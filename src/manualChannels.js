// Manual stream URLs for channel names that no playlist matches — admin-
// entered via the /manual-channels page. Keyed by channel NAME (the
// broadcaster the sources already report, e.g. "WST Play"), so one entry
// applies to every game that lists that channel, now and in future runs.
// Effectively a hand-maintained playlist layered on top of iptv-org/doms9.

const fs = require('fs');
const path = require('path');

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

function channelKey(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function addManualChannel(name, url) {
  const key = channelKey(name);
  const cleanUrl = (url || '').trim();
  if (!key || !cleanUrl) return;
  if (!_store[key]) _store[key] = { name: name.trim(), urls: [] };
  if (!_store[key].urls.includes(cleanUrl)) _store[key].urls.push(cleanUrl);
  _store[key].updatedAt = new Date().toISOString();
  saveStore(_store);
}

function removeManualChannel(name, index) {
  const key = channelKey(name);
  const entry = _store[key];
  if (!entry || entry.urls[index] === undefined) return;
  entry.urls.splice(index, 1);
  if (!entry.urls.length) delete _store[key];
  saveStore(_store);
}

function getAll() {
  return _store;
}

/**
 * Merge manual URLs into every channel whose name has an entry. Pure, no
 * I/O — takes the store as plain data so it's directly testable. Returns
 * NEW row objects (never mutates `rows`).
 *
 * Each channel remembers which of its URLs came from here (`manualUrls`),
 * so on every apply those are stripped first and the current store's URLs
 * re-added at the front — manual streams are curated by a person, so they
 * outrank playlist matches. Idempotent by construction: add/remove both
 * just re-run this, and a removed entry simply stops being re-added.
 */
function applyManualChannels(rows, store) {
  return rows.map((row) => ({
    ...row,
    channels: (row.channels || []).map((ch) => {
      const previousManual = ch.manualUrls || [];
      const auto = (ch.sources || []).filter((u) => !previousManual.includes(u));
      const entry = store[channelKey(ch.name)];
      // Copy, never alias: removeManualChannel splices the store's array in
      // place, which would silently empty every channel's marker too and
      // leave the removed URL behind in `sources` on the next apply.
      const manualUrls = entry ? [...entry.urls] : [];
      const { manualUrls: _drop, ...rest } = ch;
      const merged = { ...rest, sources: [...manualUrls, ...auto.filter((u) => !manualUrls.includes(u))] };
      if (manualUrls.length) merged.manualUrls = manualUrls;
      return merged;
    }),
  }));
}

module.exports = { channelKey, addManualChannel, removeManualChannel, getAll, applyManualChannels };
