// Air Spec watchdog: keeps the conversion queue moving without anyone pressing Start.
//
// The routine is days of work (thousands of clips, one at a time) and it stops for
// ordinary reasons: a run finishes, the app restarts, somebody stops it to free the
// share. Left alone the queue then sits idle for days (2026-11-09: 3,427 pending,
// nothing running). Every `intervalMinutes` the watchdog:
//
//   1. converting/scanning → nothing to do (ffmpeg's own per-file timeout already
//      kills a stuck encode, see transcodeConfig().perFileTimeoutMinutes);
//   2. idle with clips `pending` → startConvert() with the operator's settings;
//   3. idle, nothing pending, last scan older than `rescanHours` → an incremental
//      startScan() so clips catalogued since then get judged (unchanged files cost
//      a stat, never an ffprobe);
//   4. new `failed` clips since the last alert ≥ `failAlertThreshold` → one e-mail
//      to the monitor's recipients (and a log line either way).
//
// An operator Stop in the Air Spec tab holds the watchdog for `holdAfterStopHours`,
// so "stop" means stop, not "stop for ten minutes". `enabled: false` turns it off.
// `hours: [from, to]` (local, 0-24) optionally confines restarts to a window, for a
// share that must be quiet during the day; a run already going is never stopped.

import { loadConfig, updateConfig } from '../config.js';
import { db } from '../db.js';
import { log } from '../logger.js';
import { getState, startConvert, startScan } from './transcode.js';
import { sendMail } from './mailer.js';

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 10,
  rescanHours: 24,
  failAlertThreshold: 5,
  holdAfterStopHours: 6,
  hours: null,
};

const state = {
  timer: null,
  lastTickAt: null,
  lastAction: null,
  lastActionAt: null,
  lastError: null,
  heldUntil: null,
  lastScanAt: null,
  failedSeen: null,
  lastAlertAt: null,
};

export function watchdogConfig() {
  const c = loadConfig().transcode?.watchdog || {};
  const out = { ...DEFAULTS, ...c };
  out.enabled = out.enabled !== false;
  out.intervalMinutes = Math.max(1, Number(out.intervalMinutes) || DEFAULTS.intervalMinutes);
  out.rescanHours = Math.max(0, Number(out.rescanHours ?? DEFAULTS.rescanHours));
  out.failAlertThreshold = Math.max(1, Number(out.failAlertThreshold) || DEFAULTS.failAlertThreshold);
  out.holdAfterStopHours = Math.max(0, Number(out.holdAfterStopHours ?? DEFAULTS.holdAfterStopHours));
  out.hours = Array.isArray(out.hours) && out.hours.length === 2 ? out.hours.map(Number) : null;
  return out;
}

/** Persist enabled / interval / thresholds; returns the config as it now resolves. */
export function setWatchdogConfig(patch = {}) {
  const allowed = ['enabled', 'intervalMinutes', 'rescanHours', 'failAlertThreshold', 'holdAfterStopHours', 'hours'];
  updateConfig((cfg) => {
    cfg.transcode ||= {};
    cfg.transcode.watchdog ||= {};
    for (const k of allowed) if (k in patch) cfg.transcode.watchdog[k] = patch[k];
  });
  if ('enabled' in patch && patch.enabled) state.heldUntil = null;
  reschedule();
  return watchdogConfig();
}

/** Called by the Stop button: the operator wants it quiet for a while. */
export function noteManualStop(now = Date.now()) {
  const { holdAfterStopHours } = watchdogConfig();
  state.heldUntil = holdAfterStopHours ? new Date(now + holdAfterStopHours * 3_600_000).toISOString() : null;
  if (state.heldUntil) log('watchdog').info(`operator stopped Air Spec — watchdog holds until ${state.heldUntil}`);
}

/** Clear an operator hold (Start pressed by hand, or the switch turned back on). */
export function clearHold() { state.heldUntil = null; }

export function inWindow(hours, date = new Date()) {
  if (!hours) return true;
  const [from, to] = hours;
  const h = date.getHours() + date.getMinutes() / 60;
  return from <= to ? h >= from && h < to : h >= from || h < to; // window may cross midnight
}

function failedCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM TranscodeItem WHERE status = 'failed'").get().n;
}

function lastProbeAt() {
  const r = db.prepare('SELECT MAX(probed_at) AS t FROM TranscodeItem').get();
  return r?.t ? Date.parse(r.t) : null;
}

function act(action) {
  state.lastAction = action;
  state.lastActionAt = new Date().toISOString();
  log('watchdog').info(action);
}

/** One pass. Exported so tests (and POST /watchdog/tick) can drive it directly. */
export async function tick({ now = new Date(), mail = sendMail } = {}) {
  const cfg = watchdogConfig();
  state.lastTickAt = now.toISOString();
  state.lastError = null;
  try {
    // Failure alerts run even when restarts are held or off: they are news either way.
    const failed = failedCount();
    if (state.failedSeen == null) state.failedSeen = failed;
    const fresh = failed - state.failedSeen;
    if (fresh >= cfg.failAlertThreshold) {
      const rows = db.prepare(`SELECT file_path, error FROM TranscodeItem WHERE status = 'failed'
        ORDER BY finished_at DESC LIMIT ?`).all(Math.min(fresh, 20));
      const text = `${fresh} clip(s) failed conversion since the last alert (${failed} failed in total).\n\n`
        + rows.map((r) => `• ${r.file_path}\n  ${String(r.error || '').slice(0, 300)}`).join('\n')
        + '\n\nAir Spec tab → filter "failed" to retry or skip them.';
      log('watchdog').warn(`${fresh} new failed conversion(s)`);
      try {
        await mail({ subject: `[Automator] ${fresh} clips failed conversion`, text });
        state.lastAlertAt = now.toISOString();
      } catch (err) {
        log('watchdog').warn(`failure alert not e-mailed: ${err.message}`);
      }
      state.failedSeen = failed;
    } else if (fresh < 0) {
      state.failedSeen = failed; // retried/skipped by hand
    }

    if (!cfg.enabled) return { action: 'disabled' };
    if (state.heldUntil && Date.parse(state.heldUntil) > now.getTime()) return { action: 'held', until: state.heldUntil };
    state.heldUntil = null;

    const s = getState();
    if (s.phase !== 'idle') return { action: 'busy', phase: s.phase };
    if (!inWindow(cfg.hours, now)) return { action: 'outside-hours' };

    if ((s.counts.pending || 0) > 0) {
      const r = startConvert({});
      act(`restarted conversion: ${r.total} clip(s) queued`);
      return { action: 'convert', total: r.total };
    }

    const last = state.lastScanAt ? Date.parse(state.lastScanAt) : lastProbeAt();
    if (cfg.rescanHours && (!last || now.getTime() - last > cfg.rescanHours * 3_600_000)) {
      startScan({});
      state.lastScanAt = now.toISOString();
      act('nothing queued — started an incremental scan for newly catalogued clips');
      return { action: 'scan' };
    }
    return { action: 'idle-nothing-to-do' };
  } catch (err) {
    state.lastError = String(err.message || err);
    log('watchdog').warn(`tick failed: ${state.lastError}`);
    return { action: 'error', error: state.lastError };
  }
}

export function watchdogState() {
  return {
    config: watchdogConfig(),
    running: !!state.timer,
    lastTickAt: state.lastTickAt,
    lastAction: state.lastAction,
    lastActionAt: state.lastActionAt,
    lastError: state.lastError,
    heldUntil: state.heldUntil,
    lastAlertAt: state.lastAlertAt,
  };
}

function reschedule() {
  if (state.timer) clearInterval(state.timer);
  const { intervalMinutes } = watchdogConfig();
  state.timer = setInterval(() => { tick().catch(() => {}); }, intervalMinutes * 60_000);
  state.timer.unref?.();
}

/** Started from app.js after listen; first pass a minute later, once the app has settled. */
export function startTranscodeWatchdog() {
  reschedule();
  const first = setTimeout(() => { tick().catch(() => {}); }, 60_000);
  first.unref?.();
  log('watchdog').info(`Air Spec watchdog on (every ${watchdogConfig().intervalMinutes} min)`);
}

export function stopTranscodeWatchdog() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}
