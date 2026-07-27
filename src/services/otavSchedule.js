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

import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  if (!existsSync(schedulePath)) return { version: '2.0', events: [] };
  const raw = readFileSync(schedulePath, 'utf8').trim();
  if (!raw) return { version: '2.0', events: [] };
  const doc = JSON.parse(raw);
  if (!Array.isArray(doc.events)) doc.events = [];
  return doc;
}

/** Write via temp file + rename so OTAV never observes a half-written schedule. */
export function writeSchedule(schedulePath, doc) {
  const tmp = `${schedulePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  if (existsSync(schedulePath) && !existsSync(`${schedulePath}.bak`)) {
    copyFileSync(schedulePath, `${schedulePath}.bak`); // one pristine copy, kept forever
  }
  renameSync(tmp, schedulePath);
}

/**
 * Insert or replace this app's event for one channel-day, in place.
 * Other events are left byte-for-byte as they were.
 *
 * @param doc            parsed schedule document
 * @param displayName    tagged name identifying our event (see eventDisplayName)
 * @param playlistPath   .xpls path as the OTAV Mac sees it
 * @param startDateTime  "YYYY-MM-DD HH:MM:SS"
 * @param durationSeconds total run time of the day's playlist
 * @returns 'inserted' | 'replaced'
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
    doc.events[at] = event;
    return 'replaced';
  }
  doc.events.push(event);
  return 'inserted';
}

/**
 * Make the day's playlist exist on disk and be referenced by the schedule.
 * Returns { playlistPath, playlistCreated, event, schedulePath } or null when
 * this channel isn't set up for file-level scheduling (no playlist folder or no
 * template, or no schedule to edit).
 *
 * Throws with an actionable message when a configured path is wrong — a silent
 * skip here would surface much later as an opaque REST 422.
 */
export function prepareDaySchedule(channel, {
  playlistName, targetDate, startDateTime, durationSeconds, reportedSchedulePath,
}) {
  const { playlist_dir: playlistDir, playlist_template: template } = channel;
  // The channel may name the schedule explicitly; otherwise use the one the
  // instance itself reports (GET /scheduler -> schedule_path). Same-mount-path
  // means what OTAV reads is what this process writes.
  const schedulePath = channel.schedule_path || reportedSchedulePath || null;
  if (!schedulePath || !playlistDir || !template) return null;
  if (!/\.json$/i.test(schedulePath)) {
    throw new Error(`"${schedulePath}" is not a JSON event schedule — a folder-based schedule needs no file editing`);
  }

  if (!existsSync(template)) {
    throw new Error(`playlist template not found at "${template}" — save an empty playlist from OTAV there`);
  }
  if (!existsSync(dirname(schedulePath))) {
    throw new Error(`schedule folder not reachable: "${dirname(schedulePath)}" (is the share mounted?)`);
  }
  if (!existsSync(playlistDir)) mkdirSync(playlistDir, { recursive: true });

  const playlistPath = join(playlistDir, `${playlistName}.xpls`);
  const playlistCreated = !existsSync(playlistPath);
  if (playlistCreated) copyFileSync(template, playlistPath); // byte copy: format untouched

  const displayName = eventDisplayName(channel.channel_name ?? channel.name, targetDate);
  const doc = readSchedule(schedulePath);
  const event = upsertDayEvent(doc, { displayName, playlistPath, startDateTime, durationSeconds });
  writeSchedule(schedulePath, doc);

  return { playlistPath, playlistCreated, event, displayName, schedulePath };
}

/**
 * Can this process actually reach and edit the paths a push would touch?
 * Answers from the app machine's point of view — the point of failure when the
 * schedule lives on a share that isn't mounted here, or is mounted read-only.
 */
export function inspectPaths(channel, reportedSchedulePath) {
  const schedulePath = channel.schedule_path || reportedSchedulePath || null;
  const canWrite = (p) => { try { accessSync(p, constants.W_OK); return true; } catch { return false; } };

  const out = {
    schedule_path: schedulePath,
    schedule_path_source: channel.schedule_path ? 'configured on the channel' : (reportedSchedulePath ? 'reported by OTAV' : 'not set'),
    playlist_dir: channel.playlist_dir ?? null,
    playlist_template: channel.playlist_template ?? null,
  };
  if (schedulePath) {
    out.schedule_exists = existsSync(schedulePath);
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
  if (channel.playlist_dir) {
    out.playlist_dir_exists = existsSync(channel.playlist_dir);
    out.playlist_dir_writable = out.playlist_dir_exists && canWrite(channel.playlist_dir);
  }
  if (channel.playlist_template) out.template_exists = existsSync(channel.playlist_template);
  return out;
}
