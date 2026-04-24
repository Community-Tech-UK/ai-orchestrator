#!/usr/bin/env node
/* eslint-env node */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run(process.execPath, ['scripts/verify-native-abi.js']);
run(process.execPath, ['scripts/verify-ipc-channels.js']);
run(process.execPath, ['scripts/verify-package-exports.js']);

const requiredFiles = [
  'src/preload/generated/channels.ts',
  'src/main/index.ts',
  'build-preload.ts',
  'package.json',
];

for (const rel of requiredFiles) {
  if (!fs.existsSync(path.join(ROOT, rel))) {
    console.error(`Electron smoke check failed: missing ${rel}`);
    process.exit(1);
  }
}

console.log('Electron smoke check passed');
