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
    SELECT sb.*,
           COALESCE(s.start_time, bt.start_time) AS start_time,
           COALESCE(s.end_time, bt.end_time)     AS end_time,
           s.slot_order AS slot_order,
           bt.name AS template_name, bt.channel_id
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.id = ?
  `).get(blockId);
  if (!block) return null;

  const items = db.prepare(`
    SELECT si.*, r.name, r.duration, r.is_filler, r.subject, r.chapter
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

// Normalize weekdays to a CSV string from an array or a string.
function toWeekdaysCsv(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean).join(',');
  return String(v || '').split(',').map((s) => s.trim()).filter(Boolean).join(',');
}

// Replace a template's time slots. `slots` is [{ start_time, end_time }]; the
// first is the primary airing (slot_order 0), the rest mirror it.
function setSlots(templateId, slots) {
  db.prepare('DELETE FROM BlockTemplateSlot WHERE template_id = ?').run(templateId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (?, ?, ?, ?)'
  );
  slots.forEach((s, idx) => ins.run(templateId, s.start_time, s.end_time, idx));
}

// Replace a template's assigned series. `series` is an ordered list of subject
// strings (or { subject } objects).
function setSeries(templateId, series) {
  db.prepare('DELETE FROM BlockTemplateSeries WHERE template_id = ?').run(templateId);
  const ins = db.prepare(
    'INSERT OR IGNORE INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, ?, ?)'
  );
  series.forEach((s, idx) => ins.run(templateId, typeof s === 'string' ? s : s.subject, idx));
}

function templateWithDetails(t) {
  return {
    ...t,
    slots: db.prepare('SELECT id, start_time, end_time, slot_order FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order').all(t.id),
    series: db.prepare('SELECT subject, play_order FROM BlockTemplateSeries WHERE template_id = ? ORDER BY play_order').all(t.id),
  };
}

router.get('/templates', (req, res) => {
  const rows = db.prepare('SELECT * FROM BlockTemplate ORDER BY channel_id, name').all();
  res.json(rows.map(templateWithDetails));
});

router.post('/templates', (req, res) => {
  const b = req.body || {};
  const weekdays = toWeekdaysCsv(b.weekdays ?? b.weekday);
  const slots = Array.isArray(b.slots) && b.slots.length
    ? b.slots
    : (b.start_time && b.end_time ? [{ start_time: b.start_time, end_time: b.end_time }] : []);
  if (!b.channel_id || !b.name || !weekdays || !slots.length) {
    return res.status(400).json({ error: 'channel_id, name, weekdays and at least one time slot are required' });
  }
  const primary = slots[0];
  const firstWeekday = weekdays.split(',')[0];
  const info = db.prepare(`
    INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, target_subject_id, target_subject, content_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(b.channel_id, b.name, firstWeekday, weekdays, primary.start_time, primary.end_time,
         b.target_subject_id ?? null, b.target_subject || null, b.content_type || 'movie');
  const id = info.lastInsertRowid;
  setSlots(id, slots);
  if (Array.isArray(b.series)) setSeries(id, b.series);
  res.status(201).json({ id });
});

router.put('/templates/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM BlockTemplate WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const weekdays = b.weekdays !== undefined || b.weekday !== undefined
    ? toWeekdaysCsv(b.weekdays ?? b.weekday) : cur.weekdays;
  const slots = Array.isArray(b.slots) && b.slots.length ? b.slots : null;
  const primary = slots ? slots[0] : { start_time: b.start_time ?? cur.start_time, end_time: b.end_time ?? cur.end_time };
  db.prepare(`
    UPDATE BlockTemplate SET channel_id=?, name=?, weekday=?, weekdays=?, start_time=?, end_time=?, target_subject_id=?, target_subject=?, content_type=?
    WHERE id=?
  `).run(
    b.channel_id ?? cur.channel_id, b.name ?? cur.name,
    (weekdays || '').split(',')[0] || cur.weekday, weekdays,
    primary.start_time, primary.end_time,
    b.target_subject_id ?? cur.target_subject_id, b.target_subject ?? cur.target_subject,
    b.content_type ?? cur.content_type, id
  );
  if (slots) setSlots(id, slots);
  if (Array.isArray(b.series)) setSeries(id, b.series);
  res.json({ ok: true });
});

router.delete('/templates/:id', (req, res) => {
  db.prepare('DELETE FROM BlockTemplate WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- Template series & slots sub-resources ---------------------------------
router.get('/templates/:id/series', (req, res) => {
  res.json(db.prepare(
    'SELECT subject, play_order FROM BlockTemplateSeries WHERE template_id = ? ORDER BY play_order'
  ).all(Number(req.params.id)));
});

router.put('/templates/:id/series', (req, res) => {
  const list = Array.isArray(req.body?.series) ? req.body.series : null;
  if (!list) return res.status(400).json({ error: 'series array is required' });
  setSeries(Number(req.params.id), list);
  res.json({ ok: true });
});

router.get('/templates/:id/slots', (req, res) => {
  res.json(db.prepare(
    'SELECT id, start_time, end_time, slot_order FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order'
  ).all(Number(req.params.id)));
});

router.put('/templates/:id/slots', (req, res) => {
  const list = Array.isArray(req.body?.slots) ? req.body.slots : null;
  if (!list || !list.length) return res.status(400).json({ error: 'slots array is required' });
  setSlots(Number(req.params.id), list);
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
    SELECT sb.id, sb.target_date, sb.status, sb.slot_id, bt.name AS template_name,
           bt.channel_id, bt.weekday, bt.content_type,
           COALESCE(s.start_time, bt.start_time) AS start_time,
           COALESCE(s.end_time, bt.end_time)     AS end_time,
           COALESCE(s.slot_order, 0)             AS slot_order,
           c.name AS channel_name
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN ChannelType   c  ON c.id = bt.channel_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.target_date BETWEEN ? AND ?
    ORDER BY sb.target_date, c.name, start_time
  `).all(dates[0], dates[6]);

  // Attach validation summary so the UI can render tolerance badges directly.
  const blocks = rows.map((r) => {
    const v = validateBlock(r.id);
    return { ...r, is_mirror: r.slot_order > 0, blockSeconds: v.blockSeconds, totalSeconds: v.totalSeconds, diff: v.diff, fits: v.fits };
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
  const block = db.prepare(`
    SELECT sb.*, COALESCE(s.slot_order, 0) AS slot_order
    FROM ScheduledBlock sb LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.id = ?
  `).get(id);
  if (!block) return res.status(404).json({ error: 'not found' });
  if (block.slot_order > 0) {
    return res.status(409).json({ error: 'this is a mirrored airing — edit its primary airing instead' });
  }
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
