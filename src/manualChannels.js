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
//
// Playlists are M3U/M3U8 lists: a remote link (read again every 30 minutes) or
// a file pasted/uploaded here (kept on disk, id "file:<id>"). Their entries are
// matched to channel names, and can be used by a rule.
//
// A rule attaches sources to every game that fits its conditions (league, sport,
// a word in the game name) - not to a channel name: it adds a channel with the
// rule's own name (e.g. "NFL Network") to those games, holding the rule's links
// and/or the entries of one of the playlists (optionally only those whose name or
// group contains some words).

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');
const iptv = require('./iptv');

const STORE_PATH = dataPath('manual-channels.json');
// Remote M3U/M3U8 playlists the admin added (the same format as iptv-org's):
// each entry whose name matches a channel's name becomes one of its sources,
// exactly like a manual URL, and follows the file when it changes.
const PLAYLISTS_PATH = dataPath('manual-playlists.json');
const PLAYLIST_FILES_DIR = dataPath('manual-playlist-files');
const RULES_PATH = dataPath('manual-rules.json');
const MAX_PLAYLISTS = 20;
const MAX_PLAYLIST_FILE = 5 * 1024 * 1024;
const MAX_RULES = 100;
const PLAYLIST_SOURCES_PER_CHANNEL = 5;
const RULE_PLAYLIST_LIMIT = 5;
const RULE_PLAYLIST_MAX_LIMIT = 20;

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

function loadRules() {
  try {
    const list = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let _rules = loadRules();

function saveRules() {
  fs.mkdirSync(path.dirname(RULES_PATH), { recursive: true });
  fs.writeFileSync(RULES_PATH, JSON.stringify(_rules, null, 2));
}

// A playlist file's content lives in its own file; its parsed entries are cached under "file:<id>"
// (the iptv cache the matching reads), loaded again here after a restart.
const FILE_REF = /^file:[a-z0-9]{6,32}$/;
const filePathFor = (ref) => path.join(PLAYLIST_FILES_DIR, `${ref.slice(5)}.m3u`);
for (const p of _playlists) {
  if (!FILE_REF.test(p.url || '')) continue;
  try {
    iptv.setCachedPlaylist(p.url, iptv.parseM3UDetailed(fs.readFileSync(filePathFor(p.url), 'utf8')));
  } catch {
    /* a missing file leaves the playlist empty until it is added again */
  }
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
  if (_playlists.length !== before) {
    savePlaylists();
    if (FILE_REF.test(url)) fs.rmSync(filePathFor(url), { force: true });
    // A rule that used it keeps its own links; the playlist part is dropped
    let changed = false;
    for (const r of _rules) {
      if (r.playlist && r.playlist.ref === url) { delete r.playlist; changed = true; }
    }
    _rules = _rules.filter((r) => (r.sources && r.sources.length) || r.playlist);
    if (changed) saveRules();
  }
  return _playlists.length !== before;
}

/**
 * A playlist pasted or uploaded as a file (the M3U text itself): stored on disk, cached, and used
 * like a remote one. At most 5 MB. `id` is only given by an import that keeps the ids an export wrote.
 * Returns { ok, url: 'file:<id>', count } or { error }.
 */
function addPlaylistFile(label, content, id = '') {
  const text = String(content === undefined || content === null ? '' : content);
  if (!text.trim()) return { error: 'the file is empty' };
  if (Buffer.byteLength(text, 'utf8') > MAX_PLAYLIST_FILE) return { error: 'the file is larger than 5 MB' };
  const entries = iptv.parseM3UDetailed(text);
  if (!entries.length) return { error: 'no channels found in this file (is it an M3U/M3U8 playlist with http(s) stream links?)' };
  if (_playlists.length >= MAX_PLAYLISTS) return { error: `more than ${MAX_PLAYLISTS} playlists` };
  let ref = FILE_REF.test(id) && !_playlists.some((p) => p.url === id) ? id : '';
  while (!ref) {
    const candidate = `file:${require('crypto').randomBytes(5).toString('hex')}`;
    if (!_playlists.some((p) => p.url === candidate)) ref = candidate;
  }
  fs.mkdirSync(PLAYLIST_FILES_DIR, { recursive: true });
  fs.writeFileSync(filePathFor(ref), text);
  iptv.setCachedPlaylist(ref, entries);
  _playlists.push({ url: ref, file: true, label: String(label || '').trim().slice(0, 80) || 'Uploaded file', addedAt: new Date().toISOString() });
  savePlaylists();
  return { ok: true, url: ref, count: entries.length };
}

function playlistContent(ref) {
  try {
    return fs.readFileSync(filePathFor(ref), 'utf8');
  } catch {
    return '';
  }
}

// A playlist by its link, "file:<id>", or label (a rule or a JSON import names one)
function findPlaylist(ref) {
  const key = String(ref || '').trim();
  if (!key) return null;
  return _playlists.find((p) => p.url === key) || _playlists.find((p) => (p.label || '').toLowerCase() === key.toLowerCase()) || null;
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
  const parsed = iptv.parseM3UDetailed(String(res.data || ''));
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

// ── Rules: sources for every game that fits ─────────────────

const norm = (s) => String(s === undefined || s === null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
const MAX_RULE_SOURCES = 20;

/**
 * { channel, when: { league?, sport?, text? }, sources?: [url | iframe tag | { url, type }],
 *   playlist?: { ref, filter?, limit? } } -> { rule } or { error }.
 * channel = the name the games will show for these sources (e.g. "NFL Network"). At least one
 * condition and at least one source or a playlist. `ref` names an added playlist (its link,
 * "file:<id>" or label); `filter` = words, separated by commas, of which an entry's name, group or
 * id must contain one; `limit` = how many entries a game gets (default 5, at most 20).
 */
function parseRule(input) {
  if (!input || typeof input !== 'object') return { error: 'a rule must be an object' };
  const channel = String(input.channel || input.name || '').trim();
  if (!channel) return { error: 'the rule needs a channel name (what the games will show)' };
  if (channel.length > MAX_NAME) return { error: 'channel name too long' };
  const when = {};
  const w = input.when && typeof input.when === 'object' ? input.when : {};
  for (const key of ['league', 'sport', 'text']) {
    const v = String(w[key] === undefined || w[key] === null ? '' : w[key]).trim();
    if (v.length > 80) return { error: `"${key}" is too long` };
    if (v) when[key] = v;
  }
  if (!Object.keys(when).length) return { error: 'the rule needs a condition: a league, a sport, or a word in the game name' };

  const sources = [];
  const list = Array.isArray(input.sources) ? input.sources : input.sources ? [input.sources] : [];
  if (list.length > MAX_RULE_SOURCES) return { error: `more than ${MAX_RULE_SOURCES} sources in one rule` };
  for (const s of list) {
    const parsed = parseSource(s && typeof s === 'object' ? s.url : s, s && typeof s === 'object' ? (s.embed === true ? 'embed' : s.type) : '');
    if (parsed.error) return { error: `source ${String(s && s.url ? s.url : s).slice(0, 80)}: ${parsed.error}` };
    if (!sources.some((x) => x.url === parsed.url)) sources.push({ url: parsed.url, type: parsed.embed ? 'embed' : 'stream' });
  }

  let playlist;
  const pl = input.playlist && typeof input.playlist === 'object' ? input.playlist : null;
  if (pl) {
    const found = findPlaylist(pl.ref || pl.url || pl.file || pl.label);
    if (!found) return { error: 'the rule names a playlist that has not been added' };
    const filter = String(pl.filter || '').trim();
    if (filter.length > 200) return { error: 'the playlist filter is too long' };
    const limit = Math.min(RULE_PLAYLIST_MAX_LIMIT, Math.max(1, Math.floor(Number(pl.limit)) || RULE_PLAYLIST_LIMIT));
    playlist = { ref: found.url, ...(filter ? { filter } : {}), limit };
  }
  if (!sources.length && !playlist) return { error: 'the rule needs a link, an embed or a playlist' };
  return { rule: { channel, when, sources, ...(playlist ? { playlist } : {}) } };
}

function addRule(input) {
  const parsed = parseRule(input);
  if (parsed.error) return parsed;
  if (_rules.length >= MAX_RULES) return { error: `more than ${MAX_RULES} rules` };
  const rule = { id: require('crypto').randomBytes(4).toString('hex'), ...parsed.rule, addedAt: new Date().toISOString() };
  _rules.push(rule);
  saveRules();
  return { ok: true, id: rule.id, rule };
}

function removeRule(id) {
  const before = _rules.length;
  _rules = _rules.filter((r) => r.id !== id);
  if (_rules.length !== before) saveRules();
  return _rules.length !== before;
}

function getRules() {
  return _rules;
}

// Every condition the rule has must hold: league / sport / words, all case- and space-insensitive
function ruleMatchesRow(rule, row) {
  const w = rule.when || {};
  if (w.league && !(norm(row.league).includes(norm(w.league)) || norm(row.rawLeague).includes(norm(w.league)))) return false;
  if (w.sport && norm(row.sportType) !== norm(w.sport)) return false;
  if (w.text && !norm(`${row.homeTeam || ''} ${row.awayTeam || ''} ${row.league || ''}`).includes(norm(w.text))) return false;
  return Boolean(w.league || w.sport || w.text);
}

// The links a rule gives one game: its own, then the playlist's entries that pass the filter
function ruleSources(rule, playlistsByRef) {
  const urls = rule.sources.map((s) => s.url);
  const embeds = rule.sources.filter((s) => s.type === 'embed').map((s) => s.url);
  if (rule.playlist) {
    const words = norm(rule.playlist.filter).split(',').map((x) => x.trim()).filter(Boolean);
    const entries = (playlistsByRef && playlistsByRef.get && playlistsByRef.get(rule.playlist.ref)) || [];
    let taken = 0;
    for (const e of entries) {
      if (taken >= (rule.playlist.limit || RULE_PLAYLIST_LIMIT)) break;
      if (words.length && !words.some((x) => norm(`${e.name} ${e.group || ''} ${e.tvgName || ''} ${e.id || ''}`).includes(x))) continue;
      if (!urls.includes(e.url)) { urls.push(e.url); taken++; }
    }
  }
  return { urls, embeds };
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
function isEmbedUrl(url, store = _store, rules = _rules) {
  return Object.values(store).some((e) => (e.embed || []).includes(url)) || rules.some((r) => (r.sources || []).some((s) => s.type === 'embed' && s.url === url));
}

/**
 * JSON in, in any of these shapes (the same shapes exportManualChannels
 * writes, so an export can be edited and imported again):
 *   { "playlists": [...], "rules": [...], "channels": [ { "name": "WST Play", "sources": [ "https://x/a.m3u8", { "url": "https://x/p", "type": "embed" } ] } ] }
 *   [ { "name": ..., "sources": [...] } ]
 *   { "WST Play": [ "https://x/a.m3u8", ... ] }
 * A source is a URL string, a pasted <iframe> tag (an embed), or { url, type }
 * with type "stream" or "embed" (also accepted: embed: true, "urls" for
 * "sources"). A playlist is a link, { url, label }, or { id, label, content }
 * (the M3U text itself). A rule is { channel, when: { league, sport, text },
 * sources, playlist: { ref, filter, limit } } (see parseRule), after the
 * playlists in the same JSON so it can name one. `replace` drops every
 * current entry first (playlists and rules only when the JSON has them);
 * otherwise everything is added to what is there. Nothing is written when
 * the JSON can't be read; an entry that fails the checks is skipped and
 * listed with its reason.
 * Returns { ok, added, playlistsAdded, rulesAdded, skipped: [{ channel, url, reason }], ... } or { error }.
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
  let rulesIn = null;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.playlists)) playlistsIn = data.playlists;
    if (Array.isArray(data.rules)) rulesIn = data.rules;
    if (Array.isArray(data.channels)) list = data.channels;
    else list = Object.entries(data).filter(([k]) => k !== 'playlists' && k !== 'rules').map(([name, sources]) => ({ name, sources }));
  } else return { error: 'expected {"channels": [...], "playlists": [...], "rules": [...]}, a list of channels, or {"Channel name": [urls]}' };
  if (list.length > MAX_CHANNELS) return { error: `more than ${MAX_CHANNELS} channels` };

  const backup = JSON.parse(JSON.stringify(_store));
  const playlistBackup = _playlists;
  const rulesBackup = _rules;
  if (replace) _store = {};
  if (replace && playlistsIn) _playlists = [];
  if (replace && (rulesIn || playlistsIn)) _rules = [];
  const skipped = [];
  let added = 0;
  let playlistsAdded = 0;
  let rulesAdded = 0;
  for (const p of playlistsIn || []) {
    const obj = p && typeof p === 'object' ? p : { url: p };
    const result = obj.content !== undefined ? addPlaylistFile(obj.label, obj.content, obj.id || obj.url) : addPlaylist(obj.url, obj.label);
    if (result.ok) playlistsAdded += result.added === false ? 0 : 1;
    else skipped.push({ channel: '(playlist)', url: String(obj.url || obj.id || obj.label || '').slice(0, 120), reason: result.error });
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
  for (const r of rulesIn || []) {
    const result = addRule(r);
    if (result.ok) rulesAdded++;
    else skipped.push({ channel: `(rule) ${String((r && (r.channel || r.name)) || '')}`, url: '', reason: result.error });
  }
  // A replace that found nothing usable must not leave the list empty
  if (replace && !added && !playlistsAdded && !rulesAdded) {
    _store = backup;
    _playlists = playlistBackup;
    _rules = rulesBackup;
    return { error: 'nothing valid to import - the current entries were kept', skipped };
  }
  saveStore(_store);
  if (playlistsIn) savePlaylists();
  if (rulesIn || (replace && playlistsIn)) saveRules();
  if (replace && playlistsIn) pruneOrphanFiles();
  return {
    ok: true, added, playlistsAdded, rulesAdded, skipped,
    channels: Object.keys(_store).length, playlists: _playlists.length, rules: _rules.length, replaced: Boolean(replace),
  };
}

// Playlist files no playlist points at any more (after a replace)
function pruneOrphanFiles() {
  try {
    for (const f of fs.readdirSync(PLAYLIST_FILES_DIR)) {
      const ref = `file:${f.replace(/\.m3u$/, '')}`;
      if (!_playlists.some((p) => p.url === ref)) fs.rmSync(path.join(PLAYLIST_FILES_DIR, f), { force: true });
    }
  } catch {
    /* no folder yet */
  }
}

function exportManualChannels(store = _store) {
  return {
    playlists: _playlists.map((p) =>
      p.file
        ? { id: p.url, ...(p.label ? { label: p.label } : {}), content: playlistContent(p.url) }
        : { url: p.url, ...(p.label ? { label: p.label } : {}) }
    ),
    rules: _rules.map((r) => ({ channel: r.channel, when: r.when, sources: r.sources, ...(r.playlist ? { playlist: r.playlist } : {}) })),
    channels: Object.values(store)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        name: e.name,
        sources: e.urls.map((url) => ({ url, type: (e.embed || []).includes(url) ? 'embed' : 'stream' })),
      })),
  };
}

/**
 * Merge manual URLs into every channel whose name has an entry, and the rules'
 * sources into every game that fits one. Pure, no I/O — takes the store, the
 * rules and the parsed playlists as plain data so it's directly testable.
 * Returns NEW row objects (never mutates `rows`).
 *
 * Each channel remembers which of its URLs came from here (`manualUrls`),
 * and which of those are embeds (`embedUrls`), so on every apply those are
 * stripped first and the current store's URLs re-added at the front —
 * manual streams are curated by a person, so they outrank playlist
 * matches. A rule's channel is added to the game when it has none by that
 * name (`fromRule: true`, dropped and rebuilt on every apply); when it has,
 * the rule's links join that channel's manual ones. Idempotent by
 * construction: add/remove both just re-run this, and a removed entry
 * simply stops being re-added.
 *
 * options: playlists = every parsed playlist (matched to channel names),
 * rules = [rule], playlistsByRef = Map(ref -> parsed list) for the rules' playlists.
 */
function applyManualChannels(rows, store, { playlists = [], rules = [], playlistsByRef = new Map() } = {}) {
  return rows.map((row) => {
    const base = (row.channels || []).filter((c) => !c.fromRule);
    // Links already on the game from the playlists (not from here): a rule does not repeat them
    const present = new Set();
    for (const c of base) for (const u of c.sources || []) if (!(c.manualUrls || []).includes(u)) present.add(u);

    // What the rules give this game, by channel name
    const byKey = new Map();
    for (const rule of rules) {
      if (!ruleMatchesRow(rule, row)) continue;
      const { urls, embeds } = ruleSources(rule, playlistsByRef);
      const key = channelKey(rule.channel);
      const slot = byKey.get(key) || { name: rule.channel, urls: [], embeds: [] };
      for (const u of urls) if (!present.has(u) && !slot.urls.includes(u)) slot.urls.push(u);
      for (const u of embeds) if (slot.urls.includes(u) && !slot.embeds.includes(u)) slot.embeds.push(u);
      byKey.set(key, slot);
    }
    const used = new Set();

    const channels = base.map((ch) => {
      const previousManual = ch.manualUrls || [];
      const auto = (ch.sources || []).filter((u) => !previousManual.includes(u));
      const key = channelKey(ch.name);
      const entry = store[key];
      // Copy, never alias: removeManualChannel splices the store's array in
      // place, which would silently empty every channel's marker too and
      // leave the removed URL behind in `sources` on the next apply.
      const entryUrls = entry ? [...entry.urls] : [];
      // The remote playlists the admin added: entries matching this channel's name
      // (the same matching as iptv-org/doms9), after the hand-entered links
      const fromPlaylists = playlists.length
        ? iptv.findChannelSourcesAcrossPlaylists(ch.name, playlists, PLAYLIST_SOURCES_PER_CHANNEL, row).filter((u) => !entryUrls.includes(u))
        : [];
      const rule = byKey.get(key);
      if (rule) used.add(key);
      const fromRules = rule ? rule.urls.filter((u) => !entryUrls.includes(u) && !fromPlaylists.includes(u)) : [];
      const manualUrls = [...entryUrls, ...fromPlaylists, ...fromRules];
      const embedUrls = [
        ...(entry ? (entry.embed || []).filter((u) => entryUrls.includes(u)) : []),
        ...(rule ? rule.embeds.filter((u) => fromRules.includes(u)) : []),
      ];
      const { manualUrls: _drop, embedUrls: _dropEmbed, ...rest } = ch;
      const merged = { ...rest, sources: [...manualUrls, ...auto.filter((u) => !manualUrls.includes(u))] };
      if (manualUrls.length) merged.manualUrls = manualUrls;
      if (embedUrls.length) merged.embedUrls = embedUrls;
      return merged;
    });

    for (const [key, rule] of byKey) {
      if (used.has(key) || !rule.urls.length) continue;
      channels.push({ name: rule.name, sources: [...rule.urls], manualUrls: [...rule.urls], ...(rule.embeds.length ? { embedUrls: [...rule.embeds] } : {}), fromRule: true });
    }
    return { ...row, channels };
  });
}

module.exports = {
  channelKey,
  parseSource,
  addManualChannel,
  removeManualChannel,
  addPlaylist,
  addPlaylistFile,
  removePlaylist,
  getPlaylists,
  fetchPlaylist,
  parsePlaylistUrl,
  isPrivateHost,
  parseRule,
  addRule,
  removeRule,
  getRules,
  ruleMatchesRow,
  importManualChannels,
  exportManualChannels,
  isEmbedUrl,
  getAll,
  applyManualChannels,
};
