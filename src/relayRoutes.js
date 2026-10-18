// Browser-facing proxy for the Relay service: /api/relay/stream and
// /api/relay/thumb, plus a /player page. The browser only ever sees this
// app's own domain; relay.js attaches RELAY_SECRET server-side and the
// playlist rewrite guarantees no relay host or secret is ever emitted.
//
// Not an open proxy: a top-level request must name a known, relayable
// source (`isRelayable`), and the segment/key/subtitle URLs inside a
// rewritten playlist carry an HMAC signature only this process can make.

const axios = require('axios');
const relay = require('./relay');

const STREAM_TIMEOUT_MS = 20000;
const THUMB_TIMEOUT_MS = 15000;
// Served from this app (pinned npm dependency) so the player page talks
// to no other host at all.
const HLS_JS_PATH = require.resolve('hls.js/dist/hls.min.js');
const HLS_JS_URL = '/static/hls.min.js';
const FORWARD_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges'];

// Public playback links (/go, /api/relay/stream) are fetched by hls.js on
// other sites — the WordPress plugin's player page. Any origin, never
// credentials, and on EVERY response (redirects and errors too) so the
// player can read the status instead of an opaque CORS failure.
const allowAnyOrigin = (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  next();
};
const streamCors = (req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  });
  next();
};

const PLACEHOLDER_SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">' +
    '<rect width="320" height="180" fill="#1e293b"/>' +
    '<text x="160" y="96" fill="#64748b" font-family="sans-serif" font-size="14" text-anchor="middle">no preview</text>' +
    '</svg>'
);

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function logError(where, err) {
  console.error(`[relay] ${where}: ${relay.redact(err && (err.code || err.message || err))}`);
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error('playlist too large'));
      } else chunks.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function mountRelayRoutes(app, { requireAuth, isRelayable, isEnabled }) {
  const isAllowed = (target, sig) => relay.verifySignature(target, sig) || isRelayable(target);

  // Public by design (reach first): a link this process signed — what /go
  // hands out, and every URI inside a rewritten playlist — needs no login.
  // Unsigned requests (raw known-source URLs) still need a viewer login, so
  // the proxy can't be pointed at arbitrary URLs by anyone.
  const signedOrViewer = (req, res, next) => {
    const target = relay.validateTarget(req.query.url);
    if (target && relay.verifySignature(target, req.query.sig)) return next();
    return requireAuth('viewer')(req, res, next);
  };

  app.get(HLS_JS_URL, (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.type('application/javascript').sendFile(HLS_JS_PATH);
  });

  app.options('/api/relay/stream', streamCors, (req, res) => {
    res.set({
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Max-Age': '86400',
    });
    res.sendStatus(204);
  });

  // streamCors before signedOrViewer: a 401 must carry the header too.
  app.get('/api/relay/stream', streamCors, signedOrViewer, async (req, res) => {
    if (!isEnabled()) return res.status(503).type('text/plain').send('Relay is turned off');
    const target = relay.validateTarget(req.query.url);
    if (!target) return res.status(400).type('text/plain').send('Invalid url');
    if (!isAllowed(target, req.query.sig)) return res.status(403).type('text/plain').send('Not an allowed source');

    let upstream;
    try {
      upstream = await axios.get(relay.relayStreamRequestUrl(target), {
        responseType: 'stream',
        timeout: STREAM_TIMEOUT_MS,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: req.headers.range ? { Range: req.headers.range } : {},
      });
    } catch (err) {
      logError('stream request failed', err);
      return res.status(502).type('text/plain').send('Stream unavailable');
    }

    const { status } = upstream;
    if (status >= 300) {
      upstream.data.destroy();
      if (status >= 400 && status < 500) return res.status(status).type('text/plain').send('Stream unavailable');
      if (status >= 500) logError('stream upstream', `HTTP ${status}`);
      return res.status(502).type('text/plain').send('Stream unavailable');
    }

    const contentType = upstream.headers['content-type'] || '';
    if (relay.isPlaylist(target, contentType)) {
      try {
        const body = await readBody(upstream.data, relay.MAX_PLAYLIST_BYTES);
        const rewritten = relay.rewritePlaylist(body.toString('utf8'), target);
        res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(200).type('application/vnd.apple.mpegurl').send(rewritten);
      } catch (err) {
        logError('playlist rewrite failed', err);
        return res.status(502).type('text/plain').send('Stream unavailable');
      }
    }

    // A media request answered as a playlist means the relay "rewrote" the
    // media bytes as if they were a playlist (seen live 2026-10-11 on an
    // Amagi .ts): the body is corrupt AND now carries relay URLs. Never
    // forward that — it would leak the relay host to the browser.
    if (/mpegurl/i.test(contentType)) {
      upstream.data.destroy();
      logError('stream upstream', 'relay returned a playlist for a media segment');
      return res.status(502).type('text/plain').send('Stream unavailable');
    }

    // Binary (segment / key / subtitle): stream straight through.
    for (const h of FORWARD_HEADERS) {
      if (upstream.headers[h]) res.set(h, upstream.headers[h]);
    }
    res.set('Cache-Control', 'private, max-age=30');
    res.status(status);
    req.on('close', () => upstream.data.destroy());
    upstream.data.on('error', (err) => {
      logError('stream body', err);
      res.destroy();
    });
    upstream.data.pipe(res);
  });

  app.get('/api/relay/thumb', signedOrViewer, async (req, res) => {
    const placeholder = (code) =>
      res.status(code).set('Cache-Control', 'no-store').type('image/svg+xml').send(PLACEHOLDER_SVG);

    if (!isEnabled()) return placeholder(503);
    const target = relay.validateTarget(req.query.url);
    if (!target) return placeholder(400);
    if (!isAllowed(target, req.query.sig)) return placeholder(403);
    try {
      const upstream = await axios.get(relay.relayThumbRequestUrl(target), {
        responseType: 'arraybuffer',
        timeout: THUMB_TIMEOUT_MS,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      if (upstream.status !== 200 || !/image\/jpeg/i.test(upstream.headers['content-type'] || '')) {
        if (upstream.status >= 500) logError('thumb upstream', `HTTP ${upstream.status}`);
        return placeholder(404);
      }
      res.set('Cache-Control', 'private, max-age=300');
      return res.status(200).type('image/jpeg').send(Buffer.from(upstream.data));
    } catch (err) {
      logError('thumb request failed', err);
      return placeholder(404);
    }
  });

  // Public: anyone can watch a matched source; signing in is only suggested.
  app.get('/player', (req, res) => {
    const target = relay.validateTarget(req.query.url);
    if (!target || !isRelayable(target)) return res.status(404).type('text/plain').send('Unknown source');
    // Through /go: it re-resolves the source at play time (fresh token)
    // and redirects to /api/relay/stream; hls.js follows the redirect.
    const src = `/go?u=${encodeURIComponent(target)}`;
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Player</title>
<style>body{margin:0;background:#0f172a;color:#cbd5e1;font-family:sans-serif}video{width:100%;max-height:90vh;background:#000;display:block}p{padding:8px 16px;margin:0;font-size:13px;word-break:break-all}</style>
</head><body>
<video id="v" controls autoplay muted playsinline></video>
<p id="status">Loading…</p>
<p class="muted">${escapeHtml(target)}</p>
<p>Want every match in one place? <a href="/browse" style="color:#93c5fd">Sign in</a> for the full fixture list (optional — playback works without it).</p>
<script src="${HLS_JS_URL}"></script>
<script>
  var src = ${JSON.stringify(src).replace(/</g, '\\u003c')};
  var v = document.getElementById('v'), st = document.getElementById('status');
  v.addEventListener('playing', function () { st.textContent = 'Playing'; });
  if (window.Hls && Hls.isSupported()) {
    var h = new Hls();
    h.on(Hls.Events.ERROR, function (e, d) { if (d && d.fatal) st.textContent = 'Playback error: ' + (d.details || d.type); });
    h.loadSource(src); h.attachMedia(v);
  } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
    v.src = src;
  } else {
    st.textContent = 'This browser cannot play HLS.';
  }
</script>
</body></html>`);
  });
}

// Markup for /browse: a lazy thumbnail + play link for a relayable stream.
function relayPreviewHtml(url) {
  const enc = encodeURIComponent(url);
  return ` <a class="relay-play" href="/player?url=${enc}" target="_blank" rel="noopener" title="Play via relay"><img class="relay-thumb" loading="lazy" width="96" height="54" alt="" src="/api/relay/thumb?url=${enc}" onerror="this.onerror=null;this.style.visibility='hidden'">▶</a>`;
}

module.exports = { mountRelayRoutes, relayPreviewHtml, allowAnyOrigin, PLACEHOLDER_SVG };
