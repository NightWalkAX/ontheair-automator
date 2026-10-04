import { $, api, confirmDialog, el, fmt, toast, withBusy } from './core.js';
import { scheduleChannels, set_scheduleChannels } from './schedule.js';

// ---- Air Spec (ffmpeg normalisation) ---------------------------------------
// The run is a background routine measured in hours, so this panel is built to
// be LEFT OPEN and to survive being closed: everything on screen is re-derived
// from GET /api/transcode/status, and the live extras (per-clip percentage, log
// lines) arrive on one SSE stream that is opened once and kept.

const TX_STATUS_LABELS = {
  ok: 'on spec', pending: 'queued', running: 'converting', converted: 'waiting to replace',
  blocked: 'blocked', replaced: 'replaced', failed: 'failed', skipped: 'skipped',
  missing: 'unreadable', stale: 'probe again',
};
const TX_COUNTER_ORDER = ['pending', 'running', 'converted', 'blocked', 'stale', 'replaced', 'failed', 'ok', 'skipped', 'missing'];

let txConfig = null;
let txState = null;
let txFilter = null;      // status filter for the clip table
let txStream = null;      // EventSource
let txTicker = null;      // 1s repaint of the elapsed clock
let txReloadTimer = null; // debounced item-table reload
let txStartedAt = null;

const txPct = (v) => `${Math.round((v || 0) * 100)}%`;

function txDur(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s % 60).padStart(2, '0')}s`;
}
const txElapsedText = (fromMs) => (fromMs ? txDur((Date.now() - fromMs) / 1000) : '');

function txLogLine(message, kind = '') {
  const log = $('#txLog');
  if (!log) return;
  log.append(el('li', { className: kind === 'warn' ? '' : kind, textContent: message }));
  while (log.children.length > 200) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

// The banner is read by an operator, not by ffmpeg. "30000/1001" is the exact
// way to write 29.97 and the only way to encode it, but nobody should have to
// do that division in their head to check the house format — so the chips are
// plain language and the exact values sit in the tooltip.
const SPEC_LABELS = {
  libx264: 'H.264', libx265: 'HEVC',
  yuv420p: '8-bit 4:2:0', yuv422p: '8-bit 4:2:2',
  pcm_s16le: 'PCM 16-bit', pcm_s24le: 'PCM 24-bit', aac: 'AAC',
};
const specLabel = (v) => SPEC_LABELS[v] || v;

/** "30000/1001" -> "29.97"; a whole rate keeps its integer form. */
function fpsLabel(fps) {
  const s = String(fps);
  if (!s.includes('/')) return s;
  const [n, d] = s.split('/').map(Number);
  if (!d) return s;
  const v = n / d;
  return (Math.round(v * 100) / 100).toFixed(2).replace(/\.00$/, '');
}

const CHANNEL_LABELS = { 1: 'mono', 2: 'stereo' };

function renderSpecBanner() {
  const box = $('#specBanner');
  if (!box || !txConfig) return;
  const t = txConfig.target;
  box.innerHTML = '';
  const chip = (label, value, title = '') => {
    const s = el('span', { className: 'spec-chip', title });
    s.append(el('b', { textContent: label }), document.createTextNode(` ${value}`));
    return s;
  };
  box.append(
    chip('Video',
      `${t.width}×${t.height} · ${fpsLabel(t.fps)} fps · ${specLabel(t.vcodec)} ${specLabel(t.pixFmt)}`,
      `${t.vcodec} ${t.pixFmt}, ${t.fps} fps exactly, CRF ${t.crf}, preset ${t.preset}`),
    chip('Audio',
      `${specLabel(t.acodec)} · ${t.sampleRate / 1000} kHz · ${CHANNEL_LABELS[t.audioChannels] || `${t.audioChannels} ch`}`,
      `${t.acodec} ${t.sampleRate} Hz ${t.audioChannels} channel(s) — what the CLIP carries, `
      + 'not what the playout card outputs'),
    chip('Container', t.container),
    chip('Originals →', txConfig.archiveDir),
  );
  box.append(el('span', {
    className: 'muted spec-note',
    textContent: `${txConfig.concurrency} clip at a time · ${txConfig.order} first`
      + ` · edit config/config.json → "transcode" to change the spec`,
  }));
  box.append(renderExportedDaysSwitch());
}

/**
 * The exported-day repair switch.
 *
 * A converted clip changes name, so a day already pushed to OTAV names a file
 * that is about to move. On, that playlist is repaired (the clip re-pointed in
 * place, or the day pushed again when the runtime moved); off, the clip waits
 * for the operator. It lives on the spec banner rather than in the toolbar
 * because it is NOT a per-run choice like "replace each clip as it verifies" —
 * it also governs the Replace button on a single row, and it is saved to
 * config.json.
 */
function renderExportedDaysSwitch() {
  const policy = txConfig?.exportedDays || {};
  const fixes = policy.mode === 'fix';
  const wrap = el('label', { className: 'spec-switch' });
  const box = el('input', { type: 'checkbox', checked: fixes });
  box.disabled = !!policy.overridden;

  const text = el('span', {});
  text.append(el('b', { textContent: 'Repair days already pushed to OTAV' }));
  text.append(el('span', {
    className: 'hint',
    textContent: policy.overridden
      ? `forced to "${policy.mode}" by the ${policy.overridden} environment variable`
      : (fixes
        ? 'On: when a converted clip changes name, the playlist on the playout Mac is re-pointed'
          + ' at the new file — or that day is pushed again if the new runtime changes the block’s'
          + ' fit. Nothing on air, starting soon, or on today’s playlist is ever rebuilt.'
        : 'Off: a clip whose day is already pushed stays queued until you push those days again,'
          + ' or force the swap from its row. Saved to config.json.'),
  }));

  box.onchange = async () => {
    const mode = box.checked ? 'fix' : 'block';
    wrap.classList.add('saving');
    try {
      const r = await api.send('PUT', '/api/transcode/exported-days', { mode });
      txConfig = { ...txConfig, exportedDays: r.exportedDays };
      toast(mode === 'fix'
        ? 'Days already pushed will be repaired on OTAV'
        : 'Days already pushed will wait for a manual re-push', 'ok');
    } catch (err) {
      toast(`Could not save: ${err.message}`, 'bad');
    } finally {
      wrap.classList.remove('saving');
      renderSpecBanner();   // redraw from what the server actually stored
    }
  };

  wrap.append(box, text);
  return wrap;
}

// ---- House spec editor -----------------------------------------------------
// The form is filled FROM the saved spec and always re-filled from what the
// server actually stored after a save, so what is on screen is never a guess
// about what a clip will be converted to.

const SPEC_SELECTS = ['fps', 'container', 'vcodec', 'pixFmt', 'preset', 'acodec', 'sampleRate', 'audioChannels'];

/** Put a value in a select, adding an option for it when the list lacks one. */
function selectValue(sel, value) {
  const v = String(value);
  if (!sel) return;
  if (![...sel.options].some((o) => o.value === v)) {
    sel.append(el('option', { value: v, textContent: `${v} · from config.json` }));
  }
  sel.value = v;
}

function fillSpecForm() {
  const form = $('#specForm');
  if (!form || !txConfig) return;
  const t = txConfig.target;
  for (const name of SPEC_SELECTS) selectValue(form.elements[name], t[name]);
  form.elements.crf.value = t.crf ?? 18;
  form.elements.enforceContainer.checked = !!t.enforceContainer;
  form.elements.width.value = t.width;
  form.elements.height.value = t.height;

  const res = $('#specResolution');
  const pair = `${t.width}x${t.height}`;
  const known = [...res.options].some((o) => o.value === pair);
  res.value = known ? pair : 'custom';
  syncResolutionFields();
  $('#specDirty').textContent = '';
}

/** The width/height boxes only exist for a resolution the list doesn't offer. */
function syncResolutionFields() {
  const custom = $('#specResolution').value === 'custom';
  $('#specWidthField').hidden = !custom;
  $('#specHeightField').hidden = !custom;
}

/** The form as the API wants it. */
function readSpecForm() {
  const form = $('#specForm');
  const res = $('#specResolution').value;
  const [w, h] = res === 'custom'
    ? [form.elements.width.value, form.elements.height.value]
    : res.split('x');
  const body = { width: Number(w), height: Number(h), crf: Number(form.elements.crf.value),
    enforceContainer: form.elements.enforceContainer.checked };
  for (const name of SPEC_SELECTS) body[name] = form.elements[name].value;
  body.sampleRate = Number(body.sampleRate);
  body.audioChannels = Number(body.audioChannels);
  return body;
}

function wireSpecForm() {
  const form = $('#specForm');
  if (!form || form.dataset.wired) return;
  form.dataset.wired = '1';

  $('#specResolution').addEventListener('change', syncResolutionFields);
  form.addEventListener('input', () => {
    $('#specDirty').textContent = 'unsaved changes';
  });
  $('#btnSpecReset').addEventListener('click', () => { fillSpecForm(); toast('Form reset to the saved spec', 'info'); });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    withBusy($('#btnSpecSave'), async () => {
      // Say what the save costs before it costs it: a spec change re-judges
      // every clip, and clips already converted go back in the queue.
      const c = txState?.counts || {};
      const atRisk = (c.converted || 0) + (c.blocked || 0) + (c.replaced || 0) + (c.ok || 0);
      if (atRisk) {
        const parts = [];
        if (c.ok) parts.push(`${c.ok} judged on spec`);
        if (c.converted || c.blocked) parts.push(`${(c.converted || 0) + (c.blocked || 0)} converted and waiting`);
        if (c.replaced) parts.push(`${c.replaced} already swapped in`);
        const ok = await confirmDialog('Change the house spec',
          `${parts.join(', ')}. Those judgements were made against the CURRENT spec: clips waiting to be `
          + 'swapped in go back in the queue to be re-encoded, and clips already swapped in are set aside '
          + 'until you probe the library again. Nothing on disk is touched by this save. Continue?',
          { confirmLabel: 'Save the new spec', danger: true });
        if (!ok) return;
      }
      let r;
      try {
        r = await api.send('PUT', '/api/transcode/target', readSpecForm());
      } catch (err) {
        toast(err.message, 'bad', 'Spec not saved');
        return;
      }
      txConfig = { ...txConfig, target: r.target };
      renderSpecBanner();
      fillSpecForm();
      if (!r.changed) {
        toast('That is already the saved spec — nothing was re-judged', 'info');
      } else {
        toast(`${r.reclassified} clip(s) re-judged · ${r.requeued} queued`
          + (r.stale ? ` · ${r.stale} need the library probed again` : ''), 'ok', 'Spec saved');
      }
      await Promise.all([refreshTxStatus(), loadTxItems()]);
    });
  });
}

function renderTxCounters() {
  const host = $('#txCounters');
  if (!host) return;
  const counts = txState?.counts || {};
  host.innerHTML = '';
  if (!counts.total) {
    host.append(el('span', {
      className: 'muted',
      textContent: 'Nothing probed yet — run “Probe library” to find out which clips are off spec.',
    }));
    return;
  }
  for (const status of TX_COUNTER_ORDER) {
    const n = counts[status];
    if (!n) continue;
    const b = el('button', {
      className: `tx-counter tx-${status}${txFilter === status ? ' active' : ''}`,
      title: `Show only clips that are ${TX_STATUS_LABELS[status]}`,
    });
    b.append(el('b', { textContent: String(n) }), el('span', { textContent: TX_STATUS_LABELS[status] }));
    b.onclick = () => {
      txFilter = txFilter === status ? null : status;
      renderTxCounters();
      loadTxItems();
    };
    host.append(b);
  }
}

function renderTxState() {
  if (!txState) return;
  const phase = txState.phase;
  const pill = $('#txPhase');
  pill.textContent = phase === 'convert'
    ? (txState.stopRequested ? 'converting · stopping' : 'converting')
    : phase === 'scan' ? 'probing' : 'idle';
  pill.className = `mount-pill ${phase === 'idle' ? 'off' : 'on'}`;

  const queuePct = txState.total ? txState.done / txState.total : 0;
  $('#txQueueFill').style.width = txPct(queuePct);
  $('#txQueueCounts').textContent = txState.total
    ? `${txState.done}/${txState.total} clips this run`
    : (txState.counts?.pending ? `${txState.counts.pending} clip(s) queued` : '');
  $('#txElapsed').textContent = txStartedAt ? `${txElapsedText(txStartedAt)} elapsed` : '';

  const cur = txState.running?.[0];
  if (cur) {
    const bits = [cur.name];
    if (cur.pct != null) bits.push(txPct(cur.pct));
    if (cur.speed) bits.push(`${cur.speed.toFixed(2)}× realtime`);
    if (cur.etaSeconds != null) bits.push(`~${txDur(cur.etaSeconds)} left`);
    if (cur.startedAtMs) bits.push(`${txElapsedText(cur.startedAtMs)} on this clip`);
    $('#txCurrent').textContent = bits.filter(Boolean).join(' · ');
    $('#txClipFill').style.width = txPct(cur.pct);
  } else {
    $('#txCurrent').textContent = phase === 'scan' ? 'Probing files with ffprobe…' : 'Nothing running.';
    if (phase !== 'convert') $('#txClipFill').style.width = '0%';
  }

  const busy = phase !== 'idle';
  $('#btnTxScan').disabled = busy;
  $('#btnTxStart').disabled = busy;
  $('#btnTxStop').disabled = !busy || txState.stopRequested;
  $('#btnTxAbort').disabled = !busy;
  renderTxCounters();
}

// The server reports how long the clip in flight has been going as a snapshot;
// turning it into a wall-clock start lets the 1s ticker keep counting instead of
// showing a frozen number between status fetches.
function txStampRunning(state) {
  for (const r of state.running || []) r.startedAtMs = Date.now() - (r.elapsedMs || 0);
  return state;
}

async function refreshTxStatus() {
  txState = txStampRunning(await api.get('/api/transcode/status'));
  if (txState.startedAt) txStartedAt = txState.startedAt;
  else if (txState.phase === 'idle') txStartedAt = null;
  renderTxState();
}

function scheduleTxItemReload() {
  clearTimeout(txReloadTimer);
  txReloadTimer = setTimeout(() => loadTxItems().catch(() => {}), 1500);
}

function openTxStream() {
  if (txStream) return;
  const es = new EventSource('/api/transcode/events');
  txStream = es;
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === 'state') {
      txState = txStampRunning({ ...(txState || {}), ...ev });
      txStartedAt = ev.startedAt || (ev.phase === 'idle' ? null : txStartedAt);
      renderTxState();
      scheduleTxItemReload();
    } else if (ev.type === 'progress') {
      if (txState) { txState.done = ev.done; txState.total = ev.total; renderTxState(); }
    } else if (ev.type === 'progress-item') {
      if (txState?.running?.length) {
        Object.assign(txState.running[0], { pct: ev.pct, speed: ev.speed, etaSeconds: ev.etaSeconds });
        renderTxState();
      }
    } else if (ev.type === 'item') {
      if (ev.message) txLogLine(`${ev.message}: ${ev.file_path.split('/').pop()}`,
        ev.status === 'failed' ? 'bad' : ev.status === 'replaced' ? 'ok' : '');
      refreshTxStatus().catch(() => {});
      scheduleTxItemReload();
    } else if (ev.type === 'phase') {
      txLogLine(ev.message);
      refreshTxStatus().catch(() => {});
    } else if (ev.type === 'log') {
      txLogLine(ev.message, ev.kind === 'warn' ? 'bad' : ev.kind);
    }
  };
  // The browser reconnects on its own; a dropped stream must not look like a
  // dead run, so the status poll below keeps the panel honest either way.
  es.onerror = () => {};
}

function txRowActions(item) {
  const wrap = el('div', { className: 'row-actions' });
  const act = (label, title, fn, cls = 'mini ghost') => {
    const b = el('button', { className: cls, textContent: label, title });
    b.onclick = () => withBusy(b, fn);
    wrap.append(b);
  };
  if (item.status === 'converted' || item.status === 'blocked') {
    act('↔ Replace', 'Archive the original and put the converted file in its place', async () => {
      const force = item.status === 'blocked';
      if (force) {
        const ok = await confirmDialog('Replace anyway',
          'OTAV already has playlists that point at this file’s old name, and they could not be '
          + 'repaired — the reason is on the row. Forcing the swap now means those days name a file '
          + 'that has moved to the archive, so they have to be pushed again before they air. Continue?',
          { confirmLabel: 'Replace anyway', danger: true });
        if (!ok) return;
      }
      await api.send('POST', `/api/transcode/items/${item.id}/replace${force ? '?force=1' : ''}`);
      toast('Replaced — original archived', 'ok');
      await Promise.all([refreshTxStatus(), loadTxItems()]);
    }, item.status === 'blocked' ? 'mini danger' : 'mini');
  }
  if (item.status === 'failed' || item.status === 'skipped' || item.status === 'blocked') {
    act('↻ Retry', item.status === 'blocked'
      ? 'Try the swap (and the OTAV playlist repair) again'
      : 'Put this clip back in the queue', async () => {
      await api.send('POST', `/api/transcode/items/${item.id}/retry`);
      await Promise.all([refreshTxStatus(), loadTxItems()]);
    });
  }
  if (['pending', 'failed', 'missing'].includes(item.status)) {
    act('✕ Skip', 'Leave this clip exactly as it is', async () => {
      await api.send('POST', `/api/transcode/items/${item.id}/skip`);
      await Promise.all([refreshTxStatus(), loadTxItems()]);
    });
  }
  return wrap;
}

async function loadTxItems() {
  const tbody = $('#txTable tbody');
  if (!tbody) return;
  const channel = $('#txChannel').value;
  const q = new URLSearchParams({ limit: '400' });
  if (txFilter) q.set('status', txFilter);
  if (channel) q.set('channel', channel);
  const r = await api.get(`/api/transcode/items?${q}`);
  $('#txFilterLabel').textContent = txFilter
    ? `· ${TX_STATUS_LABELS[txFilter]} only` : '· queue first, then the rest';
  tbody.innerHTML = '';
  if (!r.items.length) {
    tbody.append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', textContent: 'Nothing to show.' })));
    return;
  }
  const labels = txState?.reasonLabels || {};
  for (const it of r.items) {
    const tr = el('tr', { className: `tx-row tx-row-${it.status}` });
    const nameCell = el('td', {});
    nameCell.append(el('div', { textContent: it.name || it.file_path.split('/').pop() }));
    nameCell.append(el('div', { className: 'muted tx-path', textContent: it.file_path }));
    tr.append(nameCell);
    tr.append(el('td', {
      className: 'muted',
      textContent: it.width
        ? `${it.width}×${it.height} · ${(it.fps || 0).toFixed(3)} fps · ${it.vcodec || '?'}`
          + ` / ${it.acodec || 'no audio'}${it.sample_rate ? ` ${Math.round(it.sample_rate / 1000)}k` : ''}`
        : '—',
    }));
    let reasons = [];
    try { reasons = JSON.parse(it.reasons || '[]'); } catch { reasons = []; }
    tr.append(el('td', {
      className: 'muted',
      textContent: reasons.length ? reasons.map((x) => labels[x] || x).join(', ') : '—',
    }));
    tr.append(el('td', { textContent: it.src_duration ? fmt(it.src_duration) : '—' }));
    const status = el('td', {});
    status.append(el('span', {
      className: `tx-badge tx-${it.status}`,
      textContent: it.status === 'running'
        ? `converting ${txPct(it.progress)}` : TX_STATUS_LABELS[it.status] || it.status,
    }));
    if (it.error) status.append(el('div', { className: 'muted tx-err', textContent: it.error }));
    tr.append(status);
    tr.append(el('td', {}, txRowActions(it)));
    tbody.append(tr);
  }
}

export async function loadTranscodeTab() {
  if (!txConfig) {
    txConfig = await api.get('/api/transcode/config');
    renderSpecBanner();
    wireSpecForm();
    fillSpecForm();
    $('#txAutoReplace').checked = txConfig.autoReplace;
  }
  const sel = $('#txChannel');
  if (!sel.options.length) {
    const chans = scheduleChannels.length ? scheduleChannels : await api.get('/api/channels');
    set_scheduleChannels(chans);
    sel.append(el('option', { value: '', textContent: 'All channels' }));
    for (const c of chans) sel.append(el('option', { value: String(c.id), textContent: c.name }));
    sel.onchange = () => loadTxItems().catch(() => {});
  }
  openTxStream();
  if (!txTicker) txTicker = setInterval(() => { if (txState) renderTxState(); }, 1000);
  await refreshTxStatus();
  await loadTxItems();
}

$('#btnTxScan').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const channel = $('#txChannel').value;
  const force = $('#txForceProbe').checked;
  const q = new URLSearchParams({ fillers: $('#txFillers').checked ? '1' : '0' });
  if (channel) q.set('channel', channel);
  if (force) q.set('force', '1');
  // Say the SCOPE out loud. The list comes from the catalogue, so "every
  // channel" means every catalogued clip — not everything on the NAS.
  const where = channel
    ? ($('#txChannel').selectedOptions[0]?.textContent || 'that channel')
    : 'every channel';
  if (force) {
    const ok = await confirmDialog('Re-probe everything',
      `This runs ffprobe again on every clip catalogued for ${where}, including the ones that `
      + 'have not changed since the last check — one process and one read over the share each. '
      + 'Leave it off unless you think a verdict is wrong. Continue?',
      { confirmLabel: 'Re-probe everything' });
    if (!ok) return;
  }
  const r = await api.send('POST', `/api/transcode/scan?${q}`);
  toast(`${r.total} catalogued clip(s) for ${where}`
    + (force ? ' — re-probing all of them' : ' — only the changed ones get re-probed'),
  'ok', 'Check started');
  await refreshTxStatus();
}));

$('#btnTxStart').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const pending = txState?.counts?.pending || 0;
  const limit = Number($('#txLimit').value) || null;
  const n = limit ? Math.min(limit, pending) : pending;
  const replace = $('#txAutoReplace').checked;
  const ok = await confirmDialog('Start converting',
    `${n} clip(s) will be re-encoded to ${txConfig.target.width}×${txConfig.target.height} @ `
    + `${txConfig.target.fps} with ${txConfig.target.acodec} audio, `
    + `${txConfig.concurrency} at a time. This takes hours — it re-encodes full features over the share. `
    + (replace
      ? 'Each clip is verified, its original archived, and the new file put in its place as it finishes.'
      : 'Converted clips will WAIT in the archive folder until you replace them by hand.')
    + ' You can stop it at any point; whatever was already replaced stays replaced.',
    { confirmLabel: 'Start the run', danger: true });
  if (!ok) return;
  const q = new URLSearchParams({ replace: replace ? '1' : '0' });
  const channel = $('#txChannel').value;
  if (channel) q.set('channel', channel);
  if (limit) q.set('limit', String(limit));
  const r = await api.send('POST', `/api/transcode/start?${q}`);
  toast(`Converting ${r.total} clip(s) — leave this running`, 'ok', 'Run started');
  await refreshTxStatus();
}));

$('#btnTxStop').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  await api.send('POST', '/api/transcode/stop');
  toast('Will stop once the clip in flight finishes', 'ok');
  await refreshTxStatus();
}));

$('#btnTxAbort').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const ok = await confirmDialog('Abort now',
    'ffmpeg is killed immediately and the half-written work file is thrown away. Clips already '
    + 'replaced stay replaced; the clip in flight goes back in the queue. Originals are never touched.',
    { confirmLabel: 'Abort now', danger: true });
  if (!ok) return;
  await api.send('POST', '/api/transcode/stop?now=1');
  toast('Aborted', 'ok');
  await refreshTxStatus();
}));

$('#btnTxReplacePending').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const waiting = (txState?.counts?.converted || 0) + (txState?.counts?.blocked || 0);
  if (!waiting) return toast('Nothing is waiting to be replaced', 'info');
  const ok = await confirmDialog('Replace all waiting',
    `${waiting} converted clip(s) will be swapped in: each original is archived and the new file takes `
    + 'its place. Clips whose days are already exported to OTAV stay blocked — replace those one by one.',
    { confirmLabel: 'Replace them', danger: true });
  if (!ok) return;
  const r = await api.send('POST', '/api/transcode/replace-pending');
  toast(`${r.replaced} replaced${r.failed.length ? `, ${r.failed.length} could not be` : ''}`,
    r.failed.length ? 'bad' : 'ok');
  await Promise.all([refreshTxStatus(), loadTxItems()]);
  return undefined;
}));

$('#btnTxReload').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  await Promise.all([refreshTxStatus(), loadTxItems()]);
}));

