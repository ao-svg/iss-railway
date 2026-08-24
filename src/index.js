require('dotenv').config();
const cron = require('node-cron');
const { runPipeline } = require('./pipeline');
const { createServer } = require('./server');
const { getConfig } = require('./config');
const sourceChecks = require('./sourceChecks');
const translate = require('./translate');
const leagues = require('./leagues');
const liveTv = require('./liveTv');
const liveTvStore = require('./liveTvStore');
const youtubeChannels = require('./youtubeChannels');
const { writeCsv } = require('./csv');

const port = process.env.PORT || 3000;

const state = {
  running: false,
  lastRunAt: null,
  lastRunCount: null,
  lastRunFailures: [],
  lastError: null,
  lastRows: null,
  checkRunning: false,
  checkProgress: null, // { done, total }
  lastCheckAt: null,
  lastCheckSummary: null,
  translateRunning: false,
  translateProgress: null, // { done, total }
  lastTranslateAt: null,
  lastTranslateSummary: null,
  liveRunning: false,
  liveProgress: null, // { done, total } — sports processed, not games
  lastLiveAt: null,
  lastLiveFailures: [],
  liveRows: null, // separate from lastRows: "live right now", not schedule data
  liveRowsNormalized: null, // backs /live.csv and /live.json, mirrors lastRows -> fixtures.csv/json
};

let cronTask = null;

async function runOnce() {
  if (state.running) return state;
  state.running = true;
  try {
    const { apiKey, leagueIds, playlistUrl, outputCsvPath, wtmDays } = getConfig();
    const { rows, failures } = await runPipeline({ apiKey, leagueIds, playlistUrl, outputCsvPath, wtmDays });
    state.lastRunAt = new Date().toISOString();
    state.lastRunCount = rows.length;
    state.lastRunFailures = failures;
    state.lastRows = rows;
    state.lastError = null;
  } catch (err) {
    console.error('[pipeline] run failed:', err.message);
    state.lastError = err.message;
  } finally {
    state.running = false;
  }
  return state;
}

function allSourceUrls() {
  const urls = [];
  for (const row of state.lastRows || []) {
    for (const ch of row.channels || []) {
      for (const url of ch.sources || []) urls.push(url);
    }
  }
  return urls;
}

async function runSourceCheck(force = false) {
  if (state.checkRunning) return state;
  const urls = allSourceUrls();
  if (!urls.length) return state;
  state.checkRunning = true;
  state.checkProgress = { done: 0, total: urls.length };
  try {
    const summary = await sourceChecks.checkAll(urls, {
      force,
      onProgress: (done, total) => {
        state.checkProgress = { done, total };
      },
    });
    state.lastCheckAt = new Date().toISOString();
    state.lastCheckSummary = summary;
  } catch (err) {
    console.error('[sourceChecks] run failed:', err.message);
  } finally {
    state.checkRunning = false;
    state.checkProgress = null;
  }
  return state;
}

function allTranslatableNames() {
  const names = new Set();
  for (const row of state.lastRows || []) {
    if (row.league) names.add(row.league);
    if (row.homeTeam) names.add(row.homeTeam);
    if (row.awayTeam) names.add(row.awayTeam);
  }
  return [...names];
}

// After a translate run, the already-loaded rows in memory (and the CSV
// already on disk) still carry whatever leagueZH/homeTeamZH/awayTeamZH they
// had at pipeline-run time. Refresh them from the cache and rewrite the CSV
// so newly-translated names show up immediately, without waiting for the
// next full pipeline run (which would also needlessly re-fetch everything
// from SportsDB/wheresthematch/iptv-org just to pick up a translation).
function refreshTranslationsOnRows() {
  if (!state.lastRows) return;
  for (const r of state.lastRows) {
    r.leagueZH = translate.getCached(r.league)?.zh || null;
    r.homeTeamZH = translate.getCached(r.homeTeam)?.zh || null;
    r.awayTeamZH = r.awayTeam ? translate.getCached(r.awayTeam)?.zh || null : null;
  }
  const { outputCsvPath } = getConfig();
  writeCsv(state.lastRows, outputCsvPath);
}

async function runTranslate(force = false) {
  if (state.translateRunning) return state;
  const names = allTranslatableNames();
  if (!names.length) return state;
  state.translateRunning = true;
  state.translateProgress = { done: 0, total: names.length };
  try {
    const summary = await translate.translateAll(names, {
      force,
      onProgress: (done, total) => {
        state.translateProgress = { done, total };
      },
    });
    state.lastTranslateAt = new Date().toISOString();
    state.lastTranslateSummary = summary;
    refreshTranslationsOnRows();
  } catch (err) {
    console.error('[translate] run failed:', err.message);
  } finally {
    state.translateRunning = false;
    state.translateProgress = null;
  }
  return state;
}

// Manual overrides (translation or league grouping) should show up
// immediately on the already-loaded rows/CSV, not wait for the next
// pipeline run — same reasoning as refreshTranslationsOnRows() above.
function setManualTranslationAndRefresh(text, zh) {
  translate.setManualTranslation(text, zh);
  refreshTranslationsOnRows();
  refreshLiveCsv();
}

function setLeagueAliasAndRefresh(rawName, canonicalName) {
  leagues.setLeagueAlias(rawName, canonicalName);
  if (state.lastRows) {
    for (const r of state.lastRows) {
      if (r.rawLeague) r.league = leagues.canonicalLeague(r.rawLeague);
    }
    const { outputCsvPath } = getConfig();
    writeCsv(state.lastRows, outputCsvPath);
  }
  refreshLiveCsv();
}

// Rebuilds live.csv/live.json from the current state.liveRows — called
// after every fetch and after any manual override (channel approval,
// translation, league alias) so those show up immediately, same reasoning
// as refreshTranslationsOnRows() above for the main pipeline's CSV.
function refreshLiveCsv() {
  if (!state.liveRows) return;
  const { outputLiveCsvPath } = getConfig();
  state.liveRowsNormalized = liveTv.normalizeLiveRows(state.liveRows);
  writeCsv(state.liveRowsNormalized, outputLiveCsvPath);
}

async function runLiveTvFetch() {
  if (state.liveRunning) return state;
  const { liveTvDomain } = getConfig();
  state.liveRunning = true;
  state.liveProgress = { done: 0, total: liveTv.SPORTS.length };
  try {
    const { rows, failures, successfulSports } = await liveTv.fetchLiveStreams(liveTvDomain, {
      onProgress: (done, total) => {
        state.liveProgress = { done, total };
      },
    });
    state.liveRows = liveTvStore.applyFetch(rows, successfulSports);
    state.lastLiveFailures = failures;
    state.lastLiveAt = new Date().toISOString();
    refreshLiveCsv();
  } catch (err) {
    console.error('[liveTv] run failed:', err.message);
  } finally {
    state.liveRunning = false;
    state.liveProgress = null;
  }
  return state;
}

// Approving/rejecting a channel should show up immediately on already-
// fetched live rows, not wait for the next "Fetch live streams" click.
function setChannelStatusAndRefresh(channelUrl, status) {
  youtubeChannels.setChannelStatus(channelUrl, status);
  if (!state.liveRows) return;
  for (const row of state.liveRows) {
    for (const ch of row.channels || []) {
      if (ch.type === 'youtube' && ch.channelUrl === channelUrl) {
        ch.approved = youtubeChannels.isApproved(channelUrl);
      }
    }
  }
  refreshLiveCsv();
}

function scheduleCron() {
  if (cronTask) cronTask.stop();
  const { cronExpr } = getConfig();
  if (!cron.validate(cronExpr)) {
    console.error(`[index] invalid PIPELINE_CRON "${cronExpr}", falling back to every 6h`);
    getConfig().cronExpr = '0 */6 * * *';
  }
  cronTask = cron.schedule(getConfig().cronExpr, runOnce);
  console.log(`[index] pipeline scheduled: ${getConfig().cronExpr}`);
}

const runOnlyFlag = process.argv.includes('--once');

if (runOnlyFlag) {
  runOnce().then(() => process.exit(0));
} else {
  runOnce();
  scheduleCron();

  const app = createServer({
    getState: () => state,
    runOnce,
    rescheduleCron: scheduleCron,
    runSourceCheck,
    getSourceStatus: sourceChecks.getStatus,
    runTranslate,
    getTranslation: translate.getCached,
    getAllTranslations: translate.getAllCached,
    setManualTranslation: setManualTranslationAndRefresh,
    getLeagueOverrides: leagues.getOverrides,
    setLeagueAlias: setLeagueAliasAndRefresh,
    runLiveTvFetch,
    getAllYouTubeChannels: youtubeChannels.getAllChannels,
    setChannelStatus: setChannelStatusAndRefresh,
  });
  app.listen(port, () => {
    console.log(`[index] server listening on :${port}`);
  });
}
