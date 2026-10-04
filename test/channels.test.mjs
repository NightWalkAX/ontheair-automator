// Deleting a channel: preview first, shared templates survive, on-air days need a confirm.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-chdel-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-chdelcfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const { router: channels } = await import('../src/routes/channels.js');
const { localDate, addDays } = await import('../src/dates.js');

let server, base;
async function j(method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
before(async () => {
  initSchema();
  const app = express();
  app.use(express.json());
  app.use('/api/channels', channels);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('deleting a channel previews, keeps shared templates, and confirms on-air days', async () => {
  const mk = (name) => db.prepare('INSERT INTO ChannelType (name) VALUES (?) RETURNING id').get(name).id;
  const gone = mk('Gone'), stay = mk('Stay');
  const tpl = (name, chans) => {
    const id = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
      VALUES (?, ?, 'Mon', 'Mon', '08:00', '09:00') RETURNING id`).get(chans[0], name).id;
    for (const c of chans) db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(id, c);
    return id;
  };
  const sharedTpl = tpl('Shared', [gone, stay]);
  tpl('Only here', [gone]);
  db.prepare("INSERT INTO Resource (name, file_path, duration, channel_id) VALUES ('a', '/a.mov', 60, ?)").run(gone);
  db.prepare("INSERT INTO Resource (name, file_path, duration, channel_id) VALUES ('a', '/a.mov', 60, ?)").run(stay);
  db.prepare("INSERT INTO TranscodeItem (file_path, channel_id, status) VALUES ('/a.mov', ?, 'ok')").run(gone);
  const stayBlock = db.prepare(`INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status)
    VALUES (?, ?, '2031-01-06', 'approved') RETURNING id`).get(sharedTpl, stay).id;
  db.prepare(`INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status)
    VALUES (?, ?, ?, 'exported')`).run(sharedTpl, gone, addDays(localDate(), 1));
  // A monitor feed linked to the channel loses the link, not the feed.
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.monitor = { ...(cfg.monitor || {}), sources: [{ id: 'f1', name: 'Feed', url: 'http://x', channelId: gone }] };
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));

  const p = (await j('GET', `/api/channels/${gone}/delete-preview`)).data;
  assert.equal(p.resources, 1);
  assert.equal(p.templatesDeleted, 1);
  assert.deepEqual(p.templatesKept.map((t) => t.name), ['Shared']);
  assert.equal(p.exportedFromToday, 1);
  assert.deepEqual(p.monitorFeeds, ['Feed']);

  const refused = await j('DELETE', `/api/channels/${gone}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.needsConfirm, 'exported');

  assert.equal((await j('DELETE', `/api/channels/${gone}?force=1`)).status, 200);
  assert.equal(db.prepare('SELECT channel_id FROM BlockTemplate WHERE id = ?').get(sharedTpl).channel_id, stay,
    'the shared template now belongs to the channel that still airs it');
  assert.ok(db.prepare('SELECT 1 FROM ScheduledBlock WHERE id = ?').get(stayBlock), "and the other channel's blocks are intact");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM BlockTemplate WHERE name = 'Only here'").get().n, 0);
  assert.equal(db.prepare("SELECT channel_id FROM TranscodeItem WHERE file_path = '/a.mov'").get().channel_id, stay);
  const after = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  assert.equal(after.monitor.sources[0].channelId, undefined);
  assert.equal(after.monitor.sources[0].name, 'Feed');
  assert.equal((await j('DELETE', `/api/channels/${gone}`)).status, 404);
});
