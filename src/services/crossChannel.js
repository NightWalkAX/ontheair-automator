// Rules ACROSS channels (decided with the operator 2026-10-21).
//
//   1. A film airs on ONE channel within a day either side: the same file may
//      not air on any other channel that day, the day before or the day after
//      (`schedule.crossChannel.movieDays`, default 1; 0 turns it off).
//   2. A series airs on ONE channel at a time: the same show (subject) may not
//      be in two blocks of different channels whose windows overlap, whatever
//      the episode (`schedule.crossChannel.series`, default true). TV shows,
//      documentaries and lessons alike — films are covered by rule 1.
//      Windows that only TOUCH don't count, and neither does an overlap of up
//      to `schedule.crossChannel.graceSeconds` (default 60): balanceDay moves a
//      boundary by up to shift.autoMaxSeconds, so a block that ends at 10:00 on
//      one channel and one that starts at 10:00 on another routinely share a
//      few seconds — that is not two channels airing a show at once.
//
// The analog channel counts as a channel like any other (it shares the
// catalogue). A shared template is no exception either: each channel that airs
// it gets content of its own.
//
// Identity is the FILE for a film and the SUBJECT for a series, never the
// Resource id: each channel has its own Resource row for the same file, and the
// catalogue keeps the subject identical on every channel (catalogSync.js).
//
// "Overlap" is judged on BLOCK windows — the shifted, gap-extended window the
// block airs in (linkShifts) — not on clip times: a clip's clock time moves with
// every filler and boundary shift, and the generator has to decide before any
// of that is known. Conservative, and the generator and the validator agree.
//
// The generator avoids both (first come, first served: whichever block is built
// later picks something else); validateBlock() reports what an edit left, and
// such a block is red like any other rule — refused by approve and push unless
// forced.

import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { addDays } from '../dates.js';
import { MOVIES_CODE, channelDayBlocks, linkShifts } from './scheduling.js';

const DAY = 86400;
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const hhmm = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60;
};

/** { movieDays, series, graceSeconds } from config, with the defaults the operator chose. */
export function crossChannelRules() {
  const c = loadConfig().schedule?.crossChannel ?? {};
  const days = Number(c.movieDays ?? 1);
  const grace = Number(c.graceSeconds ?? 60);
  return {
    movieDays: Number.isFinite(days) && days > 0 ? Math.floor(days) : 0,
    series: c.series !== false,
    graceSeconds: Number.isFinite(grace) && grace > 0 ? grace : 0,
  };
}

/** Do two { start, end } windows share more than `grace` seconds? */
export const windowsOverlap = (a, b, grace = 0) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > grace;

/**
 * Absolute air window of every block of one channel-day, as a Map of block id →
 * { start, end } in seconds since the epoch day 0. `cache` (a Map) keeps each
 * channel-day's computation for callers judging many blocks.
 */
export function dayWindows(channelId, date, cache = null) {
  const k = `${channelId}|${date}`;
  if (cache?.has(k)) return cache.get(k);
  const out = new Map();
  for (const r of linkShifts(channelDayBlocks(channelId, date))) {
    const start = dayNumber(r.target_date) * DAY + hhmm(r.start_time) + r.start_shift;
    out.set(r.id, { start, end: start + r.blockSeconds, effective_start: r.effective_start, effective_end: r.effective_end });
  }
  cache?.set(k, out);
  return out;
}

/** Window of one block, or null. */
export function blockWindow(blockId, channelId, date, cache = null) {
  return dayWindows(channelId, date, cache).get(blockId) ?? null;
}

/**
 * The windows a primary's content will air in: its own and every repeat of the
 * same template on that channel and date (they mirror it clip for clip).
 */
export function airingWindows(block, channelId, cache = null) {
  if (!block?.id || channelId == null || !block.target_date) return [];
  const ids = block.template_id == null ? [] : db.prepare(`
    SELECT id FROM ScheduledBlock
    WHERE template_id = ? AND target_date = ? AND COALESCE(channel_id, ?) = ?
  `).all(block.template_id, block.target_date, channelId, channelId).map((r) => r.id);
  if (!ids.includes(block.id)) ids.push(block.id);
  const day = dayWindows(channelId, block.target_date, cache);
  return ids.map((id) => day.get(id)).filter(Boolean);
}

const hitCols = `
  sb.id AS block_id, sb.target_date, COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
  c.name AS channel_name, bt.name AS template_name`;
const hitJoins = `
  FROM ScheduleItem si
  JOIN ScheduledBlock sb ON sb.id = si.block_id
  JOIN BlockTemplate bt ON bt.id = sb.template_id
  JOIN ChannelType c ON c.id = COALESCE(sb.channel_id, bt.channel_id)
  JOIN Resource r ON r.id = si.resource_id
  LEFT JOIN ShowType st ON st.id = r.show_type_id`;

const inList = (col, list) => `${col} IN (${list.map(() => '?').join(',')})`;

/**
 * Films other channels air within `movieDays` of `date`: Map file_path → the
 * first block that airs it. `files` narrows the search to those paths (a gate
 * that only needs a verdict); omit it for the whole set (generation, the modal).
 */
export function busyFiles(channelId, date, { files = null } = {}) {
  const { movieDays } = crossChannelRules();
  const out = new Map();
  if (!movieDays || !date || (files && !files.length)) return out;
  const params = [addDays(date, -movieDays), addDays(date, movieDays), channelId ?? -1];
  let extra = '';
  if (files) { extra = `AND ${inList('r.file_path', files)}`; params.push(...files); }
  for (const h of db.prepare(`
    SELECT DISTINCT r.file_path, r.name, ${hitCols} ${hitJoins}
    WHERE sb.target_date BETWEEN ? AND ? AND COALESCE(sb.channel_id, bt.channel_id) != ?
      AND r.is_filler = 0 AND st.code = '${MOVIES_CODE}' ${extra}
    ORDER BY sb.target_date, c.name
  `).all(...params)) {
    if (!out.has(h.file_path)) out.set(h.file_path, { kind: 'movie', ...h });
  }
  return out;
}

/**
 * Series other channels air in a block overlapping any of `windows`: Map
 * subject → the first such block, with its window. `subjects` narrows it.
 */
export function busySubjects(channelId, date, windows, { subjects = null, cache = null } = {}) {
  const out = new Map();
  const { series, graceSeconds } = crossChannelRules();
  if (!series || !date || !windows?.length || (subjects && !subjects.length)) return out;
  // A window can run past midnight (a night block owns the gap to the morning),
  // so the day before and after can overlap too.
  const params = [addDays(date, -1), addDays(date, 1), channelId ?? -1];
  let extra = '';
  if (subjects) { extra = `AND ${inList('r.subject', subjects)}`; params.push(...subjects); }
  const rows = db.prepare(`
    SELECT DISTINCT r.subject, ${hitCols} ${hitJoins}
    WHERE sb.target_date BETWEEN ? AND ? AND COALESCE(sb.channel_id, bt.channel_id) != ?
      AND r.is_filler = 0 AND r.subject IS NOT NULL AND COALESCE(st.code, '') != '${MOVIES_CODE}' ${extra}
    ORDER BY sb.target_date, c.name
  `).all(...params);
  for (const h of rows) {
    if (out.has(h.subject)) continue;
    const w = blockWindow(h.block_id, h.channel_id, h.target_date, cache);
    if (!w) continue;
    if (windows.some((x) => windowsOverlap(x, w, graceSeconds))) {
      out.set(h.subject, { kind: 'series', ...h, start: w.effective_start, end: w.effective_end });
    }
  }
  return out;
}

/** Is this a film (show type Movies)? Takes a row with show_type_code or show_type_id. */
let moviesTypeId;
export function isMovie(r) {
  if (r.show_type_code !== undefined) return r.show_type_code === MOVIES_CODE;
  if (moviesTypeId === undefined) {
    moviesTypeId = db.prepare('SELECT id FROM ShowType WHERE code = ?').get(MOVIES_CODE)?.id ?? null;
  }
  return r.show_type_id != null && r.show_type_id === moviesTypeId;
}

/**
 * Everything a block on `channelId` must not air because another channel does,
 * for the generator: `{ files, subjects, blocks(r) }` where `blocks(r)` returns
 * the clash a resource would cause (or null).
 */
export function crossBusy(block, channelId, { cache = null } = {}) {
  const date = block?.target_date;
  const files = busyFiles(channelId, date);
  const subjects = busySubjects(channelId, date, airingWindows(block, channelId, cache), { cache });
  return {
    files,
    subjects,
    blocks: (r) => (Number(r.is_filler) ? null
      : isMovie(r) ? files.get(r.file_path) ?? null
      : (r.subject != null ? subjects.get(r.subject) ?? null : null)),
  };
}

/**
 * Clashes of one block's items against the other channels, for validateBlock():
 * `[{ item_id, resource_id, kind, key, name, other: { block_id, channel_name,
 * target_date, template_name, start?, end? } }]`. With `full`, also returns the
 * whole busy set so the block editor can judge an unsaved edit live.
 */
export function blockCrossConflicts(block, items, { cache = null, full = false } = {}) {
  const channelId = block.channel_id;
  const main = items.filter((i) => !Number(i.is_filler));
  const films = [...new Set(main.filter(isMovie).map((i) => i.file_path).filter(Boolean))];
  const shows = [...new Set(main.filter((i) => !isMovie(i)).map((i) => i.subject).filter((s) => s != null))];
  const win = blockWindow(block.id, channelId, block.target_date, cache);
  const files = busyFiles(channelId, block.target_date, full ? {} : { files: films });
  const subjects = win
    ? busySubjects(channelId, block.target_date, [win], full ? { cache } : { subjects: shows, cache })
    : new Map();
  const conflicts = [];
  for (const i of main) {
    const hit = isMovie(i) ? files.get(i.file_path) : subjects.get(i.subject);
    if (!hit) continue;
    conflicts.push({
      item_id: i.id, resource_id: i.resource_id, kind: hit.kind,
      key: hit.kind === 'movie' ? i.file_path : i.subject,
      name: hit.kind === 'movie' ? (i.label || i.name) : i.subject,
      other: {
        block_id: hit.block_id, channel_id: hit.channel_id, channel_name: hit.channel_name,
        target_date: hit.target_date, template_name: hit.template_name,
        start: hit.start ?? null, end: hit.end ?? null,
      },
    });
  }
  if (!full) return { conflicts };
  const plain = (m) => Object.fromEntries([...m].map(([k, h]) => [k, {
    channel_name: h.channel_name, target_date: h.target_date, template_name: h.template_name,
    start: h.start ?? null, end: h.end ?? null,
  }]));
  return { conflicts, busy: { files: plain(files), subjects: plain(subjects) } };
}

/** One operator-readable line for a list of clashes (null when there are none). */
export function crossProblem(conflicts) {
  if (!conflicts?.length) return null;
  const c = conflicts[0];
  const more = conflicts.length > 1 ? ` (+${conflicts.length - 1} more)` : '';
  return c.kind === 'movie'
    ? `airs the film "${c.name}", which ${c.other.channel_name} airs on ${c.other.target_date}${more}`
    : `airs "${c.name}" while ${c.other.channel_name} airs it (${c.other.target_date} ${String(c.other.start).slice(0, 5)}–${String(c.other.end).slice(0, 5)})${more}`;
}

/**
 * How many clashing clips each block of a range holds, for the week grid: one
 * pass over the range ±1 day instead of a validation per block. Map block id →
 * count. `blockIds` limits the result (the grid shows one channel at a time);
 * the index always spans every channel, since that is what a clash is against.
 */
export function crossConflictCounts(from, to, { blockIds = null } = {}) {
  const { movieDays, series, graceSeconds } = crossChannelRules();
  const out = new Map();
  if (!movieDays && !series) return out;
  const span = Math.max(movieDays, 1);
  const rows = db.prepare(`
    SELECT si.id AS item_id, r.file_path, r.subject, COALESCE(st.code, '') = '${MOVIES_CODE}' AS movie,
           ${hitCols} ${hitJoins}
    WHERE sb.target_date BETWEEN ? AND ? AND r.is_filler = 0
  `).all(addDays(from, -span), addDays(to, span));
  const cache = new Map();
  const want = blockIds ? new Set(blockIds) : null;
  const inRange = (d) => d >= from && d <= to;

  const byFile = new Map();
  const bySubject = new Map();
  for (const r of rows) {
    if (r.movie) {
      if (!movieDays || !r.file_path) continue;
      if (!byFile.has(r.file_path)) byFile.set(r.file_path, []);
      byFile.get(r.file_path).push(r);
    } else if (series && r.subject != null) {
      const w = blockWindow(r.block_id, r.channel_id, r.target_date, cache);
      if (!w) continue;
      r.start = w.start; r.end = w.end;
      if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
      bySubject.get(r.subject).push(r);
    }
  }
  const flag = (r) => {
    if (!inRange(r.target_date) || (want && !want.has(r.block_id))) return;
    out.set(r.block_id, (out.get(r.block_id) || 0) + 1);
  };
  for (const list of byFile.values()) {
    for (const r of list) {
      const d = dayNumber(r.target_date);
      if (list.some((o) => o.channel_id !== r.channel_id && Math.abs(dayNumber(o.target_date) - d) <= movieDays)) flag(r);
    }
  }
  for (const list of bySubject.values()) {
    for (const r of list) {
      if (list.some((o) => o.channel_id !== r.channel_id && windowsOverlap(o, r, graceSeconds))) flag(r);
    }
  }
  return out;
}
