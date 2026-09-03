// Logging tests.
//
// The log only earns its keep on the day something dies unattended, so what is
// tested here is the properties that day depends on: a line is on DISK the
// moment it is written (not buffered in a stream that a crash discards), the
// file cannot grow without bound on a USB drive, an Error arrives with its
// stack, and the progress reporter carries the numbers that separate "frozen"
// from "slow".

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'otav-log-'));
process.env.SCHEDULER_LOG_DIR = scratch;
process.env.SCHEDULER_LOG_MAX_BYTES = '2048';   // rotate almost immediately
process.env.SCHEDULER_LOG_KEEP = '3';

const { log, logPath, tailLog, progressLogger } = await import('../src/logger.js');

const readLog = () => readFileSync(logPath(), 'utf8');

before(() => {
  // Nothing installs the handlers here: initLogging() replaces console and
  // registers process-wide exit handlers, which would follow the test runner
  // around. The file writing under test is independent of it.
});

test('a line is on disk as soon as it is logged, not when a buffer flushes', () => {
  log('unit').info('first line');
  // No await, no flush, no close: the assertion is the point — a crash on the
  // very next statement would still have left this behind.
  assert.match(readLog(), /INFO {2}\[unit\] first line/);
});

test('each level is labelled and scoped so the log can be grepped', () => {
  log('scan').warn('a warning');
  log('otav').error('a failure');
  const text = readLog();
  assert.match(text, /WARN {2}\[scan\] a warning/);
  assert.match(text, /ERROR \[otav\] a failure/);
  // ISO-ish timestamp at the head of every line.
  for (const line of text.trim().split('\n')) {
    assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /, line);
  }
});

test('an Error keeps its stack, one prefixed line per frame', () => {
  log('unit').error('while doing the thing', new Error('the actual cause'));
  const lines = readLog().trim().split('\n').filter((l) => l.includes('the actual cause') || l.includes('    at '));
  assert.ok(lines.length > 1, 'a stack must span several lines');
  // Every frame carries the prefix, so grepping a scope does not lose the stack.
  for (const l of lines) assert.match(l, /^\d{4}-\d{2}-\d{2} .*\[unit\]/);
});

test('objects are serialised rather than logged as [object Object]', () => {
  log('unit').info('payload', { channel: 3, date: '2026-09-03' });
  assert.match(readLog(), /\{"channel":3,"date":"2026-09-03"\}/);
  assert.doesNotMatch(readLog(), /\[object Object\]/);
});

test('the log rotates instead of filling the drive, keeping a bounded history', () => {
  // MAX_BYTES is 2048 and KEEP is 3 for this run.
  for (let i = 0; i < 400; i++) log('bulk').info(`line ${i} ${'x'.repeat(80)}`);
  const files = readdirSync(scratch).filter((f) => f.startsWith('automator.log'));
  assert.ok(files.includes('automator.log'), 'the live log always exists');
  assert.ok(files.length > 1, 'it actually rotated');
  assert.ok(files.length <= 1 + 3, `keeps at most 3 old files, found ${files.join(', ')}`);
  assert.ok(!existsSync(join(scratch, 'automator.log.4')), 'the oldest is dropped, not kept forever');
  // The newest content is in the live file, which is what a tail must show.
  assert.match(readLog(), /line 399/);
});

test('tailLog reads across a rotation, so a just-rotated log is not blank', () => {
  // The previous test rotated repeatedly, which is the trap: rotation happens
  // on the write that crosses the limit, so the live file can be empty (or hold
  // a single line) at the exact moment somebody opens /api/log to find out what
  // a long run just did.
  log('unit').info('MARKER-NEAR-THE-END');
  const tail = tailLog(40);
  assert.match(tail, /MARKER-NEAR-THE-END/, 'the newest line must always be in the tail');
  const lines = tail.split('\n');
  assert.ok(lines.length > 1, 'and it must reach back for context, not stop at the file boundary');
  assert.ok(lines.length <= 40, `asked for 40 lines, got ${lines.length}`);
  // Context really did come out of the rotated file.
  assert.match(tail, /line 39\d/);
  assert.doesNotThrow(() => tailLog(5));
});

test('progress reporting carries rate, elapsed and ETA — frozen vs merely slow', async () => {
  const p = progressLogger('unit', 10, { everyMs: 0, stepWarnMs: 50 });
  p.start('a media root');
  p.step('clip-1.mov', 5);
  await new Promise((r) => setTimeout(r, 30));
  p.step('clip-2.mov', 5);
  p.done('0 error(s)');
  const text = readLog();
  assert.match(text, /\[unit\] start · 10 item\(s\) · a media root/);
  assert.match(text, /2\/10 \(20%\) · [\d.]+\/s · elapsed \d+s · eta \S+ · rss \d+MB · last: clip-2\.mov/);
  assert.match(text, /\[unit\] done · 2\/10 in \d+s · 0 error\(s\)/);
});

test('a step that stalls is named, because over SMB that is the whole diagnosis', () => {
  const p = progressLogger('unit', 3, { everyMs: 60_000, stepWarnMs: 100 });
  p.step('fast.mov', 10);
  p.step('/Volumes/Public/Movies/stalled.mov', 45_000);
  const text = readLog();
  assert.match(text, /WARN {2}\[unit\] slow item \(45\.0s\): \/Volumes\/Public\/Movies\/stalled\.mov/);
  assert.doesNotMatch(text, /slow item .*fast\.mov/);
});

test('a failed run records how far it got', () => {
  const p = progressLogger('unit', 100, { everyMs: 60_000 });
  p.step('a.mov', 1);
  p.fail(new Error('share went away'));
  assert.match(readLog(), /ERROR \[unit\] aborted after 1\/100/);
  assert.match(readLog(), /share went away/);
});
