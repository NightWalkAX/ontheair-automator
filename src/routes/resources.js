// Resource listing + metadata editing. Rows are created by ingestion; this
// route lets an admin fix subject/chapter/filler/rating that ffprobe can't
// infer, and list/filter the catalog.

import { Router } from 'express';
import { db } from '../db.js';

export const router = Router();

// GET /api/resources?channel_id=&subject=&is_filler=
router.get('/', (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.channel_id) { clauses.push('channel_id = ?'); params.push(Number(req.query.channel_id)); }
  if (req.query.subject)    { clauses.push('subject = ?');    params.push(String(req.query.subject)); }
  if (req.query.is_filler != null) { clauses.push('is_filler = ?'); params.push(req.query.is_filler === '1' || req.query.is_filler === 'true' ? 1 : 0); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  res.json(db.prepare(`SELECT * FROM Resource ${where} ORDER BY subject, chapter, name`).all(...params));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM Resource WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

// PUT /api/resources/:id — edit the admin-controlled metadata fields only.
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM Resource WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const m = { ...cur, ...req.body };
  db.prepare(`
    UPDATE Resource SET name=?, subject=?, chapter=?, is_filler=?, audience_rating=?, show_type_id=?
    WHERE id=?
  `).run(m.name, m.subject, m.chapter | 0, m.is_filler ? 1 : 0, m.audience_rating, m.show_type_id, id);
  res.json({ ok: true });
});

export const router_resources = router;
