import { describe, expect, it } from 'vitest';

import { classifyOverlap, evaluateTransition } from '../workflow-transition-policy';
import type {
  WorkflowExecution,
  WorkflowStartSource,
  WorkflowTemplate,
} from '../../../shared/types/workflow.types';

const makeTemplate = (
  id: string,
  category: WorkflowTemplate['category'] = 'review',
  name = id,
): WorkflowTemplate => ({
  id,
  name,
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

const makeExecution = (
  templateId: string,
  opts: Partial<WorkflowExecution> = {},
): WorkflowExecution => ({
  id: `wf-${templateId}`,
  instanceId: 'inst-1',
  templateId,
  currentPhaseId: 'p1',
  phaseStatuses: { p1: 'active' },
  phaseData: {},
  startedAt: Date.now(),
  agentInvocations: 0,
  totalTokens: 0,
  totalCost: 0,
  ...opts,
});

const inputs = (
  current: { execution: WorkflowExecution; template: WorkflowTemplate } | null,
  requestedTemplate: WorkflowTemplate,
  source: WorkflowStartSource = 'manual-ui',
) => ({
  current,
  requested: { template: requestedTemplate, instanceId: 'inst-1' },
  source,
});

describe('evaluateTransition', () => {
  it('allows start when no workflow is active', () => {
    expect(evaluateTransition(inputs(null, makeTemplate('a')))).toEqual({ kind: 'allow' });
  });

  it('denies self-overlap on the same template', () => {
    const template = makeTemplate('a');
    const result = evaluateTransition(inputs(
      { execution: makeExecution('a'), template },
      template,
    ));

    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.reason).toMatch(/already active/i);
    }
  });

  it('allows start when the current execution is already completed', () => {
    const template = makeTemplate('a');

    expect(evaluateTransition(inputs(
      { execution: makeExecution('a', { completedAt: Date.now() }), template },
      makeTemplate('b'),
    ))).toEqual({ kind: 'allow' });
  });

  it('denies nl-suggestion while the active execution is pending a gate', () => {
    const template = makeTemplate('a');
    const result = evaluateTransition(inputs(
      {
        execution: makeExecution('a', {
          pendingGate: {
            phaseId: 'p1',
            gateType: 'user_confirmation',
            gatePrompt: 'Continue?',
            submittedAt: Date.now(),
          },
        }),
        template,
      },
      makeTemplate('b'),
      'nl-suggestion',
    ));

    expect(result.kind).toBe('deny');
  });

  it('auto-completes sibling category workflows', () => {
    const current = makeTemplate('a', 'review');
    const requested = makeTemplate('b', 'review');

    expect(evaluateTransition(inputs(
      { execution: makeExecution('a'), template: current },
      requested,
    ))).toEqual({ kind: 'autoCompleteCurrent' });
  });

  it('allows compatible cross-category overlap', () => {
    const current = makeTemplate('a', 'review');
    const requested = makeTemplate('b', 'debugging');

    expect(evaluateTransition(inputs(
      { execution: makeExecution('a'), template: current },
      requested,
    ))).toEqual({ kind: 'allowWithOverlap', maxConcurrent: 2 });
  });

  it('always allows restore starts', () => {
    const current = makeTemplate('a', 'review');
    const requested = makeTemplate('b', 'review');

    expect(evaluateTransition(inputs(
      { execution: makeExecution('a'), template: current },
      requested,
      'restore',
    ))).toEqual({ kind: 'allow' });
  });

  it('does not auto-complete from automation source', () => {
    const current = makeTemplate('a', 'review');
    const requested = makeTemplate('b', 'review');
    const result = evaluateTransition(inputs(
      { execution: makeExecution('a'), template: current },
      requested,
      'automation',
    ));

    expect(result.kind === 'allow' || result.kind === 'deny').toBe(true);
    expect(result.kind).not.toBe('autoCompleteCurrent');
  });

  it('classifies null current as no-overlap', () => {
    expect(classifyOverlap(inputs(null, makeTemplate('a')))).toBe('no-overlap');
  });

  it('classifies sibling categories as superseding', () => {
    const current = makeTemplate('a', 'review');
    const requested = makeTemplate('b', 'review');

    expect(classifyOverlap(inputs(
      { execution: makeExecution('a'), template: current },
      requested,
    ))).toBe('superseding');
  });
});
