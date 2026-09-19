import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitWithHooks } from './plan-queue-squash';

let repo: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-squash-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(['add', 'a.txt']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('commitWithHooks', () => {
  it.skipIf(process.platform === 'win32')('kills the whole hook process tree on a timeout, not just git', async () => {
    const pidFile = join(repo, '.git', 'grandchild.pid');
    const hooks = join(repo, '.git', 'test-hooks');
    mkdirSync(hooks, { recursive: true });
    // The hook starts a long-running descendant (like a generator or vitest) and waits.
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nwait\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);

    const started = Date.now();
    const result = await commitWithHooks(repo, 'timed out', 1_500);

    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('timed out after 1500ms');
    // Resolves at the timeout, not when an orphan finally lets go of the output pipe.
    expect(Date.now() - started).toBeLessThan(20_000);
    const grandchild = Number(readFileSync(pidFile, 'utf-8').trim());
    await vi.waitFor(() => { if (isAlive(grandchild)) throw new Error('hook descendant still running'); }, { timeout: 5_000 });
    expect(() => git(['rev-parse', '-q', '--verify', 'HEAD'])).toThrow();
  }, 20_000);

  it('commits when the hook passes', async () => {
    const result = await commitWithHooks(repo, 'ok');

    expect(result.exitCode).toBe(0);
    expect(git(['log', '--format=%s'])).toBe('ok');
  });
});
