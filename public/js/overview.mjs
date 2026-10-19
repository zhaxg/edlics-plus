// overview.mjs — admin overview panel: system info + live/history charts.
//
// Data path: SSE (/api/sys/metrics/stream) for the live view, SQLite-backed
// history (/api/sys/metrics?range=…) when a range is picked. uPlot renders.
import { api, escapeHtml, toast, copyToClipboard, openDialog } from './api.mjs';
import { uPlot } from '/charts.mjs';

const MAX_POINTS = 180;         // matches the server ring (~3 min at 1s)
const buf = { xs: [], cpu: [], mem: [], netRx: [], netTx: [] };

let cpuChart = null, memChart = null, netChart = null;
let es = null;                  // EventSource for live mode
let range = 'live';
let initialized = false;

// --- formatting ------------------------------------------------------------

function fmtBytes(n) {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + u[i];
}

function fmtUptime(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function palette() {
  return {
    accent: cssVar('--accent', '#1e66f5'),
    green: cssVar('--green', '#40a02b'),
    peach: cssVar('--peach', '#fe640b'),
    mauve: cssVar('--mauve', '#8839ef'),
    dim: cssVar('--text-dim', '#888'),
    grid: cssVar('--border', '#333') + '66',
  };
}

// --- charts ----------------------------------------------------------------

function chartOpts(el, seriesSpec) {
  const p = palette();
  return {
    width: Math.max(120, el.clientWidth || el.parentElement.clientWidth || 240),
    height: 150,
    padding: [6, 8, 2, 2],
    legend: { show: false },
    cursor: { show: false, x: false, y: false },
    scales: { x: { time: true }, y: { range: (u, min, max) => [0, max <= 0 ? 1 : max * 1.15] } },
    axes: [
      { stroke: p.dim, grid: { stroke: p.grid }, ticks: { stroke: p.grid }, font: '9px system-ui', size: 22 },
      { stroke: p.dim, grid: { stroke: p.grid }, ticks: { stroke: p.grid }, font: '9px system-ui', size: 46 },
    ],
    series: [{}, ...seriesSpec],
  };
}

function buildCharts() {
  const p = palette();
  const cpuEl = document.getElementById('ovCpu');
  const memEl = document.getElementById('ovMem');
  const netEl = document.getElementById('ovNet');
  if (!cpuEl || !memEl || !netEl) return;

  if (cpuChart) { cpuChart.destroy(); cpuChart = null; }
  if (memChart) { memChart.destroy(); memChart = null; }
  if (netChart) { netChart.destroy(); netChart = null; }

  cpuChart = new uPlot(chartOpts(cpuEl, [{ stroke: p.accent, width: 1.5, fill: p.accent + '22' }]), [[], []], cpuEl);
  memChart = new uPlot(chartOpts(memEl, [{ stroke: p.green, width: 1.5, fill: p.green + '22' }]), [[], []], memEl);
  netChart = new uPlot(chartOpts(netEl, [
    { stroke: p.peach, width: 1.5 }, { stroke: p.mauve, width: 1.5 },
  ]), [[], [], []], netEl);
}

function resizeCharts() {
  for (const [chart, id] of [[cpuChart, 'ovCpu'], [memChart, 'ovMem'], [netChart, 'ovNet']]) {
    const el = document.getElementById(id);
    if (chart && el) chart.setSize({ width: Math.max(120, el.clientWidth), height: 150 });
  }
}

function render() {
  if (cpuChart) cpuChart.setData([buf.xs, buf.cpu]);
  if (memChart) memChart.setData([buf.xs, buf.mem]);
  if (netChart) netChart.setData([buf.xs, buf.netRx, buf.netTx]);
}

function pushSample(s) {
  buf.xs.push(s.t / 1000);
  buf.cpu.push(s.cpu);
  buf.mem.push(s.memTotal ? (100 * s.memUsed / s.memTotal) : 0);
  buf.netRx.push((s.netRxRate || 0) / 1024);
  buf.netTx.push((s.netTxRate || 0) / 1024);
  for (const k of Object.keys(buf)) if (buf[k].length > MAX_POINTS) buf[k].shift();
  render();
}

function resetBuf() { for (const k of Object.keys(buf)) buf[k] = []; }

// --- data sources ----------------------------------------------------------

function connectLive() {
  if (es) return;
  es = new EventSource('/api/sys/metrics/stream');
  es.addEventListener('history', e => {
    try { resetBuf(); for (const s of JSON.parse(e.data).ring) pushSample(s); } catch {}
  });
  es.onmessage = e => { try { pushSample(JSON.parse(e.data)); } catch {} };
  es.onerror = () => { /* EventSource auto-reconnects */ };
}

function disconnectLive() {
  if (es) { es.close(); es = null; }
}

function loadHistory(rangeKey) {
  disconnectLive();
  api('GET', `/api/sys/metrics?range=${encodeURIComponent(rangeKey)}`)
    .then(data => {
      if (!data || data.error || !data.points) return;
      resetBuf();
      for (const r of data.points) {
        buf.xs.push(r.ts);
        buf.cpu.push(r.cpu);
        buf.mem.push(r.mem_total ? (100 * r.mem_used / r.mem_total) : 0);
        buf.netRx.push((r.net_rx || 0) / 60 / 1024);   // per-minute bytes → KB/s
        buf.netTx.push((r.net_tx || 0) / 60 / 1024);
      }
      render();
    })
    .catch(() => {});
}

// --- system info -----------------------------------------------------------

function renderInfo(info) {
  const box = document.getElementById('ovInfo');
  if (!box || !info) return;
  const rows = [
    ['Host', info.hostname],
    ['OS', info.os],
    ['Kernel', info.kernel],
    ['Arch', info.arch],
    ['CPU', `${info.cores}× ` + (info.cpuModel || 'unknown')],
    ['Memory', `${fmtBytes(info.memTotal)}`],
    ['Uptime', fmtUptime(info.uptime)],
    ['Node', info.node],
  ];
  box.innerHTML = rows.map(([k, v]) =>
    `<div class="ov-row"><span class="ov-k">${k}</span><span class="ov-v" title="${v}">${v}</span></div>`
  ).join('');
}

function loadInfo() {
  api('GET', '/api/sys/info').then(renderInfo).catch(() => {});
}

// --- two-factor auth control ------------------------------------------------

let totpState = { enabled: false, pending: false };

function updateTotpButton() {
  const btn = document.getElementById('btnTotp');
  if (!btn) return;
  btn.classList.toggle('on', totpState.enabled);
  btn.title = totpState.enabled
    ? 'Two-factor authentication: ON — click to manage'
    : 'Two-factor authentication: OFF — click to enable';
}

function loadTotp() {
  api('GET', '/api/sys/totp')
    .then(s => { totpState = s || { enabled: false, pending: false }; updateTotpButton(); })
    .catch(() => {});
}

function openTotpDialog() {
  if (totpState.enabled) return openDisableDialog();
  return openEnableDialog();
}

const COPY_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const REFRESH_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';
const CODE_OK = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-11"/></svg>';
const CODE_BAD = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

async function openEnableDialog() {
  const en = await api('POST', '/api/sys/totp/enroll', {});
  if (en.error) { toast(en.error, true); return; }
  let secret = en.secret;
  let url = en.url || '';
  const { overlay, content } = openDialog(`
    <h3>Enable two-factor authentication</h3>
    <p class="dlg-sub">Scan this code with an authenticator app, then confirm with a 6-digit code. It stays off until you confirm.</p>
    <div class="totp-grid">
      <div class="totp-qr" id="totpQr"></div>
      <div class="totp-side">
        <p class="totp-help">Or enter the key manually. Works with Google Authenticator, Authy, 1Password, and browser extensions such as &ldquo;Authenticator: 2FA Client&rdquo;.</p>
        <div class="totp-key">
          <code id="totpSecretText"></code>
          <button class="icon-btn sm" id="totpRegen" title="Generate a new key">${REFRESH_ICON}</button>
        </div>
        <div class="totp-actions">
          <button class="copy-btn" id="totpCopyKey">${COPY_ICON}secret</button>
          <button class="copy-btn" id="totpCopyUrl">${COPY_ICON}setup link</button>
        </div>
      </div>
    </div>
    <div class="totp-warn">Keep a backup of the key. If the device is lost, disable 2FA on the server with <code>edlics reset-2fa</code>.</div>
    <label class="dlg-label" for="totpConfirmCode">6-digit code</label>
    <div class="totp-code-row">
      <input id="totpConfirmCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123 456" />
      <span id="totpCodeIcon" class="code-icon" aria-live="polite"></span>
    </div>
    <div class="btn-row">
      <button class="cancel" id="totpCancelBtn">Cancel</button>
      <button class="primary" id="totpConfirmBtn" disabled>Confirm</button>
    </div>`);
  content.classList.add('totp-dialog');

  const secretEl = content.querySelector('#totpSecretText');
  const qrEl = content.querySelector('#totpQr');
  const input = content.querySelector('#totpConfirmCode');
  const confirmBtn = content.querySelector('#totpConfirmBtn');
  const icon = content.querySelector('#totpCodeIcon');
  const setValid = v => { confirmBtn.disabled = !v; };
  let vtimer = null;

  async function applySecret(s) {
    secret = s;
    url = `otpauth://totp/Edlics:admin?secret=${encodeURIComponent(s)}&issuer=Edlics&algorithm=SHA1&digits=6&period=30`;
    secretEl.textContent = s;
    try { const m = await import('/qr.mjs'); qrEl.innerHTML = await m.qrSvg(url, { width: 150, margin: 0 }); }
    catch { qrEl.innerHTML = '<span class="muted">QR unavailable</span>'; }
    input.value = ''; setValid(false); icon.className = 'code-icon'; icon.innerHTML = '';
    input.focus();
  }
  await applySecret(secret);

  content.querySelector('#totpRegen').onclick = async () => {
    const r = await api('POST', '/api/sys/totp/regenerate', {});
    if (r.error) { toast(r.error, true); return; }
    await applySecret(r.secret);
    toast('New key generated');
  };
  content.querySelector('#totpCopyKey').onclick = () => copyToClipboard(secret).then(() => toast('Key copied')).catch(() => {});
  content.querySelector('#totpCopyUrl').onclick = () => copyToClipboard(url).then(() => toast('Link copied')).catch(() => {});
  input.oninput = () => {
    const code = input.value.replace(/\D/g, '');
    clearTimeout(vtimer);
    setValid(false);
    icon.className = 'code-icon'; icon.innerHTML = '';
    if (code.length < 6) return;
    vtimer = setTimeout(async () => {
      try {
        const r = await api('POST', '/api/sys/totp/verify', { code });
        if (r && r.valid) { setValid(true); icon.className = 'code-icon ok'; icon.innerHTML = CODE_OK; }
        else { setValid(false); icon.className = 'code-icon bad'; icon.innerHTML = CODE_BAD; }
      } catch { setValid(false); icon.className = 'code-icon bad'; icon.innerHTML = CODE_BAD; }
    }, 250);
  };
  input.onkeydown = e => { if (e.key === 'Enter' && !confirmBtn.disabled) confirmBtn.click(); };
  // Cancel just closes the dialog — the pending key is kept so it stays
  // stable across opens (use the refresh button to mint a new one).
  content.querySelector('#totpCancelBtn').onclick = () => { overlay.classList.add('hidden'); };
  confirmBtn.onclick = async () => {
    const code = input.value.trim();
    if (!code) return;
    const r = await api('POST', '/api/sys/totp/confirm', { code });
    if (r.error) { toast(r.error, true); setValid(false); icon.className = 'code-icon bad'; icon.innerHTML = CODE_BAD; return; }
    overlay.classList.add('hidden');
    toast('Two-factor enabled');
    loadTotp();
  };
}

function openDisableDialog() {
  const { overlay, content } = openDialog(`
    <h3>Disable two-factor authentication</h3>
    <p class="dlg-sub">Enter a current code to turn it off.</p>
    <label class="dlg-label" for="totpDisableCode">6-digit code</label>
    <input id="totpDisableCode" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="123 456" />
    <div class="btn-row">
      <button class="cancel" id="totpDisableCancel">Cancel</button>
      <button class="primary danger" id="totpDisableBtn">Disable</button>
    </div>`);
  content.classList.add('totp-dialog');
  const input = content.querySelector('#totpDisableCode');
  input.focus();
  content.querySelector('#totpDisableCancel').onclick = () => overlay.classList.add('hidden');
  content.querySelector('#totpDisableBtn').onclick = async () => {
    const r = await api('POST', '/api/sys/totp/disable', { code: input.value.trim() });
    if (r.error) { toast(r.error, true); return; }
    overlay.classList.add('hidden');
    toast('Two-factor disabled');
    loadTotp();
  };
  input.onkeydown = e => { if (e.key === 'Enter') content.querySelector('#totpDisableBtn').click(); };
}

// --- lifecycle -------------------------------------------------------------

export function refreshOverview() {
  const body = document.getElementById('overviewBody');
  if (!body) return;
  if (!initialized) { initialized = true; buildCharts(); }
  loadInfo();
  loadTotp();
  if (range === 'live') { connectLive(); } else { loadHistory(range); }
}

export function initOverview() {
  const tbtn = document.getElementById('btnTotp');
  if (tbtn) tbtn.addEventListener('click', openTotpDialog);
  const rangeSel = document.getElementById('ovRange');
  if (rangeSel) {
    rangeSel.addEventListener('change', () => {
      range = rangeSel.value;
      if (range === 'live') { resetBuf(); connectLive(); }
      else loadHistory(range);
    });
  }
  const btn = document.getElementById('btnOverviewRefresh');
  if (btn) btn.addEventListener('click', refreshOverview);

  document.addEventListener('view-changed', e => {
    if (e.detail && e.detail.view === 'overview') {
      refreshOverview();
      setTimeout(() => { if (initialized) resizeCharts(); }, 0);
    }
  });
  window.addEventListener('resize', () => { if (initialized) resizeCharts(); });
  document.addEventListener('theme-changed', () => {
    if (!initialized) return;
    buildCharts();
    render();
  });
  document.addEventListener('workspace-changed', () => { if (initialized && range === 'live') connectLive(); });
}
