// file-ops.mjs — File operations (open, save, delete, rename, upload, download, create)

import { api, toast, escapeHtml, basename, dirname, join, confirmDialog, isImageFile } from './api.mjs';
import { state, currentDir, HOME, sudoPassword, setSudoPassword } from './state.mjs';
import { addTab, removeTab, setActiveTab, renderTabs, closeEditor, loadEditor } from './editor-ui.mjs';
import { renderDir } from './file-tree.mjs';

function handleSudoError(filePath, action) {
  api('GET', '/api/sudo-status').then(status => {
    if (status.nopasswd || sudoPassword) { action(); }
    else { showSudoDialog(() => action()); }
  }).catch(() => showSudoDialog(() => action()));
}

function showSudoDialog(callback) {
  const overlay = document.getElementById('dialogOverlay');
  const content = document.getElementById('dialogContent');
  content.innerHTML = `
    <h3>Sudo Required</h3>
    <p style="color:var(--text-dim);font-size:13px;margin-bottom:16px;">This file requires elevated permissions. Enter your sudo password.</p>
    <label for="sudoPasswordInput">Password</label>
    <input id="sudoPasswordInput" type="password" placeholder="sudo password" autofocus />
    <div class="btn-row">
      <button class="cancel" id="btnSudoCancel">Cancel</button>
      <button class="primary" id="btnSudoAuth">Authenticate</button>
    </div>`;
  overlay.classList.remove('hidden');
  document.getElementById('sudoPasswordInput').focus();
  document.getElementById('btnSudoCancel').onclick = () => overlay.classList.add('hidden');
  document.getElementById('btnSudoAuth').onclick = () => {
    const pw = document.getElementById('sudoPasswordInput').value;
    if (!pw) return;
    api('POST', '/api/sudo-auth', { password: pw }).then(data => {
      if (data.error) { toast(data.error, true); return; }
      setSudoPassword(pw);
      document.getElementById('sudoBadge').style.display = 'inline';
      overlay.classList.add('hidden');
      toast('Sudo authenticated');
      if (callback) callback();
    });
  };
  document.getElementById('sudoPasswordInput').onkeydown = e => {
    if (e.key === 'Enter') document.getElementById('btnSudoAuth').click();
    if (e.key === 'Escape') overlay.classList.add('hidden');
  };
}

export function openFile(filePath, newTab) {
  const isImg = isImageFile(filePath);
  const url = `/api/read?path=${encodeURIComponent(filePath)}`;
  api('GET', url).then(data => {
    if (data.error === 'Permission denied') {
      return handleSudoError(filePath, () => {
        api('GET', url + '&sudo=1').then(d2 => {
          if (d2.error) { toast(d2.error, true); return; }
          openFileResult(filePath, d2, isImg, newTab);
        });
      });
    }
    if (data.error) { toast(data.error, true); return; }
    openFileResult(filePath, data, isImg, newTab);
  }).catch(e => toast('Failed: ' + e.message, true));
}

function openFileResult(filePath, data, isImg, newTab) {
  const existing = state.tabs.find(t => t.path === filePath);

  // Already open in a tab — switch to it (unless force-new-tab)
  if (!newTab && existing) {
    if (isImg) {
      existing.content = '/api/download?path=' + encodeURIComponent(filePath);
      existing.type = 'image'; existing.size = data.size;
    } else if (data.binary) {
      existing.fileType = data.fileType;
    } else {
      existing.content = data.content; existing.savedContent = data.content;
      state.dirty.delete(filePath);
    }
    setActiveTab(existing.id);
    return;
  }

  // Single click, no existing tab, but there IS an active tab — replace it
  if (!newTab && state.activeTab) {
    const activeTab = state.tabs.find(t => t.id === state.activeTab);
    if (activeTab) {
      if (state.dirty.has(activeTab.path)) {
        confirmDialog(`"${activeTab.name}" has unsaved changes. Replace anyway?`).then(ok => {
          if (!ok) return;
          replaceActiveTab(activeTab, filePath, data, isImg);
        });
        return;
      }
      replaceActiveTab(activeTab, filePath, data, isImg);
      return;
    }
  }

  // Default: create new tab
  if (isImg) {
    addTab(filePath, '/api/download?path=' + encodeURIComponent(filePath), true, 'image', data.size);
  } else if (data.binary) {
    addTab(filePath, null, true, 'binary', data.size, data.fileType);
  } else {
    addTab(filePath, data.content, true);
  }
}

function replaceActiveTab(tab, filePath, data, isImg) {
  // Clean up old editor state
  if (tab.cmView) { tab.cmView.view.destroy(); tab.cmView = null; }
  if (tab._previewPanel) { tab._previewPanel.remove(); tab._previewPanel = null; }
  if (tab._cmWrapper) { tab._cmWrapper.remove(); tab._cmWrapper = null; }
  tab._updatePreview = null;
  state.dirty.delete(tab.path);

  // Update tab properties
  tab.path = filePath;
  tab.name = basename(filePath);
  tab._previewMode = undefined;

  if (isImg) {
    tab.content = '/api/download?path=' + encodeURIComponent(filePath);
    tab.savedContent = ''; tab.type = 'image'; tab.size = data.size; tab.fileType = null;
  } else if (data.binary) {
    tab.content = null; tab.savedContent = '';
    tab.type = 'binary'; tab.size = data.size; tab.fileType = data.fileType;
  } else {
    tab.content = data.content; tab.savedContent = data.content;
    tab.type = 'text'; tab.size = 0; tab.fileType = null;
  }

  renderTabs();
  loadEditor(tab);
}

export function saveFile() {
  const tab = state.tabs.find(t => t.id === state.activeTab);
  if (!tab) return;
  const content = tab.content;
  function doSave(sudo) {
    const qs = sudo ? '&sudo=1' : '';
    api('PUT', `/api/write?path=${encodeURIComponent(tab.path)}${qs}`, { content }).then(data => {
      if (data.error === 'Permission denied' && !sudo) return handleSudoError(tab.path, () => doSave(true));
      if (data.error) { toast(data.error, true); return; }
      tab.savedContent = content; state.dirty.delete(tab.path);
      renderTabs(); toast('Saved ' + basename(tab.path));
    }).catch(e => toast('Save failed: ' + e.message, true));
  }
  doSave(false);
}

export async function deleteItem(filePath) {
  if (!await confirmDialog(`Delete "${basename(filePath)}"?`)) return;
  api('GET', `/api/delete?path=${encodeURIComponent(filePath)}`).then(data => {
    if (data.error) { toast(data.error, true); return; }
    const tab = state.tabs.find(t => t.path === filePath);
    if (tab) removeTab(tab.id);
    renderDir(currentDir, document.getElementById('fileTree'));
    toast('Deleted');
  }).catch(e => toast('Delete failed: ' + e.message, true));
}

export function renameItem(filePath) {
  const oldName = basename(filePath);
  const overlay = document.getElementById('dialogOverlay');
  const content = document.getElementById('dialogContent');
  content.innerHTML = `
    <h3>Rename</h3>
    <label for="renameInput">New name</label>
    <input id="renameInput" value="${escapeHtml(oldName)}" autofocus />
    <div class="btn-row">
      <button class="cancel" id="btnRenameCancel">Cancel</button>
      <button class="primary" id="btnRenameOk">Rename</button>
    </div>`;
  overlay.classList.remove('hidden');
  const input = document.getElementById('renameInput');
  input.focus(); input.select();
  function doRename() {
    const newName = input.value.trim();
    if (!newName || newName === oldName) { overlay.classList.add('hidden'); return; }
    api('POST', `/api/rename?path=${encodeURIComponent(filePath)}`, { newPath: join(dirname(filePath), newName) }).then(data => {
      if (data.error) { toast(data.error, true); return; }
      const tab = state.tabs.find(t => t.path === filePath);
      if (tab) { tab.path = join(dirname(filePath), newName); tab.name = newName; renderTabs(); }
      renderDir(currentDir, document.getElementById('fileTree'));
      toast('Renamed');
    }).catch(e => toast('Rename failed: ' + e.message, true));
    overlay.classList.add('hidden');
  }
  document.getElementById('btnRenameOk').onclick = doRename;
  document.getElementById('btnRenameCancel').onclick = () => overlay.classList.add('hidden');
  input.onkeydown = e => { if (e.key === 'Enter') doRename(); if (e.key === 'Escape') overlay.classList.add('hidden'); };
}

export function downloadItem(filePath) {
  const a = document.createElement('a');
  a.href = '/api/download?path=' + encodeURIComponent(filePath);
  a.download = basename(filePath);
  a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  toast('Downloading ' + basename(filePath));
}

export function uploadFiles() {
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.style.display = 'none';
  input.onchange = () => {
    const total = input.files.length;
    let done = 0;
    for (const file of input.files) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const base64 = e.target.result.split(',')[1];
        const destPath = join(currentDir, file.name);
        api('POST', '/api/upload?path=' + encodeURIComponent(destPath), { content: base64 }).then(data => {
          if (data.error) toast(file.name + ': ' + data.error, true);
          done++;
          if (done === total) { renderDir(currentDir, document.getElementById('fileTree')); toast('Uploaded ' + total + ' file(s)'); }
        }).catch(e => { toast(file.name + ': ' + e.message, true); done++; if (done === total) renderDir(currentDir, document.getElementById('fileTree')); });
      };
      reader.readAsDataURL(file);
    }
  };
  document.body.appendChild(input); input.click(); document.body.removeChild(input);
}

export function showNewFileDialog(type) {
  const overlay = document.getElementById('dialogOverlay');
  const content = document.getElementById('dialogContent');
  content.innerHTML = `
    <h3>New ${type === 'directory' ? 'Folder' : 'File'}</h3>
    <label>Location: ${escapeHtml(currentDir)}</label>
    <label for="newName">Name</label>
    <input id="newName" placeholder="${type === 'directory' ? 'folder-name' : 'filename.ext'}" autofocus />
    <div class="btn-row">
      <button class="cancel" id="btnNewCancel">Cancel</button>
      <button class="primary" id="btnCreate">Create</button>
    </div>`;
  overlay.classList.remove('hidden');
  document.getElementById('newName').focus();
  document.getElementById('btnNewCancel').onclick = () => overlay.classList.add('hidden');
  document.getElementById('btnCreate').onclick = () => {
    const name = document.getElementById('newName').value.trim();
    if (!name) return;
    const fullPath = join(currentDir, name);
    api('POST', `/api/create?path=${encodeURIComponent(fullPath)}`, { type }).then(data => {
      if (data.error) { toast(data.error, true); return; }
      overlay.classList.add('hidden');
      renderDir(currentDir, document.getElementById('fileTree'));
      toast('Created');
      if (type !== 'directory') openFile(fullPath);
    }).catch(e => toast('Create failed: ' + e.message, true));
  };
}
