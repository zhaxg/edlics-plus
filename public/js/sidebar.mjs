// sidebar.mjs — Sidebar drag-to-resize

export function initSidebarResize() {
  let resizing = false;
  const sidebarEl = document.querySelector('.sidebar');
  const resizeEl = document.getElementById('sidebarResize');
  resizeEl.addEventListener('mousedown', e => { resizing = true; e.preventDefault(); });
  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const rect = sidebarEl.getBoundingClientRect();
    sidebarEl.style.width = Math.max(180, Math.min(1200, e.clientX - rect.left)) + 'px';
  });
  document.addEventListener('mouseup', () => { resizing = false; });
}
