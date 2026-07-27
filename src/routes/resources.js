// Resource listing + metadata editing. Rows are created by ingestion; this
// route lets an admin fix subject/chapter/filler/rating that ffprobe can't
// infer, and list/filter the catalog.

import { Router } from 'express';
import { db } from '../db.js';
import { EPISODE_NO_CTE, withLabel } from '../services/labels.js';

export const router = Router();

// Every row leaves this route carrying episode_no / episode_code / label so no
// caller has to render the internal `chapter` number at an operator.
const SELECT_WITH_LABEL = `
  WITH ${EPISODE_NO_CTE}
  SELECT r.*, en.episode_no, ov.display_name AS display_name, st.code AS show_type_code
  FROM Resource r
  LEFT JOIN EpisodeNo en ON en.id = r.id
  LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
  LEFT JOIN ShowType st ON st.id = r.show_type_id
`;

// GET /api/resources?channel_id=&subject=&is_filler=
router.get('/', (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.channel_id) { clauses.push('r.channel_id = ?'); params.push(Number(req.query.channel_id)); }
  if (req.query.subject)    { clauses.push('r.subject = ?');    params.push(String(req.query.subject)); }
  if (req.query.is_filler != null) { clauses.push('r.is_filler = ?'); params.push(req.query.is_filler === '1' || req.query.is_filler === 'true' ? 1 : 0); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(
    `${SELECT_WITH_LABEL} ${where} ORDER BY r.subject, r.season, r.chapter, r.name`
  ).all(...params);
  res.json(rows.map(withLabel));
});

router.get('/:id', (req, res) => {
  const row = db.prepare(`${SELECT_WITH_LABEL} WHERE r.id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(withLabel(row));
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
