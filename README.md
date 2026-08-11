# ISS Fixture Pipeline (Railway)

Node/Express service that replaces the WordPress-plugin fixture logic with a
standalone pipeline you can deploy on Railway and pull CSV/JSON from.

**What it does — and what it deliberately does NOT do:**

- ✅ Pulls fixtures from **TheSportsDB** (`eventsnextleague.php`), same league
  IDs as the original plugin (`SPORTSDB_LEAGUE_IDS` in `.env`).
- ✅ Looks up official TV broadcaster listings per fixture (`lookuptv.php`)
  and matches those channel names against the **public iptv-org** playlist
  (`https://iptv-org.github.io/iptv/index.m3u`) — a community-maintained,
  self-reported index of free-to-air / publicly broadcast channels.
- ✅ Writes the result to `data/fixtures.csv` and serves it at `/fixtures.csv`
  and `/fixtures.json`.
- ❌ Does **not** include the original plugin's aggregator web-scraper
  (Sportsurge/StreamEast link extraction) or the URL-token/anti-indexing
  layer. That module scraped unauthorized copies of copyrighted live
  broadcasts and was intentionally left out of this port.

## Local dev

```bash
npm install
cp .env.example .env
npm run run-once     # single pipeline run, writes data/fixtures.csv, exits
npm start             # runs once at boot, then on the PIPELINE_CRON schedule, serves HTTP
```

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. In Railway: **New Project → Deploy from GitHub repo**, pick the repo.
3. Railway auto-detects Node via Nixpacks and reads `railway.json`.
4. Set the environment variables from `.env.example` under **Variables**.
5. Deploy. Railway assigns a public URL — CSV is at `<url>/fixtures.csv`.

## Endpoints

| Route            | Description                                    |
|-------------------|-------------------------------------------------|
| `GET /health`      | Liveness check                                 |
| `GET /fixtures.csv`| Latest fixtures + matched channels, as CSV     |
| `GET /fixtures.json` | Same data as JSON                            |

## Pulling into your Google Sheet

Sheets can import the CSV directly:

```
=IMPORTDATA("https://<your-railway-app>.up.railway.app/fixtures.csv")
```

Or, since your existing pipeline already writes to a `Source_*` sheet
convention, you could instead add a small `UrlFetchApp.fetch(...)` call in
Apps Script to pull `/fixtures.json` and map fields into a `Source_SDB` tab,
following the same Source → Feed → Final → Master pattern as your other two
scrapers.

## Notes on TheSportsDB rate limits

The free key (`1`) is shared and rate-limited. `lookuptv.php` is called once
**per fixture**, so with the default 12 leagues + full TV lookups you may
want to either request a paid key or lower `PIPELINE_CRON` frequency
(default: every 6 hours, matching TheSportsDB's own "fetch once daily"
guidance from the original plugin fairly closely).
