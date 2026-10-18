// Routes for the WordPress-sites hub (see hub.js):
//   GET  /api/hub/config    sites: settings + check-in (X-Zhibo-Key header)
//   GET  /api/hub/package   sites: the published plugin zip (?key=), for WordPress's updater
//   GET  /sites             admin page: destination, overrides, sites list, plugin updates
//   POST /api/hub/*         admin actions behind it
//
// The admin routes use the dashboard's Basic auth. Browsers resend Basic credentials on any
// request to this host, so every admin POST/PUT also has to come from this app's own pages.

const express = require('express');
const axios = require('axios');
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

const pendingCount = (host) => hub.commandsFor(host).filter((c) => c.status === 'queued' || c.status === 'sent').length;

// Version that understands hub commands (setup / uninstall)
const COMMANDS_SINCE = '2.2.0';

// Sports offered on the setup form: the main ones first (zhibo82.com's menu), then the rest
const SETUP_SPORTS = [
  ['Football', '足球'], ['Basketball', '篮球'], ['Tennis', '网球'], ['American Football', '美式橄榄球'],
  ['Ice Hockey', '冰球'], ['Cricket', '板球'], ['Baseball', '棒球'], ['Rugby', '橄榄球'], ['Golf', '高尔夫'],
  ['Boxing', '拳击'], ['UFC/MMA', '综合格斗'], ['Motorsport', '赛车'], ['Cycling', '自行车'], ['Darts', '飞镖'],
  ['Snooker', '斯诺克'], ['Horse Racing', '赛马'], ['Australian Rules', '澳式橄榄球'], ['Athletics', '田径'],
  ['Volleyball', '排球'], ['Table Tennis', '乒乓球'], ['Handball', '手球'],
];

// "Ask your hub now" — the site only acts on what its own hub hands out, so this needs no secret
async function pokeSite(site) {
  const home = hub.cleanUrl(site && site.home);
  if (!home) return { ok: false, error: 'no address on record' };
  try {
    const res = await axios.post(`${home}/?rest_route=/zhibo/v1/poke`, {}, { timeout: 10000, maxRedirects: 2, validateStatus: () => true });
    return res.status === 200 ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  }
}

function renderSite({ layout, escapeHtml }, host, flash) {
  const st = hub.getState();
  const x = st.sites[host];
  const d = x.details || {};
  const cmds = hub.commandsFor(host).slice().reverse();
  const isPlayer = x.role === 'player';
  const canCommand = !isPlayer && hub.compareVersions(x.version, COMMANDS_SINCE) >= 0;
  const pagesHave = new Set(Object.keys(d.pages || {}));
  const statusTag = (s) => ({ done: 'rank-working', failed: 'rank-low', cancelled: 'rank-unverified', sent: 'rank-medium', queued: 'rank-medium' })[s] || 'rank-unverified';
  const flashHtml =
    flash && flash.startsWith('error:') ? `<p class="status-err">${escapeHtml(flash.slice(6))}</p>` : flash ? `<p class="status-ok">${escapeHtml(flash)}</p>` : '';

  const cmdRows = cmds
    .map(
      (c) => `<tr>
    <td class="muted" title="${escapeHtml(c.createdAt)}">${ago(c.createdAt)}</td>
    <td>${c.type === 'uninstall' ? 'Remove' : 'Set up'}${c.local ? ' <span class="muted">(from the site’s admin)</span>' : ''}</td>
    <td class="muted">${c.type === 'setup' ? escapeHtml(describeSetup(c.args)) : ''}</td>
    <td><span class="rank ${statusTag(c.status)}">${escapeHtml(c.status)}</span></td>
    <td class="muted">${(c.log || []).map((l) => `<div class="${/^ERROR/.test(l) ? 'status-err' : ''}">${escapeHtml(l)}</div>`).join('')}</td>
    <td>${c.status === 'queued' || c.status === 'sent' ? `<form class="inline-form" method="POST" action="/api/hub/cancel"><input type="hidden" name="host" value="${escapeHtml(host)}"><input type="hidden" name="id" value="${escapeHtml(c.id)}"><button type="submit" class="secondary">Cancel</button></form>` : ''}</td>
  </tr>`
    )
    .join('');

  const sportBoxes = SETUP_SPORTS.map(
    ([type, cn], i) =>
      `<label style="display:inline-flex;gap:0.35rem;align-items:center;margin:0.25rem 1rem 0.25rem 0;color:var(--text)"><input type="checkbox" name="sports" value="${escapeHtml(type)}" ${pagesHave.has(type) || (!pagesHave.size && i < 6) ? 'checked' : ''}> ${escapeHtml(cn)} <span class="muted">${escapeHtml(type)}</span>${pagesHave.has(type) ? ' <span class="status-ok">✓</span>' : ''}</label>`
  ).join('');

  return layout(
    `${host} · WordPress sites`,
    `
    <p class="muted"><a href="/sites">← WordPress sites</a></p>
    <h1>${escapeHtml(host)}${x.removed ? ' <span class="rank rank-low">removed</span>' : ''}</h1>
    ${flashHtml}
    <div class="card">
      <table>
        <tr><th>Site</th><td><a href="${escapeHtml(x.home || `https://${host}`)}" target="_blank" rel="noopener">${escapeHtml(x.home || host)}</a></td></tr>
        <tr><th>Plugin</th><td>v${escapeHtml(x.version || '?')} · WordPress ${escapeHtml(x.wp || '?')} · PHP ${escapeHtml(x.php || '?')}</td></tr>
        <tr><th>Last check-in</th><td>${ago(x.lastSeen)}</td></tr>
        <tr><th>Opens on</th><td><code>${escapeHtml(hub.targetFor(host, st.settings, st.overrides))}</code>${st.overrides[host] ? ' (override)' : ''}</td></tr>
        <tr><th>Theme</th><td>${escapeHtml(d.theme || x.theme || '—')}</td></tr>
        <tr><th>Homepage table</th><td>${d.at ? (d.homepage ? 'yes' : 'no') : '—'}</td></tr>
        <tr><th>Sport pages</th><td>${pagesHave.size ? Object.entries(d.pages).map(([t, p]) => `${escapeHtml(t)} <code>${escapeHtml(p)}</code>`).join(' · ') : `${Number(x.pages) || 0}`}</td></tr>
        <tr><th>ABS3 bridge</th><td>${d.at ? (d.bridge ? 'installed (removal adds 301s through it)' : 'not installed') : '—'}</td></tr>
      </table>
      <form class="inline-form" method="POST" action="/api/hub/poke" style="margin-top:0.75rem">
        <input type="hidden" name="host" value="${escapeHtml(host)}">
        <button type="submit" class="secondary">Check now</button>
        <span class="muted">Sites pick up commands within 5 minutes; this asks the site to do it right away.</span>
      </form>
    </div>

    ${isPlayer ? '<p class="muted">A player site (zhibo82 plugin): it checks in and takes its updates from here; set-up and removal are for schedule sites.</p>' : canCommand ? '' : `<p class="status-warn">This site runs plugin v${escapeHtml(x.version || '?')}; remote set-up and removal need v${COMMANDS_SINCE} or later. Publish it under Plugin updates and wait for the site to update.</p>`}

    <div class="card">
      <strong>Set up</strong>
      <p class="muted">Same steps as the plugin's setup wizard, run on the site. Pages that already exist are kept as they are.</p>
      <form method="POST" action="/api/hub/command">
        <input type="hidden" name="host" value="${escapeHtml(host)}">
        <input type="hidden" name="type" value="setup">
        <label for="s-brand">Brand name (empty = the site title)</label>
        <input type="text" id="s-brand" name="brand" value="${escapeHtml(d.brand || '')}">
        <label style="display:flex;gap:0.5rem;align-items:center"><input type="checkbox" name="theme" value="1" ${d.theme === 'zhibo-child' ? '' : 'checked'}> Install GeneratePress + the Zhibo child theme (the zhibo82.com look)</label>
        <label style="display:flex;gap:0.5rem;align-items:center"><input type="checkbox" name="homepage" value="1" checked> Table on the homepage</label>
        <label style="display:flex;gap:0.5rem;align-items:center"><input type="checkbox" name="menu" value="1" checked> Header menu (直播首页 + the first four sports), if the site has none</label>
        <label>Sport pages (table under the heading, starter SEO text below)</label>
        <div>${sportBoxes}</div>
        <button type="submit" ${canCommand ? '' : 'disabled'}>Queue set-up</button>
      </form>
    </div>

    <div class="card">
      <strong>Remove from this site</strong>
      <p class="muted">Takes the table out of every page, post and widget; keeps the sport pages with their own text; restores the theme, front page and menu the site had before; adds 301s for anything removed (needs the ABS3 bridge); deletes the plugin's settings and then the plugin itself.</p>
      <form method="POST" action="/api/hub/command" onsubmit="return confirm('Remove the plugin and everything it added from ${escapeHtml(host)}?');">
        <input type="hidden" name="host" value="${escapeHtml(host)}">
        <input type="hidden" name="type" value="uninstall">
        <button type="submit" class="secondary" ${canCommand && !x.removed ? '' : 'disabled'}>Remove from site</button>
      </form>
    </div>

    <h2 class="section-heading">Commands</h2>
    <div class="card">
      ${cmdRows ? `<table><tr><th>When</th><th>Command</th><th>Details</th><th>Status</th><th>Result</th><th></th></tr>${cmdRows}</table>` : '<p class="muted">None yet.</p>'}
    </div>
  `,
    '/sites'
  );
}

function describeSetup(a) {
  const parts = [];
  if (a.theme) parts.push('theme');
  if (a.homepage !== false) parts.push('homepage');
  if (a.menu) parts.push('menu');
  if (a.sports && a.sports.length) parts.push(`${a.sports.length} sport pages`);
  if (a.brand) parts.push(`brand "${a.brand}"`);
  return parts.join(', ');
}

function renderSites({ layout, escapeHtml }, base, flash) {
  const st = hub.getState();
  const s = st.settings;
  const latestOf = (x) => { const r = st.releases[hub.knownPlugin(x.plugin)]; return r && r.version; };
  const dayAgo = Date.now() - 86400000;
  const sites = Object.entries(st.sites)
    .map(([host, x]) => ({
      host,
      ...x,
      target: hub.targetFor(host, s, st.overrides),
      override: st.overrides[host] || null,
      rotating: hub.rotationFor(host, s, st.overrides).length,
    }))
    .sort((a, b) => a.host.localeCompare(b.host));
  const isOld = (x) => latestOf(x) && hub.compareVersions(x.version, latestOf(x)) < 0;

  const players = sites.filter((x) => x.role === 'player');
  const schedules = sites.filter((x) => x.role !== 'player');
  const summary = (list) => {
    const old = list.filter(isOld).length;
    const silent = list.filter((x) => new Date(x.lastSeen).getTime() < dayAgo).length;
    return `<p><strong>${list.length}</strong> sites · <strong>${old}</strong> need the update · <strong class="${silent ? 'status-err' : ''}">${silent}</strong> silent for a day+</p>`;
  };
  // How many schedule sites send their visitors to each player site
  const usedBy = (p) => schedules.filter((x) => !x.removed && (x.target === p.home || hub.cleanHost(x.target) === p.host || (x.rotating && hub.rotationFor(x.host, s, st.overrides).some((u) => hub.cleanHost(u) === p.host)))).length;

  const bare = (u) => escapeHtml(String(u).replace(/^https?:\/\//, ''));

  const forgetForm = (x) => `<form class="inline-form" method="POST" action="/api/hub/forget" onsubmit="return confirm('Remove ${escapeHtml(x.host)} from the list? It comes back on its next check-in if it still runs the plugin.');">
        <input type="hidden" name="host" value="${escapeHtml(x.host)}">
        <button type="submit" class="secondary">Forget</button>
      </form>`;
  // ── Destination sites: one list; main one + optional rotation ──
  const dests = hub.destinations();
  const multi = dests.length > 1;
  const destRows = dests
    .map((d) => {
      const p = d.player;
      const stale = p && new Date(p.lastSeen).getTime() < dayAgo;
      const status = p
        ? `<span class="${stale ? 'status-err' : 'status-ok'}">● connected</span> <span class="muted">v${escapeHtml(p.version || '?')} · ${ago(p.lastSeen)}</span>`
        : '<span class="muted">not connected — install the zhibo82 plugin there and connect it (Settings → Zhibo82 → Hub)</span>';
      const sending = usedBy({ host: d.host, home: d.url });
      return `<tr>
    <td><label style="display:flex;gap:0.4rem;align-items:center;margin:0;color:var(--text)"><input type="radio" name="main" value="${escapeHtml(d.url)}" ${d.main ? 'checked' : ''}> ${d.main ? '<strong>Main</strong>' : 'Main'}</label></td>
    ${multi ? `<td><input type="checkbox" name="rotate" value="${escapeHtml(d.url)}" ${d.inRotation ? 'checked' : ''} aria-label="Rotate to ${escapeHtml(d.host)}"></td>` : ''}
    <td><a href="${escapeHtml(d.url)}" target="_blank" rel="noopener"><strong>${escapeHtml(d.host)}</strong></a></td>
    <td>${status}</td>
    <td class="muted">${sending} schedule site${sending === 1 ? '' : 's'}</td>
    <td>${
      d.main
        ? ''
        : d.player
          ? `<button type="submit" class="secondary" form="hub-dest-forget" name="host" value="${escapeHtml(d.host)}" formnovalidate onclick="return confirm('Remove ${escapeHtml(d.host)} from the list? It comes back on its next check-in if it still runs the plugin and is connected.')">Forget</button>`
          : d.manual
            ? `<button type="submit" class="secondary" form="hub-dest-remove" name="url" value="${escapeHtml(d.url)}" formnovalidate onclick="return confirm('Remove ${escapeHtml(d.host)} from the destinations?')">Remove</button>`
            : ''
    }</td>
  </tr>`;
    })
    .join('');

  // "Opens on": default (main / rotation) or one destination, per schedule site
  const opensOn = (x) => {
    const current = x.override ? hub.cleanHost(x.override) : '';
    const def = s.rotationEnabled && multi ? `Default — rotating × ${hub.rotationFor('', s, {}).length}` : `Default — ${hub.cleanHost(s.defaultTarget)}`;
    return `<form class="inline-form" method="POST" action="/api/hub/override">
        <input type="hidden" name="host" value="${escapeHtml(x.host)}">
        <select name="target" onchange="this.form.submit()" style="width:auto">
          <option value="">${escapeHtml(def)}</option>
          ${dests.map((d) => `<option value="${escapeHtml(d.url)}" ${current === d.host ? 'selected' : ''}>${escapeHtml(d.host)} only</option>`).join('')}
        </select>
      </form>`;
  };

  const siteRows = schedules
    .map((x) => {
      const old = isOld(x);
      const stale = new Date(x.lastSeen).getTime() < dayAgo;
      return `<tr>
    <td><a href="/sites/${encodeURIComponent(x.host)}"><strong>${escapeHtml(x.host)}</strong></a>${x.removed ? ' <span class="rank rank-low">removed</span>' : ''}${pendingCount(x.host) ? ` <span class="rank rank-medium">${pendingCount(x.host)} pending</span>` : ''}</td>
    <td>${opensOn(x)}</td>
    <td><span class="rank ${old ? 'rank-medium' : 'rank-working'}">v${escapeHtml(x.version || '?')}</span></td>
    <td class="${stale ? 'status-err' : 'muted'}" title="${escapeHtml(x.lastSeen)}">${ago(x.lastSeen)}</td>
    <td class="muted">${x.theme === 'zhibo-child' ? '✓' : escapeHtml(x.theme || '—')}</td>
    <td class="muted">${Number(x.pages) || 0}</td>
    <td>${forgetForm(x)}</td>
  </tr>`;
    })
    .join('');

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
    <p class="muted">Destination sites are where visitors watch (zhibo82 plugin). Schedule sites list the matches and send visitors to them (zhibo882 plugin). Both check in here every few minutes and take their plugin updates from here.</p>
    ${flashHtml}

    <h2 class="section-heading">Destination sites</h2>
    <div class="card">
      <p class="muted">Matches on every schedule site open on the <strong>main</strong> destination${multi ? ' — or, with rotation on, on one of the ticked ones at random for each click' : ''}. Changes reach the sites within ${s.cacheMinutes || 5} minutes.</p>
      <form method="POST" action="/api/hub/destinations">
        <table>
          <tr><th>Main</th>${multi ? '<th>Rotate</th>' : ''}<th>Site</th><th>Status</th><th>Receives from</th><th></th></tr>
          ${destRows}
        </table>
        ${multi ? `<label style="display:flex;gap:0.5rem;align-items:center"><input type="checkbox" name="rotationEnabled" value="1" ${s.rotationEnabled ? 'checked' : ''}> Rotate between the ticked sites${s.rotationEnabled ? ` — on, ${hub.rotationFor('', s, {}).length} sites` : ''}</label>` : ''}
        <button type="submit">Save</button>
      </form>
      <form id="hub-dest-remove" method="POST" action="/api/hub/destinations/remove"></form>
      <form id="hub-dest-forget" method="POST" action="/api/hub/forget"></form>
      <form class="inline-form" method="POST" action="/api/hub/destinations/add" style="margin-top:1rem">
        <input type="text" name="url" placeholder="https://another-destination.com" required>
        <button type="submit" class="secondary">Add destination</button>
      </form>
    </div>

    <h2 class="section-heading">Schedule sites</h2>
    <div class="card">
      ${summary(schedules)}
      ${schedules.length ? `<table><tr><th>Domain</th><th>Opens on</th><th>Plugin</th><th>Last check-in</th><th>Theme</th><th>Sport pages</th><th></th></tr>${siteRows}</table>` : '<p class="muted">No schedule site has checked in yet.</p>'}
    </div>

    <div class="card">
      <strong>Plugin updates</strong>
      <table>${Object.entries(hub.PLUGINS).map(([slug, p]) => {
        const r = st.releases[slug];
        return `<tr><th>${escapeHtml(p.label)}</th><td>${
          r ? `<strong>v${escapeHtml(r.version)}</strong> · ${ago(r.uploadedAt)} · ${Math.round(r.size / 1024)} KB · <a href="/sites/download?plugin=${encodeURIComponent(slug)}">Download zip</a>${r.notes ? ` — ${escapeHtml(r.notes)}` : ''}` : '<span class="muted">nothing published — sites keep the version they have</span>'
        }</td></tr>`;
      }).join('')}</table>
      <label for="hub-zip">Plugin zip — either plugin; the hub sees which one from its folder (<code>${Object.keys(hub.PLUGINS).join('/</code> or <code>')}/</code>) and only sites running that plugin get it</label>
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
      <p class="muted">Schedule site: install the zhibo882 plugin, then 直播设置 → 1 · 连接 → Network. Player site: in the zhibo82 plugin, Settings → Zhibo82 → Hub. Both with:</p>
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
        .then(function (j) { location.href = '/sites?flash=' + encodeURIComponent((j.label || 'Plugin') + ' v' + j.version + ' published'); })
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
    // Which plugin is asking (sites before player-site support don't say: the schedule plugin)
    const plugin = hub.knownPlugin(q('plugin'));
    hub.recordCheckin(host, {
      home: q('home'), version: q('v'), wp: q('wp'), php: q('php'), theme: q('theme'), pages: Number(q('pages')) || 0,
      plugin, role: hub.PLUGINS[plugin].role,
    });
    res.json(hub.configFor(host, baseUrl(req, getConfig), plugin));
  });

  app.get('/api/hub/package', (req, res) => {
    if (!hub.keyMatches(req.query.key)) return res.status(401).type('text/plain').send('bad key');
    const plugin = hub.knownPlugin(String(req.query.plugin || ''));
    const file = hub.releasePath(plugin);
    if (!file) return res.status(404).type('text/plain').send('no release');
    res.set('Cache-Control', 'no-store');
    res.type('application/zip').attachment(`${plugin}.zip`);
    fs.createReadStream(file).pipe(res);
  });

  // Sites: command results + their current state
  app.post('/api/hub/report', express.json({ limit: '256kb' }), (req, res) => {
    if (!hub.keyMatches(req.get('x-zhibo-key'))) return res.status(401).json({ error: 'bad key' });
    const ok = hub.recordReport(req.body && req.body.site, req.body || {});
    res.status(ok ? 200 : 404).json({ ok });
  });

  // ── Admin ──
  const siteBack = (res, host, flash) => res.redirect(`/sites/${encodeURIComponent(host)}?flash=${encodeURIComponent(flash)}`);

  // Before /sites/:host, which would otherwise take "download" for a domain
  app.get('/sites/download', requireAuth('admin'), (req, res) => {
    const plugin = hub.knownPlugin(String(req.query.plugin || ''));
    const file = hub.releasePath(plugin);
    if (!file) return res.status(404).send(layout('Not found', '<p>Nothing published for that plugin yet. <a href="/sites">Back</a></p>', '/sites'));
    const r = hub.getState().releases[plugin];
    res.set('Cache-Control', 'no-store');
    res.type('application/zip').attachment(`${plugin}-${r.version}.zip`);
    fs.createReadStream(file).pipe(res);
  });

  app.get('/sites/:host', requireAuth('admin'), (req, res) => {
    const host = hub.cleanHost(req.params.host);
    if (!hub.getState().sites[host]) return res.status(404).send(layout('Not found', '<p>No such site. <a href="/sites">Back</a></p>', '/sites'));
    res.send(renderSite({ layout, escapeHtml }, host, req.query.flash));
  });

  app.post('/api/hub/command', requireAuth('admin'), sameOrigin, async (req, res) => {
    const host = hub.cleanHost(req.body.host);
    const type = req.body.type;
    try {
      const args =
        type === 'setup'
          ? {
              brand: req.body.brand || '',
              theme: req.body.theme === '1',
              homepage: req.body.homepage === '1',
              menu: req.body.menu === '1',
              sports: [].concat(req.body.sports || []),
            }
          : {};
      hub.queueCommand(host, type, args);
    } catch (err) {
      return siteBack(res, host, `error:${err.message}`);
    }
    const poke = await pokeSite(hub.getState().sites[host]);
    siteBack(res, host, poke.ok ? 'Queued — the site is on it; refresh in a minute for the result.' : `Queued — the site picks it up within 5 minutes (couldn't reach it now: ${poke.error}).`);
  });

  app.post('/api/hub/cancel', requireAuth('admin'), sameOrigin, (req, res) => {
    const host = hub.cleanHost(req.body.host);
    hub.cancelCommand(host, String(req.body.id || ''));
    siteBack(res, host, 'Cancelled.');
  });

  app.post('/api/hub/poke', requireAuth('admin'), sameOrigin, async (req, res) => {
    const host = hub.cleanHost(req.body.host);
    const poke = await pokeSite(hub.getState().sites[host]);
    siteBack(res, host, poke.ok ? 'The site checked in.' : `error:Couldn't reach the site: ${poke.error}`);
  });

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

  // Destination sites card: main one, rotation ticks, rotation on/off
  app.post('/api/hub/destinations', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(
      res,
      () => hub.setDestinations({ main: req.body.main, rotate: [].concat(req.body.rotate || []), rotationEnabled: req.body.rotationEnabled === '1' }),
      'Saved — schedule sites switch within a few minutes.'
    )
  );

  app.post('/api/hub/destinations/add', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(res, () => hub.addDestination(req.body.url), 'Destination added.')
  );

  app.post('/api/hub/destinations/remove', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(res, () => hub.removeDestination(req.body.url), 'Destination removed.')
  );

  app.post('/api/hub/rotation', requireAuth('admin'), sameOrigin, (req, res) =>
    attempt(
      res,
      () => hub.updateSettings({ rotation: req.body.rotation || '', rotationEnabled: req.body.rotationEnabled === '1' }),
      req.body.rotationEnabled === '1' ? 'Rotation on — sites pick it up within a few minutes.' : 'Rotation off.'
    )
  );

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
        res.json({ ok: true, slug: release.slug, version: release.version, label: hub.PLUGINS[release.slug].label });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    }
  );
}

module.exports = { mountHubRoutes, renderSites };
