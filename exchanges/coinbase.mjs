/**
 * exchanges/coinbase.mjs
 * Coinbase Advanced Trade API v3 — spot crypto only.
 *
 * Supports two key types (auto-detected):
 *
 *   NEW (CDP keys — what coinbase.com now issues):
 *     COINBASE_API_KEY        = key name, e.g. "organizations/xxx/apiKeys/yyy"
 *     COINBASE_API_SECRET     = EC or Ed25519 private key PEM (paste as-is in settings)
 *     COINBASE_API_PASSPHRASE = leave blank
 *     Auth: JWT Bearer — key type auto-detected (ES256 or EdDSA)
 *
 *   LEGACY (older coinbase.com keys):
 *     COINBASE_API_KEY        = API key
 *     COINBASE_API_SECRET     = API secret
 *     COINBASE_API_PASSPHRASE = API passphrase
 *     Auth: HMAC-SHA256
 *
 * Notes:
 *   - Spot only — no leverage, no native shorting
 *   - SHORT signals will close any open long and go flat
 *   - Symbol format: "BTC", "ETH", "SOL" or "BTC-USD" — converted internally
 *   - BUY orders use quote_size (USD amount); SELL orders use base_size (asset amount)
 */

import crypto from "crypto";
import { randomUUID } from "crypto";

const BASE = "https://api.coinbase.com";

function toProductId(asset) {
  const base = asset.replace(/-USD$|\/USD$/i, "").toUpperCase();
  return `${base}-USD`;
}

function toCurrencyCode(asset) {
  return asset.replace(/-USD$|\/USD$/i, "").toUpperCase();
}

// ── JWT auth helpers (new CDP keys) ──────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// Convert DER-encoded ECDSA signature → raw r||s (IEEE P1363 / JWS)
function derToConcat(der, coordLen = 32) {
  let pos = 2; // skip SEQUENCE tag + length
  const rLen = der[pos + 1];
  let r = der.slice(pos + 2, pos + 2 + rLen);
  pos += 2 + rLen;
  const sLen = der[pos + 1];
  let s = der.slice(pos + 2, pos + 2 + sLen);
  while (r.length > coordLen) r = r.slice(1);
  while (s.length > coordLen) s = s.slice(1);
  const out = Buffer.alloc(coordLen * 2);
  r.copy(out, coordLen - r.length);
  s.copy(out, coordLen * 2 - s.length);
  return out;
}

function createJwt(keyName, privateKeyPem, method, path) {
  // Coinbase JWT uri uses path only — strip query string
  const pathOnly = path.split("?")[0];
  const now = Math.floor(Date.now() / 1000);

  // Auto-detect key type: Ed25519 or EC (P-256)
  const keyObj = crypto.createPrivateKey(privateKeyPem);
  const isEd25519 = keyObj.asymmetricKeyType === "ed25519";
  const alg = isEd25519 ? "EdDSA" : "ES256";

  const header  = b64url(JSON.stringify({ alg, kid: keyName }));
  const payload = b64url(JSON.stringify({
    sub: keyName,
    iss: "coinbase-cloud",
    nbf: now,
    exp: now + 120,
    uri: `${method.toUpperCase()} api.coinbase.com${pathOnly}`,
  }));
  const data = `${header}.${payload}`;

  let sig;
  if (isEd25519) {
    sig = crypto.sign(null, Buffer.from(data), keyObj);
  } else {
    const s = crypto.createSign("SHA256");
    s.update(data);
    sig = derToConcat(s.sign({ key: keyObj, dsaEncoding: "der" }));
  }
  return `${data}.${b64url(sig)}`;
}

// ── Exchange class ────────────────────────────────────────────────────────────

export class CoinbaseExchange {
  constructor(apiKey, apiSecret, passphrase) {
    this.apiKey     = apiKey;
    this.apiSecret  = apiSecret;
    this.passphrase = passphrase;
    // No passphrase = new CDP JWT key
    this._useJwt = !passphrase;
    if (this._useJwt) {
      // PEM stored in .env with literal \n — restore real newlines
      this._pem = apiSecret.replace(/\\n/g, "\n");
    }
  }

  get name() { return "Coinbase"; }

  // ── HMAC signing (legacy keys) ──────────────────────────────────────────────

  _sign(timestamp, method, path, body = "") {
    const message = timestamp + method.toUpperCase() + path + body;
    return crypto
      .createHmac("sha256", this.apiSecret)
      .update(message)
      .digest("hex");
  }

  // ── Unified request ─────────────────────────────────────────────────────────

  async _request(method, path, body) {
    const bodyStr = body ? JSON.stringify(body) : "";
    let headers = { "Content-Type": "application/json" };

    if (this._useJwt) {
      const jwt = createJwt(this.apiKey, this._pem, method, path);
      headers["Authorization"] = `Bearer ${jwt}`;
    } else {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      headers["CB-ACCESS-KEY"]        = this.apiKey;
      headers["CB-ACCESS-SIGN"]       = this._sign(timestamp, method, path, bodyStr);
      headers["CB-ACCESS-TIMESTAMP"]  = timestamp;
      headers["CB-ACCESS-PASSPHRASE"] = this.passphrase;
    }

    const res = await fetch(BASE + path, {
      method,
      headers,
      body: bodyStr || undefined,
    });

    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`Coinbase ${res.status}: ${text}`); }
    if (!res.ok) {
      const msg = json?.message ?? json?.error_details ?? JSON.stringify(json);
      throw new Error(`Coinbase ${res.status}: ${msg}`);
    }
    return json;
  }

  // ── Public interface ────────────────────────────────────────────────────────

  async getMidPrice(asset) {
    const productId = toProductId(asset);
    const data = await this._request("GET", `/api/v3/brokerage/best_bid_ask?product_ids=${productId}`);
    const book = data?.pricebooks?.find(p => p.product_id === productId);
    if (!book) throw new Error(`No Coinbase price for ${productId}`);
    const bid = parseFloat(book.bids?.[0]?.price ?? "0");
    const ask = parseFloat(book.asks?.[0]?.price ?? "0");
    if (!bid || !ask) throw new Error(`Empty order book for ${productId}`);
    return (bid + ask) / 2;
  }

  /**
   * Every account, all pages. Coinbase returns 49 per page by default and an
   * account exists for every currency ever listed, so one page misses most of them.
   */
  async listAccounts() {
    const all = [];
    let cursor = null;
    for (let page = 0; page < 40; page++) {
      const qs = `?limit=250${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const data = await this._request("GET", `/api/v3/brokerage/accounts${qs}`);
      all.push(...(data?.accounts ?? []));
      if (!data?.has_next || !data?.cursor) break;
      cursor = data.cursor;
    }
    return all;
  }

  /**
   * Holdings as Coinbase's portfolio summary reports them: one row per asset and
   * account type, with the USD value. This is the only place staked balances
   * appear (the account list shows them as 0 available, 0 hold).
   * Returns [{ currency, amount, usd, tradable, staked }].
   */
  async listPortfolioHoldings() {
    const out = [];
    const list = await this._request("GET", "/api/v3/brokerage/portfolios");
    for (const pf of list?.portfolios ?? []) {
      const data = await this._request("GET", `/api/v3/brokerage/portfolios/${pf.uuid}`);
      for (const p of data?.breakdown?.spot_positions ?? []) {
        const amount = parseFloat(p.total_balance_crypto ?? "0");
        if (!(amount > 0)) continue;
        out.push({
          currency: p.asset,
          amount,
          usd:      parseFloat(p.total_balance_fiat ?? "0") || 0,
          tradable: parseFloat(p.available_to_trade_crypto ?? "0") || 0,
          staked:   /STAKED/i.test(p.account_type ?? ""),
        });
      }
    }
    return out;
  }

  async getPosition(asset) {
    const currency = toCurrencyCode(asset);
    const accounts = await this.listAccounts();
    const account = accounts.find(a => a.currency === currency);
    if (!account) return null;
    const available = parseFloat(account.available_balance?.value ?? "0");
    if (available < 1e-8) return null;
    return { szi: available.toFixed(8), entryPx: "0" };
  }

  async placeLimitOrder(asset, side, size, limitPrice) {
    const productId = toProductId(asset);
    const clientOrderId = randomUUID();
    console.log(`[coinbase] Limit ${side.toUpperCase()} ${size} ${productId} @ $${limitPrice}`);
    return this._request("POST", "/api/v3/brokerage/orders", {
      client_order_id: clientOrderId,
      product_id: productId,
      side: side.toUpperCase(),
      order_configuration: {
        limit_limit_gtc: {
          base_size: size.toString(),
          limit_price: limitPrice.toString(),
        },
      },
    });
  }

  async getOpenOrders() {
    const data = await this._request("GET", "/api/v3/brokerage/orders/historical/batch?order_status=OPEN&limit=100");
    return (data?.orders ?? []).map(o => {
      const cfg = o.order_configuration?.limit_limit_gtc
               ?? o.order_configuration?.limit_limit_gtd
               ?? {};
      return {
        id: o.order_id,
        asset: (o.product_id ?? "").replace("-USD", ""),
        side: (o.side ?? "").toLowerCase(),
        size: parseFloat(cfg.base_size ?? o.filled_size ?? "0"),
        limitPrice: parseFloat(cfg.limit_price ?? "0"),
      };
    });
  }

  async cancelOrder(orderId) {
    return this._request("POST", "/api/v3/brokerage/orders/batch_cancel", {
      order_ids: [orderId],
    });
  }

  async editOrder(orderId, asset, side, size, limitPrice) {
    console.log(`[coinbase] Editing order ${orderId}: ${size} ${asset} @ $${limitPrice}`);
    return this._request("POST", "/api/v3/brokerage/orders/edit", {
      order_id: orderId,
      order_configuration: {
        limit_limit_gtc: {
          base_size: size.toString(),
          limit_price: limitPrice.toString(),
        },
      },
    });
  }

  async setLeverage(asset, leverage) {
    if (leverage > 1) console.warn(`[coinbase] Leverage >1 not supported — ignoring`);
  }

  async placeMarketOrder(asset, side, size) {
    const productId = toProductId(asset);
    const clientOrderId = randomUUID();
    const orderConfig = side === "buy"
      ? { market_market_ioc: { quote_size: size.toString() } }
      : { market_market_ioc: { base_size: size.toString() } };

    console.log(`[coinbase] ${side.toUpperCase()} ${size} ${productId} @ market`);
    return this._request("POST", "/api/v3/brokerage/orders", {
      client_order_id:     clientOrderId,
      product_id:          productId,
      side:                side.toUpperCase(),
      order_configuration: orderConfig,
    });
  }

  async closePosition(asset) {
    const position = await this.getPosition(asset);
    if (!position) {
      console.log(`[coinbase] No open position for ${asset}`);
      return null;
    }
    const size = Math.abs(parseFloat(position.szi));
    console.log(`[coinbase] Closing ${size} ${asset}`);
    return this.placeMarketOrder(asset, "sell", size);
  }
}
