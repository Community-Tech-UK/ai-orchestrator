import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DesktopGatewayService, type DesktopGatewayServiceOptions } from './desktop-gateway-service';
import { InMemoryDesktopGatewayAuditStore } from './desktop-gateway-audit-store';
import { InMemoryDesktopGrantStore } from './desktop-grant-store';
import type { DesktopDriver } from './platform/desktop-driver';
import type {
  DesktopAccessibilitySnapshotResult,
  DesktopAppDescriptor,
  DesktopScreenshotResult,
} from '../../shared/types/desktop-gateway.types';

const APP: DesktopAppDescriptor = {
  appId: 'darwin-window:preview:1',
  displayName: 'Preview',
  platform: 'darwin',
  bundleId: 'com.apple.Preview',
  pid: 123,
  windowId: 'window-1',
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

  it('denies operator permission requests without touching the driver while disabled', async () => {
    const driver = makeDriver();
    const auditStore = new InMemoryDesktopGatewayAuditStore();
    const service = makeService({ enabled: false, driver, auditStore });

    await expect(service.requestSystemPermissionForOperator('screen-recording')).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_disabled',
    });
    expect(driver.requestSystemPermission).not.toHaveBeenCalled();

    const entries = await auditStore.list({ limit: 10 });
    expect(entries[0]).toMatchObject({
      instanceId: 'operator',
      toolName: 'computer.request_permission',
      decision: 'denied',
      reason: 'computer_use_disabled',
    });
  });

  it('delegates operator permission requests with the stable operator audit context', async () => {
    const driver = makeDriver();
    const auditStore = new InMemoryDesktopGatewayAuditStore();
    const service = makeService({ enabled: true, driver, auditStore });

    await expect(service.requestSystemPermissionForOperator('accessibility')).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'ok',
      data: {
        permission: 'accessibility',
        state: 'available',
        nativeRequestAttempted: true,
      },
    });
    expect(driver.requestSystemPermission).toHaveBeenCalledWith('accessibility');
    expect(driver.requestSystemPermission).toHaveBeenCalledOnce();

    const entries = await auditStore.list({ limit: 10 });
    expect(entries[0]).toMatchObject({
      instanceId: 'operator',
      toolName: 'computer.request_permission',
      decision: 'allowed',
      redactedMetadata: expect.objectContaining({ permission: 'accessibility', state: 'available' }),
    });
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

  it('resolves an observed element uid to bounded coordinates before clicking', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-save',
          role: 'AXButton',
          label: 'Save',
          bounds: { x: 10, y: 20, width: 100, height: 40 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), {
      appId: APP.appId,
    });

    await service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      elementUid: 'ax-save',
    });

    expect(driver.click).toHaveBeenCalledWith(expect.objectContaining({
      appId: APP.appId,
      windowId: APP.windowId,
      elementUid: 'ax-save',
      x: 60,
      y: 40,
    }));
  });

  it('never trusts caller coordinates when an observed element uid is supplied', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-safe',
          role: 'AXButton',
          label: 'Continue',
          bounds: { x: 100, y: 200, width: 40, height: 20 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });

    await service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      elementUid: 'ax-safe',
      x: 0,
      y: 0,
    });

    expect(driver.click).toHaveBeenCalledWith(expect.objectContaining({ x: 120, y: 210 }));
  });

  it('allows coordinates inside the observed app and rejects off-app coordinates', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-window',
          role: 'AXWindow',
          bounds: { x: 100, y: 100, width: 400, height: 300 },
          children: [{
            uid: 'ax-safe',
            role: 'AXButton',
            label: 'Continue',
            bounds: { x: 120, y: 130, width: 80, height: 30 },
          }],
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });

    await expect(service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      x: 140,
      y: 140,
    })).resolves.toMatchObject({ decision: 'allowed', outcome: 'ok' });
    await expect(service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      x: 0,
      y: 0,
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_target_outside_approved_window',
    });
    expect(driver.click).toHaveBeenCalledOnce();
  });

  it('blocks secure text fields and sensitive observed controls without trusting caller flags', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-password',
          role: 'AXSecureTextField',
          label: 'Password',
          redacted: true,
          focused: true,
          bounds: { x: 10, y: 10, width: 120, height: 30 },
        }, {
          uid: 'ax-delete',
          role: 'AXButton',
          label: 'Delete account',
          bounds: { x: 10, y: 50, width: 120, height: 30 },
        }],
        focusedUid: 'ax-password',
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });

    await expect(service.typeText(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      text: 'ordinary-password',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    await expect(service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      elementUid: 'ax-delete',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    expect(driver.typeText).not.toHaveBeenCalled();
    expect(driver.click).not.toHaveBeenCalled();
  });

  describe('activate_window', () => {
    const MULTI_WINDOW_APP: DesktopAppDescriptor = {
      ...APP,
      visibleWindowCount: 2,
      windows: [
        { windowId: 'window-1', title: 'Duolingo', bounds: { x: 0, y: 0, width: 800, height: 600 } },
        {
          windowId: 'window-2',
          title: 'ProContract',
          // A second monitor: negative origin, different size.
          bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
        },
      ],
    };

    async function observe(driver: DesktopDriver) {
      const service = makeService({
        allowedApps: [MULTI_WINDOW_APP.appId],
        apps: [MULTI_WINDOW_APP],
        driver,
        requireApprovalForInput: false,
      });
      const snapshot = await service.accessibilitySnapshot(context(), {
        appId: MULTI_WINDOW_APP.appId,
      });
      return { service, token: snapshot.data!.observationToken! };
    }

    it('activates a specific window on another monitor and verifies which is now active', async () => {
      const driver = makeDriver({ apps: [MULTI_WINDOW_APP] });
      const { service, token } = await observe(driver);

      await expect(service.activateWindow(context(), {
        appId: MULTI_WINDOW_APP.appId,
        observationToken: token,
        windowId: 'window-2',
      })).resolves.toMatchObject({
        decision: 'allowed',
        outcome: 'ok',
        data: {
          activated: true,
          appId: MULTI_WINDOW_APP.appId,
          activeWindow: { windowId: 'window-2' },
          // Tokens are bound to their snapshot, so the caller must re-observe.
          reobserveRequired: true,
        },
      });
      expect(driver.activateWindow).toHaveBeenCalledWith(expect.objectContaining({
        appId: MULTI_WINDOW_APP.appId,
        windowId: 'window-2',
      }));
    });

    it('defaults to the observed window when no windowId is supplied', async () => {
      const driver = makeDriver({ apps: [MULTI_WINDOW_APP] });
      const { service, token } = await observe(driver);

      await service.activateWindow(context(), {
        appId: MULTI_WINDOW_APP.appId,
        observationToken: token,
      });

      expect(driver.activateWindow).toHaveBeenCalledWith(expect.objectContaining({
        windowId: 'window-1',
      }));
    });

    it('refuses a window the granted app does not own', async () => {
      const driver = makeDriver({ apps: [MULTI_WINDOW_APP] });
      const { service, token } = await observe(driver);

      await expect(service.activateWindow(context(), {
        appId: MULTI_WINDOW_APP.appId,
        observationToken: token,
        windowId: 'window-belonging-to-another-app',
      })).resolves.toMatchObject({
        decision: 'denied',
        reason: 'computer_use_target_not_found',
      });
      expect(driver.activateWindow).not.toHaveBeenCalled();
    });

    it('refuses a denied app outright', async () => {
      const driver = makeDriver({ apps: [DENIED_APP] });
      const service = makeService({
        allowedApps: [DENIED_APP.appId],
        deniedApps: [DENIED_APP.appId],
        apps: [DENIED_APP],
        driver,
        requireApprovalForInput: false,
      });

      const result = await service.activateWindow(context(), {
        appId: DENIED_APP.appId,
        observationToken: 'obs_whatever',
      });

      expect(result.decision).toBe('denied');
      expect(driver.activateWindow).not.toHaveBeenCalled();
    });

    it('requires an observation token that is still valid', async () => {
      const driver = makeDriver({ apps: [MULTI_WINDOW_APP] });
      const { service } = await observe(driver);

      await expect(service.activateWindow(context(), {
        appId: MULTI_WINDOW_APP.appId,
        observationToken: 'obs_never-issued',
      })).resolves.toMatchObject({
        decision: 'denied',
        reason: 'computer_use_stale_observation',
      });
      expect(driver.activateWindow).not.toHaveBeenCalled();
    });

    it('surfaces a driver refusal rather than reporting success', async () => {
      const driver = makeDriver({ apps: [MULTI_WINDOW_APP] });
      (driver.activateWindow as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('computer_use_target_not_active'),
      );
      const { service, token } = await observe(driver);

      await expect(service.activateWindow(context(), {
        appId: MULTI_WINDOW_APP.appId,
        observationToken: token,
        windowId: 'window-2',
      })).resolves.toMatchObject({
        decision: 'denied',
        outcome: 'failed',
        reason: 'computer_use_target_not_active',
      });
    });
  });

  it('allows navigation links whose labels contain action verbs, and still gates real commands', async () => {
    // The live ProContract breadcrumb: a plain link whose label contains
    // "Publish" and "Invite". Substring classification blocked it and made the
    // whole read-only journey impossible.
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-breadcrumb',
          role: 'AXLink',
          label: 'PA23 - 07A - Publish Tender Pack (Auto Invite)',
          url: 'https://procontract.example/activities/PA23-07A',
          bounds: { x: 10, y: 10, width: 300, height: 20 },
        }, {
          uid: 'ax-unsubscribe-link',
          role: 'AXLink',
          label: 'Unsubscribe from notifications',
          url: 'https://procontract.example/account/unsubscribe',
          bounds: { x: 10, y: 40, width: 300, height: 20 },
        }, {
          uid: 'ax-publish-button',
          role: 'AXButton',
          label: 'Publish tender pack',
          bounds: { x: 10, y: 70, width: 300, height: 20 },
        }, {
          uid: 'ax-link-no-url',
          role: 'AXLink',
          label: 'Publish tender pack',
          bounds: { x: 10, y: 100, width: 300, height: 20 },
        }, {
          uid: 'ax-js-link',
          role: 'AXLink',
          label: 'Publish tender pack',
          url: 'javascript:doPublish()',
          bounds: { x: 10, y: 130, width: 300, height: 20 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });
    const token = snapshot.data!.observationToken!;
    const clickUid = (elementUid: string) =>
      service.click(context(), { appId: APP.appId, observationToken: token, elementUid });

    await expect(clickUid('ax-breadcrumb')).resolves.toMatchObject({ decision: 'allowed' });

    // A link is still gated when it performs the state change itself...
    await expect(clickUid('ax-unsubscribe-link')).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    // ...and a command control never earns the navigation exemption...
    await expect(clickUid('ax-publish-button')).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    // ...nor does a link with no destination to prove it navigates...
    await expect(clickUid('ax-link-no-url')).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    // ...nor one whose "destination" is arbitrary script.
    await expect(clickUid('ax-js-link')).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
  });

  it('keeps credential and payment controls blocked regardless of link semantics', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-card-link',
          role: 'AXLink',
          label: 'Card number help',
          url: 'https://procontract.example/help/card-number',
          bounds: { x: 10, y: 10, width: 200, height: 20 },
        }, {
          uid: 'ax-password-link',
          role: 'AXLink',
          label: 'Password reset',
          url: 'https://procontract.example/account/password',
          bounds: { x: 10, y: 40, width: 200, height: 20 },
        }, {
          // Harmless label, effectful destination.
          uid: 'ax-sneaky-link',
          role: 'AXLink',
          label: 'Manage notifications',
          url: 'https://procontract.example/account/unsubscribe?token=abc',
          bounds: { x: 10, y: 70, width: 200, height: 20 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });
    const token = snapshot.data!.observationToken!;

    for (const elementUid of ['ax-card-link', 'ax-password-link', 'ax-sneaky-link']) {
      await expect(service.click(context(), {
        appId: APP.appId,
        observationToken: token,
        elementUid,
      })).resolves.toMatchObject({
        decision: 'denied',
        reason: 'computer_use_sensitive_action_blocked',
      });
    }
  });

  it('reclassifies an element handle center against the deepest observed child', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-window',
          role: 'AXWindow',
          label: 'Document',
          bounds: { x: 0, y: 0, width: 200, height: 200 },
          children: [{
            uid: 'ax-delete',
            role: 'AXButton',
            label: 'Delete account',
            bounds: { x: 90, y: 90, width: 20, height: 20 },
          }],
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });

    await expect(service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      elementUid: 'ax-window',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('blocks credential-submit labels and hotkeys on focused sensitive controls', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-sign-in',
          role: 'AXButton',
          label: 'Sign In',
          focused: true,
          bounds: { x: 10, y: 10, width: 100, height: 30 },
        }],
        focusedUid: 'ax-sign-in',
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });
    const base = {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
    };

    await expect(service.click(context(), {
      ...base,
      elementUid: 'ax-sign-in',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    await expect(service.hotkey(context(), {
      ...base,
      keys: ['space'],
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    await expect(service.hotkey(context(), {
      ...base,
      keys: ['cmd', 'v'],
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    expect(driver.click).not.toHaveBeenCalled();
    expect(driver.hotkey).not.toHaveBeenCalled();
  });

  it('rejects an observation after the active window changes within the approved app', async () => {
    let activeWindowId = 'window-1';
    const driver = makeDriver({
      apps: [{ ...APP, windowId: activeWindowId }],
      snapshot: {
        appId: APP.appId,
        windowId: activeWindowId,
        nodes: [{
          uid: 'ax-safe',
          role: 'AXButton',
          label: 'Save',
          bounds: { x: 10, y: 10, width: 100, height: 30 },
        }],
        capturedAt: 1,
      },
    });
    vi.mocked(driver.listApps).mockImplementation(async () => [{ ...APP, windowId: activeWindowId }]);
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });
    activeWindowId = 'window-2';

    await expect(service.click(context(), {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
      elementUid: 'ax-safe',
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_target_changed',
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it('returns a window-bound snapshot token from wait_for that can drive follow-up input', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        windowId: APP.windowId,
        nodes: [{
          uid: 'ax-save',
          role: 'AXButton',
          label: 'Save',
          bounds: { x: 10, y: 20, width: 100, height: 40 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });

    const waited = await service.waitFor(context(), {
      appId: APP.appId,
      condition: { label: 'Save' },
      timeoutMs: 100,
    });
    await expect(service.click(context(), {
      appId: APP.appId,
      observationToken: waited.data!.observationToken!,
      elementUid: 'ax-save',
    })).resolves.toMatchObject({ decision: 'allowed', outcome: 'ok' });
    expect(driver.click).toHaveBeenCalledWith(expect.objectContaining({
      windowId: APP.windowId,
      elementUid: 'ax-save',
    }));
  });

  it('keeps drags inside observed app bounds and blocks activation hotkeys', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-window',
          role: 'AXWindow',
          bounds: { x: 10, y: 10, width: 200, height: 200 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      driver,
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });
    const base = {
      appId: APP.appId,
      observationToken: snapshot.data!.observationToken!,
    };

    await expect(service.drag(context(), {
      ...base,
      start: { x: 20, y: 20 },
      end: { x: 40, y: 40 },
    })).resolves.toMatchObject({ decision: 'allowed', outcome: 'ok' });
    await expect(service.drag(context(), {
      ...base,
      start: { x: 20, y: 20 },
      end: { x: 400, y: 400 },
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_target_outside_approved_window',
    });
    await expect(service.hotkey(context(), {
      ...base,
      keys: ['enter'],
    })).resolves.toMatchObject({
      decision: 'denied',
      reason: 'computer_use_sensitive_action_blocked',
    });
    expect(driver.drag).toHaveBeenCalledOnce();
    expect(driver.hotkey).not.toHaveBeenCalled();
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
    await service.resolveAppGrant(context(), {
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

  it('starts bounded grant duration when approval is granted, not when requested', async () => {
    let now = 1_000;
    const service = makeService({
      apps: [APP],
      now: () => now,
    });
    const requested = await service.requestAppGrant(context(), {
      appId: APP.appId,
      capability: 'observe',
      reason: 'Observe Preview briefly',
      duration: 'boundedMinutes',
      minutes: 1,
    });
    now += 30_000;

    await service.resolveAppGrant(context(), {
      requestId: requested.data!.requestId,
      approved: true,
      decidedBy: 'test-operator',
    });
    const grants = await service.listGrants(context(), { includeExpired: true });

    expect(grants.data?.grants[0]?.expiresAt).toBe(91_000);
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
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-button',
          role: 'AXButton',
          label: 'Continue',
          bounds: { x: 5, y: 6, width: 20, height: 10 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      allowedApps: [APP.appId],
      apps: [APP],
      driver,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });

    await expect(
      service.click(context(), {
        appId: APP.appId,
        observationToken: snapshot.data!.observationToken!,
        elementUid: 'ax-button',
      }),
    ).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_grant_required',
    });
  });

  it('executes input actions only with an approved grant and redacts typed text from audit', async () => {
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-notes',
          role: 'AXTextArea',
          label: 'Notes',
          focused: true,
          bounds: { x: 5, y: 6, width: 200, height: 100 },
        }],
        focusedUid: 'ax-notes',
        capturedAt: 1,
      },
    });
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
    await service.resolveAppGrant(context(), {
      requestId: grant.data!.requestId,
      approved: true,
      decidedBy: 'test-operator',
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });

    await expect(
      service.typeText(context(), {
        appId: APP.appId,
        observationToken: snapshot.data!.observationToken!,
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
    const driver = makeDriver({
      apps: [APP],
      snapshot: {
        appId: APP.appId,
        nodes: [{
          uid: 'ax-button',
          role: 'AXButton',
          label: 'Continue',
          bounds: { x: 5, y: 6, width: 20, height: 10 },
        }],
        capturedAt: 1,
      },
    });
    const service = makeService({
      driver,
      now: () => now,
      allowedApps: [APP.appId],
      apps: [APP],
      requireApprovalForInput: false,
    });
    const snapshot = await service.accessibilitySnapshot(context(), { appId: APP.appId });
    now += 16_000;

    await expect(
      service.click(context(), {
        appId: APP.appId,
        observationToken: snapshot.data!.observationToken!,
        elementUid: 'ax-button',
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
  permissionRegistry?: DesktopGatewayServiceOptions['permissionRegistry'];
} = {}): DesktopGatewayService {
  return new DesktopGatewayService({
    driver: options.driver ?? makeDriver({
      apps: options.apps,
      screenshot: options.screenshot,
      snapshot: options.snapshot,
    }),
    auditStore: options.auditStore ?? new InMemoryDesktopGatewayAuditStore(),
    // Hermetic per-service stores: an in-memory grant store plus a unique temp
    // userDataPath so the file-backed session lock never bleeds state between
    // tests or runs.
    grantStore: new InMemoryDesktopGrantStore(),
    userDataPath: mkdtempSync(join(tmpdir(), 'aio-desktop-gateway-spec-')),
    permissionRegistry: options.permissionRegistry,
    settings: {
      get: ((key: string) => {
        if (key === 'computerUseEnabled') return options.enabled ?? true;
        if (key === 'computerUseAllowedAppsJson') return JSON.stringify(options.allowedApps ?? []);
        if (key === 'computerUseDeniedAppsJson') return JSON.stringify(options.deniedApps ?? []);
        if (key === 'computerUseRequireApprovalForInput') return options.requireApprovalForInput ?? true;
        if (key === 'computerUseStoreScreenshotsForEscalations') return false;
        return undefined;
      }) as unknown as NonNullable<DesktopGatewayServiceOptions['settings']>['get'],
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
      screenCapture: 'available' as const,
      accessibility: 'unavailable' as const,
      input: 'unavailable' as const,
      setupActions: [],
    })),
    requestSystemPermission: vi.fn(async (permission) => ({
      permission,
      state: 'available' as const,
      nativeRequestAttempted: true,
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
    activateWindow: vi.fn(async (request) => ({
      activated: true,
      appId: request.appId,
      activeWindow: { windowId: request.windowId ?? 'window-1', title: 'Activated' },
      reobserveRequired: true as const,
    })),
    click: vi.fn(async () => ({ status: 'ok' as const })),
    typeText: vi.fn(async () => ({ status: 'ok' as const })),
    hotkey: vi.fn(async () => ({ status: 'ok' as const })),
    scroll: vi.fn(async () => ({ status: 'ok' as const })),
    drag: vi.fn(async () => ({ status: 'ok' as const })),
  };
}
