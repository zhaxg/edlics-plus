// disk.mjs — Disk view for the System page: filesystems (df -h), inodes
// (df -i), block devices (lsblk) and the mount tree (findmnt). Read-only.
import { api, escapeHtml, spinner } from './api.mjs';

let data = null;

function bar(pct) {
  const n = parseInt(String(pct).replace('%', ''), 10);
  if (!Number.isFinite(n)) return '';
  const cls = n >= 90 ? 'danger' : n >= 75 ? 'warn' : '';
  return `<span class="disk-bar" title="${escapeHtml(pct)}"><span class="disk-bar-fill ${cls}" style="width:${Math.min(100, n)}%"></span></span>`;
}

function dfSection(title, rows, cols, empty) {
  if (!rows || !rows.length) return `<div class="panel-placeholder">${empty}</div>`;
  const head = `<div class="disk-head"><span>${cols[0]}</span><span>${cols[1]}</span><span>${cols[2]}</span><span>${cols[3]}</span><span>${cols[4]}</span></div>`;
  const body = rows.map(r => `<div class="disk-row">
      <span class="disk-mount mono" title="${escapeHtml(r.mount)}">${escapeHtml(r.mount)}</span>
      <span class="disk-src mono" title="${escapeHtml(r.fs)}">${escapeHtml(r.fs)}</span>
      <span class="disk-num">${escapeHtml(r.size)}</span>
      <span class="disk-num">${escapeHtml(r.used)}</span>
      <span class="disk-num">${escapeHtml(r.avail)}</span>
      <span class="disk-pct">${bar(r.pct)}<b>${escapeHtml(r.pct)}</b></span>
    </div>`).join('');
  return `<div class="disk-table grid6">${head}${body}</div>`;
}

function lsblkSection(devs) {
  if (!devs || !devs.length) return '<div class="panel-placeholder">No block devices</div>';
  return '<div class="disk-table flexrows">' + devs.map(d => `<div class="disk-row">
      <span class="disk-dev mono" style="padding-left:${d.depth * 16}px">${d.depth ? '└ ' : ''}${escapeHtml(d.name)}</span>
      <span class="disk-num">${escapeHtml(d.size || '')}</span>
      <span class="disk-src">${escapeHtml(d.type || '')}${d.fstype ? ' · ' + escapeHtml(d.fstype) : ''}</span>
      <span class="disk-mount mono">${escapeHtml(d.mountpoint || '')}${d.ro ? ' (ro)' : ''}</span>
    </div>`).join('') + '</div>';
}

function findmntSection(mounts) {
  if (!mounts || !mounts.length) return '<div class="panel-placeholder">No mounts</div>';
  return '<div class="disk-table flexrows">' + mounts.map(m => `<div class="disk-row">
      <span class="disk-mount mono" style="padding-left:${m.depth * 14}px">${escapeHtml(m.target)}</span>
      <span class="disk-src mono">${escapeHtml(m.source)}</span>
      <span class="disk-src">${escapeHtml(m.fstype)}</span>
      <span class="disk-num">${escapeHtml(m.size)}</span>
      <span class="disk-num">${escapeHtml(m.usePct)}</span>
    </div>`).join('') + '</div>';
}

function render() {
  const box = document.getElementById('diskBoard');
  if (!box) return;
  if (!data) { box.innerHTML = spinner('Loading…'); return; }
  box.innerHTML =
    `<div class="disk-section"><div class="disk-title">Filesystems <span class="muted">df -h</span></div>${dfSection('', data.mounts, ['Mounted on', 'Filesystem', 'Size', 'Used', 'Avail', 'Use%'], 'No filesystems')}</div>` +
    `<div class="disk-section"><div class="disk-title">Block devices <span class="muted">lsblk</span></div>${lsblkSection(data.blockdevices)}</div>`;
}

export async function refreshDisk() {
  const box = document.getElementById('diskBoard');
  if (box) box.innerHTML = spinner('Loading…');
  try { data = await api('GET', '/api/sys/disk'); } catch { data = null; }
  render();
}

export function initDisk() { /* refreshed on tab activation by services.mjs */ }
