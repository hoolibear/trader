#!/usr/bin/env node
/**
 * monitor/watchdog.mjs — read-only position watchdog with Telegram alerts.
 *
 * Runs on a separate machine (the VPS) so it keeps watching when the Mac that
 * trades is asleep, offline, or the trader has died. It needs only the wallet
 * ADDRESS — no private key — and cannot place, change or cancel anything.
 *
 * One run = one check, then exit. A systemd timer (or cron) runs it every
 * couple of minutes. State between runs lives in a small JSON file.
 *
 * Alerts:
 *   no_stop      open position with no stop-loss order resting on the exchange
 *   liq_near     price within LIQ_WARN_PCT of the liquidation price
 *   heartbeat    the trader has not reported in for HEARTBEAT_MAX_MIN (optional)
 *   api_down     Hyperliquid unreachable for several checks in a row
 * Notices: position opened / closed / resized, alert cleared, daily summary.
 *
 * No dependencies — plain Node 22+.
 *
 * Config (environment, usually from monitor.env):
 *   WALLET_ADDRESS        0x… address to watch            (required)
 *   TELEGRAM_BOT_TOKEN    from @BotFather                 (required unless --dry)
 *   TELEGRAM_CHAT_ID      chat to post to                 (required unless --dry)
 *   LIQ_WARN_PCT          default 10
 *   REMIND_HOURS          repeat an unresolved alert every N hours, default 6
 *   DAILY_UTC_HOUR        hour (UTC) of the daily summary, default 13; -1 = off
 *   HEARTBEAT_FILE        file whose modified time is the trader's last check-in
 *   HEARTBEAT_MAX_MIN     alert when that file is older than this (default off)
 *   STATE_FILE            default ./state.json next to this script
 *   MONITOR_NAME          label in messages, default "Trader monitor"
 *
 * Flags:  --dry   print messages instead of sending, do not save state
 *         --test  send one test message and exit
 */

import { readFileSync, writeFileSync, statSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DRY  = process.argv.includes("--dry");
const TEST = process.argv.includes("--test");

const cfg = {
  address:      (process.env.WALLET_ADDRESS ?? "").trim().toLowerCase(),
  token:        (process.env.TELEGRAM_BOT_TOKEN ?? "").trim(),
  chatId:       (process.env.TELEGRAM_CHAT_ID ?? "").trim(),
  liqWarnPct:   parseFloat(process.env.LIQ_WARN_PCT ?? "10"),
  remindHours:  parseFloat(process.env.REMIND_HOURS ?? "6"),
  dailyUtcHour: parseInt(process.env.DAILY_UTC_HOUR ?? "13"),
  hbFile:       (process.env.HEARTBEAT_FILE ?? "").trim(),
  hbMaxMin:     parseFloat(process.env.HEARTBEAT_MAX_MIN ?? "0"),
  stateFile:    process.env.STATE_FILE ? resolve(process.env.STATE_FILE) : resolve(HERE, "state.json"),
  name:         process.env.MONITOR_NAME ?? "Trader monitor",
};

const HL_INFO = "https://api.hyperliquid.xyz/info";
const API_FAILS_BEFORE_ALERT = 3;

// ── helpers ───────────────────────────────────────────────────────────────────

const usd = n => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 10 ? 4 : 2 })}`;
const pct = n => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

async function hl(body) {
  const res = await fetch(HL_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Hyperliquid ${body.type} → HTTP ${res.status}`);
  return res.json();
}

async function send(text) {
  const message = `${cfg.name}\n${text}`;
  if (DRY) { console.log(`--- would send ---\n${message}\n`); return true; }
  const res = await fetch(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: cfg.chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // never print the URL — it contains the bot token
    console.error(`[monitor] Telegram send failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

function loadState() {
  try { return JSON.parse(readFileSync(cfg.stateFile, "utf8")); }
  catch { return { alerts: {}, positions: {}, apiFails: 0, lastDaily: null, started: false }; }
}

function saveState(state) {
  if (DRY) return;
  const tmp = cfg.stateFile + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, cfg.stateFile);          // atomic: never leave a half-written state file
}

// ── checks ────────────────────────────────────────────────────────────────────

/** Pure: turn exchange data into the list of positions with their risk facts. */
export function assess({ clearinghouse, orders, mids, liqWarnPct }) {
  const positions = [];
  for (const row of clearinghouse?.assetPositions ?? []) {
    const p = row.position;
    const szi = parseFloat(p?.szi ?? "0");
    if (!szi) continue;
    const coin   = p.coin;
    const isLong = szi > 0;
    const mid    = parseFloat(mids?.[coin] ?? "0") || null;
    const entry  = parseFloat(p.entryPx ?? "0") || null;
    const liq    = p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;

    // A stop = reduce-only trigger order that closes this position, with its
    // trigger on the losing side of the current price.
    const stops = (orders ?? []).filter(o =>
      o.coin === coin && o.isTrigger && o.reduceOnly &&
      (isLong ? o.side === "A" : o.side === "B") &&
      (mid == null || (isLong ? parseFloat(o.triggerPx) < mid : parseFloat(o.triggerPx) > mid)));
    const stopPx = stops.length
      ? (isLong ? Math.max(...stops.map(o => parseFloat(o.triggerPx))) : Math.min(...stops.map(o => parseFloat(o.triggerPx))))
      : null;

    const liqDistPct = liq && mid ? Math.abs(mid - liq) / mid * 100 : null;
    positions.push({
      coin, isLong, size: Math.abs(szi), entry, mid, liq, liqDistPct,
      leverage: p.leverage?.value ?? null,
      marginMode: p.leverage?.type ?? null,
      pnl: parseFloat(p.unrealizedPnl ?? "0"),
      movePct: entry && mid ? (mid - entry) / entry * 100 * (isLong ? 1 : -1) : null,
      stopPx,
      noStop: stopPx == null,
      liqNear: liqDistPct != null && liqDistPct < liqWarnPct,
    });
  }
  return positions;
}

function describe(p) {
  const side = p.isLong ? "LONG" : "SHORT";
  const lines = [
    `${p.coin} ${side} ${p.size}${p.leverage ? ` (${p.leverage}x ${p.marginMode ?? ""})`.replace(" )", ")") : ""}`,
    `  entry ${p.entry ? usd(p.entry) : "?"} → now ${p.mid ? usd(p.mid) : "?"}${p.movePct != null ? ` (${pct(p.movePct)})` : ""}, P&L ${p.pnl >= 0 ? "+" : "-"}${usd(Math.abs(p.pnl))}`,
    `  stop: ${p.stopPx != null ? usd(p.stopPx) : "NONE"}`,
    `  liquidation: ${p.liq != null ? `${usd(p.liq)} (${p.liqDistPct.toFixed(1)}% away)` : "n/a"}`,
  ];
  return lines.join("\n");
}

/**
 * Raise / remind / clear one alert. `active` says whether the condition holds now.
 * Sends at most one message per call.
 */
async function track(state, key, active, text, now) {
  const prev = state.alerts[key];
  if (active) {
    const due = !prev || now - prev.lastSent >= cfg.remindHours * 3600_000;
    if (due) {
      const sent = await send(`${prev ? "🔁 STILL" : "🚨"} ${text}`);
      if (sent) state.alerts[key] = { since: prev?.since ?? now, lastSent: now };
    }
  } else if (prev) {
    const mins = Math.round((now - prev.since) / 60000);
    if (await send(`✅ Cleared: ${key.replace(":", " ")} (was active ${mins} min)`)) delete state.alerts[key];
  }
}

async function main() {
  if (!cfg.address) throw new Error("WALLET_ADDRESS is not set");
  if (!DRY && (!cfg.token || !cfg.chatId)) throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required (or run with --dry)");

  if (TEST) {
    const ok = await send("✅ Test message — alerts will arrive in this chat.");
    process.exit(ok ? 0 : 1);
  }

  const state = loadState();
  const now   = Date.now();

  // 1. fetch — a failure here is itself something to report, but only after a few in a row
  let clearinghouse, orders, mids;
  try {
    [clearinghouse, orders, mids] = await Promise.all([
      hl({ type: "clearinghouseState", user: cfg.address }),
      hl({ type: "frontendOpenOrders", user: cfg.address }),
      hl({ type: "allMids" }),
    ]);
  } catch (err) {
    state.apiFails = (state.apiFails ?? 0) + 1;
    console.error(`[monitor] fetch failed (${state.apiFails} in a row): ${err.message}`);
    if (state.apiFails >= API_FAILS_BEFORE_ALERT) {
      await track(state, "api_down", true, `Cannot reach Hyperliquid (${state.apiFails} checks in a row): ${err.message}. Positions are NOT being watched.`, now);
    }
    saveState(state);
    return;
  }
  state.apiFails = 0;
  await track(state, "api_down", false, "", now);

  const positions = assess({ clearinghouse, orders, mids, liqWarnPct: cfg.liqWarnPct });
  const byCoin    = Object.fromEntries(positions.map(p => [p.coin, p]));

  // 2. first run: say hello with the current picture
  if (!state.started) {
    await send(`👋 Online. Watching ${cfg.address.slice(0, 6)}…${cfg.address.slice(-4)}.\n` +
      (positions.length ? positions.map(describe).join("\n") : "No open positions."));
    state.started = true;
  } else {
    // 3. position changes since last run
    for (const p of positions) {
      const before = state.positions[p.coin];
      if (!before) await send(`📈 Position opened\n${describe(p)}`);
      else if (before.isLong !== p.isLong) await send(`🔄 Position flipped\n${describe(p)}`);
      else if (Math.abs(before.size - p.size) / before.size > 0.01) await send(`↕️ Position size changed ${before.size} → ${p.size}\n${describe(p)}`);
    }
    for (const [coin, before] of Object.entries(state.positions)) {
      if (!byCoin[coin]) {
        await send(`📉 Position closed: ${coin} ${before.isLong ? "LONG" : "SHORT"} ${before.size}` +
          (before.liqNear ? `\n⚠️ It was close to liquidation at the last check — it may have been liquidated.` : ""));
      }
    }
  }

  // 4. risk alerts (one key per coin so each clears on its own)
  const coins = new Set([...positions.map(p => p.coin), ...Object.keys(state.alerts).map(k => k.split(":")[1]).filter(Boolean)]);
  for (const coin of coins) {
    const p = byCoin[coin];
    await track(state, `no_stop:${coin}`, !!p?.noStop,
      p ? `NO STOP-LOSS on the exchange\n${describe(p)}` : "", now);
    await track(state, `liq_near:${coin}`, !!p?.liqNear,
      p ? `NEAR LIQUIDATION — ${p.liqDistPct?.toFixed(1)}% away\n${describe(p)}` : "", now);
  }

  // 5. trader heartbeat (optional)
  if (cfg.hbFile && cfg.hbMaxMin > 0) {
    let ageMin = Infinity;
    try { ageMin = (now - statSync(cfg.hbFile).mtimeMs) / 60000; } catch {}
    await track(state, "heartbeat", ageMin > cfg.hbMaxMin,
      `Trader has not checked in for ${Number.isFinite(ageMin) ? Math.round(ageMin) + " min" : "ever"} (limit ${cfg.hbMaxMin} min). It may be asleep, quit or crashed.`, now);
  }

  // 6. daily summary — also proves the monitor itself is alive
  const today = new Date(now).toISOString().slice(0, 10);
  if (cfg.dailyUtcHour >= 0 && new Date(now).getUTCHours() >= cfg.dailyUtcHour && state.lastDaily !== today) {
    const acct  = parseFloat(clearinghouse?.marginSummary?.accountValue ?? "0");
    const open  = Object.keys(state.alerts);
    const sent  = await send(`🗓 Daily summary ${today}\n` +
      `Perp account value: ${usd(acct)}\n` +
      (positions.length ? positions.map(describe).join("\n") : "No open positions.") +
      `\nOpen alerts: ${open.length ? open.join(", ") : "none"}`);
    if (sent) state.lastDaily = today;
  }

  state.positions = Object.fromEntries(positions.map(p => [p.coin, { isLong: p.isLong, size: p.size, liqNear: p.liqNear }]));
  state.lastRun = now;
  saveState(state);
  console.log(`[monitor] ok — ${positions.length} position(s), ${Object.keys(state.alerts).length} open alert(s)`);
}

// Run only when executed directly (tests import assess())
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(`[monitor] ${err.message}`); process.exit(1); });
}
