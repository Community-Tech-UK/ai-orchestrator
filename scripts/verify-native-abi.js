#!/usr/bin/env node

/**
 * Fast pre-flight check: verifies bundled native modules' NODE_MODULE_VERSION
 * matches the installed Electron's expected ABI.
 *
 * Runs before build/start. If ABI drifts (e.g. after bumping Electron), this
 * fails loudly with a clear fix-it message so the stale binary never gets
 * packaged into a DMG.
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const NATIVE_MODULES = ['better-sqlite3'];

function fail(msg) {
  console.error('');
  console.error('✗ Native module ABI check failed:');
  console.error('  ' + msg);
  console.error('');
  console.error('Fix: run `npm run rebuild:native`, then re-run this command.');
  console.error('');
  process.exit(1);
}

const electronPkg = path.join(projectRoot, 'node_modules', 'electron', 'package.json');
if (!fs.existsSync(electronPkg)) {
  console.log('Electron not installed yet — skipping native ABI check.');
  process.exit(0);
}
const electronVersion = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;

let expectedAbi;
try {
  expectedAbi = String(require('node-abi').getAbi(electronVersion, 'electron'));
} catch {
  console.log('Could not resolve Electron ABI — skipping native ABI check.');
  process.exit(0);
}

for (const moduleName of NATIVE_MODULES) {
  const releaseDir = path.join(projectRoot, 'node_modules', moduleName, 'build', 'Release');
  if (!fs.existsSync(releaseDir)) {
    fail(`${moduleName}: no build/Release directory; module hasn't been built.`);
  }
  const binary = fs
    .readdirSync(releaseDir)
    .find(f => f.endsWith('.node') && !f.startsWith('test'));
  if (!binary) fail(`${moduleName}: no .node binary in build/Release.`);
  const binaryPath = path.join(releaseDir, binary);

  const probe =
    'try { process.dlopen({ exports: {} }, ' +
    JSON.stringify(binaryPath) +
    '); console.log(process.versions.modules); } ' +
    "catch (e) { const m = String(e.message).match(/NODE_MODULE_VERSION (\\d+)/); if (m) console.log(m[1]); }";
  const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  const actual = (result.stdout || '').trim();
  if (!actual) {
    fail(
      `${moduleName}: could not determine binary ABI — binary may be corrupt. ` +
        `stderr: ${(result.stderr || '').split('\n')[0]}`,
    );
  }
  if (actual !== expectedAbi) {
    fail(
      `${moduleName}: binary is NODE_MODULE_VERSION ${actual}, but Electron ${electronVersion} needs ${expectedAbi}.`,
    );
  }
  console.log(
    `✓ ${moduleName}: NODE_MODULE_VERSION ${actual} matches Electron ${electronVersion}`,
  );
}
