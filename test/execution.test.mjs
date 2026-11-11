import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngine, makeStrategy, FakeExchange } from "./helpers.mjs";
import { formatHlPrice } from "../hyperliquid.mjs";

const { db, engine } = await loadEngine();
const { runStrategyOnce, checkTpTrail, parseFill } = engine;

const SCALP = { risk: { mode: "scalp" } };
const PLAIN = { risk: {} };
const run = (strategy, exchange, signal, def = PLAIN) =>
  runStrategyOnce(db.getStrategy(strategy.id), { exchange, def, signalData: { signal, price: exchange.mid } });
const actions = id => db.getTradeHistory(id, 50).map(t => t.action);
const openAlerts = id => db.getOpenAlerts().filter(a => a.strategy_id === id).map(a => a.code);
const sigFigs = s => s.replace(".", "").replace(/^0+/, "").replace(/0+$/, "").length;

test("price format: at most 5 significant figures (the Sep 28 stop rejection)", () => {
  // 4.729 × (1 − 0.0371) = 4.5535… — six figures were sent, Hyperliquid refused
  assert.equal(formatHlPrice(4.729 * (1 - 0.0371), 1), "4.5535");
  assert.equal(formatHlPrice(4.326, 1), "4.326");
  assert.equal(formatHlPrice(2.2281749, 1), "2.2281");
  for (const [px, dec] of [[104233.71, 5], [0.000123456, 0], [16.14837, 2], [296.9753, 2], [3.69671, 1]]) {
    const out = formatHlPrice(px, dec);
    assert.ok(sigFigs(out) <= 5 || /^\d+$/.test(out), `${px} → ${out}`);
    assert.ok((out.split(".")[1]?.length ?? 0) <= 6 - dec, `${px} → ${out} decimals`);
  }
});

test("parseFill reads Hyperliquid statuses and ignores unknown shapes", () => {
  assert.deepEqual(parseFill({ response: { data: { statuses: [{ filled: { totalSz: "2", avgPx: "5.1" } }] } } }), { filled: true, size: 2, price: 5.1 });
  assert.equal(parseFill({ response: { data: { statuses: [{ error: "nope" }] } } }).filled, false);
  assert.equal(parseFill({ response: { data: { statuses: [{ resting: { oid: 1 } }] } } }).filled, false);
  assert.equal(parseFill({ orderId: "abc" }), null);
  assert.equal(parseFill(null), null);
});

test("entry: trade recorded, stop placed from fill price, order id stored", async () => {
  const s = makeStrategy(db, { sl_pct: 5 });
  const ex = new FakeExchange({ mid: 4.0 });
  const r = await run(s, ex, "LONG");
  assert.equal(r.ok, true);
  assert.match(actions(s.id)[0], /^ENTERED LONG /);
  assert.equal(ex.stops.length, 1);
  assert.equal(ex.stops[0].side, "sell");
  assert.ok(Math.abs(ex.stops[0].triggerPrice - 3.8) < 1e-9);
  assert.equal(db.getStrategyStopOrderId(s.id), String(ex.stops[0].id));
  assert.deepEqual(openAlerts(s.id), []);
});

test("stop order fails: position kept, trade still recorded, alert raised, retried next run", async () => {
  const s = makeStrategy(db, { sl_pct: 5 });
  const ex = new FakeExchange({ mid: 4.0 });
  ex.failStop = new Error("Order 0: Invalid TP/SL price. asset=74");
  const r = await run(s, ex, "LONG");
  assert.equal(r.ok, true, "a stop failure is not an execution error");
  assert.match(actions(s.id)[0], /^ENTERED LONG /);
  assert.ok(ex.szi > 0, "position stays open");
  assert.equal(ex.count("stop"), 2, "one retry");
  assert.equal(ex.count("close"), 0);
  assert.deepEqual(openAlerts(s.id), ["stop_missing"]);

  ex.failStop = null;
  await run(s, ex, "LONG");            // unchanged signal → hold cycle
  assert.equal(ex.stops.length, 1, "stop placed on the next run");
  assert.deepEqual(openAlerts(s.id), []);
  await run(s, ex, "LONG");
  assert.equal(ex.stops.length, 1, "no duplicate stop");
});

test("found position already past its stop level: alert only, no stop, no close", async () => {
  // The live NEAR case: long from ~4.73, stop 3.71% → 4.55, price now 3.70
  const s = makeStrategy(db, { sl_pct: 3.71 });
  const ex = new FakeExchange({ mid: 3.70, szi: 12.7, entryPx: 4.729 });
  db.upsertSignal({ strategy_id: s.id, date: new Date().toISOString().slice(0, 10), signal: "LONG", price: 5.25 });
  const r = await run(s, ex, "LONG", SCALP);
  assert.equal(r.ok, true);
  assert.equal(ex.count("stop"), 0);
  assert.equal(ex.count("close"), 0);
  assert.equal(ex.count("market"), 0);
  assert.equal(ex.szi, 12.7);
  assert.deepEqual(openAlerts(s.id), ["stop_breached"]);
  assert.deepEqual(actions(s.id), []);
});

test("entry order does not fill: no trade row, no stop, signal change retried", async () => {
  const s = makeStrategy(db, { sl_pct: 5 });
  const ex = new FakeExchange({ mid: 4.0 });
  await run(s, ex, "FLAT");
  ex.noFill = true;
  const r = await run(s, ex, "LONG");
  assert.equal(r.ok, false);
  assert.deepEqual(actions(s.id), []);
  assert.equal(ex.count("stop"), 0);
  assert.equal(db.getLatestSignal(s.id).signal, "FLAT", "stored signal put back so the flip is seen again");
  ex.noFill = false;
  const r2 = await run(s, ex, "LONG");
  assert.match(r2.action, /^ENTERED LONG /);
});

test("partial fill: recorded and protected at the filled size", async () => {
  const s = makeStrategy(db, { sl_pct: 5 });
  const ex = new FakeExchange({ mid: 4.0 });
  ex.fillFraction = 0.5;
  await run(s, ex, "LONG");
  const t = db.getTradeHistory(s.id, 1)[0];
  assert.equal(t.size, 7.5);                 // 20 × 3 / 4.0 = 15 requested
  assert.equal(ex.stops[0].size, 7.5);
});

test("cooldown blocks a new entry but never an exit", async () => {
  const s = makeStrategy(db, { cooldown_minutes: 60 });
  const ex = new FakeExchange({ mid: 4.0 });
  await run(s, ex, "LONG");
  assert.ok(ex.szi > 0);
  const r = await run(s, ex, "FLAT");        // seconds after entry, inside cooldown
  assert.equal(ex.szi, 0, "exit went through");
  assert.match(r.action, /^CLOSED /);
  const r2 = await run(s, ex, "LONG");
  assert.match(r2.action, /^Blocked: cooldown/);
  assert.equal(ex.szi, 0);
});

test("SHORT → LONG closes the short and opens a long", async () => {
  const s = makeStrategy(db, { sl_pct: 5 });
  const ex = new FakeExchange({ mid: 4.0 });
  await run(s, ex, "SHORT");
  assert.ok(ex.szi < 0);
  assert.equal(ex.stops[0].side, "buy");
  assert.ok(Math.abs(ex.stops[0].triggerPrice - 4.2) < 1e-9);
  const shortStop = String(ex.stops[0].id);
  ex.mid = 3.9;
  const r = await run(s, ex, "LONG");
  assert.ok(ex.szi > 0, "now long");
  assert.match(r.action, /^CLOSED .*\(flip\) → ENTERED LONG /);
  assert.ok(ex.calls.some(c => c[0] === "cancel" && c[1] === shortStop), "old stop cancelled");
  assert.equal(ex.stops.length, 1);
  assert.equal(ex.stops[0].side, "sell");
  const closeRow = db.getTradeHistory(s.id, 10).find(t => t.action.startsWith("CLOSED"));
  assert.ok(closeRow.pnl > 0, "short closed lower than entry is a profit");
});

test("LONG → SHORT still flips", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 4.0 });
  await run(s, ex, "LONG");
  await run(s, ex, "SHORT");
  assert.ok(ex.szi < 0);
});

test("short trail: favourable move does not close; reversal closes with positive P&L", async () => {
  const s = makeStrategy(db, { tp_pct: 2, trail_pct: 1 });
  const ex = new FakeExchange({ mid: 100 });
  await run(s, ex, "SHORT");
  const size = Math.abs(ex.szi);
  const strat = () => ({ ...db.getStrategy(s.id) });

  ex.mid = 99;                                   // in profit, TP (98) not reached
  assert.equal(await checkTpTrail(strat(), ex), false);
  assert.equal(db.getTpState(s.id).trail_mode, 0);

  ex.mid = 97;                                   // TP reached → trail mode
  assert.equal(await checkTpTrail(strat(), ex), false);
  assert.equal(db.getTpState(s.id).trail_mode, 1);

  ex.mid = 96;                                   // new low, still open
  assert.equal(await checkTpTrail(strat(), ex), false);
  assert.equal(db.getTpState(s.id).high_water, 96);
  assert.ok(ex.szi < 0);

  ex.mid = 97.5;                                 // > 96 × 1.01 → trail stop
  assert.equal(await checkTpTrail(strat(), ex), true);
  assert.equal(ex.szi, 0);
  const t = db.getTradeHistory(s.id, 5).find(x => x.action.startsWith("TRAIL STOP"));
  assert.ok(Math.abs(t.pnl - +(2.5 * size).toFixed(2)) < 0.011, `pnl ${t.pnl}`);
});

test("long trail still works", async () => {
  const s = makeStrategy(db, { tp_pct: 2, trail_pct: 1 });
  const ex = new FakeExchange({ mid: 100 });
  await run(s, ex, "LONG");
  const strat = () => ({ ...db.getStrategy(s.id) });
  ex.mid = 103; assert.equal(await checkTpTrail(strat(), ex), false);
  ex.mid = 105; assert.equal(await checkTpTrail(strat(), ex), false);
  ex.mid = 104.5; assert.equal(await checkTpTrail(strat(), ex), false);
  ex.mid = 103.9; assert.equal(await checkTpTrail(strat(), ex), true);
  const t = db.getTradeHistory(s.id, 5).find(x => x.action.startsWith("TRAIL STOP"));
  assert.ok(t.pnl > 0);
});

test("scalper holding a position: trail check runs, no false flip events, no re-entry", async () => {
  const s = makeStrategy(db, { tp_pct: 2, trail_pct: 1 });
  const ex = new FakeExchange({ mid: 100 });
  await run(s, ex, "LONG", SCALP);
  assert.ok(ex.szi > 0);
  ex.mid = 103; await run(s, ex, "LONG", SCALP);    // TP hit
  ex.mid = 105; await run(s, ex, "LONG", SCALP);    // new high
  assert.equal(ex.count("market"), 1, "no second entry while in position");
  ex.mid = 103.5;
  const r = await run(s, ex, "LONG", SCALP);        // trail stop
  assert.equal(r.action, "Closed via TP/trail stop");
  assert.equal(ex.szi, 0);
  const events = db.getRecentSignalEvents(1).filter(e => e.strategy_id === s.id);
  assert.equal(events.filter(e => e.type === "flip").length, 1, "only the first LONG is a flip");
  assert.equal(events.filter(e => e.type === "check").length, 3);
});

test("scalper enters on signal without a flip (no-flip rule kept)", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 4.0 });
  await run(s, ex, "LONG", SCALP);
  ex.szi = 0;                                        // position gone (e.g. stopped out)
  const r = await run(s, ex, "LONG", SCALP);         // same signal, flat → enter again
  assert.match(r.action, /^ENTERED LONG /);
});

test("adaptive stop does not overwrite the user's sl_pct", async () => {
  const s = makeStrategy(db, { sl_pct: 7 });
  const ex = new FakeExchange({ mid: 4.0 });
  // 60 candles with a steady true range of 0.2 → ATR 0.2 → 1.5×0.2/4 = 7.5%
  ex.getCandles = async () => Array.from({ length: 60 }, () => ({ h: "4.1", l: "3.9", c: "4.0" }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ json: async () => [] });   // BTC macro check → no data → fail open
  try { await run(s, ex, "LONG", SCALP); } finally { globalThis.fetch = realFetch; }
  const row = db.getStrategy(s.id);
  assert.equal(row.sl_pct, 7);
  assert.equal(row.sl_pct_adaptive, 7.5);
  assert.ok(Math.abs(ex.stops[0].triggerPrice - 4.0 * (1 - 0.075)) < 1e-9);
  await run(s, ex, "FLAT", SCALP);
  assert.equal(db.getStrategy(s.id).sl_pct_adaptive, null, "cleared on close");
});

test("dry run: no orders, nothing written", async () => {
  const s = makeStrategy(db, { sl_pct: 5, tp_pct: 2, trail_pct: 1 });
  const ex = new FakeExchange({ mid: 4.0 });
  process.env.TRADER_DRY_RUN = "1";
  try {
    const r = await run(s, ex, "LONG", SCALP);
    assert.match(r.action, /^\[DRY RUN\] Would: ENTER LONG/);
  } finally { delete process.env.TRADER_DRY_RUN; }
  assert.equal(ex.calls.length, 0);
  assert.deepEqual(actions(s.id), []);
  assert.equal(db.getLatestSignal(s.id), undefined);
  assert.equal(db.getTpState(s.id), undefined);
  assert.deepEqual(openAlerts(s.id), []);
});

test("signal fetch alert clears as soon as any signal arrives", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 4.0 });
  db.raiseAlert({ strategy_id: s.id, code: "signal_fetch_failed", message: "fetch failed", level: "warning" });
  assert.deepEqual(openAlerts(s.id), ["signal_fetch_failed"]);
  await run(s, ex, "FLAT");
  assert.deepEqual(openAlerts(s.id), []);
});

// ── Server signal must not close a position that has its own exit rules ───────
// 2026-11-11: the local check failed once, the run fell back to the server,
// the server said FLAT (entry rule not true), and a NEAR long was closed with
// neither exit condition met.

const NEAR_DEF = {
  risk: { mode: "scalp" },
  long_entry: { operator: "AND", conditions: [{ op: "lte", field: "rsi", value: 45, period: 14, interval: "4h" }] },
  long_exit:  { operator: "AND", conditions: [
    { op: "gte", field: "rsi", value: 80, period: 14, interval: "4h" },
    { op: "gte", field: "pct_above_entry", value: 10 },
  ] },
};
const serverSays = signal => { const f = async () => { f.calls++; return { signal, price: 3.74 }; }; f.calls = 0; return f; };
const runLive = (strategy, exchange, def, fetchSignal) =>
  runStrategyOnce(db.getStrategy(strategy.id), { exchange, def, fetchSignal });

test("local exit check fails with a position open: hold, never ask the server, alert", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 3.74, szi: 20.7, entryPx: 4.356 });
  ex.getCandles = async () => { throw new Error("network down"); };
  db.upsertSignal({ strategy_id: s.id, date: "2026-11-11", signal: "LONG", price: 3.78, notes: null });
  const server = serverSays("FLAT");
  const r = await runLive(s, ex, NEAR_DEF, server);
  assert.equal(r.ok, true);
  assert.equal(r.held, true);
  assert.equal(ex.szi, 20.7, "position untouched");
  assert.equal(ex.count("close"), 0);
  assert.equal(ex.count("market"), 0);
  assert.equal(server.calls, 0, "server signal not fetched");
  assert.equal(db.getLatestSignal(s.id).signal, "LONG", "stored signal unchanged");
  assert.deepEqual(openAlerts(s.id), ["local_check_failed"]);
});

test("strategy rules not loaded with a position open: hold", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 3.74, szi: 20.7, entryPx: 4.356 });
  const server = serverSays("FLAT");
  const r = await runLive(s, ex, null, server);
  assert.equal(r.held, true);
  assert.equal(ex.szi, 20.7);
  assert.equal(server.calls, 0);
  assert.deepEqual(openAlerts(s.id), ["local_check_failed"]);
});

test("local exit check works again: alert clears, exit rule not met so still holding", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 3.74, szi: 20.7, entryPx: 4.356 });
  db.raiseAlert({ strategy_id: s.id, code: "local_check_failed", message: "x", level: "warning" });
  ex.getCandles = async () => Array.from({ length: 100 }, (_, i) => ({ c: String(3.7 + (i % 2) * 0.02) }));
  const server = serverSays("FLAT");
  const r = await runLive(s, ex, NEAR_DEF, server);
  assert.equal(r.signal, "LONG");
  assert.equal(ex.szi, 20.7);
  assert.equal(server.calls, 0);
  assert.deepEqual(openAlerts(s.id), []);
});

test("no position: server signal is still used for entries", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 3.74 });
  ex.getCandles = async () => { throw new Error("network down"); };
  const server = serverSays("FLAT");
  const r = await runLive(s, ex, NEAR_DEF, server);
  assert.equal(server.calls, 1);
  assert.equal(r.signal, "FLAT");
  assert.deepEqual(openAlerts(s.id), []);
});

test("strategy with no exit rules of its own: server FLAT still closes the position", async () => {
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 4.0 });
  await run(s, ex, "LONG");
  assert.ok(ex.szi > 0);
  const server = serverSays("FLAT");
  const r = await runLive(s, ex, PLAIN, server);
  assert.equal(server.calls, 1);
  assert.equal(ex.szi, 0);
  assert.match(r.action, /^CLOSED /);
});
