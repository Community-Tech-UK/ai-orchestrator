import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextStore, RLMSession } from '../../shared/types/rlm.types';
import { RLMDatabase } from '../persistence/rlm-database';
import type {
  ContextSectionMetadataRow,
  ContextSectionRow,
} from '../persistence/rlm-database.types';
import {
  DEFAULT_RLM_RESIDENCY_POLICY,
  type PersistedContextState,
  type RlmPersistedLoadStats,
  type RlmResidencyPolicy,
  type RlmStoreHydrationState,
} from './context-persistence-loader';
import {
  ContextResidencyController,
  type ContextResidencyControllerOptions,
} from './context-residency-controller';
import { RLMContextManager } from './context-manager';
import { VectorStore } from './vector-store';

function store(id: string, lastAccessed = 1): ContextStore {
  return {
    id,
    instanceId: `instance-${id}`,
    sections: [],
    totalTokens: 10,
    totalSize: 10,
    createdAt: 1,
    lastAccessed,
    accessCount: 0,
    config: { label: id },
  };
}

function metadataRow(
  storeId: string,
  id: string,
  estimatedBytes: number,
  overrides: Partial<ContextSectionMetadataRow> = {},
): ContextSectionMetadataRow {
  return {
    id,
    store_id: storeId,
    type: 'file',
    name: `${id}.ts`,
    source: null,
    start_offset: 0,
    end_offset: estimatedBytes,
    tokens: 2,
    checksum: `checksum-${id}`,
    depth: 0,
    summarizes_json: null,
    parent_summary_id: null,
    file_path: `/repo/${id}.ts`,
    language: 'typescript',
    source_url: null,
    created_at: 1,
    content_file: null,
    content_size_bytes: estimatedBytes,
    ...overrides,
  };
}

function sectionRow(
  metadata: ContextSectionMetadataRow,
  content: string,
): ContextSectionRow {
  const { content_size_bytes: _contentSizeBytes, ...row } = metadata;
  return { ...row, content_inline: content };
}

function hydrationState(
  sectionCount: number,
  contentEligible = true,
): Readonly<RlmStoreHydrationState> {
  return Object.freeze({
    metadata: 'deferred',
    content: 'deferred',
    contentEligible,
    sectionCount,
  });
}

function loadStats(
  storeCount: number,
  sectionCount: number,
): Readonly<RlmPersistedLoadStats> {
  return Object.freeze({
    discoveredStores: storeCount,
    activeSessions: 0,
    startupContentBytes: 0,
    residentMetadataSections: 0,
    deferredMetadataSections: sectionCount,
    residentContentBytes: 0,
    residentContentSections: 0,
    residentContentStores: 0,
    hotCandidates: 0,
    hotAdmitted: 0,
    hotSkipped: 0,
    hotExhausted: 0,
    hotCancelled: 0,
    semanticDiscovered: 0,
    semanticIndexed: 0,
    semanticSkipped: 0,
    semanticFailed: 0,
    semanticRetried: 0,
    metadataOnlyStores: storeCount,
    deferredStores: storeCount,
    exhausted: Object.freeze({
      metadata: false,
      contentBytes: false,
      contentSections: false,
      contentStores: false,
    }),
    elapsedMs: 0,
  });
}

function activeSession(storeId: string): RLMSession {
  return {
    id: `session-${storeId}`,
    storeId,
    instanceId: `instance-${storeId}`,
    queries: [],
    recursiveCalls: [],
    totalRootTokens: 0,
    totalSubQueryTokens: 0,
    estimatedDirectTokens: 10,
    tokenSavingsPercent: 0,
    startedAt: 1,
    lastActivityAt: 1,
  };
}

function policy(overrides: Partial<RlmResidencyPolicy> = {}): RlmResidencyPolicy {
  return {
    ...DEFAULT_RLM_RESIDENCY_POLICY,
    maxResidentSectionMetadata: 10,
    maxResidentContentBytes: 100,
    maxResidentContentSections: 10,
    maxResidentContentStores: 10,
    ...overrides,
  };
}

function controllerFixture(options: {
  rowsByStore: Record<string, ContextSectionMetadataRow[]>;
  contentBySection?: Record<string, string>;
  sessions?: RLMSession[];
  policy?: RlmResidencyPolicy;
  now?: () => number;
}): {
  controller: ContextResidencyController;
  stores: Map<string, ContextStore>;
  getSectionMetadata: ReturnType<typeof vi.fn>;
  getSectionStatsByType: ReturnType<typeof vi.fn>;
  getSection: ReturnType<typeof vi.fn>;
  getSectionContent: ReturnType<typeof vi.fn>;
} {
  const stores = new Map<string, ContextStore>();
  const hydrationStates = new Map<string, Readonly<RlmStoreHydrationState>>();
  let totalSections = 0;
  for (const [storeId, rows] of Object.entries(options.rowsByStore)) {
    stores.set(storeId, store(storeId));
    hydrationStates.set(storeId, hydrationState(rows.length));
    totalSections += rows.length;
  }

  const rowsBySection = new Map<string, ContextSectionRow>();
  for (const rows of Object.values(options.rowsByStore)) {
    for (const row of rows) {
      const content = options.contentBySection?.[row.id] ?? 'data';
      rowsBySection.set(row.id, sectionRow(row, content));
    }
  }

  const getSectionMetadata = vi.fn((storeId: string) => options.rowsByStore[storeId] ?? []);
  const getSectionStatsByType = vi.fn(() => {
    const totals = new Map<string, { section_count: number; total_tokens: number }>();
    for (const row of Object.values(options.rowsByStore).flat()) {
      const current = totals.get(row.type) ?? { section_count: 0, total_tokens: 0 };
      current.section_count += 1;
      current.total_tokens += row.tokens;
      totals.set(row.type, current);
    }
    return Array.from(totals, ([type, values]) => ({ type, ...values }))
      .sort((left, right) => left.type.localeCompare(right.type));
  });
  const getSection = vi.fn((sectionId: string) => rowsBySection.get(sectionId) ?? null);
  const getSectionContent = vi.fn((row: ContextSectionRow) => (
    options.contentBySection?.[row.id] ?? row.content_inline ?? ''
  ));
  const db = {
    getSectionMetadata,
    getSectionStatsByType,
    getSection,
    getSectionContent,
  } as unknown as RLMDatabase;
  const sessions = new Map(
    (options.sessions ?? []).map((session) => [session.id, session]),
  );
  const initialState: PersistedContextState = {
    stores,
    sessions,
    loadedStores: stores.size,
    loadedSections: 0,
    loadStats: loadStats(stores.size, totalSections),
    hydrationStates,
  };
  const controllerOptions: ContextResidencyControllerOptions = {
    db,
    stores,
    sessions,
    hydrationStates: initialState.hydrationStates,
    loadStats: initialState.loadStats,
    policy: options.policy ?? policy(),
    ...(options.now ? { now: options.now } : {}),
  };

  return {
    controller: new ContextResidencyController(controllerOptions),
    stores,
    getSectionMetadata,
    getSectionStatsByType,
    getSection,
    getSectionContent,
  };
}

describe('ContextResidencyController', () => {
  it('prewarms active-session stores before recent stores and excludes stores outside one captured cutoff', async () => {
    vi.useFakeTimers();
    try {
      const now = vi.fn()
        .mockReturnValueOnce(1_000_000)
        .mockReturnValue(10_000_000);
      const newerActive = activeSession('active-new');
      newerActive.lastActivityAt = 900;
      const olderActive = activeSession('active-old');
      olderActive.lastActivityAt = 800;
      const { controller, stores, getSectionContent } = controllerFixture({
        rowsByStore: {
          'active-new': [metadataRow('active-new', 'section-active-new', 4)],
          'active-old': [metadataRow('active-old', 'section-active-old', 4)],
          recent: [metadataRow('recent', 'section-recent', 4)],
          boundary: [metadataRow('boundary', 'section-boundary', 4)],
          old: [metadataRow('old', 'section-old', 4)],
        },
        sessions: [olderActive, newerActive],
        policy: policy({ hotWindowMs: 100 }),
        now,
      });
      stores.get('recent')!.lastAccessed = 999_950;
      stores.get('boundary')!.lastAccessed = 999_900;
      stores.get('old')!.lastAccessed = 999_899;

      const prewarm = controller as unknown as {
        startHotPrewarm(): boolean;
        getHotPrewarmStats(): {
          running: boolean;
          candidates: number;
          admitted: number;
          skipped: number;
          exhausted: number;
          cancelled: number;
        };
      };
      expect(prewarm.startHotPrewarm()).toBe(true);
      expect(prewarm.startHotPrewarm()).toBe(false);
      expect(getSectionContent).not.toHaveBeenCalled();

      await vi.advanceTimersToNextTimerAsync();
      expect(getSectionContent).toHaveBeenCalledTimes(1);
      expect(getSectionContent.mock.calls[0]?.[0].id).toBe('section-active-new');
      await vi.advanceTimersToNextTimerAsync();
      expect(getSectionContent.mock.calls[1]?.[0].id).toBe('section-active-old');
      await vi.advanceTimersToNextTimerAsync();
      expect(getSectionContent.mock.calls[2]?.[0].id).toBe('section-recent');
      await vi.advanceTimersToNextTimerAsync();
      expect(getSectionContent.mock.calls[3]?.[0].id).toBe('section-boundary');
      await vi.runAllTimersAsync();

      expect(getSectionContent).toHaveBeenCalledTimes(4);
      expect(now).toHaveBeenCalledTimes(5);
      expect(prewarm.getHotPrewarmStats()).toEqual({
        running: false,
        candidates: 4,
        admitted: 4,
        skipped: 0,
        exhausted: 0,
        cancelled: 0,
      });
      expect(controller.getStats()).toMatchObject({
        hotCandidates: 4,
        hotAdmitted: 4,
        hotSkipped: 0,
        hotCancelled: 0,
      });
      for (const store of stores.values()) expect(store.bloomFilter).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels before the next scheduled store and counts the unprocessed candidates once', async () => {
    vi.useFakeTimers();
    try {
      const { controller, getSectionContent } = controllerFixture({
        rowsByStore: {
          first: [metadataRow('first', 'section-first', 4)],
          second: [metadataRow('second', 'section-second', 4)],
          third: [metadataRow('third', 'section-third', 4)],
        },
        now: () => 10,
      });
      const prewarm = controller as unknown as {
        startHotPrewarm(): boolean;
        cancelHotPrewarm(): boolean;
        getHotPrewarmStats(): { cancelled: number; running: boolean };
      };

      expect(prewarm.startHotPrewarm()).toBe(true);
      await vi.advanceTimersToNextTimerAsync();
      expect(getSectionContent).toHaveBeenCalledTimes(1);
      expect(prewarm.cancelHotPrewarm()).toBe(true);
      expect(prewarm.cancelHotPrewarm()).toBe(false);
      await vi.runAllTimersAsync();

      expect(getSectionContent).toHaveBeenCalledTimes(1);
      expect(prewarm.getHotPrewarmStats()).toMatchObject({ running: false, cancelled: 2 });
      expect(controller.getStats().hotCancelled).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts a failed content read as skipped and yields before continuing', async () => {
    vi.useFakeTimers();
    try {
      const { controller, getSection, getSectionContent } = controllerFixture({
        rowsByStore: {
          first: [metadataRow('first', 'section-first', 4)],
          second: [metadataRow('second', 'section-second', 4)],
        },
        now: () => 10,
      });
      getSection.mockImplementationOnce(() => null);

      controller.startHotPrewarm();
      await vi.advanceTimersToNextTimerAsync();
      expect(getSectionContent).not.toHaveBeenCalled();
      expect(controller.getStats()).toMatchObject({ hotSkipped: 1, hotAdmitted: 0 });
      await vi.advanceTimersToNextTimerAsync();

      expect(getSectionContent).toHaveBeenCalledOnce();
      expect(controller.getStats()).toMatchObject({ hotSkipped: 1, hotAdmitted: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops immediately at an exact residency ceiling without evicting admitted content', async () => {
    vi.useFakeTimers();
    try {
      const { controller, stores, getSectionContent } = controllerFixture({
        rowsByStore: {
          first: [metadataRow('first', 'section-first', 4)],
          second: [metadataRow('second', 'section-second', 4)],
        },
        contentBySection: { 'section-first': 'aaaa', 'section-second': 'bbbb' },
        policy: policy({
          maxResidentContentBytes: 4,
          maxResidentContentSections: 1,
          maxResidentContentStores: 1,
        }),
        now: () => 10,
      });
      const prewarm = controller as unknown as {
        startHotPrewarm(): boolean;
        getHotPrewarmStats(): { admitted: number; exhausted: number; running: boolean };
      };

      prewarm.startHotPrewarm();
      await vi.runAllTimersAsync();

      expect(getSectionContent).toHaveBeenCalledTimes(1);
      expect(stores.get('first')?.sections[0].content).toBe('aaaa');
      expect(stores.get('second')?.sections).toEqual([]);
      expect(prewarm.getHotPrewarmStats()).toMatchObject({
        running: false,
        admitted: 1,
        exhausted: 1,
      });
      expect(controller.getStats()).toMatchObject({ hotAdmitted: 1, hotExhausted: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('hydrates content-free section metadata without exposing internal state in store config', () => {
    const row = metadataRow('store-a', 'section-a', 12, {
      summarizes_json: JSON.stringify(['source-a']),
      parent_summary_id: 'summary-parent',
    });
    const { controller, stores, getSection, getSectionContent } = controllerFixture({
      rowsByStore: { 'store-a': [row] },
    });

    const result = controller.ensureMetadata('store-a');

    expect(result).toMatchObject({ changed: true, state: { metadata: 'resident', content: 'deferred' } });
    expect(stores.get('store-a')?.sections).toEqual([{
      id: 'section-a',
      type: 'file',
      name: 'section-a.ts',
      content: '',
      tokens: 2,
      startOffset: 0,
      endOffset: 12,
      checksum: 'checksum-section-a',
      depth: 0,
      summarizes: ['source-a'],
      parentSummaryId: 'summary-parent',
      filePath: '/repo/section-a.ts',
      language: 'typescript',
    }]);
    expect(stores.get('store-a')?.config).toEqual({ label: 'store-a' });
    expect(getSection).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 1,
      deferredMetadataSections: 0,
      residentContentBytes: 0,
    });
  });

  it('returns hydration-state snapshots that reject runtime map mutation', () => {
    const { controller } = controllerFixture({
      rowsByStore: { 'store-a': [metadataRow('store-a', 'section-a', 4)] },
    });
    const snapshot = controller.getHydrationStates();
    const mutableAttempt = snapshot as Map<string, Readonly<RlmStoreHydrationState>>;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => mutableAttempt.set('injected', hydrationState(99))).toThrow(
      'Cannot mutate a readonly hydration-state map',
    );
    expect(snapshot.has('injected')).toBe(false);
    expect(controller.getHydrationState('injected')).toBeUndefined();
  });

  it('hydrates individually-small store content and accounts actual UTF-8 bytes', () => {
    const { controller, stores } = controllerFixture({
      rowsByStore: {
        'store-a': [
          metadataRow('store-a', 'section-a', 4),
          metadataRow('store-a', 'section-b', 4),
        ],
      },
      contentBySection: { 'section-a': 'cafe', 'section-b': 'éé' },
    });

    const result = controller.ensureContent('store-a');

    expect(result).toMatchObject({ changed: true, state: { metadata: 'resident', content: 'resident' } });
    expect(stores.get('store-a')?.sections.map((section) => section.content)).toEqual(['cafe', 'éé']);
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 2,
      deferredMetadataSections: 0,
      residentContentBytes: 8,
      residentContentSections: 2,
      residentContentStores: 1,
      metadataOnlyStores: 0,
      deferredStores: 0,
    });
  });

  it('discards all newly read content when actual UTF-8 bytes exceed the remaining ceiling', () => {
    const { controller, stores } = controllerFixture({
      rowsByStore: {
        'store-a': [metadataRow('store-a', 'section-a', 4)],
      },
      contentBySection: { 'section-a': '🚀🚀' },
      policy: policy({ maxResidentContentBytes: 7 }),
    });

    const result = controller.ensureContent('store-a');

    expect(result).toMatchObject({
      changed: true,
      reason: 'actual-content-exceeds-byte-budget',
      state: { metadata: 'resident', content: 'deferred' },
    });
    expect(stores.get('store-a')?.sections[0].content).toBe('');
    expect(controller.getStats()).toMatchObject({
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
      metadataOnlyStores: 1,
      deferredStores: 1,
      exhausted: { contentBytes: true },
      lastAdmissionFailure: {
        reason: 'actual-content-exceeds-byte-budget',
      },
    });
  });

  it('is idempotent for metadata and content hydration', () => {
    const { controller, getSectionMetadata, getSection, getSectionContent } = controllerFixture({
      rowsByStore: { 'store-a': [metadataRow('store-a', 'section-a', 4)] },
      contentBySection: { 'section-a': 'data' },
    });

    expect(controller.ensureContent('store-a').changed).toBe(true);
    expect(controller.ensureMetadata('store-a').changed).toBe(false);
    expect(controller.ensureContent('store-a').changed).toBe(false);

    expect(getSectionMetadata).toHaveBeenCalledTimes(1);
    expect(getSection).toHaveBeenCalledTimes(1);
    expect(getSectionContent).toHaveBeenCalledTimes(1);
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 1,
      residentContentBytes: 4,
      residentContentSections: 1,
      residentContentStores: 1,
    });
  });

  it('evicts the least-recently-used persisted content until every content ceiling fits', () => {
    const clockValues = [100, 200, 300];
    const { controller, stores } = controllerFixture({
      rowsByStore: {
        'store-a': [metadataRow('store-a', 'section-a', 4)],
        'store-b': [metadataRow('store-b', 'section-b', 4)],
        'store-c': [metadataRow('store-c', 'section-c', 4)],
      },
      contentBySection: { 'section-a': 'aaaa', 'section-b': 'bbbb', 'section-c': 'cccc' },
      policy: policy({
        maxResidentContentBytes: 8,
        maxResidentContentSections: 2,
        maxResidentContentStores: 2,
      }),
      now: () => clockValues.shift() ?? 400,
    });

    controller.ensureContent('store-a');
    controller.ensureContent('store-b');
    stores.get('store-a')!.bloomFilter = { bits: new Uint8Array(1), size: 8, hashCount: 1 };
    stores.get('store-b')!.bloomFilter = { bits: new Uint8Array(1), size: 8, hashCount: 1 };

    const result = controller.ensureContent('store-c');

    expect(result).toMatchObject({ changed: true, evictedStoreIds: ['store-a'] });
    expect(stores.get('store-a')?.sections[0].content).toBe('');
    expect(stores.get('store-a')?.bloomFilter).toBeUndefined();
    expect(stores.get('store-b')?.sections[0].content).toBe('bbbb');
    expect(stores.get('store-b')?.bloomFilter).toBeDefined();
    expect(stores.get('store-c')?.sections[0].content).toBe('cccc');
    expect(controller.getStats()).toMatchObject({
      residentContentBytes: 8,
      residentContentSections: 2,
      residentContentStores: 2,
      metadataOnlyStores: 1,
      deferredStores: 1,
    });
  });

  it('never lets a resident empty store release a content-store slot it does not own', () => {
    const clockValues = [100, 200, 300];
    const { controller, stores } = controllerFixture({
      rowsByStore: {
        empty: [],
        populated: [metadataRow('populated', 'section-populated', 4)],
        requested: [metadataRow('requested', 'section-requested', 4)],
      },
      contentBySection: {
        'section-populated': 'data',
        'section-requested': 'next',
      },
      policy: policy({ maxResidentContentStores: 1 }),
      now: () => clockValues.shift() ?? 400,
    });
    controller.ensureContent('empty');
    controller.ensureContent('populated');

    const result = controller.ensureContent('requested');

    expect(result).toMatchObject({
      state: { content: 'resident' },
      evictedStoreIds: ['populated'],
    });
    expect(controller.getHydrationState('empty')?.content).toBe('resident');
    expect(stores.get('populated')?.sections[0].content).toBe('');
    expect(stores.get('requested')?.sections[0].content).toBe('next');
    const residentNonEmptyStores = ['populated', 'requested'].filter(
      (storeId) => controller.getHydrationState(storeId)?.content === 'resident',
    );
    expect(residentNonEmptyStores).toEqual(['requested']);
    expect(controller.getStats().residentContentStores).toBe(1);
  });

  it('continues LRU eviction when actual content bytes exceed the admitted estimate', () => {
    const clockValues = [100, 200, 300];
    const { controller, stores } = controllerFixture({
      rowsByStore: {
        'store-a': [metadataRow('store-a', 'section-a', 3)],
        'store-b': [metadataRow('store-b', 'section-b', 4)],
        'store-c': [metadataRow('store-c', 'section-c', 5)],
      },
      contentBySection: {
        'section-a': 'aaa',
        'section-b': 'bbbb',
        'section-c': '1234567',
      },
      policy: policy({ maxResidentContentBytes: 10 }),
      now: () => clockValues.shift() ?? 400,
    });
    controller.ensureContent('store-a');
    controller.ensureContent('store-b');

    const result = controller.ensureContent('store-c');

    expect(result).toMatchObject({
      changed: true,
      evictedStoreIds: ['store-a', 'store-b'],
      state: { content: 'resident' },
    });
    expect(result.reason).toBeUndefined();
    expect(stores.get('store-a')?.sections[0].content).toBe('');
    expect(stores.get('store-b')?.sections[0].content).toBe('');
    expect(stores.get('store-c')?.sections[0].content).toBe('1234567');
    expect(controller.getStats()).toMatchObject({
      residentContentBytes: 7,
      residentContentSections: 1,
      residentContentStores: 1,
      metadataOnlyStores: 2,
      deferredStores: 2,
    });
  });

  it('protects active-session content and reports when protected occupancy blocks admission', () => {
    const { controller, stores } = controllerFixture({
      rowsByStore: {
        protected: [metadataRow('protected', 'section-protected', 4)],
        requested: [metadataRow('requested', 'section-requested', 4)],
      },
      contentBySection: {
        'section-protected': 'safe',
        'section-requested': 'next',
      },
      sessions: [activeSession('protected')],
      policy: policy({
        maxResidentContentBytes: 4,
        maxResidentContentSections: 1,
        maxResidentContentStores: 1,
      }),
    });
    controller.ensureContent('protected');
    stores.get('protected')!.bloomFilter = { bits: new Uint8Array(1), size: 8, hashCount: 1 };

    const result = controller.ensureContent('requested');

    expect(result).toMatchObject({
      changed: true,
      reason: 'protected-content-prevents-admission',
      state: { metadata: 'resident', content: 'deferred' },
      evictedStoreIds: [],
    });
    expect(stores.get('protected')?.sections[0].content).toBe('safe');
    expect(stores.get('protected')?.bloomFilter).toBeDefined();
    expect(stores.get('requested')?.sections[0].content).toBe('');
    expect(controller.getStats()).toMatchObject({
      residentContentBytes: 4,
      residentContentSections: 1,
      residentContentStores: 1,
      metadataOnlyStores: 1,
      deferredStores: 1,
      lastAdmissionFailure: {
        reason: 'protected-content-prevents-admission',
      },
      exhausted: {
        contentBytes: true,
        contentSections: true,
        contentStores: true,
      },
    });
  });

  it('enforces the exact metadata ceiling without querying a store that cannot fit', () => {
    const { controller, stores, getSectionMetadata } = controllerFixture({
      rowsByStore: {
        'store-a': [metadataRow('store-a', 'section-a', 1)],
        'store-b': [metadataRow('store-b', 'section-b', 1)],
      },
      policy: policy({ maxResidentSectionMetadata: 1 }),
    });

    expect(controller.ensureMetadata('store-a')).toMatchObject({ changed: true });
    expect(controller.ensureMetadata('store-b')).toMatchObject({
      changed: false,
      reason: 'metadata-budget-exhausted',
      state: { metadata: 'deferred', content: 'deferred' },
    });
    expect(getSectionMetadata).toHaveBeenCalledTimes(1);
    expect(stores.get('store-b')?.sections).toEqual([]);
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 1,
      deferredMetadataSections: 1,
      exhausted: { metadata: true },
    });
  });

  it('keeps individually-large stores metadata-only without reading any section content', () => {
    const rows = [metadataRow('large', 'large-section', 4)];
    const stores = new Map([['large', store('large')]]);
    const sessions = new Map<string, RLMSession>();
    const getSectionMetadata = vi.fn(() => rows);
    const getSection = vi.fn(() => sectionRow(rows[0], 'data'));
    const getSectionContent = vi.fn(() => 'data');
    const controller = new ContextResidencyController({
      db: { getSectionMetadata, getSection, getSectionContent } as unknown as RLMDatabase,
      stores,
      sessions,
      hydrationStates: new Map([['large', hydrationState(1, false)]]),
      loadStats: loadStats(1, 1),
      policy: policy(),
    });

    expect(controller.ensureContent('large')).toMatchObject({
      changed: true,
      reason: 'content-ineligible',
      state: { metadata: 'resident', content: 'deferred', contentEligible: false },
    });
    expect(getSectionMetadata).toHaveBeenCalledTimes(1);
    expect(getSection).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
    expect(stores.get('large')?.sections[0].content).toBe('');
  });

  it('keeps the controller policy authoritative when loader state used a wider limit', () => {
    const rows = [
      metadataRow('over-policy', 'section-1', 1),
      metadataRow('over-policy', 'section-2', 1),
      metadataRow('over-policy', 'section-3', 1),
    ];
    const { controller, getSection, getSectionContent } = controllerFixture({
      rowsByStore: { 'over-policy': rows },
      policy: policy({ maxSectionsPerStore: 2 }),
    });

    expect(controller.getHydrationState('over-policy')).toMatchObject({
      contentEligible: false,
      sectionCount: 3,
    });
    expect(controller.ensureContent('over-policy')).toMatchObject({
      reason: 'content-ineligible',
      state: { metadata: 'resident', content: 'deferred' },
    });
    expect(getSection).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
  });

  it('rechecks the per-store ceiling when the metadata projection is larger than its grouped count', () => {
    const rows = [
      metadataRow('changed-store', 'section-1', 1),
      metadataRow('changed-store', 'section-2', 1),
      metadataRow('changed-store', 'section-3', 1),
    ];
    const stores = new Map([['changed-store', store('changed-store')]]);
    const getSectionMetadata = vi.fn(() => rows);
    const getSection = vi.fn((sectionId: string) => (
      sectionRow(rows.find((row) => row.id === sectionId)!, 'x')
    ));
    const getSectionContent = vi.fn(() => 'x');
    const controller = new ContextResidencyController({
      db: { getSectionMetadata, getSection, getSectionContent } as unknown as RLMDatabase,
      stores,
      sessions: new Map(),
      hydrationStates: new Map([['changed-store', hydrationState(2)]]),
      loadStats: loadStats(1, 2),
      policy: policy({ maxSectionsPerStore: 2 }),
    });

    expect(controller.ensureContent('changed-store')).toMatchObject({
      reason: 'content-ineligible',
      state: {
        metadata: 'resident',
        content: 'deferred',
        contentEligible: false,
        sectionCount: 3,
      },
    });
    expect(getSection).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
  });

  it('collects aggregate stats with one grouped query and no deferred metadata paging', () => {
    const manyRows = Array.from({ length: 1_001 }, (_, index) => metadataRow(
      'many',
      `many-${index}`,
      1,
      { type: index % 2 === 0 ? 'file' : 'external', tokens: 3 },
    ));
    const { controller, stores, getSectionMetadata, getSectionStatsByType } = controllerFixture({
      rowsByStore: {
        many: manyRows,
        second: [metadataRow('second', 'second-1', 1, { type: 'external', tokens: 5 })],
      },
    });

    expect(controller.getStorageStats()).toEqual({
      totalStores: 2,
      totalSections: 1_002,
      totalTokens: 20,
      totalSizeBytes: 20,
      byType: [
        { type: 'external', count: 501, tokens: 1_505 },
        { type: 'file', count: 501, tokens: 1_503 },
      ],
    });
    expect(getSectionStatsByType).toHaveBeenCalledTimes(1);
    expect(getSectionMetadata).not.toHaveBeenCalled();
    expect(stores.get('many')?.sections).toEqual([]);
    expect(stores.get('second')?.sections).toEqual([]);
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 0,
      deferredMetadataSections: 1_002,
    });
  });

  it('accounts added and removed resident content without re-reading the database', () => {
    const { controller, stores, getSection, getSectionContent } = controllerFixture({
      rowsByStore: { 'store-a': [metadataRow('store-a', 'section-a', 4)] },
      contentBySection: { 'section-a': 'data' },
    });
    controller.ensureContent('store-a');
    getSection.mockClear();
    getSectionContent.mockClear();

    const added = {
      id: 'section-added',
      type: 'external' as const,
      name: 'added.txt',
      content: 'café',
      tokens: 2,
      startOffset: 4,
      endOffset: 8,
      checksum: 'checksum-added',
      depth: 0,
    };
    stores.get('store-a')!.sections.push(added);
    controller.accountSectionsAdded('store-a', [added]);

    expect(getSection).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
    expect(controller.getHydrationState('store-a')?.sectionCount).toBe(2);
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 2,
      residentContentBytes: 9,
      residentContentSections: 2,
      residentContentStores: 1,
    });

    stores.get('store-a')!.sections.splice(0, 1);
    controller.accountSectionRemoved('store-a', {
      id: 'section-a',
      type: 'file',
      name: 'section-a.ts',
      content: 'data',
      tokens: 2,
      startOffset: 0,
      endOffset: 4,
      checksum: 'checksum-section-a',
      depth: 0,
    });
    expect(controller.getHydrationState('store-a')?.sectionCount).toBe(1);
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 1,
      residentContentBytes: 5,
      residentContentSections: 1,
      residentContentStores: 1,
    });
  });

  it('registers a runtime store and clears every retained runtime reference on reset', () => {
    const { controller, stores } = controllerFixture({ rowsByStore: {} });
    const runtimeStore = store('runtime');
    runtimeStore.sections.push({
      id: 'runtime-section',
      type: 'external',
      name: 'runtime.txt',
      content: 'runtime',
      tokens: 2,
      startOffset: 0,
      endOffset: 7,
      checksum: 'runtime-checksum',
      depth: 0,
    });
    runtimeStore.bloomFilter = { bits: new Uint8Array(1), size: 8, hashCount: 1 };
    stores.set(runtimeStore.id, runtimeStore);

    controller.registerRuntimeStore(runtimeStore);
    expect(controller.getHydrationState('runtime')).toMatchObject({
      metadata: 'resident',
      content: 'resident',
      sectionCount: 1,
    });
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 1,
      residentContentBytes: 7,
      residentContentSections: 1,
      residentContentStores: 1,
    });

    controller.clear();
    expect(runtimeStore.sections).toEqual([]);
    expect(runtimeStore.bloomFilter).toBeUndefined();
    expect(controller.getHydrationState('runtime')).toBeUndefined();
    expect(controller.getStats()).toMatchObject({
      residentMetadataSections: 0,
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
    });
  });
});

describe('RLMContextManager residency ownership', () => {
  let temporaryRoot: string | undefined;

  afterEach(() => {
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
    temporaryRoot = undefined;
  });

  it('keeps persisted shells listable without consuming metadata residency', () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-residency-manager-'));
    const db = RLMDatabase.getInstance({
      dbPath: path.join(temporaryRoot, 'rlm.db'),
      contentDir: path.join(temporaryRoot, 'content'),
    });
    db.createStore({ id: 'persisted-store', instanceId: 'persisted-instance' });
    db.addSection({
      id: 'persisted-section',
      storeId: 'persisted-store',
      type: 'file',
      name: 'persisted.ts',
      startOffset: 0,
      endOffset: 4,
      tokens: 1,
      content: 'data',
    });

    const manager = RLMContextManager.getInstance();

    vi.useFakeTimers();
    vi.runAllTimers();
    vi.useRealTimers();

    expect(manager.getStoreHydrationState('persisted-store')).toEqual({
      metadata: 'deferred',
      content: 'deferred',
      contentEligible: true,
      sectionCount: 1,
    });
    expect(manager.listStores().find((store) => store.id === 'persisted-store')?.sections).toEqual([]);
    expect(manager.getResidencyStats()).toMatchObject({
      discoveredStores: 1,
      residentMetadataSections: 0,
      deferredMetadataSections: 1,
      residentContentBytes: 0,
      metadataOnlyStores: 1,
      deferredStores: 1,
    });
  });
});
