// A second place for the ABS3 Theme Bridge plugin to fetch its own updates
// from. The plugin on each site checks ABS3 first and this hub second (the hub
// address is built into the plugin), so one of the two being down never stops
// updates. The hub keeps the last good copy it fetched from ABS3 on disk and
// serves that, so it still answers while ABS3 is down or restarting.
const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');

const REFRESH_MS = 10 * 60 * 1000;
const dir = () => dataPath('bridge-cache');
const infoFile = () => path.join(dir(), 'update.json');
const zipFile = () => path.join(dir(), 'abs3-theme-bridge.zip');

const abs3Url = () => String(process.env.ABS3_URL || 'https://abs3-production.up.railway.app').replace(/\/+$/, '');

let lastTry = 0;
let running = null;

async function fetchFresh() {
  const base = abs3Url();
  const metaRes = await fetch(base + '/plugin/update.json', { signal: AbortSignal.timeout(10000) });
  if (!metaRes.ok) throw new Error('update.json answered HTTP ' + metaRes.status);
  const meta = await metaRes.json();
  if (!meta || !meta.version) throw new Error('update.json has no version');
  const have = readInfo();
  if (have && have.version === meta.version && fs.existsSync(zipFile())) return have;
  const zipRes = await fetch(base + '/plugin/abs3-theme-bridge.zip', { signal: AbortSignal.timeout(30000) });
  if (!zipRes.ok) throw new Error('the zip answered HTTP ' + zipRes.status);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  // A zip starts with "PK"; anything else (an error page) is not kept
  if (zip.length < 1000 || zip[0] !== 0x50 || zip[1] !== 0x4b) throw new Error('the download is not a zip');
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(zipFile() + '.tmp', zip);
  fs.renameSync(zipFile() + '.tmp', zipFile());
  const keep = { name: meta.name, slug: meta.slug, version: meta.version, requires: meta.requires, requires_php: meta.requires_php, tested: meta.tested, last_updated: meta.last_updated };
  fs.writeFileSync(infoFile(), JSON.stringify(keep));
  return keep;
}

function readInfo() {
  try { return JSON.parse(fs.readFileSync(infoFile(), 'utf8')); } catch (e) { return null; }
}

// The cached release, refreshed from ABS3 at most every ten minutes. Never throws.
async function current() {
  if (Date.now() - lastTry > REFRESH_MS) {
    lastTry = Date.now();
    running = running || fetchFresh().catch((err) => { console.warn('[bridge-mirror]', err.message); }).finally(() => { running = null; });
  }
  if (running && !readInfo()) await running;
  return readInfo();
}

function mountBridgeMirror(app, baseUrl) {
  app.get('/bridge/update.json', async (req, res) => {
    const info = await current();
    if (!info || !fs.existsSync(zipFile())) return res.status(503).json({ error: 'no copy of the bridge yet' });
    const base = baseUrl(req);
    res.set('Cache-Control', 'no-store');
    res.json({ ...info, download_url: base + '/bridge/abs3-theme-bridge.zip', url: base });
  });
  app.get('/bridge/abs3-theme-bridge.zip', async (req, res) => {
    await current();
    if (!fs.existsSync(zipFile())) return res.status(503).type('text/plain').send('no copy of the bridge yet');
    res.set('Cache-Control', 'no-store');
    res.type('application/zip').attachment('abs3-theme-bridge.zip');
    fs.createReadStream(zipFile()).pipe(res);
  });
}

module.exports = { mountBridgeMirror, current };
