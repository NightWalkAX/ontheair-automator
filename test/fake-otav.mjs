// Fake Softron OnTheAir Video REST server for tests. Implements just the
// endpoints the integrator uses, per the real contract, and records what was
// pushed so the test can assert on it. Playlists are modelled by name: GET on
// an unknown one 404s (as the real server does), POST /playlists/{NAME} creates
// it — which is how the integrator gets one playlist per broadcast day.

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

export function startFakeOtav({
  requireAuth = false,
  canCreatePlaylists = true,   // false = scheduler isn't folder-based (real 422)
  scheduled = [],
  scheduleFile = null,        // event schedule JSON on disk, like the real Macs run
  refuseClear = false,        // 422 "not editable" on DELETE, as scheduler-opened playlists do
  folderBased = false,        // playlists play a folder's contents: item lists aren't editable
  refuseLogo = false,         // instance rejects the undocumented logo properties on a clip
} = {}) {
  // playlists: name -> { unique_id, items: [] }
  // scheduled: playlist FILES the OTAV schedule points at, e.g.
  //   ['/Volumes/Playlists/Channel 1 2026-07-20.xpls'] — addressable only after
  //   GET /scheduler/playlists?path=...
  const state = {
    received: [], cleared: 0, resynced: 0, authorized: 0,
    playlists: new Map(), scheduled: [...scheduled], opened: [],
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    const token = url.searchParams.get('token');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};

      // Auth
      if (req.method === 'PUT' && path === '/authorize') {
        state.authorized++;
        return send(200, { token: 'faketoken', level: 4 });
      }
      // Everything else needs a token when auth is required.
      if (requireAuth && token !== 'faketoken') {
        return send(401, { success: false, error: 'unauthorized' });
      }

      if (req.method === 'GET' && path === '/info') {
        return send(200, { application_version: '4.2', name: 'Fake OTAV', is_player_capable: true });
      }
      // Playlists are addressed by name or unique_id (which here is
      // "<name>-uid"); resolve either form to the stored entry.
      const findPlaylist = (ref) => {
        if (state.playlists.has(ref)) return state.playlists.get(ref);
        for (const pl of state.playlists.values()) if (pl.unique_id === ref) return pl;
        return null;
      };
      const plMatch = /^\/playlists\/([^/]+)$/.exec(path);
      if (plMatch) {
        const name = decodeURIComponent(plMatch[1]);
        if (req.method === 'GET') {
          const pl = findPlaylist(name);
          if (!pl) return send(404, { success: false, error: 'No playlist matches the given unique ID or index' });
          return send(200, { unique_id: pl.unique_id, name, total_items: pl.items.length });
        }
        if (req.method === 'POST') {
          // OTAV 4.2.7 only routes the create request when a body is present;
          // without one it answers a generic HTML 404 page.
          if (!body) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            return res.end('<!doctype html><html><head><title>Error 404</title></head>'
              + '<body><h1>404 Page Not Found</h1></body></html>');
          }
          if (!canCreatePlaylists) {
            return send(422, { success: false, error: 'The schedule does not exist or is not folder-based.' });
          }
          const pl = { unique_id: `${name}-uid`, name, items: [] };
          state.playlists.set(name, pl);
          return send(201, { unique_id: pl.unique_id, name, total_items: 0 });
        }
      }
      const itemsMatch = /^\/playlists\/([^/]+)\/items$/.exec(path);
      if (itemsMatch) {
        const ref = decodeURIComponent(itemsMatch[1]);
        const pl = findPlaylist(ref);
        if (req.method === 'DELETE') {
          if (!pl) return send(404, { success: false, error: 'No playlist matches the given unique ID or index (items)' });
          if (refuseClear) return send(422, { success: false, error: 'The specified playlist is not editable.' });
          pl.items.length = 0;
          state.cleared++;
          return send(200, { success: true });
        }
        if (req.method === 'POST') {
          if (!pl) return send(404, { success: false, error: 'No playlist matches the given unique ID or index (items)' });
          if (pl.folderBased) return send(422, { success: false, error: 'The specified playlist is not editable' });
          const clip = { ...json, unique_id: `id-${state.received.length + 1}` };
          pl.items.push(clip);
          state.received.push({ ...clip, playlist: pl.name });
          return send(201, { success: true, unique_id: clip.unique_id });
        }
      }
      // A single clip, addressed by unique_id or index — used to stamp the
      // watermark after the clip is created, and to read it back.
      const itemMatch = /^\/playlists\/([^/]+)\/items\/([^/]+)$/.exec(path);
      if (itemMatch && (req.method === 'PUT' || req.method === 'GET')) {
        const pl = findPlaylist(decodeURIComponent(itemMatch[1]));
        if (!pl) return send(404, { success: false, error: 'No playlist matches the given unique ID or index' });
        const clipRef = decodeURIComponent(itemMatch[2]);
        const clip = pl.items.find((c) => c.unique_id === clipRef) ?? pl.items[Number(clipRef)];
        if (!clip) return send(404, { success: false, error: 'No clip matches the given unique ID or index' });
        if (req.method === 'GET') return send(200, clip);
        if (refuseLogo) return send(400, { success: false, error: 'Unknown property logo_filename' });
        Object.assign(clip, json);
        const mirror = state.received.find((c) => c.unique_id === clip.unique_id);
        if (mirror) Object.assign(mirror, json);
        return send(200, { success: true });
      }
      if (req.method === 'GET' && path === '/scheduler') {
        return send(200, {
          version: '2.0', is_enabled: true,
          schedule_path: scheduleFile || '/Volumes/Playlists/Schedule.xml',
        });
      }
      if (req.method === 'GET' && path === '/scheduler/playlists') {
        // OTAV only knows the playlists its schedule references — read them back
        // out of the schedule document, exactly as the real server would.
        if (scheduleFile && existsSync(scheduleFile)) {
          const doc = JSON.parse(readFileSync(scheduleFile, 'utf8'));
          state.scheduled = (doc.events || []).flatMap((e) => (e.playlists || []).map((p) => p.playlist_path));
        }
        const wanted = url.searchParams.get('path');
        if (!wanted) {
          return send(200, state.scheduled.map((p) => ({ path: p, total_items: 0, missing_items: 0 })));
        }
        if (!state.scheduled.includes(wanted)) return send(404, { success: false, error: 'playlist not in schedule' });
        const name = (wanted.split('/').pop() || '').replace(/\.xpls$/i, '');
        const pl = state.playlists.get(name)
          || { unique_id: `${name}-uid`, name, items: [], path: wanted, folderBased };
        state.playlists.set(name, pl);
        state.opened.push(wanted);
        return send(200, {
          unique_id: pl.unique_id, name, path: wanted, total_items: pl.items.length,
          is_folder_based: !!pl.folderBased,
          ...(pl.folderBased ? { folder_based_path: '/Volumes/Drive/SomeFolder' } : {}),
        });
      }
      if (req.method === 'GET' && path === '/scheduler/resynchronize') {
        state.resynced++;
        return send(200, { success: true });
      }
      return send(404, { success: false, error: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
