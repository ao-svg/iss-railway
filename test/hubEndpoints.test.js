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

  await t.test('a zip that is not the plugin is refused', async () => {
    const res = await fetch(`${base}/api/hub/release`, {
      method: 'PUT',
      headers: { Authorization: basic, Origin: base, 'Content-Type': 'application/zip' },
      body: buildZip([{ name: 'something/else.php', data: Buffer.from('x') }]),
    });
    assert.equal(res.status, 400);
  });
});
