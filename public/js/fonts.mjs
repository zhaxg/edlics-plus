// fonts.mjs — resolve font stacks declared in CSS, so the editor and the
// terminal never hardcode a stack that drifts away from public/css/style.css.
// Reads `--font-mono` from :root; falls back when CSS isn't ready yet.

/**
 * The full mono stack, ready to hand to CodeMirror / xterm.
 *
 * Reads the *resolved* value (var(--font-cjk) already substituted) by probing
 * an element that actually uses the variable — getComputedStyle on the root
 * would hand back the raw token stream, var() and all, which xterm can't use.
 */
export function cssMonoFont(fallback = 'monospace') {
  try {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;font-family:var(--font-mono)';
    (document.body || document.documentElement).appendChild(probe);
    const value = getComputedStyle(probe).fontFamily;
    probe.remove();
    return value || fallback;
  } catch {
    return fallback;
  }
}
