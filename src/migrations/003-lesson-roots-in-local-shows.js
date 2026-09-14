// The educational programmes that live inside the TV Shows folder get a media
// root of their own, typed Lessons.
//
// A clip's show type comes from the media root that contains it, and the whole
// of Broadcast/Local Shows is registered as TV Shows — so "CPCE Teacher
// Lessons", "Math Intervention" and the rest were catalogued as TV Shows and
// never reached a lessons slot, however educational they are. The fix is the
// mechanism the roots already provide: a DEEPER root carves its subtree out of
// the one above it. The catalogue already does exactly this for
// Local Shows/Literacy; these seven folders were simply never given the same
// treatment. Confirmed folder by folder with the operator on 2026-09-14.
//
// The roots are registered AND the clips already catalogued under them are
// re-typed here, so the repair does not wait for somebody to run a scan. A
// re-scan agrees with it afterwards: scanMediaRoot() skips what a deeper root
// owns, so the deepest root keeps winning.
//
// A folder this installation has no clips under is skipped: with no catalogue
// behind it a root would just be a guess about somebody else's share.

import { db } from '../db.js';

export const id = '003-lesson-roots-in-local-shows';
export const description = 'register the educational folders inside Local Shows as Lessons roots';

// Folder names, relative to whatever path the Local Shows root has.
const LESSON_FOLDERS = [
  'Math Intervention',
  'Spanish Program',
  'R.E.A.D',
  'Beatin da Maths',
  'CPCE Teacher Lessons',
  'Renewed Curriculum',
  'Inside NCERD',
];

const esc = (s) => s.replace(/[%_\\]/g, (m) => '\\' + m);

export function plan() {
  const lessons = db.prepare("SELECT id FROM ShowType WHERE code = 'lessons'").get()?.id;
  if (!lessons) return { ops: [], summary: [] };

  // Every root that IS the Local Shows folder, whatever it is typed as and
  // wherever the share is mounted.
  const parents = db.prepare(
    "SELECT channel_id, path FROM MediaRoot WHERE path LIKE '%/Local Shows'"
  ).all();
  if (!parents.length) return { ops: [], summary: [] };

  const ops = [];
  const summary = [];
  for (const parent of parents) {
    for (const folder of LESSON_FOLDERS) {
      const path = `${parent.path}/${folder}`;
      const clips = db.prepare(
        `SELECT COUNT(*) n FROM Resource
         WHERE channel_id = ? AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')`
      ).get(parent.channel_id, path, esc(path) + '/%').n;
      if (!clips) continue; // nothing catalogued there on this installation

      const already = db.prepare(
        'SELECT 1 AS x FROM MediaRoot WHERE channel_id = ? AND show_type_id = ? AND path = ?'
      ).get(parent.channel_id, lessons, path);
      if (!already) {
        ops.push({
          sql: 'INSERT OR IGNORE INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)',
          params: [parent.channel_id, lessons, path],
        });
      }

      const offType = db.prepare(
        `SELECT COUNT(*) n FROM Resource
         WHERE channel_id = ? AND show_type_id IS NOT ?
           AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')`
      ).get(parent.channel_id, lessons, path, esc(path) + '/%').n;
      if (offType) {
        ops.push({
          sql: `UPDATE Resource SET show_type_id = ?
                WHERE channel_id = ? AND show_type_id IS NOT ?
                  AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')`,
          params: [lessons, parent.channel_id, lessons, path, esc(path) + '/%'],
        });
        // The series registry has to agree, or a movie block's series-level
        // guard still judges these by the type they used to carry.
        ops.push({
          sql: `UPDATE ChannelSeries SET show_type_id = ?
                WHERE channel_id = ? AND subject IN (
                  SELECT DISTINCT subject FROM Resource
                  WHERE channel_id = ? AND subject IS NOT NULL
                    AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')
                )`,
          params: [lessons, parent.channel_id, parent.channel_id, path, esc(path) + '/%'],
        });
      }
      summary.push(`channel ${parent.channel_id}: ${folder} — ${clips} clip(s)`
        + `${already ? ' (root already there)' : ''}${offType ? `, ${offType} re-typed` : ''}`);
    }
  }
  return { ops, summary };
}
