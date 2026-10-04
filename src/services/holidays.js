// Seasonal programming ("holidays": Christmas, Halloween, Valentine's …).
//
// Named Holiday in the code because "season" already means a TV season
// (Resource.season, S01/S02) everywhere in this project.
//
// A Holiday is a yearly date range ('MM-DD' → 'MM-DD', which may wrap the new
// year: 12-15 → 01-06). A FILE is marked with any number of holidays
// (HolidayFile, keyed by file_path like every other decision about a file, so it
// holds on every channel that carries it). The scheduling rule, decided with
// the operator on 2026-10-04:
//
//   - outside all of its holidays, a marked film never airs;
//   - inside one, it is PREFERRED: picked ahead of the rest and exempt from the
//     cooldown (a Christmas film has a few weeks a year to air), still never twice
//     within the ±6-day window.
//
// An inactive holiday restricts nothing: its films behave as ordinary films.

import { db } from '../db.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Is 'MM-DD' a valid month-day? */
export function isMonthDay(v) { return MD.test(String(v ?? '')); }

/** SQL: does holiday row `h` cover month-day literal `md`? */
const covers = (md) => `((h.start_md <= h.end_md AND '${md}' BETWEEN h.start_md AND h.end_md)
  OR (h.start_md > h.end_md AND ('${md}' >= h.start_md OR '${md}' <= h.end_md)))`;

/**
 * SQL fragments for a Resource aliased `r` on `date`:
 *   allowed   — true unless the file is marked and none of its holidays is on
 *   inSeason  — true when one of the file's active holidays covers the date
 * The date is validated and inlined (it is never user text by the time it gets
 * here, but a malformed one is refused rather than spliced in).
 */
export function holidaySql(date) {
  if (!DATE.test(String(date))) throw new Error(`holidaySql: bad date ${date}`);
  const md = String(date).slice(5, 10);
  const marked = `EXISTS (SELECT 1 FROM HolidayFile hf JOIN Holiday h ON h.id = hf.holiday_id
    WHERE hf.file_path = r.file_path AND h.active = 1)`;
  const inSeason = `EXISTS (SELECT 1 FROM HolidayFile hf JOIN Holiday h ON h.id = hf.holiday_id
    WHERE hf.file_path = r.file_path AND h.active = 1 AND ${covers(md)})`;
  return { allowed: `(NOT ${marked} OR ${inSeason})`, inSeason };
}

/** Holidays covering a date (active only). */
export function holidaysOn(date) {
  if (!DATE.test(String(date))) return [];
  const md = String(date).slice(5, 10);
  return db.prepare(`SELECT h.* FROM Holiday h WHERE h.active = 1 AND ${covers(md)} ORDER BY h.name`).all();
}

/** Every holiday with how many files it marks. */
export function listHolidays() {
  return db.prepare(`
    SELECT h.*, (SELECT COUNT(*) FROM HolidayFile hf WHERE hf.holiday_id = h.id) AS files
    FROM Holiday h ORDER BY h.start_md, h.name
  `).all();
}

/** { file_path: [holiday_id, …] } for the given paths (all marked files when omitted). */
export function holidaysByFile(paths = null) {
  const rows = paths
    ? (paths.length ? db.prepare(`SELECT file_path, holiday_id FROM HolidayFile
        WHERE file_path IN (${paths.map(() => '?').join(',')})`).all(...paths) : [])
    : db.prepare('SELECT file_path, holiday_id FROM HolidayFile').all();
  const out = {};
  for (const r of rows) (out[r.file_path] ||= []).push(r.holiday_id);
  return out;
}

/**
 * Mark (or unmark) files. `mode`: 'set' replaces each file's holidays with
 * `holidayIds`, 'add' adds them, 'remove' removes them. Returns rows changed.
 */
export function setFileHolidays(filePaths, holidayIds, mode = 'set') {
  const paths = [...new Set(filePaths.filter(Boolean))];
  const ids = [...new Set(holidayIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const del = db.prepare('DELETE FROM HolidayFile WHERE file_path = ?');
  const delOne = db.prepare('DELETE FROM HolidayFile WHERE file_path = ? AND holiday_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO HolidayFile (file_path, holiday_id) VALUES (?, ?)');
  let n = 0;
  for (const p of paths) {
    if (mode === 'set') n += Number(del.run(p).changes);
    for (const id of ids) {
      n += Number(mode === 'remove' ? delOne.run(p, id).changes : ins.run(p, id).changes);
    }
  }
  return n;
}
