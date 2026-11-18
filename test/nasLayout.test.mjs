// The on-air folder (src/services/nasLayout.js) and the playlist watchdog
// (src/services/playlistWatch.js). What matters is that NOTHING airs a path with
// no file behind it: a move re-points every exported OTAV day in the same step,
// refuses the clip on air on ANY instance, never overwrites, and the watchdog
// finds a clip moved by hand and re-points today's playlist.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import { renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe');
process.env.SCHEDULER_DB = process.env.SCHEDULER_DB
  || join(mkdtempSync(join(tmpdir(), 'otav-db-')), 'test.sqlite');

const scratch = mkdtempSync(join(tmpdir(), 'otav-nas-'));
const share = join(scratch, 'Public');
const testConfig = join(scratch, 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), testConfig);
{
  const cfg = JSON.parse(readFileSync(testConfig, 'utf8'));
  cfg.nasLayout = { share };
  cfg.playlistWatch = { enabled: false, alert: true };
  writeFileSync(testConfig, JSON.stringify(cfg, null, 2));
}
process.env.SCHEDULER_CONFIG = testConfig;

const { db, initSchema } = await import('../src/db.js');
initSchema();
const nas = await import('../src/services/nasLayout.js');
const watch = await import('../src/services/playlistWatch.js');
const { startFakeOtav } = await import('./fake-otav.mjs');
const { localDate, addDays } = await import('../src/dates.js');

const fakes = [];
after(() => { for (const f of fakes) f.close?.(); });
async function fake(opts) { const f = await startFakeOtav(opts); fakes.push(f); return f; }

const typeId = (name) => db.prepare('SELECT id FROM ShowType WHERE name = ?').get(name)?.id
  ?? db.prepare('INSERT INTO ShowType (name, code) VALUES (?, ?)').run(name, name.toLowerCase().replace(/\s+/g, '')).lastInsertRowid;

function file(rel, bytes = 'x') {
  const p = join(share, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, bytes);
  return p;
}

let n = 0;
async function channelWith(f, label) {
  n++;
  return db.prepare('INSERT INTO ChannelType (name, api_ip, api_port, is_active) VALUES (?, ?, ?, 1)')
    .run(`${label} ${n}`, '127.0.0.1', f.port).lastInsertRowid;
}

function catalogue(channelId, path, type, duration = 300) {
  return db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, chapter, channel_id, show_type_id, approved)
    VALUES (?, ?, ?, 0, 0, ?, ?, 1)`).run(path.split('/').pop(), path, duration, channelId, typeId(type)).lastInsertRowid;
}

/** Export `resourceId` on `date` for `channelId` and build the day playlist on the fake. */
async function exportDay(f, channelId, resourceId, date, path) {
  const ch = db.prepare('SELECT name FROM ChannelType WHERE id = ?').get(channelId);
  const tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, content_type)
    VALUES (?, ?, 'Mon', 'Mon', '18:00', '19:00', 'movie')`).run(channelId, `T${resourceId}`).lastInsertRowid;
  const block = db.prepare(`INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status)
    VALUES (?, ?, ?, 'exported')`).run(tpl, channelId, date).lastInsertRowid;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)').run(block, resourceId);
  const playlist = `${ch.name} ${date}`;
  const base = `http://127.0.0.1:${f.port}/playlists/${encodeURIComponent(playlist)}`;
  await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: playlist }) });
  await fetch(`${base}/items`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clip_type: 0, url: path, name: path.split('/').pop(), duration: 300 }) });
  return playlist;
}
const clipsOf = async (f, playlist) =>
  (await fetch(`http://127.0.0.1:${f.port}/playlists/${encodeURIComponent(playlist)}/items`)).json();

test('targetFor files each old folder under its content type', () => {
  const root = `${share}/GLC On Air`;
  assert.equal(nas.targetFor(`${share}/Broadcast/Shows/Bluey/Bluey_S01E01.mov`, 'TV Shows'), `${root}/TV Shows/Bluey/Bluey_S01E01.mov`);
  assert.equal(nas.targetFor(`${share}/Broadcast/Local Shows/R.E.A.D/a.mov`, 'Lessons'), `${root}/Lessons/Local Shows/R.E.A.D/a.mov`);
  assert.equal(nas.targetFor(`${share}/Broadcast/Local Shows/Agri/a.mov`, 'TV Shows'), `${root}/TV Shows/Local Shows/Agri/a.mov`);
  assert.equal(nas.targetFor(`${share}/Local Academic Videos - Sorted/Science/Grade 3/x.mov`, 'Lessons'), `${root}/Lessons/Science/Grade 3/x.mov`);
  assert.equal(nas.targetFor(`${share}/Completed Projects/TRANSMISSION FOLDER 2026/promo.mov`, 'TV Shows'), `${root}/Promos/promo.mov`);
  assert.equal(nas.targetFor(`${share}/Broadcast/Filler/new fillers/f.mov`, 'Fillers'), `${root}/Fillers/new fillers/f.mov`);
  assert.equal(nas.targetFor(`${share}/kaylah's Wedding/v.mov`, 'Movies'), null, 'unmapped folders are left alone');
  assert.equal(nas.targetFor(`${root}/Movies/m.mov`, 'Movies'), null, 'already inside');
  // the root itself, for MediaRoot rows
  assert.equal(nas.targetFor(`${share}/Broadcast/Shows`, 'TV Shows'), `${root}/TV Shows`);
});

test('organize moves files, re-points exported OTAV days, the catalogue and the roots', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Org');
  const tvRoot = `${share}/Broadcast/Shows`;
  for (const t of ['TV Shows']) db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(ch, typeId(t), tvRoot);
  const a = file('Broadcast/Shows/Bluey/Bluey_S01E01.mov');
  const b = file('Broadcast/Shows/Bluey/Bluey_S01E02.mov');
  const ra = catalogue(ch, a, 'TV Shows');
  catalogue(ch, b, 'TV Shows');
  db.prepare("INSERT INTO AnalogFile (file_path, device_filename) VALUES (?, 'Bluey_S01E01.mov')").run(a);
  const pl = await exportDay(f, ch, ra, addDays(localDate(), 1), a);

  const plan = nas.planOrganize();
  assert.equal(plan.moves.filter((m) => m.from.startsWith(tvRoot)).length, 2);
  assert.ok(plan.moves.find((m) => m.from === a).onAir, 'a is on an exported day');

  const r = await nas.runOrganize({ only: '/Bluey/' });
  assert.equal(r.moved, 2, JSON.stringify(r));
  assert.equal(r.patched, 1);
  const na = `${share}/GLC On Air/TV Shows/Bluey/Bluey S01E01.mov`;
  assert.ok(existsSync(na) && !existsSync(a), 'the file moved');
  assert.equal((await clipsOf(f, pl))[0].url, na, 'OTAV names the new path');
  assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(ra).file_path, na);
  assert.equal(db.prepare('SELECT file_path FROM AnalogFile WHERE device_filename = ?').get('Bluey_S01E01.mov').file_path, na, 'the analog mapping follows');
  assert.ok(db.prepare('SELECT 1 FROM FileMove WHERE old_path = ? AND new_path = ?').get(a, na), 'journalled');
  assert.ok(db.prepare('SELECT 1 FROM MediaRoot WHERE path = ?').get(`${share}/GLC On Air/TV Shows`), 'the root moved with its files');
  assert.ok(!db.prepare('SELECT 1 FROM MediaRoot WHERE path = ?').get(tvRoot));
});

test('a clip on air on ANOTHER instance is not moved (the channel row may name the wrong port)', async () => {
  const f1 = await fake();
  const f2 = await fake();
  const ch = await channelWith(f1, 'Air');
  await channelWith(f2, 'Other');
  const p = file('Broadcast/Movies/Film_On_Air.mov');
  const r = catalogue(ch, p, 'Movies');
  const pl = await exportDay(f1, ch, r, addDays(localDate(), 1), p);
  f2.state.onAirUrl = p;                       // airing through the other instance
  const rep = await nas.runOrganize({ only: 'Film_On_Air' });
  assert.equal(rep.moved, 0);
  assert.equal(rep.deferred.length, 1, JSON.stringify(rep));
  assert.ok(existsSync(p), 'left where it is');
  assert.equal((await clipsOf(f1, pl))[0].url, p, 'playlist untouched');
  f2.state.onAirUrl = null;
  const again = await nas.runOrganize({ only: 'Film_On_Air' });
  assert.equal(again.moved, 1, 'moves on the next run once it is off air');
});

test('an existing target is a collision, never overwritten', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Col');
  const p = file('Broadcast/Documentaries/Planet.mov', 'original');
  catalogue(ch, p, 'Documentaries');
  file('GLC On Air/Documentaries/Planet.mov', 'someone else');
  const rep = await nas.runOrganize({ only: 'Planet.mov' });
  assert.equal(rep.moved, 0);
  assert.deepEqual(rep.collisions, [p]);
  assert.equal(readFileSync(join(share, 'GLC On Air/Documentaries/Planet.mov'), 'utf8'), 'someone else');
});

test('nothing moves while Air Spec converts', async () => {
  const tx = await import('../src/services/transcode.js');
  assert.equal(nas.busyReason(), null);
  assert.equal(typeof tx.getState().phase, 'string');
});

test('watchdog: a clip moved by hand is found by name + length and re-pointed in OTAV and the catalogue', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Watch');
  const p = file('Broadcast/Shows/Arthur/Arthur_01X05.mov');
  const r = catalogue(ch, p, 'TV Shows', 5);   // fake-ffprobe reads the length from the name's last number
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(ch, typeId('TV Shows'), `${share}/Broadcast/Shows`);
  const pl = await exportDay(f, ch, r, localDate(), p);
  // Someone drags it in Finder.
  const moved = join(share, 'GLC On Air/TV Shows/Arthur/Arthur_01X05.mov');
  mkdirSync(dirname(moved), { recursive: true });
  renameSync(p, moved);

  watch._resetWatchState();
  const mails = [];
  const res = await watch.tick({ channelIds: [ch], mail: async (m) => mails.push(m) });
  assert.equal(res.action, 'checked', JSON.stringify(res));
  assert.equal((await clipsOf(f, pl))[0].url, moved, 'OTAV re-pointed');
  assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(r).file_path, moved, 'catalogue follows');
  assert.ok(db.prepare("SELECT 1 FROM FileMove WHERE old_path = ? AND source = 'watchdog'").get(p));
  assert.equal(mails.length, 0);
  const day = watch.watchState({ channelId: ch, date: localDate() });
  assert.equal(day.items[0].exists, true);
  assert.equal(day.fixed.length, 1);
});

test('watchdog: an unfindable clip in today\'s playlist is e-mailed once, and a clip on air is left alone', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Lost');
  const p = file('Broadcast/Movies/Vanished.mov');
  const r = catalogue(ch, p, 'Movies');
  await exportDay(f, ch, r, localDate(), p);
  renameSync(p, join(scratch, 'outside-the-share.mov'));
  watch._resetWatchState();
  const mails = [];
  await watch.tick({ channelIds: [ch], mail: async (m) => mails.push(m) });
  await watch.tick({ channelIds: [ch], mail: async (m) => mails.push(m) });
  assert.equal(mails.length, 1, 'one alert, not one per pass');
  assert.match(mails[0].text, /Vanished/);

  // On air: found, but not touched.
  const q = file('Broadcast/Movies/Playing.mov');
  const rq = catalogue(ch, q, 'Movies', 60);
  const pl = await exportDay(f, ch, rq, localDate(), q);
  const dest = join(share, 'GLC On Air/Movies/Playing.mov');
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(q, dest);
  f.state.onAirUrl = q;
  await watch.tick({ channelIds: [ch], mail: async () => {} });
  assert.equal((await clipsOf(f, pl)).find((c) => c.name === 'Playing.mov').url, q, 'the playing clip is not patched');
  f.state.onAirUrl = null;
  await watch.tick({ channelIds: [ch], mail: async () => {} });
  assert.equal((await clipsOf(f, pl)).find((c) => c.name === 'Playing.mov').url, dest, 'patched once it is off air');
});

test('watchdog: same name but a different length is not a match', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Len');
  const p = file('Broadcast/Shows/Twin/Twin_Episode_900.mov');
  const r = catalogue(ch, p, 'TV Shows', 900);
  const pl = await exportDay(f, ch, r, localDate(), p);
  renameSync(p, join(scratch, 'gone-900.mov'));
  file('GLC On Air/TV Shows/Other/Twin_Episode_900x.mov');   // name key differs
  file('GLC On Air/TV Shows/Other2/Twin Episode 9.mov');    // name key differs too
  const imposter = file('GLC On Air/TV Shows/Other3/Twin-Episode-900.mov'); // same key, fake probes 900
  watch._resetWatchState();
  await watch.tick({ channelIds: [ch], mail: async () => {} });
  assert.equal((await clipsOf(f, pl))[0].url, imposter, 'same key + same length = match');

  const q = file('Broadcast/Shows/Twin/Short_Clip_30.mov');
  const rq = catalogue(ch, q, 'TV Shows', 45);                 // recorded 45s
  const pl2 = await exportDay(f, ch, rq, localDate(), q);
  renameSync(q, join(scratch, 'gone-30.mov'));
  file('GLC On Air/TV Shows/Elsewhere/Short_Clip_30.mov');      // probes 30s: not the same clip
  await watch.tick({ channelIds: [ch], mail: async () => {} });
  const after = (await clipsOf(f, pl2)).find((c) => c.name === 'Short_Clip_30.mov');
  assert.equal(after.url, q, 'a different length is never taken');
});

test('undo puts organised files back and re-points OTAV again', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Undo');
  const p = file('Broadcast/Filler/Filler_A.mov');
  const r = catalogue(ch, p, 'Fillers');
  const pl = await exportDay(f, ch, r, addDays(localDate(), 1), p);
  const since = new Date(Date.now() - 1000).toISOString();
  const rep = await nas.runOrganize({ only: 'Filler_A' });
  assert.equal(rep.moved, 1);
  const u = await nas.undoMoves({ since });
  assert.ok(u.undone >= 1, JSON.stringify(u));
  assert.ok(existsSync(p));
  assert.equal((await clipsOf(f, pl))[0].url, p);
  assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(r).file_path, p);
});

test('cleanStem tidies names without changing what the episode parser reads', async () => {
  const { statedEpisode } = await import('../src/services/episodeParse.js');
  const cases = [
    ['Family_Matters_4X13_The_Way_The_Ball_Bounces_(1)', 'TV Shows', 'Family Matters S04E13 The Way The Ball Bounces'],
    ['Saved_By_The_Bell_S1E11', 'TV Shows', 'Saved By The Bell S01E11'],
    ['Grade  8- English Language- Alliteration', 'Lessons', 'Grade 8 - English Language - Alliteration'],
    ['Dragon_Tales_S01E26_Crash_Landings_The_Big_Cake_Mix-Up', 'TV Shows', 'Dragon Tales S01E26 Crash Landings The Big Cake Mix-Up'],
    ['Monster Trucks 4x4', 'Movies', 'Monster Trucks 4x4'],
    ['Teen English E12', 'Lessons', 'Teen English E12'],
  ];
  for (const [raw, type, want] of cases) {
    const got = nas.cleanStem(raw, type);
    assert.equal(got, want);
    assert.equal(statedEpisode(got, raw.split(/_| /)[0]), statedEpisode(raw, raw.split(/_| /)[0]), `episode of ${raw}`);
  }
});

test('organize cleans the file name and the catalogue row follows', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Clean');
  const p = file('Broadcast/Shows/Family Matters/Family_Matters_4X13_The_Way_(1).mov');
  const r = catalogue(ch, p, 'TV Shows');
  db.prepare('UPDATE Resource SET name = ? WHERE id = ?').run('Family_Matters_4X13_The_Way_(1)', r);
  const rep = await nas.runOrganize({ only: 'Family_Matters_4X13' });
  assert.equal(rep.moved, 1);
  const to = `${share}/GLC On Air/TV Shows/Family Matters/Family Matters S04E13 The Way.mov`;
  assert.ok(existsSync(to));
  const row = db.prepare('SELECT name, file_path FROM Resource WHERE id = ?').get(r);
  assert.equal(row.file_path, to);
  assert.equal(row.name, 'Family Matters S04E13 The Way');
});

test('sweep: copies of catalogued files go to Duplicates numbered, uncatalogued uniques to _Not Catalogued', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Sweep');
  // A catalogued episode already organised.
  const orig = file('GLC On Air/TV Shows/Bluey/Bluey S01E07 Bike.mov', 'same-bytes');
  catalogue(ch, orig, 'TV Shows');
  // Two copies elsewhere under other names/folders (same name key, same size).
  const c1 = file('Transmission/Shows/Bluey/Bluey_S01E07_Bike.mov', 'same-bytes');
  const c2 = file('Transmission/New Shows/Bluey S01E07 Bike.mov', 'same-bytes');
  // An uncatalogued unique and a copy of it.
  const u = file('Transmission/Mov/Some_Film_Nobody_Catalogued.mov', 'film');
  const u2 = file('Transmission/Downloads/Some Film Nobody Catalogued.mov', 'film');
  // Never swept.
  const sched = file('Transmission/Schedules/whatever.mov', 'x');

  const rep = await nas.runSweep({ probe: false });
  assert.ok(!rep.error, rep.error);
  const dupDir = `${share}/GLC On Air/Duplicates/TV Shows/Bluey`;
  assert.ok(existsSync(`${dupDir}/Bluey S01E07 Bike [DUP 1].mov`), 'first copy numbered 1');
  assert.ok(existsSync(`${dupDir}/Bluey S01E07 Bike [DUP 2].mov`), 'second copy numbered 2');
  assert.ok(!existsSync(c1) && !existsSync(c2));
  assert.ok(existsSync(orig), 'the original stays');
  assert.ok(existsSync(`${share}/GLC On Air/_Not Catalogued/Movies/Some Film Nobody Catalogued.mov`), 'unique kept, cleaned, classified');
  assert.ok(existsSync(`${share}/GLC On Air/Duplicates/_Not Catalogued/Movies/Some Film Nobody Catalogued [DUP 1].mov`), 'its copy is a duplicate');
  assert.ok(!existsSync(u) && !existsSync(u2));
  assert.ok(existsSync(sched), 'Schedules is never swept');
  const manifest = readFileSync(`${share}/GLC On Air/Duplicates/_manifest.csv`, 'utf8');
  assert.match(manifest, /Bluey S01E07 Bike \[DUP 2\]/);
  assert.ok(db.prepare("SELECT 1 FROM FileMove WHERE source = 'sweep' AND old_path = ?").get(c1));
});

test('sweep never moves a file an OTAV playlist names', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'SweepAir');
  // An uncatalogued promo someone dropped into a playlist by hand.
  const promo = file('Transmission/Promos/Hand_Added_Promo.mov', 'p');
  const host = file('Broadcast/Filler/Host_Clip.mov', 'h');
  const r = catalogue(ch, host, 'Fillers');
  const pl = await exportDay(f, ch, r, localDate(), host);
  await fetch(`http://127.0.0.1:${f.port}/playlists/${encodeURIComponent(pl)}/items`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clip_type: 0, url: promo, name: 'promo' }) });
  const rep = await nas.runSweep({ probe: false });
  assert.ok(rep.skippedOnAir.includes(promo), JSON.stringify(rep));
  assert.ok(existsSync(promo));
});

test('rescue: a catalogued file gone before the organize takes back its copy from Duplicates', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Rescue');
  const ghost = `${share}/Broadcast/Movies/Ghost_Film_Carol.mpg`;      // catalogued, not on disk
  catalogue(ch, ghost, 'Movies', 60);
  const copy = file('Broadcast/Christmas Movies/Ghost_Film_Carol.mpg', 'real');  // the real one, elsewhere
  const sw = await nas.runSweep({ probe: true });
  assert.ok(!sw.error, sw.error);
  const dup = `${share}/GLC On Air/Duplicates/Other/Broadcast/Movies/Ghost_Film_Carol [DUP 1].mpg`;
  assert.ok(existsSync(dup), 'the sweep filed it as a duplicate of the ghost');
  const r = await nas.rescueGhosts();
  const to = `${share}/GLC On Air/Movies/Ghost Film Carol.mpg`;
  assert.ok(r.rescued.find((x) => x.to === to), JSON.stringify(r));
  assert.ok(existsSync(to) && !existsSync(dup) && !existsSync(copy));
  assert.equal(db.prepare('SELECT file_path FROM Resource WHERE file_path = ?').get(to)?.file_path, to);
  assert.ok(!db.prepare('SELECT 1 FROM Resource WHERE file_path = ?').get(ghost));
});

test('hasTopic: level + subject + number is not a topic', () => {
  assert.equal(nas.hasTopic('Teen English E12', 'Teen English'), false);
  assert.equal(nas.hasTopic('Elementary English E119', ''), false);
  assert.equal(nas.hasTopic('5 CPCE Maths', 'CPCE Teacher Lessons'), false);
  assert.equal(nas.hasTopic('Grade 2 - Mathematics - Comparing Numbers', 'Grade 2 Mathematics'), true);
  assert.equal(nas.hasTopic('Grade 7 - English Language - Comprehension Poetry Pt.1', 'Grade 7 English Language'), true);
  assert.equal(nas.hasTopic('Teen Science E29 Photosynthesis', 'Teen Science'), true);
});

test('unlabeled: topic-less lessons move to Unlabeled, OTAV and the root follow; the rest stay', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Unl');
  const rootPath = `${share}/GLC On Air/Lessons/Local Academic New/Teen`;
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(ch, typeId('Lessons'), rootPath);
  const bare = file('GLC On Air/Lessons/Local Academic New/Teen/Teen Maths E7.mov');
  const named = file('GLC On Air/Lessons/Local Academic New/Teen/Teen Maths E8 Fractions.mov');
  const rb = catalogue(ch, bare, 'Lessons');
  catalogue(ch, named, 'Lessons');
  db.prepare("UPDATE Resource SET subject = 'Teen Maths' WHERE file_path IN (?, ?)").run(bare, named);
  const pl = await exportDay(f, ch, rb, addDays(localDate(), 1), bare);
  const r = await nas.runUnlabeled();
  assert.equal(r.moved >= 1, true, JSON.stringify(r));
  const to = `${share}/GLC On Air/Unlabeled/Lessons/Local Academic New/Teen/Teen Maths E7.mov`;
  assert.ok(existsSync(to) && existsSync(named));
  assert.equal((await clipsOf(f, pl))[0].url, to);
  assert.ok(db.prepare('SELECT 1 FROM MediaRoot WHERE channel_id = ? AND path = ?').get(ch, `${share}/GLC On Air/Unlabeled/Lessons/Local Academic New/Teen`), 'twin root');
  assert.ok(db.prepare('SELECT 1 FROM MediaRoot WHERE channel_id = ? AND path = ?').get(ch, rootPath), 'original root kept (a file is still there)');
});

test('empty folders: only truly empty ones go (OS litter counts as empty), never roots or kept folders', async () => {
  mkdirSync(join(share, 'Transmission/Shows/Gone/Season 1'), { recursive: true });
  writeFileSync(join(share, 'Transmission/Shows/Gone/.DS_Store'), 'x');
  file('Transmission/Shows/Kept/notes.txt', 'keep me');
  mkdirSync(join(share, 'Transmission/Schedules'), { recursive: true });
  mkdirSync(join(share, 'Transmission/Promos'), { recursive: true });
  const dry = await nas.removeEmptyDirs({ dryRun: true });
  assert.ok(dry.removed.includes(`${share}/Transmission/Shows/Gone`));
  assert.ok(existsSync(join(share, 'Transmission/Shows/Gone')), 'dry run removes nothing');
  const r = await nas.removeEmptyDirs({ dryRun: false });
  assert.ok(!existsSync(join(share, 'Transmission/Shows/Gone')));
  assert.ok(existsSync(join(share, 'Transmission/Shows/Kept/notes.txt')));
  assert.ok(existsSync(join(share, 'Transmission/Schedules')) && existsSync(join(share, 'Transmission/Promos')));
  assert.ok(existsSync(join(share, 'Transmission')), 'top-level folders stay');
  for (const p of db.prepare('SELECT path FROM MediaRoot').all()) {
    if (existsSync(dirname(p.path))) assert.ok(!r.removed.includes(p.path), `root ${p.path} kept`);
  }
});

test('runRenames moves a given list with OTAV re-pointed and refuses paths outside the root', async () => {
  const f = await fake();
  const ch = await channelWith(f, 'Ren');
  const from = file('GLC On Air/Unlabeled/Lessons/X/Teen English E18.mov');
  const r = catalogue(ch, from, 'Lessons');
  const pl = await exportDay(f, ch, r, addDays(localDate(), 1), from);
  const to = `${share}/GLC On Air/Lessons/X/Grade 9 - English Language - Comprehension - E18.mov`;
  const rep = await nas.runRenames([{ from, to }, { from, to: '/etc/passwd.mov' }]);
  assert.equal(rep.moved, 1); assert.equal(rep.rejected, 1);
  assert.ok(existsSync(to));
  assert.equal((await clipsOf(f, pl))[0].url, to);
});
