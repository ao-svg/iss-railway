const fs = require('fs');
const path = require('path');

const HEADER = [
  'EventID',
  'Source',
  'League',
  'HomeTeam',
  'AwayTeam',
  'MatchDateUTC',
  'HomeLogo',
  'AwayLogo',
  'Channels', // semicolon-separated list of matched TV channel names
  'StreamURLs', // semicolon-separated, same order as Channels
];

function escapeCsvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowsToCsv(rows) {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.eventId,
        r.source,
        r.league,
        r.homeTeam,
        r.awayTeam,
        r.matchDateUTC,
        r.homeLogo,
        r.awayLogo,
        (r.channels || []).join(';'),
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

module.exports = { rowsToCsv, writeCsv, HEADER };
