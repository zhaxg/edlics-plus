// theme.mjs — Dark/light theme toggle + CodeMirror theme switching

import { EditorView, Compartment, oneDark, syntaxHighlighting, HighlightStyle, tags } from '/editor.mjs';
import { state } from './state.mjs';

const THEME_LIGHT = {
  '--bg': '#f6f7fa', '--sidebar': '#eaecef', '--panel': '#ffffff',
  '--border': '#cdd2dd',
  '--text': '#333747', '--text-dim': '#5c6172', '--text-dimmer': '#858b9c',
  '--accent': '#2160e0', '--accent-hover': '#1a52c2', '--hover': '#eceef4', '--active': '#e0e4ec',
  '--dir-color': '#2160e0', '--file-color': '#4a4f61',
  '--folder-bg': 'rgba(33,96,224,0.07)',
  '--input-bg': '#ffffff', '--sunken': '#eceef3',
  '--tab-bg': '#eaecef', '--tab-active-bg': '#f6f7fa',
  '--green': '#2f8f3f', '--red': '#d20f39', '--yellow': '#a96800', '--peach': '#e8590c', '--mauve': '#7b3fe4', '--pink': '#d63384',
  '--chart-fill-alpha': '18',
  '--shadow-color': 'rgba(15,23,42,0.18)',
};

export const themeCompartment = new Compartment();

// Editor chrome is expressed in the app's CSS variables so both themes stay in
// sync with the rest of the UI. The dark variant is layered on top of oneDark to
// keep its syntax palette while replacing its slate background.
function editorChrome(dark) {
  return EditorView.theme({
    '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--active)' },
    '.cm-panels': { backgroundColor: 'var(--sidebar)', color: 'var(--text)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
    '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
    '.cm-searchMatch': { backgroundColor: 'var(--active)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--border)' },
    '.cm-selectionMatch': { backgroundColor: 'var(--active)' },
    '.cm-matchingBracket, .cm-nonmatchingBracket': { backgroundColor: 'var(--active)' },
    '.cm-gutters': { backgroundColor: 'var(--sidebar)', color: 'var(--text-dimmer)', border: 'none', borderRight: '1px solid var(--border)' },
    '.cm-activeLine': { backgroundColor: 'var(--hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--active)', color: 'var(--text)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--hover)', color: 'var(--text-dim)', border: 'none' },
    '.cm-tooltip': { border: '1px solid var(--border)', backgroundColor: 'var(--panel)' },
    '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: 'transparent', borderBottomColor: 'transparent' },
    '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: 'var(--panel)', borderBottomColor: 'var(--panel)' },
    '.cm-tooltip-autocomplete': { '& > ul > li[aria-selected]': { backgroundColor: 'var(--active)', color: 'var(--text)' } },
  }, { dark });
}

// Light syntax palette: Catppuccin Latte hues pushed darker so every token
// clears 4.5:1 on the #f6f7fa canvas (code text is 13px).
const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#8839ef' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#0f766e' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#1a52c2' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#b45309' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#333747' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#8a5a00' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#b45309' },
  { tag: [tags.meta, tags.comment], color: '#6b7086', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: '#1a52c2', textDecoration: 'underline' },
  { tag: tags.heading, fontWeight: 'bold', color: '#1a52c2' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#c2410c' },
  { tag: [tags.tagName, tags.angleBracket], color: '#d20f39' },
  { tag: tags.attributeName, color: '#0f766e' },
  { tag: tags.attributeValue, color: '#2f7d32' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#2f7d32' },
  { tag: tags.invalid, color: '#d20f39' },
]);

export const lightTheme = [editorChrome(false), syntaxHighlighting(lightHighlight)];
export const darkTheme = [oneDark, editorChrome(true)];
export let currentTheme = darkTheme;

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
  currentTheme = isLight ? lightTheme : darkTheme;
  for (const tab of state.tabs) {
    if (tab.cmView) {
      tab.cmView.view.dispatch({ effects: themeCompartment.reconfigure(currentTheme) });
    }
  }
  // Let other editors (xterm terminal) sync their own palette
  document.dispatchEvent(new CustomEvent('theme-changed', { detail: { light: isLight } }));
}

export function initTheme() {
  const saved = localStorage.getItem('edlics-theme');
  if (saved === 'light') applyTheme(true);
  document.getElementById('themeToggle').addEventListener('click', () => {
    const isLight = !document.documentElement.style.getPropertyValue('--bg');
    applyTheme(isLight);
  });
}
