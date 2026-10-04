// "No black screens" — the week check.
//
// Per-block validation answers "does this block fit its window?". What actually
// put channels in black was never a block: OTAV plays a channel-day as ONE
// continuous playlist behind ONE schedule event, so the channel goes black
// whenever that playlist ends before the next day's event starts. This module
// simulates exactly what a push would send (see dayBlocks() in otavClient.js —
// approved/exported blocks in slot order, back to back from the first block's
// start) and reports, per channel and day, everything that makes the day end
// early or late:
//
//   not-generated   the day has no blocks at all
//   missing-blocks  a template that airs that day was not instantiated
//   draft           a block is not approved — a push leaves it out entirely
//   overlap         two blocks claim the same time (a template conflict)
//   unfit           a block does not fit its window (and is not forced)
//   missing-file    a scheduled clip's file is not on disk (OTAV skips it)
//   black           the pushed playlist ends before the next day's event
//   overrun         the pushed playlist runs past the next day's event
//   next-unknown    the next day has nothing scheduled, so the end can't be judged
//
// The first seven (and black/overrun) stop a push; next-unknown is a warning —
// the last day of whatever has been generated always has it.

import { db } from '../db.js';
import {
  channelDayBlocks, fitTolerance, fitsTolerance, linkShifts, templateSlots, templateWeekdays,
} from './scheduling.js';
import { missingFilesInRange } from './blockValidation.js';
import { addDays } from '../dates.js';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const BLOCKING = new Set([
  'not-generated', 'missing-blocks', 'draft', 'overlap', 'unfit', 'missing-file', 'black', 'overrun',
]);

const hhmm = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 3600 + m * 60; };
const clock = (secs) => {
  const s = ((Math.round(secs) % 86400) + 86400) % 86400;
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
};

/** The templates (and slots) that should exist for a channel on a date. */
function expectedSlots(channelId, date) {
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const templates = db.prepare(`
    SELECT DISTINCT bt.* FROM BlockTemplate bt
    LEFT JOIN BlockTemplateChannel btc ON btc.template_id = bt.id
    WHERE btc.channel_id = ?
       OR (bt.channel_id = ? AND NOT EXISTS (SELECT 1 FROM BlockTemplateChannel x WHERE x.template_id = bt.id))
  `).all(channelId, channelId);
  const out = [];
  for (const t of templates) {
    if (!templateWeekdays(t).includes(weekday)) continue;
    for (const s of templateSlots(t)) out.push({ template_id: t.id, slot_id: s.id, name: t.name, start_time: s.start_time });
  }
  return out;
}

/**
 * Check a date range. Returns { from, to, ok, channels: [{ id, name, ok,
 * days: [{ date, ok, playlistStart, playlistEnd, nextEventStart, problems }] }] }.
 * Problems are { kind, message, blockId?, seconds?, blocking }.
 */
export async function checkRange(from, to, channelIds = []) {
  const channels = db.prepare(
    `SELECT id, name FROM ChannelType WHERE is_active = 1
     ${channelIds.length ? `AND id IN (${channelIds.map(() => '?').join(',')})` : ''} ORDER BY name`,
  ).all(...channelIds);
  const dates = [];
  for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
  const tol = fitTolerance();

  const totalOf = db.prepare(`
    SELECT COALESCE(SUM(r.duration), 0) AS s FROM ScheduleItem si
    JOIN Resource r ON r.id = si.resource_id WHERE si.block_id = ?`);
  const meta = db.prepare(`
    SELECT sb.override_reason, bt.name AS template_name, sb.template_id, sb.slot_id
    FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id WHERE sb.id = ?`);

  const missing = channels.length
    ? await missingFilesInRange(from, to, channels.map((c) => c.id), { statuses: ['draft', 'approved', 'exported'] })
    : [];

  const report = { from, to, ok: true, channels: [] };
  for (const ch of channels) {
    const chOut = { id: ch.id, name: ch.name, ok: true, days: [] };
    for (const date of dates) {
      const problems = [];
      const add = (kind, message, extra = {}) => problems.push({ kind, message, blocking: BLOCKING.has(kind), ...extra });
      const rows = linkShifts(channelDayBlocks(ch.id, date));
      const day = { date, ok: true, playlistStart: null, playlistEnd: null, nextEventStart: null, problems };

      const expected = expectedSlots(ch.id, date);
      if (!rows.length) {
        if (expected.length) add('not-generated', 'no blocks generated for this day');
        chOut.days.push(finish(day));
        continue;
      }
      const have = new Set(rows.map((r) => {
        const m = meta.get(r.id);
        return `${m.template_id}|${m.slot_id ?? ''}`;
      }));
      const absent = expected.filter((e) => !have.has(`${e.template_id}|${e.slot_id ?? ''}`));
      if (absent.length) {
        add('missing-blocks', `not generated: ${absent.map((e) => `${e.start_time} ${e.name}`).join(', ')}`);
      }

      let content = 0;
      for (const r of rows) {
        const m = meta.get(r.id);
        const label = `${String(r.effective_start).slice(0, 5)} ${m.template_name}`;
        const total = totalOf.get(r.id).s;
        if (r.status === 'draft') add('draft', `${label} is not approved — a push leaves it out`, { blockId: r.id, seconds: total });
        if (r.overlap_seconds > 0) {
          add('overlap', `${label} overlaps the next block by ${r.overlap_seconds}s (template conflict)`, { blockId: r.id, seconds: r.overlap_seconds });
        }
        const diff = r.blockSeconds - total;
        if (!fitsTolerance(diff, tol) && !m.override_reason) {
          add('unfit', `${label} is ${diff > 0 ? `${diff}s short` : `${-diff}s long`}`, { blockId: r.id, seconds: diff });
        }
        if (r.status === 'approved' || r.status === 'exported') content += total;
      }
      for (const f of missing) {
        const here = f.blocks.filter((b) => b.channel_id === ch.id && b.target_date === date);
        if (here.length) {
          add('missing-file', `${f.file_path} is not on disk (${f.error})`, { blockId: here[0].id, seconds: f.seconds });
        }
      }

      // What a push sends: approved/exported, slot order, back to back from the
      // first such block's slot start (dayBlocks / pushChannelDays).
      const aired = rows.filter((r) => r.status === 'approved' || r.status === 'exported');
      if (aired.length) {
        const start = Math.min(...aired.map((r) => hhmm(r.start_time)));
        day.playlistStart = clock(start);
        const end = start + content;
        day.playlistEnd = `${clock(end)}${end >= 86400 ? ' (+1d)' : ''}`;
        const next = linkShifts(channelDayBlocks(ch.id, addDays(date, 1)), { nextDayStart: null });
        if (!next.length) {
          add('next-unknown', 'the next day has nothing scheduled, so where this day must end is unknown');
        } else {
          const nextStart = 86400 + Math.min(...next.map((r) => hhmm(r.start_time)));
          day.nextEventStart = `${clock(nextStart)} (+1d)`;
          const gap = nextStart - end;
          if (gap > tol.maxUnderrun) {
            add('black', `the playlist ends at ${clock(end)} and the next day starts at ${clock(nextStart)}: ${gap}s of black`, { seconds: gap });
          } else if (-gap > tol.maxOverrun) {
            add('overrun', `the playlist runs ${-gap}s into the next day's event`, { seconds: -gap });
          }
        }
      }
      chOut.days.push(finish(day));
    }
    chOut.ok = chOut.days.every((d) => d.ok);
    report.channels.push(chOut);
  }
  report.ok = report.channels.every((c) => c.ok);
  return report;
}

function finish(day) {
  day.ok = !day.problems.some((p) => p.blocking);
  return day;
}

/** The week starting `weekStart` ('YYYY-MM-DD'). */
export function checkWeek(weekStart, channelIds = []) {
  return checkRange(weekStart, addDays(weekStart, 6), channelIds);
}

/** Blocking problems in a check, flattened: [{ channel, date, kind, message }]. */
export function blockingProblems(report, { excludeDates = [] } = {}) {
  const out = [];
  for (const c of report.channels) {
    for (const d of c.days) {
      if (excludeDates.includes(d.date)) continue;
      for (const p of d.problems) if (p.blocking) out.push({ channel: c.name, channel_id: c.id, date: d.date, ...p });
    }
  }
  return out;
}
