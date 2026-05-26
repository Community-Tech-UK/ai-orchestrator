import type {
  BrowserApprovalRequest,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGrantStore } from './browser-grant-store';

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
  const grant = deps.grantStore.createGrant({
    ...deps.approval.proposedGrant,
    autonomous:
      deps.approval.proposedGrant.mode === 'autonomous' &&
      deps.approval.proposedGrant.autonomous,
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
