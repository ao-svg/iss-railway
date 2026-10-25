const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createServer } = require('../src/server');
const auth = require('../src/auth');
const hub = require('../src/hub');
const hubConnect = require('../src/hubConnect');

const ADMIN_USER = 'test-admin-hubConnect';
const ADMIN_PASS = 'admin-pass-connect-123';
const basic = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');
const WP_USER = 'siteadmin';
const WP_APP_PASS = 'abcd efgh ijkl mnop';

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

// A WordPress site with the player plugin (zhibo82/v1), as far as the hub can see it
function fakeWordPress(state) {
  const app = express();
  app.use(express.json());
  const authed = (req) => req.headers.authorization === 'Basic ' + Buffer.from(`${WP_USER}:${WP_APP_PASS}`).toString('base64');
  app.all('/', async (req, res) => {
    const route = req.query.rest_route;
    const base = `http://localhost:${state.port}`;
    if (route === '/' && req.method === 'GET') {
      return res.json({
        name: 'Fake WP',
        home: base,
        url: base,
        namespaces: ['wp/v2', ...state.namespaces],
        authentication: state.appPasswords ? { 'application-passwords': { endpoints: { authorization: `${base}/wp-admin/authorize-application.php` } } } : {},
      });
    }
    if (!authed(req)) return res.status(401).json({ code: 'rest_not_logged_in', message: 'Sorry, you are not allowed to do that.' });
    if (route === '/zhibo82/v1/connect' && req.method === 'POST') {
      state.connects.push(req.body);
      // What the plugin does: save the settings, then check in with the hub
      const r = await fetch(`${req.body.hub_url}/api/hub/config?site=localhost&plugin=${hub.PLAYER_SLUG}&v=4.3.5&home=${encodeURIComponent(base + '/')}`, {
        headers: { 'X-Zhibo-Key': req.body.network_key },
      });
      return r.status === 200 ? res.json({ ok: true, home: `${base}/`, version: '4.3.5' }) : res.status(502).json({ ok: false, error: `Hub answered HTTP ${r.status}` });
    }
    if (route === '/wp/v2/users/me/application-passwords/introspect') return res.json({ uuid: 'pw-1', app_id: hubConnect.APP_ID });
    // Like WordPress: POST + X-HTTP-Method-Override: DELETE (a real DELETE is often blocked by the web server)
    if (route === '/wp/v2/users/me/application-passwords/pw-1' && req.method === 'POST' && req.get('x-http-method-override') === 'DELETE') {
      state.deleted.push('pw-1');
      return res.json({ deleted: true });
    }
    res.status(404).json({ code: 'rest_no_route' });
  });
  return app;
}

test('Add a site: check, approve in WordPress, connected', async (t) => {
  auth.upsert({ username: ADMIN_USER, password: ADMIN_PASS, role: 'admin' });
  const st = hub.getState();
  const savedSettings = { ...st.settings };

  const wp = { namespaces: ['zhibo82/v1'], appPasswords: true, connects: [], deleted: [] };
  const wpServer = await new Promise((resolve) => {
    const s = fakeWordPress(wp).listen(0, () => resolve(s));
  });
  wp.port = wpServer.address().port;
  const wpBase = `http://localhost:${wp.port}`;

  const server = await new Promise((resolve) => {
    const s = createServer(fakeDeps()).listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const get = (path) => fetch(`${base}${path}`, { redirect: 'manual', headers: { Authorization: basic } });
  const post = (path, fields) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: basic, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });
  // What WordPress does when the admin clicks Approve / Reject on its authorize page
  const approve = async (location, { password = WP_APP_PASS, reject = false } = {}) => {
    const u = new URL(location);
    assert.equal(u.origin + u.pathname, `${wpBase}/wp-admin/authorize-application.php`);
    assert.equal(u.searchParams.get('app_id'), hubConnect.APP_ID);
    const back = new URL(u.searchParams.get(reject ? 'reject_url' : 'success_url'));
    if (!reject) {
      back.searchParams.set('site_url', wpBase);
      back.searchParams.set('user_login', WP_USER);
      back.searchParams.set('password', password);
    }
    return get(back.pathname + back.search);
  };
  const start = (fields = {}) => post('/api/hub/connect/start', { domain: wpBase, plugin: hub.PLAYER_SLUG, destination: '1', ...fields });

  t.after(() => {
    server.close();
    wpServer.close();
    st.settings = savedSettings;
    hub.forgetSite('localhost');
    auth.remove(ADMIN_USER);
  });

  await t.test('the check page says which plugin is there', async () => {
    const res = await get(`/sites/add?domain=${encodeURIComponent(wpBase)}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Player plugin \(zhibo82\)<\/strong> is installed/);
    assert.match(html, /Approve in WordPress/);
  });

  await t.test('approved: the plugin gets the hub URL and key, checks in, and the password is deleted', async () => {
    const res = await start();
    assert.equal(res.status, 303);
    const done = await approve(res.headers.get('location'));
    assert.equal(done.status, 302);
    assert.match(decodeURIComponent(done.headers.get('location')), /^\/sites\/localhost\?flash=localhost is connected\. Added to the destination sites\./);
    assert.deepEqual(wp.connects.at(-1), { hub_url: base, network_key: hub.networkKey() });
    assert.deepEqual(wp.deleted, ['pw-1']);
    assert.equal(hub.getState().sites.localhost.role, 'player');
    assert.ok(hub.destinations().some((d) => d.url === wpBase));
  });

  await t.test('an approval link works once', async () => {
    const res = await start();
    const loc = res.headers.get('location');
    await approve(loc);
    const again = await approve(loc);
    assert.match(decodeURIComponent(again.headers.get('location')), /error:That approval expired or was already used/);
  });

  await t.test('declined in WordPress: nothing is sent to the site', async () => {
    const before = wp.connects.length;
    const res = await start();
    const done = await approve(res.headers.get('location'), { reject: true });
    assert.match(decodeURIComponent(done.headers.get('location')), /error:localhost was not connected: the approval was declined/);
    assert.equal(wp.connects.length, before);
  });

  await t.test('a password WordPress refuses: a clear error', async () => {
    const res = await start();
    const done = await approve(res.headers.get('location'), { password: 'wrong' });
    assert.match(decodeURIComponent(done.headers.get('location')), /error:localhost was not connected\. WordPress didn't accept the approval/);
  });

  await t.test('no plugin / no Application Passwords: says what to do instead', async () => {
    wp.namespaces = [];
    let html = await (await get(`/sites/add?domain=${encodeURIComponent(wpBase)}`)).text();
    assert.match(html, /neither plugin is installed/);
    wp.namespaces = ['zhibo/v1'];
    wp.appPasswords = false;
    html = await (await get(`/sites/add?domain=${encodeURIComponent(wpBase)}`)).text();
    assert.match(html, /Application Passwords turned off/);
    const res = await start({ plugin: hub.PLUGIN_SLUG });
    assert.match(decodeURIComponent(res.headers.get('location')), /error:localhost has Application Passwords turned off/);
  });

  await t.test('start comes from the hub page only', async () => {
    const res = await fetch(`${base}/api/hub/connect/start`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: basic, Origin: 'https://evil.example', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ domain: wpBase, plugin: hub.PLAYER_SLUG }),
    });
    assert.equal(res.status, 403);
  });
});
