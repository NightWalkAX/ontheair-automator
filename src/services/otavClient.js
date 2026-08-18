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
import {
  createScheduleBatch, flushScheduleBatch, inspectPaths, prepareDaySchedule,
} from './otavSchedule.js';
import { EPISODE_NO_CTE, withLabel } from './labels.js';
import { NULL_PROGRESS } from './pushProgress.js';

/**
 * Node's fetch throws a bare "fetch failed" TypeError and hides the real
 * network error (ECONNREFUSED, EHOSTUNREACH, ...) in err.cause. Surface it,
 * name the target, and say which knob to check — an operator reading the push
 * report can't act on "fetch failed".
 */
function describeFetchError(err, base) {
  const cause = err?.cause ?? err;
  const code = cause?.code || (err?.name === 'TimeoutError' ? 'ETIMEDOUT' : '');
  const hints = {
    ECONNREFUSED: 'connection refused — nothing is listening there (is OTAV running, and is its REST API enabled on that port?)',
    EHOSTUNREACH: 'host unreachable — wrong IP, or this machine is not on that network',
    ENETUNREACH: 'network unreachable from this machine',
    ETIMEDOUT: 'timed out — host silent (firewall, wrong IP, or Mac asleep?)',
    ENOTFOUND: 'hostname not found (DNS)',
    ECONNRESET: 'connection reset by the host',
  };
  const detail = hints[code] || cause?.message || String(err);
  return `cannot reach OTAV at ${base}: ${detail}${code ? ` [${code}]` : ''}. Check the channel's api_ip/api_port.`;
}

const FETCH_TIMEOUT_MS = 10_000;

class OtavClient {
  constructor(channel) {
    this.channel = channel;
    // Operators paste the address in every shape — "192.168.75.5",
    // "http://192.168.75.5", "192.168.75.5:8000/", … Normalize instead of
    // producing "http://http://…" (which fails DNS with ENOTFOUND).
    let host = String(channel.api_ip || '').trim()
      .replace(/^https?:\/\//i, '')
      .replace(/[/?#].*$/, '');
    let port = channel.api_port;
    const withPort = host.match(/^(.+):(\d+)$/);
    if (withPort) {
      host = withPort[1];
      port = port || Number(withPort[2]);
    }
    this.base = `http://${host}:${port}`;
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
    let res;
    try {
      res = await fetch(this.base + '/authorize', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: api_username, password: api_password }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`OTAV authorize for "${this.channel.name}": ${describeFetchError(err, this.base)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new Error(`OTAV authorize failed for "${this.channel.name}": ${data.error || res.status}`);
    }
    this.token = data.token;
  }

  /** Request with one automatic re-auth + retry on 401. */
  async request(method, path, body, _retried = false) {
    let res;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const wrapped = new Error(`OTAV ${method} ${path}: ${describeFetchError(err, this.base)}`);
      wrapped.fatal = true; // a dead host won't come back mid-push; don't cascade fallbacks
      throw wrapped;
    }
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

  /**
   * A folder-based playlist plays whatever sits in a folder, so OTAV rejects
   * every item call on it with 422 "The specified playlist is not editable."
   * Nothing about that is retryable, hence `fatal`.
   */
  static assertEditable(playlist, filePath) {
    if (!playlist?.is_folder_based) return;
    const err = new Error(
      `the day playlist is FOLDER-BASED (plays "${playlist.folder_based_path ?? '?'}"), so OTAV refuses item `
      + 'edits on it. Replace the template with a NORMAL empty playlist saved from OTAV (not pointed at a '
      + `folder)${filePath ? `, then delete the copy already made from the old one: ${filePath}` : ''}.`,
    );
    err.fatal = true;
    throw err;
  }

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

  /**
   * Clear a playlist only when it actually holds clips.
   *
   * OTAV answers 422 "The specified playlist is not editable." to DELETE on
   * playlists it opened from the scheduler. That's fatal when there are items to
   * replace, but irrelevant when the playlist is already empty (a day playlist we
   * just created from the template always is), so an empty playlist is confirmed
   * rather than treated as a failure.
   */
  async clearIfNeeded(ref, known) {
    const totalOf = (pl) => (typeof pl?.total_items === 'number' ? pl.total_items
      : Array.isArray(pl?.items) ? pl.items.length : null);
    if (totalOf(known) === 0) return { cleared: false, note: 'already empty' };
    try {
      await this.clearPlaylist(ref);
      return { cleared: true };
    } catch (err) {
      const fresh = await this.getPlaylist(ref).catch(() => null);
      if (totalOf(fresh) === 0) return { cleared: false, note: `not cleared (${err.message}) but empty` };
      throw err;
    }
  }

  /** Playlists (files) that the current OTAV schedule references. */
  schedulerPlaylists() { return this.request('GET', '/scheduler/playlists'); }

  /** Open a scheduled playlist by path so it becomes addressable. */
  openSchedulerPlaylist(path) {
    return this.request('GET', `/scheduler/playlists?path=${encodeURIComponent(path)}`);
  }

  /** Every playlist currently open, with its index (the only enumeration OTAV offers). */
  async openPlaylists(limit = 10) {
    const out = [];
    for (let i = 0; i < limit; i++) {
      try { out.push({ index: i, ...(await this.getPlaylist(i)) }); } catch { break; }
    }
    return out;
  }

  /**
   * The safest ref for a playlist we know by file path: its unique_id, falling
   * back to its index. A scheduler-opened playlist reports a name that still
   * carries the .xpls extension, so the day name is not a reliable handle — and
   * the index is worse than it looks: it is just the playlist's position among
   * the open ones, so it shifts whenever OTAV closes/reopens playlists (which it
   * does on every schedule reload). Filling a day through a stale index empties
   * and rewrites SOMEBODY ELSE'S day; a unique_id simply 404s instead.
   */
  async refForPath(path, fallback) {
    const open = await this.openPlaylists().catch(() => []);
    const hit = open.find((pl) => pl.path === path)
      || open.find((pl) => (pl.name || '').replace(/\.xpls$/i, '') === String(fallback));
    return hit ? { ref: hit.unique_id ?? hit.index, playlist: hit } : { ref: fallback, playlist: null };
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
    const notes = [];

    // 0. A file this app just wrote and registered in the schedule. OTAV may
    //    still be holding the previous schedule in memory, so on a miss ask it
    //    to resynchronize (which re-reads the schedule) and try once more.
    if (preparedPath) {
      for (const attempt of ['first', 'after resync']) {
        try {
          const opened = await this.openSchedulerPlaylist(preparedPath);
          OtavClient.assertEditable(opened, preparedPath);
          const found = await this.refForPath(preparedPath, opened?.unique_id || name);
          const ref = found.ref;
          const cleared = await this.clearIfNeeded(ref, found.playlist ?? opened);
          if (cleared.note) notes.push(cleared.note);
          return { ref, source: 'prepared', created: false, path: preparedPath, notes };
        } catch (err) {
          if (err.fatal) throw err; // a folder-based playlist won't become editable
          tried.push(`open "${preparedPath}" (${attempt}) -> ${err.message}`);
          if (attempt === 'after resync') break;
          await this.resynchronize().catch(() => {});
        }
      }
    }

    // 1. Open playlist with that display name.
    try {
      const existing = await this.getPlaylist(name);
      OtavClient.assertEditable(existing);
      const ref = existing?.unique_id || name;
      const cleared = await this.clearIfNeeded(ref, existing);
      if (cleared.note) notes.push(cleared.note);
      return { ref, source: 'open', created: false, notes };
    } catch (err) {
      if (err.fatal || err.status !== 404) throw err; // 401/403/network are real failures
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
        OtavClient.assertEditable(opened, match.path);
        const ref = opened?.unique_id || name;
        const cleared = await this.clearIfNeeded(ref, opened);
        if (cleared.note) notes.push(cleared.note);
        return { ref, source: 'schedule', created: false, path: match.path, notes };
      }
      tried.push(scheduled.length
        ? `schedule holds ${scheduled.length} playlist(s) but none named "${name}.xpls" ` +
          `(${scheduled.slice(0, 5).map((p) => String(p?.path || '').split('/').pop()).join(', ')})`
        : 'OTAV schedule is empty (no playlist files)');
    } catch (err) {
      if (err.fatal) throw err;
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
   * Which open playlists actually accept edits, and addressed how.
   *
   * OTAV answers 422 "The specified playlist is not editable." without saying
   * why, so this adds a comment clip (clip_type 3 — needs no media file) to each
   * open playlist by index and by name, then removes it again. A playlist that
   * accepts the comment is editable; if none do, the block is instance-wide
   * (access level or a read-only mount) rather than specific to the day playlist.
   */
  async probeEditRoutes() {
    const results = [];
    for (const pl of await this.openPlaylists().catch(() => [])) {
      const label = `[${pl.index}] ${pl.name ?? '?'}${pl.is_folder_based ? ' (folder-based)' : ''}`;
      for (const [how, ref] of [['by index', pl.index], ['by name', pl.name]]) {
        if (ref == null) continue;
        try {
          const added = await this.request('POST', `/playlists/${OtavClient.ref(ref)}/items`,
            { clip_type: 3, name: 'ontheair-automator probe' });
          results.push({ playlist: label, addressed: how, ok: true });
          const id = added?.unique_id;
          if (id) {
            await this.request('DELETE', `/playlists/${OtavClient.ref(ref)}/items/${OtavClient.ref(id)}`)
              .catch(() => {}); // leave no litter; a stray comment is harmless if this fails
          }
        } catch (err) {
          results.push({ playlist: label, addressed: how, ok: false, status: err.status, error: String(err.message).slice(0, 160) });
        }
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
    out.open_playlists = (await this.openPlaylists()).map((pl) => ({
      index: pl.index, unique_id: pl.unique_id, name: pl.name, path: pl.path, total_items: pl.total_items,
      // A folder-based playlist plays whatever is in a folder, so its item list
      // cannot be edited — OTAV rejects item calls on it as "not editable".
      is_folder_based: pl.is_folder_based, folder_based_path: pl.folder_based_path,
    }));
    return out;
  }

  addFileClip(ref, filePath, name) {
    return this.request('POST', `/playlists/${OtavClient.ref(ref)}/items`, {
      clip_type: 0, // FILE
      url: filePath,
      name,
    });
  }

  /**
   * Set the watermark on one clip. The create-clip body has no logo fields, so
   * the logo is a follow-up edit: OTAV's clip update accepts "all properties of
   * a clip" even though only the common ones are listed. Addressed by the clip's
   * unique_id (the POST hands it back) rather than an index, which shifts.
   */
  setClipLogo(ref, clipRef, { filename, enabled }) {
    return this.request('PUT', `/playlists/${OtavClient.ref(ref)}/items/${OtavClient.ref(clipRef)}`, {
      logo_filename: filename,
      logo_enabled: !!enabled,
    });
  }

  getClip(ref, clipRef) {
    return this.request('GET', `/playlists/${OtavClient.ref(ref)}/items/${OtavClient.ref(clipRef)}`);
  }

  resynchronize() { return this.request('GET', '/scheduler/resynchronize'); }
}

/**
 * Load ordered (resource) items for a scheduled block. Each item carries the
 * operator-facing `label` ("Show · S01E02") — that, not the raw filename, is the
 * clip name written into OTAV's playlist, so the schedule reads the same on air
 * as it does in the review UI.
 */
function blockItems(blockId) {
  return db.prepare(`
    WITH ${EPISODE_NO_CTE}
    SELECT si.play_order, r.file_path, r.name, r.duration,
           r.subject, r.season, r.chapter, r.is_filler, en.episode_no,
           ov.display_name AS display_name, st.code AS show_type_code
    FROM ScheduleItem si
    JOIN Resource r ON r.id = si.resource_id
    LEFT JOIN EpisodeNo en ON en.id = r.id
    LEFT JOIN ResourceOverride ov ON ov.resource_id = r.id
    LEFT JOIN ShowType st ON st.id = r.show_type_id
    WHERE si.block_id = ?
    ORDER BY si.play_order
  `).all(blockId).map(withLabel);
}

const DEFAULT_PLAYLIST_PATTERN = '{channel} {date}';

// House rule for the per-clip watermark: every channel's logo file is named
// after the channel. A channel may override it (the stored value also accepts
// the {channel} token), and logo_enabled = 0 turns the watermark off entirely.
const DEFAULT_LOGO_PATTERN = '{channel} Watermark.png';

/**
 * The watermark to stamp on every clip of a channel, or null when the channel
 * has it switched off. The named file has to exist on that OTAV Mac — the REST
 * API can neither list nor upload logos, so a name that matches nothing simply
 * shows no watermark. pushApprovedBlocks reads one clip back to catch that.
 */
export function channelLogo(channel) {
  if (channel.logo_enabled === 0) return null;
  const pattern = (channel.logo_filename || '').trim() || DEFAULT_LOGO_PATTERN;
  const filename = pattern.replaceAll('{channel}', channel.channel_name ?? channel.name ?? '').trim();
  return filename ? { filename, enabled: true } : null;
}

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

/** Blocks of one date that have cleared review, with their channel's settings. */
function dayBlocks(targetDate) {
  return db.prepare(`
    SELECT sb.id AS block_id, bt.channel_id, bt.start_time,
           c.name AS channel_name, c.api_ip, c.api_port,
           c.playlist_ref, c.playlist_name_pattern, c.api_username, c.api_password,
           c.schedule_path, c.playlist_dir, c.playlist_template,
           c.logo_filename, c.logo_enabled
    FROM ScheduledBlock sb
    JOIN BlockTemplate bt ON bt.id = sb.template_id
    JOIN ChannelType   c  ON c.id = bt.channel_id
    WHERE sb.target_date = ? AND sb.status IN ('approved', 'exported')
    ORDER BY bt.channel_id, bt.start_time
  `).all(targetDate);
}

/**
 * One push at a time, process-wide.
 *
 * A push is a long read-modify-write against a live OTAV: clear the day's
 * playlist, then append ~80 clips one REST call at a time. Two overlapping
 * pushes (an impatient second click, a retried request, a week push racing a day
 * push) interleave those steps, so one run clears the playlist the other is
 * halfway through filling — the clips visibly appear, vanish and reappear.
 * Queueing costs nothing here: pushes are operator-triggered and rare.
 */
let pushQueue = Promise.resolve();
let pushInFlight = 0;
function serialized(fn) {
  pushInFlight++;
  const run = pushQueue.then(fn);
  pushQueue = run.then(() => {}, () => {});
  run.then(() => {}, () => {}).finally(() => { pushInFlight--; });
  return run;
}

/**
 * True while a push is running or waiting its turn in the queue. The route uses
 * it to refuse a second click outright: queueing behind a 10-minute week push
 * looks exactly like a hung request to whoever clicked.
 */
export function isPushRunning() { return pushInFlight > 0; }

/**
 * Fill one channel's day playlist with that day's clips and mark the blocks
 * exported. `plan` carries the day's blocks, their clips and the prepared
 * schedule entry; the caller owns error reporting.
 */
async function fillDayPlaylist(client, channel, plan, progress = NULL_PROGRESS) {
  const { result, dayItems, prepared } = plan;
  const chan = channel.channel_name || channel.name;
  const playlistName = result.playlist;
  const markExported = db.prepare("UPDATE ScheduledBlock SET status = 'exported' WHERE id = ?");

  let ref;
  try {
    const day = await client.ensureDayPlaylist(playlistName, prepared?.playlistPath);
    ref = day.ref;
    result.playlist_ref = ref;
    result.created = prepared?.playlistCreated ?? day.created;
    result.source = day.source;
    if (day.notes?.length) result.warning = day.notes.join('; ');
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
    await client.clearIfNeeded(ref, await client.getPlaylist(ref).catch(() => null));
  }
  progress.emit({
    type: 'playlist', channel: chan, date: plan.targetDate,
    playlist: playlistName, source: result.source,
    message: `playlist "${playlistName}" ready (${result.source})`,
  });

  // Watermark: a follow-up edit per clip, and never fatal — a day that airs
  // without its logo still beats a day that doesn't air. The first failure
  // stops further attempts so one unsupported instance can't turn into 80
  // failing round-trips.
  const logo = channelLogo(channel);
  let logoDone = false;   // one read-back is enough to prove it stuck
  let logoBroken = false;
  const noteLogo = (msg) => { if (!result.logo_warning) result.logo_warning = msg; };
  if (logo) result.logo = logo.filename;

  const clipTotal = dayItems.reduce((n, b) => n + b.items.length, 0);
  for (const b of dayItems) {
    for (const item of b.items) {
      // Between clips is the safe point to honour a cancel or the run deadline:
      // the playlist is consistent and the report shows exactly how far we got.
      progress.guard();
      const added = await client.addFileClip(ref, item.file_path, item.label || item.name);
      result.pushed++;
      progress.emit({
        type: 'clip', channel: chan, date: plan.targetDate,
        playlist: playlistName, done: result.pushed, total: clipTotal,
        name: item.label || item.name,
      });
      if (!logo || logoBroken) continue;
      const clipRef = added?.unique_id;
      if (!clipRef) {
        logoBroken = true;
        noteLogo('OTAV returned no clip id on create, so the watermark could not be addressed');
        continue;
      }
      try {
        await client.setClipLogo(ref, clipRef, logo);
        if (!logoDone) {
          logoDone = true;
          const back = await client.getClip(ref, clipRef).catch(() => null);
          if (back && back.logo_filename !== logo.filename) {
            noteLogo(`OTAV kept logo_filename "${back.logo_filename}" instead of "${logo.filename}"`);
          }
        }
      } catch (err) {
        logoBroken = true;
        noteLogo(`watermark not applied: ${err.message}`);
      }
    }
    markExported.run(b.block_id);
  }
}

/**
 * Push every requested day of ONE channel, in one pass over that instance.
 *
 * The order matters and is the fix for playlists churning during a week push:
 * all the days' playlist files and schedule events are prepared first and the
 * schedule is written ONCE (only if it actually changed), then a single
 * resynchronize lets OTAV reload and settle, and only then are playlists
 * resolved and filled. Preparing-and-resyncing per day instead made OTAV close
 * and reopen its playlists between (and during) days, which both churned the
 * playlist list and invalidated the ref of the day being filled.
 *
 * Returns [{ targetDate, result }] — one report row per day, failures included.
 */
async function pushChannelDays(channel, days, progress = NULL_PROGRESS) {
  const client = new OtavClient(channel);
  const chan = channel.channel_name || channel.name;
  const plans = [];
  for (const [targetDate, blocks] of days) {
    // Read the day's clips up front: the schedule event needs their total run
    // time, and pushing them is the next step anyway.
    const dayItems = blocks.map((b) => ({ block_id: b.block_id, items: blockItems(b.block_id) }));
    plans.push({
      targetDate,
      blocks,
      dayItems,
      daySeconds: dayItems.reduce((sum, b) => sum + b.items.reduce((s, i) => s + (i.duration || 0), 0), 0),
      result: {
        channel: channel.channel_name,
        playlist: dayPlaylistName(channel, targetDate),
        pushed: 0,
        blocks: blocks.length,
      },
    });
  }
  const rows = () => plans.map((p) => ({ targetDate: p.targetDate, result: p.result }));

  // Auth is per instance, not per day.
  progress.emit({
    type: 'channel-start', channel: chan, days: plans.length,
    clips: plans.reduce((n, p) => n + p.dayItems.reduce((m, b) => m + b.items.length, 0), 0),
    message: `${chan}: connecting to ${client.base}`,
  });
  progress.guard();   // a cancel here must unwind the run, not read as an auth failure
  try {
    await client.authorize();
  } catch (err) {
    for (const plan of plans) { plan.result.ok = false; plan.result.error = String(err.message || err); }
    return rows();
  }

  // Event-based schedules can't be modified over REST, so when the channel is
  // configured for it, the days' playlist files and their schedule events are
  // prepared on disk first — that is also what makes a playlist openable by path
  // below (OTAV only opens paths its schedule references). When the channel
  // doesn't name a schedule, ask the instance which one it has open rather than
  // making the operator retype the path.
  let reportedSchedulePath = null;
  if (!channel.schedule_path && channel.playlist_template) {
    const sched = await client.request('GET', '/scheduler').catch(() => null);
    reportedSchedulePath = typeof sched?.schedule_path === 'string' ? sched.schedule_path : null;
  }
  const batch = createScheduleBatch();
  for (const plan of plans) {
    try {
      plan.prepared = prepareDaySchedule(channel, {
        playlistName: plan.result.playlist,
        targetDate: plan.targetDate,
        startDateTime: `${plan.targetDate} ${String(plan.blocks[0]?.start_time || '00:00').slice(0, 5)}:00`,
        durationSeconds: plan.daySeconds,
        reportedSchedulePath,
        batch,
      });
      if (plan.prepared) {
        plan.result.playlist_path = plan.prepared.playlistPath;
        plan.result.schedule_event = plan.prepared.event;
        plan.result.schedule_path = plan.prepared.schedulePath;
      }
    } catch (err) {
      plan.prepareError = err; // this day only; the other days still go out
    }
  }
  const written = flushScheduleBatch(batch);
  if (written.length) {
    progress.emit({
      type: 'schedule', channel: chan, files: written.length,
      message: `${chan}: schedule written (${written.length} file${written.length === 1 ? '' : 's'})`,
    });
  }
  // One resync per channel, before any playlist is resolved: OTAV re-reads the
  // schedule (picking up the new .xpls files) and settles its open playlists
  // BEFORE we take refs, instead of shuffling them under a fill in progress.
  // Nothing changed on disk -> nothing to reload, so don't ask for one.
  if (written.length || plans.some((p) => p.prepared?.playlistCreated)) {
    progress.emit({ type: 'resync', channel: chan, message: `${chan}: resynchronizing scheduler` });
    await client.resynchronize().catch(() => {}); // best-effort
  }

  for (const plan of plans) {
    try {
      progress.guard();
      progress.emit({
        type: 'day-start', channel: chan, date: plan.targetDate,
        clips: plan.dayItems.reduce((n, b) => n + b.items.length, 0),
        message: `${chan} ${plan.targetDate}: pushing`,
      });
      if (plan.prepareError) throw plan.prepareError;
      await fillDayPlaylist(client, channel, plan, progress);
      plan.result.ok = true;
      progress.emit({
        type: 'day-done', channel: chan, date: plan.targetDate, ok: true,
        pushed: plan.result.pushed,
        message: `${chan} ${plan.targetDate}: ${plan.result.pushed} clips pushed`,
      });
    } catch (err) {
      plan.result.ok = false;
      plan.result.error = String(err.message || err);
      progress.emit({
        type: 'day-done', channel: chan, date: plan.targetDate, ok: false,
        pushed: plan.result.pushed, error: plan.result.error,
        message: `${chan} ${plan.targetDate}: ${plan.result.error}`,
      });
      // A cancel or a blown deadline is about the RUN, not this day: stop here
      // instead of marching the remaining days into the same wall.
      if (err.cancelled || err.timedOut) {
        for (const rest of plans) {
          if (rest.result.ok === undefined) {
            rest.result.ok = false;
            rest.result.error = `not pushed — ${plan.result.error}`;
          }
        }
        err.rows = rows();   // the caller still reports how far the run got
        throw err;
      }
      if (/not editable/i.test(plan.result.error)) {
        plan.result.error += '. OTAV refuses edits on that playlist — stop the scheduler '
          + '(GET /scheduler/stop), or open the playlist in OTAV and unlock it, then push again.';
      }
    }
  }
  return rows();
}

/**
 * Push a set of dates, one channel at a time (a channel's whole run — every day
 * it owns — completes before the next instance is touched). Returns one entry
 * per date that had something to push.
 */
async function pushDays(dates, progress = NULL_PROGRESS) {
  const perChannel = new Map(); // channel_id -> { channel, days: Map(date -> blocks) }
  const nonEmpty = new Set();
  for (const targetDate of dates) {
    for (const b of dayBlocks(targetDate)) {
      nonEmpty.add(targetDate);
      let entry = perChannel.get(b.channel_id);
      if (!entry) perChannel.set(b.channel_id, (entry = { channel: b, days: new Map() }));
      if (!entry.days.has(targetDate)) entry.days.set(targetDate, []);
      entry.days.get(targetDate).push(b);
    }
  }

  const totalClips = [...perChannel.values()].reduce((n, entry) => n
    + [...entry.days.values()].reduce((m, blocks) => m
      + blocks.reduce((k, b) => k + blockItems(b.block_id).length, 0), 0), 0);
  progress.emit({
    type: 'plan',
    channels: perChannel.size,
    days: nonEmpty.size,
    clips: totalClips,
    message: `${totalClips} clips across ${perChannel.size} channel(s) and ${nonEmpty.size} day(s)`,
  });

  const rows = [];
  let aborted = null;
  for (const entry of perChannel.values()) {
    try {
      rows.push(...await pushChannelDays(entry.channel, entry.days, progress));
    } catch (err) {
      // Only a cancel or the run deadline unwinds this far; everything else is
      // already captured per day. Keep the partial report and stop the run.
      if (!err.cancelled && !err.timedOut) throw err;
      rows.push(...(err.rows || []));
      aborted = { reason: err.cancelled ? 'cancelled' : 'timeout', error: String(err.message || err) };
      break;
    }
  }
  if (aborted) {
    // Channels never reached: say so explicitly rather than silently dropping
    // them from the report.
    for (const entry of perChannel.values()) {
      for (const [targetDate, blocks] of entry.days) {
        if (rows.some((r) => r.targetDate === targetDate && r.result.channel === entry.channel.channel_name)) continue;
        rows.push({
          targetDate,
          result: {
            channel: entry.channel.channel_name,
            playlist: dayPlaylistName(entry.channel, targetDate),
            pushed: 0,
            blocks: blocks.length,
            ok: false,
            error: `not pushed — run ${aborted.reason}`,
          },
        });
      }
    }
  }
  // Report stays date-major (channels within a day in channel order), which is
  // what the push report renders, even though the run is channel-major.
  const days = dates.filter((d) => nonEmpty.has(d)).map((targetDate) => ({
    targetDate,
    channels: rows.filter((r) => r.targetDate === targetDate).map((r) => r.result),
  }));
  days.aborted = aborted;
  return days;
}

/**
 * Push every block for `targetDate` that has cleared review — 'approved' AND
 * 'exported' — to their channels' OTAV instances. Groups blocks by channel,
 * creates (or reuses+clears) that channel's playlist FOR THAT DAY, then appends
 * every clip in schedule order. On success marks blocks 'exported'.
 *
 * Already-exported days are re-pushed rather than skipped: a push is "make OTAV
 * match the schedule as it stands now", so clip attributes changed after the
 * first push (the channel watermark, a renamed clip) reach air on the next one.
 * Drafts are still never pushed. Note this rebuilds the day's playlist, so
 * pushing a day that is currently on air interrupts it briefly.
 *
 * Returns a per-channel report; failures are captured per channel rather than
 * aborting the whole run (one dead OTAV shouldn't block the other 5).
 */
export function pushApprovedBlocks(targetDate, { progress = NULL_PROGRESS } = {}) {
  return serialized(async () => {
    const days = await pushDays([targetDate], progress);
    return { targetDate, channels: days[0]?.channels ?? [], aborted: days.aborted || null };
  });
}

/**
 * Push every day in an inclusive date range. A block template that repeats on
 * several weekdays produces one ScheduledBlock per date, and each date needs its
 * own playlist (and, on event schedules, its own schedule event) — so pushing a
 * single date only ever airs that one day.
 *
 * Dates with nothing past review are skipped and listed, rather than reported as
 * failures: an empty Wednesday is normal for a Mon/Tue/Thu template. Days pushed
 * before are pushed again, so a week push refreshes what already aired out.
 */
export function pushApprovedRange(fromDate, toDate, { progress = NULL_PROGRESS } = {}) {
  return serialized(async () => {
    const dates = [];
    for (let d = new Date(`${fromDate}T00:00:00Z`); d <= new Date(`${toDate}T00:00:00Z`);
         d.setUTCDate(d.getUTCDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    const days = await pushDays(dates, progress);
    const pushed = new Set(days.map((d) => d.targetDate));
    return {
      from: fromDate,
      to: toDate,
      days,
      aborted: days.aborted || null,
      skipped: dates.filter((d) => !pushed.has(d)),
      // Flat per-channel-per-day view, for reports that just want a list.
      channels: days.flatMap((d) => d.channels.map((c) => ({ ...c, date: d.targetDate }))),
    };
  });
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
  // What the file-level path would do, seen from this machine.
  const reported = typeof out.scheduler?.schedule_path === 'string' ? out.scheduler.schedule_path : null;
  out.files = inspectPaths(channel, reported);
  if (probeCreate) {
    out.create_routes = await client.probeCreateRoutes(out.day_playlist_name, out.files?.playlist_dir);
    out.edit_routes = await client.probeEditRoutes();
  }
  return out;
}

export { OtavClient };
