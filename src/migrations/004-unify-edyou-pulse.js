// EDYOU PULSE is ONE TV show with two seasons, on every channel.
//
// What the catalogue held on 2026-09-26, from the operator's own database:
//   - MoE Central had been re-filed by hand as "EDYOU PULSE", season 1 and 2 —
//     but with the chapters of the hand edits: EP 2 and EP 3 both chapter 2, EP 4
//     and EP 5 both chapter 3, and season 2 as 2003/2004/2020. The episode picker
//     de-duplicates by chapter, so half of season 1 could not be picked at all.
//   - The other five channels still had the scan's flat "EDYOUPULSE" (no seasons,
//     season 2's episodes colliding with season 1's), plus "EdYou Pulse" for a
//     copy of episode 19 sitting in Broadcast/Local Shows.
//   - Rows for three season 2 files that had since been RENAMED
//     ("EDYOU PULSE  EP 3.mp4" -> "EDYOU PULSE  EP3SE2.mp4"): the scan adds the
//     new name and never removes the old one, and the operator deleted the stale
//     rows on MoE Central only.
//   - In the series registry "EDYOUPULSE" was a Movie on Elevate and
//     "EDYOU PULSE" a Movie on MoE Central, while every clip was a TV show —
//     which is how the same show appeared as a movie in one place and a TV show
//     in another.
//
// The repair, on every channel: every clip under the EDYOUPULSE folder becomes
// "EDYOU PULSE" with its season (from "EP3SE2" or the SEASON 2 folder) and a
// chapter re-derived from the filename, so the order is real and unique; the
// stale renamed rows go; the Local Shows copy of episode 19 is taken out of the
// show and unapproved (a re-scan keeps both, so it cannot come back as a third
// series); each channel's registry keeps ONE serial TV row, carrying on from
// where its cursor was.

import { basename, dirname } from 'node:path';
import { db } from '../db.js';
import { parseEpisode, encodeChapter } from '../services/episodeParse.js';

export const id = '004-unify-edyou-pulse';
export const description = 'file EDYOU PULSE as one two-season TV show on every channel';

const SUBJECT = 'EDYOU PULSE';
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');
const isVariant = (s) => norm(s) === 'EDYOUPULSE';

function seasonEpisode(filePath) {
  const name = basename(filePath).replace(/\.[^.]+$/, '');
  const p = parseEpisode(name);
  const folder = basename(dirname(filePath));
  const fromFolder = /(?:season|temporada)\s*(\d+)/i.exec(folder);
  const season = p.season ?? (fromFolder ? Number(fromFolder[1]) : 1);
  return { season, episode: p.episode, chapter: encodeChapter(season, p.episode) };
}

export function plan() {
  const rows = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM ScheduleItem si JOIN ScheduledBlock sb ON sb.id = si.block_id
                 WHERE si.resource_id = r.id AND sb.status != 'draft') AS locked
    FROM Resource r
    WHERE r.file_path LIKE '%/EDYOUPULSE/%' OR r.file_path LIKE '%/EdYou Pulse/%'
  `).all();
  if (!rows.length) return { ops: [], summary: [] };

  const ops = [];
  const summary = [];
  const show = rows.filter((r) => /\/EDYOUPULSE\//i.test(r.file_path));
  const copies = rows.filter((r) => !/\/EDYOUPULSE\//i.test(r.file_path));

  // Stale renamed rows: two paths that are the same (season, episode), where one
  // of them has already been deleted on some channel that still has the other.
  // That is the operator's decision on record, and the scan's evidence: it
  // listed the folder and did not find the old name.
  const byPath = new Map();
  for (const r of show) {
    if (!byPath.has(r.file_path)) byPath.set(r.file_path, { ...seasonEpisode(r.file_path), channels: new Set(), rows: [] });
    byPath.get(r.file_path).channels.add(r.channel_id);
    byPath.get(r.file_path).rows.push(r);
  }
  const stale = new Set();
  for (const [p, a] of byPath) {
    for (const [q, b] of byPath) {
      if (p === q || a.chapter !== b.chapter) continue;
      if ([...b.channels].some((c) => !a.channels.has(c))) stale.add(p);
    }
  }

  const approvedAnywhere = (fp) => byPath.get(fp).rows.some((r) => r.approved);
  const newChapter = new Map(); // resource id -> chapter it gets
  for (const [fp, a] of byPath) {
    if (stale.has(fp)) {
      for (const r of a.rows) {
        if (r.locked) {
          // Already in an approved/exported block: keep the row, retire it.
          ops.push({ sql: 'UPDATE Resource SET subject = NULL, approved = 0 WHERE id = ?', params: [r.id] });
        } else {
          ops.push({ sql: 'DELETE FROM Resource WHERE id = ?', params: [r.id] });
        }
      }
      summary.push(`stale (renamed) ${basename(fp)} — ${a.rows.length} row(s) removed`);
      continue;
    }
    const approved = approvedAnywhere(fp) ? 1 : 0;
    for (const r of a.rows) {
      newChapter.set(r.id, a.chapter);
      if (r.subject === SUBJECT && r.season === a.season && r.chapter === a.chapter && r.approved === approved) continue;
      ops.push({
        sql: 'UPDATE Resource SET subject = ?, season = ?, chapter = ?, approved = ?, is_filler = 0 WHERE id = ?',
        params: [SUBJECT, a.season, a.chapter, approved, r.id],
      });
    }
  }
  const s2 = [...byPath.entries()].filter(([fp, a]) => !stale.has(fp) && a.season === 2).length;
  summary.push(`${byPath.size - stale.size} file(s) filed as ${SUBJECT} (season 2: ${s2}), on ${new Set(show.map((r) => r.channel_id)).size} channel(s)`);

  for (const r of copies) {
    if (r.subject == null && !r.approved) continue;
    ops.push({ sql: 'UPDATE Resource SET subject = NULL, approved = 0 WHERE id = ?', params: [r.id] });
  }
  if (copies.length) summary.push(`duplicate copy ${basename(copies[0].file_path)} taken out of the show on ${copies.length} channel(s)`);

  // Registry: one serial TV row per channel, carrying the cursor across.
  const channels = new Set(show.map((r) => r.channel_id));
  for (const channelId of channels) {
    const variants = db.prepare('SELECT * FROM ChannelSeries WHERE channel_id = ?').all(channelId)
      .filter((cs) => isVariant(cs.subject));
    const typeId = show.find((r) => r.channel_id === channelId && r.show_type_id)?.show_type_id ?? null;
    const playOrder = variants.length ? Math.min(...variants.map((v) => v.play_order))
      : db.prepare('SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ChannelSeries WHERE channel_id = ?').get(channelId).n;
    // The cursor named an OLD chapter; find the clip it pointed at and use the
    // chapter that clip has now (or the next one that survives).
    let cursor = null;
    const withCursor = variants.find((v) => v.cursor_chapter != null);
    if (withCursor) {
      const mine = show.filter((r) => r.channel_id === channelId && newChapter.has(r.id))
        .sort((a, b) => a.chapter - b.chapter || a.id - b.id);
      const hit = mine.find((r) => isVariant(r.subject) && r.chapter >= withCursor.cursor_chapter);
      cursor = hit ? newChapter.get(hit.id) : null;
    }
    ops.push({
      sql: `DELETE FROM ChannelSeries WHERE channel_id = ? AND subject IN (${variants.map(() => '?').join(',') || "''"})`,
      params: [channelId, ...variants.map((v) => v.subject)],
    });
    ops.push({
      sql: `INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order, cursor_chapter)
            VALUES (?, ?, ?, 1, 1, ?, ?)`,
      params: [channelId, SUBJECT, typeId, playOrder, cursor],
    });
    summary.push(`channel ${channelId}: registry ${variants.map((v) => `"${v.subject}"`).join(' + ') || '(none)'} -> "${SUBJECT}"`
      + `${cursor != null ? `, next-up chapter ${cursor}` : ''}`);
  }

  // Templates name series by subject text.
  for (const t of db.prepare('SELECT id, template_id, subject FROM BlockTemplateSeries').all()) {
    if (!isVariant(t.subject) || t.subject === SUBJECT) continue;
    const has = db.prepare('SELECT 1 AS x FROM BlockTemplateSeries WHERE template_id = ? AND subject = ?').get(t.template_id, SUBJECT);
    ops.push(has
      ? { sql: 'DELETE FROM BlockTemplateSeries WHERE id = ?', params: [t.id] }
      : { sql: 'UPDATE BlockTemplateSeries SET subject = ? WHERE id = ?', params: [SUBJECT, t.id] });
  }

  return { ops, summary };
}
