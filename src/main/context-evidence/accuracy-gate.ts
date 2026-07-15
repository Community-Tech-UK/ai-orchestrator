import type {
  AccuracyGateIssue,
  AccuracyGateIssueCode,
  AccuracyGateResult,
  EvidenceCaptureCompleteness,
  EvidenceCitation,
  EvidenceProvenanceTrust,
  EvidenceSensitivity,
  EvidenceSourceKind,
} from '@contracts/types/context-evidence';
import { parseEvidenceCitations } from './evidence-citation-parser';
import type { EvidenceAccessPolicy } from './evidence-access-policy';

export type AccuracyEvidenceVerification =
  | {
      status: 'valid';
      provenanceTrust: EvidenceProvenanceTrust;
      captureCompleteness: EvidenceCaptureCompleteness;
      rawSpanAvailable: boolean;
      modelAssistedOnly: boolean;
      sensitivity: EvidenceSensitivity;
      sourceKind: EvidenceSourceKind;
      observedAt: number;
    }
  | {
      status:
        | 'missing-evidence'
        | 'wrong-conversation'
        | 'invalid-citation'
        | 'stale-evidence'
        | 'corrupt-evidence';
    };

export interface AccuracyEvidenceVerifier {
  verify(conversationId: string, citation: EvidenceCitation): Promise<AccuracyEvidenceVerification>;
}

export interface AccuracyGateInput {
  conversationId: string;
  assistantText: string;
  researchRequested: boolean;
  externalFactsUsed: boolean;
  completionClaim: boolean;
  highStakes: boolean;
  executionReceiptCurrent: boolean;
  unresolvedContradictionCount: number;
  contradictionsPresented: boolean;
  disclosedIncompleteEvidenceIds: string[];
}

interface ValidatedCitation {
  citation: EvidenceCitation;
  verification: Extract<AccuracyEvidenceVerification, { status: 'valid' }>;
}

/** Validates evidence linkage and receipts; it does not assert interpretations are true. */
export class AccuracyGate {
  constructor(
    private readonly verifier: AccuracyEvidenceVerifier,
    private readonly policy: EvidenceAccessPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(input: AccuracyGateInput): Promise<AccuracyGateResult> {
    const parsed = parseEvidenceCitations(input.assistantText);
    const mode = classifyMode(input, parsed.citations.length > 0);
    if (mode === 'casual') {
      return { mode, verdict: 'pass', checkedCitationCount: 0, issues: [], disclosures: [] };
    }

    const issues: AccuracyGateIssue[] = parsed.malformedMarkers.map(() => ({
      code: 'invalid-citation',
    }));
    const disclosures: string[] = [];
    const valid: ValidatedCitation[] = [];

    if (parsed.citations.length === 0) issues.push({ code: 'missing-evidence' });
    for (const citation of parsed.citations) {
      const verification = await this.verifier.verify(input.conversationId, citation);
      if (verification.status !== 'valid') {
        issues.push({ code: verification.status, evidenceId: citation.evidenceId });
        continue;
      }
      const access = this.policy.authorize({
        requester: {
          id: 'accuracy-gate',
          path: 'accuracy-gate',
          localSensitiveAuthorized: true,
          localRestrictedAuthorized: true,
        },
        sensitivity: verification.sensitivity,
        sourceKind: verification.sourceKind,
        observedAt: verification.observedAt,
        now: this.now(),
      });
      if (!access.allowed) {
        issues.push({
          code: access.code === 'EVIDENCE_FRESHNESS_INPUT_INVALID'
            ? 'stale-evidence'
            : 'invalid-citation',
          evidenceId: citation.evidenceId,
        });
        continue;
      }
      disclosures.push(...access.disclosures);
      valid.push({ citation, verification });
      if (
        verification.captureCompleteness !== 'complete'
        && !input.disclosedIncompleteEvidenceIds.includes(citation.evidenceId)
      ) {
        issues.push({
          code: 'incomplete-capture-undisclosed',
          evidenceId: citation.evidenceId,
        });
      }
      if (!verification.rawSpanAvailable || verification.modelAssistedOnly) {
        issues.push({ code: 'model-assisted-only', evidenceId: citation.evidenceId });
      }
      if (verification.provenanceTrust === 'legacy-unverified') {
        disclosures.push(`Evidence ${citation.evidenceId} has legacy-unverified provenance.`);
      }
    }

    if (
      valid.length > 0
      && valid.every(({ verification }) => verification.provenanceTrust === 'legacy-unverified')
    ) {
      for (const { citation } of valid) {
        issues.push({ code: 'legacy-unverified-only', evidenceId: citation.evidenceId });
      }
    }
    if (input.unresolvedContradictionCount > 0 && !input.contradictionsPresented) {
      issues.push({ code: 'unresolved-contradiction' });
    }
    if (mode === 'completion-claim' && !input.executionReceiptCurrent) {
      issues.push({ code: 'missing-execution-receipt' });
    }

    return {
      mode,
      verdict: issues.length === 0 ? 'pass' : 'block',
      checkedCitationCount: parsed.citations.length,
      issues: uniqueIssues(issues),
      disclosures: [...new Set(disclosures)],
    };
  }
}

function classifyMode(
  input: AccuracyGateInput,
  presentsCitations: boolean,
): AccuracyGateResult['mode'] {
  if (input.highStakes) return 'high-stakes';
  if (input.completionClaim) return 'completion-claim';
  if (input.researchRequested || input.externalFactsUsed || presentsCitations) {
    return 'evidence-backed';
  }
  return 'casual';
}

function uniqueIssues(issues: AccuracyGateIssue[]): AccuracyGateIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = issueKey(issue.code, issue.evidenceId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issueKey(code: AccuracyGateIssueCode, evidenceId?: string): string {
  return `${code}\u0000${evidenceId ?? ''}`;
}
