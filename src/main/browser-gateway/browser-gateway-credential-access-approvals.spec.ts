import { describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest, BrowserGatewayResult, BrowserPermissionGrant } from '@contracts/types/browser';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';

function accessRequest(): BrowserApprovalRequest {
  return {
    id: 'placeholder-request', requestId: 'placeholder-request', instanceId: 'placeholder-session',
    provider: 'claude', profileId: 'placeholder-profile', targetId: 'placeholder-target',
    toolName: 'browser.request_credential_access', action: 'request_credential_access', actionClass: 'credential',
    origin: 'https://login.example.com', url: 'https://login.example.com/login',
    proposedGrant: {
      mode: 'session', allowedOrigins: [{ scheme: 'https', hostPattern: 'login.example.com', includeSubdomains: false }],
      allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false,
    },
    credentialAccess: {
      taskScope: 'conversation:placeholder-task', sessionName: 'Example session', reason: 'Finish sign-in',
      origin: 'https://login.example.com', computerName: 'windows-pc', computerId: 'placeholder-computer', scope: 'placeholder-scope',
      vaultItemRef: 'placeholder-item', itemTitle: 'Example login', vaultFolder: 'AgentVault',
      moveIntoFolder: false, purposes: ['login'], permission: 'task',
    },
    status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 30_000,
  };
}

function setup(approval = accessRequest()) {
  const approvalStore = {
    getRequest: vi.fn(() => approval), listRequests: vi.fn(() => [approval]), resolveRequest: vi.fn(),
  };
  const grantStore = {
    getGrant: vi.fn(() => null as BrowserPermissionGrant | null),
    listGrants: vi.fn(() => []),
    createGrant: vi.fn((input) => ({ ...input, id: 'placeholder-grant', createdAt: Date.now() })),
    revokeGrant: vi.fn(() => null as BrowserPermissionGrant | null),
  };
  const approved: BrowserGatewayResult<BrowserPermissionGrant | null> = {
    decision: 'allowed', outcome: 'failed', reason: 'vault_locked', data: null, auditId: 'placeholder-audit',
  };
  const denied: BrowserGatewayResult<BrowserApprovalRequest | null> = {
    decision: 'allowed', outcome: 'succeeded', data: { ...approval, status: 'denied' }, auditId: 'placeholder-audit',
  };
  const approveCredentialAccess = vi.fn(async () => approved);
  const denyCredentialAccess = vi.fn(async () => denied);
  const autoApproveApproval = vi.fn();
  const revokeCredentialAccess = vi.fn();
  const operations = new BrowserGatewayApprovalOperations({
    approvalStore, grantStore, approveCredentialAccess, denyCredentialAccess, autoApproveApproval, revokeCredentialAccess,
    refreshCredentialAccess: (request) => request,
    profileStore: { getProfile: () => null, setRuntimeState: vi.fn() },
    result: (params) => ({
      decision: params.decision, outcome: params.outcome, data: params.data, auditId: 'placeholder-audit',
    }) as BrowserGatewayResult<never>,
  });
  return { operations, approval, approvalStore, grantStore, approveCredentialAccess, denyCredentialAccess, autoApproveApproval, revokeCredentialAccess, approved, denied };
}

describe('Credential access approval routing', () => {
  it('delegates enrolment and preserves its truthful failed result without minting a generic grant', async () => {
    const ctx = setup();
    const choice = { permission: 'remember' as const, rememberForMs: 3_600_000 };
    const result = await ctx.operations.approveRequest({
      requestId: ctx.approval.requestId, grant: ctx.approval.proposedGrant, credentialAccess: choice,
    });
    expect(result).toBe(ctx.approved);
    expect(ctx.approveCredentialAccess).toHaveBeenCalledWith(ctx.approval, choice);
    expect(ctx.grantStore.createGrant).not.toHaveBeenCalled();
    expect(ctx.approvalStore.resolveRequest).not.toHaveBeenCalled();
  });

  it('delegates denial to the same credential request service', async () => {
    const ctx = setup();
    const result = await ctx.operations.denyRequest({ requestId: ctx.approval.requestId });
    expect(result).toBe(ctx.denied);
    expect(ctx.denyCredentialAccess).toHaveBeenCalledWith(ctx.approval);
    expect(ctx.approvalStore.resolveRequest).not.toHaveBeenCalled();
  });

  it('never policy-approves pending credential access while the banner polls', async () => {
    const ctx = setup();
    const listed = await ctx.operations.listApprovalRequests({ status: 'pending' });
    const status = await ctx.operations.getApprovalStatus({ requestId: ctx.approval.requestId, instanceId: ctx.approval.instanceId });
    expect(listed.data).toEqual([ctx.approval]);
    expect(status.data?.status).toBe('pending');
    expect(ctx.autoApproveApproval).not.toHaveBeenCalled();
    expect(ctx.approveCredentialAccess).not.toHaveBeenCalled();
  });

  it('keeps manual acknowledgement read-only even when a generic UI proposes credential access', async () => {
    const approval = accessRequest();
    delete approval.credentialAccess;
    approval.toolName = 'browser.request_user_login';
    const ctx = setup(approval);
    await ctx.operations.approveRequest({ requestId: approval.requestId, grant: approval.proposedGrant });
    expect(ctx.grantStore.createGrant).toHaveBeenCalledWith(expect.objectContaining({
      allowedActionClasses: ['read'], mode: 'per_action', autonomous: false, userApprovedCredentials: false,
    }));
    expect(ctx.approveCredentialAccess).not.toHaveBeenCalled();
  });

  it('revokes saved-login authority even when the user replaces the browser grant reason', async () => {
    const ctx = setup();
    const original: BrowserPermissionGrant = {
      ...ctx.approval.proposedGrant, id: 'placeholder-grant', createdAt: Date.now(),
      instanceId: ctx.approval.instanceId, provider: ctx.approval.provider,
      requestedBy: ctx.approval.instanceId, decidedBy: 'user', decision: 'allow',
      expiresAt: Date.now() + 60_000, reason: 'saved_login_access_approved', userApprovedCredentials: true,
    };
    ctx.grantStore.getGrant.mockReturnValue(original);
    ctx.grantStore.revokeGrant.mockReturnValue({ ...original, reason: 'User withdrew access', revokedAt: Date.now() });
    const result = await ctx.operations.revokeGrant({ grantId: original.id, reason: 'User withdrew access' });
    expect(result.outcome).toBe('succeeded');
    expect(ctx.revokeCredentialAccess).toHaveBeenCalledExactlyOnceWith(original.id);
  });

  it('does not revoke credential authority for an unrelated browser grant', async () => {
    const ctx = setup();
    const grant: BrowserPermissionGrant = {
      ...ctx.approval.proposedGrant, id: 'placeholder-grant', createdAt: Date.now(),
      instanceId: ctx.approval.instanceId, provider: ctx.approval.provider,
      requestedBy: ctx.approval.instanceId, decidedBy: 'user', decision: 'allow',
      expiresAt: Date.now() + 60_000, reason: 'Ordinary browser access',
    };
    ctx.grantStore.getGrant.mockReturnValue(grant);
    ctx.grantStore.revokeGrant.mockReturnValue(grant);
    await ctx.operations.revokeGrant({ grantId: grant.id });
    expect(ctx.revokeCredentialAccess).not.toHaveBeenCalled();
  });
});
