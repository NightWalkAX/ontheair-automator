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
      WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND chapter >= ?
      ORDER BY chapter ASC LIMIT 1
    `).get(channelId, subject, target) ||
    db.prepare(`
      SELECT * FROM Resource
      WHERE channel_id = ? AND subject = ? AND is_filler = 0
      ORDER BY chapter ASC LIMIT 1
    `).get(channelId, subject) ||
    null
  );
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
 * TV episodes on Sundays — the latest-added episode for a subject/channel.
 * "Latest" = highest chapter, tie-broken by newest added_at.
 */
export function latestEpisode(channelId, subject) {
  return db.prepare(`
    SELECT * FROM Resource
    WHERE channel_id = ? AND subject = ? AND is_filler = 0
    ORDER BY chapter DESC, added_at DESC
    LIMIT 1
  `).get(channelId, subject) || null;
}

/** Record that a resource aired on a channel at a given datetime. */
export function recordPlay(channelId, resourceId, playedAt) {
  db.prepare(
    'INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, ?, ?)'
  ).run(resourceId, channelId, playedAt);
}
