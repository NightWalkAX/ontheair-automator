#!/usr/bin/env node
// Phase 18 — two grades per digital channel (Nursery–G11, Elementary lowest …
// Discover highest); the analog channel repeats classes (2026-10-28).
//
// This is a startup MIGRATION (src/migrations/010-grade-pairs.js): the
// app applies it once, by itself, and records it in data/.migrations.lock.
// This script is the manual door onto the same code — run it to SEE what it
// would change before a database is ever started.
//
// Usage:
//   node scripts/cleanup/18-grade-pairs.js         # report only
//   node scripts/cleanup/18-grade-pairs.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { plan, description } from '../../src/migrations/010-grade-pairs.js';
import { planner } from './lib.js';

const { ops, summary } = plan();
const p = planner('18-grade-pairs');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to change.');
for (const line of summary) console.log('  ' + line);

p.commit();
