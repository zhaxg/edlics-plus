// views/containers.mjs — Containers page (Preact).
//
// Two tabs: Containers | Compose. Each item is one card: a header row (status
// dot + name + metrics/image) and an action row of icon buttons. Stats arrive
// in a second, slower request so the list paints immediately; buttons are
// disabled according to both the container state and the in-flight action.
import { html, useState, useEffect, useRef, Fragment, createPortal } from '/ui.mjs';
import { api, toast, confirmDialog } from '../api.mjs';
import { Page, Tabs, Spinner, Empty } from '../components.mjs';
import { serverInfo } from '../state.mjs';
import { useStore, setTab } from '../store.mjs';

const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);

// --- icons -----------------------------------------------------------------

/** Stroked icon: pass the inner path elements as children. */
const Icon = ({ children, size = 15, fill = false, vb = '0 0 24 24' }) => html`<svg viewBox=${vb}
  width=${size} height=${size} fill=${fill ? 'currentColor' : 'none'}
  stroke=${fill ? 'none' : 'currentColor'} stroke-width=${fill ? null : 2}
  stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;

const I = {
  ports: () => html`<${Icon}><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></${Icon}>`,
  logs: () => html`<${Icon}>
    <path d="M16 4.002C18.175 4.014 19.353 4.111 20.121 4.879C21 5.758 21 7.172 21 10v6c0 2.829 0 4.243-.879 5.122C19.243 22 17.828 22 15 22H9c-2.828 0-4.243 0-5.121-.878C3 20.243 3 18.829 3 16v-6c0-2.828 0-4.242.879-5.121C4.647 4.111 5.825 4.014 8 4.002"/>
    <path d="M10.5 14H17M7 14h.5M7 10.5h.5M7 17.5h.5M10.5 10.5H17M10.5 17.5H17"/>
    <path d="M8 3.5C8 2.67 8.67 2 9.5 2h5c.83 0 1.5.67 1.5 1.5v1c0 .83-.67 1.5-1.5 1.5h-5A1.5 1.5 0 0 1 8 4.5v-1Z"/>
  </${Icon}>`,
  console: () => html`<${Icon}><path d="m5 7 5 5-5 5m7 2h7"/></${Icon}>`,
  start: () => html`<${Icon}><path d="M5 5v14a2 2 0 0 0 2.75 1.84L20 13.74a2 2 0 0 0 0-3.5L7.75 3.14A2 2 0 0 0 5 4.89"/></${Icon}>`,
  restart: () => html`<${Icon}><path d="M19.933 13.041a8 8 0 1 1-9.925-8.788c3.899-1 7.935 1.007 9.425 4.747"/><path d="M20 4v5h-5"/></${Icon}>`,
  stop: () => html`<${Icon}><path d="M7 6a7.75 7.75 0 1 0 10 0m-5-2v8"/></${Icon}>`,
  build: () => html`<${Icon} fill vb="0 0 16 16">
    <path d="m8.354 5.854 2-2a.5.5 0 0 0-.708-.707L8.5 4.293V.5a.5.5 0 0 0-1 0v3.793L6.354 3.147a.5.5 0 0 0-.707.707l2 2a.5.5 0 0 0 .707 0"/>
    <path d="M15 12.5c0 1.379-1.121 2.5-2.5 2.5h-9A2.5 2.5 0 0 1 1 12.5v-6a.5.5 0 0 1 1 0v6c0 .827.673 1.5 1.5 1.5h9c.827 0 1.5-.673 1.5-1.5v-6a.5.5 0 0 1 1 0z"/>
    <path d="M4 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2m4 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2m-2 3a1 1 0 1 0 0-2 1 1 0 0 0 0 2m4 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2m2-3a1 1 0 1 0 0-2 1 1 0 0 0 0 2"/>
  </${Icon}>`,
  clean: () => html`<${Icon} fill>
    <path d="m19.36 2.72 1.42 1.42-5.72 5.71c1.07 1.54 1.22 3.39.32 4.59L9.06 8.12c1.2-.9 3.05-.75 4.59.32zM5.93 17.57c-2.01-2.01-3.24-4.41-3.58-6.65l4.88-2.09 7.44 7.44-2.09 4.88c-2.24-.34-4.64-1.57-6.65-3.58"/>
  </${Icon}>`,
  composefile: () => html`<${Icon} fill>
    <path d="M22.73 9.965c-.725-.42-1.68-.47-2.49-.235-.1-.875-.67-1.63-1.345-2.17l-.27-.22-.235.27c-.455.52-.59 1.395-.52 2.065.05.485.2.99.505 1.395-.235.135-.485.32-.725.405-.47.17-.99.335-1.495.335H15.03V9.44h-2.185V5.245h-2.52V7.26h-4.2v2.185H3.94V11.8H2.055l-.035.25c-.085 1.075.05 2.12.505 3.11l.185.37.015.035c1.33 2.25 3.645 3.195 6.185 3.195 4.91 0 8.96-2.2 10.81-6.825 1.245.065 2.52-.305 3.125-1.495l.15-.305-.27-.17zm-16.27-2.2h1.68v1.85H6.46zm2.2 7.43c0 .285-.235.52-.52.52a.523.523 0 0 1-.52-.52c0-.285.235-.52.52-.52.285.015.52.235.52.52M6.46 9.95h1.68v1.85H6.46zm-2.185 0h1.85v1.85h-1.85zm4.655 8.44c-2.655-.015-4.085-.91-5.26-2.085.355.015.69.035.99.035.27 0 .54 0 .79-.015a8 8 0 0 0 1.7-.25c.385.89 1.095 1.715 2.355 2.32h-.57zm1.395-6.59h-1.85V9.95h1.85zm0-2.185h-1.85v-1.85h1.85zM12.51 11.8h-1.85V9.95h1.85zm0-2.185h-1.85v-1.85h1.85zm0-2.185h-1.85V5.58h1.85zm2.185 4.37h-1.85V9.95h1.85z"/>
  </${Icon}>`,
  del: () => html`<${Icon} fill>
    <path d="M20 6a1 1 0 0 1 .117 1.993L20 8h-.081L19 19a3 3 0 0 1-2.824 2.995L16 22H8c-1.598 0-2.904-1.249-2.992-2.75l-.005-.167L4.08 8H4a1 1 0 0 1-.117-1.993L4 6zm-10 4a1 1 0 0 0-1 1v6a1 1 0 0 0 2 0v-6a1 1 0 0 0-1-1m4 0a1 1 0 0 0-1 1v6a1 1 0 0 0 2 0v-6a1 1 0 0 0-1-1m0-8a2 2 0 0 1 2 2 1 1 0 0 1-1.993.117L14 4h-4l-.007.117A1 1 0 0 1 8 4a2 2 0 0 1 1.85-1.995L10 2z"/>
  </${Icon}>`,
};

/**
 * Badge glyph: the outline "package/cube" mark used for container items.
 * Sized for the 38px badge (the old markup hard-coded 16px and looked tiny).
 */
const BADGE_ICON = html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor"
  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
  <path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>
</svg>`;

// --- helpers ---------------------------------------------------------------

const dotClass = s => s === 'running' ? 'ok' : s === 'exited' ? 'off' : 'warn';

/**
 * Split Docker's Status into plain text + health, so the card can render the
 * health part as a dot instead of the long "(healthy)" / "(health: starting)"
 * suffix — the meta row then has a stable width and never gains a line.
 *   "Up 2 hours (healthy)" → { text: 'Up 2 hours', health: 'healthy' }
 *   "Exited (1) 2 hours ago" → { text: 'Exited (1) 2 hours ago', health: '' }
 */
function splitStatus(status) {
  const m = /^(.*?)\s*\((healthy|unhealthy|health:\s*starting)\)$/i.exec(String(status || ''));
  if (!m) return { text: String(status || ''), health: '' };
  return { text: m[1], health: m[2].toLowerCase().replace(/^health:\s*/, '') };
}

/** Health value → dot colour class: ok green / bad red / anything else warn. */
const healthDot = h => h === 'healthy' ? 'ok' : h === 'unhealthy' ? 'bad' : 'warn';

/**
 * Dot after the status text: health wins when the container has a HEALTHCHECK,
 * otherwise fall back to the container state (running/exited/…).
 */
const metaDot = (st, state) => st.health
  ? healthDot(st.health)
  : state === 'running' ? 'ok' : state === 'exited' ? 'off' : 'warn';

/** Docker's MemUsage is "used / total"; the card shows the used part only. */
const usedOnly = v => String(v).split('/')[0].trim();

/** Top-level URL for a published port (wildcard hosts use the page host). */
function portUrl(p) {
  const host = (!p.host || /^(0\.0\.0\.0|::|\[::\]|:::)$/.test(p.host)) ? location.hostname : p.host;
  return `http://${host}:${p.hostPort}`;
}

function ActionBtn({ title, danger, disabled, onClick, children }) {
  return html`<button class=${'icon-btn sm ctr-ibtn' + (danger ? ' danger' : '')}
    title=${title} disabled=${!!disabled} onClick=${onClick}>${children}</button>`;
}

/** Badge column: status dot over the whale glyph. */
function Badge({ state, title }) {
  return html`<div class="ctr-badge" title=${title || state || ''}>
    <span class="ctr-badge-ico">${BADGE_ICON}</span>
    <span class=${'ctr-badge-dot ' + dotClass(state)}></span>
  </div>`;
}

/** Viewport position for a fixed-position popup, right-aligned to its anchor. */
function popupPos(el) {
  const r = el.getBoundingClientRect();
  return { top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) };
}

/**
 * Port picker button. Opens a small popup listing the published ports so the
 * user can pick which one to open (a container may publish several).
 * The menu is rendered through a portal because `.floating-menu` is fixed.
 */
function PortsButton({ ports }) {
  const [pos, setPos] = useState(null);
  const btn = useRef(null);

  useEffect(() => {
    if (!pos) return undefined;
    const close = () => setPos(null);
    const t = setTimeout(() => {
      document.addEventListener('click', close, { once: true });
      window.addEventListener('scroll', close, { once: true, capture: true });
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener('click', close);
      window.removeEventListener('scroll', close, { capture: true });
    };
  }, [pos]);

  return html`<${Fragment}>
    <button ref=${btn} class="icon-btn sm ctr-ibtn" title="Mapped ports"
      onClick=${e => { e.stopPropagation(); setPos(p => p ? null : popupPos(btn.current)); }}><${I.ports} /></button>
    ${pos ? createPortal(html`<div class="floating-menu" style=${`top:${pos.top}px;right:${pos.right}px;`}>
      ${ports.map(p => html`<button class="menu-item" key=${p.hostPort + '/' + p.proto}
        onClick=${() => { setPos(null); window.open(portUrl(p), '_blank', 'noopener'); }}>
        :${p.hostPort} → ${p.containerPort}/${p.proto}
      </button>`)}
    </div>`, document.body) : null}
  <//>`;
}

// --- containers tab --------------------------------------------------------

function ContainerCard({ c, stats, statsLoading, busy, onAction }) {
  const running = c.state === 'running';
  const [showLogs, setShowLogs] = useState(false);
  const [logText, setLogText] = useState('');
  const [loadCfg, setLoadCfg] = useState(false);
  const [cfg, setCfg] = useState(null);
  const s = (stats && (stats[c.name] || stats[c.id.slice(0, 12)])) || {};
  const net = String(s.net || '').split('/').map(x => x.trim());
  const write = canWrite();
  const isBusy = busy === c.id;

  async function toggleLogs() {
    const next = !showLogs;
    setShowLogs(next);
    if (!next) return;
    setLogText('Loading…');
    try {
      const d = await api('GET', `/api/sys/containers/logs?id=${encodeURIComponent(c.id)}&tail=200`);
      setLogText(d.error || (d.lines || []).join('\n') || '(no output)');
    } catch (e) { setLogText('Failed: ' + e.message); }
  }

  const metrics = [
    s.mem ? html`<span class="ctr-metric"><b>RAM</b> ${usedOnly(s.mem)}</span>` : null,
    s.cpu ? html`<span class="ctr-metric"><b>CPU</b> ${s.cpu}</span>` : null,
    net[0] ? html`<span class="ctr-metric"><b>↓</b> ${net[0]}</span>` : null,
    net[1] ? html`<span class="ctr-metric"><b>↑</b> ${net[1]}</span>` : null,
  ].filter(Boolean);
  const st = splitStatus(c.status);

  return html`<div class="ilist-item ctr">
    <div class="ctr-head">
      <${Badge} state=${c.state} />
      <div class="ctr-main">
        <div class="ctr-name"><span class="ctr-name-text">${c.name}</span></div>
        <div class="ctr-sub">
          ${metrics.length ? metrics : html`<span class="ctr-metric">${statsLoading ? 'loading stats…' : 'no stats'}</span>`}
          <span class="ctr-meta mono" title=${[c.image, c.status].filter(Boolean).join(' · ')}>${st.text}${st.text
            ? html`<i class=${'ctr-hdot ' + metaDot(st, c.state)}></i>` : ''}</span>
        </div>
      </div>
    </div>
    <div class="ctr-tagcol">${c.project ? html`<span class="ctr-tag">${c.project}</span>` : null}</div>
    <div class="ctr-actions">
      ${c.ports && c.ports.length ? html`<${PortsButton} ports=${c.ports} />` : null}
      <${ActionBtn} title="Logs" onClick=${toggleLogs}><${I.logs} /></${ActionBtn}>
      <${ActionBtn} title=${`Console — docker exec -it ${c.name} sh`} disabled=${!running || isBusy}
        onClick=${() => import('../terminal-ui.mjs').then(m => m.runCommandInTerminal(`docker exec -it ${c.name} sh`))}>
        <${I.console} />
      </${ActionBtn}>
      ${write ? html`
        <${ActionBtn} title=${running ? 'Already running' : 'Start'} disabled=${running || isBusy}
          onClick=${() => onAction(c, 'start', 'Start')}><${I.start} /></${ActionBtn}>
        <${ActionBtn} title=${running ? 'Restart' : 'Not running'} disabled=${!running || isBusy}
          onClick=${() => onAction(c, 'restart', 'Restart')}><${I.restart} /></${ActionBtn}>
        <${ActionBtn} title=${running ? 'Stop' : 'Already stopped'} danger disabled=${!running || isBusy}
          onClick=${() => onAction(c, 'stop', 'Stop')}><${I.stop} /></${ActionBtn}>
        <${ActionBtn} title=${running ? 'Stop the container before deleting' : 'Delete container'} danger
          disabled=${running || isBusy} onClick=${() => onAction(c, 'rm', 'Delete')}><${I.del} /></${ActionBtn}>` : null}
    </div>
    ${showLogs ? html`<pre class="svc-logs">${logText}</pre>` : null}
  </div>`;
}

// --- compose tab -----------------------------------------------------------

function ComposeCard({ p, busy, onAction }) {
  const [showFile, setShowFile] = useState(false);
  const [file, setFile] = useState(null);   // { title, text }
  const running = /(^|\()up|running/i.test(p.status || '');
  const up = p.count > 0 && p.running === p.count;
  const any = p.count > 0;
  const write = canWrite();
  const isBusy = busy === p.name;

  const dt = p.created ? new Date(p.created) : null;
  const created = dt && !isNaN(dt) ? dt.toLocaleDateString() : String(p.created || '').slice(0, 10);

  async function toggleFile() {
    const next = !showFile;
    setShowFile(next);
    if (!next || file) return;
    setFile({ title: 'docker-compose.yml', text: 'Loading…' });
    try {
      const r = await api('GET', `/api/sys/containers/compose-file?name=${encodeURIComponent(p.name)}`);
      if (r.error) { setFile({ title: 'docker-compose.yml', text: r.error }); return; }
      const files = r.files || [];
      if (!files.length) { setFile({ title: 'docker-compose.yml', text: '(no file)' }); return; }
      setFile({
        title: files.length === 1 ? files[0].path : `${files.length} files`,
        text: files.map(f => (files.length > 1 ? `# ${f.path}\n` : '') +
          (f.error ? `(error: ${f.error})` : (f.content || '(empty)'))).join('\n\n'),
      });
    } catch (e) { setFile({ title: 'docker-compose.yml', text: 'Failed: ' + e.message }); }
  }

  return html`<div class="ilist-item ctr">
    <div class="ctr-head">
      <${Badge} state=${running ? 'running' : 'exited'} title=${p.status} />
      <div class="ctr-main">
        <div class="ctr-name">${p.name}</div>
        <div class="ctr-sub">
          <span class="ctr-metric"><b>containers</b> ${p.count || 0}${typeof p.running === 'number' ? ` (${p.running} up)` : ''}</span>
          ${created ? html`<span class="ctr-metric"><b>created</b> ${created}</span>` : null}
        </div>
      </div>
    </div>
    <div class="ctr-tagcol"><span class="ctr-tag">${p.status || ''}</span></div>
    <div class="ctr-actions">
      <${ActionBtn} title="View compose file" onClick=${toggleFile}><${I.composefile} /></${ActionBtn}>
      ${write ? html`
        <${ActionBtn} title=${up ? 'Already up' : 'Start (up -d)'} disabled=${up || isBusy}
          onClick=${() => onAction(p.name, 'up', 'Start')}><${I.start} /></${ActionBtn}>
        <${ActionBtn} title=${p.running > 0 ? 'Stop' : 'Not running'} disabled=${!(p.running > 0) || isBusy}
          onClick=${() => onAction(p.name, 'stop', 'Stop')}><${I.stop} /></${ActionBtn}>
        <${ActionBtn} title="Build images" disabled=${isBusy}
          onClick=${() => onAction(p.name, 'build', 'Build')}><${I.build} /></${ActionBtn}>
        <${ActionBtn} title=${any ? 'Clean up (down)' : 'No containers'} disabled=${!any || isBusy}
          onClick=${() => onAction(p.name, 'down', 'Clean up')}><${I.clean} /></${ActionBtn}>
        <${ActionBtn} title=${any ? 'Delete (down -v)' : 'No containers'} danger disabled=${!any || isBusy}
          onClick=${() => onAction(p.name, 'downv', 'Delete')}><${I.del} /></${ActionBtn}>` : null}
    </div>
    ${showFile ? html`<div class="cfview">
      <div class="cfview-title mono">${file ? file.title : 'docker-compose.yml'}</div>
      <pre class="svc-logs">${file ? file.text : 'Loading…'}</pre>
    </div>` : null}
  </div>`;
}

// --- page ------------------------------------------------------------------

export default function ContainersPage() {
  const store = useStore();
  const tab = store.tab.containers || 'containers';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [stats, setStats] = useState({});
  const [statsLoading, setStatsLoading] = useState(false);
  const [busy, setBusy] = useState('');       // id/name of the in-flight action
  const [reload, setReload] = useState(0);

  // Step 1 (fast): list + compose projects.
  useEffect(() => {
    let alive = true;
    api('GET', '/api/sys/containers')
      .then(d => { if (!alive) return; if (d && d.error) setError(d.error); else { setData(d); setError(''); } })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [reload]);

  // Step 2 (slow): live stats — only while the containers tab is visible.
  useEffect(() => {
    if (tab !== 'containers' || !data || !data.available) return undefined;
    let alive = true;
    setStatsLoading(true);
    api('GET', '/api/sys/containers/stats')
      .then(r => { if (alive) setStats((r && r.stats) || {}); })
      .catch(() => { if (alive) setStats({}); })
      .finally(() => { if (alive) setStatsLoading(false); });
    return () => { alive = false; };
  }, [tab, data, reload]);

  async function containerAction(c, action, label) {
    if (action === 'stop' || action === 'restart' || action === 'rm') {
      const msg = action === 'rm'
        ? `Delete container "${c.name}"? It will be force-removed.`
        : `${label} container "${c.name}"?`;
      const okGo = await confirmDialog(msg, { title: label, okLabel: label, danger: true });
      if (!okGo) return;
    }
    setBusy(c.id);
    try {
      const r = await api('POST', '/api/sys/containers/action', { id: c.id, action });
      if (r.error) toast(r.error, true); else toast(`${label} ${c.name || c.id} ok`);
    } catch (e) { toast('Action failed: ' + e.message, true); }
    setBusy('');
    setReload(n => n + 1);
  }

  async function composeAction(name, action, label) {
    const confirmMsg = action === 'down' ? `Bring down project "${name}" (containers removed, volumes kept)?`
      : action === 'downv' ? `Delete project "${name}"? Containers AND volumes will be removed.` : '';
    if (confirmMsg) {
      const okGo = await confirmDialog(confirmMsg, { title: label, okLabel: label, danger: true });
      if (!okGo) return;
    }
    setBusy(name);
    try {
      const r = await api('POST', '/api/sys/containers/compose', { name, action });
      if (r.error) toast(r.error, true); else toast(`${label} ${name} ok`);
    } catch (e) { toast('Action failed: ' + e.message, true); }
    setBusy('');
    setReload(n => n + 1);
  }

  const containers = (data && data.containers) || [];
  const compose = (data && data.compose) || [];
  const items = [
    { id: 'containers', label: `Containers (${containers.length})` },
    { id: 'compose', label: `Compose (${compose.length})` },
  ];

  let body;
  if (error) body = html`<${Empty}>${error}</${Empty}>`;
  else if (!data) body = html`<${Spinner} text="Loading…" />`;
  else if (!data.available) body = html`<${Empty}>Docker is not available</${Empty}>`;
  else if (tab === 'compose') {
    body = compose.length
      ? html`<div class="ilist">${compose.map(p => html`<${ComposeCard} key=${p.name} p=${p} busy=${busy} onAction=${composeAction} />`)}</div>`
      : html`<${Empty}>No compose projects</${Empty}>`;
  } else {
    body = containers.length
      ? html`<div class="ilist">${containers.map(c => html`<${ContainerCard} key=${c.id} c=${c} stats=${stats}
          statsLoading=${statsLoading} busy=${busy} onAction=${containerAction} />`)}</div>`
      : html`<${Empty}>No containers</${Empty}>`;
  }

  return html`<${Page} title="Containers" actions=${html`
      <button class="icon-btn" title="Refresh" onClick=${() => setReload(n => n + 1)}>↻</button>`}>
    <${Tabs} items=${items} active=${tab} onSelect=${t => setTab('containers', t)} />
    ${body}
  </${Page}>`;
}
