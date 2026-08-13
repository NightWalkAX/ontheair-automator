// SQLite access layer.
//
// Uses Node's built-in `node:sqlite` module (stable as of Node 22.5+) so the
// project folder stays free of native binaries that would need rebuilding when
// the app is copied via USB between Macs (Intel vs Apple Silicon). If you must
// run on an older Node, swap this module for `better-sqlite3` — the exported
// surface (`db`, prepared-statement style) is intentionally close.

import { DatabaseSync } from 'node:sqlite';
import { parseEpisode } from './services/episodeParse.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
// SCHEDULER_DB lets tests (and USB/alternate deployments) point at a throwaway
// database instead of the live one. Tests MUST set it so a run never touches
// data/scheduler.sqlite — the operator's real schedule lives there.
const DB_PATH = process.env.SCHEDULER_DB || join(DATA_DIR, 'scheduler.sqlite');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// Enforce foreign keys on every connection (per SEED.md §3).
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA journal_mode = WAL;');

// node:sqlite's DatabaseSync has no .transaction() helper (unlike better-sqlite3),
// so wrap a function in BEGIN/COMMIT with ROLLBACK on error. Not re-entrant —
// callers must not nest withTx.
export function withTx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
      -- Fallback playlist (index "0" or a unique_id) used only when the
      -- instance can't create the per-day playlist (no "traffic" option).
      playlist_ref TEXT,
      -- Name template for the playlist created per push day.
      -- Tokens: {channel} {date} {yyyy} {mm} {dd}. NULL = "{channel} {date}".
      playlist_name_pattern TEXT,
      -- Event-based scheduling done at the file level (see migrations below).
      schedule_path     TEXT,
      playlist_dir      TEXT,
      playlist_template TEXT,
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
      file_path       TEXT NOT NULL,          -- absolute local mount path
      duration        INTEGER NOT NULL,       -- seconds
      subject         TEXT,
      -- Season number parsed from the filename (S02E.., 03x.., "Season 2 …").
      -- A pure display/organization level (the "season folder" inside a show);
      -- ordering is by the chapter column. Null = no season info (standalone clip).
      season          INTEGER,
      chapter         INTEGER NOT NULL DEFAULT 0,
      is_filler       INTEGER NOT NULL DEFAULT 0,
      audience_rating INTEGER,
      -- Review gate: a resource is unavailable to the scheduling engine until the
      -- operator has reviewed/organized it in the Catalog Editor and approved it.
      -- New scans arrive unapproved (default 0); re-scans preserve the flag.
      approved        INTEGER NOT NULL DEFAULT 0,
      -- Refinements flagged in the plan:
      channel_id      INTEGER REFERENCES ChannelType(id) ON DELETE CASCADE,
      show_type_id    INTEGER REFERENCES ShowType(id)    ON DELETE SET NULL,
      added_at        TEXT,                   -- file mtime, drives Sunday "latest episode" pick
      last_used_at    TEXT,                   -- when a filler was last placed (spreads repeats)
      sort_order      INTEGER,                -- optional manual chapter ordering within a series
      -- Shared folders: the same physical file can be cataloged under several
      -- channels (one Resource row per channel), so identity is (channel, path),
      -- not the path alone.
      UNIQUE (channel_id, file_path)
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

    -- The channels a template airs on. A template may target several channels;
    -- each channel picks its own content independently at generation time. Legacy
    -- BlockTemplate.channel_id is retained as the "primary" channel and backfilled
    -- into this table for pre-existing templates.
    CREATE TABLE IF NOT EXISTS BlockTemplateChannel (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      channel_id  INTEGER NOT NULL REFERENCES ChannelType(id)   ON DELETE CASCADE,
      UNIQUE (template_id, channel_id)
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
      -- Which channel this block belongs to. A template can air on several
      -- channels; each gets its own block per slot/date with independent content.
      -- Nullable for legacy rows; backfilled from template.channel_id on startup.
      channel_id  INTEGER REFERENCES ChannelType(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,              -- 'YYYY-MM-DD'
      status      TEXT NOT NULL DEFAULT 'draft', -- 'draft'|'approved'|'exported'
      UNIQUE (template_id, slot_id, channel_id, target_date)
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

    -- Non-destructive "fake root" catalog editor layer. Lets the operator rename
    -- clips for-screen and snapshot the detected subject/chapter so edits can be
    -- reset. Resource.name / file_path (server truth) are never written by the
    -- editor; Resource.subject/chapter (the scheduling/organization layer) are
    -- edited in place and the pre-edit values are snapshotted here once.
    CREATE TABLE IF NOT EXISTS ResourceOverride (
      resource_id      INTEGER PRIMARY KEY REFERENCES Resource(id) ON DELETE CASCADE,
      display_name     TEXT,        -- on-screen name; Resource.name stays untouched
      detected_subject TEXT,        -- snapshot at first edit → enables reset
      detected_chapter INTEGER,
      detected_season  INTEGER      -- season snapshot → reset restores it too
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
  // Name template for the per-day playlist created on push. Tokens:
  // {channel} {date} {yyyy} {mm} {dd}. NULL = "{channel} {date}".
  addColumnIfMissing('ChannelType', 'playlist_name_pattern', 'TEXT');
  // File-level scheduling for instances whose OTAV scheduler runs an EVENT-based
  // schedule (which REST cannot modify): the schedule JSON this app edits, the
  // folder day playlists are written to, and an empty playlist saved from OTAV
  // that gets byte-copied per day. Paths as this process sees them — the share is
  // mounted at the same path on every machine. schedule_path is optional: when
  // blank, the schedule the instance reports via GET /scheduler is edited.
  addColumnIfMissing('ChannelType', 'schedule_path', 'TEXT');
  addColumnIfMissing('ChannelType', 'playlist_dir', 'TEXT');
  addColumnIfMissing('ChannelType', 'playlist_template', 'TEXT');
  addColumnIfMissing('ChannelType', 'api_username', 'TEXT');
  addColumnIfMissing('ChannelType', 'api_password', 'TEXT');
  // Per-clip watermark. NULL means "follow the naming convention" — see
  // channelLogoFilename() in otavClient.js. The file itself lives on the OTAV
  // Mac; the API can neither list nor upload logos.
  addColumnIfMissing('ChannelType', 'logo_filename', 'TEXT');
  addColumnIfMissing('ChannelType', 'logo_enabled', 'INTEGER NOT NULL DEFAULT 1');
  addColumnIfMissing('BlockTemplate', 'target_subject', 'TEXT');
  // content_type is retained for backward compatibility but no longer read by
  // the engine (the scheduling rule is derived per series). Kept so old DBs and
  // the CRUD layer don't break.
  addColumnIfMissing('BlockTemplate', 'content_type', "TEXT NOT NULL DEFAULT 'movie'");
  addColumnIfMissing('BlockTemplate', 'weekdays', 'TEXT'); // CSV, e.g. 'Mon,Tue,Wed'
  addColumnIfMissing('BlockTemplate', 'max_per_show', 'INTEGER'); // cap episodes/show/block; NULL = unlimited
  addColumnIfMissing('ShowType', 'code', 'TEXT');
  addColumnIfMissing('ShowType', 'is_filler', 'INTEGER NOT NULL DEFAULT 0');
  // These Resource columns predate this migration helper — guard them for DBs
  // created from the very first SEED-era schema.
  addColumnIfMissing('Resource', 'channel_id', 'INTEGER');
  addColumnIfMissing('Resource', 'show_type_id', 'INTEGER');
  addColumnIfMissing('Resource', 'added_at', 'TEXT');
  addColumnIfMissing('Resource', 'last_used_at', 'TEXT');   // filler repeat-heat
  addColumnIfMissing('Resource', 'sort_order', 'INTEGER');  // manual chapter order
  // Review gate. New rows default to 0 (unapproved). On a DB that predates this
  // column, the media was already in use, so backfill existing rows to approved
  // once — only new scans thereafter arrive unapproved.
  if (addColumnIfMissing('Resource', 'approved', 'INTEGER NOT NULL DEFAULT 0')) {
    db.exec('UPDATE Resource SET approved = 1');
  }
  addColumnIfMissing('ChannelSeries', 'cursor_chapter', 'INTEGER'); // per-series progression cursor

  seedShowTypes();
  backfillWeekdays();
  backfillPrimarySlots();
  rebuildScheduledBlockForSlots();
  rebuildScheduledBlockForChannels();
  rebuildResourceForSharedFolders();
  backfillTemplateChannels();
  backfillScheduledBlockChannel();
  migrateSeasonSupport();
}

// Season support. Runs AFTER rebuildResourceForSharedFolders so its table
// rebuild (old DBs only) can't drop the column. New scans fill `season` from the
// filename; existing rows are backfilled once by re-parsing their stored name.
function migrateSeasonSupport() {
  if (addColumnIfMissing('Resource', 'season', 'INTEGER')) backfillSeasons();
  addColumnIfMissing('ResourceOverride', 'detected_season', 'INTEGER');
}

function backfillSeasons() {
  const rows = db.prepare('SELECT id, name FROM Resource WHERE is_filler = 0').all();
  const upd = db.prepare('UPDATE Resource SET season = ? WHERE id = ?');
  for (const r of rows) {
    const { season } = parseEpisode(r.name);
    if (season != null) upd.run(season, r.id);
  }
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

// One-time rebuild of ScheduledBlock for DBs whose table predates `channel_id`.
// A template can now air on several channels, so a block must know its own
// channel independent of the template. SQLite can't add the column to the
// composite UNIQUE in place, so recreate the table, backfilling channel_id from
// each block's template. Runs after rebuildScheduledBlockForSlots so slot_id
// already exists.
function rebuildScheduledBlockForChannels() {
  const cols = db.prepare('PRAGMA table_info(ScheduledBlock)').all();
  if (cols.some((c) => c.name === 'channel_id')) return; // already migrated

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE ScheduledBlock_new (
      id          INTEGER PRIMARY KEY,
      template_id INTEGER NOT NULL REFERENCES BlockTemplate(id) ON DELETE CASCADE,
      slot_id     INTEGER REFERENCES BlockTemplateSlot(id) ON DELETE CASCADE,
      channel_id  INTEGER REFERENCES ChannelType(id) ON DELETE CASCADE,
      target_date TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft',
      UNIQUE (template_id, slot_id, channel_id, target_date)
    );
    INSERT INTO ScheduledBlock_new (id, template_id, slot_id, channel_id, target_date, status)
      SELECT sb.id, sb.template_id, sb.slot_id,
             (SELECT bt.channel_id FROM BlockTemplate bt WHERE bt.id = sb.template_id),
             sb.target_date, sb.status
      FROM ScheduledBlock sb;
    DROP TABLE ScheduledBlock;
    ALTER TABLE ScheduledBlock_new RENAME TO ScheduledBlock;
    CREATE INDEX IF NOT EXISTS idx_scheduledblock_date ON ScheduledBlock(target_date, status);
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

// One-time rebuild of Resource for DBs created with UNIQUE(file_path) alone.
// Shared folders mean the same file can be cataloged under several channels, so
// identity becomes (channel_id, file_path). Detect the old constraint by the
// absence of the composite in the table's SQL and rebuild if needed.
function rebuildResourceForSharedFolders() {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='Resource'"
  ).get();
  if (!row || /UNIQUE\s*\(\s*channel_id\s*,\s*file_path\s*\)/i.test(row.sql)) return; // already migrated

  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec(`
    CREATE TABLE Resource_new (
      id              INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      duration        INTEGER NOT NULL,
      subject         TEXT,
      chapter         INTEGER NOT NULL DEFAULT 0,
      is_filler       INTEGER NOT NULL DEFAULT 0,
      audience_rating INTEGER,
      approved        INTEGER NOT NULL DEFAULT 0,
      channel_id      INTEGER REFERENCES ChannelType(id) ON DELETE CASCADE,
      show_type_id    INTEGER REFERENCES ShowType(id)    ON DELETE SET NULL,
      added_at        TEXT,
      last_used_at    TEXT,
      sort_order      INTEGER,
      UNIQUE (channel_id, file_path)
    );
    INSERT INTO Resource_new
      (id, name, file_path, duration, subject, chapter, is_filler, audience_rating,
       approved, channel_id, show_type_id, added_at, last_used_at, sort_order)
      SELECT id, name, file_path, duration, subject, chapter, is_filler, audience_rating,
             COALESCE(approved, 1), channel_id, show_type_id, added_at, last_used_at, sort_order
      FROM Resource;
    DROP TABLE Resource;
    ALTER TABLE Resource_new RENAME TO Resource;
    CREATE INDEX IF NOT EXISTS idx_resource_channel ON Resource(channel_id, is_filler);
    CREATE INDEX IF NOT EXISTS idx_resource_subject ON Resource(channel_id, subject, chapter);
  `);
  db.exec('PRAGMA foreign_keys = ON;');
}

// Give every template at least one BlockTemplateChannel row, derived from its
// legacy primary channel_id. Idempotent via INSERT OR IGNORE.
function backfillTemplateChannels() {
  db.exec(`
    INSERT OR IGNORE INTO BlockTemplateChannel (template_id, channel_id)
      SELECT id, channel_id FROM BlockTemplate WHERE channel_id IS NOT NULL
  `);
}

// Set channel_id on any ScheduledBlock rows still missing it (belt-and-braces;
// the rebuild already backfills, but a fresh row inserted before this migration
// on a partially-migrated DB is covered too).
function backfillScheduledBlockChannel() {
  db.exec(`
    UPDATE ScheduledBlock
       SET channel_id = (SELECT bt.channel_id FROM BlockTemplate bt WHERE bt.id = ScheduledBlock.template_id)
     WHERE channel_id IS NULL
  `);
}

// Returns true if the column was just added (so callers can backfill once).
function addColumnIfMissing(table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  }
  return false;
}

export { DB_PATH };
