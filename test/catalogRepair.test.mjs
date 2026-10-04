// Catalogue path repair: clips catalogued at a path that no longer exists are
// found again by name + length; aliases of one physical file are folded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe'); // duration = last number in the name
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-repair-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-repaircfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const { planRepair, applyRepair } = await import('../src/services/catalogRepair.js');
initSchema();

test('the repair finds converted, moved and aliased clips and re-points the catalogue', async () => {
  const share = mkdtempSync(join(tmpdir(), 'otav-share-'));
  const shows = join(share, 'Broadcast', 'Local Shows');
  const movies = join(share, 'Broadcast', 'Movies');
  mkdirSync(join(shows, 'Agri talk new videos'), { recursive: true });
  mkdirSync(movies, { recursive: true });
  mkdirSync(join(share, 'Broadcast', 'Christmas'), { recursive: true });
  // 1. Converted by Air Spec into the renamed folder; the old .mp4 is gone.
  writeFileSync(join(shows, 'Agri talk new videos', 'HYDROPONICS_900.mov'), 'x');
  // 2. A film moved by hand out of the Movies root (not catalogued anywhere).
  //    (.mov: the fake ffprobe reads the last number in the name, and .mp4 has one.)
  writeFileSync(join(share, 'Broadcast', 'Christmas', 'Home_Alone_1_6000.mov'), 'x');
  // 3. One physical file reachable under two folder names (the SMB-mangled alias).
  writeFileSync(join(shows, 'Agri talk new videos', 'BUDDING_700.mov'), 'x');
  symlinkSync(join(shows, 'Agri talk new videos'), join(shows, 'ANWHU2~D'));

  const ch = db.prepare("INSERT INTO ChannelType (name) VALUES ('Repair') RETURNING id").get().id;
  const ch2 = db.prepare("INSERT INTO ChannelType (name) VALUES ('Repair 2') RETURNING id").get().id;
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, 1, ?)').run(ch, movies);
  const row = (c, path, dur, approved = 1) => db.prepare(`INSERT INTO Resource (name, file_path, duration, channel_id, approved)
    VALUES (?, ?, ?, ?, ?) RETURNING id`).get(path.split('/').pop(), path, dur, c, approved).id;

  const oldHydro = join(shows, 'ANWHU2~D', 'HYDROPONICS_900.mp4');
  const stale = row(ch, oldHydro, 901);
  const fresh = row(ch2, join(shows, 'Agri talk new videos', 'HYDROPONICS_900.mov'), 900, 0); // channel 2 already has it
  const stale2 = row(ch2, join(shows, 'Agri talk new videos ', 'HYDROPONICS_900.mp4'), 899); // and a spaced-folder copy
  const film = row(ch, join(movies, 'Home_Alone_1_6000.mov'), 6000);
  const aliasA = row(ch, join(shows, 'ANWHU2~D', 'BUDDING_700.mov'), 700);
  const aliasB = row(ch, join(shows, 'Agri talk new videos', 'BUDDING_700.mov'), 700);
  const gone = row(ch, join(movies, 'Nowhere_1234.mp4'), 1234);
  // A scheduled item and a seasonal mark on the stale paths must follow.
  const tpl = db.prepare("INSERT INTO BlockTemplate (channel_id, name, weekday, start_time, end_time) VALUES (?, 't', 'Mon', '08:00', '09:00') RETURNING id").get(ch2).id;
  const blk = db.prepare("INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status) VALUES (?, ?, '2031-01-06', 'draft') RETURNING id").get(tpl, ch2).id;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)').run(blk, stale2);
  const xmas = db.prepare("SELECT id FROM Holiday WHERE name = 'Christmas'").get().id;
  db.prepare('INSERT INTO HolidayFile (file_path, holiday_id) VALUES (?, ?)').run(join(movies, 'Home_Alone_1_6000.mov'), xmas);

  const shallow = await planRepair();
  assert.deepEqual(shallow.relocate.map((r) => r.from).sort(), [oldHydro, join(shows, 'Agri talk new videos ', 'HYDROPONICS_900.mp4')].sort());
  assert.ok(shallow.notFound.some((n) => n.file_path.endsWith('Home_Alone_1_6000.mov')), 'a hand-moved film needs the deep search');

  const r = await applyRepair({ deep: true });
  assert.ok(r.relocate.some((x) => x.from.endsWith('Home_Alone_1_6000.mov') && x.to.includes('/Christmas/')));
  assert.deepEqual(r.notFound.map((n) => n.file_path), [join(movies, 'Nowhere_1234.mp4')], 'only the truly gone clip is left');
  assert.equal(r.aliases.length, 1);
  assert.equal(r.aliases[0].to, join(shows, 'Agri talk new videos', 'BUDDING_700.mov'), 'the clean folder name wins');

  const path = (id) => db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(id)?.file_path;
  assert.equal(path(stale), join(shows, 'Agri talk new videos', 'HYDROPONICS_900.mov'), 're-pointed');
  assert.equal(path(stale2), undefined, 'merged into the row channel 2 already had');
  assert.equal(db.prepare('SELECT resource_id FROM ScheduleItem WHERE block_id = ?').get(blk).resource_id, fresh, 'the schedule follows');
  assert.equal(db.prepare('SELECT approved FROM Resource WHERE id = ?').get(fresh).approved, 1, 'approval survives the merge');
  assert.match(path(film), /Christmas\/Home_Alone_1_6000\.mov$/);
  assert.equal(db.prepare('SELECT file_path FROM HolidayFile WHERE holiday_id = ?').get(xmas).file_path, path(film), 'the seasonal mark follows');
  assert.equal(path(aliasA), undefined);
  assert.ok(path(aliasB));
  assert.ok(path(gone), 'an unmatched clip is never deleted');

  // Nothing left to do the second time.
  const again = await planRepair({ deep: true });
  assert.equal(again.relocate.length + again.aliases.length, 0);
});
