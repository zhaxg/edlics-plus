// file-tree.mjs — VS Code-style collapsible workspace tree (lazy-loaded children)

import { api, toast, escapeHtml, join, dirname } from './api.mjs';
import { state, currentDir, HOME, setCurrentDir } from './state.mjs';
import { getFileIcon } from './icons.mjs';
import { showContextMenu, showTreeEmptyMenu } from './context-menu.mjs';
import { openFile } from './file-ops.mjs';

// Workspace root currently rendered; expansion state is per-session
let rootPath = null;
const expanded = new Set();

export function getRootPath() { return rootPath; }

// Re-render the whole tree from the workspace root.
// Passing a path sets it as the new root; without args keeps the current root.
export function renderTree(path) {
  if (path) rootPath = path;
  const root = state.workspace || rootPath || currentDir || HOME;
  rootPath = root;
  setCurrentDir(root);
  const container = document.getElementById('fileTree');
  container.innerHTML = '';
  loadChildren(root, container, 0, /*keepExpanded=*/true);
}

// Expand every dir along `target` so the path becomes visible in the tree.
export function revealPath(target) {
  if (!rootPath || !target.startsWith(rootPath)) { renderTree(target); return; }
  const rel = target.slice(rootPath.length).replace(/^[\\/]/, '');
  if (!rel) { renderTree(); return; }
  let acc = rootPath;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    acc = join(acc, part);
    expanded.add(acc);
  }
  renderTree();
}

const CHEVRON_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function makeChevron() {
  const chev = document.createElement('span');
  chev.className = 'chevron';
  chev.innerHTML = CHEVRON_SVG;
  return chev;
}

function makeRow(depth, name, isDir, fullPath) {
  const div = document.createElement('div');
  div.className = 'tree-item' + (isDir ? ' dir' : '');
  div.style.paddingLeft = (8 + depth * 14) + 'px';

  const chev = makeChevron();
  if (!isDir) chev.classList.add('placeholder');
  div.appendChild(chev);

  const icon = document.createElement('span');
  icon.className = 'icon';
  const img = document.createElement('img');
  img.src = '/icons/' + getFileIcon(name, isDir) + '.svg';
  img.alt = '';
  img.className = 'icon-img';
  img.onerror = function () { this.style.display = 'none'; };
  icon.appendChild(img);
  div.appendChild(icon);

  const nameEl = document.createElement('span');
  nameEl.className = 'name';
  if (name.startsWith('.')) { nameEl.style.opacity = '0.4'; nameEl.style.fontSize = '12px'; }
  nameEl.textContent = name;
  nameEl.title = name;
  div.appendChild(nameEl);

  if (isDir) {
    div.dataset.dir = fullPath;
    if (expanded.has(fullPath)) div.classList.add('expanded');
    div.addEventListener('click', e => { e.stopPropagation(); toggleDir(div, depth); });
  } else {
    div.dataset.file = fullPath;
    attachFileClicks(div, fullPath);
  }
  return div;
}

let _dblClickTimer = null;
function attachFileClicks(row, filePath) {
  row.addEventListener('dblclick', e => {
    e.stopPropagation(); e.preventDefault();
    clearTimeout(_dblClickTimer);
    openFile(filePath, true);
  });
  row.addEventListener('click', e => {
    e.stopPropagation();
    const target = row;
    clearTimeout(_dblClickTimer);
    _dblClickTimer = setTimeout(() => {
      if (!target) return;
      document.getElementById('statusLeft').textContent = '→ ' + filePath;
      openFile(filePath);
    }, 200);
  });
}

// Load dir entries into `container`. keepExpanded re-opens dirs from the expanded set.
function loadChildren(dirPath, container, depth, keepExpanded) {
  return api('GET', `/api/list?path=${encodeURIComponent(dirPath)}`).then(items => {
    if (!Array.isArray(items)) {
      if (items.error && items.error.includes('outside root')) {
        toast('Access denied: path outside root directory', true);
        if (dirPath === rootPath) {
          container.innerHTML = '<div class="panel-placeholder">⚠ Access denied</div>';
        }
        return;
      }
      if (dirPath === rootPath) {
        container.innerHTML = '<div class="panel-placeholder">⚠ ' + escapeHtml(items.error || 'Error') + '</div>';
      }
      return;
    }
    for (const item of items) {
      const fullPath = join(dirPath, item.name);
      const row = makeRow(depth, item.name, item.isDirectory, fullPath);
      container.appendChild(row);
      if (item.isDirectory && keepExpanded && expanded.has(fullPath)) {
        row.classList.add('expanded');
        const childBox = document.createElement('div');
        childBox.className = 'tree-children';
        container.appendChild(childBox);
        loadChildren(fullPath, childBox, depth + 1, true);
      }
    }
    if (items.length === 0 && dirPath === rootPath) {
      const empty = document.createElement('div');
      empty.className = 'panel-placeholder';
      empty.textContent = '(empty folder)';
      container.appendChild(empty);
    }
  }).catch(e => {
    if (dirPath === rootPath) {
      container.innerHTML = '<div class="panel-placeholder">⚠ ' + escapeHtml(e.message) + '</div>';
    }
  });
}

function toggleDir(row, depth) {
  const dir = row.dataset.dir;
  const existing = row.nextElementSibling;
  if (row.classList.contains('expanded')) {
    row.classList.remove('expanded');
    expanded.delete(dir);
    // Remove the children box (first sibling with .tree-children)
    if (existing && existing.classList.contains('tree-children')) existing.remove();
    return;
  }
  row.classList.add('expanded');
  expanded.add(dir);
  const childBox = document.createElement('div');
  childBox.className = 'tree-children';
  row.after(childBox);
  loadChildren(dir, childBox, depth + 1, false);
}

export function initFileTree() {
  const container = document.getElementById('fileTree');
  container.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const treeItem = e.target.closest('.tree-item');
    if (treeItem && (treeItem.dataset.dir || treeItem.dataset.file)) {
      const target = treeItem.dataset.dir || treeItem.dataset.file;
      // Operations like "New File" act on the right-clicked folder
      setCurrentDir(treeItem.dataset.dir || dirname(target));
      showContextMenu(e.clientX, e.clientY, target, !!treeItem.dataset.dir);
    } else {
      showTreeEmptyMenu(e.clientX, e.clientY);
    }
  });
}

// Legacy signature kept for callers that previously refreshed a flat listing.
export function renderDir(dirPath, container) {
  if (container && container.id === 'fileTree') { renderTree(); return; }
  if (container) { container.innerHTML = ''; loadChildren(dirPath, container, 0, false); }
}
