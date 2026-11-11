import { test } from "node:test";
import assert from "node:assert/strict";
import { CoinbaseExchange } from "../exchanges/coinbase.mjs";

/** CoinbaseExchange with canned responses instead of the network. */
class FakeCoinbase extends CoinbaseExchange {
  constructor(routes) { super("key", "secret", ""); this.routes = routes; this.seen = []; }
  async _request(method, path) {
    this.seen.push(path);
    const hit = Object.keys(this.routes).find(k => path === k) ?? Object.keys(this.routes).find(k => path.startsWith(k));
    if (!hit) throw new Error(`unexpected request ${path}`);
    const r = this.routes[hit];
    return typeof r === "function" ? r(path) : r;
  }
}
const acct = (currency, available, hold = "0") => ({ uuid: `u-${currency}`, currency, available_balance: { value: available }, hold: { value: hold } });

test("listAccounts reads every page", async () => {
  const cb = new FakeCoinbase({
    "/api/v3/brokerage/accounts": path => path.includes("cursor=abc")
      ? { accounts: [acct("USD", "250"), acct("ATOM", "0")], has_next: false, cursor: "" }
      : { accounts: [acct("VET", "10")], has_next: true, cursor: "abc" },
  });
  const all = await cb.listAccounts();
  assert.deepEqual(all.map(a => a.currency), ["VET", "USD", "ATOM"]);
  assert.equal(cb.seen.length, 2);
});

test("getPosition finds a balance that is not on the first page", async () => {
  const cb = new FakeCoinbase({
    "/api/v3/brokerage/accounts": path => path.includes("cursor=abc")
      ? { accounts: [acct("LINK", "3.5")], has_next: false }
      : { accounts: [acct("VET", "10")], has_next: true, cursor: "abc" },
  });
  assert.equal((await cb.getPosition("LINK-USD")).szi, "3.50000000");
});

test("listPortfolioHoldings reports staked balances with their USD value", async () => {
  const cb = new FakeCoinbase({
    "/api/v3/brokerage/portfolios/p1": { breakdown: { spot_positions: [
      { asset: "ATOM", total_balance_crypto: 1978.4557, total_balance_fiat: 2777.75, available_to_trade_crypto: 0, account_type: "ACCOUNT_TYPE_STAKED_FUNDS" },
      { asset: "VET",  total_balance_crypto: 10, total_balance_fiat: 0.3, available_to_trade_crypto: 10, account_type: "ACCOUNT_TYPE_WALLET" },
      { asset: "BTC",  total_balance_crypto: 0, total_balance_fiat: 0, account_type: "ACCOUNT_TYPE_WALLET" },
    ] } },
    "/api/v3/brokerage/portfolios": { portfolios: [{ uuid: "p1", name: "Default" }] },
  });
  const h = await cb.listPortfolioHoldings();
  assert.deepEqual(h.map(x => x.currency), ["ATOM", "VET"], "zero balances dropped");
  assert.deepEqual(h[0], { currency: "ATOM", amount: 1978.4557, usd: 2777.75, tradable: 0, staked: true });
  assert.equal(h[1].staked, false);
});
