import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayService } from './browser-gateway-service';
import { BrowserCampaignService } from './browser-campaign-store';
import {
  initializeBrowserCampaignRuntime,
  stopBrowserCampaignRuntime,
} from './browser-campaign-runtime';
import { makeGrant, makeProfile, makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';

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
    sendCommand: vi.fn(async (req: { command: string }) =>
      req.command === 'snapshot'
        ? { tab: { tabId: 42, windowId: 7, url: 'https://portal.example.gov.uk/login' } }
        : {},
    ),
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
    driver.readControl.mockImplementation(async (_p: string, _t: string, target: string) =>
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
    driver.readControl.mockResolvedValue({ value: '' });

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
    const vault = { getSecretForFill: vi.fn(async () => 'S3cr3t-From-Vault!') };
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
    const vault = { getSecretForFill: vi.fn(async () => 'secret') };
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
    const vault = { getSecretForFill: vi.fn(async () => 'vault-secret') };
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

  it('fillCredential rejects email_code sender domains unrelated to the live origin', async () => {
    const vault = { getSecretForFill: vi.fn() };
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
    const vault = { getSecretForFill: vi.fn() };
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
    const vault = { getSecretForFill: vi.fn() };
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

  it('createAgentCredential registers a vaulted account and returns only a ref + username', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({ vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' })),
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

  it('createAgentCredential records a new-account budget hit under a campaign lease', async () => {
    const vault = {
      getSecretForFill: vi.fn(),
      createAgentCredential: vi.fn(async () => ({ vaultItemRef: 'item-9', username: 'james@communitytech.co.uk' })),
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
    const vault = { getSecretForFill: vi.fn(async () => 'secret') };
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
    const vault = { getSecretForFill: vi.fn(async () => SECRET) };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    const { service, driver, audits } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
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
        payload: expect.objectContaining({ selector: '#pass', value: SECRET }),
      }),
    );
    expect(driver.type).not.toHaveBeenCalled();
    // ...but never leaks into the model-visible result or the audit log.
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  it('fillCredential keys the opt-in by the shared tab node scope, not the ephemeral tab profileId', async () => {
    const SECRET = 'Node-Scoped-S3cret!';
    const vault = { getSecretForFill: vi.fn(async () => SECRET) };
    const authorizations = { check: vi.fn(() => ({ authorized: true, authorizationId: 'auth-1' })) };
    const extensionCommandStore = portalExtensionCommandStore();
    // A per-node opt-in reader: only unlocks the 'local' scope. It must receive
    // the resolved node scope ('local'), NOT the ephemeral 'existing-tab:7:42'.
    const allowSharedTabCredentialFill = vi.fn((profileId: string) => profileId === 'local');
    const { service } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
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
    const vault = { getSecretForFill: vi.fn(async () => 'secret') };
    const authorizations = {
      check: vi.fn(() => ({ authorized: false as const, reason: 'origin_not_authorized' as const })),
    };
    const extensionCommandStore = portalExtensionCommandStore();
    const { service, driver } = makeService({
      credentialVault: vault,
      credentialAuthorizations: authorizations,
      extensionCommandStore,
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
