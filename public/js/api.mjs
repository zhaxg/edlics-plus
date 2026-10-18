// api.mjs — API calls, toast notifications, utility functions

import { state } from './state.mjs';

const BASE = '';

export function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(BASE + url, opts).then(r => {
    if (r.status === 401 && url !== '/api/login') {
      // Session expired — pop the login gate (lazy import avoids circular dep)
      import('./auth.mjs').then(m => m.showLogin()).catch(() => {});
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }
    return r.json();
  });
}

// --- notifications ---------------------------------------------------------

function toastStack() {
  let s = document.getElementById('toastStack');
  if (!s) { s = document.createElement('div'); s.id = 'toastStack'; s.className = 'toast-stack'; document.body.appendChild(s); }
  return s;
}

/**
 * Non-blocking notification. Errors persist until dismissed; successes
 * auto-hide. Stackable and individually closable.
 * @returns {() => void} dismiss
 */
export function toast(msg, isError = false) {
  const stack = toastStack();
  const t = document.createElement('div');
  t.className = 'toast-item' + (isError ? ' error' : '');
  t.setAttribute('role', isError ? 'alert' : 'status');
  const span = document.createElement('span');
  span.className = 'toast-msg';
  span.textContent = String(msg);
  const x = document.createElement('button');
  x.className = 'toast-x';
  x.setAttribute('aria-label', 'Dismiss');
  x.textContent = '×';
  t.append(span, x);
  stack.appendChild(t);
  let done = false;
  const remove = () => { if (done) return; done = true; t.classList.add('out'); setTimeout(() => t.remove(), 180); };
  x.onclick = remove;
  if (!isError) setTimeout(remove, 4000);
  return remove;
}

/** Small inline loading indicator (for containers rendered via innerHTML). */
export function spinner(text) {
  return `<div class="loading"><span class="spinner"></span>${text ? escapeHtml(text) : ''}</div>`;
}

/** Busy state for a button: disables it and shows a spinner glyph. */
export function setBusy(btn, busy) {
  if (!btn) return;
  if (busy) {
    if (btn.dataset._label === undefined) btn.dataset._label = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add('busy');
  } else {
    btn.disabled = false;
    btn.classList.remove('busy');
    if (btn.dataset._label !== undefined) { btn.innerHTML = btn.dataset._label; delete btn.dataset._label; }
  }
}

export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  return Promise.resolve();
}

// --- dialogs ---------------------------------------------------------------

/** Mount dialog markup into the shared overlay. */
function openDialog(html) {
  const overlay = document.getElementById('dialogOverlay');
  const content = document.getElementById('dialogContent');
  content.innerHTML = html;
  overlay.classList.remove('hidden');
  return { overlay, content };
}

/**
 * Confirmation dialog.
 * @param {string} msg
 * @param {{title?:string, okLabel?:string, cancelLabel?:string, danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(msg, opts = {}) {
  const title = opts.title || 'Confirm';
  const okLabel = opts.okLabel || 'OK';
  const cancelLabel = opts.cancelLabel || 'Cancel';
  return new Promise(resolve => {
    const { overlay, content } = openDialog(`
      <h3>${escapeHtml(title)}</h3>
      <p style="color:var(--text-dim);font-size:13px;margin-bottom:20px;">${escapeHtml(msg)}</p>
      <div class="btn-row">
        <button class="cancel" id="dlgNo">${escapeHtml(cancelLabel)}</button>
        <button class="primary${opts.danger ? ' danger' : ''}" id="dlgYes">${escapeHtml(okLabel)}</button>
      </div>`);
    const done = v => { overlay.classList.add('hidden'); resolve(v); };
    content.querySelector('#dlgNo').onclick = () => done(false);
    content.querySelector('#dlgYes').onclick = () => done(true);
    content.querySelector('#dlgYes').focus();
  });
}

/**
 * Single-line text prompt (replaces window.prompt).
 * @returns {Promise<string|null>}
 */
export function promptDialog(label, opts = {}) {
  return new Promise(resolve => {
    const { overlay, content } = openDialog(`
      <h3>${escapeHtml(opts.title || 'Input')}</h3>
      <p style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">${escapeHtml(label)}</p>
      <input id="dlgInput" type="${escapeHtml(opts.type || 'text')}" value="${escapeHtml(opts.value || '')}"
        placeholder="${escapeHtml(opts.placeholder || '')}" style="width:100%;" />
      <div class="btn-row" style="margin-top:14px;">
        <button class="cancel" id="dlgNo">Cancel</button>
        <button class="primary${opts.danger ? ' danger' : ''}" id="dlgYes">${escapeHtml(opts.okLabel || 'OK')}</button>
      </div>`);
    const input = content.querySelector('#dlgInput');
    setTimeout(() => { input.focus(); if (opts.select) input.select(); }, 30);
    const done = v => { overlay.classList.add('hidden'); resolve(v); };
    content.querySelector('#dlgNo').onclick = () => done(null);
    content.querySelector('#dlgYes').onclick = () => done(input.value);
    input.onkeydown = e => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); };
  });
}

/**
 * Choose one of several actions (replaces window.prompt for signals etc.).
 * @param {string} title
 * @param {string} message
 * @param {{label:string, value:any, danger?:boolean}[]} options
 * @returns {Promise<any|null>}
 */
export function choiceDialog(title, message, options) {
  return new Promise(resolve => {
    const { overlay, content } = openDialog(`
      <h3>${escapeHtml(title)}</h3>
      ${message ? `<p style="color:var(--text-dim);font-size:12px;margin-bottom:14px;">${escapeHtml(message)}</p>` : ''}
      <div class="choice-row">
        ${options.map((o, i) => `<button class="choice${o.danger ? ' danger' : ''}" data-i="${i}">${escapeHtml(o.label)}</button>`).join('')}
      </div>
      <div class="btn-row" style="margin-top:14px;"><button class="cancel" id="dlgNo">Cancel</button></div>`);
    const done = v => { overlay.classList.add('hidden'); resolve(v); };
    content.querySelectorAll('.choice').forEach(b => { b.onclick = () => done(options[+b.dataset.i].value); });
    content.querySelector('#dlgNo').onclick = () => done(null);
  });
}

export function basename(p) { return p.split('/').filter(Boolean).pop() || p; }

/** Canonical path form: POSIX forward slashes (Windows \ → /). */
export function toPosix(p) { return typeof p === 'string' ? p.replace(/\\/g, '/') : p; }

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico', '.tiff', '.tif']);
export function isImageFile(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && IMAGE_EXTS.has(name.slice(dot).toLowerCase());
}
export function dirname(p) { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; }
export function join(...parts) { return parts.join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'; }

/** Path relative to the workspace root (POSIX). Root itself → '.', outside → full path. */
export function workspaceRelative(p) {
  const norm = toPosix(p);
  const root = state.workspace ? toPosix(state.workspace).replace(/\/+$/, '') : null;
  if (!root) return norm;
  if (norm === root) return '.';
  if (norm.startsWith(root + '/')) return norm.slice(root.length + 1);
  return norm;
}
