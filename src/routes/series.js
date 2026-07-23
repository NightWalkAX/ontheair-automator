// Per-channel series registry API.
//
// A "series" is a distinct Resource.subject on a channel. Ingestion auto-registers
// them (see services/ingestion.js); this router lets the admin order them
// (reproduction order), toggle active/serial, and inspect their chapters. Mounted
// alongside the channels router at /api/channels.

import { Router } from 'express';
import { db } from '../db.js';

export const router = Router();

const SERIAL_DEFAULT_CODES = new Set(['lessons', 'tv_shows']);

// Ensure a ChannelSeries row exists for (channel, subject) so a cursor write has
// something to update. Adopts the subject's show type and serial default when
// creating. No-op if the row already exists.
function ensureSeriesRow(channelId, subject) {
  const showTypeId = db.prepare(`
    SELECT show_type_id FROM Resource
    WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND show_type_id IS NOT NULL
    ORDER BY id LIMIT 1
  `).get(channelId, subject)?.show_type_id ?? null;
  const code = showTypeId ? db.prepare('SELECT code FROM ShowType WHERE id = ?').get(showTypeId)?.code : null;
  const isSerial = code && SERIAL_DEFAULT_CODES.has(code) ? 1 : 0;
  const nextOrder = db.prepare(
    'SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ChannelSeries WHERE channel_id = ?'
  ).get(channelId).n;
  db.prepare(`
    INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
    VALUES (?, ?, ?, ?, 1, ?)
  `).run(channelId, subject, showTypeId, isSerial, nextOrder);
}

// GET /api/channels/:id/series — registry rows with chapter counts + show type.
router.get('/:id/series', (req, res) => {
  const channelId = Number(req.params.id);
  const rows = db.prepare(`
    SELECT cs.*, st.name AS show_type_name, st.code AS show_code,
      (SELECT COUNT(*) FROM Resource r
         WHERE r.channel_id = cs.channel_id AND r.subject = cs.subject AND r.is_filler = 0) AS chapter_count,
      (SELECT COALESCE(SUM(r.duration), 0) FROM Resource r
         WHERE r.channel_id = cs.channel_id AND r.subject = cs.subject AND r.is_filler = 0) AS total_duration
    FROM ChannelSeries cs
    LEFT JOIN ShowType st ON st.id = cs.show_type_id
    WHERE cs.channel_id = ?
    ORDER BY cs.play_order, cs.subject
  `).all(channelId);
  res.json(rows);
});

// PUT /api/channels/:id/series — bulk upsert order/flags.
// Body: { series: [{ subject, play_order, is_active, is_serial, show_type_id }] }
router.put('/:id/series', (req, res) => {
  const channelId = Number(req.params.id);
  const list = Array.isArray(req.body?.series) ? req.body.series : null;
  if (!list) return res.status(400).json({ error: 'series array is required' });

  const upsert = db.prepare(`
    INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
    VALUES (@channel_id, @subject, @show_type_id, @is_serial, @is_active, @play_order)
    ON CONFLICT(channel_id, subject) DO UPDATE SET
      show_type_id = excluded.show_type_id,
      is_serial    = excluded.is_serial,
      is_active    = excluded.is_active,
      play_order   = excluded.play_order
  `);
  list.forEach((s, idx) => upsert.run({
    channel_id: channelId,
    subject: String(s.subject),
    show_type_id: s.show_type_id ?? null,
    is_serial: s.is_serial ? 1 : 0,
    is_active: s.is_active === undefined ? 1 : (s.is_active ? 1 : 0),
    play_order: s.play_order ?? idx,
  }));
  res.json({ ok: true });
});

// GET /api/channels/:id/series/:subject/chapters — ordered chapters for a series.
router.get('/:id/series/:subject/chapters', (req, res) => {
  const channelId = Number(req.params.id);
  const subject = decodeURIComponent(req.params.subject);
  const rows = db.prepare(`
    SELECT id, name, chapter, duration, added_at
    FROM Resource
    WHERE channel_id = ? AND subject = ? AND is_filler = 0
    ORDER BY chapter, id
  `).all(channelId, subject);
  res.json(rows);
});

// Bounds (lowest/highest chapter) of a serial subject on a channel.
function chapterBounds(channelId, subject) {
  return db.prepare(`
    SELECT MIN(chapter) AS lo, MAX(chapter) AS hi FROM Resource
    WHERE channel_id = ? AND subject = ? AND is_filler = 0
  `).get(channelId, subject);
}

// GET /api/channels/:id/series/:subject/cursor — the chapter that will play next.
router.get('/:id/series/:subject/cursor', (req, res) => {
  const channelId = Number(req.params.id);
  const subject = decodeURIComponent(req.params.subject);
  const row = db.prepare(
    'SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?'
  ).get(channelId, subject);
  const b = chapterBounds(channelId, subject);
  // Null cursor = "derive from history"; report the lowest chapter as the effective start.
  const cursor = row?.cursor_chapter ?? b?.lo ?? 1;
  res.json({ cursor, lo: b?.lo ?? null, hi: b?.hi ?? null });
});

// POST /api/channels/:id/series/:subject/cursor { delta } — nudge ±1 (or ±n),
// clamped to the series' chapter range.
router.post('/:id/series/:subject/cursor', (req, res) => {
  const channelId = Number(req.params.id);
  const subject = decodeURIComponent(req.params.subject);
  const delta = Number(req.body?.delta || 0);
  const b = chapterBounds(channelId, subject);
  if (b?.lo == null) return res.status(404).json({ error: 'series has no chapters' });
  ensureSeriesRow(channelId, subject);
  const row = db.prepare(
    'SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?'
  ).get(channelId, subject);
  const current = row?.cursor_chapter ?? b.lo;
  const next = Math.max(b.lo, Math.min(b.hi, current + delta));
  db.prepare(
    'UPDATE ChannelSeries SET cursor_chapter = ? WHERE channel_id = ? AND subject = ?'
  ).run(next, channelId, subject);
  res.json({ ok: true, cursor: next, lo: b.lo, hi: b.hi });
});

// PUT /api/channels/:id/series/:subject/cursor { chapter } — set absolutely.
router.put('/:id/series/:subject/cursor', (req, res) => {
  const channelId = Number(req.params.id);
  const subject = decodeURIComponent(req.params.subject);
  const b = chapterBounds(channelId, subject);
  if (b?.lo == null) return res.status(404).json({ error: 'series has no chapters' });
  ensureSeriesRow(channelId, subject);
  const chapter = Math.max(b.lo, Math.min(b.hi, Number(req.body?.chapter)));
  db.prepare(
    'UPDATE ChannelSeries SET cursor_chapter = ? WHERE channel_id = ? AND subject = ?'
  ).run(chapter, channelId, subject);
  res.json({ ok: true, cursor: chapter, lo: b.lo, hi: b.hi });
});

// PUT /api/channels/:id/series/:subject/chapters { order: [resourceId,...] } —
// reorder a series by rewriting each resource's chapter to its position (1..N).
// Progression is chapter-number based, so play order IS the chapter sequence.
router.put('/:id/series/:subject/chapters', (req, res) => {
  const channelId = Number(req.params.id);
  const subject = decodeURIComponent(req.params.subject);
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'order array of resource ids is required' });
  const upd = db.prepare(
    'UPDATE Resource SET chapter = ? WHERE id = ? AND channel_id = ? AND subject = ?'
  );
  order.forEach((rid, idx) => upd.run(idx + 1, Number(rid), channelId, subject));
  res.json({ ok: true });
});

// POST /api/channels/:id/series/detect — (re)register any series seen in the
// catalog that aren't in the registry yet. Existing rows are left untouched.
router.post('/:id/series/detect', (req, res) => {
  const channelId = Number(req.params.id);
  const subjects = db.prepare(`
    SELECT r.subject AS subject,
           (SELECT r2.show_type_id FROM Resource r2
              WHERE r2.channel_id = r.channel_id AND r2.subject = r.subject
              ORDER BY r2.id LIMIT 1) AS show_type_id
    FROM Resource r
    WHERE r.channel_id = ? AND r.is_filler = 0 AND r.subject IS NOT NULL
    GROUP BY r.subject
  `).all(channelId);

  const nextOrder = db.prepare(
    'SELECT COALESCE(MAX(play_order), -1) + 1 AS n FROM ChannelSeries WHERE channel_id = ?'
  );
  const codeOf = db.prepare('SELECT code FROM ShowType WHERE id = ?');
  const insert = db.prepare(`
    INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
    VALUES (?, ?, ?, ?, 1, ?)
  `);
  let added = 0;
  for (const s of subjects) {
    const code = s.show_type_id ? codeOf.get(s.show_type_id)?.code : null;
    const isSerial = code && SERIAL_DEFAULT_CODES.has(code) ? 1 : 0;
    const info = insert.run(channelId, s.subject, s.show_type_id ?? null, isSerial, nextOrder.get(channelId).n);
    if (info.changes) added++;
  }
  res.json({ ok: true, added });
});
