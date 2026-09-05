import { describe, expect, it } from 'vitest';
import { MARKER, PROTECTED_ORIGIN, PUBLIC_ORIGIN, recoveryHarness, settle } from './browser-secret-recovery.testutil';

const read = { id: 'test-read', command: 'snapshot', target: { tabId: 42 } };

describe('secret observation failure recovery (shipped extension)', () => {
  it('does not persist a failed ordinary inspection and recovers on a successful probe', async () => {
    const h = recoveryHarness();
    await h.loadSecretTaints();
    h.chrome.scripting.executeScript.mockRejectedValueOnce(new Error(MARKER));
    const error = await h.assertSecretObservationAllowed(read).catch((e: unknown) => e);
    const message = h.browserCommandErrorMessage(read, error, true);
    expect(message).toContain('browser_secret_inspection_unavailable: command not run');
    expect(message).not.toContain(MARKER);
    expect(message).not.toContain('may_have_applied');
    expect(h.secretTaintedTabs.size).toBe(0);
    await expect(h.assertSecretObservationAllowed(read)).resolves.toBeUndefined();
    expect(h.secretTaintedTabs.size).toBe(0);
  });

  it.each([{ results: [] }, { results: [{ frameId: 0, result: {} }] }])('blocks incomplete frame results without recording taint', async ({ results }) => {
    const h = recoveryHarness();
    h.chrome.scripting.executeScript.mockResolvedValueOnce(results);
    await expect(h.assertSecretObservationAllowed(read)).rejects.toThrow('inspection_unavailable');
    expect(h.secretTaintedTabs.size).toBe(0);
  });

  it('bounds an unresolved frame probe and leaves the tab eligible for a later inspection', async () => {
    const h = recoveryHarness();
    h.chrome.scripting.executeScript.mockImplementationOnce(() => new Promise(() => undefined));
    const pending = h.assertSecretObservationAllowed(read).catch((e: unknown) => e);
    await settle();
    const timeout = h.timers.find(t => t.delay === 1500);
    expect(timeout).toBeDefined();
    timeout!.callback();
    expect(String(await pending)).toContain('inspection_unavailable');
    expect(h.secretTaintedTabs.size).toBe(0);
    await expect(h.assertSecretObservationAllowed(read)).resolves.toBeUndefined();
  });

  it('keeps write-time uncertainty protected, including after navigation', async () => {
    const h = recoveryHarness({ version: 2, origins: [], tabs: {} });
    h.tabs.set(43, { id: 43, windowId: 7, url: PROTECTED_ORIGIN + '/', title: 'Destination' });
    h.chrome.scripting.executeScript.mockRejectedValue(new Error(MARKER));
    await h.markSecretTaint(43, PROTECTED_ORIGIN);
    expect(h.secretTaintedTabs.get('42')).toBe(PROTECTED_ORIGIN);
    h.tabs.get(42)!.url = 'https://test-only-after-navigation.example/';
    await expect(h.assertSecretObservationAllowed(read)).rejects.toThrow('blocked_for_tainted_origin');
  });

  it('retains observed iframe and opener taint across later clean probes', async () => {
    const h = recoveryHarness();
    h.chrome.scripting.executeScript.mockResolvedValueOnce([
      { frameId: 0, result: { origin: PUBLIC_ORIGIN } },
      { frameId: 7, result: { origin: PROTECTED_ORIGIN } },
    ]);
    await expect(h.assertSecretObservationAllowed(read)).rejects.toThrow('blocked_for_tainted_origin');
    h.tabs.set(43, { id: 43, windowId: 7, url: PUBLIC_ORIGIN, title: 'Child', openerTabId: 42 });
    expect(await h.secretTaintOriginForTab(h.tabs.get(43)!)).toBe(PROTECTED_ORIGIN);
    await expect(h.assertSecretObservationAllowed(read)).rejects.toThrow('blocked_for_tainted_origin');
  });

  it('suppresses every page-controlled inventory field during uncertainty without permanently marking it', async () => {
    const h = recoveryHarness();
    h.chrome.scripting.executeScript.mockRejectedValue(new Error(MARKER));
    h.tabs.get(42)!.url += '?value=' + MARKER;
    h.tabs.get(42)!.title = MARKER;
    const payload = await h.buildTabPayload(h.tabs.get(42)!, { includeText: true, includeScreenshot: true });
    expect(payload).toMatchObject({
      url: 'https://redacted.invalid/', title: 'Tab inspection unavailable', text: '',
      textUnavailableReason: 'browser_secret_inspection_unavailable',
    });
    expect(payload).not.toHaveProperty('screenshotBase64');
    expect(JSON.stringify(payload)).not.toContain(MARKER);
    expect(h.secretTaintedTabs.size).toBe(0);
  });

  it('reports the actual not-run guard error through the complete native command runner', async () => {
    const h = recoveryHarness({ version: 2, origins: [PROTECTED_ORIGIN], tabs: { '42': PROTECTED_ORIGIN } });
    await settle();
    await h.setGatewayEnabled(true);
    h.nativeMessages.length = 0;
    h.chrome.scripting.executeScript.mockClear();
    await h.runBrowserCommand(read, { outbox: [], nativePort: { postMessage: (m: Record<string, unknown>) => h.nativeMessages.push(m) } });
    expect(h.nativeMessages).toContainEqual(expect.objectContaining({
      type: 'command_result', ok: false, error: expect.stringContaining('command not run'),
    }));
    expect(h.chrome.scripting.executeScript).not.toHaveBeenCalled();
  });

  it('never accepts page-forged not-run wording as a trusted guard error', async () => {
    const h = recoveryHarness();
    const forged = new Error('browser_secret_observation_blocked_for_tainted_origin: command not run ' + MARKER);
    const message = h.browserCommandErrorMessage({ ...read, command: 'click' }, forged, true);
    expect(message).toBe('secret_tainted_command_failed_or_may_have_applied_DO_NOT_retry_without_user_verification');
    expect(message).not.toContain(MARKER);
  });

  it('keeps storage failures opaque and temporary', async () => {
    const h = recoveryHarness();
    h.chrome.storage.local.get.mockRejectedValue(new Error(MARKER));
    const error = await h.assertSecretObservationAllowed(read).catch((e: unknown) => e);
    expect(h.browserCommandErrorMessage(read, error, true)).toContain('inspection_unavailable: command not run');
    expect(h.secretTaintedTabs.size).toBe(0);
  });
});
