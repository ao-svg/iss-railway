// Connecting a WordPress site from the hub, without copying the network key by hand.
//
//   1. probeSite(domain): the site's REST index (/?rest_route=/) says which of our plugins is
//      installed (its REST namespace) and where WordPress's "Authorize application" page is.
//   2. start(): remembers the attempt under a random state id and returns that page's URL.
//      The admin approves there (logged in to that WordPress as an administrator).
//   3. WordPress sends the browser back with a one-time Application Password; finish() uses it
//      to call the plugin's /connect route (hub URL + network key), which makes the site check
//      in, then deletes that Application Password again. The hub keeps no WordPress credentials.

const axios = require('axios');
const crypto = require('crypto');
const hub = require('./hub');

// Shown on WordPress's authorize page; the same id every time, so WordPress lists one app
const APP_NAME = 'Zhibo Hub';
const APP_ID = 'b241c029-9063-4c06-b8f1-ff07e48dbd4f';

// REST namespace each plugin registers → plugin slug
const NAMESPACES = {
  'zhibo/v1': hub.PLUGIN_SLUG,     // schedule plugin (zhibo882)
  'zhibo82/v1': hub.PLAYER_SLUG,   // player plugin (zhibo82), 4.3.5+
};
const NAMESPACE_OF = Object.fromEntries(Object.entries(NAMESPACES).map(([ns, slug]) => [slug, ns]));

const PENDING_TTL_MS = 20 * 60 * 1000;
const pending = new Map();   // state id → attempt

// "zhibo882.com", "https://zhibo882.com/whatever" → "https://zhibo882.com"
function originOf(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const u = hub.cleanUrl(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

const restUrl = (origin, route) => `${origin}/?rest_route=${route}`;

// What the site offers: { origin, host, name, plugins: [slug], authUrl } or { error }
async function probeSite(domain) {
  const origin = originOf(domain);
  if (!origin) return { error: 'Not a valid domain' };
  let res;
  try {
    res = await axios.get(restUrl(origin, '/'), { timeout: 15000, maxRedirects: 5, validateStatus: () => true, headers: { Accept: 'application/json' } });
  } catch (err) {
    return { origin, error: `Couldn't reach ${origin}: ${err.code || err.message}` };
  }
  const body = res.data;
  if (res.status !== 200 || !body || typeof body !== 'object' || !Array.isArray(body.namespaces)) {
    return { origin, error: `${origin} didn't answer like a WordPress site (REST API: HTTP ${res.status}). Is it WordPress, with the REST API on?` };
  }
  // Follow the site's own idea of its address (e.g. a redirect to www.)
  const home = originOf(body.home || body.url) || origin;
  const auth = body.authentication && body.authentication['application-passwords'];
  return {
    origin: home,
    host: hub.cleanHost(home),
    name: String(body.name || '').slice(0, 120),
    plugins: Object.entries(NAMESPACES).filter(([ns]) => body.namespaces.includes(ns)).map(([, slug]) => slug),
    authUrl: (auth && auth.endpoints && hub.cleanUrl(auth.endpoints.authorization)) || null,
  };
}

function sweep() {
  const now = Date.now();
  for (const [id, a] of pending) if (now - a.createdAt > PENDING_TTL_MS) pending.delete(id);
}

// Remember the attempt; returns WordPress's authorize URL to send the admin to
function start({ origin, authUrl, plugin, options, hubBase }) {
  sweep();
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { origin, plugin, options: options || {}, createdAt: Date.now() });
  const back = `${hubBase}/sites/connect/done?state=${state}`;
  const u = new URL(authUrl);
  u.searchParams.set('app_name', APP_NAME);
  u.searchParams.set('app_id', APP_ID);
  u.searchParams.set('success_url', back);
  u.searchParams.set('reject_url', `${back}&rejected=1`);
  return u.toString();
}

// The attempt for this state, once (null when unknown, used or expired)
function take(state) {
  sweep();
  const a = pending.get(String(state || ''));
  if (a) pending.delete(String(state));
  return a || null;
}

function wpError(res, what) {
  const msg = res.data && typeof res.data === 'object' && res.data.message ? ` (${String(res.data.message).slice(0, 200)})` : '';
  if (res.status === 401) return `WordPress didn't accept the approval for ${what}${msg}. Some hosts strip the Authorization header — connect by hand instead.`;
  if (res.status === 403) return `The approving WordPress user isn't an administrator${msg}.`;
  if (res.status === 404) return `The plugin on the site is too old for this (no ${what} route) — update it first${msg}.`;
  return `${what} failed: HTTP ${res.status}${msg}`;
}

// Use the Application Password: connect the plugin, then delete the password again.
// Returns { ok, error?, home?, revoked }
async function finish(attempt, { user, password, hubBase, networkKey }) {
  const auth = { username: String(user || ''), password: String(password || '') };
  const ns = NAMESPACE_OF[attempt.plugin];
  const out = { ok: false, revoked: false };
  try {
    const res = await axios.post(
      restUrl(attempt.origin, `/${ns}/connect`),
      { hub_url: hubBase, network_key: networkKey },
      { auth, timeout: 30000, validateStatus: () => true }
    );
    if (res.status === 200 && res.data && res.data.ok) {
      out.ok = true;
      out.home = (res.data.home && hub.cleanUrl(res.data.home)) || null;
    } else {
      out.error = res.data && res.data.error ? `The site couldn't reach the hub: ${res.data.error}` : wpError(res, 'connect');
    }
  } catch (err) {
    out.error = `Couldn't reach ${attempt.origin}: ${err.code || err.message}`;
  }
  // The hub keeps no WordPress credentials: delete this Application Password whatever happened
  try {
    const me = await axios.get(restUrl(attempt.origin, '/wp/v2/users/me/application-passwords/introspect'), { auth, timeout: 15000, validateStatus: () => true });
    const uuid = me.status === 200 && me.data && me.data.uuid;
    if (uuid) {
      // POST + method override: many servers (nginx defaults among them) refuse a real DELETE
      const del = await axios.post(restUrl(attempt.origin, `/wp/v2/users/me/application-passwords/${encodeURIComponent(uuid)}`), null, {
        auth,
        timeout: 15000,
        validateStatus: () => true,
        headers: { 'X-HTTP-Method-Override': 'DELETE' },
      });
      out.revoked = del.status === 200;
    }
  } catch {
    /* reported through out.revoked */
  }
  return out;
}

module.exports = { APP_ID, APP_NAME, NAMESPACES, originOf, probeSite, start, take, finish };
