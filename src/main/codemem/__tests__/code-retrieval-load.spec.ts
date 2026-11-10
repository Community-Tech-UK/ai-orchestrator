import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../cas-schema';
import { CasStore } from '../cas-store';
import { CodeIndexManager } from '../code-index-manager';
import { CodeRetrievalService } from '../code-retrieval-service';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { searchAcrossSources, writeRetrievalWorkspace } from './code-retrieval-workspace.test-helpers';

// What gets indexed and what each search returns. How fast the searches are, over the same workspace with
// 1,000 generated files in each ignored folder, is checked by the slow tier (`soak.spec.ts`), where a
// real-clock ceiling is not at the mercy of whatever else a developer's machine is doing.
describe('CodeRetrievalService over a workspace with generated folders', () => {
  let workDir: string;
  let db: SqliteDriver;
  let store: CasStore;
  let manager: CodeIndexManager;

  beforeEach(() => {
    workDir = join(tmpdir(), `codemem-load-${Date.now()}-${Math.random()}`);
    db = defaultDriverFactory(':memory:');
    migrate(db);
    store = new CasStore(db);
    manager = new CodeIndexManager({ store });
  });

  afterEach(async () => {
    await manager.stop();
    db.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('leaves generated folders out of the index and ranks each source file first for its own words', async () => {
    // Ignoring is decided per path, so ten files in each generated folder prove it as well as a thousand.
    await writeRetrievalWorkspace(workDir, 10);

    const indexResult = await manager.coldIndex(workDir);

    expect(store.searchWorkspaceChunks(indexResult.workspaceHash, 'generated dependency', 10)).toHaveLength(0);
    expect(store.searchWorkspaceChunks(indexResult.workspaceHash, 'unique source token 0042', 10)[0]).toEqual(
      expect.objectContaining({ pathFromRoot: 'src/file-0042.ts' }),
    );
    await searchAcrossSources(new CodeRetrievalService({ store }), workDir);
  }, 60_000);
});
