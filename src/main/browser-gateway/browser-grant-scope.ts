import type { BrowserPermissionGrant } from '@contracts/types/browser';

export function existingTabGrantNodeId(profileId: string, explicitNodeId?: string): string | undefined {
  if (!profileId.startsWith('existing-tab:')) {
    return undefined;
  }
  if (explicitNodeId) {
    return explicitNodeId;
  }
  const remote = /^existing-tab:n\.([^:]+):/.exec(profileId);
  return remote?.[1] ?? 'local';
}

export function grantScopeForApproval(input: {
  profileId: string;
  targetId?: string;
  proposedNodeId?: string;
}): Pick<BrowserPermissionGrant, 'nodeId' | 'profileId' | 'targetId'> {
  const existingNodeId = existingTabGrantNodeId(input.profileId, input.proposedNodeId);
  if (existingNodeId) {
    return { nodeId: existingNodeId };
  }
  return {
    ...(input.proposedNodeId ? { nodeId: input.proposedNodeId } : {}),
    profileId: input.profileId,
    ...(input.targetId ? { targetId: input.targetId } : {}),
  };
}
