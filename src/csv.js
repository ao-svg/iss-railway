const fs = require('fs');
const path = require('path');

// Column order mirrors the old Google Sheet's Source/Feed/Final tabs
// (Date, 北京时间/Time, Match, League, Channels, Type), with the extra
// traceability fields (EventID, Source, team split, StreamURLs) trailing —
// useful for verifying a row on the dashboard without breaking the shape
// match.
const HEADER = [
  'Date', // Beijing time (UTC+8), matching the reference sheet
  'Time', // Beijing time (UTC+8), matching the reference sheet
  'Match',
  'League',
  'Channels', // semicolon-separated list of matched TV channel names
  'Type', // sport category
  'EventID',
  'Source', // sportsdb | wheresthematch
  'HomeTeam',
  'AwayTeam',
  'MatchDateUTC',
  'StreamURLs', // semicolon-separated, same order as Channels
];

function escapeCsvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Parse a matchDateUTC string into a Date. SportsDB rows come without a
 * timezone suffix (documented as UTC); wheresthematch rows already carry an
 * explicit offset. Normalize both into a real Date.
 */
function parseMatchDate(matchDateUTC) {
  if (!matchDateUTC) return null;
  let s = matchDateUTC.trim().replace(' ', 'T');
  if (!/Z$|[+-]\d{2}:\d{2}$/.test(s)) s += 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date as Beijing time (UTC+8), matching the reference sheet's
 * "北京时间" column regardless of the source's original timezone.
 */
function formatBeijing(matchDateUTC) {
  const d = parseMatchDate(matchDateUTC);
  if (!d) return { date: '', time: '' };
  const beijing = new Date(d.getTime() + 8 * 3600000);
  return {
    date: `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())}`,
    time: `${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}`,
  };
}

function matchLabel(r) {
  return r.awayTeam ? `${r.homeTeam} v ${r.awayTeam}` : r.homeTeam;
}

function rowsToCsv(rows) {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    const { date, time } = formatBeijing(r.matchDateUTC);
    lines.push(
      [
        date,
        time,
        matchLabel(r),
        r.league,
        (r.channels || []).join(';'),
        r.sportType || '',
        r.eventId,
        r.source,
        r.homeTeam,
        r.awayTeam,
        r.matchDateUTC,
        (r.streamUrls || []).join(';'),
      ]
        .map(escapeCsvField)
        .join(',')
    );
  }
  return lines.join('\n') + '\n';
}

function writeCsv(rows, outputPath) {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, rowsToCsv(rows), 'utf8');
  console.log(`[csv] wrote ${rows.length} rows -> ${outputPath}`);
}

module.exports = { rowsToCsv, writeCsv, HEADER, formatBeijing };
