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
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const NATIVE_MODULES = ['better-sqlite3'];
const projectRoot = path.resolve(__dirname, '..');

function canLoad(moduleName) {
  try {
    const moduleValue = require(path.join(projectRoot, 'node_modules', moduleName));
    if (moduleName === 'better-sqlite3') {
      const db = new moduleValue(':memory:');
      db.prepare('select 1').get();
      db.close();
    }
    return true;
  } catch (err) {
    if (err && err.code === 'ERR_DLOPEN_FAILED') return false;
    return true;
  }
}

function moduleExists(moduleName) {
  return fs.existsSync(path.join(projectRoot, 'node_modules', moduleName));
}

function rebuild(moduleName) {
  console.log(`  Rebuilding ${moduleName} against Node ${process.version}…`);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(npmCmd, ['rebuild', moduleName], { cwd: projectRoot, stdio: 'inherit' });
}

const mismatched = NATIVE_MODULES.filter(moduleExists).filter((m) => !canLoad(m));
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
