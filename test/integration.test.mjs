// End-to-end integration test against a fully faked environment:
//   - fake ffprobe (test/fake-ffprobe) supplies durations from filenames
//   - a fake OTAV REST server stands in for the 6 Softron instances
//   - a temp media tree stands in for the SMB mount
//
// It boots the real Express app (same routers as server.js) and drives the
// whole flow over HTTP: ingest -> tag -> generate -> review/edit -> approve
// (incl. the tolerance 409) -> push -> verify OTAV received the clips.

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
const { router: showtypes } = await import('../src/routes/showtypes.js');
const { router: resources } = await import('../src/routes/resources.js');
const { router: media } = await import('../src/routes/media.js');
const { router: blocks } = await import('../src/routes/blocks.js');
const { router: otav } = await import('../src/routes/otav.js');
const { runWeeklyDraft } = await import('../src/cron/weeklyDraft.js');
const { startFakeOtav } = await import('./fake-otav.mjs');

let server, base, fakeOtav, mediaDir;

// Media spec: filename encodes duration as its last number; subject/chapter/
// filler are applied afterwards to simulate admin tagging.
const MEDIA = [
  ...[1, 2, 3, 4, 5].map((c) => ({ dir: 'lessons', file: `math_${c}_1680.mov`, subject: 'Math', chapter: c, filler: 0 })),
  ...[5400, 6000, 5700, 4800].map((d, i) => ({ dir: 'movies', file: `movie_${i}_${d}.mov`, subject: 'Movies', chapter: 0, filler: 0 })),
  ...[1, 2, 3, 4].map((c) => ({ dir: 'tv', file: `tv_${c}_1500.mov`, subject: 'TV', chapter: c, filler: 0 })),
  ...[30, 45, 60, 90, 120, 300, 240, 15, 20, 10, 5].map((d, i) => ({ dir: 'fillers', file: `f_${i}_${d}.mov`, subject: 'Filler', chapter: 0, filler: 1 })),
];

async function j(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

before(async () => {
  initSchema();

  // Fake media tree.
  mediaDir = mkdtempSync(join(tmpdir(), 'otav-media-'));
  for (const m of MEDIA) {
    mkdirSync(join(mediaDir, m.dir), { recursive: true });
    writeFileSync(join(mediaDir, m.dir, m.file), 'x');
  }

  fakeOtav = await startFakeOtav({ requireAuth: true });

  const app = express();
  app.use(express.json());
  app.use('/api/channels', channels);
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

test('channels & show types CRUD', async () => {
  const ch = await j('POST', '/api/channels', {
    name: 'Channel 1', api_ip: '127.0.0.1', api_port: fakeOtav.port,
    playlist_ref: '0', api_username: 'admin', api_password: 'pw',
  });
  assert.equal(ch.status, 201);
  assert.ok(ch.data.id);

  for (const name of ['Lessons', 'Movies', 'Fillers']) {
    const r = await j('POST', '/api/showtypes', { name });
    assert.equal(r.status, 201);
  }
  const list = await j('GET', '/api/channels');
  assert.equal(list.data.length, 1);
});

test('ingestion via fake ffprobe + admin tagging', async () => {
  const chId = (await j('GET', '/api/channels')).data[0].id;
  const stId = (await j('GET', '/api/showtypes')).data[0].id;

  // Assign each subfolder as a MediaRoot (direct SQL: the HTTP assign route is
  // guarded to the real SMB mount point, tested separately below).
  const dirs = [...new Set(MEDIA.map((m) => m.dir))];
  for (const d of dirs) {
    db.prepare('INSERT INTO MediaRoot (channel_id, show_type_id, path) VALUES (?,?,?)')
      .run(chId, stId, join(mediaDir, d));
  }
  const roots = (await j('GET', '/api/media/roots')).data;
  assert.equal(roots.length, dirs.length);

  let ingested = 0;
  for (const r of roots) {
    const scan = await j('POST', `/api/media/roots/${r.id}/scan`);
    assert.equal(scan.status, 200);
    ingested += scan.data.ingested;
  }
  assert.equal(ingested, MEDIA.length, 'all fake media ingested with durations');

  // Verify a known duration came through the fake probe.
  const all = (await j('GET', '/api/resources')).data;
  const m0 = all.find((r) => basename(r.file_path) === 'movie_0_5400.mov');
  assert.equal(m0.duration, 5400);

  // Admin tagging: set subject/chapter/is_filler per the spec.
  const spec = Object.fromEntries(MEDIA.map((m) => [m.file, m]));
  for (const r of all) {
    const s = spec[basename(r.file_path)];
    const put = await j('PUT', `/api/resources/${r.id}`, {
      subject: s.subject, chapter: s.chapter, is_filler: s.filler,
    });
    assert.equal(put.status, 200);
  }
});

test('templates + week generation fit within tolerance', async () => {
  const chId = (await j('GET', '/api/channels')).data[0].id;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (const wd of days) {
    await j('POST', '/api/blocks/templates', { channel_id: chId, name: `${wd} Lesson`, weekday: wd, start_time: '08:00', end_time: '08:30', target_subject: 'Math', content_type: 'lesson_series' });
    await j('POST', '/api/blocks/templates', { channel_id: chId, name: `${wd} Movie`, weekday: wd, start_time: '20:00', end_time: '21:35', target_subject: 'Movies', content_type: 'movie' });
    await j('POST', '/api/blocks/templates', { channel_id: chId, name: `${wd} TV`, weekday: wd, start_time: '18:00', end_time: '18:30', target_subject: 'TV', content_type: 'tv_episode' });
  }

  const gen = await j('POST', '/api/blocks/generate?weekStart=2026-07-20'); // Monday
  assert.equal(gen.status, 200);
  assert.equal(gen.data.results.length, 21, '3 templates x 7 days');

  const view = await j('GET', '/api/blocks?week=2026-07-20');
  assert.equal(view.data.blocks.length, 21);
  const fitting = view.data.blocks.filter((b) => b.fits).length;
  assert.equal(fitting, 21, 'every block packs to within tolerance');
});

test('manual edit, reorder, and the tolerance approval guard (409 -> 200)', async () => {
  const view = await j('GET', '/api/blocks?week=2026-07-20');
  const movieBlock = view.data.blocks.find((b) => b.content_type === 'movie');
  const lessonBlock = view.data.blocks.find((b) => b.content_type === 'lesson_series');

  // Reorder a fitting block's items then approve -> 200.
  const detail = await j('GET', `/api/blocks/${lessonBlock.id}`);
  const items = detail.data.items.map((i) => ({ resource_id: i.resource_id })).reverse();
  const put = await j('PUT', `/api/blocks/${lessonBlock.id}/items`, { items });
  assert.equal(put.status, 200);
  assert.ok(put.data.fits);
  const ok = await j('POST', `/api/blocks/${lessonBlock.id}/approve`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, 'approved');

  // Force an overrun on the movie block: two full movies in one slot.
  const movies = (await j('GET', '/api/resources?subject=Movies')).data;
  const bad = await j('PUT', `/api/blocks/${movieBlock.id}/items`, {
    items: [{ resource_id: movies[0].id }, { resource_id: movies[1].id }],
  });
  assert.ok(bad.data.overrun, 'edit reported as overrun');
  const blocked = await j('POST', `/api/blocks/${movieBlock.id}/approve`);
  assert.equal(blocked.status, 409, 'out-of-tolerance approval is blocked');

  // Repopulate that block back to a fitting state.
  await j('POST', `/api/blocks/${movieBlock.id}/regenerate`);
});

test('approve-week then push to fake OTAV marks blocks exported', async () => {
  const wk = await j('POST', '/api/blocks/approve-week?week=2026-07-20');
  assert.equal(wk.status, 200);
  assert.ok(wk.data.approved.length >= 20);

  // Approved blocks land on multiple dates; push the Monday.
  const push = await j('POST', '/api/otav/push?date=2026-07-20');
  assert.equal(push.status, 200);
  const ch1 = push.data.channels[0];
  assert.ok(ch1.ok, `push ok: ${ch1.error || ''}`);
  assert.ok(ch1.pushed > 0, 'clips were pushed');

  // The fake OTAV recorded auth, a playlist clear, clips, and a resync.
  assert.ok(fakeOtav.state.authorized >= 1);
  assert.ok(fakeOtav.state.cleared >= 1);
  assert.equal(fakeOtav.state.received.length, ch1.pushed);
  assert.equal(fakeOtav.state.received[0].clip_type, 0);
  assert.ok(fakeOtav.state.received[0].url.startsWith('/'));

  // Pushed blocks are now 'exported'.
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
  // Assigning/browsing outside the configured mount point is rejected.
  const outside = await j('POST', '/api/media/roots', { channel_id: 1, show_type_id: 1, path: '/etc' });
  assert.equal(outside.status, 400);
  const browse = await j('GET', '/api/media/browse?path=/etc/passwd');
  assert.equal(browse.status, 400);
});

test('weekly cron entrypoint runs', async () => {
  const results = runWeeklyDraft();
  assert.ok(Array.isArray(results));
});
