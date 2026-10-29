const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const auth = require('../src/auth');
const hub = require('../src/hub');
const { buildZip } = require('../src/zip');

const ADMIN_USER = 'test-admin-hubEndpoints';
const ADMIN_PASS = 'admin-pass-hub-123';
const SITE = 'hub-endpoints-test.example';
const PLAYER = 'hub-endpoints-player.example';

const basic = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASS}`).toString('base64');

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

test('hub endpoints', async (t) => {
  auth.upsert({ username: ADMIN_USER, password: ADMIN_PASS, role: 'admin' });
  const st = hub.getState();
  const saved = { settings: { ...st.settings }, overrides: { ...st.overrides }, releases: { ...st.releases } };

  const server = await new Promise((resolve) => {
    const s = createServer(fakeDeps()).listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const key = hub.networkKey();
  const config = (site = SITE) => fetch(`${base}/api/hub/config?site=${site}&v=1.0.0&theme=zhibo-child&pages=3`, { headers: { 'X-Zhibo-Key': key } });
  const adminPost = (path, fields, origin = base) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: basic, Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });

  t.after(() => {
    server.close();
    // Leave the store as this test found it
    st.settings = saved.settings;
    st.overrides = saved.overrides;
    st.releases = saved.releases;
    hub.forgetSite(PLAYER);
    hub.forgetSite(SITE);
    delete st.commands[SITE];
    auth.remove(ADMIN_USER);
  });

  await t.test('config without the network key -> 401', async () => {
    const res = await fetch(`${base}/api/hub/config?site=${SITE}`);
    assert.equal(res.status, 401);
  });

  await t.test('config with the key: destination, own feeds by default, and a check-in', async () => {
    hub.updateSettings({ defaultTarget: 'https://zhibo82.com', feedFixtures: '', feedLive: '' });
    const res = await config();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.player_site, 'https://zhibo82.com');
    assert.equal(body.feeds.fixtures, `${base}/fixtures.json`);
    assert.equal(hub.getState().sites[SITE].version, '1.0.0');
    assert.equal(hub.getState().sites[SITE].pages, 3);
  });

  await t.test('/sites needs admin auth', async () => {
    assert.equal((await fetch(`${base}/sites`)).status, 401);
    const res = await fetch(`${base}/sites`, { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), new RegExp(SITE.replace(/\./g, '\\.')));
  });

  await t.test('admin POST from another origin -> 403 (Basic auth is resent cross-site)', async () => {
    const res = await adminPost('/api/hub/destination', { defaultTarget: 'https://evil.example' }, 'https://evil.example');
    assert.equal(res.status, 403);
    assert.equal(hub.getState().settings.defaultTarget, 'https://zhibo82.com');
  });

  await t.test('changing the destination moves the site; an override wins', async () => {
    let res = await adminPost('/api/hub/destination', { defaultTarget: 'https://zhibo83.example/' });
    assert.equal(res.status, 302);
    assert.equal((await (await config()).json()).player_site, 'https://zhibo83.example');

    res = await adminPost('/api/hub/override', { host: SITE, target: 'https://other.example' });
    assert.equal(res.status, 302);
    assert.equal((await (await config()).json()).player_site, 'https://other.example');

    await adminPost('/api/hub/override', { host: SITE, target: '' });
    assert.equal((await (await config()).json()).player_site, 'https://zhibo83.example');
  });

  await t.test('rotation: sites get the destination list only while it is on', async () => {
    let res = await adminPost('/api/hub/rotation', { rotation: 'https://zazhibo82.example\nnot a url', rotationEnabled: '1' });
    assert.match(decodeURIComponent(res.headers.get('location')), /error:Rotation destination "not a url"/);

    res = await adminPost('/api/hub/rotation', { rotation: 'https://zazhibo82.example\nhttps://zhibo83.example', rotationEnabled: '1' });
    assert.equal(res.status, 302);
    assert.deepEqual((await (await config()).json()).rotation, ['https://zhibo83.example', 'https://zazhibo82.example']);

    await adminPost('/api/hub/rotation', { rotation: 'https://zazhibo82.example' });   // checkbox unticked
    assert.deepEqual((await (await config()).json()).rotation, []);
  });

  await t.test('commands: queued on the hub, handed out with the settings, finished by the site\x27s report', async () => {
    let res = await adminPost('/api/hub/command', { host: SITE, type: 'setup', brand: 'Test', theme: '1', homepage: '1', sports: 'Football' });
    assert.equal(res.status, 302);
    let cfg = await (await config()).json();
    assert.equal(cfg.commands.length, 1);
    const cmd = cfg.commands[0];
    assert.deepEqual(cmd.args, { brand: 'Test', theme: true, homepage: true, menu: false, sports: ['Football'] });

    // Handed out again until the site reports (the plugin skips ids it already ran)
    assert.equal((await (await config()).json()).commands.length, 1);

    const report = (body, key = hub.networkKey()) =>
      fetch(`${base}/api/hub/report`, { method: 'POST', headers: { 'X-Zhibo-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await report({ site: SITE, results: [] }, 'wrong')).status, 401);
    res = await report({ site: SITE, results: [{ id: cmd.id, ok: true, log: ['Theme: ok'] }], status: { theme: 'zhibo-child', homepage: true, pages: { Football: '/football/' } } });
    assert.equal(res.status, 200);
    assert.equal((await (await config()).json()).commands.length, 0);
    const done = hub.commandsFor(SITE).find((c) => c.id === cmd.id);
    assert.equal(done.status, 'done');
    assert.equal(hub.getState().sites[SITE].details.pages.Football, '/football/');

    // Removal: cancels what is still queued, and the report marks the site removed
    await adminPost('/api/hub/command', { host: SITE, type: 'setup' });
    await adminPost('/api/hub/command', { host: SITE, type: 'uninstall' });
    cfg = await (await config()).json();
    assert.deepEqual(cfg.commands.map((c) => c.type), ['uninstall']);
    await report({ site: SITE, results: [{ id: cfg.commands[0].id, ok: true, log: ['Settings removed'], removed: true }] });
    assert.equal(hub.getState().sites[SITE].removed, true);

    // Checking in again (plugin reinstalled) clears the flag
    await config();
    assert.equal(hub.getState().sites[SITE].removed, false);

    res = await fetch(`${base}/sites/${SITE}`, { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Settings removed/);
  });

  await t.test('commands for an unknown site are refused', async () => {
    const res = await adminPost('/api/hub/command', { host: 'nope.example', type: 'setup' });
    assert.match(decodeURIComponent(res.headers.get('location')), /error:Unknown site/);
  });

  await t.test('invalid destination is refused with a message', async () => {
    const res = await adminPost('/api/hub/destination', { defaultTarget: 'javascript:alert(1)' });
    assert.match(decodeURIComponent(res.headers.get('location')), /error:Destination is not a valid/);
  });

  await t.test('publishing a plugin zip offers it to sites and serves it to the key holder', async () => {
    const zip = buildZip([
      { name: `${hub.PLUGIN_SLUG}/${hub.PLUGIN_SLUG}.php`, data: Buffer.from('<?php\n/*\n * Version: 9.9.9\n */') },
    ]);
    const up = await fetch(`${base}/api/hub/release?notes=test`, {
      method: 'PUT',
      headers: { Authorization: basic, Origin: base, 'Content-Type': 'application/zip' },
      body: zip,
    });
    assert.equal(up.status, 200);
    assert.equal((await up.json()).version, '9.9.9');

    const latest = (await (await config()).json()).latest;
    assert.equal(latest.version, '9.9.9');
    const pkg = await fetch(latest.package);
    assert.equal(pkg.status, 200);
    assert.deepEqual(Buffer.from(await pkg.arrayBuffer()), zip);

    assert.equal((await fetch(`${base}/api/hub/package?key=wrong`)).status, 401);
  });

  await t.test('player sites: own role and release, no destination or commands', async () => {
    const res = await fetch(`${base}/api/hub/config?site=${PLAYER}&plugin=${hub.PLAYER_SLUG}&v=4.0.0&home=https://${PLAYER}/`, { headers: { 'X-Zhibo-Key': key } });
    const body = await res.json();
    assert.equal(body.role, 'player');
    assert.equal(body.player_site, undefined);
    assert.equal(body.commands, undefined);
    assert.equal(body.feeds.fixtures, `${base}/fixtures.json`);
    assert.equal(hub.getState().sites[PLAYER].role, 'player');
    assert.deepEqual(hub.playerSites().map((p) => p.host), [PLAYER]);

    // A player-plugin zip is a release for player sites only
    const zip = buildZip([{ name: `${hub.PLAYER_SLUG}/zhibo82-streaming-table.php`, data: Buffer.from('<?php\n/*\n * Version: 4.9.0\n */') }]);
    const up = await fetch(`${base}/api/hub/release`, { method: 'PUT', headers: { Authorization: basic, Origin: base, 'Content-Type': 'application/zip' }, body: zip });
    assert.equal((await up.json()).slug, hub.PLAYER_SLUG);
    const playerLatest = (await (await fetch(`${base}/api/hub/config?site=${PLAYER}&plugin=${hub.PLAYER_SLUG}`, { headers: { 'X-Zhibo-Key': key } })).json()).latest;
    assert.equal(playerLatest.version, '4.9.0');
    assert.deepEqual(Buffer.from(await (await fetch(playerLatest.package)).arrayBuffer()), zip);
    assert.equal((await (await config()).json()).latest.version, '9.9.9');   // the schedule plugin's release is untouched

    const cmd = await adminPost('/api/hub/command', { host: PLAYER, type: 'setup' });
    assert.match(decodeURIComponent(cmd.headers.get('location')), /error:.*player site/);
  });

  await t.test('destination sites: one list, a main one, optional rotation, per-site choice', async () => {
    // The player site that checked in above is listed without being added
    assert.ok(hub.destinations().some((d) => d.host === PLAYER && d.player));

    let res = await adminPost('/api/hub/destinations/add', { url: 'https://zazhibo82.example/' });
    assert.equal(res.status, 302);
    assert.ok(hub.destinations().some((d) => d.host === 'zazhibo82.example' && d.manual));

    // Main = the player site, rotate with the added one
    res = await adminPost('/api/hub/destinations', { main: `https://${PLAYER}`, rotate: ['https://zazhibo82.example'], rotationEnabled: '1' });
    assert.equal(res.status, 302);
    let cfg = await (await config()).json();
    assert.equal(cfg.player_site, `https://${PLAYER}`);
    assert.deepEqual(cfg.rotation, [`https://${PLAYER}`, 'https://zazhibo82.example']);

    // A destination that isn't in the list can't be made main
    res = await adminPost('/api/hub/destinations', { main: 'https://nowhere.example' });
    assert.match(decodeURIComponent(res.headers.get('location')), /error:Pick the main destination/);

    // Per site: one destination only, then back to the default
    await adminPost('/api/hub/override', { host: SITE, target: 'https://zazhibo82.example' });
    cfg = await (await config()).json();
    assert.equal(cfg.player_site, 'https://zazhibo82.example');
    assert.deepEqual(cfg.rotation, []);
    await adminPost('/api/hub/override', { host: SITE, target: '' });

    // The main one can't be removed; a hand-added one can, and leaves the rotation with it
    res = await adminPost('/api/hub/destinations/remove', { url: `https://${PLAYER}` });
    assert.match(decodeURIComponent(res.headers.get('location')), /error:That is the main destination/);
    await adminPost('/api/hub/destinations/remove', { url: 'https://zazhibo82.example' });
    cfg = await (await config()).json();
    assert.equal(cfg.player_site, `https://${PLAYER}`);
    assert.deepEqual(cfg.rotation, []);
  });

  await t.test('zips dropped into hub-incoming/ are published; the page offers them for download', async () => {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(hub.INCOMING_DIR, { recursive: true });
    const good = path.join(hub.INCOMING_DIR, 'test-player.zip');
    const bad = path.join(hub.INCOMING_DIR, 'test-bad.zip');
    const zip = buildZip([{ name: `${hub.PLAYER_SLUG}/zhibo82-streaming-table.php`, data: Buffer.from('<?php\n/*\n * Version: 4.9.5\n */') }]);
    fs.writeFileSync(good, zip);
    fs.writeFileSync(bad, buildZip([{ name: 'other/x.php', data: Buffer.from('x') }]));
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(good, old, old);
    fs.utimesSync(bad, old, old);

    const published = hub.importIncoming();
    assert.deepEqual(published.map((r) => `${r.slug} ${r.version}`), [`${hub.PLAYER_SLUG} 4.9.5`]);
    assert.equal(fs.existsSync(good), false);
    assert.equal(fs.existsSync(`${bad}.rejected`), true);
    assert.match(fs.readFileSync(`${bad}.rejected.txt`, 'utf8'), /one plugin folder/);
    fs.rmSync(`${bad}.rejected`, { force: true });
    fs.rmSync(`${bad}.rejected.txt`, { force: true });

    assert.equal((await fetch(`${base}/sites/download?plugin=${hub.PLAYER_SLUG}`)).status, 401);
    const res = await fetch(`${base}/sites/download?plugin=${hub.PLAYER_SLUG}`, { headers: { Authorization: basic } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /zhibo82-streaming-table-v3-4\.9\.5\.zip/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), zip);
    assert.match(await (await fetch(`${base}/sites`, { headers: { Authorization: basic } })).text(), /Download zip/);
  });

  await t.test('zips committed to plugin-releases/ are published when newer, and left alone otherwise', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-releases-'));
    const player = (v) => buildZip([{ name: `${hub.PLAYER_SLUG}/zhibo82-streaming-table.php`, data: Buffer.from(`<?php\n/*\n * Version: ${v}\n */`) }]);
    try {
      fs.writeFileSync(path.join(dir, 'a-older.zip'), player('4.9.4'));   // the previous test published 4.9.5
      fs.writeFileSync(path.join(dir, 'b-newer.zip'), player('4.9.6'));
      fs.writeFileSync(path.join(dir, 'c-bad.zip'), buildZip([{ name: 'other/x.php', data: Buffer.from('x') }]));
      const published = hub.importRepoReleases(dir);
      assert.deepEqual(published.map((r) => `${r.slug} ${r.version}`), [`${hub.PLAYER_SLUG} 4.9.6`]);
      assert.equal(hub.getState().releases[hub.PLAYER_SLUG].version, '4.9.6');
      assert.equal(fs.existsSync(path.join(dir, 'b-newer.zip')), true);   // part of the deployed code: kept
      // Same versions again (the next restart): nothing to do
      assert.deepEqual(hub.importRepoReleases(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t.test('API token: scripts read the state, publish, and ask outdated sites to update now', async () => {
    const http = require('http');
    const bearer = (tok) => ({ Authorization: `Bearer ${tok}` });
    assert.equal((await fetch(`${base}/api/hub/state`, { headers: bearer('nope') })).status, 401);

    const token = hub.createApiToken();
    const state = await (await fetch(`${base}/api/hub/state`, { headers: bearer(token) })).json();
    assert.ok(state.sites.some((x) => x.host === SITE));

    // Publish with the token (no login, no same-origin page)
    const zip = buildZip([{ name: `${hub.PLUGIN_SLUG}/${hub.PLUGIN_SLUG}.php`, data: Buffer.from('<?php\n/*\n * Version: 9.9.10\n */') }]);
    const up = await fetch(`${base}/api/hub/release`, { method: 'PUT', headers: { ...bearer(token), 'Content-Type': 'application/zip' }, body: zip });
    assert.equal((await up.json()).version, '9.9.10');

    // A stand-in WordPress site that records the poke
    const pokes = [];
    const fake = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c)).on('end', () => {
        pokes.push({ url: req.url, body: b });
        res.setHeader('Content-Type', 'application/json');
        res.end('{"ok":true,"updating":"9.9.10"}');
      });
    });
    await new Promise((r) => fake.listen(0, r));
    t.after(() => fake.close());
    const fakeHome = `http://localhost:${fake.address().port}/`;
    await fetch(`${base}/api/hub/config?site=${SITE}&v=1.0.0&home=${encodeURIComponent(fakeHome)}`, { headers: { 'X-Zhibo-Key': key } });

    const upd = await (await fetch(`${base}/api/hub/update`, { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ site: SITE }) })).json();
    assert.equal(upd.results.length, 1);
    assert.equal(upd.results[0].action, 'asked to update');
    assert.deepEqual(JSON.parse(pokes[0].body), { update: true });
    assert.match(pokes[0].url, /rest_route=\/zhibo\/v1\/poke/);

    const missing = await fetch(`${base}/api/hub/update`, { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ site: 'nope.example' }) });
    assert.equal(missing.status, 404);
    delete hub.getState().apiToken;
  });

  await t.test('a zip that is not the plugin is refused', async () => {
    const res = await fetch(`${base}/api/hub/release`, {
      method: 'PUT',
      headers: { Authorization: basic, Origin: base, 'Content-Type': 'application/zip' },
      body: buildZip([{ name: 'something/else.php', data: Buffer.from('x') }]),
    });
    assert.equal(res.status, 400);
  });
});
