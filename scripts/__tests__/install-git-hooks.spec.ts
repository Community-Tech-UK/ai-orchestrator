import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { installGitHooks } = require('../install-git-hooks.js') as {
  installGitHooks: (
    options: {
      execFileSync: (command: string, args: string[]) => string | Buffer;
      log?: (message: string) => void;
      warn?: (message: string) => void;
    },
  ) => { installed: boolean; reason?: string };
};

describe('install-git-hooks', () => {
  it('configures tracked hooks when run inside a git worktree', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const messages: string[] = [];

    const result = installGitHooks({
      execFileSync: (command, args) => {
        calls.push({ command, args });
        return 'true';
      },
      log: (message) => messages.push(message),
    });

    expect(result).toEqual({ installed: true });
    expect(calls).toEqual([
      { command: 'git', args: ['rev-parse', '--is-inside-work-tree'] },
      { command: 'git', args: ['config', 'core.hooksPath', '.githooks'] },
    ]);
    expect(messages).toContain('Git hooks installed from .githooks');
  });

  it('skips gracefully when dependencies are installed outside a git worktree', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const messages: string[] = [];

    const result = installGitHooks({
      execFileSync: (command, args) => {
        calls.push({ command, args });
        throw new Error('not a git repository');
      },
      log: (message) => messages.push(message),
    });

    expect(result).toEqual({ installed: false, reason: 'not-git-worktree' });
    expect(calls).toEqual([
      { command: 'git', args: ['rev-parse', '--is-inside-work-tree'] },
    ]);
    expect(messages).toContain('Git hooks not installed: not inside a git worktree');
  });
});
