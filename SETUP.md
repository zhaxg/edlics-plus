# 安装指南

## 环境要求

- **Node.js** v18 或更高
- **npm** v9 或更高
- **Git**（源码安装时需要）
- **sudo** 权限（系统级安装时需要）

验证环境：

```bash
node --version   # 需要 v18+
npm --version    # 需要 v9+
```

<br>

---

## 安装方式

### 方式一：npx 直接运行（需已发布到 npm）

```bash
npx edlics-plus serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

`npx` 会下载并运行最新版本，不产生永久安装。首次运行需要几秒下载依赖并构建编辑器。

> 注意：包名是 **`edlics-plus`**（命令仍为 `edlics`），发布到 npm 后此方式可用。
> 尚未发布时请使用方式二或方式三。

<br>

### 方式二：npm 全局安装（需已发布到 npm）

```bash
npm install -g edlics-plus
edlics serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

以后升级：

```bash
npm update -g edlics-plus
```

<br>

### 方式三：从源码安装（GitHub）

```bash
git clone https://github.com/zhaxg/edlics-plus.git
cd edlics-plus
npm install
sudo bash install.sh
edlics serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

`install.sh` 实际做了这些事：

1. `npm install` —— 安装依赖（CodeMirror 6、esbuild、xterm、node-pty）并自动构建编辑器与终端 bundle
2. 给 `bin/edlics.js` 添加可执行权限
3. 创建 symlink：
   - 以 root 运行时 → `/usr/local/bin/edlics`
   - 普通用户 → `~/.local/bin/edlics`（若不在 PATH 中会给出提示）

以后更新：

```bash
cd edlics-plus
git pull
npm install
```

<br>

### 方式四：不建 symlink，直接从源码运行

```bash
git clone https://github.com/zhaxg/edlics-plus.git
cd edlics-plus
npm install
node bin/edlics.js serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

不需要 `install.sh`，直接用 `node` 运行脚本即可。

<br>

---

## 首次运行与登录

服务启动后，浏览器打开：

```
http://localhost:5000
```

远程服务器：

```bash
edlics serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

然后访问 `http://<服务器IP>:5000`（确保防火墙/安全组放行该端口）。

**打开页面会先看到登录框**，输入密码后进入 IDE。

### 密码从哪来

优先级从高到低：

1. `--password` 命令行参数
2. 环境变量 `EDLICS_PASSWORD`
3. 都没设置时**自动生成随机密码**并打印在服务启动日志里

登录安全策略：

- 密码使用 sha256 + 恒时比较校验
- 同一 IP **连续输错 5 次锁定 15 分钟**
- 登录成功后签发 **HttpOnly Cookie 会话**（7 天有效）
- 所有 `/api/*` 接口未登录一律返回 401

> **忘记密码？** 重启服务并用 `--password` 指定新密码即可（会话在重启后全部失效）。

<br>

---

## 参数

```text
edlics serve [options]

选项：
  --hostname   绑定地址（默认: 127.0.0.1）
  --port       监听端口（默认: 3000）
  --root       限制文件操作的根目录（默认: 无限制）
  --password   登录密码（或设置环境变量 EDLICS_PASSWORD；省略则自动生成并打印）
  --readonly   只读模式，禁止所有写操作

示例：
  edlics serve
  edlics serve --hostname 0.0.0.0 --port 5000 --password 'secret'
  edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www --password 'secret'
  edlics serve --readonly --root /var/www
```

<br>

---

## 升级

### npx 方式

每次运行即为最新版，无需操作。

### npm 全局安装方式

```bash
npm update -g edlics-plus
pkill -f edlics        # Windows: 结束对应 node 进程
edlics serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

### 源码方式

```bash
cd edlics-plus
git pull
npm install
pkill -f edlics
node bin/edlics.js serve --hostname 0.0.0.0 --port 5000 --password '你的密码'
```

<br>

---

## 终端功能说明（node-pty）

内置终端基于 **node-pty**（原生模块），提供真实 TTY（回显、制表符、`ls` 分栏、Ctrl+C、颜色）。

- 主流平台（Linux x64/arm64、macOS、Windows）安装时通常直接使用预编译二进制，无需编译
- 若 `npm install` 阶段 node-pty 编译失败，安装编译工具后重试：

```bash
# Debian / Ubuntu
sudo apt install -y build-essential python3

# Alpine
apk add make g++ python3

# Windows：安装 Visual Studio Build Tools（含 C++ 工作负载）
```

安装完成后重新执行 `npm install`。

<br>

---

## 故障排查

| 问题 | 解决方法 |
|------|----------|
| `command not found: edlics` | 先执行 `sudo bash install.sh`，或直接用 `node bin/edlics.js` 运行 |
| 端口被占用 | 换端口：`edlics serve --port 5001` |
| 浏览器无法连接 | 检查防火墙 / 安全组是否放行端口 |
| 白屏 / 无内容 | 强制刷新 `Ctrl+F5`（Mac: `Cmd+Shift+R`） |
| 编辑器没有语法高亮 | 确认 `npm run build` 成功——`public/editor.mjs` 必须存在 |
| Markdown / SVG 预览不工作 | 强制刷新 `Ctrl+F5`（预览模块按 ES Module 加载） |
| `root directory does not exist` | `--root` 路径必须存在且是目录 |
| 登录提示被锁定 | 输错 5 次后锁定 15 分钟；或重启服务立即解除 |
| 忘记登录密码 | 用 `--password` 重启服务设置新密码 |
| 安装时报 node-pty 编译失败 | 见上文「终端功能说明」安装编译工具 |

<br>

---

## 发布新版本

```bash
npm version patch     # 或 minor / major，例如升到 1.3.0
git push --tags       # 推送 tag 触发 GitHub Actions 发布到 npm
```

`.github/workflows/publish.yml` 会在 tag `v*` 推送时自动：设置版本 → `npm install` → `npm run build` → 冒烟测试 → 生成 CHANGELOG → 通过 **OIDC Trusted Publishing** 发布到 npm（无需手动配置 token）。
