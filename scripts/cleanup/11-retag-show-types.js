#!/usr/bin/env node
// Phase 11 — re-tag every Resource with the show type of the media root it
// actually lives under.
//
// Symptom being repaired: a movie block airs two films and then starts playing
// lessons. The engine was right; the catalogue was not. On the production
// database, 971 rows per channel on two of the three channels carry
// show_type_id = Movies while their file_path sits under a Lessons root:
//
//   channel 1  /Volumes/Public/Local Academic Videos - Sorted/…  -> Lessons
//   channel 2  (the same files)                                  -> Movies
//   channel 3  (the same files)                                  -> Movies
//
// How they got there: cloneScannedResources() used to force the newly added
// root's show type onto EVERY file in its subtree, so a root added one level too
// high re-typed thousands of clips; and editing a root's type never re-tagged
// what it had already catalogued. Both are fixed in the app now — this script
// repairs the rows those bugs already wrote.
//
// The rule, identical to the one ingestion uses: the DEEPEST media root of the
// same channel that contains a file decides its show type. A file no root
// explains is reported and left alone (it may predate a root that was removed,
// and guessing would be worse than leaving it).
//
// ChannelSeries is repaired alongside, since a series registered under the wrong
// show type is the second way a lesson reaches a movie block.
//
// Nothing is deleted. Dry run unless --apply.
//
// Usage:
//   node scripts/cleanup/11-retag-show-types.js                 # report only
//   node scripts/cleanup/11-retag-show-types.js --channel 2     # one channel
//   node scripts/cleanup/11-retag-show-types.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy before the real file.

import { planner, q } from './lib.js';

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const onlyChannel = argOf('channel') ? Number(argOf('channel')) : null;

const types = new Map(q('SELECT id, name FROM ShowType').map((t) => [t.id, t.name]));
const typeName = (id) => types.get(id) ?? `#${id ?? 'null'}`;

// Roots per channel, deepest first — longest path wins, exactly as ingestion
// resolves it.
const rootsByChannel = new Map();
for (const r of q('SELECT channel_id, path, show_type_id FROM MediaRoot ORDER BY LENGTH(path) DESC')) {
  if (!rootsByChannel.has(r.channel_id)) rootsByChannel.set(r.channel_id, []);
  rootsByChannel.get(r.channel_id).push(r);
}
const rootFor = (channelId, filePath) =>
  (rootsByChannel.get(channelId) || []).find(
    (r) => filePath === r.path || filePath.startsWith(r.path + '/')
  ) || null;

const plan = planner('11-retag-show-types');

const where = onlyChannel ? 'WHERE channel_id = ?' : '';
const args = onlyChannel ? [onlyChannel] : [];
const rows = q(`SELECT id, channel_id, file_path, show_type_id, subject FROM Resource ${where}`, ...args);

const byChange = new Map(); // "ch|from|to" -> { n, sample }
let unrooted = 0;
const fixedSubjects = new Map(); // "ch|subject" -> show_type_id

for (const r of rows) {
  const root = rootFor(r.channel_id, r.file_path);
  if (!root) { unrooted++; continue; }
  if (root.show_type_id === r.show_type_id) continue;
  const key = `${r.channel_id}|${r.show_type_id}|${root.show_type_id}`;
  if (!byChange.has(key)) byChange.set(key, { n: 0, sample: r.file_path });
  byChange.get(key).n++;
  plan.op(
    'UPDATE Resource SET show_type_id = ? WHERE id = ?',
    [root.show_type_id, r.id],
    null // one line per row would be thousands; the summary below is the report
  );
  if (r.subject) fixedSubjects.set(`${r.channel_id}|${r.subject}`, root.show_type_id);
}

// A series must agree with its clips, or the engine's series-level guard still
// lets it into the wrong kind of block.
for (const [key, typeId] of fixedSubjects) {
  const [channelId, subject] = [Number(key.split('|')[0]), key.slice(key.indexOf('|') + 1)];
  const cs = q(
    'SELECT id, show_type_id FROM ChannelSeries WHERE channel_id = ? AND subject = ?',
    channelId, subject
  )[0];
  if (cs && cs.show_type_id !== typeId) {
    plan.op(
      'UPDATE ChannelSeries SET show_type_id = ? WHERE id = ?',
      [typeId, cs.id],
      `series "${subject}" (channel ${channelId}): ${typeName(cs.show_type_id)} -> ${typeName(typeId)}`
    );
  }
}

console.log('\nMis-typed resources, by channel and show type');
console.log('-'.repeat(60));
if (!byChange.size) console.log('  none — every catalogued file already matches its media root.');
for (const [key, v] of [...byChange.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const [ch, from, to] = key.split('|');
  console.log(`  channel ${ch}: ${typeName(Number(from))} -> ${typeName(Number(to))}  ${String(v.n).padStart(6)} rows`);
  console.log(`             e.g. ${v.sample}`);
}
if (unrooted) {
  plan.note(`${unrooted} resource(s) sit under no media root of their channel — left untouched`);
}

if (!plan.size) console.log('\nNothing to repair.');
plan.commit();
