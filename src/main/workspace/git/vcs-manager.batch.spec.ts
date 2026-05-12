import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VcsManager } from './vcs-manager';

describe('VcsManager batch helpers', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(tempPaths.map((tempPath) => fs.rm(tempPath, { recursive: true, force: true })));
    tempPaths.length = 0;
  });

  it('finds git repositories without recursing into ignored dependency directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcs-manager-batch-'));
    tempPaths.push(root);
    const repo = path.join(root, 'app');
    const ignoredRepo = path.join(root, 'node_modules', 'dep');
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await fs.mkdir(path.join(ignoredRepo, '.git'), { recursive: true });

    expect(VcsManager.findRepositories(root)).toEqual([repo]);
  });

  // Phase 2a (item 4 prologue) — the original implementation returned as
  // soon as it found `.git`, so a monorepo with submodules below the
  // selected root would never surface the child repos. The fix is to
  // record the parent and keep walking below it.
  it('continues walking after finding `.git` so nested repos are surfaced', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcs-manager-nested-'));
    tempPaths.push(root);
    const child = path.join(root, 'packages', 'child');
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.mkdir(path.join(child, '.git'), { recursive: true });

    const repos = VcsManager.findRepositories(root);
    expect(repos).toContain(root);
    expect(repos).toContain(child);
  });
});
