<div align="center">
  <img src="docs/assets/logo.svg" alt="vitals — local-first health archive and baseline-deviation detector" width="720">
</div>

<p align="center"><strong>Your wearable data, archived locally before Google drops it — and checked against your own baseline.</strong></p>

<p align="center">
  <a href="https://github.com/mstuart/vitals/actions/workflows/ci.yml"><img src="https://github.com/mstuart/vitals/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933.svg" alt="Node 22+">
  <img src="https://img.shields.io/badge/MCP-server-8b5cf6.svg" alt="MCP server">
  <a href="https://deepwiki.com/mstuart/vitals"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
  <a href="https://socket.dev/npm/package/@mstuart/vitals"><img src="https://socket.dev/api/badge/npm/package/@mstuart/vitals" alt="Socket"></a>
</p>

<p align="center">
  <a href="#why">Why</a> ·
  <a href="#install">Install</a> ·
  <a href="#connect">Connect</a> ·
  <a href="#commands">Commands</a> ·
  <a href="#running-it-daily">Scheduling</a> ·
  <a href="#what-it-flags">What it flags</a> ·
  <a href="#mcp">MCP</a>
</p>

---

A local-first CLI and MCP server that archives your Google Health API data
(Fitbit, Pixel Watch) into SQLite and tells you when you have drifted off your
own baseline.

```
$ vitals
RHR 71 ↑  HRV 20ms ↓  Sleep 7.1h 99%eff  SpO2 96.6%
⚠ temp +1.1C vs baseline (2 nights)
```

## Why

Google does not keep your fine-grained data. Measured against the live API,
continuous SpO2 is retained for roughly **12 days** and sleep-stage detail for
roughly **13 nights**. Anything you do not pull inside that window is gone.

`vitals` pulls on a schedule, stores everything locally, and keeps it. The
archive is the point; the reports are what you do with it.

## Install

Requires **Node 22+**.

```bash
git clone https://github.com/mstuart/vitals.git
cd vitals
npm install
npm run build
npm link          # optional, puts `vitals` on your PATH
```

## Connect

The Health API grants access per application, so you need your own OAuth
client. There is deliberately no client id bundled here — one shared by every
user of the tool could be revoked for everyone at once.

1. Create a project at <https://console.cloud.google.com/>
2. Enable the **Health API** for it
3. Create an **OAuth 2.0 Client ID** of type *Desktop app*
4. Connect:

```bash
vitals auth --client-id <id> --client-secret <secret>
# or set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
```

This opens a browser, runs the consent flow on a loopback port, and writes a
refresh token to `~/.local/share/vitals/credentials.json` (mode 0600). Seven
read-only scopes are requested; `vitals` never writes to your Google account.

Then:

```bash
vitals pull --since 30d
```

## Commands

| Command | Purpose |
|---|---|
| `vitals` | Today versus your baseline. The daily driver. |
| `vitals --quiet` | Alerts only. Silent when clear, exit 1 when flags fire. Built for cron. |
| `vitals pull [--since 30d] [--full]` | Ingest from the API. Incremental by default. |
| `vitals sleep [--days 14]` | Recent nights with stage breakdown. |
| `vitals heart [--days 14]` | Resting heart rate and HRV over time. |
| `vitals body [--days 30]` | Weight and body fat. |
| `vitals note --mood 6 [--tag x] "text"` | Record how you actually feel. |
| `vitals week` | Weekly report. |
| `vitals serve` | MCP server over stdio. |
| `vitals auth` | Connect a Google account. |

Every read command accepts `--json`.

## Running it daily

`vitals` is a plain command, so use your operating system's scheduler rather
than leaving a daemon running. There is deliberately no `vitals daemon`
subcommand: it would reimplement process supervision, restart-on-crash, and
boot persistence that the OS already provides.

`vitals --quiet` prints nothing while you are within your baselines, so a
scheduled job stays silent until something is worth reading.

### macOS (launchd)

Preferred over cron on a laptop: **launchd runs a missed job when the machine
wakes, cron does not.** A cron entry scheduled for 09:00 silently skips every
day the lid is shut, and the gaps appear in your archive with no error.

Save as `~/Library/LaunchAgents/com.mstuart.vitals-pull.plist`, changing the
label to your own reverse-DNS prefix and the paths to match your install:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.mstuart.vitals-pull</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/you/.local/share/vitals/daily-pull.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>9</integer>
        <key>Minute</key><integer>15</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/you/.local/share/vitals/logs/pull.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/you/.local/share/vitals/logs/pull.err.log</string>
</dict>
</plist>
```

Point it at a small wrapper rather than the binary directly, because **launchd
does not source your shell profile** — environment set in `~/.zshrc` is not
present, and a version-managed `node` will not be on `PATH`:

```sh
#!/bin/zsh
# ~/.local/share/vitals/daily-pull.sh
NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
[ -x "$NODE" ] || NODE="$(command -v node)"

echo "$(date -Iseconds) pull starting"

# launchd runs a missed job as soon as the machine wakes, often before the
# network is back, and every data type then fails with "fetch failed". Retrying
# with backoff stops a wake-up race costing a day of history. Sync is
# idempotent, so retrying after a partial success is free.
rc=1
for attempt in 1 2 3 4; do
	"$NODE" "$HOME/path/to/vitals/dist/cli/index.js" pull --since 7d
	rc=$?          # NOT `status` — that is a read-only special variable in zsh,
	               # and assigning to it makes the script exit non-zero on success
	[ $rc -eq 0 ] && break
	[ $attempt -lt 4 ] && sleep $((attempt * 60))
done

echo "$(date -Iseconds) pull finished with status $rc"
exit $rc
```

A 7-day window means a week away from the machine still backfills. Sync is
idempotent, so the overlap costs nothing.

```bash
chmod +x ~/.local/share/vitals/daily-pull.sh
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.mstuart.vitals-pull.plist

launchctl list | grep vitals                        # status; second column is last exit code
launchctl kickstart -p gui/$UID/com.mstuart.vitals-pull   # run now
tail -f ~/.local/share/vitals/logs/pull.log         # logs
launchctl bootout gui/$UID/com.mstuart.vitals-pull  # stop
```

Run it once with `kickstart` and check the exit code before trusting it.

### Linux (systemd)

`~/.config/systemd/user/vitals-pull.service`:

```ini
[Unit]
Description=vitals daily pull

[Service]
Type=oneshot
ExecStart=%h/.local/bin/vitals pull --since 7d
```

`~/.config/systemd/user/vitals-pull.timer`:

```ini
[Unit]
Description=vitals daily pull

[Timer]
OnCalendar=*-*-* 09:15:00
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` is the equivalent of launchd's catch-up behaviour — without
it, missed runs are skipped rather than run at next boot.

```bash
systemctl --user enable --now vitals-pull.timer
journalctl --user -u vitals-pull -f
```

### cron

Works, but skips missed runs entirely. Prefer the above where available.

```cron
15 9 * * *  vitals pull --since 7d && vitals --quiet
```

## What it flags

Thresholds are taken from published research rather than chosen by feel. Each
flag names its basis.

| Signal | Red | Basis |
|---|---|---|
| Resting heart rate | > +3 bpm vs baseline | Li et al. 2020 (Stanford): precedes symptom onset 24–48h, ~80% sensitivity |
| HRV | > 20% below baseline | HRV4Training red-day protocol; WHOOP recovery model |
| Skin temperature | > +1.0 °C vs 30-day baseline | Oura illness prediction, ~80% sensitivity |
| Respiratory rate | > +2 breaths/min, 2 nights running | Visible Health flare prediction |

A single marker runs 60–70% sensitivity; two or more agreeing reach 80–90%, so
multi-marker agreement is reported explicitly. Skin temperature stays
suppressed until 30 days of local history exist, because the API returns `NaN`
for its baseline before then.

**This is not a medical device.** It reports deviations from your own history.
It does not diagnose anything. Talk to a doctor, not a CLI.

## MCP

`vitals serve` exposes the archive over the Model Context Protocol:
`vitals_today`, `vitals_sleep`, `vitals_heart`, `vitals_body`,
`vitals_weekly_report`, `vitals_log_checkin`, `vitals_coverage`.

`vitals_coverage` matters more than it looks — it reports the date range the
archive actually holds, so an assistant can tell "no data" apart from "zero".

```json
{
  "mcpServers": {
    "vitals": { "command": "vitals", "args": ["serve"] }
  }
}
```

## Data

Everything is local. Nothing is uploaded anywhere.

| Path | Contents |
|---|---|
| `~/.local/share/vitals/vitals.db` | The archive |
| `~/.local/share/vitals/credentials.json` | OAuth refresh token, mode 0600 |
| `~/.local/share/vitals/token.json` | Cached access tokens |

Honours `XDG_DATA_HOME`. Override individually with `VITALS_DATA_DIR`,
`VITALS_DB`, and `VITALS_GOOGLE_TOKEN`.

`VITALS_GOOGLE_TOKEN` points at a credential file owned by another tool, to
reuse a refresh token you already have. `vitals` reads that file and never
writes to it — the owning tool may refresh the same credential concurrently.

## Development

```bash
npm test
npm run typecheck
```

Tests never touch the network. They run against synthetic fixtures in
`test/fixtures/api/`, which preserve the real API's structure — including the
fields it returns as strings rather than numbers — with fabricated values.

To regenerate them from your own account:

```bash
node scripts/record-fixtures.mjs   # -> test/fixtures/private/ (gitignored, real data)
node scripts/make-fixtures.mjs     # -> test/fixtures/api/ (synthetic, committed)
```

Recorded output is real medical data. It stays gitignored and is never
committed.

### Notes from the API

Worth knowing before changing the sync layer:

- `heart-rate` and `heart-rate-variability` **reject** AIP-160 date filters with
  HTTP 400. They must be paged unfiltered and stopped early.
- Raw `heart-rate` samples at about 1 Hz, so a page spans roughly 48 minutes.
  It is aggregated into hourly buckets at ingest; raw points are never stored.
- `sleep` and `exercise` cap at 25 records per page. Everything else defaults
  to 1440.
- SpO2 readings of exactly `50.0%` are artifacts from the band losing skin
  contact, filtered at ingest.
- `better-sqlite3` must be **v13 or newer**. On v11 the process intermittently
  aborts at teardown on Node 24.

## License

MIT
