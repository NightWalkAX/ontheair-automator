#!/usr/bin/env node
// Phase 12 — remove series registry rows that describe content the catalogue no
// longer holds.
//
// Symptom being repaired: the Block Editor's series picker on channels 2 and 3
// lists ~12,800 entries each, nearly all of them dead — "New folder", "FX3",
// "sesame-street-2010s", "Math Intervention Highlight.PRV", "Copied_NCERD
// video". Finding the series you actually want in there is hopeless.
//
// Where they came from: ChannelSeries holds one row per SUBJECT, and ingestion
// derives a subject from every folder it walks (registerSeries() in
// services/ingestion.js). When /Volumes/Public was assigned as a media root,
// the scan walked the whole production share and registered a series for every
// folder on it. The paths were later pruned (10-prune-media-roots.js), but that
// script deletes Resource and MediaRoot rows only — ChannelSeries has no
// foreign key to Resource (it joins by channel_id + subject TEXT), so the
// registry rows stayed behind, pointing at nothing.
//
// What is removed: a ChannelSeries row with NO Resource under that channel and
// subject, AND not named by any BlockTemplateSeries. Both conditions, always:
// an empty series a template still names is a real configuration the operator
// is mid-way through, not rubbish.
//
// Nothing else is touched. A series row carries the serial flag, the play order
// and the progression cursor, so this can only affect a series that has no
// clips to progress through.
//
// Usage:
//   node scripts/cleanup/12-prune-orphan-series.js                 # report only
//   node scripts/cleanup/12-prune-orphan-series.js --channel 2
//   node scripts/cleanup/12-prune-orphan-series.js --apply
//
// Honours SCHEDULER_DB, so rehearse it against a copy first.

import { planner, q } from './lib.js';

const argOf = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : null;
};
const onlyChannel = argOf('channel') ? Number(argOf('channel')) : null;

const where = onlyChannel ? 'WHERE cs.channel_id = ?' : '';
const args = onlyChannel ? [onlyChannel] : [];

const orphans = q(`
  SELECT cs.id, cs.channel_id, cs.subject, c.name AS channel_name
  FROM ChannelSeries cs
  LEFT JOIN ChannelType c ON c.id = cs.channel_id
  ${where}
  ${where ? 'AND' : 'WHERE'} NOT EXISTS (
    SELECT 1 FROM Resource r
    WHERE r.channel_id = cs.channel_id AND r.subject = cs.subject
  )
  AND NOT EXISTS (
    SELECT 1 FROM BlockTemplateSeries bts
    JOIN BlockTemplate bt ON bt.id = bts.template_id
    WHERE bts.subject = cs.subject AND bt.channel_id = cs.channel_id
  )
  ORDER BY cs.channel_id, cs.subject
`, ...args);

const plan = planner('12-prune-orphan-series');

const byChannel = new Map();
for (const o of orphans) {
  if (!byChannel.has(o.channel_id)) byChannel.set(o.channel_id, { name: o.channel_name, rows: [] });
  byChannel.get(o.channel_id).rows.push(o.subject);
  plan.op('DELETE FROM ChannelSeries WHERE id = ?', [o.id], null);
}

console.log('\nSeries registradas sin un solo clip y sin plantilla que las use');
console.log('-'.repeat(64));
for (const [id, v] of byChannel) {
  const kept = q(
    'SELECT COUNT(*) AS n FROM ChannelSeries WHERE channel_id = ?', id
  )[0].n - v.rows.length;
  console.log(`  channel ${id} (${v.name ?? '?'}): ${v.rows.length} a borrar, ${kept} se quedan`);
  console.log(`    p.ej. ${v.rows.slice(0, 6).map((s) => JSON.stringify(s)).join(', ')}`);
}
if (!orphans.length) console.log('  ninguna — el registro de series está limpio.');

plan.commit();
