import type {
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';
import type { RLMDatabase } from '../persistence/rlm-database';
import type { RlmResidencySnapshot } from './context/context.types';

const METADATA_ONLY_TOKEN_LIMIT = 2_000_000;
const METADATA_ONLY_SIZE_LIMIT = 25 * 1024 * 1024;

export interface RlmResidencyPolicy {
  hotWindowMs: number;
  maxResidentSectionMetadata: number;
  maxResidentContentBytes: number;
  maxResidentContentSections: number;
  maxResidentContentStores: number;
  maxSectionsPerStore: number;
}

export type RlmProcessRole = 'context-worker' | 'indexing-lane';

export function getRlmProcessRole(): RlmProcessRole {
  return process.env['AIO_RLM_PROCESS_ROLE'] === 'indexing-lane'
    || process.argv.some((argument) => argument.includes('codebase-indexing-lane-main'))
    ? 'indexing-lane'
    : 'context-worker';
}

export const DEFAULT_RLM_RESIDENCY_POLICY: RlmResidencyPolicy = {
  hotWindowMs: 48 * 60 * 60 * 1000,
  maxResidentSectionMetadata: 50_000,
  maxResidentContentBytes: 64 * 1024 * 1024,
  maxResidentContentSections: 20_000,
  maxResidentContentStores: 128,
  maxSectionsPerStore: 5_000,
};

export interface RlmPersistedLoadStats {
  discoveredStores: number;
  activeSessions: number;
  startupContentBytes: 0;
  residentMetadataSections: number;
  deferredMetadataSections: number;
  residentContentBytes: number;
  residentContentSections: number;
  residentContentStores: number;
  hotCandidates: number;
  hotAdmitted: number;
  hotSkipped: number;
  hotExhausted: number;
  hotCancelled: number;
  semanticDiscovered: number;
  semanticIndexed: number;
  semanticSkipped: number;
  semanticFailed: number;
  semanticRetried: number;
  metadataOnlyStores: number;
  deferredStores: number;
  exhausted: {
    metadata: boolean;
    contentBytes: boolean;
    contentSections: boolean;
    contentStores: boolean;
  };
  elapsedMs: number;
}

export function buildRlmLoadSummary(
  stats: Readonly<RlmPersistedLoadStats>,
): RlmResidencySnapshot {
  return {
    processRole: getRlmProcessRole(),
    ...stats,
    counts: {
      durableStores: stats.discoveredStores,
      durableSections: stats.residentMetadataSections + stats.deferredMetadataSections,
      activeSessions: stats.activeSessions,
      residentMetadataSections: stats.residentMetadataSections,
      deferredMetadataSections: stats.deferredMetadataSections,
      residentContentSections: stats.residentContentSections,
      residentContentStores: stats.residentContentStores,
      metadataOnlyStores: stats.metadataOnlyStores,
      deferredStores: stats.deferredStores,
    },
    exhausted: { ...stats.exhausted },
    elapsedMs: Math.max(0, stats.elapsedMs),
  };
}

export interface RlmStoreHydrationState {
  metadata: 'deferred' | 'resident';
  content: 'deferred' | 'resident';
  contentEligible: boolean;
  sectionCount: number;
}

export interface PersistedContextState {
  stores: Map<string, ContextStore>;
  sessions: Map<string, RLMSession>;
  loadedStores: number;
  loadedSections: number;
  loadStats: Readonly<RlmPersistedLoadStats>;
  hydrationStates: ReadonlyMap<string, Readonly<RlmStoreHydrationState>>;
}

export function loadPersistedContextState(
  db: RLMDatabase,
  policy: RlmResidencyPolicy = DEFAULT_RLM_RESIDENCY_POLICY,
): PersistedContextState {
  const now = Date.now();
  const startedAt = now;
  const stores = new Map<string, ContextStore>();
  const sessions = new Map<string, RLMSession>();
  const hydrationStates = new Map<string, Readonly<RlmStoreHydrationState>>();
  for (const row of db.listSessions()) {
    if (row.ended_at === null) {
      const session = parsePersistedSession(row);
      if (session) {
        sessions.set(session.id, session);
      }
    }
  }

  const storeRows = db.listStores();
  const sectionCountsByStore = new Map(
    db.getSectionCountsByStore().map((row) => [row.store_id, row.section_count]),
  );
  let deferredMetadataSections = 0;
  for (const row of storeRows) {
    const config = parseStoreConfig(row.config_json);
    const sectionCount = sectionCountsByStore.get(row.id) ?? 0;
    const contentEligible = !shouldLoadMetadataOnly(row, config, sectionCount, policy);

    const store: ContextStore = {
      id: row.id,
      instanceId: row.instance_id,
      sections: [],
      totalTokens: row.total_tokens,
      totalSize: row.total_size,
      createdAt: row.created_at,
      lastAccessed: row.last_accessed,
      accessCount: row.access_count,
      ...(config ? { config } : {}),
    };

    stores.set(row.id, store);
    deferredMetadataSections += sectionCount;
    hydrationStates.set(row.id, Object.freeze({
      metadata: 'deferred',
      content: 'deferred',
      contentEligible,
      sectionCount,
    }));
  }

  const loadStats = Object.freeze({
    discoveredStores: storeRows.length,
    activeSessions: sessions.size,
    startupContentBytes: 0 as const,
    residentMetadataSections: 0,
    deferredMetadataSections,
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
    metadataOnlyStores: storeRows.length,
    deferredStores: storeRows.length,
    exhausted: Object.freeze({
      metadata: false,
      contentBytes: false,
      contentSections: false,
      contentStores: false,
    }),
    elapsedMs: Date.now() - startedAt,
  });

  return {
    stores,
    sessions,
    loadedStores: storeRows.length,
    loadedSections: 0,
    loadStats,
    hydrationStates: createReadonlyMapView(hydrationStates),
  };
}

export function selectHotStoreCandidates<Store extends {
  id: string;
  created_at: number;
  last_accessed: number;
}>(
  stores: readonly Store[],
  activeSessionStoreActivity: ReadonlyMap<string, number> | ReadonlySet<string>,
  now: number,
  policy: RlmResidencyPolicy = DEFAULT_RLM_RESIDENCY_POLICY,
): Store[] {
  const hotCutoff = now - policy.hotWindowMs;

  return stores
    .filter((store) => activeSessionStoreActivity.has(store.id)
      || store.last_accessed >= hotCutoff
      || store.created_at >= hotCutoff)
    .sort((left, right) => {
      const leftHasActiveSession = activeSessionStoreActivity.has(left.id);
      const rightHasActiveSession = activeSessionStoreActivity.has(right.id);
      if (leftHasActiveSession !== rightHasActiveSession) {
        return leftHasActiveSession ? -1 : 1;
      }
      if (leftHasActiveSession) {
        const leftActivity = getActiveSessionActivity(activeSessionStoreActivity, left.id);
        const rightActivity = getActiveSessionActivity(activeSessionStoreActivity, right.id);
        if (leftActivity !== rightActivity) {
          return rightActivity - leftActivity;
        }
      } else {
        const leftRecency = Math.max(left.last_accessed, left.created_at);
        const rightRecency = Math.max(right.last_accessed, right.created_at);
        if (leftRecency !== rightRecency) {
          return rightRecency - leftRecency;
        }
      }
      return left.id.localeCompare(right.id);
    });
}

function shouldLoadMetadataOnly(
  row: { total_tokens: number; total_size: number },
  config: Record<string, unknown> | undefined,
  sectionCount: number,
  policy: Readonly<RlmResidencyPolicy>,
): boolean {
  if (config?.['kind'] === 'codebase-auto') {
    return true;
  }
  return (
    sectionCount > policy.maxSectionsPerStore
    || row.total_tokens > METADATA_ONLY_TOKEN_LIMIT
    || row.total_size > METADATA_ONLY_SIZE_LIMIT
  );
}

function parseStoreConfig(configJson: string | null): Record<string, unknown> | undefined {
  if (!configJson) return undefined;
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Corrupt store config should not prevent RLM stores from loading.
  }
  return undefined;
}

function parsePersistedSession(row: ReturnType<RLMDatabase['listSessions']>[number]): RLMSession | undefined {
  const queries = parseSessionArray<RLMSession['queries']>(row.queries_json);
  const recursiveCalls = parseSessionArray<RLMSession['recursiveCalls']>(row.recursive_calls_json);
  if (!queries || !recursiveCalls) return undefined;

  return {
    id: row.id,
    storeId: row.store_id,
    instanceId: row.instance_id,
    queries,
    recursiveCalls,
    totalRootTokens: row.total_root_tokens,
    totalSubQueryTokens: row.total_sub_query_tokens,
    estimatedDirectTokens: row.estimated_direct_tokens,
    tokenSavingsPercent: row.token_savings_percent,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
  };
}

function parseSessionArray<Value>(json: string | null): Value | undefined {
  if (json === null) return [] as Value;
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed as Value : undefined;
  } catch {
    return undefined;
  }
}

function getActiveSessionActivity(
  activeSessionStoreActivity: ReadonlyMap<string, number> | ReadonlySet<string>,
  storeId: string,
): number {
  return 'get' in activeSessionStoreActivity
    ? activeSessionStoreActivity.get(storeId) ?? 0
    : 0;
}

function createReadonlyMapView<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  let view: ReadonlyMap<Key, Value>;
  view = new Proxy(source, {
    get(target, property) {
      if (property === 'set' || property === 'delete' || property === 'clear') {
        return () => {
          throw new TypeError('Cannot mutate a readonly hydration-state map');
        };
      }
      if (property === 'forEach') {
        return (callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) => {
          target.forEach((value, key) => callbackfn.call(thisArg, value, key, view));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze(view);
}
