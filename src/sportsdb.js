// Port of includes/class-iss-api.php — TheSportsDB fixture + TV-listing client.
// No WordPress/$wpdb here: fetch functions just return plain JS objects/arrays.

const axios = require('axios');

const BASE_URL = 'https://www.thesportsdb.com/api/v1/json';

/**
 * Fetch upcoming fixtures for a single league ID.
 * Mirrors ISS_API::get_league_fixtures()
 */
async function getLeagueFixtures(apiKey, leagueId) {
  const url = `${BASE_URL}/${apiKey}/eventsnextleague.php?id=${leagueId}`;
  const { data } = await axios.get(url, { timeout: 15000 });
  return data && Array.isArray(data.events) ? data.events : [];
}

/**
 * Fetch fixtures for every configured league and flatten into one array.
 * Mirrors ISS_API::fetch_and_store_fixtures(), minus the DB write.
 */
async function fetchAllFixtures(apiKey, leagueIds) {
  const allEvents = [];
  const failures = [];
  for (const leagueId of leagueIds) {
    try {
      const events = await getLeagueFixtures(apiKey, leagueId);
      for (const ev of events) allEvents.push(ev);
      console.log(`[sportsdb] league ${leagueId}: ${events.length} fixtures`);
    } catch (err) {
      console.error(`[sportsdb] league ${leagueId} failed: ${err.message}`);
      failures.push({ leagueId, message: err.message });
    }
  }
  return { events: allEvents, failures };
}

/**
 * TV channels broadcasting a given event.
 * Mirrors ISS_IPTV_Scraper::get_match_channels()
 */
async function getMatchChannels(apiKey, sportsDbEventId) {
  const url = `${BASE_URL}/${apiKey}/lookuptv.php?id=${sportsDbEventId}`;
  try {
    const { data } = await axios.get(url, { timeout: 15000 });
    if (!data || !Array.isArray(data.tvevent)) return [];
    const names = data.tvevent.map((tv) => tv.strChannel).filter(Boolean);
    return [...new Set(names)];
  } catch (err) {
    console.error(`[sportsdb] tv lookup for event ${sportsDbEventId} failed: ${err.message}`);
    return [];
  }
}

/**
 * Normalize a raw TheSportsDB event into a flat row shape used downstream.
 */
function normalizeEvent(event) {
  const timestamp =
    event.strTimestamp || `${event.dateEvent || ''} ${event.strTime || ''}`.trim();
  return {
    eventId: event.idEvent,
    league: event.strLeague || '',
    homeTeam: event.strHomeTeam || '',
    awayTeam: event.strAwayTeam || '',
    homeLogo: event.strHomeTeamBadge || '',
    awayLogo: event.strAwayTeamBadge || '',
    matchDateUTC: timestamp,
  };
}

module.exports = { getLeagueFixtures, fetchAllFixtures, getMatchChannels, normalizeEvent };
