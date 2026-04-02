# Claude Code Patterns: AI Orchestrator Improvements

**Date:** 2026-04-02  
**Status:** Draft  
**Source:** Comparative analysis of Claude Code source (Actual Claude) vs AI Orchestrator  

## Overview

20 improvements across 5 phases, learned from Claude Code's production patterns. Each improvement includes concrete implementation with file paths, interfaces, and code snippets specific to the AI Orchestrator codebase.

## Implementation Order

| Phase | Theme | Items | Effort | Dependencies |
|-------|-------|-------|--------|-------------|
| **A** | Type Safety & Utilities | 4 items | Small | None |
| **B** | Context & Token Efficiency | 3 items | Medium | None |
| **C** | Reliability & Lifecycle | 4 items | Medium | Phase A (buffered writer) |
| **D** | Architecture & State | 2 items | Large | Phase A (sequential wrapper) |
| **E** | Developer Experience | 7 items | Medium | None |

---

## Phase A: Type Safety & Utilities

### A1. Branded Types for IDs

**Claude Code Pattern:** Uses `type SessionId = string & { readonly __brand: 'SessionId' }` with validation functions like `toAgentId()` to prevent compile-time ID mix-ups.

**Current Gap:** The AI Orchestrator has an excellent prefixed ID generator (`src/shared/utils/id-generator.ts`) producing human-debuggable IDs, but all IDs are typed as plain `string`. With 1,965 occurrences of `instanceId: string` across 130 files and 793 occurrences of `sessionId: string` across 83 files, the compiler can't catch bugs like passing an `instanceId` where a `sessionId` is expected.

**New File: `src/shared/types/branded-ids.ts`**

```typescript
declare const __brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [__brand]: B };

// Core ID types
export type InstanceId = Brand<string, 'InstanceId'>;
export type SessionId  = Brand<string, 'SessionId'>;
export type AgentId    = Brand<string, 'AgentId'>;

// Orchestration ID types
export type DebateId       = Brand<string, 'DebateId'>;
export type VerificationId = Brand<string, 'VerificationId'>;
export type ConsensusId    = Brand<string, 'ConsensusId'>;
export type ReviewId       = Brand<string, 'ReviewId'>;
export type WorktreeId     = Brand<string, 'WorktreeId'>;

// Resource ID types
export type TaskId     = Brand<string, 'TaskId'>;
export type SkillId    = Brand<string, 'SkillId'>;
export type ServerId   = Brand<string, 'ServerId'>;
export type SnapshotId = Brand<string, 'SnapshotId'>;
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type ArtifactId = Brand<string, 'ArtifactId'>;

// Hierarchy ID types
export type SupervisorNodeId = Brand<string, 'SupervisorNodeId'>;
export type WorkerNodeId     = Brand<string, 'WorkerNodeId'>;

// Factory functions (zero-cost casts)
export function toInstanceId(raw: string): InstanceId { return raw as InstanceId; }
export function toSessionId(raw: string): SessionId { return raw as SessionId; }
export function toAgentId(raw: string): AgentId { return raw as AgentId; }
export function toDebateId(raw: string): DebateId { return raw as DebateId; }
export function toVerificationId(raw: string): VerificationId { return raw as VerificationId; }
export function toConsensusId(raw: string): ConsensusId { return raw as ConsensusId; }
export function toReviewId(raw: string): ReviewId { return raw as ReviewId; }
export function toWorktreeId(raw: string): WorktreeId { return raw as WorktreeId; }
export function toTaskId(raw: string): TaskId { return raw as TaskId; }
export function toSkillId(raw: string): SkillId { return raw as SkillId; }
export function toServerId(raw: string): ServerId { return raw as ServerId; }
export function toSnapshotId(raw: string): SnapshotId { return raw as SnapshotId; }
export function toWorkflowId(raw: string): WorkflowId { return raw as WorkflowId; }
export function toArtifactId(raw: string): ArtifactId { return raw as ArtifactId; }
export function toSupervisorNodeId(raw: string): SupervisorNodeId { return raw as SupervisorNodeId; }
export function toWorkerNodeId(raw: string): WorkerNodeId { return raw as WorkerNodeId; }

export type AnyId = InstanceId | SessionId | AgentId | DebateId
  | VerificationId | ConsensusId | ReviewId | WorktreeId
  | TaskId | SkillId | ServerId | SnapshotId | WorkflowId | ArtifactId;
```

**Update `src/shared/utils/id-generator.ts`:** Return branded types from generators.

**Migration Strategy:**
1. Create `branded-ids.ts`, update generators (non-breaking)
2. Update `Instance` interface in `instance.types.ts` — fix downstream compiler errors one domain at a time
3. Add `toInstanceId()` calls at IPC handler boundaries
4. Migrate orchestration types (debate/verification/consensus)

**Priority Migration Files:**
- P0: `src/shared/types/instance.types.ts`, `src/shared/utils/id-generator.ts`
- P1: `src/shared/types/ipc.types.ts`, `src/main/instance/instance-lifecycle.ts`
- P2: `src/shared/types/debate.types.ts`, `src/shared/types/verification.types.ts`
- P3: `src/main/orchestration/*.ts`, `src/main/session/*.ts`

---

### A2. TelemetrySafeError + IPC Error Truncation

**Claude Code Pattern:** `TelemetrySafeError` marker type forces developers to verify errors contain no PII before telemetry logging. `shortErrorStack()` truncates stacks to top N frames (saves 500-2000 tokens per error).

**Current Gap:** AI Orchestrator already has `shortErrorStack()` and `truncateErrorForContext()` in `src/main/util/error-utils.ts` (good!). But: no `TelemetrySafeError` marker type, IPC handlers send raw full stacks, and `ErrorInfo` has no truncation at creation time.

**Add to `src/main/util/error-utils.ts`:**

```typescript
export class TelemetrySafeError extends Error {
  readonly isTelemetrySafe = true as const;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TelemetrySafeError';
  }
  static from(e: unknown, maxFrames = 5): TelemetrySafeError {
    const truncated = shortErrorStack(e, maxFrames);
    const safe = new TelemetrySafeError(e instanceof Error ? e.message : String(e));
    safe.stack = truncated;
    return safe;
  }
}

export function createSafeErrorInfo(error: unknown, code: string): ErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error));
  return { code, message: err.message || 'Unknown error', stack: shortErrorStack(err, 5), timestamp: Date.now() };
}
```

**Integration:** Replace manual `ErrorInfo` construction in IPC handlers with `createSafeErrorInfo()`.

---

### A3. Buffered Writer for I/O Operations

**Claude Code Pattern:** `BufferedWriter` with configurable flush intervals, max buffer size, deferred overflow handling. Coalesces writes and flushes in batches.

**Current Gap:** AI Orchestrator has good write patterns for logging and session continuity, but `fs.writeFileSync` is used in:
- `src/main/persistence/rlm/rlm-content.ts` — blocks event loop on every observation
- `src/main/persistence/snapshot-manager.ts` — blocks on index writes
- `src/main/session/session-archive.ts` — 3x writeFileSync calls

**New File: `src/main/util/buffered-writer.ts`** — Full implementation with:
- Configurable flush interval (default 1s), max buffer size (100), max bytes (1MB)
- Write deduplication (same-path overwrites keep only latest)
- Append coalescing (multiple appends to same file merged)
- Overflow strategy (flush or drop oldest)
- Singleton with `getBufferedWriter()` + `shutdownBufferedWriter()` for app exit

**Integration:** Replace `fs.writeFileSync` in RLM content, snapshot manager, and session archive with `getBufferedWriter().write()`.

---

### A4. Sequential Execution Wrapper

**Claude Code Pattern:** `sequential()` utility (57 lines) wraps any async function to guarantee strictly-ordered execution. Preserves return values and `this` context.

**Current Gap:** AI Orchestrator has `SessionMutex` (per-instance) and `FileLock` (cross-process), but no general-purpose sequential wrapper. Unguarded concurrent paths found in:
- `supervisor-tree.ts` — 3 Maps modified concurrently without locks
- `multi-verify-coordinator.ts` — `activeVerifications` Map concurrent read/write
- `outcome-tracker.ts` — arrays modified during concurrent `recordOutcome()` calls

**New File: `src/main/util/sequential.ts`** — Three utilities:

```typescript
// 1. Wrap any async function for strict sequential execution
export function sequential<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>
): (...args: TArgs) => Promise<TReturn>;

// 2. Per-key sequential execution (generalizes SessionMutex)
export function keyedSequential<TArgs extends [string, ...unknown[]], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options?: { idleCleanupMs?: number }
): (...args: TArgs) => Promise<TReturn>;

// 3. Lightweight mutex for code regions
export function createMutex(): { acquire: () => Promise<() => void>; isLocked: () => boolean; };
```

**Integration:** Wrap `registerInstance`/`unregisterInstance` in SupervisorTree, `recordOutcome` in OutcomeTracker, and verification Map operations in MultiVerifyCoordinator.

---

## Phase B: Context & Token Efficiency

### B1. Tool Output Persistence Thresholds

**Claude Code Pattern:** Per-tool `maxResultSizeChars` — when output exceeds threshold (20K for grep, 100K for web fetch), result saved to disk with preview sent to model. Prevents context window bloat.

**Current Gap:** Large CLI outputs flow directly into conversation context, triggering premature compaction.

**New File: `src/main/context/output-persistence.ts`**
- Configurable per-provider thresholds (default 20K chars)
- Saves large outputs to `~/.orchestrator/output-cache/<hash>.txt`
- Returns truncated preview with `[Full output saved: <path>]` marker
- Retrieval API for when model requests the full output
- Auto-cleanup of old cached outputs (24h TTL)

**Integration:** Hook into CLI adapter output processing before conversation context insertion.

---

### B2. Model-Aware Context Window Auto-Detection

**Claude Code Pattern:** Detects context window size per model at runtime — checks model capability registry, beta headers, feature experiments, `[1m]` suffix.

**Current Gap:** Uses configured constants for context windows. Adding a new model requires a config change.

**New File: `src/main/providers/model-capabilities.ts`**
- Query providers for model capabilities at startup
- Cache per-model specs: context window, max output tokens, thinking budget
- Fallback to configured defaults if detection fails
- Auto-detect from CLI adapter metadata when available

**Integration:** Replace hardcoded context window constants in `src/main/context/` with dynamic lookups from model capabilities.

---

### B3. Hybrid Content Storage (Inline Small / External Large)

**Claude Code Pattern:** History uses hybrid storage — small content (<1KB) inline in JSON, large content gets SHA hash + external file. Fire-and-forget async writes.

**Current Gap:** Session snapshots store everything together. Large conversation histories make snapshots slow.

**New File: `src/main/session/content-store.ts`**
- Size threshold: <1KB inline, >=1KB external
- SHA-256 hash-based deduplication of external content
- Storage at `~/.orchestrator/content-store/<hash>`
- Async external writes (fire-and-forget)
- Lazy resolution on snapshot load

**Integration:** Use in `SessionContinuityManager` for snapshot serialization. Existing snapshots auto-migrate on first load.

---

## Phase C: Reliability & Lifecycle

### C1. Graceful Shutdown Orchestration

**Claude Code Pattern:** ~530 lines: synchronous terminal cleanup (writeSync before async), memoized signal handlers, orphan TTY detection (30s macOS checks), failsafe budget (5s + hooks + 3.5s headroom), resume hint.

**Current Gap:** Existing two-phase shutdown has: no ordered phases (race conditions possible), hard 10s timeout, no orphan detection, no memoized signals, duplicate `getChannelManager().shutdown()` call.

**New File: `src/main/process/graceful-shutdown.ts`** — `GracefulShutdownManager` with:
- Ordered shutdown phases (priority-based): SESSION_SYNC(0) → SIGNAL_CHILDREN(10) → FLUSH_IO(20) → STOP_BACKGROUND(30) → TERMINATE_INSTANCES(40) → FINAL_CLEANUP(50)
- Sync-first execution (guaranteed state saves before async work)
- Adaptive failsafe budget (base + per-hook + headroom)
- Memoized SIGTERM/SIGINT handlers
- Orphan process detection (ppid=1 check every 30s on macOS/Linux)
- Legacy `cleanup-registry.ts` backward compatibility

**Integration:** Replace `cleanupSync()`/`cleanup()`/`before-quit` in `src/main/index.ts` with registered shutdown phases.

---

### C2. Slow Operation Detection

**Claude Code Pattern:** Uses `Symbol.dispose()` to auto-measure operation durations. Configurable thresholds per operation type. Build-time elimination for production.

**Current Gap:** No fine-grained operation timing. Only coarse event loop stall detection (60s interval).

**New File: `src/main/util/slow-operations.ts`** with:
- `measureOp(name)` — returns Disposable for `using` syntax (TS 5.2+)
- `measureAsync(name, fn)` — wraps async operations
- `safeStringify/safeParse/safeClone` — instrumented common operations
- Per-operation thresholds: json.stringify=50ms, context.compact=500ms, embedding.generate=1000ms
- Build-time `__DEV_SLOW_OPS__` flag for production elimination
- `onSlowOperation` callback for telemetry integration

**Integration:** Wrap context compaction, session persistence, and embedding generation. Add `__DEV_SLOW_OPS__` define to build config.

---

### C3. Cron with Anti-Thundering-Herd Jitter

**Claude Code Pattern:** Forward jitter proportional to interval, backward jitter on minute boundaries, missed task detection after suspend, task anchoring with drift correction.

**Current Gap:** No recurring task scheduler. `BackgroundTaskManager` is queue-only. Session auto-save uses raw `setInterval` with no missed-task detection.

**New File: `src/main/tasks/jitter-scheduler.ts`** — `JitterScheduler` with:
- Forward jitter (10% of interval by default)
- Minute-boundary avoidance
- Missed task detection on system resume (with configurable max catch-up)
- Drift-correcting anchor-based scheduling
- System suspend/resume awareness (integrates with Electron power events)
- Event emission: `task:executed`, `task:missed`, `task:error`, `task:unscheduled`

**Integration:** Replace raw `setInterval` in session auto-save. Wire into Electron `powerMonitor` suspend/resume events.

---

### C4. Resume Hint on Exit

**Claude Code Pattern:** Prints `claude --resume <sessionId>` for interactive sessions with persistence enabled.

**Proposed Implementation:**
- On graceful shutdown (final phase), store last session ID to `~/.orchestrator/last-session.json`
- On next app launch, show "Resume last session?" in the UI with session details (timestamp, instance count, working directory)
- Add IPC channel `session:get-last-session` for renderer to query

**Integration:** Add to `GracefulShutdownManager` final phase and app startup sequence.

---

## Phase D: Architecture & State Management

### D1. Immutable Store for Main Process State

**Claude Code Pattern:** Lightweight 30-line store: `getState()`, `setState(updater)`, `subscribe(listener)`. `AppState` is a flat object. `onChangeAppState` observers detect specific field mutations via referential equality.

**Current Gap:** State scattered across 15+ singleton services with EventEmitter communication. `main/index.ts` has 250+ lines of EventEmitter wiring. No single source of truth. Race conditions from overlapping state mutations.

**New Directory: `src/main/state/`**

- `store.ts` — Generic immutable store with re-entrancy guard and same-reference short-circuit
- `app-state.ts` — Unified state shape with `InstanceSlice` per instance + global fields (memory pressure, creation paused, task counts, shutdown flag)
- `selectors.ts` — Pure derivation functions (selectInstance, selectByStatus, selectCanCreate, etc.)
- `observers.ts` — `observeInstances()`, `observeInstanceField()`, `observeGlobal()` + `wireObservers()` to replace 250+ lines of EventEmitter wiring
- `index.ts` — Singleton store + convenience mutators (addInstance, removeInstance, setInstanceState, setGlobalState)

**Key Design Decision:** `InstanceSlice` is a *projection* of the full Instance — only fields that change and are observed. Heavy state (conversation history, session snapshots) stays in dedicated singletons.

**Migration Strategy (4 phases):**
1. Add store alongside existing singletons (shadow EventEmitter events into store)
2. Wire observers, gradually remove duplicate EventEmitter wiring from index.ts
3. Singletons delegate reads to store, writes through store mutators
4. (Optional) Per-instance sub-stores for isolated state

**Risk Mitigations:** Dev-mode assertion that store state matches singleton state during Phase 1. Re-entrancy guard prevents observer cascades.

---

### D2. Narrow DI for Core Execution Loop

**Claude Code Pattern:** Query engine accepts narrow `QueryDeps` interface (~10 focused methods). `productionDeps()` wires real implementations. Tests provide mocks without touching singletons.

**Current Gap:** `InstanceLifecycleManager` has 15+ direct singleton getters. Testing `createInstance()` requires mocking 15+ singletons. Hidden dependencies make the method signature misleading.

**New File: `src/main/instance/instance-deps.ts`** — Narrow capability interfaces:

```typescript
interface AgentDeps { resolveAgent, getAgentById, getDefaultAgent }
interface SettingsDeps { getAll }
interface SupervisionDeps { registerInstance, unregisterInstance }
interface SessionDeps { updateState, createSnapshot, acquireMutex, forceReleaseMutex }
interface PermissionDeps { loadProjectRules }
interface ObservationDeps { buildObservationContext }
interface MemoryDeps { getCurrentPressure, onWarning }
interface HistoryDeps { addThread }
interface HibernationDeps { markHibernated, markAwoken }
interface TitleDeps { maybeGenerateTitle }
interface OutputStorageDeps { store }

interface CoreDeps {
  agents, settings, supervision, session, permissions,
  observation, memory, history, hibernation, title, outputStorage
}
```

**Production wiring in `src/main/instance/instance-manager.ts`:**
```typescript
function productionCoreDeps(): CoreDeps {
  return {
    agents: { resolveAgent: getAgentRegistry().resolve, ... },
    settings: { getAll: getSettingsManager().getAll },
    supervision: { registerInstance: getSupervisorTree().registerInstance, ... },
    // ...
  };
}
```

**Migration:** Extend existing `LifecycleDependencies` to include `CoreDeps`. Replace singleton getters one service at a time. Tests create mock `CoreDeps` without initializing singletons.

---

## Phase E: Developer Experience

### E1. Enhanced Markdown Command Discovery

**Effort:** Small.  
**File:** `src/main/skills/markdown-command-registry.ts` (enhance existing)

Enhance existing `MarkdownCommandRegistry` with:
- Multi-path priority overrides (later sources win over earlier)
- Per-directory caching with 10s TTL (avoid re-reading unchanged SKILL.md files)
- Already ~85% implemented — needs TTL cache and priority merge logic

---

### E2. Feature Gates with Dead Code Elimination

**Effort:** Medium.  
**New File:** `src/main/util/feature-gates.ts`

```typescript
declare const __FEATURES__: Record<string, boolean>;

export function feature(flag: string): boolean {
  return typeof __FEATURES__ !== 'undefined' && __FEATURES__[flag] === true;
}

// Usage: if (feature('LEARNING_SYSTEM')) { ... }
// esbuild define replaces __FEATURES__ at build time → dead code eliminated
```

**Candidate gates:** `LEARNING_SYSTEM`, `DEBATE_SYSTEM`, `BROWSER_AUTOMATION`, `GRPO_TRAINING`, `AB_TESTING`, `REMOTE_OBSERVER`.

**Build integration:** Add `define: { '__FEATURES__': JSON.stringify(features) }` to esbuild config. Production builds disable experimental features for smaller bundles.

---

### E3. Permission Matcher Compilation

**Effort:** Small.  
**File:** `src/main/security/permission-manager.ts` (enhance existing)

```typescript
interface CompiledMatcher {
  test(path: string): boolean;
  ruleHash: string;
}

// Pre-compile once, reuse for all permission checks
function preparePermissionMatcher(rules: PermissionRule[]): CompiledMatcher {
  const hash = hashRules(rules);
  if (matcherCache.has(hash)) return matcherCache.get(hash)!;
  // Compile regex/wildcard patterns into single RegExp
  const compiled = compileRules(rules);
  matcherCache.set(hash, compiled);
  return compiled;
}
```

**Integration:** Call at rule load time (not per-check). Cache invalidated on rule file change.

---

### E4. Tool Concurrency Safety Declarations

**Effort:** Small.  
**File:** `src/shared/types/tool.types.ts` (new interface), integrate into `src/main/mcp/`

```typescript
interface ToolSafetyMetadata {
  isConcurrencySafe: boolean;   // Can run in parallel with other tools
  isReadOnly: boolean;          // No side effects
  isDestructive: boolean;       // Irreversible changes (delete, overwrite)
}
```

**Integration:** Orchestration layer (`src/main/orchestration/`) reads metadata to batch read-only tools in parallel, serialize destructive tools. Extends existing `concurrencySafe` flag already present on some tools.

---

### E5. Priority Message Queue

**Effort:** Medium.  
**New File:** `src/main/routing/priority-queue.ts`

```typescript
type Priority = 'now' | 'next' | 'later';

interface PriorityMessage {
  priority: Priority;
  payload: InterInstanceMessage;
  timestamp: number;
}

class PriorityMessageQueue {
  private queues = new Map<Priority, PriorityMessage[]>();
  
  enqueue(msg: PriorityMessage): void;
  dequeue(): PriorityMessage | undefined;  // Returns highest priority first
  peek(): PriorityMessage | undefined;
}
```

**Integration:** Replace FIFO dispatch in `src/main/routing/message-router.ts`. System commands (`now`), user responses (`next`), background tasks (`later`).

---

### E6. Multi-Layer Settings Cache

**Effort:** Medium.  
**File:** `src/main/core/settings-manager.ts` (enhance existing)

Three cache levels:
1. **Parsed-file cache** — per-file JSON parse results, invalidated on fs change
2. **Per-source cache** — merged settings per source (global, project, instance)
3. **Session-merged cache** — fully merged settings, most expensive to recompute

Single `resetSettingsCache(level?)` invalidation point. Filesystem watcher triggers level-1 invalidation, which cascades up.

---

### E7. EPIPE/Stdin Handling

**Effort:** Small.  
**Files:** `src/main/cli/adapters/*.ts` (enhance existing adapters)

```typescript
// Add to all CLI adapter stream setup
childProcess.stdout?.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    logger.debug('EPIPE on stdout — consumer closed pipe');
    return; // Swallow gracefully
  }
  throw err;
});
```

Already ~85% handled by existing error handling. Needs explicit EPIPE guard in Claude, Gemini, Codex, Copilot adapters. Add stdin pipe detection utility (`isRealPipe()`) for adapters that read from stdin.

---

## Summary

| # | Improvement | Phase | New Files | Effort |
|---|------------|-------|-----------|--------|
| A1 | Branded Types | A | `shared/types/branded-ids.ts` | Small |
| A2 | TelemetrySafeError | A | (extend `error-utils.ts`) | Small |
| A3 | Buffered Writer | A | `main/util/buffered-writer.ts` | Small |
| A4 | Sequential Wrapper | A | `main/util/sequential.ts` | Small |
| B1 | Output Persistence | B | `main/context/output-persistence.ts` | Medium |
| B2 | Model Capabilities | B | `main/providers/model-capabilities.ts` | Medium |
| B3 | Hybrid Content Store | B | `main/session/content-store.ts` | Medium |
| C1 | Graceful Shutdown | C | `main/process/graceful-shutdown.ts` | Medium |
| C2 | Slow Operations | C | `main/util/slow-operations.ts` | Medium |
| C3 | Jitter Scheduler | C | `main/tasks/jitter-scheduler.ts` | Medium |
| C4 | Resume Hint | C | (integrate into shutdown + startup) | Small |
| D1 | Immutable Store | D | `main/state/` (5 files) | Large |
| D2 | Narrow DI | D | `main/instance/instance-deps.ts` | Medium |
| E1 | Command Discovery | E | (enhance existing) | Small |
| E2 | Feature Gates | E | `main/util/feature-gates.ts` | Medium |
| E3 | Permission Matcher | E | (enhance existing) | Small |
| E4 | Tool Concurrency | E | (new interface) | Small |
| E5 | Priority Queue | E | `main/routing/priority-queue.ts` | Medium |
| E6 | Settings Cache | E | (enhance existing) | Medium |
| E7 | EPIPE Handling | E | (enhance adapters) | Small |
