import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function harness() {
  const listeners = new Map<string, (event: Record<string, unknown>) => void>();
  const event = (name: string) => ({ addListener: (fn: (value: Record<string, unknown>) => void) => listeners.set(name, fn) });
  let frame = { documentId: 'chrome-document', url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent', documentLifecycle: 'active' };
  const chrome = {
    webNavigation: { getFrame: vi.fn(async () => ({ ...frame })), onBeforeNavigate: event('before'),
      onCommitted: event('committed'), onHistoryStateUpdated: event('history'),
      onReferenceFragmentUpdated: event('fragment'), onErrorOccurred: event('error'), onTabReplaced: event('replaced') },
    tabs: { onRemoved: event('removed') },
    cookies: { onChanged: event('cookie') },
    scripting: { executeScript: vi.fn(async (_input: unknown): Promise<Array<{ frameId: number; documentId: string; result: unknown }>> =>
      [{ frameId: 0, documentId: 'chrome-document', result: { identity: 'approved@example.invalid' } }]) },
  };
  const taint = vi.fn(async () => undefined);
  const source = readFileSync('resources/browser-extension/codex-device-handoff.js', 'utf8');
  const create = runInNewContext(`${source}\ncreateCodexDeviceExtensionAdapter;`, { URL, Date, setTimeout, clearTimeout });
  const rawAdapter = create({ chrome, runtime: () => ({ extensionInstanceId: 'test-install', extensionGeneration: '1000' }),
    enabled: () => true, withBoundary: (fn: () => Promise<unknown>) => fn(), taint });
  const owner = {};
  const adapter = { ...rawAdapter, run: (command: unknown, deadline: number) => rawAdapter.run(command, deadline, owner) };
  const command = { command: 'codex_device_context', target: { tabId: 42, extensionInstanceId: 'test-install' },
    payload: { expectedIdentity: 'approved@example.invalid' } };
  return { adapter, chrome, taint, command, listeners, setFrame: (value: typeof frame) => { frame = value; } };
}

describe('private Codex Chrome context adapter', () => {
  it('binds the approved transition and private writes to one Chrome document', async () => {
    const h = harness();
    const binding = { operationHandle: 'test-operation', approvalId: 'test-approval', expectedIdentity: 'approved@example.invalid',
      expiresAt: Date.now() + 20_000, documentId: 'chrome-document', extensionInstanceId: 'test-install', extensionGeneration: '1000' };
    const dispatch = (command: string, code?: string) => h.adapter.run({ ...h.command, command,
      payload: { binding, deviceDocumentId: 'chrome-document', code } }, Date.now() + 10_000);
    h.chrome.scripting.executeScript.mockImplementation(async (input) => {
      const action = (input as { args: unknown[] }).args[0];
      if (action === 'transition') {
        const frame = { documentId: 'chrome-document', url: 'https://auth.openai.com/deviceauth/callback', documentLifecycle: 'active' };
        h.setFrame(frame);
        h.listeners.get('history')!({ ...frame, tabId: 42, frameId: 0 });
      }
      return [{ frameId: 0, documentId: 'chrome-document', result: action === 'consent' ? { identity: binding.expectedIdentity } : true }];
    });
    expect(await dispatch('codex_device_attest')).toEqual({ completed: true, deviceDocumentId: 'chrome-document' });
    expect(h.taint).toHaveBeenCalledWith(42, 'https://auth.openai.com');
    expect(await dispatch('codex_device_fill', 'TESTCODEX')).toEqual({ completed: true,
      observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' });
    expect(await dispatch('codex_device_submit')).toEqual({ completed: true,
      observationBlocked: 'browser_secret_observation_blocked_for_tainted_origin' });
    await expect(dispatch('codex_device_submit')).rejects.toThrow(/^codex_device_handoff_refused$/);
  });

  it('returns only Chrome document/install generation and exact identity confirmation', async () => {
    const h = harness();
    expect(await h.adapter.run(h.command, Date.now() + 10_000)).toEqual({
      documentId: 'chrome-document', extensionInstanceId: 'test-install', extensionGeneration: '1000', identityMatches: true,
    });
    expect(h.taint).not.toHaveBeenCalled();
    expect(h.chrome.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 42, documentIds: ['chrome-document'] }, world: 'ISOLATED',
    }));
  });

  it('rejects same-document context when another tab changes an OpenAI auth cookie', async () => {
    const h = harness();
    h.chrome.scripting.executeScript.mockImplementation(async () => {
      h.listeners.get('cookie')?.({ cookie: { domain: '.openai.com' } });
      return [{ frameId: 0, documentId: 'chrome-document', result: { identity: 'approved@example.invalid' } }];
    });
    await expect(h.adapter.run(h.command, Date.now() + 10_000)).rejects.toThrow(/^codex_device_handoff_refused$/);
  });

  it.each(['identity', 'document', 'origin', 'navigation', 'exception'])('refuses changed %s with fixed secret-free error', async (kind) => {
    const h = harness();
    if (kind === 'identity') h.chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0, documentId: 'chrome-document', result: { identity: 'wrong@example.invalid' } }]);
    if (kind === 'document') h.chrome.scripting.executeScript.mockResolvedValue([{ frameId: 0, documentId: 'other-document', result: { identity: 'approved@example.invalid' } }]);
    if (kind === 'origin') h.setFrame({ documentId: 'chrome-document', documentLifecycle: 'active', url: 'https://wrong.example.invalid/sign-in-with-chatgpt/codex/consent' });
    if (kind === 'navigation') h.chrome.scripting.executeScript.mockImplementation(async () => {
      h.listeners.get('before')!({ tabId: 42, frameId: 0 });
      return [{ frameId: 0, documentId: 'chrome-document', result: { identity: 'approved@example.invalid' } }];
    });
    if (kind === 'exception') h.chrome.scripting.executeScript.mockRejectedValue(new Error('TEST_ONLY_PRIVATE_EXCEPTION'));
    await expect(h.adapter.run(h.command, Date.now() + 10_000)).rejects.toThrow(/^codex_device_handoff_refused$/);
    expect(h.taint).not.toHaveBeenCalled();
  });
});
