// file-tree.mjs — File tree rendering

import { api, toast, escapeHtml, join, dirname } from './api.mjs';
import { currentDir, HOME, setCurrentDir } from './state.mjs';
import { getFileIcon } from './icons.mjs';
import { showContextMenu, showTreeEmptyMenu } from './context-menu.mjs';
import { openFile } from './file-ops.mjs';

export function renderTree(path) {
  setCurrentDir(path || HOME);
  renderDir(currentDir, document.getElementById('fileTree'));
}

function dirClick(e) {
  e.stopPropagation();
  const d = e.currentTarget;
  setCurrentDir(d.dataset.dir);
  renderDir(currentDir, d.parentNode);
}

let _dblClickTimer = null;
function fileDblClick(e) {
  e.stopPropagation();
  e.preventDefault();
  clearTimeout(_dblClickTimer);
  openFile(e.currentTarget.dataset.file, true);
}
function fileSingleClick(e) {
  const target = e.currentTarget;
  clearTimeout(_dblClickTimer);
  _dblClickTimer = setTimeout(() => {
    if (!target) return;
    document.getElementById('statusLeft').textContent = '→ ' + target.dataset.file;
    openFile(target.dataset.file);
  }, 200);
}

export function initFileTree() {
  const container = document.getElementById('fileTree');
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const treeItem = e.target.closest('.tree-item');
    if (treeItem && (treeItem.dataset.dir || treeItem.dataset.file)) {
      showContextMenu(e.clientX, e.clientY, treeItem.dataset.dir || treeItem.dataset.file, !!treeItem.dataset.dir);
    } else {
      showTreeEmptyMenu(e.clientX, e.clientY);
    }
  });
}

export function renderDir(dirPath, container) {
  container.innerHTML = '';
  const parent = dirPath === '/' ? null : dirname(dirPath);
  if (parent) {
    const up = document.createElement('div');
    up.className = 'tree-item';
    up.innerHTML = '<span class="icon" style="color:var(--text-dimmer)">↑</span><span class="name" style="color:var(--text-dim)" title="..">..</span>';
    up.addEventListener('click', function () { renderDir(parent, container); });
    container.appendChild(up);
  }
  api('GET', `/api/list?path=${encodeURIComponent(dirPath)}`).then(items => {
    if (!Array.isArray(items)) {
      if (items.error && items.error.includes('outside root')) {
        setCurrentDir(HOME);
        renderDir(HOME, container);
        toast('Access denied: path outside root directory', true);
        return;
      }
      container.innerHTML = '<div class="tree-item" style="color:var(--red);padding:8px 14px;font-size:12px;">⚠ ' + escapeHtml(items.error || 'Error') + '</div>';
      return;
    }
    for (const item of items) {
      const div = document.createElement('div');
      div.className = 'tree-item';
      const icon = document.createElement('span');
      icon.className = 'icon';
      const iconId = getFileIcon(item.name, item.isDirectory);
      const img = document.createElement('img');
      img.src = '/icons/' + iconId + '.svg';
      img.alt = '';
      img.className = 'icon-img';
      img.onerror = function () { this.style.display = 'none'; };
      icon.appendChild(img);
      div.appendChild(icon);
      const name = document.createElement('span');
      name.className = 'name';
      if (item.name.startsWith('.')) { name.style.opacity = '0.4'; name.style.fontSize = '12px'; }
      name.textContent = item.name;
      name.title = item.name;
      div.appendChild(name);
      if (item.isDirectory) {
        div.dataset.dir = join(dirPath, item.name);
        div.addEventListener('click', dirClick);
      } else {
        div.dataset.file = join(dirPath, item.name);
        div.addEventListener('click', fileSingleClick);
        div.addEventListener('dblclick', fileDblClick);
      }
      container.appendChild(div);
    }
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tree-item';
      empty.style.cssText = 'color:var(--text-dimmer);padding-left:24px;font-size:12px;';
      empty.textContent = '(empty)';
      container.appendChild(empty);
    }
  }).catch(e => {
    container.innerHTML = '<div class="tree-item" style="color:var(--red);padding:8px 14px;font-size:12px;">⚠ ' + escapeHtml(e.message) + '</div>';
  });
}
