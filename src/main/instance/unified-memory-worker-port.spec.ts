import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ContextWorkerRpcMsg } from './context-worker-protocol';
import {
  UnifiedMemoryWorkerRpcError,
  UnifiedMemoryWorkerRpcTimeoutError,
} from './unified-memory-worker-port';
import type {
  UnifiedMemoryCloneValue,
  UnifiedMemoryWorkerPort,
  UnifiedMemoryWorkerRequest,
  UnifiedMemoryWorkerResult,
} from './unified-memory-worker-port';
import type {
  UnifiedMemoryStats,
  WorkflowMemory,
} from '../../shared/types/unified-memory.types';

const requestsByKind = {
  'process-input': {
    kind: 'process-input', input: 'remember this', sessionId: 'session-1', taskId: 'task-1',
  },
  retrieve: {
    kind: 'retrieve', query: 'what matters?', taskId: 'task-1',
    options: { types: ['long_term'], maxTokens: 500, sessionId: 'session-1' },
  },
  'record-session-end': {
    kind: 'record-session-end', sessionId: 'session-1', outcome: 'success',
    summary: 'Completed the task', lessons: ['Prefer the worker boundary'],
  },
  'record-workflow': {
    kind: 'record-workflow', name: 'Worker flow', steps: ['validate', 'invoke'],
    applicableContexts: ['memory'],
  },
  'record-strategy': {
    kind: 'record-strategy', strategy: 'Use typed RPC', conditions: ['memory request'],
    taskId: 'task-1', success: true, score: 1,
  },
  'record-outcome': {
    kind: 'record-outcome', taskId: 'task-1', success: false, score: 0.25,
  },
  'get-stats': { kind: 'get-stats' },
  'get-sessions': { kind: 'get-sessions', limit: 20 },
  'get-patterns': { kind: 'get-patterns', minSuccessRate: 0.75 },
  'get-workflows': { kind: 'get-workflows' },
  save: { kind: 'save' },
  load: {
    kind: 'load',
    snapshot: {
      version: '1.0', timestamp: 1,
      shortTerm: { buffer: [], summaries: [] },
      episodic: { sessions: [], patterns: [] },
      procedural: { workflows: [], strategies: [] },
    },
  },
  configure: {
    kind: 'configure', config: { shortTermMaxTokens: 1_000, trainingStage: 2 },
  },
} satisfies {
  [TKind in UnifiedMemoryWorkerRequest['kind']]: Extract<
    UnifiedMemoryWorkerRequest,
    { kind: TKind }
  >;
};

describe('unified-memory worker port contract', () => {
  it('exposes distinct worker failure and timeout errors to IPC callers', () => {
    expect(new UnifiedMemoryWorkerRpcError('worker failed')).toMatchObject({
      name: 'UnifiedMemoryWorkerRpcError',
      message: 'worker failed',
    });
    expect(new UnifiedMemoryWorkerRpcTimeoutError('worker timed out')).toMatchObject({
      name: 'UnifiedMemoryWorkerRpcTimeoutError',
      message: 'worker timed out',
    });
  });

  it('exhaustively represents all 13 renderer operations with clone-safe payloads', () => {
    const requests = Object.values(requestsByKind);

    expectTypeOf<() => void>().not.toMatchTypeOf<UnifiedMemoryCloneValue>();
    expect(structuredClone(requests)).toEqual(requests);
    expect(requests.map((request) => request.kind)).toEqual([
      'process-input',
      'retrieve',
      'record-session-end',
      'record-workflow',
      'record-strategy',
      'record-outcome',
      'get-stats',
      'get-sessions',
      'get-patterns',
      'get-workflows',
      'save',
      'load',
      'configure',
    ]);
  });

  it('correlates invoke results to the request discriminant at compile time', () => {
    expectTypeOf<UnifiedMemoryWorkerPort['invokeUnifiedMemory']>().toBeFunction();
    expectTypeOf<UnifiedMemoryWorkerResult<{ kind: 'get-stats' }>>()
      .toEqualTypeOf<UnifiedMemoryStats>();
    expectTypeOf<UnifiedMemoryWorkerResult<{ kind: 'get-workflows' }>>()
      .toEqualTypeOf<WorkflowMemory[]>();
    expectTypeOf<UnifiedMemoryWorkerResult<{
      kind: 'record-outcome'; taskId: string; success: boolean; score: number;
    }>>().toEqualTypeOf<void>();
  });

  it('carries a typed request inside its own clone-safe worker RPC envelope', () => {
    const message = {
      type: 'unified-memory-request',
      id: 71,
      request: requestsByKind.retrieve,
    } satisfies ContextWorkerRpcMsg;

    expect(structuredClone(message)).toEqual(message);
  });
});
