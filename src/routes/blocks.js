// BlockTemplate CRUD + ScheduledBlock/ScheduleItem review & approval API.
// Backs the admin review UI (Module B).

import { Router } from 'express';
import { db, withTx } from '../db.js';
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
           bt.name AS template_name,
           bt.id AS template_id,
           bt.max_per_show AS max_per_show,
           COALESCE(sb.channel_id, bt.channel_id) AS channel_id
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

// Record that a block's items aired: write PlayHistory (drives movie cooldown +
// series progression), stamp fillers' last_used_at (repeat-heat), and advance the
// per-series cursor for serial series. Called once when a block first becomes
// approved. Idempotent-safe fields (MAX-based progression) tolerate re-runs, but
// callers guard on the draft→approved transition to avoid duplicate history rows.
function recordBlockPlays(v) {
  const { block, items } = v;
  const channelId = block.channel_id;
  if (channelId == null) return;
  const playedAt = `${block.target_date}T${(block.start_time || '00:00')}:00`;

  const insPlay = db.prepare('INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, ?, ?)');
  const stampFiller = db.prepare('UPDATE Resource SET last_used_at = ? WHERE id = ?');
  // Advance the cursor only for genuinely sequential (serial-rule) series. TV
  // shows are is_serial by default but are picked by the latest-added/cooldown
  // rule, not chapter progression, so bumping their cursor to (lastChapter+1)
  // would wrap the series — exclude the tv_shows show type here.
  const bumpCursor = db.prepare(`
    UPDATE ChannelSeries SET cursor_chapter = ?
    WHERE channel_id = ? AND subject = ? AND is_serial = 1
      AND (cursor_chapter IS NULL OR cursor_chapter < ?)
      AND show_type_id NOT IN (SELECT id FROM ShowType WHERE code = 'tv_shows')
  `);

  const serialMax = new Map(); // subject -> highest chapter aired in this block
  for (const it of items) {
    insPlay.run(it.resource_id, channelId, playedAt);
    if (it.is_filler) stampFiller.run(playedAt, it.resource_id);
    else if (it.subject != null) serialMax.set(it.subject, Math.max(serialMax.get(it.subject) ?? 0, it.chapter));
  }
  for (const [subject, maxCh] of serialMax) {
    bumpCursor.run(maxCh + 1, channelId, subject, maxCh + 1);
  }
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

// Replace a template's target channels. `channels` is a list of channel ids.
// Always keeps at least the legacy primary channel so a template is never
// orphaned. The first channel is also written back as BlockTemplate.channel_id
// (the legacy "primary").
function setChannels(templateId, channels, fallbackChannelId) {
  const ids = (Array.isArray(channels) ? channels : [])
    .map((c) => Number(typeof c === 'object' ? c.channel_id : c))
    .filter((n) => Number.isInteger(n) && n > 0);
  const list = ids.length ? [...new Set(ids)] : (fallbackChannelId ? [fallbackChannelId] : []);
  if (!list.length) return;
  db.prepare('DELETE FROM BlockTemplateChannel WHERE template_id = ?').run(templateId);
  const ins = db.prepare('INSERT OR IGNORE INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)');
  list.forEach((cid) => ins.run(templateId, cid));
  db.prepare('UPDATE BlockTemplate SET channel_id = ? WHERE id = ?').run(list[0], templateId);
}

function templateChannels(templateId) {
  return db.prepare(
    'SELECT channel_id FROM BlockTemplateChannel WHERE template_id = ? ORDER BY channel_id'
  ).all(templateId).map((r) => r.channel_id);
}

function templateWithDetails(t) {
  return {
    ...t,
    slots: db.prepare('SELECT id, start_time, end_time, slot_order FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order').all(t.id),
    series: db.prepare('SELECT subject, play_order FROM BlockTemplateSeries WHERE template_id = ? ORDER BY play_order').all(t.id),
    channels: templateChannels(t.id),
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
  // Channels can arrive as a list (multi-channel) or a single channel_id (legacy).
  const channels = Array.isArray(b.channels) && b.channels.length
    ? b.channels : (b.channel_id ? [b.channel_id] : []);
  const primaryChannel = channels[0];
  if (!primaryChannel || !b.name || !weekdays || !slots.length) {
    return res.status(400).json({ error: 'at least one channel, name, weekdays and one time slot are required' });
  }
  const primary = slots[0];
  const firstWeekday = weekdays.split(',')[0];
  const maxPerShow = Number(b.max_per_show) > 0 ? Number(b.max_per_show) : null;
  const info = db.prepare(`
    INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, target_subject_id, target_subject, content_type, max_per_show)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(primaryChannel, b.name, firstWeekday, weekdays, primary.start_time, primary.end_time,
         b.target_subject_id ?? null, b.target_subject || null, b.content_type || 'movie', maxPerShow);
  const id = info.lastInsertRowid;
  setSlots(id, slots);
  setChannels(id, channels, primaryChannel);
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
  const maxPerShow = b.max_per_show === undefined
    ? cur.max_per_show
    : (Number(b.max_per_show) > 0 ? Number(b.max_per_show) : null);
  db.prepare(`
    UPDATE BlockTemplate SET channel_id=?, name=?, weekday=?, weekdays=?, start_time=?, end_time=?, target_subject_id=?, target_subject=?, content_type=?, max_per_show=?
    WHERE id=?
  `).run(
    b.channel_id ?? cur.channel_id, b.name ?? cur.name,
    (weekdays || '').split(',')[0] || cur.weekday, weekdays,
    primary.start_time, primary.end_time,
    b.target_subject_id ?? cur.target_subject_id, b.target_subject ?? cur.target_subject,
    b.content_type ?? cur.content_type, maxPerShow, id
  );
  if (slots) setSlots(id, slots);
  if (Array.isArray(b.channels)) setChannels(id, b.channels, b.channel_id ?? cur.channel_id);
  if (Array.isArray(b.series)) setSeries(id, b.series);
  res.json({ ok: true });
});

// ---- Template channels sub-resource ----------------------------------------
router.get('/templates/:id/channels', (req, res) => {
  res.json(templateChannels(Number(req.params.id)));
});

router.put('/templates/:id/channels', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT channel_id FROM BlockTemplate WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const list = Array.isArray(req.body?.channels) ? req.body.channels : null;
  if (!list || !list.length) return res.status(400).json({ error: 'channels array is required' });
  setChannels(id, list, cur.channel_id);
  res.json({ ok: true, channels: templateChannels(id) });
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
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  try {
    const results = generateWeek(ws, channelId);
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

// PUT /api/blocks/:id/max-per-show { max } — set the block's template cap on how
// many episodes one show may contribute per block (0/null = unlimited), then
// wipe+rebuild this draft block so the change is visible immediately. The cap
// lives on the template, so it also governs every future generation.
router.put('/:id/max-per-show', (req, res) => {
  const id = Number(req.params.id);
  const block = db.prepare('SELECT * FROM ScheduledBlock WHERE id = ?').get(id);
  if (!block) return res.status(404).json({ error: 'not found' });
  const raw = Number(req.body?.max);
  const max = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null;
  db.prepare('UPDATE BlockTemplate SET max_per_show = ? WHERE id = ?').run(max, block.template_id);
  // Rebuild from scratch (drop auto + manual items so the cap fully re-applies).
  db.prepare('DELETE FROM ScheduleItem WHERE block_id = ?').run(id);
  populateBlock(block);
  res.json(validateBlock(id));
});

// PUT /api/blocks/:id/series-order { subjects: [...] } — reorder the cycle order
// of the shows in this block's template, then wipe+rebuild the block so the new
// order takes effect. The order lives on the template (BlockTemplateSeries), so
// it also governs future generations. Subjects not listed keep their relative
// order after the listed ones.
router.put('/:id/series-order', (req, res) => {
  const id = Number(req.params.id);
  const block = db.prepare('SELECT * FROM ScheduledBlock WHERE id = ?').get(id);
  if (!block) return res.status(404).json({ error: 'not found' });
  const subjects = Array.isArray(req.body?.subjects) ? req.body.subjects.map(String) : null;
  if (!subjects) return res.status(400).json({ error: 'subjects array is required' });

  const rows = db.prepare(
    'SELECT subject FROM BlockTemplateSeries WHERE template_id = ? ORDER BY play_order'
  ).all(block.template_id).map((r) => r.subject);
  // New order = the requested subjects (that actually belong to the template)
  // first, then any remaining template subjects in their existing order.
  const wanted = subjects.filter((s) => rows.includes(s));
  const rest = rows.filter((s) => !wanted.includes(s));
  const ordered = [...wanted, ...rest];

  const upd = db.prepare('UPDATE BlockTemplateSeries SET play_order = ? WHERE template_id = ? AND subject = ?');
  ordered.forEach((s, i) => upd.run(i, block.template_id, s));

  db.prepare('DELETE FROM ScheduleItem WHERE block_id = ?').run(id);
  populateBlock(block);
  res.json(validateBlock(id));
});

// ---- Review ----------------------------------------------------------------
// GET /api/blocks?week=YYYY-MM-DD — the 7-day window starting at `week`.
router.get('/', (req, res) => {
  const start = req.query.week ? new Date(String(req.query.week) + 'T00:00:00') : new Date();
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  const clauses = ['sb.target_date BETWEEN ? AND ?'];
  const params = [dates[0], dates[6]];
  if (channelId != null) { clauses.push('COALESCE(sb.channel_id, bt.channel_id) = ?'); params.push(channelId); }
  const rows = db.prepare(`
    SELECT sb.id, sb.target_date, sb.status, sb.slot_id,
           COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
           bt.name AS template_name, bt.weekday, bt.content_type,
           COALESCE(s.start_time, bt.start_time) AS start_time,
           COALESCE(s.end_time, bt.end_time)     AS end_time,
           COALESCE(s.slot_order, 0)             AS slot_order,
           c.name AS channel_name
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN ChannelType   c  ON c.id = COALESCE(sb.channel_id, bt.channel_id)
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY sb.target_date, c.name, start_time
  `).all(...params);

  // Attach validation summary so the UI can render tolerance badges directly.
  const blocks = rows.map((r) => {
    const v = validateBlock(r.id);
    return { ...r, is_mirror: r.slot_order > 0, blockSeconds: v.blockSeconds, totalSeconds: v.totalSeconds, diff: v.diff, fits: v.fits };
  });
  res.json({ week: dates, blocks });
});

// GET /api/blocks/export?week=YYYY-MM-DD&channel_id=N — a printable, print-to-PDF
// friendly HTML schedule for the 7-day window. Fillers are excluded; each main
// clip shows its real on-air clock time (computed from the block start plus the
// running duration of everything before it, fillers included). Omit channel_id
// for a single combined document covering every channel.
router.get('/export', (req, res) => {
  const start = req.query.week ? new Date(String(req.query.week) + 'T00:00:00') : new Date();
  const channelId = req.query.channel_id ? Number(req.query.channel_id) : null;
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const clauses = ['sb.target_date BETWEEN ? AND ?'];
  const params = [dates[0], dates[6]];
  if (channelId != null) { clauses.push('COALESCE(sb.channel_id, bt.channel_id) = ?'); params.push(channelId); }
  const blocks = db.prepare(`
    SELECT sb.id, sb.target_date, sb.status,
           COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
           bt.name AS template_name,
           COALESCE(s.start_time, bt.start_time) AS start_time,
           COALESCE(s.end_time, bt.end_time)     AS end_time,
           COALESCE(s.slot_order, 0)             AS slot_order,
           c.name AS channel_name
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN ChannelType   c  ON c.id = COALESCE(sb.channel_id, bt.channel_id)
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY c.name, sb.target_date, start_time, slot_order
  `).all(...params);

  const itemsOf = db.prepare(`
    SELECT r.name, r.duration, r.is_filler, r.subject, r.chapter
    FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id
    WHERE si.block_id = ? ORDER BY si.play_order
  `);

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hhmmss = (secs) => {
    const s = ((secs % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return [h, m, ss].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const dur = (secs) => {
    const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
    return (h ? [h, m, s] : [m, s]).map((n) => String(n).padStart(2, '0')).join(':');
  };
  const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayLabel = (d) => `${WD[new Date(d + 'T00:00:00').getDay()]} ${d}`;

  // Group blocks: channel -> date -> [block]
  const byChannel = new Map();
  for (const b of blocks) {
    if (!byChannel.has(b.channel_name)) byChannel.set(b.channel_name, new Map());
    const byDate = byChannel.get(b.channel_name);
    if (!byDate.has(b.target_date)) byDate.set(b.target_date, []);
    byDate.get(b.target_date).push(b);
  }

  const scopeLabel = channelId != null
    ? (blocks[0]?.channel_name || `Channel ${channelId}`)
    : 'All channels';
  let body = '';
  if (!blocks.length) {
    body = `<p class="empty">No blocks scheduled for the week of ${esc(dates[0])}.</p>`;
  }
  for (const [channelName, byDate] of byChannel) {
    body += `<section class="channel"><h1>${esc(channelName)}</h1>`;
    for (const d of dates) {
      const dayBlocks = byDate.get(d);
      if (!dayBlocks || !dayBlocks.length) continue;
      body += `<h2>${esc(dayLabel(d))}</h2>`;
      for (const b of dayBlocks) {
        const rows = itemsOf.all(b.id);
        const mains = [];
        let offset = 0; // seconds from block start, counting fillers too
        const blockStart = (() => { const [h, m] = b.start_time.split(':').map(Number); return h * 3600 + m * 60; })();
        for (const it of rows) {
          if (!it.is_filler) {
            const label = it.subject
              ? `${it.subject}${it.chapter ? ` — Ep ${it.chapter}` : ''}${it.name ? ` (${it.name})` : ''}`
              : it.name;
            mains.push({ air: hhmmss(blockStart + offset), label, dur: dur(it.duration) });
          }
          offset += it.duration;
        }
        const mirror = b.slot_order > 0 ? ' <span class="mirror">🔁 repeat airing</span>' : '';
        body += `<div class="block"><h3>${esc(b.start_time)}–${esc(b.end_time)} · ${esc(b.template_name)} `
          + `<span class="status">${esc(b.status)}</span>${mirror}</h3>`;
        if (!mains.length) {
          body += `<p class="empty">No main programming (fillers only).</p></div>`;
          continue;
        }
        body += '<table><thead><tr><th>Air time</th><th>Programme</th><th>Duration</th></tr></thead><tbody>';
        for (const m of mains) body += `<tr><td class="t">${m.air}</td><td>${esc(m.label)}</td><td class="t">${m.dur}</td></tr>`;
        body += '</tbody></table></div>';
      }
    }
    body += '</section>';
  }

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Schedule — ${esc(scopeLabel)} — week of ${esc(dates[0])}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color: #111; margin: 0; padding: 24px; background: #fff; }
  .bar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 8px 0 16px; background: #fff; }
  .bar h1 { font-size: 18px; margin: 0; flex: 1; }
  button { font: inherit; padding: 6px 14px; border: 1px solid #888; border-radius: 6px; background: #f4f4f4; cursor: pointer; }
  section.channel { margin: 0 0 28px; page-break-after: always; }
  section.channel:last-child { page-break-after: auto; }
  h1 { font-size: 20px; border-bottom: 2px solid #111; padding-bottom: 4px; }
  h2 { font-size: 15px; margin: 18px 0 6px; color: #333; }
  .block { margin: 0 0 10px; }
  .block h3 { font-size: 13px; font-weight: 600; margin: 8px 0 3px; color: #222; }
  .status { font-weight: 400; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  .mirror { font-weight: 400; font-size: 11px; color: #666; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { text-align: left; padding: 3px 10px 3px 0; border-bottom: 1px solid #e2e2e2; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  td.t, th:first-child, th:last-child { font-variant-numeric: tabular-nums; }
  td.t { white-space: nowrap; }
  .empty { color: #888; font-style: italic; }
  @media print { .bar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="bar"><h1>Schedule · ${esc(scopeLabel)} · week of ${esc(dates[0])}</h1>
<button onclick="window.print()">🖨 Print / Save as PDF</button></div>
${body}
</body></html>`;

  res.type('html').send(html);
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

// POST /api/blocks/:id/items/:itemId/set-episode { chapter }
// Calibrate where a serial show starts. Sets the series cursor to the chosen
// chapter (and marks the series serial), then wipes + rebuilds this block and
// every later still-draft block this week for the same channel so the whole
// run rolls forward from the corrected episode. Rebuilding (rather than pinning
// a single item) keeps multi-episode blocks intact and propagates cleanly.
router.post('/:id/items/:itemId/set-episode', (req, res) => {
  const id = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const chapter = Number(req.body?.chapter);
  if (!Number.isFinite(chapter)) return res.status(400).json({ error: 'chapter is required' });

  const block = db.prepare(`
    SELECT sb.*, COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
           COALESCE(s.slot_order, 0) AS slot_order
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.id = ?
  `).get(id);
  if (!block) return res.status(404).json({ error: 'not found' });
  if (block.slot_order > 0) {
    return res.status(409).json({ error: 'this is a mirrored airing — edit its primary airing instead' });
  }

  const item = db.prepare(`
    SELECT si.id, r.subject FROM ScheduleItem si
    JOIN Resource r ON r.id = si.resource_id
    WHERE si.id = ? AND si.block_id = ?
  `).get(itemId, id);
  if (!item) return res.status(404).json({ error: 'item not found in this block' });
  if (item.subject == null) return res.status(400).json({ error: 'this item is not part of a series' });

  const target = db.prepare(
    'SELECT id FROM Resource WHERE channel_id = ? AND subject = ? AND chapter = ? AND is_filler = 0'
  ).get(block.channel_id, item.subject, chapter);
  if (!target) return res.status(404).json({ error: `no chapter ${chapter} for “${item.subject}”` });

  try {
  withTx(() => {
    // (1) set the series cursor (ensure a row exists, mark it serial), so this
    // block and future generations start from the corrected episode.
    db.prepare(`
      INSERT INTO ChannelSeries (channel_id, subject, is_serial, is_active, play_order)
      VALUES (?, ?, 1, 1, (SELECT COALESCE(MAX(play_order), -1) + 1 FROM ChannelSeries WHERE channel_id = ?))
      ON CONFLICT(channel_id, subject) DO UPDATE SET is_serial = 1
    `).run(block.channel_id, item.subject, block.channel_id);
    db.prepare(
      'UPDATE ChannelSeries SET cursor_chapter = ? WHERE channel_id = ? AND subject = ?'
    ).run(chapter, block.channel_id, item.subject);

    // (2) wipe + rebuild this block and every later still-draft block this week
    // (same channel), primary airings first so mirrors copy a populated source.
    // nextChapter floors at the cursor and unions earlier-dated items, so the
    // run rolls forward from the corrected episode. Bounded to the 7-day window.
    const scope = db.prepare(`
      SELECT sb.id, COALESCE(s.slot_order, 0) AS slot_order
      FROM ScheduledBlock sb
      JOIN BlockTemplate bt ON bt.id = sb.template_id
      LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
      WHERE sb.status = 'draft'
        AND COALESCE(sb.channel_id, bt.channel_id) = ?
        AND sb.target_date >= ? AND sb.target_date <= date(?, '+6 days')
      ORDER BY sb.target_date, sb.template_id, slot_order
    `).all(block.channel_id, block.target_date, block.target_date);
    for (const b of scope) db.prepare('DELETE FROM ScheduleItem WHERE block_id = ?').run(b.id);
    for (const b of scope) {
      const full = db.prepare('SELECT * FROM ScheduledBlock WHERE id = ?').get(b.id);
      populateBlock(full);
    }
  });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }

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
  if (v.block.status !== 'approved') recordBlockPlays(v); // record only on first approval
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
    if (v.fits) {
      recordBlockPlays(v); // these are drafts, so always a first approval
      db.prepare("UPDATE ScheduledBlock SET status='approved' WHERE id=?").run(id);
      approved.push(id);
    } else blocked.push({ id, diff: v.diff });
  }
  res.json({ ok: blocked.length === 0, approved, blocked });
});
