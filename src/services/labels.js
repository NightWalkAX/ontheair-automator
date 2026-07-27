// One display-naming rule for the whole app: a clip is shown as
// "Show · S01E02" — show name, season, episode — never as its raw filename and
// never as its internal `chapter` number.
//
// `chapter` is a channel-wide monotonic ordering key (renumbering a catalog
// leaves values like 1674 or 1474 on episode 1 and 2 of a show), so it orders
// correctly but must not reach an operator's eyes. The episode number shown is
// instead the clip's 1-based position inside its (show, season).

/**
 * SQL CTE exposing EpisodeNo(id, episode_no) for every non-filler clip.
 * Use as: `WITH ${EPISODE_NO_CTE} SELECT ... LEFT JOIN EpisodeNo en ON en.id = r.id`.
 * Numbering is computed over the whole table, so a filtered query still gets
 * each clip's true position within its season.
 */
export const EPISODE_NO_CTE = `
  EpisodeNo AS (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY channel_id, COALESCE(subject, ''), COALESCE(season, -1)
             ORDER BY chapter, id
           ) AS episode_no
    FROM Resource
    WHERE is_filler = 0
  )
`;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * "S01E02", or "E02" for a show filed without seasons. Empty for anything that
 * isn't an episode: fillers, unfiled clips, and movies (a film isn't episode 3
 * of anything, even when several are filed under the same show).
 */
export function episodeCode({ season, episode_no, is_filler, show_type_code } = {}) {
  if (!episode_no || is_filler || show_type_code === 'movies') return '';
  return season != null ? `S${pad2(season)}E${pad2(episode_no)}` : `E${pad2(episode_no)}`;
}

/**
 * The label an operator — and OTAV's playlist — sees for a clip.
 * Fillers and clips not filed under a show keep their (possibly overridden)
 * name, since there's no show/season/episode to name them by.
 */
export function clipLabel(row = {}) {
  const title = row.display_name || row.name || '';
  if (row.is_filler || !row.subject) return title;
  // A movie is one of a kind: "Curious George · E03" would hide which film it
  // is, so movies keep their title even though they're filed under a show.
  if (row.show_type_code === 'movies') return title;
  const code = episodeCode(row);
  return code ? `${row.subject} · ${code}` : `${row.subject} · ${title}`;
}

/** Attach `episode_code` + `label` to a row that already carries episode_no. */
export function withLabel(row) {
  return { ...row, episode_code: episodeCode(row), label: clipLabel(row) };
}
