// Routes for the WordPress-sites hub (see hub.js):
//   GET  /api/hub/config    sites: settings + check-in (X-Zhibo-Key header)
//   GET  /api/hub/package   sites: the published plugin zip (?key=), for WordPress's updater
//   GET  /sites             admin page: destination, overrides, sites list, plugin updates
//   POST /api/hub/*         admin actions behind it
//
// The admin routes use the dashboard's Basic auth. Browsers resend Basic credentials on any
// request to this host, so every admin POST/PUT also has to come from this app's own pages.

const express = require('express');
const fs = require('fs');
const hub = require('./hub');

function baseUrl(req, getConfig) {
  if (getConfig().publicBaseUrl) return getConfig().publicBaseUrl.replace(/\/+$/, '');
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function sameOrigin(req, res, next) {
  const origin = req.get('origin') || req.get('referer') || '';
  try {
    if (origin && new URL(origin).host === req.get('host')) return next();
  } catch { /* fall through */ }
  return res.status(403).type('text/plain').send('Forbidden: not sent from this app');
}

function ago(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return '—';
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function renderSites({ layout, escapeHtml }, base, flash) {
  const st = hub.getState();
  const s = st.settings;
  const latest = st.release && st.release.version;
  const dayAgo = Date.now() - 86400000;
  const sites = Object.entries(st.sites)
    .map(([host, x]) => ({ host, ...x, target: hub.targetFor(host, s, st.overrides), override: st.overrides[host] || null }))
    .sort((a, b) => a.host.localeCompare(b.host));
  const outdated = sites.filter((x) => latest && hub.compareVersions(x.version, latest) < 0).length;
  const silent = sites.filter((x) => new Date(x.lastSeen).getTime() < dayAgo).length;
  const bare = (u) => escapeHtml(String(u).replace(/^https?:\/\//, ''));

  const siteRows = sites
    .map((x) => {
      const old = latest && hub.compareVersions(x.version, latest) < 0;
      const stale = new Date(x.lastSeen).getTime() < dayAgo;
      return `<tr>
    <td><a href="${escapeHtml(x.home || `https://${x.host}`)}" target="_blank" rel="noopener">${escapeHtml(x.host)}</a></td>
    <td><code>${bare(x.target)}</code>${x.override ? ' <span class="rank rank-medium">override</span>' : ''}</td>
    <td><span class="rank ${old ? 'rank-medium' : 'rank-working'}">v${escapeHtml(x.version || '?')}</span></td>
    <td class="${stale ? 'status-err' : 'muted'}" title="${escapeHtml(x.lastSeen)}">${ago(x.lastSeen)}</td>
    <td class="muted">${x.theme === 'zhibo-child' ? '✓' : escapeHtml(x.theme || '—')}</td>
    <td class="muted">${Number(x.pages) || 0}</td>
    <td>
      <form class="inline-form" method="POST" action="/api/hub/forget" onsubmit="return confirm('Remove ${escapeHtml(x.host)} from the list? It comes back on its next check-in if it still runs the plugin.');">
        <input type="hidden" name="host" value="${escapeHtml(x.host)}">
        <button type="submit" class="secondary">Forget</button>
      </form>
    </td>
  </tr>`;
    })
    .join('');

  const overrideRows = Object.entries(st.overrides)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([host, target]) => `<tr>
    <td>${escapeHtml(host)}</td>
    <td><code>${bare(target)}</code></td>
    <td>
      <form class="inline-form" method="POST" action="/api/hub/override">
        <input type="hidden" name="host" value="${escapeHtml(host)}">
        <input type="hidden" name="target" value="">
        <button type="submit" class="secondary">Remove</button>
      </form>
    </td>
  </tr>`
    )
    .join('');

  const r = st.release;
  const flashHtml =
    flash && flash.startsWith('error:')
      ? `<p class="status-err">${escapeHtml(flash.slice(6))}</p>`
      : flash
        ? `<p class="status-ok">${escapeHtml(flash)}</p>`
        : '';

  return layout(
    'WordPress sites',
    `
    <h1>WordPress sites</h1>
    <p class="muted">Sites running the Zhibo Streaming Table plugin in Network mode get their settings and plugin updates from here, and check in every few minutes.</p>
    ${flashHtml}

    <div class="card">
      <strong>Destination</strong>
      <p class="muted">Where every site's matches open (each match: <code>&lt;destination&gt;/#match-…</code>). Sites switch within ${s.cacheMinutes || 5} minutes — sites with full-page caching once their cache expires.</p>
      <form method="POST" action="/api/hub/destination" onsubmit="return confirm('Send visitors from every site without an override to ' + this.defaultTarget.value + '?');">
        <input type="text" name="defaultTarget" value="${escapeHtml(s.defaultTarget)}" required>
        <button type="submit">Save destination</button>
      </form>
    </div>

    <div class="card">
      <strong>Per-domain destinations</strong>
      <p class="muted">Send some domains elsewhere. Everything not listed uses the destination above.</p>
      ${overrideRows ? `<table><tr><th>Domain</th><th>Destination</th><th></th></tr>${overrideRows}</table>` : '<p class="muted">None.</p>'}
      <form method="POST" action="/api/hub/override">
        <label for="ov-host">Domain</label>
        <input type="text" id="ov-host" name="host" placeholder="example.com" required list="hub-hosts">
        <datalist id="hub-hosts">${sites.map((x) => `<option value="${escapeHtml(x.host)}">`).join('')}</datalist>
        <label for="ov-target">Destination</label>
        <input type="text" id="ov-target" name="target" placeholder="https://…" required>
        <button type="submit">Save</button>
      </form>
    </div>

    <h2 class="section-heading">Sites</h2>
    <div class="card">
      <p><strong>${sites.length}</strong> sites · <strong>${outdated}</strong> need the update · <strong class="${silent ? 'status-err' : ''}">${silent}</strong> silent for a day+</p>
      ${sites.length ? `<table><tr><th>Domain</th><th>Opens on</th><th>Plugin</th><th>Last check-in</th><th>Theme</th><th>Sport pages</th><th></th></tr>${siteRows}</table>` : '<p class="muted">No site has checked in yet.</p>'}
    </div>

    <div class="card">
      <strong>Plugin updates</strong>
      <p class="muted">${
        r
          ? `Published: <strong>v${escapeHtml(r.version)}</strong> · ${ago(r.uploadedAt)} · ${Math.round(r.size / 1024)} KB${r.notes ? ` — ${escapeHtml(r.notes)}` : ''}`
          : 'Nothing published yet — sites keep the version they have.'
      }</p>
      <label for="hub-zip">Plugin zip (must contain the <code>${hub.PLUGIN_SLUG}/</code> folder)</label>
      <input type="file" id="hub-zip" accept=".zip,application/zip">
      <label for="hub-notes">What changed (optional)</label>
      <input type="text" id="hub-notes">
      <button type="button" id="hub-publish">Publish to all sites</button>
      <p class="muted" id="hub-publish-status"></p>
      <form method="POST" action="/api/hub/settings">
        <input type="hidden" name="autoUpdate" value="${s.autoUpdate ? '0' : '1'}">
        <p class="muted">Automatic updates are <strong>${s.autoUpdate ? 'on' : 'off'}</strong>: ${
          s.autoUpdate ? 'WordPress installs a published version in the background (within about 12 hours, usually much sooner).' : 'each site shows the update; someone has to click Update.'
        } <button type="submit" class="secondary">Turn ${s.autoUpdate ? 'off' : 'on'}</button></p>
      </form>
    </div>

    <div class="card">
      <strong>Feeds &amp; table</strong>
      <p class="muted">Must be the feeds the destination site uses, or links won't find their match. Empty = this app's own exports.</p>
      <form method="POST" action="/api/hub/settings">
        <label for="hub-fx">Fixtures feed</label>
        <input type="text" id="hub-fx" name="feedFixtures" value="${escapeHtml(s.feedFixtures)}" placeholder="${escapeHtml(base)}/fixtures.json">
        <label for="hub-live">Live feed</label>
        <input type="text" id="hub-live" name="feedLive" value="${escapeHtml(s.feedLive)}" placeholder="${escapeHtml(base)}/live.json">
        <label for="hub-page">Upcoming matches per page (0 = all)</label>
        <input type="text" id="hub-page" name="pageSize" value="${s.pageSize}" inputmode="numeric">
        <label for="hub-cache">Feed cache on each site (minutes)</label>
        <input type="text" id="hub-cache" name="cacheMinutes" value="${s.cacheMinutes}" inputmode="numeric">
        <button type="submit">Save</button>
      </form>
    </div>

    <div class="card">
      <strong>Connecting a site</strong>
      <p class="muted">Install the plugin, then in WordPress: 直播设置 → 1 · 连接 → Network, with:</p>
      <table>
        <tr><th>Hub URL</th><td><code>${escapeHtml(base)}</code></td></tr>
        <tr><th>Network key</th><td><code>${escapeHtml(hub.networkKey())}</code></td></tr>
      </table>
      ${
        process.env.HUB_NETWORK_KEY
          ? '<p class="muted">The key comes from the HUB_NETWORK_KEY variable.</p>'
          : `<form method="POST" action="/api/hub/rotate-key" onsubmit="return confirm('Every site stops getting settings and updates until the new key is entered on it. Change the key?');">
        <button type="submit" class="secondary">Change key…</button></form>`
      }
    </div>

    <script>
    document.getElementById('hub-publish').addEventListener('click', function () {
      var f = document.getElementById('hub-zip').files[0], st = document.getElementById('hub-publish-status'), btn = this;
      if (!f) { st.textContent = 'Choose the plugin zip first.'; return; }
      btn.disabled = true; st.textContent = 'Uploading…';
      fetch('/api/hub/release?notes=' + encodeURIComponent(document.getElementById('hub-notes').value), {
        method: 'PUT', body: f, headers: { 'Content-Type': 'application/zip' }, credentials: 'same-origin'
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || r.status); return j; }); })
        .then(function (j) { location.href = '/sites?flash=' + encodeURIComponent('v' + j.version + ' published to all sites'); })
        .catch(function (e) { st.textContent = 'Failed: ' + e.message; btn.disabled = false; });
    });
    </script>
  `,
    '/sites'
  );
}

function mountHubRoutes(app, { requireAuth, layout, escapeHtml, getConfig }) {
  const back = (res, flash) => res.redirect(`/sites?flash=${encodeURIComponent(flash)}`);
  const attempt = (res, fn, ok) => {
    try {
      fn();
      back(res, ok);
    } catch (err) {
      back(res, `error:${err.message}`);
    }
  };

  // ── Sites ──
  app.get('/api/hub/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!hub.keyMatches(req.get('x-zhibo-key'))) return res.status(401).json({ error: 'bad key' });
    const host = hub.cleanHost(req.query.site);
    if (!host) return res.status(400).json({ error: 'site missing' });
    const q = (k) => String(req.query[k] || '').slice(0, 200);
    hub.recordCheckin(host, { home: q('home'), version: q('v'), wp: q('wp'), php: q('php'), theme: q('theme'), pages: Number(q('pages')) || 0 });
    res.json(hub.configFor(host, baseUrl(req, getConfig)));
  });

  app.get('/api/hub/package', (req, res) => {
    if (!hub.keyMatches(req.query.key)) return res.status(401).type('text/plain').send('bad key');
    const file = hub.releasePath();
    if (!file) return res.status(404).type('text/plain').send('no release');
    res.set('Cache-Control', 'no-store');
    res.type('application/zip').attachment(`${hub.PLUGIN_SLUG}.zip`);
    fs.createReadStream(file).pipe(res);
  });

  // ── Admin ──
  app.get('/sites', requireAuth('admin'), (req, res) => {
    res.send(renderSites({ layout, escapeHtml }, baseUrl(req, getConfig), req.query.flash));
  });

  app.post('/api/hub/destination', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(res, () => hub.updateSettings({ defaultTarget: req.body.defaultTarget }), 'Destination saved — sites switch within a few minutes.')
  );

  app.post('/api/hub/override', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(res, () => hub.setOverride(req.body.host, req.body.target), req.body.target ? 'Saved.' : 'Removed.')
  );

  app.post('/api/hub/settings', requireAuth('admin'), sameOrigin, (req, res) => {
    const b = req.body;
    const fields = {};
    for (const k of ['feedFixtures', 'feedLive', 'pageSize', 'cacheMinutes']) if (b[k] !== undefined) fields[k] = b[k];
    if (b.autoUpdate !== undefined) fields.autoUpdate = b.autoUpdate === '1';
    attempt(res, () => hub.updateSettings(fields), 'Saved.');
  });

  app.post('/api/hub/forget', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(res, () => hub.forgetSite(req.body.host), 'Removed from the list.')
  );

  app.post('/api/hub/rotate-key', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(res, () => hub.rotateKey(), 'New network key — enter it on every site.')
  );

  app.put(
    '/api/hub/release',
    requireAuth('admin'),
    sameOrigin,
    express.raw({ type: () => true, limit: hub.MAX_ZIP_BYTES }),
    (req, res) => {
      try {
        const release = hub.publishRelease(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.query.notes);
        res.json({ ok: true, version: release.version });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }
  );
}

module.exports = { mountHubRoutes, renderSites };
