#!/usr/bin/env bash
#
# Package the whole app (including node_modules) into a single .tgz for USB
# transport. A tarball is the reliable way to move this to another Mac:
#   - it copies to exFAT/FAT32 USB drives as ONE file (no per-file failures)
#   - it preserves the node_modules/.bin symlinks that exFAT can't store
#     (e.g. mime, uuid), which is exactly what a raw folder copy trips over
#
# On the target Mac:
#   tar xzf ontheair-automator.tgz
#   cd ontheair-automator && ./setup.sh   # skips npm install, deps are bundled
#   node server.js
#
set -eu
cd "$(dirname "$0")"

OUT="dist/ontheair-automator.tgz"
mkdir -p dist

# Exclude things that shouldn't travel: the live DB (regenerated on setup),
# the output dir itself, VCS metadata, and OS cruft.
tar czf "$OUT" \
  --exclude='./dist' \
  --exclude='./.git' \
  --exclude='./data/scheduler.sqlite*' \
  --exclude='.DS_Store' \
  -C . .

SIZE=$(du -h "$OUT" | cut -f1)
echo "Created $OUT ($SIZE)"
echo "Copy that single file to the USB drive, then on the target Mac:"
echo "    tar xzf ontheair-automator.tgz && cd ontheair-automator && ./setup.sh"
