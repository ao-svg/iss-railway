// Checks whether a source URL is (a) reachable and (b) not blocked from
// being embedded in an <iframe> via X-Frame-Options / CSP frame-ancestors.
// Most of these URLs are raw HLS/DASH manifests (.m3u8/.mpd) rather than
// HTML pages, so "iframeable" here really means "reachable and not
// explicitly forbidding cross-origin framing" — the closest useful proxy,
// since a manifest file has no framing semantics of its own but the CDN in
// front of it sometimes still sets these headers.
//
// Results persist to data/source-checks.json so a page load never re-probes
// hundreds of third-party URLs live. Same caveat as config.js: this file
// lives on Railway's ephemeral disk and resets on redeploy.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'source-checks.json');
const CHECK_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — these links die/change often
const REQUEST_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

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

/**
 * Probe one URL. Uses a ranged GET (not HEAD — many stream CDNs reject HEAD)
 * to avoid downloading the whole file.
 */
async function checkUrl(url) {
  try {
    const res = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { Range: 'bytes=0-2047' },
      responseType: 'arraybuffer',
    });
    if (res.status >= 400) {
      return { status: 'dead', httpStatus: res.status, checkedAt: new Date().toISOString() };
    }
    const blocked = isBlockedByHeaders(res.headers);
    return {
      status: blocked ? 'blocked' : 'ok',
      httpStatus: res.status,
      checkedAt: new Date().toISOString(),
    };
  } catch (err) {
    return { status: 'dead', error: err.message, checkedAt: new Date().toISOString() };
  }
}

/**
 * Check every URL in `urls` (deduped), skipping ones already checked within
 * CHECK_TTL_MS unless `force`. Runs with limited concurrency, saving the
 * cache incrementally so a crash/redeploy mid-run doesn't lose progress.
 * `onProgress(done, total)` is called after each URL.
 */
async function checkAll(urls, { force = false, onProgress } = {}) {
  const unique = [...new Set(urls)];
  const now = Date.now();
  const toCheck = unique.filter((u) => {
    if (force) return true;
    const cached = _cache[u];
    return !cached || now - new Date(cached.checkedAt).getTime() > CHECK_TTL_MS;
  });

  const summary = { total: unique.length, checked: 0, ok: 0, blocked: 0, dead: 0, skipped: unique.length - toCheck.length };

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

module.exports = { getStatus, checkAll, checkUrl };
