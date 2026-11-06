import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig, Instance } from '../../../shared/types/instance.types';
import { PlanBuildHandoff } from './plan-build-handoff';
import { buildInstanceRecord } from '../lifecycle/instance-create-builder';
import { encodeLocalModelSelector } from '../../../shared/utils/local-model-selector';
import type { ModelRuntimeTarget } from '../../../shared/types/local-model-runtime.types';

vi.mock('../../logging/logger', () => ({ getLogger: () => ({ warn: vi.fn() }) }));
const cache = new Map<string, unknown>();
vi.mock('../../ipc/handlers/instance-create-idempotency', () => ({
  getInstanceCreateIdempotencyCache: () => ({
    run: async (key: string, run: () => Promise<unknown>) => {
      if (cache.has(key)) return cache.get(key);
      const value = await run();
      cache.set(key, value);
      return value;
    },
  }),
}));

function planInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'plan-1', displayName: 'Plan export', agentId: 'plan', workingDirectory: '/repo',
    provider: 'claude', currentModel: 'sonnet', historyThreadId: 'thread-1',
    contextUsage: { used: 14_200, occupancyReported: true }, planMode: { enabled: false, state: 'off' },
    executionLocation: { type: 'local' }, outputBuffer: [
      { id: 'u', type: 'user', content: 'Plan export', timestamp: 1 },
      { id: 'a', type: 'assistant', content: '1. Build the export button.', timestamp: 2 },
    ],
    ...overrides,
  } as unknown as Instance;
}

function harness(source: Instance = planInstance()) {
  const createInstance = vi.fn(async () => ({ id: 'build-1' }) as Instance);
  const dismissUserAction = vi.fn();
  const approvePlan = vi.fn();
  const emitSystemNotice = vi.fn();
  const handoff = new PlanBuildHandoff({
    getInstance: () => source,
    createInstance,
    dismissUserAction,
    approvePlan,
    emitSystemNotice,
  });
  return { handoff, createInstance, dismissUserAction, approvePlan, emitSystemNotice };
}

describe('PlanBuildHandoff', () => {
  beforeEach(() => cache.clear());

  it('previews the extracted plan and context numbers', () => {
    const { handoff } = harness();
    expect(handoff.preview('plan-1')).toMatchObject({
      canStart: true, planningContextTokens: 14_200, provider: 'claude', model: 'sonnet',
    });
  });

  it.each([
    ['never reported occupancy', { used: 14_200 }],
    ['an estimate placeholder of 0', { used: 0 }],
    ['a cumulative spend total', { used: 4_800_000, occupancyReported: true, occupancyIsAggregate: true }],
    ['no usage object at all', undefined],
  ])('omits the planning context number when occupancy is %s (R5M3)', (_label, contextUsage) => {
    const { handoff } = harness(planInstance({ contextUsage } as Partial<Instance>));
    const preview = handoff.preview('plan-1');
    expect(preview.planningContextTokens).toBeNull();
    expect(preview.canStart).toBe(true);
  });

  it('reports the number only for a measured window occupancy (R5M3)', () => {
    const { handoff } = harness(planInstance({
      contextUsage: { used: 142_000, occupancyReported: true, occupancyIsAggregate: false },
    } as Partial<Instance>));
    expect(handoff.preview('plan-1').planningContextTokens).toBe(142_000);
  });

  it('refuses non-plan sessions even with caller-supplied text', async () => {
    const { handoff, createInstance } = harness(planInstance({ agentId: 'build' }));
    expect(await handoff.start({ sourceId: 'plan-1', planText: 'approved' })).toMatchObject({ ok: false });
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('rejects oversized and empty edited plans', async () => {
    const { handoff, createInstance } = harness();
    expect((await handoff.start({ sourceId: 'plan-1', planText: 'x'.repeat(60_001) })).ok).toBe(false);
    expect((await handoff.start({ sourceId: 'plan-1', planText: ' ' })).ok).toBe(false);
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('creates an independent build session and dismisses the request', async () => {
    const { handoff, createInstance, dismissUserAction, emitSystemNotice } = harness();
    const result = await handoff.start({ sourceId: 'plan-1', requestId: 'request-1', model: 'opus' });
    expect(result).toEqual({ ok: true, newInstanceId: 'build-1' });
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'build', parentId: null, provider: 'claude', modelOverride: 'opus',
      isRenamed: true, initialUserMessageSource: 'current-submission',
      metadata: { plannedFrom: expect.objectContaining({ instanceId: 'plan-1' }) },
    }));
    expect(dismissUserAction).toHaveBeenCalledWith('request-1');
    expect(emitSystemNotice).toHaveBeenCalledOnce();
  });

  it.each([
    ['this-device', undefined],
    ['worker-node', undefined],
    ['this-device', 'fixture-local-model'],
    ['this-device', 'opus'],
  ] as const)('keeps the actual %s runtime unless another model is explicitly chosen (%s)', async (placement, model) => {
    const fields = {
      source: placement, endpointProvider: 'openai-compatible' as const,
      endpointId: 'fixture-local-endpoint', modelId: 'fixture-local-model',
      ...(placement === 'worker-node' ? { nodeId: 'fixture-worker', nodeName: 'Fixture worker' } : {}),
    };
    const target: ModelRuntimeTarget = { kind: 'local-model', ...fields, selectorId: encodeLocalModelSelector(fields) };
    const source = planInstance({ currentModel: target.modelId, modelRuntimeTarget: target });
    const createInstance = vi.fn(async (config: InstanceCreateConfig) => buildInstanceRecord(
      config, { id: 'build', mode: 'build' } as Parameters<typeof buildInstanceRecord>[1],
      { defaultYoloMode: false, getParent: () => undefined },
    ));
    const handoff = new PlanBuildHandoff({ getInstance: () => source, createInstance, emitSystemNotice: vi.fn() });
    const input = { sourceId: source.id, model, idempotencyKey: 'local-handoff' };
    const result = await handoff.start(input);
    expect(await handoff.start(input)).toEqual(result);
    expect(createInstance).toHaveBeenCalledOnce();
    const created = await createInstance.mock.results[0].value;
    expect(created.id).not.toBe(source.id);
    expect(created.parentId).toBeNull();
    expect(created.currentModel).toBe(model ?? target.modelId);
    if (model === 'opus') {
      expect(created.modelRuntimeTarget).toBeUndefined();
      expect(created.runtimeSummary).toBeUndefined();
    } else {
      expect(created.modelRuntimeTarget).toEqual(target);
      expect(created.runtimeSummary).toMatchObject({ kind: 'local-model', selectorId: target.selectorId });
    }
    expect(source.modelRuntimeTarget).toEqual(target);
  });

  it('approves a planning Plan Mode session and retains remote placement', async () => {
    const { handoff, createInstance, approvePlan } = harness(planInstance({
      planMode: { enabled: true, state: 'planning' } as Instance['planMode'],
      executionLocation: { type: 'remote', nodeId: 'node-1' },
      nodePlacement: { strategy: 'prefer-remote' } as Instance['nodePlacement'],
    }));
    await handoff.start({ sourceId: 'plan-1' });
    expect(approvePlan).toHaveBeenCalledWith('plan-1', expect.any(String));
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ forceNodeId: 'node-1' }));
  });

  it('does not complete the handoff before plan approval settles', async () => {
    const source = planInstance({ planMode: { enabled: true, state: 'planning' } as Instance['planMode'] });
    let resolveApproval!: () => void;
    const approval = new Promise<void>((resolve) => { resolveApproval = resolve; });
    let signalCreated!: () => void;
    const created = new Promise<void>((resolve) => { signalCreated = resolve; });
    const emitSystemNotice = vi.fn();
    const handoff = new PlanBuildHandoff({
      getInstance: () => source,
      createInstance: async () => { signalCreated(); return { id: 'build-1' } as Instance; },
      approvePlan: () => approval,
      emitSystemNotice,
    });
    const result = handoff.start({ sourceId: source.id });
    await created;
    await new Promise(resolve => setImmediate(resolve));
    expect(emitSystemNotice).not.toHaveBeenCalled();
    resolveApproval();
    expect(await result).toMatchObject({ ok: true, newInstanceId: 'build-1' });
    expect(emitSystemNotice).toHaveBeenCalledOnce();
  });

  it('catches a rejected approval as best effort after creating the build session', async () => {
    const { handoff, approvePlan, emitSystemNotice } = harness(planInstance({
      planMode: { enabled: true, state: 'planning' } as Instance['planMode'],
    }));
    approvePlan.mockRejectedValueOnce(new Error('approval unavailable'));
    expect(await handoff.start({ sourceId: 'plan-1' })).toMatchObject({ ok: true, newInstanceId: 'build-1' });
    expect(emitSystemNotice).toHaveBeenCalledOnce();
  });

  it('replays a successful idempotency response', async () => {
    const { handoff, createInstance } = harness();
    const input = { sourceId: 'plan-1', idempotencyKey: 'same' };
    expect(await handoff.start(input)).toEqual(await handoff.start(input));
    expect(createInstance).toHaveBeenCalledOnce();
  });
});
