// Migration 007: the template conflicts found on 2026-10-04, keyed to the
// production ids, applied only when the rows still look as they did then.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-007-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-007cfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const m007 = await import('../src/migrations/007-template-conflicts-2026-10.js');
const { pickMovieRun } = await import('../src/services/scheduling.js');
const { localDate, addDays } = await import('../src/dates.js');
initSchema();

const ch = (id, name) => db.prepare('INSERT INTO ChannelType (id, name) VALUES (?, ?)').run(id, name);
function tpl(id, channel, name, weekdays, slots) {
  db.prepare(`INSERT INTO BlockTemplate (id, channel_id, name, weekday, weekdays, start_time, end_time)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, channel, name, weekdays.split(',')[0], weekdays, slots[0][0], slots[0][1]);
  db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(id, channel);
  slots.forEach(([s, e], i) => db.prepare(
    'INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (?, ?, ?, ?)').run(id, s, e, i));
}
const run = (p) => { for (const op of p.ops) db.prepare(op.sql).run(...op.params); };

test('007 fixes the conflicts it recognises and leaves edited rows alone', () => {
  ch(1, 'Discover'); ch(2, 'MoE Central'); ch(3, 'Elevate'); ch(7, 'Elementary');
  tpl(17, 1, 'Morning Shows', 'Tue', [['06:00', '08:00']]);
  db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (17, 3)').run();
  tpl(33, 3, 'Yoga on the Beach', 'Mon,Tue,Thu,Fri', [['11:30', '12:00']]);
  tpl(35, 3, 'Your Government & You', 'Mon,Thu', [['12:30', '13:05']]);
  tpl(115, 7, 'Elementary Weekend 10 - 12', 'Sat,Sun', [['10:00', '23:59']]);
  tpl(67, 2, 'Yoga on the Beach', 'Mon,Tue,Wed,Thu,Fri', [['10:00', '10:30']]);
  tpl(47, 3, "Let's Talk Autism", 'Wed', [['10:00', '10:30']]);
  tpl(44, 3, 'Something else now', 'Wed', [['08:30', '09:00']]); // renamed by hand: skipped

  // A future approved Tuesday block of 17, with its play recorded; a past one stays.
  let tue = addDays(localDate(), 1);
  while (new Date(`${tue}T00:00:00Z`).getUTCDay() !== 2) tue = addDays(tue, 1);
  const res = db.prepare("INSERT INTO Resource (name, file_path, duration, channel_id) VALUES ('m', '/m.mov', 7200, 1) RETURNING id").get().id;
  const future = db.prepare("INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status) VALUES (17, 1, ?, 'approved') RETURNING id").get(tue).id;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)').run(future, res);
  db.prepare('INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, 1, ?)').run(res, `${tue}T06:00:00`);
  const past = db.prepare("INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status) VALUES (17, 1, '2026-09-29', 'exported') RETURNING id").get().id;

  const p = m007.plan();
  assert.ok(p.summary.some((l) => /template 44 .* repeat/.test(l) && l.startsWith('skipped')), p.summary.join('\n'));
  run(p);

  const t = (id) => db.prepare('SELECT * FROM BlockTemplate WHERE id = ?').get(id);
  const slots = (id) => db.prepare('SELECT start_time, end_time FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order').all(id)
    .map((s) => `${s.start_time}-${s.end_time}`);
  assert.equal(t(17).weekdays, '');
  assert.equal(t(17).weekday, '');
  assert.match(t(17).name, /retired/);
  assert.equal(t(33).weekdays, 'Mon,Thu');
  assert.deepEqual(slots(35), ['12:30-13:00']);
  assert.deepEqual(slots(115), ['10:00-12:00']);
  assert.deepEqual(slots(67), ['10:00-10:30', '19:00-19:30']);
  assert.deepEqual(slots(47), ['10:00-10:30', '19:00-20:00']);
  assert.deepEqual(slots(44), ['08:30-09:00'], 'a template edited since is not touched');
  assert.equal(db.prepare('SELECT 1 FROM ScheduledBlock WHERE id = ?').get(future), undefined, 'the future duplicate is gone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM PlayHistory WHERE resource_id = ?').get(res).n, 0, 'and so is its recorded play');
  assert.ok(db.prepare('SELECT 1 FROM ScheduledBlock WHERE id = ?').get(past), 'history is kept');

  // Idempotent: a second plan finds nothing left to do.
  assert.equal(m007.plan().ops.length, 0);
});

test('a movie block with no saga mid-run may start one when every standalone film is cooling', () => {
  const movies = db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
  const c = db.prepare("INSERT INTO ChannelType (name) VALUES ('Saga only') RETURNING id").get().id;
  const film = (name, subject, chapter) => db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject, chapter)
    VALUES (?, ?, 5400, 0, 1, ?, ?, ?, ?) RETURNING id`).get(name, `/s/${name}.mov`, c, movies, subject, chapter).id;
  const solo = film('Solo', 'Movies', 0);
  film('Saga_1', 'Saga', 1);
  film('Saga_2', 'Saga', 2);
  // The only standalone film aired yesterday: it is cooling down.
  db.prepare("INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, ?, '2031-02-01T20:00:00')").run(solo, c);
  const run = pickMovieRun({ id: 0, is_movie_block: 1, movie_limit: 1 }, { id: 0, target_date: '2031-02-02' }, 7200, 0, c);
  assert.deepEqual(run.map((r) => r.name), ['Saga_1'], 'the next saga starts at its first part — never part 2');
});

test('fillers are spread between programmes by TIME, and cooling films close a hole fresh ones cannot', async () => {
  const { spreadFillers, moviePool } = await import('../src/services/scheduling.js');
  const M = (id) => ({ id, duration: 5000, is_filler: 0 });
  const F = (id, d) => ({ id, duration: d, is_filler: 1 });
  // One 11-minute filler and eight short ones, two gaps: by count the long one
  // and four short ones shared a gap; by time the long one sits alone-ish.
  const out = spreadFillers([M('A')], [F('big', 685), ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => F(`s${i}`, 120))]);
  const gapSecs = [];
  let run = 0;
  for (const r of [...out, M('end')]) { if (r.is_filler) run += r.duration; else { gapSecs.push(run); run = 0; } }
  assert.ok(Math.max(...gapSecs) <= 1645 / 2 + 120, `gaps ${gapSecs}`); // by count it was 685 + 4×120 = 1165 vs 480
  assert.equal(out.filter((r) => r.is_filler).length, 9);

  // Two fresh films leave 45 minutes; a cooling third one closes it.
  const movies = db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
  const c = db.prepare("INSERT INTO ChannelType (name) VALUES ('Cooling') RETURNING id").get().id;
  const film = (name, d) => db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject, chapter)
    VALUES (?, ?, ?, 0, 1, ?, ?, 'Movies', 0) RETURNING id`).get(name, `/c/${name}.mov`, d, c, movies).id;
  film('Fresh1', 6500); film('Fresh2', 5100);
  const cooling = [film('Cool1', 2800), film('Cool2', 9000), film('Cool3', 9100), film('Cool4', 9200)];
  for (const id of cooling) db.prepare("INSERT INTO PlayHistory (resource_id, channel_id, played_at) VALUES (?, ?, '2031-03-01T20:00:00')").run(id, c);
  const tplRow = { id: 0, is_movie_block: 1, movie_limit: 3 };
  const blk = { id: 0, target_date: '2031-03-02' };
  assert.deepEqual(moviePool(tplRow, blk, 14400, c, null).map((r) => r.name).sort(), ['Fresh1', 'Fresh2']);
  const picked = pickMovieRun(tplRow, blk, 14400, 0, c).map((r) => r.name);
  const total = picked.reduce((n, name) => n + { Fresh1: 6500, Fresh2: 5100, Cool1: 2800, Cool2: 9000, Cool3: 9100, Cool4: 9200 }[name], 0);
  assert.ok(14400 - total <= 1200, `hole ${14400 - total}s with ${picked}`);
});
