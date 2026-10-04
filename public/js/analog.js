// Analog tab: the UltraNEXUS-HD's own affairs. Scheduling and the push are the
// Schedule tab's, as for every channel; this is the device: what it airs, the
// files on its disk, its backups and its player.
import { $, api, confirmDialog, debounce, el, fmt, localToday, reportDialog, toast, withBusy } from './core.js';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return localToday(x); };
const VERDICT = {
  ok: ['tx-ok', 'on air'], stopped: ['tx-failed', 'player stopped'], frozen: ['tx-failed', 'frozen'],
  wrong_file: ['tx-blocked', 'wrong file'], no_event: ['tx-blocked', 'nothing scheduled'],
  stale_log: ['tx-blocked', 'status unknown'], unknown: ['tx-blocked', 'unknown'],
};
const STATE = {
  ready: ['tx-ok', 'ready'], 'on-disk': ['tx-converted', 'on disk — added at push'],
  missing: ['tx-missing', 'missing'], unsupported: ['tx-failed', 'unsupported container'],
};

let info = null;
let pollTimer = null;
let uploadTimer = null;
let started = false;

const row = (...cells) => el('tr', {}, ...cells.map((c) => (c instanceof Node ? el('td', {}, c) : el('td', { textContent: c ?? '' }))));
const badge = ([cls, text]) => el('span', { className: `tx-badge ${cls}`, textContent: text });
const emptyRow = (tbody, cols, text) => tbody.append(el('tr', {}, el('td', { colSpan: cols, className: 'muted', textContent: text })));

export async function loadAnalogTab() {
  if (!started) {
    started = true;
    const today = localToday();
    $('#anFrom').value = addDays(today, 1);
    $('#anTo').value = addDays(today, 6);
    $('#anAsrunDay').value = today;
    $('#anDay').value = DAYS[new Date(`${addDays(today, 1)}T00:00:00`).getDay()];
    $('#anRtFrom').value = addDays(today, 1);
    $('#anRtTo').value = addDays(today, 6);
  }
  info = await api.get('/api/analog');
  $('#anUnconfigured').hidden = info.configured;
  $('#anGuide').value = info.settings.programGuideTitle;
  if (!info.configured) {
    setVerdict(['tx-blocked', 'not set up'], '');
    return;
  }
  renderUpload(info.upload);
  if (info.upload?.running) watchUpload();
  await Promise.allSettled([refreshStatus(), loadDisk(), loadFolders(), loadBackups(), loadRecoverLog(), loadVol1()]);
  scheduleAnalogPoll();
}

function setVerdict(v, live) {
  const b = $('#anVerdict');
  b.className = `tx-badge ${v[0]}`;
  b.textContent = v[1];
  $('#anLive').textContent = live;
  $('#anNavDot').hidden = v[0] !== 'tx-failed';
}

async function refreshStatus() {
  try {
    const d = await api.get('/api/analog/status');
    const p = d.playback || {};
    if (p.error) return setVerdict(['tx-failed', 'unreachable'], p.error);
    const live = d.live?.player || {};
    const exp = p.expected;
    setVerdict(VERDICT[p.verdict] || VERDICT.unknown,
      [live.filename ? `Playing ${live.filename}${live.position ? ` @ ${live.position}` : ''}` : '',
        exp ? `scheduled: ${exp.title} (${exp.start}–${exp.end})` : '',
        p.verdict !== 'ok' ? p.detail : ''].filter(Boolean).join(' · '));
  } catch (e) {
    setVerdict(['tx-failed', 'unreachable'], e.message);
  }
}

/** Status every 30s while the tab is open and the browser tab visible. */
export function scheduleAnalogPoll() {
  clearTimeout(pollTimer);
  if (!info?.configured || document.hidden || !$('#tab-analog').classList.contains('active')) return;
  pollTimer = setTimeout(async () => { await refreshStatus(); scheduleAnalogPoll(); }, 30_000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleAnalogPoll(); });

async function loadDisk() {
  const d = await api.get('/api/analog/disk').catch((e) => ({ error: e.message }));
  $('#anDisk').textContent = d.error ? d.error
    : d.disk.map((v) => `${v.volume}: ${v.used_pct}% used · ${(v.free / 1073741824).toFixed(1)} GB free · ${v.mpegs ?? '?'} videos`).join('   ');
}

async function loadFolders() {
  const d = await api.get('/api/analog/folders');
  const sel = $('#anFolder');
  sel.innerHTML = '';
  sel.append(el('option', { value: '', textContent: '— choose —' }));
  for (const f of [...d.folders].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    sel.append(el('option', { value: String(f.folder_id), textContent: f.path || f.name }));
  }
  sel.value = info.settings.folderId != null ? String(info.settings.folderId) : '';
}

async function loadGrid() {
  const day = $('#anDay').value;
  const source = $('#anSource').value;
  const d = await api.get(`/api/analog/schedule?day=${day}&source=${source}`);
  const tb = $('#anGrid tbody');
  tb.innerHTML = '';
  if (!d.events.length) emptyRow(tb, 6, 'Nothing scheduled.');
  for (const e of d.events) {
    tb.append(row(e.time, e.end, e.length, e.title,
      e.type === 'program_guide' ? el('span', { className: 'muted', textContent: 'Program Guide' }) : e.filename,
      e.fixed ? el('span', { className: 'badge status', textContent: 'fixed', title: 'starts at its time; the rest follow on' }) : ''));
  }
  const total = d.events.reduce((n, e) => n + (e.length_s || 0), 0);
  $('#anGridCount').textContent = `${d.events.length} event(s) · ${fmt(total)}`;
}

async function checkFiles() {
  const d = await api.get(`/api/analog/files?from=${$('#anFrom').value}&to=${$('#anTo').value}`);
  const tb = $('#anFiles tbody');
  tb.innerHTML = '';
  if (!d.files.length) emptyRow(tb, 4, 'The analog channel has no blocks in these dates.');
  for (const f of d.files) {
    tb.append(row(el('span', { textContent: f.name, title: f.file_path }), f.device_filename || '—',
      badge(STATE[f.state] || ['', f.state]), f.first_date));
  }
  const missing = d.files.filter((f) => f.state === 'missing').length;
  $('#anUploadBtn').disabled = !missing;
  $('#anUploadBtn').textContent = missing ? `Upload ${missing} missing` : 'Nothing to upload';
}

function renderUpload(u) {
  const box = $('#anUploadState');
  $('#anUploadCancel').hidden = !u?.running;
  if (!u || (!u.running && !u.finishedAt)) { box.textContent = ''; return; }
  const mb = (b) => Math.round((b || 0) / 1048576);
  const head = u.running
    ? `Uploading ${u.done + 1}/${u.total}: ${u.current || '…'} · ${mb(u.bytesDone)} of ${mb(u.bytesTotal)} MB done`
    : `Last upload: ${u.uploaded.length} of ${u.total} uploaded${u.cancelled ? ' (cancelled)' : ''}${u.stoppedBy ? ` — stopped: ${u.stoppedBy}` : ''}`;
  box.textContent = head + (u.failed.length ? ` · ${u.failed.length} failed` : '');
  if (!u.running && u.failed.length) {
    const more = el('button', { className: 'mini ghost', textContent: 'see failures' });
    more.onclick = () => reportDialog('Uploads that failed', u.failed.map((f) => ({ name: f.file_path, ok: false, detail: f.error })));
    box.append(document.createTextNode(' '), more);
  }
}

function watchUpload() {
  clearTimeout(uploadTimer);
  uploadTimer = setTimeout(async () => {
    const { upload } = await api.get('/api/analog/upload/status').catch(() => ({ upload: null }));
    renderUpload(upload);
    if (upload?.running) watchUpload();
    else {
      toast(`${upload?.uploaded?.length ?? 0} file(s) uploaded to the analog device`, upload?.failed?.length ? 'bad' : 'ok', 'Upload finished');
      checkFiles().catch(() => {});
      loadDisk().catch(() => {});
    }
  }, 3000);
}

async function loadBackups() {
  const d = await api.get('/api/analog/backups');
  const tb = $('#anBackups tbody');
  tb.innerHTML = '';
  if (!d.backups.length) emptyRow(tb, 2, 'No backups yet.');
  for (const name of d.backups.slice(0, 40)) {
    const btn = el('button', { className: 'mini ghost', textContent: 'restore…' });
    btn.onclick = () => withBusy(btn, async () => {
      const ok = await confirmDialog('Put this backup on air?',
        `The whole device week goes back to ${name}. Every day pushed since then is undone on the device (the blocks stay approved here — push them again to bring them back).`,
        { confirmLabel: 'Restore on air', danger: true });
      if (!ok) return;
      await api.send('POST', `/api/analog/rollback/${encodeURIComponent(name)}`, { confirm: true });
      toast(`Device restored to ${name}`, 'ok', 'Analog');
      await loadBackups();
    });
    tb.append(row(name, btn));
  }
}

async function loadRecoverLog() {
  const d = await api.get('/api/analog/recover/log');
  const tb = $('#anRecoverLog tbody');
  tb.innerHTML = '';
  if (!d.log.length) emptyRow(tb, 2, 'No recoveries.');
  for (const r of [...d.log].reverse().slice(0, 30)) {
    const when = String(r.at || '').replace('T', ' ').slice(0, 19);
    const what = `${r.verdict_before || '?'} → ${r.result || '?'}${r.reason ? `: ${r.reason}` : ''}${r.error ? `: ${r.error}` : ''}`;
    tb.append(row(when, el('span', { textContent: what, title: r.detail_before || '' })));
  }
}

async function loadAsrun() {
  const d = await api.get(`/api/analog/asrun?day=${$('#anAsrunDay').value}`);
  const tb = $('#anAsrun tbody');
  tb.innerHTML = '';
  if (!d.rows.length) emptyRow(tb, 4, 'Nothing logged for that day.');
  for (const r of d.rows) {
    const bad = r.result && !/^(ok|played|complete)/i.test(r.result);
    tb.append(row(r.time, el('span', { textContent: r.title, title: r.filename }), `${r.played || ''} / ${r.length || ''}`,
      el('span', { className: bad ? 'tx-badge tx-failed' : 'muted', textContent: r.result || '' })));
  }
}

const busy = (fn) => (e) => withBusy(e.currentTarget, fn).catch(() => {});
$('#anRefresh').addEventListener('click', busy(() => loadAnalogTab()));
$('#anCheck').addEventListener('click', busy(async () => {
  const d = await api.get('/api/analog/check');
  const err = (x) => x?.error;
  reportDialog('Analog API', [
    { name: 'API', ok: !err(d.health), detail: err(d.health) || `${d.base} → device ${d.health.host}` },
    { name: 'publish / uploads', ok: !err(d.health) && d.health.publish_enabled && d.health.storage_writes_enabled,
      detail: err(d.health) ? '—' : `publish ${d.health.publish_enabled ? 'on' : 'OFF'} · uploads ${d.health.storage_writes_enabled ? 'on' : 'OFF'}` },
    { name: 'draft', ok: !err(d.draft) && !d.draft.stale,
      detail: err(d.draft) || (d.draft.stale ? 'changed outside the API (WinLGX?) — the next push starts again from what is on air' : 'in step') },
    { name: 'playback', ok: !err(d.playback) && d.playback.verdict === 'ok', detail: err(d.playback) || d.playback.detail || d.playback.verdict },
  ]);
}));
$('#anLoadGrid').addEventListener('click', busy(loadGrid));
$('#anFilesCheck').addEventListener('click', busy(checkFiles));
$('#anUploadBtn').addEventListener('click', busy(async () => {
  const r = await api.send('POST', '/api/analog/upload', { from: $('#anFrom').value, to: $('#anTo').value });
  renderUpload(r.upload);
  if (!r.upload.total) toast('Nothing missing on the device for these dates', 'ok', 'Analog');
  else watchUpload();
}));
$('#anUploadCancel').addEventListener('click', busy(async () => {
  await api.send('POST', '/api/analog/upload/cancel');
  toast('Cancelling after the current file is interrupted', 'info', 'Analog');
}));
$('#anAudit').addEventListener('click', busy(async () => {
  const { audit } = await api.get('/api/analog/audit');
  reportDialog('Device disk audit', [
    { name: 'scheduled but not on disk', ok: !audit.scheduled_missing_on_disk.length,
      detail: audit.scheduled_missing_on_disk.join(', ') || 'none' },
    { name: 'in library, not on disk', ok: !audit.library_missing_on_disk.length,
      detail: `${audit.library_missing_on_disk.length} resource(s)${audit.library_missing_on_disk.length ? `: ${audit.library_missing_on_disk.slice(0, 20).map((r) => r.filename).join(', ')}…` : ''}` },
    { name: 'on disk, not in library', ok: true,
      detail: `${audit.on_disk_not_in_library.length} file(s) — candidates to delete when space runs out` },
  ]);
}));
$('#anSaveSettings').addEventListener('click', busy(async () => {
  const folder = $('#anFolder').value;
  const r = await api.send('PUT', '/api/analog/settings', {
    folderId: folder === '' ? null : Number(folder), programGuideTitle: $('#anGuide').value.trim(),
  });
  info.settings = r.settings;
  toast('Analog settings saved', 'ok');
}));
$('#anRecover').addEventListener('click', busy(async () => {
  const ok = await confirmDialog('Recover playback now?',
    'Plays the scheduled file at the position it should be at — only if the device reports the player stopped or frozen (otherwise nothing happens). The analog API already does this by itself after 45s.',
    { confirmLabel: 'Recover now', danger: true });
  if (!ok) return;
  // Never force: a forced recovery replays the file even on a healthy channel,
  // which cuts air. The API acts only on 'stopped' / 'frozen'.
  const r = await api.send('POST', '/api/analog/recover', { force: false });
  const res = r.result || {};
  toast(`${res.result || 'sent'}${res.reason ? ` — ${res.reason}` : ''}${res.error ? ` — ${res.error}` : ''}`,
    res.result === 'recovered' ? 'ok' : 'info', 'Analog recovery');
  await Promise.allSettled([refreshStatus(), loadRecoverLog()]);
}));
$('#anAsrunLoad').addEventListener('click', busy(loadAsrun));

// ---- Files on the device disk ----------------------------------------------
let storage = [];
const picked = new Set();
const mbText = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : `${Math.round((b || 0) / 1048576)} MB`);
const isFree = (f) => !f.in_schedule && !f.upcoming;

function shownStorage() {
  const q = $('#anStorageSearch').value.trim().toLowerCase();
  const free = $('#anStorageFree').checked;
  return storage.filter((f) => (!q || f.filename.toLowerCase().includes(q)) && (!free || isFree(f)));
}

function renderStorage() {
  const tb = $('#anStorage tbody');
  tb.innerHTML = '';
  const shown = shownStorage();
  if (!shown.length) emptyRow(tb, 6, storage.length ? 'Nothing matches.' : 'The device disk is empty.');
  for (const f of shown.slice(0, 1500)) {
    const cb = el('input', { type: 'checkbox', checked: picked.has(f.filename) });
    cb.onchange = () => { if (cb.checked) picked.add(f.filename); else picked.delete(f.filename); updateStorageCount(); };
    const dev = f.in_schedule ? badge(['tx-failed', 'on air'])
      : f.in_library ? badge(['tx-converted', 'in library']) : el('span', { className: 'muted', textContent: 'unused' });
    const u = f.upcoming;
    const auto = !u ? el('span', { className: 'muted', textContent: f.file_path ? 'not scheduled' : '—' })
      : u.approved ? badge(['tx-failed', `airs ${u.first}`])
        : badge(['tx-blocked', `${u.drafts} draft use(s)`]);
    if (f.file_path) auto.title = f.file_path;
    tb.append(el('tr', {}, el('td', {}, cb), el('td', { textContent: f.filename }), el('td', { textContent: mbText(f.size) }),
      el('td', { textContent: f.modified || '' }), el('td', {}, dev), el('td', {}, auto)));
  }
  updateStorageCount();
}

function updateStorageCount() {
  const total = storage.reduce((n, f) => n + (f.size || 0), 0);
  const sel = storage.filter((f) => picked.has(f.filename));
  $('#anStorageCount').textContent = `${storage.length} file(s), ${mbText(total)}`
    + (sel.length ? ` · ${sel.length} selected (${mbText(sel.reduce((n, f) => n + (f.size || 0), 0))})` : '');
  $('#anStorageDelete').disabled = !sel.length;
}

async function loadStorage() {
  const d = await api.get('/api/analog/storage');
  storage = d.files.sort((a, b) => a.filename.localeCompare(b.filename));
  for (const n of [...picked]) if (!storage.some((f) => f.filename === n)) picked.delete(n);
  renderStorage();
}

async function deleteSelected() {
  const names = [...picked];
  const sel = storage.filter((f) => picked.has(f.filename));
  const bytes = sel.reduce((n, f) => n + (f.size || 0), 0);
  const ok = await confirmDialog(`Delete ${names.length} file(s) from the device?`,
    `Frees about ${mbText(bytes)} on the device disk. This can't be undone from here — the files have to be uploaded again to air.`,
    { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  let r = await api.send('POST', '/api/analog/storage/delete', { filenames: names });
  let deleted = r.deleted;
  // A file with no copy on the share is never deleted, confirmed or not.
  const unsafe = r.refused.filter((x) => x.unsafe);
  r = { ...r, refused: r.refused.filter((x) => !x.unsafe), failed: r.failed.concat(unsafe.map((x) => ({ filename: x.filename, error: x.reason }))) };
  if (r.refused.length) {
    const lines = r.refused.slice(0, 8).map((x) => `${x.filename} (${x.reason})`).join('; ')
      + (r.refused.length > 8 ? `; and ${r.refused.length - 8} more` : '');
    const force = await confirmDialog(`${r.refused.length} file(s) are still in use`,
      `${lines}. Deleting a file that is on air makes the device skip it — black for its length — until it is uploaded again. Delete them anyway?`,
      { confirmLabel: 'Delete anyway', danger: true });
    if (force) {
      const again = await api.send('POST', '/api/analog/storage/delete', { filenames: r.refused.map((x) => x.filename), force: true });
      deleted = deleted.concat(again.deleted);
      r = { ...again, failed: r.failed.concat(again.failed) };
    }
  }
  for (const d of deleted) picked.delete(d.filename);
  const freed = deleted.reduce((n, d) => n + (d.size || 0), 0);
  toast(`${deleted.length} file(s) deleted, ${mbText(freed)} freed${r.failed.length ? ` · ${r.failed.length} failed` : ''}`,
    r.failed.length ? 'bad' : 'ok', 'Device disk');
  if (r.failed.length) reportDialog('Files not deleted', r.failed.map((f) => ({ name: f.filename, ok: false, detail: f.error })));
  await Promise.allSettled([loadStorage(), loadDisk()]);
}

$('#anStorageLoad').addEventListener('click', busy(loadStorage));
$('#anOpenStorage').addEventListener('click', busy(async () => {
  await loadStorage();
  $('#anStoragePanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}));
$('#anStorageSearch').addEventListener('input', debounce(renderStorage, 200));
$('#anStorageFree').addEventListener('change', renderStorage);
$('#anStorageAll').addEventListener('change', (e) => {
  for (const f of shownStorage()) { if (e.target.checked) picked.add(f.filename); else picked.delete(f.filename); }
  renderStorage();
});
$('#anStorageDelete').addEventListener('click', busy(deleteSelected));

// ---- Vol1 inventory, archive, clean-up and the week routine ------------------
let vol1 = [];
const vPicked = new Set();
let archiveTimer = null;
let routineTimer = null;
const KIND = { filler: ['tx-ok', 'filler · keep'], movie: ['tx-converted', 'movie · keep'], program: ['tx-blocked', 'programme'] };
const SHARE = {
  pending: ['tx-missing', 'not on the share'], matched: ['tx-ok', 'matched'],
  archived: ['tx-ok', 'archived'], failed: ['tx-failed', 'archive failed'],
};
const gbText = (b) => `${((b || 0) / 1073741824).toFixed(1)} GB`;

function shownVol1() {
  const q = $('#anVol1Search').value.trim().toLowerCase();
  const kind = $('#anVol1Kind').value;
  const st = $('#anVol1State').value;
  return vol1.filter((f) => (!kind || f.kind === kind) && (!st || f.archive === st)
    && (!q || `${f.filename} ${f.title || ''} ${f.folder_path || ''}`.toLowerCase().includes(q)));
}

function renderVol1() {
  const tb = $('#anVol1 tbody');
  tb.innerHTML = '';
  const shown = shownVol1();
  if (!shown.length) emptyRow(tb, 7, vol1.length ? 'Nothing matches.' : 'Press Scan Vol1.');
  for (const f of shown.slice(0, 1500)) {
    const cb = el('input', { type: 'checkbox', checked: vPicked.has(f.filename) });
    cb.onchange = () => { if (cb.checked) vPicked.add(f.filename); else vPicked.delete(f.filename); };
    const kind = badge(KIND[f.kind] || ['', f.kind]);
    kind.title = f.kind_reason || '';
    const share = badge(SHARE[f.archive] || ['', f.archive]);
    share.title = f.archive_error || f.share_path || '';
    tb.append(el('tr', {}, el('td', {}, cb), el('td', { textContent: f.filename, title: f.title || '' }),
      el('td', { textContent: String(f.folder_path || '').replace(/^Library\/?/, '') }),
      el('td', { textContent: f.length_s != null ? fmt(Math.round(f.length_s)) : '—' }),
      el('td', { textContent: mbText(f.size) }), el('td', {}, kind), el('td', {}, share)));
  }
}

function renderVol1Summary(s) {
  if (!s?.scannedAt) { $('#anVol1Summary').textContent = 'Not scanned yet.'; return; }
  const k = (x) => `${s.byKind[x]?.files ?? 0} (${gbText(s.byKind[x]?.bytes)})`;
  const a = (x) => s.byArchive[x]?.files ?? 0;
  $('#anVol1Summary').textContent = `${s.files} file(s), ${gbText(s.bytes)} · fillers ${k('filler')} · movies ${k('movie')} · programmes ${k('program')}`
    + ` · on the share: ${a('matched')} matched, ${a('archived')} archived, ${a('pending')} not yet${a('failed') ? `, ${a('failed')} failed` : ''}`
    + ` · scanned ${String(s.scannedAt).replace('T', ' ').slice(0, 16)}`;
}

function renderArchive(a) {
  const box = $('#anVol1ArchiveState');
  $('#anVol1ArchiveCancel').hidden = !a?.running;
  $('#anVol1Archive').disabled = !!a?.running;
  if (!a || (!a.running && !a.finishedAt)) { box.textContent = ''; return; }
  box.textContent = a.running
    ? `Archiving ${a.done + 1}/${a.total}: ${a.current || '…'} · ${gbText(a.bytesDone + (a.currentBytes || 0))} of ${gbText(a.bytesTotal)}${a.waiting ? ` — waiting: ${a.waiting}` : ''}`
    : `Last archive: ${a.archived.length} of ${a.total} copied${a.cancelled ? ' (stopped)' : ''}${a.catalogued ? `, ${a.catalogued} catalogued` : ''}`;
  if (a.failed.length) {
    const more = el('button', { className: 'mini ghost', textContent: `${a.failed.length} failed` });
    more.onclick = () => reportDialog('Files not archived', a.failed.map((f) => ({ name: f.filename, ok: false, detail: f.error })));
    box.append(document.createTextNode(' '), more);
  }
}

function renderRoutine(r) {
  $('#anRtCancel').hidden = !r?.running;
  $('#anRtRun').disabled = !!r?.running;
  if (!r || (!r.running && !r.finishedAt)) { $('#anRtState').textContent = ''; $('#anRtLog').textContent = ''; return; }
  const u = r.upload;
  $('#anRtState').textContent = r.running
    ? `${r.from} → ${r.to}: ${r.step}${u?.running ? ` (${u.done}/${u.total}, ${gbText(u.bytesDone)} of ${gbText(u.bytesTotal)})` : ''}`
    : `${r.from} → ${r.to}: ${r.error ? `stopped — ${r.error}` : 'done'} (${String(r.finishedAt).replace('T', ' ').slice(0, 16)})`;
  $('#anRtState').className = r.error ? 'tx-badge tx-failed' : 'muted';
  $('#anRtLog').textContent = r.log.join('\n');
}

async function loadVol1() {
  const d = await api.get('/api/analog/vol1');
  vol1 = d.files || [];
  for (const n of [...vPicked]) if (!vol1.some((f) => f.filename === n)) vPicked.delete(n);
  $('#anArchiveDir').textContent = d.settings.archiveDir;
  $('#anArchiveDirInput').value = d.settings.archiveDir;
  $('#anMinFree').value = d.settings.minFreeGb;
  renderVol1Summary(d.summary);
  renderVol1();
  renderArchive(d.archive);
  renderRoutine(d.routine);
  if (d.archive?.running) watchArchive();
  if (d.routine?.running) watchRoutine();
}

function watchArchive() {
  clearTimeout(archiveTimer);
  archiveTimer = setTimeout(async () => {
    const d = await api.get('/api/analog/vol1?rows=0').catch(() => null);
    if (!d) return watchArchive();
    renderArchive(d.archive);
    renderVol1Summary(d.summary);
    if (d.archive.running) watchArchive();
    else {
      toast(`${d.archive.archived.length} file(s) archived to the share`, d.archive.failed.length ? 'bad' : 'ok', 'Vol1');
      loadVol1().catch(() => {});
    }
  }, 3000);
}

function watchRoutine() {
  clearTimeout(routineTimer);
  routineTimer = setTimeout(async () => {
    const d = await api.get('/api/analog/routine/status').catch(() => null);
    if (!d) return watchRoutine();
    renderRoutine(d.routine);
    if (d.routine.running) watchRoutine();
    else {
      toast(d.routine.error ? `Stopped: ${d.routine.error}` : 'Week copied and pushed', d.routine.error ? 'bad' : 'ok', 'Week routine');
      Promise.allSettled([loadVol1(), loadDisk(), loadBackups()]);
    }
  }, 3000);
}

$('#anVol1Scan').addEventListener('click', busy(async () => {
  const r = await api.send('POST', '/api/analog/vol1/scan');
  toast(`${r.summary.files} file(s) on Vol1`, 'ok', 'Vol1 scanned');
  await loadVol1();
}));
$('#anVol1Archive').addEventListener('click', busy(async () => {
  const pending = vol1.filter((f) => f.archive === 'pending' || f.archive === 'failed');
  const picked = pending.filter((f) => vPicked.has(f.filename));
  const list = picked.length ? picked : pending;
  if (!list.length) return toast('Everything on Vol1 is already on the share', 'ok', 'Vol1');
  const bytes = list.reduce((n, f) => n + (f.size || 0), 0);
  const ok = await confirmDialog(`Archive ${list.length} file(s) to the share?`,
    `${gbText(bytes)} copied from the device to ${$('#anArchiveDir').textContent} — at the device's FTP speed this can take hours or days, so it runs in the background and can be stopped and resumed. It steps aside whenever a push or an upload needs the device.`,
    { confirmLabel: 'Start archiving' });
  if (!ok) return;
  const r = await api.send('POST', '/api/analog/vol1/archive', picked.length ? { filenames: picked.map((f) => f.filename) } : {});
  renderArchive(r.archive);
  watchArchive();
}));
$('#anVol1ArchiveCancel').addEventListener('click', busy(async () => {
  await api.send('POST', '/api/analog/vol1/archive/cancel');
  toast('Stopping — the partial copy is kept and resumed next time', 'info', 'Vol1');
}));
$('#anVol1Cleanup').addEventListener('click', busy(async () => {
  const { plan } = await api.get('/api/analog/vol1/cleanup');
  if (!plan.delete.length) {
    return toast(`Nothing to delete (${plan.kept.onAir} on air, ${plan.kept.upcoming} still scheduled, ${plan.kept.notArchived} not on the share yet)`, 'info', 'Vol1');
  }
  const ok = await confirmDialog(`Delete ${plan.delete.length} aired programme(s) from Vol1?`,
    `Frees ${gbText(plan.bytes)}. Every one of them has a checked copy on the share and nothing from today on uses it. Kept: ${plan.kept.onAir} on air, ${plan.kept.upcoming} still scheduled, ${plan.kept.notArchived} not on the share yet; fillers and movies always stay.`,
    { confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const r = await api.send('POST', '/api/analog/vol1/cleanup', { confirm: true });
  toast(`${r.deleted.length} deleted, ${gbText(r.deleted.reduce((n, d) => n + (d.size || 0), 0))} freed`, r.failed.length ? 'bad' : 'ok', 'Vol1');
  await Promise.allSettled([loadVol1(), loadDisk()]);
}));
$('#anVol1Search').addEventListener('input', debounce(renderVol1, 200));
$('#anVol1Kind').addEventListener('change', renderVol1);
$('#anVol1State').addEventListener('change', renderVol1);
$('#anVol1All').addEventListener('change', (e) => {
  for (const f of shownVol1()) { if (e.target.checked) vPicked.add(f.filename); else vPicked.delete(f.filename); }
  renderVol1();
});
$('#anVol1SetKind').addEventListener('change', async (e) => {
  const kind = e.target.value;
  e.target.value = '';
  if (!kind || !vPicked.size) { if (kind) toast('Select some files first', 'info', 'Vol1'); return; }
  await api.send('PUT', '/api/analog/vol1/kind', { filenames: [...vPicked], kind });
  for (const f of vol1) if (vPicked.has(f.filename)) { f.kind = kind; f.kind_manual = 1; f.kind_reason = 'set by hand'; }
  renderVol1();
  toast(`${vPicked.size} file(s) set to ${kind}`, 'ok', 'Vol1');
});
$('#anRtRun').addEventListener('click', busy(async () => {
  const from = $('#anRtFrom').value;
  const to = $('#anRtTo').value;
  const ok = await confirmDialog(`Run the week routine for ${from} → ${to}?`,
    'Deletes aired programmes that are safe on the share, copies what the approved days need, pushes those days to the device (replacing their weekdays) and then deletes what the old week used.',
    { confirmLabel: 'Run' });
  if (!ok) return;
  const r = await api.send('POST', '/api/analog/routine', { from, to });
  renderRoutine(r.routine);
  watchRoutine();
}));
$('#anRtCancel').addEventListener('click', busy(async () => {
  await api.send('POST', '/api/analog/routine/cancel');
  toast('Cancelling after the current step', 'info', 'Week routine');
}));
$('#anSaveVol1Settings').addEventListener('click', busy(async () => {
  await api.send('PUT', '/api/analog/settings', { archiveDir: $('#anArchiveDirInput').value.trim(), minFreeGb: Number($('#anMinFree').value) });
  toast('Vol1 settings saved', 'ok');
  await loadVol1();
}));
