// Tracks live/ended status for src/liveTv.js across repeated fetches.
// fetchLiveStreams() only ever returns "what's live right now" — nothing on
// its own remembers that a game seen live in a previous fetch might have
// ended since. This module diffs each fresh fetch against what was known
// before and persists the result (same loadStore/saveStore pattern as
// sourceChecks.js/translate.js/leagues.js/youtubeChannels.js).

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, '..', 'data', 'live-store.json');
const ENDED_RETENTION_MS = 3 * 60 * 60 * 1000; // 3h after ending, tunable

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

/**
 * Pure diff/merge — no I/O, clock injectable, independently testable.
 *
 * - eventId present in freshRows -> status 'live', lastSeenAt=now,
 *   firstSeenAt preserved if previously known, endedAt reset to null
 *   (covers a game flapping live -> ended -> live again).
 * - eventId previously 'live' but missing from freshRows -> only
 *   transitions to 'ended' if THIS game's sport was successfully
 *   re-scraped this round (successfulSports). If that sport's own fetch
 *   failed (network blip, timeout), we have no confirmed information that
 *   the game actually ended — it just wasn't looked at — so it's carried
 *   forward unchanged rather than falsely marked ended.
 * - already 'ended' entries are pruned once ENDED_RETENTION_MS has passed
 *   since endedAt.
 */
function mergeLiveFetch(freshRows, prevStore, { now = new Date(), successfulSports } = {}) {
  const nowIso = now.toISOString();
  const nextStore = {};
  const seenIds = new Set();

  for (const row of freshRows) {
    seenIds.add(row.eventId);
    const prev = prevStore[row.eventId];
    nextStore[row.eventId] = {
      ...row,
      channels: (row.channels || []).map((ch) => ({ ...ch })), // clone — never alias prevStore's objects
      status: 'live',
      firstSeenAt: prev ? prev.firstSeenAt : nowIso,
      lastSeenAt: nowIso,
      endedAt: null,
    };
  }

  for (const [eventId, prev] of Object.entries(prevStore)) {
    if (seenIds.has(eventId)) continue;

    if (prev.status === 'live') {
      if (successfulSports && successfulSports.has(prev.sportType)) {
        nextStore[eventId] = { ...prev, status: 'ended', endedAt: nowIso };
      } else {
        nextStore[eventId] = prev; // unconfirmed — carry forward as-is
      }
      continue;
    }

    const endedAt = prev.endedAt ? new Date(prev.endedAt).getTime() : 0;
    if (now.getTime() - endedAt <= ENDED_RETENTION_MS) nextStore[eventId] = prev;
    // else: pruned — dropped from both the returned rows and the persisted store
  }

  return { store: nextStore, rows: Object.values(nextStore) };
}

let _store = loadStore();

/**
 * Apply a fresh fetch to the persisted store, saving and returning the
 * merged, status-tagged rows.
 */
function applyFetch(freshRows, successfulSports, now = new Date()) {
  const { store, rows } = mergeLiveFetch(freshRows, _store, { now, successfulSports });
  _store = store;
  saveStore(_store);
  return rows;
}

module.exports = { mergeLiveFetch, applyFetch, ENDED_RETENTION_MS };
