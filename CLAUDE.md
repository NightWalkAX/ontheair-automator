# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository is **pre-implementation**. It currently contains only planning material — no application code, `package.json`, Dockerfiles, or source tree exist yet:

- `SEED.md` — the master project blueprint (system overview, tech stack, DB schema, module specs, Docker volume layout). Treat this as the authoritative product/architecture spec until code exists to supersede it.
- `OnTheAir Video REST API documentation.htm` — vendor REST API reference for the video playout systems this tool must integrate with. Open it in a browser or strip tags to read; see "OnTheAir Video REST API" below for the parts relevant to this project.

When asked to start implementing, scaffold the project according to the stack and structure described in `SEED.md` rather than inventing a different architecture. If `SEED.md` and the actual code ever diverge, prefer the code and flag the discrepancy — SEED.md is the seed intent, not necessarily up to date.

## What this system does

An internal, on-premise TV broadcast scheduler for a government network. It:

1. Scans mounted media directories (`ffmpeg`/`ffprobe`) to catalog video assets into SQLite.
2. Auto-generates weekly draft schedules from fixed block templates using rule-based content selection (sequential series/lesson playback, cooldown-based random movie selection, latest-episode-first for Sunday TV blocks).
3. Fits filler clips into each block via a "knapsack" pass targeting 0s overrun / max 5s underrun.
4. Presents drafts in an admin review UI for manual reordering/swapping before approval.
5. Pushes approved schedules to 6 separate **Softron OnTheAir Video (OTAV)** instances over their REST APIs.

## Intended technology stack (per SEED.md)

Portable, non-containerized, **macOS-native** app — the whole project folder (code + SQLite data) must be copyable via USB drive and runnable on any Mac with minimal setup. No Docker, no build step required to run.

- **Orchestration:** None — start the backend process directly (e.g. `node server.js`).
- **Frontend:** Plain HTML, CSS, and vanilla JavaScript — no framework, no bundler. Served as static files by the backend.
- **Backend:** Node.js (Express/Fastify) or Python (FastAPI) — serves the static frontend, handles API routes, SQLite access, the cron scheduling engine, and HTTP calls out to OTAV.
- **Database:** SQLite, single file (`./data/scheduler.sqlite`) inside the project folder so it travels with the app on USB. Enable `PRAGMA foreign_keys = ON`.
- **Ingestion worker:** runs in the same process (or a child process), uses `ffmpeg`/`ffprobe` (installed via Homebrew on the Mac) against local/mounted media folders to extract duration/metadata. Media root paths should be configurable per `ShowType`, not hardcoded.

Folder layout: `./data/` (sqlite persistence), `./media/` or a configurable external path (read-only media scanning), `./public/` (static frontend assets).

## Core data model (SQLite)

`ChannelType` (incl. `api_ip`/`api_port` per OTAV instance) → `BlockTemplate` (weekly recurring slot) → `ScheduledBlock` (a template instantiated for one date, status `draft`/`approved`/`exported`) → `ScheduleItem` (ordered `Resource` references within a block). `Resource` rows carry `file_path`, `duration`, `subject`/`chapter` (for series ordering), `is_filler`, `audience_rating`. `PlayHistory` tracks what has aired per channel, driving both sequential-series progression and movie cooldown math.

## Scheduling logic rules (must be preserved in implementation)

- **Lessons/Series:** next resource is `chapter = last_played_chapter + 1` per subject, from `PlayHistory`.
- **Movie franchises (sagas):** movies arrive as a flat folder of standalone files, so folder-based subject detection files them all under one subject with no ordering. `src/services/movieSaga.js` recovers the franchise from the filenames instead, and does so CORPUS-LEVEL: a saga exists only when two or more titles in the same folder agree on a base name, because a bare trailing number is ambiguous ("Angry_Birds_2" is a sequel, "Big_Hero_6" is not). Ingestion applies it per movies-root scan (`applySagaGrouping`); `scripts/cleanup/08-movie-sagas.js` retrofits an existing catalogue. A saga becomes its own subject (registered serial, so it plays in part order) with `chapter` = part; a standalone film keeps the folder subject and `chapter` 0. A base already used by another show type is qualified as `<base> (Movies)` — the catalogue has "Curious George" as both a TV series and a film franchise, and merging them would collide chapters.
- **Movies:** random selection with cooldown = `total available movies / 2` days.
- **Movie blocks:** a `BlockTemplate` with `is_movie_block = 1` builds its main content with `pickMovieRun()` instead of the per-series cycle, capped at `movie_limit` features (NULL = `config.movies.maxPerBlock`, default 2; `max_per_show` does not apply). Two passes:
  1. **Assigned franchises play in ORDER.** A serial series contributes its next part from the series cursor, exactly as in a normal block — never a part chosen for fit. A franchise may double-bill (parts 1+2) only when it is the block's sole source; with an unordered folder also assigned it takes one slot per block so the other series still gets one.
  2. **Remaining slots fill by best fit**, searching for the run whose quarter-hour-aligned span leaves the smallest hole — this is what keeps a long slot from becoming one feature plus hours of filler. Scope: the assigned non-serial series, or — when the template names NO series at all — every movie on the channel, with each franchise held to the part it is due (`onlyNextParts`). "No series assigned" is therefore the right setup for a general movie night: it draws the whole library without airing a franchise out of order. **Naming all franchises on a movie block is counterproductive** (they'd play in order ahead of fit: 23% filler vs 4% on the real catalogue).
  Both passes drop titles still cooling down or already scheduled within ±6 days of the target date (no repeats inside a week). Two titles of the same franchise may share a block only in ascending part order; standalone films (chapter 0) carry no order and pair freely.
- **TV episodes:** weekday 18:00 slots act as movie fillers (cooldown applies); Sunday slots explicitly pick the latest-added episode.
- **Filler fitting:** stack `is_filler = true` resources before/between/after main content until the block reaches as close to exact duration as possible. `makeFillerPacker(channelId).pack()` fills a gap in two passes: a BULK pass that draws distinct clips in global LRU rotation while the gap is wider than a small reserve (so a wide gap airs many different clips rather than one clip on repeat), then an EXACT unbounded-knapsack pass on the remainder, which may repeat and is what lands the gap on the second. Diversity is best-effort and the fit is the guarantee: for the closing fill (`{ overrun: true }`) the bulk pass hands clips back one at a time until the exact pass can land inside tolerance, degrading in the worst case to the exact-only search — a coarse pool asked for 1800s can otherwise strand 13s where 600+600+600 is exact. Exact is the target; the block may end up to `filler.maxUnderrunSeconds` (default 5s) short, and when the filler pool is too coarse to land inside that window the fill goes up to `filler.maxOverrunSeconds` (default 5s) PAST the block end instead of leaving a bigger hole. Tolerance is one shared helper — `fitTolerance()` / `fitsTolerance(diff)` in `src/services/scheduling.js`, mirrored client-side in `renderValidation()`. Any manual edit that violates this tolerance must block approval in the UI until fixed.

## OnTheAir Video REST API (integration target)

Each OTAV instance is a separate server reachable at `http://<api_ip>:<api_port>/...` (per `ChannelType` row) — this project talks to 6 of them independently, not one shared instance.

- **Auth (optional, server-side toggle):** `PUT /authorize` with `{username, password}` → `{token, level}`. Token must be appended as a query param on every subsequent request; expires on OTAV relaunch (expect periodic 401s and re-auth). Access levels: 1 read-only, 2 modify playlists, 3 modify+control playback/DGO, 4 full admin.
- **Playlists:** `GET/POST/PUT /playlists/{n}`, `GET /playlists/{n}/items`, `GET /playlists/{n}/start_times`, `GET /playlists/{n}/out_of_time_range_items`, `GET /playlists/{n}/not_chronological_items`. Playlists can be addressed by index or `unique_id`.
- **Scheduler & control:** `GET /scheduler/start|stop|resynchronize`, `GET /scheduler/playlists`.
- **Playback control:** generic (`/playback/play|stop|pause`), per-playlist (`/playlists/{n}/play|stop|pause`), or per-clip (`/playlists/{n}/items/{m}/play|stop|pause`) — three addressing granularities for the same verbs.
- **Actions:** `GET /actions` lists device-control actions available on that server (ATEM switches, etc.) — version-sensitive (OTAV 4.2 changed Actions semantics); check `GET /info` for server version before assuming action shape.
- Standard REST verb semantics (GET/POST/PUT/DELETE) and HTTP status codes (200/201/202/400/401/403...) apply throughout; POST/PUT require `Content-Type: application/json`.
- The full doc (`OnTheAir Video REST API documentation.htm`) also covers Clips, Current Clip, DGO (graphics overlay), Media Browser, Transitions, Subtitles, Live/Virtual Sources, Thumbnails — consult it directly for payload shapes when implementing the Module C integrator, since it's large and endpoint bodies are easiest to read in-browser.

## Working in this repo before code exists

- If asked to scaffold the project, follow the portable/vanilla-frontend/SQLite stack above rather than substituting alternatives (no Docker, no frontend framework, no bundler), unless the user asks for a different stack.
- Keep dependencies minimal and vendored/installable in a way that survives being copied via USB and run offline on a Mac — avoid assumptions that require internet access or a package registry at runtime.
- Since there's no existing test/build/lint tooling yet, don't invent commands — add this section to CLAUDE.md once real tooling exists (e.g. `npm run dev`, `npm test`).
