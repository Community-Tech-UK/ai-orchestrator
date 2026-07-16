/**
 * In-memory conversation-ledger fake for the Task 18 governed incident replay.
 *
 * Implements the narrow ledger surfaces consumed by EvidenceCaptureService,
 * EvidenceCardService, EvidenceRetrievalService, EvidenceMaintenanceService,
 * and EvidenceDeletionService — the same idiom already used by every other
 * context-evidence spec in this directory (vi.fn() ledger doubles), just
 * durable enough across the "same instance, new services" restart-simulation
 * used by the replay. It is deliberately NOT SQLite-backed: the replay proves
 * the crypto/capture/retrieval pipeline against a real temp-dir blob store,
 * not the ledger SQL layer (covered separately by conversation-ledger specs).
 */
import { randomUUID } from 'node:crypto';
import type {
  ConversationEvidenceDeletionInput,
  ConversationEvidenceDeletionResult,
  EvidenceAccessLogInput,
  EvidenceBlobReferenceQuery,
  EvidenceBlobReplacementInput,
  EvidenceCardListQuery,
  EvidenceCardMetadataInput,
  EvidenceCardMetadataRecord,
  EvidenceDeletionQueueRecord,
  EvidenceFailureInput,
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceListQuery,
  EvidenceMaintenanceQuery,
  EvidenceStageInput,
} from '../../conversation-ledger/context-evidence-ledger.types';

const READABLE_DEFAULT_STATUSES = new Set<EvidenceLedgerRecord['status']>(['complete']);

/** Deterministic, inspectable in-memory stand-in for the real evidence ledger tables. */
export class InMemoryEvidenceLedger {
  private readonly records = new Map<string, EvidenceLedgerRecord>();
  private readonly byCaptureKey = new Map<string, string>();
  private readonly cards = new Map<string, EvidenceCardMetadataRecord>();
  readonly accessLog: EvidenceAccessLogInput[] = [];
  private readonly deletionQueue = new Map<string, EvidenceDeletionQueueRecord>();
  private readonly deletedConversations = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  // -- capture -------------------------------------------------------------

  async stageEvidence(input: EvidenceStageInput): Promise<EvidenceLedgerRecord> {
    const key = captureKeyOf(input.conversationId, input.captureKey);
    const existingId = this.byCaptureKey.get(key);
    if (existingId) return this.records.get(existingId)!;

    const createdAt = input.createdAt ?? this.now();
    const record: EvidenceLedgerRecord = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      provider: input.provider,
      providerThreadRef: input.providerThreadRef ?? null,
      providerSessionRef: input.providerSessionRef ?? null,
      turnRef: input.turnRef ?? null,
      toolCallRef: input.toolCallRef ?? null,
      toolName: input.toolName,
      sourceKind: input.sourceKind,
      sourceLocatorRedacted: input.sourceLocatorRedacted ?? null,
      status: 'staging',
      blobRef: null,
      keyedContentId: null,
      byteCount: 0,
      tokenEstimate: null,
      mimeType: input.mimeType,
      sensitivity: input.sensitivity,
      provenanceTrust: input.provenanceTrust,
      captureMode: input.captureMode,
      captureCompleteness: input.captureCompleteness,
      truncationReason: input.truncationReason ?? null,
      keyVersion: null,
      captureKey: input.captureKey,
      createdAt,
      completedAt: null,
      updatedAt: createdAt,
    };
    this.records.set(record.id, record);
    this.byCaptureKey.set(key, record.id);
    return record;
  }

  async prepareEvidenceBlob(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord> {
    const record = this.requireRecord(input.evidenceId, input.conversationId);
    const updated: EvidenceLedgerRecord = {
      ...record,
      blobRef: input.blobRef,
      keyedContentId: input.keyedContentId,
      byteCount: input.byteCount,
      tokenEstimate: input.tokenEstimate ?? record.tokenEstimate,
      keyVersion: input.keyVersion,
      updatedAt: this.now(),
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  async finalizeEvidence(input: EvidenceFinalizeInput): Promise<EvidenceLedgerRecord> {
    const prepared = await this.prepareEvidenceBlob(input);
    const completed: EvidenceLedgerRecord = {
      ...prepared,
      status: 'complete',
      completedAt: input.completedAt ?? this.now(),
      updatedAt: this.now(),
    };
    this.records.set(completed.id, completed);
    return completed;
  }

  async failEvidence(input: EvidenceFailureInput): Promise<EvidenceLedgerRecord> {
    const record = this.requireRecord(input.evidenceId, input.conversationId);
    const updated: EvidenceLedgerRecord = {
      ...record,
      status: input.status ?? 'failed',
      updatedAt: input.updatedAt ?? this.now(),
    };
    this.records.set(updated.id, updated);
    return updated;
  }

  // -- reads / cards ---------------------------------------------------------

  async getEvidence(conversationId: string, evidenceId: string): Promise<EvidenceLedgerRecord | null> {
    const record = this.records.get(evidenceId);
    return record && record.conversationId === conversationId ? record : null;
  }

  /** Cross-conversation lookup used only by the replay's accuracy-gate verifier. */
  findRecordById(evidenceId: string): EvidenceLedgerRecord | undefined {
    return this.records.get(evidenceId);
  }

  async listEvidence(conversationId: string, query: EvidenceListQuery = {}): Promise<EvidenceLedgerRecord[]> {
    const allowedStatuses = query.includeMaintenanceStates
      ? undefined
      : READABLE_DEFAULT_STATUSES;
    const rows = [...this.records.values()]
      .filter((record) => record.conversationId === conversationId)
      .filter((record) => !allowedStatuses || allowedStatuses.has(record.status))
      .filter((record) => !query.turnRef || record.turnRef === query.turnRef)
      .filter((record) => !query.toolCallRef || record.toolCallRef === query.toolCallRef)
      .filter((record) => !query.sourceKind || record.sourceKind === query.sourceKind)
      .sort((left, right) => left.createdAt - right.createdAt);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }

  async storeEvidenceCard(input: EvidenceCardMetadataInput): Promise<EvidenceCardMetadataRecord> {
    const createdAt = input.createdAt ?? this.now();
    const record: EvidenceCardMetadataRecord = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      evidenceId: input.evidenceId,
      blobRef: input.blobRef ?? null,
      extractorKind: input.extractorKind,
      extractorVersion: input.extractorVersion,
      status: input.status,
      sensitivity: input.sensitivity,
      byteCount: input.byteCount,
      tokenEstimate: input.tokenEstimate ?? null,
      createdAt,
      updatedAt: createdAt,
    };
    this.cards.set(record.id, record);
    return record;
  }

  async listEvidenceCards(
    conversationId: string,
    query: EvidenceCardListQuery = {},
  ): Promise<EvidenceCardMetadataRecord[]> {
    const rows = [...this.cards.values()]
      .filter((card) => card.conversationId === conversationId)
      .filter((card) => !query.evidenceId || card.evidenceId === query.evidenceId)
      .sort((left, right) => left.createdAt - right.createdAt);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }

  async getEvidenceCard(
    conversationId: string,
    cardId: string,
  ): Promise<EvidenceCardMetadataRecord | null> {
    const card = this.cards.get(cardId);
    return card && card.conversationId === conversationId ? card : null;
  }

  async logEvidenceAccess(input: EvidenceAccessLogInput): Promise<void> {
    this.accessLog.push({ ...input, createdAt: input.createdAt ?? this.now() });
  }

  // -- maintenance -----------------------------------------------------------

  async listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): Promise<EvidenceLedgerRecord[]> {
    const statuses = new Set(query.statuses);
    const rows = [...this.records.values()]
      .filter((record) => statuses.has(record.status))
      .filter((record) => query.keyVersionNot === undefined || record.keyVersion !== query.keyVersionNot)
      .filter((record) => query.updatedBefore === undefined || record.updatedAt < query.updatedBefore)
      .filter((record) => !isBeforeCursor(record, query.afterUpdatedAt, query.afterId))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id));
    return rows.slice(0, query.limit);
  }

  async listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): Promise<string[]> {
    const refs = [...this.records.values()]
      .filter((record) => record.status !== 'deleted' && record.blobRef !== null)
      .map((record) => record.blobRef!)
      .sort();
    const startIndex = query.afterBlobRef
      ? refs.findIndex((ref) => ref > query.afterBlobRef!)
      : 0;
    return refs.slice(Math.max(0, startIndex), Math.max(0, startIndex) + query.limit);
  }

  async replaceEvidenceBlob(input: EvidenceBlobReplacementInput): Promise<boolean> {
    const record = this.records.get(input.evidenceId);
    if (
      !record
      || record.conversationId !== input.conversationId
      || record.blobRef !== input.expectedBlobRef
      || record.keyVersion !== input.expectedKeyVersion
    ) {
      return false;
    }
    this.records.set(record.id, {
      ...record,
      blobRef: input.blobRef,
      keyedContentId: input.keyedContentId,
      byteCount: input.byteCount,
      keyVersion: input.keyVersion,
      completedAt: input.completedAt ?? record.completedAt,
      updatedAt: input.updatedAt,
    });
    return true;
  }

  // -- deletion ----------------------------------------------------------------

  async softDeleteConversationWithEvidence(
    input: ConversationEvidenceDeletionInput,
  ): Promise<ConversationEvidenceDeletionResult> {
    if (this.deletedConversations.has(input.conversationId)) {
      return { conversationId: input.conversationId, queuedBlobCount: 0, alreadyDeleted: true };
    }
    this.deletedConversations.add(input.conversationId);
    const now = this.now();
    let queuedBlobCount = 0;
    for (const record of this.records.values()) {
      if (record.conversationId !== input.conversationId || record.status === 'deleted') continue;
      if (record.blobRef) {
        this.enqueueDeletion(input.conversationId, record.id, record.blobRef, input.graceDeadline, now);
        queuedBlobCount += 1;
      }
      this.records.set(record.id, { ...record, status: 'deleted', updatedAt: now });
    }
    for (const card of this.cards.values()) {
      if (card.conversationId !== input.conversationId || !card.blobRef) continue;
      this.enqueueDeletion(input.conversationId, null, card.blobRef, input.graceDeadline, now);
      queuedBlobCount += 1;
    }
    return { conversationId: input.conversationId, queuedBlobCount, alreadyDeleted: false };
  }

  async claimEvidenceDeletions(
    now: number,
    limit: number,
    leaseMs = 60_000,
  ): Promise<EvidenceDeletionQueueRecord[]> {
    const claimable = [...this.deletionQueue.values()]
      .filter((row) => row.completedAt === null)
      .filter((row) => row.claimedUntil === null || row.claimedUntil <= now)
      .filter((row) => row.nextAttemptAt <= now)
      .slice(0, limit);
    const claimed: EvidenceDeletionQueueRecord[] = [];
    for (const row of claimable) {
      const updated: EvidenceDeletionQueueRecord = {
        ...row,
        claimToken: randomUUID(),
        claimedUntil: now + leaseMs,
      };
      this.deletionQueue.set(updated.id, updated);
      claimed.push(updated);
    }
    return claimed;
  }

  async completeEvidenceDeletion(id: string, claimToken: string, completedAt: number): Promise<boolean> {
    const row = this.deletionQueue.get(id);
    if (!row || !row.claimToken || row.claimToken !== claimToken) return false;
    this.deletionQueue.set(id, { ...row, completedAt, claimToken: null, claimedUntil: null });
    return true;
  }

  async failEvidenceDeletion(
    id: string,
    claimToken: string,
    errorCode: string,
    retryAt: number,
  ): Promise<boolean> {
    const row = this.deletionQueue.get(id);
    if (!row || !row.claimToken || row.claimToken !== claimToken) return false;
    this.deletionQueue.set(id, {
      ...row,
      attempts: row.attempts + 1,
      lastErrorCode: errorCode,
      nextAttemptAt: retryAt,
      claimToken: null,
      claimedUntil: null,
    });
    return true;
  }

  // -- test-only inspection helpers --------------------------------------------

  allRecords(): EvidenceLedgerRecord[] {
    return [...this.records.values()];
  }

  deletionQueueSnapshot(): EvidenceDeletionQueueRecord[] {
    return [...this.deletionQueue.values()];
  }

  private enqueueDeletion(
    conversationId: string,
    evidenceId: string | null,
    blobRef: string,
    graceDeadline: number,
    now: number,
  ): void {
    const row: EvidenceDeletionQueueRecord = {
      id: randomUUID(),
      conversationId,
      evidenceId,
      blobRef,
      graceDeadline,
      attempts: 0,
      claimToken: null,
      claimedUntil: null,
      nextAttemptAt: 0,
      lastErrorCode: null,
      completedAt: null,
      createdAt: now,
    };
    this.deletionQueue.set(row.id, row);
  }

  private requireRecord(evidenceId: string, conversationId: string): EvidenceLedgerRecord {
    const record = this.records.get(evidenceId);
    if (!record || record.conversationId !== conversationId) {
      throw new Error('INCIDENT_REPLAY_LEDGER_RECORD_NOT_FOUND');
    }
    return record;
  }
}

function captureKeyOf(conversationId: string, captureKey: string): string {
  return `${conversationId} ${captureKey}`;
}

function isBeforeCursor(record: EvidenceLedgerRecord, afterUpdatedAt?: number, afterId?: string): boolean {
  if (afterUpdatedAt === undefined) return false;
  if (record.updatedAt < afterUpdatedAt) return true;
  if (record.updatedAt > afterUpdatedAt) return false;
  return afterId !== undefined && record.id.localeCompare(afterId) <= 0;
}
