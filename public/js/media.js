import { $, $$, api, closeDialog, confirmDialog, el, fmt, invalidateResources, reportDialog, toast, withBusy } from './core.js';
import { populateSelect } from './setup.js';

// ---- Media & Roots ---------------------------------------------------------
let browsePath = null;
let selectedFolder = null;

let mediaChannels = [];

export async function loadMediaTab() {
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
    // Re-check scope. "" = every channel, which is the honest default: the
    // catalogue is shared, and a clip several channels air is one physical file.
    const rc = $('#recheckChannel');
    const keep = rc.value;
    rc.innerHTML = '';
    rc.append(el('option', { value: '', textContent: 'every channel' }));
    for (const c of mediaChannels) rc.append(el('option', { value: String(c.id), textContent: c.name }));
    if (keep && [...rc.options].some((o) => o.value === keep)) rc.value = keep;
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
  const reused = r.results.reduce((s, x) => s + (x.reused || 0), 0);
  toast(`Ingested ${total} resource(s) across ${r.results.length} root(s)`
    + (reused ? ` · ${reused} unchanged, probe skipped` : ''), 'ok', 'Scan complete');
}));

// Re-check what is already catalogued. Separate from the root scan on purpose:
// this one never lists a directory, so it is the cheap answer to "are my clips
// still there and still the length I recorded?" — and the only thing that finds
// a clip that has vanished, which is what makes a block fail on air.
$('#btnRecheck').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const channel = $('#recheckChannel').value;
  const r = await api.send('POST', '/api/media/recheck', channel ? { channel_id: Number(channel) } : {});
  const parts = [`${r.checked} clip(s) checked`];
  if (r.unchanged) parts.push(`${r.unchanged} unchanged`);
  if (r.updated) parts.push(`${r.updated} duration(s) corrected`);
  if (r.errors.length) parts.push(`${r.errors.length} unreadable`);
  if (r.missing.length) {
    toast(`${r.missing.length} catalogued clip(s) are NOT on disk any more — a block holding one `
      + `will fail on air. Nothing was deleted. First: ${r.missing[0].file}`,
    'bad', 'Missing media');
  }
  toast(parts.join(' · '), r.missing.length ? 'info' : 'ok', 'Re-check complete');
  if (r.missing.length || r.updated) await loadMediaTab().catch(() => {});
}));
// Catalogue path repair (services/catalogRepair.js): a clip that is not at its
// path any more is usually somewhere else — converted by Air Spec, its folder
// renamed, moved by hand. Preview first, then apply; nothing on disk is touched.
async function showRepair(deep) {
  const r = await api.get(`/api/media/repair${deep ? '?deep=1' : ''}`);
  const short = (p) => String(p).replace(/^\/Volumes\/[^/]+\//, '');
  const rows = [
    ...r.relocate.map((x) => ({ name: short(x.from), ok: true, detail: `→ ${short(x.to)} (${x.rows} catalogue row(s))` })),
    ...r.aliases.map((x) => ({ name: short(x.from), ok: true, detail: `same file as ${short(x.to)} — folded into it` })),
    ...r.ambiguous.map((x) => ({ name: short(x.file_path), ok: false, detail: `several candidates: ${x.candidates.map(short).join(' · ')}` })),
    ...r.notFound.map((x) => ({ name: short(x.file_path), ok: false, detail: x.nameMatches.length ? `same name but a different length at ${x.nameMatches.map(short).join(' · ')}` : 'not found anywhere' })),
    ...r.unreadable.map((x) => ({ name: short(x.file_path), ok: false, detail: `unreadable (${x.error}) — is the share mounted?` })),
  ];
  // Nearly everything gone at once is the share not being mounted, not a
  // catalogue problem — say so instead of listing six thousand files.
  if (r.checked > 20 && r.notFound.length > r.checked / 2) {
    rows.splice(0, rows.length, { name: `${r.notFound.length} of ${r.checked} catalogued clips are not on disk`, ok: false,
      detail: 'That is almost everything: the share is probably not mounted on this Mac. Mount it (🔌 above) and try again.' });
  }
  const fixable = r.relocate.length + r.aliases.length;
  reportDialog(`Repair: ${r.relocate.length} found elsewhere, ${r.aliases.length} alias(es), `
    + `${r.notFound.length + r.ambiguous.length} unresolved${deep ? ' (deep search)' : ''}`,
  rows.length ? rows : [{ name: `All ${r.checked} catalogued paths are on disk`, ok: true, detail: '' }]);
  const actions = $('#dialogActions');
  if (!deep && r.notFound.length) {
    const deeper = el('button', { className: 'ghost', textContent: 'Search the share too…', title: 'Walk the folders above the media roots for files moved by hand (slower)' });
    deeper.onclick = () => withBusy(deeper, () => showRepair(true)).catch(() => {});
    actions.prepend(deeper);
  }
  if (fixable) {
    const apply = el('button', { className: 'primary', textContent: `Re-point ${fixable} path(s)` });
    apply.onclick = () => withBusy(apply, async () => {
      const done = await api.send('POST', '/api/media/repair', { deep });
      closeDialog();
      invalidateResources();
      toast(`${done.applied.rowsMoved} catalogue row(s) re-pointed, ${done.applied.rowsMerged} merged`
        + (done.exportedDays.length ? ` — re-push ${done.exportedDays.length} day(s) already on OTAV: `
          + done.exportedDays.slice(0, 4).map((d) => `${d.channel} ${d.target_date}`).join(', ') : ''),
      'ok', 'Catalogue repaired');
    }).catch(() => {});
    actions.prepend(apply);
  }
}
$('#btnRepair').addEventListener('click', (e) => withBusy(e.currentTarget, () => showRepair(false)).catch(() => {}));

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
  // one row per (path, show type) with the channels shown as badges. scan/edit/
  // delete fan out across every underlying row, so a shared root is managed as
  // ONE thing and its channels can't drift apart.
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.path} ${r.show_type_id}`;
    if (!groups.has(key)) groups.set(key, { path: r.path, show_type_id: r.show_type_id, show_type_name: r.show_type_name, channels: [] });
    groups.get(key).channels.push(r); // each carries id + channel_name + channel_id
  }
  // View: every shared root, or the roots ONE channel has to itself. A channel's
  // exclusive roots are not shown anywhere else, so they can't be mistaken for
  // (or edited as) part of the shared library.
  const view = $('#rootsView');
  const pick = view.value || (() => { try { return localStorage.getItem('rootsView') || ''; } catch { return ''; } })() || 'shared';
  const shared = [...groups.values()].filter((g) => g.channels.length > 1);
  const only = (cid) => [...groups.values()].filter((g) => g.channels.length === 1 && g.channels[0].channel_id === cid);
  view.innerHTML = '';
  view.append(el('option', { value: 'shared', textContent: `Shared across channels (${shared.length})` }));
  for (const c of mediaChannels) {
    view.append(el('option', { value: String(c.id), textContent: `Only on ${c.name} (${only(c.id).length})` }));
  }
  view.value = [...view.options].some((o) => o.value === pick) ? pick : 'shared';
  view.onchange = () => {
    try { localStorage.setItem('rootsView', view.value); } catch { /* per-viewer nicety only */ }
    loadRoots();
  };
  const visible = view.value === 'shared' ? shared : only(Number(view.value));
  if (!visible.length) {
    tb.append(el('tr', {}, el('td', { colSpan: 4, className: 'muted', style: 'text-align:center;padding:22px',
      textContent: view.value === 'shared' ? 'No folder is shared by more than one channel.' : 'This channel has no roots of its own — everything it carries is shared.' })));
  }
  for (const g of visible) {
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
    // Share: hand this already-scanned folder to more channels. The catalog is
    // cloned from the donor channel, so the new channel has the clips available
    // (durations, edits and approval intact) without an ffprobe pass.
    const btnShare = el('button', { className: 'mini ghost', textContent: 'share' });
    btnShare.onclick = async () => {
      const have = new Set(g.channels.map((c) => c.channel_id));
      const missing = mediaChannels.filter((c) => !have.has(c.id));
      if (!missing.length) return toast('Every channel already has this folder', 'ok', label);
      const picked = await channelsDialog(
        'Share folder with channels',
        `“${g.path}” (${g.show_type_name}) — pick the channels that should also carry this media.`,
        missing, { confirmLabel: 'Share' },
      );
      if (!picked?.length) return;
      await withBusy(btnShare, async () => {
        const r = await api.send('POST', '/api/media/roots', {
          channel_ids: picked, show_type_id: g.channels[0].show_type_id, path: g.path,
        });
        const n = r.created?.length ?? 0;
        const cloned = r.clonedResources ?? 0;
        toast(
          `Shared with ${n} channel${n === 1 ? '' : 's'}`
            + (cloned ? ` — ${cloned} clip(s) reused, no scan needed` : ' — run a scan to catalog it'),
          'ok', label,
        );
        await loadRoots();
        await loadResources();
      });
    };
    const btnEdit = el('button', { className: 'mini ghost', textContent: 'edit' });
    // One edit for every channel carrying the folder (type + which channels).
    btnEdit.onclick = () => editRootGroup(g);
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
    td.append(btnScan, document.createTextNode(' '), btnShare, document.createTextNode(' '),
      btnEdit, document.createTextNode(' '), btnDel); tr.append(td);
    tb.append(tr);
  }
}

// Edit a media root as ONE thing across every channel that carries it: its
// folder type and the set of channels. The catalogue is re-tagged on save; a
// channel ticked on gets the already-scanned clips cloned, a channel ticked off
// loses the root and the clips it catalogued there (asked first).
async function editRootGroup(g) {
  const showTypes = await api.get('/api/showtypes');
  $('#dialogTitle').textContent = 'Edit media root';
  const content = $('#dialogContent');
  content.innerHTML = '';
  content.append(el('p', { className: 'dialog-msg', textContent: g.path }));
  const have = new Set(g.channels.map((c) => c.channel_id));
  const box = el('div', { className: 'weekday-row' });
  const boxes = mediaChannels.map((c) => {
    const input = el('input', { type: 'checkbox', value: c.id, checked: have.has(c.id) });
    box.append(el('label', { className: 'chk' }, input, document.createTextNode(' ' + c.name)));
    return input;
  });
  const stSel = el('select');
  for (const s of showTypes) stSel.append(el('option', { value: s.id, textContent: s.name, selected: s.id === g.show_type_id }));
  content.append(
    el('span', { className: 'form-title' }, document.createTextNode('Channels that carry this folder')),
    box,
    el('label', { className: 'field' }, document.createTextNode('Folder type'), stSel),
    el('p', { className: 'hint muted', textContent: 'Applies to every ticked channel at once. Clips already catalogued are re-tagged immediately — no re-scan needed.' }),
  );
  const actions = $('#dialogActions');
  actions.innerHTML = '';
  const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
  const save = el('button', { className: 'primary', textContent: 'Save' });
  cancel.onclick = closeDialog;
  save.onclick = async () => {
    const channel_ids = boxes.filter((b) => b.checked).map((b) => Number(b.value));
    if (!channel_ids.length) return toast('Tick at least one channel — or delete the root', 'bad');
    const dropping = g.channels.filter((c) => !channel_ids.includes(c.channel_id));
    closeDialog();
    if (dropping.length && !await confirmDialog('Remove channels from root',
      `${dropping.map((c) => c.channel_name).join(', ')} will stop carrying “${g.path}”, and the clips it catalogued there are dropped from those channels (and from their draft blocks).`,
      { confirmLabel: 'Remove', danger: true })) return;
    await withBusy(null, async () => {
      const r = await api.send('PUT', '/api/media/roots/group', {
        path: g.path, show_type_id: g.show_type_id,
        next_show_type_id: Number(stSel.value), channel_ids,
      });
      const bits = [];
      if (r.retagged) bits.push(`${r.retagged} clip(s) re-tagged`);
      if (r.added) bits.push(`added to ${r.added} channel(s)${r.clonedResources ? `, ${r.clonedResources} clip(s) reused` : ''}`);
      if (r.removed) bits.push(`removed from ${r.removed} channel(s), ${r.droppedResources} clip(s) dropped`);
      toast(bits.join(' · ') || 'Nothing changed', 'ok', g.path.split('/').pop());
      await loadRoots();
      await loadResources();
    });
  };
  actions.append(cancel, save);
  $('#dialog').classList.remove('hidden');
}

// A checkbox list of channels on the generic #dialog. Resolves the checked ids,
// or null on cancel. Used wherever media has to be handed to more channels.
function channelsDialog(title, msg, channels, { confirmLabel = 'Apply' } = {}) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = title;
    const content = $('#dialogContent');
    content.innerHTML = '';
    content.append(el('p', { className: 'dialog-msg', textContent: msg }));
    const box = el('div', { className: 'weekday-row' });
    const boxes = channels.map((c) => {
      const input = el('input', { type: 'checkbox', value: c.id });
      box.append(el('label', { className: 'chk' }, input, document.createTextNode(' ' + c.name)));
      return input;
    });
    content.append(box);
    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: 'primary', textContent: confirmLabel });
    cancel.onclick = () => { closeDialog(); resolve(null); };
    ok.onclick = () => {
      const picked = boxes.filter((b) => b.checked).map((b) => Number(b.value));
      closeDialog();
      resolve(picked);
    };
    actions.append(cancel, ok);
    $('#dialog').classList.remove('hidden');
  });
}

// Copy every root of one channel onto others — the fast path for a channel that
// was just created and should carry the same media as an existing one.
$('#btnCopyRoots')?.addEventListener('click', async () => {
  if (mediaChannels.length < 2) return toast('Add a second channel first', 'bad');
  const roots = await api.get('/api/media/roots');
  const withRoots = mediaChannels.filter((c) => roots.some((r) => r.channel_id === c.id));
  if (!withRoots.length) return toast('No channel has media roots to copy yet', 'bad');

  $('#dialogTitle').textContent = 'Copy media roots';
  const content = $('#dialogContent');
  content.innerHTML = '';
  const src = el('select');
  for (const c of withRoots) {
    const n = roots.filter((r) => r.channel_id === c.id).length;
    src.append(el('option', { value: c.id, textContent: `${c.name} (${n} root${n === 1 ? '' : 's'})` }));
  }
  const box = el('div', { className: 'weekday-row' });
  const boxes = new Map();
  for (const c of mediaChannels) {
    const input = el('input', { type: 'checkbox', value: c.id });
    const lbl = el('label', { className: 'chk' }, input, document.createTextNode(' ' + c.name));
    boxes.set(c.id, { input, lbl });
    box.append(lbl);
  }
  // A channel can't copy onto itself: hide the source from the target list.
  const syncTargets = () => {
    for (const [id, { lbl, input }] of boxes) {
      const isSource = id === Number(src.value);
      lbl.style.display = isSource ? 'none' : '';
      if (isSource) input.checked = false;
    }
  };
  src.onchange = syncTargets;
  syncTargets();
  content.append(
    el('label', { className: 'field' }, document.createTextNode('Copy roots from'), src),
    el('span', { className: 'form-title' }, document.createTextNode('To these channels')),
    box,
    el('p', { className: 'hint muted', textContent: 'Already-scanned clips are reused as-is — durations, catalog edits and approval carry over, so no ffprobe pass is needed.' }),
  );
  const actions = $('#dialogActions');
  actions.innerHTML = '';
  const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
  const ok = el('button', { className: 'primary', textContent: 'Copy' });
  cancel.onclick = closeDialog;
  ok.onclick = () => withBusy(ok, async () => {
    const to_channel_ids = [...boxes.values()].filter((b) => b.input.checked).map((b) => Number(b.input.value));
    if (!to_channel_ids.length) return toast('Pick at least one target channel', 'bad');
    const r = await api.send('POST', '/api/media/roots/copy', { from_channel_id: Number(src.value), to_channel_ids });
    closeDialog();
    const n = r.created?.length ?? 0;
    toast(
      n ? `Copied ${n} root assignment(s) — ${r.clonedResources} clip(s) reused`
        : 'Nothing to copy — those channels already have every root',
      'ok',
    );
    await loadRoots();
    await loadResources();
  });
  actions.append(cancel, ok);
  $('#dialog').classList.remove('hidden');
});

// A single text-input dialog built on the generic #dialog, with an optional
// datalist of suggestions. Resolves the entered string, or null on cancel.
export function inputDialog(title, label, initial = '', suggestions = null) {
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

