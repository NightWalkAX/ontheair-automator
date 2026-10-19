// Clips that played badly (services/playbackFaults.js): the list the Signal
// Monitor tab shows, the operator's decision on each file, and a manual read of
// the analog device's logs.

import { Router } from 'express';
import { listFlags, faultsFor, setFlags, syncAnalogFaults, STATUSES } from '../services/playbackFaults.js';

export const router = Router();

const PLAYOUTS = ['otav', 'analog'];

// GET /api/faults?status=&playout= — every flagged file, suspects first.
router.get('/', (req, res) => {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const playout = PLAYOUTS.includes(req.query.playout) ? req.query.playout : null;
  res.json({ ok: true, flags: listFlags({ status, playout }) });
});

// GET /api/faults/file?path=&playout= — the faults behind one file.
router.get('/file', (req, res) => {
  const path = String(req.query.path || '');
  if (!path) return res.status(400).json({ error: 'path is required' });
  const playout = PLAYOUTS.includes(req.query.playout) ? req.query.playout : null;
  res.json({ ok: true, faults: faultsFor(path, playout) });
});

// PUT /api/faults { paths: [], playout, status: suspect|confirmed|dismissed|clear, note? }
router.put('/', (req, res) => {
  const paths = Array.isArray(req.body?.paths) ? req.body.paths.map(String).filter(Boolean) : [];
  const { playout, status } = req.body || {};
  if (!paths.length) return res.status(400).json({ error: 'paths[] is required' });
  if (!PLAYOUTS.includes(playout)) return res.status(400).json({ error: 'playout must be otav or analog' });
  if (status !== 'clear' && !STATUSES.includes(status)) return res.status(400).json({ error: 'unknown status' });
  const note = typeof req.body.note === 'string' && req.body.note.trim() ? req.body.note.trim().slice(0, 300) : undefined;
  res.json({ ok: true, changed: setFlags(paths, playout, status, note) });
});

// POST /api/faults/sync-analog — read the analog as-run and recoveries now.
router.post('/sync-analog', async (req, res) => {
  try {
    res.json(await syncAnalogFaults());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
