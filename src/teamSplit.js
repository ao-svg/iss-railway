// Shared "Team A v Team B" -> { homeTeam, awayTeam } splitter. Used by
// wheresthematch.js and liveTv.js — pulled out here so there's one copy of
// this regex instead of a third inline one.

function splitTeams(matchName) {
  const parts = (matchName || '').split(/\s+v\s+/i);
  const homeTeam = parts[0] ? parts[0].trim() : matchName || '';
  const awayTeam = parts[1] ? parts[1].trim() : '';
  return { homeTeam, awayTeam };
}

module.exports = { splitTeams };
