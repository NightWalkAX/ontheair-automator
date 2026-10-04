// A channel's day is ONE continuous OTAV playlist. Anything that makes it end
// before the next day's event starts is black on air — these tests pin the
// causes found in production: blocks pushed in the wrong order or into the
// wrong channel, today's playlist rebuilt while it plays, and clips whose files
// are gone.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-day-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-daycfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);

const { db, initSchema } = await import('../src/db.js');
const { router: otav } = await import('../src/routes/otav.js');
const { dayBlocks } = await import('../src/services/otavClient.js');
const { missingFilesInRange } = await import('../src/services/blockValidation.js');
const { moviePool } = await import('../src/services/scheduling.js');
const { localDate, addDays } = await import('../src/dates.js');

let server, base;
const media = mkdtempSync(join(tmpdir(), 'otav-day-media-'));

async function j(method, path) {
  const res = await fetch(base + path, { method });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

before(async () => {
  initSchema();
  const app = express();
  app.use(express.json());
  app.use('/api/otav', otav);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

const channel = (name) => db.prepare(
  "INSERT INTO ChannelType (name, api_ip, api_port) VALUES (?, '127.0.0.1', 1) RETURNING id",
).get(name).id;

/** A template on `owner` with one slot per [start, end]; returns the slot ids. */
function template(owner, name, slots) {
  const tpl = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
                          VALUES (?, ?, 'Mon', 'Mon', ?, ?) RETURNING id`).get(owner, name, slots[0][0], slots[0][1]).id;
  const ids = slots.map(([s, e], i) => db.prepare(`INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order)
                                                   VALUES (?, ?, ?, ?) RETURNING id`).get(tpl, s, e, i).id);
  return { tpl, slots: ids };
}

const block = (tpl, slot, ch, date, status = 'approved') => db.prepare(`
  INSERT INTO ScheduledBlock (template_id, slot_id, channel_id, target_date, status)
  VALUES (?, ?, ?, ?, ?) RETURNING id`).get(tpl, slot, ch, date, status).id;

test('a day is pushed in SLOT order, under the block\'s own channel', () => {
  const date = '2031-03-03';
  const a = channel('Air order A');
  const b = channel('Air order B');
  // Primary at 08:00, repeat at 17:00 — the repeat must air at 17:00, not
  // right behind its primary (the old ORDER BY bt.start_time did exactly that).
  const lessons = template(a, 'Lessons', [['08:00', '09:00'], ['17:00', '18:00']]);
  const shows = template(a, 'Shows', [['10:00', '17:00']]);
  // A template owned by B that also airs on A: its block belongs in A's playlist.
  const shared = template(b, 'Shared', [['20:00', '00:00']]);

  const l8 = block(lessons.tpl, lessons.slots[0], a, date);
  const l17 = block(lessons.tpl, lessons.slots[1], a, date);
  const s10 = block(shows.tpl, shows.slots[0], a, date);
  const sh = block(shared.tpl, shared.slots[0], a, date);
  block(shows.tpl, shows.slots[0], a, date.replace('03-03', '03-04')); // another day: ignored
  const draft = template(a, 'Draft', [['18:00', '20:00']]);
  block(draft.tpl, draft.slots[0], a, date, 'draft'); // drafts never go to air

  const rows = dayBlocks(date).filter((r) => r.channel_id === a);
  assert.deepEqual(rows.map((r) => r.block_id), [l8, s10, l17, sh]);
  assert.deepEqual(rows.map((r) => r.start_time), ['08:00', '10:00', '17:00', '20:00']);
  assert.ok(rows.every((r) => r.channel_name === 'Air order A'), 'the shared template airs under A');
  assert.equal(dayBlocks(date).filter((r) => r.channel_id === b).length, 0, 'and nothing leaks into B');
});

test('pushing TODAY needs explicit confirmation; a week push holds today back', async () => {
  const today = localDate();
  const ch = channel('Today guard');
  const t = template(ch, 'Today', [['06:00', '07:00']]);
  block(t.tpl, t.slots[0], ch, today);

  const refused = await j('POST', `/api/otav/push?date=${today}&channels=${ch}`);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.needsConfirm, 'today');

  // A past or future single day is not on air: no confirmation needed. (The
  // push itself fails against port 1 — what matters is that it was attempted.)
  const other = await j('POST', `/api/otav/push?date=${addDays(today, 1)}&channels=${ch}&allowGaps=1`);
  assert.notEqual(other.status, 409);

  const week = await j('POST', `/api/otav/push?week=${addDays(today, -1)}&channels=${ch}&allowGaps=1`);
  assert.equal(week.status, 200);
  assert.deepEqual(week.data.held, [today], 'today is reported as held, not pushed');
  assert.ok(!week.data.days.some((d) => d.targetDate === today));
});

test('a clip whose file is gone stops the push before OTAV is touched', async () => {
  const date = '2031-03-10';
  const ch = channel('Missing file');
  const t = template(ch, 'Movies', [['20:00', '22:00']]);
  const b = block(t.tpl, t.slots[0], ch, date);
  const here = join(media, 'here.mov');
  writeFileSync(here, 'x');
  const clip = db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id)
                           VALUES (?, ?, ?, 0, 1, ?) RETURNING id`);
  const ins = db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, ?)');
  ins.run(b, clip.get('Here', here, 3600, ch).id, 0);
  ins.run(b, clip.get('Gone', join(media, 'gone.mov'), 3600, ch).id, 1);

  const missing = await missingFilesInRange(date, date, [ch]);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].file_path, join(media, 'gone.mov'));
  assert.equal(missing[0].seconds, 3600, 'how much air the day would lose');
  assert.equal(missing[0].blocks[0].id, b);

  const r = await j('POST', `/api/otav/push?date=${date}&channels=${ch}`);
  assert.equal(r.status, 409);
  assert.equal(r.data.missing.length, 1);
});

test('the generator never picks a clip Air Spec found missing', () => {
  const ch = channel('Missing pick');
  const movies = db.prepare("SELECT id FROM ShowType WHERE code = 'movies'").get().id;
  const ins = db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id, show_type_id, subject)
                          VALUES (?, ?, 5400, 0, 1, ?, ?, 'Films') RETURNING id`);
  ins.get('Kept', '/films/kept.mov', ch, movies);
  ins.get('Gone', '/films/gone.mov', ch, movies);
  db.prepare("INSERT INTO TranscodeItem (file_path, status) VALUES ('/films/gone.mov', 'missing')").run();

  const pool = moviePool({ id: 0 }, { id: 0, target_date: '2031-03-17' }, 7200, ch, null);
  assert.deepEqual(pool.map((r) => r.name), ['Kept']);
});

// --- Day continuity: gaps, auto-shift, week check ----------------------------

const { linkShifts, channelDayBlocks, balanceDay } = await import('../src/services/scheduling.js');
const { checkRange } = await import('../src/services/dayCoverage.js');

const clipOf = (ch, name, secs) => db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id)
  VALUES (?, ?, ?, 0, 1, ?) RETURNING id`).get(name, join(media, `${name}.mov`), secs, ch).id;
function fill(blockId, ch, ...secs) {
  const ins = db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, ?)');
  secs.forEach((s, i) => {
    const name = `c${blockId}_${i}`;
    writeFileSync(join(media, `${name}.mov`), 'x');
    ins.run(blockId, clipOf(ch, name, s), i);
  });
}
const win = (ch, date) => Object.fromEntries(linkShifts(channelDayBlocks(ch, date)).map((r) => [r.id, r]));

test('uncovered time belongs to the block before it, up to the next day\'s first block', () => {
  const ch = channel('Gaps');
  const d1 = '2031-04-07', d2 = '2031-04-08';
  const a = template(ch, 'A', [['06:00', '08:00']]);
  const b = template(ch, 'B', [['08:30', '23:59']]);
  const ba = block(a.tpl, a.slots[0], ch, d1);
  const bb = block(b.tpl, b.slots[0], ch, d1);
  const next = block(a.tpl, a.slots[0], ch, d2); // the next day starts at 06:00

  let w = win(ch, d1);
  assert.equal(w[ba].extend_seconds, 1800, 'A owns 08:00–08:30');
  assert.equal(w[ba].blockSeconds, 9000);
  assert.equal(w[ba].effective_end, '08:30:00');
  // B ends 23:59 and the next day starts 06:00: B owns the night.
  assert.equal(w[bb].extend_seconds, 6 * 3600 + 60);
  assert.equal(w[bb].effective_end, '06:00:00');

  // With no next day scheduled there is nothing to extend to: reported instead.
  db.prepare('DELETE FROM ScheduledBlock WHERE id = ?').run(next);
  w = win(ch, d1);
  assert.equal(w[bb].extend_seconds, 0);
});

test('balanceDay moves small residues down the day and leaves manual shifts and exported days alone', () => {
  const ch = channel('Balance');
  const date = '2031-04-14';
  const t1 = template(ch, 'One', [['10:00', '11:00']]);
  const t2 = template(ch, 'Two', [['11:00', '12:00']]);
  const t3 = template(ch, 'Three', [['12:00', '13:00']]);
  const b1 = block(t1.tpl, t1.slots[0], ch, date);
  const b2 = block(t2.tpl, t2.slots[0], ch, date);
  const b3 = block(t3.tpl, t3.slots[0], ch, date);
  fill(b1, ch, 3600 - 20);      // 20s short
  fill(b2, ch, 3600 + 30);      // 30s long
  fill(b3, ch, 3600 - 10);      // 10s short, and nothing after it

  const r = balanceDay(ch, date);
  assert.equal(r.shifted, 2);
  let w = win(ch, date);
  assert.equal(w[b1].end_shift, -20, 'One ends 20s early');
  assert.equal(w[b1].blockSeconds, 3580);
  assert.equal(w[b2].start_shift, -20);
  assert.equal(w[b2].blockSeconds, 3630, 'Two starts 20s early and ends 30s late: exact');
  assert.equal(w[b2].end_shift, 10);
  assert.equal(w[b3].blockSeconds, 3590, 'Three inherits it: now exact too');
  assert.ok(Object.values(w).every((x) => x.blockSeconds === db.prepare(
    'SELECT SUM(r.duration) s FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ?',
  ).get(x.id).s), 'every block now lands on the second');

  // Idempotent.
  balanceDay(ch, date);
  assert.deepEqual(Object.values(win(ch, date)).map((x) => x.end_shift), Object.values(w).map((x) => x.end_shift));

  // An operator's shift is never moved.
  db.prepare('UPDATE ScheduledBlock SET end_shift_seconds = 45, end_shift_auto = 0 WHERE id = ?').run(b1);
  balanceDay(ch, date);
  w = win(ch, date);
  assert.equal(w[b1].end_shift, 45);

  // A residue past autoMax is left for the operator.
  const t4 = template(ch, 'Four', [['13:00', '14:00']]);
  const t5 = template(ch, 'Five', [['14:00', '15:00']]);
  const b4 = block(t4.tpl, t4.slots[0], ch, date);
  block(t5.tpl, t5.slots[0], ch, date);
  fill(b4, ch, 3600 - 300);
  balanceDay(ch, date);
  assert.equal(win(ch, date)[b4].end_shift, 0);

  // An exported day is on the playout Mac: hands off.
  db.prepare("UPDATE ScheduledBlock SET status = 'exported' WHERE id = ?").run(b3);
  assert.equal(balanceDay(ch, date).skipped, 'exported');
});

test('the week check finds every way a day can end early', async () => {
  const ch = channel('Check');
  const d1 = '2031-05-05', d2 = '2031-05-06';
  const a = template(ch, 'Morning', [['00:00', '12:00']]);
  const b = template(ch, 'Evening', [['12:00', '00:00']]);
  const am = block(a.tpl, a.slots[0], ch, d1);
  const pm = block(b.tpl, b.slots[0], ch, d1, 'draft');
  block(a.tpl, a.slots[0], ch, d2);
  fill(am, ch, 12 * 3600);
  fill(pm, ch, 12 * 3600);

  let rep = await checkRange(d1, d1, [ch]);
  let day = rep.channels[0].days[0];
  assert.equal(day.ok, false);
  const kinds = day.problems.map((p) => p.kind);
  assert.ok(kinds.includes('draft'), 'the evening is not approved');
  assert.ok(kinds.includes('black'), 'so the playlist ends at noon');
  assert.equal(day.playlistEnd, '12:00:00');
  assert.ok(day.problems.find((p) => p.kind === 'black').seconds === 12 * 3600);

  db.prepare("UPDATE ScheduledBlock SET status = 'approved' WHERE id = ?").run(pm);
  rep = await checkRange(d1, d1, [ch]);
  day = rep.channels[0].days[0];
  assert.deepEqual(day.problems.filter((p) => p.blocking), [], JSON.stringify(day.problems));
  assert.equal(day.playlistEnd, '00:00:00 (+1d)');

  // A template conflict.
  const c = template(ch, 'Clash', [['11:00', '13:00']]);
  fill(block(c.tpl, c.slots[0], ch, d1), ch, 7200);
  rep = await checkRange(d1, d1, [ch]);
  assert.ok(rep.channels[0].days[0].problems.some((p) => p.kind === 'overlap'));

  // The push refuses it, and says why.
  const push = await j('POST', `/api/otav/push?date=${d1}&channels=${ch}`);
  assert.equal(push.status, 409);
  assert.equal(push.data.gaps, true);
  assert.ok(push.data.problems.some((p) => p.kind === 'overlap'));
});

test('the end of the day closes with fillers, or hands the residue back to the block before', () => {
  const ch = channel('Closing');
  const date = '2031-06-02';
  const filler = (secs) => {
    const p = join(media, `fill_${ch}_${secs}.mov`);
    writeFileSync(p, 'x');
    return db.prepare(`INSERT INTO Resource (name, file_path, duration, is_filler, approved, channel_id)
      VALUES (?, ?, ?, 1, 1, ?) RETURNING id`).get(`f${secs}`, p, secs, ch).id;
  };
  filler(52); filler(60);
  const a = template(ch, 'Before', [['22:00', '23:00']]);
  const b = template(ch, 'Last', [['23:00', '00:00']]);
  const ba = block(a.tpl, a.slots[0], ch, date);
  const bb = block(b.tpl, b.slots[0], ch, date);
  block(a.tpl, a.slots[0], ch, '2031-06-03'); // next day starts 22:00 → Last owns the gap
  db.prepare('DELETE FROM ScheduledBlock WHERE target_date = ? AND template_id = ?').run('2031-06-03', a.tpl);
  // Nothing scheduled the next day: Last's end is fixed at midnight.
  fill(ba, ch, 3600 - 60);
  db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) SELECT ?, id, 9 FROM Resource WHERE channel_id = ? AND duration = 60 AND is_filler = 1').run(ba, ch);
  fill(bb, ch, 3600 - 43); // 43s short, and the shortest filler is 52s

  balanceDay(ch, date);
  const w = win(ch, date);
  const tot = (id) => db.prepare('SELECT SUM(r.duration) s FROM ScheduleItem si JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ?').get(id).s;
  assert.ok(Math.abs(w[bb].blockSeconds - tot(bb)) <= 5, `Last lands: ${w[bb].blockSeconds} vs ${tot(bb)}`);
  assert.ok(Math.abs(w[ba].blockSeconds - tot(ba)) <= 5, `Before lands: ${w[ba].blockSeconds} vs ${tot(ba)}`);
  assert.equal(w[bb].effective_end, '00:00:00', 'and the day still ends at midnight');
});

test('scope: approve-week, generate and counterparts honour ?channels=', async () => {
  const { router: blocks } = await import('../src/routes/blocks.js');
  const app = express();
  app.use(express.json());
  app.use('/api/blocks', blocks);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const b = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p) => { const r = await fetch(b + p, { method: m }); return { status: r.status, data: await r.json() }; };
  try {
    const x = channel('Scope X'), y = channel('Scope Y'), z = channel('Scope Z');
    const date = '2031-07-07';
    const t = template(x, 'Shared scope', [['10:00', '11:00']]);
    for (const c of [x, y, z]) db.prepare('INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (?, ?)').run(t.tpl, c);
    const bx = block(t.tpl, t.slots[0], x, date, 'draft');
    const by = block(t.tpl, t.slots[0], y, date, 'draft');
    fill(bx, x, 3600);
    fill(by, y, 3600);

    const cp = await call('GET', `/api/blocks/${bx}/counterparts?channels=${y},${z}`);
    assert.deepEqual(cp.data.counterparts.map((r) => r.id), [by]);
    assert.deepEqual(cp.data.none, [z], 'Z has no block for that airing');

    const chk = await call('GET', `/api/blocks/week-check?week=${date}&channels=${x}`);
    assert.equal(chk.status, 200, JSON.stringify(chk.data));
    assert.deepEqual(chk.data.channels.map((c) => c.id), [x]);
    assert.ok(chk.data.channels[0].days[0].problems.some((p) => p.kind === 'draft'));

    const wk = await call('POST', `/api/blocks/approve-week?week=${date}&channels=${x}`);
    assert.deepEqual(wk.data.approved, [bx], 'only the chosen channel is approved');
    assert.equal(db.prepare('SELECT status FROM ScheduledBlock WHERE id = ?').get(by).status, 'draft');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
