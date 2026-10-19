// Clips that play badly on a node — OTAV or the analog UltraNEXUS — recorded
// against the FILE, so the catalogue and the scheduler can see them.
//
// How a clip gets here (each one a PlaybackFault row):
//   monitor  — the signal monitor opened a black / frozen / silent incident on
//              a feed linked to a channel. It asks that channel's node what was
//              playing WHEN THE PICTURE WENT, not when the alert goes out: the
//              public feed runs `feedDelaySeconds` behind the playout and the
//              resync that follows makes the node jump to another clip, so
//              "what is on air now" names the wrong clip more often than not.
//              OTAV's GET /playback/playing gives the clip and how far into it
//              the node is; when the fault is older than that clip, the walk
//              goes back through the playlist by duration. The analog device
//              gives the file and its position (/playback/live), and its as-run
//              log says what started before that.
//   asrun    — an event the analog device logged with a result that is not OK.
//   recovery — analog-automator found its player stopped or frozen and
//              restarted the clip (MPGPLAYX <file>).
// "No signal" (down) never counts: a dead public feed is the encoder or the
// CDN, not a clip. Nor does an incident that hits several channels at once
// (`correlatedFeeds` within `correlatedWindowSeconds`): that is upstream too,
// so the faults already recorded in that window are discarded.
//
// Decisions (PlaybackFlag, one per file and kind of node — the six OTAVs play
// the same master, the analog channel its own device copy):
//   suspect   — seen failing; shown with ⚠ in the catalogue, the block editor
//               and the week grid. The generator still uses it.
//   confirmed — the operator agrees: the generator stops choosing it (the
//               serial skips that episode) until it is cleared.
//   dismissed — not the file's fault. Sticky: later faults are still recorded
//               and counted, but the clip stays dismissed.
// Nothing here blocks approval or a push; a clip an operator places by hand
// airs, with its warning.

import { db } from '../db.js';
import { loadConfig } from '../config.js';
import { localDate, addDays } from '../dates.js';
import { log } from '../logger.js';
import { OtavClient } from './otavClient.js';
import { AnalogClient, analogChannel, isConfigured as analogConfigured } from './analogClient.js';

const L = log('faults');

export const STATUSES = ['suspect', 'confirmed', 'dismissed'];
const IMAGE_EXT = /\.(jpe?g|png|bmp|gif|tiff?)$/i;

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function faultsConfig(raw = loadConfig().faults) {
  const f = raw || {};
  let okRe;
  try { okRe = new RegExp(String(f.analogAsrunOk || '^(ok|played|complete|normal|success)'), 'i'); } catch { okRe = /^(ok|played|complete|normal|success)/i; }
  return {
    enabled: f.enabled !== false,
    // How far the public HLS feed runs behind the node's output (30–40s measured).
    feedDelaySeconds: clampNum(f.feedDelaySeconds, 0, 300, 35),
    // A fault this close to a clip change may belong to the clip next to it.
    boundarySeconds: clampNum(f.boundarySeconds, 0, 120, 10),
    correlatedFeeds: clampNum(f.correlatedFeeds, 2, 50, 3),
    correlatedWindowSeconds: clampNum(f.correlatedWindowSeconds, 5, 600, 60),
    analogAsrunOk: okRe,
    analogSyncMinutes: clampNum(f.analogSyncMinutes, 0, 1440, 10),
  };
}

export const playoutOf = (channel) => (channel?.playout === 'analog' ? 'analog' : 'otav');

// --- Which catalogue file is that? ----------------------------------------------

/** "/Volumes/…" from what OTAV reports (a path, or a file:// URL, maybe escaped). */
export function otavPathOf(v) {
  let p = String(v ?? '').replace(/\\\//g, '/').trim();
  if (!p) return null;
  if (/^file:\/\//i.test(p)) {
    p = p.replace(/^file:\/\/(localhost)?/i, '');
    try { p = decodeURIComponent(p); } catch { /* keep as is */ }
  }
  return p.normalize('NFC');
}

/** The catalogue's spelling of a path OTAV played, or the path itself. */
export function catalogPathFor(path) {
  if (!path) return null;
  const hit = db.prepare('SELECT file_path FROM Resource WHERE file_path = ? LIMIT 1').get(path)
    || db.prepare('SELECT file_path FROM Resource WHERE file_path = ? COLLATE NOCASE LIMIT 1').get(path)
    || db.prepare('SELECT file_path FROM Resource WHERE file_path = ? LIMIT 1').get(path.normalize('NFD'));
  return hit?.file_path ?? path;
}

/** The catalogue file behind a name on the analog device's disk. */
export function catalogPathForDevice(filename) {
  const name = String(filename ?? '').trim();
  if (!name) return null;
  const mapped = db.prepare('SELECT file_path FROM AnalogFile WHERE device_filename = ? COLLATE NOCASE').get(name);
  if (mapped) return mapped.file_path;
  const archived = db.prepare('SELECT share_path FROM AnalogDeviceFile WHERE filename = ? COLLATE NOCASE AND share_path IS NOT NULL').get(name);
  return archived?.share_path ?? `vol1:${name}`;
}

// --- Recording ------------------------------------------------------------------

/** Recount a flag from its faults; drop a suspect nobody decided on that has none left. */
export function refreshFlag(filePath, playout) {
  const agg = db.prepare(`
    SELECT COUNT(*) AS n, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at FROM PlaybackFault
    WHERE file_path = ? AND playout = ? AND discarded = 0`).get(filePath, playout);
  const last = agg.n ? db.prepare(`
    SELECT kind, channel_id FROM PlaybackFault WHERE file_path = ? AND playout = ? AND discarded = 0
    ORDER BY occurred_at DESC, id DESC LIMIT 1`).get(filePath, playout) : null;
  const flag = db.prepare('SELECT * FROM PlaybackFlag WHERE file_path = ? AND playout = ?').get(filePath, playout);
  if (!flag) {
    if (!agg.n) return null;
    db.prepare(`INSERT INTO PlaybackFlag (file_path, playout, status, faults, first_at, last_at, last_kind, last_channel_id)
      VALUES (?, ?, 'suspect', ?, ?, ?, ?, ?)`).run(filePath, playout, agg.n, agg.first_at, agg.last_at, last.kind, last.channel_id);
  } else if (!agg.n && flag.status === 'suspect' && !flag.decided_at) {
    db.prepare('DELETE FROM PlaybackFlag WHERE file_path = ? AND playout = ?').run(filePath, playout);
    return null;
  } else {
    db.prepare(`UPDATE PlaybackFlag SET faults = ?, first_at = ?, last_at = ?, last_kind = ?, last_channel_id = ?
      WHERE file_path = ? AND playout = ?`).run(agg.n, agg.first_at, agg.last_at, last?.kind ?? null,
      last?.channel_id ?? null, filePath, playout);
  }
  return db.prepare('SELECT * FROM PlaybackFlag WHERE file_path = ? AND playout = ?').get(filePath, playout);
}

/**
 * Record one fault and update the file's flag. Returns the fault row, or null
 * when `extKey` was already recorded (a log read twice).
 */
export function recordFault({
  filePath, playout, channelId = null, source, kind, occurredAt, offsetSeconds = null,
  confidence = 'exact', detail = null, clipName = null, signalEventId = null, extKey = null,
}) {
  if (!filePath || !playout || !source || !kind) throw new Error('recordFault: filePath, playout, source and kind are required');
  const at = occurredAt ? new Date(occurredAt).toISOString() : new Date().toISOString();
  const r = db.prepare(`
    INSERT OR IGNORE INTO PlaybackFault (file_path, playout, channel_id, source, kind, occurred_at, offset_seconds,
      confidence, detail, clip_name, signal_event_id, ext_key, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(filePath, playout, channelId, source, kind, at,
    offsetSeconds == null ? null : Math.round(offsetSeconds * 10) / 10, confidence, detail, clipName,
    signalEventId, extKey, new Date().toISOString());
  if (!r.changes) return null;
  refreshFlag(filePath, playout);
  return db.prepare('SELECT * FROM PlaybackFault WHERE id = ?').get(Number(r.lastInsertRowid));
}

/**
 * Several channels failing inside one window is upstream (network, encoder,
 * CDN), not a clip: discard the monitor faults of that window. Returns how
 * many were discarded.
 */
export function discardCorrelated(aroundIso, cfg = faultsConfig()) {
  const t = Date.parse(aroundIso);
  const from = new Date(t - cfg.correlatedWindowSeconds * 1000).toISOString();
  const to = new Date(t + cfg.correlatedWindowSeconds * 1000).toISOString();
  const rows = db.prepare(`SELECT * FROM PlaybackFault WHERE source = 'monitor' AND discarded = 0
    AND occurred_at BETWEEN ? AND ?`).all(from, to);
  const channels = new Set(rows.map((r) => r.channel_id));
  if (channels.size < cfg.correlatedFeeds) return 0;
  const mark = db.prepare(`UPDATE PlaybackFault SET discarded = 1,
    detail = TRIM(COALESCE(detail, '') || ' · discarded: ' || ? || ' channels failed at once') WHERE id = ?`);
  for (const r of rows) mark.run(String(channels.size), r.id);
  for (const k of new Set(rows.map((r) => `${r.playout}\n${r.file_path}`))) {
    const [playout, filePath] = k.split('\n');
    refreshFlag(filePath, playout);
  }
  L.info(`${rows.length} fault(s) discarded: ${channels.size} channels failed within ${cfg.correlatedWindowSeconds}s of ${aroundIso}`);
  return rows.length;
}

// --- What was playing at that moment? -------------------------------------------

const asItems = (v) => (Array.isArray(v) ? v : Array.isArray(v?.items) ? v.items : []);

/**
 * Walk back from the clip on air to the one playing at `faultAt` (ms). Pure:
 * `current` = { path, name, elapsed, index }, `items` = the playlist (each with
 * a duration and a url), `now` = when `current` was read. Returns
 * { path, name, offset, confidence } or null.
 */
export function walkBack(current, items, faultAt, now, { boundarySeconds = 10 } = {}) {
  if (!current?.path) return null;
  const near = (offset, dur) => offset < boundarySeconds || (dur != null && dur - offset < boundarySeconds);
  let start = now - (Number(current.elapsed) || 0) * 1000;
  if (faultAt >= start - 2000 || !Number.isFinite(Number(current.elapsed))) {
    const offset = Math.max(0, (faultAt - start) / 1000);
    return { path: current.path, name: current.name ?? null, offset,
      confidence: !Number.isFinite(Number(current.elapsed)) ? 'uncertain' : near(offset, null) ? 'boundary' : 'exact' };
  }
  const list = asItems(items);
  let idx = Number.isInteger(current.index) ? current.index
    : list.findIndex((it) => otavPathOf(it.url ?? it.path) === current.path);
  for (let steps = 0; idx > 0 && steps < 50; steps++) {
    idx--;
    const it = list[idx];
    const dur = Number(it?.duration);
    if (!Number.isFinite(dur) || dur <= 0) break;
    start -= dur * 1000;
    if (faultAt >= start) {
      const offset = (faultAt - start) / 1000;
      const path = otavPathOf(it.url ?? it.path ?? it.media_url);
      if (!path) break;
      return { path, name: it.name ?? it.display_name ?? null, offset, confidence: near(offset, dur) ? 'boundary' : 'exact' };
    }
  }
  return { path: current.path, name: current.name ?? null, offset: null, confidence: 'uncertain' };
}

/** OTAV: the clip that was playing at `faultAt`, or null. Throws on a node that won't answer. */
export async function otavClipAt(channel, faultAt, cfg = faultsConfig()) {
  const client = new OtavClient(channel);
  await client.authorize();
  const now = Date.now();
  const st = await client.request('GET', '/playback/playing').catch(() => null);
  let current = null;
  let playlist = null;
  if (st && (st.item_path || st.item_media_url)) {
    current = { path: otavPathOf(st.item_path || st.item_media_url), name: st.item_display_name || st.item_filename || null,
      elapsed: st.item_elapsed, index: Number.isInteger(st.item_index) ? st.item_index : null };
    playlist = st.playlist_unique_id ?? (Number.isInteger(st.playlist_index) ? st.playlist_index : null);
  } else {
    // Older builds: only the clip, with no position — say so.
    const item = await client.currentItem().catch(() => null);
    const path = otavPathOf(item?.url || item?.file_path || item?.path);
    if (!path) return null;
    current = { path, name: item.name || item.clip_name || null, elapsed: undefined, index: null };
  }
  let items = null;
  const startOfCurrent = now - (Number(current.elapsed) || 0) * 1000;
  if (playlist != null && faultAt < startOfCurrent - 2000) {
    items = await client.playlistItems(playlist).catch(() => null);
  }
  return walkBack(current, items, faultAt, now, cfg);
}

/** "HH:MM:SS[:FF]" / "h:mm:ss AM" → seconds into the day, or null. */
export function clockSeconds(v) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?::\d{2})?\s*([AP]M)?$/i.exec(String(v ?? '').trim());
  if (!m) return null;
  let h = Number(m[1]);
  if (m[4]) { h %= 12; if (/p/i.test(m[4])) h += 12; }
  return h * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
}

const localMidnight = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const tcSeconds = (v) => {
  const m = /^(\d+):(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/** Analog: the device file that was playing at `faultAt`, or null. */
export async function analogClipAt(channel, faultAt, cfg = faultsConfig()) {
  const client = new AnalogClient(channel);
  const now = Date.now();
  const live = await client.live();
  const p = live?.player || {};
  if (!p.filename) return null;
  const elapsed = Number.isFinite(Number(live.position_s)) ? Number(live.position_s) : tcSeconds(p.position);
  const start = now - (elapsed ?? 0) * 1000;
  if (elapsed == null || faultAt >= start - 2000) {
    const offset = elapsed == null ? null : Math.max(0, (faultAt - start) / 1000);
    return { filename: p.filename, offset,
      confidence: elapsed == null ? 'uncertain' : offset < cfg.boundarySeconds ? 'boundary' : 'exact' };
  }
  // Older than this clip: the as-run log says what started before it.
  const rows = await client.asrun(localDate(new Date(faultAt))).catch(() => []);
  const sec = (faultAt - localMidnight(faultAt)) / 1000;
  const before = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ ...r, t: clockSeconds(r.time) }))
    .filter((r) => r.t != null && r.t <= sec && r.filename)
    .sort((a, b) => b.t - a.t)[0];
  if (!before) return { filename: p.filename, offset: null, confidence: 'uncertain' };
  const offset = sec - before.t;
  return { filename: before.filename, offset, confidence: offset < cfg.boundarySeconds ? 'boundary' : 'exact' };
}

/**
 * The monitor's entry point: attribute one incident to the clip that was
 * playing when it began. `incident` = { kind, startedAt, eventId }. Returns
 * { fault, label } or { skipped } — never throws.
 */
export async function attributeIncident(channelId, incident, cfg = faultsConfig()) {
  try {
    if (!cfg.enabled) return { skipped: 'fault marking is off' };
    if (!['black', 'frozen', 'silent'].includes(incident.kind)) return { skipped: `${incident.kind} is not a clip fault` };
    const channel = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(channelId);
    if (!channel?.api_ip) return { skipped: 'the channel has no node address' };
    const playout = playoutOf(channel);
    const faultAt = Date.parse(incident.startedAt) - cfg.feedDelaySeconds * 1000;
    let filePath, clipName, offset, confidence;
    if (playout === 'analog') {
      if (!analogConfigured(channel)) return { skipped: 'the analog channel has no address or key' };
      const hit = await analogClipAt(channel, faultAt, cfg);
      if (!hit) return { skipped: 'the device is playing nothing' };
      if (IMAGE_EXT.test(hit.filename)) return { skipped: `the device was on its ${hit.filename} guide` };
      filePath = catalogPathForDevice(hit.filename);
      ({ offset, confidence } = hit);
      clipName = hit.filename;
    } else {
      const hit = await otavClipAt(channel, faultAt, cfg);
      if (!hit) return { skipped: 'OTAV is playing nothing' };
      filePath = catalogPathFor(hit.path);
      ({ offset, confidence } = hit);
      clipName = hit.name;
    }
    const fault = recordFault({
      filePath, playout, channelId, source: 'monitor', kind: incident.kind,
      occurredAt: new Date(faultAt).toISOString(), offsetSeconds: offset, confidence,
      clipName, signalEventId: incident.eventId ?? null,
      detail: `${channel.name}: ${incident.kind} on the public feed`,
    });
    if (fault) discardCorrelated(fault.occurred_at, cfg);
    const label = `${clipName || filePath.split('/').pop()}${offset != null ? ` (${fmtClock(offset)} into the clip)` : ''}`
      + (confidence !== 'exact' ? ` — ${confidence === 'boundary' ? 'near a clip change, may be the one next to it' : 'position unknown'}` : '');
    return { fault, label };
  } catch (err) {
    L.warn(`could not attribute ${incident.kind} on channel ${channelId}: ${err.message}`);
    return { skipped: `could not ask the node: ${err.message}` };
  }
}

const fmtClock = (s) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), x = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

// --- The analog device's own logs -------------------------------------------------

/** Pull failed as-run events and player recoveries from the analog API. */
export async function syncAnalogFaults({ days = null, cfg = faultsConfig() } = {}) {
  const channel = analogChannel();
  if (!cfg.enabled || !analogConfigured(channel)) return { ok: false, skipped: 'the analog channel is not configured' };
  const client = new AnalogClient(channel);
  const today = localDate();
  const out = { ok: true, asrun: 0, recoveries: 0, skippedDays: [], errors: [] };
  for (const day of days || [addDays(today, -1), today]) {
    let rows;
    try { rows = await client.asrun(day); } catch (err) { out.errors.push(`as-run ${day}: ${err.message}`); continue; }
    rows = Array.isArray(rows) ? rows : [];
    const bad = rows.filter((r) => r.filename && r.result && !cfg.analogAsrunOk.test(String(r.result).trim()) && !IMAGE_EXT.test(r.filename));
    // A vocabulary this code doesn't know would mark the whole day. Better none.
    if (rows.length >= 4 && bad.length > rows.length / 2) {
      out.skippedDays.push(day);
      L.warn(`as-run ${day}: ${bad.length}/${rows.length} rows read as failed ("${bad[0].result}") — not marking; set faults.analogAsrunOk if that result means OK`);
      continue;
    }
    for (const r of bad) {
      const t = clockSeconds(r.time);
      const hms = t == null ? '00:00:00'
        : [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((x) => String(x).padStart(2, '0')).join(':');
      const at = `${day}T${hms}`;
      const f = recordFault({
        filePath: catalogPathForDevice(r.filename), playout: 'analog', channelId: channel.id, source: 'asrun',
        kind: String(r.result).trim().toLowerCase().slice(0, 40), occurredAt: new Date(at).toISOString(),
        clipName: r.filename, detail: [r.title, r.report].filter(Boolean).join(' · ') || null,
        extKey: `asrun:${day}:${r.time}:${r.filename}`,
      });
      if (f) out.asrun++;
    }
  }
  try {
    const entries = await client.recoverLog(200);
    for (const e of Array.isArray(entries) ? entries : []) {
      if (!['stopped', 'frozen'].includes(e.verdict_before) || e.result === 'skipped') continue;
      const m = /MPGPLAYX\s+(\S+)/.exec(String(e.action || ''));
      if (!m || IMAGE_EXT.test(m[1])) continue;
      const f = recordFault({
        filePath: catalogPathForDevice(m[1]), playout: 'analog', channelId: channel.id, source: 'recovery',
        kind: e.verdict_before, occurredAt: e.at, clipName: m[1],
        detail: [`player ${e.verdict_before}`, e.result, e.detail_before].filter(Boolean).join(' · '),
        extKey: `recovery:${e.at}`,
      });
      if (f) out.recoveries++;
    }
  } catch (err) {
    out.errors.push(`recoveries: ${err.message}`);
  }
  if (out.asrun || out.recoveries) L.info(`analog: ${out.asrun} failed event(s), ${out.recoveries} recover(ies) recorded`);
  return out;
}

let syncTimer = null;
/** Every `analogSyncMinutes`, read the analog logs. Started from src/app.js. */
export function startFaultSync() {
  clearInterval(syncTimer);
  const minutes = faultsConfig().analogSyncMinutes;
  if (!minutes) return;
  syncTimer = setInterval(() => {
    syncAnalogFaults().catch((err) => L.warn(`analog fault sync: ${err.message}`));
  }, minutes * 60_000);
  syncTimer.unref?.();
}
export function stopFaultSync() { clearInterval(syncTimer); syncTimer = null; }

// --- Reading and deciding -----------------------------------------------------------

/** Every flag with what the catalogue knows about the file. */
export function listFlags({ status = null, playout = null, includeDismissed = true } = {}) {
  const clauses = [];
  const params = [];
  if (status) { clauses.push('pf.status = ?'); params.push(status); }
  else if (!includeDismissed) clauses.push("pf.status != 'dismissed'");
  if (playout) { clauses.push('pf.playout = ?'); params.push(playout); }
  const flags = db.prepare(`
    SELECT pf.*, c.name AS last_channel,
           (SELECT r.name FROM Resource r WHERE r.file_path = pf.file_path LIMIT 1) AS name,
           (SELECT COALESCE(ov.display_name, r.name) FROM Resource r LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
             WHERE r.file_path = pf.file_path LIMIT 1) AS display_name,
           (SELECT r.subject FROM Resource r WHERE r.file_path = pf.file_path LIMIT 1) AS subject,
           (SELECT COUNT(*) FROM Resource r WHERE r.file_path = pf.file_path) AS catalogued
    FROM PlaybackFlag pf LEFT JOIN ChannelType c ON c.id = pf.last_channel_id
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY CASE pf.status WHEN 'suspect' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, pf.last_at DESC
  `).all(...params);
  // Upcoming airings make the list actionable: these are the ones to fix first.
  const upcoming = db.prepare(`
    SELECT COUNT(*) AS n, MIN(sb.target_date) AS next_date FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN Resource r ON r.id = si.resource_id
    JOIN ChannelType c ON c.id = COALESCE(sb.channel_id, bt.channel_id)
    WHERE r.file_path = ? AND COALESCE(c.playout, 'otav') = ? AND sb.target_date >= ?`);
  const today = localDate();
  return flags.map((f) => ({ ...f, upcoming: upcoming.get(f.file_path, f.playout, today) }));
}

/** The faults behind one file, newest first. */
export function faultsFor(filePath, playout = null, limit = 100) {
  return db.prepare(`
    SELECT f.*, c.name AS channel FROM PlaybackFault f LEFT JOIN ChannelType c ON c.id = f.channel_id
    WHERE f.file_path = ? ${playout ? 'AND f.playout = ?' : ''} ORDER BY f.occurred_at DESC, f.id DESC LIMIT ?
  `).all(...[filePath, ...(playout ? [playout] : []), limit]);
}

/**
 * The operator's decision on files: status suspect|confirmed|dismissed, or
 * 'clear' to take the mark away (the fault history stays, and a new fault
 * starts a new suspect). Creates the flag for a manual mark.
 */
export function setFlags(filePaths, playout, status, note = undefined) {
  if (!['otav', 'analog'].includes(playout)) throw new Error('playout must be otav or analog');
  if (status !== 'clear' && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')} or clear`);
  const now = new Date().toISOString();
  let n = 0;
  for (const p of new Set(filePaths.filter(Boolean))) {
    if (status === 'clear') {
      n += db.prepare('DELETE FROM PlaybackFlag WHERE file_path = ? AND playout = ?').run(p, playout).changes;
      // History stays, but no longer counts toward a new flag.
      db.prepare('UPDATE PlaybackFault SET discarded = 1 WHERE file_path = ? AND playout = ? AND discarded = 0').run(p, playout);
      continue;
    }
    refreshFlag(p, playout);
    const has = db.prepare('SELECT 1 FROM PlaybackFlag WHERE file_path = ? AND playout = ?').get(p, playout);
    if (has) {
      n += db.prepare(`UPDATE PlaybackFlag SET status = ?, decided_at = ?, note = COALESCE(?, note)
        WHERE file_path = ? AND playout = ?`).run(status, now, note ?? null, p, playout).changes;
    } else {
      n += db.prepare(`INSERT INTO PlaybackFlag (file_path, playout, status, faults, decided_at, note)
        VALUES (?, ?, ?, 0, ?, ?)`).run(p, playout, status, now, note ?? 'marked by hand').changes;
    }
  }
  return n;
}

/** file_path → flag, for the flags of one kind of node (dismissed left out). */
export function flagsByPath(playout) {
  const m = new Map();
  for (const f of db.prepare("SELECT file_path, status, faults, last_at, last_kind FROM PlaybackFlag WHERE playout = ? AND status != 'dismissed'").all(playout)) {
    m.set(f.file_path, f);
  }
  return m;
}

/** Marks follow a file whose path changed (Air Spec, catalogue repair, rollback). */
export function moveFlags(from, to, { reencoded = false } = {}) {
  if (!from || !to || from === to) return;
  db.prepare('UPDATE PlaybackFault SET file_path = ? WHERE file_path = ?').run(to, from);
  for (const f of db.prepare('SELECT * FROM PlaybackFlag WHERE file_path = ?').all(from)) {
    const clash = db.prepare('SELECT 1 FROM PlaybackFlag WHERE file_path = ? AND playout = ?').get(to, f.playout);
    if (clash) db.prepare('DELETE FROM PlaybackFlag WHERE file_path = ? AND playout = ?').run(from, f.playout);
    else db.prepare('UPDATE PlaybackFlag SET file_path = ? WHERE file_path = ? AND playout = ?').run(to, from, f.playout);
    // A re-encode may well have fixed it: what the operator confirmed was the
    // OLD file, so it is a suspect again until it is seen to play.
    if (reencoded) {
      db.prepare(`UPDATE PlaybackFlag SET status = 'suspect', decided_at = NULL,
        note = 'converted by Air Spec on ' || ? || ' — check that it now plays' WHERE file_path = ? AND playout = ? AND status = 'confirmed'`)
        .run(localDate(), to, f.playout);
    }
    refreshFlag(to, f.playout);
  }
}
