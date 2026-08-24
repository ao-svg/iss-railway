const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { getConfig, updateConfig } = require('./config');
const { formatBeijing, formatInTimezone } = require('./csv');

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
  .channel-list { list-style: none; margin: 0; padding: 0; }
  .channel-list li { margin-bottom: 0.15rem; }
  .channel-list a { color: #93c5fd; }
  .channel-list .no-url { color: #94a3b8; }
  .channel-name { color: #e2e8f0; margin-right: 0.3rem; }
  .source-list { list-style: none; margin: 0.15rem 0 0.35rem 0.9rem; padding: 0; }
  .source-list li { margin-bottom: 0.1rem; }
  .source-list a { color: #93c5fd; font-size: 0.8rem; }
  .dot { display: inline-block; width: 0.55rem; height: 0.55rem; border-radius: 50%; margin-right: 0.4rem; }
  .dot-ok { background: #4ade80; }
  .dot-stream { background: #fbbf24; }
  .dot-blocked, .dot-dead { background: #f87171; }
  .dot-unchecked { background: #475569; }
  #search-box { margin-bottom: 1rem; }
  #row-count { font-size: 0.85rem; color: #94a3b8; margin-bottom: 0.5rem; }
  .badge { display: inline-block; font-size: 0.7rem; padding: 0.05rem 0.4rem; border-radius: 4px; margin-left: 0.4rem; }
  .badge-manual { background: #1e3a8a; color: #93c5fd; }
  .badge-auto { background: #334155; color: #94a3b8; }
  .badge-none { background: #334155; color: #64748b; }
  .badge-approved { background: #14532d; color: #4ade80; }
  .badge-pending { background: #713f12; color: #fbbf24; }
  .badge-rejected { background: #7f1d1d; color: #f87171; }
  .inline-form { display: flex; gap: 0.4rem; align-items: center; }
  .inline-form input[type=text] { width: auto; flex: 1; }
  .inline-form button { margin-top: 0; padding: 0.35rem 0.7rem; font-size: 0.8rem; }
</style>
</head>
<body>
<main>
<nav><a href="/">Dashboard</a><a href="/browse">Browse all</a><a href="/live">Live now</a><a href="/youtube-channels">YouTube channels</a><a href="/leagues">Leagues</a><a href="/translations">Translations</a><a href="/settings">Settings</a><a href="/fixtures.json">fixtures.json</a><a href="/fixtures.csv">fixtures.csv</a><a href="/live.json">live.json</a><a href="/live.csv">live.csv</a><a href="/health">health</a></nav>
${body}
</main>
</body>
</html>`;
}

function channelNames(row) {
  return (row.channels || []).map((c) => c.name).join(', ') || '—';
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
    .map((r) => {
      const { date, time } = formatBeijing(r.matchDateUTC);
      return `<tr>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(r.homeTeam)}${r.awayTeam ? ' v ' + escapeHtml(r.awayTeam) : ''}</td>
        <td>${escapeHtml(r.league)}</td>
        <td>${escapeHtml(channelNames(r))}</td>
        <td>${escapeHtml(r.sportType || '')}</td>
        <td>${escapeHtml(r.source === 'wheresthematch' ? 'WTM' : 'SDB')}</td>
      </tr>`;
    })
    .join('');
  const sourceCounts = (state.lastRows || []).reduce((acc, r) => {
    acc[r.source] = (acc[r.source] || 0) + 1;
    return acc;
  }, {});

  const allDates = (state.lastRows || [])
    .map((r) => formatBeijing(r.matchDateUTC).date)
    .filter(Boolean)
    .sort();
  const coverage =
    allDates.length > 0
      ? `${allDates[0]} to ${allDates[allDates.length - 1]} (${new Set(allDates).size} distinct days)`
      : '—';

  const uniqueSourceCount = new Set(
    (state.lastRows || []).flatMap((r) => (r.channels || []).flatMap((c) => c.sources || []))
  ).size;

  let checkStatusLine;
  if (state.checkRunning) {
    const p = state.checkProgress;
    checkStatusLine = `<span class="status-warn">● checking… ${p ? `${p.done}/${p.total}` : ''}</span>`;
  } else if (state.lastCheckSummary) {
    const s = state.lastCheckSummary;
    checkStatusLine = `<span class="muted">Last checked ${escapeHtml(state.lastCheckAt)} — ok: ${s.ok}, stream: ${s.stream ?? 0}, blocked: ${s.blocked}, dead: ${s.dead}, skipped (fresh): ${s.skipped}</span>`;
  } else {
    checkStatusLine = '<span class="muted">Never checked</span>';
  }

  const namesToTranslate = new Set();
  for (const r of state.lastRows || []) {
    if (r.league) namesToTranslate.add(r.league);
    if (r.homeTeam) namesToTranslate.add(r.homeTeam);
    if (r.awayTeam) namesToTranslate.add(r.awayTeam);
  }

  let translateStatusLine;
  if (state.translateRunning) {
    const p = state.translateProgress;
    translateStatusLine = `<span class="status-warn">● translating… ${p ? `${p.done}/${p.total}` : ''}</span>`;
  } else if (state.lastTranslateSummary) {
    const s = state.lastTranslateSummary;
    translateStatusLine = `<span class="muted">Last run ${escapeHtml(state.lastTranslateAt)} — translated: ${s.translated}, failed: ${s.failed}, skipped (cached): ${s.skipped}</span>`;
  } else {
    translateStatusLine = '<span class="muted">Never run</span>';
  }

  let liveStatusLine;
  if (!config.liveTvDomain) {
    liveStatusLine = '<span class="muted">Disabled — set LIVETV_DOMAIN to enable (see Settings)</span>';
  } else if (state.liveRunning) {
    const p = state.liveProgress;
    liveStatusLine = `<span class="status-warn">● fetching… sport ${p ? `${p.done}/${p.total}` : ''}</span>`;
  } else if (state.lastLiveAt) {
    const rows = state.liveRows || [];
    const liveCount = rows.filter((r) => r.status === 'live').length;
    const endedCount = rows.filter((r) => r.status === 'ended').length;
    const ytCount = rows.reduce((n, r) => n + (r.channels || []).filter((c) => c.type === 'youtube').length, 0);
    const otherCount = rows.reduce((n, r) => n + (r.channels || []).filter((c) => c.type === 'other').length, 0);
    liveStatusLine = `<span class="muted">Last fetched ${escapeHtml(state.lastLiveAt)} — ${liveCount} live, ${endedCount} recently ended, ${ytCount} YouTube links, ${otherCount} other (not shown)</span>`;
  } else {
    liveStatusLine = '<span class="muted">Never fetched</span>';
  }

  return layout(
    'iss-railway dashboard',
    `
    <h1>ISS Fixture Pipeline</h1>
    <p class="muted">${statusLine}</p>

    <div class="card">
      <table>
        <tr><th>Last run</th><td>${state.lastRunAt ? escapeHtml(state.lastRunAt) : '—'}</td></tr>
        <tr><th>Fixtures written</th><td>${state.lastRunCount ?? '—'} (SportsDB: ${sourceCounts.sportsdb || 0}, wheresthematch: ${sourceCounts.wheresthematch || 0})</td></tr>
        <tr><th>Date coverage</th><td>${escapeHtml(coverage)}</td></tr>
        <tr><th>Schedule</th><td><code>${escapeHtml(config.cronExpr)}</code></td></tr>
        <tr><th>Leagues configured</th><td>${config.leagueIds.length}</td></tr>
        <tr><th>wheresthematch.com lookahead</th><td>${config.wtmDays} days</td></tr>
      </table>
      <form method="POST" action="/api/run">
        <button type="submit" ${state.running ? 'disabled' : ''}>Run pipeline now</button>
      </form>
    </div>

    ${
      failures.length
        ? `<div class="card">
      <strong>Sources that failed last run</strong>
      <table><tr><th>Source</th><th>Error</th></tr>${failureRows}</table>
    </div>`
        : ''
    }

    <div class="card">
      <strong>Source (iframe) checks</strong> <span class="muted">— ${uniqueSourceCount} unique stream URLs across all fixtures</span>
      <p>${checkStatusLine}</p>
      <form method="POST" action="/api/check-sources">
        <button type="submit" ${state.checkRunning ? 'disabled' : ''}>Check sources now</button>
        <button type="submit" name="force" value="1" class="secondary" ${state.checkRunning ? 'disabled' : ''}>Re-check all (ignore cache)</button>
      </form>
      <p class="muted">Green = HTML page, directly &lt;iframe&gt;-embeddable. Amber = live stream manifest (HLS/DASH) — reachable and CORS-open (for HLS, its first actual video segment is verified too, not just the master playlist), but needs a &lt;video&gt; player (hls.js/dash.js) on your page, not a bare iframe. Red = dead link, blocks framing (X-Frame-Options/CSP), a manifest with no CORS access, or (HLS) one whose first segment isn't reachable. See <a href="/browse">Browse all</a> for per-source status.</p>
    </div>

    <div class="card">
      <strong>Simplified Chinese translation</strong> <span class="muted">— ${namesToTranslate.size} distinct league/team names</span>
      <p>${translateStatusLine}</p>
      <form method="POST" action="/api/translate-names">
        <button type="submit" ${state.translateRunning ? 'disabled' : ''}>Translate names now</button>
        <button type="submit" name="force" value="1" class="secondary" ${state.translateRunning ? 'disabled' : ''}>Re-translate (ignore cache, keeps manual overrides)</button>
      </form>
      <p class="muted">Auto-translated via the free Google Translate endpoint and cached. Manual corrections on the <a href="/translations">Translations</a> page always win and are never overwritten by re-translation.</p>
    </div>

    <div class="card">
      <strong>Live streaming (LTV)</strong> <span class="muted">— currently-live games, separate from the scheduled fixtures above</span>
      <p>${liveStatusLine}</p>
      <form method="POST" action="/api/fetch-live">
        <button type="submit" ${state.liveRunning || !config.liveTvDomain ? 'disabled' : ''}>Fetch live streams now</button>
      </form>
      <p class="muted">YouTube links only count as usable once their uploading channel is approved on <a href="/youtube-channels">YouTube channels</a> — oEmbed confirms who uploaded a video, not whether they're authorized to broadcast it, so that call is made by a human, once per channel. Non-YouTube sources are counted but never resolved to an actual URL. See <a href="/live">Live now</a>.</p>
    </div>

    <div class="card">
      <strong>First 25 fixtures</strong> <span class="muted">(preview only, earliest first, Beijing UTC+8 — see <a href="/browse">Browse all</a> for the full ${state.lastRunCount ?? 0}-row dataset with stream URLs, or fixtures.csv/fixtures.json for raw data)</span>
      ${
        rows.length
          ? `<table><tr><th>Date</th><th>Time</th><th>Match</th><th>League</th><th>Channels</th><th>Type</th><th>Src</th></tr>${fixtureRows}</table>`
          : '<p class="muted">No fixtures yet — click "Run pipeline now" above.</p>'
      }
    </div>
  `
  );
}

function statusDot(url, getSourceStatus) {
  const cached = getSourceStatus ? getSourceStatus(url) : null;
  const cls = cached ? `dot-${cached.status}` : 'dot-unchecked';
  let title = 'not checked yet';
  if (cached) {
    title = `${cached.status} (checked ${cached.checkedAt})`;
    if (cached.nestedUrl) {
      title += cached.nestedOk
        ? ' — first segment verified reachable'
        : ' — first segment failed reachability/CORS';
    }
  }
  return `<span class="dot ${cls}" title="${escapeHtml(title)}"></span>`;
}

function renderBrowse(state, getSourceStatus, tz = 'beijing') {
  const rows = state.lastRows || [];

  const tableRows = rows
    .map((r) => {
      const { date, time } = formatInTimezone(r.matchDateUTC, tz);
      const channels = r.channels || [];
      const channelItems = channels.length
        ? channels
            .map((ch) => {
              const sources = ch.sources || [];
              const sourceItems = sources
                .map(
                  (url) =>
                    `<li>${statusDot(url, getSourceStatus)}<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></li>`
                )
                .join('');
              return `<li><span class="channel-name">${escapeHtml(ch.name)}</span>${sources.length ? '' : '<span class="no-url">(no stream match)</span>'}
                ${sources.length ? `<ul class="source-list">${sourceItems}</ul>` : ''}
              </li>`;
            })
            .join('')
        : '<li class="no-url">—</li>';
      const matchZH =
        r.homeTeamZH && (!r.awayTeam || r.awayTeamZH)
          ? `${r.homeTeamZH}${r.awayTeamZH ? ' v ' + r.awayTeamZH : ''}`
          : '';
      return `<tr>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(r.homeTeam)}${r.awayTeam ? ' v ' + escapeHtml(r.awayTeam) : ''}</td>
        <td>${escapeHtml(matchZH) || '<span class="no-url">—</span>'}</td>
        <td>${escapeHtml(r.league)}</td>
        <td>${escapeHtml(r.leagueZH || '') || '<span class="no-url">—</span>'}</td>
        <td>${escapeHtml(r.sportType || '')}</td>
        <td>${escapeHtml(r.source === 'wheresthematch' ? 'WTM' : 'SDB')}</td>
        <td><ul class="channel-list">${channelItems}</ul></td>
      </tr>`;
    })
    .join('');

  return layout(
    'iss-railway browse',
    `
    <h1>All fixtures</h1>
    <p class="muted">Every row from the last run. Each channel can have multiple candidate sources; the dot shows the last check (<span class="dot dot-ok"></span> ok — iframe-ready, <span class="dot dot-stream"></span> stream — needs a video player, not a bare iframe, <span class="dot dot-blocked"></span> blocked/dead, <span class="dot dot-unchecked"></span> not checked — run "Check sources" on the <a href="/">dashboard</a>).</p>
    <p class="muted">Times shown: <a href="/browse?tz=beijing" ${tz === 'beijing' ? 'style="color:#e2e8f0;font-weight:600"' : ''}>Beijing (UTC+8)</a> · <a href="/browse?tz=jerusalem" ${tz === 'jerusalem' ? 'style="color:#e2e8f0;font-weight:600"' : ''}>Jerusalem</a> — exports (fixtures.csv/fixtures.json) are always Beijing time regardless of this toggle. Chinese columns are blank until "Translate names" has run — see the <a href="/">dashboard</a>.</p>
    <input type="text" id="search-box" placeholder="Filter by team, league, channel..." oninput="filterRows()">
    <p id="row-count"></p>
    <div class="card" style="overflow-x:auto">
      <table id="fixtures-table">
        <thead><tr><th>Date</th><th>Time</th><th>Match</th><th>Match (中文)</th><th>League</th><th>League (中文)</th><th>Type</th><th>Src</th><th>Channels</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <script>
      function filterRows() {
        const q = document.getElementById('search-box').value.toLowerCase();
        const rows = document.querySelectorAll('#fixtures-table tbody tr');
        let visible = 0;
        rows.forEach((row) => {
          const match = row.textContent.toLowerCase().includes(q);
          row.style.display = match ? '' : 'none';
          if (match) visible++;
        });
        document.getElementById('row-count').textContent = visible + ' of ' + rows.length + ' rows shown';
      }
      filterRows();
    </script>
  `
  );
}

function liveStatusBadge(row) {
  if (row.status === 'ended') {
    return `<span class="dot dot-dead" title="Ended ${escapeHtml(row.endedAt || '')}"></span>Ended`;
  }
  return `<span class="dot dot-ok" title="Live since ${escapeHtml(row.firstSeenAt || '')}"></span>Live`;
}

function renderLive(state) {
  const rows = state.liveRows || [];

  const tableRows = rows
    .map((r) => {
      const { date, time } = formatBeijing(r.matchDateUTC);
      const channelItems = (r.channels || [])
        .map((ch) => {
          if (ch.type === 'other') {
            return `<li><span class="badge badge-none">other source (not shown)</span></li>`;
          }
          const badge = ch.approved
            ? '<span class="badge badge-approved">approved</span>'
            : '<span class="badge badge-pending">pending review</span>';
          const link = ch.approved
            ? `<a href="${escapeHtml(ch.url)}" target="_blank" rel="noopener">${escapeHtml(ch.channelName)}</a>`
            : `${escapeHtml(ch.channelName)} <span class="no-url">(not embeddable until approved)</span>`;
          return `<li>${link} ${badge}<br><span class="muted">${escapeHtml(ch.title || '')}</span></li>`;
        })
        .join('');
      return `<tr>
        <td>${escapeHtml(date)}</td>
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(r.matchName)}</td>
        <td>${escapeHtml(r.league)}</td>
        <td>${escapeHtml(r.sportType || '')}</td>
        <td>${liveStatusBadge(r)}</td>
        <td><ul class="channel-list">${channelItems || '<li class="no-url">—</li>'}</ul></td>
      </tr>`;
    })
    .join('');

  return layout(
    'iss-railway live now',
    `
    <h1>Live now</h1>
    <p class="muted">Currently-live games from the configured live-streaming source, refreshed on demand from the <a href="/">dashboard</a>. This is "what's live right now," separate from the scheduled fixtures on <a href="/browse">Browse all</a>. A game stays visible marked "Ended" for a few hours after it drops off the source's live list, then disappears — also exported at <a href="/live.csv">live.csv</a> / <a href="/live.json">live.json</a>, same column format as fixtures.csv.</p>
    <p class="muted">Only YouTube links from an <a href="/youtube-channels">approved channel</a> are shown as embeddable. Everything else is either pending review or a non-YouTube source that's intentionally never resolved to a URL.</p>
    <div class="card" style="overflow-x:auto">
      ${
        rows.length
          ? `<table><tr><th>Date</th><th>Time</th><th>Match</th><th>League</th><th>Type</th><th>Status</th><th>Sources</th></tr>${tableRows}</table>`
          : '<p class="muted">No live games fetched yet — click "Fetch live streams now" on the dashboard.</p>'
      }
    </div>
  `
  );
}

function renderYouTubeChannels(getAllYouTubeChannels) {
  const channels = getAllYouTubeChannels ? getAllYouTubeChannels() : {};
  const entries = Object.entries(channels).sort((a, b) => (a[1].channelName || '').localeCompare(b[1].channelName || ''));

  const rows = entries
    .map(([url, info]) => {
      const badgeClass = `badge-${info.status || 'pending'}`;
      return `<tr>
        <td><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(info.channelName || url)}</a></td>
        <td><span class="badge ${badgeClass}">${escapeHtml(info.status || 'pending')}</span></td>
        <td class="muted">${escapeHtml(info.exampleTitle || '')}</td>
        <td>
          <form class="inline-form" method="POST" action="/api/youtube-channel">
            <input type="hidden" name="channelUrl" value="${escapeHtml(url)}">
            <button type="submit" name="status" value="approved">Approve</button>
            <button type="submit" name="status" value="rejected" class="secondary">Reject</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return layout(
    'iss-railway youtube channels',
    `
    <h1>YouTube channels</h1>
    <p class="muted">Every YouTube channel the live-streaming source has surfaced a video from. Approving a channel here means every past and future video from it counts as usable — check the channel is genuinely the rightsholder's own official account before approving, not just that the current example video looks fine. Verified live via <a href="https://www.youtube.com/oembed" target="_blank" rel="noopener">YouTube's own oEmbed endpoint</a> — this confirms who uploaded a video, never whether they're authorized to broadcast the content.</p>
    <div class="card" style="overflow-x:auto">
      ${
        entries.length
          ? `<table><tr><th>Channel</th><th>Status</th><th>Example video seen</th><th>Action</th></tr>${rows}</table>`
          : '<p class="muted">No channels seen yet — fetch live streams from the dashboard first.</p>'
      }
    </div>
  `
  );
}

function renderLeagues(state, getLeagueOverrides) {
  const overrides = getLeagueOverrides ? getLeagueOverrides() : {};
  const rawNames = new Set();
  for (const r of state.lastRows || []) {
    if (r.rawLeague) rawNames.add(r.rawLeague);
  }

  const rows = [...rawNames]
    .sort()
    .map((raw) => {
      const key = raw.trim().toLowerCase().replace(/\s+/g, ' ');
      const current = overrides[key];
      // Find what it currently resolves to by checking a live row (covers the seed-table case too)
      const example = (state.lastRows || []).find((r) => r.rawLeague === raw);
      const resolvesTo = example ? example.league : raw;
      return `<tr>
        <td>${escapeHtml(raw)}</td>
        <td>${escapeHtml(resolvesTo)}${current ? ' <span class="badge badge-manual">override</span>' : ''}</td>
        <td>
          <form class="inline-form" method="POST" action="/api/league-alias">
            <input type="hidden" name="rawName" value="${escapeHtml(raw)}">
            <input type="text" name="canonicalName" value="${escapeHtml(resolvesTo)}" placeholder="Canonical name">
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return layout(
    'iss-railway leagues',
    `
    <h1>League grouping</h1>
    <p class="muted">Different sources word the same league differently (e.g. SportsDB's "English Premier League" vs wheresthematch's "Premier League"). Set the canonical name each raw name should resolve to — it applies immediately to the current dataset and persists for future runs.</p>
    <div class="card" style="overflow-x:auto">
      ${
        rows.length
          ? `<table><tr><th>Raw league name</th><th>Currently resolves to</th><th>Set canonical name</th></tr>${rows}</table>`
          : '<p class="muted">No fixtures yet — run the pipeline first.</p>'
      }
    </div>
  `
  );
}

function renderTranslations(state, getAllTranslations) {
  const cache = getAllTranslations ? getAllTranslations() : {};
  const names = new Set();
  for (const r of state.lastRows || []) {
    if (r.league) names.add(r.league);
    if (r.homeTeam) names.add(r.homeTeam);
    if (r.awayTeam) names.add(r.awayTeam);
  }

  const rows = [...names]
    .sort()
    .map((text) => {
      const entry = cache[text];
      const badge = entry
        ? `<span class="badge ${entry.source === 'manual' ? 'badge-manual' : 'badge-auto'}">${entry.source}</span>`
        : '<span class="badge badge-none">untranslated</span>';
      return `<tr>
        <td>${escapeHtml(text)}</td>
        <td>${badge}</td>
        <td>
          <form class="inline-form" method="POST" action="/api/translation">
            <input type="hidden" name="text" value="${escapeHtml(text)}">
            <input type="text" name="zh" value="${escapeHtml(entry ? entry.zh : '')}" placeholder="Simplified Chinese">
            <button type="submit">Save</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');

  return layout(
    'iss-railway translations',
    `
    <h1>Translations</h1>
    <p class="muted">League and team names, Simplified Chinese. Saving here sets a manual override that always wins over auto-translation and is never overwritten by "Re-translate" on the <a href="/">dashboard</a>.</p>
    <div class="card" style="overflow-x:auto">
      ${
        rows.length
          ? `<table><tr><th>Original</th><th>Source</th><th>Simplified Chinese</th></tr>${rows}</table>`
          : '<p class="muted">No fixtures yet — run the pipeline first.</p>'
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

        <label for="wtmDays">wheresthematch.com lookahead (days)</label>
        <input type="text" id="wtmDays" name="wtmDays" value="${escapeHtml(config.wtmDays)}">

        <label for="liveTvDomain">Live streaming source domain (blank = feature disabled)</label>
        <input type="text" id="liveTvDomain" name="liveTvDomain" value="${escapeHtml(config.liveTvDomain || '')}" placeholder="e.g. http://example.com">

        <button type="submit">Save settings</button>
      </form>
    </div>
    <p class="muted">Note: settings saved here live on this container's disk and apply immediately, but a Railway
    redeploy resets them back to the service's environment variables. Set the env vars too if you want a change
    to survive a redeploy.</p>
  `
  );
}

function createServer({
  getState,
  runOnce,
  rescheduleCron,
  runSourceCheck,
  getSourceStatus,
  runTranslate,
  getAllTranslations,
  setManualTranslation,
  getLeagueOverrides,
  setLeagueAlias,
  runLiveTvFetch,
  getAllYouTubeChannels,
  setChannelStatus,
}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/', requireAuth, (req, res) => {
    res.send(renderDashboard(getState(), getConfig()));
  });

  app.get('/browse', requireAuth, (req, res) => {
    const tz = req.query.tz === 'jerusalem' ? 'jerusalem' : 'beijing';
    res.send(renderBrowse(getState(), getSourceStatus, tz));
  });

  app.post('/api/check-sources', requireAuth, (req, res) => {
    // Fire-and-forget: the check can take minutes for hundreds of URLs, so
    // don't block the response on it. Progress shows up on the dashboard.
    runSourceCheck(req.body.force === '1').catch((err) => console.error('[sourceChecks]', err.message));
    res.redirect('/');
  });

  app.post('/api/translate-names', requireAuth, (req, res) => {
    runTranslate(req.body.force === '1').catch((err) => console.error('[translate]', err.message));
    res.redirect('/');
  });

  app.get('/leagues', requireAuth, (req, res) => {
    res.send(renderLeagues(getState(), getLeagueOverrides));
  });

  app.post('/api/league-alias', requireAuth, (req, res) => {
    const { rawName, canonicalName } = req.body;
    setLeagueAlias(rawName, canonicalName);
    res.redirect('/leagues');
  });

  app.get('/live', requireAuth, (req, res) => {
    res.send(renderLive(getState()));
  });

  app.post('/api/fetch-live', requireAuth, (req, res) => {
    runLiveTvFetch().catch((err) => console.error('[liveTv]', err.message));
    res.redirect('/');
  });

  app.get('/youtube-channels', requireAuth, (req, res) => {
    res.send(renderYouTubeChannels(getAllYouTubeChannels));
  });

  app.post('/api/youtube-channel', requireAuth, (req, res) => {
    const { channelUrl, status } = req.body;
    setChannelStatus(channelUrl, status);
    res.redirect('/youtube-channels');
  });

  app.get('/translations', requireAuth, (req, res) => {
    res.send(renderTranslations(getState(), getAllTranslations));
  });

  app.post('/api/translation', requireAuth, (req, res) => {
    const { text, zh } = req.body;
    setManualTranslation(text, zh);
    res.redirect('/translations');
  });

  app.get('/settings', requireAuth, (req, res) => {
    res.send(renderSettings(getConfig(), req.query.saved === '1'));
  });

  app.post('/settings', requireAuth, (req, res) => {
    const { apiKey, leagueIds, playlistUrl, cronExpr, wtmDays, liveTvDomain } = req.body;
    updateConfig({ apiKey, leagueIds, playlistUrl, cronExpr, wtmDays, liveTvDomain });
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

  app.get('/live.csv', (req, res) => {
    const { outputLiveCsvPath } = getConfig();
    if (!fs.existsSync(outputLiveCsvPath)) {
      return res.status(404).send('No live CSV generated yet — fetch live streams has not completed a run.');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="live.csv"');
    fs.createReadStream(outputLiveCsvPath).pipe(res);
  });

  app.get('/live.json', (req, res) => {
    const rows = getState().liveRowsNormalized;
    if (!rows) return res.status(404).json({ error: 'No data yet — fetch live streams has not completed a run.' });
    res.json(rows);
  });

  return app;
}

module.exports = { createServer, renderLive };
