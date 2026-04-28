import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactRegistryRecord } from '../../shared/types/artifact-cleanup.types';
import { ArtifactCleanupService } from './artifact-cleanup-service';
import type { ArtifactAttributionStore } from './artifact-attribution-store';

vi.mock('../plugins/hook-emitter', () => ({
  emitPluginHook: vi.fn(),
}));

describe('ArtifactCleanupService', () => {
  let tempDir: string;
  let removedIds: string[];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-cleanup-'));
    removedIds = [];
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function makeStore(records: ArtifactRegistryRecord[]): ArtifactAttributionStore {
    return {
      listCleanupCandidates: vi.fn(() => records),
      delete: vi.fn((id: string) => {
        removedIds.push(id);
      }),
    } as unknown as ArtifactAttributionStore;
  }

  function makeRecord(id: string, artifactPath: string): ArtifactRegistryRecord {
    return {
      id,
      ownerType: 'automation_run',
      ownerId: 'run-1',
      kind: 'automation_output',
      path: artifactPath,
      protected: false,
      createdAt: 1,
      lastSeenAt: 1,
    };
  }

  it('blocks artifacts under protected roots by default', async () => {
    const service = new ArtifactCleanupService(makeStore([
      makeRecord('artifact-1', path.join(process.cwd(), 'generated-output.json')),
    ]));

    const result = await service.cleanup({ olderThan: 2, dryRun: false });

    expect(result.candidates[0]?.wouldRemove).toBe(false);
    expect(result.candidates[0]?.blockedReason).toBe('protected project/worktree path');
    expect(result.removed).toEqual([]);
    expect(removedIds).toEqual([]);
  });

  it('removes artifacts inside explicit allowed roots', async () => {
    const artifactPath = path.join(tempDir, 'run-output.json');
    await fs.writeFile(artifactPath, '{}', 'utf-8');
    const service = new ArtifactCleanupService(makeStore([
      makeRecord('artifact-2', artifactPath),
    ]));

    const result = await service.cleanup({
      olderThan: 2,
      dryRun: false,
      allowedRoots: [tempDir],
      protectedRoots: [],
    });

    await expect(fs.access(artifactPath)).rejects.toThrow();
    expect(result.removed).toEqual(['artifact-2']);
    expect(removedIds).toEqual(['artifact-2']);
  });

  it('blocks artifacts outside explicit allowed roots', async () => {
    const service = new ArtifactCleanupService(makeStore([
      makeRecord('artifact-3', path.join(tempDir, 'out-of-policy.json')),
    ]));

    const result = await service.cleanup({
      olderThan: 2,
      dryRun: false,
      allowedRoots: [path.join(tempDir, 'allowed')],
      protectedRoots: [],
    });

    expect(result.candidates[0]?.wouldRemove).toBe(false);
    expect(result.candidates[0]?.blockedReason).toBe('outside allowed cleanup roots');
    expect(result.removed).toEqual([]);
  });
});
