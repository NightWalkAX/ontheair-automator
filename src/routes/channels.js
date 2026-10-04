// ChannelType CRUD — one row per OTAV instance (6 channels).

import { Router } from 'express';
import { db, withTx } from '../db.js';
import { loadConfig, updateConfig } from '../config.js';
import { isPushRunning } from '../services/otavClient.js';
import { localDate } from '../dates.js';
import { log } from '../logger.js';

const l = log('channels');

export const router = Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM ChannelType ORDER BY name').all());
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const { name, is_active = 1, api_ip, api_port, playlist_ref, playlist_name_pattern,
          schedule_path, playlist_dir, playlist_template, api_username, api_password,
          logo_filename, logo_enabled = 1 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  // Every optional column takes `?? null`, api_ip/api_port included: node:sqlite
  // refuses to bind `undefined`, so registering a channel before its Mac has an
  // address used to die on a 500 naming "SQLite parameter 3".
  const info = db.prepare(`
    INSERT INTO ChannelType (name, is_active, api_ip, api_port, playlist_ref, playlist_name_pattern,
                             schedule_path, playlist_dir, playlist_template, api_username, api_password,
                             logo_filename, logo_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, is_active ? 1 : 0, api_ip ?? null, api_port ?? null,
         playlist_ref ?? null, playlist_name_pattern ?? null,
         schedule_path ?? null, playlist_dir ?? null, playlist_template ?? null,
         api_username ?? null, api_password ?? null,
         logo_filename ?? null, logo_enabled ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const m = { ...cur, ...req.body };
  db.prepare(`
    UPDATE ChannelType SET name=?, is_active=?, api_ip=?, api_port=?, playlist_ref=?, playlist_name_pattern=?,
                           schedule_path=?, playlist_dir=?, playlist_template=?, api_username=?, api_password=?,
                           logo_filename=?, logo_enabled=?
    WHERE id=?
  `).run(m.name, m.is_active ? 1 : 0, m.api_ip, m.api_port, m.playlist_ref, m.playlist_name_pattern ?? null,
         m.schedule_path ?? null, m.playlist_dir ?? null, m.playlist_template ?? null,
         m.api_username, m.api_password,
         m.logo_filename ?? null, m.logo_enabled ? 1 : 0, id);
  res.json({ ok: true });
});

// --- Deleting a channel ---------------------------------------------------------
// Every table that belongs to a channel cascades from ChannelType, so a bare
// DELETE wiped far more than the channel: a template whose PRIMARY channel was
// the deleted one went with it for every other channel it airs on, and the
// operator got no idea of the size of what was about to go. So the delete
// previews first, keeps shared templates alive by handing them to another of
// their channels, and refuses while that channel's days are on a playout Mac.

/** What deleting channel `id` would remove or change. Null when it doesn't exist. */
export function deletePreview(id) {
  const ch = db.prepare('SELECT id, name, is_active FROM ChannelType WHERE id = ?').get(id);
  if (!ch) return null;
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  const today = localDate();
  const shared = db.prepare(`
    SELECT bt.id, bt.name FROM BlockTemplate bt
    WHERE bt.channel_id = ? AND EXISTS (
      SELECT 1 FROM BlockTemplateChannel btc WHERE btc.template_id = bt.id AND btc.channel_id != ?)
  `).all(id, id);
  const cfg = loadConfig();
  return {
    channel: ch,
    resources: n('SELECT COUNT(*) AS n FROM Resource WHERE channel_id = ?', id),
    mediaRoots: n('SELECT COUNT(*) AS n FROM MediaRoot WHERE channel_id = ?', id),
    series: n('SELECT COUNT(*) AS n FROM ChannelSeries WHERE channel_id = ?', id),
    playHistory: n('SELECT COUNT(*) AS n FROM PlayHistory WHERE channel_id = ?', id),
    // Templates that air ONLY here go; shared ones stay and get a new owner.
    templatesDeleted: n(`SELECT COUNT(*) AS n FROM BlockTemplate bt WHERE bt.channel_id = ? AND NOT EXISTS (
      SELECT 1 FROM BlockTemplateChannel btc WHERE btc.template_id = bt.id AND btc.channel_id != ?)`, id, id),
    templatesKept: shared,
    blocks: Object.fromEntries(db.prepare(`
      SELECT sb.status, COUNT(*) AS n FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id
      WHERE COALESCE(sb.channel_id, bt.channel_id) = ? GROUP BY sb.status`).all(id).map((r) => [r.status, r.n])),
    exportedFromToday: n(`
      SELECT COUNT(*) AS n FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id
      WHERE COALESCE(sb.channel_id, bt.channel_id) = ? AND sb.status = 'exported' AND sb.target_date >= ?`, id, today),
    monitorFeeds: (Array.isArray(cfg.monitor?.sources) ? cfg.monitor.sources : [])
      .filter((src) => Number(src.channelId) === id).map((src) => src.name || src.id),
  };
}

// GET /api/channels/:id/delete-preview
router.get('/:id/delete-preview', (req, res) => {
  const p = deletePreview(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

// DELETE /api/channels/:id[?force=1]
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const p = deletePreview(id);
  if (!p) return res.status(404).json({ error: 'not found' });
  if (isPushRunning()) {
    return res.status(409).json({ error: 'a push is running — wait for it to finish before deleting a channel' });
  }
  const force = ['1', 'true'].includes(String(req.query.force ?? req.body?.force ?? ''));
  if (p.exportedFromToday && !force) {
    return res.status(409).json({
      error: `${p.channel.name} has ${p.exportedFromToday} block(s) from today on already pushed to OTAV — `
        + 'its playout Mac keeps airing them. Confirm to delete anyway.',
      needsConfirm: 'exported', preview: p,
    });
  }
  try {
    withTx(() => {
      // Shared templates move to another of their channels, so the cascade
      // below doesn't take them away from everybody else.
      const other = db.prepare(
        'SELECT MIN(channel_id) AS c FROM BlockTemplateChannel WHERE template_id = ? AND channel_id != ?',
      );
      const own = db.prepare('UPDATE BlockTemplate SET channel_id = ? WHERE id = ?');
      for (const t of p.templatesKept) own.run(other.get(t.id, id).c, t.id);
      // Air Spec's queue is keyed by file: point it at a surviving copy.
      db.prepare(`UPDATE TranscodeItem SET channel_id = (
          SELECT MIN(r.channel_id) FROM Resource r WHERE r.file_path = TranscodeItem.file_path AND r.channel_id != ?)
        WHERE channel_id = ?`).run(id, id);
      db.prepare('DELETE FROM ChannelType WHERE id = ?').run(id);
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
  if (p.monitorFeeds.length) {
    updateConfig((c) => {
      for (const src of c.monitor?.sources || []) if (Number(src.channelId) === id) delete src.channelId;
    });
  }
  l.info(`deleted channel ${id} "${p.channel.name}": ${p.resources} clip row(s), ${p.templatesDeleted} template(s); `
    + `${p.templatesKept.length} shared template(s) kept`);
  res.json({ ok: true, deleted: p });
});
