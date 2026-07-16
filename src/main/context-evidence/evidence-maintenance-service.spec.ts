import { describe, expect, it, vi } from 'vitest';
import type { EvidenceLedgerRecord } from '../conversation-ledger/context-evidence-ledger.types';
import { EvidenceStorageError } from './evidence-storage.types';
import {
  EVIDENCE_STAGING_STALE_MS,
  EvidenceMaintenanceService,
  type EvidenceMaintenanceBlobStore,
  type EvidenceMaintenanceLedger,
} from './evidence-maintenance-service';

describe('EvidenceMaintenanceService', () => {
  it('recovers authenticated prepared metadata after a restart', async () => {
    const prepared = record({
      status: 'staging',
      blobRef: 'opaque/prepared.aioev1',
      keyedContentId: 'a'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      updatedAt: 10,
    });
    const { service, ledger, blobStore } = harness([prepared], 20);

    await expect(service.reconcileStartup()).resolves.toEqual({
      recovered: 1,
      failed: 0,
      corrupt: 0,
      pending: 0,
      stagingFilesRemoved: 0,
      finalizedFilesRemoved: 0,
    });

    expect(blobStore.read).toHaveBeenCalledWith(prepared.blobRef, prepared.keyedContentId);
    expect(ledger.finalizeEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: prepared.id,
      conversationId: prepared.conversationId,
      blobRef: prepared.blobRef,
      keyVersion: 1,
    }));
  });

  it('fails only stale irrecoverable staging rows and removes stale staging files', async () => {
    const stale = record({ status: 'staging', updatedAt: 1 });
    const fresh = record({
      id: 'fresh',
      captureKey: 'fresh-key',
      status: 'staging',
      updatedAt: EVIDENCE_STAGING_STALE_MS + 5,
    });
    const now = EVIDENCE_STAGING_STALE_MS + 10;
    const { service, ledger, blobStore } = harness([stale, fresh], now);
    vi.mocked(blobStore.cleanupOrphanStagingFiles).mockResolvedValue(2);

    await expect(service.reconcileStartup()).resolves.toEqual({
      recovered: 0,
      failed: 1,
      corrupt: 0,
      pending: 1,
      stagingFilesRemoved: 2,
      finalizedFilesRemoved: 0,
    });

    expect(ledger.failEvidence).toHaveBeenCalledOnce();
    expect(ledger.failEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: stale.id,
      status: 'failed',
    }));
    expect(blobStore.cleanupOrphanStagingFiles).toHaveBeenCalledWith({
      olderThanMs: EVIDENCE_STAGING_STALE_MS,
      now,
    });
  });

  it('marks a prepared row corrupt when its finalized blob cannot authenticate', async () => {
    const prepared = record({
      status: 'staging',
      blobRef: 'opaque/prepared.aioev1',
      keyedContentId: 'b'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      updatedAt: 1,
    });
    const { service, ledger, blobStore } = harness(
      [prepared],
      EVIDENCE_STAGING_STALE_MS + 10,
    );
    vi.mocked(blobStore.read).mockRejectedValue(new EvidenceStorageError('BLOB_AUTH_FAILED'));

    const result = await service.reconcileStartup();

    expect(result.corrupt).toBe(1);
    expect(ledger.failEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: prepared.id,
      status: 'corrupt',
    }));
  });

  it.each(['UNSAFE_STORAGE_PATH', 'BLOB_REF_INVALID'] as const)(
    'fails closed when prepared metadata resolves through %s',
    async (code) => {
      const prepared = record({
        status: 'staging',
        blobRef: 'opaque/prepared.aioev1',
        keyedContentId: 'b'.repeat(64),
        byteCount: 7,
        keyVersion: 1,
        updatedAt: 1,
      });
      const { service, ledger, blobStore } = harness([prepared], 20);
      vi.mocked(blobStore.read).mockRejectedValue(new EvidenceStorageError(code));

      await expect(service.reconcileStartup()).resolves.toMatchObject({
        corrupt: 1,
        pending: 0,
      });
      expect(ledger.failEvidence).toHaveBeenCalledWith(expect.objectContaining({
        evidenceId: prepared.id,
        status: 'corrupt',
      }));
    },
  );

  it('keeps a fresh prepared row pending when its final blob is not yet present', async () => {
    const prepared = record({
      status: 'staging',
      blobRef: 'opaque/prepared.aioev1',
      keyedContentId: 'b'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      updatedAt: 10,
    });
    const { service, ledger, blobStore } = harness([prepared], 20);
    vi.mocked(blobStore.read).mockRejectedValue(new EvidenceStorageError('BLOB_NOT_FOUND'));

    await expect(service.reconcileStartup()).resolves.toMatchObject({
      recovered: 0,
      failed: 0,
      corrupt: 0,
      pending: 1,
    });

    expect(ledger.failEvidence).not.toHaveBeenCalled();
    expect(blobStore.cleanupOrphanStagingFiles).toHaveBeenCalledOnce();
  });

  it('fails a stale prepared row only when its final blob is demonstrably absent', async () => {
    const prepared = record({
      status: 'staging',
      blobRef: 'opaque/prepared.aioev1',
      keyedContentId: 'b'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      updatedAt: 1,
    });
    const { service, ledger, blobStore } = harness(
      [prepared],
      EVIDENCE_STAGING_STALE_MS + 10,
    );
    vi.mocked(blobStore.read).mockRejectedValue(new EvidenceStorageError('BLOB_NOT_FOUND'));

    await expect(service.reconcileStartup()).resolves.toMatchObject({
      recovered: 0,
      failed: 1,
      corrupt: 0,
      pending: 0,
    });

    expect(ledger.failEvidence).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: prepared.id,
      status: 'failed',
    }));
  });

  it('keeps a stale prepared row pending when its final blob read fails transiently', async () => {
    const prepared = record({
      status: 'staging',
      blobRef: 'opaque/prepared.aioev1',
      keyedContentId: 'b'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      updatedAt: 1,
    });
    const { service, ledger, blobStore } = harness(
      [prepared],
      EVIDENCE_STAGING_STALE_MS + 10,
    );
    vi.mocked(blobStore.read).mockRejectedValue(new EvidenceStorageError('BLOB_READ_FAILED'));

    await expect(service.reconcileStartup()).resolves.toMatchObject({
      recovered: 0,
      failed: 0,
      corrupt: 0,
      pending: 1,
    });

    expect(ledger.failEvidence).not.toHaveBeenCalled();
  });

  it('keeps authenticated prepared evidence pending when only ledger finalization fails', async () => {
    const prepared = record({
      status: 'staging',
      blobRef: 'opaque/prepared.aioev1',
      keyedContentId: 'b'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      updatedAt: 1,
    });
    const { service, ledger } = harness(
      [prepared],
      EVIDENCE_STAGING_STALE_MS + 10,
    );
    vi.mocked(ledger.finalizeEvidence).mockRejectedValue(new Error('fixture sqlite failure'));

    await expect(service.reconcileStartup()).resolves.toMatchObject({
      recovered: 0,
      failed: 0,
      corrupt: 0,
      pending: 1,
    });

    expect(ledger.failEvidence).not.toHaveBeenCalled();
  });

  it('paginates through more than one thousand staging rows without repeating pending rows', async () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => record({
      id: `evidence-${String(index).padStart(4, '0')}`,
      captureKey: `capture-${index}`,
      status: 'staging',
      updatedAt: 10,
    }));
    const { service, ledger } = harness([], 20);
    vi.mocked(ledger.listEvidenceForMaintenance).mockImplementation(async (query) => {
      const start = query.afterId
        ? rows.findIndex((row) => row.id === query.afterId) + 1
        : 0;
      return rows.slice(start, start + query.limit);
    });

    await expect(service.reconcileStartup()).resolves.toMatchObject({ pending: 1_001 });

    expect(ledger.listEvidenceForMaintenance).toHaveBeenCalledTimes(2);
    expect(ledger.listEvidenceForMaintenance).toHaveBeenNthCalledWith(2, expect.objectContaining({
      afterUpdatedAt: 10,
      afterId: 'evidence-0999',
    }));
  });

  it('passes a complete paginated reference set to finalized orphan cleanup', async () => {
    const { service, ledger, blobStore } = harness([], 20);
    const firstPage = Array.from({ length: 1_000 }, (_, index) => `ref-${index}`);
    vi.mocked(ledger.listReferencedEvidenceBlobRefs)
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(['ref-final']);
    vi.mocked(blobStore.cleanupOrphanFinalizedBlobs).mockResolvedValue(2);

    await expect(service.reconcileStartup()).resolves.toMatchObject({
      finalizedFilesRemoved: 2,
    });

    const cleanupInput = vi.mocked(blobStore.cleanupOrphanFinalizedBlobs).mock.calls[0]?.[0];
    expect(cleanupInput).toMatchObject({
      olderThanMs: EVIDENCE_STAGING_STALE_MS,
      now: 20,
    });
    expect(cleanupInput?.referencedBlobRefs.size).toBe(1_001);
    expect(cleanupInput?.referencedBlobRefs.has('ref-final')).toBe(true);
  });

  it('rotates one complete blob at a time after authenticating the old version', async () => {
    const complete = record({
      status: 'complete',
      blobRef: 'opaque/old.aioev1',
      keyedContentId: 'c'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      completedAt: 10,
    });
    const { service, ledger, blobStore, keyManager } = harness([], 30);
    vi.mocked(ledger.listEvidenceForMaintenance).mockResolvedValue([complete]);
    vi.mocked(blobStore.write).mockResolvedValue({
      blobRef: 'opaque/new.aioev1',
      keyedContentId: 'd'.repeat(64),
      byteCount: 7,
      keyVersion: 2,
    });

    await expect(service.rotateNext()).resolves.toEqual({
      status: 'rotated',
      evidenceId: complete.id,
    });

    expect(keyManager.getActiveKey).toHaveBeenCalledOnce();
    expect(blobStore.read).toHaveBeenCalledWith(complete.blobRef, complete.keyedContentId);
    expect(ledger.replaceEvidenceBlob).toHaveBeenCalledWith(expect.objectContaining({
      evidenceId: complete.id,
      expectedBlobRef: complete.blobRef,
      blobRef: 'opaque/new.aioev1',
      keyVersion: 2,
      cleanupGraceDeadline: 30 + EVIDENCE_STAGING_STALE_MS,
    }));
    expect(blobStore.remove).not.toHaveBeenCalledWith(complete.blobRef);
  });

  it('leaves either authenticated blob recoverable when rotation metadata update loses its race', async () => {
    const complete = record({
      status: 'complete',
      blobRef: 'opaque/old.aioev1',
      keyedContentId: 'c'.repeat(64),
      byteCount: 7,
      keyVersion: 1,
      completedAt: 10,
    });
    const { service, ledger, blobStore } = harness([], 30);
    vi.mocked(ledger.listEvidenceForMaintenance).mockResolvedValue([complete]);
    vi.mocked(ledger.replaceEvidenceBlob).mockResolvedValue(false);

    await expect(service.rotateNext()).resolves.toEqual({ status: 'race-lost' });
    expect(blobStore.remove).toHaveBeenCalledWith('opaque/default.aioev1');
  });
});

function harness(records: EvidenceLedgerRecord[], now: number): {
  service: EvidenceMaintenanceService;
  ledger: EvidenceMaintenanceLedger;
  blobStore: EvidenceMaintenanceBlobStore;
  keyManager: { getActiveKey: ReturnType<typeof vi.fn> };
} {
  const ledger: EvidenceMaintenanceLedger = {
    listEvidenceForMaintenance: vi.fn(async () => records),
    listReferencedEvidenceBlobRefs: vi.fn(async () => []),
    finalizeEvidence: vi.fn(async (input) => record({
      id: input.evidenceId,
      conversationId: input.conversationId,
      status: 'complete',
    })),
    failEvidence: vi.fn(async (input) => record({
      id: input.evidenceId,
      conversationId: input.conversationId,
      status: input.status ?? 'failed',
    })),
    replaceEvidenceBlob: vi.fn(async () => true),
  };
  const blobStore: EvidenceMaintenanceBlobStore = {
    read: vi.fn(async () => new TextEncoder().encode('payload')),
    write: vi.fn(async () => ({
      blobRef: 'opaque/default.aioev1',
      keyedContentId: 'e'.repeat(64),
      byteCount: 7,
      keyVersion: 2,
    })),
    remove: vi.fn(async () => undefined),
    cleanupOrphanStagingFiles: vi.fn(async () => 0),
    cleanupOrphanFinalizedBlobs: vi.fn(async () => 0),
  };
  const keyManager = {
    getActiveKey: vi.fn(async () => ({ version: 2, key: new Uint8Array(32), activatedAt: 20 })),
  };
  return {
    service: new EvidenceMaintenanceService({ ledger, blobStore, keyManager, now: () => now }),
    ledger,
    blobStore,
    keyManager,
  };
}

function record(overrides: Partial<EvidenceLedgerRecord> = {}): EvidenceLedgerRecord {
  return {
    id: 'evidence-1',
    conversationId: 'conversation-1',
    provider: 'codex',
    providerThreadRef: null,
    providerSessionRef: null,
    turnRef: null,
    toolCallRef: null,
    toolName: 'placeholder-tool',
    sourceKind: 'other',
    sourceLocatorRedacted: null,
    status: 'staging',
    blobRef: null,
    keyedContentId: null,
    byteCount: 0,
    tokenEstimate: null,
    mimeType: 'text/plain',
    sensitivity: 'normal',
    provenanceTrust: 'runtime-authenticated',
    captureMode: 'post-retention',
    captureCompleteness: 'complete',
    truncationReason: null,
    keyVersion: null,
    captureKey: 'capture-key',
    createdAt: 1,
    completedAt: null,
    updatedAt: 1,
    ...overrides,
  };
}
