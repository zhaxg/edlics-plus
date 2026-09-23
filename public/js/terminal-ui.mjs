// terminal-ui.mjs — xterm.js over a real PTY shell (wede-style architecture:
// creack/pty ↔ node-pty). The TTY does echo, line editing, tab stops and
// signals natively — the browser only forwards raw keystrokes, so the cursor
// always follows typing and tty-aware tools (ls columns, colors, Ctrl+C) work.

import { Terminal, FitAddon } from '/terminal.mjs';
import { api } from './api.mjs';
import { state, serverInfo } from './state.mjs';

// xterm palettes matching the app's dark / light themes (theme.mjs THEME_LIGHT)
const XTERM_DARK = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#89b4fa',
  selectionBackground: '#45475a',
};
const XTERM_LIGHT = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#dc8a78',
  selectionBackground: '#ccd0da',
};
function isLightTheme() {
  return !!document.documentElement.style.getPropertyValue('--bg');
}

let term = null;
let fit = null;
let sessionOpen = false;
let opening = null;
let closing = false;
let pendingInput = [];
let respawnTimes = [];

// ---- session lifecycle -----------------------------------------------------

async function ensureSession() {
  if (sessionOpen || !term) return;
  if (opening) return opening;
  opening = (async () => {
    if (fit) { try { fit.fit(); } catch {} }
    const body = { cols: term.cols, rows: term.rows };
    if (state.workspace) body.cwd = state.workspace;
    const r = await api('POST', '/api/term/open', body);
    if (r && r.error) throw new Error(r.error);
    sessionOpen = true;
    startStream();
  })()
    .catch(e => {
      sessionOpen = false;
      if (term) term.write('\r\n\x1b[31mFailed to start shell: ' + (e && e.message ? e.message : e) + '\x1b[0m\r\n');
    })
    .finally(() => { opening = null; });
  return opening;
}

async function startStream() {
  try {
    const res = await fetch('/api/term/stream');
    if (res.status === 401 || !res.ok) {
      sessionOpen = false;
      if (res.status === 401) import('./auth.mjs').then(m => m.showLogin()).catch(() => {});
      return;
    }
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length && term) term.write(value);
    }
  } catch { /* network drop — handled below */ }

  // Stream ended: session killed by us, shell exited, or network drop.
  const wasClosing = closing;
  closing = false;
  sessionOpen = false;
  if (!term) return;
  if (wasClosing) {
    // trash-button restart: wipe everything and spawn a fresh shell
    term.reset();
    respawnTimes = [];
    ensureSession();
    return;
  }
  // Shell exited on its own (or connection lost) → auto-respawn with a guard
  // so a crashing shell can't spin forever.
  const now = Date.now();
  respawnTimes = respawnTimes.filter(t => now - t < 6000);
  if (respawnTimes.length >= 3) {
    term.write('\r\n\x1b[33mShell keeps exiting — click the trash button to retry.\x1b[0m\r\n');
    return;
  }
  respawnTimes.push(now);
  setTimeout(() => ensureSession(), 350);
}

function sendInput(data) {
  if (!term) return;
  if (sessionOpen) {
    api('POST', '/api/term/input', { data }).catch(() => {});
    return;
  }
  pendingInput.push(data);
  ensureSession().then(() => {
    const queue = pendingInput;
    pendingInput = [];
    queue.forEach(d => api('POST', '/api/term/input', { data: d }).catch(() => {}));
  });
}

function restartTerminal() {
  if (!term) return;
  closing = true;
  api('POST', '/api/term/close', {})
    .catch(() => {})
    .then(() => {
      // If a stream was live, its end-handler resets + respawns.
      // If nothing was running, do it here.
      if (!sessionOpen && !opening) {
        closing = false;
        term.reset();
        respawnTimes = [];
        ensureSession();
      }
    });
}

// ---- xterm setup -----------------------------------------------------------

function ensureInit() {
  if (term) {
    fit.fit();
    ensureSession();
    return;
  }
  const container = document.getElementById('terminalContainer');
  if (!container) return;

  term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: '"SF Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
    convertEol: false,
    scrollback: 5000,
    theme: isLightTheme() ? XTERM_LIGHT : XTERM_DARK,
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  // Raw pass-through: every keystroke goes straight to the PTY.
  term.onData(sendInput);
  // Keep the PTY in sync with the emulator size (SIGWINCH equivalent).
  term.onResize(({ cols, rows }) => {
    if (sessionOpen) api('POST', '/api/term/resize', { cols, rows }).catch(() => {});
  });

  // Follow global theme toggles — foreground/cursor/selection must flip with
  // the background or text becomes unreadable (light-on-light).
  document.addEventListener('theme-changed', e => {
    if (term) term.options.theme = e.detail && e.detail.light ? XTERM_LIGHT : XTERM_DARK;
  });

  // Re-fit whenever the container's box changes (panel open/drag, window
  // resize, font load) so xterm-screen always fills the container.
  try {
    new ResizeObserver(() => { if (term && fit) { try { fit.fit(); } catch {} } }).observe(container);
  } catch {}
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { if (term && fit) { try { fit.fit(); } catch {} } }).catch(() => {});
  }

  window.addEventListener('resize', () => { if (state.terminalOpen && fit) fit.fit(); });

  ensureSession();
}

// ---- panel height drag -----------------------------------------------------

// Drag the panel's top edge to change height; remembers it across reloads.
function initPanelResize() {
  const handle = document.getElementById('terminalResize');
  const panel = document.getElementById('terminalPanel');
  if (!handle || !panel) return;
  const KEY = 'edlics.terminalHeight';
  const DEFAULT = 280;
  const MIN = 120;
  const maxH = () => Math.round(window.innerHeight * 0.75);
  const clamp = h => Math.min(maxH(), Math.max(MIN, h));

  try {
    const saved = parseInt(localStorage.getItem(KEY), 10);
    if (saved) panel.style.height = clamp(saved) + 'px';
  } catch {}

  const setH = h => {
    panel.style.height = clamp(h) + 'px';
    if (term && fit) { try { fit.fit(); } catch {} }
  };

  let dragging = false;
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    dragging = true;
    document.body.style.cursor = 'ns-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    setH(window.innerHeight - e.clientY);
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    try { localStorage.setItem(KEY, panel.style.height); } catch {}
    if (term && fit) { try { fit.fit(); } catch {} }
  });
  handle.addEventListener('dblclick', () => {
    setH(DEFAULT);
    try { localStorage.setItem(KEY, String(DEFAULT)); } catch {}
  });
}

// ---- wiring ----------------------------------------------------------------

export function initTerminal() {
  state.onTerminalShow = ensureInit;
  initPanelResize();
  const kill = document.getElementById('terminalKill');
  if (kill) kill.addEventListener('click', restartTerminal);
}
