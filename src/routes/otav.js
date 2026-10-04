// OTAV push routes (Module C trigger).

import { Router } from 'express';
import {
  pushApprovedBlocks, pushApprovedRange, checkChannel, diagnoseChannel, isPushRunning,
} from '../services/otavClient.js';
import { cancelJob, finishJob, getJob, startJob, subscribe } from '../services/pushProgress.js';
import { missingFilesInRange, unfitBlocksInRange } from '../services/blockValidation.js';
import { addDays, localDate } from '../dates.js';
import { blockingProblems, checkRange } from '../services/dayCoverage.js';
import { db } from '../db.js';
import { loadConfig } from '../config.js';
import {
  analogChannel, filesForRange, isAnalogPushRunning, isConfigured, planFiles, pushAnalogDays,
  analogWindow, AnalogClient,
} from '../services/analogClient.js';

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
  if (isPushRunning() || isAnalogPushRunning()) {
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
    // The analog channel rides the same push but not the same pusher: OTAV
    // channels go to pushApprovedRange (which skips it), the analog one to
    // pushAnalogDays. Selected explicitly, or — with no selection — when active.
    const analog = analogChannel();
    const analogWanted = !!analog && (channelIds.length ? channelIds.includes(analog.id) : !!analog.is_active);
    const otavIds = analog ? channelIds.filter((id) => id !== analog.id) : channelIds;
    const otavWanted = !channelIds.length || otavIds.length > 0;
    // Files on the share matter only to the OTAV channels; the analog device
    // plays its own copies, checked below against its disk.
    const shareIds = otavIds.length ? otavIds : db.prepare(
      "SELECT id FROM ChannelType WHERE COALESCE(playout, 'otav') != 'analog'",
    ).all().map((r) => r.id);
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
      if (otavWanted && shareIds.length && loadConfig().otav?.verifyFilesBeforePush !== false) {
        const missing = (await missingFilesInRange(range[0], range[1], shareIds))
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

    // A clip that is not on the analog device can't be scheduled there at all.
    // Checked here so the operator gets the list (and an upload button) before
    // anything is pushed. An unreachable device doesn't stop the OTAV push: the
    // analog row of the report says what failed.
    let analogDates = [];
    if (range && analogWanted) {
      const all = [];
      for (let d = range[0]; d <= range[1]; d = addDays(d, 1)) all.push(d);
      analogDates = all.filter((d) => !excludeDates.includes(d));
      if (isConfigured(analog)) {
        const { pushable } = analogWindow(analog.id, analogDates, { includeToday });
        const paths = [...new Set(pushable.flatMap((d) => filesForRange(analog.id, d, d, ['approved', 'exported'])
          .map((f) => f.file_path)))];
        const plan = paths.length ? await planFiles(new AnalogClient(analog), paths).catch(() => null) : [];
        const absent = (plan || []).filter((p) => p.state === 'missing' || p.state === 'unsupported');
        if (absent.length) {
          return res.status(409).json({
            ok: false,
            analogMissing: absent,
            range: { from: pushable[0], to: pushable[pushable.length - 1] },
            error: `${absent.length} file(s) are not on the ${analog.name} device yet — upload them first (Analog tab), then push again`,
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
    if (DATE.test(from) && DATE.test(to) && to < from) {
      if (job) finishJob(job.id, { ok: false, error: 'to must not precede from' });
      return res.status(400).json({ error: 'to must not precede from' });
    }
    if (otavIds.length) opts.channelIds = otavIds;
    else delete opts.channelIds;
    // Analog after OTAV, so a slow device upload of the schedule never delays
    // six channels; both report into the same job and the same push report.
    const withAnalog = async (r) => {
      if (!analogWanted) return r;
      const a = await runAnalog(analog, analogDates, { progress: job || undefined, includeToday });
      r.channels = [...(r.channels || []), ...a.rows];
      if (r.days) {
        for (const row of a.rows.filter((x) => x.date)) {
          let day = r.days.find((d) => d.targetDate === row.date);
          if (!day) r.days.push(day = { targetDate: row.date, channels: [] });
          day.channels.push(row);
        }
        r.days.sort((x, y) => x.targetDate.localeCompare(y.targetDate));
        const pushed = new Set(r.days.map((d) => d.targetDate));
        if (r.skipped) r.skipped = r.skipped.filter((d) => !pushed.has(d));
      }
      r.analog = { held: a.held, backup: a.backup, missing: a.missing || null };
      return r;
    };
    const empty = (extra) => ({ channels: [], aborted: null, ...extra });
    if (DATE.test(week) || (DATE.test(from) && DATE.test(to))) {
      const [a, b] = range;
      const r = otavWanted ? await pushApprovedRange(a, b, opts)
        : empty({ from: a, to: b, days: [], held: excludeDates.filter((d) => d >= a && d <= b), skipped: [] });
      return res.json(send({ ok: true, ...(await withAnalog(r)) }));
    }
    if (DATE.test(date)) {
      const r = otavWanted ? await pushApprovedBlocks(date, opts) : empty({ targetDate: date });
      return res.json(send({ ok: true, ...(await withAnalog(r)) }));
    }
    if (job) finishJob(job.id, { ok: false, error: 'missing date/week/range' });
    return res.status(400).json({ error: 'date=YYYY-MM-DD, week=YYYY-MM-DD, or from=&to= is required' });
  } catch (err) {
    const error = String(err.message || err);
    if (job) finishJob(job.id, { ok: false, error });
    res.status(500).json({ ok: false, error });
  }
});

/** Push the analog channel's days, as push-report rows. Never throws. */
async function runAnalog(analog, dates, { progress, includeToday }) {
  try {
    const r = await pushAnalogDays(dates, { ...(progress ? { progress } : {}), includeToday });
    return { rows: r.days.map((d) => ({ ...d.result, date: d.date })), held: r.held, backup: r.backup };
  } catch (err) {
    return { rows: [{ channel: analog.name, ok: false, error: String(err.message || err) }], held: [], missing: err.missing };
  }
}

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
