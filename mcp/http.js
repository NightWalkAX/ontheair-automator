// MCP over HTTP, with no dependencies (the Macs are updated with `git pull`,
// which brings no node_modules — see CLAUDE.md, nodemailer).
//
// Two transports, because MCP clients (AnythingLLM among them) speak either:
//
//   Streamable HTTP  POST /mcp   one JSON-RPC message or batch in, JSON out.
//                                Stateless: no session id, no server stream
//                                (GET /mcp answers 405, as the spec allows).
//   Legacy HTTP+SSE  GET  /sse   opens the stream; the first event names the
//                                POST /messages?sessionId=… endpoint, and every
//                                answer goes back over the stream.
//
// Auth is one shared token: `Authorization: Bearer <token>` on every request.
// Never in the query string — requestLogger writes URLs to automator.log.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { automatorApi, callTool, listTools } from './tools.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'ontheair-automator', title: 'OnTheAir Automator', version: '1.0.0' };
const INSTRUCTIONS = [
  'Controls the GLC TV broadcast scheduler (OnTheAir Automator): 6 OTAV channels + 1 analog channel.',
  'Workflow: list_channels → week_overview (find unfit blocks) → get_block → fix (regenerate_block, set_episode, shift_block, force_block) → approve_block / approve_week → week_check → push_to_air.',
  'push_to_air, force_block, include_today and allow_gaps change what goes on air: always ask the operator to confirm first.',
  'Dates are YYYY-MM-DD in the station\'s local time (Guyana).',
].join('\n');

const sha = (s) => createHash('sha256').update(String(s)).digest();
function authorized(req, token) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return !!m && timingSafeEqual(sha(m[1].trim()), sha(token));
}

function send(res, status, body, headers = {}) {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...(body != null ? { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' } : {}),
    ...headers,
  });
  res.end(text);
}

async function readBody(req) {
  if (req._body) return req.body; // express.json() already parsed it
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One JSON-RPC message → its response, or null for a notification. */
export async function handleMessage(msg, { api, readOnly }) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcError(msg?.id, -32600, 'invalid request');
  const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
  if (!isRequest) return null; // notifications (initialized, cancelled…) and stray responses
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const p = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS + (readOnly ? '\nThis server is READ-ONLY: nothing can be changed through it.' : ''),
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: listTools({ readOnly }) });
    case 'tools/call':
      if (typeof p.name !== 'string') return rpcError(msg.id, -32602, 'params.name is required');
      return ok(await callTool(p.name, p.arguments, { api, readOnly }));
    case 'resources/list': return ok({ resources: [] });
    case 'prompts/list': return ok({ prompts: [] });
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

async function handleBody(body, ctx) {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  return handleMessage(body, ctx);
}

/**
 * A (req, res, next) handler for /mcp, /sse and /messages. `getConfig()` is read
 * on every request, so a token or read-only change needs no restart:
 *   { token, readOnly, automatorUrl, pushWaitMs }
 * With no token configured the endpoints answer 503 — never open by default.
 */
export function mcpHandler(getConfig) {
  const streams = new Map(); // legacy SSE: sessionId → res

  return async function mcp(req, res, next) {
    const path = (req.url || '').split('?')[0];
    if (path !== '/mcp' && path !== '/sse' && path !== '/messages') return next ? next() : send(res, 404, { error: 'not found' });

    let cfg;
    try { cfg = getConfig() || {}; } catch (err) { return send(res, 500, { error: `config: ${err.message}` }); }
    if (!cfg.token) return send(res, 503, { error: 'MCP is not configured: set mcp.token in config/config.json' });
    if (!authorized(req, cfg.token)) return send(res, 401, { error: 'missing or wrong bearer token' }, { 'www-authenticate': 'Bearer' });
    const ctx = { api: automatorApi(cfg.automatorUrl, { pushWaitMs: cfg.pushWaitMs }), readOnly: !!cfg.readOnly };

    try {
      if (path === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only (no server stream)' }, { allow: 'POST' });
        let body;
        try { body = await readBody(req); } catch (err) {
          return send(res, err.status || 400, rpcError(null, -32700, `parse error: ${err.message}`));
        }
        const out = await handleBody(body, ctx);
        return out ? send(res, 200, out) : send(res, 202, null);
      }

      if (path === '/sse') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, { allow: 'GET' });
        const id = randomUUID();
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: endpoint\ndata: /messages?sessionId=${id}\n\n`);
        streams.set(id, res);
        const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        req.on('close', () => { clearInterval(keepAlive); streams.delete(id); });
        return;
      }

      // /messages
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' });
      const id = new URL(req.url, 'http://x').searchParams.get('sessionId');
      const stream = streams.get(id);
      if (!stream) return send(res, 404, { error: 'unknown or closed session' });
      let body;
      try { body = await readBody(req); } catch (err) { return send(res, 400, { error: err.message }); }
      send(res, 202, 'Accepted');
      const out = await handleBody(body, ctx);
      if (out && !stream.writableEnded) stream.write(`event: message\ndata: ${JSON.stringify(out)}\n\n`);
    } catch (err) {
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, String(err.message || err)));
    }
  };
}
