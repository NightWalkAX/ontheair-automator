// End-to-end integration test against a fully faked environment:
//   - fake ffprobe (test/fake-ffprobe) supplies durations from filenames
//   - a fake OTAV REST server stands in for the 6 Softron instances
//   - a temp media tree stands in for the SMB mount
//
// It boots the real Express app (same routers as server.js) and drives the
// whole flow over HTTP: ingest (with folder/filename series detection + filler
// auto-flag) -> configure the channel series registry -> build a multi-weekday,
// multi-airing, multi-series template -> generate (greedy series cycling + strict
// mirror airings + cross-day progression) -> review/edit (incl. the tolerance 409
// and the mirror-edit guard) -> approve -> push -> verify OTAV received the clips.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point ingestion at the fake ffprobe BEFORE importing app modules.
process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe');

const { db, initSchema } = await import('../src/db.js');
const { router: channels } = await import('../src/routes/channels.js');
const { router: seriesRouter } = await import('../src/routes/series.js');
const { router: showtypes } = await import('../src/routes/showtypes.js');
const { router: resources } = await import('../src/routes/resources.js');
const { router: catalog } = await import('../src/routes/catalog.js');
const { router: media } = await import('../src/routes/media.js');
const { router: blocks } = await import('../src/routes/blocks.js');
const { router: otav } = await import('../src/routes/otav.js');
const { runWeeklyDraft } = await import('../src/cron/weeklyDraft.js');
const { fitFillers, spreadFillers } = await import('../src/services/scheduling.js');
const { cloneScannedResources } = await import('../src/services/ingestion.js');
const { latestEpisode } = await import('../src/services/playHistory.js');
const { startFakeOtav } = await import('./fake-otav.mjs');

let server, base, fakeOtav, mediaDir;

// Media tree. Lessons live in per-series subfolders (folder name = subject) with
// SxxEyy chapter markers and a trailing duration; the Fillers show type auto-flags
// its clips; movies are standalone. All durations are the last number in the name.
const LESSON_SERIES = ['Math', 'History', 'Biology'];
const LESSON_CH = [1, 2, 3, 4, 5, 6];
const FILLER_DURS = [30, 45, 60, 90, 120, 15, 20, 10, 5];

async function j(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const stId = (code) => db.prepare('SELECT id FROM ShowType WHERE code = ?').get(code).id;

before(async () => {
  initSchema();

  mediaDir = mkdtempSync(join(tmpdir(), 'otav-media-'));
  for (const s of LESSON_SERIES) {
    mkdirSync(join(mediaDir, 'lessons', s), { recursive: true });
    for (const c of LESSON_CH) {
      writeFileSync(join(mediaDir, 'lessons', s, `${s}_S01E0${c}_600.mov`), 'x');
    }
  }
  mkdirSync(join(mediaDir, 'movies'), { recursive: true });
  for (const [i, d] of [5400, 6000, 5700, 4800].entries()) {
    writeFileSync(join(mediaDir, 'movies', `Movie${i}_${d}.mov`), 'x');
  }
  mkdirSync(join(mediaDir, 'fillers'), { recursive: true });
  FILLER_DURS.forEach((d, i) => writeFileSync(join(mediaDir, 'fillers', `f${i}_${d}.mov`), 'x'));

  fakeOtav = await startFakeOtav({ requireAuth: true });

  const app = express();
  app.use(express.json());
  app.use('/api/channels', channels);
  app.use('/api/channels', seriesRouter);
  app.use('/api/showtypes', showtypes);
  app.use('/api/resources', resources);
  app.use('/api/catalog', catalog);
  app.use('/api/media', media);
  app.use('/api/blocks', blocks);
  app.use('/api/otav', otav);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await fakeOtav.close();
});

test('show types are a fixed, read-only catalogue of 5', async () => {
  const list = (await j('GET', '/api/showtypes')).data;
  assert.equal(list.length, 5);
  assert.deepEqual(list.map((s) => s.code).sort(), ['documentaries', 'fillers', 'lessons', 'movies', 'tv_shows']);
  assert.equal(list.find((s) => s.code === 'fillers').is_filler, 1);
  assert.equal(list.find((s) => s.code === 'lessons').is_educational, 1);
  const denied = await j('POST', '/api/showtypes', { name: 'Anything' });
  assert.equal(denied.status, 405, 'creating a show type is rejected');
});

test('channel + ingestion detects series/chapters and auto-flags fillers', async () => {
  const ch = await j('POST', '/api/channels', {
    name: 'Channel 1', api_ip: '127.0.0.1', api_port: fakeOtav.port,
    playlist_ref: '0', api_username: 'admin', api_password: 'pw',
  });
  assert.equal(ch.status, 201);
  const chId = ch.data.id;

  // Assign one media root per show type (direct SQL: the HTTP assign route is
  // guarded to the real SMB mount point, exercised separately below).
  const roots = [
    { code: 'lessons', dir: 'lessons' },
    { code: 'movies', dir: 'movies' },
    { code: 'fillers', dir: 'fillers' },
  ];
  for (const r of roots) {
    db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
      .run(chId, stId(r.code), join(mediaDir, r.dir));
  }

  let ingested = 0;
  for (const r of (await j('GET', '/api/media/roots')).data) {
    const scan = await j('POST', `/api/media/roots/${r.id}/scan`);
    assert.equal(scan.status, 200);
    ingested += scan.data.ingested;
  }
  assert.equal(ingested, LESSON_SERIES.length * LESSON_CH.length + 4 + FILLER_DURS.length);

  // New scans arrive unapproved (the review gate). The operator approves after
  // organizing — simulate that here so downstream generation has content.
  db.exec('UPDATE Resource SET approved = 1');

  const all = (await j('GET', `/api/resources?channel_id=${chId}`)).data;
  // Duration through the fake probe.
  const m0 = all.find((r) => basename(r.file_path) === 'Movie0_5400.mov');
  assert.equal(m0.duration, 5400);
  // Series detection: subject = folder, chapter = SxxEyy marker.
  const math3 = all.find((r) => basename(r.file_path) === 'Math_S01E03_600.mov');
  assert.equal(math3.subject, 'Math');
  assert.equal(math3.chapter, 3);
  assert.equal(math3.duration, 600);
  // Filler auto-flag: Fillers show type → is_filler=1, no subject.
  const fillers = all.filter((r) => r.is_filler);
  assert.equal(fillers.length, FILLER_DURS.length);
  assert.ok(fillers.every((r) => !r.subject));

  // Series auto-registration in the channel registry.
  const reg = (await j('GET', `/api/channels/${chId}/series`)).data;
  const subjects = reg.map((s) => s.subject).sort();
  assert.deepEqual(subjects, ['Biology', 'History', 'Math', 'movies']);
  const math = reg.find((s) => s.subject === 'Math');
  assert.equal(math.is_serial, 1, 'lessons default to serial');
  assert.equal(math.chapter_count, 6);
  assert.equal(reg.find((s) => s.subject === 'movies').is_serial, 0, 'movies default to standalone');
});

test('series registry: order the series and inspect chapters', async () => {
  const chId = (await j('GET', '/api/channels')).data[0].id;
  const put = await j('PUT', `/api/channels/${chId}/series`, {
    series: LESSON_SERIES.map((subject, idx) => ({ subject, play_order: idx, is_serial: 1, is_active: 1 })),
  });
  assert.equal(put.status, 200);

  const chapters = (await j('GET', `/api/channels/${chId}/series/${encodeURIComponent('History')}/chapters`)).data;
  assert.equal(chapters.length, 6);
  assert.deepEqual(chapters.map((c) => c.chapter), [1, 2, 3, 4, 5, 6]);
});

let templateId;
test('build a multi-weekday, multi-airing, multi-series template', async () => {
  const chId = (await j('GET', '/api/channels')).data[0].id;
  const created = await j('POST', '/api/blocks/templates', {
    channel_id: chId,
    name: 'Morning Lessons',
    weekdays: ['Mon', 'Tue'],
    slots: [{ start_time: '08:00', end_time: '08:40' }, { start_time: '20:00', end_time: '20:40' }],
    series: LESSON_SERIES, // Math, History, Biology
  });
  assert.equal(created.status, 201);
  templateId = created.data.id;

  const tpl = (await j('GET', '/api/blocks/templates')).data.find((t) => t.id === templateId);
  assert.equal(tpl.weekdays, 'Mon,Tue');
  assert.equal(tpl.slots.length, 2);
  assert.deepEqual(tpl.series.map((s) => s.subject), LESSON_SERIES);
});

test('generation: greedy series cycling, strict mirror airings, cross-day progression', async () => {
  const gen = await j('POST', '/api/blocks/generate?weekStart=2026-07-20'); // Monday
  assert.equal(gen.status, 200);
  // 2 weekdays (Mon, Tue) x 2 airings = 4 blocks.
  assert.equal(gen.data.results.length, 4);

  const view = (await j('GET', '/api/blocks?week=2026-07-20')).data;
  const mon = view.blocks.filter((b) => b.target_date === '2026-07-20');
  const tue = view.blocks.filter((b) => b.target_date === '2026-07-21');
  assert.equal(mon.length, 2);
  assert.equal(tue.length, 2);

  const monPrimary = mon.find((b) => !b.is_mirror);
  const monMirror = mon.find((b) => b.is_mirror);
  assert.ok(monPrimary && monMirror);
  assert.ok(mon.every((b) => b.fits), 'both Monday airings fit');

  const pItems = (await j('GET', `/api/blocks/${monPrimary.id}`)).data.items;
  const mItems = (await j('GET', `/api/blocks/${monMirror.id}`)).data.items;
  // Strict mirror: identical resources in identical order.
  assert.deepEqual(mItems.map((i) => i.resource_id), pItems.map((i) => i.resource_id));

  // Greedy cycle: first three main items are Math1, History1, Biology1.
  const main = pItems.filter((i) => !i.is_filler);
  assert.deepEqual(main.slice(0, 3).map((i) => `${i.subject}${i.chapter}`), ['Math1', 'History1', 'Biology1']);

  // Cross-day progression: Tuesday's Math continues past Monday's highest Math chapter.
  const tuePrimary = tue.find((b) => !b.is_mirror);
  const tueMain = (await j('GET', `/api/blocks/${tuePrimary.id}`)).data.items.filter((i) => !i.is_filler);
  const monMaxMath = Math.max(...main.filter((i) => i.subject === 'Math').map((i) => i.chapter));
  const tueMinMath = Math.min(...tueMain.filter((i) => i.subject === 'Math').map((i) => i.chapter));
  assert.equal(tueMinMath, monMaxMath + 1, 'Math rolls forward day to day');
});

test('mirror airings are read-only; primary edits + tolerance 409 guard', async () => {
  const view = (await j('GET', '/api/blocks?week=2026-07-20')).data;
  const primary = view.blocks.find((b) => b.target_date === '2026-07-20' && !b.is_mirror);
  const mirror = view.blocks.find((b) => b.target_date === '2026-07-20' && b.is_mirror);

  // Editing a mirror airing directly is rejected.
  const mirrorEdit = await j('PUT', `/api/blocks/${mirror.id}/items`, { items: [] });
  assert.equal(mirrorEdit.status, 409, 'mirror is not directly editable');

  // Reorder the primary then approve -> 200.
  const detail = (await j('GET', `/api/blocks/${primary.id}`)).data;
  const items = detail.items.map((i) => ({ resource_id: i.resource_id })).reverse();
  const put = await j('PUT', `/api/blocks/${primary.id}/items`, { items });
  assert.equal(put.status, 200);
  assert.ok(put.data.fits);
  const ok = await j('POST', `/api/blocks/${primary.id}/approve`);
  assert.equal(ok.status, 200);

  // Force an overrun: pack more lessons than the 40-minute slot holds.
  const lessons = (await j('GET', '/api/resources?subject=Math')).data;
  const bad = await j('PUT', `/api/blocks/${primary.id}/items`, {
    items: lessons.slice(0, 5).map((r) => ({ resource_id: r.id })), // 5 x 600 = 3000s > 2400s
  });
  assert.ok(bad.data.overrun, 'edit reported as overrun');
  const blocked = await j('POST', `/api/blocks/${primary.id}/approve`);
  assert.equal(blocked.status, 409, 'out-of-tolerance approval is blocked');

  await j('POST', `/api/blocks/${primary.id}/regenerate`); // back to fitting
});

test('approve-week then push to fake OTAV marks blocks exported', async () => {
  const wk = await j('POST', '/api/blocks/approve-week?week=2026-07-20');
  assert.equal(wk.status, 200);
  assert.ok(wk.data.approved.length >= 2);

  const push = await j('POST', '/api/otav/push?date=2026-07-20');
  assert.equal(push.status, 200);
  const ch1 = push.data.channels[0];
  assert.ok(ch1.ok, `push ok: ${ch1.error || ''}`);
  assert.ok(ch1.pushed > 0, 'clips were pushed');

  assert.ok(fakeOtav.state.authorized >= 1);
  assert.ok(fakeOtav.state.cleared >= 1);
  assert.equal(fakeOtav.state.received[0].clip_type, 0);

  const exported = db.prepare("SELECT COUNT(*) n FROM ScheduledBlock WHERE status='exported' AND target_date='2026-07-20'").get();
  assert.ok(exported.n > 0);
});

test('OTAV connectivity check hits /info', async () => {
  const chId = (await j('GET', '/api/channels')).data[0].id;
  const r = await j('GET', `/api/otav/check/${chId}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.info.application_version, '4.2');
});

test('media routes: status, mount-guard, and browse boundary', async () => {
  const st = await j('GET', '/api/media/status');
  assert.ok('mounted' in st.data);
  const outside = await j('POST', '/api/media/roots', { channel_id: 1, show_type_id: 1, path: '/etc' });
  assert.equal(outside.status, 400);
  const browse = await j('GET', '/api/media/browse?path=/etc/passwd');
  assert.equal(browse.status, 400);
});

test('weekly cron entrypoint runs', async () => {
  const results = runWeeklyDraft();
  assert.ok(Array.isArray(results));
});

// ---- New feature coverage --------------------------------------------------

test('filler auto-detection: Filler(s) folder + under 15 min, regardless of show type', async () => {
  const chId = (await j('GET', '/api/channels')).data[0].id;
  // A non-filler (documentaries) root that happens to contain a "Fillers" subfolder.
  mkdirSync(join(mediaDir, 'docs', 'Fillers'), { recursive: true });
  writeFileSync(join(mediaDir, 'docs', 'Fillers', 'bumper_60.mov'), 'x');   // 60s  -> filler
  writeFileSync(join(mediaDir, 'docs', 'Fillers', 'promo_899.mov'), 'x');   // 899s -> filler (< 900)
  writeFileSync(join(mediaDir, 'docs', 'Fillers', 'special_1200.mov'), 'x'); // 1200s -> filler (no cap)
  writeFileSync(join(mediaDir, 'docs', 'Doc1_1800.mov'), 'x');               // outside Fillers -> not filler
  const rootId = db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
    .run(chId, stId('documentaries'), join(mediaDir, 'docs')).lastInsertRowid;
  const scan = await j('POST', `/api/media/roots/${rootId}/scan`);
  assert.equal(scan.status, 200);

  const byName = (n) => (db.prepare('SELECT * FROM Resource WHERE channel_id=? AND name=?').get(chId, n));
  assert.equal(byName('bumper_60').is_filler, 1, 'short clip in Fillers folder is a filler');
  assert.equal(byName('promo_899').is_filler, 1, 'sub-15-min clip in Fillers folder is a filler');
  assert.equal(byName('special_1200').is_filler, 1, 'clip in Fillers folder is a filler regardless of length');
  assert.equal(byName('Doc1_1800').is_filler, 0, 'clip outside a Fillers folder is not a filler');
});

test('unbounded filler fill reaches near-exact (repeats allowed)', () => {
  const chId = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  // With the seeded coarse filler pool, filling 1000s to within tolerance is only
  // possible if fillers may repeat (subset-sum with each filler once tops out far short).
  const fit = fitFillers(chId, 1000);
  assert.ok(fit.total >= 995 && fit.total <= 1000, `filled ${fit.total}/1000 within 0..5s underrun`);
  assert.ok(fit.items.length > new Set(fit.items.map((i) => i.id)).size || fit.items.length >= 9,
    'fill reused fillers (or drew the whole pool) to close the gap');
});

let ch2Id;
test('shared folder: the same files catalog independently under a second channel', async () => {
  const ch = await j('POST', '/api/channels', { name: 'Channel 2', api_ip: '127.0.0.1', api_port: fakeOtav.port });
  assert.equal(ch.status, 201);
  ch2Id = ch.data.id;
  // Assign the SAME lessons + fillers folders to channel 2 (shared folder).
  for (const code of ['lessons', 'fillers']) {
    const dir = code === 'lessons' ? 'lessons' : 'fillers';
    const rid = db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
      .run(ch2Id, stId(code), join(mediaDir, dir)).lastInsertRowid;
    const scan = await j('POST', `/api/media/roots/${rid}/scan`);
    assert.equal(scan.status, 200);
  }
  db.exec('UPDATE Resource SET approved = 1'); // operator-approved after review
  // Channel 2 has its own Math chapters (same file_path as channel 1, distinct rows).
  const ch2Math = (await j('GET', `/api/resources?channel_id=${ch2Id}&subject=Math`)).data;
  assert.equal(ch2Math.length, 6, 'channel 2 cataloged its own copy of Math');
  const dup = db.prepare('SELECT COUNT(*) c FROM Resource WHERE file_path = (SELECT file_path FROM Resource WHERE channel_id=? AND subject=? LIMIT 1)')
    .get(ch2Id, 'Math').c;
  assert.ok(dup >= 2, 'same file_path exists under both channels (composite unique)');
});

test('multi-channel template generates independent blocks per channel', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  // Register + activate Math on channel 2 so it has content to pick.
  await j('PUT', `/api/channels/${ch2Id}/series`, { series: [{ subject: 'Math', play_order: 0, is_serial: 1, is_active: 1, show_type_id: stId('lessons') }] });
  const created = await j('POST', '/api/blocks/templates', {
    channels: [c1, ch2Id],
    name: 'Shared Morning',
    weekdays: ['Wed'],
    slots: [{ start_time: '09:00', end_time: '09:30' }],
    series: ['Math'],
  });
  assert.equal(created.status, 201);
  const tpl = (await j('GET', '/api/blocks/templates')).data.find((t) => t.id === created.data.id);
  assert.deepEqual([...tpl.channels].sort((a, b) => a - b), [c1, ch2Id].sort((a, b) => a - b));

  const gen = await j('POST', '/api/blocks/generate?weekStart=2026-08-10'); // a Monday; Wed = 08-12
  assert.equal(gen.status, 200);
  const view = (await j('GET', '/api/blocks?week=2026-08-10')).data;
  const wed = view.blocks.filter((b) => b.target_date === '2026-08-12' && b.template_name === 'Shared Morning');
  const channelsWithBlock = new Set(wed.map((b) => b.channel_id));
  assert.ok(channelsWithBlock.has(c1) && channelsWithBlock.has(ch2Id), 'both channels got their own block');

  // Channel-filtered view returns only that channel's blocks.
  const only2 = (await j('GET', `/api/blocks?week=2026-08-10&channel_id=${ch2Id}`)).data;
  assert.ok(only2.blocks.every((b) => b.channel_id === ch2Id), 'channel filter is respected');
});

test('series cursor: nudge persists and sets the next episode', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const set = await j('PUT', `/api/channels/${c1}/series/${encodeURIComponent('History')}/cursor`, { chapter: 4 });
  assert.equal(set.status, 200);
  assert.equal(set.data.cursor, 4);
  const got = (await j('GET', `/api/channels/${c1}/series/${encodeURIComponent('History')}/cursor`)).data;
  assert.equal(got.cursor, 4, 'cursor persisted');
  // Rewind by 1.
  const down = await j('POST', `/api/channels/${c1}/series/${encodeURIComponent('History')}/cursor`, { delta: -1 });
  assert.equal(down.data.cursor, 3);
  // Clamped to the series range (1..6).
  const clamp = await j('POST', `/api/channels/${c1}/series/${encodeURIComponent('History')}/cursor`, { delta: 99 });
  assert.equal(clamp.data.cursor, 6, 'clamped to highest chapter');
});

test('deleting a media root drops its cataloged resources', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  // The documentaries root created earlier owns the docs/* resources.
  const root = db.prepare("SELECT * FROM MediaRoot WHERE channel_id=? AND show_type_id=?").get(c1, stId('documentaries'));
  const before = db.prepare('SELECT COUNT(*) c FROM Resource WHERE channel_id=? AND show_type_id=?').get(c1, stId('documentaries')).c;
  assert.ok(before > 0, 'docs resources exist before delete');
  const del = await j('DELETE', `/api/media/roots/${root.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deletedResources, before, 'reported count matches');
  const after = db.prepare('SELECT COUNT(*) c FROM Resource WHERE channel_id=? AND show_type_id=?').get(c1, stId('documentaries')).c;
  assert.equal(after, 0, 'all docs resources dropped on root delete');
  // Lessons/movies/fillers survive (different show type).
  assert.ok(db.prepare('SELECT COUNT(*) c FROM Resource WHERE channel_id=? AND subject=?').get(c1, 'Math').c === 6, 'unrelated resources untouched');
});

// ---- Newer feature coverage ------------------------------------------------

test('spreadFillers distributes fillers before, between, and after main items', () => {
  const main = [{ id: 'M1' }, { id: 'M2' }, { id: 'M3' }];
  const fillers = [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4' }];
  const out = spreadFillers(main, fillers).map((r) => r.id);
  // 4 fillers over 4 gaps → one per gap: f, M1, f, M2, f, M3, f
  assert.deepEqual(out, ['f1', 'M1', 'f2', 'M2', 'f3', 'M3', 'f4']);
  // A leading filler (before the first main) and a trailing filler (after last).
  assert.ok(out[0].startsWith('f'), 'a filler leads the block');
  assert.ok(out[out.length - 1].startsWith('f'), 'a filler trails the block');
  // Main order and filler order are both preserved.
  assert.deepEqual(out.filter((x) => x[0] === 'M'), ['M1', 'M2', 'M3']);
  assert.deepEqual(out.filter((x) => x[0] === 'f'), ['f1', 'f2', 'f3', 'f4']);
  // Even split across gaps (2 main → 3 gaps), one filler each.
  const out2 = spreadFillers([{ id: 'M1' }, { id: 'M2' }], [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }]).map((r) => r.id);
  assert.deepEqual(out2, ['f1', 'M1', 'f2', 'M2', 'f3']);
  // Remainder goes to the leading gaps: 4 fillers → 3 gaps = [2,1,1].
  const out3 = spreadFillers([{ id: 'M1' }, { id: 'M2' }], [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }, { id: 'f4' }]).map((r) => r.id);
  assert.deepEqual(out3, ['f1', 'f2', 'M1', 'f3', 'M2', 'f4']);
  // Degenerate cases.
  assert.deepEqual(spreadFillers([], [{ id: 'f1' }]).map((r) => r.id), ['f1']);
  assert.deepEqual(spreadFillers([{ id: 'M1' }], []).map((r) => r.id), ['M1']);
});

test('populated block interleaves fillers around main content', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const gen = await j('POST', '/api/blocks/generate?weekStart=2026-10-05'); // Monday
  assert.equal(gen.status, 200);
  const view = (await j('GET', '/api/blocks?week=2026-10-05')).data;
  const primary = view.blocks.find((b) => b.channel_id === c1 && !b.is_mirror && b.template_name === 'Morning Lessons');
  assert.ok(primary, 'a lessons block was generated');
  const items = (await j('GET', `/api/blocks/${primary.id}`)).data.items;
  const fillerIdx = items.map((it, i) => (it.is_filler ? i : -1)).filter((i) => i >= 0);
  const mainIdx = items.map((it, i) => (!it.is_filler ? i : -1)).filter((i) => i >= 0);
  if (fillerIdx.length && mainIdx.length) {
    // At least one filler sits before the last main item (i.e. not all clumped at the tail).
    assert.ok(fillerIdx.some((f) => f < Math.max(...mainIdx)), 'fillers are not all at the end');
  }
});

test('clone on re-add: a scanned folder assigned to a new channel needs no re-scan', async () => {
  const ch = await j('POST', '/api/channels', { name: 'Channel 3', api_ip: '127.0.0.1', api_port: fakeOtav.port });
  const ch3 = ch.data.id;
  const lessonsPath = join(mediaDir, 'lessons');
  // Simulate the POST /roots assignment path: register the root, then clone.
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)').run(ch3, stId('lessons'), lessonsPath);
  const cloned = cloneScannedResources(ch3, stId('lessons'), lessonsPath);
  db.exec('UPDATE Resource SET approved = 1'); // operator-approved after review
  assert.ok(cloned >= 18, `cloned all lesson chapters (${cloned})`);
  const ch3Math = (await j('GET', `/api/resources?channel_id=${ch3}&subject=Math`)).data;
  assert.equal(ch3Math.length, 6, 'channel 3 has Math without a fresh ffprobe scan');
  // Series registered for the new channel too.
  const reg = (await j('GET', `/api/channels/${ch3}/series`)).data.map((s) => s.subject).sort();
  assert.ok(reg.includes('Math') && reg.includes('History') && reg.includes('Biology'));
});

test('latestEpisode returns the newest-added episode, not the highest chapter', () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const ins = db.prepare(`INSERT INTO Resource (name, file_path, duration, subject, chapter, is_filler, approved, channel_id, show_type_id, added_at)
    VALUES (?, ?, 600, 'TVNews', ?, 0, 1, ?, ?, ?)`);
  // Chapter 1 is the most recently added; chapter 3 is the oldest.
  ins.run('news1', '/tv/news1.mov', 1, c1, stId('tv_shows'), '2026-03-03T00:00:00.000Z');
  ins.run('news2', '/tv/news2.mov', 2, c1, stId('tv_shows'), '2026-02-02T00:00:00.000Z');
  ins.run('news3', '/tv/news3.mov', 3, c1, stId('tv_shows'), '2026-01-01T00:00:00.000Z');
  const pick = latestEpisode(c1, 'TVNews');
  assert.equal(pick.chapter, 1, 'newest added_at wins over highest chapter');
});

test('catalog editor: display-name override is non-destructive and resettable', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const cat = (await j('GET', `/api/catalog?channel_id=${c1}`)).data;
  const math = cat.groups.flatMap((g) => g.shows).find((s) => s.subject === 'Math');
  assert.ok(math, 'Math show present in catalog');
  const ep = math.episodes[0];
  const serverName = db.prepare('SELECT name FROM Resource WHERE id=?').get(ep.id).name;

  const put = await j('PUT', `/api/catalog/resource/${ep.id}`, { display_name: 'Álgebra — Clase 1' });
  assert.equal(put.status, 200);
  const cat2 = (await j('GET', `/api/catalog?channel_id=${c1}`)).data;
  const ep2 = cat2.groups.flatMap((g) => g.shows).find((s) => s.subject === 'Math').episodes.find((e) => e.id === ep.id);
  assert.equal(ep2.display_name, 'Álgebra — Clase 1', 'display name overridden');
  assert.equal(ep2.has_override, true);
  assert.equal(db.prepare('SELECT name FROM Resource WHERE id=?').get(ep.id).name, serverName, 'server name untouched');

  const reset = await j('POST', '/api/catalog/reset', { ids: [ep.id] });
  assert.equal(reset.status, 200);
  const cat3 = (await j('GET', `/api/catalog?channel_id=${c1}`)).data;
  const ep3 = cat3.groups.flatMap((g) => g.shows).find((s) => s.subject === 'Math').episodes.find((e) => e.id === ep.id);
  assert.equal(ep3.display_name, serverName, 'reset falls back to server name');
  assert.equal(ep3.has_override, false);
});

test('catalog editor: bulk merge + renumber gathers clips into one continuous show', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const bio = (await j('GET', `/api/resources?channel_id=${c1}&subject=Biology`)).data.sort((a, b) => a.chapter - b.chapter);
  const ids = bio.map((r) => r.id);
  const merge = await j('POST', '/api/catalog/bulk', { ids, op: 'set-subject', subject: 'Life Sciences' });
  assert.equal(merge.status, 200, JSON.stringify(merge.data));
  const renum = await j('POST', '/api/catalog/bulk', { ids, op: 'renumber' });
  assert.equal(renum.status, 200);
  const merged = (await j('GET', `/api/resources?channel_id=${c1}&subject=${encodeURIComponent('Life Sciences')}`)).data
    .sort((a, b) => a.chapter - b.chapter);
  assert.equal(merged.length, ids.length, 'all clips moved under the new show');
  assert.deepEqual(merged.map((r) => r.chapter), merged.map((_, i) => i + 1), 'chapters are 1..N');
  // The new show is registered in the channel series registry.
  const reg = (await j('GET', `/api/channels/${c1}/series`)).data.map((s) => s.subject);
  assert.ok(reg.includes('Life Sciences'));
});

test('catalog editor: GET includes file_path, set-chapters fixes order, DELETE removes a clip', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const cat = (await j('GET', `/api/catalog?channel_id=${c1}`)).data;
  const someEp = cat.groups.flatMap((g) => g.shows).flatMap((s) => s.episodes)[0];
  assert.ok(someEp.file_path && someEp.file_path.includes('/'), 'episodes carry file_path for the browser tree');

  // Fix order: assign explicit chapters to two Math clips (reversed).
  const math = (await j('GET', `/api/resources?channel_id=${c1}&subject=Math`)).data.sort((a, b) => a.chapter - b.chapter);
  const [a, b] = math;
  const entries = [{ id: a.id, chapter: 50 }, { id: b.id, chapter: 40 }];
  const fix = await j('POST', '/api/catalog/bulk', { ids: entries.map((e) => e.id), op: 'set-chapters', entries });
  assert.equal(fix.status, 200);
  assert.equal(db.prepare('SELECT chapter FROM Resource WHERE id=?').get(a.id).chapter, 50);
  assert.equal(db.prepare('SELECT chapter FROM Resource WHERE id=?').get(b.id).chapter, 40);

  // Delete a clip (duplicate case) — DB row gone, file untouched (nothing to check on disk).
  const before = db.prepare('SELECT COUNT(*) c FROM Resource WHERE channel_id=? AND subject=?').get(c1, 'Math').c;
  const del = await j('DELETE', `/api/catalog/resource/${a.id}`);
  assert.equal(del.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM Resource WHERE id=?').get(a.id).c, 0, 'resource row removed');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM Resource WHERE channel_id=? AND subject=?').get(c1, 'Math').c, before - 1);
  const del404 = await j('DELETE', `/api/catalog/resource/${a.id}`);
  assert.equal(del404.status, 404, 'deleting a missing clip is a 404');
});

test('catalog editor: mark/unmark filler toggles is_filler and drops series on mark', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const hist = (await j('GET', `/api/resources?channel_id=${c1}&subject=History`)).data.slice(0, 2);
  const ids = hist.map((r) => r.id);
  assert.ok(ids.length === 2, 'have two History clips to mark');

  const mark = await j('POST', '/api/catalog/bulk', { ids, op: 'set-filler', is_filler: 1 });
  assert.equal(mark.status, 200);
  for (const id of ids) {
    const r = db.prepare('SELECT is_filler, subject, chapter FROM Resource WHERE id=?').get(id);
    assert.equal(r.is_filler, 1, 'now a filler');
    assert.equal(r.subject, null, 'series dropped when marked filler');
    assert.equal(r.chapter, 0, 'chapter cleared when marked filler');
  }
  const unmark = await j('POST', '/api/catalog/bulk', { ids, op: 'set-filler', is_filler: 0 });
  assert.equal(unmark.status, 200);
  assert.equal(db.prepare('SELECT is_filler FROM Resource WHERE id=?').get(ids[0]).is_filler, 0, 'unmarked back to normal content');
});

test('set-episode: correct an episode from the schedule view, propagate cursor + later drafts', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const gen = await j('POST', '/api/blocks/generate?weekStart=2026-11-02'); // Monday
  assert.equal(gen.status, 200);
  const view = (await j('GET', '/api/blocks?week=2026-11-02')).data;
  const mon = view.blocks.find((b) => b.channel_id === c1 && !b.is_mirror && b.target_date === '2026-11-02' && b.template_name === 'Morning Lessons');
  assert.ok(mon, 'Monday lessons draft exists');
  const detail = (await j('GET', `/api/blocks/${mon.id}`)).data;
  const mathItem = detail.items.find((it) => it.subject === 'Math');
  assert.ok(mathItem, 'block has a Math item');

  const targetCh = 3;
  const targetRes = db.prepare('SELECT id FROM Resource WHERE channel_id=? AND subject=? AND chapter=?').get(c1, 'Math', targetCh);
  const set = await j('POST', `/api/blocks/${mon.id}/items/${mathItem.id}/set-episode`, { chapter: targetCh });
  assert.equal(set.status, 200, JSON.stringify(set.data));

  // Calibration rebuilds the block from the cursor rather than pinning one item:
  // the block's first Math clip is now the chosen chapter, freshly generated.
  const afterItems = (await j('GET', `/api/blocks/${mon.id}`)).data.items;
  const firstMath = afterItems.find((it) => it.subject === 'Math');
  assert.ok(firstMath, 'block still has a Math item after rebuild');
  assert.equal(firstMath.resource_id, targetRes.id, 'first Math clip is the chosen chapter');
  assert.equal(firstMath.is_manual_override, 0, 'rebuilt item is not a manual pin');
  const cursor = (await j('GET', `/api/channels/${c1}/series/${encodeURIComponent('Math')}/cursor`)).data;
  assert.equal(cursor.cursor, targetCh, 'series cursor moved to the corrected episode');
  // Tuesday's still-draft block was regenerated and still fits.
  const tue = (await j('GET', '/api/blocks?week=2026-11-02')).data.blocks
    .find((b) => b.channel_id === c1 && !b.is_mirror && b.target_date === '2026-11-03' && b.template_name === 'Morning Lessons');
  if (tue) assert.ok(tue.fits, 'later draft still fits after regeneration');
});

test('approval gate: only approved resources reach the scheduler', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const fillerIds = db.prepare('SELECT id FROM Resource WHERE channel_id=? AND is_filler=1').all(c1).map((r) => r.id);
  assert.ok(fillerIds.length, 'channel has fillers');

  // Un-approve every filler → the fitter has nothing available to place.
  const off = await j('POST', '/api/catalog/bulk', { ids: fillerIds, op: 'set-approved', approved: 0 });
  assert.equal(off.status, 200);
  const none = fitFillers(c1, 1000);
  assert.equal(none.items.length, 0, 'unapproved fillers are invisible to the fitter');

  // The catalog GET reflects the approval flag (drives the UI badges).
  const cat = (await j('GET', `/api/catalog?channel_id=${c1}`)).data;
  const aFiller = cat.groups.flatMap((g) => g.shows).flatMap((s) => s.episodes).find((e) => e.is_filler);
  assert.equal(aFiller.approved, false, 'GET exposes approved:false');
  // set-approved must not create a spurious "edited" override.
  assert.equal(aFiller.has_override, false, 'approval toggle does not mark the clip edited');

  // Re-approve → placeable again (restores state for any later tests).
  const on = await j('POST', '/api/catalog/bulk', { ids: fillerIds, op: 'set-approved', approved: 1 });
  assert.equal(on.status, 200);
  const some = fitFillers(c1, 1000);
  assert.ok(some.items.length > 0, 're-approved fillers are placeable again');
});

test('seasonal detection: seasons parsed into a folder level + exposed with rel_dirs', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  // A multi-season show, one show folder with SxxEyy episodes across two seasons.
  const dir = join(mediaDir, 'tvshows', 'Cosmos');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Cosmos_S01E01_600.mov'), 'x');
  writeFileSync(join(dir, 'Cosmos_S02E01_600.mov'), 'x');
  writeFileSync(join(dir, 'Cosmos_S02E02_600.mov'), 'x');
  db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
    .run(c1, stId('tv_shows'), join(mediaDir, 'tvshows'));
  const root = (await j('GET', '/api/media/roots')).data.find((r) => r.path === join(mediaDir, 'tvshows'));
  await j('POST', `/api/media/roots/${root.id}/scan`);
  db.exec('UPDATE Resource SET approved = 1');

  const cat = (await j('GET', `/api/catalog?channel_id=${c1}`)).data;
  const cosmos = cat.groups.flatMap((g) => g.shows).find((s) => s.subject === 'Cosmos');
  assert.ok(cosmos, 'Cosmos show present in the catalog');
  const seasons = [...new Set(cosmos.episodes.map((e) => e.season))].sort();
  assert.deepEqual(seasons, [1, 2], 'two season folders detected from the filenames');
  const s2e2 = cosmos.episodes.find((e) => e.name.includes('S02E02'));
  assert.equal(s2e2.season, 2, 'season parsed');
  assert.equal(s2e2.chapter, 2002, 'season-2 episode encoded for global play order');
  assert.deepEqual(s2e2.rel_dirs, ['Cosmos'], 'rel_dirs mirrors the on-disk folder (Library browser)');
});

test('catalog editor: assign-to-show, set-season, and reset round-trip', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const movieIds = db.prepare("SELECT id FROM Resource WHERE channel_id=? AND subject='movies'").all(c1).map((r) => r.id);
  assert.equal(movieIds.length, 4, 'four standalone movies to file under a show');

  // Drag-a-folder-onto-a-show: subject set, season/order re-derived (season-less
  // movie names stay season-less).
  const assign = await j('POST', '/api/catalog/bulk', { ids: movieIds, op: 'assign-to-show', subject: 'Retro Cinema' });
  assert.equal(assign.status, 200);
  for (const id of movieIds) {
    const r = db.prepare('SELECT subject, season FROM Resource WHERE id=?').get(id);
    assert.equal(r.subject, 'Retro Cinema');
    assert.equal(r.season, null, 'season-less movies get no season folder');
  }
  const reg = (await j('GET', `/api/channels/${c1}/series`)).data.find((s) => s.subject === 'Retro Cinema');
  assert.ok(reg, 'assign-to-show registers the new show as a series');

  // set-season files them explicitly into Season 1.
  const setS = await j('POST', '/api/catalog/bulk', { ids: movieIds, op: 'set-season', season: 1 });
  assert.equal(setS.status, 200);
  assert.equal(db.prepare('SELECT season FROM Resource WHERE id=?').get(movieIds[0]).season, 1);

  // Reset restores the snapshot taken at the first edit (subject 'movies', no season).
  const reset = await j('POST', '/api/catalog/reset', { ids: movieIds });
  assert.equal(reset.status, 200);
  const back = db.prepare('SELECT subject, season FROM Resource WHERE id=?').get(movieIds[0]);
  assert.equal(back.subject, 'movies', 'reset restores detected subject');
  assert.equal(back.season, null, 'reset restores detected (null) season');
});

test('merge season-as-show: forced season rides into chapter and the empty source registry row is removable', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  // A show whose episodes carry no season marker in the filename (season came
  // from a folder), sitting under its own subject — the "season detected as a
  // whole show" case. Two clips, plain episode numbers 1 and 2.
  db.prepare(`INSERT INTO Resource (name, file_path, duration, subject, season, chapter, is_filler, channel_id, show_type_id, approved, added_at)
              VALUES ('Episode 1','/m/GoodShow S3/Episode 1.mov',600,'GoodShow Season 3',NULL,1,0,?,?,1,'2026-01-01T00:00:00Z')`).run(c1, stId('tv_shows'));
  db.prepare(`INSERT INTO Resource (name, file_path, duration, subject, season, chapter, is_filler, channel_id, show_type_id, approved, added_at)
              VALUES ('Episode 2','/m/GoodShow S3/Episode 2.mov',600,'GoodShow Season 3',NULL,2,0,?,?,1,'2026-01-01T00:00:00Z')`).run(c1, stId('tv_shows'));
  db.prepare(`INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
              VALUES (?, 'GoodShow Season 3', ?, 1, 1, 50)`).run(c1, stId('tv_shows'));
  const ids = db.prepare("SELECT id FROM Resource WHERE channel_id=? AND subject='GoodShow Season 3' ORDER BY chapter").all(c1).map((r) => r.id);
  assert.equal(ids.length, 2);

  // Merge into the real parent as Season 3. The forced season must be encoded
  // into chapter (3000 + episode) so it can't collide with the parent's season 1.
  const merge = await j('POST', '/api/catalog/bulk', { ids, op: 'assign-to-show', subject: 'GoodShow', season: 3 });
  assert.equal(merge.status, 200);
  const rows = db.prepare("SELECT season, chapter FROM Resource WHERE id IN (?,?) ORDER BY chapter").all(...ids);
  assert.deepEqual(rows.map((r) => r.season), [3, 3], 'both filed under the forced season');
  assert.deepEqual(rows.map((r) => r.chapter), [3001, 3002], 'season encoded into chapter for global order');

  // The old source series lingers in the registry until cleaned up.
  const before = (await j('GET', `/api/channels/${c1}/series`)).data.map((s) => s.subject);
  assert.ok(before.includes('GoodShow Season 3'), 'orphan registry row still present after merge');

  // DELETE removes it now that no clip uses the subject.
  const del = await j('DELETE', `/api/channels/${c1}/series/${encodeURIComponent('GoodShow Season 3')}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, 1);
  const after = (await j('GET', `/api/channels/${c1}/series`)).data.map((s) => s.subject);
  assert.ok(!after.includes('GoodShow Season 3'), 'orphan registry row gone');
  assert.ok(after.includes('GoodShow'), 'parent show remains registered');
});

test('series delete refuses while clips still use the subject', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const inUse = await j('DELETE', `/api/channels/${c1}/series/${encodeURIComponent('History')}`);
  assert.equal(inUse.status, 409, 'cannot delete a series that still has clips');
  const reg = (await j('GET', `/api/channels/${c1}/series`)).data.map((s) => s.subject);
  assert.ok(reg.includes('History'), 'in-use series untouched');
});

test('quarter-hour alignment: main content starts on :00/:15/:30/:45 marks', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const gen = await j('POST', '/api/blocks/generate?weekStart=2026-12-07'); // Monday
  assert.equal(gen.status, 200);
  const view = (await j('GET', '/api/blocks?week=2026-12-07')).data;
  const primary = view.blocks.find((b) => b.channel_id === c1 && !b.is_mirror && b.template_name === 'Morning Lessons');
  assert.ok(primary, 'a lessons block exists');
  assert.equal(primary.start_time, '08:00', 'block starts on the hour');

  const items = (await j('GET', `/api/blocks/${primary.id}`)).data.items;
  // Walk durations; every MAIN item must begin on a 15-minute clock boundary.
  let offset = 0;
  const mainOffsets = [];
  for (const it of items) {
    if (!it.is_filler) mainOffsets.push(offset);
    offset += it.duration;
  }
  assert.ok(mainOffsets.length >= 2, 'block has multiple main items');
  for (const off of mainOffsets) {
    assert.equal(off % 900, 0, `main item at offset ${off}s lands on a quarter-hour mark`);
  }
});

test('regenerate always wipes drafts and rebuilds from scratch', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  await j('POST', '/api/blocks/generate?weekStart=2026-12-14'); // Monday
  const before = (await j('GET', '/api/blocks?week=2026-12-14')).data.blocks;
  const primary = before.find((b) => b.channel_id === c1 && !b.is_mirror && b.template_name === 'Morning Lessons');
  assert.ok(primary, 'a draft block exists');

  // Inject a manual override item, then regenerate the week.
  const detail = (await j('GET', `/api/blocks/${primary.id}`)).data;
  const anExtra = detail.items[0].resource_id;
  const withManual = detail.items.map((i) => ({ resource_id: i.resource_id }))
    .concat([{ resource_id: anExtra, is_manual_override: 1 }]);
  await j('PUT', `/api/blocks/${primary.id}/items`, { items: withManual });

  const regen = await j('POST', '/api/blocks/generate?weekStart=2026-12-14');
  assert.equal(regen.status, 200);
  const after = (await j('GET', '/api/blocks?week=2026-12-14')).data.blocks;
  // Same number of blocks (wipe+recreate, not duplicated).
  assert.equal(after.length, before.length, 'block count is stable across regenerate');
  // The rebuilt block has no manual override lingering.
  const rebuilt = after.find((b) => b.channel_id === c1 && !b.is_mirror && b.template_name === 'Morning Lessons');
  const rebuiltItems = (await j('GET', `/api/blocks/${rebuilt.id}`)).data.items;
  assert.ok(rebuiltItems.every((i) => i.is_manual_override === 0), 'manual overrides wiped on regenerate');
});

test('export: printable schedule is HTML, excludes fillers, shows air times', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  await j('POST', `/api/blocks/generate?weekStart=2026-12-21&channel_id=${c1}`); // Monday, one channel
  const res = await fetch(base + `/api/blocks/export?week=2026-12-21&channel_id=${c1}`);
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/html'), 'served as HTML');
  const html = await res.text();
  assert.ok(html.includes('Air time'), 'has an air-time column');
  assert.ok(/Math|History|Biology/.test(html), 'lists main programming');
  // Filler clip names (f0_30, f1_45, ...) must not appear in the export.
  assert.ok(!/f\d+_\d+\.mov/.test(html) && !/>f\d+_/.test(html), 'fillers excluded from the export');
});

test('reset-cursors: next-ups go back to episode 1 and scheduling honours it', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const lo = db.prepare("SELECT MIN(chapter) AS lo FROM Resource WHERE channel_id=? AND subject='Math' AND is_filler=0").get(c1).lo;

  // Push Math's cursor forward, then reset all next-ups.
  await j('PUT', `/api/channels/${c1}/series/${encodeURIComponent('Math')}/cursor`, { chapter: 5 });
  const reset = await j('POST', `/api/channels/${c1}/series/reset-cursors`);
  assert.equal(reset.status, 200);
  assert.ok(reset.data.reset >= 3, 'reset several series');
  const cur = (await j('GET', `/api/channels/${c1}/series/${encodeURIComponent('Math')}/cursor`)).data;
  assert.equal(cur.cursor, lo, 'Math next-up is back to its first chapter');

  // Generate a clean, well-separated week — Math must start at episode 1 even
  // though earlier weeks aired/scheduled higher chapters.
  await j('POST', `/api/blocks/generate?weekStart=2027-01-04&channel_id=${c1}`); // Monday
  const view = (await j('GET', `/api/blocks?week=2027-01-04&channel_id=${c1}`)).data;
  const mon = view.blocks.find((b) => !b.is_mirror && b.target_date === '2027-01-04' && b.template_name === 'Morning Lessons');
  assert.ok(mon, 'Monday lessons block generated');
  const firstMath = (await j('GET', `/api/blocks/${mon.id}`)).data.items.find((it) => it.subject === 'Math');
  assert.equal(firstMath.chapter, lo, 'scheduler selects episode 1 after a reset');
});

test('serial toggle overrides the TV rule: a serial TV show plays in order, not latest-added', async () => {
  const c1 = db.prepare("SELECT id FROM ChannelType WHERE name='Channel 1'").get().id;
  const tv = stId('tv_shows');
  const ins = db.prepare(`INSERT INTO Resource (name, file_path, duration, subject, chapter, is_filler, approved, channel_id, show_type_id, added_at)
    VALUES (?, ?, 600, 'SeqTV', ?, 0, 1, ?, ?, ?)`);
  ins.run('e1', '/seqtv/e1.mov', 1, c1, tv, '2026-01-01T00:00:00.000Z');
  ins.run('e2', '/seqtv/e2.mov', 2, c1, tv, '2026-02-01T00:00:00.000Z');
  ins.run('e3', '/seqtv/e3.mov', 3, c1, tv, '2026-03-01T00:00:00.000Z'); // newest → old TV rule would pick this on Sunday

  await j('PUT', `/api/channels/${c1}/series`, { series: [{ subject: 'SeqTV', is_serial: 1, is_active: 1, show_type_id: tv, play_order: 99 }] });
  await j('PUT', `/api/channels/${c1}/series/${encodeURIComponent('SeqTV')}/cursor`, { chapter: 1 });
  await j('POST', '/api/blocks/templates', {
    channels: [c1], name: 'Sunday Serial', weekdays: ['Sun'],
    slots: [{ start_time: '10:00', end_time: '10:30' }], series: ['SeqTV'],
  });

  await j('POST', '/api/blocks/generate?weekStart=2027-01-03'); // a Sunday
  const view = (await j('GET', '/api/blocks?week=2027-01-03')).data;
  const block = view.blocks.find((b) => b.channel_id === c1 && !b.is_mirror && b.template_name === 'Sunday Serial');
  assert.ok(block, 'Sunday Serial block generated');
  const seq = (await j('GET', `/api/blocks/${block.id}`)).data.items.filter((it) => it.subject === 'SeqTV');
  assert.ok(seq.length, 'block contains the serial TV show');
  assert.equal(seq[0].chapter, 1, 'serial TV show plays episode 1 (cursor), not the latest-added episode 3');
});
