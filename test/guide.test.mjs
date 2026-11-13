// Channel guide: the 20 s kept at the end of each block, what a guide lists
// (what is left of the bracket, the next bracket from its last block), the
// looks, and the clips the push appends.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = mkdtempSync(join(tmpdir(), 'otav-guide-out-'));
process.env.SCHEDULER_DB = join(mkdtempSync(join(tmpdir(), 'otav-guide-')), 'test.sqlite');
process.env.SCHEDULER_CONFIG = join(mkdtempSync(join(tmpdir(), 'otav-guidecfg-')), 'config.json');
copyFileSync(join(__dirname, '..', 'config', 'config.example.json'), process.env.SCHEDULER_CONFIG);
const writeCfg = (guide) => {
  const cfg = JSON.parse(readFileSync(process.env.SCHEDULER_CONFIG, 'utf8'));
  cfg.schedule = { ...cfg.schedule, extendIntoGaps: false };
  cfg.guide = { enabled: true, seconds: 20, outDir: OUT, ...guide };
  writeFileSync(process.env.SCHEDULER_CONFIG, JSON.stringify(cfg));
};
writeCfg({});

const { db, initSchema } = await import('../src/db.js');
const { linkShifts, channelDayBlocks } = await import('../src/services/scheduling.js');
const { guideSecondsFor, resetGuideConfigCache, channelStyle } = await import('../src/services/guideConfig.js');
const { guidePlan, groupRows, guideTime, describeClip, lessonParts } = await import('../src/services/guidePlan.js');
const { guideHtml, identHtml } = await import('../src/services/guideTemplates.js');
const { guideItemsForDay, guidePath, fallbackPath } = await import('../src/services/guideRender.js');

const DATE = '2031-05-06';
let disc, analog, tv, movie;
const block = (ch, start, end, date = DATE, status = 'approved') => {
  const t = db.prepare(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time)
    VALUES (?, ?, 'tue', 'tue', ?, ?) RETURNING id`).get(ch, `${start} block`, start, end).id;
  return db.prepare('INSERT INTO ScheduledBlock (template_id, channel_id, target_date, status) VALUES (?, ?, ?, ?) RETURNING id')
    .get(t, ch, date, status).id;
};
const res = (ch, name, secs, type, subject = null, season = null) => db.prepare(`
  INSERT INTO Resource (name, file_path, duration, approved, channel_id, show_type_id, subject, season)
  VALUES (?, ?, ?, 1, ?, (SELECT id FROM ShowType WHERE code = ?), ?, ?) RETURNING id`).get(name, `/Volumes/Public/x/${name}.mov`, secs, ch, type, subject, season).id;
const put = (blockId, ids) => ids.forEach((r, i) => db.prepare('INSERT INTO ScheduleItem (block_id, resource_id, play_order) VALUES (?, ?, ?)').run(blockId, r, i));

before(() => {
  initSchema();
  disc = db.prepare("INSERT INTO ChannelType (name) VALUES ('Discover') RETURNING id").get().id;
  analog = db.prepare("INSERT INTO ChannelType (name, playout) VALUES ('Analog', 'analog') RETURNING id").get().id;
  tv = (n) => res(disc, `Full_House_S1E0${n}`, 1780, 'tv_shows', 'Full House', 1);
  movie = (name, secs) => res(disc, name, secs, 'movies', 'Movies');
});

test('a block keeps guide.seconds free at its end; the analog channel and short blocks keep none', () => {
  resetGuideConfigCache();
  const b = block(disc, '06:00', '07:00', '2031-05-01');
  const a = block(analog, '06:00', '07:00', '2031-05-01');
  const [r] = linkShifts(channelDayBlocks(disc, '2031-05-01'));
  assert.equal(r.id, b);
  assert.equal(r.windowSeconds, 3600);
  assert.equal(r.guide_seconds, 20);
  assert.equal(r.blockSeconds, 3580);
  assert.equal(linkShifts(channelDayBlocks(analog, '2031-05-01'))[0].guide_seconds, 0, `analog block ${a}`);
  assert.equal(guideSecondsFor(disc, '2031-05-01', 200), 0); // under minBlockSeconds
  assert.equal(channelStyle(disc), 'discover');
  assert.equal(channelStyle(analog), null);
});

test('startDate: blocks before the switch-on keep their whole window', () => {
  writeCfg({ startDate: '2031-05-02' }); resetGuideConfigCache();
  assert.equal(guideSecondsFor(disc, '2031-05-01', 3600), 0);
  assert.equal(guideSecondsFor(disc, '2031-05-02', 3600), 20);
  writeCfg({ enabled: false }); resetGuideConfigCache();
  assert.equal(guideSecondsFor(disc, '2031-05-02', 3600), 0);
  writeCfg({}); resetGuideConfigCache();
});

test('times read on the quarter hour, rows fold and cap', () => {
  assert.equal(guideTime(8 * 3600 - 40), 8 * 3600);           // 7:59:20 → 8:00
  assert.equal(guideTime(8 * 3600 + 7 * 60 + 10), 8 * 3600 + 7 * 60);
  const items = [
    { title: 'Bluey', tag: 'S02E23', kind: 'show', at: 0 }, { title: 'Bluey', tag: 'S02E24', kind: 'show', at: 60 },
    { title: 'Grade 3 Maths', tag: 'LESSON', kind: 'lesson', at: 120 }, { title: 'Grade 3 Science', tag: 'LESSON', kind: 'lesson', at: 180 },
    { title: 'Turbo', tag: 'MOVIE', kind: 'movie', at: 240 },
  ];
  const rows = groupRows(items);
  assert.deepEqual(rows.map((r) => [r.title, r.tag]), [['Bluey', 'S02E23–E24'], ['Grade 3 Maths', 'LESSON'], ['Grade 3 Science', 'LESSON'], ['Turbo', 'MOVIE']]);
  // every lesson is its own row: topic + subject (operator 2026-11-12)
  assert.deepEqual(lessonParts({ name: 'Grade 2- English language- Singular & Plural Nouns.mov', subject: 'Grade 2 English Language' }), { title: 'Singular & Plural Nouns', tag: 'Grade 2 · English' });
  assert.deepEqual(lessonParts({ name: 'Grade 6- Social - Studies - Symbols of Nationhood.mp4', subject: 'Grade 6 Social Studies' }), { title: 'Symbols of Nationhood', tag: 'Grade 6 · Social Studies' });
  assert.deepEqual(lessonParts({ name: 'Math_Intervention_Program_045_Algebra_and_Measurement_Part_1.mov', subject: 'Math Intervention' }), { title: 'Algebra and Measurement Part 1', tag: 'Math Intervention' });
  assert.deepEqual(lessonParts({ name: 'R.E.A.D_Read_Enjoy_&_Discover_Ep12_Letter_L.mov', subject: 'R.E.A.D' }), { title: 'Letter L · Ep 12', tag: 'R.E.A.D' });
  const lessons = groupRows(['Nouns', 'Verbs', 'Verbs'].map((title, i) => ({ title, tag: 'Grade 2 · English', kind: 'lesson', at: i })));
  assert.deepEqual(lessons.map((r) => [r.title, r.n]), [['Nouns', 1], ['Verbs', 2]]);
  const many = Array.from({ length: 14 }, (_, i) => ({ title: `Show ${i}`, tag: '', kind: 'show', at: i }));
  const capped = groupRows(many);
  assert.equal(capped.length, 10);
  assert.equal(capped[9].title, '+ 5 more programmes');
  assert.equal(describeClip({ name: 'HarryPotter4GobletOfFire', duration: 9000, show_type_code: 'movies', subject: 'Movies' }).title, 'Harry Potter and the Goblet of Fire');
  assert.equal(describeClip({ name: 'Peter_Pan_(2003)', duration: 6000, show_type_code: 'movies', subject: 'Movies' }).title, 'Peter Pan (2003)');
});

test('a guide lists what is left of the bracket; the last block of a bracket shows the next one', () => {
  const b10 = block(disc, '10:00', '11:00');
  const b11 = block(disc, '11:00', '12:00');
  const b12 = block(disc, '12:00', '15:00');
  put(b10, [tv(1), tv(2)]);
  put(b11, [tv(3), tv(4)]);
  put(b12, [movie('Turbo', 5741), movie('The_Lorax', 5179)]);
  const p10 = guidePlan(b10);
  assert.equal(p10.bracket, 'am');
  assert.deepEqual(p10.rows.map((r) => [r.time, r.title, r.tag]), [['11:00 AM', 'Full House', 'S01E03–E04']]);
  const p11 = guidePlan(b11);
  assert.equal(p11.bracket, 'pm', 'the 11:00 block ends the morning: its guide shows the afternoon');
  assert.deepEqual(p11.rows.map((r) => r.title), ['Turbo', 'The Lorax']);
  assert.equal(p11.hero.title, 'Turbo');
  assert.equal(p11.style, 'discover');
  assert.equal(guidePlan(block(analog, '10:00', '11:00')), null);
});

test('every look renders every bracket', () => {
  const rows = [{ time: '6:00 PM', title: 'Bluey <b>', tag: 'S02E23', kind: 'show', at: 64800, duration: 420 },
    { time: '8:00 PM', title: 'Turbo', tag: 'MOVIE', kind: 'movie', at: 72000, duration: 5741 }];
  for (const style of ['discover', 'jr', 'teen', 'elevate', 'elementary', 'moe']) {
    for (const bk of ['am', 'pm', 'eve', 'late']) {
      const html = guideHtml({ style, bk, rows, hero: rows[1], next: { bracket: 'late', rows: [{ time: '12:00 AM', title: 'Arthur' }] },
        bracketStart: 64800, seconds: 20, dateLong: 'TUESDAY, MAY 6', dateShort: 'TUESDAY · MAY 6', dateTitle: 'Tuesday, May 6' });
      assert.match(html, /id="stage"/);
      assert.match(html, /Turbo/);
      assert.ok(html.includes('Bluey &lt;b&gt;'), `${style}/${bk} escapes titles`);
    }
    assert.match(identHtml(style, 20), /STAY WITH US/);
  }
});

test('the push closes each block with its own guide, or the channel fallback', async () => {
  const d = '2031-05-08';
  const a = block(disc, '06:00', '07:00', d);
  const b = block(disc, '07:00', '08:00', d);
  const fb = fallbackPath(disc);
  mkdirSync(dirname(fb), { recursive: true });
  writeFileSync(fb, 'x');
  const own = guidePath(disc, d, a);
  mkdirSync(dirname(own), { recursive: true });
  writeFileSync(own, 'x');
  db.prepare("INSERT INTO GuideRender (block_id, channel_id, target_date, path, hash, status, seconds) VALUES (?, ?, ?, ?, 'h', 'ok', 19.987)").run(a, disc, d, own);
  writeFileSync(`${fb}.v1-20`, ''); // fallback rendered with this look/length
  const items = await guideItemsForDay(disc, d);
  assert.equal(items.get(a).file_path, own);
  assert.equal(items.get(a).duration, 19.987);
  assert.equal(items.get(b).file_path, fb);
  assert.equal(items.get(b).duration, 20);
  assert.equal((await guideItemsForDay(analog, d)).size, 0);
});

test('an OTAV push appends the guide after each block, and refuses the day without one', async () => {
  const { startFakeOtav } = await import('./fake-otav.mjs');
  const { pushApprovedBlocks } = await import('../src/services/otavClient.js');
  const otav = await startFakeOtav();
  try {
    const ch = db.prepare("INSERT INTO ChannelType (name, api_ip, api_port) VALUES ('Elevate', '127.0.0.1', ?) RETURNING id").get(otav.port).id;
    const d = '2031-05-09';
    const b1 = block(ch, '06:00', '07:00', d);
    const b2 = block(ch, '07:00', '08:00', d);
    put(b1, [res(ch, 'Show_A', 3580, 'tv_shows', 'A')]);
    put(b2, [res(ch, 'Show_B', 3580, 'tv_shows', 'B')]);
    const fb = fallbackPath(ch);
    mkdirSync(dirname(fb), { recursive: true });
    writeFileSync(fb, 'x');
    writeFileSync(`${fb}.v1-20`, '');
    const out = await pushApprovedBlocks(d);
    assert.equal(out.channels[0]?.ok, true, JSON.stringify(out));
    assert.deepEqual(otav.state.received.map((c) => c.url ?? c.path), [
      '/Volumes/Public/x/Show_A.mov', fb, '/Volumes/Public/x/Show_B.mov', fb,
    ]);

    // no fallback and no Chrome to make one: the day is refused before its playlist is touched
    writeCfg({ chromePath: '/nonexistent/chrome' }); resetGuideConfigCache();
    const fb2 = fallbackPath(ch);
    (await import('node:fs')).rmSync(fb2); (await import('node:fs')).rmSync(`${fb2}.v1-20`);
    const before = otav.state.received.length;
    const again = await pushApprovedBlocks(d);
    assert.equal(again.channels[0]?.ok, false);
    assert.match(again.channels[0]?.error ?? '', /channel guide/);
    assert.equal(otav.state.received.length, before);
  } finally {
    writeCfg({}); resetGuideConfigCache();
    await otav.close?.();
  }
});
