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
  if (kind !== 'bad') setTimeout(dismiss, 4200);
  return t;
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

