import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../../../../preload/generated/channels';
import { createOrchestrationDomain } from '../../../../../preload/domains/orchestration.preload';
import { ElectronIpcService } from './electron-ipc.service';
import { OrchestrationIpcService } from './orchestration-ipc.service';

describe('OrchestrationIpcService payloads through preload', () => {
  function createService() {
    const invoke = vi.fn(async () => ({ success: true, data: null }));
    const api = createOrchestrationDomain(
      { invoke } as unknown as Parameters<typeof createOrchestrationDomain>[0],
      IPC_CHANNELS,
    );
    const base = {
      getApi: () => api,
      invoke: (channel: string, payload?: unknown) => {
        const method = channel.split(/[:-]/).map((part, index) =>
          index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)
        ).join('') as keyof typeof api;
        return (api[method] as (value?: unknown) => Promise<unknown>)(payload);
      },
    };
    TestBed.configureTestingModule({
      providers: [OrchestrationIpcService, { provide: ElectronIpcService, useValue: base }],
    });
    return { service: TestBed.inject(OrchestrationIpcService), invoke };
  }

  it.each([
    ['workflow template', (service: OrchestrationIpcService) => service.workflowGetTemplate('template-1'), IPC_CHANNELS.WORKFLOW_GET_TEMPLATE, { templateId: 'template-1' }],
    ['workflow execution', (service: OrchestrationIpcService) => service.workflowGetExecution('execution-1'), IPC_CHANNELS.WORKFLOW_GET_EXECUTION, { executionId: 'execution-1' }],
    ['workflow by instance', (service: OrchestrationIpcService) => service.workflowGetByInstance('instance-1'), IPC_CHANNELS.WORKFLOW_GET_BY_INSTANCE, { instanceId: 'instance-1' }],
    ['workflow phase', (service: OrchestrationIpcService) => service.workflowCompletePhase('execution-1', 'phase-1'), IPC_CHANNELS.WORKFLOW_COMPLETE_PHASE, { executionId: 'execution-1', phaseData: { phaseId: 'phase-1' } }],
    ['workflow gate', (service: OrchestrationIpcService) => service.workflowSatisfyGate('execution-1', { approved: true }), IPC_CHANNELS.WORKFLOW_SATISFY_GATE, { executionId: 'execution-1', response: { approved: true } }],
    ['workflow skip', (service: OrchestrationIpcService) => service.workflowSkipPhase('execution-1'), IPC_CHANNELS.WORKFLOW_SKIP_PHASE, { executionId: 'execution-1' }],
    ['workflow cancel', (service: OrchestrationIpcService) => service.workflowCancel('execution-1'), IPC_CHANNELS.WORKFLOW_CANCEL, { executionId: 'execution-1' }],
    ['workflow prompt', (service: OrchestrationIpcService) => service.workflowGetPromptAddition('execution-1'), IPC_CHANNELS.WORKFLOW_GET_PROMPT_ADDITION, { executionId: 'execution-1' }],
    ['review agent', (service: OrchestrationIpcService) => service.reviewGetAgent('agent-1'), IPC_CHANNELS.REVIEW_GET_AGENT, { agentId: 'agent-1' }],
    ['review session', (service: OrchestrationIpcService) => service.reviewGetSession('session-1'), IPC_CHANNELS.REVIEW_GET_SESSION, { sessionId: 'session-1' }],
    ['review issues', (service: OrchestrationIpcService) => service.reviewGetIssues({ sessionId: 'session-1', severity: 'high' }), IPC_CHANNELS.REVIEW_GET_ISSUES, { sessionId: 'session-1', severity: 'high' }],
    ['review acknowledgement', (service: OrchestrationIpcService) => service.reviewAcknowledgeIssue('session-1', 'issue-1', true), IPC_CHANNELS.REVIEW_ACKNOWLEDGE_ISSUE, { sessionId: 'session-1', issueId: 'issue-1', acknowledged: true }],
    ['skill discovery', (service: OrchestrationIpcService) => service.skillsDiscover(['/skills']), IPC_CHANNELS.SKILLS_DISCOVER, { searchPaths: ['/skills'] }],
    ['skill match', (service: OrchestrationIpcService) => service.skillsMatch('design'), IPC_CHANNELS.SKILLS_MATCH, { text: 'design' }],
    ['skill control', (service: OrchestrationIpcService) => service.skillsSetControl('design', 'enabled'), IPC_CHANNELS.SKILLS_SET_CONTROL, { skillName: 'design', mode: 'enabled', reason: undefined }],
    ['skill reference', (service: OrchestrationIpcService) => service.skillsLoadReference('design', 'ref.md'), IPC_CHANNELS.SKILLS_LOAD_REFERENCE, { skillId: 'design', referencePath: 'ref.md' }],
    ['skill example', (service: OrchestrationIpcService) => service.skillsLoadExample('design', 'example.md'), IPC_CHANNELS.SKILLS_LOAD_EXAMPLE, { skillId: 'design', examplePath: 'example.md' }],
    ['skill health', (service: OrchestrationIpcService) => service.skillsHealthSummary(42), IPC_CHANNELS.SKILLS_HEALTH_SUMMARY, { since: 42 }],
    ['supervision tree', (service: OrchestrationIpcService) => service.supervisionGetTree('root-1'), IPC_CHANNELS.SUPERVISION_GET_TREE, { rootInstanceId: 'root-1' }],
  ] as const)('preserves %s payload', async (_name, call, channel, payload) => {
    const { service, invoke } = createService();
    await call(service);
    expect(invoke).toHaveBeenCalledWith(channel, payload);
  });
});
