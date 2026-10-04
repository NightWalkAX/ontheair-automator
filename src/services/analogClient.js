// The analog channel: a Leightronix UltraNEXUS-HD driven through the
// analog-automator REST API (github.com/NightWalkAX/analog-automator, running on
// the WinLGX PC). Everything the scheduler does for the OTAV channels applies —
// templates, blocks, fillers, approval, the week check — and only the push
// destination differs. Read docs/ANALOG_AUTOMATION_HANDOFF.md before changing
// how a day is built; the device model is not OTAV's:
//
// - The device schedule is a WEEKLY TEMPLATE (Sun..Sat), not one playlist per
//   date. Pushing date D replaces weekday(D), and that weekday repeats every
//   week until it is replaced again. So only today..today+6 can be pushed (a
//   later date would overwrite a weekday that airs sooner), and today only
//   with the operator's confirmation, exactly as OTAV.
// - Every block starts with a FIXED event at its (shifted) window start; the
//   rest of the block is CHAINED. A chained event that runs into the next fixed
//   one is trimmed by the device, so a block can never push its successor late.
//   The hole a block leaves before its window ends is filled with the "Program
//   Guide" resource at exactly that length — the device's own filler, which
//   takes any length — so nothing between blocks is black.
// - Chaining runs on the DEVICE's lengths (GETMPEGINFOX), which can differ
//   from ffprobe by frames; the automator's durations only choose content.
// - Files are on the device's own disk, not the share. A catalogue file is
//   known there by a normalised name (no spaces, ≤31 characters), remembered in
//   AnalogFile. A push refuses while any file is missing from the device; the
//   upload job (startUpload) sends them over HTTP first. The push itself never
//   uploads: Vol1 is nearly full, and a push must not turn into hours of copying.
// - Every change goes through the API's draft: reset from what is on air,
//   replace each day, publish ONCE. Publish backs the device up first, so the
//   Analog tab can roll back.

import { request as httpRequest } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { db } from '../db.js';
import { loadConfig, localizePath } from '../config.js';
import { addDays, localDate } from '../dates.js';
import { log } from '../logger.js';
import { NULL_PROGRESS } from './pushProgress.js';
import { channelDayBlocks, linkShifts } from './scheduling.js';
import { blockItems } from './otavClient.js';

const l = log('analog');

export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const VIDEO_EXT = ['.mp4', '.mpg', '.mpeg', '.m2t', '.ts', '.mov'];
const MAX_NAME = 31;          // the device's filename field is 32 bytes, NUL-terminated
const DEFAULT_PORT = 8750;

export function analogConfig() {
  const a = loadConfig().analog || {};
  return {
    daysAhead: Math.min(6, Math.max(0, Number.isInteger(a.daysAhead) ? a.daysAhead : 6)),
    folderId: Number.isInteger(Number(a.folderId)) && a.folderId !== null && a.folderId !== '' ? Number(a.folderId) : null,
    programGuideTitle: String(a.programGuideTitle || 'Program Guide'),
    requestTimeoutSeconds: Number(a.requestTimeoutSeconds) > 0 ? Number(a.requestTimeoutSeconds) : 30,
    publishTimeoutSeconds: Number(a.publishTimeoutSeconds) > 0 ? Number(a.publishTimeoutSeconds) : 300,
    // Vol1 housekeeping (analogVol1.js).
    archiveDir: String(a.archiveDir || '/Volumes/Public/Broadcast/Analog Archive'),
    minFreeGb: Number(a.minFreeGb) >= 0 && a.minFreeGb !== null && a.minFreeGb !== '' ? Number(a.minFreeGb) : 50,
    fillerMaxSeconds: Number(a.fillerMaxSeconds) > 0 ? Number(a.fillerMaxSeconds) : 660,
    fillerPrefixes: Array.isArray(a.fillerPrefixes) && a.fillerPrefixes.length ? a.fillerPrefixes.map(String)
      : ['PSA', 'PROMO', 'FILL', 'NDMA', 'Infobits', 'IsGuyTing', 'FortsMon', 'GMCS', 'CATS', 'StartingPoint', 'QOD', 'FunFacts'],
  };
}

// The device's FTP serves one transfer at a time (analog-automator holds a lock
// around every FTP call), so a multi-GB archive download would hold a push or an
// upload for half an hour. Whoever needs the device calls wantDevice(): the
// archive job aborts its current download (it resumes later with a Range) and
// waits until deviceWanted() is false again.
const deviceListeners = new Set();
let deviceClaims = 0;
export function onDeviceWanted(fn) { deviceListeners.add(fn); return () => deviceListeners.delete(fn); }
export function deviceWanted() { return deviceClaims > 0 || inFlight > 0 || !!job?.running; }
export async function claimDevice(fn) {
  deviceClaims++;
  for (const f of deviceListeners) { try { f(); } catch { /* a listener must not stop the claim */ } }
  try { return await fn(); } finally { deviceClaims--; }
}

/** The one analog ChannelType row (seeded by db.js), or null on a DB without it. */
export function analogChannel() {
  return db.prepare("SELECT * FROM ChannelType WHERE playout = 'analog'").get() ?? null;
}

export const isConfigured = (ch) => !!(ch && String(ch.api_ip || '').trim() && String(ch.api_key || '').trim());

export class AnalogError extends Error {
  constructor(message, { status = null, detail = null } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/** FastAPI's {"detail": …} is a string, an object, or a list of validation errors. */
function detailText(detail) {
  if (detail == null) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
  if (typeof detail === 'object') return detail.detail ? detailText(detail.detail) : JSON.stringify(detail);
  return String(detail);
}

export class AnalogClient {
  constructor(channel) {
    // Operators paste addresses in every shape (http://host:port/api/v1/…),
    // as with OTAV; keep host and port, drop the rest.
    let host = String(channel.api_ip || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
    let port = Number(channel.api_port) || null;
    const m = /^(.*):(\d+)$/.exec(host);
    if (m) { host = m[1]; port = port || Number(m[2]); }
    this.host = host;
    this.port = port || DEFAULT_PORT;
    this.base = `http://${host}:${this.port}/api/v1`;
    this.key = String(channel.api_key || '');
  }

  async request(method, path, { body, timeoutSeconds } = {}) {
    const ms = (timeoutSeconds ?? analogConfig().requestTimeoutSeconds) * 1000;
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { 'X-API-Key': this.key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ms),
      });
    } catch (err) {
      const why = err.name === 'TimeoutError' ? `no answer in ${ms / 1000}s` : (err.cause?.code || err.message);
      throw new AnalogError(`cannot reach the analog API at ${this.base}: ${why}. Check the analog channel's IP/port, `
        + 'and that this Mac is on 172.20.0.0/24 (the WinLGX PC firewall only allows the LAN).');
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const detail = data && typeof data === 'object' ? data.detail : data;
      const hint = { 401: ' — the API key is wrong', 403: ' — that function is disabled on the analog API',
        502: ' — the device control port failed', 507: ' — no space on the device disk' }[res.status] || '';
      throw new AnalogError(`analog API ${method} ${path} → ${res.status}: ${detailText(detail) || res.statusText}${hint}`,
        { status: res.status, detail });
    }
    return data;
  }

  health() { return this.request('GET', '/health'); }
  resources(source = 'draft') { return this.request('GET', `/library/resources?source=${source}&limit=6102`); }
  folders() { return this.request('GET', '/library/folders'); }
  createResource(filename, folderId) {
    return this.request('POST', '/library/resources', { body: { filename, folder_id: folderId } });
  }
  files() { return this.request('GET', '/storage/files'); }
  disk() { return this.request('GET', '/storage/disk'); }
  audit() { return this.request('GET', '/storage/audit'); }
  deleteFile(name, force = false) {
    return this.request('DELETE', `/storage/files/${encodeURIComponent(name)}${force ? '?force=true' : ''}`);
  }
  schedule(day, source = 'device') {
    return this.request('GET', `/schedule?source=${source}${day ? `&day=${day}` : ''}`);
  }
  resetDraft() { return this.request('POST', '/schedule/draft/reset'); }
  replaceDay(day, items, overflow = 'drop') {
    return this.request('PUT', `/schedule/draft/days/${day}`, { body: { items, overflow } });
  }
  diff() { return this.request('GET', '/schedule/draft/diff'); }
  draftStatus() { return this.request('GET', '/schedule/draft/status'); }
  publish({ confirmToday = false } = {}) {
    return this.request('POST', '/schedule/publish', {
      body: { confirm: true, confirm_today: !!confirmToday, override_external: false },
      timeoutSeconds: analogConfig().publishTimeoutSeconds,
    });
  }
  backups() { return this.request('GET', '/schedule/backups'); }
  rollback(name) {
    return this.request('POST', `/schedule/rollback/${encodeURIComponent(name)}`, {
      body: { confirm: true }, timeoutSeconds: analogConfig().publishTimeoutSeconds,
    });
  }
  playbackStatus() { return this.request('GET', '/playback/status'); }
  live() { return this.request('GET', '/playback/live'); }
  asrun(day) { return this.request('GET', `/playback/asrun${day ? `?day=${day}` : ''}`); }
  recover(force = false) { return this.request('POST', '/playback/recover', { body: { force: !!force } }); }
  recoverLog(limit = 50) { return this.request('GET', `/playback/recover/log?limit=${limit}`); }

  /**
   * Stream one device file into `out` (a writable stream), starting at byte
   * `offset` (GET /storage/files/<name>/content, Range: bytes=offset-). Resolves
   * with the bytes written. The API can't change its status once the body has
   * started, so a transfer cut short is caught here by counting against
   * Content-Length — the caller resumes from what landed.
   */
  download(name, out, { offset = 0, signal } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: this.host, port: this.port, method: 'GET',
        path: `/api/v1/storage/files/${encodeURIComponent(name)}/content`,
        headers: { 'X-API-Key': this.key, ...(offset ? { Range: `bytes=${offset}-` } : {}) },
        signal,
      }, (res) => {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => {
            let data = null;
            try { data = text ? JSON.parse(text) : null; } catch { data = text; }
            const hint = res.statusCode === 404 && /no route|Not Found/i.test(String(data?.detail ?? data))
              ? ' — the analog API is too old to download; deploy analog-automator with GET /storage/files/{name}/content' : '';
            reject(new AnalogError(`download of ${name} → ${res.statusCode}: ${detailText(data?.detail ?? data)}${hint}`,
              { status: res.statusCode }));
          });
          return;
        }
        if (offset && res.statusCode !== 206) { res.destroy(); return reject(new AnalogError(`download of ${name}: the API ignored the resume offset`)); }
        const expected = Number(res.headers['content-length']);
        let got = 0;
        res.on('data', (c) => { got += c.length; });
        res.on('error', (err) => reject(new AnalogError(`download of ${name} failed: ${err.code || err.message}`)));
        res.on('aborted', () => reject(new AnalogError(`download of ${name} cut short at ${got} bytes`)));
        res.pipe(out, { end: false });
        res.on('end', () => {
          if (Number.isFinite(expected) && got !== expected) {
            return reject(Object.assign(new AnalogError(`download of ${name} cut short at ${got} of ${expected} bytes`), { partial: got }));
          }
          resolve(got);
        });
      });
      req.on('error', (err) => reject(err.name === 'AbortError'
        ? Object.assign(new AnalogError('download interrupted'), { cancelled: true })
        : new AnalogError(`download of ${name} failed: ${err.code || err.message}`)));
      req.end();
    });
  }

  /**
   * Stream one local file to the device disk (PUT /storage/files/<name>).
   * node:http rather than fetch: the API needs Content-Length (it checks the
   * free space and the completeness of the upload against it), and a streamed
   * fetch body can't carry one. No timeout — 2 MB/s over this LAN makes a
   * feature several minutes; `signal` is how the job cancels.
   */
  upload(name, localPath, size, { signal } = {}) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: this.host, port: this.port, method: 'PUT',
        path: `/api/v1/storage/files/${encodeURIComponent(name)}`,
        headers: { 'X-API-Key': this.key, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
        signal,
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          let data = null;
          try { data = text ? JSON.parse(text) : null; } catch { data = text; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
          reject(new AnalogError(`upload of ${name} → ${res.statusCode}: ${detailText(data?.detail ?? data)}`,
            { status: res.statusCode, detail: data?.detail ?? data }));
        });
      });
      req.on('error', (err) => reject(err.name === 'AbortError'
        ? Object.assign(new AnalogError('upload cancelled'), { cancelled: true })
        : new AnalogError(`upload of ${name} failed: ${err.code || err.message}`)));
      const src = createReadStream(localPath);
      src.on('error', (err) => { req.destroy(); reject(new AnalogError(`cannot read ${localPath}: ${err.code || err.message}`)); });
      src.pipe(req);
    });
  }
}

// --- File names on the device ---------------------------------------------------

/** `filePath`'s name on the device: no spaces or accents, ≤31 characters, `_n` to disambiguate. */
export function deviceFileName(filePath, n = 0) {
  const ext = extname(filePath).toLowerCase();
  let stem = basename(filePath, extname(filePath)).normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._()-]+/g, '_').replace(/_+/g, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  if (!stem) stem = 'clip';
  const suffix = n ? `_${n}` : '';
  return stem.slice(0, MAX_NAME - ext.length - suffix.length).replace(/[_.-]+$/, '') + suffix + ext;
}

/** Same clip? Lengths within max(3s, 1%) — the device measures frames differently. */
const sameLength = (a, b) => Math.abs(a - b) <= Math.max(3, 0.01 * Math.max(a, b));

/**
 * Where each catalogue file stands on the device. Returns one entry per path:
 * { file_path, device_filename, state, resource_id, length_s } with state
 *   ready        in the device library (and on its disk) — can be scheduled
 *   on-disk      on the disk but not in the library — the push creates the resource
 *   missing      not on the device disk — upload it first
 *   unsupported  a container the device doesn't take (VIDEO_EXT)
 * A name is chosen once and recorded in AnalogFile. A name already on the
 * device that this catalogue never mapped is ADOPTED when the lengths agree —
 * the device library came from the same masters — and skipped (`_2`, …) when
 * they don't, so a different clip is never aired under someone else's name.
 */
export async function planFiles(client, paths, { source = 'device' } = {}) {
  const [lib, files] = await Promise.all([client.resources(source), client.files()]);
  const libByName = new Map();
  for (const r of lib) if (r.type !== 'program_guide' && !libByName.has(r.filename)) libByName.set(r.filename, r);
  const disk = new Set(files.map((f) => f.filename));
  const mapped = new Map(db.prepare('SELECT file_path, device_filename FROM AnalogFile').all()
    .map((r) => [r.file_path, r.device_filename]));
  const takenBy = new Map([...mapped].map(([p, n]) => [n, p]));
  const durationOf = db.prepare('SELECT MAX(duration) AS d FROM Resource WHERE file_path = ?');
  const remember = db.prepare('INSERT OR REPLACE INTO AnalogFile (file_path, device_filename) VALUES (?, ?)');

  const out = [];
  for (const filePath of paths) {
    const entry = { file_path: filePath, device_filename: null, state: 'missing', resource_id: null, length_s: null };
    if (!VIDEO_EXT.includes(extname(filePath).toLowerCase())) {
      entry.state = 'unsupported';
      out.push(entry);
      continue;
    }
    let name = mapped.get(filePath);
    if (!name) {
      const dur = durationOf.get(filePath)?.d;
      for (let n = 0; ; n++) {
        const cand = deviceFileName(filePath, n);
        if (takenBy.has(cand)) continue;
        const r = libByName.get(cand);
        if (r && dur && r.length_s && !sameLength(r.length_s, dur)) continue;
        name = cand;
        break;
      }
      remember.run(filePath, name);
      takenBy.set(name, filePath);
    }
    entry.device_filename = name;
    const r = libByName.get(name);
    if (disk.has(name)) {
      entry.state = r ? 'ready' : 'on-disk';
      if (r) { entry.resource_id = r.resource_id; entry.length_s = r.length_s; }
    }
    out.push(entry);
  }
  return out;
}

/** Distinct catalogue files the analog channel's blocks use between two dates (inclusive). */
export function filesForRange(channelId, from, to, statuses = ['draft', 'approved', 'exported']) {
  return db.prepare(`
    SELECT r.file_path, MAX(r.name) AS name, MAX(r.duration) AS duration,
           MIN(sb.target_date) AS first_date, COUNT(*) AS uses
    FROM ScheduleItem si
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN Resource r ON r.id = si.resource_id
    WHERE COALESCE(sb.channel_id, bt.channel_id) = ? AND sb.target_date BETWEEN ? AND ?
      AND sb.status IN (${statuses.map(() => '?').join(',')})
    GROUP BY r.file_path ORDER BY first_date, r.file_path
  `).all(channelId, from, to, ...statuses);
}

// --- Building a day ------------------------------------------------------------

const toSecs = (t) => {
  const [h, m, s = 0] = String(t).split(':').map(Number);
  return h * 3600 + m * 60 + s;
};
const clock = (secs) => [Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60]
  .map((n) => String(n).padStart(2, '0')).join(':');

/** Approved/exported blocks of the analog channel on `date`, with their shifted windows. */
export function airedBlocks(channelId, date) {
  return linkShifts(channelDayBlocks(channelId, date))
    .filter((b) => b.status === 'approved' || b.status === 'exported')
    .sort((a, b) => toSecs(a.effective_start) - toSecs(b.effective_start));
}

/**
 * The `items` for PUT /schedule/draft/days/<day>. `fileOf(path)` gives the
 * device's { resource_id, length_s }; `guide` is the Program Guide resource.
 * Returns { items, warnings, clips }.
 */
export function buildDayItems(blocks, fileOf, guide) {
  const items = [];
  const warnings = [];
  let clips = 0;
  for (const b of blocks) {
    const start = toSecs(b.effective_start);
    if (start < 0 || start >= 86400) throw new AnalogError(`block ${b.id} starts outside its day (${b.effective_start})`);
    const window = Math.round(b.blockSeconds);
    const label = `${clock(start)} block ${b.id}`;
    let used = 0;
    b.items.forEach((c, i) => {
      const f = fileOf(c.file_path);
      items.push({ resource_id: f.resource_id, ...(i === 0 ? { time: clock(start) } : {}) });
      used += f.length_s;
      clips++;
    });
    const gap = window - used;
    if (!b.items.length || gap >= 1) {
      if (!guide) {
        warnings.push(`${label}: ${gap}s left before the next block and no "Program Guide" resource on the device to fill it — black`);
      } else {
        items.push({ resource_id: guide.resource_id, length_s: Math.max(1, gap),
          ...(!b.items.length ? { time: clock(start) } : {}) });
      }
    } else if (gap < -5) {
      warnings.push(`${label}: runs ${-gap}s past its window on the device's lengths — the next block's fixed start trims it`);
    }
  }
  return { items, warnings, clips };
}

// --- Push ----------------------------------------------------------------------

let queue = Promise.resolve();
let inFlight = 0;
function serialized(fn) {
  inFlight++;
  for (const f of deviceListeners) { try { f(); } catch { /* see claimDevice */ } }
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  run.then(() => {}, () => {}).finally(() => { inFlight--; });
  return run;
}
/** True while an analog push or rollback is running or queued. */
export function isAnalogPushRunning() { return inFlight > 0; }

/**
 * Which of `dates` the analog channel can take: { pushable, held } where held
 * entries are { date, reason }. Dates with nothing approved are left out.
 */
export function analogWindow(channelId, dates, { includeToday = false } = {}) {
  const today = localDate();
  const last = addDays(today, analogConfig().daysAhead);
  const pushable = [];
  const held = [];
  for (const date of dates) {
    if (!airedBlocks(channelId, date).length) continue;
    if (date < today) held.push({ date, reason: 'in the past' });
    else if (date === today && !includeToday) held.push({ date, reason: 'on air today — push it on its own to confirm' });
    else if (date > last) {
      held.push({ date, reason: `beyond ${last}: the device holds one week, so this would overwrite the ${DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]} that airs sooner` });
    } else pushable.push(date);
  }
  return { pushable, held };
}

/**
 * Push `dates` to the device: one draft, every day replaced, ONE publish.
 * Returns { channel, days: [{ date, result }], held, backup }. A failure per day
 * leaves that weekday as it was (the draft started from what is on air);
 * missing files fail the whole run before the device is touched.
 */
export function pushAnalogDays(dates, { progress = NULL_PROGRESS, includeToday = false } = {}) {
  return serialized(() => doPush(dates, { progress, includeToday }));
}

async function doPush(dates, { progress, includeToday }) {
  const ch = analogChannel();
  if (!ch) throw new AnalogError('there is no analog channel');
  if (!isConfigured(ch)) throw new AnalogError(`${ch.name} has no address or API key — set them under Channels & Templates`);
  const { pushable, held } = analogWindow(ch.id, dates, { includeToday });
  const out = { channel: ch.name, channel_id: ch.id, days: [], held, backup: null };
  if (!pushable.length) return out;

  const today = localDate();
  const days = pushable.map((date) => ({
    date,
    weekday: DAYS[new Date(`${date}T00:00:00Z`).getUTCDay()],
    blocks: airedBlocks(ch.id, date).map((b) => ({ ...b, items: blockItems(b.id) })),
  }));
  const paths = [...new Set(days.flatMap((d) => d.blocks.flatMap((b) => b.items.map((i) => i.file_path))))];
  const client = new AnalogClient(ch);
  progress.emit({ type: 'analog', message: `${ch.name}: checking ${paths.length} file(s) on the device` });

  const plan = await planFiles(client, paths);
  const bad = plan.filter((p) => p.state === 'missing' || p.state === 'unsupported');
  if (bad.length) {
    throw Object.assign(new AnalogError(`${bad.length} file(s) are not on the analog device — upload them from the Analog tab first`),
      { missing: bad });
  }
  const cfg = analogConfig();
  const toAdd = plan.filter((p) => p.state === 'on-disk');
  if (toAdd.length && cfg.folderId == null) {
    throw new AnalogError(`${toAdd.length} file(s) are on the device disk but not in its library, and no library folder is chosen — pick one in the Analog tab`);
  }

  progress.guard();
  await client.resetDraft();
  for (const p of toAdd) {
    await client.createResource(p.device_filename, cfg.folderId);
    progress.emit({ type: 'analog', message: `${ch.name}: added ${p.device_filename} to the device library` });
  }
  const lib = await client.resources('draft');
  const byName = new Map();
  for (const r of lib) if (r.type !== 'program_guide' && !byName.has(r.filename)) byName.set(r.filename, r);
  const nameOf = new Map(plan.map((p) => [p.file_path, p.device_filename]));
  const fileOf = (path) => {
    const r = byName.get(nameOf.get(path));
    if (!r) throw new AnalogError(`${nameOf.get(path)} is not in the device library`);
    return r;
  };
  const guide = lib.find((r) => r.type === 'program_guide' && r.title === cfg.programGuideTitle)
    || lib.find((r) => r.type === 'program_guide') || null;

  for (const d of days) {
    progress.guard();
    const result = {
      channel: ch.name, playlist: `device ${d.weekday.toUpperCase()} (weekly template)`, source: 'analog',
      blocks: d.blocks.length, pushed: 0, ok: false,
    };
    try {
      const built = buildDayItems(d.blocks, fileOf, guide);
      const r = await client.replaceDay(d.weekday, built.items, 'drop');
      const dropped = (r.warnings || []).map((w) => w.message);
      const notes = [...built.warnings, ...dropped];
      result.pushed = built.clips;
      result.ok = true;
      if (notes.length) result.warning = notes.join('; ');
      progress.emit({ type: 'day-done', ok: true, message: `${ch.name} ${d.date}: ${built.clips} clip(s) → ${d.weekday}` });
    } catch (err) {
      result.error = err.message;
      progress.emit({ type: 'day-done', ok: false, message: `${ch.name} ${d.date}: ${err.message}` });
    }
    out.days.push({ date: d.date, result });
  }

  const good = out.days.filter((d) => d.result.ok);
  if (!good.length) {
    await client.resetDraft().catch(() => {});
    logRun(out);
    return out;
  }
  progress.emit({ type: 'analog', message: `${ch.name}: publishing ${good.length} day(s) to the device` });
  try {
    const pub = await client.publish({ confirmToday: good.some((d) => d.date === today) });
    out.backup = pub?.backup ?? null;
  } catch (err) {
    for (const d of good) { d.result.ok = false; d.result.error = `publish failed: ${err.message}`; }
    await client.resetDraft().catch(() => {});
    logRun(out);
    return out;
  }
  const mark = db.prepare("UPDATE ScheduledBlock SET status = 'exported' WHERE id = ?");
  for (const d of days) {
    if (!good.some((g) => g.date === d.date)) continue;
    for (const b of d.blocks) mark.run(b.id);
  }
  for (const d of good) if (out.backup) d.result.backup = out.backup;
  logRun(out);
  return out;
}

function logRun(out) {
  for (const { date, result } of out.days) {
    const line = `${result.channel} ${date}: ${result.pushed} clip(s), ${result.blocks} block(s) → ${result.playlist}`;
    if (result.ok) l.info(`${line}${out.backup ? ` (backup ${out.backup})` : ''}${result.warning ? ` — ${result.warning}` : ''}`);
    else l.warn(`${line} FAILED: ${result.error}`);
  }
  for (const h of out.held) l.info(`${out.channel} ${h.date}: held — ${h.reason}`);
}

/** Put a device backup back on air (serialized with pushes: both rewrite the schedule). */
export function rollbackAnalog(name) {
  return serialized(async () => {
    const ch = analogChannel();
    if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
    const r = await new AnalogClient(ch).rollback(name);
    l.warn(`rolled the device back to ${name}`);
    return r;
  });
}

// --- Files on the device disk (Vol1) -------------------------------------------
// Vol1 runs ~99% full, so making room is part of running the channel. What
// the device says about a file (in its on-air schedule, in its library) and
// what the automator knows (a block from today on still uses it) are both
// shown, and either one makes a delete need an explicit force.

/** Upcoming automator uses of each device file: Map(device_filename -> { first, drafts, approved }). */
function automatorUses(channelId) {
  const rows = db.prepare(`
    SELECT af.device_filename AS name, sb.status, MIN(sb.target_date) AS first, COUNT(*) AS n
    FROM AnalogFile af
    JOIN Resource r       ON r.file_path = af.file_path AND r.channel_id = ?
    JOIN ScheduleItem si  ON si.resource_id = r.id
    JOIN ScheduledBlock sb ON sb.id = si.block_id
    WHERE sb.target_date >= ?
    GROUP BY af.device_filename, sb.status
  `).all(channelId, localDate());
  const out = new Map();
  for (const r of rows) {
    const u = out.get(r.name) || { first: null, drafts: 0, approved: 0 };
    if (r.status === 'draft') u.drafts += r.n;
    else {
      u.approved += r.n;
      if (!u.first || r.first < u.first) u.first = r.first;
    }
    out.set(r.name, u);
  }
  return out;
}

/** Every file on the device disk with what uses it. */
export async function deviceFiles(client, channelId) {
  const files = await client.files();
  const mapped = new Map(db.prepare('SELECT device_filename, file_path FROM AnalogFile').all()
    .map((r) => [r.device_filename, r.file_path]));
  const uses = automatorUses(channelId);
  return files.map((f) => ({
    ...f,
    file_path: mapped.get(f.filename) || null,
    upcoming: uses.get(f.filename) || null,
  }));
}

/**
 * Delete files from the device disk. Without `force`, a file the device has in
 * its on-air schedule or that an approved/pushed block from today on still uses
 * is refused and listed. Serialized with pushes: a push resolving files while
 * one disappears would schedule a clip that is no longer there.
 * Returns { deleted: [{ filename, size }], refused: [{ filename, reason }], failed: [{ filename, error }] }.
 */
export function deleteDeviceFiles(filenames, { force = false } = {}) {
  return serialized(async () => {
    const ch = analogChannel();
    if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
    const client = new AnalogClient(ch);
    const byName = new Map((await deviceFiles(client, ch.id)).map((f) => [f.filename, f]));
    const safeOnShare = new Set(db.prepare(
      "SELECT filename FROM AnalogDeviceFile WHERE archive IN ('matched', 'archived') AND share_path IS NOT NULL"
    ).all().map((r) => r.filename));
    const out = { deleted: [], refused: [], failed: [] };
    for (const name of [...new Set(filenames.map(String))]) {
      const f = byName.get(name);
      if (!f) { out.failed.push({ filename: name, error: 'not on the device disk' }); continue; }
      // Nothing leaves the device without a copy on the share: a file the
      // automator uploaded has one by definition (AnalogFile), anything else
      // only once the Vol1 archive matched or archived it. Force doesn't skip this.
      if (!f.file_path && !safeOnShare.has(name)) {
        out.refused.push({ filename: name, reason: 'no copy on the share yet — archive it first (Vol1 inventory)', unsafe: true });
        continue;
      }
      const reasons = [];
      if (f.in_schedule) reasons.push('in the schedule on air');
      if (f.upcoming?.approved) reasons.push(`approved/pushed blocks use it from ${f.upcoming.first}`);
      if (reasons.length && !force) { out.refused.push({ filename: name, reason: reasons.join('; ') }); continue; }
      try {
        await client.deleteFile(name, force);
        out.deleted.push({ filename: name, size: f.size });
        db.prepare('UPDATE AnalogFile SET uploaded_at = NULL, size = NULL WHERE device_filename = ?').run(name);
        db.prepare('UPDATE AnalogDeviceFile SET gone_at = ? WHERE filename = ?').run(new Date().toISOString(), name);
        l.warn(`deleted ${name} from the device disk (${Math.round((f.size || 0) / 1048576)} MB)`
          + `${reasons.length ? ` — FORCED: ${reasons.join('; ')}` : ''}`);
      } catch (err) {
        if (err.status === 409) out.refused.push({ filename: name, reason: err.message });
        else out.failed.push({ filename: name, error: err.message });
      }
    }
    return out;
  });
}

// --- Upload job ----------------------------------------------------------------
// One at a time, in the background, polled by the Analog tab. In memory only: a
// restart simply stops it, and a re-run plans again (what landed is ready).

let job = null;

export function uploadStatus() {
  if (!job) return { running: false };
  const { controller, ...pub } = job;
  return pub;
}

export function cancelUpload() {
  if (!job?.running) return false;
  job.cancelled = true;
  job.controller.abort();
  return true;
}

/** Plan `paths` and upload every one the device is missing. Resolves once started. */
export async function startUpload(paths) {
  if (job?.running) throw new AnalogError('an upload is already running');
  const ch = analogChannel();
  if (!isConfigured(ch)) throw new AnalogError('the analog channel has no address or API key');
  const client = new AnalogClient(ch);
  const plan = await planFiles(client, paths);
  const todo = plan.filter((p) => p.state === 'missing');
  job = {
    running: true, cancelled: false, startedAt: new Date().toISOString(), finishedAt: null,
    total: todo.length, done: 0, bytesTotal: 0, bytesDone: 0, current: null,
    uploaded: [], failed: [], unsupported: plan.filter((p) => p.state === 'unsupported').map((p) => p.file_path),
    stoppedBy: null, controller: new AbortController(),
  };
  for (const f of deviceListeners) { try { f(); } catch { /* see claimDevice */ } }
  runUpload(client, todo, job).catch((err) => { l.error('upload job crashed', err); });
  return uploadStatus();
}

export async function runUpload(client, todo, j) {
  const record = db.prepare('UPDATE AnalogFile SET size = ?, uploaded_at = ? WHERE file_path = ?');
  const sized = [];
  for (const p of todo) {
    try {
      const st = await stat(localizePath(p.file_path));
      sized.push({ ...p, size: st.size });
    } catch (err) {
      j.failed.push({ file_path: p.file_path, error: `not readable on this Mac: ${err.code || err.message}` });
    }
  }
  j.bytesTotal = sized.reduce((n, p) => n + p.size, 0);
  try {
    for (const p of sized) {
      if (j.cancelled) break;
      j.current = p.device_filename;
      try {
        await client.upload(p.device_filename, localizePath(p.file_path), p.size, { signal: j.controller.signal });
        record.run(p.size, new Date().toISOString(), p.file_path);
        j.uploaded.push(p.device_filename);
        l.info(`uploaded ${p.file_path} → ${p.device_filename} (${Math.round(p.size / 1048576)} MB)`);
      } catch (err) {
        if (err.cancelled) break;
        j.failed.push({ file_path: p.file_path, error: err.message });
        l.warn(`upload ${p.file_path}: ${err.message}`);
        // No space and no permission won't change on the next file.
        if (err.status === 507 || err.status === 403 || err.status === 401) { j.stoppedBy = err.message; break; }
      }
      j.done++;
      j.bytesDone += p.size;
    }
  } finally {
    j.running = false;
    j.current = null;
    j.finishedAt = new Date().toISOString();
  }
}
