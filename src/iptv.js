// Port of includes/class-iss-iptv-scraper.php — public iptv-org playlist matching only.
// The original file's channel-matching logic is preserved as-is; the WordPress
// transient cache is replaced with a plain in-memory cache with a TTL.

const axios = require('axios');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours, same as the plugin's CACHE_TTL

let _cache = { playlist: null, fetchedAt: 0 };

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
  if (!force && _cache.playlist && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.playlist;
  }

  const { data } = await axios.get(playlistUrl, { timeout: 30000 });
  const parsed = parseM3U(data);
  _cache = { playlist: parsed, fetchedAt: now };
  console.log(`[iptv] refreshed playlist: ${parsed.length} channels`);
  return parsed;
}

/**
 * { channelCount, fetchedAt } for display (e.g. the dashboard), or null if
 * the playlist has never been fetched yet.
 */
function getPlaylistStatus() {
  if (!_cache.playlist) return null;
  return { channelCount: _cache.playlist.length, fetchedAt: new Date(_cache.fetchedAt).toISOString() };
}

// Below this length a substring match is too likely to be a coincidental
// generic word (e.g. a playlist entry literally named "Sport" matched
// "TNT Sports 1", "Sky Sports Cricket", "Viaplay Sports 1 UK", etc. — all
// unrelated channels — because "Sport" is a substring of all of them).
const MIN_SUBSTRING_MATCH_LENGTH = 8;

// wheresthematch invents these suffixes to describe the delivery method
// (e.g. "Channel 4 Sport YouTube", "BBC Sport Website") — they're not part
// of any real channel name, so a raw match against them always fails. Only
// applied as a fallback when the un-stripped name finds nothing, so it can
// never corrupt a name that already matches (e.g. a real "STV Player" entry).
const DELIVERY_SUFFIX_RE = /\s+(YouTube|Website|Online|App)$/i;

/**
 * Every playlist entry that plausibly matches `name`, best first: exact
 * match(es), then substring matches ordered by specificity (longest
 * matched name first). Deduped by URL, capped at `limit`.
 */
function findMatches(name, playlist, limit) {
  const target = name.toLowerCase();
  const exact = [];
  const partial = [];
  const seenUrls = new Set();

  for (const item of playlist) {
    if (seenUrls.has(item.url)) continue;
    const itemName = item.name.toLowerCase();
    if (itemName === target) {
      exact.push(item);
      seenUrls.add(item.url);
      continue;
    }
    if (itemName.length < MIN_SUBSTRING_MATCH_LENGTH) continue;
    if (itemName.includes(target) || target.includes(itemName)) {
      partial.push({ item, score: itemName.length });
    }
  }

  partial.sort((a, b) => b.score - a.score);
  const ordered = [...exact, ...partial.map((p) => p.item)];

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
function findChannelSources(name, playlist, limit = 10) {
  const direct = findMatches(name, playlist, limit);
  if (direct.length) return direct;

  const stripped = name.replace(DELIVERY_SUFFIX_RE, '').trim();
  if (stripped !== name && stripped.length >= MIN_SUBSTRING_MATCH_LENGTH) {
    return findMatches(stripped, playlist, limit);
  }
  return [];
}

/**
 * Given a list of channel names, return one entry per name — each with up
 * to `limit` candidate source URLs (not just the single best guess — a
 * channel is genuinely carried on more than one mirror sometimes, and
 * callers want alternates to fall back to), or an empty `sources` array if
 * nothing in the free iptv-org playlist matches it.
 *
 * A broadcaster with no free stream is still a broadcaster the source
 * genuinely reported — dropping it here used to make a fixture with a
 * known-but-unmatched channel (e.g. a paywalled "Sky Sports"/"HBO Max"
 * mention) look identical to one where nothing was extracted at all. The
 * caller (src/server.js's renderBrowse) already had a "(no stream match)"
 * fallback for exactly this shape; it just never received one to render.
 */
async function matchChannels(channelNames, playlistUrl, limit = 10) {
  if (!channelNames.length) return [];
  const playlist = await getPlaylist(playlistUrl);
  return channelNames.map((name) => ({ label: name, sources: findChannelSources(name, playlist, limit) }));
}

module.exports = { parseM3U, getPlaylist, getPlaylistStatus, findChannelSources, matchChannels };
