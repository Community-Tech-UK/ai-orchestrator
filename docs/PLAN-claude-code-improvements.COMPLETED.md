# Implementation Plan: Claude Code-Inspired Improvements

**Source of improvements**: Patterns from `/Actual Claude/` (Claude Code CLI source) applied to the Claude Orchestrator.

**Total items**: 10 improvements across 3 priority tiers.

## Implementation Status

| Item | Status |
|------|--------|
| 1.1 Wire ErrorRecoveryManager | ✅ DONE — all 4 coordinators import and call `classifyError()` from ErrorRecoveryManager |
| 1.2 Fix Checkpoint Race Condition | ✅ DONE |
| 1.3 Fix Silent Worktree Cleanup | ✅ DONE |
| 2.1 Coordinator Error Handler Utility | ✅ DONE — utility created and all 4 coordinators now use `handleCoordinatorError()` |
| 2.2 Prefixed ID Generation | ✅ DONE |
| 2.3 Debate Early Termination | ✅ DONE |
| 2.4 Tool Permission Model | ✅ DONE |
| 3.1 Async Generator Pipeline | ✅ DONE |
| 3.2 Lazy Loading Coordinators | ✅ DONE |
| 4.1 Typed Progress Events | ✅ DONE |
| 4.2 Tool Validation Separation | ✅ DONE |

**All items complete.** All coordinators now use `handleCoordinatorError()` from the shared utility.

---

## Phase 1: P0 — Critical Bug Fixes (3 items)

These are low-effort fixes that prevent real bugs (corrupt recovery, resource leaks, silent crashes).

### 1.1 Wire ErrorRecoveryManager into All Coordinators

**Problem**: The orchestrator already has `ErrorRecoveryManager` (`src/main/core/error-recovery.ts`) with `classifyError()`, `retryWithBackoff()`, and 15 error patterns — but **no coordinator uses it**. Each coordinator has ad-hoc error handling:
- `debate-coordinator.ts`: Sets `status = 'cancelled'` on any error, emits `debate:error`
- `consensus-coordinator.ts`: Returns `emptyResult()` on failure
- `parallel-worktree-coordinator.ts`: Silently ignores cleanup errors

**Claude Code pattern**: QueryEngine categorizes errors as `api_retry` (retryable) vs permanent. Tool errors carry `retryAttempt` and `retryInMs` metadata.

**Files to modify**:
1. `src/main/orchestration/debate-coordinator.ts`
   - Import `getErrorRecoveryManager` from `../core/error-recovery`
   - In `runDebate()` catch block (~line 134-190): replace bare `debate.status = 'cancelled'` with `classifyError()` → if recoverable, retry round; if permanent, cancel
   - In round execution methods: wrap `waitForResponses()` with try-catch that classifies individual agent failures
   - Add per-agent error isolation: one agent failure shouldn't cancel the entire debate

2. `src/main/orchestration/consensus-coordinator.ts`
   - Already has good per-provider isolation (`Promise.all` with individual catches)
   - Wire `classifyError()` into the per-provider catch to distinguish transient vs permanent
   - On transient errors: auto-retry that specific provider (up to 2 attempts)
   - On permanent errors: exclude provider and continue with remaining

3. `src/main/orchestration/parallel-worktree-coordinator.ts`
   - Import `getErrorRecoveryManager`
   - In `performMerges()` catch (~line 307-324): classify error → if transient, retry merge; if permanent, mark task failed but **continue remaining merges** (don't halt all)

4. `src/main/orchestration/multi-verify-coordinator.ts`
   - Wire `classifyError()` into agent failure handling
   - Use `retryWithBackoff()` for transient failures instead of custom retry logic

**Verification**: `npx tsc --noEmit && npm run lint && npm test -- --grep "coordinator"`

---

### 1.2 Fix Checkpoint Manager Race Condition

**Problem**: `checkpoint-manager.ts` line 304-350 creates a checkpoint synchronously with an **empty state placeholder**, then patches real state asynchronously via fire-and-forget `.then()`. If the checkpoint is read before the async patch completes, it contains corrupt/empty data.

```typescript
// Line 318-335: Empty placeholder created synchronously
const checkpoint = this.errorRecovery.createCheckpoint(sessionId, type, {
  conversationState: { messages: [], contextUsage: { used: 0, total: 0 }, ... },
  activeTasks: [],
  metadata: { snapshotId: '', description },
});

// Line 339-350: Real state patched asynchronously (fire-and-forget)
this.continuity.createSnapshot(sessionId, ...).then((snapshot) => {
  checkpoint.metadata['snapshotId'] = snapshot.id;
  // Backfill conversation state...
});
```

**Claude Code pattern**: QueryEngine's session storage writes state atomically — no partial writes visible to readers.

**File to modify**: `src/main/session/checkpoint-manager.ts`

**Fix approach**: Make `createCheckpoint` return `Promise<SessionCheckpoint | null>` instead of `SessionCheckpoint | null`. Await the snapshot before returning:

```typescript
async createCheckpoint(
  sessionId: string,
  type: CheckpointType,
  description?: string
): Promise<SessionCheckpoint | null> {
  // Rate-limit check stays the same
  const lastTime = this.lastCheckpointTime.get(sessionId) || 0;
  if (type !== CheckpointType.MANUAL && Date.now() - lastTime < this.config.minCheckpointIntervalMs) {
    return null;
  }

  this.lastCheckpointTime.set(sessionId, Date.now());

  // Create snapshot FIRST, then checkpoint with real data
  const snapshot = await this.continuity.createSnapshot(
    sessionId,
    description || `Checkpoint: ${type}`,
    undefined,
    type === CheckpointType.PERIODIC ? 'auto' : 'checkpoint'
  );

  const checkpoint = this.errorRecovery.createCheckpoint(sessionId, type, {
    conversationState: snapshot?.state?.conversationState ?? {
      messages: [], contextUsage: { used: 0, total: 0 }, lastActivityAt: Date.now(),
    },
    activeTasks: snapshot?.state?.activeTasks ?? [],
    metadata: { snapshotId: snapshot?.id ?? '', description },
  });

  this.emit('checkpoint:created', { checkpoint, sessionId });
  return checkpoint;
}
```

**Callers to update**: Search all callers of `createCheckpoint` — they now need `await`. Key callers:
- `beginTransaction()` (line 221) — make it async or accept null synchronously
- `commitTransaction()` (line 258)
- `rollbackTransaction()` (line 292)

Since `beginTransaction` and `rollbackTransaction` both call `createCheckpoint` for side-effect logging, they can use fire-and-forget on the *new* async version safely — the checkpoint data is complete before it's stored, so even if the caller doesn't await, no reader gets partial data.

**Verification**: `npx tsc --noEmit` (signature change will surface all callers)

---

### 1.3 Fix Silent Worktree Cleanup Failures

**Problem**: `parallel-worktree-coordinator.ts` lines 367-373:
```typescript
} catch {
  // Ignore cleanup errors ← DANGEROUS
}
```
Failed worktree deletions leave orphaned git refs and disk space leaks.

**Claude Code pattern**: Task cleanup is tracked; `isTerminalTaskStatus()` prevents operations on dead tasks; cleanup failures are logged.

**File to modify**: `src/main/orchestration/parallel-worktree-coordinator.ts`

**Fix**:
```typescript
private async cleanup(execution: ParallelExecution): Promise<void> {
  const failures: Array<{ taskId: string; error: string }> = [];

  for (const [taskId, session] of execution.sessions) {
    try {
      await this.worktreeManager.abandonWorktree(session.id);
      this.emit('worktree:cleaned', { executionId: execution.id, taskId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to clean up worktree', { executionId: execution.id, taskId, error: message });
      failures.push({ taskId, error: message });
    }
  }

  if (failures.length > 0) {
    this.emit('worktree:cleanup-partial', {
      executionId: execution.id,
      failures,
      message: `${failures.length} worktree(s) could not be cleaned up`,
    });
  }
}
```

Also: In `performMerges()` (~line 307-324), change the early `return` on merge failure to `continue` so remaining merges still proceed:

```typescript
} catch (error) {
  this.emit('task:merge-failed', { executionId: execution.id, taskId, error: (error as Error).message });
  failedMerges.push(taskId);
  continue; // Don't halt remaining merges
}
// After loop:
if (failedMerges.length > 0) {
  execution.status = 'failed';
}
```

**Verification**: `npx tsc --noEmit && npm run lint`

---

## Phase 2: P1 — High-Value Improvements (4 items)

### 2.1 Categorized Error Types in Coordinator Error Handling

**Problem**: Even after wiring ErrorRecoveryManager (item 1.1), coordinators need a shared helper that returns typed results so callers can pattern-match.

**Claude Code pattern**: Tool errors carry `{ subtype: 'api_retry', retryAttempt, retryInMs }` — callers destructure and branch on subtype.

**Files to create/modify**:

1. **Create** `src/main/orchestration/utils/coordinator-error-handler.ts`:
```typescript
import { getErrorRecoveryManager } from '../../core/error-recovery';
import { ClassifiedError, ErrorCategory } from '../../../shared/types/error-recovery.types';
import { getLogger } from '../../logging/logger';

export interface CoordinatorErrorResult {
  classified: ClassifiedError;
  shouldRetry: boolean;
  retryDelayMs: number;
  shouldFailFast: boolean;
  userMessage: string;
}

export function handleCoordinatorError(
  error: unknown,
  context: { coordinatorName: string; operationName: string; attempt?: number }
): CoordinatorErrorResult {
  const logger = getLogger(context.coordinatorName);
  const recovery = getErrorRecoveryManager();
  const err = error instanceof Error ? error : new Error(String(error));
  const classified = recovery.classifyError(err);

  const shouldRetry = classified.recoverable && (context.attempt ?? 0) < 3;
  const shouldFailFast = classified.category === ErrorCategory.AUTH
    || classified.category === ErrorCategory.PERMANENT;

  logger.warn(`${context.operationName} error classified`, {
    category: classified.category,
    severity: classified.severity,
    recoverable: classified.recoverable,
    attempt: context.attempt,
  });

  return {
    classified,
    shouldRetry,
    retryDelayMs: classified.retryAfterMs ?? 5000,
    shouldFailFast,
    userMessage: classified.userMessage,
  };
}
```

2. **Update** all 4 coordinators to use `handleCoordinatorError()` in their catch blocks.

**Verification**: `npx tsc --noEmit && npm run lint`

---

### 2.2 Cryptographic Type-Prefixed ID Generation

**Problem**: Current `generateId()` in `src/shared/utils/id-generator.ts` returns plain UUID v4 (`crypto.randomUUID()`). IDs give no information about what they represent, making debugging harder.

**Claude Code pattern**: Task IDs use type prefixes + cryptographic randomness (`b` + 8 random chars from 36-char alphabet = 2.8 trillion combinations). IDs are human-debuggable: `b8f3k2m1` = bash task, `a4j7n9x2` = agent task.

**File to modify**: `src/shared/utils/id-generator.ts`

**Add new function** (keep existing `generateId()` for backward compatibility):

```typescript
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Generate a type-prefixed ID with cryptographic randomness.
 * Format: prefix + 8 random chars from [0-9a-z] (36^8 ≈ 2.8T combinations)
 */
export function generatePrefixedId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let id = prefix;
  for (let i = 0; i < 8; i++) {
    id += ID_ALPHABET[bytes[i] % 36];
  }
  return id;
}

/** Instance ID prefixes */
export const INSTANCE_ID_PREFIXES = {
  claude: 'c',
  gemini: 'g',
  codex: 'x',
  copilot: 'p',
  generic: 'i',
} as const;

/** Generate a provider-prefixed instance ID */
export function generateInstanceId(provider: keyof typeof INSTANCE_ID_PREFIXES = 'generic'): string {
  return generatePrefixedId(INSTANCE_ID_PREFIXES[provider]);
}
```

**Migration**: Update `instance-manager.ts` and `instance-lifecycle.ts` to use `generateInstanceId(provider)` instead of `generateId()` when creating instances. Keep `generateId()` for other uses (session IDs, message IDs, etc.).

**Verification**: `npx tsc --noEmit && npm test -- --grep "id-generator"`

---

### 2.3 Debate Early Termination on Divergence

**Problem**: The debate system checks convergence (line 149: `consensusScore >= convergenceThreshold`) but has **no divergence detection**. If agents diverge further each round, rounds 3-4 are wasted compute.

**Claude Code pattern**: `isTerminalTaskStatus()` prevents wasted operations on dead tasks. The principle: detect hopeless situations and exit early.

**File to modify**: `src/main/orchestration/debate-coordinator.ts`

**Changes**:

1. Track consensus score trend across rounds:
```typescript
// Add to class properties
private readonly MIN_IMPROVEMENT_THRESHOLD = 0.02; // 2% improvement minimum per round
private readonly DIVERGENCE_THRESHOLD = -0.05; // 5% drop = diverging
```

2. In the round loop (~line 140-176), after each round's consensus calculation, add:
```typescript
const scoreTrend = currentRound.consensusScore - previousRound.consensusScore;

if (scoreTrend < this.DIVERGENCE_THRESHOLD && debate.currentRound >= 2) {
  logger.info('Debate early termination: agents diverging', {
    debateId: debate.id,
    round: debate.currentRound,
    scoreTrend,
    consensusScore: currentRound.consensusScore,
  });
  debate.status = 'early_terminated';
  break;
}
```

3. Add fallback when early-terminated — use best round's consensus instead of running synthesis:
```typescript
if (debate.status === 'early_terminated') {
  // Find the round with highest consensus score
  const bestRound = debate.rounds.reduce((best, round) =>
    round.consensusScore > best.consensusScore ? round : best
  );
  debate.result = this.buildResultFromBestRound(bestRound);
} else {
  // Normal path: run synthesis
  const synthesisRound = await this.runSynthesisRound(debate);
  debate.rounds.push(synthesisRound);
}
```

4. Add `'early_terminated'` to `DebateStatus` type.

**Verification**: `npx tsc --noEmit && npm test -- --grep "debate"`

---

### 2.4 Granular Tool Permission Model

**Problem**: The orchestrator's security model is binary (allowed/denied). No concept of "warn but allow" or "safe for automation."

**Claude Code pattern**: Tool permissions have 3 layers:
- `checkPermissions(context)` → `'allow' | 'warn' | 'deny'`
- `isDestructive()` method on each tool
- `automationExceptions` set for tools safe to auto-approve
- `workingDirectories` scoping per tool

**Files to create/modify**:

1. **Create** `src/shared/types/tool-permission.types.ts`:
```typescript
export type ToolBehavior = 'allow' | 'warn' | 'deny';

export interface ToolPermissionContext {
  instanceId: string;
  workingDirectory: string;
  provider: string;
  isAutomated: boolean;
}

export interface ToolPermissionResult {
  behavior: ToolBehavior;
  reason?: string;
  /** If warn: message to show user */
  warningMessage?: string;
}

export interface ToolPermissionConfig {
  /** Tools that are always allowed without prompting */
  automationExceptions: Set<string>;
  /** Tools that require explicit approval */
  restrictedTools: Set<string>;
  /** Whether destructive operations require confirmation */
  confirmDestructive: boolean;
  /** Allowed working directories per instance */
  workingDirectories: string[];
}
```

2. **Create** `src/main/security/tool-permission-checker.ts`:
   - Singleton service that evaluates `ToolPermissionContext` → `ToolPermissionResult`
   - Integrates with existing `src/main/security/` path validation
   - Tracks permission denials for audit (like Claude Code's `permissionDenials` array)

3. **Wire into** `instance-communication.ts` — before forwarding tool calls to instances, check permissions.

**Verification**: `npx tsc --noEmit && npm run lint`

---

## Phase 3: P2 — Architectural Improvements (2 items)

### 3.1 Async Generator Pipeline for Coordinators

**Problem**: Coordinators use EventEmitter for progress. This lacks backpressure — if renderer can't keep up, messages pile up in the 2000-message buffer.

**Claude Code pattern**: `QueryEngine.submitMessage()` is an `async *` generator yielding `SDKMessage` objects. Provides natural backpressure, cancellation via iterator return, and memory efficiency.

**Scope**: Start with debate coordinator as proof-of-concept, then expand.

**File to modify**: `src/main/orchestration/debate-coordinator.ts`

**Add parallel interface** (keep EventEmitter for backward compatibility):
```typescript
async *streamDebate(debateId: string): AsyncGenerator<DebateProgress, DebateResult, void> {
  const debate = this.debates.get(debateId);
  if (!debate) throw new Error(`Debate ${debateId} not found`);

  yield { type: 'started', debateId, topic: debate.topic, agents: debate.agents.length };

  for await (const round of this.runRoundsIterator(debate)) {
    yield { type: 'round-complete', debateId, round: round.number, consensusScore: round.consensusScore };

    if (debate.status !== 'in_progress') break;
  }

  const result = this.buildResult(debate);
  yield { type: 'completed', debateId, result };
  return result;
}
```

**IPC integration**: Create a new IPC channel `DEBATE_STREAM` that wraps the async generator into an Electron IPC stream for the renderer.

**Verification**: `npx tsc --noEmit && npm test -- --grep "debate"`

---

### 3.2 Lazy Loading for Optional Coordinators

**Problem**: All coordinators are imported eagerly, even if unused. For users who never use debate or verification, this wastes startup time and memory.

**Claude Code pattern**: Feature-gated loading via `feature('WORKFLOW_SCRIPTS') ? require('./LocalWorkflowTask') : null`. Tasks not enabled are never loaded.

**Files to modify**:

1. `src/main/orchestration/index.ts` — change static imports to lazy getters:
```typescript
let _debateCoordinator: DebateCoordinator | null = null;

export async function getDebateCoordinator(): Promise<DebateCoordinator> {
  if (!_debateCoordinator) {
    const { DebateCoordinator } = await import('./debate-coordinator');
    _debateCoordinator = DebateCoordinator.getInstance();
  }
  return _debateCoordinator;
}

// Same pattern for: MultiVerifyCoordinator, ConsensusCoordinator, ParallelWorktreeCoordinator
```

2. Update all callers that import coordinators directly to use the lazy getters.

3. Add feature flags to `src/shared/constants/` for each coordination system:
```typescript
export const FEATURES = {
  DEBATE_SYSTEM: true,
  VERIFICATION_SYSTEM: true,
  CONSENSUS_SYSTEM: true,
  PARALLEL_WORKTREE: true,
} as const;
```

**Verification**: `npx tsc --noEmit && npm run lint`

---

## Phase 4: P3 — Nice-to-Have Polish (2 items)

### 4.1 Typed Progress Events Per Coordinator

**Problem**: Progress is implicit through untyped EventEmitter events. The Angular frontend has no type-safe way to display coordinator progress.

**Claude Code pattern**: Specialized progress types per execution context — `BashProgress`, `MCPProgress`, `AgentToolProgress`, `TaskOutputProgress`.

**File to create**: `src/shared/types/coordinator-progress.types.ts`:
```typescript
export interface DebateProgress {
  type: 'debate';
  debateId: string;
  phase: 'initial' | 'critique' | 'defense' | 'synthesis' | 'completed' | 'early_terminated';
  round: number;
  maxRounds: number;
  agentsResponded: number;
  totalAgents: number;
  consensusScore: number;
  elapsedMs: number;
}

export interface VerificationProgress {
  type: 'verification';
  verificationId: string;
  agentsCompleted: number;
  totalAgents: number;
  clustersFormed: number;
  consensusStrength: number;
}

export interface WorktreeProgress {
  type: 'worktree';
  executionId: string;
  phase: 'creating' | 'running' | 'merging' | 'cleaning' | 'completed' | 'failed';
  tasksRunning: number;
  tasksComplete: number;
  totalTasks: number;
  conflictsDetected: number;
}

export interface ConsensusProgress {
  type: 'consensus';
  queryId: string;
  providersQueried: number;
  totalProviders: number;
  agreementStrength: number;
}

export type CoordinatorProgress =
  | DebateProgress
  | VerificationProgress
  | WorktreeProgress
  | ConsensusProgress;
```

**Wire into**: Each coordinator's EventEmitter calls. Create IPC channel for streaming to renderer.

**Verification**: `npx tsc --noEmit`

---

### 4.2 Separate Tool Validation from Permission Checks

**Problem**: Tool input validation and permission checking are conflated. This makes it hard to test each independently.

**Claude Code pattern**: `validateInput()` and `checkPermissions()` are separate methods on the Tool interface.

**File to create**: `src/main/security/tool-validator.ts`:
```typescript
export interface ToolValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface ToolPermissionResult {
  allowed: boolean;
  behavior: 'allow' | 'warn' | 'deny';
  reason?: string;
}

// Separate functions for each concern
export function validateToolInput(toolName: string, input: unknown): ToolValidationResult { ... }
export function checkToolPermission(toolName: string, context: ToolPermissionContext): ToolPermissionResult { ... }
```

**Verification**: `npx tsc --noEmit`

---

## Execution Order & Dependencies

```
Phase 1 (P0) — can all run in parallel:
├── 1.1 Wire ErrorRecoveryManager into coordinators
├── 1.2 Fix checkpoint race condition
└── 1.3 Fix silent worktree cleanup

Phase 2 (P1) — after Phase 1:
├── 2.1 Coordinator error handler utility (depends on 1.1)
├── 2.2 Prefixed ID generation (independent)
├── 2.3 Debate early termination (independent)
└── 2.4 Tool permission model (independent)

Phase 3 (P2) — after Phase 2:
├── 3.1 Async generator pipeline (depends on debate changes in 2.3)
└── 3.2 Lazy loading coordinators (independent)

Phase 4 (P3) — after Phase 2:
├── 4.1 Typed progress events (depends on coordinator changes)
└── 4.2 Tool validation separation (depends on 2.4)
```

## Parallelization Opportunities

Within each phase, items marked "independent" can be done by parallel child instances:

- **Phase 1**: All 3 items in parallel (different files, no overlap)
- **Phase 2**: Items 2.2, 2.3, 2.4 in parallel; 2.1 after 1.1 completes
- **Phase 3**: Both items in parallel
- **Phase 4**: Both items in parallel

## Estimated Scope

| Phase | Items | New Files | Modified Files | Effort |
|-------|-------|-----------|---------------|--------|
| P0    | 3     | 0         | 4             | Small  |
| P1    | 4     | 3         | 6             | Medium |
| P2    | 2     | 0         | 4             | Medium |
| P3    | 2     | 2         | 4             | Small  |
| **Total** | **11** | **5** | **~18** | |
