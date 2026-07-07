import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserApprovalRequest,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import { autoApproveBrowserApproval } from './browser-auto-approve';

function makeApproval(
  overrides: Partial<BrowserApprovalRequest> = {},
): BrowserApprovalRequest {
  return {
    id: 'approval-1',
    requestId: 'request-1',
    instanceId: 'instance-1',
    provider: 'claude',
    profileId: 'profile-1',
    targetId: 'target-1',
    toolName: 'browser.type',
    action: 'type',
    actionClass: 'input',
    origin: 'https://example.com',
    url: 'https://example.com/form',
    proposedGrant: {
      mode: 'per_action',
      allowedOrigins: [
        { scheme: 'https', hostPattern: 'example.com', includeSubdomains: false },
      ],
      allowedActionClasses: ['input'],
      allowExternalNavigation: false,
      autonomous: false,
    },
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

function makeStores() {
  const grant = { id: 'grant-1' } as BrowserPermissionGrant;
  return {
    grant,
    approvalStore: { resolveRequest: vi.fn() },
    grantStore: { createGrant: vi.fn().mockReturnValue(grant) },
  };
}

describe('autoApproveBrowserApproval', () => {
  it('approves a non-excluded action class when the predicate allows it', () => {
    const { grant, approvalStore, grantStore } = makeStores();

    const result = autoApproveBrowserApproval({
      approval: makeApproval(),
      approvalStore,
      grantStore,
      autoApproveRequests: () => true,
      now: () => 5_000,
    });

    expect(result).toBe(grant);
    expect(grantStore.createGrant).toHaveBeenCalledTimes(1);
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('never auto-approves a grant that would carry the credential class, even with an always-true predicate', () => {
    const { approvalStore, grantStore } = makeStores();
    const predicate = vi.fn().mockReturnValue(true);

    const result = autoApproveBrowserApproval({
      approval: makeApproval({
        actionClass: 'credential',
        proposedGrant: {
          mode: 'per_action',
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'example.com', includeSubdomains: false },
          ],
          allowedActionClasses: ['credential'],
          allowExternalNavigation: false,
          autonomous: false,
        },
      }),
      approvalStore,
      grantStore,
      autoApproveRequests: predicate,
    });

    // The exclusion must short-circuit BEFORE the predicate runs: an
    // auto-approved credential grant executes the pending mutation (typing a
    // password/2FA/captcha) directly, so YOLO-mode predicates must never
    // even be consulted for it.
    expect(result).toBeNull();
    expect(predicate).not.toHaveBeenCalled();
    expect(grantStore.createGrant).not.toHaveBeenCalled();
    expect(approvalStore.resolveRequest).not.toHaveBeenCalled();
  });

  it('still auto-approves credential-class manual-handoff approvals whose proposed grant is read-only', () => {
    const { grant, approvalStore, grantStore } = makeStores();

    // request_user_login / pause_for_manual_step approvals are classified
    // `credential` but propose a read-only grant: auto-approving them only
    // surfaces the handoff — the human still performs the login themselves.
    const result = autoApproveBrowserApproval({
      approval: makeApproval({
        actionClass: 'credential',
        toolName: 'browser.request_user_login',
        proposedGrant: {
          mode: 'per_action',
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'example.com', includeSubdomains: false },
          ],
          allowedActionClasses: ['read'],
          allowExternalNavigation: false,
          autonomous: false,
        },
      }),
      approvalStore,
      grantStore,
      autoApproveRequests: () => true,
    });

    expect(result).toBe(grant);
    expect(grantStore.createGrant).toHaveBeenCalledTimes(1);
  });

  it('returns null when the predicate declines', () => {
    const { approvalStore, grantStore } = makeStores();

    const result = autoApproveBrowserApproval({
      approval: makeApproval(),
      approvalStore,
      grantStore,
      autoApproveRequests: () => false,
    });

    expect(result).toBeNull();
    expect(grantStore.createGrant).not.toHaveBeenCalled();
    expect(approvalStore.resolveRequest).not.toHaveBeenCalled();
  });

  it('returns null when the predicate throws', () => {
    const { approvalStore, grantStore } = makeStores();

    const result = autoApproveBrowserApproval({
      approval: makeApproval(),
      approvalStore,
      grantStore,
      autoApproveRequests: () => {
        throw new Error('boom');
      },
    });

    expect(result).toBeNull();
    expect(grantStore.createGrant).not.toHaveBeenCalled();
  });
});
