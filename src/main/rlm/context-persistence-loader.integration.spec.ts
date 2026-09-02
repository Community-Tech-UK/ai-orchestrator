import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embed = vi.fn(async (text: string) => ({
  embedding: [1, 0, 0],
  model: 'fixture-embed',
  tokens: Math.ceil(text.length / 4),
  cached: false,
  provider: 'fixture',
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
      similarity: 1,
    })),
  }),
  EmbeddingService: class {},
}));

import type { ContextStore, RLMSession } from '../../shared/types/rlm.types';
import { RLMDatabase } from '../persistence/rlm-database';
import { RLMContextManager } from './context-manager';
import {
  DEFAULT_RLM_RESIDENCY_POLICY,
  selectHotStoreCandidates,
  type RlmResidencyPolicy,
} from './context-persistence-loader';
import { ContextResidencyController } from './context-residency-controller';
import { VectorStore } from './vector-store';

const NOW = Date.UTC(2026, 7, 30, 12);
const HOUR = 60 * 60 * 1_000;
const SECTION_BYTES = 6;
const SECTIONS_PER_STORE = 2;
const POLICY: RlmResidencyPolicy = {
  ...DEFAULT_RLM_RESIDENCY_POLICY,
  maxResidentSectionMetadata: 8,
  maxResidentContentBytes: 30,
  maxResidentContentSections: 4,
  maxResidentContentStores: 2,
  maxSectionsPerStore: SECTIONS_PER_STORE,
};

const STORE_TIMES = [
  ['active-old', NOW - (72 * HOUR)],
  ['recent-new', NOW - HOUR],
  ['recent-a', NOW - (2 * HOUR)],
  ['recent-b', NOW - (2 * HOUR)],
  ['boundary', NOW - (48 * HOUR)],
  ['stale-a', NOW - (48 * HOUR) - 1],
] as const;

const electronPath = createRequire(import.meta.url)('electron') as string;
const RESTART_RESULT_PREFIX = 'AIO_RLM_DURABLE_RESTART:';
const HANGING_CHILD_TIMEOUT_MS = 500;
const DURABLE_CHILD_TIMEOUT_MS = 5_000;

interface ElectronChildExecution {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  callbackErrorCode?: string;
  timedOut: boolean;
  closeObserved: boolean;
  pid: number;
}

interface HangingChildEvidence {
  timedOut: boolean;
  closeObserved: boolean;
  signal: NodeJS.Signals | null;
  callbackErrorCode?: string;
  markerCreated: boolean;
  processAliveAfterClose: boolean;
  cleanupConfirmed: boolean;
}

interface DurableRestartResult {
  closeEvents: number;
  firstConnectionRejectedAfterClose: boolean;
  databaseIdentityChanged: boolean;
  managerIdentityChanged: boolean;
  vectorStoreIdentityChanged: boolean;
  fileSizeAfterClose: number;
  durableBeforeFreshRuntime: {
    stores: number;
    sections: number;
    sessions: number;
    vectors: number;
    missingVectors: number;
  };
  initialManagerContentReads: string[];
  restartedManagerContentReads: string[];
  hydrationBeforeQuery: unknown;
  hydrationAfterQuery: unknown;
  sectionEmbeddingCalls: Array<{
    storeId: string;
    sectionId: string;
    content: string;
    existingSectionOnly: boolean;
  }>;
  embedTexts: string[];
  existingVectorPreserved: boolean;
  missingVectorPersisted: boolean;
  finalVectorCount: number;
  sectionsAccessed: string[];
  networkGuard: {
    interceptedHealthChecks: Array<{ url: string; method: string }>;
    unexpectedFetchAttempts: Array<{ url: string; method: string }>;
    blockedSocketAttempts: string[];
  };
}

const durableRestartProcessScript = String.raw`
(async () => {
  require('tsx/cjs');
  const fs = require('node:fs');
  const path = require('node:path');
  const [databasePath, contentDir] = process.argv.slice(1);
  const expectedHealthUrl = 'http://localhost:11434/api/tags';
  const interceptedHealthChecks = [];
  const unexpectedFetchAttempts = [];
  const blockedSocketAttempts = [];
  const blockSocket = (surface) => () => {
    blockedSocketAttempts.push(surface);
    throw new Error('Blocked fixture socket API: ' + surface);
  };
  const net = require('node:net');
  const tls = require('node:tls');
  const http = require('node:http');
  const https = require('node:https');
  const dgram = require('node:dgram');
  net.connect = blockSocket('net.connect');
  net.createConnection = blockSocket('net.createConnection');
  tls.connect = blockSocket('tls.connect');
  http.request = blockSocket('http.request');
  http.get = blockSocket('http.get');
  https.request = blockSocket('https.request');
  https.get = blockSocket('https.get');
  dgram.createSocket = blockSocket('dgram.createSocket');
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || (typeof input === 'string' ? 'GET' : input.method)).toUpperCase();
    if (url === expectedHealthUrl && method === 'GET') {
      interceptedHealthChecks.push({ url, method });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ models: [] }),
      };
    }
    unexpectedFetchAttempts.push({ url, method });
    throw new Error('Blocked unexpected fixture fetch: ' + method + ' ' + url);
  };
  const load = (relativePath) => require(path.join(process.cwd(), relativePath));
  const { RLMDatabase } = load('src/main/persistence/rlm-database.ts');
  const { RLMContextManager } = load('src/main/rlm/context-manager.ts');
  const { VectorStore } = load('src/main/rlm/vector-store.ts');
  const existingContent = 'durable existing vector';
  const missingContent = 'durable missing vector';
  const queryText = 'find durable vectors';
  let result;

  RLMDatabase._resetForTesting();
  VectorStore._resetForTesting();
  RLMContextManager._resetForTesting();
  try {
    const seededDatabase = RLMDatabase.getInstance({
      dbPath: databasePath,
      contentDir,
      enableWAL: false,
    });
    seededDatabase.createStore({ id: 'semantic-store', instanceId: 'semantic-instance' });
    seededDatabase.addSection({
      id: 'semantic-existing',
      storeId: 'semantic-store',
      type: 'external',
      name: 'existing-note',
      startOffset: 0,
      endOffset: existingContent.length,
      tokens: 4,
      content: existingContent,
    });
    seededDatabase.addSection({
      id: 'semantic-missing',
      storeId: 'semantic-store',
      type: 'external',
      name: 'missing-note',
      startOffset: existingContent.length,
      endOffset: existingContent.length + missingContent.length,
      tokens: 4,
      content: missingContent,
    });
    seededDatabase.addVector({
      id: 'vector-semantic-existing',
      storeId: 'semantic-store',
      sectionId: 'semantic-existing',
      embedding: new Float32Array([1, 0, 0]),
      contentPreview: existingContent,
      metadata: { fixture: true },
    });
    seededDatabase.createSession({
      id: 'semantic-session',
      storeId: 'semantic-store',
      instanceId: 'semantic-instance',
      estimatedDirectTokens: 12,
    });

    const existingVectorBefore = seededDatabase.getVectorBySectionId('semantic-existing');
    const initialManagerContentReads = [];
    const seededGetSectionContent = seededDatabase.getSectionContent.bind(seededDatabase);
    seededDatabase.getSectionContent = (row) => {
      initialManagerContentReads.push(row.id);
      return seededGetSectionContent(row);
    };
    const initialManager = RLMContextManager.getInstance();
    const initialVectorStore = VectorStore.getInstance();
    const firstConnection = seededDatabase.getRawDb();
    let closeEvents = 0;
    seededDatabase.on('database:closed', () => { closeEvents += 1; });

    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();

    let firstConnectionRejectedAfterClose = false;
    try {
      firstConnection.prepare('SELECT 1').get();
    } catch {
      firstConnectionRejectedAfterClose = true;
    }
    const fileSizeAfterClose = fs.statSync(databasePath).size;
    const reopenedDatabase = RLMDatabase.getInstance({
      dbPath: databasePath,
      contentDir,
      enableWAL: false,
    });
    const raw = reopenedDatabase.getRawDb();
    const count = (table) => raw.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count;
    const durableBeforeFreshRuntime = {
      stores: count('context_stores'),
      sections: count('context_sections'),
      sessions: count('rlm_sessions'),
      vectors: count('vectors'),
      missingVectors: raw.prepare(
        'SELECT COUNT(*) AS count '
        + 'FROM context_sections AS sections '
        + 'LEFT JOIN vectors AS vectors ON vectors.section_id = sections.id '
        + 'WHERE sections.store_id = ? AND vectors.id IS NULL',
      ).get('semantic-store').count,
    };

    const restartedManagerContentReads = [];
    const reopenedGetSectionContent = reopenedDatabase.getSectionContent.bind(reopenedDatabase);
    reopenedDatabase.getSectionContent = (row) => {
      restartedManagerContentReads.push(row.id);
      return reopenedGetSectionContent(row);
    };
    const embedTexts = [];
    const fakeEmbeddingService = {
      embed: async (text) => {
        embedTexts.push(text);
        return {
          embedding: [1, 0, 0],
          model: 'fixture-embed',
          tokens: Math.ceil(text.length / 4),
          cached: false,
          provider: 'fixture',
        };
      },
      embedBatch: async (texts) => Promise.all(texts.map((text) => fakeEmbeddingService.embed(text))),
      findSimilar: (_query, candidates, topK = 10) => candidates.slice(0, topK).map((candidate) => ({
        id: candidate.id,
        similarity: 1,
      })),
    };
    const restartedVectorStore = VectorStore.getInstance();
    restartedVectorStore.embeddingService = fakeEmbeddingService;
    const sectionEmbeddingCalls = [];
    const addSection = restartedVectorStore.addSection.bind(restartedVectorStore);
    restartedVectorStore.addSection = async (
      storeId, sectionId, content, metadata, options = {},
    ) => {
      sectionEmbeddingCalls.push({
        storeId,
        sectionId,
        content,
        existingSectionOnly: options.existingSectionOnly === true,
      });
      return addSection(storeId, sectionId, content, metadata, options);
    };

    const restartedManager = RLMContextManager.getInstance();
    const hydrationBeforeQuery = restartedManager.getStoreHydrationState('semantic-store');
    const queryResult = await restartedManager.executeQuery('semantic-session', {
      type: 'semantic_search',
      params: { query: queryText, useHyDE: false },
    });
    const existingVectorAfter = reopenedDatabase.getVectorBySectionId('semantic-existing');
    const missingVectorAfter = reopenedDatabase.getVectorBySectionId('semantic-missing');
    const existingVectorPreserved = existingVectorBefore.id === existingVectorAfter.id
      && existingVectorBefore.store_id === existingVectorAfter.store_id
      && existingVectorBefore.section_id === existingVectorAfter.section_id
      && Buffer.from(existingVectorBefore.embedding).equals(Buffer.from(existingVectorAfter.embedding))
      && existingVectorBefore.content_preview === existingVectorAfter.content_preview
      && existingVectorBefore.metadata_json === existingVectorAfter.metadata_json;

    result = {
      closeEvents,
      firstConnectionRejectedAfterClose,
      databaseIdentityChanged: seededDatabase !== reopenedDatabase,
      managerIdentityChanged: initialManager !== restartedManager,
      vectorStoreIdentityChanged: initialVectorStore !== restartedVectorStore,
      fileSizeAfterClose,
      durableBeforeFreshRuntime,
      initialManagerContentReads,
      restartedManagerContentReads,
      hydrationBeforeQuery,
      hydrationAfterQuery: restartedManager.getStoreHydrationState('semantic-store'),
      sectionEmbeddingCalls,
      embedTexts,
      existingVectorPreserved,
      missingVectorPersisted: missingVectorAfter
        && missingVectorAfter.store_id === 'semantic-store'
        && missingVectorAfter.section_id === 'semantic-missing',
      finalVectorCount: reopenedDatabase.getVectors('semantic-store').length,
      sectionsAccessed: queryResult.sectionsAccessed,
      networkGuard: {
        interceptedHealthChecks,
        unexpectedFetchAttempts,
        blockedSocketAttempts,
      },
    };
  } finally {
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
  }
  console.log('${RESTART_RESULT_PREFIX}' + JSON.stringify(result));
})();
`;

const hangingChildProcessScript = String.raw`
const fs = require('node:fs');
fs.writeFileSync(process.argv[1], 'ready');
setInterval(() => {}, 1_000);
`;

interface ManagerInternals {
  stores: Map<string, ContextStore>;
  sessions: Map<string, RLMSession>;
  residencyController: ContextResidencyController;
}

describe('RLM aggregate persisted-load regression', () => {
  let temporaryRoot: string;
  let db: RLMDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-rlm-aggregate-'));
    RLMDatabase._resetForTesting();
    db = RLMDatabase.getInstance({
      dbPath: path.join(temporaryRoot, 'fixture.db'),
      contentDir: path.join(temporaryRoot, 'content'),
    });
    VectorStore._resetForTesting();
    RLMContextManager._resetForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('bounds aggregate hot and on-demand residency and reconstructs it without doubling on reload', async () => {
    seedAggregateFixture();
    const getSectionMetadata = vi.spyOn(db, 'getSectionMetadata');
    const getSection = vi.spyOn(db, 'getSection');
    const getSectionContent = vi.spyOn(db, 'getSectionContent');
    let peakHeapBytes = process.memoryUsage().heapUsed;
    const sampleHeap = (): void => {
      peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed);
    };

    const manager = RLMContextManager.getInstance();
    sampleHeap();

    expect(getSectionMetadata).not.toHaveBeenCalled();
    expect(getSection).not.toHaveBeenCalled();
    expect(getSectionContent).not.toHaveBeenCalled();
    expect(manager.getResidencyStats()).toMatchObject({
      startupContentBytes: 0,
      residentMetadataSections: 0,
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
      deferredMetadataSections: STORE_TIMES.length * SECTIONS_PER_STORE,
    });
    expect(manager.listStores()).toHaveLength(STORE_TIMES.length);
    expect(manager.listStores().every((store) => store.sections.length === 0)).toBe(true);

    const durableBytes = STORE_TIMES.length * SECTIONS_PER_STORE * SECTION_BYTES;
    expect(STORE_TIMES.length * SECTIONS_PER_STORE).toBeGreaterThan(
      POLICY.maxResidentSectionMetadata,
    );
    expect(durableBytes).toBeGreaterThan(POLICY.maxResidentContentBytes);
    expect(STORE_TIMES.length * SECTIONS_PER_STORE).toBeGreaterThan(
      POLICY.maxResidentContentSections,
    );
    expect(STORE_TIMES.length).toBeGreaterThan(POLICY.maxResidentContentStores);

    const activeActivity = new Map([['active-old', NOW - (30 * 60 * 1_000)]]);
    expect(selectHotStoreCandidates(db.listStores(), activeActivity, NOW, POLICY)
      .map((store) => store.id)).toEqual([
      'active-old',
      'recent-new',
      'recent-a',
      'recent-b',
      'boundary',
    ]);

    installPolicy(manager);
    vi.useFakeTimers();
    expect(manager.startHotPrewarm()).toBe(true);
    await vi.runAllTimersAsync();
    sampleHeap();

    expect(getSectionContent.mock.calls.map(([row]) => row.store_id)).toEqual([
      'active-old',
      'active-old',
      'recent-new',
      'recent-new',
    ]);
    expect(manager.getResidencyStats()).toMatchObject({
      hotCandidates: 5,
      hotAdmitted: 2,
      hotExhausted: 3,
      residentMetadataSections: 4,
      residentContentBytes: 24,
      residentContentSections: 4,
      residentContentStores: 2,
    });
    expect(contentsFor(manager, 'active-old')).toEqual(contentsForStore(0));
    expect(contentsFor(manager, 'recent-new')).toEqual(contentsForStore(1));
    assertWithinPolicy(manager);

    const oldGraph = manager.listStores();
    expect(manager.exportStore('stale-a')?.store.sections.map((section) => section.content))
      .toEqual(contentsForStore(5));
    sampleHeap();
    expect(manager.getStoreHydrationState('active-old')?.content).toBe('resident');
    expect(manager.getStoreHydrationState('recent-new')?.content).toBe('deferred');
    expect(manager.getStoreHydrationState('stale-a')?.content).toBe('resident');
    expect(manager.listSections('recent-a')).toHaveLength(SECTIONS_PER_STORE);
    expect(() => manager.listSections('recent-b')).toThrowError(
      expect.objectContaining({ reason: 'metadata-budget-exhausted' }),
    );
    expect(manager.getResidencyStats()).toMatchObject({
      residentMetadataSections: POLICY.maxResidentSectionMetadata,
      exhausted: expect.objectContaining({ metadata: true }),
    });
    assertWithinPolicy(manager);

    const readsBeforeReload = getSectionContent.mock.calls.length;
    manager.reloadFromPersistence();
    sampleHeap();
    expect(getSectionContent).toHaveBeenCalledTimes(readsBeforeReload);
    expect(oldGraph.every((store) => store.sections.length === 0)).toBe(true);
    expect(manager.getResidencyStats()).toMatchObject({
      startupContentBytes: 0,
      residentMetadataSections: 0,
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
      deferredMetadataSections: STORE_TIMES.length * SECTIONS_PER_STORE,
    });

    installPolicy(manager);
    getSectionContent.mockClear();
    expect(manager.startHotPrewarm()).toBe(true);
    await vi.runAllTimersAsync();
    sampleHeap();

    expect(getSectionContent).toHaveBeenCalledTimes(4);
    expect(manager.getResidencyStats()).toMatchObject({
      residentMetadataSections: 4,
      residentContentBytes: 24,
      residentContentSections: 4,
      residentContentStores: 2,
    });
    assertWithinPolicy(manager);
    console.info('RLM aggregate fixture peak heap bytes (diagnostic only)', peakHeapBytes);
  });

  it('repairs exactly one durable vector gap through a semantic query after restart', async () => {
    const existingContent = 'durable existing vector';
    const missingContent = 'durable missing vector';
    const queryText = 'find durable vectors';
    const hangingChild = await runHangingChildIntegrityProof(temporaryRoot);
    expect(hangingChild).toMatchObject({
      timedOut: true,
      closeObserved: true,
      signal: 'SIGKILL',
      markerCreated: true,
      processAliveAfterClose: false,
      cleanupConfirmed: true,
    });
    expect(hangingChild.callbackErrorCode).toBeDefined();
    const result = await runDurableSemanticRestart(temporaryRoot);

    expect(result).toMatchObject({
      closeEvents: 1,
      firstConnectionRejectedAfterClose: true,
      databaseIdentityChanged: true,
      managerIdentityChanged: true,
      vectorStoreIdentityChanged: true,
      durableBeforeFreshRuntime: {
        stores: 1,
        sections: 2,
        sessions: 1,
        vectors: 1,
        missingVectors: 1,
      },
      initialManagerContentReads: [],
      hydrationBeforeQuery: {
        metadata: 'deferred',
        content: 'deferred',
      },
      hydrationAfterQuery: {
        metadata: 'resident',
        content: 'deferred',
      },
      existingVectorPreserved: true,
      missingVectorPersisted: true,
      finalVectorCount: 2,
    });
    expect(result.networkGuard).toEqual({
      interceptedHealthChecks: [{
        url: 'http://localhost:11434/api/tags',
        method: 'GET',
      }],
      unexpectedFetchAttempts: [],
      blockedSocketAttempts: [],
    });
    expect(result.fileSizeAfterClose).toBeGreaterThan(0);
    expect(result.restartedManagerContentReads).toEqual(['semantic-missing']);
    expect(result.sectionEmbeddingCalls).toEqual([{
      storeId: 'semantic-store',
      sectionId: 'semantic-missing',
      content: missingContent,
      existingSectionOnly: true,
    }]);
    expect(result.embedTexts).toEqual([missingContent, queryText]);
    expect(result.sectionsAccessed).toEqual(expect.arrayContaining([
      'semantic-existing',
      'semantic-missing',
    ]));
  }, 10_000);

  it('keeps a store above the injected per-store section ceiling content-deferred', () => {
    db.createStore({ id: 'over-policy-store', instanceId: 'over-policy-instance' });
    [0, 1, 2].forEach((sectionIndex) => {
      const content = `P${String(sectionIndex).padStart(5, '0')}`;
      db.addSection({
        id: sectionId('over-policy-store', sectionIndex),
        storeId: 'over-policy-store',
        type: 'external',
        name: `over-policy-${sectionIndex}`,
        startOffset: sectionIndex * SECTION_BYTES,
        endOffset: (sectionIndex + 1) * SECTION_BYTES,
        tokens: 2,
        content,
      });
    });
    const getSectionContent = vi.spyOn(db, 'getSectionContent');
    const manager = RLMContextManager.getInstance();
    installPolicy(manager);

    expect(manager.getStoreHydrationState('over-policy-store')?.sectionCount).toBe(
      POLICY.maxSectionsPerStore + 1,
    );
    expect(manager.getStoreHydrationState('over-policy-store')?.contentEligible).toBe(false);
    expect(() => manager.exportStore('over-policy-store')).toThrowError(
      expect.objectContaining({ reason: 'content-ineligible' }),
    );
    expect(getSectionContent).not.toHaveBeenCalled();
    expect(manager.getResidencyStats()).toMatchObject({
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
    });
  });

  function seedAggregateFixture(): void {
    STORE_TIMES.forEach(([storeId, timestamp], storeIndex) => {
      db.createStore({ id: storeId, instanceId: `instance-${storeIndex}` });
      contentsForStore(storeIndex).forEach((content, sectionIndex) => {
        db.addSection({
          id: sectionId(storeId, sectionIndex),
          storeId,
          type: 'external',
          name: `note-${storeIndex}-${sectionIndex}`,
          startOffset: sectionIndex * SECTION_BYTES,
          endOffset: (sectionIndex + 1) * SECTION_BYTES,
          tokens: 2,
          content,
        });
      });
      db.getRawDb().prepare(`
        UPDATE context_stores SET created_at = ?, last_accessed = ? WHERE id = ?
      `).run(timestamp, timestamp, storeId);
    });
    db.createSession({
      id: 'active-session',
      storeId: 'active-old',
      instanceId: 'active-instance',
      estimatedDirectTokens: 8,
    });
    db.getRawDb().prepare(`
      UPDATE rlm_sessions
      SET started_at = ?, last_activity_at = ?
      WHERE id = ?
    `).run(NOW - HOUR, NOW - (30 * 60 * 1_000), 'active-session');
  }

  function installPolicy(manager: RLMContextManager): void {
    const internals = manager as unknown as ManagerInternals;
    const current = internals.residencyController;
    internals.residencyController = new ContextResidencyController({
      db,
      stores: internals.stores,
      sessions: internals.sessions,
      hydrationStates: current.getHydrationStates(),
      loadStats: current.getStats(),
      policy: POLICY,
      now: () => NOW,
    });
  }

  function assertWithinPolicy(manager: RLMContextManager): void {
    const stats = manager.getResidencyStats();
    expect(stats).not.toBeNull();
    expect(stats!.residentMetadataSections).toBeLessThanOrEqual(
      POLICY.maxResidentSectionMetadata,
    );
    expect(stats!.residentContentBytes).toBeLessThanOrEqual(
      POLICY.maxResidentContentBytes,
    );
    expect(stats!.residentContentSections).toBeLessThanOrEqual(
      POLICY.maxResidentContentSections,
    );
    expect(stats!.residentContentStores).toBeLessThanOrEqual(
      POLICY.maxResidentContentStores,
    );
    for (const store of manager.listStores()) {
      if (manager.getStoreHydrationState(store.id)?.content === 'resident') {
        expect(store.sections).toHaveLength(SECTIONS_PER_STORE);
        expect(store.sections.length).toBeLessThanOrEqual(POLICY.maxSectionsPerStore);
      }
    }
  }

  function contentsFor(manager: RLMContextManager, storeId: string): string[] {
    return manager.listSections(storeId).map((section) => section.content);
  }
});

async function runDurableSemanticRestart(temporaryRoot: string): Promise<DurableRestartResult> {
  const execution = await runBoundedElectronChild(
    durableRestartProcessScript,
    [
    path.join(temporaryRoot, 'fixture.db'),
    path.join(temporaryRoot, 'content'),
    ],
    DURABLE_CHILD_TIMEOUT_MS,
  );
  if (execution.timedOut || execution.exitCode !== 0 || execution.callbackErrorCode) {
    throw new Error(formatChildFailure('Durable RLM restart', execution));
  }
  const resultLine = execution.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(RESTART_RESULT_PREFIX));
  if (!resultLine) throw new Error('Durable RLM restart process returned no result');
  return JSON.parse(resultLine.slice(RESTART_RESULT_PREFIX.length)) as DurableRestartResult;
}

function formatChildFailure(label: string, execution: ElectronChildExecution): string {
  const clip = (value: string): string => value.trim().slice(0, 2_000) || '(empty)';
  return `${label} child failed: timedOut=${execution.timedOut}, `
    + `exitCode=${String(execution.exitCode)}, signal=${String(execution.signal)}, `
    + `errorCode=${execution.callbackErrorCode ?? '(none)'}, `
    + `stdout=${JSON.stringify(clip(execution.stdout))}, `
    + `stderr=${JSON.stringify(clip(execution.stderr))}`;
}

async function runHangingChildIntegrityProof(
  temporaryRoot: string,
): Promise<HangingChildEvidence> {
  const childRoot = fs.mkdtempSync(path.join(temporaryRoot, 'hanging-child-'));
  const markerPath = path.join(childRoot, 'started.txt');
  let evidence: Omit<HangingChildEvidence, 'cleanupConfirmed'> | undefined;
  try {
    const execution = await runBoundedElectronChild(
      hangingChildProcessScript,
      [markerPath],
      HANGING_CHILD_TIMEOUT_MS,
    );
    evidence = {
      timedOut: execution.timedOut,
      closeObserved: execution.closeObserved,
      signal: execution.signal,
      callbackErrorCode: execution.callbackErrorCode,
      markerCreated: fs.existsSync(markerPath),
      processAliveAfterClose: isProcessAlive(execution.pid),
    };
  } finally {
    fs.rmSync(childRoot, { recursive: true, force: true });
  }
  if (!evidence) throw new Error('Hanging-child integrity proof produced no evidence');
  return { ...evidence, cleanupConfirmed: !fs.existsSync(childRoot) };
}

function runBoundedElectronChild(
  script: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ElectronChildExecution> {
  return new Promise((resolve) => {
    let timedOut = false;
    let callbackComplete = false;
    let closeObserved = false;
    let stdout = '';
    let stderr = '';
    let callbackErrorCode: string | undefined;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    const child = execFile(electronPath, ['-e', script, ...args], {
      cwd: process.cwd(),
      env: minimalChildEnvironment(),
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, childStdout, childStderr) => {
      stdout = childStdout;
      stderr = childStderr;
      if (error) {
        callbackErrorCode = 'code' in error && typeof error.code === 'string'
          ? error.code
          : error.name;
      }
      callbackComplete = true;
      finish();
    });
    const pid = child.pid ?? -1;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('close', (code, closeSignal) => {
      clearTimeout(deadline);
      exitCode = code;
      signal = closeSignal;
      closeObserved = true;
      finish();
    });

    function finish(): void {
      if (!callbackComplete || !closeObserved) return;
      resolve({
        stdout,
        stderr,
        exitCode,
        signal,
        callbackErrorCode,
        timedOut,
        closeObserved,
        pid,
      });
    }
  });
}

function minimalChildEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'test',
  };
  for (const name of ['TMPDIR', 'TMP', 'TEMP'] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function isProcessAlive(pid: number): boolean {
  if (pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function contentsForStore(storeIndex: number): string[] {
  return [0, 1].map((sectionIndex) => (
    `${String.fromCharCode(65 + storeIndex)}${String(sectionIndex).padStart(5, '0')}`
  ));
}

function sectionId(storeId: string, sectionIndex: number): string {
  return `section-${storeId}-${sectionIndex}`;
}
