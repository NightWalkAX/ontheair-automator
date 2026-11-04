// MCP server for the OnTheAir Automator.
//
// Normally you don't run this file: src/app.js mounts the same handler at
// /mcp (and /sse + /messages) on the automator's own port, configured from the
// `mcp` section of config/config.json. This entry point is for running the MCP
// on a different machine or port than the automator:
//
//   MCP_TOKEN=… AUTOMATOR_URL=http://172.20.0.29:8090 node mcp/server.js
//
// Env: MCP_TOKEN (required), AUTOMATOR_URL (default http://127.0.0.1:8090),
// MCP_PORT (8091), MCP_HOST (0.0.0.0), MCP_READ_ONLY=1.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { mcpHandler } from './http.js';

export function createMcpServer(getConfig) {
  return createServer(mcpHandler(getConfig));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = {
    token: process.env.MCP_TOKEN || '',
    automatorUrl: process.env.AUTOMATOR_URL || 'http://127.0.0.1:8090',
    readOnly: ['1', 'true', 'yes'].includes(String(process.env.MCP_READ_ONLY || '').toLowerCase()),
  };
  if (!cfg.token) {
    console.error('MCP_TOKEN is required');
    process.exit(1);
  }
  const port = Number(process.env.MCP_PORT) || 8091;
  const host = process.env.MCP_HOST || '0.0.0.0';
  createMcpServer(() => cfg).listen(port, host, () => {
    console.log(`MCP on http://${host}:${port}/mcp (SSE: /sse) → ${cfg.automatorUrl}${cfg.readOnly ? ' [read-only]' : ''}`);
  });
}
