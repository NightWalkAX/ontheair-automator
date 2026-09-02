// Air Spec (ffmpeg normalisation) tests.
//
// Drives the whole slow routine against fakes: test/fake-ffprobe-json declares a
// file's format from a sidecar, test/fake-ffmpeg writes an on-spec output. What
// matters here is the SAFETY of the swap, not the encode: an on-spec clip is
// never touched, an unreadable one never enters the queue, a failed encode never
// moves anything, and a successful one archives the original before the new file
// takes its place — with the catalogue re-pointed at the new name.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe-json');
process.env.FFMPEG_PATH = join(__dirname, 'fake-ffmpeg');
process.env.SCHEDULER_DB = process.env.SCHEDULER_DB
  || join(mkdtempSync(join(tmpdir(), 'otav-db-')), 'test.sqlite');

const scratch = mkdtempSync(join(tmpdir(), 'otav-tx-'));
const mediaDir = join(scratch, 'media');
process.env.TRANSCODE_WORK_DIR = join(scratch, 'work');
process.env.TRANSCODE_ARCHIVE_DIR = join(scratch, 'originals');
// updateConfig() WRITES this file (the exported-day switch persists there), so
// the run works on a throwaway copy and never touches the operator's own.
const testConfig = join(scratch, 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.json'), testConfig);
process.env.SCHEDULER_CONFIG = testConfig;

const { db, initSchema } = await import('../src/db.js');
const { router: transcodeRouter } = await import('../src/routes/transcode.js');
const tx = await import('../src/services/transcode.js');

const ON_SPEC = {
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080,
      avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p' },
    { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 },
  ],
  format: { duration: '600.000', size: '1000' },
};
const OFF_SPEC = {
  streams: [
    { codec_type: 'video', codec_name: 'mpeg4', width: 720, height: 480,
      avg_frame_rate: '30000/1000', pix_fmt: 'yuv420p' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
  ],
  format: { duration: '300.000', size: '1000' },
};

let server, base, channelId;

function media(name, sidecar) {
  const path = join(mediaDir, name);
  writeFileSync(path, Buffer.alloc(64, 1));
  if (sidecar) writeFileSync(`${path}.json`, JSON.stringify(sidecar));
  return path;
}

async function j(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** The routine runs in the background; wait for it to go idle. */
async function settle(timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (tx.getState().phase !== 'idle') {
    if (Date.now() > until) throw new Error('transcode run did not finish in time');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  initSchema();
  mkdirSync(mediaDir, { recursive: true });

  channelId = db.prepare('INSERT INTO ChannelType (name, is_active) VALUES (?, 1)')
    .run('Test Channel').lastInsertRowid;

  const files = [
    ['good.mov', ON_SPEC],
    ['old_sd.avi', OFF_SPEC],
    ['broken.mov', null],          // no sidecar -> ffprobe fails -> 'missing'
    ['clip_fail.avi', OFF_SPEC],   // fake ffmpeg refuses this one
  ];
  const insert = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, chapter, channel_id, approved)
    VALUES (?, ?, ?, 0, 0, ?, 1)
  `);
  for (const [name, sidecar] of files) {
    const path = media(name, sidecar);
    insert.run(name.replace(/\.[^.]+$/, ''), path, Number(sidecar?.format.duration || 60), channelId);
  }

  const app = express();
  app.use(express.json());
  app.use('/api/transcode', transcodeRouter);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
});

test('specReasons only flags what actually breaks playout', () => {
  const target = tx.transcodeConfig().target;
  assert.deepEqual(tx.specReasons({
    width: 1920, height: 1080, fps: 30000 / 1001, vcodec: 'h264', pix_fmt: 'yuv420p',
    acodec: 'pcm_s16le', sample_rate: 48000, achannels: 2, file_path: '/x/y.mov',
  }, target), [], 'an on-spec file must not be re-encoded');

  // 30.000 is NOT 29.97: that one-frame-in-1000 difference is exactly the drift
  // this routine exists to remove, so it has to be caught.
  const reasons = tx.specReasons({
    width: 720, height: 480, fps: 30, vcodec: 'mpeg4', pix_fmt: 'yuv420p',
    acodec: 'aac', sample_rate: 44100, achannels: 2, file_path: '/x/y.avi',
  }, target);
  assert.deepEqual(reasons.sort(), ['audio_codec', 'audio_rate', 'fps', 'resolution', 'vcodec'].sort());

  assert.ok(tx.specReasons({
    width: 1920, height: 1080, fps: 30000 / 1001, vcodec: 'h264', pix_fmt: 'yuv420p',
    acodec: null, file_path: '/x/y.mov',
  }, target).includes('no_audio'));
});

test('ffmpeg args carry the sync-critical flags', () => {
  const target = tx.transcodeConfig().target;
  const args = tx.buildFfmpegArgs('/in.avi', '/out.mov', target, { hasAudio: true }).join(' ');
  assert.match(args, /scale=1920:1080/);
  assert.match(args, /pad=1920:1080/);
  assert.match(args, /fps=30000\/1001/);
  assert.match(args, /-r 30000\/1001/);
  assert.match(args, /-video_track_timescale 30000/);
  assert.match(args, /-c:a pcm_s16le/);
  assert.match(args, /-ar 48000 -ac 2/);
  assert.match(args, /aresample=async=1:first_pts=0/);

  // A source with no audio gets a generated silent track rather than a clip OTAV
  // would play with a missing stream.
  const silent = tx.buildFfmpegArgs('/in.avi', '/out.mov', target, { hasAudio: false }).join(' ');
  assert.match(silent, /anullsrc=channel_layout=stereo:sample_rate=48000/);
  assert.match(silent, /-map 1:a:0/);
});

test('scan classifies the library and queues only what is off spec', async () => {
  const r = await j('POST', `/api/transcode/scan?channel=${channelId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 4);
  await settle();

  const byName = Object.fromEntries(
    tx.listItems({ limit: 50 }).map((i) => [i.file_path.split('/').pop(), i])
  );
  assert.equal(byName['good.mov'].status, 'ok');
  assert.equal(byName['old_sd.avi'].status, 'pending');
  assert.equal(byName['broken.mov'].status, 'missing');
  assert.equal(byName['clip_fail.avi'].status, 'pending');
  assert.deepEqual(JSON.parse(byName['old_sd.avi'].reasons).sort(),
    ['audio_codec', 'audio_rate', 'fps', 'resolution', 'vcodec'].sort());
  assert.equal(byName['old_sd.avi'].width, 720);
});

test('a run converts, verifies, archives the original and re-points the catalogue', async () => {
  const before = db.prepare('SELECT * FROM Resource WHERE name = ?').get('old_sd');
  const r = await j('POST', `/api/transcode/start?channel=${channelId}`);
  assert.equal(r.status, 200);
  await settle();

  const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path LIKE ?').get('%old_sd.mov');
  assert.equal(item.status, 'replaced');

  // The new file sits where the old one did, under the target container.
  const expected = before.file_path.replace(/\.avi$/, '.mov');
  assert.ok(existsSync(expected), 'converted file must be in the media folder');
  assert.ok(!existsSync(before.file_path), 'the .avi must have been moved out');
  assert.ok(existsSync(join(process.env.TRANSCODE_ARCHIVE_DIR, before.file_path.replace(/^\/+/, ''))),
    'the original must be kept in the archive, never deleted');

  const after = db.prepare('SELECT * FROM Resource WHERE id = ?').get(before.id);
  assert.equal(after.file_path, expected);
  assert.equal(after.duration, 300);

  // The clip fake-ffmpeg refuses is recorded as failed, and nothing about it moved.
  const failed = db.prepare('SELECT * FROM TranscodeItem WHERE file_path LIKE ?').get('%clip_fail.avi');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ffmpeg/);
  assert.ok(existsSync(failed.file_path), 'a failed conversion must leave the original in place');

  // An on-spec clip is left completely alone.
  const good = db.prepare('SELECT * FROM TranscodeItem WHERE file_path LIKE ?').get('%good.mov');
  assert.equal(good.status, 'ok');
  assert.equal(good.out_path, null);
});

test('a re-scan never pushes finished work back into the queue', async () => {
  const r = await j('POST', `/api/transcode/scan?channel=${channelId}`);
  assert.equal(r.status, 200);
  await settle();
  const replaced = db.prepare('SELECT status FROM TranscodeItem WHERE file_path LIKE ?').get('%old_sd.mov');
  assert.equal(replaced.status, 'replaced');
});

test('retry and skip move a failed clip between the queue and the sidelines', async () => {
  const failed = db.prepare('SELECT * FROM TranscodeItem WHERE file_path LIKE ?').get('%clip_fail.avi');
  assert.equal((await j('POST', `/api/transcode/items/${failed.id}/retry`)).status, 200);
  assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(failed.id).status, 'pending');
  assert.equal((await j('POST', `/api/transcode/items/${failed.id}/skip`)).status, 200);
  assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(failed.id).status, 'skipped');
});

test('an exported day on an unreachable channel blocks the swap, not the file', async () => {
  // Stage a fresh off-spec clip, convert it WITHOUT auto-replace, then export a
  // block that airs it: the old path is baked into a playlist on the playout
  // Mac. This channel has no API address, so that playlist cannot be repaired —
  // the swap waits rather than moving a file OTAV still expects to find.
  const path = media('exported_show.avi', OFF_SPEC);
  const resourceId = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, chapter, channel_id, approved)
    VALUES (?, ?, 300, 0, 0, ?, 1)
  `).run('exported_show', path, channelId).lastInsertRowid;

  const templateId = db.prepare(`
    INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, content_type)
    VALUES (?, 'Exported block', 'Mon', 'Mon', '18:00', '19:00', 'movie')
  `).run(channelId).lastInsertRowid;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const blockId = db.prepare(`
    INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status)
    VALUES (?, ?, ?, 'exported')
  `).run(templateId, channelId, tomorrow).lastInsertRowid;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)')
    .run(blockId, resourceId);

  await j('POST', `/api/transcode/scan?channel=${channelId}`);
  await settle();
  await j('POST', `/api/transcode/start?channel=${channelId}&replace=0`);
  await settle();

  const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(path);
  assert.equal(item.status, 'converted');
  assert.ok(tx.replaceBlockers(item).length, 'an exported future day must count as a blocker');

  const blocked = await j('POST', `/api/transcode/items/${item.id}/replace`);
  assert.equal(blocked.status, 400);
  assert.match(blocked.body.error, /no API address/);
  assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(item.id).status, 'blocked');
  assert.ok(existsSync(path), 'a blocked swap must leave the original exactly where it is');
  assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(resourceId).file_path, path);

  // Forcing it through is the operator's call, and then it does swap.
  const forced = await j('POST', `/api/transcode/items/${item.id}/replace?force=1`);
  assert.equal(forced.status, 200);
  assert.ok(existsSync(path.replace(/\.avi$/, '.mov')));
  assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(item.id).status, 'replaced');
});

test('status reports the spec, the counts and an idle phase', async () => {
  const r = await j('GET', '/api/transcode/status');
  assert.equal(r.status, 200);
  assert.equal(r.body.phase, 'idle');
  assert.equal(r.body.target.width, 1920);
  assert.equal(r.body.target.fps, '30000/1001');
  assert.equal(r.body.target.acodec, 'pcm_s16le');
  assert.ok(r.body.counts.total >= 5);
  assert.ok(r.body.counts.replaced >= 2);
});

test('two runs cannot overlap', async () => {
  // Nothing is queued now, so a start is refused for that reason — the same 409
  // path the UI relies on to keep the operator from stacking runs.
  const r = await j('POST', `/api/transcode/start?channel=${channelId}`);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /nothing queued/);
});

// ---- Repairing a day already exported --------------------------------------
//
// The whole point of the default `exportedDays.mode = 'fix'`: a converted clip
// changes name, and the playlist on the playout Mac is repaired instead of the
// swap waiting for the operator to remember which days to push again. What
// matters here is the ORDER — nothing moves until every affected day has been
// found fixable, and the original is archived only after the playlists name the
// new file, so no playlist ever names a path with nothing behind it.

const { startFakeOtav } = await import('./fake-otav.mjs');

/**
 * A channel wired to a fake OTAV, with `name` already exported for `date`:
 * a day playlist that exists and holds one clip naming the file's old path.
 */
async function exportedOn(fake, { name, date, duration = 300, sidecar = OFF_SPEC }) {
  const chan = db.prepare('INSERT INTO ChannelType (name, api_ip, api_port, is_active) VALUES (?, ?, ?, 1)')
    .run(`Fixable ${name}`, '127.0.0.1', fake.port).lastInsertRowid;
  const path = media(name, sidecar);
  const resourceId = db.prepare(`
    INSERT INTO Resource (name, file_path, duration, is_filler, chapter, channel_id, approved)
    VALUES (?, ?, ?, 0, 0, ?, 1)
  `).run(name.replace(/\.[^.]+$/, ''), path, duration, chan).lastInsertRowid;

  const templateId = db.prepare(`
    INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, content_type)
    VALUES (?, ?, 'Mon', 'Mon', '18:00', '19:00', 'movie')
  `).run(chan, `Block ${name}`).lastInsertRowid;
  const blockId = db.prepare(`
    INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status)
    VALUES (?, ?, ?, 'exported')
  `).run(templateId, chan, date).lastInsertRowid;
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, 0)')
    .run(blockId, resourceId);

  // The day playlist as a push would have left it: created, holding the clip.
  const playlist = `Fixable ${name} ${date}`;
  await fetch(`http://127.0.0.1:${fake.port}/playlists/${encodeURIComponent(playlist)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: playlist }),
  });
  await fetch(`http://127.0.0.1:${fake.port}/playlists/${encodeURIComponent(playlist)}/items`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clip_type: 0, url: path, name }),
  });

  return { channelId: chan, path, resourceId, blockId, playlist };
}

/** Convert one channel's queue without swapping anything in yet. */
async function convertOnly(channelId) {
  await j('POST', `/api/transcode/scan?channel=${channelId}`);
  await settle();
  await j('POST', `/api/transcode/start?channel=${channelId}&replace=0`);
  await settle();
}

const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);
const clipsOf = async (fake, playlist) =>
  (await fetch(`http://127.0.0.1:${fake.port}/playlists/${encodeURIComponent(playlist)}/items`)).json();

test('an exported day is re-pointed at the new path instead of blocking the swap', async () => {
  const fake = await startFakeOtav();
  try {
    const day = await exportedOn(fake, { name: 'fix_me.avi', date: tomorrow() });
    await convertOnly(day.channelId);

    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);
    assert.equal(item.status, 'converted');
    assert.ok(tx.replaceBlockers(item).length, 'the exported day must still register as a blocker');

    const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const newPath = day.path.replace(/\.avi$/, '.mov');
    assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(item.id).status, 'replaced');
    assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(day.resourceId).file_path, newPath);
    assert.ok(existsSync(newPath), 'the converted file must be at its new path');
    assert.ok(!existsSync(day.path), 'the original must be archived once the playlist is fixed');

    const clips = await clipsOf(fake, day.playlist);
    assert.equal(clips.length, 1, 'the clip keeps its slot — it is edited, not re-added');
    assert.equal(clips[0].url, newPath, 'OTAV must now name the converted file');
    assert.equal(clips[0].name, 'fix_me.avi', 'the clip keeps the name the push gave it');
    assert.equal(fake.state.cleared, 0, 'a re-point must never clear the day');
  } finally {
    await fake.close();
  }
});

test('a runtime that moved rebuilds the day instead of editing one clip', async () => {
  const fake = await startFakeOtav();
  try {
    // *_drift.* comes back a second longer, so the block no longer adds up and
    // patching the url alone would leave the day's fit (and its schedule event
    // duration) computed from a runtime that no longer exists.
    const day = await exportedOn(fake, { name: 'fix_drift.avi', date: tomorrow() });
    await convertOnly(day.channelId);

    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);
    assert.equal(item.status, 'converted');
    assert.ok(Math.abs(item.out_duration - item.src_duration) > 0.5, 'the fake must have drifted');

    const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const newPath = day.path.replace(/\.avi$/, '.mov');
    const clips = await clipsOf(fake, day.playlist);
    assert.equal(clips.length, 1);
    assert.equal(clips[0].url, newPath);
    assert.ok(fake.state.cleared > 0, 'a rebuild clears the day first, unlike a re-point');
    assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(item.id).status, 'replaced');
    assert.ok(!existsSync(day.path));
  } finally {
    await fake.close();
  }
});

test('the clip on air is never touched, and nothing moves when a day cannot be fixed', async () => {
  const fake = await startFakeOtav();
  try {
    const day = await exportedOn(fake, { name: 'fix_onair.avi', date: tomorrow() });
    fake.state.onAirUrl = day.path;   // that very clip is playing right now
    await convertOnly(day.channelId);
    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);
    assert.equal(item.status, 'converted');

    const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /on air right now/);

    const after = db.prepare('SELECT * FROM TranscodeItem WHERE id = ?').get(item.id);
    assert.equal(after.status, 'blocked');
    assert.ok(existsSync(day.path), 'a refused repair must leave the original exactly where it is');
    assert.ok(!existsSync(day.path.replace(/\.avi$/, '.mov')), 'and must not have landed the new file');
    assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(day.resourceId).file_path, day.path);
    assert.equal(after.out_path, item.out_path, 'the work file is still there to retry from');

    // Retrying a blocked clip retries the SWAP, not the encode: hours of ffmpeg
    // must not be spent again to have another go at a REST edit.
    assert.equal((await j('POST', `/api/transcode/items/${item.id}/retry`)).status, 200);
    assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(item.id).status, 'converted');
  } finally {
    await fake.close();
  }
});

test('an OTAV that accepts the edit but keeps the old path is not believed', async () => {
  const fake = await startFakeOtav({ keepClipUrl: true });
  try {
    const day = await exportedOn(fake, { name: 'fix_liar.avi', date: tomorrow() });
    await convertOnly(day.channelId);
    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);

    const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /kept/);

    // Rolled all the way back: the catalogue, the original and the work file.
    assert.equal(db.prepare('SELECT status FROM TranscodeItem WHERE id = ?').get(item.id).status, 'blocked');
    assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(day.resourceId).file_path, day.path);
    assert.ok(existsSync(day.path));
    assert.ok(existsSync(item.out_path), 'the work file must survive for a retry');
  } finally {
    await fake.close();
  }
});

test('a clip about to start on today’s playlist is left alone', async () => {
  const now = new Date();
  const inFiveMinutes = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + 300;
  const fake = await startFakeOtav({ startTimes: { 'id-1': inFiveMinutes } });
  try {
    const day = await exportedOn(fake, { name: 'fix_soon.avi', date: today() });
    // The clip just posted is the fake's first, so it carries unique_id 'id-1'.
    const clips = await clipsOf(fake, day.playlist);
    assert.equal(clips[0].unique_id, 'id-1');

    await convertOnly(day.channelId);
    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);
    const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /starts within/);
    assert.ok(existsSync(day.path));
  } finally {
    await fake.close();
  }
});

test('an exported day whose playlist no longer names the clip still completes the swap', async () => {
  const fake = await startFakeOtav();
  try {
    const day = await exportedOn(fake, { name: 'fix_moved.avi', date: tomorrow() });
    // Someone pushed that day again in the meantime, so its playlist names
    // something else entirely. There is nothing to repair — but the swap must
    // still finish, or the original would be archived with no file in its place.
    const playlistRef = encodeURIComponent(day.playlist);
    await fetch(`http://127.0.0.1:${fake.port}/playlists/${playlistRef}/items/id-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '/Volumes/Public/somewhere/else.mov' }),
    });

    await convertOnly(day.channelId);
    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);
    const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const newPath = day.path.replace(/\.avi$/, '.mov');
    assert.ok(existsSync(newPath), 'the converted file still has to land');
    assert.ok(!existsSync(day.path), 'and the original still gets archived');
    assert.equal(db.prepare('SELECT file_path FROM Resource WHERE id = ?').get(day.resourceId).file_path, newPath);
    assert.equal((await clipsOf(fake, day.playlist))[0].url, '/Volumes/Public/somewhere/else.mov',
      'a playlist that does not name the clip is left untouched');
  } finally {
    await fake.close();
  }
});

test('mode "block" keeps the old conservative behaviour', async () => {
  const fake = await startFakeOtav();
  try {
    const day = await exportedOn(fake, { name: 'fix_off.avi', date: tomorrow() });
    await convertOnly(day.channelId);
    const item = db.prepare('SELECT * FROM TranscodeItem WHERE file_path = ?').get(day.path);

    assert.equal(tx.transcodeConfig().exportedDays.mode, 'fix', 'repairing is the default');

    // Turned off the way the UI turns it off, not by an env var: the switch has
    // to actually reach the swap it governs.
    assert.equal((await j('PUT', '/api/transcode/exported-days', { mode: 'block' })).status, 200);
    try {
      const r = await j('POST', `/api/transcode/items/${item.id}/replace`);
      assert.equal(r.status, 400);
      assert.match(r.body.error, /re-push those days/);
      assert.equal((await clipsOf(fake, day.playlist))[0].url, day.path, 'nothing was edited on OTAV');
      assert.ok(existsSync(day.path));
    } finally {
      await j('PUT', '/api/transcode/exported-days', { mode: 'fix' });
    }
  } finally {
    await fake.close();
  }
});

test('the exported-day switch persists to config.json and leaves the rest of it alone', async () => {
  const before = JSON.parse(readFileSync(testConfig, 'utf8'));

  const off = await j('PUT', '/api/transcode/exported-days', { mode: 'block' });
  assert.equal(off.status, 200);
  assert.equal(off.body.exportedDays.mode, 'block');
  assert.equal(off.body.exportedDays.overridden, null);

  const written = JSON.parse(readFileSync(testConfig, 'utf8'));
  assert.equal(written.transcode.exportedDays.mode, 'block');
  // A settings file that travels on a USB drive: writing one key must not drop
  // another, nor rewrite the spec the operator tuned.
  assert.deepEqual(written.filler, before.filler);
  assert.deepEqual(written.transcode.target, before.transcode.target);
  assert.equal(written.transcode.workDir, before.transcode.workDir);
  assert.equal(written.transcode.exportedDays.imminentMinutes,
    before.transcode.exportedDays.imminentMinutes, 'the other keys of the policy survive');
  // Re-read from disk, so the very next swap sees it without a restart.
  assert.equal(tx.transcodeConfig().exportedDays.mode, 'block');

  const on = await j('PUT', '/api/transcode/exported-days', { mode: 'fix' });
  assert.equal(on.body.exportedDays.mode, 'fix');
  assert.equal(tx.transcodeConfig().exportedDays.mode, 'fix');

  const bad = await j('PUT', '/api/transcode/exported-days', { mode: 'whatever' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /fix, block/);
  assert.equal(tx.transcodeConfig().exportedDays.mode, 'fix', 'a rejected mode changes nothing');
});

test('an env override wins over the switch and says so', async () => {
  process.env.TRANSCODE_EXPORTED_MODE = 'block';
  try {
    const r = await j('PUT', '/api/transcode/exported-days', { mode: 'fix' });
    assert.equal(r.status, 200);
    assert.equal(r.body.exportedDays.mode, 'block', 'the env var still decides');
    assert.equal(r.body.exportedDays.overridden, 'TRANSCODE_EXPORTED_MODE');
    // The click is still saved, so removing the override lands on what was asked.
    assert.equal(JSON.parse(readFileSync(testConfig, 'utf8')).transcode.exportedDays.mode, 'fix');
  } finally {
    delete process.env.TRANSCODE_EXPORTED_MODE;
  }
  assert.equal(tx.transcodeConfig().exportedDays.mode, 'fix');
});
