# Edlics-Plus 管理面板改造计划（root 级轻量 Linux Web 管理面板）

> 目标：在现有 edlics-plus 之上，扩展为一个 root 级、面向单机的 Linux Web 管理面板
> （概览指标 / systemd / 网络 / 用户 / 定时任务 / 容器）。
> 本文件是执行清单与验收标准；完成后应沉淀为 `CLAUDE.md` 的新章节 + `README` 的功能说明。

## 实施进度（滚动更新）

**第 1 轮（分支 `feat/admin-panel`）— Phase 2 核心链路 + Phase 0/1 地基，已落地：**
- ✅ 采样/存储/广播/概览全链路：`metrics.js`（/proc 1s 采样 + 分钟聚合 + 环形缓冲）、
  `db.js`（node:sqlite + `metrics_min`/`audit_log`/`login_attempts`/`meta`）、
  `sys-api.js`（info / metrics / metrics-stream(SSE) / health / audit）、
  `public/js/overview.mjs` + `bundle/charts.mjs`（uPlot）+ 活动栏 Overview 面板。
- ✅ 门闸：`--admin` / `--admin-write` / `--data-dir` / `--retention-days` / `--cookie-secure`；
  `/api/sys/*` 未开 `--admin` 一律 403；`/api/info` 上报 `admin` 供前端隐藏入口。
- ✅ 审计：登录成功/失败/锁定写 `audit_log`；限流计数落库（重启不清零）；全局熔断。
- ✅ 长跑：优雅关停（SIGTERM/SIGINT）、`uncaughtException` 受控退出、事件循环延迟监控、`/api/sys/health`。
- ✅ 测试：`metrics.test.js` / `sys-api.test.js` / `admin-smoke.test.js`；全套 67 用例全绿。
- ⏳ 未做（见下方各阶段）：TOTP、`__Host-` 前缀、CIDR 白名单、`--trust-proxy`、昂贵端点限流、
  systemd 单元示例、systemd 服务管理、网络/用户/定时任务/容器、systemd unit 安装示例。

> 本地运行（看到概览面板）：`node bin/edlics.js serve --port 8088 --password 1234 --admin --terminal`

**第 2 轮 — Phase 4 systemd 服务与日志，已落地：**
- ✅ `services-api.js`：`/api/sys/services`（列表/过滤）、`/api/sys/services/logs`（journalctl JSON）、
  `/api/sys/services/action`（start/stop/restart/reload/enable/disable）。
- ✅ 安全：`execFile` 无 shell；unit 名**先过形状校验**（首字符必须字母数字，杜绝 `--xx.service`
  选项注入）**再核对实时枚举**才允许操作；写操作需 `--admin-write` 且审计；`--readonly` 恒优先。
- ✅ 前端 `public/js/services.mjs`：服务列表 + 状态点 + 过滤 + 启停按钮（仅 `adminWrite` 时出现）+ journal 抽屉。
- ✅ 测试：`services.test.js` 纯解析/校验 + admin-smoke 补服务端点用例（74 用例全绿）。
- ⏳ 未做：网络/用户/定时任务/容器（Phase 5–8）；Timer/Socket 单位、`systemctl show` 详情。

**第 3 轮 — Phase 5 网络查看，已落地：**
- ✅ `network-api.js`（全只读）：`/api/sys/network`（接口/路由/DNS）、`/network/sockets`（监听端口）、
  `/network/firewall`（nftables 汇总）；解析 `ip -j`、`ss -j`、`nft -j`，并含 **文本兜底**
  （本机 `ip -j route` 会 segfault 截断 JSON、`ss` 不支持 `-j`，均已兼容）。
- ✅ 前端 `public/js/network.mjs`：Ifaces / Routes / Sockets / FW 四个页签。
- ✅ 测试：`network.test.js` 六个解析器 + admin-smoke 网络端点（80 用例全绿）。
- ⏳ 未做：防火墙**修改**（nft 增删规则，归入 `--admin-write`）；流量历史（已在指标里）。

**第 4 轮 — Phase 6/7/8 用户·定时任务·容器（只读），已落地：**
- ✅ `users-api.js`：`/api/sys/users`（用户/组/在线会话，`/etc/passwd`·`/etc/group`·`who`）。
- ✅ `cron-api.js`：`/api/sys/cron`（`crontab -l`·`/etc/crontab`·`/etc/cron.d/*`·`systemctl list-timers`）。
- ✅ `container-api.js`：`/api/sys/containers`（`docker ps -a`·`compose ls`）、`/containers/logs`；
  容器引用先过形状校验再核对实时枚举，docker 守护进程不可用时优雅降级。
- ✅ 前端：Users（Tabs：Users/Groups/Sessions）、Scheduled、Containers 三个面板 + 活动栏入口。
- ✅ 测试：`sysadmin.test.js` 七个解析器（87 用例全绿）。
- ⏳ 未做（有意延后，需先设计安全的 stdin/argv 与审计）：用户增删改、密码、crontab 编辑、
  容器起停/exec、compose up/down、防火墙修改 —— 这些是**最高后果**的写操作，单独一轮做。


---

## 0. 总原则（所有阶段共同遵守）

- **默认关闭、最小暴露**：新能力一律挂在 `--admin*` 标志之后，默认不开；`--readonly` 永远最高优先级。
- **安全地基先行**：Phase 0 未完成前，禁止对外开启任何 `--admin` 能力。
- **Linux-only 特性门控**：非 Linux 或缺 systemd/docker 时，对应面板自动隐藏，服务端返回明确的 501/禁用。
- **execFile 无 shell** 是铁律：所有外部命令用参数数组，绝不拼 shell 字符串。
- **零新增原生依赖优先**：指标读 `/proc`，数据库先用 `node:sqlite`（Node 22 自带）。
- **纯逻辑抽函数 + 单测**：所有解析/校验逻辑导出为纯函数，照 `git-parse` 的既有模式。
- **命名空间隔离**：后端 `/api/sys/*`，前端 `public/js/*.mjs` 新模块，不改动既有 `/api/*` 契约。
- **不转 Go**：见「附录 A：技术选型决议」。

## 0.1 危险等级 × 开关矩阵

| 功能 | 危险级 | 默认 | 需要的开关 | 备注 |
|---|---|---|---|---|
| 概览指标（CPU/内存/磁盘/网络） | 低（只读） | 关 | `--admin` | 无特权也可读 `/proc` |
| 历史曲线 | 低（只读） | 关 | `--admin` | SQLite 落盘 |
| 系统信息（主机/内核/运行时间） | 低（只读） | 关 | `--admin` | |
| 服务列表 + 日志（只读） | 中 | 关 | `--admin` | `journalctl` 可读到敏感日志 |
| 服务 起/停/重启/启用 | **高** | 关 | `--admin` + `--admin-write` | |
| 网络查看（ip/ss/DNS/流量） | 中 | 关 | `--admin` | |
| 防火墙规则查看 | 中 | 关 | `--admin` | |
| 防火墙修改 | **高** | 关 | `--admin` + `--admin-write` | 有自锁风险 |
| 用户/组查看 | 中 | 关 | `--admin` | |
| 用户/组修改 | **高** | 关 | `--admin` + `--admin-write` | |
| 定时任务查看 | 中 | 关 | `--admin` | |
| 定时任务修改 | **高** | 关 | `--admin` + `--admin-write` | |
| 容器 列表/日志/检查 | 中 | 关 | `--docker` | |
| 容器 起/停/删/exec | **高** | 关 | `--docker` + `--docker-write` | docker.sock = root 等价 |
| docker-compose 项目 | **高** | 关 | `--docker` + `--docker-write` | 单独排期 |
| 审计日志查看 | 低 | 关 | `--admin` | |

## 0.2 编辑纪律（新增不变量，写进 CLAUDE.md）

1. 所有整机端点必须：`--admin` 闸门 → 会话鉴权 → `checkReadonly()`（写操作）→ 审计。
2. **绝不信任客户端传入的 unit 名 / 容器 ID / 服务名 / 用户名 / 路径**：必须与实时枚举结果比对，或用严格白名单正则。
3. 每条写操作必须写审计（谁、何时、何 IP、动作、目标、结果）。
4. 昂贵端点（`journalctl`、`docker logs`、全文搜索）必须限流 + 有输出上限。
5. 一切缓冲区/集合/Maps 必须有 TTL 或上限。

---

## 阶段总览与里程碑

| 阶段 | 内容 | 里程碑 | 预估 |
|---|---|---|---|
| Phase 0 | 安全地基 | **M1 可安全上线** | 大 |
| Phase 1 | 运行时健壮性（长跑） | 稳定跑 7×24 | 中 |
| Phase 2 | 指标采集 + 存储 + 广播 + 概览面板 | **M2 有个能看的仪表盘** | 大 |
| Phase 3 | 系统信息服务 | | 小 |
| Phase 4 | systemd 服务与日志 | **M3 能管服务** | 中 |
| Phase 5 | 网络查看 | | 中 |
| Phase 6 | 用户 / 用户组 | | 中 |
| Phase 7 | 定时任务 | | 中 |
| Phase 8 | 容器 → compose | **M4 容器可管** | 大 |
| Phase 9 | 性能历史 / 监控告警 | | 中 |
| Phase 10 | 文档 / 测试 / 发布 | **M5 正式发布** | 中 |

---

## Phase 0 — 安全地基（P0，必须先做）

**目标**：既然以 root 运行，把所有"能被爆破 / 能被嗅探 / 能被绕过"的口子先堵上。

### 0.1 传输与 Cookie 硬化
- [ ] 反代 TLS 方案（推荐 Caddy 自动 Let's Encrypt）或内置自签 TLS
- [ ] Cookie 增加 `Secure` + `__Host-` 前缀（HTTPS 时）
- [ ] 会话 TTL 从 7 天降到小时级 + 滑动续期；新增"吊销全部会话"接口
- [ ] `static.js` 补 `X-Content-Type-Options: nosniff`、`Referrer-Policy`、HSTS（HTTPS 时）
- [ ] 未登录前不暴露 `appVersion`、服务器 IP 徽标等指纹

### 0.2 认证强化
- [ ] TOTP 双因素（首次启动生成 secret + 二维码；`otplib`）
- [ ] 启动时拒绝弱密码（长度/常见字典），而非仅警告
- [ ] （可选）mTLS 客户端证书

### 0.3 限流：分布式 + 持久化（补现有短板）
- [ ] 全局熔断（每分钟失败总数上限）+ 每 IP 指数退避（替代固定 5/15min）
- [ ] 登录失败计数落 SQLite（重启不清零）
- [ ] `--trust-proxy` 显式开关 + 取"最右可信跳"解析 `X-Forwarded-For`（防伪造）
- [ ] 昂贵端点统一限流中间件

### 0.4 自动封禁
- [ ] 结构化认证日志 `/var/log/edlics/auth.log`（每行一条失败/成功）
- [ ] 提供 fail2ban jail 示例规则（README/SETUP）
- [ ] （可选）内建 nftables 封禁：白名单 + 自动解封 + 看门狗，默认关闭

### 0.5 审计
- [ ] `bin/lib/audit.js`：`audit_log` 表 + 记录函数
- [ ] 登录/失败/所有写操作落审计
- [ ] 审计查看端点 `/api/sys/audit`（分页 + 过滤）

### 0.6 网络层收口
- [ ] 保持默认 `127.0.0.1`
- [ ] `--allow <CIDR,...>`：非白名单在**进入任何逻辑前**断开（不返回 401）
- [ ] 文档明确：root 面板**必须**经隧道/白名单，不得裸奔公网

**验收**：TLS 生效；TOTP 可开；重启后锁定计数仍在；审计可查；白名单外连接被立即拒绝。

---

## Phase 1 — 运行时健壮性（P0/P1）

**目标**：消除长跑崩溃/内存增长/主线程卡顿。

- [ ] `uncaughtException` / `unhandledRejection` → 记日志 + 受控退出
- [ ] `SIGTERM`/`SIGINT` 优雅关停：关 SQLite、杀全部 PTY、结束全部 SSE
- [ ] 所有 `Map`/缓冲加上限与 TTL（sessions / loginAttempts / preview token / termSessions / SSE 客户端）
- [ ] 采样路径彻底去同步 IO；`getExcludes` 等 `*Sync` 评估并改造
- [ ] `perf_hooks.monitorEventLoopDelay()` 监控，超阈值告警
- [ ] `/api/sys/health`：RSS、事件循环延迟、会话数、SSE 数、PTY 数、DB 大小
- [ ] 自带 systemd unit 示例：`Restart=always`、`MemoryMax=`、`OOMScoreAdjust=`
- [ ] 日志统一格式（结构化），支持 `--log-level`

**验收**：压测 24h RSS 平稳；杀掉异常进程 systemd 能拉起；关停无残留 PTY 子进程。

---

## Phase 2 — 指标采集 + 存储 + 广播 + 概览面板（P1，核心）

**目标**：实时仪表盘 + 30 天历史。

### 2.1 采集
- [ ] `bin/lib/metrics.js`：
  - [ ] 读 `/proc/stat`（CPU 差值）、`/proc/meminfo`、`/proc/loadavg`、`/proc/uptime`
  - [ ] 读 `/proc/net/dev`（网卡收发）、`/proc/diskstats`（磁盘读写）、挂载用量（`statfs`）
  - [ ] 1s 采样；环形缓冲保留最近 ~2min 原始值
  - [ ] 分钟聚合器（均值/增量）
- [ ] 纯函数：`parseProcStat` / `parseMeminfo` / `parseNetDev` / `computeCpuDelta` + 单测

### 2.2 存储
- [ ] `bin/lib/db.js`（`node:sqlite` 薄封装，可替换）
- [ ] `metrics_min` 表（ts 主键；cpu/mem/swap/load/net/disk）
- [ ] 每 60s 落一行；保留 30 天；定时清理
- [ ] （可选）磁盘 I/O、温度、网络错误计数扩展列

### 2.3 广播
- [ ] 全局单采样器（**不**每客户端各采）
- [ ] `GET /api/sys/metrics/stream`（SSE，背压时丢帧）
- [ ] `GET /api/sys/metrics?from&to&step`（读历史，降采样）
- [ ] SSE 客户端数上限

### 2.4 前端
- [ ] `bundle/charts.mjs`（uPlot，esbuild 打包 → `public/charts.mjs`，**构建产物禁止手改**）
- [ ] `public/js/overview.mjs`：实时折线（CPU/内存/网络）+ 概览卡片
- [ ] `index.html` 活动栏加 `overview` 按钮 + `panel-overview`；`activity.mjs` 加映射；`app.mjs` init
- [ ] 时间范围切换（1m/1h/1d/7d/30d）拉历史

**验收**：两个浏览器同时打开看到一致实时曲线；刷新后历史 30 天可查；DB 体积停在合理范围。

---

## Phase 3 — 系统信息服务（P1）

- [ ] `bin/lib/sys-api.js` 扩展 `/api/sys/info`：主机名、OS/发行版、内核版本、架构、运行时间、当前用户、时区、CPU 型号/核数、内存总量
- [ ] 数据源：`/etc/os-release`、`/proc/*`、`hostnamectl`（有则用，无则降级）
- [ ] 概览面板展示系统信息卡片
- [ ] 纯函数解析 `/etc/os-release` + 单测

**验收**：信息与 `hostnamectl` 一致；缺命令时优雅降级。

---

## Phase 4 — systemd 服务与日志（P1，M3）

- [ ] `bin/lib/services-api.js`
  - [ ] 只读：`systemctl list-units --type=service --all --no-pager --output=json`、`show`、`list-unit-files`
  - [ ] 日志：`journalctl -u <unit> -n <N> -o json --no-pager`（**N 有上限、有 `--` 分隔**）
  - [ ] 写：`start/stop/restart/reload/enable/disable`
- [ ] **unit 名必须在当前枚举结果内**才允许操作（防参数注入）
- [ ] `--admin-write` 门控写操作 + 审计
- [ ] 前端 `public/js/services.mjs`：列表、状态着色、操作按钮（二次确认）、日志抽屉（自动刷新可关）
- [ ] 日志输出上限（行数/字节）+ 限流

**验收**：能起停一个真实服务并看到 journal 日志；非法 unit 名被拒；写操作有审计。

---

## Phase 5 — 网络查看（P1/P2）

- [ ] `bin/lib/network-api.js`
  - [ ] 接口/地址：`ip -j addr`、`ip -j link`
  - [ ] 路由：`ip -j route`
  - [ ] 连接/端口：`ss -j -tulpn`
  - [ ] DNS：`/etc/resolv.conf`（`resolvectl` 缺则降级）
  - [ ] 防火墙：nftables（`nft -j list ruleset`）；ufw 缺则标注不支持
  - [ ] 单网卡流量历史（来自 Phase 2 指标）
- [ ] 前端 `public/js/network.mjs`：网卡卡片、连接表、路由表、DNS、防火墙规则
- [ ] 防火墙**修改**归入 `--admin-write`，带自锁防护与二次确认
- [ ] 纯函数解析 `ip -j` / `ss -j` 输出 + 单测

**验收**：`ip`/`ss` 输出与命令行一致；DNS 正确展示；缺工具时给出明确提示。

---

## Phase 6 — 用户 / 用户组（P2）

- [ ] `bin/lib/users-api.js`
  - [ ] 只读：`/etc/passwd`、`/etc/group`、`getent`、`who`（在线会话）
  - [ ] 写（`--admin-write`）：`useradd/usermod/userdel/groupadd/passwd` 等
- [ ] 密码输入不落日志、不回显；命令行参数避免出现在 `ps`（优先 stdin/`chpasswd`）
- [ ] 前端 `public/js/users.mjs`
- [ ] 纯函数解析 passwd/group + 单测

**验收**：用户/组/在线会话准确；写操作受门控 + 审计；密码不经 shell 泄露。

---

## Phase 7 — 定时任务（P2）

- [ ] `bin/lib/cron-api.js`
  - [ ] 只读：`crontab -l`、`/etc/cron.d/*`、`systemctl list-timers`
  - [ ] 写（`--admin-write`）：`crontab -`（经 stdin 写入）、编辑 `/etc/cron.d`
- [ ] crontab 语法校验（纯函数，落库前校验）
- [ ] 前端 `public/js/cron.mjs`：列表 + 编辑
- [ ] 纯函数解析 crontab 行 + 单测

**验收**：能增删一条任务并生效；非法语法被拒并提示。

---

## Phase 8 — 容器 → compose（P2/P3，M4）

### 8.1 单容器
- [ ] `bin/lib/container-api.js`
  - [ ] 只读：`docker ps --format '{{json .}}'`、`logs`、`inspect`、`stats --no-stream`
  - [ ] 写（`--docker-write`）：`start/stop/restart/rm`
  - [ ] `exec` 单独评估（≈ shell，危险级最高，默认不开）
- [ ] 容器 ID 必须与当前枚举比对
- [ ] 前端 `public/js/containers.mjs`

### 8.2 compose
- [ ] `docker compose ls --format json` 列项目
- [ ] 按项目 `ps` / `up -d` / `down` / `restart` / `logs`
- [ ] `-f` 路径必须过 `checkPath`、cwd 必须校验
- [ ] compose 文件复用文件编辑器编辑
- [ ] 面板内展示项目 → 服务 → 容器层级

**验收**：能列出并操作容器/compose 项目；非法 ID/路径被拒；写操作审计。

---

## Phase 9 — 性能历史 / 监控告警（P3）

- [ ] 历史曲线扩展（更多时间范围、对比、导出 CSV）
- [ ] 阈值告警：CPU/内存/磁盘/负载超限 → 界面告警 + （可选）webhook/邮件
- [ ] 简单健康趋势页
- [ ] 数据保留策略可配（默认 30 天）

**验收**：超阈值有可见告警；历史可导出。

---

## Phase 10 — 文档 / 测试 / 发布（持续）

- [ ] `CLAUDE.md` 新增「管理面板」章节：模块地图、新不变量、如何新增一个 sys 端点
- [ ] `README` 功能说明 + 安全说明（root 风险、必须 TLS/白名单/TOTP）
- [ ] `SETUP.md`：反代 TLS、fail2ban 配置、systemd unit 安装
- [ ] 测试补齐：每个 `parse*` 单测 + `smoke` 集成（鉴权/门控/限流/审计/只读）
- [ ] 版本与发布：沿用 tag → Actions → npm test 硬闸门
- [ ] 安全自查清单过一遍（附录 B）

---

## 依赖关系

```
Phase 0 (安全地基) ─┬─► 所有对外能力的前置
Phase 1 (健壮性) ───┘
        │
        ├─► Phase 2 (指标/DB/广播) ─► Phase 3 (系统信息) ─► Phase 9 (历史/告警)
        ├─► Phase 4 (systemd)
        ├─► Phase 5 (网络)
        ├─► Phase 6 (用户)
        ├─► Phase 7 (定时任务)
        └─► Phase 8 (容器/compose)
Phase 10 (文档/测试) 贯穿全程
```

---

## 附录 A：技术选型决议

- **语言：保持 Node.js，不重写 Go。** 负载为 IO 密集（读 `/proc`、execFile、SQLite、SSE），单管理员并发，事件循环足够；重写要付出整个 `bin/lib` + 测试的成本，前端还要原样保留，不划算。
- Go 的触发条件（未来）：出现真实 CPU 热点且 `worker_threads` 无法解决；或产品需要单文件零依赖分发。
- **数据库**：`node:sqlite`（零依赖，Node 22 自带，实验性）优先，封装 `db.js` 以便换 `better-sqlite3`。
- **图表**：uPlot（轻、canvas、专为实时时序）走 esbuild bundle。
- **不引入**：Web 框架、ORM、前端框架——延续现有的零框架/零构建（业务代码）风格。

## 附录 B：上线前安全自查清单

- [ ] 默认 `127.0.0.1`，未裸奔公网；或已配隧道/白名单
- [ ] TLS 已启用，Cookie 带 `Secure`/`HttpOnly`/`SameSite=Strict`
- [ ] 已启用 TOTP
- [ ] 限流全局 + 持久化；重启不清零；`X-Forwarded-For` 仅在 `--trust-proxy` 下解析
- [ ] 审计覆盖所有登录与写操作
- [ ] 所有整机端点受 `--admin*` 门控；`--readonly` 生效
- [ ] 无 shell 拼接；unit/容器/用户名均经白名单或实时枚举校验
- [ ] 所有集合有上限/TTL；昂贵端点有限流与输出上限
- [ ] 优雅关停无残留子进程
- [ ] 弱密码被拒；生成的默认密码足够强

## 附录 C：明确的非目标

- 不做多用户/多租户权限体系（单管理员）
- 不做多主机远程管理（单机）
- 不做 Go 重写
- 不默认对公网开放
