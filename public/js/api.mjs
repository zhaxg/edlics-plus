// api.mjs — API calls, toast notifications, utility functions

const BASE = '';

export function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  return fetch(BASE + url, opts).then(r => r.json());
}

export function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '') + ' show';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), 2500);
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

export function confirmDialog(msg) {
  return new Promise(resolve => {
    const overlay = document.getElementById('dialogOverlay');
    const content = document.getElementById('dialogContent');
    content.innerHTML = `
      <h3>Confirm</h3>
      <p style="color:var(--text-dim);font-size:13px;margin-bottom:20px;">${escapeHtml(msg)}</p>
      <div class="btn-row">
        <button class="cancel" id="confirmNo">Cancel</button>
        <button class="primary" id="confirmYes">OK</button>
      </div>`;
    overlay.classList.remove('hidden');
    document.getElementById('confirmNo').onclick = () => { overlay.classList.add('hidden'); resolve(false); };
    document.getElementById('confirmYes').onclick = () => { overlay.classList.add('hidden'); resolve(true); };
  });
}

export function basename(p) { return p.split('/').filter(Boolean).pop() || p; }
export function dirname(p) { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; }
export function join(...parts) { return parts.join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'; }
