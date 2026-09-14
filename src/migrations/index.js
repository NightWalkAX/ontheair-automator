// Data repairs that run ONCE, at startup, before the app serves anything.
//
// These are not schema changes — db.js does those on every boot and they are
// idempotent by construction. These repair ROWS that earlier bugs wrote, which
// is a different thing: expensive to compute, pointless to redo, and something
// an operator should never have to remember to run from a terminal on a playout
// Mac. So each one is applied at most once and the fact is recorded in a lock
// file next to the database.
//
// The lock lives beside the DB (not in the repo) and is NOT versioned: it
// describes one installation's history, and a copy of the folder that carries a
// different database must be free to repair that one. A migration is written to
// the lock only after its transaction commits, so a crash mid-repair leaves it
// pending and it runs again on the next boot.
//
// Adding one: write the module with `id`, `description` and `plan()` — plan()
// must READ ONLY and return { ops: [{sql, params}], summary: [...] } — then
// list it below. Order is the order of this list.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { db, withTx, DB_PATH } from '../db.js';
import { log } from '../logger.js';

import * as retagShowTypes from './001-retag-show-types.js';
import * as pruneOrphanSeries from './002-prune-orphan-series.js';

const MIGRATIONS = [retagShowTypes, pruneOrphanSeries];

/** Where the record of what has already run lives, next to the database. */
export function lockPath() {
  return join(dirname(DB_PATH), '.migrations.lock');
}

function readLock() {
  try {
    const parsed = JSON.parse(readFileSync(lockPath(), 'utf8'));
    return Array.isArray(parsed?.applied) ? parsed : { applied: [] };
  } catch {
    return { applied: [] }; // missing or unreadable: treat everything as pending
  }
}

function writeLock(lock) {
  // Temp file renamed over the target, as config.js does: a crash mid-write
  // must not leave a truncated lock that re-runs everything.
  const tmp = lockPath() + '.tmp';
  writeFileSync(tmp, JSON.stringify(lock, null, 2) + '\n');
  renameSync(tmp, lockPath());
}

/**
 * Apply every migration this database has not seen yet.
 * Returns [{ id, changes, summary }] for the ones that ran.
 */
export function runPendingMigrations() {
  const l = log('migrate');
  const lock = readLock();
  const done = new Set(lock.applied.map((a) => a.id));
  const ran = [];

  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    let plan;
    try {
      plan = m.plan();
    } catch (err) {
      // A repair that cannot even be planned must not stop the app from coming
      // up: the schedule still has to air. It stays pending and is logged.
      l.error(`${m.id} could not be planned — left pending`, err);
      continue;
    }
    if (plan.ops.length) {
      l.info(`${m.id}: ${m.description} — ${plan.ops.length} change(s)`);
      for (const line of plan.summary) l.info(`  ${line}`);
      try {
        withTx(() => {
          for (const op of plan.ops) db.prepare(op.sql).run(...op.params);
        });
      } catch (err) {
        l.error(`${m.id} FAILED and was rolled back — left pending`, err);
        continue;
      }
    } else {
      l.info(`${m.id}: nothing to repair`);
    }
    lock.applied.push({ id: m.id, at: new Date().toISOString(), changes: plan.ops.length });
    writeLock(lock);
    ran.push({ id: m.id, changes: plan.ops.length, summary: plan.summary });
  }
  return ran;
}

export { MIGRATIONS };
