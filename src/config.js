// Loads config/config.json. Re-read from disk each call so edits to the file
// take effect without restarting (the file is small and reads are infrequent).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config', 'config.json');

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

// --- Path mapping ------------------------------------------------------------
// The database and OTAV always speak the deployment Mac's paths
// ("/Volumes/Public/..."). When this app runs on a machine that mounts the same
// share somewhere else (e.g. a Linux box via gvfs), config.pathMap translates
// those canonical paths to local ones for filesystem access ONLY — everything
// stored or sent to OTAV stays canonical:
//
//   "pathMap": { "/Volumes/Public": "/run/user/1000/gvfs/smb-share:server=...,share=public" }

const stripSlash = (p) => String(p).replace(/\/+$/, '');

/** Pure prefix rewrite: longest matching `from` prefix wins. */
export function applyPathMap(path, map) {
  if (typeof path !== 'string' || !map) return path;
  const entries = Object.entries(map)
    .map(([from, to]) => [stripSlash(from), stripSlash(to)])
    .sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of entries) {
    if (path === from || path.startsWith(from + '/')) return to + path.slice(from.length);
  }
  return path;
}

/** Canonical (Mac) path -> path usable on THIS machine's filesystem. */
export function localizePath(path) {
  return applyPathMap(path, loadConfig().pathMap);
}

/** Local path -> canonical (Mac) path, for storing scan results. */
export function delocalizePath(path) {
  const map = loadConfig().pathMap || {};
  const inverse = Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
  return applyPathMap(path, inverse);
}

export { CONFIG_PATH };
