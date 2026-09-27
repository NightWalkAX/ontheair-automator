// Bring every channel's copy of a shared file back into agreement.
//
// Until catalogue edits were made per FILE (services/catalogSync.js), editing a
// clip changed only the channel the Catalog Editor was showing, so the copies on
// the other channels drifted. On the operator's database of 2026-09-26:
//   - 403 lesson clips (Math Intervention, Spanish Program, R.E.A.D, Beatin da
//     Maths…) were Lessons on three channels and TV Shows on the other three,
//     although all six carry the same Lessons roots for those folders;
//   - 84 files were approved on some channels and not on others;
//   - series registry rows disagreed with their own clips about the show type
//     (a TV show registered as a Movie).
//
// Three passes, in order:
//   1. show type = the deepest media root of the file's channel (the rule
//      001-retag-show-types established; re-run because the drift came back);
//   2. organisation (subject/season/chapter/filler) copied from one row per file
//      onto the rest — the edited row if there is one (it has an override), else
//      an approved one, else the lowest channel — and approval is the UNION:
//      approved on any channel is approved on all, since it is a decision about
//      the file and no channel airs a clip its templates do not ask for;
//   3. each registry row takes its clips' show type when they agree on one.

import { db } from '../db.js';
import { plan as retagPlan } from './001-retag-show-types.js';

export const id = '005-sync-shared-catalog';
export const description = "align every channel's copy of a shared file (type, filing, approval)";

const ORG = ['subject', 'season', 'chapter', 'is_filler'];

export function plan() {
  const ops = [];
  const summary = [];

  // 1. Show type from the deepest root.
  const retag = retagPlan();
  ops.push(...retag.ops);
  for (const line of retag.summary) summary.push(`type: ${line}`);
  // Pass 3 must judge the registry by the types pass 1 is about to write.
  const typeOverride = new Map();
  for (const op of retag.ops) {
    if (op.sql.startsWith('UPDATE Resource')) typeOverride.set(op.params[1], op.params[0]);
  }

  // 2. Filing + approval, per physical file.
  const drifted = db.prepare(`
    SELECT file_path FROM Resource GROUP BY file_path
    HAVING COUNT(*) > 1 AND (
      COUNT(DISTINCT COALESCE(subject, '~none~')) > 1 OR COUNT(DISTINCT COALESCE(season, -1)) > 1
      OR COUNT(DISTINCT chapter) > 1 OR COUNT(DISTINCT is_filler) > 1 OR COUNT(DISTINCT approved) > 1)
  `).all().map((r) => r.file_path);
  const copiesOf = db.prepare(`
    SELECT r.*, (ov.resource_id IS NOT NULL) AS edited FROM Resource r
    LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
    WHERE r.file_path = ?
    ORDER BY edited DESC, r.approved DESC, r.channel_id
  `);
  let filed = 0;
  let approved = 0;
  const newSubjects = new Set(); // "channel\0subject"
  for (const fp of drifted) {
    const rows = copiesOf.all(fp);
    const src = rows[0];
    const anyApproved = rows.some((r) => r.approved) ? 1 : 0;
    for (const r of rows) {
      const orgDiffers = ORG.some((f) => (r[f] ?? null) !== (src[f] ?? null));
      if (!orgDiffers && r.approved === anyApproved) continue;
      ops.push({
        sql: 'UPDATE Resource SET subject = ?, season = ?, chapter = ?, is_filler = ?, approved = ? WHERE id = ?',
        params: [src.subject, src.season, src.chapter, src.is_filler, anyApproved, r.id],
      });
      if (orgDiffers) filed++;
      if (r.approved !== anyApproved) approved++;
      if (src.subject && orgDiffers) newSubjects.add(`${r.channel_id}\u0000${src.subject}`);
    }
  }
  if (filed) summary.push(`filing: ${filed} row(s) re-filed to match the edited copy of their file`);
  if (approved) summary.push(`approval: ${approved} row(s) approved to match another channel`);
  for (const key of newSubjects) {
    const [channelId, subject] = key.split('\u0000');
    ops.push({
      sql: `INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, is_serial, is_active, play_order)
            VALUES (?, ?, 0, 1, (SELECT COALESCE(MAX(play_order), -1) + 1 FROM ChannelSeries WHERE channel_id = ?))`,
      params: [Number(channelId), subject, Number(channelId)],
    });
  }

  // 3. Registry type follows the clips (with pass 1's types applied).
  const clips = db.prepare(
    'SELECT id, show_type_id FROM Resource WHERE channel_id = ? AND subject = ? AND is_filler = 0'
  );
  let registry = 0;
  for (const cs of db.prepare('SELECT id, channel_id, subject, show_type_id FROM ChannelSeries').all()) {
    const types = new Set(clips.all(cs.channel_id, cs.subject)
      .map((r) => typeOverride.get(r.id) ?? r.show_type_id).filter((t) => t != null));
    if (types.size !== 1) continue;
    const [t] = types;
    if (t === cs.show_type_id) continue;
    ops.push({ sql: 'UPDATE ChannelSeries SET show_type_id = ? WHERE id = ?', params: [t, cs.id] });
    registry++;
  }
  if (registry) summary.push(`registry: ${registry} series now typed like their clips`);

  return { ops, summary };
}
