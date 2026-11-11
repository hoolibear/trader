/**
 * scheduler.mjs — in-process replacement for the PM2 cron jobs.
 *
 * Every tick it runs each active strategy that is due:
 *   - crypto strategies: whenever their own interval_minutes has passed (24/7)
 *   - stock strategies:  once per weekday, from 13:31 UTC (the same slot PM2
 *     used). If the machine was asleep at 13:31 the run happens on wake, as
 *     long as it is still before 20:00 UTC.
 *
 * It starts paused unless the saved state says otherwise — trading only begins
 * when the user switches it on.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./paths.mjs";
import { getActiveStrategies, getStrategy, isStrategyDue, touchStrategyRun, raiseAlert, resolveAlert } from "./db.mjs";
import { runStrategyOnce, syncPositions, isDryRun } from "./execution.mjs";
import { isCrypto } from "./markets.mjs";
import { acquireRunLock, releaseRunLock, lockHolder } from "./runlock.mjs";

const STATE_PATH = resolve(DATA_DIR, "app-state.json");

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(state) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Is a stock strategy due? Once per weekday inside the 13:31–20:00 UTC window. */
export function stockSlotDue(lastRunAt, now = new Date()) {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;
  const open  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 31);
  const close = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0);
  if (now.getTime() < open || now.getTime() >= close) return false;
  if (!lastRunAt) return true;
  return new Date(lastRunAt + "Z").getTime() < open;   // not yet run in today's window
}

export function strategyDue(strategy, now = new Date()) {
  if (isCrypto(strategy.symbol)) return isStrategyDue(strategy.id);
  return stockSlotDue(strategy.last_run_at, now);
}

// `isOnline` lets the host say "no network right now" (the desktop app passes
// Electron's net.isOnline). Ticks are skipped while offline, so a Mac that
// half-wakes with no network does not raise fetch-failure alerts.
export function createScheduler({ tickMs = 60_000, onEvent = () => {}, isOnline = () => true } = {}) {
  const saved = loadState();
  const st = {
    paused: saved.paused !== false,     // paused unless explicitly switched on
    busy: false,
    lastTickAt: null,                   // last time the loop woke up
    lastCycleAt: null,                  // last time at least one strategy ran
    lastResults: [],
    lastError: null,
    blockedBy: null,                    // another runner (PM2) holding the lock
  };
  let timer = null;

  async function tick({ force = false } = {}) {
    st.lastTickAt = Date.now();
    if (st.busy) return { skipped: "busy" };
    if (st.paused && !force) return { skipped: "paused" };
    if (!isOnline()) { st.offline = true; return { skipped: "offline" }; }
    st.offline = false;

    const all = getActiveStrategies();
    const due = force ? all : all.filter(s => strategyDue(s));
    if (!due.length) return { ran: 0 };

    if (!acquireRunLock("desktop-app")) {
      const holder = lockHolder();
      st.blockedBy = holder?.owner ?? "another runner";
      onEvent({ type: "blocked", by: st.blockedBy });
      return { skipped: "locked" };
    }
    st.blockedBy = null;
    st.busy = true;
    onEvent({ type: "cycle-start", count: due.length });
    const results = [];
    try {
      for (const row of due) {
        const strategy = getStrategy(row.id) ?? row;      // fresh row (adaptive stop, last run)
        console.log(`\n[scheduler] ── ${strategy.name} (${strategy.symbol}) ──`);
        let result;
        try {
          result = await runStrategyOnce(strategy);
        } catch (err) {
          result = { ok: false, error: err.message };
          console.error(`[scheduler] ${strategy.name} threw: ${err.message}`);
        }
        // A failed signal fetch is retried on the next tick rather than waiting a full interval
        if (!result.fetchFailed && !isDryRun()) touchStrategyRun(strategy.id);
        results.push({ id: strategy.id, name: strategy.name, at: Date.now(), ...result });
      }
      await syncPositions(due);
      st.lastCycleAt = Date.now();
      st.lastResults = results;
      st.lastError = results.find(r => !r.ok)?.error ?? null;
      if (!isDryRun()) {
        if (st.lastError) raiseAlert({ code: "run_failed", level: "warning", message: `Last trading run had an error: ${st.lastError}` });
        else resolveAlert("", "run_failed");
      }
      onEvent({ type: "cycle-end", results });
    } finally {
      st.busy = false;
      releaseRunLock();
    }
    return { ran: results.length, results };
  }

  function safeTick(opts) {
    return tick(opts).catch(err => {
      st.lastError = err.message;
      console.error(`[scheduler] tick failed: ${err.message}`);
      onEvent({ type: "error", error: err.message });
      return { error: err.message };
    });
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => safeTick(), tickMs);
      safeTick();
    },
    stop() { clearInterval(timer); timer = null; },
    /** Run every active strategy now, due or not. Works while paused. */
    runNow() { return safeTick({ force: true }); },
    /** Check for due strategies now (used after wake from sleep). */
    poke() { return safeTick(); },
    setPaused(paused) {
      st.paused = !!paused;
      saveState({ ...loadState(), paused: st.paused });
      onEvent({ type: "paused", paused: st.paused });
      if (!st.paused) safeTick();
    },
    status() {
      const active = getActiveStrategies();
      return {
        paused: st.paused,
        busy: st.busy,
        dryRun: isDryRun(),
        activeStrategies: active.length,
        lastTickAt: st.lastTickAt,
        lastCycleAt: st.lastCycleAt,
        lastResults: st.lastResults,
        lastError: st.lastError,
        blockedBy: st.blockedBy,
        offline: !!st.offline,
        tickMs,
      };
    },
  };
}
