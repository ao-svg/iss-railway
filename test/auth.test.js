const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword,
  verifyPassword,
  verifyCredentials,
  hasRole,
  upsertUser,
  deleteUser,
  seedFromEnv,
} = require('../src/auth');

function makeUser(username, password, role = 'admin') {
  const { salt, hash } = hashPassword(password);
  return { username, role, salt, hash, createdAt: '2026-08-24T00:00:00.000Z', updatedAt: '2026-08-24T00:00:00.000Z' };
}

test('hashPassword/verifyPassword round-trip', () => {
  const { salt, hash } = hashPassword('correct-horse');
  assert.equal(verifyPassword('correct-horse', salt, hash), true);
  assert.equal(verifyPassword('wrong', salt, hash), false);
});

test('verifyPassword returns false (not throw) on a malformed stored hash', () => {
  assert.equal(verifyPassword('anything', undefined, undefined), false);
  assert.equal(verifyPassword('anything', 'deadbeef', 'not-valid-hex-zz'), false);
});

test('verifyCredentials: unknown username returns null', () => {
  const users = [makeUser('admin', 'secret')];
  assert.equal(verifyCredentials(users, 'nobody', 'secret'), null);
});

test('verifyCredentials: correct creds return the user record', () => {
  const users = [makeUser('admin', 'secret')];
  const result = verifyCredentials(users, 'admin', 'secret');
  assert.ok(result);
  assert.equal(result.username, 'admin');
});

test('verifyCredentials: wrong password returns null', () => {
  const users = [makeUser('admin', 'secret')];
  assert.equal(verifyCredentials(users, 'admin', 'nope'), null);
});

test('verifyCredentials: username lookup is case-insensitive', () => {
  const users = [makeUser('Admin', 'secret')];
  const result = verifyCredentials(users, 'admin', 'secret');
  assert.ok(result);
  assert.equal(result.username, 'Admin');
});

test('hasRole: admin passes both admin and viewer checks', () => {
  const admin = { role: 'admin' };
  assert.equal(hasRole(admin, 'admin'), true);
  assert.equal(hasRole(admin, 'viewer'), true);
});

test('hasRole: viewer passes viewer, fails admin', () => {
  const viewer = { role: 'viewer' };
  assert.equal(hasRole(viewer, 'viewer'), true);
  assert.equal(hasRole(viewer, 'admin'), false);
});

test('hasRole: null user fails both', () => {
  assert.equal(hasRole(null, 'viewer'), false);
  assert.equal(hasRole(null, 'admin'), false);
});

test('upsertUser: new username appends with a fresh hash', () => {
  const users = [makeUser('admin', 'secret')];
  const next = upsertUser(users, { username: 'jane', password: 'viewpass', role: 'viewer' });
  assert.equal(next.length, 2);
  const jane = next.find((u) => u.username === 'jane');
  assert.ok(jane);
  assert.equal(verifyPassword('viewpass', jane.salt, jane.hash), true);
});

test('upsertUser: existing username + new password replaces only that hash and bumps updatedAt', () => {
  const users = [makeUser('admin', 'secret'), makeUser('jane', 'oldpass', 'viewer')];
  const before = users.find((u) => u.username === 'admin');
  const janeBefore = users.find((u) => u.username === 'jane');
  const next = upsertUser(users, { username: 'jane', password: 'newpass', role: 'viewer' });
  const admin = next.find((u) => u.username === 'admin');
  const jane = next.find((u) => u.username === 'jane');
  assert.deepEqual(admin, before); // untouched
  assert.equal(verifyPassword('newpass', jane.salt, jane.hash), true);
  assert.equal(verifyPassword('oldpass', jane.salt, jane.hash), false);
  assert.notEqual(jane.hash, janeBefore.hash);
});

test('upsertUser: existing username + blank password keeps the prior hash', () => {
  const users = [makeUser('jane', 'oldpass', 'viewer')];
  const prevHash = users[0].hash;
  const next = upsertUser(users, { username: 'jane', password: '', role: 'admin' });
  const jane = next.find((u) => u.username === 'jane');
  assert.equal(jane.hash, prevHash);
  assert.equal(jane.role, 'admin'); // role still updates even without a password change
  assert.equal(verifyPassword('oldpass', jane.salt, jane.hash), true);
});

test('upsertUser: invalid role throws', () => {
  assert.throws(() => upsertUser([], { username: 'x', password: 'pw', role: 'superadmin' }));
});

test('upsertUser: new account with no password throws', () => {
  assert.throws(() => upsertUser([], { username: 'x', password: '', role: 'viewer' }));
});

test('deleteUser: non-last admin deletes fine', () => {
  const users = [makeUser('admin1', 'a'), makeUser('admin2', 'b')];
  const { users: next, error } = deleteUser(users, 'admin1');
  assert.equal(error, null);
  assert.equal(next.length, 1);
  assert.equal(next[0].username, 'admin2');
});

test('deleteUser: sole remaining admin is blocked', () => {
  const users = [makeUser('admin', 'a'), makeUser('jane', 'b', 'viewer')];
  const { users: next, error } = deleteUser(users, 'admin');
  assert.equal(error, 'cannot delete the last admin account');
  assert.deepEqual(next, users); // unchanged
});

test('deleteUser: deleting a viewer never trips the last-admin guard', () => {
  const users = [makeUser('admin', 'a'), makeUser('jane', 'b', 'viewer')];
  const { users: next, error } = deleteUser(users, 'jane');
  assert.equal(error, null);
  assert.equal(next.length, 1);
});

test('deleteUser: unknown username returns not-found error without mutating', () => {
  const users = [makeUser('admin', 'a')];
  const { users: next, error } = deleteUser(users, 'ghost');
  assert.equal(error, 'not found');
  assert.deepEqual(next, users);
});

test('seedFromEnv: empty array + ADMIN_PASSWORD set seeds one admin with real scrypt hash', () => {
  const prevUser = process.env.ADMIN_USERNAME;
  const prevPass = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_USERNAME = 'boss';
  process.env.ADMIN_PASSWORD = 'topsecret';
  try {
    const seeded = seedFromEnv([]);
    assert.equal(seeded.length, 1);
    assert.equal(seeded[0].username, 'boss');
    assert.equal(seeded[0].role, 'admin');
    assert.notEqual(seeded[0].hash, 'topsecret'); // never stored in plaintext
    assert.equal(verifyPassword('topsecret', seeded[0].salt, seeded[0].hash), true);
  } finally {
    if (prevUser === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevPass;
  }
});

test('seedFromEnv: empty array + no ADMIN_PASSWORD returns empty array unchanged', () => {
  const prevPass = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  try {
    assert.deepEqual(seedFromEnv([]), []);
  } finally {
    if (prevPass !== undefined) process.env.ADMIN_PASSWORD = prevPass;
  }
});

test('seedFromEnv: non-empty array is returned untouched regardless of env vars', () => {
  const prevPass = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'shouldBeIgnored';
  try {
    const users = [makeUser('admin', 'secret')];
    const result = seedFromEnv(users);
    assert.deepEqual(result, users);
  } finally {
    if (prevPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevPass;
  }
});

test('seedFromEnv: defaults username to admin when ADMIN_USERNAME unset', () => {
  const prevUser = process.env.ADMIN_USERNAME;
  const prevPass = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_USERNAME;
  process.env.ADMIN_PASSWORD = 'secret';
  try {
    const seeded = seedFromEnv([]);
    assert.equal(seeded[0].username, 'admin');
  } finally {
    if (prevUser === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = prevUser;
    if (prevPass === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = prevPass;
  }
});
