import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleUnifiedMemoryWorkerRequest,
  type UnifiedMemoryWorkerRequestController,
} from './unified-memory-worker-request-handler';
import type { UnifiedMemoryWorkerRequest } from './unified-memory-worker-port';

const retrieval = {
  shortTerm: ['current'],
  longTerm: ['durable'],
  procedural: ['workflow'],
  skills: [],
  totalTokens: 12,
};
const workflow = {
  id: 'workflow-1',
  name: 'Worker flow',
  steps: ['validate', 'invoke'],
  successRate: 0.75,
  applicableContexts: ['memory'],
};
const strategy = {
  id: 'strategy-1',
  strategy: 'Use typed RPC',
  conditions: ['memory request'],
  outcomes: [{ taskId: 'task-1', success: true, score: 1, timestamp: 1 }],
};
const stats = {
  shortTermTokens: 10,
  longTermEntries: 2,
  episodicSessions: 1,
  learnedPatterns: 1,
  workflows: 1,
  strategies: 1,
};
const sessions = [{
  sessionId: 'session-1', summary: 'Done', keyEvents: [], outcome: 'success' as const,
  lessonsLearned: [], timestamp: 1,
}];
const patterns = [{
  id: 'pattern-1', pattern: 'typed boundary', successRate: 0.9,
  usageCount: 2, contexts: ['memory'],
}];
const snapshot = {
  version: '1.0', timestamp: 1,
  shortTerm: { buffer: [], summaries: [] },
  episodic: { sessions, patterns },
  procedural: { workflows: [workflow], strategies: [strategy] },
};

function createController(): UnifiedMemoryWorkerRequestController {
  return {
    processInput: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue(retrieval),
    recordSessionEnd: vi.fn().mockResolvedValue(undefined),
    recordWorkflow: vi.fn().mockResolvedValue(workflow),
    recordStrategy: vi.fn().mockResolvedValue(strategy),
    recordTaskOutcome: vi.fn(),
    getStats: vi.fn(() => stats),
    getSessionHistory: vi.fn(() => sessions),
    getPatterns: vi.fn(() => patterns),
    getWorkflows: vi.fn(() => [workflow]),
    save: vi.fn().mockResolvedValue(snapshot),
    load: vi.fn().mockResolvedValue(undefined),
    configure: vi.fn(),
  };
}

const cases = [
  {
    request: { kind: 'process-input', input: 'remember', sessionId: 'session-1', taskId: 'task-1' },
    method: 'processInput', args: ['remember', 'session-1', 'task-1'], expected: undefined,
  },
  {
    request: { kind: 'retrieve', query: 'find it', taskId: 'task-1', options: { maxTokens: 500 } },
    method: 'retrieve', args: ['find it', 'task-1', { maxTokens: 500 }], expected: retrieval,
  },
  {
    request: {
      kind: 'record-session-end', sessionId: 'session-1', outcome: 'success',
      summary: 'Done', lessons: ['typed ports'],
    },
    method: 'recordSessionEnd',
    args: ['session-1', 'success', 'Done', ['typed ports']],
    expected: undefined,
  },
  {
    request: {
      kind: 'record-workflow', name: 'Worker flow', steps: ['validate', 'invoke'],
      applicableContexts: ['memory'],
    },
    method: 'recordWorkflow',
    args: ['Worker flow', ['validate', 'invoke'], ['memory']],
    expected: workflow,
  },
  {
    request: {
      kind: 'record-strategy', strategy: 'Use typed RPC', conditions: ['memory request'],
      taskId: 'task-1', success: true, score: 1,
    },
    method: 'recordStrategy',
    args: ['Use typed RPC', ['memory request'], 'task-1', true, 1],
    expected: strategy,
  },
  {
    request: { kind: 'record-outcome', taskId: 'task-1', success: false, score: 0.25 },
    method: 'recordTaskOutcome', args: ['task-1', false, 0.25], expected: undefined,
  },
  { request: { kind: 'get-stats' }, method: 'getStats', args: [], expected: stats },
  {
    request: { kind: 'get-sessions', limit: 20 },
    method: 'getSessionHistory', args: [20], expected: sessions,
  },
  {
    request: { kind: 'get-patterns', minSuccessRate: 0.75 },
    method: 'getPatterns', args: [0.75], expected: patterns,
  },
  {
    request: { kind: 'get-workflows' },
    method: 'getWorkflows', args: [], expected: [workflow],
  },
  { request: { kind: 'save' }, method: 'save', args: [], expected: snapshot },
  {
    request: { kind: 'load', snapshot }, method: 'load', args: [snapshot], expected: undefined,
  },
  {
    request: { kind: 'configure', config: { shortTermMaxTokens: 1_000 } },
    method: 'configure', args: [{ shortTermMaxTokens: 1_000 }], expected: undefined,
  },
] satisfies {
  [TKind in UnifiedMemoryWorkerRequest['kind']]: {
    request: Extract<UnifiedMemoryWorkerRequest, { kind: TKind }>;
    method: keyof UnifiedMemoryWorkerRequestController;
    args: unknown[];
    expected: unknown;
  };
}[UnifiedMemoryWorkerRequest['kind']][];

describe('unified-memory worker request handler', () => {
  let controller: UnifiedMemoryWorkerRequestController;

  beforeEach(() => {
    controller = createController();
  });

  it.each(cases)('routes and clone-safely returns $request.kind', async ({
    request, method, args, expected,
  }) => {
    const result = await handleUnifiedMemoryWorkerRequest(controller, request);

    expect(controller[method]).toHaveBeenCalledWith(...args);
    expect(result).toEqual(expected);
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('rejects an unknown request kind instead of returning empty success', async () => {
    await expect(handleUnifiedMemoryWorkerRequest(
      controller,
      { kind: 'unknown-unified-operation' } as never,
    )).rejects.toThrow('Unknown unified-memory worker request kind: unknown-unified-operation');
  });
});
