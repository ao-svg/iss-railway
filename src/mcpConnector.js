// A Claude connector for this app: a remote MCP server (Streamable HTTP) with
// the OAuth sign-in Claude's "Add custom connector" dialog expects, so the app
// can be driven from a Claude chat (claude.ai, the desktop and mobile apps,
// Claude Code). The same file serves ABS3 and the ISS hub; each app gives it
// its own tools, its own way of signing an admin in and a place to keep state.
//
// What Claude does with it:
//   1. POST /mcp without a token -> 401 with a pointer to
//      /.well-known/oauth-protected-resource -> /.well-known/oauth-authorization-server
//   2. POST /oauth/register (Dynamic Client Registration) with its callback URL
//   3. the user's browser opens /oauth/authorize: the app's own admin login,
//      then a consent page; Approve sends a one-time code back to Claude
//   4. POST /oauth/token swaps the code (PKCE, S256) for an access token (1 hour)
//      and a refresh token (90 days, replaced on every use)
//   5. POST /mcp with "Authorization: Bearer <access token>": initialize,
//      tools/list, tools/call. Stateless, JSON answers, no SSE stream.
//
// Safety: only Claude's own callback addresses (claude.ai, claude.com) and
// loopback addresses (Claude Code, the MCP inspector) can be registered, so a
// code never goes to another site. Every request re-checks that the person
// who approved is still an admin. Tokens are stored as SHA-256 only. The
// endpoint never reads cookies, so it needs no Origin check; the consent form
// is signed for the signed-in user and refuses to be framed.
'use strict';

const crypto = require('crypto');
const express = require('express');

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const CONSENT_TTL_MS = 15 * 60 * 1000;
const MAX_CLIENTS = 100;
const SCOPE = 'admin';
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function redirectAllowed(uri, hosts) {
  let u;
  try { u = new URL(uri); } catch (e) { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'https:' && hosts.includes(u.hostname)) return true;
  return u.protocol === 'http:' && LOOPBACK.includes(u.hostname);
}

// A loopback callback matches whatever port the client is listening on this time.
function sameRedirect(registered, given) {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK.includes(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch (e) { return false; }
}

// opts:
//   name, title, version, instructions  what the server tells Claude about itself
//   tools: [{ name, title, description, inputSchema, annotations, handler(args, ctx) }]
//          handler returns a string, or { text, isError }; ctx = { user, baseUrl, req }
//   store: { read(): state | null, write(state) }   (may be async)
//   baseUrl(req)            the app's public address, no trailing slash
//   signIn(req, res)        the signed-in admin as { id, name }, or null after it answered itself
//                           (a redirect to the login page, a 401, a 403)
//   resolveUser(identity)   the live user for { id, name } while still an admin, else null
//   staticBearer(token)     optional: the user for the app's own API token, else null
//   redirectHosts           https hosts a client may register a callback on
//   mcpPath ('/mcp'), oauthPath ('/oauth')
function createConnector(opts) {
  const mcpPath = opts.mcpPath || '/mcp';
  const oauthPath = opts.oauthPath || '/oauth';
  const hosts = opts.redirectHosts || ['claude.ai', 'claude.com'];
  const tools = opts.tools || [];
  const title = opts.title || opts.name;

  // One writer at a time, so two requests never overwrite each other's change.
  let lock = Promise.resolve();
  const normalize = (s) => {
    const st = s && typeof s === 'object' ? s : {};
    st.secret = st.secret || rand(32);
    st.clients = st.clients || {};
    st.codes = st.codes || {};
    st.grants = Array.isArray(st.grants) ? st.grants : [];
    return st;
  };
  const read = async () => normalize(await opts.store.read());
  const mutate = (fn) => {
    const run = lock.then(async () => {
      const st = await read();
      const out = await fn(st);
      await opts.store.write(st);
      return out;
    });
    lock = run.catch(() => {});
    return run;
  };

  function prune(st) {
    const now = Date.now();
    for (const [h, c] of Object.entries(st.codes)) if (c.exp < now) delete st.codes[h];
    st.grants = st.grants.filter((g) => g.refreshExp > now);
    const used = new Set(st.grants.map((g) => g.clientId));
    const idle = Object.entries(st.clients).filter(([id]) => !used.has(id)).sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [id, c] of idle) if (now - c.createdAt > 24 * 60 * 60 * 1000) delete st.clients[id];
    // Registration is open to anyone who can reach the app: the oldest unused entries go first.
    const left = Object.entries(st.clients).filter(([id]) => !used.has(id)).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (Object.keys(st.clients).length >= MAX_CLIENTS && left.length) delete st.clients[left.shift()[0]];
  }

  const cors = (res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Expose-Headers', 'WWW-Authenticate');
  };
  const preflight = (req, res) => { cors(res); res.status(204).end(); };
  const noStore = (res) => res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');
  const oauthError = (res, status, error, description) => { cors(res); noStore(res); res.status(status).json({ error, error_description: description }); };

  function issue(st, grant) {
    const access = rand(32);
    const refresh = rand(32);
    grant.access = sha(access);
    grant.accessExp = Date.now() + ACCESS_TTL_MS;
    grant.refresh = sha(refresh);
    grant.refreshExp = Date.now() + REFRESH_TTL_MS;
    grant.usedAt = Date.now();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: SCOPE };
  }

  const sign = (st, payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return body + '.' + crypto.createHmac('sha256', st.secret).update(body).digest('base64url');
  };
  const unsign = (st, ticket) => {
    const [body, mac] = String(ticket || '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', st.secret).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      return p && p.exp > Date.now() ? p : null;
    } catch (e) { return null; }
  };

  function page(res, heading, bodyHtml, status = 200) {
    res.status(status);
    res.set('X-Frame-Options', 'DENY');
    res.set('Content-Security-Policy', "frame-ancestors 'none'");
    noStore(res);
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f4ef;color:#1f1e1b;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #e3e0d6;border-radius:12px;padding:28px 30px;max-width:440px;margin:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
h1{font-size:19px;margin:0 0 12px}p{font-size:14px;line-height:1.5;margin:0 0 12px}ul{font-size:14px;line-height:1.5;margin:0 0 14px;padding-left:20px}
.muted{color:#6b6a65;font-size:12.5px}.row{display:flex;gap:10px;margin-top:18px}
button{font:inherit;font-size:14px;border-radius:8px;padding:9px 18px;cursor:pointer;border:1px solid #c9c6ba;background:#fff;color:#1f1e1b}
button.go{background:#c96442;border-color:#c96442;color:#fff}code{background:#f1efe8;padding:1px 5px;border-radius:4px;font-size:12.5px}
</style></head><body><div class="card"><h1>${esc(heading)}</h1>${bodyHtml}</div></body></html>`);
  }

  function mount(app) {
    // ── Discovery ──
    const resourceMeta = (req, res) => {
      cors(res);
      const base = opts.baseUrl(req);
      res.json({ resource: base + mcpPath, authorization_servers: [base], bearer_methods_supported: ['header'], scopes_supported: [SCOPE], resource_name: title });
    };
    const serverMeta = (req, res) => {
      cors(res);
      const base = opts.baseUrl(req);
      res.json({
        issuer: base,
        authorization_endpoint: base + oauthPath + '/authorize',
        token_endpoint: base + oauthPath + '/token',
        registration_endpoint: base + oauthPath + '/register',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: [SCOPE]
      });
    };
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource' + mcpPath]) { app.options(p, preflight); app.get(p, resourceMeta); }
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server' + mcpPath]) { app.options(p, preflight); app.get(p, serverMeta); }

    // ── Dynamic Client Registration ──
    app.options(oauthPath + '/register', preflight);
    app.post(oauthPath + '/register', express.json({ limit: '32kb' }), async (req, res) => {
      const b = req.body || {};
      const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.map(String).slice(0, 10) : [];
      if (!uris.length || !uris.every((u) => redirectAllowed(u, hosts))) {
        return oauthError(res, 400, 'invalid_redirect_uri', 'Only Claude can connect: redirect_uris must be on ' + hosts.join(' or ') + ', or a loopback address.');
      }
      const id = 'mcp_' + rand(18);
      const name = String(b.client_name || 'Claude').slice(0, 80);
      await mutate((st) => { prune(st); st.clients[id] = { redirectUris: uris, name, createdAt: Date.now() }; });
      cors(res);
      noStore(res);
      res.status(201).json({ client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    });

    // ── Authorize: the app's own login, then consent ──
    const authParams = (src) => ({
      client_id: String(src.client_id || ''), redirect_uri: String(src.redirect_uri || ''), state: String(src.state || '').slice(0, 2000),
      code_challenge: String(src.code_challenge || ''), code_challenge_method: String(src.code_challenge_method || ''),
      response_type: String(src.response_type || ''), resource: String(src.resource || '').slice(0, 500)
    });
    const backToClient = (res, p, params) => {
      const u = new URL(p.redirect_uri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.state) u.searchParams.set('state', p.state);
      noStore(res);
      res.redirect(302, u.toString());
    };
    // The client and its callback are checked before anything is sent back to that callback.
    const checkClient = async (res, p) => {
      const st = await read();
      const client = st.clients[p.client_id];
      if (!client) { page(res, 'This connection request is not valid', '<p>Claude is not registered with this app (the request may be old). Remove the connector in Claude and add it again.</p>', 400); return null; }
      if (!client.redirectUris.some((r) => sameRedirect(r, p.redirect_uri))) { page(res, 'This connection request is not valid', '<p>The return address does not match the one that was registered.</p>', 400); return null; }
      return { st, client };
    };

    app.get(oauthPath + '/authorize', async (req, res) => {
      const p = authParams(req.query);
      const found = await checkClient(res, p);
      if (!found) return;
      if (p.response_type !== 'code') return backToClient(res, p, { error: 'unsupported_response_type' });
      if (!p.code_challenge || p.code_challenge_method !== 'S256') return backToClient(res, p, { error: 'invalid_request', error_description: 'PKCE with S256 is required' });
      const user = await opts.signIn(req, res);
      if (!user) return;
      const st = await mutate((s) => s); // makes sure the signing secret is saved
      const ticket = sign(st, { ...p, uid: String(user.id), exp: Date.now() + CONSENT_TTL_MS });
      const where = new URL(p.redirect_uri).hostname;
      page(res, 'Connect Claude to ' + title + '?', `
<p><strong>${esc(found.client.name)}</strong> (returning to <code>${esc(where)}</code>) is asking to use ${esc(title)} as <strong>${esc(user.name)}</strong>.</p>
<p>If you approve, Claude can:</p>
<ul>${(opts.consentLines || tools.map((t) => t.title || t.name)).map((l) => '<li>' + esc(l) + '</li>').join('')}</ul>
<p class="muted">Only approve if you just added this connector in Claude yourself. You can disconnect it at any time on this app's Settings page.</p>
<form method="POST" action="${esc(oauthPath)}/authorize"><input type="hidden" name="ticket" value="${esc(ticket)}">
<div class="row"><button class="go" type="submit" name="decision" value="approve">Approve</button><button type="submit" name="decision" value="deny">Cancel</button></div></form>`);
    });

    app.post(oauthPath + '/authorize', express.urlencoded({ extended: false }), async (req, res) => {
      const origin = req.get('origin');
      if (origin) {
        let ok = false;
        try { ok = new URL(origin).host === req.get('host'); } catch (e) { /* not ours */ }
        if (!ok) return page(res, 'Not sent from this app', '<p>Start again from Claude.</p>', 403);
      }
      const st0 = await read();
      const p = unsign(st0, req.body && req.body.ticket);
      if (!p) return page(res, 'That approval page expired', '<p>Go back to Claude and connect again.</p>', 400);
      const found = await checkClient(res, p);
      if (!found) return;
      const user = await opts.signIn(req, res);
      if (!user) return;
      if (String(user.id) !== p.uid) return page(res, 'Signed in as someone else', '<p>Go back to Claude and connect again.</p>', 400);
      if (req.body.decision !== 'approve') return backToClient(res, p, { error: 'access_denied' });
      const code = rand(32);
      await mutate((st) => {
        prune(st);
        st.codes[sha(code)] = { clientId: p.client_id, redirectUri: p.redirect_uri, challenge: p.code_challenge, user: { id: user.id, name: user.name }, exp: Date.now() + CODE_TTL_MS };
      });
      backToClient(res, p, { code });
    });

    // ── Token ──
    app.options(oauthPath + '/token', preflight);
    app.post(oauthPath + '/token', express.urlencoded({ extended: false }), express.json({ limit: '32kb' }), async (req, res) => {
      const b = req.body || {};
      const type = String(b.grant_type || '');
      if (type !== 'authorization_code' && type !== 'refresh_token') return oauthError(res, 400, 'unsupported_grant_type', 'authorization_code or refresh_token');
      let failure = null;
      const tokens = await mutate(async (st) => {
        prune(st);
        if (type === 'authorization_code') {
          const key = sha(b.code || '');
          const c = st.codes[key];
          delete st.codes[key]; // one use, whatever happens next
          if (!c || c.clientId !== String(b.client_id || '') || !sameRedirect(c.redirectUri, String(b.redirect_uri || c.redirectUri))) { failure = 'That code is not valid any more.'; return null; }
          const verifier = String(b.code_verifier || '');
          if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== c.challenge) { failure = 'The code verifier does not match.'; return null; }
          if (!(await opts.resolveUser(c.user))) { failure = 'That person can no longer use this app.'; return null; }
          const grant = { id: rand(9), clientId: c.clientId, clientName: (st.clients[c.clientId] || {}).name || 'Claude', user: c.user, createdAt: Date.now() };
          st.grants.push(grant);
          return issue(st, grant);
        }
        const grant = st.grants.find((g) => g.refresh === sha(b.refresh_token || ''));
        if (!grant || (b.client_id && grant.clientId !== String(b.client_id))) { failure = 'That refresh token is not valid any more.'; return null; }
        if (!(await opts.resolveUser(grant.user))) { st.grants = st.grants.filter((g) => g !== grant); failure = 'That person can no longer use this app.'; return null; }
        return issue(st, grant);
      });
      if (!tokens) return oauthError(res, 400, 'invalid_grant', failure);
      cors(res);
      noStore(res);
      res.json(tokens);
    });

    // ── The MCP endpoint ──
    const unauthorized = (req, res, hadToken) => {
      cors(res);
      res.set('WWW-Authenticate', 'Bearer resource_metadata="' + opts.baseUrl(req) + '/.well-known/oauth-protected-resource"' + (hadToken ? ', error="invalid_token"' : ''));
      res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: hadToken ? 'That access token is not valid any more.' : 'Sign in first.' } });
    };
    async function userFor(token) {
      if (opts.staticBearer) {
        const fixed = await opts.staticBearer(token);
        if (fixed) return fixed;
      }
      const st = await read();
      const hash = sha(token);
      const grant = st.grants.find((g) => g.access === hash && g.accessExp > Date.now());
      if (!grant) return null;
      const user = await opts.resolveUser(grant.user);
      if (!user) return null;
      // "Last used" for the Settings page, written at most every ten minutes.
      if (Date.now() - (grant.usedAt || 0) > 10 * 60 * 1000) {
        mutate((s) => { const g = s.grants.find((x) => x.id === grant.id); if (g) g.usedAt = Date.now(); }).catch(() => {});
      }
      return user;
    }

    async function handle(msg, ctx) {
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
        return { jsonrpc: '2.0', id: msg && msg.id !== undefined ? msg.id : null, error: { code: -32600, message: 'Invalid request' } };
      }
      if (msg.id === undefined || msg.id === null) return null; // a notification
      const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
      switch (msg.method) {
        case 'initialize':
          return ok({
            protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: opts.name, title, version: opts.version || '1.0.0' },
            instructions: opts.instructions || undefined
          });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema || { type: 'object', properties: {} }, annotations: t.annotations })) });
        case 'tools/call': {
          const tool = tools.find((t) => t.name === params.name);
          if (!tool) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Unknown tool: ' + params.name } };
          let out;
          try {
            out = await tool.handler(params.arguments && typeof params.arguments === 'object' ? params.arguments : {}, ctx);
          } catch (err) {
            console.error('[connector] ' + tool.name + ' failed:', err);
            out = { text: 'Failed: ' + err.message, isError: true };
          }
          const text = typeof out === 'string' ? out : String((out && out.text) || '');
          return ok({ content: [{ type: 'text', text: text.length > 120000 ? text.slice(0, 120000) + '\n… (cut)' : text }], isError: !!(out && out.isError) });
        }
        default:
          return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } };
      }
    }

    app.options(mcpPath, preflight);
    app.all(mcpPath, async (req, res, next) => {
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
      if (!bearer) return unauthorized(req, res, false);
      const user = await userFor(bearer[1]);
      if (!user) return unauthorized(req, res, true);
      req.connectorUser = user;
      cors(res);
      if (req.method !== 'POST') return res.status(405).set('Allow', 'POST, OPTIONS').json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'This server answers POST only (no event stream).' } });
      next();
    }, express.json({ limit: '1mb' }), async (req, res) => {
      const ctx = { user: req.connectorUser, baseUrl: opts.baseUrl(req), req };
      const body = req.body;
      if (Array.isArray(body)) {
        const answers = (await Promise.all(body.map((m) => handle(m, ctx)))).filter(Boolean);
        return answers.length ? res.json(answers) : res.status(202).end();
      }
      const answer = await handle(body, ctx);
      return answer ? res.json(answer) : res.status(202).end();
    }, (err, req, res, next) => { // a body that is not JSON
      if (res.headersSent) return next(err);
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    });
  }

  // For the Settings page: who is connected, and switching them off.
  async function connections() {
    const st = await read();
    return st.grants.filter((g) => g.refreshExp > Date.now()).map((g) => ({ id: g.id, client: g.clientName, user: g.user && g.user.name, createdAt: new Date(g.createdAt).toISOString(), usedAt: g.usedAt ? new Date(g.usedAt).toISOString() : null }));
  }
  async function disconnect(id) {
    return mutate((st) => {
      const before = st.grants.length;
      st.grants = id ? st.grants.filter((g) => g.id !== id) : [];
      if (!id) st.codes = {};
      return before - st.grants.length;
    });
  }

  return { mount, connections, disconnect, mcpPath };
}

module.exports = { createConnector, redirectAllowed, sameRedirect, PROTOCOL_VERSIONS };
