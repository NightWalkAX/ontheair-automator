// Fake analog-automator API (the UltraNEXUS-HD's REST front) for tests. Just
// the endpoints analogClient.js uses, shaped like the real ones
// (analog_automator/api.py), recording what the scheduler sent. The draft is
// modelled the way the real API keeps it: reset copies what is on air, a
// resource created by POST /library/resources lives in the draft until publish.

import { createServer } from 'node:http';

export function startFakeAnalog({
  key = 'test-key',
  library = [],          // [{ resource_id, title, filename, length_s, type?, folder_id? }] — on air
  disk = [],             // filenames on the device disk
  lengths = {},          // filename -> length_s the device measures once a file is added
  onAir = [],            // filenames the device's on-air schedule uses (in_schedule)
  folders = [{ folder_id: 5, name: 'Automator', path: 'Library/Automator', parent_id: null }],
  contents = {},         // filename -> Buffer, served by GET /storage/files/<name>/content
  free = 20e9,           // bytes free on Vol1
  cutAfter = {},         // filename -> bytes after which the first download is cut short
} = {}) {
  const lib = library.map((r) => ({ type: 'video', folder_id: 5, volume: 'Vol1', ...r }));
  const state = {
    device: lib.map((r) => ({ ...r })),
    draft: lib.map((r) => ({ ...r })),
    disk: new Set(disk),
    uploads: [],          // { filename, bytes }
    created: [],          // filenames added to the library
    days: {},             // weekday -> items of the last PUT
    resets: 0,
    published: [],        // publish bodies
    rollbacks: [],
    recovers: [],
    nextId: 900000,
    onAir: new Set(onAir),
    deleted: [],          // { filename, force }
    contents: { ...contents },
    downloads: [],        // { filename, offset }
    free,
    cutAfter: { ...cutAfter },
  };
  const sizeOf = (f) => state.contents[f]?.length ?? 1048576;
  const out = (r) => ({ ...r, length: `${r.length_s}s` });

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (path === '/health') return send(200, { ok: true, host: '172.20.0.15', publish_enabled: true, storage_writes_enabled: true, recovery_enabled: true, auto_recover: true });
      if (req.headers['x-api-key'] !== key) return send(401, { detail: 'API key inválida' });
      const json = () => (raw.length ? JSON.parse(raw.toString('utf8')) : {});
      const m = (re) => re.exec(path);
      let g;

      if (req.method === 'GET' && path === '/library/resources') {
        const src = url.searchParams.get('source') === 'device' ? state.device : state.draft;
        return send(200, src.map(out));
      }
      if (req.method === 'POST' && path === '/library/resources') {
        const b = json();
        if (!state.disk.has(b.filename)) return send(404, { detail: 'el equipo no reconoce ese archivo en el disco' });
        const r = { resource_id: state.nextId++, title: b.filename.replace(/\.[^.]+$/, '').slice(0, 31), filename: b.filename,
          length_s: lengths[b.filename] ?? 60, type: 'video', folder_id: b.folder_id, volume: 'Vol1' };
        state.draft.push(r);
        state.created.push(b.filename);
        return send(201, { resource_id: r.resource_id, length: `${r.length_s}s` });
      }
      if (req.method === 'GET' && path === '/library/folders') return send(200, folders);
      if (req.method === 'GET' && path === '/storage/files') {
        return send(200, [...state.disk].map((f) => ({ filename: f, size: sizeOf(f), modified: '2026-10-01 10:00',
          in_schedule: state.onAir.has(f), in_library: state.device.some((r) => r.filename === f) })));
      }
      if ((g = m(/^\/storage\/files\/([^/]+)\/content$/)) && req.method === 'GET') {
        const name = decodeURIComponent(g[1]);
        if (!state.disk.has(name)) return send(404, { detail: 'no existe' });
        const body = state.contents[name] ?? Buffer.alloc(1048576, 1);
        const range = /^bytes=(\d+)-$/.exec(req.headers.range || '');
        const offset = range ? Number(range[1]) : 0;
        state.downloads.push({ filename: name, offset });
        const tail = body.subarray(offset);
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': tail.length,
          ...(range ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}) });
        const cut = state.cutAfter[name];
        if (cut != null && cut < tail.length) {
          delete state.cutAfter[name];
          res.write(tail.subarray(0, cut));
          return setTimeout(() => res.destroy(), 20);
        }
        return res.end(tail);
      }
      if ((g = m(/^\/storage\/files\/([^/]+)$/)) && req.method === 'PUT') {
        const name = decodeURIComponent(g[1]);
        if (!/^[A-Za-z0-9._()-]+$/.test(name) || name.length > 31) return send(422, { detail: 'nombre inválido' });
        if (state.disk.has(name)) return send(409, { detail: `${name} ya existe en el disco del equipo` });
        if (Number(req.headers['content-length']) !== raw.length) return send(400, { detail: 'subida incompleta' });
        state.disk.add(name);
        state.contents[name] = raw;
        state.uploads.push({ filename: name, bytes: raw.length });
        return send(201, { uploaded: name, bytes: raw.length, duration: '00:01:00:00' });
      }
      if ((g = m(/^\/storage\/files\/([^/]+)$/)) && req.method === 'DELETE') {
        const name = decodeURIComponent(g[1]);
        const force = url.searchParams.get('force') === 'true';
        if (!state.disk.has(name)) return send(404, { detail: 'no existe' });
        if (state.onAir.has(name) && !force) return send(409, { detail: { detail: 'el archivo está en la escaleta', usage: {} } });
        state.disk.delete(name);
        state.deleted.push({ filename: name, force });
        return send(200, { deleted: name });
      }
      if (req.method === 'GET' && path === '/storage/disk') return send(200, [{ volume: 'Vol1', total: 100e9, free: state.free, mpegs: 3000, used_pct: 80 }]);
      if (req.method === 'GET' && path === '/storage/audit') return send(200, { on_disk_not_in_library: [], library_missing_on_disk: [], scheduled_missing_on_disk: [] });
      if (req.method === 'POST' && path === '/schedule/draft/reset') {
        state.resets++;
        state.draft = state.device.map((r) => ({ ...r }));
        return send(200, { events: 0, resources: state.draft.length });
      }
      if ((g = m(/^\/schedule\/draft\/days\/([a-z]{3})$/)) && req.method === 'PUT') {
        const b = json();
        for (const it of b.items) {
          if (it.resource_id && !state.draft.some((r) => r.resource_id === it.resource_id)) {
            return send(422, { detail: `recurso ${it.resource_id} no existe en la biblioteca` });
          }
        }
        state.days[g[1]] = b;
        return send(200, { day: g[1], events: b.items.map((it, i) => ({ event_id: i + 1, ...it })), warnings: [] });
      }
      if (req.method === 'GET' && path === '/schedule/draft/status') return send(200, { stale: false, today_conflicts: [] });
      if (req.method === 'GET' && path === '/schedule') {
        const day = url.searchParams.get('day');
        return send(200, { [day]: (state.days[day]?.items || []).map((it, i) => ({ event_id: i + 1, time: it.time || null, length_s: it.length_s || 0 })) });
      }
      if (req.method === 'POST' && path === '/schedule/publish') {
        const b = json();
        if (!b.confirm) return send(400, { detail: 'confirm' });
        state.published.push(b);
        state.device = state.draft.map((r) => ({ ...r }));
        return send(200, { backup: `backup-${state.published.length}.bin`, events: 10, player: 'ok' });
      }
      if (req.method === 'GET' && path === '/schedule/backups') return send(200, state.published.map((_, i) => `backup-${i + 1}.bin`).reverse());
      if ((g = m(/^\/schedule\/rollback\/(.+)$/)) && req.method === 'POST') {
        if (!json().confirm) return send(400, { detail: 'confirm' });
        state.rollbacks.push(decodeURIComponent(g[1]));
        return send(200, { restored: decodeURIComponent(g[1]) });
      }
      if (req.method === 'GET' && path === '/playback/status') return send(200, { verdict: 'ok', detail: 'playing', expected: null, source: 'web' });
      if (req.method === 'GET' && path === '/playback/live') return send(200, { player: { filename: 'Arthur_S02E201.mpg', position: '00:01:02:03' } });
      if (req.method === 'GET' && path === '/playback/asrun') return send(200, []);
      if (req.method === 'POST' && path === '/playback/recover') { state.recovers.push(json()); return send(200, { result: 'skipped', reason: 'veredicto ok' }); }
      if (req.method === 'GET' && path === '/playback/recover/log') return send(200, []);
      return send(404, { detail: `fake: no route ${req.method} ${path}` });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port }));
  });
}
