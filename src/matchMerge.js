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
// Sources sometimes disagree by more (NFL: 20:05 vs 20:25). Up to this far
// apart, rows merge only when both teams are exactly the same teams —
// the same two teams never play twice within an hour (an MLB doubleheader's
// second game starts hours after the first).
const SAME_TEAMS_TOLERANCE_MS = 60 * 60 * 1000;
// Richest metadata first: SportsDB is the only source with real team
// logos, wheresthematch has broader league/team-name conventions already
// relied on elsewhere (league grouping, translations), livesportsontv is
// newest/least depended-on. Channels are unioned from every matched row
// regardless of which one wins as the metadata source below.
const SOURCE_PRIORITY = ['sportsdb', 'wheresthematch', 'livesportsontv'];

// Club-form words every source adds or drops at will ("Arsenal FC",
// "AFC Bournemouth" / "Bournemouth AFC").
const FILLER_TOKENS = new Set(['fc', 'afc', 'cf', 'sc', 'the']);
// Words that make it a different team (women's, youth, reserve sides):
// these must agree exactly, so "Arsenal Women" never merges with "Arsenal".
const SIDE_TOKEN_RE = /^(women|womens|w|ladies|femenino|feminine|ii|iii|b|reserves|youth|academy|u\d{2})$/;
const TOKEN_ALIASES = { utd: 'united' };
// Letters NFD doesn't take apart ("Bodø", "Gießen", "Łódź").
const LETTER_FOLDS = { ø: 'o', æ: 'ae', œ: 'oe', ß: 'ss', ł: 'l', đ: 'd', ı: 'i' };
// Words too common in club names to say two names are the same club.
const COMMON_WORDS = new Set(['real', 'united', 'city', 'club', 'town', 'county', 'sporting', 'deportivo', 'union', 'saint', 'sint', 'st', 'de', 'del', 'la', 'le', 'los', 'las', 'and', 'new', 'san', 'santa']);

function teamTokens(name) {
  const words = (name || '')
    .toLowerCase()
    .replace(/[øæœßłđı]/g, (c) => LETTER_FOLDS[c])
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .map((t) => TOKEN_ALIASES[t] || t.replace(/^(u\d{2})s$/, '$1'))
    .filter((t) => t && !FILLER_TOKENS.has(t));
  // Spelled-out initials are one word: "D.C. United" = "DC United"
  const out = [];
  let initials = '';
  for (const w of words) {
    if (/^[a-z]$/.test(w)) {
      initials += w;
      continue;
    }
    if (initials) out.push(initials);
    initials = '';
    out.push(w);
  }
  if (initials) out.push(initials);
  return out;
}

function sameSide(ta, tb) {
  const side = (t) => t.filter((w) => SIDE_TOKEN_RE.test(w)).sort().join(' ');
  return side(ta) === side(tb);
}

/**
 * Same team under two sources' spellings: after dropping punctuation,
 * accents and club-form words, every word of the shorter name starts a
 * word of the longer one ("St. Louis Blues" = "St Louis Blues", "Brighton"
 * = "Brighton & Hove Albion", "Man City" = "Manchester City"), and both
 * name the same side (women's, U18, ...). "Manchester United" vs
 * "Manchester City" fails: "united" starts no word of the other.
 */
function sameTeam(a, b) {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (!ta.length || !tb.length || !sameSide(ta, tb)) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  // An abbreviation of the full name: "PSG" = "Paris Saint-Germain"
  if (short.length === 1 && long.length >= 2 && /^[a-z]{2,4}$/.test(short[0]) && short[0] === long.map((w) => w[0]).join('')) return true;
  const used = new Set();
  return short.every((w) => {
    const i = long.findIndex((l, idx) => !used.has(idx) && (l === w || (w.length >= 3 && l.startsWith(w))));
    if (i === -1) return false;
    used.add(i);
    return true;
  });
}

/**
 * Looser: the names share a distinctive word, or two words start with the
 * same 4 letters — "Bayern München" / "Bayern Munich", "RB Leipzig" / "Red
 * Bull Leipzig", "Wolves" / "Wolverhampton Wanderers". Only ever used for
 * one team of a game whose other team and kickoff already match.
 */
function likelySameTeam(a, b) {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (!ta.length || !tb.length || !sameSide(ta, tb)) return false;
  const distinctive = (t) => t.filter((w) => w.length >= 4 && !COMMON_WORDS.has(w) && !SIDE_TOKEN_RE.test(w));
  const da = distinctive(ta);
  const db = distinctive(tb);
  return da.some((x) => db.some((y) => x === y || x.slice(0, 4) === y.slice(0, 4)));
}

const sportKey = (s) => (/^soccer$/i.test(s || '') ? 'football' : (s || '').toLowerCase());

/**
 * Same game: same sport (when both say), and both teams the same team — or
 * one the same team and the other likely the same. Sources sometimes
 * disagree on which side is home (an NFL game abroad, a neutral venue), so
 * both teams matching the other way round counts too: callers only compare
 * rows within minutes of each other, and the same two teams can't play two
 * games at once (a return fixture is weeks apart). Events without an away
 * side (racing, golf: "Live Racing") match on the home name alone.
 */
// Both teams exactly the same (either way round), same sport.
function sameTeams(a, b) {
  const sa = sportKey(a.sportType);
  const sb = sportKey(b.sportType);
  if (sa && sb && sa !== 'other' && sb !== 'other' && sa !== sb) return false;
  if (!teamTokens(a.awayTeam).length || !teamTokens(b.awayTeam).length) return false;
  return (
    (sameTeam(a.homeTeam, b.homeTeam) && sameTeam(a.awayTeam, b.awayTeam)) ||
    (sameTeam(a.homeTeam, b.awayTeam) && sameTeam(a.awayTeam, b.homeTeam))
  );
}

function sameGame(a, b) {
  const sa = sportKey(a.sportType);
  const sb = sportKey(b.sportType);
  if (sa && sb && sa !== 'other' && sb !== 'other' && sa !== sb) return false;
  if (!teamTokens(a.awayTeam).length && !teamTokens(b.awayTeam).length) return sameTeam(a.homeTeam, b.homeTeam);
  const home = sameTeam(a.homeTeam, b.homeTeam);
  const away = sameTeam(a.awayTeam, b.awayTeam);
  if ((home && away) || (home && likelySameTeam(a.awayTeam, b.awayTeam)) || (away && likelySameTeam(a.homeTeam, b.homeTeam))) return true;
  return sameTeam(a.homeTeam, b.awayTeam) && sameTeam(a.awayTeam, b.homeTeam);
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
 * Rows match when both teams are the same team (sameTeam: tolerant of
 * punctuation, accents, club-form words and short forms — sources spell
 * names differently, and exact names left the same game as separate rows,
 * e.g. "St. Louis Blues" / "St Louis Blues") in the same home/away order —
 * not also checked swapped, since two teams can legitimately meet twice in
 * a season in opposite home/away order.
 *
 * Rows are taken in kickoff order and join a cluster whose FIRST (earliest)
 * row is the same game and at most TIME_TOLERANCE_MS earlier (up to
 * SAME_TEAMS_TOLERANCE_MS when both teams match exactly) — a sliding
 * window anchored to that first row, not a fixed time-bucket grid (which
 * would split same-game rows straddling a bucket boundary, e.g. 19:58 vs
 * 20:02) and not a chained previous-item comparison (which would let a
 * cluster's time drift unboundedly across close-but-not-identical reports).
 *
 * A row whose matchDateUTC doesn't parse is never merged with anything —
 * it becomes its own single-row cluster rather than guessing.
 */
function mergeRows(rows) {
  const withTime = rows
    .map((row) => ({ row, time: parseTime(row.matchDateUTC) }))
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  const clusters = []; // { start, rows }, in start order
  for (const item of withTime) {
    let target = null;
    if (item.time !== null) {
      for (let i = clusters.length - 1; i >= 0 && item.time - clusters[i].start <= SAME_TEAMS_TOLERANCE_MS; i--) {
        if (clusters[i].start === null) continue;
        const anchor = clusters[i].rows[0];
        const close = item.time - clusters[i].start <= TIME_TOLERANCE_MS;
        if (close ? sameGame(anchor, item.row) : sameTeams(anchor, item.row)) {
          target = clusters[i];
          break;
        }
      }
    }
    if (target) target.rows.push(item.row);
    else clusters.push({ start: item.time, rows: [item.row] });
  }

  return clusters.map((c) => ({ ...pickPrimaryRow(c.rows), channels: mergeChannels(c.rows) }));
}

module.exports = { mergeRows, sameTeam };
