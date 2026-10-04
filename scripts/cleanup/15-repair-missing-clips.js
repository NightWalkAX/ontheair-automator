#!/usr/bin/env node
// Phase 15 — catalogued clips that are no longer at their path: converted by Air
// Spec under another path, folder renamed (the trailing-space / SMB-mangled
// "ANWHU2~D" folders), or moved by hand. Same code as the "🩹 Repair missing
// clips…" button in Media & Roots (src/services/catalogRepair.js).
//
// Usage:
//   node scripts/cleanup/15-repair-missing-clips.js              # report only
//   node scripts/cleanup/15-repair-missing-clips.js --deep       # also walk the share
//   node scripts/cleanup/15-repair-missing-clips.js --apply [--deep]
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { initSchema } from '../../src/db.js';
import { applyRepair, planRepair } from '../../src/services/catalogRepair.js';

initSchema();
const deep = process.argv.includes('--deep');
const apply = process.argv.includes('--apply');
const r = apply ? await applyRepair({ deep }) : await planRepair({ deep });

console.log(`\n${r.checked} catalogued path(s) checked${deep ? ' (deep search)' : ''}`);
console.log('-'.repeat(64));
for (const x of r.relocate) console.log(`  found     ${x.from}\n         → ${x.to}`);
for (const x of r.aliases) console.log(`  alias     ${x.from}\n         = ${x.to}`);
for (const x of r.ambiguous) console.log(`  AMBIGUOUS ${x.file_path}\n            ${x.candidates.join('\n            ')}`);
for (const x of r.notFound) console.log(`  NOT FOUND ${x.file_path}`);
for (const x of r.unreadable) console.log(`  UNREADABLE ${x.file_path} (${x.error})`);
console.log(`\n${r.relocate.length} found, ${r.aliases.length} alias(es), ${r.ambiguous.length} ambiguous, `
  + `${r.notFound.length} not found, ${r.unreadable.length} unreadable`);
if (apply) {
  console.log(`applied: ${r.applied.rowsMoved} row(s) re-pointed, ${r.applied.rowsMerged} merged`);
  if (r.exportedDays.length) console.log(`re-push: ${r.exportedDays.map((d) => `${d.channel} ${d.target_date}`).join(', ')}`);
} else {
  console.log('[dry run] nothing written. Re-run with --apply to commit.');
}
