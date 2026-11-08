#!/usr/bin/env node
/* eslint-env node */

'use strict';

const { spawnSync } = require('node:child_process');

// The list of files this hook regenerates lives in one JSON file, read here and by
// Harness's Plan Queue (src/main/plan-queue/plan-queue-generated-files.ts) so a
// landing never refuses a root copy of a file this hook rebuilds anyway.
// `generators` are npm script names, run in this order before the artifacts are staged.
const { artifacts: GENERATED_ARTIFACTS, generators: GENERATORS } = require('./generated-artifacts.json');

const HOOK_COMMANDS = {
  'pre-commit': [
    // Sub-second lint catch first so obvious breakage fails before the slower
    // generate/test steps below.
    { command: 'npm', args: ['run', 'lint:fast'] },
    ...GENERATORS.map((script) => ({ command: 'npm', args: ['run', script] })),
    // Warn-only locally so a commit/push is never blocked purely by file size.
    // CI runs `npm run check:ts-max-loc` without --warn, so it stays the enforcing gate.
    { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
    { command: 'git', args: ['add', ...GENERATED_ARTIFACTS] },
    // Fast feedback at commit time: run only the tests related to the staged
    // source files (`vitest related`), not the full suite. This is the "best of
    // both" gate — quick, scoped test coverage on commit, with the slow
    // full suite still living in CI. test-staged.js excludes the
    // generated artifacts staged just above (they're widely imported and would
    // balloon the run) and skips the test invocation when no source files are
    // staged. The build still runs first to validate current worker assets.
    // Bypass in an emergency with `git commit --no-verify`.
    // Related tests launch the compiled CLI worker. Rebuild from current source
    // so a clean checkout or live-test cleanup cannot leave it missing or stale.
    { command: 'npm', args: ['run', 'build:main'] },
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
    { command: 'npm', args: ['run', 'check:ui-hints', '--', '--warn'] },
    { command: 'npm', args: ['run', 'verify:ipc'] },
    { command: 'npm', args: ['run', 'check:contracts'] },
    { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
    { command: 'npm', args: ['run', 'verify:architecture'] },
    // Lint, both type checks and the three builds, on the test machine when one is set up and here
    // otherwise, from one snapshot of the working tree. All six run whatever fails, and the first
    // failure's exit code stops the push.
    { command: 'node', args: ['scripts/remote-checks/checks.js', '--set', 'push'] },
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

  // Plan Queue sessions never push (src/main/plan-queue/plan-queue-push-guard.ts sets this). Refuse
  // before the slow checks; a person's own pushes never carry the variable.
  if (hookName === 'pre-push' && env.AIO_QUEUE_SESSION) {
    console.error('Refusing to push: this is a Plan Queue session, and queue sessions never push. James pushes.');
    return 1;
  }

  for (const { command, args } of commands) {
    if (hookName === 'pre-commit' && command === 'npm' && args[0] === 'run' && args[1] === 'test:staged'
      && env.AIO_PLAN_QUEUE_TESTS_COVERED === '1'
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(env.AIO_PLAN_QUEUE_TESTS_COVERED_TREE ?? '')) {
      // Earlier generators may have staged different code. Reuse evidence only
      // after ALL those steps, against the exact index the tests would judge.
      const tree = run('git', ['write-tree'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (!tree.error && !tree.signal && tree.status === 0
        && String(tree.stdout).trim() === env.AIO_PLAN_QUEUE_TESTS_COVERED_TREE) {
        console.log('Skipping related tests: this exact staged tree already passed the queue checklist.');
        continue;
      }
    }
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
