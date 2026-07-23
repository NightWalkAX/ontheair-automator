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
- **Movies:** random selection with cooldown = `total available movies / 2` days.
- **TV episodes:** weekday 18:00 slots act as movie fillers (cooldown applies); Sunday slots explicitly pick the latest-added episode.
- **Filler fitting:** stack `is_filler = true` resources before/between/after main content until the block reaches as close to exact duration as possible — 0s overrun is the target, -5s is the max allowed underrun. Any manual edit that violates this tolerance must block approval in the UI until fixed.

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
