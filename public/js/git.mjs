// git.mjs — Source Control panel: branch, changes, history, per-file diffs

import { api, escapeHtml, toast } from './api.mjs';
import { state } from './state.mjs';
import { basename } from './api.mjs';
import { getFileIcon } from './icons.mjs';

// File-type icon markup — same logic as the file tree (Material icon manifest)
function iconHtml(filePath) {
  const name = basename(filePath.replace(/\\/g, '/'));
  const iconId = getFileIcon(name, false);
  return `<span class="icon"><img src="/icons/${iconId}.svg" class="icon-img" alt="" onerror="this.style.display='none'"></span>`;
}

const XY_LABEL = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied',
  U: 'Unmerged', '?': 'Untracked', '!': 'Ignored',
};

function xyClass(xy) {
  if (xy === '??') return 'untracked';
  const c = xy[0] !== ' ' ? xy[0] : xy[1];
  if (c === 'M' || c === 'R') return 'modified';
  if (c === 'A' || c === 'C') return 'added';
  if (c === 'D') return 'deleted';
  if (c === 'U') return 'conflict';
  return 'modified';
}

function xyLetter(xy) {
  if (xy === '??') return 'U'; // untracked — VS Code shows "U"
  const c = xy[0] !== ' ' ? xy[0] : xy[1];
  return c || '?';
}

// Open a read-only diff tab in the editor area
export function openDiffTab(label, diffText) {
  const path = 'diff:' + label;
  const existing = state.tabs.find(t => t.path === path);
  if (existing) {
    existing.content = diffText;
    import('./editor-ui.mjs').then(m => { m.setActiveTab(existing.id); });
    return;
  }
  import('./editor-ui.mjs').then(m => {
    const tab = m.addTab(path, diffText, true, 'diff');
    // addTab derives name from basename — give it a friendlier label
    if (tab) { tab.name = label.split(/[\\/]/).pop(); m.renderTabs(); m.setActiveTab(tab.id); }
  });
}

function loadWorktreeDiff(file, staged) {
  const ws = state.workspace;
  api('GET', `/api/git/diff?path=${encodeURIComponent(ws)}&file=${encodeURIComponent(file)}&staged=${staged ? 1 : 0}`)
    .then(data => {
      if (data.error) { toast(data.error, true); return; }
      // Everything in the changes list is viewable — empty diff still opens a tab
      if (!data.diff) { openDiffTab(basename(file), '# No textual changes for ' + file); return; }
      openDiffTab(basename(file), data.diff);
    })
    .catch(e => toast('Diff failed: ' + e.message, true));
}

function loadCommitDiff(sha, file) {
  const ws = state.workspace;
  api('GET', `/api/git/show?path=${encodeURIComponent(ws)}&sha=${encodeURIComponent(sha)}&file=${encodeURIComponent(file)}`)
    .then(data => {
      if (data.error) { toast(data.error, true); return; }
      if (!data.diff) { openDiffTab(basename(file), '# No textual changes for ' + file + ' in ' + sha.slice(0, 7)); return; }
      openDiffTab(basename(file), data.diff);
    })
    .catch(e => toast('Diff failed: ' + e.message, true));
}

// Which sub-view of the git panel is showing: 'changes' | 'graph'
let activeGitView = 'changes';

function renderPanel(info) {
  const body = document.getElementById('gitPanelBody');
  if (!body) return;

  if (!info || !info.repo) {
    body.innerHTML = `<div class="panel-placeholder">⚠ Not a git repository<br><span style="color:var(--text-dimmer);font-size:11px;">${escapeHtml((info && info.error) || 'open a folder that contains .git')}</span></div>`;
    return;
  }

  // Remote opener at the end of the branch row (generic glyph — remote may be any host)
  const remoteHtml = `
    <button class="git-remote-btn" title="Open remote repository in browser"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M2 11.5v-1h3v1zm3.054 5.666l-.708-.72l2.1-2.1l.72.708zm1.392-9.512l-2.1-2.1l.708-.72l2.112 2.112zM16.962 18.5l-4.443-4.442l-.942 2.903l-2.193-7.23l7.308 2.192l-2.892 1.03l4.354 4.355zM10.116 6V3h1v3zm4.669 1.654l-.72-.708l2.112-2.111l.708.707z"/></svg></button>`;

  const changes = info.changes || [];
  let changesHtml;
  if (changes.length === 0) {
    changesHtml = `<div class="git-empty">No changes</div>`;
  } else {
    changesHtml = '<div class="git-changes">';
    for (const c of changes) {
      const staged = c.xy[0] !== ' ' && c.xy[0] !== '?';
      const letter = xyLetter(c.xy);
      const labelKey = c.xy === '??' ? '?' : letter;
      changesHtml += `<div class="git-change" data-file="${escapeHtml(c.path)}" data-staged="${staged ? 1 : 0}" title="${escapeHtml(XY_LABEL[labelKey] || '')} — ${escapeHtml(c.path)}">
        ${iconHtml(c.path)}
        <span class="git-change-name">${escapeHtml(c.path)}</span>
        <span class="git-status ${xyClass(c.xy)}">${letter}</span>
      </div>`;
    }
    changesHtml += '</div>';
  }

  body.innerHTML = `
    <div class="git-branch" title="Current branch">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
      <span>${escapeHtml(info.branch)}</span>
      ${remoteHtml}
    </div>
    <div class="git-toggle">
      <button class="git-toggle-btn${activeGitView === 'changes' ? ' active' : ''}" data-gview="changes">Changes <span class="git-count">${changes.length}</span></button>
      <button class="git-toggle-btn${activeGitView === 'graph' ? ' active' : ''}" data-gview="graph">Graph</button>
    </div>
    <div class="git-view${activeGitView === 'changes' ? '' : ' hidden'}" id="gitViewChanges">${changesHtml}</div>
    <div class="git-view git-timeline${activeGitView === 'graph' ? '' : ' hidden'}" id="gitViewGraph"><div class="git-empty">Loading…</div></div>`;

  // Remote button lives in the branch row (re-rendered each refresh)
  body.querySelector('.git-remote-btn')?.addEventListener('click', openRemote);

  // Segmented toggle
  body.querySelectorAll('.git-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeGitView = btn.dataset.gview;
      body.querySelectorAll('.git-toggle-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('gitViewChanges').classList.toggle('hidden', activeGitView !== 'changes');
      document.getElementById('gitViewGraph').classList.toggle('hidden', activeGitView !== 'graph');
    });
  });

  // Wire changes
  body.querySelectorAll('#gitViewChanges .git-change').forEach(el => {
    el.addEventListener('click', () => {
      loadWorktreeDiff(el.dataset.file, el.dataset.staged === '1');
    });
  });

  // Load history as a single vertical timeline
  api('GET', `/api/git/log?path=${encodeURIComponent(state.workspace)}&n=50`).then(log => {
    const box = document.getElementById('gitViewGraph');
    if (!box) return;
    if (!log.repo || !log.commits || log.commits.length === 0) {
      box.innerHTML = '<div class="git-empty">No commits yet</div>';
      return;
    }
    box.innerHTML = '';
    log.commits.forEach((c, idx) => {
      const item = document.createElement('div');
      item.className = 'timeline-item' + (idx === 0 ? ' head' : '');
      const date = (c.date || '').slice(0, 10);
      item.innerHTML = `
        <div class="git-commit-subject" title="${escapeHtml(c.subject)}">${escapeHtml(c.subject)}</div>
        <div class="git-commit-meta"><code>${escapeHtml(c.short)}</code> · ${escapeHtml(c.author)} · ${escapeHtml(date)}</div>
        <div class="git-commit-files hidden"></div>`;
      const filesBox = item.querySelector('.git-commit-files');
      let expandedOnce = false;
      item.querySelector('.git-commit-subject').addEventListener('click', async () => {
        if (!expandedOnce) {
          expandedOnce = true;
          filesBox.innerHTML = '<div class="git-empty">Loading…</div>';
          try {
            const res = await api('GET', `/api/git/commit-files?path=${encodeURIComponent(state.workspace)}&sha=${encodeURIComponent(c.hash)}`);
            if (!res.repo || !res.files.length) { filesBox.innerHTML = '<div class="git-empty">(no files)</div>'; return; }
            filesBox.innerHTML = '';
            for (const f of res.files) {
              const row = document.createElement('div');
              row.className = 'git-change';
              const cls = f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : 'modified';
              row.innerHTML = `${iconHtml(f.path)}<span class="git-change-name">${escapeHtml(f.path)}</span><span class="git-status ${cls}">${f.status}</span>`;
              row.addEventListener('click', ev => { ev.stopPropagation(); loadCommitDiff(c.hash, f.path); });
              filesBox.appendChild(row);
            }
          } catch { filesBox.innerHTML = '<div class="git-empty">Failed to load</div>'; }
        }
        filesBox.classList.toggle('hidden');
      });
      box.appendChild(item);
    });
  }).catch(() => {});
}

export function refreshGit() {
  const body = document.getElementById('gitPanelBody');
  if (!state.workspace) {
    if (body) body.innerHTML = '<div class="panel-placeholder">Open a folder first</div>';
    return;
  }
  if (body) body.innerHTML = '<div class="git-empty">Loading…</div>';
  api('GET', `/api/git/status?path=${encodeURIComponent(state.workspace)}`)
    .then(renderPanel)
    .catch(() => { if (body) body.innerHTML = '<div class="panel-placeholder">⚠ Failed to load git status</div>'; });
}

function openRemote() {
  if (!state.workspace) { toast('Open a folder first', true); return; }
  api('GET', `/api/git/remote?path=${encodeURIComponent(state.workspace)}`)
    .then(data => {
      if (data.error) { toast(data.error, true); return; }
      if (!data.url) { toast('No remote configured', true); return; }
      window.open(data.url, '_blank', 'noopener');
    })
    .catch(e => toast('Remote failed: ' + e.message, true));
}

export function initGit() {
  const btn = document.getElementById('btnGitRefresh');
  if (btn) btn.addEventListener('click', refreshGit);
  document.addEventListener('workspace-changed', () => refreshGit());
  // Refresh when the panel becomes visible
  document.querySelector('.act-btn[data-view="git"]')?.addEventListener('click', () => {
    setTimeout(refreshGit, 0);
  });
  // Initial load if workspace already set
  if (state.workspace) refreshGit();
}
