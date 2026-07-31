/**
 * Approval Category — never-delegable request categories (WS-B3 Phase 1).
 *
 * A category-bearing PermissionRequest can NEVER be auto-decided by any
 * automatic path (YOLO, a matched rule of any source, a future adjudicator)
 * — `PermissionManager.checkPermission()` always resolves it to a live human
 * 'ask', before consulting rules, YOLO, or the decision cache. See
 * `checkPermission()` in permission-manager.ts for the enforcement.
 *
 * Deliberately conservative: only scope combinations that PROVABLY imply a
 * category are auto-derived here. Everything else requires an explicit
 * `context.categoryHint` set by the calling feature — e.g. a future
 * PR-creation flow (external_publish) or a billing/spend confirmation
 * (billing) has no dedicated PermissionScope and MUST set the hint itself.
 * Silence here is not safety: an un-hinted publish/billing/question request
 * simply falls through to ordinary permission handling, unprotected by this
 * guard (though still subject to normal rules/YOLO/ask).
 */

import type { PermissionDecision, PermissionRequest, PermissionScope } from './permission-manager';

export type ApprovalCategory =
  | 'credentials'
  | 'billing'
  | 'external_publish'
  | 'interactive_question';

/** Scopes that provably imply a category regardless of resource/context. */
const SCOPE_CATEGORY: Partial<Record<PermissionScope, ApprovalCategory>> = {
  secret_access: 'credentials',
};

/**
 * Derive the never-delegable category for `request`, if any. An explicit
 * `context.categoryHint` always wins; otherwise falls back to the provable
 * scope mapping above. Returns `null` when neither applies — NOT a claim
 * that the request is safe, only that this guard has no opinion on it.
 */
export function deriveApprovalCategory(request: PermissionRequest): ApprovalCategory | null {
  return request.context?.categoryHint ?? SCOPE_CATEGORY[request.scope] ?? null;
}

/**
 * The forced decision for a category-bearing request: always 'ask', never
 * cached, attributed to this guard so the audit trail can distinguish it
 * from an ordinary rule/YOLO/default-action 'ask'.
 */
export function buildNeverDelegableAskDecision(
  request: PermissionRequest,
  category: ApprovalCategory,
): PermissionDecision {
  return {
    request,
    action: 'ask',
    category,
    decidedBy: 'never-delegable-guard',
    fromCache: false,
    reason: `never-delegable:${category}`,
    decidedAt: Date.now(),
  };
}
