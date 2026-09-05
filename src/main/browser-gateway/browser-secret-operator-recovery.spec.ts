import { describe, expect, it } from 'vitest';
import type { ScriptResult } from './browser-secret-recovery.testutil';
import { MARKER, POPUP_SENDER, PROTECTED_ORIGIN, recoveryHarness, settle } from './browser-secret-recovery.testutil';

const storedState = { version: 2, origins: [PROTECTED_ORIGIN], tabs: { '42': PROTECTED_ORIGIN } };

describe('operator secret protection recovery (shipped extension)', () => {
  it.each([storedState, { '42': PROTECTED_ORIGIN }])('clears reviewed persisted flags, including legacy state, while leaving the gateway off', async (stored) => {
    const h = recoveryHarness(stored);
    const status = await h.status();
    expect(status.origins).toEqual([PROTECTED_ORIGIN]);
    expect(status.tabCount).toBe(1);
    expect(status.reviewToken).toBeTypeOf('string');
    expect(await h.reset(status.reviewToken)).toEqual({ ok: true });
    expect(h.secretTaintedTabs.size).toBe(0);
    expect(h.secretTaintedOrigins.size).toBe(0);
    expect(h.storage['browserGatewaySecretTaints']).toEqual({ version: 2, origins: [], tabs: {} });
    expect(h.enabled()).toBe(false);
    expect(h.nativeMessages).toEqual([]);
    expect((await h.reset(status.reviewToken)).ok).toBe(false);
  });

  it.each([
    {}, { ...POPUP_SENDER, id: 'other-extension' },
    { ...POPUP_SENDER, url: 'https://test-only-page.example/' },
    { ...POPUP_SENDER, tab: { id: 42 } },
    { ...POPUP_SENDER, url: POPUP_SENDER.url + '?forged=true' },
  ])('rejects a non-popup sender even with a valid review token', async (sender) => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    expect((await h.reset(status.reviewToken, sender)).ok).toBe(false);
    expect(h.secretTaintedOrigins.size).toBe(1);
    expect((await h.send({ type: 'get_secret_protection' }, sender)).ok).toBe(false);
  });

  it('requires explicit acknowledgement and refuses tokens from an older review', async () => {
    const h = recoveryHarness(storedState);
    const old = await h.status();
    const current = await h.status();
    expect((await h.reset(old.reviewToken)).ok).toBe(false);
    expect((await h.send({ type: 'reset_secret_protection', reviewToken: current.reviewToken })).ok).toBe(false);
    expect(h.secretTaintedTabs.size).toBe(1);
    expect((await h.reset(current.reviewToken)).ok).toBe(true);
  });

  it('rejects recovery if the gateway is enabled after review', async () => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    await h.setGatewayEnabled(true);
    expect((await h.reset(status.reviewToken)).ok).toBe(false);
    expect((await h.status()).reviewToken).toBeNull();
    expect(h.secretTaintedTabs.size).toBe(1);
  });

  it('invalidates a review on a new fill, even when its origin and tab already exist', async () => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    await h.markSecretTaint(42, PROTECTED_ORIGIN);
    expect((await h.reset(status.reviewToken)).ok).toBe(false);
    expect(h.secretTaintedOrigins.size).toBe(1);
  });

  it('keeps persisted and in-memory protection intact when recovery storage fails', async () => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    h.chrome.storage.local.set.mockRejectedValueOnce(new Error(MARKER));
    const result = await h.reset(status.reviewToken);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(h.secretTaintedTabs.get('42')).toBe(PROTECTED_ORIGIN);
    expect(h.storage['browserGatewaySecretTaints']).toEqual(storedState);
    expect(h.enabled()).toBe(false);
  });

  it('blocks re-enabling the gateway until the recovery storage write completes', async () => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    let finish!: () => void;
    h.chrome.storage.local.set.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const reset = h.reset(status.reviewToken);
    await settle();
    await expect(h.setGatewayEnabled(true)).rejects.toThrow('recovery is still running');
    expect(h.secretTaintedTabs.size).toBe(1);
    finish();
    expect((await reset).ok).toBe(true);
    expect(h.enabled()).toBe(false);
  });

  it('does not let a delayed startup read overwrite an explicit gateway-off action', async () => {
    let loaded!: (enabled: boolean) => void;
    const h = recoveryHarness(storedState, new Promise<boolean>(resolve => { loaded = resolve; }));
    const off = h.setGatewayEnabled(false);
    loaded(true);
    await off;
    expect(h.enabled()).toBe(false);
    expect(h.storage['browserGatewayEnabled']).toBe(false);
    expect((await h.status()).reviewToken).toBeTypeOf('string');
  });

  it('persists gateway OFF with recovery even if the earlier OFF write failed', async () => {
    const h = recoveryHarness(storedState, Promise.resolve(true));
    h.storage['browserGatewayEnabled'] = true;
    await settle();
    h.chrome.storage.local.set.mockRejectedValueOnce(new Error('TEST_ONLY off persistence failure'));
    await h.setGatewayEnabled(false);
    expect(h.enabled()).toBe(false);
    expect(h.storage['browserGatewayEnabled']).toBe(true);
    expect((await h.reset((await h.status()).reviewToken)).ok).toBe(true);
    expect(h.storage['browserGatewayEnabled']).toBe(false);
    const restarted = recoveryHarness(
      h.storage['browserGatewaySecretTaints'],
      Promise.resolve(h.storage['browserGatewayEnabled'] === true),
    );
    expect((await restarted.status()).origins).toEqual([]);
    expect(restarted.enabled()).toBe(false);
    expect(restarted.nativeMessages).toEqual([]);
  });

  it('keeps recovery persisted across reload when a tab closes during storage acknowledgement', async () => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    const persist = h.chrome.storage.local.set.getMockImplementation()!;
    let acknowledge!: () => void;
    h.chrome.storage.local.set.mockImplementationOnce(async values => {
      await persist(values);
      await new Promise<void>(resolve => { acknowledge = resolve; });
    });
    const reset = h.reset(status.reviewToken);
    await settle();
    const close = h.clearSecretTaint(42);
    await settle();
    acknowledge();
    expect((await reset).ok).toBe(true);
    await close;
    const persisted = h.storage['browserGatewaySecretTaints'];
    expect(persisted).toEqual({ version: 2, origins: [], tabs: {} });
    const restarted = recoveryHarness(persisted);
    expect((await restarted.status()).origins).toEqual([]);
    expect(restarted.secretTaintedTabs.size).toBe(0);
  });

  it('keeps recovered sharing OFF when a restarted worker cannot read its saved setting', async () => {
    const h = recoveryHarness(storedState);
    expect((await h.reset((await h.status()).reviewToken)).ok).toBe(true);
    const restarted = recoveryHarness(
      h.storage['browserGatewaySecretTaints'],
      Promise.reject(new Error('TEST_ONLY startup read failure')),
    );
    expect((await restarted.status()).origins).toEqual([]);
    expect(restarted.enabled()).toBe(false);
    expect(restarted.nativeMessages).toEqual([]);
    // Recovery from uncertainty requires a new explicit operator action.
    await restarted.setGatewayEnabled(true);
    expect(restarted.enabled()).toBe(true);
  });

  it('expires the operator review after five minutes', async () => {
    const h = recoveryHarness(storedState);
    const status = await h.status();
    h.advanceTime(300001);
    expect((await h.reset(status.reviewToken)).ok).toBe(false);
    expect(h.secretTaintedOrigins.size).toBe(1);
  });

  it('requires a new review when pending command classification discovers inherited protection', async () => {
    const h = recoveryHarness();
    const status = await h.status();
    let finish!: (value: ScriptResult[]) => void;
    h.chrome.scripting.executeScript.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const classification = h.targetSecretTaintOrigin({ id: 'test', command: 'snapshot', target: { tabId: 42 } });
    await settle();
    const reset = h.reset(status.reviewToken);
    await settle();
    finish([{ frameId: 0, result: { origin: PROTECTED_ORIGIN } }]);
    expect(await classification).toBe(PROTECTED_ORIGIN);
    expect((await reset).ok).toBe(false);
    expect((await h.reset((await h.status()).reviewToken)).ok).toBe(true);
    const restarted = recoveryHarness(h.storage['browserGatewaySecretTaints']);
    expect((await restarted.status()).origins).toEqual([]);
    expect(restarted.secretTaintedTabs.size).toBe(0);
  });

  it('prevents command classification from restoring old flags while reset awaits storage acknowledgement', async () => {
    const h = recoveryHarness();
    const status = await h.status();
    h.tabs.get(42)!.url = PROTECTED_ORIGIN + '/';
    const persist = h.chrome.storage.local.set.getMockImplementation()!;
    let acknowledge!: () => void;
    h.chrome.storage.local.set.mockImplementationOnce(async values => {
      await persist(values);
      await new Promise<void>(resolve => { acknowledge = resolve; });
    });
    const reset = h.reset(status.reviewToken);
    await settle();
    const classification = h.targetSecretTaintOrigin({ id: 'test', command: 'snapshot', target: { tabId: 42 } });
    await settle();
    acknowledge();
    expect((await reset).ok).toBe(true);
    expect(await classification).toBeNull();
    const persisted = h.storage['browserGatewaySecretTaints'];
    expect(persisted).toEqual({ version: 2, origins: [], tabs: {} });
    const restarted = recoveryHarness(persisted);
    expect((await restarted.status()).origins).toEqual([]);
    expect(restarted.secretTaintedTabs.size).toBe(0);
  });

  it('keeps recovery unavailable after a watchdog timeout until the actual command settles', async () => {
    const h = recoveryHarness({ version: 2, origins: [], tabs: {} });
    await settle();
    await h.setGatewayEnabled(true);
    const original = h.chrome.scripting.executeScript.getMockImplementation()!;
    let finish!: (value: ScriptResult[]) => void;
    h.chrome.scripting.executeScript.mockImplementation(async input => {
      if (input.args?.[0] === 'type') return await new Promise(resolve => { finish = resolve; });
      return original(input);
    });
    const command = h.runCommandWithWatchdog({ id: 'late-write', command: 'type', target: { tabId: 42 }, payload: { selector: '#test', value: 'TEST_ONLY_VALUE' }, timeoutMs: 1000 })
      .catch((e: unknown) => e);
    await settle();
    expect(h.activeCount()).toBe(1);
    h.timers.find(t => t.delay === 1000)!.callback();
    expect(String(await command)).toContain('browser_extension_command_timeout');
    await h.setGatewayEnabled(false);
    expect(h.activeCount()).toBe(1);
    expect((await h.status()).reviewToken).toBeNull();
    finish([{ result: { __found: true, valueApplied: true } }]);
    await settle();
    expect(h.activeCount()).toBe(0);
    expect((await h.status()).reviewToken).toBeTypeOf('string');
  });
});
