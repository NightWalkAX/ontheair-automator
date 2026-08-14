// Day-playlist file + OTAV schedule preparation.
//
// The REST API can create a playlist only when that instance's scheduler points
// at a folder-based schedule (POST /playlists/{NAME} otherwise answers
// 422 "The schedule does not exist or is not folder-based."). These channels run
// an EVENT-based schedule instead — a JSON document like:
//
//   { "version": "2.0", "events": [ { "playlists": [ { "playlist_path": … } ],
//                                     "start_date_time": "2026-07-22 13:10:00", … } ] }
//
// and the API exposes no way to modify events (only GET /scheduler/events). So the
// day's playlist is prepared at the file level instead:
//
//   1. copy a playlist file the operator saved once from OTAV (the template) to
//      "<playlist_dir>/<day name>.xpls" — a byte copy, so the proprietary .xpls
//      format is never parsed or generated here;
//   2. upsert ONLY that day's event in the schedule JSON, leaving every other
//      event (including hand-made repeating ones) untouched;
//   3. the caller then opens it over REST (GET /scheduler/playlists?path=…, which
//      only accepts paths the schedule references) and fills it with clips.
//
// Paths are used exactly as configured: per SEED.md every machine mounts the
// share at the same path, so what this process writes is what OTAV reads. The
// schedule and the playlist folder therefore have to live on that shared volume,
// not in a local ~/Documents.

import {
  accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { localizePath as loc } from '../config.js';

// All paths in this module are CANONICAL (the OTAV Mac's view) — that's what
// goes into the schedule JSON and the push report. Only the filesystem calls
// go through loc(), so the same code works on a machine that mounts the share
// elsewhere (config.pathMap).

/** Events this app owns are tagged in their display name so upserts are safe. */
const EVENT_TAG = 'ontheair-automator';

export function eventDisplayName(channelName, targetDate) {
  return `${channelName} ${targetDate} [${EVENT_TAG}]`;
}

function isOurs(ev, displayName) {
  return typeof ev?.display_name === 'string'
    && (ev.display_name === displayName
        || (ev.display_name.includes(`[${EVENT_TAG}]`) && ev.display_name.startsWith(displayName.split(' [')[0])));
}

export function readSchedule(schedulePath) {
  if (!existsSync(loc(schedulePath))) return { version: '2.0', events: [] };
  const raw = readFileSync(loc(schedulePath), 'utf8').trim();
  if (!raw) return { version: '2.0', events: [] };
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.events)) doc.events = [];
  return doc;
}

/** Write via temp file + rename so OTAV never observes a half-written schedule. */
export function writeSchedule(schedulePath, doc) {
  const local = loc(schedulePath);
  const tmp = `${local}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  if (existsSync(local) && !existsSync(`${local}.bak`)) {
    copyFileSync(local, `${local}.bak`); // one pristine copy, kept forever
  }
  renameSync(tmp, local);
}

/**
 * Key-order-independent comparison — the operator's editor may reorder keys, and
 * a re-push that rewrites an identical event costs a schedule reload on the OTAV
 * side (see upsertDayEvent).
 */
function sameEvent(a, b) {
  const canon = (v) => JSON.stringify(v, (_k, val) => (
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val));
  return canon(a) === canon(b);
}

/**
 * Insert or replace this app's event for one channel-day, in place.
 * Other events are left byte-for-byte as they were.
 *
 * An event that already says exactly what we would write reports 'unchanged' so
 * the caller can skip the file write: OTAV watches the schedule and reloads it on
 * every change, closing and reopening the playlists it references — a re-push
 * that rewrote an identical schedule made the day's playlist vanish and come back
 * under us while we were filling it.
 *
 * @param doc            parsed schedule document
 * @param displayName    tagged name identifying our event (see eventDisplayName)
 * @param playlistPath   .xpls path as the OTAV Mac sees it
 * @param startDateTime  "YYYY-MM-DD HH:MM:SS"
 * @param durationSeconds total run time of the day's playlist
 * @returns 'inserted' | 'replaced' | 'unchanged'
 */
export function upsertDayEvent(doc, { displayName, playlistPath, startDateTime, durationSeconds }) {
  const event = {
    playlists: [{ playlist_path: playlistPath, should_shuffle: false, should_loop: false, should_randomize: false }],
    start_date_time: startDateTime,
    theoretical_duration_in_seconds: Math.max(1, Math.round(durationSeconds || 0)),
    should_loop: false,
    event_color_index: 0,
    use_preset_theoretical_duration: true,
    display_name: displayName,
    is_repeating_event: false,
    is_enabled: true,
  };
  const at = doc.events.findIndex((ev) => isOurs(ev, displayName));
  if (at >= 0) {
    if (sameEvent(doc.events[at], event)) return 'unchanged';
    doc.events[at] = event;
    return 'replaced';
  }
  doc.events.push(event);
  return 'inserted';
}

/**
 * Collector for a run that prepares several days at once (a week push touches 7
 * days per channel). Every day of a channel edits the SAME schedule document, so
 * without batching the file is written — and therefore reloaded by OTAV — once
 * per day, which closes and reopens that instance's playlists 7 times mid-push.
 * Pass one batch through every prepareDaySchedule call, then flush it once.
 */
export function createScheduleBatch() {
  return { docs: new Map(), dirty: new Set() };
}

/** Write every schedule the batch actually changed. Returns the paths written. */
export function flushScheduleBatch(batch) {
  const written = [];
  for (const path of batch.dirty) {
    writeSchedule(path, batch.docs.get(path));
    written.push(path);
  }
  batch.dirty.clear();
  return written;
}

/**
 * Make the day's playlist exist on disk and be referenced by the schedule.
 * Returns { playlistPath, playlistCreated, event, changed, schedulePath } or null when
 * this channel isn't set up for file-level scheduling (no playlist folder or no
 * template, or no schedule to edit).
 *
 * Throws with an actionable message when a configured path is wrong — a silent
 * skip here would surface much later as an opaque REST 422.
 */
export function prepareDaySchedule(channel, {
  playlistName, targetDate, startDateTime, durationSeconds, reportedSchedulePath, batch,
}) {
  const template = channel.playlist_template;
  // The channel may name the schedule explicitly; otherwise use the one the
  // instance itself reports (GET /scheduler -> schedule_path). Same-mount-path
  // means what OTAV reads is what this process writes.
  const schedulePath = channel.schedule_path || reportedSchedulePath || null;
  if (!schedulePath || !template) return null;
  // Day playlists default to living beside the schedule.
  const playlistDir = channel.playlist_dir || dirname(schedulePath);
  if (!/\.json$/i.test(schedulePath)) {
    throw new Error(`"${schedulePath}" is not a JSON event schedule — a folder-based schedule needs no file editing`);
  }

  if (!existsSync(loc(template))) {
    throw new Error(`playlist template not found at "${template}" — save an empty playlist from OTAV there`);
  }
  if (!existsSync(loc(dirname(schedulePath)))) {
    throw new Error(`schedule folder not reachable: "${dirname(schedulePath)}" (is the share mounted?)`);
  }
  if (!existsSync(loc(playlistDir))) mkdirSync(loc(playlistDir), { recursive: true });

  const playlistPath = join(playlistDir, `${playlistName}.xpls`);
  const playlistCreated = !existsSync(loc(playlistPath));
  if (playlistCreated) {
    copyFileSync(loc(template), loc(playlistPath)); // byte copy: format untouched
    // OTAV edits this file as a different user over the share; a template copied
    // with restrictive permissions would open read-only there.
    try { chmodSync(loc(playlistPath), 0o666); } catch { /* share may not support it */ }
  }

  const displayName = eventDisplayName(channel.channel_name ?? channel.name, targetDate);
  // Within a batch every day of this channel edits one in-memory document, so
  // the schedule is read once and written once no matter how many days go out.
  const doc = batch?.docs.get(schedulePath) ?? readSchedule(schedulePath);
  batch?.docs.set(schedulePath, doc);
  const event = upsertDayEvent(doc, { displayName, playlistPath, startDateTime, durationSeconds });
  // Only touch the file when something really changed: an untouched schedule is
  // a schedule OTAV doesn't reload, and a reload mid-push reopens its playlists.
  const changed = event !== 'unchanged';
  if (batch) {
    if (changed) batch.dirty.add(schedulePath);
  } else if (changed) {
    writeSchedule(schedulePath, doc);
  }

  return { playlistPath, playlistCreated, event, changed, displayName, schedulePath };
}

/**
 * Can this process actually reach and edit the paths a push would touch?
 * Answers from the app machine's point of view — the point of failure when the
 * schedule lives on a share that isn't mounted here, or is mounted read-only.
 */
export function inspectPaths(channel, reportedSchedulePath) {
  const schedulePath = channel.schedule_path || reportedSchedulePath || null;
  const canWrite = (p) => { try { accessSync(loc(p), constants.W_OK); return true; } catch { return false; } };

  const playlistDir = channel.playlist_dir || (schedulePath ? dirname(schedulePath) : null);
  const out = {
    schedule_path: schedulePath,
    schedule_path_source: channel.schedule_path ? 'configured on the channel' : (reportedSchedulePath ? 'reported by OTAV' : 'not set'),
    playlist_dir: playlistDir,
    playlist_dir_source: channel.playlist_dir ? 'configured on the channel' : 'defaults to the schedule folder',
    playlist_template: channel.playlist_template ?? null,
  };
  if (schedulePath) {
    out.schedule_exists = existsSync(loc(schedulePath));
    out.schedule_writable = out.schedule_exists ? canWrite(schedulePath) : canWrite(dirname(schedulePath));
    out.schedule_is_json = /\.json$/i.test(schedulePath);
    if (out.schedule_exists) {
      try {
        const doc = readSchedule(schedulePath);
        out.schedule_events = doc.events.length;
        out.schedule_our_events = doc.events.filter((e) => String(e?.display_name || '').includes(`[${EVENT_TAG}]`)).length;
      } catch (err) {
        out.schedule_error = `unreadable: ${err.message}`;
      }
    }
  }
  if (playlistDir) {
    out.playlist_dir_exists = existsSync(loc(playlistDir));
    out.playlist_dir_writable = out.playlist_dir_exists && canWrite(playlistDir);
  }
  if (channel.playlist_template) out.template_exists = existsSync(loc(channel.playlist_template));
  return out;
}
