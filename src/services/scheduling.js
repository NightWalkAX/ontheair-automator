// Module A — the auto-generation engine.
//
// Turns active BlockTemplates into draft ScheduledBlocks for the coming week,
// populates each with main content per its content_type, then packs fillers to
// hit the block's exact duration (0s overrun ceiling, 5s underrun floor).

import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { nextSequential, randomWithCooldown, latestEpisode } from './playHistory.js';

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

/**
 * Instantiate active templates as draft ScheduledBlocks for the next 7 days
 * (starting `weekStart`). Idempotent: the UNIQUE(template_id, target_date)
 * constraint means re-running won't duplicate blocks.
 * Returns the list of ScheduledBlock ids that now exist for the window.
 */
export function rollForwardTemplates(weekStart = new Date()) {
  const templates = db.prepare(`
    SELECT bt.* FROM BlockTemplate bt
    JOIN ChannelType c ON c.id = bt.channel_id
    WHERE c.is_active = 1
  `).all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ScheduledBlock (template_id, target_date, status)
    VALUES (?, ?, 'draft')
  `);

  const created = [];
  for (let i = 0; i < 7; i++) {
    const target = dateStr(i, weekStart);
    const weekday = WEEKDAYS[new Date(target + 'T00:00:00').getDay()];
    for (const t of templates) {
      if (t.weekday !== weekday) continue;
      insert.run(t.id, target);
      const block = db.prepare(
        'SELECT * FROM ScheduledBlock WHERE template_id = ? AND target_date = ?'
      ).get(t.id, target);
      created.push(block);
    }
  }
  return created;
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

/**
 * Choose the main content for a block, per its content_type. `blockSecs` caps
 * main-item length so cooldown/random picks can't exceed the slot. Returns an
 * array of Resource rows (usually one main item; fillers top up the rest).
 */
export function pickMainContent(template, block, blockSecs) {
  const { channel_id, content_type, target_subject } = template;
  // Resource scoping is by the TEXT subject label carried on the template.
  // Null means "any resource on this channel".
  const subject = target_subject || null;

  switch (content_type) {
    case 'lesson_series': {
      // Sequential progression is authoritative even if a lesson slightly
      // exceeds the slot; the admin resolves genuine overruns in the UI.
      const next = nextSequential(channel_id, subject);
      return next ? [next] : [];
    }
    case 'tv_episode': {
      const weekday = WEEKDAYS[new Date(block.target_date + 'T00:00:00').getDay()];
      if (weekday === 'Sun') {
        const ep = latestEpisode(channel_id, subject);
        return ep ? [ep] : [];
      }
      // Weekday 18:00 slots behave like cooldown movie fillers.
      const pick = randomWithCooldown(channel_id, candidates(channel_id, subject, blockSecs), block.target_date);
      return pick ? [pick] : [];
    }
    case 'movie':
    default: {
      const pick = randomWithCooldown(channel_id, candidates(channel_id, subject, blockSecs), block.target_date);
      return pick ? [pick] : [];
    }
  }
}

/**
 * Filler knapsack. Given `remaining` seconds to fill and available filler
 * resources, choose a subset whose total duration is as close to `remaining`
 * as possible WITHOUT exceeding it, and not more than maxUnderrun below it.
 *
 * Bounded subset-sum DP over integer seconds. Returns { items, total, fits }.
 */
export function fitFillers(channelId, remaining) {
  const cfg = loadConfig().filler || {};
  const maxUnderrun = cfg.maxUnderrunSeconds ?? 5;

  const fillers = db.prepare(
    'SELECT * FROM Resource WHERE channel_id = ? AND is_filler = 1 ORDER BY duration DESC'
  ).all(channelId);

  if (remaining <= 0) {
    return { items: [], total: 0, fits: remaining >= -maxUnderrun };
  }

  // DP: best[t] = index list achieving total t (t from 0..remaining).
  // Track reachable sums with backpointers; cap at `remaining` (0s overrun).
  const reach = new Array(remaining + 1).fill(false);
  const from = new Array(remaining + 1).fill(-1); // filler index used to reach t
  const prev = new Array(remaining + 1).fill(-1); // previous sum
  reach[0] = true;

  for (let i = 0; i < fillers.length; i++) {
    const d = fillers[i].duration;
    if (d <= 0 || d > remaining) continue;
    for (let t = remaining; t >= d; t--) {
      if (!reach[t] && reach[t - d]) {
        reach[t] = true;
        from[t] = i;
        prev[t] = t - d;
      }
    }
  }

  // Find the largest reachable total <= remaining.
  let best = 0;
  for (let t = remaining; t >= 0; t--) {
    if (reach[t]) { best = t; break; }
  }

  // Reconstruct chosen fillers.
  const items = [];
  for (let t = best; t > 0; t = prev[t]) {
    items.push(fillers[from[t]]);
  }
  items.reverse();

  const underrun = remaining - best;
  return { items, total: best, fits: underrun <= maxUnderrun };
}

/**
 * Populate a single ScheduledBlock: clear any auto items, pick main content,
 * fit fillers, and write ordered ScheduleItems. Manual-override items are
 * preserved. Returns { blockId, mainCount, fillerCount, underrun, fits }.
 */
export function populateBlock(block) {
  const template = db.prepare('SELECT * FROM BlockTemplate WHERE id = ?').get(block.template_id);
  const blockSecs = blockDurationSeconds(template.start_time, template.end_time);

  // Preserve manual overrides; regenerate the rest.
  db.prepare(
    'DELETE FROM ScheduleItem WHERE block_id = ? AND is_manual_override = 0'
  ).run(block.id);

  const kept = db.prepare(
    'SELECT si.*, r.duration FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ? ORDER BY si.play_order'
  ).all(block.id);
  const keptSecs = kept.reduce((s, i) => s + i.duration, 0);

  const main = kept.length ? [] : pickMainContent(template, block, blockSecs);
  const mainSecs = main.reduce((s, r) => s + r.duration, 0);

  const remaining = blockSecs - keptSecs - mainSecs;
  const { items: fillers, total: fillerSecs, fits } = fitFillers(template.channel_id, remaining);

  // Write items: kept overrides first (already ordered), then main, then fillers.
  const insert = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, 0)'
  );
  let order = kept.length;
  for (const r of main) insert.run(block.id, r.id, order++);
  for (const r of fillers) insert.run(block.id, r.id, order++);

  const underrun = blockSecs - (keptSecs + mainSecs + fillerSecs);
  return {
    blockId: block.id,
    blockSeconds: blockSecs,
    mainCount: main.length,
    fillerCount: fillers.length,
    underrun,
    fits,
  };
}

/** Generate a full week: roll forward templates, then populate each block. */
export function generateWeek(weekStart = new Date()) {
  const blocks = rollForwardTemplates(weekStart);
  return blocks.map((b) => populateBlock(b));
}
