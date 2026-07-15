export type EvidenceStatus = 'staging' | 'complete' | 'failed' | 'corrupt' | 'deleted';
export type EvidenceSourceKind = 'command' | 'file' | 'database' | 'web' | 'mcp' | 'browser' | 'other';
export type EvidenceSensitivity = 'normal' | 'sensitive' | 'restricted';
export type EvidenceProvenanceTrust = 'runtime-authenticated' | 'legacy-unverified';
export type EvidenceCaptureMode = 'pre-retention' | 'post-retention' | 'observed-only';
export type EvidenceCaptureCompleteness = 'complete' | 'bounded' | 'metadata-only';

export interface EvidenceLedgerRecord {
  id: string;
  conversationId: string;
  provider: string;
  providerThreadRef: string | null;
  providerSessionRef: string | null;
  turnRef: string | null;
  toolCallRef: string | null;
  toolName: string;
  sourceKind: EvidenceSourceKind;
  sourceLocatorRedacted: string | null;
  status: EvidenceStatus;
  blobRef: string | null;
  keyedContentId: string | null;
  byteCount: number;
  tokenEstimate: number | null;
  mimeType: string;
  sensitivity: EvidenceSensitivity;
  provenanceTrust: EvidenceProvenanceTrust;
  captureMode: EvidenceCaptureMode;
  captureCompleteness: EvidenceCaptureCompleteness;
  truncationReason: string | null;
  keyVersion: number | null;
  captureKey: string;
  createdAt: number;
  completedAt: number | null;
  updatedAt: number;
}

export interface EvidenceStageInput {
  id?: string;
  conversationId: string;
  provider: string;
  providerThreadRef?: string | null;
  providerSessionRef?: string | null;
  turnRef?: string | null;
  toolCallRef?: string | null;
  toolName: string;
  sourceKind: EvidenceSourceKind;
  sourceLocatorRedacted?: string | null;
  mimeType: string;
  sensitivity: EvidenceSensitivity;
  provenanceTrust: EvidenceProvenanceTrust;
  captureMode: EvidenceCaptureMode;
  captureCompleteness: EvidenceCaptureCompleteness;
  truncationReason?: string | null;
  captureKey: string;
  createdAt?: number;
}

export interface EvidenceFinalizeInput {
  evidenceId: string;
  conversationId: string;
  blobRef: string;
  keyedContentId: string;
  byteCount: number;
  tokenEstimate?: number | null;
  keyVersion: number;
  completedAt?: number;
}

export interface EvidenceMaintenanceQuery {
  statuses: EvidenceStatus[];
  updatedBefore?: number;
  keyVersionNot?: number;
  afterUpdatedAt?: number;
  afterId?: string;
  limit: number;
}

export interface EvidenceBlobReferenceQuery {
  afterBlobRef?: string;
  limit: number;
}

export interface EvidenceBlobReplacementInput extends EvidenceFinalizeInput {
  expectedBlobRef: string;
  expectedKeyVersion: number;
  cleanupGraceDeadline: number;
  updatedAt: number;
}

export interface EvidenceFailureInput {
  evidenceId: string;
  conversationId: string;
  status?: Extract<EvidenceStatus, 'failed' | 'corrupt'>;
  updatedAt?: number;
}

export interface EvidenceListQuery {
  turnRef?: string;
  toolCallRef?: string;
  sourceKind?: EvidenceSourceKind;
  includeMaintenanceStates?: boolean;
  limit?: number;
}

export interface EvidenceMetadataSearchQuery {
  text?: string;
  toolName?: string;
  turnRef?: string;
  sourceKind?: EvidenceSourceKind;
  limit?: number;
}

export interface EvidenceRangeAuthorizationInput {
  conversationId: string;
  evidenceId: string;
  startByte: number;
  endByte: number;
}

export type EvidenceRangeAuthorization =
  | {
      authorized: true;
      conversationId: string;
      evidenceId: string;
      startByte: number;
      endByte: number;
      byteCount: number;
      blobRef: string;
      keyedContentId: string;
      keyVersion: number;
      sensitivity: EvidenceSensitivity;
      captureCompleteness: EvidenceCaptureCompleteness;
      truncationReason: string | null;
    }
  | {
      authorized: false;
      reason: 'not-found' | 'invalid-range' | 'range-out-of-bounds';
    };

export interface EvidenceCardMetadataRecord {
  id: string;
  conversationId: string;
  evidenceId: string;
  blobRef: string | null;
  extractorKind: string;
  extractorVersion: string;
  status: 'validated' | 'partial' | 'failed';
  sensitivity: EvidenceSensitivity;
  byteCount: number;
  tokenEstimate: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvidenceCardMetadataInput {
  id?: string;
  conversationId: string;
  evidenceId: string;
  blobRef?: string | null;
  extractorKind: string;
  extractorVersion: string;
  status: EvidenceCardMetadataRecord['status'];
  sensitivity: EvidenceSensitivity;
  byteCount: number;
  tokenEstimate?: number | null;
  createdAt?: number;
  cleanupGraceDeadline: number;
}

export interface ContextEvidenceConversationMetrics {
  evidenceRecordCount: number;
  evidenceCardCount: number;
  externallyStoredBytes: number;
  toolCallCount: number;
  toolResultBytes: number;
  lastActionCode: string | null;
  recoveryCount: number;
}

export interface EvidenceCardListQuery {
  evidenceId?: string;
  limit?: number;
}

export interface EvidenceAccessLogInput {
  id?: string;
  requester: string;
  conversationId: string;
  operation: 'list' | 'get-card' | 'search' | 'read' | 'compare' | 'verify';
  evidenceIds?: string[];
  requestedRanges?: { startByte: number; endByte: number }[];
  outcomeCode: string;
  createdAt?: number;
}

export interface ContextEvidenceEventInput {
  id?: string;
  conversationId: string;
  provider?: string | null;
  eventKind: string;
  recoveryEpoch: number;
  thresholdCode?: string | null;
  actionCode?: string | null;
  proofStage?: string | null;
  occupancyUsed?: number | null;
  occupancyTotal?: number | null;
  cumulativeTokens?: number | null;
  outputBytes: number;
  providerRequestCount: number;
  newEvidenceCount: number;
  newFindingCount: number;
  failureCode?: string | null;
  durationMs?: number | null;
  createdAt?: number;
}

export interface ConversationEvidenceDeletionInput {
  conversationId: string;
  deletedAt: string;
  graceDeadline: number;
}

export interface ConversationEvidenceDeletionResult {
  conversationId: string;
  queuedBlobCount: number;
  alreadyDeleted: boolean;
}

export interface EvidenceDeletionQueueRecord {
  id: string;
  conversationId: string;
  evidenceId: string | null;
  blobRef: string;
  graceDeadline: number;
  attempts: number;
  claimToken: string | null;
  claimedUntil: number | null;
  nextAttemptAt: number;
  lastErrorCode: string | null;
  completedAt: number | null;
  createdAt: number;
}

export interface LegacyMarkerCompareAndSwapInput {
  conversationId: string;
  messageId: string;
  evidenceId: string;
  expectedMarker: string;
  evidenceCitation: string;
  /** Citation plus the fixed legacy-unverified disclosure. */
  replacementText?: string;
}

export interface LegacyOutputCacheMarkerRecord {
  conversationId: string;
  messageId: string;
  content: string;
  provider: string;
  sourceKind: string;
}
