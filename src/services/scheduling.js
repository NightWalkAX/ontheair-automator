// Module A — the auto-generation engine.
//
// Turns active BlockTemplates into draft ScheduledBlocks for the coming week
// (across every weekday the template runs and every time slot it airs at),
// populates each primary airing by cycling its assigned series chapter-by-chapter
// and packing fillers to hit the slot's exact duration, then strict-mirrors that
// content into the template's secondary airings.

import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { nextChapter, randomWithCooldown, cooldownEligible, latestEpisode } from './playHistory.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// --- Fit tolerance (shared truth for the engine, the API and the UI) ---------
// A block's `diff` is blockSeconds - totalSeconds: positive = underrun (dead
// air at the end), negative = overrun (the block runs past its slot).
//
// Exact (diff 0) is still the target. Underrun is acceptable up to
// maxUnderrunSeconds. When the filler pool is too coarse to land inside that
// window, a SMALL OVERRUN is preferred over a bigger hole — so the fill goes
// over the block end instead, bounded by maxOverrunSeconds.

/** { maxUnderrun, maxOverrun } in seconds, from config.filler. */
export function fitTolerance() {
  const f = loadConfig().filler || {};
  return {
    maxUnderrun: f.maxUnderrunSeconds ?? 5,
    maxOverrun: f.maxOverrunSeconds ?? 5,
  };
}

/** Is a blockSeconds-totalSeconds difference inside the fit tolerance? */
export function fitsTolerance(diff, tol = fitTolerance()) {
  return diff <= tol.maxUnderrun && diff >= -tol.maxOverrun;
}

/** Block length in seconds from 'HH:MM' start/end (handles past-midnight). */
export function blockDurationSeconds(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let secs = (eh * 3600 + em * 60) - (sh * 3600 + sm * 60);
  if (secs <= 0) secs += 24 * 3600; // wraps past midnight
  return secs;
}

/** 'YYYY-MM-DD' for `daysAhead` days after a base date (default today). */
function dateStr(daysAhead, base = new Date()) {
  const d = new Date(base);
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

// --- Template shape helpers -------------------------------------------------

/** The weekdays a template runs on (multi-weekday CSV, legacy single fallback). */
export function templateWeekdays(t) {
  return String(t.weekdays || t.weekday || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The template's time slots (airings), ordered primary-first. Synthesizes a
 * single primary slot from the legacy start_time/end_time columns if the
 * template has no BlockTemplateSlot rows yet.
 */
export function templateSlots(template) {
  const rows = db.prepare(
    'SELECT * FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order, start_time'
  ).all(template.id);
  if (rows.length) return rows;
  return [{ id: null, template_id: template.id, start_time: template.start_time, end_time: template.end_time, slot_order: 0 }];
}

/**
 * The ordered series a block draws from, each tagged with its scheduling rule.
 * Reads BlockTemplateSeries (subset + order) joined to the channel registry.
 * Falls back to the legacy single target_subject / content_type when a template
 * has no series assigned, so pre-existing templates keep working.
 */
export function templateSeries(template, channelId = template.channel_id) {
  const rows = db.prepare(`
    SELECT bts.subject,
           COALESCE(cs.is_serial, 0) AS is_serial,
           COALESCE(cs.is_active, 1) AS is_active,
           st.code AS show_code
    FROM BlockTemplateSeries bts
    LEFT JOIN ChannelSeries cs ON cs.channel_id = ? AND cs.subject = bts.subject
    LEFT JOIN ShowType st ON st.id = cs.show_type_id
    WHERE bts.template_id = ?
    ORDER BY bts.play_order
  `).all(channelId, template.id);

  const active = rows.filter((r) => r.is_active);
  if (active.length) return active.map((r) => ({ subject: r.subject, rule: ruleFor(r.show_code, r.is_serial) }));

  // Legacy fallback: derive a single series from the old columns.
  if (template.target_subject) {
    const legacy = {
      lesson_series: { show_code: 'lessons', is_serial: 1 },
      tv_episode: { show_code: 'tv_shows', is_serial: 1 },
      movie: { show_code: 'movies', is_serial: 0 },
    }[template.content_type] || { show_code: 'movies', is_serial: 0 };
    return [{ subject: template.target_subject, rule: ruleFor(legacy.show_code, legacy.is_serial) }];
  }
  return [];
}

/** Scheduling rule for a series from its show type + serial flag. */
function ruleFor(showCode, isSerial) {
  // The explicit "serial" toggle wins over everything: a show marked serial
  // plays in strict chapter order from its cursor, honouring resets. This is
  // why a TV series set serial no longer gets stuck on latest-added/cooldown.
  if (isSerial) return 'serial';              // sequential chapter progression
  if (showCode === 'tv_shows') return 'tv';   // TV default: Sunday latest / weekday cooldown
  return 'cooldown';                          // random movie/documentary pick
}

/**
 * Non-filler candidate resources for a block's channel, optionally by subject
 * and capped at maxDuration so a single main item can never overrun the slot.
 */
function candidates(channelId, subject, maxDuration) {
  const clauses = ['channel_id = ?', 'is_filler = 0', 'approved = 1'];
  const params = [channelId];
  if (subject) { clauses.push('subject = ?'); params.push(subject); }
  if (maxDuration) { clauses.push('duration <= ?'); params.push(maxDuration); }
  return db.prepare(`SELECT * FROM Resource WHERE ${clauses.join(' AND ')}`).all(...params);
}

// --- Per-series content iterators -------------------------------------------
// Each returns { peek(): Resource|null, consume(): void }. `peek` shows the next
// candidate without committing; `consume` advances past it once it's placed.

function serialIterator(channelId, subject, block) {
  const chapters = db.prepare(
    'SELECT * FROM Resource WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND approved = 1 ORDER BY chapter ASC, id ASC'
  ).all(channelId, subject);
  if (!chapters.length) return { peek: () => null, consume: () => {} };

  const target = nextChapter(channelId, subject, block.target_date);
  let idx = chapters.findIndex((c) => c.chapter >= target);
  if (idx < 0) idx = 0; // past the last chapter → wrap to the start (loop the series)
  let steps = 0;
  return {
    peek: () => (steps >= chapters.length ? null : chapters[idx % chapters.length]),
    consume: () => { idx++; steps++; },
  };
}

/** Single-pick iterator: yields one resource then is exhausted. */
function singleIterator(resource) {
  let used = false;
  return {
    peek: () => (used || !resource ? null : resource),
    consume: () => { used = true; },
  };
}

/** Sequence iterator: yields a pre-chosen list of resources in order. */
function sequenceIterator(list) {
  let i = 0;
  return { peek: () => list[i] ?? null, consume: () => { i++; } };
}

// --- Movie blocks -----------------------------------------------------------
// A block flagged `is_movie_block` does NOT cycle its series one pick at a time
// (which yielded a single feature per slot, leaving hours to be papered over with
// fillers). Instead it treats every movie the block's series expose as one pool
// and searches that pool for the combination of up to `movie_limit` titles that
// fills the slot best, so the leftover the fillers have to cover is as small as
// the catalog allows.

/** Max movies a movie block may hold: template override, else config default. */
export function movieLimit(template) {
  const n = Number(template?.movie_limit);
  if (n > 0) return Math.floor(n);
  const cfg = Number(loadConfig().movies?.maxPerBlock);
  return cfg > 0 ? Math.floor(cfg) : 2;
}

/** Is this template a movie block? */
export function isMovieBlock(template) {
  return Number(template?.is_movie_block) === 1;
}

/**
 * The eligible movie pool for a block: every non-filler, approved resource in
 * scope, capped at the slot length, minus
 *   - titles still inside their cooldown window (PlayHistory), and
 *   - titles already scheduled within 6 days either side of this block's date,
 *     which is what keeps a week from airing the same film twice.
 * Falls back a level at a time rather than returning nothing, so a small or
 * fully-cooled catalog still produces a block.
 *
 * `subjects` sets the scope: omit it for the block's own series, pass a list to
 * narrow it, or pass null for EVERY movie on the channel — which is what a movie
 * block with no series assigned means ("just fill it with movies"). An empty list
 * means an empty pool: the operator named series and none of them feed this pass.
 */
export function moviePool(template, block, blockSecs, channelId, subjects = undefined) {
  const scope = subjects === undefined
    ? templateSeries(template, channelId).map((s) => s.subject)
    : subjects;
  let all;
  if (scope === null) {
    all = db.prepare(`
      SELECT r.* FROM Resource r
      JOIN ShowType st ON st.id = r.show_type_id
      WHERE r.channel_id = ? AND r.is_filler = 0 AND r.approved = 1 AND r.duration <= ?
        AND st.code = 'movies'
    `).all(channelId, blockSecs);
  } else {
    if (!scope.length) return [];
    const marks = scope.map(() => '?').join(',');
    all = db.prepare(`
      SELECT * FROM Resource
      WHERE channel_id = ? AND is_filler = 0 AND approved = 1 AND duration <= ?
        AND subject IN (${marks})
    `).all(channelId, blockSecs, ...scope);
  }
  if (!all.length) return [];

  // Already scheduled in the surrounding week (any block but this one).
  const nearby = new Set(db.prepare(`
    SELECT DISTINCT si.resource_id AS id
    FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    WHERE sb.id != ?
      AND sb.target_date BETWEEN date(?, '-6 days') AND date(?, '+6 days')
  `).all(block.id, block.target_date, block.target_date).map((r) => r.id));

  const cooled = cooldownEligible(channelId, all, block.target_date);
  const unaired = all.filter((r) => !nearby.has(r.id));
  const fresh = cooled.filter((r) => !nearby.has(r.id));
  if (fresh.length) return fresh;
  if (cooled.length) return cooled;    // the whole catalogue already aired this week
  if (unaired.length) return unaired;  // everything is still cooling down
  return all;                          // both, on a catalogue this small
}

/**
 * Pick the best-fitting ordered run of up to `limit` movies from `pool`.
 *
 * Scoring mirrors how buildAlignedBlock will actually lay them out: every item
 * starts on the next quarter-hour mark, so the span a run consumes depends on
 * its order as well as its durations. The search is a depth-first walk over runs
 * (longest titles first, so strong fits surface early), bounded by a node cap and
 * short-circuited on an exact fill. Returns the run with the smallest leftover.
 *
 * Two titles from the same franchise may share a block, but only in ascending part
 * order — a double bill of "Toy Story 1" then "Toy Story 2" is fine, the reverse
 * is not. (Franchises exist as their own subjects since movie sagas are split out;
 * see services/movieSaga.js.) Standalone films carry chapter 0, i.e. no ordinal, so
 * the constraint does not apply between them.
 */
export function chooseMovies(pool, startSecs, blockSecs, limit) {
  if (!pool.length || limit <= 0) return [];
  const cands = pool.slice().sort((a, b) => b.duration - a.duration || a.id - b.id);
  const NODE_CAP = 200_000;
  let nodes = 0;
  let best = { items: [], leftover: blockSecs };

  const walk = (chosen, pos) => {
    if (chosen.length) {
      const leftover = blockSecs - (pos - startSecs);
      if (leftover < best.leftover) best = { items: chosen.slice(), leftover };
      if (best.leftover === 0 || chosen.length >= limit) return;
    }
    for (const r of cands) {
      if (nodes++ > NODE_CAP) return;
      if (chosen.includes(r)) continue;
      // Same franchise already in the block? Only continue it forwards. Chapter 0
      // means "no ordinal" (every standalone film in the flat Movies folder), so
      // it carries no order to respect and two of them may share a block freely.
      if (r.subject != null && Number(r.chapter) > 0 && chosen.some(
        (c) => c.subject === r.subject && Number(c.chapter) > 0 && Number(c.chapter) >= Number(r.chapter)
      )) continue;
      const end = Math.ceil(pos / QUARTER_SECS) * QUARTER_SECS + r.duration;
      if (end - startSecs > blockSecs) continue; // would run past the slot
      chosen.push(r);
      walk(chosen, end);
      chosen.pop();
      if (best.leftover === 0) return;
    }
  };
  walk([], startSecs);
  return best.items;
}

/**
 * The ordered features a movie block airs.
 *
 * A movie block is not "pick whatever fits" for every series it holds. A SERIAL
 * series is a franchise, and a franchise has an order: it contributes its NEXT
 * part, from the series cursor, exactly as it would in a normal block. Choosing
 * its part by best fit instead — which is what this used to do — meant a block
 * assigned "Harry Potter" aired part 2 one night and part 5 the next.
 *
 * Whatever slots are left over (up to movie_limit in total) are filled by
 * best-fit from the standalone pool, which is what keeps a long slot from
 * becoming mostly filler.
 *
 * Scope of that standalone pool:
 *   - series assigned  -> the non-serial ones among them,
 *   - nothing assigned -> every movie on the channel. A movie block with no
 *     series named means "fill it with movies", so it draws on the whole
 *     library rather than coming back empty.
 */
export function pickMovieRun(template, block, blockSecs, startSecs, channelId) {
  const limit = movieLimit(template);
  if (limit <= 0) return [];
  const series = templateSeries(template, channelId);

  const items = [];
  const used = new Set();
  let pos = startSecs; // running clock, so fit is measured the way the block lays out
  const endIfPlaced = (r) => Math.ceil(pos / QUARTER_SECS) * QUARTER_SECS + r.duration;
  const fits = (r) => endIfPlaced(r) - startSecs <= blockSecs;
  const place = (r) => { pos = endIfPlaced(r); items.push(r); used.add(r.id); };

  // 1. Franchises, in the template's series order, each at its next part.
  //
  // A franchise may double-bill (parts 1 and 2 the same night) only when it is the
  // block's only source. With a standalone folder also assigned, each franchise
  // takes one slot per block so the other series still gets one — the same
  // one-pick-per-series-per-round cycling a normal block uses.
  const hasStandalone = series.some((sr) => sr.rule !== 'serial');
  const maxPerFranchise = hasStandalone ? 1 : limit;
  const serials = series
    .filter((sr) => sr.rule === 'serial')
    .map((sr) => ({ it: serialIterator(channelId, sr.subject, block), count: 0 }));
  let progressed = true;
  while (progressed && items.length < limit) {
    progressed = false;
    for (const a of serials) {
      if (items.length >= limit) break;
      if (a.count >= maxPerFranchise) continue;
      const r = a.it.peek();
      if (!r || used.has(r.id) || !fits(r)) continue;
      place(r);
      a.it.consume();
      a.count++;
      progressed = true;
    }
  }

  // 2. Remaining slots: best-fit films for the time still open.
  if (items.length < limit) {
    const standalone = series.filter((sr) => sr.rule !== 'serial').map((sr) => sr.subject);
    const scope = series.length ? standalone : null; // null = every movie on the channel
    let pool = moviePool(template, block, blockSecs, channelId, scope)
      .filter((r) => !used.has(r.id));
    // The whole-library pool sweeps in franchise members too. Picking those purely
    // by fit would air "Narnia 2" with no "Narnia 1" before it, so each franchise
    // is narrowed to the one part it is actually due to play.
    if (scope === null) pool = onlyNextParts(pool, channelId, block);
    for (const r of chooseMovies(pool, pos, blockSecs - (pos - startSecs), limit - items.length)) {
      place(r);
    }
  }
  return items;
}

/**
 * Keep every unordered film (chapter 0) plus, for each ordered series present, only
 * the part that series is due to play next. Lets an unrestricted movie block draw
 * on the whole library without airing a franchise out of order.
 */
function onlyNextParts(pool, channelId, block) {
  const due = new Map(); // subject -> chapter due next
  return pool.filter((r) => {
    if (!r.subject || Number(r.chapter) <= 0) return true;
    if (!due.has(r.subject)) due.set(r.subject, nextChapter(channelId, r.subject, block.target_date));
    const target = due.get(r.subject);
    // The series may have run past its last part, in which case it wraps to the
    // lowest remaining — mirror serialIterator's wrap rather than dropping it.
    const parts = pool.filter((x) => x.subject === r.subject).map((x) => Number(x.chapter)).sort((a, b) => a - b);
    const pick = parts.find((c) => c >= target) ?? parts[0];
    return Number(r.chapter) === pick;
  });
}

function iteratorForSeries(series, channelId, block, blockSecs) {
  switch (series.rule) {
    case 'serial':
      return serialIterator(channelId, series.subject, block);
    case 'tv': {
      const weekday = WEEKDAYS[new Date(block.target_date + 'T00:00:00').getDay()];
      const pick = weekday === 'Sun'
        ? latestEpisode(channelId, series.subject)
        : randomWithCooldown(channelId, candidates(channelId, series.subject, blockSecs), block.target_date);
      return singleIterator(pick);
    }
    case 'cooldown':
    default:
      return singleIterator(
        randomWithCooldown(channelId, candidates(channelId, series.subject, blockSecs), block.target_date)
      );
  }
}

/**
 * Greedy multi-series fill. Cycles the block's series in order, appending each
 * one's next resource whenever it still fits the slot (0s overrun ceiling), so a
 * block of series A,B,C fills A1,B1,C1,A2,B2,… until nothing more fits. Serial
 * series advance chapter-by-chapter (across days via the PlayHistory cursor);
 * standalone movie/documentary and TV picks contribute a single item. Returns
 * the ordered array of Resource rows; fillers top up the remainder.
 */
export function pickMainContent(template, block, blockSecs) {
  const channelId = block.channel_id ?? template.channel_id;
  const series = templateSeries(template, channelId);
  if (!series.length && !isMovieBlock(template)) return [];

  const iters = isMovieBlock(template)
    ? [sequenceIterator(pickMovieRun(template, block, blockSecs, 0, channelId))]
    : series.map((s) => iteratorForSeries(s, channelId, block, blockSecs));
  const items = [];
  const usedIds = new Set();
  let total = 0;
  let active = iters.slice();

  while (active.length) {
    let progressed = false;
    const stillActive = [];
    for (const it of active) {
      const r = it.peek();
      // Drop a series when it's exhausted, would repeat an item already in this
      // block (serial wrapped fully), or its next item no longer fits the slot.
      if (!r || usedIds.has(r.id) || total + r.duration > blockSecs) continue;
      items.push(r);
      usedIds.add(r.id);
      total += r.duration;
      it.consume();
      progressed = true;
      stillActive.push(it);
    }
    active = stillActive;
    if (!progressed) break;
  }
  return items;
}

/**
 * Build a reusable filler packer for a channel. Loads the approved filler pool
 * once, groups it by duration (each group LRU-ordered so repeats spread across
 * distinct clips), and returns a `pack(target)` closure plus a `hasFillers` flag.
 *
 * `pack(target)` fills in two passes:
 *   1. BULK — while the gap is wider than a small reserve, draw distinct
 *      clips in global LRU rotation. Every clip airs once before any airs twice,
 *      so a multi-hour gap no longer becomes one long filler on repeat.
 *   2. EXACT — an unbounded knapsack over integer-second durations on what is
 *      left (fillers MAY repeat here, which is what lets a coarse pool land a gap
 *      to the second), returning the LARGEST reachable total <= target and
 *      preferring fewer/longer fillers.
 * A gap no wider than that reserve skips pass 1 entirely, so the tightest
 * alignment gaps behave exactly as they did before. Both rotation cursors are
 * SHARED across successive pack() calls, so filling several gaps in one block
 * keeps spreading over the whole pool.
 *
 * `pack(target, { overrun: true })` relaxes the ceiling: if no reachable total
 * lands within maxUnderrun of the target, it takes the SMALLEST total above the
 * target instead (up to maxOverrun over). Used for the fill that closes a block,
 * where a few seconds long beats a bigger hole. Alignment gaps inside a block
 * keep the strict <= target ceiling, since overshooting one would push the next
 * main item off its quarter-hour mark.
 */
export function makeFillerPacker(channelId) {
  const fillers = db.prepare(
    'SELECT * FROM Resource WHERE channel_id = ? AND is_filler = 1 AND approved = 1'
  ).all(channelId);

  const byDur = new Map();
  for (const f of fillers) {
    if (!byDur.has(f.duration)) byDur.set(f.duration, []);
    byDur.get(f.duration).push(f);
  }
  for (const arr of byDur.values()) {
    arr.sort((a, b) => String(a.last_used_at || '').localeCompare(String(b.last_used_at || '')));
  }
  const allDurations = [...byDur.keys()].filter((d) => d > 0).sort((a, b) => a - b);
  const maxDuration = allDurations.length ? allDurations[allDurations.length - 1] : 0;
  const minDuration = allDurations.length ? allDurations[0] : 0;
  // What the bulk pass holds back for the exact pass. A few of the pool's
  // shortest clips is plenty — every target from roughly 2x the shortest clip up
  // is exactly composable — and holding back less means more of a wide gap is
  // spent on distinct clips instead of on the exact pass, which is free to repeat.
  const reserve = Math.min(maxDuration, 4 * minDuration);
  const cursor = new Map(); // duration -> LRU rotation offset, shared across pack() calls

  // Global LRU rotation over the WHOLE pool, shared across pack() calls in a
  // block. The bulk pass draws from here in order, so every clip airs once before
  // any airs twice — the fix for blocks that used to repeat one long filler a
  // dozen times because the exact pass kept reaching for the same (single-clip)
  // duration.
  const rotation = fillers
    .filter((f) => f.duration > 0)
    .sort((a, b) => String(a.last_used_at || '').localeCompare(String(b.last_used_at || '')));
  let rot = 0;
  function nextInRotation(maxDur) {
    for (let k = 0; k < rotation.length; k++) {
      const r = rotation[(rot + k) % rotation.length];
      if (r.duration <= maxDur) {
        rot = (rot + k + 1) % rotation.length;
        return r;
      }
    }
    return null;
  }

  function packExact(target, { overrun = false } = {}) {
    if (target <= 0 || !fillers.length) return { items: [], total: 0 };
    const tol = fitTolerance();
    // Composition search window: exactly `target` normally, a little past it when
    // overrun is allowed (so a total just above the block end is reachable).
    const limit = target + (overrun ? Math.max(0, tol.maxOverrun) : 0);
    const durations = allDurations.filter((d) => d <= limit);
    if (!durations.length) return { items: [], total: 0 };

    // reach[t] = t seconds is exactly composable; fromDur[t] records a duration
    // used to reach t, preferring the LARGEST that fits (fewer, longer fillers).
    const reach = new Array(limit + 1).fill(false);
    const fromDur = new Array(limit + 1).fill(0);
    reach[0] = true;
    for (let t = 1; t <= limit; t++) {
      for (let k = durations.length - 1; k >= 0; k--) {
        const d = durations[k];
        if (d <= t && reach[t - d]) { reach[t] = true; fromDur[t] = d; break; }
      }
    }
    let best = 0;
    for (let t = Math.min(target, limit); t >= 0; t--) { if (reach[t]) { best = t; break; } }
    // Best under-fill leaves too big a hole: take the smallest overrun instead.
    if (target - best > tol.maxUnderrun) {
      for (let t = target + 1; t <= limit; t++) { if (reach[t]) { best = t; break; } }
    }

    const durSeq = [];
    for (let t = best; t > 0; t -= fromDur[t]) durSeq.push(fromDur[t]);
    const items = durSeq.map((d) => {
      const arr = byDur.get(d);
      const i = (cursor.get(d) || 0) % arr.length;
      cursor.set(d, (cursor.get(d) || 0) + 1);
      return arr[i];
    }).reverse();
    return { items, total: best };
  }

  function pack(target, opts = {}) {
    if (target <= 0 || !fillers.length) return { items: [], total: 0 };
    // Bulk pass: spend a wide gap on distinct clips in LRU rotation, holding
    // `reserve` seconds back so packExact can still land the tail on the second.
    // A gap no wider than the reserve skips this pass entirely and is handled by
    // the exact pass alone, exactly as before.
    const bulk = [];
    let bulkTotal = 0;
    while (target - bulkTotal > reserve) {
      const r = nextInRotation(target - bulkTotal - reserve);
      if (!r) break;
      bulk.push(r);
      bulkTotal += r.duration;
    }
    let tail = packExact(target - bulkTotal, opts);

    // Diversity is best-effort; closing the gap is the guarantee. Spending clips
    // greedily can strand a remainder the pool cannot compose (a 6-clip pool asked
    // for 1800s lands 13s short this way, where 600+600+600 is exact), so bulk
    // clips are handed back one at a time until the exact pass can finish the job.
    // Worst case the whole bulk is returned and this is the old exact-only search.
    // Only the closing fill carries the tolerance, so only it pays for this: an
    // alignment gap mid-block is allowed to come up short and self-corrects at the
    // next quarter mark.
    if (opts.overrun) {
      while (bulk.length && !fitsTolerance(target - bulkTotal - tail.total)) {
        const r = bulk.pop();
        bulkTotal -= r.duration;
        rot = (rot - 1 + rotation.length) % rotation.length; // un-spend its turn
        tail = packExact(target - bulkTotal, opts);
      }
    }
    return { items: [...bulk, ...tail.items], total: bulkTotal + tail.total };
  }

  return { pack, hasFillers: fillers.length > 0 };
}

/**
 * Filler packer (single-shot). Choose fillers whose total duration is as close
 * to `remaining` as possible — under it when that lands within maxUnderrun,
 * otherwise slightly over (up to maxOverrun). Returns { items, total, fits }.
 */
export function fitFillers(channelId, remaining) {
  const tol = fitTolerance();
  const packer = makeFillerPacker(channelId);
  if (remaining <= 0) return { items: [], total: 0, fits: fitsTolerance(remaining, tol) };
  if (!packer.hasFillers) return { items: [], total: 0, fits: fitsTolerance(remaining, tol) };
  const { items, total } = packer.pack(remaining, { overrun: true });
  return { items, total, fits: fitsTolerance(remaining - total, tol) };
}

// Quarter-hour boundary, in seconds. Main content is aligned to :00/:15/:30/:45.
const QUARTER_SECS = 15 * 60;

/** Seconds-of-day for an 'HH:MM' clock time. */
function timeOfDaySeconds(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

/**
 * Quarter-hour aligned block builder. Places the block's main content so each
 * main item STARTS on the next :00/:15/:30/:45 clock boundary at or after the
 * running position, padding the gap before it with fillers ("use fillers to get
 * there"). Fillers therefore land before the first item (only when the block
 * doesn't start on a boundary), between items (alignment gaps), and after the
 * last item (trailing gap) — bookends plus in-between, driven by alignment.
 *
 * Alignment is best-effort ("if possible"): a gap the coarse filler pool can't
 * hit exactly just leaves the next item slightly early, and the running clock
 * self-corrects at the following boundary. The TRAILING gap does the precise
 * fill, and is the only one allowed to overshoot (see fitTolerance), so the
 * block lands inside the maxUnderrun / maxOverrun window.
 *
 * Returns { items, total } — the ordered resource sequence and its duration.
 */
export function buildAlignedBlock(template, block, blockSecs, startSecs, channelId, packer) {
  // A movie block places its own run: franchises at their next part, then
  // best-fitting standalone films for whatever time is left. See pickMovieRun.
  const movie = isMovieBlock(template);
  const iters = movie
    ? [sequenceIterator(pickMovieRun(template, block, blockSecs, startSecs, channelId))]
    : templateSeries(template, channelId).map((s) => iteratorForSeries(s, channelId, block, blockSecs));

  // max_per_show caps how many episodes one series may contribute to a block
  // (NULL/0 = unlimited). Tracked per iterator so a series drops out of the
  // cycle once it hits its cap, leaving room for the others (or fillers). A movie
  // block is already capped by movie_limit, so the per-show cap doesn't apply.
  const maxPerShow = movie || !(Number(template.max_per_show) > 0)
    ? Infinity
    : Number(template.max_per_show);

  const items = [];
  const usedIds = new Set();
  let total = 0; // placed seconds so far (main + fillers), i.e. offset from block start
  let active = iters.map((it) => ({ it, count: 0 }));

  while (active.length) {
    let progressed = false;
    const stillActive = [];
    for (const a of active) {
      const r = a.it.peek();
      if (!r || usedIds.has(r.id)) continue;
      // Filler gap needed to push this item's start onto the next quarter mark.
      const abs = startSecs + total;
      const gap = (Math.ceil(abs / QUARTER_SECS) * QUARTER_SECS) - abs;
      // Skip if the item can't fit even once aligned (gap upper-bounds the fill).
      if (total + gap + r.duration > blockSecs) continue;
      if (gap > 0) {
        const fill = packer.pack(gap);
        for (const f of fill.items) items.push(f);
        total += fill.total; // actual filler secs (<= gap; drift self-corrects next mark)
      }
      items.push(r);
      total += r.duration;
      usedIds.add(r.id);
      a.it.consume();
      a.count++;
      progressed = true;
      if (a.count < maxPerShow) stillActive.push(a); // retire the series once capped
    }
    active = stillActive;
    if (!progressed) break;
  }

  // Trailing fillers fill to the block end and carry the tolerance guarantee.
  let trailing = blockSecs - total;
  if (trailing > 0) {
    let fill = packer.pack(trailing, { overrun: true });
    // A residual gap shorter than the shortest filler is unreachable on its own —
    // the pool simply has no clip that small, so pack() returns nothing and the
    // hole survives. Give the pack more room by taking back fillers already
    // placed in the block and re-packing the widened span at the end: a span of
    // gap + a released filler is coarse enough to hit the target. The main item
    // that followed a released filler loses its quarter-hour alignment, which is
    // best-effort anyway; the block-end tolerance is the hard guarantee.
    while (!fitsTolerance(trailing - fill.total)) {
      const i = items.findLastIndex((r) => r.is_filler);
      if (i < 0) break; // no filler to release — leave the hole, validation flags it
      total -= items[i].duration;
      items.splice(i, 1);
      trailing = blockSecs - total;
      fill = packer.pack(trailing, { overrun: true });
    }
    for (const f of fill.items) items.push(f);
    total += fill.total;
  }
  return { items, total };
}

// --- Block population -------------------------------------------------------

/** Load a ScheduledBlock joined to its slot + template, with derived fields. */
function loadBlock(blockId) {
  const block = db.prepare(`
    SELECT sb.*, s.start_time AS slot_start, s.end_time AS slot_end, s.slot_order
    FROM ScheduledBlock sb
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.id = ?
  `).get(blockId);
  if (!block) return null;
  const template = db.prepare('SELECT * FROM BlockTemplate WHERE id = ?').get(block.template_id);
  // Fall back to the template's legacy times for pre-slot blocks.
  const start = block.slot_start || template.start_time;
  const end = block.slot_end || template.end_time;
  // A block carries its own channel (a template can air on several); fall back to
  // the template's primary channel for legacy rows without channel_id.
  const channelId = block.channel_id ?? template.channel_id;
  return { block, template, start, end, slotOrder: block.slot_order ?? 0, channelId };
}

/** Copy one block's ordered items into another (used for strict mirroring). */
function copyItems(fromBlockId, toBlockId) {
  db.prepare('DELETE FROM ScheduleItem WHERE block_id = ?').run(toBlockId);
  const src = db.prepare(
    'SELECT resource_id, play_order FROM ScheduleItem WHERE block_id = ? ORDER BY play_order'
  ).all(fromBlockId);
  const ins = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, 0)'
  );
  src.forEach((it, idx) => ins.run(toBlockId, it.resource_id, idx));
  return src.length;
}

/**
 * Re-sync all secondary airings of a template/date/channel to match the primary
 * block. Scoped by channel because a template can air on several channels, each
 * with its own independent primary + mirrors.
 */
function resyncMirrors(template_id, target_date, channelId, primaryBlockId) {
  const mirrors = db.prepare(
    'SELECT id FROM ScheduledBlock WHERE template_id = ? AND target_date = ? AND channel_id IS ? AND id != ?'
  ).all(template_id, target_date, channelId ?? null, primaryBlockId);
  for (const m of mirrors) copyItems(primaryBlockId, m.id);
}

/**
 * Interleave fillers around main content. Produces one gap before each main item
 * and one trailing gap (main.length + 1 gaps), dealing fillers as evenly as
 * possible with any remainder placed in the leading gaps, preserving both the
 * main order and the filler order. Returns the merged resource sequence.
 */
export function spreadFillers(main, fillers) {
  if (!main.length) return [...fillers];
  if (!fillers.length) return [...main];
  const gaps = main.length + 1;
  const base = Math.floor(fillers.length / gaps);
  let extra = fillers.length % gaps; // remainder spread over the leading gaps
  const out = [];
  let fi = 0;
  for (let g = 0; g < gaps; g++) {
    let take = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    for (let k = 0; k < take && fi < fillers.length; k++) out.push(fillers[fi++]);
    if (g < main.length) out.push(main[g]);
  }
  while (fi < fillers.length) out.push(fillers[fi++]); // safety: flush any remainder
  return out;
}

/**
 * Populate a single ScheduledBlock. A primary airing (slot_order 0) picks main
 * content by cycling its series, fits fillers, preserves manual overrides, and
 * then re-syncs its mirror airings. A secondary airing strict-mirrors its
 * primary. Returns { blockId, blockSeconds, mainCount, fillerCount, underrun,
 * fits, mirrored }.
 */
export function populateBlock(block) {
  const ctx = loadBlock(block.id);
  if (!ctx) return null;
  const { template, start, end, slotOrder, channelId } = ctx;
  const blockSecs = blockDurationSeconds(start, end);

  // Secondary airing: copy the primary's content verbatim (same channel).
  if (slotOrder > 0) {
    const primarySlot = db.prepare(
      'SELECT id FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order LIMIT 1'
    ).get(template.id);
    const primary = primarySlot && db.prepare(
      'SELECT id FROM ScheduledBlock WHERE template_id = ? AND slot_id = ? AND target_date = ? AND channel_id IS ?'
    ).get(template.id, primarySlot.id, block.target_date, channelId ?? null);
    const count = primary ? copyItems(primary.id, block.id) : 0;
    const total = db.prepare(
      'SELECT COALESCE(SUM(r.duration),0) AS s FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ?'
    ).get(block.id).s;
    const underrun = blockSecs - total;
    return { blockId: block.id, blockSeconds: blockSecs, mainCount: count, fillerCount: 0, underrun, fits: fitsTolerance(underrun), mirrored: true };
  }

  // Primary airing: regenerate auto items, preserve manual overrides.
  db.prepare('DELETE FROM ScheduleItem WHERE block_id = ? AND is_manual_override = 0').run(block.id);

  const kept = db.prepare(
    'SELECT si.*, r.duration FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ? ORDER BY si.play_order'
  ).all(block.id);
  const keptSecs = kept.reduce((s, i) => s + i.duration, 0);

  const insert = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, 0)'
  );
  let mainCount = 0;
  let fillerCount = 0;
  let placedSecs = 0;

  if (kept.length) {
    // A manual override is pinned (single-block regenerate): don't rebuild main
    // content, just top up around it. Fillers stream in after the kept items.
    const remaining = blockSecs - keptSecs;
    const { items: fillers } = fitFillers(channelId, remaining);
    let order = kept.length;
    for (const r of fillers) insert.run(block.id, r.id, order++);
    fillerCount = fillers.length;
    placedSecs = keptSecs + fillers.reduce((s, r) => s + r.duration, 0);
  } else {
    // Fresh build: place main content on quarter-hour marks, packing fillers
    // before/between/after to hit each mark and the block end.
    const startSecs = timeOfDaySeconds(start);
    const packer = makeFillerPacker(channelId);
    const { items: seq, total } = buildAlignedBlock(template, block, blockSecs, startSecs, channelId, packer);
    let order = 0;
    for (const r of seq) {
      insert.run(block.id, r.id, order++);
      if (r.is_filler) fillerCount++; else mainCount++;
    }
    placedSecs = total;
  }

  // Keep secondary airings identical to what we just built (same channel).
  resyncMirrors(template.id, block.target_date, channelId, block.id);

  const underrun = blockSecs - placedSecs;
  return {
    blockId: block.id,
    blockSeconds: blockSecs,
    mainCount,
    fillerCount,
    underrun,
    fits: fitsTolerance(underrun),
    mirrored: false,
  };
}

/**
 * Instantiate active templates as draft ScheduledBlocks for the next 7 days
 * (starting `weekStart`) — one block per matching weekday per time slot.
 * Idempotent via UNIQUE(template_id, slot_id, target_date). Returns the blocks,
 * sorted primary-first within each template/date so mirrors populate after.
 */
export function rollForwardTemplates(weekStart = new Date(), channelId = null) {
  const templates = db.prepare('SELECT * FROM BlockTemplate').all();

  // The active channels a template airs on (BlockTemplateChannel, falling back to
  // the legacy primary channel). Only channels that are currently active.
  const channelsFor = db.prepare(`
    SELECT c.id FROM BlockTemplateChannel btc
    JOIN ChannelType c ON c.id = btc.channel_id
    WHERE btc.template_id = ? AND c.is_active = 1
    ORDER BY c.id
  `);
  const legacyChannel = db.prepare('SELECT id FROM ChannelType WHERE id = ? AND is_active = 1');

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status)
    VALUES (?, ?, ?, ?, 'draft')
  `);
  const fetch = db.prepare(
    'SELECT * FROM ScheduledBlock WHERE template_id = ? AND slot_id = ? AND channel_id IS ? AND target_date = ?'
  );

  const created = [];
  for (let i = 0; i < 7; i++) {
    const target = dateStr(i, weekStart);
    const weekday = WEEKDAYS[new Date(target + 'T00:00:00').getDay()];
    for (const t of templates) {
      if (!templateWeekdays(t).includes(weekday)) continue;
      let channels = channelsFor.all(t.id).map((r) => r.id);
      if (!channels.length && legacyChannel.get(t.channel_id)) channels.push(t.channel_id);
      if (channelId != null) channels = channels.filter((c) => c === Number(channelId));
      for (const ch of channels) {
        for (const slot of templateSlots(t)) {
          insert.run(t.id, slot.id, ch, target);
          const block = fetch.get(t.id, slot.id, ch, target);
          if (block) created.push({ ...block, slot_order: slot.slot_order });
        }
      }
    }
  }
  // Primary (slot_order 0) before mirrors so copyItems has a populated source.
  // Group by channel too, so each channel's primary precedes its own mirrors.
  created.sort((a, b) =>
    a.target_date.localeCompare(b.target_date) ||
    (a.template_id - b.template_id) ||
    ((a.channel_id ?? 0) - (b.channel_id ?? 0)) ||
    (a.slot_order - b.slot_order)
  );
  return created;
}

/**
 * Wipe every DRAFT block (and its items, via ON DELETE CASCADE) in the 7-day
 * window for the scope, so a regenerate always rebuilds from scratch. Approved
 * and exported blocks are committed history and are left untouched.
 */
function wipeDraftBlocks(weekStart, channelId) {
  const clauses = ["status = 'draft'", 'target_date BETWEEN ? AND ?'];
  const params = [dateStr(0, weekStart), dateStr(6, weekStart)];
  if (channelId != null) {
    clauses.push("COALESCE(channel_id, (SELECT channel_id FROM BlockTemplate WHERE id = template_id)) = ?");
    params.push(Number(channelId));
  }
  db.prepare(`DELETE FROM ScheduledBlock WHERE ${clauses.join(' AND ')}`).run(...params);
}

/**
 * Generate a full week: delete the existing draft schedule for the scope, roll
 * forward templates, then populate each freshly-created draft block. Approved/
 * exported blocks survive the wipe and are not repopulated. Pass a channelId to
 * restrict generation to a single channel (per-channel tab).
 */
export function generateWeek(weekStart = new Date(), channelId = null) {
  wipeDraftBlocks(weekStart, channelId);
  const blocks = rollForwardTemplates(weekStart, channelId);
  return blocks.filter((b) => b.status === 'draft').map((b) => populateBlock(b)).filter(Boolean);
}
