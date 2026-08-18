// Movie saga (franchise) detection.
//
// Movies arrive as a flat folder of standalone files — no series folders, no
// SxxEyy markers — so the generic folder/episode detection in ingestion.js files
// every one of them under a single "Movies" subject with chapter 0. That makes a
// franchise invisible: there is no folder per saga to look at, and no ordering to
// play "Toy Story 1, 2, 3, 4" in.
//
// The franchise IS in the filename, but only as a bare number: "Toy_Story_3",
// "HarryPotter5OrderOfPhoenix", "Cars2". A bare number is ambiguous on its own —
// "Big_Hero_6" and "Angry_Birds_2" are identical in shape, and only one is a
// sequel. So detection is CORPUS-LEVEL, not per-filename: a saga exists only when
// two or more titles in the same folder agree on a base name. "Angry Birds" has
// two members, "Big Hero" has one, so the first becomes a saga and the second
// stays a standalone movie.
//
// This module intentionally imports nothing, so both ingestion and the one-off
// cleanup script can use it.

// A release year, not a part number: "Aladdin_2019", "Peter_Pan_(2003)".
const YEAR_RE = /^(?:19|20)\d{2}$/;
// Above this, a trailing number is far likelier to be part of the title
// ("Planet_51", "Miracle_34th_Street") than a sequel ordinal.
const MAX_PART = 20;

/**
 * A filename reduced to spaced words: camelCase and letter/digit runs are split
 * so "HarryPotter1PhilosopStone" and "Toy_Story_1" normalize the same way, and
 * punctuation becomes whitespace.
 */
export function normalizeTitle(name) {
  return String(name || '')
    .replace(/&/g, ' & ')                     // Beauty&Beast -> Beauty & Beast
    .replace(/([a-z])([A-Z])/g, '$1 $2')      // camelCase  -> camel Case
    .replace(/([A-Za-z])(\d)/g, '$1 $2')      // Cars1      -> Cars 1
    .replace(/(\d)([A-Za-z])/g, '$1 $2')      // 2ndPart    -> 2 ndPart
    .replace(/[^A-Za-z0-9&]+/g, ' ')          // _ . - ( ) ’ ! -> space ("&" kept)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every way a title could be read as "<base> <part> [subtitle]".
 *
 * One rule covers both shapes the operator's files use — a trailing ordinal
 * ("Toy_Story_3") and an infix one ("Shrek_3_The_Third") — because a trailing
 * number is just an infix number with an empty subtitle. Each numeric token that
 * is neither first (so "102_Dalmatians" is safe) nor a year nor implausibly large
 * yields one candidate. Emitting ALL of them lets the corpus pass choose: for
 * "HarryPotter7DeathHallows1" the trailing "1" suggests a base of "Harry Potter 7
 * Death Hallows", but the infix "7" suggests "Harry Potter" — and only the latter
 * has siblings.
 */
export function titleCandidates(name) {
  const tokens = normalizeTitle(name).split(' ').filter(Boolean);
  const out = [];
  for (let i = 1; i < tokens.length; i++) {
    if (!/^\d{1,4}$/.test(tokens[i])) continue;
    if (YEAR_RE.test(tokens[i])) continue;
    const part = Number(tokens[i]);
    if (part < 1 || part > MAX_PART) continue;
    const base = tokens.slice(0, i).join(' ');
    if (base.length < 2 || /^\d+$/.test(base)) continue;
    out.push({ base, part });
  }
  return out;
}

/**
 * Group a list of movie titles into sagas.
 *
 * `items` is [{ id, name }]. Returns:
 *   { sagas: Map<base, [{ id, name, part }]>, standalone: [{ id, name }] }
 * with each saga's members sorted by part and every base holding >= 2 titles.
 *
 * Three passes:
 *   1. Score every candidate base by how many titles propose it, and give each
 *      title the base with the most proposers (longest base breaks a tie, so
 *      "The Lion King" beats "The").
 *   2. Fold in the un-numbered first film: a title with no ordinal joins a saga
 *      only when its normalized name is EXACTLY the base and it is the only such
 *      claimant. That is what makes {Cinderella, Cinderella_2, Cinderella_3} one
 *      saga while keeping "Aladdin_2019" (normalizing to "Aladdin 2019", not
 *      "Aladdin") out of the Aladdin saga, and "Home" out of "Home Alone".
 *   3. Drop any base left with a single title — the guard that separates a real
 *      franchise from a title that merely ends in a number.
 */
export function groupSagas(items) {
  const candidates = new Map(); // id -> candidate[]
  const proposers = new Map();  // base -> Set<id>
  for (const it of items) {
    const cands = titleCandidates(it.name);
    candidates.set(it.id, cands);
    for (const c of cands) {
      if (!proposers.has(c.base)) proposers.set(c.base, new Set());
      proposers.get(c.base).add(it.id);
    }
  }

  // Pass 1 — each numbered title takes its best-supported reading.
  const sagas = new Map(); // base -> [{ id, name, part }]
  const claimed = new Set();
  for (const it of items) {
    const cands = candidates.get(it.id);
    if (!cands.length) continue;
    let best = null;
    for (const c of cands) {
      const support = proposers.get(c.base).size;
      if (!best || support > best.support || (support === best.support && c.base.length > best.base.length)) {
        best = { ...c, support };
      }
    }
    if (!sagas.has(best.base)) sagas.set(best.base, []);
    sagas.get(best.base).push({ id: it.id, name: it.name, part: best.part });
    claimed.add(it.id);
  }

  // Pass 2 — fold in an exactly-named, unambiguous first film.
  const unnumbered = items.filter((it) => !claimed.has(it.id));
  const byExactName = new Map(); // normalized name -> ids
  for (const it of unnumbered) {
    const key = normalizeTitle(it.name);
    if (!byExactName.has(key)) byExactName.set(key, []);
    byExactName.get(key).push(it);
  }
  for (const [base, members] of sagas) {
    const claimants = byExactName.get(base);
    if (!claimants || claimants.length !== 1) continue;   // absent or ambiguous
    if (members.some((m) => m.part === 1)) continue;      // part 1 already present
    members.push({ id: claimants[0].id, name: claimants[0].name, part: 1 });
    claimed.add(claimants[0].id);
  }

  // Pass 3 — a base with one title is not a saga.
  for (const [base, members] of [...sagas]) {
    if (members.length >= 2) {
      members.sort((a, b) => a.part - b.part || a.name.localeCompare(b.name));
      continue;
    }
    sagas.delete(base);
    for (const m of members) claimed.delete(m.id);
  }

  return { sagas, standalone: items.filter((it) => !claimed.has(it.id)) };
}

/**
 * A free subject name for a detected franchise.
 *
 * A franchise base can collide with a series that already exists for a different
 * show type — the operator's catalogue has "Curious George" as an 86-episode TV
 * series AND a 6-film franchise. Merging them would put six films with chapters
 * 1..6 inside a TV series that already has chapters 1..6, which is exactly the
 * duplicate-chapter contamination that breaks sequential progression. So the
 * franchise takes a qualified name instead.
 *
 * `isTaken(name)` reports whether a name is already in use by something else.
 */
export function sagaSubjectName(base, isTaken) {
  if (!isTaken || !isTaken(base)) return base;
  const qualified = `${base} (Movies)`;
  if (!isTaken(qualified)) return qualified;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base} (Movies ${n})`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${base} (Movies)`; // pathological; caller reports the clash
}
