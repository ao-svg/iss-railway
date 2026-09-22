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
// hundreds of third-party URLs live. Same caveat as config.js: this file
// lives on Railway's ephemeral disk and resets on redeploy.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'source-checks.json');
const CHECK_TTL_MS = 12 * 60 * 60 * 1000; // HTML pages — comparatively stable
const MANIFEST_TTL_MS = 2 * 60 * 60 * 1000; // manifests — these CDNs rotate/die within hours
const REQUEST_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

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

/**
 * Fetch one hop and report reachability and CORS as SEPARATE facts, plus
 * the fetched bytes so the caller can inspect WHAT came back (another
 * playlist? real media?) — a master playlist can be perfectly reachable
 * while every segment it references is dead. Kept separate because "does
 * it work" and "can a browser fetch it" are different questions with
 * different answers, and conflating them is what made 'blocked' useless.
 */
async function probeOnce(url) {
  try {
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { Range: 'bytes=0-16383' },
      responseType: 'arraybuffer',
    });
    return {
      reachable: res.status < 400,
      cors: hasCorsHeader(res.headers),
      contentType: res.headers['content-type'] || null,
      data: res.data,
    };
  } catch {
    return { reachable: false, cors: false, contentType: null, data: null };
  }
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

// Best-effort — MPEG-TS segments start with sync byte 0x47; fMP4 segments
// have an 'ftyp'/'moof'/'styp' box near the start. Neither is a perfect
// test, so this only returns false for content that's CLEARLY not media
// (declared as text/HTML, or looks like printable text) — null means
// inconclusive (e.g. empty body), which callers should NOT penalize.
function looksLikeBinaryMedia(buffer, contentType) {
  if (!buffer || !buffer.length) return null;
  const ct = (contentType || '').toLowerCase();
  if (ct.startsWith('text/') || ct.includes('html')) return false;
  const bytes = Buffer.from(buffer);
  if (bytes[0] === 0x47) return true; // MPEG-TS sync byte
  const head = bytes.slice(0, 64).toString('latin1');
  if (head.includes('ftyp') || head.includes('moof') || head.includes('styp')) return true; // fMP4 box signatures
  const sample = bytes.slice(0, 256);
  const printable = sample.filter((b) => b >= 32 && b < 127).length;
  return printable / sample.length < 0.85; // mostly non-printable -> treat as binary/media
}

/**
 * Probe one URL. Uses a ranged GET (not HEAD — many stream CDNs reject HEAD)
 * to avoid downloading the whole file — the range is generous (16KB) so a
 * full HLS manifest is captured even with many variants/segments listed.
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
 */
async function checkUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { Range: 'bytes=0-16383' },
      responseType: 'arraybuffer',
    });
    const checkedAt = new Date().toISOString();
    if (res.status >= 400) {
      return { status: 'dead', working: false, cors: null, httpStatus: res.status, checkedAt };
    }

    const contentType = res.headers['content-type'] || null;
    const isManifest = isManifestUrl(url, contentType, res.data);

    if (isManifest) {
      let cors = hasCorsHeader(res.headers);
      let working = null;
      let nestedUrl = null;
      let nestedOk = null;
      let segmentUrl = null;
      let segmentOk = null;

      // Verify the referenced content for HLS (.m3u8) regardless of CORS —
      // "does it work" is a separate question from "can a browser fetch
      // it". DASH's XML segment templates are out of scope, so an .mpd
      // only gets the outer check (working stays null).
      if (urlPathname(url).endsWith('.m3u8')) {
        const text = Buffer.from(res.data).toString('utf8');
        nestedUrl = extractFirstReference(text, url);
        if (nestedUrl) {
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
            if (hop1IsManifest && urlPathname(nestedUrl).endsWith('.m3u8')) {
              const hop1Text = Buffer.from(hop1.data).toString('utf8');
              segmentUrl = extractFirstReference(hop1Text, nestedUrl);
              if (segmentUrl) {
                const hop2 = await probeOnce(segmentUrl);
                const mediaCheck = looksLikeBinaryMedia(hop2.data, hop2.contentType);
                segmentOk = hop2.reachable && mediaCheck !== false;
                if (!hop2.reachable || mediaCheck === false) {
                  working = false;
                } else {
                  working = mediaCheck === true ? true : null;
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

      return {
        status: manifestStatus(working, cors),
        working,
        cors,
        httpStatus: res.status,
        contentType,
        isManifest: true,
        nestedUrl,
        nestedOk,
        segmentUrl,
        segmentOk,
        checkedAt,
      };
    }

    return {
      status: isBlockedByHeaders(res.headers) ? 'blocked' : 'ok',
      working: true,
      cors: null,
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
 * Check every URL in `urls` (deduped), skipping ones already checked within
 * their TTL unless `force` — manifests use a shorter TTL than HTML pages
 * since they're far more likely to rotate/die within hours. Runs with
 * limited concurrency, saving the cache incrementally so a crash/redeploy
 * mid-run doesn't lose progress. `onProgress(done, total)` is called after
 * each URL.
 */
async function checkAll(urls, { force = false, onProgress } = {}) {
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
    skipped: unique.length - toCheck.length,
  };

  let index = 0;
  async function worker() {
    while (index < toCheck.length) {
      const i = index++;
      const url = toCheck[i];
      const result = await checkUrl(url);
      _cache[url] = result;
      summary.checked++;
      summary[result.status]++;
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
 *   sourceWorking  - true / false / null (unverified or never checked)
 *   sourceCors     - true / false / null (n/a for HTML pages, or never checked)
 * Used to label fixtures.csv/fixtures.json exports, not just the /browse
 * page's dots. `getSourceStatus` is injectable so this is testable with fakes.
 */
function enrichRowsWithSourceStatus(rows, getSourceStatus = getStatus) {
  return rows.map((r) => ({
    ...r,
    channels: (r.channels || []).map((ch) => {
      const results = (ch.sources || []).map((url) => getSourceStatus(url) || null);
      return {
        ...ch,
        sourceStatuses: results.map((s) => s?.status || null),
        sourceWorking: results.map((s) => (s && s.working !== undefined ? s.working : null)),
        sourceCors: results.map((s) => (s && s.cors !== undefined ? s.cors : null)),
      };
    }),
  }));
}

module.exports = {
  getStatus,
  checkAll,
  checkUrl,
  manifestStatus,
  enrichRowsWithSourceStatus,
  bodyLooksLikeManifest,
  looksLikeBinaryMedia,
  isManifestUrl,
  isBlockedByHeaders,
  hasCorsHeader,
  extractFirstReference,
};
