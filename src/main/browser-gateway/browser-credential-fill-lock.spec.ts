import { describe, expect, it, vi } from 'vitest';
import { fillCredentialOperation, type FillOperationDeps } from './browser-form-fill-operations';
import { CredentialVault } from './browser-credential-vault';
import { BrowserCredentialSession } from './browser-credential-session';
import { CredentialAuthorizationService, InMemoryCredentialAuthorizationStore } from './browser-credential-authorization-store';
import { BrowserGatewayResultRecorder } from './browser-gateway-result';

describe('vault locks between secret resolution and browser dispatch', () => {
  it.each([false, true])('cancels a pending fill after lock (subsequent unlock: %s)', async (unlockAgain) => {
    const origin = 'https://login.example.test';
    const session = new BrowserCredentialSession();
    session.unlock('TEST_ONLY_SESSION_PLACEHOLDER');
    let generation = 0;
    const vault = new CredentialVault({
      getSession: () => session.getToken(), getSessionGeneration: () => generation,
      bindings: { get: () => ({ vaultItemRef: 'test-item', origin, username: 'TEST_ONLY_USERNAME', createdAt: 1 }), put: () => undefined },
      runner: { run: async (args) => ({ code: 0, stderr: '', stdout: JSON.stringify(args[1] === 'folders'
        ? [{ id: 'test-folder', name: 'AIO-Agent' }]
        : { id: 'test-item', folderId: 'test-folder', login: { password: 'TEST_ONLY_PASSWORD_PLACEHOLDER' } }) }) },
    });
    const auth = new CredentialAuthorizationService(new InMemoryCredentialAuthorizationStore());
    auth.create({ profileId: 'local', allowedOrigins: [{ scheme: 'https', hostPattern: 'login.example.test', includeSubdomains: false }], purposes: ['login'], vaultFolder: 'AIO-Agent', expiresAt: Date.now() + 60_000 }, 'test-authorization');
    let finish!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const release = new Promise<void>((resolve) => { finish = resolve; });
    let snapshots = 0;
    const driverType = vi.fn(async () => undefined);
    const recorder = new BrowserGatewayResultRecorder({ record: (entry) => ({ ...entry, id: 'test-audit', createdAt: Date.now() }) });
    const deps: FillOperationDeps = {
      result: (input) => recorder.record(input), hasExistingTab: () => true,
      sharedTabCredentialFillAllowed: () => true, sharedTabSecureCredentialFillSupported: () => true,
      resolveCredentialProfileScope: () => 'local', resolveCredentialComputerId: () => 'local',
      credentialVault: vault, credentialAuthorizations: auth,
      type: vi.fn(), select: vi.fn(), click: vi.fn(), readControl: vi.fn(), driverType,
      refreshTargetOrigin: async () => { if (++snapshots === 2) { started(); await release; } return origin; },
    };
    const filling = fillCredentialOperation(deps, { profileId: 'existing-tab:test', targetId: 'test-target', vaultItemRef: 'test-item', fields: [{ selector: '#password', kind: 'password' }] });
    await begun;
    generation += 1;
    session.lock();
    if (unlockAgain) session.unlock('TEST_ONLY_NEW_SESSION_PLACEHOLDER');
    finish();
    const result = await filling;
    // The lock lands during the in-loop origin re-check, so the pre-dispatch
    // guard is what cancels the fill — and the reason names that exact step.
    expect(result).toMatchObject({ decision: 'denied', outcome: 'failed', reason: 'pre_dispatch_guard:vault_locked', data: null });
    expect(driverType).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('TEST_ONLY_PASSWORD_PLACEHOLDER');
  });
});
