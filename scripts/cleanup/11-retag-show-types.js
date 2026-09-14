#!/usr/bin/env node
// Phase 11 — re-tag every Resource with the show type of the media root it
// actually lives under.
//
// This is now a startup MIGRATION (src/migrations/001-retag-show-types.js): the
// app applies it once, by itself, and records it in data/.migrations.lock. This
// script is the manual door onto the same code — run it to SEE what it would
// change on a database that has not been started yet, or to re-run the repair
// after a scan wrote bad rows again.
//
// Usage:
//   node scripts/cleanup/11-retag-show-types.js            # report only
//   node scripts/cleanup/11-retag-show-types.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy before the real file.

import { plan, description } from '../../src/migrations/001-retag-show-types.js';
import { planner } from './lib.js';

const { ops, summary } = plan();
const p = planner('11-retag-show-types');
for (const op of ops) p.op(op.sql, op.params, null);

console.log(`\n${description}`);
console.log('-'.repeat(64));
if (!summary.length) console.log('  nothing to repair — every file matches its deepest media root.');
for (const line of summary) console.log('  ' + line);

p.commit();
