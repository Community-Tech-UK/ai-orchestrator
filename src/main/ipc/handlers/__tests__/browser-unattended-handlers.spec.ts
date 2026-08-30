import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../validated-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const serviceMocks = vi.hoisted(() => {
  const authorizationService = {
    create: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    find: vi.fn(),
  };
  const campaignService = {
    create: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    getCounters: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(),
    approveDeclarationHash: vi.fn(),
  };
  const escalationService = {
    list: vi.fn(),
    resolve: vi.fn(),
    skip: vi.fn(),
    pending: vi.fn(),
  };
  const credentialVault = {
    enrolExistingCredential: vi.fn(),
  };
  // Added 2026-08-29: the handler now resolves the authorization scope against
  // the real roster and profile store, so a grant on a scope the fill could
  // never look up is refused at the point of creation on BOTH doors.
  const remoteNodeRoster = {
    list: vi.fn(() => [{ id: 'bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be', name: 'windows-pc' }]),
  };
  const profileStore = {
    listProfiles: vi.fn(() => [{ id: 'profile-1' }]),
  };
  return {
    authorizationService,
    campaignService,
    escalationService,
    credentialVault,
    remoteNodeRoster,
    profileStore,
    unlockBrowserCredentialVault: vi.fn(),
    lockBrowserCredentialVault: vi.fn(),
    getBrowserVaultStatus: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../remote-node/remote-node-roster-service', () => ({
  getRemoteNodeRosterService: () => serviceMocks.remoteNodeRoster,
}));

vi.mock('../../../browser-gateway/browser-profile-store', () => ({
  getBrowserProfileStore: () => serviceMocks.profileStore,
}));

vi.mock('../../../browser-gateway/browser-unattended-services', () => ({
  getBrowserCredentialVault: () => serviceMocks.credentialVault,
  getBrowserCredentialAuthorizationService: () => serviceMocks.authorizationService,
  getBrowserCampaignService: () => serviceMocks.campaignService,
  getBrowserEscalationService: () => serviceMocks.escalationService,
  unlockBrowserCredentialVault: serviceMocks.unlockBrowserCredentialVault,
  lockBrowserCredentialVault: serviceMocks.lockBrowserCredentialVault,
  getBrowserVaultStatus: serviceMocks.getBrowserVaultStatus,
}));

import { registerBrowserUnattendedHandlers } from '../browser-unattended-handlers';

const fakeEvent = {};

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(fakeEvent, payload);
}

const AUTH_PAYLOAD = {
  profileId: 'profile-1',
  allowedOrigins: [
    { scheme: 'https' as const, hostPattern: 'in-tendhost.co.uk', includeSubdomains: true },
  ],
  purposes: ['login' as const, 'register' as const],
  vaultFolder: 'AIO-Agent',
  expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
};

const CAMPAIGN_PAYLOAD = {
  label: 'Overnight tender registrations',
  profileId: 'profile-1',
  allowedOrigins: ['https://in-tendhost.co.uk'],
  allowedActionClasses: ['input', 'submit'],
  budget: {
    maxActions: 500,
    maxSubmits: 20,
    maxNewAccounts: 2,
    maxUploads: 10,
    maxDurationMs: 8 * 60 * 60 * 1000,
  },
};

describe('registerBrowserUnattendedHandlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    vi.clearAllMocks();
    registerBrowserUnattendedHandlers();
  });

  describe('vault', () => {
    it('returns the unlock result without any token on success', async () => {
      serviceMocks.unlockBrowserCredentialVault.mockResolvedValue({ unlocked: true });

      const result = await invoke('browser:vault-unlock', {});

      expect(result).toMatchObject({ success: true, data: { unlocked: true } });
      expect(JSON.stringify(result)).not.toContain('token');
    });

    it('returns the failure reason when unlock fails', async () => {
      serviceMocks.unlockBrowserCredentialVault.mockResolvedValue({
        unlocked: false,
        reason: 'bw_unlock_failed',
      });

      const result = await invoke('browser:vault-unlock', {});

      expect(result).toMatchObject({
        success: true,
        data: { unlocked: false, reason: 'bw_unlock_failed' },
      });
    });

    it('locks the vault and reports status', async () => {
      serviceMocks.getBrowserVaultStatus.mockReturnValue({
        locked: true,
        passwordSourceConfigured: true,
      });

      const result = await invoke('browser:vault-lock', {});

      expect(serviceMocks.lockBrowserCredentialVault).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: true, data: { locked: true } });
    });

    it('reports vault status', async () => {
      serviceMocks.getBrowserVaultStatus.mockReturnValue({
        locked: false,
        passwordSourceConfigured: true,
      });

      const result = await invoke('browser:vault-status', {});

      expect(result).toMatchObject({
        success: true,
        data: { locked: false, passwordSourceConfigured: true },
      });
    });

    it('rejects unexpected unlock payload fields', async () => {
      const result = await invoke('browser:vault-unlock', { masterPassword: 'nope' });

      expect(result.success).toBe(false);
      expect(serviceMocks.unlockBrowserCredentialVault).not.toHaveBeenCalled();
    });
  });

  // The enrol channel is the newest and most sensitive surface in this file:
  // it binds a hand-registered login to an origin. A 2026-08-19 completion gate
  // found it had no coverage anywhere in the repo, and that this spec's own
  // service mock omitted `getBrowserCredentialVault`, so any test reaching it
  // would have thrown rather than failed meaningfully.
  describe('enrol existing credential', () => {
    const enrolPayload = {
      item: 'Report MI login',
      origin: 'https://auth.reportmi.gca.gov.uk',
    };

    it('maps the payload field-by-field onto the vault call', async () => {
      serviceMocks.credentialVault.enrolExistingCredential.mockResolvedValue({
        vaultItemRef: 'bw:item:abc',
        username: 'jl@example.invalid',
        movedIntoFolder: false,
      });

      await expect(invoke('browser:enrol-credential', enrolPayload)).resolves.toMatchObject({
        success: true,
        data: { vaultItemRef: 'bw:item:abc', username: 'jl@example.invalid' },
      });

      expect(serviceMocks.credentialVault.enrolExistingCredential).toHaveBeenCalledWith({
        item: 'Report MI login',
        origin: 'https://auth.reportmi.gca.gov.uk',
      });
    });

    it('omits moveIntoFolder entirely when the caller did not supply it', async () => {
      serviceMocks.credentialVault.enrolExistingCredential.mockResolvedValue({
        vaultItemRef: 'bw:item:abc',
        username: 'jl@example.invalid',
        movedIntoFolder: false,
      });

      await invoke('browser:enrol-credential', enrolPayload);

      const [arg] = serviceMocks.credentialVault.enrolExistingCredential.mock.calls[0] as [
        Record<string, unknown>,
      ];
      // Not `toBeUndefined()` — the conditional spread exists so the key is
      // absent, and an explicit `undefined` would still satisfy that.
      expect(Object.keys(arg)).not.toContain('moveIntoFolder');
    });

    it('forwards moveIntoFolder when the caller does supply it', async () => {
      serviceMocks.credentialVault.enrolExistingCredential.mockResolvedValue({
        vaultItemRef: 'bw:item:abc',
        username: 'jl@example.invalid',
        movedIntoFolder: true,
      });

      await invoke('browser:enrol-credential', { ...enrolPayload, moveIntoFolder: true });

      expect(serviceMocks.credentialVault.enrolExistingCredential).toHaveBeenCalledWith({
        item: 'Report MI login',
        origin: 'https://auth.reportmi.gca.gov.uk',
        moveIntoFolder: true,
      });
    });

    it('rejects a payload carrying a password without calling the vault', async () => {
      const result = await invoke('browser:enrol-credential', {
        ...enrolPayload,
        password: 'should-never-be-accepted',
      });

      expect(result.success).toBe(false);
      expect(serviceMocks.credentialVault.enrolExistingCredential).not.toHaveBeenCalled();
    });

    it('surfaces a vault failure as a failed response', async () => {
      serviceMocks.credentialVault.enrolExistingCredential.mockRejectedValue(
        new Error('bw_command_failed'),
      );

      const result = await invoke('browser:enrol-credential', enrolPayload);

      expect(result.success).toBe(false);
    });

    it('blocks untrusted senders before touching the credential vault', async () => {
      electronMocks.handlers.clear();
      registerBrowserUnattendedHandlers({
        ensureTrustedSender: () => ({
          success: false,
          error: { code: 'UNTRUSTED_SENDER', message: 'nope', timestamp: Date.now() },
        }),
      });

      const result = await invoke('browser:enrol-credential', enrolPayload);

      expect(result.success).toBe(false);
      expect(serviceMocks.credentialVault.enrolExistingCredential).not.toHaveBeenCalled();
    });
  });

  describe('credential authorizations', () => {
    it('creates an authorization with a generated id', async () => {
      serviceMocks.authorizationService.create.mockImplementation(
        (input: object, id: string) => ({ ...input, id, createdAt: 1 }),
      );

      const result = await invoke('browser:create-credential-authorization', AUTH_PAYLOAD);

      expect(result.success).toBe(true);
      expect(serviceMocks.authorizationService.create).toHaveBeenCalledTimes(1);
      const [input, id] = serviceMocks.authorizationService.create.mock.calls[0]!;
      expect(input).toMatchObject({ profileId: 'profile-1', vaultFolder: 'AIO-Agent' });
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    // `allowedSenderDomains` is the cross-domain OTP allowlist this plan added
    // (change D): it is what lets a one-time code from notifications.service.gov.uk
    // be accepted while filling a form on auth.reportmi.gca.gov.uk. A 2026-08-19
    // completion gate deleted the handler's conditional spread for it entirely and
    // the whole feature suite still passed 69/69 — so the mapping is asserted here.
    it('forwards allowedSenderDomains to the authorization service when supplied', async () => {
      serviceMocks.authorizationService.create.mockImplementation(
        (input: object, id: string) => ({ ...input, id, createdAt: 1 }),
      );

      await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        allowedSenderDomains: ['notifications.service.gov.uk'],
      });

      const [input] = serviceMocks.authorizationService.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(input['allowedSenderDomains']).toEqual(['notifications.service.gov.uk']);
    });

    it('refuses a scope the fill could never look up, on this door too', async () => {
      // F-F from the 2026-08-29 review: the comments claimed both doors enforce
      // the same rules while only the CLI door checked the scope, so the panel
      // could still mint an unmatchable grant.
      const result = await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        profileId: 'not-a-real-scope',
      });

      expect(result.success).toBe(false);
      expect(serviceMocks.authorizationService.create).not.toHaveBeenCalled();
    });

    it('normalises a host the panel accepts rather than rejecting it', async () => {
      // The panel host field applies no normalisation and the fill-time matcher
      // lowercases, so mixed case has always worked. Rejecting it would regress.
      serviceMocks.authorizationService.create.mockImplementation(
        (input: object, id: string) => ({ ...input, id, createdAt: 1 }),
      );

      await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'In-TendHost.CO.UK', includeSubdomains: true },
        ],
      });

      const [input] = serviceMocks.authorizationService.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(input['allowedOrigins']).toEqual([
        { scheme: 'https', hostPattern: 'in-tendhost.co.uk', includeSubdomains: true },
      ]);
    });

    it('omits allowedSenderDomains entirely when it is absent', async () => {
      serviceMocks.authorizationService.create.mockImplementation(
        (input: object, id: string) => ({ ...input, id, createdAt: 1 }),
      );

      await invoke('browser:create-credential-authorization', AUTH_PAYLOAD);

      const [input] = serviceMocks.authorizationService.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(Object.keys(input)).not.toContain('allowedSenderDomains');
    });

    // An empty array must not reach the store as an empty allowlist: the store
    // treats a present-but-empty list differently from an absent one, and
    // "absent" is the fail-closed state.
    it('omits allowedSenderDomains when supplied as an empty array', async () => {
      serviceMocks.authorizationService.create.mockImplementation(
        (input: object, id: string) => ({ ...input, id, createdAt: 1 }),
      );

      await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        allowedSenderDomains: [],
      });

      const [input] = serviceMocks.authorizationService.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(Object.keys(input)).not.toContain('allowedSenderDomains');
    });

    it('forwards note when supplied and omits it when absent', async () => {
      serviceMocks.authorizationService.create.mockImplementation(
        (input: object, id: string) => ({ ...input, id, createdAt: 1 }),
      );

      await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        note: 'Report MI overnight registration',
      });
      const [withNote] = serviceMocks.authorizationService.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(withNote['note']).toBe('Report MI overnight registration');

      serviceMocks.authorizationService.create.mockClear();
      await invoke('browser:create-credential-authorization', AUTH_PAYLOAD);
      const [withoutNote] = serviceMocks.authorizationService.create.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(Object.keys(withoutNote)).not.toContain('note');
    });

    it('rejects an authorization whose expiry is in the past', async () => {
      const result = await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        expiresAt: Date.now() - 1000,
      });

      expect(result.success).toBe(false);
      expect(serviceMocks.authorizationService.create).not.toHaveBeenCalled();
    });

    it('rejects an authorization more than a year out', async () => {
      const result = await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        expiresAt: Date.now() + 400 * 24 * 60 * 60 * 1000,
      });

      expect(result.success).toBe(false);
      expect(serviceMocks.authorizationService.create).not.toHaveBeenCalled();
    });

    it('validates the payload before creating', async () => {
      const result = await invoke('browser:create-credential-authorization', {
        ...AUTH_PAYLOAD,
        purposes: ['payment'],
      });

      expect(result.success).toBe(false);
      expect(serviceMocks.authorizationService.create).not.toHaveBeenCalled();
    });

    it('lists authorizations, optionally scoped to a profile', async () => {
      serviceMocks.authorizationService.list.mockReturnValue([]);

      await invoke('browser:list-credential-authorizations', { profileId: 'profile-1' });
      expect(serviceMocks.authorizationService.list).toHaveBeenCalledWith('profile-1');

      await invoke('browser:list-credential-authorizations');
      expect(serviceMocks.authorizationService.list).toHaveBeenLastCalledWith(undefined);
    });

    it('revokes an authorization', async () => {
      serviceMocks.authorizationService.find.mockReturnValue({ id: 'auth-1' });

      const result = await invoke('browser:revoke-credential-authorization', {
        authorizationId: 'auth-1',
      });

      expect(result).toMatchObject({ success: true, data: { revoked: true } });
      expect(serviceMocks.authorizationService.revoke).toHaveBeenCalledWith('auth-1');
    });

    it('reports false for an id that never existed, matching the CLI door', async () => {
      // markRevoked is a no-op UPDATE, so this door used to answer `revoked:
      // true` for a typo while the CLI door answered false.
      serviceMocks.authorizationService.find.mockReturnValue(undefined);

      const result = await invoke('browser:revoke-credential-authorization', {
        authorizationId: 'never-existed',
      });

      expect(result).toMatchObject({ success: true, data: { revoked: false } });
      expect(serviceMocks.authorizationService.revoke).not.toHaveBeenCalled();
    });

    it('stays idempotent on an already-revoked id', async () => {
      serviceMocks.authorizationService.find.mockReturnValue({ id: 'auth-1', revokedAt: 1 });

      const result = await invoke('browser:revoke-credential-authorization', {
        authorizationId: 'auth-1',
      });

      expect(result).toMatchObject({ success: true, data: { revoked: true } });
      expect(serviceMocks.authorizationService.revoke).not.toHaveBeenCalled();
    });
  });

  describe('campaigns', () => {
    it('creates a campaign', async () => {
      serviceMocks.campaignService.create.mockReturnValue({
        id: 'campaign-1',
        status: 'active',
      });

      const result = await invoke('browser:create-campaign', CAMPAIGN_PAYLOAD);

      expect(result).toMatchObject({ success: true, data: { id: 'campaign-1' } });
      expect(serviceMocks.campaignService.create).toHaveBeenCalledWith(CAMPAIGN_PAYLOAD);
    });

    it('surfaces campaign service rejections (e.g. blocked action class)', async () => {
      serviceMocks.campaignService.create.mockImplementation(() => {
        throw new Error("Action class 'credential' cannot be pre-approved");
      });

      const result = await invoke('browser:create-campaign', {
        ...CAMPAIGN_PAYLOAD,
        allowedActionClasses: ['credential'],
      });

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('credential');
    });

    it('lists campaigns with their counters', async () => {
      serviceMocks.campaignService.list.mockReturnValue([{ id: 'campaign-1' }]);
      serviceMocks.campaignService.getCounters.mockReturnValue({
        actions: 3,
        submits: 1,
        newAccounts: 0,
        uploads: 0,
      });

      const result = await invoke('browser:list-campaigns', { status: 'active' });

      expect(serviceMocks.campaignService.list).toHaveBeenCalledWith({ status: 'active' });
      expect(result.data).toEqual([
        {
          campaign: { id: 'campaign-1' },
          counters: { actions: 3, submits: 1, newAccounts: 0, uploads: 0 },
        },
      ]);
    });

    it('gets a campaign with counters and pending escalation count', async () => {
      serviceMocks.campaignService.get.mockReturnValue({ id: 'campaign-1' });
      serviceMocks.campaignService.getCounters.mockReturnValue({
        actions: 0,
        submits: 0,
        newAccounts: 0,
        uploads: 0,
      });
      serviceMocks.escalationService.pending.mockReturnValue(2);

      const result = await invoke('browser:get-campaign', { campaignId: 'campaign-1' });

      expect(result).toMatchObject({
        success: true,
        data: { campaign: { id: 'campaign-1' }, pendingEscalations: 2 },
      });
    });

    it('fails cleanly for an unknown campaign', async () => {
      serviceMocks.campaignService.get.mockReturnValue(undefined);

      const result = await invoke('browser:get-campaign', { campaignId: 'nope' });

      expect(result.success).toBe(false);
    });

    it('pauses, resumes, and kills campaigns', async () => {
      serviceMocks.campaignService.pause.mockReturnValue({ id: 'c', status: 'paused' });
      serviceMocks.campaignService.resume.mockReturnValue({ id: 'c', status: 'active' });
      serviceMocks.campaignService.kill.mockReturnValue({ id: 'c', status: 'killed' });

      await expect(invoke('browser:pause-campaign', { campaignId: 'c' })).resolves.toMatchObject({
        success: true,
        data: { status: 'paused' },
      });
      await expect(invoke('browser:resume-campaign', { campaignId: 'c' })).resolves.toMatchObject({
        success: true,
        data: { status: 'active' },
      });
      await expect(invoke('browser:kill-campaign', { campaignId: 'c' })).resolves.toMatchObject({
        success: true,
        data: { status: 'killed' },
      });
    });

    it('approves a declaration hash (lowercased)', async () => {
      const hash = 'A'.repeat(64);

      const result = await invoke('browser:approve-campaign-declaration', {
        campaignId: 'c',
        declarationHash: hash,
      });

      expect(result).toMatchObject({ success: true, data: { approved: true } });
      expect(serviceMocks.campaignService.approveDeclarationHash).toHaveBeenCalledWith(
        'c',
        'a'.repeat(64),
      );
    });

    it('rejects a malformed declaration hash', async () => {
      const result = await invoke('browser:approve-campaign-declaration', {
        campaignId: 'c',
        declarationHash: 'not-a-hash',
      });

      expect(result.success).toBe(false);
      expect(serviceMocks.campaignService.approveDeclarationHash).not.toHaveBeenCalled();
    });
  });

  describe('escalations', () => {
    it('lists escalations with filters', async () => {
      serviceMocks.escalationService.list.mockReturnValue([]);

      await invoke('browser:list-escalations', { status: 'pending' });

      expect(serviceMocks.escalationService.list).toHaveBeenCalledWith({ status: 'pending' });
    });

    it('resolves and skips escalations with an optional note', async () => {
      serviceMocks.escalationService.resolve.mockReturnValue({ id: 'esc-1', status: 'resolved' });
      serviceMocks.escalationService.skip.mockReturnValue({ id: 'esc-2', status: 'skipped' });

      await expect(
        invoke('browser:resolve-escalation', { escalationId: 'esc-1', note: 'done by hand' }),
      ).resolves.toMatchObject({ success: true, data: { status: 'resolved' } });
      await expect(
        invoke('browser:skip-escalation', { escalationId: 'esc-2' }),
      ).resolves.toMatchObject({ success: true, data: { status: 'skipped' } });

      expect(serviceMocks.escalationService.resolve).toHaveBeenCalledWith('esc-1', 'done by hand');
      expect(serviceMocks.escalationService.skip).toHaveBeenCalledWith('esc-2', undefined);
    });
  });

  it('blocks untrusted senders before touching any service', async () => {
    electronMocks.handlers.clear();
    registerBrowserUnattendedHandlers({
      ensureTrustedSender: () => ({
        success: false,
        error: { code: 'UNTRUSTED_SENDER', message: 'nope', timestamp: Date.now() },
      }),
    });

    const result = await invoke('browser:vault-unlock', {});

    expect(result.success).toBe(false);
    expect(serviceMocks.unlockBrowserCredentialVault).not.toHaveBeenCalled();
  });
});
