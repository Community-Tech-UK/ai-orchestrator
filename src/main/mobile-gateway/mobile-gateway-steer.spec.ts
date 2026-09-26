import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDeviceRegistry } from './mobile-device-registry';
import { MobileGatewayServer, type GatewayInstanceSource } from './mobile-gateway-server';
import type { Instance } from '../../shared/types/instance.types';

describe('Mobile steering HTTP boundary', () => {
  let server: MobileGatewayServer;
  let base: string;
  let token: string;
  let source: GatewayInstanceSource;
  const attachment = { name: 'photo.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' };

  beforeEach(async () => {
    const instance = { id: 'a', displayName: 'Agent', status: 'busy', provider: 'claude',
      workingDirectory: '/project', createdAt: 1, lastActivity: 1, parentId: null,
      outputBuffer: [], contextUsage: { used: 0, total: 0, percentage: 0 } } as unknown as Instance;
    source = Object.assign(new EventEmitter(), {
      getAllInstances: () => [instance], getInstance: (id: string) => id === 'a' ? instance : undefined,
      sendInput: vi.fn().mockResolvedValue(undefined), steerInput: vi.fn().mockResolvedValue(undefined),
      interruptInstance: vi.fn(), terminateInstance: vi.fn(), resumeAfterDeferredPermission: vi.fn(),
      recordInputRequiredPermissionDecision: vi.fn(), clearPendingInputRequiredPermission: vi.fn(),
      renameInstance: vi.fn(), changeModel: vi.fn(), createInstance: vi.fn(),
      getOrchestrationHandler: () => Object.assign(new EventEmitter(), { respondToUserAction: vi.fn() }),
    });
    const registry = new MobileDeviceRegistry({ load: () => undefined, save: () => undefined });
    const pause = Object.assign(new EventEmitter(), {
      toPayload: () => ({ isPaused: false, reasons: [], pausedAt: null, lastChange: 0 }), addReason: vi.fn(), removeReason: vi.fn(),
    });
    server = new MobileGatewayServer();
    server.initialize({ instanceManager: source, registry, pauseCoordinator: pause,
      loopCoordinator: Object.assign(new EventEmitter(), { getActiveLoops: () => [] }) });
    const status = await server.start({ port: 0, bindInterface: 'all' });
    base = `http://127.0.0.1:${status.port}`;
    const pairing = registry.issuePairing();
    const response = await fetch(`${base}/pair`, { method: 'POST', body: JSON.stringify({ pairingToken: pairing.pairingToken }) });
    token = (await response.json()).token;
  });
  afterEach(async () => { await server.stop(); });

  const invalidBodies = [null, [], 'text', {}, { message: '   ' }, { message: 1 },
    { message: 'x'.repeat(500_001) }, { message: 'x', attachments: {} },
    { message: 'x', attachments: [null] }, { message: 'x', attachments: [[]] },
    { attachments: [{ ...attachment, name: 'x'.repeat(501) }] },
    { attachments: [{ ...attachment, type: 'x'.repeat(101) }] },
    { attachments: [{ ...attachment, size: 50 * 1024 * 1024 + 1 }] },
    { attachments: [{ ...attachment, size: -1 }] }, { attachments: [{ ...attachment, size: '4' }] },
    { attachments: [{ ...attachment, data: 4 }] }, { attachments: Array(11).fill(attachment) }];
  function post(action: string, body: unknown, id = 'a', auth = true) {
    return fetch(`${base}/api/instances/${id}/${action}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body) });
  }

  it('requires authentication before steering', async () => {
    expect((await post('steer', { message: 'change course' }, 'a', false)).status).toBe(401);
    expect(source.steerInput).not.toHaveBeenCalled();
  });
  it('rejects a missing session', async () => {
    expect((await post('steer', { message: 'change course' }, 'missing')).status).toBe(404);
    expect(source.steerInput).not.toHaveBeenCalled();
  });
  it('calls steerInput once with text and attachments, with no queue or normal send', async () => {
    const response = await post('steer', { message: 'change course', attachments: [attachment] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(source.steerInput).toHaveBeenCalledExactlyOnceWith('a', 'change course', [attachment]);
    expect(source.sendInput).not.toHaveBeenCalled();
    expect(source.interruptInstance).not.toHaveBeenCalled();
    const snapshot = await fetch(`${base}/api/snapshot`, { headers: { authorization: `Bearer ${token}` } }).then(r => r.json());
    expect(snapshot.instances[0].queuedMessages).toBeUndefined();
  });
  it('keeps normal Send queued during an active turn', async () => {
    expect(await (await post('input', { message: 'later' })).json()).toMatchObject({ ok: true, queued: true });
    expect(source.steerInput).not.toHaveBeenCalled();
    expect(source.sendInput).not.toHaveBeenCalled();
  });
  it('returns manager rejection without attempting normal delivery', async () => {
    vi.mocked(source.steerInput).mockRejectedValueOnce(new Error('Steer refused'));
    const response = await post('steer', { message: 'change course' });
    expect(response.status).toBe(500);
    expect(source.sendInput).not.toHaveBeenCalled();
  });
  it('allows attachment-only steering at the declared size boundary', async () => {
    const attachments = [{ ...attachment, size: 50 * 1024 * 1024 }];
    expect((await post('steer', { message: '', attachments })).status).toBe(200);
    expect(source.steerInput).toHaveBeenCalledWith('a', '', attachments);
  });
  for (const action of ['input', 'steer']) {
    it('retains the 8 MiB transfer cap on ' + action, async () => {
      await expect(post(action, { attachments: [{ ...attachment, data: 'x'.repeat(8 * 1024 * 1024) }] })).rejects.toThrow('fetch failed');
      expect(source.steerInput).not.toHaveBeenCalled();
      expect(source.sendInput).not.toHaveBeenCalled();
    });
    it('accepts exact text and attachment metadata limits on ' + action, async () => {
      const attachments = Array.from({ length: 10 }, () => ({ ...attachment, name: 'n'.repeat(500), type: 't'.repeat(100), size: 50 * 1024 * 1024 }));
      expect((await post(action, { message: 'x'.repeat(500_000), attachments })).status).toBe(200);
    });
    it('rejects malformed JSON on ' + action, async () => {
      const response = await fetch(`${base}/api/instances/a/${action}`, { method: 'POST',
        headers: { authorization: `Bearer ${token}` }, body: '{' });
      expect(response.status).toBe(400);
      expect(source.steerInput).not.toHaveBeenCalled();
      expect(source.sendInput).not.toHaveBeenCalled();
    });
    it.each(invalidBodies.map((body, index) => ({ body, index })))('rejects invalid body $index on ' + action, async ({ body }) => {
      expect((await post(action, body)).status).toBe(400);
      expect(source.steerInput).not.toHaveBeenCalled();
      expect(source.sendInput).not.toHaveBeenCalled();
    });
  }
});
