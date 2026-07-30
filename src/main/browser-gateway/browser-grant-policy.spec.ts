import { describe, expect, it } from 'vitest';
import type { BrowserPermissionGrant } from '@contracts/types/browser';
import type { BrowserGrantProposal } from '@contracts/types/browser';
import {
  findGrantCoveringProposal,
  findMatchingBrowserGrant,
  proposalCoversProposal,
} from './browser-grant-policy';

function grant(overrides: Partial<BrowserPermissionGrant> = {}): BrowserPermissionGrant {
  return {
    id: 'grant-1',
    mode: 'session',
    instanceId: 'instance-1',
    provider: 'copilot',
    profileId: 'profile-1',
    allowedOrigins: [
      {
        scheme: 'https',
        hostPattern: 'play.google.com',
        includeSubdomains: true,
      },
    ],
    allowedActionClasses: ['input'],
    allowExternalNavigation: false,
    autonomous: false,
    requestedBy: 'user',
    decidedBy: 'user',
    decision: 'allow',
    expiresAt: 10_000,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('browser-grant-policy', () => {
  it('matches only active grants for the same instance profile origin and action class', () => {
    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).grant?.id,
    ).toBe('grant-1');

    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'other',
        provider: 'copilot',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');

    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'instance-1',
        provider: 'claude',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');
  });

  it('never matches a payment action, even under a blanket autonomous grant', () => {
    const paymentGrant = grant({
      autonomous: true,
      allowedActionClasses: ['payment', 'input', 'submit'],
    });
    expect(
      findMatchingBrowserGrant({
        grants: [paymentGrant],
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'payment',
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');
  });

  it('rejects expired revoked consumed and unsafe autonomous grants', () => {
    for (const candidate of [
      grant({ expiresAt: 1_999 }),
      grant({ revokedAt: 1_500 }),
      grant({ consumedAt: 1_500 }),
      grant({ autonomous: true, allowedActionClasses: ['input'] }),
    ]) {
      expect(
        findMatchingBrowserGrant({
          grants: [candidate],
          instanceId: 'instance-1',
          profileId: 'profile-1',
          origin: 'https://play.google.com',
          actionClass: 'submit',
          autonomousRequired: true,
          now: 2_000,
        }).grant,
      ).toBeUndefined();
    }
  });

  it('requires explicit autonomous dangerous action classes', () => {
    expect(
      findMatchingBrowserGrant({
        grants: [
          grant({
            mode: 'autonomous',
            autonomous: true,
            allowedActionClasses: ['input', 'submit'],
          }),
        ],
        instanceId: 'instance-1',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'submit',
        autonomousRequired: true,
        now: 2_000,
      }).grant?.id,
    ).toBe('grant-1');

    expect(
      findMatchingBrowserGrant({
        grants: [
          grant({
            mode: 'autonomous',
            autonomous: true,
            allowedActionClasses: ['input'],
          }),
        ],
        instanceId: 'instance-1',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        actionClass: 'submit',
        autonomousRequired: true,
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');
  });

  it('stops when the live origin no longer matches the classified origin', () => {
    expect(
      findMatchingBrowserGrant({
        grants: [grant()],
        instanceId: 'instance-1',
        profileId: 'profile-1',
        origin: 'https://play.google.com',
        liveOrigin: 'https://evil.example',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('origin_changed_before_execution');
  });

  it('matches node-scoped grants only on the same node when profile ids churn', () => {
    const nodeGrant = grant({
      profileId: undefined,
      targetId: undefined,
      nodeId: 'node-1',
    } as Partial<BrowserPermissionGrant>);

    expect(
      findMatchingBrowserGrant({
        grants: [nodeGrant],
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'existing-tab:n.node-1:8:99',
        nodeId: 'node-1',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).grant?.id,
    ).toBe('grant-1');

    expect(
      findMatchingBrowserGrant({
        grants: [nodeGrant],
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'existing-tab:n.node-2:8:99',
        nodeId: 'node-2',
        origin: 'https://play.google.com',
        actionClass: 'input',
        now: 2_000,
      }).reason,
    ).toBe('no_matching_grant');
  });
  describe('findGrantCoveringProposal', () => {
    function proposal(overrides: Partial<BrowserGrantProposal> = {}): BrowserGrantProposal {
      return {
        mode: 'session',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: true,
          },
        ],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
        ...overrides,
      };
    }

    const scope = {
      instanceId: 'instance-1',
      provider: 'copilot' as const,
      profileId: 'profile-1',
      origin: 'https://play.google.com',
      now: 2_000,
    };

    it('returns the live grant that already covers every requested class and origin', () => {
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({ allowedActionClasses: ['read', 'input'] })],
          proposal: proposal({ allowedActionClasses: ['read', 'input'] }),
        })?.id,
      ).toBe('grant-1');
    });

    it('treats a broader mode as covering a narrower one but never the reverse', () => {
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({ mode: 'autonomous', autonomous: true })],
          proposal: proposal({ mode: 'session' }),
        })?.id,
      ).toBe('grant-1');

      // per_action grants are consumed by the next mutation, so they cannot
      // stand in for a session request.
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({ mode: 'per_action' })],
          proposal: proposal({ mode: 'session' }),
        }),
      ).toBeNull();
    });

    it('requires an autonomous grant for submit and destructive proposals', () => {
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({ allowedActionClasses: ['input', 'submit'] })],
          proposal: proposal({ allowedActionClasses: ['input', 'submit'] }),
        }),
      ).toBeNull();

      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({
            mode: 'autonomous',
            autonomous: true,
            allowedActionClasses: ['input', 'submit'],
          })],
          proposal: proposal({ allowedActionClasses: ['input', 'submit'] }),
        })?.id,
      ).toBe('grant-1');
    });

    it('refuses to reuse a grant that misses any requested class, origin, or capability', () => {
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({ allowedActionClasses: ['read'] })],
          proposal: proposal({ allowedActionClasses: ['read', 'input'] }),
        }),
      ).toBeNull();

      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant()],
          proposal: proposal({
            allowedOrigins: [
              { scheme: 'https', hostPattern: 'developer.apple.com', includeSubdomains: false },
            ],
          }),
        }),
      ).toBeNull();

      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant()],
          proposal: proposal({ allowExternalNavigation: true }),
        }),
      ).toBeNull();

      // Upload roots are approved per path set — never inferred from a grant.
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant({
            allowedActionClasses: ['file-upload'],
            uploadRoots: ['/tmp'],
          })],
          proposal: proposal({
            allowedActionClasses: ['file-upload'],
            uploadRoots: ['/tmp'],
          }),
        }),
      ).toBeNull();

      // Nothing requested means nothing to cover.
      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [grant()],
          proposal: proposal({ allowedActionClasses: [] }),
        }),
      ).toBeNull();
    });

    it('ignores expired, revoked, consumed, and other-instance grants', () => {
      for (const overrides of [
        { expiresAt: 1_500 },
        { revokedAt: 1_800 },
        { consumedAt: 1_800 },
        { instanceId: 'other-instance' },
        { provider: 'claude' as const },
      ]) {
        expect(
          findGrantCoveringProposal({
            ...scope,
            grants: [grant(overrides)],
            proposal: proposal(),
          }),
        ).toBeNull();
      }
    });

    it('matches node-scoped existing-tab grants only for their own node', () => {
      const nodeGrant = grant({
        profileId: undefined,
        nodeId: 'node-1',
        mode: 'autonomous',
        autonomous: true,
        allowedActionClasses: ['read', 'submit'],
      });

      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [nodeGrant],
          nodeId: 'node-1',
          profileId: 'existing-tab:n.node-1:8:99',
          proposal: proposal({ allowedActionClasses: ['read', 'submit'] }),
        })?.id,
      ).toBe('grant-1');

      expect(
        findGrantCoveringProposal({
          ...scope,
          grants: [nodeGrant],
          nodeId: 'node-2',
          profileId: 'existing-tab:n.node-2:8:99',
          proposal: proposal({ allowedActionClasses: ['read', 'submit'] }),
        }),
      ).toBeNull();
    });
  });
  describe('proposalCoversProposal', () => {
    const base: BrowserGrantProposal = {
      mode: 'session',
      allowedOrigins: [
        { scheme: 'https', hostPattern: 'play.google.com', includeSubdomains: true },
      ],
      allowedActionClasses: ['read', 'input'],
      allowExternalNavigation: false,
      autonomous: false,
    };

    it('covers an identical or narrower ask', () => {
      expect(proposalCoversProposal(base, base)).toBe(true);
      expect(proposalCoversProposal(base, { ...base, allowedActionClasses: ['read'] })).toBe(true);
      expect(
        proposalCoversProposal({ ...base, mode: 'autonomous', autonomous: true }, base),
      ).toBe(true);
    });

    it('does not cover a broader ask', () => {
      expect(
        proposalCoversProposal(base, { ...base, allowedActionClasses: ['read', 'submit'] }),
      ).toBe(false);
      expect(proposalCoversProposal(base, { ...base, mode: 'autonomous' })).toBe(false);
      expect(proposalCoversProposal(base, { ...base, autonomous: true })).toBe(false);
      expect(proposalCoversProposal(base, { ...base, allowExternalNavigation: true })).toBe(false);
      expect(proposalCoversProposal(base, { ...base, uploadRoots: ['/tmp'] })).toBe(false);
      expect(proposalCoversProposal(base, { ...base, allowedActionClasses: [] })).toBe(false);
      expect(
        proposalCoversProposal(base, {
          ...base,
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'developer.apple.com', includeSubdomains: false },
          ],
        }),
      ).toBe(false);
    });
  });
});
