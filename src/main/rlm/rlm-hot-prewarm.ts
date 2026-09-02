import type { ContextStore, RLMSession } from '../../shared/types/rlm.types';
import {
  getRlmProcessRole,
  selectHotStoreCandidates,
  type RlmResidencyPolicy,
} from './context-persistence-loader';
import type {
  RlmHydrationFailureReason,
  RlmHydrationResult,
  RlmResidencyStats,
} from './context-residency-controller';
import { getLogger } from '../logging/logger';

const logger = getLogger('RlmHotPrewarm');

export interface RlmHotPrewarmStats {
  running: boolean;
  candidates: number;
  admitted: number;
  skipped: number;
  exhausted: number;
  cancelled: number;
}

interface MutableHotCounters {
  hotCandidates: number;
  hotAdmitted: number;
  hotSkipped: number;
  hotExhausted: number;
  hotCancelled: number;
}

interface RlmHotPrewarmOptions {
  stores: Map<string, ContextStore>;
  sessions: Map<string, RLMSession>;
  policy: RlmResidencyPolicy;
  counters: MutableHotCounters;
  now: () => number;
  hydrateContent: (storeId: string) => RlmHydrationResult;
  getResidencyStats: () => Readonly<RlmResidencyStats>;
  onSummary?: () => void;
}

const schedulers = new WeakMap<object, RlmHotPrewarmer>();

export function startRlmHotPrewarm(owner: object, options: RlmHotPrewarmOptions): boolean {
  let scheduler = schedulers.get(owner);
  if (!scheduler) {
    scheduler = new RlmHotPrewarmer(options);
    schedulers.set(owner, scheduler);
  }
  return scheduler.start();
}

export function cancelRlmHotPrewarm(owner: object): boolean {
  return schedulers.get(owner)?.cancel() ?? false;
}

export function getRlmHotPrewarmStats(owner: object): Readonly<RlmHotPrewarmStats> {
  return schedulers.get(owner)?.getStats() ?? Object.freeze({
    running: false,
    candidates: 0,
    admitted: 0,
    skipped: 0,
    exhausted: 0,
    cancelled: 0,
  });
}

class RlmHotPrewarmer {
  private candidates: ContextStore[] = [];
  private nextCandidate = 0;
  private scheduled: NodeJS.Immediate | null = null;
  private stats: RlmHotPrewarmStats = emptyStats();
  private generation = 0;
  private startedAt = 0;
  private terminalGeneration = 0;

  constructor(private readonly options: RlmHotPrewarmOptions) {}

  start(): boolean {
    if (this.stats.running) return false;

    const capturedNow = this.options.now();
    const generation = ++this.generation;
    this.startedAt = performance.now();
    const activeActivity = activeSessionStoreActivity(this.options.sessions);
    const candidateRows = [...this.options.stores.values()].map((store) => ({
      store,
      id: store.id,
      created_at: store.createdAt,
      last_accessed: store.lastAccessed,
    }));
    this.candidates = selectHotStoreCandidates(
      candidateRows,
      activeActivity,
      capturedNow,
      this.options.policy,
    ).map((candidate) => candidate.store);
    this.nextCandidate = 0;
    this.stats = {
      ...emptyStats(),
      running: this.candidates.length > 0,
      candidates: this.candidates.length,
    };
    this.options.counters.hotCandidates = this.candidates.length;
    this.options.counters.hotAdmitted = 0;
    this.options.counters.hotSkipped = 0;
    this.options.counters.hotExhausted = 0;
    this.options.counters.hotCancelled = 0;
    this.logSummary('started');
    this.options.onSummary?.();
    if (this.stats.running) this.scheduleNext(generation);
    else this.finish(generation);
    return true;
  }

  cancel(): boolean {
    if (!this.stats.running) return false;
    this.stats.running = false;
    if (this.scheduled) clearImmediate(this.scheduled);
    this.scheduled = null;
    const cancelled = this.candidates.length - this.nextCandidate;
    this.stats.cancelled += cancelled;
    this.options.counters.hotCancelled += cancelled;
    this.finish(this.generation, 'cancelled');
    return true;
  }

  getStats(): Readonly<RlmHotPrewarmStats> {
    return Object.freeze({ ...this.stats });
  }

  private scheduleNext(generation: number): void {
    this.scheduled = setImmediate(() => this.runOneStore(generation));
  }

  private runOneStore(generation: number): void {
    this.scheduled = null;
    if (!this.stats.running || generation !== this.generation) return;
    if (this.nextCandidate >= this.candidates.length) return this.finish(generation);
    if (anyCeilingFull(this.options.getResidencyStats(), this.options.policy)) {
      return this.exhaustRemaining();
    }

    const candidate = this.candidates[this.nextCandidate++];
    const result = this.options.hydrateContent(candidate.id);
    if (result.state?.content === 'resident' && result.changed) {
      this.stats.admitted += 1;
      this.options.counters.hotAdmitted += 1;
    } else if (isExhaustion(result.reason)) {
      return this.exhaustRemaining(true);
    } else {
      this.stats.skipped += 1;
      this.options.counters.hotSkipped += 1;
    }

    if (this.nextCandidate >= this.candidates.length) return this.finish(generation);
    if (anyCeilingFull(this.options.getResidencyStats(), this.options.policy)) {
      return this.exhaustRemaining();
    }
    this.scheduleNext(generation);
  }

  private exhaustRemaining(includeCurrent = false): void {
    const exhausted = this.candidates.length - this.nextCandidate + (includeCurrent ? 1 : 0);
    this.stats.exhausted += exhausted;
    this.options.counters.hotExhausted += exhausted;
    this.finish(this.generation);
  }

  private finish(generation: number, phase: 'completed' | 'cancelled' = 'completed'): void {
    if (generation !== this.generation || this.terminalGeneration === generation) return;
    this.terminalGeneration = generation;
    this.stats.running = false;
    this.scheduled = null;
    this.logSummary(phase);
    this.options.onSummary?.();
  }

  private logSummary(phase: 'started' | 'completed' | 'cancelled'): void {
    const residency = this.options.getResidencyStats();
    logger.info('RLM hot prewarm summary', {
      processRole: getRlmProcessRole(),
      phase,
      candidates: this.stats.candidates,
      admitted: this.stats.admitted,
      skipped: this.stats.skipped,
      exhausted: this.stats.exhausted,
      cancelled: this.stats.cancelled,
      residentMetadataSections: residency.residentMetadataSections,
      residentContentBytes: residency.residentContentBytes,
      residentContentSections: residency.residentContentSections,
      residentContentStores: residency.residentContentStores,
      elapsedMs: Math.max(0, performance.now() - this.startedAt),
    });
  }
}

function emptyStats(): RlmHotPrewarmStats {
  return {
    running: false,
    candidates: 0,
    admitted: 0,
    skipped: 0,
    exhausted: 0,
    cancelled: 0,
  };
}

function activeSessionStoreActivity(sessions: ReadonlyMap<string, RLMSession>): Map<string, number> {
  const activity = new Map<string, number>();
  for (const session of sessions.values()) {
    activity.set(
      session.storeId,
      Math.max(activity.get(session.storeId) ?? 0, session.lastActivityAt),
    );
  }
  return activity;
}

function anyCeilingFull(
  stats: Readonly<RlmResidencyStats>,
  policy: RlmResidencyPolicy,
): boolean {
  return stats.residentMetadataSections >= policy.maxResidentSectionMetadata
    || stats.residentContentBytes >= policy.maxResidentContentBytes
    || stats.residentContentSections >= policy.maxResidentContentSections
    || stats.residentContentStores >= policy.maxResidentContentStores
    || Object.values(stats.exhausted).some(Boolean);
}

function isExhaustion(reason: RlmHydrationFailureReason | undefined): boolean {
  return reason === 'metadata-budget-exhausted'
    || reason === 'content-byte-budget-exhausted'
    || reason === 'content-section-budget-exhausted'
    || reason === 'content-store-budget-exhausted'
    || reason === 'protected-content-prevents-admission'
    || reason === 'actual-content-exceeds-byte-budget';
}
