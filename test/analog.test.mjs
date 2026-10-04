// The analog channel (UltraNEXUS-HD via analog-automator): one fixed channel,
// its key kept server-side, its days pushed as weekday replacements, its files
// uploaded to the device first. Nothing here reaches a real device.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { startFakeAnalog } from './fake-analog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'otav-analog-'));
process.env.SCHEDULER_DB = join(work, 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(work, 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);
{
  // Windows = slots, so the fixture's arithmetic is the whole story.
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.schedule = { ...(cfg.schedule || {}), extendIntoGaps: false };
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));
}

const { db, initSchema, ensureAnalogChannel } = await import('../src/db.js');
const { router: channels } = await import('../src/routes/channels.js');
const { router: otav } = await import('../src/routes/otav.js');
const { router: analogRoutes } = await import('../src/routes/analog.js');
const analog = await import('../src/services/analogClient.js');
const { localDate, addDays } = await import('../src/dates.js');

let server, base, fake, analogId;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const weekday = (d) => DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()];
const tomorrow = addDays(localDate(), 1);

async function j(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const file = (name, bytes = 1000) => {
  const p = join(work, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  return p;
};

before(async () => {
  initSchema();
  analogId = ensureAnalogChannel();
  const app = express();
  app.use(express.json());
  app.use('/api/channels', channels);
  app.use('/api/otav', otav);
  app.use('/api/analog', analogRoutes);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  if (fake) await new Promise((r) => fake.server.close(r));
});

test('device names: no spaces or accents, at most 31 characters, suffix to disambiguate', () => {
  assert.equal(analog.deviceFileName('/m/Arthur S02E201.MPG'), 'Arthur_S02E201.mpg');
  assert.equal(analog.deviceFileName('/m/Canción de cuna – Parte 1.mov'), 'Cancion_de_cuna_Parte_1.mov');
  const long = analog.deviceFileName('/m/Math Intervention Program 020 Grade 4 Part 1.mov');
  assert.ok(long.length <= 31, long);
  assert.match(long, /^[A-Za-z0-9._()-]+\.mov$/);
  const second = analog.deviceFileName('/m/Math Intervention Program 020 Grade 4 Part 1.mov', 2);
  assert.ok(second.endsWith('_2.mov') && second.length <= 31, second);
});

test('a day is fixed block starts, chained content, and the Program Guide in every hole', () => {
  const lib = { a: { resource_id: 1, length_s: 598 }, b: { resource_id: 2, length_s: 300 } };
  const { items, warnings, clips } = analog.buildDayItems([
    { id: 1, effective_start: '06:00:00', blockSeconds: 900, items: [{ file_path: 'a' }, { file_path: 'b' }] },
    { id: 2, effective_start: '06:15:00', blockSeconds: 1800, items: [{ file_path: 'b' }] },
    { id: 3, effective_start: '06:45:00', blockSeconds: 600, items: [] },
  ], (p) => lib[p], { resource_id: 99 });
  assert.deepEqual(items, [
    { resource_id: 1, time: '06:00:00' },
    { resource_id: 2 },
    { resource_id: 99, length_s: 2 },        // 900 - 598 - 300
    { resource_id: 2, time: '06:15:00' },
    { resource_id: 99, length_s: 1500 },
    { resource_id: 99, length_s: 600, time: '06:45:00' },  // an empty block is all guide
  ]);
  assert.equal(clips, 3);
  assert.deepEqual(warnings, []);
});

test('the analog channel is fixed, and its API key never goes back to the browser', async () => {
  assert.equal(ensureAnalogChannel(), analogId, 'one row, however often it is ensured');
  let r = await j('PUT', `/api/channels/${analogId}`, { api_ip: '127.0.0.1', api_port: 1, api_key: 'secret', is_active: 1 });
  assert.equal(r.status, 200);
  const listed = (await j('GET', '/api/channels')).data.find((c) => c.id === analogId);
  assert.equal(listed.playout, 'analog');
  assert.equal(listed.has_api_key, true);
  assert.ok(!('api_key' in listed), 'the key is not listed');
  // A save with the key blank keeps it.
  await j('PUT', `/api/channels/${analogId}`, { name: 'Analog', api_key: '' });
  assert.equal(db.prepare('SELECT api_key FROM ChannelType WHERE id = ?').get(analogId).api_key, 'secret');
  r = await j('DELETE', `/api/channels/${analogId}`);
  assert.equal(r.status, 409);
  r = await j('POST', '/api/channels', { name: 'Analog 2', playout: 'analog' });
  assert.equal(r.status, 409);
  assert.throws(() => db.prepare("INSERT INTO ChannelType (name, playout) VALUES ('x', 'analog')").run(), /UNIQUE/);
});

test('push: refuses files the device lacks, uploads them, then replaces the weekday and publishes once', async () => {
  // On the device already: A (same name, length within tolerance → adopted).
  fake = await startFakeAnalog({
    key: 'secret',
    library: [
      { resource_id: 11, title: 'Show_A', filename: 'Show_A.mov', length_s: 598 },
      { resource_id: 77, title: 'Program Guide', filename: 'TVBackground_1920.jpg', length_s: 60, type: 'program_guide' },
    ],
    disk: ['Show_A.mov'],
    lengths: { 'Show_B.mov': 905, 'Show_C.mov': 300 },
  });
  db.prepare('UPDATE ChannelType SET api_ip = ?, api_port = ?, api_key = ? WHERE id = ?')
    .run('127.0.0.1', fake.port, 'secret', analogId);

  const res = (name, path, duration) => db.prepare(`INSERT INTO Resource (name, file_path, duration, channel_id, approved)
    VALUES (?, ?, ?, ?, 1) RETURNING id`).get(name, path, duration, analogId).id;
  const A = res('Show A', file('Show A.mov'), 600);
  const B = res('Show B', file('Show B.mov', 4096), 900);
  const C = res('Show C', file('Show C.mov', 2048), 300);
  const wd = weekday(tomorrow);
  const wdCap = wd[0].toUpperCase() + wd.slice(1);
  const tpl = (name, start, end) => {
    const id = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
      VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(analogId, name, wdCap, wdCap, start, end).id;
    db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(id, analogId);
    const slot = db.prepare('INSERT INTO BlockTemplateSlot (template_id, start_time, end_time) VALUES (?, ?, ?) RETURNING id')
      .get(id, start, end).id;
    return { id, slot };
  };
  const block = (t, date, items, extra = '') => {
    const id = db.prepare(`INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status)
      VALUES (?, ?, ?, ?, 'approved') RETURNING id`).get(t.id, t.slot, analogId, date).id;
    items.forEach((r, i) => db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, ?)').run(id, r, i));
    if (extra) db.prepare(`UPDATE ScheduledBlock SET override_reason = ?, override_at = datetime('now') WHERE id = ?`).run(extra, id);
    return id;
  };
  const t1 = tpl('Morning', '06:00', '06:30');
  const t2 = tpl('Late morning', '06:30', '07:00');
  const b1 = block(t1, tomorrow, [A, B, C]);                 // 1800s of 1800
  const b2 = block(t2, tomorrow, [C, C], 'forced: short');   // 600s of 1800, forced

  // B and C are not on the device: the push says so before touching it.
  let r = await j('POST', `/api/otav/push?date=${tomorrow}&channels=${analogId}`);
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.deepEqual(r.data.analogMissing.map((m) => m.device_filename).sort(), ['Show_B.mov', 'Show_C.mov']);
  assert.equal(fake.state.resets, 0, 'the device draft was not touched');

  // Upload them (background job), as the dialog's button does.
  r = await j('POST', '/api/analog/upload', { from: tomorrow, to: tomorrow });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.upload.total, 2);
  for (let i = 0; i < 100 && analog.uploadStatus().running; i++) await new Promise((ok) => setTimeout(ok, 20));
  const up = analog.uploadStatus();
  assert.equal(up.failed.length, 0, JSON.stringify(up.failed));
  assert.deepEqual(fake.state.uploads.map((u) => [u.filename, u.bytes]).sort(), [['Show_B.mov', 4096], ['Show_C.mov', 2048]]);

  // On disk but not in the library: the push adds them — into the chosen folder.
  r = await j('POST', `/api/otav/push?date=${tomorrow}&channels=${analogId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.channels[0].ok, false);
  assert.match(r.data.channels[0].error, /library folder/);
  assert.equal((await j('PUT', '/api/analog/settings', { folderId: 5 })).status, 200);

  r = await j('POST', `/api/otav/push?date=${tomorrow}&channels=${analogId}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = r.data.channels.find((c) => c.channel === 'Analog');
  assert.equal(row.ok, true, row.error);
  assert.equal(row.source, 'analog');
  assert.equal(row.pushed, 5);
  assert.deepEqual(fake.state.created.sort(), ['Show_B.mov', 'Show_C.mov']);
  assert.equal(fake.state.published.length, 1, 'one publish');
  assert.equal(fake.state.published[0].confirm_today, false);

  const ids = Object.fromEntries(fake.state.device.map((x) => [x.filename, x.resource_id]));
  assert.deepEqual(fake.state.days[wd].items, [
    { resource_id: ids['Show_A.mov'], time: '06:00:00' },
    { resource_id: ids['Show_B.mov'] },
    { resource_id: ids['Show_C.mov'] },             // 598 + 905 + 300 = 1803: 3s over, trimmed by the device
    { resource_id: ids['Show_C.mov'], time: '06:30:00' },
    { resource_id: ids['Show_C.mov'] },
    { resource_id: 77, length_s: 1200 },            // the forced block's hole is the guide, not black
  ]);
  assert.equal(fake.state.days[wd].overflow, 'drop');
  for (const id of [b1, b2]) {
    assert.equal(db.prepare('SELECT status FROM ScheduledBlock WHERE id = ?').get(id).status, 'exported');
  }
});

test('push: today needs a confirmation, and a date past the device week is held', async () => {
  const today = localDate();
  const t = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, start_time, end_time)
    VALUES (?, 'Today', 'Mon', '05:00', '05:05') RETURNING id`).get(analogId).id;
  const C = db.prepare("SELECT id FROM Resource WHERE name = 'Show C'").get().id;
  for (const d of [today, addDays(today, 8)]) {
    const id = db.prepare(`INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status)
      VALUES (?, ?, ?, 'approved') RETURNING id`).get(t, analogId, d).id;
    db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)').run(id, C);
  }
  let r = await j('POST', `/api/otav/push?date=${today}&channels=${analogId}`);
  assert.equal(r.status, 409);
  assert.equal(r.data.needsConfirm, 'today');

  const published = fake.state.published.length;
  r = await j('POST', `/api/otav/push?date=${today}&channels=${analogId}&includeToday=1&allowGaps=1`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(fake.state.published.length, published + 1);
  assert.equal(fake.state.published.at(-1).confirm_today, true);

  const far = addDays(today, 8);
  const w = analog.analogWindow(analogId, [far]);
  assert.deepEqual(w.pushable, []);
  assert.match(w.held[0].reason, /would overwrite/);
});

test('device disk: list with what uses each file, delete the free ones, force the rest', async () => {
  fake.state.disk.add('Old_Promo.mov');
  fake.state.disk.add('On_Air_Now.mov');
  fake.state.onAir.add('On_Air_Now.mov');
  const list = (await j('GET', '/api/analog/storage')).data.files;
  const by = Object.fromEntries(list.map((f) => [f.filename, f]));
  assert.equal(by['Old_Promo.mov'].upcoming, null);
  assert.equal(by['On_Air_Now.mov'].in_schedule, true);
  // Show_C.mov airs from tomorrow in approved/pushed blocks (the push test above).
  assert.ok(by['Show_C.mov'].upcoming.approved > 0, JSON.stringify(by['Show_C.mov']));
  assert.match(by['Show_C.mov'].file_path, /Show C\.mov$/);

  let r = await j('POST', '/api/analog/storage/delete', { filenames: ['Old_Promo.mov', 'On_Air_Now.mov', 'Show_C.mov', 'Nope.mov'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.deleted.map((d) => d.filename), ['Old_Promo.mov']);
  assert.deepEqual(r.data.refused.map((d) => d.filename).sort(), ['On_Air_Now.mov', 'Show_C.mov']);
  assert.deepEqual(r.data.failed.map((d) => d.filename), ['Nope.mov']);
  assert.ok(fake.state.disk.has('Show_C.mov'), 'a used file stays without force');

  r = await j('POST', '/api/analog/storage/delete', { filenames: ['Show_C.mov'], force: true });
  assert.deepEqual(r.data.deleted.map((d) => d.filename), ['Show_C.mov']);
  assert.deepEqual(fake.state.deleted.at(-1), { filename: 'Show_C.mov', force: true });
  // The mapping stays (same name next time) and the file reads as missing again.
  assert.equal(db.prepare("SELECT uploaded_at FROM AnalogFile WHERE device_filename = 'Show_C.mov'").get().uploaded_at, null);
  const files = (await j('GET', `/api/analog/files?from=${tomorrow}&to=${tomorrow}`)).data.files;
  assert.equal(files.find((f) => f.device_filename === 'Show_C.mov').state, 'missing');
  assert.equal((await j('POST', '/api/analog/storage/delete', {})).status, 400);
});

test('the OTAV pusher never takes the analog channel, and the tab routes reach the device', async () => {
  const { dayBlocks } = await import('../src/services/otavClient.js');
  assert.ok(dayBlocks(tomorrow).every((b) => b.playout === 'analog'), 'fixture blocks are analog');
  const r = await j('GET', '/api/analog/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.playback.verdict, 'ok');
  assert.equal(r.data.live.player.filename, 'Arthur_S02E201.mpg');
  const b = await j('GET', '/api/analog/backups');
  assert.ok(b.data.backups.length >= 1);
  assert.equal((await j('POST', `/api/analog/rollback/${b.data.backups[0]}`, {})).status, 400, 'needs confirm');
  assert.equal((await j('POST', `/api/analog/rollback/${b.data.backups[0]}`, { confirm: true })).status, 200);
  assert.deepEqual(fake.state.rollbacks, [b.data.backups[0]]);
  // Manual recovery is never forced: a forced one replays the file on a healthy channel.
  await j('POST', '/api/analog/recover', { force: true });
  assert.deepEqual(fake.state.recovers.at(-1), { force: false });
  // A wrong key is reported as such.
  db.prepare("UPDATE ChannelType SET api_key = 'wrong' WHERE id = ?").run(analogId);
  const bad = await j('GET', '/api/analog/backups');
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /API key is wrong/);
});
