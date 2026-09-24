// paths.js — path safety primitives, project-aware walk excludes, binary sniffing.
//
// INVARIANT: every user-supplied path that touches the filesystem must pass
// through isPathSafe() (see CLAUDE.md). rootDir is set once at startup from --root.
const fs = require('fs');
const path = require('path');

let rootDir = null; // When set, all file operations are restricted to this directory

function setRootDir(p) { rootDir = p ? path.resolve(p) : null; }
function getRootDir() { return rootDir; }

/**
 * Canonical external path form: POSIX forward slashes everywhere
 * (`E:\temp/edlics-plus` → `E:/temp/edlics-plus`). Windows fs/path accept
 * '/' natively; Linux output is already POSIX so this is a no-op there.
 * Internal fs calls may keep native separators — only client-facing
 * strings (info/search/term results, breadcrumbs) must go through this.
 */
function toPosix(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

// Cross-platform containment check: target is base itself or a descendant.
// path.relative handles OS separators and Windows case-insensitivity,
// unlike prefixing with '/' which breaks on Windows (rootDir + '/' never matches '\').
function isWithinRoot(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}

function isPathSafe(targetPath) {
  if (!rootDir) return true;
  const resolved = path.resolve(targetPath);
  if (!isWithinRoot(rootDir, resolved)) return false;
  // Resolve symlinks to prevent escape via symlink traversal
  try {
    const real = fs.realpathSync(resolved);
    return isWithinRoot(rootDir, real);
  } catch {
    // Path doesn't exist yet (e.g. create) — check parent for symlink escape
    const parent = path.dirname(resolved);
    try {
      const realParent = fs.realpathSync(parent);
      const reassembled = path.join(realParent, path.basename(resolved));
      return isWithinRoot(rootDir, reassembled);
    } catch {
      return false;
    }
  }
}

/**
 * Identify a binary file from its leading bytes.
 * @param {Buffer} buf
 * @returns {string} human readable type label
 */
function detectFileType(buf) {
  if (buf.length < 4) return 'Unknown file';
  // ELF
  if (buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46) {
    const arch = buf.length > 4 ? buf[4] : 0;
    const bits = arch === 1 ? '32-bit' : arch === 2 ? '64-bit' : '';
    return 'ELF executable' + (bits ? ' (' + bits + ')' : '');
  }
  // PE / EXE
  if (buf[0] === 0x4D && buf[1] === 0x5A) return 'Windows executable (PE)';
  // Mach-O
  if ((buf[0] === 0xFE && buf[1] === 0xED && buf[2] === 0xFA) ||
      (buf[0] === 0xCE && buf[1] === 0xFA && buf[2] === 0xED)) return 'Mach-O executable';
  // ZIP / JAR / APK
  if (buf[0] === 0x50 && buf[1] === 0x4B) {
    if (buf.length > 4 && buf[2] === 0x03 && buf[3] === 0x04) return 'ZIP archive';
    return 'ZIP archive';
  }
  // GZIP
  if (buf[0] === 0x1F && buf[1] === 0x8B) return 'GZIP archive';
  // BZ2
  if (buf[0] === 0x42 && buf[1] === 0x5A && buf[2] === 0x68) return 'BZ2 archive';
  // XZ
  if (buf[0] === 0xFD && buf[1] === 0x37 && buf[2] === 0x7A && buf[3] === 0x58) return 'XZ archive';
  // 7z
  if (buf[0] === 0x37 && buf[1] === 0x7A && buf[2] === 0xBC && buf[3] === 0xAF) return '7z archive';
  // RAR
  if (buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) return 'RAR archive';
  // PDF
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return 'PDF document';
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'PNG image';
  // JPEG
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'JPEG image';
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'GIF image';
  // WebP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'WebP image';
  // MP3
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'MP3 audio';
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return 'MP3 audio';
  // OGG
  if (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x67) return 'OGG audio';
  // FLAC
  if (buf[0] === 0x66 && buf[1] === 0x4C && buf[2] === 0x61 && buf[3] === 0x43) return 'FLAC audio';
  // MP4
  if (buf.length > 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return 'MP4 video';
  // SQLite
  if (buf[0] === 0x53 && buf[1] === 0x51 && buf[2] === 0x4C && buf[3] === 0x69) return 'SQLite database';
  // ISO 9660
  if (buf.length > 0x8001 && buf[0x8001] === 0x43 && buf[0x8002] === 0x44) return 'ISO image';
  // Docker image
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x00) return 'Binary data';
  // Generic fallback
  return 'Binary file';
}

// Smart directory filtering: detect project type and exclude build/cache dirs
const BASE_EXCLUDE = new Set(['.git', '.svn', '.hg', '.DS_Store']);
const PROJECT_EXCLUDES = {
  'package.json':   ['node_modules', 'dist', '.next', '.nuxt', '.cache', '.turbo'],
  'go.mod':         ['vendor'],
  'pom.xml':        ['target'],
  'build.gradle':   ['target', '.gradle'],
  'Cargo.toml':     ['target'],
  'requirements.txt': ['__pycache__', '.venv', 'venv', '.mypy_cache', '.tox'],
  'pyproject.toml': ['__pycache__', '.venv', 'venv', '.mypy_cache', '.tox'],
  'Gemfile':        ['vendor', '.bundle'],
  '.csproj':        ['bin', 'obj', '.vs', 'packages'],
  '.sln':           ['bin', 'obj', '.vs', 'packages'],
  '.slnx':          ['bin', 'obj', '.vs', 'packages'],
};

function getExcludes(dirPath) {
  const excluded = new Set(BASE_EXCLUDE);
  let entries;
  try { entries = fs.readdirSync(dirPath); } catch { return excluded; }
  for (const marker of Object.keys(PROJECT_EXCLUDES)) {
    if (marker.startsWith('.')) {
      // dot-files: check exact match (e.g. .sln won't work as startsWith, use some)
      if (entries.some(e => e === marker || e.endsWith(marker))) {
        for (const d of PROJECT_EXCLUDES[marker]) excluded.add(d);
      }
    } else {
      if (entries.includes(marker)) {
        for (const d of PROJECT_EXCLUDES[marker]) excluded.add(d);
      }
    }
  }
  return excluded;
}

module.exports = { setRootDir, getRootDir, toPosix, isWithinRoot, isPathSafe, detectFileType, getExcludes };
