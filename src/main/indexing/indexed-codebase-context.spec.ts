import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import type { ContextStore } from '../../shared/types/rlm.types';
import type { CodeRetrievalResult } from '../codemem/code-retrieval-service';

const workerPort = vi.hoisted(() => ({
  invokeRlm: vi.fn(),
}));

vi.mock('../instance/context-worker-client', () => ({
  getContextWorkerClient: () => workerPort,
}));

import { IndexedCodebaseContextService } from './indexed-codebase-context';

const REPO_PATH = path.resolve('/repo');

function makeStore(overrides: Partial<ContextStore> = {}): ContextStore {
  return {
    id: 'ctx-codebase',
    instanceId: 'codebase:test',
    sections: [],
    totalTokens: 0,
    totalSize: 0,
    createdAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    config: {
      kind: 'codebase-auto',
      rootPath: REPO_PATH,
    },
    ...overrides,
  };
}

function makeResult(overrides: Partial<CodeRetrievalResult> = {}): CodeRetrievalResult {
  return {
    workspacePath: REPO_PATH,
    relativePath: 'src/auth.ts',
    absolutePath: path.join(REPO_PATH, 'src', 'auth.ts'),
    content: 'export function requireAuth() {\n  return true;\n}',
    startLine: 10,
    endLine: 12,
    score: 0.42,
    source: 'fts',
    language: 'typescript',
    symbolName: 'requireAuth',
    stale: false,
    ...overrides,
  };
}

describe('IndexedCodebaseContextService', () => {
  beforeEach(() => {
    workerPort.invokeRlm.mockReset();
  });

  it('uses the shared RLM worker port for default store lookup', async () => {
    workerPort.invokeRlm.mockResolvedValue(makeStore({ id: 'ctx-from-worker' }));
    const search = { search: vi.fn().mockResolvedValue([makeResult()]) };
    const service = new IndexedCodebaseContextService({
      search,
      storeIdResolver: () => 'codebase:test',
    });

    const context = await service.buildContext({
      workspacePath: '/repo',
      query: 'find auth middleware',
      storeLookupDeadlineMs: 50,
    });

    expect(context?.storeId).toBe('ctx-from-worker');
    expect(workerPort.invokeRlm).toHaveBeenCalledOnce();
    expect(workerPort.invokeRlm).toHaveBeenCalledWith({
      kind: 'get-store-by-instance',
      instanceId: 'codebase:test',
    });
  });

  it('resolves the codebase-auto store, searches it, and formats indexed snippets', async () => {
    const search = {
      search: vi.fn().mockResolvedValue([makeResult()]),
    };
    const contextManager = {
      getStoreByInstance: vi.fn().mockReturnValue(makeStore()),
      listStores: vi.fn().mockReturnValue([]),
    };
    const service = new IndexedCodebaseContextService({
      contextManager,
      search,
      storeIdResolver: () => 'codebase:test',
    });

    const context = await service.buildContext({
      workspacePath: '/repo',
      query: 'where is auth middleware handled?',
      maxTokens: 300,
      topK: 3,
    });

    expect(search.search).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: REPO_PATH,
      query: 'where is auth middleware handled?',
      limit: 3,
    }));
    expect(context?.storeId).toBe('ctx-codebase');
    expect(context?.results[0]?.relativePath).toBe('src/auth.ts');

    const block = service.formatContextBlock(context);
    expect(block).toContain('[Indexed Codebase Context]');
    expect(block).toContain('Source: Harness indexed codebase search');
    expect(block).toContain('src/auth.ts:10-12');
    expect(block).toContain('requireAuth');
    expect(block).toContain('[End Indexed Codebase Context]');
  });

  it('falls back to persisted store metadata when the instance-id lookup misses', async () => {
    const search = {
      search: vi.fn().mockResolvedValue([makeResult()]),
    };
    const contextManager = {
      getStoreByInstance: vi.fn().mockReturnValue(undefined),
      listStores: vi.fn().mockReturnValue([makeStore({ id: 'ctx-from-config' })]),
    };
    const service = new IndexedCodebaseContextService({
      contextManager,
      search,
      storeIdResolver: () => 'codebase:test',
    });

    const context = await service.buildContext({
      workspacePath: '/repo',
      query: 'find auth middleware',
    });

    expect(context?.storeId).toBe('ctx-from-config');
    expect(search.search).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: REPO_PATH,
    }));
  });

  it('returns null when codemem retrieval returns no indexed results', async () => {
    const search = {
      search: vi.fn().mockResolvedValue([]),
    };
    const service = new IndexedCodebaseContextService({
      contextManager: {
        getStoreByInstance: vi.fn().mockReturnValue(undefined),
        listStores: vi.fn().mockReturnValue([]),
      },
      search,
      storeIdResolver: () => 'codebase:test',
    });

    await expect(service.buildContext({
      workspacePath: '/repo',
      query: 'find auth middleware',
    })).resolves.toBeNull();
    expect(search.search).toHaveBeenCalled();
  });

  it('waits exactly for the caller deadline then searches with the deterministic store ID', async () => {
    vi.useFakeTimers();
    try {
      const search = { search: vi.fn().mockResolvedValue([makeResult()]) };
      const getStoreByInstance = vi.fn(() => new Promise<ContextStore | undefined>(() => undefined));
      const listStores = vi.fn().mockResolvedValue([]);
      const service = new IndexedCodebaseContextService({
        contextManager: { getStoreByInstance, listStores } as never,
        search,
        storeIdResolver: () => 'codebase:deterministic',
      });

      const pending = service.buildContext({
        workspacePath: '/repo',
        query: 'find auth middleware',
        storeLookupDeadlineMs: 37,
      });
      await vi.advanceTimersByTimeAsync(36);
      expect(search.search).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({ storeId: 'codebase:deterministic' });
      expect(getStoreByInstance).toHaveBeenCalledOnce();
      expect(listStores).not.toHaveBeenCalled();
      expect(search.search).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the deterministic store ID when worker lookup is unavailable', async () => {
    const search = { search: vi.fn().mockResolvedValue([makeResult()]) };
    const getStoreByInstance = vi.fn(() => {
      throw new Error('worker unavailable');
    });
    const service = new IndexedCodebaseContextService({
      contextManager: {
        getStoreByInstance,
        listStores: vi.fn().mockResolvedValue([]),
      } as never,
      search,
      storeIdResolver: () => 'codebase:deterministic',
    });

    await expect(service.buildContext({
      workspacePath: '/repo',
      query: 'find auth middleware',
      storeLookupDeadlineMs: 25,
    })).resolves.toMatchObject({ storeId: 'codebase:deterministic' });
    expect(getStoreByInstance).toHaveBeenCalledOnce();
    expect(search.search).toHaveBeenCalledOnce();
  });

  it('keeps the fallback stable and absorbs a late worker rejection after timeout', async () => {
    vi.useFakeTimers();
    try {
      let rejectLookup!: (error: Error) => void;
      const getStoreByInstance = vi.fn(() => new Promise<ContextStore | undefined>((_resolve, reject) => {
        rejectLookup = reject;
      }));
      const listStores = vi.fn().mockResolvedValue([makeStore({ id: 'late-store' })]);
      const search = { search: vi.fn().mockResolvedValue([makeResult()]) };
      const service = new IndexedCodebaseContextService({
        contextManager: { getStoreByInstance, listStores } as never,
        search,
        storeIdResolver: () => 'codebase:deterministic',
      });

      const pending = service.buildContext({
        workspacePath: '/repo',
        query: 'find auth middleware',
        storeLookupDeadlineMs: 20,
      });
      await vi.advanceTimersByTimeAsync(20);
      await expect(pending).resolves.toMatchObject({ storeId: 'codebase:deterministic' });

      rejectLookup(new Error('late worker failure'));
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }
      expect(getStoreByInstance).toHaveBeenCalledOnce();
      expect(listStores).not.toHaveBeenCalled();
      expect(search.search).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
