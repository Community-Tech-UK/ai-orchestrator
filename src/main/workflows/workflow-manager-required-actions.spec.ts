import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowTemplate } from '../../shared/types/workflow.types';
import { WorkflowManager, _resetWorkflowManagerForTesting } from './workflow-manager';

const template: WorkflowTemplate = {
  id: 'required-action-test',
  name: 'Required action test',
  description: '',
  icon: '*',
  category: 'development',
  triggerPatterns: [],
  autoTrigger: false,
  phases: [{
    id: 'work',
    name: 'Work',
    description: '',
    order: 0,
    systemPromptAddition: 'Do the work.',
    gateType: 'completion',
    requiredActions: ['analysis_done'],
    agents: {
      count: 1,
      agentType: 'reviewer',
      prompts: ['Analyze the code.'],
      parallel: false,
    },
  }],
  estimatedDuration: '1m',
  requiredAgents: [],
};

describe('WorkflowManager required-action protocol', () => {
  let manager: WorkflowManager;

  beforeEach(() => {
    _resetWorkflowManagerForTesting();
    manager = WorkflowManager.getInstance();
    manager.registerTemplate(template);
  });

  it('teaches agents the exact own-line marker for each required action', async () => {
    let prompt = '';
    manager.on('workflow:invoke-agent', (payload: { prompt: string; callback: (response: string, tokens: number) => void }) => {
      prompt = payload.prompt;
      payload.callback('analysis complete', 1);
    });
    const completed = new Promise<void>((resolve) => manager.once('workflow:agents-completed', () => resolve()));

    const execution = manager.startWorkflow('instance-1', template.id);
    await completed;

    expect(prompt).toContain('[[WORKFLOW_ACTION:analysis_done]]');
    expect(manager.getSystemPromptAddition(execution.id)).toContain('[[WORKFLOW_ACTION:analysis_done]]');
  });

  it('does not satisfy completion gates from a loose substring match', async () => {
    const execution = manager.startWorkflow('instance-2', template.id);
    await manager.completePhase(execution.id, {
      agentResults: [{
        agentId: 'agent-1',
        prompt: '',
        response: 'The analysis_done work is mentioned but not certified.',
        duration: 1,
        tokens: 1,
      }],
    });

    expect(manager.getExecution(execution.id)?.pendingGate?.gateType).toBe('completion');
  });

  it('accepts the exact marker only when it appears on its own line', async () => {
    const execution = manager.startWorkflow('instance-3', template.id);
    await manager.completePhase(execution.id, {
      agentResults: [{
        agentId: 'agent-1',
        prompt: '',
        response: 'Evidence recorded.\n[[WORKFLOW_ACTION:analysis_done]]\nFinished.',
        duration: 1,
        tokens: 1,
      }],
    });

    expect(manager.getExecution(execution.id)?.completedAt).toBeDefined();
  });
});
