// state.mjs — Shared application state

export const state = {
  tabs: [],
  activeTab: null,
  dirty: new Set(),
  editorView: null,
  currentView: 'explorer',   // activity bar: explorer | search | git
  terminalOpen: false,
  onTerminalShow: null,      // set by terminal.mjs
  workspace: null,           // absolute path of the opened project folder
  gitBranch: null,           // current branch shown in status bar
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
