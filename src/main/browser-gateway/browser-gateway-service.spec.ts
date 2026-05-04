import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserAuditEntry,
  BrowserApprovalRequest,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import { BrowserGatewayService } from './browser-gateway-service';

function makeProfile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
  return {
    id: 'profile-1',
    label: 'Local',
    mode: 'session',
    browser: 'chrome',
    allowedOrigins: [
      {
        scheme: 'http',
        hostPattern: 'localhost',
        port: 4567,
        includeSubdomains: false,
      },
    ],
    status: 'running',
    debugPort: 9222,
    debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id',
    processId: 123,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeTarget(overrides: Partial<BrowserTarget> = {}): BrowserTarget {
  return {
    id: 'target-1',
    profileId: 'profile-1',
    driverTargetId: 'cdp-target',
    mode: 'session',
    title: 'Local',
    url: 'http://localhost:4567',
    origin: 'http://localhost:4567',
    driver: 'cdp',
    status: 'available',
    lastSeenAt: 1,
    ...overrides,
  };
}

function makeService(overrides: {
  profile?: BrowserProfile | null;
  profiles?: BrowserProfile[];
  target?: BrowserTarget;
  navigate?: () => Promise<void>;
  screenshot?: () => Promise<string>;
  snapshot?: () => Promise<{ title: string; url: string; text: string }>;
  refreshTarget?: () => Promise<BrowserTarget>;
  grants?: BrowserPermissionGrant[];
  existingTab?: {
    profileId: string;
    targetId: string;
    title: string;
    url: string;
    origin: string;
    text?: string;
    screenshotBase64?: string;
    allowedOrigins: BrowserProfile['allowedOrigins'];
  };
} = {}) {
  const audits: BrowserAuditEntry[] = [];
  const approvalRequests: BrowserApprovalRequest[] = [];
  const grants = [...(overrides.grants ?? [])];
  const profile = overrides.profile === null
    ? null
    : (overrides.profile ?? makeProfile());
  const profiles = overrides.profiles ?? (profile ? [profile] : []);
  const target = overrides.target ?? makeTarget();
  const driver = {
    openProfile: vi.fn(async () => [target]),
    closeProfile: vi.fn(async () => undefined),
    listTargets: vi.fn(async () => [target]),
    refreshTarget: vi.fn(overrides.refreshTarget ?? (async () => target)),
    navigate: vi.fn(overrides.navigate ?? (async () => undefined)),
    snapshot: vi.fn(overrides.snapshot ?? (async () => ({
      title: 'Local',
      url: 'http://localhost:4567',
      text: 'hello',
    }))),
    screenshot: vi.fn(overrides.screenshot ?? (async () => 'base64')),
    consoleMessages: vi.fn(async () => []),
    networkRequests: vi.fn(async () => []),
    waitFor: vi.fn(async () => undefined),
    inspectElement: vi.fn(async () => ({
      role: 'button',
      accessibleName: 'Continue',
    })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    fillForm: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => undefined),
  };
  const auditStore = {
    record: vi.fn((entry: Omit<BrowserAuditEntry, 'id' | 'createdAt'>) => {
      const audit: BrowserAuditEntry = {
        id: `audit-${audits.length + 1}`,
        createdAt: audits.length + 1,
        ...entry,
      };
      audits.push(audit);
      return audit;
    }),
    list: vi.fn(() => audits),
  };
  const grantStore = {
    listGrants: vi.fn(() => grants),
    consumeGrant: vi.fn((grantId: string) => {
      const grant = grants.find((item) => item.id === grantId);
      if (!grant) {
        return null;
      }
      grant.consumedAt = Date.now();
      return { ...grant };
    }),
    revokeGrant: vi.fn((grantId: string, reason?: string) => {
      const grant = grants.find((item) => item.id === grantId);
      if (!grant) {
        return null;
      }
      grant.revokedAt = Date.now();
      grant.decidedBy = 'revoked';
      grant.reason = reason ?? grant.reason;
      return { ...grant };
    }),
    createGrant: vi.fn((input: Omit<BrowserPermissionGrant, 'id' | 'createdAt' | 'revokedAt' | 'consumedAt'>) => {
      const grant: BrowserPermissionGrant = {
        id: `grant-${grants.length + 1}`,
        createdAt: Date.now(),
        ...input,
      };
      grants.push(grant);
      return grant;
    }),
  };
  const approvalStore = {
    createRequest: vi.fn((input: Omit<BrowserApprovalRequest, 'id' | 'requestId' | 'status' | 'createdAt' | 'decidedAt' | 'grantId'>) => {
      const request: BrowserApprovalRequest = {
        id: `request-${approvalRequests.length + 1}`,
        requestId: `request-${approvalRequests.length + 1}`,
        status: 'pending',
        createdAt: Date.now(),
        ...input,
      };
      approvalRequests.push(request);
      return request;
    }),
    getRequest: vi.fn((requestId: string, instanceId?: string) =>
      approvalRequests.find((request) =>
        request.requestId === requestId && (!instanceId || request.instanceId === instanceId),
      ) ?? null,
    ),
    listRequests: vi.fn(() => approvalRequests),
    resolveRequest: vi.fn(),
  };
  const profileRegistry = {
    createProfile: vi.fn((input) => ({ ...(profile ?? makeProfile()), ...input })),
    resolveProfileDir: vi.fn((profileId) => `/tmp/browser-profiles/${profileId}`),
  };
  const extensionTabStore = {
    attachTab: vi.fn((input) => ({
      profileId: `existing-tab:${input.windowId}:${input.tabId}`,
      targetId: `existing-tab:${input.windowId}:${input.tabId}:target`,
      title: input.title,
      url: input.url,
      origin: new URL(input.url).origin,
      allowedOrigins: input.allowedOrigins ?? [
        {
          scheme: new URL(input.url).protocol === 'http:' ? 'http' : 'https',
          hostPattern: new URL(input.url).hostname,
          includeSubdomains: false,
        },
      ],
      text: input.text,
      screenshotBase64: input.screenshotBase64,
      attachedAt: Date.now(),
      updatedAt: Date.now(),
    })),
    getTab: vi.fn((profileId: string, targetId: string) =>
      overrides.existingTab &&
        overrides.existingTab.profileId === profileId &&
        overrides.existingTab.targetId === targetId
        ? overrides.existingTab
        : null,
    ),
    queueRefresh: vi.fn((profileId: string, targetId: string) =>
      overrides.existingTab &&
        overrides.existingTab.profileId === profileId &&
        overrides.existingTab.targetId === targetId
        ? {
          id: 'command-1',
          kind: 'refresh_tab',
          status: 'queued',
          profileId,
          targetId,
          tabId: 42,
          windowId: 7,
          createdAt: 100,
          updatedAt: 100,
        }
        : null,
    ),
  };
  const service = new BrowserGatewayService({
    profileStore: {
      listProfiles: () => profiles,
      getProfile: (profileId) => (profile && profileId === profile.id ? profile : null),
      updateProfile: vi.fn((_profileId, patch) => ({ ...(profile ?? makeProfile()), ...patch })),
      deleteProfile: vi.fn(),
    },
    profileRegistry,
    targetRegistry: {
      listTargets: (profileId?: string) =>
        !profileId || profileId === target.profileId ? [target] : [],
      selectTarget: vi.fn((targetId: string) => ({ ...target, id: targetId, status: 'selected' })),
    },
    driver,
    extensionTabStore,
    auditStore,
    grantStore,
    approvalStore,
    healthService: {
      diagnose: async () => ({
        chromeRuntime: {
          available: true,
          debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id',
        },
      }),
    },
  });

  return {
    service,
    audits,
    driver,
    auditStore,
    grantStore,
    approvalStore,
    approvalRequests,
    grants,
    profileRegistry,
    extensionTabStore,
  };
}

function makeGrant(overrides: Partial<BrowserPermissionGrant> = {}): BrowserPermissionGrant {
  return {
    id: 'grant-1',
    mode: 'session',
    instanceId: 'instance-1',
    provider: 'copilot',
    profileId: 'profile-1',
    allowedOrigins: [
      {
        scheme: 'http',
        hostPattern: 'localhost',
        port: 4567,
        includeSubdomains: false,
      },
    ],
    allowedActionClasses: ['input'],
    allowExternalNavigation: false,
    autonomous: false,
    requestedBy: 'user',
    decidedBy: 'user',
    decision: 'allow',
    expiresAt: 9_999_999_999_999,
    createdAt: 1_000,
    ...overrides,
  };
}

describe('BrowserGatewayService', () => {
  it('returns an actionable bootstrap reason when no managed profiles exist', async () => {
    const { service } = makeService({ profile: null, profiles: [] });

    await expect(service.listProfiles({
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'no_profiles_configured_call_browser_create_profile_then_browser_open_profile',
      data: [],
    });
  });

  it('allows providers to create managed profiles without exposing profile paths', async () => {
    const { service, audits, profileRegistry } = makeService();

    const result = await service.createProfile({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      defaultUrl: 'https://play.google.com/console',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    expect(profileRegistry.createProfile).toHaveBeenCalledWith({
      label: 'Google Play',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [
        {
          scheme: 'https',
          hostPattern: 'play.google.com',
          includeSubdomains: true,
        },
      ],
      defaultUrl: 'https://play.google.com/console',
    });
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        label: 'Google Play',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: true,
          },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('debugEndpoint');
    expect(audits[0]).toMatchObject({
      provider: 'claude',
      action: 'create_profile',
      toolName: 'browser.create_profile',
    });
  });

  it('attaches a selected existing Chrome tab and audits it as an extension target', async () => {
    const { service, extensionTabStore } = makeService();

    const result = await service.attachExistingTab({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Release dashboard',
      screenshotBase64: 'cG5n',
      capturedAt: 1000,
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    });

    expect(extensionTabStore.attachTab).toHaveBeenCalledWith({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console',
      title: 'Google Play Console',
      text: 'Release dashboard',
      screenshotBase64: 'cG5n',
      capturedAt: 1000,
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
    });
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        id: 'existing-tab:7:42:target',
        profileId: 'existing-tab:7:42',
        mode: 'existing-tab',
        driver: 'extension',
      },
    });
    expect(JSON.stringify(result)).not.toContain('driverTargetId');
  });

  it('reads cached snapshots and screenshots from selected existing Chrome tabs', async () => {
    const { service, driver } = makeService({
      profile: null,
      profiles: [],
      target: makeTarget({
        id: 'existing-tab:7:42:target',
        profileId: 'existing-tab:7:42',
        mode: 'existing-tab',
        driver: 'extension',
        url: 'https://play.google.com/console',
        origin: 'https://play.google.com',
      }),
      existingTab: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        title: 'Google Play Console',
        url: 'https://play.google.com/console',
        origin: 'https://play.google.com',
        text: 'token=abc123 release dashboard',
        screenshotBase64: 'cG5n',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: false,
          },
        ],
      },
    });

    await expect(service.snapshot({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        title: 'Google Play Console',
        url: 'https://play.google.com/console',
        text: 'token=[REDACTED] release dashboard',
      },
    });
    await expect(service.screenshot({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: 'cG5n',
    });
    expect(driver.snapshot).not.toHaveBeenCalled();
    expect(driver.screenshot).not.toHaveBeenCalled();
  });

  it('queues refresh commands for selected existing Chrome tabs through the audited gateway', async () => {
    const { service, extensionTabStore, audits } = makeService({
      profile: null,
      profiles: [],
      existingTab: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        title: 'Google Play Console',
        url: 'https://play.google.com/console',
        origin: 'https://play.google.com',
        text: 'Initial dashboard',
        screenshotBase64: 'cG5n',
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: false,
          },
        ],
      },
    });

    await expect(service.refreshExistingTab({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: {
        commandId: 'command-1',
        status: 'queued',
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
      },
    });
    expect(extensionTabStore.queueRefresh).toHaveBeenCalledWith(
      'existing-tab:7:42',
      'existing-tab:7:42:target',
    );
    expect(audits[0]).toMatchObject({
      provider: 'claude',
      action: 'refresh_existing_tab',
      toolName: 'browser.refresh_existing_tab',
      decision: 'allowed',
      outcome: 'succeeded',
      origin: 'https://play.google.com',
      url: 'https://play.google.com/console',
    });
  });

  it('allows navigation within policy, calls the driver, and audits success', async () => {
    const { service, audits, driver } = makeService();

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'audit-1',
    });
    expect(driver.navigate).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'http://localhost:4567/next',
    );
    expect(audits[0]).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      action: 'navigate',
      toolName: 'browser.navigate',
    });
  });

  it('denies blocked navigation without calling the driver', async () => {
    const { service, audits, driver } = makeService();

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'https://example.com',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
      auditId: 'audit-1',
    });
    expect(driver.navigate).not.toHaveBeenCalled();
    expect(audits[0]).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
    });
  });

  it('denies screenshots when the current target origin is blocked', async () => {
    const { service, driver } = makeService({
      target: makeTarget({
        url: 'https://example.com',
        origin: 'https://example.com',
      }),
    });

    const result = await service.screenshot({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
    });
    expect(driver.screenshot).not.toHaveBeenCalled();
  });

  it('refreshes live target state before read operations so stale allowed URLs cannot leak blocked pages', async () => {
    const { service, driver } = makeService({
      target: makeTarget({
        url: 'http://localhost:4567/stale',
        origin: 'http://localhost:4567',
      }),
      refreshTarget: async () => makeTarget({
        url: 'https://example.com/live',
        origin: 'https://example.com',
      }),
    });

    const result = await service.screenshot({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
    });
    expect(driver.refreshTarget).toHaveBeenCalledWith('profile-1', 'target-1');
    expect(driver.screenshot).not.toHaveBeenCalled();
  });

  it('records requires_user for mutating browser actions', async () => {
    const { service, audits } = makeService();

    const result = await service.requireUserForMutatingAction({
      toolName: 'browser.click',
      action: 'click',
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      auditId: 'audit-1',
    });
    expect(audits[0]).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      actionClass: 'input',
    });
  });

  it('creates an approval request for ungranted click without executing the driver', async () => {
    const { service, driver, approvalStore, approvalRequests } = makeService();

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
    });
    expect(driver.click).not.toHaveBeenCalled();
    expect(approvalStore.createRequest).toHaveBeenCalledOnce();
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'input',
      selector: 'button.continue',
      status: 'pending',
    });
  });

  it('executes click under a matching session grant and audits the grant id', async () => {
    const { service, driver, audits } = makeService({
      grants: [makeGrant()],
    });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.continue');
    expect(audits.at(-1)).toMatchObject({
      grantId: 'grant-1',
      autonomous: false,
      action: 'click',
    });
  });

  it('requires explicit autonomous submit grant for submit-like clicks', async () => {
    const submitGrant = makeGrant({
      mode: 'autonomous',
      autonomous: true,
      allowedActionClasses: ['input', 'submit'],
    });
    const { service, driver } = makeService({
      grants: [submitGrant],
    });
    driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Submit for review',
    });

    await expect(service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.submit',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalled();

    const blocked = makeService({
      grants: [
        makeGrant({
          mode: 'autonomous',
          autonomous: true,
          allowedActionClasses: ['input'],
        }),
      ],
    });
    blocked.driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Submit for review',
    });
    await expect(blocked.service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.submit',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });
    expect(blocked.driver.click).not.toHaveBeenCalled();
  });

  it('consumes per-action grants after one execution', async () => {
    const { service, grantStore } = makeService({
      grants: [makeGrant({ mode: 'per_action' })],
    });

    await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(grantStore.consumeGrant).toHaveBeenCalledWith('grant-1');
  });

  it('re-checks the grant immediately before mutating driver execution', async () => {
    const activeGrant = makeGrant();
    const { service, driver, grantStore } = makeService({
      grants: [activeGrant],
    });
    grantStore.listGrants
      .mockReturnValueOnce([activeGrant])
      .mockReturnValueOnce([]);

    await expect(service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'no_matching_grant',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('refreshes live target state before mutating actions so stale allowed URLs cannot authorize blocked pages', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
      refreshTarget: async () => makeTarget({
        url: 'https://example.com/live',
        origin: 'https://example.com',
      }),
    });

    await expect(service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="title"]',
      value: 'Release notes',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
    });
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('audits mutating driver failures as failed Browser Gateway results', async () => {
    const { service, driver, audits } = makeService({
      grants: [makeGrant()],
    });
    driver.type.mockRejectedValueOnce(new Error('type failed'));

    const result = await service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="title"]',
      value: 'Release notes',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'type failed',
    });
    expect(audits.at(-1)).toMatchObject({
      action: 'type',
      toolName: 'browser.type',
      decision: 'allowed',
      outcome: 'failed',
      grantId: 'grant-1',
    });
  });

  it('turns element inspection failures into requires_user instead of raw driver errors', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    driver.inspectElement.mockRejectedValueOnce(new Error('selector missing'));

    await expect(service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.missing',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'element_context_unavailable',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('executes type, select, fill_form, and upload_file under matching grants', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-gateway-upload-'));
    const uploadRoot = path.join(tempDir, 'uploads');
    fs.mkdirSync(uploadRoot);
    const uploadFile = path.join(uploadRoot, 'app.aab');
    fs.writeFileSync(uploadFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const resolvedUploadFile = fs.realpathSync(uploadFile);
    const { service, driver } = makeService({
      profile: makeProfile({
        userDataDir: path.join(tempDir, 'userData', 'browser-profiles', 'profile-1'),
      }),
      grants: [
        makeGrant({
          allowedActionClasses: ['input', 'file-upload'],
          uploadRoots: [uploadRoot],
        }),
      ],
    });

    try {
      await service.type({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[name="title"]',
        value: 'Release notes',
        instanceId: 'instance-1',
        provider: 'copilot',
      });
      await service.select({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'select.track',
        value: 'production',
        instanceId: 'instance-1',
        provider: 'copilot',
      });
      await service.fillForm({
        profileId: 'profile-1',
        targetId: 'target-1',
        fields: [
          { selector: '#one', value: 'One' },
          { selector: '#two', value: 'Two' },
        ],
        instanceId: 'instance-1',
        provider: 'copilot',
      });
      await service.uploadFile({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[type="file"]',
        filePath: uploadFile,
        instanceId: 'instance-1',
        provider: 'copilot',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    expect(driver.type).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'input[name="title"]',
      'Release notes',
    );
    expect(driver.select).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'select.track',
      'production',
    );
    expect(driver.fillForm).toHaveBeenCalledWith('profile-1', 'target-1', [
      { selector: '#one', value: 'One' },
      { selector: '#two', value: 'Two' },
    ]);
    expect(driver.uploadFile).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      'input[type="file"]',
      resolvedUploadFile,
    );
  });

  it('blocks fill_form atomically when a field is credential-like', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input', 'credential'] })],
    });
    driver.inspectElement
      .mockResolvedValueOnce({ label: 'Title', inputType: 'text' })
      .mockResolvedValueOnce({ label: 'Password', inputType: 'password' });

    await expect(service.fillForm({
      profileId: 'profile-1',
      targetId: 'target-1',
      fields: [
        { selector: '#title', value: 'Title' },
        { selector: '#password', value: 'secret' },
      ],
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });
    expect(driver.fillForm).not.toHaveBeenCalled();
  });

  it('creates grant requests and returns approval status scoped to the instance', async () => {
    const { service, approvalRequests } = makeService();

    const requestResult = await service.requestGrant({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      reason: 'overnight form filling',
    });

    expect(requestResult).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
    });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.request_grant',
      status: 'pending',
      proposedGrant: {
        mode: 'session',
        allowedActionClasses: ['input'],
      },
    });

    await expect(service.getApprovalStatus({
      requestId: 'request-1',
      instanceId: 'other-instance',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'approval_request_not_found',
    });
    await expect(service.getApprovalStatus({
      requestId: 'request-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: {
        requestId: 'request-1',
        status: 'pending',
      },
    });
  });

  it('approves pending requests into bounded grants and resolves the approval request', async () => {
    const { service, approvalStore, grants } = makeService();
    await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.continue',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    const result = await service.approveRequest({
      requestId: 'request-1',
      grant: {
        mode: 'autonomous',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['input', 'submit'],
        allowExternalNavigation: false,
        autonomous: true,
      },
      reason: 'approved overnight run',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      data: {
        id: 'grant-1',
        mode: 'autonomous',
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
      },
    });
    expect(grants[0].expiresAt - grants[0].createdAt).toBeLessThanOrEqual(86_400_000);
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('lists and revokes active grants through the service', async () => {
    const grant = makeGrant({ id: 'grant-active' });
    const { service, grantStore } = makeService({ grants: [grant] });

    await expect(service.listGrants({
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: [
        {
          id: 'grant-active',
        },
      ],
    });
    await expect(service.revokeGrant({
      grantId: 'grant-active',
      reason: 'user stopped the run',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: {
        id: 'grant-active',
        revokedAt: expect.any(Number),
      },
    });
    expect(grantStore.revokeGrant).toHaveBeenCalledWith('grant-active', 'user stopped the run');
  });

  it('validates upload paths against grant roots before calling the driver', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-gateway-upload-'));
    try {
      const allowedRoot = path.join(tempDir, 'allowed');
      const deniedRoot = path.join(tempDir, 'denied');
      fs.mkdirSync(allowedRoot);
      fs.mkdirSync(deniedRoot);
      const deniedFile = path.join(deniedRoot, 'release.zip');
      fs.writeFileSync(deniedFile, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      const { service, driver } = makeService({
        profile: makeProfile({
          userDataDir: path.join(tempDir, 'userData', 'browser-profiles', 'profile-1'),
        }),
        grants: [
          makeGrant({
            allowedActionClasses: ['file-upload'],
            uploadRoots: [allowedRoot],
          }),
        ],
      });

      await expect(service.uploadFile({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[type="file"]',
        filePath: deniedFile,
        instanceId: 'instance-1',
        provider: 'copilot',
      })).resolves.toMatchObject({
        decision: 'requires_user',
        outcome: 'not_run',
        reason: 'root_not_allowed',
      });
      expect(driver.uploadFile).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('audits allowed driver failures as failed outcomes', async () => {
    const { service, audits } = makeService({
      navigate: async () => {
        throw new Error('driver failed');
      },
    });

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: 'driver failed',
      auditId: 'audit-1',
    });
    expect(audits[0]).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
    });
  });

  it('redacts unsafe driver failure details before returning or storing audit entries', async () => {
    const { service, audits } = makeService({
      navigate: async () => {
        throw new Error(
          'failed via ws://127.0.0.1:9222/devtools/browser/id in /tmp/browser-profiles/profile-1 Authorization: Bearer abc123',
        );
      },
    });

    const result = await service.navigate({
      profileId: 'profile-1',
      targetId: 'target-1',
      url: 'http://localhost:4567/next',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    const payload = JSON.stringify({ result, audit: audits[0] });

    expect(payload).not.toContain('ws://');
    expect(payload).not.toContain('browser-profiles/profile-1');
    expect(payload).not.toContain('Bearer');
    expect(payload).not.toContain('abc123');
  });

  it('passes audit profile, instance, and limit filters through to the audit store', async () => {
    const { service, auditStore } = makeService();

    await service.getAuditLog({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      limit: 7,
    });

    expect(auditStore.list).toHaveBeenCalledWith({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      limit: 7,
    });
  });

  it('returns agent-safe profile, target, health, and audit data', async () => {
    const { service, audits } = makeService();
    audits.push({
      id: 'audit-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      action: 'snapshot',
      toolName: 'browser.snapshot',
      actionClass: 'read',
      url: 'ws://127.0.0.1:9222/devtools/browser/id',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: 'ws://127.0.0.1:9222/devtools/browser/id debugPort=9222',
      redactionApplied: true,
      createdAt: 1,
    });

    const [profiles, targets, health, audit] = await Promise.all([
      service.listProfiles({ instanceId: 'instance-1', provider: 'copilot' }),
      service.listTargets({ profileId: 'profile-1', instanceId: 'instance-1', provider: 'copilot' }),
      service.getHealth({ instanceId: 'instance-1', provider: 'copilot' }),
      service.getAuditLog({ instanceId: 'instance-1', provider: 'copilot' }),
    ]);
    const payload = JSON.stringify({ profiles, targets, health, audit });

    expect(payload).not.toContain('debugPort');
    expect(payload).not.toContain('debugEndpoint');
    expect(payload).not.toContain('driverTargetId');
    expect(payload).not.toContain('ws://');
  });
});
