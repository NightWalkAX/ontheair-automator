// The analog device's disk (Vol1) as the automator manages it.
//
// Vol1 runs ~99% full with years of hand-loaded programmes, and the analog
// channel's week has to fit on it. Decided with the operator on 2026-10-04:
//
//   - FILLERS on Vol1 stay (PSAs, promos, Infobits …) and are part of the
//     channel's filler pool; MOVIES stay too (they come back on cooldown).
//     Everything else is a PROGRAMME: it may leave the device once it has aired
//     and nothing from today on needs it.
//   - Nothing is lost: a file leaves the device only when the share holds a
//     verified copy. One already in the catalogue (same name, same length) is
//     MATCHED; anything else is ARCHIVED — downloaded to
//     <analog.archiveDir>/<Fillers|Movies|Lessons|Shows>/<library folder>/,
//     checked (size, and ffprobe within 1s of the device's length), and then
//     catalogued for the analog channel, already mapped to its device name so it
//     plays without being uploaded again. deleteDeviceFiles() refuses any file
//     without that copy, force or not.
//   - The week routine: scan → delete what aired and isn't needed → upload what
//     the approved week needs (keeping analog.minFreeGb free) → push → delete
//     what the old week used.
//
// Classification is a first guess the operator corrects in the Analog tab
// (kind_manual survives every re-scan): a known filler prefix or a filler
// library folder, or short (≤ fillerMaxSeconds) without an episode/grade
// marker = filler; Movie_ prefix, a movie folder or ≥ 75 min = movie.

import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { db } from '../db.js';
import { delocalizePath, localizePath } from '../config.js';
import { addDays, localDate } from '../dates.js';
import { log } from '../logger.js';
import {
  AnalogClient, AnalogError, analogChannel, analogConfig, claimDevice, deleteDeviceFiles, deviceFileName,
  deviceWanted, filesForRange, isConfigured, onDeviceWanted, planFiles, pushAnalogDays, runUpload,
} from './analogClient.js';
import { probeDuration, scanMediaRoot } from './ingestion.js';

const l = log('analog');
const now = () => new Date().toISOString();
const MOVIE_SECONDS = 75 * 60;
const VERIFY_SECONDS = 1;

/** Name key: basename without extension, alphanumerics only, lower case. */
export const nameKey = (name) => String(name).replace(/\.[^./]+$/, '').replace(/^.*\//, '')
  .normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
const sameLength = (a, b) => Math.abs(a - b) <= Math.max(3, 0.01 * Math.max(a, b));

// An episode / grade / part marker: a short clip carrying one is a programme
// (a 6-minute lesson), not a filler.
const EPISODE_MARK = /(^|[^a-z])(s\d{1,2}e\d{1,3}|ep\.?\s?\d+|episode|e\d{2,3}\b|g\d{1,2}[a-z]{0,4}_|grade|cxc|csec|pt\.?\s?\d|part\s?\d|season)/i;
const LESSON_MARK = /(^|[^a-z])(g\d{1,2}[a-z]{0,4}_|grade|cxc|csec|lesson|nursery|_g\d{1,2}_|maths?_|eng_|sci_|ss_|mth_|phy_|chem|bio_|pob_|oa_)/i;

/** { kind: 'filler'|'movie'|'program', reason } for one device file. */
export function classify({ filename, title = '', folder_path: folder = '', length_s: len = null }, cfg = analogConfig()) {
  const stem = String(filename).replace(/\.[^.]+$/, '');
  const prefix = cfg.fillerPrefixes.find((p) => stem.toLowerCase().startsWith(p.toLowerCase()));
  if (prefix) return { kind: 'filler', reason: `prefix ${prefix}` };
  if (/fill|promo|psa|bumper|interstitial/i.test(folder || '')) return { kind: 'filler', reason: `folder ${folder}` };
  if (/^movie[_ -]/i.test(stem) || /^movie:/i.test(title || '')) return { kind: 'movie', reason: 'Movie_ prefix' };
  if (/movie|film|feature/i.test(folder || '')) return { kind: 'movie', reason: `folder ${folder}` };
  if (len != null && len >= MOVIE_SECONDS) return { kind: 'movie', reason: `${Math.round(len / 60)} min long` };
  if (len != null && len <= cfg.fillerMaxSeconds && !EPISODE_MARK.test(stem) && !EPISODE_MARK.test(title || '')) {
    return { kind: 'filler', reason: `${Math.round(len / 60)} min, no episode marker` };
  }
  return { kind: 'program', reason: len == null ? 'not in the device library (no length)' : 'programme' };
}

/** The archive folder (under analog.archiveDir) a file goes to. */
export function archiveDirFor(row, cfg = analogConfig()) {
  const top = row.kind === 'filler' ? 'Fillers' : row.kind === 'movie' ? 'Movies'
    : (LESSON_MARK.test(row.filename) || LESSON_MARK.test(row.folder_path || '') ? 'Lessons' : 'Shows');
  const sub = String(row.folder_path || '').replace(/^Library\/?/i, '').split('/').filter(Boolean)
    .map((p) => p.replace(/[^A-Za-z0-9 ._()&-]+/g, '_').trim()).filter(Boolean).join('/') || 'Unfiled';
  return join(cfg.archiveDir, top, sub);
}

const SHOW_TYPE_FOR = { Fillers: 'fillers', Movies: 'movies', Lessons: 'lessons', Shows: 'tv_shows' };

// --- Scan ----------------------------------------------------------------------

/**
 * Read Vol1 and its library, classify every file and match it to the share.
 * Returns the summary the tab shows. Manual kinds and finished archives are kept.
 */
export async function scanVol1() {
  const ch = analogChannel();
  if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
  const client = new AnalogClient(ch);
  const [files, lib] = await Promise.all([client.files(), client.resources('device')]);
  const libBy = new Map();
  for (const r of lib) if (r.type !== 'program_guide' && !libBy.has(r.filename)) libBy.set(r.filename, r);
  const cfg = analogConfig();

  // The share side: every catalogued file by name key — its full name and the
  // shortened name the automator would give it on the device — with its length.
  const byKey = new Map();
  for (const r of db.prepare('SELECT file_path, MAX(duration) AS duration FROM Resource GROUP BY file_path').all()) {
    for (const k of new Set([nameKey(r.file_path), nameKey(deviceFileName(r.file_path))])) {
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    }
  }
  const mappedTo = new Map(db.prepare('SELECT device_filename, file_path FROM AnalogFile').all()
    .map((r) => [r.device_filename, r.file_path]));
  const mapIt = db.prepare('INSERT OR IGNORE INTO AnalogFile (file_path, device_filename) VALUES (?, ?)');
  const prev = new Map(db.prepare('SELECT * FROM AnalogDeviceFile').all().map((r) => [r.filename, r]));
  const upsert = db.prepare(`
    INSERT INTO AnalogDeviceFile (filename, size, modified, title, folder_path, length_s, kind, kind_reason, kind_manual,
                                  share_path, archive, archive_error, scanned_at, gone_at)
    VALUES (@filename, @size, @modified, @title, @folder_path, @length_s, @kind, @kind_reason, @kind_manual,
            @share_path, @archive, @archive_error, @scanned_at, NULL)
    ON CONFLICT(filename) DO UPDATE SET size = excluded.size, modified = excluded.modified, title = excluded.title,
      folder_path = excluded.folder_path, length_s = excluded.length_s, kind = excluded.kind,
      kind_reason = excluded.kind_reason, kind_manual = excluded.kind_manual, share_path = excluded.share_path,
      archive = excluded.archive, archive_error = excluded.archive_error, scanned_at = excluded.scanned_at, gone_at = NULL
  `);

  const stamp = now();
  const seen = new Set();
  db.exec('BEGIN');
  try {
    for (const f of files) {
      if (!/\.[a-z0-9]+$/i.test(f.filename)) continue;
      seen.add(f.filename);
      const r = libBy.get(f.filename);
      const row = {
        filename: f.filename, size: f.size ?? null, modified: f.modified ?? null,
        title: r?.title ?? null, folder_path: r?.folder_path ?? null, length_s: r?.length_s ?? null,
      };
      const old = prev.get(f.filename);
      const guess = classify(row, cfg);
      row.kind = old?.kind_manual ? old.kind : guess.kind;
      row.kind_reason = old?.kind_manual ? 'set by hand' : guess.reason;
      row.kind_manual = old?.kind_manual ? 1 : 0;
      row.share_path = old?.share_path ?? null;
      row.archive = old?.archive ?? 'pending';
      row.archive_error = old?.archive_error ?? null;
      row.scanned_at = stamp;
      // An archived copy whose size no longer matches (the file on the device
      // was replaced) is not a copy of it any more.
      if (row.archive === 'archived' && old?.size != null && f.size != null && old.size !== f.size) {
        row.archive = 'pending'; row.share_path = null; row.archive_error = 'the device file changed since it was archived';
      }
      if (row.archive === 'pending' || row.archive === 'failed') {
        const share = mappedTo.get(f.filename)
          ?? (byKey.get(nameKey(f.filename)) || []).find((c) => row.length_s == null || c.duration == null
            || sameLength(row.length_s, c.duration))?.file_path;
        if (share) {
          row.share_path = share;
          row.archive = 'matched';
          row.archive_error = null;
          if (!mappedTo.has(f.filename)) { mapIt.run(share, f.filename); mappedTo.set(f.filename, share); }
        }
      }
      upsert.run(row);
    }
    const gone = db.prepare('UPDATE AnalogDeviceFile SET gone_at = ? WHERE filename = ? AND gone_at IS NULL');
    for (const name of prev.keys()) if (!seen.has(name)) gone.run(stamp, name);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  const s = vol1Summary();
  l.info(`Vol1 scanned: ${s.files} file(s) — ${s.byKind.filler?.files ?? 0} filler, ${s.byKind.movie?.files ?? 0} movie, `
    + `${s.byKind.program?.files ?? 0} programme; ${s.byArchive.pending?.files ?? 0} not on the share yet`);
  return s;
}

/** Counts and bytes by kind and by archive state, of what is on the device now. */
export function vol1Summary() {
  const rows = db.prepare('SELECT kind, archive, COUNT(*) AS n, SUM(size) AS bytes FROM AnalogDeviceFile WHERE gone_at IS NULL GROUP BY kind, archive').all();
  const byKind = {};
  const byArchive = {};
  let files = 0;
  let bytes = 0;
  for (const r of rows) {
    for (const [m, k] of [[byKind, r.kind], [byArchive, r.archive]]) {
      m[k] = m[k] || { files: 0, bytes: 0 };
      m[k].files += r.n;
      m[k].bytes += r.bytes || 0;
    }
    files += r.n;
    bytes += r.bytes || 0;
  }
  const last = db.prepare('SELECT MAX(scanned_at) AS at FROM AnalogDeviceFile').get().at;
  return { files, bytes, byKind, byArchive, scannedAt: last };
}

/** The inventory rows still on the device, for the tab. */
export function vol1Rows() {
  return db.prepare(`
    SELECT filename, size, modified, title, folder_path, length_s, kind, kind_reason, kind_manual,
           share_path, archive, archive_error, scanned_at
    FROM AnalogDeviceFile WHERE gone_at IS NULL ORDER BY kind, folder_path, filename
  `).all();
}

/** Correct the kind of some files by hand; it survives re-scans. */
export function setKind(filenames, kind) {
  if (!['filler', 'movie', 'program'].includes(kind)) throw new AnalogError('kind must be filler, movie or program');
  const up = db.prepare("UPDATE AnalogDeviceFile SET kind = ?, kind_manual = 1, kind_reason = 'set by hand' WHERE filename = ?");
  let n = 0;
  for (const f of filenames) n += up.run(kind, String(f)).changes;
  return n;
}

// --- Archive -------------------------------------------------------------------

let archiveJob = null;

export function archiveStatus() {
  if (!archiveJob) return { running: false };
  const { controller, ...pub } = archiveJob;
  return pub;
}

export function cancelArchive() {
  if (!archiveJob?.running) return false;
  archiveJob.cancelled = true;
  archiveJob.controller?.abort();
  return true;
}

/** Start archiving every pending/failed file still on the device (or just `filenames`). */
export async function startArchive({ filenames = null } = {}) {
  if (archiveJob?.running) throw new AnalogError('the archive is already running');
  const ch = analogChannel();
  if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
  const want = filenames ? new Set(filenames.map(String)) : null;
  const todo = db.prepare(`
    SELECT * FROM AnalogDeviceFile WHERE gone_at IS NULL AND archive IN ('pending', 'failed')
    ORDER BY CASE kind WHEN 'filler' THEN 0 WHEN 'program' THEN 1 ELSE 2 END, size
  `).all().filter((r) => !want || want.has(r.filename));
  archiveJob = {
    running: true, cancelled: false, startedAt: now(), finishedAt: null,
    total: todo.length, done: 0, bytesTotal: todo.reduce((n, r) => n + (r.size || 0), 0), bytesDone: 0,
    current: null, currentBytes: 0, waiting: null, archived: [], failed: [], catalogued: 0, controller: null,
  };
  runArchive(new AnalogClient(ch), ch, todo, archiveJob).catch((err) => { l.error('archive job crashed', err); });
  return archiveStatus();
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function runArchive(client, ch, todo, j) {
  // A push or an upload needs the device's FTP: let go of the current download
  // (it resumes from its .part file) and wait.
  const off = onDeviceWanted(() => { if (j.controller) { j.yielded = true; j.controller.abort(); } });
  const roots = new Set();
  try {
    for (const row of todo) {
      if (j.cancelled) break;
      j.current = row.filename;
      for (;;) {
        while (deviceWanted() && !j.cancelled) { j.waiting = 'the device is busy with a push or an upload'; await sleep(2000); }
        j.waiting = null;
        if (j.cancelled) break;
        j.yielded = false;
        try {
          const path = await archiveOne(client, row, j);
          j.archived.push(row.filename);
          roots.add(dirname(path).split('/').slice(0, analogConfig().archiveDir.split('/').length + 1).join('/'));
          break;
        } catch (err) {
          if (err.cancelled && j.yielded && !j.cancelled) continue; // gave way to a push: resume
          if (err.cancelled) break;
          db.prepare("UPDATE AnalogDeviceFile SET archive = 'failed', archive_error = ? WHERE filename = ?").run(err.message, row.filename);
          j.failed.push({ filename: row.filename, error: err.message });
          l.warn(`archive ${row.filename}: ${err.message}`);
          break;
        }
      }
      j.done++;
      j.bytesDone += row.size || 0;
      j.currentBytes = 0;
    }
    j.catalogued = await catalogueArchive(ch.id, roots);
  } finally {
    off();
    j.running = false;
    j.current = null;
    j.finishedAt = now();
  }
}

/** Download one file to the archive, verify it, and record where it is. Returns the canonical path. */
async function archiveOne(client, row, j) {
  const dir = archiveDirFor(row);
  const canonical = join(dir, row.filename);
  const local = localizePath(canonical);
  const part = `${local}.part`;
  await mkdir(dirname(local), { recursive: true });

  // Already there from an earlier run that died between rename and record?
  let done = await stat(local).catch(() => null);
  if (!done || (row.size != null && done.size !== row.size)) {
    // A transfer cut short is resumed from what landed in the .part file — a
    // few times, as long as each attempt makes progress.
    for (let attempt = 0; ; attempt++) {
      let offset = (await stat(part).catch(() => null))?.size ?? 0;
      if (row.size != null && offset > row.size) { await unlink(part); offset = 0; }
      if (row.size != null && offset === row.size) break;
      j.controller = new AbortController();
      const out = createWriteStream(part, { flags: offset ? 'a' : 'w' });
      const tick = setInterval(async () => { j.currentBytes = (await stat(part).catch(() => null))?.size ?? j.currentBytes; }, 2000);
      try {
        await client.download(row.filename, out, { offset, signal: j.controller.signal });
        break;
      } catch (err) {
        const now = (await stat(part).catch(() => null))?.size ?? 0;
        if (err.cancelled || attempt >= 4 || now <= offset) throw err;
        l.info(`archive ${row.filename}: transfer cut at ${now} bytes — resuming`);
      } finally {
        clearInterval(tick);
        await new Promise((r) => { out.end(r); });
        j.controller = null;
      }
    }
    const got = (await stat(part)).size;
    if (row.size != null && got !== row.size) throw new AnalogError(`copy is ${got} bytes, the device lists ${row.size}`);
    await rename(part, local);
    done = await stat(local);
  }
  // The copy must be a playable file of the same length as the device's.
  const dur = await probeDuration(local).catch((err) => { throw new AnalogError(`ffprobe cannot read the copy: ${err.message}`); });
  if (dur == null || dur <= 0) throw new AnalogError('ffprobe found no duration in the copy');
  if (row.length_s != null && Math.abs(dur - row.length_s) > VERIFY_SECONDS + 0.5) {
    throw new AnalogError(`copy runs ${dur}s, the device measures ${row.length_s}s`);
  }
  const path = delocalizePath(local) || canonical;
  db.prepare(`UPDATE AnalogDeviceFile SET archive = 'archived', share_path = ?, archive_error = NULL WHERE filename = ?`)
    .run(path, row.filename);
  // The copy IS the device file: map it, so the analog channel plays it from
  // Vol1 as it is, and re-uploads it under the same name if it was deleted.
  db.prepare('DELETE FROM AnalogFile WHERE device_filename = ? AND file_path != ?').run(row.filename, path);
  db.prepare('INSERT OR REPLACE INTO AnalogFile (file_path, device_filename, size) VALUES (?, ?, ?)').run(path, row.filename, done.size);
  l.info(`archived ${row.filename} → ${path} (${Math.round(done.size / 1048576)} MB, ${dur}s)`);
  return path;
}

/**
 * Make the archive part of the analog channel's catalogue: one root per
 * archive folder (Fillers / Movies / Lessons / Shows) on the analog channel
 * only, scanned. These files were on air already, so they arrive approved.
 */
async function catalogueArchive(channelId, roots) {
  let n = 0;
  for (const root of roots) {
    const top = root.split('/').pop();
    const code = SHOW_TYPE_FOR[top];
    const type = code && db.prepare('SELECT id FROM ShowType WHERE code = ?').get(code);
    if (!type) continue;
    db.prepare('INSERT OR IGNORE INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(channelId, type.id, root);
    const mr = db.prepare('SELECT * FROM MediaRoot WHERE channel_id = ? AND show_type_id = ? AND path = ?').get(channelId, type.id, root);
    try {
      await scanMediaRoot(mr);
    } catch (err) {
      l.warn(`archive root ${root} could not be scanned: ${err.message}`);
      continue;
    }
    const like = root.replace(/[\\%_]/g, (m) => `\\${m}`) + '/%';
    n += db.prepare("UPDATE Resource SET approved = 1 WHERE channel_id = ? AND file_path LIKE ? ESCAPE '\\' AND approved = 0")
      .run(channelId, like).changes;
  }
  return n;
}

// --- Does it fit? --------------------------------------------------------------

/**
 * Whether the files `paths` still need on the device fit on Vol1, keeping
 * analog.minFreeGb free. Sizes come from the share (stat), free space from the
 * device. Also says how much deleting the aired programmes would give back, so
 * a "doesn't fit" comes with what to do about it.
 * { files, toCopy, bytes, unreadable[], free, margin, after, fits, short, reclaimable }
 */
export async function spaceFor(client, channelId, paths) {
  const plan = await planFiles(client, paths);
  const todo = plan.filter((p) => p.state === 'missing');
  const sizes = new Map();
  const unreadable = [];
  await Promise.all(todo.map(async (p) => {
    const st = await stat(localizePath(p.file_path)).catch(() => null);
    if (st) sizes.set(p.file_path, st.size);
    else unreadable.push(p.file_path);
  }));
  const bytes = [...sizes.values()].reduce((n, b) => n + b, 0);
  const disks = await client.disk();
  const vol = disks.find((d) => /vol1/i.test(String(d.volume))) || disks[0] || null;
  const margin = analogConfig().minFreeGb * 1073741824;
  const free = vol ? Number(vol.free) : null;
  const after = free == null ? null : free - bytes;
  const fits = after == null ? null : after >= margin;
  let reclaimable = 0;
  if (fits === false) reclaimable = (await cleanupPlan(client, channelId).catch(() => ({ bytes: 0 }))).bytes;
  return {
    files: plan.length, toCopy: todo.length, bytes, unreadable, free, margin, after, fits,
    short: fits === false ? margin - after : 0, reclaimable, sizes: Object.fromEntries(sizes),
  };
}

// --- Clean-up ------------------------------------------------------------------

/**
 * Programmes that can leave the device now: safe on the share, not in the
 * device's on-air week, and not used by any analog block from today on (draft
 * included — a draft is the next thing to be approved). Fillers and movies stay.
 */
export async function cleanupPlan(client, channelId) {
  const files = new Map((await client.files()).map((f) => [f.filename, f]));
  const needed = new Set();
  const today = localDate();
  for (const r of db.prepare(`
    SELECT DISTINCT af.device_filename AS name
    FROM ScheduleItem si JOIN ScheduledBlock sb ON sb.id = si.block_id
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN Resource r ON r.id = si.resource_id
    JOIN AnalogFile af ON af.file_path = r.file_path
    WHERE COALESCE(sb.channel_id, bt.channel_id) = ? AND sb.target_date >= ?`).all(channelId, today)) needed.add(r.name);
  const out = { delete: [], kept: { onAir: 0, upcoming: 0, notArchived: 0 } };
  for (const r of db.prepare("SELECT * FROM AnalogDeviceFile WHERE gone_at IS NULL AND kind = 'program'").all()) {
    const f = files.get(r.filename);
    if (!f) continue;
    if (!['matched', 'archived'].includes(r.archive) || !r.share_path) { out.kept.notArchived++; continue; }
    if (f.in_schedule) { out.kept.onAir++; continue; }
    if (needed.has(r.filename)) { out.kept.upcoming++; continue; }
    out.delete.push({ filename: r.filename, size: f.size ?? r.size ?? 0, share_path: r.share_path });
  }
  out.bytes = out.delete.reduce((n, d) => n + (d.size || 0), 0);
  return out;
}

/** Delete what cleanupPlan() allows. Never forced. */
export async function runCleanup() {
  const ch = analogChannel();
  if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
  const plan = await cleanupPlan(new AnalogClient(ch), ch.id);
  if (!plan.delete.length) return { ...plan, deleted: [], refused: [], failed: [] };
  const r = await deleteDeviceFiles(plan.delete.map((d) => d.filename), { force: false });
  l.info(`Vol1 clean-up: ${r.deleted.length} programme(s) deleted, ${Math.round(r.deleted.reduce((n, d) => n + (d.size || 0), 0) / 1073741824)} GB freed`);
  return { ...plan, ...r };
}

// --- The week routine ------------------------------------------------------------

let routine = null;

export function routineStatus() {
  if (!routine) return { running: false };
  const { controller, upload, ...pub } = routine;
  return { ...pub, upload: upload ? (({ controller: _c, ...u }) => u)(upload) : null };
}

export function cancelRoutine() {
  if (!routine?.running) return false;
  routine.cancelled = true;
  routine.upload?.controller.abort();
  return true;
}

const datesBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to && out.length < 14; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * Scan → clean up → upload what the approved days need (keeping minFreeGb
 * free) → push → clean up what the old week used. One run at a time, in the
 * background; the tab polls routineStatus().
 */
export async function startRoutine({ from, to }) {
  if (routine?.running) throw new AnalogError('the week routine is already running');
  const ch = analogChannel();
  if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
  routine = {
    running: true, cancelled: false, startedAt: now(), finishedAt: null, from, to,
    step: 'starting', log: [], error: null, push: null, upload: null,
  };
  const r = routine;
  claimDevice(() => runRoutine(new AnalogClient(ch), ch, r))
    .catch((err) => {
      r.error = err.message;
      r.log.push(`stopped: ${err.message}`);
      l.warn(`week routine stopped: ${err.message}`);
    })
    .finally(() => { r.running = false; r.step = 'done'; r.finishedAt = now(); });
  return routineStatus();
}

async function runRoutine(client, ch, r) {
  const say = (line) => { r.log.push(line); l.info(`week routine: ${line}`); };
  const gb = (b) => `${(b / 1073741824).toFixed(1)} GB`;
  const guard = () => { if (r.cancelled) throw new AnalogError('cancelled'); };

  r.step = 'scanning Vol1';
  const s = await scanVol1();
  say(`Vol1: ${s.files} file(s), ${gb(s.bytes)}; ${s.byArchive.pending?.files ?? 0} not on the share yet`);
  guard();

  r.step = 'deleting what aired';
  const c1 = await runCleanup();
  say(`deleted ${c1.deleted.length} aired programme(s), ${gb(c1.deleted.reduce((n, d) => n + (d.size || 0), 0))} freed`
    + `${c1.refused.length ? ` · ${c1.refused.length} refused` : ''}`);
  guard();

  r.step = 'checking what the week needs';
  const paths = filesForRange(ch.id, r.from, r.to, ['approved', 'exported']).map((f) => f.file_path);
  if (!paths.length) throw new AnalogError(`no approved analog blocks between ${r.from} and ${r.to} — approve the week first`);
  const space = await spaceFor(client, ch.id, paths);
  r.space = space;
  const plan = await planFiles(client, paths);
  const todo = plan.filter((p) => p.state === 'missing');
  say(`${paths.length} clip(s) in the week, ${todo.length} to copy (${gb(space.bytes)}); `
    + `${space.free != null ? `${gb(space.free)} free on Vol1, ${gb(space.after)} after copying` : 'free space unknown'}`);
  if (space.unreadable.length) {
    throw new AnalogError(`${space.unreadable.length} file(s) the week needs can't be read on the share: ${space.unreadable.slice(0, 5).join(', ')}`);
  }
  if (space.fits === false) {
    throw new AnalogError(`does not fit: copying ${gb(space.bytes)} would leave ${gb(space.after)} free on Vol1, `
      + `${gb(space.short)} under the ${analogConfig().minFreeGb} GB margin — archive more of Vol1 so its aired `
      + 'programmes can go, or delete movies by hand');
  }
  guard();

  if (todo.length) {
    r.step = `copying ${todo.length} file(s) to the device`;
    r.upload = {
      running: true, cancelled: false, total: todo.length, done: 0, bytesTotal: 0, bytesDone: 0, current: null,
      uploaded: [], failed: [], stoppedBy: null, controller: new AbortController(),
    };
    await runUpload(client, todo, r.upload);
    say(`copied ${r.upload.uploaded.length} of ${todo.length}${r.upload.failed.length ? ` · ${r.upload.failed.length} failed` : ''}`);
    guard();
    if (r.upload.failed.length) throw new AnalogError(`${r.upload.failed.length} file(s) did not copy — the week is not pushed`);
  }

  r.step = 'pushing the week';
  r.push = await pushAnalogDays(datesBetween(r.from, r.to));
  const ok = r.push.days.filter((d) => d.result.ok).length;
  say(`pushed ${ok} of ${r.push.days.length} day(s)${r.push.held.length ? `; held: ${r.push.held.map((h) => `${h.date} (${h.reason})`).join(', ')}` : ''}`);
  guard();

  r.step = 'deleting what the old week used';
  const c2 = await runCleanup();
  say(`deleted ${c2.deleted.length} more programme(s) the new week no longer airs`);
}

