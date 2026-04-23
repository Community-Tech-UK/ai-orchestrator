import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveProjectScanRoots } from '../project-scan-roots';

describe('resolveProjectScanRoots', () => {
  it('returns the git-root ancestry down to the working directory', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-scan-roots-'));
    const projectRoot = path.join(tempRoot, 'repo');
    const workingDirectory = path.join(projectRoot, 'packages', 'app');

    await fs.promises.mkdir(path.join(projectRoot, '.git'), { recursive: true });
    await fs.promises.mkdir(workingDirectory, { recursive: true });

    expect(resolveProjectScanRoots(workingDirectory, tempRoot)).toEqual([
      projectRoot,
      path.join(projectRoot, 'packages'),
      workingDirectory,
    ]);

    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it('falls back to the working directory when no git root is found', async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'project-scan-roots-'));
    const workingDirectory = path.join(tempRoot, 'standalone');
    await fs.promises.mkdir(workingDirectory, { recursive: true });

    expect(resolveProjectScanRoots(workingDirectory, tempRoot)).toEqual([workingDirectory]);

    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });
});
