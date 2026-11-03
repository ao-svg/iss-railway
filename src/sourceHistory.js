// Source URLs this app handed out recently, and which URL replaced which.
//
// /go only redirects to sources this app matched itself (no open
// redirect), but "matched" used to mean "in state.lastRows right now" —
// and that set moves constantly: doms9 tokens are swapped every 20 min
// (index.js refreshDoms9Sources), live rows every 10 min, the pipeline
// re-matches every 6 h. The WordPress sites cache the feed (5 min, plus a
// last-good-copy fallback) and visitors keep pages open, so a button
// whose URL was valid minutes ago got /go's "Unknown source URL"
// (2026-11-03). Now /go also accepts any URL known within KNOWN_TTL_MS and
// follows recorded swaps to the URL that replaced it.
//
// Persisted to data/source-history.json so a redeploy doesn't empty it.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');

const HISTORY_PATH = dataPath('source-history.json');
const KNOWN_TTL_MS = 48 * 60 * 60 * 1000;
// lastSeen is only rewritten when it's older than this — the current set
// is re-noted on every source check (every 3 min), and the file doesn't
// need a write each time just to move a timestamp a few minutes.
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_SWAP_HOPS = 50;

function emptyHistory() {
  return { known: {}, swaps: {} };
}

function load() {
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
    return { known: h.known || {}, swaps: h.swaps || {} };
  } catch {
    return emptyHistory();
  }
}

let _history = load();

function save() {
  fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(_history));
}

/** Drop entries not seen within the TTL. Pure: returns a new history. */
function prune(history, now = Date.now(), ttl = KNOWN_TTL_MS) {
  const known = {};
  for (const [url, e] of Object.entries(history.known)) if (now - e.seen <= ttl) known[url] = e;
  const swaps = {};
  for (const [from, s] of Object.entries(history.swaps)) if (now - s.at <= ttl) swaps[from] = s;
  return { known, swaps };
}

/**
 * Note every URL currently handed out. `isExcluded(url)` (doms9 sources,
 * which must never go through the relay) is remembered per URL, because an
 * old doms9 URL is no longer in the current doms9 playlist and couldn't be
 * recognised as one later. Pure: returns { history, changed }.
 */
function noteUrls(history, urls, { now = Date.now(), isExcluded = () => false } = {}) {
  let changed = false;
  const known = { ...history.known };
  for (const url of urls) {
    const prev = known[url];
    const excluded = Boolean(isExcluded(url)) || Boolean(prev && prev.excluded);
    if (!prev || now - prev.seen > TOUCH_INTERVAL_MS || excluded !== Boolean(prev.excluded)) {
      known[url] = { seen: now, ...(excluded ? { excluded: true } : {}) };
      changed = true;
    }
  }
  return { history: changed ? { ...history, known } : history, changed };
}

/** Record that `from` was replaced by `to` (and both were handed out). Pure. */
function noteSwap(history, from, to, { now = Date.now() } = {}) {
  if (!from || !to || from === to) return history;
  const prev = history.known[from];
  const known = { ...history.known, [from]: { ...(prev || {}), seen: now } };
  if (!known[to]) known[to] = { seen: now, ...(prev && prev.excluded ? { excluded: true } : {}) };
  return { known, swaps: { ...history.swaps, [from]: { to, at: now } } };
}

/**
 * Which source URL a /go request for `url` should play, or null (never
 * known — refuse). Pure.
 *   - currently handed out                          -> itself
 *   - replaced (swaps followed to the newest one)   -> the newest replacement
 *                                                      that's current or still
 *                                                      known; else itself
 *   - known within the TTL, no replacement          -> itself
 */
function resolveKnown(history, url, current, { now = Date.now(), ttl = KNOWN_TTL_MS } = {}) {
  if (typeof url !== 'string' || !url) return null;
  const isKnown = (u) => current.has(u) || (history.known[u] && now - history.known[u].seen <= ttl);
  let best = isKnown(url) ? url : null;
  let cursor = url;
  const seen = new Set([url]);
  for (let i = 0; i < MAX_SWAP_HOPS; i++) {
    const swap = history.swaps[cursor];
    if (!swap || now - swap.at > ttl || seen.has(swap.to)) break;
    cursor = swap.to;
    seen.add(cursor);
    if (isKnown(cursor)) best = cursor;
    if (current.has(cursor)) return cursor;
  }
  return best;
}

function wasExcluded(history, url) {
  return Boolean(history.known[url] && history.known[url].excluded);
}

// --- stateful wrappers used by index.js / server.js ---

function rememberCurrent(urls, opts) {
  const { history, changed } = noteUrls(_history, urls, opts);
  if (!changed) return;
  _history = prune(history);
  save();
}

function rememberSwaps(pairs) {
  if (!pairs.length) return;
  for (const [from, to] of pairs) _history = noteSwap(_history, from, to);
  _history = prune(_history);
  save();
}

function resolve(url, current) {
  return resolveKnown(_history, url, current);
}

function isExcludedHistorically(url) {
  return wasExcluded(_history, url);
}

module.exports = {
  KNOWN_TTL_MS,
  prune,
  noteUrls,
  noteSwap,
  resolveKnown,
  wasExcluded,
  rememberCurrent,
  rememberSwaps,
  resolve,
  isExcludedHistorically,
};
