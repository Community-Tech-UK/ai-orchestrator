import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

interface StagedFilesOptions {
  execFileSync?: (command: string, args: string[], opts?: unknown) => string;
  existsSync?: (file: string) => boolean;
  generatedArtifacts?: string[];
}

interface RunOptions extends StagedFilesOptions {
  files?: string[];
  log?: (message: string) => void;
  spawnSync?: (
    command: string,
    args: string[],
    opts?: unknown,
  ) => { status?: number | null; signal?: NodeJS.Signals | null; error?: Error };
}

const { batchFilesByLength, getStagedTestRelatedFiles, runStagedTests } = require('../test-staged.js') as {
  batchFilesByLength: (files: string[], maxChars?: number) => string[][];
  getStagedTestRelatedFiles: (options?: StagedFilesOptions) => string[];
  runStagedTests: (options?: RunOptions) => number;
};

const GENERATED_ARTIFACTS = [
  'src/main/register-aliases.ts',
  'src/preload/generated/channels.ts',
  'docs/generated/architecture-inventory.json',
];

describe('test-staged: getStagedTestRelatedFiles', () => {
  it('keeps existing staged source files and drops non-source, generated, and deleted files', () => {
    const staged = [
      'src/main/foo.ts',
      'src/renderer/bar.component.ts',
      'README.md', // non-source
      'docs/notes.txt', // non-source
      'src/main/register-aliases.ts', // generated artifact (excluded)
      'src/main/deleted.ts', // staged delete (no longer on disk)
      '', // blank line
    ];

    const files = getStagedTestRelatedFiles({
      execFileSync: () => staged.join('\n'),
      existsSync: (file) => file !== 'src/main/deleted.ts',
      generatedArtifacts: GENERATED_ARTIFACTS,
    });

    expect(files).toEqual(['src/main/foo.ts', 'src/renderer/bar.component.ts']);
  });

  it('returns an empty list when nothing relevant is staged', () => {
    const files = getStagedTestRelatedFiles({
      execFileSync: () => 'README.md\npackage-lock.json\n',
      existsSync: () => true,
    });

    expect(files).toEqual([]);
  });
});

describe('test-staged: batchFilesByLength', () => {
  it('keeps a small file set in a single batch', () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts'];
    expect(batchFilesByLength(files)).toEqual([files]);
  });

  it('splits into multiple batches once the combined length exceeds the limit', () => {
    const files = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    // Each entry costs its length + 1; force a split after ~2 entries.
    const batches = batchFilesByLength(files, 30);

    expect(batches.length).toBeGreaterThan(1);
    // Every file is preserved exactly once, in order.
    expect(batches.flat()).toEqual(files);
    // No batch exceeds the char budget.
    for (const batch of batches) {
      const chars = batch.reduce((sum, file) => sum + file.length + 1, 0);
      expect(chars).toBeLessThanOrEqual(30);
    }
  });

  it('never drops a single file that alone exceeds the limit', () => {
    const files = ['a'.repeat(50) + '.ts', 'short.ts'];
    const batches = batchFilesByLength(files, 10);

    expect(batches.flat()).toEqual(files);
  });

  it('returns no batches for an empty file list', () => {
    expect(batchFilesByLength([])).toEqual([]);
  });
});

describe('test-staged: runStagedTests', () => {
  it('skips vitest entirely when no source files are staged', () => {
    const spawnSync = vi.fn();
    const status = runStagedTests({ files: [], spawnSync, log: () => {} });

    expect(status).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('runs vitest related against the staged files and returns its exit status', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const status = runStagedTests({
      files: ['src/main/foo.ts', 'src/main/bar.ts'],
      log: () => {},
      spawnSync: (command, args) => {
        calls.push({ command, args });
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        command: 'npx',
        args: ['vitest', 'related', '--run', '--passWithNoTests', 'src/main/foo.ts', 'src/main/bar.ts'],
      },
    ]);
  });

  it('splits a large staged set across multiple vitest invocations covering every file', () => {
    // Enough long paths to overflow the internal ~6000-char command-line budget.
    const files = Array.from(
      { length: 400 },
      (_, i) => `src/renderer/app/features/some/really/long/path/component-${i}.spec.ts`,
    );
    const calls: string[][] = [];
    const status = runStagedTests({
      files,
      log: () => undefined,
      spawnSync: (_command, args) => {
        // Drop the fixed prefix, keep only the file arguments.
        calls.push(args.slice(4));
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.flat()).toEqual(files);
  });

  it('stops at the first failing batch and returns its status', () => {
    const files = Array.from(
      { length: 400 },
      (_, i) => `src/renderer/app/features/some/really/long/path/component-${i}.spec.ts`,
    );
    let invocations = 0;
    const status = runStagedTests({
      files,
      log: () => undefined,
      spawnSync: () => {
        invocations += 1;
        return { status: 2 };
      },
    });

    expect(status).toBe(2);
    // Short-circuits after the first failing batch instead of running them all.
    expect(invocations).toBe(1);
  });

  it('propagates a non-zero vitest exit status', () => {
    const status = runStagedTests({
      files: ['src/main/foo.ts'],
      log: () => {},
      spawnSync: () => ({ status: 1 }),
    });

    expect(status).toBe(1);
  });

  it('reports a failure when vitest cannot be spawned', () => {
    const status = runStagedTests({
      files: ['src/main/foo.ts'],
      log: () => {},
      spawnSync: () => ({ error: new Error('spawn failed') }),
    });

    expect(status).toBe(1);
  });
});
