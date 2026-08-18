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
 * "S01E02", or "E02" for a show filed without seasons. Movies are ordered by
 * FRANCHISE PART instead — "Part 2" — since a saga's parts are the one case where
 * a film really is the Nth of something. Empty for anything with no ordinal at
 * all: fillers, unfiled clips, and standalone films.
 *
 * `chapter` is what separates the two kinds of movie: a franchise part carries its
 * part number there, a standalone film carries 0. episode_no cannot make that call
 * on its own, because it numbers position within a subject and the flat "Movies"
 * folder holds a hundred-plus unrelated films that would come out as Part 1..138.
 */
export function episodeCode({ season, episode_no, is_filler, show_type_code, chapter } = {}) {
  if (!episode_no || is_filler) return '';
  if (show_type_code === 'movies') return Number(chapter) > 0 ? `Part ${episode_no}` : '';
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
  const code = episodeCode(row);
  if (row.show_type_code === 'movies') {
    // A franchise part is named by its saga and part — "Toy Story · Part 3" — so an
    // operator can see the saga and its order at a glance wherever a clip is
    // listed. A standalone film has neither, and is one of a kind, so it keeps its
    // own title: "Movies · Part 37" would hide which film it is.
    return code ? `${row.subject} · ${code}` : title;
  }
  return code ? `${row.subject} · ${code}` : `${row.subject} · ${title}`;
}

/** Attach `episode_code` + `label` to a row that already carries episode_no. */
export function withLabel(row) {
  return { ...row, episode_code: episodeCode(row), label: clipLabel(row) };
}
