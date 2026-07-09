import { describe, expect, it, vi } from 'vitest';
import { DesktopGatewayService } from './desktop-gateway-service';
import { InMemoryDesktopGatewayAuditStore } from './desktop-gateway-audit-store';
import type {
  DesktopAccessibilitySnapshotResult,
  DesktopAppDescriptor,
  DesktopDriver,
  DesktopScreenshotResult,
} from './platform/desktop-driver';

const APP: DesktopAppDescriptor = {
  appId: 'darwin-window:preview:1',
  displayName: 'Preview',
  platform: 'darwin',
  bundleId: 'com.apple.Preview',
  pid: 123,
  visibleWindowCount: 1,
};

const DENIED_APP: DesktopAppDescriptor = {
  appId: 'darwin-window:terminal:1',
  displayName: 'Terminal',
  platform: 'darwin',
  pid: 456,
  visibleWindowCount: 1,
};

describe('DesktopGatewayService', () => {
  it('reports disabled health without calling the driver for control status', async () => {
    const driver = makeDriver();
    const service = makeService({
      enabled: false,
      driver,
    });

    await expect(service.health(context())).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        enabled: false,
        platform: process.platform,
        injectable: false,
      },
    });
    expect(driver.health).toHaveBeenCalledOnce();
  });

  it('annotates apps with allow/deny policy without exposing command lines', async () => {
    const service = makeService({
      allowedApps: [APP.appId],
      deniedApps: [DENIED_APP.appId],
      apps: [APP, DENIED_APP],
    });

    const result = await service.listApps(context());

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        apps: [
          { appId: APP.appId, policyStatus: 'allowed' },
          { appId: DENIED_APP.appId, policyStatus: 'denied' },
        ],
      },
    });
    expect(JSON.stringify(result)).not.toContain('COMMAND_LINE');
  });

  it('captures screenshots only for allowed non-denied apps and returns an observation token', async () => {
    const service = makeService({
      allowedApps: [APP.appId],
      apps: [APP],
      screenshot: {
        appId: APP.appId,
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 20,
        height: 10,
        capturedAt: 1783468800000,
      },
    });

    const result = await service.screenshot(context(), { appId: APP.appId });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        appId: APP.appId,
        width: 20,
        height: 10,
        observationToken: expect.stringMatching(/^obs_/),
      },
    });
  });

  it('rejects screenshots when the driver returns a different app than policy approved', async () => {
    const service = makeService({
      allowedApps: [APP.appId],
      apps: [APP],
      screenshot: {
        appId: DENIED_APP.appId,
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 20,
        height: 10,
        capturedAt: 1783468800000,
      },
    });

    await expect(
      service.screenshot(context(), { appId: APP.appId }),
    ).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'failed',
      reason: 'computer_use_target_changed',
    });
  });

  it('canonicalizes grant requests made by bundle id before applying approved grants', async () => {
    const service = makeService({
      apps: [APP],
    });
    const grant = await service.requestAppGrant(context(), {
      appId: APP.bundleId!,
      capability: 'observeAndInput',
      reason: 'Use Preview by bundle id',
      duration: 'session',
    });

    expect(grant.data).toMatchObject({
      appId: APP.appId,
      status: 'pending',
    });
    await (service as any).resolveAppGrant(context(), {
      requestId: grant.data!.requestId,
      approved: true,
      decidedBy: 'test-operator',
    });

    await expect(
      service.screenshot(context(), { appId: APP.appId }),
    ).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        observationToken: expect.stringMatching(/^obs_/),
      },
    });
  });

  it('routes app grant requests through the permission registry approval path', async () => {
    const permissionRegistry = {
      requestPermission: vi.fn(async (request: { id: string }) => ({
        requestId: request.id,
        granted: true,
        decidedBy: 'user' as const,
        decidedAt: 1783468800001,
      })),
    };
    const service = makeService({
      apps: [APP],
      permissionRegistry,
    });
    const grant = await service.requestAppGrant(context(), {
      appId: APP.appId,
      capability: 'observeAndInput',
      reason: 'Use Preview for a controlled flow',
      duration: 'session',
    });

    expect(permissionRegistry.requestPermission).toHaveBeenCalledWith(expect.objectContaining({
      id: grant.data!.requestId,
      instanceId: 'instance-1',
      action: 'desktop_computer_use_grant',
      toolName: 'computer.request_app_grant',
      details: expect.objectContaining({
        appId: APP.appId,
        capability: 'observeAndInput',
      }),
    }));
    await vi.waitFor(async () => {
      await expect(
        service.getApprovalStatus(context(), { requestId: grant.data!.requestId }),
      ).resolves.toMatchObject({
        data: {
          status: 'approved',
          grantId: expect.stringMatching(/^desktop_grant_/),
        },
      });
    });
  });

  it('denies hard-deny apps even when settings allow them', async () => {
    const service = makeService({
      allowedApps: [DENIED_APP.appId],
      apps: [DENIED_APP],
    });

    await expect(
      service.screenshot(context(), { appId: DENIED_APP.appId }),
    ).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_app_denied',
    });
  });

  it('does not create grant requests for hard-denied apps', async () => {
    const service = makeService({
      apps: [DENIED_APP],
    });

    await expect(
      service.requestAppGrant(context(), {
        appId: DENIED_APP.appId,
        capability: 'observe',
        reason: 'Need to inspect a terminal',
        duration: 'session',
      }),
    ).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_app_denied',
    });
  });

  it('redacts screenshot bytes and typed text from audit entries', async () => {
    const auditStore = new InMemoryDesktopGatewayAuditStore();
    const service = makeService({
      auditStore,
      allowedApps: [APP.appId],
      apps: [APP],
      screenshot: {
        appId: APP.appId,
        data: 'iVBORw0KGgo=',
        mimeType: 'image/png',
        width: 20,
        height: 10,
        capturedAt: 1783468800000,
      },
    });

    await service.screenshot(context(), {
      appId: APP.appId,
      metadata: { text: 'secret typed text', data: 'iVBORw0KGgo=' },
    });

    const audit = await service.getAuditLog(context(), { limit: 10 });

    expect(JSON.stringify(audit)).not.toContain('secret typed text');
    expect(JSON.stringify(audit)).not.toContain('iVBORw0KGgo=');
    expect(audit).toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        entries: [
          {
            toolName: 'computer.screenshot',
            decision: 'allowed',
            resultCode: 'ok',
          },
        ],
      },
    });
  });

  it('records escalation requests without treating them as granted actions', async () => {
    const service = makeService();

    await expect(
      service.raiseEscalation(context(), {
        kind: 'credential_request',
        reason: 'Login form needs James',
      }),
    ).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        escalationId: expect.stringMatching(/^esc_/),
        status: 'recorded',
      },
    });
  });

  it('requires an approved input grant before clicking even with a fresh observation token', async () => {
    const service = makeService({
      allowedApps: [APP.appId],
      apps: [APP],
    });
    const screenshot = await service.screenshot(context(), { appId: APP.appId });

    await expect(
      (service as any).click(context(), {
        appId: APP.appId,
        observationToken: screenshot.data!.observationToken,
        x: 5,
        y: 6,
      }),
    ).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_grant_required',
    });
  });

  it('executes input actions only with an approved grant and redacts typed text from audit', async () => {
    const driver = makeDriver({ apps: [APP] });
    const auditStore = new InMemoryDesktopGatewayAuditStore();
    const service = makeService({
      driver,
      auditStore,
      allowedApps: [APP.appId],
      apps: [APP],
    });
    const grant = await service.requestAppGrant(context(), {
      appId: APP.appId,
      capability: 'observeAndInput',
      reason: 'Fill the controlled test app',
      duration: 'session',
    });
    await (service as any).resolveAppGrant(context(), {
      requestId: grant.data!.requestId,
      approved: true,
      decidedBy: 'test-operator',
    });
    const screenshot = await service.screenshot(context(), { appId: APP.appId });

    await expect(
      (service as any).typeText(context(), {
        appId: APP.appId,
        observationToken: screenshot.data!.observationToken,
        text: 'super secret typed value',
      }),
    ).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: { status: 'ok' },
    });
    expect(driver.typeText).toHaveBeenCalledWith(expect.objectContaining({
      appId: APP.appId,
      text: 'super secret typed value',
    }));

    const audit = await service.getAuditLog(context(), { limit: 10 });
    expect(JSON.stringify(audit)).not.toContain('super secret typed value');
    expect(audit.data!.entries[0]).toMatchObject({
      toolName: 'computer.type_text',
      decision: 'allowed',
      resultCode: 'ok',
      appId: APP.appId,
      grantId: expect.stringMatching(/^desktop_grant_/),
    });
  });

  it('rejects stale observation tokens before running the input driver', async () => {
    let now = 1783468800000;
    const driver = makeDriver({ apps: [APP] });
    const service = makeService({
      driver,
      now: () => now,
      allowedApps: [APP.appId],
      apps: [APP],
      requireApprovalForInput: false,
    });
    const screenshot = await service.screenshot(context(), { appId: APP.appId });
    now += 16_000;

    await expect(
      (service as any).click(context(), {
        appId: APP.appId,
        observationToken: screenshot.data!.observationToken,
        x: 5,
        y: 6,
      }),
    ).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_stale_observation',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });
});

function context() {
  return { instanceId: 'instance-1', provider: 'codex' };
}

function makeService(options: {
  enabled?: boolean;
  allowedApps?: string[];
  deniedApps?: string[];
  apps?: DesktopAppDescriptor[];
  screenshot?: DesktopScreenshotResult;
  snapshot?: DesktopAccessibilitySnapshotResult;
  driver?: DesktopDriver;
  auditStore?: InMemoryDesktopGatewayAuditStore;
  now?: () => number;
  requireApprovalForInput?: boolean;
  permissionRegistry?: ConstructorParameters<typeof DesktopGatewayService>[0]['permissionRegistry'];
} = {}): DesktopGatewayService {
  return new DesktopGatewayService({
    driver: options.driver ?? makeDriver({
      apps: options.apps,
      screenshot: options.screenshot,
      snapshot: options.snapshot,
    }),
    auditStore: options.auditStore ?? new InMemoryDesktopGatewayAuditStore(),
    permissionRegistry: options.permissionRegistry,
    settings: {
      get: (key) => {
        if (key === 'computerUseEnabled') return options.enabled ?? true;
        if (key === 'computerUseAllowedAppsJson') return JSON.stringify(options.allowedApps ?? []);
        if (key === 'computerUseDeniedAppsJson') return JSON.stringify(options.deniedApps ?? []);
        if (key === 'computerUseRequireApprovalForInput') return options.requireApprovalForInput ?? true;
        if (key === 'computerUseStoreScreenshotsForEscalations') return false;
        return undefined;
      },
    },
    now: options.now ?? (() => 1783468800000),
    tokenBytes: () => 'abcdef1234567890',
  });
}

function makeDriver(options: {
  apps?: DesktopAppDescriptor[];
  screenshot?: DesktopScreenshotResult;
  snapshot?: DesktopAccessibilitySnapshotResult;
} = {}): DesktopDriver {
  return {
    health: vi.fn(async () => ({
      platform: process.platform,
      supported: true,
      screenCapture: 'available',
      accessibility: 'unavailable',
      input: 'unavailable',
      setupActions: [],
    })),
    listApps: vi.fn(async () => options.apps ?? [APP]),
    screenshot: vi.fn(async () => options.screenshot ?? {
      appId: APP.appId,
      data: 'iVBORw0KGgo=',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      capturedAt: 1783468800000,
    }),
    accessibilitySnapshot: vi.fn(async () => options.snapshot ?? {
      appId: APP.appId,
      nodes: [],
      capturedAt: 1783468800000,
    }),
    click: vi.fn(async () => ({ status: 'ok' })),
    typeText: vi.fn(async () => ({ status: 'ok' })),
    hotkey: vi.fn(async () => ({ status: 'ok' })),
    scroll: vi.fn(async () => ({ status: 'ok' })),
    drag: vi.fn(async () => ({ status: 'ok' })),
  };
}
