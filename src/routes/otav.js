// OTAV push routes (Module C trigger).

import { Router } from 'express';
import { pushApprovedBlocks, checkChannel } from '../services/otavClient.js';

export const router = Router();

// POST /api/otav/push?date=YYYY-MM-DD  — "Push to Air".
router.post('/push', async (req, res) => {
  const date = String(req.query.date || req.body?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });
  }
  try {
    const report = await pushApprovedBlocks(date);
    res.json({ ok: true, ...report });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// GET /api/otav/check/:channelId — connectivity/auth probe against /info.
router.get('/check/:channelId', async (req, res) => {
  try {
    const info = await checkChannel(Number(req.params.channelId));
    res.json({ ok: true, info });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
});
