// Client for the Relay service — a separate Railway service (owned
// elsewhere, not modified from here) that proxies HLS resources and grabs
// stream thumbnails.
//
// Env:
//   RELAY_URL          public base URL, e.g. https://relay-production.up.railway.app.
//                      Used for every URL a browser loads: the relay rewrites
//                      playlist segment URLs from the incoming Host header, so
//                      a private address would hand browsers unreachable URLs.
//   RELAY_SECRET       sent as ?secret= on every request except /health.
//   RELAY_INTERNAL_URL optional base for server-to-server calls (health,
//                      thumbs), e.g. http://relay.railway.internal:8080. Only
//                      resolvable when both services share a Railway project;
//                      falls back to RELAY_URL.
//
// Env is read on every call (not cached at require time) so a variable
// change only needs a restart, and tests can set it per case.

const axios = require('axios');

const trimSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

function relaySettings() {
  const publicUrl = trimSlash(process.env.RELAY_URL);
  return {
    publicUrl,
    internalUrl: trimSlash(process.env.RELAY_INTERNAL_URL) || publicUrl,
    secret: process.env.RELAY_SECRET || '',
  };
}

function isRelayConfigured() {
  const { publicUrl, secret } = relaySettings();
  return Boolean(publicUrl && secret);
}

function buildUrl(base, route, target, secret) {
  return `${base}/${route}?secret=${encodeURIComponent(secret)}&url=${encodeURIComponent(target)}`;
}

// Browser-facing: hand straight to hls.js / native HLS, don't rewrite.
function relayStreamUrl(target) {
  const { publicUrl, secret } = relaySettings();
  if (!publicUrl || !secret) return null;
  return buildUrl(publicUrl, 'stream', target, secret);
}

// Browser-facing thumbnail (usable as <img src>).
function relayThumbUrl(target) {
  const { publicUrl, secret } = relaySettings();
  if (!publicUrl || !secret) return null;
  return buildUrl(publicUrl, 'thumb', target, secret);
}

// Server-side thumbnail fetch: a JPEG Buffer, or null on any failure (the
// relay can take ~12s on a cache miss, hence the generous timeout).
async function fetchRelayThumb(target, { timeoutMs = 20000 } = {}) {
  const { internalUrl, secret } = relaySettings();
  if (!internalUrl || !secret) return null;
  try {
    const res = await axios.get(buildUrl(internalUrl, 'thumb', target, secret), {
      responseType: 'arraybuffer',
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (res.status !== 200 || !/image\/jpeg/i.test(res.headers['content-type'] || '')) return null;
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

/**
 * Connection check. Never includes the secret in its output.
 *   configured - RELAY_URL and RELAY_SECRET are both set
 *   reachable  - GET /health answered with { ok: true }
 *   auth       - 'ok' | 'rejected' | 'unknown': the secret is tested with a
 *                /stream call that has no url — 401 means the secret is
 *                wrong, 400 (missing url) means it got past auth.
 */
async function checkRelay({ timeoutMs = 8000 } = {}) {
  const { publicUrl, internalUrl, secret } = relaySettings();
  const out = {
    configured: Boolean(publicUrl && secret),
    publicUrl: publicUrl || null,
    usingInternalUrl: internalUrl !== publicUrl,
    reachable: false,
    ffmpeg: null,
    uptime: null,
    auth: 'unknown',
    error: null,
  };
  if (!internalUrl) {
    out.error = 'RELAY_URL is not set';
    return out;
  }

  try {
    const res = await axios.get(`${internalUrl}/health`, { timeout: timeoutMs, validateStatus: () => true });
    const body = res.data && typeof res.data === 'object' ? res.data : {};
    out.reachable = res.status === 200 && body.ok === true;
    out.ffmpeg = typeof body.ffmpeg === 'boolean' ? body.ffmpeg : null;
    out.uptime = typeof body.uptime === 'number' ? body.uptime : null;
    if (!out.reachable) out.error = `health returned HTTP ${res.status}`;
  } catch (err) {
    out.error = `health request failed: ${err.code || err.message}`;
    return out;
  }

  if (!secret) {
    out.error = 'RELAY_SECRET is not set';
    return out;
  }
  try {
    const res = await axios.get(`${internalUrl}/stream?secret=${encodeURIComponent(secret)}`, {
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    if (res.status === 401) {
      out.auth = 'rejected';
      out.error = 'relay rejected RELAY_SECRET (401)';
    } else if (res.status === 400) {
      out.auth = 'ok';
    }
  } catch (err) {
    out.error = `auth check failed: ${err.code || err.message}`;
  }
  return out;
}

module.exports = { relaySettings, isRelayConfigured, relayStreamUrl, relayThumbUrl, fetchRelayThumb, checkRelay };
