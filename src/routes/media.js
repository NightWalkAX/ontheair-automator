// Media routes: mount the SMB share, browse its folder tree, and assign a
// chosen folder as a MediaRoot (Channel + ShowType), then trigger ingestion.

import { Router } from 'express';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { db } from '../db.js';
import { loadConfig, localizePath } from '../config.js';
import { mountShare, isMounted } from '../services/smbMount.js';
import { scanAll, scanMediaRoot, recheckCatalog, cloneScannedResources } from '../services/ingestion.js';

/** Query/body flags arrive as "1", "true" or a real boolean. */
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Is `parent` a strict ancestor directory of `child`? Trailing slashes ignored. */
const isAncestorOf = (parent, child) => {
  const p = String(parent).replace(/\/+$/, '');
  return p !== String(child).replace(/\/+$/, '') && String(child).startsWith(`${p}/`);
};

/**
 * Refuse a root that CONTAINS another root.
 *
 * A parent root re-walks everything its children already cover, and the failure
 * is not a slow scan — it is a catalogue full of files nobody meant to air.
 * "/Volumes/Public" was assigned as a root once and pulled in 196,014 clips
 * (Premiere projects, presets, b-roll, raw camera footage) against a broadcast
 * library of about 5,000. Nothing about that is recoverable by re-scanning: the
 * only way back is deleting rows, and deleting rows cascades away the
 * PlayHistory that drives movie cooldown and series progression.
 *
 * The reverse — adding a CHILD under an existing root — is deliberately still
 * allowed. That is how a deeper folder gets its own show type (the catalogue
 * has "Mathematics" alongside "Mathematics/Grade 1"), and it narrows the scan
 * rather than widening it.
 *
 * Scoped per channel, because that is where the rows land. Returns an error
 * message naming the roots in the way, or null when the path is fine.
 */
function containedRootsError(path, channelIds, { exceptRootId = null } = {}) {
  if (!channelIds.length) return null;
  const rows = db.prepare(`
    SELECT m.id, m.path, COALESCE(c.name, '?') AS channel
    FROM MediaRoot m LEFT JOIN ChannelType c ON c.id = m.channel_id
    WHERE m.channel_id IN (${channelIds.map(() => '?').join(',')})
      ${exceptRootId ? 'AND m.id != ?' : ''}
  `).all(...channelIds, ...(exceptRootId ? [exceptRootId] : []));

  const contained = rows.filter((r) => isAncestorOf(path, r.path));
  if (!contained.length) return null;
  const shown = contained.slice(0, 4).map((r) => `${r.channel}: ${r.path}`);
  return `"${path}" contains ${contained.length} media root(s) that already exist`
    + `, so it would re-scan everything they cover plus everything else under it — `
    + `the whole share, not just the broadcast folders. Roots inside it: `
    + `${shown.join('; ')}${contained.length > shown.length ? `; …and ${contained.length - shown.length} more` : ''}. `
    + 'Assign the specific folders you want to air, or delete those roots first if you '
    + 'really mean to replace them with this one.';
}

export const router = Router();

// Guard: only allow browsing within the configured SMB mount point, so this
// endpoint can't be turned into an arbitrary filesystem reader.
function withinMount(target) {
  const { smb } = loadConfig();
  const root = resolve(smb.mountPoint);
  const abs = resolve(target);
  return abs === root || abs.startsWith(root + '/') ? abs : null;
}

// POST /api/media/mount — mount the SMB share described in config.
router.post('/mount', async (req, res) => {
  try {
    const { smb } = loadConfig();
    const result = await mountShare(smb);
    res.json({ ok: true, mountPoint: smb.mountPoint, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// GET /api/media/status — is the share mounted?
router.get('/status', (req, res) => {
  const { smb } = loadConfig();
  res.json({ mountPoint: smb.mountPoint, mounted: isMounted(smb.mountPoint) });
});

// GET /api/media/browse?path=/Volumes/Drive/... — list child folders +
// video-file counts, powering the folder-tree picker. Defaults to mount root.
router.get('/browse', async (req, res) => {
  const { smb } = loadConfig();
  const target = req.query.path ? String(req.query.path) : smb.mountPoint;
  const abs = withinMount(target);
  if (!abs) {
    return res.status(400).json({ error: 'path is outside the configured mount point' });
  }
  try {
    // List via the local view of the path (config.pathMap); the paths returned
    // to the UI (and later stored as MediaRoots) stay canonical.
    const entries = await readdir(localizePath(abs), { withFileTypes: true });
    const folders = [];
    let fileCount = 0;
    for (const e of entries) {
      if (e.isDirectory()) folders.push({ name: e.name, path: join(abs, e.name) });
      else fileCount++;
    }
    folders.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: abs, folders, fileCount });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// GET /api/media/roots — list configured MediaRoots (with channel/showtype names).
router.get('/roots', (req, res) => {
  const rows = db.prepare(`
    SELECT mr.*, c.name AS channel_name, s.name AS show_type_name
    FROM MediaRoot mr
    JOIN ChannelType c ON c.id = mr.channel_id
    JOIN ShowType   s ON s.id = mr.show_type_id
    ORDER BY c.name, s.name
  `).all();
  res.json(rows);
});

// POST /api/media/roots  { channel_ids?: number[], channel_id?, show_type_id, path }
// Assign a browsed folder as a media root. Shared folders: pass channel_ids to
// register the same folder for several channels at once (one row per channel;
// each channel catalogs its own resources).
router.post('/roots', (req, res) => {
  const { channel_ids, channel_id, show_type_id, path } = req.body || {};
  const channels = Array.isArray(channel_ids) && channel_ids.length
    ? channel_ids.map(Number) : (channel_id ? [Number(channel_id)] : []);
  if (!channels.length || !show_type_id || !path) {
    return res.status(400).json({ error: 'at least one channel, show_type_id and path are required' });
  }
  const abs = withinMount(path);
  if (!abs) {
    return res.status(400).json({ error: 'path is outside the configured mount point' });
  }
  const contains = containedRootsError(abs, channels);
  if (contains) return res.status(409).json({ error: contains });
  const ins = db.prepare('INSERT OR IGNORE INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)');
  const created = [];
  let clonedResources = 0;
  try {
    for (const cid of channels) {
      const info = ins.run(cid, Number(show_type_id), abs);
      if (info.changes) {
        created.push({ id: info.lastInsertRowid, channel_id: cid, show_type_id: Number(show_type_id), path: abs });
        // Reuse an already-scanned copy of this folder from another channel so a
        // re-add doesn't force a fresh ffprobe pass. No-op if never scanned yet.
        clonedResources += cloneScannedResources(cid, Number(show_type_id), abs);
      }
    }
    res.status(201).json({ ok: true, created, clonedResources });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// POST /api/media/roots/copy  { from_channel_id, to_channel_ids: number[] }
// Give one or more channels the same media availability as an existing channel:
// every root of the donor is registered for each target, reusing the already
// scanned catalog (durations, operator fixes, approval) instead of re-probing.
// Roots a target already has are skipped, so this is safe to re-run.
router.post('/roots/copy', (req, res) => {
  const { from_channel_id, to_channel_ids } = req.body || {};
  const from = Number(from_channel_id);
  const targets = (Array.isArray(to_channel_ids) ? to_channel_ids : [])
    .map(Number).filter((id) => id && id !== from);
  if (!from || !targets.length) {
    return res.status(400).json({ error: 'from_channel_id and at least one other to_channel_ids entry are required' });
  }
  const roots = db.prepare('SELECT * FROM MediaRoot WHERE channel_id = ?').all(from);
  if (!roots.length) return res.status(400).json({ error: 'the source channel has no media roots' });

  // A donor root can be an ancestor of one the target already has, which would
  // widen the target's catalogue exactly the way a hand-added parent does.
  for (const r of roots) {
    const contains = containedRootsError(r.path, targets);
    if (contains) return res.status(409).json({ error: `copying "${r.path}": ${contains}` });
  }

  const ins = db.prepare('INSERT OR IGNORE INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)');
  const created = [];
  let clonedResources = 0;
  try {
    for (const cid of targets) {
      for (const r of roots) {
        const info = ins.run(cid, r.show_type_id, r.path);
        if (!info.changes) continue;
        created.push({ id: info.lastInsertRowid, channel_id: cid, show_type_id: r.show_type_id, path: r.path });
        clonedResources += cloneScannedResources(cid, r.show_type_id, r.path);
      }
    }
    res.status(201).json({ ok: true, created, clonedResources, sourceRoots: roots.length });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// PUT /api/media/roots/:id  { channel_id?, show_type_id?, path? }
// Edit a root's channel / show type (folder type) / path. A re-scan is needed
// afterwards to re-catalog under the new assignment.
router.put('/roots/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM MediaRoot WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'MediaRoot not found' });
  const b = req.body || {};
  let path = cur.path;
  if (b.path !== undefined) {
    const abs = withinMount(b.path);
    if (!abs) return res.status(400).json({ error: 'path is outside the configured mount point' });
    path = abs;
  }
  // Only a change that could WIDEN the root is checked. Re-saving a root whose
  // path is unchanged must stay possible even once deeper roots exist under it
  // — the catalogue deliberately has "Mathematics" alongside "Mathematics/Grade
  // 1", and otherwise the parent's show type could never be edited again.
  const targetChannel = b.channel_id != null ? Number(b.channel_id) : cur.channel_id;
  if (path !== cur.path || targetChannel !== cur.channel_id) {
    const contains = containedRootsError(path, [targetChannel], { exceptRootId: id });
    if (contains) return res.status(409).json({ error: contains });
  }
  try {
    db.prepare('UPDATE MediaRoot SET channel_id = ?, show_type_id = ?, path = ? WHERE id = ?').run(
      b.channel_id != null ? Number(b.channel_id) : cur.channel_id,
      b.show_type_id != null ? Number(b.show_type_id) : cur.show_type_id,
      path, id
    );
    res.json({ ok: true, rescanNeeded: true });
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
});

// DELETE /api/media/roots/:id — also drops the resources this root cataloged
// (there is no FK from Resource to MediaRoot, so do it explicitly). ScheduleItem
// and PlayHistory rows cascade off Resource. Matches files at the root itself and
// anywhere in its subtree, scoped to the root's channel + show type.
router.delete('/roots/:id', (req, res) => {
  const id = Number(req.params.id);
  const root = db.prepare('SELECT * FROM MediaRoot WHERE id = ?').get(id);
  if (!root) return res.json({ ok: true, deletedResources: 0 });
  const info = db.prepare(`
    DELETE FROM Resource
    WHERE channel_id = ? AND show_type_id = ?
      AND (file_path = ? OR file_path LIKE ? ESCAPE '\\')
  `).run(root.channel_id, root.show_type_id, root.path, root.path.replace(/[%_\\]/g, '\\$&') + '/%');
  db.prepare('DELETE FROM MediaRoot WHERE id = ?').run(id);
  res.json({ ok: true, deletedResources: info.changes });
});

// POST /api/media/scan  { channel_id?, force? }  — run ffprobe ingestion.
// A file already catalogued whose mtime has not moved reuses its stored
// duration; `force` (body or ?force=1) re-probes the whole tree, for when the
// catalogue is suspected wrong rather than merely out of date.
router.post('/scan', async (req, res) => {
  try {
    const channelId = req.body?.channel_id ? Number(req.body.channel_id) : undefined;
    const force = truthy(req.body?.force ?? req.query.force);
    const results = await scanAll({ channelId, force });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/media/recheck  { channel_id?, force? }
//
// Re-check ONLY the clips already catalogued, taking the file list from the
// database instead of walking the share. Use this to answer "are my clips still
// there and still the length I recorded?" — /scan is for discovering new
// content and has to readdir the whole NAS to do it.
//
// Nothing is ever deleted: a clip that has vanished is reported so the operator
// can act on it, because a block holding a missing file fails on air.
router.post('/recheck', async (req, res) => {
  try {
    const channelId = req.body?.channel_id ?? req.query.channel_id;
    const result = await recheckCatalog({
      channelId: channelId ? Number(channelId) : null,
      force: truthy(req.body?.force ?? req.query.force),
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/media/roots/:id/scan — scan a single media root.
router.post('/roots/:id/scan', async (req, res) => {
  const root = db.prepare('SELECT * FROM MediaRoot WHERE id = ?').get(Number(req.params.id));
  if (!root) return res.status(404).json({ error: 'MediaRoot not found' });
  try {
    const result = await scanMediaRoot(root, { force: truthy(req.body?.force ?? req.query.force) });
    res.json({ ok: true, mediaRoot: root, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});
