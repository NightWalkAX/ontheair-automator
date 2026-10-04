// Seasonal films: never outside their holiday, preferred inside it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-hol-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-holcfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const { router: holidays } = await import('../src/routes/holidays.js');
const { router: catalog } = await import('../src/routes/catalog.js');
const { moviePool, pickMovieRun, activeFranchise } = await import('../src/services/scheduling.js');
const { holidaysOn } = await import('../src/services/holidays.js');

let server, base;
async function j(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
before(async () => {
  initSchema();
  const app = express();
  app.use(express.json());
  app.use('/api/holidays', holidays);
  app.use('/api/catalog', catalog);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const movies = () => db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
let ch;
const film = (name, secs, subject = 'Films', chapter = 0) => db.prepare(`
  INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject, chapter)
  VALUES (?, ?, ?, 0, 1, ?, ?, ?, ?) RETURNING id`).get(name, `/films/${name}.mov`, secs, ch, movies(), subject, chapter).id;
const mark = (holidayId, ...ids) => j('POST', '/api/catalog/bulk', { op: 'set-holidays', ids, holiday_ids: [holidayId], mode: 'add' });
const xmas = () => db.prepare("SELECT id FROM Holiday WHERE name = 'Christmas'").get().id;

test('holidays are seeded, editable, and may wrap the new year', async () => {
  const list = (await j('GET', '/api/holidays')).data;
  assert.deepEqual(list.map((h) => h.name).sort(), ['Christmas', 'Halloween', "Valentine's Day"]);

  assert.equal((await j('POST', '/api/holidays', { name: 'Bad', start_md: '13-01', end_md: '01-01' })).status, 400);
  const ny = await j('POST', '/api/holidays', { name: 'New Year', start_md: '12-28', end_md: '01-03', color: '#123456' });
  assert.equal(ny.status, 201);
  assert.deepEqual(holidaysOn('2031-01-02').map((h) => h.name), ['New Year']);
  assert.deepEqual(holidaysOn('2031-12-29').map((h) => h.name).sort(), ['Christmas', 'New Year']);
  assert.deepEqual(holidaysOn('2031-06-01'), []);

  const off = await j('PUT', `/api/holidays/${ny.data.id}`, { active: false });
  assert.equal(off.data.active, 0);
  assert.deepEqual(holidaysOn('2031-01-02'), [], 'an inactive holiday covers nothing');
  assert.equal((await j('DELETE', `/api/holidays/${ny.data.id}`)).status, 200);
});

test('a marked film airs only in its season, and is preferred there', async () => {
  ch = db.prepare("INSERT INTO ChannelType (name, api_ip, api_port) VALUES ('Seasons', '127.0.0.1', 1) RETURNING id").get().id;
  const plain = film('Plain', 5400);
  const carol = film('Carol', 5000);
  assert.equal((await mark(xmas(), carol)).status, 200);

  const cat = (await j('GET', `/api/catalog?channel_id=${ch}`)).data;
  const row = cat.groups.flatMap((g) => g.shows).flatMap((s) => s.episodes).find((e) => e.id === carol);
  assert.deepEqual(row.holidays, [xmas()]);

  const tpl = { id: 0, is_movie_block: 1, movie_limit: 1 };
  const july = { id: 0, target_date: '2031-07-10' };
  const dec = { id: 0, target_date: '2031-12-20' };
  assert.deepEqual(moviePool(tpl, july, 7200, ch, null).map((r) => r.id), [plain], 'out of season: gone');
  const decPool = moviePool(tpl, dec, 7200, ch, null);
  assert.deepEqual(decPool.map((r) => r.id).sort(), [plain, carol].sort());

  // In season it leads, even though Plain fills the slot better.
  const run = pickMovieRun(tpl, dec, 7200, 0, ch);
  assert.deepEqual(run.map((r) => r.id), [carol]);

  // ...and the cooldown does not hold it back.
  db.prepare("INSERT INTO PlayHistory (channel_id, resource_id, played_at) VALUES (?, ?, '2031-12-18 20:00:00')").run(ch, carol);
  assert.ok(moviePool(tpl, dec, 7200, ch, null).some((r) => r.id === carol));
});

test('a holiday saga waits for its season', () => {
  const s1 = film('Elf_Saga_1', 5000, 'Elf Saga', 1);
  const s2 = film('Elf_Saga_2', 5000, 'Elf Saga', 2);
  db.prepare('INSERT INTO HolidayFile (file_path, holiday_id) SELECT file_path, ? FROM Resource WHERE id IN (?, ?)').run(xmas(), s1, s2);
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, play_order, cursor_chapter) VALUES (?, 'Elf Saga', ?, 1, 0, 2)")
    .run(ch, movies());
  assert.equal(activeFranchise(ch, ['Elf Saga'], { id: 0, target_date: '2031-07-10' }), null, 'not mid-run in July');
  assert.equal(activeFranchise(ch, ['Elf Saga'], { id: 0, target_date: '2031-12-10' }), 'Elf Saga');
});
