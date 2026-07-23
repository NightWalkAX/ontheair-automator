// BlockTemplate CRUD + ScheduledBlock/ScheduleItem review & approval API.
// Backs the admin review UI (Module B).

import { Router } from 'express';
import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { blockDurationSeconds, generateWeek, populateBlock } from '../services/scheduling.js';

export const router = Router();

// ---- Duration validation (shared truth for UI + server) --------------------
// A block "fits" when the total item duration does not exceed the block length
// (0s overrun ceiling) and is not more than maxUnderrun seconds short.
function validateBlock(blockId) {
  const block = db.prepare(`
    SELECT sb.*, bt.start_time, bt.end_time, bt.name AS template_name, bt.channel_id
    FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id
    WHERE sb.id = ?
  `).get(blockId);
  if (!block) return null;

  const items = db.prepare(`
    SELECT si.*, r.name, r.duration, r.is_filler
    FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id
    WHERE si.block_id = ? ORDER BY si.play_order
  `).all(blockId);

  const blockSeconds = blockDurationSeconds(block.start_time, block.end_time);
  const totalSeconds = items.reduce((s, i) => s + i.duration, 0);
  const diff = blockSeconds - totalSeconds; // >0 underrun, <0 overrun
  const maxUnderrun = loadConfig().filler?.maxUnderrunSeconds ?? 5;

  const overrun = diff < 0;
  const fits = !overrun && diff <= maxUnderrun;
  return { block, items, blockSeconds, totalSeconds, diff, overrun, maxUnderrun, fits };
}

// ---- BlockTemplate CRUD ----------------------------------------------------
router.get('/templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM BlockTemplate ORDER BY channel_id, weekday, start_time').all());
});

router.post('/templates', (req, res) => {
  const { channel_id, name, weekday, start_time, end_time, target_subject_id, target_subject, content_type = 'movie' } = req.body || {};
  if (!channel_id || !name || !weekday || !start_time || !end_time) {
    return res.status(400).json({ error: 'channel_id, name, weekday, start_time, end_time are required' });
  }
  const info = db.prepare(`
    INSERT INTO BlockTemplate (channel_id, name, weekday, start_time, end_time, target_subject_id, target_subject, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(channel_id, name, weekday, start_time, end_time, target_subject_id ?? null, target_subject || null, content_type);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.put('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM BlockTemplate WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const m = { ...cur, ...req.body };
  db.prepare(`
    UPDATE BlockTemplate SET channel_id=?, name=?, weekday=?, start_time=?, end_time=?, target_subject_id=?, target_subject=?, content_type=?
    WHERE id=?
  `).run(m.channel_id, m.name, m.weekday, m.start_time, m.end_time, m.target_subject_id, m.target_subject, m.content_type, id);
  res.json({ ok: true });
});

router.delete('/templates/:id', (req, res) => {
  db.prepare('DELETE FROM BlockTemplate WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Generation ------------------------------------------------------------
// POST /api/blocks/generate?weekStart=YYYY-MM-DD (defaults to today)
router.post('/generate', (req, res) => {
  const ws = req.query.weekStart ? new Date(String(req.query.weekStart) + 'T00:00:00') : new Date();
  try {
    const results = generateWeek(ws);
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// POST /api/blocks/:id/regenerate — repopulate one block (keeps manual items).
router.post('/:id/regenerate', (req, res) => {
  const block = db.prepare('SELECT * FROM ScheduledBlock WHERE id = ?').get(Number(req.params.id));
  if (!block) return res.status(404).json({ error: 'not found' });
  res.json(populateBlock(block));
});

// ---- Review ----------------------------------------------------------------
// GET /api/blocks?week=YYYY-MM-DD — the 7-day window starting at `week`.
router.get('/', (req, res) => {
  const start = req.query.week ? new Date(String(req.query.week) + 'T00:00:00') : new Date();
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const rows = db.prepare(`
    SELECT sb.id, sb.target_date, sb.status, bt.name AS template_name,
           bt.channel_id, bt.weekday, bt.start_time, bt.end_time, bt.content_type,
           c.name AS channel_name
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN ChannelType   c  ON c.id = bt.channel_id
    WHERE sb.target_date BETWEEN ? AND ?
    ORDER BY sb.target_date, c.name, bt.start_time
  `).all(dates[0], dates[6]);

  // Attach validation summary so the UI can render tolerance badges directly.
  const blocks = rows.map((r) => {
    const v = validateBlock(r.id);
    return { ...r, blockSeconds: v.blockSeconds, totalSeconds: v.totalSeconds, diff: v.diff, fits: v.fits };
  });
  res.json({ week: dates, blocks });
});

// GET /api/blocks/:id — full block with ordered items + validation.
router.get('/:id', (req, res) => {
  const v = validateBlock(Number(req.params.id));
  if (!v) return res.status(404).json({ error: 'not found' });
  res.json(v);
});

// PUT /api/blocks/:id/items — replace the ordered item list (manual edit).
// Body: { items: [{ resource_id, is_manual_override? }] } in play order.
router.put('/:id/items', (req, res) => {
  const id = Number(req.params.id);
  const block = db.prepare('SELECT * FROM ScheduledBlock WHERE id = ?').get(id);
  if (!block) return res.status(404).json({ error: 'not found' });
  const items = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!items) return res.status(400).json({ error: 'items array is required' });

  const tx = db.prepare('DELETE FROM ScheduleItem WHERE block_id = ?');
  const ins = db.prepare(
    'INSERT INTO ScheduleItem (block_id, resource_id, play_order, is_manual_override) VALUES (?, ?, ?, ?)'
  );
  tx.run(id);
  items.forEach((it, idx) => ins.run(id, it.resource_id, idx, it.is_manual_override ? 1 : 0));

  res.json(validateBlock(id));
});

// POST /api/blocks/:id/approve — server-side re-validation before approving,
// so a stale client can't push an out-of-tolerance block through.
router.post('/:id/approve', (req, res) => {
  const id = Number(req.params.id);
  const v = validateBlock(id);
  if (!v) return res.status(404).json({ error: 'not found' });
  if (!v.fits) {
    return res.status(409).json({
      error: 'block is outside the filler tolerance and cannot be approved',
      diff: v.diff, overrun: v.overrun, maxUnderrun: v.maxUnderrun,
    });
  }
  db.prepare("UPDATE ScheduledBlock SET status = 'approved' WHERE id = ?").run(id);
  res.json({ ok: true, status: 'approved' });
});

// POST /api/blocks/approve-week?week=YYYY-MM-DD — approve every fitting draft.
router.post('/approve-week', (req, res) => {
  const start = req.query.week ? new Date(String(req.query.week) + 'T00:00:00') : new Date();
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const drafts = db.prepare(
    "SELECT id FROM ScheduledBlock WHERE status='draft' AND target_date BETWEEN ? AND ?"
  ).all(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));

  const approved = [], blocked = [];
  for (const { id } of drafts) {
    const v = validateBlock(id);
    if (v.fits) { db.prepare("UPDATE ScheduledBlock SET status='approved' WHERE id=?").run(id); approved.push(id); }
    else blocked.push({ id, diff: v.diff });
  }
  res.json({ ok: blocked.length === 0, approved, blocked });
});
