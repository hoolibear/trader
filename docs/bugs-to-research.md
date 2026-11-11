# Trading engine bugs — found and fixed

Logged 2026-11-10 from a read-through of `execution.mjs`, `trader.mjs`, `db.mjs`, `hyperliquid.mjs`
and the PM2 logs. Fixed the same day. Every fix has a test in `test/execution.test.mjs` that runs
against a fake exchange (`npm test`, 19 passing).

**Not yet proven against the real exchange:** fix 0 (stop price format). The rule it applies comes
from the Hyperliquid SDK's own formatter, and matches the rejected order, but no live stop order
has been placed with the new code. See "Still open" at the end.

Items 0, 1, 2 and 6 were confirmed to exist in committed `HEAD:trader.mjs`, so the extraction to
`execution.mjs` did not introduce them. The extraction itself was diffed function by function
against `HEAD` and changed no behaviour.

| # | Bug | Status |
|---|---|---|
| 0 | Native stop-loss never placed; a failed stop lost the trade record | fixed, live check pending |
| 1 | Short TP/trail logic was long-only | fixed |
| 2 | Scalpers never ran the trail check while in a position; false "flip" events | fixed |
| 3 | Cooldown and max-size guards blocked exits | fixed |
| 4 | No SHORT → LONG branch | fixed |
| 5 | x402 payment ignored the vault signer | fixed in code, vault path untested |
| 6 | Entry gate L1/L2 documented but not in code | docs corrected (decision: keep removed) |
| 7 | Entry recorded without checking the fill | fixed |
| 8 | A failed exit was never retried | fixed (found during the work) |
| 9 | Dashboard open to the whole network | fixed (found during the work) |
| 10 | Dashboard trade routes bypassed the engine | fixed (found during the work) |

---

## 0. Native stop-loss was never placed

**Evidence (PM2 logs and DB)**

- `trader-crypto-out.log`: 2 `Native SL SELL` attempts, 0 `Native SL set` confirmations.
- `trader-crypto-error.log`: 2 matching errors,
  `Execution error for NEAR Mean Reversion: Order 0: Invalid TP/SL price. asset=74`.
- Last entry, 2026-09-28: `Placing BUY 12.6866 NEAR @ ~$4.729`, then
  `Native SL SELL 12.6866 NEAR trigger $4.554 limit $4.326`, then no `ENTERED` line.
- DB: no `ENTERED` trade row after the 2026-09-18 close; `stop_order_id` empty.
- NEAR's 4h low between 2026-09-28 and 2026-10-11 was $4.293, below the $4.554 trigger, and the
  position was still open on 2026-10-11. So no stop was resting on the exchange.

**Cause.** The trigger price was sent with `toPrecision(6)`. Hyperliquid accepts at most 5
significant figures and at most `6 − szDecimals` decimals for perps. `4.729 × (1 − 0.0371)` is
`4.55355`: six figures. The log hid this because it printed with `toLocaleString()`.
When the stop threw, `executeTrade()` exited before `insertTrade()`, so the open position had no
stop, no trade row, no TP state and no cooldown timestamp.

**Fix**

- `hyperliquid.mjs`: every price now goes through `formatHlPrice()`, a wrapper around the SDK's
  `formatPrice` (`@nktkas/hyperliquid/utils`). No `toPrecision` calls remain.
- `execution.mjs` `openPosition()`: order → check fill → record trade and TP state → then the stop,
  which can no longer throw away the trade. One retry.
- If the stop still fails: the position is kept (your decision), an alert `stop_missing` is raised,
  and `ensureNativeStop()` tries again on every later run.
- `ensureNativeStop()` runs each cycle for any open position with a stop percent. It adopts a stop
  already resting on the exchange, places a missing one from the entry price, or, when the price
  is already past the stop level, places nothing and raises `stop_breached` (your decision).

## 1. Short TP/trail was long-only

Short entries never set TP state; the auto-initialised state for a short was treated as hit at
once (`price >= tp_price` with TP below entry); trail maths and P&L assumed a long. Effect: a short
would be closed on a move in its favour with the wrong P&L sign.

**Fix:** `checkTpTrail()` is direction-aware. `tp_state.high_water` now means "best price seen"
(highest for a long, lowest for a short). TP state left over from a position on the other side is
discarded. Both entry sides set TP state, from the fill price.

## 2. Scalpers skipped the trail check while holding

`checkTpTrail()` only ran in the unchanged-signal branch, which scalpers with LONG/SHORT skipped.
Every such run also logged `Signal flip: LONG → LONG` and wrote a `flip` event.

**Fix:** any run that does not trade now does position upkeep (`maintainPosition()`: trail check,
then stop check). Events are `flip` only when the signal changed, else `check`.
The no-flip scalper entry rule is unchanged and has its own test.

## 3. Guards blocked exits

`runGuards()` ran before the code knew whether it was entering or exiting, so a FLAT signal inside
the cooldown returned `Blocked` and left the position open.

**Fix:** guards apply to entries only. No live strategy had a cooldown set, so this never fired.

Known limit, unchanged: for a non-scalper, an entry blocked by cooldown is not retried, because
the signal then reads as unchanged. Non-scalpers trade on flips only, by design.

## 4. SHORT → LONG did nothing

**Fix:** `executeTrade()` now works from two questions, "must the current position close?" and
"must a new one open?", which covers every signal/position pair. The three copies of entry code
are one `openPosition()` helper. A flip writes two trade rows: `CLOSED … (flip)` with P&L, then
`ENTERED …`.

## 5. x402 payment ignored the vault

`fetchSignal()` and `subscribeStrategy()` always signed with `AGENT_PRIVATE_KEY`.

**Fix:** `getPaymentAccount()` picks the payer the same way trading does: vault when
`VAULT_ACTIVE=true`, else the DB trading wallet, else the env key. If the vault cannot be loaded it
falls back to the raw key with a warning. A failed fetch raises `signal_fetch_failed`.

**Untested:** paying through the vault. It needs a real 402 response and a real signature.
The payer address changes when the vault is active, so check that address holds Base USDC and the
subscriptions before relying on it.

## 6. Entry gate L1/L2

Only L3 (ATR regime) and L4 (BTC macro) run. L1 (RSI band) and L2 (EMA50) were removed in commit
`4021bf4`; logs show L1 blocking a NEAR Mean Reversion entry at RSI 30.7, which is where that
strategy wants to buy. Decision: keep them removed. `CLAUDE.md`, `docs/entry-gate.md` and the code
comment are corrected.

## 7. Fill not checked

**Fix:** `parseFill()` reads the order result. No fill → error, no trade row, no stop. Partial
fill → the filled size is recorded and protected. Trade price and stop level use the fill price,
not the mid. Exchanges whose result shape is not recognised keep the old behaviour.

Also changed: the entry order is no longer wrapped in `withRetry()`. An order is not idempotent;
retrying after a timeout could open the position twice.

## 8. A failed exit was never retried

If closing threw, the signal was already stored as FLAT, so the next run saw "unchanged" and held.

**Fix:** when execution fails on a changed signal, the stored signal is put back, so the next run
sees the change again. An `execution_error` alert is raised.

## 9. Dashboard open to the network

`server.listen(PORT)` bound every interface. The dashboard has no login and its routes can trade,
withdraw and change wallets, so anyone on the same network could use it.

**Fix:** binds `127.0.0.1` only. Checked: a request to the LAN address is refused.

## 10. Dashboard trade routes bypassed the engine

`/api/run` and `/api/execute` had their own copies of the signal and trade logic: no stop, no
guards, no fill check, raw key only. `/api/close` left the native stop resting.

**Fix:** both routes call `execution.mjs`. The duplicate `tryLocalEvalDash()` and its indicator
helpers are deleted. Manual close cancels the native stop and clears TP state. Manual open, add,
cancel and edit get their Hyperliquid client from `getExchange()`, so they follow the vault.
Also fixed: the strategies page treated `ENTERED SHORT` as a long.

## Smaller fixes

- **Dry run writes nothing:** no signals, events, TP state, trades or alerts. Enabled by
  `--dry-run` or `TRADER_DRY_RUN=1`. It still fetches signals, so a paid fetch can still cost $0.01,
  and it still posts the position snapshot to AgentSignal.
- **Adaptive stop no longer overwrites your setting.** The gate's stop goes to
  `strategies.sl_pct_adaptive` and is cleared when the position closes. Note: NEAR Mean Reversion's
  `sl_pct` currently holds 3.71, an adaptive value written by the old code. Set it to what you want.
- **Stop order ids** are stored as text and converted to numbers for cancel.

---

## 9. Server signal closed a position whose exit rules were not met (fixed 2026-11-11)

**What happened.** 2026-11-11 18:06 UTC: NEAR Mean Reversion closed 20.7 NEAR at $3.7375 for
-$12.80. Its long exit rule needs RSI(14, 4h) >= 80 AND price >= 10% above entry. Actual: RSI
about 56.7, price 14% below entry ($4.356).

**Cause.** A run gets its signal from the local check first and falls back to the server. The
local check knows a position is open and tests only the exit rule. The server does not: it
reports whether the entry rule (RSI <= 45) is true now, so it said FLAT. At 18:00 the local
check failed without logging anything, the run fell back to the server six minutes later, and
the engine treated LONG -> FLAT as an exit. The fallback predates the 2026-11-10 work; the old
cooldown guard on exits may have hidden it.

**Fix.** With a position open and no local check, the run holds: nothing is closed, alert
`local_check_failed` is raised, the stop and trail upkeep still run, and the next run tries
again. The server signal is still used when flat (entries) and for strategies with no exit
rules of their own. Local check failures now log their reason. Five tests cover it.

**Not known.** Why the local check failed at 18:00 (network drop or the Mac sleeping are the
likely causes).

## Still open

1. **Live stop-order check.** Place one stop with the new price format at minimum size, confirm
   Hyperliquid accepts it, cancel it. Needs your go-ahead: real order on the real account.
2. ~~Live NEAR position.~~ Closed 2026-11-11 by bug 9 above.
3. **Vault x402 payment** untested (item 5).
4. **Balance pre-flight check** and **exchange-error circuit breaker**: not in this work.
5. **Shared positions.** Two strategies on the same asset share one exchange position and would
   fight over it. Not addressed.
