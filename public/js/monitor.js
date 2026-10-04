import { $, $$, api, el, fmt, toast, withBusy } from './core.js';

// ---- Signal Monitor ----------------------------------------------------------
// The feeds are watched on the server whether or not this tab is open; the tab
// only shows what the server sees (state + the last tiny frame of each feed)
// and edits the settings. Polled, not streamed: once every few seconds is as
// fast as a frame arrives anyway.

const MON_STATE = {
  ok: 'OK', dimming: 'going dark', black: 'BLACK', frozen: 'FROZEN', down: 'NO SIGNAL', resyncing: 'resync sent…',
  starting: 'connecting…', disabled: 'off', off: 'monitor off',
};
const MON_KIND = { black: 'Black', frozen: 'Frozen', down: 'No signal', silent: 'Silent' };
const MON_AUDIO = { ok: 'sound', quiet: 'going quiet', silent: 'SILENT', starting: 'connecting…', off: 'not watched', disabled: 'off' };
const monTrouble = (s) => ['black', 'down', 'frozen', 'resyncing'].includes(s.state) || s.audio?.state === 'silent';
let monFeeds = [];
let monChannels = [];
let monTimer = null;

const monAgo = (iso) => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
};
const monTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' }) : '');

function monDrawFrame(canvas, b64, w, h) {
  const ctx = canvas.getContext('2d');
  if (!b64) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  const gray = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < gray.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = gray[i];
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function renderMonStatus(st) {
  $('#monEnabled').checked = st.enabled;
  const bad = st.sources.filter(monTrouble);
  $('#monNavDot').hidden = !bad.length;
  const watching = st.sources.filter((s) => s.enabled).length;
  $('#monSummary').textContent = !st.enabled
    ? 'Off — nothing is being watched and no e-mail will be sent.'
    : bad.length ? `${bad.length} of ${watching} feed(s) in trouble: ${bad.map((s) => s.name).join(', ')}`
      : `Watching ${watching} feed(s)${st.startedAt ? ` since ${monTime(st.startedAt)}` : ''}.`;
  const mail = $('#monEmailState');
  mail.className = `tx-badge ${st.email.problem ? 'st-dimming' : 'st-ok'}`;
  mail.textContent = st.email.problem ? `✉ e-mail off: ${st.email.problem}`
    : st.email.onShift ? `✉ alerts go to whoever is on shift (${st.email.recipients})`
      : `✉ alerts go to ${st.email.recipients} address(es)`;
  mail.title = st.email.note || '';

  const grid = $('#monGrid');
  grid.innerHTML = '';
  for (const s of st.sources) {
    const worst = s.state === 'ok' && s.audio?.state === 'silent' ? 'silent' : s.state;
    const card = el('div', { className: `mon-card st-${worst}` });
    const canvas = el('canvas', { width: st.frame.width, height: st.frame.height });
    monDrawFrame(canvas, s.frame, st.frame.width, st.frame.height);
    const body = el('div', { className: 'mon-body' });
    const name = el('div', { className: 'mon-name' }, s.name);
    name.append(el('span', { className: `tx-badge st-${s.state}`, textContent: MON_STATE[s.state] || s.state }));
    body.append(name);
    if (s.incident) {
      body.append(el('div', { className: 'mon-meta', textContent: `since ${monTime(s.incident.startedAt)} (${monAgo(s.incident.startedAt)})` }));
      if (s.incident.resync) body.append(el('div', { className: 'mon-meta', textContent: s.incident.resync }));
    }
    if (s.luma !== null && s.luma !== undefined) {
      body.append(el('div', {
        className: 'mon-meta',
        textContent: `brightness ${s.luma} · ${s.brightPct}% lit · last frame ${monAgo(s.lastFrameAt)}`,
      }));
    }
    if (s.audio && s.audio.state !== 'disabled') {
      const a = el('div', { className: 'mon-meta mon-audio' });
      a.append(el('span', { className: `tx-badge st-${s.audio.state === 'silent' ? 'black' : s.audio.state === 'quiet' ? 'dimming' : s.audio.state}`, textContent: `♪ ${MON_AUDIO[s.audio.state] || s.audio.state}` }));
      if (s.audio.db !== null && s.audio.db !== undefined) a.append(` ${s.audio.db <= -120 ? 'digital silence' : `${s.audio.db} dB`}`);
      if (s.audio.incident) a.append(` · since ${monTime(s.audio.incident.startedAt)}${s.audio.incident.detail ? ` (${s.audio.incident.detail})` : ''}`);
      body.append(a);
      if (s.audio.error) body.append(el('div', { className: 'mon-err', textContent: `audio: ${s.audio.error}` }));
    }
    const ch = monChannels.find((c) => c.id === s.channelId);
    if (ch) body.append(el('div', { className: 'mon-meta', textContent: `OTAV: ${ch.name}` }));
    if (s.error) body.append(el('div', { className: 'mon-err', textContent: s.error }));
    card.append(canvas, body);
    grid.append(card);
  }
}

function renderMonEvents(events) {
  const tb = $('#monEventsTable tbody');
  tb.innerHTML = '';
  if (!events.length) {
    tb.append(el('tr', {}, el('td', { colSpan: 8, className: 'muted', textContent: 'Nothing yet.' })));
    return;
  }
  for (const e of events) {
    const end = e.ended_at ? Date.parse(e.ended_at) : Date.now();
    const lasted = fmt((end - Date.parse(e.started_at)) / 1000);
    const tr = el('tr');
    tr.append(
      el('td', { textContent: e.source_name }),
      el('td', {}, el('span', { className: `tx-badge st-${e.ended_at ? 'dimming' : e.kind}`, textContent: MON_KIND[e.kind] || e.kind })),
      el('td', { textContent: monTime(e.started_at) }),
      el('td', { textContent: e.ended_at ? monTime(e.ended_at) : 'still going' }),
      el('td', { textContent: lasted + (e.note ? ` (${e.note})` : '') }),
      el('td', { className: 'muted', textContent: e.resync || '' }),
      el('td', { className: 'path-cell', textContent: e.on_air || '' }),
      el('td', { className: e.email_error ? 'tx-err' : 'muted', textContent: e.email_error || (e.emailed ? `sent ×${e.emailed}` : '') }),
    );
    tb.append(tr);
  }
}

function renderMonFeeds() {
  const tb = $('#monFeedsTable tbody');
  tb.innerHTML = '';
  monFeeds.forEach((f, i) => {
    const on = el('input', { type: 'checkbox', checked: f.enabled });
    on.onchange = () => { f.enabled = on.checked; };
    const name = el('input', { value: f.name, placeholder: 'GLC Discover' });
    name.oninput = () => { f.name = name.value; };
    const url = el('input', { value: f.url, placeholder: 'http://…/stream.m3u8' });
    url.oninput = () => { f.url = url.value; };
    const ch = el('select');
    ch.append(el('option', { value: '', textContent: '— none —' }));
    for (const c of monChannels) ch.append(el('option', { value: String(c.id), textContent: c.name }));
    ch.value = f.channelId ? String(f.channelId) : '';
    ch.onchange = () => { f.channelId = ch.value ? Number(ch.value) : null; };
    const del = el('button', { type: 'button', className: 'mini ghost', textContent: 'Remove' });
    del.onclick = () => { monFeeds.splice(i, 1); renderMonFeeds(); };
    tb.append(el('tr', {}, el('td', {}, on), el('td', {}, name), el('td', { className: 'url-cell' }, url), el('td', {}, ch), el('td', {}, del)));
  });
}

async function refreshMonitor() {
  try {
    const [st, ev] = await Promise.all([api.get('/api/monitor/status'), api.get('/api/monitor/events?limit=30')]);
    renderMonStatus(st);
    renderMonEvents(ev.events);
  } catch { /* the next poll will try again */ }
}

export async function loadMonitorTab() {
  try { monChannels = await api.get('/api/channels'); } catch { monChannels = []; }
  const { monitor, email } = await api.get('/api/monitor/config');
  monFeeds = monitor.sources.map((s) => ({ ...s }));
  renderMonFeeds();
  const ef = $('#monEmailForm');
  ef.recipients.value = email.recipients.join('\n');
  ef.user.value = email.user;
  ef.fromName.value = email.fromName;
  ef.appPassword.value = '';
  ef.appPassword.placeholder = email.hasPassword ? '•••• saved — leave empty to keep' : '16 letters from Google';
  const rf = $('#monRulesForm');
  rf.blackAfter.value = monitor.black.alertAfterSeconds;
  rf.blackRecover.value = monitor.black.recoverAfterSeconds;
  rf.maxLuma.value = monitor.black.maxLuma;
  rf.maxBrightPct.value = monitor.black.maxBrightPct;
  rf.downAfter.value = monitor.down.alertAfterSeconds;
  rf.repeatMinutes.value = monitor.repeatMinutes;
  rf.freezeEnabled.checked = monitor.freeze.enabled;
  rf.silenceEnabled.checked = monitor.silence.enabled;
  rf.silenceDb.value = monitor.silence.thresholdDb;
  rf.silenceAfter.value = monitor.silence.alertAfterSeconds;
  rf.freezeAfter.value = monitor.freeze.alertAfterSeconds;
  rf.resyncEnabled.checked = monitor.resync.enabled;
  rf.resyncWait.value = monitor.resync.waitSeconds;
  rf.resyncCooldown.value = monitor.resync.cooldownMinutes;
  rf.resyncEmailFixed.checked = monitor.resync.emailWhenFixed;
  const ro = $('#rosterRules');
  ro.routeAlerts.checked = monitor.roster.routeAlerts;
  ro.notify.checked = monitor.roster.notify;
  ro.leadMinutes.value = monitor.roster.leadMinutes;
  await Promise.all([refreshMonitor(), loadRoster()]);
}

// ---- Shift roster ------------------------------------------------------------
// The shift spreadsheet, imported as codes (A, B, C…). The operator gives each
// code a name and an e-mail; alerts go to whoever is on shift.

const rosterWhen = (iso) => new Date(iso).toLocaleString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});
const rosterClock = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

async function loadRoster() {
  const r = await api.get('/api/monitor/roster');
  const range = r.range || {};
  $('#rosterSummary').textContent = range.shifts
    ? `${range.shifts} shifts loaded, ${range.from} → ${range.to}. Times are this Mac's clock. Import the sheet again whenever it changes: names and e-mails stay with their code.`
    : 'No roster loaded: every alert goes to the whole list. Import the shift spreadsheet to send alerts only to whoever is on shift.';

  const now = $('#rosterNow');
  now.innerHTML = '';
  if (range.shifts) {
    now.append(el('strong', { textContent: 'On shift now:' }));
    if (!r.onShift.length) now.append(el('span', { className: 'tx-badge st-dimming', textContent: 'nobody (alerts go to the whole list)' }));
    for (const s of r.onShift) {
      now.append(el('span', {
        className: `tx-badge ${s.hasEmail ? 'st-ok' : 'st-dimming'}`,
        textContent: `${s.who} · ${s.label} until ${rosterClock(s.endsAt)}${s.hasEmail ? '' : ' (no e-mail!)'}`,
      }));
    }
  }

  const pb = $('#rosterPeople tbody');
  pb.innerHTML = '';
  if (!r.people.length) pb.append(el('tr', {}, el('td', { colSpan: 4, className: 'muted', textContent: 'Import the shift sheet first.' })));
  for (const p of r.people) {
    const name = el('input', { value: p.name || '', placeholder: p.sheetName });
    const email = el('input', { type: 'email', value: p.email || '', placeholder: 'name@example.gy' });
    const tr = el('tr', {}, el('td', {}, el('strong', { textContent: p.code })), el('td', { className: 'muted', textContent: p.sheetName }),
      el('td', {}, name), el('td', {}, email));
    tr.dataset.code = p.code;
    pb.append(tr);
  }

  const ub = $('#rosterUpcoming tbody');
  ub.innerHTML = '';
  if (!r.upcoming.length) ub.append(el('tr', {}, el('td', { colSpan: 4, className: 'muted', textContent: range.shifts ? 'No more shifts in the sheet — import the next one.' : '' })));
  const t = Date.now();
  for (const s of r.upcoming) {
    const current = Date.parse(s.startsAt) <= t;
    const notes = [s.startNoticeAt ? `start ✓ ${rosterClock(s.startNoticeAt)}` : '', s.endNoticeAt ? `end ✓ ${rosterClock(s.endNoticeAt)}` : '']
      .filter(Boolean).join(' · ');
    const tr = el('tr', { className: current ? 'roster-current' : '' },
      el('td', { textContent: `${rosterWhen(s.startsAt)} → ${rosterClock(s.endsAt)}` }),
      el('td', { textContent: s.label + (s.location ? ` (${s.location})` : '') }),
      el('td', { textContent: s.who + (s.hasEmail ? '' : ' · no e-mail') }),
      el('td', { className: s.noticeError ? 'tx-err' : 'muted', textContent: s.noticeError || notes }));
    ub.append(tr);
  }
}

$('#rosterImportBtn').addEventListener('click', () => $('#rosterFile').click());
$('#rosterFile').addEventListener('change', async (e) => {
  const file = e.currentTarget.files[0];
  e.currentTarget.value = '';
  if (!file) return;
  try {
    const r = await fetch('/api/monitor/roster/import', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await file.arrayBuffer(),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.status);
    const added = data.added.length ? ` New codes: ${data.added.map((p) => `${p.code} = ${p.sheetName}`).join(', ')}.` : '';
    toast(`${data.shifts} shifts, ${data.from} → ${data.to}.${added}`, 'ok', 'Roster imported');
    await loadRoster();
  } catch (err) {
    toast(err.message, 'bad', 'Import failed');
  }
});

$('#rosterSavePeople').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const people = $$('#rosterPeople tbody tr[data-code]').map((tr) => {
    const [name, email] = $$('input', tr);
    return { code: tr.dataset.code, name: name.value, email: email.value };
  });
  await api.send('PUT', '/api/monitor/roster/people', { people });
  toast('Names and e-mails saved', 'ok');
  await Promise.all([loadRoster(), refreshMonitor()]);
}).catch(() => {}));

$('#rosterRules').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  return withBusy(f.querySelector('button[type="submit"]'), async () => {
    await api.send('PUT', '/api/monitor/config', {
      roster: { routeAlerts: f.routeAlerts.checked, notify: f.notify.checked, leadMinutes: Number(f.leadMinutes.value) },
    });
    toast('Roster settings saved', 'ok');
    await loadMonitorTab();
  }).catch(() => {});
});

// Poll fast while the tab is open, slowly otherwise — the red dot on the tab
// button is how an alert is noticed from another tab of the UI.
// Nothing at all while the browser tab is hidden: a background tab polling
// every few seconds is load on the server for nobody to see; it catches up the
// moment the tab is shown again.
export function scheduleMonitorPoll() {
  clearTimeout(monTimer);
  if (document.hidden) return;
  const open = $('#tab-monitor').classList.contains('active');
  monTimer = setTimeout(async () => {
    if (document.hidden) return;
    if (open) await refreshMonitor();
    else {
      try {
        const st = await api.get('/api/monitor/status');
        $('#monNavDot').hidden = !st.sources.some(monTrouble);
      } catch { /* ignore */ }
    }
    scheduleMonitorPoll();
  }, open ? 3000 : 30000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleMonitorPoll(); });
scheduleMonitorPoll();

$('#monEnabled').addEventListener('change', async (e) => {
  const on = e.currentTarget.checked;
  try {
    await api.send('PUT', '/api/monitor/config', { enabled: on });
    toast(on ? 'Monitor on — connecting to the feeds' : 'Monitor off', 'ok');
    await refreshMonitor();
  } catch (err) {
    e.currentTarget.checked = !on;
    toast(err.message, 'bad', 'Error');
  }
});

$('#monEmailForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  return withBusy(f.querySelector('button[type="submit"]'), async () => {
    await api.send('PUT', '/api/monitor/email', {
      recipients: f.recipients.value, user: f.user.value, fromName: f.fromName.value,
      appPassword: f.appPassword.value || undefined,
    });
    toast('E-mail settings saved', 'ok');
    await loadMonitorTab();
  }).catch(() => {});
});

$('#monTestEmail').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  const r = await api.send('POST', '/api/monitor/test-email');
  toast(`Test e-mail sent to ${r.recipients} address(es)`, 'ok');
}).catch(() => {}));

$('#monRulesForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  return withBusy(f.querySelector('button[type="submit"]'), async () => {
    await api.send('PUT', '/api/monitor/config', {
      black: {
        alertAfterSeconds: Number(f.blackAfter.value), recoverAfterSeconds: Number(f.blackRecover.value),
        maxLuma: Number(f.maxLuma.value), maxBrightPct: Number(f.maxBrightPct.value),
      },
      down: { alertAfterSeconds: Number(f.downAfter.value) },
      freeze: { enabled: f.freezeEnabled.checked, alertAfterSeconds: Number(f.freezeAfter.value) },
      silence: {
        enabled: f.silenceEnabled.checked, thresholdDb: Number(f.silenceDb.value),
        alertAfterSeconds: Number(f.silenceAfter.value),
      },
      resync: {
        enabled: f.resyncEnabled.checked, waitSeconds: Number(f.resyncWait.value),
        cooldownMinutes: Number(f.resyncCooldown.value), emailWhenFixed: f.resyncEmailFixed.checked,
      },
      repeatMinutes: Number(f.repeatMinutes.value),
    });
    toast('Rules saved — the feeds reconnect with them', 'ok');
    await loadMonitorTab();
  }).catch(() => {});
});

$('#monAddFeed').addEventListener('click', () => {
  monFeeds.push({ name: '', url: '', enabled: true, channelId: null });
  renderMonFeeds();
});

$('#monSaveFeeds').addEventListener('click', (e) => withBusy(e.currentTarget, async () => {
  await api.send('PUT', '/api/monitor/config', { sources: monFeeds });
  toast('Feeds saved', 'ok');
  await loadMonitorTab();
}).catch(() => {}));

