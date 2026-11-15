import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexDeviceTransferRegistry } from '../codex-device-transfer';

const binding = {
  browserNodeId: 'browser-node', profileId: 'browser-profile', targetId: 'browser-target',
  origin: 'https://auth.openai.com', documentId: 'document-placeholder',
  extensionInstanceId: 'extension-placeholder', extensionGeneration: 'generation-placeholder',
  approvalId: 'approval-placeholder', expectedIdentity: 'account@example.test',
};
const owner = { sessionId: 'session-placeholder', generation: 'owner-generation' };
const registries: CodexDeviceTransferRegistry[] = [];
function setup() {
  const registry = new CodexDeviceTransferRegistry(); registries.push(registry);
  const signal = new AbortController();
  const deliver = vi.fn(async (_code: string, _signal: AbortSignal): Promise<void> => undefined);
  const input = { nodeId: 'native-node', handle: 'handle-placeholder', owner, binding,
    expiresAt: Date.now() + 60_000, signal: signal.signal, isCurrent: () => true, deliver };
  const transfer = registry.register(input);
  const payload = { transferId: transfer.transferId, handle: input.handle, owner: { ...owner },
    binding: { ...binding }, expiresAt: input.expiresAt, code: 'NON-SECRET-TEST-PLACEHOLDER' };
  return { registry, signal, deliver, input, transfer, payload };
}
afterEach(() => { for (const registry of registries.splice(0)) registry.shutdown(); vi.useRealTimers(); });

describe('private native device-code transfer', () => {
  it.each(['native-node', 'browser-node'])('cancels transfers when %s disconnects', async (nodeId) => {
    const { registry, payload, deliver } = setup();
    registry.invalidateNode(nodeId);
    await expect(registry.receive('native-node', payload, () => true)).rejects.toThrow('codex_device_transfer_refused');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('does not cancel transfers for an unrelated node', async () => {
    const { registry, payload } = setup();
    registry.invalidateNode('other-node');
    await expect(registry.receive('native-node', payload, () => true)).resolves.toEqual({ delivered: true });
  });

  it('acknowledges only after the private callback completes, and consumes once', async () => {
    const { registry, deliver, payload } = setup();
    let finish!: () => void;
    deliver.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = registry.receive('native-node', payload, () => true);
    await expect(registry.receive('native-node', payload, () => true)).rejects.toThrow('codex_device_transfer_refused');
    expect(deliver).toHaveBeenCalledOnce();
    finish();
    await expect(first).resolves.toEqual({ delivered: true });
    await expect(registry.receive('native-node', payload, () => true)).rejects.toThrow('codex_device_transfer_refused');
  });

  it.each(['node', 'owner', 'handle', 'binding', 'expiry'])('refuses a mismatched %s without exposing a code', async (field) => {
    const { registry, deliver, payload } = setup();
    const altered = structuredClone(payload);
    if (field === 'owner') altered.owner.generation = 'other-generation';
    if (field === 'handle') altered.handle = 'other-handle';
    if (field === 'binding') altered.binding.extensionInstanceId = 'other-install';
    if (field === 'expiry') altered.expiresAt++;
    await expect(registry.receive(field === 'node' ? 'other-node' : 'native-node', altered, () => true))
      .rejects.toThrow('codex_device_transfer_refused');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('refuses a lost incoming TLS proof even when original authority remains live', async () => {
    const { registry, payload, deliver } = setup();
    await expect(registry.receive('native-node', payload, () => false)).rejects.toThrow('codex_device_transfer_refused');
    expect(deliver).not.toHaveBeenCalled();
  });

  it('settles a cancelled transfer even when the private callback never settles', async () => {
    const { registry, payload, deliver, signal } = setup();
    deliver.mockImplementation(() => new Promise(() => undefined));
    const received = registry.receive('native-node', payload, () => true);
    const rejection = expect(received).rejects.toThrow('codex_device_transfer_refused');
    signal.abort();
    await rejection;
    expect(deliver.mock.calls[0]![1].aborted).toBe(true);
  });

  it('refuses acknowledgment after authority changes during delivery', async () => {
    const { registry, input, deliver } = setup();
    let current = true;
    const next = registry.register({ ...input, handle: 'second-handle', isCurrent: () => current });
    deliver.mockImplementation(async () => { current = false; });
    await expect(registry.receive('native-node', { transferId: next.transferId, handle: 'second-handle',
      owner, binding, expiresAt: input.expiresAt, code: 'NON-SECRET-TEST-PLACEHOLDER' }, () => true))
      .rejects.toThrow('codex_device_transfer_refused');
  });

  it('bounds expiry and hides callback errors', async () => {
    const { registry, input, payload, deliver } = setup();
    expect(() => registry.register({ ...input, expiresAt: Infinity })).toThrow('codex_device_transfer_refused');
    deliver.mockRejectedValue(new Error('NON-SECRET-PRIVATE-ERROR-PLACEHOLDER'));
    await expect(registry.receive('native-node', payload, () => true)).rejects.toThrow(/^codex_device_transfer_refused$/);
  });
});
