import type { BrowserUploadFileRequest } from '@contracts/types/browser';
import type { BrowserGatewayPreparedMutation } from './browser-gateway-action-guard.types';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import { findMatchingBrowserGrant } from './browser-grant-policy';
import type { BrowserGrantStore } from './browser-grant-store';
import { providerFromContext } from './browser-provider';
import { validateBrowserUploadPath, type BrowserUploadPolicyInput, type BrowserUploadPolicyResult } from './browser-upload-policy';

interface BrowserUploadGrantInput {
  request: BrowserGatewayContext & BrowserUploadFileRequest;
  prepared: BrowserGatewayPreparedMutation;
  nodeId: string;
  grantStore: Pick<BrowserGrantStore, 'listGrants'>;
  policy: Omit<BrowserUploadPolicyInput, 'approvedRoots' | 'autonomous'>;
}

/** Select consent covering this file without changing the upload safety policy. */
export function resolveBrowserUploadGrant(input: BrowserUploadGrantInput): {
  prepared: BrowserGatewayPreparedMutation;
  uploadDecision: BrowserUploadPolicyResult;
} {
  const { prepared, request } = input;
  const validate = (grant: BrowserGatewayPreparedMutation['grant']) => validateBrowserUploadPath({
    ...input.policy, approvedRoots: grant.uploadRoots ?? [], autonomous: grant.autonomous,
  });
  const uploadDecision = validate(prepared.grant);
  if (uploadDecision.allowed || uploadDecision.reason === 'file_not_found'
    || prepared.actionClass !== 'file-upload' || prepared.exactApprovalRequestId) {
    return { prepared, uploadDecision };
  }

  // A newer rootless grant, or consent for a different folder, must not hide
  // an older approval for this file. The full policy applies to every candidate:
  // true secrets/profile data never pass; hardlinks retain per-grant autonomy rules.
  const grants = input.grantStore.listGrants({
    instanceId: request.instanceId, profileId: request.profileId, nodeId: input.nodeId,
    authorizationOrigin: prepared.origin,
  });
  for (const candidate of grants) {
    if (candidate.id === prepared.grant.id || !candidate.uploadRoots?.length) continue;
    const match = findMatchingBrowserGrant({
      grants: [candidate], instanceId: request.instanceId ?? '', provider: providerFromContext(request.provider),
      profileId: request.profileId, targetId: request.targetId, nodeId: input.nodeId,
      origin: prepared.origin, actionClass: 'file-upload',
    });
    if (!match.grant) continue;
    const candidateDecision = validate(match.grant);
    if (candidateDecision.allowed) {
      return { prepared: { ...prepared, grant: match.grant }, uploadDecision: candidateDecision };
    }
  }
  return { prepared, uploadDecision };
}
