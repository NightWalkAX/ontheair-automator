// Signal monitor: watch the channels' public HLS feeds and e-mail the operators
// when one goes BLACK (or freezes, or the feed itself disappears).
//
// Headless and browser-free: one ffmpeg per feed reads the LOWEST rendition of
// the HLS ladder (a 480x320 picture is plenty to tell black from not-black, and
// decoding it costs a few % of one core) and hands this process one tiny
// grayscale frame per second — 64x36 = 2304 bytes of luma. Everything else is
// plain JavaScript on those bytes. A headless Chrome would do the same job
// through a canvas, but it is a 150MB download that does not travel on a USB
// drive, and ffmpeg is already a dependency of this app.
//
// Durations are measured in STREAM time, by counting frames, not by the wall
// clock: an HLS reader receives a whole segment (10s here) in one burst, and
// the first read after connecting delivers the last ~30s at once, so arrival
// times say little about how long a picture was actually black. At `sampleFps`
// frames per second, N black frames in a row is N / sampleFps seconds of black.
// Only "the feed stopped delivering anything" is judged by the wall clock,
// because there are no frames to count.
//
// One incident per feed at a time, recorded in SignalEvent:
//   black  — ≥ alertAfterSeconds of frames with almost no bright pixel. "Almost"
//            because the channel bug / watermark stays on screen over a black
//            programme; `maxBrightPct` is how much of the picture it may cover.
//   frozen — the same picture for ≥ alertAfterSeconds (OFF by default: a lesson
//            slide legitimately holds still for minutes).
//   down   — no frame at all for ≥ alertAfterSeconds (feed unreachable, encoder
//            stopped, or this Mac lost its connection).
//   silent — the AUDIO: ≥ silence.alertAfterSeconds below silence.thresholdDb, or
//            no audio at all while the picture keeps coming. Tracked apart from
//            the picture (a feed can be black AND silent, or silent with a
//            perfect picture — a clip with no sound), by a second, independent
//            ffmpeg on the feed's audio rendition, so a broken audio reader never
//            stops the black detection. 1s windows of 8kHz mono s16 — RMS in
//            dBFS per window, counted in stream time like the frames.
// Before alerting on black or frozen, a feed linked to a channel we control
// (source.channelId) gets ONE OTAV scheduler resync (GET /scheduler/resynchronize
// — "stop playing what it is currently playing and start playing what was
// scheduled"), and the alert is HELD for resync.waitSeconds: the public feed
// runs 30s+ behind the playout, so the fix can't be seen any sooner. Picture
// back inside the window = fixed, recorded, and (by default) nobody is mailed.
// Still black, or the resync refused = the alert goes out saying what was
// tried. At most one resync per channel per resync.cooldownMinutes: a
// programme that is genuinely black must not be interrupted on a loop.
//
// Opening and closing each send an e-mail; a long incident sends a reminder
// every `repeatMinutes`. Alerts raised within `batchSeconds` of each other go
// out as ONE message, so a network outage that takes all seven feeds reads as
// one e-mail rather than seven.

import { spawn } from 'node:child_process';
import { db } from '../db.js';
import { loadConfig, updateConfig } from '../config.js';
import { log } from '../logger.js';
import { sendMail, emailProblem, emailConfig } from './mailer.js';
import { OtavClient } from './otavClient.js';

const L = log('monitor');

export const FRAME_W = 64;
export const FRAME_H = 36;
export const FRAME_BYTES = FRAME_W * FRAME_H;

// The seven GLC feeds from glc-playout.html. Used only when config.json has no
// monitor.sources yet; from then on the list lives in config.json.
export const DEFAULT_SOURCES = [
  ['glc-classic', 'Guyana Learning Channel', 'GuyanaLearning'],
  ['glc-junior', 'GLC Junior', 'GLCjr'],
  ['glc-elementary', 'GLC Elementary', 'GLCElementary'],
  ['glc-teened', 'GLC TeenEd', 'GLCTeenED'],
  ['glc-elevate', 'GLC Elevate', 'GLCEleVate'],
  ['glc-discover', 'GLC Discover', 'GLCDiscover'],
  ['glc-plus', 'GLC Plus', 'GLCAhWeTV'],
].map(([id, name, key]) => ({
  id, name, enabled: true, channelId: null,
  url: `http://live.dreamtv.gy/live/c2eds/${key}/HLS/${key}.m3u8`,
}));

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export const slug = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'feed';

/** config.monitor with every default filled in and every number bounded. */
export function monitorConfig(raw = loadConfig().monitor) {
  const m = raw || {};
  const b = m.black || {};
  const f = m.freeze || {};
  const d = m.down || {};
  const sources = (Array.isArray(m.sources) ? m.sources : DEFAULT_SOURCES).map((s) => ({
    id: String(s.id || slug(s.name || s.url)),
    name: String(s.name || s.id || s.url),
    url: String(s.url || ''),
    enabled: s.enabled !== false,
    channelId: Number.isInteger(Number(s.channelId)) && Number(s.channelId) > 0
      ? Number(s.channelId) : null,
  }));
  return {
    enabled: m.enabled === true,
    sampleFps: clampNum(m.sampleFps, 0.2, 5, 1),
    variant: m.variant === 'highest' ? 'highest' : 'lowest',
    black: {
      maxLuma: clampNum(b.maxLuma, 1, 128, 32),
      maxBrightPct: clampNum(b.maxBrightPct, 0, 50, 2),
      alertAfterSeconds: clampNum(b.alertAfterSeconds, 1, 3600, 10),
      recoverAfterSeconds: clampNum(b.recoverAfterSeconds, 1, 600, 5),
    },
    freeze: {
      enabled: f.enabled === true,
      maxDiff: clampNum(f.maxDiff, 0, 20, 0.5),
      alertAfterSeconds: clampNum(f.alertAfterSeconds, 5, 7200, 60),
      recoverAfterSeconds: clampNum(f.recoverAfterSeconds, 1, 600, 3),
    },
    silence: {
      enabled: (m.silence || {}).enabled !== false,
      thresholdDb: clampNum((m.silence || {}).thresholdDb, -90, -20, -50),
      alertAfterSeconds: clampNum((m.silence || {}).alertAfterSeconds, 5, 3600, 30),
      recoverAfterSeconds: clampNum((m.silence || {}).recoverAfterSeconds, 1, 600, 3),
      noAudioAfterSeconds: clampNum((m.silence || {}).noAudioAfterSeconds, 10, 3600, 60),
    },
    down: {
      alertAfterSeconds: clampNum(d.alertAfterSeconds, 10, 3600, 60),
      stallRestartSeconds: clampNum(d.stallRestartSeconds, 10, 600, 45),
    },
    resync: {
      enabled: (m.resync || {}).enabled !== false,
      waitSeconds: clampNum((m.resync || {}).waitSeconds, 1, 600, 60),
      cooldownMinutes: clampNum((m.resync || {}).cooldownMinutes, 1, 1440, 15),
      emailWhenFixed: (m.resync || {}).emailWhenFixed === true,
    },
    repeatMinutes: clampNum(m.repeatMinutes, 0, 1440, 30),
    batchSeconds: clampNum(m.batchSeconds, 0, 300, 15),
    sources,
  };
}

// --- Frame analysis ---------------------------------------------------------

/**
 * Measure one 8-bit luma frame. `prev` (the previous frame, or null) gives the
 * mean absolute difference used for freeze detection. Pure — tested directly.
 */
export function analyzeFrame(frame, prev, cfg) {
  let sum = 0;
  let bright = 0;
  let diff = 0;
  const n = frame.length;
  for (let i = 0; i < n; i++) {
    const v = frame[i];
    sum += v;
    if (v > cfg.black.maxLuma) bright++;
    if (prev) diff += Math.abs(v - prev[i]);
  }
  const brightPct = (100 * bright) / n;
  return {
    luma: sum / n,
    brightPct,
    diff: prev ? diff / n : null,
    black: brightPct <= cfg.black.maxBrightPct,
  };
}

export const AUDIO_RATE = 8000;
export const AUDIO_WINDOW_BYTES = AUDIO_RATE * 2;   // 1s of mono s16le

/** RMS level of one window of s16le samples, in dBFS (-Infinity for digital silence). Pure. */
export function audioLevelDb(buf) {
  const n = Math.floor(buf.length / 2);
  if (!n) return -Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n);
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// --- Per-feed state machine -------------------------------------------------
//
// Deliberately free of I/O and timers: frames and ticks come in, events come
// out through `emit`. That is what lets the tests drive a whole incident in a
// few lines, with a fake clock.

const nowIso = (ms) => new Date(ms).toISOString();

export class FeedWatch {
  constructor(source, cfg, emit, now = Date.now()) {
    this.source = source;
    this.cfg = cfg;
    this.emit = emit;
    this.startedAt = now;
    this.lastFrameAt = null;
    this.prev = null;
    this.last = null;            // last analyzeFrame() result
    this.blackRun = 0;           // consecutive black frames
    this.clearRun = 0;           // consecutive non-black frames
    this.frozenRun = 0;
    this.movingRun = 0;
    this.framesSinceDown = 0;
    this.incident = null;        // { kind, startedAt, alertedAt, remindedAt }
    this.error = null;
    this.frames = 0;
    // Audio, a separate track with its own incident.
    this.audioIncident = null;
    this.lastAudioAt = null;
    this.lastDb = null;
    this.quietRun = 0;           // consecutive seconds below the silence threshold
    this.soundRun = 0;
    this.audioSeconds = 0;
    this.audioError = null;
  }

  onAudioSecond(db, now = Date.now()) {
    this.lastDb = db;
    this.lastAudioAt = now;
    this.audioSeconds++;
    this.audioError = null;
    if (db <= this.cfg.silence.thresholdDb) { this.quietRun++; this.soundRun = 0; } else { this.soundRun++; this.quietRun = 0; }
    this.evaluateAudio(now);
  }

  evaluateAudio(now) {
    const s = this.cfg.silence;
    const inc = this.audioIncident;
    // No picture at all is already its own alert; silence on top of it is noise.
    if (!s.enabled || this.incident?.kind === 'down') {
      if (inc) this.close(now, s.enabled ? 'feed lost' : null, 'audioIncident');
      return;
    }
    if (inc) {
      if (this.soundRun >= s.recoverAfterSeconds) this.close(now, null, 'audioIncident');
      else this.remind(now, 'audioIncident');
      return;
    }
    const noAudioFor = (now - (this.lastAudioAt ?? this.startedAt)) / 1000;
    if (noAudioFor >= s.noAudioAfterSeconds) {
      this.soundRun = 0;
      this.open('silent', now, this.lastAudioAt ?? this.startedAt, 'audioIncident',
        { detail: 'no audio in the feed at all' });
    } else if (this.quietRun >= s.alertAfterSeconds) {
      this.open('silent', now, now - this.quietRun * 1000, 'audioIncident');
    }
  }

  frameSeconds(n) { return n / this.cfg.sampleFps; }

  onFrame(frame, now = Date.now()) {
    const a = analyzeFrame(frame, this.prev, this.cfg);
    this.prev = Buffer.from(frame);
    this.last = a;
    this.lastFrameAt = now;
    this.frames++;
    this.framesSinceDown++;
    this.error = null;

    if (a.black) { this.blackRun++; this.clearRun = 0; } else { this.clearRun++; this.blackRun = 0; }
    // A black picture is also a still one; it is reported as black, never frozen.
    const still = !a.black && a.diff !== null && a.diff <= this.cfg.freeze.maxDiff;
    if (still) { this.frozenRun++; this.movingRun = 0; } else { this.movingRun++; this.frozenRun = 0; }

    this.evaluate(now);
  }

  /** Wall-clock checks (feed down, no audio, reminders). Called every second. */
  tick(now = Date.now()) {
    this.evaluate(now);
    this.evaluateAudio(now);
  }

  evaluate(now) {
    const { black, freeze, down } = this.cfg;
    const noFrameFor = (now - (this.lastFrameAt ?? this.startedAt)) / 1000;
    const inc = this.incident;

    // 1. The feed itself.
    if (noFrameFor >= down.alertAfterSeconds) {
      if (inc?.kind !== 'down') {
        if (inc) this.close(now, 'feed lost');
        this.framesSinceDown = 0;
        this.open('down', now, (this.lastFrameAt ?? this.startedAt));
      }
      return this.remind(now);
    }
    if (inc?.kind === 'down') {
      // Back once a few seconds of picture have arrived, not on one stray frame.
      if (this.framesSinceDown >= Math.max(3, this.cfg.sampleFps * 3)) {
        this.close(now);
      } else return this.remind(now);
    }

    // 2. Black.
    if (this.incident?.kind === 'black') {
      if (this.frameSeconds(this.clearRun) >= black.recoverAfterSeconds) this.close(now);
      else return this.remind(now);
    }
    if (this.frameSeconds(this.blackRun) >= black.alertAfterSeconds) {
      if (this.incident) this.close(now, 'went black');
      this.open('black', now, now - this.frameSeconds(this.blackRun) * 1000);
      return this.remind(now);
    }

    // 3. Frozen (optional).
    if (this.incident?.kind === 'frozen') {
      if (!freeze.enabled || this.frameSeconds(this.movingRun) >= freeze.recoverAfterSeconds) {
        this.close(now);
      } else return this.remind(now);
    }
    if (freeze.enabled && this.frameSeconds(this.frozenRun) >= freeze.alertAfterSeconds) {
      this.open('frozen', now, now - this.frameSeconds(this.frozenRun) * 1000);
    }
    return this.remind(now);
  }

  // `slot` is 'incident' (the picture / the feed) or 'audioIncident' (the sound).
  open(kind, now, startedAtMs, slot = 'incident', extra = {}) {
    const inc = { kind, startedAt: nowIso(startedAtMs), alertedAt: nowIso(now), remindedAt: now, ...extra };
    this[slot] = inc;
    this.emit({ type: 'open', kind, source: this.source, incident: inc, at: now });
  }

  close(now, note = null, slot = 'incident') {
    const inc = this[slot];
    if (!inc) return;
    this[slot] = null;
    this.emit({ type: 'close', kind: inc.kind, source: this.source, incident: inc, at: now, note });
  }

  remind(now, slot = 'incident') {
    const inc = this[slot];
    const every = this.cfg.repeatMinutes * 60_000;
    if (!inc || !every || now - inc.remindedAt < every) return;
    inc.remindedAt = now;
    this.emit({ type: 'remind', kind: inc.kind, source: this.source, incident: inc, at: now });
  }

  get state() {
    if (!this.source.enabled) return 'disabled';
    if (this.incident?.held) return 'resyncing';
    if (this.incident) return this.incident.kind;
    if (!this.lastFrameAt) return 'starting';
    if (this.blackRun > 0) return 'dimming';     // black, but not long enough to alert
    return 'ok';
  }

  get audioState() {
    if (!this.source.enabled) return 'disabled';
    if (!this.cfg.silence.enabled) return 'off';
    if (this.audioIncident) return 'silent';
    if (!this.lastAudioAt) return 'starting';
    if (this.quietRun > 0) return 'quiet';       // silent, but not long enough to alert
    return 'ok';
  }

  snapshot() {
    return {
      id: this.source.id,
      name: this.source.name,
      url: this.source.url,
      channelId: this.source.channelId,
      enabled: this.source.enabled,
      state: this.state,
      incident: this.incident && {
        kind: this.incident.kind, startedAt: this.incident.startedAt, alertedAt: this.incident.alertedAt,
        resync: this.incident.resync || null,
      },
      lastFrameAt: this.lastFrameAt && nowIso(this.lastFrameAt),
      luma: this.last ? Math.round(this.last.luma * 10) / 10 : null,
      brightPct: this.last ? Math.round(this.last.brightPct * 10) / 10 : null,
      blackSeconds: Math.round(this.frameSeconds(this.blackRun)),
      audio: {
        state: this.audioState,
        db: Number.isFinite(this.lastDb) ? Math.round(this.lastDb * 10) / 10 : (this.lastDb === null ? null : -120),
        quietSeconds: this.quietRun,
        lastAt: this.lastAudioAt && nowIso(this.lastAudioAt),
        incident: this.audioIncident && {
          kind: 'silent', startedAt: this.audioIncident.startedAt, detail: this.audioIncident.detail || null,
        },
        error: this.audioError,
        url: this.audioUrl || null,
      },
      frames: this.frames,
      error: this.error,
      variantUrl: this.variantUrl || null,
      // The frame itself, so the UI can draw a thumbnail and nobody has to take
      // the numbers on faith.
      frame: this.prev ? this.prev.toString('base64') : null,
    };
  }
}

// --- HLS: pick the rendition -------------------------------------------------

/**
 * Resolve a master playlist to one rendition URL (lowest bandwidth by default).
 * Follows the CDN's redirect first, so relative URIs resolve against where the
 * playlist really lives. A media playlist is returned as is.
 */
export async function resolveFeed(url, variant = 'lowest', { timeoutMs = 10_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`playlist answered HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith('#EXTM3U')) throw new Error('not an HLS playlist');
  const base = res.url || url;
  const video = pickVariant(text, base, variant);
  // No separate audio rendition = the sound is muxed into the video one.
  return { video, audio: pickAudio(text, base) || video };
}

/**
 * The audio rendition of a master playlist (EXT-X-MEDIA TYPE=AUDIO, the
 * DEFAULT=YES one if there are several), or null when audio is muxed.
 */
export function pickAudio(text, baseUrl) {
  const tracks = text.split(/\r?\n/)
    .filter((l) => l.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(l))
    .map((l) => ({ uri: (l.match(/URI="([^"]+)"/) || [])[1], dflt: /DEFAULT=YES/.test(l) }))
    .filter((t) => t.uri);
  const t = tracks.find((x) => x.dflt) || tracks[0];
  return t ? new URL(t.uri, baseUrl).toString() : null;
}

export function pickVariant(text, baseUrl, variant = 'lowest') {
  const lines = text.split(/\r?\n/);
  const renditions = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = Number((lines[i].match(/[:,]BANDWIDTH=(\d+)/) || [])[1]) || 0;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri) renditions.push({ bw, url: new URL(uri.trim(), baseUrl).toString() });
  }
  if (!renditions.length) return baseUrl;
  renditions.sort((a, b) => a.bw - b.bw);
  return (variant === 'highest' ? renditions.at(-1) : renditions[0]).url;
}

// --- Persistence -------------------------------------------------------------

function recordOpen(ev, onAir) {
  const r = db.prepare(`
    INSERT INTO SignalEvent (source_id, source_name, kind, started_at, alerted_at, on_air)
    VALUES (?, ?, ?, ?, ?, ?)`).run(ev.source.id, ev.source.name, ev.kind,
    ev.incident.startedAt, ev.incident.alertedAt, onAir);
  ev.incident.eventId = Number(r.lastInsertRowid);
}

function recordClose(ev) {
  if (!ev.incident.eventId) return;
  db.prepare('UPDATE SignalEvent SET ended_at = ?, note = COALESCE(?, note) WHERE id = ?')
    .run(nowIso(ev.at), ev.note, ev.incident.eventId);
}

function recordResync(inc, text) {
  if (inc.eventId) db.prepare('UPDATE SignalEvent SET resync = ? WHERE id = ?').run(text, inc.eventId);
}

function recordMail(ids, error) {
  const st = db.prepare('UPDATE SignalEvent SET emailed = emailed + ?, email_error = ? WHERE id = ?');
  for (const id of ids) if (id) st.run(error ? 0 : 1, error, id);
}

export function recentEvents(limit = 50) {
  return db.prepare('SELECT * FROM SignalEvent ORDER BY id DESC LIMIT ?').all(limit);
}

// --- What is on air ----------------------------------------------------------

/** "Name — /path" of the clip OTAV says is playing, or null. Never throws. */
async function onAirFor(channelId) {
  if (!channelId) return null;
  try {
    const channel = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(channelId);
    if (!channel?.api_ip) return null;
    const client = new OtavClient(channel);
    await client.authorize();
    const item = await client.currentItem();
    if (!item) return null;
    const name = item.name || item.clip_name || '';
    const url = item.url || item.file_path || item.path || '';
    return [name, url].filter(Boolean).join(' — ') || null;
  } catch (err) {
    return `(could not ask OTAV: ${err.message})`;
  }
}

// --- Resync before alerting ---------------------------------------------------

const withTimeout = (p, ms, fallback) => Promise.race([
  p, new Promise((resolve) => { setTimeout(() => resolve(fallback), ms).unref?.(); }),
]);

const lastResyncAt = new Map();   // channelId -> ms of the last resync this monitor sent
const heldTimers = new Set();

/**
 * Should this incident get a resync first? Returns { try: true } or
 * { try: false, why } — `why` is null when resync simply doesn't apply (no
 * channel, feed down, feature off) and a sentence when it was skipped on purpose.
 */
export function resyncPlan(ev, cfg, now = Date.now()) {
  if (!cfg.resync.enabled || !ev.source.channelId) return { try: false, why: null };
  if (ev.kind !== 'black' && ev.kind !== 'frozen') return { try: false, why: null };
  const last = lastResyncAt.get(ev.source.channelId);
  if (last && now - last < cfg.resync.cooldownMinutes * 60_000) {
    return { try: false, why: `no resync: one was already sent at ${localTime(nowIso(last))}` };
  }
  return { try: true };
}

async function resyncChannel(channelId) {
  const channel = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(channelId);
  if (!channel?.api_ip) throw new Error('the channel has no OTAV address');
  const client = new OtavClient(channel);
  await client.authorize();
  try {
    await client.resynchronize();
  } catch (err) {
    if (err.status === 403) {
      throw new Error('OTAV refused: the API user needs access level 3 (control playback)');
    }
    throw err;
  }
}

/** Resync, then hold the alert until the public feed has had time to show the result. */
async function resyncThenDecide(ev, cfg) {
  const inc = ev.incident;
  inc.held = true;
  lastResyncAt.set(ev.source.channelId, Date.now());
  const at = localTime(new Date().toISOString());
  try {
    // OtavClient bounds each request at 10s; no extra timeout needed here.
    await resyncChannel(ev.source.channelId);
  } catch (err) {
    inc.held = false;
    inc.resync = `resync failed at ${at}: ${err.message}`;
    recordResync(inc, inc.resync);
    L.warn(`${ev.source.name}: ${inc.resync}`);
    // The picture may have come back on its own while OTAV was being asked;
    // an alert for an incident already over would be a false alarm.
    return inc.closed ? undefined : alertNow(ev);
  }
  inc.resync = `OTAV resync sent at ${at}`;
  recordResync(inc, inc.resync);
  L.warn(`${ev.source.name}: ${KIND_LABEL[ev.kind]} — ${inc.resync}, waiting ${cfg.resync.waitSeconds}s before alerting`);
  const timer = setTimeout(() => {
    heldTimers.delete(timer);
    if (!inc.held || inc.closed) return;
    inc.held = false;
    inc.resync = `${inc.resync} — the picture did not come back within ${cfg.resync.waitSeconds}s`;
    recordResync(inc, inc.resync);
    alertNow(ev);
  }, cfg.resync.waitSeconds * 1000);
  timer.unref?.();
  heldTimers.add(timer);
  return undefined;
}

async function alertNow(ev) {
  ev.onAir = await withTimeout(onAirFor(ev.source.channelId), 8_000, '(OTAV did not answer in time)');
  if (ev.onAir) {
    db.prepare('UPDATE SignalEvent SET on_air = ? WHERE id = ?').run(ev.onAir, ev.incident.eventId);
  }
  L.warn(describeEvent(ev) + (ev.onAir ? ` · on air: ${ev.onAir}` : ''));
  enqueueMail(ev);
}

// --- E-mail ------------------------------------------------------------------

const KIND_LABEL = { black: 'BLACK', frozen: 'FROZEN', down: 'NO SIGNAL', silent: 'SILENT' };

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
}

const localTime = (iso) => new Date(iso).toLocaleString('en-GB', { hour12: false });
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** One line per event, used for both the text and the HTML body. Pure. */
export function describeEvent(ev) {
  const label = KIND_LABEL[ev.kind] || ev.kind.toUpperCase();
  const since = localTime(ev.incident.startedAt);
  const lasted = formatDuration(ev.at - Date.parse(ev.incident.startedAt));
  const detail = ev.incident.detail ? ` (${ev.incident.detail})` : '';
  if (ev.type === 'open') return `${ev.source.name}: ${label} since ${since}${detail}`;
  if (ev.type === 'remind') return `${ev.source.name}: STILL ${label} — ${lasted} so far (since ${since})`;
  if (ev.fixed) return `${ev.source.name}: was ${label.toLowerCase()} for ${lasted} — fixed by an automatic OTAV resync`;
  return `${ev.source.name}: back to normal — was ${label.toLowerCase()} for ${lasted}`
    + (ev.note ? ` (${ev.note})` : '');
}

export function composeMail(events) {
  const bad = events.filter((e) => e.type !== 'close');
  const tag = bad.length ? 'ALERT' : 'RECOVERED';
  const subject = events.length === 1
    ? `[Signal ${tag}] ${describeEvent(events[0]).split(' since ')[0]}`
    : `[Signal ${tag}] ${events.length} changes: ${[...new Set(events.map((e) => e.source.name))].join(', ')}`;
  const rows = events.map((e) => ({
    line: describeEvent(e), onAir: e.onAir, url: e.source.url, type: e.type,
    resync: e.type !== 'close' ? e.incident.resync || e.resyncSkipped || null : null,
  }));
  const text = [
    ...rows.map((r) => [`• ${r.line}`, r.resync ? `  ${r.resync}` : null,
      r.onAir ? `  On air: ${r.onAir}` : null, `  Feed: ${r.url}`]
      .filter(Boolean).join('\n')),
    '',
    `Sent by the OTAV automator signal monitor at ${localTime(new Date().toISOString())}.`,
  ].join('\n');
  const color = { open: '#dc2626', remind: '#d97706', close: '#16a34a' };
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px">
${rows.map((r) => `<p style="margin:0 0 12px;padding:8px 12px;border-left:4px solid ${color[r.type]}">
<strong>${escapeHtml(r.line)}</strong>${r.resync ? `<br>${escapeHtml(r.resync)}` : ''}${r.onAir ? `<br>On air: ${escapeHtml(r.onAir)}` : ''}
<br><span style="color:#666;font-size:12px">${escapeHtml(r.url)}</span></p>`).join('\n')}
<p style="color:#888;font-size:12px">Sent by the OTAV automator signal monitor.</p></div>`;
  return { subject, text, html };
}

let outbox = [];
let outboxTimer = null;

function enqueueMail(ev) {
  outbox.push(ev);
  if (outboxTimer) return;
  const wait = monitorConfig().batchSeconds * 1000;
  outboxTimer = setTimeout(flushMail, wait);
  outboxTimer.unref?.();
}

export async function flushMail() {
  clearTimeout(outboxTimer);
  outboxTimer = null;
  // In the order things happened: an 'open' is queued only after OTAV has been
  // asked what is on air, so it can land behind a later 'close'.
  const ORDER = { open: 0, remind: 1, close: 2 };
  const events = outbox.sort((a, b) => a.at - b.at || ORDER[a.type] - ORDER[b.type]);
  outbox = [];
  if (!events.length) return null;
  const ids = events.map((e) => e.incident.eventId);
  const problem = emailProblem();
  if (problem) {
    L.warn(`${events.length} alert(s) not e-mailed: ${problem}`);
    recordMail(ids, problem);
    return { sent: false, error: problem };
  }
  try {
    await sendMail(composeMail(events));
    L.info(`e-mailed ${events.length} alert(s) to ${emailConfig().recipients.length} recipient(s)`);
    recordMail(ids, null);
    return { sent: true };
  } catch (err) {
    L.error(`alert e-mail failed: ${err.message}`);
    recordMail(ids, err.message);
    return { sent: false, error: err.message };
  }
}

async function handleEvent(ev) {
  const inc = ev.incident;
  try {
    if (ev.type === 'open') {
      // The row first, synchronously: a close that arrives while OTAV is still
      // being asked anything must find it.
      recordOpen(ev, null);
      const cfg = monitorConfig();
      const plan = resyncPlan(ev, cfg);
      if (plan.try) return await resyncThenDecide(ev, cfg);
      if (plan.why) { ev.resyncSkipped = plan.why; recordResync(inc, plan.why); }
      return await alertNow(ev);
    }
    if (ev.type === 'close') {
      inc.closed = true;
      if (inc.held) {
        // Closed inside the resync window. Fixed — unless it only "closed"
        // because the feed went down, in which case the down alert speaks.
        inc.held = false;
        const fixed = !ev.note;
        if (fixed) {
          ev.note = 'fixed by OTAV resync';
          ev.fixed = true;
        }
        recordClose(ev);
        L.info(describeEvent(ev));
        if (fixed && monitorConfig().resync.emailWhenFixed) enqueueMail(ev);
        return undefined;
      }
      recordClose(ev);
      L.info(describeEvent(ev));
      return enqueueMail(ev);
    }
    // A reminder for an alert nobody has been sent yet is noise.
    if (inc.held) return undefined;
    L.warn(describeEvent(ev));
    return enqueueMail(ev);
  } catch (err) {
    L.error(`could not handle ${ev.type} ${ev.kind} for ${ev.source.name}`, err);
    return undefined;
  }
}

// --- ffmpeg per feed -----------------------------------------------------------

const ffmpegPath = () => process.env.FFMPEG_PATH || loadConfig().ffmpegPath || 'ffmpeg';
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

export function ffmpegArgs(url, cfg) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-rw_timeout', '15000000',
    '-i', url,
    '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', `fps=${cfg.sampleFps},scale=${FRAME_W}:${FRAME_H}:flags=area,format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
  ];
}

export function ffmpegAudioArgs(url) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-rw_timeout', '15000000',
    '-i', url,
    '-map', '0:a:0', '-vn', '-sn', '-dn',
    '-ac', '1', '-ar', String(AUDIO_RATE),
    '-f', 's16le', 'pipe:1',
  ];
}

// Every ffmpeg alive right now. They are not detached, but a child does not
// die with its parent either: on a clean exit they are killed here; after a
// hard crash each one dies on its own at its next write into the broken pipe.
const children = new Set();
process.on('exit', () => { for (const c of children) c.kill('SIGKILL'); });

// The two readers of a feed differ only in what they ask ffmpeg for, how big
// one unit of output is, and where a problem is reported.
const TRACKS = {
  video: {
    args: (url, cfg) => ffmpegArgs(url, cfg),
    unit: FRAME_BYTES,
    feed: (watch, buf) => watch.onFrame(buf),
    setError: (watch, msg) => { watch.error = msg; },
    what: 'picture',
  },
  audio: {
    args: (url) => ffmpegAudioArgs(url),
    unit: AUDIO_WINDOW_BYTES,
    feed: (watch, buf) => watch.onAudioSecond(audioLevelDb(buf)),
    setError: (watch, msg) => { watch.audioError = msg; },
    what: 'audio',
  },
};

/** Run one ffmpeg until it exits (or stalls, or the monitor stops). */
function runOnce(watch, url, cfg, signal, track) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), track.args(url, cfg), { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let pending = Buffer.alloc(0);
    let lastData = Date.now();
    const stderr = [];

    child.stdout.on('data', (chunk) => {
      lastData = Date.now();
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= track.unit) {
        track.feed(watch, pending.subarray(0, track.unit));
        pending = pending.subarray(track.unit);
      }
    });
    child.stderr.on('data', (d) => {
      for (const line of String(d).split('\n')) if (line.trim()) stderr.push(line.trim());
      if (stderr.length > 10) stderr.splice(0, stderr.length - 10);
    });

    // A live HLS reader can hang without exiting: segments stop coming and
    // ffmpeg waits politely forever. No bytes for a while = start over.
    const stall = setInterval(() => {
      if ((Date.now() - lastData) / 1000 >= cfg.down.stallRestartSeconds) {
        track.setError(watch, `no ${track.what} for ${cfg.down.stallRestartSeconds}s — reconnecting`);
        child.kill('SIGKILL');
      }
    }, 1000);
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      track.setError(watch, err.code === 'ENOENT'
        ? `ffmpeg not found at "${ffmpegPath()}" — install it (brew install ffmpeg) or set ffmpegPath`
        : err.message);
    });
    child.on('close', (code) => {
      children.delete(child);
      clearInterval(stall);
      signal.removeEventListener('abort', onAbort);
      if (!signal.aborted && code !== 0 && stderr.length) track.setError(watch, stderr.at(-1));
      resolve(code);
    });
  });
}

async function runTrack(watch, cfg, signal, kind) {
  const track = TRACKS[kind];
  let backoff = 5_000;
  while (!signal.aborted) {
    const started = Date.now();
    try {
      const { video, audio } = await resolveFeed(watch.source.url, cfg.variant);
      watch.variantUrl = video;
      watch.audioUrl = audio;
      await runOnce(watch, kind === 'video' ? video : audio, cfg, signal, track);
    } catch (err) {
      track.setError(watch, `could not open the feed: ${err.cause?.code || err.message}`);
    }
    if (signal.aborted) break;
    // A run that lasted a while was a healthy feed that dropped: retry soon.
    backoff = Date.now() - started > 60_000 ? 5_000 : Math.min(60_000, backoff * 2);
    await sleep(backoff, signal);
  }
}

// --- Lifecycle -----------------------------------------------------------------

let running = null;   // { controller, watches: Map, ticker, startedAt }

export function isMonitorRunning() { return !!running; }

export function startMonitor() {
  if (running) return;
  const cfg = monitorConfig();
  if (!cfg.enabled) {
    L.info('signal monitor is off (monitor.enabled in config.json)');
    return;
  }
  // An incident open when the app last stopped can't be closed with an honest
  // end time any more; close it as of now and say why.
  db.prepare(`UPDATE SignalEvent SET ended_at = ?, note = 'monitor restarted'
              WHERE ended_at IS NULL`).run(new Date().toISOString());

  const controller = new AbortController();
  const watches = new Map();
  for (const source of cfg.sources) {
    const watch = new FeedWatch(source, cfg, handleEvent);
    watches.set(source.id, watch);
    if (source.enabled && source.url) {
      runTrack(watch, cfg, controller.signal, 'video');
      if (cfg.silence.enabled) runTrack(watch, cfg, controller.signal, 'audio');
    }
  }
  const ticker = setInterval(() => {
    for (const w of watches.values()) if (w.source.enabled) w.tick();
  }, 1000);
  ticker.unref?.();
  running = { controller, watches, ticker, startedAt: new Date().toISOString() };
  L.info(`signal monitor watching ${cfg.sources.filter((s) => s.enabled).length} feed(s)`);
}

export function stopMonitor() {
  if (!running) return;
  running.controller.abort();
  clearInterval(running.ticker);
  for (const t of heldTimers) clearTimeout(t);
  heldTimers.clear();
  running = null;
  L.info('signal monitor stopped');
}

export function restartMonitor() {
  stopMonitor();
  startMonitor();
}

export function monitorStatus() {
  const cfg = monitorConfig();
  const live = running?.watches;
  return {
    enabled: cfg.enabled,
    running: !!running,
    startedAt: running?.startedAt || null,
    frame: { width: FRAME_W, height: FRAME_H },
    sources: cfg.sources.map((s) => (live?.get(s.id)?.snapshot()
      || { ...s, state: s.enabled ? (cfg.enabled ? 'starting' : 'off') : 'disabled' })),
    email: { problem: emailProblem(), recipients: emailConfig().recipients.length },
  };
}

/** Persist a new monitor section (already validated) and apply it. */
export function saveMonitorConfig(next) {
  updateConfig((c) => { c.monitor = { ...(c.monitor || {}), ...next }; });
  restartMonitor();
  return monitorConfig();
}
