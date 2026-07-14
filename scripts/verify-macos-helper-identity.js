#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER_RELATIVE_PATH = path.join(
  'Contents',
  'Resources',
  'desktop-helper',
  'desktop-helper',
);

function parseCodeSignMetadata(output) {
  const metadata = {};
  for (const line of output.split(/\r?\n/u)) {
    const signature = /^Signature(?:=|\s+)(.+)$/u.exec(line);
    if (signature) {
      metadata.signature = signature[1];
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).trim();
    if (key === 'Identifier') metadata.identifier = value;
    if (key === 'TeamIdentifier') metadata.teamIdentifier = value;
  }
  return metadata;
}

function readCodeSignMetadata(targetPath) {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', targetPath], {
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not inspect the macOS code signature for ${path.basename(targetPath)}`);
  }
  return parseCodeSignMetadata(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}

function isRealTeamIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'not set';
}

function verifyMacHelperIdentity(appPath, deps = {}) {
  const pathExists = deps.pathExists ?? fs.existsSync;
  const readMetadata = deps.readMetadata ?? readCodeSignMetadata;
  const helperPath = path.join(appPath, HELPER_RELATIVE_PATH);
  if (!pathExists(helperPath)) {
    throw new Error('Packaged macOS desktop helper is missing');
  }
  const appMetadata = readMetadata(appPath);
  const helperMetadata = readMetadata(helperPath);
  if (!isRealTeamIdentifier(appMetadata.teamIdentifier)
    || !isRealTeamIdentifier(helperMetadata.teamIdentifier)) {
    throw new Error('Harness and its desktop helper must use a real code-signing identity');
  }
  if (appMetadata.teamIdentifier !== helperMetadata.teamIdentifier) {
    throw new Error('Harness and its desktop helper must share the same Team ID');
  }
  return {
    appTeamIdentifier: appMetadata.teamIdentifier,
    helperTeamIdentifier: helperMetadata.teamIdentifier,
  };
}

if (require.main === module) {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('Usage: verify-macos-helper-identity.js /path/to/Harness.app');
    process.exit(1);
  }
  try {
    verifyMacHelperIdentity(path.resolve(appPath));
    console.log('macOS desktop helper signing identity verified');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  HELPER_RELATIVE_PATH,
  parseCodeSignMetadata,
  readCodeSignMetadata,
  verifyMacHelperIdentity,
};
