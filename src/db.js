// SQLite access layer.
//
// Uses Node's built-in `node:sqlite` module (stable as of Node 22.5+) so the
// project folder stays free of native binaries that would need rebuilding when
// the app is copied via USB between Macs (Intel vs Apple Silicon). If you must
// run on an older Node, swap this module for `better-sqlite3` — the exported
// surface (`db`, prepared-statement style) is intentionally close.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'scheduler.sqlite');

mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Enforce foreign keys on every connection (per SEED.md §3).
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

// --- Schema -----------------------------------------------------------------
// Created idempotently on startup. Deviations from SEED.md §3 are commented
// inline; they are code-level refinements flagged in the approved plan, not a
// silent redesign.

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ChannelType (
      id           INTEGER PRIMARY KEY,
      name         TEXT NOT NULL,
      is_active    INTEGER NOT NULL DEFAULT 1,   -- boolean (0/1)
      api_ip       TEXT,
      api_port     INTEGER,
      -- Which OTAV playlist to push into: an index ("0") or a unique_id.
      -- Defaults to index 0 (the first open playlist) when null.
      playlist_ref TEXT,
      -- Optional OTAV auth (only used if that instance requires it).
      api_username TEXT,
      api_password TEXT
    );

    CREATE TABLE IF NOT EXISTS ShowType (
      id             INTEGER PRIMARY KEY,
      name           TEXT NOT NULL,
      is_educational INTEGER NOT NULL DEFAULT 0
      -- NOTE: SEED.md's ShowType.paths (JSON array) is intentionally removed.
      -- Media roots are per-channel + per-showtype, so they live in the
      -- MediaRoot table below rather than as a flat array here.
    );

    CREATE TABLE IF NOT EXISTS MediaRoot (
      id           INTEGER PRIMARY KEY,
      channel_id   INTEGER NOT NULL REFERENCES ChannelType(id) ON DELETE CASCADE,
      show_type_id INTEGER NOT NULL REFERENCES ShowType(id)    ON DELETE CASCADE,
      path         TEXT NOT NULL,             -- absolute local path under the SMB mount
      UNIQUE (channel_id, show_type_id, path)
    );

    CREATE TABLE IF NOT EXISTS Resource (
      id              INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      file_path       TEXT NOT NULL UNIQUE,   -- absolute local mount path
      duration        INTEGER NOT NULL,       -- seconds
      subject         TEXT,
      chapter         INTEGER NOT NULL DEFAULT 0,
      is_filler       INTEGER NOT NULL DEFAULT 0,
      audience_rating INTEGER,
      -- Refinements flagged in the plan:
      channel_id      INTEGER REFERENCES ChannelType(id) ON DELETE CASCADE,
      show_type_id    INTEGER REFERENCES ShowType(id)    ON DELETE SET NULL,
      added_at        TEXT                    -- file mtime, drives Sunday "latest episode" pick
    );

    CREATE TABLE IF NOT EXISTS BlockTemplate (
      id                INTEGER PRIMARY KEY,
      channel_id        INTEGER NOT NULL REFERENCES ChannelType(id) ON DELETE CASCADE,
      name              TEXT NOT NULL,
      weekday           TEXT NOT NULL,        -- 'Mon'..'Sun'
      start_time        TEXT NOT NULL,        -- 'HH:MM'
      end_time          TEXT NOT NULL,        -- 'HH:MM'
      target_subject_id INTEGER,
      -- Refinement: SEED has target_subject_id (INTEGER) but no Subject table.
      -- Resource scoping is by the TEXT subject label, so templates carry the
      -- label directly here. Null = draw from the whole channel pool.
      target_subject    TEXT,
      -- Refinement: tells the population engine which rule set to apply.
      content_type      TEXT NOT NULL DEFAULT 'movie'  -- 'lesson_series'|'movie'|'tv_episode'
    );

    CREATE TABLE IF NOT EXISTS ScheduledBlock (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,              -- 'YYYY-MM-DD'
      status      TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'approved'|'exported'
      UNIQUE (template_id, target_date)
    );

    CREATE TABLE IF NOT EXISTS ScheduleItem (
      id                 INTEGER PRIMARY KEY,
      block_id           INTEGER NOT NULL REFERENCES ScheduledBlock(id) ON DELETE CASCADE,
      resource_id        INTEGER NOT NULL REFERENCES Resource(id)       ON DELETE CASCADE,
      play_order         INTEGER NOT NULL,
      is_manual_override INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS PlayHistory (
      id          INTEGER PRIMARY KEY,
      resource_id INTEGER NOT NULL REFERENCES Resource(id)    ON DELETE CASCADE,
      channel_id  INTEGER NOT NULL REFERENCES ChannelType(id) ON DELETE CASCADE,
      played_at   TEXT NOT NULL                -- ISO datetime
    );

    CREATE INDEX IF NOT EXISTS idx_resource_channel   ON Resource(channel_id, is_filler);
    CREATE INDEX IF NOT EXISTS idx_resource_subject   ON Resource(channel_id, subject, chapter);
    CREATE INDEX IF NOT EXISTS idx_playhistory_lookup ON PlayHistory(channel_id, resource_id, played_at);
    CREATE INDEX IF NOT EXISTS idx_scheduleitem_block ON ScheduleItem(block_id, play_order);
    CREATE INDEX IF NOT EXISTS idx_scheduledblock_date ON ScheduledBlock(target_date, status);
  `);

  // Lightweight migrations for DBs created before a column was added. Each is
  // guarded so re-running is a no-op.
  addColumnIfMissing('ChannelType', 'playlist_ref', 'TEXT');
  addColumnIfMissing('ChannelType', 'api_username', 'TEXT');
  addColumnIfMissing('ChannelType', 'api_password', 'TEXT');
  addColumnIfMissing('BlockTemplate', 'target_subject', 'TEXT');
}

function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export { DB_PATH };
