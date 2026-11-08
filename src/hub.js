// Hub for the WordPress sites of the network. Two kinds:
//   player sites   (zhibo82.com …) — where visitors watch; plugin zhibo82-streaming-table-v3
//   schedule sites (zhibo882.com …) — list the matches and send visitors to a player site;
//                                    plugin zhibo882-streaming-table
//
// Every site asks GET /api/hub/config every few minutes for its settings — which feeds to read
// (the same for every site, so schedule sites list exactly the player sites' matches), the latest
// published version of its plugin, and for schedule sites which player site their matches open
// on — and checks in while doing so.
//
// State: hub.json in the data dir (network key, settings, overrides, site check-ins, releases);
// published plugin zips in hub-releases/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { dataPath } = require('./dataDir');

const STORE_PATH = dataPath('hub.json');
const RELEASES_DIR = dataPath('hub-releases');
const PLUGIN_SLUG = 'zhibo882-streaming-table';   // schedule plugin (also the default for old clients)
const PLAYER_SLUG = 'zhibo82-streaming-table-v3';
// Plugin folder → its main file and the kind of site it makes
const PLUGINS = {
  [PLUGIN_SLUG]: { main: 'zhibo882-streaming-table.php', role: 'schedule', label: 'Schedule plugin (zhibo882)' },
  [PLAYER_SLUG]: { main: 'zhibo82-streaming-table.php', role: 'player', label: 'Player plugin (zhibo82)' },
};
const MAX_ZIP_BYTES = 25 * 1024 * 1024;

const DEFAULT_SETTINGS = {
  defaultTarget: 'https://zhibo82.com',
  feedFixtures: '', // '' = this app's own /fixtures.json
  feedLive: '',     // '' = this app's own /live.json
  pageSize: 30,
  cacheMinutes: 5,
  autoUpdate: true,
  // Optional: each click opens one of these at random (together with defaultTarget).
  // Off by default; domains with an override always use their override.
  rotationEnabled: false,
  rotation: [],
  // Destination groups: { url: 1 | 2 | … }. Visitors go to the first group with a site that is up
  // (random per click when it has several); a group takes over when every site before it is down.
  // Empty = the older main + rotation settings above.
  groups: {},
  // Destination sites added by hand (player sites that check in are listed automatically)
  destinations: [],
};

// ── Pure helpers (tested) ────────────────────────────────────
function cleanHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:?#].*$/, '');
}

// http(s) origin + path without trailing slash, or null
function cleanUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

// Group numbers in use, lowest first, each with its destination URLs (in the order saved)
function groupList(settings) {
  const byN = new Map();
  for (const [url, n] of Object.entries(settings.groups || {})) {
    const g = parseInt(n, 10);
    if (!(g > 0)) continue;
    if (!byN.has(g)) byN.set(g, []);
    byN.get(g).push(url);
  }
  return [...byN.entries()].sort((a, b) => a[0] - b[0]).map(([n, urls]) => ({ n, urls }));
}

// Where clicks go right now: the up sites of the first group that has any (health: { host: { down } }).
// Every site down → the first group anyway (a check from here can be wrong; never send nowhere).
// No groups saved → the main destination, plus the rotation ones while rotation is on.
function activeTargets(settings, health = {}) {
  const groups = groupList(settings);
  if (!groups.length) {
    return [...new Set([settings.defaultTarget, ...(settings.rotationEnabled ? settings.rotation || [] : [])])];
  }
  for (const g of groups) {
    const up = g.urls.filter((u) => !(health[cleanHost(u)] && health[cleanHost(u)].down));
    if (up.length) return up;
  }
  return groups[0].urls;
}

// A site's destination: its own override, else its www/non-www twin's, else the first active one
function targetFor(host, settings, overrides, health = {}) {
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return overrides[host] || overrides[twin] || activeTargets(settings, health)[0] || settings.defaultTarget;
}

// Destinations a site's clicks are spread over at random: [] for a single one or an overridden domain
function rotationFor(host, settings, overrides, health = {}) {
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  if (overrides[host] || overrides[twin]) return [];
  const all = activeTargets(settings, health);
  return all.length > 1 ? all : [];
}

function compareVersions(a, b) {
  const x = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const y = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Just enough of the zip format to check an uploaded plugin: entry names + one file's contents
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip');
    const nameLen = buf.readUInt16LE(p + 28);
    entries.push({
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      local: buf.readUInt32LE(p + 42),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return {
    names: entries.map((e) => e.name),
    read(name) {
      const e = entries.find((x) => x.name === name);
      if (!e) return null;
      if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error('Corrupt zip');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) return zlib.inflateRawSync(data);
      throw new Error('Unsupported zip compression');
    },
  };
}

// Which known plugin an uploaded zip holds, and its version — or throws with a message for the admin
function pluginFromZip(buf) {
  const zip = readZip(buf);
  const top = [...new Set(zip.names.map((n) => n.split('/')[0]))];
  const slug = top.length === 1 && PLUGINS[top[0]] ? top[0] : null;
  if (!slug) {
    const known = Object.keys(PLUGINS).map((s) => `"${s}/"`).join(' or ');
    throw new Error(`Everything in the zip must be inside one plugin folder, ${known} (found: ${top.slice(0, 3).join(', ') || 'nothing'})`);
  }
  const mainFile = PLUGINS[slug].main;
  const main = zip.read(`${slug}/${mainFile}`);
  const match = main && /^[ \t*#@]*Version:\s*([0-9A-Za-z.-]+)/im.exec(main.toString('utf8'));
  if (!match) throw new Error(`No ${mainFile} with a Version header in the zip`);
  return { slug, version: match[1] };
}

// Kept for callers that only need the version
function pluginVersionFromZip(buf) {
  return pluginFromZip(buf).version;
}

function knownPlugin(slug) {
  return PLUGINS[slug] ? slug : PLUGIN_SLUG;
}

// ── Store ────────────────────────────────────────────────────
function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const s = { overrides: {}, sites: {}, releases: {}, commands: {}, ...data, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
    // One release per plugin now; the single "release" of earlier versions was the schedule plugin's
    if (s.release && !s.releases[PLUGIN_SLUG]) s.releases[PLUGIN_SLUG] = s.release;
    delete s.release;
    return s;
  } catch {
    return { networkKey: null, settings: { ...DEFAULT_SETTINGS }, overrides: {}, sites: {}, releases: {}, commands: {} };
  }
}

const store = loadStore();
if (!store.networkKey) store.networkKey = crypto.randomBytes(24).toString('base64url');

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}
if (!fs.existsSync(STORE_PATH)) save();

// Check-ins arrive every few minutes from every site — batch their writes
let checkinTimer = null;
function saveSoon() {
  if (checkinTimer) return;
  checkinTimer = setTimeout(() => { checkinTimer = null; save(); }, 10_000);
  checkinTimer.unref();
}

// HUB_NETWORK_KEY wins over the stored key (rotate it from Railway variables)
function networkKey() {
  return process.env.HUB_NETWORK_KEY || store.networkKey;
}

function keyMatches(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(networkKey());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// API token for scripts (scripts/hub.js: publish a plugin, list sites, update sites now).
// HUB_API_TOKEN wins; otherwise one made on the WordPress sites page. Separate from the network
// key, which every site holds — the token is admin access.
function apiToken() {
  return process.env.HUB_API_TOKEN || store.apiToken || '';
}

function createApiToken() {
  if (process.env.HUB_API_TOKEN) throw new Error('The token comes from HUB_API_TOKEN — change it in Railway');
  store.apiToken = `hub_${crypto.randomBytes(24).toString('base64url')}`;
  save();
  return store.apiToken;
}

function tokenMatches(given) {
  const t = apiToken();
  if (!t) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(t);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function recordCheckin(host, info) {
  const now = new Date().toISOString();
  const prev = store.sites[host] || {};
  // A site that checks in again after a removal has the plugin back
  store.sites[host] = { ...prev, ...info, removed: false, firstSeen: prev.firstSeen || now, lastSeen: now };
  saveSoon();
}

// Which other system set the site up and writes its content (ABS3 connects sites through
// /api/hub/connect and says so). Shown on the sites pages; nothing else changes.
function markSource(host, source) {
  const h = cleanHost(host);
  if (!store.sites[h]) return false;
  const s = String(source || '').trim().toLowerCase().slice(0, 20);
  if (s) store.sites[h].managedBy = s; else delete store.sites[h].managedBy;
  save();
  return true;
}

// ── Package tickets ──────────────────────────────────────────
// A short-lived link to a published plugin zip that carries no network key: ABS3 hands it to the
// site's bridge plugin, which downloads and installs the zip from it. Signed with the network key,
// good for TICKET_TTL_MS; plugin and expiry are inside the ticket so it can't be reused for another.
const TICKET_TTL_MS = 15 * 60 * 1000;

function ticketSign(payload) {
  return crypto.createHmac('sha256', networkKey()).update(payload).digest('base64url');
}

function packageTicket(slug) {
  if (!PLUGINS[slug]) throw new Error(`Unknown plugin ${slug}`);
  if (!store.releases[slug]) throw new Error(`Nothing published for ${PLUGINS[slug].label} yet`);
  const expires = Date.now() + TICKET_TTL_MS;
  const payload = `${slug}.${expires}`;
  return { ticket: `${Buffer.from(payload).toString('base64url')}.${ticketSign(payload)}`, expiresAt: new Date(expires).toISOString(), version: store.releases[slug].version };
}

// The plugin slug a ticket is good for, or null (bad, expired, or for another plugin)
function ticketPlugin(ticket) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(ticket || ''));
  if (!m) return null;
  let payload;
  try { payload = Buffer.from(m[1], 'base64url').toString('utf8'); } catch { return null; }
  const want = Buffer.from(ticketSign(payload));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const dot = payload.lastIndexOf('.');
  const slug = payload.slice(0, dot);
  const expires = parseInt(payload.slice(dot + 1), 10);
  if (!PLUGINS[slug] || !(expires > Date.now())) return null;
  return slug;
}

// ── Commands to sites ────────────────────────────────────────
// Queued here, handed out with the site's settings (/api/hub/config) until the site reports a
// result (/api/hub/report). The plugin skips ids it already ran, so re-sending is safe.
const COMMAND_TYPES = ['setup', 'uninstall', 'content'];
const MAX_COMMANDS_PER_SITE = 30;

function cleanSetupArgs(args) {
  const out = {};
  if (args.brand !== undefined) out.brand = String(args.brand).trim().slice(0, 80);
  if (args.theme !== undefined) out.theme = Boolean(args.theme);
  if (args.menu !== undefined) out.menu = Boolean(args.menu);
  if (args.homepage !== undefined) out.homepage = Boolean(args.homepage);
  if (args.sports !== undefined) {
    out.sports = [...new Set((Array.isArray(args.sports) ? args.sports : [args.sports]).map((x) => String(x).trim()).filter((x) => /^[A-Za-z][A-Za-z /-]{1,40}$/.test(x)))].slice(0, 40);
  }
  return out;
}

// content: { pages: { "Football": "<h2>…</h2><p>…</p>", … } } — text for the sport pages, under the table
function cleanContentArgs(args) {
  const pages = {};
  for (const [type, html] of Object.entries((args && args.pages) || {}).slice(0, 40)) {
    if (!/^[A-Za-z][A-Za-z /-]{1,40}$/.test(type)) continue;
    pages[type] = String(html || '').slice(0, 20000);
  }
  return { pages };
}

function queueCommand(host, type, args = {}) {
  const h = cleanHost(host);
  if (!store.sites[h]) throw new Error(`Unknown site ${h}`);
  if (store.sites[h].role === 'player') throw new Error(`${h} is a player site — set-up and removal are for schedule sites`);
  if (!COMMAND_TYPES.includes(type)) throw new Error(`Unknown command ${type}`);
  const list = store.commands[h] || [];
  const cmd = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    args: type === 'setup' ? cleanSetupArgs(args) : type === 'content' ? cleanContentArgs(args) : {},
    status: 'queued',
    createdAt: new Date().toISOString(),
  };
  // A new removal makes older queued setups pointless
  const kept = type === 'uninstall' ? list.map((c) => (c.status === 'queued' || c.status === 'sent' ? { ...c, status: 'cancelled' } : c)) : list;
  store.commands[h] = [...kept, cmd].slice(-MAX_COMMANDS_PER_SITE);
  save();
  return cmd;
}

function cancelCommand(host, id) {
  const c = (store.commands[cleanHost(host)] || []).find((x) => x.id === id);
  if (c && (c.status === 'queued' || c.status === 'sent')) { c.status = 'cancelled'; save(); }
}

function commandsFor(host) {
  return store.commands[cleanHost(host)] || [];
}

// What goes out with the settings: everything not finished yet, marked as sent
function pendingFor(host) {
  const list = store.commands[host] || [];
  const out = [];
  for (const c of list) {
    if (c.status !== 'queued' && c.status !== 'sent') continue;
    if (c.status === 'queued') { c.status = 'sent'; c.sentAt = new Date().toISOString(); saveSoon(); }
    out.push({ id: c.id, type: c.type, args: c.args });
  }
  return out;
}

// A site's results (and its current state, as it describes it)
function recordReport(host, { results, status }) {
  const h = cleanHost(host);
  if (!store.sites[h]) return false;
  const now = new Date().toISOString();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r !== 'object') continue;
    const log = (Array.isArray(r.log) ? r.log : []).map((l) => String(l).slice(0, 500)).slice(0, 100);
    const c = (store.commands[h] || []).find((x) => x.id === r.id);
    if (c) Object.assign(c, { status: r.ok ? 'done' : 'failed', finishedAt: now, log });
    else if (r.removed) {
      // Removed from the site's own admin (no hub command): keep it in the history
      store.commands[h] = [...(store.commands[h] || []), { id: String(r.id || 'local').slice(0, 40), type: 'uninstall', args: {}, status: r.ok ? 'done' : 'failed', createdAt: now, finishedAt: now, log, local: true }].slice(-MAX_COMMANDS_PER_SITE);
    }
    if (r.removed) store.sites[h].removed = true;
  }
  if (status && typeof status === 'object') {
    store.sites[h].details = {
      theme: String(status.theme || '').slice(0, 80),
      homepage: Boolean(status.homepage),
      bridge: Boolean(status.bridge),
      // zhibo882 2.6.0+ sends the bridge's version ('1' for bridges before 2.7.0)
      bridgeVersion: /^\d+\.\d+/.test(String(status.bridge)) ? String(status.bridge).slice(0, 20) : '',
      brand: String(status.brand || '').slice(0, 80),
      mode: String(status.mode || '').slice(0, 20),
      pages: Object.fromEntries(Object.entries(status.pages || {}).slice(0, 60).map(([k, v]) => [String(k).slice(0, 40), String(v || '').slice(0, 200)])),
      at: now,
    };
  }
  save();
  return true;
}

// What a site gets from /api/hub/config. baseUrl = this app's public address; slug = its plugin.
function configFor(host, baseUrl, slug = PLUGIN_SLUG) {
  slug = knownPlugin(slug);
  const s = store.settings;
  const r = store.releases[slug];
  const common = {
    role: PLUGINS[slug].role,
    feeds: {
      fixtures: s.feedFixtures || `${baseUrl}/fixtures.json`,
      live: s.feedLive || `${baseUrl}/live.json`,
    },
    cache: s.cacheMinutes,
    auto_update: s.autoUpdate,
    latest: r
      ? {
          version: r.version,
          notes: r.notes || '',
          package: `${baseUrl}/api/hub/package?key=${encodeURIComponent(networkKey())}&plugin=${encodeURIComponent(slug)}&v=${encodeURIComponent(r.version)}`,
        }
      : null,
  };
  if (PLUGINS[slug].role === 'player') return common;
  return {
    ...common,
    player_site: targetFor(host, s, store.overrides, health),
    rotation: rotationFor(host, s, store.overrides, health),
    page_size: s.pageSize,
    commands: pendingFor(host),
  };
}

// Player sites that have checked in (not removed) — the destinations to pick from
function playerSites() {
  return Object.entries(store.sites)
    .filter(([, x]) => x.role === 'player' && !x.removed)
    .map(([host, x]) => ({ host, home: cleanUrl(x.home) || `https://${host}`, lastSeen: x.lastSeen, version: x.version }));
}

// Every destination site: the main one, the rotation ones, the ones added by hand and the player
// sites that check in — one entry per host, with what the hub knows about it
function destinations() {
  const s = store.settings;
  const byHost = new Map();
  const add = (url, extra = {}) => {
    const u = cleanUrl(url);
    if (!u) return;
    const host = cleanHost(u);
    byHost.set(host, { url: u, host, ...(byHost.get(host) || {}), ...extra });
  };
  add(s.defaultTarget);
  (s.rotation || []).forEach((u) => add(u));
  (s.destinations || []).forEach((u) => add(u, { manual: true }));
  playerSites().forEach((p) => add(p.home, { player: p }));
  const mainHost = cleanHost(s.defaultTarget);
  const rotHosts = new Set((s.rotation || []).map(cleanHost));
  const groupOf = groupNumbers(s);
  const active = new Set(activeTargets(s, health).map(cleanHost));
  return [...byHost.values()]
    .map((d) => ({
      ...d,
      main: d.host === mainHost,
      inRotation: d.host === mainHost || rotHosts.has(d.host),
      group: groupOf.get(d.host) || 0,
      health: health[d.host] || null,
      active: active.has(d.host),
    }))
    .sort((a, b) => ((a.group || 99) - (b.group || 99)) || (b.main - a.main) || a.host.localeCompare(b.host));
}

// host → group number, from the saved groups or (none saved) from main + rotation
function groupNumbers(s) {
  const m = new Map();
  const groups = groupList(s);
  if (groups.length) groups.forEach((g) => g.urls.forEach((u) => m.set(cleanHost(u), g.n)));
  else {
    m.set(cleanHost(s.defaultTarget), 1);
    (s.rotation || []).forEach((u) => { if (!m.has(cleanHost(u))) m.set(cleanHost(u), s.rotationEnabled ? 1 : 0); });
  }
  return m;
}

// The Destination sites form: a group per site ({ host: n }, 0 = not used). The main destination
// (older settings, single-site views) becomes the first site of the lowest group.
function setGroups(groupsByHost) {
  const known = new Map(destinations().map((d) => [d.host, d.url]));
  const groups = {};
  for (const [h, n] of Object.entries(groupsByHost || {})) {
    const url = known.get(cleanHost(h));
    const g = parseInt(n, 10);
    if (url && g > 0 && g <= 20) groups[url] = g;
  }
  const list = groupList({ groups });
  if (!list.length) throw new Error('Put at least one destination in a group');
  const first = list[0].urls;
  store.settings = { ...store.settings, groups, defaultTarget: first[0], rotation: first.slice(1), rotationEnabled: first.length > 1 };
  save();
  if (onTargetsChange) onTargetsChange();
}

// The Destination sites form in one go: main site, which ones rotate, rotation on/off
function setDestinations({ main, rotate = [], rotationEnabled }) {
  const known = new Map(destinations().map((d) => [d.host, d.url]));
  const mainUrl = known.get(cleanHost(main));
  if (!mainUrl) throw new Error('Pick the main destination from the list');
  const others = [...new Set([].concat(rotate).map((r) => known.get(cleanHost(r))).filter((u) => u && cleanHost(u) !== cleanHost(mainUrl)))];
  const on = Boolean(rotationEnabled) && others.length > 0;
  const groups = { [mainUrl]: 1 };
  if (on) others.forEach((u) => { groups[u] = 1; });
  store.settings = { ...store.settings, defaultTarget: mainUrl, rotation: others, rotationEnabled: on, groups };
  save();
}

function addDestination(url) {
  const u = cleanUrl(url);
  if (!u) throw new Error('Not a valid http(s) address');
  const list = store.settings.destinations || [];
  if (!list.some((x) => cleanHost(x) === cleanHost(u))) store.settings = { ...store.settings, destinations: [...list, u] };
  save();
  return u;
}

// Only hand-added ones, and never the main destination
function removeDestination(url) {
  const host = cleanHost(url);
  if (host === cleanHost(store.settings.defaultTarget)) throw new Error('That is the main destination — pick another main one first');
  store.settings = {
    ...store.settings,
    destinations: (store.settings.destinations || []).filter((x) => cleanHost(x) !== host),
    rotation: (store.settings.rotation || []).filter((x) => cleanHost(x) !== host),
    groups: Object.fromEntries(Object.entries(store.settings.groups || {}).filter(([u]) => cleanHost(u) !== host)),
  };
  delete health[host];
  for (const [h, t] of Object.entries(store.overrides)) if (cleanHost(t) === host) delete store.overrides[h];
  save();
}

function updateSettings(fields) {
  const next = { ...store.settings };
  const errors = [];
  if (fields.defaultTarget !== undefined) {
    const u = cleanUrl(fields.defaultTarget);
    if (u) next.defaultTarget = u; else errors.push('Destination is not a valid http(s) URL');
  }
  for (const key of ['feedFixtures', 'feedLive']) {
    if (fields[key] === undefined) continue;
    if (!String(fields[key]).trim()) { next[key] = ''; continue; }
    const u = cleanUrl(fields[key]);
    if (u) next[key] = u; else errors.push(`${key === 'feedFixtures' ? 'Fixtures' : 'Live'} feed is not a valid URL`);
  }
  if (fields.pageSize !== undefined) next.pageSize = Math.max(0, Math.min(500, parseInt(fields.pageSize, 10) || 0));
  if (fields.cacheMinutes !== undefined) next.cacheMinutes = Math.max(0, Math.min(60, parseInt(fields.cacheMinutes, 10) || 0));
  if (fields.autoUpdate !== undefined) next.autoUpdate = Boolean(fields.autoUpdate);
  if (fields.rotationEnabled !== undefined) next.rotationEnabled = Boolean(fields.rotationEnabled);
  if (fields.rotation !== undefined) {
    const lines = (Array.isArray(fields.rotation) ? fields.rotation : String(fields.rotation).split(/[\r\n,]+/))
      .map((l) => l.trim())
      .filter(Boolean);
    const urls = [];
    for (const line of lines) {
      const u = cleanUrl(line);
      if (u) { if (!urls.includes(u)) urls.push(u); } else errors.push(`Rotation destination "${line.slice(0, 60)}" is not a valid URL`);
    }
    if (urls.length > 20) errors.push('At most 20 rotation destinations');
    next.rotation = urls;
  }
  if (errors.length) throw new Error(errors.join(' · '));
  store.settings = next;
  save();
}

function setOverride(host, target) {
  const h = cleanHost(host);
  if (!h) throw new Error('Domain missing');
  if (!target) { delete store.overrides[h]; save(); return; }
  const u = cleanUrl(target);
  if (!u) throw new Error(`Destination for ${h} is not a valid URL`);
  store.overrides[h] = u;
  save();
}

function forgetSite(host) {
  delete store.sites[cleanHost(host)];
  save();
}

function rotateKey() {
  if (process.env.HUB_NETWORK_KEY) throw new Error('The key comes from HUB_NETWORK_KEY — change it in Railway');
  store.networkKey = crypto.randomBytes(24).toString('base64url');
  save();
}

// A new version of whichever plugin the zip holds; the sites running that plugin get it
function publishRelease(buf, notes) {
  if (buf.length > MAX_ZIP_BYTES) throw new Error('Zip is larger than 25 MB');
  const { slug, version } = pluginFromZip(buf);
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const file = `${slug}-${version}-${crypto.randomBytes(4).toString('hex')}.zip`;
  fs.writeFileSync(path.join(RELEASES_DIR, file), buf);
  const old = store.releases[slug];
  store.releases[slug] = {
    slug,
    version,
    file,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    notes: String(notes || '').slice(0, 2000),
    uploadedAt: new Date().toISOString(),
  };
  save();
  if (old && old.file && old.file !== file) fs.rm(path.join(RELEASES_DIR, old.file), { force: true }, () => {});
  return store.releases[slug];
}

function releasePath(slug = PLUGIN_SLUG) {
  const r = store.releases[knownPlugin(slug)];
  const file = r && path.join(RELEASES_DIR, r.file);
  return file && fs.existsSync(file) ? file : null;
}

// Zips dropped into hub-incoming/ on the volume (e.g. over `railway ssh`) are published like an
// upload on the WordPress sites page, then removed. A zip that isn't a known plugin is renamed
// to .rejected with the reason next to it, so it's never retried.
const INCOMING_DIR = dataPath('hub-incoming');
function importIncoming() {
  let names;
  try { names = fs.readdirSync(INCOMING_DIR).filter((n) => /\.zip$/i.test(n)); } catch { return []; }
  const done = [];
  for (const name of names) {
    const file = path.join(INCOMING_DIR, name);
    try {
      // Still being written? Wait for the next pass.
      if (Date.now() - fs.statSync(file).mtimeMs < 5000) continue;
      const release = publishRelease(fs.readFileSync(file), `uploaded to the hub's storage (${name})`);
      fs.rmSync(file, { force: true });
      console.log(`[hub] published ${release.slug} v${release.version} from ${name}`);
      done.push(release);
    } catch (err) {
      fs.renameSync(file, `${file}.rejected`);
      fs.writeFileSync(`${file}.rejected.txt`, String(err.message));
      console.error(`[hub] ${name} rejected: ${err.message}`);
    }
  }
  return done;
}
importIncoming();
setInterval(importIncoming, 60_000).unref();

// Plugin zips committed to the repo's plugin-releases/ folder are published when the hub
// starts, if they're newer than what it already has. So releasing a plugin is a commit and a
// push — no token, upload or Railway login needed. Older or same versions are left alone, and
// the files stay (they're part of the deployed code).
const REPO_RELEASES_DIR = path.join(__dirname, '..', 'plugin-releases');
function importRepoReleases(dir = REPO_RELEASES_DIR) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => /\.zip$/i.test(n)).sort(); } catch { return []; }
  const done = [];
  for (const name of names) {
    try {
      const buf = fs.readFileSync(path.join(dir, name));
      const { slug, version } = pluginFromZip(buf);
      const current = store.releases[slug];
      if (current && compareVersions(version, current.version) <= 0) continue;
      const release = publishRelease(buf, `released from the repo (${name})`);
      console.log(`[hub] published ${release.slug} v${release.version} from plugin-releases/${name}`);
      done.push(release);
    } catch (err) {
      console.error(`[hub] plugin-releases/${name} skipped: ${err.message}`);
    }
  }
  return done;
}
importRepoReleases();

// ── AI content (OpenAI) ──────────────────────────────────────
// The key stays on the hub: the hub writes the text and sends sites only the text.
function aiSettings() {
  const a = store.ai || {};
  return { key: a.key || '', model: a.model || 'gpt-4o-mini', brief: a.brief || '' };
}

function updateAiSettings({ key, model, brief }) {
  const a = { ...aiSettings() };
  if (key !== undefined && String(key).trim()) a.key = String(key).trim();   // empty field = keep the saved key
  if (model !== undefined) a.model = String(model).trim().slice(0, 60) || 'gpt-4o-mini';
  if (brief !== undefined) a.brief = String(brief).slice(0, 2000);
  store.ai = a;
  save();
}

function clearAiKey() {
  store.ai = { ...aiSettings(), key: '' };
  save();
}

// "sk-…abcd", for showing that a key is saved without showing it
function maskedAiKey() {
  const k = aiSettings().key;
  return k ? `${k.slice(0, 3)}…${k.slice(-4)}` : '';
}

function getState() {
  return store;
}

// ── Destination health ──
// Every 2 minutes each grouped destination is fetched from here. Down = two misses in a row
// (no answer in 15 s, or HTTP 5xx); one good answer brings it back. Kept in memory only: after a
// restart every site counts as up until checked. onTargetsChange: called when where clicks go changes.
const health = {};
let onTargetsChange = null;
let healthTimer = null;
const HEALTH_EVERY_MS = 2 * 60 * 1000;

function destinationHealth() {
  return health;
}

async function probe(url, fetchImpl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': 'zhibo-hub health check' } });
    return res.status < 500 ? { ok: true, code: res.status } : { ok: false, why: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'no answer in 15 s' : (err.cause && err.cause.code) || err.message };
  } finally {
    clearTimeout(t);
  }
}

async function checkDestinations(fetchImpl = fetch) {
  const before = activeTargets(store.settings, health).join(' ');
  const hosts = new Map();
  for (const g of groupList(store.settings)) g.urls.forEach((u) => hosts.set(cleanHost(u), u));
  if (!hosts.size) [store.settings.defaultTarget, ...(store.settings.rotation || [])].forEach((u) => u && hosts.set(cleanHost(u), u));
  await Promise.all([...hosts.entries()].map(async ([host, url]) => {
    const r = await probe(url, fetchImpl);
    const h = health[host] || { down: false, fails: 0 };
    const at = new Date().toISOString();
    if (r.ok) health[host] = { down: false, fails: 0, at, since: h.down ? at : h.since || at, why: '' };
    else {
      const fails = (h.fails || 0) + 1;
      const down = fails >= 2;
      health[host] = { down, fails, at, since: down && !h.down ? at : h.since || at, why: r.why };
    }
  }));
  const changed = activeTargets(store.settings, health).join(' ') !== before;
  if (changed && onTargetsChange) onTargetsChange();
  return changed;
}

function startHealthChecks({ onChange } = {}) {
  onTargetsChange = onChange || null;
  if (healthTimer) return;
  const run = () => checkDestinations().catch((err) => console.error('[hub] destination check failed:', err.message));
  setTimeout(run, 10000).unref();
  healthTimer = setInterval(run, HEALTH_EVERY_MS);
  healthTimer.unref();
}

module.exports = {
  activeTargets,
  setGroups,
  checkDestinations,
  startHealthChecks,
  destinationHealth,
  PLUGIN_SLUG,
  PLAYER_SLUG,
  PLUGINS,
  knownPlugin,
  pluginFromZip,
  playerSites,
  destinations,
  setDestinations,
  addDestination,
  removeDestination,
  importIncoming,
  importRepoReleases,
  INCOMING_DIR,
  MAX_ZIP_BYTES,
  cleanHost,
  cleanUrl,
  targetFor,
  rotationFor,
  compareVersions,
  readZip,
  pluginVersionFromZip,
  networkKey,
  keyMatches,
  apiToken,
  createApiToken,
  tokenMatches,
  recordCheckin,
  markSource,
  packageTicket,
  ticketPlugin,
  TICKET_TTL_MS,
  cleanSetupArgs,
  cleanContentArgs,
  aiSettings,
  updateAiSettings,
  clearAiKey,
  maskedAiKey,
  queueCommand,
  cancelCommand,
  commandsFor,
  recordReport,
  configFor,
  updateSettings,
  setOverride,
  forgetSite,
  rotateKey,
  publishRelease,
  releasePath,
  getState,
};
