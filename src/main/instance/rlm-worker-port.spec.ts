import { describe, expect, expectTypeOf, it } from 'vitest';
import type { ContextWorkerRpcMsg } from './context-worker-protocol';
import type {
  RlmCloneValue,
  RlmContextStoreDto,
  RlmWorkerPort,
  RlmWorkerRequest,
  RlmWorkerResult,
} from './rlm-worker-port';

const requestsByKind = {
  'create-store': {
    kind: 'create-store',
    instanceId: 'inst-1',
    config: { kind: 'codebase-auto', rootPath: '/workspace' },
  },
  'delete-store': { kind: 'delete-store', storeId: 'store-1' },
  'get-store': { kind: 'get-store', storeId: 'store-1' },
  'get-store-by-instance': { kind: 'get-store-by-instance', instanceId: 'inst-1' },
  'list-section-filter-metadata': {
    kind: 'list-section-filter-metadata',
    storeId: 'store-1',
    offset: 256,
    limit: 32,
  },
  'list-stores': { kind: 'list-stores' },
  'add-section': {
    kind: 'add-section',
    storeId: 'store-1',
    type: 'file',
    name: 'README.md',
    content: '# Read me',
    metadata: {
      filePath: '/workspace/README.md',
      depth: 0,
      summarizes: ['section-0'],
    },
  },
  'remove-section': {
    kind: 'remove-section',
    storeId: 'store-1',
    sectionId: 'section-1',
  },
  'list-sections': { kind: 'list-sections', storeId: 'store-1' },
  'start-session': {
    kind: 'start-session',
    storeId: 'store-1',
    instanceId: 'inst-1',
  },
  'end-session': { kind: 'end-session', sessionId: 'session-1' },
  'get-session': { kind: 'get-session', sessionId: 'session-1' },
  'list-sessions': { kind: 'list-sessions' },
  'execute-query': {
    kind: 'execute-query',
    sessionId: 'session-1',
    query: {
      type: 'grep',
      params: { terms: ['budget', 'owner'], exact: false, limit: 10 },
    },
    depth: 0,
  },
  'get-store-stats': { kind: 'get-store-stats', storeId: 'store-1' },
  'get-session-stats': { kind: 'get-session-stats', sessionId: 'session-1' },
  'get-storage-stats': { kind: 'get-storage-stats' },
  'get-query-stats': { kind: 'get-query-stats', days: 30 },
  'get-token-savings-history': { kind: 'get-token-savings-history', days: 30 },
  configure: {
    kind: 'configure',
    config: { maxRecursionDepth: 3, enableCostTracking: true },
  },
} satisfies {
  [TKind in RlmWorkerRequest['kind']]: Extract<RlmWorkerRequest, { kind: TKind }>;
};

describe('RLM worker port contract', () => {
  it('exhaustively represents every renderer RLM operation with clone-safe payloads', () => {
    const requests = Object.values(requestsByKind);

    expectTypeOf<() => void>().not.toMatchTypeOf<RlmCloneValue>();
    expect(structuredClone(requests)).toEqual(requests);
    expect(requests.map((request) => request.kind)).toEqual([
      'create-store',
      'delete-store',
      'get-store',
      'get-store-by-instance',
      'list-section-filter-metadata',
      'list-stores',
      'add-section',
      'remove-section',
      'list-sections',
      'start-session',
      'end-session',
      'get-session',
      'list-sessions',
      'execute-query',
      'get-store-stats',
      'get-session-stats',
      'get-storage-stats',
      'get-query-stats',
      'get-token-savings-history',
      'configure',
    ]);
  });

  it('keeps invokeRlm results correlated to the request discriminant at compile time', () => {
    interface CreateStoreRequest {
      kind: 'create-store';
      instanceId: string;
    }
    interface RemoveSectionRequest {
      kind: 'remove-section';
      storeId: string;
      sectionId: string;
    }
    interface ConfigureRequest {
      kind: 'configure';
      config: Record<string, never>;
    }

    expectTypeOf<RlmWorkerPort['invokeRlm']>().toBeFunction();
    expectTypeOf<RlmWorkerResult<CreateStoreRequest>>()
      .toEqualTypeOf<RlmContextStoreDto>();
    expectTypeOf<RlmWorkerResult<RemoveSectionRequest>>().toEqualTypeOf<boolean>();
    expectTypeOf<RlmWorkerResult<ConfigureRequest>>().toEqualTypeOf<void>();
  });

  it('carries a typed RLM request inside one clone-safe worker RPC envelope', () => {
    const message = {
      type: 'rlm-request',
      id: 17,
      request: requestsByKind['execute-query'],
    } satisfies ContextWorkerRpcMsg;

    expect(structuredClone(message)).toEqual(message);
  });
});
