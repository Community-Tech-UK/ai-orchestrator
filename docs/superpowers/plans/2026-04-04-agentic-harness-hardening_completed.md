# Agentic Harness Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 9 highest-priority gaps identified by auditing our orchestrator against the 12 architectural primitives from the Claude Code source leak analysis.

**Architecture:** Nine focused improvements across security enforcement, crash diagnostics, workflow durability, budget governance, and safety testing. Each task is independently deployable and testable. Tasks are ordered so earlier tasks unblock later ones where dependencies exist.

**Tech Stack:** TypeScript 5.9, Vitest, Electron 40, better-sqlite3 (RLM), Zod 4

**Background:** This plan is based on a deep audit of our codebase against the 12 primitives identified in Nate B Jones' analysis of the Claude Code source leak (video: "You're Building 20% of an Agent. Anthropic Just Showed You the Other 80%"). All gaps were verified by reading the actual source code with specific line references.

---

## File Map

| Task | Creates | Modifies |
|------|---------|----------|
| 1 | `src/main/instance/__tests__/crash-diagnostics.spec.ts` | `src/main/instance/instance-state.ts`, `src/main/instance/instance-communication.ts` |
| 2 | `src/main/workflows/__tests__/workflow-cleanup.spec.ts` | `src/main/index.ts`, `src/main/workflows/workflow-manager.ts` |
| 3 | `src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts` | `src/shared/utils/permission-mapper.ts`, `src/main/ipc/specialist-ipc-handler.ts` |
| 4 | — | `src/main/instance/instance-lifecycle.ts` |
| 5 | `src/main/security/__tests__/permission-persistence.spec.ts`, `src/main/security/permission-decision-store.ts` | `src/main/security/permission-manager.ts`, `src/main/persistence/rlm/rlm-schema.ts` |
| 6 | `src/main/context/__tests__/budget-enforcement.spec.ts` | `src/main/instance/instance-communication.ts` |
| 7 | `src/main/workflows/__tests__/workflow-persistence.spec.ts`, `src/main/workflows/workflow-persistence.ts` | `src/main/workflows/workflow-manager.ts`, `src/main/persistence/rlm/rlm-schema.ts` |
| 8 | `src/main/instance/__tests__/tool-pool-filtering.spec.ts` | `src/main/instance/instance-lifecycle.ts` |
| 9 | `src/main/security/__tests__/harness-invariants.spec.ts` | — |

---

### Task 1: Crash Black Box — Populate `error` Field on Process Exit

**Why:** When a CLI adapter process crashes, the renderer receives `status: 'error'` with zero context. The `error?: ErrorInfo` field in `InstanceStateUpdatePayload` (ipc.types.ts:889) exists but is never populated by `queueUpdate` (instance-state.ts:196-211). Users can't diagnose crashes.

**Approach:** `queueUpdate` in `instance-state.ts` builds `InstanceStateUpdatePayload` objects and stores them in `pendingUpdates` Map. We add an `error` parameter to `queueUpdate`, populate the field on the payload, and pass `ErrorInfo` from the crash handler in `instance-communication.ts`. We also update the relay in `instance-manager.ts:155` to forward the error.

**Files:**
- Modify: `src/main/instance/instance-state.ts:196-211` (add `error?` param to `queueUpdate`)
- Modify: `src/main/instance/instance-manager.ts:155` (forward `error` param in relay)
- Modify: `src/main/instance/instance-communication.ts:37` (update `CommunicationDependencies` type)
- Modify: `src/main/instance/instance-communication.ts:923-1019` (pass `ErrorInfo` in crash handler)
- Test: `src/main/instance/__tests__/crash-diagnostics.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/instance/__tests__/crash-diagnostics.spec.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InstanceStateManager } from '../instance-state.js';
import type { ErrorInfo } from '../../../shared/types/ipc.types.js';

describe('Crash Diagnostics', () => {
  let stateManager: InstanceStateManager;

  beforeEach(() => {
    InstanceStateManager._resetForTesting();
    stateManager = InstanceStateManager.getInstance();
  });

  it('should include ErrorInfo in queued update when error is provided', () => {
    // Create a minimal instance so queueUpdate has something to work with
    const errorInfo: ErrorInfo = {
      code: 'EXIT_1',
      message: 'Process exited with code 1 (signal: SIGTERM)',
      timestamp: Date.now(),
    };

    stateManager.queueUpdate('test-instance', 'error', undefined, undefined, undefined, errorInfo);

    // Access the pending update to verify error is set
    // We need to check the batched output — listen for the batch-update event
    const updates: unknown[] = [];
    stateManager.on('batch-update', (payload: { updates: unknown[] }) => {
      updates.push(...payload.updates);
    });

    // Force flush
    (stateManager as unknown as { flushUpdates(): void }).flushUpdates();

    expect(updates).toHaveLength(1);
    expect((updates[0] as { error?: ErrorInfo }).error).toMatchObject({
      code: 'EXIT_1',
      message: expect.stringContaining('code 1'),
      timestamp: expect.any(Number),
    });
  });

  it('should not include error when none provided', () => {
    stateManager.queueUpdate('test-instance', 'idle');

    const updates: unknown[] = [];
    stateManager.on('batch-update', (payload: { updates: unknown[] }) => {
      updates.push(...payload.updates);
    });
    (stateManager as unknown as { flushUpdates(): void }).flushUpdates();

    expect(updates).toHaveLength(1);
    expect((updates[0] as { error?: ErrorInfo }).error).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/__tests__/crash-diagnostics.spec.ts`
Expected: FAIL — `queueUpdate` doesn't accept 6th `error` parameter yet

- [ ] **Step 3: Add `error?` parameter to `queueUpdate` in instance-state.ts**

In `src/main/instance/instance-state.ts`, change `queueUpdate` (lines 196-211) from:

```typescript
queueUpdate(
  instanceId: string,
  status: InstanceStatus,
  contextUsage?: ContextUsage,
  diffStats?: SessionDiffStats,
  displayName?: string
): void {
  const existing = this.pendingUpdates.get(instanceId);
  this.pendingUpdates.set(instanceId, {
    instanceId,
    status,
    contextUsage: contextUsage ?? existing?.contextUsage,
    diffStats: diffStats ?? existing?.diffStats,
    displayName: displayName ?? existing?.displayName
  });
}
```

to:

```typescript
queueUpdate(
  instanceId: string,
  status: InstanceStatus,
  contextUsage?: ContextUsage,
  diffStats?: SessionDiffStats,
  displayName?: string,
  error?: ErrorInfo
): void {
  const existing = this.pendingUpdates.get(instanceId);
  this.pendingUpdates.set(instanceId, {
    instanceId,
    status,
    contextUsage: contextUsage ?? existing?.contextUsage,
    diffStats: diffStats ?? existing?.diffStats,
    displayName: displayName ?? existing?.displayName,
    error: error ?? existing?.error,
  });
}
```

Add the import at the top of the file:

```typescript
import type { ErrorInfo } from '../../shared/types/ipc.types.js';
```

- [ ] **Step 4: Update `CommunicationDependencies` type**

In `src/main/instance/instance-communication.ts`, update the `queueUpdate` signature in `CommunicationDependencies` (~line 37) from:

```typescript
queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage, diffStats?: SessionDiffStats) => void;
```

to:

```typescript
queueUpdate: (instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage, diffStats?: SessionDiffStats, error?: ErrorInfo) => void;
```

Add import for `ErrorInfo` at the top.

- [ ] **Step 5: Update relay in instance-manager.ts**

In `src/main/instance/instance-manager.ts` at line 155, change:

```typescript
queueUpdate: (id, status, ctx, diffStats) => this.state.queueUpdate(id, status, ctx, diffStats),
```

to:

```typescript
queueUpdate: (id, status, ctx, diffStats, error) => this.state.queueUpdate(id, status, ctx, diffStats, undefined, error),
```

Note: the 5th positional param in `instance-state.ts` is `displayName` (not used by communication manager), so we pass `undefined` for it and `error` as the 6th param.

- [ ] **Step 6: Pass ErrorInfo from crash handler**

In `src/main/instance/instance-communication.ts`, in the exit handler (~line 923), add a helper at the top of the handler body (after the `instance` null check at line 926):

```typescript
const buildCrashError = (reason: string): ErrorInfo => ({
  code: signal ? `SIGNAL_${signal}` : `EXIT_${code ?? 'unknown'}`,
  message: reason,
  timestamp: Date.now(),
});
```

Then update the three `queueUpdate` calls that pass `'error'` status:

At line ~962 (interrupt respawn failure):
```typescript
this.deps.queueUpdate(instanceId, 'error', undefined, undefined,
  buildCrashError(`Respawn after interrupt failed: ${err instanceof Error ? err.message : String(err)}`)
);
```

At line ~996 (auto-respawn failure):
```typescript
this.deps.queueUpdate(instanceId, 'error', undefined, undefined,
  buildCrashError(`Auto-respawn failed: ${err instanceof Error ? err.message : String(err)}`)
);
```

At line ~1005 (unexpected exit with non-zero code):
```typescript
this.deps.queueUpdate(instanceId, instance.status, undefined, undefined,
  code !== 0 ? buildCrashError(`Process exited with code ${code} (signal: ${signal})`) : undefined
);
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run src/main/instance/__tests__/crash-diagnostics.spec.ts`
Expected: PASS, no type errors

- [ ] **Step 8: Commit**

```bash
git add src/main/instance/instance-state.ts src/main/instance/instance-communication.ts src/main/instance/instance-manager.ts src/main/instance/__tests__/crash-diagnostics.spec.ts
git commit -m "feat: populate crash diagnostics in instance error state updates"
```

---

### Task 2: Wire Workflow `cleanupInstance` into Instance Removal

**Why:** `WorkflowManager.cleanupInstance()` (workflow-manager.ts:434-440) is defined but never called. When instances are removed, the `instanceExecutions` Map leaks entries. Other managers (compaction, doom loop, load balancer) are cleaned up in `index.ts:499-508` but workflow is missing.

**Files:**
- Modify: `src/main/index.ts` (~line 501, inside `instance:removed` handler)
- Modify: `src/main/workflows/workflow-manager.ts` (ensure `getWorkflowManager` convenience getter exists)
- Test: `src/main/workflows/__tests__/workflow-cleanup.spec.ts`

- [ ] **Step 1: Write the test**

Create `src/main/workflows/__tests__/workflow-cleanup.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowManager } from '../workflow-manager.js';

describe('WorkflowManager.cleanupInstance', () => {
  beforeEach(() => {
    WorkflowManager._resetForTesting();
  });

  it('should remove instanceExecutions mapping on cleanup', () => {
    const wm = WorkflowManager.getInstance();
    wm.registerTemplate({
      id: 'test-template',
      name: 'Test',
      description: 'Test workflow',
      phases: [{ id: 'phase-1', name: 'Phase 1', type: 'agent', prompt: 'Do something' }],
    });

    const execution = wm.startWorkflow('instance-1', 'test-template');
    expect(wm.getExecutionByInstance('instance-1')).toBeDefined();

    wm.cleanupInstance('instance-1');
    expect(wm.getExecutionByInstance('instance-1')).toBeUndefined();

    // Execution itself is kept for history
    expect(wm.getExecution(execution.id)).toBeDefined();
  });

  it('should be a no-op for unknown instances', () => {
    const wm = WorkflowManager.getInstance();
    expect(() => wm.cleanupInstance('nonexistent')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it passes (validates existing method)**

Run: `npx vitest run src/main/workflows/__tests__/workflow-cleanup.spec.ts`
Expected: PASS

- [ ] **Step 3: Ensure `getWorkflowManager` convenience getter exists**

Check `src/main/workflows/workflow-manager.ts` for a `getWorkflowManager` export. If missing, add after the class definition:

```typescript
export function getWorkflowManager(): WorkflowManager {
  return WorkflowManager.getInstance();
}
```

- [ ] **Step 4: Wire cleanup into index.ts**

In `src/main/index.ts`, find the `instance:removed` handler (~line 499). After the existing cleanup calls:

```typescript
getCompactionCoordinator().cleanupInstance(instanceId as string);
getDoomLoopDetector().cleanupInstance(instanceId as string);
getLoadBalancer().removeMetrics(instanceId as string);
```

Add:

```typescript
getWorkflowManager().cleanupInstance(instanceId as string);
```

Add the import at the top of the file:

```typescript
import { getWorkflowManager } from './workflows/workflow-manager.js';
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/main/workflows/workflow-manager.ts src/main/workflows/__tests__/workflow-cleanup.spec.ts
git commit -m "fix: wire WorkflowManager.cleanupInstance into instance removal lifecycle"
```

---

### Task 3: Enforce Specialist Constraints via Real Permissions

**Why:** Specialist constraints like `readOnlyMode: true` (specialist.types.ts:63) are only injected as prompt text ("IMPORTANT: You are in READ-ONLY mode" in specialist-registry.ts:321). The LLM can ignore these. We need to map constraints to actual tool permission changes.

**Approach:** Create `applySpecialistConstraints()` in permission-mapper.ts. Then wire it into `specialist-ipc-handler.ts` at the `SPECIALIST_GET_SYSTEM_PROMPT` handler (line 494) so when the frontend requests a specialist's prompt addition, it also gets the enforced permission overrides returned alongside it.

**Files:**
- Modify: `src/shared/utils/permission-mapper.ts` (add `applySpecialistConstraints` function)
- Modify: `src/main/ipc/specialist-ipc-handler.ts` (~line 487, add new IPC channel for constraint enforcement)
- Test: `src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { applySpecialistConstraints } from '../../../../shared/utils/permission-mapper.js';
import type { AgentToolPermissions } from '../../../../shared/types/agent.types.js';
import type { SpecialistConstraints } from '../../../../shared/types/specialist.types.js';

describe('applySpecialistConstraints', () => {
  const fullPermissions: AgentToolPermissions = {
    read: 'allow',
    write: 'allow',
    bash: 'allow',
    web: 'allow',
    task: 'allow',
  };

  it('should deny write when readOnlyMode is true', () => {
    const constraints: SpecialistConstraints = { readOnlyMode: true };
    const result = applySpecialistConstraints(fullPermissions, constraints);
    expect(result.write).toBe('deny');
    expect(result.read).toBe('allow');
  });

  it('should set bash to ask when sandboxedExecution is true', () => {
    const constraints: SpecialistConstraints = { sandboxedExecution: true };
    const result = applySpecialistConstraints(fullPermissions, constraints);
    expect(result.bash).toBe('ask');
  });

  it('should apply both readOnly and sandboxed together', () => {
    const constraints: SpecialistConstraints = { readOnlyMode: true, sandboxedExecution: true };
    const result = applySpecialistConstraints(fullPermissions, constraints);
    expect(result.write).toBe('deny');
    expect(result.bash).toBe('ask');
  });

  it('should return permissions unchanged when no constraints', () => {
    const result = applySpecialistConstraints(fullPermissions, {});
    expect(result).toEqual(fullPermissions);
  });

  it('should not weaken existing deny permissions', () => {
    const restricted: AgentToolPermissions = {
      read: 'allow',
      write: 'deny',
      bash: 'deny',
      web: 'allow',
      task: 'allow',
    };
    const constraints: SpecialistConstraints = { sandboxedExecution: true };
    const result = applySpecialistConstraints(restricted, constraints);
    expect(result.bash).toBe('deny'); // deny is stricter than ask, keep deny
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts`
Expected: FAIL — `applySpecialistConstraints` does not exist yet

- [ ] **Step 3: Implement `applySpecialistConstraints`**

In `src/shared/utils/permission-mapper.ts`, add at the end of the file:

```typescript
import type { SpecialistConstraints } from '../types/specialist.types.js';

/**
 * Applies specialist constraints as hard permission overrides.
 * Never weakens existing permissions — only tightens them.
 */
export function applySpecialistConstraints(
  permissions: AgentToolPermissions,
  constraints: SpecialistConstraints
): AgentToolPermissions {
  const result = { ...permissions };

  if (constraints.readOnlyMode) {
    result.write = 'deny';
  }

  if (constraints.sandboxedExecution) {
    // Only tighten: deny stays deny, allow becomes ask
    if (result.bash !== 'deny') {
      result.bash = 'ask';
    }
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts`
Expected: PASS

- [ ] **Step 5: Wire into specialist IPC handler**

In `src/main/ipc/specialist-ipc-handler.ts`, find the `SPECIALIST_GET_SYSTEM_PROMPT` handler (~line 487). Currently it returns just the prompt string. Enhance it to also return permission overrides by updating the response:

```typescript
// At the SPECIALIST_GET_SYSTEM_PROMPT handler:
const prompt = getSpecialistRegistry().getSystemPromptAddition(validated.profileId);
const profile = getSpecialistRegistry().getProfile(validated.profileId);
const permissionOverrides = profile?.constraints
  ? applySpecialistConstraints(
      { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' },
      profile.constraints
    )
  : undefined;

return { success: true, data: { prompt, permissionOverrides } };
```

Add import at the top:

```typescript
import { applySpecialistConstraints } from '../../shared/utils/permission-mapper.js';
```

This provides the constraint data to the frontend. The frontend can then apply these permission overrides when configuring the instance's agent. This is a data-provision approach — the frontend caller is responsible for actually applying the overrides via agent switching.

- [ ] **Step 6: Run typecheck and tests**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npx vitest run src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts`
Expected: PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/shared/utils/permission-mapper.ts src/main/ipc/specialist-ipc-handler.ts src/main/agents/specialists/__tests__/specialist-enforcement.spec.ts
git commit -m "feat: enforce specialist constraints via real tool permission overrides"
```

---

### Task 4: Remove Contradictory "All Tools Auto-Approved" System Prompt

**Why:** `instance-lifecycle.ts` appends "All tool calls in this environment are auto-approved" to every system prompt (~line 730). This contradicts `--disallowedTools` and specialist constraints. It was added to prevent LLMs from hallucinating permission errors, but it undermines our actual permission system.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` (~lines 730-736, and also ~lines 1532, 1700, 1859 where the same text appears)

- [ ] **Step 1: Find all occurrences**

Run: `grep -n "auto-approved" src/main/instance/instance-lifecycle.ts`

This should show 4 occurrences (the main prompt and 3 agent-switching paths).

- [ ] **Step 2: Replace all occurrences**

Replace every instance of the text block:

```typescript
'[Tool Permissions] All tool calls in this environment are auto-approved. ' +
'You do NOT need user permission to run any tool, including Bash, Write, or Edit. ' +
'If a command fails, it failed for a real reason (syntax error, test failure, missing dependency, etc.) — not because of permissions. ' +
'Never ask the user to approve or deny tool calls. Just use tools directly.'
```

with:

```typescript
'[Tool Permissions] Tools available to you are pre-configured for your current mode. ' +
'Use any tool in your tool list directly without asking the user for permission. ' +
'If a command fails, it failed for a real reason (syntax error, test failure, missing dependency, etc.) — not because of permissions. ' +
'Never ask the user to approve or deny tool calls. Just use tools directly.'
```

Apply this replacement at all 4 locations.

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors (string-only change)

- [ ] **Step 4: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "fix: replace misleading 'all tools auto-approved' system prompt with accurate text"
```

---

### Task 5: Persist Permission Decisions to RLM Database

**Why:** `permission:decided` events are emitted (permission-manager.ts:596,610) but have zero listeners. Session-scoped and once-scoped decisions are in-memory only and lost on restart. Only "always" rules persist to `~/.orchestrator/permissions.json`. We need an audit trail.

**Key types (verified):** `PermissionDecision` (permission-manager.ts:204-217) has fields: `request: PermissionRequest`, `action`, `matchedRule?`, `fromCache`, `reason`, `decidedAt`. `PermissionRequest` has `instanceId` (line 184) and `context?.toolName` (line 191). There is no `sessionId` — we'll use `request.instanceId` for querying.

**Files:**
- Create: `src/main/security/permission-decision-store.ts`
- Create: `src/main/security/__tests__/permission-persistence.spec.ts`
- Modify: `src/main/security/permission-manager.ts` (subscribe to own events)
- Modify: `src/main/persistence/rlm/rlm-schema.ts` (add migration 008)

- [ ] **Step 1: Add RLM migration for permission_decisions table**

In `src/main/persistence/rlm/rlm-schema.ts`, add migration 008 to the `MIGRATIONS` array:

```typescript
{
  name: '008_permission_decisions',
  up: `
    CREATE TABLE IF NOT EXISTS permission_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      resource TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('allow', 'deny', 'ask')),
      decided_by TEXT,
      rule_id TEXT,
      reason TEXT,
      tool_name TEXT,
      is_cached INTEGER NOT NULL DEFAULT 0,
      decided_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_perm_decisions_instance ON permission_decisions(instance_id);
    CREATE INDEX idx_perm_decisions_scope ON permission_decisions(scope);
    CREATE INDEX idx_perm_decisions_created ON permission_decisions(created_at);
  `,
  down: `
    DROP TABLE IF EXISTS permission_decisions;
  `,
},
```

- [ ] **Step 2: Write the failing test**

Create `src/main/security/__tests__/permission-persistence.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PermissionDecisionStore } from '../permission-decision-store.js';

describe('PermissionDecisionStore', () => {
  let store: PermissionDecisionStore;
  let mockRun: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRun = vi.fn();
    mockAll = vi.fn().mockReturnValue([]);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ run: mockRun, all: mockAll }),
    };
    store = new PermissionDecisionStore(mockDb as never);
  });

  it('should record a permission decision', () => {
    store.record({
      instanceId: 'inst-1',
      scope: 'file_write',
      resource: '/tmp/test.txt',
      action: 'allow',
      decidedBy: 'user',
      toolName: 'Write',
      decidedAt: '2026-04-04T10:00:00Z',
    });

    expect(mockRun).toHaveBeenCalledWith(
      'inst-1',       // instance_id
      'file_write',   // scope
      '/tmp/test.txt', // resource
      'allow',        // action
      'user',         // decided_by
      null,           // rule_id
      null,           // reason
      'Write',        // tool_name
      0,              // is_cached
      '2026-04-04T10:00:00Z' // decided_at
    );
  });

  it('should query decisions by instance', () => {
    store.getByInstance('inst-1');
    expect(mockAll).toHaveBeenCalledWith('inst-1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/security/__tests__/permission-persistence.spec.ts`
Expected: FAIL — `PermissionDecisionStore` does not exist

- [ ] **Step 4: Implement PermissionDecisionStore**

Create `src/main/security/permission-decision-store.ts`:

```typescript
import type { Database } from 'better-sqlite3';
import { getLogger } from '../logging/logger.js';

const logger = getLogger('PermissionDecisionStore');

export interface PermissionDecisionRecord {
  instanceId: string;
  scope: string;
  resource: string;
  action: 'allow' | 'deny' | 'ask';
  decidedBy?: string;
  ruleId?: string;
  reason?: string;
  toolName?: string;
  isCached?: boolean;
  decidedAt: string;
}

export class PermissionDecisionStore {
  constructor(private db: Database) {}

  record(decision: PermissionDecisionRecord): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO permission_decisions
          (instance_id, scope, resource, action, decided_by, rule_id, reason, tool_name, is_cached, decided_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        decision.instanceId,
        decision.scope,
        decision.resource,
        decision.action,
        decision.decidedBy ?? null,
        decision.ruleId ?? null,
        decision.reason ?? null,
        decision.toolName ?? null,
        decision.isCached ? 1 : 0,
        decision.decidedAt
      );
    } catch (err) {
      logger.error('Failed to record permission decision', err as Error);
    }
  }

  getByInstance(instanceId: string): PermissionDecisionRecord[] {
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM permission_decisions WHERE instance_id = ? ORDER BY created_at DESC'
      );
      return stmt.all(instanceId) as PermissionDecisionRecord[];
    } catch (err) {
      logger.error('Failed to query permission decisions', err as Error);
      return [];
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/security/__tests__/permission-persistence.spec.ts`
Expected: PASS

- [ ] **Step 6: Wire store into PermissionManager**

In `src/main/security/permission-manager.ts`, add a private field and setter:

```typescript
private decisionStore?: PermissionDecisionStore;

setDecisionStore(store: PermissionDecisionStore): void {
  this.decisionStore = store;
}
```

Add import:

```typescript
import { PermissionDecisionStore } from './permission-decision-store.js';
```

In the constructor (or `initialize()` method), add a listener for the existing `permission:decided` event:

```typescript
this.on('permission:decided', (decision: PermissionDecision) => {
  if (this.decisionStore) {
    this.decisionStore.record({
      instanceId: decision.request.instanceId ?? 'unknown',
      scope: decision.request.scope,
      resource: decision.request.resource,
      action: decision.action,
      decidedBy: decision.matchedRule?.source,
      ruleId: decision.matchedRule?.id,
      reason: decision.reason,
      toolName: decision.request.context?.toolName,
      isCached: decision.fromCache,
      decidedAt: new Date(decision.decidedAt).toISOString(),
    });
  }
});
```

- [ ] **Step 7: Run typecheck and tests**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npx vitest run src/main/security/__tests__/permission-persistence.spec.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/security/permission-decision-store.ts src/main/security/__tests__/permission-persistence.spec.ts src/main/security/permission-manager.ts src/main/persistence/rlm/rlm-schema.ts
git commit -m "feat: persist permission decisions to RLM database with audit trail"
```

---

### Task 6: Wire Token Budget Enforcement into Execution Path

**Why:** `TokenBudgetTracker.checkBudget()` (token-budget-tracker.ts:44) is 100% dead code. It returns `BudgetAction.STOP` but nothing in the execution chain calls it. The path `sendInput()` → `adapter.sendInput()` (instance-communication.ts:360) has zero budget check. `CompactionCoordinator.getBudgetTracker()` (compaction-coordinator.ts:238) instantiates trackers but never invokes `checkBudget()`.

**Files:**
- Modify: `src/main/instance/instance-communication.ts` (~line 355, add budget check before `adapter.sendInput()`, and ~line 37 add optional deps)
- Test: `src/main/context/__tests__/budget-enforcement.spec.ts`

- [ ] **Step 1: Write the test for existing tracker logic**

Create `src/main/context/__tests__/budget-enforcement.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetTracker, BudgetAction } from '../token-budget-tracker.js';

describe('TokenBudgetTracker enforcement behavior', () => {
  let tracker: TokenBudgetTracker;

  beforeEach(() => {
    tracker = new TokenBudgetTracker({ totalBudget: 10000 });
  });

  it('should return CONTINUE when under budget', () => {
    const result = tracker.checkBudget({ turnTokens: 5000 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
  });

  it('should return STOP when turn tokens exceed 90% of budget', () => {
    const result = tracker.checkBudget({ turnTokens: 9500 });
    expect(result.action).toBe(BudgetAction.STOP);
    expect(result.reason).toBeDefined();
  });

  it('should return STOP on diminishing returns after 3+ continuations', () => {
    tracker.recordContinuation(1000);
    tracker.recordContinuation(800);
    tracker.recordContinuation(200); // delta < 500 after 3 continuations
    const result = tracker.checkBudget({ turnTokens: 3000 });
    expect(result.action).toBe(BudgetAction.STOP);
    expect(result.reason).toContain('diminishing');
  });
});
```

- [ ] **Step 2: Run test to verify it passes (validates existing tracker logic)**

Run: `npx vitest run src/main/context/__tests__/budget-enforcement.spec.ts`
Expected: PASS

- [ ] **Step 3: Add optional budget deps to CommunicationDependencies**

In `src/main/instance/instance-communication.ts`, add to the `CommunicationDependencies` interface (~line 37):

```typescript
getBudgetTracker?: (instanceId: string) => TokenBudgetTracker | undefined;
getContextUsage?: (instanceId: string) => ContextUsage | undefined;
```

Add imports:

```typescript
import { TokenBudgetTracker, BudgetAction } from '../context/token-budget-tracker.js';
```

These are optional (`?`) so existing construction in `instance-manager.ts:150` doesn't break.

- [ ] **Step 4: Add budget check before adapter.sendInput()**

In `sendInput()` method, just before the line `await adapter.sendInput(finalMessage, attachments)` (~line 360), insert:

```typescript
// Budget enforcement: check before API call
const budgetTracker = this.deps.getBudgetTracker?.(instanceId);
if (budgetTracker) {
  const contextUsage = this.deps.getContextUsage?.(instanceId);
  const turnTokens = contextUsage?.used ?? 0;
  const budgetCheck = budgetTracker.checkBudget({ turnTokens });

  if (budgetCheck.action === BudgetAction.STOP) {
    logger.warn('Token budget exceeded, halting before API call', {
      instanceId,
      reason: budgetCheck.reason,
      turnTokens,
    });

    // Push a system message so user sees why execution stopped
    const message: OutputMessage = {
      type: 'system',
      content: `Token budget limit reached: ${budgetCheck.reason}. ${budgetCheck.nudgeMessage ?? 'Consider starting a new conversation.'}`,
      timestamp: Date.now(),
    };
    instance.outputBuffer.push(message);
    this.emit('output', { instanceId, message });

    return; // Do NOT call adapter.sendInput
  }
}
```

- [ ] **Step 5: Wire the dependency in instance-manager.ts**

In `src/main/instance/instance-manager.ts` at the `InstanceCommunicationManager` construction (~line 150), add:

```typescript
getBudgetTracker: (id) => {
  try {
    return getCompactionCoordinator().getBudgetTracker(id);
  } catch {
    return undefined;
  }
},
getContextUsage: (id) => {
  const inst = this.state.getInstance(id);
  return inst?.contextUsage;
},
```

Add the import:

```typescript
import { getCompactionCoordinator } from '../context/compaction-coordinator.js';
```

- [ ] **Step 6: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run src/main/context/__tests__/budget-enforcement.spec.ts`
Expected: PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-communication.ts src/main/instance/instance-manager.ts src/main/context/__tests__/budget-enforcement.spec.ts
git commit -m "feat: wire token budget enforcement into sendInput execution path"
```

---

### Task 7: Persist Workflow Execution State

**Why:** `WorkflowManager.executions` (workflow-manager.ts:24) is `Map<string, WorkflowExecution>` — RAM only. A crash mid-workflow loses all progress, gate decisions, and phase data.

**Key types (verified):** `WorkflowExecution` (workflow.types.ts:66-93) has fields: `id`, `instanceId`, `templateId`, `currentPhaseId`, `phaseStatuses: Record<string, WorkflowPhaseStatus>`, `phaseData: Record<string, PhaseData>`, `pendingGate?`, `startedAt: number`, `completedAt?: number`, `agentInvocations: number`, `totalTokens: number`, `totalCost: number`.

**Files:**
- Create: `src/main/workflows/workflow-persistence.ts`
- Create: `src/main/workflows/__tests__/workflow-persistence.spec.ts`
- Modify: `src/main/workflows/workflow-manager.ts`
- Modify: `src/main/persistence/rlm/rlm-schema.ts` (add migration 009)

- [ ] **Step 1: Add RLM migration for workflow_executions table**

In `src/main/persistence/rlm/rlm-schema.ts`, add migration 009:

```typescript
{
  name: '009_workflow_executions',
  up: `
    CREATE TABLE IF NOT EXISTS workflow_executions (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'completed', 'cancelled', 'failed')),
      current_phase_id TEXT,
      phase_statuses_json TEXT NOT NULL DEFAULT '{}',
      phase_data_json TEXT NOT NULL DEFAULT '{}',
      pending_gate_json TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      agent_invocations INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      total_cost REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_wf_exec_instance ON workflow_executions(instance_id);
    CREATE INDEX idx_wf_exec_status ON workflow_executions(status);
  `,
  down: `
    DROP TABLE IF EXISTS workflow_executions;
  `,
},
```

Note: `started_at` and `completed_at` are `INTEGER` (Unix timestamps) matching the `number` type in `WorkflowExecution`.

- [ ] **Step 2: Write the failing test**

Create `src/main/workflows/__tests__/workflow-persistence.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowPersistence } from '../workflow-persistence.js';
import type { WorkflowExecution } from '../../../shared/types/workflow.types.js';

describe('WorkflowPersistence', () => {
  let persistence: WorkflowPersistence;
  let mockRun: ReturnType<typeof vi.fn>;
  let mockAll: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRun = vi.fn();
    mockAll = vi.fn().mockReturnValue([]);
    mockGet = vi.fn().mockReturnValue(undefined);
    const mockDb = {
      prepare: vi.fn().mockReturnValue({ run: mockRun, all: mockAll, get: mockGet }),
    };
    persistence = new WorkflowPersistence(mockDb as never);
  });

  it('should save a workflow execution', () => {
    const execution: WorkflowExecution = {
      id: 'exec-1',
      instanceId: 'inst-1',
      templateId: 'tmpl-1',
      currentPhaseId: 'phase-1',
      phaseStatuses: { 'phase-1': 'active' },
      phaseData: {},
      startedAt: 1712200000000,
      agentInvocations: 0,
      totalTokens: 0,
      totalCost: 0,
    };

    persistence.save(execution);
    expect(mockRun).toHaveBeenCalledWith(
      'exec-1',      // id
      'inst-1',      // instance_id
      'tmpl-1',      // template_id
      'active',      // status
      'phase-1',     // current_phase_id
      expect.any(String), // phase_statuses_json
      expect.any(String), // phase_data_json
      null,          // pending_gate_json (no pending gate)
      1712200000000, // started_at
      null,          // completed_at
      0,             // agent_invocations
      0,             // total_tokens
      0,             // total_cost
    );
  });

  it('should load active executions', () => {
    persistence.loadActive();
    expect(mockAll).toHaveBeenCalled();
  });

  it('should load by id', () => {
    persistence.loadById('exec-1');
    expect(mockGet).toHaveBeenCalledWith('exec-1');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/workflows/__tests__/workflow-persistence.spec.ts`
Expected: FAIL — `WorkflowPersistence` does not exist

- [ ] **Step 4: Implement WorkflowPersistence**

Create `src/main/workflows/workflow-persistence.ts`:

```typescript
import type { Database } from 'better-sqlite3';
import type { WorkflowExecution } from '../../shared/types/workflow.types.js';
import { getLogger } from '../logging/logger.js';

const logger = getLogger('WorkflowPersistence');

export class WorkflowPersistence {
  constructor(private db: Database) {}

  save(execution: WorkflowExecution): void {
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO workflow_executions
          (id, instance_id, template_id, status, current_phase_id,
           phase_statuses_json, phase_data_json, pending_gate_json,
           started_at, completed_at, agent_invocations, total_tokens, total_cost,
           updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      const status = execution.completedAt ? 'completed' : 'active';
      stmt.run(
        execution.id,
        execution.instanceId,
        execution.templateId,
        status,
        execution.currentPhaseId ?? null,
        JSON.stringify(execution.phaseStatuses),
        JSON.stringify(execution.phaseData),
        execution.pendingGate ? JSON.stringify(execution.pendingGate) : null,
        execution.startedAt,
        execution.completedAt ?? null,
        execution.agentInvocations,
        execution.totalTokens,
        execution.totalCost,
      );
    } catch (err) {
      logger.error('Failed to save workflow execution', err as Error);
    }
  }

  loadById(id: string): WorkflowExecution | undefined {
    try {
      const stmt = this.db.prepare('SELECT * FROM workflow_executions WHERE id = ?');
      const row = stmt.get(id) as Record<string, unknown> | undefined;
      return row ? this.deserialize(row) : undefined;
    } catch (err) {
      logger.error('Failed to load workflow execution', err as Error);
      return undefined;
    }
  }

  loadActive(): WorkflowExecution[] {
    try {
      const stmt = this.db.prepare("SELECT * FROM workflow_executions WHERE status = 'active' ORDER BY started_at DESC");
      const rows = stmt.all() as Record<string, unknown>[];
      return rows.map(row => this.deserialize(row));
    } catch (err) {
      logger.error('Failed to load active executions', err as Error);
      return [];
    }
  }

  loadByInstance(instanceId: string): WorkflowExecution[] {
    try {
      const stmt = this.db.prepare('SELECT * FROM workflow_executions WHERE instance_id = ? ORDER BY started_at DESC');
      const rows = stmt.all(instanceId) as Record<string, unknown>[];
      return rows.map(row => this.deserialize(row));
    } catch (err) {
      logger.error('Failed to load executions for instance', err as Error);
      return [];
    }
  }

  private deserialize(row: Record<string, unknown>): WorkflowExecution {
    return {
      id: row.id as string,
      instanceId: row.instance_id as string,
      templateId: row.template_id as string,
      currentPhaseId: (row.current_phase_id as string) ?? '',
      phaseStatuses: JSON.parse((row.phase_statuses_json as string) || '{}'),
      phaseData: JSON.parse((row.phase_data_json as string) || '{}'),
      pendingGate: row.pending_gate_json ? JSON.parse(row.pending_gate_json as string) : undefined,
      startedAt: row.started_at as number,
      completedAt: (row.completed_at as number) ?? undefined,
      agentInvocations: row.agent_invocations as number,
      totalTokens: row.total_tokens as number,
      totalCost: row.total_cost as number,
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/workflows/__tests__/workflow-persistence.spec.ts`
Expected: PASS

- [ ] **Step 6: Wire persistence into WorkflowManager**

In `src/main/workflows/workflow-manager.ts`, add:

```typescript
import { WorkflowPersistence } from './workflow-persistence.js';

// Private field:
private persistence?: WorkflowPersistence;

// Setter (called during app initialization when RLM database is available):
setPersistence(persistence: WorkflowPersistence): void {
  this.persistence = persistence;
}

// Private helper:
private persistExecution(execution: WorkflowExecution): void {
  if (!this.persistence) return;
  try {
    this.persistence.save(execution);
  } catch (err) {
    logger.error('Failed to persist workflow execution', err instanceof Error ? err : undefined);
  }
}
```

Then add `this.persistExecution(execution)` calls at the end of:
- `startWorkflow()` — after `this.executions.set(execution.id, execution)` (~line 90)
- `completePhase()` — after phase status update (~line 145)
- `satisfyGate()` — after gate response stored (~line 200)
- `skipPhase()` — after skip (~line 345)
- `cancelWorkflow()` — after cancel (~line 425)

- [ ] **Step 7: Run typecheck and all workflow tests**

Run: `npx tsc --noEmit && npx vitest run src/main/workflows/`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/main/workflows/workflow-persistence.ts src/main/workflows/__tests__/workflow-persistence.spec.ts src/main/workflows/workflow-manager.ts src/main/persistence/rlm/rlm-schema.ts
git commit -m "feat: persist workflow execution state to RLM database"
```

---

### Task 8: Activate ToolListFilter for Proactive Tool Pool Filtering

**Why:** `ToolListFilter` (tool-list-filter.ts) with `filterForModel()` exists but is never instantiated outside tests. Tools are only restricted via `--disallowedTools` CLI flag — the model still sees all tools in its context, wasting tokens. We need to also pre-filter the tool definitions sent via `--allowedTools` or by removing denied tools from the tool list parameter.

**Approach:** In `instance-lifecycle.ts`, after building the `disallowedTools` array (~line 697), construct a `ToolListFilter` and store it on the spawn options. Then in the Claude CLI adapter, use it to filter tool definitions before inclusion in the API request. Since the Claude CLI adapter uses `--allowedTools` and `--disallowedTools` flags (not raw tool definitions), the proactive filter should be applied to the `allowedTools` list if one is being built, or we should build an explicit `allowedTools` list that excludes denied tools.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` (~line 697)
- Test: `src/main/instance/__tests__/tool-pool-filtering.spec.ts`

- [ ] **Step 1: Write the test**

Create `src/main/instance/__tests__/tool-pool-filtering.spec.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ToolListFilter } from '../../tools/tool-list-filter.js';
import type { DenyRule } from '../../tools/tool-list-filter.js';

describe('ToolListFilter integration with agent permissions', () => {
  it('should filter tools based on deny rules from agent permissions', () => {
    const denyRules: DenyRule[] = [
      { pattern: 'Write', type: 'blanket' },
      { pattern: 'Edit', type: 'blanket' },
      { pattern: 'NotebookEdit', type: 'blanket' },
    ];
    const filter = new ToolListFilter(denyRules);

    const allTools = [
      { id: 'Read', description: 'Read files' },
      { id: 'Write', description: 'Write files' },
      { id: 'Edit', description: 'Edit files' },
      { id: 'Glob', description: 'Find files' },
      { id: 'NotebookEdit', description: 'Edit notebooks' },
      { id: 'Bash', description: 'Run commands' },
    ];

    const filtered = filter.filterForModel(allTools);
    expect(filtered.map(t => t.id)).toEqual(['Read', 'Glob', 'Bash']);
  });

  it('should handle MCP tool namespace patterns', () => {
    const denyRules: DenyRule[] = [
      { pattern: 'mcp__dangerous', type: 'blanket' },
    ];
    const filter = new ToolListFilter(denyRules);

    const tools = [
      { id: 'mcp__dangerous__tool1', description: 'Dangerous tool' },
      { id: 'mcp__safe__tool1', description: 'Safe tool' },
    ];

    const filtered = filter.filterForModel(tools);
    expect(filtered.map(t => t.id)).toEqual(['mcp__safe__tool1']);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (validates existing ToolListFilter logic)**

Run: `npx vitest run src/main/instance/__tests__/tool-pool-filtering.spec.ts`
Expected: PASS

- [ ] **Step 3: Build ToolListFilter in instance-lifecycle.ts**

In `src/main/instance/instance-lifecycle.ts`, at ~line 697 where `disallowedTools` is built, add after it:

```typescript
import { ToolListFilter } from '../tools/tool-list-filter.js';
import type { DenyRule } from '../tools/tool-list-filter.js';

// Build a proactive filter for pre-filtering tool definitions
const denyRules: DenyRule[] = disallowedTools.map(tool => ({
  pattern: tool,
  type: 'blanket' as const,
}));
const toolFilter = new ToolListFilter(denyRules);
```

Store `toolFilter` in the spawn options or instance metadata so it's available when assembling tool lists. Add a `toolFilter?: ToolListFilter` field to `UnifiedSpawnOptions` in `src/main/cli/adapters/adapter-factory.ts` if needed, or pass it as instance metadata.

The `--disallowedTools` flag remains as defense-in-depth — the proactive filter reduces token waste, while the CLI flag is the safety backstop.

- [ ] **Step 4: Apply the same pattern at the other 3 locations**

At lines ~1532, ~1700, ~1859 where `disallowedTools` is also built during agent switching, apply the same `ToolListFilter` construction pattern.

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts src/main/instance/__tests__/tool-pool-filtering.spec.ts
git commit -m "feat: activate ToolListFilter for proactive tool pool filtering"
```

---

### Task 9: Create Harness Invariant Test Suite

**Why:** No tests verify that safety properties survive configuration changes. We need tests that act as guardrails — if someone modifies system prompts, permission configs, or tool settings, these tests catch regressions.

**Key note (verified):** `BashValidator` is NOT a singleton — it's constructed with `new BashValidator()`. `PermissionManager` has `_resetForTesting()` (permission-manager.ts:420).

**Files:**
- Create: `src/main/security/__tests__/harness-invariants.spec.ts`

- [ ] **Step 1: Write harness invariant tests**

Create `src/main/security/__tests__/harness-invariants.spec.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolPermissionChecker } from '../tool-permission-checker.js';
import { BashValidator } from '../bash-validator.js';
import { PermissionManager } from '../permission-manager.js';
import { getDisallowedTools } from '../../../shared/utils/permission-mapper.js';
import type { AgentToolPermissions } from '../../../shared/types/agent.types.js';

/**
 * Harness Invariant Tests
 *
 * These tests codify safety properties that must hold regardless of
 * configuration changes to system prompts, tool configs, or permission
 * settings. If any of these fail after a harness change, the change
 * has broken a safety guarantee.
 */
describe('Harness Safety Invariants', () => {
  beforeEach(() => {
    ToolPermissionChecker._resetForTesting();
    PermissionManager._resetForTesting();
  });

  describe('Destructive tool detection always active', () => {
    it('should flag rm as destructive', () => {
      const checker = ToolPermissionChecker.getInstance();
      expect(checker.isDestructive('rm')).toBe(true);
    });

    it('should flag delete as destructive', () => {
      const checker = ToolPermissionChecker.getInstance();
      expect(checker.isDestructive('delete')).toBe(true);
    });

    it('should not flag read operations as destructive', () => {
      const checker = ToolPermissionChecker.getInstance();
      expect(checker.isDestructive('Read')).toBe(false);
      expect(checker.isDestructive('Glob')).toBe(false);
      expect(checker.isDestructive('Grep')).toBe(false);
    });
  });

  describe('Bash validator blocks known-dangerous commands', () => {
    let validator: BashValidator;

    beforeEach(() => {
      validator = new BashValidator();
    });

    it('should block rm -rf /', () => {
      const result = validator.validate('rm -rf /');
      expect(result.risk).toBe('dangerous');
    });

    it('should block mkfs commands', () => {
      const result = validator.validate('mkfs.ext4 /dev/sda1');
      expect(result.risk).toBe('dangerous');
    });

    it('should allow safe commands like ls', () => {
      const result = validator.validate('ls -la');
      expect(result.risk).toBe('safe');
    });
  });

  describe('Permission system denies by mode', () => {
    it('should disallow Write/Edit/NotebookEdit in plan mode', () => {
      const planPermissions: AgentToolPermissions = {
        read: 'allow',
        write: 'deny',
        bash: 'ask',
        web: 'allow',
        task: 'allow',
      };
      const disallowed = getDisallowedTools(planPermissions);
      expect(disallowed).toContain('Write');
      expect(disallowed).toContain('Edit');
      expect(disallowed).toContain('NotebookEdit');
    });

    it('should disallow Bash when bash is deny', () => {
      const restricted: AgentToolPermissions = {
        read: 'allow',
        write: 'deny',
        bash: 'deny',
        web: 'deny',
        task: 'deny',
      };
      const disallowed = getDisallowedTools(restricted);
      expect(disallowed).toContain('Bash');
      expect(disallowed).toContain('WebFetch');
      expect(disallowed).toContain('WebSearch');
    });

    it('should never disallow Read/Glob/Grep in any standard mode', () => {
      const modes: AgentToolPermissions[] = [
        { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' },
        { read: 'allow', write: 'deny', bash: 'ask', web: 'allow', task: 'allow' },
        { read: 'allow', write: 'deny', bash: 'deny', web: 'deny', task: 'deny' },
      ];
      for (const perms of modes) {
        const disallowed = getDisallowedTools(perms);
        expect(disallowed).not.toContain('Read');
        expect(disallowed).not.toContain('Glob');
        expect(disallowed).not.toContain('Grep');
      }
    });
  });

  describe('System-level permission rules block sensitive paths', () => {
    it('should deny writes to /etc', () => {
      const pm = PermissionManager.getInstance();
      const decision = pm.checkPermission({
        instanceId: 'test',
        scope: 'file_write',
        resource: '/etc/passwd',
      });
      expect(decision.action).toBe('deny');
    });

    it('should deny access to SSH keys', () => {
      const pm = PermissionManager.getInstance();
      const decision = pm.checkPermission({
        instanceId: 'test',
        scope: 'file_read',
        resource: '/home/user/.ssh/id_rsa',
      });
      expect(decision.action).toBe('deny');
    });
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/main/security/__tests__/harness-invariants.spec.ts`
Expected: PASS — these tests codify existing behavior as invariants

- [ ] **Step 3: Verify regression detection**

Temporarily comment out `'rm'` from the destructive patterns in `tool-permission-checker.ts` and verify the test fails. Then revert.

- [ ] **Step 4: Commit**

```bash
git add src/main/security/__tests__/harness-invariants.spec.ts
git commit -m "test: add harness invariant test suite for safety property regression detection"
```

---

## Integration Notes

- **Task 5 (migration 008) and Task 7 (migration 009)** both add RLM migrations. If implemented in parallel worktrees, coordinate migration numbering when merging.
- **Task 3** creates the `applySpecialistConstraints` function and returns overrides via IPC. The frontend must apply these when configuring instances — that's a renderer-side change outside this plan's scope.
- **Task 6** uses optional deps (`getBudgetTracker?`) so it's backward-compatible with existing callers.
- **Task 8** keeps `--disallowedTools` flag as defense-in-depth alongside the proactive filter.

## Verification

After all tasks are complete, run the full suite:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run test
```
