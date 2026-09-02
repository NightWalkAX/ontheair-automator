// Loads config/config.json. Re-read from disk each call so edits to the file
// take effect without restarting (the file is small and reads are infrequent) —
// which also means a setting written by updateConfig() applies immediately.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// SCHEDULER_CONFIG lets tests (and alternate deployments) point at a throwaway
// config, the same way SCHEDULER_DB does for the database — updateConfig()
// WRITES this file, so a test must never be aimed at the operator's own.
const CONFIG_PATH = process.env.SCHEDULER_CONFIG
  || join(__dirname, '..', 'config', 'config.json');

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

/**
 * Change part of config.json from the app, keeping everything else intact.
 *
 * `mutate(config)` edits the parsed document in place. The result is written to
 * a sibling temp file and renamed over the original: this config is the app's
 * only settings file and it travels on a USB drive, so a crash (or a pulled
 * drive) halfway through a write must never leave a truncated document that
 * stops the whole thing from booting. Serialized at 2 spaces, matching the file
 * an operator reads and edits by hand.
 *
 * Returns the config as written.
 */
export function updateConfig(mutate) {
  const config = loadConfig();
  mutate(config);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  JSON.parse(text);          // never rename a document that won't parse back
  const tmp = `${CONFIG_PATH}.tmp`;
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, CONFIG_PATH);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
  return config;
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
