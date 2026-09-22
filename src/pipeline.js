const sportsdb = require('./sportsdb');
const wtm = require('./wheresthematch');
const livesportsontv = require('./livesportsontv');
const iptv = require('./iptv');
const leagues = require('./leagues');
const translate = require('./translate');
const matchMerge = require('./matchMerge');
const { writeCsv } = require('./csv');

/**
 * Full run: TheSportsDB + wheresthematch.com + livesportsontv.com schedule
 * scrapes -> per-event TV channel lookup -> match against the free public
 * playlists (doms9/iptv + iptv-org, doms9 prioritized — see iptv.js's
 * matchChannels) -> merge same-game duplicates across sources (see
 * matchMerge.js) -> flat rows -> CSV.
 *
 * Each row's `channels` is an array of { name, sources: [url, ...] } — a
 * channel can resolve to more than one candidate stream (mirrors from
 * either playlist, doms9's listed first), so this intentionally isn't a
 * one-to-one channel-to-URL mapping. When the same real game is reported
 * by more than one source, their channel lists are unioned into one row
 * rather than kept as separate duplicate rows.
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
async function runPipeline({ apiKey, leagueIds, playlistUrl, doms9PlaylistUrl, outputCsvPath, wtmDays, livesportsontvLeagues }) {
  console.log(`[pipeline] starting run for ${leagueIds.length} leagues`);

  // Force-refresh both channel playlists once per run, bypassing their own
  // TTL, so "up to date" tracks this run's timestamp rather than an
  // independent clock that could lag behind by up to a full day. Every
  // matchChannels() call below reuses this run's cached copies. doms9 is
  // listed first — matchChannels stacks results from both, preferring
  // doms9's URLs when a channel matches in both.
  const playlistUrls = [doms9PlaylistUrl, playlistUrl].filter(Boolean);
  await Promise.all(playlistUrls.map((url) => iptv.getPlaylist(url, { force: true })));

  const { events: rawEvents, failures } = await sportsdb.fetchAllFixtures(apiKey, leagueIds);
  const rows = [];

  for (const raw of rawEvents) {
    const event = sportsdb.normalizeEvent(raw);

    const channelNames = await sportsdb.getMatchChannels(apiKey, event.eventId);
    const matched = channelNames.length ? await iptv.matchChannels(channelNames, playlistUrls) : [];

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
      const matched = event.channels.length ? await iptv.matchChannels(event.channels, playlistUrls) : [];

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

  try {
    if (livesportsontvLeagues && livesportsontvLeagues.length) {
      console.log(`[pipeline] fetching livesportsontv.com (${livesportsontvLeagues.join(', ')})`);
      const { rows: lsotvRaw, failures: lsotvFailures } = await livesportsontv.fetchAllLeagues(livesportsontvLeagues);
      console.log(`[pipeline] livesportsontv: ${lsotvRaw.length} fixtures`);
      for (const f of lsotvFailures) failures.push({ leagueId: `livesportsontv:${f.league || 'unknown'}`, message: f.message });

      for (const event of lsotvRaw) {
        const matched = event.channels.length ? await iptv.matchChannels(event.channels, playlistUrls) : [];

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
          source: 'livesportsontv',
          channels: matched.map((m) => ({ name: m.label, sources: m.sources })),
        });
      }
    }
  } catch (err) {
    console.error(`[pipeline] livesportsontv fetch failed: ${err.message}`);
    failures.push({ leagueId: 'livesportsontv.com', message: err.message });
  }

  // Merge rows representing the same real game across sources (matched by
  // team names + kickoff time — see matchMerge.js) instead of a naive
  // eventId-only dedup, which never caught cross-source duplicates (the
  // three sources never share an ID scheme) and left the same game
  // showing up as separate rows whenever more than one source reported it.
  const deduped = matchMerge.mergeRows(rows);

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
