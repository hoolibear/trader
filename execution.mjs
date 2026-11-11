/**
 * execution.mjs — shared trade-execution engine.
 *
 * Extracted from trader.mjs so the cron path (trader.mjs) and the on-demand
 * paths (dashboard.mjs's /api/run and /api/execute routes, and the desktop
 * app's scheduler) run identical logic — same guards, cooldown, native
 * stop-loss, TP/trail, and retry handling. Do not duplicate this logic elsewhere.
 *
 * Unlike trader.mjs (a short-lived CLI process), this module may be imported
 * by the long-lived dashboard process, so credentials/URLs are read live from
 * process.env on every call rather than snapshotted at import time — this
 * matches dashboard.mjs's existing getSignalUrl() pattern and means Settings
 * changes apply without a restart.
 */

import { argv } from "process";
import Decimal from "decimal.js";

import {
  upsertSignal, getLatestSignal, insertTrade, insertSignalEvent,
  setTpState, getTpState, updateTpTrailMode, updateTpHighWater, clearTpState,
  logFetch, getLastTradeTime, setSubscriptionExpiry, setStrategyRiskMode,
  getTradingWallet, setStrategyAdaptiveSl, setStrategyStopOrderId, getStrategyStopOrderId,
  getLastStrategyEntry, raiseAlert, resolveAlert,
} from "./db.mjs";

import { HyperliquidExchange } from "./exchanges/hyperliquid.mjs";
import { KrakenExchange } from "./exchanges/kraken.mjs";
import { AlpacaExchange } from "./exchanges/alpaca.mjs";
import { CoinbaseExchange } from "./exchanges/coinbase.mjs";
import { SchwabExchange } from "./exchanges/schwab.mjs";

export function getSignalUrl() {
  return process.env.AGENT_SIGNAL_URL ?? "https://agentsignal.app";
}

// Dry run: no orders and no state written. Set by `--dry-run` or TRADER_DRY_RUN=1.
export function isDryRun() {
  return argv.includes("--dry-run") || process.env.TRADER_DRY_RUN === "1";
}

function assetOf(strategy) {
  return strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
}

// Open an alert for a human (dashboard banner / desktop notification).
// Dry runs only log it.
function alert(strategy, code, message, level = "critical") {
  console.warn(`[trader] 🚨 ${message}`);
  if (isDryRun()) return;
  raiseAlert({ strategy_id: strategy?.id ?? "", code, message, level });
}

function clearAlert(strategy, code) {
  if (isDryRun()) return;
  resolveAlert(strategy?.id ?? "", code);
}

// ── x402 network config ───────────────────────────────────────────────────────

const X402_NETWORKS = {
  "eip155:8453":  { viemChain: "base",        rpc: "https://mainnet.base.org" },
  "eip155:1":     { viemChain: "mainnet",     rpc: "https://eth.llamarpc.com" },
  "eip155:42161": { viemChain: "arbitrum",    rpc: "https://arb1.arbitrum.io/rpc" },
  "eip155:137":   { viemChain: "polygon",     rpc: "https://polygon-rpc.com" },
  "eip155:43114": { viemChain: "avalanche",   rpc: "https://api.avax.network/ext/bc/C/rpc" },
  "eip155:84532": { viemChain: "baseSepolia", rpc: "https://sepolia.base.org" },
};

function getPaymentNetwork() {
  return process.env.X402_PAYMENT_NETWORK || "eip155:8453";
}

// Resolve the Hyperliquid signer once and cache it. When the Vultisig MPC vault
// is the active trading wallet, this is a viem-style account that co-signs with
// VultiServer; otherwise the Hyperliquid branch uses the raw AGENT_PRIVATE_KEY.
let _vaultSigner;
async function getVaultSigner() {
  if (_vaultSigner !== undefined) return _vaultSigner;
  const vultFilePath = process.env.VULT_FILE_PATH?.trim();
  if (!vultFilePath) throw new Error("VAULT_ACTIVE=true but VULT_FILE_PATH is not set — create/import a vault from the dashboard");
  const { loadVultisigAccount } = await import("./vultisig-account.mjs");
  _vaultSigner = await loadVultisigAccount({ vultPath: vultFilePath, password: process.env.VULTISIG_PASS });
  console.log(`[trader] 🔐 Vultisig MPC vault active — signing as ${_vaultSigner.address}`);
  return _vaultSigner;
}

export async function getExchange(strategy) {
  const exch = strategy.exchange ?? "hyperliquid";
  if (exch === "kraken") {
    const key = process.env.KRAKEN_API_KEY?.trim();
    const secret = process.env.KRAKEN_API_SECRET?.trim();
    if (!key || !secret) throw new Error("KRAKEN_API_KEY and KRAKEN_API_SECRET are required for Kraken strategies");
    return new KrakenExchange(key, secret, strategy.leverage ?? 1);
  }
  if (exch === "alpaca") {
    const key = process.env.ALPACA_API_KEY?.trim();
    const secret = process.env.ALPACA_API_SECRET?.trim();
    if (!key || !secret) throw new Error("ALPACA_API_KEY and ALPACA_API_SECRET are required for Alpaca strategies");
    return new AlpacaExchange(key, secret, process.env.ALPACA_PAPER === "true");
  }
  if (exch === "coinbase") {
    const key = process.env.COINBASE_API_KEY?.trim();
    const secret = process.env.COINBASE_API_SECRET?.trim();
    const passphrase = process.env.COINBASE_API_PASSPHRASE?.trim();
    if (!key || !secret || !passphrase) throw new Error("COINBASE_API_KEY, COINBASE_API_SECRET, and COINBASE_API_PASSPHRASE are required for Coinbase strategies");
    return new CoinbaseExchange(key, secret, passphrase);
  }
  if (exch === "schwab") {
    const key = process.env.SCHWAB_API_KEY?.trim();
    const secret = process.env.SCHWAB_APP_SECRET?.trim();
    if (!key || !secret) throw new Error("SCHWAB_API_KEY and SCHWAB_APP_SECRET are required for Schwab strategies");
    return new SchwabExchange(key, secret, {
      optionMode:  strategy.option_mode  ?? null,
      dteTarget:   strategy.dte_target   ?? 30,
      deltaTarget: strategy.delta_target ?? 0.30,
      contracts:   strategy.contracts    ?? 1,
    });
  }
  if (process.env.VAULT_ACTIVE === "true") {
    return new HyperliquidExchange(await getVaultSigner());
  }
  // The db trading wallet is the source of truth; the dashboard keeps
  // AGENT_PRIVATE_KEY in sync with it, so env is the fallback.
  const key = getTradingWallet()?.key ?? process.env.AGENT_PRIVATE_KEY?.trim();
  if (!key) throw new Error("No trading wallet set and AGENT_PRIVATE_KEY is unset — pick a wallet in the dashboard");
  return new HyperliquidExchange(key);
}

// ── Retry / guard helpers ─────────────────────────────────────────────────────

export async function withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isTransient =
        err.cause?.code === "ECONNRESET" || err.cause?.code === "ETIMEDOUT" ||
        err.cause?.code === "ENOTFOUND"  || err.cause?.code === "ECONNREFUSED" ||
        err.message?.includes("fetch failed") || err.message?.includes("timeout");
      if (!isTransient || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(`[trader] Network error, retry ${attempt}/${maxAttempts - 1} in ${delay}ms: ${err.message}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

export function runGuards(strategy, sizeUsd) {
  if (strategy.max_size_usd && sizeUsd > strategy.max_size_usd) {
    return `position size $${sizeUsd} exceeds max $${strategy.max_size_usd}`;
  }
  if (strategy.cooldown_minutes) {
    const lastTrade = getLastTradeTime(strategy.id);
    if (lastTrade) {
      const minutesAgo = (Date.now() - new Date(lastTrade + "Z").getTime()) / 60000;
      if (minutesAgo < strategy.cooldown_minutes) {
        return `cooldown active — last trade ${Math.round(minutesAgo)}min ago (cooldown: ${strategy.cooldown_minutes}min)`;
      }
    }
  }
  return null;
}

// ── Indicator helpers ─────────────────────────────────────────────────────────

export function minutesToInterval(min) {
  const m = { 1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 60: "1h", 120: "2h", 240: "4h", 480: "8h", 720: "12h", 1440: "1d" };
  return m[min] ?? `${min}m`;
}

export function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeSMA(values, period) {
  if (values.length < period) return null;
  return values.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function computeEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return ema;
}

// Wilder's smoothed ATR. Candles must have .h .l .c fields.
function computeATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = parseFloat(candles[i].h), l = parseFloat(candles[i].l), pc = parseFloat(candles[i - 1].c);
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

// ── Strategy definition fetch (free, no x402) ────────────────────────────────

export async function fetchStrategyDef(strategyId) {
  try {
    const res = await fetch(`${getSignalUrl()}/api/strategy/${strategyId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// ── Local eval — price thresholds + candle indicators (no x402) ──────────────

export async function tryLocalEval(strategy, def, exchangeIn) {
  try {
    if (!def) return null;
    const parse = v => typeof v === "string" ? JSON.parse(v) : v;

    const risk = parse(def.risk) ?? {};

    const hasConditions = r => r?.conditions?.length > 0;
    const entry       = hasConditions(parse(def.long_entry))  ? parse(def.long_entry)  : parse(def.entry);
    const exit        = hasConditions(parse(def.long_exit))   ? parse(def.long_exit)   : parse(def.exit);
    const shortEntry  = hasConditions(parse(def.short_entry)) ? parse(def.short_entry) : null;
    const shortExit   = hasConditions(parse(def.short_exit))  ? parse(def.short_exit)  : null;

    const allConds = [
      ...(entry?.conditions ?? []), ...(exit?.conditions ?? []),
      ...(shortEntry?.conditions ?? []), ...(shortExit?.conditions ?? []),
    ];
    if (!allConds.length) return null;

    const priceFlds     = new Set(["close", "price", "last", "mark", "open", "high", "low"]);
    const indicatorFlds = new Set(["rsi", "sma", "ema"]);
    const passthroughFlds = new Set(["pct_above_entry", "pct_below_entry"]);
    const knownFlds     = new Set([...priceFlds, ...indicatorFlds, ...passthroughFlds]);

    const asset    = assetOf(strategy);
    const exchange = exchangeIn ?? await getExchange(strategy);

    // Fetch position first — needed to decide whether RADAR gate applies
    const [price, position] = await Promise.all([
      withRetry(() => exchange.getMidPrice(asset)),
      withRetry(() => exchange.getPosition(asset)),
    ]);
    if (!price) return null;

    const hasPosition = parseFloat(position?.szi ?? "0") !== 0;
    const isLong      = parseFloat(position?.szi ?? "0") > 0;

    // Crypto RADAR gate blocks new entries only — if flat, defer entry decision to server.
    // When already in a position, evaluate exit conditions locally; RADAR is irrelevant to exits.
    if (!hasPosition && (risk.crypto_radar_long_gate != null || risk.crypto_radar_short_gate != null)) {
      console.log(`[trader] 📡 Crypto RADAR gate configured — deferring entry signal to server`);
      return null;
    }

    // When in a position, only the relevant exit conditions matter.
    // Unknown fields in entry rules (e.g. macd_cross) shouldn't block exit evaluation.
    const relevantConds = hasPosition
      ? (isLong ? [...(exit?.conditions ?? [])] : [...(shortExit?.conditions ?? [])])
      : allConds;

    if (!relevantConds.length) return null;
    if (!relevantConds.every(c => knownFlds.has((c.field ?? "close").toLowerCase()))) return null;

    const needsCandles = relevantConds.some(c => indicatorFlds.has((c.field ?? "close").toLowerCase()));

    // Fetch candles + compute indicators if needed
    const indicatorValues = {};
    if (needsCandles) {
      if (typeof exchange.getCandles !== "function") return null; // exchange doesn't support candles
      const defaultInterval = minutesToInterval(strategy.interval_minutes ?? 60);
      const intervals = new Set(relevantConds.map(c => c.interval ?? defaultInterval));
      const candlesByInterval = {};
      for (const iv of intervals) {
        const candles = await withRetry(() => exchange.getCandles(asset, iv, 100));
        candlesByInterval[iv] = candles.map(c => parseFloat(c.c));
      }
      for (const c of relevantConds) {
        const field = (c.field ?? "close").toLowerCase();
        if (!indicatorFlds.has(field)) continue;
        const iv     = c.interval ?? defaultInterval;
        const period = parseInt(c.period ?? 14);
        const key    = `${field}_${period}_${iv}`;
        if (indicatorValues[key] !== undefined) continue;
        const closes = candlesByInterval[iv];
        if (!closes?.length) continue;
        switch (field) {
          case "rsi": indicatorValues[key] = computeRSI(closes, period); break;
          case "sma": indicatorValues[key] = computeSMA(closes, period); break;
          case "ema": indicatorValues[key] = computeEMA(closes, period); break;
        }
      }
    }

    const defaultInterval = minutesToInterval(strategy.interval_minutes ?? 60);
    const evalRules = (rules) => {
      if (!rules?.conditions?.length) return false;
      const results = rules.conditions.map(c => {
        const field = (c.field ?? "close").toLowerCase();
        const v     = parseFloat(c.value);
        let actual;
        if (indicatorFlds.has(field)) {
          const period = parseInt(c.period ?? 14);
          const iv     = c.interval ?? defaultInterval;
          actual = indicatorValues[`${field}_${period}_${iv}`];
        } else {
          actual = price;
        }
        if (passthroughFlds.has(field)) {
          const entryPx = parseFloat(position?.entryPx ?? "0");
          if (!entryPx || !hasPosition) return true;
          if (field === "pct_above_entry") {
            actual = isLong
              ? (price - entryPx) / entryPx * 100
              : (entryPx - price) / entryPx * 100;
          } else if (field === "pct_below_entry") {
            actual = isLong
              ? (entryPx - price) / entryPx * 100
              : (price - entryPx) / entryPx * 100;
          } else {
            return true;
          }
        }
        if (actual == null) return false;
        const op = c.op;
        if (op === "<="  || op === "lte") return actual <= v;
        if (op === ">="  || op === "gte") return actual >= v;
        if (op === "<"   || op === "lt")  return actual <  v;
        if (op === ">"   || op === "gt")  return actual >  v;
        return false;
      });
      return rules.operator === "AND" ? results.every(Boolean) : results.some(Boolean);
    };

    // Funding gate check (mirrors server-side fail-closed logic)
    let fundingRate = null;
    if (risk.funding_long_gate != null || risk.funding_short_gate != null) {
      try {
        const fRes = await fetch("https://api.hyperliquid.xyz/info", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        });
        const [meta, ctxs] = await fRes.json();
        const idx = meta.universe.findIndex(a => a.name === asset);
        if (idx !== -1) fundingRate = parseFloat(ctxs[idx].funding);
      } catch { /* funding unavailable — fail closed */ }
    }
    const longGateOk  = risk.funding_long_gate  == null || (fundingRate !== null && fundingRate <= risk.funding_long_gate);
    const shortGateOk = risk.funding_short_gate == null || (fundingRate !== null && fundingRate >= risk.funding_short_gate);

    // 4-ruleset scalper model: long + short independent entry/exit
    let signal;
    if (shortEntry) {
      if (hasPosition) {
        const isLong  = parseFloat(position?.szi ?? "0") > 0;
        signal = isLong
          ? (evalRules(exit)      ? "FLAT" : "LONG")
          : (evalRules(shortExit) ? "FLAT" : "SHORT");
      } else {
        if      (evalRules(entry)      && longGateOk)  signal = "LONG";
        else if (evalRules(shortEntry) && shortGateOk) signal = "SHORT";
        else                                            signal = "FLAT";
      }
    } else {
      // Legacy long-only model
      signal = hasPosition
        ? (evalRules(exit)  ? "FLAT" : "LONG")
        : (evalRules(entry) ? "LONG" : "FLAT");
    }

    const indLog = Object.entries(indicatorValues)
      .map(([k, v]) => {
        const [fld, period, iv] = k.split("_");
        return `${fld.toUpperCase()}(${period},${iv})=${v?.toFixed(2)}`;
      })
      .join(" ");
    console.log(`[trader] 📊 Local eval: ${asset} @ $${price.toLocaleString()}${indLog ? " | " + indLog : ""} | pos: ${hasPosition ? "open" : "flat"} → ${signal}`);
    return { signal, price };
  } catch (err) {
    console.warn(`[trader] Local eval failed: ${err.message}`);
    return null;
  }
}

// ── x402 payer ────────────────────────────────────────────────────────────────
// The wallet that pays for signals is the wallet that trades: the Vultisig
// vault when it is active, else the db trading wallet, else AGENT_PRIVATE_KEY.
// Returns { address, makeSigner(chain, rpc) } — makeSigner gives the object
// ExactEvmScheme needs (an `address` plus signTypedData).
export async function getPaymentAccount() {
  if (process.env.VAULT_ACTIVE === "true") {
    try {
      const vault = await getVaultSigner();
      return { address: vault.address, isVault: true, makeSigner: () => vault };
    } catch (e) {
      console.warn(`[trader] Vault unavailable for x402 payment: ${e.message} — trying raw key`);
    }
  }
  const key = getTradingWallet()?.key ?? process.env.AGENT_PRIVATE_KEY?.trim();
  if (!key) throw new Error("No wallet available to pay for signals (no vault, no trading wallet, no AGENT_PRIVATE_KEY)");
  const { createWalletClient, http } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(key);
  return {
    address: account.address,
    isVault: false,
    makeSigner: (chain, rpc) =>
      Object.assign(createWalletClient({ account, chain, transport: http(rpc) }), { address: account.address }),
  };
}

// ── Subscribe strategy (lump-sum x402) ───────────────────────────────────────

export async function subscribeStrategy(strategyId, intervalMinutes, period) {
  const PERIOD_DAYS = { day: 1, week: 7, month: 30, year: 365 };
  const days = PERIOD_DAYS[period];
  if (!days) throw new Error(`Invalid subscription period: ${period}`);

  const url = `${getSignalUrl()}/api/strategy/${strategyId}/subscribe?interval_minutes=${intervalMinutes}&period=${period}`;
  const { x402Client } = await import("@x402/core/client");
  const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const allChains = await import("viem/chains");

  const account = await getPaymentAccount();
  const client = new x402Client();

  const probe = await fetch(url, { method: "POST", headers: { "X-Wallet-Address": account.address } });
  if (probe.ok) return await probe.json();
  if (probe.status !== 402) throw new Error(`Subscribe API ${probe.status}`);

  const rawHeader = probe.headers.get("payment-required") ?? probe.headers.get("X-PAYMENT-REQUIRED");
  if (!rawHeader) throw new Error("No payment-required header");
  const paymentRequired = decodePaymentRequiredHeader(rawHeader);

  const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
  const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS["eip155:8453"];
  const chain = allChains[networkCfg.viemChain];
  const signer = account.makeSigner(chain, networkCfg.rpc);
  client.register(serverNetwork, new ExactEvmScheme(signer));

  const calls = Math.round((60 / intervalMinutes) * 24 * days);
  const priceUsd = (Math.round(calls * 0.01 * 100) / 100).toFixed(2);
  console.log(`[trader] 🔄 Auto-renewing ${period} subscription for strategy ${strategyId} — $${priceUsd}`);

  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeader = encodePaymentSignatureHeader(paymentPayload);
  const paid = await fetch(url, { method: "POST", headers: { "payment-signature": paymentHeader, "X-Wallet-Address": account.address } });
  if (!paid.ok) throw new Error(`Subscription payment rejected (${paid.status})`);
  return await paid.json();
}

// ── Entry confirmation gate ───────────────────────────────────────────────────
// Two checks run on every new scalper entry signal. Exits (FLAT) are never
// blocked. Returns { slPct } on pass, null on block. Fails open — candle errors
// return { slPct: strategy.sl_pct } so the configured SL still applies.
//
// (Layers 1 and 2 — an RSI band and an EMA50 trend filter — were removed: they
// blocked the low-RSI entries that mean-reversion strategies exist to take.
// The L3/L4 names are kept so old log lines still make sense.)
//
// Layer 3 — ATR volatility regime: if ATR(14) > 1.5×ATR(50), market is stressed
//           — stand aside until volatility normalises.
// Layer 4 — BTC macro filter: if BTC drops >2.5% on the last 4h candle, skip
//           all alt entries (most alt selloffs are BTC-led).
// Adaptive SL — computed as 1.5×ATR(14) / price, clamped [3%, 15%]. Widens in
//           volatile conditions, tightens in calm ones. Stored in
//           strategies.sl_pct_adaptive for the life of the position and used
//           for the native stop order.
//
// TUNING: if too many blocks → raise the ATR ratio (e.g. 1.8×) or the BTC
//         threshold (e.g. -3.5%). If too many losses → lower them.

export async function confirmEntry(strategy, signal, exchange) {
  if (signal !== "LONG" && signal !== "SHORT") return { slPct: strategy.sl_pct };
  const asset = strategy.symbol.replace(/-USD$/, "").replace(/\/USD$/, "");
  try {
    const position = await withRetry(() => exchange.getPosition(asset));
    if (parseFloat(position?.szi ?? "0") !== 0) return { slPct: strategy.sl_pct }; // already in

    if (typeof exchange.getCandles !== "function") return { slPct: strategy.sl_pct };
    const iv      = minutesToInterval(strategy.interval_minutes ?? 60);
    const candles = await withRetry(() => exchange.getCandles(asset, iv, 60));
    if (!candles?.length) return { slPct: strategy.sl_pct };

    const closes = candles.map(c => parseFloat(c.c));
    const price  = closes[closes.length - 1];
    const atr14  = computeATR(candles, 14);
    const atr50  = computeATR(candles, 50);

    // ── Layer 3: ATR volatility regime ───────────────────────────────────
    if (atr14 != null && atr50 != null && atr14 > atr50 * 1.5) {
      console.log(`[trader] 🚫 Gate L3 blocked ${signal} — elevated volatility (ATR14 ${atr14.toFixed(4)} > 1.5×ATR50 ${atr50.toFixed(4)})`);
      return null;
    }

    // ── Layer 4: BTC macro filter ────────────────────────────────────────
    try {
      const now = Date.now();
      const btcRaw = await fetch("https://api.hyperliquid.xyz/info", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "candleSnapshot", req: { coin: "BTC", interval: "4h", startTime: now - 3 * 4 * 3600 * 1000, endTime: now } }),
      }).then(r => r.json());
      if (Array.isArray(btcRaw) && btcRaw.length >= 2) {
        const prev = parseFloat(btcRaw[btcRaw.length - 2].c);
        const cur  = parseFloat(btcRaw[btcRaw.length - 1].c);
        const chg  = (cur - prev) / prev;
        if (chg < -0.025) {
          console.log(`[trader] 🚫 Gate L4 blocked ${signal} — BTC down ${(chg * 100).toFixed(1)}% in last 4h (macro risk)`);
          return null;
        }
      }
    } catch { /* BTC fetch failed — fail open */ }

    // ── Adaptive SL: 1.5×ATR as % of price, clamped [3%, 15%] ──────────
    let slPct = strategy.sl_pct ?? 7;
    if (atr14 != null && price > 0) {
      slPct = Math.max(3, Math.min(15, parseFloat((1.5 * atr14 / price * 100).toFixed(2))));
    }

    console.log(`[trader] ✅ Entry gate passed — ATR14/50 ${atr14?.toFixed(4)}/${atr50?.toFixed(4)} | adaptive SL ${slPct.toFixed(2)}%`);
    return { slPct };
  } catch (err) {
    console.warn(`[trader] ⚠️  Entry gate error: ${err.message} — allowing entry`);
    return { slPct: strategy.sl_pct }; // fail open
  }
}

// ── Fetch signal from agentsignal.app ─────────────────────────────────────────

export async function fetchSignal(strategy) {
  const strategyId = typeof strategy === "string" ? strategy : strategy.id;
  const isScalper = strategy.risk?.mode === "scalp";
  const url = isScalper
    ? `${getSignalUrl()}/api/scalper/${strategyId}/signal`
    : `${getSignalUrl()}/api/strategy/${strategyId}/signal`;
  const AGENT_API_KEY = process.env.AGENT_API_KEY?.trim();
  try {
    const { x402Client } = await import("@x402/core/client");
    const { decodePaymentRequiredHeader, encodePaymentSignatureHeader } = await import("@x402/core/http");
    const { ExactEvmScheme } = await import("@x402/evm/exact/client");
    const allChains = await import("viem/chains");

    const account = await getPaymentAccount();
    const client = new x402Client();

    // Step 1: probe — send API key header so AgentSignal can bypass x402 for paid subscribers
    const probeHeaders = { "X-Wallet-Address": account.address };
    if (AGENT_API_KEY) probeHeaders["Authorization"] = "Bearer " + AGENT_API_KEY;
    const probe = await fetch(url, { headers: probeHeaders });
    if (probe.ok) {
      const data = await probe.json();
      const network = AGENT_API_KEY ? "api_key" : "bypass";
      console.log(`[trader] ✅ Signal fetched for ${strategyId} (${network}): ${data.signal}`);
      logFetch({ strategy_id: strategyId, network, cost_usd: 0 });
      clearAlert({ id: strategyId }, "signal_fetch_failed");
      return data;
    }
    if (probe.status !== 402) throw new Error(`Signal API ${probe.status}`);

    // Auto-renew subscription if strategy has a preferred period and it has expired locally
    const subPeriod = typeof strategy === "object" ? strategy.subscription_period : null;
    const subExpiresAt = typeof strategy === "object" ? strategy.subscription_expires_at : null;
    const subStillValid = subExpiresAt && new Date(subExpiresAt) > new Date();
    if (subPeriod && !subStillValid) {
      try {
        const iv = typeof strategy === "object" ? (strategy.interval_minutes ?? 60) : 60;
        const subResult = await subscribeStrategy(strategyId, iv, subPeriod);
        // Record expiry locally so we don't try again until it actually expires
        if (subResult?.expires_at) setSubscriptionExpiry(strategyId, subResult.expires_at);
        // Retry — subscription now active
        const retried = await fetch(url, { headers: { "X-Wallet-Address": account.address } });
        if (retried.ok) {
          const data = await retried.json();
          console.log(`[trader] ✅ Signal fetched for ${strategyId} (auto-renewed ${subPeriod}): ${data.signal}`);
          logFetch({ strategy_id: strategyId, network: "subscription", cost_usd: 0 });
          clearAlert({ id: strategyId }, "signal_fetch_failed");
          return data;
        }
      } catch (e) {
        console.warn(`[trader] Auto-renew failed: ${e.message} — falling back to per-call`);
      }
    } else if (subStillValid) {
      console.log(`[trader] 📋 Subscription valid until ${subExpiresAt} — skipping auto-renew`);
    }

    // Warn if falling back to per-call — subscription missing or expired
    const subExpired = subExpiresAt && new Date(subExpiresAt) <= new Date();
    if (subExpired) {
      console.warn(`[trader] ⚠️  Subscription expired ${subExpiresAt} — paying per-call. Renew from the dashboard.`);
    } else if (!subPeriod) {
      console.warn(`[trader] ⚠️  No subscription set for ${strategyId} — paying per-call. Set one from the dashboard.`);
    }

    // Step 2: decode payment requirement — network comes FROM the server's 402 response
    // x402 v2 uses "payment-required"; v1 used "X-PAYMENT-REQUIRED" — try both
    const rawHeader = probe.headers.get("payment-required") ?? probe.headers.get("X-PAYMENT-REQUIRED");
    if (!rawHeader) throw new Error("No payment-required header in 402 response");
    const paymentRequired = decodePaymentRequiredHeader(rawHeader);

    // Step 3: resolve network from the server's requirement (not from local settings)
    const serverNetwork = paymentRequired.accepts?.[0]?.network ?? paymentRequired.accepts?.network;
    const networkCfg = X402_NETWORKS[serverNetwork] ?? X402_NETWORKS[getPaymentNetwork()] ?? X402_NETWORKS["eip155:8453"];
    const chain = allChains[networkCfg.viemChain];

    // ExactEvmScheme reads signer.address directly — makeSigner surfaces it
    const signer = account.makeSigner(chain, networkCfg.rpc);
    const evmScheme = new ExactEvmScheme(signer);
    client.register(serverNetwork, evmScheme);

    console.warn(`[trader] 💳 Per-call payment on ${networkCfg.label ?? serverNetwork} ($0.01)`);

    // Step 4: create and sign payment payload
    const paymentPayload = await client.createPaymentPayload(paymentRequired);
    const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

    // Step 5: retry with payment
    // x402 v2 server reads "payment-signature" (core server extractPayment)
    const res = await fetch(url, { headers: { "payment-signature": paymentHeader, "X-Wallet-Address": account.address } });
    if (!res.ok) {
      const errHeader = res.headers.get("payment-required") ?? res.headers.get("X-PAYMENT-REQUIRED") ?? "";
      try {
        const decoded = errHeader ? JSON.parse(Buffer.from(errHeader, "base64").toString()) : {};
        console.error(`[trader] x402 verify rejected (${res.status}):`, JSON.stringify(decoded));
      } catch {
        console.error(`[trader] x402 verify rejected (${res.status}): raw=`, errHeader.slice(0, 300));
      }
      throw new Error(`Signal API ${res.status} after payment`);
    }
    const data = await res.json();
    console.log(`[trader] ✅ Signal fetched for ${strategyId}: ${data.signal}`);
    logFetch({ strategy_id: strategyId, network: serverNetwork, cost_usd: 0.01 });
    clearAlert({ id: strategyId }, "signal_fetch_failed");
    return data;
  } catch (err) {
    console.warn(`[trader] Signal fetch failed: ${err.message}`);
    alert({ id: strategyId }, "signal_fetch_failed", `Signal fetch failed for ${typeof strategy === "object" ? strategy.name ?? strategyId : strategyId}: ${err.message}`, "warning");
    return null;
  }
}

// ── TP / Trail stop monitor ───────────────────────────────────────────────────
// Works for both sides. For a long: TP is above entry, the trail follows the
// highest price seen and closes when price falls trail_pct below it. For a
// short everything is mirrored: TP below entry, the trail follows the lowest
// price and closes when price rises trail_pct above it.
// tp_state.high_water holds the best price seen (highest for a long, lowest
// for a short). Returns true when the position was closed here.

export async function checkTpTrail(strategy, exchangeIn) {
  const asset    = assetOf(strategy);
  const exchange = exchangeIn ?? await getExchange(strategy);
  const dry      = isDryRun();

  // Check actual position on exchange — not signal state
  const position = await withRetry(() => exchange.getPosition(asset));
  const szi      = parseFloat(position?.szi ?? "0");

  // No open position — clear stale TP state and bail
  if (szi === 0) {
    if (!dry) clearTpState(strategy.id);
    return false;
  }
  const isLong = szi > 0;
  const dir    = isLong ? 1 : -1;

  let state = getTpState(strategy.id);

  // State left over from a position on the other side — discard it
  if (state && (state.tp_price >= state.entry_price) !== isLong) {
    if (!dry) clearTpState(strategy.id);
    state = null;
  }

  // Position exists but no TP state (e.g. manual entry) — auto-initialize
  if (!state && strategy.tp_pct) {
    const entryPrice = parseFloat(position?.entryPx ?? "0");
    if (entryPrice > 0) {
      const init = {
        strategy_id: strategy.id,
        entry_price: entryPrice,
        tp_price:    entryPrice * (1 + dir * strategy.tp_pct / 100),
        trail_pct:   strategy.trail_pct ?? 1,
      };
      if (dry) state = { ...init, trail_mode: 0, high_water: null };
      else { setTpState(init); state = getTpState(strategy.id); }
      console.log(`[trader] 📊 Auto-initialized TP for ${strategy.name}: entry $${entryPrice.toLocaleString()} → TP $${init.tp_price.toLocaleString()}`);
    }
  }
  if (!state) return false;

  const price = await withRetry(() => exchange.getMidPrice(asset));
  if (!price) return false;

  if (!state.trail_mode) {
    // Waiting for TP to be hit
    const hit = isLong ? price >= state.tp_price : price <= state.tp_price;
    if (hit) {
      console.log(`[trader] 🎯 TP hit @ $${price.toLocaleString()} (target $${state.tp_price.toLocaleString()}) — switching to trail`);
      if (!dry) updateTpTrailMode(strategy.id, price);
    }
    return false;
  }

  // In trail mode — track the best price seen
  const prevBest = state.high_water ?? price;
  const best     = isLong ? Math.max(prevBest, price) : Math.min(prevBest, price);
  if (best !== state.high_water && !dry) updateTpHighWater(strategy.id, best);

  const stopPrice = best * (1 - dir * state.trail_pct / 100);
  console.log(`[trader] 📈 Trail (${isLong ? "long" : "short"}): price $${price.toLocaleString()} | best $${best.toLocaleString()} | stop $${stopPrice.toLocaleString()}`);

  const triggered = isLong ? price <= stopPrice : price >= stopPrice;
  if (!triggered) return false;

  console.log(`[trader] 🛑 Trail stop triggered @ $${price.toLocaleString()} — closing position`);
  if (dry) {
    console.log(`[trader] [DRY RUN] Would close via trail stop`);
    return false;
  }

  const entryPx = parseFloat(position?.entryPx ?? "0") || state.entry_price;
  const size    = Math.abs(szi);
  const pnl     = parseFloat(((price - entryPx) * size * dir).toFixed(2));

  await cancelNativeStop(strategy, exchange, asset);
  await withRetry(() => exchange.closePosition(asset));

  clearTpState(strategy.id);
  setStrategyAdaptiveSl(strategy.id, null);
  insertTrade({
    strategy_id: strategy.id,
    action: `TRAIL STOP @ $${price.toLocaleString()} (best $${best.toLocaleString()})`,
    asset,
    size,
    price,
    leverage: strategy.leverage ?? 1,
    pnl,
    result: { trail_stop: true, side: isLong ? "long" : "short", best, stop_price: stopPrice },
  });
  console.log(`[trader] P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
  return true; // position closed by trail
}

// ── Native stop-loss ──────────────────────────────────────────────────────────

export async function cancelNativeStop(strategy, exchange, asset) {
  const oid = getStrategyStopOrderId(strategy.id);
  if (!oid) return;
  try {
    await exchange.cancelOrder(oid, asset);
    console.log(`[trader] 🗑 Native stop cancelled (order ${oid})`);
  } catch (e) {
    console.warn(`[trader] Could not cancel stop order ${oid}: ${e.message}`);
  }
  setStrategyStopOrderId(strategy.id, null);
}

/**
 * Read an order result. Returns:
 *   { filled: true, size, price }  — order filled (fully or partly)
 *   { filled: false, error }       — order was accepted but nothing filled
 *   null                           — result shape not recognised (exchanges
 *                                    other than Hyperliquid); caller falls back
 *                                    to the requested size and the mid price
 */
export function parseFill(result) {
  const statuses = result?.response?.data?.statuses;
  if (!Array.isArray(statuses) || !statuses.length) return null;
  const st = statuses[0];
  if (st?.filled) {
    const size  = parseFloat(st.filled.totalSz);
    const price = parseFloat(st.filled.avgPx);
    if (size > 0 && price > 0) return { filled: true, size, price };
    return { filled: false, error: "order reported zero fill" };
  }
  if (st?.error) return { filled: false, error: String(st.error) };
  return { filled: false, error: "order did not fill" };
}

/**
 * Place the native stop for a position. Never throws: the position is already
 * open, so a failure here must not lose the trade record. On failure (after one
 * retry) an alert is raised and ensureNativeStop() tries again next cycle.
 * Returns the stop order id, or null.
 */
export async function placeProtectiveStop(strategy, exchange, asset, isLong, size, refPrice) {
  if (!strategy.sl_pct || typeof exchange.placeStopOrder !== "function") return null;
  const slPrice = refPrice * (1 - (isLong ? 1 : -1) * strategy.sl_pct / 100);

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { oid } = await exchange.placeStopOrder(asset, isLong, size, slPrice);
      if (oid) {
        setStrategyStopOrderId(strategy.id, oid);
        clearAlert(strategy, "stop_missing");
        clearAlert(strategy, "stop_breached");
        console.log(`[trader] 🛑 Native SL set: $${slPrice.toLocaleString()} (${strategy.sl_pct}% · order ${oid})`);
        return oid;
      }
      lastErr = new Error("exchange returned no order id");
      break; // order may be resting — do not place a second one; next cycle checks the book
    } catch (e) {
      lastErr = e;
      console.warn(`[trader] Stop order attempt ${attempt}/2 failed: ${e.message}`);
    }
  }
  alert(strategy, "stop_missing",
    `${strategy.name}: ${isLong ? "long" : "short"} ${size} ${asset} has NO stop-loss on the exchange — stop order failed: ${lastErr?.message}. Will retry each run.`);
  return null;
}

/**
 * Make sure an open position has its stop on the exchange. Runs every cycle.
 *  - stop already resting → nothing to do
 *  - no stop, level not reached → place it from the position's entry price
 *  - no stop, level already breached → place nothing (it would close the
 *    position at once), raise an alert and leave the decision to the user
 */
export async function ensureNativeStop(strategy, exchangeIn) {
  const exchange = exchangeIn ?? await getExchange(strategy);
  if (!strategy.sl_pct || typeof exchange.placeStopOrder !== "function") return;
  const asset = assetOf(strategy);
  const dry   = isDryRun();

  const position = await withRetry(() => exchange.getPosition(asset));
  const szi      = parseFloat(position?.szi ?? "0");
  if (szi === 0) {
    if (!dry && getStrategyStopOrderId(strategy.id)) setStrategyStopOrderId(strategy.id, null);
    clearAlert(strategy, "stop_missing");
    clearAlert(strategy, "stop_breached");
    return;
  }
  const isLong = szi > 0;
  const mid    = await withRetry(() => exchange.getMidPrice(asset));
  if (!mid) return;

  // Is a stop already resting?
  const stored = getStrategyStopOrderId(strategy.id);
  if (typeof exchange.getStopOrders === "function") {
    const stops = (await withRetry(() => exchange.getStopOrders(asset)))
      // only orders that close this position on the losing side of the market
      .filter(o => (isLong ? o.side === "sell" && o.triggerPrice < mid : o.side === "buy" && o.triggerPrice > mid));
    const mine = stops.find(o => String(o.id) === String(stored)) ?? stops[0];
    if (mine) {
      if (!dry && String(mine.id) !== String(stored)) setStrategyStopOrderId(strategy.id, mine.id);
      clearAlert(strategy, "stop_missing");
      clearAlert(strategy, "stop_breached");
      return;
    }
  } else if (stored) {
    return; // cannot inspect the book — trust the stored order id
  }

  const entryPx = parseFloat(position?.entryPx ?? "0");
  if (!(entryPx > 0)) return;
  const slPrice  = entryPx * (1 - (isLong ? 1 : -1) * strategy.sl_pct / 100);
  const breached = isLong ? mid <= slPrice : mid >= slPrice;

  if (breached) {
    if (!dry && stored) setStrategyStopOrderId(strategy.id, null);
    alert(strategy, "stop_breached",
      `${strategy.name}: ${isLong ? "long" : "short"} ${Math.abs(szi)} ${asset} has NO stop-loss, and price $${mid.toLocaleString()} is already past its stop level $${slPrice.toLocaleString()} (${strategy.sl_pct}% from entry $${entryPx.toLocaleString()}). No stop was placed — close it or set a stop by hand.`);
    return;
  }

  if (dry) {
    console.log(`[trader] [DRY RUN] Would place missing stop for ${asset} @ $${slPrice.toLocaleString()}`);
    return;
  }
  console.log(`[trader] 🛡 ${asset} position has no stop on the exchange — placing one`);
  await placeProtectiveStop(strategy, exchange, asset, isLong, Math.abs(szi), entryPx);
}

// Hold-cycle upkeep for an open position: trail/TP check, then stop check.
// Returns true when the trail stop closed the position.
async function maintainPosition(strategy, exchange) {
  if (await checkTpTrail(strategy, exchange)) return true;
  try {
    await ensureNativeStop(strategy, exchange);
  } catch (e) {
    console.warn(`[trader] Stop check failed for ${strategy.name}: ${e.message}`);
  }
  return false;
}

// ── Execute trade ─────────────────────────────────────────────────────────────

async function closeOpenPosition({ strategy, exchange, asset, position, midPrice, leverage, flip }) {
  const currentSize = parseFloat(position?.szi ?? "0");
  const entryPrice  = parseFloat(position?.entryPx ?? "0");
  const dir         = currentSize > 0 ? 1 : -1;
  const size        = Math.abs(currentSize);

  await cancelNativeStop(strategy, exchange, asset);
  const result = await withRetry(() => exchange.closePosition(asset));
  const fill   = parseFill(result);
  const price  = fill?.filled ? fill.price : midPrice;

  let pnl = null;
  if (entryPrice > 0) {
    pnl = new Decimal(price).minus(entryPrice).times(size).times(dir).toDecimalPlaces(2).toNumber();
    console.log(`[trader] P&L: ${pnl >= 0 ? "+" : ""}$${pnl}`);
  }

  clearTpState(strategy.id);
  setStrategyAdaptiveSl(strategy.id, null);
  clearAlert(strategy, "stop_missing");
  clearAlert(strategy, "stop_breached");

  const action = `CLOSED ${size} ${asset} @ ~$${price.toLocaleString()}${flip ? " (flip)" : ""}`;
  insertTrade({ strategy_id: strategy.id, action, asset, size, price, leverage, pnl, result });
  console.log(`[trader] ✅ ${action}`);
  return action;
}

async function openPosition({ strategy, exchange, asset, side, positionSize, midPrice, leverage }) {
  const isLong = side === "LONG";

  await withRetry(() => exchange.setLeverage(asset, leverage));
  // Not retried: an order is not idempotent. Retrying after a timeout could
  // open the position twice.
  const result = await exchange.placeMarketOrder(asset, isLong ? "buy" : "sell", positionSize);

  const fill = parseFill(result);
  if (fill && !fill.filled) throw new Error(`Entry order did not fill: ${fill.error}`);
  const size  = fill?.size  ?? positionSize;
  const price = fill?.price ?? midPrice;
  if (fill && size < positionSize * 0.99) {
    console.warn(`[trader] ⚠️  Partial fill: ${size} of ${positionSize} ${asset}`);
  }

  // Record the trade first — nothing after this point may lose it.
  const action = `ENTERED ${side} ${size} ${asset} @ ~$${price.toLocaleString()} (${leverage}x)`;
  insertTrade({ strategy_id: strategy.id, action, asset, size, price, leverage, pnl: null, result });
  console.log(`[trader] ✅ ${action}`);

  if (strategy.tp_pct && strategy.trail_pct) {
    const tpPrice = price * (1 + (isLong ? 1 : -1) * strategy.tp_pct / 100);
    setTpState({ strategy_id: strategy.id, entry_price: price, tp_price: tpPrice, trail_pct: strategy.trail_pct });
    console.log(`[trader] 🎯 TP set: ${isLong ? "+" : "−"}${strategy.tp_pct}% = $${tpPrice.toLocaleString()} | trail ${strategy.trail_pct}%`);
  }

  await placeProtectiveStop(strategy, exchange, asset, isLong, size, price);
  return action;
}

/**
 * Bring the position in line with the signal.
 *   LONG  + flat  → open long          SHORT + flat → open short
 *   FLAT  + open  → close
 *   SHORT + long  → close, open short  LONG + short → close, open long
 * Guards (max size, cooldown) apply to entries only — an exit is never blocked.
 * Returns the action as text.
 */
export async function executeTrade(strategy, signal, priorSignal, deps = {}) {
  return (await executeTradeDetailed(strategy, signal, priorSignal, deps)).action;
}

async function executeTradeDetailed(strategy, signal, priorSignal, deps = {}) {
  const asset    = assetOf(strategy);
  const leverage = strategy.leverage ?? 1;
  const sizeUsd  = strategy.position_size_usd ?? parseFloat(process.env.HL_POSITION_SIZE_USD ?? "10");

  const exchange = deps.exchange ?? await getExchange(strategy);

  const midPrice = await withRetry(() => exchange.getMidPrice(asset));
  if (!midPrice) throw new Error(`Could not get price for ${asset}`);

  const positionSize = new Decimal(sizeUsd).times(leverage).div(midPrice).toDecimalPlaces(5).toNumber();

  const position    = await withRetry(() => exchange.getPosition(asset));
  const currentSize = parseFloat(position?.szi ?? "0");
  const isFlat = currentSize === 0;
  const isLong = currentSize > 0;

  console.log(`[trader] ${strategy.name} (${exchange.name}) — signal: ${priorSignal?.signal ?? "N/A"} → ${signal} | position: ${currentSize} ${asset}`);

  const wantsLong  = signal === "LONG";
  const wantsShort = signal === "SHORT";
  const needClose  = !isFlat && (signal === "FLAT" || (wantsShort && isLong) || (wantsLong && !isLong));
  const needOpen   = (wantsLong || wantsShort) && (isFlat || needClose);

  if (!needClose && !needOpen) {
    console.log(`[trader] ⚪ HOLD — no action needed`);
    return { action: "HOLD — no action needed", traded: false };
  }

  // Guards cover the entry only. Checked before any close so the cooldown is
  // measured from the last trade before this run.
  const guardBlock = needOpen ? runGuards(strategy, sizeUsd) : null;
  if (guardBlock) console.warn(`[trader] 🛡 Guard blocked entry: ${guardBlock}`);
  if (guardBlock && !needClose) return { action: `Blocked: ${guardBlock}`, traded: false };

  if (isDryRun()) {
    const parts = [];
    if (needClose) parts.push(`CLOSE ${Math.abs(currentSize)} ${asset}`);
    if (needOpen && !guardBlock) parts.push(`ENTER ${signal} ${positionSize} ${asset} @ ~$${midPrice.toLocaleString()} (${leverage}x)`);
    const action = `[DRY RUN] Would: ${parts.join(" then ")}`;
    console.log(`[trader] ${action}`);
    return { action, traded: false };
  }

  const actions = [];
  if (needClose) {
    actions.push(await closeOpenPosition({ strategy, exchange, asset, position, midPrice, leverage, flip: needOpen }));
  }
  if (needOpen) {
    if (guardBlock) actions.push(`entry blocked: ${guardBlock}`);
    else actions.push(await openPosition({ strategy, exchange, asset, side: signal, positionSize, midPrice, leverage }));
  }
  return { action: actions.join(" → "), traded: true };
}

// ── Run one strategy end-to-end: fetch signal → gate → execute ──────────────
// Used by trader.mjs's cron loop, the desktop app's scheduler and the
// dashboard's /api/run route, so every path gets exactly the same
// guards/cooldown/SL/TP/retry behavior.
//
// `deps` is for tests: { exchange, def, signalData } replace the live exchange,
// the strategy definition fetch and the signal fetch.

// One strategy run at a time per process: the scheduler and a manual "Run" from
// the dashboard must not interleave orders on the same account.
let _runQueue = Promise.resolve();
export function runStrategyOnce(strategy, deps = {}) {
  const next = _runQueue.then(() => runStrategyOnceUnlocked(strategy, deps));
  _runQueue = next.catch(() => {});
  return next;
}

async function runStrategyOnceUnlocked(strategy, deps = {}) {
  const dry = isDryRun();
  const def = deps.def !== undefined ? deps.def : await fetchStrategyDef(strategy.id);
  const parseJson = v => { try { return typeof v === "string" ? JSON.parse(v) : (v ?? {}); } catch { return {}; } };
  const risk = parseJson(def?.risk);
  if (risk?.mode && !dry) setStrategyRiskMode(strategy.id, risk.mode);

  // The user's own stop setting. The gate's adaptive stop (sl_pct_adaptive)
  // overrides it for as long as the position it was computed for is open.
  const baseSlPct = strategy.sl_pct ?? risk.sl_pct ?? risk.stop_loss_pct ?? null;
  const effectiveStrategy = {
    ...strategy,
    risk,  // expose parsed risk so fetchSignal can detect scalper mode + gate checks
    tp_pct:    strategy.tp_pct    ?? risk.tp_pct    ?? null,
    trail_pct: strategy.trail_pct ?? risk.trail_pct ?? null,
    sl_pct:    strategy.sl_pct_adaptive ?? baseSlPct,
  };

  // Try local candle/indicator eval first, fall back to x402 fetch
  const signalData = deps.signalData
    ?? await tryLocalEval(effectiveStrategy, def, deps.exchange)
    ?? await fetchSignal(effectiveStrategy);
  if (!signalData) {
    return { ok: false, error: "Could not fetch signal", fetchFailed: true };
  }
  // A signal arrived (by local evaluation or by fetch) — an earlier fetch failure is over
  clearAlert(strategy, "signal_fetch_failed");

  const signal = signalData.signal;
  const price  = signalData.price ?? null;
  const today  = new Date().toISOString().slice(0, 10);

  // Build notes from scores (signalData.compass is the full market_reports row)
  const c = signalData.compass;
  const scoreNotes = [
    c?.score       != null ? `COMPASS:${c.score}` : null,
    c?.radar_score != null ? `RADAR:${c.radar_score}` : null,
    c?.crypto_radar_score != null ? `CRYPTO:${c.crypto_radar_score}` : null,
  ].filter(Boolean).join(" | ");

  // Read prior signal BEFORE upserting — includes today's earlier fetches for intraday strategies
  const priorSignal   = getLatestSignal(strategy.id);
  const signalChanged = !priorSignal || priorSignal.signal !== signal;

  const isScalper   = effectiveStrategy.risk?.mode === "scalp";
  const directional = signal === "LONG" || signal === "SHORT";
  // Scalpers act on a directional signal whether or not it flipped (they enter
  // on signal + no position). Everything else acts on flips only.
  const actOnSignal = signalChanged || (isScalper && directional);

  if (!dry) {
    upsertSignal({ strategy_id: strategy.id, date: today, signal, price, notes: scoreNotes || null });
    insertSignalEvent({
      strategy_id: strategy.id,
      signal,
      prev_signal: priorSignal?.signal ?? null,
      price,
      notes: scoreNotes || null,
      type: signalChanged ? "flip" : "check",
    });
  }
  if (signalChanged) console.log(`[trader] 🔄 Signal flip: ${priorSignal?.signal ?? "N/A"} → ${signal}`);

  try {
    const exchange = deps.exchange ?? await getExchange(effectiveStrategy);

    if (!actOnSignal) {
      // Nothing to trade — look after any open position (trail/TP, stop present)
      const closedByTrail = await maintainPosition(effectiveStrategy, exchange);
      clearAlert(strategy, "execution_error");
      return { ok: true, signal, action: closedByTrail ? "Closed via TP/trail stop" : `Signal unchanged (${signal}) — holding` };
    }

    // Entry confirmation gate — scalpers only, new entries only
    if (isScalper && directional) {
      const asset    = assetOf(effectiveStrategy);
      const position = await withRetry(() => exchange.getPosition(asset));
      if (parseFloat(position?.szi ?? "0") === 0) {
        const gateResult = await confirmEntry({ ...effectiveStrategy, sl_pct: baseSlPct }, signal, exchange);
        if (!gateResult) return { ok: true, signal, action: `Entry gate blocked ${signal} entry (see logs for which layer)` };
        effectiveStrategy.sl_pct = gateResult.slPct ?? baseSlPct;
        if (gateResult.slPct != null) {
          if (!dry) setStrategyAdaptiveSl(strategy.id, gateResult.slPct);
          console.log(`[trader] 🛡 Stop for this entry: ${Number(gateResult.slPct).toFixed(2)}%`);
        }
      }
    }

    const { action, traded } = await executeTradeDetailed(effectiveStrategy, signal, priorSignal, { exchange });
    if (!traded) {
      // Held (or entry blocked) — still look after an open position
      const closedByTrail = await maintainPosition(effectiveStrategy, exchange);
      clearAlert(strategy, "execution_error");
      if (closedByTrail) return { ok: true, signal, action: "Closed via TP/trail stop" };
    } else {
      clearAlert(strategy, "execution_error");
    }
    return { ok: true, signal, action };
  } catch (err) {
    console.error(`[trader] ❌ Execution error for ${strategy.name}: ${err.message}`);
    alert(strategy, "execution_error", `${strategy.name}: execution failed on signal ${signal} — ${err.message}`, "warning");
    // The signal change was not acted on. Put the stored signal back so the next
    // run sees the change again and retries (otherwise a failed exit is never
    // retried, because the signal would look "unchanged").
    if (!dry && signalChanged && priorSignal) {
      upsertSignal({ strategy_id: strategy.id, date: today, signal: priorSignal.signal, price: priorSignal.price, notes: priorSignal.notes });
    }
    return { ok: false, signal, error: err.message };
  }
}

// ── Position snapshot → AgentSignal account ──────────────────────────────────

export async function syncPositions(strategies) {
  const apiKey = process.env.AGENT_API_KEY?.trim();
  if (!apiKey || !strategies?.length) return null;
  try {
    const snapshot = strategies.map(s => {
      const latest = getLatestSignal(s.id);
      const signal = latest?.signal ?? "FLAT";
      const entry  = signal !== "FLAT" ? getLastStrategyEntry(s.id) : null;
      return {
        strategy_id:   s.id,
        strategy_name: s.name,
        asset:         s.symbol,
        exchange:      s.exchange ?? "hyperliquid",
        signal,
        signal_price:  latest?.price ?? null,
        entry_price:   entry?.price ?? null,
        leverage:      entry?.leverage ?? s.leverage ?? 1,
      };
    });
    const res = await fetch(`${getSignalUrl()}/api/account/positions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ positions: snapshot }),
    });
    if (!res.ok) return null;
    const { synced } = await res.json();
    console.log(`[trader] 📡 Synced ${synced} position(s) to AgentSignal`);
    return synced;
  } catch (e) {
    console.warn(`[trader] ⚠️  Position sync failed: ${e.message}`);
    return null;
  }
}
