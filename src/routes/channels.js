// ChannelType CRUD — one row per OTAV instance (6 channels).

import { Router } from 'express';
import { db } from '../db.js';

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
  const info = db.prepare(`
    INSERT INTO ChannelType (name, is_active, api_ip, api_port, playlist_ref, playlist_name_pattern,
                             schedule_path, playlist_dir, playlist_template, api_username, api_password,
                             logo_filename, logo_enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, is_active ? 1 : 0, api_ip, api_port, playlist_ref ?? null, playlist_name_pattern ?? null,
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

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM ChannelType WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
