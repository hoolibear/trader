/**
 * hyperliquid.mjs
 * Hyperliquid perps client using the official @nktkas/hyperliquid SDK.
 * Env: AGENT_PRIVATE_KEY — 0x-prefixed private key
 */

import Decimal from "decimal.js";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { mainnet } from "viem/chains";
import { ExchangeClient, InfoClient, HttpTransport } from "@nktkas/hyperliquid";
import { formatPrice } from "@nktkas/hyperliquid/utils";

const transport = new HttpTransport();

// Perp asset index cache: name → index
let _assetIndexCache = null;
// Perp szDecimals cache: name → szDecimals
let _perpSzCache = null;
// Spot: name → { pairIndex, szDecimals }
let _spotIndexCache = null;

async function _loadCaches() {
  const info = new InfoClient({ transport });
  if (!_assetIndexCache) {
    const meta = await info.meta();
    _assetIndexCache = {};
    _perpSzCache = {};
    meta.universe.forEach((a, i) => {
      _assetIndexCache[a.name.toUpperCase()] = i;
      _perpSzCache[a.name.toUpperCase()] = a.szDecimals;
    });
  }
  if (!_spotIndexCache) {
    const spotMeta = await info.spotMeta();
    _spotIndexCache = {};
    const tokenByIdx = {};
    spotMeta.tokens.forEach(t => { tokenByIdx[t.index] = { name: t.name.toUpperCase(), szDecimals: t.szDecimals }; });
    spotMeta.universe.forEach(pair => {
      const tok = tokenByIdx[pair.tokens[0]];
      if (tok) _spotIndexCache[tok.name] = { pairIndex: pair.index, szDecimals: tok.szDecimals };
    });
  }
}

function getSzDecimals(asset) {
  const upper = asset.toUpperCase();
  if (_spotIndexCache?.[upper] !== undefined) return _spotIndexCache[upper].szDecimals;
  return _perpSzCache?.[upper] ?? 5;
}

function fmtSize(size, asset) {
  const dec = getSzDecimals(asset);
  return new Decimal(String(size)).toDecimalPlaces(dec).toFixed(dec);
}

/**
 * Format a price the way Hyperliquid accepts it: at most 5 significant figures
 * and at most (6 − szDecimals) decimals for perps, (8 − szDecimals) for spot.
 * A price outside these rules is rejected ("Invalid TP/SL price" for triggers).
 * Pure — no network. Truncates, never rounds.
 */
export function formatHlPrice(px, szDecimals, type = "perp") {
  return formatPrice(new Decimal(String(px)).toFixed(), szDecimals, type);
}

// Same, looking the asset's decimals up in the meta caches. Callers must have
// awaited _loadCaches() (getAssetIndex and getMidPrice both do).
function fmtPrice(px, asset) {
  return formatHlPrice(px, getSzDecimals(asset), isSpotAsset(asset) ? "spot" : "perp");
}

async function getAssetIndex(asset) {
  await _loadCaches();
  const upper = asset.toUpperCase();
  if (_assetIndexCache[upper] !== undefined) return _assetIndexCache[upper];
  if (_spotIndexCache[upper] !== undefined)
    throw new Error(`${asset} is spot-only on Hyperliquid — no perp market available`);
  throw new Error(`Unknown asset: ${asset}`);
}

function isSpotAsset(asset) {
  const upper = asset.toUpperCase();
  return _spotIndexCache?.[upper] !== undefined && _assetIndexCache?.[upper] === undefined;
}

// `signer` is either a 0x-prefixed private key string, or a viem-style local
// account ({ address, signTypedData }) — e.g. a Vultisig MPC account. @nktkas
// accepts a local account directly as `wallet`; a raw key is wrapped in a
// viem WalletClient first (the established path).
function makeClients(signer) {
  if (typeof signer === "string") {
    const wallet = privateKeyToAccount(signer);
    const walletClient = createWalletClient({ account: wallet, chain: mainnet, transport: http() });
    const exchange = new ExchangeClient({ transport, wallet: walletClient });
    const info = new InfoClient({ transport });
    return { exchange, info, wallet };
  }
  const exchange = new ExchangeClient({ transport, wallet: signer });
  const info = new InfoClient({ transport });
  return { exchange, info, wallet: signer };
}

// ── Info (read-only) ─────────────────────────────────────────────────────────

export async function getAccountState(address) {
  const info = new InfoClient({ transport });
  return info.clearinghouseState({ user: address });
}

export async function getMidPrice(asset) {
  await _loadCaches();
  const info = new InfoClient({ transport });
  const mids = await info.allMids();
  const upper = asset.toUpperCase();
  // Spot assets appear in allMids as "@{pairIndex}", not by name
  if (_spotIndexCache?.[upper] !== undefined) {
    const spotKey = `@${_spotIndexCache[upper].pairIndex}`;
    return mids[spotKey] ? parseFloat(mids[spotKey]) : null;
  }
  const key = Object.keys(mids).find(k => k.toUpperCase() === upper);
  return key ? parseFloat(mids[key]) : null;
}

export async function getPosition(address, asset) {
  await _loadCaches();
  if (isSpotAsset(asset)) {
    const info = new InfoClient({ transport });
    const state = await info.spotClearinghouseState({ user: address });
    const bal = (state?.balances ?? []).find(b => b.coin.toUpperCase() === asset.toUpperCase());
    const total = parseFloat(bal?.total ?? "0");
    if (total <= 0) return null;
    // Return perp-compatible shape; entryPx unknown for spot
    return { szi: String(total), entryPx: "0", coin: asset };
  }
  const state = await getAccountState(address);
  const positions = state?.assetPositions ?? [];
  const pos = positions.find(p => p.position?.coin?.toUpperCase() === asset.toUpperCase());
  return pos?.position ?? null;
}

// ── Place order ──────────────────────────────────────────────────────────────

/**
 * Place a market order (IOC limit at ±1% slippage).
 * @param {string} privateKey  0x-prefixed private key
 * @param {string} asset       e.g. "BTC"
 * @param {"buy"|"sell"} side
 * @param {number} size        position size in asset units
 * @param {number} [slippage]  fraction, default 0.01 (1%)
 */
export async function placeMarketOrder(privateKey, asset, side, size, slippage = 0.01) {
  const { exchange, wallet } = makeClients(privateKey);
  const isBuy = side === "buy";

  const mid = await getMidPrice(asset);
  if (!mid) throw new Error(`Could not get mid price for ${asset}`);

  const assetIdx = await getAssetIndex(asset);

  const limitPx = fmtPrice(isBuy ? mid * (1 + slippage) : mid * (1 - slippage), asset);

  console.log(`[hyperliquid] Placing ${side.toUpperCase()} ${size} ${asset} @ ~$${mid.toLocaleString()} (limit $${parseFloat(limitPx).toLocaleString()})`);

  const result = await exchange.order({
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: limitPx,
      s: fmtSize(size, asset),
      r: false,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });

  return result;
}

/**
 * Set leverage for an asset before placing an order.
 * @param {string} privateKey  0x-prefixed private key
 * @param {string} asset       e.g. "BTC"
 * @param {number} leverage    1–50
 * @param {boolean} [isCross]  cross-margin (default: false = isolated)
 */
export async function setLeverage(privateKey, asset, leverage, isCross = false) {
  await _loadCaches();
  if (isSpotAsset(asset)) return;
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  console.log(`[hyperliquid] Setting leverage: ${leverage}x ${isCross ? "cross" : "isolated"} for ${asset}`);
  return exchange.updateLeverage({ asset: assetIdx, isCross, leverage });
}

/**
 * Place a GTC limit order.
 */
export async function placeLimitOrder(privateKey, asset, side, size, limitPrice) {
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  const isBuy = side === "buy";
  console.log(`[hyperliquid] Limit ${side.toUpperCase()} ${size} ${asset} @ $${limitPrice}`);
  return exchange.order({
    orders: [{
      a: assetIdx,
      b: isBuy,
      p: fmtPrice(limitPrice, asset),
      s: fmtSize(size, asset),
      r: false,
      t: { limit: { tif: "Gtc" } },
    }],
    grouping: "na",
  });
}

/**
 * Fetch open orders for an address.
 * Returns normalized [{ id, asset, side, size, limitPrice }]
 */
export async function getOpenOrders(address) {
  const info = new InfoClient({ transport });
  const orders = await info.openOrders({ user: address });
  return (orders ?? []).map(o => ({
    id: o.oid,
    asset: o.coin,
    side: o.side === "B" ? "buy" : "sell",
    size: parseFloat(o.sz),
    limitPrice: parseFloat(o.limitPx),
  }));
}

/**
 * Resting reduce-only trigger orders (stops / take-profits) for one asset.
 * Returns [{ id, asset, side, size, triggerPrice }].
 */
export async function getStopOrders(address, asset) {
  const info = new InfoClient({ transport });
  const orders = await info.frontendOpenOrders({ user: address });
  return (orders ?? [])
    .filter(o => o.isTrigger && o.reduceOnly && o.coin?.toUpperCase() === asset.toUpperCase())
    .map(o => ({
      id: o.oid,
      asset: o.coin,
      side: o.side === "B" ? "buy" : "sell",
      size: parseFloat(o.sz),
      triggerPrice: parseFloat(o.triggerPx),
    }));
}

/**
 * Place a native stop-loss order (trigger market, reduce-only).
 * Returns { result, oid } — oid is null if the exchange didn't echo it.
 */
export async function placeStopOrder(signer, asset, isLong, size, triggerPrice) {
  const { exchange } = makeClients(signer);
  const assetIdx = await getAssetIndex(asset);
  // Limit px is worst acceptable fill — 5% slippage beyond trigger guarantees market fill
  const limitPx   = fmtPrice(isLong ? triggerPrice * 0.95 : triggerPrice * 1.05, asset);
  const triggerPx = fmtPrice(triggerPrice, asset);
  console.log(`[hyperliquid] Native SL ${isLong ? "SELL" : "BUY"} ${size} ${asset} trigger $${triggerPx} limit $${limitPx}`);
  const result = await exchange.order({
    orders: [{
      a: assetIdx,
      b: !isLong,
      p: limitPx,
      s: fmtSize(size, asset),
      r: true,
      t: { trigger: { triggerPx, isMarket: true, tpsl: "sl" } },
    }],
    grouping: "na",
  });
  const status = result?.response?.data?.statuses?.[0];
  const oid = status?.resting?.oid ?? status?.filled?.oid ?? null;
  return { result, oid };
}

/**
 * Cancel an open order by asset + order ID.
 */
export async function cancelOrder(privateKey, asset, oid) {
  const { exchange } = makeClients(privateKey);
  const assetIdx = await getAssetIndex(asset);
  return exchange.cancel({ cancels: [{ a: assetIdx, o: oid }] });
}

/**
 * Fetch OHLCV candle snapshots from Hyperliquid.
 * interval: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "2h" | "4h" | "8h" | "12h" | "1d"
 * Returns last `count` closed candles, each: { t, T, s, i, o, c, h, l, v, n }
 */
export async function getFundingRate(asset) {
  await _loadCaches();
  const info = new InfoClient({ transport });
  const [meta, ctxs] = await info.metaAndAssetCtxs();
  const idx = meta.universe.findIndex(a => a.name.toUpperCase() === asset.toUpperCase());
  if (idx === -1) return null;
  const ctx = ctxs[idx];
  return {
    funding:       parseFloat(ctx.funding),
    openInterest:  parseFloat(ctx.openInterest),
    markPx:        parseFloat(ctx.markPx),
    dayNtlVlm:     parseFloat(ctx.dayNtlVlm),
  };
}

export async function getCandleSnapshots(asset, interval, count = 100) {
  const INTERVAL_MS = {
    "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000, "30m": 1800000,
    "1h": 3600000, "2h": 7200000, "4h": 14400000, "8h": 28800000, "12h": 43200000,
    "1d": 86400000, "3d": 259200000, "1w": 604800000,
  };
  const intervalMs = INTERVAL_MS[interval] ?? 60000;
  const endTime = Date.now();
  const startTime = endTime - intervalMs * (count + 50);
  const info = new InfoClient({ transport });
  const candles = await info.candleSnapshot({ coin: asset.toUpperCase(), interval, startTime, endTime });
  return Array.isArray(candles) ? candles.slice(-count) : [];
}

/**
 * Fetch fills where the given address was liquidated (not where they liquidated others).
 * @param {string} address  0x-prefixed wallet address
 * @param {number} sinceMs  epoch ms — only fills after this time
 */
export async function getLiquidationFills(address, sinceMs) {
  const info = new InfoClient({ transport });
  const fills = await info.userFillsByTime({ user: address, startTime: sinceMs });
  return fills.filter(f =>
    f.liquidation && f.liquidation.liquidatedUser.toLowerCase() === address.toLowerCase()
  );
}

/**
 * Close all positions for an asset (reduce-only IOC).
 */
export async function closePosition(privateKey, asset) {
  const { exchange, wallet } = makeClients(privateKey);
  const pos = await getPosition(wallet.address, asset);

  if (!pos || parseFloat(pos.szi ?? "0") === 0) {
    console.log(`[hyperliquid] No open position for ${asset}`);
    return null;
  }

  const size = Math.abs(parseFloat(pos.szi));
  const mid = await getMidPrice(asset);
  const slippage = 0.01;
  const assetIdx = await getAssetIndex(asset);
  console.log(`[hyperliquid] Closing ${size} ${asset} position`);

  if (isSpotAsset(asset)) {
    const limitPx = fmtPrice(mid * (1 - slippage), asset);
    return exchange.order({
      orders: [{
        a: assetIdx,
        b: false,
        p: limitPx,
        s: fmtSize(size, asset),
        r: false,
        t: { limit: { tif: "Ioc" } },
      }],
      grouping: "na",
    });
  }

  const isLong = parseFloat(pos.szi) > 0;
  const limitPx = fmtPrice(isLong ? mid * (1 - slippage) : mid * (1 + slippage), asset);

  return exchange.order({
    orders: [{
      a: assetIdx,
      b: !isLong,
      p: limitPx,
      s: fmtSize(size, asset),
      r: true,
      t: { limit: { tif: "Ioc" } },
    }],
    grouping: "na",
  });
}

// ── Funding (deposit / withdraw) ───────────────────────────────────────────────

/**
 * Withdraw USDC from the Hyperliquid perp account to an Arbitrum address.
 * Hyperliquid deducts a flat $1 fee and bridges to Arbitrum (~5 min). The
 * destination defaults to the signer's own address. `amount` is USDC as a
 * number/string (the gross amount; you receive amount − $1).
 * `signer` is a raw key string or a viem-style MPC account (vault).
 */
export async function withdrawFunds(signer, amount, destination) {
  const { exchange, wallet } = makeClients(signer);
  const dest = (destination ?? wallet.address).toLowerCase();
  const amt = new Decimal(String(amount)).toFixed(2);
  console.log(`[hyperliquid] Withdraw ${amt} USDC → ${dest} (−$1 fee)`);
  return exchange.withdraw3({ destination: dest, amount: amt });
}

/** Withdrawable USDC (free perp margin) for an address. */
export async function getWithdrawable(address) {
  const st = await getAccountState(address);
  return parseFloat(st?.withdrawable ?? "0");
}

/**
 * Account abstraction mode. "unifiedAccount" merges spot + perp USDC into one
 * balance (spot is usable as perp margin directly, no usdClassTransfer needed,
 * withdraw3 pulls from the unified balance). Other modes keep them separate.
 * Returns one of: unifiedAccount | portfolioMargin | dexAbstraction | disabled | default.
 */
export async function getAbstraction(address) {
  const info = new InfoClient({ transport });
  try { return await info.userAbstraction({ user: address }); }
  catch { return "default"; }
}

/** USDC sitting in the spot account (not usable as perp margin until swept). */
export async function getSpotUsdc(address) {
  const info = new InfoClient({ transport });
  const st = await info.spotClearinghouseState({ user: address });
  return parseFloat(st?.balances?.find(b => b.coin === "USDC")?.total ?? "0");
}

/**
 * Move USDC between the spot and perp accounts. `toPerp=true` sweeps spot→perp
 * (needed before withdrawing or trading spot funds); `false` does perp→spot.
 * `signer` is a raw key string or a viem-style MPC account (vault).
 */
export async function transferSpotPerp(signer, amount, toPerp = true) {
  const { exchange } = makeClients(signer);
  const amt = new Decimal(String(amount)).toFixed(2);
  console.log(`[hyperliquid] usdClassTransfer ${amt} USDC ${toPerp ? "spot→perp" : "perp→spot"}`);
  return exchange.usdClassTransfer({ amount: amt, toPerp });
}
