#!/usr/bin/env node
// Phase 8 — split the flat Movies folder into one series per franchise.
//
// Symptom being repaired: every movie sits in a single on-disk folder, so
// detectSubject() (src/services/ingestion.js) files all of them under one subject
// ("Movies") with chapter 0. The consequences the operator sees are:
//   - the catalog shows one undifferentiated folder — a franchise is invisible,
//   - a block given that folder can only pick at random; there is no ordering, so
//     "Toy Story 3" can air before "Toy Story 1".
//
// The franchise is in the filename ("Toy_Story_3", "HarryPotter5OrderOfPhoenix",
// "Cars2"), but a bare number is ambiguous — "Big_Hero_6" has the same shape as
// "Angry_Birds_2" and is not a sequel. So detection is corpus-level: a franchise
// exists only when two or more titles in the same folder agree on a base name.
// See src/services/movieSaga.js for the rules and test/movieSaga.test.mjs for the
// cases this must NOT group.
//
// What this does, per channel, for every Movies-show-type series:
//   1. moves each detected franchise member to its own subject, chapter = part,
//   2. registers each franchise in ChannelSeries as SERIAL (so it plays in order),
//   3. clears the junk ordinal off standalone films (the generic "last integer in
//      the name" fallback leaves 2019 on "Aladdin_2019", 102 on "102_Dalmatians"),
//
// It deliberately does NOT touch the templates. A movie block with no series named
// already draws on every movie the channel has (each franchise held at the part it
// is due), so a movie night keeps the whole library without naming anything. Adding
// the franchises to it would do the opposite: a named franchise is played in ORDER
// ahead of fit, so a block naming all 52 would just air the first two every night
// and pad the rest with fillers — 23% filler instead of 4% on the real catalogue.
// Name a franchise on a block only when you want that franchise's marathon.
//
// Nothing is deleted and nothing is quarantined: a title this cannot place simply
// stays where it is, and single-member near-misses are listed in the report so the
// operator can merge them by hand in the Catalog Editor.
//
// Dry run by default; pass --apply to write. Honours SCHEDULER_DB.
//
// Usage:
//   node scripts/cleanup/08-movie-sagas.js                         # dry run + report
//   node scripts/cleanup/08-movie-sagas.js --apply                 # commit
//   node scripts/cleanup/08-movie-sagas.js --apply --unlink-sagas   # + undo a previous
//                                                                  #   --link-templates run
import { q, one, planner, flag, ensureSeries, renumber } from './lib.js';
import { groupSagas, titleCandidates, sagaSubjectName } from '../../src/services/movieSaga.js';

const plan = planner('08-movie-sagas');
// An earlier revision of this script had a --link-templates flag that added every
// franchise to the movie templates. That turned out to work against the movie-block
// fill (see the note above), so this undoes it.
const UNLINK_SAGAS = flag('--unlink-sagas');

const MOVIES_SHOW_TYPE = one("SELECT id FROM ShowType WHERE code = 'movies'")?.id ?? 1;

const channels = q('SELECT id, name FROM ChannelType ORDER BY id');
let totalSagas = 0;
let totalMoved = 0;

for (const channel of channels) {
  // Group by the subject the movies currently sit under, so a root that already
  // has franchise subfolders keeps them scoped rather than being re-cut globally.
  const subjects = q(
    `SELECT DISTINCT subject FROM Resource
      WHERE channel_id = ? AND show_type_id = ? AND is_filler = 0 AND subject IS NOT NULL
      ORDER BY subject`,
    channel.id,
    MOVIES_SHOW_TYPE
  ).map((r) => r.subject);

  for (const subject of subjects) {
    const rows = q(
      `SELECT id, name, chapter, season FROM Resource
        WHERE channel_id = ? AND show_type_id = ? AND is_filler = 0 AND subject = ?
        ORDER BY name`,
      channel.id,
      MOVIES_SHOW_TYPE,
      subject
    );
    if (rows.length < 2) continue;

    const { sagas, standalone } = groupSagas(rows.map((r) => ({ id: r.id, name: r.name })));
    const byId = new Map(rows.map((r) => [r.id, r]));

    plan.note(
      `${channel.name} / "${subject}": ${rows.length} title(s) -> ` +
      `${sagas.size} franchise(s) covering ${rows.length - standalone.length}, ` +
      `${standalone.length} standalone`
    );

    // Names already used by another show type on this channel are off limits: the
    // catalogue has "Curious George" as both an 86-episode TV series and a 6-film
    // franchise, and merging them would collide chapters 1..6 inside the TV series.
    const claimed = new Set();
    // The subject each franchise actually ended up under — NOT the raw base, which
    // may have been qualified away from a name another show type already owns.
    // Linking the raw base would point a movie block at that other series.
    const filedAs = [];
    const isTaken = (name) =>
      claimed.has(name) ||
      !!one(
        `SELECT 1 AS x FROM Resource
          WHERE channel_id = ? AND subject = ? AND show_type_id IS NOT ? LIMIT 1`,
        channel.id, name, MOVIES_SHOW_TYPE
      );

    for (const [rawBase, members] of sagas) {
      if (rawBase === subject) {
        plan.note(`  · "${rawBase}" already is the folder subject — leaving it in place`);
        continue;
      }
      const base = sagaSubjectName(rawBase, isTaken);
      claimed.add(base);
      filedAs.push(base);
      if (base !== rawBase) {
        plan.note(`  ! "${rawBase}" is already a series of another show type on this channel — filing the films as "${base}"`);
      }
      totalSagas++;
      ensureSeries(plan, channel.id, base, MOVIES_SHOW_TYPE, true);

      // Parts are the franchise's own numbering (Harry Potter 1..8), which is the
      // ordering to keep. Only fall back to a 1..N renumber when two members claim
      // the same part — a collision would make the engine's "next chapter" pick
      // arbitrarily between them.
      const parts = members.map((m) => m.part);
      const collides = new Set(parts).size !== parts.length;

      for (const m of members) {
        const row = byId.get(m.id);
        const chapter = collides ? members.indexOf(m) + 1 : m.part;
        plan.op(
          'UPDATE Resource SET subject = ?, season = NULL, chapter = ? WHERE id = ?',
          [base, chapter, m.id],
          `move "${row.name}" -> "${base}" part ${chapter}`
        );
        totalMoved++;
      }
      if (collides) {
        plan.note(`  ! "${base}" had duplicate part numbers (${parts.join(',')}) — renumbered 1..${members.length}`);
      }
    }

    // A standalone film has no ordinal to carry; a leftover one is a parse artifact.
    for (const s of standalone) {
      const row = byId.get(s.id);
      if (row.chapter === 0 && row.season == null) continue;
      plan.op(
        'UPDATE Resource SET season = NULL, chapter = 0 WHERE id = ?',
        [s.id],
        `clear ordinal ${row.chapter} off standalone "${row.name}"`
      );
    }

    // Near-misses worth a human look: a title that proposes a base no sibling
    // agreed on. Either a genuinely standalone film, or a franchise whose other
    // parts are named differently (e.g. the Muppets and Octonauts titles, which
    // carry no numbers at all).
    const nearMiss = standalone
      .filter((s) => titleCandidates(s.name).length)
      .map((s) => `${s.name} (reads as "${titleCandidates(s.name)[0].base}" part ${titleCandidates(s.name)[0].part})`);
    if (nearMiss.length) {
      plan.note(`  ? ${nearMiss.length} title(s) look numbered but have no sibling: ${nearMiss.join('; ')}`);
    }

  }
}

// Undo a previous --link-templates run. Standalone, not tied to what this run
// moved, so it also works on a catalogue that was already split: drop from every
// movie-block template the rows naming a FRANCHISE (a movies-show-type subject with
// ordered parts), leaving unordered folders like "Movies" alone. Those blocks then
// draw the whole library by fit again instead of marching the first two franchises.
if (UNLINK_SAGAS) {
  const linked = q(`
    SELECT bts.id, bts.subject, bt.name
      FROM BlockTemplateSeries bts
      JOIN BlockTemplate bt ON bt.id = bts.template_id
     WHERE bt.is_movie_block = 1
       AND EXISTS (
             SELECT 1 FROM Resource r
              JOIN ShowType st ON st.id = r.show_type_id
             WHERE r.subject = bts.subject AND st.code = 'movies'
               AND r.is_filler = 0 AND r.chapter > 0)
  `);
  const byTemplate = new Map();
  for (const r of linked) {
    plan.op('DELETE FROM BlockTemplateSeries WHERE id = ?', [r.id], null);
    byTemplate.set(r.name, (byTemplate.get(r.name) || 0) + 1);
  }
  for (const [name, n] of byTemplate) {
    plan.note(`- template "${name}": removed ${n} franchise row(s); it draws the whole library by fit again`);
  }
  if (!linked.length) plan.note('- no franchise rows on any movie-block template — nothing to unlink');
}

plan.note(`TOTAL: ${totalSagas} franchise(s), ${totalMoved} title(s) moved`);
plan.note(
  'next: tick "Movie block" on the movie templates and leave their series list EMPTY — ' +
  'a movie block with no series named draws on every movie, holding each franchise at the part ' +
  'it is due. Name a franchise on a block only for that franchise\'s marathon.'
);
plan.commit();
