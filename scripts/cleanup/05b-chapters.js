#!/usr/bin/env node
// Phase 5b of the catalog cleanup — repair `Resource.chapter` inside serial series.
//
// Dry run by default; pass --apply to write. Honours SCHEDULER_DB.
//
//   node scripts/cleanup/05b-chapters.js            # report only
//   node scripts/cleanup/05b-chapters.js --apply    # commit
//
// WHY: `chapter` is the scheduler's only ordering key. A serial series advances by
// `chapter = last_played + 1` (src/services/scheduling.js:139, src/services/
// playHistory.js:32), so a row with chapter = 0 is unreachable and two rows sharing
// a chapter make the series stall (the engine can only ever pick one of them).
//
// ROOT CAUSE: parseEpisode()'s last-resort fallback (src/services/episodeParse.js:41)
// takes the LAST standalone integer in the name. That grabs:
//   - the "1" from "(Part_1)" instead of the explicit E49   → Daniel Tiger
//   - the "11" from "Top_11_Countdown" instead of the 65    → Bill Nye
//   - nothing at all where the name has no number           → Peep (chapter 0)
// and letter-suffixed episodes ("S04E96c" / "S04E96d") legitimately parse to the
// same number → Blue's Clues.
//
// WHAT THIS DOES, per broken series:
//   1. Re-derives {season, episode} with a stricter preference order than the
//      ingestion parser (explicit SxxEyy / NxNN → explicit E##/Ep##/Episode ## →
//      first integer token after the series' shared name prefix → parseEpisode as
//      the last resort) and recomputes chapter via encodeChapter(), preserving the
//      existing season*1000+episode convention untouched.
//   2. Breaks the remaining ties (letter-suffixed episodes, junk numbers) by
//      walking the rows in (derived chapter, name) order and pushing each one to
//      the next free integer — the same "re-deal the chapter values in the new
//      order" idea as `set-positions` in src/routes/catalog.js:227. Broadcast order
//      is preserved; an episode may land on the next integer up.
//   3. Falls back to a straight 1..N alphabetical renumber when the names carry no
//      usable numbering at all (every row, or most rows, derive to 0 — Peep, Forts
//      and Monuments). That order is a GUESS and is reported as such.
//
// SCOPE / non-overlap with the other phases: any series whose non-filler rows
// already form a clean ordering (no zeros, no duplicates) is skipped untouched, so
// the series that 02-split-series.js / 03-lessons.js already renumbered are left
// alone and a second run of this script plans nothing. Movies (show_type_id 1) are
// skipped on purpose — 04-hygiene.js zeroes their chapter and the random-with-
// cooldown rule never reads it. Fillers are out of scope. Nothing is quarantined
// here; 06-validate-approve.js owns approval.

import { APPLY, q, one, planner, renumber } from './lib.js';
import { parseEpisode, encodeChapter } from '../../src/services/episodeParse.js';

const CHANNEL_ID = 1; // the only channel
const ST_MOVIES = 1;

// A derived episode of 0 for more than this share of a series means the filenames
// simply don't carry episode numbers — number them by name instead of shuffling
// a couple of accidental integers to the front.
const ALPHA_FALLBACK_SHARE = 0.5;

const plan = planner('05b-chapters');

// --- Re-derivation ----------------------------------------------------------

// Presence tests for the two markers parseEpisode() handles well. We only ask
// "did the name use this style?" and then take parseEpisode()'s numbers — the
// parsing itself is not duplicated here.
const RE_SXXEYY = /[Ss]\d{1,3}[\s._-]*[Ee]\d{1,4}/;
const RE_NXNN = /(?<![A-Za-z0-9])\d{1,2}\s*[xX]\s*\d{1,3}(?![A-Za-z0-9])/;
// "S2Ep1" / "S3 Episode 4" — an explicit season+episode pair that parseEpisode
// misses (its SxxEyy branch needs digits immediately after the E, so "Ep1" fails
// and the season is silently dropped, colliding every season's Ep1).
const RE_S_EP = /(?<![A-Za-z0-9])[Ss](\d{1,2})[\s._-]*(?:[Ee]pisode|[Ee]p)[\s._-]*(\d{1,4})/;
// An explicit episode token: E49, Ep7, Episode 12. Bare lowercase "e12" is NOT
// accepted (too many false positives inside words); Ep/Episode are.
const RE_EPISODE_TOKEN = /(?<![A-Za-z0-9])(?:[Ee]pisode|[Ee]p|E)[\s._-]*(\d{1,4})/;

const tokens = (name) => String(name || '').split(/[_\s.\-]+/).filter(Boolean);

/**
 * The name with its first `prefixLen` tokens (and the separators around them)
 * removed. Works on the raw string rather than the token list so a fractional
 * index ("113.5", "3.5") survives — token splitting eats the dot.
 */
function stripPrefix(name, prefixLen) {
  const s = String(name || '');
  let pos = 0;
  for (let i = 0; i < prefixLen; i++) {
    while (pos < s.length && /[_\s.\-]/.test(s[pos])) pos++;
    while (pos < s.length && !/[_\s.\-]/.test(s[pos])) pos++;
  }
  return s.slice(pos);
}

/**
 * Longest run of leading tokens shared by every name in the series, e.g.
 * ["bill","nye","the","science","guy"]. Stripping it is what lets us take the
 * FIRST integer of what remains (the episode index) instead of the last integer
 * of the whole name (a number out of the episode title).
 */
function sharedPrefixLength(names) {
  if (names.length < 2) return 0;
  const lists = names.map((n) => tokens(n).map((t) => t.toLowerCase()));
  const shortest = Math.min(...lists.map((l) => l.length));
  let i = 0;
  while (i < shortest && lists.every((l) => l[i] === lists[0][i])) i++;
  // Never consume the whole name — something has to be left to look at.
  return Math.min(i, shortest - 1 < 0 ? 0 : shortest - 1);
}

/**
 * { season, episode, source } for one row. Strict preference order; parseEpisode
 * is consulted last so its "last integer in the name" fallback can no longer
 * outvote an explicit marker.
 *
 * A season is only ever taken from a marker that PAIRS it with the episode
 * (S01E02, 3x04, S2Ep1). A loose "S5" elsewhere in the name is not trusted — in
 * this catalog those belong to a second title inside the filename
 * ("Mythbusters_115_Pykrete Peril_S5_Snowplow Split"), not to a season.
 */
function derive(name, prefixLen) {
  const base = String(name || '');

  // (a) explicit SxxEyy / NxNN — parseEpisode already reads these correctly.
  if (RE_SXXEYY.test(base) || RE_NXNN.test(base)) {
    const p = parseEpisode(base);
    return { season: p.season, episode: p.episode, source: 'sxxeyy' };
  }

  // (a2) "S2Ep1" — same intent as SxxEyy, but parseEpisode loses the season.
  let m;
  if ((m = base.match(RE_S_EP))) {
    return { season: Number(m[1]), episode: Number(m[2]), source: 's-ep' };
  }

  // (b) a bare explicit episode token (E49 / Ep7 / Episode 12).
  if ((m = base.match(RE_EPISODE_TOKEN))) {
    return { season: null, episode: Number(m[1]), source: 'episode-token' };
  }

  // (c) the first standalone integer AFTER the series' shared name prefix. A
  //     fractional index ("113.5", "3.5_CPCE_...") keeps its fraction as a sort
  //     hint so the half-episode lands right after its whole one.
  const rest = stripPrefix(base, prefixLen);
  if ((m = rest.match(/(?<![A-Za-z0-9])(\d{1,4})(?:\.(\d{1,2}))?(?![\d])/))) {
    return {
      season: null,
      episode: Number(m[1]),
      frac: m[2] ? Number(`0.${m[2]}`) : 0,
      source: 'index-token',
    };
  }

  // (d) last resort: whatever the ingestion parser makes of it.
  const p = parseEpisode(base);
  return { season: p.season, episode: p.episode, source: 'parseEpisode' };
}

// --- Per-series repair ------------------------------------------------------

function chapterStats(rows, key = 'chapter') {
  const counts = new Map();
  let zeros = 0;
  for (const r of rows) {
    const c = r[key];
    if (!c) zeros++;
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  let dupExtra = 0;
  for (const n of counts.values()) if (n > 1) dupExtra += n - 1;
  return { zeros, dupExtra, broken: zeros > 0 || dupExtra > 0 };
}

const summary = {
  seriesSeen: 0,
  skippedClean: 0,
  skippedEmpty: 0,
  skippedMovies: 0,
  repaired: 0,
  alphabetical: [],
  left: [],
};

function repairSeries(series) {
  const all = q(
    `SELECT id, name, chapter, season, show_type_id FROM Resource
      WHERE channel_id = ? AND subject = ? AND is_filler = 0
      ORDER BY name ASC, id ASC`,
    CHANNEL_ID,
    series.subject
  );

  // Movies rows never use chapter (04-hygiene.js zeroes them on purpose), so they
  // must not count as "broken" nor be renumbered back to non-zero here.
  const movieRows = all.filter((r) => r.show_type_id === ST_MOVIES);
  const rows = all.filter((r) => r.show_type_id !== ST_MOVIES);

  if (!rows.length) {
    if (movieRows.length) {
      summary.skippedMovies++;
      plan.note(
        `skip "${series.subject}": ${movieRows.length} row(s), all show_type = Movies — chapter is unused there`
      );
    } else {
      summary.skippedEmpty++;
    }
    return;
  }
  if (movieRows.length) {
    plan.note(
      `"${series.subject}": ${movieRows.length} Movies row(s) excluded from the numbering (chapter unused for Movies)`
    );
  }

  const before = chapterStats(rows);
  if (!before.broken) {
    summary.skippedClean++;
    return;
  }

  // --- step 1: re-derive -----------------------------------------------------
  const prefixLen = sharedPrefixLength(rows.map((r) => r.name));
  const derived = rows.map((r) => {
    const d = derive(r.name, prefixLen);
    // seasonDb keeps the stored column (d.season is the freshly derived one).
    return { ...r, ...d, seasonDb: r.season, want: encodeChapter(d.season, d.episode) };
  });

  const rederived = derived.filter((r) => r.want !== r.chapter).length;
  const bySource = derived.reduce((acc, r) => {
    acc[r.source] = (acc[r.source] || 0) + 1;
    return acc;
  }, {});
  const zeroDerived = derived.filter((r) => !r.want).length;

  // season is only ever filled IN, never rewritten, and only from a marker that
  // pairs season with episode (see derive()).
  let seasonFilled = 0;
  for (const r of derived) {
    if (r.seasonDb == null && r.season != null && (r.source === 'sxxeyy' || r.source === 's-ep')) {
      plan.op('UPDATE Resource SET season = ? WHERE id = ?', [r.season, r.id], null);
      seasonFilled++;
    }
  }

  // --- step 3 (checked before 2): no usable numbering at all -----------------
  if (zeroDerived >= Math.max(1, Math.ceil(rows.length * ALPHA_FALLBACK_SHARE))) {
    // Pass the rows explicitly: a dry run has none of our staged changes in the
    // DB, and renumber() would otherwise re-read the untouched table.
    renumber(plan, CHANNEL_ID, series.subject, 'name', rows);
    summary.repaired++;
    summary.alphabetical.push(series.subject);
    plan.note(
      `repair "${series.subject}": ${rows.length} rows, ${zeroDerived} with NO episode number in the filename ` +
        `→ ALPHABETICAL 1..${rows.length} (order is a guess — operator should eyeball it). ` +
        `was: ${before.zeros} zero(s), ${before.dupExtra} duplicate row(s)`
    );
    if (seasonFilled) plan.note(`"${series.subject}": ${seasonFilled} season column(s) filled from an explicit S## token`);
    return;
  }

  // --- step 2: deal out the ties in name order -------------------------------
  // Walk in (derived chapter, name) order and keep the sequence strictly
  // increasing: a row keeps its derived number when that number is still free,
  // otherwise it takes the next free integer. Deterministic, preserves broadcast
  // order, and leaves no zero and no collision behind.
  const ordered = [...derived].sort(
    (a, b) =>
      a.want + (a.frac || 0) - (b.want + (b.frac || 0)) ||
      a.name.localeCompare(b.name) ||
      a.id - b.id
  );
  let last = 0;
  let bumped = 0;
  let changed = 0;
  for (const r of ordered) {
    const next = Math.max(r.want, last + 1);
    if (next !== r.want) bumped++;
    last = next;
    r.final = next;
    if (next !== r.chapter) {
      plan.op('UPDATE Resource SET chapter = ? WHERE id = ?', [next, r.id], null);
      changed++;
    }
  }

  if (changed) {
    // The stored cursor points at the OLD numbering; leaving it would make the
    // series resume from an arbitrary episode (same reasoning as renumber()).
    const cur = one(
      'SELECT id, cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?',
      CHANNEL_ID,
      series.subject
    );
    if (cur && cur.cursor_chapter != null) {
      plan.op(
        'UPDATE ChannelSeries SET cursor_chapter = NULL WHERE id = ?',
        [cur.id],
        `clear stale cursor on "${series.subject}" (was ${cur.cursor_chapter}, numbering changed)`
      );
    }
  }

  summary.repaired++;
  plan.note(
    `repair "${series.subject}": ${rows.length} rows — was ${before.zeros} zero(s) / ${before.dupExtra} duplicate row(s); ` +
      `re-derived ${rederived} chapter(s) [${Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(' ')}], ` +
      `${bumped} tie(s) pushed to the next free integer, ${changed} row(s) updated`
  );
  if (seasonFilled) {
    plan.note(`"${series.subject}": ${seasonFilled} season column(s) filled from an explicit S## token`);
  }

  // Show a couple of examples so the operator can spot a wrong re-derivation
  // without opening the report JSON.
  const samples = ordered.filter((r) => r.final !== r.chapter).slice(0, 4);
  for (const s of samples) {
    plan.note(`   e.g. "${s.name}": chapter ${s.chapter} → ${s.final} (${s.source})`);
  }

  // When most of the series had to be pushed along, the filenames' own numbers
  // were mostly unusable and the resulting order is really "name order with the
  // numbers as a hint" — say so rather than letting the count imply precision.
  if (bumped > rows.length / 2) {
    plan.note(
      `   ^ "${series.subject}": ${bumped}/${rows.length} rows were re-dealt — the filenames' numbers ` +
        `mostly collide, so the resulting order is largely name order. Worth an operator eyeball.`
    );
  }

  // Two rows that BOTH carry an explicit episode marker for the same episode and
  // yet have different names ("Full_House_S1E01" vs "Fuller_House_S1E01") are not
  // a parsing bug: the subject holds two shows (or two variants of one episode),
  // each numbered from 1. Re-dealing makes the numbering valid but interleaves
  // them, so flag it — splitting the subject (Phase 2) or quarantining the
  // variant (Phase 6) is a human call.
  const EXPLICIT = new Set(['sxxeyy', 's-ep', 'episode-token']);
  const stem = (n) => n.replace(/\d+/g, '#').toLowerCase();
  const groups = new Map();
  for (const r of derived) {
    if (!groups.has(r.want)) groups.set(r.want, []);
    groups.get(r.want).push(r);
  }
  const mixed = [...groups.values()].filter(
    (g) =>
      g.length > 1 &&
      g.every((r) => EXPLICIT.has(r.source)) &&
      new Set(g.map((r) => stem(r.name))).size > 1
  );
  if (mixed.length) {
    const example = mixed[0].map((r) => `"${r.name}"`).join(' vs ');
    plan.note({
      needs_decision: series.subject,
      reason:
        `${mixed.length} collision group(s) where rows with different names carry the SAME explicit ` +
        `episode marker (${example}) — two shows (or two cuts of one episode) sharing this subject's ` +
        `numbering. Chapters were made valid by interleaving them in name order; a subject split ` +
        `(Phase 2) or quarantine of the variant (Phase 6) would be truer.`,
    });
  }

  // Safety net: if this somehow left the series broken, say so instead of
  // pretending it's fixed.
  const after = chapterStats(ordered, 'final');
  if (after.broken) {
    summary.left.push(`${series.subject} (still ${after.zeros} zero(s) / ${after.dupExtra} dup(s) after repair)`);
  }
}

// --- Verification -----------------------------------------------------------

function verify() {
  const series = q(
    `SELECT subject, show_type_id FROM ChannelSeries
      WHERE channel_id = ? AND is_serial = 1 ORDER BY subject`,
    CHANNEL_ID
  ).filter((s) => s.show_type_id !== ST_MOVIES);

  let brokenSeries = 0;
  let zeroRows = 0;
  let dupRows = 0;
  for (const s of series) {
    const rows = q(
      `SELECT chapter FROM Resource
        WHERE channel_id = ? AND subject = ? AND is_filler = 0
          AND (show_type_id IS NULL OR show_type_id != ?)`,
      CHANNEL_ID,
      s.subject,
      ST_MOVIES
    );
    if (!rows.length) continue;
    const st = chapterStats(rows);
    if (st.broken) brokenSeries++;
    zeroRows += st.zeros;
    dupRows += st.dupExtra;
  }

  console.log(`\n=== verification (${APPLY ? 'post-apply' : 'current DB — dry run changed nothing'}) ===`);
  console.log(`  serial series (excl. Movies) with chapter = 0 or duplicate chapters : ${brokenSeries}`);
  console.log(`  rows with chapter = 0                                              : ${zeroRows}`);
  console.log(`  surplus rows sharing a chapter with a sibling                       : ${dupRows}`);
  if (!APPLY) {
    console.log('  ^ these are the PRE-fix counts; re-run with --apply, then again to confirm they drop to 0.');
    console.log(
      `  projected after this plan: ${summary.left.length} broken series` +
        (summary.left.length ? ` — ${summary.left.join('; ')}` : ' (target 0)')
    );
  }
  return { brokenSeries, zeroRows, dupRows };
}

// --- Run --------------------------------------------------------------------

const seriesList = q(
  `SELECT id, subject, show_type_id FROM ChannelSeries
    WHERE channel_id = ? AND is_serial = 1
    ORDER BY subject`,
  CHANNEL_ID
);

for (const s of seriesList) {
  summary.seriesSeen++;
  if (s.show_type_id === ST_MOVIES) {
    summary.skippedMovies++;
    plan.note(`skip "${s.subject}": ChannelSeries show_type = Movies (chapter is unused for movies)`);
    continue;
  }
  repairSeries(s);
}

plan.note(
  `totals: ${summary.seriesSeen} serial series — ${summary.repaired} repaired, ` +
    `${summary.skippedClean} already clean, ${summary.skippedEmpty} with no resources, ` +
    `${summary.skippedMovies} Movies-only`
);
if (summary.alphabetical.length) {
  plan.note(
    `ALPHABETICAL fallback (order is a guess, needs a human eyeball): ${summary.alphabetical.join(', ')}`
  );
}
for (const l of summary.left) plan.note({ needs_decision: null, reason: l });

plan.commit();
verify();
