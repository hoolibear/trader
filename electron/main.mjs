/**
 * electron/main.mjs — AgentSignal Trader desktop app (macOS menu-bar app).
 *
 * One process hosts everything: the dashboard HTTP server, the scheduler that
 * replaces the PM2 cron jobs, and the trading engine. The window is just a
 * browser view of the local dashboard.
 *
 * Safety rules built in here:
 *   - trading starts PAUSED until switched on from the tray (choice is remembered)
 *   - only one copy of the app can run
 *   - the run lock stops the app and the PM2/CLI runner trading at the same time
 *   - alerts raised by the engine become macOS notifications
 */

import { app, BrowserWindow, Tray, Menu, Notification, nativeImage, net, powerMonitor, powerSaveBlocker, shell, dialog } from "electron";
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const HERE     = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

// ── One instance only ─────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ── Log to a file (a packaged app has no terminal) ────────────────────────────

const LOG_DIR  = resolve(app.getPath("userData"), "logs");
const LOG_PATH = resolve(LOG_DIR, "trader.log");
mkdirSync(LOG_DIR, { recursive: true });

function writeLog(level, args) {
  try {
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 5 * 1024 * 1024) renameSync(LOG_PATH, LOG_PATH + ".1");
    const text = args.map(a => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(" ");
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${level} ${text}\n`);
  } catch {}
}
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => { writeLog(level.toUpperCase(), args); original(...args); };
}
process.on("uncaughtException", err => console.error("[app] uncaught:", err));
process.on("unhandledRejection", err => console.error("[app] unhandled rejection:", err));

// ── Where the trader's data lives ─────────────────────────────────────────────
// v1 uses the existing trader folder (its .env and data/), so the app, the CLI
// and PM2 all see the same strategies, keys and history.

const CONFIG_PATH = resolve(app.getPath("userData"), "config.json");

function readConfig() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch { return {}; }
}
function writeConfig(cfg) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function defaultHome() {
  try { return JSON.parse(readFileSync(resolve(HERE, "build-info.json"), "utf8")).defaultHome; } catch { return null; }
}

async function resolveHome() {
  const cfg = readConfig();
  let home = process.env.TRADER_HOME || cfg.home || defaultHome();
  while (!home || !existsSync(resolve(home, ".env"))) {
    const pick = await dialog.showOpenDialog({
      title: "Choose your trader folder",
      message: "Pick the folder that holds the trader's .env file and data/ folder.",
      properties: ["openDirectory"],
    });
    if (pick.canceled || !pick.filePaths[0]) return null;
    home = pick.filePaths[0];
  }
  if (cfg.home !== home) writeConfig({ ...cfg, home });
  return home;
}

// ── State ─────────────────────────────────────────────────────────────────────

let tray = null;
let win = null;
let scheduler = null;
let db = null;
let analyst = null;
let port = null;
let quitting = false;
let sleepBlocker = null;
let lastAlertId = 0;
let stallNotified = false;

const dashboardUrl = (path = "/") => `http://127.0.0.1:${port}${path}`;

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on("click", onClick ?? (() => showWindow("/positions")));
  n.show();
}

function showWindow(path) {
  if (!win) {
    win = new BrowserWindow({
      width: 1320,
      height: 880,
      title: "AgentSignal Trader",
      backgroundColor: "#0b0e14",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Closing the window keeps the trader running in the menu bar
    win.on("close", e => { if (!quitting) { e.preventDefault(); win.hide(); } });
    // Links to other sites open in the normal browser
    win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
    win.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith(dashboardUrl(""))) { e.preventDefault(); shell.openExternal(url); }
    });
    win.loadURL(dashboardUrl(path ?? "/"));
  } else if (path) {
    win.loadURL(dashboardUrl(path));
  }
  win.show();
  win.focus();
}

// ── Tray ──────────────────────────────────────────────────────────────────────

const ago = ts => {
  if (!ts) return "never";
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
};

function refreshTray() {
  if (!tray || !scheduler) return;
  const st = scheduler.status();
  let openAlerts = [];
  try { openAlerts = db.getOpenAlerts(); } catch {}
  const critical = openAlerts.filter(a => a.level === "critical").length;

  const state = st.paused ? "Paused" : st.busy ? "Running a cycle…" : "On";
  tray.setTitle(critical ? " ⚠" : st.paused ? " ⏸" : "");
  tray.setToolTip(`AgentSignal Trader — trading ${state.toLowerCase()}`);

  const lastLines = (st.lastResults ?? []).slice(0, 5).map(r => ({
    label: `   ${r.name}: ${r.ok ? (r.action ?? r.signal ?? "ok") : "ERROR " + (r.error ?? "")}`.slice(0, 90),
    enabled: false,
  }));

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Trading: ${state}${st.dryRun ? "  (DRY RUN — no orders)" : ""}`, enabled: false },
    { label: `Active strategies: ${st.activeStrategies}`, enabled: false },
    { label: `Last run: ${ago(st.lastCycleAt)}`, enabled: false },
    ...lastLines,
    ...(st.blockedBy ? [{ label: `Waiting — ${st.blockedBy} holds the run lock`, enabled: false }] : []),
    ...(st.offline ? [{ label: "Offline — waiting for network", enabled: false }] : []),
    { type: "separator" },
    {
      label: openAlerts.length ? `Alerts: ${openAlerts.length} open${critical ? ` (${critical} need action)` : ""}` : "No alerts",
      enabled: openAlerts.length > 0,
      click: () => showWindow("/positions"),
    },
    { type: "separator" },
    { label: "Open Dashboard", click: () => showWindow() },
    { label: "Run Now", enabled: !st.busy, click: runNow },
    st.paused
      ? { label: "Start Trading…", click: startTrading }
      : { label: "Pause Trading", click: () => scheduler.setPaused(true) },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: item => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
    },
    { label: "Show Log File", click: () => shell.showItemInFolder(LOG_PATH) },
    { type: "separator" },
    { label: "Quit", click: quitApp },
  ]));
}

async function startTrading() {
  const st = scheduler.status();
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Start Trading", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: st.dryRun ? "Start the trader in dry-run mode?" : "Start live trading?",
    detail: st.dryRun
      ? "Dry run: signals are fetched and decisions logged, but no orders are placed."
      : `The trader will place real orders for ${st.activeStrategies} active strategy(ies) on its schedule. Make sure PM2 is not also running the trader.`,
  });
  if (response === 0) scheduler.setPaused(false);
}

async function runNow() {
  const st = scheduler.status();
  if (!st.dryRun) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Run Now", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Run all active strategies now?",
      detail: "This fetches fresh signals and places real orders if a signal calls for it.",
    });
    if (response !== 0) return;
  }
  const r = await scheduler.runNow();
  if (r?.skipped === "locked") notify("Run skipped", "Another runner (PM2 or the CLI) is trading right now.");
}

async function quitApp() {
  const st = scheduler?.status();
  if (st && !st.paused) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message: "Quit while trading is on?",
      detail: "Nothing will check signals or exit rules until the app is opened again. Stop orders already on the exchange stay in place.",
    });
    if (response !== 0) return;
  }
  quitting = true;
  app.quit();
}

// ── Background checks ─────────────────────────────────────────────────────────

function updateSleepBlocker() {
  const on = scheduler && !scheduler.status().paused;
  if (on && sleepBlocker === null) sleepBlocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!on && sleepBlocker !== null) { powerSaveBlocker.stop(sleepBlocker); sleepBlocker = null; }
}

function checkAlerts() {
  try {
    const fresh = db.getAlertsAfter(lastAlertId);
    for (const a of fresh) {
      lastAlertId = Math.max(lastAlertId, a.id);
      if (a.resolved_at) continue;
      announceAlert(a);
    }
  } catch (e) { console.warn("[app] alert check failed:", e.message); }
}

// Notify about a new alert. When the user has switched on "Use my Claude Code",
// a critical alert first gets Claude's explanation and the notification carries
// that instead of the raw message. Any failure falls back to the plain message.
async function announceAlert(a) {
  const title = a.level === "critical" ? "Trader: action needed" : "Trader notice";
  if (a.level !== "critical" || !analyst?.analystConfig().enabled) { notify(title, a.message); return; }
  try {
    const text = await analyst.analyzeAlert(a.id);
    console.log(`[app] Claude explained alert ${a.id} (${a.code})`);
    notify(title, text);
  } catch (e) {
    console.warn(`[app] Claude explanation failed for alert ${a.id}: ${e.message}`);
    notify(title, a.message);
  }
}

function checkStall() {
  const st = scheduler.status();
  const stalled = !st.paused && st.lastTickAt && Date.now() - st.lastTickAt > st.tickMs * 3;
  if (stalled && !stallNotified) {
    stallNotified = true;
    notify("Trader stopped checking", "The scheduler has not run for several minutes. Restart the app.");
  }
  if (!stalled) stallNotified = false;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

app.on("second-instance", () => showWindow());
app.on("window-all-closed", () => { /* stay alive in the menu bar */ });
app.on("activate", () => showWindow());
app.on("before-quit", () => { quitting = true; scheduler?.stop(); });

app.whenReady().then(async () => {
  const home = await resolveHome();
  if (!home) { app.quit(); return; }
  process.env.TRADER_HOME = home;
  if (readConfig().dryRun) process.env.TRADER_DRY_RUN = "1";
  console.log(`[app] starting — home ${home}${process.env.TRADER_DRY_RUN === "1" ? " — DRY RUN" : ""}`);

  // Imported only now, after TRADER_HOME is set (paths.mjs reads it on load)
  db = await import("../db.mjs");
  const dashboard = await import("../dashboard.mjs");
  const { createScheduler } = await import("../scheduler.mjs");
  analyst = await import("../analyst.mjs");

  // Dashboard server — try the usual port, move up if PM2's dashboard has it
  const basePort = parseInt(process.env.DASHBOARD_PORT ?? "4100");
  for (let p = basePort; p < basePort + 6; p++) {
    try { await dashboard.startServer({ port: p }); port = p; break; }
    catch (e) { if (e.code !== "EADDRINUSE") throw e; }
  }
  if (!port) {
    dialog.showErrorBox("AgentSignal Trader", `Could not start the dashboard: ports ${basePort}–${basePort + 5} are all in use.`);
    app.quit();
    return;
  }

  scheduler = createScheduler({
    isOnline: () => net.isOnline(),
    onEvent: ev => {
      if (ev.type === "cycle-end") {
        const failed = ev.results.filter(r => !r.ok && !r.fetchFailed);
        if (failed.length) notify("Trader: run failed", failed.map(r => `${r.name}: ${r.error}`).join("\n"));
        const traded = ev.results.filter(r => r.ok && /^(ENTERED|CLOSED|Closed)/.test(r.action ?? ""));
        for (const r of traded) notify(r.name, r.action);
      }
      updateSleepBlocker();
      refreshTray();
    },
  });
  dashboard.attachScheduler(scheduler);

  // Tray
  const iconPath = resolve(APP_ROOT, "public", "icon.png");
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.on("click", refreshTray);

  // Existing alerts: one summary now, individual notifications only for new ones
  const open = db.getOpenAlerts();
  lastAlertId = db.getAlertsAfter(0).reduce((m, a) => Math.max(m, a.id), 0);
  if (open.length) notify("Trader: open alerts", `${open.length} alert(s) need a look. ${open[0].message}`.slice(0, 220));

  scheduler.start();
  updateSleepBlocker();
  refreshTray();
  setInterval(() => { checkAlerts(); checkStall(); refreshTray(); }, 15_000);

  // After sleep, check straight away instead of waiting for the next tick
  // (after a short wait — the network is usually not back the instant the Mac wakes)
  powerMonitor.on("resume", () => { console.log("[app] woke from sleep"); setTimeout(() => scheduler.poke(), 15_000); });

  if (!app.getLoginItemSettings().wasOpenedAsHidden) showWindow();
}).catch(err => {
  console.error("[app] failed to start:", err);
  dialog.showErrorBox("AgentSignal Trader failed to start", String(err?.stack ?? err));
  app.quit();
});
