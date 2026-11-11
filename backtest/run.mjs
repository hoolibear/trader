#!/usr/bin/env node
/**
 * backtest/run.mjs — run the LP-rotation backtest and print the results.
 *
 *   node backtest/run.mjs            ETH
 *   node backtest/run.mjs BTC SOL    other tokens
 *
 * Three views per token:
 *   1. Whole history from the first candle.
 *   2. Every cycle the leveraged rule would have taken.
 *   3. Rolling 2-year windows starting every 30 days — because one start date
 *      proves little. Shows how often the rule beat simply staying in the LP.
 */

import { loadHourly, to4h } from "./candles.mjs";
import { simulate, stats, holdBenchmarks, DEFAULTS } from "./lp-rotation.mjs";

const assets = process.argv.slice(2).filter(a => !a.startsWith("-"));
if (!assets.length) assets.push("ETH");

const usd  = n => "$" + Math.round(n).toLocaleString("en-US");
const pct  = n => (n * 100).toFixed(0) + "%";
const date = t => new Date(t).toISOString().slice(0, 10);
const pad  = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

function row(label, r) {
  const s = stats(r.equity);
  return `${pad(label, 34)}${padl(usd(s.final), 11)}${padl(pct(s.cagr), 8)}${padl(pct(s.maxDrawdown), 9)}${padl(r.cycles.length, 8)}${padl(r.liquidations, 7)}${padl(pct(r.hours.long / (r.hours.long + r.hours.lp || 1)), 9)}`;
}

for (const asset of assets) {
  const hourly = await loadHourly(asset);
  const c4 = to4h(hourly);
  console.log(`\n══════════ ${asset}/USDC  ${date(hourly[0].t)} → ${date(hourly.at(-1).t)}  (${hourly.length.toLocaleString()} hourly candles) ══════════`);
  console.log(`Start $10,000. Rule: −${pct(DEFAULTS.triggerDrop)} from LP start price + turn signal → ${DEFAULTS.leverage}x long on half, half reserve → exit at +${pct(DEFAULTS.exitAbove)} over LP start price.`);
  console.log(`Assumed: full-range fee yield ${pct(DEFAULTS.baseFeeApr)}/yr (×4.2 in a ±50% range, ×8.3 in ±25%, only while in range), funding ${pct(DEFAULTS.fundingApr)}/yr, swap cost ${(DEFAULTS.swapCost * 100).toFixed(2)}%.`);

  // 1. whole history
  const hold = holdBenchmarks(hourly);
  console.log(`\n1. WHOLE HISTORY`);
  console.log(`${pad("", 34)}${padl("final", 11)}${padl("per yr", 8)}${padl("worst dd", 9)}${padl("cycles", 8)}${padl("liq'd", 7)}${padl("in long", 9)}`);
  console.log(`${pad("Hold token", 34)}${padl(usd(hold.token.final), 11)}${padl(pct(hold.token.cagr), 8)}${padl(pct(hold.token.maxDrawdown), 9)}`);
  console.log(`${pad("Hold 50/50 token + USDC", 34)}${padl(usd(hold.half.final), 11)}${padl(pct(hold.half.cagr), 8)}${padl(pct(hold.half.maxDrawdown), 9)}`);
  let detail = null;
  for (const rangePct of [0.5, 0.25]) {
    console.log(`  range ±${pct(rangePct)}`);
    console.log(row(`    LP only`, simulate(hourly, c4, { mode: "lp-only", rangePct })));
    for (const turn of ["none", "rsi", "ema", "higherlow"]) {
      const lev = simulate(hourly, c4, { mode: "leveraged", rangePct, turn });
      console.log(row(`    3x long, turn=${turn}`, lev));
      if (rangePct === 0.5 && turn === "rsi") detail = lev;
    }
    console.log(row(`    Spot 1x (no leverage), turn=rsi`, simulate(hourly, c4, { mode: "spot", rangePct, turn: "rsi" })));
  }

  // fee assumption sensitivity
  console.log(`  fee-yield sensitivity (range ±50%, turn=rsi): final value`);
  for (const baseFeeApr of [0, 0.02, 0.04, 0.08]) {
    const lp  = stats(simulate(hourly, c4, { mode: "lp-only", baseFeeApr }).equity).final;
    const lev = stats(simulate(hourly, c4, { mode: "leveraged", baseFeeApr }).equity).final;
    console.log(`    full-range yield ${padl(pct(baseFeeApr), 3)}/yr:  LP only ${padl(usd(lp), 10)}   3x rule ${padl(usd(lev), 10)}`);
  }

  // 2. cycles
  console.log(`\n2. EVERY CYCLE (range ±50%, turn=rsi)`);
  console.log(`   entered     price    lowest after   days held   result      in → out`);
  for (const c of detail.cycles) {
    const span = hourly.filter(h => h.t >= c.openedAt && h.t <= c.closedAt);
    const low = Math.min(...span.map(h => h.l));
    console.log(`   ${date(c.openedAt)}  ${padl(usd(c.entry), 7)}  ${padl(usd(low), 7)} (${padl(pct(low / c.entry - 1), 4)})  ${padl(Math.round((c.closedAt - c.openedAt) / 86400000), 6)}      ${pad(c.result, 10)}  ${usd(c.equityIn)} → ${usd(c.equityOut)}`);
  }
  if (detail.open) console.log(`   ${date(detail.open.openedAt)}  ${padl(usd(detail.open.entry), 7)}  still open — target ${usd(detail.open.target)}, last price ${usd(hourly.at(-1).c)}`);
  if (!detail.cycles.length && !detail.open) console.log("   none");

  // 3. rolling windows, several rule variants
  const WINDOW_H = 24 * 365 * 2, STEP_H = 24 * 30;
  const VARIANTS = [
    ["LP only (benchmark)",                       { mode: "lp-only" }],
    ["3x rule as specified",                      { mode: "leveraged" }],
    ["  + stop 20% below entry",                  { mode: "leveraged", stopLoss: 0.20 }],
    ["  + stop 30% below entry",                  { mode: "leveraged", stopLoss: 0.30 }],
    ["  + uptrend only (200d avg rising)",        { mode: "leveraged", regime: "ma200up" }],
    ["  + uptrend only + stop 30%",               { mode: "leveraged", regime: "ma200up", stopLoss: 0.30 }],
    ["  + exit +40% from entry + stop 30%",       { mode: "leveraged", exitFromEntry: 0.40, stopLoss: 0.30 }],
    ["  + uptrend + exit +40% + stop 30%",        { mode: "leveraged", regime: "ma200up", exitFromEntry: 0.40, stopLoss: 0.30 }],
    ["Spot 1x rule as specified",                 { mode: "spot" }],
    ["  + exit +40% from entry + stop 30%",       { mode: "spot", exitFromEntry: 0.40, stopLoss: 0.30 }],
  ];
  const starts = [];
  for (let s = 0; s + WINDOW_H < hourly.length; s += STEP_H) starts.push(s);
  const med = a => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const lpFinals = starts.map(s => simulate(hourly.slice(0, s + WINDOW_H), c4, { mode: "lp-only" }, s).final);
  console.log(`\n3. ROLLING 2-YEAR WINDOWS (${starts.length} start dates, 30 days apart; range ±50%, turn=rsi)`);
  console.log(`   ${pad("", 40)}${padl("median", 9)}${padl("worst", 9)}${padl("best", 10)}${padl("beat LP", 9)}${padl("lost", 6)}${padl("wiped", 7)}${padl("whole hist.", 13)}`);
  let runs = null;
  for (const [name, opts] of VARIANTS) {
    const rs = starts.map(s => simulate(hourly.slice(0, s + WINDOW_H), c4, opts, s));
    const v = rs.map(r => r.final);
    const beat = v.filter((x, k) => x > lpFinals[k] * 1.01).length / v.length;
    const lost = v.filter((x, k) => x < lpFinals[k] * 0.99).length / v.length;
    const wiped = rs.filter(r => r.liquidations > 0).length / v.length;
    const whole = simulate(hourly, c4, opts).final;
    console.log(`   ${pad(name, 40)}${padl(usd(med(v)), 9)}${padl(usd(Math.min(...v)), 9)}${padl(usd(Math.max(...v)), 10)}${padl(opts.mode === "lp-only" ? "-" : pct(beat), 9)}${padl(opts.mode === "lp-only" ? "-" : pct(lost), 6)}${padl(pct(wiped), 7)}${padl(usd(whole), 13)}`);
    if (name === "3x rule as specified") runs = rs.map((r, k) => ({ start: hourly[starts[k]].t, lp: lpFinals[k], lev: r.final }));
  }
  const worst = runs.reduce((a, b) => (b.lev / b.lp < a.lev / a.lp ? b : a));
  const best  = runs.reduce((a, b) => (b.lev / b.lp > a.lev / a.lp ? b : a));
  console.log(`   Worst start vs LP: ${date(worst.start)} — 3x rule ${usd(worst.lev)} vs LP ${usd(worst.lp)}.  Best: ${date(best.start)} — ${usd(best.lev)} vs ${usd(best.lp)}`);
}
