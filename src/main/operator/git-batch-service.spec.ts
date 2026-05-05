import { execFileSync } from 'child_process';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitBatchService } from './git-batch-service';

describe('GitBatchService', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
    tempPaths.length = 0;
  });

  it('pulls clean tracking repositories with fast-forward only', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'git-batch-pull-'));
    tempPaths.push(workspace);
    const { seed, clone } = setupTrackingRepo(workspace);
    const commands: Array<Record<string, unknown>> = [];

    await fs.writeFile(path.join(seed, 'feature.txt'), 'feature\n', 'utf-8');
    git(seed, ['add', 'feature.txt']);
    git(seed, ['commit', '-m', 'feature']);
    git(seed, ['push']);

    const result = await new GitBatchService().pullAll(workspace, {
      concurrency: 2,
      onShellCommand: (command) => commands.push(command),
    });

    expect(result.total).toBe(1);
    expect(result.pulled).toBe(1);
    expect(result.results[0]).toMatchObject({
      repositoryPath: clone,
      status: 'pulled',
      reason: null,
    });
    expect(await fs.readFile(path.join(clone, 'feature.txt'), 'utf-8')).toBe('feature\n');
    expect(commands).toEqual([
      expect.objectContaining({
        cmd: 'git',
        args: ['fetch', '--prune'],
        cwd: clone,
        exitCode: 0,
        stdoutBytes: expect.any(Number),
        stderrBytes: expect.any(Number),
        durationMs: expect.any(Number),
      }),
      expect.objectContaining({
        cmd: 'git',
        args: ['pull', '--ff-only'],
        cwd: clone,
        exitCode: 0,
        stdoutBytes: expect.any(Number),
        stderrBytes: expect.any(Number),
        durationMs: expect.any(Number),
      }),
    ]);
  });

  it('skips dirty and no-remote repositories', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'git-batch-skip-'));
    tempPaths.push(workspace);
    const { clone } = setupTrackingRepo(workspace, 'dirty-repo');
    await fs.writeFile(path.join(clone, 'local.txt'), 'local\n', 'utf-8');
    const noRemote = path.join(workspace, 'no-remote');
    await fs.mkdir(noRemote);
    git(noRemote, ['init']);
    configureUser(noRemote);

    const result = await new GitBatchService().pullAll(workspace, { concurrency: 2 });

    expect(result.total).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.results.map((repo) => [path.basename(repo.repositoryPath), repo.reason]).sort()).toEqual([
      ['dirty-repo', 'dirty_worktree'],
      ['no-remote', 'no_remote'],
    ]);
  });

  function setupTrackingRepo(workspace: string, cloneName = 'app'): { seed: string; clone: string } {
    const remote = path.join(workspace, `${cloneName}.git`);
    const seedRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'git-batch-seed-'));
    tempPaths.push(seedRoot);
    const seed = path.join(seedRoot, `${cloneName}-seed`);
    const clone = path.join(workspace, cloneName);
    git(workspace, ['init', '--bare', remote]);
    fsSync.mkdirSync(seed, { recursive: true });
    git(workspace, ['init', seed]);
    configureUser(seed);
    git(seed, ['checkout', '-b', 'main']);
    fsSync.writeFileSync(path.join(seed, 'README.md'), '# Test\n', 'utf-8');
    git(seed, ['add', 'README.md']);
    git(seed, ['commit', '-m', 'initial']);
    git(seed, ['remote', 'add', 'origin', remote]);
    git(seed, ['push', '-u', 'origin', 'main']);
    git(workspace, ['clone', remote, clone]);
    git(clone, ['checkout', 'main']);
    configureUser(clone);
    return { seed, clone };
  }

  function configureUser(cwd: string): void {
    git(cwd, ['config', 'user.email', 'test@example.com']);
    git(cwd, ['config', 'user.name', 'Test User']);
  }

  function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
});
