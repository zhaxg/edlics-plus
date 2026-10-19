// components.mjs — shared presentational components (Preact + htm).
// All text goes through Preact's text nodes, so no manual escaping is needed.
import { html } from '/ui.mjs';

/** Page scaffold: title, header actions, body. */
export function Page({ title, actions, children, class: cls = '' }) {
  return html`<section class=${'page ' + cls}>
    <header class="page-header">
      <h1 class="page-h1">${title}</h1>
      ${actions ? html`<div class="page-actions">${actions}</div>` : null}
    </header>
    <div class="page-body">${children}</div>
  </section>`;
}

/** Tab bar. `items`: [{id, label, count?}] */
export function Tabs({ items, active, onSelect, id }) {
  return html`<div class="page-tabs" id=${id}>
    ${items.map(it => html`<button key=${it.id}
        class=${it.id === active ? 'active' : ''}
        onClick=${() => onSelect(it.id)}>
      ${it.label}${it.count != null ? ` (${it.count})` : ''}
    </button>`)}
  </div>`;
}

export function Spinner({ text }) {
  return html`<div class="loading"><span class="spinner"></span>${text || ''}</div>`;
}

export function Empty({ children }) {
  return html`<div class="panel-placeholder">${children}</div>`;
}

/** Small faint/green percentage ring (SVG). */
export function Ring({ pct, size = 20 }) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return html`<svg class="ring" viewBox="0 0 36 36" width=${size} height=${size} aria-hidden="true">
    <circle class="ring-track" cx="18" cy="18" r="15.5" fill="none" stroke-width="3" />
    <circle class="ring-fill" cx="18" cy="18" r="15.5" fill="none" stroke-width="3"
      pathLength="100" stroke-dasharray=${p.toFixed(1) + ' 100'} transform="rotate(-90 18 18)" />
  </svg>`;
}

export function StatusDot({ state }) {
  const cls = state === 'running' || state === 'UP' || state === 'active' ? 'ok'
    : state === 'exited' || state === 'DOWN' || state === 'inactive' ? 'off' : 'warn';
  return html`<span class=${'svc-dot ' + cls} title=${state || ''}></span>`;
}

export function IconButton({ title, onClick, children, class: cls = '' }) {
  return html`<button class=${'icon-btn ' + cls} title=${title} onClick=${onClick}>${children}</button>`;
}

/** Small chip toggle (e.g. "system (24)"). */
export function Chip({ active, onClick, title, children }) {
  return html`<button class=${'chip-btn' + (active ? ' active' : '')} title=${title} onClick=${onClick}>${children}</button>`;
}

/** Card wrapper with a small uppercase title. */
export function Card({ title, children, class: cls = '' }) {
  return html`<div class=${'card ' + cls}>
    ${title ? html`<div class="card-title">${title}</div>` : null}
    ${children}
  </div>`;
}

/** Definition-style field rows. */
export function Fields({ rows }) {
  return html`<div class="ilist-fields">
    ${rows.filter(Boolean).map(([k, v]) => html`<div class="ilist-field">
      <span class="ilist-k">${k}</span><span class="ilist-v">${v}</span>
    </div>`)}
  </div>`;
}

/** Generic data table. `cols`: [{label, num?}], rows: array of arrays. */
export function DataTable({ cols, rows, empty = 'No data' }) {
  return html`<table class="data-table">
    <thead><tr>${cols.map(c => html`<th class=${c.num ? 'num' : ''}>${c.label}</th>`)}</tr></thead>
    <tbody>
      ${rows.length
        ? rows.map(r => html`<tr>${r.map((cell, i) => html`<td class=${cols[i] && cols[i].num ? 'num' : ''}>${cell}</td>`)}</tr>`)
        : html`<tr><td class="empty" colSpan=${cols.length}>${empty}</td></tr>`}
    </tbody>
  </table>`;
}
