// SERVER-ONLY client for the Relay service — a separate Railway service
// (not modified from here) that proxies HLS resources and grabs stream
// thumbnails. Never import this from anything rendered to the browser.
//
// HARD RULE: RELAY_SECRET never reaches the browser — not in HTML, JS,
// API responses, playlist contents, redirects, error messages or logs.
// Browsers only ever talk to this app's own /api/relay/* routes (see
// server.js); those fetch the relay server-side, rewrite every URI in a
// playlist back to /api/relay/stream, and refuse to emit anything that
// still contains the relay host or "secret=".
//
// Env (server-side only):
//   RELAY_SECRET        required — startup fails fast without it.
//   RELAY_INTERNAL_URL  preferred base for every relay call (private network).
//   RELAY_URL           fallback base when RELAY_INTERNAL_URL is unset.
//
// Env is read per call so tests can set it per case.

const crypto = require('crypto');
const axios = require('axios');

const ALLOWED_EXTENSIONS = ['.m3u8', '.ts', '.aac', '.mp4', '.key', '.vtt'];
const PLAYLIST_CT_RE = /mpegurl/i;
const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;

const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

function relayBase() {
  return trimSlash(process.env.RELAY_INTERNAL_URL) || trimSlash(process.env.RELAY_URL);
}

function relaySecret() {
  return process.env.RELAY_SECRET || '';
}

function isRelayConfigured() {
  return Boolean(relaySecret() && relayBase());
}

// Called once at startup (index.js), only while the relay is switched on.
function assertRelayConfig() {
  if (!relaySecret()) throw new Error('RELAY_SECRET is not set — refusing to start (see .env.example)');
  if (!relayBase()) throw new Error('Neither RELAY_INTERNAL_URL nor RELAY_URL is set — refusing to start');
}

// Strips the secret (by value and as a query param) from anything that
// might be logged or surfaced.
function redact(text) {
  let s = String(text ?? '');
  const secret = relaySecret();
  if (secret) {
    s = s.split(secret).join('[REDACTED]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) s = s.split(encoded).join('[REDACTED]');
  }
  return s.replace(/secret=[^&\s"']*/gi, 'secret=[REDACTED]');
}

function relayRequestUrl(route, target) {
  return `${relayBase()}/${route}?secret=${encodeURIComponent(relaySecret())}&url=${encodeURIComponent(target)}`;
}

const relayStreamRequestUrl = (target) => relayRequestUrl('stream', target);
const relayThumbRequestUrl = (target) => relayRequestUrl('thumb', target);
const relayHealthUrl = () => `${relayBase()}/health`;

/**
 * The URL exactly as given if it's http(s) with a path ending in an
 * allowed extension, null otherwise. Returned verbatim (not re-serialized)
 * so allowlist lookups match the exact string the source list holds.
 */
function validateTarget(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const pathname = u.pathname.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return null;
  return raw;
}

// A media extension wins over the content type: the live relay labels
// some .ts segments application/vnd.apple.mpegurl (seen 2026-10-11 on an
// Amagi stream), and treating 1-2MB of video as a playlist to rewrite
// broke playback.
const MEDIA_EXTENSIONS = ALLOWED_EXTENSIONS.filter((ext) => ext !== '.m3u8');
const isPlaylist = (target, contentType) => {
  const pathname = new URL(target).pathname.toLowerCase();
  if (pathname.endsWith('.m3u8')) return true;
  if (MEDIA_EXTENSIONS.some((ext) => pathname.endsWith(ext))) return false;
  return PLAYLIST_CT_RE.test(contentType || '');
};

// Per-process key for signing the segment/key/subtitle URLs this app
// itself writes into rewritten playlists, so /api/relay/stream can accept
// them without being an open proxy for arbitrary URLs. A restart just
// invalidates old signatures; live players re-fetch playlists constantly.
const SIGNING_KEY = crypto.randomBytes(32);

function sign(target) {
  return crypto.createHmac('sha256', SIGNING_KEY).update(target).digest('base64url');
}

function verifySignature(target, sig) {
  if (typeof sig !== 'string' || !sig) return false;
  const expected = Buffer.from(sign(target));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function localStreamPath(original) {
  return `/api/relay/stream?url=${encodeURIComponent(original)}&sig=${sign(original)}`;
}

/**
 * Rewrites a relay-served playlist so every URI (plain URI lines and
 * URI="..." attributes on any tag — EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA,
 * EXT-X-I-FRAME-STREAM-INF, ...) becomes a local /api/relay/stream path.
 * The original target is taken from the relay URI's `url` param; a URI
 * without one (not relay-shaped) is resolved against `playlistTarget`.
 * Throws if the result would still leak the relay host or a secret —
 * callers turn that into a generic 502.
 */
function rewritePlaylist(text, playlistTarget) {
  const base = relayBase();
  const relayHost = base ? new URL(base).host : null;

  const toLocal = (uri) => {
    let original;
    try {
      // Only a relay-shaped link (…/stream?url=…) carries the original in
      // its url param; anything else is a plain URI relative to the playlist.
      const abs = new URL(uri, base ? `${base}/stream` : playlistTarget);
      if (abs.pathname.endsWith('/stream')) original = abs.searchParams.get('url');
      if (!original) original = new URL(uri, playlistTarget).toString();
    } catch {
      return null;
    }
    return localStreamPath(original);
  };

  const out = String(text)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]*)"/g, (m, uri) => {
          const local = toLocal(uri);
          return local ? `URI="${local}"` : m;
        });
      }
      return toLocal(trimmed) ?? '';
    })
    .join('\n');

  const secret = relaySecret();
  if (/secret=/i.test(out) || (secret && out.includes(secret)) || (relayHost && out.includes(relayHost))) {
    throw new Error('rewritten playlist still references the relay');
  }
  return out;
}

/**
 * Relay /health, cached briefly so a busy /health endpoint can't hammer
 * it. Resolves to { ok, ffmpeg } — never the URL, never the secret.
 */
let _healthCache = { at: 0, value: null };
const HEALTH_CACHE_MS = 10000;

async function relayHealth({ timeoutMs = 5000, force = false } = {}) {
  if (!force && _healthCache.value && Date.now() - _healthCache.at < HEALTH_CACHE_MS) return _healthCache.value;
  let value;
  if (!relayBase()) {
    value = { ok: false, ffmpeg: null };
  } else {
    try {
      const res = await axios.get(relayHealthUrl(), { timeout: timeoutMs, validateStatus: () => true });
      const body = res.data && typeof res.data === 'object' ? res.data : {};
      value = {
        ok: res.status === 200 && body.ok === true,
        ffmpeg: typeof body.ffmpeg === 'boolean' ? body.ffmpeg : null,
      };
    } catch {
      value = { ok: false, ffmpeg: null };
    }
  }
  _healthCache = { at: Date.now(), value };
  return value;
}

/**
 * Diagnostic: health plus how the relay treats RELAY_SECRET, from two
 * /stream calls with no url — ours, and a deliberately wrong secret:
 *   'ok'           ours gets past auth (400 missing url), wrong one gets 401
 *   'rejected'     ours gets 401
 *   'not-enforced' a wrong secret gets past auth too — the relay isn't
 *                  checking secrets at all (seen on the live relay 2026-10-11)
 *   'unknown'      anything else
 * Output is safe to log.
 */
async function checkRelayAuth({ timeoutMs = 8000 } = {}) {
  const health = await relayHealth({ timeoutMs, force: true });
  let auth = 'unknown';
  if (health.ok && relaySecret()) {
    const probe = (secret) =>
      axios
        .get(`${relayBase()}/stream?secret=${encodeURIComponent(secret)}`, { timeout: timeoutMs, validateStatus: () => true })
        .then((r) => r.status, () => null);
    const [ours, wrong] = await Promise.all([probe(relaySecret()), probe(`wrong-${crypto.randomBytes(8).toString('hex')}`)]);
    if (ours === 401) auth = 'rejected';
    else if (ours === 400 && wrong === 401) auth = 'ok';
    else if (ours === 400 && wrong === 400) auth = 'not-enforced';
  }
  return { ...health, auth };
}

// First bytes of a response body, then the connection is dropped — the
// relay ignores Range, so this is how a probe avoids pulling whole segments.
async function fetchHead(url, { timeoutMs, maxBytes = 16384 }) {
  const res = await axios.get(url, { responseType: 'stream', timeout: timeoutMs, maxRedirects: 0, validateStatus: () => true });
  const chunks = [];
  let size = 0;
  await new Promise((resolve) => {
    const done = () => {
      res.data.destroy();
      resolve();
    };
    res.data.on('data', (c) => {
      chunks.push(c);
      size += c.length;
      if (size >= maxBytes) done();
    });
    res.data.on('end', resolve);
    res.data.on('error', resolve);
  });
  return { status: res.status, contentType: res.headers['content-type'] || '', body: Buffer.concat(chunks) };
}

function firstUri(text, base) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    try {
      return new URL(t, base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Does `target` actually play THROUGH the relay? Server-side: playlist ->
 * (variant playlist ->) first segment, all via the relay's own rewritten
 * links, segment checked for real media bytes. true / false, or null when
 * inconclusive. Never logs or returns URLs.
 * `looksLikeMedia(buffer, contentType)` -> true/false/null is injected
 * (sourceChecks.looksLikeBinaryMedia) to avoid a require cycle.
 */
async function probeViaRelay(target, { looksLikeMedia, timeoutMs = 10000 } = {}) {
  if (!validateTarget(target) || !relaySecret() || !relayBase()) return null;
  try {
    let url = relayStreamRequestUrl(target);
    for (let hop = 0; hop < 3; hop++) {
      const r = await fetchHead(url, { timeoutMs, maxBytes: hop === 0 ? MAX_PLAYLIST_BYTES : 16384 });
      if (r.status !== 200) return false;
      const text = r.body.toString('utf8');
      if (PLAYLIST_CT_RE.test(r.contentType) || text.trimStart().startsWith('#EXTM3U')) {
        const next = firstUri(text, url);
        if (!next) return false;
        url = next;
        continue;
      }
      const verdict = looksLikeMedia ? looksLikeMedia(r.body, r.contentType) : null;
      return verdict === false ? false : verdict === true ? true : null;
    }
    return null;
  } catch {
    return false;
  }
}

// Server-side relay thumbnail: JPEG Buffer, or null on any failure.
async function fetchRelayThumb(target, { timeoutMs = 15000 } = {}) {
  if (!validateTarget(target) || !relaySecret() || !relayBase()) return null;
  try {
    const res = await axios.get(relayThumbRequestUrl(target), {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      maxRedirects: 0,
      validateStatus: () => true,
    });
    if (res.status !== 200 || !/image\/jpeg/i.test(res.headers['content-type'] || '')) return null;
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

module.exports = {
  ALLOWED_EXTENSIONS,
  probeViaRelay,
  fetchRelayThumb,
  assertRelayConfig,
  isRelayConfigured,
  redact,
  relayStreamRequestUrl,
  relayThumbRequestUrl,
  relayHealthUrl,
  validateTarget,
  isPlaylist,
  sign,
  verifySignature,
  localStreamPath,
  rewritePlaylist,
  relayHealth,
  checkRelayAuth,
  MAX_PLAYLIST_BYTES,
};
