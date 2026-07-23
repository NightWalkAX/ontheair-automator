// Media ingestion worker (Module A input).
//
// Scans each MediaRoot's folder tree with ffprobe and upserts channel-tagged
// Resource rows. Every resource is tagged with the channel_id + show_type_id of
// the MediaRoot it came from, because each of the 6 channels owns distinct
// folders on the share (see plan / SEED.md deviation note).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { db } from '../db.js';
import { loadConfig } from '../config.js';

const execFileAsync = promisify(execFile);

const VIDEO_EXTS = new Set([
  '.mov', '.mp4', '.m4v', '.mxf', '.avi', '.mkv', '.mpg', '.mpeg', '.ts', '.wmv',
]);

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
 * Scan one MediaRoot row and upsert its Resource rows.
 * Returns { scanned, ingested, errors }.
 */
export async function scanMediaRoot(mediaRoot) {
  const files = await collectVideoFiles(mediaRoot.path);
  let ingested = 0;
  const errors = [];

  for (const file of files) {
    try {
      const duration = await probeDuration(file);
      if (duration == null) {
        errors.push({ file, error: 'no duration from ffprobe' });
        continue;
      }
      const info = await stat(file);
      upsert({
        name: basename(file, extname(file)),
        file_path: file,
        duration,
        subject: null,          // filled in by admin / naming convention later
        chapter: 0,
        is_filler: 0,
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
