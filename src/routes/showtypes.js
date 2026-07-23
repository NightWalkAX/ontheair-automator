// ShowType CRUD.

import { Router } from 'express';
import { db } from '../db.js';

export const router = Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM ShowType ORDER BY name').all());
});

router.post('/', (req, res) => {
  const { name, is_educational = 0 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare(
    'INSERT INTO ShowType (name, is_educational) VALUES (?, ?)'
  ).run(name, is_educational ? 1 : 0);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM ShowType WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const m = { ...cur, ...req.body };
  db.prepare('UPDATE ShowType SET name=?, is_educational=? WHERE id=?')
    .run(m.name, m.is_educational ? 1 : 0, id);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM ShowType WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});
