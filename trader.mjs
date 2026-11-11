#!/usr/bin/env node
/**
 * trader.mjs — AgentSignal autonomous trader
 *
 * Fetches live signals from agentsignal.app and executes trades
 * on Hyperliquid for all active strategies.
 *
 * Runs on a schedule via PM2 (see ecosystem.config.cjs).
 * Run manually: node trader.mjs [--dry-run]
 *
 * The actual per-strategy signal-fetch + execute logic lives in
 * execution.mjs (runStrategyOnce) — shared with the dashboard's /api/run
 * route and the desktop app's scheduler, so every path trades identically
 * (guards, cooldown, native SL, TP/trail, retry).
 */

import { argv } from "process";
import { loadEnv } from "./paths.mjs";

loadEnv();

const PRIVATE_KEY       = process.env.AGENT_PRIVATE_KEY?.trim();
const VAULT_ACTIVE      = process.env.VAULT_ACTIVE === "true";
const KRAKEN_API_KEY    = process.env.KRAKEN_API_KEY?.trim();
const ALPACA_API_KEY    = process.env.ALPACA_API_KEY?.trim();

const cryptoOnly       = argv.includes("--crypto-only");
const stocksOnly       = argv.includes("--stocks-only");
const strategyIdx      = argv.indexOf("--strategy");
const strategyFilter   = strategyIdx !== -1 ? (argv[strategyIdx + 1] || null) : null;
const today            = new Date().toISOString().slice(0, 10);

if (!PRIVATE_KEY && !KRAKEN_API_KEY && !ALPACA_API_KEY && !VAULT_ACTIVE) {
  console.error("[trader] No exchange credentials found. Run: npm run setup");
  process.exit(1);
}

// ── Imports ───────────────────────────────────────────────────────────────────

import { getActiveStrategies, isStrategyDue, touchStrategyRun } from "./db.mjs";
import { runStrategyOnce, syncPositions, isDryRun } from "./execution.mjs";
import { isCrypto } from "./markets.mjs";
import { acquireRunLock, releaseRunLock, lockHolder } from "./runlock.mjs";

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\n[trader] ═══════════════════════════════════════`);
console.log(`[trader] AgentSignal Trader — ${today}${isDryRun() ? " [DRY RUN]" : ""}`);
console.log(`[trader] ═══════════════════════════════════════`);

const allStrategies = getActiveStrategies();
const strategies = allStrategies.filter(s => {
  if (strategyFilter) return s.id === strategyFilter;
  if (cryptoOnly) return isCrypto(s.symbol);
  if (stocksOnly) return !isCrypto(s.symbol);
  return true;
});

if (!strategies.length) {
  const scope = strategyFilter ? `strategy ${strategyFilter}` : cryptoOnly ? "crypto" : stocksOnly ? "stock" : "active";
  console.log(`[trader] No ${scope} strategies. Activate one from the dashboard: npm run dashboard`);
  process.exit(0);
}

// One runner at a time: if the desktop app (or another run) is mid-cycle, skip.
if (!acquireRunLock("cli")) {
  console.log(`[trader] Another runner holds the run lock (${lockHolder()?.owner ?? "unknown"}) — skipping this run`);
  process.exit(0);
}
process.on("exit", releaseRunLock);

console.log(`[trader] Active strategies: ${strategies.map(s => s.name).join(", ")}`);

for (const strategy of strategies) {
  console.log(`\n[trader] ── ${strategy.name} (${strategy.symbol}) ──`);

  // Check interval — skip if not due yet
  if (!isStrategyDue(strategy.id)) {
    console.log(`[trader] ⏱ Not due yet (every ${strategy.interval_minutes}min) — skipping`);
    continue;
  }

  const result = await runStrategyOnce(strategy);
  if (result.fetchFailed) {
    console.warn(`[trader] Skipping ${strategy.name} — could not fetch signal`);
    continue;
  }
  if (!isDryRun()) touchStrategyRun(strategy.id);
  if (!result.ok) {
    console.warn(`[trader] Skipping ${strategy.name} — ${result.error}`);
  }
}

console.log(`\n[trader] Done.`);

// Sync position snapshot to AgentSignal account
await syncPositions(strategies);
