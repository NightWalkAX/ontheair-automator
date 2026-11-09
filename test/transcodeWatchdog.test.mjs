// Air Spec watchdog: restarts an idle queue, respects an operator Stop, never
// interrupts a run, and e-mails once when conversions start failing.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'otav-wd-'));
process.env.FFPROBE_PATH = join(__dirname, 'fake-ffprobe-json');
process.env.FFMPEG_PATH = join(__dirname, 'fake-ffmpeg');
process.env.SCHEDULER_DB = join(scratch, 'test.sqlite');
process.env.TRANSCODE_WORK_DIR = join(scratch, 'work');
process.env.TRANSCODE_ARCHIVE_DIR = join(scratch, 'originals');
const testConfig = join(scratch, 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), testConfig);
process.env.SCHEDULER_CONFIG = testConfig;

const { db, initSchema } = await import('../src/db.js');
const tx = await import('../src/services/transcode.js');
const wd = await import('../src/services/transcodeWatchdog.js');

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};
const idle = () => tx.getState().phase === 'idle';
const add = (path, status = 'pending') => db.prepare(
  "INSERT INTO TranscodeItem (file_path, status, probed_at) VALUES (?, ?, datetime('now'))",
).run(path, status);

before(() => { initSchema(); });

test('idle with nothing queued and a fresh scan does nothing', async () => {
  add('/nowhere/ok.mov', 'ok');
  const r = await wd.tick({ mail: async () => {} });
  assert.equal(r.action, 'idle-nothing-to-do');
});

test('idle with pending clips → restarts conversion (missing files simply fail)', async () => {
  add('/nowhere/a.avi'); add('/nowhere/b.avi');
  const r = await wd.tick({ mail: async () => {} });
  assert.equal(r.action, 'convert');
  assert.equal(r.total, 2);
  await until(idle);
  assert.equal(tx.itemCounts().pending || 0, 0);
});

test('never touches a run in progress', async () => {
  add('/nowhere/c.avi');
  tx.startConvert({});
  const r = await wd.tick({ mail: async () => {} });
  assert.ok(['busy', 'idle-nothing-to-do'].includes(r.action), r.action); // fast fake may already be done
  await until(idle);
});

test('an operator Stop holds it; turning it back on releases the hold', async () => {
  add('/nowhere/d.avi');
  wd.noteManualStop();
  assert.equal((await wd.tick({ mail: async () => {} })).action, 'held');
  wd.setWatchdogConfig({ enabled: true });
  assert.equal((await wd.tick({ mail: async () => {} })).action, 'convert');
  await until(idle);
});

test('disabled → no restart; outside the hours window → no restart', async () => {
  add('/nowhere/e.avi');
  wd.setWatchdogConfig({ enabled: false });
  assert.equal((await wd.tick({ mail: async () => {} })).action, 'disabled');
  const now = new Date(); const h = now.getHours();
  wd.setWatchdogConfig({ enabled: true, hours: [(h + 2) % 24, (h + 3) % 24] });
  assert.equal((await wd.tick({ now, mail: async () => {} })).action, 'outside-hours');
  wd.setWatchdogConfig({ hours: null });
  db.prepare("UPDATE TranscodeItem SET status = 'skipped' WHERE file_path = '/nowhere/e.avi'").run();
});

test('inWindow handles a window that crosses midnight', () => {
  const at = (h) => new Date(2026, 10, 9, h, 0);
  assert.equal(wd.inWindow([22, 6], at(23)), true);
  assert.equal(wd.inWindow([22, 6], at(3)), true);
  assert.equal(wd.inWindow([22, 6], at(12)), false);
  assert.equal(wd.inWindow(null, at(12)), true);
});

test('failures past the threshold are e-mailed once', async () => {
  wd.setWatchdogConfig({ failAlertThreshold: 3, enabled: false });
  const sent = [];
  const mail = async (m) => { sent.push(m); };
  await wd.tick({ mail }); // baseline
  for (const n of ['f1', 'f2', 'f3']) add(`/nowhere/${n}.avi`, 'failed');
  await wd.tick({ mail });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /3 clips failed/);
  await wd.tick({ mail });
  assert.equal(sent.length, 1);
});
