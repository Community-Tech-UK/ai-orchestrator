#!/usr/bin/env node

/**
 * Rebuild native modules for Electron
 *
 * This script rebuilds native Node.js modules (like better-sqlite3) to be compatible
 * with Electron's version of Node.js. It runs automatically after npm install via
 * the postinstall script.
 *
 * Strategy:
 * 1. Try prebuild-install to download a prebuilt binary for Electron (no compiler needed)
 * 2. Fall back to @electron/rebuild (needs Python + C++ build tools)
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Native modules that need to be rebuilt for Electron
const NATIVE_MODULES = ['better-sqlite3'];

const projectRoot = path.resolve(__dirname, '..');

function getElectronVersion() {
  const electronPkgPath = path.join(projectRoot, 'node_modules', 'electron', 'package.json');
  if (fs.existsSync(electronPkgPath)) {
    return JSON.parse(fs.readFileSync(electronPkgPath, 'utf8')).version;
  }
  throw new Error('Could not determine Electron version — is electron installed?');
}

function moduleExists(moduleName) {
  return fs.existsSync(path.join(projectRoot, 'node_modules', moduleName));
}

/**
 * Try to download a prebuilt binary using prebuild-install.
 * This avoids needing a C++ compiler on the host.
 */
function tryPrebuildInstall(moduleName, electronVersion) {
  const modulePath = path.join(projectRoot, 'node_modules', moduleName);
  const prebuildBin = path.join(projectRoot, 'node_modules', '.bin', 'prebuild-install');

  if (!fs.existsSync(prebuildBin) && !fs.existsSync(prebuildBin + '.cmd')) {
    return false;
  }

  try {
    console.log(`  Trying prebuild-install for Electron ${electronVersion}...`);
    execSync(
      `npx prebuild-install --runtime electron --target ${electronVersion} --arch ${process.arch}`,
      { cwd: modulePath, stdio: 'pipe' }
    );
    console.log(`  ✓ ${moduleName} — prebuilt binary installed`);
    return true;
  } catch {
    console.log(`  ⚠ No prebuilt binary available, will try electron-rebuild...`);
    return false;
  }
}

/**
 * Fall back to @electron/rebuild (requires C++ toolchain).
 */
function tryElectronRebuild(moduleName) {
  try {
    console.log(`  Rebuilding ${moduleName} with electron-rebuild...`);
    execSync(`npx electron-rebuild -f -w ${moduleName}`, {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    console.log(`  ✓ ${moduleName} rebuilt successfully`);
    return true;
  } catch (error) {
    console.error(`  ✗ electron-rebuild failed: ${error.message}`);
    return false;
  }
}

function main() {
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Rebuilding native modules for Electron           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');

  const present = NATIVE_MODULES.filter(m => moduleExists(m));

  if (present.length === 0) {
    console.log('No native modules to rebuild.');
    process.exit(0);
  }

  let electronVersion;
  try {
    electronVersion = getElectronVersion();
  } catch (error) {
    console.log('Electron not yet installed — skipping native module rebuild.');
    console.log('(This is normal during initial npm install; postinstall will re-run.)');
    process.exit(0);
  }

  console.log(`Platform:  ${process.platform} / ${process.arch}`);
  console.log(`Electron:  ${electronVersion}`);
  console.log(`Modules:   ${present.join(', ')}`);
  console.log('');

  let allSucceeded = true;

  for (const moduleName of present) {
    // Try prebuilt binary first, fall back to compilation
    const ok = tryPrebuildInstall(moduleName, electronVersion) || tryElectronRebuild(moduleName);
    if (!ok) allSucceeded = false;
  }

  console.log('');

  if (allSucceeded) {
    console.log('✓ All native modules ready!');
    process.exit(0);
  } else {
    console.error('✗ Some modules failed to rebuild.');
    console.error('');
    console.error('Troubleshooting:');
    console.error('  - Try: npx electron-rebuild -f -w better-sqlite3');
    console.error('  - Windows may need C++ build tools: npm install -g windows-build-tools');
    console.error('  - Or install Visual Studio Build Tools with "Desktop development with C++"');
    process.exit(1);
  }
}

main();
