const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { getConfig, updateConfig } = require('./config');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireAuth(req, res, next) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    return res
      .status(503)
      .send('Dashboard disabled: set the ADMIN_PASSWORD environment variable on this service to enable it.');
  }
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const pass = sep === -1 ? '' : decoded.slice(sep + 1);
    if (timingSafeEqual(pass, password)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="iss-railway admin"');
  return res.status(401).send('Authentication required');
}

function layout(title, body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 2rem; }
  main { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  nav { margin-bottom: 1.5rem; }
  nav a { color: #93c5fd; text-decoration: none; margin-right: 1rem; font-size: 0.9rem; }
  .card { background: #1e293b; border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }
  .status-ok { color: #4ade80; }
  .status-warn { color: #facc15; }
  .status-err { color: #f87171; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #334155; vertical-align: top; }
  th { color: #94a3b8; font-weight: 600; }
  label { display: block; margin: 0.75rem 0 0.25rem; font-size: 0.85rem; color: #94a3b8; }
  input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 0.5rem; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-size: 0.9rem; }
  button { margin-top: 1rem; background: #2563eb; color: white; border: none; padding: 0.55rem 1.1rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
  button.secondary { background: #334155; }
  .muted { color: #94a3b8; font-size: 0.85rem; }
  code { background: #0f172a; padding: 0.1rem 0.35rem; border-radius: 4px; }
</style>
</head>
<body>
<main>
<nav><a href="/">Dashboard</a><a href="/settings">Settings</a><a href="/fixtures.json">fixtures.json</a><a href="/fixtures.csv">fixtures.csv</a><a href="/health">health</a></nav>
${body}
</main>
</body>
</html>`;
}

function renderDashboard(state, config) {
  const failures = state.lastRunFailures || [];
  let statusLine;
  if (state.running) {
    statusLine = '<span class="status-warn">● running now…</span>';
  } else if (state.lastError) {
    statusLine = `<span class="status-err">● last run failed: ${escapeHtml(state.lastError)}</span>`;
  } else if (failures.length) {
    statusLine = `<span class="status-warn">● ok, but ${failures.length} league(s) failed</span>`;
  } else if (state.lastRunAt) {
    statusLine = '<span class="status-ok">● healthy</span>';
  } else {
    statusLine = '<span class="muted">● no run yet</span>';
  }

  const failureRows = failures
    .map((f) => `<tr><td>${escapeHtml(f.leagueId)}</td><td>${escapeHtml(f.message)}</td></tr>`)
    .join('');

  const rows = (state.lastRows || []).slice(0, 25);
  const fixtureRows = rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.league)}</td>
        <td>${escapeHtml(r.homeTeam)} vs ${escapeHtml(r.awayTeam)}</td>
        <td>${escapeHtml(r.matchDateUTC)}</td>
        <td>${escapeHtml((r.channels || []).join(', ') || '—')}</td>
      </tr>`
    )
    .join('');

  return layout(
    'iss-railway dashboard',
    `
    <h1>ISS Fixture Pipeline</h1>
    <p class="muted">${statusLine}</p>

    <div class="card">
      <table>
        <tr><th>Last run</th><td>${state.lastRunAt ? escapeHtml(state.lastRunAt) : '—'}</td></tr>
        <tr><th>Fixtures written</th><td>${state.lastRunCount ?? '—'}</td></tr>
        <tr><th>Schedule</th><td><code>${escapeHtml(config.cronExpr)}</code></td></tr>
        <tr><th>Leagues configured</th><td>${config.leagueIds.length}</td></tr>
      </table>
      <form method="POST" action="/api/run">
        <button type="submit" ${state.running ? 'disabled' : ''}>Run pipeline now</button>
      </form>
    </div>

    ${
      failures.length
        ? `<div class="card">
      <strong>Leagues that failed last run</strong>
      <table><tr><th>League ID</th><th>Error</th></tr>${failureRows}</table>
    </div>`
        : ''
    }

    <div class="card">
      <strong>Latest fixtures</strong>
      ${
        rows.length
          ? `<table><tr><th>League</th><th>Match</th><th>Date (UTC)</th><th>Channels</th></tr>${fixtureRows}</table>`
          : '<p class="muted">No fixtures yet — click "Run pipeline now" above.</p>'
      }
    </div>
  `
  );
}

function renderSettings(config, saved) {
  return layout(
    'iss-railway settings',
    `
    <h1>Settings</h1>
    ${saved ? '<p class="status-ok">Saved. Changes apply immediately; next scheduled run (or "Run now") will use them.</p>' : ''}
    <div class="card">
      <form method="POST" action="/settings">
        <label for="apiKey">TheSportsDB API key</label>
        <input type="text" id="apiKey" name="apiKey" value="${escapeHtml(config.apiKey)}">

        <label for="leagueIds">League IDs (comma-separated)</label>
        <input type="text" id="leagueIds" name="leagueIds" value="${escapeHtml(config.leagueIds.join(','))}">

        <label for="playlistUrl">iptv-org playlist URL</label>
        <input type="text" id="playlistUrl" name="playlistUrl" value="${escapeHtml(config.playlistUrl)}">

        <label for="cronExpr">Cron schedule</label>
        <input type="text" id="cronExpr" name="cronExpr" value="${escapeHtml(config.cronExpr)}">

        <button type="submit">Save settings</button>
      </form>
    </div>
    <p class="muted">Note: settings saved here live on this container's disk and apply immediately, but a Railway
    redeploy resets them back to the service's environment variables. Set the env vars too if you want a change
    to survive a redeploy.</p>
  `
  );
}

function createServer({ getState, runOnce, rescheduleCron }) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/', requireAuth, (req, res) => {
    res.send(renderDashboard(getState(), getConfig()));
  });

  app.get('/settings', requireAuth, (req, res) => {
    res.send(renderSettings(getConfig(), req.query.saved === '1'));
  });

  app.post('/settings', requireAuth, (req, res) => {
    const { apiKey, leagueIds, playlistUrl, cronExpr } = req.body;
    updateConfig({ apiKey, leagueIds, playlistUrl, cronExpr });
    rescheduleCron();
    res.redirect('/settings?saved=1');
  });

  app.post('/api/run', requireAuth, async (req, res) => {
    await runOnce();
    res.redirect('/');
  });

  app.get('/fixtures.csv', (req, res) => {
    const { outputCsvPath } = getConfig();
    if (!fs.existsSync(outputCsvPath)) {
      return res.status(404).send('No CSV generated yet — pipeline has not completed a run.');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fixtures.csv"');
    fs.createReadStream(outputCsvPath).pipe(res);
  });

  app.get('/fixtures.json', (req, res) => {
    const rows = getState().lastRows;
    if (!rows) return res.status(404).json({ error: 'No data yet — pipeline has not completed a run.' });
    res.json(rows);
  });

  return app;
}

module.exports = { createServer };
