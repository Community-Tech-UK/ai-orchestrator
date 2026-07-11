import type { BrowserActionClass } from '@contracts/types/browser';
import type { GenericSecretKind } from './browser-credential-vault';

/**
 * Advisory-reviewer orchestration for the procurement workflow.
 *
 * Two (or more) independent LLM reviewers inspect a REDACTED plan — form↔field
 * mapping, factual consistency with source docs, authorization scope, upload
 * suitability, navigation/submission risk — and return structured verdicts. This
 * coordinator is the DETERMINISTIC gate around them:
 *  - Reviewers are ADVISORY. They can only BLOCK; they can never authorize a
 *    fill. The secret-fill authorization + broker remain the security boundary.
 *  - Execution proceeds only if EVERY reviewer approves. Any rejection — and
 *    therefore any disagreement — stops execution.
 *  - Reviewers never receive secrets: the plan carries only opaque references,
 *    and `assertNoSecretMaterial` fails closed if a value ever leaks into a plan.
 */

export interface ProcurementPlanField {
  selector: string;
  /** Present for a brokered secret field; the value is NOT here. */
  secretType?: GenericSecretKind;
  /** Opaque vault item reference (non-secret). */
  vaultItemRef?: string;
  /** Non-secret custom-field name for arbitrary_named_vault_field. */
  fieldName?: string;
  /** Reference to the source document a factual reviewer checks against. */
  sourceDocRef?: string;
  actionClass: BrowserActionClass;
}

export interface ProcurementReviewPlan {
  origin: string;
  targetId: string;
  fields: ProcurementPlanField[];
  uploads?: Array<{ selector: string; documentRef: string }>;
  declarations?: Array<{ selector: string; textHash: string }>;
}

export interface ProcurementReviewVerdict {
  reviewer: string;
  approved: boolean;
  /** Structured concerns; required to be non-empty when not approved. */
  concerns: string[];
}

export type ProcurementReviewer = (plan: ProcurementReviewPlan) => Promise<ProcurementReviewVerdict>;

export interface ProcurementReviewOutcome {
  decision: 'approved' | 'blocked';
  reason?:
    | 'insufficient_reviewers'
    | 'reviewer_error'
    | 'reviewer_disagreement'
    | 'all_reviewers_rejected'
    | 'secret_material_in_plan';
  verdicts: ProcurementReviewVerdict[];
}

/** Property names that must never carry a value in a review plan. */
const FORBIDDEN_VALUE_KEYS = new Set([
  'value',
  'secret',
  'secretvalue',
  'password',
  'plaintext',
  'accountnumber',
  'sortcode',
  'iban',
  'cvv',
  'cvc',
]);

/**
 * Fail closed if a plan smells of a secret VALUE (a forbidden key holding a
 * non-empty string). A well-formed plan carries only references, so this never
 * fires in normal operation — it is the backstop that keeps a malformed plan out
 * of an LLM reviewer's context.
 */
export function assertNoSecretMaterial(plan: ProcurementReviewPlan): void {
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, val] of Object.entries(node)) {
        if (FORBIDDEN_VALUE_KEYS.has(key.toLowerCase()) && typeof val === 'string' && val.length > 0) {
          throw new SecretMaterialInPlanError(key);
        }
        visit(val);
      }
    }
  };
  visit(plan);
}

export class SecretMaterialInPlanError extends Error {
  constructor(readonly key: string) {
    // Never echo the value — only the offending key name.
    super(`Review plan contains disallowed secret material under "${key}"`);
    this.name = 'SecretMaterialInPlanError';
  }
}

/**
 * Run the reviewer panel over a redacted plan and decide whether execution may
 * proceed. Requires at least two reviewers; proceeds only on unanimous approval.
 */
export async function runProcurementReview(
  plan: ProcurementReviewPlan,
  reviewers: ProcurementReviewer[],
): Promise<ProcurementReviewOutcome> {
  try {
    assertNoSecretMaterial(plan);
  } catch (error) {
    if (error instanceof SecretMaterialInPlanError) {
      return { decision: 'blocked', reason: 'secret_material_in_plan', verdicts: [] };
    }
    throw error;
  }

  if (reviewers.length < 2) {
    return { decision: 'blocked', reason: 'insufficient_reviewers', verdicts: [] };
  }

  const settled = await Promise.allSettled(reviewers.map((reviewer) => reviewer(plan)));
  const verdicts: ProcurementReviewVerdict[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      // A reviewer that errored cannot be treated as an approval — fail closed.
      return { decision: 'blocked', reason: 'reviewer_error', verdicts };
    }
    verdicts.push(outcome.value);
  }

  const rejected = verdicts.filter((verdict) => !verdict.approved);
  if (rejected.length > 0) {
    return {
      decision: 'blocked',
      reason: rejected.length === verdicts.length ? 'all_reviewers_rejected' : 'reviewer_disagreement',
      verdicts,
    };
  }
  return { decision: 'approved', verdicts };
}
