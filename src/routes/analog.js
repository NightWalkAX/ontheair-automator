// The Analog tab: the UltraNEXUS-HD's own affairs (status, device grid,
// files on its disk, backups, recovery). Scheduling and the push itself go
// through the same routes as every channel — /api/blocks and /api/otav/push,
// which hands the analog channel to analogClient.pushAnalogDays().

import { Router } from 'express';
import { updateConfig } from '../config.js';
import { localDate, addDays } from '../dates.js';
import {
  AnalogClient, AnalogError, DAYS, analogChannel, analogConfig, cancelUpload, filesForRange, isAnalogPushRunning,
  deleteDeviceFiles, deviceFiles, isConfigured, listConversions, planFiles, rollbackAnalog, rollbackConversions,
  startUpload, uploadStatus,
} from '../services/analogClient.js';
import {
  archiveStatus, cancelArchive, cancelRoutine, cleanupPlan, routineStatus, runCleanup, scanVol1, setKind, spaceFor,
  startArchive, startRoutine, vol1Rows, vol1Summary,
} from '../services/analogVol1.js';

export const router = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The analog channel and a client for it, or an error already sent. */
function ready(res) {
  const ch = analogChannel();
  if (!ch) { res.status(404).json({ ok: false, error: 'there is no analog channel' }); return null; }
  if (!isConfigured(ch)) {
    res.status(409).json({ ok: false, unconfigured: true,
      error: `${ch.name} has no address or API key — set them under Channels & Templates` });
    return null;
  }
  return { ch, client: new AnalogClient(ch) };
}

// A bad request of ours is a 400; anything the device or its API said is a 502
// (with the API's own status alongside, so the UI can tell 401 from 507).
const fail = (res, err) => res.status(err.status === 400 && !(err instanceof AnalogError) ? 400 : 502)
  .json({ ok: false, error: String(err.message || err), status: err.status ?? null });

/** Wrap a handler that needs the device. */
const device = (fn) => async (req, res) => {
  const r = ready(res);
  if (!r) return;
  try {
    res.json(await fn(r, req));
  } catch (err) {
    fail(res, err);
  }
};

/** Settle a set of reads so one failing doesn't hide the rest: { key: value | { error } }. */
async function settle(map) {
  const keys = Object.keys(map);
  const vals = await Promise.allSettled(Object.values(map));
  return Object.fromEntries(keys.map((k, i) => [k,
    vals[i].status === 'fulfilled' ? vals[i].value : { error: String(vals[i].reason?.message || vals[i].reason) }]));
}

// GET /api/analog — the channel (no key), the settings, what is running.
router.get('/', (req, res) => {
  const ch = analogChannel();
  if (!ch) return res.status(404).json({ ok: false, error: 'there is no analog channel' });
  const { api_key, api_password, ...channel } = ch;
  res.json({
    ok: true,
    channel: { ...channel, has_api_key: !!api_key },
    configured: isConfigured(ch),
    settings: analogConfig(),
    pushRunning: isAnalogPushRunning(),
    upload: uploadStatus(),
  });
});

// PUT /api/analog/settings { folderId?, programGuideTitle?, daysAhead?, archiveDir?, minFreeGb? } — config.json analog.*
router.put('/settings', (req, res) => {
  const b = req.body || {};
  const next = {};
  if ('folderId' in b) {
    if (b.folderId !== null && !Number.isInteger(Number(b.folderId))) return res.status(400).json({ error: 'folderId must be a number' });
    next.folderId = b.folderId === null || b.folderId === '' ? null : Number(b.folderId);
  }
  if ('programGuideTitle' in b) next.programGuideTitle = String(b.programGuideTitle || '').trim() || 'Program Guide';
  if ('daysAhead' in b) {
    const n = Number(b.daysAhead);
    if (!Number.isInteger(n) || n < 0 || n > 6) return res.status(400).json({ error: 'daysAhead must be 0..6' });
    next.daysAhead = n;
  }
  if ('archiveDir' in b) {
    const dir = String(b.archiveDir || '').trim();
    if (!dir.startsWith('/')) return res.status(400).json({ error: 'archiveDir must be an absolute path on the share' });
    next.archiveDir = dir.replace(/\/+$/, '');
  }
  if ('minFreeGb' in b) {
    const n = Number(b.minFreeGb);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'minFreeGb must be a number of GB' });
    next.minFreeGb = n;
  }
  updateConfig((c) => { c.analog = { ...(c.analog || {}), ...next }; });
  res.json({ ok: true, settings: analogConfig() });
});

// GET /api/analog/check — connectivity + what the API allows (the "probe" button).
router.get('/check', device(async ({ client }) => ({
  ok: true,
  base: client.base,
  ...(await settle({
    health: client.health(), disk: client.disk(), draft: client.draftStatus(), playback: client.playbackStatus(),
  })),
})));

// GET /api/analog/status — playback verdict + what is playing (polled by the tab).
router.get('/status', device(async ({ client }) => ({
  ok: true, ...(await settle({ playback: client.playbackStatus(), live: client.live() })),
})));

// GET /api/analog/schedule?day=mon&source=device|draft
router.get('/schedule', device(async ({ client }, req) => {
  const day = String(req.query.day || '').toLowerCase().slice(0, 3);
  const source = req.query.source === 'draft' ? 'draft' : 'device';
  if (!DAYS.includes(day)) throw Object.assign(new Error('day must be sun..sat'), { status: 400 });
  return { ok: true, day, source, events: (await client.schedule(day, source))[day] || [] };
}));

router.get('/folders', device(async ({ client }) => ({ ok: true, folders: await client.folders() })));
router.get('/disk', device(async ({ client }) => ({ ok: true, disk: await client.disk() })));
// GET /api/analog/storage — every file on the device disk, with what uses it.
router.get('/storage', device(async ({ ch, client }) => ({ ok: true, files: await deviceFiles(client, ch.id) })));

// POST /api/analog/storage/delete { filenames: [...], force? } — make room on Vol1.
// Without force, files on air or used by approved blocks from today on are
// refused and listed (refused[]); the UI asks before resending with force.
router.post('/storage/delete', async (req, res) => {
  const names = Array.isArray(req.body?.filenames) ? req.body.filenames.filter((n) => typeof n === 'string' && n) : [];
  if (!names.length) return res.status(400).json({ ok: false, error: 'filenames is required' });
  if (isAnalogPushRunning()) return res.status(409).json({ ok: false, error: 'a push to the analog device is running — wait for it' });
  if (!ready(res)) return;
  try {
    res.json({ ok: true, ...(await deleteDeviceFiles(names, { force: req.body?.force === true })) });
  } catch (err) {
    fail(res, err);
  }
});
router.get('/audit', device(async ({ client }) => ({ ok: true, audit: await client.audit() })));
router.get('/backups', device(async ({ client }) => ({ ok: true, backups: await client.backups() })));
router.get('/recover/log', device(async ({ client }) => ({ ok: true, log: await client.recoverLog(50) })));
router.get('/asrun', device(async ({ client }, req) => {
  const day = DATE.test(String(req.query.day || '')) ? String(req.query.day) : localDate();
  return { ok: true, day, rows: await client.asrun(day) };
}));

// POST /api/analog/recover — play the scheduled file at its position. The API
// already does this on its own after 45s; this is the operator's manual
// trigger, confirmed in the UI. Never forced: a forced recovery replays the
// file on a HEALTHY channel too, which cuts air (handoff §6), so the device
// only acts when it reports the player stopped or frozen.
router.post('/recover', device(async ({ client }) => ({
  ok: true, result: await client.recover(false),
})));

// POST /api/analog/rollback/:name { confirm: true }
router.post('/rollback/:name', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'send { "confirm": true } to restore a backup on air' });
  if (!ready(res)) return;
  try {
    res.json({ ok: true, result: await rollbackAnalog(req.params.name) });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/analog/files?from=&to= — the files the analog blocks use in a range,
// and where each stands on the device (ready / on-disk / missing / unsupported).
router.get('/files', device(async ({ ch, client }, req) => {
  const from = DATE.test(String(req.query.from || '')) ? String(req.query.from) : localDate();
  const to = DATE.test(String(req.query.to || '')) ? String(req.query.to) : addDays(from, 6);
  const rows = filesForRange(ch.id, from, to);
  const paths = rows.map((r) => r.file_path);
  const plan = await planFiles(client, paths);
  const byPath = new Map(plan.map((p) => [p.file_path, p]));
  const { sizes, ...space } = await spaceFor(client, ch.id, paths);
  return {
    ok: true, from, to, space,
    files: rows.map((r) => ({ ...r, ...byPath.get(r.file_path), size: sizes[r.file_path] ?? null })),
  };
}));

// POST /api/analog/upload { from, to } | { paths: [...] } — upload what the device is missing.
router.post('/upload', async (req, res) => {
  const r = ready(res);
  if (!r) return;
  const b = { ...req.query, ...req.body };
  let paths = Array.isArray(b.paths) ? b.paths.map(String) : null;
  if (!paths) {
    const from = DATE.test(String(b.from || '')) ? String(b.from) : localDate();
    const to = DATE.test(String(b.to || '')) ? String(b.to) : addDays(from, 6);
    paths = filesForRange(r.ch.id, from, to).map((f) => f.file_path);
  }
  try {
    // Refuse before a single byte moves if it won't fit with the margin kept:
    // a copy that dies at 507 half way has filled the disk for nothing.
    const { sizes, ...space } = await spaceFor(r.client, r.ch.id, paths);
    if (space.fits === false) {
      const gb = (x) => `${(x / 1073741824).toFixed(1)} GB`;
      return res.status(507).json({ ok: false, space,
        error: `does not fit on Vol1: ${gb(space.bytes)} to copy, ${gb(space.free)} free — it would leave ${gb(space.after)}, `
          + `under the ${gb(space.margin)} margin. ${space.reclaimable ? `Deleting the aired programmes frees ${gb(space.reclaimable)}.` : 'Archive Vol1 so aired programmes can be deleted.'}` });
    }
    res.json({ ok: true, space, upload: await startUpload(paths) });
  } catch (err) {
    res.status(err.status ? 502 : 409).json({ ok: false, error: String(err.message || err) });
  }
});
router.get('/upload/status', (req, res) => res.json({ ok: true, upload: uploadStatus() }));
router.post('/upload/cancel', (req, res) => res.json({ ok: cancelUpload(), upload: uploadStatus() }));

// GET /api/analog/conversions — the capped copies the uploads made (≤ analog.maxBitrateKbps).
router.get('/conversions', (req, res) => res.json({ ok: true, conversions: listConversions() }));

// POST /api/analog/conversions/rollback { ids } — back to the previous copy or the
// master as it is; the capped copy is deleted from the device.
router.post('/conversions/rollback', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ ok: false, error: 'no conversions given' });
  if (!ready(res)) return;
  try {
    const results = await rollbackConversions(ids);
    res.json({ ok: true, rolledBack: results.filter((r) => r.ok).length, results, failed: results.filter((r) => !r.ok) });
  } catch (err) {
    fail(res, err);
  }
});

// ---- Vol1 inventory, archive and the week routine (services/analogVol1.js) ----

// GET /api/analog/vol1 — the last scan of the device disk, and the jobs.
router.get('/vol1', (req, res) => res.json({
  ok: true, summary: vol1Summary(), files: req.query.rows === '0' ? undefined : vol1Rows(),
  archive: archiveStatus(), routine: routineStatus(), settings: analogConfig(),
}));

// POST /api/analog/vol1/scan — read the device disk + library, classify, match to the share.
router.post('/vol1/scan', async (req, res) => {
  if (!ready(res)) return;
  try { res.json({ ok: true, summary: await scanVol1() }); } catch (err) { fail(res, err); }
});

// PUT /api/analog/vol1/kind { filenames, kind } — the operator's correction.
router.put('/vol1/kind', (req, res) => {
  const names = Array.isArray(req.body?.filenames) ? req.body.filenames.filter((n) => typeof n === 'string' && n) : [];
  if (!names.length) return res.status(400).json({ ok: false, error: 'filenames is required' });
  try { res.json({ ok: true, changed: setKind(names, String(req.body?.kind || '')) }); } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// POST /api/analog/vol1/archive { filenames? } — copy to the share what isn't there yet.
router.post('/vol1/archive', async (req, res) => {
  if (!ready(res)) return;
  const names = Array.isArray(req.body?.filenames) ? req.body.filenames.map(String) : null;
  try { res.json({ ok: true, archive: await startArchive({ filenames: names }) }); } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});
router.post('/vol1/archive/cancel', (req, res) => res.json({ ok: cancelArchive(), archive: archiveStatus() }));

// GET /api/analog/vol1/cleanup — what would be deleted; POST { confirm: true } deletes it.
router.get('/vol1/cleanup', device(async ({ ch, client }) => ({ ok: true, plan: await cleanupPlan(client, ch.id) })));
router.post('/vol1/cleanup', async (req, res) => {
  if (req.body?.confirm !== true) return res.status(400).json({ ok: false, error: 'send { "confirm": true } to delete' });
  if (isAnalogPushRunning()) return res.status(409).json({ ok: false, error: 'a push to the analog device is running — wait for it' });
  if (!ready(res)) return;
  try { res.json({ ok: true, ...(await runCleanup()) }); } catch (err) { fail(res, err); }
});

// POST /api/analog/routine { from, to } — scan, delete what aired, copy the week, push, delete the old week.
router.post('/routine', async (req, res) => {
  if (!ready(res)) return;
  const today = localDate();
  const from = DATE.test(String(req.body?.from || '')) ? String(req.body.from) : addDays(today, 1);
  const to = DATE.test(String(req.body?.to || '')) ? String(req.body.to) : addDays(today, analogConfig().daysAhead);
  if (to < from) return res.status(400).json({ ok: false, error: 'to is before from' });
  try { res.json({ ok: true, routine: await startRoutine({ from, to }) }); } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});
router.get('/routine/status', (req, res) => res.json({ ok: true, routine: routineStatus() }));
router.post('/routine/cancel', (req, res) => res.json({ ok: cancelRoutine(), routine: routineStatus() }));
