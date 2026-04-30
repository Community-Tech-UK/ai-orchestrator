/**
 * ResourceGovernor - Listens to MemoryMonitor events and takes automated
 * actions to keep the process within safe memory bounds.
 *
 * Actions:
 *  - warning  → request GC
 *  - critical → terminate idle instances
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getMemoryMonitor } from '../memory/memory-monitor';
import type { MemoryStats, MemoryPressureLevel } from '../memory/memory-monitor';
import { registerCleanup } from '../util/cleanup-registry';

export interface ResourceGovernorConfig {
  /** Per-instance soft memory cap in MB (default: 512) */
  maxInstanceMemoryMB: number;
  /** Legacy setting retained for config compatibility. Memory pressure no longer blocks instance creation. */
  creationPausedAtPressure: MemoryPressureLevel;
  /** Automatically terminate idle instances at critical pressure (default: true) */
  terminateIdleAtCritical: boolean;
  /** Legacy idle threshold retained for config compatibility; critical cleanup terminates all idle instances immediately. */
  idleThresholdMs: number;
  /** Request GC when memory warning fires (default: true) */
  gcOnWarning: boolean;
  /** Hard cap on total running instances (default: 50) */
  maxTotalInstances: number;
}

const DEFAULT_CONFIG: ResourceGovernorConfig = {
  maxInstanceMemoryMB: 512,
  creationPausedAtPressure: 'critical',
  terminateIdleAtCritical: true,
  idleThresholdMs: 5 * 60 * 1000,
  gcOnWarning: true,
  maxTotalInstances: 50,
};

/** Subset of MemoryMonitor used by the governor (allows injection in tests) */
interface MemoryMonitorLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  requestGC(): boolean;
  getPressureLevel(): MemoryPressureLevel;
}

/** Subset of InstanceManager used by the governor (allows injection in tests) */
interface InstanceManagerLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  getInstanceCount(): number;
  getIdleInstances(thresholdMs: number): { id: string; lastActivity: number }[];
  terminateInstance(id: string, graceful?: boolean): Promise<void>;
}

export interface GovernorDependencies {
  getMemoryMonitor(): MemoryMonitorLike;
  getInstanceManager(): InstanceManagerLike;
  getLogger(subsystem: string): {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, err?: Error, data?: Record<string, unknown>): void;
  };
}

const defaultDeps: GovernorDependencies = {
  getMemoryMonitor,
  getInstanceManager: () => {
    // Production path always overrides this via start({ getInstanceManager })
    // (see src/main/index.ts). Throwing here ensures any new caller that
    // forgets to inject InstanceManager fails loudly instead of silently
    // touching a global singleton.
    throw new Error(
      'ResourceGovernor.start() requires { getInstanceManager } to be injected. ' +
      'See src/main/index.ts for the canonical wiring.'
    );
  },
  getLogger,
};

export class ResourceGovernor extends EventEmitter {
  private readonly config: ResourceGovernorConfig;
  private deps: GovernorDependencies;
  private readonly logger;
  private creationPaused = false;

  // Bound event handlers kept as instance fields so we can remove them later
  private readonly boundOnWarning = (stats: MemoryStats) => this.handleWarning(stats);
  private readonly boundOnCritical = (stats: MemoryStats) => this.handleCritical(stats);
  private readonly boundOnNormal = () => this.handleNormal();
  private readonly boundOnPressureChange = (level: MemoryPressureLevel) => this.handlePressureChange(level);

  private static instance: ResourceGovernor;

  static getInstance(): ResourceGovernor {
    if (!this.instance) {
      this.instance = new ResourceGovernor();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.stop();
    }
    (this.instance as unknown) = undefined;
  }

  constructor(deps?: Partial<GovernorDependencies>, config?: Partial<ResourceGovernorConfig>) {
    super();
    this.deps = { ...defaultDeps, ...deps };
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = this.deps.getLogger('ResourceGovernor');
    registerCleanup(() => { this.stop(); });
  }

  /**
   * Begin listening to MemoryMonitor events. Call once during app init.
   * Optionally override dependencies (e.g., to inject a concrete InstanceManager).
   */
  start(overrideDeps?: Partial<GovernorDependencies>): void {
    if (overrideDeps) {
      Object.assign(this.deps, overrideDeps);
    }
    const monitor = this.deps.getMemoryMonitor();
    monitor.on('warning', this.boundOnWarning as (...args: unknown[]) => void);
    monitor.on('critical', this.boundOnCritical as (...args: unknown[]) => void);
    monitor.on('normal', this.boundOnNormal as (...args: unknown[]) => void);
    monitor.on('pressure-change', this.boundOnPressureChange as (...args: unknown[]) => void);
    this.logger.info('Resource governor started', { config: this.config });
  }

  /**
   * Stop listening to MemoryMonitor events. Call during app cleanup.
   */
  stop(): void {
    const monitor = this.deps.getMemoryMonitor();
    monitor.off('warning', this.boundOnWarning as (...args: unknown[]) => void);
    monitor.off('critical', this.boundOnCritical as (...args: unknown[]) => void);
    monitor.off('normal', this.boundOnNormal as (...args: unknown[]) => void);
    monitor.off('pressure-change', this.boundOnPressureChange as (...args: unknown[]) => void);
  }

  /**
   * Returns true when it is safe to create a new instance.
   * Memory pressure is intentionally advisory; the only hard creation gate is
   * the explicit instance count cap.
   */
  isCreationAllowed(): boolean {
    return this.getCreationBlockReason() === null;
  }

  /**
   * Returns a stable machine-readable reason when instance creation is blocked.
   * Memory pressure is not a creation block reason; high-memory machines should
   * be allowed to keep working while the governor performs recovery actions.
   */
  getCreationBlockReason(): string | null {
    try {
      const instanceManager = this.deps.getInstanceManager();
      if (
        this.config.maxTotalInstances > 0
        && instanceManager.getInstanceCount() >= this.config.maxTotalInstances
      ) {
        return 'instance-limit';
      }
    } catch {
      // InstanceManager may not be available in all test contexts — fail open
    }

    return null;
  }

  /**
   * Check if creation is allowed on a specific remote node.
   * Checks node's own capacity limit independently from local limits.
   */
  isRemoteCreationAllowed(nodeId: string): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getWorkerNodeRegistry } = require('../remote-node');
      const registry = getWorkerNodeRegistry();
      const node = registry.getNode(nodeId);
      if (!node) return false;
      if (node.status !== 'connected') return false;
      return node.activeInstances < node.capabilities.maxConcurrentInstances;
    } catch {
      // Remote node module may not be initialized — fail closed
      return false;
    }
  }

  getConfig(): ResourceGovernorConfig {
    return { ...this.config };
  }

  configure(updates: Partial<ResourceGovernorConfig>): void {
    Object.assign(this.config, updates);
    this.emit('config:updated', this.getConfig());
  }

  getStats(): { creationPaused: boolean; pressureLevel: MemoryPressureLevel; creationBlockReason: string | null } {
    return {
      creationPaused: this.creationPaused,
      pressureLevel: this.deps.getMemoryMonitor().getPressureLevel(),
      creationBlockReason: this.getCreationBlockReason(),
    };
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  private handleWarning(stats: MemoryStats): void {
    this.logger.warn('Memory warning — requesting garbage collection', { heapUsedMB: stats.heapUsedMB });

    if (this.config.gcOnWarning) {
      this.deps.getMemoryMonitor().requestGC();
    }
  }

  private handleCritical(stats: MemoryStats): void {
    this.logger.error('Memory critical — terminating idle instances', undefined, { heapUsedMB: stats.heapUsedMB });

    if (this.config.terminateIdleAtCritical) {
      try {
        const instanceManager = this.deps.getInstanceManager();
        const idle = instanceManager.getIdleInstances(0);
        for (const inst of idle) {
          this.logger.warn('Terminating idle instance due to memory pressure', { instanceId: inst.id });
          instanceManager.terminateInstance(inst.id, true).catch((err: unknown) => {
            this.logger.error(
              'Failed to terminate idle instance',
              err instanceof Error ? err : undefined,
              { instanceId: inst.id }
            );
          });
        }
        this.emit('instances:terminated', { count: idle.length, reason: 'memory-critical' });
      } catch {
        // InstanceManager may not be wired yet
      }
    }

    this.emit('memory:critical-recovery', { stats });
  }

  private handleNormal(): void {
    if (this.creationPaused) {
      this.logger.info('Memory returned to normal — resuming instance creation');
      this.creationPaused = false;
      this.emit('creation:resumed');
    }
  }

  private handlePressureChange(level: MemoryPressureLevel): void {
    this.emit('pressure:changed', { level });
  }
}

export function getResourceGovernor(): ResourceGovernor {
  return ResourceGovernor.getInstance();
}
