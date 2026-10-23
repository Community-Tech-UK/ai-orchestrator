#!/usr/bin/env node
/* eslint-env node */
'use strict';

const { spawnSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

/** Every installed CLI bump, including patches, refreshes the source snapshot before compilation. */
function refreshCodexProtocol(options = {}) {
  const run = options.run ?? spawnSync;
  const warn = options.warn ?? console.warn;
  const root = options.root ?? process.cwd();
  const result = run('codex', ['--version'], { cwd: root, encoding: 'utf8', timeout: 15_000 });
  if (result.error?.code === 'ENOENT') {
    warn('Codex CLI unavailable; protocol snapshot not verified. Building with the committed snapshot.');
    return 'unverified';
  }
  if (result.error || result.status !== 0 || !/^codex-cli \d+\.\d+\.\d+$/.test(result.stdout?.trim() ?? '')) {
    throw new Error('Could not probe installed Codex CLI for protocol snapshot refresh.');
  }
  const installed = result.stdout.trim();
  const readSnapshot = options.readSnapshot ?? (() => readFileSync(join(root, 'src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts'), 'utf8'));
  const snapshot = /CODEX_APP_SERVER_PROTOCOL_VERSION = "(codex-cli \d+\.\d+\.\d+)"/.exec(readSnapshot())?.[1];
  if (snapshot === installed) return 'current';

  const generated = run(process.execPath, [require.resolve('tsx/cli'), 'scripts/generate-codex-app-server-protocol.ts'], {
    cwd: root, stdio: 'inherit', timeout: 120_000,
  });
  if (generated.error || generated.status !== 0) throw new Error('Codex protocol snapshot regeneration failed.');
  console.info(`Codex protocol snapshot regenerated for ${installed}.`);
  return 'regenerated';
}

if (require.main === module) {
  try { refreshCodexProtocol(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { refreshCodexProtocol };
