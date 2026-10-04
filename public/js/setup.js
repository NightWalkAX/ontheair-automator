import { $, $$, api, confirmDialog, el, fmt, reportDialog, toast, withBusy, closeDialog, invalidateChannels, invalidateResources } from './core.js';

// ---- Channels & Templates --------------------------------------------------
export async function populateSelect(sel, url, labelKey) {
  const rows = await api.get(url);
  const s = $(sel); s.innerHTML = '';
  for (const r of rows) s.append(el('option', { value: r.id, textContent: r[labelKey] }));
  return rows;
}

let setupChannels = [];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export async function loadSetupTab() {
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

    setupTemplates = await api.get('/api/blocks/templates');
    setupChannelNames = chName;
    renderTemplatesTable();
  } catch (e) { toast(e.message, 'bad', 'Setup'); }
}

// ---- Block template table --------------------------------------------------
// Held in module state and re-rendered from there, so the search box filters
// without another round trip.
let setupTemplates = [];
let setupChannelNames = {};
let tplTableSearch = '';
let tplTableChannel = '';

/** One template as the flat text the search box matches against. */
function templateHaystack(t) {
  const airings = (t.slots || []).map((s) => `${s.start_time}–${s.end_time}`).join(' ') || `${t.start_time}–${t.end_time}`;
  const series = (t.series || []).map((s) => s.subject).join(' ') || (t.target_subject || '');
  return [
    setupChannelNames[t.channel_id] || t.channel_id,
    t.name, (t.weekdays || t.weekday || '').replaceAll(',', ' '), airings, series,
  ].join(' ').toLowerCase();
}

function renderTemplatesTable() {
  const chName = setupChannelNames;
  const chSel = $('#tplTableChannel');
  if (chSel) {
    const ids = [...new Set(setupTemplates.map((t) => t.channel_id))];
    chSel.innerHTML = '';
    chSel.append(el('option', { value: '', textContent: 'All channels' }));
    for (const id of ids) {
      chSel.append(el('option', {
        value: String(id), textContent: chName[id] || id, selected: String(id) === tplTableChannel,
      }));
    }
  }
  const q = tplTableSearch.trim().toLowerCase();
  const tpls = setupTemplates
    .filter((t) => !tplTableChannel || String(t.channel_id) === tplTableChannel)
    .filter((t) => !q || templateHaystack(t).includes(q));
  const count = $('#tplTableCount');
  if (count) {
    count.textContent = tpls.length === setupTemplates.length
      ? `${tpls.length} template(s)`
      : `${tpls.length} of ${setupTemplates.length}`;
  }

  const tt = $('#templatesTable tbody'); tt.innerHTML = '';
  if (!setupTemplates.length) tt.append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', style: 'text-align:center;padding:18px', textContent: 'No block templates yet — click “New template”.' })));
  else if (!tpls.length) tt.append(el('tr', {}, el('td', { colSpan: 6, className: 'muted', style: 'text-align:center;padding:18px', textContent: 'Nothing matches this filter.' })));
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
}

$('#tplTableSearch').addEventListener('input', (e) => { tplTableSearch = e.currentTarget.value; renderTemplatesTable(); });
$('#tplTableChannel').addEventListener('change', (e) => { tplTableChannel = e.currentTarget.value; renderTemplatesTable(); });

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
let tplSeries = [];         // [{subject, meta}] every active series on the channel
let tplChosen = [];         // [subject] the ones this template cycles, in play order
let tplSeriesSearch = '';
let tplSeriesTypeFilter = ''; // show_type_name to restrict the Available pane to, '' = all
let tplDrag = null;         // subject being dragged between the two panes
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
    lbl.querySelector('input').onchange = () => { markTplDirty(); loadTplSeries(tplPrimaryChannel(), tplChosen.slice()); };
    chBox.append(lbl);
  }
  $('#tplmName').value = t ? t.name : '';
  $('#tplmName').oninput = markTplDirty;
  $('#tplmMaxPerShow').value = t && t.max_per_show ? t.max_per_show : '';
  $('#tplmMaxPerShow').oninput = markTplDirty;
  $('#tplmIsMovieBlock').checked = !!(t && t.is_movie_block);
  $('#tplmIsMovieBlock').onchange = markTplDirty;
  $('#tplmMovieLimit').value = t && t.movie_limit ? t.movie_limit : '';
  $('#tplmMovieLimit').oninput = markTplDirty;
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
  tplSeriesSearch = ''; $('#tplSeriesSearch').value = '';
  tplSeriesTypeFilter = ''; $('#tplSeriesTypeFilter').value = '';
  tplDrag = null;
  await loadTplSeries(tplPrimaryChannel(), included);

  tplDirty = false;   // opening a template is not itself a change
  $('#templateModal').classList.remove('hidden');
}

async function loadTplSeries(channelId, included = []) {
  let rows = [];
  try { rows = await api.get(`/api/channels/${channelId}/series`); } catch { /* none */ }
  // A series with no clips cannot contribute anything to a block, and there are
  // thousands of them on the channels that were once scanned against the whole
  // production share — one registry row per folder walked. Keep one that a
  // template already names (the operator is mid-way through a setup), hide the
  // rest so the picker lists what can actually air.
  const active = rows.filter((r) => r.is_active)
    .filter((r) => r.chapter_count > 0 || included.includes(r.subject));
  tplSeries = active.map((r) => ({ subject: r.subject, meta: r }));
  // Keep the saved play order, dropping shows that are no longer active.
  const known = new Set(active.map((r) => r.subject));
  tplChosen = included.filter((s) => known.has(s));
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
      else if (min <= 0) { row.classList.add('invalid'); dur.textContent = 'end must be after start'; }
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

// The series picker is two panes: every active series on the left, the ones
// this template cycles (in play order) on the right. Membership is which pane a
// show sits in; order is its position on the right — no checkbox/order overload.
const tplMeta = (subject) => tplSeries.find((s) => s.subject === subject)?.meta || {};

function tplSeriesRow(subject, { chosen }) {
  const meta = tplMeta(subject);
  const li = el('li', { draggable: true });
  li.dataset.subject = subject;
  li.append(el('span', { className: 'drag', textContent: '⠿', title: chosen ? 'Drag to reorder' : 'Drag into the block' }));
  if (chosen) li.append(el('span', { className: 'idx', textContent: String(tplChosen.indexOf(subject) + 1) }));
  li.append(el('span', { className: 'grow', textContent: `${subject}  `, title: subject },
    el('small', { className: 'muted', textContent: `${meta.show_type_name || '—'}${meta.is_serial ? ' · serial' : ''}` })));
  const btn = el('button', {
    className: chosen ? 'mini danger' : 'mini ghost', type: 'button',
    textContent: chosen ? '✕' : '→',
    title: chosen ? 'Remove from this block' : 'Add to this block',
  });
  btn.onclick = () => {
    if (chosen) tplChosen = tplChosen.filter((x) => x !== subject);
    else if (!tplChosen.includes(subject)) tplChosen.push(subject);
    markTplDirty();
    renderTplSeries();
  };
  li.append(btn);
  li.addEventListener('dragstart', () => { tplDrag = subject; li.classList.add('dragging'); });
  li.addEventListener('dragend', () => { tplDrag = null; li.classList.remove('dragging'); $$('#tplSeriesPanes li').forEach((x) => x.classList.remove('drag-over')); });
  return li;
}

// Rebuild the show-type filter's options from whatever series are on this
// channel, keeping the current selection if it still exists.
function renderTplTypeFilter() {
  const sel = $('#tplSeriesTypeFilter');
  const types = [...new Set(tplSeries.map((s) => s.meta.show_type_name).filter(Boolean))].sort();
  if (tplSeriesTypeFilter && !types.includes(tplSeriesTypeFilter)) tplSeriesTypeFilter = '';
  sel.innerHTML = '';
  sel.append(el('option', { value: '', textContent: 'All show types' }));
  for (const t of types) sel.append(el('option', { value: t, textContent: t, selected: t === tplSeriesTypeFilter }));
}

function renderTplSeries() {
  const avail = $('#tplmAvail'), chosenList = $('#tplmChosen');
  avail.innerHTML = ''; chosenList.innerHTML = '';
  renderTplTypeFilter();

  // Left pane: everything not already in the block, filtered by the search box
  // and (optionally) by show type.
  const q = tplSeriesSearch.trim().toLowerCase();
  const available = tplSeries
    .map((s) => s.subject)
    .filter((s) => !tplChosen.includes(s))
    .filter((s) => !q || s.toLowerCase().includes(q))
    .filter((s) => !tplSeriesTypeFilter || tplMeta(s).show_type_name === tplSeriesTypeFilter);

  $('#tplAvailCount').textContent = `${available.length}`;
  $('#tplChosenCount').textContent = `${tplChosen.length}`;

  if (!tplSeries.length) {
    const li = el('li', { className: 'muted' });
    li.append(el('div', { textContent: 'No active series on this channel yet.' }));
    const actions = el('div', { className: 'series-empty-actions' });
    const detect = el('button', { className: 'mini primary', type: 'button', textContent: 'Detect from catalog' });
    detect.onclick = (e) => withBusy(e.currentTarget, async () => {
      const ch = tplPrimaryChannel();
      if (!ch) return toast('Pick a channel first', 'bad', 'Series');
      const r = await api.send('POST', `/api/channels/${ch}/series/detect`);
      toast(`Detected ${r.added} new series`, 'ok');
      await loadTplSeries(ch, tplChosen.slice());
    });
    const manage = el('button', { className: 'mini ghost', type: 'button', textContent: 'Open series manager' });
    manage.onclick = async () => {
      const ch = setupChannels.find((c) => c.id === tplPrimaryChannel());
      if (!ch) return;
      if (tplDirty && !await confirmDialog('Discard changes', 'This template has unsaved changes. Leave for the series manager?', { confirmLabel: 'Leave', danger: true })) return;
      $('#templateModal').classList.add('hidden');
      openSeries(ch);
    };
    actions.append(detect, manage);
    li.append(actions);
    avail.append(li);
  } else if (!available.length) {
    avail.append(el('li', { className: 'muted', textContent: q ? 'No series match that search.' : 'Every series is already in this block.' }));
  } else {
    for (const s of available) avail.append(tplSeriesRow(s, { chosen: false }));
  }

  if (!tplChosen.length) {
    chosenList.append(el('li', { className: 'muted dp-empty', textContent: 'Drag shows here — they play in this order.' }));
  } else {
    for (const s of tplChosen) chosenList.append(tplSeriesRow(s, { chosen: true }));
  }
}

// Drop onto a row: reorder within the block, or insert an incoming show there.
function tplWireRowDrops(root, { chosen }) {
  root.addEventListener('dragover', (e) => {
    if (!tplDrag) return;
    e.preventDefault();
    const li = e.target.closest('li[data-subject]');
    if (li) li.classList.add('drag-over');
  });
  root.addEventListener('dragleave', (e) => {
    const li = e.target.closest?.('li[data-subject]');
    if (li) li.classList.remove('drag-over');
  });
  root.addEventListener('drop', (e) => {
    if (!tplDrag) return;
    e.preventDefault();
    const subject = tplDrag;
    tplDrag = null;
    if (!chosen) {                       // dropped back on the left = remove
      tplChosen = tplChosen.filter((x) => x !== subject);
    } else {
      const li = e.target.closest('li[data-subject]');
      const at = li ? tplChosen.indexOf(li.dataset.subject) : -1;
      tplChosen = tplChosen.filter((x) => x !== subject);
      if (at === -1) tplChosen.push(subject);
      else tplChosen.splice(at, 0, subject);
    }
    markTplDirty();
    renderTplSeries();
  });
}
tplWireRowDrops($('#tplmChosen'), { chosen: true });
tplWireRowDrops($('#tplmAvail'), { chosen: false });
$('#tplSeriesSearch').addEventListener('input', (e) => { tplSeriesSearch = e.currentTarget.value; renderTplSeries(); });
$('#tplSeriesTypeFilter').addEventListener('change', (e) => { tplSeriesTypeFilter = e.currentTarget.value; renderTplSeries(); });

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
  const series = tplChosen.slice();

  // Build concrete, per-issue messages instead of one generic toast.
  const problems = [];
  if (!name) problems.push('name is required');
  if (!channels.length) problems.push('pick at least one channel');
  if (!weekdays.length) problems.push('pick at least one weekday');
  if (!validSlots.length) problems.push('add at least one airing');
  if (validSlots.some((s) => slotMinutes(s) != null && slotMinutes(s) <= 0)) problems.push('an airing ends before it starts');
  // Overlap check within this template (by minute range).
  const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? +m[1] * 60 + +m[2] : null; };
  const ranges = validSlots
    .map((s) => ({ a: toMin(s.start_time), b: toMin(s.end_time) }))
    .filter((r) => r.a != null && r.b != null && r.b > r.a)
    .sort((x, y) => x.a - y.a);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].a < ranges[i - 1].b) { problems.push('airings overlap'); break; }

  showTplErrors(problems);
  if (problems.length) return;

  const maxPerShow = Number($('#tplmMaxPerShow').value) > 0 ? Number($('#tplmMaxPerShow').value) : 0;
  const movieLimit = Number($('#tplmMovieLimit').value) > 0 ? Number($('#tplmMovieLimit').value) : 0;
  const body = { channels, channel_id: channels[0], name, weekdays, slots: validSlots, series,
    max_per_show: maxPerShow,
    is_movie_block: $('#tplmIsMovieBlock').checked ? 1 : 0,
    movie_limit: movieLimit };
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
  if (tplDirty && !await confirmDialog('Discard changes', 'This template has unsaved changes. Close anyway?', { confirmLabel: 'Discard', danger: true })) return;
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
  $('#chmLogo').value = c.logo_filename ?? '';
  $('#chmLogoEnabled').checked = c.logo_enabled !== 0;
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
    logo_filename: $('#chmLogo').value.trim() || null,
    logo_enabled: $('#chmLogoEnabled').checked ? 1 : 0,
    schedule_path: $('#chmSchedulePath').value.trim() || null,
    playlist_dir: $('#chmPlaylistDir').value.trim() || null,
    playlist_template: $('#chmPlaylistTemplate').value.trim() || null,
    api_username: $('#chmUser').value.trim() || null,
    api_password: $('#chmPass').value || null,
    is_active: $('#chmActive').checked ? 1 : 0,
  };
  await api.send('PUT', `/api/channels/${chEditing}`, body);
  invalidateChannels();
  $('#channelModal').classList.add('hidden');
  toast('Channel saved', 'ok');
  await loadSetupTab();
}));
// Deleting a channel takes its catalogue, blocks, history and roots with it, so
// the operator sees exactly how much first (GET …/delete-preview) and types the
// channel's name to confirm. Templates shared with other channels survive.
$('#chmDelete').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  if (chEditing == null) return;
  const p = await api.get(`/api/channels/${chEditing}/delete-preview`);
  const name = p.channel.name;
  const lines = [
    `${p.resources} catalogue entr${p.resources === 1 ? 'y' : 'ies'}, ${p.mediaRoots} media root(s), ${p.series} series`,
    `${Object.entries(p.blocks).map(([k, n]) => `${n} ${k}`).join(', ') || 'no'} block(s) and ${p.playHistory} play-history row(s)`,
    `${p.templatesDeleted} template(s) that air only here`,
  ];
  if (p.templatesKept.length) lines.push(`Kept for the other channels: ${p.templatesKept.map((t) => t.name).join(', ')}`);
  if (p.monitorFeeds.length) lines.push(`Signal monitor feeds lose their link: ${p.monitorFeeds.join(', ')}`);
  if (p.exportedFromToday) lines.push(`⚠ ${p.exportedFromToday} block(s) from today on are already on its OTAV — that Mac keeps airing them.`);

  const confirmed = await new Promise((resolve) => {
    $('#dialogTitle').textContent = `Delete ${name}?`;
    const content = $('#dialogContent');
    content.innerHTML = '';
    content.append(el('p', { className: 'dialog-msg', textContent: 'This permanently removes:' }));
    const ul = el('ul', { className: 'del-list' });
    for (const l of lines) ul.append(el('li', { textContent: l }));
    content.append(ul);
    content.append(el('p', { className: 'dialog-msg', textContent: `Files on disk are not touched. Type “${name}” to confirm.` }));
    const input = el('input', { type: 'text', className: 'dialog-note', placeholder: name });
    content.append(input);
    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: 'danger', textContent: 'Delete channel', disabled: true });
    input.addEventListener('input', () => { ok.disabled = input.value.trim() !== name; });
    cancel.onclick = () => { closeDialog(); resolve(false); };
    ok.onclick = () => { closeDialog(); resolve(true); };
    actions.append(cancel, ok);
    $('#dialog').classList.remove('hidden');
    input.focus();
  });
  if (!confirmed) return;
  await api.send('DELETE', `/api/channels/${chEditing}${p.exportedFromToday ? '?force=1' : ''}`);
  invalidateChannels();
  invalidateResources(chEditing);
  $('#channelModal').classList.add('hidden');
  toast(`${name} deleted`, 'ok');
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
    invalidateChannels();
    e.target.reset();
    toast('Channel added', 'ok');
    await loadSetupTab();
  });
});

