// Translates league/team names to Simplified Chinese, caching results to
// data/translations.json (checked once via the free translate.googleapis.com
// endpoint — no API key/billing setup needed). Manual overrides (set via the
// /translations admin page) always win and are never touched by auto-
// translation, so a bad machine translation can be permanently corrected.
//
// This is the free, unofficial endpoint (not the paid Cloud Translation
// API) — no credentials required, but it's not an SLA-backed service.
// Swapping to the official API later only means changing translateOne()'s
// implementation; getCached()/setManualTranslation()/the cache format all
// stay the same.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'translations.json');
const REQUEST_TIMEOUT_MS = 8000;
const DELAY_BETWEEN_REQUESTS_MS = 500;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000; // 2s, 4s, 8s on repeated 429s

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

function getCached(text) {
  return _cache[text] || null;
}

function getAllCached() {
  return _cache;
}

function setManualTranslation(text, zh) {
  if (!text || !zh || !zh.trim()) return;
  _cache[text] = { zh: zh.trim(), source: 'manual', updatedAt: new Date().toISOString() };
  saveCache(_cache);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Auto-translate one string via the free Google Translate endpoint, with
 * exponential backoff on 429 (this free/unofficial endpoint rate-limits
 * fairly aggressively under sustained use). Does NOT check the cache first
 * or write to it on success — callers that want caching should go through
 * translateAll(). Returns { zh } / { rateLimited: true } / { zh: null } on
 * a non-retryable failure.
 */
async function fetchTranslation(text) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.get('https://translate.googleapis.com/translate_a/single', {
        params: { client: 'gtx', sl: 'en', tl: 'zh-CN', dt: 't', q: text },
        timeout: REQUEST_TIMEOUT_MS,
      });
      const segments = res.data && Array.isArray(res.data[0]) ? res.data[0] : null;
      if (!segments || !segments.length) return { zh: null };
      return { zh: segments.map((seg) => seg[0]).join('') };
    } catch (err) {
      const is429 = err.response && err.response.status === 429;
      if (is429 && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.error(`[translate] 429 for "${text}", retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(delay);
        continue;
      }
      if (is429) return { zh: null, rateLimited: true };
      console.error(`[translate] failed for "${text}": ${err.message}`);
      return { zh: null };
    }
  }
  return { zh: null };
}

/**
 * Translate every string in `texts` (deduped). By default skips anything
 * already cached (manual or auto). With `force`, re-translates auto-cached
 * entries too (e.g. to pick up upstream translation improvements) — but
 * NEVER touches a manual override, since that's the whole point of manual
 * overrides existing. Runs sequentially with a small delay between requests
 * to stay polite to the free endpoint. `onProgress(done, total)` called
 * after each string.
 */
async function translateAll(texts, { onProgress, force = false } = {}) {
  const unique = [...new Set(texts.filter(Boolean))];
  const toTranslate = unique.filter((t) => {
    const cached = _cache[t];
    if (!cached) return true;
    if (cached.source === 'manual') return false;
    return force;
  });
  const summary = {
    total: unique.length,
    translated: 0,
    failed: 0,
    skipped: unique.length - toTranslate.length,
  };

  for (let i = 0; i < toTranslate.length; i++) {
    const text = toTranslate[i];
    const result = await fetchTranslation(text);
    if (result.zh) {
      _cache[text] = { zh: result.zh, source: 'auto', updatedAt: new Date().toISOString() };
      summary.translated++;
    } else {
      summary.failed++;
    }
    if (onProgress) onProgress(summary.translated + summary.failed + summary.skipped, unique.length);

    if (result.rateLimited) {
      // Still 429 after MAX_RETRIES backoffs — the endpoint isn't going to
      // clear itself mid-run. Stop instead of burning through every
      // remaining name against the same wall; they stay untranslated and
      // will be picked up on the next "Translate names" click.
      const remaining = toTranslate.length - i - 1;
      summary.failed += remaining;
      console.error(`[translate] persistent rate limiting — stopping early, ${remaining} name(s) left untranslated for this run`);
      break;
    }

    if (i < toTranslate.length - 1) await sleep(DELAY_BETWEEN_REQUESTS_MS);
  }

  saveCache(_cache);
  return summary;
}

module.exports = { getCached, getAllCached, setManualTranslation, translateAll };
