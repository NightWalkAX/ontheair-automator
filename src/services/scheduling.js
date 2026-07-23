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
  if (showCode === 'tv_shows') return 'tv';   // Sunday latest / weekday cooldown
  if (isSerial) return 'serial';              // sequential chapter progression
  return 'cooldown';                          // random movie/documentary pick
}

/**
 * Non-filler candidate resources for a block's channel, optionally by subject
 * and capped at maxDuration so a single main item can never overrun the slot.
 */
function candidates(channelId, subject, maxDuration) {
  const clauses = ['channel_id = ?', 'is_filler = 0'];
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
    'SELECT * FROM Resource WHERE channel_id = ? AND subject = ? AND is_filler = 0 ORDER BY chapter ASC, id ASC'
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
 * Filler packer. Given `remaining` seconds to fill, choose fillers whose total
 * duration is as close to `remaining` as possible WITHOUT exceeding it, and not
 * more than maxUnderrun below it.
 *
 * Unbounded knapsack over integer-second durations — fillers MAY repeat, which
 * is what lets a small/coarse filler pool still fill a block to the second
 * (the previous subset-sum packer left large underruns when it ran out of
 * distinct fillers). "Repeat heat": among fillers of the same duration we hand
 * out the least-recently-used first (Resource.last_used_at, stamped on approval),
 * so repeats spread across the pool instead of hammering one clip.
 *
 * Returns { items, total, fits }.
 */
export function fitFillers(channelId, remaining) {
  const cfg = loadConfig().filler || {};
  const maxUnderrun = cfg.maxUnderrunSeconds ?? 5;

  const fillers = db.prepare(
    'SELECT * FROM Resource WHERE channel_id = ? AND is_filler = 1'
  ).all(channelId);

  if (remaining <= 0) {
    return { items: [], total: 0, fits: remaining >= -maxUnderrun };
  }
  if (!fillers.length) {
    return { items: [], total: 0, fits: remaining <= maxUnderrun };
  }

  // Distinct usable durations, ascending.
  const durations = [...new Set(fillers.map((f) => f.duration))]
    .filter((d) => d > 0 && d <= remaining)
    .sort((a, b) => a - b);

  // Unbounded knapsack: reach[t] = t seconds is exactly composable from fillers.
  // fromDur[t] records a duration used to reach t, preferring the LARGEST that
  // fits so we favour fewer, longer fillers over many tiny ones.
  const reach = new Array(remaining + 1).fill(false);
  const fromDur = new Array(remaining + 1).fill(0);
  reach[0] = true;
  for (let t = 1; t <= remaining; t++) {
    for (let k = durations.length - 1; k >= 0; k--) {
      const d = durations[k];
      if (d <= t && reach[t - d]) { reach[t] = true; fromDur[t] = d; break; }
    }
  }

  // Largest reachable total <= remaining (0s overrun ceiling).
  let best = 0;
  for (let t = remaining; t >= 0; t--) {
    if (reach[t]) { best = t; break; }
  }

  // Group fillers by duration, each ordered least-recently-used first so repeats
  // are handed out round-robin across distinct clips of the same length.
  const byDur = new Map();
  for (const f of fillers) {
    if (!byDur.has(f.duration)) byDur.set(f.duration, []);
    byDur.get(f.duration).push(f);
  }
  for (const arr of byDur.values()) {
    arr.sort((a, b) => String(a.last_used_at || '').localeCompare(String(b.last_used_at || '')));
  }

  // Reconstruct the duration sequence, then assign concrete filler rows,
  // rotating within each duration's LRU-ordered group.
  const durSeq = [];
  for (let t = best; t > 0; t -= fromDur[t]) durSeq.push(fromDur[t]);
  const cursor = new Map();
  const items = durSeq.map((d) => {
    const arr = byDur.get(d);
    const i = (cursor.get(d) || 0) % arr.length;
    cursor.set(d, (cursor.get(d) || 0) + 1);
    return arr[i];
  }).reverse();

  const underrun = remaining - best;
  return { items, total: best, fits: underrun <= maxUnderrun };
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

  const main = kept.length ? [] : pickMainContent(template, block, blockSecs);
  const mainSecs = main.reduce((s, r) => s + r.duration, 0);

  const remaining = blockSecs - keptSecs - mainSecs;
  const { items: fillers, total: fillerSecs, fits } = fitFillers(channelId, remaining);

  const insert = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, 0)'
  );
  let order = kept.length;
  for (const r of main) insert.run(block.id, r.id, order++);
  for (const r of fillers) insert.run(block.id, r.id, order++);

  // Keep secondary airings identical to what we just built (same channel).
  resyncMirrors(template.id, block.target_date, channelId, block.id);

  const underrun = blockSecs - (keptSecs + mainSecs + fillerSecs);
  return {
    blockId: block.id,
    blockSeconds: blockSecs,
    mainCount: main.length,
    fillerCount: fillers.length,
    underrun,
    fits,
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
 * Generate a full week: roll forward templates, then populate each block.
 * Pass a channelId to restrict generation to a single channel (per-channel tab).
 */
export function generateWeek(weekStart = new Date(), channelId = null) {
  const blocks = rollForwardTemplates(weekStart, channelId);
  return blocks.map((b) => populateBlock(b)).filter(Boolean);
}
