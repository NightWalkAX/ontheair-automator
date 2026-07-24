// PlayHistory-backed selection helpers for the auto-generation engine.
//
// These encode the three content-selection rules from SEED.md §4 Module A:
//   - lesson/series : strict sequential chapter progression
//   - movies        : random pick honouring a dynamic cooldown
//   - tv episodes   : cooldown on weekdays, latest-added on Sundays
//
// All queries are scoped by channel_id because each channel owns its own media.

import { db } from '../db.js';

/**
 * Lessons & Series — next sequential resource for a subject on a channel.
 * Picks chapter = (last played chapter for that subject) + 1. If nothing has
 * played yet, starts at the lowest available chapter.
 */
export function nextSequential(channelId, subject) {
  const last = db.prepare(`
    SELECT MAX(r.chapter) AS last_chapter
    FROM PlayHistory ph
    JOIN Resource r ON r.id = ph.resource_id
    WHERE ph.channel_id = ? AND r.subject = ?
  `).get(channelId, subject);

  const target = (last?.last_chapter ?? 0) + 1;

  // Exact next chapter if present, else the lowest chapter >= target (skips
  // gaps), else wrap to the lowest chapter of the subject (loop the series).
  return (
    db.prepare(`
      SELECT * FROM Resource
      WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND approved = 1 AND chapter >= ?
      ORDER BY chapter ASC LIMIT 1
    `).get(channelId, subject, target) ||
    db.prepare(`
      SELECT * FROM Resource
      WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND approved = 1
      ORDER BY chapter ASC LIMIT 1
    `).get(channelId, subject) ||
    null
  );
}

/**
 * Series progression cursor. Returns the chapter number a serial series should
 * play next on a channel, as of a given date.
 *
 * `cursor_chapter` (when set) is AUTHORITATIVE: it is the chapter the admin wants
 * this series to start from, and it wins over all-time aired history — so resetting
 * a series back to episode 1 actually schedules episode 1, even if it aired before.
 * The cursor is folded forward on approval (recordBlockPlays bumps it), so it always
 * reflects real progression. Within a generation, the series still rolls forward day
 * by day past whatever was already scheduled earlier IN THE SAME 7-day window — the
 * window bound keeps a prior week's leftover drafts from leaking into progression.
 *
 * With no cursor yet (a never-approved series), fall back to `1 + MAX(chapter)` over
 * aired PlayHistory (all time) plus earlier-in-window scheduled items.
 */
export function nextChapter(channelId, subject, beforeDate) {
  // Highest chapter already placed earlier in the current 7-day window.
  const win = db.prepare(`
    SELECT MAX(r.chapter) AS m
    FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    JOIN Resource r ON r.id = si.resource_id
    WHERE r.channel_id = ? AND r.subject = ?
      AND sb.target_date < ? AND sb.target_date >= date(?, '-6 days')
  `).get(channelId, subject, beforeDate, beforeDate);
  const earlierMax = win?.m ?? null;

  const cur = db.prepare(
    'SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?'
  ).get(channelId, subject);
  const cursor = cur?.cursor_chapter ?? null;

  if (cursor != null) {
    // Start at the cursor; roll forward past anything already placed this window.
    return Math.max(cursor, (earlierMax ?? cursor - 1) + 1);
  }

  const hist = db.prepare(`
    SELECT MAX(r.chapter) AS m FROM PlayHistory ph JOIN Resource r ON r.id = ph.resource_id
    WHERE ph.channel_id = ? AND r.subject = ?
  `).get(channelId, subject);
  return Math.max(hist?.m ?? 0, earlierMax ?? 0) + 1;
}

/**
 * Movies — random pick honouring a dynamic cooldown.
 * cooldownDays = floor(total candidate movies / 2). A movie is eligible if it
 * has never played on this channel, or last played more than cooldownDays ago.
 *
 * `candidates` is narrowed by the caller (e.g. by subject or show type) so this
 * works for both movie blocks and weekday TV-as-filler blocks.
 */
export function randomWithCooldown(channelId, candidates, asOfDate) {
  if (!candidates.length) return null;
  const cooldownDays = Math.floor(candidates.length / 2);

  const lastPlayed = db.prepare(`
    SELECT MAX(played_at) AS last FROM PlayHistory
    WHERE channel_id = ? AND resource_id = ?
  `);

  const asOf = new Date(asOfDate + 'T00:00:00');
  const eligible = candidates.filter((r) => {
    const row = lastPlayed.get(channelId, r.id);
    if (!row?.last) return true; // never played
    const daysSince = (asOf - new Date(row.last)) / 86_400_000;
    return daysSince > cooldownDays;
  });

  const pool = eligible.length ? eligible : candidates; // fall back if all cooled
  // Deterministic-ish pick without Math.random (unavailable in some contexts):
  // rotate by day-of-month so repeated same-day runs are stable.
  const idx = asOf.getDate() % pool.length;
  return pool[idx];
}

/**
 * TV episodes on Sundays — the latest-*added* episode for a subject/channel per
 * SEED §4. "Latest" = most recently ingested (added_at), NOT the highest chapter
 * number — ordering by chapter would always surface the final episode of the
 * series as the "start", which is the bug this fixes. added_at is the file mtime
 * stamped at scan time; id is the tiebreaker for equal mtimes.
 */
export function latestEpisode(channelId, subject) {
  return db.prepare(`
    SELECT * FROM Resource
    WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND approved = 1
    ORDER BY added_at DESC, id DESC
    LIMIT 1
  `).get(channelId, subject) || null;
}

/** Record that a resource aired on a channel at a given datetime. */
export function recordPlay(channelId, resourceId, playedAt) {
  db.prepare(
    'INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, ?, ?)'
  ).run(resourceId, channelId, playedAt);
}
