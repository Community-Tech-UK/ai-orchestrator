import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('PoolManager');
const DEFAULT_RESUME_POOL_GRACE_MS = 60_000;

export interface PoolConfig {
  minPoolSize: number;        // Minimum warm instances (default: 0)
  maxPoolSize: number;        // Maximum pool size (default: 5)
  warmupIntervalMs: number;   // How often to check pool level (default: 30s)
  maxIdleTimeMs: number;      // Max time in pool before eviction (default: 5min)
  enableAutoWarm: boolean;    // Auto-warm to minPoolSize (default: false)
}

const DEFAULT_CONFIG: PoolConfig = {
  minPoolSize: 0,
  maxPoolSize: 5,
  warmupIntervalMs: 30 * 1000,
  maxIdleTimeMs: 5 * 60 * 1000,
  enableAutoWarm: false,
};

interface PooledInstance {
  instanceId: string;
  provider: string;
  workingDirectory: string;
  pooledAt: number;
}

export interface AcquireOptions {
  provider?: string;
  workingDirectory?: string;
}

export class PoolManager extends EventEmitter {
  private config: PoolConfig;
  private pool: PooledInstance[] = [];
  private warmupTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceDeferredUntil = 0;

  private static instance: PoolManager;

  static getInstance(): PoolManager {
    if (!this.instance) {
      this.instance = new PoolManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stop();
    }
    (this.instance as unknown) = undefined;
  }

  constructor(config?: Partial<PoolConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    registerCleanup(() => { this.stop(); });
  }

  start(): void {
    if (this.config.enableAutoWarm && !this.warmupTimer) {
      this.warmupTimer = setInterval(() => {
        if (Date.now() < this.maintenanceDeferredUntil) {
          return;
        }
        this.checkPoolLevel();
      }, this.config.warmupIntervalMs);
      logger.info('Pool manager started', { config: this.config as unknown as Record<string, unknown> });
    }
  }

  stop(): void {
    if (this.warmupTimer) {
      clearInterval(this.warmupTimer);
      this.warmupTimer = null;
    }
  }

  getConfig(): PoolConfig {
    return { ...this.config };
  }

  configure(updates: Partial<PoolConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('config:updated', this.config);
  }

  addToPool(instanceId: string, meta: { provider: string; workingDirectory: string }): boolean {
    if (this.pool.length >= this.config.maxPoolSize) {
      logger.warn('Pool full, cannot add instance', { instanceId, poolSize: this.pool.length });
      return false;
    }
    this.pool.push({
      instanceId,
      provider: meta.provider,
      workingDirectory: meta.workingDirectory,
      pooledAt: Date.now(),
    });
    this.emit('instance:pooled', { instanceId });
    logger.info('Instance added to pool', { instanceId, poolSize: this.pool.length });
    return true;
  }

  acquire(options: AcquireOptions = {}): string | null {
    // Evict stale instances first
    this.evictStale();

    const idx = this.pool.findIndex(p => {
      if (options.provider && p.provider !== options.provider) return false;
      if (options.workingDirectory && p.workingDirectory !== options.workingDirectory) return false;
      return true;
    });

    if (idx === -1) return null;

    const [acquired] = this.pool.splice(idx, 1);
    this.emit('instance:acquired', { instanceId: acquired.instanceId });
    logger.info('Instance acquired from pool', { instanceId: acquired.instanceId, poolSize: this.pool.length });
    return acquired.instanceId;
  }

  getPoolSize(): number {
    return this.pool.length;
  }

  getAvailable(): number {
    return this.pool.length;
  }

  getStats(): { poolSize: number; maxPoolSize: number; minPoolSize: number } {
    return {
      poolSize: this.pool.length,
      maxPoolSize: this.config.maxPoolSize,
      minPoolSize: this.config.minPoolSize,
    };
  }

  handleSystemSuspend(): void {
    logger.info('Pool maintenance noted system suspend', {
      poolSize: this.pool.length,
    });
  }

  handleSystemResume(graceMs = DEFAULT_RESUME_POOL_GRACE_MS): void {
    const normalizedGraceMs = Math.max(0, graceMs);
    this.maintenanceDeferredUntil = Date.now() + normalizedGraceMs;

    logger.info('Pool maintenance deferred after system resume', {
      graceMs: normalizedGraceMs,
      deferredUntil: this.maintenanceDeferredUntil,
      poolSize: this.pool.length,
    });
  }

  private evictStale(): void {
    const now = Date.now();
    const before = this.pool.length;
    this.pool = this.pool.filter(p => {
      if ((now - p.pooledAt) > this.config.maxIdleTimeMs) {
        this.emit('instance:evicted', { instanceId: p.instanceId, reason: 'stale' });
        return false;
      }
      return true;
    });
    if (this.pool.length < before) {
      logger.info('Evicted stale pool instances', { evicted: before - this.pool.length });
    }
  }

  private checkPoolLevel(): void {
    this.evictStale();
    const deficit = this.config.minPoolSize - this.pool.length;
    if (deficit > 0) {
      this.emit('pool:needs-warm', { count: deficit });
    }
  }
}

export function getPoolManager(): PoolManager {
  return PoolManager.getInstance();
}
