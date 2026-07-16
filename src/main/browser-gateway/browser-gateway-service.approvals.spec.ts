import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { stopBrowserCampaignRuntime } from './browser-campaign-runtime';
import { makeGrant, makeProfile, makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import type { FillControlReadback } from './browser-fill-plan-executor';
import type { BrowserElementContext } from '@contracts/types/browser';

/**
 * `makeService()`'s default driver mocks (browser-gateway-service.test-helpers.ts)
 * infer narrow literal return types for `readControl`/`inspectElement` from
 * their default implementations. These helpers re-type those mocks to the
 * real driver contracts so per-test `mockResolvedValueOnce` overrides can use
 * the full shape without touching the shared test-helpers file.
 */
function readControlMock(driver: { readControl: unknown }): Mock<
  (profileId: string, targetId: string, selector: string) => Promise<FillControlReadback>
> {
  return driver.readControl as Mock<
    (profileId: string, targetId: string, selector: string) => Promise<FillControlReadback>
  >;
}

function inspectElementMock(driver: { inspectElement: unknown }): Mock<
  (profileId: string, targetId: string, selector: string) => Promise<BrowserElementContext>
> {
  return driver.inspectElement as Mock<
    (profileId: string, targetId: string, selector: string) => Promise<BrowserElementContext>
  >;
}

describe('BrowserGatewayService approvals', () => {
  afterEach(() => {
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
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

  it('auto-approves submit-classified actions for YOLO instances with a usable autonomous grant', async () => {
    const { service, driver, grants, approvalRequests } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });
    driver.inspectElement.mockResolvedValueOnce({
      role: 'button',
      accessibleName: 'Save changes',
    });

    const result = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'codex',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.save');
    // The auto-approved grant must be autonomous or the submit-class recheck
    // would immediately reject it and re-prompt the user despite yolo.
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      allowedActionClasses: ['submit'],
      autonomous: true,
    });
    expect(approvalRequests).toHaveLength(1);
  });

  it('creates a usable grant when the user approves a submit action per_action', async () => {
    const { service, driver, grants, approvalRequests } = makeService();
    driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Save changes',
    });

    const first = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    expect(first).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
    });

    // Approve with the dialog default: the proposed per_action grant.
    await service.approveRequest({
      requestId: approvalRequests[0].requestId,
      grant: approvalRequests[0].proposedGrant,
      reason: 'Approved from session page',
    });
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      allowedActionClasses: ['submit'],
      autonomous: true,
    });

    const retry = await service.click({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'button.save',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    expect(retry).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', 'button.save');
  });

  it('auto-approves a grant change between preparation and execution for YOLO instances', async () => {
    const grant = makeGrant({ mode: 'per_action' });
    const { service, driver, grantStore, approvalStore } = makeService({
      grants: [grant],
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });
    // First lookup (preparation) sees the grant; every later lookup (the
    // pre-execution recheck) sees it gone, simulating a revocation race.
    grantStore.listGrants
      .mockImplementationOnce(() => [grant])
      .mockImplementation(() => []);

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
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-2',
    });
  });

  it('installs auto-approval when the singleton already exists before runtime initialization', async () => {
    BrowserGatewayService._resetForTesting();
    const { service, driver, approvalStore, grants } = makeService({
      useSingleton: true,
    });

    BrowserGatewayService.initialize({
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
      instanceId: 'instance-1',
      allowedActionClasses: ['input'],
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
  });

  it('redacts element context before storing approval requests', async () => {
    const { service, driver, approvalRequests } = makeService();
    inspectElementMock(driver).mockResolvedValueOnce({
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

  it('consumes per-action grants after successful typed input', async () => {
    const { service, grantStore } = makeService({
      grants: [
        makeGrant({
          mode: 'per_action',
          allowedActionClasses: ['input'],
        }),
      ],
    });

    const result = await service.type({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'input[name="title"]',
      value: 'Release notes',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(grantStore.consumeGrant).toHaveBeenCalledWith('grant-1');
  });

  it('consumes per-action grants after successful file downloads', async () => {
    const { service, grantStore } = makeService({
      grants: [
        makeGrant({
          mode: 'per_action',
          allowedActionClasses: ['file-download'],
        }),
      ],
    });

    const result = await service.downloadFile({
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'a.report',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(grantStore.consumeGrant).toHaveBeenCalledWith('grant-1');
  });

  it('fails verified click when read-back does not match the expectation', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    readControlMock(driver).mockResolvedValueOnce({ checked: false });

    const request: Parameters<BrowserGatewayService['click']>[0] = {
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: '#terms',
      verify: { checked: true },
      instanceId: 'instance-1',
      provider: 'copilot',
    };
    const result = await service.click(request);

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: expect.stringContaining('browser_verify_mismatch') as string,
    });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', '#terms');
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', '#terms');
  });

  it('fails verified select when selected label read-back does not match', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    readControlMock(driver).mockResolvedValueOnce({ value: 'internal', selectedLabel: 'Internal' });

    const request: Parameters<BrowserGatewayService['select']>[0] = {
      profileId: 'profile-1',
      targetId: 'target-1',
      selector: 'select.track',
      value: 'production',
      verify: { selectedLabel: 'Production' },
      instanceId: 'instance-1',
      provider: 'copilot',
    };
    const result = await service.select(request);

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: expect.stringContaining('browser_verify_mismatch') as string,
    });
    expect(driver.select).toHaveBeenCalledWith('profile-1', 'target-1', 'select.track', 'production');
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', 'select.track');
  });

  it('fails verified fill_form when any field read-back does not match', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant()],
    });
    readControlMock(driver)
      .mockResolvedValueOnce({ value: 'One' })
      .mockResolvedValueOnce({ value: 'wrong' });

    const request: Parameters<BrowserGatewayService['fillForm']>[0] = {
      profileId: 'profile-1',
      targetId: 'target-1',
      fields: [
        { selector: '#one', value: 'One', verify: { value: 'One' } },
        { selector: '#two', value: 'Two', verify: { value: 'Two' } },
      ],
      instanceId: 'instance-1',
      provider: 'copilot',
    };
    const result = await service.fillForm(request);

    expect(driver.fillForm).toHaveBeenCalledWith('profile-1', 'target-1', [
      { selector: '#one', value: 'One' },
      { selector: '#two', value: 'Two' },
    ]);
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', '#one');
    expect(driver.readControl).toHaveBeenCalledWith('profile-1', 'target-1', '#two');
    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'failed',
      reason: expect.stringContaining('browser_verify_mismatch') as string,
    });
  });

  it('blocks fill_form atomically when a field is credential-like', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input', 'credential'] })],
    });
    inspectElementMock(driver)
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

  it('auto-approves manual handoff requests for YOLO instances without surfacing a prompt', async () => {
    const { service, approvalStore, grants, profileStore } = makeService({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const login = await service.requestUserLogin({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      reason: 'Sign in required.',
    });
    expect(login).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'auto_approved_by_yolo_mode',
    });
    expect('requestId' in login).toBe(false);
    expect(grants[0]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      provider: 'claude',
      allowedActionClasses: ['read'],
      autonomous: false,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });
    expect(profileStore.setRuntimeState).toHaveBeenCalledWith('profile-1', {
      lastLoginCheckAt: expect.any(Number),
    });

    const manualStep = await service.pauseForManualStep({
      profileId: 'profile-1',
      targetId: 'target-1',
      kind: 'two_factor',
      instanceId: 'instance-1',
      provider: 'claude',
      reason: 'Enter the authenticator code.',
    });
    expect(manualStep).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      reason: 'auto_approved_by_yolo_mode',
    });
    expect('requestId' in manualStep).toBe(false);
    expect(grants[1]).toMatchObject({
      mode: 'per_action',
      instanceId: 'instance-1',
      provider: 'claude',
      allowedActionClasses: ['read'],
      autonomous: false,
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-2', {
      status: 'approved',
      grantId: 'grant-2',
    });
  });

  it('auto-resolves stale pending browser approvals when YOLO is enabled before listing', async () => {
    BrowserGatewayService._resetForTesting();
    const { service, approvalStore, grants } = makeService({
      useSingleton: true,
    });

    const pending = await service.pauseForManualStep({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'codex',
      reason: 'Refresh the shared tab.',
    });
    expect(pending).toMatchObject({
      decision: 'requires_user',
      outcome: 'not_run',
      requestId: 'request-1',
    });

    BrowserGatewayService.initialize({
      autoApproveRequests: ({ instanceId }) => instanceId === 'instance-1',
    });

    const listed = await service.listApprovalRequests({
      instanceId: 'instance-1',
      status: 'pending',
    });
    expect(listed).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: [],
    });
    expect(grants[0]).toMatchObject({
      id: 'grant-1',
      instanceId: 'instance-1',
      provider: 'codex',
    });
    expect(approvalStore.resolveRequest).toHaveBeenCalledWith('request-1', {
      status: 'approved',
      grantId: 'grant-1',
    });

    await expect(service.getApprovalStatus({
      requestId: 'request-1',
      instanceId: 'instance-1',
      provider: 'codex',
    })).resolves.toMatchObject({
      decision: 'allowed',
      data: {
        requestId: 'request-1',
        status: 'approved',
        grantId: 'grant-1',
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
});
