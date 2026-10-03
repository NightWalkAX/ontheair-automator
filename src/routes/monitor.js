// Signal monitor routes ("Signal Monitor" tab): live state of every public
// feed, the incident history, and the settings — feeds, thresholds, and the
// Gmail account + recipient list the alerts go to.

import express, { Router } from 'express';
import { updateConfig } from '../config.js';
import {
  monitorStatus, monitorConfig, saveMonitorConfig, recentEvents, slug,
} from '../services/signalMonitor.js';
import { emailConfig, isEmail, sendMail } from '../services/mailer.js';
import {
  importRoster, listPeople, savePeople, onShiftAt, upcomingShifts, rosterRange, personLabel,
} from '../services/shiftRoster.js';

export const router = Router();

// GET /api/monitor/status — every feed's state + its last frame, polled by the tab.
router.get('/status', (req, res) => {
  res.json({ ok: true, ...monitorStatus() });
});

// GET /api/monitor/events?limit=50 — incident history, newest first.
router.get('/events', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  res.json({ ok: true, events: recentEvents(limit) });
});

// GET /api/monitor/config — monitor settings plus the e-mail settings, with
// the app password replaced by whether one is stored.
router.get('/config', (req, res) => {
  const e = emailConfig();
  res.json({
    ok: true,
    monitor: monitorConfig(),
    email: {
      host: e.host, port: e.port, user: e.user, fromName: e.fromName,
      recipients: e.recipients, hasPassword: !!e.appPassword,
    },
  });
});

/** Validate the feeds list from the UI. Throws with a message for the operator. */
function cleanSources(list) {
  if (!Array.isArray(list)) throw new Error('sources must be a list');
  const seen = new Set();
  return list.map((s, i) => {
    const name = String(s?.name || '').trim();
    const url = String(s?.url || '').trim();
    if (!name) throw new Error(`feed #${i + 1} has no name`);
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`"${name}": the URL must start with http:// or https://`);
    let id = slug(s.id || name);
    while (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const channelId = Number(s.channelId);
    return {
      id, name, url, enabled: s.enabled !== false,
      channelId: Number.isInteger(channelId) && channelId > 0 ? channelId : null,
    };
  });
}

// PUT /api/monitor/config — { enabled?, sampleFps?, black?, freeze?, down?,
// repeatMinutes?, batchSeconds?, sources? }. Saved to config.json and applied
// at once (the monitor restarts its feeds).
router.put('/config', (req, res) => {
  const b = req.body || {};
  const current = monitorConfig();
  const next = {};
  try {
    if ('enabled' in b) next.enabled = b.enabled === true;
    for (const k of ['sampleFps', 'repeatMinutes', 'batchSeconds']) {
      if (k in b) next[k] = Number(b[k]);
    }
    // Partial groups merge onto what is stored: sending { black: { maxLuma } }
    // must not reset the rest of the black settings to their defaults.
    for (const k of ['black', 'freeze', 'down', 'resync', 'silence', 'roster']) {
      if (b[k] && typeof b[k] === 'object') next[k] = { ...current[k], ...b[k] };
    }
    if ('sources' in b) next.sources = cleanSources(b.sources);
    // Round-trip through monitorConfig() so what is stored is what will run:
    // bounded numbers, no stray keys.
    const merged = monitorConfig({ ...current, ...next });
    const stored = Object.fromEntries(Object.keys(next).map((k) => [k, merged[k]]));
    res.json({ ok: true, monitor: saveMonitorConfig(stored) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// PUT /api/monitor/email — { user, appPassword?, fromName?, recipients, host?, port? }.
// A blank appPassword keeps the stored one, so saving the form never erases it.
router.put('/email', (req, res) => {
  const b = req.body || {};
  const user = String(b.user || '').trim();
  if (user && !isEmail(user)) return res.status(400).json({ ok: false, error: 'the sender account must be an e-mail address' });
  const raw = Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[\s,;]+/);
  const recipients = [...new Set(raw.map((r) => String(r).trim()).filter(Boolean))];
  const bad = recipients.filter((r) => !isEmail(r));
  if (bad.length) return res.status(400).json({ ok: false, error: `not an e-mail address: ${bad.join(', ')}` });
  const port = b.port === undefined || b.port === '' ? undefined : Number(b.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    return res.status(400).json({ ok: false, error: 'port must be a number' });
  }
  try {
    updateConfig((c) => {
      const e = { ...(c.email || {}) };
      e.user = user;
      e.recipients = recipients;
      if (b.fromName !== undefined) e.fromName = String(b.fromName).trim() || undefined;
      if (b.host !== undefined) e.host = String(b.host).trim() || undefined;
      if (port !== undefined) e.port = port;
      if (b.appPassword) e.appPassword = String(b.appPassword).replace(/\s+/g, '');
      c.email = e;
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: `config.json could not be written: ${err.message}` });
  }
  const e = emailConfig();
  return res.json({ ok: true, email: { user: e.user, recipients: e.recipients, hasPassword: !!e.appPassword } });
});

// POST /api/monitor/test-email — send a test message to the whole list, so a
// wrong app password is found now and not during the first real outage.
router.post('/test-email', async (req, res) => {
  try {
    const n = emailConfig().recipients.length;
    await sendMail({
      subject: '[Signal monitor] Test message',
      text: 'This is a test from the OTAV automator signal monitor. If you can read it, alerts will reach you.',
      html: '<p style="font-family:Arial,sans-serif">This is a test from the OTAV automator signal monitor. '
        + 'If you can read it, alerts will reach you.</p>',
    });
    res.json({ ok: true, recipients: n });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// --- On-shift roster ----------------------------------------------------------

const shiftView = (r) => ({
  id: r.id, day: r.day, label: r.label, code: r.code, who: personLabel(r), location: r.location,
  startsAt: r.starts_at, endsAt: r.ends_at, hasEmail: !!r.email,
  startNoticeAt: r.start_notice_at, endNoticeAt: r.end_notice_at, noticeError: r.notice_error,
});

// GET /api/monitor/roster — the codes with their names/e-mails, who is on shift
// now, the next shifts, and the dates the imported sheet covers.
router.get('/roster', (req, res) => {
  const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 12));
  res.json({
    ok: true,
    people: listPeople(),
    range: rosterRange(),
    onShift: onShiftAt().map(shiftView),
    upcoming: upcomingShifts(Date.now(), limit).map(shiftView),
  });
});

// POST /api/monitor/roster/import — the shift spreadsheet (.xlsx / .xlsm) as the
// raw request body. Replaces the shifts for the dates it covers; codes and
// their e-mails carry over.
router.post('/roster/import', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ ok: false, error: 'no file received' });
  }
  try {
    res.json({ ok: true, ...importRoster(req.body), people: listPeople() });
  } catch (err) {
    res.status(400).json({ ok: false, error: `could not read the roster: ${err.message}` });
  }
});

// PUT /api/monitor/roster/people — [{ code, name, email }].
router.put('/roster/people', (req, res) => {
  try {
    res.json({ ok: true, people: savePeople(req.body?.people) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});
