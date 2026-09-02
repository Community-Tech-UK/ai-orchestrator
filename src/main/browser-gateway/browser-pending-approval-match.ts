import type { BrowserApprovalRequest } from '@contracts/types/browser';
import type {
  BrowserApprovalRequestInput,
  BrowserApprovalStore,
} from './browser-approval-store';

type PendingApprovalStore = Pick<BrowserApprovalStore, 'createRequest' | 'listRequests'>;

export interface BrowserPendingApprovalResult {
  approval: BrowserApprovalRequest;
  reused: boolean;
}

/** Keep repeated retries attached to the one decision already awaiting the user. */
export function createOrReusePendingBrowserApproval(
  store: PendingApprovalStore,
  input: BrowserApprovalRequestInput,
): BrowserPendingApprovalResult {
  const approval = store.listRequests({
    instanceId: input.instanceId,
    status: 'pending',
    limit: 100,
  }).find((candidate) => pendingApprovalMatches(candidate, input));
  if (approval) {
    return { approval, reused: true };
  }
  return { approval: store.createRequest(input), reused: false };
}

function pendingApprovalMatches(
  candidate: BrowserApprovalRequest,
  input: BrowserApprovalRequestInput,
): boolean {
  return (
    candidate.status === 'pending' &&
    candidate.expiresAt > Date.now() &&
    candidate.instanceId === input.instanceId &&
    candidate.provider === input.provider &&
    candidate.profileId === input.profileId &&
    candidate.targetId === input.targetId &&
    candidate.toolName === input.toolName &&
    candidate.action === input.action &&
    candidate.actionClass === input.actionClass &&
    candidate.origin === input.origin &&
    candidate.url === input.url &&
    candidate.selector === input.selector &&
    candidate.filePath === input.filePath &&
    candidate.detectedFileType === input.detectedFileType &&
    JSON.stringify(candidate.elementContext) === JSON.stringify(input.elementContext) &&
    JSON.stringify(candidate.proposedGrant) === JSON.stringify(input.proposedGrant)
  );
}
