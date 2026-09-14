# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository is **pre-implementation**. It currently contains only planning material — no application code, `package.json`, Dockerfiles, or source tree exist yet:

- `SEED.md` — the master project blueprint (system overview, tech stack, DB schema, module specs, Docker volume layout). Treat this as the authoritative product/architecture spec until code exists to supersede it.
- `OnTheAir Video REST API documentation.htm` — vendor REST API reference for the video playout systems this tool must integrate with. Open it in a browser or strip tags to read; see "OnTheAir Video REST API" below for the parts relevant to this project.

When asked to start implementing, scaffold the project according to the stack and structure described in `SEED.md` rather than inventing a different architecture. If `SEED.md` and the actual code ever diverge, prefer the code and flag the discrepancy — SEED.md is the seed intent, not necessarily up to date.

## What this system does

An internal, on-premise TV broadcast scheduler for a government network. It:

1. Scans mounted media directories (`ffmpeg`/`ffprobe`) to catalog video assets into SQLite. A
   re-scan is **incremental**: a file already catalogued for that channel whose mtime still
   matches its stored `added_at` reuses its duration instead of paying for another ffprobe (one
   process spawn plus a container read over SMB, per file — that is the entire cost of a scan).
   Any mismatch falls through to a probe, so the failure mode is "slower", never "stale"; the two
   ways a duration can change (an operator replacing the file, Air Spec swapping in a conversion)
   both move mtime. `force` re-probes everything, for when the catalogue is suspected wrong
   rather than out of date. Rows are still BUILT for skipped files — franchise detection weighs
   a title against every other title in its folder, so omitting them would break saga grouping
   and series registration on every re-scan.
   **The walk is cycle-safe by IDENTITY, not by depth.** Over SMB a symlink on the server
   reaches the client as a real DIRECTORY (Samba `follow symlinks` / `wide links`), so a link
   pointing back at an ancestor makes `collectVideoFiles()` re-enumerate the subtree once per
   level — that is how ~5k clips get announced as 196014 files to scan. A depth cap only bounds
   how bad it gets (one link inflates a folder ~24x, two multiply rather than add), so every
   directory's `dev:ino` is recorded and never walked twice, and files are de-duplicated the
   same way — two independent layers, either of which bounds the result. Symlinked folders ARE
   followed (that is what SMB already does, and skipping them locally made linked folders
   silently invisible); it is only safe because of the identity check. `MAX_WALK_DEPTH` stays as
   a backstop for a filesystem with no stable inodes.
   **A number far bigger than the library means the bloat is already in the DB.** Air Spec's
   "clips this run" is `catalogFiles()` — `Resource` grouped by `file_path` — not a walk. A scan
   that ran BEFORE the walk was cycle-safe persisted a row per enumerated path, so the same clip
   sits under thousands of looped paths. `scripts/cleanup/09-diagnose-catalog-bloat.js` (writes
   nothing) reports it: distinct paths, which paths repeat a directory segment, the path-depth
   histogram, what `ScheduleItem`/`PlayHistory` still reference, and how many distinct `dev:ino`
   the paths resolve to. That last ratio is what decides the repair — many paths per physical
   file is a de-duplication, all-ENOENT is a different problem — so run it before any cleanup.
   **Show type comes from the DEEPEST media root that contains the file.** Two paths used to
  break that: `cloneScannedResources()` forced the newly added root's show type onto every file
  in its subtree (a root added one level too high re-typed thousands of clips, and 971 lesson
  files per channel ended up as Movies — which is how lessons started airing in movie blocks),
  and `PUT /api/media/roots/:id` changed a root's type without re-tagging what it had already
  catalogued. Both now resolve per file against the deepest containing root, `ChannelSeries`
  included, and `scripts/cleanup/11-retag-show-types.js` (dry run, `--apply`) repairs a catalogue
  the old behaviour already wrote.
  **A media root may not CONTAIN another media root** (`containedRootsError()` in
   `src/routes/media.js`, enforced on add, edit and copy, scoped per channel, HTTP 409). This is
   the guard for the incident above: assigning `/Volumes/Public` as a root pulled the whole
   production share into the catalogue. Adding a DEEPER root is still allowed — that is how a
   subfolder gets its own show type (`Mathematics` alongside `Mathematics/Grade 1`), and it
   narrows the scan. An edit that leaves the path and channel alone is not checked either, or the
   show type of a parent root could never be changed again once a child existed.
   **Two different operations, don't conflate them:** `POST /api/media/scan` DISCOVERS new files
   and therefore has to `readdir` every folder under every media root — the whole share, whether
   or not any of it is catalogued. `POST /api/media/recheck` (`recheckCatalog()`, the "Re-check
   catalogued clips" button) takes the file list from the DATABASE instead and performs **zero
   directory listings**: per file a `stat`, then a probe only if mtime moved. It is the cheap
   answer to "are my clips still there and still the length I recorded?", and the only thing
   that reports a catalogued clip that has **vanished** — which is what makes a scheduled block
   fail on air. Missing clips are reported, never deleted (a share hiccup must not shrink the
   catalogue), and an unreadable file is reported separately from a missing one: "fix
   permissions" and "somebody deleted a film" are different problems.
2. Auto-generates weekly draft schedules from fixed block templates using rule-based content selection (sequential series/lesson playback, cooldown-based random movie selection, latest-episode-first for Sunday TV blocks).
3. Fits filler clips into each block via a "knapsack" pass targeting 0s overrun / max 5s underrun.
4. Presents drafts in an admin review UI for manual reordering/swapping before approval. The week grid shows ONE channel at a time (chip strip, remembered in `localStorage`) and carries only each block's fit summary — `GET /api/blocks` takes those totals as one grouped `SUM`, and the clips load when a block is opened (`GET /api/blocks/:id`). Do not reintroduce a per-block `validateBlock()` call there: it labels every clip of every block and its `EPISODE_NO_CTE` window-numbers the whole non-filler catalogue per call, which was 613ms of SQL for one week of one channel. `Generate drafts`, `Approve fitting drafts` and `Download schedule` are week-wide and cover EVERY channel regardless of the chip — the chip filters the view, not the actions.
5. Pushes approved schedules to 6 separate **Softron OnTheAir Video (OTAV)** instances over their REST APIs.

## Intended technology stack (per SEED.md)

Portable, non-containerized, **macOS-native** app — the whole project folder (code + SQLite data) must be copyable via USB drive and runnable on any Mac with minimal setup. No Docker, no build step required to run.

- **Orchestration:** None — start the backend process directly (e.g. `node server.js`).
- **Frontend:** Plain HTML, CSS, and vanilla JavaScript — no framework, no bundler. Served as static files by the backend.
- **Backend:** Node.js (Express/Fastify) or Python (FastAPI) — serves the static frontend, handles API routes, SQLite access, the cron scheduling engine, and HTTP calls out to OTAV.
- **Database:** SQLite, single file (`./data/scheduler.sqlite`) inside the project folder so it travels with the app on USB. Enable `PRAGMA foreign_keys = ON`.
- **Logging:** `src/logger.js` → `data/logs/automator.log` (rotates at 8MB, keeps 5). `server.js`
  is a deliberately tiny bootstrap that installs logging and then `await import('./src/app.js')`
  — ESM hoists static imports, so anything imported directly by the entrypoint would evaluate
  BEFORE logging existed, and a module that throws while initialising (unreadable config, locked
  SQLite, port taken) is exactly the crash that used to leave no evidence. Don't move app setup
  back into `server.js`. Lines are written with `writeSync` on an append fd, not through a
  stream, so a crash cannot discard the last thing that happened; `uncaughtException`,
  `unhandledRejection`, node warnings, signals and non-zero exits are all recorded. A
  blocked-event-loop watchdog logs any synchronous stall over 2s — that is what "the whole app
  froze" looks like, and no request log shows it. `GET /api/log?lines=N` tails it from the
  browser (reaching into the rotated files, since rotation happens on the write that crosses the
  limit and leaves the live file briefly empty). `progressLogger()` is what long loops report
  through: rate, ETA and RSS every 15s plus a warning for any single step over 20s, which is how
  a stalled SMB read shows itself. **`SCHEDULER_LOG_DIR` isolates it for tests** the way
  `SCHEDULER_DB` does the database — the npm scripts set both; without it a test run writes into
  the operator's `data/`.
- **Data repairs run at startup, once:** `src/migrations/` + `runPendingMigrations()`, called from `src/app.js` right after `initSchema()` and before any route is mounted. These are NOT schema changes (db.js does those every boot, idempotently) — they repair ROWS earlier bugs wrote, which is expensive to compute, pointless to redo, and not something an operator should have to remember to run from a terminal on a playout Mac. Each migration module exports `id`, `description` and a **read-only** `plan()` returning `{ ops, summary }`; the runner applies the ops in one transaction and appends the id to **`data/.migrations.lock`** — beside the database, never versioned, because it describes one installation's history and a folder copied onto a different database must be free to repair that one. The lock is written only after the transaction commits, so a crash mid-repair leaves the migration pending; an unreadable lock treats everything as pending, which is safe because a repair is idempotent. A migration that throws is logged and left pending rather than stopping the app — the schedule still has to air. `scripts/cleanup/11` and `12` are thin CLIs over the same modules, for seeing what a repair would do (dry run) before a database is ever started.
- **Settings:** `config/config.json`, re-read on every `loadConfig()` call (no restart to pick up an edit) and written back by `updateConfig()` for the handful of settings the UI can change. `SCHEDULER_CONFIG` points both at a throwaway copy, the way `SCHEDULER_DB` does for the database — **any test that can write config must set it**, or it edits the operator's own.
- **Ingestion worker:** runs in the same process (or a child process), uses `ffmpeg`/`ffprobe` (installed via Homebrew on the Mac) against local/mounted media folders to extract duration/metadata. Media root paths should be configurable per `ShowType`, not hardcoded.

Folder layout: `./data/` (sqlite persistence), `./media/` or a configurable external path (read-only media scanning), `./public/` (static frontend assets).

## Core data model (SQLite)

`ChannelType` (incl. `api_ip`/`api_port` per OTAV instance) → `BlockTemplate` (weekly recurring slot) → `ScheduledBlock` (a template instantiated for one date, status `draft`/`approved`/`exported`) → `ScheduleItem` (ordered `Resource` references within a block). `Resource` rows carry `file_path`, `duration`, `subject`/`chapter` (for series ordering), `is_filler`, `audience_rating`. Display naming lives in `src/services/labels.js`: TV/lessons are named `Show · S01E02`, a movie franchise part `Saga · Part N` (its `chapter` holds the part), and a standalone film keeps its own title (`chapter` 0 — it is not part N of anything). Never surface the raw `chapter` to an operator. `PlayHistory` tracks what has aired per channel, driving both sequential-series progression and movie cooldown math.

## Scheduling logic rules (must be preserved in implementation)

- **Lessons/Series:** next resource is `chapter = last_played_chapter + 1` per subject, from `PlayHistory`.
- **Movie franchises (sagas):** movies arrive as a flat folder of standalone files, so folder-based subject detection files them all under one subject with no ordering. `src/services/movieSaga.js` recovers the franchise from the filenames instead, and does so CORPUS-LEVEL: a saga exists only when two or more titles in the same folder agree on a base name, because a bare trailing number is ambiguous ("Angry_Birds_2" is a sequel, "Big_Hero_6" is not). Ingestion applies it per movies-root scan (`applySagaGrouping`); `scripts/cleanup/08-movie-sagas.js` retrofits an existing catalogue. A saga becomes its own subject (registered serial, so it plays in part order) with `chapter` = part; a standalone film keeps the folder subject and `chapter` 0. A base already used by another show type is qualified as `<base> (Movies)` — the catalogue has "Curious George" as both a TV series and a film franchise, and merging them would collide chapters.
- **Movies:** random selection with cooldown = `total available movies / 2` days.
- **Movie blocks:** a `BlockTemplate` with `is_movie_block = 1` builds its main content with `pickMovieRun()` instead of the per-series cycle, capped at `movie_limit` features (NULL = `config.movies.maxPerBlock`, default 2; `max_per_show` does not apply). Two passes:
  1. **ONE franchise at a time, in ORDER.** `activeFranchise()` finds the saga this channel is part way through — the one whose due part (`nextChapter`) is neither its first nor past its last — and that saga owns every serial slot until it ends, even across blocks and weeks. No other franchise may start while it runs; standalone films (chapter 0) still accompany it freely. With nothing mid-run, the template's first serial series starts, and from then on it is the active one. How many parts it takes in a SINGLE block is unchanged: a double bill only when it is the block's sole source, otherwise one part per block so an unordered folder still gets its slot — a saga is meant to continue in the next movie block, not to be interrupted by a different saga.
  1b. **Order first, but not at any price.** If leading with the saga's next part leaves more dead air than the filler-run cap allows, and the films alone close the slot better, the saga waits for the next movie block. It is a DELAY, not a skip: the cursor doesn't move, so the same part is due next time.
  2. **Remaining slots fill by best fit**, searching for the run whose quarter-hour-aligned span leaves the smallest hole — this is what keeps a long slot from becoming one feature plus hours of filler. Scope: the assigned non-serial series, or — when the template names NO series at all — every movie on the channel. `franchiseFilter()` then holds the pool to what the one-saga rule allows: every standalone, plus the active saga at its due part, or (when nothing is mid-run) a franchise's OPENING part, which is how the next saga gets started. `chooseMovies()` enforces the same rule inside a run — two ordered parts may share a block only if they are the same franchise, ascending.
  Both passes drop titles still cooling down or already scheduled within ±6 days of the target date (no repeats inside a week).
  **Content types must not mix, and the guard is at the RESOURCE level, not the subject.** A movie block draws only `ShowType.code = 'movies'`: `moviePool()` joins ShowType on BOTH branches (it used to only on the whole-library one), `seriesParts()`/`candidates()` take an optional show-type scope, and `moviesOnly()` drops any assigned series registered as something else (logged, since it is why a block can come back short). This is what production hit: 971 lesson files per channel carried `show_type_id = Movies` after a bad root clone, so a movie block aired two films and then lessons. The subject label says what folder a clip came from; only the show type says what it IS.
- **TV episodes:** weekday 18:00 slots act as movie fillers (cooldown applies); Sunday slots explicitly pick the latest-added episode.
- **Filler fitting:** stack `is_filler = true` resources before/between/after main content until the block reaches as close to exact duration as possible. `makeFillerPacker(channelId).pack()` fills a gap in two passes: a BULK pass that draws distinct clips in global LRU rotation while the gap is wider than a small reserve (so a wide gap airs many different clips rather than one clip on repeat), then an EXACT unbounded-knapsack pass on the remainder, which may repeat and is what lands the gap on the second. Diversity is best-effort and the fit is the guarantee: for the closing fill (`{ overrun: true }`) the bulk pass hands clips back one at a time until the exact pass can land inside tolerance, degrading in the worst case to the exact-only search — a coarse pool asked for 1800s can otherwise strand 13s where 600+600+600 is exact. Exact is the target; the block may end up to `filler.maxUnderrunSeconds` (default 5s) short, and when the filler pool is too coarse to land inside that window the fill goes up to `filler.maxOverrunSeconds` (default 5s) PAST the block end instead of leaving a bigger hole. Tolerance is one shared helper — `fitTolerance()` / `fitsTolerance(diff)` in `src/services/scheduling.js`, mirrored client-side in `renderValidation()`. Any manual edit that violates this tolerance must block approval in the UI until fixed.
- **Approval and push gate:** `validateBlock()` lives in `src/services/blockValidation.js` (it used to be private to `src/routes/blocks.js`) because three callers need the same verdict: the review API, `POST /approve` + `approve-week`, and the OTAV push. A block passes only when all three rules hold — duration inside tolerance, filler run inside the cap, no mixed types — and `blockProblem(v)` turns a failure into the one line the operator reads. `POST /api/otav/push` re-validates the whole range with `unfitBlocksInRange()` BEFORE starting the job and answers 409 with the offending blocks: a block can stop passing after it was approved (an edit, a changed cap, a re-scan re-typing a clip), and half a week on air is worse than none.
- **No clock alignment inside a block.** Main content plays back to back from the block start; the clock promise that matters is when the BLOCK starts, and that comes from the slot. Main items used to begin on the next :00/:15/:30/:45 mark with fillers padding the way there, and it was the biggest single source of filler on the real catalogue: it quantised the whole schedule to 15 minutes, so an 8.5-minute episode in a 30-minute slot cost 6.5 minutes of filler and then pushed its successor past the block end — one programme and 21 minutes of filler where two fit with four to spare. Removing it took the real week from 28.0 h of filler to 5.1 h. **Fillers are spread between the programmes** (`spreadFillers()`, applied at the end of `buildAlignedBlock`): the fit is identical either way, but the whole fill in one lump at the block end is dead air and breaches the filler-run cap on its own. The first main item stays first.
- **A series fills a block, it doesn't contribute one clip to it.** `iteratorForSeries()` returns the whole series in order for every rule — `cooldownOrder()` (outside its cooldown window first, then the rest, each rotated by day-of-month) for movies/documentaries, latest-added-first on Sunday TV — and the round-robin keeps cycling until the slot is full. It used to hand back a single clip (`singleIterator`), which is why a 3-hour block with three series aired three episodes and papered over the rest, and why `max_per_show` could only ever reduce that count. **A clip longer than the whole slot is skipped and logged**: it used to stall its series silently and leave the block 100% filler every week.
- **Closing pick:** when the cycle stops with more dead air than the filler-run cap allows, one more pass looks across the UNORDERED series for the longest clip that fits the hole. Ordered series are excluded on purpose — choosing a later part for its length is what a serial must never do. A hole no clip can fill (three 50-minute documentaries in a 3-hour block) is left for the operator, red.
- **Filler run cap:** a block may hold plenty of filler; what reads as dead air is a long UNBROKEN stretch of it, so the cap is on the longest consecutive run (`filler.maxConsecutiveSeconds`, default 1200 = 20 min), not on the block's filler total. `maxFillerRunSeconds()` / `fillerRunLimit()` in `scheduling.js` are the shared truth, mirrored by `fillerRunSeconds()` in `app.js`. **The engine does not try to satisfy this by itself** — deliberately: a block over the cap goes red and the operator adds or removes content. The week grid gets the number as one grouped gaps-and-islands query (position = `ROW_NUMBER()` over `play_order`, never `play_order` itself, so a deleted item can't fake a break), alongside the existing `SUM` — still no per-block `validateBlock()` there.

## Media normalisation ("Air Spec" tab)

`src/services/transcode.js` + `src/routes/transcode.js` + the `Air Spec` tab bring the whole
catalogue to one house format so OTAV plays it with consistent timing and no audio drift.
Target (config `transcode.target`), **editable from the tab** — the "Change the house spec"
panel writes it through `PUT /api/transcode/target`. Default: **1920x1080, 29.97fps
(`30000/1001`), h264 High yuv420p, PCM s16le 48kHz stereo, `.mov`** — PCM because a compressed
track's encoder delay is the usual source of lip-sync drift, and `-video_track_timescale 30000`
because a 600-timescale mov turns 29.97 into "29.97-ish" over a two-hour feature. Closed short
GOPs, no B-frames, so OTAV cues cleanly. `yadif=deint=1` only touches frames flagged interlaced.
Those defaults are the house recommendation, not a constraint — say so in the UI rather than
hard-coding them into copy (`REASON_LABELS.resolution` is "wrong resolution", not "not 1080p").

**The house spec is not the playout output spec, and deliberately differs.** The OTAV device
emits **1080i59.94 (1920x1080), YUV 8-bit, 32 audio channels, 16 sample size, 29.97fps**. Three
points where the files are intentionally not that, decided with the operator on 2026-09-02 —
don't "fix" them into agreement:

- **Files are 29.97 PROGRESSIVE against a 1080i59.94 output.** 59.94 fields = 29.97 frames, so
  the rate already matches and the card builds both fields at output. The catalogue is films,
  series, lessons and documentaries — 24p/29.97p at source — so progressive is the correct
  normalisation, and `yadif=deint=1` only touches what is actually flagged interlaced. An
  interlaced mode (`-flags +ilme+ildct -top 1`, no yadif) would only earn its keep for natively
  59.94i live material, which this network does not air.
- **Files are STEREO against a 32-channel output.** 32 is the DeckLink's channel count, not a
  property of a clip: OTAV maps the clip's pair to output channels 1-2 and the rest are silent.
  32ch PCM s16 48kHz is 10.3 GiB/hour — about 20 GiB of silence per two-hour feature, on a share
  holding 5200+ clips. `audioChannels` validates to 1 or 2 on purpose.
- **Files are 4:2:0 against a 4:2:2 output.** "YUV 8 bit" in Blackmagic/Softron device settings
  means 4:2:2; the card upsamples 4:2:0 losslessly in that direction. `yuv422p` is selectable if
  it is ever wanted — and `profileFor()` exists because it must be: h264 `high` is 4:2:0 ONLY
  and x265 has no `high` profile at all, so a pinned profile failed those encodes outright.

**Changing the spec re-judges the queue, it does not re-probe it.** `specReasons()` reads
nothing but the probe columns already on `TranscodeItem`, so `reclassifyQueue()` recomputes
every judgement exactly and instantly, with no ffprobe and no share access:
`ok`⇄`pending` flip as the new spec dictates; `converted`/`blocked` go back to `pending` with
`out_path` cleared (that work file meets the OLD spec); `skipped`/`missing` are left alone. The
one thing that cannot be re-derived is a clip already `replaced` — its row describes the file
that went to the archive, not the converted one now at that path — so those become **`stale`**,
which is out of the conversion queue until a re-probe reclassifies them. A save whose fields all
match the stored spec changes nothing at all (`changed: false`): re-saving the form must never
throw away a night of conversions. `preset` is deliberately not a spec field — it trades encode
time for size and re-queues nothing. A chosen `vcodec`/`acodec` is auto-added to
`acceptVideo`/`acceptAudio`, or every file already in that codec would be queued to be
re-encoded into it. Refused outright while a scan or conversion is running.

The routine is deliberately slow (full re-encode at broadcast quality over the SMB share,
`concurrency` 1 by default — hours per channel, days for the library), so it is built to be
started and left alone:

- **Two phases.** `POST /api/transcode/scan` judges the CATALOGUED clips against the spec and
  records what is off spec in `TranscodeItem` (one row per distinct physical path, statuses
  `ok|pending|running|converted|blocked|replaced|failed|skipped|missing|stale`). `POST
  /api/transcode/start` works that queue. An on-spec file is NEVER re-encoded, and a re-scan
  never pushes finished work back into the queue.
  **Scope:** the file list comes from `catalogFiles()` — `Resource`, grouped by distinct
  `file_path` — so this never lists a directory and never sees anything on the NAS that no
  channel has catalogued. Scoped further by `channel` / `showType` / `fillers`.
  **A re-scan is incremental.** Each clip is `stat`ed first: unchanged mtime AND size since the
  recorded `probed_at` keeps its verdict with no ffprobe at all (`src_mtime` is the column that
  makes this possible; store the size from `stat`, never ffprobe's self-reported one, so both
  sides of the comparison come from the same place). `force=1` re-probes the lot. The stat also
  separates "the file is not on disk any more" from "ffprobe could not read it", which used to
  be the same `missing` status and are different problems.
- **Copy → convert → verify → swap → archive, per clip.** Output goes to `transcode.workDir`,
  is probed and checked against the spec (and against the source duration,
  `verifyToleranceSeconds`) BEFORE anything moves. When the name changes (the usual case) the
  new file lands FIRST and the original is moved into `transcode.archiveDir` afterwards (full
  path mirrored, never deleted) — the two names coexist, so no path is ever left with nothing
  behind it. A same-name swap has no such luxury: the original moves out first and goes straight
  back if the new file fails to land.
  Replacement is per clip as it verifies (`autoReplace`), so stopping mid-run leaves a partly
  normalised catalogue, never a half-written file at a path OTAV might read.
- **The path can change, and OTAV is repaired.** Output is `.mov`, so a converted `.avi` gets a
  new `file_path`; every `Resource` row for that physical file is re-pointed and its duration
  updated. A clip that appears in a block already `exported` for today or later would leave that
  playlist on the playout Mac naming the old file, so `repointExportedDays()` in
  `src/services/otavClient.js` fixes it — `PUT /playlists/{n}/items/{m}` with `{ url }` is an
  editable property of a FILE clip, so the clip keeps its slot, name and watermark and OTAV
  re-reads the runtime from the new file. Three rules make that safe:
  1. **Plan, then commit, then fix.** Every affected day is resolved and checked FIRST; if any
     one of them can't be handled the clip stays `blocked` having moved nothing. The new file
     lands and the catalogue is re-pointed next, and only then are the playlists edited — the
     original is archived LAST, so until every playlist names the new file the old path still
     resolves and those days still air. A failure mid-fix rolls the patches, the catalogue and
     the file back.
  2. **A runtime that moved needs a re-push, not an edit.** OTAV recalculates a re-pointed
     clip's duration itself, but the block's fit in SQLite and the schedule event's duration
     were computed from the old runtime. Past `exportedDays.durationEpsilonSeconds` (0.5s,
     inside `verifyToleranceSeconds`) the day is pushed again instead (`pushDays`).
  3. **Never the live playlist.** The clip on air (`GET /playback/current_item`) and one
     starting within `exportedDays.imminentMinutes` are refused, and today's playlist is never
     rebuilt by re-push (OTAV won't clear a playing playlist, and it would interrupt air).
  `exportedDays.mode = 'block'` restores the old conservative behaviour: the clip waits for the
  operator to re-push those days, or to force the swap. It is switchable from the Air Spec tab
  (the **Repair days already pushed to OTAV** switch on the spec banner) — `PUT
  /api/transcode/exported-days` persists it through `updateConfig()` in `src/config.js`, which
  merges one key into `config/config.json` and renames a temp file over it, so a crash can't
  truncate the app's only settings file. It's a persisted switch rather than a per-run checkbox
  because it also governs the Replace button on a single row. `loadConfig()` re-reads per call,
  so no restart is needed. `TRANSCODE_EXPORTED_MODE` still wins and greys the switch out.
  Retrying a `blocked` clip retries the SWAP, not the encode — the verified work file is kept.
- **ffmpeg's progress stream lies.** Its first `-progress` block is all `N/A`, and `"N/A"` is
  TRUTHY — so `a || b` picks it and `Number("N/A")` is NaN, which survives every `??` (NaN is
  neither null nor undefined) and reaches SQLite, where **NaN is stored as NULL** and fails the
  NOT NULL on `TranscodeItem.progress`, inside a stdout handler, as an uncaughtException that
  kills the process mid-run. `parseProgressBlock()` is exported so that shape can be asserted
  directly, `setItem()` coerces any non-finite number to null, and the progress write is wrapped
  — a cosmetic update must never end a conversion. `test/fake-ffmpeg` emits the `N/A` block
  precisely because a fake that skips it cannot catch this, and didn't.
- **State survives everything.** The queue is in SQLite; `resetStaleRunning()` on startup
  re-queues clips that were mid-conversion. `GET /api/transcode/status` re-derives the whole
  panel; `GET /api/transcode/events` (SSE) carries ffmpeg progress + log lines.

## OnTheAir Video REST API (integration target)

Each OTAV instance is a separate server reachable at `http://<api_ip>:<api_port>/...` (per `ChannelType` row) — this project talks to 6 of them independently, not one shared instance.

- **Auth (optional, server-side toggle):** `PUT /authorize` with `{username, password}` → `{token, level}`. Token must be appended as a query param on every subsequent request; expires on OTAV relaunch (expect periodic 401s and re-auth). Access levels: 1 read-only, 2 modify playlists, 3 modify+control playback/DGO, 4 full admin.
- **Playlists:** `GET/POST/PUT /playlists/{n}`, `GET /playlists/{n}/items`, `GET /playlists/{n}/start_times`, `GET /playlists/{n}/out_of_time_range_items`, `GET /playlists/{n}/not_chronological_items`. Playlists can be addressed by index or `unique_id`.
- **One clip:** `GET/PUT/DELETE /playlists/{n}/items/{m}`, `POST /playlists/{n}/items/{m}` to insert at an index, and `GET /playback/current_item` for whatever is on air. Items are addressable by `unique_id`, which (unlike the index) doesn't shift. The PUT accepts "all properties of a clip" — including `url` for a FILE clip, which is what lets Air Spec repair an already-pushed day — and saves the playlist itself; **never send `duration`**, the doc is explicit that OTAV calculates it from the media it finds. Deleting the playing clip, or clearing the playing playlist, is refused.
- **Scheduler & control:** `GET /scheduler/start|stop|resynchronize`, `GET /scheduler/playlists`.
- **Playback control:** generic (`/playback/play|stop|pause`), per-playlist (`/playlists/{n}/play|stop|pause`), or per-clip (`/playlists/{n}/items/{m}/play|stop|pause`) — three addressing granularities for the same verbs.
- **Actions:** `GET /actions` lists device-control actions available on that server (ATEM switches, etc.) — version-sensitive (OTAV 4.2 changed Actions semantics); check `GET /info` for server version before assuming action shape.
- Standard REST verb semantics (GET/POST/PUT/DELETE) and HTTP status codes (200/201/202/400/401/403...) apply throughout; POST/PUT require `Content-Type: application/json`.
- The full doc (`OnTheAir Video REST API documentation.htm`) also covers Clips, Current Clip, DGO (graphics overlay), Media Browser, Transitions, Subtitles, Live/Virtual Sources, Thumbnails — consult it directly for payload shapes when implementing the Module C integrator, since it's large and endpoint bodies are easiest to read in-browser.

## Working in this repo before code exists

- If asked to scaffold the project, follow the portable/vanilla-frontend/SQLite stack above rather than substituting alternatives (no Docker, no frontend framework, no bundler), unless the user asks for a different stack.
- Keep dependencies minimal and vendored/installable in a way that survives being copied via USB and run offline on a Mac — avoid assumptions that require internet access or a package registry at runtime.
- Since there's no existing test/build/lint tooling yet, don't invent commands — add this section to CLAUDE.md once real tooling exists (e.g. `npm run dev`, `npm test`).
