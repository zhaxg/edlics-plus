#!/bin/bash
set -e

EDLICS_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "  Installing Edlics-Plus..."
echo ""

# Install npm dependencies and build the bundles (editor + terminal)
if [ -f "$EDLICS_DIR/package.json" ]; then
  echo "  → Installing dependencies (CodeMirror, xterm, node-pty)..."
  (cd "$EDLICS_DIR" && npm install) || {
    echo ""
    echo "  ✗ npm install failed."
    echo "    node-pty is a native module — if its build failed, install the toolchain first:"
    echo "      Debian/Ubuntu: sudo apt install -y build-essential python3"
    echo "      Alpine:        apk add make g++ python3"
    echo "    See SETUP.md →「终端功能说明（node-pty）」, then re-run this script."
    exit 1
  }
  echo ""
fi

# Make the CLI executable
chmod +x "$EDLICS_DIR/bin/edlics.js"

# Create symlink in /usr/local/bin if sudo, else in ~/.local/bin
if [ "$EUID" -eq 0 ]; then
  TARGET="/usr/local/bin"
  echo "  Root install: symlinking to $TARGET/edlics"
else
  TARGET="$HOME/.local/bin"
  mkdir -p "$TARGET"
  echo "  User install: symlinking to $TARGET/edlics"
fi

ln -sf "$EDLICS_DIR/bin/edlics.js" "$TARGET/edlics"
chmod +x "$TARGET/edlics"

# Check if target is in PATH
if ! echo "$PATH" | tr ':' '\n' | grep -qx "$TARGET"; then
  echo "  Warning: $TARGET is not in your PATH."
  echo "  Add it with: export PATH=\"\$PATH:$TARGET\""
  if [ "$EUID" -ne 0 ]; then
    echo "  Or run: echo 'export PATH=\"\$PATH:$TARGET\"' >> ~/.bashrc"
  fi
fi

echo ""
echo "  ✓ Edlics-Plus installed!"
echo ""
echo "  Quick start:"
echo "    edlics serve --hostname 0.0.0.0 --port 5000 --password 'your-password'"
echo ""
echo "  Then open http://localhost:5000 in your browser and sign in."
echo "  (Omit --password to auto-generate one — it is printed at startup.)"
echo ""
