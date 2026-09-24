// state.mjs — Shared application state

/**
 * @typedef {Object} TabInfo
 * @property {string} id            unique per tab ('<ts>_<rand>')
 * @property {string} path          absolute file path, or 'diff:<label>' for git diffs
 * @property {string} name          display name (basename)
 * @property {string} content       file text (diff text for type='diff')
 * @property {string} savedContent  last-persisted text (dirty check baseline)
 * @property {'text'|'image'|'binary'|'diff'} type
 * @property {number} size          bytes (image/binary)
 * @property {string|null} fileType binary type label from the server
 * @property {object} [cmView]      { view } while a CodeMirror instance is attached
 * @property {object} [_pendingReveal] { line, column } one-shot reveal target
 */

export const state = {
  /** @type {TabInfo[]} */
  tabs: [],
  activeTab: null,
  dirty: new Set(),
  editorView: null,
  currentView: 'explorer',   // activity bar: explorer | search | git
  terminalOpen: false,
  onTerminalShow: null,      // set by terminal-ui.mjs
  workspace: null,           // absolute path of the opened project folder
};

export let currentDir = '/home';
export let HOME = '/home';
export let serverInfo = null;
export let sudoPassword = null;
export let iconManifest = null;
export let rootRestricted = false;

const WS_KEY = 'edlics.workspace';

export function setCurrentDir(dir) { currentDir = dir; }
export function setHOME(dir) { HOME = dir; }
export function setServerInfo(info) { serverInfo = info; }
export function setSudoPassword(pw) { sudoPassword = pw; }
export function setIconManifest(m) { iconManifest = m; }
export function setRootRestricted(v) { rootRestricted = v; }

export function loadWorkspace() {
  try { return localStorage.getItem(WS_KEY); } catch { return null; }
}
export function saveWorkspace(path) {
  state.workspace = path;
  try {
    if (path) localStorage.setItem(WS_KEY, path);
    else localStorage.removeItem(WS_KEY);
  } catch {}
}
