// Multi-account, role-based dashboard login. Two roles: 'admin' (full
// access) and 'viewer' (read-only, /browse only). Replaces the old
// single-shared-password scheme that never actually checked a username.
//
// Seeding vs config.js: config.js merges env-under-file on EVERY boot,
// which is fine for settings but wrong for credentials — if an admin
// rotates their password via /users while the old value is still sitting
// in ADMIN_PASSWORD, a merge-every-boot strategy would silently resurrect
// the old password on every redeploy. So this module seeds from
// ADMIN_USERNAME/ADMIN_PASSWORD only when the store is empty (fresh boot,
// wiped disk, or the store was deliberately deleted); once real accounts
// exist, data/users.json is authoritative until it's gone again. On
// Railway data/ is wiped every redeploy anyway (same ephemeral-disk
// caveat as config.js), so this mostly matters for long-running/local use.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_PATH = path.join(__dirname, '..', 'data', 'users.json');
const ROLE_RANK = { viewer: 1, admin: 2 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  try {
    const candidate = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(candidate, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false; // malformed record (e.g. hand-edited store missing salt/hash) — never crash a login attempt
  }
}

function findUser(users, username) {
  return users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null;
}

function verifyCredentials(users, username, password) {
  const user = findUser(users, username);
  return user && verifyPassword(password, user.salt, user.hash) ? user : null;
}

function hasRole(user, minRole) {
  if (!user) return false;
  return (ROLE_RANK[user.role] || 0) >= (ROLE_RANK[minRole] || Infinity);
}

// Add-or-replace by username. Password optional on update — blank/omitted keeps the existing hash.
function upsertUser(users, { username, password, role }) {
  if (!username || !username.trim()) throw new Error('username required');
  if (!['admin', 'viewer'].includes(role)) throw new Error('invalid role');
  const key = username.trim();
  const idx = users.findIndex((u) => u.username.toLowerCase() === key.toLowerCase());
  const now = new Date().toISOString();
  if (idx === -1) {
    if (!password) throw new Error('password required for a new account');
    const { salt, hash } = hashPassword(password);
    return [...users, { username: key, role, salt, hash, createdAt: now, updatedAt: now }];
  }
  const prev = users[idx];
  const { salt, hash } = password ? hashPassword(password) : { salt: prev.salt, hash: prev.hash };
  const next = [...users];
  next[idx] = { ...prev, username: key, role, salt, hash, updatedAt: now };
  return next;
}

// Returns { users, error } instead of throwing, so the route handler turns
// "last admin" into a flash message instead of a 500.
function deleteUser(users, username) {
  const target = findUser(users, username);
  if (!target) return { users, error: 'not found' };
  const remainingAdmins = users.filter(
    (u) => u.role === 'admin' && u.username.toLowerCase() !== target.username.toLowerCase()
  );
  if (target.role === 'admin' && remainingAdmins.length === 0) {
    return { users, error: 'cannot delete the last admin account' };
  }
  return { users: users.filter((u) => u.username.toLowerCase() !== target.username.toLowerCase()), error: null };
}

// Never re-seeds over an existing store — see the module comment above.
function seedFromEnv(users) {
  if (users.length > 0) return users;
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return users; // nothing to seed — dashboard stays disabled, same as before
  const username = process.env.ADMIN_USERNAME || 'admin';
  const { salt, hash } = hashPassword(password);
  const now = new Date().toISOString();
  return [{ username, role: 'admin', salt, hash, createdAt: now, updatedAt: now }];
}

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveStore(users) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(users, null, 2));
}

let _users = seedFromEnv(loadStore());
if (_users.length && !fs.existsSync(STORE_PATH)) saveStore(_users); // persist the seed so /users shows it immediately

function authenticate(username, password) {
  return verifyCredentials(_users, username, password);
}

// Includes salt/hash — callers (renderUsers) must only read username/role/createdAt/updatedAt.
function getAllUsers() {
  return _users;
}

function upsert(fields) {
  _users = upsertUser(_users, fields);
  saveStore(_users);
  return _users;
}

function remove(username) {
  const { users, error } = deleteUser(_users, username);
  if (!error) {
    _users = users;
    saveStore(_users);
  }
  return { error };
}

function hasAnyAdmin() {
  return _users.some((u) => u.role === 'admin');
}

module.exports = {
  ROLE_RANK,
  findUser,
  verifyCredentials,
  hasRole,
  upsertUser,
  deleteUser,
  seedFromEnv,
  hashPassword,
  verifyPassword,
  authenticate,
  getAllUsers,
  upsert,
  remove,
  hasAnyAdmin,
};
