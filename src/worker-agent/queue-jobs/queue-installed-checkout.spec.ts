import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRANCH, JOB, PROJECT, commitAll, documents, makeFixture, runGit, sendCommit, writeFile, type Fixture } from './queue-job-fixture.test-helpers';
import { npmInstaller } from './queue-installed-checkout';

let fx: Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.dispose());

const installedPath = (): string => join(fx.root, 'queue-repos', `${PROJECT}-installed`);
async function prepareAt(commit: string, jobId: string, startCommit = commit) {
  await sendCommit(fx, { commit, jobId, startCommit, have: [] });
  return fx.host.prepare({ project: PROJECT, jobId, branch: `queue/${jobId}-xyz`, commit, documents: documents({}), turnId: 't1' });
}

describe('the installed checkout (queue.prepare)', () => {
  it('is a worktree of the bare repository, installed once, and not installed again for the same lock file', async () => {
    const start = runGit(['rev-parse', 'HEAD'], fx.mac);
    const first = await prepareAt(start, 'job-a');
    expect(first.installed).toBe(true);
    expect(fx.install).toHaveBeenCalledTimes(1);
    expect(fx.install).toHaveBeenCalledWith(installedPath(), true);
    expect(runGit(['rev-parse', '--git-common-dir'], installedPath())).toMatch(/\.git$/);
    expect(runGit(['rev-parse', 'HEAD'], installedPath())).toBe(start);

    writeFile(fx.mac, 'src/a.txt', 'changed\n'); // same package-lock.json
    const second = commitAll(fx.mac, 'code only');
    const again = await prepareAt(second, 'job-b');
    expect(again.installed).toBe(false);
    expect(fx.install).toHaveBeenCalledTimes(1);
    expect(runGit(['rev-parse', 'HEAD'], installedPath())).toBe(second); // moved to the job's starting commit
  });

  it('installs again when the lock file in the job\'s start commit differs, and records it', async () => {
    const start = runGit(['rev-parse', 'HEAD'], fx.mac);
    await prepareAt(start, 'job-a');
    writeFile(fx.mac, 'package-lock.json', '{"lock":2}');
    const changed = commitAll(fx.mac, 'new lock file');
    const result = await prepareAt(changed, 'job-b');
    expect(result.installed).toBe(true);
    expect(fx.install).toHaveBeenCalledTimes(2);
    const marker = join(runGit(['rev-parse', '--absolute-git-dir'], installedPath()), 'queue-installed-lock');
    expect(readFileSync(marker, 'utf8')).toBe(runGit(['rev-parse', `${changed}:package-lock.json`], fx.mac));
    // The lock file of the START commit decides, not the latest commit sent.
    writeFile(fx.mac, 'package-lock.json', '{"lock":3}');
    const later = commitAll(fx.mac, 'third lock file');
    expect((await prepareAt(later, 'job-c', changed)).installed).toBe(false);
  });

  it('installs again when the dependencies folder has gone, and a failed install is retried rather than remembered', async () => {
    const start = runGit(['rev-parse', 'HEAD'], fx.mac);
    fx.install.mockRejectedValueOnce(new Error('Installing the project\'s dependencies failed (npm ci exit 1)'));
    await expect(prepareAt(start, 'job-a')).rejects.toThrow(/dependencies failed/);
    expect((await prepareAt(start, 'job-a2')).installed).toBe(true);
    expect(fx.install).toHaveBeenCalledTimes(2);
  });

  it('runs one installer per project at a time', async () => {
    const start = runGit(['rev-parse', 'HEAD'], fx.mac);
    let running = 0;
    let peak = 0;
    fx.install.mockImplementation(async path => {
      running += 1; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 60));
      writeFile(path, 'node_modules/dep/index.js', 'x');
      running -= 1;
    });
    await Promise.all([prepareAt(start, 'job-a'), prepareAt(start, 'job-b')]);
    expect(peak).toBe(1);
    expect(fx.install).toHaveBeenCalledTimes(1); // the second saw the first's install
    expect(existsSync(installedPath())).toBe(true);
    expect(BRANCH && JOB).toBeTruthy();
  });
});

describe('npmInstaller', () => {
  const limits = { installTimeoutMs: 120_000 } as never;
  it('runs `npm ci` with a lock file and `npm install` without, and never puts output in a refusal beyond a redacted tail', async () => {
    const runner = vi.fn().mockResolvedValue({ code: 0, timedOut: false, tail: '' });
    await npmInstaller({ runner, limits })('/p', true);
    await npmInstaller({ runner, limits })('/p', false);
    expect(runner.mock.calls.map(call => call[1])).toEqual([['ci'], ['install']]);
    runner.mockResolvedValueOnce({ code: 1, timedOut: false, tail: 'npm ERR! _authToken=abc123secret failed' });
    const error = await npmInstaller({ runner, limits })('/p', true).catch((e: Error) => e);
    expect((error as Error).message).toContain('failed (npm ci exit 1)');
    expect((error as Error).message).not.toContain('abc123secret');
    runner.mockResolvedValueOnce({ code: null, timedOut: true, tail: '' });
    await expect(npmInstaller({ runner, limits })('/p', true)).rejects.toThrow(/took longer than 2 minutes/);
  });
});
