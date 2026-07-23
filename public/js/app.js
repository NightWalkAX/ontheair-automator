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
    toast(`Assigned folder to ${n} channel${n === 1 ? '' : 's'}`, 'ok');
    await loadRoots();
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
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', { textContent: r.channel_name }), el('td', { textContent: r.show_type_name }), el('td', { className: 'path-cell', textContent: r.path }));
    const btnScan = el('button', { className: 'mini ghost', textContent: 'scan' });
    btnScan.onclick = () => withBusy(btnScan, async () => {
      const x = await api.send('POST', `/api/media/roots/${r.id}/scan`);
      toast(`Ingested ${x.ingested} of ${x.scanned}`, 'ok', r.path.split('/').pop());
    });
    const btnEdit = el('button', { className: 'mini ghost', textContent: 'edit' });
    btnEdit.onclick = () => editRoot(r);
    const btnDel = el('button', { className: 'mini danger', textContent: 'delete' });
    btnDel.onclick = async () => {
      if (!await confirmDialog('Delete media root', `Remove the root “${r.path}” and drop every resource it cataloged for ${r.channel_name}? This also removes those clips from any draft blocks.`, { confirmLabel: 'Delete', danger: true })) return;
      await withBusy(btnDel, async () => {
        const res = await api.send('DELETE', `/api/media/roots/${r.id}`);
        toast(`Root removed — ${res.deletedResources ?? 0} resource(s) dropped`, 'ok');
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
