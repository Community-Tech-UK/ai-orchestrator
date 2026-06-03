import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getHookCommands, runHook } = require('../run-git-hook.js') as {
  getHookCommands: (hookName: string) => Array<{ command: string; args: string[] }>;
  runHook: (
    hookName: string,
    options: {
      spawnSync: (command: string, args: string[]) => { status: number | null; signal?: NodeJS.Signals | null };
    },
  ) => number;
};

describe('run-git-hook', () => {
  it('pre-commit regenerates generated artifacts and stages them', () => {
    expect(getHookCommands('pre-commit')).toEqual([
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
    ]);
  });

  it('pre-push verifies generated artifacts and runs the full test suite', () => {
    expect(getHookCommands('pre-push')).toEqual([
      { command: 'npm', args: ['run', 'verify:ipc'] },
      { command: 'npm', args: ['run', 'check:contracts'] },
      { command: 'npm', args: ['run', 'check:ts-max-loc', '--', '--warn'] },
      { command: 'npm', args: ['run', 'verify:architecture'] },
      { command: 'npm', args: ['run', 'test'] },
    ]);
  });

  it('runs hook commands in order and returns zero when all commands pass', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = runHook('pre-push', {
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
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return { status: calls.length === 2 ? 1 : 0 };
      },
    });

    expect(status).toBe(1);
    expect(calls).toEqual(getHookCommands('pre-push').slice(0, 2));
  });

  it('rejects unknown hook names', () => {
    expect(() => getHookCommands('post-merge')).toThrow('Unknown git hook: post-merge');
  });
});
