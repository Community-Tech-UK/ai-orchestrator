import { describe, expect, it } from 'vitest';
import {
  isHighVolumeContextStore,
  serializeContextQueryResultForIpc,
  serializeContextSectionForIpc,
  serializeRlmSessionForIpc,
  serializeContextStoreForIpc,
} from './rlm-ipc-serialization';
import type {
  ContextQueryResult,
  ContextSection,
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';

const section: ContextSection = {
  id: 'sec-1',
  type: 'file',
  name: 'main.ts',
  content: 'x'.repeat(2000),
  tokens: 500,
  startOffset: 0,
  endOffset: 2000,
  checksum: 'abc',
  depth: 0,
  filePath: '/repo/src/main.ts',
};

function store(overrides: Partial<ContextStore> = {}): ContextStore {
  return {
    id: 'store-1',
    instanceId: 'instance-1',
    sections: [section],
    totalTokens: 500,
    totalSize: 2000,
    createdAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    ...overrides,
  };
}

describe('RLM IPC serialization', () => {
  it('strips section content by default', () => {
    const serialized = serializeContextSectionForIpc(section);

    expect(serialized.content).toBe('');
    expect(serialized.tokens).toBe(500);
  });

  it('caps store event payloads without adding internal cache state', () => {
    const serialized = serializeContextStoreForIpc(store(), {
      includeSections: true,
      sectionLimit: 0,
    });

    expect(serialized.sections).toEqual([]);
    expect(serialized).not.toHaveProperty('bloomFilter');
    expect(serialized.config?.['ipcSectionCount']).toBe(1);
    expect(serialized.config?.['ipcSectionsTruncated']).toBe(true);
  });

  it('uses the authoritative hydration count for deferred stores', () => {
    const serialized = serializeContextStoreForIpc(store({ sections: [] }), {
      includeSections: true,
      authoritativeSectionCount: 37,
    });

    expect(serialized.sections).toEqual([]);
    expect(serialized.config?.['ipcSectionCount']).toBe(37);
    expect(serialized.config?.['ipcSectionsTruncated']).toBe(true);
  });

  it('caps store details at 1,000 metadata-only sections', () => {
    const sections = Array.from({ length: 1_002 }, (_, index) => ({
      ...section,
      id: `sec-${index}`,
      content: `private-content-${index}`,
    }));

    const serialized = serializeContextStoreForIpc(store({ sections }), {
      includeSections: true,
      authoritativeSectionCount: 1_002,
    });

    expect(serialized.sections).toHaveLength(1_000);
    expect(serialized.sections.every((item) => item.content === '')).toBe(true);
    expect(serialized.config?.['ipcSectionCount']).toBe(1_002);
    expect(serialized.config?.['ipcSectionsTruncated']).toBe(true);
  });

  it('whitelists section and config data so functions and internal maps cannot cross IPC', () => {
    const unsafeSection = {
      ...section,
      callback: () => 'do not clone',
      internalLookup: new Map([['secret', 1]]),
    } as ContextSection;
    const unsafeStore = store({
      sections: [unsafeSection],
      config: {
        kind: 'ordinary',
        nested: { enabled: true },
        callback: () => 'do not clone',
        internalLookup: new Map([['secret', 1]]),
      },
    });

    const serialized = serializeContextStoreForIpc(unsafeStore, { includeSections: true });

    expect(serialized.sections[0]).not.toHaveProperty('callback');
    expect(serialized.sections[0]).not.toHaveProperty('internalLookup');
    expect(serialized.config).toEqual({
      kind: 'ordinary',
      nested: { enabled: true },
      ipcSectionCount: 1,
      ipcSectionsTruncated: false,
    });
    expect(() => structuredClone(serialized)).not.toThrow();
  });

  it('serializes nested query/session values without retaining runtime-only properties', () => {
    const queryResult = {
      query: {
        type: 'grep',
        params: {
          pattern: 'needle',
          callback: () => 'do not clone',
          internalLookup: new Map([['secret', 1]]),
        },
      },
      result: 'match',
      tokensUsed: 2,
      sectionsAccessed: ['sec-1'],
      duration: 3,
      depth: 0,
      callback: () => 'do not clone',
    } as ContextQueryResult;
    const session = {
      id: 'session-1',
      storeId: 'store-1',
      instanceId: 'instance-1',
      queries: [queryResult],
      recursiveCalls: [],
      totalRootTokens: 2,
      totalSubQueryTokens: 0,
      estimatedDirectTokens: 5,
      tokenSavingsPercent: 60,
      startedAt: 1,
      lastActivityAt: 2,
      callback: () => 'do not clone',
    } as RLMSession;

    const serializedResult = serializeContextQueryResultForIpc(queryResult);
    const serializedSession = serializeRlmSessionForIpc(session);

    expect(serializedResult.query.params).toEqual({ pattern: 'needle' });
    expect(serializedResult).not.toHaveProperty('callback');
    expect(serializedSession).not.toHaveProperty('callback');
    expect(() => structuredClone({ serializedResult, serializedSession })).not.toThrow();
  });

  it('identifies codebase-auto stores as high-volume stores', () => {
    expect(isHighVolumeContextStore(store({
      config: { kind: 'codebase-auto' },
    }))).toBe(true);
    expect(isHighVolumeContextStore(store())).toBe(false);
  });
});
