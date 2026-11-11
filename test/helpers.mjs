/**
 * Test helpers: a fake exchange and a throwaway TRADER_HOME.
 * TRADER_HOME must be set before db.mjs is imported, so tests import this
 * file first and load the engine through `loadEngine()`.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.TRADER_HOME = mkdtempSync(join(tmpdir(), "trader-test-"));
delete process.env.TRADER_DRY_RUN;
delete process.env.VAULT_ACTIVE;
delete process.env.AGENT_API_KEY;

export async function loadEngine() {
  const db     = await import("../db.mjs");
  const engine = await import("../execution.mjs");
  return { db, engine };
}

let seq = 0;
/** Insert a strategy row and return it. */
export function makeStrategy(db, over = {}) {
  const id = `strat-${++seq}`;
  db.upsertStrategy({
    id, name: `Test ${seq}`, symbol: "NEAR-USD", leverage: 3, position_size_usd: 20,
    exchange: "hyperliquid", interval_minutes: 30, ...over,
  });
  db.setStrategyActive(id, true);
  return db.getStrategy(id);
}

/**
 * In-memory exchange with the same interface as exchanges/hyperliquid.mjs.
 * Orders fill at the mid price. Results use Hyperliquid's response shape.
 */
export class FakeExchange {
  constructor({ mid = 4.729, szi = 0, entryPx = 0 } = {}) {
    this.mid = mid;
    this.szi = szi;
    this.entryPx = entryPx;
    this.stops = [];          // resting stop orders
    this.calls = [];          // every order-type call, in order
    this.nextOid = 1000;
    this.failStop = null;     // set to an Error to make placeStopOrder throw
    this.fillFraction = 1;    // < 1 simulates a partial fill
    this.noFill = false;      // true → order accepted, nothing filled
  }
  get name() { return "Fake"; }
  async getMidPrice() { return this.mid; }
  async getPosition() {
    return this.szi === 0 ? null : { szi: String(this.szi), entryPx: String(this.entryPx), coin: "NEAR" };
  }
  async setLeverage(asset, leverage) { this.calls.push(["setLeverage", leverage]); }
  async placeMarketOrder(asset, side, size) {
    this.calls.push(["market", side, size]);
    if (this.noFill) return { response: { data: { statuses: [{ error: "Order could not immediately match" }] } } };
    const filled = +(size * this.fillFraction).toFixed(5);
    const signed = side === "buy" ? filled : -filled;
    this.entryPx = this.mid;
    this.szi = +(this.szi + signed).toFixed(5);
    return { response: { data: { statuses: [{ filled: { totalSz: String(filled), avgPx: String(this.mid), oid: this.nextOid++ } }] } } };
  }
  async placeStopOrder(asset, isLong, size, triggerPrice) {
    this.calls.push(["stop", isLong ? "sell" : "buy", size, triggerPrice]);
    if (this.failStop) throw this.failStop;
    const oid = this.nextOid++;
    this.stops.push({ id: oid, asset, side: isLong ? "sell" : "buy", size, triggerPrice });
    return { result: {}, oid };
  }
  async getStopOrders() { return this.stops.slice(); }
  async cancelOrder(oid) {
    this.calls.push(["cancel", String(oid)]);
    this.stops = this.stops.filter(o => String(o.id) !== String(oid));
  }
  async closePosition() {
    this.calls.push(["close", this.szi]);
    const size = Math.abs(this.szi);
    this.szi = 0;
    return { response: { data: { statuses: [{ filled: { totalSz: String(size), avgPx: String(this.mid), oid: this.nextOid++ } }] } } };
  }
  async getCandles() { return []; }
  count(kind) { return this.calls.filter(c => c[0] === kind).length; }
}
