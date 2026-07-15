import type {
  EvidenceSensitivity,
  EvidenceSourceKind,
} from '@contracts/types/context-evidence';

const WEB_CURRENT_FACT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export type EvidenceAccessPath =
  | 'provider'
  | 'model-assisted'
  | 'local'
  | 'ipc'
  | 'accuracy-gate';

export interface EvidenceAccessRequester {
  id: string;
  path: EvidenceAccessPath;
  localSensitiveAuthorized: boolean;
  localRestrictedAuthorized: boolean;
  modelDataBoundary?: 'local' | 'configured-remote';
  modelDataBoundaryAuthorized?: boolean;
}

export interface EvidenceAccessPolicyInput {
  requester: EvidenceAccessRequester;
  sensitivity: EvidenceSensitivity;
  sourceKind: EvidenceSourceKind;
  observedAt: number;
  now: number;
  freshnessRequirementMs?: number;
}

export type EvidenceAccessPolicyDecision =
  | { allowed: true; disclosures: string[] }
  | { allowed: false; code: string };

export interface EvidenceAccessPolicy {
  authorize(input: EvidenceAccessPolicyInput): EvidenceAccessPolicyDecision;
}

/** Shared fail-closed sensitivity and freshness policy for evidence consumers. */
export class ConservativeEvidenceAccessPolicy implements EvidenceAccessPolicy {
  authorize(input: EvidenceAccessPolicyInput): EvidenceAccessPolicyDecision {
    if (!validFreshnessInput(input)) {
      return { allowed: false, code: 'EVIDENCE_FRESHNESS_INPUT_INVALID' };
    }
    const sensitivityDecision = authorizeSensitivity(input);
    if (!sensitivityDecision.allowed) return sensitivityDecision;
    if (
      input.requester.path === 'model-assisted'
      && (!input.requester.modelDataBoundary || !input.requester.modelDataBoundaryAuthorized)
    ) {
      return { allowed: false, code: 'MODEL_DATA_BOUNDARY_NOT_AUTHORIZED' };
    }
    return { allowed: true, disclosures: freshnessDisclosures(input) };
  }
}

function authorizeSensitivity(
  input: EvidenceAccessPolicyInput,
): EvidenceAccessPolicyDecision {
  if (input.sensitivity === 'normal') return { allowed: true, disclosures: [] };
  if (input.requester.path === 'provider' || input.requester.path === 'model-assisted') {
    return {
      allowed: false,
      code: input.sensitivity === 'restricted'
        ? 'RESTRICTED_EVIDENCE_PATH_DENIED'
        : 'SENSITIVE_EVIDENCE_REQUIRES_AUTHORIZED_LOCAL_REQUESTER',
    };
  }
  if (input.sensitivity === 'sensitive' && input.requester.localSensitiveAuthorized) {
    return { allowed: true, disclosures: [] };
  }
  if (input.sensitivity === 'restricted' && input.requester.localRestrictedAuthorized) {
    return { allowed: true, disclosures: [] };
  }
  return {
    allowed: false,
    code: input.sensitivity === 'restricted'
      ? 'RESTRICTED_EVIDENCE_REQUIRES_AUTHORIZED_LOCAL_REQUESTER'
      : 'SENSITIVE_EVIDENCE_REQUIRES_AUTHORIZED_LOCAL_REQUESTER',
  };
}

function validFreshnessInput(input: EvidenceAccessPolicyInput): boolean {
  return Number.isSafeInteger(input.observedAt)
    && input.observedAt >= 0
    && Number.isSafeInteger(input.now)
    && input.now >= input.observedAt
    && (
      input.freshnessRequirementMs === undefined
      || (Number.isSafeInteger(input.freshnessRequirementMs) && input.freshnessRequirementMs >= 0)
    );
}

function freshnessDisclosures(input: EvidenceAccessPolicyInput): string[] {
  const age = Math.max(0, input.now - input.observedAt);
  const disclosures: string[] = [];
  if (input.sourceKind === 'web' && age > WEB_CURRENT_FACT_MAX_AGE_MS) {
    disclosures.push(
      'Web evidence was observed more than 24 hours ago; verify current facts before relying on it.',
    );
  }
  if (
    input.freshnessRequirementMs !== undefined
    && age > input.freshnessRequirementMs
    && !(input.sourceKind === 'web' && input.freshnessRequirementMs === WEB_CURRENT_FACT_MAX_AGE_MS)
  ) {
    disclosures.push(
      `Evidence exceeds the requester's ${input.freshnessRequirementMs}ms freshness requirement.`,
    );
  }
  return disclosures;
}
