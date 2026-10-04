// The analog channel's line-up migration and its Vol1 housekeeping: scan,
// classify, match to the share, archive (download + verify), clean up, and the
// week routine. Everything runs against test/fake-analog.mjs — never a device.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startFakeAnalog } from './fake-analog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'otav-vol1-'));
const archiveDir = join(work, 'Analog Archive');
process.env.SCHEDULER_DB = join(work, 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(work, 'config.json');
process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe'); // duration = last number in the name
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);
{
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.schedule = { ...(cfg.schedule || {}), extendIntoGaps: false };
  cfg.analog = { ...(cfg.analog || {}), archiveDir, minFreeGb: 1000, folderId: 5 };
  cfg.pathMap = {};
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));
}

const { db, initSchema, ensureAnalogChannel } = await import('../src/db.js');
const { router: analogRoutes } = await import('../src/routes/analog.js');
const vol1 = await import('../src/services/analogVol1.js');
const lineup = await import('../src/migrations/008-analog-lineup.js');
const { localDate, addDays } = await import('../src/dates.js');

let server, base, fake, analogId, glcId;
const tomorrow = addDays(localDate(), 1);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

async function j(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const until = async (fn) => { for (let i = 0; i < 300 && fn(); i++) await new Promise((r) => setTimeout(r, 20)); };
const shareFile = (rel, bytes = 2000) => {
  const p = join(work, 'share', rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, Buffer.alloc(bytes, 3));
  return p;
};

before(async () => {
  initSchema();
  analogId = ensureAnalogChannel();
  glcId = db.prepare("INSERT INTO ChannelType (name, is_active) VALUES ('Discover', 1) RETURNING id").get().id;
  const app = express();
  app.use(express.json());
  app.use('/api/analog', analogRoutes);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  if (fake) await new Promise((r) => fake.server.close(r));
});

test('classify: prefixes and filler folders keep, short lessons are programmes, long ones movies', () => {
  const c = (filename, length_s = null, folder_path = '', title = '') => vol1.classify({ filename, length_s, folder_path, title }).kind;
  assert.equal(c('PSA_GEA_EnergyLetsSaveIt.mp4', 173), 'filler');
  assert.equal(c('Infobits14_PainKillers.mpg', 102), 'filler');
  assert.equal(c('Anything.mpg', 900, 'Library/Promos'), 'filler');
  assert.equal(c('GMCS_Mangrove.mpg', 373), 'filler');
  assert.equal(c('Spot_Unknown.mpg', 200), 'filler', 'short, no episode marker');
  assert.equal(c('G2E_Letters_NCH.mpg', 353), 'program', 'a 6-minute lesson is not a filler');
  assert.equal(c('WildKratts_S1_E1.mpg', 1587), 'program');
  assert.equal(c('Movie_TheLorax.mpg', 5178), 'movie');
  assert.equal(c('5_Coriolanus.mpg', 8683), 'movie', 'long = movie');
  assert.equal(c('Unknown_NotInLibrary.mpg'), 'program', 'no length: kept as a programme (archived before any delete)');
  assert.match(vol1.archiveDirFor({ filename: 'G2E_Letters.mpg', kind: 'program', folder_path: 'Library/Grade 2' }), /\/Lessons\/Grade 2$/);
  assert.match(vol1.archiveDirFor({ filename: 'Arthur.mpg', kind: 'program', folder_path: 'Library/Cartoon' }), /\/Shows\/Cartoon$/);
  assert.match(vol1.archiveDirFor({ filename: 'PSA.mpg', kind: 'filler', folder_path: null }), /\/Fillers\/Unfiled$/);
});

test('migration 008: the analog channel gets the shared catalogue and its line-up, once', () => {
  const tv = db.prepare("SELECT id FROM ShowType WHERE code = 'tv_shows'").get().id;
  const mv = db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(glcId, tv, join(work, 'share', 'Shows'));
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)').run(glcId, mv, join(work, 'share', 'Movies'));
  const add = (name, rel, dur, subject, type, chapter = 0) => db.prepare(`
    INSERT INTO Resource (name, file_path, duration, subject, chapter, channel_id, show_type_id, approved)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(name, shareFile(rel), dur, subject, chapter, glcId, type);
  add('Arthur S01E01', 'Shows/Arthur/Arthur S01E01.mov', 1500, 'Arthur', tv, 1);
  add('Arthur S01E02', 'Shows/Arthur/Arthur S01E02.mov', 1510, 'Arthur', tv, 2);
  add('Up', 'Movies/Up_5400.mov', 5400, 'Movies', mv);
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, cursor_chapter) VALUES (?, 'Arthur', ?, 1, 2)").run(glcId, tv);

  const p = lineup.plan();
  for (const op of p.ops) db.prepare(op.sql).run(...op.params);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM MediaRoot WHERE channel_id = ?').get(analogId).n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM Resource WHERE channel_id = ? AND approved = 1').get(analogId).n, 3);
  const cs = db.prepare("SELECT * FROM ChannelSeries WHERE channel_id = ? AND subject = 'Arthur'").get(analogId);
  assert.equal(cs.is_serial, 1);
  assert.equal(cs.cursor_chapter, null, 'the analog channel starts every series at its first episode');

  // Only templates whose series exist here: the five movie blocks, and the two cartoon blocks that carry Arthur.
  const tpls = db.prepare('SELECT * FROM BlockTemplate WHERE channel_id = ? ORDER BY name').all(analogId);
  assert.deepEqual(tpls.filter((t) => !t.is_movie_block).map((t) => t.name).sort(),
    ['Analog Cartoons (Mon)', 'Analog Weekend Cartoons (Sat)']);
  assert.equal(tpls.filter((t) => t.is_movie_block).length, 5);
  const mon = tpls.find((t) => t.name === 'Analog Cartoons (Mon)');
  assert.deepEqual(db.prepare('SELECT start_time, end_time, slot_order FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order').all(mon.id)
    .map((s) => ({ ...s })), [{ start_time: '07:00', end_time: '08:00', slot_order: 0 }, { start_time: '18:00', end_time: '19:00', slot_order: 1 }]);
  assert.deepEqual(db.prepare('SELECT subject FROM BlockTemplateSeries WHERE template_id = ?').all(mon.id).map((r) => r.subject), ['Arthur']);
  assert.ok(p.summary.some((s) => /left out: .*Octonauts/.test(s)), p.summary.join('\n'));

  // The whole line-up covers every minute of the week exactly once.
  const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  for (const day of WD) {
    const cover = new Array(1440).fill(0);
    for (const t of lineup.LINEUP) {
      if (!t.weekdays.split(',').includes(day)) continue;
      for (const [s, e] of t.slots) for (let m = mins(s); m < (e === '23:59' ? 1440 : mins(e)); m++) cover[m]++;
    }
    assert.ok(cover.every((n) => n === 1), `${day}: ${cover.findIndex((n) => n !== 1)} min is covered ${cover.find((n) => n !== 1)} times`);
  }

  // Run again: everything is set up, nothing to do.
  assert.equal(lineup.plan().ops.length, 0);
});

test('Vol1: scan classifies and matches, archive copies + verifies + catalogues, clean-up deletes only what is safe', async () => {
  const sizes = { 'PSA_Spot_60.mpg': 3000, 'Movie_Lorax_5178.mpg': 9000, 'Arthur_S01E01.mov': 2000,
    'OldShow_Ep_1200.mpg': 7000, 'OnAirShow_Ep_1300.mpg': 5000, 'Mystery_1400.mpg': 4000 };
  fake = await startFakeAnalog({
    key: 'k',
    library: [
      { resource_id: 1, title: 'PSA_Spot', filename: 'PSA_Spot_60.mpg', length_s: 60, folder_path: 'Library/PSA' },
      { resource_id: 2, title: 'Movie: The Lorax', filename: 'Movie_Lorax_5178.mpg', length_s: 5178, folder_path: 'Library/Movies' },
      { resource_id: 3, title: 'Arthur', filename: 'Arthur_S01E01.mov', length_s: 1499, folder_path: 'Library/Cartoon' },
      { resource_id: 4, title: 'Old Show', filename: 'OldShow_Ep_1200.mpg', length_s: 1200, folder_path: 'Library/Cartoon' },
      { resource_id: 5, title: 'On air', filename: 'OnAirShow_Ep_1300.mpg', length_s: 1300, folder_path: 'Library/Cartoon' },
      { resource_id: 6, title: 'Mystery', filename: 'Mystery_1400.mpg', length_s: 1400, folder_path: 'Library/Misc' },
      { resource_id: 77, title: 'Program Guide', filename: 'TVBackground_1920.jpg', length_s: 60, type: 'program_guide' },
    ],
    disk: Object.keys(sizes),
    onAir: ['OnAirShow_Ep_1300.mpg'],
    contents: Object.fromEntries(Object.entries(sizes).map(([f, n]) => [f, Buffer.alloc(n, f.length)])),
    cutAfter: { 'OldShow_Ep_1200.mpg': 2500 },   // the first download dies part way: resumed with a Range
  });
  db.prepare('UPDATE ChannelType SET api_ip = ?, api_port = ?, api_key = ?, is_active = 1 WHERE id = ?')
    .run('127.0.0.1', fake.port, 'k', analogId);

  let r = await j('POST', '/api/analog/vol1/scan');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const rows = () => Object.fromEntries(db.prepare('SELECT * FROM AnalogDeviceFile').all().map((x) => [x.filename, x]));
  let by = rows();
  assert.equal(by['PSA_Spot_60.mpg'].kind, 'filler');
  assert.equal(by['Movie_Lorax_5178.mpg'].kind, 'movie');
  assert.equal(by['Arthur_S01E01.mov'].archive, 'matched', 'same name and length as the catalogue file');
  assert.match(by['Arthur_S01E01.mov'].share_path, /Arthur S01E01\.mov$/);
  assert.equal(db.prepare("SELECT file_path FROM AnalogFile WHERE device_filename = 'Arthur_S01E01.mov'").get().file_path,
    by['Arthur_S01E01.mov'].share_path, 'mapped: the analog channel plays it from Vol1 as it is');
  assert.equal(by['OldShow_Ep_1200.mpg'].archive, 'pending');

  // The operator files Mystery as a filler; a re-scan keeps it.
  assert.equal((await j('PUT', '/api/analog/vol1/kind', { filenames: ['Mystery_1400.mpg'], kind: 'filler' })).data.changed, 1);
  await j('POST', '/api/analog/vol1/scan');
  assert.equal(rows()['Mystery_1400.mpg'].kind, 'filler');

  // Nothing unarchived can be deleted, force or not.
  r = await j('GET', '/api/analog/vol1/cleanup');
  assert.deepEqual(r.data.plan.delete.map((d) => d.filename), ['Arthur_S01E01.mov']);
  assert.equal(r.data.plan.kept.notArchived, 2, 'Old Show and the on-air one are not on the share yet');
  assert.equal(r.data.plan.kept.onAir, 0);

  // Archive everything that isn't on the share.
  r = await j('POST', '/api/analog/vol1/archive');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await until(() => vol1.archiveStatus().running);
  const a = vol1.archiveStatus();
  assert.deepEqual(a.failed, []);
  assert.equal(a.archived.length, 5);
  by = rows();
  const copy = join(archiveDir, 'Shows', 'Cartoon', 'OldShow_Ep_1200.mpg');
  assert.equal(by['OldShow_Ep_1200.mpg'].archive, 'archived');
  assert.equal(by['OldShow_Ep_1200.mpg'].share_path, copy);
  assert.deepEqual(readFileSync(copy), fake.state.contents['OldShow_Ep_1200.mpg'], 'byte-identical after a resume');
  assert.ok(fake.state.downloads.some((d) => d.filename === 'OldShow_Ep_1200.mpg' && d.offset === 2500), 'resumed from the cut');
  assert.ok(!existsSync(`${copy}.part`));
  assert.ok(existsSync(join(archiveDir, 'Fillers', 'PSA', 'PSA_Spot_60.mpg')));
  assert.ok(existsSync(join(archiveDir, 'Movies', 'Movies', 'Movie_Lorax_5178.mpg')));
  // Catalogued for the analog channel, approved, fillers as fillers, and mapped to the device name.
  const res = db.prepare('SELECT * FROM Resource WHERE channel_id = ? AND file_path LIKE ?').all(analogId, `${archiveDir}/%`);
  assert.equal(res.length, 5);
  assert.ok(res.every((x) => x.approved === 1));
  assert.equal(res.find((x) => x.file_path.endsWith('PSA_Spot_60.mpg')).is_filler, 1);
  assert.equal(db.prepare('SELECT device_filename FROM AnalogFile WHERE file_path = ?').get(copy).device_filename, 'OldShow_Ep_1200.mpg');
  assert.ok(db.prepare('SELECT 1 FROM MediaRoot WHERE channel_id = ? AND path = ?').get(analogId, join(archiveDir, 'Fillers')));
  assert.ok(!db.prepare('SELECT 1 FROM MediaRoot WHERE channel_id = ? AND path = ?').get(glcId, join(archiveDir, 'Fillers')),
    'the archive is the analog channel\'s alone');

  // A copy that doesn't verify is not archived (and so never deleted).
  fake.state.disk.add('Bad_Length_99.mpg');
  fake.state.contents['Bad_Length_99.mpg'] = Buffer.alloc(100, 1);
  fake.state.device.push({ resource_id: 8, title: 'Bad', filename: 'Bad_Length_99.mpg', length_s: 1800, folder_path: 'Library/Cartoon', type: 'video' });
  await j('POST', '/api/analog/vol1/scan');
  await j('POST', '/api/analog/vol1/archive', { filenames: ['Bad_Length_99.mpg'] });
  await until(() => vol1.archiveStatus().running);
  assert.match(vol1.archiveStatus().failed[0].error, /runs 99s, the device measures 1800s/);
  assert.equal(rows()['Bad_Length_99.mpg'].archive, 'failed');

  // Clean-up: programmes that are safe and unused go; on air, fillers, movies and the failed one stay.
  r = await j('POST', '/api/analog/vol1/cleanup', { confirm: true });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.deleted.map((d) => d.filename).sort(), ['Arthur_S01E01.mov', 'OldShow_Ep_1200.mpg']);
  assert.equal(r.data.kept.onAir, 1);
  for (const f of ['PSA_Spot_60.mpg', 'Movie_Lorax_5178.mpg', 'Mystery_1400.mpg', 'OnAirShow_Ep_1300.mpg', 'Bad_Length_99.mpg']) {
    assert.ok(fake.state.disk.has(f), `${f} stays`);
  }
  assert.ok(fake.state.deleted.every((d) => !d.force), 'never forced');
  r = await j('POST', '/api/analog/storage/delete', { filenames: ['Bad_Length_99.mpg'], force: true });
  assert.equal(r.data.refused[0].unsafe, true);
  assert.ok(fake.state.disk.has('Bad_Length_99.mpg'));
});

test('week routine: copies what the approved days need inside the free-space margin, pushes, then deletes the old week', async () => {
  // A block tomorrow airing Arthur S01E02 (on the share only) and the archived Old Show (deleted from Vol1 above).
  const wd = WD[new Date(`${tomorrow}T00:00:00Z`).getUTCDay()];
  const t = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
    VALUES (?, 'Routine test', ?, ?, '06:00', '07:00') RETURNING id`).get(analogId, wd, wd).id;
  db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(t, analogId);
  const slot = db.prepare("INSERT INTO BlockTemplateSlot (template_id, start_time, end_time) VALUES (?, '06:00', '07:00') RETURNING id").get(t).id;
  const blk = db.prepare(`INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status)
    VALUES (?, ?, ?, ?, 'approved') RETURNING id`).get(t, slot, analogId, tomorrow).id;
  const rid = (like) => db.prepare('SELECT id FROM Resource WHERE channel_id = ? AND file_path LIKE ?').get(analogId, like).id;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0), (?, ?, 1)')
    .run(blk, rid('%Arthur S01E02.mov'), blk, rid('%OldShow_Ep_1200.mpg'));

  // 1000 GB margin on a 20 GB-free disk: refused before anything is copied.
  let r = await j('POST', '/api/analog/routine', { from: tomorrow, to: tomorrow });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await until(() => vol1.routineStatus().running);
  assert.match(vol1.routineStatus().error, /does not fit/);
  assert.equal(fake.state.uploads.length, 0);

  // The files panel says so too, and the upload button's route refuses before copying a byte.
  let f = await j('GET', `/api/analog/files?from=${tomorrow}&to=${tomorrow}`);
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.equal(f.data.space.toCopy, 2);
  assert.equal(f.data.space.fits, false);
  assert.ok(f.data.space.short > 0);
  assert.ok(f.data.files.every((x) => x.state !== 'missing' || x.size > 0), 'missing files carry their size');
  r = await j('POST', '/api/analog/upload', { from: tomorrow, to: tomorrow });
  assert.equal(r.status, 507);
  assert.match(r.data.error, /does not fit on Vol1/);
  assert.equal(fake.state.uploads.length, 0);

  assert.equal((await j('PUT', '/api/analog/settings', { minFreeGb: 1 })).status, 200);
  f = await j('GET', `/api/analog/files?from=${tomorrow}&to=${tomorrow}`);
  assert.equal(f.data.space.fits, true);
  fake.state.onAir.clear(); // the new week replaces the on-air one
  r = await j('POST', '/api/analog/routine', { from: tomorrow, to: tomorrow });
  await until(() => vol1.routineStatus().running);
  const s = vol1.routineStatus();
  assert.equal(s.error, null, s.log.join('\n'));
  assert.deepEqual(fake.state.uploads.map((u) => u.filename).sort(), ['Arthur_S01E02.mov', 'OldShow_Ep_1200.mpg'],
    'the archived file goes back under its own device name');
  assert.equal(s.push.days[0].result.ok, true, JSON.stringify(s.push));
  assert.equal(db.prepare('SELECT status FROM ScheduledBlock WHERE id = ?').get(blk).status, 'exported');
  // OnAirShow is no longer on air and nothing upcoming uses it: the second clean-up removes it.
  assert.ok(!fake.state.disk.has('OnAirShow_Ep_1300.mpg'), s.log.join('\n'));
  assert.ok(fake.state.disk.has('OldShow_Ep_1200.mpg'), 'what the new week airs stays');
  assert.ok(fake.state.disk.has('PSA_Spot_60.mpg') && fake.state.disk.has('Movie_Lorax_5178.mpg'));
});
