#!/usr/bin/env node
// Phase 2 — split contaminated series in Documentaries (show_type 2) and
// TV Shows (show_type 3).
//
// Symptom being repaired: a single Resource.subject conflates two different
// shows, because the scan picked up a parent folder that held both. Two shows
// under one subject means two episode-1s, two episode-2s, ... — duplicate
// `chapter` values inside one series, which breaks the engine's sequential
// progression (`chapter = last_played + 1` picks arbitrarily between the twins).
//
// What this does, per rule in SPLITS below:
//   1. moves the matching rows to their own subject,
//   2. registers the new subject in ChannelSeries (inheriting show_type_id /
//      is_serial from the subject it was split out of),
//   3. renumbers BOTH sides to a contiguous 1..N by name.
//
// Rows that belong to no series at all (a stray clip that landed in a show's
// folder) are only quarantined — approved = 0 hides them from the scheduler
// without guessing a home for them. Their subject is left alone on purpose.
//
// Dry run by default; pass --apply to write. Honours SCHEDULER_DB.
//
// Usage:
//   node scripts/cleanup/02-split-series.js            # dry run + report
//   node scripts/cleanup/02-split-series.js --apply     # commit

import { q, one, planner, ensureSeries, renumber, quarantine } from './lib.js';

/** Discover — the only channel (ChannelType.id = 1). */
const CHANNEL_ID = 1;

/** Phase 2 is scoped to Documentaries + TV Shows. */
const SHOW_TYPES = [2, 3];

// ---------------------------------------------------------------------------
// The rules. `match` is either { like: '<SQL LIKE pattern>' } (escape char is
// '\', so '\_' means a literal underscore) or { pred: row => boolean }.
// `expect` is the row count profiled from the live DB — a mismatch is reported,
// not fatal, since the catalog keeps being rescanned.
// ---------------------------------------------------------------------------
const SPLITS = [
  // "Full House" also held its sequel series.
  { from: 'Full House', to: 'Fuller House', match: { like: 'Fuller\\_House%' }, expect: 73 },

  // "Octonauts" also held the Netflix follow-up series.
  {
    from: 'Octonauts',
    to: 'Octonauts Above and Beyond',
    match: { like: 'Octonauts\\_Above\\_and\\_Beyond%' },
    expect: 75,
  },

  // "Spanish Program" is a folder name, not a show: it holds two distinct
  // language series and nothing else.
  {
    from: 'Spanish Program',
    to: 'La Escuelita de Español',
    match: { like: 'La\\_Escuelita\\_de\\_Espanol%' },
    expect: 47,
  },
  {
    from: 'Spanish Program',
    to: 'La Escuelita de Inglés',
    match: { like: 'La\\_Escuelita\\_de\\_Ingles%' },
    expect: 47,
  },

  // "New folder" is an unnamed scan folder holding extra Math Intervention
  // episodes; `to` is an existing series, so this is a merge rather than a split.
  {
    from: 'New folder',
    to: 'Math Intervention',
    match: { like: 'Math Intervention Program - %' },
    expect: 12,
    append: true,
  },
];

// ---------------------------------------------------------------------------
// Quarantine-only rules: these rows do not belong to their subject, but they do
// not form a series either. approved = 0, subject untouched.
// ---------------------------------------------------------------------------
const QUARANTINES = [
  {
    subject: 'R.E.A.D',
    reason: 'unrelated handwriting clip filed under the R.E.A.D series',
    // Every real episode is named "R.E.A.D_Read_Enjoy_&_Discover_EpNN_...".
    match: { pred: (r) => !r.name.startsWith('R.E.A.D') },
    expect: 1,
  },
  {
    subject: 'Octonauts',
    reason: 'one-off special, not part of either Octonauts series numbering',
    match: { like: 'Octonauts\\_Special%' },
    expect: 1,
  },
  {
    subject: 'Local Shows',
    reason: 'standalone local clip in a catch-all subject (no episode ordinal)',
    // "Local Shows" is a junk-drawer folder. The only coherent run in it is
    // Ms Fung's CSEC revision; everything else is a standalone one-off.
    // Matched by NAME, not by `chapter === 0`: 05b-chapters runs later and fills
    // the missing chapters in, so a chapter-based rule stops matching on a second
    // run and this phase silently drops the decision.
    match: { pred: (r) => !r.name.startsWith("Ms_Fung's") },
    expect: 1,
  },
  {
    subject: 'Documentaries',
    reason: 'standalone documentary in a catch-all subject (no episode ordinal)',
    // The whole "Documentaries" subject is the unsorted top-level folder: both
    // rows in it are one-offs that belong to no series. Name-based for the same
    // reason as above.
    match: { pred: () => true },
    expect: 2,
  },
  {
    subject: 'Students of Guyana',
    reason: 'CV/how-to clip filed under the Students of Guyana series',
    match: { like: 'CV\\_%' },
    expect: 1,
  },
];

// ---------------------------------------------------------------------------
// ChannelSeries case/spelling twins. `keep` is the better-cased spelling.
// Where only one spelling actually has resources there is nothing to move —
// the empty twin is reported for Phase 5 to deactivate. If a pair ever has
// resources on BOTH spellings, they are consolidated onto `keep`.
// ---------------------------------------------------------------------------
const TWINS = [
  { keep: 'Forts and Monuments', drop: 'forts and monuments' },
  { keep: 'Tongues of the Motherland', drop: 'Tongues of the MotherLand' },
  { keep: 'EdYou Pulse', drop: 'EDYOUPULSE' },
  { keep: 'Students of Guyana', drop: 'STUDENTS OF GUYANA' },
  { keep: 'CPCE Teacher Lessons', drop: 'CPCE TEACHER LESSONS' },
  { keep: 'Math Intervention', drop: 'Math Intervention Program' },
  { keep: 'Beatin da Maths', drop: 'Beatin the Maths' },
  { keep: 'AgriTalks', drop: 'Agri Talks' },
];

// ---------------------------------------------------------------------------

const plan = planner('02-split-series');

/** Non-filler resources of one subject on the channel, ordered by name. */
const rowsOf = (subject) =>
  q(
    `SELECT id, name, chapter, approved, show_type_id FROM Resource
      WHERE channel_id = ? AND subject = ? AND is_filler = 0
      ORDER BY name ASC, id ASC`,
    CHANNEL_ID,
    subject
  );

const seriesOf = (subject) =>
  one('SELECT * FROM ChannelSeries WHERE channel_id = ? AND subject = ?', CHANNEL_ID, subject);

const matches = (rule, subject, row) => {
  if (rule.match.pred) return rule.match.pred(row);
  return (
    one(
      `SELECT 1 AS hit FROM Resource
        WHERE id = ? AND subject = ? AND name LIKE ? ESCAPE '\\'`,
      row.id,
      subject,
      rule.match.like
    ) != null
  );
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id - b.id);

// Projection of the post-plan world, so a dry run can verify itself: id -> {subject, chapter}.
const projected = new Map();
for (const r of q(
  `SELECT id, subject, chapter, show_type_id FROM Resource
    WHERE channel_id = ? AND is_filler = 0 AND show_type_id IN (${SHOW_TYPES.join(',')})`,
  CHANNEL_ID
)) {
  projected.set(r.id, { subject: r.subject, chapter: r.chapter, show_type_id: r.show_type_id });
}
/** subject -> is_serial, including subjects this script is about to create. */
const isSerial = new Map(
  q('SELECT subject, is_serial FROM ChannelSeries WHERE channel_id = ?', CHANNEL_ID).map((r) => [
    r.subject,
    r.is_serial,
  ])
);

/** Record what renumber() will write, for the projection. */
function project(subject, rows) {
  rows.forEach((r, i) => {
    const p = projected.get(r.id);
    if (p) {
      p.subject = subject;
      p.chapter = i + 1;
    }
  });
}

let moved = 0;
let quarantined = 0;
let quarantineNoops = 0;

// --- 1. splits -------------------------------------------------------------

// Group rules by source subject so each source is read once and renumbered once.
const bySource = new Map();
for (const rule of SPLITS) {
  if (!bySource.has(rule.from)) bySource.set(rule.from, []);
  bySource.get(rule.from).push(rule);
}

for (const [from, rules] of bySource) {
  const parent = seriesOf(from);
  const source = rowsOf(from);
  if (!source.length) {
    plan.note(`split source "${from}" has no resources (already split?) — nothing to move`);
  }
  if (!parent) {
    plan.note(`WARNING: no ChannelSeries row for split source "${from}" — new series get show_type=null`);
  }

  const claimed = new Map(); // row id -> rule.to, to catch overlapping patterns
  const keep = [];

  for (const row of source) {
    const hits = rules.filter((rule) => matches(rule, from, row));
    if (hits.length > 1) {
      plan.note(
        `AMBIGUOUS: "${row.name}" (id ${row.id}) matches ${hits.length} rules ` +
          `(${hits.map((h) => h.to).join(', ')}) — left in "${from}" for manual review`
      );
      keep.push(row);
      continue;
    }
    if (hits.length === 1) claimed.set(row.id, hits[0].to);
    else keep.push(row);
  }

  for (const rule of rules) {
    const take = source.filter((r) => claimed.get(r.id) === rule.to);
    // Already-landed rows: on a re-run the source matches nothing because the
    // rows now sit on the destination. Only flag drift when the numbers cannot
    // be explained that way.
    const landed = one(
      `SELECT COUNT(*) AS n FROM Resource
        WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND name LIKE ? ESCAPE '\\'`,
      CHANNEL_ID,
      rule.to,
      rule.match.like ?? '%'
    ).n;
    if (take.length !== rule.expect && take.length + landed < rule.expect) {
      plan.note(
        `count drift: "${rule.from}" -> "${rule.to}" matched ${take.length} row(s) ` +
          `(+${landed} already on the destination), expected ${rule.expect}`
      );
    }
    for (const r of take) {
      plan.op(
        'UPDATE Resource SET subject = ? WHERE id = ?',
        [rule.to, r.id],
        null
      );
    }
    moved += take.length;
    if (take.length) {
      plan.note(`split "${rule.from}" -> "${rule.to}": ${take.length} row(s) moved`);
    }

    // Register the destination, inheriting the parent's classification.
    ensureSeries(plan, CHANNEL_ID, rule.to, parent?.show_type_id ?? null, parent?.is_serial ?? 1);
    if (!isSerial.has(rule.to)) isSerial.set(rule.to, parent?.is_serial ?? 1);

    // renumber() reads the DB, and in a dry run these moves are not committed
    // yet — so hand it the post-move row list. Destination = rows already on
    // that subject (non-zero on re-runs and on merges) + the rows arriving now.
    const existing = rowsOf(rule.to).filter((r) => !claimed.has(r.id));
    // A merge into an established series appends the newcomers instead of sorting
    // them in: the incoming files use a different naming style ("Math Intervention
    // Program - X" vs "Math_Intervention_Program_001_X"), and a plain name sort
    // would put every newcomer ahead of episode 1 and shift the whole canonical
    // numbering the operator already knows. A split into a fresh subject has no
    // established numbering to protect, so it sorts normally.
    //
    // On a RE-RUN the newcomers are already part of `existing`, so re-sorting by
    // name would undo the append and shuffle the numbering back — the plan would
    // never converge. When the destination is already numbered 1..N with no gaps
    // there is nothing to fix, so leave it alone; that is what makes this phase
    // idempotent for merges.
    const contiguous =
      existing.length > 0 &&
      existing
        .slice()
        .sort((a, b) => a.chapter - b.chapter)
        .every((r, i) => r.chapter === i + 1);

    if (rule.append && !take.length && contiguous) {
      plan.note(`"${rule.to}" already numbered 1..${existing.length}; merge renumber skipped`);
      project(rule.to, existing.slice().sort((a, b) => a.chapter - b.chapter));
    } else {
      const dest = rule.append
        ? [
            // Keep whatever order the destination already carries (chapter order)
            // and append only the arriving rows, so established numbering holds.
            ...existing.slice().sort((a, b) => (a.chapter || Infinity) - (b.chapter || Infinity) || byName(a, b)),
            ...take.sort(byName),
          ]
        : [...existing, ...take].sort(byName);
      renumber(plan, CHANNEL_ID, rule.to, 'name', dest);
      project(rule.to, dest);

      if (rule.append && take.length) {
        plan.note(
          `"${rule.to}" merge appends the ${take.length} "${rule.from}" row(s) AFTER the ` +
            `${existing.length} existing episodes (chapters ${existing.length + 1}..${dest.length}), ` +
            `leaving the established numbering untouched.`
        );
      }
    }
  }

  // The source keeps whatever did not match any rule.
  renumber(plan, CHANNEL_ID, from, 'name', keep);
  project(from, keep);
  if (!keep.length && source.length) {
    plan.note(
      `"${from}" is empty after the split — its ChannelSeries row is a candidate for Phase 5 deactivation`
    );
  }
}

// --- 2. quarantine-only rows ----------------------------------------------

for (const rule of QUARANTINES) {
  const hits = rowsOf(rule.subject).filter((r) => matches(rule, rule.subject, r));
  if (hits.length !== rule.expect) {
    plan.note(
      `count drift: quarantine rule on "${rule.subject}" matched ${hits.length} row(s), expected ${rule.expect}`
    );
  }
  for (const r of hits) {
    if (r.approved === 0) {
      // Already hidden from the engine — record it, but do not queue a no-op
      // UPDATE, so re-running after --apply stays clean.
      plan.note({ alreadyQuarantined: r.id, name: r.name, reason: rule.reason });
      quarantineNoops++;
      continue;
    }
    quarantine(plan, r.id, r.name, `[${rule.subject}] ${rule.reason}`);
    quarantined++;
  }
}

// --- 3. ChannelSeries spelling twins --------------------------------------

for (const { keep, drop } of TWINS) {
  const keepRow = seriesOf(keep);
  const dropRow = seriesOf(drop);
  if (!dropRow) continue; // twin already gone
  const dropRes = rowsOf(drop);
  if (!dropRes.length) {
    plan.note(
      `twin "${drop}" (series id ${dropRow.id}) has 0 resources; "${keep}" has ` +
        `${rowsOf(keep).length} — leave for Phase 5 to deactivate`
    );
    continue;
  }
  if (!keepRow) {
    plan.note(`twin pair "${drop}" -> "${keep}": no ChannelSeries row for "${keep}", skipping`);
    continue;
  }
  // Both spellings carry resources: consolidate onto the better-cased one.
  for (const r of dropRes) {
    plan.op('UPDATE Resource SET subject = ? WHERE id = ?', [keep, r.id], null);
  }
  moved += dropRes.length;
  plan.note(`consolidate twin "${drop}" -> "${keep}": ${dropRes.length} row(s) moved`);
  const merged = [...rowsOf(keep), ...dropRes].sort(byName);
  renumber(plan, CHANNEL_ID, keep, 'name', merged);
  project(keep, merged);
  plan.note(`twin "${drop}" is now empty — candidate for Phase 5 deactivation`);
}

// --- 4. residual collisions this phase does not claim ---------------------

const collide = new Map();
for (const [, p] of projected) {
  if (!SHOW_TYPES.includes(p.show_type_id)) continue;
  if (!isSerial.get(p.subject)) continue;
  const k = `${p.subject}\u0000${p.chapter}`;
  collide.set(k, (collide.get(k) || 0) + 1);
}
const residual = new Map();
for (const [k, n] of collide) {
  if (n < 2) continue;
  const subject = k.split('\u0000')[0];
  residual.set(subject, (residual.get(subject) || 0) + 1);
}
if (residual.size) {
  plan.note(
    `MANUAL REVIEW — ${residual.size} subject(s) in show_type ${SHOW_TYPES.join('/')} still have ` +
      `duplicate (subject, chapter) pairs after this phase; not claimed by any rule above:`
  );
  for (const [subject, dups] of [...residual].sort((a, b) => b[1] - a[1])) {
    plan.note(`  "${subject}": ${dups} duplicated chapter value(s)`);
  }
} else {
  plan.note('no duplicate (subject, chapter) pairs remain in scope after this phase');
}

// --- 5. summary + commit --------------------------------------------------

console.log('\n--- phase 2 summary ---');
console.log(`  resources moved to a new subject : ${moved}`);
console.log(`  rows quarantined (approved 1->0) : ${quarantined}`);
console.log(`  rows already quarantined (no-op) : ${quarantineNoops}`);

plan.commit();

// --- 6. verification -----------------------------------------------------

const VERIFY = `
  SELECT r.channel_id, r.subject, r.chapter, COUNT(*) AS n
    FROM Resource r
    JOIN ChannelSeries cs
      ON cs.channel_id = r.channel_id AND cs.subject = r.subject
   WHERE r.is_filler = 0
     AND cs.is_serial = 1
     AND r.show_type_id IN (${SHOW_TYPES.join(',')})
   GROUP BY r.channel_id, r.subject, r.chapter
  HAVING COUNT(*) > 1
   ORDER BY r.subject, r.chapter`;

const live = q(VERIFY);
console.log(`\n=== verification: (channel_id, subject, chapter) collisions in DB now — ${live.length} ===`);
for (const r of live.slice(0, 40)) {
  console.log(`  ch${r.channel_id}  ${JSON.stringify(r.subject)}  chapter=${r.chapter}  x${r.n}`);
}
if (live.length > 40) console.log(`  … ${live.length - 40} more`);

const projectedCollisions = [...collide].filter(([, n]) => n > 1);
console.log(
  `\n=== projected after this plan is applied — ${projectedCollisions.length} collision(s) ===`
);
for (const [k, n] of projectedCollisions.slice(0, 40)) {
  const [subject, chapter] = k.split('\u0000');
  console.log(`  ch${CHANNEL_ID}  ${JSON.stringify(subject)}  chapter=${chapter}  x${n}`);
}
if (projectedCollisions.length > 40) {
  console.log(`  … ${projectedCollisions.length - 40} more`);
}
