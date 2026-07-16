export type EvidenceSourceKind =
  | 'command'
  | 'file'
  | 'database'
  | 'web'
  | 'mcp'
  | 'browser'
  | 'other';

export type EvidenceStatus = 'staging' | 'complete' | 'failed' | 'corrupt' | 'deleted';
export type EvidenceSensitivity = 'normal' | 'sensitive' | 'restricted';
export type EvidenceProvenanceTrust = 'runtime-authenticated' | 'legacy-unverified';
export type EvidenceCaptureMode = 'pre-retention' | 'post-retention' | 'observed-only';
export type EvidenceCaptureCompleteness = 'complete' | 'bounded' | 'metadata-only';

/** Content-free metadata for one conversation-owned evidence blob. */
export interface EvidenceRecord {
  id: string;
  conversationId: string;
  provider: string;
  providerThreadRef?: string;
  turnRef?: string;
  toolCallRef?: string;
  toolName: string;
  sourceKind: EvidenceSourceKind;
  sourceLocatorRedacted?: string;
  status: EvidenceStatus;
  keyedContentId?: string;
  byteCount: number;
  tokenEstimate?: number;
  mimeType: string;
  sensitivity: EvidenceSensitivity;
  provenanceTrust: EvidenceProvenanceTrust;
  createdAt: number;
  completedAt?: number;
  keyVersion?: number;
  captureMode: EvidenceCaptureMode;
  captureCompleteness: EvidenceCaptureCompleteness;
  truncationReason?: string;
}

/** UTF-8 byte offsets into one evidence record plus a keyed, range-specific digest. */
export interface EvidenceCitation {
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
}

export interface EvidenceFinding {
  id: string;
  kind: 'fact' | 'change' | 'warning' | 'error' | 'verification';
  statement: string;
  importance: 'info' | 'warning' | 'critical';
  citations: EvidenceCitation[];
}

export interface EvidenceContradictionResolution {
  statement: string;
  citations: EvidenceCitation[];
}

interface EvidenceContradictionBase {
  id: string;
  statement: string;
  leftCitations: EvidenceCitation[];
  rightCitations: EvidenceCitation[];
}

export type EvidenceContradiction = EvidenceContradictionBase & (
  | { status: 'unresolved'; resolution?: never }
  | { status: 'resolved'; resolution: EvidenceContradictionResolution }
);

export interface EvidenceCard {
  id: string;
  evidenceId: string;
  version: number;
  status: 'validated' | 'partial' | 'failed';
  summary: string;
  findings: EvidenceFinding[];
  citations: EvidenceCitation[];
  freshness?: { observedAt: number; sourcePublishedAt?: number };
  contradictions: EvidenceContradiction[];
  derivedBy: { kind: 'deterministic' | 'model-assisted'; version: string };
  createdAt: number;
}

export type ContextOccupancy =
  | { status: 'known'; used: number; total: number }
  | { status: 'unknown'; reason: string };

export interface ContextPressureSample {
  occupancy: ContextOccupancy;
  cumulativeTokens?: number;
  outputBytesSinceCompaction: number;
  providerRequestCount: number;
  newEvidenceCount: number;
  newValidatedFindingCount: number;
  recoveryEpoch: number;
}

export interface ProviderContextCapabilities {
  toolResultControl: 'pre-retention' | 'post-retention' | 'none';
  toolResultVisibility: 'full' | 'bounded' | 'metadata-only' | 'none';
  transcriptControl: 'rebuild' | 'native-compaction' | 'none';
  occupancyReporting: 'current' | 'aggregate-only' | 'none';
  cumulativeReporting: 'available' | 'none';
  interruptProof: 'observed' | 'acknowledged-only' | 'none';
  compactionProof: 'observed' | 'acknowledged-only' | 'none';
  sameThreadContinuation: boolean;
}

export const CONSERVATIVE_PROVIDER_CONTEXT_CAPABILITIES: ProviderContextCapabilities = {
  toolResultControl: 'none',
  toolResultVisibility: 'none',
  transcriptControl: 'none',
  occupancyReporting: 'none',
  cumulativeReporting: 'none',
  interruptProof: 'none',
  compactionProof: 'none',
  sameThreadContinuation: false,
};

/** Input bytes are transient; they are never part of EvidenceRecord metadata. */
export interface EvidenceCaptureRequest {
  captureKey: string;
  conversationId: string;
  provider: string;
  providerThreadRef?: string;
  turnRef?: string;
  toolCallRef?: string;
  toolName: string;
  sourceKind: EvidenceSourceKind;
  sourceLocatorRedacted?: string;
  mimeType: string;
  sensitivity: EvidenceSensitivity;
  provenanceTrust: EvidenceProvenanceTrust;
  captureMode: EvidenceCaptureMode;
  captureCompleteness: EvidenceCaptureCompleteness;
  truncationReason?: string;
  content: Uint8Array;
}

export type EvidenceCaptureResult =
  | { status: 'captured' | 'duplicate'; record: EvidenceRecord }
  | { status: 'failed' | 'conflict'; errorCode: string; disclosure: string };

export interface EvidenceRetrievalRequest {
  conversationId: string;
  evidenceId: string;
  startByte: number;
  endByte: number;
  tokenLimit: number;
}

export interface EvidenceRetrievalResponse {
  evidenceId: string;
  startByte: number;
  endByte: number;
  content: string;
  tokenCount: number;
  tokenLimit: number;
  truncated: boolean;
  citation: EvidenceCitation;
  captureCompleteness: EvidenceCaptureCompleteness;
  disclosure?: string;
}

export type AccuracyGateIssueCode =
  | 'missing-evidence'
  | 'wrong-conversation'
  | 'invalid-citation'
  | 'stale-evidence'
  | 'unresolved-contradiction'
  | 'model-assisted-only'
  | 'missing-execution-receipt'
  | 'corrupt-evidence'
  | 'incomplete-capture-undisclosed'
  | 'legacy-unverified-only';

export interface AccuracyGateIssue {
  code: AccuracyGateIssueCode;
  evidenceId?: string;
}

export interface AccuracyGateResult {
  mode: 'casual' | 'evidence-backed' | 'completion-claim' | 'high-stakes';
  verdict: 'pass' | 'warn' | 'block';
  checkedCitationCount: number;
  issues: AccuracyGateIssue[];
  disclosures: string[];
}

export interface WorkingSetAllocation {
  capacityTokens?: number;
  instructionsTokens: number;
  recentDialogueTokens: number;
  evidenceCardTokens: number;
  exactExcerptTokens: number;
  reasoningAndAnswerTokens: number;
  emergencyReserveTokens: number;
  normalWorkingSetTokens: number;
  totalAllocatedTokens: number;
  estimateKind: 'provider-tokenizer' | 'conservative-fallback';
}

export type EnforcementActionKind =
  | 'none'
  | 'externalize-result'
  | 'rebuild-working-set'
  | 'native-compaction'
  | 'stop-broad-research'
  | 'controlled-interrupt'
  | 'controlled-recovery'
  | 'same-thread-continuation'
  | 'convergence-review'
  | 'pause';

export type EnforcementTrigger =
  | 'oversized-result'
  | 'known-occupancy-60'
  | 'known-occupancy-75'
  | 'known-occupancy-85'
  | 'known-occupancy-92'
  | 'cumulative-2x'
  | 'cumulative-4x'
  | 'no-evidence-progress'
  | 'unknown-occupancy-budget'
  | 'manual';

export interface EnforcementAction {
  kind: EnforcementActionKind;
  trigger: EnforcementTrigger;
  recoveryEpoch: number;
  proofRequired: 'none' | 'acknowledged' | 'observed';
  createdAt: number;
}

export interface ContextEvidenceRendererMetrics {
  occupancy: ContextOccupancy;
  cumulativeTokens?: number;
  workingSet: WorkingSetAllocation;
  evidenceRecordCount: number;
  evidenceCardCount: number;
  exactExcerptCount: number;
  externallyStoredBytes: number;
  modelRequestCount: number;
  toolCallCount: number;
  toolResultBytes: number;
  enforcementMode: 'off' | 'shadow' | 'enforce';
  lastAction?: EnforcementActionKind;
  recoveryCount: number;
  updatedAt: number;
}

export type ContextEvidenceOwner =
  | { kind: 'chat'; chatId: string }
  | { kind: 'instance'; instanceId: string };

export interface ContextEvidenceScope {
  conversationId: string;
  owner: ContextEvidenceOwner;
}

export interface ContextEvidenceListRequest extends ContextEvidenceScope {
  limit?: number;
}

export interface ContextEvidenceGetCardRequest extends ContextEvidenceScope {
  cardId: string;
  tokenLimit: number;
}

export interface ContextEvidenceSearchRequest extends ContextEvidenceScope {
  query: string;
  tokenLimit: number;
}

export interface ContextEvidenceReadRequest extends ContextEvidenceScope {
  evidenceId: string;
  startByte: number;
  endByte: number;
  tokenLimit: number;
}

export interface ContextEvidenceCompareRequest extends ContextEvidenceScope {
  left: { evidenceId: string; startByte: number; endByte: number };
  right: { evidenceId: string; startByte: number; endByte: number };
}

export interface ContextEvidenceVerifyRequest extends ContextEvidenceScope {
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
}

export type ContextEvidenceGetMetricsRequest = ContextEvidenceScope;

export interface ContextEvidenceSearchMatch {
  matchKind: 'card' | 'raw';
  evidenceId: string;
  startByte: number;
  endByte: number;
  preview: string;
  citation: EvidenceCitation;
  disclosure?: string;
}

export interface ContextEvidenceCardResponse {
  card: EvidenceCard;
  sensitivity: EvidenceSensitivity;
  provenanceTrust: EvidenceProvenanceTrust;
  captureCompleteness: EvidenceCaptureCompleteness;
  tokenCount: number;
  tokenLimit: number;
  truncated: boolean;
  disclosure?: string;
}

export interface ContextEvidenceCompareResponse {
  equal: boolean;
  leftCitation: EvidenceCitation;
  rightCitation: EvidenceCitation;
}

export interface ContextEvidenceVerifyResponse {
  verified: boolean;
}

export interface ContextEvidenceStateChanged {
  conversationId: string;
  metrics: ContextEvidenceRendererMetrics;
}
