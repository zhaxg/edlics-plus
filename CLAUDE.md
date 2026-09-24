# CLAUDE.md — 协作指南（AI 与人类共用）

Edlics-Plus：浏览器里的 VSCode 式 IDE。单文件 Node 后端 + 原生 ESM 前端 + node-pty 真终端。
本文是改动本仓库前必读的地图与不变量清单。

## 常用命令

```bash
npm install            # 装依赖 + postinstall 自动构建两个 bundle
npm test               # node --test：单测 + 集成冒烟（认证/穿越/PTY/终端门闸/输入策略）
npm run build          # 仅两个 bundle 需要构建：public/editor.mjs + public/terminal.mjs
node bin/edlics.js serve --root . --password dev123   # 本地跑（--root 限制在仓库内）
#                                              需要终端时追加 --terminal
node --check bin/edlics.js            # 后端语法检查（每个 bin/lib/*.js 同理）
```

发布：**只走 tag**（无 push/PR CI）——`npm version patch && git push --tags` →
`publish.yml` 自动：装依赖 → 构建 → **`npm test` 硬闸门（全绿才继续）** → 冒烟 → CHANGELOG →
npm(OIDC) → 创建 GitHub Release。
旧 tag 补发 Release 用 `release.yml`（Actions 手动 Run workflow 填 tag）。

## 架构地图

```
bin/edlics.js        入口(~170行)：CLI 解析、启动、API 调度胶水 + 声明式路由表
bin/lib/
  paths.js           路径安全原语 isWithinRoot/isPathSafe、getExcludes、detectFileType
  auth.js            密码登录、会话 Cookie、IP 锁定(5次/15分)、公开路由 session/login/logout
  static.js          静态服务(ETag 304 + gzip)、router(含 public/ 路径穿越防护)
  files-api.js       list/read/write/delete/rename/create/stat/sudo-*/info + sudo 提权
  transfer-api.js    download(含 tar.gz 打包)/upload
  search-api.js      文件名搜索 + 全文搜索(async fs，不阻塞事件循环)
  git-api.js         status/log/commit-files/diff/show(execFile 无 shell) + 纯解析器(可单测)
  terminal-api.js    node-pty 会话 open/stream/input/resize/close + 30 分钟空闲回收
  version.js         版本号(git tag 优先，package.json 兜底)
public/index.html    页面骨架：登录遮罩/活动栏/侧栏面板/编辑区/终端面板
public/js/           原生 ESM，**无构建、改完刷新即生效**
  app.mjs            主入口：快捷键、init、登录成功后 bootApp
  auth.mjs activity.mjs workspace.mjs file-tree.mjs search.mjs git.mjs
  terminal-ui.mjs editor-ui.mjs tabs.mjs pathbar-status.mjs file-ops.mjs …
public/css/style.css 全部样式(明暗主题=CSS变量；滚动条=全局规则)
bundle/              esbuild 打包入口：editor.mjs(CodeMirror)、terminal.mjs(xterm)
test/                node --test：paths/auth/git-parse/search/terminal-idle 单测 + smoke 集成
docs/                README 截图与 logo
```

## 不变量（违反即安全/功能回归）

1. **认证**：`bin/edlics.js` 调度里，除 `session/login/logout` 外**所有** `/api/*` 必须先过
   `auth.isAuthed()` → 401。新增端点自动受保护，勿绕过。
2. **路径安全**：任何来自客户端的文件路径必须过 `ctx.checkPath()`（= `paths.isPathSafe`：
   root containment + 符号链接 realpath 双检）。root 未配置时放行。
3. **静态穿越**：`static.js` 的 router 必须 resolve 后校验仍在 `PUBLIC_DIR` 内（曾出过
   `/../bin/edlics.js` 源码泄露 CVE 级漏洞，`test/smoke.test.js` 有回归用例）。
4. **写操作门闸**：`--readonly` 时经 `ctx.checkReadonly()` 拒绝所有写路由。
5. **Git 命令**：只用 `execFile`（无 shell）；sha 必须匹配 `/^[0-9a-f]{4,40}$/i`；
   pathspec 放在 `--` 之后；cwd 必须是校验过的 workspace。
6. **终端**：**默认关闭**——`terminalEnabled = --terminal && !readonly`，调度层按
   `route.name` 前缀 `api/term` 拦截（`/api/info` 上报 `terminal` 供前端提示）。
   启用后：一个登录会话一个 PTY；输出缓冲上限 256KB；空闲 30 分钟自杀
   (`sweepIdle`)；浏览器只透传原始字节（行编辑在 shell/TTY 内完成）。
   **输入策略（防手滑，非防黑客）**：`classifyInput` 拒绝多行 payload（整包不转发）；
   Enter 边界用 `checkHighRisk` 拦截高危行（命中 → 吞掉 Enter 并发 ^C 丢行）；
   `trackLine` 做尽力而为的行跟踪（退格/历史键），详见 `terminal-api.js` 顶部注释。
7. **前端响应形状**：成功=数据本体，失败=`{ error: string }` + 对应 status。
   会话 Cookie：`HttpOnly; SameSite=Strict`，7 天。
8. **密码**：`--password` > `EDLICS_PASSWORD` > 自动生成并打印；sha256 + `timingSafeEqual`。
9. **对外路径一律 POSIX 正斜杠**：返回给客户端的路径（info.home、搜索结果、term cwd、
   面包屑）必须过 `paths.toPosix()`；Windows 的 `fs`/`path` 原生接受 `/`，内部计算可保留
   系统分隔符。localStorage 里旧的混合分隔符工作区在 `workspace.mjs` 加载时自动迁移。

## 如何新增一个 API 端点

在对应 `bin/lib/*-api.js` 的 `routes` 数组追加一项即可，调度自动生效：

```js
{ name: 'api/my-route',
  match: (parts, params) => parts[1] === 'my-route' && !!params.path,  // parts[0]==='api' 已保证
  handle: (ctx) => { /* ctx: req,res,parts,params,ok,fail,checkPath,checkReadonly,readonly,rootDir */ } }
```

- 接收路径 → 先 `if (!ctx.checkPath(params.path)) return;`
- 写操作 → 先 `if (ctx.checkReadonly()) return;`
- 需要共享状态 → 模块内 `let`（参照 files-api 的 sudoPassword）
- 给纯解析逻辑抽 `parse*` 导出函数 + 在 `test/` 加单测

## 如何新增一个侧栏面板

1. `public/index.html`：活动栏加 `<button class="act-btn" data-view="xxx">`，侧栏加
   `<div class="panel hidden" id="panel-xxx">`
2. `public/js/activity.mjs`：`VIEW_TO_PANEL` 加映射
3. 新建 `public/js/xxx.mjs`，在 `app.mjs` 里 init
4. 样式写进 `public/css/style.css`（颜色一律用 `var(--*)`，明暗主题自动适配）

## 前端关键约定

- **业务代码零构建**：只改 `public/js/*.mjs` 即生效；改 `bundle/editor.mjs`（CodeMirror）或
  `bundle/terminal.mjs`（xterm）才需要 `npm run build`。
- **`public/editor.mjs`、`public/terminal.*` 是构建产物，禁止手改。**
- ESM 循环引用（tabs ↔ editor-ui）：只允许**运行时**使用对方（函数体内调用），顶层勿执行。
  新模块优先动态 `import('./x.mjs')` 打断环（file-ops/git 均如此）。
- `state.mjs` 是全局单例状态；类型见其中的 `TabInfo` JSDoc typedef。
- 快捷键集中在 `app.mjs` 的 keydown（终端聚焦时整段跳过）。
- 明暗主题：`theme.mjs` 切 CSS 变量并派发 `theme-changed`；xterm 调色板在
  `terminal-ui.mjs`（XTERM_DARK/XTERM_LIGHT 监听该事件）。
- 滚动条全局统一（style.css 顶部 `*::-webkit-scrollbar`）；例外仅 `.tabs`（悬停显示）
  与 xterm viewport（隐藏）——新滚动区域无需单独写样式。

## 测试

- 纯函数：直接 `require('../bin/lib/xxx')`（如 git 解析、路径安全、内容匹配）
- 集成：`test/smoke.test.js` 模式——spawn 真服务(随机端口+--password) → fetch 驱动 →
  after() kill。含认证、穿越回归、gzip/304、PTY 往返。
- 改动后基线：`npm test && npm run build && timeout 3 node bin/edlics.js serve --port 19999 || true`

## 已知坑

- `package-lock.json`、`.playwright-mcp/`、`.code-graph/` 被 gitignore；`npm publish` 走
  npm install（无 lock 也能发）。
- Windows 启动会闪一行 `系统找不到指定的路径`——是 `git describe … 2>/dev/null` 在 cmd 下的
  噪音，版本回退逻辑正常，Linux CI 无此问题。
- node-pty 是原生模块：Linux 缺编译器时 `apt install build-essential python3`（见 SETUP.md）。
- Playwright 的 `scale:"device"` 截图在本机会返回过期帧；如需截图用 `scale:"css"` 并
  （状态切换后）连拍取第 3 张。
- `search-content` 上限：500 条命中 / 单文件 2MB；全文匹配是纯 Node 实现（非 ripgrep）。
- 后端 body 解析均为手写 `req.on('data'/'end')`；新写时记得 `JSON.parse` 包 try/catch → 400。
