import { describe, expect, it, vi } from 'vitest';
import { loadPersistedContextState } from './context-persistence-loader';
import type { RLMDatabase } from '../persistence/rlm-database';
import type {
  ContextSectionRow,
  ContextStoreRow,
} from '../persistence/rlm-database.types';

function storeRow(overrides: Partial<ContextStoreRow> = {}): ContextStoreRow {
  return {
    id: 'store-1',
    instance_id: 'instance-1',
    total_tokens: 0,
    total_size: 0,
    access_count: 0,
    created_at: 1,
    last_accessed: 1,
    config_json: null,
    ...overrides,
  };
}

function sectionRow(overrides: Partial<ContextSectionRow> = {}): ContextSectionRow {
  return {
    id: 'sec-1',
    store_id: 'store-1',
    type: 'file',
    name: 'src/main.ts',
    source: null,
    start_offset: 0,
    end_offset: 12,
    tokens: 3,
    checksum: 'abc',
    depth: 0,
    summarizes_json: null,
    parent_summary_id: null,
    file_path: '/repo/src/main.ts',
    language: 'typescript',
    source_url: null,
    created_at: 1,
    content_file: null,
    content_inline: 'export {};',
    ...overrides,
  };
}

describe('loadPersistedContextState', () => {
  it('loads codebase-auto stores as metadata without reading section content', () => {
    const getSectionContent = vi.fn(() => 'large content');
    const db = {
      listStores: () => [
        storeRow({
          config_json: JSON.stringify({
            kind: 'codebase-auto',
            rootPath: '/repo',
          }),
          total_tokens: 42_000_000,
        }),
      ],
      getSections: () => [sectionRow()],
      getSectionContent,
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);
    const store = state.stores.get('store-1');

    expect(getSectionContent).not.toHaveBeenCalled();
    expect(store?.sections[0]?.content).toBe('');
    expect(store?.searchIndex?.terms.size).toBe(0);
  });

  it('continues to load small normal stores with content for in-memory search', () => {
    const getSectionContent = vi.fn(() => 'export {};');
    const db = {
      listStores: () => [storeRow()],
      getSections: () => [sectionRow()],
      getSectionContent,
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);
    const store = state.stores.get('store-1');

    expect(getSectionContent).toHaveBeenCalledTimes(1);
    expect(store?.sections[0]?.content).toBe('export {};');
    expect(store?.searchIndex?.terms.has('export')).toBe(true);
  });
});
