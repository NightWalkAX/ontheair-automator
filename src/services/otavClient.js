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
//   - Clear a playlist : DELETE /playlists/{n}/items
//   - Add a file clip  : POST   /playlists/{n}/items
//                        body { "clip_type": 0, "url": <path>, "name": <name> }
//                        (clip_type 0 = FILE; url is the media path)
//   - Resync scheduler : GET    /scheduler/resynchronize
//
// Because the scheduler Mac and both broadcast Macs mount the same SMB share at
// the same path, Resource.file_path is used verbatim as the clip "url".

import { db } from '../db.js';

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
      throw new Error(`OTAV ${method} ${path} -> ${res.status}: ${data.error || text}`);
    }
    return data;
  }

  info() { return this.request('GET', '/info'); }

  clearPlaylist(ref) { return this.request('DELETE', `/playlists/${ref}/items`); }

  addFileClip(ref, filePath, name) {
    return this.request('POST', `/playlists/${ref}/items`, {
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
    SELECT si.play_order, r.file_path, r.name
    FROM ScheduleItem si
    JOIN Resource r ON r.id = si.resource_id
    WHERE si.block_id = ?
    ORDER BY si.play_order
  `).all(blockId);
}

/**
 * Push all approved blocks for `targetDate` to their channels' OTAV instances.
 * Groups blocks by channel, clears each channel's target playlist once, then
 * appends every clip in schedule order. On success marks blocks 'exported'.
 *
 * Returns a per-channel report; failures are captured per channel rather than
 * aborting the whole run (one dead OTAV shouldn't block the other 5).
 */
export async function pushApprovedBlocks(targetDate) {
  const blocks = db.prepare(`
    SELECT sb.id AS block_id, bt.channel_id, bt.start_time,
           c.name AS channel_name, c.api_ip, c.api_port,
           c.playlist_ref, c.api_username, c.api_password
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
    const ref = channel.playlist_ref ?? '0';
    const client = new OtavClient(channel);
    const result = { channel: channel.channel_name, playlist_ref: ref, pushed: 0, blocks: chBlocks.length };
    try {
      await client.authorize();
      await client.clearPlaylist(ref);
      for (const b of chBlocks) {
        for (const item of blockItems(b.block_id)) {
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

export { OtavClient };
