// markdown-preview.mjs — Lazy-load marked, render markdown; SVG preview support

let _marked = null;

export function isMarkdownFile(path) {
  return /\.md$/i.test(path);
}

export function isSvgFile(path) {
  return /\.svg$/i.test(path);
}

// Files that support preview/edit toggle (md + svg)
export function isPreviewableFile(path) {
  return isMarkdownFile(path) || isSvgFile(path);
}

async function loadMarked() {
  if (_marked) return _marked;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/marked@14/marked.min.js';
    s.onload = () => {
      _marked = window.marked;
      // Configure marked for safe rendering
      _marked.setOptions({
        gfm: true,
        breaks: true,
      });
      resolve(_marked);
    };
    s.onerror = () => reject(new Error('Failed to load marked library'));
    document.head.appendChild(s);
  });
}

export async function renderMarkdown(content, filePath) {
  const marked = await loadMarked();
  return rewriteImages(marked.parse(content || ''), filePath);
}

function dirnamePosix(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : '';
}

/** Collapse `.`/`..` segments in a POSIX-ish path (keeps drive letters intact). */
function normalizePosix(p) {
  const rooted = p.startsWith('/') || /^[a-zA-Z]:\//.test(p);
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') { out.pop(); continue; }
      if (rooted) continue;
      out.push(seg);
      continue;
    }
    out.push(seg);
  }
  let joined = out.join('/');
  if (!/^[a-zA-Z]:/.test(joined) && rooted) joined = '/' + joined;
  return joined;
}

/**
 * Resolve one <img src> for preview. Relative paths must resolve against the
 * markdown FILE's directory (not the page URL) and be fetched through
 * /api/download (auth + root containment + correct MIME).
 * Pure — exported for unit tests.
 * @param {string} src
 * @param {string} [filePath] absolute path of the .md file
 * @returns {string} src to render
 */
export function resolveImgSrc(src, filePath) {
  const s = (src || '').trim();
  if (!s) return s;
  if (/^(data:|https?:|\/\/)/i.test(s)) return s;   // data-URI / external URL
  if (s.startsWith('/api/')) return s;              // already an endpoint
  const dir = dirnamePosix(filePath);
  let resolved;
  if (/^[a-zA-Z]:[\\/]/.test(s)) {
    resolved = s.replace(/\\/g, '/');               // windows absolute E:\a\b
  } else if (s.startsWith('/')) {
    resolved = s;                                   // server absolute path
  } else if (dir) {
    resolved = dir + '/' + s;                       // relative to the .md file
  } else {
    return s;                                       // no context — leave as-is
  }
  return '/api/download?path=' + encodeURIComponent(normalizePosix(resolved));
}

function rewriteImages(html, filePath) {
  if (typeof DOMParser === 'undefined') return html; // non-DOM fallback (tests)
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let changed = 0;
  for (const img of doc.querySelectorAll('img')) {
    const next = resolveImgSrc(img.getAttribute('src'), filePath);
    if (next !== img.getAttribute('src')) {
      img.setAttribute('src', next);
      changed++;
    }
  }
  return changed ? doc.body.innerHTML : html;
}

// Render SVG content as a preview (direct DOM insert, no iframe needed)
export function renderSvgPreview(container, content) {
  container.innerHTML = '';
  const wrapper = document.createElement('div');
  wrapper.className = 'svg-render';
  wrapper.innerHTML = content;
  // Auto-size: scale SVG to fit container while maintaining aspect ratio
  const svg = wrapper.querySelector('svg');
  if (svg) {
    if (!svg.getAttribute('width') && !svg.getAttribute('height')) {
      svg.style.maxWidth = '100%';
      svg.style.maxHeight = '100%';
    }
  }
  container.appendChild(wrapper);
}
