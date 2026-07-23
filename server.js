// Entrypoint. Start with: node server.js
//
// Serves the static admin UI from ./public, mounts the JSON API, initialises
// the SQLite schema, and starts the weekly draft-generation cron. Single
// process, no build step — copy the folder to a Mac and run.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { initSchema } from './src/db.js';
import { loadConfig } from './src/config.js';
import { startWeeklyDraftCron } from './src/cron/weeklyDraft.js';

import { router as channels } from './src/routes/channels.js';
import { router as showtypes } from './src/routes/showtypes.js';
import { router as resources } from './src/routes/resources.js';
import { router as media } from './src/routes/media.js';
import { router as blocks } from './src/routes/blocks.js';
import { router as otav } from './src/routes/otav.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

initSchema();

const app = express();
app.use(express.json());

app.use('/api/channels', channels);
app.use('/api/showtypes', showtypes);
app.use('/api/resources', resources);
app.use('/api/media', media);
app.use('/api/blocks', blocks);
app.use('/api/otav', otav);

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Static frontend (served last so /api/* wins).
app.use(express.static(join(__dirname, 'public')));

const { server } = loadConfig();
const PORT = server?.port || 8090;

app.listen(PORT, () => {
  console.log(`ontheair-automator listening on http://localhost:${PORT}`);
  startWeeklyDraftCron();
});
