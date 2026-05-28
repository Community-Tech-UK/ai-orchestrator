import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toPosixPath, buildInventory, assertDeterministicPaths } = require(
  '../generate-architecture-inventory.js',
) as {
  toPosixPath: (filePath: string) => string;
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
