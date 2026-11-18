// GLC mosaic — the seven public GLC feeds composed into ONE 1920x1080 HLS stream,
// so a TV that cannot decode seven videos at once plays a single one.
//
// Runs on the WinLGX PC (Intel HD 530: h264_qsv); see README.md. No npm dependencies:
//   node mosaic.mjs           (ffmpeg in ./bin, or set FFMPEG)
// Serves http://<host>:8088/mosaic.m3u8 + /status.json (CORS *), read by /playout.
//
// One ffmpeg per feed decodes the 720x480 rendition into 640x360 raw frames; this
// process keeps each feed's latest frame and paints the 3x3 grid at a fixed 30 fps
// into one encoder. A dead feed only blanks its own tile (the wall's NO SIGNAL card
// comes from status.json), never the whole mosaic — which is why the feeds are not
// simply xstack inputs of one ffmpeg.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const exe = process.platform === 'win32' ? '.exe' : '';
const FFMPEG = process.env.FFMPEG || (existsSync(join(HERE, 'bin', `ffmpeg${exe}`)) ? join(HERE, 'bin', `ffmpeg${exe}`) : 'ffmpeg');
const PORT = Number(process.env.PORT || 8088);
const OUT = join(HERE, 'out');
const LOG = join(HERE, 'mosaic.log');
const ENCODER = process.env.ENCODER || 'h264_qsv';   // libx264 where there is no Quick Sync
const BITRATE = process.env.BITRATE || '6M';

const CHANNELS = [   // same order as the wall (glc-wall/public/index.html)
  { key: 'GuyanaLearning', name: 'Guyana Learning Channel' },
  { key: 'GLCjr', name: 'GLC Junior' },
  { key: 'GLCElementary', name: 'GLC Elementary' },
  { key: 'GLCTeenED', name: 'GLC TeenEd' },
  { key: 'GLCEleVate', name: 'GLC Elevate' },
  { key: 'GLCDiscover', name: 'GLC Discover' },
  { key: 'GLCAhWeTV', name: 'MoE Central' },
];
const masterUrl = (key) => `http://live.dreamtv.gy/live/c2eds/${key}/HLS/${key}.m3u8`;

const W = 1920, H = 1080, COLS = 3, TW = 640, TH = 360, FPS = 30;
const TILE_BYTES = TW * TH * 3 / 2;
const FRAME_BYTES = W * H * 3 / 2;
const STALE_MS = 6000;        // no frame this long = tile blanked, state "down"
const RESTART_MS = 30000;     // no frame this long = reader killed and restarted

// ---- log (rotates at 5 MB, keeps one) ----
function log(...a) {
  const line = `${new Date().toISOString()} ${a.join(' ')}\n`;
  try {
    if (existsSync(LOG) && statSync(LOG).size > 5e6) renameSync(LOG, `${LOG}.1`);
    appendFileSync(LOG, line);
  } catch { /* logging must never stop the mosaic */ }
  process.stdout.write(line);
}

// ---- canvas: 4:2:0 planar, black, the info area (bottom right) a dark panel ----
const frame = Buffer.alloc(FRAME_BYTES);
const Y0 = 0, U0 = W * H, V0 = U0 + (W / 2) * (H / 2);
function fillRect(x, y, w, h, yv, uv = 128, vv = 128) {
  for (let r = 0; r < h; r++) frame.fill(yv, Y0 + (y + r) * W + x, Y0 + (y + r) * W + x + w);
  for (let r = 0; r < h / 2; r++) {
    const o = (y / 2 + r) * (W / 2) + x / 2;
    frame.fill(uv, U0 + o, U0 + o + w / 2);
    frame.fill(vv, V0 + o, V0 + o + w / 2);
  }
}
fillRect(0, 0, W, H, 16);
fillRect(TW, 2 * TH, 2 * TW, TH, 18);
const tilePos = (i) => ({ x: (i % COLS) * TW, y: Math.floor(i / COLS) * TH });
function blitTile(i, src) {
  const { x, y } = tilePos(i);
  for (let r = 0; r < TH; r++) src.copy(frame, Y0 + (y + r) * W + x, r * TW, (r + 1) * TW);
  const cw = TW / 2, ch = TH / 2, uOff = TW * TH, vOff = uOff + cw * ch;
  for (let r = 0; r < ch; r++) {
    const o = (y / 2 + r) * (W / 2) + x / 2;
    src.copy(frame, U0 + o, uOff + r * cw, uOff + (r + 1) * cw);
    src.copy(frame, V0 + o, vOff + r * cw, vOff + (r + 1) * cw);
  }
}

// ---- feed readers ----
// The 720x480 rendition (SAR 40:33, i.e. 16:9-ish) is plenty for a 640x360 tile and is
// a third of the 1080p bitrate; the lowest one (480x320) looks soft on a TV.
async function pickVariant(key) {
  const url = masterUrl(key);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^#EXT-X-STREAM-INF:.*RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
      if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) {
        variants.push({ w: +m[1], h: +m[2], url: new URL(lines[i + 1], res.url).href });
      }
    }
    variants.sort((a, b) => a.h - b.h);
    const v = variants.find((x) => x.h >= TH) || variants[variants.length - 1];
    if (v) return v.url;
  } catch (e) {
    log(`[${key}] master playlist: ${e.message}`);
  }
  return url;
}

const feeds = CHANNELS.map((ch, i) => ({
  ...ch, i, proc: null, lastFrameAt: 0, frames: 0, restarts: 0, error: null,
  pending: [], pendingBytes: 0, startedAt: 0, timer: null,
}));

async function startFeed(f) {
  const url = await pickVariant(f.key);
  f.startedAt = Date.now();
  f.pending = []; f.pendingBytes = 0;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-live_start_index', '-1', '-re',
    '-i', url,
    '-an', '-sn',
    '-vf', `scale=iw*sar:ih,setsar=1,scale=${TW}:${TH}:force_original_aspect_ratio=increase,crop=${TW}:${TH},fps=${FPS}`,
    '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1',
  ];
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  f.proc = p;
  p.stdout.on('data', (chunk) => {
    f.pending.push(chunk); f.pendingBytes += chunk.length;
    if (f.pendingBytes < TILE_BYTES) return;
    const all = Buffer.concat(f.pending, f.pendingBytes);
    const whole = Math.floor(all.length / TILE_BYTES);
    blitTile(f.i, all.subarray((whole - 1) * TILE_BYTES, whole * TILE_BYTES));   // newest frame only
    const rest = all.subarray(whole * TILE_BYTES);
    f.pending = rest.length ? [Buffer.from(rest)] : []; f.pendingBytes = rest.length;
    f.lastFrameAt = Date.now(); f.frames += whole; f.error = null;
  });
  p.stderr.on('data', (d) => { f.error = String(d).trim().split('\n').pop().slice(0, 200); });
  p.on('exit', (code) => {
    if (f.proc !== p) return;
    f.proc = null;
    log(`[${f.key}] reader exited (${code})${f.error ? `: ${f.error}` : ''}`);
    scheduleRestart(f);
  });
  log(`[${f.key}] reading ${url}`);
}

function scheduleRestart(f) {
  clearTimeout(f.timer);
  const wait = Math.min(30000, 2000 * 2 ** Math.min(f.restarts++, 4));
  f.timer = setTimeout(() => startFeed(f), wait);
}

setInterval(() => {
  const now = Date.now();
  for (const f of feeds) {
    const since = now - Math.max(f.lastFrameAt, f.startedAt);
    if (f.lastFrameAt && now - f.lastFrameAt > STALE_MS && !f.blanked) {
      const { x, y } = tilePos(f.i); fillRect(x, y, TW, TH, 16); f.blanked = true;
    }
    if (now - f.lastFrameAt < STALE_MS) { f.blanked = false; f.restarts = 0; }
    if (f.proc && since > RESTART_MS) {
      log(`[${f.key}] no frames for ${Math.round(since / 1000)} s, restarting`);
      const p = f.proc; f.proc = null; p.kill('SIGKILL'); scheduleRestart(f);
    }
  }
}, 1000);

// ---- encoder: fixed 30 fps (frames are counted, so a slow tick is caught up) ----
let enc = null, encStartedAt = 0, framesSent = 0, encRestarts = 0, encError = null;
function startEncoder() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const venc = ENCODER === 'libx264'
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency']
    : ['-c:v', ENCODER, '-preset', 'veryfast'];
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
    ...venc, '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', '12M',
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-bf', '0',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+independent_segments+temp_file',
    '-hls_segment_filename', join(OUT, 'seg%06d.ts'),
    join(OUT, 'mosaic.m3u8'),
  ];
  const p = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  enc = p; encStartedAt = Date.now(); framesSent = 0;
  p.stdin.on('error', () => {});
  p.stderr.on('data', (d) => { encError = String(d).trim().split('\n').pop().slice(0, 200); });
  p.on('exit', (code) => {
    if (enc !== p) return;
    enc = null;
    log(`[encoder] exited (${code})${encError ? `: ${encError}` : ''}`);
    setTimeout(startEncoder, Math.min(30000, 2000 * 2 ** Math.min(encRestarts++, 4)));
  });
  log(`[encoder] ${ENCODER} ${BITRATE} -> ${OUT}`);
}

let behindLogged = 0;
setInterval(() => {
  if (!enc) return;
  const due = Math.floor((Date.now() - encStartedAt) * FPS / 1000);
  if (due - framesSent > FPS * 5) {   // more than 5 s behind: skip ahead, don't burst
    if (Date.now() - behindLogged > 60000) { log(`[encoder] ${due - framesSent} frames behind, skipping`); behindLogged = Date.now(); }
    framesSent = due - 1;
  }
  while (framesSent < due) {
    if (enc.stdin.writableLength > FRAME_BYTES * 4) break;   // encoder is slow: let it drain
    enc.stdin.write(Buffer.from(frame));
    framesSent++;
  }
  if (framesSent >= FPS * 600) encRestarts = 0;
}, 1000 / FPS / 2);

// ---- http: the HLS output + status ----
const TYPES = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.json': 'application/json' };
function status() {
  const now = Date.now();
  return {
    ok: !!enc,
    encoder: ENCODER,
    uptimeSeconds: Math.round(process.uptime()),
    feeds: feeds.map((f) => ({
      key: f.key, name: f.name,
      state: f.lastFrameAt && now - f.lastFrameAt < STALE_MS ? 'live' : f.lastFrameAt ? 'down' : 'loading',
      lastFrameAgo: f.lastFrameAt ? Math.round((now - f.lastFrameAt) / 1000) : null,
      error: f.error,
    })),
  };
}
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/status.json') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(status()));
  }
  const name = path.replace(/^\/+/, '');
  if (!/^(mosaic\.m3u8|seg\d+\.ts)$/.test(name)) {
    res.statusCode = 404;
    return res.end('GLC mosaic: /mosaic.m3u8, /status.json\n');
  }
  try {
    const body = readFileSync(join(OUT, name));
    res.setHeader('Content-Type', TYPES[extname(name)]);
    res.setHeader('Cache-Control', name.endsWith('.m3u8') ? 'no-cache' : 'max-age=60');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end();
  }
}).listen(PORT, () => log(`[http] listening on :${PORT}`));

// ---- go ----
for (const f of feeds) startFeed(f);
startEncoder();
const shutdown = () => {
  for (const f of feeds) f.proc?.kill('SIGKILL');
  enc?.kill('SIGKILL');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
