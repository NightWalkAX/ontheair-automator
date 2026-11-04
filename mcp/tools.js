// The tools the MCP server exposes. Every one of them is a call to the
// automator's own REST API — never to the database or a service module — so
// the same gates that protect the UI (validateBlock, the push gate, the
// "today is on air" confirmation, the missing-file check) protect an LLM too.
//
// Answers are COMPACTED before they go back: an LLM reads every character it
// is given, and the raw week grid or catalogue is hundreds of KB.

const MAX_CHARS = 40_000;

/** A JSON-RPC-safe error the model can read and act on. */
export class ToolError extends Error {}

// ---- small helpers ----------------------------------------------------------

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function date(v, name, { required = false } = {}) {
  if (v == null || v === '') {
    if (required) throw new ToolError(`${name} (YYYY-MM-DD) is required`);
    return localDate();
  }
  const s = String(v).slice(0, 10);
  if (!DATE.test(s)) throw new ToolError(`${name} must be YYYY-MM-DD`);
  return s;
}

function int(v, name, { required = true } = {}) {
  if (v == null || v === '') {
    if (required) throw new ToolError(`${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolError(`${name} must be a whole number`);
  return n;
}

function channelList(v) {
  if (v == null || v === '') return '';
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const ids = arr.map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].join(',');
}

function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

const mmss = (s) => {
  const a = Math.round(Math.abs(Number(s) || 0));
  return `${s < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};

/** The same one-line verdict the UI shows, rebuilt from the week-grid flags. */
function problemsOf(b) {
  const p = [];
  if (b.durationFits === false) p.push(b.diff > 0 ? `runs ${mmss(b.diff)} over` : `${mmss(-b.diff)} short`);
  if (b.fillerFits === false) p.push(`filler run ${mmss(b.fillerRun)} > cap ${mmss(b.maxFillerRun)}`);
  if (b.typeFits === false) p.push(`${b.offTypeCount} clip(s) of the wrong content type`);
  if (b.crossFits === false) p.push(`${b.crossCount} clash(es) with another channel`);
  if (b.faultyConfirmed) p.push(`${b.faultyConfirmed} clip(s) confirmed to play badly`);
  return p;
}

/** Missing files come by the dozen when a share is off: count them, show a few. */
function groupMissing(list) {
  const missing = list.filter((p) => p.kind === 'missing-file');
  const rest = list.filter((p) => p.kind !== 'missing-file').map((p) => p.text);
  if (missing.length <= 3) return [...rest, ...missing.map((p) => p.text)];
  return [...rest, `missing-file: ${missing.length} scheduled files are not on disk, e.g.`, ...missing.slice(0, 3).map((p) => p.text)];
}

function compactBlock(b) {
  return {
    id: b.id, date: b.target_date, channel_id: b.channel_id, channel: b.channel_name,
    template: b.template_name, start: b.start_time, end: b.end_time,
    mirror: !!b.is_mirror, status: b.status, fits: b.fits, approvable: b.approvable,
    ...(b.overridden ? { forced: b.override_reason } : {}),
    ...(problemsOf(b).length ? { problems: problemsOf(b) } : {}),
  };
}

// ---- the tool table -----------------------------------------------------------
//
// `write: true` marks a tool that changes something; with mcp.readOnly those are
// neither listed nor callable. `destructive` is a hint to the client that the
// action reaches air or cannot simply be undone.

const S = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const P = {
  week: { type: 'string', description: 'First day of the 7-day window, YYYY-MM-DD. Default: today.' },
  channels: { type: 'array', items: { type: 'integer' }, description: 'Channel ids to limit to (see list_channels). Omit for every channel.' },
  channel_id: { type: 'integer', description: 'Channel id (see list_channels).' },
  block_id: { type: 'integer', description: 'Scheduled block id (see week_overview).' },
};

export const TOOLS = [
  // ---- read ----
  {
    name: 'health',
    description: 'Is the automator up? Uptime, memory and log location.',
    inputSchema: S(),
    run: (api) => api.get('/api/health'),
  },
  {
    name: 'list_channels',
    description: 'Every channel (6 OTAV + 1 analog) with its id, name, playout kind and whether it is active. Use the ids in the other tools.',
    inputSchema: S(),
    run: async (api) => (await api.get('/api/channels')).map((c) => ({
      id: c.id, name: c.name, playout: c.playout || 'otav', active: !!c.is_active,
      api: c.api_ip ? `${c.api_ip}:${c.api_port}` : null,
    })),
  },
  {
    name: 'week_overview',
    description: 'The schedule for 7 days from `week`: blocks per channel and status (draft/approved/exported), and every block that does NOT pass validation with the reason. Set `all_blocks` to list every block (filter with channel_id and/or date to keep it short).',
    inputSchema: S({
      week: P.week,
      channel_id: P.channel_id,
      date: { type: 'string', description: 'Only list blocks of this day (YYYY-MM-DD) when all_blocks is set.' },
      all_blocks: { type: 'boolean', description: 'List every block, not only the problem ones.' },
    }),
    run: async (api, a) => {
      const week = date(a.week, 'week');
      const r = await api.get(`/api/blocks${qs({ week, channel_id: a.channel_id })}`);
      const blocks = r.blocks || [];
      const summary = {};
      for (const b of blocks) {
        const s = (summary[b.channel_name] ||= { draft: 0, approved: 0, exported: 0, unfit: 0, forced: 0 });
        s[b.status] = (s[b.status] || 0) + 1;
        if (!b.fits && !b.overridden) s.unfit++;
        if (b.overridden) s.forced++;
      }
      const unfit = blocks.filter((b) => !b.approvable).map(compactBlock);
      const out = { week: r.week, total: blocks.length, perChannel: summary, notApprovable: unfit };
      if (a.all_blocks) {
        const day = a.date ? date(a.date, 'date') : null;
        out.blocks = blocks.filter((b) => !day || b.target_date === day).map(compactBlock);
      }
      return out;
    },
  },
  {
    name: 'get_block',
    description: 'One block in detail: window (with shifts), verdict, and its clips in play order (item ids are what set_episode needs).',
    inputSchema: S({ block_id: P.block_id }, ['block_id']),
    run: async (api, a) => {
      const v = await api.get(`/api/blocks/${int(a.block_id, 'block_id')}`);
      return {
        block: {
          id: v.block.id, date: v.block.target_date, channel_id: v.block.channel_id,
          template: v.block.template_name, status: v.block.status,
          slot: `${v.block.start_time}–${v.block.end_time}`,
          window: `${v.effectiveStart}–${v.effectiveEnd}`,
          startShift: v.startShift, endShift: v.endShift,
          prevBlockId: v.prevBlockId, nextBlockId: v.nextBlockId,
        },
        verdict: {
          fits: v.fits, approvable: v.approvable, overridden: v.overridden, overrideReason: v.overrideReason,
          slotSeconds: v.slotSeconds, contentSeconds: v.totalSeconds, diff: v.diff,
          durationFits: v.durationFits, fillerRun: v.fillerRun, maxFillerRun: v.maxFillerRun,
          typeFits: v.typeFits, crossConflicts: v.crossConflicts, faultyItems: v.faultyItems,
        },
        items: (v.items || []).map((i) => ({
          item_id: i.id, resource_id: i.resource_id, label: i.label || i.display_name || i.name,
          subject: i.subject, duration: i.duration, filler: !!i.is_filler,
          manual: !!i.is_manual_override, ...(i.fault_status ? { fault: i.fault_status } : {}),
        })),
      };
    },
  },
  {
    name: 'week_check',
    description: 'Simulates what a push would put on air for the week and lists, per channel-day, what would leave black or overrun: days not generated, missing blocks, drafts, overlaps, unfit blocks, missing files, where the playlist ends.',
    inputSchema: S({ week: P.week, channels: P.channels }),
    run: async (api, a) => {
      const r = await api.get(`/api/blocks/week-check${qs({ week: date(a.week, 'week'), channels: channelList(a.channels) })}`);
      // Only the days that have something to say; the full simulation is ~40KB a week.
      return {
        from: r.from, to: r.to, ok: r.ok,
        channels: (r.channels || []).map((c) => ({
          id: c.id, name: c.name, ok: c.ok,
          days: (c.days || []).filter((d) => !d.ok || d.problems?.length).map((d) => ({
            date: d.date, ok: d.ok, playlistEnd: d.playlistEnd, nextEventStart: d.nextEventStart,
            problems: groupMissing((d.problems || []).map((p) => ({
              kind: p.kind,
              text: `${p.blocking ? '' : '(warning) '}${p.kind}: ${p.message}${p.blockId ? ` [block ${p.blockId}]` : ''}`,
            }))),
          })),
        })),
      };
    },
  },
  {
    name: 'list_templates',
    description: 'Weekly block templates (recurring slots): name, weekdays, time slots, channels and assigned series.',
    inputSchema: S({ channel_id: P.channel_id }),
    run: async (api, a) => {
      const rows = await api.get('/api/blocks/templates');
      const cid = a.channel_id != null ? int(a.channel_id, 'channel_id') : null;
      return rows.filter((t) => cid == null || (t.channels || []).includes(cid)).map((t) => ({
        id: t.id, name: t.name, weekdays: t.weekdays || t.weekday, content_type: t.content_type,
        movie_block: !!t.is_movie_block, channels: t.channels,
        slots: (t.slots || []).map((s) => `${s.start_time}–${s.end_time}`),
        series: (t.series || []).map((s) => s.subject),
      }));
    },
  },
  {
    name: 'list_series',
    description: 'A channel\'s series registry: each show, whether it plays in order (serial), active, show type, episode count and total length.',
    inputSchema: S({ channel_id: P.channel_id }, ['channel_id']),
    run: async (api, a) => (await api.get(`/api/channels/${int(a.channel_id, 'channel_id')}/series`)).map((s) => ({
      subject: s.subject, serial: !!s.is_serial, active: !!s.is_active, show_type: s.show_type_name,
      episodes: s.chapter_count, total_seconds: s.total_duration,
    })),
  },
  {
    name: 'search_catalog',
    description: 'Search a channel\'s catalogue of clips by text (name, show or path). Returns at most `limit` clips with id, label, show, duration and approval.',
    inputSchema: S({
      channel_id: P.channel_id,
      query: { type: 'string', description: 'Text to look for (case-insensitive).' },
      subject: { type: 'string', description: 'Exact show/subject name.' },
      fillers: { type: 'boolean', description: 'true = only fillers, false = no fillers.' },
      limit: { type: 'integer', description: 'Default 50, max 300.' },
    }, ['channel_id']),
    run: async (api, a) => {
      const rows = await api.get(`/api/resources${qs({
        channel_id: int(a.channel_id, 'channel_id'), subject: a.subject,
        is_filler: a.fillers == null ? null : a.fillers ? 1 : 0,
      })}`);
      const q = String(a.query || '').toLowerCase().trim();
      const hit = q ? rows.filter((r) => [r.name, r.subject, r.label, r.file_path]
        .some((f) => String(f || '').toLowerCase().includes(q))) : rows;
      const limit = Math.min(300, Math.max(1, Number(a.limit) || 50));
      return {
        matches: hit.length,
        clips: hit.slice(0, limit).map((r) => ({
          id: r.id, label: r.label || r.name, subject: r.subject, season: r.season, chapter: r.chapter,
          duration: r.duration, filler: !!r.is_filler, approved: !!r.approved, file_path: r.file_path,
        })),
      };
    },
  },
  {
    name: 'monitor_status',
    description: 'Signal monitor: state of every public feed (ok / black / silent / frozen / down / resyncing) and open incidents.',
    inputSchema: S(),
    run: async (api) => {
      const r = await api.get('/api/monitor/status');
      // Drop the frame thumbnails: binary noise to a language model.
      return JSON.parse(JSON.stringify(r, (k, v) => (/frame|thumb|image|png|jpeg/i.test(k) && typeof v === 'string' ? undefined : v)));
    },
  },
  {
    name: 'monitor_events',
    description: 'Signal-monitor incident history, newest first.',
    inputSchema: S({ limit: { type: 'integer', description: 'Default 30, max 500.' } }),
    run: (api, a) => api.get(`/api/monitor/events${qs({ limit: Math.min(500, Math.max(1, Number(a.limit) || 30)) })}`),
  },
  {
    name: 'list_faults',
    description: 'Clips flagged for playing badly (suspect / confirmed / dismissed), per playout kind (otav or analog).',
    inputSchema: S({
      status: { type: 'string', enum: ['suspect', 'confirmed', 'dismissed'] },
      playout: { type: 'string', enum: ['otav', 'analog'] },
    }),
    run: (api, a) => api.get(`/api/faults${qs({ status: a.status, playout: a.playout })}`),
  },
  {
    name: 'push_status',
    description: 'Is a push to air running right now, and how did the job with this id end?',
    inputSchema: S({ job: { type: 'string', description: 'Job id returned by push_to_air.' } }),
    run: (api, a) => api.get(`/api/otav/push/status${qs({ job: a.job })}`),
  },
  {
    name: 'check_playout',
    description: 'Connectivity check of one channel\'s OTAV instance (GET /info through the automator).',
    inputSchema: S({ channel_id: P.channel_id }, ['channel_id']),
    run: (api, a) => api.get(`/api/otav/check/${int(a.channel_id, 'channel_id')}`),
  },
  {
    name: 'transcode_status',
    description: 'Air Spec (media normalisation) queue: counts per status and what is converting now.',
    inputSchema: S(),
    run: (api) => api.get('/api/transcode/status'),
  },
  {
    name: 'read_log',
    description: 'The last lines of the automator log (data/logs/automator.log).',
    inputSchema: S({ lines: { type: 'integer', description: 'Default 150, max 1000.' } }),
    run: (api, a) => api.text(`/api/log${qs({ lines: Math.min(1000, Math.max(1, Number(a.lines) || 150)) })}`),
  },

  // ---- write ----
  {
    name: 'generate_week',
    write: true,
    description: 'Generate draft blocks for the 7 days from `week_start`. Only drafts are (re)built; approved/exported blocks are left alone.',
    inputSchema: S({ week_start: P.week, channels: P.channels }),
    run: async (api, a) => {
      const r = await api.post(`/api/blocks/generate${qs({ weekStart: date(a.week_start, 'week_start'), channels: channelList(a.channels) })}`);
      return { ok: r.ok, results: r.results };
    },
  },
  {
    name: 'regenerate_block',
    write: true,
    description: 'Rebuild one draft block from its template (manual items are kept; a force on it is cleared).',
    inputSchema: S({ block_id: P.block_id }, ['block_id']),
    run: (api, a) => api.post(`/api/blocks/${int(a.block_id, 'block_id')}/regenerate`),
  },
  {
    name: 'approve_block',
    write: true,
    description: 'Approve one block. Refused (with the reason) when the block does not pass validation and is not forced.',
    inputSchema: S({ block_id: P.block_id }, ['block_id']),
    run: (api, a) => api.post(`/api/blocks/${int(a.block_id, 'block_id')}/approve`),
  },
  {
    name: 'approve_week',
    write: true,
    description: 'Approve every draft of the 7 days from `week` that passes validation; returns what was approved and what was not, with reasons.',
    inputSchema: S({ week: P.week, channels: P.channels }),
    run: (api, a) => api.post(`/api/blocks/approve-week${qs({ week: date(a.week, 'week'), channels: channelList(a.channels) })}`),
  },
  {
    name: 'force_block',
    write: true,
    destructive: true,
    description: 'Operator override for a block that cannot be fixed by editing: records the accepted problem so it can be approved and pushed. enabled=false takes the force back. Refused on a block that already passes.',
    inputSchema: S({
      block_id: P.block_id,
      enabled: { type: 'boolean', description: 'true = force (default), false = undo.' },
      reason: { type: 'string', description: 'Why it is being forced (kept on the block).' },
    }, ['block_id']),
    run: (api, a) => api.post(`/api/blocks/${int(a.block_id, 'block_id')}/override`, {
      enabled: a.enabled !== false, reason: a.reason || '',
    }),
  },
  {
    name: 'shift_block',
    write: true,
    description: 'Move where a block starts or ends (the boundary with its neighbour). `seconds` is the absolute offset from the slot time (0 = back to the slot), negative = earlier. Returns both blocks\' new verdicts.',
    inputSchema: S({
      block_id: P.block_id,
      edge: { type: 'string', enum: ['start', 'end'] },
      seconds: { type: 'integer' },
    }, ['block_id', 'edge', 'seconds']),
    run: (api, a) => api.put(`/api/blocks/${int(a.block_id, 'block_id')}/shift`, {
      edge: a.edge === 'start' ? 'start' : 'end', seconds: int(a.seconds, 'seconds'),
    }),
  },
  {
    name: 'set_episode',
    write: true,
    description: 'Choose which episode of a serial show a block plays (by chapter); the block and later drafts of the week roll forward from it. item_id comes from get_block.',
    inputSchema: S({
      block_id: P.block_id,
      item_id: { type: 'integer' },
      chapter: { type: 'integer', description: 'Chapter (episode position) to play.' },
    }, ['block_id', 'item_id', 'chapter']),
    run: (api, a) => api.post(`/api/blocks/${int(a.block_id, 'block_id')}/items/${int(a.item_id, 'item_id')}/set-episode`, {
      chapter: int(a.chapter, 'chapter'),
    }),
  },
  {
    name: 'push_to_air',
    write: true,
    destructive: true,
    description: 'Send approved schedules to the playout systems (OTAV and/or the analog device). Give ONE of: date, week (7 days from it) or from+to. Today is on air and is held back unless include_today is set (a push of today cuts air for a few seconds). Refused with the list of problems when a block is unfit, a file is missing or a day would go black. Requires confirm=true. Long pushes keep running in the background: poll push_status with the returned job id.',
    inputSchema: S({
      date: { type: 'string', description: 'Single day, YYYY-MM-DD.' },
      week: { type: 'string', description: '7 days from this day, YYYY-MM-DD.' },
      from: { type: 'string' },
      to: { type: 'string' },
      channels: P.channels,
      include_today: { type: 'boolean', description: 'Also push today (cuts air briefly). Only with the operator\'s explicit consent.' },
      allow_gaps: { type: 'boolean', description: 'Push even though the week check found days that would go black. Only with the operator\'s explicit consent.' },
      confirm: { type: 'boolean', description: 'Must be true: the operator has confirmed this push.' },
    }, ['confirm']),
    run: async (api, a) => {
      if (a.confirm !== true) throw new ToolError('push_to_air changes what goes on air: ask the operator to confirm, then call again with confirm=true');
      const range = a.week ? { week: date(a.week, 'week') }
        : a.from || a.to ? { from: date(a.from, 'from', { required: true }), to: date(a.to, 'to', { required: true }) }
        : a.date ? { date: date(a.date, 'date') } : null;
      if (!range) throw new ToolError('give date, week, or from+to');
      const job = `mcp-${Date.now().toString(36)}`;
      const path = `/api/otav/push${qs({
        ...range, job, channels: channelList(a.channels),
        includeToday: a.include_today ? 1 : null, allowGaps: a.allow_gaps ? 1 : null,
      })}`;
      // Refusals come back at once; a real push is thousands of REST calls and
      // can take minutes, longer than an MCP client will wait on one call.
      const call = api.post(path, undefined, { allowStatus: [409] });
      const waited = await Promise.race([call, new Promise((r) => setTimeout(() => r(null), api.pushWaitMs))]);
      if (waited) return { job, ...waited };
      call.catch(() => {}); // it keeps running in the automator either way
      return { job, running: true, note: 'Push started and still running — call push_status with this job id.' };
    },
  },
  {
    name: 'cancel_push',
    write: true,
    description: 'Stop a running push at the next clip boundary.',
    inputSchema: S({ job: { type: 'string', description: 'Job id from push_to_air.' } }, ['job']),
    run: (api, a) => api.post(`/api/otav/push/cancel${qs({ job: a.job })}`),
  },
  {
    name: 'recheck_catalog',
    write: true,
    description: 'Check that catalogued clips are still on disk and still the recorded length (no folder walk). Reports missing and unreadable clips; never deletes.',
    inputSchema: S({ channel_id: P.channel_id }),
    run: (api, a) => api.post('/api/media/recheck', a.channel_id != null ? { channel_id: int(a.channel_id, 'channel_id') } : {}),
  },
  {
    name: 'set_fault_status',
    write: true,
    description: 'Decide on clips that played badly: confirmed (the generator stops choosing them), dismissed, suspect, or clear (forget the history).',
    inputSchema: S({
      paths: { type: 'array', items: { type: 'string' }, description: 'file_path of each clip.' },
      playout: { type: 'string', enum: ['otav', 'analog'] },
      status: { type: 'string', enum: ['suspect', 'confirmed', 'dismissed', 'clear'] },
      note: { type: 'string' },
    }, ['paths', 'playout', 'status']),
    run: (api, a) => api.put('/api/faults', { paths: a.paths, playout: a.playout, status: a.status, note: a.note }),
  },
];

/** The tools visible under this configuration, in MCP `tools/list` shape. */
export function listTools({ readOnly = false } = {}) {
  return TOOLS.filter((t) => !(readOnly && t.write)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: {
      readOnlyHint: !t.write,
      destructiveHint: !!t.destructive,
      openWorldHint: false,
    },
  }));
}

/** A tiny client of the automator's REST API. */
export function automatorApi(baseUrl, { pushWaitMs = 20_000 } = {}) {
  const base = String(baseUrl).replace(/\/+$/, '');
  async function call(method, path, body, { allowStatus = [], asText = false } = {}) {
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ToolError(`cannot reach the automator at ${base}: ${err.cause?.code || err.message}`);
    }
    const text = await res.text();
    if (asText && res.ok) return text;
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { body: text.slice(0, 2000) }; }
    if (!res.ok && !allowStatus.includes(res.status)) {
      throw new ToolError(`automator answered ${res.status}: ${data?.error || text.slice(0, 500)}${
        data && typeof data === 'object' && Object.keys(data).length > 1 ? `\n${JSON.stringify(data).slice(0, 4000)}` : ''}`);
    }
    return data;
  }
  return {
    pushWaitMs,
    get: (p) => call('GET', p),
    text: (p) => call('GET', p, undefined, { asText: true }),
    post: (p, body, opts) => call('POST', p, body, opts),
    put: (p, body) => call('PUT', p, body),
  };
}

/** Run one tool; always resolves to an MCP CallToolResult. */
export async function callTool(name, args, { api, readOnly = false }) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || (readOnly && tool.write)) {
    return { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] };
  }
  try {
    const out = await tool.run(api, args && typeof args === 'object' ? args : {});
    let text = typeof out === 'string' ? out : JSON.stringify(out);
    if (text.length > MAX_CHARS) {
      text = `${text.slice(0, MAX_CHARS)}\n… [truncated ${text.length - MAX_CHARS} characters — narrow the request]`;
    }
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `internal error: ${err.message || err}`;
    return { isError: true, content: [{ type: 'text', text: msg }] };
  }
}
