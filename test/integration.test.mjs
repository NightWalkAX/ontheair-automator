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
const { router: media } = await import('../src/routes/media.js');
const { router: blocks } = await import('../src/routes/blocks.js');
const { router: otav } = await import('../src/routes/otav.js');
const { runWeeklyDraft } = await import('../src/cron/weeklyDraft.js');
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
