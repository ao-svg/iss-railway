#!/usr/bin/env node
// Command line for the WordPress-sites hub (src/hub.js), using its API token.
//
//   npm run hub -- status
//   npm run hub -- publish <plugin folder or zip> [--notes "what changed"]
//   npm run hub -- update <site | all> [--plugin <slug>]
//   npm run hub -- release <plugin folder or zip> [--to <site | all>] [--notes "…"]
//
// release = publish, then ask the sites running that plugin (or just --to) to install it now.
// Needs HUB_API_TOKEN (WordPress sites page → Settings → API token) in .env or the environment;
// HUB_URL defaults to the production hub.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { buildZip } = require('../src/zip');

const HUB = (process.env.HUB_URL || 'https://iss-railway-production.up.railway.app').replace(/\/+$/, '');
const TOKEN = process.env.HUB_API_TOKEN || '';
const PLUGIN_FOLDERS = ['zhibo882-streaming-table', 'zhibo82-streaming-table-v3'];
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

async function api(method, route, { body, json } = {}) {
  if (!TOKEN) fail('HUB_API_TOKEN is not set. Create one on the hub: WordPress sites → Settings → API token, then add HUB_API_TOKEN=… to iss-railway/.env');
  const res = await fetch(HUB + route, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(json ? { 'Content-Type': 'application/json' } : body ? { 'Content-Type': 'application/zip' } : {}) },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
  if (!res.ok) fail(`${method} ${route} → HTTP ${res.status}: ${data.error || text.slice(0, 300)}`);
  return data;
}

// A plugin folder becomes a zip with that folder at its top, as WordPress expects
function zipFromFolder(dir) {
  const top = path.basename(path.resolve(dir));
  if (!PLUGIN_FOLDERS.includes(top)) fail(`${dir}: the folder must be one of the plugins (${PLUGIN_FOLDERS.join(', ')})`);
  const files = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs)) {
      if (SKIP.has(name)) continue;
      const a = path.join(abs, name);
      const r = `${rel}/${name}`;
      const st = fs.statSync(a);
      if (st.isDirectory()) walk(a, r);
      else files.push({ name: r, data: fs.readFileSync(a), mtime: st.mtime });
    }
  };
  walk(path.resolve(dir), top);
  return buildZip(files);
}

function readPackage(target) {
  if (!target) fail('Which plugin? Give its folder or a zip.');
  if (!fs.existsSync(target)) fail(`${target}: not found`);
  return fs.statSync(target).isDirectory() ? zipFromFolder(target) : fs.readFileSync(target);
}

const ago = (iso) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return '—';
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};

async function status() {
  const st = await api('GET', '/api/hub/state');
  console.log('Releases:');
  for (const [slug, r] of Object.entries(st.releases)) console.log(`  ${slug.padEnd(28)} v${r.version}  (${ago(r.uploadedAt)})`);
  console.log(`Destinations${st.rotation ? ' (rotation on)' : ''}:`);
  for (const d of st.destinations) console.log(`  ${d.main ? '*' : ' '} ${d.host.padEnd(28)} ${d.connected ? 'connected' : 'not connected'}${d.inRotation && st.rotation ? ', in rotation' : ''}`);
  console.log('Sites:');
  if (!st.sites.length) console.log('  (none has checked in yet)');
  for (const x of st.sites.sort((a, b) => a.role.localeCompare(b.role) || a.host.localeCompare(b.host))) {
    const v = `v${x.version || '?'}${x.outdated ? ` → v${x.latest} available` : ''}`;
    console.log(`  ${x.role.padEnd(9)} ${x.host.padEnd(28)} ${v.padEnd(26)} last check-in ${ago(x.lastSeen)}${x.removed ? '  (removed)' : ''}`);
  }
}

async function publish(target, notes) {
  const buf = readPackage(target);
  const r = await api('PUT', `/api/hub/release?notes=${encodeURIComponent(notes || '')}`, { body: buf });
  console.log(`Published ${r.label || r.slug} v${r.version} (${Math.round(buf.length / 1024)} KB)`);
  return r;
}

async function update(site, plugin) {
  const r = await api('POST', '/api/hub/update', { json: { site: site || 'all', plugin } });
  if (!r.results.length) console.log('No connected site matches.');
  for (const x of r.results) {
    const said = x.answer && typeof x.answer === 'object' ? ` — site says: ${JSON.stringify(x.answer)}` : '';
    console.log(`  ${x.host.padEnd(28)} v${x.version || '?'} → ${x.latest ? `v${x.latest}` : '(nothing published)'}: ${x.action}${said}`);
  }
  if (r.results.some((x) => x.action === 'asked to update')) {
    console.log('Sites install it in the background and report the new version on their next check-in (`npm run hub -- status` in a minute or two).');
  }
}

(async () => {
  const a = args(process.argv.slice(2));
  const [cmd, target] = a._;
  if (cmd === 'status') return status();
  if (cmd === 'publish') return publish(target, a.notes);
  if (cmd === 'update') return update(target || 'all', a.plugin);
  if (cmd === 'release') {
    const r = await publish(target, a.notes);
    return update(a.to || 'all', r.slug);
  }
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).join('\n').replace(/^\/\/ ?/gm, ''));
})().catch((err) => fail(err.message));
