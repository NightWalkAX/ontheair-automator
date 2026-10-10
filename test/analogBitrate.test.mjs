// The analog device's bitrate cap (analog.maxBitrateKbps, 4 Mb/s video + audio):
// a master over it goes to Vol1 as a capped copy, a copy already on Vol1 over it
// is replaced under a new name and the old one handed to the clean-up, and the
// master on the share is never touched. Fake ffmpeg/ffprobe, fake device.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeAnalog } from './fake-analog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'otav-analog-cap-'));
process.env.SCHEDULER_DB = join(work, 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(work, 'config.json');
process.env.FFMPEG_PATH = join(__dirname, 'fake-ffmpeg');
process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe-json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);
{
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.analog = { ...(cfg.analog || {}), minFreeGb: 0, maxBitrateKbps: 4000, encodeDir: join(work, 'enc') };
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));
}

const { db, initSchema, ensureAnalogChannel } = await import('../src/db.js');
const analog = await import('../src/services/analogClient.js');
const { cleanupPlan } = await import('../src/services/analogVol1.js');
const { deviceEncodeArgs, kbpsOf, videoKbpsFor } = await import('../src/services/analogEncode.js');

let fake, analogId;

/** A master on the "share": `bytes` long, `seconds` by its ffprobe sidecar. */
const master = (name, bytes, seconds) => {
  const p = join(work, name);
  writeFileSync(p, Buffer.alloc(bytes, 7));
  writeFileSync(`${p}.json`, JSON.stringify({
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30000/1001', pix_fmt: 'yuv420p' },
      { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '48000', channels: 2 },
    ],
    format: { duration: String(seconds), size: String(bytes) },
  }));
  db.prepare('INSERT INTO Resource (name, file_path, duration, channel_id, approved) VALUES (?, ?, ?, ?, 1)')
    .run(name, p, seconds, analogId);
  return p;
};

before(() => {
  initSchema();
  analogId = ensureAnalogChannel();
});
after(async () => { if (fake) await new Promise((r) => fake.server.close(r)); });

test('the capped encode: constant 1-second VBV under the cap, AAC audio, 1920x1080', () => {
  const cfg = analog.analogConfig();
  assert.equal(cfg.maxBitrateKbps, 4000);
  const v = videoKbpsFor(cfg);
  assert.equal(v, 3800 - 192);
  const args = deviceEncodeArgs('/in.mov', '/out.mov', cfg).join(' ');
  for (const want of [`-b:v ${v}k`, `-maxrate ${v}k`, `-bufsize ${v}k`, '-c:a aac', '-b:a 192k', 'scale=1920:1080', 'fps=30000/1001']) {
    assert.ok(args.includes(want), `${want} in ${args}`);
  }
  assert.ok(!deviceEncodeArgs('/in.mov', '/out.mov', cfg, { hasAudio: false }).includes('-c:a'));
  assert.equal(kbpsOf(500_000, 1), 4000);
  assert.equal(kbpsOf(0, 10), null);
  assert.equal(analog.overCap(4001, cfg), true);
  assert.equal(analog.overCap(4000, cfg), false);
  assert.equal(analog.overCap(9000, { ...cfg, maxBitrateKbps: 0 }), false, '0 turns the cap off');
});

test('upload: over-cap masters go as capped copies, over-cap device copies are replaced, the rest as is', async () => {
  // Old_Movie.mov is on Vol1 already: 1 MiB over 1s = ~8.4 Mb/s.
  fake = await startFakeAnalog({
    key: 'k',
    library: [{ resource_id: 11, title: 'Old_Movie', filename: 'Old_Movie.mov', length_s: 1 }],
    disk: ['Old_Movie.mov'],
  });
  db.prepare('UPDATE ChannelType SET api_ip = ?, api_port = ?, api_key = ? WHERE id = ?').run('127.0.0.1', fake.port, 'k', analogId);

  const old = master('Old Movie.mov', 1000, 1);          // the master itself reads under: the device copy decides
  const big = master('Big Show.mpg', 1048576, 1);         // ~8.4 Mb/s, not on the device, .mpg → .mp4
  const small = master('Small.mov', 1000, 60);            // well under: uploaded as is
  const client = new analog.AnalogClient(analog.analogChannel());

  const plan = await analog.planFiles(client, [old, big, small]);
  const byPath = Object.fromEntries(plan.map((p) => [p.file_path, p]));
  assert.equal(byPath[old].state, 'ready');
  assert.equal(byPath[old].over_bitrate, true);
  assert.ok(byPath[old].kbps > 8000, String(byPath[old].kbps));
  assert.equal(byPath[big].state, 'missing');
  assert.equal(plan.filter(analog.needsCopy).length, 3);

  const st = await analog.startUpload([old, big, small]);
  assert.equal(st.total, 3);
  for (let i = 0; i < 200 && analog.uploadStatus().running; i++) await new Promise((ok) => setTimeout(ok, 20));
  const up = analog.uploadStatus();
  assert.equal(up.failed.length, 0, JSON.stringify(up.failed));
  // fake-ffmpeg writes 2048 bytes: those two are the capped copies.
  assert.deepEqual(fake.state.uploads.map((u) => [u.filename, u.bytes]).sort(),
    [['Big_Show.mp4', 2048], ['Old_Movie_1.mov', 2048], ['Small.mov', 1000]]);
  assert.deepEqual(up.converted.map((c) => c.device_filename).sort(), ['Big_Show.mp4', 'Old_Movie_1.mov']);

  const mapped = Object.fromEntries(db.prepare('SELECT file_path, device_filename FROM AnalogFile').all()
    .map((r) => [r.file_path, r.device_filename]));
  assert.equal(mapped[old], 'Old_Movie_1.mov');
  assert.equal(mapped[big], 'Big_Show.mp4');
  assert.equal(mapped[small], 'Small.mov');

  // The masters are untouched, and no encode is left behind.
  assert.equal(statSync(big).size, 1048576);
  assert.deepEqual(readdirSync(join(work, 'enc')).filter((f) => !f.endsWith('.json')), []);

  // The old over-cap copy stays on Vol1 (it may be on air) until the clean-up
  // finds it out of the week — and nothing the automator schedules uses it now.
  assert.deepEqual(fake.state.deleted, []);
  const retired = db.prepare("SELECT * FROM AnalogDeviceFile WHERE filename = 'Old_Movie.mov'").get();
  assert.equal(retired.archive, 'matched');
  assert.equal(retired.share_path, old);
  assert.equal(retired.kind, 'program');
  assert.ok((await cleanupPlan(client, analogId)).delete.some((d) => d.filename === 'Old_Movie.mov'));

  // A second plan has nothing left to send.
  const again = await analog.planFiles(client, [old, big, small]);
  assert.deepEqual(again.filter(analog.needsCopy), []);
});

test('rollback: back to the previous device copy, or the master as it is; the capped copy leaves the device', async () => {
  const convs = analog.listConversions();
  assert.equal(convs.length, 2);
  assert.ok(convs.every((c) => c.in_use));
  const byName = Object.fromEntries(convs.map((c) => [c.device_filename, c]));
  assert.equal(byName['Old_Movie_1.mov'].previous_filename, 'Old_Movie.mov');
  assert.equal(byName['Big_Show.mp4'].previous_filename, null);
  // The capped copy of Old Movie is in the week on air: it must not be deleted yet.
  fake.state.onAir.add('Old_Movie_1.mov');

  const res = await analog.rollbackConversions([byName['Old_Movie_1.mov'].id, byName['Big_Show.mp4'].id]);
  assert.ok(res.every((r) => r.ok), JSON.stringify(res));
  assert.deepEqual(fake.state.deleted.map((d) => d.filename), ['Big_Show.mp4'], 'only the copy off the air is deleted now');
  const handed = db.prepare("SELECT * FROM AnalogDeviceFile WHERE filename = 'Old_Movie_1.mov'").get();
  assert.equal(handed.archive, 'matched');
  assert.equal(handed.kind, 'program');

  const af = Object.fromEntries(db.prepare('SELECT file_path, device_filename, no_cap, uploaded_at FROM AnalogFile').all()
    .map((r) => [r.device_filename, r]));
  assert.equal(af['Old_Movie.mov'].no_cap, 1, 'back on the copy the device had');
  assert.equal(af['Big_Show.mpg'].no_cap, 1, 'the master, under its own name');
  assert.equal(af['Big_Show.mpg'].uploaded_at, null);
  // The restored copy is the clean-up's no longer.
  assert.equal(db.prepare("SELECT kind_manual FROM AnalogDeviceFile WHERE filename = 'Old_Movie.mov'").get().kind_manual, 0);

  const client = new analog.AnalogClient(analog.analogChannel());
  const paths = db.prepare('SELECT file_path FROM AnalogFile').all().map((r) => r.file_path);
  const plan = Object.fromEntries((await analog.planFiles(client, paths)).map((p) => [p.device_filename, p]));
  assert.equal(plan['Old_Movie.mov'].state, 'ready');
  assert.equal(plan['Old_Movie.mov'].over_bitrate, false, 'never capped again');
  assert.equal(plan['Big_Show.mpg'].state, 'missing');

  // The next upload sends the master as it is, not another capped copy.
  await analog.startUpload(paths);
  for (let i = 0; i < 200 && analog.uploadStatus().running; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.deepEqual(analog.uploadStatus().converted, []);
  assert.deepEqual(fake.state.uploads.at(-1), { filename: 'Big_Show.mpg', bytes: 1048576 });

  const again = await analog.rollbackConversions([byName['Big_Show.mp4'].id]);
  assert.equal(again[0].ok, false);
  assert.match(again[0].error, /already rolled back/);
});
