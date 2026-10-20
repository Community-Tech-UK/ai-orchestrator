import { describe, expect, it, vi } from 'vitest';

import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';

const admission = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn(() => ({ kind: 'admitted' as const, admissionId: 'admission-42' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  requeueUndelivered: vi.fn(),
  registerRedeliveryHandler: vi.fn(),
}));

vi.mock('../../session/session-admission-service', () => ({
  getSessionAdmissionService: () => admission,
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../learning/outcome-tracker', () => ({
  OutcomeTracker: { getInstance: () => ({ recordOutcome: vi.fn() }) },
}));
vi.mock('../../learning/strategy-learner', () => ({
  StrategyLearner: { getInstance: () => ({ getRecommendation: vi.fn(() => null) }) },
}));
vi.mock('../../learning/preference-store', () => ({
  getPreferenceStore: () => ({ get: vi.fn(() => undefined) }),
}));

function setup(
  adapter: { sendInput: (message: string) => Promise<void>; sendOrchestrationResponse?: (message: string, onDelayed?: () => void) => Promise<void> },
  holdRejectedResponse?: (instanceId: string, adapter: unknown, error: Error) => boolean,
  holdQueuedResponse?: (instanceId: string) => boolean,
) {
  const parent = {
    id: 'parent-1', status: 'busy', displayName: 'parent', childrenIds: [], depth: 0,
  } as unknown as Instance;
  const output: OutputMessage[] = [];
  const manager = new InstanceOrchestrationManager({
    getInstance: () => parent,
    getInstanceCount: () => 1,
    createChildInstance: vi.fn(),
    sendInput: vi.fn(),
    terminateInstance: vi.fn(),
    getAdapter: () => adapter,
    recordTaskOutcome: vi.fn(),
    holdRejectedResponse,
    holdQueuedResponse,
  });
  manager.setupOrchestrationHandlers(
    { maxTotalInstances: 0, maxChildrenPerParent: 0, allowNestedOrchestration: false, maxSpawnDepth: 0 },
    (_instance, message) => output.push(message),
    vi.fn(),
  );
  manager.registerInstance(parent.id, '/tmp', null);
  return { manager, output };
}

describe('orchestration response delivery to an active parent', () => {
  it('confirms the child ID admission only after the provider-safe send settles once', async () => {
    admission.markDelivered.mockClear();
    admission.markFailed.mockClear();
    let resolveSend!: () => void;
    let reportDelayed: (() => void) | undefined;
    const sendOrchestrationResponse = vi.fn((_message: string, onDelayed?: () => void) => {
      reportDelayed = onDelayed;
      return new Promise<void>((resolve) => { resolveSend = resolve; });
    });
    const sendInput = vi.fn(async (_message: string) => undefined);
    const { manager, output } = setup({ sendInput, sendOrchestrationResponse });

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-42', 'worker');
    await vi.waitFor(() => expect(sendOrchestrationResponse).toHaveBeenCalledTimes(1));
    expect(sendOrchestrationResponse.mock.calls[0]?.[0]).toContain('child-42');
    expect(sendInput).not.toHaveBeenCalled();
    expect(admission.markDelivered).not.toHaveBeenCalled();

    reportDelayed?.();
    expect(output.some((message) => message.content.includes('child-42')
      && message.metadata?.['deliveryPending'] === true)).toBe(true);
    expect(admission.markDelivered).not.toHaveBeenCalled();

    resolveSend();
    await vi.waitFor(() => expect(admission.markDelivered).toHaveBeenCalledWith('admission-42'));
    expect(sendOrchestrationResponse).toHaveBeenCalledTimes(1);
    expect(admission.markFailed).not.toHaveBeenCalled();
  });

  it('surfaces a failed send with the child ID and marks the admission failed', async () => {
    admission.markDelivered.mockClear();
    admission.markFailed.mockClear();
    const sendOrchestrationResponse = vi.fn(async () => { throw new Error('runtime closed'); });
    const { manager, output } = setup({ sendInput: vi.fn(), sendOrchestrationResponse });

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-42', 'worker');
    await vi.waitFor(() => expect(admission.markFailed).toHaveBeenCalledWith('admission-42', 'runtime closed'));
    expect(admission.markDelivered).not.toHaveBeenCalled();
    expect(output.some((message) => message.type === 'error'
      && message.content.includes('child-42')
      && message.content.includes('runtime closed'))).toBe(true);
  });

  it('holds a response refused on a usage limit for redelivery instead of failing it', async () => {
    admission.markDelivered.mockClear();
    admission.markFailed.mockClear();
    admission.requeueUndelivered.mockClear();
    const refusal = new Error('You have hit your usage limit.');
    const sendOrchestrationResponse = vi.fn(async () => { throw refusal; });
    const hold = vi.fn(() => true);
    const { manager, output } = setup({ sendInput: vi.fn(), sendOrchestrationResponse }, hold);

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-42', 'worker');
    await vi.waitFor(() => expect(admission.requeueUndelivered).toHaveBeenCalledOnce());
    expect(hold).toHaveBeenCalledWith('parent-1', expect.anything(), refusal);
    expect(admission.requeueUndelivered).toHaveBeenCalledWith('admission-42', expect.objectContaining({
      instanceId: 'parent-1', origin: 'orchestration', message: expect.stringContaining('child-42'),
    }), 'provider-limited');
    expect(admission.markFailed).not.toHaveBeenCalled();
    expect(admission.markDelivered).not.toHaveBeenCalled();
    expect(output.some((message) => message.type === 'error')).toBe(false);
    expect(output.some((message) => message.type === 'system'
      && message.metadata?.['providerLimitHeld'] === true
      && message.content.includes('child-42'))).toBe(true);
  });

  it('does not send a queued response once the session went limited behind it, and requeues it', async () => {
    admission.markFailed.mockClear();
    admission.requeueUndelivered.mockClear();
    let releaseFirst!: () => void;
    let limited = false;
    const sendOrchestrationResponse = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseFirst = resolve; }))
      .mockImplementation(async () => undefined);
    const { manager, output } = setup({ sendInput: vi.fn(), sendOrchestrationResponse }, () => false, () => limited);

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-1', 'worker');
    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-2', 'worker');
    await vi.waitFor(() => expect(sendOrchestrationResponse).toHaveBeenCalledTimes(1));
    limited = true; // the first delivery's refusal started a switch or park
    releaseFirst();

    await vi.waitFor(() => expect(admission.requeueUndelivered).toHaveBeenCalledOnce());
    expect(sendOrchestrationResponse).toHaveBeenCalledTimes(1);
    expect(admission.requeueUndelivered).toHaveBeenCalledWith('admission-42', expect.objectContaining({
      message: expect.stringContaining('child-2'),
    }), 'provider-limited');
    expect(admission.markFailed).not.toHaveBeenCalled();
    expect(output.some((message) => message.type === 'error')).toBe(false);
  });

  it('still fails a refused response the limit funnel did not take', async () => {
    admission.markFailed.mockClear();
    admission.requeueUndelivered.mockClear();
    const sendOrchestrationResponse = vi.fn(async () => { throw new Error('runtime closed'); });
    const { manager } = setup({ sendInput: vi.fn(), sendOrchestrationResponse }, () => false);

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-42', 'worker');
    await vi.waitFor(() => expect(admission.markFailed).toHaveBeenCalledWith('admission-42', 'runtime closed'));
    expect(admission.requeueUndelivered).not.toHaveBeenCalled();
  });

  it('requeues a response whose adapter was replaced before it was sent', async () => {
    admission.markFailed.mockClear();
    admission.requeueUndelivered.mockClear();
    let current: { sendInput: (message: string) => Promise<void>; sendOrchestrationResponse: () => Promise<void> } | undefined;
    let releaseFirst!: () => void;
    const first = {
      sendInput: vi.fn(async () => undefined),
      sendOrchestrationResponse: vi.fn(() => new Promise<void>((resolve) => { releaseFirst = resolve; })),
    };
    current = first;
    const parent = { id: 'parent-1', status: 'busy', displayName: 'parent', childrenIds: [], depth: 0 } as unknown as Instance;
    const output: OutputMessage[] = [];
    const hold = vi.fn(() => false);
    const manager = new InstanceOrchestrationManager({
      getInstance: () => parent,
      getInstanceCount: () => 1,
      createChildInstance: vi.fn(),
      sendInput: vi.fn(),
      terminateInstance: vi.fn(),
      getAdapter: () => current,
      recordTaskOutcome: vi.fn(),
      holdRejectedResponse: hold,
    });
    manager.setupOrchestrationHandlers(
      { maxTotalInstances: 0, maxChildrenPerParent: 0, allowNestedOrchestration: false, maxSpawnDepth: 0 },
      (_instance, message) => output.push(message),
      vi.fn(),
    );
    manager.registerInstance(parent.id, '/tmp', null);

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-1', 'worker');
    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-2', 'worker');
    await vi.waitFor(() => expect(first.sendOrchestrationResponse).toHaveBeenCalledTimes(1));
    current = { sendInput: vi.fn(async () => undefined), sendOrchestrationResponse: vi.fn(async () => undefined) };
    releaseFirst();

    await vi.waitFor(() => expect(admission.requeueUndelivered).toHaveBeenCalledOnce());
    expect(admission.requeueUndelivered).toHaveBeenCalledWith('admission-42', expect.objectContaining({
      message: expect.stringContaining('child-2'),
    }), 'respawning');
    expect(first.sendOrchestrationResponse).toHaveBeenCalledTimes(1);
    expect(admission.markFailed).not.toHaveBeenCalled();
    expect(output.some((message) => message.type === 'error')).toBe(false);
    expect(output.some((message) => message.content.includes('child-2') && message.content.includes('being restarted'))).toBe(true);
  });

  it('keeps the ordinary sendInput path for adapters without the Codex readiness method', async () => {
    admission.markDelivered.mockClear();
    const sendInput = vi.fn(async (_message: string) => undefined);
    const { manager } = setup({ sendInput });

    manager.getOrchestrationHandler().notifyChildSpawned('parent-1', 'child-42', 'worker');
    await vi.waitFor(() => expect(admission.markDelivered).toHaveBeenCalledWith('admission-42'));
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0]?.[0]).toContain('child-42');
  });
});
