import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import type { WorkflowExecution } from '../../../shared/types/workflow.types.js';
import { WorkflowManager, _resetWorkflowManagerForTesting } from '../workflow-manager';

const TEMPLATE_ID = 'restore-template';
const INSTANCE_ID = 'instance-restore';

function registerTemplate(manager: WorkflowManager): void {
  manager.registerTemplate({
    id: TEMPLATE_ID,
    name: 'Restore Template',
    description: 'Template used for restoration tests',
    phases: [
      {
        id: 'phase-1',
        name: 'Phase 1',
        order: 1,
        description: 'First phase',
        gateType: 'none',
        systemPromptAddition: '',
      },
    ],
  });
}

function makeExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    id: 'exec-restored',
    instanceId: INSTANCE_ID,
    templateId: TEMPLATE_ID,
    currentPhaseId: 'phase-1',
    phaseStatuses: { 'phase-1': 'active' },
    phaseData: {},
    startedAt: 1_712_200_000_000,
    agentInvocations: 0,
    totalTokens: 0,
    totalCost: 0,
    ...overrides,
  };
}

describe('WorkflowManager persistence restoration', () => {
  beforeEach(() => {
    _resetWorkflowManagerForTesting();
  });

  it('restores active executions into the in-memory indexes when persistence is attached', () => {
    const manager = WorkflowManager.getInstance();
    registerTemplate(manager);

    const restored = makeExecution();
    const persistence = {
      loadActive: vi.fn().mockReturnValue([restored]),
      save: vi.fn(),
    };

    manager.setPersistence(persistence as never);

    expect(persistence.loadActive).toHaveBeenCalledTimes(1);
    expect(manager.getExecution(restored.id)).toEqual(restored);
    expect(manager.getExecutionByInstance(restored.instanceId)?.id).toBe(restored.id);
    expect(manager.getActiveExecutions().map((execution) => execution.id)).toContain(restored.id);
  });

  it('does not overwrite a live in-memory execution when persisted state is older', () => {
    const manager = WorkflowManager.getInstance();
    registerTemplate(manager);

    const liveExecution = manager.startWorkflow(INSTANCE_ID, TEMPLATE_ID);
    const restored = makeExecution({
      id: 'exec-older',
      startedAt: liveExecution.startedAt - 1000,
    });
    const persistence = {
      loadActive: vi.fn().mockReturnValue([restored]),
      save: vi.fn(),
    };

    manager.setPersistence(persistence as never);

    expect(manager.getExecutionByInstance(INSTANCE_ID)?.id).toBe(liveExecution.id);
    expect(manager.getExecution(restored.id)).toBeUndefined();
  });
});
