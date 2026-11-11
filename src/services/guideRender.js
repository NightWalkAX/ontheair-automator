// Channel guide clips: plan → HTML → frames (headless Chrome) → .mov (ffmpeg).
//
// No new dependency: the Mac already has Google Chrome, and Node ≥ 22 has a
// WebSocket, so Chrome is driven over its DevTools protocol directly (cdp()).
// Every animation in a guide is CSS, so each frame is taken by pausing all of
// them and seeking to the frame's time — deterministic, never real time.
// Measured on the automator Mac (M1): ~35 s for a 20 s guide.
//
// Output (house spec, CLAUDE.md "Air Spec"): 1920x1080, 30000/1001, h264 High
// yuv420p, closed GOP 15, no B-frames, PCM s16le 48 kHz stereo, .mov, written
// under guide.outDir/<channel>/<date>/b<block>.mov on the share. A re-render
// replaces the file atomically under the SAME name, so a day already pushed to
// OTAV picks up the new guide without a re-push. A block airing within
// guide.frozenMinutes (or past) is never re-rendered.
//
// The background loop (startGuideRenderer) keeps today..today+daysAhead ready
// for approved/exported blocks; the push uses whatever is rendered and falls
// back to the channel's "Stay with us" clip (same length) for the rest.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, renameSync, statSync, copyFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { loadConfig, localizePath } from '../config.js';
import { log } from '../logger.js';
import { addDays, localDate } from '../dates.js';
import { guideConfig, channelStyle, guideSecondsFor } from './guideConfig.js';
import { guidePlan } from './guidePlan.js';
import { channelDayBlocks, linkShifts } from './scheduling.js';
import { guideHtml, identHtml, MUSIC, TEMPLATE_VERSION } from './guideTemplates.js';

const L = log('guide');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'data', 'guide');
export const FRAMES_DIR = join(DATA, 'frames');
const FPS_NUM = 30000, FPS_DEN = 1001;
const MUSIC_OFFSET = { am: 0, pm: 25, eve: 50, late: 75 }; // a different stretch of the song per bracket

const ffmpegBin = () => { try { return process.env.FFMPEG_PATH || loadConfig().ffmpegPath || 'ffmpeg'; } catch { return 'ffmpeg'; } };
const sha = (s) => createHash('sha1').update(s).digest('hex');
const DAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const cap = (w) => w.charAt(0) + w.slice(1).toLowerCase();
function dateLabels(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const day = DAYS[d.getUTCDay()], mon = MONTHS[d.getUTCMonth()], n = d.getUTCDate();
  return { dateLong: `${day}, ${mon} ${n}`, dateShort: `${day} · ${mon.slice(0, 3)} ${n}`, dateTitle: `${cap(day)}, ${cap(mon)} ${n}` };
}

// --- channel folders ---------------------------------------------------------
const channelName = (id) => db.prepare('SELECT name FROM ChannelType WHERE id = ?').get(id)?.name ?? `channel-${id}`;
const safe = (s) => String(s).replace(/[^\w .+-]/g, '').trim() || 'channel';
export function guidePath(channelId, date, blockId) {
  return `${guideConfig().outDir.replace(/\/+$/, '')}/${safe(channelName(channelId))}/${date}/b${blockId}.mov`;
}
export function fallbackPath(channelId) {
  return `${guideConfig().outDir.replace(/\/+$/, '')}/${safe(channelName(channelId))}/_stay-with-us.mov`;
}

// --- frames of the programmes (cached per file) -------------------------------
function run(bin, args, { timeoutMs = 60000, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} timed out`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(e); });
    child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${err.trim().split('\n').pop()}`)); });
  });
}

/**
 * A still of the clip, cached; resolves to its URL or null. Three candidates
 * (30/45/60 %) and the one with the biggest JPEG wins: size tracks detail, so
 * a black or near-black frame (a film's dark scene) loses.
 */
export async function frameFor(filePath, duration) {
  if (!filePath) return null;
  mkdirSync(FRAMES_DIR, { recursive: true });
  const name = `${sha(filePath)}.jpg`;
  const out = join(FRAMES_DIR, name);
  if (existsSync(out)) return `/guide/frames/${name}`;
  const len = Number(duration) || 60;
  const tries = [];
  for (const [k, f] of [0.3, 0.45, 0.6].entries()) {
    const tmp = `${out}.${k}.tmp.jpg`;
    try {
      await run(ffmpegBin(), ['-nostdin', '-loglevel', 'error', '-ss', String(Math.max(1, Math.round(len * f))), '-i', localizePath(filePath),
        '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', '-y', tmp], { timeoutMs: 30000 });
      tries.push({ tmp, size: statSync(tmp).size });
    } catch (err) {
      if (!tries.length && k === 2) L.warn(`no frame for ${filePath}: ${err.message}`);
    }
  }
  if (!tries.length) return null;
  tries.sort((a, b) => b.size - a.size);
  renameSync(tries[0].tmp, out);
  for (const t of tries.slice(1)) rmSync(t.tmp, { force: true });
  return `/guide/frames/${name}`;
}

/** The plan as the template wants it: pictures resolved, dates as words. */
export async function guideView(plan, { frames = true } = {}) {
  const cfg = guideConfig();
  const pic = async (r) => (frames && r && (r.kind === 'movie' || r.kind === 'show' || r.kind === 'doc') ? frameFor(r.file_path, r.duration) : null);
  const rows = [];
  for (const r of plan.rows) rows.push({ ...r, img: await pic(r) });
  const hero = plan.hero ? { ...plan.hero, img: await pic(plan.hero) } : null;
  const bracketStart = Math.floor((plan.rows[0]?.at ?? 0) / 21600) * 21600;
  // MoE Central's clock shows when the guide is on air (the end of the block)
  const ca = ((Math.round(plan.airsAt / 60) * 60) % 86400 + 86400) % 86400;
  const clock = [`${(Math.floor(ca / 3600) % 12) || 12}:${String(Math.floor((ca % 3600) / 60)).padStart(2, '0')}`, ca < 43200 ? 'AM' : 'PM'];
  return {
    style: plan.style, bk: plan.bracket, rows, hero, next: plan.next, bracketStart, clock,
    seconds: Number(cfg.seconds) || 20, title: `Guide · block ${plan.blockId}`, ...dateLabels(plan.date),
  };
}

/** What decides a guide's content; a different hash = re-render. */
export function planHash(plan, style) {
  const cfg = guideConfig();
  return sha(JSON.stringify({ v: TEMPLATE_VERSION, s: cfg.seconds, style, plan: plan && { ...plan, airsAt: undefined } }));
}

// --- headless Chrome over the DevTools protocol --------------------------------
class Browser {
  static async launch(chromePath) {
    const dir = mkdtempSync(join(tmpdir(), 'guide-chrome-'));
    const child = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
      '--hide-scrollbars', '--mute-audio', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--force-color-profile=srgb', `--user-data-dir=${dir}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const t = setTimeout(() => reject(new Error('Chrome did not start (no DevTools URL in 20 s)')), 20000);
      child.stderr.on('data', (d) => {
        buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on('error', (e) => { clearTimeout(t); reject(e); });
      child.on('exit', (c) => { clearTimeout(t); reject(new Error(`Chrome exited (${c}) before DevTools came up`)); });
    });
    const b = new Browser(child, dir);
    // The socket can refuse for a moment right after Chrome prints its URL.
    for (let i = 0; ; i++) {
      try { await b.connect(wsUrl); return b; } catch (err) {
        if (i >= 4) { await b.close(); throw err; }
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  }
  constructor(child, dir) { this.child = child; this.dir = dir; this.id = 0; this.pending = new Map(); this.events = []; }
  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => reject(new Error(`DevTools socket: ${e.message || e.error?.message || 'error'}`));
      ws.onmessage = (m) => {
        const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
          msg.error ? rej(new Error(`${msg.error.message}`)) : res(msg.result);
        } else if (msg.method) {
          for (const w of [...this.events]) if (w.method === msg.method && w.sessionId === msg.sessionId) { this.events.splice(this.events.indexOf(w), 1); w.res(msg.params); }
        }
      };
      ws.onclose = () => { for (const { rej } of this.pending.values()) rej(new Error('DevTools socket closed')); this.pending.clear(); };
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  once(method, sessionId, timeoutMs = 30000) {
    return new Promise((res, rej) => {
      const w = { method, sessionId, res };
      this.events.push(w);
      setTimeout(() => { const i = this.events.indexOf(w); if (i >= 0) { this.events.splice(i, 1); rej(new Error(`${method} timed out`)); } }, timeoutMs);
    });
  }
  async close() {
    try { this.ws?.close(); } catch { /* gone */ }
    try { this.child.kill('SIGKILL'); } catch { /* gone */ }
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/**
 * Render a full HTML page (served by this app at `url`) to a house-spec .mov.
 * Frames are piped as JPEG to ffmpeg; music from `music` at `musicOffset`.
 */
async function renderUrl(browser, url, out, { seconds, music, musicOffset = 0 }) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => browser.send(m, p, sessionId);
  let ff;
  try {
    await S('Page.enable');
    await S('Emulation.setDeviceMetricsOverride', { width: 768, height: 432, deviceScaleFactor: 2.5, mobile: false });
    const loaded = browser.once('Page.loadEventFired', sessionId, 60000);
    await S('Page.navigate', { url });
    await loaded;
    await S('Runtime.evaluate', {
      awaitPromise: true,
      expression: `(async () => { await document.fonts.ready;
        await Promise.all([...document.images].map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; })));
        const urls = [...document.querySelectorAll('*')].flatMap((e) => [...getComputedStyle(e).backgroundImage.matchAll(/url\\("?([^")]+)"?\\)/g)].map((m) => m[1]));
        await Promise.all([...new Set(urls)].map((u) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = u; })));
        return true; })()`,
    });
    const frames = Math.round(seconds * FPS_NUM / FPS_DEN);
    const fps = `${FPS_NUM}/${FPS_DEN}`;
    const dur = (frames * FPS_DEN / FPS_NUM).toFixed(3);
    const args = ['-nostdin', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', fps, '-i', '-'];
    if (music && existsSync(music)) args.push('-ss', String(musicOffset), '-t', dur, '-i', music);
    else args.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=48000:cl=stereo');
    args.push('-map', '0:v', '-map', '1:a',
      '-vf', `scale=1920:1080:flags=lanczos:in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p,fade=t=in:st=0:d=0.3,fade=t=out:st=${(dur - 0.5).toFixed(2)}:d=0.5`,
      '-af', `afade=t=in:st=0:d=0.8,afade=t=out:st=${(dur - 1.5).toFixed(2)}:d=1.5,loudnorm=I=-24:TP=-2,aresample=48000`,
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'medium', '-crf', '18', '-g', '15', '-bf', '0', '-flags', '+cgop', '-r', fps,
      '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-t', dur, '-video_track_timescale', '30000', '-movflags', '+faststart', '-f', 'mov', out);
    let ffErr = '';
    ff = spawn(ffmpegBin(), args, { stdio: ['pipe', 'ignore', 'pipe'] });
    ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-4000); });
    const done = new Promise((res, rej) => {
      ff.on('error', rej);
      ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}: ${ffErr.trim().split('\n').pop()}`))));
    });
    ff.stdin.on('error', () => { /* reported by close */ });
    for (let i = 0; i < frames; i++) {
      const t = (i * FPS_DEN * 1000) / FPS_NUM;
      await S('Runtime.evaluate', { expression: `for (const a of document.getAnimations()) { a.pause(); a.currentTime = ${t}; }` });
      const { data } = await S('Page.captureScreenshot', {
        format: 'jpeg', quality: 92, optimizeForSpeed: true, clip: { x: 0, y: 0, width: 768, height: 432, scale: 1 },
      });
      if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end();
    await done;
    return Number(dur);
  } finally {
    if (ff && ff.exitCode == null) ff.stdin.destroy();
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/** Write via a work file next to the target, then rename: never a half file at an airing path. */
async function publish(work, canonical) {
  const dest = localizePath(canonical);
  mkdirSync(dirname(dest), { recursive: true });
  const part = join(dirname(dest), `.${Date.now()}.part.mov`);
  copyFileSync(work, part);
  renameSync(part, dest);
}

// --- one block ---------------------------------------------------------------
const baseUrl = () => { let p = 8090; try { p = loadConfig().server?.port || 8090; } catch { /* default */ } return `http://127.0.0.1:${p}`; };
const upsert = () => db.prepare(`INSERT INTO GuideRender (block_id, channel_id, target_date, path, hash, status, error, seconds, rendered_at)
  VALUES (@block_id, @channel_id, @target_date, @path, @hash, @status, @error, @seconds, datetime('now','localtime'))
  ON CONFLICT(block_id) DO UPDATE SET channel_id=@channel_id, target_date=@target_date, path=@path, hash=@hash,
  status=@status, error=@error, seconds=@seconds, rendered_at=datetime('now','localtime')`);

/**
 * Render one block's guide if it is missing or stale. `browser` is reused by
 * the batch. Returns { blockId, status: 'ok'|'fresh'|'empty'|'frozen'|'failed', ... }.
 */
export async function renderBlockGuide(blockId, { browser, force = false, nowAbs = null } = {}) {
  const b = db.prepare('SELECT id, channel_id, target_date FROM ScheduledBlock WHERE id = ?').get(blockId);
  if (!b) return { blockId, status: 'gone' };
  const style = channelStyle(b.channel_id);
  if (!style) return { blockId, status: 'no-guide' };
  const plan = guidePlan(blockId);
  const hash = planHash(plan, style);
  const row = db.prepare('SELECT * FROM GuideRender WHERE block_id = ?').get(blockId);
  const path = guidePath(b.channel_id, b.target_date, blockId);
  const base = { block_id: blockId, channel_id: b.channel_id, target_date: b.target_date, path, hash };
  if (!plan) { upsert().run({ ...base, status: 'empty', error: 'nothing airs in the next brackets', seconds: null }); return { blockId, status: 'empty' }; }
  if (!force && row?.status === 'ok' && row.hash === hash && existsSync(localizePath(row.path))) return { blockId, status: 'fresh' };
  const cfg = guideConfig();
  if (row?.status === 'ok' && nowAbs != null && plan.airsAt - nowAbs < cfg.frozenMinutes * 60) return { blockId, status: 'frozen' };
  const work = join(mkdtempSync(join(tmpdir(), 'guide-')), `b${blockId}.mov`);
  try {
    const seconds = await renderUrl(browser, `${baseUrl()}/api/guide/blocks/${blockId}/page`, work, {
      seconds: Number(cfg.seconds) || 20, music: join(ROOT, 'public', MUSIC[style]), musicOffset: MUSIC_OFFSET[plan.bracket] ?? 0,
    });
    await publish(work, path);
    upsert().run({ ...base, status: 'ok', error: null, seconds });
    return { blockId, status: 'ok', path, seconds };
  } catch (err) {
    upsert().run({ ...base, status: 'failed', error: String(err.message || err), seconds: null });
    L.error(`guide for block ${blockId} failed`, err);
    return { blockId, status: 'failed', error: String(err.message || err) };
  } finally {
    rmSync(dirname(work), { recursive: true, force: true });
  }
}

/** The channel's "Stay with us" clip, rendered once (and again after a look change). */
export async function ensureFallback(channelId, { browser } = {}) {
  const style = channelStyle(channelId);
  if (!style) return null;
  const path = fallbackPath(channelId);
  const local = localizePath(path);
  const marker = `${local}.v${TEMPLATE_VERSION}-${guideConfig().seconds}`;
  if (existsSync(local) && existsSync(marker)) return path;
  const own = !browser;
  const br = browser ?? await Browser.launch(guideConfig().chromePath);
  const work = join(mkdtempSync(join(tmpdir(), 'guide-')), 'fallback.mov');
  try {
    await renderUrl(br, `${baseUrl()}/api/guide/fallback/${channelId}/page`, work, {
      seconds: Number(guideConfig().seconds) || 20, music: join(ROOT, 'public', MUSIC[style]), musicOffset: 0,
    });
    await publish(work, path);
    for (const f of readdirSync(dirname(local))) if (f.startsWith(`${local.split('/').pop()}.v`)) unlinkSync(join(dirname(local), f));
    writeFileSync(marker, ''); // which look/length this fallback was rendered with
    return path;
  } finally {
    rmSync(dirname(work), { recursive: true, force: true });
    if (own) await br.close();
  }
}

export { identHtml, guideHtml };

// --- batches and the background loop -------------------------------------------
const state = { running: false, cancel: false, startedAt: null, finishedAt: null, total: 0, done: 0, counts: {}, current: [], lastError: null, scope: null };
export function guideStatus() {
  const cfg = guideConfig();
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM GuideRender WHERE target_date >= ? GROUP BY status`).all(localDate());
  return { enabled: !!cfg.enabled, startDate: cfg.startDate, seconds: cfg.seconds, outDir: cfg.outDir, ...state, current: [...state.current], upcoming: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
}
export function stopGuideRender() { if (state.running) state.cancel = true; return guideStatus(); }

/** Blocks that air a guide in the range: approved/exported, on a channel with a look, window long enough. */
export function guideBlocks(from, to, channelIds = []) {
  const chans = db.prepare("SELECT id FROM ChannelType WHERE is_active = 1 AND COALESCE(playout,'otav') != 'analog'").all()
    .map((c) => c.id).filter((id) => (!channelIds.length || channelIds.includes(id)) && channelStyle(id));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const ch of chans) {
      for (const r of linkShifts(channelDayBlocks(ch, d))) {
        if (r.guide_seconds > 0 && (r.status === 'approved' || r.status === 'exported')) out.push({ id: r.id, channel_id: ch, date: d, start: r.effective_start });
      }
    }
  }
  return out;
}

const nowAbsolute = () => {
  const d = new Date();
  const day = Math.round(Date.parse(`${localDate(d)}T00:00:00Z`) / 86400000);
  return day * 86400 + d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
};

/** Render every missing/stale guide in a range (one run at a time). */
export async function renderRange(from, to, { channelIds = [], force = false, blockIds = [] } = {}) {
  if (state.running) throw Object.assign(new Error('a guide render is already running'), { status: 409 });
  const cfg = guideConfig({ fresh: true });
  if (!cfg.enabled) throw Object.assign(new Error('the channel guide is off (config guide.enabled)'), { status: 409 });
  const only = new Set(blockIds.map(Number));
  const list = guideBlocks(from, to, channelIds).filter((b) => !only.size || only.has(b.id))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  Object.assign(state, { running: true, cancel: false, startedAt: new Date().toISOString(), finishedAt: null, total: list.length, done: 0, counts: {}, current: [], lastError: null, scope: { from, to, channelIds, force } });
  const workers = Math.max(1, Math.min(4, Number(cfg.concurrency) || 1));
  const browsers = [];
  try {
    for (let i = 0; i < workers; i++) browsers.push(await Browser.launch(cfg.chromePath));
    const chans = [...new Set(list.map((b) => b.channel_id))];
    for (const ch of chans) {
      try { await ensureFallback(ch, { browser: browsers[0] }); } catch (err) { state.lastError = `fallback ${ch}: ${err.message}`; L.error(`fallback clip for channel ${ch} failed`, err); }
    }
    let next = 0;
    const nowAbs = nowAbsolute();
    await Promise.all(browsers.map(async (browser) => {
      while (!state.cancel && next < list.length) {
        const item = list[next++];
        state.current.push(item.id);
        const res = await renderBlockGuide(item.id, { browser, force, nowAbs });
        state.current.splice(state.current.indexOf(item.id), 1);
        state.done++;
        state.counts[res.status] = (state.counts[res.status] || 0) + 1;
        if (res.status === 'failed') state.lastError = `block ${item.id}: ${res.error}`;
      }
    }));
  } catch (err) {
    state.lastError = String(err.message || err);
    L.error('guide render run failed', err);
  } finally {
    await Promise.all(browsers.map((b) => b.close()));
    state.running = false;
    state.finishedAt = new Date().toISOString();
    L.info(`guide render ${from}..${to}: ${JSON.stringify(state.counts)}${state.cancel ? ' (stopped)' : ''}`);
  }
  return guideStatus();
}

/** Delete rendered days older than keepDays (never the fallback clips). */
export function pruneOldGuides() {
  const cfg = guideConfig();
  const cutoff = addDays(localDate(), -Math.max(1, Number(cfg.keepDays) || 3));
  const root = localizePath(cfg.outDir);
  if (!existsSync(root)) return 0;
  let n = 0;
  for (const ch of readdirSync(root)) {
    const dir = join(root, ch);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    for (const d of readdirSync(dir)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d < cutoff) { rmSync(join(dir, d), { recursive: true, force: true }); n++; }
    }
  }
  db.prepare('DELETE FROM GuideRender WHERE target_date < ?').run(cutoff);
  return n;
}

let timer = null;
/** Keeps today..today+daysAhead rendered. Off while guide.enabled is false. */
export function startGuideRenderer() {
  if (timer) return;
  const tick = async () => {
    const cfg = guideConfig({ fresh: true });
    if (!cfg.enabled || state.running) return;
    try {
      pruneOldGuides();
      const today = localDate();
      await renderRange(today, addDays(today, Math.max(0, Number(cfg.daysAhead) || 0)));
    } catch (err) { L.error('guide renderer tick failed', err); }
  };
  const every = () => Math.max(5, Number(guideConfig().intervalMinutes) || 15) * 60000;
  setTimeout(tick, 60000).unref?.();
  timer = setInterval(tick, every());
  timer.unref?.();
}

// --- the push ------------------------------------------------------------------
/**
 * The guide clip each block of a channel-day closes with, for the OTAV push:
 * Map(blockId → { file_path, name, label, duration }). A block's own guide when
 * rendered and on disk, else the channel's fallback; a block that keeps no
 * guide time gets none. Throws when a guide is due and neither exists — a day
 * pushed without them would end early by 20 s a block.
 */
export async function guideItemsForDay(channelId, date) {
  const rows = linkShifts(channelDayBlocks(channelId, date)).filter((r) => r.guide_seconds > 0);
  const out = new Map();
  if (!rows.length) return out;
  const exists = async (p) => { try { return (await stat(localizePath(p))).size > 0; } catch { return false; } };
  let fallback = fallbackPath(channelId);
  if (!(await exists(fallback))) fallback = await ensureFallback(channelId);
  for (const r of rows) {
    const g = db.prepare("SELECT path, seconds FROM GuideRender WHERE block_id = ? AND status = 'ok'").get(r.id);
    const own = g && (await exists(g.path)) ? g.path : null;
    out.set(r.id, {
      file_path: own ?? fallback, name: own ? 'Channel guide' : 'Channel guide (stay with us)',
      label: own ? 'Channel guide' : 'Channel guide · stay with us', duration: g?.seconds ?? r.guide_seconds, is_guide: true,
    });
  }
  return out;
}

export { guideSecondsFor };
