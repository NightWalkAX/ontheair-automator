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
import { db } from '../db.js';
import { loadConfig } from '../config.js';

const execFileAsync = promisify(execFile);

const VIDEO_EXTS = new Set([
  '.mov', '.mp4', '.m4v', '.mxf', '.avi', '.mkv', '.mpg', '.mpeg', '.ts', '.wmv',
]);

// Show-type codes whose series default to sequential chapter progression.
const SERIAL_DEFAULT_CODES = new Set(['lessons', 'tv_shows']);

/**
 * Infer a series/subject label from a file's path: the immediate parent folder
 * name (the series folder). Files directly under the media root use that root's
 * last path segment.
 */
function detectSubject(filePath, rootPath) {
  const parent = dirname(filePath);
  // Don't let the media root itself become a subject when files sit at its top
  // level with no series folder — fall back to the root's own basename anyway,
  // which is a reasonable label the admin can rename.
  return basename(parent) || basename(rootPath) || null;
}

/**
 * Infer a chapter number from a filename. Prefers an SxxEyy episode marker,
 * else the last standalone integer in the name. Returns 0 when none found
 * (single/standalone).
 */
function detectChapter(fileName) {
  const base = basename(fileName, extname(fileName));
  const ep = base.match(/[Ss]\d{1,3}[\s._-]*[Ee](\d{1,4})/);
  if (ep) return Number(ep[1]);
  const nums = base.match(/\d{1,4}/g);
  if (nums && nums.length) return Number(nums[nums.length - 1]);
  return 0;
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
      INSERT INTO Resource (name, file_path, duration, subject, chapter, is_filler,
                            audience_rating, channel_id, show_type_id, added_at)
      VALUES (@name, @file_path, @duration, @subject, @chapter, @is_filler,
              @audience_rating, @channel_id, @show_type_id, @added_at)
      ON CONFLICT(file_path) DO UPDATE SET
        duration     = excluded.duration,
        channel_id   = excluded.channel_id,
        show_type_id = excluded.show_type_id,
        added_at     = excluded.added_at
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
 * Scan one MediaRoot row and upsert its Resource rows. Subject/chapter are
 * detected from the folder/filename on first insert; the Fillers show type
 * marks its resources is_filler=1 (and leaves subject null). Newly-seen series
 * are registered in ChannelSeries.
 * Returns { scanned, ingested, errors }.
 */
export async function scanMediaRoot(mediaRoot) {
  const showType = db.prepare('SELECT code, is_filler FROM ShowType WHERE id = ?').get(mediaRoot.show_type_id);
  const isFiller = showType?.is_filler ? 1 : 0;
  const isSerialDefault = showType ? SERIAL_DEFAULT_CODES.has(showType.code) : false;

  const files = await collectVideoFiles(mediaRoot.path);
  let ingested = 0;
  const errors = [];
  const subjects = new Set();

  for (const file of files) {
    try {
      const duration = await probeDuration(file);
      if (duration == null) {
        errors.push({ file, error: 'no duration from ffprobe' });
        continue;
      }
      const info = await stat(file);
      const subject = isFiller ? null : detectSubject(file, mediaRoot.path);
      const chapter = isFiller ? 0 : detectChapter(file);
      if (subject) subjects.add(subject);
      upsert({
        name: basename(file, extname(file)),
        file_path: file,
        duration,
        subject,
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
