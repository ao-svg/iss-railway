// Manual stream URLs for channel names that no playlist matches — admin-
// entered via the /manual-channels page or as JSON (import/export, same page
// and /api/manual-channels). Keyed by channel NAME (the broadcaster the
// sources already report, e.g. "WST Play"), so one entry applies to every
// game that lists that channel, now and in future runs.
// Effectively a hand-maintained playlist layered on top of iptv-org/doms9.
//
// A URL is a stream (HLS etc., played by the sites' own video player) or an
// embed (a web page the sites show in an iframe - an official player page,
// Twitch, Vimeo...). Embeds are the URLs also listed in the entry's `embed`
// array, and are exported as sourceEmbed: true.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');
const iptv = require('./iptv');

const STORE_PATH = dataPath('manual-channels.json');
// Remote M3U/M3U8 playlists the admin added (the same format as iptv-org's):
// each entry whose name matches a channel's name becomes one of its sources,
// exactly like a manual URL, and follows the file when it changes.
const PLAYLISTS_PATH = dataPath('manual-playlists.json');
const MAX_PLAYLISTS = 20;
const PLAYLIST_SOURCES_PER_CHANNEL = 5;

const MAX_CHANNELS = 500;
const MAX_SOURCES_PER_CHANNEL = 50;
const MAX_NAME = 120;
const MAX_URL = 2000;

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

function loadPlaylists() {
  try {
    const list = JSON.parse(fs.readFileSync(PLAYLISTS_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let _playlists = loadPlaylists();

function savePlaylists() {
  fs.mkdirSync(path.dirname(PLAYLISTS_PATH), { recursive: true });
  fs.writeFileSync(PLAYLISTS_PATH, JSON.stringify(_playlists, null, 2));
}

// The server fetches a playlist from a link an admin typed, from inside Railway:
// never an address on this machine or a private network.
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h.startsWith('::ffff:')) return true;
  return false;
}

function parsePlaylistUrl(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return { error: 'empty playlist link' };
  if (raw.length > MAX_URL) return { error: 'link too long' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'not a valid link' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'only http(s) links are accepted' };
  if (u.username || u.password) return { error: 'a link with a login in it is not accepted' };
  if (isPrivateHost(u.hostname)) return { error: 'a private or local address is not accepted' };
  return { url: raw };
}

function addPlaylist(input, label = '') {
  const parsed = parsePlaylistUrl(input);
  if (parsed.error) return parsed;
  if (!_playlists.some((p) => p.url === parsed.url)) {
    if (_playlists.length >= MAX_PLAYLISTS) return { error: `more than ${MAX_PLAYLISTS} playlists` };
    _playlists.push({ url: parsed.url, label: String(label || '').trim().slice(0, 80), addedAt: new Date().toISOString() });
    savePlaylists();
    return { ok: true, url: parsed.url, added: true };
  }
  return { ok: true, url: parsed.url, added: false };
}

function removePlaylist(url) {
  const before = _playlists.length;
  _playlists = _playlists.filter((p) => p.url !== url);
  if (_playlists.length !== before) savePlaylists();
  return _playlists.length !== before;
}

function getPlaylists() {
  return _playlists;
}

/**
 * Downloads one of the admin's playlists and caches it where iptv matching looks.
 * Same links the add form accepts, and the same check on every redirect: a
 * redirect to a private address is refused. At most 30 MB, 30 s, 3 redirects.
 * Throws with a readable reason; the previous copy stays in use when it does.
 */
async function fetchPlaylist(url, http = require('axios')) {
  const check = parsePlaylistUrl(url);
  if (check.error) throw new Error(check.error);
  // A name that points at a private address is as bad as typing the address (a failed lookup
  // is left to the download itself to report)
  const addresses = await require('dns').promises.lookup(new URL(url).hostname, { all: true }).catch(() => []);
  if (addresses.some((a) => isPrivateHost(a.address))) throw new Error('a private or local address is not accepted');
  const res = await http.get(url, {
    timeout: 30000,
    maxContentLength: 30 * 1024 * 1024,
    maxRedirects: 3,
    responseType: 'text',
    transformResponse: [(d) => d],
    beforeRedirect: (options) => {
      if (isPrivateHost(options.hostname || options.host) || !/^https?:$/.test(options.protocol || 'https:')) throw new Error('redirected to an address that is not accepted');
    },
  });
  const parsed = iptv.parseM3U(String(res.data || ''));
  if (!parsed.length) throw new Error('no channels found in this file (is it an M3U/M3U8 playlist?)');
  iptv.setCachedPlaylist(url, parsed);
  return parsed;
}

function channelKey(name) {
  return (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * One source as typed by a person: a URL, or a pasted <iframe ...> tag (its
 * src is taken and it is an embed). `type` is 'stream' / 'embed' / '' (auto:
 * an iframe tag is an embed, anything else a stream). Only http(s) links are
 * accepted - a javascript: or data: link in an iframe would run on the
 * visitor's page - and an embed must be https, since an http page can't be
 * framed on an https site. Returns { url, embed } or { error }.
 */
function parseSource(input, type = '') {
  let raw = String(input === undefined || input === null ? '' : input).trim();
  let embed = /^(embed|iframe)$/i.test(String(type || ''));
  const tag = /<iframe\b[^>]*?\bsrc\s*=\s*(["'])(.*?)\1/is.exec(raw);
  if (tag) {
    raw = tag[2].trim();
    embed = true;
  }
  // A protocol-relative src ("//player.example/x") in a pasted tag
  if (embed && raw.startsWith('//')) raw = `https:${raw}`;
  if (!raw) return { error: 'empty URL' };
  if (raw.length > MAX_URL) return { error: 'URL too long' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { error: 'not a valid URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'only http(s) links are accepted' };
  if (embed && u.protocol !== 'https:') return { error: 'an embed must be an https link' };
  return { url: raw, embed };
}

function addSource(name, input, type = '') {
  const key = channelKey(name);
  const cleanName = String(name || '').trim();
  if (!key) return { error: 'empty channel name' };
  if (cleanName.length > MAX_NAME) return { error: 'channel name too long' };
  const parsed = parseSource(input, type);
  if (parsed.error) return parsed;
  const entry = _store[key] || { name: cleanName, urls: [] };
  if (!_store[key] && Object.keys(_store).length >= MAX_CHANNELS) return { error: `more than ${MAX_CHANNELS} channels` };
  if (!entry.urls.includes(parsed.url) && entry.urls.length >= MAX_SOURCES_PER_CHANNEL) return { error: `more than ${MAX_SOURCES_PER_CHANNEL} sources for one channel` };
  _store[key] = entry;
  if (!entry.urls.includes(parsed.url)) entry.urls.push(parsed.url);
  // Adding the same link again with another type changes its type
  const embeds = new Set(entry.embed || []);
  if (parsed.embed) embeds.add(parsed.url);
  else embeds.delete(parsed.url);
  if (embeds.size) entry.embed = [...embeds];
  else delete entry.embed;
  entry.updatedAt = new Date().toISOString();
  return { ok: true, url: parsed.url, embed: parsed.embed };
}

function addManualChannel(name, url, opts = {}) {
  const result = addSource(name, url, opts.embed ? 'embed' : opts.type || '');
  if (result.ok) saveStore(_store);
  return result;
}

function removeManualChannel(name, index) {
  const key = channelKey(name);
  const entry = _store[key];
  if (!entry || entry.urls[index] === undefined) return;
  const [removed] = entry.urls.splice(index, 1);
  if (entry.embed) {
    entry.embed = entry.embed.filter((u) => u !== removed);
    if (!entry.embed.length) delete entry.embed;
  }
  if (!entry.urls.length) delete _store[key];
  saveStore(_store);
}

function getAll() {
  return _store;
}

// True for a link that was added as an embed (listed in any entry's `embed`)
function isEmbedUrl(url, store = _store) {
  return Object.values(store).some((e) => (e.embed || []).includes(url));
}

/**
 * JSON in, in any of these shapes (the same shapes exportManualChannels
 * writes, so an export can be edited and imported again):
 *   { "channels": [ { "name": "WST Play", "sources": [ "https://x/a.m3u8", { "url": "https://x/p", "type": "embed" } ] } ] }
 *   [ { "name": ..., "sources": [...] } ]
 *   { "WST Play": [ "https://x/a.m3u8", ... ] }
 * A source is a URL string, a pasted <iframe> tag (an embed), or { url, type }
 * with type "stream" or "embed" (also accepted: embed: true, "urls" for
 * "sources"). `replace` drops every current entry first; otherwise sources
 * are added to what is there. Nothing is written when the JSON can't be
 * read; a source that fails the checks is skipped and listed with its reason.
 * Returns { ok, added, skipped: [{ channel, url, reason }], channels } or { error }.
 */
function importManualChannels(input, { replace = false } = {}) {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (err) {
      return { error: `not valid JSON (${err.message})` };
    }
  }
  let list;
  let playlistsIn = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.playlists)) playlistsIn = data.playlists;
    if (Array.isArray(data.channels)) list = data.channels;
    else list = Object.entries(data).filter(([k]) => k !== 'playlists').map(([name, sources]) => ({ name, sources }));
  } else return { error: 'expected {"channels": [...], "playlists": [...]}, a list of channels, or {"Channel name": [urls]}' };
  if (list.length > MAX_CHANNELS) return { error: `more than ${MAX_CHANNELS} channels` };

  const backup = JSON.parse(JSON.stringify(_store));
  const playlistBackup = _playlists;
  if (replace) _store = {};
  if (replace && playlistsIn) _playlists = [];
  const skipped = [];
  let added = 0;
  let playlistsAdded = 0;
  for (const p of playlistsIn || []) {
    const result = addPlaylist(p && typeof p === 'object' ? p.url : p, p && typeof p === 'object' ? p.label : '');
    if (result.ok) playlistsAdded += result.added ? 1 : 0;
    else skipped.push({ channel: '(playlist)', url: String((p && p.url) || p || '').slice(0, 120), reason: result.error });
  }
  for (const item of list) {
    const name = item && typeof item === 'object' ? item.name : '';
    const sources = item && typeof item === 'object' ? item.sources || item.urls || [] : [];
    if (!channelKey(name)) {
      skipped.push({ channel: String(name || ''), url: '', reason: 'empty channel name' });
      continue;
    }
    if (!Array.isArray(sources)) {
      skipped.push({ channel: String(name), url: '', reason: 'sources must be a list' });
      continue;
    }
    for (const s of sources) {
      const url = s && typeof s === 'object' ? s.url : s;
      const type = s && typeof s === 'object' ? (s.embed === true ? 'embed' : s.type) : '';
      const result = addSource(name, url, type);
      if (result.ok) added++;
      else skipped.push({ channel: String(name), url: String(url || '').slice(0, 120), reason: result.error });
    }
  }
  // A replace that found nothing usable must not leave the list empty
  if (replace && !added && !playlistsAdded) {
    _store = backup;
    _playlists = playlistBackup;
    savePlaylists();
    return { error: 'nothing valid to import - the current entries were kept', skipped };
  }
  saveStore(_store);
  return { ok: true, added, playlistsAdded, skipped, channels: Object.keys(_store).length, playlists: _playlists.length, replaced: Boolean(replace) };
}

function exportManualChannels(store = _store) {
  return {
    playlists: _playlists.map((p) => ({ url: p.url, ...(p.label ? { label: p.label } : {}) })),
    channels: Object.values(store)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        name: e.name,
        sources: e.urls.map((url) => ({ url, type: (e.embed || []).includes(url) ? 'embed' : 'stream' })),
      })),
  };
}

/**
 * Merge manual URLs into every channel whose name has an entry. Pure, no
 * I/O — takes the store as plain data so it's directly testable. Returns
 * NEW row objects (never mutates `rows`).
 *
 * Each channel remembers which of its URLs came from here (`manualUrls`),
 * and which of those are embeds (`embedUrls`), so on every apply those are
 * stripped first and the current store's URLs re-added at the front —
 * manual streams are curated by a person, so they outrank playlist
 * matches. Idempotent by construction: add/remove both just re-run this,
 * and a removed entry simply stops being re-added.
 */
function applyManualChannels(rows, store, { playlists = [] } = {}) {
  return rows.map((row) => ({
    ...row,
    channels: (row.channels || []).map((ch) => {
      const previousManual = ch.manualUrls || [];
      const auto = (ch.sources || []).filter((u) => !previousManual.includes(u));
      const entry = store[channelKey(ch.name)];
      // Copy, never alias: removeManualChannel splices the store's array in
      // place, which would silently empty every channel's marker too and
      // leave the removed URL behind in `sources` on the next apply.
      const entryUrls = entry ? [...entry.urls] : [];
      // The remote playlists the admin added: entries matching this channel's name
      // (the same matching as iptv-org/doms9), after the hand-entered links
      const fromPlaylists = playlists.length
        ? iptv.findChannelSourcesAcrossPlaylists(ch.name, playlists, PLAYLIST_SOURCES_PER_CHANNEL, row).filter((u) => !entryUrls.includes(u))
        : [];
      const manualUrls = [...entryUrls, ...fromPlaylists];
      const embedUrls = entry ? (entry.embed || []).filter((u) => entryUrls.includes(u)) : [];
      const { manualUrls: _drop, embedUrls: _dropEmbed, ...rest } = ch;
      const merged = { ...rest, sources: [...manualUrls, ...auto.filter((u) => !manualUrls.includes(u))] };
      if (manualUrls.length) merged.manualUrls = manualUrls;
      if (embedUrls.length) merged.embedUrls = embedUrls;
      return merged;
    }),
  }));
}

module.exports = {
  channelKey,
  parseSource,
  addManualChannel,
  removeManualChannel,
  addPlaylist,
  removePlaylist,
  getPlaylists,
  fetchPlaylist,
  parsePlaylistUrl,
  isPrivateHost,
  importManualChannels,
  exportManualChannels,
  isEmbedUrl,
  getAll,
  applyManualChannels,
};
