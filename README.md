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
  `Source1`..`Source10` are this app's own `/go?u=...` redirect links, not
  the raw CDN URLs — many of those carry a per-session token that can
  expire between when it was matched and when someone actually opens it,
  so `/go` re-resolves the real destination live, at click time, and 302s
  there. `Source1Resolved`..`Source10Resolved` still show what the last
  periodic check saw, as an audit trail.
- ✅ Checks whether each source URL is genuinely usable, via a manual "Check
  sources" job on the dashboard (`src/sourceChecks.js`). Classifies into
  four states: **ok** (HTML page, iframe-ready), **stream** (HLS/DASH
  manifest, reachable + CORS-open — for HLS, its first actual video segment
  is fetched and verified too, not just the master playlist — but needs a
  `<video>` player like hls.js, not a bare iframe), **blocked**, **dead**.
  Results persist to `data/source-checks.json` and show as a colored dot per
  source on `/browse`.
- ✅ Captures what each source actually shows in a headless browser
  (`src/screenshots.js`) — a still JPEG, plus (video sources only) a short
  animated GIF of a few seconds of real playback, since a still can be a
  stale frame someone already scrolled past. Both persist to
  `data/screenshots/`, indexed in `data/screenshots.json`, and are exposed
  alongside each source as `sourceScreenshot`/`sourceGif` in
  fixtures.json and `Source1Screenshot`/`Source1Gif`..`Source10Screenshot`/
  `Source10Gif` in fixtures.csv. Runs on every 3rd scheduled source check,
  with sources missing a good image retried on every check in between.
  The capture browser runs with web security **on** and loads the player
  from an https origin, so CORS and mixed content (an `http://` stream on
  an https site) block a capture exactly as they block a visitor — a
  capture only succeeds for what a normal browser can play. (Until
  2026-10-18 it ran with `--disable-web-security`, which let streams no
  visitor could play pass.) It still runs from Railway's US datacenter, so
  it can't see geo-blocking — see `sourceGeo` below.
- ✅ Source probes send an `Origin` header like a browser player does (some
  CDNs, e.g. CloudFront, only return `Access-Control-Allow-Origin` when
  asked), and a 403 to the ranged probe is retried once as a plain,
  size-capped GET before the source counts as dead/unauthorized (some
  hosts, e.g. cdn.stmify.com, refuse `Range`).
- ✅ Speed test: at most every 30 min per source (and on every forced
  check), one whole media segment is downloaded (capped at 8 MB / 20 s) and
  timed against its own `#EXTINF` duration. If it takes longer than 0.8x
  the segment's length it can never play, only buffer, so the source is
  marked **too slow**: `working: false` (the sites hide it via
  `sourceWorking`), rank **low**, its own row on `/source-report`. The
  ratio is exported as `sourceSpeedRatio`. **Caveat:** this runs from
  Railway's US datacenter. Slow from there is slow for everyone, but fast
  from there does not prove fast for a visitor in China.
- ✅ `/go` accepts source URLs handed out in the last 48 h, not only the
  ones in the current rows, and follows doms9 token swaps to the URL that
  replaced them (`src/sourceHistory.js`, persisted in
  `data/source-history.json`). Cached feeds and pages left open no longer
  get "Unknown source URL" after a token swap; URLs this app never handed
  out still do (no open redirect). doms9 URLs stay off the relay even
  after they leave the current playlist.
- ✅ Flags sources on known US-only CDNs (`GEO_FENCED_HOSTS` in
  `src/config.js` — Turner's `turnerlive.warnermediacdn.com`, amagi's
  `*.playout.now3.amagi.tv`, `univisionnow.com`, `streamer1.nexgen.bz`,
  `dai.google.com`) as `sourceGeo: "us-only"`
  in fixtures.json and `Source1Geo`..`Source10Geo` in fixtures.csv
  (null/blank otherwise). Based on the host the source resolves to; a hint
  for the WordPress sites, not a rank change.
- ✅ `sourceWorking` (what the WordPress plugins hide sources by) is the
  **visitor** verdict, not just "the stream answered": each stream is also
  played through this app's own `/go` link, the way a visitor's button
  plays it — through the relay, or straight to the source for doms9
  channels (`sourceVisitorPath`: `relay` / `direct`). It's false when the
  stream is broken, fails along that path (e.g. inside the relay), is DASH
  (the plugins' player is hls.js only), or `/go` sends visitors straight
  to a US-only CDN — the check runs in the US, so such a stream looks fine
  from here but not from China (`src/sourceChecks.js` `visitorPlayable`).
- ✅ Ranks every source into one word (`sourceChecks.rankFor`) — **working**
  (real still + real gif, AND the latest check agrees a visitor's browser
  can play it: for a manifest, a real segment was fetched and every hop is
  CORS-open; for an HTML page, status ok), **medium** (reachable, but no
  good capture yet, or the check doesn't back the capture up — e.g. no
  CORS on a hop), **unauthorized** (confirmed 401/403 — an access gate to
  fix, kept separate from dead links on purpose), **low** (confirmed dead
  across several checks in a row, not just one bad probe), **unverified**
  (not enough data yet). A single failed check never demotes a source by
  itself — only `FLAG_AFTER_FAILURES` (3) dead results in a row count as
  actually broken. Shown as a badge on `/browse` and as `sourceRank` /
  `Source1Rank`..`Source10Rank` in the exports.
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
  endpoint and recorded on `/youtube-channels` (approve/reject buttons there
  are informational only — nothing gates on them, every discovered YouTube
  link is included in `live.csv`/`live.json` as soon as it's found). Non-
  YouTube stream links are counted (`type: 'other'`) but never
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
6. **Attach a volume** (service → **Settings → Volumes → Add volume**, any
   mount path, e.g. `/data`). Without one, Railway's disk is wiped on every
   redeploy, taking users, Settings overrides, source-check history,
   screenshots, translations and manual channels/league names with it.
   Railway sets `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached and
   the app picks it up automatically — no extra variable needed.
   `GET /health` reports `persistentData: true` once it's in use, and the
   boot log prints the data dir it's using.

### Persistent data

Every file the app stores lives in one data dir, resolved as:
`DATA_DIR` (explicit override) → `RAILWAY_VOLUME_MOUNT_PATH` (Railway
volume) → `./data` (local default; ephemeral on Railway). Paths shown as
`data/...` elsewhere in this README are relative to that dir.

With a volume, two things behave differently from the old wipe-every-deploy
setup:

- **`ADMIN_USERNAME`/`ADMIN_PASSWORD` only seed the first admin**, on the
  very first boot. After that `users.json` on the volume is authoritative,
  so changing those env vars no longer resets the login. Locked out? Delete
  `users.json` from the volume and restart to reseed from the env vars.
- **Settings page overrides persist.** Only fields changed to something
  other than their env var value are stored (in `config.json`); a field
  left at — or set back to — its env value keeps following the env var.

## Endpoints

Two roles: **admin** (full access) and **viewer** (read-only, `/browse`
only). Manage accounts on `/users`.

| Route            | Description                                    |
|-------------------|-------------------------------------------------|
| `GET /health`      | Liveness check, plus the Relay service's `{ ok, ffmpeg }` |
| `GET /api/relay/stream?url=` | HLS proxy through the Relay service — playlists rewritten so every URI points back here; never exposes the relay host or secret. Known, non-excluded sources only (viewer) |
| `GET /api/relay/thumb?url=` | 320x180 JPEG thumbnail via the relay, SVG placeholder on any failure (viewer) |
| `GET /player?url=` | hls.js player for a source, streaming through /api/relay/stream (viewer) |
| `GET /`             | Admin dashboard (admin only)          |
| `GET /browse`       | Every fixture with per-source status dots, Chinese names, timezone toggle, full-text filter (admin or viewer) |
| `GET /leagues`      | Set canonical league-name groupings (admin only) |
| `GET /translations` | Set manual Simplified Chinese overrides (admin only) |
| `GET /live`          | Currently-live games from the live-streaming source, refreshed on demand (admin only) |
| `GET /youtube-channels` | YouTube channels the live-streaming source has surfaced, with informational approve/reject labels — doesn't gate what's exported (admin only) |
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
| `GET /go?u=<url>`   | Live redirect to a source URL's current destination — what `Source1`..`Source10` actually link to; `u` must be a source this app currently knows about |

### Claude connector

The hub can be run from a Claude chat (claude.ai, the desktop and mobile apps): "which sites are
outdated?", "set up example.com with football and basketball".

- In Claude: Settings → Connectors → Add custom connector, and paste `https://<this app>/mcp` (the
  address is on `/sites` → Settings → Claude connector). The browser asks for the dashboard's
  admin login, then shows an approval page: click Approve.
- Tools: `list_sites` and `site_status` (read), `add_site` (checks a WordPress site and answers
  with the link where an admin connects it - the connection itself is still approved in the
  site's WordPress), `update_plugins` (asks outdated sites to update now) and `set_up_site` (the
  schedule plugin's set-up: look, homepage table, sport pages, menu).
- Not offered on purpose: removing a site, uninstalling the plugin, destinations and rotation,
  keys and tokens - those stay on the `/sites` page.
- It acts as the admin who approved; `/sites` → Settings lists the connections and disconnects
  them, and an account that stops being an admin loses its connection at once. State is
  `claude-connector.json` in the data dir (tokens as SHA-256 only), so it needs the Railway
  volume to survive a redeploy; without one, connect again after each deploy.
- Claude Code can use the API token instead of the sign-in:
  `claude mcp add --transport http iss-hub https://<this app>/mcp --header "Authorization: Bearer <API token>"`

`src/mcpConnector.js` is the server (MCP over Streamable HTTP with OAuth sign-in; only Claude's
callback addresses can register; the same file as ABS3's `lib/mcpConnector.js`) and
`src/hubMcp.js` the tools. Sites are usually added from ABS3's own connector instead
(`add site … zhibo882`), which installs the plugin, connects the site here and writes its content.

### Hub API for scripts and ABS3

`/sites` (the WordPress-sites hub) also has a token API: `Authorization: Bearer <API token>`
(WordPress sites → Settings → API token). `npm run hub` uses it to publish plugins and update
sites; ABS3 uses it to make a WordPress site a schedule or player site of the network without
anyone copying keys around (ABS3 then writes the site's pages and posts under the plugin's table
and never removes the table; such a site shows an **ABS3** pill on `/sites`).

| Route | Description |
|---|---|
| `GET /api/hub/state` | Every site (role, plugin version, latest published version, last check-in, `managedBy`), the releases and the destinations |
| `GET /api/hub/site/<host>` | One site with its details (theme, sport pages, bridge version), where its matches open, and its last 10 commands with their status and log |
| `POST /api/hub/package-link` `{ plugin }` | A download link for the published zip of that plugin that carries no network key and works for 15 minutes — for the site's ABS3 bridge to install from (`/api/hub/package?ticket=…`) |
| `POST /api/hub/connect` `{ site, plugin?, user, password, source?, destination?, setup? }` | Connects a site that already runs the plugin, like "Add a site": the given WordPress Application Password (an administrator's, made for this and deleted here afterwards) is used once to hand the plugin the hub URL and network key; `source: "abs3"` marks the site; `destination: true` adds a player site to the destinations; `setup: { brand, theme, homepage, menu, sports }` queues the schedule plugin's set-up and pokes the site |
| `POST /api/hub/setup` `{ site, setup }` | Queues the set-up on a connected schedule site and pokes it; answers with the command id to follow on `/api/hub/site/<host>` |
| `POST /api/hub/update` `{ site?, plugin? }` | Asks outdated sites to install the published plugin now |
| `PUT /api/hub/release?notes=` (zip body) | Publishes a plugin zip (`npm run hub -- publish`) |

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
