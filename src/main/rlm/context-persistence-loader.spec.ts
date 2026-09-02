import { describe, expect, it, vi } from 'vitest';
import {
  buildRlmLoadSummary,
  DEFAULT_RLM_RESIDENCY_POLICY,
  loadPersistedContextState,
  selectHotStoreCandidates,
} from './context-persistence-loader';
import type { RLMDatabase } from '../persistence/rlm-database';
import type {
  ContextSectionRow,
  ContextStoreRow,
  RLMSessionRow,
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

function activeSessionRow(overrides: Partial<RLMSessionRow> = {}): RLMSessionRow {
  return {
    id: 'session-1',
    store_id: 'store-1',
    instance_id: 'instance-1',
    started_at: 1,
    ended_at: null,
    last_activity_at: 1,
    total_queries: 0,
    total_root_tokens: 0,
    total_sub_query_tokens: 0,
    estimated_direct_tokens: 0,
    token_savings_percent: 0,
    queries_json: null,
    recursive_calls_json: null,
    ...overrides,
  };
}

class ReadonlyMapWrapper<Key, Value> implements ReadonlyMap<Key, Value> {
  constructor(private readonly entriesByKey: Map<Key, Value>) {}

  get size(): number {
    return this.entriesByKey.size;
  }

  get(key: Key): Value | undefined {
    return this.entriesByKey.get(key);
  }

  has(key: Key): boolean {
    return this.entriesByKey.has(key);
  }

  forEach(callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown): void {
    this.entriesByKey.forEach((value, key) => callbackfn.call(thisArg, value, key, this));
  }

  entries(): MapIterator<[Key, Value]> {
    return this.entriesByKey.entries();
  }

  keys(): MapIterator<Key> {
    return this.entriesByKey.keys();
  }

  values(): MapIterator<Value> {
    return this.entriesByKey.values();
  }

  [Symbol.iterator](): MapIterator<[Key, Value]> {
    return this.entriesByKey[Symbol.iterator]();
  }
}

describe('loadPersistedContextState', () => {
  it('preserves every hot and semantic counter in the full load snapshot', () => {
    const db = {
      listStores: () => [],
      getSectionCountsByStore: () => [],
      listSessions: () => [],
    } as unknown as RLMDatabase;
    const state = loadPersistedContextState(db);

    expect(buildRlmLoadSummary({
      ...state.loadStats,
      hotCandidates: 5,
      hotAdmitted: 4,
      hotSkipped: 1,
      hotCancelled: 2,
      semanticDiscovered: 9,
      semanticIndexed: 6,
      semanticSkipped: 1,
      semanticFailed: 2,
      semanticRetried: 3,
    })).toMatchObject({
      processRole: 'context-worker',
      hotCandidates: 5,
      hotAdmitted: 4,
      hotSkipped: 1,
      hotCancelled: 2,
      semanticDiscovered: 9,
      semanticIndexed: 6,
      semanticSkipped: 1,
      semanticFailed: 2,
      semanticRetried: 3,
    });
  });

  it('returns an empty deferred state for an empty database', () => {
    const db = {
      listStores: () => [],
      getSectionCountsByStore: () => [],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.stores).toHaveLength(0);
    expect(state.sessions).toHaveLength(0);
    expect(state.hydrationStates).toHaveLength(0);
    expect(state.loadStats).toMatchObject({
      discoveredStores: 0,
      activeSessions: 0,
      deferredMetadataSections: 0,
      deferredStores: 0,
      hotCandidates: 0,
    });
  });

  it('retains a zero-section store shell with an explicit deferred hydration state', () => {
    const db = {
      listStores: () => [storeRow()],
      getSectionCountsByStore: () => [],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.stores.get('store-1')?.sections).toEqual([]);
    expect(state.hydrationStates.get('store-1')).toMatchObject({
      metadata: 'deferred',
      content: 'deferred',
      sectionCount: 0,
      contentEligible: true,
    });
  });

  it('exposes hydration states through an immutable runtime map view', () => {
    const db = {
      listStores: () => [storeRow()],
      getSectionCountsByStore: () => [],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);
    const mutableAttempt = state.hydrationStates as unknown as Map<string, unknown>;

    expect(state.hydrationStates.get('store-1')).toMatchObject({ sectionCount: 0 });
    expect(Array.from(state.hydrationStates.keys())).toEqual(['store-1']);
    expect(Object.isFrozen(state.hydrationStates)).toBe(true);
    expect(() => mutableAttempt.set('injected', {})).toThrow();
    expect(state.hydrationStates.has('injected')).toBe(false);
  });

  it('loads store shells and active sessions without reading sections or content at startup', () => {
    const stores = Array.from({ length: 200 }, (_, index) => storeRow({
      id: `store-${index}`,
      instance_id: `instance-${index}`,
      total_tokens: 10,
      total_size: 40,
    }));
    const getSections = vi.fn(() => [sectionRow()]);
    const getSectionContent = vi.fn(() => 'small content');
    const db = {
      listStores: () => stores,
      getSectionCountsByStore: () => [],
      getSections,
      getSectionContent,
      listSessions: () => [
        activeSessionRow({ id: 'session-1', store_id: 'store-1' }),
        activeSessionRow({ id: 'ended-session', ended_at: 2 }),
      ],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.stores).toHaveLength(200);
    expect(state.sessions).toHaveLength(1);
    expect(Array.from(state.stores.values()).every((store) => store.sections.length === 0)).toBe(true);
    expect(Array.from(state.stores.values()).every((store) => (
      store.bloomFilter === undefined
    ))).toBe(true);
    expect(getSections).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
    expect(state.loadStats).toMatchObject({
      discoveredStores: 200,
      activeSessions: 1,
      startupContentBytes: 0,
      residentMetadataSections: 0,
      deferredMetadataSections: 0,
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
      metadataOnlyStores: 200,
      deferredStores: 200,
    });
    expect(state.hydrationStates.get('store-1')).toMatchObject({
      metadata: 'deferred',
      content: 'deferred',
    });
  });

  it('records authoritative grouped section totals without invoking the metadata projection at startup', () => {
    const getSectionCountsByStore = vi.fn(() => [
      { store_id: 'store-1', section_count: 5_001 },
      { store_id: 'store-2', section_count: 2 },
    ]);
    const getSectionMetadata = vi.fn(() => {
      throw new Error('startup must not project section metadata');
    });
    const db = {
      listStores: () => [storeRow(), storeRow({ id: 'store-2', instance_id: 'instance-2' })],
      listSessions: () => [],
      getSectionCountsByStore,
      getSectionMetadata,
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(getSectionCountsByStore).toHaveBeenCalledTimes(1);
    expect(getSectionMetadata).not.toHaveBeenCalled();
    expect(state.hydrationStates.get('store-1')).toMatchObject({
      metadata: 'deferred',
      sectionCount: 5_001,
      contentEligible: false,
    });
    expect(state.hydrationStates.get('store-2')).toMatchObject({
      sectionCount: 2,
      contentEligible: true,
    });
    expect(state.loadStats.deferredMetadataSections).toBe(5_003);
  });

  it('keeps the exact section limit content-eligible and defers a store one section over it', () => {
    const db = {
      listStores: () => [
        storeRow({ id: 'exact-limit' }),
        storeRow({ id: 'one-over-limit', instance_id: 'instance-2' }),
      ],
      getSectionCountsByStore: () => [
        { store_id: 'exact-limit', section_count: 5_000 },
        { store_id: 'one-over-limit', section_count: 5_001 },
      ],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.hydrationStates.get('exact-limit')).toMatchObject({
      sectionCount: 5_000,
      contentEligible: true,
    });
    expect(state.hydrationStates.get('one-over-limit')).toMatchObject({
      sectionCount: 5_001,
      contentEligible: false,
    });
  });

  it('uses an injected per-store section limit at the exact boundary and one over', () => {
    const db = {
      listStores: () => [
        storeRow({ id: 'exact-injected-limit' }),
        storeRow({ id: 'over-injected-limit', instance_id: 'instance-2' }),
      ],
      getSectionCountsByStore: () => [
        { store_id: 'exact-injected-limit', section_count: 2 },
        { store_id: 'over-injected-limit', section_count: 3 },
      ],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db, {
      ...DEFAULT_RLM_RESIDENCY_POLICY,
      maxSectionsPerStore: 2,
    });

    expect(state.hydrationStates.get('exact-injected-limit')).toMatchObject({
      sectionCount: 2,
      contentEligible: true,
    });
    expect(state.hydrationStates.get('over-injected-limit')).toMatchObject({
      sectionCount: 3,
      contentEligible: false,
    });
  });

  it('orders hot candidates by active session, recency, then store id', () => {
    const now = 1_000_000_000;
    const candidates = selectHotStoreCandidates(
      [
        storeRow({ id: 'older', last_accessed: now - (48 * 60 * 60 * 1_000) - 1 }),
        storeRow({ id: 'recent-b', last_accessed: now - 1_000 }),
        storeRow({ id: 'recent-a', last_accessed: now - 1_000 }),
        storeRow({ id: 'recent-c', last_accessed: now - 500 }),
        storeRow({ id: 'active-old', last_accessed: 1 }),
      ],
      new Set(['active-old']),
      now,
    );

    expect(candidates.map((store) => store.id)).toEqual([
      'active-old',
      'recent-c',
      'recent-a',
      'recent-b',
    ]);
  });

  it('orders active-session stores by their newest session activity before any store recency', () => {
    const now = 1_000_000_000;
    const candidates = selectHotStoreCandidates(
      [
        storeRow({ id: 'active-a', last_accessed: now - 1 }),
        storeRow({ id: 'active-z', last_accessed: 1 }),
        storeRow({ id: 'recent', last_accessed: now - 2 }),
      ],
      new Map([
        ['active-a', now - 2_000],
        ['active-z', now - 1_000],
      ]),
      now,
    );

    expect(candidates.map((store) => store.id)).toEqual([
      'active-z',
      'active-a',
      'recent',
    ]);
  });

  it('uses active-session activity from a custom ReadonlyMap implementation', () => {
    const now = 1_000_000_000;
    const candidates = selectHotStoreCandidates(
      [
        storeRow({ id: 'active-a', last_accessed: now - 1 }),
        storeRow({ id: 'active-z', last_accessed: 1 }),
      ],
      new ReadonlyMapWrapper(new Map([
        ['active-a', now - 2_000],
        ['active-z', now - 1_000],
      ])),
      now,
    );

    expect(candidates.map((store) => store.id)).toEqual(['active-z', 'active-a']);
  });

  it('ranks remaining hot candidates by the newer of last access and creation time', () => {
    const now = 1_000_000_000;
    const candidates = selectHotStoreCandidates(
      [
        storeRow({ id: 'recent-access', last_accessed: now - 500, created_at: 1 }),
        storeRow({ id: 'recent-created', last_accessed: 1, created_at: now - 100 }),
        storeRow({ id: 'outside-window', last_accessed: 1, created_at: 1 }),
      ],
      new Set(),
      now,
    );

    expect(candidates.map((store) => store.id)).toEqual([
      'recent-created',
      'recent-access',
    ]);
  });

  it('includes a store exactly at the 48-hour hot cutoff and excludes one just before it', () => {
    const now = 1_000_000_000;
    const cutoff = now - (48 * 60 * 60 * 1_000);
    const candidates = selectHotStoreCandidates(
      [
        storeRow({ id: 'at-access-cutoff', last_accessed: cutoff, created_at: 1 }),
        storeRow({ id: 'at-created-cutoff', last_accessed: 1, created_at: cutoff }),
        storeRow({ id: 'before-cutoff', last_accessed: cutoff - 1, created_at: 1 }),
      ],
      new Set(),
      now,
    );

    expect(candidates.map((store) => store.id)).toEqual([
      'at-access-cutoff',
      'at-created-cutoff',
    ]);
  });

  it('skips a corrupt active session row while retaining later valid sessions and all store counts', () => {
    const db = {
      listStores: () => [
        storeRow({ id: 'store-1' }),
        storeRow({ id: 'store-2', instance_id: 'instance-2' }),
      ],
      getSectionCountsByStore: () => [
        { store_id: 'store-1', section_count: 2 },
        { store_id: 'store-2', section_count: 1 },
      ],
      listSessions: () => [
        activeSessionRow({ queries_json: '{not valid json' }),
        activeSessionRow({
          id: 'session-2',
          store_id: 'store-2',
          instance_id: 'instance-2',
        }),
      ],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(Array.from(state.sessions.keys())).toEqual(['session-2']);
    expect(state.stores).toHaveLength(2);
    expect(state.loadStats).toMatchObject({
      discoveredStores: 2,
      activeSessions: 1,
      deferredMetadataSections: 3,
    });
  });

  it('treats an empty session-history string as corrupt rather than an empty history', () => {
    const db = {
      listStores: () => [storeRow()],
      getSectionCountsByStore: () => [],
      listSessions: () => [
        activeSessionRow({ id: 'empty-history', queries_json: '' }),
        activeSessionRow({ id: 'valid-history' }),
      ],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(Array.from(state.sessions.keys())).toEqual(['valid-history']);
    expect(state.loadStats.activeSessions).toBe(1);
  });

  it('does not restore a session with a zero ended timestamp as active', () => {
    const db = {
      listStores: () => [storeRow()],
      getSectionCountsByStore: () => [],
      listSessions: () => [activeSessionRow({ ended_at: 0 })],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.sessions).toHaveLength(0);
    expect(state.loadStats.activeSessions).toBe(0);
  });

  it('isolates a corrupt store config without dropping any other store shells or counts', () => {
    const db = {
      listStores: () => [
        storeRow({ id: 'corrupt-config', config_json: '{invalid json' }),
        storeRow({
          id: 'valid-config',
          instance_id: 'instance-2',
          config_json: JSON.stringify({ label: 'valid' }),
        }),
      ],
      getSectionCountsByStore: () => [
        { store_id: 'corrupt-config', section_count: 1 },
        { store_id: 'valid-config', section_count: 2 },
      ],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.stores).toHaveLength(2);
    expect(state.stores.get('corrupt-config')?.config).toBeUndefined();
    expect(state.stores.get('valid-config')?.config).toEqual({ label: 'valid' });
    expect(state.loadStats.deferredMetadataSections).toBe(3);
  });

  it('defers section metadata for a single persisted store without querying rows', () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => sectionRow({
      id: `sec-${index}`,
      start_offset: index,
    }));
    const getSections = vi.fn(() => rows);
    const db = {
      listStores: () => [storeRow()],
      getSectionCountsByStore: () => [],
      getSections,
      getSectionContent: vi.fn(() => 'content'),
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(getSections).not.toHaveBeenCalled();
    expect(state.stores.get('store-1')?.sections).toHaveLength(0);
    expect(state.loadedSections).toBe(0);
  });

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
      getSectionCountsByStore: () => [],
      getSections: () => [sectionRow()],
      getSectionContent,
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(getSectionContent).not.toHaveBeenCalled();
    expect(state.stores.get('store-1')?.sections).toHaveLength(0);
    expect(state.hydrationStates.get('store-1')?.contentEligible).toBe(false);
  });

  it('keeps normal stores above the token or size guard ineligible for content hydration', () => {
    const db = {
      listStores: () => [
        storeRow({
          id: 'over-token-limit',
          total_tokens: 2_000_001,
        }),
        storeRow({
          id: 'over-size-limit',
          total_size: (25 * 1024 * 1024) + 1,
        }),
      ],
      getSectionCountsByStore: () => [],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.hydrationStates.get('over-token-limit')?.contentEligible).toBe(false);
    expect(state.hydrationStates.get('over-size-limit')?.contentEligible).toBe(false);
  });

  it('keeps stores exactly at the token and size thresholds content-eligible', () => {
    const db = {
      listStores: () => [
        storeRow({ id: 'exact-token-limit', total_tokens: 2_000_000 }),
        storeRow({
          id: 'exact-size-limit',
          instance_id: 'instance-2',
          total_size: 25 * 1024 * 1024,
        }),
      ],
      getSectionCountsByStore: () => [],
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.hydrationStates.get('exact-token-limit')?.contentEligible).toBe(true);
    expect(state.hydrationStates.get('exact-size-limit')?.contentEligible).toBe(true);
  });

  it('keeps one oversized recent store as a metadata-only shell', () => {
    const getSections = vi.fn(() => [sectionRow()]);
    const getSectionContent = vi.fn(() => 'content');
    const db = {
      listStores: () => [storeRow({
        total_size: (25 * 1024 * 1024) + 1,
        last_accessed: Date.now(),
      })],
      getSectionCountsByStore: () => [{ store_id: 'store-1', section_count: 1 }],
      getSections,
      getSectionContent,
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(state.stores.get('store-1')?.sections).toEqual([]);
    expect(state.hydrationStates.get('store-1')?.contentEligible).toBe(false);
    expect(getSections).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
  });

  it('defers small normal-store content while marking it eligible for later hydration', () => {
    const getSectionContent = vi.fn(() => 'export {};');
    const db = {
      listStores: () => [storeRow()],
      getSectionCountsByStore: () => [],
      getSections: () => [sectionRow()],
      getSectionContent,
      listSessions: () => [],
    } as unknown as RLMDatabase;

    const state = loadPersistedContextState(db);

    expect(getSectionContent).not.toHaveBeenCalled();
    expect(state.stores.get('store-1')?.sections).toHaveLength(0);
    expect(state.hydrationStates.get('store-1')?.contentEligible).toBe(true);
  });
});
