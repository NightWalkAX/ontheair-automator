// Shared helpers for the one-off catalog cleanup scripts (scripts/cleanup/*).
//
// These scripts repair `Resource` rows scanned before the catalog conventions
// settled: series that conflate two shows, `chapter` holding a grade number or
// a release year instead of an episode ordinal, and registry rows left behind by
// renamed folders. They are dry-run by default; pass --apply to write.
//
// Every script honours SCHEDULER_DB (see src/db.js) so the whole chain can be
// rehearsed against a scratch copy before touching data/scheduler.sqlite.

import { db, withTx } from '../../src/db.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dirname, 'reports');

export { db, withTx };

/** True when the operator passed --apply; otherwise everything is a dry run. */
export const APPLY = process.argv.includes('--apply');

export function flag(name) {
  return process.argv.includes(name);
}

const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);
export { q, one };

/**
 * Mutations are collected rather than executed so a dry run can print exactly
 * what --apply would do. Each entry is { sql, params, note }.
 */
export function planner(phase) {
  const ops = [];
  const notes = [];
  return {
    /** Queue one statement. `note` is the human-readable line for the report. */
    op(sql, params, note) {
      ops.push({ sql, params, note });
    },
    /** A report-only observation (e.g. "quarantined: reason"). */
    note(obj) {
      notes.push(obj);
    },
    get size() {
      return ops.length;
    },
    /**
     * Print the report, write reports/<phase>.json, and run the statements
     * inside a single transaction when --apply is set.
     */
    commit() {
      console.log(`\n=== ${phase} — ${ops.length} statement(s), ${notes.length} note(s) ===`);
      for (const { note } of ops) if (note) console.log('  ' + note);
      for (const n of notes) console.log('  · ' + (typeof n === 'string' ? n : JSON.stringify(n)));

      mkdirSync(REPORT_DIR, { recursive: true });
      writeFileSync(
        join(REPORT_DIR, `${phase}.json`),
        JSON.stringify({ phase, applied: APPLY, ops, notes }, null, 2)
      );

      if (!APPLY) {
        console.log(`\n[dry run] nothing written. Re-run with --apply to commit.`);
        return 0;
      }
      // node:sqlite's DatabaseSync has no .transaction(); use withTx (src/db.js).
      withTx(() => {
        for (const { sql, params } of ops) db.prepare(sql).run(...params);
      });
      console.log(`\n[applied] ${ops.length} statement(s) committed.`);
      return ops.length;
    },
  };
}

/**
 * Queue an INSERT OR IGNORE into ChannelSeries for a subject, mirroring
 * registerSeries() in src/services/ingestion.js:142. play_order is resolved at
 * plan time from the current max, which is close enough for a one-off repair
 * (ties only affect the UI's default ordering when adding series to a block).
 */
export function ensureSeries(plan, channelId, subject, showTypeId, isSerial) {
  const existing = one(
    'SELECT id, is_active FROM ChannelSeries WHERE channel_id = ? AND subject = ?',
    channelId,
    subject
  );
  if (existing) {
    if (!existing.is_active) {
      plan.op(
        'UPDATE ChannelSeries SET is_active = 1 WHERE id = ?',
        [existing.id],
        `reactivate series "${subject}"`
      );
    }
    return;
  }
  const nextOrder = one(
    'SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ChannelSeries WHERE channel_id = ?',
    channelId
  ).n;
  plan.op(
    `INSERT OR IGNORE INTO ChannelSeries
       (channel_id, subject, show_type_id, is_serial, is_active, play_order)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [channelId, subject, showTypeId ?? null, isSerial ? 1 : 0, nextOrder],
    `register series "${subject}" (show_type=${showTypeId}, serial=${isSerial ? 1 : 0})`
  );
}

/**
 * Queue a rewrite of `chapter` to 1..N across a series, ordered by `orderBy`.
 * Same effect as PUT /api/channels/:id/series/:subject/chapters
 * (src/routes/series.js:197), which is how an operator does this by hand.
 *
 * Any stored cursor_chapter is also cleared: it points at the OLD numbering, so
 * leaving it would make the series resume from an arbitrary episode.
 *
 * `rows` may be supplied when the caller has already staged subject moves that
 * aren't in the DB yet (the split scripts do this).
 */
export function renumber(plan, channelId, subject, orderBy = 'name', rows = null) {
  const items =
    rows ??
    q(
      `SELECT id, name, chapter FROM Resource
        WHERE channel_id = ? AND subject = ? AND is_filler = 0
        ORDER BY ${orderBy === 'chapter' ? 'chapter ASC, name ASC' : 'name ASC'}, id ASC`,
      channelId,
      subject
    );
  let changed = 0;
  items.forEach((r, i) => {
    const next = i + 1;
    if (r.chapter !== next) {
      plan.op('UPDATE Resource SET chapter = ? WHERE id = ?', [next, r.id], null);
      changed++;
    }
  });
  if (changed) {
    plan.note(`renumber "${subject}": ${changed}/${items.length} chapters rewritten to 1..${items.length}`);
  }
  const cur = one(
    'SELECT id, cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?',
    channelId,
    subject
  );
  if (cur && cur.cursor_chapter != null) {
    plan.op(
      'UPDATE ChannelSeries SET cursor_chapter = NULL WHERE id = ?',
      [cur.id],
      `clear stale cursor on "${subject}" (was ${cur.cursor_chapter}, numbering changed)`
    );
  }
  return items.length;
}

/** Queue approved=0 with a reason recorded in the report. */
export function quarantine(plan, id, label, reason) {
  plan.op('UPDATE Resource SET approved = 0 WHERE id = ?', [id], null);
  plan.note({ quarantined: id, name: label, reason });
}
