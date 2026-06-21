/**
 * P5 acceptance: GitWriteQueue serializes orchestrator git writes and retries
 * transient git lock errors with backoff. The concurrency stress test runs many
 * git writes against a REAL temp git repo (per the plan's test strategy: git
 * integration units run against a real temp repo, not a mocked child_process)
 * and asserts no unhandled lock failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWriteQueue, getGitWriteQueue, isGitLockError } from './git-write-queue';
import { hermeticGitEnv } from './git-env';

const execFileAsync = promisify(execFile);

// Real-git tests spawn many child processes; give them generous timeouts so they
// don't flake under load (e.g. during a pre-commit `vitest related` run on a busy
// machine), where the default 5s per-test budget can be exceeded.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' });
  return stdout.trim();
}

describe('isGitLockError', () => {
  it('recognises the standard git lock phrasings', () => {
    expect(isGitLockError(new Error("Unable to create '/r/.git/index.lock': File exists."))).toBe(true);
    expect(isGitLockError(new Error("fatal: Unable to create '/r/.git/shallow.lock': File exists"))).toBe(true);
    expect(isGitLockError(new Error("cannot lock ref 'refs/heads/main'"))).toBe(true);
    expect(isGitLockError(new Error('Another git process seems to be running in this repository'))).toBe(true);
  });

  it('reads stderr off an exec-style error object', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: "fatal: Unable to create '/r/.git/index.lock': File exists.",
    });
    expect(isGitLockError(err)).toBe(true);
  });

  it('does NOT treat ordinary errors as lock errors', () => {
    expect(isGitLockError(new Error('merge conflict in foo.ts'))).toBe(false);
    expect(isGitLockError(new Error('nothing to commit'))).toBe(false);
    expect(isGitLockError(undefined)).toBe(false);
  });
});

describe('GitWriteQueue — serialization + retry', () => {
  beforeEach(() => {
    GitWriteQueue._resetForTesting();
  });

  it('runs enqueued ops strictly in order (single-flight)', async () => {
    const q = getGitWriteQueue();
    const order: number[] = [];
    const started: number[] = [];

    const mk = (n: number) => () =>
      new Promise<number>((resolve) => {
        started.push(n);
        // Each op overlaps in scheduling but must run after the previous resolves.
        setTimeout(() => {
          order.push(n);
          resolve(n);
        }, 5);
      });

    await Promise.all([q.enqueue('a', mk(1)), q.enqueue('b', mk(2)), q.enqueue('c', mk(3))]);

    expect(order).toEqual([1, 2, 3]);
    // No op should have started before the previous one finished.
    expect(started).toEqual([1, 2, 3]);
  });

  it('retries a transient lock error then succeeds', async () => {
    const q = getGitWriteQueue();
    q.configureRetry({ baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 });

    let calls = 0;
    const result = await q.enqueue('lock-then-ok', async () => {
      calls++;
      if (calls < 3) {
        throw new Error("fatal: Unable to create '/r/.git/index.lock': File exists.");
      }
      return 'done';
    });

    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('gives up after maxAttempts on persistent lock errors', async () => {
    const q = getGitWriteQueue();
    q.configureRetry({ baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 3 });

    let calls = 0;
    await expect(
      q.enqueue('always-locked', async () => {
        calls++;
        throw new Error("Unable to create '/r/.git/index.lock': File exists.");
      }),
    ).rejects.toThrow('index.lock');
    expect(calls).toBe(3);
  });

  it('does NOT retry non-lock errors', async () => {
    const q = getGitWriteQueue();
    q.configureRetry({ baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 5 });

    let calls = 0;
    await expect(
      q.enqueue('real-failure', async () => {
        calls++;
        throw new Error('merge conflict — manual resolution required');
      }),
    ).rejects.toThrow('merge conflict');
    expect(calls).toBe(1);
  });

  it('a rejected op does not poison the queue — later ops still run', async () => {
    const q = getGitWriteQueue();
    q.configureRetry({ baseDelayMs: 0, maxDelayMs: 0, maxAttempts: 1 });

    const p1 = q.enqueue('boom', async () => {
      throw new Error('boom');
    });
    const p2 = q.enqueue('ok', async () => 'survived');

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('survived');
  });
});

describe('GitWriteQueue — real-git concurrency stress', () => {
  let repo: string;

  beforeEach(async () => {
    GitWriteQueue._resetForTesting();
    repo = mkdtempSync(join(tmpdir(), 'gitwq-stress-'));
    await git(['init', '-q'], repo);
    await git(['config', 'user.email', 'test@example.com'], repo);
    await git(['config', 'user.name', 'Test'], repo);
    writeFileSync(join(repo, 'seed.txt'), 'seed\n');
    await git(['add', '-A'], repo);
    await git(['commit', '-q', '--no-gpg-sign', '-m', 'seed'], repo);
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('serializes 24 concurrent commits with zero unhandled lock failures', async () => {
    const q = getGitWriteQueue();
    q.configureRetry({ baseDelayMs: 5, maxDelayMs: 50, maxAttempts: 8 });

    const N = 24;
    const ops = Array.from({ length: N }, (_, i) =>
      q.enqueue(`commit-${i}`, async () => {
        writeFileSync(join(repo, `file-${i}.txt`), `content ${i}\n`);
        await git(['add', '-A'], repo);
        await git(['commit', '-q', '--no-gpg-sign', '-m', `commit ${i}`], repo);
        return i;
      }),
    );

    const results = await Promise.all(ops);
    expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i));

    // The repo must have N new commits on top of the seed, all applied cleanly.
    const count = await git(['rev-list', '--count', 'HEAD'], repo);
    expect(Number(count)).toBe(N + 1);

    // No lingering lock file.
    await expect(git(['status', '--porcelain'], repo)).resolves.toBe('');
  });
});
