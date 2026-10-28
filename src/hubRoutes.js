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
const hubConnect = require('./hubConnect');

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
// opts.update: also install the hub's newer version of the site's plugin now (plugins that know
// it: schedule 2.4.0+, player 4.4.0+; older ones just check in)
async function pokeSite(site, opts = {}) {
  const home = hub.cleanUrl(site && site.home);
  if (!home) return { ok: false, error: 'no address on record' };
  try {
    const ns = site.role === 'player' ? 'zhibo82/v1' : 'zhibo/v1';
    const res = await axios.post(`${home}/?rest_route=/${ns}/poke`, opts.update ? { update: true } : {}, { timeout: 10000, maxRedirects: 2, validateStatus: () => true });
    return res.status === 200 ? { ok: true, answer: res.data } : { ok: false, error: `HTTP ${res.status}` };
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
  const flashHtml = flashBox(escapeHtml, flash);

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
    `${HUB_CSS}<div class="hub">
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

// Page-only styles for /sites and its sub-pages (the shared layout leaves links unstyled)
const HUB_CSS = `<style>
  .hub a { color: #93c5fd; text-decoration: none; }
  .hub a:hover { text-decoration: underline; }
  .hub .lead { color: var(--text-muted); margin: 0 0 1.25rem; max-width: 760px; font-size: 0.9rem; }
  .hub .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; margin-bottom: 1.25rem; }
  .hub .stat { background: var(--surface); border-radius: var(--radius); padding: 0.8rem 1rem; box-shadow: var(--shadow); }
  .hub .stat b { display: block; font-size: 1.5rem; line-height: 1.2; }
  .hub .stat span { color: var(--text-muted); font-size: 0.8rem; }
  .hub .stat.warn b { color: #fbbf24; }
  .hub .stat.err b { color: #f87171; }
  .hub .card-head { display: flex; justify-content: space-between; align-items: baseline; gap: 0.25rem 1rem; flex-wrap: wrap; }
  .hub .card-head h2 { font-size: 1.05rem; margin: 0; }
  .hub .card-head p { margin: 0; }
  .hub table { margin-top: 0.75rem; }
  .hub td, .hub th { vertical-align: middle; padding: 0.55rem 0.5rem; }
  .hub th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
  .hub td.c, .hub th.c { text-align: center; }
  .hub td.r { text-align: right; white-space: nowrap; }
  .hub .site { font-weight: 600; }
  .hub .pill { display: inline-block; font-size: 0.7rem; padding: 0.05rem 0.5rem; border-radius: 999px; background: #1e3a8a; color: #bfdbfe; margin-left: 0.45rem; vertical-align: 1px; }
  .hub button.small { margin: 0; padding: 0.3rem 0.65rem; font-size: 0.78rem; }
  .hub button.link { background: none; color: var(--text-muted); padding: 0.3rem 0.4rem; margin: 0; font-size: 0.78rem; }
  .hub button.link:hover { color: #f87171; background: none; }
  .hub td form { margin: 0; }
  .hub select.compact { width: auto; max-width: 230px; padding: 0.3rem 0.4rem; font-size: 0.8rem; }
  .hub .row { display: flex; gap: 0.6rem; align-items: center; flex-wrap: wrap; }
  .hub .row input[type=text] { flex: 1; min-width: 180px; width: auto; }
  .hub .row button { margin: 0; }
  .hub .switch { display: flex; gap: 0.6rem; align-items: flex-start; color: var(--text); margin: 1rem 0 0; font-size: 0.88rem; }
  .hub .switch input { margin-top: 0.2rem; }
  .hub .foot { display: flex; justify-content: space-between; align-items: center; gap: 0.75rem 1rem; flex-wrap: wrap; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border); }
  .hub .foot button { margin: 0; }
  .hub details { margin-top: 0.9rem; }
  .hub summary { cursor: pointer; color: var(--text-muted); font-size: 0.85rem; }
  .hub summary:hover { color: var(--text); }
  .hub details > div { margin-top: 0.75rem; }
  .hub .release { display: flex; justify-content: space-between; gap: 0.4rem 1rem; flex-wrap: wrap; padding: 0.7rem 0; border-bottom: 1px solid var(--border); align-items: center; }
  .hub .release .meta { color: var(--text-muted); font-size: 0.8rem; margin-top: 0.1rem; }
  .hub .flash { padding: 0.7rem 1rem; border-radius: var(--radius-sm); margin-bottom: 1rem; font-size: 0.9rem; }
  .hub .flash.ok { background: #14532d; color: #bbf7d0; }
  .hub .flash.err { background: #7f1d1d; color: #fecaca; }
  .hub .empty { color: var(--text-muted); font-size: 0.88rem; margin: 0.75rem 0 0; }
  .hub input[type=file] { color: var(--text-muted); font-size: 0.85rem; max-width: 100%; }
  @media (max-width: 700px) { .hub .hide-sm { display: none; } .hub .card { padding: 1rem; } }
</style>`;

function flashBox(escapeHtml, flash) {
  if (!flash) return '';
  const err = flash.startsWith('error:');
  return `<div class="flash ${err ? 'err' : 'ok'}">${escapeHtml(err ? flash.slice(6) : flash)}</div>`;
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
  const isSilent = (x) => new Date(x.lastSeen).getTime() < dayAgo;

  const schedules = sites.filter((x) => x.role !== 'player');
  // How many schedule sites send their visitors to each destination
  const usedBy = (p) => schedules.filter((x) => !x.removed && (x.target === p.home || hub.cleanHost(x.target) === p.host || (x.rotating && hub.rotationFor(x.host, s, st.overrides).some((u) => hub.cleanHost(u) === p.host)))).length;
  const version = (x) =>
    `<span class="rank ${isOld(x) ? 'rank-medium' : 'rank-working'}" title="${isOld(x) ? `v${escapeHtml(latestOf(x))} is published` : 'Up to date'}">v${escapeHtml(x.version || '?')}</span>`;
  const seen = (x) => `<span class="${isSilent(x) ? 'status-err' : 'muted'}" title="${escapeHtml(x.lastSeen)}">${ago(x.lastSeen)}</span>`;

  // ── Destination sites ──
  const dests = hub.destinations();
  const multi = dests.length > 1;
  const rotationOn = Boolean(s.rotationEnabled && multi);
  const destRows = dests
    .map((d) => {
      const p = d.player;
      const status = p
        ? `<span class="dot ${isSilent(p) ? 'dot-dead' : 'dot-ok'}"></span>${isSilent(p) ? `silent · ${ago(p.lastSeen)}` : 'connected'}`
        : `<span class="dot dot-unchecked"></span><a href="/sites/add?domain=${encodeURIComponent(d.host)}">Connect</a>`;
      const sending = usedBy({ host: d.host, home: d.url });
      const remove = d.main
        ? ''
        : p
          ? `<button type="submit" class="link" form="hub-dest-forget" name="host" value="${escapeHtml(d.host)}" formnovalidate onclick="return confirm('Remove ${escapeHtml(d.host)} from the list? It comes back on its next check-in if it still runs the plugin and is connected.')">Remove</button>`
          : d.manual
            ? `<button type="submit" class="link" form="hub-dest-remove" name="url" value="${escapeHtml(d.url)}" formnovalidate onclick="return confirm('Remove ${escapeHtml(d.host)} from the destinations?')">Remove</button>`
            : '';
      return `<tr>
    <td><a class="site" href="${p ? `/sites/${encodeURIComponent(d.host)}` : escapeHtml(d.url)}">${escapeHtml(d.host)}</a>${d.main ? '<span class="pill">main</span>' : ''}</td>
    <td>${status}</td>
    <td class="hide-sm">${p ? version(p) : '<span class="muted">—</span>'}</td>
    <td class="hide-sm muted">${sending ? `${sending} schedule site${sending === 1 ? '' : 's'}` : '—'}</td>
    <td class="c"><input type="radio" name="main" value="${escapeHtml(d.url)}" ${d.main ? 'checked' : ''} aria-label="Main destination: ${escapeHtml(d.host)}"></td>
    ${multi ? `<td class="c"><input type="checkbox" name="rotate" value="${escapeHtml(d.url)}" ${d.inRotation ? 'checked' : ''} aria-label="Include ${escapeHtml(d.host)} in the random pick"></td>` : ''}
    <td class="r">${remove}</td>
  </tr>`;
    })
    .join('');

  // ── Schedule sites ──
  const opensOn = (x) => {
    const current = x.override ? hub.cleanHost(x.override) : '';
    const def = rotationOn ? `Default — random of ${hub.rotationFor('', s, {}).length}` : `Default — ${hub.cleanHost(s.defaultTarget)}`;
    return `<form method="POST" action="/api/hub/override">
        <input type="hidden" name="host" value="${escapeHtml(x.host)}">
        <select class="compact" name="target" onchange="this.form.submit()" aria-label="Where ${escapeHtml(x.host)} sends visitors">
          <option value="">${escapeHtml(def)}</option>
          ${dests.map((d) => `<option value="${escapeHtml(d.url)}" ${current === d.host ? 'selected' : ''}>Only ${escapeHtml(d.host)}</option>`).join('')}
        </select>
      </form>`;
  };
  const siteRows = schedules
    .map(
      (x) => `<tr>
    <td><a class="site" href="/sites/${encodeURIComponent(x.host)}">${escapeHtml(x.host)}</a>${x.removed ? ' <span class="rank rank-low">removed</span>' : ''}${pendingCount(x.host) ? ` <span class="rank rank-medium">${pendingCount(x.host)} pending</span>` : ''}</td>
    <td>${opensOn(x)}</td>
    <td>${version(x)}</td>
    <td>${seen(x)}</td>
    <td class="hide-sm muted">${x.theme === 'zhibo-child' ? 'Zhibo' : escapeHtml(x.theme || '—')}</td>
    <td class="hide-sm muted c">${Number(x.pages) || 0}</td>
    <td class="r"><form method="POST" action="/api/hub/forget" onsubmit="return confirm('Remove ${escapeHtml(x.host)} from the list? It comes back on its next check-in if it still runs the plugin.');">
        <input type="hidden" name="host" value="${escapeHtml(x.host)}"><button type="submit" class="link">Remove</button></form></td>
  </tr>`
    )
    .join('');

  // ── Plugin updates ──
  const releaseRows = Object.entries(hub.PLUGINS)
    .map(([slug, p]) => {
      const r = st.releases[slug];
      const running = sites.filter((x) => hub.knownPlugin(x.plugin) === slug && !x.removed);
      const current = r ? running.filter((x) => hub.compareVersions(x.version, r.version) >= 0).length : 0;
      return `<div class="release">
        <div><strong>${escapeHtml(p.label)}</strong><div class="meta">${
          r ? `published ${ago(r.uploadedAt)} · ${Math.round(r.size / 1024)} KB${r.notes ? ` · ${escapeHtml(r.notes)}` : ''}` : 'nothing published — sites keep the version they have'
        }</div></div>
        ${r ? `<div><span class="rank rank-working">v${escapeHtml(r.version)}</span> <span class="muted">on ${current} of ${running.length} site${running.length === 1 ? '' : 's'}</span> · <a href="/sites/download?plugin=${encodeURIComponent(slug)}">Download zip</a></div>` : ''}
      </div>`;
    })
    .join('');

  const old = sites.filter((x) => !x.removed && isOld(x)).length;
  const silent = sites.filter((x) => !x.removed && isSilent(x)).length;
  const connectedDests = dests.filter((d) => d.player && !isSilent(d.player)).length;

  return layout(
    'WordPress sites',
    `${HUB_CSS}
    <div class="hub">
    <h1>WordPress sites</h1>
    <p class="lead">Destination sites (zhibo82 plugin) are where visitors watch. Schedule sites (zhibo882 plugin) list the matches and send each click to a destination. All of them take their settings and plugin updates from here.</p>
    ${flashBox(escapeHtml, flash)}

    <div class="stats">
      <div class="stat"><b>${connectedDests}/${dests.length}</b><span>destinations connected</span></div>
      <div class="stat"><b>${schedules.filter((x) => !x.removed).length}</b><span>schedule sites</span></div>
      <div class="stat ${old ? 'warn' : ''}"><b>${old}</b><span>need the plugin update</span></div>
      <div class="stat ${silent ? 'err' : ''}"><b>${silent}</b><span>silent for a day+</span></div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Add a site</h2><p class="muted">Either plugin — no key to copy</p></div>
      <form class="row" method="GET" action="/sites/add" style="margin-top:0.75rem">
        <input type="text" name="domain" placeholder="example.com" required aria-label="Domain">
        <button type="submit">Check site</button>
      </form>
      <p class="muted" style="margin:0.6rem 0 0">The hub checks which plugin the site runs; you approve the connection in that site's WordPress and come back connected.</p>
    </div>

    <div class="card">
      <div class="card-head"><h2>Destination sites</h2><p class="muted">Where visitors watch</p></div>
      <form method="POST" action="/api/hub/destinations">
        <table>
          <tr><th>Site</th><th>Status</th><th class="hide-sm">Plugin</th><th class="hide-sm">Gets visitors from</th><th class="c">Main</th>${multi ? '<th class="c">In random pick</th>' : ''}<th></th></tr>
          ${destRows}
        </table>
        ${
          multi
            ? `<label class="switch"><input type="checkbox" name="rotationEnabled" value="1" ${s.rotationEnabled ? 'checked' : ''}>
          <span><strong>Random destination per click</strong><br><span class="muted">${
            rotationOn
              ? `On — each click on a schedule site opens one of the ${hub.rotationFor('', s, {}).length} sites ticked under “In random pick”.`
              : 'Off — every click opens the main site. To spread visitors, tick the sites under “In random pick”, switch this on and save.'
          }</span></span></label>`
            : ''
        }
        <div class="foot"><span class="muted">Schedule sites switch within ${s.cacheMinutes || 5} minutes of saving.</span><button type="submit">Save</button></div>
      </form>
      <form id="hub-dest-remove" method="POST" action="/api/hub/destinations/remove"></form>
      <form id="hub-dest-forget" method="POST" action="/api/hub/forget"></form>
      <details>
        <summary>Add a destination by address only (not connected)</summary>
        <div><form class="row" method="POST" action="/api/hub/destinations/add">
          <input type="text" name="url" placeholder="https://another-destination.com" required aria-label="Destination address">
          <button type="submit" class="secondary">Add destination</button>
        </form></div>
      </details>
    </div>

    <div class="card">
      <div class="card-head"><h2>Schedule sites</h2><p class="muted">Each sends visitors to the default destination, or only to the one you pick</p></div>
      ${
        schedules.length
          ? `<table><tr><th>Site</th><th>Sends visitors to</th><th>Plugin</th><th>Last check-in</th><th class="hide-sm">Theme</th><th class="hide-sm c">Sport pages</th><th></th></tr>${siteRows}</table>`
          : '<p class="empty">No schedule site yet — add one above.</p>'
      }
    </div>

    <div class="card">
      <div class="card-head"><h2>Plugin updates</h2><p class="muted">Publish once — every connected site running that plugin gets it</p></div>
      ${releaseRows}
      <div class="row" style="margin-top:1rem">
        <input type="file" id="hub-zip" accept=".zip,application/zip" aria-label="Plugin zip">
        <input type="text" id="hub-notes" placeholder="What changed (optional)" aria-label="What changed">
        <button type="button" id="hub-publish">Publish</button>
      </div>
      <p class="muted" id="hub-publish-status" style="margin:0.5rem 0 0">Either plugin's zip — the hub tells them apart by the folder inside.</p>
      <form method="POST" action="/api/hub/settings" class="foot">
        <input type="hidden" name="autoUpdate" value="${s.autoUpdate ? '0' : '1'}">
        <span class="muted">Automatic updates are <strong>${s.autoUpdate ? 'on' : 'off'}</strong>: ${
          s.autoUpdate ? 'sites install a published version by themselves in the background.' : 'each site shows the update and someone has to click Update.'
        }</span>
        <button type="submit" class="secondary small">Turn ${s.autoUpdate ? 'off' : 'on'}</button>
      </form>
    </div>

    <div class="card">
      <details>
        <summary><strong style="color:var(--text)">Settings</strong> — feeds, matches per page, cache, network key</summary>
        <div>
          <form method="POST" action="/api/hub/settings">
            <p class="muted">The feeds must be the ones the destination sites use, or links won't find their match. Empty = this app's own exports.</p>
            <label for="hub-fx">Fixtures feed</label>
            <input type="text" id="hub-fx" name="feedFixtures" value="${escapeHtml(s.feedFixtures)}" placeholder="${escapeHtml(base)}/fixtures.json">
            <label for="hub-live">Live feed</label>
            <input type="text" id="hub-live" name="feedLive" value="${escapeHtml(s.feedLive)}" placeholder="${escapeHtml(base)}/live.json">
            <label for="hub-page">Upcoming matches per page (0 = all)</label>
            <input type="text" id="hub-page" name="pageSize" value="${s.pageSize}" inputmode="numeric">
            <label for="hub-cache">Feed cache on each site (minutes)</label>
            <input type="text" id="hub-cache" name="cacheMinutes" value="${s.cacheMinutes}" inputmode="numeric">
            <button type="submit">Save settings</button>
          </form>
          <div class="foot" style="display:block">
            <strong>Connecting a site by hand</strong>
            <p class="muted">Only needed when “Add a site” can't reach the site. Schedule site: 直播设置 → 1 · 连接 → Network. Destination site: Settings → Zhibo82 → Hub. Both with:</p>
            <table>
              <tr><th>Hub URL</th><td><code>${escapeHtml(base)}</code></td></tr>
              <tr><th>Network key</th><td><code>${escapeHtml(hub.networkKey())}</code></td></tr>
            </table>
            ${
              process.env.HUB_NETWORK_KEY
                ? '<p class="muted">The key comes from the HUB_NETWORK_KEY variable.</p>'
                : `<form method="POST" action="/api/hub/rotate-key" onsubmit="return confirm('Every site stops getting settings and updates until the new key is entered on it. Change the key?');">
              <button type="submit" class="secondary small" style="margin-top:0.75rem">Change key…</button></form>`
            }
          </div>
          <div class="foot" style="display:block">
            <strong>API token for scripts</strong>
            <p class="muted">Lets <code>npm run hub</code> in the iss-railway folder (and Claude) publish plugin zips, list the sites and update them right away — the same as this page, without a login. Put it in iss-railway's <code>.env</code> as <code>HUB_API_TOKEN=…</code>. Keep it private: it is admin access.</p>
            ${
              hub.apiToken()
                ? `<table><tr><th>Token</th><td><code>${escapeHtml(hub.apiToken())}</code></td></tr></table>`
                : '<p class="muted">No token yet.</p>'
            }
            ${
              process.env.HUB_API_TOKEN
                ? '<p class="muted">The token comes from the HUB_API_TOKEN variable.</p>'
                : `<form method="POST" action="/api/hub/api-token"${hub.apiToken() ? ` onsubmit="return confirm('The old token stops working. Make a new one?');"` : ''}>
              <button type="submit" class="secondary small" style="margin-top:0.75rem">${hub.apiToken() ? 'Make a new token…' : 'Create token'}</button></form>`
            }
          </div>
        </div>
      </details>
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
    </div>
  `,
    '/sites'
  );
}

// Set-up fields as the forms send them (site page and "Add a site")
function setupArgsFrom(body) {
  return {
    brand: body.brand || '',
    theme: body.theme === '1',
    homepage: body.homepage === '1',
    menu: body.menu === '1',
    sports: [].concat(body.sports || []),
  };
}

// "Add a site": what the hub found on the domain, and the button to approve it in WordPress
function renderAddSite({ layout, escapeHtml }, domain, probe) {
  const st = hub.getState();
  const back = '<p class="muted"><a href="/sites">← WordPress sites</a></p>';
  const again = `<form class="inline-form" method="GET" action="/sites/add" style="margin-top:0.75rem">
      <input type="text" name="domain" value="${escapeHtml(domain)}" required>
      <button type="submit" class="secondary">Check again</button>
    </form>`;
  const page = (body) => layout('Add a site · WordPress sites', `${HUB_CSS}<div class="hub">${back}<h1>Add a site</h1>${body}</div>`, '/sites');

  if (probe.error) return page(`<div class="card"><p class="status-err">${escapeHtml(probe.error)}</p>${again}</div>`);

  const known = st.sites[probe.host];
  const title = `<p><a href="${escapeHtml(probe.origin)}" target="_blank" rel="noopener"><strong>${escapeHtml(probe.host)}</strong></a>${probe.name ? ` <span class="muted">— ${escapeHtml(probe.name)}</span>` : ''}</p>`;
  const download = (slug) =>
    st.releases[slug]
      ? `<a href="/sites/download?plugin=${encodeURIComponent(slug)}">${escapeHtml(hub.PLUGINS[slug].label)} v${escapeHtml(st.releases[slug].version)}</a>`
      : escapeHtml(hub.PLUGINS[slug].label);

  if (!probe.plugins.length) {
    return page(`<div class="card">${title}
      <p class="status-warn">WordPress is there, but neither plugin is installed (or it's an old version without the hub connection).</p>
      <p>Install one in its WordPress: Plugins → Add New → Upload Plugin → choose the zip → Activate.</p>
      <ul><li>Schedule site: ${download(hub.PLUGIN_SLUG)}</li><li>Destination (player) site: ${download(hub.PLAYER_SLUG)}</li></ul>
      ${again}</div>`);
  }

  if (!probe.authUrl) {
    return page(`<div class="card">${title}
      <p class="status-warn">${escapeHtml(probe.plugins.map((p) => hub.PLUGINS[p].label).join(' + '))} found, but the site has WordPress Application Passwords turned off, so it can't be connected from here.</p>
      <p class="muted">WordPress turns them off when the site isn't on HTTPS, and some security plugins disable them. Connect it by hand instead (see “Connecting a site by hand” on the <a href="/sites">sites page</a>).</p>
      ${again}</div>`);
  }

  const sportBoxes = SETUP_SPORTS.map(
    ([type, cn], i) =>
      `<label style="display:inline-flex;gap:0.35rem;align-items:center;margin:0.25rem 1rem 0.25rem 0;color:var(--text)"><input type="checkbox" name="sports" value="${escapeHtml(type)}" ${i < 6 ? 'checked' : ''}> ${escapeHtml(cn)} <span class="muted">${escapeHtml(type)}</span></label>`
  ).join('');
  const check = (name, label, on = true) =>
    `<label style="display:flex;gap:0.5rem;align-items:center"><input type="checkbox" name="${name}" value="1" ${on ? 'checked' : ''}> ${label}</label>`;
  const both = probe.plugins.length > 1;
  const choices = probe.plugins
    .map((slug, i) => {
      const player = hub.PLUGINS[slug].role === 'player';
      const opts = player
        ? check('destination', 'Add it to the destination sites (where schedule sites can send visitors). It doesn’t become the main one.')
        : `${check('setup', '<strong>Set the site up right after connecting</strong> — same steps as the plugin’s setup wizard; pages that already exist are kept')}
          <div style="margin-left:1.6rem">
            <label for="a-brand">Brand name (empty = the site title)</label>
            <input type="text" id="a-brand" name="brand">
            ${check('theme', 'Install GeneratePress + the Zhibo child theme (the zhibo82.com look)')}
            ${check('homepage', 'Table on the homepage')}
            ${check('menu', 'Header menu (直播首页 + the first four sports), if the site has none')}
            <label>Sport pages</label>
            <div>${sportBoxes}</div>
          </div>`;
      return `<div style="margin:0.75rem 0">
          ${both ? `<label style="display:flex;gap:0.5rem;align-items:center"><input type="radio" name="plugin" value="${escapeHtml(slug)}" ${i === 0 ? 'checked' : ''}> <strong>${escapeHtml(hub.PLUGINS[slug].label)}</strong></label>` : `<input type="hidden" name="plugin" value="${escapeHtml(slug)}"><p>✓ <strong>${escapeHtml(hub.PLUGINS[slug].label)}</strong> is installed.</p>`}
          ${opts}
        </div>`;
    })
    .join('');

  return page(`<div class="card">${title}
      ${known ? `<p class="muted">Already checked in here (${ago(known.lastSeen)}, v${escapeHtml(known.version || '?')}). Connecting again is harmless.</p>` : ''}
      <form method="POST" action="/api/hub/connect/start">
        <input type="hidden" name="domain" value="${escapeHtml(probe.origin)}">
        ${choices}
        <button type="submit">Approve in WordPress →</button>
      </form>
      <p class="muted">Opens ${escapeHtml(probe.host)}'s own WordPress page “Authorize Application” (log in as an administrator if asked) and click <strong>Approve</strong>. You come back here connected. WordPress gives the hub a one-time Application Password for this; the hub uses it once and deletes it again.</p>
    </div>`);
}

function mountHubRoutes(app, { requireAuth, layout, escapeHtml, getConfig }) {
  // Scripts: "Authorization: Bearer <API token>". People: the dashboard login, from this app's pages.
  const tokenOrAdmin = (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (m) return hub.tokenMatches(m[1]) ? next() : res.status(401).json({ error: 'bad API token' });
    return requireAuth('admin')(req, res, () => sameOrigin(req, res, next));
  };

  // What the sites look like now (scripts/hub.js status)
  app.get('/api/hub/state', tokenOrAdmin, (req, res) => {
    const st = hub.getState();
    const sites = Object.entries(st.sites).map(([host, x]) => {
      const r = st.releases[hub.knownPlugin(x.plugin)];
      return {
        host,
        role: x.role || 'schedule',
        plugin: hub.knownPlugin(x.plugin),
        version: x.version,
        latest: r ? r.version : null,
        outdated: Boolean(r && hub.compareVersions(x.version, r.version) < 0),
        lastSeen: x.lastSeen,
        removed: Boolean(x.removed),
        home: x.home,
      };
    });
    res.json({
      sites,
      releases: Object.fromEntries(Object.entries(st.releases).map(([k, r]) => [k, { version: r.version, uploadedAt: r.uploadedAt, notes: r.notes }])),
      destinations: hub.destinations().map((d) => ({ host: d.host, url: d.url, main: d.main, inRotation: d.inRotation, connected: Boolean(d.player) })),
      rotation: Boolean(st.settings.rotationEnabled),
    });
  });

  // "Update now": every matching site whose plugin is older than the published one is asked to
  // install it right away. body: { site?: host | 'all', plugin?: slug }
  app.post('/api/hub/update', express.json({ limit: '16kb' }), tokenOrAdmin, async (req, res) => {
    const st = hub.getState();
    const want = hub.cleanHost((req.body && req.body.site) || 'all');
    const plugin = req.body && req.body.plugin ? hub.knownPlugin(req.body.plugin) : null;
    const targets = Object.entries(st.sites).filter(([host, x]) => {
      if (x.removed) return false;
      if (want !== 'all' && host !== want) return false;
      if (plugin && hub.knownPlugin(x.plugin) !== plugin) return false;
      return true;
    });
    if (want !== 'all' && !targets.length) return res.status(404).json({ error: `Unknown site ${want}` });
    const results = await Promise.all(
      targets.map(async ([host, x]) => {
        const r = st.releases[hub.knownPlugin(x.plugin)];
        const outdated = Boolean(r && hub.compareVersions(x.version, r.version) < 0);
        if (!outdated) return { host, version: x.version, latest: r ? r.version : null, action: 'up to date' };
        const poke = await pokeSite({ ...x, host }, { update: true });
        return { host, version: x.version, latest: r.version, action: poke.ok ? 'asked to update' : `unreachable: ${poke.error}`, answer: poke.answer };
      })
    );
    res.json({ results });
  });

  app.post('/api/hub/api-token', requireAuth('admin'), sameOrigin, (req, res) => {
    try {
      hub.createApiToken();
      res.redirect(`/sites?flash=${encodeURIComponent('New API token — copy it from Settings.')}`);
    } catch (err) {
      res.redirect(`/sites?flash=${encodeURIComponent('error:' + err.message)}`);
    }
  });
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

  // ── Add a site: check the domain → approve in its WordPress → connected ──
  // Before /sites/:host, which would otherwise take "add" for a domain
  app.get('/sites/add', requireAuth('admin'), async (req, res) => {
    const domain = String(req.query.domain || '').trim().slice(0, 300);
    if (!domain) return res.redirect('/sites');
    res.send(renderAddSite({ layout, escapeHtml }, domain, await hubConnect.probeSite(domain)));
  });

  app.post('/api/hub/connect/start', requireAuth('admin'), sameOrigin, async (req, res) => {
    // Checked again here: the authorize page address must come from the site, not the form
    const probe = await hubConnect.probeSite(req.body.domain);
    const plugin = String(req.body.plugin || '');
    if (probe.error) return back(res, `error:${probe.error}`);
    if (!probe.plugins.includes(plugin)) return back(res, `error:${probe.host} doesn't run that plugin`);
    if (!probe.authUrl) return back(res, `error:${probe.host} has Application Passwords turned off — connect it by hand`);
    const options =
      hub.PLUGINS[plugin].role === 'player'
        ? { destination: req.body.destination === '1' }
        : { setup: req.body.setup === '1' ? setupArgsFrom(req.body) : null };
    res.redirect(303, hubConnect.start({ origin: probe.origin, authUrl: probe.authUrl, plugin, options, hubBase: baseUrl(req, getConfig) }));
  });

  // WordPress sends the browser back here: ?site_url&user_login&password, or &rejected=1
  app.get('/sites/connect/done', requireAuth('admin'), async (req, res) => {
    const attempt = hubConnect.take(req.query.state);
    if (!attempt) return back(res, 'error:That approval expired or was already used — start again with “Add a site”.');
    const host = hub.cleanHost(attempt.origin);
    if (req.query.rejected || !req.query.password) return back(res, `error:${host} was not connected: the approval was declined in WordPress.`);

    const out = await hubConnect.finish(attempt, {
      user: req.query.user_login,
      password: req.query.password,
      hubBase: baseUrl(req, getConfig),
      networkKey: hub.networkKey(),
    });
    const revokeNote = out.revoked ? '' : ` Couldn't delete the “${hubConnect.APP_NAME}” Application Password on the site — remove it under Users → Profile → Application Passwords.`;
    if (!out.ok) return back(res, `error:${host} was not connected. ${out.error}${revokeNote}`);

    // The site checked in during /connect, under its own idea of its address
    const sites = hub.getState().sites;
    const site = [out.home && hub.cleanHost(out.home), host, host.replace(/^www\./, ''), `www.${host}`].find((h) => h && sites[h]) || host;
    const notes = [`${site} is connected.`];
    if (attempt.options.destination) {
      try {
        hub.addDestination(out.home || attempt.origin);
        notes.push('Added to the destination sites.');
      } catch (err) {
        notes.push(`Not added as a destination: ${err.message}.`);
      }
    }
    if (attempt.options.setup) {
      try {
        if (hub.compareVersions((sites[site] || {}).version, COMMANDS_SINCE) < 0) throw new Error(`the plugin needs v${COMMANDS_SINCE}+`);
        hub.queueCommand(site, 'setup', attempt.options.setup);
        const poke = await pokeSite(sites[site]);
        notes.push(poke.ok ? 'Set-up is running — refresh in a minute for the result.' : 'Set-up is queued; the site picks it up within 5 minutes.');
      } catch (err) {
        notes.push(`Set-up not started: ${err.message}.`);
      }
    }
    const flash = notes.join(' ') + revokeNote;
    return sites[site] ? siteBack(res, site, flash) : back(res, flash);
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
      const args = type === 'setup' ? setupArgsFrom(req.body) : {};
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
    tokenOrAdmin,
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
