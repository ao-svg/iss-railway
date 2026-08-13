// Runtime config: env vars are the baseline, data/config.json (written by the
// Settings page) overrides them for the lifetime of the running container.
// Note: this file lives on Railway's ephemeral disk, so a redeploy resets
// overrides back to whatever's in the env vars — env vars stay the source of
// truth for anything you want to survive a redeploy.

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');

function envDefaults() {
  return {
    apiKey: process.env.SPORTSDB_API_KEY || '123',
    leagueIds: (process.env.SPORTSDB_LEAGUE_IDS || '4790')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    playlistUrl: process.env.IPTV_ORG_PLAYLIST_URL || 'https://iptv-org.github.io/iptv/index.m3u',
    cronExpr: process.env.PIPELINE_CRON || '0 */6 * * *',
    outputCsvPath: process.env.OUTPUT_CSV_PATH || './data/fixtures.csv',
    wtmDays: Number(process.env.WTM_DAYS) || 31,
  };
}

function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

let current = { ...envDefaults(), ...loadOverrides() };

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
  if (normalized.wtmDays !== undefined) {
    normalized.wtmDays = Number(normalized.wtmDays) || current.wtmDays;
  }
  current = { ...current, ...normalized };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2));
  return current;
}

module.exports = { getConfig, updateConfig };
