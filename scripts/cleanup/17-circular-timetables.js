#!/usr/bin/env node
// Phase 17 — the lesson channels aligned with the MoE national timetables
// (Circular 5/2026 primary, 6/2025 nursery): one grade band per channel, each
// mirroring its circular Mon–Fri 09:00–15:00 (2026-10-26).
//
// This is a startup MIGRATION (src/migrations/009-circular-timetables.js): the
// app applies it once, by itself, and records it in data/.migrations.lock.
// This script is the manual door onto the same code — run it to SEE what it
// would change before a database is ever started.
//
// Usage:
//   node scripts/cleanup/17-circular-timetables.js         # report only
//   node scripts/cleanup/17-circular-timetables.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { plan, description } from '../../src/migrations/009-circular-timetables.js';
import { planner } from './lib.js';

const { ops, summary } = plan();
const p = planner('17-circular-timetables');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to change.');
for (const line of summary) console.log('  ' + line);

p.commit();
