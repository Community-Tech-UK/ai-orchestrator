import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import type { WorkflowTemplate } from '../../../shared/types/workflow.types';
import {
  WorkflowManager,
  WorkflowTransitionDenied,
  _resetWorkflowManagerForTesting,
} from '../workflow-manager';

const dummyTemplate = (
  id: string,
  category: WorkflowTemplate['category'] = 'review',
): WorkflowTemplate => ({
  id,
  name: id,
  description: '',
  icon: '*',
  category,
  triggerPatterns: [],
  autoTrigger: false,
  phases: [
    {
      id: 'p1',
      name: 'P1',
      description: '',
      order: 0,
      systemPromptAddition: '',
      gateType: 'none',
    },
  ],
  estimatedDuration: '5m',
  requiredAgents: [],
});

describe('WorkflowManager transition policy integration', () => {
  let manager: WorkflowManager;

  beforeEach(() => {
    _resetWorkflowManagerForTesting();
    manager = WorkflowManager.getInstance();
    manager.registerTemplate(dummyTemplate('a-review', 'review'));
    manager.registerTemplate(dummyTemplate('b-review', 'review'));
    manager.registerTemplate(dummyTemplate('c-debug', 'debugging'));
  });

  it('starts when there is no active workflow', () => {
    const execution = manager.startWorkflow('inst-1', 'a-review', 'manual-ui');

    expect(execution.templateId).toBe('a-review');
  });

  it('auto-completes same-category current workflow before starting the requested one', () => {
    const prior = manager.startWorkflow('inst-1', 'a-review', 'manual-ui');
    const next = manager.startWorkflow('inst-1', 'b-review', 'manual-ui');

    expect(next.templateId).toBe('b-review');
    expect(manager.getExecution(prior.id)?.completedAt).toBeDefined();
    expect(manager.getExecution(prior.id)?.transitionAutoCompletion).toEqual({
      reason: 'superseded',
      supersededBy: 'b-review',
    });
  });

  it('throws WorkflowTransitionDenied for nl-suggestion while a gate is pending', () => {
    const prior = manager.startWorkflow('inst-1', 'a-review', 'manual-ui');
    const active = manager.getExecution(prior.id);
    active!.pendingGate = {
      phaseId: 'p1',
      gateType: 'user_confirmation',
      gatePrompt: '?',
      submittedAt: Date.now(),
    };

    expect(() => manager.startWorkflow('inst-1', 'b-review', 'nl-suggestion'))
      .toThrowError(WorkflowTransitionDenied);
  });

  it('allows compatible cross-category overlap without auto-completing the prior workflow', () => {
    const prior = manager.startWorkflow('inst-1', 'a-review', 'manual-ui');
    const next = manager.startWorkflow('inst-1', 'c-debug', 'manual-ui');

    expect(next.templateId).toBe('c-debug');
    expect(manager.getExecution(prior.id)?.completedAt).toBeUndefined();
  });

  it('denies automation source on same-category overlap', () => {
    manager.startWorkflow('inst-1', 'a-review', 'manual-ui');

    expect(() => manager.startWorkflow('inst-1', 'b-review', 'automation'))
      .toThrowError(WorkflowTransitionDenied);
  });
});
