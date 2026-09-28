#!/usr/bin/env node
// Phase 13 — re-order episodes the old parser numbered by the LAST number in
// their name ("Math_Intervention_Program_020_…_Part_1" filed as 1, not 20).
//
// This is a startup MIGRATION (src/migrations/006-first-number-order.js): the app
// applies it once, by itself, and records it in data/.migrations.lock. This
// script is the manual door onto the same code — run it to SEE what it would
// change before a database is ever started.
//
// Usage:
//   node scripts/cleanup/13-first-number-order.js         # report only
//   node scripts/cleanup/13-first-number-order.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { plan, description } from '../../src/migrations/006-first-number-order.js';
import { planner } from './lib.js';

const { ops, summary } = plan();
const p = planner('13-first-number-order');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to re-order — every episode is numbered by its first number.');
for (const line of summary) console.log('  ' + line);

p.commit();
