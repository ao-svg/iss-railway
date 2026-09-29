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
// Latest capture only, per URL under data/screenshots/, indexed in
// data/screenshots.json. Video sources get a still PNG (a frame from the
// same screencast that builds the gif) plus a short animated GIF; HTML-page
// sources get a plain JPEG (nothing to animate, no gif attempted). Same
// ephemeral-disk caveat as every other data/ file: a Railway redeploy
// starts empty.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const puppeteer = require('puppeteer');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');
const sourceChecks = require('./sourceChecks');

const DIR = path.join(__dirname, '..', 'data', 'screenshots');
const INDEX_PATH = path.join(__dirname, '..', 'data', 'screenshots.json');
// Production evidence (data/screenshots.json on Railway, 2026-09-28): every
// single source in a pass failed with "Protocol error (Page.navigate):
// Session closed" — the whole Chromium process dying, not a per-page
// timeout — at CONCURRENCY 4, right after already dropping it from 8. That's
// the OOM killer reaping the browser: N pages each decoding live video is
// real memory, and this container doesn't have room for more than one at a
// time. One at a time is slower per pass but is the difference between
// getting some captures and getting none at all, every single pass.
const CONCURRENCY = 1;
// A live stream needs the player script, the master + variant playlists
// and usually 2–3 segments buffered before the first frame decodes — 8 s
// lost most working streams to timeouts in the first real pass, 20 s and
// then 40 s still missed some on slower CDNs, so bumped further again.
// Dead ones fail fast, no point waiting long for them. Sources that never
// get a good image also get another attempt on every check in between
// full passes (see runScreenshots' retryOnly in index.js), not just once.
const WORKING_TIMEOUT_MS = 60000;
const UNVERIFIED_TIMEOUT_MS = 30000;
const DEAD_TIMEOUT_MS = 4000;
const MAX_RUNTIME_MS = 25 * 60 * 1000;
const HLS_JS_URL = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js';
const WIDTH = 640;
const HEIGHT = 360;
// A still can be a stale frame someone already jumped past — a few seconds
// of real motion is what actually says "this is live right now". Frames
// come from a CDP screencast (see captureFramesViaScreencast) paced by the
// browser's OWN actual render timing, not a blind setTimeout guess, and
// double as the still too — one capture operation instead of a screenshot
// call plus a separate manual frame-grabbing loop.
const GIF_DURATION_MS = 4000; // under the 5s ask
const GIF_MAX_FRAMES = 12; // caps memory/encode time if the page renders fast
const GIF_FRAME_INTERVAL_MS = 400; // fallback delay only, when real timing is unavailable
const GIF_PALETTE_SIZE = 256; // gifenc's max — best color fidelity it offers

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

function getAllScreenshots() {
  return _index;
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

/**
 * A handful of raw PNG frames (already-decoded video) -> one animated GIF
 * buffer. `delays[i]` is how long frame i is displayed (ms); missing entries
 * fall back to a fixed interval. Failure here is never fatal to the capture
 * as a whole — the still image is the thing that has to work, this is a
 * bonus on top of an already-proven-good page.
 */
async function encodeGif(pngBuffers, width, height, delays = []) {
  const gif = GIFEncoder();
  pngBuffers.forEach((buf, i) => {
    // page.screenshot()/CDP screencast hand back a Uint8Array, not a real
    // Node Buffer — pngjs calls Buffer-only methods (readUInt32BE)
    // internally, so a bare Uint8Array throws "data.readUInt32BE is not a
    // function" every time.
    const { data } = PNG.sync.read(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    const palette = quantize(data, GIF_PALETTE_SIZE);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay: delays[i] ?? GIF_FRAME_INTERVAL_MS });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

/**
 * Frames via Chrome DevTools Protocol's screencast, not a manual
 * screenshot()-then-sleep loop — frames arrive as the browser actually
 * renders them (real pacing, no guessing at intervals), and one capture
 * produces enough frames for BOTH the still and the gif instead of a
 * separate screenshot() call plus N more. `everyNthFrame: 2` and the
 * maxFrames cap below both exist so a fast-rendering page can't hand back
 * an unbounded number of frames — same one-container-can't-take-much
 * reasoning as CONCURRENCY=1 above.
 */
async function captureFramesViaScreencast(page, durationMs, maxFrames) {
  const client = await page.target().createCDPSession();
  const frames = [];
  const start = Date.now();
  const onFrame = (frame) => {
    frames.push({ data: Buffer.from(frame.data, 'base64'), t: Date.now() - start });
    client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  };
  client.on('Page.screencastFrame', onFrame);
  try {
    await client.send('Page.startScreencast', { format: 'png', maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 2 });
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (frames.length >= maxFrames || Date.now() - start >= durationMs) {
          clearInterval(iv);
          resolve();
        }
      }, 100);
    });
  } finally {
    client.off('Page.screencastFrame', onFrame);
    await client.send('Page.stopScreencast').catch(() => {});
    await client.detach().catch(() => {});
  }
  return frames;
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
  const id = screenshotId(url);
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

      const frames = await captureFramesViaScreencast(page, GIF_DURATION_MS, GIF_MAX_FRAMES).catch(() => []);
      if (frames.length >= 2) {
        // Real per-frame delays from actual render timing, not a blind
        // guess; the last frame has nothing to measure to, so it reuses the
        // previous gap.
        const delays = frames.map((f, i) => (i < frames.length - 1 ? Math.max(20, frames[i + 1].t - f.t) : GIF_FRAME_INTERVAL_MS));
        // Skip the first couple frames for the still — often mid-transition
        // from whatever was on screen right as playback started.
        const stillFile = `${id}.png`;
        await fs.promises.writeFile(path.join(DIR, stillFile), frames[Math.min(2, frames.length - 1)].data);
        let gifFile = null;
        let gifError = null;
        try {
          const gifBytes = await encodeGif(
            frames.map((f) => f.data),
            WIDTH,
            HEIGHT,
            delays
          );
          gifFile = `${id}.gif`;
          await fs.promises.writeFile(path.join(DIR, gifFile), gifBytes);
        } catch (err) {
          gifError = err.message;
        }
        return { ok: true, file: stillFile, gifOk: Boolean(gifFile), gifFile, gifError };
      }
      // Screencast produced too little to animate (or nothing at all,
      // rare but possible) — fall back to the old reliable single
      // screenshot so a still still comes out of this capture.
      const file = `${id}.jpg`;
      await page.screenshot({ path: path.join(DIR, file), type: 'jpeg', quality: 70 });
      return {
        ok: true,
        file,
        gifOk: false,
        gifFile: null,
        gifError: frames.length ? 'not enough frames to animate' : 'screencast produced no frames',
      };
    }

    const file = `${id}.jpg`;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
    await new Promise((r) => setTimeout(r, 1000));
    await page.screenshot({ path: path.join(DIR, file), type: 'jpeg', quality: 70 });
    return { ok: true, file, gifOk: false, gifFile: null, gifError: null };
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
 * Capture every URL in `urls` (deduped). By default this is a full pass:
 * entries for URLs not in it are dropped from the index and their files
 * pruned, so the folder only holds the current dataset's latest captures.
 * With `partial: true` (the retry pass for sources that have no good
 * image yet) existing entries are kept untouched.
 *
 * Each capture is written to disk as soon as it completes, not batched to
 * the end — a container running 4 concurrent headless-Chrome pages decoding
 * live video can get OOM-killed mid-pass, and a redeploy can land at any
 * time too; either one used to erase an entire pass's results because
 * nothing was persisted until every URL had been attempted. Losing only the
 * not-yet-captured tail is the actual crash-safety this was meant to have.
 */
async function captureAll(urls, { onProgress, partial = false } = {}) {
  // Working sources first so the pictures that matter land in the first
  // minute; the dead ones (fast failures) trail behind.
  const rank = (url) => {
    const c = sourceChecks.getStatus(url);
    return c && c.working === true ? 0 : c && c.working === false ? 2 : 1;
  };
  const unique = [...new Set(urls)].sort((a, b) => rank(a) - rank(b));
  const uniqueSet = new Set(unique);
  const summary = { total: unique.length, captured: 0, failed: 0, stoppedEarly: false, partial };
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
        // Trim memory further on top of CONCURRENCY=1 above — no point
        // spending RAM on GPU compositing/extensions/background timers a
        // headless capture never benefits from.
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
  } catch (err) {
    console.error(`[screenshots] browser launch failed: ${err.message}`);
    summary.failed = unique.length;
    summary.launchError = err.message;
    return summary;
  }

  const startTime = Date.now();
  const next = { index: 0 };

  function recordResult(url, result) {
    _index[url] = { ...result, capturedAt: new Date().toISOString() };
    saveIndex(_index);
  }

  // Production evidence (2026-09-29): a pass got a burst of ~63 sources all
  // failing net::ERR_ABORTED within the same quarter-second (a page broken
  // early poisoning every subsequent goto() on it), then went completely
  // silent - no pass ran again for over a day. captureOne's timeouts are
  // enforced BY Puppeteer talking to a real browser; if that browser/page is
  // already wedged, Puppeteer's own timeout can itself hang instead of
  // firing, and nothing here would ever revisit the MAX_RUNTIME_MS check
  // above because it's still stuck awaiting that one call. This wraps every
  // capture in an external, timer-based cap this process enforces itself -
  // no matter how broken the browser gets, the loop always moves on.
  const HARD_CAP_MS = WORKING_TIMEOUT_MS + GIF_DURATION_MS + 15000;

  function withHardCap(promise, url) {
    let timer;
    const capped = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `hard cap: no result within ${HARD_CAP_MS / 1000}s (browser likely wedged)` }), HARD_CAP_MS);
    });
    return Promise.race([promise, capped]).finally(() => clearTimeout(timer));
  }

  async function worker() {
    let page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT });
    try {
      while (next.index < unique.length) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) {
          summary.stoppedEarly = true;
          return;
        }
        const url = unique[next.index++];
        const result = await withHardCap(captureOne(page, url), url);
        recordResult(url, result);
        if (result.ok) summary.captured++;
        else summary.failed++;
        if (onProgress) onProgress(summary.captured + summary.failed, unique.length);
        // A failed capture may leave the page in a broken state that
        // poisons every following goto() on it (the ERR_ABORTED burst
        // above) - recycle it so one bad source can't take the rest of the
        // pass down too. The old page (and whatever's still pending on it
        // from a hard-capped call) is simply abandoned, not awaited. If the
        // BROWSER itself is gone (not just this page), newPage() will
        // reject too - that's fatal for this worker, not something to
        // retry into another hang, so let it end the loop and fall through
        // to captureAll's own browser.close() cleanup.
        if (!result.ok) {
          page.close().catch(() => {});
          try {
            page = await browser.newPage();
            await page.setViewport({ width: WIDTH, height: HEIGHT });
          } catch (err) {
            console.error(`[screenshots] browser unusable, ending this pass early: ${err.message}`);
            summary.stoppedEarly = true;
            return;
          }
        }
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

  // A full pass drops entries outside the current dataset once everything
  // has actually run; a partial (retry) pass never prunes, it only adds.
  if (!partial) {
    for (const url of Object.keys(_index)) {
      if (!uniqueSet.has(url)) delete _index[url];
    }
  }
  saveIndex(_index);

  const referenced = new Set();
  for (const e of Object.values(_index)) {
    if (e.ok && e.file) referenced.add(e.file);
    if (e.gifOk && e.gifFile) referenced.add(e.gifFile);
  }
  for (const name of fs.readdirSync(DIR)) {
    if ((name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.gif')) && !referenced.has(name)) fs.unlinkSync(path.join(DIR, name));
  }

  console.log(`[screenshots] ${partial ? 'retry' : 'full'} pass: ${summary.captured} captured, ${summary.failed} failed of ${summary.total}${summary.stoppedEarly ? ' (stopped early: time budget)' : ''}`);
  return summary;
}

module.exports = { captureAll, captureOne, getScreenshot, getAllScreenshots, screenshotId, playerHtml, encodeGif, DIR };
