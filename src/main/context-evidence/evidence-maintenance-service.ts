import type {
  EvidenceFailureInput,
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceBlobReferenceQuery,
  EvidenceBlobReplacementInput,
  EvidenceMaintenanceQuery,
} from '../conversation-ledger/context-evidence-ledger.types';
import type { EvidenceDataKey, EvidenceBlobWriteResult } from './evidence-storage.types';
import { EvidenceCaptureService, type EvidenceCaptureLedger } from './evidence-capture-service';
import { EncryptedEvidenceBlobStore } from './encrypted-evidence-blob-store';
import { EvidenceKeyManager } from './evidence-key-manager';
import {
  EvidenceDeletionService,
  type EvidenceDeletionLedger,
} from './evidence-deletion-service';
import { getSafeStorage } from '../session/safe-storage-accessor';
import { registerCleanup } from '../util/cleanup-registry';

export const EVIDENCE_STAGING_STALE_MS = 15 * 60 * 1000;

export interface EvidenceMaintenanceLedger {
  listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): Promise<EvidenceLedgerRecord[]>;
  listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): Promise<string[]>;
  finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord>;
  failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord>;
  replaceEvidenceBlob(input: EvidenceBlobReplacementInput): Promise<boolean>;
}

export interface EvidenceMaintenanceBlobStore {
  read(blobRef: string, expectedKeyedContentId?: string): Promise<Uint8Array>;
  write(conversationId: string, content: Uint8Array): Promise<EvidenceBlobWriteResult>;
  remove(blobRef: string): Promise<void>;
  cleanupOrphanStagingFiles(options: { olderThanMs: number; now: number }): Promise<number>;
  cleanupOrphanFinalizedBlobs(options: {
    referencedBlobRefs: ReadonlySet<string>;
    olderThanMs: number;
    now: number;
  }): Promise<number>;
}

export interface EvidenceMaintenanceKeyManager {
  getActiveKey(): Promise<EvidenceDataKey>;
}

export interface EvidenceMaintenanceServiceOptions {
  ledger: EvidenceMaintenanceLedger;
  blobStore: EvidenceMaintenanceBlobStore;
  keyManager: EvidenceMaintenanceKeyManager;
  now?: () => number;
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

  async reconcileStartup(): Promise<EvidenceStartupReconciliationResult> {
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
        ...cursor,
      });
      for (const row of rows) {
        if (isPrepared(row)) {
          const outcome = await this.reconcilePrepared(row, now, staleBefore);
          result[outcome] += 1;
        } else if (row.updatedAt <= staleBefore) {
          await this.options.ledger.failEvidence({
            evidenceId: row.id,
            conversationId: row.conversationId,
            status: 'failed',
            updatedAt: now,
          });
          result.failed += 1;
        } else {
          result.pending += 1;
        }
      }
      if (rows.length < 1000) break;
      const last = rows.at(-1)!;
      cursor = { afterUpdatedAt: last.updatedAt, afterId: last.id };
    }

    result.stagingFilesRemoved = await this.options.blobStore.cleanupOrphanStagingFiles({
      olderThanMs: EVIDENCE_STAGING_STALE_MS,
      now,
    });
    const referencedBlobRefs = await this.listAllReferencedBlobRefs();
    result.finalizedFilesRemoved = await this.options.blobStore.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs,
      olderThanMs: EVIDENCE_STAGING_STALE_MS,
      now,
    });
    return result;
  }

  async rotateNext(): Promise<EvidenceRotationResult> {
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

  private async listAllReferencedBlobRefs(): Promise<Set<string>> {
    const referenced = new Set<string>();
    let afterBlobRef: string | undefined;
    while (true) {
      const refs = await this.options.ledger.listReferencedEvidenceBlobRefs({
        afterBlobRef,
        limit: 1000,
      });
      for (const ref of refs) referenced.add(ref);
      if (refs.length < 1000) return referenced;
      afterBlobRef = refs.at(-1)!;
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
  ): Promise<'recovered' | 'failed' | 'corrupt' | 'pending'> {
    let plaintext: Uint8Array;
    try {
      plaintext = await this.options.blobStore.read(row.blobRef, row.keyedContentId);
    } catch (error) {
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
    });
  }
}

export interface ContextEvidenceRuntime {
  keyManager: EvidenceKeyManager;
  blobStore: EncryptedEvidenceBlobStore;
  captureService: EvidenceCaptureService;
  maintenanceService: EvidenceMaintenanceService;
  deletionService: EvidenceDeletionService;
}

let contextEvidenceRuntime: ContextEvidenceRuntime | null = null;
let contextEvidenceRuntimeInitialization: Promise<void> | null = null;
let unregisterContextEvidenceCleanup: (() => void) | null = null;

/** Creates the fail-closed evidence runtime once and awaits startup reconciliation. */
export async function initializeContextEvidenceRuntime(): Promise<void> {
  if (contextEvidenceRuntime) return;
  contextEvidenceRuntimeInitialization ??= initializeDefaultRuntime().catch((error: unknown) => {
    contextEvidenceRuntimeInitialization = null;
    throw error;
  });
  await contextEvidenceRuntimeInitialization;
}

export function getContextEvidenceRuntime(): ContextEvidenceRuntime {
  if (!contextEvidenceRuntime) throw new Error('CONTEXT_EVIDENCE_RUNTIME_UNAVAILABLE');
  return contextEvidenceRuntime;
}

export function _resetContextEvidenceRuntimeForTesting(): void {
  contextEvidenceRuntime?.deletionService.stopJanitorScheduler();
  unregisterContextEvidenceCleanup?.();
  unregisterContextEvidenceCleanup = null;
  contextEvidenceRuntime = null;
  contextEvidenceRuntimeInitialization = null;
}

async function initializeDefaultRuntime(): Promise<void> {
  // Kept lazy so importing app initialization outside Electron never resolves
  // safeStorage or opens the conversation database.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron') as typeof import('electron');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getConversationLedgerService } = require('../conversation-ledger') as typeof import('../conversation-ledger');
  const ledger = getConversationLedgerService() as unknown as
    EvidenceCaptureLedger & EvidenceMaintenanceLedger & EvidenceDeletionLedger;
  const keyManager = new EvidenceKeyManager({
    userDataPath: app.getPath('userData'),
    safeStorage: getSafeStorage(),
  });
  await keyManager.initialize();
  const blobStore = new EncryptedEvidenceBlobStore({
    userDataPath: app.getPath('userData'),
    keyManager,
  });
  const captureService = new EvidenceCaptureService({ ledger, blobStore });
  const maintenanceService = new EvidenceMaintenanceService({
    ledger,
    blobStore,
    keyManager,
  });
  const deletionService = new EvidenceDeletionService({ ledger, blobStore });
  await maintenanceService.reconcileStartup();
  await deletionService.runJanitor(100);
  contextEvidenceRuntime = {
    keyManager,
    blobStore,
    captureService,
    maintenanceService,
    deletionService,
  };
  deletionService.startJanitorScheduler();
  unregisterContextEvidenceCleanup = registerCleanup(() => {
    deletionService.stopJanitorScheduler();
  });
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
