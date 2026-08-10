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
$('#btnDownload').addEventListener('click', () => {
  // Printable schedule (fillers excluded) for the current week + channel filter.
  // No channel filter → one combined document covering every channel.
  const week = $('#weekStart').value || isoToday();
  window.open(`/api/blocks/export?week=${week}${scheduleChannelQuery()}`, '_blank');
});
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
// A template repeating on several weekdays yields one block per date, and each
// date is its own playlist — so pushing a single day airs only that day.
async function pushToAir(btn, { scope }) {
  const day = $('#pushDate').value;
  const week = $('#weekStart').value;
  const query = scope === 'week' ? `week=${week}` : `date=${day}`;
  const what = scope === 'week' ? `the week starting ${week} (7 days)` : day;
  const ok = await confirmDialog('Push to Air',
    `This pushes all approved blocks for ${what} to the live OTAV instances. Continue?`,
    { confirmLabel: 'Push to Air', danger: true });
  if (!ok) return;
  await withBusy(btn, async () => {
    const r = await api.send('POST', `/api/otav/push?${query}`);
    reportDialog('Push report', r.channels.map((c) => ({
      name: c.date ? `${c.date} · ${c.channel}` : c.channel,
      ok: c.ok,
      detail: c.ok
        ? `${c.pushed} clips → “${c.playlist}” (${{
            prepared: 'file written + event upserted', created: 'created', open: 'reused',
            schedule: 'opened from schedule', fallback: 'fallback playlist',
          }[c.source] || c.source || 'ok'})${c.warning ? ` — ${c.warning}` : ''}`
        : c.error,
    })));
    const failed = r.channels.filter((c) => !c.ok).length;
    const skipped = (r.skipped || []).length;
    toast(failed ? `${failed} push(es) failed`
          : `${r.channels.length} pushed${skipped ? `, ${skipped} day(s) had nothing approved` : ''}`,
          failed ? 'bad' : 'ok', 'Push complete');
    await loadSchedule();
  });
}
$('#btnPush').addEventListener('click', (e) => pushToAir(e.currentTarget, { scope: 'day' }));
$('#btnPushWeek').addEventListener('click', (e) => pushToAir(e.currentTarget, { scope: 'week' }));

// ---- Block editor modal ----------------------------------------------------
let currentBlock = null;
let currentItems = [];      // [{resource_id, name, duration, is_filler, is_manual_override}]
let allResources = [];
let currentMirror = false;  // true when the open block is a mirrored airing (read-only)

// Library pane (left side of the block editor).
let libSearch = '';
let libType = '';           // show_type_code
let libSubject = '';        // Resource.subject
const libSel = new Set();   // selected resource ids
let libAnchorId = null;     // last-clicked row — anchor for shift-range selection
let blkDrag = null;         // { kind: 'lib', ids: [...] } | { kind: 'item', idx }

const TYPE_LABELS = { movies: 'Películas', documentaries: 'Documentales', tv_shows: 'Series TV', lessons: 'Clases', fillers: 'Fillers' };
const LIB_RENDER_CAP = 300;   // rows drawn at once; filtering/stride still see all
const BULK_ADD_WARN = 25;     // ask before dumping this many clips into a block

// A library row turned into a block item (same shape the add-button used).
const resourceToItem = (r) => ({
  resource_id: r.id, name: r.name, label: r.label, subject: r.subject,
  season: r.season, episode_no: r.episode_no, episode_code: r.episode_code,
  chapter: r.chapter, duration: r.duration, is_filler: r.is_filler, is_manual_override: 1,
});

// The library list as currently filtered — the order stride-select works on.
function libFiltered() {
  const q = libSearch.trim().toLowerCase();
  return allResources.filter((r) => {
    if (libType && (r.show_type_code || '') !== libType) return false;
    if (libSubject && (r.subject || '') !== libSubject) return false;
    if (!q) return true;
    return (r.label || '').toLowerCase().includes(q)
      || (r.display_name || '').toLowerCase().includes(q)
      || (r.name || '').toLowerCase().includes(q)
      || (r.subject || '').toLowerCase().includes(q);
  });
}

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
  $('#beLib').style.display = currentMirror ? 'none' : '';
  $('.block-editor').classList.toggle('mirror', currentMirror);
  $('#btnSaveItems').style.display = currentMirror ? 'none' : '';

  libSearch = ''; libType = ''; libSubject = '';
  libSel.clear(); libAnchorId = null;
  $('#libSearch').value = '';
  renderLibrary();
  renderBlockControls();
  renderItems();
  $('#modal').classList.remove('hidden');
}

// Per-show summary chips, the max-per-show cap control, and a draggable show-
// order strip. Hidden for mirrored airings (they copy their primary verbatim).
let showOrderDrag = null;
function renderBlockControls() {
  const box = $('#blockControls');
  box.innerHTML = '';
  if (currentMirror) return;

  // Per-show counts (main content only), in first-appearance order.
  const counts = new Map();
  for (const it of currentItems) {
    if (it.is_filler) continue;
    const k = it.subject || it.name;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const fillerCount = currentItems.filter((i) => i.is_filler).length;

  const summary = el('div', { className: 'bc-summary' });
  summary.append(el('span', { className: 'muted', textContent: 'Per show:' }));
  for (const [name, n] of counts) summary.append(el('span', { className: 'chip-count', textContent: `${name} ×${n}` }));
  if (fillerCount) summary.append(el('span', { className: 'chip-count filler', textContent: `fillers ×${fillerCount}` }));
  box.append(summary);

  // Max-per-show cap control (writes to the template, rebuilds this block).
  const capRow = el('div', { className: 'bc-row' });
  capRow.append(el('label', { className: 'muted', textContent: 'Max episodes per show:' }));
  const capInp = el('input', { className: 'cat-ord', type: 'number', min: '0', step: '1',
    value: currentBlock.block.max_per_show || '', placeholder: '0 = unlimited', style: 'max-width:120px' });
  const capBtn = el('button', { className: 'mini ghost', textContent: 'Apply & refill' });
  capBtn.onclick = () => withBusy(capBtn, async () => {
    const v = await api.send('PUT', `/api/blocks/${currentBlock.block.id}/max-per-show`, { max: Number(capInp.value) || 0 });
    currentBlock = v; currentItems = v.items.map((i) => ({ ...i }));
    renderBlockControls(); renderItems();
    toast('Cap applied — block refilled (also applies to future generations)', 'ok');
    loadSchedule();
  });
  capRow.append(capInp, capBtn);
  box.append(capRow);

  // Show-order strip: drag the show chips to set the cycle order, then refill.
  const shows = [...counts.keys()];
  if (shows.length > 1) {
    const orderRow = el('div', { className: 'bc-row' });
    orderRow.append(el('label', { className: 'muted', textContent: 'Show order:' }));
    const strip = el('div', { className: 'show-order' });
    let order = shows.slice();
    const paint = () => {
      strip.innerHTML = '';
      order.forEach((s, i) => {
        const chip = el('span', { className: 'chip-order', draggable: true, textContent: s });
        chip.addEventListener('dragstart', () => { showOrderDrag = i; chip.classList.add('dragging'); });
        chip.addEventListener('dragend', () => { showOrderDrag = null; chip.classList.remove('dragging'); });
        chip.addEventListener('dragover', (e) => e.preventDefault());
        chip.addEventListener('drop', (e) => {
          e.preventDefault();
          if (showOrderDrag === null || showOrderDrag === i) return;
          const [m] = order.splice(showOrderDrag, 1); order.splice(i, 0, m); paint();
        });
        strip.append(chip);
      });
    };
    paint();
    const applyBtn = el('button', { className: 'mini ghost', textContent: 'Apply order & refill' });
    applyBtn.onclick = () => withBusy(applyBtn, async () => {
      const v = await api.send('PUT', `/api/blocks/${currentBlock.block.id}/series-order`, { subjects: order });
      currentBlock = v; currentItems = v.items.map((i) => ({ ...i }));
      renderBlockControls(); renderItems();
      toast('Show order applied — block refilled', 'ok');
      loadSchedule();
    });
    orderRow.append(strip, applyBtn);
    box.append(orderRow);
  }
}

// Clock time (HH:MM) `offsetSecs` after a base 'HH:MM' block start.
function clockAt(baseHHMM, offsetSecs) {
  const [h, m] = String(baseHHMM || '00:00').split(':').map(Number);
  const t = (((h * 3600 + m * 60 + offsetSecs) % 86400) + 86400) % 86400;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

function renderItems() {
  const list = $('#itemList');
  list.innerHTML = '';
  const totalSecs = currentItems.reduce((s, i) => s + i.duration, 0);
  $('#blockCount').textContent = `${currentItems.length} item(s) · ${fmt(totalSecs)}`;
  const blockStart = currentBlock?.block?.start_time || '00:00';
  let acc = 0; // running seconds from block start, for air-times
  currentItems.forEach((it, idx) => {
    const airAt = clockAt(blockStart, acc);
    acc += it.duration;
    const li = el('li', { className: it.is_filler ? 'filler' : '', draggable: !currentMirror });
    if (!currentMirror) li.append(el('span', { className: 'drag', textContent: '⠿', title: 'Drag to reorder' }));
    li.append(el('span', { className: 'air', textContent: airAt, title: 'On-air time' }));
    li.append(el('span', { className: 'idx', textContent: String(idx + 1) }));
    // The server names every item "Show · S01E02" (labels.js); the filename and
    // the internal chapter number stay out of sight, in the tooltip.
    const label = it.label || it.name;
    li.append(el('span', {
      className: 'grow',
      textContent: `${label}${it.is_manual_override ? ' *' : ''}`,
      title: it.name,
    }));
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
          epSel.append(el('option', {
            value: c.chapter,
            textContent: c.episode_code || c.name,
            selected: c.chapter === it.chapter,
          }));
        }
        epSel.onchange = () => withBusy(null, async () => {
          const picked = chapters.find((c) => c.chapter === Number(epSel.value));
          await api.send('POST', `/api/blocks/${currentBlock.block.id}/items/${it.id}/set-episode`, { chapter: Number(epSel.value) });
          toast(`Starting at ${picked?.episode_code || 'that episode'} — this block and later drafts rebuilt`, 'ok', it.subject);
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

    li.addEventListener('dragstart', () => { blkDrag = { kind: 'item', idx }; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => { blkDrag = null; li.classList.remove('dragging'); $$('#itemList li').forEach((x) => x.classList.remove('drag-over')); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); li.classList.add('drag-over'); });
    li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      li.classList.remove('drag-over');
      if (!blkDrag) return;
      if (blkDrag.kind === 'lib') {
        const ids = blkDrag.ids;
        blkDrag = null;
        addResourcesToBlock(ids, idx);
        return;
      }
      const from = blkDrag.idx;
      blkDrag = null;
      if (from === idx) return;
      const [moved] = currentItems.splice(from, 1);
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

// ---- Library pane ----------------------------------------------------------
// Rebuild the two filter dropdowns from what the channel actually has, keeping
// the current pick when it survives the other filter.
function renderLibFilters() {
  const typeSel = $('#libType');
  const types = [...new Set(allResources.map((r) => r.show_type_code).filter(Boolean))].sort();
  typeSel.innerHTML = '';
  typeSel.append(el('option', { value: '', textContent: 'Todos los tipos' }));
  for (const c of types) typeSel.append(el('option', { value: c, textContent: TYPE_LABELS[c] || c, selected: c === libType }));

  const subjSel = $('#libSubject');
  const subjects = [...new Set(allResources
    .filter((r) => !libType || r.show_type_code === libType)
    .map((r) => r.subject).filter(Boolean))].sort();
  subjSel.innerHTML = '';
  subjSel.append(el('option', { value: '', textContent: 'Todos los shows' }));
  for (const s of subjects) subjSel.append(el('option', { value: s, textContent: s, selected: s === libSubject }));
  if (libSubject && !subjects.includes(libSubject)) { libSubject = ''; subjSel.value = ''; }
}

function renderLibrary() {
  if (currentMirror) return;
  renderLibFilters();
  const rows = libFiltered();
  const list = $('#libList');
  list.innerHTML = '';
  $('#libCount').textContent = `${rows.length} clip(s)${libSel.size ? ` · ${libSel.size} seleccionado(s)` : ''}`;

  if (!rows.length) {
    list.append(el('li', { className: 'muted', textContent: 'Nada coincide con el filtro.' }));
    return;
  }
  // A full channel catalogue runs to thousands of clips and this re-renders on
  // every keystroke — draw a window, keep selection/stride over the full match.
  const shown = rows.slice(0, LIB_RENDER_CAP);
  shown.forEach((r, idx) => {
    const li = el('li', { className: r.is_filler ? 'filler' : '', draggable: true });
    li.dataset.id = r.id;
    li.append(el('span', { className: 'drag', textContent: '⠿', title: 'Arrastra al bloque' }));
    const cb = el('input', { type: 'checkbox', className: 'cat-sel', checked: libSel.has(r.id), title: 'Selecciona — Shift-clic para un rango' });
    cb.addEventListener('click', (e) => {
      if (e.shiftKey && libAnchorId != null) {
        const order = rows.map((x) => x.id);
        const a = order.indexOf(libAnchorId), b = order.indexOf(r.id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) { if (cb.checked) libSel.add(order[i]); else libSel.delete(order[i]); }
        }
      } else if (cb.checked) libSel.add(r.id); else libSel.delete(r.id);
      libAnchorId = r.id;
      renderLibrary();
    });
    li.append(cb);
    li.append(el('span', { className: 'idx', textContent: String(idx + 1) }));
    li.append(el('span', { className: 'grow', textContent: r.label || r.name, title: r.name }));
    li.append(el('span', { className: 'dur', textContent: fmt(r.duration) }));
    const add = el('button', { className: 'mini ghost', textContent: '→', title: 'Añadir al final del bloque' });
    add.onclick = () => { currentItems.push(resourceToItem(r)); renderItems(); };
    li.append(add);

    // Dragging a selected row carries the whole selection, in list order.
    li.addEventListener('dragstart', (e) => {
      const ids = libSel.has(r.id) ? rows.filter((x) => libSel.has(x.id)).map((x) => x.id) : [r.id];
      blkDrag = { kind: 'lib', ids };
      e.dataTransfer.effectAllowed = 'copy';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => { blkDrag = null; li.classList.remove('dragging'); });
    list.append(li);
  });
  if (rows.length > shown.length) {
    list.append(el('li', { className: 'muted', textContent:
      `Mostrando ${shown.length} de ${rows.length} — afina el filtro. La selección y el paso se aplican a los ${rows.length}.` }));
  }
}

// Insert library resources into the block at `idx` (end when idx is null).
// Every path in (button, drag-drop) goes through here so the bulk guard can't
// be sidestepped — dragging one selected row carries the whole selection.
async function addResourcesToBlock(ids, idx) {
  const rows = ids.map((id) => allResources.find((r) => r.id === id)).filter(Boolean);
  if (!rows.length) return;
  if (rows.length >= BULK_ADD_WARN) {
    const secs = rows.reduce((s, r) => s + r.duration, 0);
    if (!await confirmDialog('Añadir al bloque',
      `Vas a añadir ${rows.length} clips (${fmt(secs)}) a un bloque de ${fmt(currentBlock.blockSeconds)}. ¿Continuar?`,
      { confirmLabel: `Añadir ${rows.length}` })) return;
  }
  const items = rows.map(resourceToItem);
  if (idx == null || idx >= currentItems.length) currentItems.push(...items);
  else currentItems.splice(idx, 0, ...items);
  libSel.clear();
  renderItems();
  renderLibrary();
}

$('#libSearch').addEventListener('input', (e) => { libSearch = e.currentTarget.value; renderLibrary(); });
$('#libType').addEventListener('change', (e) => { libType = e.currentTarget.value; renderLibrary(); });
$('#libSubject').addEventListener('change', (e) => { libSubject = e.currentTarget.value; renderLibrary(); });
$('#btnLibAll').addEventListener('click', () => { libFiltered().forEach((r) => libSel.add(r.id)); renderLibrary(); });
$('#btnLibNone').addEventListener('click', () => { libSel.clear(); renderLibrary(); });

// Stride select: take every Nth row starting at the Xth, over the filtered list.
// Two shows interleaved in one folder land as 1,3,5… and 2,4,6… — this splits them.
$('#btnLibStride').addEventListener('click', () => {
  const n = Math.max(1, Number($('#libStrideN').value) || 1);
  const off = Math.max(1, Number($('#libStrideOff').value) || 1);
  const rows = libFiltered();
  libSel.clear();
  for (let i = off - 1; i < rows.length; i += n) libSel.add(rows[i].id);
  renderLibrary();
  toast(`${libSel.size} clip(s) seleccionados (1 de cada ${n} desde ${off})`, 'ok', 'Selección');
});

$('#btnAddSelected').addEventListener('click', () => {
  const rows = libFiltered().filter((r) => libSel.has(r.id));
  if (!rows.length) return toast('No hay nada seleccionado', 'bad', 'Biblioteca');
  addResourcesToBlock(rows.map((r) => r.id), null);
});

// Dropping on empty space below the last item appends.
$('#itemList').addEventListener('dragover', (e) => { if (blkDrag) e.preventDefault(); });
$('#itemList').addEventListener('drop', (e) => {
  if (!blkDrag || currentMirror) return;
  e.preventDefault();
  if (e.target.closest('li')) return;   // a row handled it
  if (blkDrag.kind === 'lib') addResourcesToBlock(blkDrag.ids, null);
  blkDrag = null;
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
    // #templateModal has its own Esc handler — it confirms before discarding edits.
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
      el('td', { textContent: r.label || r.name, title: r.name }),
      el('td', { textContent: r.subject || '—' }),
      el('td', { textContent: r.is_filler ? '—' : (r.episode_code || '—') }),
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

// ---- Catalog Editor — dual file-browser -----------------------------------
// The catalog is navigated like a file system on BOTH sides. The left (engine)
// pane is how the scheduler sees the channel: Show Type ▸ Show ▸ Season ▸
// episodes. The right (Library) pane mirrors the real on-disk folder tree for
// the current show type — because filenames alone often omit the show name, so
// the folder context is what tells you what a clip is. Drag a folder or clip
// from the Library onto a show to organize it — you're asked which season the
// clips belong to (blank keeps the seasons parsed from their filenames), or drop
// straight onto a season folder to skip the question. A whole show that turned
// out to be one season of another can be folded in with "Merge into show…".
// Multi-select checkboxes on the left drive bulk edits.
// Nothing is available to the scheduler until it is approved here.
// Non-destructive: files on disk are never moved or renamed.

let catEpisodes = [];            // flat list of resources for the channel
let catReg = new Map();          // subject -> ChannelSeries row (engine flags + cursor)
let catShowTypes = [];
let catChannels = [];
let catChannelId = null;
let catSearch = '';              // free-text filter (folders + clips)

// Engine (left) file-browser location. null engType = the show-type list (root).
let engType = null;              // show type name
let engSubject = null;           // show key: a subject, or UNSORTED / FILLERS, or null (show list)
let engSeason = null;            // season number within a show, or null (show root)

// Library (right) file-browser location: on-disk folder segments below the root.
let libPath = [];

const catSel = new Set();        // selected resource ids (multi-edit, left panel)
let catAnchorId = null;          // last-clicked episode id — anchor for shift-range selection
let catOrderInputs = [];         // { id, input } refs for "Fix order"
let catDrag = null;              // { kind:'lib'|'reorder', ids:[...] }

const UNSORTED = ' unsorted';
const FILLERS = ' fillers';

async function loadCatalogTab() {
  if (!catChannels.length) catChannels = await api.get('/api/channels');
  if (!catShowTypes.length) catShowTypes = await api.get('/api/showtypes');
  const sel = $('#catChannel');
  if (!sel.options.length) {
    for (const c of catChannels) sel.append(el('option', { value: c.id, textContent: c.name }));
  }
  await loadCatalog();
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
  pruneSelection();
  renderCatalog();
}

// Drop ids from the selection that no longer exist after a reload.
function pruneSelection() {
  const alive = new Set(catEpisodes.map((e) => e.id));
  for (const id of [...catSel]) if (!alive.has(id)) catSel.delete(id);
}

function renderCatalog() {
  syncSearchUI();
  renderCrumb();
  renderBulkBar();
  renderBrowser();
}

// The search box lives in the static toolbar (id=catSearch) so it never loses
// focus on re-render.
function syncSearchUI() {
  const inp = $('#catSearch');
  if (!inp) return;
  inp.placeholder = engType == null ? 'Search show types…' : 'Search folders & clips…';
  if (inp.value !== catSearch) inp.value = catSearch;
}

// ---- data helpers ----------------------------------------------------------
const typeNameOf = (e) => e.show_type_name || 'Unassigned';
const showTypeIdOfName = (name) => catShowTypes.find((s) => s.name === name)?.id ?? null;
const epsOfType = (name) => catEpisodes.filter((e) => typeNameOf(e) === name);
const bySeq = (a, b) => (a.chapter - b.chapter) || (a.id - b.id);

function epsOfShow(typeName, key) {
  const eps = epsOfType(typeName);
  if (key === FILLERS) return eps.filter((e) => e.is_filler);
  if (key === UNSORTED) return eps.filter((e) => !e.is_filler && e.subject == null);
  return eps.filter((e) => !e.is_filler && e.subject === key);
}

function approvalOf(list) {
  return { approved: list.filter((e) => e.approved).length, total: list.length };
}

// Every real show name on the channel, sorted — the union of subjects that have
// clips AND registry-only shows created but not yet filled (a just-made empty
// series lives only in catReg, so a clips-only list would hide it as a merge
// target). `except` drops the source show from its own merge list.
function allShowSubjects(except = null) {
  const s = new Set(catEpisodes.map((e) => e.subject).filter(Boolean));
  for (const subject of catReg.keys()) if (subject) s.add(subject);
  if (except != null) s.delete(except);
  return [...s].sort();
}
function matchEp(e, q) {
  return !q || (e.display_name || '').toLowerCase().includes(q)
    || (e.name || '').toLowerCase().includes(q)
    || (e.subject || '').toLowerCase().includes(q);
}

// The engine's next-up chapter for a serial series (cursor, else lowest chapter).
function nextUp(subject) {
  const reg = catReg.get(subject);
  const eps = epsOfShow(engType, subject).slice().sort(bySeq);
  const lo = eps.length ? eps[0].chapter : null;
  return reg && reg.cursor_chapter != null ? reg.cursor_chapter : lo;
}

// Show-type folders (level 0), including registry-only (empty) show types.
function typeFolders() {
  const m = new Map();
  const add = (name, id) => { if (!m.has(name)) m.set(name, { name, showTypeId: id ?? null, eps: [] }); return m.get(name); };
  for (const e of catEpisodes) add(typeNameOf(e), e.show_type_id).eps.push(e);
  for (const [subject, reg] of catReg) {
    if (catEpisodes.some((e) => e.subject === subject)) continue;
    add(catShowTypes.find((s) => s.id === reg.show_type_id)?.name || 'Unassigned', reg.show_type_id);
  }
  return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Show folders within a type: real shows (subjects) + registry-only empty
// series + pseudo "Unsorted" and "Fillers" pools.
function showFolders(typeName) {
  const eps = epsOfType(typeName);
  const shows = new Map();
  for (const e of eps) {
    if (e.is_filler || e.subject == null) continue;
    if (!shows.has(e.subject)) shows.set(e.subject, { key: e.subject, subject: e.subject, eps: [] });
    shows.get(e.subject).eps.push(e);
  }
  for (const [subject, reg] of catReg) {
    const tn = catShowTypes.find((s) => s.id === reg.show_type_id)?.name || 'Unassigned';
    if (tn !== typeName || shows.has(subject) || eps.some((e) => e.subject === subject)) continue;
    shows.set(subject, { key: subject, subject, eps: [] });
  }
  const out = [...shows.values()].sort((a, b) => a.subject.localeCompare(b.subject));
  const unsorted = eps.filter((e) => !e.is_filler && e.subject == null);
  const fillers = eps.filter((e) => e.is_filler);
  if (unsorted.length) out.push({ key: UNSORTED, subject: null, label: 'Unsorted', eps: unsorted, pseudo: true });
  if (fillers.length) out.push({ key: FILLERS, subject: null, label: 'Fillers', eps: fillers, pseudo: true });
  return out;
}

// Season folders + season-less episodes within a real show.
function seasonFolders(typeName, subject) {
  const eps = epsOfShow(typeName, subject).slice().sort(bySeq);
  const seasons = new Map();
  const noSeason = [];
  for (const e of eps) {
    if (e.season == null) { noSeason.push(e); continue; }
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push(e);
  }
  const seasonList = [...seasons.entries()].sort((a, b) => a[0] - b[0]).map(([season, list]) => ({ season, eps: list }));
  return { seasonList, noSeason };
}

// All episodes at/under the current engine location (bulk scope when nothing selected).
function scopeEpisodesAll() {
  if (engType == null) return catEpisodes.slice();
  if (engSubject == null) return epsOfType(engType);
  if (engSubject === UNSORTED || engSubject === FILLERS) return epsOfShow(engType, engSubject);
  let list = epsOfShow(engType, engSubject);
  if (engSeason != null) list = list.filter((e) => e.season === engSeason);
  return list;
}
function scopeIds() {
  if (catSel.size) return [...catSel];
  return scopeEpisodesAll().map((e) => e.id);
}

// ---- navigation ------------------------------------------------------------
function goRoot() { engType = null; engSubject = null; engSeason = null; libPath = []; catSel.clear(); catAnchorId = null; catSearch = ''; renderCatalog(); }
function goType(name) { engType = name; engSubject = null; engSeason = null; libPath = []; catSel.clear(); catAnchorId = null; catSearch = ''; renderCatalog(); }
function goShow(key) { engSubject = key; engSeason = null; catSel.clear(); catAnchorId = null; catSearch = ''; renderCatalog(); }
function goSeason(s) { engSeason = s; catSel.clear(); catAnchorId = null; renderCatalog(); }

// ---- breadcrumb + per-series controls --------------------------------------
function renderCrumb() {
  const crumb = $('#catCrumb'); crumb.innerHTML = '';
  const seg = (label, fn, cur = false) => {
    if (cur) return el('strong', { className: 'crumb-title', textContent: label });
    const b = el('button', { className: 'crumb-seg', textContent: label });
    b.onclick = fn; return b;
  };
  const sep = () => el('span', { className: 'crumb-sep', textContent: '›' });
  crumb.append(seg('📚 Show types', goRoot, engType == null));
  if (engType != null) {
    crumb.append(sep(), seg(`📁 ${engType}`, () => goType(engType), engSubject == null));
    if (engSubject != null) {
      const label = engSubject === UNSORTED ? '🗂 Unsorted' : engSubject === FILLERS ? '🎞 Fillers' : `🎬 ${engSubject}`;
      crumb.append(sep(), seg(label, () => goShow(engSubject), engSeason == null));
      if (engSeason != null) crumb.append(sep(), seg(`📁 Season ${engSeason}`, null, true));
    }
  }
  if (engType != null && engSubject != null && engSubject !== UNSORTED && engSubject !== FILLERS) {
    appendSeriesControls(crumb, engSubject);
  }
}

function appendSeriesControls(crumb, subject) {
  const reg = catReg.get(subject);
  const eps = epsOfShow(engType, subject);
  const showTypeId = reg?.show_type_id ?? eps[0]?.show_type_id ?? showTypeIdOfName(engType);
  const isSerial = reg ? !!reg.is_serial : false;
  const isActive = reg ? reg.is_active !== 0 : true;
  const { approved, total } = approvalOf(eps);
  crumb.append(approvalBadge(approved, total));

  const serial = el('label', { className: 'chk', title: 'Play episodes in order (serialize) — enable for movies too' });
  const scb = el('input', { type: 'checkbox', checked: isSerial });
  scb.onchange = () => withBusy(null, () => setSerial(subject, showTypeId, scb.checked));
  serial.append(scb, document.createTextNode(' serial'));

  const active = el('label', { className: 'chk', title: 'Include this series when generating schedules' });
  const acb = el('input', { type: 'checkbox', checked: isActive });
  acb.onchange = () => withBusy(null, () => setActive(subject, showTypeId, acb.checked));
  active.append(acb, document.createTextNode(' active'));

  const ren = el('button', { className: 'mini ghost', textContent: '✏️ rename' });
  ren.onclick = () => renameSeries(subject);
  const del = el('button', { className: 'mini danger', textContent: '🗑 delete', title: 'Delete this series (clips move to Unsorted; files on disk are untouched)' });
  del.onclick = () => deleteSeries(subject);
  crumb.append(serial, active, ren, del);

  if (isSerial) {
    const nu = el('input', { className: 'cat-ord', type: 'number', value: nextUp(subject) ?? '', title: 'Next episode the scheduler will play' });
    const setnu = el('button', { className: 'mini ghost', textContent: 'set next-up' });
    setnu.onclick = () => withBusy(null, async () => { await api.send('PUT', `/api/channels/${catChannelId}/series/${encodeURIComponent(subject)}/cursor`, { chapter: Number(nu.value) }); await loadCatalog(); toast('Next-up set', 'ok'); });
    crumb.append(el('span', { className: 'muted', textContent: 'next-up:' }), nu, setnu);
  }
}

function approvalBadge(approved, total) {
  const ok = total > 0 && approved === total;
  return el('span', {
    className: `badge ${ok ? 'badge-ok' : 'badge-warn'}`,
    textContent: ok ? '✓ approved' : `${approved}/${total} approved`,
    title: 'Approved clips are available to the scheduler',
  });
}

// ---- bulk-action bar (multi-edit on the left panel) ------------------------
function renderBulkBar() {
  const bar = $('#catBulkBar'); bar.innerHTML = '';
  if (engType == null) {
    bar.append(el('span', { className: 'muted', textContent: 'Open a show type to organize its shows, seasons and episodes. Only approved clips reach the scheduler.' }));
    return;
  }
  const mk = (label, cls, fn, title) => { const b = el('button', { className: `mini ${cls}`, textContent: label, title }); b.onclick = () => withBusy(null, fn); return b; };

  if (engSubject == null) {
    const nu = el('button', { className: 'mini primary', textContent: '＋ New series', title: 'Create a new (serial) series in this show type' });
    nu.onclick = () => newSeries();
    bar.append(nu);
  }

  const selN = catSel.size;
  const scope = selN ? `${selN} selected clip(s)` : 'everything here';
  bar.append(
    mk('✓ Approve', 'primary', () => setApproved(1), `Approve ${scope} — makes them available to the scheduler`),
    mk('✕ Unapprove', 'ghost', () => setApproved(0), `Remove approval from ${scope}`),
    mk('⤵ Merge into show…', 'ghost', mergeScope, `Move ${scope} into a show — optionally as one season of it (fixes a season detected as its own show)`),
    mk('🗓 Set season…', 'ghost', setSeasonScope, `Set the season folder for ${scope}`),
    mk('🔢 Fix order', 'ghost', fixOrder, 'Apply the play-order numbers you typed'),
    mk('1..N Renumber', 'ghost', renumberScope, 'Number the selected/shown clips 1..N'),
    mk('✏️ Rename…', 'ghost', renameScope, 'Set display names from a template'),
    mk('🔎 Replace…', 'ghost', replaceScope, 'Find & replace in display names'),
    mk('🎞 Mark filler', 'ghost', () => markFiller(1), `Mark ${scope} as fillers`),
    mk('📺 Unmark', 'ghost', () => markFiller(0), `Unmark fillers in ${scope}`),
    mk('🎬 Show type…', 'ghost', setShowType, `Set the show type for ${scope}`),
    mk('↺ Reset', 'danger', resetScope, `Restore detected values for ${scope}`),
  );
  if (selN) {
    const clear = el('button', { className: 'mini ghost', textContent: '✕ clear' });
    clear.onclick = () => { catSel.clear(); renderCatalog(); };
    bar.append(el('span', { className: 'muted', style: 'margin-left:auto', textContent: `${selN} selected` }), clear);
  }
}

// ---- browser (dispatch) ----------------------------------------------------
function renderBrowser() {
  const host = $('#catBrowser'); host.innerHTML = '';
  catOrderInputs = [];
  if (!catEpisodes.length && !catReg.size) {
    host.className = 'cat-browser';
    host.append(el('p', { className: 'muted', textContent: 'Nothing cataloged for this channel yet — scan a media root on the Media tab first.' }));
    return;
  }
  if (engType == null) {
    host.className = 'cat-browser';
    renderTypeList(host);
    return;
  }
  host.className = 'cat-browser cat-2pane';
  const left = el('div', { className: 'cat-pane cat-pane-series' });
  renderEnginePane(left);
  const right = el('div', { className: 'cat-pane cat-pane-lib' });
  renderLibraryPane(right);
  host.append(left, right);
}

function renderTypeList(host) {
  const q = catSearch.trim().toLowerCase();
  const types = typeFolders().filter((t) => !q || t.name.toLowerCase().includes(q));
  if (!types.length) { host.append(el('p', { className: 'muted', textContent: 'No show types match your search.' })); return; }
  const ul = el('ul', { className: 'cat-fs' });
  for (const t of types) {
    const li = el('li', { className: 'cat-dir' });
    const name = el('button', { className: 'cat-dir-name grow', textContent: `📁 ${t.name}` });
    name.onclick = () => goType(t.name);
    const { approved, total } = approvalOf(t.eps);
    li.append(name, el('span', { className: 'muted cat-nav-count', textContent: `${total} clip(s)` }), approvalBadge(approved, total));
    ul.append(li);
  }
  host.append(ul);
}

// ---- engine (left) pane ----------------------------------------------------
function enginePaneTitle() {
  if (engSubject == null) return `📁 ${engType}`;
  if (engSubject === UNSORTED) return '🗂 Unsorted';
  if (engSubject === FILLERS) return '🎞 Fillers';
  if (engSeason != null) return `${engSubject} · Season ${engSeason}`;
  return `🎬 ${engSubject}`;
}

function renderEnginePane(pane) {
  pane.append(el('div', { className: 'cat-pane-head', textContent: enginePaneTitle() }));
  const realShow = engSubject != null && engSubject !== UNSORTED && engSubject !== FILLERS;
  if (engSubject == null) renderShowList(pane);
  else if (!realShow) renderEpisodeList(pane, epsOfShow(engType, engSubject).slice().sort(bySeq), { reorder: false });
  else if (engSeason == null) renderShowRoot(pane);
  else renderEpisodeList(pane, epsOfShow(engType, engSubject).filter((e) => e.season === engSeason).sort(bySeq), { reorder: true });
  // Inside a real show, the pane itself accepts library drops. At the show root
  // we ask which season the clips belong to; when a specific season is already
  // open that season is the drop target, so no need to ask.
  if (realShow) wirePaneDrop(pane, () => {
    const ids = catDrag?.ids || [];
    // Always ask which season, defaulting to the one currently open. Dropping
    // onto a specific season used to silently dump everything into it; now the
    // operator can accept the default (add to this season) or type a different/
    // new number (split into a new season) — or blank to keep filename seasons.
    return promptSeasonAssign(ids, engSubject, { defaultSeason: engSeason });
  });
}

function folderCheckbox(eps) {
  const ids = eps.map((e) => e.id);
  const all = ids.length > 0 && ids.every((id) => catSel.has(id));
  const some = ids.some((id) => catSel.has(id));
  const cb = el('input', { type: 'checkbox', className: 'cat-sel', checked: all, title: 'Select every clip in this folder' });
  cb.indeterminate = some && !all;
  cb.onchange = () => { if (cb.checked) ids.forEach((id) => catSel.add(id)); else ids.forEach((id) => catSel.delete(id)); renderCatalog(); };
  return cb;
}

function renderShowList(pane) {
  const q = catSearch.trim().toLowerCase();
  let shows = showFolders(engType);
  if (q) shows = shows.filter((s) => (s.subject || s.label || '').toLowerCase().includes(q) || s.eps.some((e) => matchEp(e, q)));
  const ul = el('ul', { className: 'cat-fs' });
  if (!shows.length) ul.append(el('li', { className: 'muted cat-empty', textContent: q ? 'No shows match.' : 'No shows yet — drag folders from the library →' }));
  for (const s of shows) ul.append(showRow(s));
  pane.append(ul);
}

function showRow(s) {
  const li = el('li', { className: 'cat-dir cat-folder' });
  li.append(folderCheckbox(s.eps));
  const icon = s.key === UNSORTED ? '🗂' : s.key === FILLERS ? '🎞' : '🎬';
  const name = el('button', { className: 'cat-dir-name grow', textContent: `${icon} ${s.pseudo ? s.label : s.subject}` });
  name.onclick = () => goShow(s.key);
  li.append(name);
  const { approved, total } = approvalOf(s.eps);
  li.append(el('span', { className: 'muted cat-nav-count', textContent: `${total} ep` }), approvalBadge(approved, total));
  const reg = !s.pseudo && catReg.get(s.subject);
  if (reg && reg.is_serial) li.append(el('span', { className: 'badge', textContent: `next #${nextUp(s.subject) ?? '—'}`, title: 'Episode the scheduler plays next' }));
  if (!s.pseudo) wireFolderDrop(li, () => promptSeasonAssign(catDrag?.ids || [], s.subject));
  return li;
}

function renderShowRoot(pane) {
  const q = catSearch.trim().toLowerCase();
  const { seasonList, noSeason } = seasonFolders(engType, engSubject);
  const ul = el('ul', { className: 'cat-fs' });
  for (const s of seasonList) {
    if (q && !(`season ${s.season}`.includes(q) || s.eps.some((e) => matchEp(e, q)))) continue;
    ul.append(seasonRow(s));
  }
  // Explicit "new season" drop target: dropping a library folder/clip here files
  // it as a fresh season, so operators aren't forced into an existing one. (Drop
  // onto a season folder above = add to that season.)
  if (!q) ul.append(newSeasonRow(seasonList));
  pane.append(ul);
  const eps = q ? noSeason.filter((e) => matchEp(e, q)) : noSeason;
  if (eps.length) {
    if (seasonList.length) pane.append(el('div', { className: 'cat-subhead muted', textContent: 'No season' }));
    renderEpisodeList(pane, eps, { reorder: true });
  }
}

function newSeasonRow(seasonList) {
  const li = el('li', { className: 'cat-dir cat-folder cat-newseason' });
  const next = seasonList.reduce((m, s) => Math.max(m, s.season || 0), 0) + 1;
  li.append(el('span', { className: 'cat-dir-name grow muted', textContent: `📁＋ New season ${next} — drop clips here` }));
  wireFolderDrop(li, () => promptSeasonAssign(catDrag?.ids || [], engSubject, { defaultSeason: next }));
  return li;
}

function seasonRow(s) {
  const li = el('li', { className: 'cat-dir cat-folder' });
  li.append(folderCheckbox(s.eps));
  const name = el('button', { className: 'cat-dir-name grow', textContent: `📁 Season ${s.season}` });
  name.onclick = () => goSeason(s.season);
  const { approved, total } = approvalOf(s.eps);
  li.append(name, el('span', { className: 'muted cat-nav-count', textContent: `${total} ep` }), approvalBadge(approved, total));
  wireFolderDrop(li, () => assignToShow(catDrag?.ids || [], engSubject, s.season));
  return li;
}

function renderEpisodeList(pane, eps, { reorder }) {
  if (eps.length) {
    const ids = eps.map((e) => e.id);
    const selAll = el('label', { className: 'chk cat-selall' });
    const sab = el('input', { type: 'checkbox', checked: ids.every((id) => catSel.has(id)) });
    sab.onchange = () => { if (sab.checked) ids.forEach((id) => catSel.add(id)); else ids.forEach((id) => catSel.delete(id)); renderCatalog(); };
    selAll.append(sab, document.createTextNode(' select all'));
    pane.append(selAll);
  }
  const ol = el('ol', { className: 'items cat-eps cat-drop' });
  if (!eps.length) ol.append(el('li', { className: 'muted cat-empty', textContent: 'Empty.' }));
  for (const ep of eps) ol.append(episodeRow(ep, { reorder }));
  if (reorder) wireReorder(ol);
  pane.append(ol);
}

function episodeRow(ep, { reorder = false } = {}) {
  const li = el('li', { className: ep.is_filler ? 'filler' : '', draggable: reorder });
  li.dataset.id = ep.id;
  if (reorder) {
    li.addEventListener('dragstart', (e) => {
      const ol = li.closest('ol.cat-eps');
      // A drag grabbing one of several selected rows carries them all (in list
      // order); otherwise just the grabbed row.
      const ids = (catSel.has(ep.id) && catSel.size > 1 && ol)
        ? [...ol.querySelectorAll('li[data-id]')].map((x) => Number(x.dataset.id)).filter((id) => catSel.has(id))
        : [ep.id];
      catDrag = { kind: 'reorder', ids };
      e.dataTransfer.effectAllowed = 'move';
      if (ol) ids.forEach((id) => ol.querySelector(`li[data-id="${id}"]`)?.classList.add('dragging'));
    });
    li.addEventListener('dragend', () => {
      catDrag = null;
      li.closest('ol.cat-eps')?.querySelectorAll('li.dragging').forEach((x) => x.classList.remove('dragging'));
    });
    li.append(el('span', { className: 'cat-grip', textContent: '⠿', title: 'Drag to reorder' }));
  }
  const cb = el('input', { type: 'checkbox', className: 'cat-sel', checked: catSel.has(ep.id), title: 'Select — Shift-click to select a range' });
  cb.addEventListener('click', (e) => {
    const ol = cb.closest('ol.cat-eps');
    if (e.shiftKey && catAnchorId != null && ol) {
      const order = [...ol.querySelectorAll('li[data-id]')].map((x) => Number(x.dataset.id));
      const a = order.indexOf(catAnchorId), b = order.indexOf(ep.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) { if (cb.checked) catSel.add(order[i]); else catSel.delete(order[i]); }
      }
    } else if (cb.checked) catSel.add(ep.id); else catSel.delete(ep.id);
    catAnchorId = ep.id;
    renderCatalog();
  });
  li.append(cb);
  li.append(approveToggle(ep));
  // Position within the season (1, 2, 3…), never the internal chapter key.
  const ord = el('input', { className: 'cat-ord', type: 'number', value: ep.episode_no ?? '', title: 'Episode number within this season — retype the numbers, then “Fix order”' });
  catOrderInputs.push({ id: ep.id, input: ord });
  li.append(ord);
  if (ep.episode_code) {
    li.append(el('span', { className: 'badge ep-code', textContent: ep.episode_code, title: 'Season / episode — how this clip is named everywhere it airs' }));
  }
  const nameIn = el('input', { className: 'cat-name grow', value: ep.display_name, title: `File on disk: ${ep.raw_name}` });
  nameIn.onchange = () => withBusy(null, async () => { await api.send('PUT', `/api/catalog/resource/${ep.id}`, { display_name: nameIn.value }); ep.display_name = nameIn.value; toast('Name saved', 'ok'); });
  li.append(nameIn);
  if (ep.is_filler) li.append(el('span', { className: 'badge', textContent: 'filler' }));
  if (ep.has_override) li.append(el('span', { className: 'badge', textContent: 'edited', title: 'Has local overrides' }));
  li.append(el('span', { className: 'dur', textContent: fmt(ep.duration) }));
  const del = el('button', { className: 'mini danger', textContent: '🗑', title: 'Delete this clip from the catalog (for duplicates)' });
  del.onclick = () => deleteResource(ep);
  li.append(del);
  return li;
}

function approveToggle(ep) {
  const label = el('label', { className: 'chk cat-approve', title: 'Approve — makes this clip available to the scheduler' });
  const cb = el('input', { type: 'checkbox', checked: !!ep.approved });
  cb.onchange = () => withBusy(null, async () => {
    await api.send('POST', '/api/catalog/bulk', { ids: [ep.id], op: 'set-approved', approved: cb.checked ? 1 : 0 });
    ep.approved = cb.checked; renderCatalog();
    toast(cb.checked ? 'Approved' : 'Approval removed', 'ok');
  });
  label.append(cb, document.createTextNode(' approve'));
  return label;
}

// ---- library (right) pane — mirrors the on-disk folder tree ----------------
function libFolder(typeName, path) {
  const q = catSearch.trim().toLowerCase();
  const folders = new Map();
  const files = [];
  for (const e of epsOfType(typeName)) {
    const dirs = e.rel_dirs || [];
    if (dirs.length < path.length || !path.every((seg, i) => dirs[i] === seg)) continue;
    if (dirs.length > path.length) {
      const next = dirs[path.length];
      if (!folders.has(next)) folders.set(next, { name: next, eps: [] });
      folders.get(next).eps.push(e);
    } else {
      files.push(e);
    }
  }
  let folderArr = [...folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  let fileArr = files.slice().sort((a, b) => (a.display_name || '').localeCompare(b.display_name || ''));
  if (q) {
    folderArr = folderArr.filter((f) => f.name.toLowerCase().includes(q) || f.eps.some((e) => matchEp(e, q)));
    fileArr = fileArr.filter((e) => matchEp(e, q));
  }
  return { folders: folderArr, files: fileArr };
}

function renderLibraryPane(pane) {
  pane.append(el('div', { className: 'cat-pane-head', textContent: '🗄 Library — real folders on disk (drag into the show →)' }));

  const crumb = el('div', { className: 'cat-lib-crumb' });
  const root = el('button', { className: 'crumb-seg', textContent: `📁 ${engType}` });
  root.onclick = () => { libPath = []; renderCatalog(); };
  crumb.append(root);
  libPath.forEach((segName, i) => {
    crumb.append(el('span', { className: 'crumb-sep', textContent: '›' }));
    const b = el('button', { className: 'crumb-seg', textContent: segName });
    b.onclick = () => { libPath = libPath.slice(0, i + 1); renderCatalog(); };
    crumb.append(b);
  });
  pane.append(crumb);

  const { folders, files } = libFolder(engType, libPath);
  const ul = el('ul', { className: 'cat-fs cat-lib' });
  if (!folders.length && !files.length) ul.append(el('li', { className: 'muted', textContent: catSearch ? 'No matches.' : 'Empty folder.' }));
  for (const f of folders) ul.append(libFolderRow(f));
  for (const e of files) ul.append(libFileRow(e));
  wireUnsortDrop(ul); // drop an engine clip here to pull it out of its show
  pane.append(ul);
}

function libFolderRow(f) {
  const li = el('li', { className: 'cat-lib-row cat-lib-folder', draggable: true });
  const ids = f.eps.map((e) => e.id);
  li.addEventListener('dragstart', (e) => { catDrag = { kind: 'lib', ids }; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); });
  li.addEventListener('dragend', () => { catDrag = null; li.classList.remove('dragging'); });
  li.append(el('span', { className: 'cat-grip', textContent: '⠿', title: 'Drag this folder onto a show' }));
  const name = el('button', { className: 'grow cat-lib-name', textContent: `📁 ${f.name}` });
  name.onclick = () => { libPath = [...libPath, f.name]; renderCatalog(); };
  li.append(name);
  const { approved, total } = approvalOf(f.eps);
  li.append(el('span', { className: 'muted cat-nav-count', textContent: `${total}` }), approvalBadge(approved, total));
  return li;
}

function libFileRow(ep) {
  const li = el('li', { className: 'cat-lib-row', draggable: true });
  li.dataset.id = ep.id;
  li.addEventListener('dragstart', (e) => { catDrag = { kind: 'lib', ids: [ep.id] }; e.dataTransfer.effectAllowed = 'move'; li.classList.add('dragging'); });
  li.addEventListener('dragend', () => { catDrag = null; li.classList.remove('dragging'); });
  li.append(el('span', { className: 'cat-grip', textContent: '⠿' }));
  li.append(el('span', { className: `dot ${ep.approved ? 'dot-ok' : 'dot-warn'}`, title: ep.approved ? 'Approved' : 'Not approved' }));
  li.append(el('span', { className: 'grow cat-lib-name', textContent: ep.display_name, title: ep.raw_name }));
  li.append(el('span', { className: 'badge', textContent: ep.is_filler ? 'filler' : (ep.subject || 'unsorted'), title: 'Current show' }));
  li.append(el('span', { className: 'dur', textContent: fmt(ep.duration) }));
  return li;
}

// ---- drag & drop wiring ----------------------------------------------------
function wireFolderDrop(row, onDrop) {
  row.addEventListener('dragover', (e) => { if (catDrag?.kind !== 'lib') return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; row.classList.add('drop-hot'); });
  row.addEventListener('dragleave', () => row.classList.remove('drop-hot'));
  row.addEventListener('drop', (e) => { if (catDrag?.kind !== 'lib') return; e.preventDefault(); e.stopPropagation(); row.classList.remove('drop-hot'); onDrop(); });
}
function wirePaneDrop(pane, onDrop) {
  pane.addEventListener('dragover', (e) => { if (catDrag?.kind !== 'lib') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; pane.classList.add('drop-hot'); });
  pane.addEventListener('dragleave', (e) => { if (!pane.contains(e.relatedTarget)) pane.classList.remove('drop-hot'); });
  pane.addEventListener('drop', (e) => { if (catDrag?.kind !== 'lib') return; e.preventDefault(); pane.classList.remove('drop-hot'); onDrop(); });
}
function wireUnsortDrop(ul) {
  ul.addEventListener('dragover', (e) => { if (catDrag?.kind !== 'reorder') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; ul.classList.add('drop-cold'); });
  ul.addEventListener('dragleave', () => ul.classList.remove('drop-cold'));
  ul.addEventListener('drop', (e) => { if (catDrag?.kind !== 'reorder') return; e.preventDefault(); ul.classList.remove('drop-cold'); const ids = catDrag.ids; catDrag = null; moveToSubject(ids, null); });
}
function wireReorder(ol) {
  ol.addEventListener('dragover', (e) => { if (catDrag?.kind !== 'reorder') return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; ol.classList.add('drop-hot'); });
  ol.addEventListener('dragleave', () => ol.classList.remove('drop-hot'));
  ol.addEventListener('drop', (e) => { if (catDrag?.kind !== 'reorder') return; e.preventDefault(); ol.classList.remove('drop-hot'); catDrag = null; reorderFromDom(ol); });
}

// Live-insert the dragging <li> at the cursor position during a reorder.
document.addEventListener('dragover', (e) => {
  if (catDrag?.kind !== 'reorder') return;
  const ol = e.target.closest && e.target.closest('.cat-drop');
  if (!ol) return;
  const dragging = [...ol.querySelectorAll('li.dragging')];
  if (!dragging.length) return;
  e.preventDefault();
  const after = [...ol.querySelectorAll('li[data-id]:not(.dragging)')].find((li) => {
    const r = li.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  for (const d of dragging) { if (after) ol.insertBefore(d, after); else ol.append(d); }
});

// After a reorder drop, persist the DOM order as positions 1..N. The server
// re-deals the chapter values these clips already hold, so the reordered season
// keeps its place in the channel-wide chapter numbering.
async function reorderFromDom(ol) {
  const ids = [...ol.querySelectorAll('li[data-id]')].map((li) => Number(li.dataset.id));
  if (!ids.length) return;
  const entries = ids.map((id, i) => ({ id, position: i + 1 }));
  await withBusy(null, async () => {
    await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-positions', entries });
    await loadCatalog(); toast('Reordered', 'ok');
  });
}

// ---- organize actions ------------------------------------------------------
async function assignToShow(ids, subject, season) {
  catDrag = null;
  if (!ids || !ids.length || !subject) return;
  // season: undefined = re-derive from filenames; null = no season; a number =
  // force that season. It must go in the SAME assign-to-show call so the server
  // encodes it into `chapter` (a bare set-season would leave chapter colliding).
  const body = { ids, op: 'assign-to-show', subject };
  if (season !== undefined) body.season = season;
  await withBusy(null, async () => {
    await api.send('POST', '/api/catalog/bulk', body);
    await loadCatalog();
    const label = season != null && season !== '' ? ` · Season ${season}` : '';
    toast(`Moved ${ids.length} clip(s) into “${subject}”${label}`, 'ok');
  });
}

// Best-effort season number for clips about to join a show: an explicit season
// already parsed onto the clips, else a "Season N"/"S0N" segment in their
// on-disk folders, else the trailing number of a source subject like the
// mis-detected "Cosmos Season 3". '' when nothing hints at a season.
function detectSeasonHint(ids, sourceSubject = null) {
  const eps = catEpisodes.filter((e) => ids.includes(e.id));
  const seasons = new Set(eps.map((e) => e.season).filter((s) => s != null));
  if (seasons.size === 1) return String([...seasons][0]);
  const seasonRe = /(?:season|temporada|s)\s*0*(\d{1,3})/i;
  for (const e of eps) for (const seg of e.rel_dirs || []) {
    const m = seasonRe.exec(seg);
    if (m) return m[1];
  }
  if (sourceSubject) {
    const m = seasonRe.exec(sourceSubject) || /(\d{1,3})\s*$/.exec(sourceSubject);
    if (m) return m[1];
  }
  return '';
}

// Ask the operator whether these clips form a season of `subject`, then assign
// them. Blank answer = keep the seasons parsed from the filenames; a number =
// file them all under that season. Cancel aborts. Returns true if it ran.
async function promptSeasonAssign(ids, subject, opts = {}) {
  if (!ids || !ids.length || !subject) return false;
  const hint = opts.defaultSeason != null ? String(opts.defaultSeason) : detectSeasonHint(ids, opts.sourceSubject);
  const val = await inputDialog(
    'Which season?',
    `File these ${ids.length} clip(s) under “${subject}” as which season? Type a number — a new one starts a new season, an existing one adds to it — or leave blank to keep the seasons from their filenames.`,
    hint,
  );
  if (val == null) return false;
  const season = val.trim() === '' ? undefined : (Number(val) | 0);
  await assignToShow(ids, subject, season);
  return true;
}
async function moveToSubject(ids, subject) {
  if (!ids || !ids.length) return;
  await withBusy(null, async () => {
    await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-subject', subject: subject || null });
    await loadCatalog();
    toast(subject ? `Moved to “${subject}”` : 'Removed from show', 'ok');
  });
}

async function newSeries() {
  const existing = allShowSubjects();
  const name = await inputDialog('New series', 'Series name (a show folder to drag clips into)', '', existing);
  if (name == null || name.trim() === '') return;
  const subject = name.trim();
  if (catReg.has(subject) || catEpisodes.some((e) => e.subject === subject)) {
    await loadCatalog(); goShow(subject); return toast('Series already exists — opened it', 'ok');
  }
  await withBusy(null, async () => {
    await api.send('PUT', `/api/channels/${catChannelId}/series`, { series: [{ subject, is_serial: 1, is_active: 1, play_order: catReg.size, show_type_id: showTypeIdOfName(engType) }] });
    await loadCatalog();
    goShow(subject);
    toast(`Created series “${subject}” — drag clips into it`, 'ok');
  });
}

async function setSerial(subject, showTypeId, isSerial) {
  const reg = catReg.get(subject) || {};
  await api.send('PUT', `/api/channels/${catChannelId}/series`, { series: [{
    subject, is_serial: isSerial ? 1 : 0, is_active: reg.is_active === 0 ? 0 : 1,
    play_order: reg.play_order ?? 0, show_type_id: reg.show_type_id ?? showTypeId ?? null,
  }] });
  await loadCatalog();
  toast(isSerial ? `“${subject}” now plays in order` : `“${subject}” no longer serial`, 'ok');
}
async function setActive(subject, showTypeId, isActive) {
  const reg = catReg.get(subject) || {};
  await api.send('PUT', `/api/channels/${catChannelId}/series`, { series: [{
    subject, is_serial: reg.is_serial ? 1 : 0, is_active: isActive ? 1 : 0,
    play_order: reg.play_order ?? 0, show_type_id: reg.show_type_id ?? showTypeId ?? null,
  }] });
  await loadCatalog();
  toast(isActive ? 'Series activated' : 'Series deactivated', 'ok');
}
async function renameSeries(subject) {
  const next = await inputDialog('Rename series', 'New series name', subject);
  if (next == null || next === '' || next === subject) return;
  const ids = epsOfShow(engType, subject).map((e) => e.id);
  await withBusy(null, async () => {
    if (ids.length) await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-subject', subject: next });
    const reg = catReg.get(subject) || {};
    await api.send('PUT', `/api/channels/${catChannelId}/series`, { series: [{
      subject: next, is_serial: reg.is_serial ? 1 : 0, is_active: reg.is_active === 0 ? 0 : 1,
      play_order: reg.play_order ?? catReg.size, show_type_id: reg.show_type_id ?? showTypeIdOfName(engType),
    }] });
    await loadCatalog();
    // Drop the old registry row now that every clip has moved off it, else it
    // lingers as an empty series folder (the "renamed but old one stayed" bug).
    if (ids.length && !catEpisodes.some((e) => e.subject === subject)) {
      try { await api.send('DELETE', `/api/channels/${catChannelId}/series/${encodeURIComponent(subject)}`); }
      catch { /* leave as an empty folder if the server refuses */ }
      await loadCatalog();
    }
    goShow(next);
    toast('Series renamed', 'ok');
  });
}

async function deleteSeries(subject) {
  const nonFiller = epsOfShow(engType, subject).filter((e) => !e.is_filler);
  const extra = nonFiller.length
    ? ` Its ${nonFiller.length} clip(s) will be moved to Unsorted (files on disk are not touched).`
    : '';
  if (!await confirmDialog('Delete series', `Delete series “${subject}”?${extra}`, { confirmLabel: 'Delete', danger: true })) return;
  await withBusy(null, async () => {
    if (nonFiller.length)
      await api.send('POST', '/api/catalog/bulk', { ids: nonFiller.map((e) => e.id), op: 'set-subject', subject: null });
    await api.send('DELETE', `/api/channels/${catChannelId}/series/${encodeURIComponent(subject)}`);
    await loadCatalog();
    goType(engType);
    toast('Series deleted', 'ok');
  });
}

// ---- bulk actions (scope = selected clips, else everything at this level) ---
async function setApproved(approved) {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-approved', approved });
  await loadCatalog();
  toast(approved ? `Approved ${ids.length} clip(s)` : `Removed approval from ${ids.length} clip(s)`, 'ok');
}
// Move the scoped clips into a show, optionally filing them as one season of it.
// The headline use is fixing a season that was mis-detected as its own show:
// open that show, hit Merge, pick the real parent + the season number, and the
// now-empty source show's registry row is cleaned up automatically.
async function mergeScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing to move', 'bad');
  // A whole-show merge = we're inside a real show with nothing individually
  // selected; that source show is the one we may need to clean up afterwards.
  const wholeShow = !catSel.size && engSubject != null && engSubject !== UNSORTED && engSubject !== FILLERS;
  const sourceSubject = wholeShow ? engSubject : null;
  const existing = allShowSubjects(sourceSubject);
  const subject = await inputDialog('Merge into show', `Move ${ids.length} clip(s) into which show?`, '', existing);
  if (subject == null || subject.trim() === '') return;
  const target = subject.trim();

  const hint = detectSeasonHint(ids, sourceSubject);
  const val = await inputDialog(
    'As which season?',
    `File these clips as which season of “${target}”? — leave blank to keep the seasons from their filenames`,
    hint,
  );
  if (val == null) return;
  const season = val.trim() === '' ? undefined : (Number(val) | 0);

  await assignToShow(ids, target, season); // reloads catEpisodes
  if (sourceSubject && !catEpisodes.some((e) => e.subject === sourceSubject)) {
    // Emptied the source show — drop its lingering registry row so it stops
    // showing as an empty series folder.
    try { await api.send('DELETE', `/api/channels/${catChannelId}/series/${encodeURIComponent(sourceSubject)}`); } catch { /* stays as an empty folder if it refuses */ }
    await loadCatalog();
  }
  if (sourceSubject) goShow(target);
}
async function setSeasonScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing selected', 'bad');
  const val = await inputDialog('Set season', 'Season number (leave blank for no season)');
  if (val == null) return;
  const season = val.trim() === '' ? null : (Number(val) | 0);
  await api.send('POST', '/api/catalog/bulk', { ids, op: 'set-season', season });
  await loadCatalog();
  toast('Season set', 'ok');
}
async function fixOrder() {
  if (!catOrderInputs.length) return toast('No clips to order here', 'bad');
  const entries = catOrderInputs.map(({ id, input }, i) => ({ id, position: Number(input.value) || (i + 1) }));
  await api.send('POST', '/api/catalog/bulk', { ids: entries.map((e) => e.id), op: 'set-positions', entries });
  await loadCatalog();
  toast('Order fixed', 'ok');
}
async function renumberScope() {
  const ids = scopeIds();
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
  // If we were inside a show and its clips all moved to another type, the show
  // is gone from this type — step back to the show list so we're not stranded
  // on an empty view.
  const realShow = engSubject != null && engSubject !== UNSORTED && engSubject !== FILLERS;
  const reg = catReg.get(engSubject);
  const regType = reg ? catShowTypes.find((s) => s.id === reg.show_type_id)?.name : null;
  if (realShow && !epsOfShow(engType, engSubject).length && regType !== engType) goType(engType);
  toast('Show type updated', 'ok');
}
async function resetScope() {
  const ids = scopeIds();
  if (!ids.length) return toast('Nothing here', 'bad');
  if (!await confirmDialog('Reset', `Restore detected show/season/order and drop custom names for ${ids.length} clip(s)?`, { confirmLabel: 'Reset', danger: true })) return;
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

$('#catChannel').addEventListener('change', () => { engType = null; engSubject = null; engSeason = null; libPath = []; catSel.clear(); catSearch = ''; loadCatalog(); });
$('#btnCatReload').addEventListener('click', (e) => withBusy(e.currentTarget, loadCatalog));
$('#btnResetNextUps').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const ok = await confirmDialog('Reset all next-ups',
    'Set every series on this channel back to its first episode? The next schedule you generate will start each show from episode 1.',
    { confirmLabel: 'Reset to Ep 1' });
  if (!ok) return;
  const r = await api.send('POST', `/api/channels/${catChannelId}/series/reset-cursors`);
  await loadCatalog();
  toast(`Reset ${r.reset} series to their first episode`, 'ok', 'Next-ups reset');
}));
$('#catSearch').addEventListener('input', (e) => { catSearch = e.currentTarget.value; renderCatalog(); });

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
      const probe = (deep) => (e) => withBusy(e.currentTarget, async () => {
        const date = $('#pushDate').value || new Date().toISOString().slice(0, 10);
        const d = await api.get(`/api/otav/diagnose/${c.id}?date=${date}${deep ? '&probe_create=1' : ''}`);
        const open = (d.open_playlists || []).map((p) => `[${p.index}] ${p.name ?? '?'} (${p.total_items ?? '?'} items`
          + `${p.is_folder_based ? ', FOLDER-BASED — not editable' : ''})`);
        const sched = Array.isArray(d.scheduler_playlists)
          ? d.scheduler_playlists.map((p) => p.path)
          : [`unavailable — ${d.scheduler_playlists?.error || 'no data'}`];
        reportDialog(`OTAV probe — ${c.name}`, [
          { name: 'version', ok: !d.info?.error, detail: d.info?.application_version ? `OTAV ${d.info.application_version} on ${d.info.computer_name || d.info.name || '?'}` : d.info?.error },
          { name: 'scheduler', ok: !d.scheduler?.error, detail: d.scheduler?.error || `enabled: ${d.scheduler?.is_enabled} · ${d.scheduler?.schedule_path || 'no schedule path'}` },
          { name: 'playlist for this day', ok: true, detail: d.day_playlist_name },
          { name: 'open playlists', ok: open.length > 0, detail: open.join(', ') || 'none open' },
          { name: 'schedule folder', ok: Array.isArray(d.scheduler_playlists), detail: sched.join(', ') || 'empty' },
          { name: 'fallback ref', ok: d.fallback_playlist_ref != null, detail: d.fallback_playlist_ref ?? 'not set' },
          { name: 'schedule file (from here)', ok: !!(d.files?.schedule_exists && d.files?.schedule_writable),
            detail: d.files?.schedule_path
              ? `${d.files.schedule_path} — ${d.files.schedule_path_source}; ` +
                `${d.files.schedule_exists ? 'exists' : 'MISSING from this machine'}, ` +
                `${d.files.schedule_writable ? 'writable' : 'NOT writable'}` +
                (d.files.schedule_events != null ? `, ${d.files.schedule_events} event(s), ${d.files.schedule_our_events} ours` : '') +
                (d.files.schedule_error ? `, ${d.files.schedule_error}` : '')
              : 'no schedule to edit' },
          { name: 'playlists folder + template', ok: !!(d.files?.playlist_dir_writable && d.files?.template_exists),
            detail: d.files?.playlist_dir
              ? `${d.files.playlist_dir} — ${d.files.playlist_dir_source}; ` +
                `${d.files.playlist_dir_exists ? (d.files.playlist_dir_writable ? 'writable' : 'NOT writable') : 'will be created'} · ` +
                `template ${d.files.template_exists ? 'found' : (d.files.playlist_template ? `MISSING at ${d.files.playlist_template}` : 'NOT SET — save an empty playlist from OTAV and point here')}`
              : 'no schedule, so nothing to prepare' },
          ...(d.create_routes || []).map((r) => ({
            name: r.route, ok: r.ok, detail: r.ok ? r.response : `${r.status ?? ''} ${r.error}`,
          })),
          ...(d.edit_routes || []).map((r) => ({
            name: `editable? ${r.playlist} ${r.addressed}`, ok: r.ok,
            detail: r.ok ? 'accepts items' : `${r.status ?? ''} ${r.error}`,
          })),
        ]);
      });
      const probeBtn = el('button', { className: 'mini ghost', textContent: 'probe', title: 'Read-only: what this OTAV instance supports' });
      probeBtn.onclick = probe(false);
      const probeDeepBtn = el('button', { className: 'mini ghost', textContent: 'probe+', title: 'Also tries every playlist-creation route against this instance (writes)' });
      probeDeepBtn.onclick = probe(true);
      const td = el('td'); td.style.textAlign = 'right';
      td.append(editBtn, document.createTextNode(' '), seriesBtn, document.createTextNode(' '),
                probeBtn, document.createTextNode(' '), probeDeepBtn);
      ct.append(el('tr', {},
        el('td', { textContent: c.name }),
        el('td', { textContent: c.api_ip ? `${c.api_ip}:${c.api_port ?? ''}` : '—' }),
        el('td', { textContent: c.playlist_name_pattern || '{channel} {date}' }),
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
    li.append(el('span', { className: 'grow', textContent: r.label || r.name, title: r.name }));
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
let tplDirty = false;       // unsaved-changes guard for the close handlers

const markTplDirty = () => { tplDirty = true; };

// Minutes between two 'HH:MM' strings; null if either is unparseable.
function slotMinutes(s) {
  const p = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1] * 60 + +m[2]) : null; };
  const a = p(s.start_time), b = p(s.end_time);
  if (a == null || b == null) return null;
  return b - a;
}
// "2h 05m" from a minute count.
const fmtMinutes = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

// The channel whose series populate the picker (subjects are shared across
// channels that share folders, so the first checked channel is representative).
function tplPrimaryChannel() {
  const first = $$('#tplmChannels input:checked')[0];
  return first ? Number(first.value) : (setupChannels[0]?.id ?? '');
}

async function openTemplate(t) {
  tplEditing = t ? t.id : null;
  $('#tplmTitle').textContent = t ? `Edit template — ${t.name}` : 'New block template';
  $('#tplmValidation').className = 'validation';
  $('#tplmValidation').textContent = '';
  if (!setupChannels.length) setupChannels = await api.get('/api/channels');
  const selected = new Set(t ? (t.channels?.length ? t.channels : [t.channel_id]) : (setupChannels[0] ? [setupChannels[0].id] : []));
  const chBox = $('#tplmChannels'); chBox.innerHTML = '';
  for (const c of setupChannels) {
    const lbl = el('label', { className: 'chk' }, el('input', { type: 'checkbox', value: c.id, checked: selected.has(c.id) }), document.createTextNode(' ' + c.name));
    lbl.querySelector('input').onchange = () => { markTplDirty(); loadTplSeries(tplPrimaryChannel(), tplSeries.filter((s) => s.checked).map((s) => s.subject)); };
    chBox.append(lbl);
  }
  $('#tplmName').value = t ? t.name : '';
  $('#tplmName').oninput = markTplDirty;
  $('#tplmMaxPerShow').value = t && t.max_per_show ? t.max_per_show : '';
  $('#tplmMaxPerShow').oninput = markTplDirty;
  $('#btnDeleteTpl').style.display = t ? '' : 'none';

  const days = new Set((t?.weekdays || t?.weekday || '').split(',').map((x) => x.trim()).filter(Boolean));
  const wd = $('#tplmWeekdays'); wd.innerHTML = '';
  for (const d of WEEKDAYS) {
    const lbl = el('label', { className: 'chk' }, el('input', { type: 'checkbox', value: d, checked: days.has(d) }), document.createTextNode(' ' + d));
    lbl.querySelector('input').onchange = markTplDirty;
    wd.append(lbl);
  }

  tplSlots = t?.slots?.length ? t.slots.map((s) => ({ start_time: s.start_time, end_time: s.end_time })) : [{ start_time: '18:00', end_time: '20:00' }];
  renderTplSlots();

  const included = (t?.series || []).map((s) => s.subject);
  await loadTplSeries(tplPrimaryChannel(), included);

  tplDirty = false;   // opening a template is not itself a change
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
    const start = el('input', { type: 'time', value: s.start_time });
    const end = el('input', { type: 'time', value: s.end_time });
    const dur = el('span', { className: 'dur' });
    const paint = () => {
      const min = slotMinutes(s);
      if (min == null) { row.classList.remove('invalid'); dur.textContent = ''; }
      else if (min <= 0) { row.classList.add('invalid'); dur.textContent = 'fin debe ser mayor que inicio'; }
      else { row.classList.remove('invalid'); dur.textContent = fmtMinutes(min); }
    };
    start.onchange = () => { s.start_time = start.value; markTplDirty(); paint(); };
    end.onchange = () => { s.end_time = end.value; markTplDirty(); paint(); };
    row.append(start, document.createTextNode(' – '), end, dur);
    if (tplSlots.length > 1) {
      const rm = el('button', { className: 'mini danger', type: 'button', textContent: '✕' });
      rm.onclick = () => { tplSlots.splice(idx, 1); markTplDirty(); renderTplSlots(); };
      row.append(rm);
    }
    paint();
    box.append(row);
  });
}
$('#btnAddSlot').addEventListener('click', () => { tplSlots.push({ start_time: '20:00', end_time: '22:00' }); markTplDirty(); renderTplSlots(); });

function renderTplSeries() {
  const list = $('#tplmSeries'); list.innerHTML = '';
  if (!tplSeries.length) {
    const li = el('li', { className: 'muted' });
    li.append(el('div', { textContent: 'No hay series activas en este canal.' }));
    const actions = el('div', { className: 'series-empty-actions' });
    const detect = el('button', { className: 'mini primary', type: 'button', textContent: 'Detectar del catálogo' });
    detect.onclick = (e) => withBusy(e.currentTarget, async () => {
      const ch = tplPrimaryChannel();
      if (!ch) return toast('Selecciona un canal primero', 'bad', 'Series');
      const included = tplSeries.filter((s) => s.checked).map((s) => s.subject);
      const r = await api.send('POST', `/api/channels/${ch}/series/detect`);
      toast(`Detected ${r.added} new series`, 'ok');
      await loadTplSeries(ch, included);
    });
    const manage = el('button', { className: 'mini ghost', type: 'button', textContent: 'Abrir gestor de series' });
    manage.onclick = async () => {
      const ch = setupChannels.find((c) => c.id === tplPrimaryChannel());
      if (!ch) return;
      if (tplDirty && !await confirmDialog('Descartar cambios', 'Tienes cambios sin guardar en esta plantilla. ¿Salir al gestor de series?', { confirmLabel: 'Salir', danger: true })) return;
      $('#templateModal').classList.add('hidden');
      openSeries(ch);
    };
    actions.append(detect, manage);
    li.append(actions);
    list.append(li);
    return;
  }
  tplSeries.forEach((s, idx) => {
    const li = el('li', { draggable: true });
    li.append(el('span', { className: 'drag', textContent: '⠿' }));
    const cb = el('input', { type: 'checkbox', checked: s.checked });
    cb.onchange = () => { s.checked = cb.checked; markTplDirty(); };
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
      markTplDirty();
      renderTplSeries();
    });
    list.append(li);
  });
}

function showTplErrors(problems) {
  const box = $('#tplmValidation');
  box.className = problems.length ? 'validation bad' : 'validation';
  box.textContent = problems.length ? problems.join(' · ') : '';
}

$('#btnSaveTpl').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const weekdays = $$('#tplmWeekdays input:checked').map((i) => i.value);
  const name = $('#tplmName').value.trim();
  const channels = $$('#tplmChannels input:checked').map((i) => Number(i.value));
  const validSlots = tplSlots.filter((s) => s.start_time && s.end_time);
  const series = tplSeries.filter((s) => s.checked).map((s) => s.subject);

  // Build concrete, per-issue messages instead of one generic toast.
  const problems = [];
  if (!name) problems.push('falta el nombre');
  if (!channels.length) problems.push('elige al menos un canal');
  if (!weekdays.length) problems.push('elige al menos un día');
  if (!validSlots.length) problems.push('define al menos un airing');
  if (validSlots.some((s) => slotMinutes(s) != null && slotMinutes(s) <= 0)) problems.push('un airing tiene fin ≤ inicio');
  // Overlap check within this template (by minute range).
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? +m[1] * 60 + +m[2] : null; };
  const ranges = validSlots
    .map((s) => ({ a: toMin(s.start_time), b: toMin(s.end_time) }))
    .filter((r) => r.a != null && r.b != null && r.b > r.a)
    .sort((x, y) => x.a - y.a);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].a < ranges[i - 1].b) { problems.push('hay airings que se solapan'); break; }

  showTplErrors(problems);
  if (problems.length) return;

  const maxPerShow = Number($('#tplmMaxPerShow').value) > 0 ? Number($('#tplmMaxPerShow').value) : 0;
  const body = { channels, channel_id: channels[0], name, weekdays, slots: validSlots, series, max_per_show: maxPerShow };
  if (tplEditing) await api.send('PUT', `/api/blocks/templates/${tplEditing}`, body);
  else await api.send('POST', '/api/blocks/templates', body);
  tplDirty = false;
  $('#templateModal').classList.add('hidden');
  toast('Template saved', 'ok');
  await loadSetupTab();
}));
$('#btnDeleteTpl').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  if (!tplEditing) return;
  if (!await confirmDialog('Delete template', 'Delete this template?', { confirmLabel: 'Delete', danger: true })) return;
  await api.send('DELETE', `/api/blocks/templates/${tplEditing}`);
  tplDirty = false;
  $('#templateModal').classList.add('hidden');
  toast('Template deleted', 'ok');
  await loadSetupTab();
}));
// Close the template modal, confirming first if there are unsaved edits.
async function closeTemplateModal() {
  if (tplDirty && !await confirmDialog('Descartar cambios', 'Tienes cambios sin guardar. ¿Cerrar de todos modos?', { confirmLabel: 'Descartar', danger: true })) return;
  tplDirty = false;
  $('#templateModal').classList.add('hidden');
}
$('#btnNewTemplate').addEventListener('click', () => openTemplate(null));
$('#tplmClose').addEventListener('click', closeTemplateModal);
$('#templateModal').addEventListener('click', (e) => { if (e.target.id === 'templateModal') closeTemplateModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#templateModal').classList.contains('hidden')) closeTemplateModal();
});

// ---- Channel editor modal --------------------------------------------------
let chEditing = null;
function openChannelEditor(c) {
  chEditing = c.id;
  $('#chmTitle').textContent = `Edit channel — ${c.name}`;
  $('#chmName').value = c.name ?? '';
  $('#chmIp').value = c.api_ip ?? '';
  $('#chmPort').value = c.api_port ?? '';
  $('#chmPlaylistName').value = c.playlist_name_pattern ?? '';
  $('#chmPlaylist').value = c.playlist_ref ?? '';
  $('#chmSchedulePath').value = c.schedule_path ?? '';
  $('#chmPlaylistDir').value = c.playlist_dir ?? '';
  $('#chmPlaylistTemplate').value = c.playlist_template ?? '';
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
    playlist_name_pattern: $('#chmPlaylistName').value.trim() || null,
    playlist_ref: $('#chmPlaylist').value.trim() || null,
    schedule_path: $('#chmSchedulePath').value.trim() || null,
    playlist_dir: $('#chmPlaylistDir').value.trim() || null,
    playlist_template: $('#chmPlaylistTemplate').value.trim() || null,
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
