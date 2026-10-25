// views/dashboard.mjs — Dashboard (Preact): info cards, live/history charts,
// the process table and the 2FA dialog.
//
// uPlot needs a real DOM node, so charts stay imperative: a small <Chart>
// component creates the instance on mount and feeds it new data via setData.
// All other markup is declarative, so numbers are text nodes (no escaping).
import { html, useState, useEffect, useRef, Fragment } from '/ui.mjs';
import { api, toast, copyToClipboard, choiceDialog } from '../api.mjs';
import { Ring, Spinner, Empty } from '../components.mjs';
import { uPlot } from '/charts.mjs';
import { serverInfo } from '../state.mjs';
import { fmtBytes, fmtRss, fmtUptime, pct as pctOf, parsePct } from '../format.mjs';

const MAX_POINTS = 180;              // matches the server ring (~3 min at 1s)
const RANGES = ['live', '30m', '1h', '6h', '24h', '7d', '30d'];
const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);

const EMPTY_SERIES = { x: [], cpu: [], mem: [], rx: [], tx: [] };

// --- charts ----------------------------------------------------------------

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function chartOpts(el, seriesSpec) {
  const dim = cssVar('--text-dim', '#888');
  const grid = cssVar('--border', '#333') + '66';
  return {
    width: Math.max(120, el.clientWidth || el.parentElement.clientWidth || 240),
    height: 150,
    padding: [6, 8, 2, 2],
    legend: { show: false },
    cursor: { show: false, x: false, y: false },
    scales: { x: { time: true }, y: { range: (u, min, max) => [0, max <= 0 ? 1 : max * 1.15] } },
    axes: [
      { stroke: dim, grid: { stroke: grid }, ticks: { stroke: grid }, font: '9px system-ui', size: 22 },
      { stroke: dim, grid: { stroke: grid }, ticks: { stroke: grid }, font: '9px system-ui', size: 46 },
    ],
    series: [{}, ...seriesSpec],
  };
}

/**
 * A uPlot chart bound to the app theme. Re-created when the theme changes;
 * resized with its container.
 */
function Chart({ label, unit, series, data }) {
  const host = useRef(null);
  const chart = useRef(null);
  const [theme, setTheme] = useState(0);

  useEffect(() => {
    const onTheme = () => setTheme(n => n + 1);
    document.addEventListener('theme-changed', onTheme);
    return () => document.removeEventListener('theme-changed', onTheme);
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el) return undefined;
    const p = { accent: cssVar('--accent', '#1e66f5'), green: cssVar('--green', '#40a02b'), peach: cssVar('--peach', '#fe640b'), mauve: cssVar('--mauve', '#8839ef') };
    const strokes = series.map(k => p[k] || p.accent);
    chart.current = new uPlot(
      chartOpts(el, strokes.map(c => ({ stroke: c, width: 1.5, ...(series.length === 1 ? { fill: c + '22' } : {}) }))),
      [[], ...series.map(() => [])],
      el,
    );
    const ro = new ResizeObserver(() => {
      const c = chart.current;
      if (c && el.clientWidth) { try { c.setSize({ width: Math.max(120, el.clientWidth), height: 150 }); } catch { /* detached */ } }
    });
    try { ro.observe(el); } catch { /* jsdom */ }
    return () => {
      ro.disconnect();
      if (chart.current) { try { chart.current.destroy(); } catch { /* already gone */ } chart.current = null; }
    };
  }, [theme]);

  useEffect(() => {
    if (chart.current && data) { try { chart.current.setData(data); } catch { /* chart disposed */ } }
  }, [data, theme]);

  return html`<div class="card chart-card">
    <div class="card-title">${label} <span class="ov-unit">${unit}</span></div>
    <div class="ov-chart" ref=${host}></div>
  </div>`;
}

// --- 2FA -------------------------------------------------------------------

const ICON = {
  copy: html`<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`,
  refresh: html`<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`,
  ok: html`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>`,
  bad: html`<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
};

/** Modal shell used by both 2FA dialogs. */
function Dialog({ children, onClose }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return html`<div class="overlay" onClick=${e => { if (e.target.classList.contains('overlay')) onClose(); }}>
    <div class="dialog totp-dialog">${children}</div>
  </div>`;
}

function EnableTotp({ onClose, onChanged }) {
  const [secret, setSecret] = useState('');
  const [url, setUrl] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('');     // '' | 'ok' | 'bad'
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [confirming, setConfirming] = useState(false);

  async function applySecret(s, u) {
    const link = u || `otpauth://totp/${encodeURIComponent('edlics_' + (location.hostname || 'host') + '_' + s.slice(0, 4))}?secret=${s}&issuer=edlics&algorithm=SHA1&digits=6&period=30`;
    setSecret(s);
    setUrl(link);
    setCode('');
    setStatus('');
    setQr('');
    try {
      const m = await import('/qr.mjs');
      setQr(await m.qrSvg(link, { width: 150, margin: 0 }));
    } catch { /* QR is optional — the key can be typed by hand */ }
  }

  // Enrolling is idempotent: an existing pending key is returned unchanged.
  useEffect(() => {
    let alive = true;
    api('POST', '/api/sys/totp/enroll', {})
      .then(r => {
        if (!alive) return;
        if (r.error) { setErr(r.error); return; }
        applySecret(r.secret, r.url);
      })
      .catch(e => { if (alive) setErr(e.message); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, []);

  // Live verification once six digits are present.
  useEffect(() => {
    const digits = code.replace(/\D/g, '');
    if (digits.length < 6) { setStatus(''); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      api('POST', '/api/sys/totp/verify', { code: digits })
        .then(r => { if (alive) setStatus(r && r.valid ? 'ok' : 'bad'); })
        .catch(() => { if (alive) setStatus('bad'); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [code]);

  async function regenerate() {
    const r = await api('POST', '/api/sys/totp/regenerate', {});
    if (r.error) { toast(r.error, true); return; }
    await applySecret(r.secret, r.url);
    toast('New key generated');
  }

  async function confirm() {
    setConfirming(true);
    try {
      const r = await api('POST', '/api/sys/totp/confirm', { code: code.trim() });
      if (r.error) { toast(r.error, true); setStatus('bad'); return; }
      toast('Two-factor enabled');
      onChanged();
      onClose();
    } finally { setConfirming(false); }
  }

  const copy = txt => copyToClipboard(txt).then(() => toast('Copied')).catch(() => {});

  if (busy) return html`<${Dialog} onClose=${onClose}><${Spinner} text="Loading…" /></${Dialog}>`;
  if (err) return html`<${Dialog} onClose=${onClose}>
    <h3>Enable two-factor authentication</h3>
    <p class="dlg-sub">${err}</p>
    <div class="btn-row"><button class="cancel" onClick=${onClose}>Close</button></div>
  </${Dialog}>`;

  return html`<${Dialog} onClose=${onClose}>
    <h3>Enable two-factor authentication</h3>
    <p class="dlg-sub">Scan this code with an authenticator app, then confirm with a 6-digit code. It stays off until you confirm.</p>
    <div class="totp-grid">
      <div class="totp-qr">
        ${qr ? html`<div dangerouslySetInnerHTML=${{ __html: qr }}></div>` : html`<span class="muted">QR unavailable</span>`}
      </div>
      <div class="totp-side">
        <p class="totp-help">Or enter the key manually. Works with Google Authenticator, Authy, 1Password, and browser extensions such as “Authenticator: 2FA Client”.</p>
        <div class="totp-key">
          <code>${secret}</code>
          <button class="icon-btn sm" title="Generate a new key" onClick=${regenerate}>${ICON.refresh}</button>
        </div>
        <div class="totp-actions">
          <button class="copy-btn" onClick=${() => copy(secret)}>${ICON.copy}secret</button>
          <button class="copy-btn" onClick=${() => copy(url)}>${ICON.copy}setup link</button>
        </div>
      </div>
    </div>
    <div class="totp-warn">Keep a backup of the key. If the device is lost, disable 2FA on the server with <code>edlics reset-2fa</code>.</div>
    <label class="dlg-label" for="totpConfirmCode">6-digit code</label>
    <div class="totp-code-row">
      <input id="totpConfirmCode" inputMode="numeric" autoComplete="one-time-code" maxLength="8"
        placeholder="123 456" value=${code} onInput=${e => setCode(e.target.value)}
        onKeyDown=${e => { if (e.key === 'Enter' && status === 'ok') confirm(); }} />
      <span class=${'code-icon ' + status} aria-live="polite">${status === 'ok' ? ICON.ok : status === 'bad' ? ICON.bad : null}</span>
    </div>
    <div class="btn-row">
      <button class="cancel" onClick=${onClose}>Cancel</button>
      <button class="primary" disabled=${status !== 'ok' || confirming} onClick=${confirm}>Confirm</button>
    </div>
  </${Dialog}>`;
}

function DisableTotp({ onClose, onChanged }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function disable() {
    setBusy(true);
    try {
      const r = await api('POST', '/api/sys/totp/disable', { code: code.trim() });
      if (r.error) { toast(r.error, true); return; }
      toast('Two-factor disabled');
      onChanged();
      onClose();
    } finally { setBusy(false); }
  }

  return html`<${Dialog} onClose=${onClose}>
    <h3>Disable two-factor authentication</h3>
    <p class="dlg-sub">Enter a current code to turn it off.</p>
    <label class="dlg-label" for="totpDisableCode">6-digit code</label>
    <input id="totpDisableCode" inputMode="numeric" autoComplete="one-time-code" maxLength="8" placeholder="123 456"
      value=${code} onInput=${e => setCode(e.target.value)}
      onKeyDown=${e => { if (e.key === 'Enter') disable(); }} autoFocus />
    <div class="btn-row">
      <button class="cancel" onClick=${onClose}>Cancel</button>
      <button class="primary danger" disabled=${busy || !code.trim()} onClick=${disable}>Disable</button>
    </div>
  </${Dialog}>`;
}

// --- info cards ------------------------------------------------------------

function InfoCards({ info, disk }) {
  if (!info) return html`<div class="dash-cards"><${Spinner} text="Loading…" /></div>`;
  const memTotal = info.memTotal || 0;
  const memUsed = Math.max(0, memTotal - (info.memAvailable || info.memFree || 0));
  const swapP = pctOf(info.swapUsed, info.swapTotal);
  const loadP = (info.cores && info.load && info.load[0] != null) ? Math.min(100, 100 * info.load[0] / info.cores) : null;
  const cpuStr = info.virt
    ? `${info.cores} vCPU (${info.virt})`
    : (info.cpuCores && info.cpuThreads)
      ? `${info.cores} (${info.cpuCores} cores × ${info.cpuThreads} threads)`
      : `${info.cores}`;   // older server without topology fields

  const rows = [
    ['Host', info.hostname, null],
    ['IP', info.ip || '—', null],
    ['OS', info.os, null],
    ['Kernel', info.kernel, null],
    ['Arch', info.arch, null],
    ['Uptime', fmtUptime(info.uptime), null],
    ['CPU', cpuStr, null, info.cpuModel || ''],
    ['Memory', `${fmtBytes(memUsed)} / ${fmtBytes(memTotal)}`, pctOf(memUsed, memTotal)],
    ['Swap', info.swapTotal ? `${fmtBytes(info.swapUsed)} / ${fmtBytes(info.swapTotal)}` : 'none', swapP],
    ['Load', (info.load || []).join(' '), loadP],
    ['Disk /', disk ? disk.text : '…', disk ? disk.pct : 0],
    ['Node', info.node, null],
  ];

  return html`<div class="dash-cards">
    ${rows.map(([k, v, p, title]) => html`<div class="ov-row" key=${k}>
      <span class="ov-k">${k}</span>
      ${p != null
        ? html`<span class="ov-meter"><span class="ov-v" title=${title || v}>${v}</span><${Ring} pct=${p} /></span>`
        : html`<span class="ov-v" title=${title || v}>${v}</span>`}
    </div>`)}
  </div>`;
}

// --- processes -------------------------------------------------------------

const SORTABLE = new Set(['pid', 'cpu', 'mem']);

function Processes() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ total: 0, load: [], cores: 0 });
  const [sort, setSort] = useState('cpu');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const write = canWrite();
  // Keep the current filter/sort in a ref so the poller never needs rebinding.
  const params = useRef({ sort, q });
  params.current = { sort, q };

  async function load() {
    try {
      const { sort: s, q: query } = params.current;
      const d = await api('GET', `/api/sys/processes?sort=${s}&limit=120${query ? '&q=' + encodeURIComponent(query) : ''}`);
      if (d.error) return;
      setRows(d.processes || []);
      setMeta({ total: d.total || 0, load: d.load || [], cores: d.cores || 0 });
    } catch { /* transient */ }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [sort]);
  useEffect(() => {
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  async function signalDialog(pid, name) {
    const sig = await choiceDialog(`Signal PID ${pid}`, name || '', [
      { label: 'Terminate (TERM)', value: 'TERM' },
      { label: 'Kill (KILL)', value: 'KILL', danger: true },
      { label: 'HUP', value: 'HUP' },
      { label: 'INT', value: 'INT' },
      { label: 'STOP', value: 'STOP' },
      { label: 'CONT', value: 'CONT' },
    ]);
    if (!sig) return;
    try {
      const r = await api('POST', '/api/sys/processes/kill', { pid, signal: sig });
      if (r.error) toast(r.error, true); else toast(`${sig} → ${name || pid}`);
    } catch (e) { toast('signal failed: ' + e.message, true); }
    load();
  }

  const col = (label, key, extra = '') => html`<span class=${'proc-col ' + extra + (SORTABLE.has(key) ? ' proc-sortable' : '') +
      (key && sort === key ? ' active' : '')} onClick=${key && SORTABLE.has(key) ? () => setSort(key) : null}>${label}</span>`;

  return html`<${Fragment}>
    <div class="section-sep">
      <div class="section-head-left">
        <h2 class="section-h2">Processes</h2>
        ${meta.total ? html`<span class="section-sub"><b class="section-count">${meta.total}</b> processes</span>` : null}
      </div>
      <div class="search-input-wrap">
        <input placeholder="Filter by name, command or PID…" spellCheck="false" value=${q}
          onInput=${e => { setQ(e.target.value); }} onKeyDown=${e => { if (e.key === 'Enter') load(); }} />
      </div>
      <button class="icon-btn" title="Refresh" onClick=${load}>
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V5q0-.425.288-.712T19 4t.713.288T20 5v5q0 .425-.288.713T19 11h-5q-.425 0-.712-.288T13 10t.288-.712T14 9h3.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.7 0 3.113-.862t2.187-2.313q.2-.35.563-.487t.737-.013q.4.125.575.525t-.025.75q-1.025 2-2.925 3.2T12 20"/></svg>
      </button>
    </div>
    <div class="proc-scroll">
      <div class="proc-head">
        ${col('PID', 'pid', 'proc-pid')}
        ${col('USER', null, 'proc-user')}
        ${col('CPU%', 'cpu', 'proc-num')}
        ${col('MEM%', 'mem', 'proc-num')}
        ${col('RSS', null, 'proc-num')}
        ${col('S', null, 'proc-st')}
        ${col('COMMAND', null, 'proc-cmd')}
        ${write ? col('', null, 'proc-act') : null}
      </div>
      <div class="proc-table">
        ${rows.length ? rows.map(p => html`<div class="proc-row" key=${p.pid}
            title=${`pid ${p.pid} · ppid ${p.ppid} · ${p.stateLabel} · cpu-time ${p.time}s · up ${p.elapsed}s`}>
          <span class="proc-col proc-pid">${p.pid}</span>
          <span class="proc-col proc-user">${p.user}</span>
          <span class="proc-col proc-num">${p.cpu.toFixed(1)}</span>
          <span class="proc-col proc-num">${p.mem.toFixed(1)}</span>
          <span class="proc-col proc-num">${fmtRss(p.rss)}</span>
          <span class=${'proc-col proc-st proc-st-' + p.state}>${p.state}</span>
          <span class="proc-col proc-cmd">${p.cmd || p.name}</span>
          ${write ? html`<span class="proc-col proc-act">
            <button title=${'Signal ' + p.name} onClick=${() => signalDialog(p.pid, p.name)}>kill</button>
          </span>` : null}
        </div>`) : html`<div class="panel-placeholder">${loading ? 'Loading…' : 'No matches'}</div>`}
      </div>
    </div>
  </${Fragment}>`;
}

// --- page ------------------------------------------------------------------

export default function Dashboard() {
  const [info, setInfo] = useState(null);
  const [disk, setDisk] = useState(null);
  const [range, setRange] = useState('live');
  const [series, setSeries] = useState(EMPTY_SERIES);
  const [totp, setTotp] = useState({ enabled: false });
  const [dialog, setDialog] = useState('');     // '' | 'enable' | 'disable'
  const [refresh, setRefresh] = useState(0);

  const loadTotp = () => api('GET', '/api/sys/totp').then(s => setTotp(s || { enabled: false })).catch(() => {});

  useEffect(() => {
    let alive = true;
    api('GET', '/api/sys/info').then(d => { if (alive) setInfo(d); }).catch(() => {});
    api('GET', '/api/sys/disk').then(d => {
      if (!alive) return;
      const root = (d.mounts || []).find(m => m.mount === '/') || (d.mounts || [])[0];
      if (root) setDisk({ pct: parsePct(root.pct), text: `${root.used} / ${root.size} (${root.pct})` });
    }).catch(() => {});
    loadTotp();
    return () => { alive = false; };
  }, [refresh]);

  // Live SSE stream, or a one-shot history query for the selected range.
  useEffect(() => {
    if (range !== 'live') {
      let alive = true;
      api('GET', `/api/sys/metrics?range=${encodeURIComponent(range)}`)
        .then(d => {
          if (!alive || !d || d.error || !d.points) return;
          setSeries({
            x: d.points.map(r => r.ts),
            cpu: d.points.map(r => r.cpu),
            mem: d.points.map(r => (r.mem_total ? 100 * r.mem_used / r.mem_total : 0)),
            rx: d.points.map(r => (r.net_rx || 0) / 60 / 1024),   // per-minute bytes → KB/s
            tx: d.points.map(r => (r.net_tx || 0) / 60 / 1024),
          });
        })
        .catch(() => {});
      return () => { alive = false; };
    }

    const trim = a => a.length > MAX_POINTS ? a.slice(-MAX_POINTS) : a;
    const es = new EventSource('/api/sys/metrics/stream');
    es.addEventListener('history', e => {
      try {
        const ring = JSON.parse(e.data).ring || [];
        setSeries({
          x: ring.map(s => s.t / 1000),
          cpu: ring.map(s => s.cpu),
          mem: ring.map(s => (s.memTotal ? 100 * s.memUsed / s.memTotal : 0)),
          rx: ring.map(s => (s.netRxRate || 0) / 1024),
          tx: ring.map(s => (s.netTxRate || 0) / 1024),
        });
      } catch { /* malformed history frame */ }
    });
    es.onmessage = e => {
      let s;
      try { s = JSON.parse(e.data); } catch { return; }
      setSeries(prev => ({
        x: trim([...prev.x, s.t / 1000]),
        cpu: trim([...prev.cpu, s.cpu]),
        mem: trim([...prev.mem, s.memTotal ? 100 * s.memUsed / s.memTotal : 0]),
        rx: trim([...prev.rx, (s.netRxRate || 0) / 1024]),
        tx: trim([...prev.tx, (s.netTxRate || 0) / 1024]),
      }));
    };
    return () => es.close();
  }, [range, refresh]);

  const onChanged = () => { loadTotp(); setRefresh(n => n + 1); };

  return html`<section class="page dash">
    <header class="page-header">
      <h1 class="page-h1">Dashboard</h1>
      <div class="page-actions">
        <select class="ov-range" title="Data range" value=${range} onChange=${e => setRange(e.target.value)}>
          ${RANGES.map(r => html`<option value=${r} key=${r}>${r === 'live' ? 'Live' : r}</option>`)}
        </select>
        <button class="icon-btn" title="Refresh" onClick=${() => setRefresh(n => n + 1)}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 20q-3.35 0-5.675-2.325T4 12t2.325-5.675T12 4q1.725 0 3.3.712T18 6.75V5q0-.425.288-.712T19 4t.713.288T20 5v5q0 .425-.288.713T19 11h-5q-.425 0-.712-.288T13 10t.288-.712T14 9h3.2q-.8-1.4-2.187-2.2T12 6Q9.5 6 7.75 7.75T6 12t1.75 4.25T12 18q1.7 0 3.113-.862t2.187-2.313q.2-.35.563-.487t.737-.013q.4.125.575.525t-.025.75q-1.025 2-2.925 3.2T12 20"/></svg>
        </button>
        <button class=${'icon-btn' + (totp.enabled ? ' on' : '')}
          title=${totp.enabled ? 'Two-factor authentication: ON — click to manage' : 'Two-factor authentication: OFF — click to enable'}
          aria-pressed=${totp.enabled}
          onClick=${() => setDialog(totp.enabled ? 'disable' : 'enable')}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M12 8a1 1 0 0 1 1 1a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1m9 3c0 5.55-3.84 10.74-9 12c-5.16-1.26-9-6.45-9-12V5l9-4l9 4zm-9-5a3 3 0 0 0-3 3c0 1.31.83 2.42 2 2.83V18h2v-2h2v-2h-2v-2.17c1.17-.41 2-1.52 2-2.83a3 3 0 0 0-3-3"/></svg>
        </button>
        <button class="icon-btn" title="Sign out" onClick=${() => import('../auth.mjs').then(m => m.logout())}>
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>
        </button>
      </div>
    </header>
    <div class="page-body">
      <${InfoCards} info=${info} disk=${disk} />
      <div class="dash-charts">
        <${Chart} label="CPU" unit="%" series=${['cpu']} data=${[series.x, series.cpu]} />
        <${Chart} label="Memory" unit="%" series=${['mem']} data=${[series.x, series.mem]} />
        <${Chart} label="Network" unit="KB/s" series=${['rx', 'tx']} data=${[series.x, series.rx, series.tx]} />
      </div>
      <${Processes} />
    </div>
    ${dialog === 'enable' ? html`<${EnableTotp} onClose=${() => setDialog('')} onChanged=${onChanged} />` : null}
    ${dialog === 'disable' ? html`<${DisableTotp} onClose=${() => setDialog('')} onChanged=${onChanged} />` : null}
  </section>`;
}
