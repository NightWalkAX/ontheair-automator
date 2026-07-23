// Admin review UI logic. Vanilla ES modules, no framework/bundler.

const api = {
  async get(url) { const r = await fetch(url); return r.json(); },
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

async function loadSchedule() {
  const week = $('#weekStart').value || isoToday();
  const { week: dates, blocks } = await api.get(`/api/blocks?week=${week}`);
  const grid = $('#scheduleGrid');
  grid.innerHTML = '';
  const byDate = Object.fromEntries(dates.map((d) => [d, []]));
  for (const b of blocks) (byDate[b.target_date] ||= []).push(b);

  for (const d of dates) {
    const col = el('div', { className: 'day-col' });
    const dow = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' });
    col.append(el('div', { className: 'day-head', textContent: `${dow} ${d.slice(5)}` }));
    for (const b of byDate[d] || []) {
      const card = el('div', { className: `block-card ${b.fits ? 'fits' : 'misfit'} ${b.status}` });
      card.append(el('div', { className: 'b-title', textContent: `${b.channel_name}: ${b.template_name}` }));
      card.append(el('div', { className: 'b-meta', textContent: `${b.start_time}–${b.end_time} · ${b.content_type}` }));
      const badges = el('div');
      badges.append(el('span', { className: `badge ${b.fits ? 'ok' : 'bad'}`, textContent: b.fits ? 'fits' : `off ${fmt(b.diff)}` }));
      badges.append(document.createTextNode(' '));
      badges.append(el('span', { className: 'badge status', textContent: b.status }));
      card.append(badges);
      card.addEventListener('click', () => openBlock(b.id));
      col.append(card);
    }
    grid.append(col);
  }
}

$('#btnReload').addEventListener('click', loadSchedule);
$('#btnGenerate').addEventListener('click', async () => {
  await api.send('POST', `/api/blocks/generate?weekStart=${$('#weekStart').value}`);
  loadSchedule();
});
$('#btnApproveWeek').addEventListener('click', async () => {
  const r = await api.send('POST', `/api/blocks/approve-week?week=${$('#weekStart').value}`);
  alert(`Approved ${r.approved.length}; blocked ${r.blocked.length}`);
  loadSchedule();
});
$('#btnPush').addEventListener('click', async () => {
  if (!confirm('Push approved blocks to the OTAV instances?')) return;
  try {
    const r = await api.send('POST', `/api/otav/push?date=${$('#pushDate').value}`);
    alert('Push report:\n' + r.channels.map((c) => `${c.channel}: ${c.ok ? c.pushed + ' clips' : 'ERROR ' + c.error}`).join('\n'));
    loadSchedule();
  } catch (e) { alert('Push failed: ' + e.message); }
});

// ---- Block editor modal ----------------------------------------------------
let currentBlock = null;
let currentItems = [];      // [{resource_id, name, duration, is_filler, is_manual_override}]
let allResources = [];

async function openBlock(id) {
  const v = await api.get(`/api/blocks/${id}`);
  currentBlock = v;
  currentItems = v.items.map((i) => ({ ...i }));
  allResources = await api.get(`/api/resources?channel_id=${v.block.channel_id}`);

  $('#modalTitle').textContent = `${v.block.template_name} — ${v.block.target_date}`;
  $('#modalMeta').textContent = `${v.block.start_time}–${v.block.end_time} · block ${fmt(v.blockSeconds)} · channel ${v.block.channel_id}`;

  const sel = $('#addResourceSel');
  sel.innerHTML = '';
  for (const r of allResources) {
    sel.append(el('option', { value: r.id, textContent: `${r.is_filler ? '[filler] ' : ''}${r.name} (${fmt(r.duration)})` }));
  }
  renderItems();
  $('#modal').classList.remove('hidden');
}

function renderItems() {
  const list = $('#itemList');
  list.innerHTML = '';
  currentItems.forEach((it, idx) => {
    const li = el('li', { className: it.is_filler ? 'filler' : '' });
    li.append(el('span', { className: 'grow', textContent: `${it.name} · ${fmt(it.duration)}${it.is_manual_override ? ' *' : ''}` }));
    const up = el('button', { className: 'mini', textContent: '↑' });
    const down = el('button', { className: 'mini', textContent: '↓' });
    const del = el('button', { className: 'mini danger', textContent: '✕' });
    up.onclick = () => { if (idx > 0) { [currentItems[idx-1], currentItems[idx]] = [currentItems[idx], currentItems[idx-1]]; renderItems(); } };
    down.onclick = () => { if (idx < currentItems.length-1) { [currentItems[idx+1], currentItems[idx]] = [currentItems[idx], currentItems[idx+1]]; renderItems(); } };
    del.onclick = () => { currentItems.splice(idx, 1); renderItems(); };
    li.append(up, down, del);
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
$('#btnSaveItems').addEventListener('click', async () => {
  const items = currentItems.map((i) => ({ resource_id: i.resource_id, is_manual_override: i.is_manual_override ? 1 : 0 }));
  const v = await api.send('PUT', `/api/blocks/${currentBlock.block.id}/items`, { items });
  currentBlock = v; currentItems = v.items.map((i) => ({ ...i })); renderItems();
});
$('#btnApproveBlock').addEventListener('click', async () => {
  try {
    // Persist current edits first, then approve.
    const items = currentItems.map((i) => ({ resource_id: i.resource_id, is_manual_override: i.is_manual_override ? 1 : 0 }));
    await api.send('PUT', `/api/blocks/${currentBlock.block.id}/items`, { items });
    await api.send('POST', `/api/blocks/${currentBlock.block.id}/approve`);
    $('#modal').classList.add('hidden');
    loadSchedule();
  } catch (e) { alert('Approve blocked: ' + e.message); }
});
$('#modalClose').addEventListener('click', () => $('#modal').classList.add('hidden'));

// ---- Media & Roots ---------------------------------------------------------
let browsePath = null;
let selectedFolder = null;

async function loadMediaTab() {
  const st = await api.get('/api/media/status');
  $('#mountStatus').textContent = st.mounted ? `mounted at ${st.mountPoint}` : `not mounted (${st.mountPoint})`;
  await populateSelect('#assignChannel', '/api/channels', 'name');
  await populateSelect('#assignShowType', '/api/showtypes', 'name');
  await browse(st.mountPoint);
  await loadRoots();
}

async function browse(path) {
  try {
    const data = await api.get(`/api/media/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`);
    browsePath = data.path;
    $('#browserPath').textContent = `${data.path}  (${data.fileCount} files here)`;
    const ul = $('#browser');
    ul.innerHTML = '';
    const parent = data.path.replace(/\/[^/]+$/, '');
    if (parent && parent !== data.path) {
      const up = el('li', { className: 'up', textContent: '⬆ ..' });
      up.onclick = () => browse(parent);
      ul.append(up);
    }
    for (const f of data.folders) {
      const li = el('li', { textContent: '📁 ' + f.name });
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

$('#btnMount').addEventListener('click', async () => {
  try { const r = await api.send('POST', '/api/media/mount'); alert(r.alreadyMounted ? 'Already mounted' : 'Mounted'); loadMediaTab(); }
  catch (e) { alert('Mount failed: ' + e.message); }
});
$('#btnScanAll').addEventListener('click', async () => {
  const r = await api.send('POST', '/api/media/scan');
  const total = r.results.reduce((s, x) => s + x.ingested, 0);
  alert(`Ingested ${total} resources across ${r.results.length} roots`);
});
$('#btnAssignRoot').addEventListener('click', async () => {
  const folder = selectedFolder || browsePath;
  if (!folder) return alert('Select a folder first');
  try {
    await api.send('POST', '/api/media/roots', {
      channel_id: Number($('#assignChannel').value),
      show_type_id: Number($('#assignShowType').value),
      path: folder,
    });
    loadRoots();
  } catch (e) { alert('Assign failed: ' + e.message); }
});

async function loadRoots() {
  const rows = await api.get('/api/media/roots');
  const tb = $('#rootsTable tbody');
  tb.innerHTML = '';
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', { textContent: r.channel_name }), el('td', { textContent: r.show_type_name }), el('td', { textContent: r.path }));
    const btnScan = el('button', { className: 'mini', textContent: 'scan' });
    btnScan.onclick = async () => { const x = await api.send('POST', `/api/media/roots/${r.id}/scan`); alert(`Ingested ${x.ingested} of ${x.scanned}`); };
    const btnDel = el('button', { className: 'mini danger', textContent: 'delete' });
    btnDel.onclick = async () => { await api.send('DELETE', `/api/media/roots/${r.id}`); loadRoots(); };
    const td = el('td'); td.append(btnScan, document.createTextNode(' '), btnDel); tr.append(td);
    tb.append(tr);
  }
}

// ---- Channels & Templates --------------------------------------------------
async function populateSelect(sel, url, labelKey) {
  const rows = await api.get(url);
  const s = $(sel); s.innerHTML = '';
  for (const r of rows) s.append(el('option', { value: r.id, textContent: r[labelKey] }));
  return rows;
}

async function loadSetupTab() {
  const channels = await api.get('/api/channels');
  const ct = $('#channelsTable tbody'); ct.innerHTML = '';
  for (const c of channels) {
    ct.append(el('tr', {},
      el('td', { textContent: c.name }),
      el('td', { textContent: c.api_ip ? `${c.api_ip}:${c.api_port ?? ''}` : '—' }),
      el('td', { textContent: c.playlist_ref ?? '0' }),
      el('td', { textContent: c.is_active ? 'yes' : 'no' })));
  }
  const showTypes = await api.get('/api/showtypes');
  const stb = $('#showTypesTable tbody'); stb.innerHTML = '';
  for (const s of showTypes) stb.append(el('tr', {}, el('td', { textContent: s.name }), el('td', { textContent: s.is_educational ? 'yes' : 'no' })));

  await populateSelect('#tplChannel', '/api/channels', 'name');
  const tpls = await api.get('/api/blocks/templates');
  const chName = Object.fromEntries(channels.map((c) => [c.id, c.name]));
  const tt = $('#templatesTable tbody'); tt.innerHTML = '';
  for (const t of tpls) {
    tt.append(el('tr', {},
      el('td', { textContent: chName[t.channel_id] || t.channel_id }),
      el('td', { textContent: t.name }),
      el('td', { textContent: t.weekday }),
      el('td', { textContent: `${t.start_time}–${t.end_time}` }),
      el('td', { textContent: t.content_type })));
  }
}

function formToObj(form) {
  const o = {};
  for (const elm of form.elements) {
    if (!elm.name) continue;
    o[elm.name] = elm.type === 'checkbox' ? (elm.checked ? 1 : 0) : elm.value;
  }
  return o;
}
$('#channelForm').addEventListener('submit', async (e) => { e.preventDefault(); await api.send('POST', '/api/channels', formToObj(e.target)); e.target.reset(); loadSetupTab(); });
$('#showTypeForm').addEventListener('submit', async (e) => { e.preventDefault(); await api.send('POST', '/api/showtypes', formToObj(e.target)); e.target.reset(); loadSetupTab(); });
$('#templateForm').addEventListener('submit', async (e) => { e.preventDefault(); await api.send('POST', '/api/blocks/templates', formToObj(e.target)); e.target.reset(); loadSetupTab(); });

// ---- Boot ------------------------------------------------------------------
loadSchedule();
