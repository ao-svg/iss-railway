// Manual stream additions for games with no matched channel at all —
// admin-entered via the /manual-channels page when a game has no working
// stream from any of the automated sources/playlists.
//
// Keyed by a stable "game key" (normalized team pair + date), not a row's
// eventId — eventId can pick a different winning source run-to-run (see
// matchMerge.js's pickPrimaryRow), which would silently orphan an entry
// keyed to a specific eventId that stops being the winner.

const fs = require('fs');
const path = require('path');
const { normalizeTeamName } = require('./matchMerge');

const STORE_PATH = path.join(__dirname, '..', 'data', 'manual-channels.json');

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

let _store = loadStore();

// Date-only (not exact kickoff time) so small time-reporting differences
// between runs/sources don't orphan an entry, while still distinguishing
// the same two teams playing on different dates.
function gameKey(row) {
  return `${normalizeTeamName(row.homeTeam)}|${normalizeTeamName(row.awayTeam)}|${(row.matchDateUTC || '').slice(0, 10)}`;
}

function addManualChannel(key, meta, name, url) {
  if (!key || !name || !name.trim() || !url || !url.trim()) return;
  if (!_store[key]) {
    _store[key] = {
      homeTeam: meta.homeTeam || '',
      awayTeam: meta.awayTeam || '',
      league: meta.league || '',
      matchDateUTC: meta.matchDateUTC || '',
      channels: [],
    };
  }
  _store[key].channels.push({ name: name.trim(), url: url.trim(), addedAt: new Date().toISOString() });
  saveStore(_store);
}

function removeManualChannel(key, index) {
  const entry = _store[key];
  if (!entry || !entry.channels[index]) return;
  entry.channels.splice(index, 1);
  if (!entry.channels.length) delete _store[key];
  saveStore(_store);
}

function getEntry(key) {
  return _store[key] || null;
}

function getAll() {
  return _store;
}

/**
 * Merge manually-added channels into `rows`. Pure, no I/O — takes the
 * store as plain data so it's directly testable with fixtures. Returns
 * NEW row objects (never mutates `rows`).
 *
 * For each row, any existing channel flagged `manual: true` is dropped
 * first, then the current store entry's channels are re-added — merging
 * into an existing same-named channel (e.g. one a real source reported
 * with an empty `sources` array) if present, otherwise appended as a new
 * channel. Idempotent by construction: add/edit/remove all funnel through
 * the same re-application, so calling this repeatedly with an unchanged
 * store is a no-op, and a removed entry simply stops being re-added.
 */
function applyManualChannels(rows, store) {
  return rows.map((row) => {
    const key = gameKey(row);
    const entry = store[key];
    const channels = (row.channels || []).filter((ch) => !ch.manual).map((ch) => ({ ...ch }));
    for (const m of entry ? entry.channels : []) {
      const existing = channels.find((ch) => ch.name.toLowerCase() === m.name.toLowerCase());
      if (existing) {
        existing.sources = existing.sources.includes(m.url) ? existing.sources : [m.url, ...existing.sources];
        existing.manual = true;
      } else {
        channels.push({ name: m.name, sources: [m.url], manual: true });
      }
    }
    return { ...row, channels };
  });
}

module.exports = { gameKey, addManualChannel, removeManualChannel, getEntry, getAll, applyManualChannels };
