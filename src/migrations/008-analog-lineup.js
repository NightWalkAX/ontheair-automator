// The analog channel's catalogue and weekly line-up, as decided with the
// operator on 2026-10-04.
//
// The analog channel (UltraNEXUS-HD) is the network's one multi-purpose
// channel, so it carries a bit of everything the six GLC channels split
// between them:
//
//   Mon–Fri  07–08 cartoons · 08–18 classes, one grade (or two) per hour, with a
//            documentary 12–13 · 18–19 cartoons (the morning's, repeated) ·
//            19–21 TV shows · 21–24 movies · 00–07 the day's classes repeated
//            (Nursery … Grade 9, the 08:00–16:00 hours).
//   Sat/Sun  modelled on Discover: 06–10 cartoons · 10–12 movie (Sunday:
//            EDYOU PULSE 10:00–10:30, then the movie) · 12–15 documentaries ·
//            15–17 movie · 17–20 TV shows · 20–24 movies · 00–06 the
//            documentaries and TV shows repeated.
//
// A block cycles its series in template order, always starting from the
// first, so a block with more series than it has time for airs the same two
// or three every day. That is why cartoons and documentaries get one template
// per weekday, and a grade with more subjects than an hour holds splits them
// between Mon/Wed/Fri and Tue/Thu. Repeats are strict mirrors (slot_order 1):
// the same clips, so the overnight hours cost nothing more on the device disk.
//
// The catalogue: the analog channel arrives with no media roots, so it gets
// every root the other channels have, and their already-scanned catalogue is
// copied across (filing, approval and display names included — the same
// physical files, already vetted). Its series start from their first episode:
// the analog channel has aired none of them through the automator.
//
// Guards: nothing is done for a part the operator has already set up by hand —
// an analog channel that has media roots keeps its catalogue, one that has
// templates keeps its line-up. A subject this catalogue doesn't have is left
// out of its template and named in the summary.

import { db } from '../db.js';

export const id = '008-analog-lineup';
export const description = 'give the analog channel the shared catalogue and its weekly line-up';

const WEEKDAYS = 'Mon,Tue,Wed,Thu,Fri';
const MWF = 'Mon,Wed,Fri';
const TT = 'Tue,Thu';
const WEEKEND = 'Sat,Sun';

const g = (n, ...subjects) => subjects.map((s) => `Grade ${n} ${s}`);

const SITCOMS = ['Different Strokes', 'Family Matters', 'Full House', 'Saved by the Bell', 'Fuller House'];

// { name, weekdays, slots: [[start, end], …repeats], series?, movie? }
// Times are the slot's; 23:59 ends a day, as on the other channels.
export const LINEUP = [
  // Weekday cartoons 07:00, repeated 18:00.
  ...[
    ['Mon', ['Arthur', 'Octonauts', 'Peep and the Big Wide World', 'Curious George']],
    ['Tue', ['Wild Kratts', 'Daniel Tiger', 'Bluey', 'Octonauts Above and Beyond']],
    ['Wed', ['Cyberchase', 'Sid The Science Kid', 'Curious George']],
    ['Thu', ['The Magic School Bus', 'Super Why', 'Bluey']],
    ['Fri', ['Bill Nye The Science Guy', 'Xavier Riddle', 'Peep and the Big Wide World']],
  ].map(([day, series]) => ({
    name: `Analog Cartoons (${day})`, weekdays: day, slots: [['07:00', '08:00'], ['18:00', '19:00']], series,
  })),

  // Classes 08:00–18:00. The 08:00–16:00 hours repeat overnight 00:00–07:00.
  { name: 'Analog Nursery & Grade 1', weekdays: WEEKDAYS, slots: [['08:00', '09:00'], ['00:00', '01:00']],
    series: ['Nursery', ...g(1, 'English Language', 'Mathematics', 'Science', 'Social Studies')] },
  { name: 'Analog Grade 2', weekdays: WEEKDAYS, slots: [['09:00', '10:00'], ['01:00', '02:00']],
    series: g(2, 'English Language', 'Mathematics', 'Science', 'Social Studies') },
  { name: 'Analog Grades 3-4 (Mon/Wed/Fri)', weekdays: MWF, slots: [['10:00', '11:00'], ['02:00', '03:00']],
    series: [...g(3, 'English Language', 'Science'), ...g(4, 'English Language', 'Mathematics')] },
  { name: 'Analog Grades 3-4 (Tue/Thu)', weekdays: TT, slots: [['10:00', '11:00'], ['02:00', '03:00']],
    series: [...g(4, 'Science', 'Social Studies', 'Mathematics'), ...g(3, 'Science')] },
  { name: 'Analog Grade 5', weekdays: WEEKDAYS, slots: [['11:00', '12:00'], ['03:00', '04:00']],
    series: g(5, 'English Language', 'Mathematics', 'Science', 'Social Studies') },
  { name: 'Analog Grade 6', weekdays: WEEKDAYS, slots: [['13:00', '14:00'], ['04:00', '05:00']],
    series: g(6, 'English Language', 'Mathematics', 'Science', 'Social Studies') },
  { name: 'Analog Grade 7 (Mon/Wed/Fri)', weekdays: MWF, slots: [['14:00', '15:00'], ['05:00', '06:00']],
    series: g(7, 'English Language', 'Mathematics', 'Science') },
  { name: 'Analog Grade 7 (Tue/Thu)', weekdays: TT, slots: [['14:00', '15:00'], ['05:00', '06:00']],
    series: g(7, 'Social Studies', 'Spanish', 'English Literature') },
  { name: 'Analog Grade 8 (Mon/Wed/Fri)', weekdays: MWF, slots: [['15:00', '16:00'], ['06:00', '07:00']],
    series: g(8, 'English Language', 'Science', 'Social Studies') },
  { name: 'Analog Grade 9 (Tue/Thu)', weekdays: TT, slots: [['15:00', '16:00'], ['06:00', '07:00']],
    series: g(9, 'English Language', 'Mathematics', 'Social Studies', 'Geography', 'English Literature') },
  { name: 'Analog Grade 10 (Mon/Wed/Fri)', weekdays: MWF, slots: [['16:00', '17:00']],
    series: g(10, 'English Language', 'Mathematics', 'Principles of Business') },
  { name: 'Analog Grade 10 (Tue/Thu)', weekdays: TT, slots: [['16:00', '17:00']],
    series: ['Grade 10 Office Administration', 'Grade 10 English Literature', 'Grade 10'] },
  { name: 'Analog Grade 11 (Mon/Wed/Fri)', weekdays: MWF, slots: [['17:00', '18:00']],
    series: g(11, 'Mathematics', 'English Language', 'Geography') },
  { name: 'Analog Grade 11 (Tue/Thu)', weekdays: TT, slots: [['17:00', '18:00']],
    series: [...g(11, 'Information Technology', 'Principles of Business', 'Social Studies'), 'Grade 11'] },

  // The noon documentary: one series a day leads, the next is its fallback.
  ...[
    ['Mon', ['Cosmos A Space Time Odyssey', 'Life']],
    ['Tue', ['Planet Earth', 'Frozen Planet']],
    ['Wed', ['The Blue Planet', 'Human The World Within']],
    ['Thu', ['Our Planet Frozen Worlds', 'Seven Worlds One Planet']],
    ['Fri', ['South Pacific', 'The Day The Universe Changed', 'Great Barrier Reef']],
  ].map(([day, series]) => ({ name: `Analog Noon Documentary (${day})`, weekdays: day, slots: [['12:00', '13:00']], series })),

  { name: 'Analog Evening TV Shows', weekdays: WEEKDAYS, slots: [['19:00', '21:00']], series: SITCOMS },
  { name: 'Analog Night Movies', weekdays: WEEKDAYS, slots: [['21:00', '23:59']], movie: 2 },

  // Weekends, Discover's shape.
  { name: 'Analog Weekend Cartoons (Sat)', weekdays: 'Sat', slots: [['06:00', '10:00']],
    series: ['Arthur', 'Wild Kratts', 'Cyberchase', 'The Magic School Bus', 'Sid The Science Kid', 'Blues Clues',
      'Dragon Tales', 'Little Einstein'] },
  { name: 'Analog Weekend Cartoons (Sun)', weekdays: 'Sun', slots: [['06:00', '10:00']],
    series: ['Super Why', 'Xavier Riddle', 'Bill Nye The Science Guy', 'Octonauts', 'Bluey',
      'Peep and the Big Wide World', 'Daniel Tiger', 'Curious George', 'Octonauts Above and Beyond'] },
  { name: 'Analog Saturday Morning Movie', weekdays: 'Sat', slots: [['10:00', '12:00']], movie: 1 },
  { name: 'Analog EDYOU PULSE', weekdays: 'Sun', slots: [['10:00', '10:30']], series: ['EDYOU PULSE'] },
  { name: 'Analog Sunday Morning Movie', weekdays: 'Sun', slots: [['10:30', '12:00']], movie: 1 },
  { name: 'Analog Weekend Documentaries (Sat)', weekdays: 'Sat', slots: [['12:00', '15:00'], ['00:00', '03:00']],
    series: ['Planet Earth', 'Life', 'The Blue Planet', 'Frozen Planet'] },
  { name: 'Analog Weekend Documentaries (Sun)', weekdays: 'Sun', slots: [['12:00', '15:00'], ['00:00', '03:00']],
    series: ['Seven Worlds One Planet', 'Our Planet Frozen Worlds', 'South Pacific', 'Great Barrier Reef'] },
  { name: 'Analog Weekend Afternoon Movie', weekdays: WEEKEND, slots: [['15:00', '17:00']], movie: 1 },
  { name: 'Analog Weekend TV Shows', weekdays: WEEKEND, slots: [['17:00', '20:00'], ['03:00', '06:00']], series: SITCOMS },
  { name: 'Analog Weekend Night Movies', weekdays: WEEKEND, slots: [['20:00', '23:59']], movie: 2 },
];

const analogChannel = () => db.prepare("SELECT id, name FROM ChannelType WHERE playout = 'analog'").get();

/** Every root the other channels have, once: [{ path, show_type_id }]. */
const sharedRoots = (analogId) => db.prepare(`
  SELECT path, show_type_id FROM MediaRoot WHERE channel_id != ? GROUP BY path, show_type_id ORDER BY path
`).all(analogId);

/** The channels to copy the catalogue from, the one with the most roots first. */
const donors = (analogId) => db.prepare(`
  SELECT channel_id AS id, COUNT(*) AS roots FROM MediaRoot WHERE channel_id != ?
  GROUP BY channel_id ORDER BY roots DESC, channel_id
`).all(analogId).map((r) => r.id);

export function plan() {
  const ops = [];
  const summary = [];
  const op = (sql, ...params) => ops.push({ sql, params });

  const ch = analogChannel();
  if (!ch) return { ops, summary: ['no analog channel in this database'] };

  // --- Catalogue -------------------------------------------------------------
  const hasRoots = db.prepare('SELECT COUNT(*) AS n FROM MediaRoot WHERE channel_id = ?').get(ch.id).n;
  const from = donors(ch.id);
  // The subjects the analog channel will have: its own if it has a catalogue,
  // otherwise what the copy brings.
  const subjects = new Set(db.prepare(`
    SELECT DISTINCT subject FROM ChannelSeries WHERE channel_id ${hasRoots ? '= ?' : '!= ?'}
  `).all(ch.id).map((r) => r.subject));

  if (hasRoots) {
    summary.push(`${ch.name} already has ${hasRoots} media root(s) — its catalogue is left as it is`);
  } else if (!from.length) {
    summary.push('no other channel has media roots — nothing to copy; add roots to the analog channel by hand');
  } else {
    const roots = sharedRoots(ch.id);
    for (const r of roots) {
      op('INSERT OR IGNORE INTO MediaRoot (channel_id, show_type_id, path) VALUES (?, ?, ?)', ch.id, r.show_type_id, r.path);
    }
    // One copy per file: the donor with the most roots wins, the others only
    // add files it doesn't carry (INSERT OR IGNORE on UNIQUE(channel_id, file_path)).
    for (const donor of from) {
      op(`INSERT OR IGNORE INTO Resource
            (name, file_path, duration, subject, season, chapter, is_filler, audience_rating, channel_id,
             show_type_id, added_at, last_used_at, sort_order, approved)
          SELECT name, file_path, duration, subject, season, chapter, is_filler, audience_rating, ?,
                 show_type_id, added_at, NULL, sort_order, approved
          FROM Resource WHERE channel_id = ?`, ch.id, donor);
      op(`INSERT OR IGNORE INTO ResourceOverride (resource_id, display_name, detected_subject, detected_chapter, detected_season)
          SELECT a.id, o.display_name, o.detected_subject, o.detected_chapter, o.detected_season
          FROM Resource d
          JOIN ResourceOverride o ON o.resource_id = d.id
          JOIN Resource a ON a.channel_id = ? AND a.file_path = d.file_path
          WHERE d.channel_id = ?`, ch.id, donor);
      // The registry without its cursor: the analog channel starts every series
      // at its first episode.
      op(`INSERT OR IGNORE INTO ChannelSeries (channel_id, subject, show_type_id, is_serial, is_active, play_order)
          SELECT ?, subject, show_type_id, is_serial, is_active, play_order FROM ChannelSeries WHERE channel_id = ?`,
      ch.id, donor);
    }
    const files = db.prepare(`SELECT COUNT(DISTINCT file_path) AS n FROM Resource WHERE channel_id IN (${from.map(() => '?').join(',')})`)
      .get(...from).n;
    summary.push(`${ch.name}: ${roots.length} shared media root(s) and their catalogue (${files} file(s)) copied from the other channels`);
  }

  // --- Line-up ---------------------------------------------------------------
  const hasTemplates = db.prepare(`
    SELECT COUNT(*) AS n FROM BlockTemplate bt
    WHERE bt.channel_id = ? OR EXISTS (SELECT 1 FROM BlockTemplateChannel c WHERE c.template_id = bt.id AND c.channel_id = ?)
  `).get(ch.id, ch.id).n;
  if (hasTemplates) {
    summary.push(`${ch.name} already has ${hasTemplates} template(s) — line-up left as it is`);
    return { ops, summary };
  }

  const missing = new Set();
  const tplId = '(SELECT id FROM BlockTemplate WHERE channel_id = ? AND name = ?)';
  let made = 0;
  for (const t of LINEUP) {
    const series = (t.series || []).filter((s) => {
      if (subjects.has(s)) return true;
      missing.add(s);
      return false;
    });
    if (!t.movie && !series.length) {
      summary.push(`skipped "${t.name}": none of its series are in this catalogue`);
      continue;
    }
    const [start, end] = t.slots[0];
    op(`INSERT INTO BlockTemplate (channel_id, name, weekday, weekdays, start_time, end_time, content_type, is_movie_block, movie_limit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ch.id, t.name, t.weekdays.split(',')[0], t.weekdays, start, end, t.movie ? 'movie' : 'series',
    t.movie ? 1 : 0, t.movie || null);
    op(`INSERT INTO BlockTemplateChannel (template_id, channel_id) VALUES (${tplId}, ?)`, ch.id, t.name, ch.id);
    t.slots.forEach(([s, e], i) => {
      op(`INSERT INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (${tplId}, ?, ?, ?)`,
        ch.id, t.name, s, e, i ? 1 : 0);
    });
    series.forEach((s, i) => {
      op(`INSERT INTO BlockTemplateSeries (template_id, subject, play_order) VALUES (${tplId}, ?, ?)`, ch.id, t.name, s, i);
    });
    made++;
  }
  summary.push(`${ch.name}: ${made} template(s) — Mon–Fri cartoons 07 & 18, classes 08–18 (documentary 12–13), `
    + 'TV shows 19–21, movies 21–24, classes repeated 00–07; weekends as Discover, EDYOU PULSE Sunday 10:00');
  if (missing.size) summary.push(`not in this catalogue, left out: ${[...missing].join(', ')}`);
  summary.push('next: Analog tab → scan Vol1 and archive it, then Generate drafts for the analog channel');
  return { ops, summary };
}
