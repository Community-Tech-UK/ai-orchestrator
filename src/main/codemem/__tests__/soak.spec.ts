import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';
import { CodeRetrievalService } from '../code-retrieval-service';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { searchAcrossSources, writeRetrievalWorkspace } from './code-retrieval-workspace.test-helpers';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('codemem soak', () => {
  let workDir: string;
  let db: SqliteDriver;
  let store: CasStore;
  let mgr: CodeIndexManager;

  beforeEach(async () => {
    workDir = join(tmpdir(), `codemem-soak-${Date.now()}-${Math.random()}`);
    await mkdir(join(workDir, 'src'), { recursive: true });

    db = defaultDriverFactory(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store, debounceMs: 10 });

    await writeFile(join(workDir, 'src/seed.ts'), 'export const x = 0;\n');
  });

  afterEach(async () => {
    await mgr.stop();
    await rm(workDir, { recursive: true, force: true });
    db.close();
  });

  it('handles 200 rapid edits and indexes the final file state', async () => {
    const result = await mgr.coldIndex(workDir);
    await mgr.start(workDir, result.workspaceHash);
    const finalSource = 'export const x = 200;\n';

    for (let i = 1; i <= 200; i += 1) {
      await writeFile(join(workDir, 'src/seed.ts'), `export const x = ${i};\n`);
      if (i % 25 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    const seedEntry = store
      .listManifestEntries(result.workspaceHash)
      .find((entry) => entry.pathFromRoot === 'src/seed.ts');

    expect(seedEntry).toBeDefined();
    expect(seedEntry?.contentHash).toBe(sha256(finalSource));
    expect(store.searchWorkspaceChunks(result.workspaceHash, '200', 5)[0]).toEqual(
      expect.objectContaining({ pathFromRoot: 'src/seed.ts' }),
    );
    expect(store.searchWorkspaceChunks(result.workspaceHash, '199', 5)).toHaveLength(0);
  }, 30_000);
});

// The search ceiling for `code-retrieval-load.spec.ts`'s workspace, at full size. A real-clock limit belongs
// here, in the slow tier that CI runs on its own machine, not in the default suite on a busy Mac.
describe('codemem search speed', () => {
  let workDir: string;
  let db: SqliteDriver;
  let store: CasStore;
  let mgr: CodeIndexManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `codemem-search-speed-${Date.now()}-${Math.random()}`);
    db = defaultDriverFactory(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store });
  });

  afterEach(async () => {
    await mgr.stop();
    db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('keeps every search under 500 ms with 3,000 generated files beside 500 source files', async () => {
    await writeRetrievalWorkspace(workDir, 1_000);
    const result = await mgr.coldIndex(workDir);
    expect(store.searchWorkspaceChunks(result.workspaceHash, 'generated dependency', 10)).toHaveLength(0);

    const slowestMs = await searchAcrossSources(new CodeRetrievalService({ store }), workDir);

    expect(slowestMs).toBeLessThan(500);
  }, 60_000);
});
