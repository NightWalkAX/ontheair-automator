// Media normalisation ("Convert to Air Spec") — Module A companion.
//
// OnTheAir Video plays a mixed catalogue far better when every clip shares one
// container/codec/frame-rate/audio shape: mismatched frame rates and compressed
// audio are the usual source of drift between video and sound on playout. This
// service brings the whole library to a single house spec (1920x1080, 29.97fps,
// uncompressed PCM audio by default) and does it the slow, safe way:
//
//   probe -> convert to a WORK file -> verify the work file -> archive the
//   original -> move the new file into place -> update the catalogue.
//
// Nothing is ever converted in place and no original is ever deleted: the old
// file is moved to config.transcode.archiveDir, mirroring its full path, so a
// bad conversion is undone by moving one file back. Replacement happens per
// clip, right after that clip verifies, so a run that is stopped (or that dies)
// leaves a catalogue where SOME clips are already on spec and the rest are
// untouched — never a half-written file at a path OTAV might read.
//
// This routine is knowingly slow: it re-encodes every off-spec file at
// broadcast quality over the SMB share, one at a time by default. Hours for a
// channel, days for the whole library. That is why every step is recorded in
// SQLite (TranscodeItem) and streamed to the UI: the operator is expected to
// start it, walk away, and check the status tab later — including after a
// restart, which resumes from the queue rather than starting over.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, stat, rename, copyFile, unlink } from 'node:fs/promises';
import { dirname, basename, extname, join } from 'node:path';
import { db, withTx } from '../db.js';
import { loadConfig, updateConfig, localizePath, delocalizePath } from '../config.js';
import { repointExportedDays } from './otavClient.js';

const execFileAsync = promisify(execFile);

// ---- Target spec -----------------------------------------------------------

const DEFAULT_TARGET = {
  width: 1920,
  height: 1080,
  fps: '30000/1001',            // 29.97 — NTSC broadcast, not 30
  pixFmt: 'yuv420p',
  vcodec: 'libx264',
  preset: 'medium',
  crf: 18,
  acodec: 'pcm_s16le',          // uncompressed: no encoder delay to drift on
  sampleRate: 48000,
  audioChannels: 2,
  container: '.mov',
  // A file whose video/audio already match but that sits in another container
  // is left alone unless this is on — re-wrapping thousands of compliant files
  // buys nothing and costs days.
  enforceContainer: false,
  // Codecs accepted as already-on-spec (a file does not have to be libx264's
  // own output, it has to BE h264).
  acceptVideo: ['h264'],
  acceptAudio: ['pcm_s16le', 'pcm_s16be', 'pcm_s24le'],
  fpsToleranceHz: 0.01,
  verifyToleranceSeconds: 1.5,
};

// What to do when a converted clip changes name and a day ALREADY EXPORTED to
// OTAV names the old one (see replaceBlockers).
//
//   fix   — repair those playlists: re-point the clip in place, or push the day
//           again when the runtime moved. This is the default: OTAV's own API
//           makes the repair a single edit per clip, and leaving the operator to
//           remember which days to re-push is how a day ends up airing a file
//           that isn't there any more.
//   block — the conservative behaviour: the clip stays queued until the operator
//           pushes those days again, or forces the swap.
export const EXPORTED_DAYS_MODES = ['fix', 'block'];

const DEFAULT_EXPORTED_DAYS = {
  mode: 'fix',
  // Rebuild a future day when the runtime moved. Off: those days stay blocked
  // (a re-push is a bigger operation than an edit — it clears and refills).
  repush: true,
  // A runtime that moved less than this leaves the block's fit alone, so the
  // playlist can simply be re-pointed. verifyToleranceSeconds bounds how far
  // the runtime is allowed to move at all; this is where "far enough to matter"
  // sits inside that, well under the filler tolerance a block is fitted to.
  durationEpsilonSeconds: 0.5,
  // Never edit a clip this close to its start time on today's playlist.
  imminentMinutes: 10,
};

export function transcodeConfig() {
  const c = loadConfig().transcode || {};
  return {
    ffmpegPath: process.env.FFMPEG_PATH || c.ffmpegPath || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || c.ffprobePath || loadConfig().ffprobePath || 'ffprobe',
    // The env overrides exist so a test (or a one-off run on a machine whose
    // share is elsewhere) can point the work/archive folders at scratch space
    // without editing the operator's config.
    workDir: process.env.TRANSCODE_WORK_DIR || c.workDir || '/Volumes/Public/_transcode/work',
    archiveDir: process.env.TRANSCODE_ARCHIVE_DIR || c.archiveDir || '/Volumes/Public/_transcode/originals',
    concurrency: Math.max(1, Number(process.env.TRANSCODE_CONCURRENCY || c.concurrency) || 1),
    autoReplace: c.autoReplace !== false,
    copySourceFirst: !!c.copySourceFirst,
    perFileTimeoutMinutes: Number.isFinite(Number(c.perFileTimeoutMinutes))
      ? Number(c.perFileTimeoutMinutes) : 240,
    order: c.order || 'shortest',
    target: { ...DEFAULT_TARGET, ...(c.target || {}) },
    exportedDays: {
      ...DEFAULT_EXPORTED_DAYS,
      ...(c.exportedDays || {}),
      // Same reason as the work/archive overrides above: a test (or a one-off
      // run) can pick the policy without editing the operator's config.
      ...(process.env.TRANSCODE_EXPORTED_MODE ? { mode: process.env.TRANSCODE_EXPORTED_MODE } : {}),
    },
  };
}

/**
 * Persist the exported-day policy and return it as it now resolves.
 *
 * Written to config.json rather than held in memory: it decides what happens to
 * a day that is already on a playout Mac, so an operator who turned the repair
 * off means it to stay off across a restart. The env override still wins on the
 * way back out, and says so, so a test box can't be quietly re-pointed by a
 * click in the UI.
 */
export function setExportedDaysMode(mode) {
  if (!EXPORTED_DAYS_MODES.includes(mode)) throw new Error(`unknown mode "${mode}"`);
  updateConfig((config) => {
    config.transcode = config.transcode || {};
    config.transcode.exportedDays = { ...DEFAULT_EXPORTED_DAYS, ...(config.transcode.exportedDays || {}), mode };
  });
  return exportedDaysPolicy();
}

/**
 * The policy as it actually resolves, plus which env var is overriding it (the
 * UI greys the switch out rather than offering a click that changes nothing).
 */
export function exportedDaysPolicy() {
  return {
    ...transcodeConfig().exportedDays,
    overridden: process.env.TRANSCODE_EXPORTED_MODE ? 'TRANSCODE_EXPORTED_MODE' : null,
  };
}

/** "30000/1001" | 29.97 -> 29.970029... */
export function fpsToNumber(fps) {
  if (typeof fps === 'number') return fps;
  const s = String(fps || '').trim();
  if (s.includes('/')) {
    const [n, d] = s.split('/').map(Number);
    return d ? n / d : 0;
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Compare a probed format against the house spec. Returns the list of reason
 * codes it fails on — empty means the file already airs correctly and must not
 * be touched (re-encoding a compliant file only loses generations of quality).
 */
export function specReasons(fmt, target = transcodeConfig().target) {
  const reasons = [];
  if (!fmt || !fmt.vcodec) return ['unreadable'];
  if (fmt.width !== target.width || fmt.height !== target.height) reasons.push('resolution');
  const want = fpsToNumber(target.fps);
  if (Math.abs((fmt.fps || 0) - want) > (target.fpsToleranceHz ?? 0.01)) reasons.push('fps');
  if (!target.acceptVideo.includes(fmt.vcodec)) reasons.push('vcodec');
  if (fmt.pix_fmt && fmt.pix_fmt !== target.pixFmt) reasons.push('pixfmt');
  if (!fmt.acodec) reasons.push('no_audio');
  else {
    if (!target.acceptAudio.includes(fmt.acodec)) reasons.push('audio_codec');
    if (fmt.sample_rate && fmt.sample_rate !== target.sampleRate) reasons.push('audio_rate');
    if (fmt.achannels && fmt.achannels !== target.audioChannels) reasons.push('audio_channels');
  }
  if (target.enforceContainer
      && extname(fmt.file_path || '').toLowerCase() !== String(target.container).toLowerCase()) {
    reasons.push('container');
  }
  return reasons;
}

export const REASON_LABELS = {
  resolution: 'wrong resolution',
  fps: 'wrong frame rate',
  vcodec: 'video codec',
  pixfmt: 'pixel format',
  no_audio: 'no audio track',
  audio_codec: 'compressed audio',
  audio_rate: 'sample rate',
  audio_channels: 'channel count',
  container: 'container',
  unreadable: 'unreadable',
};

// ---- Editing the house spec ------------------------------------------------
//
// The target is what every clip is measured against and converted to, so
// changing it invalidates work: a file judged "on spec" was judged against the
// OLD spec, and a clip already converted was converted to it. Rather than make
// the operator re-probe a library that takes minutes over the share, the
// judgment is RE-DERIVED from the probe columns already in TranscodeItem —
// specReasons() reads nothing else, so recomputing it is exact and instant.
//
// The one thing that cannot be re-derived is a clip already REPLACED: its row
// describes the file that went to the archive, not the converted one now at
// that path. Those rows go to 'stale' — out of the queue, waiting for a probe.

/** Fields an operator may set, with how each is validated. */
const TARGET_FIELDS = {
  width: (v) => intIn(v, 16, 8192),
  height: (v) => intIn(v, 16, 8192),
  fps: (v) => {
    const s = String(v).trim();
    if (!/^\d+(\.\d+)?$/.test(s) && !/^\d+\/\d+$/.test(s)) throw new Error('fps must be a number or "num/den"');
    const n = fpsToNumber(s);
    if (!(n > 0 && n <= 240)) throw new Error('fps must be between 0 and 240');
    return s;
  },
  vcodec: (v) => oneOf(v, ['libx264', 'libx265'], 'vcodec'),
  pixFmt: (v) => oneOf(v, ['yuv420p', 'yuv422p'], 'pixFmt'),
  preset: (v) => oneOf(v, ['ultrafast', 'veryfast', 'fast', 'medium', 'slow', 'slower'], 'preset'),
  crf: (v) => intIn(v, 0, 51),
  acodec: (v) => oneOf(v, ['pcm_s16le', 'pcm_s24le', 'aac'], 'acodec'),
  sampleRate: (v) => oneOf(Number(v), [44100, 48000], 'sampleRate'),
  audioChannels: (v) => oneOf(Number(v), [1, 2], 'audioChannels'),
  container: (v) => oneOf(String(v).toLowerCase(), ['.mov', '.mp4', '.mkv'], 'container'),
  enforceContainer: (v) => !!v,
};

function intIn(v, lo, hi) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`expected a whole number between ${lo} and ${hi}`);
  return n;
}

function oneOf(v, allowed, name) {
  if (!allowed.includes(v)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return v;
}

/** What a codec choice implies about what already counts as on spec. */
const CODEC_FAMILY = {
  libx264: 'h264',
  libx265: 'hevc',
};

// Fields that change what a clip must BE. `preset` is not one of them: it only
// trades encode time for file size, so changing it must not throw away a queue.
const TARGET_SIGNIFICANT = [
  'width', 'height', 'fps', 'vcodec', 'pixFmt', 'crf',
  'acodec', 'sampleRate', 'audioChannels', 'container', 'enforceContainer',
];

/**
 * Persist a new house spec and re-judge the queue against it.
 *
 * Returns { target, changed, requeued, stale, reclassified }. `changed` false
 * means the submitted spec matched the stored one and nothing was touched —
 * re-saving the same form must not throw away a night of conversions.
 */
export function setTarget(patch) {
  if (activity) throw new Error(`a ${activity.kind} is running — stop it before changing the spec`);

  const current = transcodeConfig().target;
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    if (!(key in TARGET_FIELDS)) continue;   // acceptVideo/acceptAudio are derived below
    try {
      next[key] = TARGET_FIELDS[key](value);
    } catch (err) {
      throw new Error(`${key}: ${err.message}`);
    }
  }

  // A codec the operator chose has to count as already-on-spec, or every file
  // that IS in that codec would be queued to be re-encoded into it.
  const encoded = CODEC_FAMILY[next.vcodec] || next.vcodec;
  next.acceptVideo = [...new Set([encoded, ...(next.acceptVideo || [])])];
  next.acceptAudio = [...new Set([next.acodec, ...(next.acceptAudio || [])])];

  const changed = TARGET_SIGNIFICANT.some((k) => String(current[k]) !== String(next[k]));
  updateConfig((config) => {
    config.transcode = config.transcode || {};
    config.transcode.target = { ...(config.transcode.target || {}), ...next };
  });
  if (!changed) return { target: transcodeConfig().target, changed: false, requeued: 0, stale: 0, reclassified: 0 };

  const counts = reclassifyQueue(transcodeConfig().target);
  line(`Air spec changed to ${next.width}x${next.height} @ ${next.fps} / ${next.acodec} `
    + `${next.sampleRate}Hz ${next.container}. ${counts.reclassified} clip(s) re-judged, `
    + `${counts.requeued} queued, ${counts.stale} need re-probing.`, 'warn');
  emit({ type: 'state', ...getState() });
  return { target: transcodeConfig().target, changed: true, ...counts };
}

/**
 * Re-judge every queued clip against `target`, from the probe data already
 * stored — no ffprobe, no share access.
 *
 *   ok / pending      -> re-derived from specReasons(); either may flip
 *   converted/blocked -> back to 'pending': the work file meets the OLD spec
 *   replaced          -> 'stale': the row describes the archived original, so
 *                        this file's real shape is unknown until a re-probe
 *   skipped / missing -> left alone (the operator's call, and unreadable stays
 *                        unreadable whatever the spec says)
 */
export function reclassifyQueue(target = transcodeConfig().target) {
  const rows = db.prepare(`
    SELECT id, status, file_path, width, height, fps, vcodec, pix_fmt,
           acodec, sample_rate, achannels
    FROM TranscodeItem
    WHERE status IN ('ok', 'pending', 'converted', 'blocked', 'replaced')
  `).all();

  const setJudged = db.prepare('UPDATE TranscodeItem SET status = ?, reasons = ?, error = NULL WHERE id = ?');
  const setRequeued = db.prepare(`
    UPDATE TranscodeItem
    SET status = 'pending', reasons = ?, error = NULL,
        out_path = NULL, out_duration = NULL, out_size_bytes = NULL, progress = 0
    WHERE id = ?
  `);
  const setStale = db.prepare(`
    UPDATE TranscodeItem SET status = 'stale', reasons = NULL,
      error = 'the spec changed after this clip was converted — probe the library again'
    WHERE id = ?
  `);

  // `reclassified` counts rows whose status actually MOVED; requeued and stale
  // are subsets of it, so a caller can report "N re-judged, of which M queued"
  // without the three adding up to more clips than exist.
  let requeued = 0;
  let stale = 0;
  let reclassified = 0;
  withTx(() => {
    for (const row of rows) {
      if (row.status === 'replaced') { setStale.run(row.id); stale++; reclassified++; continue; }
      const reasons = specReasons(row, target);
      const json = JSON.stringify(reasons);
      if (row.status === 'converted' || row.status === 'blocked') {
        setRequeued.run(json, row.id);
        requeued++;
        reclassified++;
        continue;
      }
      const want = reasons.length ? 'pending' : 'ok';
      setJudged.run(want, json, row.id);
      if (want === row.status) continue;
      reclassified++;
      if (want === 'pending') requeued++;
    }
  });
  return { requeued, stale, reclassified };
}

// ---- Probing ---------------------------------------------------------------

/** Full format probe of one file (LOCAL path). Returns null if unreadable. */
export async function probeFormat(localPath) {
  const { ffprobePath } = transcodeConfig();
  let json;
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', localPath,
    ], { maxBuffer: 16 * 1024 * 1024 });
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  if (!v) return null;
  const rate = v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate;
  return {
    width: Number(v.width) || null,
    height: Number(v.height) || null,
    fps: fpsToNumber(rate),
    vcodec: v.codec_name || null,
    pix_fmt: v.pix_fmt || null,
    acodec: a?.codec_name || null,
    sample_rate: a ? Number(a.sample_rate) || null : null,
    achannels: a ? Number(a.channels) || null : null,
    duration: Number(json.format?.duration) || Number(v.duration) || null,
    size_bytes: Number(json.format?.size) || null,
  };
}

// ---- Queue (TranscodeItem) -------------------------------------------------

const upsertItem = () => db.prepare(`
  INSERT INTO TranscodeItem
    (file_path, resource_id, channel_id, status, reasons, width, height, fps, vcodec, pix_fmt,
     acodec, sample_rate, achannels, src_duration, size_bytes, probed_at, error)
  VALUES
    (@file_path, @resource_id, @channel_id, @status, @reasons, @width, @height, @fps, @vcodec, @pix_fmt,
     @acodec, @sample_rate, @achannels, @src_duration, @size_bytes, @probed_at, @error)
  ON CONFLICT(file_path) DO UPDATE SET
    resource_id  = excluded.resource_id,
    channel_id   = excluded.channel_id,
    reasons      = excluded.reasons,
    width        = excluded.width,
    height       = excluded.height,
    fps          = excluded.fps,
    vcodec       = excluded.vcodec,
    pix_fmt      = excluded.pix_fmt,
    acodec       = excluded.acodec,
    sample_rate  = excluded.sample_rate,
    achannels    = excluded.achannels,
    src_duration = excluded.src_duration,
    size_bytes   = excluded.size_bytes,
    probed_at    = excluded.probed_at,
    error        = excluded.error,
    -- A clip already converted/replaced keeps that state: a re-probe must never
    -- push finished work back into the queue (it would re-encode it).
    status = CASE
      WHEN TranscodeItem.status IN ('replaced', 'converted', 'blocked', 'running') THEN TranscodeItem.status
      WHEN TranscodeItem.status = 'skipped' AND excluded.status != 'missing' THEN 'skipped'
      ELSE excluded.status END
`);

/** Rows in the catalogue this run covers: one per distinct physical file. */
function catalogFiles({ channelId = null, showTypeId = null, includeFillers = true } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (channelId) { where.push('channel_id = ?'); args.push(channelId); }
  if (showTypeId) { where.push('show_type_id = ?'); args.push(showTypeId); }
  if (!includeFillers) where.push('is_filler = 0');
  return db.prepare(`
    SELECT MIN(id) AS resource_id, file_path, MIN(channel_id) AS channel_id, MIN(name) AS name
    FROM Resource
    WHERE ${where.join(' AND ')}
    GROUP BY file_path
    ORDER BY file_path
  `).all(...args);
}

export function itemCounts() {
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM TranscodeItem GROUP BY status').all();
  const out = { total: 0 };
  for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
  return out;
}

export function listItems({ status = null, channelId = null, limit = 300, offset = 0 } = {}) {
  const where = ['1 = 1'];
  const args = [];
  if (status) { where.push('status = ?'); args.push(status); }
  if (channelId) { where.push('channel_id = ?'); args.push(channelId); }
  return db.prepare(`
    SELECT i.*, (SELECT name FROM Resource r WHERE r.file_path = i.file_path LIMIT 1) AS name
    FROM TranscodeItem i
    WHERE ${where.join(' AND ')}
    ORDER BY CASE i.status WHEN 'running' THEN 0 WHEN 'failed' THEN 1 WHEN 'blocked' THEN 2
                           WHEN 'stale' THEN 3 WHEN 'converted' THEN 4 WHEN 'pending' THEN 5 ELSE 6 END,
             i.src_duration IS NULL, i.src_duration, i.id
    LIMIT ? OFFSET ?
  `).all(...args, Math.min(2000, Math.max(1, limit)), Math.max(0, offset));
}

// ---- Live state + event stream --------------------------------------------
//
// The tab has to answer "is it working, on what, and how far in" after a page
// reload and after a server restart, so the durable answer lives in
// TranscodeItem and this only carries the live extras (ffmpeg progress, log).

const MAX_LOG = 400;
const listeners = new Set();
const log = [];
let seq = 0;

let activity = null;  // { kind: 'scan'|'convert', startedAt, stopRequested, opts, done, total }
const running = new Map(); // item id -> { file_path, name, pct, speed, startedAt, child }

function emit(event) {
  const ev = { seq: ++seq, at: Date.now(), ...event };
  if (ev.type === 'log' || ev.type === 'item' || ev.type === 'phase') {
    log.push(ev);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  }
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of listeners) { try { res.write(frame); } catch { /* dead socket */ } }
  return ev;
}

const line = (message, kind = '') => emit({ type: 'log', kind, message });

/** Attach an SSE response. Recent log lines are replayed so a late tab has context. */
export function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`data: ${JSON.stringify({ type: 'state', ...getState() })}\n\n`);
  for (const ev of log.slice(-120)) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  listeners.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
  res.on('close', () => { clearInterval(ping); listeners.delete(res); });
}

export function getState() {
  const cfg = transcodeConfig();
  return {
    phase: activity ? activity.kind : 'idle',
    startedAt: activity?.startedAt || null,
    stopRequested: !!activity?.stopRequested,
    done: activity?.done || 0,
    total: activity?.total || 0,
    autoReplace: cfg.autoReplace,
    concurrency: cfg.concurrency,
    target: {
      width: cfg.target.width, height: cfg.target.height, fps: cfg.target.fps,
      vcodec: cfg.target.vcodec, acodec: cfg.target.acodec,
      sampleRate: cfg.target.sampleRate, audioChannels: cfg.target.audioChannels,
      container: cfg.target.container,
    },
    exportedDays: exportedDaysPolicy(),
    running: [...running.values()].map((r) => ({
      id: r.id, file_path: r.file_path, name: r.name, pct: r.pct, speed: r.speed,
      fps: r.fps, elapsedMs: Date.now() - r.startedAt, etaSeconds: r.etaSeconds,
    })),
    counts: itemCounts(),
  };
}

export function requestStop() {
  if (!activity) return false;
  activity.stopRequested = true;
  line('Stop requested — finishing the clip in flight, then stopping.', 'warn');
  emit({ type: 'state', ...getState() });
  return true;
}

/** Hard stop: kill ffmpeg now. The work file is discarded; the original is untouched. */
export function abortNow() {
  if (!activity) return false;
  activity.stopRequested = true;
  for (const r of running.values()) { try { r.child?.kill('SIGKILL'); } catch { /* gone */ } }
  line('Aborted — ffmpeg killed. The originals were not touched.', 'bad');
  return true;
}

// ---- Scan (probe pass) -----------------------------------------------------

/**
 * Probe every catalogued file and record whether it is on spec. Returns
 * immediately; progress arrives on the event stream. Cheap next to conversion
 * (one ffprobe per file) but still minutes over SMB for a full library.
 */
export function startScan(opts = {}) {
  if (activity) throw new Error(`a ${activity.kind} is already running`);
  const files = catalogFiles(opts);
  activity = { kind: 'scan', startedAt: Date.now(), stopRequested: false, opts, done: 0, total: files.length };
  emit({ type: 'phase', phase: 'scan', message: `Probing ${files.length} file(s) with ffprobe…` });

  (async () => {
    const upsert = upsertItem();
    let offSpec = 0; let missing = 0;
    try {
      for (const f of files) {
        if (activity.stopRequested) { line('Scan stopped by operator.', 'warn'); break; }
        const local = localizePath(f.file_path);
        const fmt = await probeFormat(local);
        const reasons = fmt ? specReasons({ ...fmt, file_path: f.file_path }) : ['unreadable'];
        const status = !fmt ? 'missing' : (reasons.length ? 'pending' : 'ok');
        if (status === 'pending') offSpec++;
        if (status === 'missing') missing++;
        upsert.run({
          file_path: f.file_path,
          resource_id: f.resource_id ?? null,
          channel_id: f.channel_id ?? null,
          status,
          reasons: JSON.stringify(reasons),
          width: fmt?.width ?? null, height: fmt?.height ?? null, fps: fmt?.fps ?? null,
          vcodec: fmt?.vcodec ?? null, pix_fmt: fmt?.pix_fmt ?? null,
          acodec: fmt?.acodec ?? null, sample_rate: fmt?.sample_rate ?? null,
          achannels: fmt?.achannels ?? null,
          src_duration: fmt?.duration ?? null, size_bytes: fmt?.size_bytes ?? null,
          probed_at: new Date().toISOString(),
          error: fmt ? null : 'ffprobe could not read this file',
        });
        activity.done++;
        if (activity.done % 10 === 0 || status !== 'ok') {
          emit({ type: 'progress', done: activity.done, total: activity.total, message: basename(f.file_path) });
        }
      }
      line(`Scan finished: ${offSpec} file(s) off spec, ${missing} unreadable, `
        + `${activity.done - offSpec - missing} already on spec.`, 'ok');
    } catch (err) {
      line(`Scan failed: ${err.message || err}`, 'bad');
    } finally {
      activity = null;
      emit({ type: 'state', ...getState() });
    }
  })();

  return { started: true, total: files.length };
}

// ---- Conversion ------------------------------------------------------------

/** Where the converted file is written before it is verified. */
function workPathFor(item, target) {
  const { workDir } = transcodeConfig();
  const stem = basename(item.file_path, extname(item.file_path));
  return join(localizePath(workDir), `${item.id}-${stem}${target.container}`);
}

/** Archive path mirroring the original's full path, so it stays traceable. */
function archivePathFor(canonicalPath) {
  const { archiveDir } = transcodeConfig();
  return join(localizePath(archiveDir), canonicalPath.replace(/^\/+/, ''));
}

function videoArgsFor(target) {
  if (Array.isArray(target.videoArgs)) return target.videoArgs.map(String);
  const args = ['-c:v', target.vcodec];
  if (/^libx26[45]$/.test(target.vcodec)) {
    args.push('-preset', target.preset, '-crf', String(target.crf), '-profile:v', 'high');
    // Closed short GOPs with no B-frames: OTAV cues and seeks on these, and
    // B-pyramids are where "starts a few frames late" comes from.
    args.push('-bf', '0', '-g', '60', '-keyint_min', '1', '-sc_threshold', '0');
  }
  args.push('-pix_fmt', target.pixFmt);
  return args;
}

function audioArgsFor(target) {
  if (Array.isArray(target.audioArgs)) return target.audioArgs.map(String);
  return [
    '-c:a', target.acodec,
    '-ar', String(target.sampleRate),
    '-ac', String(target.audioChannels),
    // async=1 + first_pts=0 pads/trims the head instead of letting a late audio
    // start slide the whole track — the classic lip-sync offset on playout.
    '-af', `aresample=async=1:first_pts=0,aformat=sample_rates=${target.sampleRate}`,
  ];
}

export function buildFfmpegArgs(inPath, outPath, target, { hasAudio = true } = {}) {
  const vf = [
    // deint=1 only touches frames flagged interlaced, so progressive sources
    // pass through untouched.
    'yadif=mode=0:parity=-1:deint=1',
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `fps=${target.fps}`,
    `format=${target.pixFmt}`,
  ].join(',');

  const args = ['-y', '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', inPath];
  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${target.sampleRate}`);
  }
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0');
  if (!hasAudio) args.push('-shortest');
  args.push('-vf', vf, '-r', String(target.fps));
  // Timebase that divides the target rate exactly: a 600-timescale mov is where
  // 29.97 becomes "29.97-ish" and audio drifts over a two-hour feature.
  const num = String(target.fps).includes('/') ? String(target.fps).split('/')[0] : '30000';
  args.push('-video_track_timescale', num);
  args.push(...videoArgsFor(target), ...audioArgsFor(target));
  args.push('-map_metadata', '-1', '-max_muxing_queue_size', '1024');
  args.push('-progress', 'pipe:1', '-nostats', outPath);
  return args;
}

/** Run ffmpeg, reporting progress against `duration`. Resolves on exit code 0. */
function runFfmpeg(args, { duration, onProgress, timeoutMs, register }) {
  const { ffmpegPath } = transcodeConfig();
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    register?.(child);
    let stderrTail = '';
    let killTimer = null;
    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
        stderrTail += `\nffmpeg exceeded the per-file timeout of ${Math.round(timeoutMs / 60000)} min`;
      }, timeoutMs);
    }
    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      const info = {};
      for (const l of lines) {
        const i = l.indexOf('=');
        if (i > 0) info[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
      if (info.out_time_us || info.out_time_ms || info.speed) {
        const secs = Number(info.out_time_us || info.out_time_ms * 1000 || 0) / 1_000_000;
        onProgress?.({
          seconds: secs,
          pct: duration ? Math.min(0.999, secs / duration) : null,
          speed: info.speed && info.speed !== 'N/A' ? parseFloat(info.speed) : null,
          fps: info.fps ? parseFloat(info.fps) : null,
        });
      }
    });
    child.stderr.on('data', (c) => {
      stderrTail = (stderrTail + c.toString()).slice(-4000);
    });
    child.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (code === 0) return resolve({ stderrTail });
      const why = signal ? `killed (${signal})` : `exit code ${code}`;
      return reject(new Error(`ffmpeg ${why}${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}` : ''}`));
    });
  });
}

const setItem = (id, patch) => {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE TranscodeItem SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => patch[k]), id);
};

/**
 * Which already-exported days name this file, if any.
 *
 * The converted file lands at a .mov path, so a clip whose extension changes
 * changes its file_path — and a day already EXPORTED to OTAV has that old path
 * baked into a playlist file on the playout Mac. Under the default
 * `exportedDays.mode = 'fix'` these are the days replaceAndRepoint() repairs;
 * under 'block' they are what makes the swap wait (status 'blocked') until the
 * operator re-pushes them, or forces it.
 */
export function replaceBlockers(item) {
  const target = transcodeConfig().target;
  const sameName = extname(item.file_path).toLowerCase() === String(target.container).toLowerCase();
  if (sameName) return [];
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT DISTINCT sb.target_date, c.name AS channel
    FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    JOIN Resource r        ON r.id = si.resource_id
    LEFT JOIN ChannelType c ON c.id = sb.channel_id
    WHERE r.file_path = ? AND sb.status = 'exported' AND sb.target_date >= ?
    ORDER BY sb.target_date
  `).all(item.file_path, today);
  return rows.map((r) => `${r.channel || 'channel'} ${r.target_date}`);
}

/** Mark an item as waiting on something the operator has to do, and say what. */
function blockItem(itemId, item, message) {
  setItem(itemId, { status: 'blocked', error: message });
  emit({ type: 'item', id: itemId, status: 'blocked', file_path: item.file_path });
  throw new Error(`blocked: ${message}`);
}

/** Point every catalogue row for this physical file at the converted one. */
function pointCatalogue(item, finalCanonical) {
  return db.prepare('UPDATE Resource SET file_path = ?, duration = ? WHERE file_path = ?')
    .run(finalCanonical, Math.round(item.out_duration || item.src_duration || 0), item.file_path).changes;
}

/** Snapshot the catalogue rows for one file, returning a restore(). */
function catalogueSnapshot(filePath) {
  const rows = db.prepare('SELECT id, file_path, duration FROM Resource WHERE file_path = ?').all(filePath);
  return () => {
    const back = db.prepare('UPDATE Resource SET file_path = ?, duration = ? WHERE id = ?');
    for (const r of rows) back.run(r.file_path, r.duration, r.id);
  };
}

/** Record the swap and tell the tab about it. */
function finishReplace(itemId, item, finalCanonical, backupPath, renamed, note = null) {
  setItem(itemId, {
    status: 'replaced',
    file_path: finalCanonical,
    backup_path: backupPath,
    replaced_at: new Date().toISOString(),
    error: note,
  });
  emit({
    type: 'item', id: itemId, status: 'replaced', file_path: finalCanonical,
    message: note ? `replaced — ${note}` : 'replaced',
  });
  return { path: finalCanonical, duration: item.out_duration, renamed };
}

/**
 * Swap a converted item into place: put the new file at its final path, archive
 * the original (moved, never deleted), and re-point the catalogue at it (every
 * channel that catalogued the same physical file).
 *
 * When the name changes the new file goes in FIRST and the original is archived
 * only once it has landed — the two names can coexist, so no path is ever left
 * with nothing behind it. A same-name swap has no such luxury and moves the
 * original out of the way first, putting it straight back if the new file fails
 * to land.
 *
 * Returns { path, duration, renamed }.
 */
export async function replaceItem(itemId, { force = false } = {}) {
  const item = db.prepare('SELECT * FROM TranscodeItem WHERE id = ?').get(itemId);
  if (!item) throw new Error('unknown item');
  if (!item.out_path) throw new Error('nothing converted for this item yet');
  if (item.status === 'replaced') return { path: item.file_path, duration: item.out_duration, renamed: 0 };

  const cfg = transcodeConfig();
  const finalCanonical = join(
    dirname(item.file_path),
    basename(item.file_path, extname(item.file_path)) + cfg.target.container,
  );
  const renaming = finalCanonical !== item.file_path;

  // A different clip already sitting at the destination name would be
  // overwritten — refuse rather than destroy it.
  if (renaming) {
    const clash = db.prepare('SELECT id FROM Resource WHERE file_path = ? LIMIT 1').get(finalCanonical);
    if (clash) throw new Error(`another catalogued clip already uses ${finalCanonical}`);
  }

  const blockers = force ? [] : replaceBlockers(item);
  if (blockers.length && cfg.exportedDays.mode !== 'fix') {
    return blockItem(itemId, item,
      `already exported to OTAV for ${blockers.join(', ')} — re-push those days, then replace`);
  }
  if (blockers.length) return replaceAndRepoint(itemId, item, finalCanonical, cfg);

  const localFinal = localizePath(finalCanonical);
  const localSrc = localizePath(item.file_path);
  const archive = archivePathFor(item.file_path);
  await mkdir(dirname(archive), { recursive: true });

  if (renaming) {
    await moveFile(item.out_path, localFinal);
    try {
      await moveFile(localSrc, archive);
    } catch (err) {
      await moveFile(localFinal, item.out_path).catch(() => {});
      throw err;
    }
  } else {
    await moveFile(localSrc, archive);
    try {
      await moveFile(item.out_path, localFinal);
    } catch (err) {
      // Put the original back: better a failed item than a gap on air.
      await moveFile(archive, localSrc).catch(() => {});
      throw err;
    }
  }
  return finishReplace(itemId, item, finalCanonical, delocalizePath(archive), pointCatalogue(item, finalCanonical));
}

/**
 * The same swap, for a clip whose old path is baked into a playlist on a
 * playout Mac (one or more days are already 'exported').
 *
 * repointExportedDays() owns the order: it checks every affected day is fixable
 * BEFORE anything moves, calls back to land the new file and re-point the
 * catalogue, then edits those playlists — re-pointing the clip in place, or
 * pushing the day again when the runtime moved enough to change the block's
 * fit. The original is archived only after all of that succeeds, so until the
 * playlists name the new file the old path still resolves and those days still
 * air. A day that cannot be fixed leaves the clip queued, exactly as before.
 */
async function replaceAndRepoint(itemId, item, finalCanonical, cfg) {
  const policy = cfg.exportedDays;
  const srcDuration = item.src_duration || 0;
  const outDuration = item.out_duration || 0;
  // OTAV re-reads a re-pointed clip's runtime from the file itself, so the
  // playlist's own timing self-corrects. The block's fit in THIS database and
  // the duration written into the schedule event do not — those were computed
  // from the old runtime, so a runtime that moved needs the day rebuilt.
  const durationChanged = !!srcDuration && !!outDuration
    && Math.abs(outDuration - srcDuration) > (policy.durationEpsilonSeconds ?? 0.5);

  const localFinal = localizePath(finalCanonical);
  const localSrc = localizePath(item.file_path);
  const archive = archivePathFor(item.file_path);
  let renamed = 0;

  let report;
  try {
    report = await repointExportedDays(item.file_path, finalCanonical, {
      durationChanged,
      repush: policy.repush !== false,
      imminentMinutes: policy.imminentMinutes ?? 10,
      onLog: (message) => line(`OTAV: ${message}`),
      commit: async () => {
        await mkdir(dirname(archive), { recursive: true });
        await moveFile(item.out_path, localFinal);
        const restore = catalogueSnapshot(item.file_path);
        renamed = pointCatalogue(item, finalCanonical);
        return {
          rollback: async () => {
            restore();
            renamed = 0;
            await moveFile(localFinal, item.out_path).catch(() => {});
          },
        };
      },
    });
  } catch (err) {
    return blockItem(itemId, item,
      `OTAV already has playlists naming the old file and they could not be fixed: ${err.message}`);
  }

  // Every playlist names the new file now, so the original can be archived. A
  // failure here is cosmetic — the catalogue and the playlists are already
  // correct — so it leaves the original in place and says so rather than
  // undoing a good swap.
  let backupPath = delocalizePath(archive);
  let note = null;
  try {
    await moveFile(localSrc, archive);
  } catch (err) {
    backupPath = null;
    note = `the original could not be archived (${err.message}) and is still at ${item.file_path}`;
    line(note, 'warn');
  }

  const fixed = [];
  if (report.patched) fixed.push(`${report.patched} clip(s) re-pointed`);
  if (report.repushed) fixed.push(`${report.repushed} day(s) pushed again`);
  if (fixed.length) line(`${basename(finalCanonical)}: ${fixed.join(', ')} on OTAV.`, 'ok');
  return finishReplace(itemId, item, finalCanonical, backupPath, renamed, note);
}

/** rename(), falling back to copy+unlink across filesystems (share -> local). */
async function moveFile(from, to) {
  await mkdir(dirname(to), { recursive: true });
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

/** Convert one queued item. Throws on failure (the caller records it). */
async function convertOne(item, cfg) {
  const target = cfg.target;
  const localSrc = localizePath(item.file_path);
  const work = workPathFor(item, target);
  await mkdir(dirname(work), { recursive: true });

  let input = localSrc;
  let staged = null;
  if (cfg.copySourceFirst) {
    staged = join(dirname(work), `src-${item.id}-${basename(item.file_path)}`);
    await copyFile(localSrc, staged);
    input = staged;
  }

  const live = {
    id: item.id, file_path: item.file_path, name: basename(item.file_path),
    pct: 0, speed: null, fps: null, startedAt: Date.now(), etaSeconds: null, child: null,
  };
  running.set(item.id, live);
  setItem(item.id, { status: 'running', started_at: new Date().toISOString(), error: null, progress: 0 });
  emit({ type: 'item', id: item.id, status: 'running', file_path: item.file_path, message: 'converting' });

  const hasAudio = !!item.acodec;
  const args = buildFfmpegArgs(input, work, target, { hasAudio });
  let lastPersist = 0;
  try {
    await runFfmpeg(args, {
      duration: item.src_duration || null,
      timeoutMs: cfg.perFileTimeoutMinutes > 0 ? cfg.perFileTimeoutMinutes * 60_000 : 0,
      register: (child) => { live.child = child; },
      onProgress: (p) => {
        live.pct = p.pct ?? live.pct;
        live.speed = p.speed ?? live.speed;
        live.fps = p.fps ?? live.fps;
        if (p.pct != null && live.speed) {
          const remaining = (item.src_duration || 0) * (1 - p.pct);
          live.etaSeconds = live.speed > 0 ? Math.round(remaining / live.speed) : null;
        }
        // Persisted occasionally so a reloaded tab (or a restart) still shows
        // roughly how far the clip in flight had got.
        if (Date.now() - lastPersist > 5000) {
          lastPersist = Date.now();
          setItem(item.id, { progress: live.pct ?? 0 });
          emit({ type: 'progress-item', id: item.id, pct: live.pct, speed: live.speed, etaSeconds: live.etaSeconds });
        }
      },
    });

    // Verify before anything is moved: a file that does not itself meet the
    // spec (or lost time) must never replace a working original.
    const out = await probeFormat(work);
    if (!out) throw new Error('the converted file could not be probed');
    const reasons = specReasons({ ...out, file_path: work }, target);
    if (reasons.length) throw new Error(`converted file still off spec: ${reasons.join(', ')}`);
    const srcDur = item.src_duration || 0;
    if (srcDur && Math.abs((out.duration || 0) - srcDur) > (target.verifyToleranceSeconds ?? 1.5)) {
      throw new Error(`duration changed by ${((out.duration || 0) - srcDur).toFixed(2)}s `
        + `(${srcDur.toFixed(2)}s -> ${(out.duration || 0).toFixed(2)}s)`);
    }

    const info = await stat(work).catch(() => null);
    setItem(item.id, {
      status: 'converted',
      out_path: work,
      out_duration: out.duration ?? null,
      out_size_bytes: info?.size ?? null,
      progress: 1,
      finished_at: new Date().toISOString(),
    });
    emit({ type: 'item', id: item.id, status: 'converted', file_path: item.file_path, message: 'converted' });
    return { out };
  } finally {
    running.delete(item.id);
    if (staged) await unlink(staged).catch(() => {});
  }
}

const ORDER_SQL = {
  shortest: 'src_duration IS NULL, src_duration ASC, id ASC',
  longest: 'src_duration IS NULL, src_duration DESC, id ASC',
  path: 'file_path ASC',
};

function nextPending(channelId) {
  const cfg = transcodeConfig();
  const order = ORDER_SQL[cfg.order] || ORDER_SQL.shortest;
  const args = [];
  let where = "status = 'pending'";
  if (channelId) { where += ' AND channel_id = ?'; args.push(channelId); }
  return db.prepare(`SELECT * FROM TranscodeItem WHERE ${where} ORDER BY ${order} LIMIT 1`).get(...args);
}

/**
 * Take the next queued clip and flip it to 'running' in the same synchronous
 * step, so two workers (concurrency > 1) can never pick the same row — and so a
 * crash mid-clip leaves a visible 'running' row that resetStaleRunning() puts
 * back in the queue on the next start.
 */
function claimNext(channelId) {
  for (;;) {
    const row = nextPending(channelId);
    if (!row) return null;
    const claimed = db.prepare(
      "UPDATE TranscodeItem SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'"
    ).run(new Date().toISOString(), row.id).changes;
    if (claimed) return row;
  }
}

/**
 * Clear 'running' rows left behind by a crash or a hard restart: the work file
 * they were writing is incomplete, the original was never touched, so the clip
 * simply goes back in the queue. Called on startup.
 */
export function resetStaleRunning() {
  const n = db.prepare(
    "UPDATE TranscodeItem SET status = 'pending', progress = 0 WHERE status = 'running'"
  ).run().changes;
  if (n) line(`${n} clip(s) were mid-conversion when the app last stopped — re-queued.`, 'warn');
  return n;
}

/**
 * Start the conversion run. Returns immediately; the work happens in the
 * background, one clip at a time (config.transcode.concurrency), replacing each
 * clip as it verifies when autoReplace is on. Safe to stop at any point.
 */
export function startConvert({ channelId = null, limit = null, replace = null } = {}) {
  if (activity) throw new Error(`a ${activity.kind} is already running`);
  const cfg = transcodeConfig();
  const autoReplace = replace == null ? cfg.autoReplace : !!replace;
  const pendingCount = channelId
    ? db.prepare("SELECT COUNT(*) AS n FROM TranscodeItem WHERE status = 'pending' AND channel_id = ?").get(channelId).n
    : db.prepare("SELECT COUNT(*) AS n FROM TranscodeItem WHERE status = 'pending'").get().n;
  const total = limit ? Math.min(limit, pendingCount) : pendingCount;
  if (!total) throw new Error('nothing queued — run a scan first (or everything is already on spec)');

  activity = {
    kind: 'convert', startedAt: Date.now(), stopRequested: false,
    opts: { channelId, limit, autoReplace }, done: 0, total,
  };
  emit({
    type: 'phase',
    phase: 'convert',
    message: `Converting ${total} clip(s) to ${cfg.target.width}x${cfg.target.height} @ ${cfg.target.fps} `
      + `/ ${cfg.target.acodec} ${cfg.target.sampleRate}Hz. This is slow by design — `
      + `re-encoding at broadcast quality, ${cfg.concurrency} at a time.`,
  });

  const worker = async () => {
    for (;;) {
      if (activity.stopRequested) return;
      if (limit && activity.done + running.size >= total) return;
      const item = claimNext(channelId);
      if (!item) return;
      try {
        await convertOne(item, cfg);
        if (autoReplace) {
          try {
            const r = await replaceItem(item.id);
            line(`✓ ${basename(item.file_path)} → ${basename(r.path)} (replaced, original archived)`, 'ok');
          } catch (err) {
            line(`↺ ${basename(item.file_path)} converted but NOT replaced: ${err.message}`, 'warn');
          }
        } else {
          line(`✓ ${basename(item.file_path)} converted — waiting for you to replace it`, 'ok');
        }
      } catch (err) {
        const message = String(err.message || err);
        setItem(item.id, {
          status: 'failed',
          error: message,
          attempts: (item.attempts || 0) + 1,
          finished_at: new Date().toISOString(),
        });
        emit({ type: 'item', id: item.id, status: 'failed', file_path: item.file_path, message });
        line(`✕ ${basename(item.file_path)}: ${message}`, 'bad');
      } finally {
        activity.done++;
        emit({ type: 'progress', done: activity.done, total: activity.total });
      }
    }
  };

  (async () => {
    try {
      await Promise.all(Array.from({ length: cfg.concurrency }, () => worker()));
      const c = itemCounts();
      line(activity.stopRequested
        ? `Stopped after ${activity.done} clip(s). ${c.pending || 0} still queued — start again any time.`
        : `Run finished: ${activity.done} clip(s) handled. ${c.replaced || 0} replaced in total, `
          + `${c.failed || 0} failed, ${c.pending || 0} still queued.`,
        activity.stopRequested ? 'warn' : 'ok');
    } catch (err) {
      line(`Run aborted: ${err.message || err}`, 'bad');
    } finally {
      activity = null;
      emit({ type: 'state', ...getState() });
    }
  })();

  return { started: true, total, autoReplace };
}

/**
 * Put a failed/blocked/skipped item back in the queue.
 *
 * A clip that already has a verified work file goes back to 'converted', not
 * 'pending': a blocked clip is one whose SWAP could not be completed (the OTAV
 * playlist repair failed, the clip was on air), and re-encoding a two-hour
 * feature to retry a REST edit would cost hours for nothing.
 */
export function requeue(id) {
  const item = db.prepare('SELECT * FROM TranscodeItem WHERE id = ?').get(id);
  if (!item) throw new Error('unknown item');
  const converted = !!item.out_path && item.status !== 'failed';
  setItem(id, converted
    ? { status: 'converted', error: null, progress: 1 }
    : { status: 'pending', error: null, progress: 0 });
  return { ok: true, status: converted ? 'converted' : 'pending' };
}

/** Take an item out of the queue without converting it. */
export function skip(id) {
  const item = db.prepare('SELECT * FROM TranscodeItem WHERE id = ?').get(id);
  if (!item) throw new Error('unknown item');
  if (item.status === 'running') throw new Error('that clip is being converted right now');
  setItem(id, { status: 'skipped', error: null });
  return { ok: true };
}

/** Replace every already-converted item that is waiting (manual-replace mode). */
export async function replacePending({ force = false } = {}) {
  const rows = db.prepare(
    "SELECT id FROM TranscodeItem WHERE status IN ('converted', 'blocked') ORDER BY id"
  ).all();
  const results = [];
  for (const r of rows) {
    try {
      const out = await replaceItem(r.id, { force });
      results.push({ id: r.id, ok: true, path: out.path });
    } catch (err) {
      results.push({ id: r.id, ok: false, error: String(err.message || err) });
    }
  }
  return results;
}
