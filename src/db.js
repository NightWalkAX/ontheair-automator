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
      is_educational INTEGER NOT NULL DEFAULT 0,
      -- Fixed catalogue of 5 show types (Movies, Documentaries, TV Shows,
      -- Lessons, Fillers), seeded below and non-deletable via the API. "code"
      -- is the stable identity the engine/ingestion branch on; "is_filler"
      -- marks the reserved Fillers type (its resources auto-set Resource.is_filler).
      code           TEXT,
      is_filler      INTEGER NOT NULL DEFAULT 0
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
      content_type      TEXT NOT NULL DEFAULT 'movie'  -- DEPRECATED: rule now derived per series
    );

    -- Per-channel registry of the series (a series = a distinct Resource.subject)
    -- that channel plays, with reproduction order and per-series scheduling flags.
    -- Auto-populated by ingestion; ordered/toggled by the admin.
    CREATE TABLE IF NOT EXISTS ChannelSeries (
      id           INTEGER PRIMARY KEY,
      channel_id   INTEGER NOT NULL REFERENCES ChannelType(id) ON DELETE CASCADE,
      subject      TEXT NOT NULL,
      show_type_id INTEGER REFERENCES ShowType(id) ON DELETE SET NULL,
      is_serial    INTEGER NOT NULL DEFAULT 0,   -- 1 = sequential chapter progression
      is_active    INTEGER NOT NULL DEFAULT 1,
      play_order   INTEGER NOT NULL DEFAULT 0,   -- channel-level order (UI default when adding to a block)
      UNIQUE (channel_id, subject)
    );

    -- The subset of series assigned to a block template, in the order the engine
    -- cycles them when populating the block.
    CREATE TABLE IF NOT EXISTS BlockTemplateSeries (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      subject     TEXT NOT NULL,
      play_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (template_id, subject)
    );

    -- Time slots (airings) of a template. slot_order 0 is the primary airing
    -- that picks fresh content; higher slot_order airings strict-mirror it.
    CREATE TABLE IF NOT EXISTS BlockTemplateSlot (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      start_time  TEXT NOT NULL,   -- 'HH:MM'
      end_time    TEXT NOT NULL,
      slot_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (template_id, start_time)
    );

    CREATE TABLE IF NOT EXISTS ScheduledBlock (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      -- Which airing (time slot) of the template this block is. A template can
      -- air the same content at several hours a day; slot_order 0 is the
      -- primary (picks fresh content), the rest strict-mirror it.
      slot_id     INTEGER REFERENCES BlockTemplateSlot(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,              -- 'YYYY-MM-DD'
      status      TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'approved'|'exported'
      UNIQUE (template_id, slot_id, target_date)
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
    CREATE INDEX IF NOT EXISTS idx_channelseries_order ON ChannelSeries(channel_id, play_order);
    CREATE INDEX IF NOT EXISTS idx_bts_template ON BlockTemplateSeries(template_id, play_order);
    CREATE INDEX IF NOT EXISTS idx_btslot_template ON BlockTemplateSlot(template_id, slot_order);
  `);

  // Lightweight migrations for DBs created before a column was added. Each is
  // guarded so re-running is a no-op.
  addColumnIfMissing('ChannelType', 'playlist_ref', 'TEXT');
  addColumnIfMissing('ChannelType', 'api_username', 'TEXT');
  addColumnIfMissing('ChannelType', 'api_password', 'TEXT');
  addColumnIfMissing('BlockTemplate', 'target_subject', 'TEXT');
  // content_type is retained for backward compatibility but no longer read by
  // the engine (the scheduling rule is derived per series). Kept so old DBs and
  // the CRUD layer don't break.
  addColumnIfMissing('BlockTemplate', 'content_type', "TEXT NOT NULL DEFAULT 'movie'");
  addColumnIfMissing('BlockTemplate', 'weekdays', 'TEXT'); // CSV, e.g. 'Mon,Tue,Wed'
  addColumnIfMissing('ShowType', 'code', 'TEXT');
  addColumnIfMissing('ShowType', 'is_filler', 'INTEGER NOT NULL DEFAULT 0');
  // These Resource columns predate this migration helper — guard them for DBs
  // created from the very first SEED-era schema.
  addColumnIfMissing('Resource', 'channel_id', 'INTEGER');
  addColumnIfMissing('Resource', 'show_type_id', 'INTEGER');
  addColumnIfMissing('Resource', 'added_at', 'TEXT');

  seedShowTypes();
  backfillWeekdays();
  backfillPrimarySlots();
  rebuildScheduledBlockForSlots();
}

// The fixed, non-deletable catalogue of show types. Seeded by `code` so names
// can be localised later without breaking engine/ingestion branching.
export const FIXED_SHOW_TYPES = [
  { code: 'movies',        name: 'Movies',        is_educational: 0, is_filler: 0 },
  { code: 'documentaries', name: 'Documentaries', is_educational: 0, is_filler: 0 },
  { code: 'tv_shows',      name: 'TV Shows',      is_educational: 0, is_filler: 0 },
  { code: 'lessons',       name: 'Lessons',       is_educational: 1, is_filler: 0 },
  { code: 'fillers',       name: 'Fillers',       is_educational: 0, is_filler: 1 },
];

function seedShowTypes() {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO ShowType (code, name, is_educational, is_filler) VALUES (?, ?, ?, ?)'
  );
  const byCode = db.prepare('SELECT id FROM ShowType WHERE code = ?');
  const byName = db.prepare('SELECT id FROM ShowType WHERE name = ? AND code IS NULL');
  const setCode = db.prepare('UPDATE ShowType SET code = ?, is_filler = ?, is_educational = ? WHERE id = ?');
  for (const t of FIXED_SHOW_TYPES) {
    if (byCode.get(t.code)) continue;
    // Adopt a pre-existing free-form row with the same name rather than duplicate it.
    const existing = byName.get(t.name);
    if (existing) setCode.run(t.code, t.is_filler, t.is_educational, existing.id);
    else insert.run(t.code, t.name, t.is_educational, t.is_filler);
  }
}

// Backfill the multi-weekday column from the legacy single `weekday`.
function backfillWeekdays() {
  db.exec("UPDATE BlockTemplate SET weekdays = weekday WHERE weekdays IS NULL OR weekdays = ''");
}

// Ensure every template has at least a primary time slot mirroring its legacy
// start_time/end_time columns.
function backfillPrimarySlots() {
  const templates = db.prepare(`
    SELECT bt.id, bt.start_time, bt.end_time FROM BlockTemplate bt
    WHERE NOT EXISTS (SELECT 1 FROM BlockTemplateSlot s WHERE s.template_id = bt.id)
  `).all();
  const insert = db.prepare(
    'INSERT OR IGNORE INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (?, ?, ?, 0)'
  );
  for (const t of templates) insert.run(t.id, t.start_time, t.end_time);
}

// One-time rebuild of ScheduledBlock for DBs whose table predates `slot_id`.
// SQLite can't drop the old UNIQUE(template_id, target_date) constraint in
// place, so recreate the table, preserving ids (ScheduleItem.block_id FKs) and
// pointing each existing row at its template's primary slot.
function rebuildScheduledBlockForSlots() {
  const cols = db.prepare('PRAGMA table_info(ScheduledBlock)').all();
  if (cols.some((c) => c.name === 'slot_id')) return; // already migrated

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE ScheduledBlock_new (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      slot_id     INTEGER REFERENCES BlockTemplateSlot(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft',
      UNIQUE (template_id, slot_id, target_date)
    );
    INSERT INTO ScheduledBlock_new (id, template_id, slot_id, target_date, status)
      SELECT sb.id, sb.template_id,
             (SELECT s.id FROM BlockTemplateSlot s
               WHERE s.template_id = sb.template_id ORDER BY s.slot_order LIMIT 1),
             sb.target_date, sb.status
      FROM ScheduledBlock sb;
    DROP TABLE ScheduledBlock;
    ALTER TABLE ScheduledBlock_new RENAME TO ScheduledBlock;
    CREATE INDEX IF NOT EXISTS idx_scheduledblock_date ON ScheduledBlock(target_date, status);
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export { DB_PATH };
