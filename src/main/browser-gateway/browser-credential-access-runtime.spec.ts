import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(), getTab: vi.fn(), getProfile: vi.fn(), listTargets: vi.fn(),
  settings: vi.fn(), getNode: vi.fn(), fresh: vi.fn(), runtime: vi.fn(),
  approvalStore: {}, authorizations: {}, vault: {}, grants: {},
}));
vi.mock('./browser-gateway-service', () => ({ getBrowserGatewayService: () => ({ snapshot: mocks.snapshot }) }));
vi.mock('./browser-extension-tab-store', () => ({ getBrowserExtensionTabStore: () => ({ getTab: mocks.getTab }) }));
vi.mock('./browser-target-registry', () => ({ getBrowserTargetRegistry: () => ({ listTargets: mocks.listTargets }) }));
vi.mock('./browser-profile-store', () => ({ getBrowserProfileStore: () => ({ getProfile: mocks.getProfile }) }));
vi.mock('./browser-extension-contact-state', async (importOriginal) => ({
  ...await importOriginal<typeof import('./browser-extension-contact-state')>(),
  getBrowserExtensionContactState: () => ({ isExtensionContactFresh: mocks.fresh, getExtensionRuntime: mocks.runtime }),
}));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: mocks.settings }) }));
vi.mock('../remote-node/remote-node-roster-service', () => ({ getRemoteNodeRosterService: () => ({ get: mocks.getNode }) }));
vi.mock('./browser-approval-store', () => ({ getBrowserApprovalStore: () => mocks.approvalStore }));
vi.mock('./browser-grant-store', () => ({ getBrowserGrantStore: () => mocks.grants }));
vi.mock('./browser-unattended-services', () => ({
  getBrowserCredentialAuthorizationService: () => mocks.authorizations, getBrowserCredentialVault: () => mocks.vault,
}));
vi.mock('./browser-audit-store', () => ({ getBrowserAuditStore: () => ({ record: () => ({ id: 'audit' }) }) }));

import { createCredentialAccessDependencies, resolveCredentialComputerId } from './browser-credential-access-runtime';

const profileId = 'existing-tab:n.node-1:1:2';
const targetId = `${profileId}:target`;
const attachment = { profileId, targetId, nodeId: 'node-1', nodeName: 'windows-pc', origin: 'https://test.example', url: 'https://test.example/login' };
const target = { id: targetId, profileId, nodeId: 'node-1', status: 'selected' };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getTab.mockReturnValue({ ...attachment });
  mocks.listTargets.mockReturnValue([{ ...target }]);
  mocks.settings.mockReturnValue({ browserAllowSharedTabCredentialFill: true });
  mocks.getNode.mockReturnValue({ id: 'node-1', name: 'windows-pc', connected: true, status: 'connected' });
  mocks.fresh.mockReturnValue(true);
  mocks.runtime.mockReturnValue({ extensionVersion: '0.2.18', extensionStartedAt: 10 });
  mocks.snapshot.mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', data: { url: 'https://test.example/login', text: 'Page text must not be returned' } });
});

describe('credential request live runtime checks', () => {
  it('requires a fresh snapshot and returns only exact origin, computer, and permission scope', async () => {
    const deps = createCredentialAccessDependencies();
    expect(deps.store).toBe(mocks.approvalStore);
    expect(deps.vault).toBe(mocks.vault);
    expect(deps.authorizations).toBe(mocks.authorizations);
    expect(deps.grants).toBe(mocks.grants);
    expect(await deps.readTarget(profileId, targetId, { instanceId: 'requesting-session', provider: 'codex' }))
      .toEqual({ origin: 'https://test.example', scope: 'node-1', computerName: 'windows-pc', computerId: 'node-1' });
    expect(mocks.snapshot).toHaveBeenCalledWith({ profileId, targetId, instanceId: 'requesting-session', provider: 'codex', requireLive: true });
  });

  it('refuses a forged or detached shared profile before taking a snapshot', async () => {
    mocks.getTab.mockReturnValue(null);
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('preserves the operator opt-in for shared-tab credential access', async () => {
    mocks.settings.mockReturnValue({ browserAllowSharedTabCredentialFill: false });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'shared_tab_credential_fill_not_allowed' });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('refuses an unsafe extension runtime', async () => {
    mocks.runtime.mockReturnValue({ extensionVersion: '0.2.17', extensionStartedAt: 10 });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'shared_tab_secure_credential_fill_unavailable' });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('judges the extension of the Chrome profile that owns the tab', async () => {
    const trusted = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    // An outdated profile polled last; only an id-scoped read sees the trusted one.
    mocks.runtime.mockImplementation((_nodeId: string, instanceId?: string) => (instanceId === trusted
      ? { extensionVersion: '0.2.42', extensionStartedAt: 10 }
      : { extensionVersion: '0.2.17', extensionStartedAt: 20 }));
    mocks.getTab.mockReturnValue({ ...attachment, extensionInstanceId: trusted });

    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId))
      .resolves.toMatchObject({ computerId: 'node-1' });
    expect(mocks.runtime).toHaveBeenCalledWith('node-1', trusted);

    mocks.getTab.mockReturnValue({ ...attachment, extensionInstanceId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId))
      .rejects.toMatchObject({ code: 'shared_tab_secure_credential_fill_unavailable' });
  });

  it('refuses a disconnected worker', async () => {
    mocks.getNode.mockReturnValue({ id: 'node-1', name: 'windows-pc', connected: false, status: 'disconnected' });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('checks connection state again after the live snapshot', async () => {
    mocks.snapshot.mockImplementation(async () => {
      mocks.getNode.mockReturnValue({ connected: false, status: 'disconnected' });
      return { decision: 'allowed', outcome: 'succeeded', data: { url: 'https://test.example/login' } };
    });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('refuses disagreement between the live snapshot and the current tab origin', async () => {
    mocks.snapshot.mockResolvedValue({ decision: 'allowed', outcome: 'succeeded', data: { url: 'https://other.example' } });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'origin_mismatch' });
  });

  it('refuses mismatched attachment computer identity', async () => {
    mocks.getTab.mockReturnValue({ ...attachment, nodeId: 'different-node' });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('does not treat failed or cached reads as successful live validation', async () => {
    mocks.snapshot.mockResolvedValue({ decision: 'allowed', outcome: 'failed', data: { url: 'https://test.example' } });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId)).rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('distinguishes a confirmed closed tab from a temporary live-read failure', async () => {
    mocks.snapshot.mockResolvedValue({ decision: 'allowed', outcome: 'failed', reason: 'No tab with id: 42.', data: null });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId))
      .rejects.toMatchObject({ code: 'target_closed' });
    mocks.snapshot.mockResolvedValue({ decision: 'allowed', outcome: 'failed', reason: 'browser_extension_command_timeout', data: null });
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId))
      .rejects.toMatchObject({ code: 'target_unavailable' });
  });

  it('reports a tab already marked closed without trying another live read', async () => {
    mocks.listTargets.mockReturnValue([{ ...target, status: 'closed' }]);
    await expect(createCredentialAccessDependencies().readTarget(profileId, targetId))
      .rejects.toMatchObject({ code: 'target_closed' });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('keeps an aged-out worker suspension distinct from a confirmed closed tab', async () => {
    const { BrowserTargetRegistry } = await vi.importActual<typeof import('./browser-target-registry')>('./browser-target-registry');
    const { BrowserExtensionTabStore } = await vi.importActual<typeof import('./browser-extension-tab-store')>('./browser-extension-tab-store');
    let now = Date.now();
    const registry = new BrowserTargetRegistry();
    const tabs = new BrowserExtensionTabStore({ targetRegistry: registry, reliabilityEvents: { record: vi.fn() }, now: () => now });
    const tab = tabs.attachTab({ tabId: 2, windowId: 1, url: 'https://test.example/login' }, { nodeId: 'node-1' });
    tabs.suspendNode('node-1');
    now += 16 * 60_000;
    tabs.listTabs();
    expect(registry.listTargets()).toEqual([expect.objectContaining({ status: 'closed', stale: true })]);
    mocks.listTargets.mockImplementation((id?: string) => registry.listTargets(id));
    mocks.getTab.mockImplementation((profile: string, target: string) => tabs.getTab(profile, target));
    mocks.getNode.mockReturnValue({ connected: false, status: 'disconnected' });
    await expect(createCredentialAccessDependencies().readTarget(tab.profileId, tab.targetId))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });

  it('derives the computer for secure fill only from exact trusted targets', () => {
    expect(resolveCredentialComputerId(profileId, targetId)).toBe('node-1');
    mocks.getNode.mockReturnValueOnce({ connected: false, status: 'disconnected' });
    expect(resolveCredentialComputerId(profileId, targetId)).toBeUndefined();
    mocks.getTab.mockReturnValue({ ...attachment, nodeId: 'other-node' });
    expect(resolveCredentialComputerId(profileId, targetId)).toBeUndefined();
    mocks.listTargets.mockReturnValue([{ ...target, status: 'closed' }]);
    expect(resolveCredentialComputerId(profileId, targetId)).toBeUndefined();
  });

  it('does not carry a managed target to another computer during a snapshot', async () => {
    mocks.getTab.mockReturnValue(null);
    mocks.listTargets.mockReturnValue([{ id: 'managed-target', profileId: 'managed-profile', status: 'selected' }]);
    mocks.getProfile.mockReturnValue({ id: 'managed-profile', status: 'running', executionNodeId: 'node-1' });
    mocks.snapshot.mockImplementation(async () => {
      mocks.getProfile.mockReturnValue({ id: 'managed-profile', status: 'running', executionNodeId: 'local' });
      return { decision: 'allowed', outcome: 'succeeded', data: { url: 'https://test.example' } };
    });
    await expect(createCredentialAccessDependencies().readTarget('managed-profile', 'managed-target'))
      .rejects.toMatchObject({ code: 'target_unavailable' });
    expect(resolveCredentialComputerId('managed-profile', 'managed-target')).toBe('local');
  });
});
