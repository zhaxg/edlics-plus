// views/system.mjs — System page (Preact): nine tabs over one page.
//
//   Users | Services | Scheduled | Interfaces | Routes | Ports | Firewall |
//   Disk | Logs
//
// Every tab is a small self-contained component that owns its fetch, so the
// page only talks to the endpoint it is showing. Services and Scheduled are
// master/detail (list + unit file / journal). Adding a tab = add an entry to
// TABS; nothing else in this file needs to change.
import { html, useState, useEffect, useRef, Fragment } from '/ui.mjs';
import { api, toast, confirmDialog } from '../api.mjs';
import { Page, Tabs, Spinner, Empty, Card, Chip, StatusDot, Fields } from '../components.mjs';
import { useStore, setTab } from '../store.mjs';
import { serverInfo } from '../state.mjs';
import { fmtTime } from '../format.mjs';

const canWrite = () => !!(serverInfo && serverInfo.adminWrite) && !(serverInfo && serverInfo.readonly);

// --- shared bits -----------------------------------------------------------

/** Journal lines rendered with priority colouring. */
function Journal({ unit, lines = 300 }) {
  const [state, setState] = useState({ loading: true, text: '', lines: [] });
  const pre = useRef(null);

  useEffect(() => {
    if (!unit) return undefined;
    let alive = true;
    setState({ loading: true, text: '', lines: [] });
    api('GET', `/api/sys/services/logs?unit=${encodeURIComponent(unit)}&lines=${lines}`)
      .then(r => {
        if (!alive) return;
        if (r.error) return setState({ loading: false, text: r.error, lines: [] });
        const ls = r.lines || [];
        setState({ loading: false, text: ls.length ? '' : '(no journal entries)', lines: ls });
      })
      .catch(e => { if (alive) setState({ loading: false, text: 'Failed: ' + e.message, lines: [] }); });
    return () => { alive = false; };
  }, [unit, lines]);

  // Follow the tail once the lines arrive (matches the old behaviour).
  useEffect(() => {
    if (!state.loading && pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [state]);

  if (state.loading) return html`<${Spinner} text="Loading…" />`;
  if (state.text) return html`<pre class="logs">${state.text}</pre>`;
  return html`<pre class="logs" ref=${pre}>
    ${state.lines.map((l, i) => {
      const cls = l.priority <= 3 ? 'log-err' : l.priority === 4 ? 'log-warn' : '';
      return html`<span class=${cls} key=${i}>${fmtTime(l.ts)} ${l.message}\n</span>`;
    })}
  </pre>`;
}

/** Master/detail scaffold (Services, Scheduled). */
function Split({ left, detail, placeholder }) {
  return html`<div class="split">
    <div class="split-left">${left}</div>
    <div class="split-detail">${detail || html`<div class="panel-placeholder">${placeholder}</div>`}</div>
  </div>`;
}

/** List item used by both master panes. */
function ListItem({ selected, onClick, title, meta, sub, sub2, mono, icon }) {
  return html`<div class=${'ilist-item list-item' + (selected ? ' selected' : '')} onClick=${onClick}>
    <div class="ilist-head">
      ${icon || null}
      <span class=${'ilist-title' + (mono ? ' mono' : '')}>${title}</span>
      ${meta ? html`<span class="ilist-meta">${meta}</span>` : null}
    </div>
    ${sub ? html`<div class=${'ilist-sub' + (mono ? ' mono' : '')}>${sub}</div>` : null}
    ${sub2 ? html`<div class="ilist-sub">${sub2}</div>` : null}
  </div>`;
}

// --- Users -----------------------------------------------------------------

const nonLogin = s => /nologin|false$/i.test(String(s || '')) || /(^|\/)(sync)$/.test(String(s || ''));

function UsersTab() {
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [showSystem, setShowSystem] = useState(false);

  useEffect(() => {
    let alive = true;
    api('GET', '/api/sys/users').then(d => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!data) return html`<${Spinner} text="Loading…" />`;
  const ql = q.toLowerCase();
  const users = (data.users || [])
    .filter(u => !ql || u.name.toLowerCase().includes(ql))
    .filter(u => showSystem || !nonLogin(u.shell));
  const sessions = data.sessions || [];
  const sysCount = (data.users || []).filter(u => nonLogin(u.shell)).length;

  return html`<div class="board">
    <div class="board-cols">
      <section class="net-col">
        <header class="net-col-head">
          <h3>Login users</h3>
          <${Chip} active=${showSystem} title="Include system accounts (no login shell)"
            onClick=${() => setShowSystem(v => !v)}>system (${sysCount})</${Chip}>
          <span class="net-count">${users.length}</span>
        </header>
        <div class="net-col-body">
          ${users.length ? html`<div class="ilist">
            ${users.map(u => html`<div class="ilist-item" key=${u.name}>
              <div class="ilist-head">
                <span class="ilist-title">${u.name}</span>
                <span class="ilist-meta">${u.uid}${u.system ? ' · sys' : ''}</span>
              </div>
              <${Fields} rows=${[
                ['group', `${u.group} (${u.gid})`],
                u.groups && u.groups.length ? ['also in', u.groups.join(', ')] : null,
                ['home', u.home],
                ['shell', u.shell],
              ]} />
            </div>`)}
          </div>` : html`<${Empty}>No login users</${Empty}>`}
        </div>
      </section>
      <section class="net-col">
        <header class="net-col-head"><h3>Sessions</h3><span class="net-count">${sessions.length}</span></header>
        <div class="net-col-body">
          ${sessions.length ? html`<div class="ilist">
            ${sessions.map((s, i) => html`<div class="ilist-item" key=${s.user + s.tty + i}>
              <div class="ilist-head"><span class="ilist-title">${s.user}</span><span class="ilist-meta">${s.tty}</span></div>
              <div class="ilist-sub">${s.from || 'local'}${s.since ? ' · ' + s.since : ''}</div>
            </div>`)}
          </div>` : html`<${Empty}>No active sessions</${Empty}>`}
        </div>
      </section>
    </div>
  </div>`;
}

// --- Services --------------------------------------------------------------

const ACTIVE_CLASS = { active: 'ok', failed: 'err', activating: 'warn', deactivating: 'warn', inactive: 'off', reloading: 'warn' };
const shortName = u => u.replace(/\.service$/, '');

function ServicesTab() {
  const [units, setUnits] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState(null);
  const [dt, setDt] = useState('unit');          // unit | logs
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [unitFile, setUnitFile] = useState('');

  useEffect(() => {
    let alive = true;
    const loaded = units !== null;
    setError('');
    api('GET', '/api/sys/services' + (loaded ? '?refresh=1' : ''))
      .then(d => {
        if (!alive) return;
        if (!d || d.error) { setError((d && d.error) || 'Failed to load services'); if (!loaded) setUnits([]); return; }
        setUnits(d.units || []);
      })
      .catch(e => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [reload]);

  // Unit file for the selected unit.
  useEffect(() => {
    if (!selected) return undefined;
    let alive = true;
    setUnitFile('');
    api('GET', `/api/sys/services/unit?unit=${encodeURIComponent(selected)}`)
      .then(r => {
        if (!alive) return;
        setUnitFile(r.error ? r.error : (r.content || '(empty)'));
      })
      .catch(e => { if (alive) setUnitFile('Failed: ' + e.message); });
    return () => { alive = false; };
  }, [selected]);

  if (!units) return html`<${Spinner} text="Loading…" />`;
  if (error && !units.length) return html`<${Empty}>${error}</${Empty}>`;

  const ql = q.toLowerCase();
  const sysCount = units.filter(u => u.origin === 'system').length;
  const base = showSystem ? units : units.filter(u => u.origin !== 'system');
  const rows = ql ? base.filter(u => u.name.toLowerCase().includes(ql) || (u.description || '').toLowerCase().includes(ql)) : base;
  const u = units.find(x => x.name === selected);

  async function doAction(action) {
    if (!canWrite() || !u) return;
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    if (action === 'stop' || action === 'restart') {
      const okGo = await confirmDialog(`${label} ${u.name}?`, { title: label + ' service', okLabel: label, danger: true });
      if (!okGo) return;
    }
    setBusy(true);
    try {
      const res = await api('POST', '/api/sys/services/action', { unit: u.name, action });
      if (res.error) toast(res.error, true); else toast(`${label} ${shortName(u.name)} ok`);
    } catch (e) { toast('Action failed: ' + e.message, true); }
    setBusy(false);
    setReload(n => n + 1);
  }

  const list = rows.length ? html`<div class="ilist">
      ${rows.map(x => html`<${ListItem} key=${x.name} selected=${x.name === selected} mono=${false}
        onClick=${() => { setSelected(x.name); setDt('unit'); }}
        icon=${html`<${StatusDot} state=${x.active} />`}
        title=${shortName(x.name)}
        meta=${x.sub || ''}
        sub=${x.description || ''}
        sub2=${x.origin === 'system' ? 'system' : ''} />`)}
    </div>` : html`<${Empty}>${units.length
      ? (ql ? 'No matches' : 'No admin services — toggle “system” to show distro services')
      : 'No services'}</${Empty}>`;

  const detail = u ? html`
    <div class="detail-head">
      <${StatusDot} state=${u.active} />
      <span class="detail-title">${u.name}</span>
      <span class="ilist-meta">${u.sub || ''}${u.load ? ' · ' + u.load : ''}</span>
    </div>
    <div class="ilist-sub">${u.description || ''}</div>
    ${canWrite() ? html`<div class="detail-actions">
      <button class="btn sm" disabled=${busy} onClick=${() => doAction('start')}>Start</button>
      <button class="btn sm" disabled=${busy} onClick=${() => doAction('restart')}>Restart</button>
      <button class="btn sm danger" disabled=${busy} onClick=${() => doAction('stop')}>Stop</button>
    </div>` : null}
    <div class="page-tabs detail-tabs">
      <button class=${dt === 'unit' ? 'active' : ''} onClick=${() => setDt('unit')}>Unit file</button>
      <button class=${dt === 'logs' ? 'active' : ''} onClick=${() => setDt('logs')}>Logs</button>
    </div>
    ${dt === 'unit'
      ? html`<div class="detail-pane"><pre class="file">${unitFile || (html`<${Spinner} text="Loading…" />`)}</pre></div>`
      : html`<div class="detail-pane"><${Journal} unit=${u.name} /></div>`}
  ` : null;

  return html`<${Split}
    left=${html`<${Fragment}>
      <div class="split-search">
        <div class="search-input-wrap">
          <input placeholder="Filter services…" spellCheck="false" value=${q} onInput=${e => setQ(e.target.value)} />
        </div>
        <${Chip} active=${showSystem} title="Include distro-provided (system) services"
          onClick=${() => setShowSystem(v => !v)}>system (${sysCount})</${Chip}>
      </div>
      <div class="split-list">${list}</div>
    </${Fragment}>`}
    detail=${detail}
    placeholder="Select a service to see its unit file and logs" />`;
}

// --- Scheduled -------------------------------------------------------------

function ScheduledTab() {
  const [data, setData] = useState(null);
  const [showSystem, setShowSystem] = useState(false);
  const [sel, setSel] = useState(null);      // { type, i }
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api('GET', '/api/sys/cron').then(d => { if (alive) setData(d); }).catch(() => {});
    return () => { alive = false; };
  }, [reload]);

  if (!data) return html`<${Spinner} text="Loading…" />`;

  const jobs = (data.jobs || []).map((j, i) => ({ j, i })).filter(({ j }) => showSystem || j.origin !== 'system');
  const timers = (data.timers || []).map((t, i) => ({ t, i })).filter(({ t }) => showSystem || t.origin !== 'system');
  const sysCount = (data.jobs || []).filter(j => j.origin === 'system').length
    + (data.timers || []).filter(t => t.origin === 'system').length;
  const isSel = (type, i) => sel && sel.type === type && sel.i === i;

  let detail = null;
  if (sel && sel.type === 'job' && data.jobs && data.jobs[sel.i]) {
    const j = data.jobs[sel.i];
    detail = html`<${Fragment}>
      <div class="detail-head">
        <span class="detail-title mono">${j.schedule}</span>
        <span class="ilist-meta">${j.user || ''}</span>
      </div>
      <${Fields} rows=${[['command', j.command], ['source', j.source]]} />
      <div class="detail-section-title">Logs <span class="muted">(${data.daemon || 'cron'})</span></div>
      <div class="detail-pane">
        ${data.daemon
          ? html`<${Journal} unit=${data.daemon} />`
          : html`<pre class="logs">No cron daemon unit detected</pre>`}
      </div>
    </${Fragment}>`;
  } else if (sel && sel.type === 'timer' && data.timers && data.timers[sel.i]) {
    const t = data.timers[sel.i];
    const target = t.activates || t.unit;
    detail = html`<${Fragment}>
      <div class="detail-head"><span class="detail-title mono">${t.unit}</span></div>
      <${Fields} rows=${[
        t.activates ? ['activates', t.activates] : null,
        t.next ? ['next', t.next] : null,
        t.last ? ['last', t.last] : null,
      ]} />
      <div class="detail-section-title">Logs <span class="muted">(${target})</span></div>
      <div class="detail-pane">
        ${/\.service$/.test(target)
          ? html`<${Journal} unit=${target} />`
          : html`<pre class="logs">No service to read logs from</pre>`}
      </div>
    </${Fragment}>`;
  }

  return html`<${Split}
    left=${html`<${Fragment}>
      <div class="split-search">
        <span class="ilist-sub" style="margin:0;margin-right:auto;">cron + timers</span>
        <${Chip} active=${showSystem} title="Include distro-provided tasks"
          onClick=${() => setShowSystem(v => !v)}>system (${sysCount})</${Chip}>
      </div>
      <div class="split-list">
        ${jobs.length || timers.length ? html`<${Fragment}>
          ${jobs.length ? html`<div class="split-group-title">cron jobs</div>
            ${jobs.map(({ j, i }) => html`<${ListItem} key=${'j' + i} selected=${isSel('job', i)}
              title=${j.schedule} mono=${true} meta=${j.user || ''} sub=${j.command} sub2=${j.source}
              onClick=${() => setSel({ type: 'job', i })} />`)}` : null}
          ${timers.length ? html`<div class="split-group-title">systemd timers</div>
            ${timers.map(({ t, i }) => html`<${ListItem} key=${'t' + i} selected=${isSel('timer', i)}
              title=${t.unit} mono=${true} sub=${t.activates ? `activates ${t.activates}` : ''}
              onClick=${() => setSel({ type: 'timer', i })} />`)}` : null}
        </${Fragment}>` : html`<${Empty}>${showSystem
          ? 'No scheduled tasks'
          : 'No admin tasks — toggle “system” to show distro tasks'}</${Empty}>`}
      </div>
    </${Fragment}>`}
    detail=${detail}
    placeholder="Select a cron job or timer to see its logs" />`;
}

// --- Interfaces / Routes / Ports / Firewall --------------------------------

const UNSTABLE = new Set(['temporary', 'deprecated', 'privacy']);

/** Stable addresses only (hide temporary/deprecated/privacy; fall back if all). */
function stableAddrs(list) {
  const shown = (list || []).filter(a => !UNSTABLE.has(a.kind));
  const hasGlobalV6 = arr => arr.some(a => a.family === 'inet6' && a.scope === 'global');
  return (!hasGlobalV6(shown) && hasGlobalV6(list || [])) ? (list || []) : shown;
}

function fmtLft(sec) {
  if (sec == null) return '';
  if (sec >= 86400) return Math.round(sec / 86400) + 'd';
  if (sec >= 3600) return Math.round(sec / 3600) + 'h';
  if (sec >= 60) return Math.round(sec / 60) + 'm';
  return sec + 's';
}

function addrTip(a) {
  if (a.kind === 'link-local') return 'link-local (fe80::)';
  return `${a.kind}${a.preferred != null ? ' · preferred ' + fmtLft(a.preferred) : ''}${a.valid != null ? ' · valid ' + fmtLft(a.valid) : ''}`;
}

/** Data table. `cols`: [{label, num}], `rows`: array of cell arrays (Preact nodes ok). */
function Table({ cols, rows, empty = 'No data' }) {
  return html`<table class="data-table">
    <thead><tr>${cols.map((c, i) => html`<th class=${c.num ? 'num' : ''} key=${i}>${c.label}</th>`)}</tr></thead>
    <tbody>
      ${rows.length
        ? rows.map((r, i) => html`<tr key=${i}>${r.map((cell, j) => html`<td class=${cols[j] && cols[j].num ? 'num' : ''} key=${j}>${cell}</td>`)}</tr>`)
        : html`<tr><td class="empty" colSpan=${cols.length}>${empty}</td></tr>`}
    </tbody>
  </table>`;
}

const isV6 = s => (String(s || '').match(/:/g) || []).length > 1 || String(s || '').startsWith('[');

function PortsTable({ list }) {
  return html`<${Table}
    cols=${[{ label: 'Proto' }, { label: 'Local address' }, { label: 'State' }, { label: 'Process' }]}
    rows=${(list || []).map(s => [
      html`<${Fragment}><span class=${'fam fam-' + (isV6(s.local) ? '6' : '4')}>${isV6(s.local) ? '6' : '4'}</span> ${s.proto}</${Fragment}>`,
      html`<span class="mono">${s.local}</span>`,
      s.state,
      html`<span class="mono muted">${s.process || ''}</span>`,
    ])}
    empty="No data" />`;
}

/** Network payload shared by the Interfaces/Routes/Ports/Firewall tabs. */
function useNetwork() {
  const [state, setState] = useState({ loading: true, net: null, sockets: [], firewall: null, error: '' });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true, error: '' }));
    Promise.all([
      api('GET', '/api/sys/network').catch(() => ({ interfaces: [], routes: [], dns: { nameservers: [], search: [] } })),
      api('GET', '/api/sys/network/sockets').catch(() => ({ sockets: [] })),
      api('GET', '/api/sys/network/firewall').catch(() => ({ firewall: { available: false, tables: 0, chains: 0, rules: 0, list: [] } })),
    ]).then(([net, sock, fw]) => {
      if (!alive) return;
      setState({
        loading: false, error: '',
        net: net || { interfaces: [], route4: [], dns: { nameservers: [], search: [] } },
        sockets: sock.sockets || [],
        firewall: fw.firewall || { available: false, tables: 0, chains: 0, rules: 0, list: [] },
      });
    }).catch(e => { if (alive) setState(s => ({ ...s, loading: false, error: e.message })); });
    return () => { alive = false; };
  }, [reload]);

  return [state, () => setReload(n => n + 1)];
}

function NetworkTab({ kind }) {
  const [s, refresh] = useNetwork();
  const actions = html`<button class="icon-btn" title="Refresh" onClick=${refresh}>↻</button>`;
  if (s.loading && !s.net) return html`<${Fragment}><div class="board-actions">${actions}</div><${Spinner} text="Loading…" /></${Fragment}>`;
  if (s.error) return html`<${Fragment}><div class="board-actions">${actions}</div><${Empty}>${s.error}</${Empty}></${Fragment}>`;
  const n = s.net || {};

  let body;
  if (kind === 'interfaces') {
    const dns = n.dns || { nameservers: [], search: [] };
    body = html`<${Fragment}>
      ${(dns.nameservers || []).length || (dns.search || []).length ? html`<${Card} title="DNS" class="dns-card">
        <div class="dns-row">
          ${(dns.nameservers || []).map(a => html`<span class="ilist-addr mono" key=${a}>${a}</span>`)}
          ${(dns.search || []).length ? html`<span class="ilist-sub" style="margin-left:auto;">search ${dns.search.join(' ')}</span>` : null}
        </div>
      </${Card}>` : null}
      <${Table}
        cols=${[{ label: 'Interface' }, { label: 'State' }, { label: 'MTU', num: true }, { label: 'Addresses' }, { label: 'MAC' }]}
        rows=${(n.interfaces || []).map(i => [
          html`<span class="mono"><${StatusDot} state=${i.state} />${i.name}</span>`,
          i.state || '',
          i.mtu || '',
          html`<span class="mono addrs">
            ${stableAddrs(i.addresses).length
              ? stableAddrs(i.addresses).map((a, k) => html`<${Fragment} key=${k}>
                  <span title=${addrTip(a)}>${a.address}/${a.prefixlen}</span>
                  ${k < stableAddrs(i.addresses).length - 1 ? html`<br />` : null}
                </${Fragment}>`)
              : html`<span class="muted">—</span>`}
          </span>`,
          html`<span class="mono">${i.mac || '—'}</span>`,
        ])} />`;
  } else if (kind === 'routes') {
    body = html`<${Table}
      cols=${[{ label: 'Destination' }, { label: 'Gateway' }, { label: 'Genmask' }, { label: 'Flags' }, { label: 'Metric', num: true }, { label: 'Iface' }]}
      rows=${(n.route4 || []).map(r => [
        html`<span class="mono">${r.destination}</span>`,
        html`<span class="mono">${r.gateway}</span>`,
        html`<span class="mono">${r.genmask}</span>`,
        html`<span class="mono"><span class="fam">${r.flags}</span></span>`,
        r.metric,
        html`<span class="mono">${r.iface}</span>`,
      ])} />`;
  } else if (kind === 'ports') {
    body = html`<${PortsTable} list=${s.sockets} />`;
  } else {
    const f = s.firewall;
    if (!f) body = html`<${Spinner} text="Loading…" />`;
    else if (!f.available) body = html`<${Empty}>nftables not available</${Empty}>`;
    else body = html`<${Fragment}>
      <div class="ilist-sub" style="margin:0 0 8px;">nftables · ${f.tables} tables · ${f.chains} chains · ${f.rules} rules</div>
      <div class="fw-cards">
        ${(f.list || []).map(t => html`<div class="fw-card" key=${t.family + t.name}>
          ${famBadge(t.family)}
          <span class="fw-name">${t.name}</span>
          <span class="fw-meta">${t.chains} chains</span>
        </div>`)}
      </div>
      <div class="disk-title" style="margin-top:16px;">Open (listening) TCP ports</div>
      ${s.sockets.filter(x => /tcp/i.test(x.proto)).length
        ? html`<${PortsTable} list=${s.sockets.filter(x => /tcp/i.test(x.proto))} />`
        : html`<${Empty}>none</${Empty}>`}
    </${Fragment}>`;
  }

  return html`<div class="board">
    <div class="board-actions">${actions}</div>
    ${body}
  </div>`;
}

function famBadge(family) {
  const f = String(family || '');
  if (f === 'ip' || f === 'inet') return html`<${Fragment}>
    <span class="fw-badge">4</span>${f === 'inet' ? html`<span class="fw-badge v6">6</span>` : null}
  </${Fragment}>`;
  if (f === 'ip6') return html`<span class="fw-badge v6">6</span>`;
  return html`<span class="fw-badge other">${f.slice(0, 3)}</span>`;
}

// --- Disk ------------------------------------------------------------------

function DiskBar({ pct }) {
  const n = parseInt(String(pct).replace('%', ''), 10);
  if (!Number.isFinite(n)) return null;
  const cls = n >= 90 ? 'danger' : n >= 75 ? 'warn' : '';
  return html`<span class="disk-bar" title=${pct}>
    <span class=${'disk-bar-fill ' + cls} style=${`width:${Math.min(100, n)}%`}></span>
  </span>`;
}

function DfSection({ rows, empty }) {
  if (!rows || !rows.length) return html`<${Empty}>${empty}</${Empty}>`;
  return html`<div class="disk-table grid6">
    <div class="disk-head">
      <span>Mounted on</span><span>Filesystem</span><span>Size</span><span>Used</span><span>Avail</span><span>Use%</span>
    </div>
    ${rows.map((r, i) => html`<div class="disk-row" key=${i}>
      <span class="disk-mount mono" title=${r.mount}>${r.mount}</span>
      <span class="disk-src mono" title=${r.fs}>${r.fs}</span>
      <span class="disk-num">${r.size}</span>
      <span class="disk-num">${r.used}</span>
      <span class="disk-num">${r.avail}</span>
      <span class="disk-pct"><${DiskBar} pct=${r.pct} /><b>${r.pct}</b></span>
    </div>`)}
  </div>`;
}

function DiskTab() {
  const [data, setData] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    api('GET', '/api/sys/disk').then(d => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
    return () => { alive = false; };
  }, [reload]);

  if (!data) return html`<${Fragment}><div class="board-actions">
    <button class="icon-btn" title="Refresh" onClick=${() => setReload(n => n + 1)}>↻</button>
  </div><${Spinner} text="Loading…" /></${Fragment}>`;

  return html`<div class="board">
    <div class="board-actions"><button class="icon-btn" title="Refresh" onClick=${() => setReload(n => n + 1)}>↻</button></div>
    <div class="disk-section">
      <div class="disk-title">Filesystems <span class="muted">df -h</span></div>
      <${DfSection} rows=${data.mounts} empty="No filesystems" />
    </div>
    <div class="disk-section">
      <div class="disk-title">Block devices <span class="muted">lsblk</span></div>
      ${(data.blockdevices || []).length ? html`<div class="disk-table flexrows">
        ${data.blockdevices.map((d, i) => html`<div class="disk-row" key=${i}>
          <span class="disk-dev mono" style=${`padding-left:${d.depth * 16}px`}>${(d.depth ? '└ ' : '') + d.name}</span>
          <span class="disk-num">${d.size || ''}</span>
          <span class="disk-src">${d.type || ''}${d.fstype ? ' · ' + d.fstype : ''}</span>
          <span class="disk-mount mono">${d.mountpoint || ''}${d.ro ? ' (ro)' : ''}</span>
        </div>`)}
      </div>` : html`<${Empty}>No block devices</${Empty}>`}
    </div>
  </div>`;
}

// --- Logs ------------------------------------------------------------------

const PRIO = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'];
const prioName = n => PRIO[n] || String(n);
const prioClass = n => (n <= 3 ? 'log-err' : n === 4 ? 'log-warn' : n === 5 ? 'log-notice' : '');

const SOURCES = [
  ['all', 'All sources'], ['login', 'Login (sshd)'], ['auth', 'Authentication (authpriv)'],
  ['security', 'Security (audit)'], ['kernel', 'Kernel'],
];
const SINCES = [['1h', 'Last hour'], ['today', 'Today'], ['7d', 'Last 7 days'], ['90d', 'Last 90 days']];
const LEVELS = [['', 'All levels'], ['err', 'Error'], ['warning', 'Warning'], ['notice', 'Notice'], ['info', 'Info'], ['debug', 'Debug']];

function LogsTab() {
  const [source, setSource] = useState('all');
  const [since, setSince] = useState('today');
  const [level, setLevel] = useState('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [lines, setLines] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let alive = true;
    setError('');
    const params = new URLSearchParams({ source, since, lines: '500' });
    if (level) params.set('level', level);
    if (debouncedQ) params.set('q', debouncedQ);
    api('GET', '/api/sys/journal?' + params.toString())
      .then(r => {
        if (!alive) return;
        if (r.error) { setError(r.error); setLines([]); return; }
        setLines(r.lines || []);
      })
      .catch(e => { if (alive) { setError('Failed: ' + e.message); setLines([]); } });
    return () => { alive = false; };
  }, [source, since, level, debouncedQ]);

  const select = (value, onChange, items) => html`<select class="ov-range" value=${value} onChange=${e => onChange(e.target.value)}>
    ${items.map(([v, label]) => html`<option value=${v} key=${v}>${label}</option>`)}
  </select>`;

  return html`<div class="logs-view">
    <div class="logs-toolbar">
      ${select(source, setSource, SOURCES)}
      ${select(since, setSince, SINCES)}
      ${select(level, setLevel, LEVELS)}
      <div class="search-input-wrap">
        <input placeholder="keyword filter…" spellCheck="false" value=${q} onInput=${e => setQ(e.target.value)} />
      </div>
      <button class="icon-btn" title="Refresh"
        onClick=${() => setDebouncedQ(x => x + '\u200b')}>↻</button>
      <span class="logs-count">${lines && lines.length ? `${lines.length} lines` : ''}</span>
    </div>
    <div class="logs-list">
      ${lines === null ? html`<${Spinner} text="Loading…" />`
        : error ? html`<${Empty}>${error}</${Empty}>`
        : !lines.length ? html`<${Empty}>No log entries for this filter</${Empty}>`
        : lines.map((l, i) => html`<div class="log-line" key=${i}>
            <span class="log-ts">${new Date(l.ts).toLocaleString()}</span>
            <span class=${'log-prio ' + prioClass(l.priority)}>${prioName(l.priority)}</span>
            <span class="log-msg">${l.message}</span>
          </div>`)}
    </div>
  </div>`;
}

// --- page ------------------------------------------------------------------

const TABS = [
  { id: 'users', label: 'Users', render: () => html`<${UsersTab} />` },
  { id: 'services', label: 'Services', render: () => html`<${ServicesTab} />` },
  { id: 'scheduled', label: 'Scheduled', render: () => html`<${ScheduledTab} />` },
  { id: 'interfaces', label: 'Interfaces', render: () => html`<${NetworkTab} kind="interfaces" />` },
  { id: 'routes', label: 'Routes', render: () => html`<${NetworkTab} kind="routes" />` },
  { id: 'ports', label: 'Ports', render: () => html`<${NetworkTab} kind="ports" />` },
  { id: 'firewall', label: 'Firewall', render: () => html`<${NetworkTab} kind="firewall" />` },
  { id: 'disk', label: 'Disk', render: () => html`<${DiskTab} />` },
  { id: 'logs', label: 'Logs', render: () => html`<${LogsTab} />` },
];

export default function SystemPage() {
  const store = useStore();
  const active = TABS.find(t => t.id === store.tab.services) || TABS[0];
  return html`<${Page} title="System" class="fill">
    <${Tabs} items=${TABS} active=${active.id} onSelect=${t => setTab('services', t)} />
    <div class="tabview" key=${active.id}>${active.render()}</div>
  </${Page}>`;
}
