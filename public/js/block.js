import {
  $, $$, api, closeDialog, confirmDialog, confirmWithNote, debounce, el, fmt, getChannels, getResources, scopeDialog, toast, withBusy,
} from './core.js';
import { currentChannelId, loadSchedule, refreshCards, scheduleChannels } from './schedule.js';

// ---- Block editor modal ----------------------------------------------------
let currentBlock = null;
let currentItems = [];      // [{resource_id, name, duration, is_filler, is_manual_override}]
let allResources = [];
let currentMirror = false;  // true when the open block is a mirrored airing (read-only)

// Library pane (left side of the block editor).
let libSearch = '';
let libType = '';           // show_type_code
let libSubject = '';        // Resource.subject
let libDurMin = null;       // seconds, null = no lower bound
let libDurMax = null;       // seconds, null = no upper bound
const libSel = new Set();   // selected resource ids
let libAnchorId = null;     // last-clicked row — anchor for shift-range selection
let blkDrag = null;         // { kind: 'lib', ids: [...] } | { kind: 'item', idx }

const TYPE_LABELS = { movies: 'Movies', documentaries: 'Documentaries', tv_shows: 'TV shows', lessons: 'Lessons', fillers: 'Fillers' };
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
    if (libDurMin != null && r.duration < libDurMin) return false;
    if (libDurMax != null && r.duration > libDurMax) return false;
    if (!q) return true;
    return (r.label || '').toLowerCase().includes(q)
      || (r.display_name || '').toLowerCase().includes(q)
      || (r.name || '').toLowerCase().includes(q)
      || (r.subject || '').toLowerCase().includes(q);
  });
}

export async function openBlock(id) {
  let v;
  try {
    // The block and the channel's catalogue load together; the catalogue is
    // cached per channel, so the second block opened is instant.
    const guess = currentChannelId();
    const [vv, res] = await Promise.all([
      api.get(`/api/blocks/${id}`),
      guess != null ? getResources(guess) : Promise.resolve(null),
    ]);
    v = vv;
    allResources = v.block.channel_id === guess && res ? res : await getResources(v.block.channel_id);
  } catch (e) { return toast(e.message, 'bad', 'Error'); }
  currentBlock = v;
  currentItems = v.items.map((i) => ({ ...i }));
  markSaved();
  currentMirror = (v.block.slot_order || 0) > 0;
  syncScopeControl();

  $('#modalTitle').textContent = `${v.block.template_name} — ${v.block.target_date}`;
  renderModalMeta();
  // Mirror airings copy their primary verbatim: hide the editing controls.
  $('#beLib').style.display = currentMirror ? 'none' : '';
  $('.block-editor').classList.toggle('mirror', currentMirror);
  $('#btnSaveItems').style.display = currentMirror ? 'none' : '';

  libSearch = ''; libType = ''; libSubject = '';
  libSel.clear(); libAnchorId = null;
  $('#libSearch').value = '';
  clearLibDuration();
  renderLibrary();
  renderBlockControls();
  renderItems();
  $('#modal').classList.remove('hidden');
}

function renderModalMeta() {
  const v = currentBlock;
  const moved = v.startShift || v.endShift;
  $('#modalMeta').textContent = (moved
    ? `airs ${v.effectiveStart}–${v.effectiveEnd} (slot ${v.block.start_time}–${v.block.end_time})`
    : `${v.block.start_time}–${v.block.end_time}`)
    + ` · block ${fmt(v.blockSeconds)} · ${scheduleChannels.find((c) => c.id === v.block.channel_id)?.name ?? `channel ${v.block.channel_id}`}`
    + (currentMirror ? ' · 🔁 mirrored airing (read-only — edit the primary airing)' : '');
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

  // Movie-block toggle (writes to the template, rebuilds this block). A movie
  // block pools every title its shows expose and airs the best-fitting run of up
  // to `limit` of them, which is what keeps the slot from becoming mostly filler.
  const mvRow = el('div', { className: 'bc-row' });
  const mvChk = el('input', { type: 'checkbox', checked: !!currentBlock.block.is_movie_block });
  mvRow.append(el('label', { className: 'chk' }, mvChk, document.createTextNode(' Movie block')));
  const mvInp = el('input', { className: 'cat-ord', type: 'number', min: '0', step: '1',
    value: currentBlock.block.movie_limit || '', placeholder: 'max movies (blank = 2)', style: 'max-width:170px' });
  const mvBtn = el('button', { className: 'mini ghost', textContent: 'Apply & refill' });
  mvBtn.onclick = () => withBusy(mvBtn, async () => {
    const v = await api.send('PUT', `/api/blocks/${currentBlock.block.id}/movie-block`,
      { enabled: mvChk.checked, limit: Number(mvInp.value) || 0 });
    currentBlock = v; currentItems = v.items.map((i) => ({ ...i }));
    renderBlockControls(); renderItems();
    toast(mvChk.checked ? 'Movie block applied — block refilled' : 'Movie block turned off — block refilled', 'ok');
    loadSchedule();
  });
  mvRow.append(mvInp, mvBtn);
  box.append(mvRow);

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
  const [h, m, sec = 0] = String(baseHHMM || '00:00').split(':').map(Number);
  const t = (((h * 3600 + m * 60 + sec + offsetSecs) % 86400) + 86400) % 86400;
  return `${String(Math.floor(t / 3600)).padStart(2, '0')}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
}

function renderItems() {
  const list = $('#itemList');
  list.innerHTML = '';
  const totalSecs = currentItems.reduce((s, i) => s + i.duration, 0);
  $('#blockCount').textContent = `${currentItems.length} item(s) · ${fmt(totalSecs)}`;
  // A shifted block airs from its shifted start.
  const blockStart = currentBlock?.effectiveStart || currentBlock?.block?.start_time || '00:00';
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
    // Per-item episode corrector for ORDERED items: pick another chapter of the
    // same show. The backend swaps the item, sets the series cursor, and
    // regenerates later still-draft blocks this week so ordering follows.
    //
    // Only for items that actually carry an ordinal. A standalone film has
    // chapter 0, and every film in the flat Movies folder shares it — offering
    // "which chapter" there is meaningless, and it used to render 138 options all
    // valued 0 and all flagged selected, so the box displayed whichever sorted
    // last rather than the film on this row. Chapters are also deduped by value,
    // since a real catalogue can carry chapter collisions.
    if (!currentMirror && it.subject && it.id != null && Number(it.chapter) > 0) {
      const seen = new Set();
      const chapters = allResources
        .filter((r) => r.subject === it.subject && !r.is_filler && Number(r.chapter) > 0)
        .sort((a, b) => a.chapter - b.chapter)
        .filter((r) => (seen.has(r.chapter) ? false : seen.add(r.chapter)));
      if (chapters.length > 1) {
        const epSel = el('select', { className: 'ep-sel', title: `Episode of “${it.subject}”` });
        for (const c of chapters) {
          epSel.append(el('option', {
            value: c.chapter,
            // Movies have no episode code, so name the part by its title.
            textContent: c.episode_code || c.display_name || c.name,
            selected: c.chapter === it.chapter,
          }));
        }
        epSel.onchange = () => withBusy(null, async () => {
          const picked = chapters.find((c) => c.chapter === Number(epSel.value));
          const r = await api.send('POST', `/api/blocks/${currentBlock.block.id}/items/${it.id}/set-episode`, { chapter: Number(epSel.value) });
          // An episode longer than the slot is placed anyway (the operator chose
          // it). Offer the force right here instead of leaving a red block to go
          // hunting for the button: an overrun the operator accepts is exactly
          // what forcing is for. Cancel keeps the episode and leaves it red.
          const blockId = currentBlock.block.id;
          // An approved block is returned to draft by the pick (its content changed).
          if (r?.reopened) toast('The block was approved — it is back to draft and needs approving again', 'bad', it.subject);
          if (r?.warning) {
            const { ok, note } = await confirmWithNote(
              'Episode longer than the slot',
              `${r.warning} Force it now? It will be approved and pushed with the overrun, and the reason is recorded with the block.`,
              { confirmLabel: 'Force with overrun', placeholder: 'Why (optional) — e.g. episode runs long' },
            );
            if (ok) {
              const f = await api.send('POST', `/api/blocks/${blockId}/override`, { enabled: true, reason: note });
              toast(`Forced with the overrun${alsoAirings(f.siblings)} — it can now be approved`, 'ok', it.subject);
            } else {
              toast('Episode placed — the block stays red until it is forced or the slot is lengthened', 'bad', it.subject);
            }
          } else {
            toast(`Starting at ${picked?.episode_code || 'that episode'} — this block and later drafts rebuilt`, 'ok', it.subject);
          }
          await openBlock(blockId);
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

// Longest unbroken run of fillers in the block, in seconds. Mirrors
// maxFillerRunSeconds() in services/scheduling.js.
function fillerRunSeconds(items) {
  let run = 0;
  let max = 0;
  for (const i of items) {
    if (i.is_filler) { run += i.duration; if (run > max) max = run; }
    else run = 0;
  }
  return max;
}

// Live client-side recompute mirroring the server's validateBlock(): duration
// inside tolerance, no filler run over the cap, and no mixed content types in a
// movie block. All three gate the Approve button — and the push behind it.
function renderValidation() {
  const total = currentItems.reduce((s, i) => s + i.duration, 0);
  const diff = currentBlock.blockSeconds - total;
  const maxUnderrun = currentBlock.maxUnderrun ?? 5;
  const maxOverrun = currentBlock.maxOverrun ?? 0;
  const maxFillerRun = currentBlock.maxFillerRun ?? 1200;
  const durationFits = diff <= maxUnderrun && diff >= -maxOverrun;
  const fillerRun = fillerRunSeconds(currentItems);
  const fillerFits = fillerRun <= maxFillerRun;
  const offType = currentBlock.block?.is_movie_block
    ? currentItems.filter((i) => !i.is_filler && i.show_type_code !== 'movies')
    : [];
  const fits = durationFits && fillerFits && offType.length === 0;

  // A block the catalogue simply cannot satisfy can be FORCED by the operator.
  // It still does not "fit" — nothing about it is green — but it may be approved
  // and pushed, and the reason travels with the block.
  const overridden = !!currentBlock.overridden;
  const approvable = fits || overridden;

  const box = $('#modalValidation');
  box.className = `validation ${fits ? 'ok' : overridden ? 'warn' : 'bad'}`;
  const problems = [];
  if (!durationFits) {
    problems.push(diff < 0
      ? `OVERRUN by ${fmt(-diff)} — exceeds ${maxOverrun}s tolerance`
      : `UNDERRUN ${fmt(diff)} — exceeds ${maxUnderrun}s tolerance`);
  }
  if (!fillerFits) {
    problems.push(`${fmt(fillerRun)} of filler back to back — max ${fmt(maxFillerRun)}. `
      + 'Add content or remove fillers.');
  }
  if (offType.length) {
    problems.push(`${offType.length} clip(s) in this movie block are not movies`);
  }
  box.textContent = fits
    ? (diff >= 0
        ? `Fits — total ${fmt(total)}, ${fmt(diff)} under (≤ ${maxUnderrun}s) · longest filler run ${fmt(fillerRun)}`
        : `Fits — total ${fmt(total)}, ${fmt(-diff)} over (≤ ${maxOverrun}s) · longest filler run ${fmt(fillerRun)}`)
    : `${overridden ? 'FORCED — ' : ''}${problems.join(' · ')}`;
  if (overridden && currentBlock.overrideReason) {
    box.append(el('div', { className: 'validation-note', textContent: `Forced: ${currentBlock.overrideReason}` }));
  }

  // Mark the offending clips so the operator sees WHERE to cut, not just that
  // something is wrong.
  const rows = [...$('#itemList').children];
  let run = 0;
  const runRows = [];
  const flagRun = () => {
    if (run > maxFillerRun) for (const r of runRows) r.classList.add('overfill');
    run = 0; runRows.length = 0;
  };
  currentItems.forEach((i, idx) => {
    const row = rows[idx];
    if (row) row.classList.remove('overfill', 'offtype');
    if (i.is_filler) { run += i.duration; if (row) runRows.push(row); }
    else {
      flagRun();
      if (row && offType.includes(i)) row.classList.add('offtype');
    }
  });
  flagRun();

  $('#btnApproveBlock').disabled = !approvable;
  // Offer the force only where it means something: on a block that does not
  // pass, or on one already forced (so it can be taken back).
  const force = $('#btnOverrideBlock');
  force.hidden = currentMirror || (fits && !overridden);
  force.textContent = overridden ? '↩ Undo force' : '⚠ Force this block';
  force.title = overridden
    ? 'Stop forcing this block — it goes back to being refused until it passes'
    : 'Approve and push it anyway, and record why';
  renderShift(diff, durationFits);
  return approvable;
}

// ---- Block shift -----------------------------------------------------------
// When no clip closes the hole (or the programme simply runs long), the block's
// start or end can be moved instead. The boundary is shared with the block next
// to it — ending 3:12 later means the next block starts 3:12 later — which is
// what really happens on air, since OTAV plays the day as one playlist.
export const fmtShift = (s) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${fmt(Math.abs(s)).replace(/^0:/, '')}`;

// "+3:12", "-0:45", "1:02:03", "90" → signed seconds; null when unreadable.
function parseShift(text) {
  const t = String(text).trim().replace('−', '-');
  if (t === '') return 0;
  const m = /^([+-]?)(\d+(?::\d{1,2}){0,2})$/.exec(t);
  if (!m) return null;
  const secs = m[2].split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  return m[1] === '-' ? -secs : secs;
}

function renderShift(diff, durationFits) {
  const box = $('#blockShift');
  box.innerHTML = '';
  const v = currentBlock;
  if (!v || v.startShift === undefined) return;

  const edge = (key) => {
    const isStart = key === 'start';
    const current = isStart ? v.startShift : v.endShift;
    const wrap = el('span', { className: 'bs-edge' });
    wrap.append(el('span', {
      className: current ? 'bs-moved' : 'muted',
      textContent: `${isStart ? 'Starts' : 'Ends'} ${isStart ? v.effectiveStart : v.effectiveEnd}`
        + (current ? ` (${fmtShift(current)})` : ''),
    }));
    if (isStart && v.prevBlockId == null) {
      wrap.title = 'Nothing airs right before this block, so its start stays on the slot time';
      return wrap;
    }
    const input = el('input', {
      type: 'text', value: current ? fmtShift(current) : '', placeholder: '+m:ss',
      title: `Move the ${key} of the block: +3:12 later, -0:45 earlier (max ${fmt(v.maxShift)})`,
    });
    input.setAttribute('aria-label', `Move the ${key} of the block`);
    const move = el('button', { className: 'mini ghost', type: 'button', textContent: 'Move' });
    move.onclick = () => {
      const secs = parseShift(input.value);
      if (secs == null) return toast('Write it as +3:12, -0:45 or a number of seconds', 'bad', 'Move block');
      applyShift(key, secs, move);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') move.click(); });
    wrap.append(input, move);
    // One click to land the block exactly on its content: an underrun pulls the
    // edge in, an overrun pushes it out.
    const fitTo = isStart ? current + diff : current - diff;
    if (!durationFits && Math.abs(fitTo) <= v.maxShift) {
      const match = el('button', {
        className: 'mini ghost', type: 'button', textContent: `Match content (${fmtShift(fitTo) || '0'})`,
        title: isStart ? 'Start the block where its content needs it to' : 'End the block where its content ends',
      });
      match.onclick = () => applyShift(key, fitTo, match);
      wrap.append(match);
    }
    if (current) {
      const reset = el('button', { className: 'mini ghost', type: 'button', textContent: 'Reset', title: 'Back to the slot time' });
      reset.onclick = () => applyShift(key, 0, reset);
      wrap.append(reset);
    }
    return wrap;
  };
  box.append(edge('start'), edge('end'));
}

async function applyShift(edge, seconds, btn) {
  await withBusy(btn, async () => {
    const id = currentBlock.block.id;
    // The shift was worked out from what is on screen, so save that first.
    if (!currentMirror) {
      const items = currentItems.map((i) => ({ resource_id: i.resource_id, is_manual_override: i.is_manual_override ? 1 : 0 }));
      await api.send('PUT', `/api/blocks/${id}/items`, { items });
    }
    const v = await api.send('PUT', `/api/blocks/${id}/shift`, { edge, seconds });
    currentBlock = v;
    currentItems = v.items.map((i) => ({ ...i }));
    renderModalMeta();
    renderItems();
    const n = v.neighbour;
    if (n) {
      toast(`${n.template_name} now airs ${n.effectiveStart}–${n.effectiveEnd}`
        + (n.fits ? '' : ` and ${n.problem} — open it to adjust`), n.fits ? 'ok' : 'bad', 'Block moved');
    } else toast(`Block now airs ${v.effectiveStart}–${v.effectiveEnd}`, 'ok', 'Block moved');
    markSaved();
    refreshCards([id, n?.id].filter(Boolean));
  }).catch(() => {});
}

// ---- Library pane ----------------------------------------------------------
// Rebuild the two filter dropdowns from what the channel actually has, keeping
// the current pick when it survives the other filter.
function renderLibFilters() {
  const typeSel = $('#libType');
  const types = [...new Set(allResources.map((r) => r.show_type_code).filter(Boolean))].sort();
  typeSel.innerHTML = '';
  typeSel.append(el('option', { value: '', textContent: 'All show types' }));
  for (const c of types) typeSel.append(el('option', { value: c, textContent: TYPE_LABELS[c] || c, selected: c === libType }));

  const subjSel = $('#libSubject');
  const subjects = [...new Set(allResources
    .filter((r) => !libType || r.show_type_code === libType)
    .map((r) => r.subject).filter(Boolean))].sort();
  subjSel.innerHTML = '';
  subjSel.append(el('option', { value: '', textContent: 'All shows' }));
  for (const s of subjects) subjSel.append(el('option', { value: s, textContent: s, selected: s === libSubject }));
  if (libSubject && !subjects.includes(libSubject)) { libSubject = ''; subjSel.value = ''; }
}

function renderLibrary() {
  if (currentMirror) return;
  renderLibFilters();
  const rows = libFiltered();
  const list = $('#libList');
  list.innerHTML = '';
  const durNote = libDurMin != null || libDurMax != null
    ? ` · ${fmt(libDurMin ?? 0)}–${libDurMax != null ? fmt(libDurMax) : '∞'}`
    : '';
  $('#libCount').textContent = `${rows.length} clip(s)${durNote}`
    + `${libSel.size ? ` · ${libSel.size} selected` : ''}`;

  if (!rows.length) {
    list.append(el('li', { className: 'muted', textContent: 'Nothing matches this filter.' }));
    return;
  }
  // A full channel catalogue runs to thousands of clips and this re-renders on
  // every keystroke — draw a window, keep selection/stride over the full match.
  const shown = rows.slice(0, LIB_RENDER_CAP);
  shown.forEach((r, idx) => {
    const li = el('li', { className: r.is_filler ? 'filler' : '', draggable: true });
    li.dataset.id = r.id;
    li.append(el('span', { className: 'drag', textContent: '⠿', title: 'Drag into the block' }));
    const cb = el('input', { type: 'checkbox', className: 'cat-sel', checked: libSel.has(r.id), title: 'Select — Shift-click for a range' });
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
    const add = el('button', { className: 'mini ghost', textContent: '→', title: 'Append to the block' });
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
      `Showing ${shown.length} of ${rows.length} — narrow the filter. Selection and stride still apply to all ${rows.length}.` }));
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
    if (!await confirmDialog('Add to block',
      `This adds ${rows.length} clips (${fmt(secs)}) to a ${fmt(currentBlock.blockSeconds)} block. Continue?`,
      { confirmLabel: `Add ${rows.length}` })) return;
  }
  const items = rows.map(resourceToItem);
  if (idx == null || idx >= currentItems.length) currentItems.push(...items);
  else currentItems.splice(idx, 0, ...items);
  libSel.clear();
  renderItems();
  renderLibrary();
}

// Duration filter: three boxes per bound, so an operator types a length the way
// they read one (1 h 45 m 00 s) instead of converting it to seconds.
const DUR_IDS = ['libDurMinH', 'libDurMinM', 'libDurMinS', 'libDurMaxH', 'libDurMaxM', 'libDurMaxS'];
function hmsSeconds(h, m, sec) {
  const parts = [h, m, sec].map((id) => $('#' + id).value.trim());
  if (parts.every((v) => v === '')) return null; // all blank = no bound
  const [hh, mm, ss] = parts.map((v) => Math.max(0, Number(v) || 0));
  return hh * 3600 + mm * 60 + ss;
}
function readLibDuration() {
  libDurMin = hmsSeconds('libDurMinH', 'libDurMinM', 'libDurMinS');
  libDurMax = hmsSeconds('libDurMaxH', 'libDurMaxM', 'libDurMaxS');
  renderLibrary();
}
function clearLibDuration() {
  for (const id of DUR_IDS) $('#' + id).value = '';
  libDurMin = null; libDurMax = null;
}
const readLibDurationSoon = debounce(readLibDuration, 250);
for (const id of DUR_IDS) $('#' + id).addEventListener('input', readLibDurationSoon);
$('#btnLibDurClear').addEventListener('click', () => { clearLibDuration(); renderLibrary(); });

const renderLibrarySoon = debounce(renderLibrary, 200);
$('#libSearch').addEventListener('input', (e) => { libSearch = e.currentTarget.value; renderLibrarySoon(); });
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
  toast(`Selected ${libSel.size} clip(s) — every ${n} starting at ${off}`, 'ok', 'Selection');
});

$('#btnAddSelected').addEventListener('click', () => {
  const rows = libFiltered().filter((r) => libSel.has(r.id));
  if (!rows.length) return toast('Nothing is selected', 'bad', 'Library');
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
  markSaved();
  renderModalMeta();
  toast('Order saved', 'ok');
  refreshCards([currentBlock.block.id]);
}));
// A template can air the same content several times a day, and the repeats
// mirror it clip for clip — so a force applies to all of them and the toast
// says so, or the operator goes looking for the midnight repeat by hand.
const alsoAirings = (n) => (n > 0 ? ` (and ${n} more airing${n > 1 ? 's' : ''} that day)` : '');

// ---- Block actions, with channel scope -----------------------------------------
// Approve, force and regenerate act on this block — or also on the same airing
// (template + slot + date) on other channels, per the "Apply to" select next to
// the buttons. Each counterpart goes through the same endpoint and keeps its own
// verdict, so one that does not pass is reported, never pushed through.
let blockScopeIds = [];   // extra channels; empty = this channel only

function syncScopeControl() {
  const sel = $('#blockScope');
  if (!sel) return;
  sel.value = blockScopeIds.length ? 'more' : 'only';
  $('#blockScopeNames').textContent = blockScopeIds.length ? `+ ${blockScopeIds.length} channel(s)` : '';
}
$('#blockScope')?.addEventListener('change', async (e) => {
  if (e.currentTarget.value === 'only') { blockScopeIds = []; syncScopeControl(); return; }
  const channels = (await getChannels()).filter((c) => c.is_active || c.id === currentBlock.block.channel_id);
  // The dialog shares #dialog with nothing else open here; the modal stays put.
  const ids = await scopeDialog({
    title: 'Apply block actions to', action: 'block', current: currentBlock.block.channel_id, channels,
    message: 'Approve, Force and Regenerate will also run on the same airing on these channels (same template, slot and date).',
    confirmLabel: 'Use these channels', mode: 'more',
  });
  blockScopeIds = ids ? ids.slice(1) : [];
  syncScopeControl();
});

/** Ids of this airing on the scoped channels (not this block), plus who has none. */
async function counterparts() {
  if (!blockScopeIds.length) return { ids: [], none: [] };
  const r = await api.get(`/api/blocks/${currentBlock.block.id}/counterparts?channels=${blockScopeIds.join(',')}`);
  return { ids: r.counterparts.map((c) => c.id), names: r.counterparts, none: r.none };
}

/** Run `fn(id)` on each counterpart; returns a one-line summary. */
async function onCounterparts(fn) {
  const { ids, names = [], none = [] } = await counterparts();
  let ok = 0;
  const failed = [];
  for (const id of ids) {
    try { await fn(id); ok++; } catch (err) {
      failed.push(`${names.find((n) => n.id === id)?.channel_name ?? id}: ${err.message}`);
    }
  }
  if (!ids.length && !none.length) return { line: '', touched: [] };
  const parts = [];
  if (ok) parts.push(`${ok} other channel(s) too`);
  if (failed.length) parts.push(`refused on ${failed.join('; ')}`);
  if (none.length) parts.push(`${none.length} channel(s) don't air it that day`);
  return { line: parts.length ? ` — ${parts.join(', ')}` : '', touched: ids, bad: failed.length > 0 };
}

const saveOnScreen = () => api.send('PUT', `/api/blocks/${currentBlock.block.id}/items`, {
  items: currentItems.map((i) => ({ resource_id: i.resource_id, is_manual_override: i.is_manual_override ? 1 : 0 })),
});

$('#btnOverrideBlock').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const id = currentBlock.block.id;
  if (currentBlock.overridden) {
    currentBlock = await api.send('POST', `/api/blocks/${id}/override`, { enabled: false });
    currentItems = currentBlock.items.map((i) => ({ ...i }));
    markSaved();
    renderItems();
    const more = await onCounterparts((cid) => api.send('POST', `/api/blocks/${cid}/override`, { enabled: false }));
    toast(`Force removed${alsoAirings(currentBlock.siblings)}${more.line} — refused again until it passes`, 'ok');
    refreshCards([id]);
    return;
  }
  // Save what is on screen first: the recorded reason must describe the block
  // as the operator is actually leaving it, not as the server last saw it.
  if (!currentMirror) await saveOnScreen();
  const { ok, note } = await confirmWithNote(
    'Force this block',
    'This block does not meet the rules and will be approved and pushed anyway. '
    + 'Do this when the catalogue has nothing that fixes it — the problem is recorded with the block.',
    { confirmLabel: 'Force it', placeholder: 'Why (optional) — e.g. no shorter documentary exists' }
  );
  if (!ok) return;
  currentBlock = await api.send('POST', `/api/blocks/${id}/override`, { enabled: true, reason: note });
  currentItems = currentBlock.items.map((i) => ({ ...i }));
  markSaved();
  renderItems();
  const more = await onCounterparts((cid) => api.send('POST', `/api/blocks/${cid}/override`, { enabled: true, reason: note }));
  toast(`Block forced${alsoAirings(currentBlock.siblings)}${more.line} — it can now be approved`, more.bad ? 'info' : 'ok');
  refreshCards([id]);
}));

$('#btnApproveBlock').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  // Persist current edits first, then approve.
  const id = currentBlock.block.id;
  if (!currentMirror) await saveOnScreen();
  await api.send('POST', `/api/blocks/${id}/approve`);
  const more = await onCounterparts((cid) => api.send('POST', `/api/blocks/${cid}/approve`));
  markSaved();
  closeBlockModal(true);
  toast(`Block approved${more.line}`, more.bad ? 'info' : 'ok');
  refreshCards([id]);
}));

$('#btnRegenBlock')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ok = await confirmDialog('Regenerate this block',
    'Rebuilds the block from its template: clips you pinned by hand stay, everything else is picked again, and a force is cleared.'
    + (blockScopeIds.length ? ' Also on the selected channels.' : ''),
    { confirmLabel: 'Regenerate' });
  if (!ok) return;
  await withBusy(btn, async () => {
    const id = currentBlock.block.id;
    await api.send('POST', `/api/blocks/${id}/regenerate`);
    const more = await onCounterparts((cid) => api.send('POST', `/api/blocks/${cid}/regenerate`));
    toast(`Block rebuilt${more.line}`, 'ok');
    await openBlock(id);
    refreshCards([id]);
  }).catch(() => {}); // withBusy already showed the error
});

// ---- Closing the editor ---------------------------------------------------------
// Esc or a click outside used to drop unsaved edits without a word. They ask now.
let savedSnapshot = '';
const snapshot = () => JSON.stringify(currentItems.map((i) => [i.resource_id, i.is_manual_override ? 1 : 0]));
function markSaved() { savedSnapshot = snapshot(); }
const isDirty = () => !currentMirror && !$('#modal').classList.contains('hidden') && snapshot() !== savedSnapshot;

async function closeBlockModal(force = false) {
  if (!force && isDirty()) {
    const ok = await confirmDialog('Discard changes?', 'This block has edits that are not saved.', { confirmLabel: 'Discard', danger: true });
    if (!ok) return;
  }
  $('#modal').classList.add('hidden');
}
$('#modalClose').addEventListener('click', () => closeBlockModal());
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeBlockModal(); });
window.addEventListener('beforeunload', (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // One layer at a time: the dialog on top closes first, then the editor.
  if (!$('#dialog').classList.contains('hidden')) { closeDialog(); return; }
  if (!$('#modal').classList.contains('hidden')) { closeBlockModal(); return; }
  $('#seriesModal')?.classList.add('hidden');
  // #templateModal has its own Esc handler — it confirms before discarding edits.
  $('#channelModal')?.classList.add('hidden');
});

