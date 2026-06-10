import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyWorkerSupportFiles } from './support-files';

describe('copyWorkerSupportFiles', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-support-files-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('copies sibling worker-tools into the versioned service directory', async () => {
    const sourceDir = path.join(tempDir, 'source');
    const destinationDir = path.join(tempDir, 'versioned');
    await fs.mkdir(path.join(sourceDir, 'worker-tools'), { recursive: true });
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'worker-agent'), '');
    await fs.writeFile(path.join(sourceDir, 'worker-tools', 'axe-audit.mjs'), 'runner');

    await copyWorkerSupportFiles({
      binaryPath: path.join(sourceDir, 'worker-agent'),
      destinationDir,
    });

    await expect(
      fs.readFile(path.join(destinationDir, 'worker-tools', 'axe-audit.mjs'), 'utf-8'),
    ).resolves.toBe('runner');
  });

  it('does nothing when no sibling worker-tools directory exists', async () => {
    const sourceDir = path.join(tempDir, 'source');
    const destinationDir = path.join(tempDir, 'versioned');
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.mkdir(destinationDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'worker-agent'), '');

    await expect(
      copyWorkerSupportFiles({
        binaryPath: path.join(sourceDir, 'worker-agent'),
        destinationDir,
      }),
    ).resolves.toBeUndefined();
  });
});
