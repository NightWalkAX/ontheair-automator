// Unit tests for the season/episode filename parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEpisode, encodeChapter } from '../src/services/episodeParse.js';

test('parseEpisode recognizes the SxxEyy convention', () => {
  assert.deepEqual(parseEpisode('Cosmos_S02E05.mov'), { season: 2, episode: 5 });
  assert.deepEqual(parseEpisode('cosmos.s1e1'), { season: 1, episode: 1 });
  assert.deepEqual(parseEpisode('Show S03 E12 1080p'), { season: 3, episode: 12 });
  // A single-season lesson keeps its plain episode number.
  assert.deepEqual(parseEpisode('Math_S01E03_600'), { season: 1, episode: 3 });
});

test('parseEpisode recognizes the NxNN convention', () => {
  assert.deepEqual(parseEpisode('03x01 pilot'), { season: 3, episode: 1 });
  assert.deepEqual(parseEpisode('Series 3x10'), { season: 3, episode: 10 });
  // A resolution must NOT be mistaken for a season marker.
  assert.deepEqual(parseEpisode('clip_1920x1080'), { season: null, episode: 1080 });
});

test('parseEpisode recognizes spelled-out "Season N Episode M"', () => {
  assert.deepEqual(parseEpisode('Nature - Season 1 Episode 2'), { season: 1, episode: 2 });
  assert.deepEqual(parseEpisode('Documental Temporada 2 Episodio 7'), { season: 2, episode: 7 });
  assert.deepEqual(parseEpisode('Serie Temporada 4 Capitulo 3'), { season: 4, episode: 3 });
});

test('parseEpisode falls back to the last integer with no season', () => {
  assert.deepEqual(parseEpisode('Movie0_5400.mov'), { season: null, episode: 5400 });
  assert.deepEqual(parseEpisode('Episode 5'), { season: null, episode: 5 });
  assert.deepEqual(parseEpisode('standalone'), { season: null, episode: 0 });
});

test('encodeChapter keeps single-season plain and encodes season >= 2', () => {
  assert.equal(encodeChapter(1, 5), 5);
  assert.equal(encodeChapter(null, 5), 5);
  assert.equal(encodeChapter(2, 5), 2005);
  assert.equal(encodeChapter(3, 12), 3012);
});
