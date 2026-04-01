# Claude Code Hardening — Design Spec

> **Source**: Deep comparison of the Claude Code CLI codebase (`Actual Claude/`) against the AI Orchestrator. Identifies 7 hardening improvements organized into 3 batches by effort and risk.

## Context

The Claude Code CLI demonstrates production-grade hardening patterns that our orchestrator can adopt. Several utilities were already created in a prior audit (cleanup registry, abort controller tree) but never wired in. This spec covers wiring those in plus building the remaining hardening.

## Decisions Made

- **Batch approach** (B): 3 batches grouped by effort, each self-contained and deployable
- **Standalone utilities** (B): No coupling to LogManager/events — pure functions, services wire them in
- **Sibling abort scope** (A): Instance-level only within coordination groups
- **File locking scope** (B): Worktree + shared resources (RLM, sessions, memory files)
- **NDJSON U+2028/U+2029 escaping**: Already implemented in `base-cli-adapter.ts:21-22` — dropped from plan

## Existing Code Inventory

| Utility | File | Status |
|---------|------|--------|
| Cleanup registry | `src/main/util/cleanup-registry.ts` | Built + tested, not wired |
| Abort controller tree | `src/main/util/abort-controller-tree.ts` | Built + tested, not wired |
| NDJSON escaping | `src/main/cli/adapters/base-cli-adapter.ts:21-22` | Done |
| Child error classifier | `src/main/orchestration/child-error-classifier.ts` | Built + tested |
| CLI error handler | `src/main/cli/cli-error-handler.ts` | Built, includes `classifyError()` + `withRetry()` |
| Tool output truncation | `src/main/util/tool-output-truncation.ts` | Built + tested |
| Session mutex | `src/main/session/session-mutex.ts` | Built (in-process only) |

---

## Batch 1: Wire Existing + Small Utilities

**Effort**: Small | **Risk**: Low | **Delivers**: Foundation for Batches 2-3

### 1A. Wire Cleanup Registry into Services + Shutdown

**Files to modify**:
- `src/main/index.ts` — call `runCleanupFunctions()` as first step in `cleanup()`
- 9 singleton services that have `shutdown()`/`stop()` methods

**Design**:
- Each singleton registers itself at construction via `registerCleanup()` from `src/main/util/cleanup-registry.ts`
- `AIOrchestratorApp.cleanup()` calls `runCleanupFunctions()` first, then the existing manual teardown as fallback
- Target services: ResourceGovernor, HibernationManager, PoolManager, CrossModelReviewService, ChannelManager, SessionContinuityManager, StuckProcessDetector, McpManager, LspManager

**Why keep manual cleanup**: Safety net for services that fail to register. The manual list is the existing contract; the registry is additive.

### 1B. Error Utilities

**File to create**: `src/main/util/error-utils.ts`  
**Test file**: `src/main/util/__tests__/error-utils.spec.ts`

Four standalone functions, zero dependencies:

```typescript
/**
 * Truncate error stack to maxFrames. Used when errors flow into
 * orchestration context (debate, verification) to save tokens.
 */
function shortErrorStack(e: unknown, maxFrames?: number): string

/**
 * Detect AbortError from 3 sources: custom class, SDK class, DOMException.name.
 * Works with minified builds where constructor names may be mangled.
 */
function isAbortError(e: unknown): boolean

/**
 * True for ENOENT, EACCES, EPERM, ENOTDIR, ELOOP.
 * Used in session recovery, memory files, skill loading.
 */
function isFsInaccessible(e: unknown): e is NodeJS.ErrnoException

/**
 * Combine shortErrorStack + message truncation for agent context.
 * Returns a bounded string (default 500 chars) suitable for passing
 * between agents in multi-verify, debate, or consensus flows.
 */
function truncateErrorForContext(e: unknown, maxChars?: number): string
```

---

## Batch 2: Medium Effort, High Impact

**Effort**: Medium | **Risk**: Medium | **Delivers**: Resilience and resource efficiency

### 2A. Sync-First Shutdown Sequence

**File to modify**: `src/main/index.ts`

**Design**:
Two-phase shutdown in `before-quit` handler:

1. **Phase 1 — Synchronous** (`cleanupSync()`):
   - `SessionContinuityManager.shutdown()` — already synchronous (`writeFileSync`). Move from async cleanup to here.
   - `BaseCliAdapter.killAllActiveProcesses()` — send SIGTERM synchronously to all tracked processes. Currently the *last* step in async cleanup; moving it here ensures processes are signaled even if async cleanup hangs.

2. **Phase 2 — Async** (existing `cleanup()`):
   - `runCleanupFunctions()` (from Batch 1)
   - Existing manual service teardown
   - `instanceManager.terminateAll()` — thorough graceful shutdown + history archival
   - `BaseCliAdapter.killAllActiveProcesses()` — fallback SIGKILL for anything still alive

**Guarantee**: Session state is saved and processes are signaled even if the async phase hangs or times out.

### 2B. Enhance Error Classification

**Files to modify**:
- `src/main/orchestration/child-error-classifier.ts` — add abort/FS early-exit checks
- `src/shared/types/child-announce.types.ts` — add `'abort'` to `ChildErrorCategory`
- `src/main/orchestration/utils/coordinator-error-handler.ts` — use `shortErrorStack()` for bounded context
- `src/main/cli/adapters/base-cli-adapter.ts` — add `classified` field to error events

**Changes**:

1. `ChildErrorClassifier.classify()`:
   - Check `isAbortError(rawError)` first → return `{ category: 'abort', retryable: false, suggestedAction: 'skip' }`
   - Check `isFsInaccessible(rawError)` second → return `{ category: 'filesystem', retryable: false, suggestedAction: 'escalate_to_user' }`
   - Then fall through to existing regex patterns
   - Add `'abort'` and `'filesystem'` to `ChildErrorCategory` union type

2. `coordinator-error-handler.ts`:
   - Use `truncateErrorForContext()` when passing error information between coordination rounds
   - Prevents multi-KB error strings from bloating debate synthesis or verification results

3. `base-cli-adapter.ts` error events:
   - Emit `{ error: rawString, classified: CliError }` instead of just the raw string
   - Consumers can branch on classification without re-parsing

### 2C. Sibling Abort in Coordination Groups

**Files to modify**:
- `src/main/orchestration/multi-verify-coordinator.ts`
- `src/main/orchestration/debate-coordinator.ts`
- `src/main/orchestration/consensus-coordinator.ts`
- `src/main/orchestration/parallel-worktree-coordinator.ts`

**Design**:
Uses existing `createAbortController()` / `createChildAbortController()` from `abort-controller-tree.ts`.

Per coordinator:
1. Create a parent `AbortController` for the coordination round
2. Each spawned child gets a child controller via `createChildAbortController(parent)`
3. On child error: check classification via `ChildErrorClassifier`
   - **Non-retryable** (auth failure, process crash with exhausted retries) → `parent.abort()` → cascades to all siblings
   - **Retryable** (timeout, rate limit) → do NOT abort siblings
4. Abort signal is passed to instance creation → forwarded to CLI adapter → adapter calls `terminate()` when signal fires

**Parallel worktree coordinator** gets the same pattern: one parent abort controller per worktree batch.

**Key constraint**: Abort only fires on non-retryable errors. This prevents a transient timeout from killing an entire verification round.

---

## Batch 3: Targeted Hardening

**Effort**: Medium | **Risk**: Low-Medium | **Delivers**: Cross-process safety and concurrency control

### 3A. File-Based Cross-Process Locking

**File to create**: `src/main/util/file-lock.ts`  
**Test file**: `src/main/util/__tests__/file-lock.spec.ts`

**API**:

```typescript
interface LockHolder {
  pid: number;
  sessionId: string;
  acquiredAt: number;
  purpose?: string;
}

type LockResult =
  | { kind: 'acquired'; release: () => Promise<void> }
  | { kind: 'blocked'; holder: LockHolder };

/**
 * Acquire an exclusive file lock using O_EXCL atomic creation.
 * Automatically recovers stale locks from dead processes.
 */
function acquireLock(lockPath: string, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<LockResult>

/**
 * Scoped lock — acquire, run fn, release in finally.
 */
function withLock<T>(lockPath: string, fn: () => Promise<T>, options?: {
  purpose?: string;
  timeoutMs?: number;
  retryIntervalMs?: number;
}): Promise<T>
```

**Implementation**:
- Atomic creation: `writeFile(path, JSON.stringify(holder), { flag: 'wx' })`
- On EEXIST: read lock, check `process.kill(holder.pid, 0)` for liveness
- Dead holder: unlink + retry once (handles crash recovery)
- Lost recovery race: return `{ kind: 'blocked' }`
- Release: unlink only if our PID still owns the lock (idempotent)
- Cleanup integration: `acquireLock` calls `registerCleanup()` so locks release on shutdown
- Optional polling: if `timeoutMs` is set, retry every `retryIntervalMs` (default 200ms) until timeout

**Apply to 4 resources**:

| Resource | Lock Path | Purpose |
|----------|-----------|---------|
| Worktree ops | `{worktreePath}/.orchestrator.lock` | Prevent concurrent worktree use |
| RLM database | `{dbPath}.lock` | Protect cross-process writes |
| Session snapshots | `{snapshotPath}.lock` | Prevent concurrent auto-save corruption |
| Memory files | `{memoryFilePath}.lock` | Protect episodic/procedural/semantic writes |

### 3B. Tool Concurrency Safety Classification

**File to create**: `src/main/orchestration/concurrency-classifier.ts`  
**Test file**: `src/main/orchestration/__tests__/concurrency-classifier.spec.ts`

**API**:

```typescript
interface OperationDescriptor {
  type: 'read' | 'write' | 'git' | 'shell' | 'analysis';
  target?: string;  // file path, repo path, or resource identifier
}

type ConcurrencySafety = 'concurrent' | 'exclusive' | 'unknown';

/**
 * Classify a single operation's inherent safety (without overlap context).
 * 'read'/'analysis' → concurrent, 'write'/'git'/'shell' → needs_target_check, unknown → exclusive.
 */
function classifyOperationSafety(operation: OperationDescriptor): ConcurrencySafety

/**
 * Given a set of operations, group them into parallelizable batches.
 * Uses classifyOperationSafety for inherent safety, then checks target
 * overlap for 'needs_target_check' operations. Concurrent ops run together;
 * exclusive ops run alone; unknown → exclusive.
 */
function scheduleOperations(operations: OperationDescriptor[]): OperationDescriptor[][]
```

**Classification rules**:
- `read` + `analysis` → always `concurrent` (no target check needed)
- `write` / `git` / `shell` → `exclusive` if targets overlap with any other write/git/shell operation in the batch, `concurrent` if all targets are provably distinct (different worktrees, different files)
- `unknown` type → `exclusive` (fail-safe)
- Target overlap is determined by `scheduleOperations`, not `classifyOperationSafety` (single operations lack overlap context)

**Integration into coordinators**:
- `multi-verify-coordinator.ts`: Verification is read-only analysis → all concurrent (validates status quo)
- `debate-coordinator.ts`: Debate is analysis → concurrent
- `parallel-worktree-coordinator.ts`: Each child has a distinct worktree target → concurrent (validated by distinct targets)
- `consensus-coordinator.ts`: Voting rounds are concurrent; final synthesis step is exclusive

**Scheduling enforcement**: Coordinators call `scheduleOperations()` before spawning children. Returns batches — each batch runs in parallel, batches run sequentially.

---

## File Map

| Action | File | Batch |
|--------|------|-------|
| Modify | `src/main/index.ts` | 1A, 2A |
| Modify | `src/main/process/resource-governor.ts` | 1A |
| Modify | `src/main/process/hibernation-manager.ts` | 1A |
| Modify | `src/main/process/pool-manager.ts` | 1A |
| Modify | `src/main/orchestration/cross-model-review-service.ts` | 1A |
| Modify | `src/main/channels/channel-manager.ts` | 1A |
| Modify | `src/main/session/session-continuity.ts` | 1A |
| Modify | `src/main/instance/stuck-process-detector.ts` | 1A |
| Modify | `src/main/mcp/mcp-manager.ts` | 1A |
| Modify | `src/main/workspace/lsp-manager.ts` | 1A |
| Create | `src/main/util/error-utils.ts` | 1B |
| Create | `src/main/util/__tests__/error-utils.spec.ts` | 1B |
| Modify | `src/main/orchestration/child-error-classifier.ts` | 2B |
| Modify | `src/shared/types/child-announce.types.ts` | 2B |
| Modify | `src/main/orchestration/utils/coordinator-error-handler.ts` | 2B |
| Modify | `src/main/cli/adapters/base-cli-adapter.ts` | 2B |
| Modify | `src/main/orchestration/multi-verify-coordinator.ts` | 2C |
| Modify | `src/main/orchestration/debate-coordinator.ts` | 2C |
| Modify | `src/main/orchestration/consensus-coordinator.ts` | 2C |
| Modify | `src/main/orchestration/parallel-worktree-coordinator.ts` | 2C |
| Create | `src/main/util/file-lock.ts` | 3A |
| Create | `src/main/util/__tests__/file-lock.spec.ts` | 3A |
| Modify | `src/main/orchestration/parallel-worktree-coordinator.ts` | 3A |
| Modify | `src/main/persistence/rlm-database.ts` | 3A |
| Modify | `src/main/session/session-continuity.ts` | 3A |
| Modify | `src/main/memory/` (episodic/procedural/semantic stores) | 3A |
| Create | `src/main/orchestration/concurrency-classifier.ts` | 3B |
| Create | `src/main/orchestration/__tests__/concurrency-classifier.spec.ts` | 3B |
| Modify | `src/main/orchestration/multi-verify-coordinator.ts` | 3B |
| Modify | `src/main/orchestration/debate-coordinator.ts` | 3B |
| Modify | `src/main/orchestration/consensus-coordinator.ts` | 3B |
| Modify | `src/main/orchestration/parallel-worktree-coordinator.ts` | 3B |

## Testing Strategy

- **Unit tests** for all new utilities (`error-utils`, `file-lock`, `concurrency-classifier`)
- **Existing tests** for cleanup registry and abort controller tree already pass
- **Integration verification**: `npx tsc --noEmit` + `npm run lint` after each batch
- **File lock tests**: Use temp directories, test stale recovery with fake PIDs, test contention with concurrent acquires
- **Sibling abort tests**: Mock coordinator with 3 children, verify abort cascades on fatal error but not on retryable error
