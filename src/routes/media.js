// Media routes: mount the SMB share, browse its folder tree, and assign a
// chosen folder as a MediaRoot (Channel + ShowType), then trigger ingestion.

import { Router } from 'express';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { mountShare, isMounted } from '../services/smbMount.js';
import { scanAll, scanMediaRoot } from '../services/ingestion.js';

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
    const entries = await readdir(abs, { withFileTypes: true });
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
  const ins = db.prepare('INSERT OR IGNORE INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)');
  const created = [];
  try {
    for (const cid of channels) {
      const info = ins.run(cid, Number(show_type_id), abs);
      if (info.changes) created.push({ id: info.lastInsertRowid, channel_id: cid, show_type_id: Number(show_type_id), path: abs });
    }
    res.status(201).json({ ok: true, created });
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

// POST /api/media/scan  { channel_id? }  — run ffprobe ingestion.
router.post('/scan', async (req, res) => {
  try {
    const channelId = req.body?.channel_id ? Number(req.body.channel_id) : undefined;
    const results = await scanAll({ channelId });
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/media/roots/:id/scan — scan a single media root.
router.post('/roots/:id/scan', async (req, res) => {
  const root = db.prepare('SELECT * FROM MediaRoot WHERE id = ?').get(Number(req.params.id));
  if (!root) return res.status(404).json({ error: 'MediaRoot not found' });
  try {
    const result = await scanMediaRoot(root);
    res.json({ ok: true, mediaRoot: root, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});
