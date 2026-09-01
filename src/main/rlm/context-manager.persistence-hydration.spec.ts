import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embed = vi.fn(async (text: string) => ({
  embedding: [text.length % 5, (text.length * 2) % 5, 1],
  model: 'test-embed',
  tokens: Math.ceil(text.length / 4),
  cached: false,
  provider: 'test',
}));

vi.mock('./embedding-service', () => ({
  getEmbeddingService: () => ({
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map((text) => embed(text))),
    findSimilar: (
      _query: ArrayLike<number>,
      candidates: { id: string; embedding: ArrayLike<number> }[],
      topK = 10,
    ) => candidates.slice(0, topK).map((candidate) => ({
      id: candidate.id,
      similarity: 0.9,
    })),
  }),
  EmbeddingService: class {},
}));

import { RLMDatabase } from '../persistence/rlm-database';
import { RLMContextManager } from './context-manager';
import {
  DEFAULT_RLM_RESIDENCY_POLICY,
  type RlmResidencyPolicy,
} from './context-persistence-loader';
import {
  ContextResidencyController,
} from './context-residency-controller';
import { VectorStore } from './vector-store';
import type { ContextStore, RLMSession } from '../../shared/types/rlm.types';

interface SeedSection {
  id: string;
  name: string;
  content: string;
  tokens: number;
}

describe('RLMContextManager persisted-store hydration guards', () => {
  let temporaryRoot: string;
  let db: RLMDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-manager-hydration-'));
    RLMDatabase._resetForTesting();
    db = RLMDatabase.getInstance({
      dbPath: path.join(temporaryRoot, 'rlm.db'),
      contentDir: path.join(temporaryRoot, 'content'),
    });
    VectorStore._resetForTesting();
    RLMContextManager._resetForTesting();
  });

  afterEach(() => {
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  function seedStore(
    storeId = 'persisted-store',
    sections: SeedSection[] = [
      { id: 'section-alpha', name: 'alpha.txt', content: 'alpha lexical needle', tokens: 4 },
      { id: 'section-beta', name: 'beta.txt', content: 'beta supporting note', tokens: 3 },
    ],
    config?: Record<string, unknown>,
  ): void {
    db.createStore({ id: storeId, instanceId: `instance-${storeId}`, config });
    let startOffset = 0;
    for (const section of sections) {
      db.addSection({
        id: section.id,
        storeId,
        type: 'external',
        name: section.name,
        startOffset,
        endOffset: startOffset + section.content.length,
        tokens: section.tokens,
        content: section.content,
      });
      startOffset += section.content.length;
    }
  }

  function replaceResidencyPolicy(
    manager: RLMContextManager,
    overrides: Partial<RlmResidencyPolicy>,
  ): void {
    const internals = manager as unknown as {
      stores: Map<string, ContextStore>;
      sessions: Map<string, RLMSession>;
      residencyController: ContextResidencyController;
    };
    const current = internals.residencyController;
    internals.residencyController = new ContextResidencyController({
      db,
      stores: internals.stores,
      sessions: internals.sessions,
      hydrationStates: current.getHydrationStates(),
      loadStats: current.getStats(),
      policy: { ...DEFAULT_RLM_RESIDENCY_POLICY, ...overrides },
    });
  }

  it('hydrates metadata for section lists, store details, and exact stats, then content for export', () => {
    seedStore();
    const manager = RLMContextManager.getInstance();

    expect(manager.getStoreHydrationState('persisted-store')).toMatchObject({
      metadata: 'deferred',
      content: 'deferred',
      sectionCount: 2,
    });

    expect(manager.listSections('persisted-store')).toEqual([
      expect.objectContaining({ id: 'section-alpha', content: '' }),
      expect.objectContaining({ id: 'section-beta', content: '' }),
    ]);
    expect(manager.getStore('persisted-store')?.sections).toHaveLength(2);
    expect(manager.getStoreStats('persisted-store')).toMatchObject({
      sections: 2,
      originalSections: 2,
      summaries: 0,
      totalTokens: 7,
    });
    expect(manager.getStorageStats()).toMatchObject({
      totalStores: 1,
      totalSections: 2,
      totalTokens: 7,
      totalSizeBytes: Buffer.byteLength('alpha lexical needlebeta supporting note', 'utf8'),
      byType: [{ type: 'external', count: 2, tokens: 7 }],
    });

    const exported = manager.exportStore('persisted-store');
    expect(exported?.store.sections.map((section) => section.content)).toEqual([
      'alpha lexical needle',
      'beta supporting note',
    ]);
    expect(manager.getStoreHydrationState('persisted-store')).toMatchObject({
      metadata: 'resident',
      content: 'resident',
      sectionCount: 2,
    });
  });

  it('hydrates content before lexical queries, optimized search, and Bloom construction', async () => {
    seedStore();
    const manager = RLMContextManager.getInstance();
    const session = await manager.startSession('persisted-store', 'instance-persisted-store');

    const queryResult = await manager.executeQuery(session.id, {
      type: 'grep',
      params: { pattern: 'needle' },
    });
    expect(queryResult.sectionsAccessed).toEqual(['section-alpha']);
    expect(queryResult.result).toContain('alpha lexical needle');

    expect(manager.searchStoreOptimized('persisted-store', ['supporting'])).toMatchObject({
      sectionsAccessed: ['section-beta'],
    });
    manager.rebuildBloomFilter('persisted-store');
    expect(manager.getStore('persisted-store')?.bloomFilter).toBeDefined();
    expect(manager.getResidencyStats()).toMatchObject({
      residentContentBytes: Buffer.byteLength('alpha lexical needlebeta supporting note', 'utf8'),
      residentContentSections: 2,
      residentContentStores: 1,
    });
  });

  it('throws a typed failure instead of querying, indexing, searching, filtering, or exporting empty deferred content', async () => {
    seedStore('large-store', [
      { id: 'large-section', name: 'large.txt', content: 'must never embed empty content', tokens: 6 },
    ], { kind: 'codebase-auto' });
    const manager = RLMContextManager.getInstance();
    const session = await manager.startSession('large-store', 'instance-large-store');
    const expected = expect.objectContaining({
      name: 'RlmHydrationError',
      storeId: 'large-store',
      reason: 'content-ineligible',
    });

    await expect(manager.executeQuery(session.id, {
      type: 'grep',
      params: { pattern: 'never' },
    })).rejects.toEqual(expected);
    expect(() => manager.searchStoreOptimized('large-store', ['never'])).toThrowError(expected);
    expect(() => manager.rebuildBloomFilter('large-store')).toThrowError(expected);
    await expect(manager.indexStoreForSemanticSearch('large-store')).rejects.toEqual(expected);
    expect(() => manager.exportStore('large-store')).toThrowError(expected);
    expect(embed).not.toHaveBeenCalled();
  });

  it.each([
    ['content-byte-budget-exhausted', { maxResidentContentBytes: 1 }],
    ['content-section-budget-exhausted', { maxResidentContentSections: 0 }],
    ['content-store-budget-exhausted', { maxResidentContentStores: 0 }],
  ] as const)('surfaces the %s absolute admission failure', async (reason, policyOverride) => {
    seedStore('bounded-store', [
      { id: 'bounded-section', name: 'bounded.txt', content: 'bounded', tokens: 2 },
    ]);
    const manager = RLMContextManager.getInstance();
    replaceResidencyPolicy(manager, policyOverride);
    const session = await manager.startSession('bounded-store', 'instance-bounded-store');

    await expect(manager.executeQuery(session.id, {
      type: 'grep',
      params: { pattern: 'bounded' },
    })).rejects.toMatchObject({ name: 'RlmHydrationError', reason });
  });

  it('surfaces protected-content pressure and content-read failures', async () => {
    seedStore('protected-store', [
      { id: 'protected-section', name: 'protected.txt', content: 'protected', tokens: 2 },
    ]);
    seedStore('requested-store', [
      { id: 'requested-section', name: 'requested.txt', content: 'requested', tokens: 2 },
    ]);
    const manager = RLMContextManager.getInstance();
    replaceResidencyPolicy(manager, { maxResidentContentStores: 1 });
    const protectedSession = await manager.startSession('protected-store', 'protected-instance');
    await manager.executeQuery(protectedSession.id, {
      type: 'grep',
      params: { pattern: 'protected' },
    });
    const requestedSession = await manager.startSession('requested-store', 'requested-instance');

    await expect(manager.executeQuery(requestedSession.id, {
      type: 'grep',
      params: { pattern: 'requested' },
    })).rejects.toMatchObject({
      name: 'RlmHydrationError',
      reason: 'protected-content-prevents-admission',
    });

    manager.endSession(protectedSession.id);
    manager.endSession(requestedSession.id);
    const contentRead = vi.spyOn(db, 'getSectionContent').mockImplementation(() => {
      throw new Error('read failed');
    });
    manager.reloadFromPersistence();
    const readSession = await manager.startSession('requested-store', 'requested-instance');
    await expect(manager.executeQuery(readSession.id, {
      type: 'grep',
      params: { pattern: 'requested' },
    })).rejects.toMatchObject({
      name: 'RlmHydrationError',
      reason: 'content-read-failed',
    });
    contentRead.mockRestore();
  });

  it('does not misreport a metadata-deferred store or consume metadata residency for aggregate stats', () => {
    seedStore('first-store', [
      { id: 'first-section', name: 'first.txt', content: 'first', tokens: 2 },
    ]);
    seedStore('second-store', [
      { id: 'second-section', name: 'second.txt', content: 'second', tokens: 3 },
    ]);
    const manager = RLMContextManager.getInstance();
    replaceResidencyPolicy(manager, { maxResidentSectionMetadata: 1 });
    expect(manager.listSections('first-store')).toHaveLength(1);

    expect(manager.getStorageStats()).toEqual({
      totalStores: 2,
      totalSections: 2,
      totalTokens: 5,
      totalSizeBytes: Buffer.byteLength('firstsecond', 'utf8'),
      byType: [{ type: 'external', count: 2, tokens: 5 }],
    });
    const expected = expect.objectContaining({
      name: 'RlmHydrationError',
      storeId: 'second-store',
      reason: 'metadata-budget-exhausted',
    });
    expect(() => manager.listSections('second-store')).toThrowError(expected);
    expect(() => manager.getStore('second-store')).toThrowError(expected);
    expect(() => manager.getStoreByInstance('instance-second-store')).toThrowError(expected);
    expect(() => manager.getStoreStats('second-store')).toThrowError(expected);
    expect(manager.listStores().map((store) => store.id)).toEqual(
      expect.arrayContaining(['first-store', 'second-store']),
    );
    expect(manager.listStores()).toHaveLength(2);
    expect(() => manager.removeSection('second-store', 'second-section')).toThrowError(expected);
    expect(db.getSection('second-section')).toBeTruthy();
    expect(manager.getStoreHydrationState('second-store')?.metadata).toBe('deferred');
  });

  it('hydrates before removal and accounts runtime additions without reading them back from disk', async () => {
    seedStore('persisted-store', [
      { id: 'section-alpha', name: 'alpha.txt', content: 'alpha base', tokens: 2 },
    ]);
    const manager = RLMContextManager.getInstance();
    const session = await manager.startSession('persisted-store', 'instance-persisted-store');
    await manager.executeQuery(session.id, { type: 'grep', params: { pattern: 'alpha' } });

    const contentRead = vi.spyOn(db, 'getSectionContent');
    contentRead.mockClear();
    const added = manager.addSection(
      'persisted-store',
      'external',
      'runtime.txt',
      'runtime café',
    );

    expect(contentRead).not.toHaveBeenCalled();
    expect(manager.getStoreHydrationState('persisted-store')?.sectionCount).toBe(2);
    expect(manager.getResidencyStats()).toMatchObject({
      residentMetadataSections: 2,
      residentContentBytes: Buffer.byteLength('alpha baseruntime café', 'utf8'),
      residentContentSections: 2,
      residentContentStores: 1,
    });

    expect(manager.removeSection('persisted-store', 'section-alpha')).toBe(true);
    expect(manager.listSections('persisted-store').map((section) => section.id)).toEqual([added.id]);
    expect(manager.getStoreHydrationState('persisted-store')?.sectionCount).toBe(1);
    expect(manager.getResidencyStats()).toMatchObject({
      residentMetadataSections: 1,
      residentContentBytes: Buffer.byteLength('runtime café', 'utf8'),
      residentContentSections: 1,
    });
  });

  it('admits deferred content before single and batch additions, then accounts new bytes without rereading them', async () => {
    seedStore('persisted-store', [
      { id: 'section-alpha', name: 'alpha.txt', content: 'alpha base', tokens: 2 },
    ]);
    const manager = RLMContextManager.getInstance();
    const contentRead = vi.spyOn(db, 'getSectionContent');

    manager.addSection('persisted-store', 'external', 'single.txt', 'single addition');
    expect(contentRead).toHaveBeenCalledTimes(1);
    contentRead.mockClear();
    await manager.addSectionsBatch('persisted-store', [
      { type: 'external', name: 'batch-one.txt', content: 'batch one' },
      { type: 'external', name: 'batch-two.txt', content: 'batch two' },
    ]);

    expect(contentRead).not.toHaveBeenCalled();
    expect(manager.getStoreHydrationState('persisted-store')).toMatchObject({
      metadata: 'resident',
      content: 'resident',
      sectionCount: 4,
    });
    expect(manager.getResidencyStats()).toMatchObject({
      residentContentBytes: Buffer.byteLength(
        'alpha basesingle additionbatch onebatch two',
        'utf8',
      ),
      residentContentSections: 4,
      residentContentStores: 1,
    });
  });

  it('evicts a just-expanded store when one added byte crosses the resident-content budget', () => {
    seedStore('persisted-store', [
      { id: 'section-alpha', name: 'alpha.txt', content: '1234', tokens: 1 },
    ]);
    const manager = RLMContextManager.getInstance();
    replaceResidencyPolicy(manager, { maxResidentContentBytes: 5 });

    const added = manager.addSection('persisted-store', 'external', 'over.txt', 'xx');

    expect(added.content).toBe('');
    expect(manager.getStoreHydrationState('persisted-store')).toMatchObject({
      content: 'deferred',
      sectionCount: 2,
    });
    expect(manager.getResidencyStats()).toMatchObject({
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
    });
    expect(manager.getSectionContentLazy('persisted-store', added.id)).toBe('xx');
  });

  it('counts an empty persisted store exactly once across first add, removal, re-add, and deletion', () => {
    seedStore('empty-store', []);
    const manager = RLMContextManager.getInstance();

    const first = manager.addSection('empty-store', 'external', 'first.txt', 'x');
    expect(manager.getResidencyStats()?.residentContentStores).toBe(1);
    expect(manager.removeSection('empty-store', first.id)).toBe(true);
    expect(manager.getResidencyStats()?.residentContentStores).toBe(0);
    manager.addSection('empty-store', 'external', 'second.txt', 'y');
    expect(manager.getResidencyStats()?.residentContentStores).toBe(1);
    manager.deleteStore('empty-store');
    expect(manager.getResidencyStats()?.residentContentStores).toBe(0);
  });

  it('leaves no phantom resident store when the first addition exceeds the byte budget', () => {
    seedStore('empty-store', []);
    const manager = RLMContextManager.getInstance();
    replaceResidencyPolicy(manager, { maxResidentContentBytes: 0 });

    const added = manager.addSection('empty-store', 'external', 'over.txt', 'x');

    expect(added.content).toBe('');
    expect(manager.getStoreHydrationState('empty-store')?.content).toBe('deferred');
    expect(manager.getResidencyStats()).toMatchObject({
      residentContentStores: 0,
      residentContentSections: 0,
      residentContentBytes: 0,
      exhausted: expect.objectContaining({ contentBytes: true }),
    });
  });

  it('accounts every retained chunk when a deferred-store addition is split', () => {
    seedStore('persisted-store', [
      { id: 'section-alpha', name: 'alpha.txt', content: 'base', tokens: 1 },
    ]);
    const manager = RLMContextManager.getInstance();
    manager.configure({ maxSectionTokens: 2 });
    const contentRead = vi.spyOn(db, 'getSectionContent');

    manager.addSection(
      'persisted-store',
      'external',
      'split.txt',
      'one\ntwo\nthree\nfour\nfive\nsix',
    );

    const sections = manager.listSections('persisted-store');
    expect(sections.length).toBeGreaterThan(2);
    expect(contentRead).toHaveBeenCalledTimes(1);
    expect(manager.getStoreHydrationState('persisted-store')?.sectionCount).toBe(sections.length);
    expect(manager.getResidencyStats()).toMatchObject({
      residentContentBytes: sections.reduce(
        (total, section) => total + Buffer.byteLength(section.content, 'utf8'),
        0,
      ),
      residentContentSections: sections.length,
    });
  });

  it('preserves in-memory behavior when persistence and residency control are disabled', async () => {
    const manager = RLMContextManager.getInstance();
    const internals = manager as unknown as {
      db: RLMDatabase | null;
      vectorStore: VectorStore | null;
      residencyController: ContextResidencyController | null;
      persistenceEnabled: boolean;
    };
    internals.db = null;
    internals.vectorStore = null;
    internals.residencyController = null;
    internals.persistenceEnabled = false;

    const store = manager.createStore('memory-instance');
    const section = manager.addSection(store.id, 'external', 'memory.txt', 'memory content');
    const session = await manager.startSession(store.id, 'memory-instance');
    const result = await manager.executeQuery(session.id, {
      type: 'grep',
      params: { pattern: 'memory' },
    });

    expect(result.sectionsAccessed).toEqual([section.id]);
    expect(manager.listStores()[0].sections).toEqual([section]);
    expect(manager.exportStore(store.id)?.store.sections[0].content).toBe('memory content');
  });

  it('removes a persisted section while its metadata is still deferred', () => {
    seedStore('persisted-store', [
      { id: 'section-alpha', name: 'alpha.txt', content: 'alpha base', tokens: 2 },
    ]);
    const manager = RLMContextManager.getInstance();

    expect(manager.getStoreHydrationState('persisted-store')?.metadata).toBe('deferred');
    expect(manager.removeSection('persisted-store', 'section-alpha')).toBe(true);
    expect(db.getSection('section-alpha')).toBeFalsy();
    expect(manager.getStoreStats('persisted-store')?.sections).toBe(0);
    expect(manager.getStoreHydrationState('persisted-store')).toMatchObject({
      metadata: 'resident',
      content: 'deferred',
      sectionCount: 0,
    });
  });

  it('keeps active-session residency stats synchronized with runtime session lifecycle', async () => {
    seedStore('persisted-store', []);
    const manager = RLMContextManager.getInstance();

    const session = await manager.startSession('persisted-store', 'instance-persisted-store');
    expect(manager.getResidencyStats()?.activeSessions).toBe(1);

    manager.endSession(session.id);
    expect(manager.getResidencyStats()?.activeSessions).toBe(0);
  });

  it('removes every related active session from residency stats when deleting a store', async () => {
    seedStore('persisted-store', []);
    const manager = RLMContextManager.getInstance();
    await manager.startSession('persisted-store', 'instance-one');
    await manager.startSession('persisted-store', 'instance-two');
    expect(manager.getResidencyStats()?.activeSessions).toBe(2);

    manager.deleteStore('persisted-store');

    expect(manager.listSessions()).toEqual([]);
    expect(manager.getResidencyStats()?.activeSessions).toBe(0);
  });

  it('lazy-loads a section when metadata begins deferred and after metadata is admitted', () => {
    seedStore();
    const manager = RLMContextManager.getInstance();

    expect(manager.getStoreHydrationState('persisted-store')?.metadata).toBe('deferred');
    expect(manager.getSectionContentLazy('persisted-store', 'section-alpha')).toBe(
      'alpha lexical needle',
    );
    expect(manager.getStoreHydrationState('persisted-store')).toMatchObject({
      metadata: 'resident',
      content: 'deferred',
    });
    expect(manager.listSections('persisted-store')[0].content).toBe('');
    expect(manager.getSectionContentLazy('persisted-store', 'section-beta')).toBe(
      'beta supporting note',
    );
    expect(manager.getResidencyStats()?.residentContentBytes).toBe(0);
  });

  it('reload clears old content, Bloom, sessions, semantic work, and residency before emitting full load stats', async () => {
    seedStore('old-store', [
      { id: 'old-section', name: 'old.txt', content: 'old searchable content', tokens: 4 },
    ]);
    const manager = RLMContextManager.getInstance();
    const session = await manager.startSession('old-store', 'instance-old-store');
    await manager.executeQuery(session.id, { type: 'grep', params: { pattern: 'searchable' } });
    manager.rebuildBloomFilter('old-store');
    const oldStore = manager.listStores()[0];

    db.deleteStore('old-store');
    seedStore('replacement-store', [
      { id: 'replacement-section', name: 'new.txt', content: 'replacement', tokens: 2 },
    ]);
    const loadedEvents: Record<string, unknown>[] = [];
    manager.on('persistence:loaded', (event: Record<string, unknown>) => loadedEvents.push(event));

    manager.reloadFromPersistence();

    expect(oldStore.sections).toEqual([]);
    expect(oldStore.bloomFilter).toBeUndefined();
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(manager.getStoreHydrationState('old-store')).toBeUndefined();
    expect(manager.listStores().map((store) => store.id)).toEqual(['replacement-store']);
    expect(loadedEvents).toHaveLength(1);
    expect(loadedEvents[0]).toEqual(expect.objectContaining({
      storeCount: 1,
      sectionCount: 1,
      discoveredStores: 1,
      activeSessions: 0,
      startupContentBytes: 0,
      residentMetadataSections: 0,
      deferredMetadataSections: 1,
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
      hotCandidates: expect.any(Number),
      hotAdmitted: 0,
      hotSkipped: 0,
      hotCancelled: 0,
      metadataOnlyStores: 1,
      deferredStores: 1,
      exhausted: {
        metadata: false,
        contentBytes: false,
        contentSections: false,
        contentStores: false,
      },
      elapsedMs: expect.any(Number),
    }));
  });
});
