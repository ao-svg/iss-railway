// The hub as a Claude connector (src/hubMcp.js on src/mcpConnector.js): Claude's sign-in behind
// the dashboard login, the MCP endpoint, and the hub's five tools.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const { createServer } = require('../src/server');
const auth = require('../src/auth');
const hub = require('../src/hub');
const { STORE_PATH } = require('../src/hubMcp');

const ADMIN_USER = 'test-admin-hubMcp';
const ADMIN_PASS = 'admin-pass-mcp-123';
const VIEWER_USER = 'test-viewer-hubMcp';
const SITE = 'hub-mcp-test.example';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const basicOf = (u, p) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const basic = basicOf(ADMIN_USER, ADMIN_PASS);

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

// A WordPress site as the hub's probe sees it: its REST index, with or without a zhibo plugin
function fakeWordPress(namespaces) {
  const app = express();
  app.get('/', (req, res) => {
    if (req.query.rest_route !== '/') return res.status(404).end();
    const base = `http://localhost:${req.socket.localPort}`;
    res.json({ name: 'Fake 直播', home: base, url: base, namespaces, authentication: { 'application-passwords': { endpoints: { authorization: `${base}/wp-admin/authorize-application.php` } } } });
  });
  return app;
}

const form = (o) => new URLSearchParams(o).toString();

test('hub Claude connector', async (t) => {
  const hadStore = fs.existsSync(STORE_PATH) ? fs.readFileSync(STORE_PATH) : null;
  auth.upsert({ username: ADMIN_USER, password: ADMIN_PASS, role: 'admin' });
  auth.upsert({ username: VIEWER_USER, password: ADMIN_PASS, role: 'viewer' });
  const st = hub.getState();
  const savedToken = st.apiToken;
  const apiToken = hub.createApiToken();

  const server = await new Promise((resolve) => { const s = createServer(fakeDeps()).listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  const wpWith = await new Promise((resolve) => { const s = fakeWordPress(['wp/v2', 'zhibo/v1']).listen(0, () => resolve(s)); });
  const wpWithout = await new Promise((resolve) => { const s = fakeWordPress(['wp/v2']).listen(0, () => resolve(s)); });

  t.after(() => {
    server.close();
    wpWith.close();
    wpWithout.close();
    hub.forgetSite(SITE);
    delete st.commands[SITE];
    st.apiToken = savedToken;
    auth.remove(ADMIN_USER);
    auth.remove(VIEWER_USER);
    if (hadStore) fs.writeFileSync(STORE_PATH, hadStore); else fs.rmSync(STORE_PATH, { force: true });
  });

  const post = (url, body, headers = {}) => fetch(url, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': typeof body === 'string' ? 'application/x-www-form-urlencoded' : 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const rpc = (token, method, params) => post(`${base}/mcp`, { jsonrpc: '2.0', id: 1, method, params }, token ? { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' } : {});
  const call = async (token, name, args = {}) => (await (await rpc(token, 'tools/call', { name, arguments: args })).json()).result;
  let tokens;
  let client;

  await t.test('without a token /mcp points Claude at the sign-in', async () => {
    const r = await rpc(null, 'tools/list');
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    const res = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(res.resource, `${base}/mcp`);
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    assert.equal(meta.authorization_endpoint, `${base}/oauth/authorize`);
    assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  });

  await t.test('sign-in: only Claude can register, the approval page needs the admin login', async () => {
    assert.equal((await post(`${base}/oauth/register`, { redirect_uris: ['https://evil.example/cb'] })).status, 400);
    client = await (await post(`${base}/oauth/register`, { client_name: 'Claude', redirect_uris: [CALLBACK] })).json();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const q = form({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'hub-1' });

    // No login, a wrong password, a viewer: the browser is asked for the admin login
    const anon = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
    assert.equal(anon.status, 401);
    assert.match(anon.headers.get('www-authenticate'), /^Basic /);
    assert.equal((await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual', headers: { Authorization: basicOf(ADMIN_USER, 'wrong') } })).status, 401);
    assert.equal((await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual', headers: { Authorization: basicOf(VIEWER_USER, ADMIN_PASS) } })).status, 401);

    const consent = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual', headers: { Authorization: basic } });
    assert.equal(consent.status, 200);
    const html = await consent.text();
    assert.match(html, /Connect Claude to ISS hub\?/);
    assert.match(html, new RegExp(ADMIN_USER));
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)[1];

    // The approval needs the login too, and must come from the hub's own page
    assert.equal((await post(`${base}/oauth/authorize`, form({ ticket, decision: 'approve' }), { Origin: base })).status, 401);
    assert.equal((await post(`${base}/oauth/authorize`, form({ ticket, decision: 'approve' }), { Origin: 'https://evil.example', Authorization: basic })).status, 403);
    const approved = await post(`${base}/oauth/authorize`, form({ ticket, decision: 'approve' }), { Origin: base, Authorization: basic });
    assert.equal(approved.status, 302);
    const back = new URL(approved.headers.get('location'));
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get('state'), 'hub-1');

    tokens = await (await post(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: verifier }))).json();
    assert.equal(tokens.token_type, 'Bearer');
    assert.ok(tokens.access_token && tokens.refresh_token);
    const stored = fs.readFileSync(STORE_PATH, 'utf8');
    assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token), 'tokens are stored hashed');
  });

  await t.test('MCP: initialize and the five tools', async () => {
    const init = await (await rpc(tokens.access_token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } })).json();
    assert.equal(init.result.serverInfo.name, 'iss-hub');
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await (await rpc(tokens.access_token, 'tools/list')).json();
    assert.deepEqual(list.result.tools.map((x) => x.name), ['list_sites', 'site_status', 'add_site', 'update_plugins', 'set_up_site']);
    assert.equal(list.result.tools.find((x) => x.name === 'list_sites').annotations.readOnlyHint, true);
    assert.equal(list.result.tools.find((x) => x.name === 'set_up_site').annotations.destructiveHint, true);
    assert.equal((await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
    // The scripts' API token works as a Bearer token too
    assert.equal((await rpc(apiToken, 'ping')).status, 200);
    assert.equal((await rpc('hub_wrong', 'ping')).status, 401);
  });

  await t.test('list_sites and site_status read the hub', async () => {
    hub.recordCheckin(SITE, { plugin: hub.PLUGIN_SLUG, version: '2.6.0', role: 'schedule', home: `https://${SITE}` });
    const list = await call(tokens.access_token, 'list_sites');
    assert.equal(list.isError, false);
    assert.match(list.content[0].text, new RegExp(`- ${SITE.replace(/\./g, '\\.')}  schedule  ${hub.PLUGIN_SLUG} 2\\.6\\.0`));
    assert.match(list.content[0].text, /Published plugins:/);
    assert.match(list.content[0].text, /Destinations \(rotation (on|off)\):/);

    const one = await call(tokens.access_token, 'site_status', { site: `www.${SITE}` });
    assert.equal(one.isError, false);
    const json = JSON.parse(one.content[0].text);
    assert.equal(json.host, SITE);
    assert.equal(json.version, '2.6.0');
    assert.ok(Array.isArray(json.commands));
    const none = await call(tokens.access_token, 'site_status', { site: 'nope.example' });
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /no site nope\.example/);
  });

  await t.test('add_site checks the site and answers with the connect link, changing nothing', async () => {
    const sitesBefore = Object.keys(hub.getState().sites).length;
    const ready = await call(tokens.access_token, 'add_site', { domain: `http://localhost:${wpWith.address().port}` });
    assert.equal(ready.isError, false);
    assert.match(ready.content[0].text, /runs Schedule plugin \(zhibo882\) and is ready to connect/);
    assert.ok(ready.content[0].text.includes(`${base}/sites/add?domain=${encodeURIComponent(`http://localhost:${wpWith.address().port}`)}`));

    const bare = await call(tokens.access_token, 'add_site', { domain: `http://localhost:${wpWithout.address().port}` });
    assert.match(bare.content[0].text, /runs neither zhibo plugin/);
    assert.match(bare.content[0].text, /zhibo882/);
    assert.ok(bare.content[0].text.includes(`${base}/sites/download?plugin=${hub.PLUGIN_SLUG}`));

    assert.equal((await call(tokens.access_token, 'add_site', {})).isError, true);
    assert.equal((await call(tokens.access_token, 'add_site', { domain: 'not a domain' })).isError, true);
    assert.equal(Object.keys(hub.getState().sites).length, sitesBefore);
  });

  await t.test('update_plugins and set_up_site act through the hub\'s own logic', async () => {
    const upd = await call(tokens.access_token, 'update_plugins', { site: SITE });
    assert.equal(upd.isError, false);
    assert.match(upd.content[0].text, new RegExp(`- ${SITE.replace(/\./g, '\\.')}: `));
    assert.equal((await call(tokens.access_token, 'update_plugins', { site: 'nope.example' })).isError, true);

    const unknown = await call(tokens.access_token, 'set_up_site', { site: 'nope.example' });
    assert.equal(unknown.isError, true);
    assert.match(unknown.content[0].text, /connect it first/);
    const setup = await call(tokens.access_token, 'set_up_site', { site: SITE, sports: ['Football', 'Basketball'], brand: 'Test 直播', menu: false });
    assert.equal(setup.isError, false, setup.content[0].text);
    assert.match(setup.content[0].text, /^Set-up queued on hub-mcp-test\.example/);
    const cmd = hub.commandsFor(SITE).slice(-1)[0];
    assert.equal(cmd.type, 'setup');
    assert.deepEqual(cmd.args, { brand: 'Test 直播', theme: true, menu: false, homepage: true, sports: ['Football', 'Basketball'] });
    const after = JSON.parse((await call(tokens.access_token, 'site_status', { site: SITE })).content[0].text);
    assert.equal(after.commands.slice(-1)[0].id, cmd.id);
  });

  await t.test('the Settings card lists the connection; Disconnect ends it', async () => {
    const page = await (await fetch(`${base}/sites`, { headers: { Authorization: basic } })).text();
    assert.ok(page.includes(`${base}/mcp`));
    assert.match(page, new RegExp(`Claude as ${ADMIN_USER}`));
    const id = /action="\/api\/hub\/claude\/disconnect"[^>]*><input type="hidden" name="id" value="([^"]+)"/.exec(page)[1];
    assert.equal((await post(`${base}/api/hub/claude/disconnect`, form({ id }), { Origin: 'https://evil.example', Authorization: basic })).status, 403);
    const off = await post(`${base}/api/hub/claude/disconnect`, form({ id }), { Origin: base, Authorization: basic });
    assert.equal(off.status, 302);
    assert.equal((await rpc(tokens.access_token, 'ping')).status, 401);
    const refresh = await post(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }));
    assert.equal((await refresh.json()).error, 'invalid_grant');
  });

  await t.test('a connection ends when its admin is removed', async () => {
    // A second connection, then the account goes
    const verifier = crypto.randomBytes(32).toString('base64url');
    const q = form({ response_type: 'code', client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    const html = await (await fetch(`${base}/oauth/authorize?${q}`, { headers: { Authorization: basic } })).text();
    const ticket = /name="ticket" value="([^"]+)"/.exec(html)[1];
    const approved = await post(`${base}/oauth/authorize`, form({ ticket, decision: 'approve' }), { Origin: base, Authorization: basic });
    const code = new URL(approved.headers.get('location')).searchParams.get('code');
    const t2 = await (await post(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, client_id: client.client_id, redirect_uri: CALLBACK, code_verifier: verifier }))).json();
    assert.equal((await rpc(t2.access_token, 'ping')).status, 200);
    auth.upsert({ username: ADMIN_USER, role: 'viewer' });
    assert.equal((await rpc(t2.access_token, 'ping')).status, 401);
    auth.upsert({ username: ADMIN_USER, role: 'admin' });
  });
});
