// sidebar.mjs — Sidebar drag-to-resize
//
// Smoothness notes: the sidebar's CSS width transition (meant for the
// collapse/expand animation) must be disabled during the drag, otherwise
// every mousemove restarts a 200ms eased animation and the panel chases
// the cursor. The left edge is fixed during a drag, so measure it once on
// mousedown instead of re-reading layout on every move. Writes during the
// drag are plain style assignments (no layout reads), which the browser
// coalesces into one paint per frame anyway.

export function initSidebarResize() {
  const sidebarEl = document.querySelector('.sidebar');
  const resizeEl = document.getElementById('sidebarResize');
  let resizing = false;
  let left = 0; // cached sidebar left edge (constant during a drag)

  resizeEl.addEventListener('mousedown', e => {
    e.preventDefault();
    resizing = true;
    left = sidebarEl.getBoundingClientRect().left; // measure once per drag
    sidebarEl.classList.add('resizing');          // transition: none while dragging
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!resizing) return;
    const width = Math.max(180, Math.min(1200, e.clientX - left));
    sidebarEl.style.width = width + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    sidebarEl.classList.remove('resizing'); // restore collapse animation
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
}
