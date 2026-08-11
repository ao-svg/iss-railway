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

/**
 * Case-insensitive fuzzy match, same rule as the original PHP:
 * exact match OR substring match in either direction.
 * Mirrors ISS_IPTV_Scraper::find_channel_in_playlist()
 */
function findChannelInPlaylist(name, playlist) {
  const target = name.toLowerCase();
  for (const item of playlist) {
    const itemName = item.name.toLowerCase();
    if (itemName === target || itemName.includes(target) || target.includes(itemName)) {
      return item.url;
    }
  }
  return null;
}

/**
 * Given a list of channel names (from TheSportsDB's lookuptv.php),
 * return the subset that resolve to a stream URL in the iptv-org playlist.
 * Mirrors the loop in ISS_IPTV_Scraper::discover_streams()
 */
async function matchChannels(channelNames, playlistUrl) {
  if (!channelNames.length) return [];
  const playlist = await getPlaylist(playlistUrl);
  const found = [];
  for (const name of channelNames) {
    const url = findChannelInPlaylist(name, playlist);
    if (url) found.push({ label: name, streamUrl: url });
  }
  return found;
}

module.exports = { parseM3U, getPlaylist, findChannelInPlaylist, matchChannels };
