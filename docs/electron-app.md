# AgentSignal Trader — Mac desktop app

Spec for the local desktop build. Status: **v1 built and run in dry-run mode on 2026-11-10.**
It has not yet traded live. Built for this Mac only: unsigned, not notarised, not for distribution.

## Why

The trader ran under PM2. On 2026-10-11 the PM2 daemon restarted with an empty process list and
the trader stayed dead for a month without anyone noticing, with a live position open. The app's
job is to make the runner visible and loud: a menu-bar icon that shows whether trading is on,
and notifications when something needs a human.

## What it is

One Electron process hosts three things that used to be separate PM2 processes:

| Part | File | Replaces |
|---|---|---|
| Dashboard server | `dashboard.mjs` (`startServer()`) | PM2 `trader-dashboard` |
| Scheduler | `scheduler.mjs` | PM2 cron `trader` + `trader-crypto` |
| Trading engine | `execution.mjs` (`runStrategyOnce()`) | same code the CLI uses |

The window is a plain browser view of `http://127.0.0.1:<port>`. There is no UI rewrite: every
page is the existing dashboard.

```
electron/main.mjs ──► dashboard.mjs   (HTTP, 127.0.0.1 only)
        │
        ├──────────► scheduler.mjs ──► execution.mjs ──► exchanges/*
        │                   │
        └── tray, window,   └── runlock.mjs (shared with trader.mjs)
            notifications
```

## Scheduler

- Wakes every 60 seconds.
- **Crypto** strategies run when their own `interval_minutes` has passed (`isStrategyDue()`), 24/7.
- **Stock** strategies run once per weekday from 13:31 UTC, the slot PM2 used. Unlike PM2, a
  missed slot is caught up: if the Mac was asleep at 13:31, the run happens on wake, as long as it
  is before 20:00 UTC. Note 13:31 UTC is 9:31 ET only during daylight saving time; in winter it is
  8:31 ET. This was already true of the PM2 cron and is not changed here.
- One strategy at a time. A manual "Run" from the dashboard queues behind a scheduled run.
- A failed signal fetch is retried on the next tick rather than after a full interval.
- After each cycle the position snapshot is posted to AgentSignal (`syncPositions()`).
- On wake from sleep the scheduler checks at once.

## Safety

| Rule | How |
|---|---|
| Trading starts **paused** | `data/app-state.json` holds `{ "paused": … }`. Missing file means paused. Switching on asks for confirmation. |
| One runner at a time | `data/runner.lock` (pid + time). The app and `trader.mjs` both take it. If PM2 is mid-run the app waits; if the app is mid-run the CLI exits. A lock from a dead process or older than 15 minutes is ignored. |
| One copy of the app | Electron single-instance lock. A second launch just shows the window. |
| Local only | The dashboard listens on `127.0.0.1`. Before this change it listened on every network interface with no login. |
| No silent death | Notification if the scheduler has not ticked for 3 minutes while trading is on. Quitting with trading on asks first. |
| Alerts | The engine writes to the `alerts` table; the app shows each new one as a notification and the dashboard shows a banner on every page. |

Alert codes: `stop_missing` (stop order failed, retried each run), `stop_breached` (position found
with no stop and price already past the stop level; nothing is placed), `execution_error`,
`signal_fetch_failed`, `run_failed`.

## Menu-bar icon

- Title shows `⏸` when paused and `⚠` when a critical alert is open.
- Menu: trading state, active strategy count, last run and its results, open alerts,
  Open Dashboard, Run Now, Start/Pause Trading, Launch at Login, Show Log File, Quit.
- Closing the window keeps the app running in the menu bar.

## Sleep

While trading is on the app holds a `prevent-app-suspension` power blocker. This stops macOS
napping the app. It does **not** keep a laptop awake with the lid closed. When the Mac sleeps,
nothing checks signals; stop orders already on the exchange still work. For unattended running,
keep the Mac on power with sleep disabled, or use the VPS plan in `docs/vps-trader.md`.

## Files and data

- **Trader data:** v1 uses the existing folder (`TRADER_HOME`, default this repo) for `.env` and
  `data/`. The app, the CLI and PM2 all see the same strategies, keys and history. Nothing is copied.
- **App's own files:** `~/Library/Application Support/AgentSignal Trader/`
  - `config.json`: `{ "home": "<trader folder>", "dryRun": false }`
  - `logs/trader.log`: everything the engine prints; rotated at 5 MB
- **Dry run:** set `"dryRun": true` in `config.json`, or launch with `TRADER_DRY_RUN=1`.
  Signals are fetched and decisions logged; no orders, no database writes.
- Known gap: `exchanges/schwab.mjs` and `schwab-auth.mjs` still resolve their token and
  certificate files next to the code, not through `TRADER_HOME`. Harmless while the home is this repo.

## Build

```bash
npm run app:dev        # stage + run from source
npm run app:dev:dry    # same, dry-run mode
npm run app:build      # → dist/mac-arm64/AgentSignal Trader.app
npm test               # engine, scheduler and lock tests
```

`scripts/stage-app.mjs` copies the source into `.app-stage/` and installs production dependencies
there. `electron-builder` then packages that folder.

**Why a staged copy:** the app needs `better-sqlite3` v13, whose Node-API binary loads under both
Node and Electron with no compile step. The repo itself stays on v11 for the CLI. All other
dependencies are pinned to the exact versions the repo has installed.

**Do not run `electron-rebuild`.** It walks up into the repo's `node_modules` and deletes the
SQLite binary the CLI and PM2 need. (This happened during the build; `npm rebuild better-sqlite3`
restores it.)

Packaging choices: arm64 only, unsigned (`identity: null`), `asar` off so the Vultisig SDK can read
its WASM files from disk. The bundle is about 1 GB, most of it the Vultisig SDK's chain libraries.

## Switching from PM2 to the app

Not done yet. When ready:

1. Fix or close any position the dashboard banner flags.
2. Make sure PM2 is not running `trader` / `trader-crypto` (`pm2 ls`). The run lock prevents
   double trading, but two runners on different schedules is still confusing.
3. Open the app, check the dashboard, choose **Start Trading…** from the menu-bar icon.
4. Tick **Launch at Login**.

## Not built (later)

- Move data to `~/Library/Application Support`, keys to the macOS Keychain.
- Code signing, notarisation, auto-update, Intel build.
- Balance pre-flight check and exchange-error circuit breaker (roadmap Phase 1).
- Tray toggle for dry-run mode.
