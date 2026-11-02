// icons.mjs — File icon matching via Material Icon Theme manifest

import { iconManifest } from './state.mjs';

export function getFileIcon(name, isDir) {
  if (!iconManifest) return isDir ? 'folder' : 'file';
  const lower = name.toLowerCase();
  if (isDir) {
    return iconManifest.folderNames[lower] || iconManifest.folder;
  }
  if (iconManifest.fileNames[lower]) return iconManifest.fileNames[lower];
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = lower.slice(dotIdx + 1);
    if (iconManifest.fileExtensions[ext]) return iconManifest.fileExtensions[ext];
    // Extension is not a known icon either — walk back through the base names,
    // so variant files the theme only partly enumerates still resolve:
    // "dockerfile.api" → "dockerfile" → docker (upstream hardcodes only
    // dockerfile.dev/.prod/.ci/.web/…, never .api).
    const base = matchBaseIcon(lower);
    if (base) return base;
  }
  return iconManifest.file || 'file';
}

// Longest known fileNames key that is a prefix of `lower`, at most 3 levels
// of ".suffix" stripped ("a.b.c.d" → "a.b.c" → "a.b" → "a").
const MAX_BASE_DEPTH = 3;

function matchBaseIcon(lower) {
  let name = lower;
  for (let i = 0; i < MAX_BASE_DEPTH; i++) {
    const idx = name.lastIndexOf('.');
    if (idx <= 0) return null;
    name = name.slice(0, idx);
    const id = iconManifest.fileNames[name];
    if (id) return id;
  }
  return null;
}

// Generic icons — used when the manifest maps a name to an SVG that is not
// shipped in public/icons (404), so the slot still shows an icon instead of
// being hidden by the img onerror handler.
export function fallbackIcon(isDir) {
  return isDir ? 'folder' : 'file';
}

// <img> onerror handler: swap to the generic icon once, hide only if that
// one is missing too (prevents an infinite retry loop).
export function onIconError(img, isDir) {
  if (img.dataset.iconFallback) {
    img.style.display = 'none';
    return;
  }
  img.dataset.iconFallback = '1';
  const fallback = '/icons/' + fallbackIcon(isDir) + '.svg';
  if (img.getAttribute('src') === fallback) {
    img.style.display = 'none';
    return;
  }
  img.src = fallback;
}

// Exposed for inline onerror="…" attributes used in template strings.
if (typeof window !== 'undefined') window.onIconError = onIconError;
