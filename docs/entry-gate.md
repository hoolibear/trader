# Entry Gate & Adaptive Risk

`confirmEntry()` in `execution.mjs` — runs before every new scalper entry. Exits (FLAT signals) are never blocked. Fails open: if candle data is unavailable, the entry is allowed rather than stranded.

## Two Layers (first block wins)

| Layer | What it checks | Threshold | Why |
|---|---|---|---|
| L3 ATR regime | ATR(14) vs ATR(50) on strategy interval | Block if ATR(14) > 1.5× ATR(50) | Short-term volatility blowing out vs its own baseline = market stress event. The Jun 2026 NEAR selloff (-22% in hours) would have elevated ATR(14) before entry. Stand aside until conditions normalise. |
| L4 BTC macro | BTC 4h candle change (always HL, always 4h) | Block if BTC down > 2.5% | Most alt liquidation cascades are BTC-led and start with a single large candle. Checked regardless of the strategy's own interval. |

The layers keep their old numbers so existing log lines (`Gate L3 blocked …`) still make sense.

### Removed: L1 RSI band and L2 EMA50 trend

L1 allowed longs only with RSI(14) between 40 and 65; L2 required price above EMA(50) for longs. Both were removed in commit `4021bf4`. They suit trend-following entries but block exactly the entries a mean-reversion strategy exists to take: the logs show L1 refusing a NEAR Mean Reversion long at RSI 30.7. Decision on 2026-11-10: keep them removed. If a trend strategy needs them later, bring them back as a per-strategy option, off by default.

## Adaptive SL

Computed at entry time: `1.5 × ATR(14) / entry_price × 100`, clamped [3%, 15%].

Written to `strategies.sl_pct_adaptive` just before the entry, used for the native stop order on Hyperliquid, and cleared when the position closes. The stop is fixed at the value computed when the position opened, not recalculated. Your own `sl_pct` setting is left untouched and is the fallback when the gate fails open.

**Fixed stop.** `strategies.sl_fixed = 1` turns the adaptive stop off for that strategy; the stop is your `sl_pct`. The L3 and L4 checks still run. Set on NEAR Mean Reversion (8%) on 2026-11-11, with `tp_pct` and `trail_pct` set to 0 so the only exits are its own exit rule and the stop.

**Effect:** calm market → ATR is low → SL tightens to ~3–5%. Volatile market → ATR is high → SL widens to ~8–12%. No manual adjustment needed between market regimes.

The stop is a real order resting on the exchange (reduce-only trigger). `ensureNativeStop()` checks on every run that it is still there and re-places it if not. If it cannot be placed, an alert is raised; see `docs/bugs-to-research.md` item 0.

## Tuning Guide

### Too many blocked entries (strategy rarely trades)

| Knob | Current | Looser |
|---|---|---|
| ATR ratio | 1.5× | 1.8× or 2.0× |
| BTC drop threshold | -2.5% | -3.5% |

### Too many losing trades (gate not filtering enough)

| Knob | Current | Tighter |
|---|---|---|
| ATR ratio | 1.5× | 1.2× |
| BTC drop threshold | -2.5% | -1.5% |

### Adaptive SL too tight (stops firing on normal retracements)
- Raise the ATR multiplier: `2.0 × ATR(14)` instead of `1.5`
- Raise the minimum clamp: `Math.max(5, ...)` instead of `3`

### Adaptive SL too wide (not protecting against big moves)
- Lower the ATR multiplier: `1.0 × ATR(14)`
- Lower the maximum clamp: `Math.min(10, ...)` instead of `15`

## What This Does NOT Protect Against

- **Manual entries** — the dashboard's Open and Add buttons skip the gate. The next scheduled run adds a stop to the position if the strategy has a stop percent.
- **Gaps / flash crashes** — the native stop triggers on the exchange, but in a gap it fills at the next available price, up to 5% beyond the trigger.
- **Sustained BTC drawdowns** — L4 catches the first candle where BTC drops > 2.5%. If BTC then drops 2% per candle repeatedly, subsequent candles may not individually trigger the threshold
- **Being in a position** — gates only block new entries. If you're already in a trade when L3 or L4 conditions arise, the position stays open until the exit signal fires or SL hits

## Where the Thresholds Come From

- **1.5× ATR ratio:** ATR(14) > 1.5× ATR(50) means short-term volatility is 50% above its baseline — a meaningful signal of regime change, not just normal chop.
- **2.5% BTC drop:** large enough to filter real macro events, small enough not to trigger on normal hourly volatility. BTC moves ~0.5–1.5% per hour in normal conditions; 2.5% on a single 4h candle is a clear stress signal.

## Next Evolution

Phase 4 ticker signal engine adds another gate: AI-scored sentiment from Venice/xAI using on-chain data, funding rates, and social signals. Score −5 to +5; block entries below a configurable threshold. Same `confirmEntry()` function, one more condition.
