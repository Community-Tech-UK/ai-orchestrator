import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { BrowserCampaignService } from './browser-campaign-store';
import {
  initializeBrowserCampaignRuntime,
  stopBrowserCampaignRuntime,
} from './browser-campaign-runtime';
import {
  makeGrant,
  makeProfile,
  makeService,
  makeTarget,
} from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import type { FillControlReadback } from './browser-fill-plan-executor';
import type { BrowserNetworkRequestEntry } from './puppeteer-browser-driver';
import { BrowserExtensionContactState } from './browser-extension-contact-state';

/**
 * `makeService()`'s default driver mocks (browser-gateway-service.test-helpers.ts)
 * infer narrow literal return types for `readControl`/`networkRequests` from
 * their default implementations. These helpers re-type those mocks to the
 * real driver contracts so per-test overrides can use the full shape without
 * touching the shared test-helpers file.
 */
function readControlMock(driver: { readControl: unknown }): Mock<
  (profileId: string, targetId: string, selector: string) => Promise<FillControlReadback>
> {
  return driver.readControl as Mock<
    (profileId: string, targetId: string, selector: string) => Promise<FillControlReadback>
  >;
}

function networkRequestsMock(driver: { networkRequests: unknown }): Mock<
  (profileId: string, targetId: string) => Promise<BrowserNetworkRequestEntry[]>
> {
  return driver.networkRequests as Mock<
    (profileId: string, targetId: string) => Promise<BrowserNetworkRequestEntry[]>
  >;
}

/** A shared (non-managed) existing Chrome tab on a procurement portal. Its
 * profileId is the ephemeral `existing-tab:<window>:<tab>` form (no nodeId =
 * the coordinator's own Chrome), so its authorization scope resolves to 'local'. */
function sharedPortalTab() {
  return {
    profileId: 'existing-tab:7:42',
    targetId: 'existing-tab:7:42:target',
    title: 'Portal',
    url: 'https://portal.example.gov.uk/login',
    origin: 'https://portal.example.gov.uk',
    allowedOrigins: [
      { scheme: 'https' as const, hostPattern: 'portal.example.gov.uk', includeSubdomains: false },
    ],
  };
}

/** Extension command mock: `snapshot` reports the live portal URL; everything
 * else (type/read_control) acks. */
function portalExtensionCommandStore() {
  return {
    sendCommand: vi.fn(async (req: { command: string; payload?: Record<string, unknown> }) => {
      if (req.command === 'snapshot') {
        return { tab: { tabId: 42, windowId: 7, url: 'https://portal.example.gov.uk/login' } };
      }
      if (req.command === 'type' && req.payload?.['credentialProtection'] === 'public') {
        return { valueApplied: true };
      }
      return {
        completed: true,
        observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
      };
    }),
  };
}

function metaExtensionCommandStore() {
  return {
    sendCommand: vi.fn(async (req: { command: string }) =>
      req.command === 'snapshot'
        ? { tab: { tabId: 42, windowId: 7, url: 'https://business.facebook.com/latest/home' } }
        : {},
    ),
  };
}

function extensionContactState(extensionVersion: string | undefined) {
  return {
    getLastExtensionContactAt: vi.fn(() => Date.now()),
    isExtensionContactFresh: vi.fn(() => true),
    describeExtensionContact: vi.fn((nodeId: string) => ({
      nodeId,
      lastContactAt: Date.now(),
      silent: false,
    })),
    getContactGapStats: vi.fn(() => ({ gapCount: 0, longestGapMs: 0 })),
    getExtensionRuntime: vi.fn(() => extensionVersion
      ? { extensionVersion, extensionStartedAt: 1_000 }
      : undefined),
  };
}

describe('BrowserGatewayService credentials', () => {
  afterEach(() => {
    BrowserGatewayService._resetForTesting();
    stopBrowserCampaignRuntime();
    WorkerNodeRegistry._resetForTesting();
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
        reason: expect.stringContaining('root_not_allowed'),
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
    networkRequestsMock(driver).mockResolvedValueOnce([
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

  it('filters listed targets by remote node id', async () => {
    const { service } = makeService({
      target: makeTarget({
        nodeId: 'node-1',
        nodeName: 'Windows PC',
      }),
    });

    const matching = await service.listTargets({
      profileId: 'profile-1',
      nodeId: 'node-1',
      instanceId: 'instance-1',
      provider: 'copilot',
    });
    const other = await service.listTargets({
      profileId: 'profile-1',
      nodeId: 'node-2',
      instanceId: 'instance-1',
      provider: 'copilot',
    });

    expect(matching.data).toHaveLength(1);
    expect(matching.data?.[0]).toMatchObject({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
    });
    expect(other.data).toEqual([]);
  });

  it('executeFillPlan fills, verifies via read-back, and reports success', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input'] })],
    });
    // Read-back echoes the intended value so verification passes.
    readControlMock(driver).mockImplementation(async (_p: string, _t: string, target: string) =>
      target === '#company' ? { value: '16760348' } : { value: 'Newbury' },
    );

    const result = await service.executeFillPlan({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      steps: [
        { field: 'companyNumber', kind: 'set', target: '#company', value: '16760348' },
        { field: 'town', kind: 'set', target: '#town', value: 'Newbury' },
      ],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(result.data?.ok).toBe(true);
    expect(driver.type).toHaveBeenCalledTimes(2);
  });

  it('executeFillPlan fails loudly when a control does not reflect the intended value', async () => {
    const { service, driver } = makeService({
      grants: [makeGrant({ allowedActionClasses: ['input'] })],
    });
    // The control keeps showing an empty value — the silent no-op case.
    readControlMock(driver).mockResolvedValue({ value: '' });

    const result = await service.executeFillPlan({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      steps: [{ field: 'companyNumber', kind: 'set', target: '#company', value: '16760348' }],
      maxAttempts: 1,
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'failed' });
    expect(result.data?.ok).toBe(false);
    expect(result.data?.failedAt).toBe(0);
  });

  it('executeFillPlan refuses shared existing tabs (managed profiles only)', async () => {
    const { service, driver } = makeService({
      profile: null,
      profiles: [],
      existingTab: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        title: 'Portal',
        url: 'https://portal.example.gov.uk/form',
        origin: 'https://portal.example.gov.uk',
        text: 'application form',
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false },
        ],
      },
    });

    const result = await service.executeFillPlan({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      steps: [{ field: 'x', kind: 'set', target: '#x', value: 'y' }],
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'execute_fill_plan_managed_profile_only',
    });
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential types a vault secret without it ever appearing in the result', async () => {
    const vault = {
      getSecretForFill: vi.fn(async () => 'S3cr3t-From-Vault!'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [
        { selector: '#user', kind: 'username' },
        { selector: '#pass', kind: 'password' },
      ],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 2 } });
    // The secret was typed into the page...
    expect(driver.type).toHaveBeenCalledWith('profile-1', 'target-1', '#pass', 'S3cr3t-From-Vault!');
    // ...but never appears anywhere in the returned result (no leakage to the model).
    expect(JSON.stringify(result)).not.toContain('S3cr3t-From-Vault!');
    // Authorization was checked for the live origin.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'profile-1', origin: 'http://localhost:4567', purpose: 'login' }),
    );
  });

  it('fillCredential denies when there is no standing authorization', async () => {
    const vault = {
      getSecretForFill: vi.fn(async () => 'secret'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'origin_not_authorized' as const })),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(result.reason).toContain('credential_not_authorized');
    // Never resolved the secret or typed anything.
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential resolves an email_code from the mailbox and types it without leakage', async () => {
    const vault = {
      getSecretForFill: vi.fn(async () => 'vault-secret'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const emailCodeReader = {
      fetchCode: vi.fn(async () => ({ code: '482913', messageId: 'm-1', matchedSender: 'noreply@localhost' })),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 1 } });
    expect(driver.type).toHaveBeenCalledWith('profile-1', 'target-1', '#otp', '482913');
    expect(JSON.stringify(result)).not.toContain('482913');
    // The email_code purpose was authorization-checked for the live origin.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'http://localhost:4567', purpose: 'email_code' }),
    );
    // Default sender allowlist is derived from the live origin host.
    expect(emailCodeReader.fetchCode).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSenderDomains: ['localhost'] }),
    );
    // The vault was never touched for a mailbox code.
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
  });

  // This is the consumption point of the cross-domain OTP allowlist: the wire
  // that carries an authorization's declared `allowedSenderDomains` from
  // `authorizations.check()` into `resolveEmailSenderDomains()` at fill time
  // (`browser-form-fill-operations.ts`, the `purpose === 'email_code'` branch).
  //
  // A 2026-08-19 completion gate deleted that branch entirely — so a declared
  // allowance could never reach the fill — and 883/883 browser-gateway tests
  // still passed. It is the most load-bearing wire in the feature and the one
  // the human-only livetest exists to exercise, so it is asserted here.
  //
  // Read this together with the sibling test below: same unrelated sender
  // domain, the only difference being whether the authorization declares it.
  it('fillCredential accepts an unrelated email_code sender domain that the authorization declares', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn((input: { purpose: string }) =>
        input.purpose === 'email_code'
          ? {
            authorized: true,
            authorizationId: 'auth-1',
            allowedSenderDomains: ['notifications.service.gov.uk'],
          }
          : { authorized: true, authorizationId: 'auth-1' },
      ),
    };
    const emailCodeReader = {
      fetchCode: vi.fn(async () => ({
        code: '482913',
        messageId: 'm-1',
        matchedSender: 'noreply@notifications.service.gov.uk',
      })),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
      emailCode: { senderDomains: ['notifications.service.gov.uk'] },
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 1 } });
    // The declared domain actually reached the mailbox read — this is the
    // assertion that fails if the wiring is removed.
    expect(emailCodeReader.fetchCode).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSenderDomains: ['notifications.service.gov.uk'] }),
    );
    expect(driver.type).toHaveBeenCalledWith('profile-1', 'target-1', '#otp', '482913');
    expect(JSON.stringify(result)).not.toContain('482913');
  });

  // The negative half of the pair: an authorization that declares a *different*
  // domain must not license the requested one. Without this, the test above
  // could pass merely because the allowlist was ignored and everything allowed.
  it('fillCredential still rejects a sender domain the authorization does not declare', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({
        authorized: true,
        authorizationId: 'auth-1',
        allowedSenderDomains: ['notifications.service.gov.uk'],
      })),
    };
    const emailCodeReader = { fetchCode: vi.fn() };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
      emailCode: { senderDomains: ['some-bank.com'] },
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'email_code_sender_domain_not_allowed',
    });
    expect(emailCodeReader.fetchCode).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential rejects email_code sender domains unrelated to the live origin', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const emailCodeReader = { fetchCode: vi.fn() };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
      emailCode: { senderDomains: ['some-bank.com'] },
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'email_code_sender_domain_not_allowed',
    });
    expect(emailCodeReader.fetchCode).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential denies email_code fields when no mailbox reader is configured', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({ decision: 'denied', reason: 'email_code_reader_unavailable' });
  });

  it('fillCredential reports a failed outcome when no matching code mail arrives', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const emailCodeReader = {
      fetchCode: vi.fn(async () => {
        throw new Error('No message from an expected sender domain arrived within the recency window');
      }),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'failed' });
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential is unavailable when the vault is not configured', async () => {
    const { service } = makeService();
    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });
    expect(result).toMatchObject({ decision: 'denied', reason: 'credential_vault_unavailable' });
  });

  it('late initialization installs credential services on an already-created singleton', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({
        authorized: false as const,
        reason: 'purpose_not_authorized' as const,
      })),
    };
    const { service } = makeService({ useSingleton: true });

    BrowserGatewayService.initialize({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.createAgentCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'codex',
      username: 'test-only-user',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'credential_not_authorized:purpose_not_authorized',
    });
    expect(authorizations.check).toHaveBeenCalledWith({
      profileId: 'profile-1',
      origin: 'http://localhost:4567',
      purpose: 'register',
    });
    expect(vault.createAgentCredential).not.toHaveBeenCalled();
  });

  it('late initialization enables authorized secure filling on an existing tab', async () => {
    const vault = {
      getSecretForFill: vi.fn(async () => 'TEST_ONLY_PASSWORD_PLACEHOLDER'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })),
    };
    const extensionCommandStore = portalExtensionCommandStore();
    const { service } = makeService({
      useSingleton: true,
      existingTab: sharedPortalTab(),
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
    });

    BrowserGatewayService.initialize({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      allowSharedTabCredentialFill: () => true,
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { filled: 1 },
    });
    expect(JSON.stringify(result)).not.toContain('TEST_ONLY_PASSWORD_PLACEHOLDER');
  });

  it('late initialization installs the one-time-code reader without exposing its code', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })),
    };
    const emailCodeReader = {
      fetchCode: vi.fn(async () => ({
        code: 'TEST_ONLY_OTP_PLACEHOLDER',
        messageId: 'message-1',
        matchedSender: 'noreply@localhost',
      })),
    };
    const { service, driver } = makeService({ useSingleton: true });

    BrowserGatewayService.initialize({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      emailCodeReader,
    });

    const result = await service.fillCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#otp', kind: 'email_code' }],
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { filled: 1 },
    });
    expect(driver.type).toHaveBeenCalledWith(
      'profile-1',
      'target-1',
      '#otp',
      'TEST_ONLY_OTP_PLACEHOLDER',
    );
    expect(JSON.stringify(result)).not.toContain('TEST_ONLY_OTP_PLACEHOLDER');
  });

  it('createAgentCredential registers a vaulted account and returns only a ref + username', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({ vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' })),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const { service } = makeService({ credentialVault: vault, credentialAuthorizations: authorizations });

    const result = await service.createAgentCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      username: 'james@communitytech.co.uk',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' },
    });
    // The register authorization (not login) was checked.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'register', origin: 'http://localhost:4567' }),
    );
    expect(vault.createAgentCredential).toHaveBeenCalledWith({
      origin: 'http://localhost:4567',
      username: 'james@communitytech.co.uk',
    });
  });

  it('createAgentCredential creates an explicitly origin-bound credential from a remote extension tab without exposing a secret', async () => {
    const SECRET_MARKER = 'TEST_ONLY_VAULT_SECRET_MARKER';
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({
        vaultItemRef: 'item-instagram',
        username: '12steps.life',
        // A faulty adapter returning an extra secret must not widen the
        // model-facing result shape.
        password: SECRET_MARKER,
      })),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-instagram' })) };
    const existingTab = {
      ...sharedPortalTab(),
      profileId: 'existing-tab:n.windows-pc:7:42',
      targetId: 'existing-tab:n.windows-pc:7:42:target',
      nodeId: 'windows-pc',
      nodeName: 'Windows PC',
      title: 'Meta Business Suite',
      url: 'https://business.facebook.com/latest/home',
      origin: 'https://business.facebook.com',
      allowedOrigins: [
        { scheme: 'https' as const, hostPattern: 'business.facebook.com', includeSubdomains: false },
      ],
    };
    const { service, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore: metaExtensionCommandStore(),
      existingTab,
    });

    const result = await service.createAgentCredential({
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      instanceId: 'instance-1',
      provider: 'codex',
      itemTitle: 'Instagram — 12 Steps',
      loginUri: 'https://www.instagram.com/',
      username: '12steps.life',
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { vaultItemRef: 'item-instagram', username: '12steps.life' },
    });
    expect(authorizations.check).toHaveBeenCalledWith({
      profileId: 'windows-pc',
      origin: 'https://www.instagram.com',
      purpose: 'register',
    });
    expect(vault.createAgentCredential).toHaveBeenCalledWith({
      origin: 'https://www.instagram.com',
      itemTitle: 'Instagram — 12 Steps',
      loginUri: 'https://www.instagram.com/',
      username: '12steps.life',
    });
    expect(JSON.stringify({ result, audits })).not.toContain(SECRET_MARKER);
  });

  it('createAgentCredential fails closed on an extension tab without an origin-bound register authorization', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'origin_not_authorized' as const })),
    };
    const existingTab = {
      ...sharedPortalTab(),
      profileId: 'existing-tab:n.windows-pc:7:42',
      targetId: 'existing-tab:n.windows-pc:7:42:target',
      nodeId: 'windows-pc',
    };
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore: metaExtensionCommandStore(),
      existingTab,
    });

    const result = await service.createAgentCredential({
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      instanceId: 'instance-1',
      provider: 'codex',
      loginUri: 'https://www.instagram.com/',
      username: '12steps.life',
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(authorizations.check).toHaveBeenCalledWith({
      profileId: 'windows-pc',
      origin: 'https://www.instagram.com',
      purpose: 'register',
    });
    expect(vault.createAgentCredential).not.toHaveBeenCalled();
  });

  it('createAgentCredential rejects a forged extension profile before a node authorization can create a vault item', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({
        vaultItemRef: 'must-not-exist',
        username: '12steps.life',
      })),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-instagram' })) };
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });

    const result = await service.createAgentCredential({
      profileId: 'existing-tab:n.windows-pc:999:999',
      targetId: 'existing-tab:n.windows-pc:999:999:target',
      instanceId: 'instance-1',
      provider: 'codex',
      loginUri: 'https://www.instagram.com/',
      username: '12steps.life',
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'target_unavailable',
    });
    expect(authorizations.check).not.toHaveBeenCalled();
    expect(vault.createAgentCredential).not.toHaveBeenCalled();
  });

  it('createAgentCredential rejects a non-http or credential-bearing login URI before authorization', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn() };
    const { service } = makeService({ credentialVault: vault, credentialAuthorizations: authorizations });

    for (const loginUri of ['file:///tmp/not-a-login', 'https://user:pass@www.instagram.com/']) {
      const result = await service.createAgentCredential({
        profileId: 'profile-1',
        targetId: 'target-1',
        instanceId: 'instance-1',
        provider: 'codex',
        loginUri,
        username: '12steps.life',
      });
      expect(result).toMatchObject({
        decision: 'denied',
        outcome: 'not_run',
        reason: 'invalid_login_uri',
      });
    }

    expect(authorizations.check).not.toHaveBeenCalled();
    expect(vault.createAgentCredential).not.toHaveBeenCalled();
  });

  it('createAgentCredential records a new-account budget hit under a campaign lease', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({ vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' })),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const campaigns = new BrowserCampaignService();
    const { service, grantStore } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
    });
    const runtime = initializeBrowserCampaignRuntime({
      campaigns,
      grantStore,
      renewIntervalMs: 60 * 60 * 1000,
    });
    const campaign = campaigns.create({
      label: 'Overnight registrations',
      profileId: 'profile-1',
      allowedOrigins: ['http://localhost:4567'],
      allowedActionClasses: ['navigate', 'input', 'submit'],
      budget: {
        maxActions: 10,
        maxSubmits: 5,
        maxNewAccounts: 1,
        maxUploads: 1,
        maxDurationMs: 8 * 60 * 60 * 1000,
      },
    });
    const lease = runtime.claimLease({
      campaignId: campaign.id,
      instanceId: 'instance-1',
      provider: 'claude',
    });
    expect(lease.granted).toBe(true);

    await service.createAgentCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      username: 'james@communitytech.co.uk',
    });

    expect(campaigns.getCounters(campaign.id)).toMatchObject({
      newAccounts: 1,
    });
  });

  it('createAgentCredential denies without a register authorization', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'purpose_not_authorized' as const })),
    };
    const { service } = makeService({ credentialVault: vault, credentialAuthorizations: authorizations });

    const result = await service.createAgentCredential({
      profileId: 'profile-1',
      targetId: 'target-1',
      instanceId: 'instance-1',
      provider: 'claude',
      username: 'x@y.z',
    });

    expect(result).toMatchObject({ decision: 'denied' });
    expect(vault.createAgentCredential).not.toHaveBeenCalled();
  });

  it('fillCredential denies a shared existing tab when the opt-in flag is off (managed profiles only)', async () => {
    const vault = {
      getSecretForFill: vi.fn(async () => 'secret'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      // allowSharedTabCredentialFill omitted → default OFF (today's behaviour).
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'fill_credential_managed_profile_only',
    });
    // Denied before anything ran: no origin resolution, no authorization, no fill.
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
    expect(authorizations.check).not.toHaveBeenCalled();
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalled();
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('fillCredential fills a shared existing tab under the opt-in flag + a node-scoped authorization, without leaking the secret', async () => {
    const SECRET = 'Sh4red-Tab-S3cret!';
    const vault = {
      getSecretForFill: vi.fn(async () => SECRET),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    const { service, driver, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill: () => true,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [
        { selector: '#user', kind: 'username' },
        { selector: '#pass', kind: 'password' },
      ],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 2 } });
    // Authorized by the STABLE node scope ('local'), not the ephemeral tab
    // profileId, and against the LIVE origin resolved from a fresh snapshot.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'local', origin: 'https://portal.example.gov.uk', purpose: 'login' }),
    );
    // The secret was typed into the page over the extension channel (a shared
    // tab has no puppeteer page)...
    expect(extensionCommandStore.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'type',
        payload: expect.objectContaining({
          selector: '#pass',
          value: SECRET,
          credentialOrigin: 'https://portal.example.gov.uk',
          credentialProtection: 'password',
        }),
      }),
    );
    expect(extensionCommandStore.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'type',
        payload: expect.objectContaining({
          selector: '#user',
          credentialProtection: 'public',
        }),
      }),
    );
    expect(driver.type).not.toHaveBeenCalled();
    // ...but never leaks into the model-visible result or the audit log.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it('accepts the fixed taint sentinel for a public username written after a password', async () => {
    const vault = {
      getSecretForFill: vi.fn(async ({ kind }: { kind: string }) =>
        kind === 'username' ? 'test-only-user' : 'TEST_ONLY_PASSWORD_PLACEHOLDER'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const extensionCommandStore = {
      sendCommand: vi.fn(async (request: { command: string }) =>
        request.command === 'snapshot'
          ? { tab: { tabId: 42, windowId: 7, url: 'https://portal.example.gov.uk/login' } }
          : {
              completed: true,
              observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
            }),
    };
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: {
        check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })),
      },
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill: () => true,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [
        { selector: '#pass', kind: 'password' },
        { selector: '#user', kind: 'username' },
      ],
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { filled: 2 },
    });
    expect(extensionCommandStore.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'type',
        payload: expect.objectContaining({
          selector: '#user',
          credentialProtection: 'public',
        }),
      }),
    );
  });

  it('rejects an old shared-tab extension before resolving or dispatching a vault secret', async () => {
    const SECRET = 'TEST_ONLY_MUST_NOT_BE_RESOLVED';
    const vault = {
      getSecretForFill: vi.fn(async () => SECRET),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    const contactState = extensionContactState('0.2.2');
    const existingTab = {
      ...sharedPortalTab(),
      profileId: 'existing-tab:n.windows-pc:7:42',
      targetId: 'existing-tab:n.windows-pc:7:42:target',
      nodeId: 'windows-pc',
      nodeName: 'Windows PC',
    };
    const { service, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: contactState,
      allowSharedTabCredentialFill: () => true,
      existingTab,
    });

    const result = await service.fillCredential({
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'shared_tab_secure_credential_fill_unavailable',
    });
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
    expect(authorizations.check).not.toHaveBeenCalled();
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalled();
    expect(contactState.getExtensionRuntime).toHaveBeenCalledWith('windows-pc');
    expect(JSON.stringify({ result, audits })).not.toContain(SECRET);
  });

  it('rejects newer downgrade evidence even after an older secure result is replayed', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn() };
    const extensionCommandStore = portalExtensionCommandStore();
    const contactState = new BrowserExtensionContactState({ now: () => 3_000 });
    contactState.markExtensionContact('windows-pc', 3_000);
    contactState.markExtensionRuntime('windows-pc', {
      extensionVersion: '0.2.2',
      extensionStartedAt: 2_000,
    });
    contactState.markExtensionRuntime('windows-pc', {
      extensionVersion: '0.2.18',
      extensionStartedAt: 1_000,
    });
    const existingTab = {
      ...sharedPortalTab(),
      profileId: 'existing-tab:n.windows-pc:7:42',
      targetId: 'existing-tab:n.windows-pc:7:42:target',
      nodeId: 'windows-pc',
      nodeName: 'Windows PC',
    };
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: contactState,
      allowSharedTabCredentialFill: () => true,
      existingTab,
    });

    const result = await service.fillCredential({
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(contactState.getExtensionRuntime('windows-pc')).toEqual({
      extensionVersion: '0.2.2',
      extensionStartedAt: 2_000,
    });
    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'shared_tab_secure_credential_fill_unavailable',
    });
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
    expect(authorizations.check).not.toHaveBeenCalled();
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalled();
  });

  it('fills through a compatible remote extension using exact worker capability evidence', async () => {
    const SECRET = 'TEST_ONLY_COMPATIBLE_REMOTE_SECRET';
    const vault = {
      getSecretForFill: vi.fn(async () => SECRET),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    const contactState = extensionContactState('0.2.18');
    const existingTab = {
      ...sharedPortalTab(),
      profileId: 'existing-tab:n.windows-pc:7:42',
      targetId: 'existing-tab:n.windows-pc:7:42:target',
      nodeId: 'windows-pc',
      nodeName: 'Windows PC',
    };
    const { service, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: contactState,
      allowSharedTabCredentialFill: () => true,
      existingTab,
    });

    const result = await service.fillCredential({
      profileId: existingTab.profileId,
      targetId: existingTab.targetId,
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { filled: 1 },
    });
    expect(vault.getSecretForFill).toHaveBeenCalledTimes(1);
    expect(contactState.getExtensionRuntime).toHaveBeenCalledWith('windows-pc');
    expect(JSON.stringify({ result, audits })).not.toContain(SECRET);
  });

  it('rejects a legacy page-derived valueApplied response for a sensitive shared-tab write', async () => {
    const SECRET = 'TEST_ONLY_LEGACY_RESPONSE_SECRET';
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(async () => SECRET),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = {
      sendCommand: vi.fn(async (req: { command: string }) =>
        req.command === 'snapshot'
          ? { tab: { tabId: 42, windowId: 7, url: 'https://portal.example.gov.uk/login' } }
          : {
              valueApplied: true,
              valueAfter: SECRET,
              tagName: 'INPUT',
            }),
    };
    const { service, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill: () => true,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillSecret({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'codex',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#iban', secretType: 'iban' }],
    });

    expect(result).toMatchObject({
      decision: 'denied',
      outcome: 'failed',
      reason: 'secret_fill_failed',
      data: null,
    });
    expect(JSON.stringify({ result, audits })).not.toContain(SECRET);
  });

  it('accepts only the fixed tainted completion shape as shared-tab secret verification', async () => {
    const SECRET = 'TEST_ONLY_SHARED_TAB_BANK_VALUE';
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(async () => SECRET),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = {
      sendCommand: vi.fn(async (req: { command: string }) =>
        req.command === 'snapshot'
          ? { tab: { tabId: 42, windowId: 7, url: 'https://portal.example.gov.uk/login' } }
          : {
              completed: true,
              observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin',
            }),
    };
    const { service, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill: () => true,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillSecret({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#iban', secretType: 'iban' }],
    });

    expect(result).toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      data: { filled: 1, verified: 1 },
    });
    expect(extensionCommandStore.sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'type',
        payload: expect.objectContaining({
          value: SECRET,
          credentialOrigin: 'https://portal.example.gov.uk',
          credentialProtection: 'secret',
        }),
      }),
    );
    expect(JSON.stringify({ result, audits })).not.toContain(SECRET);
  });

  it('fillCredential aborts without typing when the shared tab navigates to a different origin between authorization and fill', async () => {
    const SECRET = 'Should-Never-Be-Typed!';
    const vault = {
      getSecretForFill: vi.fn(async () => SECRET),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    // Snapshot returns the authorized portal origin for the initial resolution, then a
    // DIFFERENT origin on the pre-type re-check — i.e. the human navigated their real tab.
    let snapshotCalls = 0;
    const extensionCommandStore = {
      sendCommand: vi.fn(async (req: { command: string }) => {
        if (req.command === 'snapshot') {
          snapshotCalls += 1;
          const url =
            snapshotCalls === 1
              ? 'https://portal.example.gov.uk/login'
              : 'https://evil.example.com/steal';
          return { tab: { tabId: 42, windowId: 7, url } };
        }
        return {};
      }),
    };
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill: () => true,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(result.reason).toBe('origin_changed_during_fill');
    // Authorized against the original origin, but the secret was NEVER typed into the page.
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'https://portal.example.gov.uk' }),
    );
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'type' }),
    );
    expect(driver.type).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('fillCredential keys the opt-in by the shared tab node scope, not the ephemeral tab profileId', async () => {
    const SECRET = 'Node-Scoped-S3cret!';
    const vault = {
      getSecretForFill: vi.fn(async () => SECRET),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    // A per-node opt-in reader: only unlocks the 'local' scope. It must receive
    // the resolved node scope ('local'), NOT the ephemeral 'existing-tab:7:42'.
    const allowSharedTabCredentialFill = vi.fn((profileId: string) => profileId === 'local');
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 1 } });
    expect(allowSharedTabCredentialFill).toHaveBeenCalledWith('local');
    expect(allowSharedTabCredentialFill).not.toHaveBeenCalledWith('existing-tab:7:42');
  });

  it('fillCredential denies a shared existing tab when the flag is on but no standing authorization covers it', async () => {
    const vault = {
      getSecretForFill: vi.fn(async () => 'secret'),
      createAgentCredential: vi.fn(),
      getGenericSecretForFill: vi.fn(),
    };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'origin_not_authorized' as const })),
    };
    const extensionCommandStore = portalExtensionCommandStore();
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
      extensionContactState: extensionContactState('0.2.18'),
      allowSharedTabCredentialFill: () => true,
      existingTab: sharedPortalTab(),
    });

    const result = await service.fillCredential({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      vaultItemRef: 'item-1',
      fields: [{ selector: '#pass', kind: 'password' }],
    });

    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(result.reason).toContain('credential_not_authorized');
    expect(authorizations.check).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'local', origin: 'https://portal.example.gov.uk' }),
    );
    // The origin was resolved (snapshot) but no secret was ever resolved or typed.
    expect(vault.getSecretForFill).not.toHaveBeenCalled();
    expect(extensionCommandStore.sendCommand).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: 'type' }),
    );
    expect(driver.type).not.toHaveBeenCalled();
  });

  it('executeFillPlan gets past the shared-tab gate when the opt-in flag is on', async () => {
    const extensionCommandStore = portalExtensionCommandStore();
    const { service } = makeService({
      allowSharedTabCredentialFill: () => true,
      extensionCommandStore,
      existingTab: sharedPortalTab(),
    });

    const result = await service.executeFillPlan({
      profileId: 'existing-tab:7:42',
      targetId: 'existing-tab:7:42:target',
      instanceId: 'instance-1',
      provider: 'claude',
      steps: [{ field: 'x', kind: 'set', target: '#x', value: 'y' }],
    });

    // The managed-only deny no longer fires; the plan proceeds to the per-step
    // action guard (which, absent a grant, parks the step rather than denying
    // for managed-profile-only).
    expect(result.reason).not.toBe('execute_fill_plan_managed_profile_only');
  });
});
