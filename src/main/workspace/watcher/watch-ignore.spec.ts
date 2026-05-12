import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { watch } from 'chokidar';
import { afterEach, describe, expect, it } from 'vitest';
import { buildWatchIgnoredMatchers, isPathPrunedByDefault } from './watch-ignore';

describe('watch-ignore', () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it('prunes heavy dependency and build directories by path segment', () => {
    const root = '/repo';

    expect(isPathPrunedByDefault(root, '/repo/node_modules/pkg/index.js')).toBe(true);
    expect(isPathPrunedByDefault(root, '/repo/node_modules')).toBe(true);
    expect(isPathPrunedByDefault(root, '/repo/.git/index')).toBe(true);
    expect(isPathPrunedByDefault(root, '/repo/dist/main.js')).toBe(true);
    expect(isPathPrunedByDefault(root, '/repo/release/mac-arm64/app')).toBe(true);
    expect(isPathPrunedByDefault(root, '/repo/benchmarks/external-benchmarks/swe-bench/workdir/file.py')).toBe(true);
    expect(isPathPrunedByDefault(root, '/repo/src/app.ts')).toBe(false);
  });

  it('includes caller patterns while retaining the pruning predicate', () => {
    const ignored = buildWatchIgnoredMatchers('/repo', ['**/.custom-cache/**']);

    expect(ignored).toContain('**/.custom-cache/**');
    expect(ignored.some((matcher) => typeof matcher === 'function')).toBe(true);
  });

  it('prevents chokidar from descending into ignored directories', async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), 'aio-watch-ignore-'));
    await mkdir(path.join(tempRoot, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(tempRoot, 'src'), { recursive: true });
    await writeFile(path.join(tempRoot, 'node_modules', 'pkg', 'index.js'), 'ignored');
    await writeFile(path.join(tempRoot, 'src', 'app.ts'), 'watched');

    const watcher = watch(tempRoot, {
      ignored: buildWatchIgnoredMatchers(tempRoot),
      ignoreInitial: true,
      depth: 99,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        watcher.once('ready', resolve);
        watcher.once('error', reject);
      });

      const watchedPaths = Object.entries(watcher.getWatched()).flatMap(([dir, entries]) =>
        entries.map((entry) => path.join(dir, entry)),
      );

      expect(watchedPaths.some((watchedPath) => watchedPath.includes('node_modules'))).toBe(false);
      expect(watchedPaths).toContain(path.join(tempRoot, 'src', 'app.ts'));
    } finally {
      await watcher.close();
    }
  });
});
