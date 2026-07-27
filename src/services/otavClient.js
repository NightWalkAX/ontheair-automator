// Module C — Softron OnTheAir Video (OTAV) REST integrator.
//
// Each of the 6 channels is a SEPARATE OTAV server reachable at its own
// api_ip:api_port (from the ChannelType row). This module pushes an approved
// day's schedule into each channel's target playlist.
//
// Contract confirmed from "OnTheAir Video REST API documentation.htm":
//   - Auth (optional per instance): PUT /authorize {username,password}
//       -> {token, level}; token appended as ?token= on every later request;
//       invalidated whenever OTAV relaunches (expect periodic 401s).
//   - Get a playlist   : GET    /playlists/{n}          (index or unique_id)
//   - Create playlist  : POST   /playlists/{NAME}       -> Playlist Object
//                        (needs the OTAV "traffic" option; the playlist file is
//                         created in the folder selected for the schedule, so
//                         the OTAV scheduler picks it up for that day)
//   - Clear a playlist : DELETE /playlists/{n}/items
//   - Add a file clip  : POST   /playlists/{n}/items
//                        body { "clip_type": 0, "url": <path>, "name": <name> }
//                        (clip_type 0 = FILE; url is the media path)
//   - Resync scheduler : GET    /scheduler/resynchronize
//
// One playlist PER DAY, per channel: pushing 2026-07-27 creates/reuses a
// playlist named from the channel's playlist_name_pattern (default
// "{channel} {date}") instead of writing into one fixed playlist index. The
// legacy fixed playlist_ref is only used as a fallback when the instance can't
// create playlists (no traffic option).
//
// Because the scheduler Mac and both broadcast Macs mount the same SMB share at
// the same path, Resource.file_path is used verbatim as the clip "url".

import { db } from '../db.js';
import { prepareDaySchedule } from './otavSchedule.js';

class OtavClient {
  constructor(channel) {
    this.channel = channel;
    this.base = `http://${channel.api_ip}:${channel.api_port}`;
    this.token = null;
  }

  url(path) {
    const u = new URL(this.base + path);
    if (this.token) u.searchParams.set('token', this.token);
    return u.toString();
  }

  async authorize() {
    const { api_username, api_password } = this.channel;
    if (!api_username) return; // instance doesn't require auth
    const res = await fetch(this.base + '/authorize', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: api_username, password: api_password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new Error(`OTAV authorize failed for "${this.channel.name}": ${data.error || res.status}`);
    }
    this.token = data.token;
  }

  /** Request with one automatic re-auth + retry on 401. */
  async request(method, path, body, _retried = false) {
    const res = await fetch(this.url(path), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !_retried) {
      await this.authorize();
      return this.request(method, path, body, true);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = new Error(`OTAV ${method} ${path} -> ${res.status}: ${data.error || text}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  info() { return this.request('GET', '/info'); }

  /** Playlist refs are index / unique_id / name — always URL-encode them. */
  static ref(ref) { return encodeURIComponent(String(ref)); }

  getPlaylist(ref) { return this.request('GET', `/playlists/${OtavClient.ref(ref)}`); }

  /**
   * POST /playlists/{NAME} — empty playlist in the folder selected for the OTAV
   * schedule. The doc shows no body, but OTAV 4.2.7 only routes the request when
   * one is present: without it the server answers a generic HTML 404, with it the
   * real handler replies (e.g. 422 "The schedule does not exist or is not
   * folder-based." when the scheduler points at an event schedule file instead of
   * a folder). So always send the name in the body.
   */
  createPlaylist(name) {
    return this.request('POST', `/playlists/${OtavClient.ref(name)}`, { name });
  }

  clearPlaylist(ref) { return this.request('DELETE', `/playlists/${OtavClient.ref(ref)}/items`); }

  /** Playlists (files) that the current OTAV schedule references. */
  schedulerPlaylists() { return this.request('GET', '/scheduler/playlists'); }

  /** Open a scheduled playlist by path so it becomes addressable. */
  openSchedulerPlaylist(path) {
    return this.request('GET', `/scheduler/playlists?path=${encodeURIComponent(path)}`);
  }

  /**
   * Resolve the playlist to push one day's blocks into, in order of preference:
   *
   *   1. already open under that name        -> clear its items and reuse
   *   2. present in the OTAV schedule folder -> open it by path, clear, reuse
   *   3. otherwise                           -> POST /playlists/{NAME} (traffic option)
   *
   * Clearing on reuse is what makes a re-push replace instead of append.
   * Returns { ref, source, created } where `ref` is the unique_id (or the name,
   * when OTAV doesn't hand one back) to address in later item calls. If all
   * three routes fail it throws an error naming what was tried, so the push
   * report tells the operator which knob to turn.
   */
  async ensureDayPlaylist(name, preparedPath) {
    const tried = [];

    // 0. A file this app just wrote and registered in the schedule. OTAV may
    //    still be holding the previous schedule in memory, so on a miss ask it
    //    to resynchronize (which re-reads the schedule) and try once more.
    if (preparedPath) {
      for (const attempt of ['first', 'after resync']) {
        try {
          const opened = await this.openSchedulerPlaylist(preparedPath);
          const ref = opened?.unique_id || name;
          await this.clearPlaylist(ref);
          return { ref, source: 'prepared', created: false, path: preparedPath };
        } catch (err) {
          tried.push(`open "${preparedPath}" (${attempt}) -> ${err.message}`);
          if (attempt === 'after resync') break;
          await this.resynchronize().catch(() => {});
        }
      }
    }

    // 1. Open playlist with that display name.
    try {
      const existing = await this.getPlaylist(name);
      const ref = existing?.unique_id || name;
      await this.clearPlaylist(ref);
      return { ref, source: 'open', created: false };
    } catch (err) {
      if (err.status !== 404) throw err; // 401/403/network are real failures
      tried.push(`no open playlist named "${name}"`);
    }

    // 2. A playlist file the schedule already points at (OTAV needs it opened
    //    before it can be addressed by unique_id).
    try {
      const scheduled = await this.schedulerPlaylists();
      if (!Array.isArray(scheduled)) {
        throw new Error(`/scheduler/playlists returned ${JSON.stringify(scheduled).slice(0, 120)}`);
      }
      const match = scheduled.find((p) => {
        const base = String(p?.path || '').split('/').pop() || '';
        return base === name || base.replace(/\.xpls$/i, '') === name;
      });
      if (match) {
        const opened = await this.openSchedulerPlaylist(match.path);
        const ref = opened?.unique_id || name;
        await this.clearPlaylist(ref);
        return { ref, source: 'schedule', created: false, path: match.path };
      }
      tried.push(scheduled.length
        ? `schedule holds ${scheduled.length} playlist(s) but none named "${name}.xpls" ` +
          `(${scheduled.slice(0, 5).map((p) => String(p?.path || '').split('/').pop()).join(', ')})`
        : 'OTAV schedule is empty (no playlist files)');
    } catch (err) {
      tried.push(`schedule lookup failed (${err.message})`);
    }

    // 3. Create it (requires the traffic option).
    try {
      const made = await this.createPlaylist(name);
      return { ref: made?.unique_id || name, source: 'created', created: true };
    } catch (err) {
      tried.push(`create failed (${err.message})`);
    }

    throw new Error(`could not resolve a playlist for "${name}": ${tried.join('; ')}`);
  }

  /**
   * Try every route that could plausibly get a playlist named `name` into an
   * addressable state on this instance, reporting what each one answered.
   *
   * The documented API has exactly one creation endpoint (POST /playlists/{NAME},
   * traffic-option only). Builds without it answer with an HTML 404 page, so the
   * remaining candidates are undocumented shapes of the same idea plus opening an
   * .xpls path directly. This writes — it's opt-in, not part of diagnose().
   */
  async probeCreateRoutes(name, scheduleDir) {
    const attempts = [
      ['POST /playlists/{name}', 'POST', `/playlists/${OtavClient.ref(name)}`, undefined],
      ['POST /playlists/{name}.xpls', 'POST', `/playlists/${OtavClient.ref(name + '.xpls')}`, undefined],
      ['POST /playlists/{name} + body', 'POST', `/playlists/${OtavClient.ref(name)}`, { name }],
      ['POST /playlists + body', 'POST', '/playlists', { name }],
    ];
    if (scheduleDir) {
      const path = `${scheduleDir.replace(/\/$/, '')}/${name}.xpls`;
      attempts.push([`GET /scheduler/playlists?path=${path}`, 'GET',
                     `/scheduler/playlists?path=${encodeURIComponent(path)}`, undefined]);
    }
    const results = [];
    for (const [label, method, path, body] of attempts) {
      try {
        const data = await this.request(method, path, body);
        results.push({ route: label, ok: true, response: JSON.stringify(data).slice(0, 200) });
      } catch (err) {
        results.push({ route: label, ok: false, status: err.status, error: String(err.message).slice(0, 200) });
      }
    }
    return results;
  }

  /**
   * Read-only probe of what this instance actually supports, for troubleshooting
   * push failures (which OTAV version, is the scheduler enabled, which playlists
   * are open, what the schedule folder holds).
   */
  async diagnose() {
    const out = {};
    const attempt = async (key, fn) => {
      try { out[key] = await fn(); } catch (err) { out[key] = { error: err.message, status: err.status }; }
    };
    await attempt('info', () => this.info());
    await attempt('scheduler', () => this.request('GET', '/scheduler'));
    await attempt('scheduler_playlists', () => this.schedulerPlaylists());
    // Open playlists are only enumerable by walking indexes until a 404.
    const open = [];
    for (let i = 0; i < 10; i++) {
      try {
        const pl = await this.getPlaylist(i);
        open.push({ index: i, unique_id: pl?.unique_id, name: pl?.name, path: pl?.path, total_items: pl?.total_items });
      } catch { break; }
    }
    out.open_playlists = open;
    return out;
  }

  addFileClip(ref, filePath, name) {
    return this.request('POST', `/playlists/${OtavClient.ref(ref)}/items`, {
      clip_type: 0, // FILE
      url: filePath,
      name,
    });
  }

  resynchronize() { return this.request('GET', '/scheduler/resynchronize'); }
}

/** Load ordered (resource) items for a scheduled block. */
function blockItems(blockId) {
  return db.prepare(`
    SELECT si.play_order, r.file_path, r.name, r.duration
    FROM ScheduleItem si
    JOIN Resource r ON r.id = si.resource_id
    WHERE si.block_id = ?
    ORDER BY si.play_order
  `).all(blockId);
}

const DEFAULT_PLAYLIST_PATTERN = '{channel} {date}';

/**
 * Name of the playlist that holds one channel's schedule for one day.
 * Tokens: {channel} {date} {yyyy} {mm} {dd}. Configurable per channel so the
 * name can match whatever the OTAV scheduler on that Mac expects.
 */
export function dayPlaylistName(channel, targetDate) {
  const pattern = (channel.playlist_name_pattern || '').trim() || DEFAULT_PLAYLIST_PATTERN;
  const [yyyy = '', mm = '', dd = ''] = String(targetDate).split('-');
  return pattern
    .replaceAll('{channel}', channel.channel_name ?? channel.name ?? '')
    .replaceAll('{date}', targetDate)
    .replaceAll('{yyyy}', yyyy)
    .replaceAll('{mm}', mm)
    .replaceAll('{dd}', dd)
    .trim();
}

/**
 * Push all approved blocks for `targetDate` to their channels' OTAV instances.
 * Groups blocks by channel, creates (or reuses+clears) that channel's playlist
 * FOR THAT DAY, then appends every clip in schedule order. On success marks
 * blocks 'exported'.
 *
 * Returns a per-channel report; failures are captured per channel rather than
 * aborting the whole run (one dead OTAV shouldn't block the other 5).
 */
export async function pushApprovedBlocks(targetDate) {
  const blocks = db.prepare(`
    SELECT sb.id AS block_id, bt.channel_id, bt.start_time,
           c.name AS channel_name, c.api_ip, c.api_port,
           c.playlist_ref, c.playlist_name_pattern, c.api_username, c.api_password,
           c.schedule_path, c.playlist_dir, c.playlist_template
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN ChannelType   c  ON c.id = bt.channel_id
    WHERE sb.target_date = ? AND sb.status = 'approved'
    ORDER BY bt.channel_id, bt.start_time
  `).all(targetDate);

  // Group by channel.
  const byChannel = new Map();
  for (const b of blocks) {
    if (!byChannel.has(b.channel_id)) byChannel.set(b.channel_id, { channel: b, blocks: [] });
    byChannel.get(b.channel_id).blocks.push(b);
  }

  const report = [];
  const markExported = db.prepare("UPDATE ScheduledBlock SET status = 'exported' WHERE id = ?");

  for (const { channel, blocks: chBlocks } of byChannel.values()) {
    const playlistName = dayPlaylistName(channel, targetDate);
    const client = new OtavClient(channel);
    // Read the day's clips up front: the schedule event needs their total run
    // time, and pushing them is the next step anyway.
    const dayItems = chBlocks.map((b) => ({ block_id: b.block_id, items: blockItems(b.block_id) }));
    const daySeconds = dayItems.reduce(
      (sum, b) => sum + b.items.reduce((s, i) => s + (i.duration || 0), 0), 0);
    const result = {
      channel: channel.channel_name,
      playlist: playlistName,
      pushed: 0,
      blocks: chBlocks.length,
    };
    try {
      await client.authorize();

      // Event-based schedules can't be modified over REST, so when the channel
      // is configured for it, the day's playlist file and its schedule event are
      // prepared on disk first — that is also what makes the playlist openable
      // by path below (OTAV only opens paths its schedule references).
      const prepared = prepareDaySchedule(channel, {
        playlistName,
        targetDate,
        startDateTime: `${targetDate} ${String(chBlocks[0]?.start_time || '00:00').slice(0, 5)}:00`,
        durationSeconds: daySeconds,
      });
      if (prepared) {
        result.playlist_path = prepared.playlistPath;
        result.schedule_event = prepared.event;
      }

      let ref;
      try {
        const day = await client.ensureDayPlaylist(playlistName, prepared?.playlistPath);
        ref = day.ref;
        result.playlist_ref = ref;
        result.created = prepared?.playlistCreated ?? day.created;
        result.source = day.source;
      } catch (err) {
        // Instances without the "traffic" option can neither create playlists
        // nor (usually) expose a schedule folder. Fall back to the channel's
        // fixed playlist_ref if one is configured; otherwise say what to fix.
        if (channel.playlist_ref == null || channel.playlist_ref === '') {
          throw new Error(
            `${err.message}. Fix one of: point that OTAV's scheduler at a ` +
            `FOLDER-BASED schedule (a folder of playlists) so it can create the ` +
            `day's playlist there, pre-create/open a playlist named ` +
            `"${playlistName}" on that Mac, or set the channel's fallback playlist ref.`,
          );
        }
        ref = channel.playlist_ref;
        result.playlist_ref = ref;
        result.created = false;
        result.source = 'fallback';
        result.warning = `no per-day playlist available (${err.message}); pushed into fixed playlist ${ref}`;
        await client.clearPlaylist(ref);
      }
      for (const b of dayItems) {
        for (const item of b.items) {
          await client.addFileClip(ref, item.file_path, item.name);
          result.pushed++;
        }
        markExported.run(b.block_id);
      }
      await client.resynchronize().catch(() => {}); // best-effort
      result.ok = true;
    } catch (err) {
      result.ok = false;
      result.error = String(err.message || err);
    }
    report.push(result);
  }
  return { targetDate, channels: report };
}

/** Connectivity check: hit /info on one channel. */
export async function checkChannel(channelId) {
  const channel = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(channelId);
  if (!channel) throw new Error('channel not found');
  const client = new OtavClient(channel);
  await client.authorize();
  return client.info();
}

/**
 * Troubleshooting probe for one channel: what the instance supports and which
 * playlist name this project would target for `targetDate`. Read-only.
 */
export async function diagnoseChannel(channelId, targetDate, { probeCreate = false } = {}) {
  const channel = db.prepare('SELECT * FROM ChannelType WHERE id = ?').get(channelId);
  if (!channel) throw new Error('channel not found');
  const client = new OtavClient(channel);
  await client.authorize();
  const out = await client.diagnose();
  out.day_playlist_name = dayPlaylistName({ ...channel, channel_name: channel.name }, targetDate);
  out.fallback_playlist_ref = channel.playlist_ref ?? null;
  if (probeCreate) {
    const schedulePath = out.scheduler?.schedule_path;
    const scheduleDir = typeof schedulePath === 'string' && schedulePath.includes('/')
      ? schedulePath.slice(0, schedulePath.lastIndexOf('/'))
      : null;
    out.create_routes = await client.probeCreateRoutes(out.day_playlist_name, scheduleDir);
  }
  return out;
}

export { OtavClient };
