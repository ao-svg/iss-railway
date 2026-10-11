// Hub for the WordPress sites running the Zhibo Streaming Table plugin.
//
// Every site asks GET /api/hub/config every few minutes for its settings — which destination
// site its matches open on, which feeds to read (this app's own fixtures.json / live.json by
// default), the latest published plugin version — and checks in while doing so. Changing the
// destination here moves every site at once; per-domain overrides send some elsewhere.
//
// State: hub.json in the data dir (network key, settings, overrides, site check-ins, release);
// published plugin zips in hub-releases/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { dataPath } = require('./dataDir');

const STORE_PATH = dataPath('hub.json');
const RELEASES_DIR = dataPath('hub-releases');
const PLUGIN_SLUG = 'zhibo882-streaming-table';
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

// The plugin version inside an uploaded zip, or throws with a message for the admin
function pluginVersionFromZip(buf) {
  const zip = readZip(buf);
  const outside = zip.names.filter((n) => !n.startsWith(`${PLUGIN_SLUG}/`));
  if (outside.length) {
    throw new Error(`Everything in the zip must be inside a "${PLUGIN_SLUG}/" folder (found: ${outside.slice(0, 3).join(', ')})`);
  }
  const main = zip.read(`${PLUGIN_SLUG}/${PLUGIN_SLUG}.php`);
  const match = main && /^[ \t*#@]*Version:\s*([0-9A-Za-z.-]+)/im.exec(main.toString('utf8'));
  if (!match) throw new Error(`No ${PLUGIN_SLUG}.php with a Version header in the zip`);
  return match[1];
}

// ── Store ────────────────────────────────────────────────────
function loadStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { overrides: {}, sites: {}, release: null, ...data, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
  } catch {
    return { networkKey: null, settings: { ...DEFAULT_SETTINGS }, overrides: {}, sites: {}, release: null };
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
  const prev = store.sites[host];
  store.sites[host] = { ...info, firstSeen: (prev && prev.firstSeen) || now, lastSeen: now };
  saveSoon();
}

// What a site gets from /api/hub/config. baseUrl = this app's public address.
function configFor(host, baseUrl) {
  const s = store.settings;
  const r = store.release;
  return {
    player_site: targetFor(host, s, store.overrides),
    rotation: rotationFor(host, s, store.overrides),
    feeds: {
      fixtures: s.feedFixtures || `${baseUrl}/fixtures.json`,
      live: s.feedLive || `${baseUrl}/live.json`,
    },
    page_size: s.pageSize,
    cache: s.cacheMinutes,
    auto_update: s.autoUpdate,
    latest: r
      ? {
          version: r.version,
          notes: r.notes || '',
          package: `${baseUrl}/api/hub/package?key=${encodeURIComponent(networkKey())}&v=${encodeURIComponent(r.version)}`,
        }
      : null,
  };
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

function publishRelease(buf, notes) {
  if (buf.length > MAX_ZIP_BYTES) throw new Error('Zip is larger than 25 MB');
  const version = pluginVersionFromZip(buf);
  fs.mkdirSync(RELEASES_DIR, { recursive: true });
  const file = `${PLUGIN_SLUG}-${version}-${crypto.randomBytes(4).toString('hex')}.zip`;
  fs.writeFileSync(path.join(RELEASES_DIR, file), buf);
  const old = store.release;
  store.release = {
    version,
    file,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    notes: String(notes || '').slice(0, 2000),
    uploadedAt: new Date().toISOString(),
  };
  save();
  if (old && old.file && old.file !== file) fs.rm(path.join(RELEASES_DIR, old.file), { force: true }, () => {});
  return store.release;
}

function releasePath() {
  const r = store.release;
  const file = r && path.join(RELEASES_DIR, r.file);
  return file && fs.existsSync(file) ? file : null;
}

function getState() {
  return store;
}

module.exports = {
  PLUGIN_SLUG,
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
  configFor,
  updateSettings,
  setOverride,
  forgetSite,
  rotateKey,
  publishRelease,
  releasePath,
  getState,
};
