// A channel's day is ONE continuous OTAV playlist. Anything that makes it end
// before the next day's event starts is black on air — these tests pin the
// causes found in production: blocks pushed in the wrong order or into the
// wrong channel, today's playlist rebuilt while it plays, and clips whose files
// are gone.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-day-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-daycfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const { router: otav } = await import('../src/routes/otav.js');
const { dayBlocks } = await import('../src/services/otavClient.js');
const { missingFilesInRange } = await import('../src/services/blockValidation.js');
const { moviePool } = await import('../src/services/scheduling.js');
const { localDate, addDays } = await import('../src/dates.js');

let server, base;
const media = mkdtempSync(join(tmpdir(), 'otav-day-media-'));

async function j(method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

before(async () => {
  initSchema();
  const app = express();
  app.use(express.json());
  app.use('/api/otav', otav);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const channel = (name) => db.prepare(
  "INSERT INTO ChannelType (name, api_ip, api_port) VALUES (?, '127.0.0.1', 1) RETURNING id",
).get(name).id;

/** A template on `owner` with one slot per [start, end]; returns the slot ids. */
function template(owner, name, slots) {
  const tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
                          VALUES (?, ?, 'Mon', 'Mon', ?, ?) RETURNING id`).get(owner, name, slots[0][0], slots[0][1]).id;
  const ids = slots.map(([s, e], i) => db.prepare(`INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order)
                                                   VALUES (?, ?, ?, ?) RETURNING id`).get(tpl, s, e, i).id);
  return { tpl, slots: ids };
}

const block = (tpl, slot, ch, date, status = 'approved') => db.prepare(`
  INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status)
  VALUES (?, ?, ?, ?, ?) RETURNING id`).get(tpl, slot, ch, date, status).id;

test('a day is pushed in SLOT order, under the block\'s own channel', () => {
  const date = '2031-03-03';
  const a = channel('Air order A');
  const b = channel('Air order B');
  // Primary at 08:00, repeat at 17:00 — the repeat must air at 17:00, not
  // right behind its primary (the old ORDER BY bt.start_time did exactly that).
  const lessons = template(a, 'Lessons', [['08:00', '09:00'], ['17:00', '18:00']]);
  const shows = template(a, 'Shows', [['10:00', '17:00']]);
  // A template owned by B that also airs on A: its block belongs in A's playlist.
  const shared = template(b, 'Shared', [['20:00', '00:00']]);

  const l8 = block(lessons.tpl, lessons.slots[0], a, date);
  const l17 = block(lessons.tpl, lessons.slots[1], a, date);
  const s10 = block(shows.tpl, shows.slots[0], a, date);
  const sh = block(shared.tpl, shared.slots[0], a, date);
  block(shows.tpl, shows.slots[0], a, date.replace('03-03', '03-04')); // another day: ignored
  const draft = template(a, 'Draft', [['18:00', '20:00']]);
  block(draft.tpl, draft.slots[0], a, date, 'draft'); // drafts never go to air

  const rows = dayBlocks(date).filter((r) => r.channel_id === a);
  assert.deepEqual(rows.map((r) => r.block_id), [l8, s10, l17, sh]);
  assert.deepEqual(rows.map((r) => r.start_time), ['08:00', '10:00', '17:00', '20:00']);
  assert.ok(rows.every((r) => r.channel_name === 'Air order A'), 'the shared template airs under A');
  assert.equal(dayBlocks(date).filter((r) => r.channel_id === b).length, 0, 'and nothing leaks into B');
});

test('pushing TODAY needs explicit confirmation; a week push holds today back', async () => {
  const today = localDate();
  const ch = channel('Today guard');
  const t = template(ch, 'Today', [['06:00', '07:00']]);
  block(t.tpl, t.slots[0], ch, today);

  const refused = await j('POST', `/api/otav/push?date=${today}&channels=${ch}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.needsConfirm, 'today');

  // A past or future single day is not on air: no confirmation needed. (The
  // push itself fails against port 1 — what matters is that it was attempted.)
  const other = await j('POST', `/api/otav/push?date=${addDays(today, 1)}&channels=${ch}`);
  assert.notEqual(other.status, 409);

  const week = await j('POST', `/api/otav/push?week=${addDays(today, -1)}&channels=${ch}`);
  assert.equal(week.status, 200);
  assert.deepEqual(week.data.held, [today], 'today is reported as held, not pushed');
  assert.ok(!week.data.days.some((d) => d.targetDate === today));
});

test('a clip whose file is gone stops the push before OTAV is touched', async () => {
  const date = '2031-03-10';
  const ch = channel('Missing file');
  const t = template(ch, 'Movies', [['20:00', '22:00']]);
  const b = block(t.tpl, t.slots[0], ch, date);
  const here = join(media, 'here.mov');
  writeFileSync(here, 'x');
  const clip = db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id)
                           VALUES (?, ?, ?, 0, 1, ?) RETURNING id`);
  const ins = db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, ?)');
  ins.run(b, clip.get('Here', here, 3600, ch).id, 0);
  ins.run(b, clip.get('Gone', join(media, 'gone.mov'), 3600, ch).id, 1);

  const missing = await missingFilesInRange(date, date, [ch]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].file_path, join(media, 'gone.mov'));
  assert.equal(missing[0].seconds, 3600, 'how much air the day would lose');
  assert.equal(missing[0].blocks[0].id, b);

  const r = await j('POST', `/api/otav/push?date=${date}&channels=${ch}`);
  assert.equal(r.status, 409);
  assert.equal(r.data.missing.length, 1);
});

test('the generator never picks a clip Air Spec found missing', () => {
  const ch = channel('Missing pick');
  const movies = db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
  const ins = db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject)
                          VALUES (?, ?, 5400, 0, 1, ?, ?, 'Films') RETURNING id`);
  ins.get('Kept', '/films/kept.mov', ch, movies);
  ins.get('Gone', '/films/gone.mov', ch, movies);
  db.prepare("INSERT INTO TranscodeItem (file_path, status) VALUES ('/films/gone.mov', 'missing')").run();

  const pool = moviePool({ id: 0 }, { id: 0, target_date: '2031-03-17' }, 7200, ch, null);
  assert.deepEqual(pool.map((r) => r.name), ['Kept']);
});
