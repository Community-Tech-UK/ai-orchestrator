import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactCleanupService } from './artifact-cleanup-service';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/harness-user-data'),
  },
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { runArtifactCleanupMaintenance } from './artifact-cleanup-maintenance';

describe('artifact cleanup maintenance', () => {
  let cleanup: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    cleanup = vi.fn().mockResolvedValue({
      dryRun: false,
      candidates: [],
      removed: [],
      errors: [],
    });
  });

  it('limits scheduled cleanup to stale artifacts under app userData', async () => {
    await runArtifactCleanupMaintenance({
      now: () => 2_000,
      retentionMs: 500,
      userDataPath: '/tmp/harness-user-data',
      service: { cleanup } as unknown as ArtifactCleanupService,
    });

    expect(cleanup).toHaveBeenCalledWith({
      olderThan: 1_500,
      dryRun: false,
      limit: 100,
      allowedRoots: ['/tmp/harness-user-data'],
      protectedRoots: [],
    });
  });
});
