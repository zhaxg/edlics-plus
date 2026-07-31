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
  }
  return iconManifest.file || 'file';
}
