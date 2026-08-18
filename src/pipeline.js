const sportsdb = require('./sportsdb');
const wtm = require('./wheresthematch');
const iptv = require('./iptv');
const { writeCsv } = require('./csv');

/**
 * Full run: TheSportsDB fixtures + wheresthematch.com schedule scrape ->
 * per-event TV channel lookup -> match against the public iptv-org playlist
 * -> flat rows -> CSV.
 */
async function runPipeline({ apiKey, leagueIds, playlistUrl, outputCsvPath, wtmDays }) {
  console.log(`[pipeline] starting run for ${leagueIds.length} leagues`);

  const { events: rawEvents, failures } = await sportsdb.fetchAllFixtures(apiKey, leagueIds);
  const rows = [];

  for (const raw of rawEvents) {
    const event = sportsdb.normalizeEvent(raw);

    const channelNames = await sportsdb.getMatchChannels(apiKey, event.eventId);
    const matched = channelNames.length
      ? await iptv.matchChannels(channelNames, playlistUrl)
      : [];

    rows.push({
      ...event,
      source: 'sportsdb',
      channels: matched.map((m) => m.label),
      streamUrls: matched.map((m) => m.streamUrl),
    });
  }

  try {
    console.log('[pipeline] fetching wheresthematch.com schedule');
    const wtmRaw = await wtm.fetchSchedule(wtmDays);
    console.log(`[pipeline] wheresthematch: ${wtmRaw.length} fixtures`);

    for (const raw of wtmRaw) {
      const event = wtm.normalizeRow(raw);
      const matched = await iptv.matchChannels([event.channelName], playlistUrl);

      rows.push({
        eventId: event.eventId,
        league: event.league,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        homeLogo: '',
        awayLogo: '',
        matchDateUTC: event.matchDateUTC,
        sportType: event.sportType,
        source: 'wheresthematch',
        channels: matched.map((m) => m.label),
        streamUrls: matched.map((m) => m.streamUrl),
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

  deduped.sort((a, b) => (a.matchDateUTC < b.matchDateUTC ? -1 : 1));

  writeCsv(deduped, outputCsvPath);
  console.log(`[pipeline] done — ${deduped.length} fixtures written`);
  return { rows: deduped, failures };
}

module.exports = { runPipeline };
