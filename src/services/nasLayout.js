// One folder for everything that airs (operator, 2026-11-18).
//
// The share grew by hand: what airs was spread over Broadcast/, Transmission/,
// Local Academic Videos - Sorted/ and Completed Projects/, next to weddings and
// personal folders. This moves every CATALOGUED file into one tree, by content
// type:
//
//   <root>/Lessons  <root>/TV Shows  <root>/Movies  <root>/Documentaries
//   <root>/Fillers  <root>/Promos
//
// The content folder comes from what the file IS in the catalogue (its show
// type, decided by the deepest media root — every channel agrees on it), never
// from a guess about its name. Promos is a folder, not a show type: the
// automator keeps scheduling those clips exactly as before.
//
// Air safety — a file that moves while a playlist names it is a black channel:
//   - a file named by a day already on OTAV (today or later) moves through
//     repointExportedDays(): plan → rename + catalogue → PUT url on every clip →
//     read back; on any failure the patches, the catalogue AND the file go back.
//     It refuses the clip on air and one starting within 10 min (retried next run).
//   - nothing moves while Air Spec converts, an analog upload/push or an OTAV
//     push runs; the move is a same-share rename (instant, no copy).
//   - a target that already exists is never overwritten: reported as a collision.
//   - every move is journalled in FileMove (the playlist watchdog follows it, and
//     it is the undo list). Nothing is deleted.
//   - media roots follow once every file under them has moved, with the same
//     channels and show type, so a scan keeps finding new files.

import { mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { db, withTx } from '../db.js';
import { loadConfig, localizePath, delocalizePath } from '../config.js';
import { log } from '../logger.js';
import { localDate } from '../dates.js';
import { movePath, nameKey } from './catalogRepair.js';
import { collectVideoFiles, probeDuration } from './ingestion.js';
import { repointExportedDays, isPushRunning, readDayPlaylist } from './otavClient.js';
import { getState as transcodeState } from './transcode.js';
import { isAnalogPushRunning } from './analogClient.js';

const l = log('nas');
const SHARE = '/Volumes/Public';

// Show type name → content folder.
const TYPE_FOLDER = {
  Lessons: 'Lessons', 'TV Shows': 'TV Shows', Movies: 'Movies',
  Documentaries: 'Documentaries', Fillers: 'Fillers',
};

// Where each old folder goes, relative to the share and to the new root.
// '{type}' = the content folder of the file's (or root's) show type.
// Longest matching prefix wins.
const DEFAULT_MAP = [
  ['Broadcast/Shows', 'TV Shows'],
  ['Broadcast/Movies', 'Movies'],
  ['Broadcast/Christmas Movies', 'Movies/Christmas Movies'],
  ['Broadcast/Documentaries', 'Documentaries'],
  ['Broadcast/Filler', 'Fillers'],
  ['Broadcast/Discover Academic', 'Lessons/Discover Academic'],
  ['Broadcast/Local Shows', '{type}/Local Shows'],
  ['Transmission/Local Shows', '{type}/Local Shows'],
  ['Transmission/EDYOUPULSE', 'TV Shows/Local Shows/EDYOU PULSE'],
  ['Local Academic Videos - Sorted', 'Lessons'],
  ['Completed Projects/TRANSMISSION FOLDER 2026', 'Promos'],
];

export function layoutConfig() {
  const c = loadConfig().nasLayout || {};
  const share = String(c.share || SHARE).replace(/\/+$/, '');
  return {
    share,
    root: String(c.root || `${share}/GLC On Air`).replace(/\/+$/, ''),
    map: Array.isArray(c.map) && c.map.length ? c.map : DEFAULT_MAP,
    cleanNames: c.cleanNames !== false,
  };
}

const typeNames = () => new Map(db.prepare('SELECT id, name FROM ShowType').all().map((r) => [r.id, r.name]));

/** New canonical path for `path` (a file or a root), or null when it is not mapped / already inside. */
export function targetFor(path, typeName, cfg = layoutConfig()) {
  const p = String(path);
  if (p === cfg.root || p.startsWith(`${cfg.root}/`)) return null;
  if (!p.startsWith(`${cfg.share}/`)) return null;
  const rel = p.slice(cfg.share.length + 1);
  let best = null;
  for (const [from, to] of cfg.map) {
    if ((rel === from || rel.startsWith(`${from}/`)) && (!best || from.length > best[0].length)) best = [from, to];
  }
  if (!best) return null;
  const folder = TYPE_FOLDER[typeName] || null;
  if (best[1].includes('{type}') && !folder) return null;
  const head = best[1].replace('{type}', folder);
  const rest = rel.slice(best[0].length).replace(/^\/+/, '');
  return rest ? `${cfg.root}/${head}/${rest}` : `${cfg.root}/${head}`;
}

/**
 * A tidier file name (no extension), conservative on purpose: underscores to
 * spaces, a download counter "(1)" / "(Final Render)" / "(HD)" / "- Copy" off,
 * "Grade 2- English-" spaced as "Grade 2 - English -", double spaces folded.
 * For TV shows "4X13" / "S1E3" become "S04E13" / "S01E03" (episodeParse reads
 * both the same — checked). Case, words and numbers are never changed, and
 * folders keep their names (a folder is a subject in the catalogue).
 */
export function cleanStem(stem, typeName = null) {
  let s = String(stem);
  s = s.replace(/_/g, ' ');
  s = s.replace(/\s*[([](?:\d{1,2}|copy|final render|final|hd)[)\]]/gi, ' ');
  s = s.replace(/\s*-?\s*copy(?:\s*\d+)?\s*$/i, '');
  if (typeName === 'TV Shows') {
    s = s.replace(/\b(\d{1,2})[xX](\d{1,3})\b/g, (_, a, b) => `S${a.padStart(2, '0')}E${b.padStart(2, '0')}`);
    s = s.replace(/\bS(\d{1,2})\s?E(\d{1,3})\b/gi, (_, a, b) => `S${a.padStart(2, '0')}E${b.padStart(2, '0')}`);
  }
  s = s.replace(/([^\s-])-\s+/g, '$1 - ').replace(/\s+-([^\s-])/g, ' - $1');
  s = s.replace(/\s{2,}/g, ' ').trim().replace(/[\s.\-]+$/, '').trim();
  return s || String(stem);
}

/** `to` with its file name cleaned (same folder, same extension). */
function cleanedPath(to, typeName) {
  const ext = extname(to);
  const stem = basename(to, ext);
  const c = cleanStem(stem, typeName);
  return c === stem ? to : `${dirname(to)}/${c}${ext}`;
}

/** Days already on OTAV (today on) per path — one query for the whole plan. */
function exportedPaths(today) {
  return new Set(db.prepare(`
    SELECT DISTINCT r.file_path FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    JOIN Resource r ON r.id = si.resource_id
    LEFT JOIN ChannelType c ON c.id = sb.channel_id
    WHERE sb.status = 'exported' AND sb.target_date >= ?
      AND COALESCE(c.playout, 'otav') != 'analog'`).all(today).map((r) => r.file_path));
}

/**
 * Read-only. Every catalogued file with where it would go.
 * Returns { root, moves: [{from, to, type, onAir}], unmapped: [path], collisions: [{to, from:[...]}],
 *           roots: [{from, to, type, channels}], byFolder: {folder: n} }.
 * Disk is not touched here (a stat per file over SMB belongs to the run).
 */
export function planOrganize({ today = localDate() } = {}) {
  const cfg = layoutConfig();
  const names = typeNames();
  const onAir = exportedPaths(today);
  const files = db.prepare('SELECT file_path, MIN(show_type_id) AS t FROM Resource GROUP BY file_path ORDER BY file_path').all();
  const moves = [];
  const unmapped = [];
  const byTarget = new Map();
  for (const f of files) {
    const type = names.get(f.t);
    if (String(f.file_path).startsWith(`${cfg.root}/`)) continue;
    const raw = targetFor(f.file_path, type, cfg);
    if (!raw) { unmapped.push(f.file_path); continue; }
    const to = cfg.cleanNames ? cleanedPath(raw, type) : raw;
    moves.push({ from: f.file_path, to, raw, type, onAir: onAir.has(f.file_path) });
  }
  // A cleaned name that two files would share keeps the original names.
  const count = new Map();
  for (const m of moves) count.set(m.to.toLowerCase(), (count.get(m.to.toLowerCase()) || 0) + 1);
  for (const m of moves) if (count.get(m.to.toLowerCase()) > 1) m.to = m.raw;
  for (const m of moves) {
    if (!byTarget.has(m.to.toLowerCase())) byTarget.set(m.to.toLowerCase(), []);
    byTarget.get(m.to.toLowerCase()).push(m);
  }
  // Two sources for one target (the same show under Broadcast/ and Transmission/):
  // neither moves until the operator decides which copy is the good one.
  const collisions = [];
  for (const list of byTarget.values()) {
    if (list.length < 2) continue;
    collisions.push({ to: list[0].to, from: list.map((m) => m.from) });
    for (const m of list) m.collision = true;
  }
  const roots = db.prepare(`SELECT path, show_type_id, GROUP_CONCAT(channel_id) AS channels
    FROM MediaRoot GROUP BY path, show_type_id ORDER BY path`).all()
    .map((r) => ({ from: r.path, to: targetFor(r.path, names.get(r.show_type_id), cfg), type: names.get(r.show_type_id), channels: r.channels }))
    .filter((r) => r.to);
  const ok = moves.filter((m) => !m.collision);
  const byFolder = {};
  for (const m of ok) {
    const top = m.to.slice(cfg.root.length + 1).split('/')[0];
    byFolder[top] = (byFolder[top] || 0) + 1;
  }
  return { root: cfg.root, moves: ok, unmapped, collisions, roots, byFolder,
    onAirCount: ok.filter((m) => m.onAir).length };
}

function journal(from, to, source) {
  db.prepare('INSERT INTO FileMove (old_path, new_path, moved_at, source) VALUES (?, ?, ?, ?)')
    .run(from, to, new Date().toISOString(), source);
}

/** Rows whose name is the old file name (no extension) take the new one. */
function renameRows(from, to) {
  const a = basename(from, extname(from));
  const b = basename(to, extname(to));
  if (a !== b) db.prepare('UPDATE Resource SET name = ? WHERE file_path = ? AND name = ?').run(b, to, a);
}

/** Why nothing may move right now, or null. */
export function busyReason() {
  const t = transcodeState();
  if (t.phase !== 'idle') return `Air Spec is ${t.phase} — stop it first (it rewrites files in place)`;
  if (isAnalogPushRunning()) return 'an analog upload/push is running';
  if (isPushRunning()) return 'an OTAV push is running';
  return null;
}

/**
 * Rename one file and re-point everything that names it. `force` is never
 * used for overwrite: an existing target is always a collision.
 */
export async function moveFile(from, to, { source = 'organize', today, onLog = () => {} } = {}) {
  const src = localizePath(from);
  const dst = localizePath(to);
  try {
    const s = await stat(src);
    if (!s.isFile()) return { status: 'not-a-file' };
  } catch (err) {
    return { status: err.code === 'ENOENT' ? 'source-missing' : 'unreadable', error: err.code };
  }
  try { await stat(dst); return { status: 'collision' }; } catch { /* free */ }
  await mkdir(dirname(dst), { recursive: true });

  const commit = async () => {
    await rename(src, dst);
    try {
      withTx(() => { movePath(from, to, null, { sameFile: true }); renameRows(from, to); journal(from, to, source); });
    } catch (err) {
      await rename(dst, src).catch(() => {});
      throw err;
    }
    return {
      rollback: async () => {
        await rename(dst, src);
        withTx(() => {
          movePath(to, from, null, { sameFile: true });
          renameRows(to, from);
          db.prepare("UPDATE FileMove SET undone_at = ? WHERE old_path = ? AND new_path = ? AND undone_at IS NULL")
            .run(new Date().toISOString(), from, to);
        });
      },
    };
  };
  try {
    const r = await repointExportedDays(from, to, { commit, today, onLog });
    return { status: 'moved', patched: r.patched, repushed: r.repushed };
  } catch (err) {
    return { status: 'deferred', error: String(err.message || err) };
  }
}

/** Point media roots at their new folder once nothing catalogued is left under the old one. */
function moveRoots(plan) {
  const left = db.prepare('SELECT 1 FROM Resource WHERE file_path LIKE ? ESCAPE \'\\\' LIMIT 1');
  const esc = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const done = [];
  for (const r of plan.roots) {
    if (left.get(`${esc(r.from)}/%`)) continue;
    withTx(() => {
      for (const row of db.prepare('SELECT id, channel_id, show_type_id FROM MediaRoot WHERE path = ?').all(r.from)) {
        const dup = db.prepare('SELECT 1 FROM MediaRoot WHERE channel_id = ? AND show_type_id = ? AND path = ?')
          .get(row.channel_id, row.show_type_id, r.to);
        if (dup) db.prepare('DELETE FROM MediaRoot WHERE id = ?').run(row.id);
        else db.prepare('UPDATE MediaRoot SET path = ? WHERE id = ?').run(r.to, row.id);
      }
    });
    done.push(r);
    l.info(`media root ${r.from} → ${r.to}`);
  }
  return done;
}

const run = { active: null, last: null };

export function organizeState() { return { running: run.active, last: run.last }; }

/**
 * Move up to `limit` files of the plan (null = all). Off-air files first (fast,
 * no OTAV call), then the ones days on OTAV name. Returns a report; one run at a time.
 */
export async function runOrganize({ limit = null, only = null, today = localDate(), onAirToo = true } = {}) {
  if (run.active || sweepRun.active) throw new Error('an organize/sweep run is already going');
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const plan = planOrganize({ today });
  let todo = plan.moves.slice().sort((a, b) => Number(a.onAir) - Number(b.onAir));
  if (only) todo = todo.filter((m) => m.from.includes(only) || m.to.includes(only));
  if (!onAirToo) todo = todo.filter((m) => !m.onAir);
  if (limit) todo = todo.slice(0, limit);
  const report = { startedAt: new Date().toISOString(), planned: todo.length, moved: 0, patched: 0,
    repushed: 0, deferred: [], collisions: [], missing: [], other: [], roots: [] };
  run.active = { startedAt: report.startedAt, planned: todo.length, done: 0 };
  l.info(`organize: ${todo.length} file(s) to move into ${plan.root}`);
  try {
    for (const m of todo) {
      const reason = busyReason();
      if (reason) { report.stopped = reason; l.warn(`organize stopped: ${reason}`); break; }
      const r = await moveFile(m.from, m.to, { today, onLog: (s) => l.info(s) });
      run.active.done++;
      if (r.status === 'moved') {
        report.moved++; report.patched += r.patched || 0; report.repushed += r.repushed || 0;
      } else if (r.status === 'deferred') report.deferred.push({ from: m.from, error: r.error });
      else if (r.status === 'collision') report.collisions.push(m.from);
      else if (r.status === 'source-missing') report.missing.push(m.from);
      else report.other.push({ from: m.from, status: r.status, error: r.error });
    }
    report.roots = moveRoots(planOrganize({ today }));
  } finally {
    report.finishedAt = new Date().toISOString();
    run.last = report;
    run.active = null;
    l.info(`organize: moved ${report.moved} (${report.patched} OTAV clip(s) re-pointed), `
      + `${report.deferred.length} deferred, ${report.collisions.length} collision(s), `
      + `${report.missing.length} missing, ${report.roots.length} root(s) moved`);
  }
  return report;
}

/** Undo every move of the journal since `since` (ISO), newest first. */
export async function undoMoves({ since, today = localDate() } = {}) {
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const rows = db.prepare(`SELECT * FROM FileMove WHERE undone_at IS NULL AND source IN ('organize', 'sweep')
    AND moved_at >= ? ORDER BY id DESC`).all(since || '0');
  const out = { undone: 0, failed: [] };
  for (const r of rows) {
    const res = await moveFile(r.new_path, r.old_path, { source: 'undo', today });
    if (res.status === 'moved') {
      db.prepare('UPDATE FileMove SET undone_at = ? WHERE id = ?').run(new Date().toISOString(), r.id);
      out.undone++;
    } else out.failed.push({ path: r.new_path, ...res });
  }
  return out;
}


// ---------------------------------------------------------------------------
// Sweep: what airs-type content is on the share but NOT in the catalogue
// (operator, 2026-11-18). Every video file left under the sweep folders after
// organize is either
//   - a DUPLICATE of a catalogued file (same name key, and same size or the same
//     length ±max(3s,1%)) → <root>/Duplicates/<content folder>/<the original's
//     sub-folders>/<original name> [DUP n].<ext>;
//   - a duplicate of another uncatalogued file (same rule; the keeper is the copy
//     in the earliest sweep folder) → the same Duplicates tree, under the keeper;
//   - unique → <root>/_Not Catalogued/<content folder>/<path below its folder>:
//     inside the one folder, classified, but outside every media root, so no scan
//     pulls raw downloads into the catalogue (or Air Spec's queue) by itself.
// Duplicates/_manifest.csv lists every duplicate with its original, sizes and
// lengths, so the operator decides what stays and what is deleted. Nothing is
// deleted here; a file any OTAV playlist names from today on is not moved.

const SWEEP_SOURCES = [
  // [folder under the share, content folder for its unique files]
  ['Broadcast/Shows', 'TV Shows'],
  ['Broadcast/Movies', 'Movies'],
  ['Broadcast/Christmas Movies', 'Movies/Christmas Movies'],
  ['Broadcast/Documentaries', 'Documentaries'],
  ['Broadcast/Filler', 'Fillers'],
  ['Broadcast/Discover Academic', 'Lessons/Discover Academic'],
  ['Broadcast/Local Shows', 'TV Shows/Local Shows'],
  ['Broadcast/Academics 2026', 'Lessons/Academics 2026'],
  ['Broadcast/Academics', 'Lessons/Academics'],
  ['Broadcast/IDB Converted', 'Lessons/IDB Converted'],
  ['Local Academic Videos - Sorted', 'Lessons'],
  ['Completed Projects/TRANSMISSION FOLDER 2026', 'Promos'],
  ['Transmission/Promos', 'Promos'],
  ['Transmission/Math Tent Promo', 'Promos'],
  ['Videos for Broadcast/Promos', 'Promos'],
  ['Transmission/EDYOUPULSE', 'TV Shows/Local Shows/EDYOU PULSE'],
  ['Transmission/Local Shows', 'TV Shows/Local Shows'],
  ['Transmission/Shows', 'TV Shows'],
  ['Transmission/New Shows', 'TV Shows/New Shows'],
  ['Transmission/Mov', 'Movies'],
  ['Transmission/Movies', 'Movies'],
  ['Transmission/Documentaries', 'Documentaries'],
  ['Transmission/Filler', 'Fillers'],
  ['Transmission/Grade 6', 'Lessons/Grade 6'],
  ['Transmission/The Art of Teaching Mathematics', 'Lessons/The Art of Teaching Mathematics'],
  ['Transmission/Daily', 'Lessons/Daily'],
  ['Transmission/Downloads', 'Downloads'],   // raw downloads, films AND series: sorted by hand
  ['Transmission', 'TV Shows/Local Shows'],
  ['Videos for Broadcast', 'TV Shows/Local Shows'],
  ['Broadcast/OldLeightronixArchive', 'TV Shows/Old Leightronix Archive'],
];
// Never swept: the automator's own outputs and the playout's schedules.
const SWEEP_EXCLUDE = ['Broadcast/Channel Guide', 'Transmission/Schedules', '_transcode'];

const tolOk = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(3, a * 0.01);

function sweepConfig(cfg = layoutConfig()) {
  const c = loadConfig().nasLayout || {};
  return {
    sources: Array.isArray(c.sweepSources) && c.sweepSources.length ? c.sweepSources : SWEEP_SOURCES,
    exclude: [...SWEEP_EXCLUDE, ...(Array.isArray(c.sweepExclude) ? c.sweepExclude : [])],
    dupDir: `${cfg.root}/Duplicates`,
    looseDir: `${cfg.root}/_Not Catalogued`,
  };
}

/** Urls named by any OTAV day playlist exported from today on (all channels). */
export async function referencedUrls(today = localDate()) {
  const out = new Set();
  const rows = db.prepare(`SELECT DISTINCT c.*, sb.target_date FROM ScheduledBlock sb JOIN ChannelType c ON c.id = sb.channel_id
    WHERE sb.status = 'exported' AND sb.target_date >= ? AND COALESCE(c.playout, 'otav') = 'otav'`).all(today);
  for (const r of rows) {
    try {
      const pl = await readDayPlaylist(r, r.target_date);
      for (const it of pl.items) if (typeof it.url === 'string') out.add(it.url.toLowerCase());
    } catch (err) {
      throw new Error(`could not read ${r.name} ${r.target_date} from OTAV (${err.message}) — not sweeping blind`);
    }
  }
  return out;
}

async function sizeOf(path) { try { return (await stat(localizePath(path))).size; } catch { return null; } }

/**
 * Plan the sweep. Walks the sweep folders (slow over SMB: minutes). `probe`
 * measures lengths where sizes differ. Returns { duplicates, loose, skipped, counts }.
 */
export async function planSweep({ probe = true, onProgress = () => {} } = {}) {
  const cfg = layoutConfig();
  const sw = sweepConfig(cfg);
  const share = cfg.share;
  const catalogued = new Set(db.prepare('SELECT DISTINCT file_path FROM Resource').all().map((r) => r.file_path.toLowerCase()));
  // Catalogued files by name key — their current name AND every name they had (journal).
  const byKey = new Map();
  const cat = db.prepare('SELECT file_path, MAX(duration) AS d FROM Resource GROUP BY file_path').all();
  const add = (k, rec) => { if (!byKey.has(k)) byKey.set(k, []); if (!byKey.get(k).includes(rec)) byKey.get(k).push(rec); };
  const recs = new Map();
  for (const r of cat) { const rec = { path: r.file_path, duration: r.d }; recs.set(r.file_path, rec); add(nameKey(r.file_path), rec); }
  for (const m of db.prepare('SELECT old_path, new_path FROM FileMove WHERE undone_at IS NULL').all()) {
    const rec = recs.get(m.new_path);
    if (rec) add(nameKey(m.old_path), rec);
  }

  // Walk.
  const files = [];   // { path, src: index, cat }
  const excluded = sw.exclude.map((e) => `${share}/${e}`);
  const seen = new Set();
  for (let i = 0; i < sw.sources.length; i++) {
    const [rel, folder] = sw.sources[i];
    const dir = `${share}/${rel}`;
    let list = [];
    try { list = await collectVideoFiles(localizePath(dir)); } catch { continue; }
    for (const f of list) {
      const p = delocalizePath(f);
      const lp = p.toLowerCase();
      if (seen.has(lp)) continue;
      seen.add(lp);
      if (p.startsWith(`${cfg.root}/`)) continue;
      if (excluded.some((e) => p === e || p.startsWith(`${e}/`))) continue;
      if (catalogued.has(lp)) continue;
      // The deepest matching source decides (sources are listed with nested ones first where it matters).
      let best = i;
      for (let j = 0; j < sw.sources.length; j++) {
        const r2 = `${share}/${sw.sources[j][0]}/`;
        if (p.startsWith(r2) && sw.sources[j][0].length > sw.sources[best][0].length) best = j;
      }
      files.push({ path: p, src: best, folder: sw.sources[best][1], rel: p.slice(share.length + 1 + sw.sources[best][0].length + 1) });
    }
    onProgress(`walked ${rel}: ${files.length} uncatalogued so far`);
  }

  const durOf = async (f) => {
    if (f.duration !== undefined) return f.duration;
    f.duration = probe ? await probeDuration(localizePath(f.path)).catch(() => null) : null;
    return f.duration;
  };
  for (const f of files) f.size = await sizeOf(f.path);

  // 1. Duplicates of catalogued files.
  const duplicates = [];
  const rest = [];
  let probed = 0;
  for (const f of files) {
    const cands = byKey.get(nameKey(f.path)) || [];
    let hit = null;
    for (const c of cands) {
      c.size ??= await sizeOf(c.path);
      if (c.size && f.size && c.size === f.size) { hit = { c, why: 'same name + same size' }; break; }
    }
    if (!hit && cands.length) {
      const d = await durOf(f); probed++;
      for (const c of cands) if (tolOk(c.duration, d)) { hit = { c, why: 'same name + same length' }; break; }
    }
    if (hit) duplicates.push({ path: f.path, size: f.size, duration: f.duration ?? null, of: hit.c.path, ofSize: hit.c.size, ofDuration: hit.c.duration, why: hit.why });
    else rest.push(f);
    if ((duplicates.length + rest.length) % 500 === 0) onProgress(`compared ${duplicates.length + rest.length}/${files.length}`);
  }

  // 2. Duplicates among the uncatalogued (keeper = earliest sweep folder, then shortest path).
  const groups = new Map();
  for (const f of rest) { const k = nameKey(f.path); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(f); }
  const loose = [];
  for (const g of groups.values()) {
    g.sort((a, b) => a.src - b.src || a.path.length - b.path.length);
    const keepers = [];
    for (const f of g) {
      let same = null;
      for (const k of keepers) {
        if (k.size && f.size && k.size === f.size) { same = { k, why: 'same name + same size' }; break; }
      }
      if (!same && keepers.length && g.length > 1) {
        const d = await durOf(f); probed++;
        for (const k of keepers) { const kd = await durOf(k); if (tolOk(kd, d)) { same = { k, why: 'same name + same length' }; break; } }
      }
      if (same) duplicates.push({ path: f.path, size: f.size, duration: f.duration ?? null, of: same.k.path, ofSize: same.k.size, ofDuration: same.k.duration ?? null, why: same.why, ofUncatalogued: true });
      else { keepers.push(f); loose.push(f); }
    }
  }

  // Targets.
  for (const f of loose) {
    const stem = basename(f.rel, extname(f.rel));
    const clean = cleanStem(stem, f.folder.startsWith('TV Shows') ? 'TV Shows' : null);
    const relDir = dirname(f.rel) === '.' ? '' : `/${dirname(f.rel)}`;
    f.to = `${sw.looseDir}/${f.folder}${relDir}/${clean}${extname(f.rel)}`;
  }
  const looseTo = new Map(loose.map((f) => [f.path, f.to]));
  const perOriginal = new Map();
  for (const d of duplicates) {
    // Where the original lives (or will live, for an uncatalogued keeper) decides the mirror folder.
    const orig = looseTo.get(d.of) || d.of;
    let under;
    if (orig.startsWith(`${sw.looseDir}/`)) under = `_Not Catalogued/${orig.slice(sw.looseDir.length + 1)}`;
    else if (orig.startsWith(`${cfg.root}/`)) under = orig.slice(cfg.root.length + 1);
    else under = `Other/${orig.slice(share.length + 1)}`;
    const n = (perOriginal.get(d.of) || 0) + 1;
    perOriginal.set(d.of, n);
    const ext = extname(d.path);
    d.to = `${sw.dupDir}/${dirname(under)}/${basename(under, extname(under))} [DUP ${n}]${ext}`;
    d.original = orig;
  }
  // Two uncatalogued uniques cleaned to one name: the later keeps its own name.
  const taken = new Map();
  for (const f of loose) {
    const k = f.to.toLowerCase();
    if (taken.has(k)) {
      const relDir = dirname(f.rel) === '.' ? '' : `/${dirname(f.rel)}`;
      f.to = `${sw.looseDir}/${f.folder}${relDir}/${basename(f.rel)}`;
    }
    taken.set(f.to.toLowerCase(), f);
  }

  const counts = { uncatalogued: files.length, duplicates: duplicates.length, loose: loose.length, probed,
    duplicateBytes: duplicates.reduce((a, d) => a + (d.size || 0), 0) };
  return { root: cfg.root, duplicates, loose: loose.map((f) => ({ path: f.path, to: f.to, size: f.size })), counts };
}

const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const sweepRun = { active: null, last: null };
export function sweepState() { return { running: sweepRun.active, last: sweepRun.last }; }

/** Plan and move. `moveLoose` false = only the duplicates. Writes Duplicates/_manifest.csv. */
export async function runSweep({ moveLoose = true, limit = null, today = localDate(), probe = true, dryRun = false, planFile = null } = {}) {
  if (sweepRun.active || run.active) throw new Error('an organize/sweep run is already going');
  const busy = dryRun ? null : busyReason();
  if (busy) throw new Error(busy);
  sweepRun.active = { startedAt: new Date().toISOString(), phase: 'reading OTAV playlists', done: 0 };
  const report = { startedAt: sweepRun.active.startedAt, duplicatesMoved: 0, looseMoved: 0, skippedOnAir: [], collisions: [], errors: [] };
  try {
    const refs = await referencedUrls(today);
    sweepRun.active.phase = 'walking the share';
    const plan = await planSweep({ probe, onProgress: (m) => { sweepRun.active.phase = m; l.info(`sweep: ${m}`); } });
    report.counts = plan.counts;
    if (dryRun) {
      if (planFile) await writeFile(planFile, JSON.stringify(plan, null, 1));
      report.dryRun = true;
      report.planFile = planFile;
      report.sampleDuplicates = plan.duplicates.slice(0, 40).map((d) => ({ path: d.path, to: d.to, of: d.original, why: d.why }));
      report.sampleLoose = plan.loose.slice(0, 40);
      return report;
    }
    const todo = [
      ...plan.duplicates.map((d) => ({ ...d, kind: 'duplicate' })),
      ...(moveLoose ? plan.loose.map((f) => ({ ...f, kind: 'loose' })) : []),
    ].slice(0, limit || Infinity);
    sweepRun.active.phase = 'moving';
    sweepRun.active.total = todo.length;
    for (const m of todo) {
      if (refs.has(m.path.toLowerCase())) { report.skippedOnAir.push(m.path); m.status = 'on air'; continue; }
      const reason = busyReason();
      if (reason) { report.stopped = reason; break; }
      const dst = localizePath(m.to);
      try { await stat(dst); report.collisions.push(m.path); m.status = 'collision'; continue; } catch { /* free */ }
      try {
        await mkdir(dirname(dst), { recursive: true });
        await rename(localizePath(m.path), dst);
        journal(m.path, m.to, 'sweep');
        m.status = 'moved';
        if (m.kind === 'duplicate') report.duplicatesMoved++; else report.looseMoved++;
      } catch (err) {
        m.status = 'error'; report.errors.push({ path: m.path, error: err.code || err.message });
      }
      sweepRun.active.done++;
    }
    // The manifest: every duplicate, moved or not, beside them.
    const cfg = layoutConfig();
    const lines = ['status,duplicate_now_at,duplicate_was_at,original,why,dup_size_mb,orig_size_mb,dup_seconds,orig_seconds'];
    for (const d of todo.filter((x) => x.kind === 'duplicate')) {
      lines.push([d.status, d.status === 'moved' ? d.to : d.path, d.path, d.original, d.why,
        d.size ? (d.size / 1048576).toFixed(1) : '', d.ofSize ? (d.ofSize / 1048576).toFixed(1) : '',
        d.duration ?? '', d.ofDuration ?? ''].map(csv).join(','));
    }
    const manifest = `${cfg.root}/Duplicates/_manifest.csv`;
    await mkdir(dirname(localizePath(manifest)), { recursive: true });
    await writeFile(localizePath(manifest), `${lines.join('\n')}\n`);
    report.manifest = manifest;
  } catch (err) {
    report.error = String(err.message || err);
    l.warn(`sweep failed: ${report.error}`);
  } finally {
    report.finishedAt = new Date().toISOString();
    sweepRun.last = report;
    sweepRun.active = null;
    l.info(`sweep: ${report.duplicatesMoved} duplicate(s) and ${report.looseMoved} uncatalogued file(s) moved, `
      + `${report.skippedOnAir.length} left (in an OTAV playlist), ${report.collisions.length} collision(s), ${report.errors.length} error(s)`);
  }
  return report;
}

/**
 * Catalogue rows whose file was already gone before the organize ("ghosts":
 * 8.3 alias folders, films moved by hand) while the sweep found a copy with the
 * same name and length — that copy is the real file, not a duplicate. Move the
 * first one ([DUP 1]) to where the catalogued file belongs and re-point every row
 * at it. Only for ghosts no OTAV playlist names (a missing file in a playlist is
 * the watchdog's job). Returns { rescued: [...], stillMissing: n }.
 */
export async function rescueGhosts({ today = localDate() } = {}) {
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const cfg = layoutConfig();
  const names = typeNames();
  const ghosts = [];
  for (const r of db.prepare('SELECT file_path, MIN(show_type_id) AS t FROM Resource GROUP BY file_path').all()) {
    if (String(r.file_path).startsWith(`${cfg.root}/`)) continue;
    if (await sizeOf(r.file_path) != null) continue;
    ghosts.push({ path: r.file_path, type: names.get(r.t) });
  }
  const refs = await referencedUrls(today);
  const dupOf = db.prepare(`SELECT old_path, new_path FROM FileMove WHERE source = 'sweep' AND undone_at IS NULL
    AND new_path LIKE ? ESCAPE '\\' ORDER BY id`);
  const esc = (x) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rescued = [];
  let stillMissing = 0;
  for (const g of ghosts) {
    // Its duplicates were filed under the ghost's own name: "<stem> [DUP n]".
    const raw = targetFor(g.path, g.type, cfg);
    // Exactly where runSweep filed duplicates of an original outside the root.
    const under = `Other/${g.path.slice(cfg.share.length + 1)}`;
    const stem = basename(under, extname(under));
    const prefix = `${cfg.root}/Duplicates/${dirname(under)}/${stem} [DUP `;
    const cands = dupOf.all(`${esc(prefix)}%`).filter((m) => m.new_path.startsWith(prefix));
    const live = [];
    for (const c of cands) if (await sizeOf(c.new_path) != null) live.push(c);
    if (!live.length || refs.has(g.path.toLowerCase())) { stillMissing++; continue; }
    const pick = live[0].new_path;
    const to = raw ? (cfg.cleanNames ? cleanedPath(`${dirname(raw)}/${basename(raw, extname(raw))}${extname(pick)}`, g.type) : `${dirname(raw)}/${basename(raw, extname(raw))}${extname(pick)}`)
      : `${cfg.root}/${g.type ? TYPE_FOLDER[g.type] || 'Other' : 'Other'}/${basename(g.path, extname(g.path))}${extname(pick)}`;
    if (await sizeOf(to) != null) { stillMissing++; continue; }
    await mkdir(dirname(localizePath(to)), { recursive: true });
    await rename(localizePath(pick), localizePath(to));
    withTx(() => { movePath(g.path, to, null, { sameFile: true }); renameRows(g.path, to); journal(pick, to, 'rescue'); journal(g.path, to, 'rescue'); });
    rescued.push({ ghost: g.path, from: pick, to });
    l.info(`rescued ${g.path} → ${to} (was ${pick})`);
  }
  return { ghosts: ghosts.length, rescued, stillMissing };
}

// ---------------------------------------------------------------------------
// Unlabeled lessons (operator, 2026-11-18: "move the videos with no topic to an
// Unlabeled folder, ready for the guide"). A lesson whose file name says only
// level + subject + number ("Teen English E12", "5 CPCE Maths") gives the guide
// nothing to print; those go to <root>/Unlabeled/<the path below the root>, so
// what is left in the content folders always has a topic and the Unlabeled
// folder is the to-do list for naming. Same air safety as organize (moveFile):
// exported OTAV days re-pointed, clip on air / starting soon deferred. Media
// roots are cloned onto the Unlabeled mirror with the same channels and show
// type (moved outright when nothing is left behind), so scheduling is unchanged.

const NO_TOPIC_WORDS = new Set(('english language literature mathematics math maths science social studies '
  + 'geography history spanish information technology it office administration principles of business pob '
  + 'literacy numeracy phonics reading writing nursery grade grades teen junior elementary year term lesson '
  + 'lessons ep episode part pt e s g local academic new edpm class video final v cpce teacher and the of').split(' '));

/** Does a lesson's file name say what it is about, beyond level/subject/number? */
export function hasTopic(stem, subject = '') {
  const skip = new Set([...NO_TOPIC_WORDS, ...String(subject || '').toLowerCase().split(/[^a-z]+/).filter(Boolean)]);
  const words = String(stem).toLowerCase().replace(/[_\-.,()[\]]/g, ' ').split(/\s+/)
    .filter((w) => w && !/^[a-z]?\d+[a-z]?$/.test(w) && !skip.has(w));
  return words.join('').replace(/[^a-z]/g, '').length >= 3;
}

/** Read-only: catalogued Lessons under the root with no topic in their name. */
export function planUnlabeled() {
  const cfg = layoutConfig();
  const unl = `${cfg.root}/Unlabeled`;
  const names = typeNames();
  const rows = db.prepare(`SELECT file_path, MIN(show_type_id) AS t, MAX(subject) AS subject
    FROM Resource GROUP BY file_path ORDER BY file_path`).all();
  const onAir = exportedPaths(localDate());
  const moves = [];
  for (const r of rows) {
    const p = String(r.file_path);
    if (!p.startsWith(`${cfg.root}/`) || p.startsWith(`${unl}/`)) continue;
    if (p.startsWith(`${cfg.root}/Duplicates/`) || p.startsWith(`${cfg.root}/_Not Catalogued/`)) continue;
    if (names.get(r.t) !== 'Lessons') continue;
    if (hasTopic(basename(p, extname(p)), r.subject)) continue;
    moves.push({ from: p, to: `${unl}/${p.slice(cfg.root.length + 1)}`, onAir: onAir.has(p) });
  }
  return { root: unl, moves, onAirCount: moves.filter((m) => m.onAir).length };
}

/** Give every media root that lost files to Unlabeled a twin there (or move it when emptied). */
function followRootsToUnlabeled(cfg) {
  const unl = `${cfg.root}/Unlabeled`;
  const esc = (x) => x.replace(/[\\%_]/g, (c) => `\\${c}`);
  const under = db.prepare("SELECT 1 FROM Resource WHERE file_path LIKE ? ESCAPE '\\' LIMIT 1");
  const out = [];
  for (const root of db.prepare('SELECT DISTINCT path FROM MediaRoot').all().map((r) => r.path)) {
    if (!root.startsWith(`${cfg.root}/`) || root.startsWith(`${unl}/`)) continue;
    const twin = `${unl}/${root.slice(cfg.root.length + 1)}`;
    if (!under.get(`${esc(twin)}/%`)) continue;            // nothing of this root went to Unlabeled
    const left = under.get(`${esc(root)}/%`);
    withTx(() => {
      for (const row of db.prepare('SELECT id, channel_id, show_type_id FROM MediaRoot WHERE path = ?').all(root)) {
        const dup = db.prepare('SELECT 1 FROM MediaRoot WHERE channel_id = ? AND show_type_id = ? AND path = ?').get(row.channel_id, row.show_type_id, twin);
        if (left) { if (!dup) db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(row.channel_id, row.show_type_id, twin); }
        else if (dup) db.prepare('DELETE FROM MediaRoot WHERE id = ?').run(row.id);
        else db.prepare('UPDATE MediaRoot SET path = ? WHERE id = ?').run(twin, row.id);
      }
    });
    out.push({ root, twin, kept: !!left });
  }
  return out;
}

const unlRun = { active: null, last: null };
export function unlabeledState() { return { running: unlRun.active, last: unlRun.last }; }

export async function runUnlabeled({ today = localDate(), limit = null } = {}) {
  if (run.active || sweepRun.active || unlRun.active) throw new Error('another NAS job is running');
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const cfg = layoutConfig();
  const plan = planUnlabeled();
  const todo = plan.moves.slice().sort((a, b) => Number(a.onAir) - Number(b.onAir)).slice(0, limit || Infinity);
  const report = { startedAt: new Date().toISOString(), planned: todo.length, moved: 0, patched: 0, deferred: [], other: [] };
  unlRun.active = { startedAt: report.startedAt, planned: todo.length, done: 0 };
  try {
    for (const m of todo) {
      const reason = busyReason();
      if (reason) { report.stopped = reason; break; }
      const r = await moveFile(m.from, m.to, { source: 'organize', today });
      unlRun.active.done++;
      if (r.status === 'moved') { report.moved++; report.patched += r.patched || 0; }
      else if (r.status === 'deferred') report.deferred.push({ from: m.from, error: r.error });
      else report.other.push({ from: m.from, status: r.status });
    }
    report.roots = followRootsToUnlabeled(cfg);
  } finally {
    report.finishedAt = new Date().toISOString();
    unlRun.last = report;
    unlRun.active = null;
    l.info(`unlabeled: moved ${report.moved} (${report.patched} OTAV clip(s)), ${report.deferred.length} deferred`);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Empty folders (operator, 2026-11-18). Bottom-up rmdir under the old content
// trees and the on-air root. rmdir itself refuses a folder with anything in it;
// OS litter (.DS_Store, ._*, Thumbs.db, desktop.ini) counts as empty and goes
// with it. Never: a media root or a folder above one, the playout's schedules,
// the guide output, Air Spec's folders, Chrome's download folder, or the
// top-level folders of the share.
const LITTER = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|\.localized)$/i;
const EMPTY_SCOPES = ['Broadcast', 'Transmission', 'Local Academic Videos - Sorted',
  'Completed Projects/TRANSMISSION FOLDER 2026', 'Videos for Broadcast', 'GLC On Air'];
const EMPTY_KEEP = ['Transmission/Schedules', 'Broadcast/Channel Guide', 'Transmission/Promos', '_transcode'];

export async function removeEmptyDirs({ dryRun = true } = {}) {
  const cfg = layoutConfig();
  const keep = new Set([
    ...EMPTY_KEEP.map((k) => `${cfg.share}/${k}`),
    ...EMPTY_SCOPES.map((k) => `${cfg.share}/${k}`),
    `${cfg.root}/Duplicates`, `${cfg.root}/_Not Catalogued`, `${cfg.root}/Unlabeled`,
    ...['Lessons', 'TV Shows', 'Movies', 'Documentaries', 'Fillers', 'Promos'].map((f) => `${cfg.root}/${f}`),
  ]);
  const roots = db.prepare('SELECT DISTINCT path FROM MediaRoot').all().map((r) => String(r.path).replace(/\/+$/, ''));
  const protectedDir = (p) => keep.has(p) || roots.some((r) => r === p || r.startsWith(`${p}/`))
    || EMPTY_KEEP.some((k) => p.startsWith(`${cfg.share}/${k}/`));
  const removed = [];
  const litter = [];
  const walk = async (dir) => {   // returns true when dir is (now) empty
    let entries;
    try { entries = await readdir(localizePath(dir), { withFileTypes: true }); } catch { return false; }
    let empty = true;
    const junk = [];
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!(await walk(full))) empty = false; }
      else if (LITTER.test(e.name)) junk.push(full);
      else empty = false;
    }
    if (!empty || protectedDir(dir)) return false;
    if (!dryRun) {
      for (const j of junk) { try { await unlink(localizePath(j)); litter.push(j); } catch { return false; } }
      try { await rmdir(localizePath(dir)); } catch { return false; }
    } else litter.push(...junk);
    removed.push(dir);
    return true;
  };
  for (const scope of EMPTY_SCOPES) await walk(`${cfg.share}/${scope}`);
  l.info(`empty folders: ${dryRun ? 'would remove' : 'removed'} ${removed.length} (${litter.length} OS litter file(s))`);
  return { dryRun, removed, litter: litter.length };
}

// Renames decided outside (e.g. lesson topics read from the video by OCR, 2026-11-18):
// a list of { from, to } moved one by one through moveFile — same air safety, journalled.
const renRun = { active: null, last: null };
export function renameState() { return { running: renRun.active, last: renRun.last }; }
export async function runRenames(moves, { today = localDate() } = {}) {
  if (run.active || sweepRun.active || unlRun.active || renRun.active) throw new Error('another NAS job is running');
  const busy = busyReason();
  if (busy) throw new Error(busy);
  const cfg = layoutConfig();
  const ok = moves.filter((m) => m && typeof m.from === 'string' && typeof m.to === 'string'
    && m.from.startsWith(`${cfg.root}/`) && m.to.startsWith(`${cfg.root}/`) && extname(m.from) === extname(m.to));
  const report = { startedAt: new Date().toISOString(), planned: ok.length, rejected: moves.length - ok.length, moved: 0, patched: 0, deferred: [], other: [] };
  renRun.active = { startedAt: report.startedAt, planned: ok.length, done: 0 };
  try {
    for (const m of ok) {
      const reason = busyReason();
      if (reason) { report.stopped = reason; break; }
      const r = await moveFile(m.from, m.to, { source: 'organize', today });
      renRun.active.done++;
      if (r.status === 'moved') { report.moved++; report.patched += r.patched || 0; }
      else if (r.status === 'deferred') report.deferred.push({ from: m.from, to: m.to, error: r.error });
      else report.other.push({ from: m.from, to: m.to, status: r.status });
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    renRun.last = report;
    renRun.active = null;
    l.info(`renames: moved ${report.moved} (${report.patched} OTAV clip(s)), ${report.deferred.length} deferred, ${report.other.length} other`);
  }
  return report;
}

export { DEFAULT_MAP, SWEEP_SOURCES };
