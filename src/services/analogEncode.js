// The analog channel's copies: the UltraNEXUS-HD plays nothing above
// analog.maxBitrateKbps (4 Mb/s, video + audio together), while the share holds
// the house masters (CRF 18, PCM audio — 8–20 Mb/s) that the six OTAV channels
// air. So the cap is applied to the DEVICE copy only, at upload time: a master
// over the cap is encoded to a capped H.264 + AAC file in analog.encodeDir, that
// file is what goes to Vol1, and the master is never touched. Decided with the
// operator on 2026-10-10 (1920x1080 kept; the cap covers audio too).
//
// Constant bitrate with a one-second VBV (-maxrate = -bufsize = -b:v) is what
// makes it a CAP and not an average: a CRF or plain -b:v encode can peak well
// above its mean on a cut or a pan, and peaks are what a player that "only
// takes 4 Mb/s" chokes on. Video gets 95% of the cap minus the audio, leaving
// room for the container.

import { mkdir, stat, unlink } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { probeFormat, runFfmpeg } from './transcode.js';

/** Average bitrate in kb/s of `bytes` over `seconds`, or null when unknown. */
export function kbpsOf(bytes, seconds) {
  if (!(bytes > 0) || !(seconds > 0)) return null;
  return Math.round((bytes * 8) / seconds / 1000);
}

/** Video kb/s for a total cap: 95% of it, less the audio. */
export function videoKbpsFor(cfg) {
  return Math.max(500, Math.floor(cfg.maxBitrateKbps * 0.95) - cfg.audioKbps);
}

/**
 * Container of the device copy: a .mov master stays .mov (it already plays on
 * the device that way), anything else becomes .mp4 — an MPEG-PS .mpg can't
 * carry H.264 + AAC.
 */
export const encodedExt = (filePath) => (extname(filePath).toLowerCase() === '.mov' ? '.mov' : '.mp4');

export function deviceEncodeArgs(inPath, outPath, cfg, { hasAudio = true } = {}) {
  const v = videoKbpsFor(cfg);
  const { width: w, height: h } = cfg;
  return [
    '-hide_banner', '-nostdin', '-y', '-i', inPath,
    '-map', '0:v:0', ...(hasAudio ? ['-map', '0:a:0'] : []),
    '-vf', `yadif=deint=1,scale=${w}:${h}:force_original_aspect_ratio=decrease,`
      + `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${cfg.fps}`,
    '-c:v', 'libx264', '-preset', cfg.preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-b:v', `${v}k`, '-maxrate', `${v}k`, '-bufsize', `${v}k`,
    '-bf', '0', '-g', '60', '-keyint_min', '1', '-sc_threshold', '0',
    ...(hasAudio
      ? ['-c:a', cfg.audioCodec, '-b:a', `${cfg.audioKbps}k`, '-ar', '48000', '-ac', '2',
        '-af', 'aresample=async=1:first_pts=0']
      : ['-an']),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    outPath,
  ];
}

/**
 * Encode `localPath` to a capped copy in cfg.encodeDir and verify it: the same
 * length (±2s) and an average under the cap. Resolves { path, size, kbps }; the
 * caller uploads it and deletes it. `signal` kills ffmpeg.
 */
export async function encodeForDevice(localPath, cfg, { duration = null, signal, onProgress } = {}) {
  const fmt = await probeFormat(localPath);
  if (!fmt) throw new Error(`ffprobe cannot read ${localPath}`);
  const length = fmt.duration || duration;
  await mkdir(cfg.encodeDir, { recursive: true });
  const out = join(cfg.encodeDir, `${basename(localPath, extname(localPath))}.analog${encodedExt(localPath)}`);
  let child = null;
  const kill = () => { try { child?.kill('SIGKILL'); } catch { /* gone */ } };
  signal?.addEventListener('abort', kill, { once: true });
  try {
    await runFfmpeg(deviceEncodeArgs(localPath, out, cfg, { hasAudio: !!fmt.acodec }), {
      duration: length, onProgress, register: (c) => { child = c; },
    });
    if (signal?.aborted) throw Object.assign(new Error('conversion cancelled'), { cancelled: true });
    const got = await probeFormat(out);
    if (!got?.duration) throw new Error('the converted copy cannot be read back');
    if (length && Math.abs(got.duration - length) > 2) {
      throw new Error(`the converted copy runs ${got.duration.toFixed(1)}s, the master ${length.toFixed(1)}s`);
    }
    const { size } = await stat(out);
    const kbps = kbpsOf(size, got.duration);
    if (kbps > cfg.maxBitrateKbps) throw new Error(`the converted copy is ${kbps} kb/s, over the ${cfg.maxBitrateKbps} kb/s cap`);
    return { path: out, size, kbps };
  } catch (err) {
    await unlink(out).catch(() => {});
    if (signal?.aborted) throw Object.assign(new Error('conversion cancelled'), { cancelled: true });
    throw err;
  } finally {
    signal?.removeEventListener('abort', kill);
  }
}
