# Trader monitor

Read-only watchdog for the Hyperliquid account. Runs on the VPS so it keeps
watching when the Mac that trades is asleep or the trader has stopped.
Sends Telegram messages. Holds no private key and cannot trade.

## What it reports

| Message | When |
|---|---|
| 🚨 NO STOP-LOSS | open position with no stop order resting on the exchange |
| 🚨 NEAR LIQUIDATION | price within `LIQ_WARN_PCT` (10%) of the liquidation price |
| 🚨 Trader has not checked in | optional heartbeat is older than `HEARTBEAT_MAX_MIN` |
| 🚨 Cannot reach Hyperliquid | 3 failed checks in a row |
| 🔁 STILL … | an alert is still active after `REMIND_HOURS` (6) |
| ✅ Cleared | the condition went away |
| 📈 📉 🔄 ↕️ | position opened, closed, flipped, resized |
| 🗓 Daily summary | once a day at `DAILY_UTC_HOUR`; also proves the monitor is alive |

If the daily summary stops arriving, the monitor itself is down.

## Files

- `watchdog.mjs` — one check per run, no dependencies (Node 22+)
- `monitor.env` — settings (from `monitor.env.example`), mode 600
- `state.json` — written by the watchdog: open alerts, last seen positions
- `trader-monitor.service` / `.timer` — systemd user units, every 2 minutes

## Install on the VPS (user `imd`, no sudo needed)

```bash
mkdir -p ~/trader-monitor && cd ~/trader-monitor      # copy watchdog.mjs + monitor.env here
chmod 600 monitor.env
set -a; . ./monitor.env; set +a
node watchdog.mjs --test                               # one test message to Telegram
node watchdog.mjs --dry                                # print what it would send
cp trader-monitor.service trader-monitor.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now trader-monitor.timer
```

Check on it: `systemctl --user list-timers trader-monitor.timer`,
`journalctl --user -u trader-monitor.service -n 20`.
Stop it: `systemctl --user disable --now trader-monitor.timer`.

## Heartbeat (not set up yet)

The watchdog cannot see the Mac. To learn that the trader stopped, the trader
must check in: after each cycle it touches `HEARTBEAT_FILE` on the VPS over SSH.
Until that is wired into the desktop app's scheduler, leave the two
`HEARTBEAT_*` settings commented out.

## Test

`npm test` covers the risk logic (`assess()`): stop detection for longs and
shorts, orders that do not count as stops, liquidation distance.
