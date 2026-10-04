import { fmtShift, openBlock } from './block.js';
import { $, api, closeDialog, confirmDialog, el, fmt, localToday, reportDialog, toast, withBusy } from './core.js';

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

// Per-channel filtering of the schedule/generator. The grid shows ONE channel
// at a time: an all-channels view is six times the blocks for a week nobody can
// read across anyway, and each card costs a query on the server. The choice is
// remembered like the theme, so a reload doesn't bounce back to the first one.
const SCHEDULE_CHANNEL_KEY = 'otav.scheduleChannel';
export let scheduleChannels = [];
let currentScheduleChannel = Number(localStorage.getItem(SCHEDULE_CHANNEL_KEY)) || null;

async function renderChannelStrip() {
  try { scheduleChannels = await api.get('/api/channels'); } catch { scheduleChannels = []; }
  if (!scheduleChannels.length) return;
  // A remembered channel that has since been deleted (or nothing remembered)
  // falls back to the first one rather than loading every channel at once.
  if (!scheduleChannels.some((c) => c.id === currentScheduleChannel)) {
    currentScheduleChannel = scheduleChannels[0].id;
    localStorage.setItem(SCHEDULE_CHANNEL_KEY, String(currentScheduleChannel));
  }
  const strip = $('#channelStrip');
  strip.innerHTML = '';
  if (scheduleChannels.length <= 1) return; // no point showing a strip for a single channel
  for (const c of scheduleChannels) {
    const b = el('button', {
      className: `chip ${currentScheduleChannel === c.id ? 'active' : ''}`,
      textContent: c.name,
    });
    b.onclick = () => {
      currentScheduleChannel = c.id;
      localStorage.setItem(SCHEDULE_CHANNEL_KEY, String(c.id));
      loadSchedule();
    };
    strip.append(b);
  }
}

function scheduleChannelQuery() {
  return currentScheduleChannel != null ? `&channel_id=${currentScheduleChannel}` : '';
}

export async function loadSchedule() {
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
      const card = el('div', {
        className: `block-card ${b.fits ? 'fits' : 'misfit'}${b.overridden ? ' forced' : ''} ${b.status}`,
        tabIndex: 0,
      });
      card.append(el('div', { className: 'b-title', textContent: `${b.channel_name}: ${b.template_name}` }));
      const moved = b.start_shift || b.end_shift;
      card.append(el('div', {
        className: 'b-meta',
        textContent: `${moved ? `${b.effective_start.slice(0, 5)}–${b.effective_end.slice(0, 5)}` : `${b.start_time}–${b.end_time}`} · ${b.content_type}`,
      }));
      const badges = el('div', { className: 'b-badges' });
      // One badge, but the reason matters: "off 0:00" on a block whose duration
      // is perfect and whose filler run is half an hour reads as a bug.
      const why = b.fits ? 'fits'
        : !b.durationFits ? `off ${fmt(b.diff)}`
        : b.fillerFits === false ? `filler ${fmt(b.fillerRun)}`
        : `${b.offTypeCount} not movies`;
      badges.append(el('span', {
        className: `badge ${b.fits ? 'ok' : b.overridden ? 'warn' : 'bad'}`,
        textContent: b.overridden ? `forced · ${why}` : why,
      }));
      badges.append(el('span', { className: 'badge status', textContent: b.status }));
      if (b.is_mirror) badges.append(el('span', { className: 'badge', textContent: '🔁 repeat' }));
      if (moved) {
        badges.append(el('span', {
          className: 'badge warn',
          textContent: `⇆ ${[b.start_shift && `start ${fmtShift(b.start_shift)}`, b.end_shift && `end ${fmtShift(b.end_shift)}`].filter(Boolean).join(' · ')}`,
          title: `Slot ${b.start_time}–${b.end_time}, moved to ${b.effective_start}–${b.effective_end}`,
        }));
      }
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
// The channel strip filters the GRID, not these two: they are week-wide
// actions, and both covered every channel before the strip lost its "All"
// chip — generating one channel at a time would leave the other five empty
// without saying so, and the printable schedule is meant to be the combined
// document (which is also what the weeklyDraft cron generates).
$('#btnDownload').addEventListener('click', () => {
  // Printable schedule (fillers excluded), every channel in one document.
  const week = $('#weekStart').value || isoToday();
  window.open(`/api/blocks/export?week=${week}`, '_blank');
});
$('#btnGenerate').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', `/api/blocks/generate?weekStart=${$('#weekStart').value}`);
  const n = r.results?.length ?? 0;
  toast(`Generated ${n} draft block${n === 1 ? '' : 's'} across every channel`, 'ok', 'Drafts ready');
  await loadSchedule();
}));
$('#btnApproveWeek').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', `/api/blocks/approve-week?week=${$('#weekStart').value}`);
  const blocked = r.blocked.length;
  toast(`Approved ${r.approved.length} block${r.approved.length === 1 ? '' : 's'}` + (blocked ? `, ${blocked} still off tolerance` : ''),
        blocked ? 'info' : 'ok', 'Week approval');
  await loadSchedule();
}));
// ---- Push progress ---------------------------------------------------------
// A week push is thousands of sequential REST calls against 6 OTAV instances
// and can run for minutes. The operator gets the real step count, the clip
// currently going out, the elapsed time and a Cancel button, so a slow push is
// never indistinguishable from a wedged one.
function pushProgressDialog(title, { onCancel }) {
  $('#dialogTitle').textContent = title;
  const content = $('#dialogContent');
  content.innerHTML = '';

  const box = el('div', { className: 'push-progress' });
  const status = el('div', { className: 'pp-status', textContent: 'Starting…' });
  const bar = el('div', { className: 'pp-bar' });
  const fill = el('div', { className: 'pp-fill' });
  bar.append(fill);
  const counts = el('div', { className: 'pp-counts muted', textContent: 'waiting for the run plan…' });
  const log = el('ol', { className: 'pp-log' });
  box.append(status, bar, counts, log);
  content.append(box);

  const actions = $('#dialogActions');
  actions.innerHTML = '';
  const cancel = el('button', { className: 'danger', textContent: 'Cancel push' });
  cancel.onclick = async () => {
    cancel.disabled = true;
    cancel.textContent = 'Cancelling…';
    await onCancel();
  };
  actions.append(cancel);
  $('#dialog').classList.remove('hidden');

  const started = Date.now();
  let total = 0;         // clips in the whole run
  let done = 0;          // clips confirmed in OTAV
  let plan = null;
  let lastLine = null;

  const elapsed = () => {
    const s = Math.round((Date.now() - started) / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };
  const paint = () => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    fill.style.width = `${pct}%`;
    counts.textContent = plan
      ? `${done}/${total} clips · ${plan.channels} channel(s) · ${plan.days} day(s) · ${elapsed()} elapsed`
      : `${elapsed()} elapsed`;
  };
  const tick = setInterval(paint, 1000);

  const addLine = (text, kind = '') => {
    const li = el('li', { className: kind, textContent: text });
    log.append(li);
    while (log.children.length > 200) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  };

  return {
    update(ev) {
      if (ev.type === 'plan') { plan = ev; total = ev.clips; addLine(ev.message); }
      else if (ev.type === 'clip') {
        done++;
        status.textContent = `${ev.channel} ${ev.date} · clip ${ev.done}/${ev.total} — ${ev.name}`;
        // One line per day, rewritten in place: 3,000 clip lines help nobody.
        if (!lastLine || lastLine.key !== `${ev.channel}|${ev.date}`) {
          lastLine = { key: `${ev.channel}|${ev.date}`, li: el('li', {}) };
          log.append(lastLine.li);
          log.scrollTop = log.scrollHeight;
        }
        lastLine.li.textContent = `${ev.channel} ${ev.date} → ${ev.playlist}: ${ev.done}/${ev.total} clips`;
      } else if (ev.type === 'day-done') {
        lastLine = null;
        addLine(ev.message, ev.ok ? 'ok' : 'bad');
      } else if (ev.type === 'done') {
        status.textContent = ev.ok ? 'Push finished' : `Push failed: ${ev.error || 'see report'}`;
      } else if (ev.message) {
        status.textContent = ev.message;
        addLine(ev.message, ev.type === 'cancelling' ? 'bad' : '');
      }
      paint();
    },
    // The run blew up: keep what the log already showed and let the operator
    // read it, instead of yanking the dialog away behind an error toast.
    fail(message) {
      clearInterval(tick);
      status.textContent = `Push failed: ${message}`;
      addLine(message, 'bad');
      actions.innerHTML = '';
      const close = el('button', { className: 'primary', textContent: 'Close' });
      close.onclick = closeDialog;
      actions.append(close);
    },
    close() { clearInterval(tick); },
  };
}

// Which channels the last push targeted — the dialog reopens on that choice, so
// pushing the same subset day after day doesn't mean re-ticking it every time.
let lastPushChannels = null;

// Push confirmation + channel picker. Resolves to an array of channel ids, or
// null when the operator cancels. An empty selection is not a valid push, so
// the confirm button stays disabled until at least one instance is ticked.
async function pushChannelDialog(message, channels) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = 'Push to Air';
    const content = $('#dialogContent');
    content.innerHTML = '';
    content.append(el('p', { className: 'dialog-msg', textContent: message }));

    // First push of a session goes out to EVERY instance unless the operator
    // says otherwise. This used to fall back to the schedule grid's channel
    // when one was picked — which was fine while the grid defaulted to "all
    // channels", but the grid now always has one selected, and inheriting it
    // would silently narrow every first push to a single instance.
    const remembered = lastPushChannels && lastPushChannels.filter((id) => channels.some((c) => c.id === id));
    const preset = remembered && remembered.length ? remembered : channels.map((c) => c.id);
    const list = el('div', { className: 'push-channels' });
    const boxes = channels.map((c) => {
      const input = el('input', { type: 'checkbox', value: String(c.id) });
      input.checked = preset.includes(c.id);
      const row = el('label', { className: 'chk push-channel' }, input,
        el('span', { textContent: c.name }));
      list.append(row);
      return input;
    });
    const bulk = el('div', { className: 'push-channel-bulk' });
    const all = el('button', { className: 'ghost', type: 'button', textContent: 'All' });
    const none = el('button', { className: 'ghost', type: 'button', textContent: 'None' });
    bulk.append(all, none);
    content.append(bulk, list);

    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: 'danger', textContent: 'Push to Air' });
    const selected = () => boxes.filter((b) => b.checked).map((b) => Number(b.value));
    const sync = () => { ok.disabled = selected().length === 0; };
    for (const b of boxes) b.addEventListener('change', sync);
    all.onclick = () => { for (const b of boxes) b.checked = true; sync(); };
    none.onclick = () => { for (const b of boxes) b.checked = false; sync(); };
    cancel.onclick = () => { closeDialog(); resolve(null); };
    ok.onclick = () => {
      const ids = selected();
      if (!ids.length) return;
      lastPushChannels = ids;
      closeDialog();
      resolve(ids);
    };
    actions.append(cancel, ok);
    sync();
    $('#dialog').classList.remove('hidden');
    ok.focus();
  });
}

// A template repeating on several weekdays yields one block per date, and each
// date is its own playlist — so pushing a single day airs only that day.
async function pushToAir(btn, { scope }) {
  const day = $('#pushDate').value;
  const week = $('#weekStart').value;
  const what = scope === 'week' ? `the week starting ${week} (7 days)` : day;

  // Pushing rebuilds the day's playlist on every instance it touches, so the
  // operator chooses which instances this run is allowed to touch.
  let channels = scheduleChannels;
  if (!channels.length) {
    try { channels = scheduleChannels = await api.get('/api/channels'); } catch { channels = []; }
  }
  let query = scope === 'week' ? `week=${week}` : `date=${day}`;
  if (channels.length) {
    const picked = await pushChannelDialog(
      `This pushes all approved blocks for ${what} to the channels you select below.`, channels);
    if (!picked) return;
    if (picked.length < channels.length) query += `&channels=${picked.join(',')}`;
  } else {
    const ok = await confirmDialog('Push to Air',
      `This pushes all approved blocks for ${what} to the live OTAV instances. Continue?`,
      { confirmLabel: 'Push to Air', danger: true });
    if (!ok) return;
  }

  // A single-day push of TODAY rebuilds the playlist that is playing; the server
  // refuses it until the operator confirms (409 needsConfirm), and a week push
  // holds today back unless it is asked for explicitly.
  if (scope === 'day' && day === localToday()) {
    const ok = await confirmDialog('Push the day on air?',
      `${day} is on air right now. Pushing it rebuilds the playing playlist and cuts air for a few seconds. Push it anyway?`,
      { confirmLabel: 'Push today', danger: true });
    if (!ok) return;
    query += '&includeToday=1';
  }

  const job = `push-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await withBusy(btn, async () => {
    const ui = pushProgressDialog('Pushing to air', {
      onCancel: () => api.send('POST', `/api/otav/push/cancel?job=${job}`).catch(() => {}),
    });
    // The stream replays whatever the run already recorded, so opening it
    // alongside the POST cannot drop the first steps.
    const es = new EventSource(`/api/otav/push/events?job=${job}`);
    es.onmessage = (m) => { try { ui.update(JSON.parse(m.data)); } catch { /* ignore */ } };
    es.onerror = () => {};
    let r;
    try {
      r = await api.send('POST', `/api/otav/push?${query}&job=${job}`);
    } catch (e) {
      es.close();
      ui.close();
      // Refusals that come with a list: show the list, not just the headline.
      if (e.data?.missing?.length) {
        reportDialog('Files missing from disk', e.data.missing.map((m) => ({
          name: m.file_path,
          ok: false,
          detail: `${fmt(m.seconds)} of air · ${m.blocks.map((b) => `${b.target_date} ${b.template_name}`).join(', ')}`,
        })));
        return;
      }
      if (e.data?.blocks?.length) {
        reportDialog('Blocks that cannot go to air', e.data.blocks.map((b) => ({
          name: `${b.target_date} · ${b.template_name}`, ok: false, detail: b.reason,
        })));
        return;
      }
      ui.fail(e.message || String(e));
      throw e;
    } finally {
      es.close();
      ui.close();
    }
    reportDialog('Push report', r.channels.map((c) => ({
      name: c.date ? `${c.date} · ${c.channel}` : c.channel,
      ok: c.ok,
      detail: c.ok
        ? `${c.pushed} clips → “${c.playlist}” (${{
            prepared: 'file written + event upserted', created: 'created', open: 'reused',
            schedule: 'opened from schedule', fallback: 'fallback playlist',
          }[c.source] || c.source || 'ok'})${c.logo ? ` · logo ${c.logo}` : ''}`
          + `${c.warning ? ` — ${c.warning}` : ''}${c.logo_warning ? ` — ${c.logo_warning}` : ''}`
        : c.error,
    })));
    const failed = r.channels.filter((c) => !c.ok).length;
    const skipped = (r.skipped || []).length;
    if ((r.held || []).length) {
      toast(`${r.held.join(', ')} is on air and was not pushed. Push that day on its own to rebuild it.`,
        'info', 'Today held back');
    }
    if (r.aborted) {
      toast(r.aborted.reason === 'cancelled'
        ? 'Push cancelled — the days already listed as pushed did go out'
        : `Push stopped on its deadline: ${r.aborted.error}`, 'bad', 'Push stopped');
    } else {
      toast(failed ? `${failed} push(es) failed`
            : `${r.channels.length} pushed${skipped ? `, ${skipped} day(s) had nothing approved` : ''}`,
            failed ? 'bad' : 'ok', 'Push complete');
    }
    await loadSchedule();
  });
}

$('#btnPush').addEventListener('click', (e) => pushToAir(e.currentTarget, { scope: 'day' }));
$('#btnPushWeek').addEventListener('click', (e) => pushToAir(e.currentTarget, { scope: 'week' }));


/** Setter for modules that assign it (an imported binding is read-only). */
export function set_scheduleChannels(v) { scheduleChannels = v; return v; }
