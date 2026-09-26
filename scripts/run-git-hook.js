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
    // Sub-second lint catch first so obvious breakage fails before the slower
    // generate/test steps below.
    { command: 'npm', args: ['run', 'lint:fast'] },
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
    // full suite still living in CI. test-staged.js excludes the
    // generated artifacts staged just above (they're widely imported and would
    // balloon the run) and skips entirely when no source files are staged, so
    // the loop agents' high-frequency auto-commits stay near-instant. Bypass in
    // an emergency with `git commit --no-verify`.
    { command: 'npm', args: ['run', 'test:staged'] },
  ],
  // This mirrors the checks in CI's "Lint, Typecheck, Build Smoke" job
  // (~90s locally): lint/typecheck/build failures are exactly what used to
  // reach CI and redden whole runs (e.g. the typecheck:spec error that sat on
  // main because no local gate ran it and CI died in npm ci before reaching
  // the step). Deviations from CI by design: checks run in local fast-fail
  // order, check:ts-max-loc is --warn here (CI runs it enforcing), and CI's
  // non-blocking model-catalog drift notice is omitted (meaningless at push).
  // Fast structural checks run first so obvious breakage fails before the
  // ~25s typechecks and builds.
  'pre-push': [
    { command: 'npm', args: ['run', 'lint:fast'] },
    { command: 'npm', args: ['run', 'verify:exports'] },
    { command: 'npm', args: ['run', 'check:provider-parity'] },
    { command: 'npm', args: ['run', 'verify:ipc'] },
    { command: 'npm', args: ['run', 'check:contracts'] },
    { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
    { command: 'npm', args: ['run', 'verify:architecture'] },
    { command: 'npm', args: ['run', 'lint'] },
    { command: 'npm', args: ['run', 'typecheck'] },
    { command: 'npm', args: ['run', 'typecheck:spec'] },
    { command: 'npm', args: ['run', 'build:main'] },
    { command: 'npm', args: ['run', 'build:worker-agent'] },
    { command: 'npm', args: ['run', 'build:renderer'] },
    // The full `npm run test` suite is deliberately NOT run here. It is a
    // CI gate (plus the slow-tier `test:slow`), and a multi-minute suite per
    // push is the wrong latency for agent-driven workflows; a flaky test would
    // also block pushes that are fine. The old socket-drop hazard (git runs
    // this hook on the same idle SSH connection it later sends the pack over)
    // is mitigated by the keepalives install-git-hooks.js installs in
    // core.sshCommand when that key is unset, so these ~90s of gates should
    // no longer drop the push connection the way the old full suite did —
    // provided the hooks have been (re)installed and no custom core.sshCommand
    // without keepalives of its own was preserved. Bypass anything here in an
    // emergency with `git push --no-verify`.
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
