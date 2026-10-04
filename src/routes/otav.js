// OTAV push routes (Module C trigger).

import { Router } from 'express';
import {
  pushApprovedBlocks, pushApprovedRange, checkChannel, diagnoseChannel, isPushRunning,
} from '../services/otavClient.js';
import { cancelJob, finishJob, getJob, startJob, subscribe } from '../services/pushProgress.js';
import { missingFilesInRange, unfitBlocksInRange } from '../services/blockValidation.js';
import { localDate } from '../dates.js';
import { blockingProblems, checkRange } from '../services/dayCoverage.js';
import { db } from '../db.js';
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
  // ?channels=1,3 (or a JSON array in the body) restricts the run to those OTAV
  // instances — the operator picks them in the push dialog. Absent = all.
  const channelIds = [...new Set((Array.isArray(q.channels) ? q.channels
    : String(q.channels ?? '').split(','))
    .map((v) => Number(String(v).trim()))
    .filter((n) => Number.isInteger(n) && n > 0))];

  // Second click while one is running: refuse instead of queueing behind a
  // 10-minute run, which the browser can only show as another dead spinner.
  if (isPushRunning()) {
    return res.status(409).json({ ok: false, error: 'a push is already running — watch or cancel that one first' });
  }

  // Everything from here on can throw (an unreadable config.json, a locked
  // database). Express 4 does not catch a rejected async handler, so a throw
  // outside this try left the request with no answer at all — the browser's
  // push dialog (and the test suite) waited on it forever.
  let job = null;
  try {
    // Nothing that no longer validates reaches air. The range is re-checked HERE,
    // before the job starts and before OTAV is touched, so the operator gets one
    // list of what to fix instead of a half-pushed week.
    const range = DATE.test(week)
      ? [week, (() => { const e = new Date(`${week}T00:00:00Z`); e.setUTCDate(e.getUTCDate() + 6); return e.toISOString().slice(0, 10); })()]
      : DATE.test(from) && DATE.test(to) ? [from, to]
      : DATE.test(date) ? [date, date]
      : null;
    // TODAY is on air. A push clears and refills the day's playlist and then
    // resynchronises the scheduler, which cuts air for a few seconds every time
    // (seen at 14:04, 14:05 and 20:44 on the production logs). So today is only
    // pushed when the operator says so: a single-day push of today needs
    // ?includeToday=1, and a week/range push skips it unless told otherwise.
    const today = localDate();
    const includeToday = ['1', 'true', 'yes'].includes(String(q.includeToday ?? '').toLowerCase());
    if (DATE.test(date) && !DATE.test(week) && date === today && !includeToday) {
      return res.status(409).json({
        ok: false,
        needsConfirm: 'today',
        error: `${today} is on air right now — pushing it rebuilds the playing playlist and cuts air for a few seconds. Confirm to push it anyway.`,
      });
    }
    const excludeDates = includeToday ? [] : [today];
    if (range) {
      // A held-back day is not going out, so it is not judged either.
      const unfit = unfitBlocksInRange(range[0], range[1], channelIds)
        .filter((b) => !excludeDates.includes(b.target_date));
      if (unfit.length) {
        return res.status(409).json({
          ok: false,
          error: `${unfit.length} block(s) in this range cannot go to air — fix them first`,
          blocks: unfit,
        });
      }
      // A day that would end before the next day's event — a block left in
      // draft, a template conflict, uncovered time — is black on air. The check
      // simulates exactly what this push sends. ?allowGaps=1 is the operator's
      // "push it anyway" after reading the list. Only instances this push can
      // reach are judged: a channel with no OTAV address has nothing to push.
      if (loadConfig().otav?.blockOnGaps !== false && !['1', 'true'].includes(String(q.allowGaps ?? ''))) {
        const pushable = channelIds.length ? channelIds : db.prepare(
          "SELECT id FROM ChannelType WHERE is_active = 1 AND COALESCE(TRIM(api_ip), '') != ''",
        ).all().map((r) => r.id);
        const problems = pushable.length
          ? blockingProblems(await checkRange(range[0], range[1], pushable), { excludeDates })
            .filter((p) => p.kind !== 'unfit' && p.kind !== 'missing-file') // reported above / below
          : [];
        if (problems.length) {
          return res.status(409).json({
            ok: false,
            gaps: true,
            error: `${problems.length} problem(s) would leave black on air — fix them, or push anyway`,
            problems,
          });
        }
      }
      // A clip whose file is gone is skipped by OTAV, the day runs short and the
      // channel goes black before the next day's event. Refuse rather than air it.
      if (loadConfig().otav?.verifyFilesBeforePush !== false) {
        const missing = (await missingFilesInRange(range[0], range[1], channelIds))
          .map((m) => ({ ...m, blocks: m.blocks.filter((b) => !excludeDates.includes(b.target_date)) }))
          .filter((m) => m.blocks.length);
        if (missing.length) {
          return res.status(409).json({
            ok: false,
            error: `${missing.length} scheduled file(s) are not on disk — the day would run short and go black. Replace those clips first.`,
            missing,
          });
        }
      }
    }

    const deadlineMs = Math.max(60, Number(loadConfig().otav?.pushTimeoutSeconds) || 900) * 1000;
    job = JOB_ID.test(jobId) ? startJob(jobId, { deadlineMs, label: week || date || `${from}..${to}` }) : null;
    const progress = job || undefined;
    const opts = { ...(progress ? { progress } : {}), ...(channelIds.length ? { channelIds } : {}), excludeDates };
    const send = (payload) => {
      if (job) finishJob(job.id, { ok: payload.ok !== false, summary: payload, error: payload.error || null });
      return payload;
    };
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
