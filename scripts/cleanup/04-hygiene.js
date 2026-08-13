#!/usr/bin/env node
// Phase 4 of the catalog cleanup — hygiene for Movies, Fillers and duplicates.
//
// Dry run by default; pass --apply to write. Honours SCHEDULER_DB.
//
//   node scripts/cleanup/04-hygiene.js            # report only
//   node scripts/cleanup/04-hygiene.js --apply    # commit
//
// Three independent passes, all idempotent (every statement is only queued when
// the row is not already in the desired state, so a second run plans 0 ops):
//
//   1. Movies (show_type_id 1) — `chapter` holds a parsed release year for many
//      rows because the filename parser fell back to the last integer in the
//      name. The movie rule is random-with-cooldown and never reads `chapter`
//      (src/services/scheduling.js, src/services/playHistory.js), so the year is
//      pure noise that shows up in the Catalog UI as an episode number. Zero it.
//   2. Fillers (show_type_id 5) — the knapsack silently drops non-positive
//      durations (src/services/scheduling.js:253 filters `d > 0`), so a filler
//      with duration <= 0 is dead weight that still looks available in the UI:
//      quarantine it. A stray `subject` or a wrong `is_filler` flag is repaired
//      in place instead — those are cosmetic/pool-coherence issues, and dropping
//      an otherwise-good clip from the pool would be the bigger harm.
//   3. Duplicates — rows sharing (name, duration). NOTHING is deleted: a rescan
//      would recreate them, and their ids are referenced by ScheduleItem /
//      PlayHistory. One row per group stays approved, the rest get approved = 0
//      so the engine stops treating them as distinct pickable content.

import {
  APPLY,
  q,
  one,
  planner,
  quarantine,
} from './lib.js';

const CHANNEL_ID = 1; // the only channel
const ST_MOVIES = 1;
const ST_FILLERS = 5;

const plan = planner('04-hygiene');

// --- 1. Movies --------------------------------------------------------------

function movies() {
  const rows = q(
    `SELECT id, name, chapter, subject FROM Resource
      WHERE channel_id = ? AND show_type_id = ?
      ORDER BY id`,
    CHANNEL_ID,
    ST_MOVIES
  );

  const withChapter = rows.filter((r) => r.chapter !== 0);
  for (const r of withChapter) {
    plan.op('UPDATE Resource SET chapter = 0 WHERE id = ?', [r.id], null);
  }
  plan.note(
    `movies: ${withChapter.length}/${rows.length} rows have a non-zero chapter (parsed release year) → chapter = 0`
  );
  // Show the range so the operator can sanity-check these really are years.
  if (withChapter.length) {
    const vals = withChapter.map((r) => r.chapter).sort((a, b) => a - b);
    plan.note(`movies: chapter values seen ${vals[0]}..${vals[vals.length - 1]}`);
  }

  // subject is the series key the engine groups by; a movie outside 'Movies'
  // would be scheduled as its own one-off series. Report, don't rewrite: the
  // right subject for such a row is a human call (it may be misfiled entirely).
  const offSubject = rows.filter((r) => r.subject !== 'Movies');
  for (const r of offSubject) {
    plan.note({
      needs_decision: r.id,
      name: r.name,
      reason: `Movies row with subject ${JSON.stringify(r.subject)} (expected "Movies") — not rewritten`,
    });
  }
  if (!offSubject.length) plan.note(`movies: all ${rows.length} rows have subject = "Movies"`);

  // Movies is random-with-cooldown, never sequential.
  const series = one(
    'SELECT id, is_serial, is_active FROM ChannelSeries WHERE channel_id = ? AND subject = ?',
    CHANNEL_ID,
    'Movies'
  );
  if (!series) {
    plan.note({
      needs_decision: null,
      reason: 'no ChannelSeries row for subject "Movies" on channel 1 — Movies will not be schedulable',
    });
  } else if (series.is_serial !== 0) {
    plan.op(
      'UPDATE ChannelSeries SET is_serial = 0 WHERE id = ?',
      [series.id],
      `ChannelSeries "Movies": is_serial ${series.is_serial} → 0 (random-with-cooldown, not sequential)`
    );
  } else {
    plan.note('movies: ChannelSeries "Movies" already is_serial = 0');
  }
}

// --- 2. Fillers -------------------------------------------------------------

function fillers() {
  const rows = q(
    `SELECT id, name, subject, duration, is_filler, approved FROM Resource
      WHERE channel_id = ? AND show_type_id = ?
      ORDER BY id`,
    CHANNEL_ID,
    ST_FILLERS
  );

  let badDuration = 0;
  let straySubject = 0;
  let flagOff = 0;

  for (const r of rows) {
    // duration <= 0: the packer filters these out (scheduling.js:253), so the
    // clip can never be placed. Quarantine so the UI stops offering it.
    if (!(r.duration > 0)) {
      badDuration++;
      if (r.approved !== 0) {
        quarantine(plan, r.id, r.name, `filler duration ${r.duration} <= 0 — knapsack silently drops it; re-scan to fix the duration`);
      } else {
        plan.note({ already_quarantined: r.id, name: r.name, reason: `filler duration ${r.duration} <= 0` });
      }
    }
    // subject on a filler is meaningless (fillers are pooled by is_filler, not
    // by series) and makes the clip show up as a series in the Catalog tree.
    if (r.subject !== null) {
      straySubject++;
      plan.op(
        'UPDATE Resource SET subject = NULL WHERE id = ?',
        [r.id],
        `filler ${r.id} "${r.name}": subject ${JSON.stringify(r.subject)} → NULL`
      );
    }
    // Fillers show type must carry the row-level flag or the packer can't see it.
    if (r.is_filler !== 1) {
      flagOff++;
      plan.op(
        'UPDATE Resource SET is_filler = 1 WHERE id = ?',
        [r.id],
        `filler ${r.id} "${r.name}": show_type = Fillers but is_filler = ${r.is_filler} → 1`
      );
    }
  }

  plan.note(
    `fillers: ${rows.length} rows — ${badDuration} with duration <= 0, ${straySubject} with a stray subject, ${flagOff} missing is_filler`
  );

  // Inverse: flagged as filler but filed under another show type. Those land in
  // the filler pool while the UI files them elsewhere, so the pool is incoherent.
  const strays = q(
    `SELECT id, name, show_type_id FROM Resource
      WHERE channel_id = ? AND is_filler = 1
        AND (show_type_id IS NULL OR show_type_id != ?)
      ORDER BY id`,
    CHANNEL_ID,
    ST_FILLERS
  );
  for (const r of strays) {
    plan.op(
      'UPDATE Resource SET is_filler = 0 WHERE id = ?',
      [r.id],
      `resource ${r.id} "${r.name}": is_filler = 1 but show_type = ${r.show_type_id} → is_filler = 0 (out of the filler pool)`
    );
  }
  plan.note(`fillers: ${strays.length} row(s) flagged is_filler outside show_type ${ST_FILLERS}`);
}

// --- 3. Duplicates ----------------------------------------------------------

// Scoped to the WHOLE Resource table: duplicate groups cross show types (the
// same lesson filed under two term folders, a movie also present under TV).
function duplicates() {
  const rows = q(
    `SELECT r.id, r.name, r.duration, r.file_path, r.subject, r.chapter,
            r.show_type_id, r.approved,
            (SELECT COUNT(*) FROM ScheduleItem si WHERE si.resource_id = r.id) AS si_refs,
            (SELECT COUNT(*) FROM PlayHistory ph WHERE ph.resource_id = r.id) AS ph_refs
       FROM Resource r
      WHERE r.channel_id = ?
        AND EXISTS (
              SELECT 1 FROM Resource d
               WHERE d.channel_id = r.channel_id
                 AND d.name = r.name AND d.duration = r.duration
                 AND d.id != r.id)
      ORDER BY r.name, r.duration, r.id`,
    CHANNEL_ID
  );

  const groups = new Map();
  for (const r of rows) {
    const key = `${r.name}\u0000${r.duration}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let handled = 0;
  let quarantined = 0;
  let human = 0;

  for (const members of groups.values()) {
    const first = members[0];
    const header = `dup "${first.name}" (${first.duration}s, ${members.length} rows)`;
    const referenced = members.filter((m) => m.si_refs + m.ph_refs > 0);

    // Always print every path: only the operator can tell "same file in two
    // folders" from "two different clips that happen to share a name".
    plan.note(
      `${header}: ` +
        members
          .map(
            (m) =>
              `#${m.id}${m.approved ? '' : ' (unapproved)'} st=${m.show_type_id} ` +
              `si=${m.si_refs} ph=${m.ph_refs} ${m.file_path}`
          )
          .join(' || ')
    );

    if (referenced.length > 1) {
      // Two live rows: deciding which airing history is canonical is not
      // something this script can guess. Leave every row approved, touch nothing.
      human++;
      plan.note({
        needs_decision: members.map((m) => m.id),
        name: first.name,
        reason:
          `${referenced.length} of ${members.length} duplicate rows are referenced by ScheduleItem/PlayHistory ` +
          `(${referenced.map((m) => `#${m.id}:si=${m.si_refs},ph=${m.ph_refs}`).join(', ')}) — ` +
          `left approved, needs a human to merge the references before one can be quarantined`,
      });
      continue;
    }

    // Keeper: the single referenced row, else the lowest id.
    const keeper = referenced.length === 1 ? referenced[0] : members.reduce((a, b) => (a.id <= b.id ? a : b));
    const losers = members.filter((m) => m.id !== keeper.id);

    // If the keeper was already pulled out of circulation (by an earlier phase,
    // or by the operator) but a sibling is still live, quarantining the sibling
    // would leave the group with nothing playable. Don't silently resurrect the
    // keeper — that would undo a deliberate decision. Report instead.
    if (!keeper.approved && losers.some((m) => m.approved)) {
      human++;
      plan.note({
        needs_decision: members.map((m) => m.id),
        name: first.name,
        reason:
          `keeper #${keeper.id} (${referenced.length === 1 ? 'the referenced row' : 'lowest id'}) is approved = 0 ` +
          `while sibling(s) ${losers.filter((m) => m.approved).map((m) => `#${m.id}`).join(', ')} are approved — ` +
          `not quarantining, or the group would have no approved row left`,
      });
      continue;
    }

    handled++;
    plan.note(
      `${header}: keep #${keeper.id} (${referenced.length === 1 ? 'referenced by schedule/history' : 'lowest id'})`
    );
    for (const m of losers) {
      if (m.approved === 0) {
        // Already out of circulation, so no UPDATE is needed (that is what keeps
        // this phase idempotent) — but the DECISION still has to be recorded, or
        // 06-validate-approve sees a structurally valid row, re-approves it, and
        // the next run of this phase quarantines it again, forever.
        plan.note({
          alreadyQuarantined: m.id,
          name: m.name,
          reason: `duplicate of #${keeper.id} (same name + duration ${m.duration}s); kept ${keeper.file_path}`,
        });
        continue;
      }
      quarantine(
        plan,
        m.id,
        m.name,
        `duplicate of #${keeper.id} (same name + duration ${m.duration}s); kept ${keeper.file_path}`
      );
      quarantined++;
    }
  }

  plan.note(
    `duplicates: ${groups.size} group(s) — ${handled} resolved to a single keeper, ` +
      `${quarantined} row(s) newly quarantined, ${human} group(s) need a human decision`
  );
}

// --- Verification -----------------------------------------------------------

function verify() {
  const movieChapters = one(
    'SELECT COUNT(*) AS n FROM Resource WHERE channel_id = ? AND show_type_id = ? AND chapter != 0',
    CHANNEL_ID,
    ST_MOVIES
  ).n;

  const fillerBad = one(
    `SELECT COUNT(*) AS n FROM Resource
      WHERE channel_id = ?
        AND ( (show_type_id = ? AND (is_filler != 1 OR subject IS NOT NULL OR duration <= 0))
           OR (is_filler = 1 AND (show_type_id IS NULL OR show_type_id != ?)) )`,
    CHANNEL_ID,
    ST_FILLERS,
    ST_FILLERS
  ).n;

  const dupApproved = one(
    `SELECT COUNT(*) AS n FROM (
       SELECT name, duration FROM Resource
        WHERE channel_id = ? AND approved = 1
        GROUP BY name, duration HAVING COUNT(*) > 1)`,
    CHANNEL_ID
  ).n;

  console.log(`\n=== verification (${APPLY ? 'post-apply' : 'current DB — dry run changed nothing'}) ===`);
  console.log(`  Movies rows with chapter != 0                 : ${movieChapters}`);
  console.log(`  Fillers rows failing an invariant             : ${fillerBad}`);
  console.log(`  (name,duration) groups with >1 approved row   : ${dupApproved}`);
  if (!APPLY) {
    console.log('  ^ these are the PRE-fix counts; re-run with --apply, then again to confirm they drop.');
  }
  return { movieChapters, fillerBad, dupApproved };
}

movies();
fillers();
duplicates();
plan.commit();
verify();
