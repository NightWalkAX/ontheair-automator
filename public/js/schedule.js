import { fmtShift, openBlock } from './block.js';
import {
  $, api, closeDialog, confirmDialog, el, fmt, getChannels, localToday, reportDialog, scopeDialog, toast, withBusy,
} from './core.js';

// ---- Schedule Review -------------------------------------------------------
// The grid shows ONE channel at a time (the chip strip, remembered like the
// theme). Every action in the toolbar asks which channels it applies to: the one
// on screen, or that one plus others — it used to act on every channel while
// showing one, which only a tooltip admitted.
const isoToday = () => localToday();
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return localToday(x); };
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

const SCHEDULE_CHANNEL_KEY = 'otav.scheduleChannel';
export let scheduleChannels = [];
let currentScheduleChannel = Number(localStorage.getItem(SCHEDULE_CHANNEL_KEY)) || null;

/** The channel on screen. */
export function currentChannelId() { return currentScheduleChannel; }

async function renderChannelStrip() {
  try { scheduleChannels = await getChannels(); } catch { scheduleChannels = []; }
  if (!scheduleChannels.length) return;
  // A remembered channel that has since been deleted (or nothing remembered)
  // falls back to the first active one.
  if (!scheduleChannels.some((c) => c.id === currentScheduleChannel)) {
    currentScheduleChannel = (scheduleChannels.find((c) => c.is_active) || scheduleChannels[0]).id;
    localStorage.setItem(SCHEDULE_CHANNEL_KEY, String(currentScheduleChannel));
  }
  const strip = $('#channelStrip');
  strip.innerHTML = '';
  if (scheduleChannels.length <= 1) return;
  for (const c of scheduleChannels) {
    const b = el('button', {
      className: `chip ${currentScheduleChannel === c.id ? 'active' : ''}${c.is_active ? '' : ' inactive'}`,
      textContent: c.name,
      title: c.is_active ? '' : 'Inactive channel',
    });
    b.onclick = () => {
      if (currentScheduleChannel === c.id) return;
      currentScheduleChannel = c.id;
      localStorage.setItem(SCHEDULE_CHANNEL_KEY, String(c.id));
      for (const x of strip.children) x.classList.toggle('active', x === b);
      loadSchedule({ strip: false });
    };
    strip.append(b);
  }
}

const weekValue = () => $('#weekStart').value || isoToday();

// Cards by block id, so an action on one block repaints that card instead of
// rebuilding the week.
const cards = new Map();
let gridToken = 0;

export async function loadSchedule({ strip = true } = {}) {
  const token = ++gridToken; // a slow answer for a channel no longer on screen is dropped
  showGridSkeleton();
  if (strip || !scheduleChannels.length) await renderChannelStrip();
  let data;
  try {
    data = await api.get(`/api/blocks?week=${weekValue()}&channel_id=${currentScheduleChannel}`);
  } catch (e) {
    if (token !== gridToken) return;
    $('#scheduleGrid').innerHTML = '';
    $('#scheduleGrid').append(emptyState('⚠️', 'Could not load schedule', e.message));
    return;
  }
  if (token !== gridToken) return;
  const { week: dates, blocks } = data;
  const grid = $('#scheduleGrid');
  grid.innerHTML = '';
  cards.clear();
  loadWeekHealth(dates[0]);

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
    col.dataset.date = d;
    const dow = dObj.toLocaleDateString(undefined, { weekday: 'short' });
    const head = el('div', { className: `day-head ${d === today ? 'today' : ''}` });
    head.append(el('span', { textContent: dow }), el('small', { textContent: d.slice(5) }));
    col.append(head);

    const dayBlocks = byDate[d] || [];
    if (!dayBlocks.length) {
      col.append(el('div', { className: 'muted', style: 'font-size:11.5px;padding:6px', textContent: '—' }));
    }
    for (const b of dayBlocks) col.append(blockCard(b));
    grid.append(col);
  }
}

/** One block's card. Kept in `cards` so updateCard() can swap it in place. */
function blockCard(b) {
  const card = el('div', {
    className: `block-card ${b.fits ? 'fits' : 'misfit'}${b.overridden ? ' forced' : ''} ${b.status}`,
    tabIndex: 0,
  });
  card.dataset.id = b.id;
  const moved = b.start_shift || b.end_shift || b.extend_seconds;
  const top = el('div', { className: 'b-top' });
  top.append(el('span', { className: 'b-time', textContent: moved
    ? `${b.effective_start.slice(0, 5)}–${b.effective_end.slice(0, 5)}`
    : `${b.start_time}–${b.end_time}` }));
  top.append(el('span', { className: `b-status s-${b.status}`, textContent: b.status === 'exported' ? 'on OTAV' : b.status }));
  card.append(top);
  card.append(el('div', { className: 'b-title', textContent: b.template_name }));
  const badges = el('div', { className: 'b-badges' });
  // One verdict, but the reason matters: "off 0:00" on a block whose duration is
  // perfect and whose filler run is half an hour reads as a bug.
  const why = b.fits ? 'fits'
    : !b.durationFits ? `off ${fmt(b.diff)}`
    : b.fillerFits === false ? `filler ${fmt(b.fillerRun)}`
    : `${b.offTypeCount} not movies`;
  badges.append(el('span', {
    className: `badge ${b.fits ? 'ok' : b.overridden ? 'warn' : 'bad'}`,
    textContent: b.overridden ? `forced · ${why}` : why,
  }));
  if (b.is_mirror) badges.append(el('span', { className: 'badge', textContent: '🔁 repeat', title: 'Copies the first airing of this template that day' }));
  if (b.start_shift || b.end_shift) {
    const auto = Number(b.end_shift_auto) === 1;
    badges.append(el('span', {
      className: `badge ${auto ? 'info' : 'warn'}`,
      textContent: `↔ ${[b.start_shift && `start ${fmtShift(b.start_shift)}`, b.end_shift && `end ${fmtShift(b.end_shift)}`].filter(Boolean).join(' · ')}`,
      title: `Slot ${b.start_time}–${b.end_time}, airs ${b.effective_start}–${b.effective_end}${auto ? ' (moved automatically)' : ''}`,
    }));
  }
  if (b.extend_seconds) {
    badges.append(el('span', {
      className: 'badge info',
      textContent: `⤓ +${fmtShift(b.extend_seconds).replace('+', '')}`,
      title: `Nothing is scheduled after this block until ${b.effective_end}, so it covers that time too`,
    }));
  }
  if (b.overlap_seconds) {
    badges.append(el('span', { className: 'badge bad', textContent: '⚠ overlap', title: 'Another block claims the same time — fix the templates' }));
  }
  card.append(badges);
  card.addEventListener('click', () => openBlock(b.id));
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBlock(b.id); } });
  cards.set(b.id, card);
  return card;
}

/**
 * Repaint some cards from the server without rebuilding the week (after an
 * approve, a force, a shift). Shifts move neighbours too, so the caller passes
 * every id it touched; the week health strip is refreshed with them.
 */
export async function refreshCards(ids = []) {
  const wanted = ids.filter((id) => cards.has(id));
  if (!wanted.length) return loadSchedule({ strip: false });
  try {
    const { blocks } = await api.get(`/api/blocks?week=${weekValue()}&channel_id=${currentScheduleChannel}`);
    for (const b of blocks) {
      const old = cards.get(b.id);
      // Neighbours of a moved boundary change as well: repaint every card whose
      // window or verdict differs, not just the ones asked for.
      if (old) old.replaceWith(blockCard(b));
    }
  } catch { return loadSchedule({ strip: false }); }
  loadWeekHealth(weekValue());
}

function emptyState(icon, title, hint) {
  const box = el('div', { className: 'empty' });
  box.append(el('div', { className: 'icon', textContent: icon }));
  box.append(el('p', { textContent: title }));
  if (hint) box.append(el('p', { className: 'hint muted', textContent: hint }));
  return box;
}

// ---- Week health ("no black screens") ------------------------------------------
// One cell per day for the channel on screen: does what a push would send
// reach the next day's event? The full list is a click away.
let healthToken = 0;
const KIND_LABEL = {
  'not-generated': 'not generated', 'missing-blocks': 'blocks missing', draft: 'draft (left out of a push)',
  overlap: 'overlapping blocks', unfit: 'off tolerance', 'missing-file': 'file missing', black: 'black at end of day',
  overrun: 'runs into next day', 'next-unknown': 'next day not scheduled',
};
async function loadWeekHealth(week) {
  const token = ++healthToken;
  const box = $('#weekHealth');
  box.classList.add('loading');
  let rep;
  try {
    rep = await api.get(`/api/blocks/week-check?week=${week}&channels=${currentScheduleChannel}`);
  } catch (e) {
    if (token === healthToken) { box.classList.remove('loading'); box.textContent = ''; }
    return;
  }
  if (token !== healthToken) return;
  box.classList.remove('loading');
  renderHealth(box, rep);
}

function renderHealth(box, rep) {
  box.innerHTML = '';
  const ch = rep.channels[0];
  if (!ch) return;
  box.append(el('span', { className: 'wh-label', textContent: 'Air check' }));
  for (const d of ch.days) {
    const blocking = d.problems.filter((p) => p.blocking);
    const warn = d.problems.filter((p) => !p.blocking);
    const black = d.problems.find((p) => p.kind === 'black' || p.kind === 'overrun');
    const cell = el('button', {
      className: `wh-day ${blocking.length ? 'bad' : warn.length ? 'warn' : 'ok'}`,
      type: 'button',
    });
    const dow = new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
    cell.append(el('strong', { textContent: dow }));
    cell.append(el('span', {
      textContent: !d.problems.length ? `✓ ends ${String(d.playlistEnd || '').slice(0, 5)}`
        : black ? `${black.kind === 'black' ? '⬛' : '⏩'} ${fmt(black.seconds)}`
        : blocking.length ? `⚠ ${blocking.length}` : `• ${warn.length}`,
    }));
    cell.title = d.problems.map((p) => `${KIND_LABEL[p.kind] || p.kind}: ${p.message}`).join('\n') || 'Covers the whole day';
    cell.onclick = () => showDayProblems(ch.name, d);
    box.append(cell);
  }
}

function showDayProblems(channelName, d) {
  const rows = d.problems.length ? d.problems.map((p) => ({
    name: KIND_LABEL[p.kind] || p.kind, ok: !p.blocking, detail: p.message,
  })) : [{ name: 'Covers the whole day', ok: true, detail: `playlist ${d.playlistStart || '—'} → ${d.playlistEnd || '—'}` }];
  reportDialog(`${channelName} · ${d.date}${d.playlistEnd ? ` · ends ${d.playlistEnd}` : ''}`, rows);
}

// ---- Toolbar ---------------------------------------------------------------------
$('#btnReload').addEventListener('click', (e) => withBusy(e.currentTarget, () => loadSchedule()));
$('#btnPrevWeek').addEventListener('click', () => { $('#weekStart').value = addDays(weekValue(), -7); loadSchedule({ strip: false }); });
$('#btnNextWeek').addEventListener('click', () => { $('#weekStart').value = addDays(weekValue(), 7); loadSchedule({ strip: false }); });
$('#btnThisWeek').addEventListener('click', () => { $('#weekStart').value = isoToday(); loadSchedule({ strip: false }); });
$('#weekStart').addEventListener('change', () => loadSchedule({ strip: false }));

/** Ask which channels an action covers. Null = cancelled. */
async function pickScope(action, title, message, opts = {}) {
  const channels = (await getChannels()).filter((c) => c.is_active || c.id === currentScheduleChannel);
  return scopeDialog({ title, message, action, current: currentScheduleChannel, channels, ...opts });
}
const namesOf = (ids) => ids.map((id) => scheduleChannels.find((c) => c.id === id)?.name ?? `#${id}`).join(', ');

$('#btnDownload').addEventListener('click', async () => {
  const ids = await pickScope('download', 'Download schedule', `Printable schedule for the week of ${weekValue()} (fillers left out).`, { confirmLabel: 'Open' });
  if (!ids) return;
  window.open(`/api/blocks/export?week=${weekValue()}&channels=${ids.join(',')}`, '_blank');
});
$('#btnGenerate').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ids = await pickScope('generate', 'Generate drafts',
    `Rebuilds every DRAFT block of the week of ${weekValue()} from the templates. Approved and pushed blocks are kept; drafts you edited by hand are rebuilt.`,
    { confirmLabel: 'Generate', danger: true });
  if (!ids) return;
  await withBusy(btn, async () => {
    const r = await api.send('POST', `/api/blocks/generate?weekStart=${weekValue()}&channels=${ids.join(',')}`);
    const n = r.results?.length ?? 0;
    toast(`Generated ${n} draft block${n === 1 ? '' : 's'} on ${namesOf(ids)}`, 'ok', 'Drafts ready');
    await loadSchedule({ strip: false });
  }).catch(() => {}); // withBusy already showed the error
});
$('#btnApproveWeek').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ids = await pickScope('approve-week', 'Approve fitting drafts',
    `Approves every draft of the week of ${weekValue()} that passes the rules (or is forced).`, { confirmLabel: 'Approve' });
  if (!ids) return;
  await withBusy(btn, async () => {
    const r = await api.send('POST', `/api/blocks/approve-week?week=${weekValue()}&channels=${ids.join(',')}`);
    const blocked = r.blocked.length;
    toast(`Approved ${r.approved.length} block${r.approved.length === 1 ? '' : 's'} on ${namesOf(ids)}`
      + (blocked ? `, ${blocked} still off tolerance` : ''), blocked ? 'info' : 'ok', 'Week approval');
    await loadSchedule({ strip: false });
  }).catch(() => {}); // withBusy already showed the error
});
$('#btnCheckWeek').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ids = await pickScope('check-week', 'Check the week for black',
    'Simulates what a push sends for each day and reports anything that would make a channel end its day early — or run into the next one.',
    { confirmLabel: 'Check' });
  if (!ids) return;
  await withBusy(btn, async () => {
    const rep = await api.get(`/api/blocks/week-check?week=${weekValue()}&channels=${ids.join(',')}`);
    const rows = [];
    for (const c of rep.channels) {
      for (const d of c.days) {
        const blocking = d.problems.filter((p) => p.blocking);
        rows.push({
          name: `${c.name} · ${d.date}`,
          ok: !blocking.length,
          detail: blocking.length
            ? blocking.map((p) => p.message).join(' · ')
            : d.problems.length ? d.problems.map((p) => p.message).join(' · ')
            : `covers the day · ends ${d.playlistEnd}`,
        });
      }
    }
    reportDialog(rep.ok ? 'No black on air this week' : 'Days that would end early (or late)', rows);
  }).catch(() => {}); // withBusy already showed the error
});
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

// A template repeating on several weekdays yields one block per date, and each
// date is its own playlist — so pushing a single day airs only that day.
async function pushToAir(btn, { scope }) {
  const day = $('#pushDate').value;
  const week = $('#weekStart').value;
  const what = scope === 'week' ? `the week starting ${week} (7 days)` : day;

  // Pushing rebuilds the day's playlist on every instance it touches, so the
  // operator chooses which instances this run is allowed to touch — the channel
  // on screen, or that one + others, like every other action.
  const picked = await pickScope(`push-${scope}`, 'Push to Air',
    `Pushes every approved block of ${what} to air: each OTAV day's playlist is rebuilt, and the analog device's weekdays are replaced (today to six days ahead).`
    + (scope === 'week' ? ' Today is on air and is held back; push it on its own if it must change.' : ''),
    { confirmLabel: 'Push to Air', danger: true });
  if (!picked) return;
  let query = `${scope === 'week' ? `week=${week}` : `date=${day}`}&channels=${picked.join(',')}`;

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
  return runPush(btn, query, { scope });
}

/** Run one push with live progress; `query` is the complete push query. */
async function runPush(btn, query, { scope }) {
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
      // Clips the analog device doesn't have yet: list them and offer the upload
      // (it runs in the background; the Analog tab shows its progress).
      if (e.data?.analogMissing?.length) {
        reportDialog('Files not on the analog device yet', e.data.analogMissing.map((m) => ({
          name: m.file_path,
          ok: false,
          detail: m.state === 'unsupported'
            ? 'container the device does not play — convert it in Air Spec first'
            : `uploads as ${m.device_filename}`,
        })));
        const paths = e.data.analogMissing.filter((m) => m.state === 'missing').map((m) => m.file_path);
        if (paths.length) {
          const up = el('button', { className: 'primary', textContent: `Upload ${paths.length} file(s) now` });
          up.onclick = () => withBusy(up, async () => {
            await api.send('POST', '/api/analog/upload', { paths });
            closeDialog();
            toast('Uploading in the background — follow it on the Analog tab, then push again.', 'info', 'Analog');
          }).catch(() => {});
          $('#dialogActions').prepend(up);
        }
        return;
      }
      // Refusals that come with a list: show the list, not just the headline.
      if (e.data?.missing?.length) {
        reportDialog('Files missing from disk', e.data.missing.map((m) => ({
          name: m.file_path,
          ok: false,
          detail: `${fmt(m.seconds)} of air · ${m.blocks.map((b) => `${b.target_date} ${b.template_name}`).join(', ')}`,
        })));
        return;
      }
      // Days that would end early: show why, and let the operator push anyway.
      if (e.data?.gaps && e.data.problems?.length) {
        reportDialog('This push would leave black on air', e.data.problems.map((p) => ({
          name: `${p.channel} · ${p.date}`, ok: false, detail: p.message,
        })));
        const actions = $('#dialogActions');
        const anyway = el('button', { className: 'danger', textContent: 'Push anyway' });
        anyway.onclick = () => { closeDialog(); runPush(btn, `${query}&allowGaps=1`, { scope }); };
        actions.prepend(anyway);
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
            analog: 'replaced and published',
          }[c.source] || c.source || 'ok'})${c.logo ? ` · logo ${c.logo}` : ''}`
          + `${c.warning ? ` — ${c.warning}` : ''}${c.logo_warning ? ` — ${c.logo_warning}` : ''}`
        : c.error,
    })));
    const failed = r.channels.filter((c) => !c.ok).length;
    const skipped = (r.skipped || []).length;
    for (const h of r.analog?.held || []) {
      if (!(r.held || []).includes(h.date)) toast(`${h.date}: ${h.reason}`, 'info', 'Analog not pushed');
    }
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
  }).catch(() => {}); // withBusy already showed the error
}

$('#btnPush').addEventListener('click', (e) => pushToAir(e.currentTarget, { scope: 'day' }));
$('#btnPushWeek').addEventListener('click', (e) => pushToAir(e.currentTarget, { scope: 'week' }));


/** Setter for modules that assign it (an imported binding is read-only). */
export function set_scheduleChannels(v) { scheduleChannels = v; return v; }
