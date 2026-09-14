// Drop series registry rows that describe content the catalogue no longer holds.
//
// ChannelSeries keys on channel_id + subject TEXT and has no foreign key to
// Resource, and the media-root prune deletes only Resource and MediaRoot rows —
// so the registry kept every folder a scan ever walked. After /Volumes/Public
// was assigned as a root, that meant 12,799 dead rows on one channel and 12,798
// on another against 176 real ones: "New folder", "FX3", "sesame-street-2010s",
// "Math Intervention Highlight.PRV". They cannot reach a block (no clips), but
// they make the series picker unusable.
//
// Removed only when BOTH hold: no Resource under that channel and subject, and
// no BlockTemplate of that channel names it. An empty series a template still
// names is a setup in progress, not rubbish.

import { db } from '../db.js';

export const id = '002-prune-orphan-series';
export const description = 'remove series registry rows with no clips that no template names';

export function plan() {
  const orphans = db.prepare(`
    SELECT cs.id, cs.channel_id, cs.subject
    FROM ChannelSeries cs
    WHERE NOT EXISTS (
      SELECT 1 FROM Resource r
      WHERE r.channel_id = cs.channel_id AND r.subject = cs.subject
    )
    AND NOT EXISTS (
      SELECT 1 FROM BlockTemplateSeries bts
      JOIN BlockTemplate bt ON bt.id = bts.template_id
      WHERE bts.subject = cs.subject AND bt.channel_id = cs.channel_id
    )
    ORDER BY cs.channel_id, cs.subject
  `).all();

  const perChannel = new Map();
  for (const o of orphans) perChannel.set(o.channel_id, (perChannel.get(o.channel_id) || 0) + 1);

  return {
    ops: orphans.map((o) => ({ sql: 'DELETE FROM ChannelSeries WHERE id = ?', params: [o.id] })),
    summary: [...perChannel.entries()].map(([ch, n]) => `channel ${ch}: ${n} dead series row(s)`),
  };
}
