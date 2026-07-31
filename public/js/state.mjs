// state.mjs — Shared application state

export const state = {
  tabs: [],
  activeTab: null,
  dirty: new Set(),
  editorView: null,
};

export let currentDir = '/home';
export let HOME = '/home';
export let serverInfo = null;
export let sudoPassword = null;
export let iconManifest = null;
export let rootRestricted = false;

export function setCurrentDir(dir) { currentDir = dir; }
export function setHOME(dir) { HOME = dir; }
export function setServerInfo(info) { serverInfo = info; }
export function setSudoPassword(pw) { sudoPassword = pw; }
export function setIconManifest(m) { iconManifest = m; }
export function setRootRestricted(v) { rootRestricted = v; }
