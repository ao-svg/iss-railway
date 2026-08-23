const sportsdb = require('./sportsdb');
const wtm = require('./wheresthematch');
const iptv = require('./iptv');
const leagues = require('./leagues');
const translate = require('./translate');
const { writeCsv } = require('./csv');

/**
 * Full run: TheSportsDB fixtures + wheresthematch.com schedule scrape ->
 * per-event TV channel lookup -> match against the public iptv-org playlist
 * -> flat rows -> CSV.
 *
 * Each row's `channels` is an array of { name, sources: [url, ...] } — a
 * channel can resolve to more than one candidate stream (mirrors), so this
 * intentionally isn't a one-to-one channel-to-URL mapping.
 *
 * `league` is the canonicalized name (see leagues.js — merges e.g. SportsDB's
 * "English Premier League" and wheresthematch's "Premier League" into one);
 * `rawLeague` keeps the original as scraped. `leagueZH`/`homeTeamZH`/
 * `awayTeamZH` are Simplified Chinese translations pulled from the
 * translation cache (translate.js) — null until the "Translate names" job
 * has run for that string at least once; this run never blocks on live
 * translation calls, same reasoning as source checks running as their own
 * job rather than inline.
 */
async function runPipeline({ apiKey, leagueIds, playlistUrl, outputCsvPath, wtmDays }) {
  console.log(`[pipeline] starting run for ${leagueIds.length} leagues`);

  const { events: rawEvents, failures } = await sportsdb.fetchAllFixtures(apiKey, leagueIds);
  const rows = [];

  for (const raw of rawEvents) {
    const event = sportsdb.normalizeEvent(raw);

    const channelNames = await sportsdb.getMatchChannels(apiKey, event.eventId);
    const matched = channelNames.length ? await iptv.matchChannels(channelNames, playlistUrl) : [];

    rows.push({
      ...event,
      rawLeague: event.league,
      league: leagues.canonicalLeague(event.league),
      source: 'sportsdb',
      channels: matched.map((m) => ({ name: m.label, sources: m.sources })),
    });
  }

  try {
    console.log('[pipeline] fetching wheresthematch.com schedule');
    const wtmRaw = await wtm.fetchSchedule(wtmDays);
    console.log(`[pipeline] wheresthematch: ${wtmRaw.length} fixtures`);

    for (const raw of wtmRaw) {
      const event = wtm.normalizeRow(raw);
      const matched = event.channels.length ? await iptv.matchChannels(event.channels, playlistUrl) : [];

      rows.push({
        eventId: event.eventId,
        rawLeague: event.league,
        league: leagues.canonicalLeague(event.league),
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        homeLogo: '',
        awayLogo: '',
        matchDateUTC: event.matchDateUTC,
        sportType: event.sportType,
        source: 'wheresthematch',
        channels: matched.map((m) => ({ name: m.label, sources: m.sources })),
      });
    }
  } catch (err) {
    console.error(`[pipeline] wheresthematch fetch failed: ${err.message}`);
    failures.push({ leagueId: 'wheresthematch.com', message: err.message });
  }

  // De-dupe on eventId in case a fixture is returned by more than one league query
  const seen = new Set();
  const deduped = rows.filter((r) => {
    if (seen.has(r.eventId)) return false;
    seen.add(r.eventId);
    return true;
  });

  for (const r of deduped) {
    r.leagueZH = translate.getCached(r.league)?.zh || null;
    r.homeTeamZH = translate.getCached(r.homeTeam)?.zh || null;
    r.awayTeamZH = r.awayTeam ? translate.getCached(r.awayTeam)?.zh || null : null;
  }

  deduped.sort((a, b) => (a.matchDateUTC < b.matchDateUTC ? -1 : 1));

  writeCsv(deduped, outputCsvPath);
  console.log(`[pipeline] done — ${deduped.length} fixtures written`);
  return { rows: deduped, failures };
}

module.exports = { runPipeline };
