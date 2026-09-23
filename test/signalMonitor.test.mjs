// Signal monitor tests.
//
// The detection is a state machine over frames, so most of this drives
// FeedWatch directly with a fake clock: what counts as black (a logo over a
// black picture still does), how long it must last, when it is over, and that
// a feed that stops delivering anything is its own incident. Then the whole
// path once, end to end: a local HLS playlist, test/fake-ffmpeg-frames standing
// in for ffmpeg, rows in SignalEvent, and the e-mail through a jsonTransport.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import nodemailer from 'nodemailer';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'otav-mon-'));

process.env.SCHEDULER_DB = process.env.SCHEDULER_DB || join(scratch, 'test.sqlite');
process.env.FFMPEG_PATH = join(__dirname, 'fake-ffmpeg-frames');
chmodSync(process.env.FFMPEG_PATH, 0o755);
// The routes WRITE config.json, so the run gets its own.
const testConfig = join(scratch, 'config.json');
writeFileSync(testConfig, JSON.stringify({ server: { port: 0 }, monitor: { enabled: false } }));
process.env.SCHEDULER_CONFIG = testConfig;

const { initSchema, db } = await import('../src/db.js');
const mon = await import('../src/services/signalMonitor.js');
const mailer = await import('../src/services/mailer.js');
const { router } = await import('../src/routes/monitor.js');

const W = mon.FRAME_W, H = mon.FRAME_H;
const cfg = (over = {}) => mon.monitorConfig({ enabled: true, repeatMinutes: 0, ...over });
const flat = (v) => Buffer.alloc(W * H, v);
const withLogo = () => {
  const f = flat(16);
  for (let y = 1; y < 4; y++) for (let x = 55; x < 62; x++) f[y * W + x] = 235;
  return f;
};
const picture = (seed = 0) => {
  const f = flat(120);
  for (let i = 0; i < f.length; i++) f[i] = (i * 31 + seed * 7) % 200 + 30;
  return f;
};
const SOURCE = { id: 'x', name: 'GLC Test', url: 'http://feed/x.m3u8', enabled: true, channelId: null };

function watcher(over) {
  const events = [];
  let t = Date.parse('2026-09-23T10:00:00Z');
  const w = new mon.FeedWatch(SOURCE, cfg(over), (e) => events.push(e), t);
  const feed = (frames) => { for (const f of frames) { t += 1000; w.onFrame(f, t); } };
  const wait = (s) => { for (let i = 0; i < s; i++) { t += 1000; w.tick(t); } };
  return { w, events, feed, wait };
}
const times = (n, f) => Array.from({ length: n }, (_, i) => (typeof f === 'function' ? f(i) : f));

before(() => initSchema());

test('a black picture is black even with the channel logo on it; a real picture is not', () => {
  const c = cfg();
  assert.equal(mon.analyzeFrame(flat(16), null, c).black, true);
  assert.equal(mon.analyzeFrame(withLogo(), null, c).black, true);
  assert.equal(mon.analyzeFrame(picture(), null, c).black, false);
  // A mid-grey card is not black: the rule is about bright pixels, not mean luma.
  assert.equal(mon.analyzeFrame(flat(60), null, c).black, false);
  assert.equal(mon.analyzeFrame(flat(16), flat(16), c).diff, 0);
});

test('black shorter than the threshold (a fade) raises nothing', () => {
  const { events, feed, w } = watcher();
  feed(times(5, picture));
  feed(times(8, withLogo()));
  assert.equal(w.state, 'dimming');
  feed(times(5, picture));
  assert.deepEqual(events, []);
  assert.equal(w.state, 'ok');
});

test('black for the threshold opens ONE incident dated when the picture went, and recovery closes it', () => {
  const { events, feed, w } = watcher();
  feed(times(3, picture));
  feed(times(25, withLogo()));
  assert.deepEqual(events.map((e) => `${e.type}:${e.kind}`), ['open:black']);
  assert.equal(w.state, 'black');
  // Started 10s before it was alerted: the incident says when the air went black.
  const inc = events[0].incident;
  assert.equal(Date.parse(inc.alertedAt) - Date.parse(inc.startedAt), 10_000);
  feed(times(2, picture));        // one stray bright frame is not a recovery…
  feed([withLogo()]);
  assert.equal(events.length, 1);
  feed(times(5, picture));        // …five seconds of picture is
  assert.deepEqual(events.map((e) => `${e.type}:${e.kind}`), ['open:black', 'close:black']);
  assert.equal(w.state, 'ok');
});

test('a long incident sends a reminder every repeatMinutes', () => {
  const { events, feed } = watcher({ repeatMinutes: 1 });
  feed(times(10, withLogo()));
  feed(times(130, withLogo()));
  assert.deepEqual(events.map((e) => e.type), ['open', 'remind', 'remind']);
});

test('a feed that delivers nothing is NO SIGNAL, and comes back only with a few seconds of picture', () => {
  const { events, feed, wait, w } = watcher({ down: { alertAfterSeconds: 30 } });
  wait(29);
  assert.deepEqual(events, []);
  assert.equal(w.state, 'starting');
  wait(1);
  assert.deepEqual(events.map((e) => `${e.type}:${e.kind}`), ['open:down']);
  feed([picture()]);
  assert.equal(events.length, 1);
  feed(times(3, picture));
  assert.deepEqual(events.map((e) => `${e.type}:${e.kind}`), ['open:down', 'close:down']);
});

test('losing the feed during black replaces the black incident rather than stacking one on it', () => {
  const { events, feed, wait } = watcher({ down: { alertAfterSeconds: 20 } });
  feed(times(12, withLogo()));
  wait(20);
  assert.deepEqual(events.map((e) => `${e.type}:${e.kind}`), ['open:black', 'close:black', 'open:down']);
  assert.equal(events[1].note, 'feed lost');
});

test('freeze detection is off by default, and when on ignores black', () => {
  const still = picture(1);
  const off = watcher();
  off.feed(times(120, still));
  assert.deepEqual(off.events, []);
  const on = watcher({ freeze: { enabled: true, alertAfterSeconds: 30 } });
  on.feed(times(40, withLogo()));
  assert.deepEqual(on.events.map((e) => e.kind), ['black']);
  on.feed(times(6, (i) => picture(i)));
  on.feed(times(31, still));
  assert.deepEqual(on.events.map((e) => `${e.type}:${e.kind}`), ['open:black', 'close:black', 'open:frozen']);
});

test('the lowest rendition is picked and resolved against the redirected playlist', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=3640207,RESOLUTION=1280x720',
    'Feed-avc1_3000000=3.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=608607,RESOLUTION=480x320',
    'Feed-avc1_400000=5.m3u8',
  ].join('\n');
  const base = 'http://190.108.196.35/live/c2eds/Feed/HLS/Feed.m3u8';
  assert.equal(mon.pickVariant(master, base), 'http://190.108.196.35/live/c2eds/Feed/HLS/Feed-avc1_400000=5.m3u8');
  assert.equal(mon.pickVariant(master, base, 'highest'), 'http://190.108.196.35/live/c2eds/Feed/HLS/Feed-avc1_3000000=3.m3u8');
  assert.equal(mon.pickVariant('#EXTM3U\n#EXTINF:10,\nseg1.ts\n', base), base);
});

test('the e-mail names every feed that changed, in one message', () => {
  const at = Date.parse('2026-09-23T10:05:00Z');
  const inc = { startedAt: '2026-09-23T10:00:00Z' };
  const mail = mon.composeMail([
    { type: 'open', kind: 'black', source: SOURCE, incident: inc, at, onAir: 'Lesson 4 — /Volumes/Public/l4.mov' },
    { type: 'close', kind: 'down', source: { ...SOURCE, name: 'GLC Plus' }, incident: inc, at },
  ]);
  assert.match(mail.subject, /^\[Signal ALERT\] 2 changes: GLC Test, GLC Plus$/);
  assert.match(mail.text, /GLC Test: BLACK since/);
  assert.match(mail.text, /On air: Lesson 4/);
  assert.match(mail.text, /GLC Plus: back to normal — was no signal for 5m 0s/);
  assert.match(mail.html, /Lesson 4 — \/Volumes\/Public\/l4\.mov/);
});

let server;
let base;
let hls;
const sent = [];

before(async () => {
  mailer.setTransportForTests({
    sendMail: async (msg) => {
      const out = await nodemailer.createTransport({ jsonTransport: true }).sendMail(msg);
      sent.push(JSON.parse(out.message));
      return out;
    },
  });
  // A master playlist that redirects like the CDN does, then lists renditions.
  hls = http.createServer((req, res) => {
    if (req.url.startsWith('/live/')) {
      res.writeHead(302, { Location: `/edge${req.url}` });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1400000\nhi.m3u8?script=bright:1\n'
      + '#EXT-X-STREAM-INF:BANDWIDTH=600000\nlo.m3u8?script=bright:3,black:12,bright:6\n');
  });
  await new Promise((r) => hls.listen(0, '127.0.0.1', r));
  const app = express();
  app.use(express.json());
  app.use('/api/monitor', router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/monitor`;
});

after(() => {
  mon.stopMonitor();
  server?.close();
  hls?.close();
});

const call = async (method, path, body) => {
  const r = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

test('the e-mail settings are validated and the app password is never sent back', async () => {
  let r = await call('PUT', '/email', { user: 'monitor@gmail.com', recipients: 'ops@example.gy, nope' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /nope/);
  r = await call('PUT', '/email', {
    user: 'monitor@gmail.com', appPassword: 'abcd efgh ijkl mnop',
    recipients: 'ops@example.gy; eng@example.gy ops@example.gy',
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.email.recipients, ['ops@example.gy', 'eng@example.gy']);
  assert.equal(JSON.parse(readFileSync(testConfig, 'utf8')).email.appPassword, 'abcdefghijklmnop');
  // Saving again without a password keeps the stored one.
  await call('PUT', '/email', { user: 'monitor@gmail.com', recipients: ['ops@example.gy'] });
  r = await call('GET', '/config');
  assert.equal(r.body.email.hasPassword, true);
  assert.equal(JSON.stringify(r.body).includes('abcdefghijklmnop'), false);
  r = await call('POST', '/test-email');
  assert.equal(r.status, 200);
  assert.deepEqual(sent.at(-1).bcc.map((a) => a.address), ['ops@example.gy']);
});

test('a feed with a bad URL is refused', async () => {
  const r = await call('PUT', '/config', { sources: [{ name: 'X', url: 'ftp://nope' }] });
  assert.equal(r.status, 400);
});

test('end to end: black on the feed becomes a SignalEvent row and one e-mail', async () => {
  const hlsUrl = `http://127.0.0.1:${hls.address().port}/live/feed.m3u8`;
  const r = await call('PUT', '/config', {
    enabled: true, batchSeconds: 0,
    sources: [{ name: 'GLC Test Feed', url: hlsUrl }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.monitor.sources[0].id, 'glc-test-feed');
  const deadline = Date.now() + 5000;
  let rows = [];
  while (Date.now() < deadline) {
    rows = db.prepare("SELECT * FROM SignalEvent WHERE source_id = 'glc-test-feed'").all();
    if (rows.length && rows[0].ended_at && sent.some((m) => /RECOVERED|ALERT/.test(m.subject) && /Feed/.test(m.subject))) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'black');
  assert.ok(rows[0].ended_at, 'the incident closed when the picture came back');
  const status = (await call('GET', '/status')).body;
  assert.match(status.sources[0].variantUrl, /\/edge\/live\/lo\.m3u8/);
  const mails = sent.filter((m) => /GLC Test Feed/.test(m.subject));
  assert.ok(mails.length >= 1);
  assert.match(mails.map((m) => m.text).join('\n'), /GLC Test Feed: BLACK since/);
  mon.stopMonitor();
});
