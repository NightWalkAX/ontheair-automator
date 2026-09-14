// A resource's show type comes from the DEEPEST media root that contains it.
//
// Two bugs wrote rows that break that rule, and a catalogue can still be
// carrying their output: cloneScannedResources() used to force the newly added
// root's show type onto everything in its subtree (a root added one level too
// high re-typed thousands of clips — 971 lesson files per channel ended up as
// Movies, and from there into movie blocks), and a scan let whichever root ran
// LAST decide, so a lesson folder inside a TV Shows root flipped type on every
// re-scan. Both are fixed; this repairs what they already wrote.
//
// A file under no root of its channel is left alone: it may predate a root that
// was removed, and guessing would be worse than leaving it.

import { db } from '../db.js';

export const id = '001-retag-show-types';
export const description = 'give every resource the show type of its deepest media root';

export function plan() {
  const rootsByChannel = new Map();
  for (const r of db.prepare(
    'SELECT channel_id, path, show_type_id FROM MediaRoot ORDER BY LENGTH(path) DESC'
  ).all()) {
    if (!rootsByChannel.has(r.channel_id)) rootsByChannel.set(r.channel_id, []);
    rootsByChannel.get(r.channel_id).push(r);
  }
  if (!rootsByChannel.size) return { ops: [], summary: [] };

  const rootFor = (channelId, filePath) =>
    (rootsByChannel.get(channelId) || []).find(
      (r) => filePath === r.path || filePath.startsWith(r.path + '/')
    ) || null;

  const ops = [];
  const counts = new Map(); // "channel|from|to" -> n
  const subjectType = new Map(); // "channel|subject" -> show_type_id
  for (const r of db.prepare('SELECT id, channel_id, file_path, show_type_id, subject FROM Resource').all()) {
    const root = rootFor(r.channel_id, r.file_path);
    if (!root || root.show_type_id === r.show_type_id) continue;
    ops.push({
      sql: 'UPDATE Resource SET show_type_id = ? WHERE id = ?',
      params: [root.show_type_id, r.id],
    });
    const key = `${r.channel_id}|${r.show_type_id}|${root.show_type_id}`;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (r.subject) subjectType.set(`${r.channel_id}|${r.subject}`, root.show_type_id);
  }

  // A series must agree with its clips, or a movie block's series-level guard
  // still waves a lesson series through.
  for (const [key, typeId] of subjectType) {
    const channelId = Number(key.slice(0, key.indexOf('|')));
    const subject = key.slice(key.indexOf('|') + 1);
    const cs = db.prepare(
      'SELECT id, show_type_id FROM ChannelSeries WHERE channel_id = ? AND subject = ?'
    ).get(channelId, subject);
    if (cs && cs.show_type_id !== typeId) {
      ops.push({
        sql: 'UPDATE ChannelSeries SET show_type_id = ? WHERE id = ?',
        params: [typeId, cs.id],
      });
    }
  }

  const name = (typeId) => db.prepare('SELECT name FROM ShowType WHERE id = ?').get(typeId)?.name ?? `#${typeId}`;
  const summary = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => {
      const [ch, from, to] = key.split('|');
      return `channel ${ch}: ${name(Number(from))} -> ${name(Number(to))}, ${n} resource(s)`;
    });
  return { ops, summary };
}
