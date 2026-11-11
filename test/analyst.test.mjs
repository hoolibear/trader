import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEngine, makeStrategy, FakeExchange } from "./helpers.mjs";

const { db } = await loadEngine();
const { analyzeAlert, positionFacts, marketFacts, buildAlertContext, analystConfig } = await import("../analyst.mjs");

function newAlert(strategyId, code = "stop_breached") {
  db.resolveAlert(strategyId, code);
  db.raiseAlert({ strategy_id: strategyId, code, level: "critical", message: "long 12.7 NEAR has NO stop-loss" });
  return db.getOpenAlerts().find(a => a.strategy_id === strategyId && a.code === code);
}
const on = (extra = {}) => Object.assign(process.env, { CLAUDE_ANALYST: "true", CLAUDE_ANALYST_DAILY_CAP: "50", ...extra });

test("position facts: long near liquidation", () => {
  const f = positionFacts({
    position: { szi: "12.7", entryPx: "4.7276", liquidationPx: "3.3771", unrealizedPnl: "-12.4", marginUsed: "7.6", leverage: { type: "isolated", value: 3 } },
    mid: 3.75, stops: [],
  });
  assert.equal(f.side, "long");
  assert.equal(f.distance_to_liquidation_pct, 9.94);
  assert.equal(f.move_from_entry_pct, -20.68);
  assert.equal(f.margin_remaining_usd, 7.6);
  assert.equal(f.margin_originally_posted_usd_approx, 20);     // 7.6 left + 12.4 lost
  assert.equal(f.pnl_as_pct_of_margin_posted, -62);
  const cross = positionFacts({ position: { szi: "1", entryPx: "100", unrealizedPnl: "-5", marginUsed: "30", leverage: { type: "cross", value: 3 } }, mid: 95 });
  assert.equal(cross.margin_required_usd, 30);
  assert.equal(cross.pnl_as_pct_of_margin_posted, undefined);
  assert.deepEqual(f.stop_orders_resting, []);
  assert.deepEqual(positionFacts({ position: null, mid: 3.75 }), { open: false });
});

test("position facts: short in profit", () => {
  const f = positionFacts({ position: { szi: "-10", entryPx: "4", liquidationPx: "5.2" }, mid: 3.8, stops: [{ side: "buy", triggerPrice: 4.3, size: 10 }] });
  assert.equal(f.side, "short");
  assert.equal(f.move_from_entry_pct, 5);
  assert.equal(f.stop_orders_resting.length, 1);
});

test("market facts summarise candles", () => {
  const candles = [100, 102, 101, 105].map(c => ({ c: String(c), h: String(c + 1), l: String(c - 1) }));
  const m = marketFacts(candles, "4h", 61.234);
  assert.equal(m.change_over_window_pct, 5);
  assert.equal(m.window_high, 106);
  assert.equal(m.window_low, 99);
  assert.equal(m.rsi_14, 61.2);
  assert.equal(marketFacts([], "4h"), null);
});

test("off by default; model and cap fall back to safe values", async () => {
  delete process.env.CLAUDE_ANALYST;
  process.env.CLAUDE_ANALYST_MODEL = "gpt-9"; process.env.CLAUDE_ANALYST_DAILY_CAP = "-3";
  assert.deepEqual(analystConfig(), { enabled: false, model: "sonnet", dailyCap: 10 });
  delete process.env.CLAUDE_ANALYST_MODEL;
  const s = makeStrategy(db);
  await assert.rejects(analyzeAlert(newAlert(s.id).id, { run: async () => "x" }), /switched off/);
});

test("explains an alert: facts go in, note is saved, private key never does", async () => {
  on();
  const s  = makeStrategy(db, { sl_pct: 3.71 });
  const ex = new FakeExchange({ mid: 3.75, szi: 12.7, entryPx: 4.7276 });
  db.insertWallet({ id: "w-test", name: "t", key: "0xSECRETKEY" });
  let seen = null;
  const a = newAlert(s.id);
  const text = await analyzeAlert(a.id, { exchange: ex, def: {}, run: async (prompt, opts) => { seen = { prompt, opts }; return "What is happening: no stop."; } });
  assert.equal(text, "What is happening: no stop.");
  assert.equal(db.getAlert(a.id).analysis, text);
  assert.equal(seen.opts.model, "sonnet");
  const facts = JSON.parse(seen.prompt.slice(seen.prompt.indexOf("{")));
  assert.equal(facts.alert.code, "stop_breached");
  assert.equal(facts.position.side, "long");
  assert.equal(facts.strategy.stop_loss_pct, 3.71);
  assert.ok(!seen.prompt.includes("0xSECRETKEY"), "no key material in the prompt");
  assert.ok(!/private|secret|password/i.test(seen.prompt));
});

test("same problem within 6 hours reuses the note; already-explained alert makes no call", async () => {
  on();
  const s = makeStrategy(db);
  const ex = new FakeExchange({ mid: 4, szi: 5, entryPx: 4.2 });
  let calls = 0;
  const run = async () => { calls++; return `note ${calls}`; };
  const first = newAlert(s.id);
  assert.equal(await analyzeAlert(first.id, { exchange: ex, def: {}, run }), "note 1");
  assert.equal(await analyzeAlert(first.id, { exchange: ex, def: {}, run }), "note 1");
  const second = newAlert(s.id);                       // dismissed and raised again
  assert.notEqual(second.id, first.id);
  assert.equal(await analyzeAlert(second.id, { exchange: ex, def: {}, run }), "note 1");
  assert.equal(calls, 1);
});

test("daily cap stops further calls; failed calls count and leave no note", async () => {
  const before = db.countAnalystCallsToday();
  on({ CLAUDE_ANALYST_DAILY_CAP: String(before + 1) });
  const ex = new FakeExchange({ mid: 4, szi: 5, entryPx: 4.2 });
  const s1 = makeStrategy(db), s2 = makeStrategy(db);
  const a1 = newAlert(s1.id);
  await assert.rejects(analyzeAlert(a1.id, { exchange: ex, def: {}, run: async () => { throw new Error("Claude Code could not answer: not signed in"); } }), /not signed in/);
  assert.equal(db.getAlert(a1.id).analysis, null);
  assert.equal(db.countAnalystCallsToday(), before + 1);
  await assert.rejects(analyzeAlert(newAlert(s2.id).id, { exchange: ex, def: {}, run: async () => "x" }), /Daily limit reached/);
});

test("alert with no strategy still gets a context", async () => {
  const ctx = await buildAlertContext({ code: "run_failed", level: "warning", created_at: "2026-11-11 11:40:44", message: "Last trading run had an error", strategy_id: "" });
  assert.deepEqual(Object.keys(ctx), ["alert"]);
});
