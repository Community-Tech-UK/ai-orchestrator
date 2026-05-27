import { describe, expect, it, vi } from 'vitest';
import type { ContextStore } from '../../shared/types/rlm.types';
import type { HybridSearchResult } from '../../shared/types/codebase.types';
import { IndexedCodebaseContextService } from './indexed-codebase-context';

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
      rootPath: '/repo',
    },
    ...overrides,
  };
}

function makeResult(overrides: Partial<HybridSearchResult> = {}): HybridSearchResult {
  return {
    sectionId: 'sec-1',
    filePath: '/repo/src/auth/middleware.ts',
    content: 'export function requireAuth() {\n  return true;\n}',
    startLine: 10,
    endLine: 12,
    score: 0.42,
    matchType: 'hybrid',
    language: 'typescript',
    ...overrides,
  };
}

describe('IndexedCodebaseContextService', () => {
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
      storeId: 'ctx-codebase',
      query: 'where is auth middleware handled?',
      topK: 3,
    }));
    expect(context?.storeId).toBe('ctx-codebase');
    expect(context?.results[0]?.relativePath).toBe('src/auth/middleware.ts');

    const block = service.formatContextBlock(context);
    expect(block).toContain('[Indexed Codebase Context]');
    expect(block).toContain('src/auth/middleware.ts:10-12');
    expect(block).toContain('requireAuth');
    expect(block).toContain('[End Indexed Codebase Context]');
  });

  it('falls back to persisted store metadata when the instance-id lookup misses', async () => {
    const search = {
      search: vi.fn().mockResolvedValue([makeResult({ sectionId: 'sec-2' })]),
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
      storeId: 'ctx-from-config',
    }));
  });

  it('returns null without searching when no indexed store exists', async () => {
    const search = {
      search: vi.fn(),
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
    expect(search.search).not.toHaveBeenCalled();
  });
});
