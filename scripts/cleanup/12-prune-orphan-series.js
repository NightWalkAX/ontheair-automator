#!/usr/bin/env node
// Phase 12 — remove series registry rows that describe content the catalogue no
// longer holds.
//
// This is now a startup MIGRATION (src/migrations/002-prune-orphan-series.js):
// the app applies it once, by itself, and records it in data/.migrations.lock.
// This script is the manual door onto the same code — run it to SEE what it
// would remove, or to clean up again after another wide scan.
//
// Usage:
//   node scripts/cleanup/12-prune-orphan-series.js         # report only
//   node scripts/cleanup/12-prune-orphan-series.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { plan, description } from '../../src/migrations/002-prune-orphan-series.js';
import { planner } from './lib.js';

const { ops, summary } = plan();
const p = planner('12-prune-orphan-series');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to remove — the series registry is clean.');
for (const line of summary) console.log('  ' + line);

p.commit();
