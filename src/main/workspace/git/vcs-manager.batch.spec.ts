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
});
