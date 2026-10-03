// On-shift roster for the signal monitor: who the alerts go to, and the
// "your shift starts in 30 minutes" / "your shift has ended" e-mails.
//
// The roster comes from the operators' own shift spreadsheet (.xlsx/.xlsm), one
// sheet per month laid out as
//
//   Date | Day | Rotation Week | 9 AM-5 PM | 5 PM-1 AM Remote | 1 AM-9 AM Remote | Off
//   22 Aug | Sat | …           | Nick (Remote) | Simeon (Remote) | Jose L (Remote) | Ethan
//
// Every column whose header is a time range is a shift; the rest are ignored.
// A sheet DAY runs from the start of its first shift column to the same time
// next morning (09:00 → 09:00, confirmed with the operator on 2026-10-03), so a
// shift that starts earlier in the clock than the first column — "1 AM-9 AM" —
// is the night AFTER the row's date, not the morning of it.
//
// People become CODES (A, B, C…), and the operator gives each code a name and
// an e-mail in the UI. The code is found again on the next import by the name
// as written in the sheet (sheet_name), so a re-import keeps the e-mails.
//
// Times in the sheet are wall-clock times on this Mac, so they are turned into
// instants with the process's local time zone at import.
//
// Routing (alertRecipients): an alert goes to whoever is on shift at that
// moment. When the roster cannot answer — nobody scheduled for this time (the
// sheet ran out), or the person on shift has no e-mail yet — it goes to the
// full recipient list instead, and the e-mail says why. An alert must never be
// dropped because a spreadsheet was not updated.

import { inflateRawSync } from 'node:zlib';
import { db, withTx } from '../db.js';
import { loadConfig } from '../config.js';
import { log } from '../logger.js';
import { sendMail, emailConfig, emailProblem, isEmail } from './mailer.js';

const L = log('roster');

/** config.monitor.roster with defaults filled in. */
export function rosterConfig(raw = (loadConfig().monitor || {}).roster) {
  const r = raw || {};
  const lead = Number(r.leadMinutes);
  return {
    routeAlerts: r.routeAlerts !== false,
    notify: r.notify !== false,
    leadMinutes: Number.isFinite(lead) ? Math.min(240, Math.max(1, lead)) : 30,
  };
}

// --- Reading the spreadsheet ---------------------------------------------------
//
// An .xlsx/.xlsm is a zip of XML files. Node has inflate but no unzip, and the
// app must not need `npm install` for a feature this small, so this reads the
// zip's central directory itself (which, unlike the local headers, always has
// the real sizes) and pulls the few XML parts it needs.

/** Map of entry name → Buffer for every file in a zip. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not an Excel file (no zip directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged Excel file (bad zip directory)');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    // Other methods don't occur in files Excel writes; skip rather than fail.
  }
  return files;
}

const unxml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

// All <t> runs of a string item, concatenated (rich text splits one string
// into several runs). Phonetic hints (<rPh>) are not part of the text.
const textOf = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
  .matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unxml(m[1])).join('');

const colIndex = (ref) => {
  const letters = ref.match(/^[A-Z]+/)[0];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** Rows of a worksheet as arrays of strings (null for empty cells). */
function sheetRows(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
      const body = cm[2] || '';
      const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let value = null;
      if (type === 's' && v !== undefined) value = shared[Number(v)] ?? null;
      else if (type === 'inlineStr') value = textOf(body);
      else if (v !== undefined) value = unxml(v);
      row[colIndex(ref)] = value;
    }
    rows.push(row);
  }
  return rows;
}

/** Every worksheet of a workbook buffer, as { name, rows }. */
export function readWorkbook(buf) {
  const files = unzip(buf);
  const ss = files.get('xl/sharedStrings.xml');
  const shared = ss ? [...ss.toString('utf8').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheets = [];
  for (const [name, data] of files) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) sheets.push({ name, rows: sheetRows(data.toString('utf8'), shared) });
  }
  if (!sheets.length) throw new Error('no worksheets in this file');
  return sheets;
}

// --- Turning rows into shifts ---------------------------------------------------

const RANGE_RE = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i;

const to24 = (h, m, ap) => ((Number(h) % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(m || 0);

/** "5 PM-1 AM Remote" → { label: '5 PM-1 AM', start: 1020, minutes: 480 } (minutes since midnight). */
export function parseShiftHeader(text) {
  const m = String(text || '').match(RANGE_RE);
  if (!m) return null;
  const start = to24(m[1], m[2], m[3]);
  const end = to24(m[4], m[5], m[6]);
  const minutes = ((end - start + 1440) % 1440) || 1440;
  return { label: m[0].replace(/\s+/g, ' ').replace(/\s*(?:-|–|—)\s*/, '-').trim(), start, minutes };
}

/** "Jose L (Remote)" → { name: 'Jose L', location: 'Remote' }; blank / "-" → null. */
export function parseAssignee(text) {
  const s = String(text ?? '').trim();
  if (!s || /^[-–—]+$/.test(s)) return null;
  const m = s.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  return m ? { name: m[1].trim(), location: m[2].trim() || null } : { name: s, location: null };
}

const pad = (n) => String(n).padStart(2, '0');

/** A Date cell (Excel serial, or text like 2026-08-22) → 'YYYY-MM-DD', or null. */
function cellDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v))) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(Number(v)) * 86_400_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Local wall-clock (day + minutes, may run past midnight) → UTC ISO instant. */
function localInstant(day, minutes) {
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, 0, minutes).toISOString();
}

/**
 * Every shift in a workbook: [{ day, label, sheetName, location, startsAt, endsAt }].
 * Pure apart from the local time zone. Throws with a readable reason when the
 * layout is not recognised, rather than importing nothing silently.
 */
export function parseRoster(buf) {
  const shifts = [];
  for (const sheet of readWorkbook(buf)) {
    const h = sheet.rows.findIndex((r) => r.some((c) => /^\s*date\s*$/i.test(String(c ?? ''))));
    if (h < 0) continue;
    const header = sheet.rows[h];
    const dateCol = header.findIndex((c) => /^\s*date\s*$/i.test(String(c ?? '')));
    const cols = [];
    header.forEach((c, i) => { const s = parseShiftHeader(c); if (s) cols.push({ i, ...s }); });
    if (!cols.length) continue;
    // The sheet day starts with its FIRST shift column; anything that starts
    // earlier on the clock belongs to the next calendar morning.
    const dayStart = cols[0].start;
    for (const row of sheet.rows.slice(h + 1)) {
      const day = cellDate(row[dateCol]);
      if (!day) continue;
      for (const col of cols) {
        const who = parseAssignee(row[col.i]);
        if (!who) continue;
        const start = col.start + (col.start < dayStart ? 1440 : 0);
        shifts.push({
          day, label: col.label, sheetName: who.name, location: who.location,
          startsAt: localInstant(day, start), endsAt: localInstant(day, start + col.minutes),
        });
      }
    }
  }
  if (!shifts.length) {
    throw new Error('no shifts found — the sheet needs a "Date" column and columns headed with times like "9 AM-5 PM"');
  }
  return shifts;
}

// --- Storing it -------------------------------------------------------------------

/** A, B, … Z, AA, AB … — the first one not already taken. */
function nextCode(taken) {
  for (let n = 1; ; n++) {
    let code = '';
    for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) code = String.fromCharCode(65 + ((k - 1) % 26)) + code;
    if (!taken.has(code)) return code;
  }
}

/**
 * Replace the roster for the dates the workbook covers. People keep their code
 * (and so their e-mail) across imports; a shift whose person did not change
 * keeps its notice record, so re-importing never re-sends a reminder.
 */
export function importRoster(buf) {
  const shifts = parseRoster(buf);
  return withTx(() => {
    const people = new Map(db.prepare('SELECT * FROM ShiftPerson').all().map((p) => [p.sheet_name.toLowerCase(), p]));
    const taken = new Set([...people.values()].map((p) => p.code));
    const added = [];
    for (const s of shifts) {
      const key = s.sheetName.toLowerCase();
      if (people.has(key)) continue;
      const code = nextCode(taken);
      taken.add(code);
      db.prepare('INSERT INTO ShiftPerson (code, sheet_name) VALUES (?, ?)').run(code, s.sheetName);
      const p = { code, sheet_name: s.sheetName };
      people.set(key, p);
      added.push(p);
    }
    const days = [...new Set(shifts.map((s) => s.day))].sort();
    const from = days[0], to = days.at(-1);
    // Slots in the imported range that the new sheet no longer has.
    const keep = new Set(shifts.map((s) => `${s.day}|${s.label}`));
    const del = db.prepare('DELETE FROM Shift WHERE id = ?');
    let removed = 0;
    for (const r of db.prepare('SELECT id, day, label FROM Shift WHERE day BETWEEN ? AND ?').all(from, to)) {
      if (!keep.has(`${r.day}|${r.label}`)) { del.run(r.id); removed++; }
    }
    const upsert = db.prepare(`
      INSERT INTO Shift (day, label, code, location, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day, label) DO UPDATE SET
        location = excluded.location, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        -- A different person, or a moved slot, has not been told yet.
        start_notice_at = CASE WHEN Shift.code = excluded.code AND Shift.starts_at = excluded.starts_at
                               THEN Shift.start_notice_at END,
        end_notice_at   = CASE WHEN Shift.code = excluded.code AND Shift.ends_at = excluded.ends_at
                               THEN Shift.end_notice_at END,
        code = excluded.code`);
    for (const s of shifts) {
      upsert.run(s.day, s.label, people.get(s.sheetName.toLowerCase()).code, s.location, s.startsAt, s.endsAt);
    }
    L.info(`roster imported: ${shifts.length} shift(s), ${from} → ${to}, ${added.length} new code(s)`);
    return {
      shifts: shifts.length, days: days.length, from, to, removed,
      added: added.map((p) => ({ code: p.code, sheetName: p.sheet_name })),
    };
  });
}

export function listPeople() {
  return db.prepare('SELECT code, sheet_name AS sheetName, name, email FROM ShiftPerson ORDER BY length(code), code').all();
}

/**
 * Save names and e-mails: [{ code, name, email }]. Throws on a bad address or
 * an unknown code, before writing anything.
 */
export function savePeople(list) {
  if (!Array.isArray(list)) throw new Error('people must be a list');
  const known = new Set(listPeople().map((p) => p.code));
  const rows = list.map((p) => {
    const code = String(p?.code || '').trim().toUpperCase();
    if (!known.has(code)) throw new Error(`unknown code "${code}"`);
    const email = String(p.email || '').trim();
    if (email && !isEmail(email)) throw new Error(`${code}: "${email}" is not an e-mail address`);
    return { code, name: String(p.name || '').trim() || null, email: email || null };
  });
  withTx(() => {
    const st = db.prepare('UPDATE ShiftPerson SET name = ?, email = ? WHERE code = ?');
    for (const r of rows) st.run(r.name, r.email, r.code);
  });
  return listPeople();
}

const SHIFT_SELECT = `SELECT s.*, p.sheet_name, p.name, p.email
  FROM Shift s JOIN ShiftPerson p ON p.code = s.code`;

/** Shifts covering an instant. */
export function onShiftAt(ms = Date.now()) {
  const t = new Date(ms).toISOString();
  return db.prepare(`${SHIFT_SELECT} WHERE s.starts_at <= ? AND s.ends_at > ? ORDER BY s.code`).all(t, t);
}

/** Shifts that end after `ms`, soonest first. */
export function upcomingShifts(ms = Date.now(), limit = 12) {
  const t = new Date(ms).toISOString();
  return db.prepare(`${SHIFT_SELECT} WHERE s.ends_at > ? ORDER BY s.starts_at, s.code LIMIT ?`).all(t, limit);
}

export function rosterRange() {
  return db.prepare('SELECT MIN(day) AS "from", MAX(day) AS "to", COUNT(*) AS shifts FROM Shift').get();
}

/** "B · Nick" — code first, the name when one was given. */
export const personLabel = (r) => (r.name ? `${r.code} · ${r.name}` : `${r.code} (${r.sheet_name})`);

const clock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
const dayClock = (iso) => new Date(iso).toLocaleString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * Who an alert raised now goes to. { to: [emails] | null, note } — `to` null
 * means "the full list", and `note` is the line the e-mail carries either way.
 */
export function alertRecipients(ms = Date.now()) {
  if (!rosterConfig().routeAlerts) return { to: null, note: null };
  const range = rosterRange();
  if (!range.shifts) return { to: null, note: null };   // no roster loaded: the list, as before
  const on = onShiftAt(ms);
  if (!on.length) {
    return { to: null, note: 'Sent to the whole alert list: nobody is on the shift roster for this time.' };
  }
  const withMail = on.filter((r) => r.email);
  const missing = on.filter((r) => !r.email);
  if (!withMail.length) {
    return {
      to: null,
      note: `Sent to the whole alert list: ${missing.map(personLabel).join(', ')} is on shift but has no e-mail in the roster.`,
    };
  }
  return {
    to: [...new Set(withMail.map((r) => r.email))],
    note: `Sent to whoever is on shift: ${withMail.map((r) => `${personLabel(r)} (until ${clock(chainEnd(r))})`).join(', ')}.`
      + (missing.length ? ` ${missing.map(personLabel).join(', ')} is also on shift but has no e-mail.` : ''),
  };
}

// --- Shift notices ------------------------------------------------------------------

// Two shifts of the same person back to back (5 PM-1 AM then 1 AM-9 AM) are
// one stretch of duty: no "your shift ended" at 01:00 followed by "your shift
// starts" for a shift they are already on.
const continuesInto = (r) => db.prepare('SELECT 1 FROM Shift WHERE code = ? AND starts_at = ?').get(r.code, r.ends_at);
const continuesFrom = (r) => db.prepare('SELECT 1 FROM Shift WHERE code = ? AND ends_at = ?').get(r.code, r.starts_at);

/** When this person's run of back-to-back shifts ends. */
function chainEnd(r) {
  let end = r.ends_at;
  const next = db.prepare('SELECT ends_at FROM Shift WHERE code = ? AND starts_at = ?');
  for (let i = 0; i < 10; i++) {
    const n = next.get(r.code, end);
    if (!n) break;
    end = n.ends_at;
  }
  return end;
}

const RETRY_MS = 5 * 60_000;
const lastTry = new Map();   // `${id}:${kind}` -> ms, so a broken mailbox isn't hammered every 30s
// An "ended" notice more than this late (the app was off at the time) is
// recorded but not sent: nobody needs to hear at noon that their shift ended at 9.
const END_GRACE_MS = 30 * 60_000;

function shiftMail(kind, r, ms, extra) {
  const who = r.name || r.sheet_name;
  const until = chainEnd(r);
  const lines = kind === 'start'
    ? [
      `Hi ${who},`,
      '',
      Date.parse(r.starts_at) > ms
        ? `Your shift starts at ${clock(r.starts_at)} (${dayClock(r.starts_at)}) and runs until ${clock(until)}.`
        : `You are on shift now — it started at ${clock(r.starts_at)} and runs until ${clock(until)}.`,
      'From then on the signal monitor\'s alerts (black, silent or lost feeds) come to you.',
      ...extra,
    ]
    : [
      `Hi ${who},`,
      '',
      `Your shift ended at ${clock(r.ends_at)}. Signal alerts no longer come to you.`,
      ...extra,
    ];
  const subject = kind === 'start'
    ? `[Shift] ${Date.parse(r.starts_at) > ms ? `Your shift starts at ${clock(r.starts_at)}` : 'You are on shift now'} — until ${clock(until)}`
    : `[Shift] Your shift ended at ${clock(r.ends_at)}`;
  const text = [...lines, '', 'Sent by the OTAV automator signal monitor.'].join('\n');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">${lines.map((l) => (l ? `<p style="margin:0 0 8px">${esc(l)}</p>` : '')).join('')}
<p style="color:#888;font-size:12px">Sent by the OTAV automator signal monitor.</p></div>`;
  return { subject, text, html };
}

/**
 * Send whatever shift notices are due at `ms`. Called every 30s by the
 * notifier; exported so tests drive it with a fake clock. `context()` returns
 * extra lines for the start notice (the feeds in trouble right now).
 * Returns what it did, for the log and the tests.
 */
export async function checkShiftNotices(ms = Date.now(), { context = () => [] } = {}) {
  const cfg = rosterConfig();
  const done = [];
  if (!cfg.notify) return done;
  const now = new Date(ms).toISOString();
  const mark = (col, r, error = null) => db.prepare(`UPDATE Shift SET ${col} = ?, notice_error = ? WHERE id = ?`).run(now, error, r.id);
  const mailOk = !emailProblem({ ...emailConfig(), recipients: ['x@x.x'] });

  const due = (r, kind) => {
    const k = `${r.id}:${kind}`;
    if (ms - (lastTry.get(k) || 0) < RETRY_MS) return false;
    lastTry.set(k, ms);
    return true;
  };
  const send = async (kind, r, extra) => {
    const col = kind === 'start' ? 'start_notice_at' : 'end_notice_at';
    try {
      await sendMail({ ...shiftMail(kind, r, ms, extra), to: [r.email] });
      mark(col, r);
      L.info(`${kind === 'start' ? 'shift start' : 'shift end'} notice sent to ${personLabel(r)}`);
      done.push({ kind, code: r.code, id: r.id });
    } catch (err) {
      db.prepare('UPDATE Shift SET notice_error = ? WHERE id = ?').run(err.message, r.id);
      L.warn(`shift notice to ${personLabel(r)} failed: ${err.message}`);
    }
  };

  // Starting within leadMinutes (or already started and not over).
  const soon = new Date(ms + cfg.leadMinutes * 60_000).toISOString();
  for (const r of db.prepare(`${SHIFT_SELECT} WHERE s.start_notice_at IS NULL AND s.starts_at <= ? AND s.ends_at > ?
                              ORDER BY s.starts_at`).all(soon, now)) {
    if (continuesFrom(r)) { mark('start_notice_at', r); continue; }
    if (!r.email || !mailOk || !due(r, 'start')) continue;
    await send('start', r, context());
  }

  // Over.
  for (const r of db.prepare(`${SHIFT_SELECT} WHERE s.end_notice_at IS NULL AND s.ends_at <= ?
                              ORDER BY s.ends_at`).all(now)) {
    if (continuesInto(r) || ms - Date.parse(r.ends_at) > END_GRACE_MS) { mark('end_notice_at', r); continue; }
    if (!r.email || !mailOk || !due(r, 'end')) continue;
    const next = onShiftAt(Date.parse(r.ends_at)).filter((n) => n.code !== r.code);
    const extra = next.length ? ['', `Alerts now go to ${next.map(personLabel).join(', ')}.`] : [];
    await send('end', r, extra);
  }
  return done;
}

let notifier = null;

/** Check for due notices every 30s. Safe to call more than once. */
export function startShiftNotifier({ context } = {}) {
  if (notifier) return;
  const run = () => checkShiftNotices(Date.now(), { context })
    .catch((err) => L.error('shift notices failed', err));
  notifier = setInterval(run, 30_000);
  notifier.unref?.();
  run();
}

export function stopShiftNotifier() {
  clearInterval(notifier);
  notifier = null;
}
