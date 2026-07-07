import type {
  BrowserApprovalRequest,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGrantStore } from './browser-grant-store';
import { requiresAutonomousGrant } from './browser-grant-policy';
import { grantScopeForApproval } from './browser-grant-scope';

export interface BrowserAutoApproveRequest {
  approval: BrowserApprovalRequest;
  instanceId: string;
  provider: BrowserApprovalRequest['provider'];
  toolName: string;
  action: string;
  actionClass: BrowserApprovalRequest['actionClass'];
}

export type BrowserAutoApprovePredicate = (request: BrowserAutoApproveRequest) => boolean;

/**
 * Action classes that a grant may NEVER receive via auto-approval,
 * regardless of the predicate (e.g. YOLO mode). The classifier's hardStop
 * path (passwords, 2FA/OTP, captcha, tokens) proposes a grant carrying the
 * `credential` class, and in the action guard an auto-approved grant
 * executes the pending mutation directly — so a predicate-based bypass
 * would let an autonomous agent type credentials with no human in the
 * loop.
 *
 * Note the check is on the PROPOSED GRANT's allowedActionClasses, not the
 * approval's own actionClass: manual-handoff approvals (request_user_login
 * / pause_for_manual_step) are also credential-class but propose read-only
 * grants — auto-approving those merely surfaces the handoff to the human,
 * who still performs the login themselves. Enforced inside
 * autoApproveBrowserApproval (not at call sites) so every current and
 * future caller inherits it.
 */
const AUTO_APPROVE_UNGRANTABLE_CLASSES: ReadonlyArray<
  BrowserApprovalRequest['actionClass']
> = ['credential', 'payment'];

export interface BrowserAutoApproveDeps {
  approval: BrowserApprovalRequest;
  approvalStore: Pick<BrowserApprovalStore, 'resolveRequest'>;
  grantStore: Pick<BrowserGrantStore, 'createGrant'>;
  autoApproveRequests?: BrowserAutoApprovePredicate;
  reason?: string;
  now?: () => number;
}

export function autoApproveBrowserApproval(
  deps: BrowserAutoApproveDeps,
): BrowserPermissionGrant | null {
  const proposedClasses = deps.approval.proposedGrant.allowedActionClasses;
  if (AUTO_APPROVE_UNGRANTABLE_CLASSES.some((cls) => proposedClasses.includes(cls))) {
    return null;
  }
  let shouldApprove = false;
  try {
    shouldApprove = Boolean(deps.autoApproveRequests?.({
      approval: deps.approval,
      instanceId: deps.approval.instanceId,
      provider: deps.approval.provider,
      toolName: deps.approval.toolName,
      action: deps.approval.action,
      actionClass: deps.approval.actionClass,
    }));
  } catch {
    shouldApprove = false;
  }

  if (!shouldApprove) {
    return null;
  }

  const now = deps.now?.() ?? Date.now();
  const proposedGrant = deps.approval.proposedGrant;
  const scope = grantScopeForApproval({
    profileId: deps.approval.profileId,
    targetId: deps.approval.targetId,
    proposedNodeId: proposedGrant.nodeId,
  });
  const grant = deps.grantStore.createGrant({
    ...proposedGrant,
    // YOLO auto-approval is the user's standing consent to proceed without
    // per-action confirmation. Grants covering submit/destructive classes must
    // carry `autonomous: true` — grantMatches() rejects non-autonomous grants
    // for those classes, so without this the auto-approved grant is instantly
    // unusable and every submit/destructive action re-prompts the user even
    // though yolo is on.
    autonomous:
      (proposedGrant.mode === 'autonomous' && proposedGrant.autonomous) ||
      requiresAutonomousGrant(proposedGrant.allowedActionClasses),
    instanceId: deps.approval.instanceId,
    provider: deps.approval.provider,
    ...scope,
    requestedBy: deps.approval.instanceId,
    decidedBy: 'user',
    decision: 'allow',
    reason: deps.reason ?? 'auto_approved_by_yolo_mode',
    expiresAt: defaultAutoApprovedGrantExpiresAt(
      deps.approval.proposedGrant.mode,
      now,
    ),
  });
  deps.approvalStore.resolveRequest(deps.approval.requestId, {
    status: 'approved',
    grantId: grant.id,
  });
  return grant;
}

function defaultAutoApprovedGrantExpiresAt(
  mode: BrowserApprovalRequest['proposedGrant']['mode'],
  now: number,
): number {
  return mode === 'per_action'
    ? now + 30 * 60 * 1000
    : now + 8 * 60 * 60 * 1000;
}
