import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCodexDeviceDelivery } from '../rpc-codex-device-delivery';
import { CodexDeviceTransferRegistry } from '../codex-device-transfer';
import type { WorkerNodeConnectionServer } from '../worker-node-connection';
import type { RpcRequest } from '../worker-node-rpc';

const auth = vi.hoisted(() => ({ validateSessionToken: vi.fn((_token?: string, _nodeId?: string) => true) }));
vi.mock('../../auth/remote-auth', () => ({ getRemoteAuthService: () => auth }));

function fixture() {
  let current = true;
  const lease = () => current;
  const capture = vi.fn((): (() => boolean) | null => lease);
  const connection = { captureConfidentialResponder: capture } as unknown as WorkerNodeConnectionServer;
  const transfers = new CodexDeviceTransferRegistry();
  const owner = { sessionId: 'test-session', generation: 'test-generation' };
  const binding = { browserNodeId: 'test-browser', profileId: 'test-profile', targetId: 'test-tab',
    origin: 'https://auth.openai.com' as const, documentId: 'test-document', extensionInstanceId: 'test-extension',
    extensionGeneration: 'test-generation', approvalId: 'test-approval', expectedIdentity: 'test@example.invalid' };
  const handle = randomUUID();
  const expiresAt = Date.now() + 60_000;
  const deliver = vi.fn(async (): Promise<void> => undefined);
  const { transferId } = transfers.register({ nodeId: 'test-node', handle, owner, binding, expiresAt,
    signal: new AbortController().signal, isCurrent: () => true, deliver });
  const request: RpcRequest = { jsonrpc: '2.0', id: `codex-device-private-${randomUUID()}`,
    method: 'provider.codexDevice.deliver', scope: 'service', token: 'test-token-placeholder',
    params: { handle, owner, binding, transferId, expiresAt, code: 'TEST-CODE' } };
  const respond = vi.fn(() => true);
  const run = () => handleCodexDeviceDelivery('test-node', request, respond, connection, transfers);
  return { request, respond, run, deliver, capture, transfers, connection, lease, replace: () => { current = false; } };
}

beforeEach(() => { vi.clearAllMocks(); auth.validateSessionToken.mockReturnValue(true); });
describe('private Codex delivery', () => {
  it('authenticates the top-level token and actual responder, then acknowledges verified delivery', async () => {
    const f = fixture();
    await f.run();
    expect(auth.validateSessionToken).toHaveBeenCalledWith('test-token-placeholder', 'test-node');
    expect(f.capture).toHaveBeenCalledWith('test-node', f.respond);
    expect(f.deliver).toHaveBeenCalledWith('TEST-CODE', expect.any(AbortSignal));
    expect(f.respond).toHaveBeenCalledWith({ jsonrpc: '2.0', id: f.request.id, result: { delivered: true } });
    expect(f.request.params).toBeUndefined();
    expect(f.request.token).toBeUndefined();
  });
  it.each(['auth', 'schema', 'scope', 'missing-lease', 'stale-lease', 'missing-responder', 'id'])('refuses %s without delivery or reflected payloads', async failure => {
    const f = fixture();
    if (failure === 'auth') auth.validateSessionToken.mockReturnValue(false);
    if (failure === 'schema') f.request.params = { ...(f.request.params as object), 'TEST-CODE': 'TEST-CODE' };
    if (failure === 'scope') f.request.scope = 'instance';
    if (failure === 'missing-lease') f.capture.mockReturnValue(null);
    if (failure === 'stale-lease') f.replace();
    if (failure === 'id') f.request.id = 'TEST-CODE';
    if (failure === 'missing-responder') await handleCodexDeviceDelivery('test-node', f.request, undefined, f.connection, f.transfers);
    else await f.run();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(f.respond.mock.calls)).not.toContain('TEST-CODE');
    expect(f.request.params).toBeUndefined();
    f.transfers.shutdown();
  });
  it('never accepts a nested token in place of the envelope token', async () => {
    const f = fixture();
    delete f.request.token;
    auth.validateSessionToken.mockImplementation(token => token === 'test-token-placeholder');
    f.request.params = { ...(f.request.params as object), token: 'test-token-placeholder' };
    await f.run();
    expect(f.deliver).not.toHaveBeenCalled();
    f.transfers.shutdown();
  });
  it('does not acknowledge a socket replaced during delivery', async () => {
    const f = fixture();
    f.deliver.mockImplementation(async () => { f.replace(); });
    await f.run();
    expect(f.respond).not.toHaveBeenCalled();
  });
  it('returns only a fixed refusal when delivery throws with sensitive text', async () => {
    const f = fixture();
    f.deliver.mockRejectedValue(new Error('TEST-CODE'));
    await f.run();
    expect(f.respond).toHaveBeenCalledWith({ jsonrpc: '2.0', id: f.request.id,
      error: { code: -32000, message: 'codex_device_delivery_refused' } });
  });
  it('rejects non-boolean transport proof without releasing the code', async () => {
    const f = fixture();
    f.capture.mockReturnValue((() => Promise.resolve(true)) as unknown as () => boolean);
    await f.run();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.respond).not.toHaveBeenCalled();
    f.transfers.shutdown();
  });
  it('rejects an invalid registry acknowledgement without reflecting its contents', async () => {
    const f = fixture();
    vi.spyOn(f.transfers, 'receive').mockResolvedValue({ delivered: true, code: 'TEST-CODE' } as { delivered: true });
    await f.run();
    expect(f.respond).toHaveBeenCalledWith({ jsonrpc: '2.0', id: f.request.id,
      error: { code: -32000, message: 'codex_device_delivery_refused' } });
    f.transfers.shutdown();
  });
  it('erases the original payload while delivery is still pending', async () => {
    const f = fixture();
    let finish!: () => void;
    f.deliver.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const raw = f.request.params as { code: string };
    const pending = f.run();
    expect(f.request.params).toBeUndefined();
    expect(raw.code).toBe('');
    expect(f.respond).not.toHaveBeenCalled();
    finish();
    await pending;
    expect(f.respond).toHaveBeenCalledWith({ jsonrpc: '2.0', id: f.request.id, result: { delivered: true } });
  });
  it('contains responder exceptions without propagating or retrying', async () => {
    const f = fixture();
    f.respond.mockImplementation(() => { throw new Error('TEST-CODE'); });
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.respond).toHaveBeenCalledOnce();
  });
});
