// Module A — the auto-generation engine.
//
// Turns active BlockTemplates into draft ScheduledBlocks for the coming week
// (across every weekday the template runs and every time slot it airs at),
// populates each primary airing by cycling its assigned series chapter-by-chapter
// and packing fillers to hit the slot's exact duration, then strict-mirrors that
// content into the template's secondary airings.

import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { nextChapter, randomWithCooldown, latestEpisode } from './playHistory.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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
  if (!series.length) return [];

  const iters = series.map((s) => iteratorForSeries(s, channelId, block, blockSecs));
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
 * `pack(target)` runs an unbounded knapsack over integer-second durations —
 * fillers MAY repeat, which lets a small/coarse pool fill a gap to the second —
 * and returns { items, total } for the LARGEST reachable total <= target (0s
 * overrun ceiling), preferring fewer/longer fillers. The LRU rotation cursor is
 * SHARED across successive pack() calls, so filling several gaps in one block
 * spreads repeats over the whole pool instead of hammering one clip per gap.
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
  const cursor = new Map(); // duration -> LRU rotation offset, shared across pack() calls

  function pack(target) {
    if (target <= 0 || !fillers.length) return { items: [], total: 0 };
    const durations = allDurations.filter((d) => d <= target);
    if (!durations.length) return { items: [], total: 0 };

    // reach[t] = t seconds is exactly composable; fromDur[t] records a duration
    // used to reach t, preferring the LARGEST that fits (fewer, longer fillers).
    const reach = new Array(target + 1).fill(false);
    const fromDur = new Array(target + 1).fill(0);
    reach[0] = true;
    for (let t = 1; t <= target; t++) {
      for (let k = durations.length - 1; k >= 0; k--) {
        const d = durations[k];
        if (d <= t && reach[t - d]) { reach[t] = true; fromDur[t] = d; break; }
      }
    }
    let best = 0;
    for (let t = target; t >= 0; t--) { if (reach[t]) { best = t; break; } }

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

  return { pack, hasFillers: fillers.length > 0 };
}

/**
 * Filler packer (single-shot). Choose fillers whose total duration is as close
 * to `remaining` as possible without exceeding it, within maxUnderrun.
 * Returns { items, total, fits }.
 */
export function fitFillers(channelId, remaining) {
  const maxUnderrun = loadConfig().filler?.maxUnderrunSeconds ?? 5;
  const packer = makeFillerPacker(channelId);
  if (remaining <= 0) return { items: [], total: 0, fits: remaining >= -maxUnderrun };
  if (!packer.hasFillers) return { items: [], total: 0, fits: remaining <= maxUnderrun };
  const { items, total } = packer.pack(remaining);
  return { items, total, fits: remaining - total <= maxUnderrun };
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
 * fill, so the block-level 0s-overrun / maxUnderrun tolerance still holds.
 *
 * Returns { items, total } — the ordered resource sequence and its duration.
 */
export function buildAlignedBlock(template, block, blockSecs, startSecs, channelId, packer) {
  const series = templateSeries(template, channelId);
  const iters = series.map((s) => iteratorForSeries(s, channelId, block, blockSecs));

  // max_per_show caps how many episodes one series may contribute to a block
  // (NULL/0 = unlimited). Tracked per iterator so a series drops out of the
  // cycle once it hits its cap, leaving room for the others (or fillers).
  const maxPerShow = Number(template.max_per_show) > 0 ? Number(template.max_per_show) : Infinity;

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
  const trailing = blockSecs - total;
  if (trailing > 0) {
    const fill = packer.pack(trailing);
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
    const maxUnderrun = loadConfig().filler?.maxUnderrunSeconds ?? 5;
    const underrun = blockSecs - total;
    return { blockId: block.id, blockSeconds: blockSecs, mainCount: count, fillerCount: 0, underrun, fits: underrun >= 0 && underrun <= maxUnderrun, mirrored: true };
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
  const maxUnderrun = loadConfig().filler?.maxUnderrunSeconds ?? 5;
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
    fits: underrun >= 0 && underrun <= maxUnderrun,
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
