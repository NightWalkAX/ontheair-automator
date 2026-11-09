#!/bin/zsh
# Update the automator on this Mac and restart it (≈5 s without the automator;
# OTAV and the analog device keep airing on their own).
#   scripts/mac/deploy.sh            pull, install deps if the lockfile moved, restart
#   scripts/mac/deploy.sh --no-pull  just restart
# Refuses while a push to air or an analog routine is running.
set -e
cd "$(dirname "$0")/../.."
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
API=http://127.0.0.1:8090
busy=$(curl -s -m10 "$API/api/analog/routine/status" | grep -o '"running":true' || true)
[ -n "$busy" ] && { echo "analog routine running — not deploying"; exit 2; }
if [ "${1:-}" != "--no-pull" ]; then
  before=$(git rev-parse HEAD); lock_before=$(git hash-object package-lock.json)
  git pull --ff-only
  [ "$(git hash-object package-lock.json)" != "$lock_before" ] && npm ci --omit=dev
  echo "code: $before → $(git rev-parse HEAD)"
fi
node --check server.js
pid=$(lsof -ti tcp:8090 -sTCP:LISTEN || true)
loop=$(cat data/run-automator.pid 2>/dev/null || true)
if [ -z "$loop" ] || ! kill -0 "$loop" 2>/dev/null; then
  echo "auto-restart loop is not running: open scripts/mac/run-automator.command first"; exit 3
fi
[ -n "$pid" ] && kill "$pid"
for i in {1..30}; do
  sleep 1
  curl -s -m2 "$API/api/health" | grep -q '"ok":true' && { echo "automator up again after ${i}s"; exit 0; }
done
echo "automator did not come back within 30 s — check the Terminal window"; exit 1
