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

/**
 * Which computer an approval is about: 'local' or a remote computer's id, for
 * showing to the person who decides. A shared tab names its computer in its own
 * id; a managed profile runs where its profile says (no setting means this
 * computer). It never comes from the agent's proposal. Undefined when a managed
 * profile no longer exists, so nothing is guessed.
 */
export function approvalComputerId(
  profileId: string,
  getProfile: (id: string) => { executionNodeId?: string } | null | undefined,
): string | undefined {
  const shared = existingTabGrantNodeId(profileId);
  if (shared) return shared;
  const profile = getProfile(profileId);
  return profile ? profile.executionNodeId ?? 'local' : undefined;
}

/**
 * Stable scope for standing, per-origin browser state that must outlive a tab:
 * credential authorizations and login recipes. Managed profiles use their own
 * id. A shared existing tab uses its node scope (the remote nodeId, or 'local'),
 * because its own profileId is per-tab and ephemeral, so keying by it could
 * never be standing. Mirrors how shared-tab grants are scoped above.
 */
export function credentialScopeForProfile(profileId: string): string {
  return existingTabGrantNodeId(profileId) ?? profileId;
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
