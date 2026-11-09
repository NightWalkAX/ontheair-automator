#!/bin/zsh
# Keeps the automator running: starts `node server.js` and restarts it 3 s after
# it exits, for whatever reason (crash, `kill` from deploy.sh, port briefly busy).
# Runs inside Terminal on purpose: Terminal already holds the macOS permissions
# for ~/Documents and the NAS; a bare launchd job would not (TCC).
# Opened at login by ~/Library/LaunchAgents/com.glc.ontheair-automator.plist.
# Stop for good: touch ~/Documents/ontheair-automator/data/STOP, then kill node.
cd "$(dirname "$0")/../.." || exit 1
APP_DIR=$PWD
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
NODE=$(command -v node || echo "$HOME/.nvm/versions/node/v24.18.0/bin/node")
export PATH="$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:$PATH"
echo $$ > "$APP_DIR/data/run-automator.pid"
printf '\e]0;OnTheAir Automator (auto-restart)\a'
rm -f "$APP_DIR/data/STOP"
while true; do
  echo "$(date '+%F %T') starting automator ($NODE)"
  "$NODE" server.js
  code=$?
  echo "$(date '+%F %T') automator exited with $code"
  [ -f "$APP_DIR/data/STOP" ] && { echo "STOP file present — not restarting"; break; }
  sleep 3
done
