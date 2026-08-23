const fs = require('fs');
const path = require('path');

const MAX_SOURCES = 10;

// Column order mirrors the old Google Sheet's Source/Feed/Final tabs: one
// row per (match, channel) pair, Date/Time in Beijing to match it exactly,
// up to MAX_SOURCES candidate stream URLs per channel (Source1..Source10 —
// a channel can resolve to more than one mirror, not a strict 1:1 mapping).
// Traceability fields (EventID, Source, team split) trail at the end.
const HEADER = [
  'Date',
  'Time',
  'Match',
  'League',
  'Channel',
  'Type',
  ...Array.from({ length: MAX_SOURCES }, (_, i) => `Source${i + 1}`),
  'EventID',
  'Source',
  'HomeTeam',
  'AwayTeam',
  'MatchDateUTC',
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
    const channels = r.channels && r.channels.length ? r.channels : [{ name: '', sources: [] }];
    for (const ch of channels) {
      const sources = (ch.sources || []).slice(0, MAX_SOURCES);
      const sourceCols = Array.from({ length: MAX_SOURCES }, (_, i) => sources[i] || '');
      lines.push(
        [
          date,
          time,
          matchLabel(r),
          r.league,
          ch.name || '',
          r.sportType || '',
          ...sourceCols,
          r.eventId,
          r.source,
          r.homeTeam,
          r.awayTeam,
          r.matchDateUTC,
        ]
          .map(escapeCsvField)
          .join(',')
      );
    }
  }
  return lines.join('\n') + '\n';
}

function writeCsv(rows, outputPath) {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, rowsToCsv(rows), 'utf8');
  const rowCount = rows.reduce((n, r) => n + (r.channels && r.channels.length ? r.channels.length : 1), 0);
  console.log(`[csv] wrote ${rowCount} rows (${rows.length} fixtures) -> ${outputPath}`);
}

module.exports = { rowsToCsv, writeCsv, HEADER, formatBeijing };
