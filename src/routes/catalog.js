// "Fake root" catalog editor (Module A cleanup layer).
//
// Non-destructive editing of the media catalog: the operator arranges shows and
// episodes and renames clips for-screen WITHOUT touching the files on disk or
// the server-side Resource.name / file_path (playout truth). The scheduling
// organization fields (Resource.subject = show, Resource.chapter = episode
// order) are edited in place — they are DB-only and survive re-scans — and the
// pre-edit values are snapshotted into ResourceOverride once so edits can be
// reset. display_name is a pure on-screen label layered over Resource.name.

import { Router } from 'express';
import { dirname } from 'node:path';
import { db, withTx } from '../db.js';
import { parseEpisode, encodeChapter } from '../services/episodeParse.js';
import { EPISODE_NO_CTE, withLabel } from '../services/labels.js';

export const router = Router();

// Snapshot the current subject/season/chapter into ResourceOverride the first
// time a resource is edited, so "reset to detected" can restore them. No-op if a
// row already exists (INSERT OR IGNORE preserves the earliest snapshot).
function ensureOverride(id) {
  const r = db.prepare('SELECT subject, chapter, season FROM Resource WHERE id = ?').get(id);
  if (!r) return false;
  db.prepare(`
    INSERT OR IGNORE INTO ResourceOverride (resource_id, detected_subject, detected_chapter, detected_season)
    VALUES (?, ?, ?, ?)
  `).run(id, r.subject, r.chapter, r.season);
  return true;
}

// The on-disk folder segments a file lives in, relative to the deepest MediaRoot
// of its channel that contains it. Powers the Library pane's file-browser view
// (which mirrors the real folder tree, since filenames alone often omit the show
// name). Returns [] for a file sitting directly in a media root.
function relDirs(filePath, roots) {
  let best = '';
  for (const r of roots) {
    if ((filePath === r || filePath.startsWith(r + '/')) && r.length > best.length) best = r;
  }
  const rest = best ? filePath.slice(best.length + 1) : filePath;
  const dir = dirname(rest);
  if (!dir || dir === '.' || dir === '/') return [];
  return dir.split('/').filter(Boolean);
}

// Register a (channel, subject) pair in ChannelSeries so renamed/merged shows
// appear in the series registry. Never clobbers existing ordering/flags.
function ensureSeries(channelId, subject) {
  if (channelId == null || !subject) return;
  db.prepare(`
    INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, is_serial, is_active, play_order)
    VALUES (?, ?, 0, 1, (SELECT COALESCE(MAX(play_order), -1) + 1 FROM ChannelSeries WHERE channel_id = ?))
  `).run(channelId, subject, channelId);
}

// GET /api/catalog?channel_id= — resources grouped show_type → show (subject) →
// episodes (ordered by chapter). Each episode carries the effective display_name
// (override ?? detected name) plus the raw detected name so the UI can show both.
router.get('/', (req, res) => {
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  if (channelId == null) return res.status(400).json({ error: 'channel_id is required' });

  const rows = db.prepare(`
    WITH ${EPISODE_NO_CTE}
    SELECT r.id, r.name, r.subject, r.season, r.chapter, r.duration, r.is_filler, r.approved,
           r.show_type_id, r.file_path, en.episode_no,
           st.name AS show_type_name, st.code AS show_type_code,
           ov.display_name AS display_name,
           (ov.resource_id IS NOT NULL) AS has_override
    FROM Resource r
    LEFT JOIN EpisodeNo en ON en.id = r.id
    LEFT JOIN ShowType st ON st.id = r.show_type_id
    LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
    WHERE r.channel_id = ?
    ORDER BY st.name, r.subject, r.season, r.chapter, r.name
  `).all(channelId);

  // MediaRoot paths for this channel, longest-first, to strip into on-disk
  // folder segments (rel_dirs) that the Library pane browses.
  const roots = db.prepare('SELECT path FROM MediaRoot WHERE channel_id = ?')
    .all(channelId).map((x) => x.path);

  // Group into show_type → subject → [episodes].
  const groups = new Map();
  for (const r of rows) {
    const stKey = r.show_type_id ?? 0;
    if (!groups.has(stKey)) {
      groups.set(stKey, { show_type_id: r.show_type_id, show_type_name: r.show_type_name || 'Unassigned', show_type_code: r.show_type_code, shows: new Map() });
    }
    const g = groups.get(stKey);
    const showKey = r.subject ?? '(fillers)';
    if (!g.shows.has(showKey)) g.shows.set(showKey, { subject: r.subject, episodes: [] });
    g.shows.get(showKey).episodes.push({
      ...withLabel(r),
      id: r.id, name: r.name, display_name: r.display_name || r.name,
      raw_name: r.name, subject: r.subject, season: r.season, chapter: r.chapter,
      episode_no: r.episode_no, duration: r.duration,
      is_filler: !!r.is_filler, approved: !!r.approved, has_override: !!r.has_override,
      file_path: r.file_path, rel_dirs: relDirs(r.file_path, roots),
      show_type_id: r.show_type_id, show_type_name: r.show_type_name || 'Unassigned',
    });
  }
  const out = [...groups.values()].map((g) => ({ ...g, shows: [...g.shows.values()] }));
  res.json({ channel_id: channelId, groups: out });
});

// PUT /api/catalog/resource/:id { display_name?, subject?, chapter? }
router.put('/resource/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM Resource WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};

  withTx(() => {
    ensureOverride(id);
    if (b.subject !== undefined || b.chapter !== undefined) {
      const subject = b.subject !== undefined ? (b.subject || null) : cur.subject;
      const chapter = b.chapter !== undefined ? (Number(b.chapter) | 0) : cur.chapter;
      db.prepare('UPDATE Resource SET subject = ?, chapter = ? WHERE id = ?').run(subject, chapter, id);
      if (b.subject !== undefined) ensureSeries(cur.channel_id, subject);
    }
    if (b.season !== undefined) {
      const season = b.season === null || b.season === '' ? null : (Number(b.season) | 0);
      db.prepare('UPDATE Resource SET season = ? WHERE id = ?').run(season, id);
    }
    if (b.display_name !== undefined) {
      db.prepare('UPDATE ResourceOverride SET display_name = ? WHERE resource_id = ?')
        .run(b.display_name || null, id);
    }
  });
  res.json({ ok: true });
});

// POST /api/catalog/bulk { ids:[], op, ... } — multi-rename / arrangement tools.
//   set-subject     { subject }            merge/rename a show
//   assign-to-show  { subject, season? }   join a show, re-deriving order from
//                                          each filename; season is forced when
//                                          `season` is present (null clears it),
//                                          else re-derived (auto season folders)
//   set-season      { season }             set the season folder (null = none)
//   renumber        (ids in target order)  assign chapters 1..N in the given order
//   set-showtype    { show_type_id }
//   find-replace    { field, find, replace } string replace on display_name|subject
//   template        { template }           display_name = tokens {name}{subject}{chapter}{n}
router.post('/bulk', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  const op = String(req.body?.op || '');
  if (!ids.length || !op) return res.status(400).json({ error: 'ids[] and op are required' });

  const rowFor = db.prepare('SELECT * FROM Resource WHERE id = ?');
  const setDisplay = db.prepare('UPDATE ResourceOverride SET display_name = ? WHERE resource_id = ?');

  const run = () => {
    // set-approved is a pure availability flag — it doesn't touch the
    // organization fields, so don't snapshot an override (would falsely badge
    // the clip as "edited").
    if (op !== 'set-approved') for (const id of ids) ensureOverride(id);
    switch (op) {
      case 'set-subject': {
        const subject = req.body.subject || null;
        for (const id of ids) {
          const r = rowFor.get(id);
          db.prepare('UPDATE Resource SET subject = ? WHERE id = ?').run(subject, id);
          if (r) ensureSeries(r.channel_id, subject);
        }
        break;
      }
      case 'assign-to-show': {
        // Drag-a-folder-onto-a-show: every clip joins `subject`. Play order is
        // always re-derived from the filename's episode number. The season is
        // either forced (when the body carries `season` — the operator answered
        // "file these as Season N", e.g. merging a mis-detected season-as-show)
        // or re-derived from the filename (S02E.. → Season 2). Either way the
        // chapter is re-encoded from the CHOSEN season so it sorts in broadcast
        // order and never collides with the show's other seasons — the season
        // must ride into `chapter`, not just the `season` column.
        const subject = req.body.subject || null;
        const forceSeason = Object.prototype.hasOwnProperty.call(req.body, 'season');
        const forcedSeason = req.body.season === null || req.body.season === ''
          ? null : (Number(req.body.season) | 0);
        for (const id of ids) {
          const r = rowFor.get(id);
          if (!r) continue;
          const { season: parsedSeason, episode } = parseEpisode(r.name);
          const season = forceSeason ? forcedSeason : parsedSeason;
          const chapter = encodeChapter(season, episode);
          db.prepare('UPDATE Resource SET subject = ?, season = ?, chapter = ? WHERE id = ?')
            .run(subject, season, chapter, id);
          ensureSeries(r.channel_id, subject);
        }
        break;
      }
      case 'set-season': {
        // Assign (or clear, null) the season folder for the selected clips. The
        // chapter is re-encoded from the NEW season while preserving each clip's
        // episode number (the low 3 digits), so a forced season sorts in its own
        // band and can't collide with season 1's plain episode numbers.
        const season = req.body.season === null || req.body.season === undefined || req.body.season === ''
          ? null : (Number(req.body.season) | 0);
        for (const id of ids) {
          const r = rowFor.get(id);
          if (!r) continue;
          const raw = r.chapter | 0;
          const episode = raw >= 1000 ? raw % 1000 : raw;
          const chapter = encodeChapter(season, episode);
          db.prepare('UPDATE Resource SET season = ?, chapter = ? WHERE id = ?').run(season, chapter, id);
        }
        break;
      }
      case 'renumber': {
        // ids arrive in the desired play order → chapters 1..N (gathers free
        // seasons into one continuous show when combined with set-subject).
        ids.forEach((id, i) => db.prepare('UPDATE Resource SET chapter = ? WHERE id = ?').run(i + 1, id));
        break;
      }
      case 'set-chapters': {
        // Explicit per-resource chapter assignment from the "Fix order" editor:
        // entries = [{ id, chapter }]. Lets the operator correct a mis-detected
        // order by typing the numbers directly.
        const entries = Array.isArray(req.body.entries) ? req.body.entries : [];
        for (const e of entries) {
          db.prepare('UPDATE Resource SET chapter = ? WHERE id = ?').run(Number(e.chapter) | 0, Number(e.id));
        }
        break;
      }
      case 'set-positions': {
        // Position-based reordering from the "Fix order" editor: entries =
        // [{ id, position }], 1..N within the season the operator is looking at.
        // The chapter VALUES already held by those clips are re-dealt in the new
        // order, so the show keeps its place in the channel-wide chapter
        // numbering (no collisions with other shows/seasons) while the operator
        // only ever types 1, 2, 3.
        const entries = (Array.isArray(req.body.entries) ? req.body.entries : [])
          .map((e) => ({ id: Number(e.id), position: Number(e.position), row: rowFor.get(Number(e.id)) }))
          .filter((e) => e.row);
        const chapters = entries.map((e) => e.row.chapter).sort((a, b) => a - b);
        entries
          .sort((a, b) => (a.position - b.position) || (a.id - b.id))
          .forEach((e, i) => {
            db.prepare('UPDATE Resource SET chapter = ? WHERE id = ?').run(chapters[i], e.id);
          });
        break;
      }
      case 'set-showtype': {
        const stId = req.body.show_type_id != null ? Number(req.body.show_type_id) : null;
        const affected = new Map(); // subject -> channel_id, for registry realignment
        for (const id of ids) {
          const r = rowFor.get(id);
          if (r?.subject) affected.set(r.subject, r.channel_id);
          db.prepare('UPDATE Resource SET show_type_id = ? WHERE id = ?').run(stId, id);
        }
        // Keep each affected series' registry row pointing at the show type its
        // clips actually live under now. Without this, moving a whole show to
        // another type leaves the ChannelSeries row on the old type, so the show
        // lingers as an empty folder there. Only realign when the series' clips
        // now all sit under a single type (a partial move stays ambiguous).
        for (const [subject, channelId] of affected) {
          const types = db.prepare(
            'SELECT DISTINCT show_type_id AS st FROM Resource WHERE channel_id = ? AND subject = ? AND is_filler = 0'
          ).all(channelId, subject);
          if (types.length === 1) {
            db.prepare('UPDATE ChannelSeries SET show_type_id = ? WHERE channel_id = ? AND subject = ?')
              .run(types[0].st, channelId, subject);
          }
        }
        break;
      }
      case 'set-filler': {
        // Manual filler toggle. Marking as filler drops the series/chapter (fillers
        // are a channel-wide pool, not a series); unmarking leaves subject null so
        // the operator can then assign it to a show.
        const f = req.body.is_filler ? 1 : 0;
        for (const id of ids) {
          if (f) db.prepare('UPDATE Resource SET is_filler = 1, subject = NULL, chapter = 0 WHERE id = ?').run(id);
          else db.prepare('UPDATE Resource SET is_filler = 0 WHERE id = ?').run(id);
        }
        break;
      }
      case 'set-approved': {
        // Review gate toggle. Only approved resources are visible to the
        // scheduling engine (see services/scheduling.js + playHistory.js).
        const a = req.body.approved ? 1 : 0;
        for (const id of ids) db.prepare('UPDATE Resource SET approved = ? WHERE id = ?').run(a, id);
        break;
      }
      case 'find-replace': {
        const field = req.body.field === 'subject' ? 'subject' : 'display_name';
        const find = String(req.body.find ?? '');
        const replace = String(req.body.replace ?? '');
        if (!find) break;
        for (const id of ids) {
          const r = rowFor.get(id);
          if (field === 'subject') {
            const next = String(r.subject ?? '').split(find).join(replace) || null;
            db.prepare('UPDATE Resource SET subject = ? WHERE id = ?').run(next, id);
            ensureSeries(r.channel_id, next);
          } else {
            const ov = db.prepare('SELECT display_name FROM ResourceOverride WHERE resource_id = ?').get(id);
            const base = (ov?.display_name ?? r.name) || '';
            setDisplay.run(base.split(find).join(replace) || null, id);
          }
        }
        break;
      }
      case 'template': {
        // display_name from tokens: {name} {subject} {chapter} {n} (1-based order).
        const tpl = String(req.body.template ?? '');
        ids.forEach((id, i) => {
          const r = rowFor.get(id);
          if (!r) return;
          const name = tpl
            .replace(/\{name\}/g, r.name ?? '')
            .replace(/\{subject\}/g, r.subject ?? '')
            .replace(/\{chapter\}/g, String(r.chapter ?? ''))
            .replace(/\{n\}/g, String(i + 1));
          setDisplay.run(name || null, id);
        });
        break;
      }
      default:
        throw new Error(`unknown op: ${op}`);
    }
  };
  try { withTx(run); } catch (err) { return res.status(400).json({ error: String(err.message || err) }); }
  res.json({ ok: true, count: ids.length });
});

// POST /api/catalog/reset { ids:[] } — restore detected subject/chapter and drop
// the display name (removes the override row entirely).
router.post('/reset', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids[] is required' });
  const ov = db.prepare('SELECT * FROM ResourceOverride WHERE resource_id = ?');
  withTx(() => {
    for (const id of ids) {
      const o = ov.get(id);
      if (!o) continue;
      db.prepare('UPDATE Resource SET subject = ?, chapter = ?, season = ? WHERE id = ?')
        .run(o.detected_subject, o.detected_chapter ?? 0, o.detected_season ?? null, id);
      db.prepare('DELETE FROM ResourceOverride WHERE resource_id = ?').run(id);
    }
  });
  res.json({ ok: true, count: ids.length });
});

// DELETE /api/catalog/resource/:id — remove a catalog row (e.g. a duplicate).
// Only drops the DB row (and its ScheduleItem/PlayHistory/override via cascade);
// the file on disk is untouched. A re-scan of the folder would re-add it.
router.delete('/resource/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM Resource WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
