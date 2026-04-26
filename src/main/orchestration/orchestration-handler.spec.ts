import { beforeEach, describe, expect, it, vi } from 'vitest';

const consensusMocks = vi.hoisted(() => ({
  query: vi.fn(),
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

import { OrchestrationHandler } from './orchestration-handler';

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

describe('OrchestrationHandler.processOutput (streaming markers)', () => {
  beforeEach(() => {
    consensusMocks.query.mockReset();
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
  });
});
