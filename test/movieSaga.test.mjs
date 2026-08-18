// Unit tests for movie franchise detection (src/services/movieSaga.js).
//
// The hard part is not finding "Toy_Story_3" — it is NOT finding a franchise in
// "Big_Hero_6", "Planet_51", "102_Dalmatians" or "Aladdin_2019". These cases are
// drawn from the operator's real 295-title movie folder.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, titleCandidates, groupSagas } from '../src/services/movieSaga.js';

const group = (names) => groupSagas(names.map((name, i) => ({ id: i, name })));
const sagaOf = (names) => {
  const { sagas } = group(names);
  return [...sagas].map(([base, members]) => [base, members.map((m) => m.part)]);
};
const isAllStandalone = (names) => group(names).standalone.length === names.length;

test('normalizeTitle splits camelCase, digits and punctuation into words', () => {
  assert.equal(normalizeTitle('HarryPotter1PhilosopStone'), 'Harry Potter 1 Philosop Stone');
  assert.equal(normalizeTitle('Cars2'), 'Cars 2');
  assert.equal(normalizeTitle('Toy_Story_3'), 'Toy Story 3');
  assert.equal(normalizeTitle('ChroniclesOfNarnia3._TVOTDT'), 'Chronicles Of Narnia 3 TVOTDT');
  assert.equal(normalizeTitle('Lilo_&_Stitch_1'), 'Lilo & Stitch 1', '"&" survives as a word');
  assert.equal(normalizeTitle('A_Bug’s_Life'), 'A Bug s Life');
});

test('titleCandidates offers every plausible reading and rejects implausible ones', () => {
  // A trailing ordinal and an infix ordinal are the same rule.
  assert.deepEqual(titleCandidates('Toy_Story_3'), [{ base: 'Toy Story', part: 3 }]);
  assert.deepEqual(titleCandidates('Shrek_3_The_Third'), [{ base: 'Shrek', part: 3 }]);
  // Two readings offered; the corpus pass picks between them.
  assert.deepEqual(titleCandidates('HarryPotter7DeathHallows1'), [
    { base: 'Harry Potter', part: 7 },
    { base: 'Harry Potter 7 Death Hallows', part: 1 },
  ]);
  // A leading number is part of the title, never an ordinal.
  assert.deepEqual(titleCandidates('102_Dalmatians'), []);
  // Years are not ordinals.
  assert.deepEqual(titleCandidates('Aladdin_2019'), []);
  assert.deepEqual(titleCandidates('Peter_Pan_(2003)'), []);
  // Implausibly large numbers are part of the title.
  assert.deepEqual(titleCandidates('Planet_51'), []);
  assert.deepEqual(titleCandidates('Miracle_34th_Street'), []);
  // A year alongside a real ordinal still yields the ordinal.
  assert.deepEqual(titleCandidates('The_Jungle_Book_3_(2016)'), [{ base: 'The Jungle Book', part: 3 }]);
});

test('a franchise needs two members — one numbered title is not a saga', () => {
  assert.deepEqual(sagaOf(['Angry_Birds_1', 'Angry_Birds_2']), [['Angry Birds', [1, 2]]]);
  // Same shape, one member: these are standalone films that happen to end in a number.
  assert.ok(isAllStandalone(['Big_Hero_6']));
  assert.ok(isAllStandalone(['Big_Hero_6', 'Planet_51', 'Zathura_A_Space_Adventure']));
});

test('the best-supported reading wins, so Harry Potter stays one saga', () => {
  const names = [1, 2, 3, 4, 5, 6].map((n) => `HarryPotter${n}Title`)
    .concat(['HarryPotter7DeathHallows1', 'HarryPotter8DeathHallows2']);
  assert.deepEqual(sagaOf(names), [['Harry Potter', [1, 2, 3, 4, 5, 6, 7, 8]]]);
});

test('an exactly-named first film folds in; a different edition does not', () => {
  // "Cinderella" is exactly the base, so it becomes part 1.
  assert.deepEqual(sagaOf(['Cinderella', 'Cinderella_2', 'Cinderella_3']),
    [['Cinderella', [1, 2, 3]]]);
  // "Aladdin_2019" normalizes to "Aladdin 2019", not "Aladdin" — a separate film.
  const { sagas, standalone } = group(['Aladdin', 'Aladdin_2019', 'Aladdin_2_King_Of_Thieves']);
  assert.deepEqual([...sagas.get('Aladdin')].map((m) => m.name), ['Aladdin', 'Aladdin_2_King_Of_Thieves']);
  assert.deepEqual(standalone.map((s) => s.name), ['Aladdin_2019']);
  // Two un-numbered claimants are ambiguous, so neither folds.
  assert.ok(isAllStandalone(['Alice_In_Wonderland', 'Alice_In_Wonderland_2010']));
});

test('a shorter title is not swallowed by a longer franchise', () => {
  const { sagas, standalone } = group(['Home', 'Home_Alone_1', 'Home_Alone_2', 'Home_Alone_3']);
  assert.deepEqual([...sagas.keys()], ['Home Alone']);
  assert.equal(sagas.get('Home Alone').length, 3, '"Home" did not join "Home Alone"');
  assert.deepEqual(standalone.map((s) => s.name), ['Home']);

  // "Monsters_Vs_Aliens" shares a first word with the Monsters films only.
  const m = group(['Monsters_1_Inc', 'Monsters_2_University', 'Monsters_Vs_Aliens']);
  assert.equal(m.sagas.get('Monsters').length, 2);
  assert.deepEqual(m.standalone.map((s) => s.name), ['Monsters_Vs_Aliens']);
});

test('release-year editions never form a franchise on their own', () => {
  assert.ok(isAllStandalone(['Beauty_And_The_Beast', 'Beauty_And_The_Beast_2017']));
  assert.ok(isAllStandalone(['Peter_Pan', 'Peter_Pan_(2003)']));
  assert.ok(isAllStandalone(['Jack_Frost_1998', 'Scrooged_1988', 'The_Grinch_2018']));
});

test('members come back sorted by part', () => {
  const { sagas } = group(['Ice_Age_5', 'Ice_Age_1', 'Ice_Age_3', 'Ice_Age_2', 'Ice_Age_4']);
  assert.deepEqual(sagas.get('Ice Age').map((m) => m.part), [1, 2, 3, 4, 5]);
});

test('an empty or single-title folder yields no sagas', () => {
  assert.deepEqual(sagaOf([]), []);
  assert.deepEqual(sagaOf(['Zootopia']), []);
});
