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

import { mkdir, rename, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { db, withTx } from '../db.js';
import { loadConfig, localizePath } from '../config.js';
import { log } from '../logger.js';
import { localDate } from '../dates.js';
import { movePath } from './catalogRepair.js';
import { repointExportedDays, isPushRunning } from './otavClient.js';
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
    const to = targetFor(f.file_path, type, cfg);
    if (!to) { unmapped.push(f.file_path); continue; }
    const m = { from: f.file_path, to, type, onAir: onAir.has(f.file_path) };
    if (!byTarget.has(to.toLowerCase())) byTarget.set(to.toLowerCase(), []);
    byTarget.get(to.toLowerCase()).push(m);
    moves.push(m);
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
      withTx(() => { movePath(from, to, null, { sameFile: true }); journal(from, to, source); });
    } catch (err) {
      await rename(dst, src).catch(() => {});
      throw err;
    }
    return {
      rollback: async () => {
        await rename(dst, src);
        withTx(() => {
          movePath(to, from, null, { sameFile: true });
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
  if (run.active) throw new Error('an organize run is already going');
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
  const rows = db.prepare(`SELECT * FROM FileMove WHERE undone_at IS NULL AND source = 'organize'
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

export { DEFAULT_MAP };
