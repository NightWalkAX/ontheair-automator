#!/usr/bin/env node
// Phase 10 — attribute the catalogue to its media roots, and prune the roots
// that were pointed somewhere far too broad.
//
// Symptom being repaired: 196,014 distinct paths for a broadcast library of
// about 5,000. The diagnosis (09-diagnose-catalog-bloat.js) ruled out a
// directory cycle — the path-depth histogram is a smooth curve peaking at 7 and
// ending at 14, where a cycle gives a flat tail to the depth cap — and the
// repeated path segments name the real cause:
//
//   "Free Presets for Motion Bro", "Motion Bro Presets for Premiere Pro",
//   "Shared Project", "b - roll", "Footage", "2. RAW", "146 Sketch Elements"
//
// Those are Premiere/After Effects project folders, stock presets, b-roll and
// raw camera material. There really ARE ~196k video files under that share.
// Nothing looped: a channel's media root was assigned a path that covers the
// whole production storage instead of its broadcast folder.
//
// So this is not a de-duplication. It is: find which root each catalogued path
// came from, show the operator the roots pulling in six figures, and remove the
// ones they name — together with the Resource rows only those roots explain.
//
// Safety rules, in order of importance:
//   1. A path referenced by ScheduleItem or PlayHistory is NEVER removed, even
//      if its root is being pruned. A block that airs tomorrow keeps its clip.
//   2. A path also reachable from a root that is being KEPT is never removed —
//      it belongs to the catalogue on its own merit.
//   3. Nothing is deleted. Rows are written to reports/ first, so the exact set
//      can be re-inserted if this turns out to be wrong.
//   4. Dry run unless --apply.
//
// Usage:
//   node scripts/cleanup/10-prune-media-roots.js                    # report only
//   node scripts/cleanup/10-prune-media-roots.js --root 12 --root 13
//   node scripts/cleanup/10-prune-media-roots.js --channel "MoE Central"
//   node scripts/cleanup/10-prune-media-roots.js --root 12 --apply
//
// Honours SCHEDULER_DB. Rehearse against a copy first.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, withTx } from '../../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(__dirname, 'reports');
const APPLY = process.argv.includes('--apply');

const multi = (name) => process.argv.reduce((acc, a, i) => (
  a === `--${name}` && process.argv[i + 1] ? [...acc, process.argv[i + 1]] : acc), []);
const rootIds = multi('root').map(Number).filter(Number.isInteger);
const channels = multi('channel');

const n = (v) => Number(v).toLocaleString('en-US');
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// ---- Attribution -----------------------------------------------------------
// A path belongs to a root when it sits under that root's directory AND shares
// its channel. Nested roots mean a path can belong to several; that is exactly
// what rule 2 relies on.

const roots = db.prepare(`
  SELECT m.id, m.channel_id, m.show_type_id, m.path,
         COALESCE(c.name, '?') AS channel, COALESCE(s.name, '?') AS show_type
  FROM MediaRoot m
  LEFT JOIN ChannelType c ON c.id = m.channel_id
  LEFT JOIN ShowType   s ON s.id = m.show_type_id
  ORDER BY m.channel_id, m.path
`).all();

const countUnder = db.prepare(`
  SELECT COUNT(DISTINCT file_path) AS n FROM Resource
  WHERE channel_id = ? AND file_path LIKE ? || '/%'
`);
for (const r of roots) r.paths = countUnder.get(r.channel_id, r.path.replace(/\/+$/, '')).n;

head('Media roots, by how much of the catalogue they explain');
let lastChannel = null;
for (const r of [...roots].sort((a, b) => (a.channel === b.channel ? b.paths - a.paths : a.channel.localeCompare(b.channel)))) {
  if (r.channel !== lastChannel) { console.log(`\n  ${r.channel}`); lastChannel = r.channel; }
  const flag = r.paths > 20_000 ? '  <-- far too broad for a broadcast folder' : '';
  console.log(`    #${String(r.id).padEnd(4)} ${n(r.paths).padStart(9)} paths  ${r.show_type.padEnd(14)} ${r.path}${flag}`);
}

// ---- What a prune would remove ---------------------------------------------

const selected = roots.filter((r) => rootIds.includes(r.id)
  || channels.some((c) => c.toLowerCase() === r.channel.toLowerCase()));

if (!selected.length) {
  head('Nothing selected');
  console.log(`Pass --root <id> (repeatable) or --channel "<name>" to prune. Nothing was changed.

Read the table above first: a root whose path is a production or scratch folder
is the bug, and the Resource rows under it were correctly scanned from files
that really exist — they simply are not broadcast material.`);
  process.exit(0);
}

head('Selected for pruning');
for (const r of selected) {
  console.log(`  #${r.id}  ${r.channel} · ${r.show_type} · ${r.path}  (${n(r.paths)} paths)`);
}

const keptRoots = roots.filter((r) => !selected.includes(r));

// Rule 1: anything a block or the play history references.
const referenced = new Set([
  ...db.prepare(`
    SELECT DISTINCT r.file_path AS p FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id
  `).all().map((x) => x.p),
  ...db.prepare(`
    SELECT DISTINCT r.file_path AS p FROM PlayHistory ph JOIN Resource r ON r.id = ph.resource_id
  `).all().map((x) => x.p),
]);

const under = (path, root) => path.startsWith(root.replace(/\/+$/, '') + '/');

const doomed = [];
const spared = { referenced: 0, otherRoot: 0 };
for (const root of selected) {
  const rows = db.prepare(
    'SELECT id, file_path, approved FROM Resource WHERE channel_id = ? AND file_path LIKE ? || \'/%\'',
  ).all(root.channel_id, root.path.replace(/\/+$/, ''));
  for (const row of rows) {
    if (referenced.has(row.file_path)) { spared.referenced++; continue; }
    // Rule 2: still explained by a root we are keeping, on the same channel.
    if (keptRoots.some((k) => k.channel_id === root.channel_id && under(row.file_path, k.path))) {
      spared.otherRoot++;
      continue;
    }
    doomed.push(row);
  }
}
// The same row can be reached through two selected roots.
const byId = new Map(doomed.map((r) => [r.id, r]));

head('Effect');
console.log(`Resource rows to remove        ${n(byId.size)}`);
console.log(`spared — a block/history uses  ${n(spared.referenced)}`);
console.log(`spared — a kept root explains  ${n(spared.otherRoot)}`);
const remaining = db.prepare('SELECT COUNT(*) AS n FROM Resource').get().n - byId.size;
console.log(`Resource rows after            ${n(remaining)}`);
console.log(`MediaRoot rows to remove       ${selected.length}`);
console.log('\nsample of what goes:');
for (const r of [...byId.values()].slice(0, 8)) console.log(`  ${r.file_path}`);

// ---- Report, then (optionally) write ---------------------------------------

mkdirSync(REPORT_DIR, { recursive: true });
const report = join(REPORT_DIR, `10-prune-media-roots-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`);
writeFileSync(report, JSON.stringify({
  applied: APPLY,
  roots: selected.map(({ id, channel, show_type, path, paths }) => ({ id, channel, show_type, path, paths })),
  spared,
  // The full set, so this is reversible by hand if the call was wrong.
  removed: [...byId.values()],
}, null, 2));
console.log(`\nreport written: ${report}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing was changed. Re-run with --apply to commit.');
  process.exit(0);
}

withTx(() => {
  const delResource = db.prepare('DELETE FROM Resource WHERE id = ?');
  for (const id of byId.keys()) delResource.run(id);
  const delRoot = db.prepare('DELETE FROM MediaRoot WHERE id = ?');
  for (const r of selected) delRoot.run(r.id);
  // TranscodeItem rows for paths that no longer exist in the catalogue are
  // orphans in Air Spec's queue; drop the ones nothing points at any more.
  db.exec(`
    DELETE FROM TranscodeItem
    WHERE file_path NOT IN (SELECT file_path FROM Resource)
      AND status NOT IN ('replaced', 'converted', 'running')
  `);
});
console.log(`\nAPPLIED. ${n(byId.size)} Resource row(s) and ${selected.length} MediaRoot row(s) removed.`);
console.log('Run the Air Spec check again — "clips this run" should now be the real library size.');
console.log(`If this was wrong, ${report} holds every removed row.`);
