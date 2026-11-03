// Daily source health report: once a day (SOURCE_REPORT_CRON) every source
// in the current dataset is force-checked, then counted into one health
// category each — live, live without CORS, authorization error, not
// responding, ... — overall and per host. One snapshot per UTC day is kept
// in data/source-reports.json (last KEEP_DAYS days), so the /source-report
// page can show the trend, not just today. Reads the source-check cache
// (sourceChecks.js) only; the forced check that feeds it runs in index.js.

const fs = require('fs');
const path = require('path');
const { dataPath } = require('./dataDir');

const REPORT_PATH = dataPath('source-reports.json');
const KEEP_DAYS = 90;
const TOP_HOSTS = 30;

// Display order, most usable first. Every source lands in exactly one.
const CATEGORIES = [
  { key: 'live', label: 'Live — plays in a browser', tone: 'ok' },
  { key: 'liveNoCors', label: 'Live — but no CORS (plays only via relay/native player)', tone: 'warn' },
  { key: 'responding', label: 'Responds — stream content not verified', tone: 'warn' },
  { key: 'authError', label: 'Authorization error (401/403)', tone: 'err' },
  { key: 'notFound', label: 'Not found (404/410)', tone: 'err' },
  { key: 'serverError', label: 'Server error (5xx)', tone: 'err' },
  { key: 'otherHttpError', label: 'Other HTTP error (4xx)', tone: 'err' },
  { key: 'notResponding', label: 'Not responding (timeout, DNS, refused)', tone: 'err' },
  { key: 'tooSlow', label: 'Too slow — segments download slower than they play', tone: 'err' },
  { key: 'broken', label: 'Responds, but the stream is broken (playlist or segment dead)', tone: 'err' },
  { key: 'blocked', label: 'Page blocks embedding (X-Frame-Options/CSP)', tone: 'err' },
  { key: 'dangerous', label: 'Dangerous (looks like an executable)', tone: 'err' },
  { key: 'neverChecked', label: 'Never checked', tone: 'muted' },
];

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
}

/**
 * One source-check result -> one category key. Pure. HTTP status decides
 * first (an access gate is an access gate whatever the body said), then
 * the working/cors facts for reachable ones.
 */
function categorize(check) {
  if (!check) return 'neverChecked';
  if (check.status === 'dangerous') return 'dangerous';
  const http = check.httpStatus;
  if (http === 401 || http === 403) return 'authError';
  if (http === 404 || http === 410) return 'notFound';
  if (http >= 500) return 'serverError';
  if (http >= 400) return 'otherHttpError';
  if (check.tooSlow) return 'tooSlow';
  if (check.status === 'dead') return http ? 'broken' : 'notResponding';
  if (check.status === 'blocked') return 'blocked';
  if (check.working === true) return check.status === 'nocors' ? 'liveNoCors' : 'live';
  return 'responding';
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '(invalid url)';
  }
}

/**
 * Snapshot for a set of source URLs (deduped). Pure apart from the
 * injected lookups. `getGeo(url, check)` gives the sourceGeo hint.
 */
function buildReport(urls, getStatus, { getGeo = () => null, now = new Date(), meta = {} } = {}) {
  const unique = [...new Set(urls)];
  const counts = emptyCounts();
  const hosts = new Map();
  let relayPlayable = 0;
  let usOnly = 0;
  for (const url of unique) {
    const check = getStatus(url);
    const key = categorize(check);
    counts[key]++;
    if (check && check.relayPlayable === true) relayPlayable++;
    if (getGeo(url, check) === 'us-only') usOnly++;
    const host = hostOf(url);
    if (!hosts.has(host)) hosts.set(host, { host, total: 0, counts: emptyCounts() });
    const h = hosts.get(host);
    h.total++;
    h.counts[key]++;
  }
  const byHost = [...hosts.values()].sort((a, b) => b.total - a.total || a.host.localeCompare(b.host));
  return {
    date: now.toISOString().slice(0, 10),
    at: now.toISOString(),
    total: unique.length,
    counts,
    relayPlayable,
    usOnly,
    byHost: byHost.slice(0, TOP_HOSTS),
    otherHosts: Math.max(0, byHost.length - TOP_HOSTS),
    ...meta,
  };
}

function loadReports() {
  try {
    const list = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

let _reports = loadReports();

function getReports() {
  return _reports;
}

function latestReport() {
  return _reports.length ? _reports[_reports.length - 1] : null;
}

/** Newest last; a second report on the same UTC day replaces the first. Pure. */
function addReport(list, report, keepDays = KEEP_DAYS) {
  const next = list.filter((r) => r.date !== report.date).concat(report);
  next.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return next.slice(-keepDays);
}

function saveReport(report) {
  _reports = addReport(_reports, report);
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(_reports, null, 2));
  return report;
}

module.exports = { CATEGORIES, categorize, buildReport, addReport, saveReport, getReports, latestReport, hostOf };
