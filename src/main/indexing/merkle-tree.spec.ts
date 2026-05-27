import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { MerkleTreeManager } from './merkle-tree';
import { defaultPreflight } from './codebase-indexing-auto-defaults';

describe('MerkleTreeManager', () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('only includes files eligible for codebase indexing', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'merkle-eligible-'));
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await mkdir(join(tempRoot, 'cache'), { recursive: true });
    await mkdir(join(tempRoot, 'libraries'), { recursive: true });
    await mkdir(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });

    await writeFile(join(tempRoot, '.gitignore'), '/cache/\n/libraries/\n');
    await writeFile(join(tempRoot, 'src', 'main.ts'), 'export const value = 1;\n');
    await writeFile(join(tempRoot, 'README.md'), '# Test\n');
    await writeFile(join(tempRoot, 'cache', 'generated.ts'), 'export const ignored = true;\n');
    await writeFile(join(tempRoot, 'libraries', 'Generated.java'), 'class Generated {}\n');
    await writeFile(join(tempRoot, 'node_modules', 'pkg', 'index.ts'), 'export const ignored = true;\n');
    await writeFile(join(tempRoot, 'mojang.jar'), 'binary archive');
    await writeFile(join(tempRoot, 'large.json'), `${'x'.repeat(1024 * 1024 + 1)}\n`);

    const manager = new MerkleTreeManager();

    const tree = await manager.buildTree(tempRoot);
    const files = manager.collectAllFilePaths(tree).sort();

    expect(files).toEqual(['README.md', 'src/main.ts']);
  });

  it('preflight ignores files that the indexer would never include', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'preflight-eligible-'));
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await mkdir(join(tempRoot, 'libraries'), { recursive: true });
    await writeFile(join(tempRoot, 'src', 'main.ts'), 'export const value = 1;\n');
    await writeFile(join(tempRoot, 'libraries', 'dependency.jar'), 'x'.repeat(1024 * 64));

    const result = await defaultPreflight(tempRoot, {
      maxFiles: 10,
      maxBytes: 1024,
    });

    expect(result).toEqual({
      fileCount: 1,
      totalBytes: 24,
    });
  });
});
