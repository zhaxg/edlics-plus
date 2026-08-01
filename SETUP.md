# Setup Guide

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- **Git** (for source install)
- **sudo** access (for system-wide install)

Verify your setup:

```bash
node --version   # needs to be v18+
npm --version    # needs to be v9+
```

<br>

---

## Installation Methods

### Method 1 — Run on demand (npm required, package must be published)

```bash
npx edlics serve --hostname 0.0.0.0 --port 5000
```

`npx` downloads and runs the latest version without installing anything permanently. The first run takes a few seconds as it downloads the package and builds the editor bundle.

> **Note:** This works only after the package is published to npm.  
> If not yet published, use Method 2 or 3.

<br>

### Method 2 — Global install via npm (package must be published)

```bash
npm install -g edlics
edlics serve --hostname 0.0.0.0 --port 5000
```

To update later:

```bash
npm update -g edlics
```

> **Note:** This works only after the package is published to npm.  
> If not yet published, use Method 3.

<br>

### Method 3 — From source (GitHub)

```bash
git clone https://github.com/opermancode/edlics.git
cd edlics
npm install
sudo bash install.sh
edlics serve --hostname 0.0.0.0 --port 5000
```

What this does:
1. `npm install` — installs dependencies (CodeMirror 6, esbuild) and builds the editor bundle
2. `sudo bash install.sh` — creates a symlink: `/usr/local/bin/edlics` → `bin/edlics.js`

To update later:

```bash
cd edlics
git pull
npm install
```

<br>

### Method 4 — No symlink (run directly from source)

```bash
git clone https://github.com/opermancode/edlics.git
cd edlics
npm install
node bin/edlics.js serve --hostname 0.0.0.0 --port 5000
```

No `install.sh` needed — just run the script directly.

<br>

---

## First Run

Once the server is running, open your browser to:

```
http://localhost:5000
```

If running on a remote server:

```bash
edlics serve --hostname 0.0.0.0 --port 5000
```

Then access it at `http://<server-ip>:5000`.

> Make sure port 5000 is open in your firewall / security group.

<br>

---

## Options

```text
edlics serve [options]

Options:
  --hostname   Host to bind to (default: 127.0.0.1)
  --port       Port to listen on (default: 3000)
  --root       Root directory to restrict file operations (default: no restriction)

Examples:
  edlics serve
  edlics serve --hostname 0.0.0.0 --port 5000
  edlics serve --hostname 0.0.0.0 --port 5000 --root /var/www
```

<br>

---

## Updating

### If installed via npx

Always runs the latest version automatically. No action needed.

### If installed globally via npm

```bash
npm update -g edlics
```

Kill the old server and start again:

```bash
pkill -f edlics
edlics serve --hostname 0.0.0.0 --port 5000
```

### If installed from source (git clone)

```bash
cd edlics
git pull
npm install
pkill -f edlics
edlics serve --hostname 0.0.0.0 --port 5000
```

### If running without symlink (Method 4)

```bash
cd edlics
git pull
npm install
pkill -f edlics
node bin/edlics.js serve --hostname 0.0.0.0 --port 5000
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `command not found: edlics` | Run `sudo bash install.sh` first, or use `node bin/edlics.js` directly |
| Port already in use | Use a different port: `edlics serve --port 5001` |
| Browser can't connect | Check firewall / security group rules for the port |
| Blank page / no content | Hard refresh with `Ctrl+F5` or `Cmd+Shift+R` |
| Editor shows no syntax colors | Make sure `npm run build` completed successfully — `public/editor.mjs` should exist |
| Markdown / SVG preview not working | Hard refresh with `Ctrl+F5` — the preview modules are loaded as ES modules |
| `root directory does not exist` | The `--root` path must exist and be a directory — check the path and try again |

<br>

---

## Publishing a new version

When you want to release an update:

```bash
npm version patch     # bumps to 1.2.1
git push --tags       # triggers GitHub Actions to publish to npm
```

The workflow in `.github/workflows/publish.yml` handles the rest.
