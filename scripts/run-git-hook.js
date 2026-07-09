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
    // Warn-only locally so a commit/push is never blocked purely by file size.
    // CI runs `npm run check:ts-max-loc` without --warn, so it stays the enforcing gate.
    { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
    { command: 'git', args: ['add', ...GENERATED_ARTIFACTS] },
    // Fast feedback at commit time: run only the tests related to the staged
    // source files (`vitest related`), not the full suite. This is the "best of
    // both" gate — quick, scoped test coverage on commit, with the slow
    // CI-mirror full suite still living on pre-push. test-staged.js excludes the
    // generated artifacts staged just above (they're widely imported and would
    // balloon the run) and skips entirely when no source files are staged, so
    // the loop agents' high-frequency auto-commits stay near-instant. Bypass in
    // an emergency with `git commit --no-verify`.
    { command: 'npm', args: ['run', 'test:staged'] },
  ],
  'pre-push': [
    { command: 'npm', args: ['run', 'verify:ipc'] },
    { command: 'npm', args: ['run', 'check:contracts'] },
    // Warn-only locally so a commit/push is never blocked purely by file size.
    // CI runs `npm run check:ts-max-loc` without --warn, so it stays the enforcing gate.
    { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
    { command: 'npm', args: ['run', 'verify:architecture'] },
    // Run the default (fast) suite before code leaves the machine for CI. This
    // is the CI-mirror gate that blocks pushing red tests — the exact failure
    // that prompted this hook. It lives on pre-push, not pre-commit, because
    // the suite is still multi-minute and the live app's loop agents auto-commit
    // on shutdown; a blocking pre-commit suite would stall those commits.
    // Slow-tier e2e/soak runs in CI (`test:slow`), not on every local push.
    // Bypass in an emergency with `git push --no-verify`.
    { command: 'npm', args: ['run', 'test'] },
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
