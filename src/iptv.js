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
      const m = line.match(/,(.*)$/);
      if (m) current = { name: m[1].trim() };
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
 */
async function getPlaylist(playlistUrl) {
  const now = Date.now();
  if (_cache.playlist && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.playlist;
  }

  const { data } = await axios.get(playlistUrl, { timeout: 30000 });
  const parsed = parseM3U(data);
  _cache = { playlist: parsed, fetchedAt: now };
  console.log(`[iptv] refreshed playlist: ${parsed.length} channels`);
  return parsed;
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
 * Given a list of channel names, return every one that resolves to at least
 * one iptv-org stream, each with up to `limit` candidate source URLs (not
 * just the single best guess — a channel is genuinely carried on more than
 * one mirror sometimes, and callers want alternates to fall back to).
 */
async function matchChannels(channelNames, playlistUrl, limit = 10) {
  if (!channelNames.length) return [];
  const playlist = await getPlaylist(playlistUrl);
  const found = [];
  for (const name of channelNames) {
    const sources = findChannelSources(name, playlist, limit);
    if (sources.length) found.push({ label: name, sources });
  }
  return found;
}

module.exports = { parseM3U, getPlaylist, findChannelSources, matchChannels };
