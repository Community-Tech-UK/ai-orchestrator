import { vi } from 'vitest';
import type {
  BrowserAccessibilityNode,
  BrowserAuditEntry,
  BrowserApprovalRequest,
  BrowserEvaluateResult,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import {
  BrowserGatewayService,
  type BrowserGatewayServiceOptions,
} from './browser-gateway-service';
import type { BrowserExtensionCommandStore } from './browser-extension-command-store';
import type { BrowserGatewayHealthReport } from './browser-health-service';
import type { BrowserAutoApprovePredicate } from './browser-auto-approve';

export function makeProfile(overrides: Partial<BrowserProfile> = {}): BrowserProfile {
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

export function makeTarget(overrides: Partial<BrowserTarget> = {}): BrowserTarget {
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

export function makeService(overrides: {
  profile?: BrowserProfile | null;
  profiles?: BrowserProfile[];
  target?: BrowserTarget;
  navigate?: () => Promise<void>;
  screenshot?: () => Promise<string>;
  snapshot?: () => Promise<{ title: string; url: string; text: string }>;
  accessibilitySnapshot?: (
    profileId: string,
    targetId: string,
    options?: { interestingOnly?: boolean; limit?: number },
  ) => Promise<BrowserAccessibilityNode[]>;
  evaluate?: (
    profileId: string,
    targetId: string,
    expression: string,
    awaitPromise: boolean,
  ) => Promise<BrowserEvaluateResult>;
  refreshTarget?: () => Promise<BrowserTarget>;
  grants?: BrowserPermissionGrant[];
  autoApproveRequests?: BrowserAutoApprovePredicate;
  existingTab?: {
    profileId: string;
    targetId: string;
    tabId?: number;
    windowId?: number;
    nodeId?: string;
    nodeName?: string;
    title: string;
    url: string;
    origin: string;
    text?: string;
    screenshotBase64?: string;
    allowedOrigins: BrowserProfile['allowedOrigins'];
  };
  extensionCommandStore?: Pick<BrowserExtensionCommandStore, 'sendCommand'>;
  extensionContactState?: BrowserGatewayServiceOptions['extensionContactState'];
  resolvePreferredDebugPort?: (profileId: string) => number | undefined;
  stageUploadFileOnNode?: (nodeId: string, localPath: string) => Promise<string>;
  useSingleton?: boolean;
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
    accessibilitySnapshot: vi.fn(overrides.accessibilitySnapshot ?? (async () => [])),
    evaluate: vi.fn(overrides.evaluate ?? (async () => ({ type: 'string', json: '"ok"' }))),
    queryElements: vi.fn(async () => []),
    inspectElement: vi.fn(async () => ({
      role: 'button',
      accessibleName: 'Continue',
    })),
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    fillForm: vi.fn(async () => undefined),
    select: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => undefined),
    downloadFile: vi.fn(async () => ({
      id: 'download-1',
      url: 'http://localhost:4567/download',
      filename: '/tmp/browser-profiles/profile-1/Downloads/download.bin',
      state: 'complete',
    })),
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
    resolveRequest: vi.fn((requestId: string, resolution: { status: BrowserApprovalRequest['status']; grantId?: string }) => {
      const request = approvalRequests.find((item) => item.requestId === requestId);
      if (!request) {
        return null;
      }
      request.status = resolution.status;
      request.grantId = resolution.grantId ?? request.grantId;
      request.decidedAt = Date.now();
      return request;
    }),
  };
  const profileRegistry = {
    createProfile: vi.fn((input) => ({ ...(profile ?? makeProfile()), ...input })),
    resolveProfileDir: vi.fn((profileId) => `/tmp/browser-profiles/${profileId}`),
  };
  const profileStore = {
    listProfiles: () => profiles,
    getProfile: (profileId: string) => (profile && profileId === profile.id ? profile : null),
    updateProfile: vi.fn((_profileId, patch) => ({ ...(profile ?? makeProfile()), ...patch })),
    deleteProfile: vi.fn(),
    setRuntimeState: vi.fn((_profileId: string, patch) => ({ ...(profile ?? makeProfile()), ...patch })),
  };
  const extensionTabStore = {
    attachTab: vi.fn((input, options?: { nodeId?: string; nodeName?: string }) => ({
      profileId: `existing-tab:${input.windowId}:${input.tabId}`,
      targetId: `existing-tab:${input.windowId}:${input.tabId}:target`,
      tabId: input.tabId,
      windowId: input.windowId,
      ...(options?.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options?.nodeName ? { nodeName: options.nodeName } : {}),
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
        ? {
          tabId: overrides.existingTab.tabId ?? 42,
          windowId: overrides.existingTab.windowId ?? 7,
          attachedAt: 1,
          updatedAt: 2,
          ...overrides.existingTab,
        }
        : null,
    ),
    listTabs: vi.fn(() =>
      overrides.existingTab
        ? [{
          tabId: overrides.existingTab.tabId ?? 42,
          windowId: overrides.existingTab.windowId ?? 7,
          attachedAt: 1,
          updatedAt: 2,
          ...overrides.existingTab,
        }]
        : [],
    ),
    detachTab: vi.fn(),
  };
  const serviceOptions: BrowserGatewayServiceOptions = {
    profileStore,
    profileRegistry,
    targetRegistry: {
      listTargets: (profileId?: string) =>
        !profileId || profileId === target.profileId ? [target] : [],
      selectTarget: vi.fn((targetId: string) => ({ ...target, id: targetId, status: 'selected' as const })),
    },
    driver,
    extensionTabStore,
    extensionCommandStore: overrides.extensionCommandStore,
    extensionContactState: overrides.extensionContactState ?? {
      getLastExtensionContactAt: () => Date.now(),
      isExtensionContactFresh: () => true,
      describeExtensionContact: (nodeId: string) => ({
        nodeId,
        lastContactAt: Date.now(),
        silent: false,
      }),
    },
    auditStore,
    grantStore,
    approvalStore,
    autoApproveRequests: overrides.autoApproveRequests,
    resolvePreferredDebugPort: overrides.resolvePreferredDebugPort,
    stageUploadFileOnNode: overrides.stageUploadFileOnNode,
    healthService: {
      diagnose: async (): Promise<BrowserGatewayHealthReport> => ({
        status: 'ready',
        checkedAt: 1,
        chromeRuntime: {
          available: true,
        },
        managedProfiles: {
          total: profiles.length,
          running: profiles.filter((item) => item.status === 'running').length,
          locked: 0,
          errors: 0,
        },
        mcpBridge: {
          available: true,
        },
        remoteExtensions: {
          total: 0,
          ready: 0,
          silent: 0,
          nodes: [],
        },
        providerCapabilities: {
          claude: 'available_via_mcp',
          copilot: 'available_via_acp_mcp',
          codex: 'available_via_mcp',
          gemini: 'unconfigured_adapter_injection_missing',
        },
        providerCapabilityDetails: {
          claude: {
            available: true,
            status: 'available_via_mcp',
            message: 'Available',
          },
          copilot: {
            available: true,
            status: 'available_via_acp_mcp',
            message: 'Available',
          },
          codex: {
            available: true,
            status: 'available_via_mcp',
            message: 'Available',
          },
          gemini: {
            available: false,
            status: 'unconfigured_adapter_injection_missing',
            message: 'Unavailable',
          },
        },
        rawLegacyAutomation: {
          surface: 'legacy_raw_browser_automation',
          status: 'ready',
          checkedAt: 1,
          runtimeAvailable: true,
          nodeAvailable: true,
          inAppConfigured: true,
          inAppConnected: true,
          inAppToolCount: 1,
          configDetected: true,
          configSources: [],
          browserToolNames: ['browser_snapshot'],
          warnings: [],
          suggestions: [],
        },
        warnings: [],
      }),
    },
  };
  const service = overrides.useSingleton
    ? BrowserGatewayService.initialize(serviceOptions)
    : new BrowserGatewayService(serviceOptions);

  return {
    service,
    audits,
    driver,
    auditStore,
    grantStore,
    approvalStore,
    approvalRequests,
    grants,
    profileStore,
    profileRegistry,
    extensionTabStore,
  };
}

export function makeGrant(overrides: Partial<BrowserPermissionGrant> = {}): BrowserPermissionGrant {
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
