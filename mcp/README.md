# MCP — control the automator from GLC AI (AnythingLLM)

An MCP server that gives an LLM the same controls the web UI has: read the week,
inspect and fix blocks, approve, check the week and push to air. No dependencies.

Every tool calls the automator's own REST API, so **the UI's gates apply unchanged**:
an unfit block can't be approved, a push re-validates the range, today is held back
unless confirmed, missing files and days that would go black are refused.

## Enable it (on the automator Mac)

It is served by the automator itself on its port (`/mcp`), off until a token is set.
In `config/config.json` (re-read per request, no restart):

```json
"mcp": { "token": "<long random string>", "readOnly": false }
```

Generate a token: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
`readOnly: true` hides every tool that changes something. `MCP_TOKEN` in the
environment is used when `mcp.token` is empty.

## Connect AnythingLLM

`storage/plugins/anythingllm_mcp_servers.json` on the AnythingLLM server:

```json
{
  "mcpServers": {
    "ontheair-automator": {
      "type": "streamable",
      "url": "http://172.20.0.29:8090/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

If that AnythingLLM version only speaks the older SSE transport, use
`"type": "sse"` with `"url": "http://172.20.0.29:8090/sse"` — both are served.
Then *Agent Skills → MCP Servers → refresh*, and use it from an `@agent` chat.

The token travels only in the `Authorization` header — never put it in the URL,
the automator log records URLs.

## Tools

| Read | Write (hidden with `readOnly`) |
|---|---|
| `health`, `list_channels`, `week_overview`, `get_block`, `week_check`, `list_templates`, `list_series`, `search_catalog`, `monitor_status`, `monitor_events`, `list_faults`, `push_status`, `check_playout`, `transcode_status`, `read_log` | `generate_week`, `regenerate_block`, `approve_block`, `approve_week`, `force_block`, `shift_block`, `set_episode`, `push_to_air`, `cancel_push`, `recheck_catalog`, `set_fault_status` |

`push_to_air` requires `confirm: true` and refuses without it; `include_today` and
`allow_gaps` map to the UI's "push today anyway" / "push anyway". A push that is
still running after 20 s returns a `job` id — follow it with `push_status`.

## Running it elsewhere

`node mcp/server.js` runs the same handler standalone (env `MCP_TOKEN`,
`AUTOMATOR_URL`, `MCP_PORT` 8091, `MCP_HOST`, `MCP_READ_ONLY=1`) — e.g. on the
AnythingLLM host, pointed at `http://172.20.0.29:8090`.

Tests: `test/mcp.test.mjs` (against a fake automator; nothing reaches OTAV).
