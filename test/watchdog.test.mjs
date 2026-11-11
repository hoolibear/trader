import { test } from "node:test";
import assert from "node:assert/strict";
import { assess } from "../monitor/watchdog.mjs";

const pos = (over = {}) => ({ position: {
  coin: "NEAR", szi: "12.7", entryPx: "4.728", liquidationPx: "3.25",
  unrealizedPnl: "-12.8", leverage: { type: "isolated", value: 3 }, ...over } });
const stop = (over = {}) => ({ coin: "NEAR", isTrigger: true, reduceOnly: true, side: "A", triggerPx: "3.5", ...over });

test("long with no orders → no stop", () => {
  const [p] = assess({ clearinghouse: { assetPositions: [pos()] }, orders: [], mids: { NEAR: "3.72" }, liqWarnPct: 10 });
  assert.equal(p.noStop, true);
  assert.equal(p.isLong, true);
  assert.ok(Math.abs(p.liqDistPct - 12.63) < 0.05);
  assert.equal(p.liqNear, false);
  assert.ok(p.movePct < -21 && p.movePct > -22);
});

test("resting stop below price is recognised", () => {
  const [p] = assess({ clearinghouse: { assetPositions: [pos()] }, orders: [stop()], mids: { NEAR: "3.72" }, liqWarnPct: 10 });
  assert.equal(p.noStop, false);
  assert.equal(p.stopPx, 3.5);
});

test("orders that do not protect the position are ignored", () => {
  const others = [
    stop({ triggerPx: "5.4" }),            // take-profit: trigger on the winning side
    stop({ side: "B" }),                   // wrong side for a long
    stop({ reduceOnly: false }),           // would open, not close
    stop({ isTrigger: false }),            // plain limit order
    stop({ coin: "BTC" }),                 // other asset
  ];
  const [p] = assess({ clearinghouse: { assetPositions: [pos()] }, orders: others, mids: { NEAR: "3.72" }, liqWarnPct: 10 });
  assert.equal(p.noStop, true);
});

test("short: stop is a buy trigger above price", () => {
  const short = pos({ szi: "-10", entryPx: "4.0", liquidationPx: "5.2" });
  const a = assess({ clearinghouse: { assetPositions: [short] }, orders: [stop({ side: "B", triggerPx: "4.3" })], mids: { NEAR: "3.9" }, liqWarnPct: 10 });
  assert.equal(a[0].noStop, false);
  assert.ok(a[0].movePct > 0, "short below entry is in profit");
  const b = assess({ clearinghouse: { assetPositions: [short] }, orders: [stop({ side: "A", triggerPx: "3.5" })], mids: { NEAR: "3.9" }, liqWarnPct: 10 });
  assert.equal(b[0].noStop, true);
});

test("near liquidation flag and flat account", () => {
  const [p] = assess({ clearinghouse: { assetPositions: [pos()] }, orders: [], mids: { NEAR: "3.40" }, liqWarnPct: 10 });
  assert.equal(p.liqNear, true);
  assert.deepEqual(assess({ clearinghouse: { assetPositions: [] }, orders: [], mids: {}, liqWarnPct: 10 }), []);
  assert.deepEqual(assess({ clearinghouse: { assetPositions: [pos({ szi: "0" })] }, orders: [], mids: {}, liqWarnPct: 10 }), []);
});
