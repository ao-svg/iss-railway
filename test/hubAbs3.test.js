// The token API ABS3 uses to make a WordPress site a schedule or player site of the network:
// a keyless plugin download link for the site's bridge, connecting with a one-off Application
// Password, queuing the plugin's set-up, and reading the site back.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createServer } = require('../src/server');
const hub = require('../src/hub');
const { buildZip } = require('../src/zip');

const WP_USER = 'abs3admin';
const WP_APP_PASS = 'one1 off2 pass3 word4';

function fakeDeps() {
  return {
    getState: () => ({}),
    runOnce: async () => {},
    rescheduleCron: () => {},
    runSourceCheck: async () => {},
    getSourceStatus: () => ({}),
    runTranslate: async () => {},
    getAllTranslations: () => ({}),
    setManualTranslation: () => {},
    getLeagueOverrides: () => ({}),
    setLeagueAlias: () => {},
    runLiveTvFetch: async () => {},
    getAllYouTubeChannels: () => [],
    setChannelStatus: () => {},
  };
}

// A WordPress site running the schedule plugin (zhibo/v1), as the hub sees it
function fakeWordPress(state) {
  const app = express();
  app.use(express.json());
  const authed = (req) => req.headers.authorization === 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64');
  app.all('/', async (req, res) => {
    const route = req.query.rest_route;
    const base = `http://localhost:${state.port}`;
    if (route === '/' && req.method === 'GET') {
      return res.json({ name: 'Fake schedule site', home: base, url: base, namespaces: ['wp/v2', 'abs3/v1', ...state.namespaces], authentication: {} });
    }
    if (route === '/zhibo/v1/poke' && req.method === 'POST') {
      state.pokes += 1;
      return res.json({ ok: true, version: '2.6.0', pending: 1 });
    }
    if (!authed(req)) return res.status(401).json({ code: 'rest_not_logged_in' });
    if (route === '/zhibo/v1/connect' && req.method === 'POST') {
      state.connects.push(req.body);
      const r = await fetch(`${req.body.hub_url}/api/hub/config?site=localhost&v=2.6.0&home=${encodeURIComponent(base + '/')}&bridge=2.8.0`, { headers: { 'X-Zhibo-Key': req.body.network_key } });
      return r.status === 200 ? res.json({ ok: true, home: `${base}/`, player_site: 'https://zhibo82.com' }) : res.status(502).json({ ok: false, error: `Hub answered HTTP ${r.status}` });
    }
    if (route === '/wp/v2/users/me/application-passwords/introspect') return res.json({ uuid: 'pw-abs3' });
    if (route === '/wp/v2/users/me/application-passwords/pw-abs3' && req.method === 'POST' && req.get('x-http-method-override') === 'DELETE') {
      state.deleted.push('pw-abs3');
      return res.json({ deleted: true });
    }
    res.status(404).json({ code: 'rest_no_route' });
  });
  return app;
}

test('ABS3 token API: package link, connect, set-up, site status', async (t) => {
  const st = hub.getState();
  const saved = { settings: { ...st.settings }, releases: { ...st.releases }, apiToken: st.apiToken };
  const token = hub.createApiToken();
  const bearer = { Authorization: `Bearer ${token}` };

  const wp = { namespaces: ['zhibo/v1'], connects: [], deleted: [], pokes: 0 };
  const wpServer = await new Promise((resolve) => { const s = fakeWordPress(wp).listen(0, () => resolve(s)); });
  wp.port = wpServer.address().port;
  const wpBase = `http://localhost:${wp.port}`;
  const server = await new Promise((resolve) => { const s = createServer(fakeDeps()).listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  const postJson = (path, body, headers = bearer) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  t.after(() => {
    server.close();
    wpServer.close();
    st.settings = saved.settings;
    st.releases = saved.releases;
    st.apiToken = saved.apiToken;
    hub.forgetSite('localhost');
    delete st.commands.localhost;
  });

  await t.test('every route needs the token', async () => {
    assert.equal((await postJson('/api/hub/package-link', { plugin: hub.PLUGIN_SLUG }, {})).status, 401);
    assert.equal((await postJson('/api/hub/connect', { site: wpBase }, { Authorization: 'Bearer nope' })).status, 401);
    assert.equal((await fetch(`${base}/api/hub/site/localhost`)).status, 401);
  });

  await t.test('package link: a keyless, signed, expiring download of the published zip', async () => {
    delete st.releases[hub.PLUGIN_SLUG];
    const r0 = await postJson('/api/hub/package-link', { plugin: hub.PLUGIN_SLUG });
    assert.equal(r0.status, 400);
    assert.match((await r0.json()).error, /Nothing published/);

    const main = `<?php\n/**\n * Plugin Name: Zhibo Streaming Table\n * Version: 2.6.0\n */\n`;
    hub.publishRelease(buildZip([{ name: `${hub.PLUGIN_SLUG}/zhibo882-streaming-table.php`, data: Buffer.from(main), mtime: new Date() }]), 'test');
    const r = await postJson('/api/hub/package-link', { plugin: hub.PLUGIN_SLUG });
    assert.equal(r.status, 200);
    const link = await r.json();
    assert.equal(link.version, '2.6.0');
    assert.match(link.url, /\/api\/hub\/package\?plugin=zhibo882-streaming-table&ticket=/);
    const zip = await fetch(link.url);
    assert.equal(zip.status, 200);
    assert.equal(zip.headers.get('content-type'), 'application/zip');
    assert.ok((await zip.arrayBuffer()).byteLength > 100);

    // The ticket is for that plugin only, and a forged one is refused
    const u = new URL(link.url);
    const other = await fetch(`${base}/api/hub/package?plugin=${hub.PLAYER_SLUG}&ticket=${encodeURIComponent(u.searchParams.get('ticket'))}`);
    assert.equal(other.status, 200, 'the ticket decides the plugin, not the query');
    assert.equal(hub.ticketPlugin(u.searchParams.get('ticket')), hub.PLUGIN_SLUG);
    assert.equal(hub.ticketPlugin(u.searchParams.get('ticket').replace(/.$/, 'x')), null);
    assert.equal((await fetch(`${base}/api/hub/package?plugin=${hub.PLUGIN_SLUG}&ticket=forged.forged`)).status, 401);
    assert.equal((await postJson('/api/hub/package-link', { plugin: 'nope' })).status, 400);
  });

  await t.test('connect: the site gets the hub URL and key, checks in, the password is deleted, set-up is queued', async () => {
    assert.equal((await fetch(`${base}/api/hub/site/localhost`, { headers: bearer })).status, 404);
    const r = await postJson('/api/hub/connect', { site: wpBase, plugin: hub.PLUGIN_SLUG, user: WP_USER, password: WP_APP_PASS, source: 'abs3', setup: { brand: 'Test 直播', theme: true, homepage: true, menu: false, sports: ['Football', 'Basketball', 'bad;name'] } });
    assert.equal(r.status, 200, await r.clone().text());
    const out = await r.json();
    assert.equal(out.ok, true);
    assert.equal(out.host, 'localhost');
    assert.equal(out.role, 'schedule');
    assert.equal(out.version, '2.6.0');
    assert.equal(out.revoked, true);
    assert.deepEqual(wp.connects.at(-1), { hub_url: base, network_key: hub.networkKey() });
    assert.deepEqual(wp.deleted, ['pw-abs3']);
    assert.equal(out.setup.status, 'running', 'the site was poked');
    assert.deepEqual(out.setup.args, { brand: 'Test 直播', theme: true, homepage: true, menu: false, sports: ['Football', 'Basketball'] });
    assert.equal(wp.pokes, 1);
    assert.equal(hub.getState().sites.localhost.managedBy, 'abs3');

    const site = await (await fetch(`${base}/api/hub/site/localhost`, { headers: bearer })).json();
    assert.equal(site.managedBy, 'abs3');
    assert.equal(site.plugin, hub.PLUGIN_SLUG);
    assert.equal(site.commands.length, 1);
    assert.equal(site.commands[0].type, 'setup');
    assert.equal(site.commands[0].status, 'queued');
    assert.equal(site.target, hub.getState().settings.defaultTarget);
    const state = await (await fetch(`${base}/api/hub/state`, { headers: bearer })).json();
    assert.equal(state.sites.find((s) => s.host === 'localhost').managedBy, 'abs3');
  });

  await t.test('connect: wrong password, wrong plugin, unknown site', async () => {
    const bad = await postJson('/api/hub/connect', { site: wpBase, plugin: hub.PLUGIN_SLUG, user: WP_USER, password: 'wrong' });
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error, /was not connected/);
    const wrong = await postJson('/api/hub/connect', { site: wpBase, plugin: hub.PLAYER_SLUG, user: WP_USER, password: WP_APP_PASS });
    assert.equal(wrong.status, 400);
    assert.match((await wrong.json()).error, /doesn't run Player plugin/);
    const missing = await postJson('/api/hub/connect', { site: wpBase, plugin: hub.PLUGIN_SLUG });
    assert.equal(missing.status, 400);
    assert.equal((await postJson('/api/hub/connect', { site: 'not a domain' })).status, 400);
  });

  await t.test('set-up on a connected site, and the result once the site reports', async () => {
    const r = await postJson('/api/hub/setup', { site: 'localhost', setup: { sports: ['Tennis'], homepage: false } });
    assert.equal(r.status, 200, await r.clone().text());
    const out = await r.json();
    assert.equal(out.command.status, 'running');
    assert.deepEqual(out.command.args, { sports: ['Tennis'], homepage: false });
    // The site runs it and reports, as the plugin does
    const handed = await (await fetch(`${base}/api/hub/config?site=localhost&v=2.6.0`, { headers: { 'X-Zhibo-Key': hub.networkKey() } })).json();
    assert.equal(handed.commands.length, 2);
    await fetch(`${base}/api/hub/report`, { method: 'POST', headers: { 'X-Zhibo-Key': hub.networkKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ site: 'localhost', results: [{ id: out.command.id, ok: true, log: ['Tennis: created /tennis/'] }], status: { version: '2.6.0', mode: 'network', theme: 'zhibo-child', homepage: true, pages: { Tennis: '/tennis/' }, bridge: '2.8.0', brand: 'Test 直播' } }) });
    const site = await (await fetch(`${base}/api/hub/site/localhost`, { headers: bearer })).json();
    const cmd = site.commands.find((c) => c.id === out.command.id);
    assert.equal(cmd.status, 'done');
    assert.deepEqual(cmd.log, ['Tennis: created /tennis/']);
    assert.deepEqual(site.details.pages, { Tennis: '/tennis/' });
    assert.equal(site.details.bridgeVersion, '2.8.0');
    assert.equal((await postJson('/api/hub/setup', { site: 'nowhere.example', setup: {} })).status, 404);
  });
});
