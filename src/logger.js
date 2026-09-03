// Persistent logging.
//
// This app runs unattended for hours on a Mac an operator does not sit in
// front of: a scan of the share is thousands of ffprobe calls, a transcode run
// is days. When it dies, "it froze" is all anybody can report unless the
// evidence was already on disk. So everything goes to a FILE, not just stdout
// (which is gone the moment the terminal closes, or was never captured because
// the process was started by double-clicking).
//
// Three properties matter more than features here:
//
//   1. Crash-safe writes. Lines go out with writeSync() on a fd opened for
//      append — no stream buffering to lose when the process dies abruptly.
//      A log that omits the last thing that happened is the one thing a crash
//      log must never do.
//   2. Nothing is silent. uncaughtException, unhandledRejection, warnings and
//      the signal that killed us are all recorded before exit.
//   3. It cannot fill the drive. The whole project folder travels on a USB
//      stick, so the log rotates by size and keeps a bounded number of files.
//
// It also carries a blocked-event-loop watchdog, because "the whole thing
// froze" is usually one synchronous call over a slow SMB mount and that is
// invisible in any per-request log.

import { openSync, writeSync, closeSync, statSync, renameSync, mkdirSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Beside the database, so the logs travel with the folder and are covered by
// the same .gitignore. SCHEDULER_LOG_DIR mirrors SCHEDULER_DB for tests.
const LOG_DIR = process.env.SCHEDULER_LOG_DIR || join(__dirname, '..', 'data', 'logs');
const LOG_FILE = join(LOG_DIR, 'automator.log');
const MAX_BYTES = Number(process.env.SCHEDULER_LOG_MAX_BYTES) || 8 * 1024 * 1024;
const KEEP = Number(process.env.SCHEDULER_LOG_KEEP) || 5;

let fd = null;
let written = 0;          // bytes since the last size check
let installed = false;

function openLog() {
  mkdirSync(LOG_DIR, { recursive: true });
  fd = openSync(LOG_FILE, 'a');
  try { written = statSync(LOG_FILE).size; } catch { written = 0; }
}

/** automator.log -> automator.log.1 -> .2 ... dropping the oldest. */
function rotate() {
  try {
    closeSync(fd);
  } catch { /* already gone */ }
  fd = null;
  try {
    const oldest = `${LOG_FILE}.${KEEP}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      if (existsSync(from)) renameSync(from, `${LOG_FILE}.${i + 1}`);
    }
    if (existsSync(LOG_FILE)) renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch { /* a failed rotation must not stop logging */ }
  openLog();
}

const stamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '');

/** One line out, synchronously. Never throws — logging must not break callers. */
function emit(level, scope, message) {
  const line = `${stamp()} ${level.padEnd(5)} [${scope}] ${message}\n`;
  try {
    if (!fd) openLog();
    written += writeSync(fd, line);
    if (written >= MAX_BYTES) rotate();
  } catch { /* disk full, unmounted, read-only: stdout below is the fallback */ }
  // Still echo, so a terminal that IS attached shows it live.
  (level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout).write(line);
}

/** Multi-line values (a stack) get one prefixed line each, so grep still works. */
function format(args) {
  return args.map((a) => {
    if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

/** A logger bound to one scope, e.g. log('scan').info('…'). */
export function log(scope = 'app') {
  const at = (level) => (...args) => {
    const text = format(args);
    for (const part of text.split('\n')) if (part.length) emit(level, scope, part);
  };
  return { info: at('INFO'), warn: at('WARN'), error: at('ERROR'), debug: at('DEBUG') };
}

const sys = log('proc');

/** Where the log is, so the startup banner and the API can name it. */
export const logPath = () => LOG_FILE;

/**
 * Last `lines` lines of the log, for GET /api/log.
 *
 * Reaches back into the rotated files when the live one is short. Rotation
 * happens on the write that crosses the size limit, so the live file is EMPTY
 * for a moment right afterwards — and "right afterwards" is exactly when a long
 * run that just filled the log is the thing somebody needs to read.
 */
export function tailLog(lines = 200) {
  const chunks = [];
  let have = 0;
  for (let i = 0; i <= KEEP && have <= lines; i++) {
    const file = i === 0 ? LOG_FILE : `${LOG_FILE}.${i}`;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if (i === 0 && !chunks.length && err.code !== 'ENOENT') {
        return `could not read ${LOG_FILE}: ${err.message}`;
      }
      continue;   // rotated file absent (or nothing logged yet): keep looking
    }
    const own = text.split('\n').filter((l) => l.length);
    chunks.unshift(own);        // older file goes in front
    have += own.length;
  }
  if (!have) return `nothing logged yet at ${LOG_FILE}`;
  const all = chunks.flat();
  return all.slice(Math.max(0, all.length - lines)).join('\n');
}

/**
 * Watch for a blocked event loop.
 *
 * A timer set for 1s that fires 9s late means something ran synchronously for
 * 8s — a statSync over an SMB mount that went away, a huge JSON serialise, a
 * long SQLite write. That is what "the whole app froze" actually looks like,
 * and no request log shows it because nothing was being served.
 */
function startLoopWatchdog(thresholdMs = 2000) {
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - 1000;
    last = now;
    if (lag >= thresholdMs) {
      sys.warn(`event loop blocked for ${(lag / 1000).toFixed(1)}s — something ran synchronously `
        + `(rss ${Math.round(process.memoryUsage().rss / 1048576)}MB)`);
    }
  }, 1000);
  timer.unref();
}

/**
 * Install file logging, console capture and the crash handlers. Call ONCE, as
 * early as possible — anything that throws before this is invisible.
 */
export function initLogging({ watchdog = true } = {}) {
  if (installed) return { logPath: LOG_FILE };
  installed = true;
  openLog();

  // Route the console calls already in the codebase into the same file rather
  // than making every module import this one.
  const raw = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a) => log('console').info(format(a));
  console.warn = (...a) => log('console').warn(format(a));
  console.error = (...a) => log('console').error(format(a));
  console.debug = (...a) => log('console').debug(format(a));

  sys.info('─'.repeat(60));
  sys.info(`started · pid ${process.pid} · node ${process.version} · ${process.platform} · ${hostname()}`);
  sys.info(`log ${LOG_FILE} (rotates at ${Math.round(MAX_BYTES / 1048576)}MB, keeps ${KEEP})`);
  sys.info(`cwd ${process.cwd()}`);

  // A crash must leave its reason on disk. writeSync means it is already there
  // by the time exit() runs.
  process.on('uncaughtException', (err, origin) => {
    sys.error(`UNCAUGHT EXCEPTION (${origin}) — exiting`, err);
    try { closeSync(fd); } catch { /* ignore */ }
    raw.error(err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    // Not fatal by default in this app: one failed OTAV call must not take the
    // scheduler down. But it is always a bug, so it is always recorded.
    sys.error('UNHANDLED REJECTION', reason instanceof Error ? reason : String(reason));
  });
  process.on('warning', (w) => sys.warn(`node warning: ${w.name}: ${w.message}`));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      sys.info(`${signal} received — shutting down`);
      try { closeSync(fd); } catch { /* ignore */ }
      process.exit(0);
    });
  }
  // An exit nobody asked for (a bare process.exit somewhere, or the loop simply
  // emptying) is worth a line too — otherwise the log just stops mid-sentence.
  process.on('exit', (code) => { if (code !== 0) emit('ERROR', 'proc', `process exiting with code ${code}`); });

  if (watchdog) startLoopWatchdog();
  return { logPath: LOG_FILE };
}

/**
 * Express middleware: one line per request, and a loud one when a request is
 * slow or fails. A scan that never answers shows up here as a request with no
 * completion line at all, which is itself the diagnosis.
 */
export function requestLogger({ slowMs = 10_000 } = {}) {
  const http = log('http');
  return (req, res, next) => {
    // Reading the whole catalogue is normal and constant; logging every poll
    // would bury the run. Mutations and anything slow always get a line.
    const started = Date.now();
    const quiet = req.method === 'GET' && /^\/api\/(transcode\/(status|events|items)|blocks|channels|catalog|media\/status|health)/.test(req.path);
    if (!quiet) http.info(`--> ${req.method} ${req.originalUrl}`);
    res.on('finish', () => {
      const ms = Date.now() - started;
      const line = `<-- ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`;
      if (res.statusCode >= 500) http.error(line);
      else if (ms >= slowMs) http.warn(`${line} (SLOW)`);
      else if (!quiet) http.info(line);
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        http.warn(`xxx ${req.method} ${req.originalUrl} client gave up after ${Date.now() - started}ms`);
      }
    });
    next();
  };
}

/**
 * Progress reporter for a long loop (a scan, a conversion run).
 *
 * Logs at most every `everyMs`, with rate, ETA and RSS — the three numbers that
 * tell you whether a run that "froze" is actually still crawling, and whether
 * it is leaking. Also names any single step that took absurdly long, which over
 * SMB is how a stalled read shows up.
 */
export function progressLogger(scope, total, { everyMs = 15_000, stepWarnMs = 20_000 } = {}) {
  const l = log(scope);
  const startedAt = Date.now();
  let lastReport = 0;
  let done = 0;
  return {
    start(what) { l.info(`start · ${total} item(s)${what ? ` · ${what}` : ''}`); },
    /** Call once per item, with how long that item took. */
    step(label, stepMs) {
      done++;
      if (stepMs != null && stepMs >= stepWarnMs) {
        l.warn(`slow item (${(stepMs / 1000).toFixed(1)}s): ${label}`);
      }
      const now = Date.now();
      if (now - lastReport < everyMs) return;
      lastReport = now;
      const elapsed = (now - startedAt) / 1000;
      const rate = done / Math.max(elapsed, 0.001);
      const left = Math.max(total - done, 0);
      const eta = rate > 0 ? left / rate : 0;
      l.info(`${done}/${total} (${Math.round((done / Math.max(total, 1)) * 100)}%) · `
        + `${rate.toFixed(1)}/s · elapsed ${fmtSecs(elapsed)} · eta ${fmtSecs(eta)} · `
        + `rss ${Math.round(process.memoryUsage().rss / 1048576)}MB · last: ${label}`);
    },
    done(summary) {
      l.info(`done · ${done}/${total} in ${fmtSecs((Date.now() - startedAt) / 1000)}`
        + `${summary ? ` · ${summary}` : ''}`);
    },
    fail(err) { l.error(`aborted after ${done}/${total}`, err); },
  };
}

function fmtSecs(s) {
  const n = Math.max(0, Math.round(s));
  if (n < 60) return `${n}s`;
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(n % 60).padStart(2, '0')}s`;
}
