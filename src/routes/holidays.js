// Seasonal programming — the holidays a film can be marked with (see
// services/holidays.js for the scheduling rule).
//
// GET    /api/holidays              every holiday, with how many files it marks
// GET    /api/holidays/on?date=     the holidays covering a date
// POST   /api/holidays              { name, start_md, end_md, color?, active? }
// PUT    /api/holidays/:id          any of the above
// DELETE /api/holidays/:id          also unmarks its files
// GET    /api/holidays/:id/files    the files it marks, with a name per file

import { Router } from 'express';
import { db } from '../db.js';
import { holidaysOn, isMonthDay, listHolidays } from '../services/holidays.js';

export const router = Router();

router.get('/', (req, res) => res.json(listHolidays()));

router.get('/on', (req, res) => res.json(holidaysOn(String(req.query.date || '').slice(0, 10))));

/** Validate a body into columns, or return an error string. */
function columns(body, partial = false) {
  const out = {};
  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? '').trim();
    if (!name) return 'name is required';
    out.name = name.slice(0, 80);
  }
  for (const k of ['start_md', 'end_md']) {
    if (body[k] !== undefined || !partial) {
      if (!isMonthDay(body[k])) return `${k} must be MM-DD`;
      out[k] = body[k];
    }
  }
  if (body.color !== undefined) {
    out.color = /^#[0-9a-f]{6}$/i.test(String(body.color)) ? String(body.color) : null;
  }
  if (body.active !== undefined) out.active = body.active ? 1 : 0;
  return out;
}

router.post('/', (req, res) => {
  const c = columns(req.body || {});
  if (typeof c === 'string') return res.status(400).json({ error: c });
  try {
    const row = db.prepare(`INSERT INTO Holiday (name, start_md, end_md, color, active)
      VALUES (?, ?, ?, ?, ?) RETURNING *`).get(c.name, c.start_md, c.end_md, c.color ?? null, c.active ?? 1);
    res.status(201).json(row);
  } catch (err) {
    res.status(/UNIQUE/.test(err.message) ? 409 : 500).json({ error: /UNIQUE/.test(err.message) ? 'a holiday with that name exists' : err.message });
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM Holiday WHERE id = ?').get(id)) return res.status(404).json({ error: 'not found' });
  const c = columns(req.body || {}, true);
  if (typeof c === 'string') return res.status(400).json({ error: c });
  const keys = Object.keys(c);
  if (keys.length) {
    try {
      db.prepare(`UPDATE Holiday SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => c[k]), id);
    } catch (err) {
      return res.status(/UNIQUE/.test(err.message) ? 409 : 500).json({ error: err.message });
    }
  }
  res.json(db.prepare('SELECT * FROM Holiday WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM Holiday WHERE id = ?').run(Number(req.params.id));
  res.status(r.changes ? 200 : 404).json({ ok: !!r.changes });
});

router.get('/:id/files', (req, res) => {
  res.json(db.prepare(`
    SELECT hf.file_path, MIN(r.name) AS name, COUNT(r.id) AS copies
    FROM HolidayFile hf LEFT JOIN Resource r ON r.file_path = hf.file_path
    WHERE hf.holiday_id = ? GROUP BY hf.file_path ORDER BY name
  `).all(Number(req.params.id)));
});
