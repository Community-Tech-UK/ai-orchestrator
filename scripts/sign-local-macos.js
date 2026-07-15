#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { signAsync } = require('@electron/osx-sign');
const { verifyMacHelperIdentity } = require('./verify-macos-helper-identity.js');

const IDENTITY_PRIORITY = [
  'Developer ID Application:',
  'Apple Development:',
  'Mac Developer:',
];

function selectCodeSigningIdentity(output) {
  const identities = output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*\d+\)\s+([A-F0-9]+)\s+"([^"]+)"\s*$/u.exec(line);
    return match ? [{ hash: match[1], name: match[2] }] : [];
  });
  for (const prefix of IDENTITY_PRIORITY) {
    const match = identities.find((identity) => identity.name.startsWith(prefix));
    if (match) return match;
  }
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
  selectCodeSigningIdentity,
  signWithLocalIdentity,
  sign,
};
