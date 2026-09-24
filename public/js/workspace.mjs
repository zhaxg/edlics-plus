// workspace.mjs — Open-a-project-folder flow + persistence (localStorage)

import { api, toast, escapeHtml, basename, toPosix } from './api.mjs';
import { state, HOME, serverInfo, saveWorkspace, loadWorkspace } from './state.mjs';
import { renderTree } from './file-tree.mjs';
import { getFileIcon } from './icons.mjs';

// Root the folder picker may not navigate above (when --root is set, home === rootDir)
function pickerCeiling() {
  if (serverInfo && serverInfo.root) return toPosix(serverInfo.home);
  return '/';
}

function updateExplorerHeader() {
  const title = document.querySelector('#panel-explorer .sidebar-header span');
  if (!title) return;
  title.textContent = state.workspace ? basename(state.workspace) : 'Explorer';
  title.title = state.workspace || '';
}

function showNoWorkspace() {
  const container = document.getElementById('fileTree');
  container.innerHTML = `
    <div class="workspace-welcome">
      <p>No folder opened</p>
      <button class="primary" id="btnWelcomeOpen">Open Folder</button>
    </div>`;
  document.getElementById('btnWelcomeOpen').onclick = openFolderDialog;
  updateExplorerHeader();
}

export function openFolderDialog() {
  const ceiling = pickerCeiling();
  let cursor = ceiling;

  const overlay = document.getElementById('dialogOverlay');
  const content = document.getElementById('dialogContent');
  content.style.width = '440px';
  content.innerHTML = `
    <h3>Open Folder</h3>
    <div class="folder-breadcrumb" id="folderCrumb" style="display:flex;flex-wrap:nowrap;gap:2px;margin-bottom:8px;overflow-x:auto;white-space:nowrap;"></div>
    <div class="folder-list" id="folderList" style="height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:rgba(0,0,0,0.2);"></div>
    <div class="btn-row" style="margin-top:14px;">
      <button class="cancel" id="btnFolderCancel">Cancel</button>
      <button class="primary" id="btnFolderOpen">Open</button>
    </div>`;
  overlay.classList.remove('hidden');

  function crumbHtml(p) {
    const parts = [];
    // Show path from ceiling downward; long paths collapse to first/****/last
    const rel = p.startsWith(ceiling) ? p.slice(ceiling.length).replace(/^[\\/]/, '') : '';
    const segs = rel ? rel.split(/[\\/]/).filter(Boolean) : [];
    // full ceiling (e.g. E:/temp) keeps the root context visible
    parts.push(`<span class="crumb" data-path="${escapeHtml(ceiling)}" style="cursor:pointer;color:var(--accent);">${escapeHtml(ceiling)}</span>`);
    const crumb = (segPath, label) =>
      `<span style="color:var(--text-dimmer)">/</span><span class="crumb" data-path="${escapeHtml(segPath)}" style="cursor:pointer;">${escapeHtml(label)}</span>`;
    if (segs.length <= 3) {
      let acc = '';
      for (const seg of segs) {
        acc = acc ? acc + '/' + seg : seg;
        parts.push(crumb(ceiling + '/' + acc, seg));
      }
    } else {
      // long path → E:/temp/****/myfolder (middle collapsed; hover shows it)
      parts.push(crumb(ceiling + '/' + segs[0], segs[0]));
      parts.push(`<span style="color:var(--text-dimmer)">/</span><span style="color:var(--text-dimmer);cursor:default;" title="${escapeHtml(segs.slice(1, -1).join('/'))}">****</span>`);
      parts.push(crumb(ceiling + '/' + segs.join('/'), segs[segs.length - 1]));
    }
    return parts.join('');
  }

  function refresh() {
    document.getElementById('folderCrumb').innerHTML = crumbHtml(cursor);
    document.getElementById('folderCrumb').querySelectorAll('.crumb').forEach(el => {
      el.addEventListener('click', () => { cursor = el.dataset.path; refresh(); });
    });
    const list = document.getElementById('folderList');
    list.innerHTML = '<div style="padding:10px;color:var(--text-dimmer);font-size:12px;">Loading…</div>';
    api('GET', `/api/list?path=${encodeURIComponent(cursor)}`).then(items => {
      if (!Array.isArray(items)) {
        list.innerHTML = '<div style="padding:10px;color:var(--red);font-size:12px;">⚠ ' + escapeHtml(items.error || 'Error') + '</div>';
        return;
      }
      const dirs = items.filter(i => i.isDirectory && i.name !== '.git');
      list.innerHTML = '';
      // Up one level (unless at ceiling)
      if (cursor !== ceiling) {
        const up = document.createElement('div');
        up.className = 'tree-item';
        up.innerHTML = `<span class="chevron placeholder">▸</span><span class="icon"><img src="/icons/${getFileIcon('..', true)}.svg" class="icon-img" alt="" onerror="this.style.display='none'"></span><span class="name" style="color:var(--text-dim)">..</span>`;
        up.addEventListener('click', () => {
          const idx = cursor.lastIndexOf('/');
          cursor = idx > 0 ? cursor.slice(0, idx) : ceiling;
          if (!cursor.startsWith(ceiling)) cursor = ceiling;
          refresh();
        });
        list.appendChild(up);
      }
      if (dirs.length === 0) {
        const none = document.createElement('div');
        none.className = 'panel-placeholder';
        none.textContent = '(no subfolders)';
        list.appendChild(none);
      }
      for (const d of dirs) {
        const row = document.createElement('div');
        row.className = 'tree-item';
        row.innerHTML = `<span class="chevron placeholder">▸</span><span class="icon"><img src="/icons/${getFileIcon(d.name, true)}.svg" class="icon-img" alt="" onerror="this.style.display='none'"></span><span class="name">${escapeHtml(d.name)}</span>`;
        row.addEventListener('click', () => { cursor = joinPath(cursor, d.name); refresh(); });
        list.appendChild(row);
      }
      document.getElementById('btnFolderOpen').textContent = 'Open ' + basename(cursor);
    });
  }

  document.getElementById('btnFolderCancel').onclick = () => {
    overlay.classList.add('hidden');
    content.style.width = '';
  };
  document.getElementById('btnFolderOpen').onclick = () => {
    overlay.classList.add('hidden');
    content.style.width = '';
    setWorkspace(cursor);
  };
  refresh();
}

function joinPath(a, b) { return (a.replace(/[\\/]+$/, '') + '/' + b); }

export function setWorkspace(path) {
  const ws = toPosix(path);
  saveWorkspace(ws);
  updateExplorerHeader();
  renderTree();
  toast('Opened ' + basename(ws));
  // Notify other panels (git/search) that the workspace changed
  document.dispatchEvent(new CustomEvent('workspace-changed', { detail: ws }));
}

// On boot: restore from localStorage (validate it), or show the open-folder prompt.
export function initWorkspace() {
  const raw = loadWorkspace();
  if (raw) {
    const saved = toPosix(raw);
    if (saved !== raw) saveWorkspace(saved); // migrate legacy mixed-separator value
    api('GET', `/api/list?path=${encodeURIComponent(saved)}`).then(items => {
      if (Array.isArray(items)) {
        state.workspace = saved;
        updateExplorerHeader();
        renderTree();
        document.dispatchEvent(new CustomEvent('workspace-changed', { detail: saved }));
      } else {
        saveWorkspace(null);
        showNoWorkspace();
      }
    }).catch(() => showNoWorkspace());
  } else {
    showNoWorkspace();
  }
}
