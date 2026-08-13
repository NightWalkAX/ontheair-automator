// Phase 7 — repair the BlockTemplateSeries rows that the subject rewrites broke.
//
// BlockTemplateSeries names a series by TEXT subject scoped to a template
// (src/db.js:157 — no series_id, no channel_id; the channel comes from the
// template). Phases 02/03 rewrite `Resource.subject` wholesale, so a template
// row can survive pointing at a subject that no longer holds any playable clip —
// which silently yields an empty block rather than an error.
//
// Two fixes, both explicitly confirmed by the operator:
//   1. Template "Academics" pointed at `Discover Academic`. Phase 03 moves that
//      folder's usable clips out to the per-grade Lessons series and leaves only
//      the 37 unidentifiable ones behind, so the block would go empty. Repoint it
//      at every Lessons series that has playable content.
//   2. Template "Thursday" pointed at `TheBluePlanetBBC`, an orphan torrent-named
//      series with 0 resources. The same template already carries
//      `The Blue Planet` (9 episodes), so the dead row is deleted outright.
//
// Run LAST, after 06-validate-approve, so `approved` already reflects the final
// gate and "has playable content" means what the scheduler will actually see.
// Dry-run by default; pass --apply to write.

import { APPLY, planner, q, one } from './lib.js';

const plan = planner('07-templates');

const LESSONS_SHOW_TYPE = one("SELECT id FROM ShowType WHERE code = 'lessons'")?.id ?? 4;

// --- 1. Academics -----------------------------------------------------------

const academics = one("SELECT id, name FROM BlockTemplate WHERE name = 'Academics'");
if (!academics) {
  plan.note('template "Academics" not found — skipping repoint (already renamed?)');
} else {
  const stale = one(
    "SELECT id FROM BlockTemplateSeries WHERE template_id = ? AND subject = 'Discover Academic'",
    academics.id
  );

  // Every active Lessons series holding at least one approved clip. Derived at
  // run time so this tracks whatever Phase 03 actually produced.
  const lessonSeries = q(
    `SELECT cs.subject,
            (SELECT COUNT(*) FROM Resource r
              WHERE r.channel_id = cs.channel_id AND r.subject = cs.subject
                AND r.is_filler = 0 AND r.approved = 1) AS n
       FROM ChannelSeries cs
      WHERE cs.show_type_id = ? AND cs.is_active = 1
      ORDER BY cs.subject`,
    LESSONS_SHOW_TYPE
  )
    // `Discover Academic` is the row being retired: it is the scan folder the
    // per-grade series were derived FROM, and only the unidentifiable leftovers
    // still carry that subject. Re-adding it would undo the delete below on every
    // run, so it can never be part of the repoint set.
    .filter((s) => s.subject !== 'Discover Academic')
    .filter((s) => s.n > 0);

  const present = new Set(
    q('SELECT subject FROM BlockTemplateSeries WHERE template_id = ?', academics.id).map(
      (r) => r.subject
    )
  );

  if (stale) {
    plan.op(
      'DELETE FROM BlockTemplateSeries WHERE id = ?',
      [stale.id],
      'Academics: drop stale row -> "Discover Academic" (only unidentified clips remain under it)'
    );
    present.delete('Discover Academic');
  }

  let order = one(
    'SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM BlockTemplateSeries WHERE template_id = ?',
    academics.id
  ).n;

  let added = 0;
  for (const s of lessonSeries) {
    if (present.has(s.subject)) continue; // UNIQUE(template_id, subject); keeps re-runs a no-op
    plan.op(
      'INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, ?, ?)',
      [academics.id, s.subject, order++],
      `Academics: + "${s.subject}" (${s.n} approved)`
    );
    added++;
  }
  plan.note(
    `Academics repointed at ${lessonSeries.length} Lessons series (${added} newly added, ${lessonSeries.length - added} already present)`
  );
  if (!lessonSeries.length) {
    console.error(
      'REFUSING: no Lessons series has approved content. Run 03-lessons.js and 06-validate-approve.js first.'
    );
    process.exit(1);
  }
}

// --- 2. Thursday / TheBluePlanetBBC ----------------------------------------

const dead = one(
  `SELECT bts.id, bts.subject, bt.name AS template
     FROM BlockTemplateSeries bts
     JOIN BlockTemplate bt ON bt.id = bts.template_id
    WHERE bts.subject = 'TheBluePlanetBBC'`
);
if (dead) {
  const replacement = one(
    "SELECT id FROM BlockTemplateSeries WHERE template_id = (SELECT template_id FROM BlockTemplateSeries WHERE id = ?) AND subject = 'The Blue Planet'",
    dead.id
  );
  if (!replacement) {
    plan.note(
      `NOT deleting "${dead.subject}" from template "${dead.template}": "The Blue Planet" is not on that template, so the slot would lose its content. Needs an operator decision.`
    );
  } else {
    plan.op(
      'DELETE FROM BlockTemplateSeries WHERE id = ?',
      [dead.id],
      `${dead.template}: drop dead row -> "TheBluePlanetBBC" (0 resources; "The Blue Planet" already on this template)`
    );
  }
} else {
  plan.note('no "TheBluePlanetBBC" template row found — already cleaned');
}

// --- 3. Report any other template row with no playable content --------------
// Report-only: repointing these is a programming decision, not a data repair.

const broken = q(`
  SELECT bt.name AS template, bts.subject,
         (SELECT COUNT(*) FROM Resource r
           WHERE r.subject = bts.subject AND r.is_filler = 0 AND r.approved = 1) AS approved_clips
    FROM BlockTemplateSeries bts
    JOIN BlockTemplate bt ON bt.id = bts.template_id
   ORDER BY bt.name, bts.play_order
`).filter((r) => r.approved_clips === 0 && r.subject !== 'Discover Academic' && r.subject !== 'TheBluePlanetBBC');

if (broken.length) {
  console.log('\ntemplate rows with ZERO approved clips (would produce empty slots):');
  for (const b of broken) {
    console.log(`  - ${b.template} -> "${b.subject}"`);
    plan.note({ emptyTemplateSeries: b.template, subject: b.subject });
  }
} else {
  console.log('\nno other template row is empty.');
}

plan.commit();

if (APPLY) {
  const remaining = one(`
    SELECT COUNT(*) AS n
      FROM BlockTemplateSeries bts
     WHERE NOT EXISTS (SELECT 1 FROM Resource r
                        WHERE r.subject = bts.subject AND r.is_filler = 0 AND r.approved = 1)
  `).n;
  console.log('\n--- post-apply verification ---');
  console.log('  template rows still pointing at zero approved clips: ' + remaining);
}
