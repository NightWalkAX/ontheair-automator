#!/usr/bin/env bash
#
# First-time setup for OnTheAir Automator.
# Idempotent: safe to re-run. Checks prerequisites, installs dependencies,
# creates config/config.json from the template, initialises the database, and
# (optionally) loads demo data.
#
# Usage:
#   ./setup.sh          # set up
#   ./setup.sh --seed   # set up and load demo data
#
set -u
cd "$(dirname "$0")"

# --- pretty output ----------------------------------------------------------
if [ -t 1 ]; then
  G="\033[32m"; Y="\033[33m"; R="\033[31m"; B="\033[1m"; N="\033[0m"
else
  G=""; Y=""; R=""; B=""; N=""
fi
ok()   { printf "${G}✓${N} %s\n" "$1"; }
warn() { printf "${Y}!${N} %s\n" "$1"; }
err()  { printf "${R}✗${N} %s\n" "$1"; }
step() { printf "\n${B}%s${N}\n" "$1"; }

SEED=0
[ "${1:-}" = "--seed" ] && SEED=1

printf "${B}OnTheAir Automator — first-time setup${N}\n"

# --- 1. Node.js >= 22.5 -----------------------------------------------------
step "1. Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node >= 22.5 (e.g. 'brew install node') and re-run."
  exit 1
fi
NODE_VER=$(node -v | sed 's/^v//')          # e.g. 24.18.0
NODE_MAJOR=${NODE_VER%%.*}
NODE_REST=${NODE_VER#*.}
NODE_MINOR=${NODE_REST%%.*}
if [ "$NODE_MAJOR" -gt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -ge 5 ]; }; then
  ok "Node.js v$NODE_VER (>= 22.5, built-in node:sqlite available)"
else
  err "Node.js v$NODE_VER is too old. This app needs >= 22.5 for node:sqlite."
  exit 1
fi

# --- 2. ffmpeg / ffprobe (needed only for ingestion) ------------------------
step "2. Checking ffmpeg/ffprobe (media ingestion)"
if command -v ffprobe >/dev/null 2>&1; then
  ok "ffprobe found at $(command -v ffprobe)"
else
  warn "ffprobe not found. Media scanning won't work until you install it:"
  warn "    brew install ffmpeg"
  warn "(The app still runs; ingestion is the only feature that needs it.)"
fi

# --- 3. Dependencies --------------------------------------------------------
step "3. Installing dependencies"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok "node_modules already present — skipping npm install"
else
  if npm install; then
    ok "Dependencies installed"
  else
    err "npm install failed (need internet the first time)."
    exit 1
  fi
fi

# --- 4. Config --------------------------------------------------------------
step "4. Config file"
if [ -f config/config.json ]; then
  ok "config/config.json already exists — leaving it untouched"
else
  cp config/config.example.json config/config.json
  ok "Created config/config.json from template"
  warn "Edit config/config.json: set smb.host/share/username/password and channel details."
fi

# --- 5. Database ------------------------------------------------------------
step "5. Initialising database"
mkdir -p data
if node -e "import('./src/db.js').then(m => { m.initSchema(); console.log('schema ready'); });" >/dev/null 2>&1; then
  ok "SQLite schema ready at data/scheduler.sqlite"
else
  err "Failed to initialise the database."
  exit 1
fi

# --- 6. Optional demo data --------------------------------------------------
if [ "$SEED" -eq 1 ]; then
  step "6. Loading demo data"
  if node scripts/seed.js >/dev/null 2>&1; then
    ok "Demo channel, resources and a generated week loaded"
  else
    warn "Seeding failed (non-fatal)."
  fi
fi

# --- Done -------------------------------------------------------------------
PORT=$(node -e "console.log(require('./config/config.json').server?.port || 8090)" 2>/dev/null || echo 8090)
step "Setup complete"
echo "Start the app with:"
printf "    ${B}node server.js${N}   (or: npm start)\n"
echo "Then open:"
printf "    ${B}http://localhost:%s${N}\n" "$PORT"
[ "$SEED" -eq 0 ] && echo "Tip: re-run with ./setup.sh --seed to load demo data."
