// Phase 6 — validate every Resource against the scheduler's consumption gate,
// then set `approved` accordingly.
//
// This is the phase that actually opens the catalog to the scheduling engine, so
// it encodes the gate exactly as the engine applies it:
//   src/services/scheduling.js:126  main pool   -> channel_id, is_filler = 0, approved = 1
//   src/services/scheduling.js:139  serial pool -> ... ORDER BY chapter ASC, id ASC
//   src/services/scheduling.js:242  filler pool -> channel_id, is_filler = 1, approved = 1
//   src/services/scheduling.js:84   series gate -> ChannelSeries.is_active = 1
//   src/services/playHistory.js:32  progression -> chapter >= cursor
//
// A row is approved only when it can actually be picked and placed; everything
// else is quarantined at approved = 0 with a reason code, never deleted.
//
// Run LAST, after 02-split-series, 03-lessons, 04-hygiene, 05b-chapters and
// 05-registry. Dry-run by default; pass --apply to write.

import { APPLY, flag, planner, q, one } from './lib.js';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const plan = planner('06-validate-approve');

// --- upstream quarantine decisions ------------------------------------------
// The earlier phases quarantine rows for reasons this phase cannot re-derive:
// an unidentifiable lesson, a duplicate copy, a one-off special that belongs to
// no series' numbering. Those rows are structurally VALID, so a purely
// structural gate would happily re-approve them and silently undo the decision.
// Read the ids back out of each phase's report and keep them quarantined.
const REPORTS = join(dirname(fileURLToPath(import.meta.url)), 'reports');
const UPSTREAM_PHASES = ['02-split-series', '03-lessons', '04-hygiene', '05b-chapters'];

const upstream = new Map(); // resource id -> reason
const missingReports = [];
for (const phase of UPSTREAM_PHASES) {
  const file = join(REPORTS, `${phase}.json`);
  if (!existsSync(file)) {
    missingReports.push(phase);
    continue;
  }
  const { notes = [], applied } = JSON.parse(readFileSync(file, 'utf8'));
  if (!applied) missingReports.push(`${phase} (report is from a DRY RUN)`);
  for (const n of notes) {
    if (!n || typeof n !== 'object') continue;
    // The phases were written independently and spell the key three ways; accept
    // all of them rather than making every phase agree.
    const id = n.quarantined ?? n.alreadyQuarantined ?? n.already_quarantined;
    if (id != null) {
      upstream.set(Number(id), { phase, detail: n.reason ?? 'quarantined upstream' });
    }
  }
}

if (missingReports.length) {
  console.error('\nMissing or dry-run upstream reports: ' + missingReports.join(', '));
  console.error(
    'Without them this phase would re-approve rows an earlier phase deliberately quarantined.'
  );
  if (APPLY && !flag('--ignore-missing-reports')) {
    console.error('Refusing to --apply. Run the earlier phases with --apply first,');
    console.error('or pass --ignore-missing-reports if you really mean to ignore them.');
    process.exit(1);
  }
}
console.log(`upstream quarantine decisions honoured: ${upstream.size} row(s)`);

const SHOW_TYPES = Object.fromEntries(q('SELECT id, name FROM ShowType').map((s) => [s.id, s.name]));

const before = one('SELECT SUM(approved) AS a, COUNT(*) - SUM(approved) AS q FROM Resource');

// Registry state, keyed by channel + subject.
const seriesKey = (channelId, subject) => channelId + '|' + subject;
const registry = new Map();
for (const s of q('SELECT channel_id, subject, is_serial, is_active FROM ChannelSeries')) {
  registry.set(seriesKey(s.channel_id, s.subject), s);
}

const rows = q(`
  SELECT id, name, file_path, duration, subject, chapter, is_filler,
         approved, channel_id, show_type_id
    FROM Resource
`);

// A serial series cannot advance past a chapter shared by two clips: one of them
// is simply unreachable. So a collision disqualifies only the LOSERS — one clip
// per chapter stays approved, preferring whichever is already scheduled or has
// aired (its id is referenced), else the lowest id.
const referenced = new Set(
  q(`SELECT resource_id AS id FROM ScheduleItem
     UNION
     SELECT resource_id AS id FROM PlayHistory`).map((r) => r.id)
);
const collisionLosers = new Set();
const byChapter = new Map();
for (const r of rows) {
  if (r.is_filler) continue;
  const k = seriesKey(r.channel_id, r.subject) + '|' + r.chapter;
  if (!byChapter.has(k)) byChapter.set(k, []);
  byChapter.get(k).push(r);
}
for (const group of byChapter.values()) {
  if (group.length < 2) continue;
  const keeper = group
    .slice()
    .sort(
      (a, b) => (referenced.has(b.id) ? 1 : 0) - (referenced.has(a.id) ? 1 : 0) || a.id - b.id
    )[0];
  for (const r of group) if (r.id !== keeper.id) collisionLosers.add(r.id);
}

/** Returns null when the row is consumable, otherwise a reason code. */
function reject(r) {
  // An earlier phase already ruled on this row; the detail is kept in the notes.
  const decided = upstream.get(r.id);
  if (decided) return 'upstream-' + decided.phase;
  if (!(r.duration > 0)) return 'duration-not-positive';
  if (r.channel_id == null) return 'no-channel';
  if (r.show_type_id == null) return 'no-show-type';

  if (r.is_filler) return null; // fillers are a channel-wide pool: no subject, no chapter

  if (r.subject == null || String(r.subject).trim() === '') return 'no-subject';

  const series = registry.get(seriesKey(r.channel_id, r.subject));
  if (!series) return 'series-not-registered';
  if (!series.is_active) return 'series-inactive';

  if (series.is_serial) {
    if (!(r.chapter > 0)) return 'serial-chapter-zero';
    if (collisionLosers.has(r.id)) return 'serial-chapter-collision';
  }
  return null;
}

const reasons = new Map();
const perType = new Map();
let toApprove = 0;
let toQuarantine = 0;

for (const r of rows) {
  const reason = reject(r);
  const want = reason ? 0 : 1;
  const type = SHOW_TYPES[r.show_type_id] || 'unclassified';
  if (!perType.has(type)) perType.set(type, { approved: 0, quarantined: 0 });
  perType.get(type)[want ? 'approved' : 'quarantined']++;

  if (reason) {
    if (!reasons.has(reason)) reasons.set(reason, []);
    reasons.get(reason).push({ id: r.id, name: r.name, subject: r.subject });
  }

  if (r.approved === want) continue; // already correct — keep the run idempotent
  plan.op('UPDATE Resource SET approved = ? WHERE id = ?', [want, r.id], null);
  if (want) toApprove++;
  else toQuarantine++;
}

console.log('\n--- validation summary ---');
console.log(`before: ${before.a} approved / ${before.q} quarantined  (${rows.length} rows)`);
console.log(`changes queued: +${toApprove} approve, -${toQuarantine} quarantine`);

console.log('\nresult by show type:');
for (const [type, c] of [...perType].sort()) {
  const a = String(c.approved).padStart(5);
  const qn = String(c.quarantined).padStart(5);
  console.log('  ' + type.padEnd(16) + ' approved ' + a + '   quarantined ' + qn);
}

console.log('\nquarantine reasons:');
for (const [reason, list] of [...reasons].sort((a, b) => b[1].length - a[1].length)) {
  console.log('  ' + reason.padEnd(26) + String(list.length).padStart(5));
  for (const s of list.slice(0, 5)) {
    console.log('      - [' + s.id + '] ' + (s.subject ?? '(no subject)') + ' :: ' + s.name);
  }
  if (list.length > 5) {
    console.log('      ... and ' + (list.length - 5) + ' more (see reports/06-validate-approve.json)');
  }
}

plan.note({ before: { approved: before.a, quarantined: before.q } });
plan.note({ byShowType: Object.fromEntries(perType) });
plan.note({ reasonCounts: Object.fromEntries([...reasons].map(([k, v]) => [k, v.length])) });
for (const [reason, list] of reasons) {
  for (const s of list) {
    const up = upstream.get(s.id);
    plan.note({
      quarantined: s.id,
      subject: s.subject,
      name: s.name,
      reason,
      ...(up ? { upstreamDetail: up.detail } : {}),
    });
  }
}

plan.commit();

// --- verification -----------------------------------------------------------
if (APPLY) {
  const after = one('SELECT SUM(approved) AS a, COUNT(*) - SUM(approved) AS q FROM Resource');
  const badSeries = one(`
    SELECT COUNT(*) AS n FROM Resource r
     WHERE r.approved = 1 AND r.is_filler = 0
       AND NOT EXISTS (SELECT 1 FROM ChannelSeries cs
                        WHERE cs.channel_id = r.channel_id AND cs.subject = r.subject
                          AND cs.is_active = 1)
  `).n;
  const badDuration = one('SELECT COUNT(*) AS n FROM Resource WHERE approved = 1 AND duration <= 0').n;
  const collisions = one(`
    SELECT COUNT(*) AS n FROM (
      SELECT r.channel_id, r.subject, r.chapter
        FROM Resource r
        JOIN ChannelSeries cs ON cs.channel_id = r.channel_id AND cs.subject = r.subject
       WHERE r.approved = 1 AND r.is_filler = 0 AND cs.is_serial = 1
       GROUP BY r.channel_id, r.subject, r.chapter
      HAVING COUNT(*) > 1
    )
  `).n;

  console.log('\n--- post-apply verification (all must be 0) ---');
  console.log('  approved rows in an unregistered/inactive series : ' + badSeries);
  console.log('  approved rows with duration <= 0                 : ' + badDuration);
  console.log('  chapter collisions in approved serial series     : ' + collisions);
  console.log('\nafter: ' + after.a + ' approved / ' + after.q + ' quarantined');
  if (badSeries || badDuration || collisions) {
    console.error('\nFAILED: the catalog is not consumable. Restore data/backups/ and investigate.');
    process.exitCode = 1;
  }
}
