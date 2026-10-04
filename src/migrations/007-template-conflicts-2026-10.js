// Template conflicts and gaps found in the production schedule on 2026-10-04,
// fixed as decided with the operator that day.
//
// OTAV plays a channel-day as ONE continuous playlist, so two templates that
// claim the same time both air, back to back, and push the rest of the day
// late; and time no template covers is the day running out early. The week
// check (services/dayCoverage.js) reports both and the push refuses them. These
// are the ones the production data had:
//
//   1. Tuesday 06:00–08:00 aired twice on Discover (templates 1 and 17) and on
//      Elevate (17 and 18). Template 17 is retired: no weekday any more, so it
//      is never generated again, and renamed so the operator can tell.
//   2. Elevate 11:30, Tuesday and Friday: Yoga on the Beach (33) and Math
//      Intervention (38). Yoga keeps Monday and Thursday only.
//   3. Elevate Mon/Thu: Your Government & You (35) ran 12:30–13:05 into Let's
//      Talk Autism at 13:00. It now ends at 13:00.
//   4. Elementary weekends: "Elementary Weekend 10 - 12" (115) ran 10:00–23:59
//      over the 12:00, 15:00 and 17:00 blocks. It now ends at 12:00, as named.
//   5. MoE Central had nothing at 19:00–19:30 on weekdays: the evening repeats
//      the morning line-up (08:00 Tongues … 10:30 Agri Talk) and skipped Yoga on
//      the Beach (67, 10:00). It gets its repeat at 19:00.
//   6. Elevate Wednesday had nothing 17:00–20:00: the evening repeat of the
//      other weekdays (26–31) does not run on Wednesday, which has its own
//      morning line-up (43–47, 08:00–10:30, the last one covering to 11:00).
//      Those get their repeats at 17:00–20:00, the same pattern. (Adding Wednesday to 26–31 instead would
//      have put two programmes in every morning slot.)
//
// Every change is guarded by what the row looks like NOW (id, name, channel,
// weekdays, times): an installation whose templates were already edited by
// hand, or that has different ids, is left alone for that item and the summary
// says so. Blocks already generated for an airing that no longer exists — from
// today on, never one already on air today — are removed together with what
// their approval wrote to PlayHistory; the next "Generate drafts" builds the
// new repeats. Run scripts/cleanup/14-template-conflicts.js to see the plan
// without applying it.

import { db } from '../db.js';
import { localDate } from '../dates.js';

export const id = '007-template-conflicts-2026-10';
export const description = 'fix the overlapping / missing template slots found on 2026-10-04';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayOf = (date) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];

function template(id, name, channelName) {
  const t = db.prepare('SELECT * FROM BlockTemplate WHERE id = ? AND name = ?').get(id, name);
  if (!t) return null;
  if (channelName) {
    const on = db.prepare(`
      SELECT 1 FROM BlockTemplateChannel btc JOIN ChannelType c ON c.id = btc.channel_id
      WHERE btc.template_id = ? AND c.name = ?
      UNION SELECT 1 FROM ChannelType c WHERE c.id = ? AND c.name = ?`).get(id, channelName, t.channel_id, channelName);
    if (!on) return null;
  }
  return t;
}
const slotsOf = (tplId) => db.prepare('SELECT * FROM BlockTemplateSlot WHERE template_id = ? ORDER BY slot_order').all(tplId);
const days = (t) => String(t.weekdays || t.weekday || '');

export function plan() {
  const ops = [];
  const summary = [];
  const op = (sql, ...params) => ops.push({ sql, params });
  const skip = (what) => summary.push(`skipped — ${what} (templates differ from 2026-10-04; check by hand)`);
  // Airings that stop existing: { templateId, weekdays: Set|null (null = all) }
  const removed = [];

  // 1. Retire template 17.
  const t17 = template(17, 'Morning Shows');
  if (t17 && days(t17) === 'Tue') {
    op("UPDATE BlockTemplate SET weekdays = '', weekday = '', name = ? WHERE id = 17",
      'Morning Shows (retired 2026-10 — duplicated Tuesday 06:00)');
    summary.push('template 17 "Morning Shows" (Tue 06:00, Discover + Elevate) retired: it duplicated templates 1 and 18');
    removed.push({ templateId: 17, weekdays: null });
  } else skip('template 17 "Morning Shows" is not the Tuesday duplicate');

  // 2. Yoga on the Beach (Elevate 11:30) keeps Mon/Thu.
  const t33 = template(33, 'Yoga on the Beach', 'Elevate');
  if (t33 && days(t33) === 'Mon,Tue,Thu,Fri') {
    op("UPDATE BlockTemplate SET weekdays = 'Mon,Thu', weekday = 'Mon' WHERE id = 33");
    summary.push('template 33 "Yoga on the Beach" (Elevate 11:30): Mon,Tue,Thu,Fri → Mon,Thu (Math Intervention keeps Tue/Fri)');
    removed.push({ templateId: 33, weekdays: new Set(['Tue', 'Fri']) });
  } else skip('template 33 "Yoga on the Beach" weekdays');

  // 3. Your Government & You ends at 13:00.
  const t35 = template(35, 'Your Government & You', 'Elevate');
  const s35 = t35 && slotsOf(35);
  if (t35 && s35.length === 1 && s35[0].start_time === '12:30' && s35[0].end_time === '13:05') {
    op("UPDATE BlockTemplate SET end_time = '13:00' WHERE id = 35");
    op("UPDATE BlockTemplateSlot SET end_time = '13:00' WHERE id = ?", s35[0].id);
    summary.push('template 35 "Your Government & You" (Elevate): 12:30–13:05 → 12:30–13:00');
  } else skip('template 35 "Your Government & You" times');

  // 4. Elementary Weekend 10 - 12 ends at 12:00.
  const t115 = template(115, 'Elementary Weekend 10 - 12', 'Elementary');
  const s115 = t115 && slotsOf(115);
  if (t115 && s115.length === 1 && s115[0].start_time === '10:00' && s115[0].end_time === '23:59') {
    op("UPDATE BlockTemplate SET end_time = '12:00' WHERE id = 115");
    op("UPDATE BlockTemplateSlot SET end_time = '12:00' WHERE id = ?", s115[0].id);
    summary.push('template 115 "Elementary Weekend 10 - 12": 10:00–23:59 → 10:00–12:00');
  } else skip('template 115 "Elementary Weekend 10 - 12" times');

  // 5 + 6. Evening repeats that were missing.
  const repeats = [
    { id: 67, name: 'Yoga on the Beach', channel: 'MoE Central', start: '10:00', at: ['19:00', '19:30'] },
    { id: 43, name: 'Inside NCERD', channel: 'Elevate', start: '08:00', at: ['17:00', '17:30'] },
    { id: 44, name: 'Yoga on the Beach', channel: 'Elevate', start: '08:30', at: ['17:30', '18:00'] },
    { id: 45, name: 'Agri Talk', channel: 'Elevate', start: '09:00', at: ['18:00', '18:30'] },
    { id: 46, name: 'Your Government & You', channel: 'Elevate', start: '09:30', at: ['18:30', '19:00'] },
    // 47's morning airing owns 10:00–11:00 (nothing is scheduled at 10:30 on a
    // Wednesday, so it covers the gap); its repeat is the same hour, 19:00–20:00.
    { id: 47, name: "Let's Talk Autism", channel: 'Elevate', start: '10:00', at: ['19:00', '20:00'] },
  ];
  for (const r of repeats) {
    const t = template(r.id, r.name, r.channel);
    const s = t && slotsOf(r.id);
    if (t && s.length === 1 && s[0].start_time === r.start) {
      op('INSERT OR IGNORE INTO BlockTemplateSlot (template_id, start_time, end_time, slot_order) VALUES (?, ?, ?, 1)',
        r.id, r.at[0], r.at[1]);
      summary.push(`template ${r.id} "${r.name}" (${r.channel}, ${days(t)}): repeat added at ${r.at[0]}–${r.at[1]}`);
    } else skip(`template ${r.id} "${r.name}" repeat`);
  }

  // Blocks of airings that no longer exist. Today stays if it is on OTAV
  // already (it is on air); later days go — a push rebuilds those playlists.
  const today = localDate();
  for (const r of removed) {
    const blocks = db.prepare(`
      SELECT sb.id, sb.target_date, sb.status, COALESCE(sb.channel_id, bt.channel_id) AS channel_id,
             COALESCE(s.start_time, bt.start_time) AS start_time
      FROM ScheduledBlock sb JOIN BlockTemplate bt ON bt.id = sb.template_id
      LEFT JOIN BlockTemplateSlot s ON s.id = sb.slot_id
      WHERE sb.template_id = ? AND sb.target_date >= ?`).all(r.templateId, today);
    let n = 0;
    for (const b of blocks) {
      if (r.weekdays && !r.weekdays.has(weekdayOf(b.target_date))) continue;
      if (b.target_date === today && b.status === 'exported') continue;
      if (b.status !== 'draft') {
        // Approval recorded each clip in PlayHistory; take back one row per clip
        // (as unrecordBlockPlays does), so cooldowns don't count a play that won't happen.
        const playedAt = `${b.target_date}T${b.start_time}:00`;
        for (const it of db.prepare('SELECT resource_id FROM ScheduleItem WHERE block_id = ?').all(b.id)) {
          op(`DELETE FROM PlayHistory WHERE id = (
                SELECT id FROM PlayHistory WHERE resource_id = ? AND channel_id = ? AND played_at = ? LIMIT 1)`,
          it.resource_id, b.channel_id, playedAt);
        }
      }
      op('DELETE FROM ScheduledBlock WHERE id = ?', b.id);
      n++;
    }
    if (n) summary.push(`template ${r.templateId}: removed ${n} block(s) from ${today} on for airings that no longer exist`);
  }

  if (ops.length) summary.push('next: Generate drafts for the affected weeks, then Check week, approve and push');
  return { ops, summary };
}
