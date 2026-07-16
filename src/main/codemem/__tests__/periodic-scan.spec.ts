import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CasStore } from '../cas-store';
import { migrate } from '../cas-schema';
import { CodeIndexManager } from '../code-index-manager';
import { PeriodicScan } from '../periodic-scan';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';

describe('PeriodicScan', () => {
  let db: SqliteDriver;
  let store: CasStore;
  let mgr: CodeIndexManager;
  let workDir: string;

  beforeEach(async () => {
    db = defaultDriverFactory(':memory:');
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
    const outcome = await scan.runOnce(result.workspaceHash);

    const rootAfter = store.getWorkspaceRoot(result.workspaceHash)?.merkleRootHash;
    expect(rootAfter).toBe(rootBefore);
    expect(outcome).toEqual({ scanned: 1, mismatched: 0, reindexed: false, escalated: false });
  });

  it('repairs mismatches even when the rate stays below the threshold', async () => {
    await writeFile(join(workDir, 'src/b.ts'), 'export const y = 1;\n');
    const result = await mgr.coldIndex(workDir);

    await writeFile(join(workDir, 'src/a.ts'), 'export const renamedOffline = 2;\n');

    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 0.9 });
    const outcome = await scan.runOnce(result.workspaceHash);

    expect(outcome.reindexed).toBe(true);
    expect(outcome.escalated).toBe(false);
    const symbols = store
      .listWorkspaceSymbols(result.workspaceHash)
      .map((symbol) => symbol.name);
    expect(symbols).toContain('renamedOffline');
  });

  it('rotates the sample window across runs instead of re-reading the same files', async () => {
    await writeFile(join(workDir, 'src/b.ts'), 'export const y = 1;\n');
    const result = await mgr.coldIndex(workDir);

    await writeFile(join(workDir, 'src/a.ts'), 'export const editedFirst = 2;\n');
    await writeFile(join(workDir, 'src/b.ts'), 'export const editedSecond = 2;\n');

    // Threshold 1 disables escalation so only the sampled file is repaired.
    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 1, sampleSize: 1 });
    const first = await scan.runOnce(result.workspaceHash);
    const second = await scan.runOnce(result.workspaceHash);

    expect(first).toEqual(expect.objectContaining({ scanned: 1, mismatched: 1, escalated: false }));
    expect(second).toEqual(expect.objectContaining({ scanned: 1, mismatched: 1, escalated: false }));
    const symbols = store
      .listWorkspaceSymbols(result.workspaceHash)
      .map((symbol) => symbol.name);
    expect(symbols).toContain('editedFirst');
    expect(symbols).toContain('editedSecond');
  });

  it('escalates high drift to a full reconcile that catches unsampled files', async () => {
    const result = await mgr.coldIndex(workDir);

    await writeFile(join(workDir, 'src/a.ts'), 'export const editedOffline = 2;\n');
    // New files never appear in the manifest sample; only reconcile finds them.
    await writeFile(join(workDir, 'src/created-offline.ts'), 'export const z = 3;\n');

    const scan = new PeriodicScan({ store, mgr, mismatchThreshold: 0.5 });
    const outcome = await scan.runOnce(result.workspaceHash);

    expect(outcome.escalated).toBe(true);
    const paths = store
      .listManifestEntries(result.workspaceHash)
      .map((entry) => entry.pathFromRoot);
    expect(paths).toContain('src/created-offline.ts');
  });
});
