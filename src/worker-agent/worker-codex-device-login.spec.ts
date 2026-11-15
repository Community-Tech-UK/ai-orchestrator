import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexDeviceLoginService } from '../main/providers/account-pool/codex-device-login';
import { WorkerCodexDeviceLogin } from './worker-codex-device-login';
import type { WebSocket } from 'ws';

const owner = { sessionId: 'test-session', generation: 'test-generation' };
const identity = 'account@example.test';
const binding = { browserNodeId: 'browser', profileId: 'browser-profile', targetId: 'tab', origin: 'https://auth.openai.com',
  documentId: 'document', extensionInstanceId: 'installation', extensionGeneration: 'generation', approvalId: 'approval', expectedIdentity: identity };
const prompt = '1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   TEST-CODEX\n';
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.useRealTimers(); });

function harness(enabled = true) {
  const tls = new TLSSocket(new Socket());
  tls.authorized = true;
  const frames: Record<string, unknown>[] = [];
  const socket = { readyState: 1, _socket: tls, send: (raw: string) => frames.push(JSON.parse(raw)) } as unknown as WebSocket;
  let current: WebSocket | null = socket;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  const prepareHome = vi.fn(() => '/test-owned-home');
  const worker = new WorkerCodexDeviceLogin({
    config: { nodeId: 'native', codexDeviceLogin: enabled ? { enabled: true, expectedIdentity: identity } : undefined },
    getSocket: () => current, getRegistered: () => true, getToken: () => 'PLACEHOLDER_TOKEN',
    createService: deps => new CodexDeviceLoginService({ ...deps, prepareHome, spawn: () => child, probeIdentity: async () => identity }),
  });
  cleanups.push(() => { worker.shutdown(); tls.destroy(); });
  const call = async (method: string, params: unknown, scope = 'service', source = socket) => {
    worker.handleMessage({ jsonrpc: '2.0', id: frames.length + 1, method: `provider.codexDevice.${method}`, params, scope: scope as 'service' }, source);
    await new Promise(resolve => setImmediate(resolve));
    return frames.at(-1)!;
  };
  const start = async () => {
    const reply = await call('start', { profileId: 'fresh', owner });
    const view = reply['result'] as { handle: string; state: string };
    child.stdout.write(prompt);
    return view;
  };
  return { worker, tls, socket, frames, child, prepareHome, call, start, replace: () => { current = null; } };
}

describe('private native worker device login', () => {
  it.each(['UPPERCASE', 'with_underscore', 'legacy', '../escape'])('refuses invalid native profile %s before preparing it', async profileId => {
    const h = harness();
    expect((await h.call('start', { profileId, owner }))['error']).toBeDefined();
    expect(h.prepareHome).not.toHaveBeenCalled();
  });
  it.each(['disabled', 'plaintext', 'unverified', 'scope', 'source', 'injection'])('refuses %s before creating a home or starting native login', async kind => {
    const h = harness(kind !== 'disabled');
    if (kind === 'plaintext') Object.assign(h.socket, { _socket: {} });
    if (kind === 'unverified') h.tls.authorized = false;
    const reply = await h.call('start', { profileId: 'fresh', owner, ...(kind === 'injection' ? { code: 'PRIVATE_PLACEHOLDER' } : {}) },
      kind === 'scope' ? 'instance' : 'service', kind === 'source' ? {} as WebSocket : h.socket);
    if (kind === 'source') expect(h.frames).toHaveLength(0);
    else expect(reply['error']).toBeDefined();
    expect(h.prepareHome).not.toHaveBeenCalled();
    expect(JSON.stringify(h.frames)).not.toContain('PRIVATE_PLACEHOLDER');
  });

  it('keeps private delivery pending until exact socket acknowledgement and never puts code in ordinary results', async () => {
    const h = harness();
    const view = await h.start();
    expect(view.state).toBe('starting');
    const transferId = '11111111-1111-4111-8111-111111111111';
    await h.call('handoff', { handle: view.handle, owner, binding, transferId });
    const transfer = h.frames.find(f => f['method'] === 'provider.codexDevice.deliver')!;
    expect(transfer).toBeDefined();
    expect(transfer['params']).toMatchObject({ code: 'TEST-CODEX', transferId, owner, binding });
    let reply = await h.call('read', { handle: view.handle, owner });
    expect(reply['result']).toMatchObject({ state: 'delivering' });
    h.worker.handleMessage({ jsonrpc: '2.0', id: transfer['id'] as string, result: { delivered: true } }, {} as WebSocket);
    reply = await h.call('read', { handle: view.handle, owner });
    expect(reply['result']).toMatchObject({ state: 'delivering' });
    h.worker.handleMessage({ jsonrpc: '2.0', id: transfer['id'] as string, result: { delivered: true } }, h.socket);
    await new Promise(resolve => setImmediate(resolve));
    reply = await h.call('read', { handle: view.handle, owner });
    expect(reply['result']).toMatchObject({ state: 'awaiting_login' });
    expect(JSON.stringify(h.frames.filter(f => !f['method']))).not.toContain('TEST-CODEX');
    expect((await h.call('handoff', { handle: view.handle, owner, binding, transferId }))['error']).toBeDefined();
  });

  it('refuses foreign owner, cancels pending transfer on disconnect and ignores late success', async () => {
    const h = harness();
    const view = await h.start();
    expect((await h.call('read', { handle: view.handle, owner: { ...owner, generation: 'foreign' } }))['error']).toBeDefined();
    await h.call('handoff', { handle: view.handle, owner, binding, transferId: '11111111-1111-4111-8111-111111111111' });
    h.replace();
    h.worker.shutdown();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.child.kill).toHaveBeenCalled();
    expect(h.worker.activeCount()).toBe(0);
    expect(JSON.stringify(h.frames.filter(f => !f['method']))).not.toContain('TEST-CODEX');
  });

  it.each(['refusal', 'malformed'])('fails the native operation after %s acknowledgement without echoing its body', async kind => {
    const h = harness();
    const view = await h.start();
    await h.call('handoff', { handle: view.handle, owner, binding, transferId: '11111111-1111-4111-8111-111111111111' });
    const transfer = h.frames.find(f => f['method'])!;
    h.worker.handleMessage({ jsonrpc: '2.0', id: transfer['id'] as string,
      ...(kind === 'refusal' ? { error: { code: -1, message: 'PRIVATE_PLACEHOLDER' } } : { result: { delivered: true, leak: 'PRIVATE_PLACEHOLDER' } }) }, h.socket);
    await new Promise(resolve => setImmediate(resolve));
    expect((await h.call('read', { handle: view.handle, owner }))['result']).toMatchObject({ state: 'failed', error: 'handoff_failed' });
    expect(JSON.stringify(h.frames)).not.toContain('PRIVATE_PLACEHOLDER');
    expect(h.child.kill).toHaveBeenCalled();
  });

  it('rechecks the actual TLS socket after serialization before code release', async () => {
    const h = harness();
    const view = await h.start();
    // A trusted token getter can trigger connection replacement synchronously; no old/new socket receives a code.
    Reflect.get(h.worker, 'deps').getToken = () => { h.replace(); return 'PLACEHOLDER_TOKEN'; };
    await h.call('handoff', { handle: view.handle, owner, binding, transferId: '11111111-1111-4111-8111-111111111111' });
    expect(h.frames.some(f => f['method'])).toBe(false);
    expect(h.child.kill).toHaveBeenCalled();
  });

  it('fails a transfer without acknowledgement after its bounded deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const h = harness();
    const view = await h.start();
    await h.call('handoff', { handle: view.handle, owner, binding, transferId: '11111111-1111-4111-8111-111111111111' });
    await vi.advanceTimersByTimeAsync(60_001);
    expect((await h.call('read', { handle: view.handle, owner }))['result']).toMatchObject({ state: 'failed', error: 'handoff_failed' });
    expect(h.child.kill).toHaveBeenCalled();
  });
});
