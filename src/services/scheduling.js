// Module A — the auto-generation engine.
//
// Turns active BlockTemplates into draft ScheduledBlocks for the coming week
// (across every weekday the template runs and every time slot it airs at),
// populates each primary airing by cycling its assigned series chapter-by-chapter
// and packing fillers to hit the slot's exact duration, then strict-mirrors that
// content into the template's secondary airings.

import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { nextChapter, cooldownEligible } from './playHistory.js';
import { log } from '../logger.js';
import { holidaySql } from './holidays.js';

const l = log('scheduling');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The ShowType.code a movie block is allowed to draw from. Content types must
// never mix: a block flagged is_movie_block airs films and nothing else, however
// a series got assigned to it and whatever a Resource row claims about itself.
export const MOVIES_CODE = 'movies';

// --- Clips whose file is gone ----------------------------------------------
// Air Spec records a catalogued file it found missing from the share
// (TranscodeItem.status 'missing'). OTAV skips a clip it cannot open, so a
// scheduled missing file shortens the day by its whole length and the channel
// goes black that much sooner. The engine never picks one. Missing is reported
// and never deleted (a share hiccup must not shrink the catalogue), so this
// filter is what keeps a known-gone file off the air until it is back.
export const ON_DISK_SQL = `NOT EXISTS (SELECT 1 FROM TranscodeItem ti
  WHERE ti.file_path = r.file_path AND ti.status = 'missing')`;

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

// --- Filler run cap (shared truth for the engine, the API and the UI) -------
// A block is allowed plenty of filler overall — what an operator (and a viewer)
// experiences as dead air is a long UNBROKEN run of it. So the cap is on the
// longest consecutive stretch of fillers, not on the block's filler total: two
// 15-minute stretches either side of a feature are fine, half an hour back to
// back is not. Nothing in the engine tries to satisfy this by itself; a block
// over the cap is flagged and the operator adds or removes content.

/** Longest allowed unbroken filler stretch, in seconds (config.filler). */
export function fillerRunLimit() {
  const n = Number((loadConfig().filler || {}).maxConsecutiveSeconds);
  return n > 0 ? n : 20 * 60;
}

/** Longest unbroken run of filler, in seconds, over items in play order. */
export function maxFillerRunSeconds(items) {
  let run = 0;
  let max = 0;
  for (const it of items) {
    if (Number(it.is_filler)) {
      run += Number(it.duration) || 0;
      if (run > max) max = run;
    } else run = 0;
  }
  return max;
}

/** Block length in seconds from 'HH:MM' start/end (handles past-midnight). */
export function blockDurationSeconds(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let secs = (eh * 3600 + em * 60) - (sh * 3600 + sm * 60);
  if (secs <= 0) secs += 24 * 3600; // wraps past midnight
  return secs;
}

// --- Block shifts -------------------------------------------------------------
// Sometimes a block cannot be brought inside tolerance at all: the catalogue has
// no clip that closes the hole, or the programme simply runs long. The operator
// can then move the BOUNDARY between two blocks — "this one ends 3:12 later and
// the next one starts 3:12 later" — instead of forcing a block that is wrong.
//
// A shift is stored once, as `ScheduledBlock.end_shift_seconds`, and read back
// as the start shift of the block that begins where it ends (same channel, same
// date, slot start == slot end). Storing it once is what keeps the two sides
// from ever disagreeing: OTAV plays the day as one continuous playlist, so the
// next block really does start whenever this one ends. A block with nothing
// adjacent after it (a gap, the end of the day) can still end later or earlier;
// the start of a block with nothing adjacent before it is fixed.

/** The largest shift an operator may set, in seconds (config shift.maxSeconds). */
export function maxShiftSeconds() {
  return Number(loadConfig().shift?.maxSeconds ?? 900);
}

/** 'HH:MM' → seconds after midnight. */
function hhmmSeconds(t) {
  const [h, m] = String(t || '00:00').split(':').map(Number);
  return h * 3600 + m * 60;
}

/** Seconds after midnight → 'HH:MM:SS' (wraps a day either way). */
export function clockString(secs) {
  const s = ((Math.round(secs) % 86400) + 86400) % 86400;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

const DAY_SECONDS = 86400;
/** Days since the epoch for a 'YYYY-MM-DD' date (calendar arithmetic, no clock). */
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);

/**
 * Seconds after midnight at which `channelId`'s first block of the day AFTER
 * `targetDate` starts, or null when that day has nothing scheduled.
 */
function nextDayFirstStart(channelId, targetDate) {
  const row = db.prepare(`
    SELECT MIN(COALESCE(s.start_time, bt.start_time)) AS t
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE COALESCE(sb.channel_id, bt.channel_id) = ? AND sb.target_date = date(?, '+1 day')
  `).get(channelId, targetDate);
  return row?.t ? hhmmSeconds(row.t) : null;
}

/** Fill time no block covers by stretching the block before it? (config schedule.extendIntoGaps) */
export function extendsIntoGaps() {
  return loadConfig().schedule?.extendIntoGaps !== false;
}

/**
 * Annotate blocks with their shifted window. Each row needs id, channel_id,
 * target_date, start_time, end_time and end_shift_seconds; it gains
 * start_shift / end_shift (seconds), prev_block_id / next_block_id (the adjacent
 * block on either side, or null), extend_seconds / overlap_seconds (see below),
 * slotSeconds, blockSeconds (the shifted length) and effective_start /
 * effective_end ('HH:MM:SS'). Rows whose neighbours are not in `rows` are
 * treated as having none, so pass whole channel-days.
 *
 * GAPS ARE COVERED. OTAV plays a channel-day as one continuous playlist, so time
 * no block covers is not "nothing on air at 19:00" — it is the rest of the day
 * starting early, and the day running out before the next day's event: black
 * on air. So a block followed by uncovered time owns that time
 * (`extend_seconds`): its window runs to the start of the next block, and the
 * last block of a day runs to the first block of the NEXT day (a template that
 * ends at 23:59 loses its minute this way, Elevate's 00:00–06:00 night lands in
 * its last block). Generation fills the window and validation judges it, so
 * neither has to know. The next day must be scheduled for this to apply; when
 * it is not, the week check reports it. `overlap_seconds` is the opposite: the
 * next block starts before this one ends — a template conflict, never extended.
 * `schedule.extendIntoGaps: false` turns the extension off.
 */
export function linkShifts(rows, { nextDayStart = nextDayFirstStart } = {}) {
  for (const r of rows) {
    r.end_shift = Number(r.end_shift_seconds) || 0;
    r.start_shift = 0;
    r.prev_block_id = null;
    r.next_block_id = null;
    r.extend_seconds = 0;
    r.overlap_seconds = 0;
    r.slotSeconds = blockDurationSeconds(r.start_time, r.end_time);
    r._start = dayNumber(r.target_date) * DAY_SECONDS + hhmmSeconds(r.start_time);
    r._end = r._start + r.slotSeconds;
  }

  // A boundary links two blocks only when exactly one block ends there and
  // exactly one starts there, on the same date. Two templates sharing a slot on
  // the same day is a conflict in the templates, and guessing which of them the
  // shift belongs to would move a block nobody asked to move. Times are
  // absolute, so a block ending at midnight never "links" to the 00:00 block
  // that STARTS the same date.
  const at = (r, t) => `${r.channel_id}|${r.target_date}|${t}`;
  const starting = new Map();
  const ending = new Map();
  for (const r of rows) {
    const s = at(r, r._start), e = at(r, r._end);
    starting.set(s, starting.has(s) ? null : r);
    ending.set(e, ending.has(e) ? null : r);
  }
  for (const r of rows) {
    const k = at(r, r._end);
    const next = starting.get(k);
    if (!next || next === r || ending.get(k) !== r) continue;
    r.next_block_id = next.id;
    next.prev_block_id = r.id;
    next.start_shift = r.end_shift;
  }

  {
    const extend = extendsIntoGaps();
    const byChannel = new Map();
    for (const r of rows) {
      if (!byChannel.has(r.channel_id)) byChannel.set(r.channel_id, []);
      byChannel.get(r.channel_id).push(r);
    }
    for (const list of byChannel.values()) {
      list.sort((a, b) => a._start - b._start || a.id - b.id);
      // Two blocks in the same time (a duplicated slot, a template that runs
      // through its neighbours): both air, one after the other, and everything
      // after them airs that much late.
      for (let i = 0; i + 1 < list.length; i++) {
        const r = list[i], nx = list[i + 1];
        const over = (r._end + r.end_shift) - (nx._start + nx.start_shift);
        if (nx._start === r._start || (over > 0 && r.next_block_id !== nx.id)) {
          r.overlap_seconds = Math.max(r.overlap_seconds, over);
        }
      }
      if (!extend) continue;
      list.forEach((r, i) => {
        if (r.next_block_id) return;
        const end = r._end + r.end_shift;
        // What airs next: the first block starting after this one, on this date
        // or the next one — never further (a day that is not generated yet is
        // a hole to report, not a day-long block).
        const nxt = list.slice(i + 1).find((x) => x._start > r._start);
        // A gap on the same day: this block owns it, and the block after the
        // gap becomes its neighbour — the boundary between them is one point in
        // the continuous playlist like any other, and can move the same way.
        if (nxt && nxt.target_date === r.target_date && !nxt.prev_block_id && nxt._start > r._end) {
          r.extend_seconds = nxt._start - r._end;
          r.next_block_id = nxt.id;
          nxt.prev_block_id = r.id;
          nxt.start_shift = r.end_shift;
          return;
        }
        let nextStart = null;
        if (nxt) {
          if (dayNumber(nxt.target_date) - dayNumber(r.target_date) <= 1) nextStart = nxt._start + nxt.start_shift;
        } else if (nextDayStart) {
          const t = nextDayStart(r.channel_id, r.target_date);
          if (t != null) nextStart = (dayNumber(r.target_date) + 1) * DAY_SECONDS + t;
        }
        if (nextStart == null) return;
        if (r.overlap_seconds) return; // a conflict is reported, never stretched
        if (nextStart > end) r.extend_seconds = nextStart - end;
        else if (nextStart < end) r.overlap_seconds = end - nextStart;
      });
    }
  }

  for (const r of rows) {
    const start = hhmmSeconds(r.start_time);
    r.blockSeconds = r.slotSeconds - r.start_shift + r.end_shift + r.extend_seconds;
    r.effective_start = clockString(start + r.start_shift);
    r.effective_end = clockString(start + r.slotSeconds + r.end_shift + r.extend_seconds);
    delete r._start;
    delete r._end;
  }
  return rows;
}

/** Every block of one channel-day with its window, for linkShifts(). */
export function channelDayBlocks(channelId, targetDate) {
  return db.prepare(`
    SELECT sb.id, sb.target_date, sb.status, sb.end_shift_seconds, sb.end_shift_auto,
           COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
           COALESCE(s.start_time, bt.start_time)  AS start_time,
           COALESCE(s.end_time, bt.end_time)      AS end_time,
           COALESCE(s.slot_order, 0)              AS slot_order
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE COALESCE(sb.channel_id, bt.channel_id) = ? AND sb.target_date = ?
    ORDER BY start_time, sb.id
  `).all(channelId, targetDate);
}

/** One block's shifted window (see linkShifts), or null when it is gone. */
export function shiftedWindow(blockId, channelId, targetDate) {
  return linkShifts(channelDayBlocks(channelId, targetDate)).find((r) => r.id === blockId) ?? null;
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
  if (active.length) {
    return active.map((r) => ({
      subject: r.subject,
      rule: ruleFor(r.show_code, r.is_serial),
      show_code: r.show_code ?? null,
    }));
  }

  // Legacy fallback: derive a single series from the old columns.
  if (template.target_subject) {
    const legacy = {
      lesson_series: { show_code: 'lessons', is_serial: 1 },
      tv_episode: { show_code: 'tv_shows', is_serial: 1 },
      movie: { show_code: 'movies', is_serial: 0 },
    }[template.content_type] || { show_code: 'movies', is_serial: 0 };
    return [{
      subject: template.target_subject,
      rule: ruleFor(legacy.show_code, legacy.is_serial),
      show_code: legacy.show_code,
    }];
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
function candidates(channelId, subject, maxDuration, showCode = null, date = null) {
  const clauses = ['r.channel_id = ?', 'r.is_filler = 0', 'r.approved = 1', ON_DISK_SQL];
  // Seasonal films air only in their season (services/holidays.js).
  const hol = date ? holidaySql(date) : null;
  if (hol) clauses.push(hol.allowed);
  const params = [channelId];
  if (subject) { clauses.push('r.subject = ?'); params.push(subject); }
  if (maxDuration) { clauses.push('r.duration <= ?'); params.push(maxDuration); }
  // A show type filter is by ShowType.code rather than the subject label: the
  // subject says what folder a clip came from, the show type says what it IS,
  // and only the second one keeps a lesson out of a movie block.
  if (showCode) { clauses.push('st.code = ?'); params.push(showCode); }
  return db.prepare(`
    SELECT r.*, ${hol ? hol.inSeason : '0'} AS in_season FROM Resource r
    LEFT JOIN ShowType st ON st.id = r.show_type_id
    WHERE ${clauses.join(' AND ')}
  `).all(...params);
}

// --- Per-series content iterators -------------------------------------------
// Each returns { peek(): Resource|null, consume(): void }. `peek` shows the next
// candidate without committing; `consume` advances past it once it's placed.

function serialIterator(channelId, subject, block, showCode = null) {
  const chapters = seriesParts(channelId, subject, showCode, block?.target_date ?? null);
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

/**
 * Every part of an ordered series, in play order. Scoped by show type when the
 * caller has one to enforce (a movie block), so a series whose rows are typed as
 * something else contributes nothing rather than contributing the wrong thing.
 */
function seriesParts(channelId, subject, showCode = null, date = null) {
  const clauses = ['r.channel_id = ?', 'r.subject = ?', 'r.is_filler = 0', 'r.approved = 1', ON_DISK_SQL];
  if (date) clauses.push(holidaySql(date).allowed); // a Christmas saga waits for Christmas
  const params = [channelId, subject];
  if (showCode) { clauses.push('st.code = ?'); params.push(showCode); }
  return db.prepare(`
    SELECT r.* FROM Resource r
    LEFT JOIN ShowType st ON st.id = r.show_type_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.chapter ASC, r.id ASC
  `).all(...params);
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
export function moviePool(template, block, blockSecs, channelId, subjects = undefined, { ignoreCooldown = false } = {}) {
  const scope = subjects === undefined
    ? templateSeries(template, channelId).map((s) => s.subject)
    : subjects;
  const hol = holidaySql(block.target_date);
  let all;
  if (scope === null) {
    all = db.prepare(`
      SELECT r.*, ${hol.inSeason} AS in_season FROM Resource r
      JOIN ShowType st ON st.id = r.show_type_id
      WHERE r.channel_id = ? AND r.is_filler = 0 AND r.approved = 1 AND r.duration <= ?
        AND st.code = 'movies' AND ${ON_DISK_SQL} AND ${hol.allowed}
    `).all(channelId, blockSecs);
  } else {
    if (!scope.length) return [];
    const marks = scope.map(() => '?').join(',');
    // Named series are scoped by show type as well. The subject label alone is
    // not a content type: the production catalogue has 971 lesson files carrying
    // show_type Movies, and without this join they schedule as films.
    all = db.prepare(`
      SELECT r.*, ${hol.inSeason} AS in_season FROM Resource r
      JOIN ShowType st ON st.id = r.show_type_id
      WHERE r.channel_id = ? AND r.is_filler = 0 AND r.approved = 1 AND r.duration <= ?
        AND st.code = ? AND r.subject IN (${marks}) AND ${ON_DISK_SQL} AND ${hol.allowed}
    `).all(channelId, blockSecs, MOVIES_CODE, ...scope);
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

  // In season, a holiday film is exempt from the cooldown (it has a few weeks a
  // year); the ±6-day no-repeat still holds.
  const cooled = [
    ...all.filter((r) => Number(r.in_season)),
    ...cooldownEligible(channelId, all.filter((r) => !Number(r.in_season)), block.target_date),
  ];
  const unaired = all.filter((r) => !nearby.has(r.id));
  if (ignoreCooldown) return unaired.length ? unaired : all;
  const fresh = cooled.filter((r) => !nearby.has(r.id));
  if (fresh.length) return fresh;
  if (cooled.length) return cooled;    // the whole catalogue already aired this week
  if (unaired.length) return unaired;  // everything is still cooling down
  return all;                          // both, on a catalogue this small
}

/**
 * Pick the best-fitting ordered run of up to `limit` movies from `pool`.
 *
 * Scoring mirrors how buildAlignedBlock will actually lay them out: items play
 * back to back from the block start, so a run's span is simply its durations.
 * The search is a depth-first walk over runs
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
      // Franchise rules. Chapter 0 means "no ordinal" (every standalone film in
      // the flat Movies folder), so it carries no order to respect and two of
      // them may share a block freely. An ordered part, though:
      //   - may only continue its own franchise FORWARDS, and
      //   - may not share the run with a DIFFERENT franchise, because a saga
      //     that has started airs to its end before another one begins.
      if (r.subject != null && Number(r.chapter) > 0 && chosen.some(
        (c) => Number(c.chapter) > 0 && (
          c.subject !== r.subject || Number(c.chapter) >= Number(r.chapter)
        )
      )) continue;
      const end = pos + r.duration;
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
  const series = moviesOnly(templateSeries(template, channelId), template);

  // ONE franchise at a time. A saga that has started airs to its end — over as
  // many blocks as it takes — before another saga begins, so the block's serial
  // slots all belong to a single franchise: the one already mid-run on this
  // channel, or, when none is, the first the template names.
  const serialSubjects = series.filter((sr) => sr.rule === 'serial').map((sr) => sr.subject);
  const activeSubject = activeFranchise(channelId, serialSubjects, block)
    ?? (serialSubjects.length ? serialSubjects[0] : activeFranchise(channelId, null, block));

  /** Build the run, with or without the franchise that is mid-run. */
  const build = (saga) => {
    const items = [];
    const used = new Set();
    let pos = startSecs; // running clock, so fit is measured the way the block lays out
    const endIfPlaced = (r) => pos + r.duration;
    const fits = (r) => endIfPlaced(r) - startSecs <= blockSecs;
    const place = (r) => { pos = endIfPlaced(r); items.push(r); used.add(r.id); };

    // 1. The saga in progress, at the part it is due.
    if (saga) {
      // How many parts it may take in ONE block: a double bill only when the
      // saga is the block's sole source, otherwise one part per block so an
      // unordered folder still gets its slot. A saga spans as many blocks as it
      // has parts — that is the point; it just may not be interrupted.
      const hasStandalone = series.some((sr) => sr.rule !== 'serial');
      const maxParts = hasStandalone ? 1 : limit;
      const it = serialIterator(channelId, saga, block, MOVIES_CODE);
      for (let n = 0; n < maxParts && items.length < limit; n++) {
        const r = it.peek();
        if (!r || used.has(r.id) || !fits(r)) break;
        place(r);
        it.consume();
      }
    }

    // 2. Remaining slots: best-fit films for the time still open.
    if (items.length < limit) {
      const standalone = series.filter((sr) => sr.rule !== 'serial').map((sr) => sr.subject);
      const scope = series.length ? standalone : null; // null = every movie on the channel
      const allowed = (list) => {
        const p = list.filter((r) => !used.has(r.id));
        // Without a saga in this run: standalone films, plus — when no saga is
        // mid-run anywhere — each franchise's OPENING part, which is how the next
        // saga starts. While one IS mid-run (this is the "hold it for the next
        // block" pass), nothing else may start: standalone films only.
        if (saga) return franchiseFilter(p, channelId, block, saga);
        if (!activeSubject) return franchiseFilter(p, channelId, block, null);
        return p.filter((r) => !r.subject || Number(r.chapter) <= 0);
      };
      let pool = allowed(moviePool(template, block, blockSecs, channelId, scope));
      // Everything the rules allow may still be cooling down while what is fresh
      // is all later saga parts (production, 2026-10: 98 fresh titles, every one
      // a part 2+). An empty block is worse than an early repeat: fall back to
      // the allowed titles ignoring the cooldown (never the ±6-day repeat rule).
      if (!pool.length) {
        pool = allowed(moviePool(template, block, blockSecs, channelId, scope, { ignoreCooldown: true }));
      }
      // (The pool sweeps in franchise members too, and picking those purely by
      // fit would air "Narnia 2" with no "Narnia 1" before it — or start a second
      // saga while the first is half aired; allowed() above is what prevents it.)
      const room = blockSecs - (pos - startSecs);
      for (const r of preferSeasonal(pool, pos, room, limit - items.length)) place(r);
    }
    return { items, hole: blockSecs - (pos - startSecs) };
  };

  const run = build(activeSubject);
  // Order comes first, but not at any price: when leading with the saga's next
  // part leaves more dead air than a block is allowed to hold back to back, and
  // the films alone close the slot better, the saga waits for the next movie
  // block. It is a DELAY, never a skip — the cursor doesn't move, so the same
  // part is due next time.
  if (activeSubject && run.hole > fillerRunLimit()) {
    const without = build(null);
    if (without.hole < run.hole) {
      l.info(`block ${block.id}: holding "${activeSubject}" for the next movie block`
        + ` — leading with it leaves ${run.hole}s of filler against ${without.hole}s without it`);
      return without.items;
    }
  }
  return run.items;
}

/**
 * chooseMovies(), preferring films in their holiday season: as many seasonal
 * titles as fit lead the run and the rest is filled by best fit. When that
 * leaves more dead air than the filler-run cap and leading with a single
 * seasonal title closes the slot better, the single lead wins — a holiday film
 * is preferred, never at the price of a block that cannot air.
 */
function preferSeasonal(pool, startSecs, room, limit) {
  const seasonal = pool.filter((r) => Number(r.in_season));
  if (!seasonal.length || limit <= 0) return chooseMovies(pool, startSecs, room, limit);
  const sum = (list) => list.reduce((s, r) => s + r.duration, 0);
  const lead = (k) => {
    const first = chooseMovies(seasonal, startSecs, room, k);
    const used = new Set(first.map((r) => r.id));
    const rest = chooseMovies(pool.filter((r) => !used.has(r.id)), startSecs + sum(first),
      room - sum(first), limit - first.length);
    return [...first, ...rest];
  };
  const many = lead(limit);
  if (room - sum(many) <= fillerRunLimit()) return many;
  const one = lead(1);
  return room - sum(one) < room - sum(many) ? one : many;
}

/**
 * Drop every series a movie block is not allowed to draw from, i.e. anything
 * whose show type is not Movies. A series with no ChannelSeries row (and so no
 * show type of its own) is kept: the resource-level guards in seriesParts() and
 * moviePool() decide it by what its clips actually are.
 */
function moviesOnly(series, template) {
  const kept = series.filter((sr) => sr.show_code == null || sr.show_code === MOVIES_CODE);
  const dropped = series.filter((sr) => !kept.includes(sr));
  if (dropped.length) {
    // Worth a line in the log: this is why a movie block can come back short.
    l.warn(`movie block "${template?.name ?? template?.id}" ignores `
      + `${dropped.length} non-movie series: `
      + dropped.map((sr) => `${sr.subject} (${sr.show_code})`).join(', '));
  }
  return kept;
}

/**
 * The franchise this channel is part way through, if any — the saga that has
 * started but not finished, and therefore owns every serial slot until it ends.
 *
 * A saga is IN PROGRESS when the part it is due to play is neither its first
 * (never started) nor past its last (already finished). `subjects` narrows the
 * search to the series a template names; pass null to look at every ordered
 * movie subject on the channel, which is what a movie block with no series
 * assigned needs. Returns the subject, or null when nothing is mid-run.
 */
export function activeFranchise(channelId, subjects, block) {
  let list = subjects;
  if (list == null) {
    list = db.prepare(`
      SELECT r.subject FROM Resource r
      JOIN ShowType st ON st.id = r.show_type_id
      LEFT JOIN ChannelSeries cs ON cs.channel_id = r.channel_id AND cs.subject = r.subject
      WHERE r.channel_id = ? AND r.is_filler = 0 AND r.approved = 1
        AND st.code = ? AND r.chapter > 0 AND r.subject IS NOT NULL
      GROUP BY r.subject
      ORDER BY COALESCE(cs.play_order, 0), r.subject
    `).all(channelId, MOVIES_CODE).map((r) => r.subject);
  }
  for (const subject of list) {
    const parts = seriesParts(channelId, subject, MOVIES_CODE, block?.target_date ?? null)
      .map((r) => Number(r.chapter))
      .filter((c) => c > 0);
    if (parts.length < 2) continue; // a one-part "saga" is never mid-run
    const target = nextChapter(channelId, subject, block.target_date);
    if (target > parts[0] && target <= parts[parts.length - 1]) return subject;
  }
  return null;
}

/**
 * Keep every unordered film (chapter 0), and of the ordered ones keep only what
 * the one-saga-at-a-time rule allows: the part the ACTIVE franchise is due to
 * play, or — when no saga is in progress — the opening part of a franchise,
 * which is how the next saga gets started. Everything else is held back for a
 * later block.
 */
function franchiseFilter(pool, channelId, block, activeSubject) {
  const partsOf = (subject) => pool
    .filter((x) => x.subject === subject)
    .map((x) => Number(x.chapter))
    .sort((a, b) => a - b);
  const due = new Map(); // subject -> chapter due next
  return pool.filter((r) => {
    if (!r.subject || Number(r.chapter) <= 0) return true;
    const parts = partsOf(r.subject);
    if (activeSubject) {
      if (r.subject !== activeSubject) return false;
      if (!due.has(r.subject)) due.set(r.subject, nextChapter(channelId, r.subject, block.target_date));
      // The series may have run past its last part, in which case it wraps to the
      // lowest remaining — mirror serialIterator's wrap rather than dropping it.
      const target = due.get(r.subject);
      return Number(r.chapter) === (parts.find((c) => c >= target) ?? parts[0]);
    }
    return Number(r.chapter) === parts[0];
  });
}

/**
 * Cooldown-ordered candidates: everything outside its cooldown window first,
 * then the rest, each rotated by day-of-month so successive days start in a
 * different place without needing Math.random. This is randomWithCooldown()
 * widened from "one pick" to "the whole run, best first" — a non-serial series
 * used to hand a block exactly ONE clip however long the slot was, which is
 * where hours of filler came from.
 */
function cooldownOrder(channelId, pool, asOfDate) {
  if (!pool.length) return [];
  const rotate = (list) => {
    if (list.length < 2) return list;
    const i = new Date(asOfDate + 'T00:00:00').getDate() % list.length;
    return [...list.slice(i), ...list.slice(0, i)];
  };
  // A film in its season leads, cooldown or not: it has a few weeks a year.
  const seasonal = pool.filter((r) => Number(r.in_season));
  const rest = pool.filter((r) => !Number(r.in_season));
  const eligible = cooldownEligible(channelId, rest, asOfDate);
  const eligibleIds = new Set(eligible.map((r) => r.id));
  const cooling = rest.filter((r) => !eligibleIds.has(r.id));
  return [...rotate(seasonal), ...rotate(eligible), ...rotate(cooling)];
}

function iteratorForSeries(series, channelId, block, blockSecs) {
  switch (series.rule) {
    case 'serial':
      return serialIterator(channelId, series.subject, block);
    case 'tv': {
      const weekday = WEEKDAYS[new Date(block.target_date + 'T00:00:00').getDay()];
      const pool = candidates(channelId, series.subject, blockSecs, null, block.target_date);
      // Sunday still leads with the latest-added episode (SEED §4); it just
      // carries on down the list instead of stopping there.
      return sequenceIterator(weekday === 'Sun'
        ? pool.slice().sort((a, b) => String(b.added_at ?? '').localeCompare(String(a.added_at ?? '')) || b.id - a.id)
        : cooldownOrder(channelId, pool, block.target_date));
    }
    case 'cooldown':
    default:
      return sequenceIterator(
        cooldownOrder(channelId, candidates(channelId, series.subject, blockSecs, null, block.target_date), block.target_date)
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
 * where a few seconds long beats a bigger hole. A gap asked for anywhere else
 * keeps the strict <= target ceiling.
 */
export function makeFillerPacker(channelId) {
  const fillers = db.prepare(
    `SELECT r.* FROM Resource r WHERE r.channel_id = ? AND r.is_filler = 1 AND r.approved = 1 AND ${ON_DISK_SQL}`
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
    // Only the closing fill carries the tolerance, so only it pays for this.
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

/** Seconds-of-day for an 'HH:MM' clock time. */
function timeOfDaySeconds(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
}

/**
 * Block builder. Main content plays back to back from the block start; fillers
 * cover only what is left at the END, which is where the tolerance guarantee
 * lives (see fitTolerance).
 *
 * There is deliberately NO clock alignment inside a block. Main items used to
 * start on the next :00/:15/:30/:45 mark, with fillers padding the way there,
 * and it cost far more than it bought: it quantised the whole schedule to 15
 * minutes, so an 8.5-minute episode in a 30-minute slot left 6.5 minutes of
 * filler and then pushed the next episode past the block end — one programme
 * and 21 minutes of filler where two fit with four minutes to spare. The clock
 * promise that matters is when the BLOCK starts, and that comes from the slot.
 *
 * Returns { items, total } — the ordered resource sequence and its duration.
 */
export function buildAlignedBlock(template, block, blockSecs, startSecs, channelId, packer) {
  // A movie block places its own run: franchises at their next part, then
  // best-fitting standalone films for whatever time is left. See pickMovieRun.
  const movie = isMovieBlock(template);
  const seriesList = movie ? [] : templateSeries(template, channelId);
  const iters = movie
    ? [sequenceIterator(pickMovieRun(template, block, blockSecs, startSecs, channelId))]
    : seriesList.map((s) => iteratorForSeries(s, channelId, block, blockSecs));

  // max_per_show caps how many episodes one series may contribute to a block
  // (NULL/0 = unlimited). Tracked per iterator so a series drops out of the
  // cycle once it hits its cap, leaving room for the others (or fillers). A movie
  // block is already capped by movie_limit, so the per-show cap doesn't apply.
  const maxPerShow = movie || !(Number(template.max_per_show) > 0)
    ? Infinity
    : Number(template.max_per_show);

  const items = [];
  const usedIds = new Set();
  let mainCount = 0; // main items placed
  let total = 0; // placed seconds so far (main + fillers), i.e. offset from block start
  let active = iters.map((it, i) => ({ it, count: 0, serial: seriesList[i]?.rule === 'serial' }));

  while (active.length) {
    let progressed = false;
    const stillActive = [];
    for (const a of active) {
      // Walk this series forward past what it cannot contribute here. Two cases
      // are safe to skip: a clip already placed in this block, and a clip LONGER
      // THAN THE WHOLE SLOT — an episode that outgrew its own programme (ep 15
      // of "La Escuelita" runs 31:21 in a 30:00 block) used to stall its series
      // outright and leave the block 100% filler, every single week.
      let r = a.it.peek();
      // …except for a SERIAL show's due episode in a block that is still empty.
      // Skipping it there broke the one promise a serial makes: EDYOU PULSE
      // S02E02 (30:21) and S02E03 (32:10) in a 30:00 slot were both skipped, the
      // series wrapped, and every rebuild put S01E01 back over the operator's
      // pick. It is placed with its overrun instead; the block goes red and the
      // operator forces it (or lengthens the slot) — visible, never silent, and
      // the series still advances once the forced block is approved.
      if (r && a.serial && !items.length && !usedIds.has(r.id) && r.duration > blockSecs) {
        l.warn(`block ${block.id}: "${r.name}" (${r.duration}s) is longer than the ${blockSecs}s slot — `
          + 'placed anyway to keep the series in order; force the block or lengthen the slot');
        items.push(r);
        total += r.duration;
        mainCount++;
        usedIds.add(r.id);
        a.it.consume();
        a.count++;
        progressed = true;
        continue; // the block is full: nothing else fits after it
      }
      while (r && (usedIds.has(r.id) || r.duration > blockSecs)) {
        if (r.duration > blockSecs) {
          l.warn(`block ${block.id}: "${r.name}" (${r.duration}s) does not fit a ${blockSecs}s slot — skipped`);
        }
        a.it.consume();
        r = a.it.peek();
      }
      if (!r) continue;
      // Doesn't fit the room LEFT: hold it for a later block rather than
      // skipping ahead in the series — order is the guarantee here.
      if (total + r.duration > blockSecs) continue;
      items.push(r);
      total += r.duration;
      mainCount++;
      usedIds.add(r.id);
      a.it.consume();
      a.count++;
      progressed = true;
      if (a.count < maxPerShow) stillActive.push(a); // retire the series once capped
    }
    active = stillActive;
    if (!progressed) break;
  }

  // Closing pick. The cycle above takes each series in its own order, so it
  // stops as soon as the NEXT clip of every series is too long for the room
  // left — even when the same series holds a shorter one that would fit. When
  // that leaves more dead air than a block may hold back to back, look across
  // the unordered series for the longest clip that actually fits the hole.
  // Ordered series are left out: their order is the guarantee, and picking a
  // later part for its length is exactly what a serial must never do.
  if (!movie) {
    const openSeries = templateSeries(template, channelId).filter((sr) => sr.rule !== 'serial');
    let guard = 0;
    while (blockSecs - total > fillerRunLimit() && guard++ < 20) {
      const hole = blockSecs - total;
      let best = null;
      for (const sr of openSeries) {
        for (const r of candidates(channelId, sr.subject, hole, null, block.target_date)) {
          if (usedIds.has(r.id)) continue;
          if (!best || r.duration > best.duration) best = r;
        }
      }
      if (!best) break;
      items.push(best);
      total += best.duration;
      mainCount++;
      usedIds.add(best.id);
    }
  }

  // Trailing fillers fill to the block end and carry the tolerance guarantee.
  let trailing = blockSecs - total;
  if (trailing > 0) {
    let fill = packer.pack(trailing, { overrun: true });
    // A residual gap shorter than the shortest filler is unreachable on its own —
    // the pool simply has no clip that small, so pack() returns nothing and the
    // hole survives. Give the pack more room by taking back fillers already
    // placed in the block and re-packing the widened span at the end: a span of
    // gap + a released filler is coarse enough to hit the target. The block-end
    // tolerance is the hard guarantee.
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

  // Fillers were all appended at the end; spread them BETWEEN the programmes
  // instead. Nothing about the fit changes — only the order — but half an hour
  // of filler in one lump at the end of a six-hour block is dead air, and it is
  // also the one shape guaranteed to breach the filler-run cap. The first main
  // item stays first, so the block still opens with programme content at the
  // time the slot promises.
  const mains = items.filter((r) => !r.is_filler);
  const pad = items.filter((r) => r.is_filler);
  const ordered = mains.length
    ? [mains[0], ...spreadFillers(mains.slice(1), pad)]
    : pad;
  return { items: ordered, total };
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
  for (const m of mirrors) {
    copyItems(primaryBlockId, m.id);
    topUpMirror(m.id, channelId, target_date);
  }
}

/**
 * A repeat airing holds its primary's content clip for clip — but its WINDOW is
 * its own: it may own a gap after it (see linkShifts) that the primary does not.
 * Close whatever the copy leaves uncovered with fillers at the end, so the
 * repeat doesn't end the day early. Returns the seconds of filler added.
 */
function topUpMirror(blockId, channelId, targetDate) {
  if (channelId == null) return 0;
  const win = shiftedWindow(blockId, channelId, targetDate);
  if (!win) return 0;
  const total = blockTotalSeconds(blockId);
  const hole = win.blockSeconds - total;
  if (fitsTolerance(hole)) return 0;
  if (hole <= 0) return 0;
  const { items } = fitFillers(channelId, hole);
  const ins = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, 0)'
  );
  let order = db.prepare('SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ScheduleItem WHERE block_id = ?').get(blockId).n;
  for (const r of items) ins.run(blockId, r.id, order++);
  return items.reduce((s, r) => s + r.duration, 0);
}

/** Sum of a block's clip durations, in seconds. */
function blockTotalSeconds(blockId) {
  return db.prepare(
    'SELECT COALESCE(SUM(r.duration), 0) AS s FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ?'
  ).get(blockId).s;
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
  // Fill the window the operator left the block with: a shifted boundary is a
  // decision about when this block airs, and a rebuild must respect it.
  const blockSecs = (channelId != null
    ? shiftedWindow(block.id, channelId, ctx.block.target_date)?.blockSeconds
    : null) ?? blockDurationSeconds(start, end);

  // Secondary airing: copy the primary's content verbatim (same channel).
  if (slotOrder > 0) {
    const primarySlot = db.prepare(
      'SELECT id FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order LIMIT 1'
    ).get(template.id);
    const primary = primarySlot && db.prepare(
      'SELECT id FROM ScheduledBlock WHERE template_id = ? AND slot_id = ? AND target_date = ? AND channel_id IS ?'
    ).get(template.id, primarySlot.id, block.target_date, channelId ?? null);
    const count = primary ? copyItems(primary.id, block.id) : 0;
    if (primary) topUpMirror(block.id, channelId, block.target_date);
    const total = blockTotalSeconds(block.id);
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
    // Fresh build: main content back to back from the block start, fillers
    // closing whatever is left at the end.
    const startSecs = timeOfDaySeconds(start);
    const packer = makeFillerPacker(channelId);
    // A movie block that owns a gap (see linkShifts) has more time than its
    // slot; keep its feature cap in proportion, or the extra hours go to filler.
    const slotSecs = blockDurationSeconds(start, end);
    const tpl = isMovieBlock(template) && blockSecs > slotSecs
      ? { ...template, movie_limit: Math.ceil(movieLimit(template) * blockSecs / slotSecs) }
      : template;
    const { items: seq, total } = buildAlignedBlock(tpl, block, blockSecs, startSecs, channelId, packer);
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
/** null | id | [ids] → null (every channel) or a Set of channel ids. */
function channelScope(channelId) {
  if (channelId == null) return null;
  const ids = (Array.isArray(channelId) ? channelId : [channelId]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return ids.length ? new Set(ids) : null;
}

export function rollForwardTemplates(weekStart = new Date(), channelId = null) {
  const scope = channelScope(channelId);
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
      if (scope) channels = channels.filter((c) => scope.has(c));
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
  const scope = channelScope(channelId);
  if (scope) {
    clauses.push(`COALESCE(channel_id, (SELECT channel_id FROM BlockTemplate WHERE id = template_id)) IN (${[...scope].map(() => '?').join(',')})`);
    params.push(...scope);
  }
  db.prepare(`DELETE FROM ScheduledBlock WHERE ${clauses.join(' AND ')}`).run(...params);
}

/**
 * Generate a full week: delete the existing draft schedule for the scope, roll
 * forward templates, then populate each freshly-created draft block. Approved/
 * exported blocks survive the wipe and are not repopulated. Pass a channel id (or
 * a list of them) to restrict generation to those channels.
 */
export function generateWeek(weekStart = new Date(), channelId = null) {
  wipeDraftBlocks(weekStart, channelId);
  const blocks = rollForwardTemplates(weekStart, channelId);
  const results = blocks.filter((b) => b.status === 'draft').map((b) => populateBlock(b)).filter(Boolean);
  // Then close each channel-day: small residues move the boundaries instead of
  // piling up into a day that ends early.
  const days = new Set(blocks.filter((b) => b.channel_id != null).map((b) => `${b.channel_id}|${b.target_date}`));
  for (const k of days) {
    const [ch, date] = k.split('|');
    balanceDay(Number(ch), date, { rebuild: true });
  }
  return results;
}

// --- Automatic boundary correction ---------------------------------------------
// A block rarely lands on the second: the fit tolerance lets it end up to 5s
// short or long, and a manual edit can leave more. Every one of those residues
// moves everything after it on air (one continuous playlist), and at the end of
// the day they add up to the playlist ending early — black — or late. Instead,
// a residue up to shift.autoMaxSeconds (default 60) moves the boundary with the
// next block, exactly as an operator's shift does, and the next block is judged
// against its new window; the correction cascades down the day. Where a
// boundary cannot move — before a gap the block owns, at the end of the day —
// the block's window is fixed and a draft there is rebuilt to it instead.

/** Largest residue corrected by moving a boundary, in seconds (config shift.autoMaxSeconds). */
export function autoShiftMaxSeconds() {
  const n = Number(loadConfig().shift?.autoMaxSeconds ?? 60);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Re-balance one channel-day. Never touches a day with an exported block (that
 * day is on the playout Mac) or a boundary the operator moved by hand. Auto
 * shifts are recomputed from scratch, so calling this twice is a no-op.
 * `rebuild` lets it re-fill a DRAFT whose window cannot move (generation only).
 * Returns { shifted, rebuilt, skipped? }.
 */
export function balanceDay(channelId, targetDate, { rebuild = false } = {}) {
  const autoMax = autoShiftMaxSeconds();
  if (!autoMax) return { shifted: 0, rebuilt: 0, skipped: 'disabled' };
  const ids = channelDayBlocks(channelId, targetDate);
  if (!ids.length) return { shifted: 0, rebuilt: 0 };
  if (ids.some((b) => b.status === 'exported')) return { shifted: 0, rebuilt: 0, skipped: 'exported' };

  const setShift = db.prepare('UPDATE ScheduledBlock SET end_shift_seconds = ?, end_shift_auto = ? WHERE id = ?');
  for (const b of ids) if (Number(b.end_shift_auto)) setShift.run(0, 0, b.id);

  const tol = fitTolerance();
  const maxShift = maxShiftSeconds();
  const rebuiltIds = new Set();
  const closedIds = new Set();
  let shifted = 0;
  // Each step changes one boundary and re-reads the day; the walk only moves
  // forward (a shift changes the NEXT block's window, never an earlier one), so
  // it ends within a pass per block plus one per rebuild.
  for (let guard = 0; guard < ids.length * 3 + 5; guard++) {
    const rows = linkShifts(channelDayBlocks(channelId, targetDate));
    let changed = false;
    for (const r of rows) {
      const total = blockTotalSeconds(r.id);
      if (!total) continue; // nothing scheduled: nothing to balance against
      const diff = r.blockSeconds - total; // >0 short, <0 long
      if (diff === 0) continue;
      const manual = !Number(r.end_shift_auto) && r.end_shift !== 0;
      if (r.next_block_id && !manual && Math.abs(diff) <= autoMax) {
        const shift = r.end_shift - diff;
        const next = rows.find((x) => x.id === r.next_block_id);
        if (Math.abs(shift) <= maxShift && next && next.blockSeconds + diff >= 60 && r.blockSeconds - diff >= 60) {
          setShift.run(shift, 1, r.id);
          shifted++;
          changed = true;
          break;
        }
      }
      // A window that cannot move (the end of the day), or a residue too big to
      // move: close it with fillers — top up a short block, or swap one filler
      // for shorter ones in a long one. Main content is never touched, and only
      // once per block; whatever is left (≤ autoMax) then moves the boundary.
      if ((!r.next_block_id || Math.abs(diff) > autoMax) && !fitsTolerance(diff, tol)
          && Math.abs(diff) <= maxShift && !closedIds.has(r.id)) {
        closedIds.add(r.id);
        if (closeWithFillers(r.id, channelId, diff)) { changed = true; break; }
        // Its own fillers can't close it (none short enough, none to swap):
        // propagate BACKWARD — move the boundary before it by the residue and let
        // the previous block close that instead. Kept only if it then fits.
        const prev = r.prev_block_id && rows.find((x) => x.id === r.prev_block_id);
        if (prev && prev.status !== 'exported' && !( !Number(prev.end_shift_auto) && prev.end_shift !== 0)
            && Math.abs(prev.end_shift + diff) <= maxShift && r.blockSeconds - diff >= 60) {
          db.exec('SAVEPOINT back_shift');
          setShift.run(prev.end_shift + diff, 1, prev.id);
          const pDiff = prev.blockSeconds + diff - blockTotalSeconds(prev.id);
          const closed = fitsTolerance(pDiff, tol) || closeWithFillers(prev.id, channelId, pDiff);
          const after = linkShifts(channelDayBlocks(channelId, targetDate));
          const pv = after.find((x) => x.id === prev.id);
          const rv = after.find((x) => x.id === r.id);
          if (closed && fitsTolerance(pv.blockSeconds - blockTotalSeconds(prev.id), tol)
              && fitsTolerance(rv.blockSeconds - blockTotalSeconds(r.id), tol)) {
            db.exec('RELEASE back_shift');
            closedIds.add(prev.id);
            shifted++;
            changed = true;
            break;
          }
          db.exec('ROLLBACK TO back_shift');
          db.exec('RELEASE back_shift');
        }
      }
      // Still out: a draft is rebuilt to its window, once — only when the caller
      // is generating (never over an operator's hand edit).
      if (rebuild && !r.next_block_id && r.status === 'draft' && !fitsTolerance(diff, tol) && !rebuiltIds.has(r.id)) {
        rebuiltIds.add(r.id);
        populateBlock(db.prepare('SELECT * FROM ScheduledBlock WHERE id = ?').get(r.id));
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  if (shifted || rebuiltIds.size || closedIds.size) {
    l.info(`balanced channel ${channelId} ${targetDate}: ${shifted} boundary shift(s), `
      + `${closedIds.size} filler close(s), ${rebuiltIds.size} rebuild(s)`);
  }
  return { shifted, closed: closedIds.size, rebuilt: rebuiltIds.size };
}

/**
 * Bring a block whose end cannot move onto its window by touching fillers only.
 * `diff` is window - content: positive = short (append fillers for it), negative
 * = long (drop the shortest filler that covers the excess, then top up what that
 * opens). Mirrors are left alone (they copy their primary). Returns true when it
 * changed anything.
 */
function closeWithFillers(blockId, channelId, diff) {
  const isMirror = db.prepare(`
    SELECT COALESCE(s.slot_order, 0) AS o FROM ScheduledBlock sb
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id WHERE sb.id = ?`).get(blockId)?.o > 0;
  if (isMirror && diff < 0) return false;
  const ins = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, 0)'
  );
  const nextOrder = () => db.prepare(
    'SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ScheduleItem WHERE block_id = ?'
  ).get(blockId).n;
  let hole = diff;
  if (diff < 0) {
    const victim = db.prepare(`
      SELECT si.id, r.duration FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id
      WHERE si.block_id = ? AND r.is_filler = 1 AND si.is_manual_override = 0 AND r.duration >= ?
      ORDER BY r.duration ASC, si.play_order DESC LIMIT 1`).get(blockId, -diff);
    if (!victim) return false;
    db.prepare('DELETE FROM ScheduleItem WHERE id = ?').run(victim.id);
    hole = victim.duration + diff;
  }
  if (hole > 0) {
    const tol = fitTolerance();
    let { items, total } = fitFillers(channelId, hole);
    // Nothing in the pool is short enough for a small hole: give one filler
    // back and re-pack it together with the hole instead.
    if (diff > 0 && !fitsTolerance(hole - total, tol)) {
      const swaps = db.prepare(`
        SELECT si.id, MIN(r.duration) AS duration FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id
        WHERE si.block_id = ? AND r.is_filler = 1 AND si.is_manual_override = 0
        GROUP BY r.duration ORDER BY r.duration LIMIT 12`).all(blockId);
      for (const sw of swaps) {
        const fit = fitFillers(channelId, sw.duration + hole);
        if (fit.items.length && fitsTolerance(sw.duration + hole - fit.total, tol)) {
          db.prepare('DELETE FROM ScheduleItem WHERE id = ?').run(sw.id);
          ({ items, total } = fit);
          break;
        }
      }
    }
    if (!items.length) return diff < 0; // a dropped filler is still a change
    let order = nextOrder();
    for (const r of items) ins.run(blockId, r.id, order++);
  }
  return true;
}
