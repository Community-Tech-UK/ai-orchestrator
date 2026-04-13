import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasStore } from '../cas-store';
import { migrate } from '../cas-schema';
import { CodeIndexManager } from '../code-index-manager';
import { PeriodicScan } from '../periodic-scan';

describe('PeriodicScan', () => {
  let db: Database.Database;
  let store: CasStore;
  let mgr: CodeIndexManager;
  let workDir: string;

  beforeEach(async () => {
    db = new Database(':memory:');
    migrate(db);
    store = new CasStore(db);
    mgr = new CodeIndexManager({ store });
    workDir = join(tmpdir(), `codemem-scan-${Date.now()}-${Math.random()}`);
    await mkdir(join(workDir, 'src'), { recursive: true });
    await writeFile(join(workDir, 'src/a.ts'), 'export const x = 1;\n');
  });

  afterEach(async () => {
    await mgr.stop();
    await rm(workDir, { recursive: true, force: true });
    db.close();
  });

  it('detects out-of-band edits and triggers re-index when mismatch rate exceeds threshold', async () => {
    const result = await mgr.coldIndex(workDir);
    const rootBefore = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;

    await writeFile(join(workDir, 'src/a.ts'), 'export const x = 2;\n');

    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 0.0 });
    await scan.runOnce(result.workspaceHash);

    const rootAfter = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;
    expect(rootAfter).not.toBe(rootBefore);
  });

  it('does nothing when manifest matches disk', async () => {
    const result = await mgr.coldIndex(workDir);
    const rootBefore = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;

    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 0.05 });
    await scan.runOnce(result.workspaceHash);

    const rootAfter = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;
    expect(rootAfter).toBe(rootBefore);
  });
});
