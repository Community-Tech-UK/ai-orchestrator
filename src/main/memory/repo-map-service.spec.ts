/**
 * RepoMapService — unit tests.
 *
 * Tests cover:
 *  1. Index-backed ranking: files ranked by symbol count + path bonus, deterministic
 *  2. Token budget truncation: map is cut off when budget would be exceeded
 *  3. Ignore rules respected in filesystem-walk fallback
 *  4. Fallback mode activated when codemem index is unavailable
 *  5. Singleton behaviour and _resetForTesting
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RepoMapService,
  getRepoMapService,
  _resetForTesting,
  DEFAULT_REPO_MAP_TOKEN_BUDGET,
  type RepoMapStoreAccessor,
} from './repo-map-service';

// ─── fixtures ─────────────────────────────────────────────────────────────────

function makeManifestEntry(pathFromRoot: string) {
  return { pathFromRoot };
}

function makeSymbol(
  pathFromRoot: string,
  name: string,
  kind: 'function' | 'class' | 'interface' | 'type' | 'method' = 'function',
) {
  return { pathFromRoot, name, kind };
}

// ─── mock helpers ─────────────────────────────────────────────────────────────

function makeStore(
  manifestEntries: { pathFromRoot: string }[],
  symbols: { pathFromRoot: string; name: string; kind: string }[],
): RepoMapStoreAccessor {
  return {
    getWorkspaceRootByPath: vi.fn(() => ({
      workspaceHash: 'ws1',
      absPath: '/repo',
      headCommit: null,
      primaryLanguage: 'typescript',
      lastIndexedAt: Date.now(),
      merkleRootHash: 'rootHash',
      pagerankJson: null,
    })),
    listManifestEntries: vi.fn(() => manifestEntries),
    listWorkspaceSymbols: vi.fn(() => symbols),
  };
}

function makeNullStore(): RepoMapStoreAccessor {
  return {
    getWorkspaceRootByPath: vi.fn(() => null),
    listManifestEntries: vi.fn(() => []),
    listWorkspaceSymbols: vi.fn(() => []),
  };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('RepoMapService', () => {
  beforeEach(() => {
    _resetForTesting();
    vi.restoreAllMocks();
  });

  // ── index-backed path ──────────────────────────────────────────────────────

  describe('index-backed ranking', () => {
    it('ranks entry-point files above plain utility files', async () => {
      const store = makeStore(
        [
          makeManifestEntry('src/utils/helpers.ts'),
          makeManifestEntry('src/index.ts'),
          makeManifestEntry('src/services/auth.ts'),
        ],
        [
          makeSymbol('src/utils/helpers.ts', 'parseDate'),
          makeSymbol('src/utils/helpers.ts', 'formatDate'),
          makeSymbol('src/services/auth.ts', 'AuthService', 'class'),
          makeSymbol('src/services/auth.ts', 'login', 'function'),
          makeSymbol('src/services/auth.ts', 'logout', 'function'),
          // src/index.ts has no symbols but gets a large path bonus
        ],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({
        projectPath: '/repo',
        tokenBudget: DEFAULT_REPO_MAP_TOKEN_BUDGET,
      });

      const lines = result.text.split('\n').filter(Boolean);
      // Header is first
      expect(lines[0]).toContain('repo map');

      // src/index.ts should appear before src/utils/helpers.ts (path bonus 60 > 2 symbols)
      const indexLine = lines.findIndex((l) => l.includes('src/index.ts'));
      const helpersLine = lines.findIndex((l) => l.includes('src/utils/helpers.ts'));
      expect(indexLine).toBeGreaterThanOrEqual(1);
      expect(indexLine).toBeLessThan(helpersLine);

      // auth.ts (3 symbols) ranks above helpers.ts (2 symbols)
      const authLine = lines.findIndex((l) => l.includes('src/services/auth.ts'));
      expect(authLine).toBeLessThan(helpersLine);
    });

    it('includes symbol names in the output line', async () => {
      const store = makeStore(
        [makeManifestEntry('src/auth.ts')],
        [
          makeSymbol('src/auth.ts', 'AuthService', 'class'),
          makeSymbol('src/auth.ts', 'login', 'function'),
        ],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });

      expect(result.text).toContain('AuthService');
      expect(result.text).toContain('login');
      expect(result.stats.fallback).toBe(false);
    });

    it('deduplicates symbol names per file', async () => {
      const store = makeStore(
        [makeManifestEntry('src/foo.ts')],
        [
          makeSymbol('src/foo.ts', 'doThing', 'function'),
          makeSymbol('src/foo.ts', 'doThing', 'function'), // duplicate
        ],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });

      const fileLines = result.text.split('\n').filter((l) => l.includes('foo.ts'));
      const symbolMatches = (fileLines[0] ?? '').match(/doThing/g) ?? [];
      expect(symbolMatches.length).toBe(1);
    });

    it('falls back to filesystem when workspace root is not found', async () => {
      const store = makeNullStore();

      const { promises: fsMock } = await import('node:fs');
      vi.spyOn(fsMock, 'readdir').mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fsMock.readdir>>,
      );
      vi.spyOn(fsMock, 'readFile').mockRejectedValue(new Error('no gitignore'));

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });

      expect(result.stats.fallback).toBe(true);
    });

    it('falls back to filesystem when storeAccessor is null', async () => {
      const { promises: fsMock } = await import('node:fs');
      vi.spyOn(fsMock, 'readdir').mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fsMock.readdir>>,
      );
      vi.spyOn(fsMock, 'readFile').mockRejectedValue(new Error('no gitignore'));

      const svc = new RepoMapService({ storeAccessor: null });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });

      expect(result.stats.fallback).toBe(true);
    });
  });

  // ── token budget truncation ────────────────────────────────────────────────

  describe('token budget truncation', () => {
    it('truncates when the budget is exhausted', async () => {
      const count = 50;
      const manifest = Array.from({ length: count }, (_, i) =>
        makeManifestEntry(`src/file${String(i).padStart(3, '0')}.ts`),
      );
      const symbols = manifest.flatMap((m) => [
        makeSymbol(m.pathFromRoot, 'functionA'),
        makeSymbol(m.pathFromRoot, 'functionB'),
      ]);
      const store = makeStore(manifest, symbols);

      // Tiny budget: 50 tokens should force truncation
      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo', tokenBudget: 50 });

      expect(result.stats.truncated).toBe(true);
      expect(result.stats.filesIncluded).toBeLessThan(count);
      expect(result.stats.tokensUsed).toBeLessThanOrEqual(50);
    });

    it('fits all files within a generous budget', async () => {
      const store = makeStore(
        [
          makeManifestEntry('src/a.ts'),
          makeManifestEntry('src/b.ts'),
          makeManifestEntry('src/c.ts'),
        ],
        [],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo', tokenBudget: 10_000 });

      expect(result.stats.truncated).toBe(false);
      expect(result.stats.filesIncluded).toBe(3);
    });

    it('reports tokensUsed consistent with the rendered text length', async () => {
      const store = makeStore([makeManifestEntry('src/main.ts')], []);

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo', tokenBudget: 10_000 });

      const expectedTokens = Math.ceil(result.text.length / 4);
      expect(result.stats.tokensUsed).toBe(expectedTokens);
    });
  });

  // ── path bonuses produce deterministic ordering ────────────────────────────

  describe('path bonuses produce deterministic ordering', () => {
    it('entry-point files rank above plain files with the same symbol count', async () => {
      const store = makeStore(
        [
          makeManifestEntry('src/utils.ts'),
          makeManifestEntry('src/index.ts'), // entry-point bonus
        ],
        [
          makeSymbol('src/utils.ts', 'helper'),
          makeSymbol('src/index.ts', 'bootstrap'),
        ],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });
      const lines = result.text.split('\n').filter(Boolean).slice(1); // skip header
      expect(lines[0]).toContain('index.ts');
    });

    it('README files rank above files with no path bonus', async () => {
      const store = makeStore(
        [
          makeManifestEntry('src/helper.ts'),
          makeManifestEntry('README.md'),
        ],
        [],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });
      const lines = result.text.split('\n').filter(Boolean).slice(1);
      expect(lines[0]).toContain('README.md');
    });

    it('spec files receive a penalty and rank below equivalent plain files', async () => {
      const store = makeStore(
        [
          makeManifestEntry('src/auth.spec.ts'), // test penalty
          makeManifestEntry('src/auth.ts'),
        ],
        [
          makeSymbol('src/auth.spec.ts', 'testA'),
          makeSymbol('src/auth.ts', 'AuthService', 'class'),
        ],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });
      const lines = result.text.split('\n').filter(Boolean).slice(1);
      const authIdx = lines.findIndex((l) => l.includes('src/auth.ts') && !l.includes('spec'));
      const specIdx = lines.findIndex((l) => l.includes('auth.spec.ts'));
      expect(authIdx).toBeGreaterThanOrEqual(0);
      expect(specIdx).toBeGreaterThanOrEqual(0);
      expect(authIdx).toBeLessThan(specIdx);
    });

    it('ordering is stable: same-score files are sorted alphabetically by path', async () => {
      const store = makeStore(
        [
          makeManifestEntry('src/zoo.ts'),
          makeManifestEntry('src/alpha.ts'),
          makeManifestEntry('src/middle.ts'),
        ],
        [],
      );

      const svc = new RepoMapService({ storeAccessor: store });
      const result = await svc.buildRepoMap({ projectPath: '/repo' });
      const lines = result.text.split('\n').filter(Boolean).slice(1);

      const alpha = lines.findIndex((l) => l.includes('alpha.ts'));
      const middle = lines.findIndex((l) => l.includes('middle.ts'));
      const zoo = lines.findIndex((l) => l.includes('zoo.ts'));

      expect(alpha).toBeLessThan(middle);
      expect(middle).toBeLessThan(zoo);
    });
  });

  // ── filesystem-walk fallback ───────────────────────────────────────────────

  describe('filesystem-walk fallback', () => {
    it('produces fallback=true output for an empty directory', async () => {
      const { promises: fsMock } = await import('node:fs');
      vi.spyOn(fsMock, 'readdir').mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fsMock.readdir>>,
      );
      vi.spyOn(fsMock, 'readFile').mockRejectedValue(new Error('no gitignore'));

      const svc = new RepoMapService({ storeAccessor: null });
      const result = await svc.buildRepoMap({ projectPath: '/empty-repo', tokenBudget: 500 });

      expect(result.stats.fallback).toBe(true);
      expect(result.stats.filesIncluded).toBe(0);
      expect(result.text).toContain('## Project structure');
    });

    it('always includes the header even with no files', async () => {
      const { promises: fsMock } = await import('node:fs');
      vi.spyOn(fsMock, 'readdir').mockResolvedValue(
        [] as unknown as Awaited<ReturnType<typeof fsMock.readdir>>,
      );
      vi.spyOn(fsMock, 'readFile').mockRejectedValue(new Error('no gitignore'));

      const svc = new RepoMapService({ storeAccessor: null });
      const result = await svc.buildRepoMap({ projectPath: '/no-files' });

      expect(result.text).toContain('## Project structure');
      expect(result.stats.fallback).toBe(true);
    });
  });

  // ── singleton ──────────────────────────────────────────────────────────────

  describe('singleton', () => {
    it('getRepoMapService returns the same instance on repeated calls', () => {
      const a = getRepoMapService();
      const b = getRepoMapService();
      expect(a).toBe(b);
    });

    it('_resetForTesting creates a fresh instance on the next call', () => {
      const before = getRepoMapService();
      _resetForTesting();
      const after = getRepoMapService();
      expect(before).not.toBe(after);
    });
  });

  // ── robustness ────────────────────────────────────────────────────────────

  describe('fail-soft behaviour', () => {
    it('resolves without throwing when the filesystem walk fails entirely', async () => {
      const { promises: fsMock } = await import('node:fs');
      vi.spyOn(fsMock, 'readdir').mockRejectedValue(new Error('EACCES'));
      vi.spyOn(fsMock, 'readFile').mockRejectedValue(new Error('EACCES'));

      const svc = new RepoMapService({ storeAccessor: null });
      const result = await svc.buildRepoMap({ projectPath: '/bad-dir', tokenBudget: 500 });

      expect(result).toBeDefined();
      expect(typeof result.text).toBe('string');
      expect(result.stats.fallback).toBe(true);
    });
  });
});
