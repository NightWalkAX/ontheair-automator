// The startup data repairs: they must run once, record themselves, and never
// run again on that database.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A throwaway database of this test's own, set before db.js is imported.
const dbDir = mkdtempSync(join(tmpdir(), 'otav-migrate-'));
process.env.SCHEDULER_DB = join(dbDir, 'test.sqlite');

const { db, initSchema } = await import('../src/db.js');
const { runPendingMigrations, lockPath, MIGRATIONS } = await import('../src/migrations/index.js');

initSchema();

const stId = (code) => db.prepare('SELECT id FROM ShowType WHERE code = ?').get(code).id;

test('the repairs run once, fix the rows, and are recorded', () => {
  const ch = db.prepare(
    "INSERT INTO ChannelType (name, api_ip, api_port) VALUES ('Migrate', '127.0.0.1', 1) RETURNING id"
  ).get().id;
  // A TV Shows root with a Lessons root inside it — the real catalogue's shape.
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
    .run(ch, stId('tv_shows'), '/m/Local Shows');
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
    .run(ch, stId('lessons'), '/m/Local Shows/Math Intervention');

  // A lesson file mis-typed as TV Shows by the bugs this repairs...
  const lesson = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, subject, chapter, show_type_id)
    VALUES ('mi1', '/m/Local Shows/Math Intervention/mi1.mov', 600, 0, 1, ?, 'Math Intervention', 1, ?)
    RETURNING id`).get(ch, stId('tv_shows')).id;
  // ...a real programme that must NOT move...
  const show = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, subject, chapter, show_type_id)
    VALUES ('cho1', '/m/Local Shows/Cho/cho1.mov', 600, 0, 1, ?, 'Cho', 1, ?)
    RETURNING id`).get(ch, stId('tv_shows')).id;
  // ...an educational folder inside Local Shows with NO root of its own, which
  // 003 has to carve out and re-type (001 types it TV Shows first, from the
  // ancestor root, so this also pins the order the migrations run in)...
  const cpce = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, subject, chapter, show_type_id)
    VALUES ('cpce1', '/m/Local Shows/CPCE Teacher Lessons/c1.mov', 600, 0, 1, ?, 'CPCE Teacher Lessons', 1, ?)
    RETURNING id`).get(ch, stId('movies')).id;
  // ...a file under no root at all, which must be left alone.
  const orphanFile = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, subject, chapter, show_type_id)
    VALUES ('x', '/elsewhere/x.mov', 600, 0, 1, ?, 'X', 1, ?)
    RETURNING id`).get(ch, stId('movies')).id;

  db.prepare(`INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
              VALUES (?, 'Math Intervention', ?, 1, 1, 0), (?, 'Cho', ?, 0, 1, 1),
                     (?, 'New folder', ?, 0, 1, 2), (?, 'Planned', ?, 0, 1, 3),
                     (?, 'CPCE Teacher Lessons', ?, 1, 1, 4)`)
    .run(ch, stId('tv_shows'), ch, stId('tv_shows'), ch, stId('movies'), ch, stId('movies'),
         ch, stId('tv_shows'));
  // "Planned" has no clips either, but a template names it: it stays.
  const tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, start_time, end_time, content_type)
                          VALUES (?, 'T', 'Mon', '08:00', '09:00', 'movie') RETURNING id`).get(ch).id;
  db.prepare("INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, 'Planned', 0)").run(tpl);

  const ran = runPendingMigrations();
  assert.deepEqual(ran.map((r) => r.id), MIGRATIONS.map((m) => m.id), 'every repair ran');

  const typeOf = (id) => db.prepare('SELECT show_type_id FROM Resource WHERE id = ?').get(id).show_type_id;
  assert.equal(typeOf(lesson), stId('lessons'), 'the deeper root decided the lesson file');
  assert.equal(typeOf(show), stId('tv_shows'), 'the programme kept its type');
  assert.equal(typeOf(orphanFile), stId('movies'), 'a file under no root was left alone');
  assert.equal(
    db.prepare('SELECT show_type_id FROM ChannelSeries WHERE channel_id = ? AND subject = ?')
      .get(ch, 'Math Intervention').show_type_id,
    stId('lessons'),
    'the series agrees with its clips'
  );

  const subjects = db.prepare('SELECT subject FROM ChannelSeries WHERE channel_id = ? ORDER BY subject')
    .all(ch).map((r) => r.subject);
  assert.deepEqual(subjects, ['CPCE Teacher Lessons', 'Cho', 'Math Intervention', 'Planned'],
    'the dead series went, the one a template names stayed');

  // 003: the educational folder got a root of its own and its clips with it.
  assert.ok(
    db.prepare('SELECT 1 AS x FROM MediaRoot WHERE channel_id = ? AND show_type_id = ? AND path = ?')
      .get(ch, stId('lessons'), '/m/Local Shows/CPCE Teacher Lessons'),
    'a Lessons root was carved out of the TV Shows folder'
  );
  assert.equal(typeOf(cpce), stId('lessons'), 'and its clips are lessons now');
  assert.equal(
    db.prepare('SELECT show_type_id FROM ChannelSeries WHERE channel_id = ? AND subject = ?')
      .get(ch, 'CPCE Teacher Lessons').show_type_id,
    stId('lessons'),
    'series registry included'
  );
  // A folder on the list this installation has no clips under stays untouched:
  // a root with no catalogue behind it is a guess about somebody else's share.
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM MediaRoot WHERE path LIKE '%R.E.A.D'").get().n, 0,
    'no root invented for a folder with nothing in it'
  );

  // Recorded, with the lock beside the database.
  assert.ok(existsSync(lockPath()), 'the lock file was written');
  const lock = JSON.parse(readFileSync(lockPath(), 'utf8'));
  assert.deepEqual(lock.applied.map((a) => a.id), MIGRATIONS.map((m) => m.id));
  assert.ok(lock.applied.every((a) => a.at), 'each records when it ran');
});

test('a second startup runs nothing, even with rows that would qualify', () => {
  const ch = db.prepare('SELECT id FROM ChannelType LIMIT 1').get().id;
  // Exactly the shape the repairs look for — but they are already recorded.
  db.prepare(`INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
              VALUES (?, 'Another dead one', ?, 0, 1, 9)`).run(ch, stId('movies'));

  assert.deepEqual(runPendingMigrations(), [], 'nothing ran');
  assert.ok(
    db.prepare('SELECT 1 AS x FROM ChannelSeries WHERE subject = ?').get('Another dead one'),
    'and nothing was touched'
  );
});

test('an unreadable lock leaves everything pending rather than crashing', () => {
  writeFileSync(lockPath(), 'not json at all');
  const ran = runPendingMigrations();
  assert.deepEqual(ran.map((r) => r.id), MIGRATIONS.map((m) => m.id), 'they run again');
  assert.equal(
    db.prepare('SELECT COUNT(*) n FROM ChannelSeries WHERE subject = ?').get('Another dead one').n,
    0,
    'and do their work — re-running a repair is safe, that is why it is idempotent'
  );
});
