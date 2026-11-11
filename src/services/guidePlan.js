// What a block's channel guide shows (see guideConfig.js for the why).
//
// Rule (operator + GLC direction, 2026-11-10): the guide that closes a block
// lists what is STILL TO COME in the current bracket (06–12, 12–18, 18–24,
// 00–06), counted from the moment the block's window ends. The last block of a
// bracket therefore shows the next bracket — and when a channel is off air for
// a whole bracket, the first bracket that has something.
//
// Times are the playlist's: each block's clips run back to back from its
// shifted window start (what a push sends), fillers left out of the list.
// Consecutive airings of one show fold into one row ("S02E23–E24"), a run of
// lessons into one ("Grade 3 English Language +2 more · 5 lessons"), and a
// bracket never lists more than 10 rows. Pure apart from the SQL reads, so the
// grouping can be tested on its own (groupRows).

import { db } from '../db.js';
import { channelDayBlocks, linkShifts } from './scheduling.js';
import { statedEpisode } from './episodeParse.js';
import { addDays } from '../dates.js';
import { BRACKETS, bracketAt, channelStyle, guideConfig } from './guideConfig.js';

const DAY = 86400;
const dayNumber = (date) => Math.round(Date.parse(`${date}T00:00:00Z`) / 86400000);
const dateOf = (dayNo) => new Date(dayNo * 86400000).toISOString().slice(0, 10);
const hhmm = (t) => { const [h, m] = String(t).split(':').map(Number); return (h || 0) * 3600 + (m || 0) * 60; };
const MAX_ROWS = 10;
const MOVIE_MIN_SECONDS = 2400; // a "movie" shorter than this is a short (Agri Talk clips are filed as Movies)

// Names as the catalogue has them → how the guide prints them. config.guide.titles adds to it.
const TITLE_FIX = {
  edpal: 'EDPAL+ Gala', 'Agri talk new videos': 'Agri Talk', 'Different Strokes': "Diff'rent Strokes",
  HarryPotter4GobletOfFire: 'Harry Potter and the Goblet of Fire', 'Across The Spider Verse': 'Across the Spider-Verse',
  'Raya Last Dragon': 'Raya and the Last Dragon', 'W & G Vengeance Most Fowl': 'Wallace & Gromit: Vengeance Most Fowl',
  'W&G Vengeance Most Fowl': 'Wallace & Gromit: Vengeance Most Fowl',
  'Beauty & Beast Enchanted Cmas': 'Beauty and the Beast: Enchanted Christmas',
  'Pirates! Band Of Misfits': 'The Pirates! Band of Misfits', 'Shaun The Sheep Farmageddon': 'Shaun the Sheep: Farmageddon',
  'The B F G': 'The BFG',
};

/** A file name made readable: "Peter_Pan_(2003)" → "Peter Pan (2003)". */
export function prettyName(name) {
  let s = String(name || '').replace(/\.(mp4|mov|mpg|mxf|avi|mkv)$/i, '');
  s = s.replace(/_/g, ' ').replace(/&/g, ' & ');
  s = s.replace(/(?<=[a-z])(?=[A-Z0-9])/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
function fixTitle(t) {
  const extra = guideConfig().titles || {};
  return extra[t] ?? TITLE_FIX[t] ?? t;
}

/** One clip → { title, tag, kind } as the guide prints it. */
export function describeClip(c) {
  const type = c.show_type_code;
  const movie = type === 'movies' && Number(c.duration) >= MOVIE_MIN_SECONDS;
  if (movie) {
    const raw = c.display_name || c.name;
    const fixed = fixTitle(raw); // a known raw file name, or the pretty form of it
    const title = fixed !== raw ? fixed : fixTitle(c.display_name || prettyName(c.name));
    return { title, tag: 'MOVIE', kind: 'movie' };
  }
  const title = fixTitle(c.subject || c.display_name || prettyName(c.name));
  if (type === 'lessons') return { title, tag: 'LESSON', kind: 'lesson' };
  const ep = statedEpisode(c.name, c.subject) ?? (Number(c.chapter) > 0 && Number(c.chapter) < 1000 ? Number(c.chapter) : null);
  const pad = (n) => String(n).padStart(2, '0');
  const tag = ep == null ? '' : c.season != null ? `S${pad(c.season)}E${pad(ep)}` : `EP ${ep}`;
  return { title, tag, kind: type === 'documentaries' ? 'doc' : 'show' };
}

/**
 * Fold consecutive airings into rows and cap them. `items` are
 * { at, title, tag, kind, duration, file_path } in air order.
 */
export function groupRows(items, max = MAX_ROWS) {
  const rows = [];
  for (const x of items) {
    const last = rows[rows.length - 1];
    if (last && x.kind !== 'movie' && last.kind === x.kind && last.title === x.title) {
      last.n++; last.lastTag = x.tag; continue;
    }
    if (last && x.kind === 'lesson' && last.kind === 'lesson') { // a run of classes is one row
      last.n++; if (!last.subjects.includes(x.title)) last.subjects.push(x.title); continue;
    }
    rows.push({ ...x, n: 1, lastTag: x.tag, subjects: [x.title] });
  }
  for (const r of rows) {
    if (r.kind === 'lesson') {
      r.title = r.subjects.length > 1 ? `${r.subjects[0]} +${r.subjects.length - 1} more` : r.subjects[0];
      r.tag = r.n > 1 ? `${r.n} LESSONS` : 'LESSON';
    } else if (r.n > 1) {
      if (/^S\d+E\d+$/.test(r.tag) && /^S\d+E\d+$/.test(r.lastTag) && r.lastTag !== r.tag) {
        r.tag = r.tag.slice(0, 3) === r.lastTag.slice(0, 3) ? `${r.tag}–${r.lastTag.slice(3)}` : `${r.tag}–${r.lastTag}`;
      } else r.tag = `${r.n} EPS`;
    }
    delete r.subjects; delete r.lastTag;
  }
  if (rows.length > max) {
    const extra = rows.length - (max - 1);
    return [...rows.slice(0, max - 1), { at: rows[max - 1].at, title: `+ ${extra} more programmes`, tag: '', kind: 'more', n: 1 }];
  }
  return rows;
}

let itemsStmt = null;
const itemsOf = { all: (id) => (itemsStmt ??= db.prepare(`
  SELECT r.name, r.subject, r.season, r.chapter, r.duration, r.is_filler, r.file_path,
         st.code AS show_type_code, ov.display_name
  FROM ScheduleItem si
  JOIN Resource r ON r.id = si.resource_id
  LEFT JOIN ShowType st ON st.id = r.show_type_id
  LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
  WHERE si.block_id = ? ORDER BY si.play_order`)).all(id) };

/** Every clip of a channel-day with its absolute air time (seconds since day 0). */
function dayAir(channelId, date) {
  const rows = linkShifts(channelDayBlocks(channelId, date));
  const blocks = [];
  for (const r of rows) {
    const start = dayNumber(r.target_date) * DAY + hhmm(r.start_time) + (r.start_shift || 0);
    let t = start;
    const clips = [];
    for (const c of itemsOf.all(r.id)) {
      if (!c.is_filler) clips.push({ ...c, at: guideTime(t) });
      t += Number(c.duration) || 0;
    }
    blocks.push({ ...r, absStart: start, absEnd: start + r.blockSeconds + (r.guide_seconds || 0), clips });
  }
  return blocks;
}

/**
 * Air time as the guide states it: to the minute, and on the quarter hour when
 * within 90 s of one. Auto-balanced boundaries move blocks by up to a minute,
 * so a programme due at 8:00 really starts 7:59:20 — a guide reads 8:00.
 */
export function guideTime(t) {
  const q = Math.round(t / 900) * 900;
  return Math.abs(t - q) <= 90 ? q : Math.round(t / 60) * 60;
}

function clock12(abs) {
  const s = ((abs % DAY) + DAY) % DAY;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${(h % 12) || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * The guide of one block, or null when the block is gone, its channel has no
 * guide look, or nothing at all airs in the next 24 hours. Returns
 * { blockId, channelId, style, date, bracket, rows, hero, next, airsAt }.
 */
export function guidePlan(blockId) {
  const b = db.prepare('SELECT id, channel_id, target_date FROM ScheduledBlock WHERE id = ?').get(blockId);
  if (!b || b.channel_id == null) return null;
  const style = channelStyle(b.channel_id);
  if (!style) return null;
  const days = [addDays(b.target_date, -1), b.target_date, addDays(b.target_date, 1), addDays(b.target_date, 2)];
  const blocks = days.flatMap((d) => dayAir(b.channel_id, d));
  const me = blocks.find((x) => x.id === blockId);
  if (!me) return null;
  const clips = blocks.flatMap((x) => x.clips).sort((p, q) => p.at - q.at);
  const from = guideTime(me.absEnd);            // what airs after the guide

  const windowOf = (abs) => {
    const day = Math.floor(abs / DAY);
    const br = bracketAt(abs - day * DAY);
    return { br, start: day * DAY + br.from * 3600, end: day * DAY + br.to * 3600, day };
  };
  let w = windowOf(from);
  let lo = from - 30;                           // a clip starting a few seconds early still counts
  let picked = [];
  for (let k = 0; k < 4; k++) {
    picked = clips.filter((c) => c.at >= lo && c.at < w.end);
    if (picked.length) break;
    w = windowOf(w.end); lo = w.start;          // nothing left: the next bracket
  }
  if (!picked.length) return null;
  const described = picked.map((c) => ({ ...describeClip(c), at: c.at, time: clock12(c.at), duration: Number(c.duration) || 0, file_path: c.file_path }));
  const rows = groupRows(described).map((r) => ({ ...r, time: clock12(r.at) }));
  const heroClip = described.find((x) => x.kind === 'movie')
    ?? described.find((x) => x.kind === 'show' || x.kind === 'doc') ?? described[0];
  const nw = windowOf(w.end);
  const next = groupRows(clips.filter((c) => c.at >= nw.start && c.at < nw.end)
    .map((c) => ({ ...describeClip(c), at: c.at, duration: Number(c.duration) || 0 })), 6)
    .slice(0, 5).map((r) => ({ title: r.title, time: clock12(r.at) }));
  return {
    blockId, channelId: b.channel_id, style,
    date: dateOf(w.day), bracket: w.br.key, bracketName: w.br.name,
    airsAt: me.absEnd - (me.guide_seconds || guideConfig().seconds),
    rows, hero: heroClip ? { ...heroClip, time: clock12(heroClip.at) } : null,
    next: { bracket: nw.br.key, bracketName: nw.br.name, date: dateOf(nw.day), rows: next },
  };
}

export { BRACKETS };
