const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const auth = require('../src/auth');

// Fixed (not timestamped) usernames: the "cannot delete the last admin"
// guard means this test's admin account can never be removed once it's the
// only admin left in an empty store (see t.after() below) — using a fixed
// name means repeated runs reuse/overwrite the same one leftover record
// instead of accumulating a new timestamped one per run.
const ADMIN_USER = 'test-admin-authEndpoints';
const ADMIN_PASS = 'admin-pass-123';
const VIEWER_USER = 'test-viewer-authEndpoints';
const VIEWER_PASS = 'viewer-pass-123';

function basicAuthHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function fakeCreateServerDeps() {
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

test('role-gated HTTP endpoints', async (t) => {
  auth.upsert({ username: ADMIN_USER, password: ADMIN_PASS, role: 'admin' });
  auth.upsert({ username: VIEWER_USER, password: VIEWER_PASS, role: 'viewer' });

  const app = createServer(fakeCreateServerDeps());
  const server = await startServer(app);
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  t.after(() => {
    server.close();
    // The viewer is always safely removable. The admin can only be removed
    // here too if some OTHER admin already existed before this test ran
    // (e.g. a real seeded ADMIN_PASSWORD account) — if this test's admin
    // is the sole admin in the store, the last-admin guard correctly
    // refuses to delete it, so it's left behind on purpose (see the fixed-
    // username comment above) rather than worked around.
    auth.remove(VIEWER_USER);
    const { error } = auth.remove(ADMIN_USER);
    if (error) console.log(`[authEndpoints.test] left ${ADMIN_USER} in place: ${error}`);
  });

  await t.test('no Authorization header on / -> 401 with WWW-Authenticate', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get('www-authenticate') || '', /Basic/);
  });

  await t.test('admin creds on / -> 200', async () => {
    const res = await fetch(`${base}/`, { headers: { Authorization: basicAuthHeader(ADMIN_USER, ADMIN_PASS) } });
    assert.equal(res.status, 200);
  });

  await t.test('admin creds on /browse -> 200 (admin reaches viewer routes too)', async () => {
    const res = await fetch(`${base}/browse`, { headers: { Authorization: basicAuthHeader(ADMIN_USER, ADMIN_PASS) } });
    assert.equal(res.status, 200);
  });

  await t.test('viewer creds on /browse -> 200', async () => {
    const res = await fetch(`${base}/browse`, { headers: { Authorization: basicAuthHeader(VIEWER_USER, VIEWER_PASS) } });
    assert.equal(res.status, 200);
  });

  await t.test('viewer creds on / -> 401 (role too low)', async () => {
    const res = await fetch(`${base}/`, { headers: { Authorization: basicAuthHeader(VIEWER_USER, VIEWER_PASS) } });
    assert.equal(res.status, 401);
  });

  await t.test('viewer creds on /settings, /users, /api/run -> 401 each', async () => {
    const headers = { Authorization: basicAuthHeader(VIEWER_USER, VIEWER_PASS) };
    const settings = await fetch(`${base}/settings`, { headers });
    const users = await fetch(`${base}/users`, { headers });
    const run = await fetch(`${base}/api/run`, { method: 'POST', headers });
    assert.equal(settings.status, 401);
    assert.equal(users.status, 401);
    assert.equal(run.status, 401);
  });

  await t.test('wrong password for an existing username -> 401', async () => {
    const res = await fetch(`${base}/`, { headers: { Authorization: basicAuthHeader(ADMIN_USER, 'wrong-password') } });
    assert.equal(res.status, 401);
  });

  await t.test('unknown username -> 401', async () => {
    const res = await fetch(`${base}/`, { headers: { Authorization: basicAuthHeader('nobody-at-all', 'whatever') } });
    assert.equal(res.status, 401);
  });

  await t.test('public routes stay reachable with no Authorization header', async () => {
    for (const path of ['/health', '/fixtures.csv', '/fixtures.json', '/live.csv', '/live.json']) {
      const res = await fetch(`${base}${path}`);
      assert.notEqual(res.status, 401, `${path} should not require auth`);
    }
  });
});
