// views/terminal.mjs — Terminal page (Preact shell around xterm.js).
//
// xterm is imperative: this component only provides the mount point and the
// page chrome. The PTY lifecycle stays in terminal-ui.mjs, which looks the
// container up by id — so the same element works however often the page
// mounts and unmounts.
import { html, useEffect } from '/ui.mjs';
import { Page } from '../components.mjs';
import { useStore } from '../store.mjs';
import { toast } from '../api.mjs';

export default function TerminalPage() {
  const info = useStore().serverInfo;

  useEffect(() => {
    // xterm is imperative: hand the live container to terminal-ui, and release
    // it again on unmount (Preact may replace the node on the next visit).
    let api = null;
    let alive = true;
    import('../terminal-ui.mjs').then(m => {
      if (!alive) return;
      api = m;
      m.initTerminal();
      document.dispatchEvent(new CustomEvent('terminal-mount'));
    });
    return () => {
      alive = false;
      api?.disposeTerminal();
    };
  }, []);

  // The rail already blocks navigation when --terminal is off; this is a
  // second line of defence for deep links (#/terminal).
  useEffect(() => {
    if (info && info.terminal === false) {
      toast('Terminal is disabled — start the server with --terminal to enable it', true);
    }
  }, [info]);

  return html`<${Page} title="Terminal" class="terminal-page" actions=${html`
      <button class="icon-btn" title="Restart shell"
        onClick=${() => import('../terminal-ui.mjs').then(m => m.restartTerminal())}>
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
        </svg>
      </button>`}>
    <div class="terminal-page-body"><div class="terminal-container" id="terminalContainer"></div></div>
  </${Page}>`;
}
