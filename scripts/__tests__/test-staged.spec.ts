import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

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
  it('sends a large staged set in one run so overlapping related tests cannot run in separate batches', () => {
    const files = Array.from({ length: 400 }, (_, i) => `src/renderer/app/features/long/path/component-${i}.ts`);
    const calls: Array<{ command: string; args: string[]; opts: unknown }> = [];
    const status = runStagedTests({
      files,
      log: () => {},
      spawnSync: (command, args, opts) => {
        calls.push({ command, args, opts });
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].opts).toMatchObject({ input: JSON.stringify(files), shell: false });
    expect(calls[0].args.join(' ').length).toBeLessThan(6000);
  });

  it('validates a generated Codex snapshot through its contract suites without expanding every importer', () => {
    const inputs: string[][] = [];
    expect(runStagedTests({
      files: ['src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts', 'src/renderer/tooltip.ts'],
      log: () => {},
      spawnSync: (_command, _args, opts) => {
        inputs.push(JSON.parse((opts as { input: string }).input));
        return { status: 0 };
      },
    })).toBe(0);
    expect(inputs).toEqual([[
      'src/main/cli/adapters/codex/generated/app-server-protocol.gen.spec.ts',
      'src/main/cli/adapters/codex/app-server-client-protocol.spec.ts',
      'src/main/cli/adapters/codex/app-server-client.spec.ts',
      'src/main/cli/adapters/codex/codex-protocol-snapshot-check.spec.ts',
      'scripts/__tests__/refresh-codex-protocol.spec.ts',
      'src/renderer/tooltip.ts',
    ]]);
  });

  it('still discovers transitive tests when a real Codex consumer changes alongside the snapshot', () => {
    const inputs: string[][] = [];
    runStagedTests({
      files: ['src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts', 'src/main/cli/adapters/codex/app-server-client.ts'],
      log: () => {},
      spawnSync: (_command, _args, opts) => {
        inputs.push(JSON.parse((opts as { input: string }).input));
        return { status: 0 };
      },
    });
    expect(inputs[0]).toContain('src/main/cli/adapters/codex/app-server-client.ts');
    expect(inputs[0]).toContain('src/main/cli/adapters/codex/app-server-client-protocol.spec.ts');
    expect(inputs[0]).not.toContain('src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts');
  });

  it('fails closed if a required generated-protocol contract suite is missing', () => {
    const spawnSync = vi.fn();
    expect(runStagedTests({
      files: ['src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts'],
      existsSync: file => !file.endsWith('app-server-client.spec.ts'),
      log: () => {}, spawnSync,
    })).toBe(1);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('skips vitest entirely when no source files are staged', () => {
    const spawnSync = vi.fn();
    const status = runStagedTests({ files: [], spawnSync, log: () => {} });

    expect(status).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('runs related tests against the staged files and returns its exit status', () => {
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
        command: process.execPath,
        args: [path.resolve('scripts/run-related-tests.mjs')],
      },
    ]);
  });

  it('preserves every source path in stdin, including spaces and shell metacharacters', () => {
    const files = Array.from(
      { length: 400 },
      (_, i) => `src/renderer/app/features/some/really/long/path/component-${i}.spec.ts`,
    );
    files.push('src/a path/$(literal);file.ts');
    const payloads: string[][] = [];
    const status = runStagedTests({
      files,
      log: () => undefined,
      spawnSync: (_command, _args, opts) => {
        payloads.push(JSON.parse((opts as { input: string }).input));
        return { status: 0 };
      },
    });

    expect(status).toBe(0);
    expect(payloads).toEqual([files]);
  });

  it('returns a failure without retrying a large staged set', () => {
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
    // A failed test run must not be retried or hidden by a subsequent run.
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

  it('fails closed on a signalled or missing child exit status', () => {
    for (const result of [{ status: null, signal: 'SIGTERM' as const }, { status: null }]) {
      expect(runStagedTests({
        files: ['src/main/foo.ts'],
        log: () => {},
        spawnSync: () => result,
      })).toBe(1);
    }
  });
});
