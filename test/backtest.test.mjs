import { test } from "node:test";
import assert from "node:assert/strict";
import { mintLiquidity, lpValue, lpAmounts, concentration, rsiSeries, simulate, stats } from "../backtest/lp-rotation.mjs";
import { to4h } from "../backtest/candles.mjs";

const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const H = 3600_000;
// hourly candles following a list of [hours, endPrice] straight-line legs
function path(legs, start = 100) {
  const out = []; let p = start, t = Date.UTC(2024, 0, 1);
  for (const [hours, end] of legs) {
    for (let k = 1; k <= hours; k++) {
      const c = p + (end - p) * (k / hours) - (k > 1 ? (end - p) * ((k - 1) / hours) : 0);
      const o = out.length ? out.at(-1).c : start, cl = o + (end - p) / hours;
      out.push({ t, o, h: Math.max(o, cl), l: Math.min(o, cl), c: cl }); t += H;
    }
    p = end;
  }
  return out;
}

test("v3 maths: $10k position at −30%", () => {
  const wide = mintLiquidity(10_000, 1, 0.5, 1.5);
  near(lpValue(wide, 1, 0.5, 1.5), 10_000, 0.01);
  near(lpValue(wide, 0.7, 0.5, 1.5), 8284, 1);
  const a = lpAmounts(wide, 0.7, 0.5, 1.5);
  near(a.token * 0.7 / (a.token * 0.7 + a.usdc), 0.67, 0.01);
  const tight = mintLiquidity(10_000, 1, 0.75, 1.25);
  near(lpValue(tight, 0.7, 0.75, 1.25), 7606, 1);       // below range: all token
  assert.equal(lpAmounts(tight, 0.7, 0.75, 1.25).usdc, 0);
  assert.equal(lpAmounts(tight, 1.3, 0.75, 1.25).token, 0);   // above range: all USDC
  near(concentration(1, 0.5, 1.5), 4.2, 0.01);
  near(concentration(1, 0.75, 1.25), 8.35, 0.01);
});

test("RSI: straight up is 100, straight down is 0", () => {
  assert.equal(rsiSeries(Array.from({ length: 30 }, (_, i) => 100 + i)).at(-1), 100);
  assert.equal(rsiSeries(Array.from({ length: 30 }, (_, i) => 100 - i)).at(-1), 0);
});

const FREE = { baseFeeApr: 0, swapCost: 0, perpFee: 0, fundingApr: 0, turn: "none" };

test("leveraged cycle: enter at −30%, exit at +15%, matches hand calculation", () => {
  const h = path([[200, 70], [400, 116]]);
  const r = simulate(h, to4h(h), { ...FREE, mode: "leveraged" });
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].result, "target");
  near(r.cycles[0].entry, 70, 0.3);
  // LP worth ~8284 at −30%; long notional 1.5× that; price 70 → 115 is +64.3%
  near(r.cycles[0].equityOut, 8284 + 1.5 * 8284 * (115 / 70 - 1), 60);
  assert.equal(r.liquidations, 0);
});

test("spot cycle has 1x exposure and cannot be liquidated", () => {
  const h = path([[200, 70], [100, 20], [600, 116]]);
  const r = simulate(h, to4h(h), { ...FREE, mode: "spot" });
  assert.equal(r.liquidations, 0);
  near(r.cycles[0].equityOut, 8284 * (115 / 70), 60);
});

test("reserve holds through a deep fall; liquidation only past about −66% from entry", () => {
  const survive = path([[200, 70], [200, 28], [600, 116]]);          // −60% from entry
  const a = simulate(survive, to4h(survive), { ...FREE, mode: "leveraged" });
  assert.equal(a.liquidations, 0);
  assert.equal(a.cycles[0].result, "target");
  const wiped = path([[200, 70], [200, 20], [600, 116]]);            // −71% from entry
  const b = simulate(wiped, to4h(wiped), { ...FREE, mode: "leveraged" });
  assert.equal(b.liquidations, 1);
  assert.ok(b.final < 1500, `nearly everything lost, got ${b.final}`);
});

test("no trigger above −30%; lp-only never rotates", () => {
  const h = path([[200, 75], [400, 116]]);
  assert.equal(simulate(h, to4h(h), { ...FREE, mode: "leveraged" }).cycles.length, 0);
  const deep = path([[200, 60], [400, 116]]);
  assert.equal(simulate(deep, to4h(deep), { ...FREE, mode: "lp-only" }).cycles.length, 0);
});

test("turn signal delays entry until the fall has stopped", () => {
  const h = path([[300, 55], [300, 80]]);
  const now  = simulate(h, to4h(h), { ...FREE, mode: "leveraged", turn: "none" });
  const wait = simulate(h, to4h(h), { ...FREE, mode: "leveraged", turn: "higherlow", maxChase: 0.2 });
  near(now.open.entry, 70, 0.3);
  assert.ok(wait.open.entry < 62, `entered after the low, at ${wait.open?.entry}`);
});

test("stats: drawdown and growth", () => {
  const s = stats([{ t: 0, v: 10_000 }, { t: 1, v: 12_000 }, { t: 2, v: 6_000 }, { t: 365 * 24 * H, v: 20_000 }]);
  near(s.maxDrawdown, 0.5, 1e-9);
  near(s.cagr, 1.0, 1e-6);
});
