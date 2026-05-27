import { describe, expect, it } from 'vitest';
import {
  isHighVolumeContextStore,
  serializeContextSectionForIpc,
  serializeContextStoreForIpc,
} from './rlm-ipc-serialization';
import type { ContextSection, ContextStore } from '../../shared/types/rlm.types';

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
    searchIndex: {
      terms: new Map([['main', [{ sectionId: 'sec-1', offset: 0, lineNumber: 1 }]]]),
      sectionBoundaries: [2000],
      lastRebuilt: 1,
    },
    ...overrides,
  };
}

describe('RLM IPC serialization', () => {
  it('strips section content by default', () => {
    const serialized = serializeContextSectionForIpc(section);

    expect(serialized.content).toBe('');
    expect(serialized.tokens).toBe(500);
  });

  it('caps store event payloads and removes non-serializable indexes', () => {
    const serialized = serializeContextStoreForIpc(store(), {
      includeSections: true,
      sectionLimit: 0,
    });

    expect(serialized.sections).toEqual([]);
    expect(serialized.searchIndex).toBeUndefined();
    expect(serialized.config?.['ipcSectionCount']).toBe(1);
    expect(serialized.config?.['ipcSectionsTruncated']).toBe(true);
  });

  it('identifies codebase-auto stores as high-volume stores', () => {
    expect(isHighVolumeContextStore(store({
      config: { kind: 'codebase-auto' },
    }))).toBe(true);
    expect(isHighVolumeContextStore(store())).toBe(false);
  });
});
