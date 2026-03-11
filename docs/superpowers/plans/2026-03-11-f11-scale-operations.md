# F11: Scale Operations Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resource governance, instance hibernation, instance pooling, and load balancing to the orchestrator's scale infrastructure.

**Architecture:** Four interconnected systems that extend existing infrastructure (MemoryMonitor, SupervisorTree, InstanceManager, TaskManager). All follow the lazy singleton pattern with EventEmitter coordination. Resource governance wires MemoryMonitor events to automated actions. Hibernation serializes idle instances to disk and wakes them on demand. Pooling pre-warms CLI instances for fast creation. Load balancing distributes work based on per-instance metrics.

**Tech Stack:** Electron main process (TypeScript/CommonJS), Node.js EventEmitter, singleton services via `getXxx()` helpers.

---

## Chunk 1: Resource Governance

### Task 1: Create ResourceGovernor Service

**Files:**
- Create: `src/main/process/resource-governor.ts`
- Create: `src/main/process/resource-governor.spec.ts`

The ResourceGovernor listens to MemoryMonitor events and takes automated actions: pausing instance creation at warning, requesting GC, and terminating idle instances at critical.

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResourceGovernor } from './resource-governor';

describe('ResourceGovernor', () => {
  let governor: ResourceGovernor;
  const mockDeps = {
    getMemoryMonitor: () => ({
      on: vi.fn(),
      off: vi.fn(),
      requestGC: vi.fn(() => true),
      getPressureLevel: vi.fn(() => 'normal' as const),
    }),
    getInstanceManager: () => ({
      on: vi.fn(),
      getInstanceCount: vi.fn(() => 3),
      getIdleInstances: vi.fn(() => []),
      terminateInstance: vi.fn(),
    }),
    getLogger: () => ({
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    }),
  };

  beforeEach(() => {
    governor = new ResourceGovernor(mockDeps as any);
  });

  it('should initialize with default config', () => {
    expect(governor.getConfig().maxInstanceMemoryMB).toBe(512);
    expect(governor.getConfig().creationPausedAtPressure).toBe('warning');
  });

  it('should report creation allowed at normal pressure', () => {
    expect(governor.isCreationAllowed()).toBe(true);
  });

  it('should block creation at warning pressure', () => {
    mockDeps.getMemoryMonitor().getPressureLevel.mockReturnValue('warning');
    governor = new ResourceGovernor(mockDeps as any);
    expect(governor.isCreationAllowed()).toBe(false);
  });

  it('should configure via configure()', () => {
    governor.configure({ maxInstanceMemoryMB: 256 });
    expect(governor.getConfig().maxInstanceMemoryMB).toBe(256);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/process/resource-governor.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ResourceGovernor**

```typescript
import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getMemoryMonitor, type MemoryStats, type MemoryPressureLevel } from '../memory/memory-monitor';

const logger = getLogger('ResourceGovernor');

export interface ResourceGovernorConfig {
  maxInstanceMemoryMB: number;         // Per-instance soft cap (default: 512MB)
  creationPausedAtPressure: MemoryPressureLevel; // Pause creation at this level
  terminateIdleAtCritical: boolean;    // Auto-terminate idle at critical
  idleThresholdMs: number;             // How long idle before eligible for termination
  gcOnWarning: boolean;                // Request GC on warning
  maxTotalInstances: number;           // Hard cap on total instances
}

const DEFAULT_CONFIG: ResourceGovernorConfig = {
  maxInstanceMemoryMB: 512,
  creationPausedAtPressure: 'warning',
  terminateIdleAtCritical: true,
  idleThresholdMs: 5 * 60 * 1000,  // 5 minutes idle
  gcOnWarning: true,
  maxTotalInstances: 50,
};

interface GovernorDependencies {
  getInstanceCount(): number;
  getIdleInstances(thresholdMs: number): Array<{ id: string; lastActivity: number }>;
  terminateInstance(id: string, graceful?: boolean): Promise<void>;
}

export class ResourceGovernor extends EventEmitter {
  private config: ResourceGovernorConfig;
  private deps: GovernorDependencies | null = null;
  private creationPaused = false;
  private boundHandlers = {
    onWarning: (stats: MemoryStats) => this.handleWarning(stats),
    onCritical: (stats: MemoryStats) => this.handleCritical(stats),
    onNormal: () => this.handleNormal(),
    onPressureChange: (level: MemoryPressureLevel) => this.handlePressureChange(level),
  };

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
    (this.instance as any) = undefined;
  }

  constructor(config?: Partial<ResourceGovernorConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(deps: GovernorDependencies): void {
    this.deps = deps;
    const monitor = getMemoryMonitor();
    monitor.on('warning', this.boundHandlers.onWarning);
    monitor.on('critical', this.boundHandlers.onCritical);
    monitor.on('normal', this.boundHandlers.onNormal);
    monitor.on('pressure-change', this.boundHandlers.onPressureChange);
    logger.info('Resource governor started', { config: this.config });
  }

  stop(): void {
    const monitor = getMemoryMonitor();
    monitor.off('warning', this.boundHandlers.onWarning);
    monitor.off('critical', this.boundHandlers.onCritical);
    monitor.off('normal', this.boundHandlers.onNormal);
    monitor.off('pressure-change', this.boundHandlers.onPressureChange);
    this.deps = null;
  }

  isCreationAllowed(): boolean {
    if (this.creationPaused) return false;
    const monitor = getMemoryMonitor();
    const level = monitor.getPressureLevel();
    if (level === 'critical') return false;
    if (level === 'warning' && this.config.creationPausedAtPressure === 'warning') return false;
    if (this.deps && this.deps.getInstanceCount() >= this.config.maxTotalInstances) return false;
    return true;
  }

  getConfig(): ResourceGovernorConfig {
    return { ...this.config };
  }

  configure(updates: Partial<ResourceGovernorConfig>): void {
    this.config = { ...this.config, ...updates };
    this.emit('config:updated', this.config);
  }

  getStats(): { creationPaused: boolean; pressureLevel: MemoryPressureLevel } {
    return {
      creationPaused: this.creationPaused,
      pressureLevel: getMemoryMonitor().getPressureLevel(),
    };
  }

  private handleWarning(stats: MemoryStats): void {
    logger.warn('Memory warning — pausing instance creation', { heapUsedMB: stats.heapUsedMB });
    this.creationPaused = true;
    if (this.config.gcOnWarning) {
      getMemoryMonitor().requestGC();
    }
    this.emit('creation:paused', { reason: 'memory-warning', stats });
  }

  private handleCritical(stats: MemoryStats): void {
    logger.error('Memory critical — terminating idle instances', { heapUsedMB: stats.heapUsedMB });
    this.creationPaused = true;
    if (this.config.terminateIdleAtCritical && this.deps) {
      const idle = this.deps.getIdleInstances(this.config.idleThresholdMs);
      for (const instance of idle) {
        logger.warn('Terminating idle instance due to memory pressure', { instanceId: instance.id });
        this.deps.terminateInstance(instance.id, true).catch(err => {
          logger.error('Failed to terminate idle instance', err instanceof Error ? err : undefined);
        });
      }
      this.emit('instances:terminated', { count: idle.length, reason: 'memory-critical' });
    }
    this.emit('creation:paused', { reason: 'memory-critical', stats });
  }

  private handleNormal(): void {
    if (this.creationPaused) {
      logger.info('Memory returned to normal — resuming instance creation');
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
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/process/resource-governor.spec.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/process/resource-governor.ts src/main/process/resource-governor.spec.ts
git commit -m "feat(f11): add ResourceGovernor for memory-triggered instance actions"
```

---

### Task 2: Wire ResourceGovernor Into App Lifecycle

**Files:**
- Modify: `src/main/index.ts` (add init step + wire dependencies)

- [ ] **Step 1: Add import**

```typescript
import { getResourceGovernor } from './process/resource-governor';
```

- [ ] **Step 2: Add init step in initialize()**

After the 'Session continuity' step, add:
```typescript
{ name: 'Resource governor', fn: () => {
  const governor = getResourceGovernor();
  governor.start({
    getInstanceCount: () => this.instanceManager.getInstanceCount(),
    getIdleInstances: (thresholdMs: number) => this.instanceManager.getIdleInstances(thresholdMs),
    terminateInstance: (id: string, graceful?: boolean) => this.instanceManager.terminateInstance(id, graceful),
  });
} },
```

- [ ] **Step 3: Add stop in cleanup()**

Before the `getSessionContinuityManager().shutdown()` call, add:
```typescript
try { getResourceGovernor().stop(); } catch {}
```

- [ ] **Step 4: Gate instance creation with governor check**

In `setupInstanceEventForwarding()`, where instance creation events are handled, or in the IPC handler for `INSTANCE_CREATE`, add a check:
```typescript
if (!getResourceGovernor().isCreationAllowed()) {
  throw new Error('Instance creation paused due to memory pressure');
}
```

Note: This should be added to the instance creation IPC handler in `src/main/ipc/handlers/instance-handlers.ts`, not in index.ts. Find the `INSTANCE_CREATE` handler and add the check before calling `createInstance()`.

- [ ] **Step 5: Verify InstanceManager has getIdleInstances()**

Check if `InstanceManager` already has a `getIdleInstances()` method. If not, add one:
```typescript
getIdleInstances(thresholdMs: number): Array<{ id: string; lastActivity: number }> {
  const now = Date.now();
  const idle: Array<{ id: string; lastActivity: number }> = [];
  for (const instance of this.stateManager.getAllInstances()) {
    if (instance.status === 'idle' && (now - instance.lastActivity) > thresholdMs) {
      idle.push({ id: instance.id, lastActivity: instance.lastActivity });
    }
  }
  // Sort by least recently active first
  return idle.sort((a, b) => a.lastActivity - b.lastActivity);
}
```

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/index.ts src/main/ipc/handlers/instance-handlers.ts src/main/instance/instance-manager.ts
git commit -m "feat(f11): wire ResourceGovernor into app lifecycle"
```

---

## Chunk 2: Instance Hibernation

### Task 3: Create HibernationManager Service

**Files:**
- Create: `src/main/process/hibernation-manager.ts`
- Create: `src/main/process/hibernation-manager.spec.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HibernationManager } from './hibernation-manager';

describe('HibernationManager', () => {
  let manager: HibernationManager;

  beforeEach(() => {
    HibernationManager._resetForTesting();
    manager = HibernationManager.getInstance();
  });

  it('should initialize with default config', () => {
    expect(manager.getConfig().idleThresholdMs).toBe(10 * 60 * 1000);
  });

  it('should track hibernated instances', () => {
    manager.markHibernated('inst-1', {
      instanceId: 'inst-1',
      displayName: 'Test',
      agentId: 'build',
      sessionState: {},
      hibernatedAt: Date.now(),
    });
    expect(manager.isHibernated('inst-1')).toBe(true);
    expect(manager.getHibernatedInstances().length).toBe(1);
  });

  it('should remove hibernated state on wake', () => {
    manager.markHibernated('inst-1', {
      instanceId: 'inst-1',
      displayName: 'Test',
      agentId: 'build',
      sessionState: {},
      hibernatedAt: Date.now(),
    });
    manager.markAwoken('inst-1');
    expect(manager.isHibernated('inst-1')).toBe(false);
  });

  it('should identify idle instances', () => {
    const now = Date.now();
    const instances = [
      { id: 'a', status: 'idle' as const, lastActivity: now - 20 * 60 * 1000 }, // 20min idle
      { id: 'b', status: 'busy' as const, lastActivity: now },                   // active
      { id: 'c', status: 'idle' as const, lastActivity: now - 5 * 60 * 1000 },  // 5min idle
    ];
    const eligible = manager.getHibernationCandidates(instances, now);
    expect(eligible.length).toBe(1); // Only 'a' exceeds default 10min threshold
    expect(eligible[0].id).toBe('a');
  });
});
```

- [ ] **Step 2: Implement HibernationManager**

```typescript
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
  enableAutoHibernation: true,
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
    (this.instance as any) = undefined;
  }

  constructor(config?: Partial<HibernationConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.config.enableAutoHibernation && !this.checkTimer) {
      this.checkTimer = setInterval(() => this.emit('check-idle'), this.config.checkIntervalMs);
      logger.info('Hibernation manager started', { config: this.config });
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
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/main/process/hibernation-manager.spec.ts`
Expected: PASS

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/process/hibernation-manager.ts src/main/process/hibernation-manager.spec.ts
git commit -m "feat(f11): add HibernationManager for idle instance state serialization"
```

---

### Task 4: Wire HibernationManager Into App Lifecycle

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add import and init step**

```typescript
import { getHibernationManager } from './process/hibernation-manager';
```

In initialize() steps:
```typescript
{ name: 'Hibernation manager', fn: () => {
  const hibernation = getHibernationManager();
  hibernation.start();
  hibernation.on('check-idle', () => {
    const instances = this.instanceManager.getAllInstances()
      .filter(i => i.status === 'idle')
      .map(i => ({ id: i.id, status: i.status, lastActivity: i.lastActivity }));
    const candidates = hibernation.getHibernationCandidates(instances);
    for (const candidate of candidates) {
      this.hibernateInstance(candidate.id).catch(err =>
        logger.warn('Failed to hibernate instance', { instanceId: candidate.id })
      );
    }
  });
} },
```

- [ ] **Step 2: Add hibernateInstance and wakeInstance methods**

Add to `AIOrchestratorApp` class:
```typescript
private async hibernateInstance(instanceId: string): Promise<void> {
  const instance = this.instanceManager.getInstance(instanceId);
  if (!instance || instance.status !== 'idle') return;

  const continuity = getSessionContinuityManager();
  const state: HibernatedInstance = {
    instanceId: instance.id,
    displayName: instance.displayName,
    agentId: instance.agentId,
    sessionState: {},
    hibernatedAt: Date.now(),
    workingDirectory: instance.workingDirectory,
    contextUsage: instance.contextUsage ? { used: instance.contextUsage.used, total: instance.contextUsage.total } : undefined,
  };

  // Save session state before terminating
  try {
    continuity.stopTracking(instanceId, true);
  } catch { /* best effort */ }

  getHibernationManager().markHibernated(instanceId, state);
  await this.instanceManager.terminateInstance(instanceId, true);
  logger.info('Instance hibernated', { instanceId });
}
```

- [ ] **Step 3: Add stop in cleanup()**

```typescript
try { getHibernationManager().stop(); } catch {}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f11): wire HibernationManager into app lifecycle with auto-hibernate"
```

---

## Chunk 3: Instance Pooling

### Task 5: Create PoolManager Service

**Files:**
- Create: `src/main/process/pool-manager.ts`
- Create: `src/main/process/pool-manager.spec.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PoolManager } from './pool-manager';

describe('PoolManager', () => {
  let pool: PoolManager;

  beforeEach(() => {
    PoolManager._resetForTesting();
    pool = PoolManager.getInstance();
  });

  it('should initialize with default config', () => {
    expect(pool.getConfig().minPoolSize).toBe(0);
    expect(pool.getConfig().maxPoolSize).toBe(5);
  });

  it('should track pool size', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    expect(pool.getPoolSize()).toBe(1);
    expect(pool.getAvailable()).toBe(1);
  });

  it('should acquire from pool', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    const acquired = pool.acquire({ provider: 'claude' });
    expect(acquired).toBe('inst-1');
    expect(pool.getPoolSize()).toBe(0);
  });

  it('should return null when pool is empty', () => {
    const acquired = pool.acquire({ provider: 'claude' });
    expect(acquired).toBeNull();
  });

  it('should match by provider', () => {
    pool.addToPool('inst-1', { provider: 'claude', workingDirectory: '/tmp' });
    pool.addToPool('inst-2', { provider: 'codex', workingDirectory: '/tmp' });
    const acquired = pool.acquire({ provider: 'codex' });
    expect(acquired).toBe('inst-2');
    expect(pool.getPoolSize()).toBe(1);
  });
});
```

- [ ] **Step 2: Implement PoolManager**

```typescript
import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('PoolManager');

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
    (this.instance as any) = undefined;
  }

  constructor(config?: Partial<PoolConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    if (this.config.enableAutoWarm && !this.warmupTimer) {
      this.warmupTimer = setInterval(() => this.checkPoolLevel(), this.config.warmupIntervalMs);
      logger.info('Pool manager started', { config: this.config });
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
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/main/process/pool-manager.spec.ts`
Expected: PASS

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/process/pool-manager.ts src/main/process/pool-manager.spec.ts
git commit -m "feat(f11): add PoolManager for pre-warmed CLI instance reuse"
```

---

### Task 6: Wire PoolManager Into App Lifecycle

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add import and init step**

```typescript
import { getPoolManager } from './process/pool-manager';
```

In initialize() steps:
```typescript
{ name: 'Instance pool', fn: () => {
  const pool = getPoolManager();
  pool.start();
  pool.on('instance:evicted', ({ instanceId }) => {
    this.instanceManager.terminateInstance(instanceId, true).catch(() => {});
  });
} },
```

- [ ] **Step 2: Add stop in cleanup()**

```typescript
try { getPoolManager().stop(); } catch {}
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f11): wire PoolManager into app lifecycle"
```

---

## Chunk 4: Load Balancing

### Task 7: Create LoadBalancer Service

**Files:**
- Create: `src/main/process/load-balancer.ts`
- Create: `src/main/process/load-balancer.spec.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { LoadBalancer } from './load-balancer';

describe('LoadBalancer', () => {
  let balancer: LoadBalancer;

  beforeEach(() => {
    LoadBalancer._resetForTesting();
    balancer = LoadBalancer.getInstance();
  });

  it('should update load metrics', () => {
    balancer.updateMetrics('inst-1', {
      activeTasks: 2,
      contextUsagePercent: 50,
      memoryPressure: 'normal',
      status: 'busy',
    });
    const metrics = balancer.getMetrics('inst-1');
    expect(metrics?.activeTasks).toBe(2);
  });

  it('should select least loaded instance', () => {
    balancer.updateMetrics('inst-1', {
      activeTasks: 3,
      contextUsagePercent: 80,
      memoryPressure: 'normal',
      status: 'busy',
    });
    balancer.updateMetrics('inst-2', {
      activeTasks: 1,
      contextUsagePercent: 30,
      memoryPressure: 'normal',
      status: 'idle',
    });
    balancer.updateMetrics('inst-3', {
      activeTasks: 0,
      contextUsagePercent: 10,
      memoryPressure: 'normal',
      status: 'idle',
    });
    const selected = balancer.selectLeastLoaded(['inst-1', 'inst-2', 'inst-3']);
    expect(selected).toBe('inst-3');
  });

  it('should exclude instances at critical memory pressure', () => {
    balancer.updateMetrics('inst-1', {
      activeTasks: 0,
      contextUsagePercent: 10,
      memoryPressure: 'critical',
      status: 'idle',
    });
    balancer.updateMetrics('inst-2', {
      activeTasks: 2,
      contextUsagePercent: 60,
      memoryPressure: 'normal',
      status: 'busy',
    });
    const selected = balancer.selectLeastLoaded(['inst-1', 'inst-2']);
    expect(selected).toBe('inst-2');
  });

  it('should return null when no eligible instances', () => {
    const selected = balancer.selectLeastLoaded([]);
    expect(selected).toBeNull();
  });
});
```

- [ ] **Step 2: Implement LoadBalancer**

```typescript
import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import type { MemoryPressureLevel } from '../memory/memory-monitor';

const logger = getLogger('LoadBalancer');

export interface LoadMetrics {
  activeTasks: number;
  contextUsagePercent: number;
  memoryPressure: MemoryPressureLevel;
  status: string;
  lastUpdated?: number;
}

export interface LoadBalancerConfig {
  weightActiveTasks: number;        // Weight for active task count (default: 0.4)
  weightContextUsage: number;       // Weight for context usage % (default: 0.3)
  weightMemoryPressure: number;     // Weight for memory pressure (default: 0.3)
  excludeCriticalMemory: boolean;   // Skip instances at critical (default: true)
  excludeTerminated: boolean;       // Skip terminated instances (default: true)
  staleMetricsMs: number;           // Ignore metrics older than this (default: 60s)
}

const DEFAULT_CONFIG: LoadBalancerConfig = {
  weightActiveTasks: 0.4,
  weightContextUsage: 0.3,
  weightMemoryPressure: 0.3,
  excludeCriticalMemory: true,
  excludeTerminated: true,
  staleMetricsMs: 60 * 1000,
};

const PRESSURE_SCORES: Record<MemoryPressureLevel, number> = {
  normal: 0,
  warning: 50,
  critical: 100,
};

export class LoadBalancer extends EventEmitter {
  private config: LoadBalancerConfig;
  private metrics = new Map<string, LoadMetrics>();

  private static instance: LoadBalancer;

  static getInstance(): LoadBalancer {
    if (!this.instance) {
      this.instance = new LoadBalancer();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as any) = undefined;
  }

  constructor(config?: Partial<LoadBalancerConfig>) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  updateMetrics(instanceId: string, metrics: LoadMetrics): void {
    this.metrics.set(instanceId, { ...metrics, lastUpdated: Date.now() });
  }

  removeMetrics(instanceId: string): void {
    this.metrics.delete(instanceId);
  }

  getMetrics(instanceId: string): LoadMetrics | undefined {
    return this.metrics.get(instanceId);
  }

  getAllMetrics(): Map<string, LoadMetrics> {
    return new Map(this.metrics);
  }

  configure(updates: Partial<LoadBalancerConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Select the least-loaded instance from the given candidates.
   * Returns instanceId or null if none eligible.
   */
  selectLeastLoaded(candidateIds: string[]): string | null {
    const now = Date.now();
    let bestId: string | null = null;
    let bestScore = Infinity;

    for (const id of candidateIds) {
      const m = this.metrics.get(id);
      if (!m) continue;

      // Skip stale metrics
      if (m.lastUpdated && (now - m.lastUpdated) > this.config.staleMetricsMs) continue;

      // Exclude critical memory instances
      if (this.config.excludeCriticalMemory && m.memoryPressure === 'critical') continue;

      // Exclude terminated
      if (this.config.excludeTerminated && m.status === 'terminated') continue;

      const score = this.computeScore(m);
      if (score < bestScore) {
        bestScore = score;
        bestId = id;
      }
    }

    return bestId;
  }

  /**
   * Select the best N instances for parallel work distribution.
   */
  selectTopN(candidateIds: string[], n: number): string[] {
    const scored = candidateIds
      .map(id => ({ id, metrics: this.metrics.get(id) }))
      .filter(({ metrics }) => {
        if (!metrics) return false;
        if (this.config.excludeCriticalMemory && metrics.memoryPressure === 'critical') return false;
        if (this.config.excludeTerminated && metrics.status === 'terminated') return false;
        return true;
      })
      .map(({ id, metrics }) => ({ id, score: this.computeScore(metrics!) }))
      .sort((a, b) => a.score - b.score);

    return scored.slice(0, n).map(s => s.id);
  }

  getStats(): { trackedInstances: number; avgLoad: number } {
    const values = [...this.metrics.values()];
    const avgLoad = values.length === 0 ? 0 :
      values.reduce((sum, m) => sum + this.computeScore(m), 0) / values.length;
    return { trackedInstances: this.metrics.size, avgLoad: Math.round(avgLoad) };
  }

  private computeScore(m: LoadMetrics): number {
    const taskScore = Math.min(m.activeTasks * 25, 100); // Normalize: 4 tasks = 100
    const contextScore = m.contextUsagePercent;
    const pressureScore = PRESSURE_SCORES[m.memoryPressure] ?? 0;

    return (
      this.config.weightActiveTasks * taskScore +
      this.config.weightContextUsage * contextScore +
      this.config.weightMemoryPressure * pressureScore
    );
  }
}

export function getLoadBalancer(): LoadBalancer {
  return LoadBalancer.getInstance();
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/main/process/load-balancer.spec.ts`
Expected: PASS

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/process/load-balancer.ts src/main/process/load-balancer.spec.ts
git commit -m "feat(f11): add LoadBalancer for weighted instance selection"
```

---

### Task 8: Wire LoadBalancer Into Event System

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add import and init step**

```typescript
import { getLoadBalancer } from './process/load-balancer';
```

In initialize() steps:
```typescript
{ name: 'Load balancer', fn: () => { getLoadBalancer(); } },
```

- [ ] **Step 2: Update metrics from batch updates**

In `setupInstanceEventForwarding()`, inside the `instance:batch-update` handler, after existing processing:

```typescript
// Update load balancer metrics
const lb = getLoadBalancer();
for (const update of data.updates) {
  if (update.instanceId) {
    lb.updateMetrics(update.instanceId, {
      activeTasks: 0, // Will be enriched when TaskManager integration is wired
      contextUsagePercent: update.contextUsage
        ? Math.round((update.contextUsage.used / update.contextUsage.total) * 100)
        : 0,
      memoryPressure: 'normal',
      status: update.status || 'idle',
    });
  }
}
```

- [ ] **Step 3: Remove metrics on instance removal**

In the `instance:removed` handler:
```typescript
getLoadBalancer().removeMetrics(instanceId as string);
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(f11): wire LoadBalancer metrics into instance event system"
```

---

## Chunk 5: Final Verification

### Task 9: Verify All F11 Systems

- [ ] **Step 1: Run all tests**

Run: `npm run test`
Expected: PASS

- [ ] **Step 2: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: PASS
