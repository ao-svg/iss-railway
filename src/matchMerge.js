// Cross-source game deduplication/merge. SportsDB, wheresthematch, and
// livesportsontv never share an ID with each other, so the same real game
// reported by more than one source shows up as separate rows unless
// explicitly matched and merged — the whole point of tracking multiple TV
// guides is more channel coverage per game, not duplicate rows for the
// same game. Matched by normalized team names + a kickoff-time tolerance
// window (the only two things every source reports in a comparable way).
//
// Pure, no I/O — same split as liveTvStore.js's mergeLiveFetch, testable
// with plain fixtures.

const { parseMatchDate } = require('./csv');

const TIME_TOLERANCE_MS = 15 * 60 * 1000; // 15 minutes
// Richest metadata first: SportsDB is the only source with real team
// logos, wheresthematch has broader league/team-name conventions already
// relied on elsewhere (league grouping, translations), livesportsontv is
// newest/least depended-on. Channels are unioned from every matched row
// regardless of which one wins as the metadata source below.
const SOURCE_PRIORITY = ['sportsdb', 'wheresthematch', 'livesportsontv'];

const TEAM_SUFFIX_RE = /\s+(FC|AFC|CF|SC)$/i;

function normalizeTeamName(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(TEAM_SUFFIX_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamPairKey(row) {
  return `${normalizeTeamName(row.homeTeam)}|${normalizeTeamName(row.awayTeam)}`;
}

// Reuses csv.js's parseMatchDate rather than `new Date(matchDateUTC)`
// directly — a date-time string with no explicit timezone designator
// (SportsDB's format) is parsed as LOCAL time by the JS spec, not UTC, so
// two rows for the exact same real kickoff (one from SportsDB with no
// offset, one from wheresthematch/livesportsontv with an explicit one)
// would resolve to different instants on any server not itself running
// in UTC — silently breaking every SportsDB-vs-other-source merge.
function parseTime(matchDateUTC) {
  const d = parseMatchDate(matchDateUTC);
  return d ? d.getTime() : null;
}

// Union channels across every row in a matched cluster, deduped by name
// (case-insensitive) — first-seen casing wins. A channel name that
// appears in more than one source's row also gets its `sources` URL
// lists unioned, in case different sources' matching independently found
// different mirror URLs for the same channel.
function mergeChannels(clusterRows) {
  const byName = new Map();
  for (const r of clusterRows) {
    for (const ch of r.channels || []) {
      const key = (ch.name || '').toLowerCase();
      if (!byName.has(key)) byName.set(key, { name: ch.name, sources: new Set() });
      const entry = byName.get(key);
      for (const url of ch.sources || []) entry.sources.add(url);
    }
  }
  return [...byName.values()].map((c) => ({ name: c.name, sources: [...c.sources] }));
}

function pickPrimaryRow(clusterRows) {
  for (const src of SOURCE_PRIORITY) {
    const found = clusterRows.find((r) => r.source === src);
    if (found) return found;
  }
  return clusterRows[0];
}

/**
 * Merge rows across sources that represent the same real game.
 *
 * Groups by normalized (homeTeam, awayTeam) pair — exact order required,
 * not also checked swapped, since two teams can legitimately meet twice
 * in a season in opposite home/away order and wrongly merging those would
 * be worse than occasionally under-merging a genuine duplicate with
 * unusually different team-name spelling (team names are matched exact-
 * after-normalization, not fuzzy/edit-distance).
 *
 * Within each team-pair group, sorts by kickoff time and clusters rows
 * using a sliding tolerance window anchored to each cluster's FIRST
 * (earliest) row — not a fixed time-bucket grid, which would incorrectly
 * split same-game rows straddling a bucket boundary (e.g. 19:58 vs 20:02
 * with clock-aligned 15-min buckets), and not a chained previous-item
 * comparison either, which would let a same-game cluster's time drift
 * unboundedly across several close-but-not-identical reports.
 *
 * A row whose matchDateUTC doesn't parse is never merged with anything —
 * it becomes its own single-row cluster rather than guessing.
 */
function mergeRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = teamPairKey(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const merged = [];
  for (const groupRows of groups.values()) {
    const withTime = groupRows
      .map((row) => ({ row, time: parseTime(row.matchDateUTC) }))
      .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

    let cluster = [];
    let clusterStart = null;

    const flush = () => {
      if (!cluster.length) return;
      const clusterRows = cluster.map((c) => c.row);
      const primary = pickPrimaryRow(clusterRows);
      merged.push({ ...primary, channels: mergeChannels(clusterRows) });
      cluster = [];
    };

    for (const item of withTime) {
      const fitsCluster =
        cluster.length > 0 && item.time !== null && clusterStart !== null && item.time - clusterStart <= TIME_TOLERANCE_MS;
      if (fitsCluster) {
        cluster.push(item);
      } else {
        flush();
        cluster.push(item);
        clusterStart = item.time;
      }
    }
    flush();
  }

  return merged;
}

module.exports = { mergeRows, normalizeTeamName };
