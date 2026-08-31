import { beforeEach, describe, expect, it, vi } from 'vitest';

const consensusMocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

const automationMocks = vi.hoisted(() => ({
  createAutomationWithScheduling: vi.fn(),
}));

// Mock the logger before any imports that transitively pull in Electron's app.getPath
vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./consensus-coordinator', () => ({
  getConsensusCoordinator: () => ({
    query: consensusMocks.query,
  }),
}));

vi.mock('../automations/automation-create-service', () => ({
  createAutomationWithScheduling: automationMocks.createAutomationWithScheduling,
}));

const admissionMocks = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn<() => import('../session/session-admission-service').AdmissionOutcome>(
    () => ({ kind: 'admitted', admissionId: 'adm-default' }),
  ),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  registerRedeliveryHandler: vi.fn(),
}));

vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => admissionMocks,
}));

import { OrchestrationHandler } from './orchestration-handler';
import {
  CONSENSUS_INTENT_REMINDER,
  SCHEDULING_INTENT_REMINDER,
} from './orchestration-protocol';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';

function commandBlock(command: Record<string, unknown>): string {
  return [
    ':::ORCHESTRATOR_COMMAND:::',
    JSON.stringify(command),
    ':::END_COMMAND:::',
  ].join('\n');
}

function responseData(response: string): Record<string, unknown> {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON payload found in response: ${response}`);
  }
  return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
}

describe('OrchestrationHandler.getLaterTurnReminderIfRelevant', () => {
  it('returns the scheduling reminder for scheduling intent', () => {
    const orchestration = new OrchestrationHandler();

    expect(orchestration.getLaterTurnReminderIfRelevant('run this every morning'))
      .toBe(SCHEDULING_INTENT_REMINDER);
  });

  it('returns the consensus reminder for consensus-worthy intent', () => {
    const orchestration = new OrchestrationHandler();

    expect(orchestration.getLaterTurnReminderIfRelevant(
      'Run a consensus check on this high-risk migration',
    )).toBe(CONSENSUS_INTENT_REMINDER);
  });

  it('combines reminders in a stable order when both intents are present', () => {
    const orchestration = new OrchestrationHandler();

    expect(orchestration.getLaterTurnReminderIfRelevant(
      'Schedule this daily, but first run a consensus check on the risky decision',
    )).toBe(`${SCHEDULING_INTENT_REMINDER}\n\n${CONSENSUS_INTENT_REMINDER}`);
  });

  it('returns null for routine messages', () => {
    const orchestration = new OrchestrationHandler();

    expect(orchestration.getLaterTurnReminderIfRelevant('fix the failing test')).toBeNull();
  });
});

describe('OrchestrationHandler.processOutput (streaming markers)', () => {
  beforeEach(() => {
    consensusMocks.query.mockReset();
    automationMocks.createAutomationWithScheduling.mockReset();
    admissionMocks.admitAutomatedWrite.mockReset();
    admissionMocks.admitAutomatedWrite.mockReturnValue({ kind: 'admitted', admissionId: 'adm-default' });
    admissionMocks.markDelivered.mockClear();
    admissionMocks.markFailed.mockClear();
    admissionMocks.registerRedeliveryHandler.mockClear();
  });

  it('emits a user-action request when the marker block is split across chunks', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-1', '/tmp', null);

    const onUserAction = vi.fn();
    orchestration.on('user-action-request', onUserAction);

    const chunk1 = [
      'some assistant text',
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"request_user_action","requestType":"select_option","title":"Pick","message":"Choose one","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}',
      ''
    ].join('\n');

    const chunk2 = [':::END_COMMAND:::', 'more text'].join('\n');

    orchestration.processOutput('i-1', chunk1);
    expect(onUserAction).toHaveBeenCalledTimes(0);

    orchestration.processOutput('i-1', chunk2);
    expect(onUserAction).toHaveBeenCalledTimes(1);

    const pending = orchestration.getPendingUserActionsForInstance('i-1');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestType).toBe('select_option');
    expect(pending[0]?.options?.map((o) => o.id)).toEqual(['a', 'b']);
  });

  it('handles the start marker itself being split across chunks', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-2', '/tmp', null);

    const onUserAction = vi.fn();
    orchestration.on('user-action-request', onUserAction);

    // Split the start marker across chunks to ensure buffering keeps enough tail.
    const chunk1 = '...:::ORCHESTRATOR_COM';
    const chunk2 = [
      'MAND:::',
      '{"action":"request_user_action","requestType":"confirm","title":"Confirm","message":"Proceed?"}',
      ':::END_COMMAND:::'
    ].join('\n');

    orchestration.processOutput('i-2', chunk1);
    orchestration.processOutput('i-2', chunk2);

    expect(onUserAction).toHaveBeenCalledTimes(1);
    const pending = orchestration.getPendingUserActionsForInstance('i-2');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestType).toBe('confirm');
    expect(pending[0]?.title).toBe('Confirm');
  });

  it('rejects malformed ask_questions commands without questions', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-3', '/tmp', null);

    const onUserAction = vi.fn();
    orchestration.on('user-action-request', onUserAction);

    const malformed = [
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"request_user_action","requestType":"ask_questions","title":"Clarify","message":"Please answer:"}',
      ':::END_COMMAND:::',
    ].join('\n');

    orchestration.processOutput('i-3', malformed);

    expect(onUserAction).toHaveBeenCalledTimes(0);
    expect(orchestration.getPendingUserActionsForInstance('i-3')).toHaveLength(0);
  });

  it('accepts valid ask_questions commands with explicit questions', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-4', '/tmp', null);

    const onUserAction = vi.fn();
    orchestration.on('user-action-request', onUserAction);

    const valid = [
      ':::ORCHESTRATOR_COMMAND:::',
      '{"action":"request_user_action","requestType":"ask_questions","title":"Clarify","message":"Please answer:","questions":["Which panel first?","Do you prefer tabs or sections?"]}',
      ':::END_COMMAND:::',
    ].join('\n');

    orchestration.processOutput('i-4', valid);

    expect(onUserAction).toHaveBeenCalledTimes(1);
    const pending = orchestration.getPendingUserActionsForInstance('i-4');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestType).toBe('ask_questions');
    expect(pending[0]?.questions).toEqual([
      'Which panel first?',
      'Do you prefer tabs or sections?',
    ]);
  });

  it('suppresses a user-action response when session admission reports the instance is blocked', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-blocked', '/tmp', null);
    orchestration.processOutput('i-blocked', commandBlock({
      action: 'request_user_action',
      requestType: 'confirm',
      title: 'Continue?',
      message: 'Approve this action?',
    }));
    const request = orchestration.getPendingUserActionsForInstance('i-blocked')[0];
    const injectedResponses: string[] = [];
    orchestration.on('inject-response', (_instanceId, response) => {
      injectedResponses.push(response);
    });
    admissionMocks.admitAutomatedWrite.mockReturnValueOnce({
      kind: 'suppressed',
      reason: 'awaiting-human',
      admissionId: 'adm-user-action-blocked',
    });

    orchestration.respondToUserAction(request.id, true);

    expect(admissionMocks.admitAutomatedWrite).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'i-blocked',
      origin: 'orchestration',
      sourceMetadata: expect.objectContaining({
        action: 'user_action_response',
        success: true,
      }),
    }));
    expect(injectedResponses).toEqual([]);
  });

  it('registers orchestration responses for redelivery after a blocked instance becomes ready', () => {
    new OrchestrationHandler();

    expect(admissionMocks.registerRedeliveryHandler).toHaveBeenCalledWith(
      'orchestration',
      expect.any(Function),
    );
  });

  it('reports in-flight consensus queries through active work and get_children', async () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-5', '/tmp', null);

    const injectedResponses: string[] = [];
    orchestration.on('inject-response', (_instanceId, response) => {
      injectedResponses.push(response);
    });
    orchestration.on('get-children', (_parentId, callback) => {
      callback([]);
    });

    let resolveQuery!: (value: unknown) => void;
    const queryPromise = new Promise((resolve) => {
      resolveQuery = resolve;
    });
    consensusMocks.query.mockReturnValueOnce(queryPromise);

    orchestration.processOutput('i-5', commandBlock({
      action: 'consensus_query',
      question: 'Should we use this implementation?',
      providers: ['gemini', 'copilot'],
    }));

    expect(orchestration.hasActiveWork('i-5')).toBe(true);

    orchestration.processOutput('i-5', commandBlock({ action: 'get_children' }));

    const getChildrenResponse = injectedResponses.find((response) =>
      response.includes('Action: get_children')
    );
    expect(getChildrenResponse).toBeDefined();
    expect(responseData(getChildrenResponse!)).toMatchObject({
      children: [],
      completedChildIds: [],
      activeConsensusQueries: 1,
    });

    resolveQuery({
      consensus: 'Use the implementation with the noted safeguards.',
      agreement: 1,
      responses: [
        {
          provider: 'gemini',
          content: 'Use it.',
          success: true,
          durationMs: 10,
        },
      ],
      dissent: [],
      edgeCases: [],
      totalDurationMs: 10,
      totalEstimatedCost: 0,
      successCount: 1,
      failureCount: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(orchestration.hasActiveWork('i-5')).toBe(false);
    const consensusResponses = injectedResponses.filter((response) =>
      response.includes('Action: consensus_query')
    );
    expect(responseData(consensusResponses.at(-1)!)).toMatchObject({
      status: 'complete',
      activeConsensusQueries: 0,
      successCount: 1,
      failureCount: 0,
    });
    expect(admissionMocks.markDelivered).toHaveBeenCalledWith('adm-default');
  });

  describe('SessionAdmissionService gating on consensus completion (A5)', () => {
    it('registers a redelivery handler for the consensus origin on construction', () => {
      new OrchestrationHandler();
      expect(admissionMocks.registerRedeliveryHandler).toHaveBeenCalledWith('consensus', expect.any(Function));
    });

    it('suppresses the completion write-back when admission denies it, and does not emit inject-response', async () => {
      const orchestration = new OrchestrationHandler();
      orchestration.registerInstance('i-6', '/tmp', null);

      const injectedResponses: string[] = [];
      orchestration.on('inject-response', (_instanceId, response) => {
        injectedResponses.push(response);
      });

      // The initial 'dispatching' ack is NOT gated (it is part of the current
      // turn's own tool-call handling); only the async completion write-back
      // (injectConsensusResult) calls admitAutomatedWrite, so this mock only
      // ever observes that one call.
      admissionMocks.admitAutomatedWrite.mockReturnValue({
        kind: 'suppressed',
        reason: 'awaiting-human',
        admissionId: 'adm-blocked',
      });

      consensusMocks.query.mockResolvedValueOnce({
        consensus: 'Use the implementation with the noted safeguards.',
        agreement: 1,
        responses: [{ provider: 'gemini', content: 'Use it.', success: true, durationMs: 10 }],
        dissent: [],
        edgeCases: [],
        totalDurationMs: 10,
        totalEstimatedCost: 0,
        successCount: 1,
        failureCount: 0,
      });

      orchestration.processOutput('i-6', commandBlock({
        action: 'consensus_query',
        question: 'Should we use this implementation?',
        providers: ['gemini'],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      const completionResponses = injectedResponses.filter((response) =>
        response.includes('Action: consensus_query') && response.includes('"status":"complete"'),
      );
      expect(completionResponses).toHaveLength(0);
      expect(admissionMocks.markDelivered).not.toHaveBeenCalledWith('adm-blocked');
    });

    it('the registered redelivery handler re-injects the stored consensus response', () => {
      const orchestration = new OrchestrationHandler();
      const injectedResponses: { instanceId: string; response: string }[] = [];
      orchestration.on('inject-response', (instanceId: string, response: string) => {
        injectedResponses.push({ instanceId, response });
      });

      const handler = admissionMocks.registerRedeliveryHandler.mock.calls.at(-1)![1] as (ctx: {
        admissionId: string;
        instanceId: string;
        sourceMetadata?: Record<string, unknown>;
      }) => void;

      handler({
        admissionId: 'adm-blocked',
        instanceId: 'i-6',
        sourceMetadata: { success: true, data: { status: 'complete', message: 'done' } },
      });

      expect(injectedResponses).toHaveLength(1);
      expect(injectedResponses[0].instanceId).toBe('i-6');
      expect(admissionMocks.markDelivered).toHaveBeenCalledWith('adm-blocked');
    });
  });

  it('creates a native automation from an orchestration command', async () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-auto', '/repo/current', null);

    const injectedResponses: string[] = [];
    orchestration.on('inject-response', (_instanceId, response) => {
      injectedResponses.push(response);
    });

    automationMocks.createAutomationWithScheduling.mockResolvedValueOnce({
      id: 'automation-1',
      name: 'Daily repo check',
      enabled: true,
      active: true,
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: {
        prompt: 'Check the repo status and summarize issues.',
        workingDirectory: '/repo/current',
        provider: 'claude',
        model: CLAUDE_MODELS.OPUS_1M,
      },
      nextFireAt: 1_000,
      lastFiredAt: null,
      lastRunId: null,
      createdAt: 100,
      updatedAt: 100,
      unreadRunCount: 0,
    });

    orchestration.processOutput('i-auto', commandBlock({
      action: 'create_automation',
      automation: {
        name: 'Daily repo check',
        schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
        missedRunPolicy: 'notify',
        concurrencyPolicy: 'skip',
        action: {
          prompt: 'Check the repo status and summarize issues.',
          provider: 'auto',
        },
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(automationMocks.createAutomationWithScheduling).toHaveBeenCalledWith({
      name: 'Daily repo check',
      schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: { kind: 'newInstance' },
      action: {
        prompt: 'Check the repo status and summarize issues.',
        workingDirectory: '/repo/current',
        provider: 'claude',
        model: CLAUDE_MODELS.OPUS_1M,
      },
    });

    const response = injectedResponses.find((item) => item.includes('Action: create_automation'));
    expect(response).toBeDefined();
    expect(responseData(response!)).toMatchObject({
      automationId: 'automation-1',
      message: 'Saved automation "Daily repo check".',
    });
  });
});

describe('OrchestrationHandler.reconcileChildrenAfterRestart', () => {
  it('returns null when the parent has no orchestration context', () => {
    const orchestration = new OrchestrationHandler();

    expect(orchestration.reconcileChildrenAfterRestart('missing', () => true)).toBeNull();
  });

  it('drops dead children, keeps live ones, and preserves dropped ids as completed', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('parent-1', '/tmp', null);
    orchestration.addChild('parent-1', 'child-live');
    orchestration.addChild('parent-1', 'child-dead');

    const result = orchestration.reconcileChildrenAfterRestart(
      'parent-1',
      (childId) => childId === 'child-live',
    );

    expect(result).toEqual({ kept: ['child-live'], dropped: ['child-dead'] });
    // Live child still owned; dead child moved to the completed set so
    // post-hoc summary queries keep resolving.
    expect(orchestration.isChildOfParent('parent-1', 'child-live')).toBe(true);
    expect(orchestration.isChildOfParent('parent-1', 'child-dead')).toBe(true);
    expect(orchestration.getCompletedChildIds('parent-1')).toEqual(['child-dead']);
    expect(orchestration.hasActiveWork('parent-1')).toBe(true);
  });

  it('is a no-op when every child is alive', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('parent-2', '/tmp', null);
    orchestration.addChild('parent-2', 'child-a');
    orchestration.addChild('parent-2', 'child-b');

    const result = orchestration.reconcileChildrenAfterRestart('parent-2', () => true);

    expect(result).toEqual({ kept: ['child-a', 'child-b'], dropped: [] });
    expect(orchestration.getCompletedChildIds('parent-2')).toEqual([]);
  });

  it('clears active work when all children are dead', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('parent-3', '/tmp', null);
    orchestration.addChild('parent-3', 'child-x');

    const result = orchestration.reconcileChildrenAfterRestart('parent-3', () => false);

    expect(result).toEqual({ kept: [], dropped: ['child-x'] });
    expect(orchestration.hasActiveWork('parent-3')).toBe(false);
  });

  it('reports a child reaped while its completion response was suppressed', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('parent-restarting', '/tmp', null);
    orchestration.addChild('parent-restarting', 'child-reaped');
    admissionMocks.admitAutomatedWrite.mockReturnValueOnce({
      kind: 'suppressed',
      reason: 'respawning',
      admissionId: 'adm-child-reaped',
    });

    orchestration.notifyChildTerminated('parent-restarting', 'child-reaped');
    const result = orchestration.reconcileChildrenAfterRestart(
      'parent-restarting',
      () => true,
    );

    expect(result).toEqual({ kept: [], dropped: ['child-reaped'] });
    expect(admissionMocks.markFailed).toHaveBeenCalledWith(
      'adm-child-reaped',
      'Child completion represented by fresh-fallback degradation notice',
    );
    expect(orchestration.reconcileChildrenAfterRestart('parent-restarting', () => true))
      .toEqual({ kept: [], dropped: [] });
  });

  it('does not classify an ordinary awaiting-human suppression as restart-window loss', () => {
    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('parent-awaiting-human', '/tmp', null);
    orchestration.addChild('parent-awaiting-human', 'child-completed');
    admissionMocks.admitAutomatedWrite.mockReturnValueOnce({
      kind: 'suppressed',
      reason: 'awaiting-human',
      admissionId: 'adm-child-awaiting-human',
    });

    orchestration.notifyChildTerminated('parent-awaiting-human', 'child-completed');

    expect(orchestration.reconcileChildrenAfterRestart('parent-awaiting-human', () => true))
      .toEqual({ kept: [], dropped: [] });
    expect(admissionMocks.markFailed).not.toHaveBeenCalledWith(
      'adm-child-awaiting-human',
      expect.any(String),
    );
  });
});
