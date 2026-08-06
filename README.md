# vitals

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

### Cron

`vitals --quiet` prints nothing when you are within your baselines, so silence
is good news and a cron entry stays quiet until something is worth reading.

```cron
0 8 * * *  vitals pull --since 3d && vitals --quiet
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
npm test          # 222 tests
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
