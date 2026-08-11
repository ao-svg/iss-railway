const express = require('express');
const fs = require('fs');

function createServer({ outputCsvPath, getLastRun }) {
  const app = express();

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.get('/fixtures.csv', (req, res) => {
    if (!fs.existsSync(outputCsvPath)) {
      return res.status(404).send('No CSV generated yet — pipeline has not completed a run.');
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="fixtures.csv"');
    fs.createReadStream(outputCsvPath).pipe(res);
  });

  app.get('/fixtures.json', (req, res) => {
    const rows = getLastRun();
    if (!rows) return res.status(404).json({ error: 'No data yet — pipeline has not completed a run.' });
    res.json(rows);
  });

  return app;
}

module.exports = { createServer };
