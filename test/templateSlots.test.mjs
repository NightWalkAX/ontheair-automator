// Editing a template's time slots must not wipe its blocks: ScheduledBlock.slot_id
// cascades on delete, so slots are edited in place by position.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-slots-')), 'test.sqlite');
const { db, initSchema } = await import('../src/db.js');
const { setSlots } = await import('../src/routes/blocks.js');

let tpl, ch;
before(() => {
  initSchema();
  ch = db.prepare("INSERT INTO ChannelType (name) VALUES ('Slots TV')").run().lastInsertRowid;
  tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
    VALUES (?, 'Morning', 'mon', 'mon', '08:00', '09:00')`).run(ch).lastInsertRowid;
});

const slots = () => db.prepare('SELECT id, start_time, end_time, slot_order FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order').all(tpl);
const blocks = () => db.prepare('SELECT COUNT(*) AS n FROM ScheduledBlock WHERE template_id = ?').get(tpl).n;

test('changing times keeps slot ids and every block', () => {
  setSlots(tpl, [{ start_time: '08:00', end_time: '09:00' }, { start_time: '20:00', end_time: '21:00' }]);
  const [a, b] = slots();
  for (const s of [a, b]) {
    db.prepare("INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status) VALUES (?, ?, ?, '2026-11-09', 'exported')").run(tpl, s.id, ch);
  }
  // Swap the two start times: would trip UNIQUE(template_id, start_time) without parking.
  setSlots(tpl, [{ start_time: '20:00', end_time: '21:00' }, { start_time: '08:00', end_time: '09:30' }]);
  const after = slots();
  assert.deepEqual(after.map((s) => s.id), [a.id, b.id]);
  assert.deepEqual(after.map((s) => s.start_time), ['20:00', '08:00']);
  assert.equal(after[1].end_time, '09:30');
  assert.equal(blocks(), 2);
});

test('adding a slot adds; removing one deletes only that airing and its blocks', () => {
  setSlots(tpl, [{ start_time: '20:00', end_time: '21:00' }, { start_time: '08:00', end_time: '09:30' }, { start_time: '23:00', end_time: '23:30' }]);
  assert.equal(slots().length, 3);
  setSlots(tpl, [{ start_time: '20:00', end_time: '21:00' }]);
  assert.equal(slots().length, 1);
  assert.equal(blocks(), 1);
});
