import type { Dir, Dirent } from 'node:fs';
import { mkdirSync, mkdtempSync, promises as fs, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Discovery from './plan-queue-discovery';

let root: string;
let discoverPlanQueueDocuments: typeof Discovery.discoverPlanQueueDocuments;
let previewPlanQueueDocuments: typeof Discovery.previewPlanQueueDocuments;
const originalOpen = fs.open;
const selected = 'docs/plans/target_plan.md';
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-discovery-bounds-')));
  mkdirSync(join(root, 'docs/plans'), { recursive: true });
  writeFileSync(join(root, selected), '# Plan\n');
  vi.spyOn(fs, 'opendir');
  vi.spyOn(fs, 'readdir');
  vi.spyOn(fs, 'open');
  vi.spyOn(fs, 'lstat');
  syncBuiltinESMExports();
  vi.resetModules();
  ({ discoverPlanQueueDocuments, previewPlanQueueDocuments } = await import('./plan-queue-discovery'));
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

function entry(name: string, directory = false): Dirent {
  return { name, isDirectory: () => directory, isFile: () => !directory } as Dirent;
}

describe('bounded discovery and I/O failures', () => {
  it('returns no matches if a literal ancestor stops being a directory during inspection', async () => {
    vi.mocked(fs.lstat).mockRejectedValueOnce(Object.assign(new Error('ancestor became a file'), { code: 'ENOTDIR' }));
    expect(await discoverPlanQueueDocuments(root, 'plans', 'docs/plans/*_plan.md')).toEqual([]);
    expect(fs.opendir).not.toHaveBeenCalled();
  });
  it('starts wildcard discovery and its copy preview inside the literal folder prefix', async () => {
    mkdirSync(join(root, 'unrelated'));
    expect(await previewPlanQueueDocuments(root, 'plans', 'docs/plans/*_plan.md')).toMatchObject({ found: 1, hiddenCountComplete: true });
    const opened = vi.mocked(fs.opendir).mock.calls.map(args => String(args[0]));
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every(dir => dir === join(root, 'docs/plans'))).toBe(true);
  });

  it.each(['ignored', 'evidence', 'linked'])('checks excluded or linked literal-prefix ancestors: %s', async directory => {
    if (directory === 'linked') symlinkSync(join(root, 'docs'), join(root, directory));
    else {
      mkdirSync(join(root, directory, 'plans'), { recursive: true });
      writeFileSync(join(root, directory, 'plans/target_plan.md'), '# Plan');
    }
    writeFileSync(join(root, '.planqueueignore'), 'ignored/\n');
    expect(await discoverPlanQueueDocuments(root, 'plans', `${directory}/plans/*_plan.md`)).toEqual([]);
    expect(fs.opendir).not.toHaveBeenCalled();
  });
  it('does not enumerate unrelated directories for an exact selection', async () => {
    const openDir = vi.spyOn(fs, 'opendir').mockRejectedValue(new Error('must not enumerate'));
    const readDir = vi.spyOn(fs, 'readdir').mockRejectedValue(new Error('must not enumerate'));
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([{ path: join(root, selected), readiness: 'candidate' }]);
    expect(openDir).not.toHaveBeenCalled();
    expect(readDir).not.toHaveBeenCalled();
  });

  it('refuses an exhausted entry budget and closes its finite synthetic directory stream', async () => {
    let yielded = 0;
    let closed = false;
    const directory = {
      async *[Symbol.asyncIterator]() {
        try {
          // Finite synthetic entries, without creating files or loading the host.
          for (let i = 0; i < 100_002; i++) { yielded++; yield entry(`note-${i}.md`); }
        } finally { closed = true; }
      },
    } as unknown as Dir;
    vi.spyOn(fs, 'opendir').mockResolvedValue(directory);
    await expect(discoverPlanQueueDocuments(root, 'plans')).rejects.toThrow(/incomplete.*100,000/i);
    expect(yielded).toBe(100_001);
    expect(closed).toBe(true);
  });

  it('refuses excessive depth and closes all ancestor directory streams', async () => {
    let opened = 0;
    let closed = 0;
    vi.spyOn(fs, 'opendir').mockImplementation(async () => {
      opened++;
      return {
        async *[Symbol.asyncIterator]() {
          try { yield entry('child', true); } finally { closed++; }
        },
      } as unknown as Dir;
    });
    await expect(discoverPlanQueueDocuments(root, 'plans')).rejects.toThrow(/incomplete.*depth/i);
    expect(opened).toBe(64); // docs/ is already the first level of the 64-level budget.
    expect(closed).toBe(opened);
  });

  it('does not hide a directory-read failure as an empty successful discovery', async () => {
    vi.spyOn(fs, 'opendir').mockRejectedValue(Object.assign(new Error('directory unreadable'), { code: 'EACCES' }));
    await expect(discoverPlanQueueDocuments(root, 'plans')).rejects.toThrow('directory unreadable');
  });

  it.each(['.planqueueignore', selected])('does not hide an unreadable %s', async (relative) => {
    vi.spyOn(fs, 'open').mockImplementation((...args) => {
      if (args[0] === join(root, relative)) return Promise.reject(Object.assign(new Error('input unreadable'), { code: 'EACCES' }));
      return originalOpen(...args);
    });
    await expect(discoverPlanQueueDocuments(root, 'plans', selected)).rejects.toThrow('input unreadable');
  });

  it('reads only the first 16 KiB and eight lines of a selected document, like the commit hook', async () => {
    // A standing-register marker beyond either boundary must not change readiness.
    for (const prefix of ['x'.repeat(16 * 1024) + '\n', '\n'.repeat(8)]) {
      writeFileSync(join(root, selected), `${prefix}Type: standing register\n`);
      expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([{ path: join(root, selected), readiness: 'candidate' }]);
    }
    // On the eighth line it still counts.
    writeFileSync(join(root, selected), `${'\n'.repeat(7)}Type: standing register\n`);
    expect(await discoverPlanQueueDocuments(root, 'plans', selected)).toEqual([]);
  });

  it('rejects an oversized ignore file explicitly', async () => {
    writeFileSync(join(root, '.planqueueignore'), 'x'.repeat(1024 * 1024 + 1));
    await expect(discoverPlanQueueDocuments(root, 'plans', selected)).rejects.toThrow(/incomplete.*planqueueignore/i);
  });

  it('requires a linked spec to be a regular file within the repository', async () => {
    writeFileSync(join(root, selected), '**Spec:** [spec](folder_spec.md)\n');
    mkdirSync(join(root, 'docs/plans/folder_spec.md'));
    expect((await discoverPlanQueueDocuments(root, 'plans', selected))[0].readiness).toBe('not-ready');
    // The outside target exists, but cannot make this plan ready.
    symlinkSync('/etc/hosts', join(root, 'docs/plans/external_spec.md'));
    writeFileSync(join(root, selected), '**Spec:** [spec](external_spec.md)\n');
    expect((await discoverPlanQueueDocuments(root, 'plans', selected))[0].readiness).toBe('not-ready');
    writeFileSync(join(root, 'docs/plans/real_spec.md'), '# Spec\n');
    symlinkSync(join(root, 'docs/plans/real_spec.md'), join(root, 'docs/plans/internal_spec.md'));
    writeFileSync(join(root, selected), '**Spec:** [spec](internal_spec.md)\n');
    expect((await discoverPlanQueueDocuments(root, 'plans', selected))[0].readiness).toBe('candidate');
  });
});
