// Calendar dates as THIS Mac's clock reads them.
//
// `new Date().toISOString().slice(0, 10)` is the UTC date, and Guyana is UTC-4:
// from 20:00 to midnight local it already names TOMORROW. Anything that asks
// "which day is on air right now" must use the local date, or for four hours a
// night it skips the playlist that is actually playing.

/** 'YYYY-MM-DD' of `d` in local time. */
export function localDate(d = new Date()) {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()]
    .map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');
}

/** 'YYYY-MM-DD' `days` after a 'YYYY-MM-DD' date (calendar arithmetic, no clock). */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
