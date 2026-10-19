// Clips that play badly: which clip a fault belongs to, the flag each file
// gets per kind of node, and what the scheduler and the UI do with it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-flt-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-fltcfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const pf = await import('../src/services/playbackFaults.js');
const { moviePool } = await import('../src/services/scheduling.js');
const { validateBlock } = await import('../src/services/blockValidation.js');
const { router: catalog } = await import('../src/routes/catalog.js');
const { router: faults } = await import('../src/routes/faults.js');
const { router: blocks } = await import('../src/routes/blocks.js');
const { startFakeOtav } = await import('./fake-otav.mjs');
const { startFakeAnalog } = await import('./fake-analog.mjs');
const { localDate, addDays } = await import('../src/dates.js');

let server, base;
async function j(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

let otavA, otavB, analog, movies;
before(async () => {
  initSchema();
  const app = express();
  app.use(express.json());
  app.use('/api/catalog', catalog);
  app.use('/api/faults', faults);
  app.use('/api/blocks', blocks);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
  const ch = (name, playout = 'otav') => db.prepare(
    "INSERT INTO ChannelType (name, api_ip, api_port, playout) VALUES (?, '127.0.0.1', 1, ?) RETURNING id").get(name, playout).id;
  otavA = ch('Discover');
  otavB = ch('Elevate');
  analog = ch('Analog', 'analog');
  movies = db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
});
after(() => new Promise((r) => server.close(r)));

const film = (channelId, name, secs = 5400) => db.prepare(`
  INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject, chapter)
  VALUES (?, ?, ?, 0, 1, ?, ?, 'Films', 0) RETURNING id`).get(name, `/Volumes/Public/Films/${name}.mov`, secs, channelId, movies).id;
const flag = (path, playout) => db.prepare('SELECT * FROM PlaybackFlag WHERE file_path = ? AND playout = ?').get(path, playout);

test('the walk back finds the clip that was playing when the picture went', () => {
  const now = 1_000_000_000;
  const items = [
    { url: 'file:///Volumes/Public/A%20one.mov', name: 'A', duration: 600 },
    { url: '/Volumes/Public/B.mov', name: 'B', duration: 300 },
    { url: '/Volumes/Public/C.mov', name: 'C', duration: 900 },
  ];
  const current = { path: '/Volumes/Public/C.mov', name: 'C', elapsed: 60, index: 2 };
  // 20s before C started → 280s into B.
  let hit = pf.walkBack(current, items, now - 80_000, now);
  assert.equal(hit.path, '/Volumes/Public/B.mov');
  assert.equal(Math.round(hit.offset), 280);
  assert.equal(hit.confidence, 'exact');
  // 5s before the change: it may be the clip next to it, and says so.
  assert.equal(pf.walkBack(current, items, now - 65_000, now, { boundarySeconds: 10 }).confidence, 'boundary');
  // Well inside A, escaped file:// URL and all.
  hit = pf.walkBack(current, items, now - (60 + 300 + 300) * 1000, now);
  assert.equal(hit.path, '/Volumes/Public/A one.mov');
  assert.equal(hit.confidence, 'exact');
  // Inside the clip on air.
  hit = pf.walkBack(current, items, now - 30_000, now);
  assert.equal(hit.path, '/Volumes/Public/C.mov');
  assert.equal(Math.round(hit.offset), 30);
  // No position from the node: the clip on air, saying so.
  assert.equal(pf.walkBack({ path: '/x.mov', elapsed: undefined }, null, now - 99_000, now).confidence, 'uncertain');
});

test('a fault makes a suspect; dismissed stays dismissed; clear takes the mark away', () => {
  const path = '/Volumes/Public/Films/Dark.mov';
  const at = new Date().toISOString();
  pf.recordFault({ filePath: path, playout: 'otav', channelId: otavA, source: 'monitor', kind: 'black', occurredAt: at });
  assert.equal(flag(path, 'otav').status, 'suspect');
  assert.equal(flag(path, 'otav').faults, 1);
  assert.equal(flag(path, 'analog'), undefined, 'the analog copy is another file');

  assert.equal(pf.recordFault({ filePath: path, playout: 'otav', source: 'asrun', kind: 'x', extKey: 'k1' }).ext_key, 'k1');
  assert.equal(pf.recordFault({ filePath: path, playout: 'otav', source: 'asrun', kind: 'x', extKey: 'k1' }), null, 'a log row read twice counts once');
  assert.equal(flag(path, 'otav').faults, 2);

  pf.setFlags([path], 'otav', 'dismissed');
  pf.recordFault({ filePath: path, playout: 'otav', channelId: otavB, source: 'monitor', kind: 'black' });
  assert.equal(flag(path, 'otav').status, 'dismissed', 'later faults are counted but do not re-open it');
  assert.equal(flag(path, 'otav').faults, 3);

  pf.setFlags([path], 'otav', 'clear');
  assert.equal(flag(path, 'otav'), undefined);
  pf.recordFault({ filePath: path, playout: 'otav', source: 'monitor', kind: 'frozen' });
  assert.equal(flag(path, 'otav').faults, 1, 'a new failure starts a new suspect; the old history does not count');
});

test('several channels failing at once is upstream, not a clip', () => {
  const at = Date.now() - 3_600_000;
  const iso = (dt) => new Date(at + dt).toISOString();
  const cfg = pf.faultsConfig({ correlatedFeeds: 3, correlatedWindowSeconds: 60 });
  pf.recordFault({ filePath: '/c/1.mov', playout: 'otav', channelId: otavA, source: 'monitor', kind: 'black', occurredAt: iso(0) });
  pf.recordFault({ filePath: '/c/2.mov', playout: 'otav', channelId: otavB, source: 'monitor', kind: 'black', occurredAt: iso(5_000) });
  assert.equal(pf.discardCorrelated(iso(5_000), cfg), 0, 'two channels can be two bad clips');
  pf.recordFault({ filePath: '/c/3.mov', playout: 'analog', channelId: analog, source: 'monitor', kind: 'black', occurredAt: iso(9_000) });
  assert.equal(pf.discardCorrelated(iso(9_000), cfg), 3);
  for (const [p, k] of [['/c/1.mov', 'otav'], ['/c/2.mov', 'otav'], ['/c/3.mov', 'analog']]) assert.equal(flag(p, k), undefined);
});

test('a confirmed clip is never picked on that kind of node; a suspect still is', () => {
  const okA = film(otavA, 'Fine');
  const badA = film(otavA, 'Broken');
  const susA = film(otavA, 'Maybe');
  const badAnalog = film(analog, 'Broken');
  const tpl = { id: 0, is_movie_block: 1, movie_limit: 1 };
  const block = { id: 0, target_date: '2031-07-10' };
  pf.setFlags(['/Volumes/Public/Films/Broken.mov'], 'otav', 'confirmed');
  pf.recordFault({ filePath: '/Volumes/Public/Films/Maybe.mov', playout: 'otav', source: 'monitor', kind: 'black' });
  const ids = moviePool(tpl, block, 7200, otavA, null).map((r) => r.id);
  assert.ok(ids.includes(okA) && ids.includes(susA));
  assert.ok(!ids.includes(badA), 'confirmed bad on OTAV');
  assert.ok(moviePool(tpl, block, 7200, analog, null).some((r) => r.id === badAnalog), 'the analog copy is judged on its own');
});

test('the catalogue shows the mark per kind of node, and marks by hand', async () => {
  const cat = async (ch) => (await j('GET', `/api/catalog?channel_id=${ch}`)).data;
  const ep = (data, name) => data.groups.flatMap((g) => g.shows).flatMap((s) => s.episodes).find((e) => e.raw_name === name);
  let a = await cat(otavA);
  assert.equal(a.playout, 'otav');
  assert.equal(ep(a, 'Broken').fault.status, 'confirmed');
  assert.equal(ep(a, 'Maybe').fault.status, 'suspect');
  assert.equal(ep(a, 'Fine').fault, null);
  assert.equal(ep(await cat(analog), 'Broken').fault, null);

  const fine = ep(a, 'Fine').id;
  assert.equal((await j('POST', '/api/catalog/bulk', { ids: [fine], op: 'set-playback', status: 'confirmed' })).status, 200);
  assert.equal(flag('/Volumes/Public/Films/Fine.mov', 'otav').note, 'marked by hand');
  assert.equal((await j('POST', '/api/catalog/bulk', { ids: [fine], op: 'set-playback', status: 'bogus' })).status, 400);
  assert.equal((await j('POST', '/api/catalog/bulk', { ids: [fine], op: 'set-playback', status: 'clear' })).status, 200);
  a = await cat(otavA);
  assert.equal(ep(a, 'Fine').fault, null);

  const list = (await j('GET', '/api/faults?playout=otav')).data.flags;
  assert.deepEqual(list.map((f) => f.status).slice(0, 1), ['suspect'], 'suspects first');
  assert.ok(list.some((f) => f.display_name === 'Broken' && f.catalogued === 2));
  assert.equal((await j('PUT', '/api/faults', { paths: ['/x'], playout: 'nope', status: 'confirmed' })).status, 400);
});

test('the block editor and the week grid warn, without failing the block', async () => {
  const tpl = db.prepare(`INSERT INTO BlockTemplate (name, channel_id, weekday, start_time, end_time, content_type)
    VALUES ('Night', ?, 4, '21:00', '22:30', 'movie') RETURNING id`).get(otavA).id;
  const date = '2031-07-10';
  const blk = db.prepare(`INSERT INTO ScheduledBlock (template_id, target_date, status, channel_id) VALUES (?, ?, 'draft', ?) RETURNING id`)
    .get(tpl, date, otavA).id;
  const maybe = db.prepare("SELECT id FROM Resource WHERE channel_id = ? AND name = 'Maybe'").get(otavA).id;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)').run(blk, maybe);
  const v = validateBlock(blk);
  assert.equal(v.items[0].fault_status, 'suspect');
  assert.equal(v.faultyItems, 1);
  assert.equal(v.fits, true, 'a warning, not a rule');
  const week = (await j('GET', `/api/blocks?week=${date}&channel_id=${otavA}`)).data;
  const card = week.blocks.find((b) => b.id === blk);
  assert.equal(card.faultyItems, 1);
  assert.equal(card.faultyConfirmed, 0);
});

test('the monitor blames what OTAV was playing when the picture went, not what is on now', async () => {
  const otav = await startFakeOtav();
  try {
    const ch = db.prepare("INSERT INTO ChannelType (name, api_ip, api_port) VALUES ('Live', '127.0.0.1', ?) RETURNING id").get(otav.port).id;
    film(ch, 'Before', 1200);
    otav.state.playlists.set('Day', { unique_id: 'Day-uid', name: 'Day', items: [
      { url: '/Volumes/Public/Films/Before.mov', name: 'Before', duration: 1200 },
      { url: '/Volumes/Public/Films/Now.mov', name: 'Now', duration: 1800 },
    ] });
    // "Now" started 20s ago; the feed went black 10s ago, i.e. 45s ago on the
    // node with the 35s feed delay — while "Before" was still playing.
    otav.state.playing = { item_path: '/Volumes/Public/Films/Now.mov', item_display_name: 'Now', item_elapsed: 20,
      item_index: 1, playlist_unique_id: 'Day-uid' };
    const r = await pf.attributeIncident(ch, { kind: 'black', startedAt: new Date(Date.now() - 10_000).toISOString() },
      pf.faultsConfig({ feedDelaySeconds: 35, boundarySeconds: 10 }));
    assert.equal(r.fault.file_path, '/Volumes/Public/Films/Before.mov');
    assert.equal(r.fault.confidence, 'exact', '25s before the change is clear of the 10s boundary');
    assert.match(r.label, /^Before \(19:3\d into the clip\)$/);
    assert.equal(flag('/Volumes/Public/Films/Before.mov', 'otav').status, 'suspect');

    assert.match((await pf.attributeIncident(ch, { kind: 'down', startedAt: new Date().toISOString() })).skipped, /not a clip fault/);
  } finally {
    await otav.close();
  }
});

test('analog: the device file is traced to its catalogue file; as-run failures and recoveries count once', async () => {
  const today = localDate();
  const dev = await startFakeAnalog({
    live: { player: { filename: 'Arthur_S02E201.mpg', position: '00:10:00:00' }, position_s: 600 },
    asrun: { [today]: [
      { time: '08:00:00', title: 'Arthur', filename: 'Arthur_S02E201.mpg', length: '00:25:00', played: '00:25:00', result: 'OK' },
      { time: '08:25:00', title: 'Bad', filename: 'Bad_Clip.mpg', length: '00:25:00', played: '00:00:03', result: 'Error' },
      { time: '08:50:00', title: 'Guide', filename: 'guide.jpg', length: '00:05:00', played: '00:00:00', result: 'Error' },
      { time: '09:00:00', title: 'Arthur', filename: 'Arthur_S02E202.mpg', length: '00:25:00', played: '00:25:00', result: 'OK' },
    ] },
    recoverLog: [
      { at: `${today}T09:10:00`, verdict_before: 'frozen', result: 'recovered', action: 'MPGPLAYX Arthur_S02E202.mpg desde 600s: ok' },
      { at: `${today}T09:20:00`, verdict_before: 'ok', result: 'skipped' },
    ],
  });
  try {
    db.prepare("UPDATE ChannelType SET api_port = ?, api_key = 'test-key' WHERE id = ?").run(dev.port, analog);
    db.prepare("INSERT INTO AnalogFile (file_path, device_filename) VALUES ('/Volumes/Public/Kids/Arthur 202.mov', 'Arthur_S02E202.mpg')").run();
    let r = await pf.syncAnalogFaults({ days: [today] });
    assert.deepEqual([r.asrun, r.recoveries], [1, 1]);
    assert.equal(flag('vol1:Bad_Clip.mpg', 'analog').faults, 1, 'a device file the catalogue does not know');
    assert.equal(flag('/Volumes/Public/Kids/Arthur 202.mov', 'analog').last_kind, 'frozen');
    assert.equal(flag('/Volumes/Public/Kids/Arthur 202.mov', 'otav'), undefined);
    r = await pf.syncAnalogFaults({ days: [today] });
    assert.deepEqual([r.asrun, r.recoveries], [0, 0], 'read again, counted once');

    // A vocabulary this code doesn't know must not mark a whole day.
    const d2 = addDays(today, -1);
    dev.state.asrun[d2] = ['a', 'b', 'c', 'd'].map((f, i) => ({ time: `10:0${i}:00`, filename: `${f}.mpg`, result: 'Aired' }));
    r = await pf.syncAnalogFaults({ days: [d2] });
    assert.deepEqual(r.skippedDays, [d2]);

    // The monitor on the analog channel: the file and its position from /playback/live.
    const m = await pf.attributeIncident(analog, { kind: 'silent', startedAt: new Date().toISOString() });
    assert.equal(m.fault.clip_name, 'Arthur_S02E201.mpg');
    assert.equal(m.fault.playout, 'analog');
    assert.equal(Math.round(m.fault.offset_seconds), 565);
  } finally {
    await new Promise((res) => dev.server.close(res));
  }
});

test('marks follow a file Air Spec converted, back to suspect', () => {
  const from = '/Volumes/Public/Films/Old.avi';
  const to = '/Volumes/Public/Films/Old.mov';
  pf.recordFault({ filePath: from, playout: 'otav', source: 'monitor', kind: 'frozen' });
  pf.setFlags([from], 'otav', 'confirmed');
  pf.moveFlags(from, to, { reencoded: true });
  assert.equal(flag(from, 'otav'), undefined);
  assert.equal(flag(to, 'otav').status, 'suspect');
  assert.match(flag(to, 'otav').note, /converted by Air Spec/);
  assert.equal(flag(to, 'otav').faults, 1, 'the history moved with it');
});
