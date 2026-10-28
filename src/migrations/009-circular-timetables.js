// Classes aligned with the Ministry of Education's national timetables, as
// decided with the operator on 2026-10-26.
//
// Circular 5/2026 (primary, Grades 1–6, in force from the third week of the
// 2026–27 school year) and Circular 6/2025 (nursery) fix, per grade and
// weekday, which subject is taught when. The lesson channels now MIRROR them
// during school hours (Mon–Fri 09:00–15:00), so a child at home watches the
// subject their class is doing at that moment:
//
//   Junior      Nursery 08–09, then the Grade 1–2 timetable (the two grades share
//               one); each subject carries Grade 1 and Grade 2.
//   Elementary  the Grade 3–4 timetable (shared too; Grade 4 leads because
//               Grade 3 has almost no catalogue — no Mathematics, no Social Studies).
//   Analog      the Grade 5 timetable, carrying Grade 5 and Grade 6 (Grade 6's
//               differs in places; Grade 5 has the content).
//   TeenEd      Grades 7–9 only (08–11 / 17–20 / 00–06, as before).
//   Discover    Grades 10–11 only (Academics, 08–11 / 17–20).
//
// That gives every grade ONE channel at any hour, which is what the
// cross-channel rule (one series on one channel at a time, 2026-10-21) needs:
// before this, Discover's Academics carried all 50 grade subjects at the same
// hours as Junior, Elementary and TeenEd, and the analog channel's grade hours
// sat on top of the Junior / Elementary overnight replays — 275 blocks of the
// week of 2026-10-26 were red for it.
//
// How a circular becomes templates (expandTimetable(), pure):
//   - Assembly & registration is absorbed into the period that follows it: the
//     morning starts at 09:00, the afternoon at 13:00, lunch is 12:00–13:00.
//   - Each period maps to catalogue series (seriesFor()). Adjacent periods of
//     the same subject merge into one block — less filler.
//   - Literacy Hour / Literacy Studies / Reading / Language Arts are the grade's
//     English Language. Letters & Sounds is R.E.A.D on Junior and the general
//     English Language lessons on Elementary (same hour on both channels, so one
//     series would clash; Literacy has a 34-minute episode, too long for 30).
//   - A teaching period under 30 minutes joins its neighbour in the same session
//     (the one before it, or the one after when it opens the session), and the
//     block carries both subjects in order. Lessons are serial and a serial's due
//     episode longer than its slot is placed with its overrun (red): Grade 5
//     English has 29 episodes over 20 minutes, so 20-minute blocks of it would
//     be red most days. The subject still airs within ~20 minutes of its period.
//   - Beyond Core → La Escuelita de Español, Moral & Civic → Your Government
//     and You, PE → Yoga on the Beach, HFLE → Let's Talk Autism — in a period of
//     30 minutes or more (they hold a handful of ~25-minute episodes); a shorter
//     one only lends its time to the subject it joins.
//   - Recess and lunch get the channel's cartoons. The three channels recess at
//     the same time, so each needs its own short series: Bluey on Junior, Curious
//     George on Elementary, and fillers on the analog channel (no other cartoon
//     is short enough).
//   - Two grades in a period too short for both: the order alternates by day
//     (Mon/Wed/Fri the lower grade first, Tue/Thu the higher), because a block
//     always starts its cycle with its first series.
//   - Identical periods on several weekdays become ONE template with those
//     weekdays. Repeats are strict mirrors: every period airs again 9 hours
//     earlier (00:00–06:00 replays the school day), and on Junior and
//     Elementary the morning (09–12) also airs 8 hours later (17:00–20:00),
//     where the old 17–20 lesson repeat was.
//
// The rest of each weekday moves around it: Junior 15–17 and Elementary 15–17
// keep their afternoon shows (formerly 11–17), Elementary's morning cartoons run
// to 09:00, the analog channel's noon documentary is its lunch (repeated 17:00
// and 03:00), a documentary at 08:00 (repeated 06:00), Behind The Signal 15:00
// (its own template now — the MoE Central one airs 14:00) and secondary classes
// 15:30–17:00, when neither TeenEd nor Discover has them on. Weekend overnight
// replays stay. Elevate's Tue/Wed/Fri 11:00–14:00 line-up is re-ordered so none
// of its shows touches MoE Central's airing of the same show.
//
// Guards: every existing template is matched by id + name + channel (the ids of
// the production database); one that differs is skipped and named. Every block
// dated AFTER today is removed — approval's PlayHistory rows taken back and the
// series cursors moved back to the first episode those blocks held — so the
// next "Generate drafts" builds the week from the new line-up. Today is never
// touched. scripts/cleanup/17-circular-timetables.js prints the plan.

import { db } from '../db.js';
import { localDate } from '../dates.js';
import { plan as pruneOrphanSeries } from './002-prune-orphan-series.js';

export const id = '009-circular-timetables';
export const description = 'align the lesson channels with MoE circulars 5/2026 and 6/2025 (one grade per channel)';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// The circulars, assembly absorbed (see above). [start, end, subject].
// Grades 1 and 2 share one timetable, as do 3 and 4.
export const TIMETABLES = {
  g12: {
    Mon: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Literacy'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:05', 'Social Studies'],
      ['11:05', '12:00', 'Mathematics'], ['12:00', '13:00', 'LUNCH'], ['13:00', '13:40', 'Reading'], ['13:40', '14:00', 'Science'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Beyond Core'], ['14:30', '15:00', 'Support:Literacy']],
    Tue: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:05', 'Reading'],
      ['11:05', '12:00', 'Literacy'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Social Studies'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Science'], ['14:30', '15:00', 'Support:Mathematics']],
    Wed: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Literacy'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:05', 'Social Studies'],
      ['11:05', '12:00', 'Mathematics'], ['12:00', '13:00', 'LUNCH'], ['13:00', '13:40', 'Reading'], ['13:40', '14:00', 'PE'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'PE'], ['14:30', '15:00', 'Support:Literacy']],
    Thu: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:05', 'Language Arts'],
      ['11:05', '12:00', 'Literacy'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Science'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Reading'], ['14:30', '15:00', 'Support:Mathematics']],
    Fri: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Literacy'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:05', 'Science'],
      ['11:05', '12:00', 'Mathematics'], ['12:00', '13:00', 'LUNCH'], ['13:00', '13:40', 'Moral & Civic'], ['13:40', '14:00', 'Social Studies'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'HFLE'], ['14:30', '15:00', 'Support:Literacy']],
  },
  g34: {
    Mon: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Literacy'],
      ['11:35', '12:00', 'Reading'], ['12:00', '13:00', 'LUNCH'], ['13:00', '13:40', 'Science'], ['13:40', '14:00', 'Language Arts'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '15:00', 'Social Studies']],
    Tue: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Literacy'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Mathematics'],
      ['11:35', '12:00', 'HFLE'], ['12:00', '13:00', 'LUNCH'], ['13:00', '13:40', 'Language Arts'], ['13:40', '14:00', 'Reading'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '15:00', 'PE']],
    Wed: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Science'],
      ['11:35', '12:00', 'Moral & Civic'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Literacy'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:40', 'Social Studies'], ['14:40', '15:00', 'Reading']],
    Thu: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:05', 'Reading'],
      ['11:05', '11:35', 'Social Studies'], ['11:35', '12:00', 'Language Arts'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Literacy'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:40', 'Science'], ['14:40', '15:00', 'Reading']],
    Fri: [['09:00', '09:30', 'L&S'], ['09:30', '10:30', 'Literacy'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Mathematics'],
      ['11:35', '12:00', 'Language Arts'], ['12:00', '13:00', 'LUNCH'], ['13:00', '13:40', 'Social Studies'], ['13:40', '14:00', 'Reading'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:40', 'Science'], ['14:40', '15:00', 'Beyond Core']],
  },
  g56: {
    Mon: [['09:00', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '12:00', 'Literacy'], ['12:00', '13:00', 'LUNCH'],
      ['13:00', '14:00', 'Science'], ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Reading'], ['14:30', '15:00', 'Social Studies']],
    Tue: [['09:00', '10:00', 'Literacy'], ['10:00', '10:30', 'Beyond Core'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Mathematics'],
      ['11:35', '12:00', 'Language Arts'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Social Studies'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '14:30', 'Reading'], ['14:30', '15:00', 'HFLE']],
    Wed: [['09:00', '10:00', 'Mathematics'], ['10:00', '10:30', 'Moral & Civic'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Social Studies'],
      ['11:35', '12:00', 'Language Arts'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Literacy'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '15:00', 'Science']],
    Thu: [['09:00', '10:00', 'Literacy'], ['10:00', '10:30', 'Science'], ['10:30', '10:45', 'RECESS'], ['10:45', '12:00', 'Mathematics'],
      ['12:00', '13:00', 'LUNCH'], ['13:00', '13:30', 'Reading'], ['13:30', '14:00', 'Language Arts'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '15:00', 'PE']],
    Fri: [['09:00', '09:40', 'Language Arts'], ['09:40', '10:30', 'Mathematics'], ['10:30', '10:45', 'RECESS'], ['10:45', '11:35', 'Social Studies'],
      ['11:35', '12:00', 'Reading'], ['12:00', '13:00', 'LUNCH'], ['13:00', '14:00', 'Literacy'],
      ['14:00', '14:10', 'RECESS'], ['14:10', '15:00', 'Science']],
  },
};

const ENGLISH = new Set(['Literacy', 'Reading', 'Language Arts']);
const ENRICHMENT = {
  'Beyond Core': ['La Escuelita de Español'],
  'Moral & Civic': ['Your Government and You'],
  PE: ['Yoga on the Beach'],
  HFLE: ["Let's Talk Autism", 'Inside NCERD'],
};
/** Shortest teaching period that is a block of its own; shorter ones join a neighbour. */
export const MIN_PERIOD_MINUTES = 30;

// One channel per grade band. `grades` lead → follow (fallback / alternate).
export const BANDS = [
  { band: 'g12', channel: 'Junior', label: 'Grades 1-2', grades: [1, 2], letters: ['R.E.A.D'], alternate: true,
    recess: ['Bluey'], lunch: ['Daniel Tiger', 'Octonauts', 'Bluey'], evening: true },
  { band: 'g34', channel: 'Elementary', label: 'Grades 3-4', grades: [4, 3], letters: ['English Language'], alternate: false,
    recess: ['Curious George'], lunch: ['Arthur', 'Cyberchase', 'Octonauts Above and Beyond'], evening: true },
  // The analog channel's recess is fillers and its lunch is its noon documentary
  // (existing templates).
  { band: 'g56', channel: 'Analog', label: 'Grades 5-6', grades: [5, 6], letters: [], alternate: true,
    recess: [], lunch: null, evening: false },
];

const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const grade = (n, subject) => `Grade ${n} ${subject}`;
const BREAKS = new Set(['RECESS', 'LUNCH']);

/** The catalogue series one period of `cfg`'s timetable airs, on `day`. */
export function seriesFor(cfg, subject, day, minutes) {
  if (subject === 'RECESS') return cfg.recess;
  if (subject === 'LUNCH') return cfg.lunch;
  if (subject === 'L&S') return cfg.letters.length ? cfg.letters : cfg.grades.map((g) => grade(g, 'English Language'));
  if (ENRICHMENT[subject]) return minutes >= MIN_PERIOD_MINUTES ? ENRICHMENT[subject] : [];
  const s = subject.startsWith('Support:') ? subject.slice(8) : subject;
  const name = ENGLISH.has(s) ? 'English Language' : s;
  // Two grades: when the period can't hold both, alternate which leads.
  const order = cfg.alternate && minutes < 40 && (day === 'Tue' || day === 'Thu') ? [...cfg.grades].reverse() : cfg.grades;
  return order.map((g) => grade(g, name));
}

/** One day of a timetable as blocks: [{ start, end, parts: [{ subject, minutes }] }]. */
export function dayBlocks(rows) {
  // What a period IS, for merging: the English periods are one subject.
  const kind = (subject) => {
    const s = subject.startsWith('Support:') ? subject.slice(8) : subject;
    return ENGLISH.has(s) ? 'English' : s;
  };
  const blocks = [];
  for (const [start, end, subject] of rows) {
    const prev = blocks[blocks.length - 1];
    const part = { subject, minutes: mins(end) - mins(start) };
    if (prev && prev.end === start && kind(prev.parts[prev.parts.length - 1].subject) === kind(subject)) {
      prev.end = end;
      prev.parts.push(part);
    } else blocks.push({ start, end, parts: [part] });
  }
  // A short teaching block joins its neighbour in the same session: the one
  // before it, or the one after when it opens the session.
  const len = (b) => mins(b.end) - mins(b.start);
  const teaching = (b) => b && !BREAKS.has(b.parts[0].subject);
  for (let i = 0; i < blocks.length;) {
    const b = blocks[i];
    if (!teaching(b) || len(b) >= MIN_PERIOD_MINUTES) { i++; continue; }
    if (teaching(blocks[i - 1])) {
      const prev = blocks[i - 1];
      prev.end = b.end;
      prev.parts.push(...b.parts);
      blocks.splice(i, 1);
    } else if (teaching(blocks[i + 1])) {
      const next = blocks[i + 1];
      next.start = b.start;
      next.parts.unshift(...b.parts);
      blocks.splice(i, 1);
    } else i++;
  }
  return blocks;
}

/**
 * One grade band's timetable → templates:
 * [{ name, weekdays, slots: [[start, end], …mirrors], series }]
 */
export function expandTimetable(cfg) {
  const periods = []; // { day, start, end, series, subject }
  for (const day of DAYS) {
    for (const b of dayBlocks(TIMETABLES[cfg.band][day])) {
      // Each subject's series follow its own length (two grades alternate only
      // in a short period), in the order the periods come.
      const lists = b.parts.map((p) => seriesFor(cfg, p.subject, day, p.minutes));
      if (lists.every((l) => l === null)) continue; // the channel's own lunch template covers it
      const series = [...new Set(lists.flatMap((l) => l || []))];
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
      const slots = [[p.start, p.end], [hhmm(mins(p.start) - 9 * 60), hhmm(mins(p.end) - 9 * 60)]];
      if (cfg.evening && mins(p.end) <= 12 * 60) slots.push([hhmm(mins(p.start) + 8 * 60), hhmm(mins(p.end) + 8 * 60)]);
      const what = p.subject.replace(/Support:/g, 'Support ').replace(/RECESS/, 'Recess').replace(/LUNCH/, 'Lunch');
      return {
        name: `${cfg.channel} ${cfg.label} ${p.start} ${what} (${p.days.length === 5 ? 'Mon-Fri' : p.days.join('/')})`,
        weekdays: p.days.join(','), slots, series: p.series,
      };
    });
}

// The analog channel's documentaries, chosen among the series no other channel
// airs at 03, 06, 08, 12 or 17 that weekday (and under an hour an episode):
// [day, noon (12:00, again 17:00 and 03:00), morning (08:00, again 06:00)].
export const ANALOG_DOCS = [
  ['Mon', ['Planet Earth', 'South Pacific'], ['Frozen Planet', 'South Pacific']],
  ['Tue', ['The Day The Universe Changed', 'Our Planet Frozen Worlds'], ['Cosmos A Space Time Odyssey', 'Human The World Within']],
  ['Wed', ['The Blue Planet', 'Planet Earth'], ['Frozen Planet', 'The Day The Universe Changed']],
  ['Thu', ['Our Planet Frozen Worlds', 'Human The World Within'], ['Cosmos A Space Time Odyssey', 'Human The World Within']],
  ['Fri', ['South Pacific', 'The Blue Planet'], ['Planet Earth', 'The Day The Universe Changed']],
];
const g = (n, ...subjects) => subjects.map((s) => grade(n, s));
export const EXTRA = [
  { channel: 'Junior', name: 'Junior Nursery 08-09', weekdays: DAYS.join(','), slots: [['08:00', '09:00']],
    series: ['Nursery', 'Numeracy', 'R.E.A.D'] },
  ...ANALOG_DOCS.map(([day, , series]) => ({
    channel: 'Analog', name: `Analog Morning Documentary (${day})`, weekdays: day, slots: [['08:00', '09:00'], ['06:00', '07:00']], series,
  })),
  { channel: 'Analog', name: 'Analog Behind The Signal', weekdays: 'Mon,Wed,Thu,Fri', slots: [['15:00', '15:30']], series: ['Behind The Signal'] },
  { channel: 'Analog', name: 'Analog Secondary Grades 7-9 (Mon)', weekdays: 'Mon', slots: [['15:30', '17:00']],
    series: [...g(7, 'English Language', 'Mathematics'), ...g(8, 'Science'), ...g(9, 'Social Studies')] },
  { channel: 'Analog', name: 'Analog Secondary Grades 7-9 (Wed)', weekdays: 'Wed', slots: [['15:30', '17:00']],
    series: [...g(8, 'English Language', 'Social Studies'), ...g(9, 'Mathematics'), ...g(7, 'Science')] },
  { channel: 'Analog', name: 'Analog Secondary Grades 7-9 (Fri)', weekdays: 'Fri', slots: [['15:30', '17:00']],
    series: [...g(9, 'English Language', 'Geography'), ...g(7, 'Social Studies', 'Spanish', 'English Literature')] },
  { channel: 'Analog', name: 'Analog Secondary Grades 10-11 (Tue)', weekdays: 'Tue', slots: [['15:00', '17:00']],
    series: [...g(10, 'English Language', 'Mathematics', 'Principles of Business'), ...g(11, 'Mathematics', 'English Language')] },
  { channel: 'Analog', name: 'Analog Secondary Grades 10-11 (Thu)', weekdays: 'Thu', slots: [['15:30', '17:00']],
    series: [...g(11, 'Geography', 'Information Technology', 'Social Studies'), ...g(10, 'Office Administration', 'English Literature')] },
];

// Existing templates, by the production ids, name and channel.
const RETIRE = [
  [93, 'Junior Ack 8 to 11 and 5 to 8', 'Junior'],
  [99, 'Elementary 8 to 11 and 5 to 8', 'Elementary'],
  [124, 'Analog Nursery & Grade 1', 'Analog'], [125, 'Analog Grade 2', 'Analog'],
  [126, 'Analog Grades 3-4 (Mon/Wed/Fri)', 'Analog'], [127, 'Analog Grades 3-4 (Tue/Thu)', 'Analog'],
  [128, 'Analog Grade 5', 'Analog'], [129, 'Analog Grade 6', 'Analog'],
  [130, 'Analog Grade 7 (Mon/Wed/Fri)', 'Analog'], [131, 'Analog Grade 7 (Tue)', 'Analog'],
  [132, 'Analog Grade 8 (Mon/Wed/Fri)', 'Analog'], [133, 'Analog Grade 9 (Tue/Thu)', 'Analog'],
  [134, 'Analog Grade 10 (Mon/Wed/Fri)', 'Analog'], [135, 'Analog Grade 10 (Tue/Thu)', 'Analog'],
  [136, 'Analog Grade 11 (Mon/Wed/Fri)', 'Analog'], [137, 'Analog Grade 11 (Tue/Thu)', 'Analog'],
  [156, 'Analog Grade 7 (Thu)', 'Analog'], [157, 'Analog Grade 7 Night (Mon/Wed/Fri)', 'Analog'],
  [158, 'Analog Grade 7 Night (Thu)', 'Analog'],
];
// [id, name, channel, weekdays, slots, series?] — the overnight lesson replays keep only
// the weekend (the circular replay covers Mon–Fri), the shows move to 15–17.
const RESHAPE = [
  [97, 'Junior 12 to 6 Replay', 'Junior', 'Sat,Sun', null],
  [103, 'Elementary 12 to 6 Replay', 'Elementary', 'Sat,Sun', null],
  [94, 'Junior 11 to 5', 'Junior', null, [['15:00', '17:00']]],
  [100, 'Elementary 11 - 5', 'Elementary', null, [['15:00', '17:00']]],
  [98, 'Elementart 6 to 8', 'Elementary', null, [['06:00', '09:00']]],
  // The analog channel's noon documentary is its lunch, and airs again at 17:00
  // and 03:00 — with series nobody else has on at those hours (ANALOG_DOCS).
  ...[138, 139, 140, 141, 142].map((tid, i) => [tid, `Analog Noon Documentary (${DAYS[i]})`, 'Analog', null,
    [['12:00', '13:00'], ['17:00', '18:00'], ['03:00', '04:00']], ANALOG_DOCS[i][1]]),
  // Elevate Tue/Wed/Fri, re-ordered against MoE Central's airings of the same
  // shows (MoE: Math Intervention 11:30, Beatin da Maths 12:15, Forts 13:00,
  // Cho 13:30) — no Elevate airing overlaps or even touches one.
  [40, 'Forts & Monuments', 'Elevate', null, [['11:00', '11:30']]],
  [42, 'The Amazing World of Cho', 'Elevate', null, [['11:30', '12:00']]],
  [37, 'New Enhanced Curriculum', 'Elevate', null, [['12:00', '12:30']]],
  [41, 'Students of Guyana', 'Elevate', null, [['12:30', '13:00']]],
  [38, 'Math Intervention', 'Elevate', null, [['13:00', '13:30']]],
  [39, 'Beatin da Maths', 'Elevate', null, [['13:30', '14:00']]],
  // EDYOU PULSE aired on the analog channel and MoE Central at the same Sunday
  // 10:00, so one of them always aired fillers: the analog film goes first.
  [149, 'Analog Sunday Morning Movie', 'Analog', null, [['10:00', '11:30']]],
  [148, 'Analog EDYOU PULSE', 'Analog', null, [['11:30', '12:00']]],
];
// The film slots of MoE Central, Junior, Elementary and TeenEd were plain
// blocks of the "Movies" series: one film after another until the next didn't
// fit, then 20–30 minutes of filler in one run. As movie blocks they search for
// the run of films that fills the slot best, like Discover's and Elevate's.
// [id, name, channel, movie_limit] (null = config.movies.maxPerBlock).
const MOVIE_BLOCKS = [
  [87, 'Night Movies', 'MoE Central', 3],
  [96, 'Junior 8 Movies', 'Junior', 3],
  [102, 'Elementary 8 Movies', 'Elementary', 3],
  [90, 'Teem Movie 8', 'TeenEd', 3],
  [110, 'Junior Weekend 10  am- 12 pm', 'Junior', null],
  [112, 'Junior Weekend 3 pm to 5 pm', 'Junior', null],
  [115, 'Elementary Weekend 10 - 12', 'Elementary', null],
  [118, 'Elementary Weekend 3 - 5', 'Elementary', null],
  [105, 'Teen Weekend 10 - 12', 'TeenEd', null],
  [107, 'Teen Weekend 3 - 5', 'TeenEd', null],
];

// [id, name, channel, keep(subject)] — the grades a template keeps.
const SECONDARY = (s) => /^Grade (7|8|9)\b/.test(s);
const UPPER = (s) => /^Grade 1[01]\b/.test(s);
const FILTER_SERIES = [
  [78, 'Teen Ack 8 to 11 and 5 to 8', 'TeenEd', SECONDARY],
  [91, 'Teen 12 to 6', 'TeenEd', SECONDARY],
  [2, 'Academics', 'Discover', UPPER],
];

function template(tid, name, channelName) {
  const t = db.prepare('SELECT * FROM BlockTemplate WHERE id = ? AND name = ?').get(tid, name);
  if (!t) return null;
  const on = db.prepare(`
    SELECT 1 FROM BlockTemplateChannel btc JOIN ChannelType c ON c.id = btc.channel_id
    WHERE btc.template_id = ? AND c.name = ?
    UNION SELECT 1 FROM ChannelType c WHERE c.id = ? AND c.name = ?`).get(tid, channelName, t.channel_id, channelName);
  return on ? t : null;
}
const channelByName = (name) => db.prepare('SELECT id, name FROM ChannelType WHERE name = ?').get(name);

/**
 * Remove every block dated after `today`, so "Generate drafts" builds them from
 * a new line-up. Approval wrote PlayHistory (taken back, one row per clip, as
 * unrecordBlockPlays does) and pushed each serial's cursor past what the block
 * held (moved back to the first chapter these blocks held, so no episode is
 * skipped). Read-only: returns { ops, summary }.
 */
export function clearBlocksAfter(today) {
  const ops = [];
  const summary = [];
  const op = (sql, ...params) => ops.push({ sql, params });
  const blocks = db.prepare(`
    SELECT sb.id, sb.target_date, sb.status, COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
           COALESCE(s.start_time, bt.start_time) AS start_time
    FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id
    LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
    WHERE sb.target_date > ?`).all(today);
  const firstChapter = new Map(); // channel|subject -> lowest chapter in a removed approved block
  let approved = 0;
  for (const b of blocks) {
    if (b.status !== 'draft') {
      approved++;
      const playedAt = `${b.target_date}T${b.start_time}:00`;
      const items = db.prepare(`
        SELECT si.resource_id, r.subject, r.chapter, r.is_filler FROM ScheduleItem si
        JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ?`).all(b.id);
      for (const it of items) {
        op(`DELETE FROM PlayHistory WHERE id = (
              SELECT id FROM PlayHistory WHERE resource_id = ? AND channel_id = ? AND played_at = ? LIMIT 1)`,
        it.resource_id, b.channel_id, playedAt);
        if (it.is_filler || it.subject == null) continue;
        const k = `${b.channel_id}|${it.subject}`;
        if (!firstChapter.has(k) || it.chapter < firstChapter.get(k)) firstChapter.set(k, it.chapter);
      }
    }
    op('DELETE FROM ScheduledBlock WHERE id = ?', b.id);
  }
  let rewound = 0;
  for (const [k, chapter] of firstChapter) {
    const [chId, subject] = [Number(k.split('|')[0]), k.slice(k.indexOf('|') + 1)];
    const cur = db.prepare('SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ? AND is_serial = 1').get(chId, subject);
    if (cur?.cursor_chapter != null && cur.cursor_chapter > chapter) {
      op('UPDATE ChannelSeries SET cursor_chapter = ? WHERE channel_id = ? AND subject = ?', chapter, chId, subject);
      rewound++;
    }
  }
  if (blocks.length) {
    summary.push(`${blocks.length} block(s) after ${today} removed (${approved} approved/exported: plays taken back, `
      + `${rewound} series cursor(s) moved back) — today is untouched`);
  }
  return { ops, summary };
}

export function plan() {
  const ops = [];
  const summary = [];
  const op = (sql, ...params) => ops.push({ sql, params });
  const skip = (what) => summary.push(`skipped — ${what} (not as in production on 2026-10-26; check by hand)`);

  const channels = Object.fromEntries(['Junior', 'Elementary', 'Analog', 'TeenEd', 'Discover', 'MoE Central', 'Elevate']
    .map((n) => [n, channelByName(n)]));
  const missingChannels = Object.entries(channels).filter(([, c]) => !c).map(([n]) => n);
  if (missingChannels.length) {
    return { ops, summary: [`not the production line-up (no channel ${missingChannels.join(', ')}) — nothing done`] };
  }
  if (db.prepare("SELECT 1 FROM BlockTemplate WHERE name LIKE 'Junior Grades 1-2 %'").get()) {
    return { ops, summary: ['circular templates already exist — nothing done'] };
  }

  // --- Existing templates ----------------------------------------------------
  for (const [tid, name, ch] of RETIRE) {
    if (template(tid, name, ch)) {
      op("UPDATE BlockTemplate SET weekdays = '', weekday = '', name = ? WHERE id = ?", `${name} (retired 2026-10-26 — circular)`, tid);
    } else skip(`retire template ${tid} "${name}"`);
  }
  summary.push(`${RETIRE.length} lesson templates retired (Junior/Elementary 08–11 & 17–20, the analog channel's grade hours)`);

  const tplId = '(SELECT MAX(id) FROM BlockTemplate WHERE channel_id = ? AND name = ?)';
  for (const [tid, name, ch, weekdays, slots, series] of RESHAPE) {
    const t = template(tid, name, ch);
    if (!t) { skip(`reshape template ${tid} "${name}"`); continue; }
    if (weekdays) op('UPDATE BlockTemplate SET weekdays = ?, weekday = ? WHERE id = ?', weekdays, weekdays.split(',')[0], tid);
    if (slots) {
      // New times are a NEW template: ScheduledBlock.slot_id cascades, so
      // rewriting the slots would delete today's blocks — already on air. The
      // old one is retired (today's blocks keep it) and a copy takes the times.
      op(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, target_subject_id, target_subject,
            content_type, max_per_show, is_movie_block, movie_limit)
          SELECT channel_id, name, weekday, weekdays, ?, ?, target_subject_id, target_subject, content_type, max_per_show,
            is_movie_block, movie_limit FROM BlockTemplate WHERE id = ?`, slots[0][0], slots[0][1], tid);
      op("UPDATE BlockTemplate SET weekdays = '', weekday = '', name = ? WHERE id = ?", `${name} (retired 2026-10-26 — circular)`, tid);
      op(`INSERT INTO BlockTemplateChannel (template_id, channel_id) SELECT ${tplId}, channel_id FROM BlockTemplateChannel WHERE template_id = ?`,
        t.channel_id, name, tid);
      if (series) {
        series.forEach((x, i) => op(`INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (${tplId}, ?, ?)`,
          t.channel_id, name, x, i));
      } else {
        op(`INSERT INTO BlockTemplateSeries (template_id, subject, play_order) SELECT ${tplId}, subject, play_order
            FROM BlockTemplateSeries WHERE template_id = ?`, t.channel_id, name, tid);
      }
      slots.forEach(([s, e], i) => op(
        `INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (${tplId}, ?, ?, ?)`,
        t.channel_id, name, s, e, i ? 1 : 0));
    }
    summary.push(`template ${tid} "${name}" (${ch}): ${[weekdays && `weekdays ${weekdays}`, slots && slots.map((x) => x.join('–')).join(', '),
      series && series.join(', ')].filter(Boolean).join('; ')}`);
  }

  for (const [tid, name, ch, keep] of FILTER_SERIES) {
    if (!template(tid, name, ch)) { skip(`series of template ${tid} "${name}"`); continue; }
    const series = db.prepare('SELECT subject FROM BlockTemplateSeries WHERE template_id = ? ORDER BY play_order').all(tid).map((r) => r.subject);
    const kept = series.filter(keep);
    op('DELETE FROM BlockTemplateSeries WHERE template_id = ?', tid);
    kept.forEach((s, i) => op('INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (?, ?, ?)', tid, s, i));
    summary.push(`template ${tid} "${name}" (${ch}): ${series.length} → ${kept.length} series (${keep === UPPER ? 'Grades 10–11' : 'Grades 7–9'})`);
  }

  let movieBlocks = 0;
  for (const [tid, name, ch, limit] of MOVIE_BLOCKS) {
    const t = template(tid, name, ch);
    if (!t || t.is_movie_block) { if (!t) skip(`movie block ${tid} "${name}"`); continue; }
    op('UPDATE BlockTemplate SET is_movie_block = 1, movie_limit = ? WHERE id = ?', limit, tid);
    movieBlocks++;
  }
  if (movieBlocks) summary.push(`${movieBlocks} film slot(s) on MoE Central, Junior, Elementary and TeenEd are movie blocks now (best-fit runs)`);

  // Behind The Signal was ONE template on MoE Central and the analog channel at
  // the same time: the analog channel gets its own, at 15:00.
  if (template(155, 'Behind The Signal', 'Analog')) {
    op('DELETE FROM BlockTemplateChannel WHERE template_id = 155 AND channel_id = ?', channels.Analog.id);
    op('UPDATE BlockTemplate SET channel_id = ? WHERE id = 155 AND channel_id = ?', channels['MoE Central'].id, channels.Analog.id);
    summary.push('template 155 "Behind The Signal": MoE Central only (14:00); the analog channel airs it at 15:00');
  } else skip('template 155 "Behind The Signal" channels');

  // --- New templates ---------------------------------------------------------
  const approvedSubjects = new Map(); // channel id -> Set of subjects with approved clips
  const subjectsOf = (chId) => {
    if (!approvedSubjects.has(chId)) {
      approvedSubjects.set(chId, new Set(db.prepare(`
        SELECT DISTINCT subject FROM Resource WHERE channel_id = ? AND approved = 1 AND subject IS NOT NULL`).all(chId).map((r) => r.subject)));
    }
    return approvedSubjects.get(chId);
  };
  const missing = new Map();
  const insert = (chName, t) => {
    const ch = channels[chName];
    const have = subjectsOf(ch.id);
    const series = t.series.filter((s) => {
      if (have.has(s)) return true;
      if (!missing.has(chName)) missing.set(chName, new Set());
      missing.get(chName).add(s);
      return false;
    });
    const [start, end] = t.slots[0];
    op(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, content_type, is_movie_block)
        VALUES (?, ?, ?, ?, ?, ?, 'series', 0)`, ch.id, t.name, t.weekdays.split(',')[0], t.weekdays, start, end);
    op(`INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (${tplId}, ?)`, ch.id, t.name, ch.id);
    t.slots.forEach(([s, e], i) => op(
      `INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (${tplId}, ?, ?, ?)`,
      ch.id, t.name, s, e, i ? 1 : 0));
    series.forEach((s, i) => op(`INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (${tplId}, ?, ?)`,
      ch.id, t.name, s, i));
  };
  for (const cfg of BANDS) {
    const tpls = expandTimetable(cfg);
    tpls.forEach((t) => insert(cfg.channel, t));
    summary.push(`${cfg.channel}: ${tpls.length} template(s) mirroring the ${cfg.label} timetable Mon–Fri 09:00–15:00 `
      + `(replayed 00:00–06:00${cfg.evening ? ', mornings again 17:00–20:00' : ''})`);
  }
  for (const t of EXTRA) insert(t.channel, t);
  summary.push(`${EXTRA.length} more: Junior nursery 08–09; analog morning documentary 08 (06), Behind The Signal 15:00, secondary classes 15:30–17:00`);
  for (const [ch, set] of missing) summary.push(`${ch}: not in its approved catalogue, left out: ${[...set].join(', ')}`);

  // --- Blocks after today ----------------------------------------------------
  const cleared = clearBlocksAfter(localDate());
  ops.push(...cleared.ops);
  summary.push(...cleared.summary);

  // Registry rows with no clips and no template (the 002 repair, again: empty
  // folders such as "Grade 1", "Bow", "Christmas Term" came back with later scans).
  const prune = pruneOrphanSeries();
  ops.push(...prune.ops);
  if (prune.ops.length) summary.push(`${prune.ops.length} empty series registry row(s) removed`);

  summary.push('next: Generate drafts for this week and the next, Check week, approve and push (today held)');
  return { ops, summary };
}
