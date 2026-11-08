import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { getHookCommands, runHook } = require('../run-git-hook.js') as {
  getHookCommands: (hookName: string) => Array<{ command: string; args: string[] }>;
  runHook: (
    hookName: string,
    options: {
      spawnSync?: (command: string, args: string[]) => { status: number | null; signal?: NodeJS.Signals | null; stdout?: string };
      env?: NodeJS.ProcessEnv;
      cwd?: string;
    },
  ) => number;
};

describe('run-git-hook', () => {
  it('pre-commit lints fast, regenerates generated artifacts, stages them, and runs changed-file tests', () => {
    expect(getHookCommands('pre-commit')).toEqual([
      { command: 'npm', args: ['run', 'lint:fast'] },
      { command: 'npm', args: ['run', 'generate:aliases'] },
      { command: 'npm', args: ['run', 'generate:ipc'] },
      { command: 'npm', args: ['run', 'generate:architecture'] },
      { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
      {
        command: 'git',
        args: [
          'add',
          'src/main/register-aliases.ts',
          'src/preload/generated/channels.ts',
          'docs/generated/architecture-inventory.json',
        ],
      },
      { command: 'npm', args: ['run', 'build:main'] },
      { command: 'npm', args: ['run', 'test:staged'] },
    ]);
  });

  it('pre-push mirrors the CI quality gates (full test suite stays a CI gate)', () => {
    expect(getHookCommands('pre-push')).toEqual([
      { command: 'npm', args: ['run', 'lint:fast'] },
      { command: 'npm', args: ['run', 'verify:exports'] },
      { command: 'npm', args: ['run', 'check:provider-parity'] },
      { command: 'npm', args: ['run', 'check:ui-hints', '--', '--warn'] },
      { command: 'npm', args: ['run', 'verify:ipc'] },
      { command: 'npm', args: ['run', 'check:contracts'] },
      { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
      { command: 'npm', args: ['run', 'verify:architecture'] },
      { command: 'node', args: ['scripts/remote-checks/checks.js', '--set', 'push'] },
    ]);
  });

  it('refuses a push from a Plan Queue session before running any check, and leaves commits and people alone', () => {
    const calls: string[] = [];
    const spawnSync = (command: string) => { calls.push(command); return { status: 0 }; };
    expect(runHook('pre-push', { spawnSync, env: { AIO_QUEUE_SESSION: '1' } } as never)).toBe(1);
    expect(calls).toEqual([]);
    expect(runHook('pre-commit', { spawnSync, env: { AIO_QUEUE_SESSION: '1' } } as never)).toBe(0);
    calls.length = 0;
    expect(runHook('pre-push', { spawnSync, env: {} } as never)).toBe(0);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('runs hook commands in order and returns zero when all commands pass', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = runHook('pre-push', {
      env: {},
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual(getHookCommands('pre-push'));
  });

  it('stops at the first failing hook command', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = runHook('pre-push', {
      env: {},
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return { status: calls.length === 2 ? 1 : 0 };
      },
    });

    expect(status).toBe(1);
    expect(calls).toEqual(getHookCommands('pre-push').slice(0, 2));
  });

  it('builds current worker assets before staged tests and stops if the build fails', () => {
    const calls: string[][] = [];
    const status = runHook('pre-commit', {
      spawnSync: (_command, args) => {
        calls.push(args);
        return { status: args.includes('build:main') ? 2 : 0 };
      },
    });

    expect(status).toBe(2);
    expect(calls.at(-1)).toEqual(['run', 'build:main']);
    expect(calls).not.toContainEqual(['run', 'test:staged']);
  });

  it('skips only related tests after confirming the frozen staged tree', () => {
    const tree = 'a'.repeat(40);
    const calls: Array<{ command: string; args: string[] }> = [];
    expect(runHook('pre-commit', { env: { AIO_PLAN_QUEUE_TESTS_COVERED: '1', AIO_PLAN_QUEUE_TESTS_COVERED_TREE: tree },
      spawnSync: (command, args) => { calls.push({ command, args }); return { status: 0, stdout: `${tree}\n` }; },
    })).toBe(0);
    expect(calls.filter(call => call.args[0] !== 'write-tree'))
      .toEqual(getHookCommands('pre-commit').filter(call => call.args[1] !== 'test:staged'));
    expect(calls.at(-1)).toEqual({ command: 'git', args: ['write-tree'] });
  });

  it.each(['missing', 'changed', 'failed'] as const)('runs related tests when the staged-tree proof is %s', proof => {
    const tree = 'a'.repeat(40);
    const calls: Array<{ command: string; args: string[] }> = [];
    expect(runHook('pre-commit', { env: { AIO_PLAN_QUEUE_TESTS_COVERED: '1',
      ...(proof === 'missing' ? {} : { AIO_PLAN_QUEUE_TESTS_COVERED_TREE: tree }) },
      spawnSync: (command, args) => { calls.push({ command, args });
        return args[0] === 'write-tree' ? { status: proof === 'failed' ? 1 : 0, stdout: `${'b'.repeat(40)}\n` } : { status: 0 }; },
    })).toBe(0);
    expect(calls.filter(call => call.args[0] !== 'write-tree')).toEqual(getHookCommands('pre-commit'));
  });

  it.each([false, true])('rechecks the real staged tree after generators (code changed: %s)', changed => {
    const root = mkdtempSync(join(tmpdir(), 'queue-hook-proof-'));
    try {
      const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      git(['init', '-q']);
      const bin = join(root, '.git', 'bin'); mkdirSync(bin);
      const calls = join(root, '.git', 'npm-calls');
      const npm = join(bin, 'npm');
      writeFileSync(npm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOOK_CALLS"\n'
        + 'if [ "$2" = "generate:aliases" ] && [ "$CHANGE_CODE" = "1" ]; then echo changed >> src/main/register-aliases.ts; fi\n');
      chmodSync(npm, 0o755);
      for (const file of ['src/main/register-aliases.ts', 'src/preload/generated/channels.ts', 'docs/generated/architecture-inventory.json']) {
        mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), 'original\n');
      }
      git(['add', '.']);
      const tree = git(['write-tree']);
      const runner = join(root, '.git', 'run-git-hook.js');
      writeFileSync(runner, readFileSync(require.resolve('../run-git-hook.js')));
      writeFileSync(join(root, '.git', 'generated-artifacts.json'), readFileSync(require.resolve('../generated-artifacts.json')));
      execFileSync(process.execPath, [runner, 'pre-commit'], { cwd: root, env: {
        ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOOK_CALLS: calls, CHANGE_CODE: changed ? '1' : '0',
        AIO_PLAN_QUEUE_TESTS_COVERED: '1', AIO_PLAN_QUEUE_TESTS_COVERED_TREE: tree,
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      const commands = readFileSync(calls, 'utf8').trim().split('\n');
      expect(commands).toEqual(getHookCommands('pre-commit').filter(call => call.command === 'npm'
        && (changed || call.args[1] !== 'test:staged')).map(call => call.args.join(' ')));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects unknown hook names', () => {
    expect(() => getHookCommands('post-merge')).toThrow('Unknown git hook: post-merge');
  });
});
