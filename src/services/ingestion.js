// Media ingestion worker (Module A input).
//
// Scans each MediaRoot's folder tree with ffprobe and upserts channel-tagged
// Resource rows. Every resource is tagged with the channel_id + show_type_id of
// the MediaRoot it came from, because each of the 6 channels owns distinct
// folders on the share (see plan / SEED.md deviation note).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename, dirname } from 'node:path';
import { db, withTx } from '../db.js';
import { loadConfig, localizePath, delocalizePath } from '../config.js';
import { parseEpisode, encodeChapter } from './episodeParse.js';
import { groupSagas, sagaSubjectName } from './movieSaga.js';
import { log, progressLogger } from '../logger.js';

const execFileAsync = promisify(execFile);

// A media tree is a handful of levels deep. Anything past this is a symlink or
// mount loop, and walking it forever is indistinguishable from a freeze.
const MAX_WALK_DEPTH = 24;

const VIDEO_EXTS = new Set([
  '.mov', '.mp4', '.m4v', '.mxf', '.avi', '.mkv', '.mpg', '.mpeg', '.ts', '.wmv',
]);

// Show-type codes whose series default to sequential chapter progression.
const SERIAL_DEFAULT_CODES = new Set(['lessons', 'tv_shows']);

// Show-type codes whose flat folders get franchise (saga) detection: movies
// arrive as standalone files with the sequel number in the filename rather than
// in a folder, so the only way to surface "Toy Story" as its own series is to
// read the whole folder at once. See services/movieSaga.js.
const SAGA_CODES = new Set(['movies']);

// A clip is auto-classified as a filler when it lives inside a folder named
// "Filler"/"Fillers", at any duration. (Explicitly assigning a root to the
// Fillers show type marks its clips regardless of folder name too.)

/** True if any segment of the path is (case-insensitively) "filler"/"fillers". */
function looksLikeFillerFolder(filePath) {
  return dirname(filePath)
    .split(/[\\/]/)
    .some((seg) => /^fillers?$/i.test(seg));
}

/** True if a folder name is a bare "season" folder (Season 1 / S01 / Temporada 2). */
function looksLikeSeasonFolder(name) {
  return /^season\s*\d+/i.test(name) || /^s\d{1,3}$/i.test(name) || /^temporada\s*\d+/i.test(name);
}

/**
 * Infer a series/subject label from a file's path: normally the immediate parent
 * folder name (the series folder). When that parent is a bare "Season N" folder,
 * climb to the grandparent (the show folder) so nested seasons group under one
 * show instead of scattering into per-season subjects. Files directly under the
 * media root fall back to the root's own basename. Free-standing season folders
 * (no show folder above) keep the season label and can be merged in the editor.
 */
function detectSubject(filePath, rootPath) {
  const parent = dirname(filePath);
  const parentName = basename(parent);
  if (parentName && looksLikeSeasonFolder(parentName)) {
    const grandparent = basename(dirname(parent));
    // Only climb when the grandparent is a real folder above the root, not the
    // root itself or the filesystem root.
    if (grandparent && dirname(parent) !== dirname(rootPath) && !looksLikeSeasonFolder(grandparent)) {
      return grandparent;
    }
  }
  // Don't let the media root itself become a subject when files sit at its top
  // level with no series folder — fall back to the root's own basename anyway,
  // which is a reasonable label the admin can rename.
  return parentName || basename(rootPath) || null;
}

/**
 * Infer { season, chapter } from a filename. Season is parsed from SxxEyy / NxNN
 * / "Season N Episode M" markers (see services/episodeParse.js) and stored as a
 * display/organization level (the "season folder" inside a show); chapter is the
 * global monotonic ordering key the engine plays by. Season-less content gets a
 * null season and its plain episode number as the chapter.
 */
function detectEpisode(fileName) {
  const { season, episode } = parseEpisode(basename(fileName, extname(fileName)));
  return { season, chapter: encodeChapter(season, episode) };
}

/**
 * Re-file a scanned set of movie rows into per-franchise series.
 *
 * Runs WITHIN each detected subject (normally the one flat "Movies" folder, but a
 * root that already has franchise subfolders keeps them scoped), and mutates the
 * rows in place: a saga member takes the franchise as its subject and its part as
 * its chapter, so the engine can play the franchise in order and the catalog
 * shows it as its own folder. A standalone film keeps its folder subject and gets
 * chapter 0 — the generic "last integer in the name" fallback would otherwise
 * leave junk ordinals like 2019 for "Aladdin_2019" or 102 for "102_Dalmatians".
 *
 * Returns { subjects, sagaSubjects } — every subject the rows now use, and which
 * of those are franchises (registered as serial, so they play in part order).
 */
function applySagaGrouping(rows) {
  const subjects = new Set();
  const sagaSubjects = new Set();
  const bySubject = new Map();
  for (const r of rows) {
    if (r.is_filler || !r.subject) continue;
    if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
    bySubject.get(r.subject).push(r);
  }
  // A franchise name already used by another show type on this channel would
  // merge the films into that series (and collide their chapters), so it gets a
  // qualified name instead. Scanned-but-unwritten rows count as taken too.
  const channelId = rows[0]?.channel_id;
  const showTypeId = rows[0]?.show_type_id;
  const taken = db.prepare(
    'SELECT 1 AS x FROM Resource WHERE channel_id = ? AND subject = ? AND show_type_id IS NOT ? LIMIT 1'
  );
  const isTaken = (name) =>
    name !== undefined &&
    (!!taken.get(channelId, name, showTypeId ?? null) || sagaSubjects.has(name));

  for (const [subject, group] of bySubject) {
    const { sagas } = groupSagas(group.map((r) => ({ id: r.file_path, name: r.name })));
    const partOf = new Map(); // file_path -> { base, part }
    for (const [rawBase, members] of sagas) {
      const base = rawBase === subject ? rawBase : sagaSubjectName(rawBase, isTaken);
      sagaSubjects.add(base);
      for (const m of members) partOf.set(m.id, { base, part: m.part });
    }
    for (const r of group) {
      const hit = partOf.get(r.file_path);
      if (hit) {
        r.subject = hit.base;
        r.season = null;
        r.chapter = hit.part;
      } else {
        r.chapter = 0; // standalone film — no meaningful ordinal
      }
      subjects.add(r.subject);
    }
    if (!sagas.size) subjects.add(subject);
  }
  return { subjects, sagaSubjects };
}

/** Probe a single file's duration (seconds, rounded) via ffprobe. */
async function probeDuration(filePath) {
  // FFPROBE_PATH env overrides config, so tests can inject a fake probe.
  const ffprobePath = process.env.FFPROBE_PATH || loadConfig().ffprobePath;
  const { stdout } = await execFileAsync(ffprobePath || 'ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? Math.round(seconds) : null;
}

/**
 * Recursively collect video file paths under a directory.
 *
 * Cycle-safe by IDENTITY, not by depth. Over SMB a symlink on the server can
 * reach the client as a real DIRECTORY (Samba's `follow symlinks` / `wide
 * links`), so `entry.isDirectory()` is true and a link pointing back at an
 * ancestor turns the walk into A/B/A/B/… Bounding the depth only bounds how bad
 * that gets: every level re-enumerates the whole subtree, so one link inflates
 * a folder ~24x and two links multiply rather than add. That is how ~5k real
 * clips get reported as 196014 files to scan.
 *
 * So each directory's dev:ino is recorded and never walked twice, whatever path
 * led to it. Files are de-duplicated the same way, so a clip reachable by two
 * paths is probed once. The depth cap stays as a backstop for a filesystem that
 * cannot give stable inodes.
 */
/** Does this path resolve to a directory? (Follows links; false if unreadable.) */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;   // dangling link, or no permission — nothing to walk
  }
}

async function collectVideoFiles(dir, acc = null, depth = 0, stats = null) {
  const walk = stats || {
    dirs: 0, unreadable: 0, loops: 0, startedAt: Date.now(), reported: 0, root: dir,
    seenDirs: new Set(), seenFiles: new Set(), files: [],
  };
  const out = acc || walk.files;

  if (depth > MAX_WALK_DEPTH) {
    log('scan').warn(`stopped at depth ${depth}: ${dir} (symlink or mount loop?)`);
    return out;
  }

  // Identity first: if this directory has already been walked under another
  // name, everything below it is already in `out`.
  let dirInfo = null;
  try {
    dirInfo = await stat(dir);
  } catch (err) {
    walk.unreadable++;
    log('scan').warn(`unreadable directory (skipped): ${dir} — ${err.code || err.message}`);
    return out;
  }
  const dirKey = `${dirInfo.dev}:${dirInfo.ino}`;
  if (dirInfo.ino && walk.seenDirs.has(dirKey)) {
    walk.loops++;
    log('scan').warn(`already walked this directory under another path, skipping: ${dir} `
      + '(a symlink or bind mount points back into the tree)');
    return out;
  }
  if (dirInfo.ino) walk.seenDirs.add(dirKey);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    walk.unreadable++;
    // Silent skips are how a whole channel quietly comes back empty.
    log('scan').warn(`unreadable directory (skipped): ${dir} — ${err.code || err.message}`);
    return out;
  }
  walk.dirs++;
  if (Date.now() - walk.reported > 15_000) {
    walk.reported = Date.now();
    log('scan').info(`walking · ${walk.dirs} dir(s), ${out.length} file(s) so far`
      + `${walk.loops ? `, ${walk.loops} loop(s) skipped` : ''} · at ${dir}`);
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    // A symlinked folder is followed too. Over SMB the server resolves it and
    // readdir already calls it a directory, so the client cannot tell the
    // difference — treating it as one locally makes the two consistent, and
    // stops a linked folder on a Mac share from being silently invisible. It is
    // only safe because of the identity check above.
    const isDir = entry.isDirectory()
      || (entry.isSymbolicLink() && await isDirectory(full));
    if (isDir) {
      await collectVideoFiles(full, out, depth + 1, walk);
    } else if (VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
      // Same identity rule for files: a clip reachable by two paths is one clip.
      try {
        const fi = await stat(full);
        const key = `${fi.dev}:${fi.ino}`;
        if (fi.ino && walk.seenFiles.has(key)) continue;
        if (fi.ino) walk.seenFiles.add(key);
      } catch { /* fall through and let the probe report it */ }
      out.push(full);
    }
  }

  if (depth === 0) {
    log('scan').info(`walked ${walk.dirs} dir(s) in ${Math.round((Date.now() - walk.startedAt) / 1000)}s: `
      + `${out.length} video file(s)`
      + `${walk.unreadable ? `, ${walk.unreadable} unreadable` : ''}`
      + `${walk.loops ? `, ${walk.loops} directory loop(s) skipped` : ''}`);
    if (walk.loops) {
      log('scan').warn(`${walk.loops} directory loop(s) under ${dir} — something in the tree links `
        + 'back into itself. Without the identity check this walk would have reported many times '
        + 'more files than exist.');
    }
  }
  return out;
}

// Prepared lazily: the module may be imported before initSchema() has created
// the tables (ESM imports run before server.js's init call).
let _upsertStmt = null;
function upsert(row) {
  if (!_upsertStmt) {
    _upsertStmt = db.prepare(`
      INSERT INTO Resource (name, file_path, duration, subject, season, chapter, is_filler,
                            audience_rating, channel_id, show_type_id, added_at)
      VALUES (@name, @file_path, @duration, @subject, @season, @chapter, @is_filler,
              @audience_rating, @channel_id, @show_type_id, @added_at)
      ON CONFLICT(channel_id, file_path) DO UPDATE SET
        duration     = excluded.duration,
        is_filler    = excluded.is_filler,
        show_type_id = excluded.show_type_id,
        added_at     = excluded.added_at,
        -- A clip re-scanned as a filler loses its old series/season/chapter;
        -- otherwise keep the operator's edits (never clobbered by re-scan).
        subject      = CASE WHEN excluded.is_filler = 1 THEN NULL ELSE subject END,
        season       = CASE WHEN excluded.is_filler = 1 THEN NULL ELSE season END,
        chapter      = CASE WHEN excluded.is_filler = 1 THEN 0    ELSE chapter END
    `);
  }
  return _upsertStmt.run(row);
}

/**
 * Register any newly-seen (channel, subject) pairs in ChannelSeries so the admin
 * can order/toggle them. Existing rows are never clobbered (INSERT OR IGNORE),
 * so admin ordering/flags survive re-scans. Filler content (null subject) is
 * skipped — fillers are a channel-wide pool, not a series.
 *
 * `serialSubjects` marks individual subjects serial even when the show type's
 * default is standalone — used for detected movie franchises.
 */
function registerSeries(channelId, subjects, showTypeId, isSerialDefault, serialSubjects = null) {
  if (!subjects.size) return;
  const nextOrder = db.prepare(
    'SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ChannelSeries WHERE channel_id = ?'
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ChannelSeries
      (channel_id, subject, show_type_id, is_serial, is_active, play_order)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  for (const subject of subjects) {
    // A detected franchise is serial regardless of its show type's default: the
    // whole point of splitting it out is to play its parts in order.
    const serial = isSerialDefault || serialSubjects?.has(subject) ? 1 : 0;
    insert.run(channelId, subject, showTypeId ?? null, serial, nextOrder.get(channelId).n);
  }
}

/**
 * Clone already-cataloged Resource rows (and their overrides) from a donor
 * channel into `newChannelId`, for a folder that was just assigned to another
 * channel. Avoids a fresh ffprobe pass: the same physical files already have
 * durations + operator subject/chapter/name fixes (and review state) under some
 * other channel.
 * Matches the root path as a subtree (path itself or path/...). No-op (returns
 * 0) when no donor exists — the caller then falls back to a normal scan.
 * Returns the number of resources cloned.
 */
export function cloneScannedResources(newChannelId, showTypeId, path) {
  const like = path.replace(/[\\%_]/g, (m) => '\\' + m) + '/%';
  // Donor rows: same file (path or subtree) cataloged under a different channel.
  const donors = db.prepare(`
    SELECT * FROM Resource
    WHERE channel_id != ? AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')
    GROUP BY file_path
  `).all(newChannelId, path, like);
  if (!donors.length) return 0;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO Resource
      (name, file_path, duration, subject, season, chapter, is_filler, audience_rating,
       channel_id, show_type_id, added_at, last_used_at, sort_order, approved)
    VALUES
      (@name, @file_path, @duration, @subject, @season, @chapter, @is_filler, @audience_rating,
       @channel_id, @show_type_id, @added_at, @last_used_at, @sort_order, @approved)
  `);
  const idFor = db.prepare('SELECT id FROM Resource WHERE channel_id = ? AND file_path = ?');
  const getOverride = db.prepare('SELECT * FROM ResourceOverride WHERE resource_id = ?');
  const putOverride = db.prepare(`
    INSERT OR IGNORE INTO ResourceOverride
      (resource_id, display_name, detected_subject, detected_chapter)
    VALUES (?, ?, ?, ?)
  `);

  // Which show type each cloned file gets. The root being added covers the whole
  // subtree, but the destination channel may already have DEEPER roots inside it
  // with a type of their own — forcing the new root's type over everything is
  // how 971 lesson files ended up catalogued as Movies on two channels, and from
  // there into movie blocks. Deepest containing root wins; the new root is the
  // fallback for anything no deeper root claims.
  const roots = db.prepare(
    'SELECT path, show_type_id FROM MediaRoot WHERE channel_id = ? ORDER BY LENGTH(path) DESC'
  ).all(newChannelId);
  const typeFor = (filePath) => {
    for (const r of roots) {
      if (filePath === r.path || filePath.startsWith(r.path + '/')) return r.show_type_id;
    }
    return showTypeId ?? null;
  };

  const subjects = new Set();
  const byType = new Map(); // show_type_id -> subjects, so ChannelSeries is typed right too
  let cloned = 0;
  withTx(() => {
    for (const d of donors) {
      const info = insert.run({
        name: d.name, file_path: d.file_path, duration: d.duration,
        subject: d.subject, season: d.season ?? null, chapter: d.chapter, is_filler: d.is_filler,
        audience_rating: d.audience_rating, channel_id: newChannelId,
        show_type_id: typeFor(d.file_path) ?? d.show_type_id, added_at: d.added_at,
        last_used_at: d.last_used_at ?? null, sort_order: d.sort_order ?? null,
        // Carry the donor's review state: these are the same physical files the
        // operator already vetted, so a shared folder is schedulable on arrival
        // instead of needing a second pass through the Catalog Editor.
        approved: d.approved ?? 0,
      });
      if (!info.changes) continue; // already present for this channel
      cloned++;
      if (d.subject) {
        subjects.add(d.subject);
        const t = typeFor(d.file_path) ?? d.show_type_id;
        if (!byType.has(t)) byType.set(t, new Set());
        byType.get(t).add(d.subject);
      }
      const ov = getOverride.get(d.id);
      if (ov) {
        const newId = idFor.get(newChannelId, d.file_path)?.id;
        if (newId) putOverride.run(newId, ov.display_name, ov.detected_subject, ov.detected_chapter);
      }
    }
  });

  // Register each subject under the show type its files actually got, not the
  // new root's — otherwise a lesson series lands in ChannelSeries as a movie
  // franchise and a movie block will happily cycle it.
  for (const [typeId, subs] of byType) {
    const showType = db.prepare('SELECT code FROM ShowType WHERE id = ?').get(typeId);
    const isSerialDefault = showType ? SERIAL_DEFAULT_CODES.has(showType.code) : false;
    registerSeries(newChannelId, subs, typeId, isSerialDefault);
  }
  return cloned;
}

/**
 * Scan one MediaRoot row and upsert its Resource rows. Subject/chapter are
 * detected from the folder/filename on first insert; the Fillers show type
 * marks its resources is_filler=1 (and leaves subject null). Newly-seen series
 * are registered in ChannelSeries.
 * Returns { scanned, ingested, errors }.
 */
/**
 * Ingest one media root.
 *
 * `force` re-probes every file. Without it, a file whose path is already
 * catalogued for this channel AND whose mtime still matches what was recorded
 * reuses its stored duration instead of paying for another ffprobe. That is the
 * whole cost of a re-scan: the directory walk is seconds, the probe is one
 * process spawn and a container read per file over SMB, thousands of times.
 *
 * mtime is the right key because it is what this function already stores in
 * `added_at`, and because the two ways a file's duration can change both move
 * it: an operator replacing the file, and Air Spec swapping in a converted one
 * (which also lands at a new path). Any mismatch — a different clock, a format
 * this build did not write, a missing duration — falls through to a probe, so
 * the failure mode is "slower", never "stale".
 *
 * Rows are still BUILT for skipped files: franchise detection weighs a title
 * against every other title in the folder, so leaving them out would break
 * saga grouping and series registration on every re-scan.
 */
export async function scanMediaRoot(mediaRoot, { force = false } = {}) {
  const showType = db.prepare('SELECT code, is_filler FROM ShowType WHERE id = ?').get(mediaRoot.show_type_id);
  const typeIsFiller = showType?.is_filler ? 1 : 0;
  const isSerialDefault = showType ? SERIAL_DEFAULT_CODES.has(showType.code) : false;

  // Walk the tree via the LOCAL path (config.pathMap), but store every
  // file_path in canonical (OTAV Mac) form — that string is what gets pushed
  // as the clip url, so it must be valid on the playout Mac, not here.
  const l = log('scan');
  l.info(`root ${mediaRoot.path} (channel ${mediaRoot.channel_id}, show type ${mediaRoot.show_type_id})`);
  let files = await collectVideoFiles(localizePath(mediaRoot.path));

  // A file inside a DEEPER root of the same channel belongs to that root, not to
  // this one — the deepest root wins, the same rule cloneScannedResources() and
  // the catalogue repair use. Without this the two roots both catalogue the file
  // and the LAST one scanned decides its show type, so a lesson folder sitting
  // inside a TV Shows root (Local Shows/Math Intervention) would flip type on
  // every re-scan depending on the order the roots happen to come out of the
  // table. Skipping here also means the file is walked once, not twice.
  const deeper = db.prepare(
    "SELECT path FROM MediaRoot WHERE channel_id = ? AND id != ? AND path LIKE ? ESCAPE '\\' AND LENGTH(path) > LENGTH(?)"
  ).all(mediaRoot.channel_id, mediaRoot.id, mediaRoot.path.replace(/[%_\\]/g, '\\$&') + '/%', mediaRoot.path)
    .map((r) => localizePath(r.path));
  if (deeper.length) {
    const before = files.length;
    files = files.filter((f) => !deeper.some((d) => f === d || f.startsWith(d + '/')));
    if (before !== files.length) {
      l.info(`root ${mediaRoot.path}: ${before - files.length} file(s) belong to a deeper root of this channel`);
    }
  }
  const errors = [];
  let subjects = new Set();
  // One ffprobe + one stat per file over SMB: thousands of round trips, and
  // until now it reported nothing at all until the whole thing finished. The
  // progress line carries rate, ETA and RSS so a run that looks frozen can be
  // told apart from one that is merely slow, or leaking.
  const progress = progressLogger('scan', files.length, { stepWarnMs: 20_000 });
  progress.start(mediaRoot.path);

  // What this channel already knows, so an unchanged file costs a stat instead
  // of an ffprobe. One query beats one lookup per file.
  const cataloged = new Map();
  if (!force) {
    for (const r of db.prepare(
      'SELECT file_path, duration, added_at FROM Resource WHERE channel_id = ?',
    ).all(mediaRoot.channel_id)) cataloged.set(r.file_path, r);
  }
  let probed = 0;
  let reused = 0;

  // Probe first, upsert after. Franchise detection needs to weigh a title against
  // every OTHER title in the folder (a lone "Big_Hero_6" is not a sequel, two
  // "Angry_Birds_N" are), so the rows are staged before any of them is written.
  const rows = [];
  for (const localFile of files) {
    const file = delocalizePath(localFile);
    const stepStart = Date.now();
    try {
      // stat comes first: its mtime is both what gets stored and what decides
      // whether the probe can be skipped.
      const info = await stat(localFile);
      const mtime = info.mtime.toISOString();
      const known = cataloged.get(file);
      let duration;
      if (known && known.added_at === mtime && known.duration > 0) {
        duration = known.duration;
        reused++;
      } else {
        duration = await probeDuration(localFile);
        probed++;
        if (duration == null) {
          errors.push({ file, error: 'no duration from ffprobe' });
          progress.step(basename(file), Date.now() - stepStart);
          continue;
        }
      }
      // Filler if the root's show type is the Fillers type, OR the clip sits in a
      // "Filler(s)" folder — any length (the operator explicitly organizes these
      // as fillers, so no duration cap).
      const isFiller = typeIsFiller || (looksLikeFillerFolder(file) ? 1 : 0);
      const subject = isFiller ? null : detectSubject(file, mediaRoot.path);
      const { season, chapter } = isFiller ? { season: null, chapter: 0 } : detectEpisode(file);
      rows.push({
        name: basename(file, extname(file)),
        file_path: file,
        duration,
        subject,
        season,
        chapter,
        is_filler: isFiller,
        audience_rating: null,
        channel_id: mediaRoot.channel_id,
        show_type_id: mediaRoot.show_type_id,
        added_at: mtime,
      });
    } catch (err) {
      errors.push({ file, error: String(err.message || err) });
      l.warn(`probe failed: ${file} — ${err.message || err}`);
    }
    progress.step(basename(file), Date.now() - stepStart);
  }
  progress.done(`${probed} probed, ${reused} unchanged (probe skipped), ${errors.length} error(s)`);

  let sagaSubjects = null;
  if (SAGA_CODES.has(showType?.code)) {
    ({ subjects, sagaSubjects } = applySagaGrouping(rows));
  } else {
    for (const r of rows) if (r.subject) subjects.add(r.subject);
  }

  // The writes are synchronous SQLite, so this DOES block the event loop —
  // worth timing, because thousands of rows is where "the whole app froze for a
  // moment" comes from and the watchdog will name it.
  const writeStart = Date.now();
  let ingested = 0;
  for (const row of rows) {
    upsert(row);
    ingested++;
  }
  registerSeries(mediaRoot.channel_id, subjects, mediaRoot.show_type_id, isSerialDefault, sagaSubjects);
  l.info(`root ${mediaRoot.path} done · ${ingested} row(s) written in `
    + `${Math.round((Date.now() - writeStart) / 1000)}s · ${subjects.size} subject(s) · ${errors.length} error(s)`);
  return { scanned: files.length, ingested, probed, reused, errors };
}

/**
 * Re-check the clips ALREADY catalogued for a channel, without walking the NAS.
 *
 * scanMediaRoot() exists to DISCOVER files, so it has to readdir every folder
 * under every media root — the whole share, whether or not any of it is
 * catalogued. That is the right operation when new content has been dropped in,
 * and the wrong one when the question is "are the clips I already have still
 * correct?": the walk is the part that takes an age over SMB and the part that
 * hangs when the mount goes away.
 *
 * This takes the file list from the DATABASE instead — one query, zero
 * directory listings — and per file does the cheap thing first:
 *
 *   gone      the row points at a file that is not there any more. REPORTED,
 *             never deleted: a clip that vanished may be a share hiccup, and a
 *             catalogue that silently shrinks is worse than one that is wrong
 *             out loud. It is what makes a scheduled block fail on air, so it
 *             is the headline number.
 *   unchanged mtime still matches the stored added_at -> nothing to do.
 *   changed   mtime moved -> re-probe and update duration + added_at.
 *
 * `force` re-probes every present file regardless of mtime.
 *
 * Distinct PHYSICAL files are probed once even when several channels catalogue
 * the same path, and every row for that path is updated together.
 */
export async function recheckCatalog({ channelId = null, force = false } = {}) {
  const l = log('recheck');
  const files = db.prepare(`
    SELECT file_path,
           MIN(duration) AS duration,
           MIN(added_at) AS added_at,
           COUNT(*)      AS rows_for_path
    FROM Resource
    ${channelId ? 'WHERE channel_id = ?' : ''}
    GROUP BY file_path
    ORDER BY file_path
  `).all(...(channelId ? [channelId] : []));

  l.info(`re-checking ${files.length} catalogued file(s)`
    + `${channelId ? ` for channel ${channelId}` : ' across every channel'}`
    + `${force ? ' · FORCED: re-probing everything' : ''} · no directory walk`);

  const progress = progressLogger('recheck', files.length, { stepWarnMs: 20_000 });
  progress.start(channelId ? `channel ${channelId}` : 'every channel');

  const updateDuration = db.prepare(
    'UPDATE Resource SET duration = ?, added_at = ? WHERE file_path = ?',
  );

  const missing = [];
  const errors = [];
  let unchanged = 0;
  let probed = 0;
  let updated = 0;

  for (const row of files) {
    const stepStart = Date.now();
    const localFile = localizePath(row.file_path);
    try {
      let info;
      try {
        info = await stat(localFile);
      } catch (err) {
        if (err.code === 'ENOENT') {
          missing.push({ file: row.file_path, rows: row.rows_for_path });
          l.warn(`MISSING on disk (still catalogued): ${row.file_path}`);
        } else {
          // EACCES, or the mount having gone away — not the same thing as gone,
          // and saying so is the difference between "fix permissions" and
          // "somebody deleted a film".
          errors.push({ file: row.file_path, error: `${err.code || ''} ${err.message}`.trim() });
          l.warn(`unreadable (NOT treated as missing): ${row.file_path} — ${err.code || err.message}`);
        }
        progress.step(basename(row.file_path), Date.now() - stepStart);
        continue;
      }

      const mtime = info.mtime.toISOString();
      if (!force && row.added_at === mtime && row.duration > 0) {
        unchanged++;
        progress.step(basename(row.file_path), Date.now() - stepStart);
        continue;
      }

      const duration = await probeDuration(localFile);
      probed++;
      if (duration == null) {
        errors.push({ file: row.file_path, error: 'no duration from ffprobe' });
        l.warn(`probe returned no duration: ${row.file_path}`);
        progress.step(basename(row.file_path), Date.now() - stepStart);
        continue;
      }
      if (duration !== row.duration || mtime !== row.added_at) {
        updateDuration.run(duration, mtime, row.file_path);
        updated++;
        if (duration !== row.duration) {
          l.info(`duration changed: ${row.file_path} ${row.duration}s -> ${duration}s`
            + ` (${row.rows_for_path} catalogue row(s) updated)`);
        }
      }
    } catch (err) {
      errors.push({ file: row.file_path, error: String(err.message || err) });
      l.warn(`re-check failed: ${row.file_path} — ${err.message || err}`);
    }
    progress.step(basename(row.file_path), Date.now() - stepStart);
  }

  progress.done(`${unchanged} unchanged, ${probed} probed, ${updated} updated, `
    + `${missing.length} missing, ${errors.length} error(s)`);
  if (missing.length) {
    l.warn(`${missing.length} catalogued clip(s) are no longer on disk — a block holding one of `
      + 'these will fail on air. Nothing was deleted; review them in the Catalog Editor.');
  }
  return {
    checked: files.length, unchanged, probed, updated, missing, errors,
  };
}

/**
 * Scan every MediaRoot (optionally filtered to one channel).
 * `force` re-probes files that are already catalogued and unchanged.
 */
export async function scanAll({ channelId, force = false } = {}) {
  // Deepest first, so the root that actually owns a subtree catalogues it before
  // any ancestor root gets there (scanMediaRoot skips what a deeper root owns;
  // this only keeps the log in a sensible order).
  const rows = channelId
    ? db.prepare('SELECT * FROM MediaRoot WHERE channel_id = ? ORDER BY LENGTH(path) DESC').all(channelId)
    : db.prepare('SELECT * FROM MediaRoot ORDER BY LENGTH(path) DESC').all();

  const l = log('scan');
  l.info(`scanAll · ${rows.length} media root(s)${channelId ? ` for channel ${channelId}` : ''}`
    + `${force ? ' · FORCED: re-probing everything' : ''}`);
  const results = [];
  for (const root of rows) {
    try {
      results.push({ mediaRoot: root, ...(await scanMediaRoot(root, { force })) });
    } catch (err) {
      // One unreachable root must not lose the roots already scanned, and the
      // reason has to survive in the log even if nobody is watching the request.
      l.error(`root ${root.path} FAILED`, err);
      results.push({ mediaRoot: root, scanned: 0, ingested: 0, probed: 0, reused: 0, errors: [{ file: root.path, error: String(err.message || err) }] });
    }
  }
  const sum = (k) => results.reduce((n, r) => n + (r[k] || 0), 0);
  l.info(`scanAll done · ${sum('ingested')} row(s) across ${rows.length} root(s) · `
    + `${sum('probed')} probed, ${sum('reused')} unchanged`);
  return results;
}
