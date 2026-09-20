import { describe, expect, it } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserApproveRequestPayloadSchema } from '@contracts/schemas/browser';
import { buildBrowserGrantProposal } from '../../features/browser/browser-page-view.utils';
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
  it('offers all durations for a request_grant that includes submit', () => {
    const approval = makeApproval();
    expect(bannerCanQuickApprove(approval)).toBe(true);
    expect(bannerGrantModes(approval)).toEqual(['per_action', 'session', 'autonomous', 'persistent']);
    expect(bannerModeLabel('per_action')).toBe('Approve once');
    expect(bannerModeLabel('autonomous')).toBe('Allow unattended');
    expect(bannerModeLabel('persistent')).toBe('Allow forever');
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

  it('offers unattended and forever for ordinary browsing proposals', () => {
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
    expect(bannerGrantModes(approval)).toEqual(['per_action', 'session', 'autonomous', 'persistent']);
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

  it('offers reusable credential approvals scoped to the proposed classes', () => {
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
    expect(bannerGrantModes(approval)).toEqual(['per_action', 'session', 'autonomous', 'persistent']);
    expect(buildBannerGrant(approval, 'persistent')).toMatchObject({
      mode: 'persistent',
      allowedActionClasses: ['credential'],
      autonomous: true,
    });
  });

  it('keeps unclassified actions once-only', () => {
    const approval = makeApproval({
      actionClass: 'unknown',
      proposedGrant: {
        ...makeApproval().proposedGrant,
        allowedActionClasses: ['input', 'unknown'],
      },
    });
    expect(bannerGrantModes(approval)).toEqual(['per_action']);
    expect(buildBannerGrant(approval, 'session')).toBeNull();
    expect(buildBannerGrant(approval, 'autonomous')).toBeNull();
    expect(buildBannerGrant(approval, 'persistent')).toBeNull();
    expect(buildBannerGrant(approval, 'per_action')?.allowedActionClasses).toEqual(['unknown']);
    expect(buildBrowserGrantProposal(approval, 'per_action', true, true)?.allowedActionClasses)
      .toEqual(['unknown']);
    for (const mode of ['session', 'autonomous', 'persistent'] as const) {
      expect(buildBrowserGrantProposal(approval, mode, true, true)).toBeNull();
    }
  });

  it.each(['per_action', 'session', 'autonomous', 'persistent'] as const)(
    'uses the same eligible action classes in both surfaces for %s', (mode) => {
      const approval = makeApproval({
        actionClass: 'input',
        proposedGrant: {
          ...makeApproval().proposedGrant,
          allowedActionClasses: ['input', 'unknown'],
        },
      });
      const banner = buildBannerGrant(approval, mode);
      const page = buildBrowserGrantProposal(approval, mode, false, false);
      expect(page).toEqual(banner);
      expect(page?.allowedActionClasses).toEqual(mode === 'per_action' ? ['input', 'unknown'] : ['input']);
      expect(BrowserApproveRequestPayloadSchema.safeParse({ requestId: approval.requestId, grant: page }).success)
        .toBe(true);

      const mutation = { ...approval, toolName: 'browser.click', action: 'click' };
      expect(buildBrowserGrantProposal(mutation, mode, false, false))
        .toEqual(buildBannerGrant(mutation, mode));
      expect(buildBrowserGrantProposal(mutation, mode, false, false)?.allowedActionClasses).toEqual(['input']);
    },
  );

  it.each(['banner', 'page'] as const)(
    '%s forever approvals narrow wildcard and multi-site proposals before IPC validation', (surface) => {
      const approval = makeApproval({
        origin: 'https://login.example.com:8443',
        proposedGrant: {
          ...makeApproval().proposedGrant,
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'example.com', includeSubdomains: true },
            { scheme: 'https', hostPattern: 'second.example.net', includeSubdomains: false },
          ],
        },
      });
      const grant = surface === 'banner'
        ? buildBannerGrant(approval, 'persistent')
        : buildBrowserGrantProposal(approval, 'persistent', false, false);

      expect(grant?.allowedOrigins).toEqual([
        { scheme: 'https', hostPattern: 'login.example.com', port: 8443, includeSubdomains: false },
      ]);
      expect(BrowserApproveRequestPayloadSchema.safeParse({
        requestId: approval.requestId, grant,
      }).success).toBe(true);
      expect(approval.proposedGrant.allowedOrigins).toHaveLength(2);
      expect(approval.proposedGrant.allowedOrigins[0]?.includeSubdomains).toBe(true);
      expect(buildBannerGrant(approval, 'autonomous')?.allowedOrigins)
        .toEqual(approval.proposedGrant.allowedOrigins);
      expect(buildBrowserGrantProposal(approval, 'autonomous', false, false)?.allowedOrigins)
        .toEqual(approval.proposedGrant.allowedOrigins);
    },
  );

  it('uses the displayed URL when no origin was supplied and omits default ports', () => {
    const approval = makeApproval({ origin: undefined, url: 'https://login.example.com:443/login' });
    const expected = [{ scheme: 'https', hostPattern: 'login.example.com', includeSubdomains: false }];
    expect(buildBannerGrant(approval, 'persistent')?.allowedOrigins).toEqual(expected);
    expect(buildBrowserGrantProposal(approval, 'persistent', false, false)?.allowedOrigins).toEqual(expected);
  });

  it.each([undefined, '', 'invalid', 'file:///tmp/page.html', 'https://*.example.com'])(
    'withholds forever without an exact HTTP site (%s)', (origin) => {
      const approval = makeApproval({ origin, url: undefined });
      expect(bannerGrantModes(approval)).toEqual(['per_action', 'session', 'autonomous']);
      expect(buildBannerGrant(approval, 'persistent')).toBeNull();
      expect(buildBrowserGrantProposal(approval, 'persistent', false, false)).toBeNull();
    },
  );

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
      for (const mode of ['per_action', 'session', 'autonomous', 'persistent'] as const) {
        expect(buildBrowserGrantProposal(approval, mode, true, true)).toBeNull();
      }
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
    expect(buildBrowserGrantProposal(approval, 'session', false, false)).toBeNull();
    expect(buildBrowserGrantProposal(approval, 'persistent', true, true)).toBeNull();
  });

  it('offers unattended and forever for file-upload and file-download', () => {
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
      expect(bannerGrantModes(approval)).toEqual(['per_action', 'session', 'autonomous', 'persistent']);
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
    expect(bannerGrantModes(destructive)).toEqual(['per_action', 'session', 'autonomous', 'persistent']);
    expect(bannerGrantRequiresConfirmation(buildBannerGrant(destructive, 'per_action')!)).toBe(true);
    expect(bannerGrantRequiresConfirmation(buildBannerGrant(destructive, 'autonomous')!)).toBe(true);
    expect(bannerGrantRequiresConfirmation(buildBannerGrant(destructive, 'persistent')!)).toBe(true);
  });
});
