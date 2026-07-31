/**
 * Renderer-side mirror of the main-process `GovernedProposal` /
 * `ProposalAuditEntry` shapes (see `src/main/persistence/rlm/rlm-governed-proposals.ts`).
 * Not Zod-validated on this side — the main process is the source of truth
 * and the IPC payload schemas (`@contracts/schemas/knowledge`) validate the
 * commands going the other way.
 */

export type GovernedProposalKind = 'memory' | 'skill' | 'hook' | 'rule';
export type GovernedProposalStatus = 'pending' | 'approved' | 'rejected' | 'superseded';

export interface GovernedProposal {
  id: string;
  kind: GovernedProposalKind;
  status: GovernedProposalStatus;
  provenance: string;
  title: string;
  description: string;
  payloadJson: string;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionRationale: string | null;
  reinforcements: number;
  relatedIdsJson: string;
  tagsJson: string;
}

export type ProposalAuditAction =
  | 'created'
  | 'approved'
  | 'rejected'
  | 'edited'
  | 'superseded'
  | 'reinforced'
  | 'backfilled';

export interface ProposalAuditEntry {
  id: number;
  proposalId: string;
  action: ProposalAuditAction;
  actor: string | null;
  timestamp: number;
  reason: string | null;
  metadataJson: string;
}

/** Best-effort decode of the memory-kind proposal payload (`{ text, normalizedText }`). */
export function decodeMemoryProposalText(proposal: GovernedProposal): string {
  try {
    const parsed = JSON.parse(proposal.payloadJson) as { text?: string };
    return parsed.text ?? proposal.title;
  } catch {
    return proposal.title;
  }
}

/**
 * WS-B8: renderer-side mirror of `RuleProposalPayload`
 * (`src/main/memory/governed-proposal-service.ts`) — a mined fail->fix
 * correction awaiting review.
 */
export interface RuleProposalEvidence {
  sessionId: string;
  exampleFail: string;
  exampleFix: string;
}

export interface RuleProposalPayload {
  baseCommand: string;
  errorClass: string;
  pattern: string;
  correction: string;
  occurrences: number;
  confidence: number;
  evidence: RuleProposalEvidence[];
  decidedLessonText?: string;
}

/** Best-effort decode of a rule-kind proposal payload. `null` when it isn't parseable. */
export function decodeRuleProposalPayload(proposal: GovernedProposal): RuleProposalPayload | null {
  try {
    const parsed = JSON.parse(proposal.payloadJson) as Partial<RuleProposalPayload>;
    if (!parsed.pattern || !parsed.correction) return null;
    return {
      baseCommand: parsed.baseCommand ?? '',
      errorClass: parsed.errorClass ?? '',
      pattern: parsed.pattern,
      correction: parsed.correction,
      occurrences: parsed.occurrences ?? 1,
      confidence: parsed.confidence ?? 0,
      evidence: parsed.evidence ?? [],
      decidedLessonText: parsed.decidedLessonText,
    };
  } catch {
    return null;
  }
}

/** Renderer-side mirror of `ScanResultSummary` (`src/main/learning/learning-scan-service.ts`). */
export interface LearningScanResultSummary {
  scopeKey: string;
  sessionsScanned: number;
  sessionsSkipped: number;
  proposalsCreated: number;
  proposalsReinforced: number;
  patternsFound: number;
  startedAt: number;
  completedAt: number;
  error: string | null;
}

/** Renderer-side mirror of `LearningScanCheckpoint` (`src/main/persistence/rlm/rlm-learning-scan-checkpoints.ts`). */
export interface LearningScanCheckpoint {
  scopeKey: string;
  lastScannedEndedAt: number;
  lastScannedEntryId: string | null;
  lastScanStartedAt: number | null;
  lastScanCompletedAt: number | null;
  sessionsScannedLastRun: number;
  sessionsScannedTotal: number;
  proposalsCreatedLastRun: number;
  proposalsReinforcedLastRun: number;
  lastError: string | null;
  updatedAt: number;
}
