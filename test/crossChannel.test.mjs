// Rules across channels: a film airs on one channel within a day either side,
// a show airs on one channel at a time. The generator avoids both; validation
// reports what an edit left.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-cross-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-crosscfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);
{
  // One block a day per template: without this each would own the 22 hours to
  // the next day's and fill them with films.
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.schedule = { ...cfg.schedule, extendIntoGaps: false };
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));
}

const { db, initSchema } = await import('../src/db.js');
const { generateWeek } = await import('../src/services/scheduling.js');
const { validateBlock, blockProblem } = await import('../src/services/blockValidation.js');
const { crossConflictCounts, crossProblem } = await import('../src/services/crossChannel.js');

before(() => initSchema());

const WEEK = '2031-05-05'; // a Monday
const DAYS = 'Sun,Mon,Tue,Wed,Thu,Fri,Sat';
const dayNo = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
const typeId = (code) => db.prepare('SELECT id FROM ShowType WHERE code = ?').get(code).id;
const channel = (name) => db.prepare(
  "INSERT INTO ChannelType (name, api_ip, api_port) VALUES (?, '127.0.0.1', 1) RETURNING id",
).get(name).id;
const resource = (ch, { name, path, secs, type = null, subject = null, chapter = 0, filler = 0 }) => db.prepare(`
  INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject, chapter)
  VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?) RETURNING id`).get(name, path, secs, filler, ch, type, subject, chapter).id;
function fillers(ch) {
  for (const s of [30, 60, 120, 300, 600]) {
    for (let k = 0; k < 3; k++) resource(ch, { name: `F${s}-${k}`, path: `/f/${ch}/${s}-${k}.mov`, secs: s, filler: 1 });
  }
}
function template(name, channels, start, end, { movie = 0, limit = null, series = [] } = {}) {
  const tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, is_movie_block, movie_limit)
                          VALUES (?, ?, 'Mon', ?, ?, ?, ?, ?) RETURNING id`).get(channels[0], name, DAYS, start, end, movie, limit).id;
  db.prepare('INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (?, ?, ?, 0)').run(tpl, start, end);
  for (const c of channels) db.prepare('INSERT OR IGNORE INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(tpl, c);
  series.forEach((s, i) => db.prepare('INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, ?, ?)').run(tpl, s, i));
  return tpl;
}
const mains = (ch) => db.prepare(`
  SELECT sb.id AS block_id, sb.target_date, r.file_path, r.subject, r.id AS resource_id
  FROM ScheduleItem si JOIN ScheduledBlock sb ON sb.id = si.block_id JOIN Resource r ON r.id = si.resource_id
  WHERE sb.channel_id = ? AND r.is_filler = 0 ORDER BY sb.target_date, si.play_order`).all(ch);

let movA, movB, serA, serB;

test('a shared movie block airs a different film on each channel, never within a day of the other', () => {
  movA = channel('Movies A');
  movB = channel('Movies B');
  for (const ch of [movA, movB]) {
    fillers(ch);
    for (let i = 0; i < 20; i++) {
      resource(ch, { name: `Film ${i}`, path: `/films/film-${i}.mov`, secs: 5400 + i * 30, type: typeId('movies'), subject: 'Films' });
    }
  }
  template('Night Movies', [movA, movB], '20:00', '22:00', { movie: 1, limit: 1 });
  generateWeek(new Date(`${WEEK}T00:00:00`), [movA, movB]);

  const a = mains(movA), b = mains(movB);
  assert.equal(a.length, 7);
  assert.equal(b.length, 7);
  for (const x of a) {
    for (const y of b) {
      if (x.file_path !== y.file_path) continue;
      assert.ok(Math.abs(dayNo(x.target_date) - dayNo(y.target_date)) > 1,
        `${x.file_path} airs on A ${x.target_date} and on B ${y.target_date}`);
    }
  }
  assert.equal(crossConflictCounts(WEEK, '2031-05-11').size, 0, 'the week grid sees no clash');
});

test('a film moved next to its airing on another channel is red, and the line says where', () => {
  const day1 = mains(movA).find((x) => x.target_date === '2031-05-06');
  const bDay2 = mains(movB).find((x) => x.target_date === '2031-05-07');
  const bCopy = db.prepare('SELECT id FROM Resource WHERE channel_id = ? AND file_path = ?').get(movB, day1.file_path).id;
  db.prepare('UPDATE ScheduleItem SET resource_id = ? WHERE block_id = ? AND resource_id = ?').run(bCopy, bDay2.block_id, bDay2.resource_id);

  const v = validateBlock(bDay2.block_id);
  assert.equal(v.crossFits, false);
  assert.equal(v.fits, false);
  assert.equal(v.approvable, false);
  assert.equal(v.crossConflicts[0].kind, 'movie');
  // (Films differ in length, so the swap also breaks the fit — which is reported first.)
  assert.match(crossProblem(v.crossConflicts), /Movies A airs on 2031-05-06/);
  assert.ok(v.crossBusy.files[day1.file_path], 'the editor gets the busy set to judge edits live');
  // The verdict-only gate agrees.
  assert.equal(validateBlock(bDay2.block_id, { windows: new Map(), labels: false }).crossFits, false);
  // Both sides of the clash show on the week grid.
  const counts = crossConflictCounts(WEEK, '2031-05-11');
  assert.equal(counts.get(bDay2.block_id), 1);
  assert.equal(counts.get(day1.block_id), 1);
  // Put it back: the clash is gone.
  db.prepare('UPDATE ScheduleItem SET resource_id = ? WHERE block_id = ? AND resource_id = ?').run(bDay2.resource_id, bDay2.block_id, bCopy);
  assert.equal(crossConflictCounts(WEEK, '2031-05-11').size, 0);
});

test('a show another channel airs at the same time sits the block out', () => {
  serA = channel('Shows A');
  serB = channel('Shows B');
  const tv = typeId('tv_shows');
  for (const ch of [serA, serB]) {
    fillers(ch);
    for (const show of ['Cho', `Own ${ch}`]) {
      db.prepare('INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial) VALUES (?, ?, ?, 1)').run(ch, show, tv);
      for (let e = 1; e <= 12; e++) {
        resource(ch, { name: `${show} ${e}`, path: `/tv/${show}/${e}.mov`, secs: 1380, type: tv, subject: show, chapter: e });
      }
    }
  }
  template('Morning A', [serA], '08:00', '09:00', { series: ['Cho', `Own ${serA}`] });
  // Overlaps A's block by half an hour.
  template('Morning B', [serB], '08:30', '09:30', { series: ['Cho', `Own ${serB}`] });
  // Not overlapping: B may air Cho in the evening.
  template('Evening B', [serB], '18:00', '19:00', { series: ['Cho'] });
  generateWeek(new Date(`${WEEK}T00:00:00`), [serA, serB]);

  const a = mains(serA), b = mains(serB);
  assert.ok(a.some((x) => x.subject === 'Cho'), 'the channel generated first keeps the show');
  const morningB = db.prepare(`SELECT sb.id FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id
                               WHERE bt.name = 'Morning B'`).all().map((r) => r.id);
  const bMorning = b.filter((x) => morningB.includes(x.block_id));
  assert.ok(bMorning.length > 0);
  assert.ok(bMorning.every((x) => x.subject !== 'Cho'), 'B airs its own show in the overlapping block');
  assert.ok(b.some((x) => !morningB.includes(x.block_id) && x.subject === 'Cho'), 'and Cho in the evening');
  assert.equal(crossConflictCounts(WEEK, '2031-05-11').size, 0);

  // An edit that puts Cho back into the overlapping block is red.
  const blockId = bMorning[0].block_id;
  const cho = db.prepare("SELECT id FROM Resource WHERE channel_id = ? AND subject = 'Cho' AND chapter = 12").get(serB).id;
  db.prepare('UPDATE ScheduleItem SET resource_id = ? WHERE id = (SELECT id FROM ScheduleItem WHERE block_id = ? AND resource_id = ?)')
    .run(cho, blockId, bMorning[0].resource_id);
  const v = validateBlock(blockId);
  assert.equal(v.crossFits, false);
  assert.equal(v.crossConflicts[0].kind, 'series');
  assert.match(blockProblem(v), /"Cho" while Shows A airs it \(2031-05-\d\d 08:00–09:00\)/);
});

test('the rules can be turned off', () => {
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.schedule = { ...cfg.schedule, crossChannel: { movieDays: 0, series: false } };
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));
  assert.equal(crossConflictCounts(WEEK, '2031-05-11').size, 0);
});
