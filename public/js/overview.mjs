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

async function openEnableDialog() {
  const en = await api('POST', '/api/sys/totp/enroll', {});
  if (en.error) { toast(en.error, true); return; }
  const secret = en.secret;
  const url = `otpauth://totp/Edlics:admin?secret=${encodeURIComponent(secret)}&issuer=Edlics&algorithm=SHA1&digits=6&period=30`;
  let qr = '';
  try { const m = await import('/qr.mjs'); qr = await m.qrSvg(url); } catch { /* QR is optional */ }
  const { overlay, content } = openDialog(`
    <h3>Enable two-factor authentication</h3>
    <ol class="totp-steps">
      <li>打开认证器 App / 客户端 / 浏览器扩展（如 Google Authenticator、Authy、1Password，或浏览器的 “Authenticator: 2FA Client” 扩展）。</li>
      <li>扫描下方二维码，或手动输入密钥：</li>
    </ol>
    <div class="totp-qr">${qr || '<span class="muted">QR unavailable — use the key below</span>'}</div>
    <div class="totp-secretline">
      <code class="totp-code">${escapeHtml(secret)}</code>
      <button class="sec-btn" id="totpCopySecret">Copy key</button>
      <button class="sec-btn" id="totpCopyUrl">Copy link</button>
    </div>
    <ol class="totp-steps" start="3">
      <li>输入认证器当前显示的 6 位码，<b>确认后才会生效</b>：</li>
    </ol>
    <div class="totp-confirm">
      <input id="totpConfirmCode" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位动态码" maxlength="8" />
      <button class="primary" id="totpConfirmBtn">Confirm</button>
      <button class="cancel" id="totpCancelBtn">Cancel</button>
    </div>
    <div class="totp-note">备份密钥：设备丢失将无法登录，可用 <code>edlics reset-2fa</code> 在服务器上恢复。</div>`);
  content.querySelector('#totpCopySecret').onclick = () => copyToClipboard(secret).then(() => toast('Copied')).catch(() => {});
  content.querySelector('#totpCopyUrl').onclick = () => copyToClipboard(url).then(() => toast('Copied')).catch(() => {});
  const input = content.querySelector('#totpConfirmCode');
  input.focus();
  content.querySelector('#totpCancelBtn').onclick = async () => {
    await api('POST', '/api/sys/totp/cancel', {}).catch(() => {});
    overlay.classList.add('hidden');
    loadTotp();
  };
  content.querySelector('#totpConfirmBtn').onclick = async () => {
    const code = input.value.trim();
    if (!code) return;
    const r = await api('POST', '/api/sys/totp/confirm', { code });
    if (r.error) { toast(r.error, true); return; }
    overlay.classList.add('hidden');
    toast('2FA enabled');
    loadTotp();
  };
  input.onkeydown = e => { if (e.key === 'Enter') content.querySelector('#totpConfirmBtn').click(); };
}

function openDisableDialog() {
  const { overlay, content } = openDialog(`
    <h3>Disable two-factor authentication</h3>
    <p style="color:var(--text-dim);font-size:12px;margin-bottom:10px;">Enter a current 6-digit code to confirm.</p>
    <input id="totpDisableCode" inputmode="numeric" placeholder="6 位动态码" style="width:100%;" />
    <div class="btn-row" style="margin-top:14px;">
      <button class="cancel" id="totpDisableCancel">Cancel</button>
      <button class="primary danger" id="totpDisableBtn">Disable 2FA</button>
    </div>`);
  const input = content.querySelector('#totpDisableCode');
  input.focus();
  content.querySelector('#totpDisableCancel').onclick = () => overlay.classList.add('hidden');
  content.querySelector('#totpDisableBtn').onclick = async () => {
    const r = await api('POST', '/api/sys/totp/disable', { code: input.value.trim() });
    if (r.error) { toast(r.error, true); return; }
    overlay.classList.add('hidden');
    toast('2FA disabled');
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
