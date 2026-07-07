import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserUnattendedStore } from './browser-unattended.store';
import { BrowserUnattendedIpcService } from '../../core/services/ipc/browser-unattended-ipc.service';
import type {
  BrowserCampaign,
  BrowserCampaignListItem,
  BrowserEscalation,
  BrowserVaultStatus,
  CredentialAuthorization,
} from './browser-unattended.types';

describe('BrowserUnattendedStore', () => {
  let store: BrowserUnattendedStore;
  let ipc: {
    vaultUnlock: ReturnType<typeof vi.fn>;
    vaultLock: ReturnType<typeof vi.fn>;
    vaultStatus: ReturnType<typeof vi.fn>;
    createCredentialAuthorization: ReturnType<typeof vi.fn>;
    listCredentialAuthorizations: ReturnType<typeof vi.fn>;
    revokeCredentialAuthorization: ReturnType<typeof vi.fn>;
    createCampaign: ReturnType<typeof vi.fn>;
    listCampaigns: ReturnType<typeof vi.fn>;
    getCampaign: ReturnType<typeof vi.fn>;
    pauseCampaign: ReturnType<typeof vi.fn>;
    resumeCampaign: ReturnType<typeof vi.fn>;
    killCampaign: ReturnType<typeof vi.fn>;
    approveCampaignDeclaration: ReturnType<typeof vi.fn>;
    listEscalations: ReturnType<typeof vi.fn>;
    resolveEscalation: ReturnType<typeof vi.fn>;
    skipEscalation: ReturnType<typeof vi.fn>;
  };

  const vaultStatusLocked: BrowserVaultStatus = { locked: true, passwordSourceConfigured: true };
  const vaultStatusUnlocked: BrowserVaultStatus = { locked: false, passwordSourceConfigured: true };

  const authorization: CredentialAuthorization = {
    id: 'auth-1',
    profileId: 'profile-1',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }],
    purposes: ['login'],
    vaultFolder: 'AIO-Agent',
    createdAt: 1,
    expiresAt: 2,
  };

  const campaign: BrowserCampaign = {
    id: 'campaign-1',
    label: 'Overnight run',
    profileId: 'profile-1',
    allowedOrigins: ['example.com'],
    allowedActionClasses: ['read', 'navigate'],
    budget: { maxActions: 100, maxSubmits: 10, maxNewAccounts: 0, maxUploads: 0, maxDurationMs: 3_600_000 },
    approvedDeclarationHashes: [],
    status: 'active',
    createdAt: 1,
    expiresAt: 2,
    approvedBy: 'user',
  };

  const campaignListItem: BrowserCampaignListItem = {
    campaign,
    counters: { actions: 1, submits: 0, newAccounts: 0, uploads: 0 },
  };

  const escalation: BrowserEscalation = {
    id: 'escalation-1',
    profileId: 'profile-1',
    kind: 'captcha',
    reason: 'Captcha challenge encountered',
    status: 'pending',
    createdAt: 1,
  };

  beforeEach(() => {
    ipc = {
      vaultUnlock: vi.fn().mockResolvedValue({ success: true, data: { unlocked: true } }),
      vaultLock: vi.fn().mockResolvedValue({ success: true, data: vaultStatusLocked }),
      vaultStatus: vi.fn().mockResolvedValue({ success: true, data: vaultStatusLocked }),
      createCredentialAuthorization: vi.fn().mockResolvedValue({ success: true, data: authorization }),
      listCredentialAuthorizations: vi.fn().mockResolvedValue({ success: true, data: [authorization] }),
      revokeCredentialAuthorization: vi.fn().mockResolvedValue({ success: true, data: { revoked: true } }),
      createCampaign: vi.fn().mockResolvedValue({ success: true, data: campaign }),
      listCampaigns: vi.fn().mockResolvedValue({ success: true, data: [campaignListItem] }),
      getCampaign: vi.fn().mockResolvedValue({
        success: true,
        data: { campaign, counters: campaignListItem.counters, pendingEscalations: 1 },
      }),
      pauseCampaign: vi.fn().mockResolvedValue({ success: true, data: { ...campaign, status: 'paused' } }),
      resumeCampaign: vi.fn().mockResolvedValue({ success: true, data: { ...campaign, status: 'active' } }),
      killCampaign: vi.fn().mockResolvedValue({ success: true, data: { ...campaign, status: 'killed' } }),
      approveCampaignDeclaration: vi.fn().mockResolvedValue({ success: true, data: { approved: true } }),
      listEscalations: vi.fn().mockResolvedValue({ success: true, data: [escalation] }),
      resolveEscalation: vi.fn().mockResolvedValue({ success: true, data: { ...escalation, status: 'resolved' } }),
      skipEscalation: vi.fn().mockResolvedValue({ success: true, data: { ...escalation, status: 'skipped' } }),
    };

    TestBed.configureTestingModule({
      providers: [{ provide: BrowserUnattendedIpcService, useValue: ipc }],
    });
    store = TestBed.inject(BrowserUnattendedStore);
  });

  it('loads vault status, authorizations, campaigns, and escalations on refreshAll', async () => {
    await store.refreshAll();

    expect(store.vaultStatus()).toEqual(vaultStatusLocked);
    expect(store.authorizations()).toEqual([authorization]);
    expect(store.campaigns()).toEqual([campaignListItem]);
    expect(store.pendingEscalations()).toEqual([escalation]);
  });

  it('maps a failed unlock reason and refreshes vault status', async () => {
    ipc.vaultUnlock.mockResolvedValueOnce({
      success: true,
      data: { unlocked: false, reason: 'empty_password' },
    });

    const unlocked = await store.unlockVault();

    expect(unlocked).toBe(false);
    expect(store.vaultUnlockReason()).toBe('empty_password');
    expect(ipc.vaultStatus).toHaveBeenCalled();
  });

  it('clears the unlock reason on a successful unlock', async () => {
    ipc.vaultUnlock.mockResolvedValueOnce({
      success: true,
      data: { unlocked: false, reason: 'empty_password' },
    });
    await store.unlockVault();
    expect(store.vaultUnlockReason()).toBe('empty_password');

    ipc.vaultUnlock.mockResolvedValueOnce({ success: true, data: { unlocked: true } });
    ipc.vaultStatus.mockResolvedValueOnce({ success: true, data: vaultStatusUnlocked });
    const unlocked = await store.unlockVault();

    expect(unlocked).toBe(true);
    expect(store.vaultUnlockReason()).toBe(null);
  });

  it('surfaces an IPC failure message in errorMessage', async () => {
    ipc.vaultStatus.mockResolvedValueOnce({
      success: false,
      error: { message: 'boom' },
    });

    await store.refreshVaultStatus();

    expect(store.errorMessage()).toBe('boom');
  });

  it('creates a credential authorization with the given payload and refreshes the list', async () => {
    const created = await store.createAuthorization({
      profileId: 'profile-1',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }],
      purposes: ['login'],
      vaultFolder: 'AIO-Agent',
      expiresAt: Date.now() + 1_000,
    });

    expect(created).toBe(true);
    expect(ipc.createCredentialAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: 'profile-1', vaultFolder: 'AIO-Agent' }),
    );
    expect(ipc.listCredentialAuthorizations).toHaveBeenCalled();
  });

  it('revokes a credential authorization', async () => {
    await store.revokeAuthorization('auth-1');
    expect(ipc.revokeCredentialAuthorization).toHaveBeenCalledWith({ authorizationId: 'auth-1' });
  });

  it('creates a campaign and refreshes the campaign list', async () => {
    const created = await store.createCampaign({
      label: 'Overnight run',
      profileId: 'profile-1',
      allowedOrigins: ['example.com'],
      allowedActionClasses: ['read'],
      budget: { maxActions: 10, maxSubmits: 1, maxNewAccounts: 0, maxUploads: 0, maxDurationMs: 60_000 },
    });

    expect(created).toBe(true);
    expect(ipc.createCampaign).toHaveBeenCalled();
    expect(ipc.listCampaigns).toHaveBeenCalled();
  });

  it('pauses, resumes, and kills a campaign', async () => {
    await store.pauseCampaign('campaign-1');
    expect(ipc.pauseCampaign).toHaveBeenCalledWith({ campaignId: 'campaign-1' });

    await store.resumeCampaign('campaign-1');
    expect(ipc.resumeCampaign).toHaveBeenCalledWith({ campaignId: 'campaign-1' });

    await store.killCampaign('campaign-1');
    expect(ipc.killCampaign).toHaveBeenCalledWith({ campaignId: 'campaign-1' });
  });

  it('loads campaign detail and approves a declaration hash', async () => {
    await store.loadCampaignDetail('campaign-1');
    expect(store.campaignDetails()['campaign-1']?.pendingEscalations).toBe(1);

    const hash = 'a'.repeat(64);
    const approved = await store.approveDeclaration('campaign-1', hash);
    expect(approved).toBe(true);
    expect(ipc.approveCampaignDeclaration).toHaveBeenCalledWith({
      campaignId: 'campaign-1',
      declarationHash: hash,
    });
  });

  it('resolves an escalation with a note and removes it from the pending list', async () => {
    await store.refreshEscalations();
    expect(store.pendingEscalations()).toEqual([escalation]);

    const resolved = await store.resolveEscalation('escalation-1', 'Solved manually');
    expect(resolved).toBe(true);
    expect(ipc.resolveEscalation).toHaveBeenCalledWith({
      escalationId: 'escalation-1',
      note: 'Solved manually',
    });
    expect(store.pendingEscalations()).toEqual([]);
  });

  it('skips an escalation with a note and removes it from the pending list', async () => {
    await store.refreshEscalations();

    const skipped = await store.skipEscalation('escalation-1', 'Not worth pursuing');
    expect(skipped).toBe(true);
    expect(ipc.skipEscalation).toHaveBeenCalledWith({
      escalationId: 'escalation-1',
      note: 'Not worth pursuing',
    });
    expect(store.pendingEscalations()).toEqual([]);
  });
});
