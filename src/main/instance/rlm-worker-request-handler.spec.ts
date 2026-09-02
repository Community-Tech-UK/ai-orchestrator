import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContextQueryResult,
  ContextSection,
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';
import {
  handleRlmWorkerRequest,
  type RlmWorkerRequestManager,
} from './rlm-worker-request-handler';
import type { RlmWorkerRequest } from './rlm-worker-port';

const section: ContextSection = {
  id: 'section-1',
  type: 'file',
  name: 'main.ts',
  content: 'private section content',
  tokens: 4,
  startOffset: 0,
  endOffset: 23,
  checksum: 'checksum-1',
  depth: 0,
  summarizes: ['source-1'],
};

const store: ContextStore = {
  id: 'store-1',
  instanceId: 'instance-1',
  sections: [section],
  totalTokens: 4,
  totalSize: 23,
  createdAt: 1,
  lastAccessed: 2,
  accessCount: 3,
  config: { kind: 'ordinary' },
};

const queryResult: ContextQueryResult = {
  query: { type: 'grep', params: { pattern: 'needle' } },
  result: 'match',
  tokensUsed: 2,
  sectionsAccessed: ['section-1'],
  duration: 5,
  depth: 0,
};

const session: RLMSession = {
  id: 'session-1',
  storeId: 'store-1',
  instanceId: 'instance-1',
  queries: [queryResult],
  recursiveCalls: [],
  totalRootTokens: 2,
  totalSubQueryTokens: 0,
  estimatedDirectTokens: 8,
  tokenSavingsPercent: 75,
  startedAt: 1,
  lastActivityAt: 2,
};

function createManager(): RlmWorkerRequestManager {
  return {
    createStore: vi.fn(() => store),
    deleteStore: vi.fn(),
    getStore: vi.fn((storeId: string) => storeId === 'missing' ? undefined : store),
    getStoreByInstance: vi.fn((instanceId: string) => (
      instanceId === 'missing' ? undefined : store
    )),
    listSectionFilterMetadata: vi.fn(() => ({
      sections: [{ type: 'file' as const, filePath: '/repo/main.ts' }],
      nextOffset: 32,
    })),
    listStores: vi.fn(() => [store]),
    addSection: vi.fn(() => section),
    removeSection: vi.fn(() => true),
    listSections: vi.fn(() => [section]),
    startSession: vi.fn(async () => session),
    endSession: vi.fn(),
    getSession: vi.fn((sessionId: string) => sessionId === 'missing' ? undefined : session),
    listSessions: vi.fn(() => [session]),
    executeQuery: vi.fn(async () => queryResult),
    getStoreStats: vi.fn(() => ({
      sections: 1,
      originalSections: 1,
      summaries: 0,
      totalTokens: 4,
      summaryLevels: 0,
      indexedTerms: 0,
    })),
    getSessionStats: vi.fn(() => ({
      totalQueries: 1,
      totalRecursiveCalls: 0,
      rootTokens: 2,
      subQueryTokens: 0,
      estimatedSavings: 6,
      avgQueryDuration: 5,
    })),
    getStorageStats: vi.fn(() => ({
      totalStores: 1,
      totalSections: 1,
      totalTokens: 4,
      totalSizeBytes: 23,
      byType: [{ type: 'file', count: 1, tokens: 4 }],
    })),
    getQueryStats: vi.fn(() => [{ type: 'grep', count: 1, avgDuration: 5, avgTokens: 2 }]),
    getTokenSavingsHistory: vi.fn(() => [{
      date: '2026-09-01',
      directTokens: 8,
      actualTokens: 2,
      savingsPercent: 75,
    }]),
    configure: vi.fn(),
    getStoreHydrationState: vi.fn(() => ({
      metadata: 'resident' as const,
      content: 'resident' as const,
      contentEligible: true,
      sectionCount: 1,
    })),
  };
}

const serializedSection = { ...section, content: '', summarizes: ['source-1'] };
const serializedStoreDetail = {
  id: 'store-1',
  instanceId: 'instance-1',
  sections: [serializedSection],
  totalTokens: 4,
  totalSize: 23,
  createdAt: 1,
  lastAccessed: 2,
  accessCount: 3,
  config: {
    kind: 'ordinary',
    ipcSectionCount: 1,
    ipcSectionsTruncated: false,
  },
};
const serializedStoreListItem = {
  ...serializedStoreDetail,
  sections: [],
  config: {
    kind: 'ordinary',
    ipcSectionCount: 1,
    ipcSectionsTruncated: true,
  },
};

const cases = [
  {
    request: {
      kind: 'create-store',
      instanceId: 'instance-1',
      config: { kind: 'codebase-auto', rootPath: '/repo' },
    },
    method: 'createStore',
    args: ['instance-1', { kind: 'codebase-auto', rootPath: '/repo' }],
    expected: serializedStoreDetail,
  },
  {
    request: { kind: 'delete-store', storeId: 'store-1' },
    method: 'deleteStore',
    args: ['store-1'],
    expected: undefined,
  },
  {
    request: { kind: 'get-store', storeId: 'store-1' },
    method: 'getStore',
    args: ['store-1'],
    expected: serializedStoreDetail,
  },
  {
    request: { kind: 'get-store-by-instance', instanceId: 'instance-1' },
    method: 'getStoreByInstance',
    args: ['instance-1'],
    expected: serializedStoreDetail,
  },
  {
    request: {
      kind: 'list-section-filter-metadata',
      storeId: 'store-1',
      offset: 0,
      limit: 32,
    },
    method: 'listSectionFilterMetadata',
    args: ['store-1', 0, 32],
    expected: {
      sections: [{ type: 'file', filePath: '/repo/main.ts' }],
      nextOffset: 32,
    },
  },
  {
    request: { kind: 'list-stores' },
    method: 'listStores',
    args: [],
    expected: [serializedStoreListItem],
  },
  {
    request: {
      kind: 'add-section',
      storeId: 'store-1',
      type: 'file',
      name: 'main.ts',
      content: 'private section content',
      metadata: { depth: 0, filePath: '/repo/main.ts' },
    },
    method: 'addSection',
    args: [
      'store-1',
      'file',
      'main.ts',
      'private section content',
      { depth: 0, filePath: '/repo/main.ts' },
    ],
    expected: serializedSection,
  },
  {
    request: { kind: 'remove-section', storeId: 'store-1', sectionId: 'section-1' },
    method: 'removeSection',
    args: ['store-1', 'section-1'],
    expected: true,
  },
  {
    request: { kind: 'list-sections', storeId: 'store-1' },
    method: 'listSections',
    args: ['store-1'],
    expected: [serializedSection],
  },
  {
    request: { kind: 'start-session', storeId: 'store-1', instanceId: 'instance-1' },
    method: 'startSession',
    args: ['store-1', 'instance-1'],
    expected: session,
  },
  {
    request: { kind: 'end-session', sessionId: 'session-1' },
    method: 'endSession',
    args: ['session-1'],
    expected: undefined,
  },
  {
    request: { kind: 'get-session', sessionId: 'session-1' },
    method: 'getSession',
    args: ['session-1'],
    expected: session,
  },
  {
    request: { kind: 'list-sessions' },
    method: 'listSessions',
    args: [],
    expected: [session],
  },
  {
    request: {
      kind: 'execute-query',
      sessionId: 'session-1',
      query: { type: 'grep', params: { pattern: 'needle' } },
      depth: 1,
    },
    method: 'executeQuery',
    args: ['session-1', { type: 'grep', params: { pattern: 'needle' } }, 1],
    expected: queryResult,
  },
  {
    request: { kind: 'get-store-stats', storeId: 'store-1' },
    method: 'getStoreStats',
    args: ['store-1'],
    expected: {
      sections: 1,
      originalSections: 1,
      summaries: 0,
      totalTokens: 4,
      summaryLevels: 0,
      indexedTerms: 0,
    },
  },
  {
    request: { kind: 'get-session-stats', sessionId: 'session-1' },
    method: 'getSessionStats',
    args: ['session-1'],
    expected: {
      totalQueries: 1,
      totalRecursiveCalls: 0,
      rootTokens: 2,
      subQueryTokens: 0,
      estimatedSavings: 6,
      avgQueryDuration: 5,
    },
  },
  {
    request: { kind: 'get-storage-stats' },
    method: 'getStorageStats',
    args: [],
    expected: {
      totalStores: 1,
      totalSections: 1,
      totalTokens: 4,
      totalSizeBytes: 23,
      byType: [{ type: 'file', count: 1, tokens: 4 }],
    },
  },
  {
    request: { kind: 'get-query-stats', days: 30 },
    method: 'getQueryStats',
    args: [30],
    expected: [{ type: 'grep', count: 1, avgDuration: 5, avgTokens: 2 }],
  },
  {
    request: { kind: 'get-token-savings-history', days: 7 },
    method: 'getTokenSavingsHistory',
    args: [7],
    expected: [{
      date: '2026-09-01',
      directTokens: 8,
      actualTokens: 2,
      savingsPercent: 75,
    }],
  },
  {
    request: { kind: 'configure', config: { maxRecursionDepth: 4 } },
    method: 'configure',
    args: [{ maxRecursionDepth: 4 }],
    expected: undefined,
  },
] satisfies {
  [TKind in RlmWorkerRequest['kind']]: {
    request: Extract<RlmWorkerRequest, { kind: TKind }>;
    method: keyof RlmWorkerRequestManager;
    args: unknown[];
    expected: unknown;
  };
}[RlmWorkerRequest['kind']][];

describe('RLM worker request handler', () => {
  let manager: RlmWorkerRequestManager;

  beforeEach(() => {
    manager = createManager();
  });

  it.each(cases)('routes and clone-safely returns $request.kind', async ({
    request,
    method,
    args,
    expected,
  }) => {
    const result = await handleRlmWorkerRequest(manager, request);

    expect(manager[method]).toHaveBeenCalledWith(...args);
    expect(result).toEqual(expected);
    expect(() => structuredClone(result)).not.toThrow();
  });

  it('preserves undefined for missing store and session reads', async () => {
    await expect(handleRlmWorkerRequest(manager, {
      kind: 'get-store',
      storeId: 'missing',
    })).resolves.toBeUndefined();
    await expect(handleRlmWorkerRequest(manager, {
      kind: 'get-store-by-instance',
      instanceId: 'missing',
    })).resolves.toBeUndefined();
    await expect(handleRlmWorkerRequest(manager, {
      kind: 'get-session',
      sessionId: 'missing',
    })).resolves.toBeUndefined();
  });

  it('caps detailed stores at 1,000 section metadata records', async () => {
    const sections = Array.from({ length: 1_002 }, (_, index) => ({
      ...section,
      id: `section-${index}`,
      content: `private-${index}`,
    }));
    const largeStore = { ...store, sections };
    vi.mocked(manager.getStore).mockReturnValue(largeStore);
    vi.mocked(manager.getStoreHydrationState).mockReturnValue({
      metadata: 'resident',
      content: 'resident',
      contentEligible: true,
      sectionCount: 1_002,
    });

    const result = await handleRlmWorkerRequest(manager, {
      kind: 'get-store',
      storeId: 'store-1',
    });

    expect(result?.sections).toHaveLength(1_000);
    expect(result?.sections.every((item) => item.content === '')).toBe(true);
    expect(result?.config?.['ipcSectionCount']).toBe(1_002);
    expect(result?.config?.['ipcSectionsTruncated']).toBe(true);
  });

  it('marks a deferred metadata-only store as truncated instead of empty', async () => {
    vi.mocked(manager.listStores).mockReturnValue([{ ...store, sections: [] }]);
    vi.mocked(manager.getStoreHydrationState).mockReturnValue({
      metadata: 'deferred',
      content: 'deferred',
      contentEligible: true,
      sectionCount: 42,
    });

    const result = await handleRlmWorkerRequest(manager, { kind: 'list-stores' });

    expect(result[0]?.sections).toEqual([]);
    expect(result[0]?.config?.['ipcSectionCount']).toBe(42);
    expect(result[0]?.config?.['ipcSectionsTruncated']).toBe(true);
  });

  it('caps internal section-filter metadata pages without returning content', async () => {
    vi.mocked(manager.listSectionFilterMetadata).mockReturnValue({
      sections: [{ type: 'file', filePath: '/repo/private.ts' }],
    });

    const result = await handleRlmWorkerRequest(manager, {
      kind: 'list-section-filter-metadata',
      storeId: 'store-1',
      offset: 0,
      limit: 10_000,
    });

    expect(manager.listSectionFilterMetadata).toHaveBeenCalledWith('store-1', 0, 256);
    expect(result).toEqual({
      sections: [{ type: 'file', filePath: '/repo/private.ts' }],
    });
    expect(JSON.stringify(result)).not.toContain('content');
  });

  it('rejects unknown request kinds', async () => {
    await expect(handleRlmWorkerRequest(manager, {
      kind: 'unknown-kind',
    } as never)).rejects.toThrow('Unknown RLM worker request kind: unknown-kind');
  });
});
