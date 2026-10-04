#!/usr/bin/env node
// Phase 16 — the analog channel's catalogue and weekly line-up (2026-10-04).
//
// This is a startup MIGRATION (src/migrations/008-analog-lineup.js): the app
// applies it once, by itself, and records it in data/.migrations.lock. This
// script is the manual door onto the same code — run it to SEE what it would
// change before a database is ever started.
//
// Usage:
//   node scripts/cleanup/16-analog-lineup.js         # report only
//   node scripts/cleanup/16-analog-lineup.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { plan, description } from '../../src/migrations/008-analog-lineup.js';
import { planner } from './lib.js';

let ops, summary;
try {
  ({ ops, summary } = plan());
} catch (err) {
  // A database from before the analog channel existed has no playout column
  // and no analog row: the app creates both at boot, then runs this itself.
  console.error(`cannot plan: ${err.message} — start the app once on this database (it adds the analog channel), then re-run`);
  process.exit(1);
}
const p = planner('16-analog-lineup');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to do.');
for (const line of summary) console.log('  ' + line);

p.commit();
