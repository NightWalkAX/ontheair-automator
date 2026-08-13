// Phase 5 — ChannelSeries registry cleanup.
//
// The registry is what gates scheduler visibility: templateSeries()
// (src/services/scheduling.js:84-97) only reaches a series when its
// ChannelSeries row has is_active = 1 AND a BlockTemplateSeries row names its
// subject. So a registry row that no longer matches any Resource is dead weight
// that still shows up in pickers, and a subject that has resources but no active
// row is invisible content.
//
// Policy is QUARANTINE, NEVER DELETE: orphan rows are deactivated (is_active = 0),
// which is one UPDATE away from being undone.
//
// SEQUENCING: this runs AFTER 02 (series splits), 03 (Lessons regrouping) and
// 04 (hygiene). Those phases rewrite Resource.subject wholesale — roughly a
// thousand Lessons rows change subject and several TV series get split — so
// NOTHING here is hardcoded: every subject, id, bucket and count is derived from
// the DB at runtime. Dry-running before 02/03 are applied therefore shows the
// pre-cleanup picture; the logic is what's being reviewed, not the numbers.
//
// What it does:
//   1. Orphan registry rows (no matching Resource on channel_id + subject) → is_active = 0.
//   2. Stale cursors → cursor_chapter = NULL (row now inactive, or the cursor
//      falls outside the real MIN(chapter)..MAX(chapter) of its resources).
//   3. Missing registrations → ensureSeries() for every distinct (channel, subject)
//      on non-filler resources that lacks an active row.
//   4. Report-only findings that need a human: BlockTemplateSeries rows pointing
//      at a deactivated/empty series, broken serial chapter numbering, and
//      series with fewer than 3 resources.
//
// Dry run by default; --apply commits.

import { db, q, one, APPLY, flag, planner, ensureSeries } from './lib.js';

const plan = planner('05-registry');
const VERBOSE = flag('--verbose');

// --- Current state ----------------------------------------------------------

const series = q(`
  SELECT cs.id, cs.channel_id, cs.subject, cs.show_type_id, cs.is_serial,
         cs.is_active, cs.cursor_chapter,
         ch.name AS channel_name
    FROM ChannelSeries cs
    LEFT JOIN ChannelType ch ON ch.id = cs.channel_id
   ORDER BY cs.channel_id, cs.subject
`);

// Per (channel, subject) resource facts, non-filler only. is_filler rows are the
// shared filler pool, not series content, and never get a registry row.
const resourceStats = q(`
  SELECT channel_id,
         subject,
         COUNT(*)                                   AS n,
         SUM(CASE WHEN approved = 1 THEN 1 ELSE 0 END) AS n_approved,
         MIN(chapter)                               AS lo,
         MAX(chapter)                               AS hi,
         COUNT(DISTINCT chapter)                    AS distinct_chapters,
         SUM(CASE WHEN chapter IS NULL OR chapter = 0 THEN 1 ELSE 0 END) AS n_zero_chapter
    FROM Resource
   WHERE is_filler = 0 AND subject IS NOT NULL AND TRIM(subject) <> ''
   GROUP BY channel_id, subject
`);

const key = (channelId, subject) => `${channelId}\u0000${subject}`;
const statsBy = new Map(resourceStats.map((r) => [key(r.channel_id, r.subject), r]));

const showTypes = q('SELECT id, code, name FROM ShowType');
const showTypeById = new Map(showTypes.map((t) => [t.id, t]));

// Resources whose subject is blank can't be registered at all — reported, not fixed.
const blankSubject = q(`
  SELECT channel_id, COUNT(*) AS n FROM Resource
   WHERE is_filler = 0 AND (subject IS NULL OR TRIM(subject) = '')
   GROUP BY channel_id
`);

// --- Bucket heuristics (structural, computed at runtime) ---------------------

/** Case/punctuation/spacing-insensitive identity used for twin detection. */
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const tokens = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

// Release-group / scene tokens that only ever appear in a downloaded folder name.
const RELEASE_TOKEN =
  /^(?:\d{3,4}p|x26[45]|h26[45]|hevc|bluray|brrip|bdrip|webrip|webdl|web|hdtv|dvdrip|xvid|divx|aac|ac3|dts|yify|rarbg|ettv|eztv|repack|proper|internal|extended|uncut|remux|iso|complete|multi|dual|subs|netflix|amzn|hulu|bbc)$/;
const SEASON_TOKEN = /^(?:s\d{1,2}(?:e\d{1,3})?|e\d{2,3}|season\d{1,2}|\d{1,2}x\d{2,3})$/;
const YEARISH = /(?:19|20)\d{2}/;

/**
 * Torrent/scene folder name: machine-shaped rather than typed by a human. The
 * giveaway is the absence of real spaces plus at least one of: separator-joined
 * multi-word structure, a scene/season token, an embedded year, or a run of
 * CamelCase words.
 */
function looksLikeTorrentName(subject) {
  const s = String(subject);
  if (/\s/.test(s)) return false; // a human typed spaces
  const tk = tokens(s);
  const sepTokens = s.split(/[._-]+/).filter(Boolean).length;
  const camelSegments = (s.match(/[A-Z][a-z]+|[A-Z]{2,}(?![a-z])/g) || []).length;
  const hasLower = /[a-z]/.test(s);
  return (
    sepTokens >= 3 ||
    (sepTokens >= 2 && (YEARISH.test(s) || tk.some((t) => RELEASE_TOKEN.test(t) || SEASON_TOKEN.test(t)))) ||
    tk.some((t) => RELEASE_TOKEN.test(t) || SEASON_TOKEN.test(t)) ||
    (YEARISH.test(s) && s.length > 12) ||
    (camelSegments >= 3 && hasLower)
  );
}

/**
 * Generic organisational vocabulary — the words that show up when a scan picked
 * up a working folder instead of a show. Show type names/codes are folded in
 * from the DB (a folder literally called "Lessons" is a container, not a series).
 */
const GENERIC_WORDS = new Set([
  'new', 'old', 'folder', 'folders', 'dir', 'directory',
  'check', 'checks', 'checked', 'recheck',
  'duplicate', 'duplicates', 'dupe', 'dupes', 'copy', 'copies',
  'final', 'finals', 'draft', 'drafts',
  'temp', 'tmp', 'misc', 'other', 'others', 'various', 'unsorted', 'stuff',
  'of', 'the', 'and', 'interest',
  'season', 'seasons', 'series', 'episode', 'episodes',
  'jr', 'sr', 'junior', 'senior',
  'done', 'todo', 'pending', 'review', 'reviewed', 'approved',
  'backup', 'backups', 'archive', 'archived',
  'untitled', 'unnamed', 'edited', 'edit', 'edits', 'raw', 'extra', 'extras',
  'test', 'tests', 'sample', 'samples', 'clips', 'videos', 'video', 'media', 'content',
]);
for (const t of showTypes) {
  for (const w of tokens(t.name)) GENERIC_WORDS.add(w);
  for (const w of tokens(t.code || '')) GENERIC_WORDS.add(w);
}

/** Every token is a generic organisational word → a folder artifact, not a show. */
function looksLikeFolderArtifact(subject) {
  const tk = tokens(subject);
  return tk.length > 0 && tk.every((t) => GENERIC_WORDS.has(t));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The live subject (one that HAS resources) this orphan is probably a stale
 * case/spelling variant of. Three tiers, tightest first: identical once
 * normalised, one a prefix of the other, then near-identical by edit distance
 * (length-gated so short labels like "Grade 1"/"Grade 4" can't pair up).
 */
function findTwin(channelId, subject) {
  const n = norm(subject);
  if (!n) return null;
  const candidates = resourceStats.filter((r) => r.channel_id === channelId && norm(r.subject) !== '');
  for (const c of candidates) if (norm(c.subject) === n) return { subject: c.subject, how: 'case/punctuation' };
  for (const c of candidates) {
    const cn = norm(c.subject);
    const [short, long] = n.length <= cn.length ? [n, cn] : [cn, n];
    if (short.length >= 8 && long.startsWith(short)) return { subject: c.subject, how: 'prefix' };
  }
  let best = null;
  for (const c of candidates) {
    const cn = norm(c.subject);
    if (Math.min(n.length, cn.length) < 10) continue;
    const d = levenshtein(n, cn);
    const sim = 1 - d / Math.max(n.length, cn.length);
    if (sim >= 0.85 && (!best || sim > best.sim)) best = { subject: c.subject, how: `similarity ${sim.toFixed(2)}`, sim };
  }
  return best;
}

/** Bucket an orphan subject. Structural signals win; anything unclear → other. */
function bucketFor(channelId, subject) {
  const twin = findTwin(channelId, subject);
  let bucket;
  if (looksLikeTorrentName(subject)) bucket = 'torrent-name';
  else if (looksLikeFolderArtifact(subject)) bucket = 'folder-artifact';
  else if (twin) bucket = 'case-or-spelling twin';
  else bucket = 'other';
  return { bucket, twin };
}

// --- 1. Orphan registry rows → is_active = 0 --------------------------------

const deactivated = new Set(); // ChannelSeries.id
const buckets = new Map();     // bucket → [{ subject, twin }]

for (const s of series) {
  if (statsBy.has(key(s.channel_id, s.subject))) continue; // has resources
  const { bucket, twin } = bucketFor(s.channel_id, s.subject);
  if (!buckets.has(bucket)) buckets.set(bucket, []);
  buckets.get(bucket).push({ id: s.id, subject: s.subject, twin });

  if (s.is_active) {
    deactivated.add(s.id);
    plan.op(
      'UPDATE ChannelSeries SET is_active = 0 WHERE id = ?',
      [s.id],
      `deactivate orphan series "${s.subject}" [${bucket}]` +
        (twin ? ` (twin of "${twin.subject}" — ${twin.how})` : '')
    );
  }
}

// --- 2. Stale cursors → NULL ------------------------------------------------

const cursorCleared = new Set();
for (const s of series) {
  if (s.cursor_chapter == null) continue;
  const st = statsBy.get(key(s.channel_id, s.subject));
  const willBeInactive = !s.is_active || deactivated.has(s.id);
  let reason = null;
  if (willBeInactive) reason = 'series inactive';
  else if (!st) reason = 'series has no resources';
  else if (s.cursor_chapter < st.lo || s.cursor_chapter > st.hi)
    reason = `cursor ${s.cursor_chapter} outside chapter range ${st.lo}..${st.hi}`;
  if (!reason) continue;
  cursorCleared.add(s.id);
  plan.op(
    'UPDATE ChannelSeries SET cursor_chapter = NULL WHERE id = ?',
    [s.id],
    `clear stale cursor on "${s.subject}" (was ${s.cursor_chapter}; ${reason})`
  );
}

// --- 3. Missing registrations ----------------------------------------------

// A subject's show type is the majority vote of its resources; serial-ness follows
// the show type (Lessons / TV Shows / Documentaries progress by chapter, Movies don't).
const SERIAL_CODES = new Set(['lessons', 'tv_shows', 'documentaries']);

function majorityShowType(channelId, subject) {
  const rows = q(
    `SELECT show_type_id, COUNT(*) AS n FROM Resource
      WHERE channel_id = ? AND subject = ? AND is_filler = 0 AND show_type_id IS NOT NULL
      GROUP BY show_type_id ORDER BY n DESC, show_type_id ASC LIMIT 1`,
    channelId,
    subject
  );
  return rows.length ? rows[0].show_type_id : null;
}

const activeBy = new Map();
for (const s of series) activeBy.set(key(s.channel_id, s.subject), s);

const registered = [];
for (const st of resourceStats) {
  const existing = activeBy.get(key(st.channel_id, st.subject));
  if (existing && existing.is_active && !deactivated.has(existing.id)) continue;

  const showTypeId = majorityShowType(st.channel_id, st.subject);
  const code = showTypeById.get(showTypeId)?.code || null;
  const isSerial = code ? SERIAL_CODES.has(code) : 0;
  ensureSeries(plan, st.channel_id, st.subject, showTypeId, isSerial);
  registered.push({
    channel_id: st.channel_id,
    subject: st.subject,
    resources: st.n,
    show_type: code || `id=${showTypeId}`,
    is_serial: isSerial ? 1 : 0,
    action: existing ? 'reactivate' : 'insert',
  });
  // Keep the projection honest for the verification pass below.
  if (existing) existing.is_active = 1;
  else activeBy.set(key(st.channel_id, st.subject), { id: null, ...st, is_active: 1 });
}

// --- 3b. Align registry show_type_id with the content it actually holds -----
// A registry row can disagree with its resources (e.g. `R.E.A.D` is registered
// as Lessons while all 50 clips are TV Shows). This does NOT change scheduling:
// ruleFor() in src/services/scheduling.js:112 returns 'serial' whenever
// is_serial = 1, ahead of any show-type test, and every mismatched row is serial.
// It does drive the Catalog/template UI's show-type filter, so a wrong value hides
// a series from the operator where they'd look for it. Align to the majority show
// type of the series' own resources.
for (const row of q(`
  SELECT cs.id, cs.channel_id, cs.subject, cs.show_type_id AS registry_type,
         r.show_type_id AS content_type, COUNT(*) AS n
    FROM ChannelSeries cs
    JOIN Resource r ON r.channel_id = cs.channel_id AND r.subject = cs.subject
   WHERE r.is_filler = 0 AND r.show_type_id IS NOT NULL
   GROUP BY cs.id, r.show_type_id
   ORDER BY cs.id, n DESC
`).reduce((best, r) => {
  // First row per series wins (ORDER BY n DESC) = the majority show type.
  if (!best.some((b) => b.id === r.id)) best.push(r);
  return best;
}, []).filter((r) => r.registry_type !== r.content_type)) {
  plan.op(
    'UPDATE ChannelSeries SET show_type_id = ? WHERE id = ?',
    [row.content_type, row.id],
    `align show type of "${row.subject}": registry ${row.registry_type} -> content ${row.content_type} (${row.n} clips)`
  );
  plan.note({
    showTypeAligned: row.subject,
    from: row.registry_type,
    to: row.content_type,
    clips: row.n,
  });
}

// --- 4. Report-only: things that need a human ------------------------------

// BlockTemplateSeries has NO series_id — it references a series by TEXT `subject`
// scoped to the template (src/db.js:157). The channel comes from the template, so
// resolve every channel the template airs on (BlockTemplateChannel, plus the
// legacy BlockTemplate.channel_id primary) before judging a row.
const btsRows = q(`
  SELECT bts.id, bts.template_id, bts.subject, bts.play_order,
         bt.name AS template_name, bt.channel_id AS primary_channel
    FROM BlockTemplateSeries bts
    JOIN BlockTemplate bt ON bt.id = bts.template_id
   ORDER BY bts.template_id, bts.play_order
`);

for (const b of btsRows) {
  const chans = q('SELECT channel_id FROM BlockTemplateChannel WHERE template_id = ?', b.template_id).map(
    (r) => r.channel_id
  );
  if (b.primary_channel != null && !chans.includes(b.primary_channel)) chans.push(b.primary_channel);
  if (!chans.length) {
    plan.note({
      review: 'block-template-series',
      template: b.template_name,
      subject: b.subject,
      problem: 'template has no channel — cannot resolve the series',
    });
    continue;
  }
  for (const ch of chans) {
    const cs = series.find((s) => s.channel_id === ch && s.subject === b.subject);
    const st = statsBy.get(key(ch, b.subject));
    const problems = [];
    if (!cs) problems.push('no ChannelSeries row for this channel');
    else if (deactivated.has(cs.id)) problems.push('series deactivated by this phase (orphan)');
    else if (!cs.is_active) problems.push('series already inactive');
    if (!st) problems.push('zero resources');
    else if (!st.n_approved) problems.push(`zero APPROVED resources (${st.n} unapproved)`);
    if (!problems.length) continue;
    plan.note({
      review: 'block-template-series',
      template: b.template_name,
      channel_id: ch,
      subject: b.subject,
      problem: problems.join('; '),
      effect: 'this template silently produces an empty/short block',
    });
  }
}

// Serial series whose chapter numbering can't drive progression.
for (const s of series) {
  const st = statsBy.get(key(s.channel_id, s.subject));
  if (!st) continue;
  const willBeSerial = s.is_serial === 1;
  if (!willBeSerial) continue;
  const dupes = st.n - st.distinct_chapters;
  if (dupes > 0 || st.n_zero_chapter > 0) {
    plan.note({
      review: 'serial-numbering',
      channel_id: s.channel_id,
      subject: s.subject,
      resources: st.n,
      duplicate_chapters: dupes,
      zero_chapters: st.n_zero_chapter,
      problem: 'is_serial = 1 but chapters are not a clean 1..N sequence',
      effect: 'sequential progression picks arbitrarily / repeats',
    });
  }
}

// Thin series — usually a mis-grouped folder rather than a real show.
for (const st of resourceStats) {
  if (st.n >= 3) continue;
  const cs = series.find((s) => s.channel_id === st.channel_id && s.subject === st.subject);
  plan.note({
    review: 'thin-series',
    channel_id: st.channel_id,
    subject: st.subject,
    resources: st.n,
    registered: cs ? (deactivated.has(cs.id) ? 'deactivating' : cs.is_active ? 'active' : 'inactive') : 'missing',
    problem: 'fewer than 3 resources',
  });
}

for (const b of blankSubject) {
  plan.note({
    review: 'blank-subject',
    channel_id: b.channel_id,
    resources: b.n,
    problem: 'non-filler resources with NULL/empty subject cannot be registered',
  });
}

// --- Bucket report ----------------------------------------------------------

console.log(`\n=== orphan registry rows by bucket ===`);
const BUCKET_ORDER = ['torrent-name', 'folder-artifact', 'case-or-spelling twin', 'other'];
const orphanTotal = [...buckets.values()].reduce((a, v) => a + v.length, 0);
for (const name of BUCKET_ORDER) {
  const rows = buckets.get(name) || [];
  console.log(`\n  ${name} — ${rows.length}`);
  for (const r of rows) {
    console.log(`    · ${JSON.stringify(r.subject)}${r.twin ? `  → twin of ${JSON.stringify(r.twin.subject)} (${r.twin.how})` : ''}`);
  }
}
for (const [name, rows] of buckets) {
  if (BUCKET_ORDER.includes(name)) continue;
  console.log(`\n  ${name} — ${rows.length}`);
  for (const r of rows) console.log(`    · ${JSON.stringify(r.subject)}`);
}
console.log(`\n  total orphan rows: ${orphanTotal} of ${series.length} registry rows`);

if (registered.length) {
  console.log(`\n=== missing registrations — ${registered.length} ===`);
  for (const r of registered) {
    console.log(
      `  · ch${r.channel_id} ${JSON.stringify(r.subject)} — ${r.resources} resource(s), ` +
        `show_type=${r.show_type}, is_serial=${r.is_serial} (${r.action})`
    );
  }
} else {
  console.log(`\n=== missing registrations — none ===`);
}

plan.commit();

// --- Verification ----------------------------------------------------------
// After --apply these are read back from the DB. On a dry run the same figures
// are projected from the plan, so the operator sees what apply would land on.

function verify(label, { projected }) {
  const rows = projected
    ? series.map((s) => ({
        ...s,
        is_active: deactivated.has(s.id) ? 0 : s.is_active,
        cursor_chapter: cursorCleared.has(s.id) ? null : s.cursor_chapter,
      }))
    : q('SELECT id, channel_id, subject, is_active, cursor_chapter FROM ChannelSeries');

  // Projected rows must also include the registrations the plan would insert.
  const activeKeys = new Set();
  let active = 0;
  let inactive = 0;
  for (const r of rows) {
    if (r.is_active) {
      active++;
      activeKeys.add(key(r.channel_id, r.subject));
    } else inactive++;
  }
  if (projected) {
    for (const r of registered) {
      if (activeKeys.has(key(r.channel_id, r.subject))) continue;
      activeKeys.add(key(r.channel_id, r.subject));
      active++;
    }
  }

  const unregistered = resourceStats.filter((st) => !activeKeys.has(key(st.channel_id, st.subject)));

  let badCursors = 0;
  for (const r of rows) {
    if (r.cursor_chapter == null) continue;
    const st = statsBy.get(key(r.channel_id, r.subject));
    if (!r.is_active || !st || r.cursor_chapter < st.lo || r.cursor_chapter > st.hi) badCursors++;
  }

  console.log(`\n=== verification (${label}) ===`);
  console.log(`  active series:                        ${active}`);
  console.log(`  inactive (quarantined) series:        ${inactive}`);
  console.log(`  resource subjects w/o active row:     ${unregistered.length} (must be 0)`);
  if (unregistered.length && VERBOSE)
    for (const u of unregistered) console.log(`      ! ch${u.channel_id} ${JSON.stringify(u.subject)}`);
  console.log(`  out-of-range / orphaned cursors:      ${badCursors} (must be 0)`);
  return unregistered.length === 0 && badCursors === 0;
}

const ok = verify(APPLY ? 'after apply' : 'projected after --apply', { projected: !APPLY });
if (!APPLY) {
  console.log('\n  (pre-cleanup snapshot, for contrast)');
  const preActive = series.filter((s) => s.is_active).length;
  console.log(`  active series before:                 ${preActive}`);
  console.log(`  inactive series before:               ${series.length - preActive}`);
}
if (!ok) {
  console.error('\n[FAIL] verification did not reach a clean state — inspect the findings above.');
  process.exitCode = 1;
}
