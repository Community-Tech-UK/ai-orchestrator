import { describe, expect, it, vi } from 'vitest';
import { BrowserCloseTabOperations } from './browser-close-tab-operations';
import { makeGrant } from './browser-gateway-service.test-helpers';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';

function attachment(
  overrides: Partial<BrowserExistingTabAttachment> = {},
): BrowserExistingTabAttachment {
  return {
    profileId: 'existing-tab:7:42',
    targetId: 'existing-tab:7:42:target',
    tabId: 42,
    windowId: 7,
    title: 'Example',
    url: 'https://example.test/page',
    origin: 'https://example.test',
    allowedOrigins: [{
      scheme: 'https',
      hostPattern: 'example.test',
      includeSubdomains: false,
    }],
    attachedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function makeOps(options: {
  tabs?: BrowserExistingTabAttachment[];
  sendCommand?: ReturnType<typeof vi.fn>;
  closeTarget?: ReturnType<typeof vi.fn>;
  grants?: ReturnType<typeof makeGrant>[];
  targets?: Array<{
    id: string;
    profileId?: string;
    title?: string;
    url?: string;
    origin?: string;
    status?: 'available' | 'selected' | 'closed';
    mode?: 'session' | 'existing-tab';
    nodeId?: string;
  }>;
} = {}) {
  const tabs = options.tabs ?? [attachment(), attachment({
    profileId: 'existing-tab:7:43',
    targetId: 'existing-tab:7:43:target',
    tabId: 43,
    title: 'Other',
    url: 'https://example.test/other',
  })];
  const sendCommand = options.sendCommand ?? vi.fn(async () => ({ closed: true }));
  const closeTarget = options.closeTarget ?? vi.fn(async () => undefined);
  const grants = options.grants ?? [
    makeGrant({
      profileId: undefined,
      nodeId: 'local',
      allowedOrigins: [{
        scheme: 'https',
        hostPattern: 'example.test',
        includeSubdomains: false,
      }],
      allowedActionClasses: ['destructive'],
      autonomous: true,
      mode: 'autonomous',
    }),
  ];
  const detached: string[] = [];
  const ops = new BrowserCloseTabOperations({
    targetRegistry: {
      listTargets: () => (options.targets ?? []).map((target) => ({
        id: target.id,
        profileId: target.profileId,
        mode: target.mode ?? 'existing-tab',
        driver: 'extension' as const,
        status: target.status ?? 'selected',
        lastSeenAt: 1,
        title: target.title,
        url: target.url,
        origin: target.origin,
        nodeId: target.nodeId,
      })),
    },
    driver: { closeTarget },
    extensionTabStore: {
      getTab: (profileId, targetId) => tabs.find((tab) => (
        tab.profileId === profileId && tab.targetId === targetId
      )) ?? null,
      listTabs: () => tabs.filter((tab) => !detached.includes(tab.targetId)),
      detachTab: (profileId, targetId) => {
        detached.push(targetId);
        return tabs.find((tab) => tab.profileId === profileId && tab.targetId === targetId) ?? null;
      },
    },
    existingTabOperations: { sendCommand },
    grantStore: {
      listGrants: () => grants,
      consumeGrant: vi.fn((id: string) => grants.find((grant) => grant.id === id) ?? null),
    },
    approvalStore: {
      createRequest: vi.fn((input) => ({ ...input, requestId: 'req-1' })),
      listRequests: vi.fn(() => []),
    },
    autoApproveApproval: () => null,
    getWorkerNodes: () => [],
    result: (params) => params as never,
  });
  return { ops, sendCommand, closeTarget, detached };
}

describe('BrowserCloseTabOperations', () => {
  it('closes an existing Chrome tab under a destructive grant and detaches it', async () => {
    const { ops, sendCommand, detached } = makeOps();
    const result = await ops.closeTab({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
    });

    expect(result.decision).toBe('allowed');
    expect(result.outcome).toBe('succeeded');
    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'existing-tab:7:42:target' }),
      'close_tab',
      { allowCloseLastInWindow: false },
    );
    expect(detached).toEqual(['existing-tab:7:42:target']);
    expect(result.data).toMatchObject({
      closed: true,
      remainingTabCount: 1,
      targetId: 'existing-tab:7:42:target',
    });
  });

  it('refuses to close the last shared tab in a window', async () => {
    const { ops, sendCommand } = makeOps({
      tabs: [attachment()],
    });
    const result = await ops.closeTab({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
    });

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('browser_close_last_tab_in_window_refused');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('asks for approval when no destructive grant exists', async () => {
    const { ops } = makeOps({ grants: [] });
    const result = await ops.closeTab({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
    });

    expect(result.decision).toBe('requires_user');
    expect((result as { actionClass?: string }).actionClass).toBe('destructive');
    expect(result.requestId).toBe('req-1');
  });

  it('skips inspection-unavailable tabs in close_matching unless included', async () => {
    const opaque = attachment({
      title: 'Tab inspection unavailable',
      url: 'https://redacted.invalid/',
      origin: 'https://redacted.invalid',
      textUnavailableReason: 'browser_secret_inspection_unavailable',
      inspectionState: 'inspection_unavailable',
    });
    const { ops, sendCommand } = makeOps({
      tabs: [opaque, attachment({
        profileId: 'existing-tab:7:43',
        targetId: 'existing-tab:7:43:target',
        tabId: 43,
        title: 'Docs',
        url: 'https://example.test/docs',
      })],
    });

    const skipped = await ops.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      urlContains: 'redacted.invalid',
    });
    expect(skipped.data?.closed).toEqual([]);
    expect(skipped.data?.skipped[0]?.reason).toBe('inspection_unavailable_skipped');
    expect(sendCommand).not.toHaveBeenCalled();

    const { ops: includeOps } = makeOps({
      tabs: [opaque, attachment({
        profileId: 'existing-tab:7:43',
        targetId: 'existing-tab:7:43:target',
        tabId: 43,
        title: 'Docs',
        url: 'https://example.test/docs',
      })],
      grants: [
        makeGrant({
          profileId: undefined,
          nodeId: 'local',
          allowedOrigins: [{
            scheme: 'https',
            hostPattern: 'redacted.invalid',
            includeSubdomains: false,
          }],
          allowedActionClasses: ['destructive'],
          autonomous: true,
          mode: 'autonomous',
        }),
      ],
    });
    const included = await includeOps.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      urlContains: 'redacted.invalid',
      includeInspectionUnavailable: true,
    });
    expect(included.outcome).toBe('succeeded');
    expect(included.data?.closed).toEqual([
      expect.objectContaining({ targetId: 'existing-tab:7:42:target' }),
    ]);
  });

  it('sweeps already-closed registry rows without calling Chrome', async () => {
    const { ops, sendCommand } = makeOps({
      tabs: [],
      targets: [{
        id: 'stale-1',
        profileId: 'existing-tab:7:99',
        status: 'closed',
        title: 'Gone',
        url: 'https://example.test/gone',
        origin: 'https://example.test',
      }],
    });

    const result = await ops.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      status: 'closed',
    });

    expect(result.outcome).toBe('succeeded');
    expect(result.data?.closed).toEqual([
      expect.objectContaining({ targetId: 'stale-1' }),
    ]);
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('closes a managed profile page through the driver', async () => {
    const { ops, closeTarget } = makeOps({
      tabs: [],
      grants: [
        makeGrant({
          allowedActionClasses: ['destructive'],
          autonomous: true,
          mode: 'autonomous',
        }),
      ],
      targets: [{
        id: 'target-1',
        profileId: 'profile-1',
        mode: 'session',
        status: 'available',
        title: 'Local',
        url: 'http://localhost:4567',
        origin: 'http://localhost:4567',
      }],
    });

    const result = await ops.closeTab({
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
    });

    expect(result.outcome).toBe('succeeded');
    expect(closeTarget).toHaveBeenCalledWith('profile-1', 'target-1');
  });

  it('does not close a different origin or targetId than the destructive grant covers', async () => {
    const otherOrigin = attachment({
      profileId: 'existing-tab:7:44',
      targetId: 'existing-tab:7:44:target',
      tabId: 44,
      title: 'Other origin',
      url: 'https://other.test/page',
      origin: 'https://other.test',
      allowedOrigins: [{
        scheme: 'https',
        hostPattern: 'other.test',
        includeSubdomains: false,
      }],
    });
    const { ops, sendCommand } = makeOps({
      tabs: [
        attachment(),
        attachment({
          profileId: 'existing-tab:7:43',
          targetId: 'existing-tab:7:43:target',
          tabId: 43,
          title: 'Same origin sibling',
          url: 'https://example.test/other',
        }),
        otherOrigin,
      ],
    });

    const byOrigin = await ops.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      urlContains: 'https://',
    });
    expect(byOrigin.outcome).toBe('succeeded');
    expect(byOrigin.data?.closed.map((item) => item.targetId).sort()).toEqual([
      'existing-tab:7:42:target',
      'existing-tab:7:43:target',
    ]);
    expect(byOrigin.data?.skipped).toEqual([
      expect.objectContaining({
        targetId: 'existing-tab:7:44:target',
        reason: 'grant_does_not_cover_target',
      }),
    ]);
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'existing-tab:7:44:target' }),
      'close_tab',
      expect.anything(),
    );

    const { ops: boundOps, sendCommand: boundSend } = makeOps({
      tabs: [
        attachment(),
        attachment({
          profileId: 'existing-tab:7:43',
          targetId: 'existing-tab:7:43:target',
          tabId: 43,
          title: 'Same origin sibling',
          url: 'https://example.test/other',
        }),
      ],
      grants: [
        makeGrant({
          profileId: undefined,
          nodeId: 'local',
          targetId: 'existing-tab:7:42:target',
          allowedOrigins: [{
            scheme: 'https',
            hostPattern: 'example.test',
            includeSubdomains: false,
          }],
          allowedActionClasses: ['destructive'],
          autonomous: true,
          mode: 'autonomous',
        }),
      ],
    });
    const byTarget = await boundOps.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      urlContains: 'example.test',
    });
    expect(byTarget.data?.closed).toEqual([
      expect.objectContaining({ targetId: 'existing-tab:7:42:target' }),
    ]);
    expect(byTarget.data?.skipped).toEqual([
      expect.objectContaining({
        targetId: 'existing-tab:7:43:target',
        reason: 'grant_does_not_cover_target',
      }),
    ]);
    expect(boundSend).toHaveBeenCalledTimes(1);
  });

  it('skips secret-tainted tabs unless included and caps close_matching with maxCount', async () => {
    const tainted = attachment({
      title: 'Secret-filled tab',
      url: 'https://example.test/',
      origin: 'https://example.test',
      textUnavailableReason: 'browser_secret_observation_blocked_for_tainted_origin',
      inspectionState: 'secret_tainted',
    });
    const { ops, sendCommand } = makeOps({
      tabs: [
        tainted,
        attachment({
          profileId: 'existing-tab:7:43',
          targetId: 'existing-tab:7:43:target',
          tabId: 43,
          title: 'Docs',
          url: 'https://example.test/docs',
        }),
        attachment({
          profileId: 'existing-tab:7:44',
          targetId: 'existing-tab:7:44:target',
          tabId: 44,
          title: 'More',
          url: 'https://example.test/more',
        }),
      ],
    });

    const skippedTainted = await ops.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      urlContains: 'example.test',
    });
    expect(skippedTainted.data?.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetId: 'existing-tab:7:42:target',
          reason: 'secret_tainted_skipped',
        }),
      ]),
    );
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetId: 'existing-tab:7:42:target' }),
      'close_tab',
      expect.anything(),
    );

    const { ops: capOps } = makeOps({
      tabs: [
        attachment({
          title: 'Docs',
          url: 'https://example.test/docs',
        }),
        attachment({
          profileId: 'existing-tab:7:43',
          targetId: 'existing-tab:7:43:target',
          tabId: 43,
          title: 'More',
          url: 'https://example.test/more',
        }),
        attachment({
          profileId: 'existing-tab:7:44',
          targetId: 'existing-tab:7:44:target',
          tabId: 44,
          title: 'Extra',
          url: 'https://example.test/extra',
        }),
      ],
    });
    const capped = await capOps.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      urlContains: 'example.test',
      maxCount: 1,
    });
    expect(capped.data?.closed).toHaveLength(1);
    expect(capped.data?.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'max_count_reached' }),
      ]),
    );
  });

  it('reports remainingTabCount for the resolved node, not every attached tab', async () => {
    const { ops } = makeOps({
      tabs: [
        attachment({
          nodeId: 'win-1',
          profileId: 'existing-tab:n.win-1:7:42',
          targetId: 'existing-tab:n.win-1:7:42:target',
        }),
        attachment({
          nodeId: 'win-1',
          profileId: 'existing-tab:n.win-1:7:43',
          targetId: 'existing-tab:n.win-1:7:43:target',
          tabId: 43,
          title: 'Same node',
          url: 'https://example.test/other',
        }),
        attachment({
          nodeId: 'win-2',
          profileId: 'existing-tab:n.win-2:8:50',
          targetId: 'existing-tab:n.win-2:8:50:target',
          tabId: 50,
          windowId: 8,
          title: 'Other node',
          url: 'https://example.test/remote',
        }),
      ],
      grants: [
        makeGrant({
          profileId: undefined,
          nodeId: 'win-1',
          allowedOrigins: [{
            scheme: 'https',
            hostPattern: 'example.test',
            includeSubdomains: false,
          }],
          allowedActionClasses: ['destructive'],
          autonomous: true,
          mode: 'autonomous',
        }),
      ],
    });

    const result = await ops.closeMatching({
      instanceId: 'instance-1',
      provider: 'copilot',
      nodeId: 'win-1',
      urlContains: 'example.test',
      maxCount: 1,
    });

    expect(result.data?.closed).toHaveLength(1);
    expect(result.data?.remainingTabCount).toBe(1);
  });
});
