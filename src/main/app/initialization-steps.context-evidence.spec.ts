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
} from './initialization-steps';

describe('context evidence initialization', () => {
  it('initializes the fail-closed evidence runtime and awaits its startup sweep', async () => {
    const initialize = vi.fn(async () => undefined);
    const step = createContextEvidenceInitializationStep(initialize);

    await step.fn();

    expect(step.name).toBe('Context evidence');
    expect(initialize).toHaveBeenCalledOnce();
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
