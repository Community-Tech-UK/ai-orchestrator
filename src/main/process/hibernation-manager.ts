import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('HibernationManager');

export interface HibernationConfig {
  idleThresholdMs: number;          // How long idle before hibernation (default: 10min)
  enableAutoHibernation: boolean;   // Auto-hibernate idle instances
  checkIntervalMs: number;          // How often to check for idle instances
  maxHibernated: number;            // Max hibernated instances to keep
  memoryPressureTrigger: boolean;   // Also hibernate on memory pressure
}

const DEFAULT_CONFIG: HibernationConfig = {
  idleThresholdMs: 10 * 60 * 1000,   // 10 minutes
  // Keep auto-hibernation off until the lifecycle is wired to persist and restore
  // sessions instead of terminating them outright.
  enableAutoHibernation: false,
  checkIntervalMs: 60 * 1000,         // 1 minute
  maxHibernated: 20,
  memoryPressureTrigger: true,
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

export class HibernationManager extends EventEmitter {
  private config: HibernationConfig;
  private hibernated = new Map<string, HibernatedInstance>();
  private checkTimer: ReturnType<typeof setInterval> | null = null;

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
      this.checkTimer = setInterval(() => this.emit('check-idle'), this.config.checkIntervalMs);
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
      this.hibernated.delete(instanceId);
      this.emit('instance:awoken', { instanceId, state });
      logger.info('Instance awoken', { instanceId });
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

  getHibernationCandidates(
    instances: HibernationCandidate[],
    now = Date.now()
  ): HibernationCandidate[] {
    return instances.filter(inst =>
      inst.status === 'idle' &&
      (now - inst.lastActivity) > this.config.idleThresholdMs &&
      !this.hibernated.has(inst.id)
    ).sort((a, b) => a.lastActivity - b.lastActivity);
  }

  getStats(): { hibernatedCount: number; maxHibernated: number; autoEnabled: boolean } {
    return {
      hibernatedCount: this.hibernated.size,
      maxHibernated: this.config.maxHibernated,
      autoEnabled: this.config.enableAutoHibernation,
    };
  }
}

export function getHibernationManager(): HibernationManager {
  return HibernationManager.getInstance();
}
