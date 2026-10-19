// overview.mjs — admin overview panel: system info + live/history charts.
//
// Data path: SSE (/api/sys/metrics/stream) for the live view, SQLite-backed
// history (/api/sys/metrics?range=…) when a range is picked. uPlot renders.
import { api, escapeHtml, toast, promptDialog, copyToClipboard, spinner } from './api.mjs';
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

let totpPendingSecret = null;

function renderTotp(status) {
  const box = document.getElementById('ovTotp');
  if (!box) return;
  const enabled = !!(status && status.enabled);
  const pending = !!(status && status.pending) || !!totpPendingSecret;

  if (enabled) {
    box.innerHTML = `<div class="sec-line">
        <span class="sec-state on">Enabled</span>
        <span class="sec-hint">A 6-digit code from your authenticator is required at login.</span>
        <button class="sec-btn danger" id="ovTotpBtn">Disable 2FA</button>
      </div>`;
    box.querySelector('#ovTotpBtn').onclick = async () => {
      const code = await promptDialog('Enter the current 2FA code to disable:', { title: 'Disable 2FA', okLabel: 'Disable', danger: true, placeholder: '123456' });
      if (!code) return;
      const r = await api('POST', '/api/sys/totp/disable', { code });
      if (r.error) toast(r.error, true); else { toast('2FA disabled'); totpPendingSecret = null; loadTotp(); }
    };
    return;
  }

  if (pending) {
    if (!totpPendingSecret) {
      box.innerHTML = spinner('Loading…');
      api('POST', '/api/sys/totp/enroll', {}).then(r => {
        if (r.error) { toast(r.error, true); return; }
        totpPendingSecret = r.secret;
        renderTotp({ pending: true });
      }).catch(() => {});
      return;
    }
    const secret = totpPendingSecret;
    const url = `otpauth://totp/Edlics:admin?secret=${encodeURIComponent(secret)}&issuer=Edlics&algorithm=SHA1&digits=6&period=30`;
    box.innerHTML = `
      <ol class="totp-steps">
        <li>打开认证器 App（Google Authenticator / Authy / 1Password 等）→ 添加账户 → <b>手动输入密钥</b>。</li>
        <li>密钥：<code class="totp-code">${escapeHtml(secret)}</code>
            <button class="sec-btn" data-copy="${escapeHtml(secret)}">复制密钥</button></li>
        <li>或导入链接：<code class="totp-code">${escapeHtml(url)}</code>
            <button class="sec-btn" data-copy="${escapeHtml(url)}">复制链接</button></li>
        <li><b>用 App 显示的 6 位动态码在下面确认后，2FA 才会生效</b>；确认前不影响登录，可随时取消。</li>
      </ol>
      <div class="totp-confirm">
        <input id="totpConfirmCode" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位动态码" maxlength="8" />
        <button class="sec-btn" id="totpConfirmBtn">Confirm &amp; enable</button>
        <button class="sec-btn danger" id="totpCancelBtn">Cancel</button>
      </div>
      <div class="sec-hint" style="margin-top:8px;">⚠ 请备份该密钥：手机丢失后无法登录（可在服务器端重置，见文档）。</div>`;
    box.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      copyToClipboard(b.dataset.copy).then(() => toast('Copied')).catch(() => {});
    }));
    const input = box.querySelector('#totpConfirmCode');
    box.querySelector('#totpConfirmBtn').onclick = async () => {
      const code = input.value.trim();
      if (!code) return;
      const r = await api('POST', '/api/sys/totp/confirm', { code });
      if (r.error) { toast(r.error, true); return; }
      totpPendingSecret = null;
      toast('2FA enabled');
      loadTotp();
    };
    box.querySelector('#totpCancelBtn').onclick = async () => {
      await api('POST', '/api/sys/totp/cancel', {}).catch(() => {});
      totpPendingSecret = null;
      toast('2FA setup cancelled');
      loadTotp();
    };
    input.focus();
    return;
  }

  box.innerHTML = `<div class="sec-line">
      <span class="sec-state off">Disabled</span>
      <span class="sec-hint">Require a 6-digit authenticator code in addition to the password at login.</span>
      <button class="sec-btn" id="ovTotpBtn">Enable 2FA</button>
    </div>`;
  box.querySelector('#ovTotpBtn').onclick = async () => {
    const r = await api('POST', '/api/sys/totp/enroll', {});
    if (r.error) { toast(r.error, true); return; }
    totpPendingSecret = r.secret;
    renderTotp({ pending: true });
  };
}

function loadTotp() { api('GET', '/api/sys/totp').then(renderTotp).catch(() => {}); }

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
