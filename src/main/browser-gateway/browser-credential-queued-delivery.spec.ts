import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';
import { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import { CredentialVault } from './browser-credential-vault';
import { CredentialAuthorizationService, InMemoryCredentialAuthorizationStore } from './browser-credential-authorization-store';

const origin = 'https://login.example.test';
const placeholder = 'TEST_ONLY_PASSWORD_PLACEHOLDER';
const queueKey = 'node:windows-pc';
const attachment = { profileId: 'existing-tab:test', targetId: 'target-test', tabId: 1, windowId: 1, nodeId: 'windows-pc', url: origin, origin, allowedOrigins: [], attachedAt: 1, updatedAt: 1 };

function fixture() {
  let session: string | undefined = 'TEST_ONLY_SESSION_PLACEHOLDER';
  let generation = 0;
  let now = Date.now();
  let computerId = 'windows-pc';
  let secureRuntime = true;
  const store = new BrowserExtensionCommandStore();
  const vault = new CredentialVault({
    getSession: () => session, getSessionGeneration: () => generation,
    runner: { run: async () => { throw new Error('Vault reads are forbidden in this delivery test'); } },
    bindings: { get: () => undefined, put: () => undefined },
  });
  const auth = new CredentialAuthorizationService(new InMemoryCredentialAuthorizationStore(), () => now);
  auth.create({ profileId: 'node:windows-pc', allowedOrigins: [{ scheme: 'https', hostPattern: 'login.example.test', includeSubdomains: false }], purposes: ['login'], vaultFolder: 'AIO-Agent', vaultItemRef: 'TEST_ONLY_ITEM', taskScope: 'TEST_ONLY_TASK', computerId: 'windows-pc', expiresAt: now + 60_000 }, 'TEST_ONLY_AUTHORIZATION');
  const assertUnlocked = vault.captureFillGuard();
  const guard = vi.fn(() => {
    assertUnlocked();
    if (!auth.check({ profileId: 'node:windows-pc', origin, purpose: 'login', vaultItemRef: 'TEST_ONLY_ITEM', taskScope: 'TEST_ONLY_TASK', computerId }).authorized) throw new Error('credential_authorization_changed');
    if (!secureRuntime) throw new Error('shared_tab_secure_credential_fill_unavailable');
  });
  const operations = new BrowserExistingTabOperations({
    extensionCommandStore: store,
    extensionTabStore: { attachTab: vi.fn(), detachTab: vi.fn() },
    isRemoteExtensionContactFresh: () => true, describeRemoteExtensionContact: () => 'TEST_ONLY_CHANNEL',
    grantStore: { listGrants: () => [], consumeGrant: () => null },
    approvalStore: { createRequest: vi.fn() }, result: vi.fn(), autoApproveApproval: () => null,
  });
  const fill = () => operations.sendCommand(attachment, 'type', { selector: '#password', value: placeholder, credentialOrigin: origin, credentialProtection: 'password' }, 1_000, undefined, guard);
  return { store, guard, fill,
    change: (change: string) => {
      if (change === 'lock' || change === 'lock-unlock') { generation++; session = undefined; if (change === 'lock-unlock') session = 'TEST_ONLY_REPLACEMENT_SESSION'; }
      if (change === 'revoke') auth.revoke('TEST_ONLY_AUTHORIZATION');
      if (change === 'expiry') now += 60_001;
      if (change === 'computer') computerId = 'another-computer';
      if (change === 'runtime') secureRuntime = false;
    },
  };
}

const poll = { timeoutMs: 1, allowSecureCredentialCommands: true };

describe('credential permission at queued extension delivery', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['lock', 'lock-unlock', 'revoke', 'expiry', 'computer', 'runtime'])('discards queued credentials after %s without consuming an ordinary command poll', async (change) => {
    const h = fixture();
    const result = h.fill().catch((error: unknown) => error as Error);
    expect(h.store.describeQueue(queueKey).queuedCount).toBe(1);
    h.change(change);
    const ordinary = h.store.sendCommand({ queueKey, command: 'snapshot', timeoutMs: 1_000 });
    const command = await h.store.pollCommand(queueKey, poll);
    expect(command?.command).toBe('snapshot');
    h.store.resolveCommand({ queueKey, commandId: command!.id, ok: true, result: { title: 'Test page' } });
    await expect(ordinary).resolves.toEqual({ title: 'Test page' });
    expect(await result).toMatchObject({ message: 'credential_delivery_rejected', code: 'credential_delivery_rejected' });
    expect(h.guard).toHaveBeenCalledTimes(2);
    expect(h.store.describeQueue(queueKey)).toMatchObject({ queuedCount: 0, inFlightCount: 0 });
    expect(h.store.describeDeliveryHealth(queueKey)).toMatchObject({ commandsAnswered: true, consecutiveUnanswered: 0 });
    expect(h.store.describePreDeliveryCapability(queueKey)).toEqual({ commandsDeliverable: true });
    expect(JSON.stringify({ command, result: await result })).not.toContain(placeholder);
    await expect(h.store.pollCommand(queueKey, poll)).resolves.toBeNull();
  });

  it.each(['lock', 'lock-unlock', 'revoke', 'expiry'])('retains the same guard through an unsent handoff and rejects %s before redelivery', async (change) => {
    const h = fixture();
    const result = h.fill().catch((error: unknown) => error as Error);
    const command = await h.store.pollCommand(queueKey, { ...poll, deferHandoffConfirmation: true });
    expect(command?.command).toBe('type');
    expect(h.store.validateCommandHandoff(queueKey, command!.id)).toBe(true);
    expect(h.store.requeueUndeliveredCommand(queueKey, command!.id)).toBe(true);
    h.change(change);
    await expect(h.store.pollCommand(queueKey, poll)).resolves.toBeNull();
    expect(await result).toMatchObject({ code: 'credential_delivery_rejected' });
    expect(h.store.requeueUndeliveredCommand(queueKey, command!.id)).toBe(false);
    expect(h.store.confirmCommandHandoff(queueKey, command!.id)).toBe(false);
    expect(h.store.describeQueue(queueKey)).toMatchObject({ queuedCount: 0, inFlightCount: 0 });
  });

  it('rechecks after poll resolution and releases the remote handoff slot on rejection', async () => {
    const h = fixture();
    const result = h.fill().catch((error: unknown) => error as Error);
    const command = await h.store.pollCommand(queueKey, { ...poll, deferHandoffConfirmation: true });
    h.change('lock');
    const waitingPoll = h.store.pollCommand(queueKey, poll);
    const ordinary = h.store.sendCommand({ queueKey, command: 'snapshot', timeoutMs: 1_000 });
    expect(h.store.validateCommandHandoff(queueKey, command!.id)).toBe(false);
    const next = await waitingPoll;
    expect(next?.command).toBe('snapshot');
    h.store.resolveCommand({ queueKey, commandId: next!.id, ok: true, result: {} });
    await ordinary;
    expect(await result).toMatchObject({ code: 'credential_delivery_rejected' });
    expect(h.store.requeueUndeliveredCommand(queueKey, command!.id)).toBe(false);
    expect(h.store.describeDeliveryHealth(queueKey).consecutiveUnanswered).toBe(0);
  });

  it('returns only the serializable command and never exports its validation callback', async () => {
    const h = fixture();
    const result = h.fill();
    const command = await h.store.pollCommand(queueKey, poll);
    expect(command).not.toHaveProperty('beforeDelivery');
    expect(Object.values(command!)).not.toContain(h.guard);
    expect(h.store.validateCommandHandoff(queueKey, command!.id)).toBe(true);
    h.store.resolveCommand({ queueKey, commandId: command!.id, ok: true, result: { completed: true } });
    await expect(result).resolves.toEqual({ completed: true });
  });

  it('never resurrects a credential command after a real disconnect and reconnect', async () => {
    const h = fixture();
    const result = h.fill().catch((error: unknown) => error as Error);
    const command = await h.store.pollCommand(queueKey, { ...poll, deferHandoffConfirmation: true });
    h.store.rejectQueue(queueKey, 'node_disconnected');
    expect(await result).toMatchObject({ message: 'node_disconnected' });
    expect(h.store.validateCommandHandoff(queueKey, command!.id)).toBe(false);
    expect(h.store.requeueUndeliveredCommand(queueKey, command!.id)).toBe(false);
    const ordinary = h.store.sendCommand({ queueKey, command: 'snapshot', timeoutMs: 1_000 });
    const next = await h.store.pollCommand(queueKey, poll);
    expect(next?.command).toBe('snapshot');
    h.store.resolveCommand({ queueKey, commandId: next!.id, ok: true, result: {} });
    await ordinary;
  });

  it('cleans up rejected guarded commands without leaving receipt or execution timers', async () => {
    vi.useFakeTimers();
    const h = fixture();
    const result = h.fill().catch((error: unknown) => error as Error);
    h.change('lock');
    const polled = h.store.pollCommand(queueKey, poll);
    await vi.advanceTimersByTimeAsync(1);
    await expect(polled).resolves.toBeNull();
    expect(await result).toMatchObject({ code: 'credential_delivery_rejected' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.store.describeDeliveryHealth(queueKey).consecutiveUnanswered).toBe(0);
  });
});
