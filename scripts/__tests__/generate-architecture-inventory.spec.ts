import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { toPosixPath, buildInventory, assertDeterministicPaths, readIndexedFileContents } = require(
  '../generate-architecture-inventory.js',
) as {
  toPosixPath: (filePath: string) => string;
  readIndexedFileContents: (files: string[]) => Map<string, string>;
  buildInventory: () => {
    providers: { files: string[] };
    largeFiles: { path: string; lines: number }[];
    packages: { dependencyGraph: { path: string }[] };
  };
  assertDeterministicPaths: (inventory: {
    providers: { files: string[] };
    largeFiles: { path: string }[];
    packages: { dependencyGraph: { path: string }[] };
  }) => void;
};

describe('generate-architecture-inventory', () => {
  describe('toPosixPath', () => {
    it('converts Windows backslash separators to forward slashes', () => {
      expect(toPosixPath('src\\main\\providers\\claude-cli-provider.ts')).toBe(
        'src/main/providers/claude-cli-provider.ts',
      );
    });

    it('leaves POSIX paths unchanged', () => {
      expect(toPosixPath('src/main/providers/claude-cli-provider.ts')).toBe(
        'src/main/providers/claude-cli-provider.ts',
      );
    });
  });

  describe('assertDeterministicPaths', () => {
    it('throws when a path field carries a backslash separator', () => {
      expect(() =>
        assertDeterministicPaths({
          providers: { files: ['src\\main\\providers\\claude-cli-provider.ts'] },
          largeFiles: [],
          packages: { dependencyGraph: [] },
        }),
      ).toThrow(/non-POSIX path separators/);
    });

    it('passes when every path field uses POSIX separators', () => {
      expect(() =>
        assertDeterministicPaths({
          providers: { files: ['src/main/providers/claude-cli-provider.ts'] },
          largeFiles: [{ path: 'docs/generated/foo.md' }],
          packages: { dependencyGraph: [{ path: 'packages/contracts' }] },
        }),
      ).not.toThrow();
    });
  });

  describe('readIndexedFileContents', () => {
    const ROOT = resolve(__dirname, '../..');

    it('returns committed content, not the working tree, for a modified tracked file', () => {
      // A tracked file the working tree is free to diverge from. Picking one
      // that is actually dirty is not reliable in CI (clean checkout), so
      // compare against git directly instead of against a hardcoded value.
      const relativePath = 'package.json';
      const absolutePath = resolve(ROOT, relativePath);

      const fromIndex = readIndexedFileContents([absolutePath]).get(absolutePath);
      const gitIndexContent = execFileSync('git', ['show', `:${relativePath}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });

      expect(fromIndex).toBe(gitIndexContent);
    });

    it('reads every file in a batch at its correct offset', () => {
      // The single `git cat-file --batch` call walks one response after another
      // by byte offset, so an off-by-one in the header/content framing would
      // silently shift every file after the first. Three files with different
      // sizes catch that; one file would not.
      const relativePaths = [
        'package.json',
        'scripts/generate-architecture-inventory.js',
        'scripts/ipc-channel-utils.js',
      ];
      const absolutePaths = relativePaths.map((file) => resolve(ROOT, file));
      const contents = readIndexedFileContents(absolutePaths);

      for (const [index, absolutePath] of absolutePaths.entries()) {
        const expected = execFileSync('git', ['show', `:${relativePaths[index]}`], {
          cwd: ROOT,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        });
        expect(contents.get(absolutePath)).toBe(expected);
      }
    });

    it('ignores an uncommitted working-tree edit to a tracked file', () => {
      // The bug this guards: `--write` ran at pre-commit against the working
      // tree, so a tracked-but-unstaged edit baked a line count into the
      // committed inventory that no clean checkout could reproduce — `--check`
      // then passed locally and failed in CI on the identical commit.
      //
      // Asserting against whatever happens to be dirty right now would make
      // this vacuous in CI, which is a clean checkout and therefore exactly
      // where a regression must still be caught. So drive the index and the
      // working tree apart deterministically: build a scratch index (HEAD with
      // one blob swapped) in a temp dir and point git at it via GIT_INDEX_FILE.
      // Nothing on disk and neither the repo's real index nor HEAD is touched.
      const relativePath = 'package.json';
      const absolutePath = resolve(ROOT, relativePath);
      const onDisk = readFileSync(absolutePath, 'utf8');
      const indexOnly = `${onDisk}\n(index-only sentinel, never written to disk)\n`;

      const scratchDir = mkdtempSync(join(tmpdir(), 'aio-inventory-index-'));
      const indexFile = join(scratchDir, 'index');
      const gitEnv = { ...process.env, GIT_INDEX_FILE: indexFile };
      execFileSync('git', ['read-tree', 'HEAD'], { cwd: ROOT, env: gitEnv });
      const blobOid = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: ROOT,
        input: indexOnly,
        encoding: 'utf8',
      }).trim();
      execFileSync(
        'git',
        ['update-index', '--cacheinfo', `100644,${blobOid},${relativePath}`],
        { cwd: ROOT, env: gitEnv },
      );

      const previousIndexFile = process.env['GIT_INDEX_FILE'];
      process.env['GIT_INDEX_FILE'] = indexFile;
      try {
        const fromIndex = readIndexedFileContents([absolutePath]).get(absolutePath);
        expect(fromIndex).toBe(indexOnly);
        expect(fromIndex).not.toBe(onDisk);
      } finally {
        if (previousIndexFile === undefined) delete process.env['GIT_INDEX_FILE'];
        else process.env['GIT_INDEX_FILE'] = previousIndexFile;
        rmSync(scratchDir, { recursive: true, force: true });
      }

      // The working-tree file is untouched by all of the above.
      expect(readFileSync(absolutePath, 'utf8')).toBe(onDisk);
    });
  });

  describe('buildInventory', () => {
    it('emits only POSIX separators for the real repository tree', () => {
      const inventory = buildInventory();
      const allPaths = [
        ...inventory.providers.files,
        ...inventory.largeFiles.map((entry) => entry.path),
        ...inventory.packages.dependencyGraph.map((pkg) => pkg.path),
      ];

      expect(allPaths.length).toBeGreaterThan(0);
      for (const value of allPaths) {
        expect(value).not.toContain('\\');
      }
    });
  });
});
