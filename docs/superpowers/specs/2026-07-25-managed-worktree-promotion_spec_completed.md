# Managed Worktree Promotion Specification

Status: completed and independently verified
Date: 2026-07-25
Owner: James
Implementation plan: [2026-07-25-managed-worktree-promotion_plan_completed.md](../plans/2026-07-25-managed-worktree-promotion_plan_completed.md)

## Purpose

Make AIO-owned worktree isolation the normal path for interactive Loop Mode while ensuring every managed terminal run reaches one explicit, durable outcome:

1. successful work is harvested, integrated, safely promoted to its base branch, and cleaned up;
2. a dirty/divergent/conflicted base is left untouched and shown as a recoverable blocked promotion;
3. unsuccessful work is harvested to a durable session branch and its worktree is cleaned up;
4. crashes resume the recorded lifecycle instead of merely deleting the worktree.

This does not authorize agents to create arbitrary feature branches or worktrees. AIO creates and owns managed worktrees under `<repo>/.worktrees/`; agents work inside the directory AIO supplies.

## Current Failure

The existing isolation engine is present and tested, but interactive Loop Mode does not set `isolateLoopWorkspaces`, whose compatibility default is false. Automations opt in, while normal interactive loops usually run in the operator checkout.

On successful isolated termination, the current code harvests work and merges it into `integration/<base>`. It only advances the base ref when that branch is not checked out anywhere. Because `main` is normally checked out in the root worktree, promotion usually stops at `integration/main`. Cleanup is fire-and-forget and boot reconciliation harvests/reaps terminal worktrees without retrying integration or promotion.

The resulting safety property is “work is preserved,” not “work reaches the base branch or visibly blocks.”

## Scope

### Included

- Interactive Loop Mode defaults to AIO-managed worktree isolation.
- The Loop Mode advanced panel exposes an explicit managed-isolation checkbox, default on.
- The existing automation default remains on and explicit false remains respected.
- A persisted lifecycle records phase, base/session/integration branches, last error, and timestamps.
- Successful runs execute `harvest -> integrate -> promote -> cleanup`.
- Clean checked-out base branches are fast-forwarded through a queued `git merge --ff-only`.
- Unchecked base branches are fast-forwarded with compare-and-swap `update-ref`.
- Dirty, divergent, conflicted, or unexpectedly checked-out bases become `blocked`.
- Blocked state is visible in the terminal summary and past-runs UI.
- Startup recovery resumes pending successful lifecycles before orphan cleanup.
- Non-success terminal runs preserve a harvested session branch and reap the worktree.
- Global agent instructions distinguish forbidden unmanaged worktree creation from permitted AIO-owned managed worktrees.

### Excluded

- Pushing branches or commits to a remote.
- Automatically resolving merge conflicts.
- Adopting arbitrary `.claude/worktrees`, sibling-directory worktrees, or branches AIO did not register.
- Changing Campaign, branch-select, repo-job, or manual Worktrees-screen semantics except where they reuse a backward-compatible Git helper.
- Deleting pre-existing branches or worktrees.

## Design Options Considered

### A. Persisted lifecycle in the existing loop store (selected)

Add a JSON lifecycle column to `loop_runs`, update it at each transition, and resume pending phases during Loop store initialization. Reuse `GitWriteQueue`, shared-branch integration, and the existing terminal cleanup path.

Advantages: smallest architecture change; lifecycle is colocated with the loop that owns it; recovery already starts from this store; renderer history already reads loop summaries.

Trade-off: loop-store and loop-state contracts gain one structured field.

### B. New global workspace lease database

Move all worktree ownership into a new database shared by loops, campaigns, repo jobs, and manual worktrees.

Advantages: one future system for every worktree producer.

Trade-off: substantially larger migration and coordination surface; unnecessary to correct interactive Loop Mode now.

### C. Agent-enforced cleanup only

Continue relying on global instructions that tell agents to integrate and delete their own branches.

Rejected: instructions are advisory, cannot recover after process exit, and caused the unmanaged-worktree incident this change is intended to prevent.

## Lifecycle Contract

`LoopWorktreeLifecycle` contains:

- `phase`: `acquired | harvesting | harvested | integrating | integrated | promoting | promoted | blocked | preserved | cleaned`
- `baseBranch`: branch from which the managed worktree was created
- `sessionBranch`: AIO-created `task-*` branch
- `integrationBranch`: normally `integration/<baseBranch>`, once known
- `lastError`: operator-readable reason when blocked or when a retryable operation fails
- `updatedAt`: epoch milliseconds

Transitions:

```text
acquired
  -> harvesting
  -> harvested
      -> integrating
      -> integrated
          -> promoting
          -> promoted
              -> cleaned

Any successful-path unsafe condition -> blocked
Any non-success terminal state -> preserved -> cleaned
Harvest failure with dirty files -> blocked, worktree retained
```

Every transition is persisted before the next destructive action. A cleanup operation may clear `worktree_path`, but it must not clear lifecycle or branch metadata.

## Promotion Rules

Promotion is local-only and fast-forward-only.

1. Resolve the current base and integration tips.
2. Require the base to be an ancestor of the integration tip.
3. Inspect all live worktrees for the base branch.
4. If the base is checked out in the repository root:
   - require the root worktree to be clean;
   - require its current branch to equal the recorded base branch;
   - serialize `git merge --ff-only <integrationBranch>` through `GitWriteQueue`.
5. If the base is not checked out anywhere:
   - compare-and-swap the ref with `git update-ref refs/heads/<base> <integration-tip> <old-base-tip>`.
6. If the base is checked out in another worktree, dirty, missing, or divergent, return `blocked` without altering the checkout.

Promotion success means the base branch contains the integration tip. It does not mean anything was pushed.

## Runtime Termination

Terminal cleanup remains asynchronous relative to the immediate terminal UI transition, but is no longer opaque:

- The coordinator initializes `worktreeLifecycle` when it acquires a managed worktree.
- The cleanup worker receives a transition callback.
- Each callback mutates the terminal `LoopState`, persists it through the normal state-change seam, and broadcasts a lifecycle-only update.
- Lifecycle-only updates do not append duplicate terminal transcript summaries or duplicate outstanding-item capture.
- On clean promotion, the worktree and merged session branch are removed.
- On promotion block/conflict, the clean worktree is removed to prevent disk leaks while the durable session/integration branches and blocked metadata remain.
- On harvest failure with dirty files, the worktree remains.

## Startup Recovery

Before generic orphan reaping:

1. Query terminal managed runs whose lifecycle is not `cleaned`.
2. For successful runs:
   - harvest a still-present dirty worktree;
   - integrate the recorded session branch idempotently;
   - retry safe promotion;
   - record `promoted` or `blocked`;
   - reap only after work is committed to a durable branch.
3. For non-success runs:
   - harvest if needed;
   - record `preserved`;
   - reap the worktree while retaining the session branch.
4. Missing worktree directories do not prevent integration/promotion when the recorded session branch exists.
5. A failed harvest with remaining dirty files leaves the pointer and directory intact.

The existing orphan reconciler remains as a compatibility fallback for pre-lifecycle rows.

## User Interface

### Loop configuration

Add an Advanced checkbox:

`Managed worktree isolation`

It defaults on and submits `isolateLoopWorkspaces: true`. Turning it off is explicit and affects only that run.

### Terminal summary and past runs

Show a compact lifecycle line for managed runs:

- `Worktree: promoting to main…`
- `Worktree: promoted to main and cleaned up`
- `Worktree: blocked — root checkout has uncommitted changes`
- `Worktree: partial work preserved on task-…`

Blocked styling uses the existing warning palette. The message must name the base or branch but never include secrets or arbitrary command output.

## Instruction Policy

Global branch/worktree policy becomes:

- Agents must not create feature branches or worktrees unless James explicitly requests an unmanaged one.
- AIO itself may create a managed worktree under `.worktrees/` and set it as the session working directory.
- When already inside an AIO-managed worktree, the agent must work there and must not create another branch/worktree.
- AIO owns harvest, integration, promotion, and cleanup.
- Agents must not manually delete or bypass AIO lifecycle metadata.

The existing rule protecting pre-existing user/session work remains unchanged.

## Compatibility

- `isolateLoopWorkspaces` remains optional in IPC and persisted configs.
- Existing saved configs without the property still parse.
- The renderer explicitly supplies the new default for new interactive runs.
- Existing loop rows have no lifecycle JSON and continue through compatibility orphan reconciliation.
- Existing callers of `tryAdvanceBaseBranch` retain a compatibility wrapper.
- Campaign, repo-job, branch-select, and manual Worktrees flows are unchanged.

## Testing

### Unit

- Interactive config emits managed isolation by default and respects explicit off.
- Promotion fast-forwards a clean checked-out `main`.
- Promotion blocks without mutation on a dirty root.
- Promotion blocks on divergent history or another-worktree checkout.
- Loop-store migration preserves existing rows and lifecycle round-trips.
- Run summaries include lifecycle metadata.
- Renderer lifecycle labels cover pending, promoted, blocked, preserved, and absent states.

### Real-git integration

- Successful isolated loop lands the agent file on `main`, not only `integration/main`, and reaps its worktree/session branch.
- Dirty root causes a visible blocked lifecycle while preserving both root edits and the session/integration result.
- Restart recovery integrates/promotes a recorded terminal run before reaping.
- Cancelled run harvests and preserves its session branch, then reaps.

### Final gates

Run the canonical TypeScript, lint, LOC, unit, and slow focused suites. Then run a fresh-agent `task-completion-gate` review and repeat until `VERDICT: PASS`.

## Acceptance Criteria

1. New interactive loops default to AIO-managed isolation.
2. Agents cannot mistake AIO-managed worktrees for permission to create arbitrary worktrees.
3. A clean successful loop fast-forwards its local base branch and removes its managed worktree/session branch.
4. A dirty/divergent/conflicted base is never modified and is visibly blocked with durable recovery metadata.
5. Restart recovery retries unfinished integration/promotion before reaping.
6. Non-success work survives on a branch without leaving a worktree directory.
7. Existing non-loop and manually managed worktree flows remain compatible.
8. No push, force-push, destructive reset, or pre-existing branch/worktree deletion occurs.

## As-Built Result

All eight acceptance criteria are implemented and verified. The final design is stricter than the initial specification in four safety-sensitive areas:

1. AIO records ownership intent before `git worktree add`, closing the acquisition crash window.
2. Session and integration branches carry exact expected OIDs; name reuse or ref rewriting blocks recovery and promotion.
3. Shared integration branches require a matching AIO ownership ref, so an existing user-owned `integration/<base>` branch is never adopted or mutated.
4. Lifecycle-null legacy rows are preserve-only because their historical ownership cannot be proven safely.

The final independent completion gate returned `VERDICT: PASS` with no actionable findings after reproducing both TypeScript checks, lint, LOC, focused and slow real-Git tests, the 1,584-file / 15,765-test full suite, diff checks, ownership boundaries, recovery behavior, and UI accessibility.
