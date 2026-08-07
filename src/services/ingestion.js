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

const execFileAsync = promisify(execFile);

const VIDEO_EXTS = new Set([
  '.mov', '.mp4', '.m4v', '.mxf', '.avi', '.mkv', '.mpg', '.mpeg', '.ts', '.wmv',
]);

// Show-type codes whose series default to sequential chapter progression.
const SERIAL_DEFAULT_CODES = new Set(['lessons', 'tv_shows']);

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

/** Recursively collect video file paths under a directory. */
async function collectVideoFiles(dir, acc = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc; // unreadable dir (permissions / unmounted) — skip
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectVideoFiles(full, acc);
    } else if (VIDEO_EXTS.has(extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
  return acc;
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
 */
function registerSeries(channelId, subjects, showTypeId, isSerialDefault) {
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
    insert.run(channelId, subject, showTypeId ?? null, isSerialDefault ? 1 : 0, nextOrder.get(channelId).n);
  }
}

/**
 * Clone already-cataloged Resource rows (and their overrides) from a donor
 * channel into `newChannelId`, for a folder that was just assigned to another
 * channel. Avoids a fresh ffprobe pass: the same physical files already have
 * durations + operator subject/chapter/name fixes under some other channel.
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
       channel_id, show_type_id, added_at, last_used_at, sort_order)
    VALUES
      (@name, @file_path, @duration, @subject, @season, @chapter, @is_filler, @audience_rating,
       @channel_id, @show_type_id, @added_at, @last_used_at, @sort_order)
  `);
  const idFor = db.prepare('SELECT id FROM Resource WHERE channel_id = ? AND file_path = ?');
  const getOverride = db.prepare('SELECT * FROM ResourceOverride WHERE resource_id = ?');
  const putOverride = db.prepare(`
    INSERT OR IGNORE INTO ResourceOverride
      (resource_id, display_name, detected_subject, detected_chapter)
    VALUES (?, ?, ?, ?)
  `);

  const subjects = new Set();
  let cloned = 0;
  withTx(() => {
    for (const d of donors) {
      const info = insert.run({
        name: d.name, file_path: d.file_path, duration: d.duration,
        subject: d.subject, season: d.season ?? null, chapter: d.chapter, is_filler: d.is_filler,
        audience_rating: d.audience_rating, channel_id: newChannelId,
        show_type_id: showTypeId ?? d.show_type_id, added_at: d.added_at,
        last_used_at: d.last_used_at ?? null, sort_order: d.sort_order ?? null,
      });
      if (!info.changes) continue; // already present for this channel
      cloned++;
      if (d.subject) subjects.add(d.subject);
      const ov = getOverride.get(d.id);
      if (ov) {
        const newId = idFor.get(newChannelId, d.file_path)?.id;
        if (newId) putOverride.run(newId, ov.display_name, ov.detected_subject, ov.detected_chapter);
      }
    }
  });

  const showType = db.prepare('SELECT code FROM ShowType WHERE id = ?').get(showTypeId);
  const isSerialDefault = showType ? SERIAL_DEFAULT_CODES.has(showType.code) : false;
  registerSeries(newChannelId, subjects, showTypeId, isSerialDefault);
  return cloned;
}

/**
 * Scan one MediaRoot row and upsert its Resource rows. Subject/chapter are
 * detected from the folder/filename on first insert; the Fillers show type
 * marks its resources is_filler=1 (and leaves subject null). Newly-seen series
 * are registered in ChannelSeries.
 * Returns { scanned, ingested, errors }.
 */
export async function scanMediaRoot(mediaRoot) {
  const showType = db.prepare('SELECT code, is_filler FROM ShowType WHERE id = ?').get(mediaRoot.show_type_id);
  const typeIsFiller = showType?.is_filler ? 1 : 0;
  const isSerialDefault = showType ? SERIAL_DEFAULT_CODES.has(showType.code) : false;

  // Walk the tree via the LOCAL path (config.pathMap), but store every
  // file_path in canonical (OTAV Mac) form — that string is what gets pushed
  // as the clip url, so it must be valid on the playout Mac, not here.
  const files = await collectVideoFiles(localizePath(mediaRoot.path));
  let ingested = 0;
  const errors = [];
  const subjects = new Set();

  for (const localFile of files) {
    const file = delocalizePath(localFile);
    try {
      const duration = await probeDuration(localFile);
      if (duration == null) {
        errors.push({ file, error: 'no duration from ffprobe' });
        continue;
      }
      // Filler if the root's show type is the Fillers type, OR the clip sits in a
      // "Filler(s)" folder — any length (the operator explicitly organizes these
      // as fillers, so no duration cap).
      const isFiller = typeIsFiller || (looksLikeFillerFolder(file) ? 1 : 0);
      const info = await stat(localFile);
      const subject = isFiller ? null : detectSubject(file, mediaRoot.path);
      const { season, chapter } = isFiller ? { season: null, chapter: 0 } : detectEpisode(file);
      if (subject) subjects.add(subject);
      upsert({
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
        added_at: info.mtime.toISOString(),
      });
      ingested++;
    } catch (err) {
      errors.push({ file, error: String(err.message || err) });
    }
  }

  registerSeries(mediaRoot.channel_id, subjects, mediaRoot.show_type_id, isSerialDefault);
  return { scanned: files.length, ingested, errors };
}

/** Scan every MediaRoot (optionally filtered to one channel). */
export async function scanAll({ channelId } = {}) {
  const rows = channelId
    ? db.prepare('SELECT * FROM MediaRoot WHERE channel_id = ?').all(channelId)
    : db.prepare('SELECT * FROM MediaRoot').all();

  const results = [];
  for (const root of rows) {
    results.push({ mediaRoot: root, ...(await scanMediaRoot(root)) });
  }
  return results;
}
