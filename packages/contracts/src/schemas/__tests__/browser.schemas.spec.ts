import { describe, expect, it } from 'vitest';
import {
  BrowserAllowedOriginSchema,
  BrowserApprovalRequestSchema,
  BrowserAttachExistingTabRequestSchema,
  BrowserCreateProfileRequestSchema,
  BrowserGatewayResultSchema,
  BrowserPermissionGrantSchema,
  BrowserClickRequestSchema,
  BrowserManualStepRequestSchema,
  BrowserTypeRequestSchema,
  BrowserUploadFileRequestSchema,
  BrowserListAuditLogRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserProfileSchema,
  BrowserRequestUserLoginRequestSchema,
  BrowserScreenshotRequestSchema,
  BrowserTargetSchema,
  BrowserUpdateProfileRequestSchema,
} from '../browser.schemas';

describe('browser.schemas', () => {
  it('accepts a strict profile create request with allowed origins', () => {
    const result = BrowserCreateProfileRequestSchema.safeParse({
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

    expect(result.success).toBe(true);
  });

  it('rejects unknown create-profile fields and invalid browser values', () => {
    const result = BrowserCreateProfileRequestSchema.safeParse({
      label: 'Edge',
      mode: 'session',
      browser: 'edge',
      allowedOrigins: [],
      extra: true,
    });

    expect(result.success).toBe(false);
  });

  it('accepts selected existing-tab attachments from the browser extension', () => {
    const result = BrowserAttachExistingTabRequestSchema.safeParse({
      tabId: 42,
      windowId: 7,
      url: 'https://play.google.com/console/u/0/developers',
      title: 'Google Play Console',
      text: 'Production release dashboard',
      screenshotBase64: Buffer.from('png').toString('base64'),
      capturedAt: 1_700_000_000_000,
    });

    expect(result.success).toBe(true);
  });

  it('rejects non-web existing-tab attachments', () => {
    const result = BrowserAttachExistingTabRequestSchema.safeParse({
      tabId: 42,
      windowId: 7,
      url: 'chrome://settings',
      title: 'Settings',
    });

    expect(result.success).toBe(false);
  });

  it('validates allowed origin bounds', () => {
    expect(
      BrowserAllowedOriginSchema.safeParse({
        scheme: 'https',
        hostPattern: 'a'.repeat(255),
        port: 443,
        includeSubdomains: false,
      }).success,
    ).toBe(true);

    expect(
      BrowserAllowedOriginSchema.safeParse({
        scheme: 'ftp',
        hostPattern: 'example.com',
        port: 70000,
        includeSubdomains: false,
      }).success,
    ).toBe(false);
  });

  it('allows partial strict profile updates', () => {
    const result = BrowserUpdateProfileRequestSchema.safeParse({
      label: 'Renamed',
      allowedOrigins: [
        {
          scheme: 'http',
          hostPattern: 'localhost',
          port: 4567,
          includeSubdomains: false,
        },
      ],
    });

    expect(result.success).toBe(true);
    expect(BrowserUpdateProfileRequestSchema.safeParse({ extra: 'nope' }).success).toBe(false);
  });

  it('validates profile and target DTOs', () => {
    expect(
      BrowserProfileSchema.safeParse({
        id: 'profile-1',
        label: 'Local Test',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'running',
        createdAt: 1,
        updatedAt: 2,
        debugPort: 9222,
        debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id',
      }).success,
    ).toBe(true);

    expect(
      BrowserTargetSchema.safeParse({
        id: 'target-1',
        profileId: 'profile-1',
        mode: 'session',
        driver: 'cdp',
        status: 'available',
        lastSeenAt: 3,
      }).success,
    ).toBe(true);
  });

  it('validates navigation and screenshot payload limits', () => {
    expect(
      BrowserNavigateRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        url: 'http://localhost:4567',
      }).success,
    ).toBe(true);

    expect(
      BrowserScreenshotRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        maxWidth: 99,
        maxHeight: 4097,
      }).success,
    ).toBe(false);
  });

  it('requires requestId on requires_user gateway results', () => {
    const result = BrowserGatewayResultSchema.safeParse({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'manual_login_required',
      auditId: 'audit-1',
    });

    expect(result.success).toBe(false);
    expect(
      BrowserGatewayResultSchema.safeParse({
        decision: 'requires_user',
        outcome: 'not_run',
        reason: 'manual_login_required',
        requestId: 'request-1',
        auditId: 'audit-1',
      }).success,
    ).toBe(true);
  });

  it('rejects impossible gateway decision and outcome combinations', () => {
    expect(
      BrowserGatewayResultSchema.safeParse({
        decision: 'denied',
        outcome: 'succeeded',
        auditId: 'audit-1',
      }).success,
    ).toBe(false);

    expect(
      BrowserGatewayResultSchema.safeParse({
        decision: 'requires_user',
        outcome: 'failed',
        auditId: 'audit-2',
      }).success,
    ).toBe(false);

    expect(
      BrowserGatewayResultSchema.safeParse({
        decision: 'allowed',
        outcome: 'not_run',
        auditId: 'audit-3',
      }).success,
    ).toBe(false);
  });

  it('validates audit log filters and caps limits', () => {
    expect(
      BrowserListAuditLogRequestSchema.safeParse({
        profileId: 'profile-1',
        limit: 100,
      }).success,
    ).toBe(true);

    expect(BrowserListAuditLogRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('validates v2 browser permission grants and caps autonomous expiry', () => {
    const base = {
      id: 'grant-1',
      mode: 'autonomous',
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
      allowedActionClasses: ['input', 'submit'],
      allowExternalNavigation: true,
      autonomous: true,
      requestedBy: 'user',
      decidedBy: 'user',
      decision: 'allow',
      createdAt: 1_000,
      expiresAt: 1_000 + 8 * 60 * 60 * 1000,
    };

    expect(BrowserPermissionGrantSchema.safeParse(base).success).toBe(true);
    expect(
      BrowserPermissionGrantSchema.safeParse({
        ...base,
        expiresAt: 1_000 + 25 * 60 * 60 * 1000,
      }).success,
    ).toBe(false);
    expect(
      BrowserPermissionGrantSchema.safeParse({
        ...base,
        mode: 'per_action',
        allowedActionClasses: ['input'],
        autonomous: false,
        consumedAt: 2_000,
      }).success,
    ).toBe(true);
  });

  it('validates browser approval requests', () => {
    const result = BrowserApprovalRequestSchema.safeParse({
      id: 'request-1',
      requestId: 'request-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      profileId: 'profile-1',
      targetId: 'target-1',
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'submit',
      origin: 'https://play.google.com',
      url: 'https://play.google.com/console',
      selector: 'button[type="submit"]',
      elementContext: {
        role: 'button',
        accessibleName: 'Submit for review',
      },
      proposedGrant: {
        mode: 'per_action',
        allowedActionClasses: ['submit'],
        allowedOrigins: [
          {
            scheme: 'https',
            hostPattern: 'play.google.com',
            includeSubdomains: true,
          },
        ],
        autonomous: false,
        allowExternalNavigation: false,
      },
      status: 'pending',
      createdAt: 1,
      expiresAt: 60_001,
    });

    expect(result.success).toBe(true);
  });

  it('validates mutating browser action payloads', () => {
    expect(
      BrowserClickRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'button.publish',
        actionHint: 'publish',
      }).success,
    ).toBe(true);
    expect(
      BrowserTypeRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[name="title"]',
        value: 'Release notes',
      }).success,
    ).toBe(true);
    expect(
      BrowserUploadFileRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        selector: 'input[type="file"]',
        filePath: '/workspace/app/build.aab',
      }).success,
    ).toBe(true);
  });

  it('validates human handoff browser payloads', () => {
    expect(
      BrowserRequestUserLoginRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        reason: 'Google Play Console needs a fresh user login.',
      }).success,
    ).toBe(true);
    expect(
      BrowserManualStepRequestSchema.safeParse({
        profileId: 'profile-1',
        targetId: 'target-1',
        kind: 'two_factor',
        reason: 'Enter the authenticator code shown on the device.',
      }).success,
    ).toBe(true);
    expect(
      BrowserManualStepRequestSchema.safeParse({
        profileId: 'profile-1',
        kind: 'unsupported',
      }).success,
    ).toBe(false);
  });
});
