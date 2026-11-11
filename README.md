# AgentSignal Trader

Autonomous trading agent for [AgentSignal](https://agentsignal.app) strategies.

Runs **locally on your machine or VPS**. Your private key never leaves your environment.

## How it works

```
agentsignal.app          Your machine
────────────────         ──────────────────────────────
Strategy signals   ←──  Fetches signal (pays $0.01 USDC via x402)
COMPASS / RADAR          Executes on Hyperliquid perps
Navigator                Local dashboard at localhost:4100
```

## Requirements

- Node.js 20+
- A small amount of USDC on Base mainnet (for x402 signal payments — ~$0.01/day)
- A Hyperliquid account with funds

## Setup

```bash
git clone https://github.com/hoolibear/trader
cd trader
npm install
npm run setup
```

The setup wizard will:
- Save your private key to a local `.env` file
- Test Hyperliquid and agentsignal.app connections
- Add your first strategy

## Running

```bash
# Start the dashboard (always-on web UI)
npm run dashboard
# → http://localhost:4100

# Run the trader once manually
npm run trade

# Run the trader in dry-run mode (no real orders)
node trader.mjs --dry-run

# Start everything on a schedule with PM2
npm start
```

## Dashboard

Open [http://localhost:4100](http://localhost:4100) to:

- View open Hyperliquid positions + liquidation prices
- Activate / deactivate strategies
- Execute trades manually
- View signal and trade history

## Adding strategies

1. Go to [agentsignal.app/navigator](https://agentsignal.app/navigator)
2. Build or load a strategy
3. Copy the strategy ID from the Live Signal URL
4. Add it in the dashboard → Strategies → Add Strategy

## Schedule

By default the trader runs at **9:31 AM ET (13:31 UTC) on weekdays** via PM2.

Edit `ecosystem.config.cjs` to change the schedule.

## Security

- Your `AGENT_PRIVATE_KEY` is stored in `.env` on your local machine only
- The `.env` file and `data/` directory are in `.gitignore` — never committed
- Signal fetches are paid with $0.01 USDC per request via the x402 protocol
