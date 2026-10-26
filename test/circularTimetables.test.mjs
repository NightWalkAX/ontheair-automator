// Migration 009: the lesson channels mirror the MoE national timetables, one
// grade band per channel — applied to the production line-up of 2026-10-26.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-009-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-009cfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const m = await import('../src/migrations/009-circular-timetables.js');
const { localDate, addDays } = await import('../src/dates.js');
initSchema();

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'templates-2026-10-26.json'), 'utf8'));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
// Templates end at :59 or 23:59 in places; the minute after is the gap the day
// extension absorbs (linkShifts), so it counts as covered.
const endMin = (t) => (t.endsWith(':59') ? mins(t) + 1 : mins(t));
const run = (p) => { for (const op of p.ops) db.prepare(op.sql).run(...op.params); };

function load() {
  for (const c of fixture.channels) db.prepare('INSERT INTO ChannelType (id, name, playout) VALUES (?, ?, ?)').run(c.id, c.name, c.playout);
  const subjects = new Set();
  for (const t of fixture.templates) {
    db.prepare(`INSERT INTO BlockTemplate (id, channel_id, name, weekday, weekdays, start_time, end_time, content_type, is_movie_block, movie_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'series', ?, ?)`).run(t.id, t.channel_id, t.name, t.weekdays.split(',')[0], t.weekdays,
      t.slots[0][0], t.slots[0][1], t.is_movie_block, t.movie_limit);
    for (const c of t.channels) db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(t.id, c);
    t.slots.forEach(([s, e], i) => db.prepare('INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (?, ?, ?, ?)')
      .run(t.id, s, e, i ? 1 : 0));
    t.series.forEach((s, i) => { db.prepare('INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, ?, ?)').run(t.id, s, i); subjects.add(s); });
  }
  for (const cfg of m.BANDS) for (const t of m.expandTimetable(cfg)) t.series.forEach((s) => subjects.add(s));
  for (const t of m.EXTRA) t.series.forEach((s) => subjects.add(s));
  // Every subject is in the catalogue except the ones production lacks.
  const absent = new Set(['Grade 3 Mathematics', 'Grade 3 Social Studies']);
  const ins = db.prepare('INSERT INTO Resource (name, file_path, duration, subject, chapter, approved, channel_id) VALUES (?, ?, 600, ?, 1, 1, ?)');
  for (const c of fixture.channels) for (const s of subjects) if (!absent.has(s)) ins.run(s, `/lib/${s}.mov`, s, c.id);
}

/** [{ channel, day, start, end, series[] }] of every active airing, by channel name. */
function airings() {
  return db.prepare(`
    SELECT c.name AS channel, bt.id, bt.weekdays, s.start_time, s.end_time,
      (SELECT GROUP_CONCAT(subject, '|') FROM BlockTemplateSeries WHERE template_id = bt.id) AS series
    FROM BlockTemplate bt JOIN BlockTemplateChannel btc ON btc.template_id = bt.id
    JOIN ChannelType c ON c.id = btc.channel_id JOIN BlockTemplateSlot s ON s.template_id = bt.id
    WHERE bt.weekdays != ''`).all()
    .flatMap((r) => r.weekdays.split(',').map((day) => ({ ...r, day, series: r.series ? r.series.split('|') : [] })));
}

test('expandTimetable: each grade band mirrors its circular, with replays', () => {
  const [junior, elementary, analog] = m.BANDS.map((cfg) => m.expandTimetable(cfg));
  const at = (tpls, day, start) => tpls.find((t) => t.weekdays.split(',').includes(day) && t.slots[0][0] === start);

  // Grade 1–2, Tuesday 09:30–10:30 Mathematics; replayed 00:30 and 17:30.
  const tueMaths = at(junior, 'Tue', '09:30');
  assert.deepEqual(tueMaths.series, ['Grade 1 Mathematics', 'Grade 2 Mathematics']);
  assert.deepEqual(tueMaths.slots, [['09:30', '10:30'], ['00:30', '01:30'], ['17:30', '18:30']]);
  // Letters & Sounds absorbs the assembly: R.E.A.D 09:00–09:30, all week.
  assert.equal(at(junior, 'Mon', '09:00').weekdays, 'Mon,Tue,Wed,Thu,Fri');
  assert.deepEqual(at(junior, 'Mon', '09:00').series, ['R.E.A.D']);
  // Reading + Literacy Hour are both English: one block 10:45–12:00 on Tue and Thu.
  assert.deepEqual(at(junior, 'Tue', '10:45').slots[0], ['10:45', '12:00']);
  // A 20-minute period can't hold two grades: Tue/Thu lead with Grade 2.
  assert.deepEqual(at(junior, 'Thu', '10:45').series, ['Grade 2 English Language', 'Grade 1 English Language']);
  // A period under 30 minutes joins its neighbour: Tuesday's Science (14:10–14:30)
  // opens the session, so it leads the 14:30 support block.
  assert.deepEqual(at(junior, 'Tue', '14:10').slots[0], ['14:10', '15:00']);
  assert.deepEqual(at(junior, 'Tue', '14:10').series,
    ['Grade 2 Science', 'Grade 1 Science', 'Grade 2 Mathematics', 'Grade 1 Mathematics']);
  // A short enrichment period only lends its time; afternoons have no 17–20 repeat.
  assert.deepEqual(at(junior, 'Mon', '14:10').series, ['Grade 1 English Language', 'Grade 2 English Language']);
  assert.equal(at(junior, 'Mon', '14:10').slots.length, 2);
  assert.deepEqual(at(junior, 'Fri', '13:00').series, ['Your Government and You', 'Grade 1 Social Studies', 'Grade 2 Social Studies']);

  // Grades 3–4: Grade 4 leads, Grade 3 follows; Letters & Sounds is Literacy.
  assert.deepEqual(at(elementary, 'Mon', '13:00').series,
    ['Grade 4 Science', 'Grade 3 Science', 'Grade 4 English Language', 'Grade 3 English Language']);
  assert.deepEqual(at(elementary, 'Wed', '09:00').series, ['English Language']);
  assert.deepEqual(at(elementary, 'Tue', '14:10').series, ['Yoga on the Beach']);

  // Grades 5–6 on the analog channel: no evening repeat, recess is fillers, lunch
  // is its own documentary.
  assert.deepEqual(at(analog, 'Wed', '10:00').series, ['Your Government and You']);
  assert.deepEqual(at(analog, 'Mon', '10:30').series, []);
  assert.deepEqual(at(analog, 'Mon', '09:00').slots, [['09:00', '10:30'], ['00:00', '01:30']]);
  assert.equal(analog.some((t) => t.slots[0][0] === '12:00'), false);
});

test('009 on the production line-up: one grade per channel, every minute once, today kept', () => {
  load();
  const today = localDate();
  const tomorrow = addDays(today, 1);
  // Production has: today exported, the rest of the week approved.
  const serial = db.prepare("SELECT id FROM Resource WHERE subject = 'Grade 1 Mathematics' AND channel_id = 4").get().id;
  db.prepare("UPDATE Resource SET chapter = 5 WHERE id = ?").run(serial);
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, is_serial, cursor_chapter) VALUES (4, 'Grade 1 Mathematics', 1, 6)").run();
  const slot93 = db.prepare('SELECT id FROM BlockTemplateSlot WHERE template_id = 93 AND slot_order = 0').get().id;
  const future = db.prepare("INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status) VALUES (93, ?, 4, ?, 'approved') RETURNING id")
    .get(slot93, tomorrow).id;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)').run(future, serial);
  db.prepare("INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, 4, ?)").run(serial, `${tomorrow}T08:00:00`);
  const slot94 = db.prepare('SELECT id FROM BlockTemplateSlot WHERE template_id = 94').get().id;
  const onAir = db.prepare("INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status) VALUES (94, ?, 4, ?, 'exported') RETURNING id")
    .get(slot94, today).id;

  const p = m.plan();
  assert.ok(!p.summary.some((l) => l.startsWith('skipped')), p.summary.join('\n'));
  assert.ok(p.summary.some((l) => /left out: Grade 3 Mathematics, Grade 3 Social Studies/.test(l)), p.summary.join('\n'));
  run(p);

  // Today's block is untouched, slot and all; the template it belongs to is retired.
  const kept = db.prepare('SELECT sb.slot_id, s.start_time, bt.weekdays FROM ScheduledBlock sb JOIN BlockTemplateSlot s ON s.id = sb.slot_id JOIN BlockTemplate bt ON bt.id = sb.template_id WHERE sb.id = ?').get(onAir);
  assert.deepEqual({ ...kept }, { slot_id: slot94, start_time: '11:00', weekdays: '' });
  // Tomorrow's is gone, its play taken back and the series rewound to the episode it held.
  assert.equal(db.prepare('SELECT 1 FROM ScheduledBlock WHERE id = ?').get(future), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM PlayHistory').get().n, 0);
  assert.equal(db.prepare("SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = 4 AND subject = 'Grade 1 Mathematics'").get().cursor_chapter, 5);

  const all = airings();
  // Junior, Elementary and the analog channel cover every minute of every day exactly once.
  for (const channel of ['Junior', 'Elementary', 'Analog']) {
    for (const day of DAYS) {
      const cover = new Array(1440).fill(0);
      for (const a of all.filter((x) => x.channel === channel && x.day === day)) {
        for (let n = mins(a.start_time); n < endMin(a.end_time); n++) cover[n]++;
      }
      const bad = cover.findIndex((n) => n !== 1);
      assert.equal(bad, -1, `${channel} ${day}: minute ${bad} (${Math.floor(bad / 60)}:${bad % 60}) covered ${cover[bad]} times`);
    }
  }

  // No grade subject, and nothing the migration placed, is on two channels at once.
  const watched = new Set();
  for (const a of all) for (const s of a.series) if (/^Grade \d|^Nursery$|^R\.E\.A\.D$/.test(s)) watched.add(s);
  // Not the cartoons of recess and lunch, nor the analog morning documentary:
  // those series are shared with other channels' shows, and the generator simply
  // skips one that is busy elsewhere (a recess then airs fillers).
  const cartoons = new Set(m.BANDS.flatMap((cfg) => [...cfg.recess, ...(cfg.lunch || [])]));
  for (const cfg of m.BANDS) for (const t of m.expandTimetable(cfg)) t.series.forEach((s) => cartoons.has(s) || watched.add(s));
  for (const t of m.EXTRA.filter((x) => !/Documentary/.test(x.name))) t.series.forEach((s) => watched.add(s));
  for (const s of ['Math Intervention', 'Beatin da Maths', 'Forts and Monuments', 'The Amazing World of Cho', 'EDYOU PULSE']) watched.add(s);
  for (const day of DAYS) {
    const on = new Map(); // subject -> per-minute channel
    for (const a of all.filter((x) => x.day === day)) {
      for (const s of a.series.filter((x) => watched.has(x))) {
        if (!on.has(s)) on.set(s, new Array(1440).fill(null));
        const row = on.get(s);
        for (let n = mins(a.start_time); n < endMin(a.end_time); n++) {
          assert.ok(row[n] === null || row[n] === a.channel,
            `${day} ${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}: "${s}" on ${row[n]} and ${a.channel}`);
          row[n] = a.channel;
        }
      }
    }
  }

  // Discover keeps only Grades 10–11.
  const academics = db.prepare('SELECT subject FROM BlockTemplateSeries WHERE template_id = 2').all().map((r) => r.subject);
  assert.ok(academics.length && academics.every((s) => /^Grade 1[01]\b/.test(s)), academics.join(', '));

  // The film slots that were plain blocks of "Movies" are movie blocks now.
  const night = db.prepare('SELECT is_movie_block, movie_limit FROM BlockTemplate WHERE id = 96').get();
  assert.deepEqual({ ...night }, { is_movie_block: 1, movie_limit: 3 });

  // Run again: nothing to do.
  assert.equal(m.plan().ops.length, 0);
});
