// store.mjs — tiny shared state for cross-module UI state (route, workspace…).
// Preact components subscribe via useStore(); plain modules use get/set.
import { useState, useEffect } from '/ui.mjs';

const state = {
  view: 'overview',        // active route: overview | services | containers | terminal | explorer | search | git
  tab: {},                 // per-page active tab, e.g. { services: 'users' }
  workspace: null,         // opened project folder
  serverInfo: null,        // /api/info payload
  theme: 'dark',
  authed: false,           // set after /api/session succeeds (and after login)
};

/** Are we past the login gate? Console views must not fetch before that. */
export function isAuthed() { return state.authed; }

const subs = new Set();
function emit() { for (const fn of subs) fn(state); }

/** Subscribe to the whole store (returns an unsubscribe fn). */
export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export function get() { return state; }

/** Shallow-merge into the store and notify subscribers. */
export function set(patch) {
  let changed = false;
  for (const k of Object.keys(patch)) {
    if (state[k] !== patch[k]) { state[k] = patch[k]; changed = true; }
  }
  if (changed) emit();
}

/** Set the active tab for a page (kept per page so switching back restores it). */
export function setTab(page, tab) {
  if (state.tab[page] === tab) return;
  state.tab = { ...state.tab, [page]: tab };
  emit();
}

/** Hook: re-render the component whenever the store changes. */
export function useStore() {
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force(n => n + 1)), []);
  return state;
}
