// One physical file, one set of catalogue decisions — on every channel.
//
// A shared folder is catalogued once PER CHANNEL (Resource is unique on
// (channel_id, file_path)), so the same clip exists as up to six rows. The
// Catalog Editor used to edit only the row of the channel it was looking at,
// and the copies drifted: EDYOU PULSE was re-filed into seasons on MoE Central
// while the other five channels kept the old flat "EDYOUPULSE" subject, a stray
// "EdYou Pulse" duplicate and stale rows for files that had been renamed. Which
// channel you opened decided what the show looked like.
//
// So an edit is now a decision about the FILE: after the operator's change is
// applied to the row they touched, the organisation fields are copied onto every
// other row with the same file_path. A folder assigned to one channel only has no
// other rows, so an isolated root stays isolated for free.
//
// Deliberately NOT copied:
//   - show_type_id: it comes from each channel's deepest media root (a child root
//     can exist on some channels only), and a scan re-derives it. The catalogue's
//     "set show type" op handles its own siblings — see syncShowType().
//   - duration / added_at / last_used_at: facts about the file or per-channel
//     airing state, maintained elsewhere.
//   - ChannelSeries (cursor, play order, serial/active): per-channel scheduling.

import { db } from '../db.js';

const FIELDS = ['subject', 'season', 'chapter', 'is_filler', 'approved', 'audience_rating', 'sort_order'];

/** Register (channel, subject) in the series registry if it is new there. */
function ensureSeries(channelId, subject) {
  if (channelId == null || !subject) return;
  const typeId = db.prepare(`
    SELECT show_type_id FROM Resource
    WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND show_type_id IS NOT NULL
    ORDER BY id LIMIT 1
  `).get(channelId, subject)?.show_type_id ?? null;
  const code = typeId ? db.prepare('SELECT code FROM ShowType WHERE id = ?').get(typeId)?.code : null;
  db.prepare(`
    INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
    VALUES (?, ?, ?, ?, 1, (SELECT COALESCE(MAX(play_order), -1) + 1 FROM ChannelSeries WHERE channel_id = ?))
  `).run(channelId, subject, typeId, code === 'lessons' || code === 'tv_shows' ? 1 : 0, channelId);
}

/**
 * Copy the organisation of each resource in `ids` onto the other channels'
 * rows for the same file. Call INSIDE the transaction that made the edit.
 * `reset` is for "reset to detected": the source's override row is gone, and the
 * copies drop theirs too. Otherwise a source with no override (an approval
 * toggle never snapshots one) leaves the copies' display names alone.
 * Returns the number of sibling rows updated.
 */
export function syncSiblings(ids, { reset = false } = {}) {
  const get = db.prepare(`SELECT * FROM Resource WHERE id = ?`);
  const siblings = db.prepare('SELECT * FROM Resource WHERE file_path = ? AND id != ?');
  const update = db.prepare(
    `UPDATE Resource SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`
  );
  const ovOf = db.prepare('SELECT * FROM ResourceOverride WHERE resource_id = ?');
  // A sibling keeps its OWN pre-edit snapshot, so "reset to detected" on that
  // channel still restores what that channel's scan found.
  const snapshot = db.prepare(`
    INSERT OR IGNORE INTO ResourceOverride (resource_id, detected_subject, detected_chapter, detected_season)
    VALUES (?, ?, ?, ?)
  `);
  const setDisplay = db.prepare('UPDATE ResourceOverride SET display_name = ? WHERE resource_id = ?');
  const dropOverride = db.prepare('DELETE FROM ResourceOverride WHERE resource_id = ?');

  let n = 0;
  const touched = new Set();
  for (const id of new Set(ids)) {
    const src = get.get(id);
    if (!src) continue;
    const srcOv = ovOf.get(id);
    for (const sib of siblings.all(src.file_path, id)) {
      if (srcOv) {
        snapshot.run(sib.id, sib.subject, sib.chapter, sib.season);
        setDisplay.run(srcOv.display_name ?? null, sib.id);
      } else if (reset) {
        dropOverride.run(sib.id);
      }
      update.run(...FIELDS.map((f) => src[f] ?? null), sib.id);
      if (src.subject) touched.add(`${sib.channel_id}\u0000${src.subject}`);
      n++;
    }
  }
  for (const key of touched) {
    const [channelId, subject] = key.split('\u0000');
    ensureSeries(Number(channelId), subject);
  }
  return n;
}

/**
 * The catalogue's "set show type" op, for the other channels' copies. A copy
 * follows only when it carried the SAME type as the edited row did before the
 * edit: a copy typed differently is typed by a media root that only exists on
 * that channel, and a re-scan would put it back anyway.
 */
export function syncShowType(filePath, fromTypeId, toTypeId, exceptId) {
  return db.prepare(
    'UPDATE Resource SET show_type_id = ? WHERE file_path = ? AND id != ? AND show_type_id IS ?'
  ).run(toTypeId, filePath, exceptId, fromTypeId).changes;
}

/** Every row of the same file, on every channel (for delete). */
export function siblingIds(id) {
  return db.prepare(`
    SELECT s.id FROM Resource r JOIN Resource s ON s.file_path = r.file_path WHERE r.id = ?
  `).all(id).map((x) => x.id);
}

/**
 * A scan found files this channel had not catalogued yet. When another channel
 * already has them, adopt that channel's organisation instead of the raw
 * filename detection, so a folder shared with a new channel — or a new episode
 * dropped into a shared folder and scanned channel by channel — arrives the way
 * the operator already filed it. Returns the number of rows adopted.
 */
export function adoptFromSiblings(channelId, filePaths) {
  if (!filePaths.length) return 0;
  const mine = db.prepare('SELECT id FROM Resource WHERE channel_id = ? AND file_path = ?');
  const donor = db.prepare(`
    SELECT r.id FROM Resource r
    LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
    WHERE r.file_path = ? AND r.channel_id != ?
    ORDER BY (ov.resource_id IS NOT NULL) DESC, r.approved DESC, r.id
    LIMIT 1
  `);
  let n = 0;
  for (const fp of filePaths) {
    const own = mine.get(channelId, fp);
    const d = donor.get(fp, channelId);
    if (!own || !d) continue;
    // Syncing FROM the donor writes the donor's decisions onto every copy,
    // which for a file new to this channel is exactly this channel's row
    // (the others already agree with the donor, or are brought into line).
    syncSiblings([d.id]);
    n++;
  }
  return n;
}
