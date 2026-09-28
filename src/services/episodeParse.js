// Unified season/episode parser for media filenames.
//
// Recognizes the common naming conventions an operator's files arrive in:
//   - SxxEyy markers   : "Cosmos_S02E05", "s2e5", "S02.E05", "S02 E05"
//   - NxNN markers     : "03x01", "3x1"
//   - episode-first    : "EP3SE2", "EP 3 SE 2", "E3S2" (episode 3 of season 2)
//   - spelled out      : "Season 1 Episode 2", "Temporada 1 Episodio 2", "Ep 4"
// and falls back to the FIRST number in the name that the show's own name does
// not carry. It used to be the LAST, which ordered "Math_Intervention_Program_020_
// Consumer_Arithmetic_MCQ_Part_1" as 1, "Octonauts_100_Tree_Lobsters_101_Convict_
// Fish" as 101 and "Human_The_World_Within_03_D11" as 11: when a name carries
// several numbers, the episode is the one that follows the show name, and what
// trails it is a part, a second episode or a disc code.
//
// This module intentionally imports nothing (not even db) so both ingestion and
// the DB migration/backfill can use it without an import cycle.

/**
 * Parse a filename (with or without extension) into { season, episode }.
 * season is null when the name carries no season information (a bare episode
 * number or a standalone clip); episode is 0 when no number is present at all.
 * `subject` is the show the clip is filed under: a number its name carries (the
 * grade in "Grade 5 Science") is not the episode.
 */
export function parseEpisode(name, subject = '') {
  // Callers pass the base name (extension already stripped); we don't strip here
  // because a dotted marker like "cosmos.s1e1" would look like an extension.
  const base = String(name || '');
  const marked = parseMarked(base);
  if (marked) return marked;
  const seasonOnly = base.match(/(?:season|temporada)\s*(\d{1,3})/i);
  return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode: firstFreeNumber(base, subject) };
}

/**
 * The episode by the no-marker rule: the first non-zero number the show's name
 * does not carry. When the show's name carries every number in it ("Grade 5-
 * Science- Force") there is no episode to find, and the last number is kept, as
 * it always was, so such clips keep the chapters they have.
 */
function firstFreeNumber(base, subject) {
  const nums = (base.match(/\d{1,4}/g) || []).map(Number);
  const own = new Set((String(subject || '').match(/\d+/g) || []).map(Number));
  const free = nums.find((n) => n > 0 && !own.has(n));
  return free ?? (nums.length ? nums[nums.length - 1] : 0);
}

/**
 * What parseEpisode() returned before it took the FIRST free number: an explicit
 * marker, else the last number in the name. Kept only so migration 006 can tell
 * which chapters are still exactly what that rule wrote.
 */
export function legacyParseEpisode(name) {
  const base = String(name || '');
  const marked = parseMarked(base);
  if (marked) return marked;
  const seasonOnly = base.match(/(?:season|temporada)\s*(\d{1,3})/i);
  const nums = base.match(/\d{1,4}/g);
  return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode: nums ? Number(nums[nums.length - 1]) : 0 };
}

/**
 * The episode number a filename STATES, or null when it doesn't say one plainly.
 *
 * This is the number an operator reads in the name, and so the one a label must
 * show: "Octonauts_74_The_Water_Bears" is episode 74 even when it is only the
 * 11th clip of the folder. Unlike parseEpisode() there is no guessing — only an
 * explicit marker (S02E05, 3x01, Ep 4, Episode 4…) or the name's ONE free number
 * counts. A number the show's own name carries is not free ("Grade 5- Science-
 * Force" under "Grade 5 Science" states no episode at all), and neither is a
 * part ("Pt. 2", "(2)"), a year, or one of several numbers ("Human_03_D11"): those
 * return null, and the caller falls back to the clip's position.
 */
export function statedEpisode(name, subject = '') {
  const base = String(name || '');
  const marked = parseMarked(base);
  if (marked) return marked.episode > 0 ? marked.episode : null;
  const own = new Set((String(subject || '').match(/\d+/g) || []).map(Number));
  const free = [...base.matchAll(/\d+/g)].filter((m) => !own.has(Number(m[0])));
  if (free.length !== 1) return null;
  const [hit] = free;
  const n = Number(hit[0]);
  if (!n || hit[0].length > 4 || (n >= 1900 && n <= 2099)) return null;
  // "Productivity Pt. 2", "Multiple Choice P3", "Part_1": the Nth part of one
  // lesson, not the Nth episode of the show.
  if (/(?:part|pt|p)[\s._#-]*$/i.test(base.slice(0, hit.index))) return null;
  // "Solving Linear Equations (2)": a second part or a second copy.
  if (base[hit.index - 1] === '(' && base[hit.index + hit[0].length] === ')') return null;
  return n;
}

/** The explicit-marker rules of parseEpisode(): { season, episode } or null. */
function parseMarked(base) {
  let m;
  // SxxEyy — the dominant TV convention. Allow separators between S## and E##.
  if ((m = base.match(/[Ss](\d{1,3})[\s._-]*[Ee](\d{1,4})/))) {
    return { season: Number(m[1]), episode: Number(m[2]) };
  }
  // Episode FIRST, then season — "EDYOU PULSE EP3SE2", "EDYOUPULSE_EP1SE2". Must
  // run before the bare "Ep N" rule below, which would read EP3SE2 as episode 3
  // with no season and file season 2 on top of season 1. The lookbehind is a
  // letter check rather than \b because "_" counts as a word character, so
  // "\bEP" never matches the very common "Show_EP1".
  if ((m = base.match(/(?<![A-Za-z])(?:ep|e)\.?\s*(\d{1,4})[\s._-]*(?:se|s)\s*(\d{1,3})(?!\d)/i))) {
    return { season: Number(m[2]), episode: Number(m[1]) };
  }
  // NxNN — "03x01". Guard both sides so a resolution like "1920x1080" or a
  // duration digit run doesn't get mistaken for a season marker.
  if ((m = base.match(/(?<![A-Za-z0-9])(\d{1,2})\s*[xX]\s*(\d{1,3})(?![A-Za-z0-9])/))) {
    return { season: Number(m[1]), episode: Number(m[2]) };
  }
  // "Season 1 Episode 2" / "Temporada 1 Episodio 2" / "Season 1 Cap 2".
  if ((m = base.match(/(?:season|temporada)\s*(\d{1,3})[\s._·:–-]*(?:episode|episodio|ep|cap[ií]?tulo|cap)\.?\s*(\d{1,4})/i))) {
    return { season: Number(m[1]), episode: Number(m[2]) };
  }
  // A season with no explicit episode number ("Season 2" folder-style names).
  const seasonOnly = base.match(/(?:season|temporada)\s*(\d{1,3})/i);
  // A bare episode word ("Episode 5", "Cap 5", "Ep. 5").
  if ((m = base.match(/(?:episode|episodio|cap[ií]?tulo|(?<![A-Za-z])ep)\.?\s*(\d{1,4})/i))) {
    return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode: Number(m[1]) };
  }
  return null;
}

/**
 * Global monotonic ordering key for a series' episode. Single-season (or
 * season-less) content keeps its plain episode number so legacy single-season
 * shows are unchanged; season >= 2 is encoded season*1000 + episode so multiple
 * seasons gathered under one show still sort in broadcast order and S01E05 /
 * S02E05 don't collide. The scheduling engine orders purely by this key.
 */
export function encodeChapter(season, episode) {
  return season && season > 1 ? season * 1000 + episode : episode;
}
