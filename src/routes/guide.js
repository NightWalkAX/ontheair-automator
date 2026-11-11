// /api/guide — the channel guide (src/services/guideConfig.js for the why).
//
//   GET  /status                    render state + counts for today on
//   POST /render {from,to,channels,blocks,force}   render missing/stale guides (background job)
//   POST /stop                      stop the running render after the clips in flight
//   GET  /blocks/:id/plan           what the guide of a block shows (JSON)
//   GET  /blocks/:id/page           the guide as the renderer sees it (open it in a browser to preview)
//   GET  /fallback/:channelId/page  the channel's "Stay with us" clip

import express from 'express';
import { localDate, addDays } from '../dates.js';
import { channelStyle, guideConfig } from '../services/guideConfig.js';
import { guidePlan } from '../services/guidePlan.js';
import { guideView, guideStatus, renderRange, stopGuideRender, guideHtml, identHtml } from '../services/guideRender.js';

export const router = express.Router();

router.get('/status', (_req, res) => res.json(guideStatus()));

router.post('/render', (req, res) => {
  const cfg = guideConfig({ fresh: true });
  if (!cfg.enabled) return res.status(409).json({ error: 'the channel guide is off — set guide.enabled in config/config.json' });
  const today = localDate();
  const from = String(req.body?.from || today);
  const to = String(req.body?.to || addDays(today, Number(cfg.daysAhead) || 0));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD, from ≤ to' });
  const channelIds = (Array.isArray(req.body?.channels) ? req.body.channels : String(req.body?.channels || '').split(','))
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (guideStatus().running) return res.status(409).json({ error: 'a guide render is already running', status: guideStatus() });
  const blockIds = (Array.isArray(req.body?.blocks) ? req.body.blocks : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  renderRange(from, to, { channelIds, force: !!req.body?.force, blockIds }).catch(() => { /* logged by the service */ });
  res.status(202).json(guideStatus());
});

router.post('/stop', (_req, res) => res.json(stopGuideRender()));

router.get('/blocks/:id/plan', (req, res) => {
  const plan = guidePlan(Number(req.params.id));
  if (!plan) return res.status(404).json({ error: 'no guide for this block (gone, no guide look for its channel, or nothing airs after it)' });
  res.json(plan);
});

router.get('/blocks/:id/page', async (req, res) => {
  const plan = guidePlan(Number(req.params.id));
  if (!plan) return res.status(404).type('text/plain').send('no guide for this block');
  try {
    const view = await guideView(plan, { frames: req.query.frames !== '0' });
    res.type('html').send(guideHtml(view));
  } catch (err) {
    res.status(500).type('text/plain').send(String(err.message || err));
  }
});

router.get('/fallback/:channelId/page', (req, res) => {
  const style = channelStyle(Number(req.params.channelId));
  if (!style) return res.status(404).type('text/plain').send('this channel has no guide look');
  res.type('html').send(identHtml(style, Number(guideConfig().seconds) || 20));
});
