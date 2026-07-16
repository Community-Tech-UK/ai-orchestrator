import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EVIDENCE_DELETION_GRACE_MS,
  EvidenceDeletionService,
  type EvidenceDeletionLedger,
} from './evidence-deletion-service';

describe('EvidenceDeletionService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('revokes a canonical conversation immediately and queues the fixed grace deadline', async () => {
    const { service, ledger } = harness(1_000);

    await expect(service.revokeConversation('conversation-1')).resolves.toEqual({
      conversationId: 'conversation-1', queuedBlobCount: 1, alreadyDeleted: false,
    });
    expect(ledger.softDeleteConversationWithEvidence).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      deletedAt: new Date(1_000).toISOString(),
      graceDeadline: 1_000 + EVIDENCE_DELETION_GRACE_MS,
    });
  });

  it('deletes only leased opaque blob refs and completes them with the same claim token', async () => {
    const { service, ledger, blobStore } = harness(20_000);
    vi.mocked(ledger.claimEvidenceDeletions).mockResolvedValue([queueRecord()]);

    await expect(service.runJanitor(5)).resolves.toEqual({
      claimed: 1, deleted: 1, failed: 0,
    });
    expect(blobStore.remove).toHaveBeenCalledWith('opaque/blob.aioev1');
    expect(ledger.completeEvidenceDeletion).toHaveBeenCalledWith(
      'queue-1', 'claim-1', 20_000,
    );
  });

  it('records a content-free retry with bounded exponential backoff', async () => {
    const { service, ledger, blobStore } = harness(20_000);
    vi.mocked(ledger.claimEvidenceDeletions).mockResolvedValue([queueRecord({ attempts: 3 })]);
    vi.mocked(blobStore.remove).mockRejectedValue(Object.assign(new Error('private path detail'), {
      code: 'CLEANUP_FAILED',
    }));

    await expect(service.runJanitor(5)).resolves.toEqual({
      claimed: 1, deleted: 0, failed: 1,
    });
    expect(ledger.failEvidenceDeletion).toHaveBeenCalledWith(
      'queue-1', 'claim-1', 'CLEANUP_FAILED', 28_000,
    );
    expect(JSON.stringify(vi.mocked(ledger.failEvidenceDeletion).mock.calls))
      .not.toContain('private path detail');
  });

  it('completes a retry when the blob was removed before the prior claim committed', async () => {
    const { service, ledger, blobStore } = harness(20_000);
    vi.mocked(ledger.claimEvidenceDeletions).mockResolvedValue([queueRecord()]);
    vi.mocked(blobStore.remove).mockRejectedValue(Object.assign(new Error('already absent'), {
      code: 'BLOB_NOT_FOUND',
    }));

    await expect(service.runJanitor(5)).resolves.toEqual({
      claimed: 1, deleted: 1, failed: 0,
    });
    expect(ledger.completeEvidenceDeletion).toHaveBeenCalledWith(
      'queue-1', 'claim-1', 20_000,
    );
    expect(ledger.failEvidenceDeletion).not.toHaveBeenCalled();
  });

  it('keeps sweeping for deletion work queued after the startup pass', async () => {
    vi.useFakeTimers();
    const { service, ledger } = harness(20_000);
    const janitor = vi.spyOn(service, 'runJanitor')
      .mockResolvedValue({ claimed: 0, deleted: 0, failed: 0 });

    service.startJanitorScheduler(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(janitor).toHaveBeenCalledTimes(2);
    expect(ledger.claimEvidenceDeletions).not.toHaveBeenCalled();
    service.stopJanitorScheduler();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(janitor).toHaveBeenCalledTimes(2);
  });

  it('bounds each janitor batch and refuses ownerless queue claims', async () => {
    const { service, ledger, blobStore } = harness(20_000);
    vi.mocked(ledger.claimEvidenceDeletions).mockResolvedValue([
      queueRecord({ claimToken: null }),
    ]);

    await expect(service.runJanitor(10_000)).resolves.toEqual({
      claimed: 1, deleted: 0, failed: 1,
    });
    expect(ledger.claimEvidenceDeletions).toHaveBeenCalledWith(20_000, 100, 60_000);
    expect(blobStore.remove).not.toHaveBeenCalled();
  });
});

function harness(now: number): {
  service: EvidenceDeletionService;
  ledger: EvidenceDeletionLedger;
  blobStore: { remove: ReturnType<typeof vi.fn> };
} {
  const ledger: EvidenceDeletionLedger = {
    softDeleteConversationWithEvidence: vi.fn(async (input) => ({
      conversationId: input.conversationId, queuedBlobCount: 1, alreadyDeleted: false,
    })),
    claimEvidenceDeletions: vi.fn(async () => []),
    completeEvidenceDeletion: vi.fn(async () => true),
    failEvidenceDeletion: vi.fn(async () => true),
  };
  const blobStore = { remove: vi.fn(async () => undefined) };
  return {
    service: new EvidenceDeletionService({ ledger, blobStore, now: () => now }),
    ledger,
    blobStore,
  };
}

function queueRecord(overrides: Partial<Awaited<ReturnType<
  EvidenceDeletionLedger['claimEvidenceDeletions']
>>[number]> = {}) {
  return {
    id: 'queue-1', conversationId: 'conversation-1', evidenceId: 'evidence-1',
    blobRef: 'opaque/blob.aioev1', graceDeadline: 10_000, attempts: 1,
    claimToken: 'claim-1', claimedUntil: 80_000, nextAttemptAt: 10_000,
    lastErrorCode: null, completedAt: null, createdAt: 1,
    ...overrides,
  };
}
