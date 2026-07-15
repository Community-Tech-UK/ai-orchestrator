import { randomUUID } from 'node:crypto';
import type {
  EvidenceCaptureRequest,
  EvidenceCaptureResult,
  EvidenceRecord,
  EvidenceSensitivity,
} from '@contracts/types/context-evidence';
import { detectSecrets } from '../security/secret-detector';
import type {
  EvidenceFailureInput,
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceStageInput,
} from '../conversation-ledger/context-evidence-ledger.types';
import type { EvidenceBlobWriteResult } from './evidence-storage.types';
import { evidenceContentIdentityMatches } from './evidence-content-identity';

export type EvidenceObservationBoundary =
  | 'before-provider-retention'
  | 'after-provider-retention'
  | 'provider-observed-only';

export interface EvidenceCaptureServiceInput extends EvidenceCaptureRequest {
  observedBoundary: EvidenceObservationBoundary;
}

export interface EvidenceCaptureLedger {
  stageEvidence(input: EvidenceStageInput): Promise<EvidenceLedgerRecord>;
  prepareEvidenceBlob(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord>;
  finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord>;
  failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord>;
}

export interface EvidenceCaptureBlobStore {
  write(
    conversationId: string,
    content: Uint8Array,
    onStaged?: (result: EvidenceBlobWriteResult) => Promise<void>,
  ): Promise<EvidenceBlobWriteResult>;
  deriveContentId(content: Uint8Array, keyVersion?: number): Promise<string>;
}

export interface EvidenceCaptureServiceOptions {
  ledger: EvidenceCaptureLedger;
  blobStore: EvidenceCaptureBlobStore;
  now?: () => number;
  createId?: () => string;
}

/** Coordinates one durable raw-evidence receipt without retaining plaintext. */
export class EvidenceCaptureService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly captureQueues = new Map<string, Promise<void>>();

  constructor(private readonly options: EvidenceCaptureServiceOptions) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  capture(input: EvidenceCaptureServiceInput): Promise<EvidenceCaptureResult> {
    const ownedInput = { ...input, content: Uint8Array.from(input.content) };
    const queueKey = `${input.conversationId}\u0000${input.captureKey}`;
    const previous = this.captureQueues.get(queueKey) ?? Promise.resolve();
    const capture = previous
      .catch(() => undefined)
      .then(() => this.captureOnce(ownedInput));
    const tail = capture.then(() => undefined, () => undefined);
    this.captureQueues.set(queueKey, tail);
    return capture.finally(() => {
      if (this.captureQueues.get(queueKey) === tail) this.captureQueues.delete(queueKey);
    });
  }

  private async captureOnce(input: EvidenceCaptureServiceInput): Promise<EvidenceCaptureResult> {
    if (
      input.captureCompleteness !== 'complete'
      && !input.truncationReason?.trim()
    ) {
      return failed(
        'CAPTURE_INVALID_REQUEST',
        'Incomplete evidence requires an explicit limitation disclosure.',
      );
    }

    const evidenceId = this.createId();
    const createdAt = this.now();
    const stageInput: EvidenceStageInput = {
      id: evidenceId,
      conversationId: input.conversationId,
      provider: input.provider,
      providerThreadRef: input.providerThreadRef ?? null,
      turnRef: input.turnRef ?? null,
      toolCallRef: input.toolCallRef ?? null,
      toolName: input.toolName,
      sourceKind: input.sourceKind,
      sourceLocatorRedacted: input.sourceLocatorRedacted ?? null,
      mimeType: input.mimeType,
      sensitivity: classifySensitivity(input),
      provenanceTrust: input.provenanceTrust,
      captureMode: truthfulCaptureMode(input),
      captureCompleteness: input.captureCompleteness,
      truncationReason: input.truncationReason ?? null,
      captureKey: input.captureKey,
      createdAt,
    };

    let staged: EvidenceLedgerRecord;
    try {
      staged = await this.options.ledger.stageEvidence(stageInput);
    } catch {
      return failed('CAPTURE_STAGE_FAILED', 'Durable evidence metadata could not be staged.');
    }

    if (staged.status === 'complete') {
      return this.classifyExistingComplete(input.content, staged);
    }
    if (staged.id !== evidenceId) {
      return failed(
        'CAPTURE_IN_PROGRESS',
        'The logical evidence capture is already pending reconciliation.',
      );
    }
    if (staged.status !== 'staging') {
      return failed(
        'CAPTURE_INVALID_STATE',
        'The logical evidence capture cannot be written in its current state.',
      );
    }

    let prepared = false;
    let writeResult: EvidenceBlobWriteResult;
    try {
      writeResult = await this.options.blobStore.write(
        input.conversationId,
        input.content,
        async (result) => {
          await this.options.ledger.prepareEvidenceBlob(
            finalizeInput(staged, result, this.now()),
          );
          prepared = true;
        },
      );
    } catch (error) {
      if (prepared) {
        return failed(
          'CAPTURE_FINALIZE_PENDING',
          'Encrypted evidence is pending startup reconciliation.',
        );
      }
      await this.failStaged(staged);
      return failed(
        contentFreeErrorCode(error, 'CAPTURE_BLOB_WRITE_FAILED'),
        'Encrypted evidence storage failed before finalization.',
      );
    }

    try {
      const complete = await this.options.ledger.finalizeEvidence(
        finalizeInput(staged, writeResult, this.now()),
      );
      return { status: 'captured', record: toContractRecord(complete) };
    } catch {
      return failed(
        'CAPTURE_FINALIZE_PENDING',
        'Encrypted evidence is pending startup reconciliation.',
      );
    }
  }

  private async classifyExistingComplete(
    content: Uint8Array,
    existing: EvidenceLedgerRecord,
  ): Promise<EvidenceCaptureResult> {
    if (existing.keyVersion === null || existing.keyedContentId === null) {
      return failed(
        'CAPTURE_EXISTING_RECORD_INVALID',
        'The existing evidence receipt is missing authenticated identity metadata.',
      );
    }
    try {
      const actual = await this.options.blobStore.deriveContentId(content, existing.keyVersion);
      if (evidenceContentIdentityMatches(actual, existing.keyedContentId)) {
        return { status: 'duplicate', record: toContractRecord(existing) };
      }
      return {
        status: 'conflict',
        errorCode: 'EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT',
        disclosure: 'The logical capture key was reused for different authenticated content.',
      };
    } catch {
      return failed(
        'CAPTURE_IDENTITY_CHECK_FAILED',
        'The existing evidence identity could not be authenticated.',
      );
    }
  }

  private async failStaged(staged: EvidenceLedgerRecord): Promise<void> {
    try {
      await this.options.ledger.failEvidence({
        evidenceId: staged.id,
        conversationId: staged.conversationId,
        status: 'failed',
        updatedAt: this.now(),
      });
    } catch {
      // The caller still receives a visible capture failure. Startup maintenance
      // treats any surviving staging row as pending reconciliation.
    }
  }
}

function classifySensitivity(input: EvidenceCaptureServiceInput): EvidenceSensitivity {
  if (input.sensitivity !== 'normal') return input.sensitivity;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.content);
  } catch {
    return input.sensitivity;
  }
  return detectSecrets(decoded).length > 0 ? 'sensitive' : 'normal';
}

function truthfulCaptureMode(
  input: EvidenceCaptureServiceInput,
): EvidenceStageInput['captureMode'] {
  if (input.observedBoundary === 'provider-observed-only') return 'observed-only';
  if (input.observedBoundary === 'after-provider-retention') return 'post-retention';
  return input.captureMode;
}

function finalizeInput(
  record: EvidenceLedgerRecord,
  result: EvidenceBlobWriteResult,
  completedAt: number,
): EvidenceFinalizeInput {
  return {
    evidenceId: record.id,
    conversationId: record.conversationId,
    blobRef: result.blobRef,
    keyedContentId: result.keyedContentId,
    byteCount: result.byteCount,
    keyVersion: result.keyVersion,
    completedAt,
  };
}

function toContractRecord(record: EvidenceLedgerRecord): EvidenceRecord {
  return {
    id: record.id,
    conversationId: record.conversationId,
    provider: record.provider,
    ...(record.providerThreadRef === null ? {} : { providerThreadRef: record.providerThreadRef }),
    ...(record.turnRef === null ? {} : { turnRef: record.turnRef }),
    ...(record.toolCallRef === null ? {} : { toolCallRef: record.toolCallRef }),
    toolName: record.toolName,
    sourceKind: record.sourceKind,
    ...(record.sourceLocatorRedacted === null
      ? {}
      : { sourceLocatorRedacted: record.sourceLocatorRedacted }),
    status: record.status,
    ...(record.keyedContentId === null ? {} : { keyedContentId: record.keyedContentId }),
    byteCount: record.byteCount,
    ...(record.tokenEstimate === null ? {} : { tokenEstimate: record.tokenEstimate }),
    mimeType: record.mimeType,
    sensitivity: record.sensitivity,
    provenanceTrust: record.provenanceTrust,
    createdAt: record.createdAt,
    ...(record.completedAt === null ? {} : { completedAt: record.completedAt }),
    ...(record.keyVersion === null ? {} : { keyVersion: record.keyVersion }),
    captureMode: record.captureMode,
    captureCompleteness: record.captureCompleteness,
    ...(record.truncationReason === null ? {} : { truncationReason: record.truncationReason }),
  };
}

function contentFreeErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : fallback;
}

function failed(errorCode: string, disclosure: string): EvidenceCaptureResult {
  return { status: 'failed', errorCode, disclosure };
}
