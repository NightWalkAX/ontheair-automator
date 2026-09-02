// Media normalisation routes ("Convert to Air Spec" tab).
//
// The work itself is a long-running background routine (hours to days), so every
// POST here returns as soon as the run is accepted; the browser follows along on
// GET /api/transcode/events (SSE) and can re-derive the whole picture from
// GET /api/transcode/status after a reload or a server restart.

import { Router } from 'express';
import {
  startScan, startConvert, requestStop, abortNow, getState, listItems, itemCounts,
  replaceItem, replacePending, requeue, skip, transcodeConfig, REASON_LABELS, subscribe,
} from '../services/transcode.js';

export const router = Router();

const num = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};

// GET /api/transcode/status — live state + queue counts + the target spec.
router.get('/status', (req, res) => {
  res.json({ ok: true, ...getState(), reasonLabels: REASON_LABELS });
});

// GET /api/transcode/config — the house spec and where work/originals go, so the
// operator can see what a run will do before starting one.
router.get('/config', (req, res) => {
  const c = transcodeConfig();
  res.json({
    ok: true,
    target: c.target,
    workDir: c.workDir,
    archiveDir: c.archiveDir,
    concurrency: c.concurrency,
    autoReplace: c.autoReplace,
    order: c.order,
    perFileTimeoutMinutes: c.perFileTimeoutMinutes,
    exportedDays: c.exportedDays,
  });
});

// GET /api/transcode/items?status=&channel=&limit=&offset=
router.get('/items', (req, res) => {
  res.json({
    ok: true,
    counts: itemCounts(),
    items: listItems({
      status: req.query.status ? String(req.query.status) : null,
      channelId: num(req.query.channel),
      limit: Number(req.query.limit) || 300,
      offset: Number(req.query.offset) || 0,
    }),
  });
});

// POST /api/transcode/scan?channel=&showType=&fillers=0 — ffprobe every
// catalogued file and record which ones are off spec.
router.post('/scan', (req, res) => {
  const q = { ...req.body, ...req.query };
  try {
    const r = startScan({
      channelId: num(q.channel),
      showTypeId: num(q.showType),
      includeFillers: String(q.fillers ?? '1') !== '0',
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(409).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/transcode/start?channel=&limit=&replace=0 — begin converting the
// queue. `replace=0` leaves converted files staged instead of swapping them in.
router.post('/start', (req, res) => {
  const q = { ...req.body, ...req.query };
  try {
    const r = startConvert({
      channelId: num(q.channel),
      limit: num(q.limit),
      replace: q.replace == null ? null : String(q.replace) !== '0',
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(409).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/transcode/stop[?now=1] — stop after the clip in flight, or kill
// ffmpeg immediately (the half-written work file is discarded either way).
router.post('/stop', (req, res) => {
  const hard = String(req.query.now ?? req.body?.now ?? '') === '1';
  const stopped = hard ? abortNow() : requestStop();
  res.json({ ok: true, stopped, hard });
});

// POST /api/transcode/items/:id/replace[?force=1] — swap one converted clip in.
router.post('/items/:id/replace', async (req, res) => {
  try {
    const out = await replaceItem(Number(req.params.id), {
      force: String(req.query.force ?? '') === '1',
    });
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/transcode/replace-pending[?force=1] — swap in everything waiting.
router.post('/replace-pending', async (req, res) => {
  const results = await replacePending({ force: String(req.query.force ?? '') === '1' });
  res.json({
    ok: true,
    replaced: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok),
  });
});

// POST /api/transcode/items/:id/retry — put a failed/blocked clip back in the queue.
router.post('/items/:id/retry', (req, res) => {
  try {
    res.json(requeue(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/transcode/items/:id/skip — leave a clip as it is, forever.
router.post('/items/:id/skip', (req, res) => {
  try {
    res.json(skip(Number(req.params.id)));
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

// GET /api/transcode/events — SSE: phase changes, per-clip progress, log lines.
router.get('/events', (req, res) => subscribe(res));
