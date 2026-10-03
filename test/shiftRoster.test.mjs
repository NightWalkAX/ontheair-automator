// Shift roster tests.
//
// The roster decides who hears about a black feed, so what matters is: the
// spreadsheet is read the way the operators read it (a "1 AM-9 AM" cell is the
// night AFTER its row's date), people become codes that survive a re-import,
// an alert goes only to whoever is on shift — and to the whole list when the
// roster can't say — and the "starts in 30 min" / "shift ended" e-mails go out
// once, to that person, and not between two back-to-back shifts.
//
// The workbook is built here, as a real zip, so no binary fixture is needed.
// Times are built with the local time zone, as the import does, so the tests
// pass in any TZ.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const scratch = mkdtempSync(join(tmpdir(), 'otav-roster-'));
process.env.SCHEDULER_DB = process.env.SCHEDULER_DB || join(scratch, 'test.sqlite');
const testConfig = join(scratch, 'config.json');
writeFileSync(testConfig, JSON.stringify({
  server: { port: 0 },
  monitor: { enabled: false, batchSeconds: 0 },
  email: { user: 'monitor@gmail.com', appPassword: 'abcdabcdabcdabcd', recipients: ['backup@example.gy'] },
}));
process.env.SCHEDULER_CONFIG = testConfig;

const { initSchema, db } = await import('../src/db.js');
const roster = await import('../src/services/shiftRoster.js');
const mon = await import('../src/services/signalMonitor.js');
const mailer = await import('../src/services/mailer.js');
initSchema();

// --- A minimal .xlsx --------------------------------------------------------------

function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflateRawSync(raw);
    const n = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, data);
    central.push(ch, n);
    offset += lh.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const serial = (iso) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
const COLS = 'ABCDEFG';

/** rows: [[ 'YYYY-MM-DD', day, rotation, 9-5, 5-1, 1-9, off ], …] */
function workbook(rows) {
  const strings = [];
  const si = (s) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s); } return i; };
  const cell = (ref, v) => (typeof v === 'number'
    ? `<c r="${ref}"><v>${v}</v></c>`
    : `<c r="${ref}" t="s"><v>${si(v)}</v></c>`);
  const header = ['Date', 'Day', 'Rotation Week', '9 AM-5 PM', '5 PM-1 AM Remote', '1 AM-9 AM Remote', 'Off'];
  const xmlRows = [
    `<row r="1">${cell('A1', 'Test Balanced Remote Shift Schedule')}</row>`,
    `<row r="3">${header.map((h, i) => cell(`${COLS[i]}3`, h)).join('')}</row>`,
    ...rows.map((r, n) => `<row r="${n + 4}">${r.map((v, i) => (v === null ? ''
      : cell(`${COLS[i]}${n + 4}`, i === 0 ? serial(v) : v))).join('')}</row>`),
  ];
  return zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Test" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${xmlRows.join('')}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<sst>${strings.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`,
  });
}

const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const iso = (...a) => new Date(at(...a)).toISOString();

const SHEET = [
  ['2030-03-01', 'Fri', 'Rotation Week 1', 'Nick (Office)', 'Simeon (Remote)', 'Jose L (Remote)', 'Ethan'],
  ['2030-03-02', 'Sat', 'Rotation Week 1', 'Ethan (Remote)', 'Jose L (Remote)', 'Jose L (Remote)', 'Nick'],
];

const sent = [];
before(() => {
  mailer.setTransportForTests({
    sendMail: async (msg) => {
      const out = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
      sent.push(JSON.parse(out.message));
      return out;
    },
  });
});
// The test files share one database; leave no roster behind for the others.
after(() => {
  db.exec('DELETE FROM Shift; DELETE FROM ShiftPerson;');
  mailer.setTransportForTests(null);
});

test('shift headers and cells are read the way the sheet is written', () => {
  assert.deepEqual(roster.parseShiftHeader('5 PM-1 AM Remote'), { label: '5 PM-1 AM', start: 17 * 60, minutes: 480 });
  assert.deepEqual(roster.parseShiftHeader('9 AM-5 PM'), { label: '9 AM-5 PM', start: 9 * 60, minutes: 480 });
  assert.equal(roster.parseShiftHeader('12 AM - 8:30 AM').minutes, 510);
  assert.equal(roster.parseShiftHeader('Off'), null);
  assert.deepEqual(roster.parseAssignee('Jose L (Remote)'), { name: 'Jose L', location: 'Remote' });
  assert.deepEqual(roster.parseAssignee('Ethan'), { name: 'Ethan', location: null });
  assert.equal(roster.parseAssignee('  '), null);
});

test('a sheet day runs 09:00 → 09:00: the 1 AM-9 AM cell is the night AFTER its date', () => {
  const shifts = roster.parseRoster(workbook(SHEET));
  assert.equal(shifts.length, 6, 'the Off column and the other columns are not shifts');
  const first = shifts.filter((s) => s.day === '2030-03-01');
  assert.deepEqual(first.map((s) => [s.label, s.sheetName, s.startsAt, s.endsAt]), [
    ['9 AM-5 PM', 'Nick', iso(2030, 3, 1, 9), iso(2030, 3, 1, 17)],
    ['5 PM-1 AM', 'Simeon', iso(2030, 3, 1, 17), iso(2030, 3, 2, 1)],
    ['1 AM-9 AM', 'Jose L', iso(2030, 3, 2, 1), iso(2030, 3, 2, 9)],
  ]);
  assert.throws(() => roster.parseRoster(zip({ 'xl/worksheets/sheet1.xml': '<worksheet><sheetData/></worksheet>' })), /no shifts found/);
  assert.throws(() => roster.parseRoster(Buffer.from('not a zip at all')), /not an Excel file/);
});

test('people become codes, and a re-import keeps the codes and their e-mails', () => {
  const r = roster.importRoster(workbook(SHEET));
  assert.equal(r.shifts, 6);
  assert.deepEqual(r.added.map((p) => `${p.code}=${p.sheetName}`), ['A=Nick', 'B=Simeon', 'C=Jose L', 'D=Ethan']);
  roster.savePeople([
    { code: 'A', name: 'Nick', email: 'nick@example.gy' },
    { code: 'B', name: 'Simeon', email: 'simeon@example.gy' },
    { code: 'C', name: 'Jose', email: 'jose@example.gy' },
    { code: 'D', name: '', email: '' },
  ]);
  assert.throws(() => roster.savePeople([{ code: 'A', email: 'nope' }]), /not an e-mail/);
  assert.throws(() => roster.savePeople([{ code: 'Z', email: 'z@example.gy' }]), /unknown code/);

  const again = roster.importRoster(workbook(SHEET));
  assert.deepEqual(again.added, []);
  assert.equal(roster.listPeople().find((p) => p.code === 'C').email, 'jose@example.gy');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Shift').get().n, 6, 'a re-import replaces, never duplicates');
});

test('an alert goes only to whoever is on shift — and to the whole list when the roster cannot say', () => {
  // Fri 20:00 — Simeon (B).
  let r = roster.alertRecipients(at(2030, 3, 1, 20));
  assert.deepEqual(r.to, ['simeon@example.gy']);
  assert.match(r.note, /B · Simeon \(until 01:00\)/);
  // Sat 10:00 — Ethan (D), who has no e-mail: nobody may be left unwarned.
  r = roster.alertRecipients(at(2030, 3, 2, 10));
  assert.equal(r.to, null);
  assert.match(r.note, /D \(Ethan\) is on shift but has no e-mail/);
  // After the sheet ends.
  r = roster.alertRecipients(at(2030, 4, 1, 10));
  assert.equal(r.to, null);
  assert.match(r.note, /nobody is on the shift roster/);
});

test('the alert e-mail itself goes to the on-shift person only, and says so', async () => {
  const realNow = Date.now;
  Date.now = () => at(2030, 3, 1, 20);
  try {
    sent.length = 0;
    const source = { id: 'x', name: 'GLC Junior', url: 'http://feed/x.m3u8', enabled: true, channelId: null };
    mon.enqueueMail({ type: 'open', kind: 'black', source, incident: { startedAt: new Date(at(2030, 3, 1, 19, 59)).toISOString() }, at: Date.now() });
    const r = await mon.flushMail();
    assert.equal(r.sent, true);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].bcc.map((b) => b.address), ['simeon@example.gy']);
    assert.match(sent[0].text, /Sent to whoever is on shift: B · Simeon/);
  } finally {
    Date.now = realNow;
  }
});

test('shift notices: 30 min before the start, once; when it ends, naming who takes over', async () => {
  sent.length = 0;
  db.exec('UPDATE Shift SET start_notice_at = NULL, end_notice_at = NULL, notice_error = NULL');
  const to = () => sent.map((m) => `${m.bcc[0].address}: ${m.subject}`);

  // 08:00 on Friday: nothing is within 30 minutes yet — but every earlier
  // shift (none here) would be recorded, not mailed.
  await roster.checkShiftNotices(at(2030, 3, 1, 8, 0));
  assert.deepEqual(to(), []);

  await roster.checkShiftNotices(at(2030, 3, 1, 8, 30));
  assert.deepEqual(to(), ['nick@example.gy: [Shift] Your shift starts at 09:00 — until 17:00']);
  await roster.checkShiftNotices(at(2030, 3, 1, 8, 45));
  assert.equal(sent.length, 1, 'never twice');

  sent.length = 0;
  await roster.checkShiftNotices(at(2030, 3, 1, 16, 30));
  assert.deepEqual(to(), ['simeon@example.gy: [Shift] Your shift starts at 17:00 — until 01:00']);
  sent.length = 0;
  await roster.checkShiftNotices(at(2030, 3, 1, 17, 0, 30));
  assert.deepEqual(to(), ['nick@example.gy: [Shift] Your shift ended at 17:00']);
  assert.match(sent[0].text, /Alerts now go to B · Simeon/);
});

test('back-to-back shifts of one person are one stretch: no "ended" then "starts" in the middle', async () => {
  sent.length = 0;
  const to = () => sent.map((m) => `${m.bcc[0].address}: ${m.subject}`);
  // Sat: Jose works 5 PM-1 AM and then 1 AM-9 AM.
  // (00:30 Sat is also the notice for Jose's Friday-night 1 AM-9 AM shift — not what this test is about.)
  await roster.checkShiftNotices(at(2030, 3, 2, 0, 30));
  sent.length = 0;
  await roster.checkShiftNotices(at(2030, 3, 2, 16, 30));
  assert.deepEqual(to(), ['jose@example.gy: [Shift] Your shift starts at 17:00 — until 09:00']);
  sent.length = 0;
  await roster.checkShiftNotices(at(2030, 3, 3, 0, 30));
  await roster.checkShiftNotices(at(2030, 3, 3, 1, 0, 30));
  assert.deepEqual(to(), [], 'no notice at 01:00 between the two');
  await roster.checkShiftNotices(at(2030, 3, 3, 9, 0, 30));
  assert.deepEqual(to(), ['jose@example.gy: [Shift] Your shift ended at 09:00']);
});

test('an "ended" notice the app was too late for is recorded, not sent hours later', async () => {
  db.exec('UPDATE Shift SET end_notice_at = NULL');
  sent.length = 0;
  await roster.checkShiftNotices(at(2030, 3, 3, 13, 0));
  assert.deepEqual(sent, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Shift WHERE end_notice_at IS NULL').get().n, 0);
});
