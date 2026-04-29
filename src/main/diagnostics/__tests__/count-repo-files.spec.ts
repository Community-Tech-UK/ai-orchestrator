import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { countRepoFiles } from '../count-repo-files';

let tempDir: string | null = null;

describe('countRepoFiles', () => {
  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it('counts files while skipping large generated directories', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-count-'));
    await writeFile(join(tempDir, 'a.ts'), 'a');
    await mkdir(join(tempDir, 'src'));
    await writeFile(join(tempDir, 'src', 'b.ts'), 'b');
    await mkdir(join(tempDir, 'node_modules'));
    await writeFile(join(tempDir, 'node_modules', 'ignored.js'), 'ignored');

    await expect(countRepoFiles(tempDir)).resolves.toBe(2);
  });

  it('stops after the configured threshold', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'repo-count-'));
    await writeFile(join(tempDir, 'a.ts'), 'a');
    await writeFile(join(tempDir, 'b.ts'), 'b');
    await writeFile(join(tempDir, 'c.ts'), 'c');

    await expect(countRepoFiles(tempDir, { stopAfter: 1 })).resolves.toBe(2);
  });
});
