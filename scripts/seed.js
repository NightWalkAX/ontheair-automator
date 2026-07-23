// Development seed + smoke test. Inserts a channel, show types, synthetic
// resources (bypassing ffprobe so it runs anywhere), and block templates, then
// generates a week and prints the fit report. Run: node scripts/seed.js
//
// Safe to re-run: uses INSERT OR IGNORE / stable names.

import { db, initSchema } from '../src/db.js';
import { generateWeek, blockDurationSeconds } from '../src/services/scheduling.js';

initSchema();

// Channel
db.prepare(`INSERT OR IGNORE INTO ChannelType (id, name, is_active, api_ip, api_port, playlist_ref)
            VALUES (1, 'Channel 1', 1, '127.0.0.1', 8081, '0')`).run();

// Show types
db.prepare(`INSERT OR IGNORE INTO ShowType (id, name, is_educational) VALUES (1, 'Lessons', 1)`).run();
db.prepare(`INSERT OR IGNORE INTO ShowType (id, name, is_educational) VALUES (2, 'Movies', 0)`).run();
db.prepare(`INSERT OR IGNORE INTO ShowType (id, name, is_educational) VALUES (3, 'Fillers', 0)`).run();

const addRes = db.prepare(`
  INSERT OR IGNORE INTO Resource (name, file_path, duration, subject, chapter, is_filler, audience_rating, channel_id, show_type_id, added_at)
  VALUES (@name, @file_path, @duration, @subject, @chapter, @is_filler, @rating, 1, @show_type_id, @added_at)
`);

// Lesson series "Math", chapters 1..5, ~28 min each
for (let ch = 1; ch <= 5; ch++) {
  addRes.run({ name: `Math Lesson ${ch}`, file_path: `/media/lessons/math_${ch}.mov`, duration: 1680, subject: 'Math', chapter: ch, is_filler: 0, rating: 0, show_type_id: 1, added_at: new Date(2026, 0, ch).toISOString() });
}
// Movies pool
const movieDurations = [5400, 6000, 5700, 4800, 5100, 6300];
movieDurations.forEach((d, i) =>
  addRes.run({ name: `Movie ${i + 1}`, file_path: `/media/movies/movie_${i + 1}.mov`, duration: d, subject: 'Movies', chapter: 0, is_filler: 0, rating: 12, show_type_id: 2, added_at: new Date(2026, 1, i + 1).toISOString() })
);
// TV series "TV", chapters 1..4, ~25 min each (Sunday picks the latest)
for (let ch = 1; ch <= 4; ch++) {
  addRes.run({ name: `TV Episode ${ch}`, file_path: `/media/tv/ep_${ch}.mov`, duration: 1500, subject: 'TV', chapter: ch, is_filler: 0, rating: 0, show_type_id: 2, added_at: new Date(2026, 2, ch).toISOString() });
}
// Fillers of assorted short lengths (seconds) for the knapsack
[30, 45, 60, 90, 120, 15, 20, 300, 240, 10, 5].forEach((d, i) =>
  addRes.run({ name: `Filler ${i + 1} (${d}s)`, file_path: `/media/fillers/f_${i + 1}.mov`, duration: d, subject: 'Filler', chapter: 0, is_filler: 1, rating: 0, show_type_id: 3, added_at: new Date().toISOString() })
);

// Block templates for each weekday
const addTpl = db.prepare(`
  INSERT OR IGNORE INTO BlockTemplate (id, channel_id, name, weekday, start_time, end_time, target_subject, content_type)
  VALUES (@id, 1, @name, @weekday, @start, @end, @subject, @type)
`);
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
days.forEach((wd, i) => {
  addTpl.run({ id: 100 + i, name: `${wd} Lesson`, weekday: wd, start: '08:00', end: '08:30', subject: 'Math', type: 'lesson_series' });
  addTpl.run({ id: 200 + i, name: `${wd} Movie`, weekday: wd, start: '20:00', end: '21:35', subject: 'Movies', type: 'movie' });
  addTpl.run({ id: 300 + i, name: `${wd} TV`, weekday: wd, start: '18:00', end: '18:30', subject: 'TV', type: 'tv_episode' });
});

console.log('Seed complete. Generating week...\n');
const results = generateWeek(new Date());
for (const r of results) {
  const tag = r.fits ? 'OK ' : 'OFF';
  console.log(`[${tag}] block ${r.blockId}  slot=${fmtSecs(r.blockSeconds)}  main=${r.mainCount} fillers=${r.fillerCount}  underrun=${r.underrun}s`);
}
const misfits = results.filter((r) => !r.fits).length;
console.log(`\n${results.length} blocks generated, ${misfits} outside tolerance.`);

function fmtSecs(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}`;
}
