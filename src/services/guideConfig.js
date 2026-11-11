// Channel guide ("cartelera") — settings and the time it takes out of a block.
//
// At the end of every block of a digital channel a 20 s video shows what is
// still to come in the current quarter of the day (the bracket: 06–12, 12–18,
// 18–24, 00–06), in that channel's own look (approved by the GLC direction on
// 2026-11-11, App Lab board 50). The clip is not a ScheduleItem: the engine
// keeps `guide.seconds` free at the end of each block's window and the OTAV push
// appends the block's rendered clip after its last item. linkShifts() is the one
// place that takes it out (r.guide_seconds, blockSeconds = content target), so
// generation, validation, balanceDay and the week check all agree without each
// knowing about guides; crossChannel adds it back, since the guide is still part
// of the block's air time.
//
// Off unless config.guide.enabled. `guide.startDate` keeps blocks generated
// before the switch-on from turning red: only dates on or after it reserve the
// time (regenerate those drafts after enabling).

import { db } from '../db.js';
import { loadConfig } from '../config.js';

export const BRACKETS = [
  { key: 'late', name: 'Late Night', from: 0, to: 6 },
  { key: 'am', name: 'Morning', from: 6, to: 12 },
  { key: 'pm', name: 'Afternoon', from: 12, to: 18 },
  { key: 'eve', name: 'Tonight', from: 18, to: 24 },
];

/** Channel name → look. A channel with no look gets no guide (the analog one). */
const STYLE_BY_NAME = [
  [/discover/i, 'discover'], [/junior|\bjr\b/i, 'jr'], [/teen/i, 'teen'],
  [/elevate/i, 'elevate'], [/elementary/i, 'elementary'], [/moe|central/i, 'moe'],
];
export const STYLES = ['discover', 'jr', 'teen', 'elevate', 'elementary', 'moe'];

const DEFAULTS = {
  enabled: false,
  startDate: null,          // 'YYYY-MM-DD': reserve only from this date on
  seconds: 20,
  minBlockSeconds: 300,     // shorter windows get no guide
  outDir: '/Volumes/Public/Broadcast/Channel Guide',
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  concurrency: 2,
  daysAhead: 3,             // the background renderer keeps today..today+N ready
  intervalMinutes: 15,
  frozenMinutes: 30,        // never re-render a guide airing this soon (or past)
  keepDays: 3,              // rendered days older than this are deleted
  styles: {},               // { "<channel id>": "discover" } overrides the name match
};

let cache = { at: 0, value: null };
/** config.guide merged over the defaults; cached 5 s (linkShifts is hot). */
export function guideConfig({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cache.value && now - cache.at < 5000) return cache.value;
  let raw = {};
  try { raw = loadConfig().guide || {}; } catch { raw = {}; }
  cache = { at: now, value: { ...DEFAULTS, ...raw, styles: { ...(raw.styles || {}) } } };
  return cache.value;
}
export function resetGuideConfigCache() { cache = { at: 0, value: null }; }

const channelCache = new Map();
/** The look of a channel, or null (no guide). Analog channels never get one. */
export function channelStyle(channelId, cfg = guideConfig()) {
  if (channelId == null) return null;
  const override = cfg.styles?.[String(channelId)];
  if (override !== undefined) return STYLES.includes(override) ? override : null;
  let ch = channelCache.get(channelId);
  if (!ch || Date.now() - ch.at > 60000) {
    const row = db.prepare('SELECT name, playout, is_active FROM ChannelType WHERE id = ?').get(channelId);
    ch = { at: Date.now(), row };
    channelCache.set(channelId, ch);
  }
  const row = ch.row;
  if (!row || row.playout === 'analog') return null;
  return STYLE_BY_NAME.find(([re]) => re.test(row.name))?.[1] ?? null;
}

/**
 * Seconds a block of this channel/date keeps free at its end for the guide.
 * `windowSeconds` is the block's full window: a short block gets none.
 */
export function guideSecondsFor(channelId, targetDate, windowSeconds = Infinity, cfg = guideConfig()) {
  if (!cfg.enabled) return 0;
  if (cfg.startDate && targetDate && String(targetDate) < cfg.startDate) return 0;
  if (!(windowSeconds >= Math.max(cfg.minBlockSeconds, cfg.seconds + 60))) return 0;
  if (!channelStyle(channelId, cfg)) return 0;
  return Number(cfg.seconds) || 0;
}

/** Bracket of a time of day in seconds (0..86399). */
export function bracketAt(secondsOfDay) {
  const h = Math.floor((((secondsOfDay % 86400) + 86400) % 86400) / 3600);
  return BRACKETS.find((b) => h >= b.from && h < b.to);
}
