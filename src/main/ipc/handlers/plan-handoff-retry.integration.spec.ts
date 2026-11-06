import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance, type InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { InstanceManager } from '../../instance/instance-manager';
import { registerPlanHandoffHandlers } from './plan-handoff-handlers';
import { _resetInstanceCreateIdempotencyCacheForTesting, getInstanceCreateIdempotencyCache } from './instance-create-idempotency';

const handlers = vi.hoisted(() => new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>());
vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (event: unknown, payload: unknown) => Promise<IpcResponse>) => handlers.set(channel, handler),
} }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

function harness() {
  const source = createInstance({ workingDirectory: '/inert-plan', agentId: 'plan', provider: 'claude' });
  source.outputBuffer = [{ id: 'plan-text', timestamp: 1, type: 'assistant', content: 'Implement the approved feature.' }];
  let pending = [{ id: 'ready-request', requestType: 'switch_mode', targetMode: 'build' }];
  const create = vi.fn(async (config: InstanceCreateConfig) => createInstance(config));
  const dismiss = vi.fn(() => { pending = []; });
  const notice = vi.fn();
  const approve = vi.fn();
  // Only the manager boundary is inert: handler/schema/service/seed/cache execute.
  registerPlanHandoffHandlers({
    getInstance: (id: string) => id === source.id ? source : undefined,
    createInstance: create,
    getOrchestrationHandler: () => ({
      getPendingUserActionsForInstance: (id: string) => id === source.id ? pending : [],
      dismissUserAction: dismiss,
    }),
    approvePlan: approve,
    emitSystemMessage: notice,
  } as unknown as InstanceManager);
  const send = (overrides: Record<string, unknown> = {}) => handlers.get('plan-handoff:start')!({}, {
    instanceId: source.id, requestId: 'ready-request', idempotencyKey: 'stable-key', ...overrides,
  });
  return { source, send, create, dismiss, notice, approve, pending: () => pending };
}

describe('actual plan handoff IPC retry acknowledgement', () => {
  beforeEach(() => { handlers.clear(); _resetInstanceCreateIdempotencyCacheForTesting(); });

  it('replays the exact settled acknowledgement after silent dismissal', async () => {
    const h = harness();
    const first = await h.send();
    expect(first).toMatchObject({ success: true, data: { ok: true, newInstanceId: expect.any(String) } });
    expect(h.pending()).toEqual([]);
    expect(getInstanceCreateIdempotencyCache().has('plan-handoff:stable-key')).toBe(true);
    expect(await h.send()).toBe(first);
    expect(h.create).toHaveBeenCalledOnce();
    expect(h.dismiss).toHaveBeenCalledOnce();
    expect(h.notice).toHaveBeenCalledOnce();
    expect(h.approve).not.toHaveBeenCalled();
  });

  it.each([
    { requestId: 'foreign-request' }, { instanceId: 'missing-source' },
  ])('does not authorize a changed source/request from a warm cache: %j', async (changed) => {
    const h = harness();
    expect((await h.send()).success).toBe(true);
    expect(await h.send(changed)).toMatchObject({ success: false, error: { code: 'PLAN_HANDOFF_START_FAILED' } });
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('shares one pending creation and then the same settled acknowledgement', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    h.create.mockImplementationOnce(async config => { await gate; return createInstance(config); });
    const first = h.send();
    const concurrent = h.send();
    expect(h.create).toHaveBeenCalledOnce();
    release();
    const ack = await first;
    expect(await concurrent).toBe(ack);
    expect(await h.send()).toBe(ack);
    expect(h.dismiss).toHaveBeenCalledOnce();
  });

  it('maps an asynchronous creation rejection and permits a genuine retry', async () => {
    const h = harness();
    h.create.mockRejectedValueOnce(new Error('inert creation refused'));
    expect(await h.send()).toMatchObject({ success: false, error: { message: 'inert creation refused' } });
    expect(h.dismiss).not.toHaveBeenCalled();
    expect((await h.send()).success).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it('evicts a mapped service failure so the same key can retry after correction', async () => {
    const h = harness();
    h.source.agentId = 'build';
    expect((await h.send()).success).toBe(false);
    h.source.agentId = 'plan';
    expect((await h.send()).success).toBe(true);
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('retains no-key ownership validation after dismissal', async () => {
    const h = harness();
    expect((await h.send({ idempotencyKey: undefined })).success).toBe(true);
    expect((await h.send({ idempotencyKey: undefined })).success).toBe(false);
    expect(h.create).toHaveBeenCalledOnce();
  });

  it('retains requestless enabled Plan Mode approval and cached replay', async () => {
    const h = harness();
    h.source.planMode = { enabled: true, state: 'planning', planContent: 'Build the approved feature.' };
    const first = await h.send({ requestId: undefined });
    expect(first.success).toBe(true);
    expect(await h.send({ requestId: undefined })).toBe(first);
    expect(h.approve).toHaveBeenCalledOnce();
    expect(h.dismiss).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledOnce();
  });
});
