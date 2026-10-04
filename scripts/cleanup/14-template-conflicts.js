#!/usr/bin/env node
// Phase 14 — the template overlaps and gaps found on 2026-10-04 (Tuesday 06:00
// twice, Yoga vs Math Intervention, 12:30–13:05, Elementary Weekend 10–23:59,
// missing evening repeats on MoE Central and Elevate Wednesday).
//
// This is a startup MIGRATION (src/migrations/007-template-conflicts-2026-10.js):
// the app applies it once, by itself, and records it in data/.migrations.lock.
// This script is the manual door onto the same code — run it to SEE what it
// would change before a database is ever started.
//
// Usage:
//   node scripts/cleanup/14-template-conflicts.js         # report only
//   node scripts/cleanup/14-template-conflicts.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { plan, description } from '../../src/migrations/007-template-conflicts-2026-10.js';
import { planner } from './lib.js';

const { ops, summary } = plan();
const p = planner('14-template-conflicts');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to fix.');
for (const line of summary) console.log('  ' + line);

p.commit();
