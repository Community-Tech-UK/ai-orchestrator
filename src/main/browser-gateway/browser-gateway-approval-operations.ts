import type {
  BrowserApprovalRequest,
  BrowserApprovalRequestLookup,
  BrowserApprovalStatusRequest,
  BrowserApproveRequestPayload,
  BrowserCreateGrantRequest,
  BrowserDenyRequestPayload,
  BrowserGatewayResult,
  BrowserGrantProposal,
  BrowserListApprovalRequestsRequest,
  BrowserListGrantsRequest,
  BrowserPermissionGrant,
  BrowserRevokeGrantRequest,
} from '@contracts/types/browser';
import { BrowserApproveRequestPayloadSchema, BrowserCreateGrantRequestSchema } from '@contracts/schemas/browser';
import type { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserGrantStore } from './browser-grant-store';
import type { BrowserProfileStore } from './browser-profile-store';
import {
  capGrantExpiresAt,
  defaultGrantExpiresAt,
  allowedOriginFromUrl,
  primaryActionClass,
} from './browser-gateway-service-helpers';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { requiresAutonomousGrant } from './browser-grant-policy';
import { grantScopeForApproval } from './browser-grant-scope';

interface BrowserGatewayApprovalOperationsDeps {
  approvalStore: Pick<BrowserApprovalStore, 'getRequest' | 'listRequests' | 'resolveRequest'>;
  grantStore: Pick<BrowserGrantStore, 'listGrants' | 'createGrant' | 'revokeGrant'>;
  profileStore: Pick<BrowserProfileStore, 'getProfile' | 'setRuntimeState'>;
  autoApproveApproval?: (approval: BrowserApprovalRequest) => BrowserPermissionGrant | null;
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

export class BrowserGatewayApprovalOperations {
  constructor(private readonly deps: BrowserGatewayApprovalOperationsDeps) {}

  async getApprovalStatus(
    request: BrowserGatewayContext & BrowserApprovalStatusRequest,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.deps.result({
        context: request,
        action: 'get_approval_status',
        toolName: 'browser.get_approval_status',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request was not found for this instance',
        data: null,
      });
    }

    const current = this.resolvePendingApprovalIfNeeded(
      this.expireApprovalIfNeeded(approval),
    );
    return this.deps.result({
      context: request,
      profileId: current.profileId,
      targetId: current.targetId,
      action: 'get_approval_status',
      toolName: 'browser.get_approval_status',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read Browser Gateway approval request status',
      data: current,
    });
  }

  async listApprovalRequests(
    request: BrowserGatewayContext & BrowserListApprovalRequestsRequest = {},
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest[]>> {
    const approvals = this.deps.approvalStore.listRequests({
      instanceId: request.instanceId,
      status: request.status,
      limit: request.limit ?? 100,
    })
      .map((approval) =>
        this.resolvePendingApprovalIfNeeded(this.expireApprovalIfNeeded(approval)),
      )
      .filter((approval) => !request.status || approval.status === request.status);
    return this.deps.result({
      context: request,
      action: 'list_approval_requests',
      toolName: 'browser.list_approval_requests',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Listed ${approvals.length} Browser Gateway approval requests`,
      data: approvals,
      // LT-217: BrowserApprovalsBannerComponent polls this every 5s on a
      // permanent timer purely to read pending state — a read-only UI poll,
      // not an agent-attributable browser decision. Audit-write it produced
      // ~1.1M rows with zero forensic value.
      recordAudit: false,
    });
  }

  async getApprovalRequest(
    request: BrowserGatewayContext & BrowserApprovalRequestLookup,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.deps.result({
        context: request,
        action: 'get_approval_request',
        toolName: 'browser.get_approval_request',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request was not found',
        data: null,
      });
    }
    const current = this.resolvePendingApprovalIfNeeded(
      this.expireApprovalIfNeeded(approval),
    );
    return this.deps.result({
      context: request,
      profileId: current.profileId,
      targetId: current.targetId,
      action: 'get_approval_request',
      toolName: 'browser.get_approval_request',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Read Browser Gateway approval request',
      data: current,
    });
  }

  async approveRequest(
    request: BrowserGatewayContext & BrowserApproveRequestPayload,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    BrowserApproveRequestPayloadSchema.parse({ requestId: request.requestId, grant: request.grant, reason: request.reason });
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.deps.result({
        context: request,
        action: 'approve_request',
        toolName: 'browser.approve_request',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request could not be approved because it was not found',
        data: null,
      });
    }
    if (approval.status !== 'pending' || approval.expiresAt <= Date.now()) {
      const current = this.expireApprovalIfNeeded(approval);
      return this.deps.result({
        context: request,
        profileId: approval.profileId,
        targetId: approval.targetId,
        action: 'approve_request',
        toolName: 'browser.approve_request',
        actionClass: approval.actionClass,
        decision: 'denied',
        outcome: 'not_run',
        reason: `approval_request_${current.status}`,
        summary: 'Browser approval request is no longer pending',
        data: null,
      });
    }

    const now = Date.now();
    const approvedGrant = normalizeApprovalGrant(approval, request.grant);
    const scope = grantScopeForApproval({
      profileId: approval.profileId,
      targetId: approval.targetId,
      // Persistent consent follows the trusted target, never an agent-authored
      // node hint retained in a pending proposal (including older requests).
      proposedNodeId: approvedGrant.mode === 'persistent' ? undefined : approvedGrant.nodeId,
    });
    if (approvedGrant.mode === 'persistent') {
      scope.nodeId ??= this.deps.profileStore.getProfile(approval.profileId)?.executionNodeId ?? 'local';
      // A managed profile's tabs are ephemeral; retain the profile and computer.
      delete scope.targetId;
    }
    const grant = this.deps.grantStore.createGrant({
      ...approvedGrant,
      // An explicit user "Allow" on an approval covering submit/destructive
      // classes must produce a grant that can actually authorize that action:
      // grantMatches() requires `autonomous: true` for those classes, so a
      // non-autonomous per_action/session grant would be dead on arrival and
      // the very next retry would re-prompt the user in a loop.
      autonomous:
        approvedGrant.mode === 'persistent' || (approvedGrant.mode === 'autonomous' && approvedGrant.autonomous) ||
        requiresAutonomousGrant(approvedGrant.allowedActionClasses),
      userApprovedCredentials: approvedGrant.mode !== 'per_action' && approvedGrant.allowedActionClasses.includes('credential'),
      instanceId: approval.instanceId,
      provider: approval.provider,
      ...scope,
      requestedBy: approval.instanceId,
      decidedBy: 'user',
      decision: 'allow',
      reason: request.reason,
      expiresAt: defaultGrantExpiresAt(approvedGrant.mode, now),
    });
    this.deps.approvalStore.resolveRequest(approval.requestId, {
      status: 'approved',
      grantId: grant.id,
    });
    if (approval.toolName === 'browser.request_user_login') {
      try {
        if (this.deps.profileStore.getProfile(approval.profileId)) {
          this.deps.profileStore.setRuntimeState(approval.profileId, {
            lastLoginCheckAt: now,
          });
        }
      } catch {
        // Existing-tab login handoffs do not have managed profile runtime state.
      }
    }

    return this.deps.result({
      context: request,
      profileId: approval.profileId,
      targetId: approval.targetId,
      action: 'approve_request',
      toolName: 'browser.approve_request',
      actionClass: approval.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Approved Browser Gateway request and created grant',
      origin: approval.origin,
      url: approval.url,
      requestId: undefined,
      grantId: grant.id,
      autonomous: grant.autonomous,
      data: grant,
    });
  }

  async denyRequest(
    request: BrowserGatewayContext & BrowserDenyRequestPayload,
  ): Promise<BrowserGatewayResult<BrowserApprovalRequest | null>> {
    const approval = this.getScopedApprovalRequest(request.requestId, request.instanceId);
    if (!approval) {
      return this.deps.result({
        context: request,
        action: 'deny_request',
        toolName: 'browser.deny_request',
        actionClass: 'read',
        decision: 'denied',
        outcome: 'not_run',
        reason: 'approval_request_not_found',
        summary: 'Browser approval request could not be denied because it was not found',
        data: null,
      });
    }
    const denied = this.deps.approvalStore.resolveRequest(approval.requestId, {
      status: 'denied',
    });
    return this.deps.result({
      context: request,
      profileId: approval.profileId,
      targetId: approval.targetId,
      action: 'deny_request',
      toolName: 'browser.deny_request',
      actionClass: approval.actionClass,
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Denied Browser Gateway approval request',
      origin: approval.origin,
      url: approval.url,
      data: denied,
    });
  }

  async createGrant(
    request: BrowserGatewayContext & BrowserCreateGrantRequest,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant>> {
    BrowserCreateGrantRequestSchema.parse(request);
    const now = Date.now();
    const grant = this.deps.grantStore.createGrant({
      mode: request.mode,
      instanceId: request.instanceId,
      provider: request.provider,
      nodeId: request.mode === 'persistent'
        ? (request.profileId ? this.deps.profileStore.getProfile(request.profileId)?.executionNodeId : request.nodeId) ?? 'local'
        : request.nodeId,
      profileId: request.profileId,
      targetId: request.mode === 'persistent' ? undefined : request.targetId,
      allowedOrigins: request.allowedOrigins,
      allowedActionClasses: request.allowedActionClasses,
      allowExternalNavigation: request.allowExternalNavigation,
      uploadRoots: request.uploadRoots,
      autonomous: request.mode === 'persistent' || request.mode === 'autonomous' && request.autonomous,
      userApprovedCredentials: request.mode !== 'per_action' && request.allowedActionClasses.includes('credential'),
      requestedBy: request.requestedBy,
      decidedBy: 'user',
      decision: 'allow',
      reason: request.reason,
      expiresAt: capGrantExpiresAt(request.mode, request.expiresAt, now),
    });
    return this.deps.result({
      context: request,
      profileId: grant.profileId,
      targetId: grant.targetId,
      action: 'create_grant',
      toolName: 'browser.create_grant',
      actionClass: primaryActionClass(grant.allowedActionClasses),
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'Created Browser Gateway grant',
      grantId: grant.id,
      autonomous: grant.autonomous,
      data: grant,
    });
  }

  async listGrants(
    request: BrowserGatewayContext & BrowserListGrantsRequest = {},
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant[]>> {
    const grants = this.deps.grantStore.listGrants({
      instanceId: request.instanceId,
      nodeId: request.nodeId,
      profileId: request.profileId,
      includeExpired: request.includeExpired,
      limit: request.limit ?? 100,
      before: request.before,
    });
    return this.deps.result({
      context: request,
      profileId: request.profileId,
      action: 'list_grants',
      toolName: 'browser.list_grants',
      actionClass: 'read',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Listed ${grants.length} Browser Gateway grants`,
      data: grants,
    });
  }

  async revokeGrant(
    request: BrowserGatewayContext & BrowserRevokeGrantRequest,
  ): Promise<BrowserGatewayResult<BrowserPermissionGrant | null>> {
    if (request.instanceId) {
      const ownGrant = this.deps.grantStore.listGrants({
        instanceId: request.instanceId,
        includeExpired: true,
      }).find((grant) => grant.id === request.grantId && grant.instanceId === request.instanceId && grant.mode !== 'persistent');
      if (!ownGrant) {
        return this.deps.result({
          context: request,
          action: 'revoke_grant',
          toolName: 'browser.revoke_grant',
          actionClass: 'read',
          decision: 'denied',
          outcome: 'not_run',
          reason: 'grant_not_found_for_instance',
          summary: 'Browser grant was not found for this instance',
          data: null,
        });
      }
    }
    const revoked = this.deps.grantStore.revokeGrant(request.grantId, request.reason);
    return this.deps.result({
      context: request,
      profileId: revoked?.profileId,
      targetId: revoked?.targetId,
      action: 'revoke_grant',
      toolName: 'browser.revoke_grant',
      actionClass: 'read',
      decision: revoked ? 'allowed' : 'denied',
      outcome: revoked ? 'succeeded' : 'not_run',
      reason: revoked ? undefined : 'grant_not_found',
      summary: revoked ? 'Revoked Browser Gateway grant' : 'Browser grant was not found',
      grantId: revoked?.id,
      autonomous: revoked?.autonomous,
      data: revoked,
    });
  }

  private getScopedApprovalRequest(
    requestId: string,
    instanceId?: string,
  ): BrowserApprovalRequest | null {
    return this.deps.approvalStore.getRequest(requestId, instanceId);
  }

  private expireApprovalIfNeeded(approval: BrowserApprovalRequest): BrowserApprovalRequest {
    if (approval.status !== 'pending' || approval.expiresAt > Date.now()) {
      return approval;
    }
    return this.deps.approvalStore.resolveRequest(approval.requestId, {
      status: 'expired',
    }) ?? approval;
  }

  private resolvePendingApprovalIfNeeded(approval: BrowserApprovalRequest): BrowserApprovalRequest {
    if (approval.status !== 'pending') {
      return approval;
    }
    const grant = this.deps.autoApproveApproval?.(approval);
    if (!grant) {
      return approval;
    }
    return this.deps.approvalStore.getRequest(approval.requestId) ?? {
      ...approval,
      status: 'approved',
      grantId: grant.id,
      decidedAt: Date.now(),
    };
  }
}

/** Unknown actions remain exact-only; reusable credential consent is an explicit operator choice. */
function normalizeApprovalGrant(
  approval: BrowserApprovalRequest,
  requested: BrowserGrantProposal,
): BrowserGrantProposal {
  if (approval.actionClass !== 'unknown' && (
    approval.actionClass !== 'credential' || requested.mode !== 'per_action'
  )) {
    if (requested.mode === 'persistent') {
      const origin = allowedOriginFromUrl(approval.origin ?? approval.url ?? '');
      if (!origin) throw new Error('persistent_grant_requires_explicit_origin');
      return { ...requested, nodeId: undefined, allowedOrigins: [origin], autonomous: true };
    }
    return requested;
  }
  return {
    ...approval.proposedGrant,
    mode: 'per_action',
    allowedActionClasses: [approval.actionClass],
    allowExternalNavigation: false,
    autonomous: false,
  };
}
