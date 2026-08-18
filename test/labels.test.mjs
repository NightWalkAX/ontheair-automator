// Display-naming rules (src/services/labels.js).
//
// The interesting case is movies. A standalone film is one of a kind and keeps its
// own title, but a franchise part really is the Nth of something, so it is named by
// its saga and part. `chapter` is what tells the two apart — the flat "Movies"
// folder holds 138 unrelated films under one subject, and numbering by position
// alone would label them Part 1..138.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeCode, clipLabel, withLabel } from '../src/services/labels.js';

const movie = (over) => ({ show_type_code: 'movies', is_filler: 0, ...over });

test('a franchise part is named by its saga and part', () => {
  const part = movie({ subject: 'Toy Story', chapter: 3, episode_no: 3, name: 'Toy_Story_3' });
  assert.equal(episodeCode(part), 'Part 3');
  assert.equal(clipLabel(part), 'Toy Story · Part 3');
});

test('a standalone film keeps its own title', () => {
  // chapter 0 = no ordinal. episode_no is still set (its position among the 138
  // films sharing the flat folder), which must NOT become a part number.
  const solo = movie({ subject: 'Movies', chapter: 0, episode_no: 37, name: 'Zootopia' });
  assert.equal(episodeCode(solo), '', 'a standalone film is not part 37 of anything');
  assert.equal(clipLabel(solo), 'Zootopia');
});

test('a display-name override wins for a standalone film', () => {
  const solo = movie({ subject: 'Movies', chapter: 0, episode_no: 2, name: 'Wall_E', display_name: 'WALL·E' });
  assert.equal(clipLabel(solo), 'WALL·E');
});

test('TV and lesson naming is unchanged', () => {
  const ep = { show_type_code: 'tv_shows', subject: 'Cosmos', season: 2, episode_no: 5, chapter: 2005 };
  assert.equal(episodeCode(ep), 'S02E05');
  assert.equal(clipLabel(ep), 'Cosmos · S02E05');

  const seasonless = { show_type_code: 'lessons', subject: 'Grade 4 Science', episode_no: 7, chapter: 7 };
  assert.equal(episodeCode(seasonless), 'E07');
  assert.equal(clipLabel(seasonless), 'Grade 4 Science · E07');
});

test('fillers and unfiled clips keep their raw name', () => {
  assert.equal(clipLabel({ is_filler: 1, name: 'Infobits_02', subject: null }), 'Infobits_02');
  assert.equal(episodeCode({ is_filler: 1, episode_no: 3 }), '');
  assert.equal(clipLabel({ subject: null, name: 'stray.mov' }), 'stray.mov');
});

test('a clip filed under a show but carrying no ordinal is named show + title', () => {
  const odd = { show_type_code: 'documentaries', subject: 'Planet Earth', name: 'bonus_feature' };
  assert.equal(clipLabel(odd), 'Planet Earth · bonus_feature');
});

test('withLabel attaches both fields', () => {
  const row = withLabel(movie({ subject: 'Shrek', chapter: 2, episode_no: 2, name: 'Shrek_2' }));
  assert.equal(row.episode_code, 'Part 2');
  assert.equal(row.label, 'Shrek · Part 2');
});
