// Every grade on a digital channel, two grades per channel, as decided with the
// operator on 2026-10-28 (supersedes the grade bands of 009).
//
// The twelve levels — Nursery and Grades 1 to 11 — go in pairs to the six OTAV
// channels, in the order the operator gave them, lowest first:
//
//   Elementary   Nursery + Grade 1     Circular 5/2026 Grade 1–2 timetable; nursery 08–09
//   Junior       Grades 2 + 3          Grade 1–2 timetable (Grade 2 leads)
//   TeenEd       Grades 4 + 5          Grade 3–4 timetable (Grade 4 leads)
//   Elevate      Grades 6 + 7          the Grade 6 timetable
//   MoE Central  Grades 8 + 9          no circular for secondary: the Grade 5 timetable's shape
//   Discover     Grades 10 + 11        no circular: the Grade 6 timetable's shape
//
// Mon–Fri 09:00–15:00 every one of them mirrors its timetable, period by period,
// exactly as 009 did (dayBlocks(): assembly absorbed, English periods merged,
// a period under 30 minutes joins its neighbour). Secondary grades map the
// circular's subjects onto theirs: English is English Language + English
// Literature, Social Studies also Geography, and the enrichment periods (Beyond
// Core, Moral & Civic, PE, HFLE) are the electives — Spanish, Information
// Technology, Office Administration, Principles of Business, and the general
// Grade 10 / Grade 11 lessons.
//
// Replays: the channels that already carried lessons at night (Elementary,
// Junior, TeenEd) and Discover (whose Academics repeated at 17:00) replay the
// school day 00:00–06:00 and its morning 17:00–20:00. Elevate and MoE Central
// keep their nights (films) and their evenings (the local shows' repeats).
//
// The local shows of Elevate and MoE Central "stay where they fit" (operator):
// those with an evening airing keep only that one; those that aired only inside
// 09:00–15:00 are retired. The shows that ran into the school day move to
// 15:00–17:00; the morning cartoons/shows run to 09:00.
//
// The analog channel no longer premieres classes — it REPEATS them: Grades 6–7
// 00:00–03:00 and Grades 8–9 03:00–06:00 (the two pairs with no night replay of
// their own), plus its secondary classes 15:00/15:30–17:00 from 009. Its school
// hours become documentaries 09–12, its noon documentary, and TV shows 13–15.
//
// Guards: the templates 009 created are found by channel + name (their ids are
// per installation); the original ones by id + name + channel. Anything that
// differs is skipped and named. A template that changes time is retired and
// cloned, never re-slotted (ScheduledBlock.slot_id cascades onto today's
// blocks). Blocks after today are removed (clearBlocksAfter, as 009) so the next
// "Generate drafts" builds the week from this line-up.

import { db } from '../db.js';
import { localDate } from '../dates.js';
import { TIMETABLES, dayBlocks, clearBlocksAfter } from './009-circular-timetables.js';

export const id = '010-grade-pairs';
export const description = 'two grades per digital channel (Nursery–G11, Elementary lowest … Discover highest); the analog channel repeats classes';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WEEKDAYS = DAYS.join(',');

// Circular 5/2026, Grade 6 (009 used Grade 5's for both), assembly absorbed.
export const G6 = {
  Mon: [['09:00', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '12:00', 'Literacy'], ['12:00', '13:00', 'LUNCH'],
    ['13:00', '14:00', 'Science'], ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Reading'], ['14:30', '15:00', 'Social Studies']],
  Tue: [['09:00', '10:00', 'Literacy'], ['10:00', '10:30', 'Language Arts'], ['10:30', '10:45', 'RECESS'], ['10:45', '12:00', 'Mathematics'],
    ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Social Studies'], ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Reading'],
    ['14:30', '15:00', 'Beyond Core']],
  Wed: [['09:00', '10:00', 'Mathematics'], ['10:00', '10:30', 'Moral & Civic'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Social Studies'],
    ['11:35', '12:00', 'Language Arts'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Literacy'], ['14:00', '14:10', 'RECESS'],
    ['14:10', '15:00', 'Science']],
  Thu: [['09:00', '10:00', 'Mathematics'], ['10:00', '10:30', 'Science'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Literacy'],
    ['11:35', '12:00', 'Language Arts'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Social Studies'], ['14:00', '14:10', 'RECESS'],
    ['14:10', '14:30', 'Reading'], ['14:30', '15:00', 'HFLE']],
  Fri: [['09:00', '10:00', 'Literacy'], ['10:00', '10:30', 'Language Arts'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Mathematics'],
    ['11:35', '12:00', 'Reading'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Science'], ['14:00', '14:10', 'RECESS'],
    ['14:10', '15:00', 'PE']],
};
const TABLES = { g12: TIMETABLES.g12, g34: TIMETABLES.g34, g5: TIMETABLES.g56, g6: G6 };

// One pair per channel, lowest first. `letters` is what Letters & Sounds airs
// (only the Grade 1–2 and 3–4 timetables have it). Recess is ten or fifteen
// minutes at the same time on every channel, so only two channels get a short
// cartoon (Bluey, Curious George); the others air fillers. Lunch draws series
// nobody else airs 12–13.
export const PAIRS = [
  { channel: 'Elementary', label: 'Grade 1', grades: [1], table: 'g12', letters: ['R.E.A.D'],
    recess: ['Curious George'], lunch: ['Arthur', 'Cyberchase', 'Octonauts Above and Beyond'], replay: true },
  { channel: 'Junior', label: 'Grades 2-3', grades: [2, 3], table: 'g12', letters: [],
    recess: ['Bluey'], lunch: ['Daniel Tiger', 'Octonauts', 'Bluey'], replay: true },
  { channel: 'TeenEd', label: 'Grades 4-5', grades: [4, 5], table: 'g34', letters: [],
    recess: [], lunch: ['Wild Kratts', 'Xavier Riddle', 'Sid The Science Kid'], replay: true },
  { channel: 'Elevate', label: 'Grades 6-7', grades: [6, 7], table: 'g6', letters: [],
    recess: [], lunch: ['How the Universe Works', 'Through the Wormhole'], replay: false },
  { channel: 'MoE Central', label: 'Grades 8-9', grades: [8, 9], table: 'g5', letters: [],
    recess: [], lunch: ['Life', 'Cosmos A Space Time Odyssey'], replay: false },
  { channel: 'Discover', label: 'Grades 10-11', grades: [10, 11], table: 'g6', letters: [],
    recess: [], lunch: ['Brain Games', 'Explained'], replay: true },
];

const ENGLISH = new Set(['Literacy', 'Reading', 'Language Arts']);
const ENRICHMENT = {
  'Beyond Core': ['La Escuelita de Español'],
  'Moral & Civic': ['Your Government and You'],
  PE: ['Yoga on the Beach'],
  HFLE: ["Let's Talk Autism", 'Inside NCERD'],
};
const MIN_PERIOD = 30;

const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

/** What one grade airs for a circular subject. */
export function gradeSeries(g, subject) {
  const s = subject.startsWith('Support:') ? subject.slice(8) : subject;
  const secondary = g >= 7;
  if (s === 'L&S' || ENGLISH.has(s)) return secondary ? [`Grade ${g} English Language`, `Grade ${g} English Literature`] : [`Grade ${g} English Language`];
  if (s === 'Social Studies') return secondary ? [`Grade ${g} Social Studies`, `Grade ${g} Geography`] : [`Grade ${g} Social Studies`];
  if (ENRICHMENT[s]) {
    if (!secondary) return [];
    const electives = ['Spanish', 'Information Technology', 'Office Administration', 'Principles of Business'].map((x) => `Grade ${g} ${x}`);
    return g >= 10 ? [...electives, `Grade ${g}`] : electives;
  }
  return [`Grade ${g} ${s}`];
}

/** The catalogue series one period of a pair's timetable airs, on `day`. */
export function pairSeries(cfg, subject, day, minutes) {
  if (subject === 'RECESS') return cfg.recess;
  if (subject === 'LUNCH') return cfg.lunch;
  if (subject === 'L&S' && cfg.letters.length) return cfg.letters;
  // Two grades: when the period can't hold both, alternate which leads.
  const order = cfg.grades.length > 1 && minutes < 40 && (day === 'Tue' || day === 'Thu') ? [...cfg.grades].reverse() : cfg.grades;
  const list = order.flatMap((g) => gradeSeries(g, subject));
  if (ENRICHMENT[subject]) {
    // A primary grade gets the enrichment equivalent, but only in a period long
    // enough for its ~25-minute episodes; a shorter one lends its time.
    const primary = cfg.grades.some((g) => g <= 6);
    if (primary && minutes >= MIN_PERIOD) return [...ENRICHMENT[subject], ...list, ...cfg.grades.map((g) => `Grade ${g} English Language`)];
  }
  return list;
}

/** One pair's timetable → templates [{ name, weekdays, slots, series }]. */
export function expandPair(cfg) {
  const periods = [];
  for (const day of DAYS) {
    for (const b of dayBlocks(TABLES[cfg.table][day])) {
      const series = [...new Set(b.parts.flatMap((p) => pairSeries(cfg, p.subject, day, p.minutes) || []))];
      periods.push({ day, start: b.start, end: b.end, subject: b.parts.map((p) => p.subject).join(' + '), series });
    }
  }
  const byKey = new Map();
  for (const p of periods) {
    const k = `${p.start}|${p.end}|${p.series.join('|')}`;
    if (!byKey.has(k)) byKey.set(k, { ...p, days: [] });
    byKey.get(k).days.push(p.day);
  }
  return [...byKey.values()]
    .sort((a, b) => a.start.localeCompare(b.start) || DAYS.indexOf(a.days[0]) - DAYS.indexOf(b.days[0]))
    .map((p) => {
      const slots = [[p.start, p.end]];
      if (cfg.replay) {
        slots.push([hhmm(mins(p.start) - 9 * 60), hhmm(mins(p.end) - 9 * 60)]);
        if (mins(p.end) <= 12 * 60) slots.push([hhmm(mins(p.start) + 8 * 60), hhmm(mins(p.end) + 8 * 60)]);
      }
      const what = p.subject.replace(/Support:/g, 'Support ').replace(/RECESS/, 'Recess').replace(/LUNCH/, 'Lunch');
      return {
        name: `${cfg.channel} ${cfg.label} ${p.start} ${what} (${p.days.length === 5 ? 'Mon-Fri' : p.days.join('/')})`,
        weekdays: p.days.join(','), slots, series: p.series,
      };
    });
}

const subjects = (...grades) => grades.flatMap((g) => ['English Language', 'English Literature', 'Mathematics', 'Science',
  'Social Studies', 'Geography'].map((s) => `Grade ${g} ${s}`));

// The analog channel's new weekday line-up around the classes it repeats.
const ANALOG_DAY_DOCS = [
  ['Mon', ['Cosmos A Space Time Odyssey', 'Human The World Within', 'Our Planet Frozen Worlds']],
  ['Tue', ['Planet Earth', 'South Pacific', 'The Blue Planet']],
  ['Wed', ['Human The World Within', 'Our Planet Frozen Worlds', 'South Pacific']],
  ['Thu', ['Planet Earth', 'The Blue Planet', 'Frozen Planet']],
  ['Fri', ['Frozen Planet', 'Human The World Within', 'Cosmos A Space Time Odyssey']],
];
export const EXTRA = [
  { channel: 'Elementary', name: 'Elementary Nursery 08-09', weekdays: WEEKDAYS, slots: [['08:00', '09:00']],
    series: ['Nursery', 'Numeracy', 'Literacy'] },
  { channel: 'Analog', name: 'Analog Night Classes Grades 6-7', weekdays: WEEKDAYS, slots: [['00:00', '03:00']], series: subjects(6, 7) },
  { channel: 'Analog', name: 'Analog Night Classes Grades 8-9', weekdays: WEEKDAYS, slots: [['03:00', '06:00']], series: subjects(8, 9) },
  ...ANALOG_DAY_DOCS.map(([day, series]) => ({
    channel: 'Analog', name: `Analog Morning Documentaries 09-12 (${day})`, weekdays: day, slots: [['09:00', '12:00']], series,
  })),
  { channel: 'Analog', name: 'Analog Afternoon TV Shows 13-15', weekdays: WEEKDAYS, slots: [['13:00', '15:00']],
    series: ['Full House', 'Family Matters', 'Different Strokes', 'Saved by the Bell', 'Fuller House'] },
];

// Existing templates. [id | null, name, channel]: null = created by 009 (or
// cloned by it), so matched by channel + name only.
const RETIRE = [
  [2, 'Academics', 'Discover'], [78, 'Teen Ack 8 to 11 and 5 to 8', 'TeenEd'],
  [null, 'Junior Nursery 08-09', 'Junior'],
  // Elevate: shows that aired only inside 09:00–15:00.
  [32, 'Inside NCERD', 'Elevate'], [33, 'Yoga on the Beach', 'Elevate'], [34, 'Agri Talk', 'Elevate'],
  [35, 'Your Government & You', 'Elevate'], [36, "Let's Talk Autism", 'Elevate'],
  [null, 'Forts & Monuments', 'Elevate'], [null, 'The Amazing World of Cho', 'Elevate'], [null, 'New Enhanced Curriculum', 'Elevate'],
  [null, 'Students of Guyana', 'Elevate'], [null, 'Math Intervention', 'Elevate'], [null, 'Beatin da Maths', 'Elevate'],
  // MoE Central: the same, plus Behind The Signal (no approved clip; the analog
  // channel keeps its own at 15:00).
  [66, "How It's Made Guyana", 'MoE Central'], [67, 'Yoga on the Beach', 'MoE Central'], [69, 'Beating The Odds', 'MoE Central'],
  [70, 'Math Intervention', 'MoE Central'], [71, 'Beatin da Maths', 'MoE Central'], [72, 'Forts & Monuments', 'MoE Central'],
  [73, 'The Amazing World of Cho', 'MoE Central'], [155, 'Behind The Signal', 'MoE Central'],
];
// Templates whose name starts with one of these, on that channel, are 009's
// grade bands — all retired.
const RETIRE_PREFIX = [['Junior', 'Junior Grades 1-2 '], ['Elementary', 'Elementary Grades 3-4 '], ['Analog', 'Analog Grades 5-6 ']];

// [id | null, name, channel, slots] — new times (retire + clone).
const RETIME = [
  [92, 'Junior 6 to 8', 'Junior', [['06:00', '09:00']]],
  [null, 'Elementart 6 to 8', 'Elementary', [['06:00', '08:00']]],
  [80, 'Morning Shows 6 to 8', 'TeenEd', [['06:00', '09:00']]],
  [88, 'Teen Cartoon 11 to 5', 'TeenEd', [['15:00', '17:00']]],
  [1, 'Weekday Morning Shows', 'Discover', [['06:00', '09:00']]],
  [159, 'Tuesday Night Movies', 'Discover', [['06:00', '09:00']]],
  ...[[3, 'Monday'], [4, 'Tuesday'], [5, 'Wednesday'], [6, 'Thursday'], [7, 'Friday']]
    .map(([tid, d]) => [tid, `${d} Afternoon Shows`, 'Discover', [['15:00', '17:00']]]),
  ...[[48, 'Monday'], [49, 'Tuesday'], [50, 'Wednesday'], [51, 'Thursday'], [52, 'Friday']]
    .map(([tid, d]) => [tid, `${d} Afternoon Shows`, 'Elevate', [['15:00', '17:00']]]),
  [62, 'Weekday Afternoon Shows', 'MoE Central', [['15:00', '17:00']]],
  // Local shows that keep only their evening airing.
  [28, 'Advancing in English', 'Elevate', [['18:00', '18:30']]],
  [29, 'La Escuelita De Espanol', 'Elevate', [['18:30', '19:00']]],
  [30, "How It's Made Guyana", 'Elevate', [['19:00', '19:30']]],
  [31, 'Of Interest', 'Elevate', [['19:30', '20:00']]],
  [45, 'Agri Talk', 'Elevate', [['18:00', '18:30']]],
  [46, 'Your Government & You', 'Elevate', [['18:30', '19:00']]],
  [47, "Let's Talk Autism", 'Elevate', [['19:00', '20:00']]],
  [65, 'La Escuelita De Espanol', 'MoE Central', [['18:00', '18:30']]],
  [75, 'Agri Talk', 'MoE Central', [['19:30', '20:00']]],
  // The analog noon documentary loses its 03:00 repeat to the night classes.
  ...DAYS.map((d) => [null, `Analog Noon Documentary (${d})`, 'Analog', [['12:00', '13:00'], ['17:00', '18:00']]]),
];
// [id, name, channel, weekdays?, series] — the weekend overnight replays follow
// their channel's new grades.
const RESERIES = [
  [103, 'Elementary 12 to 6 Replay', 'Elementary', ['Nursery', 'Numeracy', 'R.E.A.D',
    ...['English Language', 'Mathematics', 'Science', 'Social Studies'].map((s) => `Grade 1 ${s}`)]],
  [97, 'Junior 12 to 6 Replay', 'Junior',
    [2, 3].flatMap((g) => ['English Language', 'Mathematics', 'Science', 'Social Studies'].map((s) => `Grade ${g} ${s}`))],
  [91, 'Teen 12 to 6', 'TeenEd',
    [4, 5].flatMap((g) => ['English Language', 'Mathematics', 'Science', 'Social Studies'].map((s) => `Grade ${g} ${s}`)), 'Sat,Sun'],
];

const channelByName = (name) => db.prepare('SELECT id, name FROM ChannelType WHERE name = ?').get(name);
function find(tid, name, channel) {
  const ch = channelByName(channel);
  if (!ch) return null;
  const rows = db.prepare(`
    SELECT bt.* FROM BlockTemplate bt
    WHERE bt.name = ? AND bt.weekdays != '' ${tid != null ? 'AND bt.id = ?' : ''}
      AND (bt.channel_id = ? OR EXISTS (SELECT 1 FROM BlockTemplateChannel c WHERE c.template_id = bt.id AND c.channel_id = ?))
  `).all(...[name, ...(tid != null ? [tid] : []), ch.id, ch.id]);
  return rows.length === 1 ? rows[0] : null;
}

export function plan() {
  const ops = [];
  const summary = [];
  const op = (sql, ...params) => ops.push({ sql, params });
  const skip = (what) => summary.push(`skipped — ${what} (not as in production on 2026-10-28; check by hand)`);

  const channels = Object.fromEntries(['Elementary', 'Junior', 'TeenEd', 'Elevate', 'MoE Central', 'Discover', 'Analog']
    .map((n) => [n, channelByName(n)]));
  const missingChannels = Object.entries(channels).filter(([, c]) => !c).map(([n]) => n);
  if (missingChannels.length) {
    return { ops, summary: [`not the production line-up (no channel ${missingChannels.join(', ')}) — nothing done`] };
  }
  if (db.prepare("SELECT 1 FROM BlockTemplate WHERE name LIKE 'Junior Grades 2-3 %'").get()) {
    return { ops, summary: ['grade-pair templates already exist — nothing done'] };
  }
  if (!db.prepare("SELECT 1 FROM BlockTemplate WHERE name LIKE 'Junior Grades 1-2 %'").get()) {
    return { ops, summary: ['the 009 line-up is not there — nothing done'] };
  }

  const retired = (name) => `${name} (retired 2026-10-28 — grade pairs)`;
  const retire = (t) => op("UPDATE BlockTemplate SET weekdays = '', weekday = '', name = ? WHERE id = ?", retired(t.name), t.id);

  // --- Retire --------------------------------------------------------------
  let n = 0;
  for (const [tid, name, ch] of RETIRE) {
    const t = find(tid, name, ch);
    if (t) { retire(t); n++; } else skip(`retire "${name}" (${ch})`);
  }
  for (const [ch, prefix] of RETIRE_PREFIX) {
    for (const t of db.prepare(`SELECT * FROM BlockTemplate WHERE channel_id = ? AND name LIKE ? AND weekdays != ''`)
      .all(channels[ch].id, `${prefix}%`)) { retire(t); n++; }
  }
  summary.push(`${n} template(s) retired: 009's grade bands, Academics, Teen Ack, and the local shows that only aired 09:00–15:00`);

  // --- New times (retire + clone) -----------------------------------------
  const tplId = '(SELECT MAX(id) FROM BlockTemplate WHERE channel_id = ? AND name = ?)';
  for (const [tid, name, ch, slots] of RETIME) {
    const t = find(tid, name, ch);
    if (!t) { skip(`new times for "${name}" (${ch})`); continue; }
    op(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, target_subject_id, target_subject,
          content_type, max_per_show, is_movie_block, movie_limit)
        SELECT channel_id, name, weekday, weekdays, ?, ?, target_subject_id, target_subject, content_type, max_per_show,
          is_movie_block, movie_limit FROM BlockTemplate WHERE id = ?`, slots[0][0], slots[0][1], t.id);
    retire(t);
    op(`INSERT INTO BlockTemplateChannel (template_id, channel_id) SELECT ${tplId}, channel_id FROM BlockTemplateChannel WHERE template_id = ?`,
      t.channel_id, name, t.id);
    op(`INSERT INTO BlockTemplateSeries (template_id, subject, play_order) SELECT ${tplId}, subject, play_order
        FROM BlockTemplateSeries WHERE template_id = ?`, t.channel_id, name, t.id);
    slots.forEach(([s, e], i) => op(`INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (${tplId}, ?, ?, ?)`,
      t.channel_id, name, s, e, i ? 1 : 0));
  }
  summary.push(`${RETIME.length} template(s) moved: morning shows to 09:00, afternoon shows to 15:00–17:00, local shows to their evening airing`);

  for (const [tid, name, ch, series, weekdays] of RESERIES) {
    const t = find(tid, name, ch);
    if (!t) { skip(`series of "${name}" (${ch})`); continue; }
    if (weekdays) op('UPDATE BlockTemplate SET weekdays = ?, weekday = ? WHERE id = ?', weekdays, weekdays.split(',')[0], t.id);
    op('DELETE FROM BlockTemplateSeries WHERE template_id = ?', t.id);
    series.forEach((s, i) => op('INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, ?, ?)', t.id, s, i));
    summary.push(`"${name}" (${ch}) replays its channel's new grades${weekdays ? `, ${weekdays} only` : ''}`);
  }

  // --- New templates -------------------------------------------------------
  const have = new Map();
  const approvedSubjects = (chId) => {
    if (!have.has(chId)) {
      have.set(chId, new Set(db.prepare('SELECT DISTINCT subject FROM Resource WHERE channel_id = ? AND approved = 1 AND subject IS NOT NULL')
        .all(chId).map((r) => r.subject)));
    }
    return have.get(chId);
  };
  const clips = (chId, subject) => db.prepare(
    'SELECT COUNT(*) AS n FROM Resource WHERE channel_id = ? AND subject = ? AND approved = 1 AND is_filler = 0').get(chId, subject).n;
  const missing = new Map();
  let backedUp = 0;
  const insert = (chName, t, fallback = []) => {
    const ch = channels[chName];
    let series = t.series.filter((s) => {
      if (approvedSubjects(ch.id).has(s)) return true;
      if (!missing.has(chName)) missing.set(chName, new Set());
      missing.get(chName).add(s);
      return false;
    });
    // A period whose subject the catalogue hardly has (no Science for Grades
    // 10–11, no electives for 8–9) would air fillers: the pair's English and
    // Mathematics follow it, and fill whatever it can't.
    if (fallback.length && series.reduce((n, s) => n + clips(ch.id, s), 0) < 6) {
      series = [...new Set([...series, ...fallback.filter((s) => approvedSubjects(ch.id).has(s))])];
      backedUp++;
    }
    op(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, content_type, is_movie_block)
        VALUES (?, ?, ?, ?, ?, ?, 'series', 0)`, ch.id, t.name, t.weekdays.split(',')[0], t.weekdays, t.slots[0][0], t.slots[0][1]);
    op(`INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (${tplId}, ?)`, ch.id, t.name, ch.id);
    t.slots.forEach(([s, e], i) => op(`INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (${tplId}, ?, ?, ?)`,
      ch.id, t.name, s, e, i ? 1 : 0));
    series.forEach((s, i) => op(`INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (${tplId}, ?, ?)`,
      ch.id, t.name, s, i));
  };
  for (const cfg of PAIRS) {
    const tpls = expandPair(cfg);
    const fallback = cfg.grades.flatMap((g) => [`Grade ${g} English Language`, `Grade ${g} Mathematics`]);
    // Recess and lunch are breaks, not periods: they never borrow a lesson.
    tpls.forEach((t) => insert(cfg.channel, t, /Recess|Lunch/.test(t.name) ? [] : fallback));
    summary.push(`${cfg.channel}: ${cfg.label} — ${tpls.length} template(s), Mon–Fri 09:00–15:00`
      + (cfg.replay ? ', replayed 00:00–06:00 and mornings 17:00–20:00' : ''));
  }
  for (const t of EXTRA) insert(t.channel, t);
  summary.push('Elementary nursery 08–09; the analog channel repeats Grades 6–7 00–03 and 8–9 03–06, documentaries 09–12, TV shows 13–15');
  for (const [ch, set] of missing) summary.push(`${ch}: not in its approved catalogue, left out: ${[...set].join(', ')}`);
  if (backedUp) summary.push(`${backedUp} period(s) with little or no catalogue for their subject also draw the pair's English and Mathematics`);

  const cleared = clearBlocksAfter(localDate());
  ops.push(...cleared.ops);
  summary.push(...cleared.summary);
  summary.push('next: Generate drafts from tomorrow, Check week, approve and push');
  return { ops, summary };
}
