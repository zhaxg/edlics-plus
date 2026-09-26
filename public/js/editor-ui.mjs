// editor-ui.mjs — CodeMirror editor host: language map, preview panels,
// diff/binary/image/text rendering, reveal jumps.
// Tab lifecycle lives in tabs.mjs; breadcrumb/status live in pathbar-status.mjs.
// This module re-exports those APIs so existing importers keep working.
import { EditorView, EditorState, keymap, basicSetup, javascript, python, html, css, json, markdown, xml, yaml, cpp, java, rust, go, sql } from '/editor.mjs';
import { state, serverInfo } from './state.mjs';
import { escapeHtml, basename } from './api.mjs';
import { themeCompartment, currentTheme } from './theme.mjs';
import { isMarkdownFile, isSvgFile, isHtmlFile, renderMarkdown, renderSvgPreview, renderHtmlPreview } from './markdown-preview.mjs';
import { renderTabs } from './tabs.mjs';                 // runtime cycle — see CLAUDE.md
import { updatePathBar, updateStatus } from './pathbar-status.mjs';

// Back-compat re-exports: file-ops / app / git keep importing from here.
export { addTab, removeTab, setActiveTab, renderTabs, showTabContextMenu } from './tabs.mjs';
export { updatePathBar, updateStatus } from './pathbar-status.mjs';

const CM6_LANG = {
  // JavaScript / TypeScript
  '.js': () => javascript(), '.jsx': () => javascript({ jsx: true }),
  '.ts': () => javascript({ typescript: true }), '.tsx': () => javascript({ jsx: true, typescript: true }),
  '.mjs': () => javascript(), '.cjs': () => javascript(),
  '.mts': () => javascript({ typescript: true }), '.cts': () => javascript({ typescript: true }),
  // Python
  '.py': () => python(),
  // Web
  '.html': () => html(), '.htm': () => html(), '.vue': () => html(), '.svelte': () => html(),
  '.css': () => css(), '.scss': () => css(), '.less': () => css(),
  '.svg': () => xml(),
  // Data
  '.json': () => json(), '.jsonl': () => json(),
  '.xml': () => xml(),
  '.yml': () => yaml(), '.yaml': () => yaml(),
  '.md': () => markdown(), '.mdx': () => markdown(),
  // Systems
  '.c': () => cpp(), '.h': () => cpp(), '.cpp': () => cpp(), '.hpp': () => cpp(), '.cc': () => cpp(),
  '.rs': () => rust(),
  '.go': () => go(),
  // Backend
  '.java': () => java(),
  '.rb': () => javascript(), // rough fallback
  '.sql': () => sql(),
  // Shell / Config
  '.sh': () => javascript(), '.bash': () => javascript(), '.zsh': () => javascript(),
  '.ini': () => javascript(), '.env': () => javascript(),
};

function getCM6Lang(filename) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const fn = CM6_LANG[ext];
  if (!fn) return [];
  try { const r = fn(); return Array.isArray(r) ? r : [r]; } catch { return []; }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Toggle markdown preview for a tab
export function toggleMdPreview(tab) {
  if (!tab || !tab._previewPanel) return;
  const isCurrentlyPreview = tab._previewMode === 'preview';
  if (isCurrentlyPreview) {
    // Switch to edit
    tab._previewMode = 'edit';
    tab._previewPanel.style.display = 'none';
    if (tab._cmWrapper) tab._cmWrapper.style.display = '';
  } else {
    // Switch to preview
    tab._previewMode = 'preview';
    tab._previewPanel.style.display = '';
    if (tab._cmWrapper) tab._cmWrapper.style.display = 'none';
    if (tab._updatePreview) tab._updatePreview();
  }
  renderTabs();
}

export function closeEditor() {
  if (state.editorView) { state.editorView.destroy(); state.editorView = null; }
  const area = document.getElementById('editorArea');
  area.querySelectorAll('textarea, .image-preview, .binary-preview, .md-preview, .svg-preview, .html-preview, .cm-wrapper, .diff-view').forEach(el => el.remove());
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.classList.remove('hidden');
  document.getElementById('pathBar').innerHTML = '';
  if (serverInfo) {
    document.getElementById('statusLeft').textContent = serverInfo.user + '@' + serverInfo.hostname;
    document.getElementById('statusRight').textContent = serverInfo.ip;
  } else {
    document.getElementById('statusLeft').textContent = '';
    document.getElementById('statusRight').textContent = '';
  }
}

export function loadEditor(tab) {
  const welcome = document.getElementById('welcome');
  const area = document.getElementById('editorArea');
  if (!welcome || !area) return;
  welcome.classList.add('hidden');
  if (!tab) return;
  if (state.editorView) { state.editorView.destroy(); state.editorView = null; }
  // Clear previous content (textareas, images, binary previews, md toggle, etc.)
  area.querySelectorAll('textarea, .image-preview, .binary-preview, .md-preview, .svg-preview, .html-preview, .cm-wrapper, .diff-view').forEach(el => el.remove());

  // Read-only unified diff view (git panel)
  if (tab.type === 'diff') {
    const container = document.createElement('div');
    container.className = 'diff-view';
    const html = (tab.content || '').split('\n').map(line => {
      let cls = 'diff-ctx';
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) cls = 'diff-meta';
      else if (line.startsWith('@@')) cls = 'diff-hunk';
      else if (line.startsWith('+')) cls = 'diff-add';
      else if (line.startsWith('-')) cls = 'diff-del';
      return `<div class="${cls}">${escapeHtml(line) || '&nbsp;'}</div>`;
    }).join('');
    container.innerHTML = html;
    area.appendChild(container);
    // Diff tabs use a virtual path — show just the label, never a clickable breadcrumb
    const pb = document.getElementById('pathBar');
    pb.innerHTML = '';
    const label = document.createElement('span');
    label.textContent = '⑂ ' + tab.name;
    label.style.color = 'var(--accent)';
    pb.appendChild(label);
    updateStatus();
    return;
  }

  // Image preview
  if (tab.type === 'image') {
    const container = document.createElement('div');
    container.className = 'image-preview';
    const img = document.createElement('img');
    img.src = tab.content; // This is the /api/download URL
    img.alt = tab.name;
    container.appendChild(img);
    if (tab.size) {
      const info = document.createElement('div');
      info.className = 'image-info';
      info.textContent = formatSize(tab.size);
      container.appendChild(info);
    }
    area.appendChild(container);
    updatePathBar(tab.path);
    updateStatus();
    return;
  }

  // Binary file
  if (tab.type === 'binary') {
    const container = document.createElement('div');
    container.className = 'binary-preview';
    const fileType = tab.fileType || 'Binary file';
    const sizeInfo = tab.size ? formatSize(tab.size) : 'unknown size';
    container.innerHTML = `
      <div class="binary-icon">📦</div>
      <p class="file-type">${escapeHtml(fileType)}</p>
      <p class="hint">${escapeHtml(tab.name)} (${sizeInfo})</p>
      <a class="download-btn" href="/api/download?path=${encodeURIComponent(tab.path)}" download="${escapeHtml(basename(tab.path))}">Download file</a>
    `;
    area.appendChild(container);
    updatePathBar(tab.path);
    updateStatus();
    return;
  }

  // Text editor (CodeMirror)
  try {
    const isMd = isMarkdownFile(tab.path);
    const isSvg = isSvgFile(tab.path);
    const isHtml = isHtmlFile(tab.path);
    const isPreviewable = isMd || isSvg || isHtml;
    let updatePreview = null;

    // For .md/.svg/.html files, create preview panel (toggle is in the tab bar)
    if (isPreviewable) {
      // Create preview panel with appropriate class
      const previewPanel = document.createElement('div');
      previewPanel.className = isHtml ? 'html-preview' : (isSvg ? 'svg-preview' : 'md-preview');
      previewPanel.style.display = 'none';
      area.appendChild(previewPanel);

      // Store references on tab for the tab bar toggle button
      tab._previewPanel = previewPanel;
      // Default to preview mode for md and svg files; html opens in the editor
      // so the preview renders from disk and is not mistaken for live editing.
      if (tab._previewMode === undefined) {
        tab._previewMode = isHtml ? 'edit' : 'preview';
      }

      let _previewTimer = null;
      updatePreview = () => {
        clearTimeout(_previewTimer);
        _previewTimer = setTimeout(async () => {
          try {
            if (isHtml) {
              // HTML: sandboxed iframe pointed at the inline preview endpoint.
              // Awaited: the token fetch can fail, and that must land in the catch.
              await renderHtmlPreview(previewPanel, tab.path);
            } else if (isSvg) {
              // SVG: render directly in DOM
              renderSvgPreview(previewPanel, tab.content);
            } else {
              // Markdown: render as HTML
              previewPanel.innerHTML = await renderMarkdown(tab.content, tab.path);
            }
          } catch (e) {
            previewPanel.innerHTML = '<p style="color:var(--red);">Preview error: ' + escapeHtml(e.message) + '</p>';
          }
        }, 300);
      };
      tab._updatePreview = updatePreview;

      // Restore preview state if switching back to this tab
      if (tab._previewMode === 'preview') {
        previewPanel.style.display = '';
        updatePreview();
      }
    }

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        tab.content = update.state.doc.toString();
        if (tab.content !== tab.savedContent) state.dirty.add(tab.path);
        else state.dirty.delete(tab.path);
        renderTabs();
        updateStatus();
        // Live-update preview if open. HTML renders from disk, so typing must
        // not rebuild the iframe — it refreshes on save instead.
        if (!isHtml && isPreviewable && tab._previewMode === 'preview' && updatePreview) {
          updatePreview();
        }
      }
    });
    const cm6Keymap = keymap.of([{ key: 'Mod-s', run: () => {
      if (serverInfo && serverInfo.readonly) { import('./api.mjs').then(m => m.toast('Server is in read-only mode', true)); return true; }
      import('./file-ops.mjs').then(m => m.saveFile()); return true;
    } }]);
    const cm6Theme = EditorView.theme({
      '&': { height: '100%', fontSize: '13px' },
      '.cm-scroller': { overflow: 'auto' },
      '.cm-content': { fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", monospace', tabSize: '2' },
    });
    const langExt = getCM6Lang(tab.path);

    // Create wrapper for CodeMirror (for previewable files, to hide/show as unit)
    if (isPreviewable) {
      const cmWrapper = document.createElement('div');
      cmWrapper.className = 'cm-wrapper';
      cmWrapper.style.flex = '1';
      cmWrapper.style.minHeight = '0';
      cmWrapper.style.display = 'flex';
      cmWrapper.style.flexDirection = 'column';
      cmWrapper.style.overflow = 'hidden';
      // If restoring preview mode, hide the wrapper initially
      if (tab._previewMode === 'preview') {
        cmWrapper.style.display = 'none';
      }
      area.appendChild(cmWrapper);
      tab._cmWrapper = cmWrapper;

      const startState = EditorState.create({
        doc: tab.content || '',
        extensions: [basicSetup, updateListener, cm6Keymap, cm6Theme, themeCompartment.of(currentTheme), ...langExt],
      });
      state.editorView = new EditorView({ state: startState, parent: cmWrapper });
    } else {
      const startState = EditorState.create({
        doc: tab.content || '',
        extensions: [basicSetup, updateListener, cm6Keymap, cm6Theme, themeCompartment.of(currentTheme), ...langExt],
      });
      state.editorView = new EditorView({ state: startState, parent: area });
    }

    tab.cmView = { view: state.editorView };
    // Reveal position requested by search results / go-to-line
    if (tab._pendingReveal) {
      const { line, column } = tab._pendingReveal;
      tab._pendingReveal = null;
      try {
        const doc = state.editorView.state.doc;
        const targetLine = doc.line(Math.min(Math.max(1, line), doc.lines));
        const col = Math.min(Math.max(1, column || 1) - 1, targetLine.to - targetLine.from);
        state.editorView.dispatch({
          selection: { anchor: targetLine.from + col },
          effects: EditorView.scrollIntoView(targetLine.from, { y: 'center' }),
        });
      } catch {}
    }
    state.editorView.focus();
    updatePathBar(tab.path);
    updateStatus();
  } catch (e) {
    area.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--red);font-size:13px;padding:20px;">⚠ ' + escapeHtml(e.message) + '</div>';
  }
}
