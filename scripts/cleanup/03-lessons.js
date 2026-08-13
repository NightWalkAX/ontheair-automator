#!/usr/bin/env node
// Phase 3 — regroup the Lessons catalog (show_type_id = 4).
//
// Before: `subject` is whatever folder the scanner happened to land on — the TERM
// folder for most rows ("Easter Term" alone holds 668), and `chapter` holds the
// GRADE number, so 200 rows share chapter = 5. Serial playback advances by
// `chapter = last_played + 1`, so the series are unusable as scanned.
//
// After: `subject = "Grade <N> <Area>"` derived from `file_path`, `chapter`
// renumbered 1..N per series ordered by `name`. Term (Easter/Christmas) is
// deliberately dropped from the subject — it survives in file_path.
//
// Dry run by default; pass --apply to write. Honours SCHEDULER_DB.

import { q, one, APPLY, planner, ensureSeries, renumber, quarantine } from './lib.js';

const CHANNEL_ID = 1; // the only channel
const SHOW_TYPE_ID = 4; // Lessons
const IS_SERIAL = true;

// Marker folder: the segment right after it is the subject Area.
const SORTED_MARK = 'local academic videos - sorted';
// "Grade 5", "grade  5", and embedded forms like "SS Grade 6".
const GRADE_RE = /(?:^|[^a-z0-9])grade\s*0*(\d{1,2})(?![0-9])/i;
// Flat Discover Academic filenames: G10E_..., G11POB_... → grade 10 / 11.
const GRADE_CODE_RE = /^G(\d{1,2})[A-Za-z]/;

/**
 * Title Case only when the segment is unambiguously mis-cased (ALL CAPS or all
 * lowercase). Mixed-case folder names are already how the operator wants them;
 * rewriting those would invent abbreviations or mangle words like "of".
 */
function titleCaseArea(seg) {
  const hasLower = /[a-z]/.test(seg);
  const hasUpper = /[A-Z]/.test(seg);
  if (hasLower && hasUpper) return seg.trim();
  return seg
    .trim()
    .toLowerCase()
    .replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/** Derive { area, grade } from a file_path; either may be null. */
function derive(filePath) {
  const segs = String(filePath || '')
    .split('/')
    .filter(Boolean);
  const fileName = segs[segs.length - 1] || '';
  const dirs = segs.slice(0, -1);

  let area = null;
  const markIdx = dirs.findIndex((s) => s.toLowerCase() === SORTED_MARK);
  if (markIdx >= 0 && dirs[markIdx + 1]) area = titleCaseArea(dirs[markIdx + 1]);

  let grade = null;
  for (const s of dirs) {
    const m = GRADE_RE.exec(s);
    if (m) {
      grade = Number(m[1]);
      break;
    }
  }
  if (grade == null) {
    const m = GRADE_CODE_RE.exec(fileName);
    if (m) grade = Number(m[1]);
  }
  return { area, grade };
}

function targetSubject({ area, grade }) {
  if (grade != null && area) return `Grade ${grade} ${area}`;
  if (grade != null) return `Grade ${grade}`;
  if (area) return area;
  return null; // underivable → leave subject alone, quarantine
}

/** Token-set key so "SOCIAL STUDIES - Grade 6" collides with "Grade 6 Social Studies". */
function collisionKey(subject) {
  return String(subject)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

const byNameThenId = (a, b) =>
  String(a.name || '').localeCompare(String(b.name || '')) || a.id - b.id;

// ---------------------------------------------------------------- plan

const plan = planner('03-lessons');

const rows = q(
  `SELECT id, name, file_path, subject, chapter, is_filler, approved
     FROM Resource
    WHERE channel_id = ? AND show_type_id = ?`,
  CHANNEL_ID,
  SHOW_TYPE_ID
);

const content = rows.filter((r) => !r.is_filler);
const fillers = rows.filter((r) => r.is_filler);
if (fillers.length) {
  plan.note(`${fillers.length} filler row(s) under Lessons left untouched (fillers carry no chapter)`);
}

const groups = new Map(); // subject → rows
const underivable = [];
for (const r of content) {
  const subject = targetSubject(derive(r.file_path));
  if (!subject) {
    underivable.push(r);
    continue;
  }
  if (!groups.has(subject)) groups.set(subject, []);
  groups.get(subject).push(r);
}

// Projected end state, so the dry run can verify exactly what --apply would leave.
const projected = new Map(
  rows.map((r) => [r.id, { subject: r.subject, chapter: r.chapter, approved: r.approved, name: r.name }])
);

const subjectNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));

for (const subject of subjectNames) {
  const items = groups.get(subject).slice().sort(byNameThenId);

  ensureSeries(plan, CHANNEL_ID, subject, SHOW_TYPE_ID, IS_SERIAL);

  let moved = 0;
  for (const r of items) {
    if (r.subject !== subject) {
      plan.op(
        'UPDATE Resource SET subject = ? WHERE id = ?',
        [subject, r.id],
        null
      );
      moved++;
    }
  }
  if (moved) plan.note(`move ${moved}/${items.length} row(s) → subject "${subject}"`);

  // renumber() reads the DB, and the subject moves above are not committed yet in
  // a dry run — so hand it the post-move row list explicitly.
  renumber(
    plan,
    CHANNEL_ID,
    subject,
    'name',
    items.map((r) => ({ id: r.id, name: r.name, chapter: r.chapter }))
  );

  items.forEach((r, i) => {
    const p = projected.get(r.id);
    p.subject = subject;
    p.chapter = i + 1;
  });
}

// Underivable rows: subject untouched, pulled out of scheduler reach.
for (const r of underivable) {
  const reason = 'lessons phase 3: no Area and no Grade derivable from file_path';
  if (r.approved === 0) {
    plan.note({ already_quarantined: r.id, name: r.name, file_path: r.file_path, reason });
  } else {
    quarantine(plan, r.id, r.name, reason);
    plan.note({ underivable_path: r.file_path, id: r.id });
  }
  projected.get(r.id).approved = 0;
}
plan.note(
  `${underivable.length} row(s) underivable → subject left unchanged, approved=0 (sort them in the Catalog Editor)`
);

// ------------------------------------------------- report-only observations

// Subjects that end up with zero Lessons rows (Phase 5 deactivates the registry rows).
const beforeCounts = new Map();
for (const r of rows) beforeCounts.set(r.subject, (beforeCounts.get(r.subject) || 0) + 1);
const afterCounts = new Map();
for (const p of projected.values()) afterCounts.set(p.subject, (afterCounts.get(p.subject) || 0) + 1);
const emptied = [...beforeCounts.keys()].filter((s) => !afterCounts.has(s)).sort();
plan.note(`subjects emptied by this phase (Phase 5 should deactivate): ${emptied.join(' | ') || '(none)'}`);

// Old subjects that KEEP rows (i.e. survive) — usually because their rows were underivable.
const survivors = [...beforeCounts.keys()].filter(
  (s) => afterCounts.has(s) && !groups.has(s)
);
for (const s of survivors) {
  plan.note(`subject "${s}" keeps ${afterCounts.get(s)} row(s) after the move (all underivable) — registry row stays`);
}

// Stale serial cursors on subjects that lost rows but were not renumbered.
for (const s of survivors) {
  const cs = one(
    'SELECT cursor_chapter FROM ChannelSeries WHERE channel_id = ? AND subject = ?',
    CHANNEL_ID,
    s
  );
  if (cs && cs.cursor_chapter != null) {
    plan.note(
      `HUMAN: "${s}" still has cursor_chapter=${cs.cursor_chapter} while its chapters remain grade numbers — its rows are quarantined, so decide in the Catalog Editor`
    );
  }
}

// Naming collisions with pre-existing registry rows (different spelling, same tokens).
const existingSeries = q(
  'SELECT subject FROM ChannelSeries WHERE channel_id = ? AND show_type_id = ?',
  CHANNEL_ID,
  SHOW_TYPE_ID
).map((r) => r.subject);
const existingByKey = new Map();
for (const s of existingSeries) {
  const k = collisionKey(s);
  if (!existingByKey.has(k)) existingByKey.set(k, []);
  existingByKey.get(k).push(s);
}
for (const subject of subjectNames) {
  const clash = (existingByKey.get(collisionKey(subject)) || []).filter((s) => s !== subject);
  for (const other of clash) {
    plan.note(
      `HUMAN: naming collision — new "${subject}" is the same content as existing series "${other}" (${beforeCounts.get(other) || 0} row(s) move out of it); Phase 5 should retire the old spelling`
    );
  }
}

// Serial series too short to be usable.
for (const subject of subjectNames) {
  const n = groups.get(subject).length;
  if (n <= 2) plan.note(`HUMAN: serial series "${subject}" ends up with only ${n} resource(s) — barely usable`);
}

// Area folder vs. filename disagreement (e.g. a Principles of Business lesson filed
// under Office Administration, or a Social Studies clip under English Language).
const KNOWN_AREAS = [...new Set(subjectNames.map((s) => s.replace(/^Grade \d+ ?/, '')).filter(Boolean))];
for (const subject of subjectNames) {
  for (const r of groups.get(subject)) {
    const { area } = derive(r.file_path);
    if (!area) continue;
    const fn = String(r.file_path).split('/').pop().toLowerCase();
    const hits = KNOWN_AREAS.filter((a) => fn.includes(a.toLowerCase()));
    if (hits.length && !hits.includes(area)) {
      plan.note(
        `HUMAN: id ${r.id} filed under Area "${area}" but the filename says "${hits.join('/')}" → landed in "${subject}" (${r.file_path})`
      );
    }
  }
}

const written = plan.commit();

// ---------------------------------------------------------- verification

function verifyState() {
  if (APPLY && written) {
    const live = q(
      'SELECT id, name, subject, chapter, approved FROM Resource WHERE channel_id = ? AND show_type_id = ?',
      CHANNEL_ID,
      SHOW_TYPE_ID
    );
    return { label: 'live DB', list: live };
  }
  return {
    label: 'projected (dry run)',
    list: [...projected.entries()].map(([id, p]) => ({ id, ...p })),
  };
}

const { label, list } = verifyState();

const dupApproved = new Map();
const dupQuarantined = new Map();
for (const r of list) {
  const key = `${r.subject}\u0000${r.chapter}`;
  const bucket = r.approved === 0 ? dupQuarantined : dupApproved;
  bucket.set(key, (bucket.get(key) || 0) + 1);
}
const dupsOf = (m) =>
  [...m.entries()]
    .filter(([, n]) => n > 1)
    .map(([k, n]) => ({ subject: k.split('\u0000')[0], chapter: k.split('\u0000')[1], count: n }))
    .sort((a, b) => b.count - a.count);

console.log(`\n=== verification — ${label} ===`);
const badDups = dupsOf(dupApproved);
console.log(`duplicate (subject, chapter) among schedulable rows: ${badDups.length}`);
for (const d of badDups) console.log(`  !! ${d.subject} / chapter ${d.chapter} × ${d.count}`);
const okDups = dupsOf(dupQuarantined);
if (okDups.length) {
  console.log(`duplicate (subject, chapter) among quarantined rows (expected, chapters still hold grades): ${okDups.length}`);
  for (const d of okDups) console.log(`  · ${d.subject} / chapter ${d.chapter} × ${d.count}`);
}

const counts = new Map();
for (const r of list) counts.set(r.subject, (counts.get(r.subject) || 0) + 1);
const table = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
console.log(`\n=== resulting Lessons series (${table.length}) ===`);
const width = Math.max(...table.map(([s]) => s.length));
for (const [subject, n] of table) {
  const short = groups.has(subject) && n <= 2 ? '  <- too short' : '';
  const quarantined = !groups.has(subject) ? '  <- quarantined leftovers' : '';
  console.log(`  ${subject.padEnd(width)}  ${String(n).padStart(4)}${short}${quarantined}`);
}
console.log(
  `\ntotals: ${content.length} content row(s) → ${groups.size} derived series, ${underivable.length} quarantined`
);
