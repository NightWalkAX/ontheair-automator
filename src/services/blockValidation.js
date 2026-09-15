// One validation rule set for a scheduled block, shared by the review API, the
// week grid, the approval gate and the OTAV push.
//
// A block FITS when all three hold:
//   1. its duration lands inside the fit tolerance (see fitTolerance),
//   2. no unbroken run of fillers is longer than fillerRunLimit(), and
//   3. a movie block holds nothing but movies.
// Anything else is red in the UI, refused by POST /approve, and refused by the
// push — the operator adds or removes content until it passes.
//
// Except that some blocks have no solution: a three-hour documentary slot whose
// every remaining episode runs 50 minutes leaves a 30-minute hole no clip in the
// catalogue can fill, and no amount of editing changes that. So a block carries
// an OVERRIDE — `ScheduledBlock.override_reason`, set by the operator from the
// modal — and `approvable` is what the approval and push gates ask about:
// `fits || overridden`. `fits` keeps meaning "passes the rules", so a forced
// block never reads as a healthy one anywhere in the UI.

import { db } from '../db.js';
import {
  MOVIES_CODE, blockDurationSeconds, fillerRunLimit, fitTolerance, fitsTolerance,
  maxFillerRunSeconds,
} from './scheduling.js';
import { EPISODE_NO_CTE, withLabel } from './labels.js';

/** The non-filler items of a movie block whose show type is not Movies. */
export function offTypeItems(block, items) {
  if (!Number(block?.is_movie_block)) return [];
  return items.filter((i) => !Number(i.is_filler) && i.show_type_code !== MOVIES_CODE);
}

/**
 * Full validation of one block: its row, its labelled items and every number the
 * UI shows. Returns null when the block is gone.
 */
export function validateBlock(blockId) {
  const block = db.prepare(`
    SELECT sb.*,
           COALESCE(s.start_time, bt.start_time) AS start_time,
           COALESCE(s.end_time, bt.end_time)     AS end_time,
           s.slot_order AS slot_order,
           bt.name AS template_name,
           bt.id AS template_id,
           bt.max_per_show AS max_per_show,
           bt.is_movie_block AS is_movie_block,
           bt.movie_limit AS movie_limit,
           COALESCE(sb.channel_id, bt.channel_id) AS channel_id
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.id = ?
  `).get(blockId);
  if (!block) return null;

  // Items carry season/episode_no so the UI can name them "Show · S01E02"
  // instead of exposing the internal `chapter` ordering key.
  const items = db.prepare(`
    WITH ${EPISODE_NO_CTE}
    SELECT si.*, r.name, r.duration, r.is_filler, r.subject, r.season, r.chapter,
           en.episode_no, ov.display_name AS display_name, st.code AS show_type_code
    FROM ScheduleItem si
    JOIN Resource r ON r.id = si.resource_id
    LEFT JOIN EpisodeNo en ON en.id = r.id
    LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
    LEFT JOIN ShowType st ON st.id = r.show_type_id
    WHERE si.block_id = ? ORDER BY si.play_order
  `).all(blockId).map(withLabel);

  const blockSeconds = blockDurationSeconds(block.start_time, block.end_time);
  const totalSeconds = items.reduce((s, i) => s + i.duration, 0);
  const diff = blockSeconds - totalSeconds; // >0 underrun, <0 overrun
  const { maxUnderrun, maxOverrun } = fitTolerance();

  const overrun = diff < 0;
  const durationFits = fitsTolerance(diff, { maxUnderrun, maxOverrun });

  const maxFillerRun = fillerRunLimit();
  const fillerRun = maxFillerRunSeconds(items);
  const fillerFits = fillerRun <= maxFillerRun;

  const offType = offTypeItems(block, items);
  const fits = durationFits && fillerFits && offType.length === 0;
  const overridden = !!block.override_reason;

  return {
    block, items, blockSeconds, totalSeconds, diff, overrun, maxUnderrun, maxOverrun,
    durationFits, fillerRun, maxFillerRun, fillerFits,
    offTypeIds: offType.map((i) => i.id),
    typeFits: offType.length === 0,
    fits,
    overridden,
    overrideReason: block.override_reason ?? null,
    overrideAt: block.override_at ?? null,
    approvable: fits || overridden,
  };
}

/**
 * Why a block does not pass the rules, as one operator-readable line (null when
 * it does). Reports the problem even for an overridden block — that line is what
 * the override records — so callers that care about approval ask `approvable`.
 */
export function blockProblem(v) {
  if (!v) return 'block not found';
  const mmss = (s) => `${Math.floor(Math.abs(s) / 60)}:${String(Math.abs(s) % 60).padStart(2, '0')}`;
  if (!v.durationFits) {
    return v.overrun
      ? `runs ${mmss(v.diff)} past the end of the slot`
      : `is ${mmss(v.diff)} short of the slot`;
  }
  if (!v.fillerFits) return `has ${mmss(v.fillerRun)} of filler back to back (max ${mmss(v.maxFillerRun)})`;
  if (!v.typeFits) return `is a movie block holding ${v.offTypeIds.length} clip(s) that are not movies`;
  return null;
}

/**
 * Every block in a date range that the push must refuse, as
 * `[{ id, target_date, template_name, reason }]`.
 *
 * The push is the last gate before air, and a block can stop passing after it
 * was approved (an operator edit, a changed cap, a clip re-typed by a re-scan),
 * so the range is re-validated rather than trusted for its status. One
 * validateBlock() per block is heavy for a week grid — it is nothing next to a
 * push, which is thousands of sequential REST calls.
 */
export function unfitBlocksInRange(from, to, channelIds = []) {
  const clauses = ["sb.status IN ('approved', 'exported')", 'sb.target_date BETWEEN ? AND ?'];
  const params = [from, to];
  if (channelIds.length) {
    clauses.push(`COALESCE(sb.channel_id, bt.channel_id) IN (${channelIds.map(() => '?').join(',')})`);
    params.push(...channelIds);
  }
  const rows = db.prepare(`
    SELECT sb.id, sb.target_date, bt.name AS template_name
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY sb.target_date, bt.name
  `).all(...params);

  const bad = [];
  for (const r of rows) {
    const v = validateBlock(r.id);
    // An overridden block goes to air: the operator has already looked at this
    // exact problem and decided it is the best the catalogue can do.
    if (v && !v.approvable) bad.push({ ...r, reason: blockProblem(v) });
  }
  return bad;
}
