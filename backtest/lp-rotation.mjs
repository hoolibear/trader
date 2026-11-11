/**
 * backtest/lp-rotation.mjs — simulate the "LP → leveraged long → LP" rotation.
 *
 * The idea being tested:
 *   1. Hold a ranged token/USDC liquidity position, centred on a start price P0.
 *   2. When the token has fallen `triggerDrop` (30%) from P0 and a turn signal
 *      fires, withdraw the LP and convert it all to USDC.
 *   3. Put half in as margin on a `leverage`x long (3x); keep half as reserve
 *      that tops the margin up if the position nears liquidation.
 *      → total exposure = leverage / 2 of capital (1.5x).
 *   4. Close the long when price reaches `exitAbove` (15%) over P0.
 *   5. Split 50/50 into a new range centred on the current price. Repeat.
 *
 * A second mode, `spot`, is the no-leverage version for Base / Ethereum:
 * at the trigger the whole LP is converted to the token (1x) instead.
 *
 * Everything here is a model. The main simplifications:
 *   - LP fee income is an assumption (see feeApr), not history.
 *   - Fills happen at the trigger / exit price with a flat cost; no slippage
 *     model beyond that, no gas, no failed transactions.
 *   - Funding on the long is a flat yearly rate.
 *   - Reserve top-ups always arrive in time, so liquidation only happens when
 *     margin + reserve together are exhausted.
 */

// ── Uniswap v3 position maths (price of token in USDC) ───────────────────────

/** Liquidity for `value` USDC minted at price P into range [pa, pb]. */
export function mintLiquidity(value, P, pa, pb) {
  const perL = P * (1 / Math.sqrt(P) - 1 / Math.sqrt(pb)) + (Math.sqrt(P) - Math.sqrt(pa));
  return value / perL;
}

/** Token and USDC held by liquidity L at price P. */
export function lpAmounts(L, P, pa, pb) {
  const p = Math.min(Math.max(P, pa), pb);
  return {
    token: L * (1 / Math.sqrt(p) - 1 / Math.sqrt(pb)),
    usdc:  L * (Math.sqrt(p) - Math.sqrt(pa)),
  };
}

export function lpValue(L, P, pa, pb) {
  const a = lpAmounts(L, P, pa, pb);
  return a.token * P + a.usdc;
}

/** How many times more fee-earning liquidity a range holds than a full-range position of the same value. */
export function concentration(P, pa, pb) {
  return (2 * Math.sqrt(P)) / (2 * Math.sqrt(P) - Math.sqrt(pa) - P / Math.sqrt(pb));
}

// ── Indicators on 4h closes ──────────────────────────────────────────────────

export function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (i <= period) {
      g += Math.max(d, 0); l += Math.max(-d, 0);
      if (i === period) { g /= period; l /= period; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    } else {
      g = (g * (period - 1) + Math.max(d, 0)) / period;
      l = (l * (period - 1) + Math.max(-d, 0)) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

export function emaSeries(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let e = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
    else if (i >= period) e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/**
 * Turn signals, evaluated on closed 4h candles. Returns a function (i4h) → bool.
 *   none       enter the moment the drop is reached
 *   rsi        RSI(14) was under 30 in the last 12 candles and has turned back above 35
 *   ema        close back above the 20-candle average, and that average no longer falling fast
 *   higherlow  two 4h candles in a row with a higher low and a higher close
 */
export function turnSignal(kind, c4) {
  const closes = c4.map(c => c.c);
  const rsi = rsiSeries(closes, 14);
  const ema = emaSeries(closes, 20);
  switch (kind) {
    case "none": return () => true;
    case "rsi":  return i => {
      if (i < 13 || rsi[i] == null) return false;
      let wasLow = false;
      for (let k = i - 12; k < i; k++) if (rsi[k] != null && rsi[k] < 30) wasLow = true;
      return wasLow && rsi[i] > 35 && rsi[i] > rsi[i - 1];
    };
    case "ema":  return i => i > 20 && ema[i] != null && closes[i] > ema[i] && closes[i - 1] <= ema[i - 1];
    case "higherlow": return i => i > 2 &&
      c4[i].l > c4[i - 1].l && c4[i - 1].l > c4[i - 2].l && c4[i].c > c4[i - 1].c && c4[i - 1].c > c4[i - 2].c;
    default: throw new Error(`Unknown turn signal: ${kind}`);
  }
}

// ── Simulation ───────────────────────────────────────────────────────────────

export const DEFAULTS = {
  mode: "leveraged",       // "leveraged" (Arbitrum + Hyperliquid) | "spot" (no leverage) | "lp-only" (benchmark)
  rangePct: 0.5,           // range = P0 × (1 ± rangePct)
  triggerDrop: 0.30,       // arm when price ≤ P0 × (1 − triggerDrop)
  turn: "rsi",             // turn signal, see turnSignal()
  maxChase: 0.10,          // while armed, do not enter above P0 × (1 − triggerDrop + maxChase); disarm there
  leverage: 3,
  marginShare: 0.5,        // share of capital posted as margin; the rest is reserve
  exitAbove: 0.15,         // close the long at P0 × (1 + exitAbove)
  baseFeeApr: 0.04,        // fee yield of a FULL-RANGE position; a range earns this × its concentration, only while in range
  swapCost: 0.0015,        // pool fee + slippage on each token⇄USDC conversion (applied to the amount swapped)
  perpFee: 0.00045,        // taker fee per side on the long's notional
  fundingApr: 0.10,        // yearly funding paid by the long, on notional
  maintenance: 0.02,       // maintenance margin fraction
  recentreUp: true,        // when price leaves the top of the range (LP is all USDC), re-centre the range
  // Optional safety rules (off = the rule exactly as first specified)
  stopLoss: 0,             // > 0: close the long when price falls this far below entry, then go back to LP
  regime: "none",          // "ma200up": only enter while the 200-day average is rising (pullback in an uptrend)
  exitFromEntry: 0,        // > 0: exit at entry × (1 + this) instead of at exitAbove over the LP start price
  maxDays: 0,              // > 0: give up and return to LP after this many days in the long
};

const YEAR_H = 24 * 365;

/**
 * Run one simulation over hourly candles [{t,o,h,l,c}] and matching 4h candles.
 * Returns { equity: [{t, v}], cycles: [...], final, liquidations, hours: {lp, long} }.
 */
export function simulate(hourly, c4, opts = {}, startIndex = 0) {
  const o = { ...DEFAULTS, ...opts };
  const signal = turnSignal(o.turn, c4);
  const H4 = 4 * 3600_000;
  // 200-day average of 4h closes (1200 candles); "rising" = above its value 30 days (180 candles) earlier
  let ma200 = null;
  if (o.regime === "ma200up") {
    ma200 = new Array(c4.length).fill(null);
    let sum = 0;
    for (let k = 0; k < c4.length; k++) {
      sum += c4[k].c;
      if (k >= 1200) sum -= c4[k - 1200].c;
      if (k >= 1199) ma200[k] = sum / 1200;
    }
  }
  const regimeOk = k => o.regime !== "ma200up" || (ma200[k] != null && ma200[k - 180] != null && ma200[k] > ma200[k - 180]);

  let capital = 10_000;
  let state = "LP";
  let P0, pa, pb, L, feePerHourRate;
  let armed = false;
  let pos = null;                 // { entry, qty, equityAtEntry, openedAt }
  const cycles = [];
  const equity = [];
  let liquidations = 0, hoursLp = 0, hoursLong = 0, recentres = 0;
  let i4 = 0;

  const mint = (value, P) => {
    // half the value is swapped into the token to form the pair
    const v = value * (1 - o.swapCost * 0.5);
    P0 = P; pa = P * (1 - o.rangePct); pb = P * (1 + o.rangePct);
    L = mintLiquidity(v, P, pa, pb);
    feePerHourRate = o.baseFeeApr * concentration(P, pa, pb) / YEAR_H;
    armed = false;
  };
  const lpNow = P => lpValue(L, P, pa, pb);
  const withdrawToUsdc = P => {
    const a = lpAmounts(L, P, pa, pb);
    return a.usdc + a.token * P * (1 - o.swapCost);
  };

  mint(capital, hourly[startIndex].o);

  for (let i = startIndex; i < hourly.length; i++) {
    const c = hourly[i];
    while (i4 + 1 < c4.length && c4[i4 + 1].t + H4 <= c.t) i4++;       // last CLOSED 4h candle
    const closed4h = c4[i4].t + H4 <= c.t;

    if (state === "LP") {
      hoursLp++;
      // fees accrue while in range, compounding into the position's value
      if (c.c > pa && c.c < pb) L *= 1 + feePerHourRate;

      if (o.recentreUp && c.h >= pb) {                                   // out the top: all USDC → re-centre
        const usdc = withdrawToUsdc(pb);
        mint(usdc, pb);
        recentres++;
      } else if (o.mode !== "lp-only") {
        const trigger = P0 * (1 - o.triggerDrop);
        const ceiling = P0 * (1 - o.triggerDrop + o.maxChase);
        if (!armed && c.l <= trigger) armed = true;
        if (armed && c.c > ceiling) armed = false;                       // recovered without us
        if (armed && closed4h && c.c <= ceiling && signal(i4) && regimeOk(i4)) {
          const price = o.turn === "none" ? Math.min(c.o, trigger) : c.c;
          const usdc = withdrawToUsdc(price);
          if (o.mode === "leveraged") {
            const notional = usdc * o.marginShare * o.leverage;
            const eq = usdc - notional * o.perpFee;
            pos = { entry: price, qty: notional / price, equityAtEntry: eq, openedAt: c.t, P0, lev: true };
          } else {
            const eq = usdc * (1 - o.swapCost);                          // all into the token, 1x
            pos = { entry: price, qty: eq / price, equityAtEntry: 0, openedAt: c.t, P0, lev: false };
          }
          pos.funding = 0;
          state = "LONG";
          armed = false;
        }
      }
    } else {
      hoursLong++;
      if (pos.lev) pos.funding += pos.qty * c.c * o.fundingApr / YEAR_H;
      const eqAt = P => pos.lev ? pos.equityAtEntry + pos.qty * (P - pos.entry) - pos.funding : pos.qty * P;
      const target = o.exitFromEntry > 0 ? pos.entry * (1 + o.exitFromEntry) : pos.P0 * (1 + o.exitAbove);
      const stopPx = o.stopLoss > 0 ? pos.entry * (1 - o.stopLoss) : 0;
      const tooLong = o.maxDays > 0 && c.t - pos.openedAt >= o.maxDays * 86400_000;
      const closeAt = (price, result) => {
        const out = pos.lev
          ? eqAt(price) - pos.qty * price * o.perpFee
          : pos.qty * price * (1 - o.swapCost);
        cycles.push({ openedAt: pos.openedAt, closedAt: c.t, entry: pos.entry, exit: price, result, equityIn: pos.lev ? pos.equityAtEntry : pos.qty * pos.entry, equityOut: out });
        capital = Math.max(out, 0);
        mint(capital, price); state = "LP"; pos = null;
      };

      // liquidation: margin + whole reserve exhausted (leveraged mode only)
      if (pos.lev && eqAt(c.l) <= o.maintenance * pos.qty * c.l) {
        liquidations++;
        const left = Math.max(eqAt(c.l), 0) * 0.5;                       // little or nothing survives a liquidation
        cycles.push({ openedAt: pos.openedAt, closedAt: c.t, entry: pos.entry, exit: c.l, result: "liquidated", equityIn: pos.equityAtEntry, equityOut: left });
        capital = left;
        if (capital < 1) { pos = null; equity.push({ t: c.t, v: 0 }); return finish(); }
        mint(capital, c.c); state = "LP"; pos = null;
      } else if (stopPx && c.l <= stopPx) {
        closeAt(Math.min(c.o, stopPx), "stopped");
      } else if (c.h >= target) {
        closeAt(target, "target");
      } else if (tooLong) {
        closeAt(c.c, "timed out");
      }
    }

    const v = capital < 1 && state === "LP" && !L ? 0 : state === "LP" ? lpNow(c.c)
      : pos.lev ? pos.equityAtEntry + pos.qty * (c.c - pos.entry) - pos.funding
      : pos.qty * c.c;
    equity.push({ t: c.t, v });
  }
  return finish();

  function finish() {
    const open = pos ? { openedAt: pos.openedAt, entry: pos.entry, target: pos.P0 * (1 + o.exitAbove) } : null;
    return { equity, cycles, final: equity.at(-1)?.v ?? capital, liquidations, recentres, open, hours: { lp: hoursLp, long: hoursLong } };
  }
}

// ── Summary numbers ──────────────────────────────────────────────────────────

export function stats(equity) {
  if (!equity.length) return { final: 0, cagr: -1, maxDrawdown: 1 };
  let peak = equity[0].v, maxDd = 0;
  for (const p of equity) { peak = Math.max(peak, p.v); maxDd = Math.max(maxDd, peak ? 1 - p.v / peak : 1); }
  const years = (equity.at(-1).t - equity[0].t) / (365 * 24 * 3600_000);
  const final = equity.at(-1).v;
  return { final, cagr: years > 0 && final > 0 ? Math.pow(final / 10_000, 1 / years) - 1 : -1, maxDrawdown: maxDd, years };
}

/** Buy-and-hold benchmarks from the same start. */
export function holdBenchmarks(hourly, startIndex = 0) {
  const p0 = hourly[startIndex].o;
  const token = [], half = [];
  for (let i = startIndex; i < hourly.length; i++) {
    const r = hourly[i].c / p0;
    token.push({ t: hourly[i].t, v: 10_000 * r });
    half.push({ t: hourly[i].t, v: 5_000 + 5_000 * r });
  }
  return { token: stats(token), half: stats(half) };
}
