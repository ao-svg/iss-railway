# ISS Fixture Pipeline (Railway)

Node/Express service that replaces the WordPress-plugin fixture logic with a
standalone pipeline you can deploy on Railway and pull CSV/JSON from.

**What it does — and what it deliberately does NOT do:**

- ✅ Pulls fixtures from **TheSportsDB** (`eventsnextleague.php`), same league
  IDs as the original plugin (`SPORTSDB_LEAGUE_IDS` in `.env`). Note: the free
  key only returns 1 upcoming fixture per league — see rate-limit notes below.
- ✅ Scrapes **wheresthematch.com**'s public live-sport-on-tv schedule
  (`src/wheresthematch.js`) as a second, richer source — full multi-sport
  schedule for the next `WTM_DAYS` days, not capped like the free SportsDB key.
  Ported from the team's old Google Apps Script pipeline's `scrapeWheresMatch()`.
- ✅ Looks up official TV broadcaster listings for both sources (`lookuptv.php`
  for SportsDB fixtures, scraped broadcaster names for wheresthematch ones)
  and matches those channel names against the **public iptv-org** playlist
  (`https://iptv-org.github.io/iptv/index.m3u`) — a community-maintained,
  self-reported index of free-to-air / publicly broadcast channels.
- ✅ Writes the result to `data/fixtures.csv` and serves it at `/fixtures.csv`
  and `/fixtures.json`. Each row has a `source` field (`sportsdb` or
  `wheresthematch`), and each channel can carry **up to 10 candidate source
  URLs** (`Source1`..`Source10` in the CSV) — a channel isn't matched 1:1 to
  a single stream, since iptv-org sometimes carries several mirrors.
- ✅ Checks whether each source URL is genuinely usable, via a manual "Check
  sources" job on the dashboard (`src/sourceChecks.js`). Classifies into
  four states: **ok** (HTML page, iframe-ready), **stream** (HLS/DASH
  manifest, reachable + CORS-open — for HLS, its first actual video segment
  is fetched and verified too, not just the master playlist — but needs a
  `<video>` player like hls.js, not a bare iframe), **blocked**, **dead**.
  Results persist to `data/source-checks.json` and show as a colored dot per
  source on `/browse`.
- ✅ Groups differently-worded league names from the two sources into one
  canonical name (`src/leagues.js` — e.g. SportsDB's "English Premier
  League" and wheresthematch's "Premier League" both resolve to "Premier
  League"). Manual overrides on `/leagues` always win over the seed table.
- ✅ Translates league/team names to Simplified Chinese (`src/translate.js`),
  via a manual "Translate names" job on the dashboard. Uses the free,
  unofficial `translate.googleapis.com` endpoint (no API key/billing setup
  needed — swappable for the official Cloud Translation API later without
  changing the cache/override interface). Results persist to
  `data/translations.json`; manual overrides on `/translations` always win
  and are never touched by re-translation. **Known limitation:** this free
  endpoint rate-limits fairly aggressively under sustained use (hundreds of
  names in one run) — the client retries with backoff and stops early rather
  than hammering a wall, but a large first run may need to be re-triggered
  a few times as the limit clears. If this proves too unreliable in
  practice, swap in the paid API.
- ✅ Date/time defaults to Beijing time everywhere (matching the reference
  sheet), with a Beijing/Jerusalem toggle on `/browse` (`?tz=jerusalem`) for
  viewing — `fixtures.csv`/`fixtures.json` are always Beijing time
  regardless of that toggle, since exports need one consistent timezone.
- ✅ Optionally pulls "what's live right now" from a live-sports-streaming
  aggregator (`src/liveTv.js`, disabled unless `LIVETV_DOMAIN` is set — see
  below), but **only the discovery part** of that site's mechanism: which
  games are live, and which of their stream links are YouTube videos. Each
  YouTube video's channel is looked up via YouTube's own public oEmbed
  endpoint and must be manually approved on `/youtube-channels` before it
  counts as usable anywhere — oEmbed confirms who uploaded a video, never
  whether they're authorized to broadcast the content, so that call is a
  human one, once per channel (approving covers all future videos from it
  too). Non-YouTube stream links are counted (`type: 'other'`) but never
  resolved to an actual URL — the original mechanism for that (fetch a
  webplayer wrapper page, scrape whatever third-party CDN iframe it embeds)
  is the exact pirate-mirror-resolution pattern described below, and this
  port doesn't do it regardless of source.
- ❌ Does **not** include the original plugin's aggregator web-scraper
  (Sportsurge/StreamEast link extraction), the old Apps Script pipeline's
  `channels`-sheet mapping to pirate-mirror stream URLs (tv-shihab.xyz,
  freestreams-live1c.pk, dlhd.st, thedaddy.dad, acestream links, etc.), or
  its `scraper_ltv.js` aggregator's own webplayer→third-party-CDN
  resolution step. Those scraped/linked unauthorized copies of copyrighted
  live broadcasts and were intentionally left out of this port — only the
  legitimate schedule/broadcaster-name scraping (and, for `liveTv.js`, the
  channel-verification-gated YouTube subset) was ported.

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

Two roles: **admin** (full access) and **viewer** (read-only, `/browse`
only). Manage accounts on `/users`.

| Route            | Description                                    |
|-------------------|-------------------------------------------------|
| `GET /health`      | Liveness check                                 |
| `GET /`             | Admin dashboard (admin only)          |
| `GET /browse`       | Every fixture with per-source status dots, Chinese names, timezone toggle, full-text filter (admin or viewer) |
| `GET /leagues`      | Set canonical league-name groupings (admin only) |
| `GET /translations` | Set manual Simplified Chinese overrides (admin only) |
| `GET /live`          | Currently-live games from the live-streaming source, refreshed on demand (admin only) |
| `GET /youtube-channels` | Approve/reject YouTube channels the live-streaming source has surfaced (admin only) |
| `GET /users`        | Manage accounts: add/edit/delete admin and viewer logins (admin only) |
| `POST /api/check-sources` | Kicks off the reachability/iframe check job in the background (admin only) |
| `POST /api/translate-names` | Kicks off the translation job in the background (admin only) |
| `POST /api/fetch-live` | Kicks off the live-streaming fetch job in the background (admin only) |
| `POST /api/users`   | Add an account or replace an existing one's password/role (admin only) |
| `POST /api/users/delete` | Remove an account, blocked if it's the last remaining admin (admin only) |
| `GET /fixtures.csv`| Latest fixtures + matched channels, as CSV     |
| `GET /fixtures.json` | Same data as JSON                            |
| `GET /live.csv`     | Currently-live rows, same CSV format as fixtures.csv |
| `GET /live.json`    | Same data as JSON                              |

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

The free key (`123`) is shared and rate-limited. `lookuptv.php` is called once
**per fixture**, so with the default 12 leagues + full TV lookups you may
want to either request a paid key or lower `PIPELINE_CRON` frequency
(default: every 6 hours, matching TheSportsDB's own "fetch once daily"
guidance from the original plugin fairly closely).
