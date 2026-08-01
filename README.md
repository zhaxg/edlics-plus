<p align="center">
  <img src="https://raw.githubusercontent.com/opermancode/edlics/main/brand/logo.svg" width="80" height="80" alt="Edlics">
</p>

<h1 align="center">Edlics</h1>

<p align="center">
  <strong>在浏览器中编辑 Linux 服务器上的文件</strong>
  <br>
  无需终端编辑器，打开网页即可开始编辑。
</p>

<p align="center">
  <a href="SETUP.md"><img src="https://img.shields.io/badge/安装指南-blue?style=flat-square" alt="安装指南"></a>
  <a href="SETUP.md"><img src="https://img.shields.io/badge/安装-green?style=flat-square" alt="安装"></a>
  <a href="#使用方法"><img src="https://img.shields.io/badge/使用方法-purple?style=flat-square" alt="使用方法"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-white?style=flat-square" alt="License"></a>
</p>

<br>

## 解决什么问题

你有一台 Linux 服务器（比如 AWS EC2），需要编辑配置文件、写代码或修复问题。通常你需要：

- SSH 登录服务器
- 在终端里用 `vim` 或 `nano`
- 记住各种快捷键
- 没法用鼠标
- 看不到文件目录

能用，但很麻烦——特别是你更习惯 VS Code 这类编辑器的时候。

## Edlics 的方案

Edlics 把你的服务器变成一个网页版代码编辑器。运行一条命令，浏览器打开一个 URL，你就能获得：

- 左侧**文件浏览器**——点击文件夹浏览目录
- **代码编辑器**——语法高亮、行号显示
- **图片 & 二进制文件预览**——直接在浏览器中查看图片，识别二进制文件类型
- **Markdown & SVG 预览**——实时预览，支持编辑/预览切换
- **智能搜索**——自动过滤 `node_modules`、`target`、`vendor` 等目录
- **右键菜单**——重命名、删除、复制路径
- **快捷键**——Ctrl+S 保存等

除了初始安装，不需要任何 SSH 技能。适用于任何 Linux 服务器。

<br>

## 快速开始

```bash
npx edlics serve --hostname 0.0.0.0 --port 5000
```

本地访问：浏览器打开 `http://localhost:5000`
VPN 访问：浏览器打开 `http://内网IP:5000`
公网访问：浏览器打开 `http://公网IP:5000`

限制文件操作到指定目录：

```bash
npx edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www
```

> 详见 [SETUP.md](SETUP.md) 了解所有安装方式和故障排除。

<br>

## 功能特性

| | |
|---|---|
| **文件浏览器** | Material Design 图标文件树、目录导航、隐藏文件淡化显示 |
| **代码编辑器** | CodeMirror 6，支持 14 种语言语法高亮（JS、TS、Python、HTML、CSS、JSON、Markdown、XML、YAML、C/C++、Go、Rust、Java、SQL） |
| **图片预览** | 点击图片文件直接在浏览器中预览 |
| **二进制检测** | 自动识别 30+ 种二进制格式（ELF、PE、ZIP、PDF、PNG、MP4、SQLite 等），显示文件类型标签 |
| **Markdown 预览** | 实时渲染 HTML 预览，编辑/预览切换（默认预览模式） |
| **SVG 预览** | 直接 DOM 渲染，编辑/预览切换（默认预览模式） |
| **VS Code 风格标签栏** | 横向滚动标签栏，关闭按钮悬浮背景，预览切换固定在右侧 |
| **智能搜索** | 自动检测项目类型（Node.js、Go、Java、C#、Python、Rust、Ruby），排除构建/缓存目录 |
| **文件操作** | 创建、重命名、删除文件和文件夹——右键菜单 |
| **深色/浅色主题** | 点击月亮/太阳图标切换，偏好自动保存 |
| **侧边栏折叠** | 点击 Logo 折叠/展开文件树面板 |
| **服务器信息** | 显示当前登录用户、主机名和内网 IP |
| **可点击路径栏** | 点击面包屑中的任意目录即可跳转 |
| **Sudo 支持** | 编辑受保护的文件，需要时弹出密码输入框，NOPASSWD 用户自动提权 |
| **无数据库** | 直接操作文件系统，所见即所得 |
| **异步设计** | 非阻塞文件 I/O，大文件处理无压力 |
| **路径保护** | `--root` 参数限制所有文件操作在指定目录内 |

<br>

## 智能搜索过滤

Edlics 通过扫描特征文件自动检测项目类型，从搜索结果中排除构建/缓存目录：

| 特征文件 | 项目类型 | 排除目录 |
|---|---|---|
| `package.json` | Node.js | `node_modules`、`dist`、`.next`、`.nuxt`、`.cache`、`.turbo` |
| `go.mod` | Go | `vendor` |
| `pom.xml` / `build.gradle` | Java | `target`、`.gradle` |
| `.csproj` / `.sln` / `.slnx` | C# | `bin`、`obj`、`.vs`、`packages` |
| `requirements.txt` / `pyproject.toml` | Python | `__pycache__`、`.venv`、`venv`、`.mypy_cache`、`.tox` |
| `Cargo.toml` | Rust | `target` |
| `Gemfile` | Ruby | `vendor`、`.bundle` |

每个子目录独立检测，混合项目结构也能正确处理。

<br>

## 使用方法

```text
edlics serve [options]

Options:
  --hostname   绑定的主机地址（默认: 127.0.0.1）
  --port       监听端口（默认: 3000）
  --root       限制文件操作的根目录（默认: 无限制）

Examples:
  edlics serve
  edlics serve --hostname 0.0.0.0 --port 5000
  edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www
```

<br>

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+S` | 保存文件 |
| `Ctrl+P` | 搜索文件 |
| `Ctrl+W` | 关闭标签 |
| `F2` | 重命名文件 |
| `Escape` | 关闭对话框/菜单 |

<br>

## 标签页行为

- **单击**文件树中的文件 → 替换当前标签页（不新增标签）
- **双击**文件树中的文件 → 始终新开一个标签页
- **标签栏**在标签过多时横向滚动（鼠标滚轮滚动）
- **关闭按钮**悬浮时显示圆角矩形背景（VS Code 风格）

<br>

## 截图

![Edlics Dashboard](brand/Screenshot_dashboard.png)

<br>

## 工作原理

Edlics 是一个单文件 Node.js 程序，在你的 Linux 机器上启动一个 Web 服务器。

1. 运行 `edlics serve`——在指定端口启动 Web 服务器
2. 浏览器打开 `http://你的服务器IP:5000`
3. 左侧面板显示文件和文件夹（类似文件资源管理器）
4. 点击文件——在编辑器面板中打开，带语法高亮
5. 编辑、保存、创建、重命名、删除——全部在浏览器中完成
6. 服务器直接读写文件系统
7. 如果设置了 `--root`，所有操作限制在该目录内——服务器不会触碰目录外的任何文件

就这么简单。无需数据库，无需配置，无需复杂安装。

<br>

## 项目结构

```text
edlics/
├── bin/
│   └── edlics.js              # 服务端（Node.js）
├── brand/
│   └── logo.svg               # 项目 Logo
├── bundle/
│   └── editor.mjs             # CodeMirror 6 构建入口
├── public/
│   ├── editor.mjs             # 预构建的编辑器 bundle
│   ├── index.html             # 浏览器中看到的页面
│   ├── css/
│   │   └── style.css          # 所有样式
│   ├── icons/                 # Material Design 文件树图标（600+）
│   └── js/
│       ├── app.mjs            # 主入口、快捷键、侧边栏折叠
│       ├── api.mjs            # HTTP 客户端、弹窗、工具函数
│       ├── editor-ui.mjs      # CodeMirror 编辑器、标签页、路径栏
│       ├── file-tree.mjs      # 文件树渲染
│       ├── file-ops.mjs       # 文件操作（打开、保存、删除、重命名）
│       ├── markdown-preview.mjs # Markdown & SVG 预览
│       ├── context-menu.mjs   # 右键菜单
│       ├── search.mjs         # Ctrl+P 文件搜索
│       ├── sidebar.mjs        # 侧边栏拖拽调整宽度
│       ├── state.mjs          # 全局状态管理
│       ├── theme.mjs          # 深色/浅色主题切换
│       ├── icons.mjs          # 文件图标映射
│       ├── file-nesting.mjs   # 文件嵌套逻辑
│       └── glob.mjs           # Glob 模式匹配
├── .gitignore
├── README.md
├── SETUP.md                   # 安装指南
├── install.sh                 # 创建 symlink 到 /usr/local/bin
└── package.json               # 依赖 + 构建脚本
```

<br>

## 技术栈

- **前端：** 原生 JavaScript ES 模块（无构建步骤）、CodeMirror 6、CSS 自定义属性
- **后端：** Node.js（原生 `http` 模块，无框架）
- **编辑器：** CodeMirror 6，14 种语言语法、括号匹配、撤销历史
- **图标：** Material Design 文件树图标（600+ SVG）
- **主题：** 默认深色主题，可切换浅色主题

<br>

## 许可证

MIT — 自由使用、分享、二次开发。
