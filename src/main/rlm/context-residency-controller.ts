import type {
  ContextSection,
  ContextStore,
  RLMSession,
} from '../../shared/types/rlm.types';
import type { RLMDatabase } from '../persistence/rlm-database';
import type { ContextSectionMetadataRow } from '../persistence/rlm-database.types';
import type { RlmResidencySnapshot, StorageStats } from './context/context.types';
import {
  buildRlmLoadSummary,
  DEFAULT_RLM_RESIDENCY_POLICY,
  type RlmPersistedLoadStats,
  type RlmResidencyPolicy,
  type RlmStoreHydrationState,
} from './context-persistence-loader';
import {
  cancelRlmHotPrewarm,
  getRlmHotPrewarmStats,
  startRlmHotPrewarm,
  type RlmHotPrewarmStats,
} from './rlm-hot-prewarm';
export type RlmHydrationFailureReason =
  | 'store-not-found'
  | 'metadata-budget-exhausted'
  | 'metadata-read-failed'
  | 'content-ineligible'
  | 'content-byte-budget-exhausted'
  | 'content-section-budget-exhausted'
  | 'content-store-budget-exhausted'
  | 'protected-content-prevents-admission'
  | 'actual-content-exceeds-byte-budget'
  | 'content-read-failed';
export interface RlmResidencyAdmissionFailure {
  reason: RlmHydrationFailureReason;
}
export type RlmResidencyStats = RlmResidencySnapshot;
export interface RlmHydrationResult {
  storeId: string;
  changed: boolean;
  state?: Readonly<RlmStoreHydrationState>;
  reason?: RlmHydrationFailureReason;
  evictedStoreIds: readonly string[];
}
export interface EnsureContentOptions { allowEviction?: boolean; }
export class RlmHydrationError extends Error {
  override readonly name = 'RlmHydrationError';
  constructor(
    readonly storeId: string,
    readonly reason: RlmHydrationFailureReason,
  ) {
    super(`Unable to hydrate RLM store ${storeId}: ${reason}`);
  }
}
export interface ContextResidencyControllerOptions {
  db: RLMDatabase;
  stores: Map<string, ContextStore>;
  sessions: Map<string, RLMSession>;
  hydrationStates: ReadonlyMap<string, Readonly<RlmStoreHydrationState>>;
  loadStats: Readonly<RlmPersistedLoadStats>;
  policy?: RlmResidencyPolicy;
  now?: () => number;
  onStatsChanged?: (stats: Readonly<RlmResidencyStats>) => void;
}
interface ContentCapacity {
  bytes: boolean;
  sections: boolean;
  stores: boolean;
}
export class ContextResidencyController {
  private readonly db: RLMDatabase;
  private readonly stores: Map<string, ContextStore>;
  private readonly sessions: Map<string, RLMSession>;
  private readonly policy: RlmResidencyPolicy;
  private readonly now: () => number;
  private readonly onStatsChanged?: (stats: Readonly<RlmResidencyStats>) => void;
  private readonly states = new Map<string, RlmStoreHydrationState>();
  private readonly estimatedBytesByStore = new Map<string, number>();
  private readonly residentBytesByStore = new Map<string, number>();
  private readonly lastUsedAt = new Map<string, number>();
  private readonly stats: RlmPersistedLoadStats & {
    lastAdmissionFailure?: RlmResidencyAdmissionFailure;
  };
  constructor(options: ContextResidencyControllerOptions) {
    this.db = options.db;
    this.stores = options.stores;
    this.sessions = options.sessions;
    this.policy = { ...(options.policy ?? DEFAULT_RLM_RESIDENCY_POLICY) };
    this.now = options.now ?? Date.now;
    this.onStatsChanged = options.onStatsChanged;
    for (const [storeId, state] of options.hydrationStates) {
      const contentEligible = state.contentEligible
        && state.sectionCount <= this.policy.maxSectionsPerStore;
      this.states.set(storeId, { ...state, contentEligible });
      this.lastUsedAt.set(storeId, this.stores.get(storeId)?.lastAccessed ?? 0);
    }
    this.stats = { ...options.loadStats, exhausted: { ...options.loadStats.exhausted } };
  }
  getHydrationState(storeId: string): Readonly<RlmStoreHydrationState> | undefined {
    const state = this.states.get(storeId);
    return state ? Object.freeze({ ...state }) : undefined;
  }
  getHydrationStates(): ReadonlyMap<string, Readonly<RlmStoreHydrationState>> {
    const snapshot = new Map<string, Readonly<RlmStoreHydrationState>>();
    for (const [storeId, state] of this.states) {
      snapshot.set(storeId, Object.freeze({ ...state }));
    }
    return createReadonlyMapView(snapshot);
  }
  getStats(): Readonly<RlmResidencyStats> {
    const snapshot = buildRlmLoadSummary(this.stats);
    return Object.freeze({
      ...snapshot,
      counts: Object.freeze({ ...snapshot.counts }),
      exhausted: Object.freeze({ ...snapshot.exhausted }),
      ...(this.stats.lastAdmissionFailure
        ? { lastAdmissionFailure: Object.freeze({ ...this.stats.lastAdmissionFailure }) }
        : {}),
    });
  }
  startHotPrewarm(): boolean {
    return startRlmHotPrewarm(this, {
      stores: this.stores, sessions: this.sessions, policy: this.policy,
      counters: this.stats, now: this.now,
      hydrateContent: (storeId) => this.ensureContent(storeId, { allowEviction: false }),
      getResidencyStats: () => this.getStats(),
      onSummary: () => this.onStatsChanged?.(this.getStats()),
    });
  }
  cancelHotPrewarm(): boolean { return cancelRlmHotPrewarm(this); }
  getHotPrewarmStats(): Readonly<RlmHotPrewarmStats> { return getRlmHotPrewarmStats(this); }
  requireMetadata(storeId: string): Readonly<RlmStoreHydrationState> {
    const result = this.ensureMetadata(storeId);
    if (result.state?.metadata !== 'resident')
      throw new RlmHydrationError(storeId, result.reason ?? 'metadata-read-failed');
    return result.state;
  }
  requireContent(storeId: string): Readonly<RlmStoreHydrationState> {
    const result = this.ensureContent(storeId);
    if (result.state?.content !== 'resident')
      throw new RlmHydrationError(storeId, result.reason ?? 'content-read-failed');
    return result.state;
  }
  getStorageStats(): StorageStats {
    let totalSections = 0, totalTokens = 0, totalSizeBytes = 0;
    for (const store of this.stores.values()) {
      const state = this.states.get(store.id);
      totalSections += state?.sectionCount ?? store.sections.length;
      totalTokens += store.totalTokens;
      totalSizeBytes += store.totalSize;
    }
    let byType: StorageStats['byType'];
    try {
      byType = this.db.getSectionStatsByType().map((row) => ({
        type: row.type,
        count: row.section_count,
        tokens: row.total_tokens,
      }));
    } catch {
      throw new RlmHydrationError('aggregate', 'metadata-read-failed');
    }
    return { totalStores: this.stores.size, totalSections, totalTokens, totalSizeBytes,
      byType };
  }
  markAccessed(storeId: string, accessedAt = this.now()): void {
    if (this.states.has(storeId)) {
      this.lastUsedAt.set(storeId, accessedAt);
    }
  }
  syncActiveSessions(): void {
    this.stats.activeSessions = this.sessions.size;
  }
  accountSemanticDelta(summary: { missing: number; indexed: number; skipped: number; failed: number; retried: number }): void {
    this.stats.semanticDiscovered += summary.missing;
    this.stats.semanticIndexed += summary.indexed;
    this.stats.semanticSkipped += summary.skipped;
    this.stats.semanticFailed += summary.failed;
    this.stats.semanticRetried += summary.retried;
    this.onStatsChanged?.(this.getStats());
  }
  registerRuntimeStore(store: ContextStore): void {
    if (this.states.has(store.id)) return;

    const residentBytes = contentBytes(store.sections);
    const sectionCount = store.sections.length;
    this.states.set(store.id, {
      metadata: 'resident',
      content: 'resident',
      contentEligible: true,
      sectionCount,
    });
    this.estimatedBytesByStore.set(store.id, residentBytes);
    this.residentBytesByStore.set(store.id, residentBytes);
    this.lastUsedAt.set(store.id, store.lastAccessed);
    this.stats.residentMetadataSections += sectionCount;
    this.stats.residentContentBytes += residentBytes;
    this.stats.residentContentSections += sectionCount;
    if (sectionCount > 0) this.stats.residentContentStores += 1;
  }
  accountSectionsAdded(storeId: string, sections: readonly ContextSection[]): void {
    if (sections.length === 0) return;
    const state = this.states.get(storeId);
    if (!state) return;
    const previousSectionCount = state.sectionCount;
    const addedBytes = contentBytes(sections);
    state.sectionCount += sections.length;
    this.estimatedBytesByStore.set(
      storeId,
      (this.estimatedBytesByStore.get(storeId) ?? 0) + addedBytes,
    );
    if (state.metadata === 'resident') {
      this.stats.residentMetadataSections += sections.length;
    } else {
      this.stats.deferredMetadataSections += sections.length;
    }
    if (state.content === 'resident') {
      this.residentBytesByStore.set(
        storeId,
        (this.residentBytesByStore.get(storeId) ?? 0) + addedBytes,
      );
      this.stats.residentContentBytes += addedBytes;
      this.stats.residentContentSections += sections.length;
      if (previousSectionCount === 0) this.stats.residentContentStores += 1;
      const deficits = this.currentContentDeficits(0, 0, 0);
      if (hasDeficit(deficits)) {
        this.markContentExhausted(deficits);
        this.evictContent(storeId);
      }
    }
  }
  accountSectionRemoved(storeId: string, section: ContextSection): void {
    const state = this.states.get(storeId);
    if (!state || state.sectionCount === 0) return;

    const removedBytes = Buffer.byteLength(section.content, 'utf8');
    state.sectionCount -= 1;
    this.estimatedBytesByStore.set(
      storeId,
      Math.max(
        0,
        (this.estimatedBytesByStore.get(storeId) ?? 0)
          - Math.max(removedBytes, section.endOffset - section.startOffset),
      ),
    );
    if (state.metadata === 'resident') {
      this.stats.residentMetadataSections = Math.max(
        0,
        this.stats.residentMetadataSections - 1,
      );
    } else {
      this.stats.deferredMetadataSections = Math.max(
        0,
        this.stats.deferredMetadataSections - 1,
      );
    }
    if (state.content === 'resident') {
      const residentBytes = Math.max(
        0,
        (this.residentBytesByStore.get(storeId) ?? 0) - removedBytes,
      );
      this.residentBytesByStore.set(storeId, residentBytes);
      this.stats.residentContentBytes = Math.max(
        0,
        this.stats.residentContentBytes - removedBytes,
      );
      this.stats.residentContentSections = Math.max(
        0,
        this.stats.residentContentSections - 1,
      );
      if (state.sectionCount === 0) {
        this.stats.residentContentStores = Math.max(
          0,
          this.stats.residentContentStores - 1,
        );
      }
    }
  }
  unregisterStore(storeId: string): void {
    const state = this.states.get(storeId);
    const store = this.stores.get(storeId);
    if (!state) return;
    if (state.metadata === 'resident') {
      this.stats.residentMetadataSections = Math.max(
        0,
        this.stats.residentMetadataSections - (store?.sections.length ?? state.sectionCount),
      );
    } else {
      this.stats.deferredMetadataSections = Math.max(
        0,
        this.stats.deferredMetadataSections - state.sectionCount,
      );
    }
    if (state.content === 'resident') {
      this.stats.residentContentBytes = Math.max(
        0,
        this.stats.residentContentBytes - (this.residentBytesByStore.get(storeId) ?? 0),
      );
      this.stats.residentContentSections = Math.max(
        0,
        this.stats.residentContentSections - state.sectionCount,
      );
      if (state.sectionCount > 0) {
        this.stats.residentContentStores = Math.max(
          0,
          this.stats.residentContentStores - 1,
        );
      }
    } else {
      this.stats.metadataOnlyStores = Math.max(0, this.stats.metadataOnlyStores - 1);
      this.stats.deferredStores = Math.max(0, this.stats.deferredStores - 1);
    }

    if (store) {
      for (const section of store.sections) section.content = '';
      store.sections = [];
      store.bloomFilter = undefined;
      store.summaryIndex = undefined;
    }
    this.states.delete(storeId);
    this.estimatedBytesByStore.delete(storeId);
    this.residentBytesByStore.delete(storeId);
    this.lastUsedAt.delete(storeId);
  }
  /** Release every old graph reference before a persistence reload. */
  clear(): void {
    this.cancelHotPrewarm();
    for (const storeId of [...this.states.keys()]) this.unregisterStore(storeId);
    this.states.clear();
    this.estimatedBytesByStore.clear();
    this.residentBytesByStore.clear();
    this.lastUsedAt.clear();
    this.stats.residentMetadataSections = 0;
    this.stats.deferredMetadataSections = 0;
    this.stats.residentContentBytes = 0;
    this.stats.residentContentSections = 0;
    this.stats.residentContentStores = 0;
    this.stats.metadataOnlyStores = 0;
    this.stats.deferredStores = 0;
    this.clearAdmissionFailure();
  }
  ensureMetadata(storeId: string): RlmHydrationResult {
    const state = this.states.get(storeId);
    const store = this.stores.get(storeId);
    if (!state || !store) {
      return this.failureResult(storeId, false, 'store-not-found');
    }
    if (state.metadata === 'resident') {
      return this.result(storeId, false);
    }
    const metadataRemaining = this.policy.maxResidentSectionMetadata
      - this.stats.residentMetadataSections;
    if (state.sectionCount > metadataRemaining) {
      this.stats.exhausted.metadata = true;
      return this.failureResult(storeId, false, 'metadata-budget-exhausted');
    }
    let rows: ContextSectionMetadataRow[];
    try {
      rows = this.db.getSectionMetadata(storeId);
    } catch {
      return this.failureResult(storeId, false, 'metadata-read-failed');
    }
    if (rows.length > metadataRemaining) {
      this.stats.exhausted.metadata = true;
      return this.failureResult(storeId, false, 'metadata-budget-exhausted');
    }
    const previousSectionCount = state.sectionCount;
    const sections = rows.map(rowToSectionMetadata);
    store.sections = sections;
    state.sectionCount = rows.length;
    state.contentEligible = state.contentEligible && rows.length <= this.policy.maxSectionsPerStore;
    state.metadata = 'resident';
    this.estimatedBytesByStore.set(
      storeId,
      rows.reduce((total, row) => total + Math.max(0, row.content_size_bytes), 0),
    );
    this.stats.residentMetadataSections += rows.length;
    this.stats.deferredMetadataSections = Math.max(
      0,
      this.stats.deferredMetadataSections - previousSectionCount,
    );
    this.clearAdmissionFailure();
    return this.result(storeId, true);
  }
  ensureContent(storeId: string, options: EnsureContentOptions = {}): RlmHydrationResult {
    const metadataResult = this.ensureMetadata(storeId);
    const state = this.states.get(storeId);
    const store = this.stores.get(storeId);
    if (!state || !store) return metadataResult;
    if (state.metadata !== 'resident') return metadataResult;
    if (state.content === 'resident') {
      this.markAccessed(storeId);
      this.clearAdmissionFailure();
      return this.result(storeId, metadataResult.changed);
    }
    if (!state.contentEligible) {
      return this.failureResult(storeId, metadataResult.changed, 'content-ineligible');
    }
    const requiredBytes = this.estimatedBytesByStore.get(storeId) ?? 0;
    const requiredSections = store.sections.length;
    const requiredStoreSlots = requiredSections > 0 ? 1 : 0;
    const absoluteDeficits = this.contentDeficits(
      requiredBytes,
      requiredSections,
      requiredStoreSlots,
      {
      residentContentBytes: 0,
      residentContentSections: 0,
      residentContentStores: 0,
      },
    );
    if (hasDeficit(absoluteDeficits)) {
      this.markContentExhausted(absoluteDeficits);
      return this.failureResult(
        storeId,
        metadataResult.changed,
        firstContentFailureReason(absoluteDeficits),
      );
    }

    const evictedStoreIds: string[] = [];
    const evictionCandidates = options.allowEviction === false
      ? []
      : this.contentEvictionCandidates(storeId);
    const hasProtectedCandidate = this.hasProtectedResidentStore(storeId);
    let deficits = this.currentContentDeficits(
      requiredBytes,
      requiredSections,
      requiredStoreSlots,
    );
    while (hasDeficit(deficits) && evictionCandidates.length > 0) {
      const candidateId = evictionCandidates.shift()!;
      this.evictContent(candidateId);
      evictedStoreIds.push(candidateId);
      deficits = this.currentContentDeficits(
        requiredBytes,
        requiredSections,
        requiredStoreSlots,
      );
    }

    if (hasDeficit(deficits)) {
      this.markContentExhausted(deficits);
      const reason = hasProtectedCandidate
        ? 'protected-content-prevents-admission'
        : firstContentFailureReason(deficits);
      return this.failureResult(
        storeId,
        metadataResult.changed || evictedStoreIds.length > 0,
        reason,
        evictedStoreIds,
      );
    }

    const contentBySection = new Map<string, string>();
    let actualBytes = 0;
    try {
      for (const section of store.sections) {
        const row = this.db.getSection(section.id);
        if (!row) {
          return this.failureResult(
            storeId,
            metadataResult.changed || evictedStoreIds.length > 0,
            'content-read-failed',
            evictedStoreIds,
          );
        }
        const content = this.db.getSectionContent(row);
        const sectionBytes = Buffer.byteLength(content, 'utf8');
        const bytesAfterSection = actualBytes + sectionBytes;
        while (
          this.stats.residentContentBytes + bytesAfterSection
            > this.policy.maxResidentContentBytes
          && evictionCandidates.length > 0
        ) {
          const candidateId = evictionCandidates.shift()!;
          this.evictContent(candidateId);
          evictedStoreIds.push(candidateId);
        }
        if (
          this.stats.residentContentBytes + bytesAfterSection
            > this.policy.maxResidentContentBytes
        ) {
          this.stats.exhausted.contentBytes = true;
          contentBySection.clear();
          const reason = bytesAfterSection <= this.policy.maxResidentContentBytes
            && hasProtectedCandidate
            ? 'protected-content-prevents-admission'
            : 'actual-content-exceeds-byte-budget';
          return this.failureResult(
            storeId,
            metadataResult.changed || evictedStoreIds.length > 0,
            reason,
            evictedStoreIds,
          );
        }
        contentBySection.set(section.id, content);
        actualBytes += sectionBytes;
      }
    } catch {
      return this.failureResult(
        storeId,
        metadataResult.changed || evictedStoreIds.length > 0,
        'content-read-failed',
        evictedStoreIds,
      );
    }

    for (const section of store.sections) {
      section.content = contentBySection.get(section.id) ?? '';
    }
    state.content = 'resident';
    this.residentBytesByStore.set(storeId, actualBytes);
    this.stats.residentContentBytes += actualBytes;
    this.stats.residentContentSections += requiredSections;
    if (requiredSections > 0) this.stats.residentContentStores += 1;
    this.stats.metadataOnlyStores = Math.max(0, this.stats.metadataOnlyStores - 1);
    this.stats.deferredStores = Math.max(0, this.stats.deferredStores - 1);
    this.markAccessed(storeId);
    this.clearAdmissionFailure();
    return this.result(storeId, true, undefined, evictedStoreIds);
  }
  private currentContentDeficits(
    bytes: number,
    sections: number,
    stores: number,
  ): ContentCapacity {
    return this.contentDeficits(bytes, sections, stores, this.stats);
  }
  private contentDeficits(
    bytes: number,
    sections: number,
    stores: number,
    occupancy: Pick<
      RlmResidencyStats,
      'residentContentBytes' | 'residentContentSections' | 'residentContentStores'
    >,
  ): ContentCapacity {
    return {
      bytes: occupancy.residentContentBytes + bytes > this.policy.maxResidentContentBytes,
      sections: occupancy.residentContentSections + sections > this.policy.maxResidentContentSections,
      stores: occupancy.residentContentStores + stores > this.policy.maxResidentContentStores,
    };
  }
  private contentEvictionCandidates(requestedStoreId: string): string[] {
    const protectedStoreIds = this.activeSessionStoreIds();
    return Array.from(this.states.entries())
      .filter(([storeId, state]) => (
        storeId !== requestedStoreId
        && ownsResidentContentStoreSlot(state)
        && !protectedStoreIds.has(storeId)
      ))
      .sort(([leftId], [rightId]) => {
        const recencyDelta = (this.lastUsedAt.get(leftId) ?? 0)
          - (this.lastUsedAt.get(rightId) ?? 0);
        return recencyDelta || leftId.localeCompare(rightId);
      })
      .map(([storeId]) => storeId);
  }
  private hasProtectedResidentStore(requestedStoreId: string): boolean {
    const protectedStoreIds = this.activeSessionStoreIds();
    return Array.from(this.states.entries()).some(([storeId, state]) => (
      storeId !== requestedStoreId
      && ownsResidentContentStoreSlot(state)
      && protectedStoreIds.has(storeId)
    ));
  }
  private activeSessionStoreIds(): Set<string> {
    return new Set(Array.from(this.sessions.values(), (session) => session.storeId));
  }
  private evictContent(storeId: string): void {
    const state = this.states.get(storeId);
    const store = this.stores.get(storeId);
    if (!state || !store || state.content !== 'resident') return;
    for (const section of store.sections) section.content = '';
    store.bloomFilter = undefined;
    const ownedStoreSlot = ownsResidentContentStoreSlot(state);
    state.content = 'deferred';
    this.stats.residentContentBytes = Math.max(
      0,
      this.stats.residentContentBytes - (this.residentBytesByStore.get(storeId) ?? 0),
    );
    this.stats.residentContentSections = Math.max(
      0,
      this.stats.residentContentSections - store.sections.length,
    );
    if (ownedStoreSlot) {
      this.stats.residentContentStores = Math.max(0, this.stats.residentContentStores - 1);
    }
    this.stats.metadataOnlyStores += 1;
    this.stats.deferredStores += 1;
    this.residentBytesByStore.delete(storeId);
  }
  private markContentExhausted(deficits: ContentCapacity): void {
    if (deficits.bytes) this.stats.exhausted.contentBytes = true;
    if (deficits.sections) this.stats.exhausted.contentSections = true;
    if (deficits.stores) this.stats.exhausted.contentStores = true;
  }
  private result(
    storeId: string,
    changed: boolean,
    reason?: RlmHydrationFailureReason,
    evictedStoreIds: readonly string[] = [],
  ): RlmHydrationResult {
    const state = this.getHydrationState(storeId);
    return {
      storeId,
      changed,
      ...(state ? { state } : {}),
      ...(reason ? { reason } : {}),
      evictedStoreIds: Object.freeze([...evictedStoreIds]),
    };
  }
  private failureResult(
    storeId: string,
    changed: boolean,
    reason: RlmHydrationFailureReason,
    evictedStoreIds: readonly string[] = [],
  ): RlmHydrationResult {
    this.stats.lastAdmissionFailure = { reason };
    return this.result(storeId, changed, reason, evictedStoreIds);
  }
  private clearAdmissionFailure(): void {
    delete this.stats.lastAdmissionFailure;
  }
}

function rowToSectionMetadata(row: ContextSectionMetadataRow): ContextSection {
  const summarizes = parseSummarizes(row.summarizes_json);
  return {
    id: row.id,
    type: row.type as ContextSection['type'],
    name: row.name,
    content: '',
    tokens: row.tokens,
    startOffset: row.start_offset,
    endOffset: row.end_offset,
    checksum: row.checksum ?? '',
    depth: row.depth,
    ...(summarizes ? { summarizes } : {}),
    ...(row.parent_summary_id ? { parentSummaryId: row.parent_summary_id } : {}),
    ...(row.file_path ? { filePath: row.file_path } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
  };
}

function parseSummarizes(json: string | null): string[] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function hasDeficit(capacity: ContentCapacity): boolean {
  return capacity.bytes || capacity.sections || capacity.stores;
}

function firstContentFailureReason(capacity: ContentCapacity): RlmHydrationFailureReason {
  if (capacity.bytes) return 'content-byte-budget-exhausted';
  if (capacity.sections) return 'content-section-budget-exhausted';
  return 'content-store-budget-exhausted';
}

function contentBytes(sections: readonly ContextSection[]): number {
  return sections.reduce(
    (total, section) => total + Buffer.byteLength(section.content, 'utf8'),
    0,
  );
}

function ownsResidentContentStoreSlot(state: RlmStoreHydrationState): boolean {
  return state.content === 'resident' && state.sectionCount > 0;
}

function createReadonlyMapView<Key, Value>(source: ReadonlyMap<Key, Value>): ReadonlyMap<Key, Value> {
  const view: ReadonlyMap<Key, Value> = new Proxy(source, {
    get(target, property) {
      if (property === 'set' || property === 'delete' || property === 'clear') {
        return () => {
          throw new TypeError('Cannot mutate a readonly hydration-state map');
        };
      }
      if (property === 'forEach') {
        return (
          callbackfn: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void,
          thisArg?: unknown,
        ) => {
          target.forEach((value, key) => callbackfn.call(thisArg, value, key, view));
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return Object.freeze(view);
}
