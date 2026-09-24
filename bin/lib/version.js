// version.js — resolve the display version: prefer the latest git tag, fall
// back to package.json. Computed once at require time.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));

let _version = pkg.version;
try {
  const { execSync } = require('child_process');
  const tag = execSync('git describe --tags --abbrev=0 2>/dev/null', {
    cwd: ROOT, encoding: 'utf-8', timeout: 2000,
  }).trim();
  if (tag) _version = tag.replace(/^v/, '');
} catch {}

module.exports = { VERSION: _version, pkgVersion: pkg.version };
