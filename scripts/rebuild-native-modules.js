#!/usr/bin/env node

/**
 * Rebuild native modules for Electron
 *
 * This script rebuilds native Node.js modules (like better-sqlite3) to be compatible
 * with Electron's version of Node.js. It runs automatically after npm install via
 * the postinstall script.
 *
 * Strategy:
 * 1. Wipe the module's build/ dir to defeat cache-skew (see note below)
 * 2. Try prebuild-install to download a prebuilt binary for Electron (no compiler needed)
 * 3. Fall back to @electron/rebuild (needs Python + C++ build tools)
 * 4. Verify the resulting binary's NODE_MODULE_VERSION actually matches Electron's ABI
 *
 * Cache-skew note: @electron/rebuild writes `build/Release/.forge-meta` as a
 * marker for "already built for this ABI". We've seen the marker get updated
 * while the actual .node binary stays stale (ABI mismatch at runtime, producing
 * a silently-failing Electron app). Wiping build/ and verifying ABI after every
 * rebuild prevents that.
 */

const { execSync, spawnSync } = require('child_process');
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

function moduleDir(moduleName) {
  return path.join(projectRoot, 'node_modules', moduleName);
}

/** Expected NODE_MODULE_VERSION for the installed Electron. null if unresolvable. */
function getExpectedAbi(electronVersion) {
  try {
    return String(require('node-abi').getAbi(electronVersion, 'electron'));
  } catch {
    return null;
  }
}

/** Remove stale build artifacts so nothing short-circuits the rebuild. */
function wipeBuildDir(moduleName) {
  const dir = path.join(moduleDir(moduleName), 'build');
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Find the primary .node binary for a module (skips test binaries). */
function findModuleBinary(moduleName) {
  const releaseDir = path.join(moduleDir(moduleName), 'build', 'Release');
  if (!fs.existsSync(releaseDir)) return null;
  const binary = fs
    .readdirSync(releaseDir)
    .find(f => f.endsWith('.node') && !f.startsWith('test'));
  return binary ? path.join(releaseDir, binary) : null;
}

/**
 * Read the NODE_MODULE_VERSION a .node file was compiled against.
 * Attempts process.dlopen in a subprocess; if host Node's ABI doesn't match
 * the binary's, the error message exposes the binary's ABI.
 */
function readBinaryAbi(binaryPath) {
  const script =
    'try { process.dlopen({ exports: {} }, ' +
    JSON.stringify(binaryPath) +
    '); console.log(process.versions.modules); } ' +
    "catch (e) { const m = String(e.message).match(/NODE_MODULE_VERSION (\\d+)/); " +
    'if (m) console.log(m[1]); }';
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  return (result.stdout || '').trim() || null;
}

/**
 * Verify that the freshly produced .node file targets the expected ABI.
 * Returns true on match (or when verification can't run). Logs and returns
 * false on a definite mismatch so the caller can escalate to a forced rebuild.
 */
function verifyAbi(moduleName, expectedAbi) {
  if (!expectedAbi) return true;
  const binary = findModuleBinary(moduleName);
  if (!binary) {
    console.error(`  ✗ ${moduleName}: no .node binary produced`);
    return false;
  }
  const actual = readBinaryAbi(binary);
  if (!actual) {
    console.warn(`  ⚠ ${moduleName}: could not determine binary ABI; skipping verification`);
    return true;
  }
  if (actual !== expectedAbi) {
    console.error(
      `  ✗ ${moduleName}: ABI mismatch — binary is NODE_MODULE_VERSION ${actual}, Electron expects ${expectedAbi}`
    );
    return false;
  }
  console.log(`  ✓ ${moduleName}: verified NODE_MODULE_VERSION ${actual}`);
  return true;
}

/**
 * Try to download a prebuilt binary using prebuild-install.
 * This avoids needing a C++ compiler on the host.
 */
function tryPrebuildInstall(moduleName, electronVersion) {
  const prebuildBin = path.join(projectRoot, 'node_modules', '.bin', 'prebuild-install');

  if (!fs.existsSync(prebuildBin) && !fs.existsSync(prebuildBin + '.cmd')) {
    return false;
  }

  try {
    console.log(`  Trying prebuild-install for Electron ${electronVersion}...`);
    execSync(
      `npx prebuild-install --runtime electron --target ${electronVersion} --arch ${process.arch}`,
      { cwd: moduleDir(moduleName), stdio: 'pipe' }
    );
    console.log(`  ✓ ${moduleName} — prebuilt binary installed`);
    return true;
  } catch {
    console.log(`  ⚠ No prebuilt binary available, will try electron-rebuild...`);
    return false;
  }
}

/** Full rebuild pipeline for one module, with cache wipe + ABI verification. */
function buildModule(moduleName, electronVersion, expectedAbi) {
  wipeBuildDir(moduleName);

  const rebuilt = tryPrebuildInstall(moduleName, electronVersion) || tryElectronRebuild(moduleName);
  if (!rebuilt) return false;

  if (verifyAbi(moduleName, expectedAbi)) return true;

  console.error('    Retrying with a forced clean rebuild from source...');
  wipeBuildDir(moduleName);
  if (!tryElectronRebuild(moduleName)) return false;
  return verifyAbi(moduleName, expectedAbi);
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

  const expectedAbi = getExpectedAbi(electronVersion);

  console.log(`Platform:  ${process.platform} / ${process.arch}`);
  console.log(`Electron:  ${electronVersion}${expectedAbi ? ` (ABI ${expectedAbi})` : ''}`);
  console.log(`Modules:   ${present.join(', ')}`);
  console.log('');

  let allSucceeded = true;

  for (const moduleName of present) {
    if (!buildModule(moduleName, electronVersion, expectedAbi)) allSucceeded = false;
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
