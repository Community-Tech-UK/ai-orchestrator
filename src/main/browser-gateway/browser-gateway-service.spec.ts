import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeGrant, makeProfile, makeService, makeTarget } from './browser-gateway-service.test-helpers';

describe('BrowserGatewayService', () => {
  it('returns an actionable bootstrap reason when no managed profiles exist', async () => {
    const { service } = makeService({ profile: null, profiles: [] });

    await expect(service.listProfiles({
      instanceId: 'instance-1',
      provider: 'claude',
    })).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'no_managed_profiles_configured_use_browser_find_or_open_or_share_current_tab',
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

  it('denies opening a profile when its default URL is outside allowed origins', async () => {
    const { service, driver } = makeService({
      profile: makeProfile({
        defaultUrl: 'https://example.com/outside',
      }),
    });

    const result = await service.openProfile({
      profileId: 'profile-1',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'host_not_allowed',
    });
    expect(driver.openProfile).not.toHaveBeenCalled();
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

  it('auto-approves ungranted browser actions for YOLO instances', async () => {
    const { service, driver, approvalStore, grants } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
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
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      allowedActionClasses: ['input'],
      autonomous: false,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('redacts element context before storing approval requests', async () => {
    const { service, driver, approvalRequests } = makeService();
    driver.inspectElement.mockResolvedValueOnce({
      role: 'input',
      accessibleName: 'Token',
      visibleText: 'token=abc123',
      inputName: 'api_token',
      attributes: {
        value: 'abc123',
        'data-token': 'secret-token',
        'data-safe': 'safe-value',
      },
    });

    await service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="api_token"]',
      value: 'ignored',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(approvalRequests[0]?.elementContext).toMatchObject({
      visibleText: 'token=[REDACTED]',
      attributes: {
        value: '[REDACTED]',
        'data-token': '[REDACTED]',
        'data-safe': 'safe-value',
      },
    });
    expect(JSON.stringify(approvalRequests[0])).not.toContain('abc123');
    expect(JSON.stringify(approvalRequests[0])).not.toContain('secret-token');
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

  it('auto-approves explicit browser grant requests for YOLO instances', async () => {
    const { service, approvalStore, grants } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const result = await service.requestGrant({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      proposedGrant: {
        mode: 'autonomous',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['read', 'navigate', 'input'],
        allowExternalNavigation: false,
        autonomous: true,
      },
      reason: 'overnight form filling',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(grants[0]).toMatchObject({
      mode: 'autonomous',
      instanceId: 'instance-1',
      provider: 'copilot',
      allowedActionClasses: ['read', 'navigate', 'input'],
      autonomous: true,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('creates user-login approval requests without exposing credential entry to agents', async () => {
    const { service, approvalRequests } = makeService();

    const result = await service.requestUserLogin({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      reason: 'Google Play Console requires a fresh sign-in.',
    });

    expect(result).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
      reason: 'manual_login_required',
    });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.request_user_login',
      action: 'request_user_login',
      actionClass: 'credential',
      elementContext: {
        nearbyText: 'Google Play Console requires a fresh sign-in.',
      },
      proposedGrant: {
        mode: 'per_action',
        allowedActionClasses: ['read'],
        autonomous: false,
      },
    });
  });

  it('creates manual-step approval requests for captcha and two-factor pauses', async () => {
    const { service, approvalRequests } = makeService();

    await expect(service.pauseForManualStep({
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'two_factor',
      reason: 'Enter the authenticator code displayed on the device.',
      instanceId: 'instance-1',
      provider: 'copilot',
    })).resolves.toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      reason: 'manual_step_required',
    });
    expect(approvalRequests[0]).toMatchObject({
      toolName: 'browser.pause_for_manual_step',
      action: 'pause_for_manual_step',
      actionClass: 'credential',
      elementContext: {
        nearbyText: 'Enter the authenticator code displayed on the device.',
      },
      proposedGrant: {
        allowedActionClasses: ['read'],
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

  it('updates last login check time when a user-login approval is approved', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const { service, profileStore } = makeService();
    await service.requestUserLogin({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    await service.approveRequest({
      requestId: 'request-1',
      grant: {
        mode: 'per_action',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['read'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    });

    expect(profileStore.setRuntimeState).toHaveBeenCalledWith('profile-1', {
      lastLoginCheckAt: 5_000,
    });
    vi.useRealTimers();
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
      const { service, driver, approvalRequests } = makeService({
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
      expect(approvalRequests[0]?.filePath).toBe(fs.realpathSync(deniedFile));
      expect(approvalRequests[0]?.detectedFileType).toBe('application/zip');
      expect(approvalRequests[0]?.proposedGrant.uploadRoots).toContain(
        fs.realpathSync(deniedRoot),
      );
      expect(driver.uploadFile).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('redacts raw network details returned by alternate drivers before exposing them', async () => {
    const { service, driver } = makeService();
    driver.networkRequests.mockResolvedValueOnce([
      {
        url: 'http://localhost:4567/api?token=abc123&safe=value',
        method: 'GET',
        resourceType: 'xhr',
        headers: {
          Authorization: 'Bearer abc123',
          Accept: 'application/json',
        },
        timestamp: 1,
      },
    ]);

    const result = await service.networkRequests({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [
        {
          url: 'http://localhost:4567/api?token=%5BREDACTED%5D&safe=value',
          headers: {
            Authorization: '[REDACTED]',
            Accept: 'application/json',
          },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('abc123');
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
