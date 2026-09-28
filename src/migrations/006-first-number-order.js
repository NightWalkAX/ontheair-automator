// Re-order the episodes the old parser numbered by the LAST number in the name.
//
// With no explicit marker (S02E05, Ep 4…), parseEpisode() used to take the last
// number of a filename as its episode. On a name that carries several, that is
// the wrong one: "Math_Intervention_Program_020_Consumer_Arithmetic_MCQ_Part_1"
// was filed as 1 (so the 137 lessons of that programme sorted by "Part N",
// dozens of them sharing a chapter), "Octonauts_100_Tree_Lobsters_101_Convict_
// Fish" as 101, "Human_The_World_Within_03_D11" as 11. The parser now takes the
// first number the show's own name does not carry; this repairs the chapters it
// already wrote.
//
// One (channel, show, season) at a time, and three cases:
//   - still exactly what the old rule wrote: each clip takes the chapter the
//     scanner writes now (encodeChapter(season, first number));
//   - renumbered since — the cleanup scripts sorted several shows by NAME, so
//     "Octonauts_09" is followed by "Octonauts_100" and episodes 10-99 come after
//     it — in a season numbered by design (at least NUMBERED_SHARE of its clips
//     state a number of their own): the chapter values its numbered clips hold
//     are re-dealt among them in first-number order. An unnumbered clip in there
//     ("Octonauts_Special_…") keeps its slot, nothing outside the season moves,
//     and nothing can collide;
//   - a season mostly without numbers (the "Grade 5 Mathematics" lessons, "Peep
//     and the Big Wide World"): its order was chosen some other way and cannot
//     come from the names, so it is left alone.
// Movies are out of scope (a franchise part's chapter is its part, set by the
// saga grouping), and so are fillers.
//
// A series' cursor (the next episode due) is carried along: if it pointed at a
// clip whose chapter moves, it follows the clip.

import { db } from '../db.js';
import { encodeChapter, legacyParseEpisode, parseEpisode, statedEpisode } from '../services/episodeParse.js';

export const id = '006-first-number-order';
export const description = 're-order episodes the old parser numbered by the last number in their name';

/** Share of a renumbered season's clips that must state a number to re-order it. */
const NUMBERED_SHARE = 0.8;

/**
 * The episode number a clip's name states for itself, or null: an explicit
 * marker, else its first number that is not the show's own (the grade in "Grade
 * 5 Science"), not a part ("Bearings Part 1" is part 1 of a lesson, not episode
 * 1 of the programme, and neither is the "(2)" of "Solving Linear Equations (2)")
 * and not zero.
 */
function ownNumber(r) {
  const base = String(r.name);
  const stated = statedEpisode(base, r.subject);
  if (stated != null) return stated;
  const own = new Set((String(r.subject || '').match(/\d+/g) || []).map(Number));
  for (const m of base.matchAll(/\d{1,4}/g)) {
    const n = Number(m[0]);
    if (!n || own.has(n)) continue;
    if (/(?:part|pt|p)[\s._#-]*$/i.test(base.slice(0, m.index))) continue;
    // "Solving Linear Equations (2)": a second part or a second copy.
    if (base[m.index - 1] === '(' && base[m.index + m[0].length] === ')') continue;
    return n;
  }
  return null;
}

/** Order clips by their own number, then what used to decide (a part), then name. */
const byFirstNumber = (a, b) =>
  ownNumber(a) - ownNumber(b)
  || legacyParseEpisode(a.name).episode - legacyParseEpisode(b.name).episode
  || a.name.localeCompare(b.name, undefined, { numeric: true })
  || a.id - b.id;

export function plan() {
  const rows = db.prepare(`
    SELECT r.id, r.channel_id, r.subject, r.season, r.chapter, r.name
    FROM Resource r
    LEFT JOIN ShowType st ON st.id = r.show_type_id
    WHERE r.is_filler = 0 AND r.subject IS NOT NULL AND COALESCE(st.code, '') != 'movies'
    ORDER BY r.channel_id, r.subject, r.season, r.chapter, r.id
  `).all();

  const groups = new Map();
  for (const r of rows) {
    const k = `${r.channel_id}\u0000${r.subject}\u0000${r.season ?? ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  const cursorOf = db.prepare('SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?');
  const ops = [];
  const summary = [];
  const cursorMoves = new Map(); // "channel\0subject" -> { old, new }
  let skipped = 0;

  for (const group of groups.values()) {
    const { channel_id: ch, subject, season } = group[0];
    const where = `channel ${ch}: ${subject}${season != null ? ` season ${season}` : ''}`;
    const current = [...group].sort((a, b) => a.chapter - b.chapter || a.id - b.id);
    const untouched = group.every((r) => r.chapter === encodeChapter(r.season, legacyParseEpisode(r.name).episode));

    let moves;
    if (untouched) {
      moves = group
        .map((r) => ({ r, old: r.chapter, next: encodeChapter(r.season, parseEpisode(r.name, r.subject).episode) }))
        .filter((m) => m.next !== m.old);
    } else {
      const numbered = current.filter((r) => ownNumber(r) != null);
      if (numbered.length < 2) continue;
      if (numbered.length < group.length * NUMBERED_SHARE) {
        const inOrder = [...numbered].sort(byFirstNumber).every((r, i) => r === numbered[i]);
        if (!inOrder) skipped++;
        continue;
      }
      // Re-deal the chapters the numbered clips hold, lowest to the first episode.
      const values = numbered.map((r) => r.chapter);
      moves = [...numbered].sort(byFirstNumber)
        .map((r, i) => ({ r, old: r.chapter, next: values[i] }))
        .filter((m) => m.next !== m.old);
    }
    if (!moves.length) continue;

    for (const m of moves) {
      ops.push({ sql: 'UPDATE Resource SET chapter = ? WHERE id = ?', params: [m.next, m.r.id] });
    }
    const cursor = cursorOf.get(ch, subject)?.cursor_chapter;
    const hit = moves.filter((m) => m.old === cursor).sort((a, b) => a.next - b.next)[0];
    if (cursor != null && hit) cursorMoves.set(`${ch}\u0000${subject}`, { ch, subject, next: hit.next });
    const e = moves.find((m) => ownNumber(m.r) != null) ?? moves[0];
    summary.push(`${where}: ${moves.length} of ${group.length} clip(s) re-ordered by their first number`
      + ` — e.g. "${e.r.name}" ${e.old} → ${e.next}`);
  }

  for (const c of cursorMoves.values()) {
    ops.push({
      sql: 'UPDATE ChannelSeries SET cursor_chapter = ? WHERE channel_id = ? AND subject = ?',
      params: [c.next, c.ch, c.subject],
    });
    summary.push(`channel ${c.ch}: ${c.subject} — next episode due follows its clip to chapter ${c.next}`);
  }
  if (skipped) {
    summary.push(`${skipped} season(s) out of number order but mostly without numbers in their names`
      + ' were left as they are — order those in the Catalog Editor');
  }
  return { ops, summary };
}
