import { describe, expect, it, vi } from 'vitest';

import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';

const admission = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn(() => ({ kind: 'admitted' as const, admissionId: 'admission-42' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
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

function setup(adapter: { sendInput: (message: string) => Promise<void>; sendOrchestrationResponse?: (message: string, onDelayed?: () => void) => Promise<void> }) {
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
