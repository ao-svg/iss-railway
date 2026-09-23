// Screenshots of what a viewer would actually see for each source URL —
// a probe (sourceChecks.js) can say "a segment came back", only a real
// browser with a player can show the picture. Runs on every 3rd scheduled
// source check (see index.js) and on demand from the dashboard.
//
// Same one-browser-per-pass shape as liveTv.js / livesportsontv.js, with
// a small pool of pages. Web security is disabled in THIS browser only so
// 'nocors' streams can be captured too — it's our own verification
// browser, nothing is served through it.
//
// Latest capture only, one JPEG per URL under data/screenshots/, indexed
// in data/screenshots.json. Same ephemeral-disk caveat as every other
// data/ file: a Railway redeploy starts empty.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const sourceChecks = require('./sourceChecks');

const DIR = path.join(__dirname, '..', 'data', 'screenshots');
const INDEX_PATH = path.join(__dirname, '..', 'data', 'screenshots.json');
const CONCURRENCY = 4;
// A live stream needs the player script, the master + variant playlists
// and usually 2–3 segments buffered before the first frame decodes — 8 s
// lost most working streams to timeouts in the first real pass, 20 s did
// not. Dead ones fail fast, no point waiting long for them.
const WORKING_TIMEOUT_MS = 20000;
const UNVERIFIED_TIMEOUT_MS = 10000;
const DEAD_TIMEOUT_MS = 4000;
const MAX_RUNTIME_MS = 25 * 60 * 1000;
const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
const WIDTH = 640;
const HEIGHT = 360;

function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveIndex(index) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}

let _index = loadIndex();

function screenshotId(url) {
  return crypto.createHash('sha1').update(url).digest('hex');
}

function getScreenshot(url) {
  return _index[url] || null;
}

/**
 * Minimal player page: <video> + hls.js (Chromium has no native HLS).
 * Reports into window.__state so the capture loop can tell "frame
 * decoded" from "player gave up" instead of screenshotting a black box.
 */
function playerHtml(url) {
  const src = JSON.stringify(url).replace(/<\//g, '<\\/');
  return `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#000">
<video id="v" muted autoplay playsinline style="width:${WIDTH}px;height:${HEIGHT}px;object-fit:contain;background:#000"></video>
<script src="${HLS_JS_URL}"></script>
<script>
window.__state = 'loading';
window.__last = 'player-script';
var v = document.getElementById('v');
function fail(m) { window.__state = 'error:' + m; }
try {
  if (window.Hls && Hls.isSupported()) {
    var h = new Hls({ enableWorker: false });
    h.on(Hls.Events.ERROR, function (e, d) { if (d && d.fatal) fail(d.details || d.type); });
    ['MANIFEST_PARSED', 'LEVEL_LOADED', 'FRAG_LOADING', 'FRAG_LOADED', 'BUFFER_APPENDED'].forEach(function (k) {
      h.on(Hls.Events[k], function () { window.__last = k; });
    });
    window.__frag = 'none';
    h.on(Hls.Events.FRAG_LOADING, function () { if (window.__frag === 'none') window.__frag = 'loading'; });
    h.on(Hls.Events.FRAG_LOADED, function () { window.__frag = 'loaded'; });
    h.loadSource(${src});
    h.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = ${src};
  } else {
    fail('no-hls-support');
  }
  v.addEventListener('error', function () { fail('video-error'); });
  v.play().catch(function () {});
} catch (e) { fail(String(e)); }
</script></body></html>`;
}

async function captureOne(page, url) {
  const check = sourceChecks.getStatus(url);
  // An .m3u8 URL always goes through the player even if the check saw an
  // HTML page for it — navigating a browser straight to a manifest just
  // triggers a download (net::ERR_ABORTED), never a picture.
  const isManifest = /\.m3u8(\?|$)/i.test(url) || (check ? check.isManifest !== false : true);
  const timeout =
    check && check.working === true ? WORKING_TIMEOUT_MS : check && check.working === false ? DEAD_TIMEOUT_MS : UNVERIFIED_TIMEOUT_MS;
  const target = (check && check.resolvedUrl) || url;
  const file = `${screenshotId(url)}.jpg`;
  try {
    if (isManifest) {
      // data: URL rather than page.setContent — the latter goes through
      // document.write, and Chrome may block a parser-blocking cross-site
      // script (our hls.js include) loaded that way on a slow network.
      await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(playerHtml(target))}`, { waitUntil: 'load', timeout });
      // readyState >= 2 (HAVE_CURRENT_DATA) = a frame is decoded for the
      // current position; that's the picture we want. Requiring playback
      // to have advanced too (currentTime > 0) just adds a second or two
      // of waiting for live streams and nothing to the screenshot.
      await page.waitForFunction(
        () => {
          const v = document.getElementById('v');
          return (v && v.readyState >= 2) || String(window.__state || '').startsWith('error:');
        },
        { timeout, polling: 200 }
      );
      const state = await page.evaluate(() => window.__state);
      if (String(state).startsWith('error:')) return { ok: false, error: String(state).slice(6) };
      await new Promise((r) => setTimeout(r, 300)); // let the frame paint
    } else {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      await new Promise((r) => setTimeout(r, 1000));
    }
    await page.screenshot({ path: path.join(DIR, file), type: 'jpeg', quality: 60 });
    return { ok: true, file };
  } catch (err) {
    // Puppeteer phrases these as "Waiting failed: 20000ms exceeded" /
    // "Navigation timeout of 20000 ms exceeded" — match both.
    if (!/timeout|waiting failed|exceeded/i.test(err.message)) return { ok: false, error: err.message };
    // Where the player got to before we gave up — a stream stuck at
    // FRAG_LOADING is the common case: a host serving one endless TS
    // stream behind a "segment" URL, which a probe sees as bytes flowing
    // but no browser player can ever finish loading.
    const [last, frag] = await page.evaluate(() => [window.__last, window.__frag]).catch(() => [null, null]);
    const hint = frag === 'loading' ? ' — first segment never finished loading, not playable in a browser' : '';
    return { ok: false, error: `no frame within ${timeout / 1000}s (last player event: ${last || 'none'})${hint}` };
  }
}

/**
 * Capture every URL in `urls` (deduped). Entries for URLs not in this
 * pass are dropped from the index and their files pruned, so the folder
 * only ever holds the current dataset's latest captures.
 */
async function captureAll(urls, { onProgress } = {}) {
  const unique = [...new Set(urls)];
  const summary = { total: unique.length, captured: 0, failed: 0, stoppedEarly: false };
  if (!unique.length) return summary;
  fs.mkdirSync(DIR, { recursive: true });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
      ],
    });
  } catch (err) {
    console.error(`[screenshots] browser launch failed: ${err.message}`);
    summary.failed = unique.length;
    return summary;
  }

  const startTime = Date.now();
  const next = { index: 0 };
  const results = {};

  async function worker() {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    try {
      while (next.index < unique.length) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) {
          summary.stoppedEarly = true;
          return;
        }
        const url = unique[next.index++];
        const result = await captureOne(page, url);
        results[url] = { ...result, capturedAt: new Date().toISOString() };
        if (result.ok) summary.captured++;
        else summary.failed++;
        if (onProgress) onProgress(summary.captured + summary.failed, unique.length);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, worker));
  } finally {
    await browser.close().catch(() => {});
  }

  // Keep the previous capture for anything this pass didn't reach (time
  // budget) rather than blanking it; drop everything outside the dataset.
  const keep = new Set(unique);
  const nextIndex = {};
  for (const url of unique) {
    if (results[url]) nextIndex[url] = results[url];
    else if (_index[url]) nextIndex[url] = _index[url];
  }
  for (const url of Object.keys(_index)) if (!keep.has(url)) delete _index[url];
  _index = nextIndex;
  saveIndex(_index);

  const referenced = new Set(Object.values(_index).filter((e) => e.ok && e.file).map((e) => e.file));
  for (const name of fs.readdirSync(DIR)) {
    if (name.endsWith('.jpg') && !referenced.has(name)) fs.unlinkSync(path.join(DIR, name));
  }

  console.log(`[screenshots] ${summary.captured} captured, ${summary.failed} failed of ${summary.total}${summary.stoppedEarly ? ' (stopped early: time budget)' : ''}`);
  return summary;
}

module.exports = { captureAll, captureOne, getScreenshot, screenshotId, playerHtml, DIR };
