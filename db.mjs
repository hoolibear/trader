/**
 * db.mjs — local SQLite database
 * Stores strategies, signal history, and trade log.
 * No cloud database required.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { resolve } from "path";
import { DATA_DIR } from "./paths.mjs";

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(resolve(DATA_DIR, "trader.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS strategies (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    symbol            TEXT NOT NULL DEFAULT 'BTC-USD',
    leverage          INTEGER NOT NULL DEFAULT 1,
    position_size_usd REAL,
    exchange          TEXT NOT NULL DEFAULT 'hyperliquid',
    interval_minutes  INTEGER NOT NULL DEFAULT 60,
    last_run_at       TEXT,
    active            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS signals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    date        TEXT NOT NULL,
    signal      TEXT NOT NULL,
    price       REAL,
    notes       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(strategy_id, date)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    date        TEXT NOT NULL DEFAULT (date('now')),
    action      TEXT NOT NULL,
    asset       TEXT NOT NULL,
    size        REAL,
    price       REAL,
    leverage    INTEGER,
    pnl         REAL,
    result_json TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Migrations ────────────────────────────────────────────────────────────────
for (const col of [
  "ALTER TABLE strategies ADD COLUMN tp_pct REAL",
  "ALTER TABLE strategies ADD COLUMN trail_pct REAL",
  "ALTER TABLE strategies ADD COLUMN sl_pct REAL",
  "ALTER TABLE strategies ADD COLUMN max_size_usd REAL",
  "ALTER TABLE strategies ADD COLUMN cooldown_minutes INTEGER",
  "ALTER TABLE strategies ADD COLUMN subscription_period TEXT",
  "ALTER TABLE strategies ADD COLUMN subscription_expires_at TEXT",
  "ALTER TABLE strategies ADD COLUMN option_mode TEXT",
  "ALTER TABLE strategies ADD COLUMN dte_target INTEGER",
  "ALTER TABLE strategies ADD COLUMN delta_target REAL",
  "ALTER TABLE strategies ADD COLUMN contracts INTEGER",
]) {
  try { db.exec(col); } catch {}
}

// ── Strategies ────────────────────────────────────────────────────────────────

export function getStrategies() {
  return db.prepare("SELECT * FROM strategies ORDER BY created_at DESC").all();
}

export function getActiveStrategies() {
  return db.prepare("SELECT * FROM strategies WHERE active = 1").all();
}

export function getStrategy(id) {
  return db.prepare("SELECT * FROM strategies WHERE id = ?").get(id);
}

export function upsertStrategy({ id, name, symbol, leverage, position_size_usd, exchange, interval_minutes, tp_pct, trail_pct, sl_pct, max_size_usd, cooldown_minutes, subscription_period }) {
  db.prepare(`
    INSERT INTO strategies (id, name, symbol, leverage, position_size_usd, exchange, interval_minutes, tp_pct, trail_pct, sl_pct, max_size_usd, cooldown_minutes, subscription_period)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      symbol = excluded.symbol,
      leverage = excluded.leverage,
      position_size_usd = excluded.position_size_usd,
      exchange = excluded.exchange,
      interval_minutes = excluded.interval_minutes,
      tp_pct = excluded.tp_pct,
      trail_pct = excluded.trail_pct,
      sl_pct = excluded.sl_pct,
      max_size_usd = excluded.max_size_usd,
      cooldown_minutes = excluded.cooldown_minutes,
      subscription_period = COALESCE(excluded.subscription_period, strategies.subscription_period)
  `).run(id, name, symbol, leverage ?? 1, position_size_usd ?? null, exchange ?? "hyperliquid", interval_minutes ?? 60, tp_pct ?? null, trail_pct ?? null, sl_pct ?? null, max_size_usd ?? null, cooldown_minutes ?? null, subscription_period ?? null);
}

export function setSubscriptionPeriod(id, period) {
  db.prepare("UPDATE strategies SET subscription_period = ? WHERE id = ?").run(period ?? null, id);
}

export function setSubscriptionExpiry(id, expires_at) {
  db.prepare("UPDATE strategies SET subscription_expires_at = ? WHERE id = ?").run(expires_at ?? null, id);
}

export function touchStrategyRun(id) {
  db.prepare("UPDATE strategies SET last_run_at = datetime('now') WHERE id = ?").run(id);
}

export function isStrategyDue(id) {
  const s = db.prepare("SELECT interval_minutes, last_run_at FROM strategies WHERE id = ?").get(id);
  if (!s) return false;
  if (!s.last_run_at) return true;
  const elapsed = (Date.now() - new Date(s.last_run_at + "Z").getTime()) / 60000;
  return elapsed >= s.interval_minutes;
}

// Migrate existing DB
try { db.exec("ALTER TABLE strategies ADD COLUMN exchange TEXT NOT NULL DEFAULT 'hyperliquid'"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN interval_minutes INTEGER NOT NULL DEFAULT 60"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN last_run_at TEXT"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN tp_pct REAL"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN trail_pct REAL"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN max_size_usd REAL"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN cooldown_minutes INTEGER"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN risk_mode TEXT"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN stop_order_id TEXT"); } catch {}
try { db.exec("ALTER TABLE strategies ADD COLUMN sl_pct_adaptive REAL"); } catch {}

export function setStrategyRiskMode(id, mode) {
  db.prepare("UPDATE strategies SET risk_mode = ? WHERE id = ?").run(mode ?? null, id);
}

export function setStrategySlPct(id, sl_pct) {
  db.prepare("UPDATE strategies SET sl_pct = ? WHERE id = ?").run(sl_pct ?? null, id);
}

// Stop-loss % computed by the entry gate for the position currently open.
// Kept apart from sl_pct so the user's own setting is never overwritten.
// Cleared (null) when the position closes.
export function setStrategyAdaptiveSl(id, sl_pct) {
  db.prepare("UPDATE strategies SET sl_pct_adaptive = ? WHERE id = ?").run(sl_pct ?? null, id);
}

export function setStrategyStopOrderId(id, oid) {
  db.prepare("UPDATE strategies SET stop_order_id = ? WHERE id = ?").run(oid != null ? String(oid) : null, id);
}

export function getStrategyStopOrderId(id) {
  return db.prepare("SELECT stop_order_id FROM strategies WHERE id = ?").get(id)?.stop_order_id ?? null;
}

// ── TP / Trail state (one row per open position) ──────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS tp_state (
    strategy_id   TEXT PRIMARY KEY,
    entry_price   REAL NOT NULL,
    tp_price      REAL NOT NULL,
    trail_pct     REAL NOT NULL,
    trail_mode    INTEGER NOT NULL DEFAULT 0,
    high_water    REAL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export function setTpState({ strategy_id, entry_price, tp_price, trail_pct }) {
  db.prepare(`
    INSERT INTO tp_state (strategy_id, entry_price, tp_price, trail_pct, trail_mode, high_water)
    VALUES (?, ?, ?, ?, 0, NULL)
    ON CONFLICT(strategy_id) DO UPDATE SET
      entry_price = excluded.entry_price,
      tp_price    = excluded.tp_price,
      trail_pct   = excluded.trail_pct,
      trail_mode  = 0,
      high_water  = NULL,
      updated_at  = datetime('now')
  `).run(strategy_id, entry_price, tp_price, trail_pct);
}

export function getTpState(strategy_id) {
  return db.prepare("SELECT * FROM tp_state WHERE strategy_id = ?").get(strategy_id);
}

export function updateTpTrailMode(strategy_id, high_water) {
  db.prepare(`
    UPDATE tp_state SET trail_mode = 1, high_water = ?, updated_at = datetime('now')
    WHERE strategy_id = ?
  `).run(high_water, strategy_id);
}

export function updateTpHighWater(strategy_id, high_water) {
  db.prepare(`
    UPDATE tp_state SET high_water = ?, updated_at = datetime('now')
    WHERE strategy_id = ?
  `).run(high_water, strategy_id);
}

export function clearTpState(strategy_id) {
  db.prepare("DELETE FROM tp_state WHERE strategy_id = ?").run(strategy_id);
}

export function setStrategyActive(id, active) {
  db.prepare("UPDATE strategies SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteStrategy(id) {
  db.prepare("DELETE FROM strategies WHERE id = ?").run(id);
}

// ── Signal events (feed — every fetch) ───────────────────────────────────────

try {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS signal_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      signal      TEXT NOT NULL,
      prev_signal TEXT,
      price       REAL,
      notes       TEXT,
      type        TEXT DEFAULT 'flip',
      created_at  TEXT DEFAULT (datetime('now'))
    )
  `).run();
} catch {}

// Add type column to existing DBs
try { db.prepare("ALTER TABLE signal_events ADD COLUMN type TEXT DEFAULT 'flip'").run(); } catch {}

export function insertSignalEvent({ strategy_id, signal, prev_signal, price, notes, type = "flip" }) {
  db.prepare(`
    INSERT INTO signal_events (strategy_id, signal, prev_signal, price, notes, type)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(strategy_id, signal, prev_signal ?? null, price ?? null, notes ?? null, type);
}

export function getRecentSignalEvents(hours = 48) {
  return db.prepare(`
    SELECT e.*, s.name as strategy_name, s.symbol, s.leverage
    FROM signal_events e
    JOIN strategies s ON s.id = e.strategy_id
    WHERE e.created_at >= datetime('now', '-${hours} hours')
    ORDER BY e.created_at DESC
  `).all();
}

// ── Signals (current state — one row per strategy per day) ────────────────────

export function upsertSignal({ strategy_id, date, signal, price, notes }) {
  // Add updated_at column if it doesn't exist yet
  try { db.prepare("ALTER TABLE signals ADD COLUMN updated_at TEXT").run(); } catch {}
  db.prepare(`
    INSERT INTO signals (strategy_id, date, signal, price, notes, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(strategy_id, date) DO UPDATE SET
      signal = excluded.signal,
      price = excluded.price,
      notes = excluded.notes,
      updated_at = datetime('now')
  `).run(strategy_id, date, signal, price ?? null, notes ?? null);
}

export function getLatestSignal(strategy_id) {
  return db.prepare(`
    SELECT * FROM signals WHERE strategy_id = ?
    ORDER BY date DESC LIMIT 1
  `).get(strategy_id);
}

export function getPriorSignal(strategy_id) {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT * FROM signals WHERE strategy_id = ? AND date < ?
    ORDER BY date DESC LIMIT 1
  `).get(strategy_id, today);
}

export function countSignals() {
  return db.prepare("SELECT COUNT(*) as total FROM signals").get().total;
}

// ── Signal fetch log (one row per actual x402 call) ───────────────────────────

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS signal_fetches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_id TEXT NOT NULL,
      network     TEXT,
      cost_usd    REAL NOT NULL DEFAULT 0.01,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} catch {}

export function logFetch({ strategy_id, network, cost_usd = 0.01 }) {
  db.prepare(`
    INSERT INTO signal_fetches (strategy_id, network, cost_usd)
    VALUES (?, ?, ?)
  `).run(strategy_id, network ?? null, cost_usd);
}

export function getYtdPnl() {
  const year = new Date().getFullYear().toString();
  const row = db.prepare(
    "SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL AND date LIKE ?"
  ).get(`${year}-%`);
  return row?.total ?? 0;
}

export function countFetchesToday() {
  return db.prepare(`
    SELECT COUNT(*) as total, COALESCE(SUM(cost_usd), 0) as spend
    FROM signal_fetches
    WHERE date(created_at) = date('now')
  `).get();
}

export function countFetchesTotal() {
  return db.prepare(`
    SELECT COUNT(*) as total, COALESCE(SUM(cost_usd), 0) as spend
    FROM signal_fetches
  `).get();
}

export function getSignalHistory(strategy_id, limit = 30) {
  return db.prepare(`
    SELECT * FROM signals WHERE strategy_id = ?
    ORDER BY date DESC LIMIT ?
  `).all(strategy_id, limit);
}

export function getRecentSignals(hours = 48) {
  return db.prepare(`
    SELECT sig.*, s.name as strategy_name, s.symbol, s.leverage
    FROM signals sig
    JOIN strategies s ON s.id = sig.strategy_id
    WHERE sig.created_at >= datetime('now', '-${hours} hours')
    ORDER BY sig.created_at DESC
  `).all();
}

// ── Trades ────────────────────────────────────────────────────────────────────

export function insertTrade({ strategy_id, action, asset, size, price, leverage, pnl, result }) {
  db.prepare(`
    INSERT INTO trades (strategy_id, action, asset, size, price, leverage, pnl, result_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(strategy_id, action, asset, size ?? null, price ?? null, leverage ?? null, pnl ?? null, result ? JSON.stringify(result) : null);
}

// Migrate existing DB: add pnl column if it doesn't exist yet
try { db.exec("ALTER TABLE trades ADD COLUMN pnl REAL"); } catch {}
// Migrate: add fill_hash for dedup of exchange-sourced events (liquidations)
try { db.exec("ALTER TABLE trades ADD COLUMN fill_hash TEXT"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS trades_fill_hash ON trades(fill_hash) WHERE fill_hash IS NOT NULL"); } catch {}

/**
 * Insert a liquidation fill sourced from the exchange (not triggered by the trader).
 * No-ops if this fill_hash already exists.
 * @param {{ coin: string, px: string, sz: string, closedPnl: string, time: number, hash: string }} fill
 * @param {number|null} strategyId
 */
export function insertLiquidationTrade(fill, strategyId) {
  const existing = db.prepare("SELECT id FROM trades WHERE fill_hash = ?").get(fill.hash);
  if (existing) return;
  const ts = new Date(fill.time).toISOString().replace("T", " ").slice(0, 19);
  db.prepare(`
    INSERT INTO trades (strategy_id, action, asset, size, price, pnl, fill_hash, created_at)
    VALUES (?, 'LIQUIDATED', ?, ?, ?, ?, ?, ?)
  `).run(
    strategyId ?? null,
    fill.coin,
    parseFloat(fill.sz),
    parseFloat(fill.px),
    parseFloat(fill.closedPnl),
    fill.hash,
    ts,
  );
}


export function getTradeHistory(strategy_id, limit = 30) {
  return db.prepare(`
    SELECT * FROM trades WHERE strategy_id = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(strategy_id, limit);
}

// Returns price from the most recent ENTERED trade for an asset (for spot PnL)
export function getLastEntry(asset) {
  return db.prepare(`
    SELECT price, leverage FROM trades
    WHERE asset = ? AND action LIKE 'ENTERED%'
    ORDER BY created_at DESC LIMIT 1
  `).get(asset) ?? null;
}

export function getLastEntryPrice(asset) {
  return getLastEntry(asset)?.price ?? null;
}

export function getLastStrategyEntry(strategy_id) {
  return db.prepare(`
    SELECT price, leverage, size FROM trades
    WHERE strategy_id = ? AND action LIKE 'ENTERED%'
    ORDER BY created_at DESC LIMIT 1
  `).get(strategy_id) ?? null;
}

export function getAllRecentTrades(limit = 50) {
  return db.prepare(`
    SELECT t.*, s.name as strategy_name FROM trades t
    LEFT JOIN strategies s ON s.id = t.strategy_id
    ORDER BY t.created_at DESC LIMIT ?
  `).all(limit);
}

export function getLastTradeTime(strategy_id) {
  const row = db.prepare(
    "SELECT MAX(created_at) as last_at FROM trades WHERE strategy_id = ?"
  ).get(strategy_id);
  return row?.last_at ?? null;
}

// ── Wallets ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    key               TEXT NOT NULL,
    use_for_trading   INTEGER NOT NULL DEFAULT 1,
    show_on_portfolio INTEGER NOT NULL DEFAULT 1,
    show_on_uniswap   INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS vault_watchlist (
    id               TEXT PRIMARY KEY,
    chain            TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    symbol           TEXT,
    decimals         INTEGER NOT NULL DEFAULT 18,
    label            TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function getVaultWatchlist() {
  return db.prepare("SELECT * FROM vault_watchlist ORDER BY chain, created_at ASC").all();
}

export function addVaultToken({ id, chain, contractAddress, symbol, decimals, label }) {
  db.prepare(`
    INSERT OR REPLACE INTO vault_watchlist (id, chain, contract_address, symbol, decimals, label)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, chain, contractAddress.toLowerCase(), symbol ?? null, decimals ?? 18, label ?? null);
}

export function removeVaultToken(id) {
  db.prepare("DELETE FROM vault_watchlist WHERE id = ?").run(id);
}

export function maybeCreateDefaultWallet(key) {
  const count = db.prepare("SELECT COUNT(*) as c FROM wallets").get().c;
  if (count === 0 && key) {
    db.prepare(`
      INSERT INTO wallets (id, name, key, use_for_trading, show_on_portfolio, show_on_uniswap)
      VALUES ('wallet-default', 'Default', ?, 1, 1, 1)
    `).run(key);
  }
}

export function listWallets() {
  return db.prepare("SELECT * FROM wallets ORDER BY created_at ASC").all();
}

export function insertWallet({ id, name, key }) {
  db.prepare(`
    INSERT INTO wallets (id, name, key, use_for_trading, show_on_portfolio, show_on_uniswap)
    VALUES (?, ?, ?, 0, 1, 1)
  `).run(id, name, key);
}

export function deleteWallet(id) {
  db.prepare("DELETE FROM wallets WHERE id = ?").run(id);
}

export function updateWalletFlags(id, flags) {
  const fields = [];
  const values = [];
  if (flags.show_on_portfolio !== undefined) { fields.push("show_on_portfolio = ?"); values.push(flags.show_on_portfolio ? 1 : 0); }
  if (flags.show_on_uniswap   !== undefined) { fields.push("show_on_uniswap = ?");   values.push(flags.show_on_uniswap   ? 1 : 0); }
  if (flags.name              !== undefined) { fields.push("name = ?");               values.push(flags.name); }
  if (!fields.length) return;
  values.push(id);
  db.prepare(`UPDATE wallets SET ${fields.join(", ")} WHERE id = ?`).run(...values);
}

export function setTradingWallet(id) {
  db.prepare("UPDATE wallets SET use_for_trading = 0").run();
  db.prepare("UPDATE wallets SET use_for_trading = 1 WHERE id = ?").run(id);
}

// The single wallet currently flagged for trading, or null. Source of truth for
// which key signs trades / funds Hyperliquid. When the Vultisig vault is the
// active signer (VAULT_ACTIVE=true) all rows are cleared, so this returns null.
export function getTradingWallet() {
  return db.prepare("SELECT * FROM wallets WHERE use_for_trading = 1 LIMIT 1").get() ?? null;
}

// Clear the trading flag on every wallet — used when the Vultisig vault becomes
// the active signer, so no raw-key wallet also claims to be trading.
export function clearTradingWallet() {
  db.prepare("UPDATE wallets SET use_for_trading = 0").run();
}

// ── Staking contracts ─────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS staking_contracts (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    chain        TEXT NOT NULL DEFAULT 'arbitrum',
    address      TEXT NOT NULL,
    token_symbol TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function listStakingContracts() {
  return db.prepare("SELECT * FROM staking_contracts ORDER BY created_at ASC").all();
}

try { db.exec("ALTER TABLE staking_contracts ADD COLUMN token_address TEXT"); } catch {}

export function insertStakingContract({ id, name, chain, address, token_symbol, token_address }) {
  db.prepare(`
    INSERT INTO staking_contracts (id, name, chain, address, token_symbol, token_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, chain, address, token_symbol ?? null, token_address ?? null);
}

export function deleteStakingContract(id) {
  db.prepare("DELETE FROM staking_contracts WHERE id = ?").run(id);
}

// ── Account snapshots (equity curve) ─────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       TEXT NOT NULL DEFAULT (datetime('now')),
    net_liq         REAL NOT NULL,
    unrealized_pnl  REAL NOT NULL DEFAULT 0,
    realized_pnl    REAL NOT NULL DEFAULT 0,
    total_value     REAL NOT NULL
  )
`);

export function insertSnapshot({ net_liq, unrealized_pnl = 0, realized_pnl = 0, total_value }) {
  const last = db.prepare("SELECT MAX(timestamp) as t FROM snapshots").get()?.t;
  if (last) {
    const minutesSince = (Date.now() - new Date(last + "Z").getTime()) / 60000;
    if (minutesSince < 60) return;
  }
  db.prepare(`
    INSERT INTO snapshots (net_liq, unrealized_pnl, realized_pnl, total_value)
    VALUES (?, ?, ?, ?)
  `).run(net_liq, unrealized_pnl, realized_pnl, total_value ?? net_liq);
}

export function getSnapshots(days = 90) {
  return db.prepare(`
    SELECT date(timestamp) as date,
           AVG(net_liq)        as net_liq,
           AVG(unrealized_pnl) as unrealized_pnl,
           AVG(realized_pnl)   as realized_pnl,
           AVG(total_value)    as total_value
    FROM snapshots
    WHERE timestamp >= datetime('now', '-${days} days')
    GROUP BY date(timestamp)
    ORDER BY date ASC
  `).all();
}

export function hasSnapshots() {
  return (db.prepare("SELECT COUNT(*) as c FROM snapshots").get()?.c ?? 0) > 0;
}

export function backfillSnapshotsFromTrades(currentAccountValue) {
  const totalPnl = db.prepare(
    "SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL"
  ).get()?.total ?? 0;
  const startingValue = currentAccountValue - totalPnl;

  const days = db.prepare(`
    SELECT date, SUM(pnl) as daily_pnl
    FROM trades
    WHERE pnl IS NOT NULL
    GROUP BY date
    ORDER BY date ASC
  `).all();

  let running = startingValue;
  for (const day of days) {
    running += day.daily_pnl;
    db.prepare(`
      INSERT INTO snapshots (timestamp, net_liq, unrealized_pnl, realized_pnl, total_value)
      VALUES (datetime(?, '12:00:00'), ?, 0, ?, ?)
    `).run(day.date, running, running - startingValue, running);
  }
}

// ── Alerts ────────────────────────────────────────────────────────────────────
// Things a human must look at: a position with no stop, a failed payment, a
// runner that stopped. At most one open alert per (strategy_id, code).

db.exec(`
  CREATE TABLE IF NOT EXISTS alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL DEFAULT '',
    code        TEXT NOT NULL,
    level       TEXT NOT NULL DEFAULT 'warning',
    message     TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  )
`);

// Claude's explanation of an alert (see analyst.mjs)
try { db.exec("ALTER TABLE alerts ADD COLUMN analysis TEXT"); } catch {}
try { db.exec("ALTER TABLE alerts ADD COLUMN analysis_at TEXT"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS analyst_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_id   INTEGER,
    model      TEXT,
    ok         INTEGER NOT NULL DEFAULT 1,
    ms         INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export function getAlert(id) {
  return db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) ?? null;
}

export function setAlertAnalysis(id, analysis) {
  db.prepare("UPDATE alerts SET analysis = ?, analysis_at = datetime('now') WHERE id = ?").run(analysis, id);
}

/** Latest explanation written for the same strategy + alert code within `hours`. */
export function getRecentAnalysis(strategy_id, code, hours = 6) {
  return db.prepare(`
    SELECT analysis, analysis_at FROM alerts
    WHERE strategy_id = ? AND code = ? AND analysis IS NOT NULL
      AND analysis_at >= datetime('now', ?)
    ORDER BY analysis_at DESC LIMIT 1
  `).get(strategy_id ?? "", code, `-${Number(hours)} hours`) ?? null;
}

export function logAnalystCall({ alert_id, model, ok, ms }) {
  db.prepare("INSERT INTO analyst_calls (alert_id, model, ok, ms) VALUES (?, ?, ?, ?)")
    .run(alert_id ?? null, model ?? null, ok ? 1 : 0, ms ?? null);
}

/** Calls made today (UTC), successful or not — what the daily cap counts. */
export function countAnalystCallsToday() {
  return db.prepare("SELECT COUNT(*) AS c FROM analyst_calls WHERE date(created_at) = date('now')").get().c;
}

/**
 * Open an alert, or refresh the message of the one already open.
 * @returns {boolean} true when a new alert was created
 */
export function raiseAlert({ strategy_id = "", code, message, level = "warning" }) {
  const open = db.prepare(
    "SELECT id FROM alerts WHERE strategy_id = ? AND code = ? AND resolved_at IS NULL"
  ).get(strategy_id ?? "", code);
  if (open) {
    db.prepare("UPDATE alerts SET message = ?, level = ?, updated_at = datetime('now') WHERE id = ?")
      .run(message, level, open.id);
    return false;
  }
  db.prepare("INSERT INTO alerts (strategy_id, code, level, message) VALUES (?, ?, ?, ?)")
    .run(strategy_id ?? "", code, level, message);
  return true;
}

export function resolveAlert(strategy_id, code) {
  db.prepare(`
    UPDATE alerts SET resolved_at = datetime('now')
    WHERE strategy_id = ? AND code = ? AND resolved_at IS NULL
  `).run(strategy_id ?? "", code);
}

export function resolveAlertById(id) {
  db.prepare("UPDATE alerts SET resolved_at = datetime('now') WHERE id = ? AND resolved_at IS NULL").run(id);
}

export function getOpenAlerts() {
  return db.prepare(`
    SELECT a.*, s.name AS strategy_name FROM alerts a
    LEFT JOIN strategies s ON s.id = a.strategy_id
    WHERE a.resolved_at IS NULL
    ORDER BY a.created_at DESC
  `).all();
}

/** Alerts created after the given id — used by the desktop app for notifications. */
export function getAlertsAfter(id = 0) {
  return db.prepare("SELECT * FROM alerts WHERE id > ? ORDER BY id ASC").all(id);
}
