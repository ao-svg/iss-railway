// Runtime config: env vars are the baseline, config.json in the data dir
// (written by the Settings page) overrides them. Only fields actually changed
// on the Settings page are stored there, so with a persistent volume (see
// dataDir.js) env var changes still take effect for everything else. Without
// a volume the file is wiped on redeploy and env vars are all that's left.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');

const CONFIG_PATH = dataPath('config.json');

function envDefaults() {
  return {
    apiKey: process.env.SPORTSDB_API_KEY || '123',
    leagueIds: (process.env.SPORTSDB_LEAGUE_IDS || '4790')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    playlistUrl: process.env.IPTV_ORG_PLAYLIST_URL || 'https://iptv-org.github.io/iptv/index.m3u',
    // Second playlist, matched alongside iptv-org and prioritized ahead of
    // it (see iptv.js's matchChannels) — same free-M3U-aggregator shape as
    // iptv-org, just a second list for more coverage per channel.
    doms9PlaylistUrl:
      process.env.DOMS9_PLAYLIST_URL || 'https://raw.githubusercontent.com/doms9/iptv/default/M3U8/TV.m3u8',
    cronExpr: process.env.PIPELINE_CRON || '0 */6 * * *',
    // Source checks get their own, much tighter schedule — stream URLs
    // rotate/die within hours, so waiting for the next pipeline run leaves
    // exports stale. Blank disables the schedule (checks then only run
    // after a pipeline run or from the dashboard button).
    sourceCheckCronExpr: process.env.SOURCE_CHECK_CRON ?? '*/3 * * * *',
    outputCsvPath: process.env.OUTPUT_CSV_PATH || dataPath('fixtures.csv'),
    // Prefix for links this app puts into its own exports (screenshot
    // URLs in fixtures.csv/json). Railway injects RAILWAY_PUBLIC_DOMAIN;
    // blank locally, so links come out relative.
    publicBaseUrl:
      process.env.PUBLIC_BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ''),
    wtmDays: Number(process.env.WTM_DAYS) || 31,
    // Empty by default — the "live streaming" feature (src/liveTv.js) is a
    // no-op until this is deliberately set, since the source domain rotates
    // and pointing it at the wrong/any domain is a real content-provenance
    // decision, not something to default to a hardcoded value for.
    liveTvDomain: process.env.LIVETV_DOMAIN || '',
    outputLiveCsvPath: process.env.OUTPUT_LIVE_CSV_PATH || dataPath('live.csv'),
    // "Big 5" US pro leagues by default — the rest of the site's ~16
    // league pages are mostly NCAA sub-variants, noisier/lower-value by
    // default, opt-in via Settings same as SPORTSDB_LEAGUE_IDS already works.
    livesportsontvLeagues: (process.env.LIVESPORTSONTV_LEAGUES || 'nfl,nba,mlb,nhl,mls')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

let overrides = loadOverrides();
let current = { ...envDefaults(), ...overrides };

function getConfig() {
  return current;
}

// patch: { apiKey?, leagueIds? (array or comma string), playlistUrl?, cronExpr? }
function updateConfig(patch) {
  const normalized = { ...patch };
  if (typeof normalized.leagueIds === 'string') {
    normalized.leagueIds = normalized.leagueIds
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof normalized.livesportsontvLeagues === 'string') {
    normalized.livesportsontvLeagues = normalized.livesportsontvLeagues
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (normalized.wtmDays !== undefined) {
    normalized.wtmDays = Number(normalized.wtmDays) || current.wtmDays;
  }
  // The Settings form posts every field, so only keep the ones that
  // actually differ from env — anything left at its env value keeps
  // following env on future deploys.
  const env = envDefaults();
  overrides = { ...overrides };
  for (const [key, value] of Object.entries(normalized)) {
    if (value === undefined) continue;
    if (JSON.stringify(value) === JSON.stringify(env[key])) delete overrides[key];
    else overrides[key] = value;
  }
  current = { ...env, ...overrides };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(overrides, null, 2));
  return current;
}

module.exports = { getConfig, updateConfig };
