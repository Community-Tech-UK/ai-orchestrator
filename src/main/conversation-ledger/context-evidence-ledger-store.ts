import { randomUUID } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  ContextEvidenceEventInput,
  ContextEvidenceConversationMetrics,
  ConversationEvidenceDeletionInput,
  ConversationEvidenceDeletionResult,
  EvidenceAccessLogInput,
  EvidenceCardMetadataInput,
  EvidenceCardMetadataRecord,
  EvidenceCardListQuery,
  EvidenceDeletionQueueRecord,
  EvidenceFailureInput,
  EvidenceFinalizeInput,
  EvidenceLedgerRecord,
  EvidenceListQuery,
  EvidenceBlobReferenceQuery,
  EvidenceMaintenanceQuery,
  EvidenceMetadataSearchQuery,
  EvidenceBlobReplacementInput,
  EvidenceRangeAuthorization,
  EvidenceRangeAuthorizationInput,
  EvidenceStageInput,
  LegacyMarkerCompareAndSwapInput,
  LegacyOutputCacheMarkerRecord,
} from './context-evidence-ledger.types';
import { compareAndSwapLegacyOutputMarker as compareAndSwapLegacyOutputMarkerInStore,
  listLegacyOutputCacheMarkers as listLegacyOutputCacheMarkersFromStore } from './legacy-output-cache-ledger-store';
import { evidenceDeletionRowToRecord, type EvidenceDeletionQueueRow } from './evidence-deletion-ledger-mapper';

interface EvidenceRow {
  id: string;
  conversation_id: string;
  provider: string;
  provider_thread_ref: string | null;
  provider_session_ref: string | null;
  turn_ref: string | null;
  tool_call_ref: string | null;
  tool_name: string;
  source_kind: EvidenceLedgerRecord['sourceKind'];
  source_locator_redacted: string | null;
  status: EvidenceLedgerRecord['status'];
  blob_ref: string | null;
  keyed_content_id: string | null;
  byte_count: number;
  token_estimate: number | null;
  mime_type: string;
  sensitivity: EvidenceLedgerRecord['sensitivity'];
  provenance_trust: EvidenceLedgerRecord['provenanceTrust'];
  capture_mode: EvidenceLedgerRecord['captureMode'];
  capture_completeness: EvidenceLedgerRecord['captureCompleteness'];
  truncation_reason: string | null;
  key_version: number | null;
  capture_key: string;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
}

interface EvidenceCardRow {
  id: string;
  conversation_id: string;
  evidence_id: string;
  blob_ref: string | null;
  extractor_kind: string;
  extractor_version: string;
  status: EvidenceCardMetadataRecord['status'];
  sensitivity: EvidenceCardMetadataRecord['sensitivity'];
  byte_count: number;
  token_estimate: number | null;
  created_at: number;
  updated_at: number;
}

export class ContextEvidenceLedgerStore {
  constructor(private readonly db: SqliteDriver) {}

  stageEvidence(input: EvidenceStageInput): EvidenceLedgerRecord {
    if (!this.hasLiveConversation(input.conversationId)) throw new Error('EVIDENCE_CONVERSATION_NOT_FOUND');
    const existing = this.findEvidenceByCaptureKey(input.conversationId, input.captureKey);
    if (existing) return existing;
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    this.db.prepare(`
      INSERT INTO evidence_records (
        id, conversation_id, provider, provider_thread_ref, provider_session_ref,
        turn_ref, tool_call_ref, tool_name, source_kind, source_locator_redacted,
        status, byte_count, mime_type, sensitivity, provenance_trust, capture_mode,
        capture_completeness, truncation_reason, capture_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'staging', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.conversationId, input.provider, input.providerThreadRef ?? null,
      input.providerSessionRef ?? null, input.turnRef ?? null, input.toolCallRef ?? null,
      input.toolName, input.sourceKind, input.sourceLocatorRedacted ?? null, input.mimeType,
      input.sensitivity, input.provenanceTrust, input.captureMode, input.captureCompleteness,
      input.truncationReason ?? null, input.captureKey, createdAt, createdAt,
    );
    return this.findEvidenceForMaintenance(input.conversationId, id)!;
  }

  finalizeEvidence(input: EvidenceFinalizeInput): EvidenceLedgerRecord {
    const existing = this.findEvidenceForMaintenance(input.conversationId, input.evidenceId);
    if (!existing) throw new Error('EVIDENCE_NOT_FOUND');
    if (existing.status === 'complete') {
      if (existing.keyedContentId !== input.keyedContentId) {
        throw new Error('EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT');
      }
      return existing;
    }
    if (existing.status !== 'staging') throw new Error('EVIDENCE_FINALIZE_INVALID_STATE');
    this.assertPreparedIdentityCompatible(existing, input);
    const completedAt = input.completedAt ?? Date.now();
    this.db.prepare(`
      UPDATE evidence_records
      SET status = 'complete', blob_ref = ?, keyed_content_id = ?, byte_count = ?,
          token_estimate = ?, key_version = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND conversation_id = ? AND status = 'staging'
    `).run(
      input.blobRef, input.keyedContentId, input.byteCount, input.tokenEstimate ?? null,
      input.keyVersion, completedAt, completedAt, input.evidenceId, input.conversationId,
    );
    return this.findEvidenceForMaintenance(input.conversationId, input.evidenceId)!;
  }

  prepareEvidenceBlob(input: EvidenceFinalizeInput): EvidenceLedgerRecord {
    const existing = this.findEvidenceForMaintenance(input.conversationId, input.evidenceId);
    if (!existing) throw new Error('EVIDENCE_NOT_FOUND');
    if (existing.status !== 'staging') throw new Error('EVIDENCE_PREPARE_INVALID_STATE');
    this.assertPreparedIdentityCompatible(existing, input);
    const updatedAt = input.completedAt ?? Date.now();
    this.db.prepare(`
      UPDATE evidence_records
      SET blob_ref = ?, keyed_content_id = ?, byte_count = ?, token_estimate = ?,
          key_version = ?, updated_at = ?
      WHERE id = ? AND conversation_id = ? AND status = 'staging'
    `).run(
      input.blobRef, input.keyedContentId, input.byteCount, input.tokenEstimate ?? null,
      input.keyVersion, updatedAt, input.evidenceId, input.conversationId,
    );
    return this.findEvidenceForMaintenance(input.conversationId, input.evidenceId)!;
  }

  failEvidence(input: EvidenceFailureInput): EvidenceLedgerRecord {
    const status = input.status ?? 'failed';
    const updatedAt = input.updatedAt ?? Date.now();
    const result = this.db.prepare(`
      UPDATE evidence_records SET status = ?, updated_at = ?
      WHERE id = ? AND conversation_id = ? AND status IN ('staging', 'complete')
    `).run(status, updatedAt, input.evidenceId, input.conversationId);
    if (result.changes === 0) throw new Error('EVIDENCE_NOT_FOUND_OR_INVALID_STATE');
    return this.findEvidenceForMaintenance(input.conversationId, input.evidenceId)!;
  }

  getEvidence(conversationId: string, evidenceId: string): EvidenceLedgerRecord | null {
    const row = this.db.prepare(`
      SELECT evidence_records.* FROM evidence_records
      JOIN conversation_threads ON conversation_threads.id = evidence_records.conversation_id
      WHERE evidence_records.id = ? AND evidence_records.conversation_id = ?
        AND evidence_records.status = 'complete' AND conversation_threads.deleted_at IS NULL
    `).get<EvidenceRow>(evidenceId, conversationId);
    return row ? evidenceRowToRecord(row) : null;
  }

  listEvidence(conversationId: string, query: EvidenceListQuery = {}): EvidenceLedgerRecord[] {
    const where = ['evidence_records.conversation_id = ?', 'conversation_threads.deleted_at IS NULL'];
    const params: unknown[] = [conversationId];
    if (!query.includeMaintenanceStates) where.push("evidence_records.status = 'complete'");
    if (query.turnRef !== undefined) { where.push('evidence_records.turn_ref = ?'); params.push(query.turnRef); }
    if (query.toolCallRef !== undefined) { where.push('evidence_records.tool_call_ref = ?'); params.push(query.toolCallRef); }
    if (query.sourceKind !== undefined) { where.push('evidence_records.source_kind = ?'); params.push(query.sourceKind); }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    return this.db.prepare(`
      SELECT evidence_records.* FROM evidence_records
      JOIN conversation_threads ON conversation_threads.id = evidence_records.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY evidence_records.created_at ASC, evidence_records.id ASC LIMIT ?
    `).all<EvidenceRow>(...params, limit).map(evidenceRowToRecord);
  }

  listEvidenceForMaintenance(query: EvidenceMaintenanceQuery): EvidenceLedgerRecord[] {
    const allowedStatuses = new Set<EvidenceLedgerRecord['status']>([
      'staging', 'complete', 'failed', 'corrupt', 'deleted',
    ]);
    const statuses = [...new Set(query.statuses)];
    if (statuses.length === 0 || statuses.some((status) => !allowedStatuses.has(status))) {
      throw new Error('EVIDENCE_MAINTENANCE_QUERY_INVALID');
    }
    const where = [
      `evidence_records.status IN (${statuses.map(() => '?').join(', ')})`,
      'conversation_threads.deleted_at IS NULL',
    ];
    const params: unknown[] = [...statuses];
    if (query.updatedBefore !== undefined) {
      where.push('evidence_records.updated_at <= ?');
      params.push(query.updatedBefore);
    }
    if (query.keyVersionNot !== undefined) {
      where.push('evidence_records.key_version IS NOT NULL');
      where.push('evidence_records.key_version <> ?');
      params.push(query.keyVersionNot);
    }
    if ((query.afterUpdatedAt === undefined) !== (query.afterId === undefined)) {
      throw new Error('EVIDENCE_MAINTENANCE_QUERY_INVALID');
    }
    if (query.afterUpdatedAt !== undefined && query.afterId !== undefined) {
      where.push('(evidence_records.updated_at > ? OR (evidence_records.updated_at = ? AND evidence_records.id > ?))');
      params.push(query.afterUpdatedAt, query.afterUpdatedAt, query.afterId);
    }
    const limit = Math.max(1, Math.min(query.limit, 1000));
    return this.db.prepare(`
      SELECT evidence_records.* FROM evidence_records
      JOIN conversation_threads ON conversation_threads.id = evidence_records.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY evidence_records.updated_at ASC, evidence_records.id ASC LIMIT ?
    `).all<EvidenceRow>(...params, limit).map(evidenceRowToRecord);
  }

  listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): string[] {
    const limit = Math.max(1, Math.min(query.limit, 1000));
    const cursor = query.afterBlobRef;
    return this.db.prepare(`
      SELECT blob_ref FROM (
        SELECT evidence_records.blob_ref AS blob_ref
        FROM evidence_records
        JOIN conversation_threads
          ON conversation_threads.id = evidence_records.conversation_id
        WHERE evidence_records.blob_ref IS NOT NULL
          AND evidence_records.status <> 'deleted'
          AND conversation_threads.deleted_at IS NULL
        UNION
        SELECT evidence_cards.blob_ref AS blob_ref
        FROM evidence_cards
        JOIN conversation_threads
          ON conversation_threads.id = evidence_cards.conversation_id
        WHERE evidence_cards.blob_ref IS NOT NULL
          AND conversation_threads.deleted_at IS NULL
        UNION
        SELECT blob_ref FROM evidence_deletion_queue
        WHERE completed_at IS NULL
      ) AS referenced_blobs
      WHERE (? IS NULL OR blob_ref > ?)
      ORDER BY blob_ref ASC LIMIT ?
    `).all<{ blob_ref: string }>(cursor ?? null, cursor ?? null, limit)
      .map((row) => row.blob_ref);
  }

  replaceEvidenceBlob(input: EvidenceBlobReplacementInput): boolean {
    if (
      !/^[a-f0-9]{64}$/.test(input.keyedContentId)
      || !Number.isSafeInteger(input.byteCount)
      || input.byteCount < 0
      || !Number.isSafeInteger(input.keyVersion)
      || input.keyVersion < 1
      || !Number.isSafeInteger(input.cleanupGraceDeadline)
      || input.cleanupGraceDeadline < 0
    ) {
      throw new Error('EVIDENCE_REPLACEMENT_INVALID');
    }
    return this.db.transaction(() => {
      const replaced = this.db.prepare(`
        UPDATE evidence_records
        SET blob_ref = ?, keyed_content_id = ?, byte_count = ?, token_estimate = ?,
            key_version = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND conversation_id = ? AND status = 'complete'
          AND blob_ref = ? AND key_version = ?
          AND EXISTS (
            SELECT 1 FROM conversation_threads
            WHERE conversation_threads.id = evidence_records.conversation_id
              AND conversation_threads.deleted_at IS NULL
          )
      `).run(
        input.blobRef, input.keyedContentId, input.byteCount, input.tokenEstimate ?? null,
        input.keyVersion, input.completedAt ?? input.updatedAt, input.updatedAt,
        input.evidenceId, input.conversationId, input.expectedBlobRef, input.expectedKeyVersion,
      ).changes === 1;
      if (!replaced) return false;
      this.db.prepare(`
        INSERT OR IGNORE INTO evidence_deletion_queue (
          id, conversation_id, evidence_id, blob_ref, grace_deadline, attempts,
          next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        randomUUID(), input.conversationId, input.evidenceId, input.expectedBlobRef,
        input.cleanupGraceDeadline, input.cleanupGraceDeadline, input.updatedAt,
      );
      return true;
    })();
  }

  searchEvidenceMetadata(
    conversationId: string,
    query: EvidenceMetadataSearchQuery,
  ): EvidenceLedgerRecord[] {
    const where = [
      'evidence_records.conversation_id = ?',
      "evidence_records.status = 'complete'",
      'conversation_threads.deleted_at IS NULL',
    ];
    const params: unknown[] = [conversationId];
    if (query.text !== undefined) {
      const text = query.text.trim();
      if (!text || text.length > 200) throw new Error('EVIDENCE_SEARCH_QUERY_INVALID');
      const pattern = `%${escapeLikePattern(text)}%`;
      where.push(`(
        evidence_records.tool_name LIKE ? ESCAPE '\\' OR
        COALESCE(evidence_records.source_locator_redacted, '') LIKE ? ESCAPE '\\'
      )`);
      params.push(pattern, pattern);
    }
    if (query.toolName !== undefined) { where.push('evidence_records.tool_name = ?'); params.push(query.toolName); }
    if (query.turnRef !== undefined) { where.push('evidence_records.turn_ref = ?'); params.push(query.turnRef); }
    if (query.sourceKind !== undefined) { where.push('evidence_records.source_kind = ?'); params.push(query.sourceKind); }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    return this.db.prepare(`
      SELECT evidence_records.* FROM evidence_records
      JOIN conversation_threads ON conversation_threads.id = evidence_records.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY evidence_records.created_at DESC, evidence_records.id ASC LIMIT ?
    `).all<EvidenceRow>(...params, limit).map(evidenceRowToRecord);
  }

  authorizeEvidenceRange(input: EvidenceRangeAuthorizationInput): EvidenceRangeAuthorization {
    if (
      !Number.isSafeInteger(input.startByte)
      || !Number.isSafeInteger(input.endByte)
      || input.startByte < 0
      || input.endByte <= input.startByte
    ) {
      return { authorized: false, reason: 'invalid-range' };
    }
    const record = this.getEvidence(input.conversationId, input.evidenceId);
    if (
      !record
      || record.blobRef === null
      || record.keyedContentId === null
      || record.keyVersion === null
    ) {
      return { authorized: false, reason: 'not-found' };
    }
    if (input.endByte > record.byteCount) {
      return { authorized: false, reason: 'range-out-of-bounds' };
    }
    return {
      authorized: true,
      conversationId: input.conversationId,
      evidenceId: input.evidenceId,
      startByte: input.startByte,
      endByte: input.endByte,
      byteCount: record.byteCount,
      blobRef: record.blobRef,
      keyedContentId: record.keyedContentId,
      keyVersion: record.keyVersion,
      sensitivity: record.sensitivity,
      captureCompleteness: record.captureCompleteness,
      truncationReason: record.truncationReason,
    };
  }

  storeEvidenceCard(input: EvidenceCardMetadataInput): EvidenceCardMetadataRecord {
    if (!this.getEvidence(input.conversationId, input.evidenceId)) throw new Error('EVIDENCE_NOT_FOUND');
    if (!Number.isSafeInteger(input.cleanupGraceDeadline) || input.cleanupGraceDeadline < 0) {
      throw new Error('EVIDENCE_CARD_CLEANUP_DEADLINE_INVALID');
    }
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();
    return this.db.transaction(() => {
      const previous = this.db.prepare(`
        SELECT blob_ref FROM evidence_cards
        WHERE conversation_id = ? AND evidence_id = ?
          AND extractor_kind = ? AND extractor_version = ?
      `).get<{ blob_ref: string | null }>(input.conversationId, input.evidenceId,
        input.extractorKind, input.extractorVersion);
      this.db.prepare(`
        INSERT INTO evidence_cards (
          id, conversation_id, evidence_id, blob_ref, extractor_kind, extractor_version,
          status, sensitivity, byte_count, token_estimate, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, evidence_id, extractor_kind, extractor_version)
        DO UPDATE SET id = excluded.id, blob_ref = excluded.blob_ref, status = excluded.status,
          sensitivity = excluded.sensitivity, byte_count = excluded.byte_count,
          token_estimate = excluded.token_estimate, created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(
        id, input.conversationId, input.evidenceId, input.blobRef ?? null, input.extractorKind,
        input.extractorVersion, input.status, input.sensitivity, input.byteCount,
        input.tokenEstimate ?? null, createdAt, createdAt,
      );
      if (previous?.blob_ref && previous.blob_ref !== (input.blobRef ?? null)) {
        this.db.prepare(`
          INSERT OR IGNORE INTO evidence_deletion_queue (
            id, conversation_id, evidence_id, blob_ref, grace_deadline, attempts,
            next_attempt_at, created_at
          ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
        `).run(
          randomUUID(), input.conversationId, input.evidenceId, previous.blob_ref,
          input.cleanupGraceDeadline, input.cleanupGraceDeadline, createdAt,
        );
      }
      const row = this.db.prepare(`SELECT * FROM evidence_cards
        WHERE conversation_id = ? AND evidence_id = ? AND extractor_kind = ? AND extractor_version = ?`
      ).get<EvidenceCardRow>(input.conversationId, input.evidenceId,
        input.extractorKind, input.extractorVersion);
      if (!row) throw new Error('EVIDENCE_CARD_WRITE_FAILED');
      return evidenceCardRowToRecord(row);
    })();
  }
  getEvidenceCard(conversationId: string, cardId: string): EvidenceCardMetadataRecord | null {
    const row = this.db.prepare(`
      SELECT evidence_cards.* FROM evidence_cards
      JOIN conversation_threads ON conversation_threads.id = evidence_cards.conversation_id
      JOIN evidence_records ON evidence_records.id = evidence_cards.evidence_id
        AND evidence_records.conversation_id = evidence_cards.conversation_id
      WHERE evidence_cards.id = ? AND evidence_cards.conversation_id = ?
        AND conversation_threads.deleted_at IS NULL AND evidence_records.status = 'complete'
    `).get<EvidenceCardRow>(cardId, conversationId);
    return row ? evidenceCardRowToRecord(row) : null;
  }

  listEvidenceCards(
    conversationId: string,
    query: EvidenceCardListQuery = {},
  ): EvidenceCardMetadataRecord[] {
    const where = [
      'evidence_cards.conversation_id = ?',
      'conversation_threads.deleted_at IS NULL',
      "evidence_records.status = 'complete'",
    ];
    const params: unknown[] = [conversationId];
    if (query.evidenceId !== undefined) {
      where.push('evidence_cards.evidence_id = ?');
      params.push(query.evidenceId);
    }
    const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
    return this.db.prepare(`
      SELECT evidence_cards.* FROM evidence_cards
      JOIN conversation_threads ON conversation_threads.id = evidence_cards.conversation_id
      JOIN evidence_records ON evidence_records.id = evidence_cards.evidence_id
        AND evidence_records.conversation_id = evidence_cards.conversation_id
      WHERE ${where.join(' AND ')}
      ORDER BY evidence_cards.created_at DESC, evidence_cards.id ASC LIMIT ?
    `).all<EvidenceCardRow>(...params, limit).map(evidenceCardRowToRecord);
  }

  getConversationMetrics(conversationId: string): ContextEvidenceConversationMetrics {
    const aggregate = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM evidence_records
          WHERE conversation_id = conversation_threads.id AND status = 'complete')
          AS evidence_record_count,
        (SELECT COUNT(*) FROM evidence_cards
          WHERE conversation_id = conversation_threads.id) AS evidence_card_count,
        COALESCE((SELECT SUM(byte_count) FROM evidence_records
          WHERE conversation_id = conversation_threads.id AND status = 'complete'), 0)
          + COALESCE((SELECT SUM(byte_count) FROM evidence_cards
            WHERE conversation_id = conversation_threads.id), 0) AS externally_stored_bytes,
        (SELECT COUNT(DISTINCT tool_call_ref) FROM evidence_records
          WHERE conversation_id = conversation_threads.id AND status = 'complete'
            AND tool_call_ref IS NOT NULL) AS tool_call_count,
        COALESCE((SELECT SUM(byte_count) FROM evidence_records
          WHERE conversation_id = conversation_threads.id AND status = 'complete' AND tool_call_ref IS NOT NULL), 0)
          AS tool_result_bytes
      FROM conversation_threads
      WHERE conversation_threads.id = ? AND conversation_threads.deleted_at IS NULL
    `).get<{
      evidence_record_count: number;
      evidence_card_count: number;
      externally_stored_bytes: number;
      tool_call_count: number;
      tool_result_bytes: number;
    }>(conversationId) ?? {
      evidence_record_count: 0,
      evidence_card_count: 0,
      externally_stored_bytes: 0,
      tool_call_count: 0,
      tool_result_bytes: 0,
    };
    const latest = this.db.prepare(`
      SELECT action_code, recovery_epoch FROM context_evidence_events
      WHERE conversation_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get<{ action_code: string | null; recovery_epoch: number }>(conversationId);
    const recovery = this.db.prepare(`
      SELECT COALESCE(MAX(recovery_epoch), 0) AS recovery_count
      FROM context_evidence_events WHERE conversation_id = ?
    `).get<{ recovery_count: number }>(conversationId);
    return {
      evidenceRecordCount: aggregate.evidence_record_count,
      evidenceCardCount: aggregate.evidence_card_count,
      externallyStoredBytes: aggregate.externally_stored_bytes,
      toolCallCount: aggregate.tool_call_count,
      toolResultBytes: aggregate.tool_result_bytes,
      lastActionCode: latest?.action_code ?? null,
      recoveryCount: recovery?.recovery_count ?? 0,
    };
  }

  logEvidenceAccess(input: EvidenceAccessLogInput): void {
    this.db.prepare(`
      INSERT INTO evidence_access_log (
        id, requester, conversation_id, operation, evidence_ids_json,
        requested_ranges_json, outcome_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id ?? randomUUID(), input.requester, input.conversationId, input.operation,
      JSON.stringify(input.evidenceIds ?? []), JSON.stringify(input.requestedRanges ?? []),
      input.outcomeCode, input.createdAt ?? Date.now(),
    );
  }

  recordContextEvidenceEvent(input: ContextEvidenceEventInput): void {
    this.db.prepare(`
      INSERT INTO context_evidence_events (
        id, conversation_id, provider, event_kind, recovery_epoch, threshold_code,
        action_code, proof_stage, occupancy_used, occupancy_total, cumulative_tokens,
        output_bytes, provider_request_count, new_evidence_count, new_finding_count,
        failure_code, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id ?? randomUUID(), input.conversationId, input.provider ?? null, input.eventKind,
      input.recoveryEpoch, input.thresholdCode ?? null, input.actionCode ?? null,
      input.proofStage ?? null, input.occupancyUsed ?? null, input.occupancyTotal ?? null,
      input.cumulativeTokens ?? null, input.outputBytes, input.providerRequestCount,
      input.newEvidenceCount, input.newFindingCount, input.failureCode ?? null,
      input.durationMs ?? null, input.createdAt ?? Date.now(),
    );
  }

  softDeleteConversationWithEvidence(
    input: ConversationEvidenceDeletionInput,
  ): ConversationEvidenceDeletionResult {
    return this.db.transaction(() => {
      const thread = this.db.prepare('SELECT deleted_at FROM conversation_threads WHERE id = ?')
        .get<{ deleted_at: string | null }>(input.conversationId);
      if (!thread) throw new Error('CONVERSATION_NOT_FOUND');
      if (thread.deleted_at !== null) {
        return { conversationId: input.conversationId, queuedBlobCount: 0, alreadyDeleted: true };
      }
      const blobs = this.db.prepare(`
        SELECT id AS evidence_id, blob_ref FROM evidence_records
        WHERE conversation_id = ? AND blob_ref IS NOT NULL
        UNION ALL
        SELECT evidence_id, blob_ref FROM evidence_cards
        WHERE conversation_id = ? AND blob_ref IS NOT NULL
      `).all<{ evidence_id: string; blob_ref: string }>(input.conversationId, input.conversationId);
      const enqueue = this.db.prepare(`
        INSERT OR IGNORE INTO evidence_deletion_queue (
          id, conversation_id, evidence_id, blob_ref, grace_deadline, attempts,
          next_attempt_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `);
      const now = Date.now();
      let queuedBlobCount = 0;
      for (const blob of blobs) {
        queuedBlobCount += enqueue.run(
          randomUUID(), input.conversationId, blob.evidence_id, blob.blob_ref,
          input.graceDeadline, input.graceDeadline, now,
        ).changes;
      }
      this.db.prepare("UPDATE evidence_records SET status = 'deleted', updated_at = ? WHERE conversation_id = ?")
        .run(now, input.conversationId);
      this.db.prepare('DELETE FROM conversation_messages WHERE thread_id = ?').run(input.conversationId);
      this.db.prepare('DELETE FROM conversation_checkpoints WHERE thread_id = ?').run(input.conversationId);
      this.db.prepare('DELETE FROM conversation_sync_cursors WHERE thread_id = ?').run(input.conversationId);
      this.db.prepare('DELETE FROM conversation_memory_links WHERE thread_id = ?').run(input.conversationId);
      this.db.prepare('UPDATE conversation_threads SET deleted_at = ?, updated_at = ? WHERE id = ?')
        .run(input.deletedAt, now, input.conversationId);
      return { conversationId: input.conversationId, queuedBlobCount, alreadyDeleted: false };
    })();
  }

  claimEvidenceDeletions(
    now: number,
    limit: number,
    leaseMs = 60_000,
  ): EvidenceDeletionQueueRecord[] {
    const bounded = Math.max(1, Math.min(limit, 100));
    const boundedLeaseMs = Math.max(1_000, Math.min(leaseMs, 600_000));
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM evidence_deletion_queue
        WHERE completed_at IS NULL AND grace_deadline <= ? AND next_attempt_at <= ?
          AND (claim_token IS NULL OR claimed_until <= ?)
        ORDER BY grace_deadline ASC, id ASC LIMIT ?
      `).all<EvidenceDeletionQueueRow>(now, now, now, bounded);
      const claimed: EvidenceDeletionQueueRecord[] = [];
      const claim = this.db.prepare(`
        UPDATE evidence_deletion_queue
        SET attempts = attempts + 1, claim_token = ?, claimed_until = ?
        WHERE id = ? AND completed_at IS NULL AND next_attempt_at <= ?
          AND (claim_token IS NULL OR claimed_until <= ?)
      `);
      for (const row of rows) {
        const claimToken = randomUUID();
        const claimedUntil = now + boundedLeaseMs;
        if (claim.run(claimToken, claimedUntil, row.id, now, now).changes !== 1) continue;
        claimed.push(evidenceDeletionRowToRecord({
          ...row,
          attempts: row.attempts + 1,
          claim_token: claimToken,
          claimed_until: claimedUntil,
        }));
      }
      return claimed;
    })();
  }

  completeEvidenceDeletion(id: string, claimToken: string, completedAt: number): boolean {
    return this.db.prepare(`
      UPDATE evidence_deletion_queue
      SET completed_at = ?, last_error_code = NULL, claim_token = NULL, claimed_until = NULL
      WHERE id = ? AND claim_token = ? AND completed_at IS NULL
    `).run(completedAt, id, claimToken).changes === 1;
  }

  failEvidenceDeletion(
    id: string,
    claimToken: string,
    errorCode: string,
    retryAt: number,
  ): boolean {
    return this.db.prepare(`
      UPDATE evidence_deletion_queue
      SET last_error_code = ?, next_attempt_at = ?, claim_token = NULL, claimed_until = NULL
      WHERE id = ? AND claim_token = ? AND completed_at IS NULL
    `).run(errorCode, retryAt, id, claimToken).changes === 1;
  }

  compareAndSwapLegacyOutputMarker(input: LegacyMarkerCompareAndSwapInput): boolean {
    return compareAndSwapLegacyOutputMarkerInStore(
      this.db,
      input,
      (conversationId, evidenceId) => this.getEvidence(conversationId, evidenceId),
    );
  }

  listLegacyOutputCacheMarkers(): LegacyOutputCacheMarkerRecord[] {
    return listLegacyOutputCacheMarkersFromStore(this.db);
  }

  private assertPreparedIdentityCompatible(
    existing: EvidenceLedgerRecord,
    input: EvidenceFinalizeInput,
  ): void {
    if (
      (existing.blobRef !== null && existing.blobRef !== input.blobRef)
      || (existing.keyedContentId !== null && existing.keyedContentId !== input.keyedContentId)
      || (existing.keyVersion !== null && existing.keyVersion !== input.keyVersion)
      || (existing.byteCount !== 0 && existing.byteCount !== input.byteCount)
    ) {
      throw new Error('EVIDENCE_CAPTURE_KEY_CONTENT_CONFLICT');
    }
  }

  private hasLiveConversation(conversationId: string): boolean {
    return this.db.prepare('SELECT 1 AS present FROM conversation_threads WHERE id = ? AND deleted_at IS NULL')
      .get<{ present: number }>(conversationId) !== undefined;
  }

  private findEvidenceByCaptureKey(conversationId: string, captureKey: string): EvidenceLedgerRecord | null {
    const row = this.db.prepare('SELECT * FROM evidence_records WHERE conversation_id = ? AND capture_key = ?')
      .get<EvidenceRow>(conversationId, captureKey);
    return row ? evidenceRowToRecord(row) : null;
  }

  private findEvidenceForMaintenance(conversationId: string, evidenceId: string): EvidenceLedgerRecord | null {
    const row = this.db.prepare('SELECT * FROM evidence_records WHERE conversation_id = ? AND id = ?')
      .get<EvidenceRow>(conversationId, evidenceId);
    return row ? evidenceRowToRecord(row) : null;
  }
}

function evidenceRowToRecord(row: EvidenceRow): EvidenceLedgerRecord {
  return {
    id: row.id, conversationId: row.conversation_id, provider: row.provider,
    providerThreadRef: row.provider_thread_ref, providerSessionRef: row.provider_session_ref,
    turnRef: row.turn_ref, toolCallRef: row.tool_call_ref, toolName: row.tool_name,
    sourceKind: row.source_kind, sourceLocatorRedacted: row.source_locator_redacted,
    status: row.status, blobRef: row.blob_ref, keyedContentId: row.keyed_content_id,
    byteCount: row.byte_count, tokenEstimate: row.token_estimate, mimeType: row.mime_type,
    sensitivity: row.sensitivity, provenanceTrust: row.provenance_trust,
    captureMode: row.capture_mode, captureCompleteness: row.capture_completeness,
    truncationReason: row.truncation_reason, keyVersion: row.key_version,
    captureKey: row.capture_key, createdAt: row.created_at, completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

function evidenceCardRowToRecord(row: EvidenceCardRow): EvidenceCardMetadataRecord {
  return {
    id: row.id, conversationId: row.conversation_id, evidenceId: row.evidence_id,
    blobRef: row.blob_ref, extractorKind: row.extractor_kind,
    extractorVersion: row.extractor_version, status: row.status, sensitivity: row.sensitivity,
    byteCount: row.byte_count, tokenEstimate: row.token_estimate, createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}
