// Checks whether a source URL is (a) reachable and (b) actually usable on
// the user's own site — which for the two content types in this dataset
// means two different things:
//
//   - An HTML page: usable if reachable and not blocked from framing via
//     X-Frame-Options / CSP frame-ancestors. Genuinely <iframe src>-ready.
//   - A raw HLS/DASH stream manifest (.m3u8/.mpd — the vast majority of
//     iptv-org matches): a bare <iframe src="manifest.m3u8"> never renders
//     video, headers or not — browsers can't turn manifest text into a
//     picture without a <video> element + a JS player (hls.js/dash.js) that
//     fetches and decodes it. What actually matters for THAT case is
//     whether the manifest is reachable and CORS-permissive, so a player on
//     the user's own origin can fetch it. Conflating this with "ok" is what
//     caused every "green" result to fail real iframe testing (iframetester.com)
//     — so it gets its own status instead.
//
// Results persist to data/source-checks.json so a page load never re-probes
// hundreds of third-party URLs live. Lives in the data dir (see
// dataDir.js), so it only survives a Railway redeploy when a volume is
// attached.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');
const axios = require('axios');
const { GEO_FENCED_HOSTS } = require('./config');

const CACHE_PATH = dataPath('source-checks.json');
const CHECK_TTL_MS = 12 * 60 * 60 * 1000; // HTML pages — comparatively stable
// Manifests rotate/die within hours, and the scheduled check (index.js,
// SOURCE_CHECK_CRON, every 3 min by default) should actually re-verify
// them each time rather than skip them as fresh — so the TTL matches
// that cadence. HTML pages are comparatively stable and keep the long TTL.
const MANIFEST_TTL_MS = 3 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;
// Plenty of these CDNs bot-block axios's default User-Agent outright (a
// plain 403 with no other explanation) regardless of whether the URL/token
// is otherwise fine — same reason wheresthematch.js/liveTv.js already send
// a real browser UA for their own requests.
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0 Safari/537.36',
};
// What the classifying probes send: the browser UA plus an Origin, the way
// hls.js's cross-origin XHR on a WordPress site does. CloudFront and other
// CDNs only send Access-Control-Allow-Origin when the request has an Origin
// (verified 2026-10-18: the TSN cloudfront stream answered with no ACAO
// without one, `*` with one), so without it `cors` came out false for
// streams any visitor's browser plays fine.
const PROBE_ORIGIN = process.env.CORS_PROBE_ORIGIN || 'https://zhibo82.com';
const PROBE_HEADERS = { ...BROWSER_HEADERS, Origin: PROBE_ORIGIN };
const RANGE_BYTES = 16384;

const MANIFEST_CONTENT_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'application/dash+xml',
];
const MANIFEST_EXTENSIONS = ['.m3u8', '.mpd'];

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

let _cache = loadCache();

function getStatus(url) {
  return _cache[url] || null;
}

/**
 * A source URL was swapped for a fresh-token version of the same stream
 * (iptv.swapStaleUrls): start the new URL from the old one's last result
 * so its rank doesn't drop to 'unverified' until the next check gets to
 * it. Per-URL facts that belong to the old token (resolvedUrl, the hop
 * URLs) are cleared — screenshots.js would otherwise capture the expired
 * resolvedUrl. Never overwrites a result the new URL already has.
 */
function carryOver(fromUrl, toUrl) {
  const prev = _cache[fromUrl];
  if (!prev || _cache[toUrl]) return;
  _cache[toUrl] = { ...prev, resolvedUrl: toUrl, nestedUrl: null, segmentUrl: null, carriedFrom: fromUrl };
}

function persist() {
  saveCache(_cache);
}

function isBlockedByHeaders(headers) {
  const xfo = (headers['x-frame-options'] || '').toLowerCase();
  if (xfo.includes('deny') || xfo.includes('sameorigin')) return true;

  const csp = (headers['content-security-policy'] || '').toLowerCase();
  const m = csp.match(/frame-ancestors\s+([^;]+)/);
  if (m) {
    const value = m[1].trim();
    if (value === "'none'" || value === "'self'") return true;
  }
  return false;
}

function urlPathname(url) {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

// We already have the first ~2KB of the body in hand (Range: bytes=0-2047),
// so sniff it directly rather than trusting a Content-Type header — these
// third-party mirror CDNs frequently mislabel it (manifests served as
// application/octet-stream, or an HTML error page kept behind a .m3u8 URL).
function bodyLooksLikeManifest(buffer) {
  if (!buffer || !buffer.length) return null; // inconclusive — fall back to headers/extension
  const text = Buffer.from(buffer).toString('utf8');
  if (text.startsWith('#EXTM3U')) return true; // HLS
  if (/<MPD[\s>]/i.test(text)) return true; // DASH
  return false;
}

function isManifestUrl(url, contentType, buffer) {
  const sniff = bodyLooksLikeManifest(buffer);
  if (sniff !== null) return sniff;
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (MANIFEST_CONTENT_TYPES.includes(ct)) return true;
  return MANIFEST_EXTENSIONS.some((ext) => urlPathname(url).endsWith(ext));
}

function hasCorsHeader(headers) {
  const acao = headers['access-control-allow-origin'];
  return typeof acao === 'string' && acao.trim().length > 0;
}

/**
 * A master HLS playlist points at a sub-playlist; a media playlist points at
 * segment files; a DASH manifest is XML we don't attempt to parse (out of
 * scope for this fix). Returns the first referenced URL, resolved against
 * the manifest's own URL, or null if none found.
 */
function extractFirstReference(text, baseUrl) {
  const lines = text.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line && !line.startsWith('#')) {
      try {
        return new URL(line, baseUrl).toString();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The last URL a playlist references (its newest segment), resolved like extractFirstReference. */
function extractLastReference(text, baseUrl) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return null;
  try {
    return new URL(lines[lines.length - 1], baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Live, click-time resolution for /go — where does this URL point RIGHT
 * NOW, following redirects, no caching involved. Deliberately lighter than
 * checkUrl below (one hop, small range, no nested manifest/segment
 * verification): that machinery exists to CLASSIFY a source for the
 * dashboard/exports on a periodic cadence, this exists to get someone
 * watching as fast as possible at the moment they click.
 */
async function resolveNow(url) {
  try {
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { ...BROWSER_HEADERS, Range: 'bytes=0-1023' },
      responseType: 'arraybuffer',
    });
    if (res.status >= 400) return { ok: false, url: null, dangerous: false };
    const resolvedUrl = res.request?.res?.responseUrl || url;
    // A viewer clicking this app's own /go link should never end up
    // downloading an executable, whatever the periodic check last saw for
    // this URL — check live, right before the redirect actually happens.
    if (looksLikeDangerousFile(res.data, res.headers['content-type'], res.headers['content-disposition'], resolvedUrl)) {
      return { ok: false, url: null, dangerous: true };
    }
    return { ok: true, url: resolvedUrl, dangerous: false };
  } catch {
    return { ok: false, url: null, dangerous: false };
  }
}

/**
 * Fetch one hop and report reachability and CORS as SEPARATE facts, plus
 * the fetched bytes so the caller can inspect WHAT came back (another
 * playlist? real media?) — a master playlist can be perfectly reachable
 * while every segment it references is dead. Kept separate because "does
 * it work" and "can a browser fetch it" are different questions with
 * different answers, and conflating them is what made 'blocked' useless.
 */
/**
 * GET the first RANGE_BYTES of a URL. Asks with a Range header first; on a
 * 403, asks once more without it — some hosts refuse ranged requests
 * outright (cdn.stmify.com: 403 to Range from Railway, 200 to a plain GET),
 * and a browser player doesn't send Range for a manifest either. Both
 * requests are streamed and cut off after RANGE_BYTES or REQUEST_TIMEOUT_MS,
 * whichever comes first: a host that ignores Range and sends an endless TS
 * stream never goes idle, so axios's `timeout` (an idle timeout) never fires
 * (154.12.107.98:8000/play/* held one check for 15 minutes, and a pass that
 * doesn't finish blocks every later one). Resolves with axios's response,
 * `data` always a Buffer; rejects like axios on network errors.
 */
async function getFirstBytes(url) {
  const opts = { timeout: REQUEST_TIMEOUT_MS, maxRedirects: 5, validateStatus: () => true, responseType: 'stream' };
  const ranged = await axios.get(url, { ...opts, headers: { ...PROBE_HEADERS, Range: `bytes=0-${RANGE_BYTES - 1}` } });
  if (ranged.status !== 403) return readFirstBytes(ranged);
  ranged.data.destroy();
  const res = await readFirstBytes(await axios.get(url, { ...opts, headers: PROBE_HEADERS }));
  res.retriedWithoutRange = true;
  return res;
}

/** Replace a streamed response's `data` with its first RANGE_BYTES (at most REQUEST_TIMEOUT_MS of reading). */
async function readFirstBytes(res) {
  const chunks = [];
  let length = 0;
  await new Promise((resolve) => {
    const timer = setTimeout(done, REQUEST_TIMEOUT_MS);
    function done() {
      clearTimeout(timer);
      res.data.destroy();
      resolve();
    }
    res.data.on('data', (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      if (length >= RANGE_BYTES) done();
    });
    res.data.on('end', done);
    res.data.on('error', done);
  });
  res.data = Buffer.concat(chunks).subarray(0, RANGE_BYTES);
  return res;
}

// `url` is where the body actually came from after redirects: a playlist's
// relative references resolve against THAT, not the URL we asked for
// (jmp2.uk redirects to a Pluto host whose variants are relative paths).
async function probeOnce(url) {
  try {
    const res = await getFirstBytes(url);
    return {
      reachable: res.status < 400,
      httpStatus: res.status,
      url: res.request?.res?.responseUrl || url,
      cors: hasCorsHeader(res.headers),
      contentType: res.headers['content-type'] || null,
      data: res.data,
    };
  } catch {
    return { reachable: false, httpStatus: null, url, cors: false, contentType: null, data: null };
  }
}

const SEGMENT_RETRY_DELAY_MS = 1000;

/**
 * Fetch a media playlist's segment the way a player would: the newest one
 * first (hls.js starts a live stream near its end, and the oldest segment
 * may already have aged out of the CDN), then the oldest, and one more try
 * of each after a 5xx — players retry fragment loads, and cdnlivetv.tv
 * answers 503 to a good share of segment requests that succeed a second
 * later (measured 2026-10-28). Only when every attempt fails is the chain
 * not working. Returns the probe plus its media verdict and URL.
 */
async function probeSegment(playlistText, playlistUrl) {
  const candidates = [...new Set([extractLastReference(playlistText, playlistUrl), extractFirstReference(playlistText, playlistUrl)])].filter(Boolean);
  let failed = null;
  for (const segmentUrl of candidates) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, SEGMENT_RETRY_DELAY_MS));
      const hop = await probeOnce(segmentUrl);
      const mediaCheck = looksLikeBinaryMedia(hop.data, hop.contentType);
      const result = { ...hop, segmentUrl, mediaCheck, duration: segmentDurationFor(playlistText, playlistUrl, segmentUrl) };
      if (hop.reachable && mediaCheck !== false) return result;
      failed = failed || result;
      if (!(hop.httpStatus >= 500)) break;
    }
  }
  return failed;
}

/**
 * Seconds of video in `segmentUrl` per the media playlist: the #EXTINF
 * just before its line, else #EXT-X-TARGETDURATION, else null. Pure.
 */
function segmentDurationFor(playlistText, playlistUrl, segmentUrl) {
  let extinf = null;
  let target = null;
  for (const raw of String(playlistText || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const td = line.match(/^#EXT-X-TARGETDURATION:\s*([\d.]+)/);
    if (td) target = Number(td[1]);
    const inf = line.match(/^#EXTINF:\s*([\d.]+)/);
    if (inf) extinf = Number(inf[1]);
    if (line.startsWith('#')) continue;
    let resolved = null;
    try {
      resolved = new URL(line, playlistUrl).toString();
    } catch {
      // not a URL line
    }
    if (resolved === segmentUrl && extinf > 0) return extinf;
    extinf = null;
  }
  return target > 0 ? target : null;
}

// Whole-segment speed test. The first-bytes probe above only proves a
// segment starts arriving; a 6 s segment that takes 18 s to download can
// never play, it just buffers (measured 2026-11-03: 23.237.104.106 NBA TV
// 2.6 MB in 18.7 s, cdnlivetv segments not finishing in 20 s). A source
// whose segment takes longer than TOO_SLOW_RATIO x its own duration is
// "too slow". Runs at most every SPEED_TTL_MS per source (checkAll), since
// it downloads megabytes, not 16 KB. Measured from Railway's US datacenter:
// slow from there is slow for everyone, fast from there doesn't prove
// fast in China.
const SPEED_MAX_BYTES = 8 * 1024 * 1024;
const SPEED_MAX_MS = 20000;
const TOO_SLOW_RATIO = 0.8;
const SPEED_TTL_MS = 30 * 60 * 1000;

/**
 * Speed verdict from one download. Pure.
 *   seconds  - how long the download ran; bytes - how much arrived
 *   complete - the whole segment arrived (else it was cut at the time or
 *              byte cap, or the connection dropped)
 * `ratio` = seconds / segment duration. When incomplete it's only a lower
 * bound, so it can prove "too slow" but never "fast enough" (tooSlow null).
 */
function speedVerdict({ seconds, bytes, complete }, duration) {
  if (!(duration > 0)) return { seconds, bytes, complete, duration: null, ratio: null, tooSlow: null };
  const ratio = Math.round((seconds / duration) * 100) / 100;
  const tooSlow = ratio > TOO_SLOW_RATIO ? true : complete ? false : null;
  return { seconds, bytes, complete, duration, ratio, tooSlow };
}

// What a check result carries from a speed test (also copied forward by
// checkAll between tests).
function speedFields(speed, speedCheckedAt) {
  return {
    speed,
    speedCheckedAt,
    tooSlow: speed.tooSlow === true,
    ...(speed.tooSlow === true
      ? { error: `too slow: a ${speed.duration}s segment took ${speed.complete ? '' : 'over '}${speed.seconds}s to download (${speed.ratio}x real time)` }
      : {}),
  };
}

/**
 * Between speed tests (SPEED_TTL_MS) a fresh check carries the last test
 * forward, verdict included: a source found too slow stays hidden until
 * the next test says otherwise, instead of flapping back every 3 minutes.
 * Mutates and returns `result`.
 */
function carrySpeedForward(result, previous) {
  if (!previous || !previous.speed || !result.isManifest) return result;
  Object.assign(result, speedFields(previous.speed, previous.speedCheckedAt));
  if (result.tooSlow && result.working === true) {
    result.working = false;
    result.status = manifestStatus(false, result.cors);
  }
  return result;
}

function speedTestDue(previous, now = Date.now()) {
  return !previous || !previous.speedCheckedAt || now - new Date(previous.speedCheckedAt).getTime() > SPEED_TTL_MS;
}

async function measureSegmentSpeed(url, duration) {
  const start = Date.now();
  const elapsed = () => Math.round((Date.now() - start) / 100) / 10;
  let res;
  try {
    res = await axios.get(url, { timeout: SPEED_MAX_MS, maxRedirects: 5, validateStatus: () => true, responseType: 'stream', headers: PROBE_HEADERS });
  } catch (err) {
    // Not even response headers within the cap: nothing would ever play.
    if (/timeout/i.test(err.message) || err.code === 'ECONNABORTED') return speedVerdict({ seconds: elapsed(), bytes: 0, complete: false }, duration);
    return null;
  }
  if (res.status >= 400) {
    res.data.destroy();
    return null;
  }
  let bytes = 0;
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => finish('timeout'), Math.max(0, SPEED_MAX_MS - (Date.now() - start)));
    function finish(how) {
      clearTimeout(timer);
      res.data.destroy();
      resolve(how);
    }
    res.data.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes >= SPEED_MAX_BYTES) finish('cap');
    });
    res.data.on('end', () => finish('complete'));
    res.data.on('error', () => finish('error'));
  });
  if (outcome === 'error' && !bytes) return null;
  return speedVerdict({ seconds: elapsed(), bytes, complete: outcome === 'complete' }, duration);
}

/**
 * Status for a reachable manifest from the two separate facts. Pure, so
 * the mapping is testable without any network.
 *   working === false            -> 'dead'   (content confirmed broken)
 *   cors                         -> 'stream' (works, browser-playable)
 *   otherwise                    -> 'nocors' (works or unverified, but a
 *                                             browser can't fetch it directly)
 */
function manifestStatus(working, cors) {
  if (working === false) return 'dead';
  return cors ? 'stream' : 'nocors';
}

// After how many DEAD results IN A ROW a source counts as actually broken
// rather than just having a bad moment — a single failed probe is normal
// noise for third-party CDNs, three or four in a row (matching the ~3 min
// check cadence, so this spans ~10-12 minutes of real time) is not.
const FLAG_AFTER_FAILURES = 3;

// Pulled out as its own pure function (used by checkAll below) so the
// streak logic is directly unit-testable without spinning up a real
// network probe just to exercise it.
function nextConsecutiveFailures(status, previous) {
  return status === 'dead' ? (previous?.consecutiveFailures || 0) + 1 : 0;
}

/**
 * Internal ranking, layered on top of status/working/screenshot data —
 * "is this source actually worth using right now", collapsed to one word
 * instead of making every caller reconstruct it from four different fields:
 *
 *   dangerous    - the check flagged this as looking like an executable/
 *                  installer. Checked FIRST, overrides everything else —
 *                  even an old successful capture doesn't un-flag it, since
 *                  the danger signal is about what's there NOW.
 *   working      - has a real still AND a real gif capture, AND the latest
 *                  check agrees a visitor's browser can play it: a manifest
 *                  needs working === true and cors === true (every hop sent
 *                  Access-Control-Allow-Origin); an HTML page needs status
 *                  'ok' (cors is n/a for iframes). A capture alone isn't
 *                  enough — it's taken from one US datacenter, and older
 *                  captures were taken with web security off, so a stream
 *                  that later went dead or lacks CORS on a hop would
 *                  otherwise stay "working" for real visitors who can't
 *                  play it (measured 2026-10-18: 17 of 30 such sources).
 *   medium       - source-check says it's reachable/usable (ok/stream/
 *                  nocors), but there's no good capture yet or the check
 *                  doesn't back it up (no CORS, segment unverified) — new,
 *                  waiting its turn, or playable only via native/relay.
 *   unauthorized - confirmed 401/403. An access gate, not a broken link:
 *                  kept separate from 'low' on purpose, since this needs an
 *                  actual fix (headers, auth) rather than being written off.
 *   low          - confirmed dead, AND it's stayed that way for
 *                  FLAG_AFTER_FAILURES checks running — not a blip.
 *   unverified   - none of the above yet: never checked, or dead only once
 *                  or twice so far (too soon to call it broken).
 */
function browserPlayable(check) {
  if (!check) return false;
  if (check.isManifest === false) return check.status === 'ok';
  return check.working === true && check.cors === true;
}

function rankFor(check, shot) {
  if (check && check.status === 'dangerous') return 'dangerous';
  if (shot && shot.ok && shot.gifOk && browserPlayable(check)) return 'working';
  if (check && (check.httpStatus === 401 || check.httpStatus === 403)) return 'unauthorized';
  // Measured, not a blip: its segments download slower than they play.
  if (check && check.tooSlow) return 'low';
  if (check && (check.status === 'ok' || check.status === 'stream' || check.status === 'nocors')) return 'medium';
  if (check && check.status === 'dead' && (check.consecutiveFailures || 0) >= FLAG_AFTER_FAILURES) return 'low';
  return 'unverified';
}

/**
 * Region hint for a source from its host: the GEO_FENCED_HOSTS key
 * ('us-only') whose list contains the host or a parent domain of it, else
 * null. Pure, so testable without config files or network.
 */
function geoHintFor(url, fenced = GEO_FENCED_HOSTS) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [hint, hosts] of Object.entries(fenced)) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return hint;
  }
  return null;
}

// Extensions/content-types/magic bytes that mean "this is an executable or
// installer being served where a stream/page was expected" — a community-
// sourced playlist can point at literally anything, and a viewer clicking
// through this app's own link should never end up downloading one of these.
// Deliberately conservative (few, well-known signatures) so a legitimate
// mislabeled stream never gets caught by it — false negatives here are far
// cheaper than false positives blocking a working source.
const DANGEROUS_EXTENSIONS = ['.exe', '.msi', '.bat', '.cmd', '.scr', '.apk', '.dmg', '.pkg', '.jar', '.ps1'];
const DANGEROUS_CONTENT_TYPES = /x-msdownload|x-msdos-program|x-executable|vnd\.android\.package-archive|x-apple-diskimage|java-archive|x-ms-installer/i;

function looksLikeDangerousFile(buffer, contentType, contentDisposition, url) {
  if (contentDisposition && /attachment/i.test(contentDisposition)) return true;
  if (DANGEROUS_EXTENSIONS.some((ext) => urlPathname(url).endsWith(ext))) return true;
  if (contentType && DANGEROUS_CONTENT_TYPES.test(contentType)) return true;
  if (buffer && buffer.length >= 4) {
    const bytes = Buffer.from(buffer);
    if (bytes[0] === 0x4d && bytes[1] === 0x5a) return true; // 'MZ' — Windows PE (.exe/.dll)
    if (bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true; // ELF
  }
  return false;
}

// Best-effort — MPEG-TS segments start with sync byte 0x47; fMP4 segments
// have an 'ftyp'/'moof'/'styp' box near the start. Neither is a perfect
// test, so this only returns false for content that's CLEARLY not media
// (declared as text/HTML, or looks like printable text) — null means
// inconclusive (e.g. empty body), which callers should NOT penalize.
//
// The media signatures are checked BEFORE the declared type: plenty of
// small IPTV servers label every file text/plain (198.58.104.90:8989 serves
// real MPEG-TS that way, and players don't care), whereas an HTML/text
// error page never starts with a TS sync byte or an fMP4 box.
function looksLikeBinaryMedia(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  const bytes = Buffer.from(buffer);
  if (bytes[0] === 0x47) return true; // MPEG-TS sync byte
  const head = bytes.slice(0, 64).toString('latin1');
  if (head.includes('ftyp') || head.includes('moof') || head.includes('styp')) return true; // fMP4 box signatures
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('text/') || ct.includes('html')) return false;
  const sample = bytes.slice(0, 256);
  const printable = sample.filter((b) => b >= 32 && b < 127).length;
  return printable / sample.length < 0.85; // mostly non-printable -> treat as binary/media
}

/**
 * Probe one URL. Uses a ranged GET (not HEAD — many stream CDNs reject HEAD)
 * to avoid downloading the whole file — the range is generous (16KB) so a
 * full HLS manifest is captured even with many variants/segments listed.
 * A 403 to the ranged GET gets one capped plain GET (getFirstBytes).
 *
 * Every result carries two separate facts, exported alongside `status`:
 *   working - true  = a real media segment was fetched (HLS: verified up to
 *                     two hops deep — variant playlist, then a segment that
 *                     looks like actual binary media); HTML page: reachable
 *             false = a hop was unreachable or clearly not media
 *             null  = reachable but content unverified (no reference found,
 *                     DASH, inconclusive/empty body)
 *   cors    - true/false for manifests = every fetched hop sent
 *             Access-Control-Allow-Origin, i.e. hls.js on another origin can
 *             play it directly; null for HTML pages (iframes don't need it)
 *
 * status is one of:
 *   'ok'      - HTML page, reachable, not blocked from framing
 *   'stream'  - manifest that works (or is unverified) AND is CORS-open —
 *               needs a video player on the user's site, NOT a bare iframe
 *   'nocors'  - manifest that works (or is unverified) but some hop has no
 *               CORS header — fine in a native player, not in a browser
 *   'blocked' - HTML page blocked from framing (X-Frame-Options / CSP)
 *   'dead'    - unreachable (4xx/5xx, timeout, network error), or a manifest
 *               whose referenced content is confirmed broken
 *   'dangerous' - the response looks like an executable/installer (magic
 *               bytes, Content-Disposition: attachment, or a known-bad
 *               extension/content-type) — never treated as usable, and
 *               /go refuses to redirect a viewer into downloading it
 */
async function checkUrl(url, { measureSpeed = false } = {}) {
  try {
    // A 403 to the ranged request is retried once without Range before
    // this counts as dead/unauthorized — see getFirstBytes.
    const res = await getFirstBytes(url);
    const checkedAt = new Date().toISOString();
    // The URL the host actually served after redirects — stream CDNs
    // commonly bounce a stable URL to a per-session tokenized one, and the
    // token expires, so re-capturing it on every check (see the source
    // check schedule in index.js) is what keeps the exported URL playable.
    const resolvedUrl = res.request?.res?.responseUrl || url;
    if (res.status >= 400) {
      return { status: 'dead', working: false, cors: null, resolvedUrl, httpStatus: res.status, checkedAt };
    }

    const contentType = res.headers['content-type'] || null;
    if (looksLikeDangerousFile(res.data, contentType, res.headers['content-disposition'], resolvedUrl)) {
      return {
        status: 'dangerous',
        working: false,
        cors: null,
        resolvedUrl,
        httpStatus: res.status,
        contentType,
        error: 'looks like an executable/installer, not a stream or page — blocked',
        checkedAt,
      };
    }

    const isManifest = isManifestUrl(url, contentType, res.data);

    if (isManifest) {
      let cors = hasCorsHeader(res.headers);
      let working = null;
      let nestedUrl = null;
      let nestedOk = null;
      let segmentUrl = null;
      let segmentOk = null;
      let segmentDuration = null;

      // Verify the referenced content for HLS (.m3u8) regardless of CORS —
      // "does it work" is a separate question from "can a browser fetch
      // it". DASH's XML segment templates are out of scope, so an .mpd
      // only gets the outer check (working stays null).
      // References resolve against resolvedUrl — where the playlist was
      // actually served from after redirects — never the URL we asked for.
      // HLS is recognised by its body, not a .m3u8 in the URL: short
      // redirect links, this app's own /go and /api/relay/stream (the
      // visitor-path probe, checkVisitorPath) have no extension at all.
      const text = Buffer.from(res.data).toString('utf8');
      if (text.startsWith('#EXTM3U')) {
        if (/#EXTINF/.test(text)) {
          // Already a media playlist: its references are segments, so
          // probe them like a player would (see probeSegment).
          const seg = await probeSegment(text, resolvedUrl);
          if (seg) {
            nestedUrl = segmentUrl = seg.segmentUrl;
            segmentDuration = seg.duration;
            nestedOk = seg.reachable;
            segmentOk = seg.reachable && seg.mediaCheck !== false;
            if (!segmentOk) {
              working = false;
            } else {
              working = seg.mediaCheck === true ? true : null;
              cors = cors && seg.cors;
            }
          }
        } else {
          nestedUrl = extractFirstReference(text, resolvedUrl);
        }
        if (nestedUrl && !segmentUrl) {
          const hop1 = await probeOnce(nestedUrl);
          nestedOk = hop1.reachable;
          if (!hop1.reachable) {
            working = false;
          } else {
            cors = cors && hop1.cors;
            // hop1 is usually another (variant) playlist, not real video
            // bytes yet — if so, follow one more hop to an actual segment.
            // Only a confirmed-false media verdict (not null/inconclusive)
            // marks a chain as not working.
            const hop1IsManifest = bodyLooksLikeManifest(hop1.data);
            const hop1Text = Buffer.from(hop1.data || '').toString('utf8');
            if (hop1IsManifest && hop1Text.startsWith('#EXTM3U')) {
              const hop2 = await probeSegment(hop1Text, hop1.url);
              if (hop2) {
                segmentUrl = hop2.segmentUrl;
                segmentDuration = hop2.duration;
                segmentOk = hop2.reachable && hop2.mediaCheck !== false;
                if (!segmentOk) {
                  working = false;
                } else {
                  working = hop2.mediaCheck === true ? true : null;
                  cors = cors && hop2.cors;
                }
              }
            } else if (hop1IsManifest === false) {
              // hop1 wasn't a nested playlist — treat it as the segment itself.
              segmentUrl = nestedUrl;
              const mediaCheck = looksLikeBinaryMedia(hop1.data, hop1.contentType);
              segmentOk = mediaCheck !== false;
              working = mediaCheck === false ? false : mediaCheck === true ? true : null;
            }
            // hop1IsManifest === null (inconclusive/empty body) -> unverified
          }
        }
      }

      // A segment that arrives, but slower than it plays, never plays.
      let speed = null;
      if (measureSpeed && working === true && segmentUrl && segmentDuration) {
        speed = await measureSegmentSpeed(segmentUrl, segmentDuration);
        if (speed && speed.tooSlow) working = false;
      }

      return {
        status: manifestStatus(working, cors),
        working,
        cors,
        resolvedUrl,
        httpStatus: res.status,
        contentType,
        isManifest: true,
        nestedUrl,
        nestedOk,
        segmentUrl,
        segmentOk,
        segmentDuration,
        ...(speed ? speedFields(speed, checkedAt) : {}),
        checkedAt,
      };
    }

    // Raw video with no playlist (an endless MPEG-TS at 154.12.107.98:8000/
    // play/*): neither a page to frame nor something hls.js can play.
    if (!/html/i.test(contentType || '') && looksLikeBinaryMedia(res.data, contentType) === true) {
      return {
        status: 'dead',
        working: false,
        cors: null,
        resolvedUrl,
        httpStatus: res.status,
        contentType,
        isManifest: false,
        error: 'raw media stream, not a playlist or page — a browser player cannot play it',
        checkedAt,
      };
    }

    return {
      status: isBlockedByHeaders(res.headers) ? 'blocked' : 'ok',
      working: true,
      cors: null,
      resolvedUrl,
      httpStatus: res.status,
      contentType,
      isManifest: false,
      checkedAt,
    };
  } catch (err) {
    return {
      status: 'dead',
      working: false,
      cors: null,
      error: err.message,
      isManifest: MANIFEST_EXTENSIONS.some((ext) => urlPathname(url).endsWith(ext)),
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Does the source play the way a visitor's button plays it? The sites link
 * `${goBase}/go?u=<source>`, and /go either redirects to this app's relay
 * proxy or straight to the source (doms9 sources, relay down, unsupported
 * type). checkUrl on that link follows the same redirect and verifies the
 * playlist -> variant -> segment chain through whichever path /go picked —
 * so a stream that works when fetched directly but breaks inside the relay
 * (Amagi segments, 2026-11-03) shows up as not working.
 * Returns { working: true/false/null, path: 'relay' | 'direct' | null }.
 */
//
// /go is asked for its redirect first, unfollowed: if this app's own server
// can't be reached (not listening yet), that's no verdict at all — never a
// false that would hide every source.
async function checkVisitorPath(url, goBase) {
  const goUrl = `${goBase}/go?u=${encodeURIComponent(url)}`;
  let hop;
  try {
    hop = await axios.get(goUrl, { timeout: REQUEST_TIMEOUT_MS, maxRedirects: 0, validateStatus: () => true, responseType: 'stream' });
    hop.data.destroy();
  } catch {
    return { working: null, path: null };
  }
  // 502: /go couldn't resolve it at click time — a visitor gets the error page
  if (hop.status === 502) return { working: false, path: null };
  const location = hop.headers.location;
  if (hop.status < 300 || hop.status >= 400 || !location) return { working: null, path: null };
  const next = new URL(location, goUrl);
  const path = next.origin === new URL(goUrl).origin && next.pathname === '/api/relay/stream' ? 'relay' : 'direct';
  const r = await checkUrl(next.toString());
  return { working: r.working === undefined ? null : r.working, path };
}

/**
 * The verdict the sites act on (exported as sourceWorking — the plugins
 * hide a source when it's false): can a visitor outside the US play it?
 *   - the source check says broken                      -> false
 *   - DASH (.mpd): the plugins' player is hls.js only   -> false
 *   - the visitor-path probe (checkVisitorPath) failed  -> false
 *   - /go sends visitors straight to a US-only CDN      -> false (this check
 *     runs from a US datacenter, so the stream itself looks fine)
 *   - otherwise the visitor probe's true, else the check's own working.
 * Pure, so testable without network.
 */
function visitorPlayable(check, url) {
  if (!check) return null;
  const working = check.working === undefined ? null : check.working;
  if (working === false) return false;
  if (check.isManifest !== false && isDash(check, url)) return false;
  if (check.visitorWorking === false) return false;
  if (check.visitorPath === 'direct' && geoHintFor(check.resolvedUrl || url) === 'us-only') return false;
  return check.visitorWorking === true ? true : working;
}

function isDash(check, url) {
  if (/dash\+xml/i.test(check.contentType || '')) return true;
  return [check.resolvedUrl, url].some((u) => u && urlPathname(u).endsWith('.mpd'));
}

/**
 * Check every URL in `urls` (deduped), skipping ones already checked within
 * their TTL unless `force` — manifests use a shorter TTL than HTML pages
 * since they're far more likely to rotate/die within hours. Runs with
 * limited concurrency, saving the cache incrementally so a crash/redeploy
 * mid-run doesn't lose progress. `onProgress(done, total)` is called after
 * each URL.
 */
//
// `relayProbe(url, result)` (optional, from index.js while the relay is on
// and healthy) answers "does this stream play THROUGH the relay" for HLS
// sources — true/false/null, stored as `relayPlayable`. A stream that's
// 'nocors' (browser can't fetch it directly) but relayPlayable is playable
// via /go, which hands viewers the relay proxy. Without a probe the field
// is null (relay off / not applicable), never a stale true.
//
// `visitorProbe(url, result)` (optional, from index.js: checkVisitorPath on
// this app's own /go) -> { working, path }, stored as visitorWorking /
// visitorPath for sourceWorking (visitorPlayable). When it went through
// the relay it also answers relayPlayable, so without a relayProbe the
// relay isn't asked the same question twice per pass.
async function checkAll(urls, { force = false, onProgress, relayProbe = null, visitorProbe = null } = {}) {
  const unique = [...new Set(urls)];
  const now = Date.now();
  const toCheck = unique.filter((u) => {
    if (force) return true;
    const cached = _cache[u];
    if (!cached) return true;
    const ttl = cached.isManifest ? MANIFEST_TTL_MS : CHECK_TTL_MS;
    return now - new Date(cached.checkedAt).getTime() > ttl;
  });

  const summary = {
    total: unique.length,
    checked: 0,
    ok: 0,
    stream: 0,
    nocors: 0,
    blocked: 0,
    dead: 0,
    dangerous: 0,
    relayPlayable: 0,
    skipped: unique.length - toCheck.length,
  };

  let index = 0;
  async function worker() {
    while (index < toCheck.length) {
      const i = index++;
      const url = toCheck[i];
      const previous = _cache[url];
      const speedDue = force || speedTestDue(previous);
      const result = await checkUrl(url, { measureSpeed: speedDue });
      if (!speedDue) carrySpeedForward(result, previous);
      // A transient blip (one bad probe) shouldn't demote a source that's
      // otherwise fine — only a RUN of dead results in a row means it's
      // actually broken, not unlucky timing. Reset to 0 the moment it's
      // reachable again, whatever state it was in before.
      result.consecutiveFailures = nextConsecutiveFailures(result.status, previous);
      result.relayPlayable = null;
      result.visitorWorking = null;
      result.visitorPath = null;
      if (visitorProbe && result.isManifest && result.status !== 'dangerous' && result.working !== false) {
        try {
          const v = await visitorProbe(url, result);
          result.visitorWorking = v ? v.working : null;
          result.visitorPath = v ? v.path : null;
          if (!relayProbe && result.visitorPath === 'relay') result.relayPlayable = result.visitorWorking;
        } catch {
          result.visitorWorking = null;
        }
      }
      if (relayProbe && result.isManifest && result.status !== 'dangerous') {
        try {
          result.relayPlayable = await relayProbe(url, result);
        } catch {
          result.relayPlayable = null;
        }
      }
      if (result.relayPlayable === true) summary.relayPlayable++;
      _cache[url] = result;
      summary.checked++;
      summary[result.status]++;
      // Every 5th, not every single one — hundreds of URLs at this
      // concurrency would otherwise mean hundreds of disk writes per pass
      // for a safety net that only needs to bound how much a crash loses,
      // not eliminate loss entirely.
      if (summary.checked % 5 === 0) saveCache(_cache);
      if (onProgress) onProgress(summary.checked + summary.skipped, unique.length);
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, toCheck.length) }, worker);
  await Promise.all(workers);
  saveCache(_cache);
  return summary;
}

/**
 * Returns NEW row objects (never mutates `rows`) with three arrays added to
 * each channel, each parallel to and the same length as `sources`:
 *   sourceStatuses - status string ('ok'/'stream'/'nocors'/'blocked'/'dead')
 *                    or null (never checked)
 *   sourceWorking  - can a visitor outside the US play it, the way the
 *                    sites play it (through /go): true / false / null
 *                    (unverified or never checked) — see visitorPlayable
 *   sourceVisitorPath - where /go sends visitors: 'relay' / 'direct' / null
 *   sourceSpeedRatio - segment download time / segment duration from the
 *                    last speed test (> TOO_SLOW_RATIO = too slow), or null
 *   sourceCors     - true / false / null (n/a for HTML pages, or never checked)
 *   sourceResolved - the URL the host actually served after redirects (e.g.
 *                    its tokenized per-session URL) when it differs from
 *                    the source URL, else null — an audit fact, not what's
 *                    actually exported in `sources` (see below)
 *   sourceScreenshot - link to the latest capture of what the source shows
 *                    (screenshots.js), or null when there is none
 *   sourceGif      - link to a short (few-second) animated capture of the
 *                    same source, alongside but separate from the still —
 *                    video sources only (screenshots.js), null otherwise
 *   sourceRank     - one of 'working' / 'medium' / 'unauthorized' / 'low' /
 *                    'unverified' (see rankFor above) — the single-word
 *                    answer to "is this actually usable right now"
 *   sourceGeo      - 'us-only' when the resolved host is a known geo-fenced
 *                    CDN (see geoHintFor), else null — a hint, not a rank
 * Used to label fixtures.csv/fixtures.json exports, not just the /browse
 * page's dots. `getSourceStatus` / `getScreenshot` are injectable so this
 * is testable with fakes (and screenshots.js can depend on this module
 * without a require cycle).
 */
function enrichRowsWithSourceStatus(rows, getSourceStatus = getStatus, { getScreenshot = () => null, publicBaseUrl = '' } = {}) {
  return rows.map((r) => ({
    ...r,
    channels: (r.channels || []).map((ch) => {
      const sources = ch.sources || [];
      const results = sources.map((url) => getSourceStatus(url) || null);
      // A periodic check is only ever as fresh as its last run (every 3 min
      // by default) — a per-session CDN token can still rotate in the gap
      // between that check and whenever someone actually opens the link.
      // `sources` in the export is this app's own /go redirect, which
      // re-resolves live at click time and closes that gap entirely,
      // instead of exporting either the stale original match or a
      // snapshot that's already a few minutes old by the time it's used.
      const playable = sources.map((url) => `${publicBaseUrl}/go?u=${encodeURIComponent(url)}`);
      return orderForVisitors({
        ...ch,
        sources: playable,
        sourceStatuses: results.map((s) => s?.status || null),
        sourceWorking: results.map((s, i) => visitorPlayable(s, sources[i])),
        sourceVisitorPath: results.map((s) => (s && s.visitorPath) || null),
        // Last whole-segment speed test: download time / segment duration
        // (above TOO_SLOW_RATIO = too slow, hidden). null = not measured.
        sourceSpeedRatio: results.map((s) => (s && s.speed && typeof s.speed.ratio === 'number' ? s.speed.ratio : null)),
        sourceCors: results.map((s) => (s && s.cors !== undefined ? s.cors : null)),
        // Plays through the relay proxy (true/false), null = relay off,
        // not HLS, or never checked with the relay on. See checkAll.
        sourceRelayPlayable: results.map((s) => (s && typeof s.relayPlayable === 'boolean' ? s.relayPlayable : null)),
        sourceResolved: results.map((s, i) => (s?.resolvedUrl && s.resolvedUrl !== sources[i] ? s.resolvedUrl : null)),
        // Our own capture first; when there's none, the relay's thumbnail
        // (fetched server-side and saved to disk — see screenshots.js
        // saveRelayThumb), so the link never carries a relay URL.
        sourceScreenshot: sources.map((url) => {
          const shot = getScreenshot(url);
          if (shot && shot.ok && shot.file) return `${publicBaseUrl}/screenshots/${shot.file}`;
          return shot && shot.relayThumbFile ? `${publicBaseUrl}/screenshots/${shot.relayThumbFile}` : null;
        }),
        // Same index entry as sourceScreenshot, just the gif half of it —
        // grouped with the still by sharing that lookup, not folded into
        // the same field, so nothing already reading sourceScreenshot sees
        // its shape change.
        sourceGif: sources.map((url) => {
          const shot = getScreenshot(url);
          return shot && shot.gifOk && shot.gifFile ? `${publicBaseUrl}/screenshots/${shot.gifFile}` : null;
        }),
        sourceRank: sources.map((url, i) => rankFor(results[i], getScreenshot(url))),
        // 'us-only' when the host the source resolves to is a known
        // geo-fenced CDN (config.js GEO_FENCED_HOSTS), else null.
        sourceGeo: sources.map((url, i) => geoHintFor(results[i]?.resolvedUrl || url)),
      });
    }),
  }));
}

// Every per-source array of an enriched channel, parallel to `sources`.
const PARALLEL_SOURCE_FIELDS = [
  'sources', 'sourceStatuses', 'sourceWorking', 'sourceVisitorPath', 'sourceSpeedRatio', 'sourceCors',
  'sourceRelayPlayable', 'sourceResolved', 'sourceScreenshot', 'sourceGif', 'sourceRank', 'sourceGeo',
];

// Relayed sources start in 3-7 s for a visitor abroad; direct hosts often
// take 9-23 s or never start, which the US-based check can't see. So the
// export lists relayed first, then direct, then never-probed, and sources a
// visitor can't play (sourceWorking false) last. Stable within each group,
// and every parallel array moves together.
function orderForVisitors(ch) {
  const n = ch.sources.length;
  const group = (i) => {
    if (ch.sourceWorking[i] === false) return 3;
    if (ch.sourceVisitorPath[i] === 'relay') return 0;
    return ch.sourceVisitorPath[i] === 'direct' ? 1 : 2;
  };
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => group(a) - group(b) || a - b);
  if (order.every((v, i) => v === i)) return ch;
  const out = { ...ch };
  for (const key of PARALLEL_SOURCE_FIELDS) out[key] = order.map((i) => ch[key][i]);
  return out;
}

module.exports = {
  segmentDurationFor,
  speedVerdict,
  measureSegmentSpeed,
  carrySpeedForward,
  speedTestDue,
  TOO_SLOW_RATIO,
  checkVisitorPath,
  visitorPlayable,
  getStatus,
  carryOver,
  persist,
  resolveNow,
  checkAll,
  checkUrl,
  rankFor,
  geoHintFor,
  FLAG_AFTER_FAILURES,
  nextConsecutiveFailures,
  manifestStatus,
  enrichRowsWithSourceStatus,
  bodyLooksLikeManifest,
  looksLikeBinaryMedia,
  looksLikeDangerousFile,
  isManifestUrl,
  isBlockedByHeaders,
  hasCorsHeader,
  extractFirstReference,
};
