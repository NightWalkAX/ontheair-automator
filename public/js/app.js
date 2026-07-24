// Admin review UI logic. Vanilla ES modules, no framework/bundler.

const api = {
  async get(url) {
    const r = await fetch(url);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  },
  async send(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    return data;
  },
};

const fmt = (s) => {
  s = Math.round(s);
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

// ---- Toasts ----------------------------------------------------------------
const ICONS = { ok: '✓', bad: '✕', info: 'ℹ' };
function toast(message, kind = 'info', title = '') {
  const host = $('#toasts');
  const t = el('div', { className: `toast ${kind}` });
  t.append(el('span', { className: 't-icon', textContent: ICONS[kind] || ICONS.info }));
  const body = el('div', { className: 't-body' });
  if (title) body.append(el('div', { className: 't-title', textContent: title }));
  body.append(el('div', { textContent: message }));
  t.append(body);
  const close = el('button', { className: 't-close', textContent: '×' });
  const dismiss = () => { t.classList.add('leaving'); setTimeout(() => t.remove(), 240); };
  close.onclick = dismiss;
  t.append(close);
  host.append(t);
  if (kind !== 'bad') setTimeout(dismiss, 4200);
  return t;
}

// ---- Generic dialog (confirm / report) -------------------------------------
function closeDialog() { $('#dialog').classList.add('hidden'); }
$('#dialogClose').addEventListener('click', closeDialog);
$('#dialog').addEventListener('click', (e) => { if (e.target.id === 'dialog') closeDialog(); });

function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = title;
    const content = $('#dialogContent');
    content.innerHTML = '';
    content.append(el('p', { className: 'dialog-msg', textContent: message }));
    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: danger ? 'danger' : 'primary', textContent: confirmLabel });
    cancel.onclick = () => { closeDialog(); resolve(false); };
    ok.onclick = () => { closeDialog(); resolve(true); };
    actions.append(cancel, ok);
    $('#dialog').classList.remove('hidden');
    ok.focus();
  });
}

function reportDialog(title, rows) {
  // rows: [{ name, ok, detail }]
  $('#dialogTitle').textContent = title;
  const content = $('#dialogContent');
  content.innerHTML = '';
  const ul = el('ol', { className: 'report-list' });
  for (const row of rows) {
    const li = el('li', { className: row.ok ? 'r-ok' : 'r-bad' });
    li.append(el('span', { className: 'r-name', textContent: row.name }));
    li.append(el('span', { textContent: row.detail || '', className: 'muted' }));
    li.append(el('span', { className: `r-status ${row.ok ? 'ok' : 'bad'}`, textContent: row.ok ? '✓' : '✕' }));
    ul.append(li);
  }
  content.append(ul);
  const actions = $('#dialogActions');
  actions.innerHTML = '';
  const done = el('button', { className: 'primary', textContent: 'Done' });
  done.onclick = closeDialog;
  actions.append(done);
  $('#dialog').classList.remove('hidden');
  done.focus();
}

// Run an async action with a button spinner + unified error toast.
async function withBusy(btn, fn) {
  if (btn) { btn.classList.add('is-busy'); btn.disabled = true; }
  try {
    return await fn();
  } catch (e) {
    toast(e.message || String(e), 'bad', 'Error');
    throw e;
  } finally {
    if (btn) { btn.classList.remove('is-busy'); btn.disabled = false; }
  }
}

// ---- Theme -----------------------------------------------------------------
const THEME_KEY = 'otav-theme';
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#themeToggle').textContent = theme === 'dark' ? '☀️' : '🌙';
}
applyTheme(localStorage.getItem(THEME_KEY) || 'light');
$('#themeToggle').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// ---- Tabs ------------------------------------------------------------------
$$('nav button').forEach((b) =>
  b.addEventListener('click', () => {
    $$('nav button').forEach((x) => x.classList.remove('active'));
    $$('.tab').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    $(`#tab-${b.dataset.tab}`).classList.add('active');
    if (b.dataset.tab === 'media') loadMediaTab();
    if (b.dataset.tab === 'catalog') loadCatalogTab();
    if (b.dataset.tab === 'setup') loadSetupTab();
  })
);

// ---- Schedule Review -------------------------------------------------------
function isoToday() { return new Date().toISOString().slice(0, 10); }
$('#weekStart').value = isoToday();
$('#pushDate').value = isoToday();

function showGridSkeleton() {
  const grid = $('#scheduleGrid');
  grid.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const col = el('div', { className: 'day-col' });
    col.append(el('div', { className: 'day-head', innerHTML: '<span class="skeleton" style="display:inline-block;width:60px;height:12px"></span>' }));
    col.append(el('div', { className: 'skeleton sk-card' }), el('div', { className: 'skeleton sk-card' }));
    grid.append(col);
  }
}

// Per-channel filtering of the schedule/generator. null = all channels.
let scheduleChannels = [];
let currentScheduleChannel = null;

async function renderChannelStrip() {
  try { scheduleChannels = await api.get('/api/channels'); } catch { scheduleChannels = []; }
  const strip = $('#channelStrip');
  strip.innerHTML = '';
  if (scheduleChannels.length <= 1) return; // no point showing a strip for a single channel
  const mk = (label, id) => {
    const active = currentScheduleChannel === id;
    const b = el('button', { className: `chip ${active ? 'active' : ''}`, textContent: label });
    b.onclick = () => { currentScheduleChannel = id; loadSchedule(); };
    return b;
  };
  strip.append(mk('All channels', null));
  for (const c of scheduleChannels) strip.append(mk(c.name, c.id));
}

function scheduleChannelQuery() {
  return currentScheduleChannel != null ? `&channel_id=${currentScheduleChannel}` : '';
}

async function loadSchedule() {
  showGridSkeleton();
  await renderChannelStrip();
  let data;
  try {
    const week = $('#weekStart').value || isoToday();
    data = await api.get(`/api/blocks?week=${week}${scheduleChannelQuery()}`);
  } catch (e) {
    $('#scheduleGrid').innerHTML = '';
    $('#scheduleGrid').append(emptyState('⚠️', 'Could not load schedule', e.message));
    return;
  }
  const { week: dates, blocks } = data;
  const grid = $('#scheduleGrid');
  grid.innerHTML = '';

  if (!blocks.length) {
    grid.append(emptyState('🗓️', 'No blocks for this week yet', 'Click “Generate drafts” to build the weekly schedule from your templates.'));
    return;
  }

  const byDate = Object.fromEntries(dates.map((d) => [d, []]));
  for (const b of blocks) (byDate[b.target_date] ||= []).push(b);
  const today = isoToday();

  for (const d of dates) {
    const dObj = new Date(d + 'T00:00:00');
    const weekend = [0, 6].includes(dObj.getDay());
    const col = el('div', { className: `day-col ${weekend ? 'weekend' : ''}` });
    const dow = dObj.toLocaleDateString(undefined, { weekday: 'short' });
    const head = el('div', { className: `day-head ${d === today ? 'today' : ''}` });
    head.append(el('span', { textContent: dow }), el('small', { textContent: d.slice(5) }));
    col.append(head);

    const dayBlocks = byDate[d] || [];
    if (!dayBlocks.length) {
      col.append(el('div', { className: 'muted', style: 'font-size:11.5px;padding:6px', textContent: '—' }));
    }
    for (const b of dayBlocks) {
      const card = el('div', { className: `block-card ${b.fits ? 'fits' : 'misfit'} ${b.status}`, tabIndex: 0 });
      card.append(el('div', { className: 'b-title', textContent: `${b.channel_name}: ${b.template_name}` }));
      card.append(el('div', { className: 'b-meta', textContent: `${b.start_time}–${b.end_time} · ${b.content_type}` }));
      const badges = el('div', { className: 'b-badges' });
      badges.append(el('span', { className: `badge ${b.fits ? 'ok' : 'bad'}`, textContent: b.fits ? 'fits' : `off ${fmt(b.diff)}` }));
      badges.append(el('span', { className: 'badge status', textContent: b.status }));
      if (b.is_mirror) badges.append(el('span', { className: 'badge', textContent: '🔁 repeat' }));
      card.append(badges);
      card.addEventListener('click', () => openBlock(b.id));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBlock(b.id); } });
      col.append(card);
    }
    grid.append(col);
  }
}

function emptyState(icon, title, hint) {
  const box = el('div', { className: 'empty' });
  box.append(el('div', { className: 'icon', textContent: icon }));
  box.append(el('p', { textContent: title }));
  if (hint) box.append(el('p', { className: 'hint muted', textContent: hint }));
  return box;
}

$('#btnReload').addEventListener('click', (e) => withBusy(e.currentTarget, loadSchedule));
$('#btnGenerate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', `/api/blocks/generate?weekStart=${$('#weekStart').value}${scheduleChannelQuery()}`);
  const n = r.results?.length ?? 0;
  const scope = currentScheduleChannel != null ? ' (this channel)' : '';
  toast(`Generated ${n} draft block${n === 1 ? '' : 's'}${scope}`, 'ok', 'Drafts ready');
  await loadSchedule();
}));
$('#btnApproveWeek').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', `/api/blocks/approve-week?week=${$('#weekStart').value}`);
  const blocked = r.blocked.length;
  toast(`Approved ${r.approved.length} block${r.approved.length === 1 ? '' : 's'}` + (blocked ? `, ${blocked} still off tolerance` : ''),
        blocked ? 'info' : 'ok', 'Week approval');
  await loadSchedule();
}));
$('#btnPush').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ok = await confirmDialog('Push to Air',
    `This pushes all approved blocks for ${$('#pushDate').value} to the live OTAV instances. Continue?`,
    { confirmLabel: 'Push to Air', danger: true });
  if (!ok) return;
  await withBusy(btn, async () => {
    const r = await api.send('POST', `/api/otav/push?date=${$('#pushDate').value}`);
    reportDialog('Push report', r.channels.map((c) => ({
      name: c.channel,
      ok: c.ok,
      detail: c.ok ? `${c.pushed} clips` : c.error,
    })));
    const failed = r.channels.filter((c) => !c.ok).length;
    toast(failed ? `${failed} channel(s) failed` : 'All channels pushed', failed ? 'bad' : 'ok', 'Push complete');
    await loadSchedule();
  });
});

// ---- Block editor modal ----------------------------------------------------
let currentBlock = null;
let currentItems = [];      // [{resource_id, name, duration, is_filler, is_manual_override}]
let allResources = [];
let currentMirror = false;  // true when the open block is a mirrored airing (read-only)

async function openBlock(id) {
  let v;
  try {
    v = await api.get(`/api/blocks/${id}`);
    allResources = await api.get(`/api/resources?channel_id=${v.block.channel_id}`);
  } catch (e) { return toast(e.message, 'bad', 'Error'); }
  currentBlock = v;
  currentItems = v.items.map((i) => ({ ...i }));
  currentMirror = (v.block.slot_order || 0) > 0;

  $('#modalTitle').textContent = `${v.block.template_name} — ${v.block.target_date}`;
  $('#modalMeta').textContent = `${v.block.start_time}–${v.block.end_time} · block ${fmt(v.blockSeconds)} · channel ${v.block.channel_id}`
    + (currentMirror ? ' · 🔁 mirrored airing (read-only — edit the primary airing)' : '');
  // Mirror airings copy their primary verbatim: hide the editing controls.
  $('.add-item').style.display = currentMirror ? 'none' : '';
  $('#btnSaveItems').style.display = currentMirror ? 'none' : '';

  const sel = $('#addResourceSel');
  sel.innerHTML = '';
  for (const r of allResources) {
    sel.append(el('option', { value: r.id, textContent: `${r.is_filler ? '[filler] ' : ''}${r.name} (${fmt(r.duration)})` }));
  }
  renderItems();
  $('#modal').classList.remove('hidden');
}

let dragIdx = null;
function renderItems() {
  const list = $('#itemList');
  list.innerHTML = '';
  currentItems.forEach((it, idx) => {
    const li = el('li', { className: it.is_filler ? 'filler' : '', draggable: !currentMirror });
    if (!currentMirror) li.append(el('span', { className: 'drag', textContent: '⠿', title: 'Drag to reorder' }));
    li.append(el('span', { className: 'idx', textContent: String(idx + 1) }));
    li.append(el('span', { className: 'grow', textContent: `${it.name}${it.is_manual_override ? ' *' : ''}` }));
    // Per-item episode corrector for serial items: pick another chapter of the
    // same show. The backend swaps the item, sets the series cursor, and
    // regenerates later still-draft blocks this week so ordering follows.
    if (!currentMirror && it.subject && it.id != null) {
      const chapters = allResources
        .filter((r) => r.subject === it.subject && !r.is_filler)
        .sort((a, b) => a.chapter - b.chapter);
      if (chapters.length > 1) {
        const epSel = el('select', { className: 'ep-sel', title: `Episode of “${it.subject}”` });
        for (const c of chapters) {
          epSel.append(el('option', { value: c.chapter, textContent: `Ep ${c.chapter}`, selected: c.chapter === it.chapter }));
        }
        epSel.onchange = () => withBusy(null, async () => {
          await api.send('POST', `/api/blocks/${currentBlock.block.id}/items/${it.id}/set-episode`, { chapter: Number(epSel.value) });
          toast('Episode set — cursor updated, later drafts regenerated', 'ok', it.subject);
          await openBlock(currentBlock.block.id);
          await loadSchedule();
        });
        li.append(epSel);
      }
    }
    li.append(el('span', { className: 'dur', textContent: fmt(it.duration) }));
    if (currentMirror) { list.append(li); return; }
    const up = el('button', { className: 'mini ghost', textContent: '↑', title: 'Move up' });
    const down = el('button', { className: 'mini ghost', textContent: '↓', title: 'Move down' });
    const del = el('button', { className: 'mini danger', textContent: '✕', title: 'Remove' });
    up.onclick = () => { if (idx > 0) { [currentItems[idx-1], currentItems[idx]] = [currentItems[idx], currentItems[idx-1]]; renderItems(); } };
    down.onclick = () => { if (idx < currentItems.length-1) { [currentItems[idx+1], currentItems[idx]] = [currentItems[idx], currentItems[idx+1]]; renderItems(); } };
    del.onclick = () => { currentItems.splice(idx, 1); renderItems(); };
    li.append(up, down, del);

    li.addEventListener('dragstart', () => { dragIdx = idx; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { dragIdx = null; li.classList.remove('dragging'); $$('#itemList li').forEach((x) => x.classList.remove('drag-over')); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragIdx === null || dragIdx === idx) return;
      const [moved] = currentItems.splice(dragIdx, 1);
      currentItems.splice(idx, 0, moved);
      renderItems();
    });

    list.append(li);
  });
  renderValidation();
}

// Live client-side recompute mirroring the server's validateBlock().
function renderValidation() {
  const total = currentItems.reduce((s, i) => s + i.duration, 0);
  const diff = currentBlock.blockSeconds - total;
  const maxUnderrun = currentBlock.maxUnderrun ?? 5;
  const fits = diff >= 0 && diff <= maxUnderrun;
  const box = $('#modalValidation');
  box.className = `validation ${fits ? 'ok' : 'bad'}`;
  box.textContent = fits
    ? `Fits — total ${fmt(total)}, ${fmt(diff)} under (≤ ${maxUnderrun}s)`
    : (diff < 0 ? `OVERRUN by ${fmt(-diff)} — must not exceed block length` : `UNDERRUN ${fmt(diff)} — exceeds ${maxUnderrun}s tolerance`);
  $('#btnApproveBlock').disabled = !fits;
  return fits;
}

$('#btnAddItem').addEventListener('click', () => {
  const id = Number($('#addResourceSel').value);
  const r = allResources.find((x) => x.id === id);
  if (r) { currentItems.push({ resource_id: r.id, name: r.name, duration: r.duration, is_filler: r.is_filler, is_manual_override: 1 }); renderItems(); }
});
$('#btnSaveItems').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const items = currentItems.map((i) => ({ resource_id: i.resource_id, is_manual_override: i.is_manual_override ? 1 : 0 }));
  const v = await api.send('PUT', `/api/blocks/${currentBlock.block.id}/items`, { items });
  currentBlock = v; currentItems = v.items.map((i) => ({ ...i })); renderItems();
  toast('Order saved', 'ok');
}));
$('#btnApproveBlock').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  // Persist current edits first, then approve.
  const items = currentItems.map((i) => ({ resource_id: i.resource_id, is_manual_override: i.is_manual_override ? 1 : 0 }));
  await api.send('PUT', `/api/blocks/${currentBlock.block.id}/items`, { items });
  await api.send('POST', `/api/blocks/${currentBlock.block.id}/approve`);
  $('#modal').classList.add('hidden');
  toast('Block approved', 'ok');
  await loadSchedule();
}));
$('#modalClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#modal').classList.add('hidden'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('#modal').classList.add('hidden');
    $('#seriesModal')?.classList.add('hidden');
    $('#templateModal')?.classList.add('hidden');
    $('#channelModal')?.classList.add('hidden');
    closeDialog();
  }
});

// ---- Media & Roots ---------------------------------------------------------
let browsePath = null;
let selectedFolder = null;

let mediaChannels = [];

async function loadMediaTab() {
  try {
    const st = await api.get('/api/media/status');
    const pill = $('#mountStatus');
    pill.className = `mount-pill ${st.mounted ? 'on' : 'off'}`;
    pill.textContent = st.mounted ? `mounted at ${st.mountPoint}` : `not mounted (${st.mountPoint})`;
    mediaChannels = await api.get('/api/channels');
    // Channel checkboxes for multi-channel folder assignment.
    const box = $('#assignChannels'); box.innerHTML = '';
    for (const c of mediaChannels) {
      box.append(el('label', { className: 'chk' }, el('input', { type: 'checkbox', value: c.id }), document.createTextNode(' ' + c.name)));
    }
    await populateSelect('#assignShowType', '/api/showtypes', 'name');
    // Check-media channel filter.
    const filt = $('#mediaChannelFilter'); filt.innerHTML = '';
    for (const c of mediaChannels) filt.append(el('option', { value: c.id, textContent: c.name }));
    await browse(st.mountPoint);
    await loadRoots();
    await loadResources();
  } catch (e) { toast(e.message, 'bad', 'Media'); }
}

async function loadResources() {
  const tb = $('#resourcesTable tbody');
  if (!tb) return;
  const ch = $('#mediaChannelFilter').value;
  if (!ch) { tb.innerHTML = ''; return; }
  const filler = $('#mediaFillerFilter').value;
  tb.innerHTML = '';
  let rows = [];
  try {
    const q = `channel_id=${ch}` + (filler !== '' ? `&is_filler=${filler}` : '');
    rows = await api.get(`/api/resources?${q}`);
  } catch (e) { return toast(e.message, 'bad', 'Resources'); }
  if (!rows.length) {
    tb.append(el('tr', {}, el('td', { colSpan: 5, className: 'muted', style: 'text-align:center;padding:18px', textContent: 'No cataloged media for this channel yet — assign a root and scan.' })));
    return;
  }
  for (const r of rows) {
    tb.append(el('tr', {},
      el('td', { textContent: r.name }),
      el('td', { textContent: r.subject || '—' }),
      el('td', { textContent: r.is_filler ? '—' : String(r.chapter) }),
      el('td', { className: 'dur', textContent: fmt(r.duration) }),
      el('td', {}, el('span', { className: `badge ${r.is_filler ? 'ok' : 'status'}`, textContent: r.is_filler ? 'filler' : 'main' }))));
  }
}
$('#btnLoadResources')?.addEventListener('click', (e) => withBusy(e.currentTarget, loadResources));
$('#mediaChannelFilter')?.addEventListener('change', loadResources);
$('#mediaFillerFilter')?.addEventListener('change', loadResources);

async function browse(path) {
  try {
    const data = await api.get(`/api/media/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    browsePath = data.path;
    $('#browserPath').textContent = `${data.path}  ·  ${data.fileCount} file(s) here`;
    const ul = $('#browser');
    ul.innerHTML = '';
    const parent = data.path.replace(/\/[^/]+$/, '');
    if (parent && parent !== data.path) {
      const up = el('li', { className: 'up' });
      up.append(el('span', { textContent: '⬆' }), el('span', { textContent: '..' }));
      up.onclick = () => browse(parent);
      ul.append(up);
    }
    if (!data.folders.length) {
      ul.append(el('li', { className: 'muted', textContent: 'No subfolders here' }));
    }
    for (const f of data.folders) {
      const li = el('li');
      li.append(el('span', { textContent: '📁' }), el('span', { textContent: f.name }), el('span', { className: 'hint', textContent: 'double-click to open' }));
      li.onclick = () => {
        selectedFolder = f.path;
        $$('#browser li').forEach((x) => x.classList.remove('selected'));
        li.classList.add('selected');
      };
      li.ondblclick = () => browse(f.path);
      ul.append(li);
    }
  } catch (e) { $('#browserPath').textContent = 'browse error: ' + e.message; }
}

$('#btnMount').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', '/api/media/mount');
  toast(r.alreadyMounted ? 'Share already mounted' : 'Share mounted', 'ok');
  await loadMediaTab();
}));
$('#btnScanAll').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', '/api/media/scan');
  const total = r.results.reduce((s, x) => s + x.ingested, 0);
  toast(`Ingested ${total} resource(s) across ${r.results.length} root(s)`, 'ok', 'Scan complete');
}));
$('#btnAssignRoot').addEventListener('click', (e) => {
  const folder = selectedFolder || browsePath;
  if (!folder) return toast('Select a folder first', 'bad');
  const channel_ids = $$('#assignChannels input:checked').map((i) => Number(i.value));
  if (!channel_ids.length) return toast('Select at least one channel', 'bad');
  return withBusy(e.currentTarget, async () => {
    const r = await api.send('POST', '/api/media/roots', {
      channel_ids,
      show_type_id: Number($('#assignShowType').value),
      path: folder,
    });
    const n = r.created?.length ?? 0;
    const cloned = r.clonedResources ?? 0;
    toast(
      `Assigned folder to ${n} channel${n === 1 ? '' : 's'}`
        + (cloned ? ` — cloned ${cloned} already-scanned clip(s), no scan needed` : ''),
      'ok',
    );
    await loadRoots();
    await loadResources();
  });
});

async function loadRoots() {
  const rows = await api.get('/api/media/roots');
  const tb = $('#rootsTable tbody');
  tb.innerHTML = '';
  if (!rows.length) {
    tb.append(el('tr', {}, el('td', { colSpan: 4, className: 'muted', style: 'text-align:center;padding:22px', textContent: 'No media roots configured yet.' })));
    return;
  }
  // The same folder assigned to N channels is N MediaRoot rows; collapse them to
  // one row per (path, show type) with the channels shown as badges. scan/delete
  // fan out across every underlying row id.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.path} ${r.show_type_id}`;
    if (!groups.has(key)) groups.set(key, { path: r.path, show_type_name: r.show_type_name, channels: [] });
    groups.get(key).channels.push(r); // each carries id + channel_name + channel_id
  }
  for (const g of groups.values()) {
    const tr = el('tr');
    const chCell = el('td');
    for (const c of g.channels) chCell.append(el('span', { className: 'badge', textContent: c.channel_name }));
    tr.append(chCell, el('td', { textContent: g.show_type_name }), el('td', { className: 'path-cell', textContent: g.path }));
    const label = g.path.split('/').pop();

    const btnScan = el('button', { className: 'mini ghost', textContent: 'scan' });
    btnScan.onclick = () => withBusy(btnScan, async () => {
      let ingested = 0, scanned = 0;
      for (const c of g.channels) {
        const x = await api.send('POST', `/api/media/roots/${c.id}/scan`);
        ingested += x.ingested; scanned += x.scanned;
      }
      toast(`Ingested ${ingested} of ${scanned} across ${g.channels.length} channel(s)`, 'ok', label);
      await loadResources();
    });
    const btnEdit = el('button', { className: 'mini ghost', textContent: 'edit' });
    // Edit stays per-channel; when shared, edit the first assignment.
    btnEdit.onclick = () => editRoot({ ...g.channels[0], path: g.path, show_type_name: g.show_type_name });
    const btnDel = el('button', { className: 'mini danger', textContent: 'delete' });
    btnDel.onclick = async () => {
      const names = g.channels.map((c) => c.channel_name).join(', ');
      if (!await confirmDialog('Delete media root', `Remove the root “${g.path}” from ${g.channels.length} channel(s) (${names}) and drop every resource it cataloged? This also removes those clips from any draft blocks.`, { confirmLabel: 'Delete', danger: true })) return;
      await withBusy(btnDel, async () => {
        let dropped = 0;
        for (const c of g.channels) {
          const res = await api.send('DELETE', `/api/media/roots/${c.id}`);
          dropped += res.deletedResources ?? 0;
        }
        toast(`Root removed — ${dropped} resource(s) dropped`, 'ok');
        await loadRoots();
        await loadResources();
      });
    };
    const td = el('td'); td.style.textAlign = 'right';
    td.append(btnScan, document.createTextNode(' '), btnEdit, document.createTextNode(' '), btnDel); tr.append(td);
    tb.append(tr);
  }
}

// Edit a media root's channel / show type (folder type). Uses the generic dialog
// with two selects. A re-scan afterwards re-catalogs under the new assignment.
async function editRoot(r) {
  const showTypes = await api.get('/api/showtypes');
  $('#dialogTitle').textContent = 'Edit media root';
  const content = $('#dialogContent');
  content.innerHTML = '';
  content.append(el('p', { className: 'dialog-msg', textContent: r.path }));
  const chSel = el('select');
  for (const c of mediaChannels) chSel.append(el('option', { value: c.id, textContent: c.name, selected: c.id === r.channel_id }));
  const stSel = el('select');
  for (const s of showTypes) stSel.append(el('option', { value: s.id, textContent: s.name, selected: s.id === r.show_type_id }));
  content.append(
    el('label', { className: 'field' }, document.createTextNode('Channel'), chSel),
    el('label', { className: 'field' }, document.createTextNode('Folder type'), stSel),
    el('p', { className: 'hint muted', textContent: 'Re-scan this root afterwards to re-catalog under the new assignment.' }),
  );
  const actions = $('#dialogActions');
  actions.innerHTML = '';
  const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
  const save = el('button', { className: 'primary', textContent: 'Save' });
  cancel.onclick = closeDialog;
  save.onclick = () => withBusy(save, async () => {
    await api.send('PUT', `/api/media/roots/${r.id}`, { channel_id: Number(chSel.value), show_type_id: Number(stSel.value) });
    closeDialog();
    toast('Root updated — re-scan to apply', 'ok');
    await loadRoots();
  });
  actions.append(cancel, save);
  $('#dialog').classList.remove('hidden');
}

// ---- Catalog Editor ("fake root") — file-browser style ---------------------
// A single text-input dialog built on the generic #dialog, with an optional
// datalist of suggestions. Resolves the entered string, or null on cancel.
function inputDialog(title, label, initial = '', suggestions = null) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = title;
    const content = $('#dialogContent');
    content.innerHTML = '';
    const input = el('input', { value: initial, className: 'dlg-input' });
    if (suggestions && suggestions.length) {
      const listId = 'dlg-suggestions';
      const dl = el('datalist', { id: listId });
      for (const s of suggestions) dl.append(el('option', { value: s }));
      input.setAttribute('list', listId);
      content.append(dl);
    }
    content.append(el('label', { className: 'field' }, document.createTextNode(label), input));
    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: 'primary', textContent: 'OK' });
    cancel.onclick = () => { closeDialog(); resolve(null); };
    ok.onclick = () => { closeDialog(); resolve(input.value); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    actions.append(cancel, ok);
    $('#dialog').classList.remove('hidden');
    input.focus();
  });
}

let catEpisodes = [];            // flat list of resources for the channel (with file_path)
let catReg = new Map();          // subject -> ChannelSeries row (engine flags + cursor)
let catShowTypes = [];
let catChannels = [];
let catChannelId = null;
let catView = 'series';          // 'series' (engine) | 'folders' (disk explorer)
let catSeriesSel = null;         // subject currently opened in series view
let catRoot = '';                // folders view: common directory root
let catPath = '';                // folders view: current directory
const catFolderSel = new Set();  // folders view: checked sub-folder paths
const catFileSel = new Set();    // selected resource ids (both views)
let catOrderInputs = [];         // { id, input } for the files shown (Fix order)

async function loadCatalogTab() {
  if (!catChannels.length) catChannels = await api.get('/api/channels');
  if (!catShowTypes.length) catShowTypes = await api.get('/api/showtypes');
  const sel = $('#catChannel');
  if (!sel.options.length) {
    for (const c of catChannels) sel.append(el('option', { value: c.id, textContent: c.name }));
  }
  await loadCatalog();
}

const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));

function commonDir(paths) {
  if (!paths.length) return '';
  let parts = dirOf(paths[0]).split('/');
  for (const p of paths) {
    const dp = dirOf(p).split('/');
    let i = 0;
    while (i < parts.length && i < dp.length && parts[i] === dp[i]) i++;
    parts = parts.slice(0, i);
  }
  return parts.join('/');
}

async function loadCatalog() {
  const channelId = Number($('#catChannel').value);
  if (!channelId) return;
  catChannelId = channelId;
  const [data, reg] = await Promise.all([
    api.get(`/api/catalog?channel_id=${channelId}`),
    api.get(`/api/channels/${channelId}/series`),
  ]);
  catEpisodes = [];
  for (const g of data.groups) for (const show of g.shows) for (const ep of show.episodes) catEpisodes.push(ep);
  catReg = new Map(reg.map((r) => [r.subject, r]));
  catRoot = commonDir(catEpisodes.map((e) => e.file_path));
  if (!catPath || !(catPath === catRoot || catPath.startsWith(catRoot + '/')) || !pathExists(catPath)) catPath = catRoot;
  catFileSel.clear();
  catFolderSel.clear();
  renderCatalog();
}

function setCatView(v) {
  catView = v;
  catSeriesSel = null;
  catFileSel.clear();
  catFolderSel.clear();
  $('#catViewSeries').classList.toggle('active', v === 'series');
  $('#catViewFolders').classList.toggle('active', v === 'folders');
  renderCatalog();
}

function renderCatalog() {
  if (catView === 'folders') { renderCrumbFolders(); renderBrowser(); }
  else catRenderSeries();
}

// ---- shared episode row ----------------------------------------------------
// Renders a file/episode line with: select checkbox, order number, editable
// display name, series/filler/edited badges, duration, delete. `showSeries`
// adds the series badge (used in folder view where series isn't obvious).
function episodeRow(ep, { showSeries = false } = {}) {
  const li = el('li', { className: ep.is_filler ? 'filler' : '' });
  const cb = el('input', { type: 'checkbox', className: 'cat-sel', checked: catFileSel.has(ep.id), title: 'Select this clip' });
  cb.onchange = () => { if (cb.checked) catFileSel.add(ep.id); else catFileSel.delete(ep.id); renderCatBulkBar(); };
  li.append(cb);
  const ord = el('input', { className: 'cat-ord', type: 'number', value: ep.chapter, title: 'Play order — type numbers, then “Fix order”' });
  catOrderInputs.push({ id: ep.id, input: ord });
  li.append(ord);
  const nameIn = el('input', { className: 'cat-name grow', value: ep.display_name, title: `File on disk: ${ep.raw_name}` });
  nameIn.onchange = () => withBusy(null, async () => { await api.send('PUT', `/api/catalog/resource/${ep.id}`, { display_name: nameIn.value }); ep.display_name = nameIn.value; toast('Name saved', 'ok'); });
  li.append(nameIn);
  if (showSeries && ep.subject) li.append(el('span', { className: 'badge', textContent: ep.subject, title: 'Series' }));
  if (ep.is_filler) li.append(el('span', { className: 'badge', textContent: 'filler' }));
  if (ep.has_override) li.append(el('span', { className: 'badge', textContent: 'edited', title: 'Has local overrides' }));
  li.append(el('span', { className: 'dur', textContent: fmt(ep.duration) }));
  const del = el('button', { className: 'mini danger', textContent: '🗑', title: 'Delete this clip from the catalog (for duplicates)' });
  del.onclick = () => deleteResource(ep);
  li.append(del);
  return li;
}

// Ids to act on: selected clips if any, else the supplied fallback list.
const targetIds = (fallback) => (catFileSel.size ? [...catFileSel] : fallback);

// =====================  SERIES (ENGINE) VIEW  ===============================
const episodesOfSeries = (subject) => catEpisodes
  .filter((e) => !e.is_filler && e.subject === subject)
  .sort((a, b) => a.chapter - b.chapter || a.id - b.id);

// The engine's next-up chapter for a serial series (cursor, else lowest chapter).
function nextUp(subject) {
  const reg = catReg.get(subject);
  const eps = episodesOfSeries(subject);
  const lo = eps.length ? eps[0].chapter : null;
  return reg && reg.cursor_chapter != null ? reg.cursor_chapter : lo;
}

function seriesGroups() {
  const groups = new Map(); // show_type_name -> [{subject,count,show_type_id}]
  const seen = new Map();
  const fillers = catEpisodes.filter((e) => e.is_filler);
  const unsorted = catEpisodes.filter((e) => !e.is_filler && e.subject == null);
  for (const e of catEpisodes) {
    if (e.is_filler || e.subject == null) continue;
    const gk = e.show_type_name || 'Unassigned';
    if (!groups.has(gk)) groups.set(gk, []);
    const key = `${gk} ${e.subject}`;
    if (!seen.has(key)) { const o = { subject: e.subject, show_type_id: e.show_type_id, count: 0 }; seen.set(key, o); groups.get(gk).push(o); }
    seen.get(key).count++;
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.subject.localeCompare(b.subject));
  return { groups, fillers, unsorted };
}

function catRenderSeries() {
  if (catSeriesSel) return renderSeriesDetail(catSeriesSel);
  renderSeriesList();
}

function renderSeriesList() {
  $('#catCrumb').textContent = '';
  $('#catCrumb').append(el('span', { className: 'muted', textContent: 'How the scheduler groups this channel. Tick “serial” to make a series play in order (works for movies too); open one to fix episode order & next-up.' }));
  const bulk = $('#catBulkBar'); bulk.innerHTML = '';
  const host = $('#catBrowser'); host.innerHTML = '';
  if (!catEpisodes.length) { host.append(el('p', { className: 'muted', textContent: 'Nothing cataloged for this channel yet — scan a media root on the Media tab first.' })); return; }
  const { groups, fillers, unsorted } = seriesGroups();

  const seriesRow = (subject, count, showTypeId) => {
    const reg = catReg.get(subject);
    const isSerial = reg ? !!reg.is_serial : false;
    const li = el('li', { className: 'cat-series-row' });
    const name = el('button', { className: 'cat-dir-name grow', textContent: `🎬 ${subject}` });
    name.onclick = () => { catSeriesSel = subject; catFileSel.clear(); catRenderSeries(); };
    li.append(name);
    li.append(el('span', { className: 'muted cat-nav-count', textContent: `${count} ep` }));
    if (isSerial) li.append(el('span', { className: 'badge', textContent: `next #${nextUp(subject) ?? '—'}`, title: 'Episode the scheduler will play next' }));
    const serial = el('label', { className: 'chk', title: 'Play episodes in order (serialize) — enable for movies too' });
    const scb = el('input', { type: 'checkbox', checked: isSerial });
    scb.onchange = () => withBusy(null, () => setSerial(subject, showTypeId, scb.checked));
    serial.append(scb, document.createTextNode(' serial'));
    li.append(serial);
    return li;
  };

  for (const [typeName, arr] of groups) {
    host.append(el('div', { className: 'cat-nav-type', textContent: typeName }));
    const ul = el('ul', { className: 'cat-fs' });
    for (const s of arr) ul.append(seriesRow(s.subject, s.count, s.show_type_id));
    host.append(ul);
  }
  if (unsorted.length) {
    host.append(el('div', { className: 'cat-nav-type', textContent: 'Unsorted (no series)' }));
    const ul = el('ul', { className: 'cat-fs' });
    const li = el('li', { className: 'cat-series-row' });
    const b = el('button', { className: 'cat-dir-name grow', textContent: '🗂 Unsorted clips' });
    b.onclick = () => { catSeriesSel = ' unsorted'; catFileSel.clear(); catRenderSeries(); };
    li.append(b, el('span', { className: 'muted cat-nav-count', textContent: `${unsorted.length} clip(s)` }));
    ul.append(li); host.append(ul);
  }
  if (fillers.length) {
    host.append(el('div', { className: 'cat-nav-type', textContent: 'Fillers' }));
    const ul = el('ul', { className: 'cat-fs' });
    const li = el('li', { className: 'cat-series-row' });
    const b = el('button', { className: 'cat-dir-name grow', textContent: '🎞 Fillers' });
    b.onclick = () => { catSeriesSel = ' fillers'; catFileSel.clear(); catRenderSeries(); };
    li.append(b, el('span', { className: 'muted cat-nav-count', textContent: `${fillers.length} clip(s)` }));
    ul.append(li); host.append(ul);
  }
}

function seriesSelEpisodes() {
  if (catSeriesSel === ' fillers') return catEpisodes.filter((e) => e.is_filler).sort((a, b) => a.display_name.localeCompare(b.display_name));
  if (catSeriesSel === ' unsorted') return catEpisodes.filter((e) => !e.is_filler && e.subject == null).sort((a, b) => a.display_name.localeCompare(b.display_name));
  return episodesOfSeries(catSeriesSel);
}

function renderSeriesDetail(subject) {
  const eps = seriesSelEpisodes();
  const special = subject === ' fillers' || subject === ' unsorted';
  const title = subject === ' fillers' ? '🎞 Fillers' : subject === ' unsorted' ? '🗂 Unsorted clips' : subject;

  // Breadcrumb + series-level engine controls.
  const crumb = $('#catCrumb'); crumb.innerHTML = '';
  const back = el('button', { className: 'mini ghost', textContent: '← Series' });
  back.onclick = () => { catSeriesSel = null; catFileSel.clear(); catRenderSeries(); };
  crumb.append(back, el('strong', { className: 'crumb-title', textContent: title }), el('span', { className: 'muted', textContent: ` · ${eps.length} clip(s)` }));

  if (!special) {
    const reg = catReg.get(subject);
    const showTypeId = reg?.show_type_id ?? eps[0]?.show_type_id ?? null;
    const isSerial = reg ? !!reg.is_serial : false;
    const isActive = reg ? reg.is_active !== 0 : true;

    const serial = el('label', { className: 'chk', title: 'Play episodes in order (serialize). Enable this to make a movie series sequential.' });
    const scb = el('input', { type: 'checkbox', checked: isSerial });
    scb.onchange = () => withBusy(null, () => setSerial(subject, showTypeId, scb.checked));
    serial.append(scb, document.createTextNode(' serial'));

    const active = el('label', { className: 'chk', title: 'Include this series when generating schedules' });
    const acb = el('input', { type: 'checkbox', checked: isActive });
    acb.onchange = () => withBusy(null, () => setActive(subject, showTypeId, acb.checked));
    active.append(acb, document.createTextNode(' active'));

    const ren = el('button', { className: 'mini ghost', textContent: '✏️ rename series' });
    ren.onclick = () => renameSeries(subject);
    crumb.append(serial, active, ren);

    if (isSerial) {
      const nu = el('input', { className: 'cat-ord', type: 'number', value: nextUp(subject) ?? '', title: 'Next episode the scheduler will play' });
      const setnu = el('button', { className: 'mini ghost', textContent: 'set next-up' });
      setnu.onclick = () => withBusy(null, async () => { await api.send('PUT', `/api/channels/${catChannelId}/series/${encodeURIComponent(subject)}/cursor`, { chapter: Number(nu.value) }); await loadCatalog(); toast('Next-up set', 'ok'); });
      crumb.append(el('span', { className: 'muted', textContent: 'next-up:' }), nu, setnu);
    }
  }

  renderCatBulkBar();

  const host = $('#catBrowser'); host.innerHTML = '';
  catOrderInputs = [];
  if (!eps.length) { host.append(el('p', { className: 'muted', textContent: 'No clips in this series.' })); return; }
  const selAll = el('label', { className: 'chk cat-selall' });
  const sab = el('input', { type: 'checkbox' });
  sab.onchange = () => { if (sab.checked) eps.forEach((e) => catFileSel.add(e.id)); else catFileSel.clear(); renderSeriesDetail(subject); };
  selAll.append(sab, document.createTextNode(' select all'));
  host.append(selAll);
  const ul = el('ol', { className: 'items cat-eps' });
  for (const ep of eps) ul.append(episodeRow(ep));
  host.append(ul);
}

async function setSerial(subject, showTypeId, isSerial) {
  const reg = catReg.get(subject) || {};
  await api.send('PUT', `/api/channels/${catChannelId}/series`, { series: [{
    subject, is_serial: isSerial ? 1 : 0,
    is_active: reg.is_active === 0 ? 0 : 1,
    play_order: reg.play_order ?? 0,
    show_type_id: reg.show_type_id ?? showTypeId ?? null,
  }] });
  await loadCatalog();
  toast(isSerial ? `“${subject}” now plays in order` : `“${subject}” no longer serial`, 'ok');
}
async function setActive(subject, showTypeId, isActive) {
  const reg = catReg.get(subject) || {};
  await api.send('PUT', `/api/channels/${catChannelId}/series`, { series: [{
    subject, is_serial: reg.is_serial ? 1 : 0,
    is_active: isActive ? 1 : 0,
    play_order: reg.play_order ?? 0,
    show_type_id: reg.show_type_id ?? showTypeId ?? null,
  }] });
  await loadCatalog();
  toast(isActive ? 'Series activated' : 'Series deactivated', 'ok');
}
async function renameSeries(subject) {
  const next = await inputDialog('Rename series', 'New series name', subject);
  if (next == null || next === '' || next === subject) return;
  const ids = episodesOfSeries(subject).map((e) => e.id);
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-subject', subject: next });
  catSeriesSel = next;
  await loadCatalog();
  toast('Series renamed', 'ok');
}

// =====================  FOLDERS (DISK) VIEW  ================================
function pathExists(path) {
  return catEpisodes.some((e) => dirOf(e.file_path) === path || e.file_path.startsWith(path + '/'));
}
const filesAt = (path) => catEpisodes
  .filter((e) => dirOf(e.file_path) === path)
  .sort((a, b) => a.chapter - b.chapter || a.display_name.localeCompare(b.display_name));
function foldersAt(path) {
  const prefix = path + '/';
  const map = new Map();
  for (const e of catEpisodes) {
    if (!e.file_path.startsWith(prefix)) continue;
    const rest = e.file_path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) continue;
    const name = rest.slice(0, slash);
    const fp = prefix + name;
    if (!map.has(fp)) map.set(fp, { name, path: fp, count: 0, subjects: new Set(), fillers: 0 });
    const f = map.get(fp); f.count++; if (e.subject) f.subjects.add(e.subject); if (e.is_filler) f.fillers++;
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const idsUnder = (path) => catEpisodes.filter((e) => e.file_path === path || e.file_path.startsWith(path + '/')).map((e) => e.id);
function folderScopeIds() {
  const base = new Set(catFileSel);
  if (catFolderSel.size) for (const p of catFolderSel) idsUnder(p).forEach((i) => base.add(i));
  if (base.size) return [...base];
  return idsUnder(catPath);
}
function navTo(path) { catPath = path; catFolderSel.clear(); renderCatalog(); }

function renderCrumbFolders() {
  const bar = $('#catCrumb');
  bar.innerHTML = '';
  if (!catEpisodes.length) return;
  if (catPath !== catRoot) {
    const up = el('button', { className: 'mini ghost', textContent: '↑ Up' });
    up.onclick = () => navTo(dirOf(catPath).startsWith(catRoot) ? dirOf(catPath) : catRoot);
    bar.append(up);
  }
  const seg = (label, path) => { const a = el('button', { className: 'crumb-seg', textContent: label }); a.onclick = () => navTo(path); return a; };
  bar.append(seg('🏠 ' + (catRoot.split('/').pop() || 'root'), catRoot));
  const rel = catPath === catRoot ? [] : catPath.slice(catRoot.length + 1).split('/');
  let acc = catRoot;
  for (const s of rel) { acc += '/' + s; bar.append(el('span', { className: 'crumb-sep', textContent: '/' }), seg(s, acc)); }
}

function renderBrowser() {
  const host = $('#catBrowser');
  host.innerHTML = '';
  renderCatBulkBar();
  if (!catEpisodes.length) { host.append(el('p', { className: 'muted', textContent: 'Nothing cataloged for this channel yet — scan a media root on the Media tab first.' })); return; }
  const folders = foldersAt(catPath);
  const files = filesAt(catPath);
  catOrderInputs = [];
  if (folders.length) {
    const fu = el('ul', { className: 'cat-fs' });
    for (const f of folders) {
      const li = el('li', { className: 'cat-dir' });
      const cb = el('input', { type: 'checkbox', checked: catFolderSel.has(f.path), title: 'Select this folder for merge / folder actions' });
      cb.onchange = () => { if (cb.checked) catFolderSel.add(f.path); else catFolderSel.delete(f.path); renderCatBulkBar(); };
      li.append(cb);
      const name = el('button', { className: 'cat-dir-name grow', textContent: `📁 ${f.name}` });
      name.onclick = () => navTo(f.path);
      li.append(name);
      const meta = f.subjects.size === 1 ? `series: ${[...f.subjects][0]}` : f.subjects.size > 1 ? `${f.subjects.size} series` : (f.fillers ? 'fillers' : 'unsorted');
      li.append(el('span', { className: 'badge', textContent: meta }));
      li.append(el('span', { className: 'muted cat-nav-count', textContent: `${f.count} clip(s)` }));
      fu.append(li);
    }
    host.append(fu);
  }
  if (files.length) {
    const fl = el('ol', { className: 'items cat-eps' });
    for (const ep of files) fl.append(episodeRow(ep, { showSeries: true }));
    host.append(fl);
  }
  if (!folders.length && !files.length) host.append(el('p', { className: 'muted', textContent: 'This folder is empty.' }));
}

// ---- Bulk action bar (context-aware) ---------------------------------------
function renderCatBulkBar() {
  const bar = $('#catBulkBar');
  bar.innerHTML = '';
  if (!catEpisodes.length) return;
  const mk = (label, cls, fn, title) => { const b = el('button', { className: `mini ${cls}`, textContent: label, title }); b.onclick = () => withBusy(null, fn); return b; };
  const selN = catFileSel.size;
  const scope = selN ? `${selN} selected clip(s)`
    : (catView === 'folders' ? (catFolderSel.size ? `${catFolderSel.size} folder(s)` : 'this folder') : 'this series');

  if (catView === 'folders') {
    bar.append(mk('🔗 Merge → series', 'ghost', mergeScope, `Put ${scope} into one series (files stay in their folders)`));
  } else if (catSeriesSel && catSeriesSel !== ' fillers') {
    bar.append(mk('→ Move to series', 'ghost', mergeScope, `Move ${scope} into another series`));
  }
  bar.append(
    mk('🔢 Fix order', 'primary', fixOrder, 'Apply the play-order numbers you typed to the clips listed here'),
    mk('1..N Renumber', 'ghost', renumberScope, 'Number the listed clips 1..N in shown order'),
    mk('✏️ Rename…', 'ghost', renameScope, 'Set display names from a template'),
    mk('🔎 Replace…', 'ghost', replaceScope, 'Find & replace in display names'),
    mk('🎞 Mark filler', 'ghost', () => markFiller(1), `Mark ${scope} as fillers`),
    mk('📺 Unmark', 'ghost', () => markFiller(0), `Unmark fillers in ${scope}`),
    mk('🎬 Show type…', 'ghost', setShowType, `Set the show type for ${scope}`),
    mk('↺ Reset', 'danger', resetScope, `Restore detected names/order for ${scope}`),
  );
  if (selN) bar.append(el('span', { className: 'muted', style: 'margin-left:auto', textContent: `${selN} selected` }));
}

// Scope helpers: series view acts on selected clips else the whole series;
// folder view acts on selected clips/folders else the current folder.
function shownEpisodes() { return catView === 'folders' ? filesAt(catPath) : seriesSelEpisodes(); }
function scopeIds() {
  if (catFileSel.size) return [...catFileSel];
  if (catView === 'folders') return folderScopeIds();
  return shownEpisodes().map((e) => e.id);
}

// ---- Actions ---------------------------------------------------------------
async function mergeScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing to merge here', 'bad');
  const existing = [...new Set(catEpisodes.map((e) => e.subject).filter(Boolean))].sort();
  const subject = await inputDialog('Merge into series', `Series name for ${ids.length} clip(s)`, '', existing);
  if (subject == null || subject === '') return;
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-subject', subject });
  if (catView === 'series') catSeriesSel = subject;
  await loadCatalog();
  toast(`Merged ${ids.length} clip(s) into “${subject}”`, 'ok');
}
async function fixOrder() {
  if (!catOrderInputs.length) return toast('No files to order here', 'bad');
  const entries = catOrderInputs.map(({ id, input }) => ({ id, chapter: Number(input.value) || 0 }));
  await api.send('POST', '/api/catalog/bulk', { ids: entries.map((e) => e.id), op: 'set-chapters', entries });
  await loadCatalog();
  toast('Order fixed', 'ok');
}
async function renumberScope() {
  const ids = (catFileSel.size ? shownEpisodes().filter((e) => catFileSel.has(e.id)) : shownEpisodes()).map((e) => e.id);
  if (!ids.length) return toast('Nothing to renumber', 'bad');
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'renumber' });
  await loadCatalog();
  toast('Renumbered 1..N', 'ok');
}
async function renameScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  const template = await inputDialog('Rename by template', 'Tokens: {name} {subject} {chapter} {n}', '{subject} — Ep {n}');
  if (template == null) return;
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'template', template });
  await loadCatalog();
  toast('Display names updated', 'ok');
}
async function replaceScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  const find = await inputDialog('Find & replace', 'Find (in display name)');
  if (find == null || find === '') return;
  const replace = await inputDialog('Find & replace', `Replace “${find}” with`);
  if (replace == null) return;
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'find-replace', field: 'display_name', find, replace });
  await loadCatalog();
  toast('Replaced', 'ok');
}
async function markFiller(is_filler) {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-filler', is_filler });
  await loadCatalog();
  toast(is_filler ? 'Marked as filler' : 'Unmarked filler', 'ok');
}
async function setShowType() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  const names = catShowTypes.map((s) => `${s.id} = ${s.name}`).join(', ');
  const val = await inputDialog('Set show type', `Show type id (${names})`);
  if (val == null || val === '') return;
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-showtype', show_type_id: Number(val) });
  await loadCatalog();
  toast('Show type updated', 'ok');
}
async function resetScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  if (!await confirmDialog('Reset', `Restore detected series/order and drop custom names for ${ids.length} clip(s)?`, { confirmLabel: 'Reset', danger: true })) return;
  await api.send('POST', '/api/catalog/reset', { ids });
  await loadCatalog();
  toast('Reset to detected', 'ok');
}
async function deleteResource(ep) {
  if (!await confirmDialog('Delete clip', `Remove “${ep.display_name}” from the catalog? The file on disk is NOT deleted — a re-scan would re-add it.`, { confirmLabel: 'Delete', danger: true })) return;
  await withBusy(null, async () => {
    await api.send('DELETE', `/api/catalog/resource/${ep.id}`);
    await loadCatalog();
    toast('Clip removed', 'ok');
  });
}

$('#catChannel').addEventListener('change', () => { catPath = ''; catSeriesSel = null; loadCatalog(); });
$('#btnCatReload').addEventListener('click', (e) => withBusy(e.currentTarget, loadCatalog));
$('#catViewSeries').addEventListener('click', () => setCatView('series'));
$('#catViewFolders').addEventListener('click', () => setCatView('folders'));

// ---- Channels & Templates --------------------------------------------------
async function populateSelect(sel, url, labelKey) {
  const rows = await api.get(url);
  const s = $(sel); s.innerHTML = '';
  for (const r of rows) s.append(el('option', { value: r.id, textContent: r[labelKey] }));
  return rows;
}

let setupChannels = [];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

async function loadSetupTab() {
  try {
    setupChannels = await api.get('/api/channels');
    const chName = Object.fromEntries(setupChannels.map((c) => [c.id, c.name]));

    const ct = $('#channelsTable tbody'); ct.innerHTML = '';
    if (!setupChannels.length) ct.append(el('tr', {}, el('td', { colSpan: 5, className: 'muted', style: 'text-align:center;padding:18px', textContent: 'No channels yet — add one below.' })));
    for (const c of setupChannels) {
      const editBtn = el('button', { className: 'mini ghost', textContent: 'edit' });
      editBtn.onclick = () => openChannelEditor(c);
      const seriesBtn = el('button', { className: 'mini ghost', textContent: 'series' });
      seriesBtn.onclick = () => openSeries(c);
      const td = el('td'); td.style.textAlign = 'right';
      td.append(editBtn, document.createTextNode(' '), seriesBtn);
      ct.append(el('tr', {},
        el('td', { textContent: c.name }),
        el('td', { textContent: c.api_ip ? `${c.api_ip}:${c.api_port ?? ''}` : '—' }),
        el('td', { textContent: c.playlist_ref ?? '0' }),
        el('td', {}, el('span', { className: `badge ${c.is_active ? 'ok' : 'status'}`, textContent: c.is_active ? 'active' : 'off' })),
        td));
    }

    const showTypes = await api.get('/api/showtypes');
    const stb = $('#showTypesTable tbody'); stb.innerHTML = '';
    for (const s of showTypes) stb.append(el('tr', {},
      el('td', { textContent: s.name }),
      el('td', { textContent: s.is_educational ? 'yes' : 'no' }),
      el('td', { textContent: s.is_filler ? 'yes' : 'no' })));

    const tpls = await api.get('/api/blocks/templates');
    const tt = $('#templatesTable tbody'); tt.innerHTML = '';
    if (!tpls.length) tt.append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', style: 'text-align:center;padding:18px', textContent: 'No block templates yet — click “New template”.' })));
    for (const t of tpls) {
      const airings = (t.slots || []).map((s) => `${s.start_time}–${s.end_time}`).join(', ') || `${t.start_time}–${t.end_time}`;
      const series = (t.series || []).map((s) => s.subject).join(', ') || (t.target_subject || '—');
      const edit = el('button', { className: 'mini ghost', textContent: 'edit' });
      edit.onclick = () => openTemplate(t);
      const del = el('button', { className: 'mini danger', textContent: 'delete' });
      del.onclick = async () => {
        if (!await confirmDialog('Delete template', `Delete “${t.name}”? Existing generated blocks are unaffected until regenerated.`, { confirmLabel: 'Delete', danger: true })) return;
        await withBusy(del, async () => { await api.send('DELETE', `/api/blocks/templates/${t.id}`); toast('Template deleted', 'ok'); await loadSetupTab(); });
      };
      const td = el('td'); td.style.textAlign = 'right'; td.append(edit, document.createTextNode(' '), del);
      tt.append(el('tr', {},
        el('td', { textContent: chName[t.channel_id] || t.channel_id }),
        el('td', { textContent: t.name }),
        el('td', { textContent: (t.weekdays || t.weekday || '').replaceAll(',', ' ') }),
        el('td', { textContent: airings }),
        el('td', { textContent: series }),
        td));
    }
  } catch (e) { toast(e.message, 'bad', 'Setup'); }
}

// ---- Series manager modal --------------------------------------------------
let seriesChannel = null;
let seriesRows = [];        // [{subject, is_serial, is_active, show_type_name, chapter_count, total_duration}]
let seriesDragIdx = null;

async function openSeries(channel) {
  seriesChannel = channel;
  $('#seriesTitle').textContent = `Series — ${channel.name}`;
  $('#seriesChapters').innerHTML = '';
  try { seriesRows = await api.get(`/api/channels/${channel.id}/series`); }
  catch (e) { return toast(e.message, 'bad', 'Series'); }
  renderSeries();
  $('#seriesModal').classList.remove('hidden');
}

function renderSeries() {
  const list = $('#seriesList');
  list.innerHTML = '';
  if (!seriesRows.length) {
    list.append(el('li', { className: 'muted', textContent: 'No series detected yet — scan media, then “Detect from catalog”.' }));
  }
  seriesRows.forEach((s, idx) => {
    const li = el('li', { draggable: true });
    li.append(el('span', { className: 'drag', textContent: '⠿', title: 'Drag to reorder' }));
    li.append(el('span', { className: 'idx', textContent: String(idx + 1) }));
    li.append(el('span', { className: 'grow', textContent: `${s.subject}  ` }, el('small', { className: 'muted', textContent: `${s.show_type_name || '—'} · ${s.chapter_count} ch · ${fmt(s.total_duration)}` })));
    const serial = el('label', { className: 'chk', title: 'Plays chapter-by-chapter' }, el('input', { type: 'checkbox', checked: !!s.is_serial }), document.createTextNode(' serial'));
    serial.querySelector('input').onchange = (e) => { s.is_serial = e.target.checked ? 1 : 0; };
    const active = el('label', { className: 'chk', title: 'Available for scheduling' }, el('input', { type: 'checkbox', checked: !!s.is_active }), document.createTextNode(' active'));
    active.querySelector('input').onchange = (e) => { s.is_active = e.target.checked ? 1 : 0; };
    const chaptersBtn = el('button', { className: 'mini ghost', textContent: 'chapters' });
    chaptersBtn.onclick = () => showChapters(s.subject);
    li.append(serial, active, chaptersBtn);

    // Next-episode cursor controls for serial series.
    if (s.is_serial) {
      const label = el('span', { className: 'cursor-badge', title: 'Next episode to air' });
      const paint = () => { label.textContent = `next #${s.cursor_chapter ?? 1}`; };
      paint();
      const nudge = (delta) => async () => {
        try {
          const r = await api.send('POST', `/api/channels/${seriesChannel.id}/series/${encodeURIComponent(s.subject)}/cursor`, { delta });
          s.cursor_chapter = r.cursor; paint();
        } catch (e) { toast(e.message, 'bad', 'Cursor'); }
      };
      const down = el('button', { className: 'mini ghost', textContent: '↓', title: 'Rewind one episode' });
      const up = el('button', { className: 'mini ghost', textContent: '↑', title: 'Advance one episode' });
      down.onclick = nudge(-1); up.onclick = nudge(1);
      li.append(down, label, up);
    }

    li.addEventListener('dragstart', () => { seriesDragIdx = idx; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { seriesDragIdx = null; li.classList.remove('dragging'); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (seriesDragIdx === null || seriesDragIdx === idx) return;
      const [m] = seriesRows.splice(seriesDragIdx, 1);
      seriesRows.splice(idx, 0, m);
      renderSeries();
    });
    list.append(li);
  });
}

let chapterRows = [];
let chapterDragIdx = null;
async function showChapters(subject) {
  const box = $('#seriesChapters');
  box.innerHTML = '';
  try {
    chapterRows = await api.get(`/api/channels/${seriesChannel.id}/series/${encodeURIComponent(subject)}/chapters`);
  } catch (e) { return toast(e.message, 'bad', 'Chapters'); }
  const head = el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:10px' });
  head.append(el('div', { className: 'form-title', textContent: `Chapters — ${subject}`, style: 'margin:0' }));
  const saveBtn = el('button', { className: 'mini primary', textContent: 'Save order' });
  saveBtn.onclick = () => withBusy(saveBtn, async () => {
    await api.send('PUT', `/api/channels/${seriesChannel.id}/series/${encodeURIComponent(subject)}/chapters`,
      { order: chapterRows.map((r) => r.id) });
    toast('Chapter order saved', 'ok');
    await showChapters(subject);
  });
  head.append(saveBtn);
  box.append(head);
  box.append(el('div', { className: 'hint muted', textContent: 'Drag to reorder — position becomes the play order (chapter number).' }));
  box.append(el('ol', { className: 'items compact', id: 'chapterList' }));
  renderChapters();
}
// Render the reorderable chapter list; used on first show and after each drag.
function renderChapters() {
  const ol = $('#chapterList');
  if (!ol) return;
  ol.innerHTML = '';
  chapterRows.forEach((r, idx) => {
    const li = el('li', { draggable: true });
    li.append(el('span', { className: 'drag', textContent: '⠿' }));
    li.append(el('span', { className: 'idx', textContent: String(idx + 1) }));
    li.append(el('span', { className: 'grow', textContent: r.name }));
    li.append(el('span', { className: 'dur', textContent: fmt(r.duration) }));
    li.addEventListener('dragstart', () => { chapterDragIdx = idx; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { chapterDragIdx = null; li.classList.remove('dragging'); });
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (chapterDragIdx === null || chapterDragIdx === idx) return;
      const [m] = chapterRows.splice(chapterDragIdx, 1);
      chapterRows.splice(idx, 0, m);
      renderChapters();
    });
    ol.append(li);
  });
}

$('#btnDetectSeries').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', `/api/channels/${seriesChannel.id}/series/detect`);
  toast(`Detected ${r.added} new series`, 'ok');
  seriesRows = await api.get(`/api/channels/${seriesChannel.id}/series`);
  renderSeries();
}));
$('#btnSaveSeries').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const payload = seriesRows.map((s, idx) => ({ subject: s.subject, play_order: idx, is_serial: s.is_serial ? 1 : 0, is_active: s.is_active ? 1 : 0, show_type_id: s.show_type_id ?? null }));
  await api.send('PUT', `/api/channels/${seriesChannel.id}/series`, { series: payload });
  toast('Series saved', 'ok');
  $('#seriesModal').classList.add('hidden');
}));
$('#seriesClose').addEventListener('click', () => $('#seriesModal').classList.add('hidden'));
$('#seriesModal').addEventListener('click', (e) => { if (e.target.id === 'seriesModal') $('#seriesModal').classList.add('hidden'); });

// ---- Template editor modal -------------------------------------------------
let tplEditing = null;      // template id when editing, null when creating
let tplSlots = [];          // [{start_time, end_time}]
let tplSeries = [];         // [{subject, checked}] ordered
let tplSeriesDragIdx = null;

// The channel whose series populate the picker (subjects are shared across
// channels that share folders, so the first checked channel is representative).
function tplPrimaryChannel() {
  const first = $$('#tplmChannels input:checked')[0];
  return first ? Number(first.value) : (setupChannels[0]?.id ?? '');
}

async function openTemplate(t) {
  tplEditing = t ? t.id : null;
  $('#tplmTitle').textContent = t ? `Edit template — ${t.name}` : 'New block template';
  if (!setupChannels.length) setupChannels = await api.get('/api/channels');
  const selected = new Set(t ? (t.channels?.length ? t.channels : [t.channel_id]) : (setupChannels[0] ? [setupChannels[0].id] : []));
  const chBox = $('#tplmChannels'); chBox.innerHTML = '';
  for (const c of setupChannels) {
    const lbl = el('label', { className: 'chk' }, el('input', { type: 'checkbox', value: c.id, checked: selected.has(c.id) }), document.createTextNode(' ' + c.name));
    lbl.querySelector('input').onchange = () => loadTplSeries(tplPrimaryChannel(), tplSeries.filter((s) => s.checked).map((s) => s.subject));
    chBox.append(lbl);
  }
  $('#tplmName').value = t ? t.name : '';
  $('#btnDeleteTpl').style.display = t ? '' : 'none';

  const days = new Set((t?.weekdays || t?.weekday || '').split(',').map((x) => x.trim()).filter(Boolean));
  const wd = $('#tplmWeekdays'); wd.innerHTML = '';
  for (const d of WEEKDAYS) {
    const lbl = el('label', { className: 'chk' }, el('input', { type: 'checkbox', value: d, checked: days.has(d) }), document.createTextNode(' ' + d));
    wd.append(lbl);
  }

  tplSlots = t?.slots?.length ? t.slots.map((s) => ({ start_time: s.start_time, end_time: s.end_time })) : [{ start_time: '18:00', end_time: '20:00' }];
  renderTplSlots();

  const included = (t?.series || []).map((s) => s.subject);
  await loadTplSeries(tplPrimaryChannel(), included);

  $('#templateModal').classList.remove('hidden');
}

async function loadTplSeries(channelId, included = []) {
  let rows = [];
  try { rows = await api.get(`/api/channels/${channelId}/series`); } catch { /* none */ }
  const active = rows.filter((r) => r.is_active);
  // Ordered: included-in-order first, then the rest.
  const bySubject = Object.fromEntries(active.map((r) => [r.subject, r]));
  const ordered = [];
  for (const subj of included) if (bySubject[subj]) { ordered.push({ subject: subj, checked: true, meta: bySubject[subj] }); delete bySubject[subj]; }
  for (const r of active) if (bySubject[r.subject]) ordered.push({ subject: r.subject, checked: false, meta: r });
  tplSeries = ordered;
  renderTplSeries();
}

function renderTplSlots() {
  const box = $('#tplmSlots'); box.innerHTML = '';
  tplSlots.forEach((s, idx) => {
    const row = el('div', { className: 'slot-row' });
    row.append(el('span', { className: 'idx', textContent: idx === 0 ? 'primary' : `#${idx + 1}` }));
    const start = el('input', { value: s.start_time, placeholder: 'HH:MM', size: 5 });
    const end = el('input', { value: s.end_time, placeholder: 'HH:MM', size: 5 });
    start.onchange = () => { s.start_time = start.value; };
    end.onchange = () => { s.end_time = end.value; };
    row.append(start, document.createTextNode(' – '), end);
    if (tplSlots.length > 1) {
      const rm = el('button', { className: 'mini danger', type: 'button', textContent: '✕' });
      rm.onclick = () => { tplSlots.splice(idx, 1); renderTplSlots(); };
      row.append(rm);
    }
    box.append(row);
  });
}
$('#btnAddSlot').addEventListener('click', () => { tplSlots.push({ start_time: '20:00', end_time: '22:00' }); renderTplSlots(); });

function renderTplSeries() {
  const list = $('#tplmSeries'); list.innerHTML = '';
  if (!tplSeries.length) { list.append(el('li', { className: 'muted', textContent: 'No active series on this channel — open the channel’s Series manager first.' })); return; }
  tplSeries.forEach((s, idx) => {
    const li = el('li', { draggable: true });
    li.append(el('span', { className: 'drag', textContent: '⠿' }));
    const cb = el('input', { type: 'checkbox', checked: s.checked });
    cb.onchange = () => { s.checked = cb.checked; };
    li.append(cb);
    li.append(el('span', { className: 'grow', textContent: ` ${s.subject}  ` }, el('small', { className: 'muted', textContent: `${s.meta.show_type_name || '—'}${s.meta.is_serial ? ' · serial' : ''}` })));
    li.addEventListener('dragstart', () => { tplSeriesDragIdx = idx; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { tplSeriesDragIdx = null; li.classList.remove('dragging'); });
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      if (tplSeriesDragIdx === null || tplSeriesDragIdx === idx) return;
      const [m] = tplSeries.splice(tplSeriesDragIdx, 1);
      tplSeries.splice(idx, 0, m);
      renderTplSeries();
    });
    list.append(li);
  });
}

$('#btnSaveTpl').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const weekdays = $$('#tplmWeekdays input:checked').map((i) => i.value);
  const name = $('#tplmName').value.trim();
  const channels = $$('#tplmChannels input:checked').map((i) => Number(i.value));
  const slots = tplSlots.filter((s) => s.start_time && s.end_time);
  const series = tplSeries.filter((s) => s.checked).map((s) => s.subject);
  if (!name || !channels.length || !weekdays.length || !slots.length) return toast('Name, at least one channel, one weekday and one airing are required', 'bad', 'Template');
  const body = { channels, channel_id: channels[0], name, weekdays, slots, series };
  if (tplEditing) await api.send('PUT', `/api/blocks/templates/${tplEditing}`, body);
  else await api.send('POST', '/api/blocks/templates', body);
  $('#templateModal').classList.add('hidden');
  toast('Template saved', 'ok');
  await loadSetupTab();
}));
$('#btnDeleteTpl').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  if (!tplEditing) return;
  if (!await confirmDialog('Delete template', 'Delete this template?', { confirmLabel: 'Delete', danger: true })) return;
  await api.send('DELETE', `/api/blocks/templates/${tplEditing}`);
  $('#templateModal').classList.add('hidden');
  toast('Template deleted', 'ok');
  await loadSetupTab();
}));
$('#btnNewTemplate').addEventListener('click', () => openTemplate(null));
$('#tplmClose').addEventListener('click', () => $('#templateModal').classList.add('hidden'));
$('#templateModal').addEventListener('click', (e) => { if (e.target.id === 'templateModal') $('#templateModal').classList.add('hidden'); });

// ---- Channel editor modal --------------------------------------------------
let chEditing = null;
function openChannelEditor(c) {
  chEditing = c.id;
  $('#chmTitle').textContent = `Edit channel — ${c.name}`;
  $('#chmName').value = c.name ?? '';
  $('#chmIp').value = c.api_ip ?? '';
  $('#chmPort').value = c.api_port ?? '';
  $('#chmPlaylist').value = c.playlist_ref ?? '';
  $('#chmUser').value = c.api_username ?? '';
  $('#chmPass').value = c.api_password ?? '';
  $('#chmActive').checked = !!c.is_active;
  $('#channelModal').classList.remove('hidden');
}
$('#chmSave').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  if (chEditing == null) return;
  const body = {
    name: $('#chmName').value.trim(),
    api_ip: $('#chmIp').value.trim() || null,
    api_port: $('#chmPort').value ? Number($('#chmPort').value) : null,
    playlist_ref: $('#chmPlaylist').value.trim() || null,
    api_username: $('#chmUser').value.trim() || null,
    api_password: $('#chmPass').value || null,
    is_active: $('#chmActive').checked ? 1 : 0,
  };
  await api.send('PUT', `/api/channels/${chEditing}`, body);
  $('#channelModal').classList.add('hidden');
  toast('Channel saved', 'ok');
  await loadSetupTab();
}));
$('#chmClose').addEventListener('click', () => $('#channelModal').classList.add('hidden'));
$('#channelModal').addEventListener('click', (e) => { if (e.target.id === 'channelModal') $('#channelModal').classList.add('hidden'); });

// Channel add form (the only remaining inline form).
function formToObj(form) {
  const o = {};
  for (const elm of form.elements) {
    if (!elm.name) continue;
    o[elm.name] = elm.type === 'checkbox' ? (elm.checked ? 1 : 0) : elm.value;
  }
  return o;
}
$('#channelForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  await withBusy(btn, async () => {
    await api.send('POST', '/api/channels', formToObj(e.target));
    e.target.reset();
    toast('Channel added', 'ok');
    await loadSetupTab();
  });
});

// ---- Boot ------------------------------------------------------------------
loadSchedule();
