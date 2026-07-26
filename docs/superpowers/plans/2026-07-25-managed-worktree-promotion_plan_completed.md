# Managed Worktree Promotion Implementation Plan

Status: completed and independently verified

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make interactive Loop Mode use AIO-managed worktrees by default and durably drive every managed terminal run to promoted, blocked, or preserved cleanup.

**Architecture:** Extend the existing LoopState/loop_runs record with a structured worktree lifecycle, add a fast-forward-only promotion primitive to the existing serialized Git integration module, and use one lifecycle finalizer from runtime termination and boot recovery. Renderer history and terminal summaries consume the same lifecycle projection.

**Tech Stack:** TypeScript, Electron main process, Angular 21 signals, Zod 4 contracts, better-sqlite3-compatible `SqliteDriver`, Git CLI via `execFile`, Vitest.

## Global Constraints

- Do not create a feature branch or Git worktree.
- Preserve all unrelated dirty-tree changes.
- Agents do not create unmanaged worktrees; AIO may create and own `<repo>/.worktrees/*`.
- Promotion is local-only, fast-forward-only, and never pushes.
- Dirty, divergent, conflicted, or unexpectedly checked-out bases are not modified.
- Existing Campaign, repo-job, branch-select, and manual Worktrees semantics remain compatible.
- Every production behavior is preceded by a focused failing test.
- Active spec and plan remain untracked until all implementation and verification gates pass.

---

### Task 1: Lifecycle Contracts and Persistence

**Files:**
- Modify: `src/shared/types/loop-state.types.ts`
- Modify: `src/shared/types/loop-stream.types.ts`
- Modify: `src/shared/types/loop.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `src/main/orchestration/loop-schema.ts`
- Modify: `src/main/orchestration/loop-store.ts`
- Test: `src/main/orchestration/loop-schema.spec.ts`
- Test: `src/main/orchestration/loop-store.spec.ts`

**Interfaces:**
- Produces: `LoopWorktreeLifecyclePhase`
- Produces: `LoopWorktreeLifecycle`
- Produces: `LoopStore.updateWorktreeLifecycle(loopRunId, lifecycle)`
- Produces: `LoopStore.getPendingWorktreeLifecycles()`
- Extends: `LoopState.worktreeLifecycle?`
- Extends: `LoopRunSummary.worktreeLifecycle?`

- [x] **Step 1: Write schema migration and round-trip tests**

Add failing tests that upgrade a version-15 database, preserve its existing rows, persist a lifecycle object, and return it from `getRunSummary`, `listRunsForChat`, and `getPendingWorktreeLifecycles`.

Use a literal lifecycle fixture:

```ts
const lifecycle = {
  phase: 'blocked',
  baseBranch: 'main',
  sessionBranch: 'task-example',
  integrationBranch: 'integration/main',
  lastError: 'root checkout has uncommitted changes',
  updatedAt: 1234,
} as const;
```

- [x] **Step 2: Run focused persistence tests and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-schema.spec.ts src/main/orchestration/loop-store.spec.ts
```

Expected failure: lifecycle types/column/store methods do not exist.

- [x] **Step 3: Add lifecycle types and Zod schemas**

Define:

```ts
export type LoopWorktreeLifecyclePhase =
  | 'acquired'
  | 'harvesting'
  | 'harvested'
  | 'integrating'
  | 'integrated'
  | 'promoting'
  | 'promoted'
  | 'blocked'
  | 'preserved'
  | 'cleaned';

export interface LoopWorktreeLifecycle {
  phase: LoopWorktreeLifecyclePhase;
  baseBranch: string;
  sessionBranch: string;
  integrationBranch?: string;
  lastError?: string;
  updatedAt: number;
}
```

Mirror it in `LoopWorktreeLifecycleSchema`, add the optional field to `LoopStateSchema` and `LoopRunSummarySchema`, and export it through existing loop type barrels.

- [x] **Step 4: Add migration 16 and store APIs**

Set `LOOP_SCHEMA_VERSION = 16` and add:

```sql
ALTER TABLE loop_runs ADD COLUMN worktree_lifecycle_json TEXT;
```

Write lifecycle JSON on insert/update, parse it defensively in summaries, expose pending terminal lifecycle records, and change `clearWorktreeInfo` to clear only `worktree_path` while retaining branch/lifecycle recovery metadata.

- [x] **Step 5: Run focused persistence tests and confirm GREEN**

Run the Step 2 command. Expected: all selected tests pass with no new warnings.

### Task 2: Safe Base-Branch Promotion

**Files:**
- Modify: `src/main/workspace/git/worktree-integration.ts`
- Modify: `src/main/workspace/git/worktree-manager.ts`
- Test: `src/main/workspace/git/worktree-integration.spec.ts`
- Test: `src/main/workspace/git/worktree-manager.spec.ts`

**Interfaces:**
- Produces:

```ts
export type BasePromotionResult =
  | { status: 'promoted'; method: 'checked-out-ff' | 'update-ref'; tip: string }
  | { status: 'already-promoted'; tip: string }
  | { status: 'blocked'; reason: string };

export function promoteIntegrationBranch(
  repoRoot: string,
  baseBranch: string,
  integrationBranch: string,
): Promise<BasePromotionResult>;
```

- Extends `WorktreeManager.integrateWorktree()` result with `promotion`.

- [x] **Step 1: Write real-git promotion tests**

Add failing tests for:

1. clean root checked out on `main` fast-forwards and updates its files;
2. dirty root returns `blocked` and preserves both dirty content and `main`;
3. divergent base returns `blocked`;
4. base checked out in a non-root worktree returns `blocked`;
5. unchecked base advances through compare-and-swap `update-ref`;
6. already-promoted base is idempotent.

- [x] **Step 2: Run promotion tests and confirm RED**

Run:

```bash
rtk npx vitest run src/main/workspace/git/worktree-integration.spec.ts
```

Expected failure: `promoteIntegrationBranch` is not exported.

- [x] **Step 3: Implement promotion through GitWriteQueue**

Use `git worktree list --porcelain`, `git status --porcelain`, `merge-base --is-ancestor`, and:

```ts
git(['merge', '--ff-only', integrationBranch], repoRoot)
```

for a clean root checkout, or compare-and-swap `update-ref` when the base is unchecked. Return blocked results rather than throwing for expected unsafe conditions.

- [x] **Step 4: Wire WorktreeManager and preserve compatibility**

Have `integrateWorktree` call the new promotion function when requested. Keep `tryAdvanceBaseBranch` as a boolean compatibility wrapper for callers/tests that still use it.

- [x] **Step 5: Run promotion/manager tests and confirm GREEN**

Run:

```bash
rtk npx vitest run src/main/workspace/git/worktree-integration.spec.ts src/main/workspace/git/worktree-manager.spec.ts
```

Expected: selected tests pass; root mutation occurs only in clean fast-forward cases.

### Task 3: Durable Runtime Finalizer

**Files:**
- Create: `src/main/orchestration/loop-worktree-lifecycle.ts`
- Modify: `src/main/orchestration/loop-worktree-termination-cleanup.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/ipc/handlers/loop-handlers.ts`
- Test: `src/main/orchestration/loop-worktree-lifecycle.spec.ts`
- Test: `src/main/orchestration/loop-coordinator-auto-integration.e2e.spec.ts`
- Test: `src/main/orchestration/loop-coordinator-abandon-preserve.e2e.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface RuntimeWorktreeFinalizerInput {
  state: LoopState;
  status: LoopState['status'];
  worktreeSessionId: string;
  manager: WorktreeManager;
  transition: (lifecycle: LoopWorktreeLifecycle) => void;
}

export function finalizeRuntimeLoopWorktree(
  input: RuntimeWorktreeFinalizerInput,
): Promise<void>;
```

- [x] **Step 1: Write finalizer transition tests**

Add failing tests that assert observable lifecycle transitions and outcomes:

- successful clean run ends `cleaned` after `promoted`;
- promotion block ends `blocked`, retains branch metadata, and removes a clean worktree;
- harvest failure with dirty files ends `blocked` and retains the worktree;
- cancelled run records `preserved` then `cleaned` without integration.

- [x] **Step 2: Run finalizer tests and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-worktree-lifecycle.spec.ts
```

Expected failure: finalizer module is absent.

- [x] **Step 3: Implement the lifecycle finalizer**

Extract phase transitions from `cleanupLoopWorktreeAfterTerminate`. Persist each transition through the supplied callback before moving to the next phase. Treat expected promotion blocks as durable outcomes, not swallowed warnings.

- [x] **Step 4: Initialize and broadcast lifecycle state**

When `LoopCoordinator` acquires a worktree, record `baseBranch`, `sessionBranch`, and `acquired`. Pass a transition callback into terminal cleanup that updates `state.worktreeLifecycle` and emits:

```ts
{
  loopRunId: state.id,
  state: this.cloneStateForBroadcast(state),
  lifecycleOnly: true,
}
```

Update `loop-handlers.ts` so lifecycle-only terminal broadcasts persist and reach the renderer but do not append duplicate terminal transcript summaries or duplicate outstanding items.

- [x] **Step 5: Strengthen real-git E2E assertions**

Change the success E2E test to assert the agent file is present on `main`, `integration/main` is contained by `main`, and the worktree/session branch are gone. Keep the cancelled preservation test.

- [x] **Step 6: Run focused unit and slow tests and confirm GREEN**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-worktree-lifecycle.spec.ts
rtk npm run test:slow -- src/main/orchestration/loop-coordinator-auto-integration.e2e.spec.ts src/main/orchestration/loop-coordinator-abandon-preserve.e2e.spec.ts
```

### Task 4: Restart Recovery Before Reaping

**Files:**
- Create: `src/main/orchestration/loop-worktree-lifecycle-reconcile.ts`
- Modify: `src/main/orchestration/loop-worktree-reconcile.ts`
- Modify: `src/main/app/initialization-steps.ts`
- Test: `src/main/orchestration/loop-worktree-lifecycle-reconcile.spec.ts`
- Test: `src/main/orchestration/loop-worktree-reconcile.spec.ts`

**Interfaces:**
- Produces:

```ts
export interface LifecycleReconcileResult {
  promoted: number;
  blocked: number;
  preserved: number;
  reaped: number;
  total: number;
}

export function reconcilePendingWorktreeLifecycles(
  store: WorktreeLifecycleStore,
): Promise<LifecycleReconcileResult>;
```

- [x] **Step 1: Write real-git recovery tests**

Construct terminal loop rows and real branches/worktrees for:

- crash after harvest but before integration;
- crash after integration but before promotion;
- missing worktree with surviving session branch;
- dirty worktree whose harvest fails;
- dirty base causing a durable blocked result without base mutation;
- non-success terminal branch preservation.

- [x] **Step 2: Run recovery tests and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-worktree-lifecycle-reconcile.spec.ts
```

Expected failure: reconciler module/API does not exist.

- [x] **Step 3: Implement idempotent recovery**

Use the persisted branch names and lifecycle phase. Integrate with `integrateIntoSharedBranch`, promote with `promoteIntegrationBranch`, update lifecycle after each phase, and only then call compatible orphan reaping. Never require the original in-memory `WorktreeSession`.

- [x] **Step 4: Run lifecycle recovery before compatibility orphan cleanup**

In the `Loop store` initialization step:

```ts
await reconcilePendingWorktreeLifecycles(service.store);
await reconcileOrphanedWorktrees(service.store);
```

Ensure compatibility reconciliation excludes lifecycle rows it must not destroy.

- [x] **Step 5: Run recovery/reconcile tests and confirm GREEN**

Run:

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-worktree-lifecycle-reconcile.spec.ts src/main/orchestration/loop-worktree-reconcile.spec.ts
```

### Task 5: Interactive Default and Operator Visibility

**Files:**
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.ts`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.html`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.scss`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.spec.ts`
- Modify: `src/renderer/app/core/state/loop-store.types.ts`
- Modify: `src/renderer/app/core/state/loop-store-recent-runs.ts`
- Modify: `src/renderer/app/core/state/loop.store.ts`
- Modify: `src/renderer/app/features/loop/loop-past-runs-panel.component.ts`
- Modify: `src/renderer/app/features/loop/loop-past-runs-panel.component.spec.ts`
- Create: `src/renderer/app/features/loop/loop-worktree-lifecycle.util.ts`
- Create: `src/renderer/app/features/loop/loop-worktree-lifecycle.util.spec.ts`

**Interfaces:**
- Produces:

```ts
export function worktreeLifecycleLabel(
  lifecycle: LoopWorktreeLifecyclePayload | undefined,
): { tone: 'neutral' | 'success' | 'warning'; text: string } | null;
```

- [x] **Step 1: Write failing config and label tests**

Assert:

- default `buildConfig()` contains `isolateLoopWorkspaces: true`;
- toggling managed isolation off emits false;
- lifecycle labels use the base/session branches and blocked reason;
- live terminal lifecycle-only updates replace the summary lifecycle;
- persisted past-run rows render the lifecycle message.

- [x] **Step 2: Run renderer tests and confirm RED**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/loop/loop-config-panel.component.spec.ts src/renderer/app/features/loop/loop-worktree-lifecycle.util.spec.ts src/renderer/app/features/loop/loop-past-runs-panel.component.spec.ts src/renderer/app/core/state/loop.store.spec.ts
```

- [x] **Step 3: Add managed-isolation control**

Add `managedIsolation = signal(true)`, an Advanced checkbox, and:

```ts
isolateLoopWorkspaces: this.managedIsolation(),
```

to `buildConfig()`.

- [x] **Step 4: Project lifecycle into summaries**

Carry `worktreeLifecycle` through `loopStateToRunSummary`, `LoopFinalSummary`, and `LoopStore.applyState`. Lifecycle-only terminal events update the existing summary rather than dropping the final iteration snapshot.

- [x] **Step 5: Render lifecycle status**

Use the pure label helper in the just-ended summary and past-runs list. Show blocked state with the warning palette and promoted state with success styling.

- [x] **Step 6: Run renderer tests and confirm GREEN**

Run the Step 2 command.

### Task 6: Global Instruction Clarification

**Files:**
- Modify: `/Users/suas/AGENTS.md`
- Modify: `/Users/suas/.codex/AGENTS.md`
- Modify: `/Users/suas/.agents/AGENTS.md`
- Modify: `/Users/suas/.claude/CLAUDE.md`

**Interfaces:**
- Produces: identical “Managed Worktree Exception” policy across all active runtimes.

- [x] **Step 1: Read each full instruction file and locate the existing policy**

Confirm whether files are identical or have runtime-specific surrounding text. Do not overwrite unrelated instructions.

- [x] **Step 2: Amend the existing rule**

Clarify that unmanaged agent-created branches/worktrees remain forbidden unless explicitly requested, while an AIO-supplied `.worktrees/*` working directory is orchestrator-owned and must be used as-is.

- [x] **Step 3: Verify instruction consistency**

Compare only the managed-worktree policy blocks and confirm the semantic rules are identical. Do not print unrelated or sensitive instruction content.

### Task 7: Verification, Fresh-Eyes Gate, and Documentation Closure

**Files:**
- Update/rename: `docs/superpowers/specs/2026-07-25-managed-worktree-promotion_spec_planned.md`
- Update/rename: `docs/superpowers/plans/2026-07-25-managed-worktree-promotion_plan.md`

**Interfaces:**
- Produces completed filenames only after every automated gate and fresh-agent gate passes.

- [x] **Step 1: Run focused suites**

Run all Task 1–5 focused unit and slow commands again from the final source state.

- [x] **Step 2: Run canonical project gates**

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run test:quiet
```

- [x] **Step 3: Inspect repository state**

Confirm no unrelated files were overwritten, no new worktree/branch was created, and active plan/spec remain untracked.

- [x] **Step 4: Run fresh-agent completion gate**

Start a genuinely fresh agent context. Require the `task-completion-gate` skill and an independent review of acceptance criteria, merge-base-to-HEAD plus working-tree diff, architecture, tests, Git safety, persistence/recovery, UI state, accessibility, and instruction policy.

- [x] **Step 5: Fix findings and repeat**

For every actionable finding, add a failing regression test where applicable, implement the correction, rerun relevant gates, and start another fresh completion-gate pass. Continue until `VERDICT: PASS`.

- [x] **Step 6: Close documentation lifecycle**

Record as-built notes and verification evidence. Rename:

```text
2026-07-25-managed-worktree-promotion_plan.md
  -> 2026-07-25-managed-worktree-promotion_plan_completed.md

2026-07-25-managed-worktree-promotion_spec_planned.md
  -> 2026-07-25-managed-worktree-promotion_spec_completed.md
```

Update the spec link to the completed plan filename. Verify both completed documents remain untracked because James did not authorize a commit.

## As-Built Notes

- Interactive Loop Mode now defaults to AIO-managed isolation while preserving an explicit opt-out.
- AIO durably reserves ownership before any Git branch/worktree mutation. Managed lifecycle rows carry `managedByAio`, the exact session-tip OID, the exact integration-tip OID, phase, branch names, errors, and timestamps.
- Runtime and boot recovery use the same persisted phase model. Safety-critical Git inspection fails closed; resumable provider-limit rows are excluded; missing-directory recovery requires exact ref identity.
- Shared integration branches have a parallel AIO ownership ref. Existing integration-looking branches are never adopted implicitly, and promotion requires the live tip, ownership tip, and persisted expected tip to agree.
- Worktree removal requires canonical `.worktrees/` containment plus a live path/branch association. Caller-supplied worktrees never gain managed ownership, and ambiguous lifecycle-null legacy rows are preserve-only.
- Session branch deletion is ancestry-checked, exact-tip checked, compare-and-swap, and serialized. Temporary integration cleanup and database pointer clearing are verified and retryable.
- Terminal and history UI show sanitized lifecycle outcomes. Blocked asynchronous outcomes use assertive alert semantics; successful/preserved outcomes use polite status semantics.
- The four global runtime policy files contain the same narrow AIO-managed-worktree exception.

## Verification Evidence

- `rtk npx tsc --noEmit` — passed.
- `rtk npx tsc --noEmit -p tsconfig.spec.json` — passed.
- `rtk npm run lint` — passed.
- `rtk npm run check:ts-max-loc` — passed.
- Focused lifecycle, ownership, recovery, Git, persistence, and UI suites — passed.
- Slow real-Git success and cancellation E2Es — 2/2 passed.
- Final full quiet suite — 1,584 files / 15,765 tests passed.
- `rtk git diff --check` — passed.
- Six fresh completion-gate passes were run after successive fixes; the final independent result was `VERDICT: PASS` with no findings.
- No branch, worktree, commit, push, or deployment was created by this implementation session.
