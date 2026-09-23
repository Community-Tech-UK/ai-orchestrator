# Instance Startup Optimization Implementation Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** New statuses via `@contracts/types/instance-events`, state machine, snapshot index, async continuity, `hibernation-manager.ts`, Phase 1/Phase 2 split with `readyPromise` (`instance-lifecycle.ts`, awaited in `instance-manager.ts`), INSTANCE_HIBERNATE/INSTANCE_WAKE handlers in `instance-handlers.ts`, `warm-start-manager.ts`.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all instances feel "live" — instant creation, hibernate-and-wake instead of terminate, seamless transcript restore.

**Architecture:** Four independent subsystems: (1) state machine + deferred init for instant creation, (2) hibernation lifecycle wiring, (3) SessionContinuityManager async perf fixes, (4) warm-start manager. Each builds on shared types added in Task 1.

**Tech Stack:** TypeScript, Electron IPC, Node.js `fs.promises`, Vitest

**Spec:** `docs/superpowers/specs/2026-03-14-instance-startup-optimization-design.md`

---

## Chunk 1: Foundation — Types, State Machine, and Async Continuity

### Task 1: Add New Instance States to Shared Types

**Files:**
- Modify: `src/shared/types/instance.types.ts:69-76`
- Modify: `src/shared/types/ipc.types.ts:17-35`

- [ ] **Step 1: Add new states to InstanceStatus**

In `src/shared/types/instance.types.ts`, replace the `InstanceStatus` type at line 69:

```typescript
export type InstanceStatus =
  | 'initializing'
  | 'ready'        // NEW: init complete, adapter spawned, waiting for first input
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'respawning'
  | 'hibernating'  // NEW: saving state to disk before suspend
  | 'hibernated'   // NEW: state saved, process killed, can wake
  | 'waking'       // NEW: restoring from hibernation
  | 'error'
  | 'failed'       // NEW: unrecoverable init/wake failure
  | 'terminated';
```

- [ ] **Step 2: Add new IPC channels**

In `src/shared/types/ipc.types.ts`, add after the `INSTANCE_REMOVED` line (~line 34):

```typescript
  // Hibernation lifecycle
  INSTANCE_HIBERNATE: 'instance:hibernate',
  INSTANCE_HIBERNATED: 'instance:hibernated',
  INSTANCE_WAKE: 'instance:wake',
  INSTANCE_WAKING: 'instance:waking',
  INSTANCE_TRANSCRIPT_CHUNK: 'instance:transcript-chunk',
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: Errors in files that use the old status values — this is expected and will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/shared/types/instance.types.ts src/shared/types/ipc.types.ts
git commit -m "feat: add hibernation/wake instance states and IPC channels"
```

---

### Task 2: Instance State Machine

**Files:**
- Create: `src/main/instance/instance-state-machine.ts`
- Create: `src/main/instance/instance-state-machine.spec.ts`

- [ ] **Step 1: Write failing tests for valid transitions**

Create `src/main/instance/instance-state-machine.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { InstanceStateMachine, InvalidTransitionError } from './instance-state-machine';

describe('InstanceStateMachine', () => {
  it('allows initializing → ready', () => {
    const sm = new InstanceStateMachine('initializing');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('allows ready → busy → idle', () => {
    const sm = new InstanceStateMachine('ready');
    sm.transition('busy');
    sm.transition('idle');
    expect(sm.current).toBe('idle');
  });

  it('allows idle → hibernating → hibernated → waking → ready', () => {
    const sm = new InstanceStateMachine('idle');
    sm.transition('hibernating');
    sm.transition('hibernated');
    sm.transition('waking');
    sm.transition('ready');
    expect(sm.current).toBe('ready');
  });

  it('throws on invalid transition idle → busy', () => {
    const sm = new InstanceStateMachine('idle');
    expect(() => sm.transition('busy')).toThrow(InvalidTransitionError);
  });

  it('allows terminated from any state', () => {
    const sm = new InstanceStateMachine('busy');
    sm.transition('terminated');
    expect(sm.current).toBe('terminated');
  });

  it('allows failed from any state', () => {
    const sm = new InstanceStateMachine('waking');
    sm.transition('failed');
    expect(sm.current).toBe('failed');
  });

  it('throws when transitioning from terminated', () => {
    const sm = new InstanceStateMachine('terminated');
    expect(() => sm.transition('ready')).toThrow(InvalidTransitionError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/instance-state-machine.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the state machine**

Create `src/main/instance/instance-state-machine.ts`:

```typescript
import type { InstanceStatus } from '../../shared/types/instance.types';

export class InvalidTransitionError extends Error {
  constructor(from: InstanceStatus, to: InstanceStatus) {
    super(`Invalid state transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/**
 * Allowed transitions map. Keys are source states, values are sets of
 * allowed target states. 'terminated' and 'failed' are reachable from
 * any non-terminal state (added dynamically in canTransition).
 */
const TRANSITIONS: Record<string, readonly InstanceStatus[]> = {
  initializing: ['ready', 'error'],
  ready:        ['busy', 'idle', 'hibernating'],
  idle:         ['ready', 'hibernating', 'waiting_for_input'],
  busy:         ['idle', 'ready', 'waiting_for_input', 'error'],
  waiting_for_input: ['busy', 'idle', 'ready'],
  respawning:   ['ready', 'idle', 'error'],
  hibernating:  ['hibernated'],
  hibernated:   ['waking'],
  waking:       ['ready', 'error'],
  error:        ['ready', 'idle', 'respawning'],
};

const TERMINAL_STATES: InstanceStatus[] = ['terminated', 'failed'];
const UNIVERSAL_TARGETS: InstanceStatus[] = ['terminated', 'failed'];

export class InstanceStateMachine {
  private _current: InstanceStatus;

  constructor(initial: InstanceStatus) {
    this._current = initial;
  }

  get current(): InstanceStatus {
    return this._current;
  }

  canTransition(to: InstanceStatus): boolean {
    if (TERMINAL_STATES.includes(this._current)) return false;
    if (UNIVERSAL_TARGETS.includes(to)) return true;
    const allowed = TRANSITIONS[this._current];
    return !!allowed && allowed.includes(to);
  }

  transition(to: InstanceStatus): void {
    if (!this.canTransition(to)) {
      throw new InvalidTransitionError(this._current, to);
    }
    this._current = to;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/instance/instance-state-machine.spec.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.spec.json`

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/instance-state-machine.ts src/main/instance/instance-state-machine.spec.ts
git commit -m "feat: add InstanceStateMachine with transition validation"
```

---

### Task 3: Snapshot Index (In-Memory)

**Files:**
- Create: `src/main/session/snapshot-index.ts`
- Create: `src/main/session/snapshot-index.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/session/snapshot-index.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SnapshotIndex, SnapshotMeta } from './snapshot-index';

describe('SnapshotIndex', () => {
  let index: SnapshotIndex;

  beforeEach(() => {
    index = new SnapshotIndex();
  });

  it('adds and retrieves entries', () => {
    const meta: SnapshotMeta = {
      id: 'snap-1',
      sessionId: 'sess-1',
      timestamp: 1000,
      messageCount: 10,
      schemaVersion: 1,
    };
    index.add(meta);
    expect(index.listForSession('sess-1')).toEqual([meta]);
  });

  it('returns entries sorted by timestamp descending', () => {
    index.add({ id: 'a', sessionId: 's1', timestamp: 100, messageCount: 5, schemaVersion: 1 });
    index.add({ id: 'b', sessionId: 's1', timestamp: 300, messageCount: 15, schemaVersion: 1 });
    index.add({ id: 'c', sessionId: 's1', timestamp: 200, messageCount: 10, schemaVersion: 1 });
    const list = index.listForSession('s1');
    expect(list.map(s => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('removes entries', () => {
    index.add({ id: 'a', sessionId: 's1', timestamp: 100, messageCount: 5, schemaVersion: 1 });
    index.remove('a');
    expect(index.listForSession('s1')).toEqual([]);
  });

  it('filters by cutoff time', () => {
    index.add({ id: 'old', sessionId: 's1', timestamp: 100, messageCount: 5, schemaVersion: 1 });
    index.add({ id: 'new', sessionId: 's1', timestamp: 500, messageCount: 10, schemaVersion: 1 });
    const expired = index.getExpiredBefore(300);
    expect(expired.map(s => s.id)).toEqual(['old']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/session/snapshot-index.spec.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SnapshotIndex**

Create `src/main/session/snapshot-index.ts`:

```typescript
export interface SnapshotMeta {
  id: string;
  sessionId: string;
  timestamp: number;
  messageCount: number;
  schemaVersion: number;
}

export class SnapshotIndex {
  private entries = new Map<string, SnapshotMeta>();

  add(meta: SnapshotMeta): void {
    this.entries.set(meta.id, meta);
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  get(id: string): SnapshotMeta | undefined {
    return this.entries.get(id);
  }

  listForSession(sessionId: string): SnapshotMeta[] {
    return [...this.entries.values()]
      .filter(e => e.sessionId === sessionId)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  listAll(): SnapshotMeta[] {
    return [...this.entries.values()]
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  getExpiredBefore(cutoffTimestamp: number): SnapshotMeta[] {
    return [...this.entries.values()]
      .filter(e => e.timestamp < cutoffTimestamp);
  }

  getExcessForSession(sessionId: string, maxCount: number): SnapshotMeta[] {
    const sorted = this.listForSession(sessionId);
    return sorted.slice(maxCount);
  }

  get size(): number {
    return this.entries.size;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/session/snapshot-index.spec.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/session/snapshot-index.ts src/main/session/snapshot-index.spec.ts
git commit -m "feat: add in-memory SnapshotIndex for fast snapshot lookups"
```

---

### Task 4: SessionContinuityManager Async Migration

**Files:**
- Modify: `src/main/session/session-continuity.ts`
- Reference: `docs/superpowers/specs/2026-03-14-instance-startup-optimization-design.md` Section 3

This is the largest single task. It converts sync FS to async, adds atomic writes, global autosave timer, readyPromise pattern, compact JSON, schema versioning, and integrates the SnapshotIndex.

- [ ] **Step 1: Add readyPromise and async constructor pattern**

In `src/main/session/session-continuity.ts`, modify the constructor (~line 151-162):

```typescript
  private readyPromise: Promise<void>;
  private inFlightSaves = new Set<string>();
  private globalAutoSaveTimer: NodeJS.Timeout | null = null;
  private snapshotIndex: SnapshotIndex;

  constructor(config: Partial<ContinuityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    const userData = app.getPath('userData');
    this.continuityDir = path.join(userData, 'session-continuity');
    this.stateDir = path.join(this.continuityDir, 'states');
    this.snapshotDir = path.join(this.continuityDir, 'snapshots');
    this.snapshotIndex = new SnapshotIndex();

    this.readyPromise = this.initAsync();
  }

  private async initAsync(): Promise<void> {
    await this.ensureDirectories();
    await this.loadActiveStates();
    await this.buildSnapshotIndex();
    this.startGlobalAutoSave();
  }
```

- [ ] **Step 2: Convert ensureDirectories to async**

```typescript
  private async ensureDirectories(): Promise<void> {
    for (const dir of [this.continuityDir, this.stateDir, this.snapshotDir]) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
    // Ensure quarantine dir for incompatible snapshots
    await fs.promises.mkdir(path.join(this.snapshotDir, 'quarantine'), { recursive: true });
  }
```

- [ ] **Step 3: Convert loadActiveStates to async**

```typescript
  private async loadActiveStates(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.stateDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.stateDir, file);
          const data = await this.readPayload<SessionState>(filePath);
          if (data) {
            this.sessionStates.set(data.instanceId, data);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load session states', error instanceof Error ? error : undefined);
    }
  }
```

- [ ] **Step 4: Add buildSnapshotIndex**

```typescript
  private async buildSnapshotIndex(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.snapshotDir, { withFileTypes: true });
      for (const entry of files) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const filePath = path.join(this.snapshotDir, entry.name);
        const data = await this.readPayload<SessionSnapshot & { schemaVersion?: number }>(filePath);
        if (data) {
          this.snapshotIndex.add({
            id: data.id,
            sessionId: data.sessionId,
            timestamp: data.timestamp,
            messageCount: data.metadata.messageCount,
            schemaVersion: data.schemaVersion ?? 1,
          });
        }
      }
    } catch (error) {
      logger.error('Failed to build snapshot index', error instanceof Error ? error : undefined);
    }
  }
```

- [ ] **Step 5: Convert writePayload to atomic async**

```typescript
  private async writePayload(filePath: string, data: unknown): Promise<void> {
    const serialized = this.serializePayload(data);
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, serialized);
    const fd = await fs.promises.open(tmpPath, 'r');
    await fd.sync();
    await fd.close();
    await fs.promises.rename(tmpPath, filePath);
    // fsync parent directory for crash durability
    const dirFd = await fs.promises.open(path.dirname(filePath), 'r');
    await dirFd.sync();
    await dirFd.close();
  }
```

- [ ] **Step 6: Convert readPayload to async**

```typescript
  private async readPayload<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return this.deserializePayload<T>(raw);
    } catch (error) {
      logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
      return null;
    }
  }
```

- [ ] **Step 7: Use compact JSON in serializePayload**

Change `JSON.stringify(data, null, 2)` to `JSON.stringify(data)` in serializePayload method (~line 628).

- [ ] **Step 8: Replace structuredClone for deep copies**

In `createSnapshot()` and `exportSession()`, replace `JSON.parse(JSON.stringify(state))` with:

```typescript
    let cloned: SessionState;
    try {
      cloned = structuredClone(state);
    } catch {
      cloned = JSON.parse(JSON.stringify(state));
    }
```

- [ ] **Step 9: Add global autosave with jitter and dedup**

```typescript
  private startGlobalAutoSave(): void {
    if (!this.config.autoSaveEnabled || this.globalAutoSaveTimer) return;

    this.globalAutoSaveTimer = setInterval(async () => {
      const dirtyIds = [...this.dirty];
      this.dirty.clear();

      for (const instanceId of dirtyIds) {
        if (this.inFlightSaves.has(instanceId)) continue; // skip if previous save still pending
        this.inFlightSaves.add(instanceId);

        // Jitter: random delay 0-10s to avoid burst I/O
        const jitter = Math.random() * 10_000;
        setTimeout(async () => {
          try {
            await this.saveState(instanceId);
          } finally {
            this.inFlightSaves.delete(instanceId);
          }
        }, jitter);
      }
    }, this.config.autoSaveIntervalMs);
  }
```

- [ ] **Step 10: Make all public methods await readyPromise**

Add `await this.readyPromise;` as the first line of: `startTracking()`, `stopTracking()`, `updateState()`, `addConversationEntry()`, `createSnapshot()`, `listSnapshots()`, `getResumableSessions()`, `resumeSession()`, `getTranscript()`, `exportSession()`, `importSession()`, `saveState()`, `getStats()`.

Convert all to `async` if not already.

- [ ] **Step 11: Convert remaining sync FS calls**

- `stopTracking()`: `fs.existsSync` → `try { await fs.promises.access(...) } catch (e) { if (e.code !== 'ENOENT') throw e; }`
- `stopTracking()`: `fs.unlinkSync` → `await fs.promises.unlink`
- `cleanupSnapshots()`: `fs.existsSync` → async access check
- `cleanupSnapshots()`: `fs.unlinkSync` → `await fs.promises.unlink`
- `getStats()`: `fs.readdirSync` → `await fs.promises.readdir`
- `getStats()`: `fs.statSync` → `await fs.promises.stat`

- [ ] **Step 12: Replace per-instance autosave with global timer**

Remove the `setupAutoSave()` method and its calls. Remove the `autoSaveTimers` map. The global timer from Step 9 handles all dirty instances.

- [ ] **Step 13: Update listSnapshots to use index**

```typescript
  async listSnapshots(instanceId?: string): Promise<SessionSnapshot[]> {
    await this.readyPromise;
    const metas = instanceId
      ? this.snapshotIndex.listForSession(instanceId)
      : this.snapshotIndex.listAll();

    // Load full snapshot data only for the returned entries
    const snapshots: SessionSnapshot[] = [];
    for (const meta of metas) {
      const filePath = path.join(this.snapshotDir, `${meta.id}.json`);
      const data = await this.readPayload<SessionSnapshot>(filePath);
      if (data) snapshots.push(data);
    }
    return snapshots;
  }
```

- [ ] **Step 14: Update cleanupSnapshots to use single-pass index**

```typescript
  private async cleanupSnapshots(instanceId: string): Promise<void> {
    const cutoffTime = Date.now() - this.config.snapshotRetentionDays * 24 * 60 * 60 * 1000;

    // Single pass: collect expired + excess
    const expired = this.snapshotIndex.getExpiredBefore(cutoffTime)
      .filter(s => s.sessionId === instanceId);
    const excess = this.snapshotIndex.getExcessForSession(instanceId, this.config.maxSnapshots);

    const toRemove = new Set([...expired, ...excess].map(s => s.id));

    for (const id of toRemove) {
      const snapshotFile = path.join(this.snapshotDir, `${id}.json`);
      try {
        await fs.promises.unlink(snapshotFile);
      } catch { /* file may already be gone */ }
      this.snapshotIndex.remove(id);
    }
  }
```

- [ ] **Step 15: Add schema versioning to createSnapshot**

Add `schemaVersion: 1` to the snapshot object in `createSnapshot()`, and update the index when creating:

```typescript
    const snapshot: SessionSnapshot & { schemaVersion: number } = {
      // ... existing fields ...
      schemaVersion: 1,
    };
    // After saving:
    this.snapshotIndex.add({
      id: snapshot.id,
      sessionId: instanceId,
      timestamp: snapshot.timestamp,
      messageCount: snapshot.metadata.messageCount,
      schemaVersion: 1,
    });
```

- [ ] **Step 16: Add import for SnapshotIndex**

Add at the top of `session-continuity.ts`:
```typescript
import { SnapshotIndex } from './snapshot-index';
```

- [ ] **Step 17: Update shutdown to clear global timer**

```typescript
  shutdown(): void {
    // Save all dirty states synchronously for shutdown
    // (async would be ideal but shutdown must be synchronous)
    if (this.globalAutoSaveTimer) {
      clearInterval(this.globalAutoSaveTimer);
      this.globalAutoSaveTimer = null;
    }
    for (const instanceId of this.dirty) {
      // Best-effort sync save on shutdown
      const state = this.sessionStates.get(instanceId);
      if (state) {
        try {
          const stateFile = path.join(this.stateDir, `${instanceId}.json`);
          const serialized = this.serializePayload(state);
          fs.writeFileSync(stateFile, serialized);
        } catch (error) {
          logger.error('Failed to save state on shutdown', error instanceof Error ? error : undefined, { instanceId });
        }
      }
    }
  }
```

- [ ] **Step 18: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 19: Run existing session-continuity tests (if any) and fix**

Run: `npx vitest run src/main/session/ --reporter=verbose`

- [ ] **Step 20: Commit**

```bash
git add src/main/session/session-continuity.ts
git commit -m "feat: async FS migration, atomic writes, global autosave, snapshot index in SessionContinuityManager"
```

---

## Chunk 2: Hibernation Lifecycle and Deferred Init

### Task 5: Upgrade HibernationManager — Weighted Eviction, Hysteresis, 30min Default

**Files:**
- Modify: `src/main/process/hibernation-manager.ts`
- Modify: `src/main/process/hibernation-manager.spec.ts`

- [ ] **Step 1: Write new tests for weighted eviction and hysteresis**

Add to `hibernation-manager.spec.ts`:

```typescript
  it('uses 30min default idle threshold', () => {
    expect(manager.getConfig().idleThresholdMs).toBe(30 * 60 * 1000);
  });

  it('respects hysteresis cooldown after wake', () => {
    const now = Date.now();
    manager.markAwoken('inst-1');
    const instances = [
      { id: 'inst-1', status: 'idle' as const, lastActivity: now - 35 * 60 * 1000 },
    ];
    // Should NOT be a candidate — was woken less than 5min ago
    const eligible = manager.getHibernationCandidates(instances, now);
    expect(eligible.length).toBe(0);
  });

  it('scores eviction candidates by weighted formula', () => {
    const now = Date.now();
    const candidates = [
      { id: 'a', status: 'idle' as const, lastActivity: now - 60 * 60 * 1000, transcriptSize: 100, restartCost: 1 },
      { id: 'b', status: 'idle' as const, lastActivity: now - 35 * 60 * 1000, transcriptSize: 5000, restartCost: 3 },
    ];
    const scored = manager.scoreEvictionCandidates(candidates);
    // 'a' has higher idle time but lower transcript — scores should differ
    expect(scored.length).toBe(2);
    expect(scored[0].id).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `npx vitest run src/main/process/hibernation-manager.spec.ts`

- [ ] **Step 3: Update default config**

Change `idleThresholdMs` from `10 * 60 * 1000` to `30 * 60 * 1000`. Set `enableAutoHibernation: true`.

- [ ] **Step 4: Add hysteresis tracking**

```typescript
  private recentWakes = new Map<string, number>(); // instanceId → wakeTimestamp
  private readonly hysteresisCooldownMs = 5 * 60 * 1000; // 5 minutes

  markAwoken(instanceId: string): void {
    const state = this.hibernated.get(instanceId);
    if (state) {
      this.hibernated.delete(instanceId);
      this.recentWakes.set(instanceId, Date.now());
      this.emit('instance:awoken', { instanceId, state });
      logger.info('Instance awoken', { instanceId });
    }
  }
```

Update `getHibernationCandidates` to exclude recently woken instances:

```typescript
  getHibernationCandidates(
    instances: HibernationCandidate[],
    now = Date.now()
  ): HibernationCandidate[] {
    return instances.filter(inst =>
      inst.status === 'idle' &&
      (now - inst.lastActivity) > this.config.idleThresholdMs &&
      !this.hibernated.has(inst.id) &&
      !this.isInCooldown(inst.id, now)
    ).sort((a, b) => a.lastActivity - b.lastActivity);
  }

  private isInCooldown(instanceId: string, now: number): boolean {
    const wakeTime = this.recentWakes.get(instanceId);
    if (!wakeTime) return false;
    if (now - wakeTime > this.hysteresisCooldownMs) {
      this.recentWakes.delete(instanceId);
      return false;
    }
    return true;
  }
```

- [ ] **Step 5: Add weighted eviction scoring**

```typescript
  export interface EvictionCandidate extends HibernationCandidate {
    transcriptSize: number;
    restartCost: number;
  }

  scoreEvictionCandidates(candidates: EvictionCandidate[], now = Date.now()): Array<EvictionCandidate & { score: number }> {
    if (candidates.length === 0) return [];

    const maxIdle = Math.max(...candidates.map(c => now - c.lastActivity));
    const maxTranscript = Math.max(...candidates.map(c => c.transcriptSize)) || 1;
    const maxCost = Math.max(...candidates.map(c => c.restartCost)) || 1;

    return candidates.map(c => {
      const idleNorm = (now - c.lastActivity) / maxIdle;
      const transcriptNorm = c.transcriptSize / maxTranscript;
      const costNorm = c.restartCost / maxCost;
      // Higher score = more likely to evict
      const score = (idleNorm * 0.5) + (transcriptNorm * 0.3) + (costNorm * 0.2);
      return { ...c, score };
    }).sort((a, b) => b.score - a.score);
  }
```

- [ ] **Step 6: Run all hibernation tests**

Run: `npx vitest run src/main/process/hibernation-manager.spec.ts`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/process/hibernation-manager.ts src/main/process/hibernation-manager.spec.ts
git commit -m "feat: 30min default, weighted eviction, hysteresis cooldown in HibernationManager"
```

---

### Task 6: Deferred Init in InstanceLifecycleManager

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`
- Modify: `src/main/instance/instance-manager.ts`
- Reference: Spec Section 1

This task restructures `createInstance()` into Phase 1 (sync, <5ms) and Phase 2 (background Promise.all). The `readyPromise` is stored on the instance and awaited in `sendInput()`.

- [ ] **Step 1: Add readyPromise and abortController to Instance type**

In `src/shared/types/instance.types.ts`, add to the Instance interface (around line 130-170):

```typescript
  /** Resolves when init/wake completes. sendInput() awaits this. */
  readyPromise?: Promise<void>;
  /** Signals cancellation of in-progress init/wake. */
  abortController?: AbortController;
```

- [ ] **Step 2: Split createInstance into Phase 1 + Phase 2**

In `src/main/instance/instance-lifecycle.ts`, refactor `createInstance()`:

Phase 1 (synchronous): generate ID, set status `initializing`, register in store, create AbortController, kick off Phase 2.

Phase 2 (background): `Promise.all([loadPermissions(), loadInstructionHierarchy(), resolveProvider()])` → build system prompt → spawn adapter → set status `ready`.

Store the Phase 2 promise as `instance.readyPromise`.

Wrap Phase 2 in try/catch: on error or abort signal, clean up adapter, set status `failed`.

- [ ] **Step 3: Add readyPromise guard in sendInput**

In `src/main/instance/instance-manager.ts`, at the top of `sendInput()`:

```typescript
const instance = this.getInstance(instanceId);
if (instance?.readyPromise) {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Instance initialization timed out')), 30_000)
  );
  try {
    await Promise.race([instance.readyPromise, timeoutPromise]);
  } catch (error) {
    instance.abortController?.abort();
    // transition to failed
    throw error;
  }
  if (instance.status === 'failed') {
    throw new Error('Instance initialization failed');
  }
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/instance.types.ts src/main/instance/instance-lifecycle.ts src/main/instance/instance-manager.ts
git commit -m "feat: deferred init — createInstance() returns instantly, sendInput() awaits readyPromise"
```

---

### Task 7: Hibernate and Wake in InstanceLifecycleManager

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`
- Modify: `src/main/ipc/handlers/instance-handlers.ts`
- Reference: Spec Section 2

- [ ] **Step 1: Add hibernateInstance() method**

In `instance-lifecycle.ts`, add:

```typescript
  async hibernateInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) return;

    // Validate state
    if (instance.status !== 'idle') {
      throw new Error(`Cannot hibernate instance in state: ${instance.status}`);
    }

    // Transition to hibernating
    this.deps.setStatus(instanceId, 'hibernating');

    try {
      // Save state to disk
      const continuity = getSessionContinuityManager();
      await continuity.saveState(instanceId);

      // Kill adapter
      await this.deps.terminateAdapter(instanceId);

      // Mark hibernated
      const hibernation = getHibernationManager();
      hibernation.markHibernated(instanceId, {
        instanceId,
        displayName: instance.displayName,
        agentId: instance.agentId,
        sessionState: {},
        hibernatedAt: Date.now(),
        workingDirectory: instance.workingDirectory,
        contextUsage: instance.contextUsage,
      });

      this.deps.setStatus(instanceId, 'hibernated');
      logger.info('Instance hibernated', { instanceId });
    } catch (error) {
      this.deps.setStatus(instanceId, 'failed');
      logger.error('Failed to hibernate instance', error instanceof Error ? error : undefined, { instanceId });
      throw error;
    }
  }
```

- [ ] **Step 2: Add wakeInstance() method**

```typescript
  async wakeInstance(instanceId: string): Promise<void> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance || instance.status !== 'hibernated') {
      throw new Error(`Cannot wake instance in state: ${instance?.status}`);
    }

    this.deps.setStatus(instanceId, 'waking');

    const abortController = new AbortController();
    instance.abortController = abortController;

    instance.readyPromise = (async () => {
      try {
        // Load state from continuity
        const continuity = getSessionContinuityManager();
        const state = await continuity.resumeSession(instanceId, {
          restoreMessages: true,
          restoreContext: true,
          restoreEnvironment: true,
        });

        if (!state || abortController.signal.aborted) return;

        // Restore transcript to output buffer (last 50 immediately)
        // Remaining loaded async — handled by IPC event

        // Spawn adapter with resume flag
        await this.deps.spawnAdapter(instanceId, { resume: true });

        // Mark awoken
        const hibernation = getHibernationManager();
        hibernation.markAwoken(instanceId);

        this.deps.setStatus(instanceId, 'ready');
        logger.info('Instance woken', { instanceId });
      } catch (error) {
        if (!abortController.signal.aborted) {
          this.deps.setStatus(instanceId, 'failed');
          logger.error('Failed to wake instance', error instanceof Error ? error : undefined, { instanceId });
        }
      }
    })();
  }
```

- [ ] **Step 3: Register IPC handlers for hibernate/wake**

In `src/main/ipc/handlers/instance-handlers.ts`, add handlers for the new channels:

```typescript
  ipcMain.handle(IPC_CHANNELS.INSTANCE_HIBERNATE, async (_event, payload) => {
    const { instanceId } = payload;
    await instanceManager.hibernateInstance(instanceId);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.INSTANCE_WAKE, async (_event, payload) => {
    const { instanceId } = payload;
    await instanceManager.wakeInstance(instanceId);
    return { success: true };
  });
```

- [ ] **Step 4: Wire idle check timer to use hibernation**

In `instance-lifecycle.ts`, update the idle check timer to call `hibernateInstance()` instead of `terminateInstance()` for instances with conversation history.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts src/main/ipc/handlers/instance-handlers.ts
git commit -m "feat: hibernate/wake lifecycle — save state on idle, restore on click"
```

---

## Chunk 3: Warm Start, UI Updates, and Observability

### Task 8: Warm Start Manager

**Files:**
- Create: `src/main/instance/warm-start-manager.ts`
- Create: `src/main/instance/warm-start-manager.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WarmStartManager } from './warm-start-manager';

describe('WarmStartManager', () => {
  let manager: WarmStartManager;
  const mockSpawn = vi.fn().mockResolvedValue({ pid: 1234 });
  const mockKill = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WarmStartManager({ spawnAdapter: mockSpawn, killAdapter: mockKill });
  });

  it('pre-spawns a warm process for a provider', async () => {
    await manager.preWarm('claude', '/tmp/project');
    expect(mockSpawn).toHaveBeenCalledWith('claude', expect.objectContaining({ workingDirectory: '/tmp/project' }));
    expect(manager.hasWarm('claude')).toBe(true);
  });

  it('consumes the warm process on match', async () => {
    await manager.preWarm('claude', '/tmp/project');
    const adapter = manager.consume('claude');
    expect(adapter).toBeDefined();
    expect(manager.hasWarm('claude')).toBe(false);
  });

  it('returns null on provider mismatch', async () => {
    await manager.preWarm('claude', '/tmp/project');
    expect(manager.consume('gemini')).toBeNull();
  });

  it('kills warm process after expiry', async () => {
    vi.useFakeTimers();
    await manager.preWarm('claude', '/tmp/project');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(mockKill).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not pre-warm when disabled', async () => {
    manager.setEnabled(false);
    await manager.preWarm('claude', '/tmp/project');
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/instance/warm-start-manager.spec.ts`

- [ ] **Step 3: Implement WarmStartManager**

Create `src/main/instance/warm-start-manager.ts`:

```typescript
import { getLogger } from '../logging/logger';

const logger = getLogger('WarmStartManager');

interface WarmProcess {
  provider: string;
  adapter: unknown;
  workingDirectory: string;
  createdAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface WarmStartDeps {
  spawnAdapter: (provider: string, options: { workingDirectory: string }) => Promise<unknown>;
  killAdapter: (adapter: unknown) => Promise<void>;
}

export class WarmStartManager {
  private warm: WarmProcess | null = null;
  private enabled = true;
  private deps: WarmStartDeps;
  private readonly expiryMs = 5 * 60 * 1000; // 5 minutes

  constructor(deps: WarmStartDeps) {
    this.deps = deps;
  }

  async preWarm(provider: string, workingDirectory: string): Promise<void> {
    if (!this.enabled) return;

    // Kill existing warm process if any
    await this.cleanup();

    try {
      const adapter = await this.deps.spawnAdapter(provider, { workingDirectory });
      const expiryTimer = setTimeout(() => this.expire(), this.expiryMs);

      this.warm = { provider, adapter, workingDirectory, createdAt: Date.now(), expiryTimer };
      logger.info('Warm process spawned', { provider, workingDirectory });
    } catch (error) {
      logger.warn('Failed to pre-warm process', { provider, error: error instanceof Error ? error.message : String(error) });
    }
  }

  consume(provider: string): unknown | null {
    if (!this.warm || this.warm.provider !== provider) return null;

    const adapter = this.warm.adapter;
    clearTimeout(this.warm.expiryTimer);
    this.warm = null;
    logger.info('Warm process consumed', { provider });
    return adapter;
  }

  hasWarm(provider: string): boolean {
    return this.warm?.provider === provider;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cleanup();
  }

  async cleanup(): Promise<void> {
    if (this.warm) {
      clearTimeout(this.warm.expiryTimer);
      try {
        await this.deps.killAdapter(this.warm.adapter);
      } catch { /* best effort */ }
      this.warm = null;
    }
  }

  private async expire(): Promise<void> {
    if (this.warm) {
      logger.info('Warm process expired', { provider: this.warm.provider });
      await this.cleanup();
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/instance/warm-start-manager.spec.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/warm-start-manager.ts src/main/instance/warm-start-manager.spec.ts
git commit -m "feat: WarmStartManager — pre-spawn one process for next-up instant creation"
```

---

### Task 9: Renderer Updates — Loading States and Hibernation Indicators

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-list/instance-row.component.ts`
- Modify: `src/renderer/app/core/state/instance.store.ts`

- [ ] **Step 1: Add loading state to send button during initializing/waking**

In `input-panel.component.ts`, find the send button and add a disabled/loading condition:

```typescript
[disabled]="isSending() || isInitializing()"
```

Add computed:
```typescript
readonly isInitializing = computed(() => {
  const status = this.instanceStatus();
  return status === 'initializing' || status === 'waking';
});
```

- [ ] **Step 2: Add hibernated visual indicator to instance row**

In `instance-row.component.ts`, update the `showActivitySpinner` computed to not show spinner for hibernated:

Add a new computed for hibernated state:
```typescript
readonly isHibernated = computed(() => this.instance().status === 'hibernated');
```

In the template, add a hibernated indicator (hollow dot or moon icon) alongside the existing provider badge when `isHibernated()` is true.

- [ ] **Step 3: Handle new states in instance store**

In `instance.store.ts`, ensure state update handlers recognize the new statuses (`ready`, `hibernating`, `hibernated`, `waking`, `failed`) and update UI accordingly.

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-detail/input-panel.component.ts \
  src/renderer/app/features/instance-list/instance-row.component.ts \
  src/renderer/app/core/state/instance.store.ts
git commit -m "feat: UI loading states for initializing/waking, hibernated indicator in instance list"
```

---

### Task 10: Integration Wiring and Final Typecheck

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` — integrate WarmStartManager
- Modify: `src/main/instance/instance-manager.ts` — wire hibernate/wake to public API
- All files — final typecheck pass

- [ ] **Step 1: Wire WarmStartManager into createInstance**

After a successful `createInstance()`, call `warmStartManager.preWarm(provider, workingDirectory)` in the background.

In `createInstance()`, check `warmStartManager.consume(provider)` first — if a warm process is available, use it instead of spawning.

- [ ] **Step 2: Disable warm start under memory pressure**

Listen for `memory:critical` events and call `warmStartManager.setEnabled(false)`. On `memory:normal`, re-enable.

- [ ] **Step 3: Full typecheck**

Run: `npx tsc --noEmit`
Expected: PASS with 0 errors

- [ ] **Step 4: Full spec typecheck**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: All tests PASS

- [ ] **Step 6: Lint**

Run: `npm run lint`
Expected: No new errors

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire warm-start, final integration for instance startup optimization"
```

---

## Summary

| Task | What | Key Files | Dependencies |
|------|------|-----------|-------------|
| 1 | New shared types | instance.types.ts, ipc.types.ts | None |
| 2 | State machine | instance-state-machine.ts | Task 1 |
| 3 | Snapshot index | snapshot-index.ts | None |
| 4 | Async SessionContinuity | session-continuity.ts | Task 3 |
| 5 | HibernationManager upgrade | hibernation-manager.ts | None |
| 6 | Deferred init | instance-lifecycle.ts, instance-manager.ts | Tasks 1, 2 |
| 7 | Hibernate/wake lifecycle | instance-lifecycle.ts, instance-handlers.ts | Tasks 4, 5, 6 |
| 8 | Warm start manager | warm-start-manager.ts | None |
| 9 | Renderer updates | input-panel, instance-row, instance.store | Tasks 1, 7 |
| 10 | Integration wiring | instance-lifecycle.ts, instance-manager.ts | All |

**Parallelizable:** Tasks 2, 3, 5, 8 can all run concurrently (no shared dependencies). Tasks 1 must come first. Task 10 must come last.
