#!/usr/bin/env node
// Faithful ESM port of electron's own node_modules/electron/install.js.
//
// Why this exists: electron@42's install.js is CommonJS and does
//   require('@electron/get'); require('@electron-internal/extract-zip');
// but both of those packages are ESM-only, so the postinstall throws
// ERR_REQUIRE_ESM and the prebuilt Electron binary is never downloaded
// (node_modules/electron/dist stays empty -> `electron .` can't start).
//
// We download + extract the exact same artifact (same version, same
// checksums.json) here, importing the ESM deps with dynamic import().
// Wired as the project's `postinstall`, so a fresh `npm install` self-heals
// on every platform.

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rootRequire = createRequire(import.meta.url);

// Locate the installed electron package; nothing to do if it isn't there.
let electronDir;
try {
  electronDir = path.dirname(rootRequire.resolve('electron/package.json'));
} catch {
  console.log('[install-electron] electron package not found; skipping.');
  process.exit(0);
}

const { version } = rootRequire(path.join(electronDir, 'package.json'));
// Resolve electron's own deps from *its* location (handles nesting/hoisting).
const electronRequire = createRequire(path.join(electronDir, 'install.js'));

function platformPath(platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || os.platform()) {
  switch (platform) {
    case 'mas':
    case 'darwin':
      return 'Electron.app/Contents/MacOS/Electron';
    case 'freebsd':
    case 'openbsd':
    case 'linux':
      return 'electron';
    case 'win32':
      return 'electron.exe';
    default:
      throw new Error('Electron builds are not available on platform: ' + platform);
  }
}

const pPath = platformPath();

function isInstalled() {
  try {
    if (fs.readFileSync(path.join(electronDir, 'dist', 'version'), 'utf-8').replace(/^v/, '') !== version) return false;
    if (fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf-8') !== pPath) return false;
  } catch {
    return false;
  }
  const electronPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist', pPath);
  return fs.existsSync(electronPath);
}

if (isInstalled()) {
  process.exit(0);
}

const platform = process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
let arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;

if (platform === 'darwin' && process.platform === 'darwin' && arch === 'x64' && process.env.npm_config_arch === undefined) {
  // Running under Rosetta? Grab the arm64 build instead.
  try {
    if (execFileSync('sysctl', ['-in', 'sysctl.proc_translated']).toString().trim() === '1') arch = 'arm64';
  } catch {
    /* not translated */
  }
}

// Dynamic import of the ESM deps that the stock require()-based install.js chokes on.
const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href);

let checksums;
if (!process.env.electron_use_remote_checksums && !process.env.npm_config_electron_use_remote_checksums) {
  try {
    checksums = rootRequire(path.join(electronDir, 'checksums.json'));
  } catch {
    /* fall back to remote SHASUMS */
  }
}

const distPath = process.env.ELECTRON_OVERRIDE_DIST_PATH || path.join(electronDir, 'dist');

async function extractZip(zipPath) {
  // Prefer electron's bundled extractor (preserves exec bits, symlinks, etc).
  try {
    const { extract } = await import(pathToFileURL(electronRequire.resolve('@electron-internal/extract-zip')).href);
    await extract(zipPath, { dir: distPath });
    return;
  } catch (err) {
    console.warn('[install-electron] bundled extractor unavailable (' + err.message + '); using system unzip.');
  }
  fs.mkdirSync(distPath, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${distPath}' -Force`], { stdio: 'inherit' });
  } else {
    execFileSync('unzip', ['-o', '-q', zipPath, '-d', distPath], { stdio: 'inherit' });
  }
}

console.log(`[install-electron] downloading Electron ${version} for ${platform}-${arch}...`);
const zipPath = await downloadArtifact({
  version,
  artifactName: 'electron',
  force: process.env.force_no_cache === 'true',
  cacheRoot: process.env.electron_config_cache,
  checksums,
  platform,
  arch,
});

await extractZip(zipPath);

// If the zip carried type definitions, lift them next to the package (matches install.js).
const srcTypeDef = path.join(distPath, 'electron.d.ts');
if (fs.existsSync(srcTypeDef)) fs.renameSync(srcTypeDef, path.join(electronDir, 'electron.d.ts'));

fs.writeFileSync(path.join(electronDir, 'path.txt'), pPath);

// Belt-and-suspenders: ensure the launcher is executable (unzip usually keeps the bit).
if (process.platform !== 'win32') {
  try {
    fs.chmodSync(path.join(distPath, pPath), 0o755);
  } catch {
    /* non-fatal */
  }
}

console.log('[install-electron] done:', path.join(distPath, pPath));
