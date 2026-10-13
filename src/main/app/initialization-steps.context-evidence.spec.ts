import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/aio-context-evidence-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import {
  createContextEvidenceInitializationStep,
  createInitializationSteps,
  createWindowAndStartEvidenceMaintenance,
} from './initialization-steps';

describe('context evidence initialization', () => {
  it('initializes and awaits the fail-closed evidence runtime readiness', async () => {
    const initialize = vi.fn(async () => undefined);
    const step = createContextEvidenceInitializationStep(initialize);

    await step.fn();

    expect(step.name).toBe('Context evidence');
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('starts maintenance only after the loaded window and readiness marker', async () => {
    let loaded!: () => void;
    const window = new Promise<void>((resolve) => { loaded = resolve; });
    const order: string[] = [];
    const start = vi.fn(() => { order.push('maintenance'); });
    const pending = createWindowAndStartEvidenceMaintenance(
      () => window, () => { order.push('ready'); }, false, start,
    );
    expect(start).not.toHaveBeenCalled();
    loaded();
    await pending;
    expect(start).toHaveBeenCalledOnce();
    expect(order).toEqual(['ready', 'maintenance']);
  });

  it('skips background work in the self-quitting packaged smoke', async () => {
    const start = vi.fn();
    await createWindowAndStartEvidenceMaintenance(async () => undefined, () => undefined, true, start);
    expect(start).not.toHaveBeenCalled();
  });

  it('orders context evidence after the conversation ledger and before restoration services', () => {
    const steps = createInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const names = steps.map((step) => step.name);
    const evidenceIndex = names.indexOf('Context evidence');

    expect(evidenceIndex).toBe(names.indexOf('Conversation ledger') + 1);
    expect(evidenceIndex).toBeLessThan(names.indexOf('Chat service'));
  });

});
