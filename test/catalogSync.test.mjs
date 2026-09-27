// One file, one set of catalogue decisions across channels; shared media roots
// edited as one thing; an explicitly picked episode is honoured; and the
// EDYOU PULSE repair.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'otav-sync-'));
process.env.SCHEDULER_DB = join(dir, 'test.sqlite');
// A throwaway config too: nothing here may read or write the operator's.
process.env.SCHEDULER_CONFIG = join(dir, 'config.json');
copyFileSync(new URL('../config/config.example.json', import.meta.url), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const { loadConfig } = await import('../src/config.js');
const { router: catalog } = await import('../src/routes/catalog.js');
const { router: media } = await import('../src/routes/media.js');
const { router: blocks } = await import('../src/routes/blocks.js');
const { router: seriesRouter } = await import('../src/routes/series.js');
const edyou = await import('../src/migrations/004-unify-edyou-pulse.js');
const sync = await import('../src/migrations/005-sync-shared-catalog.js');

initSchema();

let server, base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/catalog', catalog);
  app.use('/api/media', media);
  app.use('/api/blocks', blocks);
  app.use('/api/channels', seriesRouter);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

async function j(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const stId = (code) => db.prepare('SELECT id FROM ShowType WHERE code = ?').get(code).id;
const channel = (name) => db.prepare(
  "INSERT INTO ChannelType (name, api_ip, api_port) VALUES (?, '127.0.0.1', 1) RETURNING id"
).get(name).id;
function clip(ch, path, { subject = null, season = null, chapter = 0, duration = 600, approved = 1, type = 'tv_shows', filler = 0 } = {}) {
  return db.prepare(`
    INSERT INTO Resource (name, file_path, duration, subject, season, chapter, is_filler, approved, channel_id, show_type_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
  `).get(path.split('/').pop().replace(/\.[^.]+$/, ''), path, duration, subject, season, chapter, filler, approved, ch, stId(type)).id;
}
const row = (id) => db.prepare('SELECT * FROM Resource WHERE id = ?').get(id);

test('a catalogue edit on one channel is applied to every channel carrying the file', async () => {
  const a = channel('Sync A');
  const b = channel('Sync B');
  const solo = channel('Sync Solo');
  const pa = clip(a, '/m/Show/Show EP 3.mov', { subject: 'Show', chapter: 3, approved: 0 });
  const pb = clip(b, '/m/Show/Show EP 3.mov', { subject: 'Show', chapter: 3, approved: 0 });
  const only = clip(solo, '/m/Solo/Solo EP 1.mov', { subject: 'Solo', chapter: 1, approved: 0 });

  await j('POST', '/api/catalog/bulk', { ids: [pa], op: 'set-season', season: 2 });
  assert.equal(row(pb).season, 2, 'the copy on the other channel follows');
  assert.equal(row(pb).chapter, 2003);

  await j('POST', '/api/catalog/bulk', { ids: [pa], op: 'set-subject', subject: 'Renamed' });
  assert.equal(row(pb).subject, 'Renamed');
  assert.ok(db.prepare("SELECT 1 FROM ChannelSeries WHERE channel_id = ? AND subject = 'Renamed'").get(b),
    'the other channel registers the series too');

  await j('POST', '/api/catalog/bulk', { ids: [pa], op: 'set-approved', approved: true });
  assert.equal(row(pb).approved, 1);
  assert.equal(row(only).approved, 0, 'a file no other channel carries is untouched');

  await j('PUT', `/api/catalog/resource/${pa}`, { display_name: 'On screen' });
  const ov = db.prepare('SELECT display_name, detected_subject FROM ResourceOverride WHERE resource_id = ?').get(pb);
  assert.equal(ov.display_name, 'On screen');
  assert.equal(ov.detected_subject, 'Show', "the copy keeps its OWN pre-edit snapshot for reset");

  const del = await j('DELETE', `/api/catalog/resource/${pa}`);
  assert.equal(del.data.deleted, 2);
  assert.equal(row(pb), undefined, 'deleting a duplicate removes it everywhere');
});

test('the series registry takes its show type from the clips, not a stale client value', async () => {
  const ch = channel('Registry');
  clip(ch, '/m/Reg/Reg EP 1.mov', { subject: 'Reg', chapter: 1 });
  await j('PUT', `/api/channels/${ch}/series`, { series: [{ subject: 'Reg', is_serial: 1, show_type_id: stId('movies') }] });
  const cs = db.prepare("SELECT show_type_id FROM ChannelSeries WHERE channel_id = ? AND subject = 'Reg'").get(ch);
  assert.equal(cs.show_type_id, stId('tv_shows'));
});

test('a shared media root is edited as one thing', async () => {
  const mount = loadConfig().smb.mountPoint.replace(/\/+$/, '');
  const path = `${mount}/__sync_test__/Docs`;
  const [x, y, z] = [channel('Root X'), channel('Root Y'), channel('Root Z')];
  for (const c of [x, y]) {
    db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)').run(c, stId('tv_shows'), path);
    clip(c, `${path}/doc1.mov`, { subject: 'Docs', chapter: 1 });
  }

  const r = await j('PUT', '/api/media/roots/group', {
    path, show_type_id: stId('tv_shows'), next_show_type_id: stId('documentaries'), channel_ids: [x, z],
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const roots = db.prepare('SELECT channel_id, show_type_id FROM MediaRoot WHERE path = ? ORDER BY channel_id').all(path);
  assert.deepEqual(roots.map((q) => q.channel_id), [x, z], 'Y dropped, Z added');
  assert.ok(roots.every((q) => q.show_type_id === stId('documentaries')), 'one type for every channel');
  const typeOn = (c) => db.prepare('SELECT show_type_id FROM Resource WHERE channel_id = ? AND file_path = ?').get(c, `${path}/doc1.mov`)?.show_type_id;
  assert.equal(typeOn(x), stId('documentaries'), 'catalogue re-tagged without a scan');
  assert.equal(typeOn(z), stId('documentaries'), 'the new channel got the scanned clip cloned');
  assert.equal(typeOn(y), undefined, "the dropped channel's clips went with its root");

  const none = await j('PUT', '/api/media/roots/group', { path, show_type_id: stId('documentaries'), channel_ids: [] });
  assert.equal(none.status, 400);
});

test('set-episode honours a pick longer than the slot, and refuses an unapproved one', async () => {
  const ch = channel('Pick');
  clip(ch, '/m/Pulse/EP 1.mov', { subject: 'Pulse', season: 1, chapter: 1, duration: 1700 });
  const long = clip(ch, '/m/Pulse/SEASON 2/EP3SE2.mp4', { subject: 'Pulse', season: 2, chapter: 2003, duration: 1821 });
  clip(ch, '/m/Pulse/SEASON 2/EP4SE2.mp4', { subject: 'Pulse', season: 2, chapter: 2004, duration: 1700, approved: 0 });
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, play_order) VALUES (?, 'Pulse', ?, 1, 0)")
    .run(ch, stId('tv_shows'));
  const tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
                          VALUES (?, 'Pulse', 'Mon', 'Mon', '19:00', '19:30') RETURNING id`).get(ch).id;
  db.prepare("INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, 'Pulse', 0)").run(tpl);
  const slot = db.prepare(`INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order)
                           VALUES (?, '19:00', '19:30', 0) RETURNING id`).get(tpl).id;
  const blockId = db.prepare(`INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status)
                              VALUES (?, ?, ?, '2026-10-05', 'draft') RETURNING id`).get(tpl, slot, ch).id;
  const regen = await j('POST', `/api/blocks/${blockId}/regenerate`);
  assert.equal(regen.status, 200, JSON.stringify(regen.data));
  const got = await j('GET', `/api/blocks/${blockId}`);
  const first = got.data.items?.find((i) => i.subject === 'Pulse');
  assert.ok(first, JSON.stringify(got.data).slice(0, 400));

  const r = await j('POST', `/api/blocks/${blockId}/items/${first.id}/set-episode`, { chapter: 2003 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const main = r.data.items.filter((i) => !i.is_filler);
  assert.deepEqual(main.map((i) => i.resource_id), [long], 'the chosen episode is in the block, not the next one');
  assert.match(r.data.warning, /21s longer/);
  assert.equal(r.data.fits, false, 'and the block honestly does not pass');
  // A rebuild must keep it: the serial's due episode is placed with its
  // overrun instead of skipped (which wrapped the series back to episode 1).
  const again = await j('POST', `/api/blocks/${blockId}/regenerate`);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const rebuilt = (await j('GET', `/api/blocks/${blockId}`)).data.items.filter((i) => !i.is_filler);
  assert.deepEqual(rebuilt.map((i) => i.resource_id), [long], 'regenerating does not fall back to S01E01');

  // The operator accepts the overrun: forcing makes it approvable, still not "fits".
  const forced = await j('POST', `/api/blocks/${blockId}/override`, { enabled: true, reason: 'episode runs long' });
  assert.equal(forced.status, 200, JSON.stringify(forced.data));
  assert.equal(forced.data.fits, false);
  assert.equal(forced.data.approvable, true);
  const approved = await j('POST', `/api/blocks/${blockId}/approve`);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));

  // Picking another episode on that forced + approved block must change it. It
  // used to answer 200 "rebuilt" and leave the block exactly as it was, because
  // only drafts are rebuilt.
  const plays = () => db.prepare('SELECT COUNT(*) AS n FROM PlayHistory WHERE channel_id = ?').get(ch).n;
  assert.ok(plays() > 0, 'approval recorded the plays');
  const ep1 = db.prepare("SELECT id FROM Resource WHERE channel_id = ? AND chapter = 1").get(ch).id;
  const onApproved = (await j('GET', `/api/blocks/${blockId}`)).data.items.find((i) => i.resource_id === long);
  const back = await j('POST', `/api/blocks/${blockId}/items/${onApproved.id}/set-episode`, { chapter: 1 });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.reopened, 1);
  assert.equal(back.data.block.status, 'draft', 'the approved block went back to draft');
  assert.equal(back.data.block.override_reason ?? null, null, 'the old force went with the old content');
  assert.deepEqual(back.data.items.filter((i) => !i.is_filler).map((i) => i.resource_id), [ep1]);
  assert.equal(plays(), 0, 'the plays its approval recorded were taken back');

  db.prepare("UPDATE ScheduledBlock SET status = 'exported' WHERE id = ?").run(blockId);
  const exported = await j('POST', `/api/blocks/${blockId}/items/${back.data.items[0].id}/set-episode`, { chapter: 2003 });
  assert.equal(exported.status, 409, 'an exported day is refused, not silently ignored');
  db.prepare("UPDATE ScheduledBlock SET status = 'draft', override_reason = NULL, override_at = NULL WHERE id = ?").run(blockId);

  const item = r.data.items[0];
  const refused = await j('POST', `/api/blocks/${blockId}/items/${item.id}/set-episode`, { chapter: 2004 });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /not approved/);
});

test('the EDYOU PULSE repair files one two-season show on every channel', () => {
  const run = (m) => { for (const op of m.plan().ops) db.prepare(op.sql).run(...op.params); };
  const root = '/Volumes/Public/Transmission/EDYOUPULSE';
  const [c1, c2] = [channel('Edyou 1'), channel('Edyou 2')];
  // c2 = the hand-edited channel: seasons, colliding chapters, stale rows deleted.
  clip(c2, `${root}/EDYOU PULSE EP 2.mov`, { subject: 'EDYOU PULSE', season: 1, chapter: 2 });
  clip(c2, `${root}/EDYOU PULSE EP 3.mov`, { subject: 'EDYOU PULSE', season: 1, chapter: 2 });
  clip(c2, `${root}/SEASON 2/EDYOU PULSE  EP3SE2.mp4`, { subject: 'EDYOU PULSE', season: 2, chapter: 2004 });
  // c1 = never touched: flat subject, a stale pre-rename row, the Local Shows copy.
  clip(c1, `${root}/EDYOU PULSE EP 2.mov`, { subject: 'EDYOUPULSE', chapter: 2, approved: 0 });
  clip(c1, `${root}/EDYOU PULSE EP 3.mov`, { subject: 'EDYOUPULSE', chapter: 3, approved: 0 });
  clip(c1, `${root}/SEASON 2/EDYOU PULSE  EP3SE2.mp4`, { subject: 'EDYOUPULSE', chapter: 3, approved: 0 });
  const stale = clip(c1, `${root}/SEASON 2/EDYOU PULSE  EP 3.mp4`, { subject: 'EDYOUPULSE', chapter: 3, approved: 0 });
  const copy = clip(c1, '/Volumes/Public/Broadcast/Local Shows/EdYou Pulse/EDYou_Pulse_ Ep_19.mp4', { subject: 'EdYou Pulse', chapter: 19 });
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, play_order) VALUES (?, 'EDYOU PULSE', ?, 1, 3)")
    .run(c2, stId('movies'));
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, play_order) VALUES (?, 'EDYOUPULSE', ?, 0, 5)")
    .run(c1, stId('movies'));
  db.prepare("INSERT INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, play_order) VALUES (?, 'EdYou Pulse', ?, 1, 7)")
    .run(c1, stId('tv_shows'));

  run(edyou);
  const filed = (c) => db.prepare(
    "SELECT subject, season, chapter, approved FROM Resource WHERE channel_id = ? AND file_path LIKE '%/EDYOUPULSE/%' ORDER BY chapter"
  ).all(c).map((r) => `${r.subject}|${r.season}|${r.chapter}|${r.approved}`);
  const want = ['EDYOU PULSE|1|2|1', 'EDYOU PULSE|1|3|1', 'EDYOU PULSE|2|2003|1'];
  assert.deepEqual(filed(c1), want);
  assert.deepEqual(filed(c2), want, 'both channels agree, chapters unique and in order');
  assert.equal(row(stale), undefined, 'the renamed file’s old row is gone');
  assert.equal(row(copy).subject, null, 'the Local Shows copy is out of the show');
  assert.equal(row(copy).approved, 0);
  for (const c of [c1, c2]) {
    const reg = db.prepare("SELECT subject, show_type_id, is_serial FROM ChannelSeries WHERE channel_id = ? AND subject LIKE '%pulse%'").all(c).map((r) => ({ ...r }));
    assert.deepEqual(reg, [{ subject: 'EDYOU PULSE', show_type_id: stId('tv_shows'), is_serial: 1 }], 'one TV row per channel');
  }
  assert.equal(edyou.plan().ops.filter((o) => !o.sql.includes('ChannelSeries')).length, 0,
    'a second run has nothing left to re-file');
  run(sync);
});
