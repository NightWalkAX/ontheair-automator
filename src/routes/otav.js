// OTAV push routes (Module C trigger).

import { Router } from 'express';
import { pushApprovedBlocks, pushApprovedRange, checkChannel, diagnoseChannel } from '../services/otavClient.js';

export const router = Router();

// POST /api/otav/push — "Push to Air". One day (?date=), a week starting at a
// date (?week=, 7 days), or an explicit range (?from=&to=). A template that
// repeats on several weekdays needs every one of those dates pushed: each date
// gets its own playlist and its own schedule event.
const DATE = /^\d{4}-\d{2}-\d{2}$/;
router.post('/push', async (req, res) => {
  const q = { ...req.body, ...req.query };
  const date = String(q.date || '').slice(0, 10);
  const week = String(q.week || '').slice(0, 10);
  const from = String(q.from || '').slice(0, 10);
  const to = String(q.to || '').slice(0, 10);
  try {
    if (DATE.test(week)) {
      const end = new Date(`${week}T00:00:00Z`);
      end.setUTCDate(end.getUTCDate() + 6);
      return res.json({ ok: true, ...(await pushApprovedRange(week, end.toISOString().slice(0, 10))) });
    }
    if (DATE.test(from) && DATE.test(to)) {
      if (to < from) return res.status(400).json({ error: 'to must not precede from' });
      return res.json({ ok: true, ...(await pushApprovedRange(from, to)) });
    }
    if (DATE.test(date)) {
      return res.json({ ok: true, ...(await pushApprovedBlocks(date)) });
    }
    return res.status(400).json({ error: 'date=YYYY-MM-DD, week=YYYY-MM-DD, or from=&to= is required' });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// GET /api/otav/diagnose/:channelId?date=YYYY-MM-DD — read-only probe of what
// that OTAV instance supports (version, scheduler, open playlists, schedule
// folder) plus the playlist name a push for that date would target.
// With ?probe_create=1 it also tries every candidate playlist-creation route
// against the live instance (this one writes) and reports what each answered.
router.get('/diagnose/:channelId', async (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const probeCreate = req.query.probe_create === '1';
  try {
    res.json({ ok: true, ...(await diagnoseChannel(Number(req.params.channelId), date, { probeCreate })) });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
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
