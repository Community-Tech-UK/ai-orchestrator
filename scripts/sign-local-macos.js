#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { signAsync } = require('@electron/osx-sign');
const { verifyMacHelperIdentity } = require('./verify-macos-helper-identity.js');

const IDENTITY_PRIORITY = [
  'Developer ID Application:',
  'Apple Development:',
  'Mac Developer:',
];

const MACHO_MAGICS = new Set([
  0xfeedface, 0xcefaedfe,
  0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca,
  0xcafebabf, 0xbfbafeca,
]);

const FAT_MAGICS = new Set([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function findCodeSigningIdentity(output) {
  const identities = output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*\d+\)\s+([A-F0-9]+)\s+"([^"]+)"\s*$/u.exec(line);
    return match ? [{ hash: match[1], name: match[2] }] : [];
  });
  for (const prefix of IDENTITY_PRIORITY) {
    const match = identities.find((identity) => identity.name.startsWith(prefix));
    if (match) return match;
  }
  return null;
}

function selectCodeSigningIdentity(output) {
  const identity = findCodeSigningIdentity(output);
  if (identity) return identity;
  throw new Error(
    'A real macOS code-signing identity is required for localbuild. '
    + 'Install an Apple Development or Developer ID Application certificate.',
  );
}

function readInstalledCodeSigningIdentities() {
  const result = spawnSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    throw new Error('Could not inspect installed macOS code-signing identities');
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function isMachOFile(filePath) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(8);
    const read = fs.readSync(handle, header, 0, 8, 0);
    if (read < 4) return false;
    const magic = header.readUInt32BE(0);
    if (!MACHO_MAGICS.has(magic)) return false;
    if (FAT_MAGICS.has(magic)) {
      // FAT_MAGIC shares its bytes with the Java class-file magic, which puts a
      // version number where a fat Mach-O keeps nfat_arch. A fat binary with
      // zero or absurdly many architectures is not code.
      if (read < 8) return false;
      const bigEndian = magic === 0xcafebabe || magic === 0xcafebabf;
      const archCount = bigEndian ? header.readUInt32BE(4) : header.readUInt32LE(4);
      return archCount >= 1 && archCount <= 32;
    }
    return true;
  } finally {
    fs.closeSync(handle);
  }
}

function findMachOBinaries(rootDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
      } else if (entry.isFile() && isMachOFile(entryPath)) {
        found.push(entryPath);
      }
    }
  };
  walk(rootDir);
  return found;
}

function runCodesign(args, label) {
  const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message
      || result.stderr
      || (result.signal ? `terminated by ${result.signal}` : `exit status ${result.status}`);
    throw new Error(`${label} failed: ${String(detail).trim()}`);
  }
}

function adHocSignApp(appPath, deps = {}) {
  const run = deps.runCodesign ?? runCodesign;
  // Loose Mach-O binaries, notably native modules under Contents/Resources, are
  // not reached by `codesign --deep`, and unsigned arm64 code never loads. Sign
  // them first so the bundle's resource seal covers their final bytes, then the
  // bundle itself, then verify.
  //
  // This sweeps every Mach-O in the bundle. electron-builder has an ignore list
  // (MacTargetHelper.buildSignOptions passes it to @electron/osx-sign as
  // opts.ignore: Contents/PlugIns, *.kext, puppeteer/playwright browser
  // caches) that this deliberately mirrors in reverse: anything Mach-O in those
  // paths would be ad-hoc signed here and left alone by a later real signing
  // pass. The current bundle holds no Mach-O in any of them; revisit if that
  // changes.
  for (const binary of findMachOBinaries(appPath)) {
    run(['--force', '--sign', '-', binary], `Ad-hoc signing ${binary}`);
  }
  run(['--force', '--deep', '--sign', '-', appPath], `Ad-hoc signing ${appPath}`);
  run(['--verify', '--deep', '--strict', appPath], `Signature verification for ${appPath}`);
}

async function signWithLocalIdentity(options, deps = {}) {
  const readIdentities = deps.readIdentities ?? readInstalledCodeSigningIdentities;
  const signApp = deps.signApp ?? signAsync;
  const verifyIdentity = deps.verifyIdentity ?? verifyMacHelperIdentity;
  const identity = options.identity ?? selectCodeSigningIdentity(readIdentities()).hash;
  await signApp({ ...options, identity });
  verifyIdentity(options.app);
}

async function sign(options) {
  return signWithLocalIdentity(options);
}

module.exports = {
  readInstalledCodeSigningIdentities,
  findCodeSigningIdentity,
  selectCodeSigningIdentity,
  findMachOBinaries,
  runCodesign,
  adHocSignApp,
  signWithLocalIdentity,
  sign,
};
