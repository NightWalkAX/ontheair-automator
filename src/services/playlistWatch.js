// Playlist watchdog (operator, 2026-11-18): "know where today's videos are, and
// if one moves, fix OTAV".
//
// Every `intervalMinutes` it reads, from each of the six OTAV instances, the day
// playlist of today (and of the next `daysAhead` days already exported), and
// stats the file behind every clip. That snapshot is what GET /api/nas/watch
// shows: per channel, every clip with its start time, path and whether the file
// is there.
//
// A clip whose file is gone is looked for, in this order:
//   1. the FileMove journal (nasLayout's organize, or this watchdog earlier):
//      old → new, followed hop by hop;
//   2. the share, by NAME (basename without extension, letters and digits) under
//      the content root and the folders above the media roots — a file moved by
//      hand in Finder. A candidate must agree on LENGTH with what OTAV / the
//      catalogue recorded (±max(3s, 1%)); exactly one physical file = a match,
//      several = ambiguous (reported, not guessed).
// A match is re-pointed in OTAV (PUT url, read back) and in the catalogue (every
// channel's row, Air Spec / analog / seasonal bookkeeping), and journalled.
//
// Never: the clip on air (it is playing from an open file; patching it can cut
// air); a future day while an operator push runs (the push owns that playlist);
// anything when the share itself looks unmounted (every file "missing" at once
// is the share, not a hundred moves). Unresolved clips in TODAY's playlist are
// e-mailed once each.

import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { db, withTx } from '../db.js';
import { loadConfig, updateConfig, localizePath, delocalizePath } from '../config.js';
import { localDate, addDays } from '../dates.js';
import { log } from '../logger.js';
import { readDayPlaylist, samePath, isPushRunning, onAirUrls } from './otavClient.js';
import { movePath, nameKey } from './catalogRepair.js';
import { collectVideoFiles, probeDuration } from './ingestion.js';
import { layoutConfig } from './nasLayout.js';
import { sendMail } from './mailer.js';

const l = log('watch');

const DEFAULTS = {
  enabled: true,
  intervalMinutes: 5,
  daysAhead: 1,
  fix: true,
  alert: true,
  indexMinutes: 30,
};

export function watchConfig() {
  const c = loadConfig().playlistWatch || {};
  const out = { ...DEFAULTS, ...c };
  out.enabled = out.enabled !== false;
  out.fix = out.fix !== false;
  out.alert = out.alert !== false;
  out.intervalMinutes = Math.max(1, Number(out.intervalMinutes) || DEFAULTS.intervalMinutes);
  out.daysAhead = Math.max(0, Math.min(6, Number(out.daysAhead ?? DEFAULTS.daysAhead)));
  out.indexMinutes = Math.max(5, Number(out.indexMinutes) || DEFAULTS.indexMinutes);
  return out;
}

export function setWatchConfig(patch = {}) {
  const allowed = ['enabled', 'intervalMinutes', 'daysAhead', 'fix', 'alert', 'indexMinutes'];
  updateConfig((cfg) => {
    cfg.playlistWatch ||= {};
    for (const k of allowed) if (k in patch) cfg.playlistWatch[k] = patch[k];
  });
  reschedule();
  return watchConfig();
}

const state = {
  timer: null,
  running: false,
  lastTickAt: null,
  lastError: null,
  shareDown: false,
  days: new Map(),       // `${channelId}|${date}` -> snapshot
  fixes: [],             // last 200 fixes
  alerted: new Set(),    // `${channelId}|${date}|${url}`
  index: null,           // { at, byName: Map<key, [path]> }
};

const durationAgrees = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(3, a * 0.01);

async function exists(path) {
  try { return (await stat(localizePath(path))).isFile(); } catch { return false; }
}

async function statMany(paths, concurrency = 8) {
  const out = new Map();
  let i = 0;
  const worker = async () => { while (i < paths.length) { const p = paths[i++]; out.set(p, await exists(p)); } };
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return out;
}

/** The share is mounted at all? (A dead mount makes every file "missing".) */
async function shareUp() {
  const root = layoutConfig().root;
  for (const p of [dirname(root), root]) {
    try { if ((await stat(localizePath(p))).isDirectory()) return true; } catch { /* next */ }
  }
  return false;
}

/** Follow the move journal from `path`; the newest live move per hop, max 6 hops. */
function followJournal(path) {
  const q = db.prepare(`SELECT new_path FROM FileMove WHERE old_path = ? AND undone_at IS NULL
    ORDER BY id DESC LIMIT 1`);
  let cur = path;
  for (let i = 0; i < 6; i++) {
    const r = q.get(cur);
    if (!r) break;
    cur = r.new_path;
  }
  return cur === path ? null : cur;
}

function searchFolders() {
  const roots = db.prepare('SELECT DISTINCT path FROM MediaRoot').all().map((r) => String(r.path).replace(/\/+$/, ''));
  const all = [layoutConfig().root, ...roots.map((p) => dirname(p))];
  const uniq = [...new Set(all)].sort();
  return uniq.filter((p, i) => !uniq.some((q, j) => j !== i && p.startsWith(`${q}/`)));
}

async function nameIndex(cfg, force = false) {
  if (!force && state.index && Date.now() - state.index.at < cfg.indexMinutes * 60_000) return state.index;
  const byName = new Map();
  for (const folder of searchFolders()) {
    let files = [];
    try { files = await collectVideoFiles(localizePath(folder)); } catch (err) { l.warn(`index: ${folder}: ${err.message}`); }
    for (const f of files) {
      const p = delocalizePath(f);
      if (/\/_transcode\//.test(p) || /\/@Recycle\//.test(p)) continue;
      const k = nameKey(p);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push(p);
    }
  }
  state.index = { at: Date.now(), byName };
  return state.index;
}

/** Recorded length for a path: the catalogue first, else OTAV's item duration. */
function knownDuration(path, item) {
  const r = db.prepare('SELECT MAX(duration) AS d FROM Resource WHERE file_path = ?').get(path);
  if (r?.d > 0) return Number(r.d);
  const d = Number(item?.media_file_duration || item?.duration);
  return d > 0 ? d : null;
}

/** Where did `path` go? { to, via } | { ambiguous: [...] } | null. */
export async function resolveMoved(path, item, cfg = watchConfig()) {
  const j = followJournal(path);
  if (j && await exists(j)) return { to: j, via: 'journal' };
  const want = knownDuration(path, item);
  for (const fresh of [false, true]) {
    const idx = await nameIndex(cfg, fresh);
    const cands = (idx.byName.get(nameKey(path)) || []).filter((p) => p !== path);
    const live = [];
    for (const c of cands) if (await exists(c)) live.push(c);
    if (!live.length) continue;  // index may be stale: rebuild once
    const agreeing = [];
    for (const c of live) {
      let d = db.prepare('SELECT MAX(duration) AS d FROM Resource WHERE file_path = ?').get(c)?.d;
      if (!(d > 0)) { try { d = await probeDuration(localizePath(c)); } catch { d = null; } }
      if (want ? durationAgrees(want, d) : true) agreeing.push(c);
    }
    // One physical file seen under several names (case, 8.3 aliases) is one candidate.
    const ids = new Map();
    for (const c of agreeing) {
      let key = c.toLowerCase();
      try { const s = await stat(localizePath(c)); if (s.ino) key = `${s.dev}:${s.ino}`; } catch { /* keep path */ }
      if (!ids.has(key)) ids.set(key, c);
    }
    if (ids.size === 1) return { to: [...ids.values()][0], via: 'name+length' };
    if (ids.size > 1) {
      // The share keeps old duplicate trees (Transmission/Shows ≈ Broadcast/Shows):
      // one copy inside the on-air root is the one that was organised.
      const root = `${layoutConfig().root}/`;
      const inRoot = [...ids.values()].filter((p) => p.startsWith(root));
      if (inRoot.length === 1) return { to: inRoot[0], via: 'name+length (on-air folder)' };
      return { ambiguous: [...ids.values()] };
    }
    return null;
  }
  return null;
}

function remember(fix) {
  state.fixes.unshift(fix);
  if (state.fixes.length > 200) state.fixes.length = 200;
}

/** Move the catalogue (every channel) to the found path and journal it. */
function followInCatalogue(from, to) {
  withTx(() => {
    if (db.prepare('SELECT 1 FROM Resource WHERE file_path = ? LIMIT 1').get(from)) {
      movePath(from, to, null, { sameFile: true });
    }
    const already = db.prepare('SELECT 1 FROM FileMove WHERE old_path = ? AND new_path = ? AND undone_at IS NULL').get(from, to);
    if (!already) {
      db.prepare("INSERT INTO FileMove (old_path, new_path, moved_at, source) VALUES (?, ?, ?, 'watchdog')")
        .run(from, to, new Date().toISOString());
    }
  });
}

async function checkDay(channel, date, today, cfg, mail) {
  const key = `${channel.id}|${date}`;
  const snap = { channelId: channel.id, channel: channel.name, date, checkedAt: new Date().toISOString(),
    playlist: null, items: [], missing: 0, fixed: [], unresolved: [], error: null };
  let pl;
  try {
    pl = await readDayPlaylist(channel, date);
  } catch (err) {
    snap.error = String(err.message || err);
    state.days.set(key, snap);
    return snap;
  }
  snap.playlist = pl.name;
  const files = pl.items.filter((it) => typeof it.url === 'string' && it.url.startsWith('/'));
  const there = await statMany([...new Set(files.map((it) => it.url))]);
  snap.items = pl.items.map((it) => ({
    uid: it.unique_id, name: it.name, url: it.url ?? null,
    start: Number.isFinite(Number(it.relative_start_time)) ? Math.round(Number(it.relative_start_time)) : null,
    duration: Number(it.duration) || null,
    exists: typeof it.url === 'string' && it.url.startsWith('/') ? there.get(it.url) : null,
  }));
  const gone = files.filter((it) => !there.get(it.url));
  snap.missing = gone.length;
  if (!gone.length) { state.days.set(key, snap); return snap; }

  // Every clip missing at once is the share, not moves.
  if (gone.length > 5 && gone.length > files.length * 0.5) {
    snap.error = `${gone.length} of ${files.length} files unreachable — share problem, nothing changed`;
    state.days.set(key, snap);
    return snap;
  }

  // Asked of every instance: the port on a channel row is not always the one airing it.
  const airing = await onAirUrls();
  const canFix = cfg.fix && (date === today || !isPushRunning());
  for (const it of gone) {
    const found = await resolveMoved(it.url, it, cfg);
    if (!found?.to) {
      snap.unresolved.push({ uid: it.unique_id, name: it.name, url: it.url,
        ambiguous: found?.ambiguous || null });
      continue;
    }
    if (!canFix) { snap.unresolved.push({ uid: it.unique_id, name: it.name, url: it.url, wouldMoveTo: found.to, why: cfg.fix ? 'push running' : 'fix off' }); continue; }
    if (airing.some((u) => samePath(u, it.url))) {
      snap.unresolved.push({ uid: it.unique_id, name: it.name, url: it.url, wouldMoveTo: found.to, why: 'on air' });
      continue;
    }
    try {
      await pl.client.setClipUrl(pl.ref, it.unique_id, found.to);
      const back = await pl.client.getClip(pl.ref, it.unique_id).catch(() => null);
      const backUrl = back?.url;
      if (back && backUrl && !samePath(backUrl, found.to)) throw new Error(`OTAV kept "${backUrl}"`);
      followInCatalogue(it.url, found.to);
      const fix = { at: new Date().toISOString(), channel: channel.name, date, name: it.name, from: it.url, to: found.to, via: found.via };
      snap.fixed.push(fix);
      remember(fix);
      const row = snap.items.find((x) => x.uid === it.unique_id);
      if (row) { row.url = found.to; row.exists = true; }
      l.info(`${channel.name} ${date}: re-pointed "${it.name}" ${it.url} → ${found.to} (${found.via})`);
    } catch (err) {
      snap.unresolved.push({ uid: it.unique_id, name: it.name, url: it.url, wouldMoveTo: found.to, why: String(err.message || err) });
    }
  }
  snap.missing = snap.unresolved.length;
  state.days.set(key, snap);

  if (cfg.alert && date === today) {
    const fresh = snap.unresolved.filter((u) => !state.alerted.has(`${key}|${u.url}`));
    if (fresh.length) {
      for (const u of fresh) state.alerted.add(`${key}|${u.url}`);
      const text = `${channel.name} — today's playlist names ${fresh.length} file(s) that are not on the share `
        + 'and the watchdog could not find them elsewhere. OTAV will skip them (the day ends early).\n\n'
        + fresh.map((u) => `• ${u.name}\n  ${u.url}${u.ambiguous ? `\n  several candidates: ${u.ambiguous.join(' | ')}` : ''}${u.why ? `\n  ${u.why}` : ''}`).join('\n');
      l.warn(`${channel.name} ${date}: ${fresh.length} missing clip(s) unresolved`);
      try { await mail({ subject: `[Automator] ${channel.name}: ${fresh.length} clip(s) missing from today's playlist`, text }); } catch (err) {
        l.warn(`missing-clip alert not e-mailed: ${err.message}`);
      }
    }
  }
  return snap;
}

/** One pass over every OTAV channel. Exported for tests and POST /api/nas/watch/tick. */
export async function tick({ today = localDate(), mail = sendMail, channelIds = null } = {}) {
  const cfg = watchConfig();
  if (state.running) return { action: 'busy' };
  state.running = true;
  state.lastTickAt = new Date().toISOString();
  state.lastError = null;
  try {
    if (!(await shareUp())) {
      state.shareDown = true;
      l.warn('share not reachable — playlist watch skipped this pass');
      return { action: 'share-down' };
    }
    state.shareDown = false;
    const channels = db.prepare(`SELECT * FROM ChannelType WHERE COALESCE(playout, 'otav') = 'otav'
      AND api_ip IS NOT NULL AND api_ip != '' AND COALESCE(is_active, 1) = 1 ORDER BY id`).all()
      .filter((c) => !channelIds || channelIds.includes(c.id));
    const out = [];
    for (const ch of channels) {
      for (let i = 0; i <= cfg.daysAhead; i++) {
        const date = addDays(today, i);
        const exported = db.prepare(`SELECT 1 FROM ScheduledBlock WHERE channel_id = ? AND target_date = ?
          AND status = 'exported' LIMIT 1`).get(ch.id, date);
        if (!exported && i > 0) continue;
        const s = await checkDay(ch, date, today, cfg, mail);
        out.push({ channel: ch.name, date, items: s.items.length, missing: s.missing, fixed: s.fixed.length, error: s.error });
      }
    }
    // Forget days that are over.
    for (const k of state.days.keys()) if (k.split('|')[1] < today) state.days.delete(k);
    for (const k of state.alerted) if (k.split('|')[1] < today) state.alerted.delete(k);
    return { action: 'checked', days: out };
  } catch (err) {
    state.lastError = String(err.message || err);
    l.warn(`tick failed: ${state.lastError}`);
    return { action: 'error', error: state.lastError };
  } finally {
    state.running = false;
  }
}

/** Summary, or one channel-day with every clip when `channelId` + `date` are given. */
export function watchState({ channelId = null, date = null } = {}) {
  const days = [...state.days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.channelId - b.channelId);
  if (channelId && date) return state.days.get(`${channelId}|${date}`) || null;
  return {
    config: watchConfig(),
    running: !!state.timer,
    lastTickAt: state.lastTickAt,
    lastError: state.lastError,
    shareDown: state.shareDown,
    days: days.map((d) => ({ channelId: d.channelId, channel: d.channel, date: d.date, playlist: d.playlist,
      items: d.items.length, missing: d.missing, fixed: d.fixed.length, unresolved: d.unresolved, error: d.error, checkedAt: d.checkedAt })),
    recentFixes: state.fixes.slice(0, 50),
  };
}

function reschedule() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const cfg = watchConfig();
  if (!cfg.enabled) return;
  state.timer = setInterval(() => { tick().catch(() => {}); }, cfg.intervalMinutes * 60_000);
  state.timer.unref?.();
}

/** From app.js after listen; first pass two minutes later. */
export function startPlaylistWatch() {
  reschedule();
  if (!watchConfig().enabled) { l.info('playlist watchdog off (playlistWatch.enabled = false)'); return; }
  const first = setTimeout(() => { tick().catch(() => {}); }, 120_000);
  first.unref?.();
  l.info(`playlist watchdog on (every ${watchConfig().intervalMinutes} min, today + ${watchConfig().daysAhead} day(s))`);
}

export function stopPlaylistWatch() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/** Tests only. */
export function _resetWatchState() {
  state.days.clear(); state.fixes.length = 0; state.alerted.clear(); state.index = null; state.running = false;
}
