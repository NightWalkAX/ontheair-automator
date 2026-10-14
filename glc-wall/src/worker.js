// HTTPS proxy for the GLC HLS feeds.
//
// live.dreamtv.gy only answers on plain http (nothing listens on 443), and a page
// served by Cloudflare is https — the browser blocks an http playlist or segment
// there as mixed content. So the wall asks /hls/<key>/<file> on its own origin and
// this Worker fetches it upstream. Everything else is a static asset in public/.
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

const ROUTE = /^\/hls\/([^/]+)\/([^/]+)$/;

export default {
  async fetch(request) {
    const m = new URL(request.url).pathname.match(ROUTE);
    if (!m || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('Not found', { status: 404 });
    }
    return proxy(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
  },
};

async function proxy(key, file) {
  if (!KEYS.has(key) || !FILE.test(file)) {
    return new Response('Not found', { status: 404 });
  }
  const ext = file.split('.').pop();
  const isPlaylist = ext === 'm3u8';

  // A live playlist changes every segment; a segment never changes, so viewers
  // share one edge copy instead of each pulling it from Guyana.
  const cf = isPlaylist
    ? { cacheTtl: 1, cacheEverything: true }
    : { cacheTtl: 120, cacheEverything: true };

  let upstream;
  let url = `${UPSTREAM}/${key}/HLS/${file}`;
  try {
    // The CDN answers every request with a 302 to a bare IP (http://190.108.196.35/...),
    // and a Worker may not fetch an IP address (Cloudflare refuses it with a 403). So
    // the redirect is followed here, through <ip>.sslip.io — a DNS name that resolves
    // to that same IP; the edge server doesn't check the Host.
    for (let hop = 0; hop < 4; hop++) {
      upstream = await fetch(url, { redirect: 'manual', cf });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const loc = upstream.headers.get('Location');
      if (!loc) break;
      const next = new URL(loc, url);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(next.hostname)) next.hostname = `${next.hostname}.sslip.io`;
      url = next.toString();
    }
  } catch (err) {
    return new Response(`Upstream unreachable: ${err.message}`, {
      status: 502, headers: { 'X-Upstream-Url': url },
    });
  }

  if (!upstream.ok) {
    return new Response(`Upstream ${upstream.status}`, {
      status: upstream.status === 404 ? 404 : 502,
      headers: { 'X-Upstream-Url': url, 'X-Upstream-Status': String(upstream.status) },
    });
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
