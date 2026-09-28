// Migration 006: episodes the old parser numbered by the LAST number in their
// name are re-ordered by their first one — without undoing an order someone chose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbDir = mkdtempSync(join(tmpdir(), 'otav-firstnum-'));
process.env.SCHEDULER_DB = join(dbDir, 'test.sqlite');

const { db, initSchema } = await import('../src/db.js');
const { plan } = await import('../src/migrations/006-first-number-order.js');

initSchema();

const stId = (code) => db.prepare('SELECT id FROM ShowType WHERE code = ?').get(code).id;
const ch = db.prepare("INSERT INTO ChannelType (name, api_ip, api_port) VALUES ('First', '127.0.0.1', 1) RETURNING id").get().id;
const add = (subject, name, chapter, type = 'tv_shows') => db.prepare(`
  INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, subject, chapter, show_type_id)
  VALUES (?, ?, 600, 0, 1, ?, ?, ?, ?) RETURNING id`).get(name, `/m/${subject}/${name}.mov`, ch, subject, chapter, stId(type)).id;
const chapterOf = (id) => db.prepare('SELECT chapter FROM Resource WHERE id = ?').get(id).chapter;
const order = (subject) => db.prepare('SELECT name FROM Resource WHERE channel_id = ? AND subject = ? ORDER BY chapter, id')
  .all(ch, subject).map((r) => r.name);
const apply = (p) => { for (const op of p.ops) db.prepare(op.sql).run(...op.params); };

// 1. Untouched since the scan: chapters are the LAST number, as the old rule wrote.
const d1 = add('Human', 'Human_The_World_Within_01_D1', 1);
const d3 = add('Human', 'Human_The_World_Within_03_D11', 11);
const d2 = add('Human', 'Human_The_World_Within_02_D2', 2);
db.prepare("INSERT INTO ChannelSeries (channel_id, subject, is_serial, cursor_chapter) VALUES (?, 'Human', 1, 11)").run(ch);

// 2. Renumbered by NAME since (what the cleanup scripts did): 09, 100, 10, 11.
add('Octo', 'Octonauts_09_The_Remipedes', 1);
add('Octo', 'Octonauts_100_Tree_Lobsters_101_Convict_Fish', 2);
add('Octo', 'Octonauts_10_The_Speedy_Sailfish', 3);
add('Octo', 'Octonauts_11_The_Blobfish_Brothers', 4);
add('Octo', 'Octonauts_Special_The_Great_Swamp_Search', 5); // no number: keeps its slot

// 3. Mostly without numbers: an order chosen some other way, left alone.
const g = [
  add('Grade 5 Mathematics', 'Grade 5- Mathematics- Money', 1, 'lessons'),
  add('Grade 5 Mathematics', 'Grade 5- Mathematics- 10, 11 and 12 Times Table', 2, 'lessons'),
  add('Grade 5 Mathematics', 'Grade 5- Mathematics- Fractions In Words', 3, 'lessons'),
  add('Grade 5 Mathematics', 'Grade 5- Mathematics- 2 & 3 Times Tables', 4, 'lessons'),
];

// Movies are out of scope: a franchise part's chapter is its part.
const film = add('Movies', 'Toy_Story_3_2010', 3, 'movies');

test('re-orders a scanned season by its first number, and the cursor follows its clip', () => {
  const p = plan();
  apply(p);
  assert.deepEqual([chapterOf(d1), chapterOf(d2), chapterOf(d3)], [1, 2, 3]);
  assert.equal(db.prepare("SELECT cursor_chapter FROM ChannelSeries WHERE subject = 'Human'").get().cursor_chapter, 3,
    'the episode that was due next is still the one due next');
  assert.ok(p.summary.some((l) => /Human: 1 of 3/.test(l)), p.summary.join('\n'));
});

test('re-deals a name-sorted season among the chapters it already holds', () => {
  assert.deepEqual(order('Octo'), [
    'Octonauts_09_The_Remipedes',
    'Octonauts_10_The_Speedy_Sailfish',
    'Octonauts_11_The_Blobfish_Brothers',
    'Octonauts_100_Tree_Lobsters_101_Convict_Fish',
    'Octonauts_Special_The_Great_Swamp_Search',
  ]);
  const chapters = db.prepare("SELECT chapter FROM Resource WHERE subject = 'Octo' ORDER BY chapter").all().map((r) => r.chapter);
  assert.deepEqual(chapters, [1, 2, 3, 4, 5], 'no chapter outside the season is used');
});

test('leaves a season mostly without numbers, and movies, alone', () => {
  assert.deepEqual(g.map(chapterOf), [1, 2, 3, 4]);
  assert.equal(chapterOf(film), 3);
});

test('a second plan has nothing left to do', () => {
  assert.equal(plan().ops.length, 0);
});
