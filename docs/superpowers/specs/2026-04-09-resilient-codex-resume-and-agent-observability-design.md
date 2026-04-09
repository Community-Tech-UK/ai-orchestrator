# Resilient Codex Resume, Agent Activity Detection & Recovery Recipes

**Date**: 2026-04-09
**Status**: Draft
**Approach**: Integrate & Extend (build on existing AI Orchestrator infrastructure)

## Problem Statement

AI Orchestrator has strong session infrastructure (SessionContinuityManager, CheckpointManager, ReplayContinuity, ResumeHintManager) but three critical blind spots compared to sibling projects (agent-orchestrator, t3code, claw-code-parity):

1. **No Codex session discovery from filesystem** — after an app crash, AI Orchestrator can't find which Codex thread was running for a given workspace. The in-memory `shouldResumeNextTurn` flag and `sessionId` are lost.
2. **No agent-level activity detection** — AI Orchestrator knows orchestrator-level `InstanceStatus` but not what the underlying agent is doing (active, idle, waiting for input, crashed).
3. **No automated recovery from known failures** — CheckpointManager provides checkpoints and a recovery wizard, but recovery is always user-triggered. Known failure modes (stuck agent, dead process, exhausted context) could be auto-recovered.

## Cross-Project Research

Patterns sourced from:
- **agent-orchestrator**: Codex JSONL scanning (`findCodexSessionFile`, `streamCodexSessionData`), 6-state activity FSM with 4-level fallback cascade, activity JSONL recording, staleness caps
- **t3code**: Resume cursor persistence in SQLite, recoverable error classification (`isRecoverableThreadResumeError`), event sourcing for session recovery
- **claw-code-parity**: Recovery recipes with typed failure taxonomy, degraded mode for MCP failures, append-only JSONL session storage, session forking with lineage
- **codex-plugin-cc**: Background job delegation via `codex resume <threadId>`, status/result tracking

## Architecture Overview

Three modules that integrate into existing infrastructure. No new singletons — each module is either a utility class or an extension to an existing singleton.

```
┌─────────────────────────────────────────────────────────┐
│                    AI Orchestrator                       │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Module A: Codex Session Discovery        │   │
│  │  New: CodexSessionScanner utility class           │   │
│  │  Extends: SessionState (resumeCursor field)       │   │
│  │  Extends: CodexCliAdapter (scan + fallback chain) │   │
│  │  Storage: Existing session-continuity JSON files   │   │
│  └──────────────┬───────────────────────────────────┘   │
│                 │ provides threadId                      │
│  ┌──────────────▼───────────────────────────────────┐   │
│  │          Module B: Activity State Detection        │   │
│  │  New: ActivityStateDetector (per-provider)         │   │
│  │  New: ActivityState type (provider-level)          │   │
│  │  Feeds: InstanceStatus transitions                 │   │
│  │  Feeds: HibernationManager, SupervisionTree        │   │
│  │  Storage: .ao/activity.jsonl per workspace         │   │
│  └──────────────┬───────────────────────────────────┘   │
│                 │ surfaces stuck/blocked                 │
│  ┌──────────────▼───────────────────────────────────┐   │
│  │          Module C: Recovery Recipes                │   │
│  │  New: RecoveryRecipeEngine                         │   │
│  │  Extends: CheckpointManager (proactive detection)  │   │
│  │  New: FailureTaxonomy (typed failure catalog)      │   │
│  │  Consumes: ActivityState, transaction logs          │   │
│  │  Actions: auto-retry → escalate to user             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Existing (untouched or minimally extended):             │
│  - SessionContinuityManager (add resumeCursor field)    │
│  - ReplayContinuity (fallback, no changes)              │
│  - CheckpointManager (extended, not replaced)           │
│  - ProviderRegistry (ActivityState added to interface)  │
│  - OrchestrationActivityBridge (enriched with activity) │
└─────────────────────────────────────────────────────────┘
```

### New Files

| File | Module | Purpose |
|------|--------|---------|
| `src/main/cli/adapters/codex/session-scanner.ts` | A | Codex JSONL session discovery |
| `src/shared/types/activity.types.ts` | B | ActivityState, ActivityEntry, ActivityDetectionResult |
| `src/main/providers/activity-state-detector.ts` | B | Per-instance activity detection with fallback cascade |
| `src/shared/types/recovery.types.ts` | C | FailureCategory, DetectedFailure, RecoveryRecipe, RecoveryOutcome |
| `src/main/session/recovery-recipe-engine.ts` | C | Detection-to-recovery pipeline with loop prevention |

### Modified Files

| File | Module | Change |
|------|--------|--------|
| `src/main/session/session-continuity.ts` | A | Add `resumeCursor` field to `SessionState` |
| `src/main/cli/adapters/codex-cli-adapter.ts` | A, B | 4-step resume fallback chain; call `activityDetector.recordTerminalActivity()` on each streaming chunk for activity classification |
| `src/main/instance/instance-lifecycle.ts` | B, C | Poll ActivityStateDetector; trigger RecoveryRecipeEngine on failures |
| `src/main/providers/provider-registry.ts` | B | Add ActivityState to provider interface |
| `src/main/ipc/handlers/session-handlers.ts` | A | Expose resume cursor and activity state via IPC |
| `src/shared/types/instance.types.ts` | B | Add `activityState` field to Instance type |

---

## Module A: Crash-Resilient Codex Resume

### A1. CodexSessionScanner

**File**: `src/main/cli/adapters/codex/session-scanner.ts`

Discovers Codex threadIds from the filesystem by scanning `~/.codex/sessions/` JSONL rollout files.

```typescript
interface CodexSessionScanResult {
  threadId: string;
  model: string | null;
  sessionFilePath: string;
  workspacePath: string;
  tokenUsage: { input: number; output: number; cached: number; reasoning: number };
  lastModified: number;
}

class CodexSessionScanner {
  async findSessionForWorkspace(workspacePath: string): Promise<CodexSessionScanResult | null>;
  private async streamParseJsonl(filePath: string, targetCwd: string): Promise<CodexSessionScanResult | null>;
  private async collectJsonlFiles(sessionsDir: string): Promise<string[]>;
  invalidateCache(workspacePath: string): void;
}
```

**Scanning strategy**:
1. Recursively collect `rollout-*.jsonl` files from `~/.codex/sessions/`
2. Sort by mtime descending (most recent first)
3. For each file: read first 4KB to check if `session_meta.cwd` matches target workspace
4. On match: stream full file line-by-line to extract threadId, model, token counts (never load full file into memory — rollout files can exceed 100MB)
5. Cache result with workspace path as key — invalidated explicitly on session end, not via TTL
6. Stop on first match (newest file wins)

**4KB header scan rationale**: Codex writes `session_meta` near the top of rollout files. Reading 4KB before committing to a full stream parse avoids unnecessary I/O on non-matching files.

### A2. Resume Cursor Persistence

**Extends**: `SessionState` interface in `session-continuity.ts`

```typescript
// Added to existing SessionState interface (lines 100-129)
interface SessionState {
  // ... all existing fields unchanged ...
  resumeCursor: ResumeCursor | null;
}

interface ResumeCursor {
  provider: string;           // 'openai' | 'claude-cli' | 'google'
  threadId: string;           // provider-specific thread/session ID
  workspacePath: string;      // for filesystem-based discovery fallback
  capturedAt: number;         // epoch ms for staleness check
  scanSource: 'native' | 'jsonl-scan' | 'replay';
}
```

**Lifecycle**:
1. **Capture**: When CodexCliAdapter starts/resumes a thread, it emits the threadId. SessionContinuityManager captures it into `resumeCursor` during the next auto-save cycle (within 60s).
2. **Persist**: Written as part of the existing SessionState JSON file — no new storage mechanism.
3. **Restore**: On app restart, `resumeSession()` reads the cursor. If present and fresh (< 7 days), uses it for `thread/resume`. If stale or missing, falls back to CodexSessionScanner.
4. **Invalidate**: Set to `null` on explicit session termination.

### A3. Resume Fallback Chain

**Extends**: CodexCliAdapter spawn/resume logic (currently lines 541-556)

Replaces the current single-step resume with a 4-step fallback:

```
Step 1: Resume from persisted cursor
  ├─ cursor exists and fresh (< 7 days)
  ├─ call thread/resume with cursor.threadId
  ├─ success → persist updated cursor, done
  └─ fail (recoverable?) → Step 2

Step 2: Scan filesystem for threadId
  ├─ CodexSessionScanner.findSessionForWorkspace(cwd)
  ├─ found → call thread/resume with scanned threadId
  │   ├─ success → persist cursor, done
  │   └─ fail → Step 3
  └─ not found → Step 3

Step 3: Replay continuity preamble (existing ReplayContinuity)
  ├─ build context preamble from saved transcript
  ├─ start fresh thread with preamble injected as system message
  └─ done (degraded — no native thread continuity)

Step 4: Fresh start (last resort)
  └─ start clean thread with no prior context
```

**Recoverable error classification**:

```typescript
function isRecoverableThreadResumeError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return ['not found', 'missing thread', 'unknown thread', 'unknown session',
          'expired', 'invalid thread'].some(pattern => msg.includes(pattern));
}
```

Non-recoverable errors (auth failure, network error, rate limit) throw immediately without advancing to the next fallback step.

---

## Module B: Agent Activity State Detection

### B1. ActivityState Type

**File**: `src/shared/types/activity.types.ts`

```typescript
type ActivityState = 'active' | 'ready' | 'idle' | 'waiting_input' | 'blocked' | 'exited';

interface ActivityEntry {
  ts: number;
  state: ActivityState;
  source: 'native' | 'terminal' | 'process-check';
  trigger?: string;        // last 3 lines of terminal output for debugging
  provider?: string;
}

interface ActivityDetectionResult {
  state: ActivityState;
  confidence: 'high' | 'medium' | 'low';
  staleAfterMs: number;
  source: string;
}
```

**Relationship to InstanceStatus** (separate layers of truth):

| ActivityState | Meaning | Feeds into InstanceStatus |
|---|---|---|
| `active` | Agent working (< 30s since last signal) | `busy` |
| `ready` | Agent finished turn, alive (30s–5min) | `idle` |
| `idle` | Agent inactive (> 5min) | `idle` → hibernation candidate |
| `waiting_input` | Agent blocked on approval prompt | `waiting_for_input` |
| `blocked` | Agent hit an error, stuck | `degraded` or `error` |
| `exited` | Agent process is dead | `terminated` or triggers respawn |

ActivityState is a provider-level signal. InstanceStatus is an orchestrator-level lifecycle state. ActivityState informs InstanceStatus transitions but InstanceStatus has additional states (`hibernating`, `waking`, `respawning`) that are orchestrator concerns.

### B2. ActivityStateDetector

**File**: `src/main/providers/activity-state-detector.ts`

```typescript
class ActivityStateDetector {
  constructor(
    private instanceId: string,
    private workspacePath: string,
    private provider: string,
  ) {}

  async detect(): Promise<ActivityDetectionResult>;
  async recordTerminalActivity(terminalOutput: string): Promise<void>;
  async getLastRecordedActivity(): Promise<ActivityEntry | null>;
}
```

One detector per active instance. Created on instance spawn, destroyed on termination. Not a singleton.

### B3. Detection Fallback Cascade

4-level cascade — each level tried only if the previous one fails or returns no data.

```
Level 1: Native Provider Signal (confidence: high)
  │  Codex: stream last entries from ~/.codex/sessions/ rollout file
  │  Claude: parse streaming output for tool_use/tool_result patterns
  │  Gemini: check process stdout activity
  │
  │  Codex entry type → state mapping:
  │    user_input, tool_call, exec_command → active
  │    approval_request → waiting_input
  │    error → blocked
  │    assistant_message, session_meta, event_msg → ready/idle (age-based)
  │
  ├─ has data → return {state, confidence: 'high'}
  └─ no data → Level 2

Level 2: Activity JSONL Log (confidence: medium)
  │  Read last entry from {workspacePath}/.ao/activity.jsonl
  │  Staleness cap: waiting_input/blocked entries expire after 5 min → decay to idle
  │  Non-actionable states trusted at face value
  │
  ├─ has entry → return {state, confidence: 'medium'}
  └─ no entry → Level 3

Level 3: Age-Based Decay (confidence: low)
  │  Use file mtime of session file or last known activity timestamp
  │    < 30s → active
  │    30s–5min → ready
  │    > 5min → idle
  │  Ceiling: never promotes past the entry's detected state
  │
  ├─ has timestamp → return {state, confidence: 'low'}
  └─ no timestamp → Level 4

Level 4: Process Check (confidence: low)
  │  Is the agent process still running? (PID signal-0 check)
  │    running → idle
  │    not running → exited
  │
  └─ return {state, confidence: 'low'}
```

### B4. Activity JSONL Recording

**Storage**: Append-only JSONL at `{workspacePath}/.ao/activity.jsonl`

```jsonl
{"ts":1712620800000,"state":"active","source":"native","provider":"openai"}
{"ts":1712620830000,"state":"waiting_input","source":"terminal","trigger":"? Allow execution of: rm -rf node_modules"}
{"ts":1712620845000,"state":"active","source":"native","provider":"openai"}
```

**Write deduplication rules** (prevents log bloat):
- Non-actionable states (`active`, `ready`, `idle`): skip write if same state and last entry < 20s old
- Actionable states (`waiting_input`, `blocked`): always write immediately
- `exited`: always write

**Rotation**: Rotate when file exceeds 1MB. Keep max 3 rotated files.

### B5. Thresholds and Constants

| Constant | Value | Purpose |
|---|---|---|
| `ACTIVE_WINDOW_MS` | 30,000 | Activity younger than this = `active` |
| `READY_THRESHOLD_MS` | 300,000 | Activity 30s–5min old = `ready` |
| `ACTIVITY_INPUT_STALENESS_MS` | 300,000 | `waiting_input`/`blocked` entries older than this decay to `idle` |
| `DEDUP_WINDOW_MS` | 20,000 | Non-actionable state dedup interval |
| `ACTIVITY_LOG_MAX_BYTES` | 1,048,576 | Rotation threshold (1MB) |
| `ACTIVITY_LOG_MAX_ROTATED` | 3 | Rotated files to keep |

### B6. Integration Points

**Where detection is triggered**:
1. **Polling loop**: InstanceLifecycle's existing status-check loop calls `activityDetector.detect()` each cycle. Result feeds into InstanceStatus transition logic.
2. **On terminal output**: When CodexCliAdapter receives streaming output, calls `activityDetector.recordTerminalActivity(chunk)`.
3. **On adapter events**: Structured events (tool_use, approval_request) directly update activity state without waiting for the polling loop.

**What consumes ActivityState**:
- **InstanceLifecycle** — status transitions (idle → hibernation candidate, blocked → recovery trigger)
- **HibernationManager** — eviction scoring
- **SupervisionTree** — child health monitoring
- **OrchestrationActivityBridge** — forward to renderer for UI display
- **RecoveryRecipeEngine** (Module C) — blocked/exited triggers recovery

---

## Module C: Recovery Recipes

### C1. Failure Taxonomy

**File**: `src/shared/types/recovery.types.ts`

```typescript
type FailureCategory =
  | 'thread_resume_failed'
  | 'process_exited_unexpected'
  | 'agent_stuck_blocked'
  | 'agent_stuck_waiting'
  | 'mcp_server_unreachable'
  | 'provider_auth_expired'
  | 'context_window_exhausted'
  | 'workspace_disappeared'
  | 'stale_branch'
  | 'ci_feedback_loop'
  ;

interface DetectedFailure {
  id: string;
  category: FailureCategory;
  instanceId: string;
  detectedAt: number;
  context: Record<string, unknown>;
  activityState?: ActivityState;
  severity: 'recoverable' | 'degraded' | 'fatal';
}

interface RecoveryRecipe {
  category: FailureCategory;
  severity: 'recoverable' | 'degraded' | 'fatal';
  maxAutoRetries: number;
  cooldownMs: number;
  recover: (failure: DetectedFailure) => Promise<RecoveryOutcome>;
  description: string;
}

type RecoveryOutcome =
  | { status: 'recovered'; action: string }
  | { status: 'degraded'; action: string }
  | { status: 'escalated'; reason: string }
  | { status: 'aborted'; reason: string }
  ;

interface RecoveryAttempt {
  failureId: string;
  category: FailureCategory;
  instanceId: string;
  attemptedAt: number;
  outcome: RecoveryOutcome;
  checkpointId: string;
}
```

### C2. RecoveryRecipeEngine

**File**: `src/main/session/recovery-recipe-engine.ts`

```typescript
class RecoveryRecipeEngine {
  private recipes: Map<FailureCategory, RecoveryRecipe>;
  private attempts: Map<string, RecoveryAttempt[]>;  // instanceId → history

  constructor(
    private checkpointManager: CheckpointManager,
    private sessionContinuity: SessionContinuityManager,
  ) {}

  registerRecipe(recipe: RecoveryRecipe): void;
  async handleFailure(failure: DetectedFailure): Promise<RecoveryOutcome>;
  getAttemptHistory(instanceId: string): RecoveryAttempt[];
  isExhausted(instanceId: string, category: FailureCategory): boolean;
}
```

Not a singleton. Instantiated by InstanceLifecycle, receives existing CheckpointManager and SessionContinuityManager singletons via constructor injection. Individual recipe `recover()` functions receive the `DetectedFailure` which includes `instanceId` — they access the running instance's adapter through InstanceLifecycle's existing instance registry (same pattern used by the supervision tree and hibernation manager).

### C3. Built-in Recovery Recipes

| Category | Severity | Auto-Recovery Action | Max Retries | Cooldown |
|---|---|---|---|---|
| `thread_resume_failed` | recoverable | Advance to next fallback step in Module A chain | 3 | 0s |
| `process_exited_unexpected` | recoverable | Respawn instance with resume cursor, restore from last checkpoint | 2 | 10s |
| `agent_stuck_blocked` | recoverable | Send `turn/interrupt` RPC (app-server) or SIGINT (exec mode), then inject "You appear stuck. Describe the error and try a different approach." as next user message | 1 | 60s |
| `agent_stuck_waiting` | degraded | Log to activity bridge for UI notification; auto-approve if in yolo mode | 1 | 30s |
| `mcp_server_unreachable` | degraded | Mark server as degraded (skip, don't crash), retry connection after cooldown | 3 | 30s |
| `provider_auth_expired` | fatal | Escalate immediately — cannot auto-fix credentials | 0 | — |
| `context_window_exhausted` | recoverable | Trigger context compaction (existing capability), checkpoint first | 1 | 0s |
| `workspace_disappeared` | recoverable | Recreate git worktree from branch metadata, restore session | 1 | 5s |
| `stale_branch` | degraded | Warn user via activity bridge, do not auto-rebase (destructive) | 0 | — |
| `ci_feedback_loop` | degraded | After 3 consecutive CI failures on same issue, pause agent, escalate with summary | 0 | — |

### C4. Detection-to-Recovery Flow

```
ActivityStateDetector.detect()
  │
  ├─ state = blocked (> 60s) ────► DetectedFailure{category: 'agent_stuck_blocked'}
  ├─ state = waiting_input (> 5m) ► DetectedFailure{category: 'agent_stuck_waiting'}
  ├─ state = exited ─────────────► DetectedFailure{category: 'process_exited_unexpected'}
  │
  ▼
RecoveryRecipeEngine.handleFailure(failure)
  │
  ├─ 1. Look up recipe by category
  ├─ 2. Check attempt history — exhausted? → escalate immediately
  ├─ 3. Check cooldown — too soon? → skip, wait for next poll cycle
  ├─ 4. Create checkpoint via CheckpointManager (safety net before acting)
  ├─ 5. Execute recipe.recover(failure)
  ├─ 6. Log attempt to history
  │
  ├─ outcome = recovered → resume normal operation, log to activity bridge
  ├─ outcome = degraded → update InstanceStatus to 'degraded', notify user
  ├─ outcome = escalated → show recovery wizard (existing UI)
  └─ outcome = aborted → terminate instance, archive session
```

### C5. Loop Prevention

**Per-category limits**: Each recipe defines `maxAutoRetries`. Once exhausted for a given instance + category, all future occurrences escalate immediately.

**Per-category cooldown**: Each recipe defines `cooldownMs`. If the last attempt for the same instance + category was within the cooldown window, skip and wait for the next poll cycle.

**Global circuit breaker**: If an instance triggers > 5 total recovery attempts across all categories within 10 minutes, escalate everything and pause the instance. This catches cascading failures that individually look recoverable.

**Attempt tracking**: In-memory only (not persisted). Cleared when instance terminates. After a full app restart, recovery starts with a clean slate — intentional, since the restart itself is a form of recovery.

### C6. CheckpointManager Integration

Recovery recipes use the existing `RECOVERY_ACTION` transaction type (already defined at lines 49-70 of checkpoint-manager.ts). Every auto-recovery attempt creates a checkpoint first, providing a rollback point if the recovery action makes things worse.

```typescript
// Inside handleFailure()
await this.checkpointManager.createCheckpoint(
  failure.instanceId,
  'RECOVERY_ACTION',
  `Pre-recovery: ${failure.category}`
);
```

---

## Testing Strategy

### Unit Tests

| File | Tests |
|------|-------|
| `session-scanner.spec.ts` | JSONL parsing, 4KB header scan, cache invalidation, workspace path matching, empty/corrupt file handling |
| `activity-state-detector.spec.ts` | Each fallback level in isolation, cascade ordering, staleness caps, dedup logic, rotation |
| `recovery-recipe-engine.spec.ts` | Each built-in recipe, exhaustion logic, cooldown enforcement, circuit breaker, checkpoint creation |

### Integration Tests

| Scenario | Modules |
|----------|---------|
| App restart → resume Codex session from filesystem | A (scanner + cursor) |
| Cursor stale → fallback to JSONL scan → fallback to replay | A (full chain) |
| Agent blocks on approval → activity detected → UI notified | B → bridge |
| Agent process dies → activity=exited → auto-respawn | B → C |
| Agent stuck > 60s → recovery interrupt → agent resumes | B → C |
| 3 consecutive resume failures → escalate to user | A → C (exhaustion) |
| 6 recoveries in 10 min → global circuit breaker → pause | C (circuit breaker) |

---

## Rollout Strategy

**Phase 1**: Module A (Codex resume) — can ship independently, immediate reliability win.
**Phase 2**: Module B (activity detection) — requires Module A's scanner for Codex native signal (Level 1).
**Phase 3**: Module C (recovery recipes) — requires Module B's activity state as trigger source.

Each phase is independently shippable and testable. Module A has zero dependencies on B or C.
