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

// A site's destination: its own override, else its www/non-www twin's, else the default
function targetFor(host, settings, overrides) {
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  return overrides[host] || overrides[twin] || settings.defaultTarget;
}

// Destinations a site's clicks are spread over: [] unless rotation is on and the site has no override
function rotationFor(host, settings, overrides) {
  const twin = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  if (!settings.rotationEnabled || overrides[host] || overrides[twin]) return [];
  const all = [...new Set([settings.defaultTarget, ...(settings.rotation || [])])];
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

function recordCheckin(host, info) {
  const now = new Date().toISOString();
  const prev = store.sites[host] || {};
  // A site that checks in again after a removal has the plugin back
  store.sites[host] = { ...prev, ...info, removed: false, firstSeen: prev.firstSeen || now, lastSeen: now };
  saveSoon();
}

// ── Commands to sites ────────────────────────────────────────
// Queued here, handed out with the site's settings (/api/hub/config) until the site reports a
// result (/api/hub/report). The plugin skips ids it already ran, so re-sending is safe.
const COMMAND_TYPES = ['setup', 'uninstall'];
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

function queueCommand(host, type, args = {}) {
  const h = cleanHost(host);
  if (!store.sites[h]) throw new Error(`Unknown site ${h}`);
  if (store.sites[h].role === 'player') throw new Error(`${h} is a player site — set-up and removal are for schedule sites`);
  if (!COMMAND_TYPES.includes(type)) throw new Error(`Unknown command ${type}`);
  const list = store.commands[h] || [];
  const cmd = {
    id: crypto.randomBytes(8).toString('hex'),
    type,
    args: type === 'setup' ? cleanSetupArgs(args) : {},
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
    player_site: targetFor(host, s, store.overrides),
    rotation: rotationFor(host, s, store.overrides),
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

function getState() {
  return store;
}

module.exports = {
  PLUGIN_SLUG,
  PLAYER_SLUG,
  PLUGINS,
  knownPlugin,
  pluginFromZip,
  playerSites,
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
  recordCheckin,
  cleanSetupArgs,
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
