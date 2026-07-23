// ShowType — read-only. The catalogue is a fixed set of 5 seeded types
// (Movies, Documentaries, TV Shows, Lessons, Fillers; see db.js seedShowTypes),
// so create/update/delete are intentionally disabled.

import { Router } from 'express';
import { db } from '../db.js';

export const router = Router();

router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM ShowType ORDER BY id').all());
});

const locked = (req, res) =>
  res.status(405).json({ error: 'show types are a fixed catalogue and cannot be modified' });

router.post('/', locked);
router.put('/:id', locked);
router.delete('/:id', locked);
