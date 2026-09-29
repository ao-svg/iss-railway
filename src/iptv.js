// Port of includes/class-iss-iptv-scraper.php — public iptv-org playlist matching only.
// The original file's channel-matching logic is preserved as-is; the WordPress
// transient cache is replaced with a plain in-memory cache with a TTL.

const axios = require('axios');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours, same as the plugin's CACHE_TTL

// Keyed by playlist URL so more than one playlist (iptv-org, doms9/iptv,
// ...) can each cache independently under the same TTL/force-refresh logic.
const _cacheByUrl = new Map();

/**
 * Simple M3U parser — line-for-line port of ISS_IPTV_Scraper::parse_m3u()
 */
function parseM3U(content) {
  const lines = content.split('\n');
  const data = [];
  let current = null;

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith('#EXTINF')) {
      // The LAST comma on the line separates the attribute block from the
      // title, per the M3U spec — NOT the first. An attribute value (e.g.
      // an embedded http-user-agent string like "...AppleWebKit/537.36
      // (KHTML, like Gecko) Chrome/...") can itself contain a comma, which
      // used to get mistaken for that separator and corrupt the parsed
      // name into a User-Agent fragment instead of the real channel name.
      const idx = line.lastIndexOf(',');
      if (idx !== -1) current = { name: line.slice(idx + 1).trim() };
    } else if (line && !line.startsWith('#')) {
      if (current) {
        current.url = line;
        data.push(current);
        current = null;
      }
    }
  }
  return data;
}

/**
 * Fetch (and cache) the public iptv-org playlist.
 * Mirrors ISS_IPTV_Scraper::get_playlist()
 *
 * `force: true` bypasses the TTL and always re-fetches — used once at the
 * start of each pipeline run so "up to date" tracks the pipeline's own
 * "Last run" timestamp rather than an independent, easily-stale clock.
 * Every per-event matchChannels() call during that same run then reuses
 * this run's cached copy instead of re-fetching per event.
 */
async function getPlaylist(playlistUrl, { force = false } = {}) {
  const now = Date.now();
  const cached = _cacheByUrl.get(playlistUrl);
  if (!force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.playlist;
  }

  const { data } = await axios.get(playlistUrl, { timeout: 30000 });
  const parsed = parseM3U(data);
  _cacheByUrl.set(playlistUrl, { playlist: parsed, fetchedAt: now });
  console.log(`[iptv] refreshed playlist (${playlistUrl}): ${parsed.length} channels`);
  return parsed;
}

/**
 * { channelCount, fetchedAt } for display (e.g. the dashboard), or null if
 * this specific playlist URL has never been fetched yet.
 */
function getPlaylistStatus(playlistUrl) {
  const cached = _cacheByUrl.get(playlistUrl);
  if (!cached) return null;
  return { channelCount: cached.playlist.length, fetchedAt: new Date(cached.fetchedAt).toISOString() };
}

// Below this length a partial match is too likely to be a coincidental
// generic word (e.g. a playlist entry literally named "Sport" matched
// "TNT Sports 1", "Sky Sports Cricket", "Viaplay Sports 1 UK", etc. — all
// unrelated channels). Applies to the reverse direction (playlist name is a
// prefix of the reported channel name).
const MIN_SUBSTRING_MATCH_LENGTH = 8;

// A reported channel name this short ("5", "E4") is only ever matched
// exactly — as a prefix it hits "5 Star Max", "Canal 5 MX", ...
const MIN_PARTIAL_TARGET_LENGTH = 3;

// wheresthematch invents these suffixes to describe the delivery method
// (e.g. "Channel 4 Sport YouTube", "BBC Sport Website") — they're not part
// of any real channel name, so a raw match against them always fails. Only
// applied as a fallback when the un-stripped name finds nothing, so it can
// never corrupt a name that already matches (e.g. a real "STV Player" entry).
const DELIVERY_SUFFIX_RE = /\s+(YouTube|Website|Online|App)$/i;

// doms9 lists per-game streams as "[League] Home vs Away | Channel (TAG)".
// Those are a specific OTHER game's feed unless the teams line up.
const EVENT_ENTRY_RE = /^\[[^\]]*\]\s*(.+?)\s*\|\s*(.+)$/;

// Keywords in a playlist name that tie a channel to a sport. A partial
// match naming a different sport than the fixture's is dropped — e.g. a
// football game reported on "Sky Sports YouTube" shouldn't pull in "Sky
// Sports Cricket" / "Sky Sports F1". An empty list means "never relevant"
// (news channels, e.g. "ABC News Live" for "ABC").
const SPORT_KEYWORDS = {
  football: ['Football', 'Soccer'],
  soccer: ['Football', 'Soccer'],
  futbol: ['Football', 'Soccer'],
  golazo: ['Football', 'Soccer'],
  laliga: ['Football', 'Soccer'],
  bundesliga: ['Football', 'Soccer'],
  nfl: ['American Football'],
  redzone: ['American Football'],
  ncaaf: ['American Football'],
  cricket: ['Cricket'],
  golf: ['Golf'],
  f1: ['Motorsport'],
  motogp: ['Motorsport'],
  nascar: ['Motorsport'],
  indycar: ['Motorsport'],
  racing: ['Motorsport', 'Horse Racing'],
  tennis: ['Tennis'],
  darts: ['Darts'],
  snooker: ['Snooker'],
  billiards: ['Snooker'],
  nba: ['Basketball'],
  basketball: ['Basketball'],
  mlb: ['Baseball'],
  baseball: ['Baseball'],
  nhl: ['Ice Hockey'],
  hockey: ['Ice Hockey'],
  rugby: ['Rugby'],
  afl: ['Australian Rules'],
  cycling: ['Cycling'],
  ufc: ['UFC/MMA'],
  mma: ['UFC/MMA'],
  combat: ['UFC/MMA', 'Boxing'],
  boxing: ['Boxing'],
  news: [],
};

/**
 * Lowercased word tokens with quality/geo tags ("(720p)", "[Geo-blocked]",
 * "(TVF90)") removed, so "MUTV (720p)" compares equal to "MUTV".
 */
function tokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .split(/[^a-z0-9+]+/)
    .filter(Boolean);
}

function startsWithTokens(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  return needle.every((t, i) => haystack[i] === t);
}

function containsTokens(haystack, needle) {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (startsWithTokens(haystack.slice(i), needle)) return true;
  }
  return false;
}

function conflictsWithSport(itemTokens, sportType) {
  if (!sportType || sportType === 'Other') return false;
  return itemTokens.some((t) => SPORT_KEYWORDS[t] && !SPORT_KEYWORDS[t].includes(sportType));
}

/**
 * For a per-game "[League] Home vs Away | Channel" entry: the channel
 * part's tokens if the game is this fixture (either team named), null if
 * it's some other game, undefined if the entry isn't per-game at all.
 */
function eventEntryChannel(rawName, ctx) {
  const m = rawName.match(EVENT_ENTRY_RE);
  if (!m) return undefined;
  const gameTokens = tokens(m[1]);
  const teams = [ctx.homeTeam, ctx.awayTeam].map(tokens).filter((t) => t.length);
  if (!teams.some((t) => containsTokens(gameTokens, t))) return null;
  return tokens(m[2]);
}

/**
 * Every playlist entry that plausibly matches `name`, best first. Matching
 * is on whole words, never raw substrings ("RDS" used to hit "Billiards
 * TV", "ABC" hit "SABC", "TNT Sports 7" hit "T Sports 7"). If any entry
 * matches exactly, only exact matches are returned; otherwise entries whose
 * name starts with the channel's words (or vice versa), longest first,
 * minus those naming a different sport than `ctx.sportType`. Deduped by
 * URL, capped at `limit`.
 *
 * ctx: { sportType, homeTeam, awayTeam } of the fixture, all optional.
 */
function findMatches(name, playlist, limit, ctx = {}) {
  const target = tokens(name);
  if (!target.length) return [];
  const targetStr = target.join(' ');
  const allowPartial = targetStr.length >= MIN_PARTIAL_TARGET_LENGTH;
  const exact = [];
  const partial = [];

  for (const item of playlist) {
    let itemTokens = eventEntryChannel(item.name, ctx);
    if (itemTokens === null) continue; // another game's feed
    if (itemTokens === undefined) itemTokens = tokens(item.name);
    if (!itemTokens.length) continue;
    const itemStr = itemTokens.join(' ');

    if (itemStr === targetStr) {
      exact.push(item);
      continue;
    }
    if (!allowPartial || exact.length) continue;
    const forward = startsWithTokens(itemTokens, target);
    const reverse = itemStr.length >= MIN_SUBSTRING_MATCH_LENGTH && startsWithTokens(target, itemTokens);
    if ((forward || reverse) && !conflictsWithSport(itemTokens, ctx.sportType)) {
      partial.push({ item, score: itemStr.length });
    }
  }

  partial.sort((a, b) => b.score - a.score);
  const ordered = exact.length ? exact : partial.map((p) => p.item);

  const out = [];
  const used = new Set();
  for (const item of ordered) {
    if (used.has(item.url)) continue;
    used.add(item.url);
    out.push(item.url);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Same as findMatches, but retries with a wheresthematch delivery-method
 * suffix stripped if the raw name finds nothing.
 */
function findChannelSources(name, playlist, limit = 10, ctx = {}) {
  const direct = findMatches(name, playlist, limit, ctx);
  if (direct.length) return direct;

  const stripped = String(name || '').replace(DELIVERY_SUFFIX_RE, '').trim();
  if (stripped !== name && stripped.length >= MIN_PARTIAL_TARGET_LENGTH) {
    return findMatches(stripped, playlist, limit, ctx);
  }
  return [];
}

/**
 * Same as findChannelSources, but searches multiple already-parsed
 * playlists in priority order as one combined list: matches keep the
 * higher-priority playlist's URLs first, a URL appearing in more than one
 * playlist only counts once, capped at `limit` total. Searching them
 * together (not one at a time) means an exact match in ANY playlist
 * suppresses fuzzy matches in all of them — otherwise "CBS" matched exactly
 * in doms9 still pulled in iptv-org's "CBS KIRO-TV" etc. Pure, no I/O —
 * the network fetch happens in matchChannels below.
 */
function findChannelSourcesAcrossPlaylists(name, playlists, limit = 10, ctx = {}) {
  return findChannelSources(name, playlists.flat(), limit, ctx);
}

/**
 * Given a list of channel names, return one entry per name — each with up
 * to `limit` candidate source URLs (not just the single best guess — a
 * channel is genuinely carried on more than one mirror sometimes, and
 * callers want alternates to fall back to), or an empty `sources` array if
 * nothing in any of the free playlists matches it.
 *
 * `playlistUrls` is an array of playlist URLs in priority order — when a
 * channel matches in more than one, their candidate URLs are stacked
 * together (see findChannelSourcesAcrossPlaylists) with the earlier
 * playlist's URLs preferred first.
 *
 * A broadcaster with no free stream is still a broadcaster the source
 * genuinely reported — dropping it here used to make a fixture with a
 * known-but-unmatched channel (e.g. a paywalled "Sky Sports"/"HBO Max"
 * mention) look identical to one where nothing was extracted at all. The
 * caller (src/server.js's renderBrowse) already had a "(no stream match)"
 * fallback for exactly this shape; it just never received one to render.
 *
 * `ctx` ({ sportType, homeTeam, awayTeam }) is the fixture the channels
 * were reported for — used to reject other games' per-event feeds and
 * other sports' channels (see findMatches).
 */
async function matchChannels(channelNames, playlistUrls, limit = 10, ctx = {}) {
  if (!channelNames.length) return [];
  const urls = (Array.isArray(playlistUrls) ? playlistUrls : [playlistUrls]).filter(Boolean);
  const playlists = await Promise.all(urls.map((url) => getPlaylist(url)));
  return channelNames.map((name) => ({
    label: name,
    sources: findChannelSourcesAcrossPlaylists(name, playlists, limit, ctx),
  }));
}

module.exports = {
  parseM3U,
  getPlaylist,
  getPlaylistStatus,
  findChannelSources,
  findChannelSourcesAcrossPlaylists,
  matchChannels,
};
