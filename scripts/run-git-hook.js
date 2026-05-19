#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { spawnSync } = require('node:child_process');

const GENERATED_ARTIFACTS = [
  'src/main/register-aliases.ts',
  'src/preload/generated/channels.ts',
  'docs/generated/architecture-inventory.json',
];

const HOOK_COMMANDS = {
  'pre-commit': [
    { command: 'npm', args: ['run', 'generate:aliases'] },
    { command: 'npm', args: ['run', 'generate:ipc'] },
    { command: 'npm', args: ['run', 'generate:architecture'] },
    { command: 'git', args: ['add', ...GENERATED_ARTIFACTS] },
  ],
  'pre-push': [
    { command: 'npm', args: ['run', 'verify:ipc'] },
    { command: 'npm', args: ['run', 'check:contracts'] },
    { command: 'npm', args: ['run', 'verify:architecture'] },
  ],
};

function getHookCommands(hookName) {
  const commands = HOOK_COMMANDS[hookName];
  if (!commands) {
    throw new Error(`Unknown git hook: ${hookName}`);
  }
  return commands.map((command) => ({
    command: command.command,
    args: [...command.args],
  }));
}

function runHook(hookName, options = {}) {
  const commands = getHookCommands(hookName);
  const run = options.spawnSync ?? spawnSync;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  for (const { command, args } of commands) {
    const result = run(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    if (result.error) {
      console.error(`Git hook ${hookName} failed to run "${command} ${args.join(' ')}": ${result.error.message}`);
      return 1;
    }

    if (result.signal) {
      console.error(`Git hook ${hookName} stopped because "${command} ${args.join(' ')}" received ${result.signal}`);
      return 1;
    }

    const status = result.status ?? 1;
    if (status !== 0) {
      return status;
    }
  }

  return 0;
}

function main() {
  const hookName = process.argv[2];
  if (!hookName) {
    console.error('Usage: node scripts/run-git-hook.js <pre-commit|pre-push>');
    process.exit(1);
  }

  try {
    process.exit(runHook(hookName));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  GENERATED_ARTIFACTS,
  getHookCommands,
  runHook,
};
