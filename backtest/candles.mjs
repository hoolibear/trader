/**
 * backtest/candles.mjs — hourly price history for backtests.
 *
 * Source: Binance's public market-data mirror (no key, no account). Candles are
 * cached in backtest/data/<SYMBOL>-1h.json and only the missing tail is fetched
 * on later runs. Prices are the USDT pair, used as a stand-in for USDC.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const HERE     = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, "data");
const BASE     = "https://data-api.binance.vision/api/v3/klines";
const HOUR     = 3600_000;

/** Returns [{ t, o, h, l, c }] hourly, oldest first. */
export async function loadHourly(asset) {
  mkdirSync(DATA_DIR, { recursive: true });
  const file = resolve(DATA_DIR, `${asset}-1h.json`);
  let candles = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];

  let from = candles.length ? candles.at(-1).t + HOUR : 0;
  const lastClosed = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  let fetched = 0;
  while (from <= lastClosed) {
    const res = await fetch(`${BASE}?symbol=${asset}USDT&interval=1h&limit=1000&startTime=${from}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Price history for ${asset}: HTTP ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;
    for (const r of rows) {
      if (r[0] > lastClosed) break;
      candles.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
    }
    fetched += rows.length;
    from = rows.at(-1)[0] + HOUR;
    if (rows.length < 1000) break;
  }
  if (fetched) writeFileSync(file, JSON.stringify(candles));
  return candles;
}

/** Group hourly candles into 4-hour candles aligned to 00:00 UTC. */
export function to4h(hourly) {
  const out = [];
  for (const c of hourly) {
    const t = Math.floor(c.t / (4 * HOUR)) * 4 * HOUR;
    const last = out.at(-1);
    if (last && last.t === t) { last.h = Math.max(last.h, c.h); last.l = Math.min(last.l, c.l); last.c = c.c; last.n++; }
    else out.push({ t, o: c.o, h: c.h, l: c.l, c: c.c, n: 1 });
  }
  return out;
}
