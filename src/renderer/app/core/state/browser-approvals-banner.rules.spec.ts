import { describe, expect, it } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import {
  bannerCanQuickApprove,
  bannerConfirmationPhrase,
  bannerGrantModes,
  bannerGrantRequiresConfirmation,
  bannerModeLabel,
  buildBannerGrant,
} from './browser-approvals-banner.rules';

function makeApproval(overrides: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest {
  return {
    id: 'row-1',
    requestId: 'request-1',
    instanceId: 'instance-1',
    provider: 'claude',
    profileId: 'existing-tab:7:42',
    targetId: 'existing-tab:7:42:target',
    toolName: 'browser.request_grant',
    action: 'request_grant',
    actionClass: 'submit',
    origin: 'https://education.app.jaggaer.com',
    proposedGrant: {
      mode: 'session',
      allowedOrigins: [
        { scheme: 'https', hostPattern: 'education.app.jaggaer.com', includeSubdomains: false },
      ],
      allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
      allowExternalNavigation: false,
      autonomous: false,
    },
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('browser-approvals-banner.rules', () => {
  it('offers once and session for a request_grant that includes submit', () => {
    const approval = makeApproval();
    expect(bannerCanQuickApprove(approval)).toBe(true);
    expect(bannerGrantModes(approval)).toEqual(['per_action', 'session']);
    expect(bannerModeLabel('per_action')).toBe('Approve once');
    expect(buildBannerGrant(approval, 'session')).toEqual({
      mode: 'session',
      allowedOrigins: approval.proposedGrant.allowedOrigins,
      allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
      allowExternalNavigation: false,
      autonomous: false,
    });
  });

  it('keeps the full proposed classes on Approve once for request_grant', () => {
    const approval = makeApproval();
    expect(buildBannerGrant(approval, 'per_action')?.allowedActionClasses).toEqual([
      'read',
      'navigate',
      'input',
      'submit',
    ]);
  });

  it('offers Always allow only for low-risk proposals', () => {
    const approval = makeApproval({
      actionClass: 'input',
      proposedGrant: {
        mode: 'autonomous',
        allowedOrigins: [],
        allowedActionClasses: ['read', 'navigate', 'input'],
        allowExternalNavigation: false,
        autonomous: true,
      },
    });
    expect(bannerGrantModes(approval)).toEqual(['per_action', 'session', 'autonomous']);
    expect(buildBannerGrant(approval, 'autonomous')).toMatchObject({
      mode: 'autonomous',
      allowedActionClasses: ['read', 'navigate', 'input'],
      autonomous: true,
    });
  });

  it('narrows Allow once on a mutation to the classified action', () => {
    const approval = makeApproval({
      toolName: 'browser.type',
      action: 'type',
      actionClass: 'input',
      proposedGrant: {
        mode: 'autonomous',
        allowedOrigins: [],
        allowedActionClasses: ['read', 'navigate', 'input'],
        allowExternalNavigation: false,
        autonomous: true,
      },
    });
    expect(buildBannerGrant(approval, 'per_action')).toMatchObject({
      mode: 'per_action',
      allowedActionClasses: ['input'],
      autonomous: false,
    });
  });

  it('exposes only Approve once for credential hard stops', () => {
    const approval = makeApproval({
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'credential',
      proposedGrant: {
        mode: 'autonomous',
        allowedOrigins: [],
        allowedActionClasses: ['credential'],
        allowExternalNavigation: false,
        autonomous: true,
      },
    });
    expect(bannerGrantModes(approval)).toEqual(['per_action']);
    expect(buildBannerGrant(approval, 'session')).toBeNull();
  });

  it.each(['payment', 'financial_identity', 'sensitive_identity'] as const)(
    'withholds banner approval for %s proposals',
    (actionClass) => {
      const approval = makeApproval({
        actionClass,
        proposedGrant: {
          mode: 'per_action',
          allowedOrigins: [],
          allowedActionClasses: [actionClass],
          allowExternalNavigation: false,
          autonomous: false,
        },
      });
      expect(bannerCanQuickApprove(approval)).toBe(false);
      expect(buildBannerGrant(approval, 'per_action')).toBeNull();
    },
  );

  it('withholds banner approval when a never-grantable class is mixed into the proposal', () => {
    const approval = makeApproval({
      actionClass: 'input',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [],
        allowedActionClasses: ['read', 'input', 'payment'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    });
    expect(bannerCanQuickApprove(approval)).toBe(false);
    expect(buildBannerGrant(approval, 'session')).toBeNull();
  });

  it('does not offer Always allow for file-upload or file-download', () => {
    for (const actionClass of ['file-upload', 'file-download'] as const) {
      const approval = makeApproval({
        toolName: actionClass === 'file-upload' ? 'browser.upload_file' : 'browser.download_file',
        action: actionClass === 'file-upload' ? 'upload_file' : 'download_file',
        actionClass,
        proposedGrant: {
          mode: 'session',
          allowedOrigins: [],
          allowedActionClasses: [actionClass],
          allowExternalNavigation: false,
          autonomous: false,
        },
      });
      expect(bannerGrantModes(approval)).toEqual(['per_action', 'session']);
    }
  });

  it('requires the host phrase before minting submit or destructive classes', () => {
    const submitGrant = buildBannerGrant(makeApproval(), 'session');
    expect(submitGrant).not.toBeNull();
    expect(bannerGrantRequiresConfirmation(submitGrant!)).toBe(true);
    expect(bannerConfirmationPhrase(makeApproval())).toBe('education.app.jaggaer.com');

    const destructive = makeApproval({
      actionClass: 'destructive',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [],
        allowedActionClasses: ['read', 'destructive'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    });
    expect(bannerGrantModes(destructive)).toEqual(['per_action', 'session']);
    expect(bannerGrantRequiresConfirmation(buildBannerGrant(destructive, 'per_action')!)).toBe(true);
  });
});
