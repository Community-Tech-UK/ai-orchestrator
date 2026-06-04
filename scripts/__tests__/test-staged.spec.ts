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

const { getStagedTestRelatedFiles, runStagedTests } = require('../test-staged.js') as {
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
