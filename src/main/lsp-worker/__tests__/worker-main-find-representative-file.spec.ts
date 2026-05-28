import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FindRepresentativeFile = (workspacePath: string, language: string) => Promise<string | null>;

describe('findRepresentativeFile', () => {
  let tmpRoot: string;
  let findRepresentativeFile: FindRepresentativeFile;
  let parentPort: EventEmitter & { postMessage: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = await mkdtemp(path.join(tmpdir(), 'lsp-representative-file-'));
    parentPort = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
    });

    vi.doMock('node:worker_threads', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:worker_threads')>();
      return {
        ...actual,
        default: { ...actual, parentPort },
        parentPort,
      };
    });

    const module = await import('../worker-main') as { findRepresentativeFile?: FindRepresentativeFile };
    if (!module.findRepresentativeFile) {
      throw new Error('findRepresentativeFile is not exported');
    }
    findRepresentativeFile = module.findRepresentativeFile;
  });

  afterEach(async () => {
    parentPort.removeAllListeners();
    vi.doUnmock('node:worker_threads');
    vi.resetModules();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns a TypeScript file for a TypeScript workspace', async () => {
    const filePath = path.join(tmpRoot, 'src', 'index.ts');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'export const value = 1;\n');

    await expect(findRepresentativeFile(tmpRoot, 'typescript')).resolves.toBe(filePath);
  });

  it('falls back to supported extensions when language is unknown', async () => {
    const filePath = path.join(tmpRoot, 'src', 'index.ts');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, 'export const value = 1;\n');

    await expect(findRepresentativeFile(tmpRoot, 'unknown')).resolves.toBe(filePath);
  });

  it('returns null when no supported source files exist', async () => {
    const filePath = path.join(tmpRoot, 'README.md');
    await writeFile(filePath, '# docs\n');

    await expect(findRepresentativeFile(tmpRoot, 'typescript')).resolves.toBeNull();
    await expect(findRepresentativeFile(tmpRoot, 'unknown')).resolves.toBeNull();
  });

  it('skips ignored directories while scanning for a representative file', async () => {
    const ignoredFile = path.join(tmpRoot, 'node_modules', 'pkg', 'index.ts');
    const sourceFile = path.join(tmpRoot, 'src', 'index.ts');
    for (const filePath of [ignoredFile, sourceFile]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, 'export const value = 1;\n');
    }

    await expect(findRepresentativeFile(tmpRoot, 'typescript')).resolves.toBe(sourceFile);
  });
});
