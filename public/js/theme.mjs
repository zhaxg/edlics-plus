// theme.mjs — Dark/light theme toggle + CodeMirror theme switching

import { EditorView, Compartment, oneDark } from '/editor.mjs';
import { state } from './state.mjs';

const THEME_LIGHT = {
  '--bg': '#eff1f5', '--sidebar': '#e6e9ef', '--border': '#ccd0da',
  '--text': '#4c4f69', '--text-dim': '#7c7f93', '--text-dimmer': '#bcc0cc',
  '--accent': '#1e66f5', '--accent-hover': '#2a6ef5', '--hover': '#dce0e8', '--active': '#ccd0da',
  '--dir-color': '#1e66f5', '--file-color': '#5c5f77',
  '--tab-bg': '#e6e9ef', '--tab-active-bg': '#eff1f5',
  '--green': '#40a02b', '--red': '#d20f39', '--yellow': '#df8e1d', '--peach': '#fe640b', '--mauve': '#8839ef', '--pink': '#ea76cb',
};

export const themeCompartment = new Compartment();
export let currentTheme = oneDark;

export const lightTheme = EditorView.theme({
  '&': { backgroundColor: '#eff1f5', color: '#4c4f69' },
  '.cm-content': { caretColor: '#dc8a78' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#dc8a78' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#ccd0da' },
  '.cm-panels': { backgroundColor: '#e6e9ef', color: '#4c4f69' },
  '.cm-panels.cm-panels-top': { borderBottom: '2px solid #ccd0da' },
  '.cm-panels.cm-panels-bottom': { borderTop: '2px solid #ccd0da' },
  '.cm-searchMatch': { backgroundColor: '#eff1f5', outline: '1px solid #9ca0b0' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#bcc0cc' },
  '.cm-activeLine': { backgroundColor: '#e6e9ef' },
  '.cm-selectionMatch': { backgroundColor: '#ccd0da' },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': { backgroundColor: '#ccd0da', outline: '1px solid #9ca0b0' },
  '.cm-gutters': { backgroundColor: '#e6e9ef', color: '#9ca0b0', border: 'none', borderRight: '1px solid #ccd0da' },
  '.cm-activeLineGutter': { backgroundColor: '#ccd0da', color: '#4c4f69' },
  '.cm-foldPlaceholder': { backgroundColor: '#e6e9ef', color: '#9ca0b0', border: 'none' },
  '.cm-tooltip': { border: 'none', backgroundColor: '#ccd0da' },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: '#ccd0da', borderBottomColor: '#ccd0da' },
  '.cm-tooltip-autocomplete': { '& > ul > li[aria-selected]': { backgroundColor: '#ccd0da', color: '#4c4f69' } },
}, { dark: false });

export function applyTheme(isLight) {
  const root = document.documentElement;
  if (isLight) {
    for (const [key, val] of Object.entries(THEME_LIGHT)) root.style.setProperty(key, val);
  } else {
    for (const key of Object.keys(THEME_LIGHT)) root.style.removeProperty(key);
  }
  document.getElementById('themeToggle').innerHTML = isLight
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
  localStorage.setItem('edlics-theme', isLight ? 'light' : 'dark');
  currentTheme = isLight ? lightTheme : oneDark;
  for (const tab of state.tabs) {
    if (tab.cmView) {
      tab.cmView.view.dispatch({ effects: themeCompartment.reconfigure(currentTheme) });
    }
  }
}

export function initTheme() {
  const saved = localStorage.getItem('edlics-theme');
  if (saved === 'light') { applyTheme(true); currentTheme = lightTheme; }
  document.getElementById('themeToggle').addEventListener('click', () => {
    const isLight = !document.documentElement.style.getPropertyValue('--bg');
    applyTheme(isLight);
  });
}
