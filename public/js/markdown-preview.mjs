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

export async function renderMarkdown(content) {
  const marked = await loadMarked();
  return marked.parse(content || '');
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
