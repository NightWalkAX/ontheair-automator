// Unified season/episode parser for media filenames.
//
// Recognizes the common naming conventions an operator's files arrive in:
//   - SxxEyy markers   : "Cosmos_S02E05", "s2e5", "S02.E05", "S02 E05"
//   - NxNN markers     : "03x01", "3x1"
//   - spelled out      : "Season 1 Episode 2", "Temporada 1 Episodio 2", "Ep 4"
// and falls back to the last standalone integer in the name (legacy behaviour).
//
// This module intentionally imports nothing (not even db) so both ingestion and
// the DB migration/backfill can use it without an import cycle.

/**
 * Parse a filename (with or without extension) into { season, episode }.
 * season is null when the name carries no season information (a bare episode
 * number or a standalone clip); episode is 0 when no number is present at all.
 */
export function parseEpisode(name) {
  // Callers pass the base name (extension already stripped); we don't strip here
  // because a dotted marker like "cosmos.s1e1" would look like an extension.
  const base = String(name || '');
  let m;
  // SxxEyy — the dominant TV convention. Allow separators between S## and E##.
  if ((m = base.match(/[Ss](\d{1,3})[\s._-]*[Ee](\d{1,4})/))) {
    return { season: Number(m[1]), episode: Number(m[2]) };
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
  if ((m = base.match(/(?:episode|episodio|cap[ií]?tulo|\bep)\.?\s*(\d{1,4})/i))) {
    return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode: Number(m[1]) };
  }
  // Fallback: last standalone integer is the episode/order number.
  const nums = base.match(/\d{1,4}/g);
  const episode = nums && nums.length ? Number(nums[nums.length - 1]) : 0;
  return { season: seasonOnly ? Number(seasonOnly[1]) : null, episode };
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
