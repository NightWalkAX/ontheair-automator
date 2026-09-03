#!/usr/bin/env node
// Phase 9 (diagnosis only) — why does the catalogue hold far more rows than the
// share holds clips?
//
// Symptom being investigated: Air Spec reports "196014 clips this run" for a
// library of about 5000. That number is NOT a directory walk — it comes from
// catalogFiles(), i.e. `SELECT ... FROM Resource GROUP BY file_path`. So the
// bloat is already PERSISTED: an earlier scan, before the walk was made
// cycle-safe, wrote a row for every path it enumerated, and a directory that
// links back into the tree yields the same clip under thousands of paths
// (a/back/a/back/…). The identity check in collectVideoFiles() stops new bloat;
// it cannot remove what is already recorded.
//
// This script WRITES NOTHING. It answers the questions a cleanup has to be based
// on, and prints the evidence rather than asking anyone to trust a guess:
//
//   1. How many rows, and how many distinct paths?
//   2. Which paths look like a cycle — a directory name repeating along the
//      path? Those are the ones a walk invented. Needs no disk access.
//   3. Which rows are actually IN USE (ScheduleItem / PlayHistory)? A cleanup
//      must not drop a clip a block still references.
//   4. How many distinct PHYSICAL files do these paths resolve to? Two paths
//      that stat to the same dev:ino are one clip reached two ways, which is
//      exactly what a cycle produces. This is the real library size.
//
// Usage:
//   node scripts/cleanup/09-diagnose-catalog-bloat.js
//   node scripts/cleanup/09-diagnose-catalog-bloat.js --limit 400   # smaller stat sample
//
// Honours SCHEDULER_DB and config.pathMap, so run it from the app folder on the
// machine that mounts the share.

import { stat } from 'node:fs/promises';
import { basename, dirname, sep } from 'node:path';
import { db } from '../../src/db.js';
import { localizePath } from '../../src/config.js';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const SAMPLE = Number(arg('limit', 3000));

const n = (v) => Number(v).toLocaleString('en-US');
const head = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// ---- 1. The raw counts -----------------------------------------------------

head('Catalogue size');
const rows = db.prepare('SELECT COUNT(*) AS n FROM Resource').get().n;
const paths = db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT file_path FROM Resource)').get().n;
console.log(`Resource rows            ${n(rows)}`);
console.log(`distinct file_path       ${n(paths)}   <- this is the number Air Spec reports`);
console.log('per channel:');
for (const r of db.prepare(`
  SELECT COALESCE(c.name, 'no channel') AS name, COUNT(*) AS rows,
         COUNT(DISTINCT r.file_path) AS paths
  FROM Resource r LEFT JOIN ChannelType c ON c.id = r.channel_id
  GROUP BY r.channel_id ORDER BY rows DESC
`).all()) {
  console.log(`  ${String(r.name).padEnd(24)} ${n(r.rows).padStart(9)} rows, ${n(r.paths).padStart(9)} paths`);
}

// ---- 2. Cycle signature, straight from the paths ---------------------------

head('Paths that repeat a directory name (the cycle signature)');
const allPaths = db.prepare('SELECT DISTINCT file_path FROM Resource').all().map((r) => r.file_path);
const repeats = [];
const depthHist = new Map();
for (const p of allPaths) {
  const segs = dirname(p).split(sep).filter(Boolean);
  depthHist.set(segs.length, (depthHist.get(segs.length) || 0) + 1);
  const seen = new Set();
  let dup = null;
  for (const s of segs) {
    if (seen.has(s)) { dup = s; break; }
    seen.add(s);
  }
  if (dup) repeats.push({ path: p, segment: dup, depth: segs.length });
}
console.log(`${n(repeats.length)} of ${n(allPaths.length)} paths repeat a directory name`
  + ` (${((repeats.length / Math.max(allPaths.length, 1)) * 100).toFixed(1)}%)`);
if (repeats.length) {
  const bySegment = new Map();
  for (const r of repeats) bySegment.set(r.segment, (bySegment.get(r.segment) || 0) + 1);
  console.log('\nrepeated segment, by how many paths carry it:');
  for (const [seg, count] of [...bySegment].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${n(count).padStart(9)}  "${seg}"`);
  }
  console.log('\nexamples (the loop is visible in the path itself):');
  for (const r of repeats.slice(0, 5)) console.log(`  ${r.path}`);
}
console.log('\npath depth distribution (a loop shows as a long tail):');
for (const [d, count] of [...depthHist].sort((a, b) => a[0] - b[0])) {
  if (count < Math.max(allPaths.length / 500, 2)) continue;
  const bar = '#'.repeat(Math.min(60, Math.round(count / Math.max(allPaths.length / 60, 1))));
  console.log(`  depth ${String(d).padStart(3)}  ${n(count).padStart(9)}  ${bar}`);
}

// ---- 3. What is actually referenced ----------------------------------------

head('Rows that something references');
const scheduled = db.prepare(
  'SELECT COUNT(DISTINCT r.file_path) AS n FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id',
).get().n;
const played = db.prepare(
  'SELECT COUNT(DISTINCT r.file_path) AS n FROM PlayHistory ph JOIN Resource r ON r.id = ph.resource_id',
).get().n;
const approved = db.prepare('SELECT COUNT(DISTINCT file_path) AS n FROM Resource WHERE approved = 1').get().n;
console.log(`in a ScheduledBlock      ${n(scheduled)}`);
console.log(`in PlayHistory           ${n(played)}`);
console.log(`approved                 ${n(approved)}`);
console.log('\nA cleanup keeps every path in the first two sets, whatever else it does.');

// ---- 4. Do these paths resolve to distinct files? --------------------------

head(`Physical identity (sampling ${n(Math.min(SAMPLE, allPaths.length))} paths - needs the share mounted)`);
const sample = allPaths.length <= SAMPLE
  ? allPaths
  : Array.from({ length: SAMPLE }, (_, i) => allPaths[Math.floor((i * allPaths.length) / SAMPLE)]);

const byIno = new Map();
let gone = 0; let unreadable = 0; let statted = 0;
for (const p of sample) {
  try {
    const info = await stat(localizePath(p));
    statted++;
    const key = `${info.dev}:${info.ino}`;
    if (!byIno.has(key)) byIno.set(key, []);
    byIno.get(key).push(p);
  } catch (err) {
    if (err.code === 'ENOENT') gone++; else unreadable++;
  }
}
console.log(`stat succeeded           ${n(statted)}`);
console.log(`not on disk (ENOENT)     ${n(gone)}`);
console.log(`unreadable (other)       ${n(unreadable)}`);
console.log(`distinct physical files  ${n(byIno.size)}`);
if (statted) {
  const ratio = statted / Math.max(byIno.size, 1);
  console.log(`paths per physical file  ${ratio.toFixed(1)}x`);
  const projected = Math.round(paths / Math.max(ratio, 1));
  console.log(`\n=> projected REAL library size: about ${n(projected)} clips`);
  console.log(`   projected duplicate rows:      about ${n(Math.max(paths - projected, 0))}`);
  const worst = [...byIno.values()].filter((v) => v.length > 1).sort((a, b) => b.length - a.length);
  if (worst.length) {
    console.log(`\n${n(worst.length)} sampled file(s) are catalogued under more than one path. Worst:`);
    for (const group of worst.slice(0, 3)) {
      console.log(`\n  ${basename(group[0])} - ${group.length} paths, e.g.`);
      for (const p of group.slice(0, 3)) console.log(`    ${p}`);
    }
  }
}

head('What this decides');
console.log(`If "paths per physical file" is well above 1, the catalogue holds the same clips
many times over, and the repair is to keep ONE path per physical file and
quarantine the rest - never deleting, and never dropping a path a block
references. If instead almost everything is ENOENT, the rows point at a tree
that no longer exists and the repair is a different one. Send this report before
any cleanup runs: which of the two it is decides what the cleanup does.`);
