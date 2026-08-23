// Groups differently-worded league names from our two sources into one
// canonical name — e.g. SportsDB's "English Premier League" and
// wheresthematch's "Premier League" are the same competition but never
// string-match, so without this every dashboard/CSV view treats them as two
// separate leagues.
//
// Seed aliases cover the common country-prefixed vs short-form pairs we've
// actually seen from these two sources. Anything not in the seed table (or
// a manual override) just passes through unchanged — grouping only ever
// merges known duplicates, it never invents a new name.
//
// Manual overrides (set via the /leagues admin page) always win over the
// seed table and persist to data/league-canon.json.

const fs = require('fs');
const path = require('path');

const OVERRIDES_PATH = path.join(__dirname, '..', 'data', 'league-canon.json');

const SEED_ALIASES = {
  'english premier league': 'Premier League',
  'premier league': 'Premier League',
  'spanish la liga': 'La Liga',
  'la liga': 'La Liga',
  'italian serie a': 'Serie A',
  'serie a': 'Serie A',
  'german bundesliga': 'Bundesliga',
  bundesliga: 'Bundesliga',
  'french ligue 1': 'Ligue 1',
  'ligue 1': 'Ligue 1',
  'uefa champions league': 'Champions League',
  'champions league': 'Champions League',
  'uefa europa league': 'Europa League',
  'europa league': 'Europa League',
  'uefa europa conference league': 'Conference League',
  'europa conference league': 'Conference League',
  'conference league': 'Conference League',
};

function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveOverrides(overrides) {
  fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
  fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(overrides, null, 2));
}

let _overrides = loadOverrides();

function normalize(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve a raw league name to its canonical group name. Manual override
 * wins, then the seed table, then the raw name unchanged (trimmed).
 */
function canonicalLeague(rawName) {
  if (!rawName) return rawName || '';
  const key = normalize(rawName);
  if (_overrides[key]) return _overrides[key];
  if (SEED_ALIASES[key]) return SEED_ALIASES[key];
  return rawName.trim();
}

function setLeagueAlias(rawName, canonicalName) {
  const key = normalize(rawName);
  if (!key || !canonicalName || !canonicalName.trim()) return;
  _overrides[key] = canonicalName.trim();
  saveOverrides(_overrides);
}

function getOverrides() {
  return _overrides;
}

module.exports = { canonicalLeague, setLeagueAlias, getOverrides, normalize };
