// The MCP server (mcp/): auth, both transports, tool listing, and that tools
// go through the REST API with its refusals passed back to the model.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mcpHandler } from '../mcp/http.js';
import { createMcpServer } from '../mcp/server.js';

const TOKEN = 'secret-token';
let fakeBase, calls = [];
let pushMode = 'ok';
const servers = [];

function listen(srv) {
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => { servers.push(srv); r(`http://127.0.0.1:${srv.address().port}`); }));
}

before(async () => {
  // A stand-in for the automator's REST API.
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { calls.push(`${req.method} ${req.originalUrl}`); next(); });
  app.get('/api/channels', (req, res) => res.json([{ id: 1, name: 'Discover', playout: 'otav', is_active: 1, api_ip: '10.0.0.1', api_port: 8000, has_api_key: false }]));
  app.get('/api/blocks', (req, res) => res.json({
    week: ['2026-11-04'],
    blocks: [
      { id: 10, target_date: '2026-11-04', channel_id: 1, channel_name: 'Discover', template_name: 'Morning', start_time: '06:00', end_time: '07:00', status: 'draft', fits: true, approvable: true, durationFits: true, fillerFits: true, typeFits: true, crossFits: true },
      { id: 11, target_date: '2026-11-04', channel_id: 1, channel_name: 'Discover', template_name: 'Docs', start_time: '07:00', end_time: '10:00', status: 'draft', fits: false, approvable: false, diff: -1800, durationFits: false, fillerFits: true, typeFits: true, crossFits: true },
    ],
  }));
  app.post('/api/blocks/:id/approve', (req, res) => res.status(409).json({ error: 'block is 30:00 short and cannot be approved' }));
  app.post('/api/otav/push', async (req, res) => {
    if (pushMode === 'refuse') return res.status(409).json({ ok: false, error: '1 block(s) cannot go to air', blocks: [{ id: 11 }] });
    if (pushMode === 'slow') await new Promise((r) => setTimeout(r, 400));
    res.json({ ok: true, channels: [{ channel: 'Discover', ok: true }] });
  });
  app.get('/api/log', (req, res) => res.type('text/plain').send('line 1\nline 2'));
  fakeBase = await listen(createServer(app));
});

after(async () => { for (const s of servers) await new Promise((r) => { s.closeAllConnections?.(); s.close(r); }); });

async function mcpServer(cfg) {
  return listen(createMcpServer(() => ({ automatorUrl: fakeBase, pushWaitMs: 150, ...cfg })));
}

async function rpc(base, method, params, { token = TOKEN, id = 1 } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { status: res.status, body: res.status === 202 ? null : await res.json().catch(() => null) };
}
const toolText = (r) => r.body.result.content[0].text;

test('no token configured → 503; wrong token → 401', async () => {
  const off = await mcpServer({ token: '' });
  assert.equal((await rpc(off, 'ping')).status, 503);
  const on = await mcpServer({ token: TOKEN });
  assert.equal((await rpc(on, 'ping', {}, { token: 'nope' })).status, 401);
  assert.equal((await rpc(on, 'ping', {}, { token: null })).status, 401);
  assert.equal((await rpc(on, 'ping')).status, 200);
});

test('initialize, notifications and tools/list', async () => {
  const base = await mcpServer({ token: TOKEN });
  const init = await rpc(base, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.ok(init.body.result.capabilities.tools);
  const note = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(note.status, 202);
  const names = (await rpc(base, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.ok(names.includes('week_overview') && names.includes('push_to_air'));

  const ro = await mcpServer({ token: TOKEN, readOnly: true });
  const roNames = (await rpc(ro, 'tools/list')).body.result.tools.map((t) => t.name);
  assert.ok(roNames.includes('week_overview'));
  assert.ok(!roNames.includes('push_to_air') && !roNames.includes('approve_block'));
  const refused = await rpc(ro, 'tools/call', { name: 'approve_block', arguments: { block_id: 11 } });
  assert.equal(refused.body.result.isError, true);
});

test('tools compact the API answer and pass refusals back as errors', async () => {
  const base = await mcpServer({ token: TOKEN });
  const ch = JSON.parse(toolText(await rpc(base, 'tools/call', { name: 'list_channels', arguments: {} })));
  assert.deepEqual(ch[0], { id: 1, name: 'Discover', playout: 'otav', active: true, api: '10.0.0.1:8000' });

  const wk = JSON.parse(toolText(await rpc(base, 'tools/call', { name: 'week_overview', arguments: { week: '2026-11-04' } })));
  assert.equal(wk.total, 2);
  assert.equal(wk.notApprovable.length, 1);
  assert.deepEqual(wk.notApprovable[0].problems, ['30:00 short']);
  assert.ok(calls.includes('GET /api/blocks?week=2026-11-04'));

  const ap = await rpc(base, 'tools/call', { name: 'approve_block', arguments: { block_id: 11 } });
  assert.equal(ap.body.result.isError, true);
  assert.match(toolText(ap), /409.*30:00 short/);

  const bad = await rpc(base, 'tools/call', { name: 'week_overview', arguments: { week: 'tomorrow' } });
  assert.equal(bad.body.result.isError, true);

  assert.equal(toolText(await rpc(base, 'tools/call', { name: 'read_log', arguments: {} })), 'line 1\nline 2');
});

test('push_to_air needs confirm, returns refusals, and hands back a job when slow', async () => {
  const base = await mcpServer({ token: TOKEN });
  calls = [];
  const noConfirm = await rpc(base, 'tools/call', { name: 'push_to_air', arguments: { week: '2026-11-05' } });
  assert.equal(noConfirm.body.result.isError, true);
  assert.ok(!calls.some((c) => c.startsWith('POST /api/otav/push')));

  pushMode = 'refuse';
  const refused = JSON.parse(toolText(await rpc(base, 'tools/call', { name: 'push_to_air', arguments: { week: '2026-11-05', confirm: true } })));
  assert.equal(refused.ok, false);
  assert.deepEqual(refused.blocks, [{ id: 11 }]);
  assert.ok(calls.some((c) => /^POST \/api\/otav\/push\?week=2026-11-05&job=mcp-/.test(c)));
  assert.ok(!calls.some((c) => c.includes('includeToday')));

  pushMode = 'slow';
  const slow = JSON.parse(toolText(await rpc(base, 'tools/call', { name: 'push_to_air', arguments: { date: '2026-11-05', confirm: true } })));
  assert.equal(slow.running, true);
  assert.match(slow.job, /^mcp-/);
  pushMode = 'ok';
});

test('legacy SSE transport', async () => {
  const base = await mcpServer({ token: TOKEN });
  const ctrl = new AbortController();
  const res = await fetch(`${base}/sse`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const nextEvent = async () => {
    while (!buf.includes('\n\n')) buf += dec.decode((await reader.read()).value);
    const i = buf.indexOf('\n\n');
    const ev = buf.slice(0, i); buf = buf.slice(i + 2);
    return Object.fromEntries(ev.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 2)]));
  };
  const endpoint = (await nextEvent()).data;
  assert.match(endpoint, /^\/messages\?sessionId=/);
  const post = await fetch(base + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
  });
  assert.equal(post.status, 202);
  const msg = await nextEvent();
  assert.equal(msg.event, 'message');
  assert.equal(JSON.parse(msg.data).id, 7);
  ctrl.abort();
});

test('mounted behind express.json() (as in src/app.js) it reads the parsed body', async () => {
  const app = express();
  app.use(express.json());
  app.use(mcpHandler(() => ({ token: TOKEN, automatorUrl: fakeBase })));
  app.use((req, res) => res.status(404).send('next'));
  const base = await listen(createServer(app));
  const r = await rpc(base, 'tools/list');
  assert.ok(r.body.result.tools.length > 10);
  assert.equal((await fetch(`${base}/other`)).status, 404);
});
