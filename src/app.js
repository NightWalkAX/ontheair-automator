// The application itself: routes, schema init, cron. Started by server.js,
// which installs logging before this module is even imported.
//
// Serves the static admin UI from ./public, mounts the JSON API, initialises
// the SQLite schema, and starts the weekly draft-generation cron. Single
// process, no build step — copy the folder to a Mac and run.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { requestLogger, log, logPath, tailLog } from './logger.js';
import { initSchema } from './db.js';
import { runPendingMigrations } from './migrations/index.js';
import { loadConfig } from './config.js';
import { startWeeklyDraftCron } from './cron/weeklyDraft.js';

import { router as channels } from './routes/channels.js';
import { router as series } from './routes/series.js';
import { router as showtypes } from './routes/showtypes.js';
import { router as resources } from './routes/resources.js';
import { router as catalog } from './routes/catalog.js';
import { router as media } from './routes/media.js';
import { router as blocks } from './routes/blocks.js';
import { router as otav } from './routes/otav.js';
import { router as transcode } from './routes/transcode.js';
import { router as monitor } from './routes/monitor.js';
import { resetStaleRunning } from './services/transcode.js';
import { startMonitor } from './services/signalMonitor.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

initSchema();
// One-off data repairs for rows earlier bugs wrote. Each runs at most once,
// recorded in data/.migrations.lock — see src/migrations/index.js. They run
// BEFORE the routes are mounted, so nothing serves a half-repaired catalogue.
runPendingMigrations();
// A conversion killed mid-clip left a 'running' row and an incomplete work
// file; the original was never touched, so the clip just goes back in the queue.
resetStaleRunning();

const app = express();
app.use(requestLogger());
app.use(express.json());

app.use('/api/channels', channels);
app.use('/api/channels', series); // /:id/series* endpoints
app.use('/api/showtypes', showtypes);
app.use('/api/resources', resources);
app.use('/api/catalog', catalog);
app.use('/api/media', media);
app.use('/api/blocks', blocks);
app.use('/api/otav', otav);
app.use('/api/transcode', transcode);
app.use('/api/monitor', monitor);

app.get('/api/health', (req, res) => res.json({
  ok: true, time: new Date().toISOString(), pid: process.pid,
  uptimeSeconds: Math.round(process.uptime()),
  rssMB: Math.round(process.memoryUsage().rss / 1048576),
  log: logPath(),
}));

// GET /api/log?lines=200 — the tail of the log as plain text. The playout Macs
// are not machines anybody wants to open a terminal on to answer "what
// happened", so the evidence is reachable from the same browser as the UI.
app.get('/api/log', (req, res) => {
  const lines = Math.min(5000, Math.max(1, Number(req.query.lines) || 200));
  res.type('text/plain').send(tailLog(lines));
});

// Static frontend (served last so /api/* wins).
app.use(express.static(join(ROOT, 'public')));

const { server } = loadConfig();
const PORT = server?.port || 8090;

const httpServer = app.listen(PORT, () => {
  log('app').info(`listening on http://localhost:${PORT} · log ${logPath()}`);
  startWeeklyDraftCron();
  // Public-feed black/no-signal watcher; off unless monitor.enabled is set.
  try { startMonitor(); } catch (err) { log('monitor').error('signal monitor did not start', err); }
});
// A port already taken is the classic "it didn't start and I don't know why".
httpServer.on('error', (err) => {
  log('app').error(`could not listen on port ${PORT}`, err);
  process.exit(1);
});
