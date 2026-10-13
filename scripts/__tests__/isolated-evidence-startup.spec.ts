import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initSqliteWasm, createSqliteWasmDatabase } from '../../src/main/db/sqlite-wasm-driver';
import { runIsolatedEvidenceStartup } from '../isolated-evidence-startup';

describe('isolated evidence startup and maintenance harness', () => {
  it('uses populated upgrade readiness and authentic encrypted capture, recovery, cleanup and restart', async () => {
    await initSqliteWasm();
    const directory = await mkdtemp(join(tmpdir(), 'isolated-evidence-harness-'));
    try {
      const result = await runIsolatedEvidenceStartup({ directory, rows: 20,
        driverFactory: createSqliteWasmDatabase });
      expect(result.mode).toBe('headless-cli-evidence-readiness-seam');
      expect(result.packagedWindowVerified).toBe(false);
      expect(result.fixture).toMatchObject({ evidenceRows: 20, cardRows: 20 });
      expect(result.readiness.map((launch) => launch.launch))
        .toEqual(['populated-v6-upgrade', 'migrated-1', 'migrated-2']);
      expect(result).toMatchObject({
        capturedAndReadDuringSweep: true, preparedRecovered: true,
        staleOrphanRemoved: true, recentOrphanSurvived: true,
        referencedSurvived: true, stopRestartVerified: true,
        cancelledSweepPreventedDeletion: true,
        deletionRevokedDuringSweep: true, deletionGraceProtected: true,
        deletion: { deleted: 1, failed: 0 },
      });
      expect(JSON.parse(await readFile(join(directory, 'startup-results.json'), 'utf8')))
        .toMatchObject({ profile: result.profile, packagedWindowVerified: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
