// Migration 010: two grades per digital channel, Elementary lowest … Discover
// highest; the analog channel repeats classes — on the production line-up of
// 2026-10-28 (after 009).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-010-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-010cfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const m = await import('../src/migrations/010-grade-pairs.js');
const { localDate, addDays } = await import('../src/dates.js');
initSchema();

const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'templates-2026-10-28.json'), 'utf8'));
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
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
  for (const cfg of m.PAIRS) for (const t of m.expandPair(cfg)) t.series.forEach((s) => subjects.add(s));
  for (const t of m.EXTRA) t.series.forEach((s) => subjects.add(s));
  const ins = db.prepare('INSERT INTO Resource (name, file_path, duration, subject, chapter, approved, channel_id) VALUES (?, ?, 600, ?, 1, 1, ?)');
  for (const c of fixture.channels) for (const s of subjects) ins.run(s, `/lib/${s}.mov`, s, c.id);
}

function airings() {
  return db.prepare(`
    SELECT c.name AS channel, bt.name, bt.weekdays, s.start_time, s.end_time, s.slot_order,
      (SELECT GROUP_CONCAT(subject, '|') FROM BlockTemplateSeries WHERE template_id = bt.id) AS series
    FROM BlockTemplate bt JOIN BlockTemplateChannel btc ON btc.template_id = bt.id
    JOIN ChannelType c ON c.id = btc.channel_id JOIN BlockTemplateSlot s ON s.template_id = bt.id
    WHERE bt.weekdays != ''`).all()
    .flatMap((r) => r.weekdays.split(',').map((day) => ({ ...r, day, series: r.series ? r.series.split('|') : [] })));
}
const gradeOf = (s) => (/^(Nursery|Numeracy|R\.E\.A\.D)$/.test(s) ? 0 : Number(s.match(/^Grade (\d+)\b/)?.[1] ?? NaN));

test('expandPair: each channel mirrors a circular with its two grades', () => {
  const at = (cfg, day, start) => m.expandPair(m.PAIRS.find((p) => p.channel === cfg))
    .find((t) => t.weekdays.split(',').includes(day) && t.slots[0][0] === start);
  // Elementary — Grade 1 alone after the nursery hour; Letters & Sounds is R.E.A.D.
  assert.deepEqual(at('Elementary', 'Tue', '09:30').series, ['Grade 1 Mathematics']);
  assert.deepEqual(at('Elementary', 'Mon', '09:00').series, ['R.E.A.D']);
  // Junior — Grades 2 and 3; Letters & Sounds is their English.
  assert.deepEqual(at('Junior', 'Tue', '09:30').series, ['Grade 2 Mathematics', 'Grade 3 Mathematics']);
  assert.deepEqual(at('Junior', 'Thu', '09:00').series, ['Grade 3 English Language', 'Grade 2 English Language']);
  // TeenEd — Grades 4 and 5 on the Grade 3–4 timetable.
  assert.deepEqual(at('TeenEd', 'Wed', '10:45').series, ['Grade 4 Science', 'Grade 5 Science']);
  // Elevate — Grade 6's own timetable: Wednesday 10:00 Moral & Civic (Your
  // Government and You for Grade 6, the electives for Grade 7).
  assert.deepEqual(at('Elevate', 'Wed', '10:00').series.slice(0, 2), ['Your Government and You', 'Grade 7 Spanish']);
  // MoE Central — secondary English is Language + Literature.
  assert.deepEqual(at('MoE Central', 'Mon', '10:45').series,
    ['Grade 8 English Language', 'Grade 8 English Literature', 'Grade 9 English Language', 'Grade 9 English Literature']);
  // Discover — replayed overnight and in the evening; Elevate and MoE are not.
  assert.deepEqual(at('Discover', 'Mon', '09:00').slots, [['09:00', '10:30'], ['00:00', '01:30'], ['17:00', '18:30']]);
  assert.equal(at('Elevate', 'Mon', '09:00').slots.length, 1);
});

test('010 on the production line-up: two grades per channel, every minute once', () => {
  load();
  const tomorrow = addDays(localDate(), 1);
  const slot = db.prepare("SELECT s.id FROM BlockTemplateSlot s JOIN BlockTemplate bt ON bt.id = s.template_id WHERE bt.name = 'Academics' AND s.slot_order = 0").get().id;
  const future = db.prepare("INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status) VALUES (2, ?, 1, ?, 'approved') RETURNING id")
    .get(slot, tomorrow).id;

  const p = m.plan();
  assert.ok(!p.summary.some((l) => l.startsWith('skipped')), p.summary.join('\n'));
  run(p);
  assert.equal(db.prepare('SELECT 1 FROM ScheduledBlock WHERE id = ?').get(future), undefined, 'blocks after today are rebuilt');

  const all = airings();
  // Every channel covers every minute of every day exactly once.
  for (const channel of ['Elementary', 'Junior', 'TeenEd', 'Elevate', 'MoE Central', 'Discover', 'Analog']) {
    for (const day of DAYS) {
      const cover = new Array(1440).fill(0);
      const who = new Array(1440).fill('');
      for (const a of all.filter((x) => x.channel === channel && x.day === day)) {
        for (let n = mins(a.start_time); n < endMin(a.end_time); n++) { cover[n]++; who[n] += `[${a.name}]`; }
      }
      // Elevate's nights are its 20:00 films running on to the morning (linkShifts
      // extends the day's last block to the next day's first), as before.
      if (channel === 'Elevate') for (let n = 0; n < 6 * 60; n++) if (!cover[n]) cover[n] = 1;
      const bad = cover.findIndex((n) => n !== 1);
      assert.equal(bad, -1, `${channel} ${day}: ${Math.floor(bad / 60)}:${String(bad % 60).padStart(2, '0')} covered ${cover[bad]} times ${who[bad]}`);
    }
  }

  // Mon–Fri 09:00–15:00, each digital channel airs only its own two grades.
  const own = { Elementary: [0, 1], Junior: [2, 3], TeenEd: [4, 5], Elevate: [6, 7], 'MoE Central': [8, 9], Discover: [10, 11] };
  for (const a of all.filter((x) => own[x.channel] && x.slot_order === 0 && DAYS.indexOf(x.day) < 5
    && mins(x.start_time) >= 9 * 60 && mins(x.start_time) < 15 * 60)) {
    for (const s of a.series) {
      const g = gradeOf(s);
      if (!Number.isNaN(g)) assert.ok(own[a.channel].includes(g), `${a.channel} ${a.day} ${a.start_time} airs ${s}`);
    }
  }
  // Every grade has its school day somewhere.
  const graded = new Set(all.filter((a) => own[a.channel]).flatMap((a) => a.series.map(gradeOf)).filter((g) => !Number.isNaN(g)));
  for (let g = 0; g <= 11; g++) assert.ok(graded.has(g), `grade ${g} airs`);

  // No grade subject is on two channels at once.
  for (const day of DAYS) {
    const on = new Map();
    for (const a of all.filter((x) => x.day === day)) {
      for (const s of a.series.filter((x) => !Number.isNaN(gradeOf(x)))) {
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

  // Run again: nothing to do.
  assert.equal(m.plan().ops.length, 0);
});
