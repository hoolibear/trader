# CLAUDE.md — AgentSignal Trader

## Overview

Standalone local trading agent for [agentsignal.app](https://agentsignal.app) strategies.
Fetches live signals via x402, detects flips, and executes market orders on Hyperliquid perps.
Your private key never leaves your machine.

- **Repo**: `github.com/ToknWrks/trader`
- **AgentSignal app**: `/Users/lancepitman/AgentSignal/` (separate repo)
- **Dashboard**: `http://localhost:4100` (run `npm run dashboard`) — listens on 127.0.0.1 only
- **Desktop app**: `npm run app:build` → `dist/mac-arm64/AgentSignal Trader.app` (spec: `docs/electron-app.md`)
- **Bug log**: `docs/bugs-to-research.md` — engine bugs fixed 2026-11-10 and what is still open

## Roadmap

### Phase 1 — Hardening
- [ ] Balance pre-flight check — guard against orders with insufficient funds
- [ ] Circuit breaker — halt trade runner on repeated exchange errors

### Phase 2 — AgentSignal Integration (Vercel)
- [ ] Migrate UI: `dashboard.mjs` → Next.js App Router + React components
- [ ] Migrate scheduling: PM2 cron → Vercel Cron Jobs → API routes
- [ ] Migrate database: SQLite → Neon Postgres
- [ ] Migrate wallet: `AGENT_PRIVATE_KEY` → browser wallet (Wagmi/RainbowKit)
- [ ] x402 payment flow: client-side wallet signs, API route relays

### Phase 3 — Key Management (VultiSig MPC) ✅ COMPLETE
- [x] Fast Vault (2-of-2) — `VAULT_ACTIVE=true`, `VULT_FILE_PATH`
- [x] VultiSig SDK for HL EIP-712 signing
- [x] VultiSig for x402 payment signing
- [x] Circuit breaker: halt if VultiServer unreachable

### Phase 3b — VPS-hosted Trader
- [ ] Vault onboarding UI in AgentSignal dashboard
- [ ] Per-user Neon Postgres DB
- [ ] VPS cron replacing PM2
- [ ] Multi-tenancy model (shared process vs per-user)

See `docs/vps-trader.md` for full architecture, open questions, and Engine comparison.

### Phase 4 — Ticker Signal Engine (Bring-Your-Own-Key AI)
- [ ] `ticker-signal/` scaffold (providers/, prompts/, score.mjs)
- [ ] Venice provider (primary — privacy-preserving)
- [ ] Alchemy + CoinGecko providers (on-chain + market data)
- [ ] xAI/Grok or Anthropic provider (inference)
- [ ] Composite score (−5 to +5) as new condition source: `{ "source": "ticker_signal", "field": "score", "op": "<=", "value": -2 }`
- [ ] Settings page for user-supplied inference API keys
- [ ] Score surfaced read-only on AgentSignal strategy detail page

---

## To Do

- [ ] **Balance pre-flight check** — in `runGuards()` before orders: call `getAccountState()`, read `marginSummary.withdrawable`, compare to `sizeUsd / leverage`. Block + log if insufficient. Add `getBalance()` to `HyperliquidExchange` and other exchange classes.

## Commands

```bash
npm run setup        # interactive setup wizard (first-time)
npm run dashboard    # local control panel at localhost:4100
npm run restart      # restart the PM2 dashboard process only (not the traders)
npm test             # engine, scheduler and run-lock tests (fake exchange, no network)
npm run app:dev      # desktop app from source (app:dev:dry = no orders)
npm run app:build    # build the unsigned Mac app into dist/
npm start            # start all PM2 processes
npm run trade        # manual one-shot run (all strategies)
node trader.mjs --dry-run          # simulate: no orders, nothing written (or TRADER_DRY_RUN=1)
node trader.mjs --crypto-only      # only crypto strategies
node trader.mjs --stocks-only      # only stock/ETF strategies
```

## Files

| File | Purpose |
|---|---|
| `trader.mjs` | CLI runner (PM2) — picks due strategies, calls the engine |
| `execution.mjs` | **Trading engine** — signal fetch, entry gate, orders, native stop, TP/trail. The only place trade logic lives; CLI, dashboard and desktop app all call it |
| `scheduler.mjs` | In-process scheduler used by the desktop app (replaces PM2 cron) |
| `runlock.mjs` | `data/runner.lock` — one runner at a time (app vs CLI/PM2) |
| `paths.mjs` | `TRADER_HOME` → `.env` and `data/` location (default: repo) |
| `markets.mjs` | `isCrypto()` + crypto ticker list |
| `analyst.mjs` | "Use my Claude Code": runs the user's local `claude -p` (their own sign-in, tools off, API key env stripped) to explain alerts. Off by default; `CLAUDE_ANALYST*` in `.env`, Settings → Claude Code tab. Advisory only — never trades |
| `monitor/` | Read-only VPS watchdog with Telegram alerts (address only, no keys). Deployed on the worker VPS at `~/trader-monitor/` |
| `electron/main.mjs` | Desktop app shell: tray, window, notifications |
| `scripts/stage-app.mjs` | Builds `.app-stage/` for Electron. Never run `electron-rebuild` (it wipes the repo's SQLite binary) |
| `dashboard.mjs` | Local web dashboard (HTTP server, no framework) |
| `db.mjs` | SQLite via better-sqlite3: strategies, signals, trades, alerts |
| `hyperliquid.mjs` | Hyperliquid client (`@nktkas/hyperliquid` + viem) |
| `vultisig-vault.mjs` | VultiSig Fast Vault signing |
| `setup.mjs` | Interactive setup wizard |
| `ecosystem.config.cjs` | PM2 config (3 processes) |

## PM2 Schedule

| Process | Args | Cron | When |
|---|---|---|---|
| `trader` | `--stocks-only` | `31 13 * * 1-5` | 9:31 AM ET, weekdays |
| `trader-crypto` | `--crypto-only` | `*/5 * * * *` | every 5 min, 24/7 — each strategy then runs on its own `interval_minutes` |
| `trader-dashboard` | — | always-on | — |

## Crypto Detection

`isCrypto(symbol)` in `markets.mjs` strips `-USD`/`/USD` and checks against `CRYPTO_TICKERS` set (50 tickers). Mirrored in `dashboard.mjs` for activation modal schedule display.

## Entry Gate & Adaptive Risk (scalpers)

`confirmEntry()` in `execution.mjs` — runs before every new scalper entry, never blocks exits. Fails open on candle fetch errors.

| Layer | Check | Threshold |
|---|---|---|
| L3 ATR regime | ATR(14) vs ATR(50) | Block if ATR(14) > 1.5× ATR(50) |
| L4 BTC macro | BTC 4h candle change | Block if BTC down > 2.5% |

L1 (RSI band) and L2 (EMA50) were removed on purpose — they blocked mean-reversion entries. Do not restore without asking.

**Adaptive SL:** `1.5 × ATR(14) / price × 100`, clamped [3%, 15%], written to `strategies.sl_pct_adaptive` at entry and cleared on close. The user's `sl_pct` is never overwritten. See `docs/entry-gate.md`.

## Execution Rules (do not regress)

- **Entry order of work:** place order → check fill (`parseFill`) → record trade + TP state → place native stop. A stop failure must never lose the trade record.
- **Stop fails:** keep the position, raise alert `stop_missing`, `ensureNativeStop()` retries every run.
- **Position found with no stop and price past the stop level:** place nothing, raise `stop_breached`.
- **Guards (cooldown, max size) apply to entries only.** Exits are never blocked.
- **Prices to Hyperliquid go through `formatHlPrice()`** (5 significant figures, `6 − szDecimals` decimals). Never `toPrecision()` — a 6-figure trigger price is rejected as `Invalid TP/SL price`.
- **Entry orders are not retried** (not idempotent). Closes are.
- **The server signal never closes a position that has its own exit rules.** The server does not know a position is open; for scalpers its FLAT only means "entry rule not true now". Position open + local check unavailable (rules not loaded, no candles, no price) → hold, raise `local_check_failed`, retry next run. See `hasOwnExitRules()` / `mustHoldWithoutLocalCheck()`.
- **Scalpers enter on signal + no position, no flip needed.** Signal events are `flip` only when the signal changed.
- **TP/trail is direction-aware.** `tp_state.high_water` = best price seen (lowest for a short).
- **Alerts** (`alerts` table) surface as a dashboard banner and desktop notifications.

## Signal Flow

1. Fetch from `AGENT_SIGNAL_URL/api/strategy/:id/signal` via x402 ($0.01 USDC on Base)
2. Store in SQLite `signals` table
3. Compare to prior — if unchanged, hold
4. If flipped: FLAT→LONG = buy, LONG→FLAT = close, LONG→SHORT = close+short, SHORT→LONG = close+long
5. No trade this run → position upkeep: trail/TP check, then make sure the native stop is resting

## Hyperliquid Notes

- **SDK**: `@nktkas/hyperliquid` + viem WalletClient — do NOT use custom EIP-712 (derives wrong address)
- **Asset index**: `order.a` must be a number — use `InfoClient.meta()` to resolve ticker → index
- **unifiedAccount mode**: spot + perp USDC are ONE balance. `clearinghouseState.withdrawable` = 0 and meaningless. Real available = `spotUsdc − marginSummary.totalMarginUsed`. Do NOT use `withdrawable + spot` (double-counts). `usdClassTransfer` is blocked.
- **default mode**: perp and spot are separate. Sweep spot→perp with `usdClassTransfer({ toPerp: true })` before withdraw.
- Dashboard funding code branches on abstraction mode — unified skips Spot→Perp button.

## x402 Payments

- `$0.01` USDC per signal fetch on Base mainnet
- Requires USDC on Base at the signing wallet address
- Dashboard positions page shows Base USDC balance + estimated total spend

## Dashboard Features

- Activate/deactivate strategies (styled confirm modal — no browser `confirm()`)
- Status column ℹ popover explaining execution flow
- Activation modal shows correct schedule (hourly vs market open) by symbol
- `parseSchedules()` reads cron from `ecosystem.config.cjs` at runtime
- Positions page: open HL positions + x402 spend tracker

## SQLite Schema (`data/trader.db`)

```sql
strategies (id, name, symbol, leverage, position_size_usd, exchange, interval_minutes, last_run_at, active,
            sl_pct, sl_pct_adaptive, tp_pct, trail_pct, max_size_usd, cooldown_minutes, risk_mode, stop_order_id, …)
signals    (strategy_id, date, signal, price, notes)  -- UNIQUE(strategy_id, date)
trades     (strategy_id, date, action, asset, size, price, leverage, pnl, result_json, fill_hash)
alerts     (strategy_id, code, level, message, created_at, resolved_at)  -- one open per strategy+code
```

Also: `tp_state`, `signal_events`, `signal_fetches`, `wallets`, `vault_watchlist`, `staking_contracts`, `snapshots`.

- `active` is INTEGER 0/1 (not boolean)

## Environment Variables (`.env`)

```
AGENT_PRIVATE_KEY      # 0x-prefixed EVM key (fallback when VAULT_ACTIVE=false)
AGENT_SIGNAL_URL       # https://agentsignal.app (or http://localhost:3001 for local dev)
HL_POSITION_SIZE_USD   # notional trade size in USD (e.g. 10)
VAULT_ACTIVE           # true = use VultiSig Fast Vault instead of raw key
VULT_FILE_PATH         # path to vault file (required when VAULT_ACTIVE=true)
COINGECKO_API_KEY      # optional, for rate limit relief
```

## Liquidation Note

Trader checks positions only when it runs — no real-time monitoring. Protection between runs is the native stop order on Hyperliquid, when one is resting. If price moves sharply between runs at leverage, Hyperliquid's engine handles liquidation. The entry gate (L3 ATR regime + L4 BTC macro) reduces the chance of entering into a move that leads to liquidation, but does not prevent it once in a position.
