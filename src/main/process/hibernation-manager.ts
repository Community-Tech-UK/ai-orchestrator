import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('HibernationManager');

const HYSTERESIS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_RESUME_HIBERNATION_GRACE_MS = 60_000;

/**
 * Default context staleness threshold.
 * If an instance has been hibernated for longer than this, its context
 * is considered "stale" and should be cleared rather than resumed.
 * Configurable via HibernationConfig.contextStalenessThresholdMs.
 * Inspired by Claude Code 2.1.84 idle-return detection that nudges toward /clear.
 */
const DEFAULT_CONTEXT_STALENESS_THRESHOLD_MS = 75 * 60 * 1000; // 75 minutes

export interface HibernationConfig {
  idleThresholdMs: number;          // How long idle before hibernation (default: 30min)
  enableAutoHibernation: boolean;   // Auto-hibernate idle instances
  checkIntervalMs: number;          // How often to check for idle instances
  maxHibernated: number;            // Max hibernated instances to keep
  memoryPressureTrigger: boolean;   // Also hibernate on memory pressure
  /** How long before hibernated context is considered stale (default: 75min) */
  contextStalenessThresholdMs: number;
}

const DEFAULT_CONFIG: HibernationConfig = {
  idleThresholdMs: 30 * 60 * 1000,   // 30 minutes
  enableAutoHibernation: true,
  checkIntervalMs: 60 * 1000,         // 1 minute
  maxHibernated: 20,
  memoryPressureTrigger: true,
  contextStalenessThresholdMs: DEFAULT_CONTEXT_STALENESS_THRESHOLD_MS,
};

export interface HibernatedInstance {
  instanceId: string;
  displayName: string;
  agentId: string;
  sessionState: Record<string, unknown>;
  hibernatedAt: number;
  workingDirectory?: string;
  contextUsage?: { used: number; total: number };
}

export interface HibernationCandidate {
  id: string;
  status: string;
  lastActivity: number;
}

export interface EvictionCandidate extends HibernationCandidate {
  transcriptSize: number;
  restartCost: number;
}

export interface ScoredEvictionCandidate extends EvictionCandidate {
  score: number;
}

export class HibernationManager extends EventEmitter {
  private config: HibernationConfig;
  private hibernated = new Map<string, HibernatedInstance>();
  private recentWakes = new Map<string, number>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private resumeDeferredUntil = 0;

  private static instance: HibernationManager;

  static getInstance(): HibernationManager {
    if (!this.instance) {
      this.instance = new HibernationManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stop();
    }
    (this.instance as unknown) = undefined;
  }

  constructor(config?: Partial<HibernationConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.config.enableAutoHibernation && !this.checkTimer) {
      this.checkTimer = setInterval(() => {
        if (Date.now() < this.resumeDeferredUntil) {
          return;
        }
        this.emit('check-idle');
      }, this.config.checkIntervalMs);
      logger.info('Hibernation manager started', { config: this.config as unknown as Record<string, unknown> });
    }
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  getConfig(): HibernationConfig {
    return { ...this.config };
  }

  configure(updates: Partial<HibernationConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('config:updated', this.config);
  }

  markHibernated(instanceId: string, state: HibernatedInstance): void {
    this.hibernated.set(instanceId, state);
    this.emit('instance:hibernated', state);
    logger.info('Instance hibernated', { instanceId, displayName: state.displayName });

    // Evict oldest if over limit
    if (this.hibernated.size > this.config.maxHibernated) {
      const oldest = [...this.hibernated.entries()]
        .sort((a, b) => a[1].hibernatedAt - b[1].hibernatedAt)[0];
      if (oldest) {
        this.hibernated.delete(oldest[0]);
        this.emit('instance:evicted', { instanceId: oldest[0] });
      }
    }
  }

  markAwoken(instanceId: string): void {
    const state = this.hibernated.get(instanceId);
    if (state) {
      const now = Date.now();
      const hibernationDurationMs = now - state.hibernatedAt;
      const isContextStale = hibernationDurationMs >= this.config.contextStalenessThresholdMs;

      this.hibernated.delete(instanceId);
      this.recentWakes.set(instanceId, now);
      this.emit('instance:awoken', {
        instanceId,
        state,
        isContextStale,
        hibernationDurationMs,
      });

      if (isContextStale) {
        logger.info('Instance awoken with stale context — recommend clearing', {
          instanceId,
          hibernationDurationMs,
          thresholdMs: this.config.contextStalenessThresholdMs,
        });
        this.emit('instance:stale-context', {
          instanceId,
          hibernationDurationMs,
        });
      } else {
        logger.info('Instance awoken', { instanceId, hibernationDurationMs });
      }
    }
  }

  isHibernated(instanceId: string): boolean {
    return this.hibernated.has(instanceId);
  }

  getHibernatedState(instanceId: string): HibernatedInstance | undefined {
    return this.hibernated.get(instanceId);
  }

  getHibernatedInstances(): HibernatedInstance[] {
    return [...this.hibernated.values()];
  }

  private isInCooldown(instanceId: string, now: number): boolean {
    const wakeTime = this.recentWakes.get(instanceId);
    if (wakeTime === undefined) {
      return false;
    }
    if (now - wakeTime > HYSTERESIS_COOLDOWN_MS) {
      // Expired — clean up
      this.recentWakes.delete(instanceId);
      return false;
    }
    return true;
  }

  getHibernationCandidates(
    instances: HibernationCandidate[],
    now = Date.now()
  ): HibernationCandidate[] {
    if (now < this.resumeDeferredUntil) {
      return [];
    }

    return instances.filter(inst =>
      inst.status === 'idle' &&
      (now - inst.lastActivity) > this.config.idleThresholdMs &&
      !this.hibernated.has(inst.id) &&
      !this.isInCooldown(inst.id, now)
    ).sort((a, b) => a.lastActivity - b.lastActivity);
  }

  scoreEvictionCandidates(
    candidates: EvictionCandidate[],
    now = Date.now()
  ): ScoredEvictionCandidate[] {
    if (candidates.length === 0) {
      return [];
    }

    const maxIdle = Math.max(...candidates.map(c => now - c.lastActivity));
    const maxTranscript = Math.max(...candidates.map(c => c.transcriptSize));
    const maxCost = Math.max(...candidates.map(c => c.restartCost));

    return candidates
      .map(c => {
        const idleNorm = maxIdle > 0 ? (now - c.lastActivity) / maxIdle : 0;
        const transcriptNorm = maxTranscript > 0 ? c.transcriptSize / maxTranscript : 0;
        const costNorm = maxCost > 0 ? c.restartCost / maxCost : 0;
        const score = (idleNorm * 0.5) + (transcriptNorm * 0.3) + (costNorm * 0.2);
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);
  }

  getStats(): { hibernatedCount: number; maxHibernated: number; autoEnabled: boolean } {
    return {
      hibernatedCount: this.hibernated.size,
      maxHibernated: this.config.maxHibernated,
      autoEnabled: this.config.enableAutoHibernation,
    };
  }

  handleSystemSuspend(): void {
    logger.info('Hibernation checks noted system suspend');
  }

  handleSystemResume(graceMs = DEFAULT_RESUME_HIBERNATION_GRACE_MS): void {
    const normalizedGraceMs = Math.max(0, graceMs);
    this.resumeDeferredUntil = Date.now() + normalizedGraceMs;

    logger.info('Hibernation checks deferred after system resume', {
      graceMs: normalizedGraceMs,
      deferredUntil: this.resumeDeferredUntil,
    });
  }
}

export function getHibernationManager(): HibernationManager {
  return HibernationManager.getInstance();
}
