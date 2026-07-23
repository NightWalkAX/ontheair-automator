// Fake Softron OnTheAir Video REST server for tests. Implements just the
// endpoints the integrator uses, per the real contract, and records what was
// pushed so the test can assert on it.

import { createServer } from 'node:http';

export function startFakeOtav({ requireAuth = false } = {}) {
  const state = { received: [], cleared: 0, resynced: 0, authorized: 0 };

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
      if (req.method === 'DELETE' && /^\/playlists\/[^/]+\/items$/.test(path)) {
        state.cleared++;
        return send(200, { success: true });
      }
      if (req.method === 'POST' && /^\/playlists\/[^/]+\/items$/.test(path)) {
        state.received.push(json);
        return send(201, { success: true, unique_id: `id-${state.received.length}` });
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
