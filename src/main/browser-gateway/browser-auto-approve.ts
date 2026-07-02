import type {
  BrowserApprovalRequest,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGrantStore } from './browser-grant-store';
import { requiresAutonomousGrant } from './browser-grant-policy';

export interface BrowserAutoApproveRequest {
  approval: BrowserApprovalRequest;
  instanceId: string;
  provider: BrowserApprovalRequest['provider'];
  toolName: string;
  action: string;
  actionClass: BrowserApprovalRequest['actionClass'];
}

export type BrowserAutoApprovePredicate = (request: BrowserAutoApproveRequest) => boolean;

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
    profileId: deps.approval.profileId,
    targetId: deps.approval.targetId,
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
