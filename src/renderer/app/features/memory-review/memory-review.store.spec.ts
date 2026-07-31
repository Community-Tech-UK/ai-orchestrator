import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GovernedProposalIpcService } from '../../core/services/ipc/governed-proposal-ipc.service';
import { LearningScanIpcService } from '../../core/services/ipc/learning-scan-ipc.service';
import { MemoryReviewStore } from './memory-review.store';
import type { GovernedProposal } from './memory-review.types';

function makeProposal(overrides: Partial<GovernedProposal> = {}): GovernedProposal {
  return {
    id: 'p1',
    kind: 'memory',
    status: 'pending',
    provenance: 'agent-derived',
    title: 'Always run typecheck before claiming done',
    description: 'Always run typecheck before claiming done',
    payloadJson: JSON.stringify({ text: 'Always run typecheck before claiming done', normalizedText: 'always run typecheck before claiming done' }),
    sourceSessionId: 'loop-run-1',
    sourceMessageId: null,
    createdAt: 1_000,
    decidedAt: null,
    decidedBy: null,
    decisionRationale: null,
    reinforcements: 1,
    relatedIdsJson: '[]',
    tagsJson: '[]',
    ...overrides,
  };
}

describe('MemoryReviewStore', () => {
  const ipc = {
    list: vi.fn(),
    get: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  };
  const scanIpc = {
    run: vi.fn(),
    getStatus: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    ipc.list.mockResolvedValue({ success: true, data: [makeProposal()] });
    scanIpc.getStatus.mockResolvedValue({ success: true, data: null });
    TestBed.configureTestingModule({
      providers: [
        MemoryReviewStore,
        { provide: GovernedProposalIpcService, useValue: ipc },
        { provide: LearningScanIpcService, useValue: scanIpc },
      ],
    });
  });

  it('loads proposals and separates pending from decided', async () => {
    const store = TestBed.inject(MemoryReviewStore);
    await store.refresh();
    expect(store.pending()).toHaveLength(1);
    expect(store.decided()).toHaveLength(0);
    expect(store.pendingCount()).toBe(1);
  });

  it('surfaces a load error', async () => {
    ipc.list.mockResolvedValue({ success: false, error: { message: 'db unavailable' } });
    const store = TestBed.inject(MemoryReviewStore);
    await store.refresh();
    expect(store.error()).toBe('db unavailable');
    expect(store.pending()).toHaveLength(0);
  });

  it('approve() upserts the decided proposal returned by IPC', async () => {
    ipc.approve.mockResolvedValue({
      success: true,
      data: makeProposal({ status: 'approved', decidedAt: 2_000, decidedBy: 'james' }),
    });
    const store = TestBed.inject(MemoryReviewStore);
    await store.refresh();

    const ok = await store.approve('p1', 'james', 'good generalization');

    expect(ok).toBe(true);
    expect(ipc.approve).toHaveBeenCalledWith({ id: 'p1', actor: 'james', rationale: 'good generalization' });
    expect(store.pending()).toHaveLength(0);
    expect(store.decided()).toHaveLength(1);
    expect(store.decided()[0].status).toBe('approved');
  });

  it('approveEdited() passes editedText through to the IPC call', async () => {
    ipc.approve.mockResolvedValue({
      success: true,
      data: makeProposal({ status: 'approved', decidedAt: 2_000, title: 'Edited title' }),
    });
    const store = TestBed.inject(MemoryReviewStore);
    await store.refresh();

    await store.approveEdited('p1', 'A better phrasing of the lesson', 'james');

    expect(ipc.approve).toHaveBeenCalledWith({
      id: 'p1',
      editedText: 'A better phrasing of the lesson',
      actor: 'james',
      rationale: undefined,
    });
  });

  it('reject() upserts the rejected proposal and surfaces an error on failure', async () => {
    ipc.reject.mockResolvedValueOnce({ success: false, error: { message: 'decision failed' } });
    const store = TestBed.inject(MemoryReviewStore);
    await store.refresh();

    const failed = await store.reject('p1', 'james', 'too narrow');
    expect(failed).toBe(false);
    expect(store.error()).toBe('decision failed');

    ipc.reject.mockResolvedValueOnce({
      success: true,
      data: makeProposal({ status: 'rejected', decidedAt: 3_000, decisionRationale: 'too narrow' }),
    });
    const ok = await store.reject('p1', 'james', 'too narrow');
    expect(ok).toBe(true);
    expect(store.decided()[0].status).toBe('rejected');
  });

  it('select() loads the audit trail for the chosen proposal', async () => {
    ipc.get.mockResolvedValue({
      success: true,
      data: { proposal: makeProposal(), audit: [{ id: 1, proposalId: 'p1', action: 'created', actor: null, timestamp: 1, reason: null, metadataJson: '{}' }] },
    });
    const store = TestBed.inject(MemoryReviewStore);
    await store.refresh();

    await store.select('p1');

    expect(store.selectedId()).toBe('p1');
    expect(store.selectedAudit()).toHaveLength(1);
    expect(store.selected()?.id).toBe('p1');
  });

  it('toggleShowDecided() flips the decided-history visibility flag', () => {
    const store = TestBed.inject(MemoryReviewStore);
    expect(store.showDecided()).toBe(false);
    store.toggleShowDecided();
    expect(store.showDecided()).toBe(true);
  });

  it('runScan() records the summary, refreshes status + the proposal list, and toggles scanning', async () => {
    scanIpc.run.mockResolvedValue({
      success: true,
      data: {
        scopeKey: '__global__', sessionsScanned: 3, sessionsSkipped: 0,
        proposalsCreated: 1, proposalsReinforced: 0, patternsFound: 1,
        startedAt: 1, completedAt: 2, error: null,
      },
    });
    scanIpc.getStatus.mockResolvedValue({
      success: true,
      data: {
        scopeKey: '__global__', lastScannedEndedAt: 2000, lastScannedEntryId: 'e2',
        lastScanStartedAt: 1, lastScanCompletedAt: 2, sessionsScannedLastRun: 3,
        sessionsScannedTotal: 3, proposalsCreatedLastRun: 1, proposalsReinforcedLastRun: 0,
        lastError: null, updatedAt: 2,
      },
    });
    const store = TestBed.inject(MemoryReviewStore);

    const scanPromise = store.runScan();
    expect(store.scanning()).toBe(true);
    await scanPromise;

    expect(store.scanning()).toBe(false);
    expect(store.lastScanResult()?.proposalsCreated).toBe(1);
    expect(store.scanStatus()?.lastScannedEntryId).toBe('e2');
    expect(ipc.list).toHaveBeenCalled(); // refresh() re-ran after the scan
  });

  it('runScan() surfaces a top-level IPC failure', async () => {
    scanIpc.run.mockResolvedValue({ success: false, error: { message: 'scan crashed' } });
    const store = TestBed.inject(MemoryReviewStore);

    await store.runScan();

    expect(store.error()).toBe('scan crashed');
    expect(store.scanning()).toBe(false);
  });

  it('runScan() surfaces an in-band scan error from a partially-completed run', async () => {
    scanIpc.run.mockResolvedValue({
      success: true,
      data: {
        scopeKey: '__global__', sessionsScanned: 0, sessionsSkipped: 0,
        proposalsCreated: 0, proposalsReinforced: 0, patternsFound: 0,
        startedAt: 1, completedAt: 2, error: 'index corrupt',
      },
    });
    const store = TestBed.inject(MemoryReviewStore);

    await store.runScan();

    expect(store.error()).toBe('index corrupt');
  });

  it('refreshScanStatus() reads the last checkpoint without triggering a scan', async () => {
    scanIpc.getStatus.mockResolvedValue({
      success: true,
      data: {
        scopeKey: '__global__', lastScannedEndedAt: 500, lastScannedEntryId: 'e1',
        lastScanStartedAt: 1, lastScanCompletedAt: 2, sessionsScannedLastRun: 1,
        sessionsScannedTotal: 1, proposalsCreatedLastRun: 0, proposalsReinforcedLastRun: 0,
        lastError: null, updatedAt: 2,
      },
    });
    const store = TestBed.inject(MemoryReviewStore);

    await store.refreshScanStatus();

    expect(store.scanStatus()?.lastScannedEntryId).toBe('e1');
    expect(scanIpc.run).not.toHaveBeenCalled();
  });
});
