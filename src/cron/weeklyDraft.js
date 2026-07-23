// Weekly draft-generation cron (Module A trigger).
//
// Schedules generateWeek() on the cron expression in config.cron.weeklyDraft
// (default: Thursdays 06:00). Also exports the job so it can be invoked
// manually from an API route or a script without waiting for the schedule.

import cron from 'node-cron';
import { loadConfig } from '../config.js';
import { generateWeek } from '../services/scheduling.js';

export function runWeeklyDraft() {
  const results = generateWeek(new Date());
  const misfits = results.filter((r) => !r.fits);
  console.log(
    `[weeklyDraft] generated ${results.length} blocks; ` +
      `${misfits.length} outside filler tolerance`
  );
  return results;
}

export function startWeeklyDraftCron() {
  const expr = loadConfig().cron?.weeklyDraft;
  if (!expr) {
    console.log('[weeklyDraft] no cron.weeklyDraft configured; skipping schedule');
    return null;
  }
  if (!cron.validate(expr)) {
    console.warn(`[weeklyDraft] invalid cron expression "${expr}"; skipping`);
    return null;
  }
  const task = cron.schedule(expr, () => {
    try {
      runWeeklyDraft();
    } catch (err) {
      console.error('[weeklyDraft] failed:', err);
    }
  });
  console.log(`[weeklyDraft] scheduled with "${expr}"`);
  return task;
}
