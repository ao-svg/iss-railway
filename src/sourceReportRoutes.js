// /source-report (page), /source-report.json and the "Run report now"
// button for the daily source health report (sourceReport.js). Admin only,
// like the rest of the dashboard.

const { CATEGORIES } = require('./sourceReport');

const DEAD_KEYS = ['notFound', 'serverError', 'otherHttpError', 'tooSlow', 'broken', 'blocked', 'dangerous'];
const sum = (counts, keys) => keys.reduce((n, k) => n + (counts[k] || 0), 0);
const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : '–');

function delta(now, before) {
  if (before === undefined) return '';
  const d = now - before;
  if (!d) return '<span class="muted">±0</span>';
  return d > 0 ? `<span class="muted">+${d}</span>` : `<span class="muted">${d}</span>`;
}

function renderSourceReport({ reports, schedule, running }, { layout, escapeHtml }) {
  const latest = reports[reports.length - 1] || null;
  const previous = reports.length > 1 ? reports[reports.length - 2] : null;
  const when = (iso) => (iso ? `${escapeHtml(iso.replace('T', ' ').slice(0, 16))} UTC` : 'never');

  const scheduleCard = `<div class="card"><strong>How often sources refresh</strong>
    <table>
      <tr><th>Full pipeline run (re-matches every fixture to playlist sources)</th><td><code>${escapeHtml(schedule.pipelineCron || 'off')}</code> · last ${when(schedule.lastRunAt)}</td></tr>
      <tr><th>doms9 playlist re-fetch (fresh stream tokens swapped into the export)</th><td>every ${schedule.doms9RefreshMinutes} min on the source-check tick · playlist last fetched ${when(schedule.doms9FetchedAt)}</td></tr>
      <tr><th>Source check (reachable / CORS / working)</th><td><code>${escapeHtml(schedule.sourceCheckCron || 'off')}</code> · last ${when(schedule.lastCheckAt)}</td></tr>
      <tr><th>Screenshots</th><td>every 3rd source check re-captures all; failed ones retried on the checks in between</td></tr>
      <tr><th>This report (forced check of every source, then counted)</th><td><code>${escapeHtml(schedule.reportCron || 'off')}</code> · last ${when(latest && latest.at)}</td></tr>
    </table>
    <p class="muted">Cron times are UTC.</p>
    <form method="post" action="/api/source-report"><button type="submit" ${running ? 'disabled' : ''}>${running ? 'Report running…' : 'Run report now'}</button></form>
  </div>`;

  if (!latest) {
    return layout('Source health', `<h1>Source health</h1><p class="muted">No report yet — the first one runs on the schedule below, or now with the button.</p>${scheduleCard}`, '/source-report');
  }

  const summaryRows = CATEGORIES.map((c) => {
    const n = latest.counts[c.key] || 0;
    if (!n && !(previous && previous.counts[c.key])) return '';
    return `<tr><td class="status-${c.tone === 'muted' ? 'warn' : c.tone}">${escapeHtml(c.label)}</td><td>${n}</td><td>${pct(n, latest.total)}</td><td>${delta(n, previous && previous.counts[c.key])}</td></tr>`;
  }).join('');

  const hostRows = latest.byHost
    .map(
      (h) => `<tr><td>${escapeHtml(h.host)}</td><td>${h.total}</td><td>${h.counts.live || ''}</td><td>${h.counts.liveNoCors || ''}</td><td>${h.counts.responding || ''}</td><td>${h.counts.authError || ''}</td><td>${h.counts.notResponding || ''}</td><td>${sum(h.counts, DEAD_KEYS) || ''}</td></tr>`
    )
    .join('');

  const historyRows = reports
    .slice(-30)
    .reverse()
    .map(
      (r) => `<tr><td>${escapeHtml(r.date)}</td><td>${r.total}</td><td>${r.counts.live}</td><td>${r.counts.liveNoCors}</td><td>${r.counts.responding}</td><td>${r.counts.authError}</td><td>${r.counts.notResponding}</td><td>${sum(r.counts, DEAD_KEYS)}</td></tr>`
    )
    .join('');

  const body = `<h1>Source health</h1>
  <p class="muted">Daily check of every source in the current export, ${when(latest.at)}${previous ? ` — compared with ${escapeHtml(previous.date)}` : ''}.</p>
  <div class="card"><strong>${latest.total} sources</strong>
    <table><tr><th>Category</th><th>Sources</th><th>Share</th><th>vs previous</th></tr>${summaryRows}</table>
    <p class="muted">${latest.relayPlayable} play through the relay · ${latest.usOnly} are on US-only CDNs (may fail for visitors outside the US).</p>
  </div>
  <div class="card"><strong>By host</strong>${latest.otherHosts ? ` <span class="muted">(top ${latest.byHost.length}, ${latest.otherHosts} more hosts not shown)</span>` : ''}
    <table><tr><th>Host</th><th>Total</th><th>Live</th><th>No CORS</th><th>Unverified</th><th>Auth error</th><th>Not responding</th><th>Dead</th></tr>${hostRows}</table>
  </div>
  <div class="card"><strong>Last 30 days</strong>
    <table><tr><th>Date</th><th>Total</th><th>Live</th><th>No CORS</th><th>Unverified</th><th>Auth error</th><th>Not responding</th><th>Dead</th></tr>${historyRows}</table>
    <p class="muted">Dead = not found, server error, other 4xx, too slow, broken stream, embed-blocked or dangerous. JSON: <a href="/source-report.json">/source-report.json</a></p>
  </div>
  ${scheduleCard}`;
  return layout('Source health', body, '/source-report');
}

function mountSourceReportRoutes(app, { requireAuth, layout, escapeHtml, getReports, getSchedule, isRunning, runReport }) {
  app.get('/source-report', requireAuth('admin'), (req, res) => {
    res.send(renderSourceReport({ reports: getReports(), schedule: getSchedule(), running: isRunning() }, { layout, escapeHtml }));
  });

  app.get('/source-report.json', requireAuth('admin'), (req, res) => {
    res.json({ schedule: getSchedule(), running: isRunning(), reports: getReports() });
  });

  app.post('/api/source-report', requireAuth('admin'), (req, res) => {
    // Fire-and-forget like "Check sources": a forced check of every source takes minutes.
    runReport().catch((err) => console.error('[sourceReport]', err.message));
    res.redirect('/source-report');
  });
}

module.exports = { mountSourceReportRoutes, renderSourceReport };
