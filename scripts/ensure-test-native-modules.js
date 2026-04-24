#!/usr/bin/env node

/**
 * Ensure native modules are loadable by the current Node runtime (for tests).
 *
 * The `postinstall` / `rebuild:native` script rebuilds native modules against
 * Electron's embedded Node (so the app itself works). Tests, however, run in
 * plain Node, which may use a different NODE_MODULE_VERSION. When the ABI
 * mismatches, `require('better-sqlite3')` throws ERR_DLOPEN_FAILED and every
 * persistence test fails.
 *
 * This script detects that mismatch and runs `npm rebuild` for the affected
 * modules so tests can load them. Running this may leave the binaries
 * incompatible with Electron — run `npm run rebuild:native` before `npm run dev`
 * to switch them back.
 *
 * Note on subprocess ABI probing:
 *   We deliberately do NOT `require()` native .node files in this script. On
 *   Linux, even a failed dlopen (wrong NODE_MODULE_VERSION) can leave the
 *   .node file's text segment partially mmap'd in the current process. If we
 *   then rebuild and replace the file on disk, Node's shutdown cleanup can
 *   touch the stale mapping and SIGSEGV. Reading the ABI via a short-lived
 *   subprocess keeps the parent process clean.
 */
const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const NATIVE_MODULES = ['better-sqlite3'];
const projectRoot = path.resolve(__dirname, '..');

function moduleExists(moduleName) {
  return fs.existsSync(path.join(projectRoot, 'node_modules', moduleName));
}

function findModuleBinary(moduleName) {
  const releaseDir = path.join(projectRoot, 'node_modules', moduleName, 'build', 'Release');
  if (!fs.existsSync(releaseDir)) return null;
  const binary = fs
    .readdirSync(releaseDir)
    .find((f) => f.endsWith('.node') && !f.startsWith('test'));
  return binary ? path.join(releaseDir, binary) : null;
}

/**
 * Probe the NODE_MODULE_VERSION that a .node file was compiled against by
 * dlopen'ing it in a short-lived subprocess. Returns true when the binary
 * matches the current Node's ABI, false on mismatch (or when no binary
 * exists / the probe is inconclusive — caller should rebuild in either case).
 */
function binaryMatchesRuntime(moduleName) {
  const binary = findModuleBinary(moduleName);
  if (!binary) return false;
  const expected = process.versions.modules;
  const probe =
    'try { process.dlopen({ exports: {} }, ' +
    JSON.stringify(binary) +
    '); console.log(process.versions.modules); } ' +
    "catch (e) { const m = String(e.message).match(/NODE_MODULE_VERSION (\\d+)/); console.log(m ? m[1] : ''); }";
  const res = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  const actual = (res.stdout || '').trim();
  return actual === expected;
}

function rebuild(moduleName) {
  console.log(`  Rebuilding ${moduleName} against Node ${process.version}…`);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['rebuild', moduleName], { cwd: projectRoot, stdio: 'inherit' });
}

const mismatched = NATIVE_MODULES.filter(moduleExists).filter((m) => !binaryMatchesRuntime(m));
if (mismatched.length === 0) process.exit(0);

console.log('');
console.log('Native module ABI mismatch detected — rebuilding for the test runtime.');
console.log('Run `npm run rebuild:native` before `npm run dev` to restore Electron compatibility.');
console.log('');

for (const moduleName of mismatched) {
  try {
    rebuild(moduleName);
  } catch (err) {
    console.error(`  ✗ Failed to rebuild ${moduleName}: ${err.message}`);
    process.exit(1);
  }
}

// Post-rebuild verification (also via subprocess — never load into parent).
const stillBad = NATIVE_MODULES.filter(moduleExists).filter((m) => !binaryMatchesRuntime(m));
if (stillBad.length > 0) {
  console.error(
    `  ✗ Rebuild completed but binary still mismatches runtime ABI ${process.versions.modules}: ${stillBad.join(', ')}`
  );
  process.exit(1);
}
