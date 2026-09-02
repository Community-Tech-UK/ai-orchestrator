import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
const embed = vi.hoisted(() => vi.fn(async () => ({
  embedding: [1, 2, 3],
  model: 'test',
  tokens: 1,
  cached: false,
  provider: 'test',
})));

vi.mock('../logging/logger', () => ({ getLogger: () => logger }));

vi.mock('./embedding-service', () => ({
  getEmbeddingService: () => ({
    embed,
    embedBatch: vi.fn(async (texts: string[]) => Promise.all(texts.map(() => embed()))),
    findSimilar: vi.fn(() => []),
  }),
  EmbeddingService: class {},
}));

import { RLMDatabase } from '../persistence/rlm-database';
import type { UnindexedRootSectionRow } from '../persistence/rlm-database.types';
import { RLMContextManager } from './context-manager';
import {
  ContextResidencyController,
} from './context-residency-controller';
import {
  DEFAULT_RLM_RESIDENCY_POLICY,
} from './context-persistence-loader';
import { SemanticVectorDeltaRepair } from './semantic-vector-delta-repair';
import { VectorStore } from './vector-store';
import type { ContextStore, RLMSession } from '../../shared/types/rlm.types';

describe('RLM observability', () => {
  let root: string;
  let db: RLMDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-rlm-observability-'));
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    db = RLMDatabase.getInstance({
      dbPath: path.join(root, 'rlm.db'),
      contentDir: path.join(root, 'content'),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('logs one metadata-only load summary and exposes the identical zero-data residency snapshot in storage stats', () => {
    const manager = RLMContextManager.getInstance();
    const snapshot = manager.getResidencyStats();
    const expectedSnapshot = {
      processRole: 'context-worker',
      counts: {
        durableStores: 0,
        durableSections: 0,
        activeSessions: 0,
        residentMetadataSections: 0,
        deferredMetadataSections: 0,
        residentContentSections: 0,
        residentContentStores: 0,
        metadataOnlyStores: 0,
        deferredStores: 0,
      },
      discoveredStores: 0,
      activeSessions: 0,
      startupContentBytes: 0,
      residentMetadataSections: 0,
      deferredMetadataSections: 0,
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
      metadataOnlyStores: 0,
      deferredStores: 0,
      exhausted: {
        metadata: false,
        contentBytes: false,
        contentSections: false,
        contentStores: false,
      },
      elapsedMs: expect.any(Number),
    };

    expect(loadSummaries()).toEqual([expectedSnapshot]);
    expect(snapshot).toEqual(expectedSnapshot);
    expect(manager.getStorageStats()).toEqual({
      totalStores: 0,
      totalSections: 0,
      totalTokens: 0,
      totalSizeBytes: 0,
      byType: [],
      residency: snapshot,
    });
    expect(snapshot?.startupContentBytes).toBe(0);
  });

  it('logs a fresh load summary and resets prior hot and semantic activity on reload', async () => {
    vi.useFakeTimers();
    seedStore('first', 'first-section', 'first content');
    const manager = RLMContextManager.getInstance();
    expect(manager.getResidencyStats()).toMatchObject({
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
    });
    embed.mockRejectedValueOnce(new Error('test-only-reload-retry'));
    await manager.indexStoreForSemanticSearch('first');
    await manager.indexStoreForSemanticSearch('first');
    expect(manager.startHotPrewarm()).toBe(true);
    await vi.runAllTimersAsync();
    expect(manager.getResidencyStats()).toMatchObject({
      hotCandidates: 1,
      hotAdmitted: 1,
      semanticDiscovered: 2,
      semanticIndexed: 1,
      semanticFailed: 1,
      semanticRetried: 1,
    });
    db.deleteStore('first');
    seedStore('second', 'second-section', 'second content');

    manager.reloadFromPersistence();

    expect(loadSummaries()).toHaveLength(2);
    expect(manager.getResidencyStats()).toMatchObject({
      discoveredStores: 1,
      residentMetadataSections: 0,
      deferredMetadataSections: 1,
      residentContentBytes: 0,
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
    });
    expect(loadSummaries()[1]).toEqual(manager.getResidencyStats());
    expect(manager.getStorageStats().residency).toEqual(manager.getResidencyStats());
  });

  it('logs exactly one completed prewarm terminal summary with reconciled within-budget counts', async () => {
    vi.useFakeTimers();
    seedStore('hot', 'hot-section', 'hot content');
    const manager = RLMContextManager.getInstance();
    const metricUpdates: unknown[] = [];
    manager.on('residency:stats', (stats) => metricUpdates.push(stats));
    logger.info.mockClear();

    expect(manager.startHotPrewarm()).toBe(true);
    await vi.runAllTimersAsync();

    expect(prewarmSummaries('started')).toHaveLength(1);
    expect(prewarmSummaries('completed')).toEqual([expect.objectContaining({
      processRole: 'context-worker',
      phase: 'completed',
      candidates: 1,
      admitted: 1,
      skipped: 0,
      exhausted: 0,
      cancelled: 0,
      residentContentSections: 1,
      residentContentStores: 1,
      elapsedMs: expect.any(Number),
    })]);
    expect(prewarmSummaries('cancelled')).toEqual([]);
    expect(manager.getResidencyStats()).toMatchObject({
      hotCandidates: 1,
      hotAdmitted: 1,
      hotSkipped: 0,
      hotExhausted: 0,
      hotCancelled: 0,
    });
    expect(manager.getStorageStats().residency).toEqual(manager.getResidencyStats());
    expect(metricUpdates.at(-1)).toEqual(manager.getResidencyStats());
  });

  it('logs exhausted completion and idempotent cancellation/restart once per prewarm generation', async () => {
    vi.useFakeTimers();
    seedStore('hot', 'hot-section', 'hot content');
    const manager = RLMContextManager.getInstance();
    replaceResidencyPolicy(manager, { maxResidentContentBytes: 0 });
    logger.info.mockClear();

    expect(manager.startHotPrewarm()).toBe(true);
    expect(manager.cancelHotPrewarm()).toBe(true);
    expect(manager.cancelHotPrewarm()).toBe(false);
    expect(prewarmSummaries('cancelled')).toEqual([expect.objectContaining({
      candidates: 1,
      admitted: 0,
      skipped: 0,
      exhausted: 0,
      cancelled: 1,
    })]);

    expect(manager.startHotPrewarm()).toBe(true);
    await vi.runAllTimersAsync();

    expect(prewarmSummaries('completed')).toEqual([expect.objectContaining({
      candidates: 1,
      admitted: 0,
      skipped: 0,
      exhausted: 1,
      cancelled: 0,
      residentContentBytes: 0,
    })]);
    expect(prewarmSummaries('cancelled')).toHaveLength(1);
  });

  it('logs semantic delta retry, failure, and skip counts without identifiers, content, query text, paths, or secret-like values', async () => {
    const sensitive = {
      storeId: 'store-/private/secret-project',
      sectionId: 'section-secret-token-123',
      content: 'private query [credential-placeholder-do-not-use]',
      path: '/private/secret-project/file.ts',
    };
    let indexed = false;
    const candidates = [
      {
        id: sensitive.sectionId,
        type: 'file',
        name: sensitive.path,
        file_path: sensitive.path,
        language: 'typescript',
      },
      {
        id: 'missing-row-secret',
        type: 'file',
        name: sensitive.path,
        file_path: sensitive.path,
        language: 'typescript',
      },
    ] as UnindexedRootSectionRow[];
    const fakeDb = {
      listUnindexedRootSections: vi.fn(() => indexed ? [candidates[1]] : candidates),
      getSection: vi.fn((sectionId: string) => sectionId === sensitive.sectionId ? {
        id: sensitive.sectionId,
        store_id: sensitive.storeId,
        depth: 0,
      } : null),
      getSectionContent: vi.fn(() => sensitive.content),
    } as unknown as RLMDatabase;
    const addSection = vi.fn()
      .mockRejectedValueOnce(new Error(`${sensitive.path} ${sensitive.content}`))
      .mockImplementationOnce(async () => {
        indexed = true;
        return {};
      });
    const repair = new SemanticVectorDeltaRepair(fakeDb, {
      getConfig: () => ({ indexBatchSize: 10 }),
      addSection,
      removeSection: vi.fn(),
    } as unknown as VectorStore);

    await expect(repair.repairStore(sensitive.storeId)).resolves.toEqual({
      missing: 2, indexed: 0, skipped: 1, failed: 1, retried: 0,
    });
    await expect(repair.repairStore(sensitive.storeId)).resolves.toEqual({
      missing: 2, indexed: 1, skipped: 1, failed: 0, retried: 1,
    });

    const summaries = semanticSummaries();
    expect(summaries).toEqual([
      expect.objectContaining({ missing: 2, indexed: 0, skipped: 1, failed: 1, retried: 0 }),
      expect.objectContaining({ missing: 2, indexed: 1, skipped: 1, failed: 0, retried: 1 }),
    ]);
    const serialized = JSON.stringify(logger.info.mock.calls
      .concat(logger.warn.mock.calls, logger.error.mock.calls));
    for (const value of Object.values(sensitive)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('storeId');
    expect(serialized).not.toContain('sectionId');
    expect(serialized).not.toContain('filePath');
    expect(serialized).not.toContain('query');
  });

  it('clears semantic retry history when reload starts a new generation', async () => {
    const candidate = {
      id: 'retry-before-reload',
      type: 'file',
      name: 'test-only-sensitive-name',
      file_path: '/test-only-sensitive-path.ts',
      language: 'typescript',
    } as UnindexedRootSectionRow;
    const fakeDb = {
      listUnindexedRootSections: vi.fn(() => [candidate]),
      getSection: vi.fn(() => ({ id: candidate.id, store_id: 'store', depth: 0 })),
      getSectionContent: vi.fn(() => 'test-only-sensitive-content'),
    } as unknown as RLMDatabase;
    const repair = new SemanticVectorDeltaRepair(fakeDb, {
      getConfig: () => ({ indexBatchSize: 10 }),
      addSection: vi.fn().mockRejectedValue(new Error('test-only-sensitive-failure')),
      removeSection: vi.fn(),
    } as unknown as VectorStore);

    await repair.repairStore('store');
    repair.invalidateForReload();
    await repair.repairStore('store');

    expect(semanticSummaries()).toEqual([
      expect.objectContaining({ failed: 1, retried: 0 }),
      expect.objectContaining({ failed: 1, retried: 0 }),
    ]);
  });

  it('classifies every discovered section when invalidated before the first attempt', async () => {
    const candidates = semanticCandidates();
    let repair!: SemanticVectorDeltaRepair;
    const addSection = vi.fn();
    const removeSection = vi.fn();
    const fakeDb = semanticDb(candidates, () => {
      repair.invalidateForReload();
      return candidates;
    });
    repair = semanticRepair(fakeDb, addSection, removeSection);

    await expect(repair.repairStore('store')).resolves.toEqual({
      missing: 2, indexed: 0, skipped: 2, failed: 0, retried: 0,
    });

    expect(addSection).not.toHaveBeenCalled();
    expect(removeSection).not.toHaveBeenCalled();
    expect(semanticSummaries()).toEqual([expect.objectContaining({
      missing: 2, indexed: 0, skipped: 2, failed: 0, retried: 0,
    })]);
  });

  it('reclassifies rolled-back success and unattempted work after partial stale invalidation', async () => {
    const candidates = semanticCandidates();
    let repair!: SemanticVectorDeltaRepair;
    const addSection = vi.fn(async () => {
      repair.invalidateForReload();
      return {};
    });
    const removeSection = vi.fn();
    repair = semanticRepair(semanticDb(candidates), addSection, removeSection);

    await expect(repair.repairStore('store')).resolves.toEqual({
      missing: 2, indexed: 0, skipped: 2, failed: 0, retried: 0,
    });

    expect(addSection).toHaveBeenCalledOnce();
    expect(removeSection).toHaveBeenCalledWith(candidates[0].id);
    expect(semanticSummaries()).toEqual([expect.objectContaining({
      missing: 2, indexed: 0, skipped: 2, failed: 0, retried: 0,
    })]);
  });

  it('reconciles failure plus staleness and does not leak the old failure into retry state', async () => {
    const candidates = semanticCandidates();
    let repair!: SemanticVectorDeltaRepair;
    const listMissing = vi.fn()
      .mockImplementationOnce(() => candidates)
      .mockImplementationOnce(() => [candidates[0]]);
    const addSection = vi.fn()
      .mockImplementationOnce(async () => {
        repair.invalidateForReload();
        throw new Error('test-only-stale-failure');
      })
      .mockResolvedValueOnce({});
    repair = semanticRepair(semanticDb(candidates, listMissing), addSection, vi.fn());

    await expect(repair.repairStore('store')).resolves.toEqual({
      missing: 2, indexed: 0, skipped: 1, failed: 1, retried: 0,
    });
    await expect(repair.repairStore('store')).resolves.toEqual({
      missing: 1, indexed: 1, skipped: 0, failed: 0, retried: 0,
    });

    expect(semanticSummaries()).toEqual([
      expect.objectContaining({ missing: 2, indexed: 0, skipped: 1, failed: 1, retried: 0 }),
      expect.objectContaining({ missing: 1, indexed: 1, skipped: 0, failed: 0, retried: 0 }),
    ]);
  });

  it('keeps retried as a subset while stale retry work is rolled back and reconciled', async () => {
    const candidates = semanticCandidates();
    let repair!: SemanticVectorDeltaRepair;
    const listMissing = vi.fn()
      .mockImplementationOnce(() => [candidates[0]])
      .mockImplementationOnce(() => candidates);
    const addSection = vi.fn()
      .mockRejectedValueOnce(new Error('test-only-retryable-failure'))
      .mockImplementationOnce(async () => {
        repair.invalidateForReload();
        return {};
      });
    const removeSection = vi.fn();
    repair = semanticRepair(semanticDb(candidates, listMissing), addSection, removeSection);

    await expect(repair.repairStore('store')).resolves.toEqual({
      missing: 1, indexed: 0, skipped: 0, failed: 1, retried: 0,
    });
    await expect(repair.repairStore('store')).resolves.toEqual({
      missing: 2, indexed: 0, skipped: 2, failed: 0, retried: 1,
    });

    expect(removeSection).toHaveBeenCalledWith(candidates[0].id);
    expect(semanticSummaries()[1]).toMatchObject({
      missing: 2, indexed: 0, skipped: 2, failed: 0, retried: 1,
    });
  });

  it('does not let a stale semantic generation update replacement residency metrics', async () => {
    seedStore('stale-store', 'stale-section', 'stale semantic content');
    const manager = RLMContextManager.getInstance();
    const metricUpdates: unknown[] = [];
    manager.on('residency:stats', (stats) => metricUpdates.push(stats));
    let release!: (value: Awaited<ReturnType<typeof embed>>) => void;
    const pending = new Promise<Awaited<ReturnType<typeof embed>>>((resolve) => {
      release = resolve;
    });
    embed.mockImplementationOnce(async () => pending);

    const stale = manager.indexStoreForSemanticSearch('stale-store');
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
    manager.reloadFromPersistence();
    release({ embedding: [1, 2, 3], model: 'test', tokens: 1, cached: false, provider: 'test' });
    await stale;

    expect(manager.getResidencyStats()).toMatchObject({
      semanticDiscovered: 0,
      semanticIndexed: 0,
      semanticSkipped: 0,
      semanticFailed: 0,
      semanticRetried: 0,
    });
    expect(metricUpdates).toEqual([]);
  });

  it('does not reintroduce sensitive store identifiers in the manager semantic wrapper logs', async () => {
    const storeId = 'store-/private/manager-secret';
    const sectionId = 'section-manager-secret';
    seedStore(storeId, sectionId, 'manager private query token');
    const manager = RLMContextManager.getInstance();
    const metricUpdates: unknown[] = [];
    manager.on('residency:stats', (stats) => metricUpdates.push(stats));
    logger.info.mockClear();
    logger.warn.mockClear();

    await (manager as unknown as {
      ensureStoreIndexedForSemanticSearch(id: string): Promise<unknown>;
    }).ensureStoreIndexedForSemanticSearch(storeId);

    expect(manager.getResidencyStats()).toMatchObject({
      semanticDiscovered: 1,
      semanticIndexed: 1,
      semanticSkipped: 0,
      semanticFailed: 0,
      semanticRetried: 0,
    });
    expect(manager.getStorageStats().residency).toEqual(manager.getResidencyStats());
    expect(metricUpdates.at(-1)).toEqual(manager.getResidencyStats());

    const serialized = JSON.stringify(logger.info.mock.calls
      .concat(logger.warn.mock.calls, logger.error.mock.calls));
    expect(serialized).not.toContain(storeId);
    expect(serialized).not.toContain(sectionId);
    expect(serialized).not.toContain('/private/manager-secret');
    expect(serialized).not.toContain('manager private query token');
  });

  it('keeps public residency and storage diagnostics count-only after an admission failure', () => {
    const sensitiveStoreId = 'store-/private/residency-secret';
    const manager = RLMContextManager.getInstance();
    const controller = (manager as unknown as {
      residencyController: ContextResidencyController;
    }).residencyController;

    expect(controller.ensureMetadata(sensitiveStoreId)).toMatchObject({
      changed: false,
      reason: 'store-not-found',
    });

    const residency = manager.getResidencyStats();
    const storageResidency = manager.getStorageStats().residency;
    expect(residency).toMatchObject({
      lastAdmissionFailure: { reason: 'store-not-found' },
    });
    expect(storageResidency).toEqual(residency);
    const serialized = JSON.stringify({ residency, storageResidency });
    expect(serialized).not.toContain(sensitiveStoreId);
    expect(serialized).not.toContain('storeId');
  });

  function seedStore(storeId: string, sectionId: string, content: string): void {
    db.createStore({ id: storeId, instanceId: `instance-${storeId}` });
    db.addSection({
      id: sectionId,
      storeId,
      type: 'external',
      name: `${sectionId}.txt`,
      startOffset: 0,
      endOffset: content.length,
      tokens: 2,
      content,
    });
  }

  function semanticCandidates(): UnindexedRootSectionRow[] {
    return ['a', 'b'].map((suffix) => ({
      id: `section-${suffix}`,
      type: 'file',
      name: `test-only-${suffix}`,
      file_path: `/test-only-${suffix}.ts`,
      language: 'typescript',
    })) as UnindexedRootSectionRow[];
  }

  function semanticDb(
    candidates: UnindexedRootSectionRow[],
    listMissing: () => UnindexedRootSectionRow[] = () => candidates,
  ): RLMDatabase {
    return {
      listUnindexedRootSections: listMissing,
      getSection: vi.fn((sectionId: string) => ({ id: sectionId, store_id: 'store', depth: 0 })),
      getSectionContent: vi.fn(() => 'test-only-semantic-content'),
    } as unknown as RLMDatabase;
  }

  function semanticRepair(
    fakeDb: RLMDatabase,
    addSection: ReturnType<typeof vi.fn>,
    removeSection: ReturnType<typeof vi.fn>,
  ): SemanticVectorDeltaRepair {
    return new SemanticVectorDeltaRepair(fakeDb, {
      getConfig: () => ({ indexBatchSize: 10 }),
      addSection,
      removeSection,
    } as unknown as VectorStore);
  }

  function replaceResidencyPolicy(
    manager: RLMContextManager,
    overrides: Partial<typeof DEFAULT_RLM_RESIDENCY_POLICY>,
  ): void {
    const internals = manager as unknown as {
      stores: Map<string, ContextStore>;
      sessions: Map<string, RLMSession>;
      residencyController: ContextResidencyController;
    };
    internals.residencyController = new ContextResidencyController({
      db,
      stores: internals.stores,
      sessions: internals.sessions,
      hydrationStates: internals.residencyController.getHydrationStates(),
      loadStats: internals.residencyController.getStats(),
      policy: { ...DEFAULT_RLM_RESIDENCY_POLICY, ...overrides },
    });
  }

  function loadSummaries(): Record<string, unknown>[] {
    return logger.info.mock.calls
      .filter(([message]) => message === 'RLM persistence load summary')
      .map(([, data]) => data as Record<string, unknown>);
  }

  function prewarmSummaries(phase: string): Record<string, unknown>[] {
    return logger.info.mock.calls
      .filter(([message, data]) => message === 'RLM hot prewarm summary'
        && (data as { phase?: string } | undefined)?.phase === phase)
      .map(([, data]) => data as Record<string, unknown>);
  }

  function semanticSummaries(): Record<string, unknown>[] {
    return logger.info.mock.calls
      .filter(([message]) => message === 'RLM semantic delta summary')
      .map(([, data]) => data as Record<string, unknown>);
  }
});
