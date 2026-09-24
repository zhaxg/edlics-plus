// workspace.mjs — Open-a-project-folder flow + persistence (localStorage)

import { api, toast, escapeHtml, basename } from './api.mjs';
import { state, HOME, serverInfo, saveWorkspace, loadWorkspace } from './state.mjs';
import { renderTree } from './file-tree.mjs';
import { getFileIcon } from './icons.mjs';

// Root the folder picker may not navigate above (when --root is set, home === rootDir)
function pickerCeiling() {
  if (serverInfo && serverInfo.root) return serverInfo.home;
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
    <div class="folder-breadcrumb" id="folderCrumb" style="display:flex;flex-wrap:wrap;gap:2px;margin-bottom:8px;max-height:32px;overflow-y:auto;"></div>
    <div class="folder-list" id="folderList" style="height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;background:rgba(0,0,0,0.2);"></div>
    <div class="btn-row" style="margin-top:14px;">
      <button class="cancel" id="btnFolderCancel">Cancel</button>
      <button class="primary" id="btnFolderOpen">Open</button>
    </div>`;
  overlay.classList.remove('hidden');

  function crumbHtml(p) {
    const ceilingLabel = basename(ceiling) || ceiling;
    const parts = [];
    let acc = '';
    // Show path from ceiling downward
    const rel = p.startsWith(ceiling) ? p.slice(ceiling.length).replace(/^[\\/]/, '') : '';
    parts.push(`<span class="crumb" data-path="${escapeHtml(ceiling)}" style="cursor:pointer;color:var(--accent);">${escapeHtml(ceilingLabel)}</span>`);
    if (rel) {
      for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
        acc = acc ? acc + '/' + seg : seg;
        parts.push(`<span style="color:var(--text-dimmer)">/</span><span class="crumb" data-path="${escapeHtml(ceiling + '/' + acc)}" style="cursor:pointer;">${escapeHtml(seg)}</span>`);
      }
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
        up.innerHTML = '<span class="chevron placeholder">▸</span><span class="icon" style="color:var(--text-dimmer)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg></span><span class="name" style="color:var(--text-dim)">..</span>';
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
  saveWorkspace(path);
  updateExplorerHeader();
  renderTree();
  toast('Opened ' + basename(path));
  // Notify other panels (git/search) that the workspace changed
  document.dispatchEvent(new CustomEvent('workspace-changed', { detail: path }));
}

// On boot: restore from localStorage (validate it), or show the open-folder prompt.
export function initWorkspace() {
  const saved = loadWorkspace();
  if (saved) {
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
