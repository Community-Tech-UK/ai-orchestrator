/**
 * ResourceGovernor - Listens to MemoryMonitor events and takes automated
 * actions to keep the process within safe memory bounds.
 *
 * Actions:
 *  - warning  → request GC
 *  - critical → reclaim the longest-idle instances (hibernate, or terminate
 *               when there is no conversation to preserve)
 *
 * Reclamation policy exists because `idle` is a weak signal: it means "alive
 * and waiting for the next user message", which describes every healthy
 * session the user is not currently watching. Reclaiming on that signal alone
 * destroys the user's working set. So a candidate must additionally be:
 *   - idle for at least `idleThresholdMs` (never the session just typed into), and
 *   - within the `maxReclaimsPerCriticalEpisode` oldest candidates.
 * Instances holding a conversation are hibernated rather than terminated, so
 * they stay in the session list and can be woken with their work intact.
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
  /** Automatically reclaim idle instances at critical pressure (default: true) */
  terminateIdleAtCritical: boolean;
  /**
   * Minimum continuous idle time before an instance may be reclaimed under
   * memory pressure (default: 5 minutes). Guards the user's live session:
   * anything more recent than this is never a candidate.
   */
  idleThresholdMs: number;
  /** Request GC when memory warning fires (default: true) */
  gcOnWarning: boolean;
  /** Hard cap on total running instances (default: 50) */
  maxTotalInstances: number;
  /**
   * Maximum instances reclaimed per critical episode (default: 3). Reclaiming
   * frees memory asynchronously — the child process has to exit and the heap
   * has to be collected — so a single sweep cannot measure its own effect.
   * Reclaiming a bounded number and re-evaluating on the next sample beats
   * emptying the whole session list on one reading.
   */
  maxReclaimsPerCriticalEpisode: number;
}

const DEFAULT_CONFIG: ResourceGovernorConfig = {
  maxInstanceMemoryMB: 512,
  creationPausedAtPressure: 'critical',
  terminateIdleAtCritical: true,
  idleThresholdMs: 5 * 60 * 1000,
  gcOnWarning: true,
  maxTotalInstances: 50,
  maxReclaimsPerCriticalEpisode: 3,
};

/** User-facing notices left in the transcript so a reclaim is never silent. */
const HIBERNATE_NOTICE =
  'This session was hibernated automatically to free memory after it had been '
  + 'idle for a while. Nothing was lost — send a message to wake it and continue.';
const TERMINATE_NOTICE =
  'This session was closed automatically to free memory after it had been idle '
  + 'for a while with no conversation to preserve.';

/** Subset of MemoryMonitor used by the governor (allows injection in tests) */
interface MemoryMonitorLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  requestGC(): boolean;
  getPressureLevel(): MemoryPressureLevel;
}

/** An idle instance the governor may reclaim. */
interface IdleInstanceLike {
  id: string;
  lastActivity: number;
  displayName?: string;
  hasConversation?: boolean;
}

/** Subset of InstanceManager used by the governor (allows injection in tests) */
interface InstanceManagerLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  getInstanceCount(): number;
  getIdleInstances(thresholdMs: number): IdleInstanceLike[];
  terminateInstance(id: string, graceful?: boolean): Promise<void>;
  hibernateInstance?(id: string): Promise<void>;
  emitSystemMessage?(id: string, content: string, metadata?: Record<string, unknown>): void;
}

export interface GovernorDependencies {
  getMemoryMonitor(): MemoryMonitorLike;
  getInstanceManager(): InstanceManagerLike;
  getLogger(subsystem: string): {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, err?: Error, data?: Record<string, unknown>): void;
  };
  /**
   * Where to write an opt-in heap snapshot at critical pressure. Injected
   * rather than resolved here so this module stays free of an `electron`
   * import (worker/test contexts cannot load it).
   */
  getDiagnosticsDir?(): string;
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
  private heapSnapshotCaptured = false;

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
    this.logger.error('Memory critical — reclaiming idle instances', undefined, { heapUsedMB: stats.heapUsedMB });

    // Pressure events fire only on level *change*, so a normal→critical or
    // warning→critical transition never runs handleWarning. Collect here too,
    // otherwise the cheapest remedy is skipped exactly when it matters most.
    if (this.config.gcOnWarning) {
      this.deps.getMemoryMonitor().requestGC();
    }

    this.maybeCaptureHeapSnapshot();

    if (this.config.terminateIdleAtCritical) {
      try {
        const instanceManager = this.deps.getInstanceManager();
        const candidates = this.selectReclaimCandidates(instanceManager);

        if (candidates.length === 0) {
          // Deliberate no-op: every live session is in active use. Riding out
          // high memory for another sample beats destroying the user's work,
          // and the GC request above is the remedy that actually applies here.
          this.logger.warn('Memory critical but no instance is idle enough to reclaim', {
            idleThresholdMs: this.config.idleThresholdMs,
          });
        } else {
          for (const inst of candidates) {
            void this.reclaimInstance(instanceManager, inst);
          }
          this.emit('instances:terminated', { count: candidates.length, reason: 'memory-critical' });
        }
      } catch {
        // InstanceManager may not be wired yet
      }
    }

    this.emit('memory:critical-recovery', { stats });
  }

  /**
   * Write a heap snapshot at critical pressure — the exact moment worth
   * capturing — when `HARNESS_HEAP_SNAPSHOT_ON_CRITICAL=1`.
   *
   * Opt-in and once per process: the write pauses the isolate for seconds at a
   * multi-GB heap and produces a file about the size of the heap, so it must
   * never fire unattended or repeatedly.
   */
  private maybeCaptureHeapSnapshot(): void {
    if (this.heapSnapshotCaptured) return;
    if (process.env['HARNESS_HEAP_SNAPSHOT_ON_CRITICAL'] !== '1') return;
    if (!this.deps.getDiagnosticsDir) return;

    this.heapSnapshotCaptured = true;
    try {
      // Required lazily so the diagnostic never loads on the common path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { writeHeapSnapshot } = require('../diagnostics/heap-snapshot') as typeof import('../diagnostics/heap-snapshot');
      const result = writeHeapSnapshot(this.deps.getDiagnosticsDir());
      this.logger.warn('Captured heap snapshot at critical memory', {
        filePath: result.filePath,
        durationMs: result.durationMs,
      });
    } catch (err: unknown) {
      this.logger.error(
        'Failed to capture heap snapshot',
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Longest-idle instances eligible for reclamation, capped per episode.
   * InstanceManager already returns oldest-first, but the sort is repeated here
   * so the cap stays correct against any other implementation of the interface.
   */
  private selectReclaimCandidates(instanceManager: InstanceManagerLike): IdleInstanceLike[] {
    const threshold = Math.max(0, this.config.idleThresholdMs);
    const cap = Math.max(0, this.config.maxReclaimsPerCriticalEpisode);

    return instanceManager
      .getIdleInstances(threshold)
      .slice()
      .sort((a, b) => a.lastActivity - b.lastActivity)
      .slice(0, cap);
  }

  /**
   * Reclaim one instance, preferring hibernation so the session survives.
   * The transcript notice is emitted first so it is persisted by the
   * hibernate/terminate path and the user can see what happened and why.
   */
  private async reclaimInstance(
    instanceManager: InstanceManagerLike,
    inst: IdleInstanceLike,
  ): Promise<void> {
    const canHibernate = inst.hasConversation === true
      && typeof instanceManager.hibernateInstance === 'function';
    const idleMs = Math.max(0, Date.now() - inst.lastActivity);

    try {
      instanceManager.emitSystemMessage?.(
        inst.id,
        canHibernate ? HIBERNATE_NOTICE : TERMINATE_NOTICE,
        { reason: 'memory-critical', idleMs },
      );
    } catch {
      // A missing transcript must never block the reclaim itself.
    }

    this.logger.warn(
      canHibernate
        ? 'Hibernating idle instance due to memory pressure'
        : 'Terminating idle instance due to memory pressure',
      { instanceId: inst.id, displayName: inst.displayName, idleMs },
    );

    try {
      if (canHibernate) {
        await instanceManager.hibernateInstance!(inst.id);
      } else {
        await instanceManager.terminateInstance(inst.id, true);
      }
    } catch (err: unknown) {
      // Do not escalate a failed hibernate into a terminate — that would
      // destroy the work hibernation was chosen to protect.
      this.logger.error(
        canHibernate ? 'Failed to hibernate idle instance' : 'Failed to terminate idle instance',
        err instanceof Error ? err : undefined,
        { instanceId: inst.id },
      );
    }
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
