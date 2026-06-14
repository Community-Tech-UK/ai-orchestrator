import { describe, expect, it, vi } from 'vitest';
import type { ContextStore } from '../../shared/types/rlm.types';
import type { CodeRetrievalResult } from '../codemem/code-retrieval-service';
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

function makeResult(overrides: Partial<CodeRetrievalResult> = {}): CodeRetrievalResult {
  return {
    workspacePath: '/repo',
    relativePath: 'src/auth.ts',
    absolutePath: '/repo/src/auth.ts',
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
      workspacePath: '/repo',
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
      workspacePath: '/repo',
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
});
