# OnTheAir Automator

Internal, on-premise TV broadcast scheduler for a government network. It scans
media on an SMB share, auto-generates weekly draft schedules from block
templates using rule-based content selection, fits filler clips to a strict
duration tolerance, lets an admin review/approve drafts in a browser, and pushes
approved schedules to 6 Softron **OnTheAir Video (OTAV)** instances over REST.

Portable by design: the whole folder (code + `data/scheduler.sqlite`) can be
copied to a Mac via USB and run with `node server.js`. No Docker, no build step,
no frontend framework.

## Copying to another Mac (USB)

Do **not** drag the raw folder onto an exFAT/FAT32 USB drive — those filesystems
can't store symlinks, so the copy fails on `node_modules/.bin/mime` and
`node_modules/.bin/uuid` (harmless CLI shims the app never uses at runtime, but
the failed copy leaves `node_modules` incomplete).

Instead, package it as a single archive:

```bash
./pack.sh               # or: npm run pack  → dist/ontheair-automator.tgz (~800 KB)
```

Copy that one `.tgz` to the USB drive. On the target Mac:

```bash
tar xzf ontheair-automator.tgz
cd ontheair-automator && ./setup.sh    # deps are bundled; skips npm install
node server.js
```

The tarball preserves symlinks and copies as one file, so it's immune to the
exFAT quirk. (Alternative: copy the folder *without* `node_modules` and run
`./setup.sh` on the target — but that needs internet for `npm install`.)

## Requirements (on the deployment Mac)

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` — no native module to
  rebuild after copying between Intel/Apple-Silicon Macs).
- **ffmpeg/ffprobe** via Homebrew: `brew install ffmpeg` (used for ingestion).
- Network access to the SMB media server and to each OTAV instance.

## Setup

Run the first-time setup script — it checks prerequisites (Node ≥ 22.5,
ffprobe), installs dependencies, creates `config/config.json` from the template,
and initialises the database. Idempotent, safe to re-run.

```bash
./setup.sh              # or: npm run setup
./setup.sh --seed       # also load demo data for a first look
node server.js          # start (or: npm start) → http://localhost:8090
```

Then edit `config/config.json` (SMB host/credentials, channels) and open
http://localhost:8090 in a browser.

### Seed demo data

`npm run seed` (or `node scripts/seed.js`) inserts a demo channel, show types,
synthetic resources (no ffprobe needed), and block templates, then generates a
week and prints the filler-fit report — a quick way to see the schedule UI
populated.

## Testing

```bash
npm test          # integration suite + line/branch coverage
npm run test:plain # same suite, no coverage
```

The suite (`test/integration.test.mjs`) boots the real Express app against a
**fully faked environment** — a fake `ffprobe` (`test/fake-ffprobe`, durations
encoded in filenames), a fake OTAV REST server (`test/fake-otav.mjs`), and a
temp media tree standing in for the SMB mount — then drives the whole pipeline
over HTTP: ingest → tag → generate → review/edit → approve (incl. the
out-of-tolerance 409) → push → verify OTAV received the clips.

Current coverage ≈ **86% lines / 61% branches / 76% functions**. Core logic is
well covered (`scheduling.js` 100%, `otavClient.js` 94%, `db.js` 99%). The gaps
are mostly platform- or branch-specific: `smbMount.js` (macOS-only `mount_smbfs`
can't run in CI), the cron scheduling timer, the OTAV 401-re-auth retry, and
some PUT/DELETE CRUD branches.

> Note: `npm test` deletes and recreates `data/scheduler.sqlite`. Re-seed with
> `npm run seed` afterwards if you want demo data back.

## Configuration (`config/config.json`)

| Key | Meaning |
| --- | --- |
| `server.port` | HTTP port (default 8090). |
| `smb.{host,share,username,password,mountPoint}` | SMB media server + where to mount it. |
| `smb.autoMountOnStartup` | Reserved; mounting is triggered from the UI/`POST /api/media/mount`. |
| `ffprobePath` | Path to `ffprobe` (default `ffprobe` on `PATH`). |
| `cron.weeklyDraft` | Cron expr for auto draft generation (default Thu 06:00). |
| `filler.maxUnderrunSeconds` / `maxOverrunSeconds` | Fit tolerance (default −5s / 0s). |

> **Security note:** SMB and OTAV credentials are stored in plaintext in
> `config/config.json` / the SQLite file. This is an accepted tradeoff for a
> self-contained, offline, USB-copyable app. Do not commit the config or leave
> the drive unattended.

## How it works

- **Ingestion** (`src/services/ingestion.js`): each channel owns distinct folders
  on the share. Admins browse the mounted tree in the UI and assign a folder as a
  `MediaRoot` (Channel + ShowType). `ffprobe` scans each root and upserts
  channel-tagged `Resource` rows.
- **Auto-generation** (`src/services/scheduling.js`): rolls active
  `BlockTemplate`s forward into 7 days of draft `ScheduledBlock`s, picks main
  content per `content_type` (sequential lessons, cooldown movies, TV episodes
  with a Sunday latest-episode rule), then a subset-sum knapsack packs fillers to
  hit the block length (0s overrun ceiling, 5s underrun floor).
- **Review UI** (`public/`): 7-day timeline; click a block to reorder/swap/add
  items with live duration validation. Approval is blocked — client- and
  server-side — while a block is out of tolerance.
- **OTAV push** (`src/services/otavClient.js`): per-channel REST client. Clears
  the target playlist, then `POST /playlists/{ref}/items` with
  `{clip_type:0, url, name}` for each item, and resynchronizes the scheduler.
  Optional token auth with automatic re-auth on 401. All machines mount the share
  at the same path, so `Resource.file_path` is used verbatim as the clip URL.

## Layout

```
server.js              entrypoint
config/config.json     runtime config (edit this)
data/scheduler.sqlite  DB (created on first run)
public/                static admin UI
src/db.js              schema + migrations
src/config.js          config loader
src/services/          smbMount, ingestion, scheduling, playHistory, otavClient
src/routes/            channels, showtypes, resources, media, blocks, otav
src/cron/weeklyDraft.js weekly generation cron
scripts/seed.js        demo/seed + smoke test
```

## Deviations from SEED.md (flagged)

These are code-level refinements over the original blueprint; SEED.md is the
seed intent, not the final schema.

- `BlockTemplate.content_type` added — SEED had no field telling the engine which
  selection rule to apply.
- `BlockTemplate.target_subject` (TEXT) added — SEED has `target_subject_id`
  (INTEGER) but no Subject table; resources are scoped by their TEXT `subject`.
- `Resource.channel_id` + a `MediaRoot(channel_id, show_type_id, path)` table
  replace SEED's flat `ShowType.paths`, because each channel owns its own folders.
- `ChannelType.playlist_ref`, `api_username`, `api_password` added for OTAV
  targeting/auth.
