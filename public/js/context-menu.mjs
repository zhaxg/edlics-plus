// context-menu.mjs — Context menus (file tree + tab bar)

import { toast, basename, dirname, copyToClipboard } from './api.mjs';
import { state, serverInfo } from './state.mjs';
import { openFile, downloadItem, renameItem, deleteItem, showNewFileDialog, uploadFiles } from './file-ops.mjs';

const ctxIcons = {
  open:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>',
  folder:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M2 10h20"/></svg>',
  copy:    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
  download:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
  rename:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/></svg>',
  delete:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
  addfile: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>',
  addfolder:'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 10v6"/><path d="M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>',
  upload:  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/></svg>',
};

let _menuHandler = null;

function showMenu(x, y, items) {
  const menu = document.getElementById('contextMenu');
  menu.innerHTML = items.map(item =>
    `<div class="context-menu-item${item.danger ? ' danger' : ''}"><span class="ctx-icon">${ctxIcons[item.icon]}</span>${item.label}</div>`
  ).join('');
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - rect.width - 10) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - rect.height - 10) + 'px';
  if (_menuHandler) menu.removeEventListener('click', _menuHandler);
  _menuHandler = (e) => {
    e.stopPropagation();
    const target = e.target.closest('.context-menu-item');
    if (!target) return;
    const idx = Array.from(menu.children).indexOf(target);
    if (idx >= 0 && items[idx]) items[idx].action();
    menu.classList.add('hidden');
  };
  menu.addEventListener('click', _menuHandler);
}

export function showContextMenu(x, y, filePath, isDir) {
  const dir = isDir ? filePath : dirname(filePath);
  const ro = serverInfo && serverInfo.readonly;
  const items = [
    { icon: isDir ? 'folder' : 'open', label: 'Open', action: () => { if (!isDir) openFile(filePath); } },
    ...(!ro ? [
      { icon: 'addfile', label: 'New File', action: () => showNewFileDialog('file') },
      { icon: 'addfolder', label: 'New Folder', action: () => showNewFileDialog('directory') },
      { icon: 'upload', label: 'Upload', action: () => uploadFiles() },
    ] : []),
    { icon: 'copy', label: 'Copy Path', action: () => { copyToClipboard(filePath); toast('Copied'); } },
    { icon: 'download', label: 'Download', action: () => downloadItem(filePath) },
    ...(!ro ? [
      { icon: 'rename', label: 'Rename', action: () => renameItem(filePath) },
      { icon: 'delete', label: 'Delete', action: () => deleteItem(filePath), danger: true },
    ] : []),
  ];
  showMenu(x, y, items);
}

export function showTreeEmptyMenu(x, y) {
  const ro = serverInfo && serverInfo.readonly;
  const items = ro ? [] : [
    { icon: 'addfile', label: 'New File', action: () => showNewFileDialog('file') },
    { icon: 'addfolder', label: 'New Folder', action: () => showNewFileDialog('directory') },
    { icon: 'upload', label: 'Upload', action: () => uploadFiles() },
  ];
  if (items.length === 0) return;
  showMenu(x, y, items);
}

export function initContextMenu() {
  document.addEventListener('click', e => {
    const menu = document.getElementById('contextMenu');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) {
      menu.classList.add('hidden');
    }
  });
  document.addEventListener('contextmenu', e => e.preventDefault());
}
