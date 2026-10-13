import type {
  EvidenceFailureInput,
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceBlobReferenceQuery,
  EvidenceBlobReferenceScanPage,
  EvidenceBlobReplacementInput,
  EvidenceMaintenanceQuery,
} from '../conversation-ledger/context-evidence-ledger.types';
import type { EvidenceDataKey, EvidenceBlobWriteResult } from './evidence-storage.types';
import { setTimeout as delay } from 'node:timers/promises';
import { getLogger } from '../logging/logger';
import type { EvidenceFinalizedCleanupOptions, EvidenceStagingCleanupOptions } from './evidence-storage.types';

export {
  initializeContextEvidenceRuntime, getContextEvidenceRuntime,
  startContextEvidenceMaintenance, abortContextEvidenceMaintenance,
  stopContextEvidenceMaintenance, _resetContextEvidenceRuntimeForTesting,
  type ContextEvidenceRuntime,
} from './evidence-maintenance-runtime';

const logger = getLogger('EvidenceMaintenanceService');

export const EVIDENCE_STAGING_STALE_MS = 15 * 60 * 1000;

export interface EvidenceMaintenanceLedger {
  listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): Promise<EvidenceLedgerRecord[]>;
  listEvidenceBlobReferenceScanPage(query: EvidenceBlobReferenceQuery): Promise<EvidenceBlobReferenceScanPage>;
  listReferencedEvidenceBlobRefsForCandidates(blobRefs: string[]): Promise<string[]>;
  getEvidenceForMaintenance(conversationId: string, evidenceId: string): Promise<EvidenceLedgerRecord | null>;
  finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord>;
  failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord>;
  replaceEvidenceBlob(input: EvidenceBlobReplacementInput): Promise<boolean>;
}

export interface EvidenceMaintenanceBlobStore {
  read(blobRef: string, expectedKeyedContentId?: string): Promise<Uint8Array>;
  write(conversationId: string, content: Uint8Array): Promise<EvidenceBlobWriteResult>;
  remove(blobRef: string): Promise<void>;
  withBlobPublication?<T>(operation: () => Promise<T>): Promise<T>;
  cleanupOrphanStagingFiles(options: EvidenceStagingCleanupOptions): Promise<number>;
  cleanupOrphanFinalizedBlobs(options: EvidenceFinalizedCleanupOptions): Promise<number>;
}

export interface EvidenceMaintenanceKeyManager {
  getActiveKey(): Promise<EvidenceDataKey>;
}

export interface EvidenceMaintenanceServiceOptions {
  ledger: EvidenceMaintenanceLedger;
  blobStore: EvidenceMaintenanceBlobStore;
  keyManager: EvidenceMaintenanceKeyManager;
  now?: () => number;
  isCaptureActive?: (row: EvidenceLedgerRecord) => boolean;
}

export interface EvidenceStartupReconciliationResult {
  recovered: number;
  failed: number;
  corrupt: number;
  pending: number;
  stagingFilesRemoved: number;
  finalizedFilesRemoved: number;
}

export type EvidenceRotationResult =
  | { status: 'idle' }
  | { status: 'rotated'; evidenceId: string }
  | { status: 'race-lost' };

/** Reconciles crash windows and rotates one authenticated blob per bounded call. */
export class EvidenceMaintenanceService {
  private readonly now: () => number;

  constructor(private readonly options: EvidenceMaintenanceServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async reconcileStartup(signal?: AbortSignal): Promise<EvidenceStartupReconciliationResult> {
    signal?.throwIfAborted();
    const now = this.now();
    const staleBefore = now - EVIDENCE_STAGING_STALE_MS;
    const result: EvidenceStartupReconciliationResult = {
      recovered: 0,
      failed: 0,
      corrupt: 0,
      pending: 0,
      stagingFilesRemoved: 0,
      finalizedFilesRemoved: 0,
    };

    let cursor: Pick<EvidenceMaintenanceQuery, 'afterUpdatedAt' | 'afterId'> = {};
    while (true) {
      const rows = await this.options.ledger.listEvidenceForMaintenance({
        statuses: ['staging'],
        limit: 1000,
        updatedBefore: now,
        ...cursor,
      });
      for (const row of rows) {
        signal?.throwIfAborted();
        if (row.updatedAt > now || this.options.isCaptureActive?.(row)) {
          result.pending += 1;
          continue;
        }
        const current = await this.options.ledger.getEvidenceForMaintenance(row.conversationId, row.id);
        signal?.throwIfAborted();
        if (!current || current.status !== 'staging' || current.updatedAt !== row.updatedAt
          || current.blobRef !== row.blobRef || this.options.isCaptureActive?.(row)) {
          result.pending += 1;
          continue;
        }
        if (isPrepared(row)) {
          const outcome = await this.reconcilePrepared(row, now, staleBefore, signal);
          result[outcome] += 1;
        } else if (row.updatedAt <= staleBefore) {
          await this.options.ledger.failEvidence({
            evidenceId: row.id,
            conversationId: row.conversationId,
            status: 'failed',
            updatedAt: now,
            expectedUpdatedAt: row.updatedAt,
            expectedBlobRef: row.blobRef,
          });
          result.failed += 1;
        } else {
          result.pending += 1;
        }
      }
      if (rows.length < 1000) break;
      const last = rows.at(-1)!;
      cursor = { afterUpdatedAt: last.updatedAt, afterId: last.id };
      await delay(25, undefined, { signal });
    }

    signal?.throwIfAborted();
    result.stagingFilesRemoved = await this.phase('staging-cleanup', () => this.options.blobStore.cleanupOrphanStagingFiles({
      olderThanMs: EVIDENCE_STAGING_STALE_MS,
      now,
      ...(signal ? { signal } : {}),
    }));
    const referencedBlobRefs = await this.phase('references', () => this.listAllReferencedBlobRefs(signal));
    signal?.throwIfAborted();
    result.finalizedFilesRemoved = await this.phase('finalized-cleanup', () => this.options.blobStore.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs,
      olderThanMs: EVIDENCE_STAGING_STALE_MS,
      now,
      ...(signal ? { signal } : {}),
      findReferencedCandidates: (refs) => this.options.ledger.listReferencedEvidenceBlobRefsForCandidates(refs),
    }));
    logger.info('Evidence reconciliation finished', { ...result });
    return result;
  }

  async rotateNext(): Promise<EvidenceRotationResult> {
    if (this.options.blobStore.withBlobPublication) {
      return this.options.blobStore.withBlobPublication(() => this.rotateNextOnce());
    }
    return this.rotateNextOnce();
  }

  private async rotateNextOnce(): Promise<EvidenceRotationResult> {
    const activeKey = await this.options.keyManager.getActiveKey();
    const [candidate] = await this.options.ledger.listEvidenceForMaintenance({
      statuses: ['complete'],
      keyVersionNot: activeKey.version,
      limit: 1,
    });
    if (!candidate || !isCompleteBlob(candidate)) return { status: 'idle' };

    const plaintext = await this.options.blobStore.read(
      candidate.blobRef,
      candidate.keyedContentId,
    );
    let replacement: EvidenceBlobWriteResult;
    try {
      replacement = await this.options.blobStore.write(candidate.conversationId, plaintext);
    } finally {
      plaintext.fill(0);
    }
    if (replacement.keyVersion !== activeKey.version) {
      await this.options.blobStore.remove(replacement.blobRef).catch(() => undefined);
      throw new Error('EVIDENCE_ROTATION_ACTIVE_KEY_CHANGED');
    }

    const updatedAt = this.now();
    const replaced = await this.options.ledger.replaceEvidenceBlob({
      evidenceId: candidate.id,
      conversationId: candidate.conversationId,
      expectedBlobRef: candidate.blobRef,
      expectedKeyVersion: candidate.keyVersion,
      blobRef: replacement.blobRef,
      keyedContentId: replacement.keyedContentId,
      byteCount: replacement.byteCount,
      keyVersion: replacement.keyVersion,
      completedAt: candidate.completedAt ?? this.now(),
      cleanupGraceDeadline: updatedAt + EVIDENCE_STAGING_STALE_MS,
      updatedAt,
    });
    if (!replaced) {
      await this.options.blobStore.remove(replacement.blobRef).catch(() => undefined);
      return { status: 'race-lost' };
    }

    return { status: 'rotated', evidenceId: candidate.id };
  }

  private async listAllReferencedBlobRefs(signal?: AbortSignal): Promise<Set<string>> {
    const referenced = new Set<string>();
    let afterBlobRef: string | undefined;
    let pages = 0;
    while (true) {
      signal?.throwIfAborted();
      const page = await this.options.ledger.listEvidenceBlobReferenceScanPage({
        afterBlobRef,
        limit: 1000,
      });
      signal?.throwIfAborted();
      pages += 1;
      for (const ref of page.blobRefs) referenced.add(ref);
      if (pages % 50 === 0) logger.info('Evidence reference enumeration progress', { pages, count: referenced.size });
      if (page.done) return referenced;
      if (page.afterBlobRef === undefined || (afterBlobRef !== undefined
        && Buffer.compare(Buffer.from(page.afterBlobRef), Buffer.from(afterBlobRef)) <= 0)) {
        throw new Error('EVIDENCE_REFERENCE_SCAN_CURSOR_INVALID');
      }
      afterBlobRef = page.afterBlobRef;
      await delay(25, undefined, { signal });
    }
  }

  private async reconcilePrepared(
    row: EvidenceLedgerRecord & {
      blobRef: string;
      keyedContentId: string;
      keyVersion: number;
    },
    now: number,
    staleBefore: number,
    signal?: AbortSignal,
  ): Promise<'recovered' | 'failed' | 'corrupt' | 'pending'> {
    let plaintext: Uint8Array;
    try {
      plaintext = await this.options.blobStore.read(row.blobRef, row.keyedContentId);
    } catch (error) {
      signal?.throwIfAborted();
      if (isCorruptionFailure(error)) {
        await this.mark(row, 'corrupt', now);
        return 'corrupt';
      }
      if (isMissingFinalBlob(error) && row.updatedAt <= staleBefore) {
        await this.mark(row, 'failed', now);
        return 'failed';
      }
      return 'pending';
    }
    const byteCountMatches = plaintext.byteLength === row.byteCount;
    plaintext.fill(0);
    signal?.throwIfAborted();
    if (!byteCountMatches) {
      await this.mark(row, 'corrupt', now);
      return 'corrupt';
    }
    try {
      await this.options.ledger.finalizeEvidence({
        evidenceId: row.id,
        conversationId: row.conversationId,
        blobRef: row.blobRef,
        keyedContentId: row.keyedContentId,
        byteCount: row.byteCount,
        tokenEstimate: row.tokenEstimate,
        keyVersion: row.keyVersion,
        completedAt: now,
        expectedUpdatedAt: row.updatedAt,
        expectedBlobRef: row.blobRef,
      });
      return 'recovered';
    } catch {
      return 'pending';
    }
  }

  private async mark(
    row: EvidenceLedgerRecord,
    status: 'failed' | 'corrupt',
    updatedAt: number,
  ): Promise<void> {
    await this.options.ledger.failEvidence({
      evidenceId: row.id,
      conversationId: row.conversationId,
      status,
      updatedAt,
      expectedUpdatedAt: row.updatedAt,
      expectedBlobRef: row.blobRef,
    });
  }

  private async phase<T>(phase: string, run: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    logger.info('Evidence maintenance phase started', { phase });
    const result = await run();
    logger.info('Evidence maintenance phase finished', { phase, durationMs: performance.now() - startedAt });
    return result;
  }
}

function isPrepared(row: EvidenceLedgerRecord): row is EvidenceLedgerRecord & {
  blobRef: string;
  keyedContentId: string;
  keyVersion: number;
} {
  return row.blobRef !== null && row.keyedContentId !== null && row.keyVersion !== null;
}

function isCompleteBlob(row: EvidenceLedgerRecord): row is EvidenceLedgerRecord & {
  blobRef: string;
  keyedContentId: string;
  keyVersion: number;
} {
  return row.status === 'complete' && isPrepared(row);
}

function isCorruptionFailure(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'BLOB_AUTH_FAILED'
    || code === 'BLOB_DIGEST_MISMATCH'
    || code === 'BLOB_FORMAT_INVALID'
    || code === 'BLOB_REF_INVALID'
    || code === 'UNSAFE_STORAGE_PATH'
    || code === 'KEY_VERSION_UNAVAILABLE';
}

function isMissingFinalBlob(error: unknown): boolean {
  return (error as { code?: unknown }).code === 'BLOB_NOT_FOUND';
}
