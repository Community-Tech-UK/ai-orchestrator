# Knowledge Fixes, Gaps & UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 bugs identified in the Codex audit, close backend gaps, and build the full Angular UI for knowledge graph, wake context, and codebase mining.

**Architecture:** Fix bugs first (wake wing filtering, duplicate mining, dead endpoint, missing event listeners), then extend the memory IPC service with KG/wake/codebase methods, create a signal-based knowledge store, and build a Knowledge Graph page component with entity browser, timeline, wake context viewer, and codebase mining status.

**Tech Stack:** TypeScript, Angular 21 (zoneless, signals, standalone components, OnPush), Electron IPC, better-sqlite3, Vitest

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/renderer/app/features/knowledge/knowledge-page.component.ts` | Knowledge Graph page — entity browser, timeline, wake context, mining status |
| `src/renderer/app/core/state/knowledge.store.ts` | Signal-based store for KG entities, facts, wake context, mining events |

### Modified files
| File | What changes |
|------|-------------|
| `src/main/memory/wake-context-builder.ts` | Add wing/room filtering to `generateL1()` + cache keyed by wing |
| `src/main/memory/conversation-miner.ts` | Use `session://<id>/terminate` vs `session://<id>/hibernate` to avoid dedup collision |
| `src/main/instance/instance-lifecycle.ts` | Update sourceFile strings for terminate vs hibernate |
| `src/main/memory/codebase-miner.ts` | Add `getStatus(dirPath)` method |
| `src/main/ipc/handlers/knowledge-graph-handlers.ts` | Add `CODEBASE_GET_STATUS` handler |
| `src/preload/domains/memory.preload.ts` | Add 5 event listeners for knowledge events |
| `src/renderer/app/core/services/ipc/memory-ipc.service.ts` | Add KG, wake, codebase, and event listener methods |
| `src/renderer/app/features/dashboard/sidebar-nav.component.ts` | Add "Knowledge Graph" nav item |
| `src/renderer/app/app.routes.ts` | Add `/knowledge` route |
| `src/tests/unit/memory/wake-context-builder.test.ts` | Add wing-filtering tests |

---

## Task 1: Fix Wake Context Wing Filtering

`generateL1()` fetches ALL hints regardless of wing/room context. Different projects get mixed wake context. The cache is also not keyed by wing.

**Files:**
- Modify: `src/main/memory/wake-context-builder.ts`
- Modify: `src/tests/unit/memory/wake-context-builder.test.ts`

- [ ] **Step 1: Read the current generateL1 and generateWakeContext methods**

Read `src/main/memory/wake-context-builder.ts` lines 140-253 to understand the current flow. Key issues:
- `generateL1()` at line 143 queries ALL hints with no WHERE clause
- `generateWakeContext(wing?)` at line 218 passes `wing` to the context object but never to `generateL1()`
- Cache at line 221 is a single cached context, not keyed by wing

- [ ] **Step 2: Add wing-filtering tests**

In `src/tests/unit/memory/wake-context-builder.test.ts`, add these tests inside the existing `describe` block:

```typescript
  describe('wing filtering', () => {
    it('should filter hints by room when wing is provided', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('React is great', { importance: 8, room: 'frontend-project' });
      builder.addHint('Rust is fast', { importance: 8, room: 'backend-project' });
      builder.addHint('General tip', { importance: 8, room: 'general' });

      const ctx = builder.generateWakeContext('frontend-project');
      expect(ctx.essentialStory.content).toContain('React is great');
      expect(ctx.essentialStory.content).toContain('General tip');
      expect(ctx.essentialStory.content).not.toContain('Rust is fast');
    });

    it('should return all hints when no wing is provided', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('Hint A', { importance: 8, room: 'project-a' });
      builder.addHint('Hint B', { importance: 8, room: 'project-b' });

      const ctx = builder.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('Hint A');
      expect(ctx.essentialStory.content).toContain('Hint B');
    });

    it('should cache separately for different wings', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('Only in alpha', { importance: 9, room: 'alpha' });
      builder.addHint('Only in beta', { importance: 9, room: 'beta' });

      const ctxAlpha = builder.generateWakeContext('alpha');
      const ctxBeta = builder.generateWakeContext('beta');

      expect(ctxAlpha.essentialStory.content).toContain('Only in alpha');
      expect(ctxAlpha.essentialStory.content).not.toContain('Only in beta');
      expect(ctxBeta.essentialStory.content).toContain('Only in beta');
      expect(ctxBeta.essentialStory.content).not.toContain('Only in alpha');
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/tests/unit/memory/wake-context-builder.test.ts`
Expected: 3 new tests FAIL (wing filtering not implemented)

- [ ] **Step 4: Update generateL1 to accept and use wing parameter**

In `src/main/memory/wake-context-builder.ts`, change `generateL1()` signature and query:

Replace:
```typescript
  private generateL1(): ContextLayer {
    // Fetch top hints by importance
    const limit = this.config.l1MaxHints;
    const rows = this.db.prepare(`
      SELECT * FROM wake_hints
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(limit) as WakeHintRow[];
```

With:
```typescript
  private generateL1(wing?: string): ContextLayer {
    // Fetch top hints by importance, optionally filtered by wing (room match or 'general')
    const limit = this.config.l1MaxHints;
    const rows = wing
      ? this.db.prepare(`
          SELECT * FROM wake_hints
          WHERE room = ? OR room = 'general'
          ORDER BY importance DESC, created_at DESC
          LIMIT ?
        `).all(wing, limit) as WakeHintRow[]
      : this.db.prepare(`
          SELECT * FROM wake_hints
          ORDER BY importance DESC, created_at DESC
          LIMIT ?
        `).all(limit) as WakeHintRow[];
```

- [ ] **Step 5: Update generateWakeContext to pass wing to generateL1 and use wing-keyed cache**

Replace the cache and generation logic in `generateWakeContext`:

Replace:
```typescript
  generateWakeContext(wing?: string): WakeContext {
    // Check cache
    const now = Date.now();
    if (this.cachedContext && (now - this.cacheGeneratedAt) < this.config.regenerateIntervalMs) {
      return this.cachedContext;
    }

    const identity = this.generateL0();
    const essentialStory = this.generateL1();

    const ctx: WakeContext = {
      identity,
      essentialStory,
      totalTokens: identity.tokenEstimate + essentialStory.tokenEstimate,
      wing,
      generatedAt: now,
    };

    this.cachedContext = ctx;
    this.cacheGeneratedAt = now;
```

With:
```typescript
  generateWakeContext(wing?: string): WakeContext {
    // Check cache (keyed by wing to avoid cross-project contamination)
    const now = Date.now();
    const cacheKey = wing ?? '__global__';
    const cached = this.contextCache.get(cacheKey);
    if (cached && (now - cached.generatedAt) < this.config.regenerateIntervalMs) {
      return cached;
    }

    const identity = this.generateL0();
    const essentialStory = this.generateL1(wing);

    const ctx: WakeContext = {
      identity,
      essentialStory,
      totalTokens: identity.tokenEstimate + essentialStory.tokenEstimate,
      wing,
      generatedAt: now,
    };

    this.contextCache.set(cacheKey, ctx);
```

- [ ] **Step 6: Replace the single-value cache with a Map**

In the class properties area, replace:
```typescript
  private cachedContext: WakeContext | null = null;
  private cacheGeneratedAt = 0;
```

With:
```typescript
  private contextCache = new Map<string, WakeContext>();
```

Also update `invalidateCache()` to clear the map:

Replace:
```typescript
  private invalidateCache(): void {
    this.cachedContext = null;
    this.cacheGeneratedAt = 0;
  }
```

With:
```typescript
  private invalidateCache(): void {
    this.contextCache.clear();
  }
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/tests/unit/memory/wake-context-builder.test.ts`
Expected: All pass (11 original + 3 new = 14 tests)

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/main/memory/wake-context-builder.ts src/tests/unit/memory/wake-context-builder.test.ts
git commit -m "fix(wake): filter hints by wing/room and cache per-wing to prevent cross-project contamination"
```

---

## Task 2: Fix Duplicate Mining on Hibernate Then Terminate

Both `terminateInstance` and `hibernateInstance` use `session://<id>` as the source file. If an instance is hibernated and later terminated, the second import silently fails because `recordImport` checks for duplicate file paths.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Read the mining blocks**

Read `src/main/instance/instance-lifecycle.ts`:
- Lines 1270-1296: terminate mining block (uses `session://${instance.id}`)
- Lines 1418-1441: hibernate mining block (uses `session://${instanceId}`)

- [ ] **Step 2: Update the sourceFile in terminate mining**

In `src/main/instance/instance-lifecycle.ts`, in the terminate mining block (around line 1280), change:

```typescript
            const sourceFile = `session://${instance.id}`;
```

To:

```typescript
            const sourceFile = `session://${instance.id}/terminate`;
```

- [ ] **Step 3: Update the sourceFile in hibernate mining**

In `src/main/instance/instance-lifecycle.ts`, in the hibernate mining block (around line 1428), change:

```typescript
            const sourceFile = `session://${instanceId}`;
```

To:

```typescript
            const sourceFile = `session://${instanceId}/hibernate`;
```

This ensures terminate and hibernate mine into separate verbatim import records, preventing the dedup check from silently skipping the second mining pass.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "fix(lifecycle): use distinct sourceFile paths for terminate vs hibernate mining"
```

---

## Task 3: Fix CODEBASE_GET_STATUS Dead Endpoint

The `CODEBASE_GET_STATUS` channel has a contract, schema, and preload bridge, but no `ipcMain.handle` and no `CodebaseMiner` method to call.

**Files:**
- Modify: `src/main/memory/codebase-miner.ts`
- Modify: `src/main/ipc/handlers/knowledge-graph-handlers.ts`

- [ ] **Step 1: Add getStatus method to CodebaseMiner**

In `src/main/memory/codebase-miner.ts`, before the closing `}` of the class (before `export function getCodebaseMiner`), add:

```typescript
  /**
   * Check whether a directory has been mined in this session.
   */
  getStatus(dirPath: string): { mined: boolean; normalizedPath: string } {
    const normalizedDir = path.resolve(dirPath);
    return {
      mined: this.minedDirectories.has(normalizedDir),
      normalizedPath: normalizedDir,
    };
  }
```

- [ ] **Step 2: Add IPC handler for CODEBASE_GET_STATUS**

In `src/main/ipc/handlers/knowledge-graph-handlers.ts`, after the `CODEBASE_MINE_DIRECTORY` handler and before the `logger.info(...)` line, add:

```typescript
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_GET_STATUS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const data = CodebaseMineDirectoryPayloadSchema.parse(payload);
        const status = getCodebaseMiner().getStatus(data.dirPath);
        return { success: true, data: status };
      } catch (error) {
        logger.error('CODEBASE_GET_STATUS failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
```

Note: Reuses `CodebaseMineDirectoryPayloadSchema` since both endpoints take `{ dirPath: string }`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/memory/codebase-miner.ts src/main/ipc/handlers/knowledge-graph-handlers.ts
git commit -m "fix: implement CODEBASE_GET_STATUS handler and CodebaseMiner.getStatus()"
```

---

## Task 4: Add Preload Event Listeners for Knowledge Events

The 5 knowledge events are forwarded via `webContents.send()` but the preload only has `invoke()` methods — no `on()` listeners. The renderer can't consume them.

**Files:**
- Modify: `src/preload/domains/memory.preload.ts`

- [ ] **Step 1: Read the existing event listener pattern**

Read `src/preload/domains/memory.preload.ts` lines 34-62 to see the `onMemoryStatsUpdate` / `onMemoryWarning` / `onMemoryCritical` pattern.

- [ ] **Step 2: Add 5 knowledge event listeners**

In `src/preload/domains/memory.preload.ts`, after the `codebaseGetStatus` invoke method (line 636) and before the closing `};` (line 637), add:

```typescript

    // ============================================
    // Knowledge Event Listeners (main → renderer)
    // ============================================

    onKgFactAdded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.KG_EVENT_FACT_ADDED, handler);
      return () => ipcRenderer.removeListener(ch.KG_EVENT_FACT_ADDED, handler);
    },

    onKgFactInvalidated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.KG_EVENT_FACT_INVALIDATED, handler);
      return () => ipcRenderer.removeListener(ch.KG_EVENT_FACT_INVALIDATED, handler);
    },

    onConvoImportComplete: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.CONVO_EVENT_IMPORT_COMPLETE, handler);
      return () => ipcRenderer.removeListener(ch.CONVO_EVENT_IMPORT_COMPLETE, handler);
    },

    onWakeHintAdded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.WAKE_EVENT_HINT_ADDED, handler);
      return () => ipcRenderer.removeListener(ch.WAKE_EVENT_HINT_ADDED, handler);
    },

    onWakeContextGenerated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.WAKE_EVENT_CONTEXT_GENERATED, handler);
      return () => ipcRenderer.removeListener(ch.WAKE_EVENT_CONTEXT_GENERATED, handler);
    },
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/preload/domains/memory.preload.ts
git commit -m "fix(preload): add event listeners for knowledge graph, mining, and wake events"
```

---

## Task 5: Extend Memory IPC Service with Knowledge Methods

The Angular `MemoryIpcService` needs methods for all KG/wake/codebase operations and event subscriptions.

**Files:**
- Modify: `src/renderer/app/core/services/ipc/memory-ipc.service.ts`

- [ ] **Step 1: Read the end of the memory IPC service**

Read `src/renderer/app/core/services/ipc/memory-ipc.service.ts` lines 485-511 to see where new methods go.

- [ ] **Step 2: Add KG, wake, codebase invoke methods and event listeners**

In `src/renderer/app/core/services/ipc/memory-ipc.service.ts`, after the `onMemoryCritical` method (line 508) and before the closing `}` of the class (line 510), add:

```typescript

  // ============================================
  // Knowledge Graph
  // ============================================

  async kgAddFact(payload: { subject: string; predicate: string; object: string; confidence?: number; sourceFile?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgAddFact(payload);
  }

  async kgInvalidateFact(payload: { subject: string; predicate: string; object?: string; ended?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgInvalidateFact(payload);
  }

  async kgQueryEntity(payload: { entityName: string; direction?: string; asOf?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgQueryEntity(payload);
  }

  async kgQueryRelationship(payload: { predicate: string; asOf?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgQueryRelationship(payload);
  }

  async kgGetTimeline(payload: { entityName: string; limit?: number }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgGetTimeline(payload);
  }

  async kgGetStats(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgGetStats();
  }

  async kgAddEntity(payload: { name: string; type: string; properties?: Record<string, unknown> }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgAddEntity(payload);
  }

  // ============================================
  // Wake Context
  // ============================================

  async wakeGenerate(payload: { wing?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeGenerate(payload);
  }

  async wakeGetText(payload: { wing?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeGetText(payload);
  }

  async wakeAddHint(payload: { content: string; importance?: number; room?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeAddHint(payload);
  }

  async wakeRemoveHint(payload: { id: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeRemoveHint(payload);
  }

  async wakeSetIdentity(payload: { text: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeSetIdentity(payload);
  }

  // ============================================
  // Codebase Mining
  // ============================================

  async codebaseMineDirectory(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebaseMineDirectory(payload);
  }

  async codebaseGetStatus(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebaseGetStatus(payload);
  }

  // ============================================
  // Conversation Mining
  // ============================================

  async convoImportFile(payload: { filePath: string; wing: string; format?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.convoImportFile(payload);
  }

  async convoImportString(payload: { content: string; wing: string; sourceFile: string; format?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.convoImportString(payload);
  }

  async convoDetectFormat(payload: { content: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.convoDetectFormat(payload);
  }

  // ============================================
  // Knowledge Event Listeners
  // ============================================

  onKgFactAdded(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onKgFactAdded(callback);
  }

  onKgFactInvalidated(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onKgFactInvalidated(callback);
  }

  onConvoImportComplete(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onConvoImportComplete(callback);
  }

  onWakeHintAdded(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onWakeHintAdded(callback);
  }

  onWakeContextGenerated(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onWakeContextGenerated(callback);
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/core/services/ipc/memory-ipc.service.ts
git commit -m "feat(renderer): add KG, wake, codebase, and mining methods to MemoryIpcService"
```

---

## Task 6: Knowledge Store (Signal-Based State)

Create a signal-based store that manages KG state and subscribes to live events.

**Files:**
- Create: `src/renderer/app/core/state/knowledge.store.ts`

- [ ] **Step 1: Create the knowledge store**

Create `src/renderer/app/core/state/knowledge.store.ts`:

```typescript
import { Injectable, inject, signal, computed, OnDestroy } from '@angular/core';
import { MemoryIpcService } from '../services/ipc/memory-ipc.service';

interface KgStats {
  entities: number;
  triples: number;
  expiredFacts: number;
}

interface KgFact {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sourceFile?: string;
}

interface TimelineEntry {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  createdAt?: number;
}

interface WakeContextView {
  totalTokens: number;
  identity: string;
  essentialStory: string;
  wing?: string;
}

interface MiningStatus {
  mined: boolean;
  normalizedPath: string;
}

@Injectable({ providedIn: 'root' })
export class KnowledgeStore implements OnDestroy {
  private memoryIpc = inject(MemoryIpcService);
  private unsubscribes: (() => void)[] = [];

  // --- KG State ---
  private _stats = signal<KgStats | null>(null);
  private _entityFacts = signal<KgFact[]>([]);
  private _timeline = signal<TimelineEntry[]>([]);
  private _selectedEntity = signal<string>('');
  private _recentFacts = signal<KgFact[]>([]);

  // --- Wake State ---
  private _wakeContext = signal<WakeContextView | null>(null);

  // --- Mining State ---
  private _miningStatus = signal<MiningStatus | null>(null);
  private _importEvents = signal<Array<{ sourceFile: string; segmentsCreated: number; format: string }>>([]);

  // --- UI State ---
  private _loading = signal(false);
  private _error = signal<string | null>(null);

  // --- Public Readonly ---
  readonly stats = this._stats.asReadonly();
  readonly entityFacts = this._entityFacts.asReadonly();
  readonly timeline = this._timeline.asReadonly();
  readonly selectedEntity = this._selectedEntity.asReadonly();
  readonly recentFacts = this._recentFacts.asReadonly();
  readonly wakeContext = this._wakeContext.asReadonly();
  readonly miningStatus = this._miningStatus.asReadonly();
  readonly importEvents = this._importEvents.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  // --- Computed ---
  readonly hasKnowledge = computed(() => {
    const s = this._stats();
    return s !== null && (s.entities > 0 || s.triples > 0);
  });

  readonly factCount = computed(() => this._stats()?.triples ?? 0);
  readonly entityCount = computed(() => this._stats()?.entities ?? 0);

  constructor() {
    this.subscribeToEvents();
  }

  ngOnDestroy(): void {
    for (const unsub of this.unsubscribes) {
      unsub();
    }
  }

  private subscribeToEvents(): void {
    this.unsubscribes.push(
      this.memoryIpc.onKgFactAdded((data) => {
        const facts = this._recentFacts();
        this._recentFacts.set([data as KgFact, ...facts].slice(0, 50));
        // Refresh stats on new fact
        void this.loadStats();
      }),
    );

    this.unsubscribes.push(
      this.memoryIpc.onKgFactInvalidated(() => {
        void this.loadStats();
      }),
    );

    this.unsubscribes.push(
      this.memoryIpc.onConvoImportComplete((data) => {
        const event = data as { sourceFile: string; segmentsCreated: number; format: string };
        const events = this._importEvents();
        this._importEvents.set([event, ...events].slice(0, 20));
      }),
    );

    this.unsubscribes.push(
      this.memoryIpc.onWakeHintAdded(() => {
        // Refresh wake context when a new hint is added
        void this.loadWakeContext();
      }),
    );

    this.unsubscribes.push(
      this.memoryIpc.onWakeContextGenerated((data) => {
        const ctx = data as { totalTokens: number; wing?: string };
        const current = this._wakeContext();
        if (current) {
          this._wakeContext.set({ ...current, totalTokens: ctx.totalTokens, wing: ctx.wing });
        }
      }),
    );
  }

  // --- Actions ---

  async loadStats(): Promise<void> {
    const res = await this.memoryIpc.kgGetStats();
    if (res.success) {
      this._stats.set(res.data as KgStats);
    }
  }

  async queryEntity(entityName: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this._selectedEntity.set(entityName);
    try {
      const res = await this.memoryIpc.kgQueryEntity({ entityName });
      if (res.success) {
        this._entityFacts.set(res.data as KgFact[]);
      } else {
        this._error.set(res.error?.message ?? 'Query failed');
      }
    } finally {
      this._loading.set(false);
    }
  }

  async loadTimeline(entityName: string, limit = 50): Promise<void> {
    const res = await this.memoryIpc.kgGetTimeline({ entityName, limit });
    if (res.success) {
      this._timeline.set(res.data as TimelineEntry[]);
    }
  }

  async loadWakeContext(wing?: string): Promise<void> {
    const res = await this.memoryIpc.wakeGenerate({ wing });
    if (res.success) {
      const data = res.data as { identity: { content: string }; essentialStory: { content: string }; totalTokens: number; wing?: string };
      this._wakeContext.set({
        totalTokens: data.totalTokens,
        identity: data.identity.content,
        essentialStory: data.essentialStory.content,
        wing: data.wing,
      });
    }
  }

  async checkMiningStatus(dirPath: string): Promise<void> {
    const res = await this.memoryIpc.codebaseGetStatus({ dirPath });
    if (res.success) {
      this._miningStatus.set(res.data as MiningStatus);
    }
  }

  async triggerMining(dirPath: string): Promise<void> {
    this._loading.set(true);
    try {
      const res = await this.memoryIpc.codebaseMineDirectory({ dirPath });
      if (res.success) {
        void this.loadStats();
        void this.checkMiningStatus(dirPath);
      } else {
        this._error.set(res.error?.message ?? 'Mining failed');
      }
    } finally {
      this._loading.set(false);
    }
  }

  clearError(): void {
    this._error.set(null);
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/state/knowledge.store.ts
git commit -m "feat(renderer): add KnowledgeStore — signal-based state for KG, wake, and mining"
```

---

## Task 7: Knowledge Graph Page Component

Build the full Angular UI for the knowledge graph, wake context viewer, and codebase mining status.

**Files:**
- Create: `src/renderer/app/features/knowledge/knowledge-page.component.ts`
- Modify: `src/renderer/app/app.routes.ts`
- Modify: `src/renderer/app/features/dashboard/sidebar-nav.component.ts`

- [ ] **Step 1: Create the knowledge page component**

Create `src/renderer/app/features/knowledge/knowledge-page.component.ts`:

```typescript
import {
  Component,
  ChangeDetectionStrategy,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { KnowledgeStore } from '../../core/state/knowledge.store';

@Component({
  selector: 'app-knowledge-page',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="page">
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">&#x2190; Back</button>
        <div class="header-title">
          <span class="title">Knowledge Graph</span>
          <span class="subtitle">Entities, facts, wake context, and codebase intelligence</span>
        </div>
      </div>

      @if (store.error(); as err) {
        <div class="error-banner">{{ err }}
          <button class="btn-dismiss" type="button" (click)="store.clearError()">&#x2715;</button>
        </div>
      }

      <div class="toolbar">
        <label class="field field-wide">
          <span class="label">Query Entity</span>
          <input
            class="input"
            type="text"
            [value]="entityQuery()"
            placeholder="e.g. my_project, Alice, TypeScript"
            (input)="onEntityQueryInput($event)"
            (keyup.enter)="queryEntity()"
          />
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="store.loading()" (click)="queryEntity()">Search</button>
          <button class="btn" type="button" [disabled]="store.loading()" (click)="refresh()">Refresh Stats</button>
        </div>
      </div>

      <div class="content">
        <div class="main-panel">
          <!-- Entity Facts -->
          <div class="panel-card full-width">
            <div class="panel-title">
              @if (store.selectedEntity(); as entity) {
                Facts for &ldquo;{{ entity }}&rdquo;
              } @else {
                Entity Facts
              }
            </div>

            @if (store.loading()) {
              <div class="hint">Loading...</div>
            } @else if (store.entityFacts().length > 0) {
              <table class="fact-table">
                <thead>
                  <tr>
                    <th>Subject</th>
                    <th>Predicate</th>
                    <th>Object</th>
                    <th>Confidence</th>
                    <th>Valid</th>
                  </tr>
                </thead>
                <tbody>
                  @for (fact of store.entityFacts(); track $index) {
                    <tr>
                      <td class="mono">{{ fact.subject }}</td>
                      <td class="mono predicate">{{ fact.predicate }}</td>
                      <td>{{ fact.object }}</td>
                      <td class="num">{{ fact.confidence != null ? (fact.confidence * 100).toFixed(0) + '%' : '-' }}</td>
                      <td class="muted">
                        @if (fact.validFrom) {
                          {{ fact.validFrom }}
                        }
                        @if (fact.validTo) {
                          &ndash; {{ fact.validTo }}
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <div class="hint">Search for an entity to see its facts.</div>
            }
          </div>

          <!-- Timeline -->
          @if (store.timeline().length > 0) {
            <div class="panel-card full-width">
              <div class="panel-title">Timeline for &ldquo;{{ store.selectedEntity() }}&rdquo;</div>
              <div class="timeline">
                @for (entry of store.timeline(); track $index) {
                  <div class="timeline-entry">
                    <span class="timeline-dot"></span>
                    <span class="mono">{{ entry.predicate }}</span>
                    <span>&rarr; {{ entry.object }}</span>
                    @if (entry.validFrom) {
                      <span class="muted">({{ entry.validFrom }})</span>
                    }
                  </div>
                }
              </div>
            </div>
          }

          <!-- Recent Facts (live feed) -->
          @if (store.recentFacts().length > 0) {
            <div class="panel-card full-width">
              <div class="panel-title">Recent Facts (Live)</div>
              <ul class="list">
                @for (fact of store.recentFacts(); track $index) {
                  <li>
                    <span class="mono">{{ fact.subject }}</span>
                    <span class="predicate">{{ fact.predicate }}</span>
                    <span>{{ fact.object }}</span>
                  </li>
                }
              </ul>
            </div>
          }
        </div>

        <div class="side-panel">
          <!-- KG Stats -->
          <div class="panel-card">
            <div class="panel-title">Graph Stats</div>
            @if (store.stats(); as s) {
              <div class="stat-row"><span>Entities</span><span class="num">{{ s.entities }}</span></div>
              <div class="stat-row"><span>Facts (triples)</span><span class="num">{{ s.triples }}</span></div>
              <div class="stat-row"><span>Expired facts</span><span class="num">{{ s.expiredFacts }}</span></div>
            } @else {
              <div class="hint">Loading stats...</div>
            }
          </div>

          <!-- Wake Context -->
          <div class="panel-card">
            <div class="panel-title">Wake Context (Cold-Start)</div>
            @if (store.wakeContext(); as ctx) {
              <div class="stat-row"><span>Tokens</span><span class="num">~{{ ctx.totalTokens }}</span></div>
              @if (ctx.wing) {
                <div class="stat-row"><span>Wing</span><span>{{ ctx.wing }}</span></div>
              }
              <details class="wake-details">
                <summary>L0 Identity</summary>
                <pre class="wake-text">{{ ctx.identity }}</pre>
              </details>
              <details class="wake-details">
                <summary>L1 Essential Story</summary>
                <pre class="wake-text">{{ ctx.essentialStory }}</pre>
              </details>
            } @else {
              <div class="hint">No wake context generated yet.</div>
            }
          </div>

          <!-- Mining Status -->
          <div class="panel-card">
            <div class="panel-title">Codebase Mining</div>
            @if (store.miningStatus(); as ms) {
              <div class="stat-row">
                <span>Status</span>
                <span [class]="ms.mined ? 'badge-success' : 'badge-pending'">
                  {{ ms.mined ? 'Mined' : 'Pending' }}
                </span>
              </div>
              <div class="stat-row"><span>Path</span><span class="mono small">{{ ms.normalizedPath }}</span></div>
            } @else {
              <div class="hint">No mining status available.</div>
            }
            <div class="mine-actions">
              <label class="field">
                <span class="label">Directory</span>
                <input
                  class="input"
                  type="text"
                  [value]="mineDir()"
                  placeholder="/path/to/project"
                  (input)="onMineDirInput($event)"
                />
              </label>
              <button class="btn" type="button" [disabled]="store.loading() || !mineDir()" (click)="triggerMine()">Mine</button>
            </div>
          </div>

          <!-- Import Events -->
          @if (store.importEvents().length > 0) {
            <div class="panel-card">
              <div class="panel-title">Recent Imports</div>
              <ul class="list compact">
                @for (evt of store.importEvents(); track $index) {
                  <li>
                    <span class="mono small">{{ evt.sourceFile }}</span>
                    <span class="muted">{{ evt.segmentsCreated }} segments ({{ evt.format }})</span>
                  </li>
                }
              </ul>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; width: 100%; height: 100%; }

    .page {
      width: 100%; height: 100%;
      display: flex; flex-direction: column; gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary); color: var(--text-primary);
      overflow-y: auto;
    }

    .page-header { display: flex; align-items: center; gap: var(--spacing-md); }
    .header-title { display: flex; flex-direction: column; }
    .title { font-size: 18px; font-weight: 700; }
    .subtitle { font-size: 12px; color: var(--text-muted); }

    .toolbar {
      display: flex; gap: var(--spacing-sm); align-items: end;
      padding: var(--spacing-md); border-radius: var(--radius-md);
      border: 1px solid var(--border-color); background: var(--bg-secondary);
    }
    .field { display: flex; flex-direction: column; gap: var(--spacing-xs); }
    .field-wide { flex: 1; }
    .label { font-size: 11px; color: var(--text-muted); }
    .input {
      width: 100%; border-radius: var(--radius-sm);
      border: 1px solid var(--border-color); background: var(--bg-primary);
      color: var(--text-primary); padding: var(--spacing-xs) var(--spacing-sm); font-size: 12px;
    }

    .actions { display: flex; gap: var(--spacing-xs); }
    .header-btn, .btn {
      border-radius: var(--radius-sm); border: 1px solid var(--border-color);
      background: var(--bg-tertiary); color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm); font-size: 12px; cursor: pointer;
      white-space: nowrap;
    }
    .btn.primary { background: var(--primary-color); border-color: var(--primary-color); color: #fff; }
    .btn:disabled { opacity: 0.6; cursor: not-allowed; }
    .btn-dismiss {
      background: none; border: none; color: inherit; cursor: pointer;
      margin-left: var(--spacing-sm); font-size: 14px;
    }

    .error-banner {
      display: flex; justify-content: space-between; align-items: center;
      padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--radius-sm);
      background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171; font-size: 12px;
    }

    .content { display: grid; grid-template-columns: 1fr 320px; gap: var(--spacing-md); flex: 1; min-height: 0; }
    .main-panel { display: flex; flex-direction: column; gap: var(--spacing-md); overflow-y: auto; }
    .side-panel { display: flex; flex-direction: column; gap: var(--spacing-md); overflow-y: auto; }

    .panel-card {
      padding: var(--spacing-md); border-radius: var(--radius-md);
      border: 1px solid var(--border-color); background: var(--bg-secondary);
    }
    .panel-card.full-width { width: 100%; }
    .panel-title { font-size: 13px; font-weight: 600; margin-bottom: var(--spacing-sm); }

    .stat-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 2px 0; font-size: 12px;
    }

    .hint { font-size: 12px; color: var(--text-muted); font-style: italic; }
    .mono { font-family: var(--font-mono, monospace); font-size: 11px; }
    .small { font-size: 10px; }
    .num { font-variant-numeric: tabular-nums; font-weight: 600; }
    .muted { color: var(--text-muted); font-size: 11px; }
    .predicate { color: var(--primary-color); }

    .fact-table {
      width: 100%; border-collapse: collapse; font-size: 12px;
    }
    .fact-table th {
      text-align: left; font-size: 11px; color: var(--text-muted);
      border-bottom: 1px solid var(--border-color); padding: 4px 8px;
    }
    .fact-table td { padding: 4px 8px; border-bottom: 1px solid var(--border-color); }

    .timeline { display: flex; flex-direction: column; gap: 4px; }
    .timeline-entry { display: flex; align-items: center; gap: var(--spacing-xs); font-size: 12px; }
    .timeline-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--primary-color); flex-shrink: 0;
    }

    .list { list-style: none; padding: 0; margin: 0; }
    .list li {
      display: flex; flex-wrap: wrap; gap: var(--spacing-xs);
      padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--border-color);
    }
    .list.compact li { padding: 2px 0; font-size: 11px; }

    .wake-details { margin-top: var(--spacing-xs); }
    .wake-details summary { font-size: 12px; cursor: pointer; color: var(--primary-color); }
    .wake-text {
      font-size: 11px; white-space: pre-wrap; word-break: break-word;
      max-height: 200px; overflow-y: auto; padding: var(--spacing-sm);
      background: var(--bg-primary); border-radius: var(--radius-sm);
      border: 1px solid var(--border-color); margin-top: var(--spacing-xs);
    }

    .badge-success { color: #4ade80; font-weight: 600; font-size: 11px; }
    .badge-pending { color: var(--text-muted); font-size: 11px; }

    .mine-actions {
      display: flex; gap: var(--spacing-xs); align-items: end;
      margin-top: var(--spacing-sm);
    }
    .mine-actions .field { flex: 1; }
  `],
})
export class KnowledgePageComponent implements OnInit {
  protected store = inject(KnowledgeStore);
  private router = inject(Router);

  protected entityQuery = signal('');
  protected mineDir = signal('');

  async ngOnInit(): Promise<void> {
    await Promise.all([
      this.store.loadStats(),
      this.store.loadWakeContext(),
    ]);
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  onEntityQueryInput(event: Event): void {
    this.entityQuery.set((event.target as HTMLInputElement).value);
  }

  onMineDirInput(event: Event): void {
    this.mineDir.set((event.target as HTMLInputElement).value);
  }

  async queryEntity(): Promise<void> {
    const name = this.entityQuery().trim();
    if (!name) return;
    await Promise.all([
      this.store.queryEntity(name),
      this.store.loadTimeline(name),
    ]);
  }

  async refresh(): Promise<void> {
    await Promise.all([
      this.store.loadStats(),
      this.store.loadWakeContext(),
    ]);
  }

  async triggerMine(): Promise<void> {
    const dir = this.mineDir().trim();
    if (!dir) return;
    await this.store.triggerMining(dir);
  }
}
```

- [ ] **Step 2: Add the route**

In `src/renderer/app/app.routes.ts`, add a new route. Find the observations route block (around line 273-280) and add after it:

```typescript
  {
    path: 'knowledge',
    loadComponent: () =>
      import('./features/knowledge/knowledge-page.component').then(
        (m) => m.KnowledgePageComponent
      ),
  },
```

- [ ] **Step 3: Add sidebar nav item**

In `src/renderer/app/features/dashboard/sidebar-nav.component.ts`, in the `Knowledge` nav group (around line 82), add a new item after the "Learning Database" entry (after line 98) and before the "Training Data" entry:

```typescript
      {
        label: 'Knowledge Graph',
        route: '/knowledge',
        icon: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="7.5"/><line x1="7" y1="8.5" x2="10.5" y2="16"/><line x1="17" y1="8.5" x2="13.5" y2="16"/>'
      },
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/knowledge/knowledge-page.component.ts \
       src/renderer/app/app.routes.ts \
       src/renderer/app/features/dashboard/sidebar-nav.component.ts
git commit -m "feat(renderer): add Knowledge Graph page with entity browser, timeline, wake context, and mining"
```

---

## Task 8: Final Verification

- [ ] **Step 1: Typecheck both configs**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 2: Run all memory tests**

Run: `npx vitest run src/tests/unit/memory/ src/tests/integration/memory/`
Expected: All pass (62+ tests, including 3 new wing-filtering tests)

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: No NEW failures

- [ ] **Step 5: Verify event wiring end-to-end**

Trace each fixed chain:
1. Wake context: `generateL1(wing)` → filters by room matching wing or 'general' → cache keyed by wing
2. Mining dedup: terminate uses `session://<id>/terminate`, hibernate uses `session://<id>/hibernate`
3. CODEBASE_GET_STATUS: channel → handler → `CodebaseMiner.getStatus()` → response
4. Events: main `webContents.send()` → preload `onXxx()` listener → Angular `MemoryIpcService.onXxx()` → `KnowledgeStore` subscription

- [ ] **Step 6: Verify Angular routing**

Confirm:
- `/knowledge` route exists in `app.routes.ts`
- "Knowledge Graph" appears in sidebar nav under "Knowledge" group
- Component lazy-loads correctly

- [ ] **Step 7: Commit if cleanup needed**

```bash
git add -A
git commit -m "chore: final verification — knowledge fixes, gaps, and UI complete"
```

---

## Summary

| Task | Type | What |
|------|------|------|
| 1 | Bug fix | Wake context wing filtering + per-wing cache |
| 2 | Bug fix | Distinct sourceFile for terminate vs hibernate mining |
| 3 | Bug fix | CODEBASE_GET_STATUS handler + CodebaseMiner.getStatus() |
| 4 | Gap | Preload event listeners for 5 knowledge events |
| 5 | Gap | MemoryIpcService KG/wake/codebase/mining methods |
| 6 | Feature | KnowledgeStore (signal-based state) |
| 7 | Feature | Knowledge Graph page component + route + sidebar |
| 8 | Verify | Final verification |
