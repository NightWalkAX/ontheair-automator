// OTAV push routes (Module C trigger).

import { Router } from 'express';
import {
  pushApprovedBlocks, pushApprovedRange, checkChannel, diagnoseChannel, isPushRunning,
} from '../services/otavClient.js';
import { cancelJob, finishJob, getJob, startJob, subscribe } from '../services/pushProgress.js';
import { loadConfig } from '../config.js';

export const router = Router();

// POST /api/otav/push — "Push to Air". One day (?date=), a week starting at a
// date (?week=, 7 days), or an explicit range (?from=&to=). A template that
// repeats on several weekdays needs every one of those dates pushed: each date
// gets its own playlist and its own schedule event.
//
// Progress: pass ?job=<id> and the run reports every step to that job, which
// the UI watches over GET /api/otav/push/events?job=<id> (SSE). A week push is
// thousands of sequential REST calls, so a plain spinner can't tell the
// operator whether it is working or wedged.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const JOB_ID = /^[A-Za-z0-9_-]{6,64}$/;
router.post('/push', async (req, res) => {
  const q = { ...req.body, ...req.query };
  const date = String(q.date || '').slice(0, 10);
  const week = String(q.week || '').slice(0, 10);
  const from = String(q.from || '').slice(0, 10);
  const to = String(q.to || '').slice(0, 10);
  const jobId = String(q.job || '');

  // Second click while one is running: refuse instead of queueing behind a
  // 10-minute run, which the browser can only show as another dead spinner.
  if (isPushRunning()) {
    return res.status(409).json({ ok: false, error: 'a push is already running — watch or cancel that one first' });
  }

  const deadlineMs = Math.max(60, Number(loadConfig().otav?.pushTimeoutSeconds) || 900) * 1000;
  const job = JOB_ID.test(jobId) ? startJob(jobId, { deadlineMs, label: week || date || `${from}..${to}` }) : null;
  const progress = job || undefined;
  const opts = progress ? { progress } : {};
  const send = (payload) => {
    if (job) finishJob(job.id, { ok: payload.ok !== false, summary: payload, error: payload.error || null });
    return payload;
  };
  try {
    if (DATE.test(week)) {
      const end = new Date(`${week}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      const r = await pushApprovedRange(week, end.toISOString().slice(0, 10), opts);
      return res.json(send({ ok: true, ...r }));
    }
    if (DATE.test(from) && DATE.test(to)) {
      if (to < from) {
        if (job) finishJob(job.id, { ok: false, error: 'to must not precede from' });
        return res.status(400).json({ error: 'to must not precede from' });
      }
      return res.json(send({ ok: true, ...(await pushApprovedRange(from, to, opts)) }));
    }
    if (DATE.test(date)) {
      return res.json(send({ ok: true, ...(await pushApprovedBlocks(date, opts)) }));
    }
    if (job) finishJob(job.id, { ok: false, error: 'missing date/week/range' });
    return res.status(400).json({ error: 'date=YYYY-MM-DD, week=YYYY-MM-DD, or from=&to= is required' });
  } catch (err) {
    const error = String(err.message || err);
    if (job) finishJob(job.id, { ok: false, error });
    res.status(500).json({ ok: false, error });
  }
});

// GET /api/otav/push/events?job=<id>[&after=<seq>] — SSE stream of push steps.
// Events already recorded are replayed first, so the browser may attach at any
// point (including after the POST started) without missing anything.
router.get('/push/events', (req, res) => {
  subscribe(String(req.query.job || ''), res, { after: Number(req.query.after) || 0 });
});

// POST /api/otav/push/cancel?job=<id> — stop the run at the next clip boundary.
router.post('/push/cancel', (req, res) => {
  const id = String(req.query.job || req.body?.job || '');
  res.json({ ok: cancelJob(id), running: isPushRunning() });
});

// GET /api/otav/push/status — is anything pushing right now, and how far along?
router.get('/push/status', (req, res) => {
  const job = getJob(String(req.query.job || ''));
  res.json({
    ok: true,
    running: isPushRunning(),
    job: job && {
      id: job.id, startedAt: job.startedAt, deadlineAt: job.deadlineAt,
      finished: job.finished, cancelled: job.cancelled, events: job.events.length,
      summary: job.summary,
    },
  });
});

// GET /api/otav/diagnose/:channelId?date=YYYY-MM-DD — read-only probe of what
// that OTAV instance supports (version, scheduler, open playlists, schedule
// folder) plus the playlist name a push for that date would target.
// With ?probe_create=1 it also tries every candidate playlist-creation route
// against the live instance (this one writes) and reports what each answered.
router.get('/diagnose/:channelId', async (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const probeCreate = req.query.probe_create === '1';
  try {
    res.json({ ok: true, ...(await diagnoseChannel(Number(req.params.channelId), date, { probeCreate })) });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});

// GET /api/otav/check/:channelId — connectivity/auth probe against /info.
router.get('/check/:channelId', async (req, res) => {
  try {
    const info = await checkChannel(Number(req.params.channelId));
    res.json({ ok: true, info });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});
