// Admin review UI logic. Vanilla ES modules, no framework/bundler.

export const api = {
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
    if (!r.ok) throw Object.assign(new Error(data.error || r.status), { status: r.status, data });
    return data;
  },
};

export const fmt = (s) => {
  s = Math.round(s);
  const sign = s < 0 ? '-' : '';
  s = Math.abs(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${sign}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

// This Mac's calendar date. toISOString() is UTC, which in Guyana is already
// tomorrow from 20:00 on.
export const localToday = (d = new Date()) => [d.getFullYear(), d.getMonth() + 1, d.getDate()]
  .map((n, i) => String(n).padStart(i ? 2 : 4, '0')).join('-');

// ---- Toasts ----------------------------------------------------------------
const ICONS = { ok: '✓', bad: '✕', info: 'ℹ' };
export function toast(message, kind = 'info', title = '') {
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
  // Errors stay longer but no longer forever, and at most a few pile up: a
  // column of stale red boxes hid the page and said nothing new.
  setTimeout(dismiss, kind === 'bad' ? 9000 : 4200);
  const all = [...host.children].filter((x) => !x.classList.contains('leaving'));
  for (const old of all.slice(0, Math.max(0, all.length - 4))) old.remove();
  return t;
}

// ---- Small utilities ----------------------------------------------------------
/** Run `fn` once input has been quiet for `ms` (search boxes, number fields). */
export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// Read-mostly data every tab asks for. The channel list used to be fetched on
// every grid reload and the whole channel catalogue on every block opened —
// most of what made the review UI feel slow. Both are cached and invalidated
// by whatever changes them.
let channelsCache = null;
let channelsAt = 0;
/** Every channel (cached for a minute, or until invalidateChannels()). */
export async function getChannels({ fresh = false } = {}) {
  if (!fresh && channelsCache && Date.now() - channelsAt < 60_000) return channelsCache;
  channelsCache = await api.get('/api/channels');
  channelsAt = Date.now();
  return channelsCache;
}
export function invalidateChannels() { channelsCache = null; }

const resourcesCache = new Map(); // channel id -> { at, rows }
/** A channel's catalogue as GET /api/resources returns it (cached for 5 minutes). */
export async function getResources(channelId, { fresh = false } = {}) {
  const hit = resourcesCache.get(channelId);
  if (!fresh && hit && Date.now() - hit.at < 300_000) return hit.rows;
  const rows = await api.get(`/api/resources?channel_id=${channelId}`);
  resourcesCache.set(channelId, { at: Date.now(), rows });
  return rows;
}
/** Drop the cached catalogue of one channel (or of all of them). */
export function invalidateResources(channelId = null) {
  if (channelId == null) resourcesCache.clear(); else resourcesCache.delete(channelId);
}

// ---- Generic dialog (confirm / report) -------------------------------------
export function closeDialog() { $('#dialog').classList.add('hidden'); }
$('#dialogClose').addEventListener('click', closeDialog);
$('#dialog').addEventListener('click', (e) => { if (e.target.id === 'dialog') closeDialog(); });

export function confirmDialog(title, message, { confirmLabel = 'Confirm', danger = false } = {}) {
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

// Confirm that also collects a short note. Used by the block override, where
// "why did somebody force this?" is worth more later than the click itself.
export function confirmWithNote(title, message, { confirmLabel = 'Confirm', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    $('#dialogTitle').textContent = title;
    const content = $('#dialogContent');
    content.innerHTML = '';
    content.append(el('p', { className: 'dialog-msg', textContent: message }));
    const input = el('input', { type: 'text', className: 'dialog-note', placeholder, maxLength: 200 });
    content.append(input);
    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: 'primary', textContent: confirmLabel });
    cancel.onclick = () => { closeDialog(); resolve({ ok: false, note: '' }); };
    ok.onclick = () => { closeDialog(); resolve({ ok: true, note: input.value.trim() }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
    actions.append(cancel, ok);
    $('#dialog').classList.remove('hidden');
    input.focus();
  });
}

export function reportDialog(title, rows) {
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
export async function withBusy(btn, fn) {
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


// ---- Channel scope picker ------------------------------------------------------
// Every scheduling action asks the same question: just the channel on screen,
// or that channel and others too? The answer is remembered per action, so
// "approve on Discover + Elevate" every week is one click after the first time.
// Resolves to an array of channel ids (the current one first), or null on cancel.
const SCOPE_KEY = (action) => `otav.scope.${action}`;
export function scopeDialog({ title, message = '', action, current, channels, confirmLabel = 'Continue', danger = false, extra = null, mode = null }) {
  return new Promise((resolve) => {
    const cur = channels.find((c) => c.id === current) || channels[0];
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SCOPE_KEY(action)) || '{}'); } catch { /* ignore */ }
    $('#dialogTitle').textContent = title;
    const content = $('#dialogContent');
    content.innerHTML = '';
    if (message) content.append(el('p', { className: 'dialog-msg', textContent: message }));

    const name = `scope-${Date.now()}`;
    const only = el('input', { type: 'radio', name, value: 'only' });
    const more = el('input', { type: 'radio', name, value: 'more' });
    const wrap = el('div', { className: 'scope-pick' });
    wrap.append(
      el('label', { className: 'scope-opt' }, only, el('span', {}, el('strong', { textContent: `Only ${cur?.name ?? 'this channel'}` }),
        el('small', { className: 'muted', textContent: 'The channel open in the schedule' }))),
      el('label', { className: 'scope-opt' }, more, el('span', {}, el('strong', { textContent: `${cur?.name ?? 'This channel'} + other channels` }),
        el('small', { className: 'muted', textContent: 'Pick which ones below' }))),
    );
    const list = el('div', { className: 'push-channels scope-list' });
    const others = channels.filter((c) => c.id !== cur?.id);
    const preset = new Set(Array.isArray(saved.others) ? saved.others : []);
    const boxes = others.map((c) => {
      const input = el('input', { type: 'checkbox', value: String(c.id) });
      input.checked = preset.has(c.id);
      list.append(el('label', { className: 'chk push-channel' }, input, el('span', { textContent: c.name })));
      return input;
    });
    const bulk = el('div', { className: 'push-channel-bulk' });
    const all = el('button', { className: 'ghost mini', type: 'button', textContent: 'All' });
    const none = el('button', { className: 'ghost mini', type: 'button', textContent: 'None' });
    bulk.append(all, none);
    const othersBox = el('div', { className: 'scope-others' }, bulk, list);
    content.append(wrap, othersBox);
    if (extra) content.append(extra);
    ((mode ?? saved.mode) === 'more' && others.length ? more : only).checked = true;
    if (!others.length) more.disabled = true;

    const actions = $('#dialogActions');
    actions.innerHTML = '';
    const cancel = el('button', { className: 'ghost', textContent: 'Cancel' });
    const ok = el('button', { className: danger ? 'danger' : 'primary', textContent: confirmLabel });
    const picked = () => (more.checked ? boxes.filter((b) => b.checked).map((b) => Number(b.value)) : []);
    const sync = () => {
      othersBox.classList.toggle('disabled', !more.checked);
      for (const b of boxes) b.disabled = !more.checked;
      ok.disabled = more.checked && picked().length === 0;
    };
    for (const x of [only, more, ...boxes]) x.addEventListener('change', sync);
    all.onclick = () => { for (const b of boxes) b.checked = true; sync(); };
    none.onclick = () => { for (const b of boxes) b.checked = false; sync(); };
    cancel.onclick = () => { closeDialog(); resolve(null); };
    ok.onclick = () => {
      const ids = [cur.id, ...picked()];
      try {
        localStorage.setItem(SCOPE_KEY(action), JSON.stringify({ mode: more.checked ? 'more' : 'only', others: boxes.filter((b) => b.checked).map((b) => Number(b.value)) }));
      } catch { /* private mode: just don't remember */ }
      closeDialog();
      resolve(ids);
    };
    actions.append(cancel, ok);
    sync();
    $('#dialog').classList.remove('hidden');
    ok.focus();
  });
}
