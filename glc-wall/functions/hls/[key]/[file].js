// HTTPS proxy for the GLC HLS feeds.
//
// live.dreamtv.gy only answers on plain http (nothing listens on 443), and a page
// served by Cloudflare Pages is https — the browser blocks an http playlist or
// segment there as mixed content. So the wall asks /hls/<key>/<file> on its own
// origin and this function fetches it upstream.
//
// It is NOT an open proxy: only the seven channel keys and HLS file names pass.
// Playlists use relative URIs, so segments come back through here too.

const UPSTREAM = 'http://live.dreamtv.gy/live/c2eds';

const KEYS = new Set([
  'GuyanaLearning', 'GLCjr', 'GLCElementary', 'GLCTeenED',
  'GLCEleVate', 'GLCDiscover', 'GLCAhWeTV',
]);

const FILE = /^[A-Za-z0-9_=.\-]+\.(m3u8|ts|aac|m4s|mp4)$/;

const TYPES = {
  m3u8: 'application/vnd.apple.mpegurl',
  ts: 'video/mp2t',
  aac: 'audio/aac',
  m4s: 'video/iso.segment',
  mp4: 'video/mp4',
};

export async function onRequestGet({ params }) {
  const { key, file } = params;
  if (!KEYS.has(key) || !FILE.test(file)) {
    return new Response('Not found', { status: 404 });
  }
  const ext = file.split('.').pop();
  const isPlaylist = ext === 'm3u8';

  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/${key}/HLS/${file}`, {
      redirect: 'follow',
      // A live playlist changes every segment; a segment never changes, so viewers
      // share one edge copy instead of each pulling it from Guyana.
      cf: isPlaylist
        ? { cacheTtl: 1, cacheEverything: true }
        : { cacheTtl: 120, cacheEverything: true },
    });
  } catch (err) {
    return new Response(`Upstream unreachable: ${err.message}`, { status: 502 });
  }

  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': TYPES[ext],
      'Cache-Control': isPlaylist ? 'no-cache, no-store' : 'public, max-age=120',
      'X-Robots-Tag': 'noindex, nofollow, noarchive',
    },
  });
}
