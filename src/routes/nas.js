// /api/nas — the on-air folder (organize) and the playlist watchdog.
// See src/services/nasLayout.js and src/services/playlistWatch.js.

import express from 'express';
import { db } from '../db.js';
import { planOrganize, runOrganize, organizeState, undoMoves, busyReason, layoutConfig, runSweep, sweepState, rescueGhosts } from '../services/nasLayout.js';
import { dirname, join } from 'node:path';
import { logPath } from '../logger.js';
import { tick, watchState, watchConfig, setWatchConfig } from '../services/playlistWatch.js';

export const router = express.Router();

// ---- playlist watchdog ----
router.get('/watch', (req, res) => {
  const channelId = Number(req.query.channel) || null;
  const date = req.query.date ? String(req.query.date).slice(0, 10) : null;
  if (channelId && date) {
    const day = watchState({ channelId, date });
    return day ? res.json(day) : res.status(404).json({ ok: false, error: 'not checked yet — POST /api/nas/watch/tick' });
  }
  res.json(watchState());
});

router.post('/watch/tick', async (req, res) => {
  const channelIds = req.body?.channels ? [].concat(req.body.channels).map(Number).filter(Boolean) : null;
  res.json(await tick({ channelIds }));
});

router.get('/watch/config', (req, res) => res.json(watchConfig()));
router.put('/watch/config', (req, res) => {
  try { res.json({ ok: true, config: setWatchConfig(req.body || {}) }); } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- organize ----
router.get('/organize/plan', (req, res) => {
  const p = planOrganize();
  const full = req.query.full === '1';
  const limit = full ? Infinity : 30;
  res.json({
    root: p.root,
    files: p.moves.length,
    onAir: p.onAirCount,
    byFolder: p.byFolder,
    roots: p.roots,
    collisions: p.collisions,
    unmapped: p.unmapped.slice(0, limit),
    unmappedCount: p.unmapped.length,
    sample: p.moves.slice(0, limit).map((m) => ({ from: m.from, to: m.to, onAir: m.onAir })),
    busy: busyReason(),
  });
});

router.get('/organize/status', (req, res) => res.json({ ...organizeState(), busy: busyReason(), root: layoutConfig().root }));

router.post('/organize/run', (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm: true is required — this moves files on the share' });
  const busy = busyReason();
  if (busy) return res.status(409).json({ ok: false, error: busy });
  if (organizeState().running) return res.status(409).json({ ok: false, error: 'an organize run is already going' });
  const opts = {
    limit: Number(req.body.limit) > 0 ? Number(req.body.limit) : null,
    only: req.body.only ? String(req.body.only) : null,
    onAirToo: req.body.onAirToo !== false,
  };
  runOrganize(opts).catch(() => {});
  res.status(202).json({ ok: true, started: true, ...opts });
});

router.post('/organize/undo', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm: true is required' });
  try { res.json({ ok: true, ...(await undoMoves({ since: req.body.since })) }); } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

router.get('/moves', (req, res) => {
  const limit = Math.min(1000, Number(req.query.limit) || 100);
  res.json(db.prepare('SELECT * FROM FileMove ORDER BY id DESC LIMIT ?').all(limit));
});

// ---- sweep: duplicates + uncatalogued content ----
router.get('/sweep/status', (req, res) => res.json({ ...sweepState(), busy: busyReason() }));
router.post('/sweep/run', (req, res) => {
  const dryRun = req.body?.dryRun === true;
  if (!dryRun && req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm: true is required — this moves files on the share (or dryRun: true)' });
  const busy = dryRun ? null : busyReason();
  if (busy) return res.status(409).json({ ok: false, error: busy });
  if (sweepState().running || organizeState().running) return res.status(409).json({ ok: false, error: 'an organize/sweep run is already going' });
  const planFile = join(dirname(logPath()), `sweep-plan-${Date.now()}.json`);
  runSweep({ dryRun, planFile, moveLoose: req.body?.moveLoose !== false,
    limit: Number(req.body?.limit) > 0 ? Number(req.body.limit) : null,
    probe: req.body?.probe !== false }).catch(() => {});
  res.status(202).json({ ok: true, started: true, dryRun, planFile: dryRun ? planFile : null });
});

router.post('/rescue', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm: true is required' });
  try { res.json({ ok: true, ...(await rescueGhosts()) }); } catch (err) { res.status(409).json({ ok: false, error: err.message }); }
});
