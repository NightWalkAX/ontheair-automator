// Catalogue path repair — "the clip is catalogued, but not at that path any more".
//
// Found in production on 2026-10-04, 117 catalogued files not on disk, and none
// of them deleted:
//
//   - Folders whose names END IN A SPACE ("Agri talk new videos "). macOS shows
//     such a folder over SMB under a mangled 8.3 name too ("ANWHU2~D"), so one
//     clip was catalogued under two or three paths. Air Spec converted ONE of
//     them, re-pointed the rows with that exact path, and archived the original;
//     the other paths were left naming a file that had moved to the archive.
//     The folder was later renamed without the space, which orphaned more.
//   - Films moved out of a media root by hand (every Christmas film left
//     Broadcast/Movies).
//
// The repair:
//   1. STAT every catalogued path (async, bounded concurrency — over SMB a
//      synchronous walk freezes the whole app).
//   2. For each one that is gone, look for the same clip elsewhere: by NAME
//      (basename without extension, case/punctuation-insensitive, so an .mp4
//      that became a .mov still matches) among the paths that ARE on disk —
//      every catalogued path, Air Spec's converted outputs, and with `deep` a
//      walk of the folders above the media roots for files moved by hand. A
//      candidate must also agree on DURATION (±max(3s, 1%)), probing it with
//      ffprobe when nothing recorded it; one agreeing candidate is a match,
//      several is reported as ambiguous and left alone.
//   3. ALIASES: paths that are on disk but are the SAME physical file (same
//      dev:ino — the mangled/spaced folders) are folded into one canonical path,
//      so the next conversion cannot orphan the others.
//   4. Apply: every catalogue row moves to the found path. Where a channel
//      already has a row for that path the two are MERGED (schedule items and
//      play history move to the surviving row, approval is kept if either had
//      it, a display-name override is kept). Seasonal marks follow the file. The
//      stale Air Spec row is dropped. Days already on OTAV that name the old
//      path are listed: re-push them.
//
// Nothing is ever deleted from disk, and an unmatched clip is only reported.

import { stat } from 'node:fs/promises';
import { dirname, basename, extname } from 'node:path';
import { db, withTx } from '../db.js';
import { localizePath, delocalizePath } from '../config.js';
import { collectVideoFiles, probeDuration } from './ingestion.js';
import { localDate } from '../dates.js';
import { log } from '../logger.js';

const l = log('repair');

/** Name key: basename without extension, lowercase, letters and digits only. */
export const nameKey = (p) => basename(String(p), extname(String(p))).toLowerCase().replace(/[^a-z0-9]/g, '');
const durationAgrees = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(3, a * 0.01);
/** A path through a mangled (8.3, "~") or space-trailing folder is the worse of two aliases. */
const pathPenalty = (p) => (/\/[^/]*~[0-9A-Z][^/]*\//.test(p) ? 2 : 0) + (/ \//.test(p) ? 1 : 0);

async function statAll(paths, concurrency = 16) {
  const out = new Map(); // path -> { ok, key?, error? }
  let i = 0;
  const worker = async () => {
    while (i < paths.length) {
      const p = paths[i++];
      try {
        const s = await stat(localizePath(p));
        out.set(p, s.isFile() ? { ok: true, key: s.ino ? `${s.dev}:${s.ino}` : null } : { ok: false, error: 'ENOTFILE' });
      } catch (err) {
        out.set(p, { ok: false, error: err.code || String(err.message || err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

/** Folders to walk for files moved by hand: the parent of every media root, nested ones dropped. */
function searchFolders() {
  const parents = [...new Set(db.prepare('SELECT DISTINCT path FROM MediaRoot').all()
    .map((r) => dirname(String(r.path).replace(/\/+$/, ''))))].sort();
  return parents.filter((p, i) => !parents.some((q, j) => j !== i && p.startsWith(q.endsWith('/') ? q : `${q}/`)));
}

/**
 * Work out what to repair. Read-only. Returns { relocate, aliases, ambiguous,
 * notFound, unreadable, checked }.
 */
export async function planRepair({ deep = false } = {}) {
  const rows = db.prepare(`
    SELECT file_path, MIN(duration) AS duration, COUNT(*) AS rows
    FROM Resource GROUP BY file_path ORDER BY file_path`).all();
  const known = new Map(rows.map((r) => [r.file_path, r]));
  // Air Spec's own outputs: converted files may be catalogued under no row yet.
  for (const t of db.prepare(`
    SELECT file_path, COALESCE(out_duration, src_duration) AS duration FROM TranscodeItem
    WHERE status IN ('replaced', 'ok', 'converted')`).all()) {
    if (!known.has(t.file_path)) known.set(t.file_path, { file_path: t.file_path, duration: Math.round(t.duration || 0), rows: 0 });
  }
  l.info(`checking ${known.size} known path(s)${deep ? ' + walking the folders above the media roots' : ''}`);
  const st = await statAll([...known.keys()]);

  const present = new Map(); // path -> { duration, catalogued, key }
  for (const [p, s] of st) if (s.ok) present.set(p, { duration: known.get(p).duration, catalogued: known.get(p).rows > 0, key: s.key });
  if (deep) {
    for (const folder of searchFolders()) {
      const found = (await collectVideoFiles(localizePath(folder))).map((f) => delocalizePath(f)).filter((p) => !present.has(p));
      // Identity too, so a walked file that IS a catalogued one counts once.
      for (const [p, s] of await statAll(found)) {
        if (s.ok) present.set(p, { duration: null, catalogued: false, key: s.key });
      }
    }
  }
  const byName = new Map();
  for (const [p, info] of present) {
    const k = nameKey(p);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push({ path: p, ...info });
  }

  const relocate = [], ambiguous = [], notFound = [], unreadable = [];
  for (const r of rows) {
    const s = st.get(r.file_path);
    if (s.ok) continue;
    if (s.error !== 'ENOENT') { unreadable.push({ file_path: r.file_path, error: s.error }); continue; }
    const cands = (byName.get(nameKey(r.file_path)) || []).filter((c) => c.path !== r.file_path);
    const agreeing = [];
    for (const c of cands) {
      let d = c.duration;
      if (!(d > 0)) {
        try { d = await probeDuration(localizePath(c.path)); } catch { d = null; }
        c.duration = d;
      }
      if (durationAgrees(r.duration, d)) agreeing.push(c);
    }
    // Several copies of one physical file are one candidate.
    const distinct = [...new Map(agreeing.map((c) => [c.key || c.path, c])).values()];
    if (distinct.length === 1) {
      // Among aliases of that file, the cleanest path wins.
      const same = agreeing.filter((c) => (c.key || c.path) === (distinct[0].key || distinct[0].path));
      same.sort((a, b) => pathPenalty(a.path) - pathPenalty(b.path) || Number(b.catalogued) - Number(a.catalogued));
      relocate.push({ from: r.file_path, to: same[0].path, duration: same[0].duration, rows: r.rows, why: 'same name and length' });
    } else if (distinct.length > 1) {
      ambiguous.push({ file_path: r.file_path, candidates: distinct.map((c) => c.path) });
    } else {
      notFound.push({ file_path: r.file_path, rows: r.rows, nameMatches: cands.map((c) => c.path) });
    }
  }

  // Aliases: catalogued paths that are one physical file under several names.
  const byInode = new Map();
  for (const [p, info] of present) {
    if (!info.key || !info.catalogued) continue;
    if (!byInode.has(info.key)) byInode.set(info.key, []);
    byInode.get(info.key).push(p);
  }
  const aliases = [];
  for (const paths of byInode.values()) {
    if (paths.length < 2) continue;
    paths.sort((a, b) => pathPenalty(a) - pathPenalty(b) || a.length - b.length);
    for (const p of paths.slice(1)) aliases.push({ from: p, to: paths[0], why: 'same physical file' });
  }

  return { checked: rows.length, relocate, aliases, ambiguous, notFound, unreadable };
}

/** Days already on OTAV (today on) whose playlists name any of these paths. */
function exportedDaysNaming(paths) {
  if (!paths.length) return [];
  const out = new Map();
  const q = db.prepare(`
    SELECT DISTINCT sb.target_date, c.name AS channel FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id JOIN Resource r ON r.id = si.resource_id
    LEFT JOIN ChannelType c ON c.id = sb.channel_id
    WHERE r.file_path = ? AND sb.status = 'exported' AND sb.target_date >= ?`);
  const today = localDate();
  for (const p of paths) for (const d of q.all(p, today)) out.set(`${d.channel}|${d.target_date}`, d);
  return [...out.values()].sort((a, b) => a.target_date.localeCompare(b.target_date) || String(a.channel).localeCompare(b.channel));
}

/** Move every catalogue row from `from` to `to`, merging into an existing row per channel. */
function movePath(from, to, duration) {
  const rows = db.prepare('SELECT * FROM Resource WHERE file_path = ?').all(from);
  const target = db.prepare('SELECT * FROM Resource WHERE channel_id = ? AND file_path = ?');
  let moved = 0, merged = 0;
  for (const r of rows) {
    const keep = target.get(r.channel_id, to);
    if (!keep) {
      db.prepare('UPDATE Resource SET file_path = ?, duration = COALESCE(?, duration) WHERE id = ?')
        .run(to, duration > 0 ? duration : null, r.id);
      moved++;
      continue;
    }
    db.prepare('UPDATE ScheduleItem SET resource_id = ? WHERE resource_id = ?').run(keep.id, r.id);
    db.prepare('UPDATE PlayHistory SET resource_id = ? WHERE resource_id = ?').run(keep.id, r.id);
    if (Number(r.approved) && !Number(keep.approved)) db.prepare('UPDATE Resource SET approved = 1 WHERE id = ?').run(keep.id);
    if (!db.prepare('SELECT 1 FROM ResourceOverride WHERE resource_id = ?').get(keep.id)) {
      db.prepare('UPDATE ResourceOverride SET resource_id = ? WHERE resource_id = ?').run(keep.id, r.id);
    }
    db.prepare('DELETE FROM Resource WHERE id = ?').run(r.id);
    merged++;
  }
  db.prepare('UPDATE OR IGNORE HolidayFile SET file_path = ? WHERE file_path = ?').run(to, from);
  db.prepare('DELETE FROM HolidayFile WHERE file_path = ?').run(from);
  // The stale Air Spec row describes a file that is not there; the found path
  // has (or will get, on the next Air Spec scan) a row of its own.
  if (db.prepare('SELECT 1 FROM TranscodeItem WHERE file_path = ?').get(to)) {
    db.prepare('DELETE FROM TranscodeItem WHERE file_path = ?').run(from);
  } else {
    db.prepare("UPDATE TranscodeItem SET file_path = ?, status = 'pending', error = NULL, src_mtime = NULL WHERE file_path = ?").run(to, from);
  }
  return { moved, merged };
}

/**
 * Plan, then apply the unambiguous part in one transaction. Returns the plan
 * plus { applied: { relocated, aliased, rowsMoved, rowsMerged }, exportedDays }.
 */
export async function applyRepair({ deep = false } = {}) {
  const plan = await planRepair({ deep });
  const changes = [...plan.relocate, ...plan.aliases];
  const exportedDays = exportedDaysNaming(changes.map((c) => c.from));
  let rowsMoved = 0, rowsMerged = 0;
  withTx(() => {
    for (const c of changes) {
      const r = movePath(c.from, c.to, c.duration);
      rowsMoved += r.moved;
      rowsMerged += r.merged;
    }
  });
  for (const c of changes) l.info(`${c.why}: ${c.from} → ${c.to}`);
  l.info(`repaired ${plan.relocate.length} missing path(s) and ${plan.aliases.length} alias(es): `
    + `${rowsMoved} row(s) re-pointed, ${rowsMerged} merged; ${plan.notFound.length} still not found, `
    + `${plan.ambiguous.length} ambiguous`);
  return { ...plan, applied: { relocated: plan.relocate.length, aliased: plan.aliases.length, rowsMoved, rowsMerged }, exportedDays };
}
