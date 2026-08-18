// Live progress for a "Push to Air" run.
//
// A week push is 6 instances x 7 days x ~80 clips of strictly sequential REST
// calls — minutes of work behind one HTTP request. Without a channel back to
// the browser the operator sees a spinner and cannot tell a slow push from a
// stuck one, so every push run gets a job here: steps are recorded as they
// happen, streamed to the UI over SSE, and bounded by a deadline plus an
// operator cancel so a run can never spin forever.

const jobs = new Map();

const KEEP_FINISHED_MS = 10 * 60_000;   // report stays fetchable after the run
const MAX_EVENTS = 4000;                // ring cap: a week push is ~3.4k clips

/** No-op sink, so the push code can run without a job (cron, tests). */
export const NULL_PROGRESS = {
  id: null,
  emit() {},
  guard() {},
  get cancelled() { return false; },
};

/**
 * Register a push job. `deadlineMs` bounds the WHOLE run: guard() throws once
 * it passes, which unwinds the push with a real error instead of leaving the
 * operator watching a spinner.
 */
export function startJob(id, { deadlineMs = 15 * 60_000, label = '' } = {}) {
  const now = Date.now();
  const job = {
    id,
    label,
    startedAt: now,
    deadlineAt: now + deadlineMs,
    events: [],
    subs: new Set(),
    cancelled: false,
    finished: false,
    summary: null,
    seq: 0,
    emit(event) { push(job, event); },
    guard() {
      if (job.cancelled) {
        const err = new Error('push cancelled by operator');
        err.cancelled = true;
        throw err;
      }
      if (Date.now() > job.deadlineAt) {
        const err = new Error(
          `push deadline of ${Math.round(deadlineMs / 1000)}s exceeded — stopped instead of running on. `
          + 'Check that every OTAV instance is reachable, then push the remaining days again.',
        );
        err.timedOut = true;
        throw err;
      }
    },
  };
  jobs.set(id, job);
  sweep();
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }

/** Ask a running job to stop at its next safe point. */
export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || job.finished) return false;
  job.cancelled = true;
  push(job, { type: 'cancelling', message: 'cancel requested — finishing the current clip' });
  return true;
}

/** Record the outcome and close every stream watching this job. */
export function finishJob(id, { ok, summary, error }) {
  const job = jobs.get(id);
  if (!job) return;
  job.finished = true;
  job.finishedAt = Date.now();
  job.summary = summary ?? null;
  push(job, { type: 'done', ok, error: error || null, summary: summary ?? null });
  for (const res of job.subs) res.end();
  job.subs.clear();
}

function push(job, event) {
  const ev = { seq: ++job.seq, at: Date.now(), elapsedMs: Date.now() - job.startedAt, ...event };
  job.events.push(ev);
  if (job.events.length > MAX_EVENTS) job.events.splice(0, job.events.length - MAX_EVENTS);
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of job.subs) res.write(frame);
}

/**
 * Attach an SSE response to a job. Events already recorded are replayed first,
 * so the browser can open the stream after (or during) the POST without losing
 * the early steps — no ordering dance between the two requests.
 */
export function subscribe(id, res, { after = 0 } = {}) {
  const job = jobs.get(id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (!job) {
    res.write(`data: ${JSON.stringify({ type: 'unknown-job', id })}\n\n`);
    return res.end();
  }
  for (const ev of job.events) if (ev.seq > after) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  if (job.finished) return res.end();
  job.subs.add(res);
  // Comment frames keep proxies and the browser from calling an idle stream
  // dead while one slow OTAV call is in flight.
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => { clearInterval(ping); job.subs.delete(res); });
  return undefined;
}

function sweep() {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) {
    if (job.finished && job.finishedAt < cutoff && job.subs.size === 0) jobs.delete(id);
  }
}
