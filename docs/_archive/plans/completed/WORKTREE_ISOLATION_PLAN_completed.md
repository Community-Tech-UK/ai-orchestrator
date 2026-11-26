# Worktree Isolation Plan (v4)

Owner: James · Status: ping-pong pass — working-tree seam, fail-closed isolation, and BLOCKED.md cross-loop gap closed · Last updated: 2026-06-20

How we give every concurrent AIO session its own isolated workspace, with the
orchestrator owning the full create/integrate/reap lifecycle so nothing scatters,
nothing collides, and no human runs a cleanup script.

## What the fresh-eyes review changed (v1 to v2)

A line-by-line code review found a load-bearing wrong assumption and several
blockers in v1. The corrections, all verified against source:

- **v1's seam was wrong.** v1 set `config.workspaceCwd` to the per-session worktree.
  But `workspaceCwd` is overloaded: besides the spawn cwd, it is the root of the
  loop's durable state (`.aio-loop-state/<runId>/` at `loop-artifact-paths.ts:68`),
  the crash-recovery anchor (`loop-control.ts`, boot reconcile in
  `initialization-steps.ts`), and the cross-loop memory key. `terminate()` deliberately
  keeps `.aio-loop-state` (it cleans only attachments and control). Reaping the worktree
  would delete the loop's own iteration log, notes, and recovery intents. v2 keeps
  `workspaceCwd` pinned to the repo root and introduces a separate `executionCwd` that
  points at the worktree and is used only as the spawn cwd.
- **Agents do not commit.** `AGENTS.md:34` ("NEVER commit or push unless the user
  explicitly asks") means sessions leave their work uncommitted in the worktree. v1's
  reaper keyed on "merged," which is never reached, and `--force` removal would delete
  the agent's real output. v2 adds an explicit harvest step (the orchestrator commits
  the worktree's changes to the session branch) and makes reap refuse a dirty tree.
- **Two factual errors fixed.** `branch-freshness`/`stale-branch-policy` measure
  ahead/behind versus the origin upstream (`@{u}`, `rev-list --left-right`), not
  "merged into local `main`," so the reaper needs its own `git merge-base --is-ancestor`
  primitive. And the single-worktree `WORKTREE_*` IPC handlers are in fact implemented
  in `verification-ipc-handler.ts`; only `WORKTREE_DELETE/LIST/GET_STATUS` and the event
  channels are missing.
- **Deps choice needs more than a clone.** The two workspace symlinks are relative
  (`node_modules/@ai-orchestrator/* -> ../../packages/*`), so a clone preserves isolation,
  but only if we copy symlinks as symlinks. More important, this repo has Electron-ABI-tied
  native modules (`better-sqlite3` and others) governed by `scripts/verify-native-abi.js`
  and `scripts/rebuild-native-modules.js`. A clone plus "install only if the lockfile
  changed" skips that rebuild and can silently ship the wrong ABI. v2 requires a
  per-worktree ABI verify/rebuild and a same-volume fallback.
- **Smaller corrections:** the health monitor emits `worktree:stale` at 48h, it does not
  itself remove; the install command is `npm install --prefer-offline`.

## What the gap-closing pass changed (v2 to v3)

A second review verified seven loose ends against source. Each is now resolved in the plan
below; the source-grounded findings:

- **P1 is bigger than v2 said — the agent reads loop state via RELATIVE paths.** v2 listed
  P1 touch points as `loop-artifact-paths.ts`, `loop-control.ts`, `initialization-steps.ts`,
  and the memory key, implying control/state are already absolute. Only *some* are.
  `loop-artifact-paths.ts:40` exposes `relDir` (`.aio-loop-state/<runId>`, a workspace-relative
  POSIX path), and `loop-stage-machine.ts:400-407` derives every agent-visible path variable
  (`stageRel/notesRel/logRel/tasksRel/doneRel/blockedRel/reportRel/outstandingRel`) from it,
  embedding them throughout the prompt (`:417-532`, `:550-634`). The prompt text at `:507`
  literally tells the agent the files are "relative to your working directory." `loop-attachments.ts:79`
  does the same for attachment paths. The moment cwd becomes the worktree, every one of these
  resolves into the worktree instead of the root, so the agent reads/writes the wrong files and
  the backend never sees them. `ORCHESTRATOR_LOOP_CONTROL_FILE` (`loop-control.ts:141`) is the
  only agent-visible path already absolute. **Fix:** P1 must convert `relDir` and all prompt
  path variables to absolute (anchored at `workspaceCwd`), add `loop-stage-machine.ts` and
  `loop-attachments.ts` to the touch points, and the P1 acceptance test must assert agent-visible
  paths resolve to the root state dir when cwd is the worktree.
- **P4 changes shared methods used by 5 callers — make the new behavior opt-in.** `mergeWorktree`,
  `cleanupWorktree`, and `abandonWorktree` are called from `default-invokers.ts` (branch-select:
  create/merge/abandon at `:924,978,992`), `parallel-worktree-coordinator.ts` (`:217,251,349,468`),
  `repo-job-service.ts` (create/complete at `:447,493`), `campaign-coordinator.ts` (create only
  `:206`), and `verification-ipc-handler.ts` (the renderer path, `:54-185`). branch-select and the
  parallel coordinator both rely on merge mutating the root checkout and on cleanup removing a
  worktree that still holds commits; flipping cleanup to refuse-dirty or moving merge off-root
  unconditionally would break them. **Fix:** the refuse-dirty/harvest/dedicated-integration-worktree
  behavior is gated behind an explicit option (e.g. `reap({ requireClean: true })` / a new
  `reapWorktree` used only by the isolation path), leaving existing callers on today's semantics
  until they are migrated (open question 3). P4 is no longer a blanket behavior change.
- **The root-`main` commit guard (Decision B) is safe — verified, with one constraint.** The app
  does NOT commit on shutdown (the `src/main/index.ts` `before-quit`/`cleanup` path contains no git
  writes). The only orchestrator commit is `commitWorktreeChanges` (`default-invokers.ts:841`) during
  loop branch-select, and it already commits inside a *worktree* (not root `main`) AND passes
  `--no-verify`. There are no existing git hooks (`.git/hooks` holds only samples; no husky /
  simple-git-hooks). So a pre-commit/pre-push guard on root `main` blocks none of AIO's own paths.
  **Constraint:** the new harvest commit (Decision C) must likewise use `--no-verify` and commit on
  the session branch in the worktree, so it stays consistent and never trips the guard.
- **Injected singleton is promoted from open question to a P4 task.** Confirmed: the constructor
  calls `startHealthMonitor()` unconditionally, arming a 5-minute `setInterval` at first
  `getInstance()` (`worktree-manager.ts:47-51,519-521`). Tests currently dodge it by mocking the
  manager, but since P4 rewrites this file anyway, making it injected (and not arming the monitor at
  import) lands there.
- **Harvest staging is scoped, not `git add -A`.** Because durable state now lives at the root
  (not the worktree), the worktree only contains real code changes — but harvest must still respect
  `.gitignore` and avoid staging stray build output. Decision C is updated accordingly.
- **Stale-event removal and execFile migration are safe.** No code listens for `worktree:stale`
  (zero listeners found), so removing the 48h signal breaks nothing. The `execFile` switch is internal
  to `WorktreeManager`; no caller observes the change.
- **P0 is a one-time operation, not a reproducible code phase.** It references live state ("3 live
  sessions", "4 merged worktrees") that will have changed by implementation time. Treat it as an
  operational runbook step, decoupled from the code phases P1-P8.

## What the second fresh-eyes pass changed (v3 to v4)

A third review re-verified v3's own line numbers and hunted for new issues. Two blockers and
several should-fixes, all confirmed against source:

- **Schema migration was unstated (blocker).** `loop-schema.ts` uses a versioned `MIGRATIONS`
  array (`LOOP_SCHEMA_VERSION = 8`; columns are added with `ALTER TABLE loop_runs ADD COLUMN ...`,
  precedent at versions 3-4). v3 said `loop_runs` "gains" columns without saying how — on existing
  DBs that requires a new **version 9** migration plus a version bump. P3 now specifies it.
- **"Only seam that changes" was self-contradictory (blocker).** Target architecture called the
  executionCwd thread "the only seam that changes," but P1 rewrites every agent-visible path.
  Corrected to "the only *execution* seam; P1 also rewrites all agent-visible state paths."
- **Terminal-failure worktrees were undefined (should-fix).** Decision C covered only success
  (harvest) and explicit abandon, but the loop has many non-success terminal states
  (`failed/error/cancelled/no-progress/cap-reached/provider-limit/...` in `loop.types.ts`).
  Decision C now defines: any non-success terminal status preserves the tree (branch/stash) before
  reap; reap never force-removes a dirty tree.
- **Prompt copy must change with the paths (should-fix).** `loop-stage-machine.ts:507` tells the
  agent its files are "relative to your working directory." When P1 makes those paths absolute, the
  copy becomes wrong — P1 now includes updating that prompt wording.
- **`gc.auto 0` needs a compensating gc (should-fix).** Disabling auto-gc on the shared `.git`
  grows it unboundedly; P5 now schedules a periodic full `git gc` through the write queue.
- **Re-verification correction.** A reviewer claimed `repo-job-service.ts` "does not exist"; a direct
  check confirms it DOES (`src/main/repo-jobs/repo-job-service.ts:447,493,494`), so the P4 caller
  matrix stands unchanged.
- **P1 is safe to ship ungated.** Absolute paths resolve identically when cwd == workspaceCwd, so
  non-isolated loops are unaffected by the path rewrite — only the prompt wording needed fixing.

## What the ping-pong pass changed (v4 to v5)

A cross-model review surfaced three blocking gaps, all verified against live code:

- **P2 underspecified the session working-tree seam (blocker).** v4 described P2 as threading
  `executionCwd` only to `workingDirectory` (the CLI spawn cwd). The live coordinator stack has
  additional root-bound readers: `default-invokers.ts:1431,1496-1500` snapshots and diffs
  `p.workspaceCwd` before/after each iteration; `loop-coordinator-completion-gates.ts:190,200`
  feeds fresh-eyes review from `collectWorkspaceDiff(state.config.workspaceCwd)`; and
  `loop-pingpong-completion.ts:247,263` does the same for ping-pong review. When isolation is
  active, the agent edits the worktree while these surfaces still inspect the repo root — they
  will routinely report zero changes, corrupting no-progress detection and reviewer context.
  P2 is expanded: **every surface that reads the session's working-tree state must use
  `executionCwd`**, not just the spawn path. Touch points and acceptance criterion updated.
- **No fail-closed behavior when worktree acquire/restore fails (blocker).** The plan promised
  "every session executes in its own worktree" and "N loops yield N worktrees," but
  `loop-coordinator.ts:751-756` silently falls back to the repo root when `createWorktree`
  fails, and `:962-975` clears a missing `executionCwd` on restore without error. A silent
  fallback recreates the exact collision/data-loss class isolation is meant to prevent — now
  invisibly. Decision D now requires that when `isolateLoopWorkspaces` is true, any start or
  resume that cannot provide a valid worktree surfaces a block/error rather than silently
  degrading to the shared root.
- **Legacy root `BLOCKED.md` fallback is a cross-loop control-state breach (blocker).**
  `loop-coordinator-state-helpers.ts:175-176` returns both the scoped per-run path and
  `<workspaceCwd>/BLOCKED.md`. A stale root `BLOCKED.md` (from a prior run or concurrent
  loop) can pause the wrong loop. P1 is updated to gate this fallback: when isolation is
  active the root fallback is skipped; `loop-coordinator-state-helpers.ts` is added to P1
  touch points and its acceptance criterion extended.

## TL;DR

We are not building a workspace manager from scratch. `WorktreeManager`,
`ParallelWorktreeCoordinator`, branch-freshness/stale-branch policy, the `WORKTREE_*`
IPC handlers, and a worktree UI all exist. The gap is that ordinary loop sessions still
run in the shared repo root, and the existing manager has real defects (shell-interpolated
git, unconditional `--force` reap, merge inside the root checkout).

The work is to isolate the agent's execution into a per-session worktree without moving
the loop's durable state, harvest the agent's uncommitted output before reaping, harden
the manager, add a serialized git-write path, and kill the per-worktree cold install.

## Goals

- Every loop session executes in its own worktree under one canonical, gitignored root.
- The loop's durable state, recovery anchor, and memory identity stay at the repo root and
  are never reaped.
- No session's output is ever lost: the orchestrator harvests uncommitted work before any
  removal, and reap refuses a dirty tree.
- The orchestrator owns acquire, harvest, integrate, and reap. No human-run step.
- Spin-up is near-instant, so four sessions in parallel beat one at a time.
- Concurrent git across worktrees does not lose work.

## Non-goals (for now)

- Containerising sessions. Rejected for this stack (container-use is early; Electron plus
  native modules in a container means X11/DISPLAY, chrome-sandbox, electron-rebuild, and
  Docker-for-Mac socket limits, while sessions run electron smoke checks). Revisit only if
  sessions become untrusted/multi-tenant or move to the cloud.
- A pnpm migration as a blocker. We want it (Decision A) but it is a tracked follow-up.

## Current state (grounded)

What exists, with the warts that matter (all confirmed in source):

- `src/main/workspace/git/worktree-manager.ts` — `WorktreeManager` singleton.
  `createWorktree / mergeWorktree / completeWorktree / abandonWorktree / cleanupWorktree`.
  Worktrees under `.worktrees/`, branches `task-<slug>-<base36ts>`. Called from
  `repo-job-service`, `parallel-worktree-coordinator`, `campaign-coordinator`,
  `default-invokers` (branch-select), and `verification-ipc-handler`. Not from the normal
  loop-start path.
- `src/main/orchestration/loop-coordinator.ts` — `startLoop(chatId, { initialPrompt,
  workspaceCwd, ... })`. `config.workspaceCwd` flows to the spawned CLI cwd via
  `loop:invoke-iteration` -> `invokeCliTextResponse({ workingDirectory })` (registered in
  `default-invokers.ts`). `isTerminalStatus()` and `terminate()` exist.
- `src/main/orchestration/loop-artifact-paths.ts:68` — loop state at
  `<workspaceCwd>/.aio-loop-state/<loopRunId>/` (STAGE/NOTES/ITERATION_LOG/LOOP_TASKS/
  BLOCKED/OUTSTANDING). The agent is handed a cwd-relative path to this, assuming
  cwd == workspaceCwd.
- `src/main/orchestration/loop-control.ts` — control comms under
  `<workspaceCwd>/.aio-loop-control/<runId>/`, surfaced to the agent via the
  `ORCHESTRATOR_LOOP_CONTROL_FILE` env var (absolute). Boot recovery re-derives this path
  from the persisted `config.workspaceCwd`.
- `src/main/git/branch-freshness.ts` + `stale-branch-policy.ts` — ahead/behind versus the
  origin upstream `@{u}`. No merged-into-main check. Not reusable for the reaper as-is.
- `src/main/workspace/git/vcs-manager.ts` — the safe git path (`execFile`, array args).
- IPC: most single-worktree `WORKTREE_*` handlers are implemented in
  `verification-ipc-handler.ts`; `WORKTREE_DELETE/LIST/GET_STATUS` and the event channels
  are not.

Defects to fix:

1. `WorktreeManager` uses `promisify(exec)` with shell string interpolation for every git
   call (`worktree-manager.ts:123,440,497,501`). Fragile and injection-prone; `VcsManager`
   already shows the safe pattern.
2. The merge path runs `git checkout / pull --ff-only / rebase / merge` with `cwd: repoRoot`
   (`worktree-manager.ts:412-453`), mutating and racing the root checkout.
3. `cleanupWorktree` runs `git worktree remove --force` unconditionally
   (`worktree-manager.ts:497`), discarding uncommitted work. Combined with agents not
   committing, this is the primary data-loss path.
4. The health monitor emits `worktree:stale` at `maxAgeHours: 48` but performs no removal
   (`worktree-manager.ts:519-532`). A future listener that removes on this signal would be
   the classic "auto-cleanup races the agent" bug, so we remove the age signal.
5. `installCommand: 'npm install --prefer-offline'` runs a full install per worktree.
6. No serialized git-write path exists; auto-gc can fire from any worktree's git invocation.

## Target architecture

A workspace is an orchestrator-owned, lifecycle-managed resource, with a hard split
between durable state and ephemeral execution:

- **Durable stays at the root.** `config.workspaceCwd` remains the repo root. Loop state,
  control comms, recovery anchor, and the cross-loop memory key all continue to key off it.
  Nothing durable lives in a reapable directory. The agent receives an absolute path to the
  state/control dirs rather than a cwd-relative one.
- **Execution moves to a worktree.** A new `executionCwd` (the session worktree under
  `<repo>/.worktrees/<loop-id>`) is threaded through `loop:invoke-iteration` to
  `workingDirectory` and becomes the spawned CLI's cwd. This is the only *execution* seam that
  changes — but it forces companion changes: because cwd is no longer the repo root, every
  agent-visible state path (today relative, see P1) must become absolute, and the prompt copy
  that describes them must be updated to match. In addition, **every orchestrator surface that
  reads the session's working-tree state must also use `executionCwd`** — not just the spawn
  path. Specifically: the before/after workspace snapshot and git diff in `default-invokers.ts`
  (`snapshotWorkspaceFiles` / `snapshotFileChangesViaWorkspace` / `snapshotFileChangesViaGit`)
  and the `collectWorkspaceDiff` calls in `loop-coordinator-completion-gates.ts` and
  `loop-pingpong-completion.ts` must all switch to `executionCwd` when isolation is active;
  otherwise they inspect the repo root while the agent edits the worktree, routinely reporting
  zero changes and corrupting no-progress detection and reviewer context.
- **Fail-closed when isolation is requested.** When `isolateLoopWorkspaces` is true, start and
  resume must not silently degrade to the shared root when a worktree cannot be acquired or
  restored. A silent fallback recreates the exact collision/data-loss class isolation is meant
  to prevent — invisibly and without operator awareness. Required behavior: if `createWorktree`
  fails at start, surface a block (write a `BLOCKED.md` with the error and halt the loop);
  if `executionCwd` is missing on restore, surface a block rather than clearing it and
  proceeding. The operator can then inspect, clean up, or re-enable with a fresh worktree.
- **Acquire, harvest, integrate, reap.** On start the orchestrator acquires a worktree on a
  fresh branch off the integration branch. Because agents do not commit, on terminal-success
  the orchestrator harvests (stages and commits the worktree's changes to the session branch)
  so the work is durable and mergeable. On any non-success terminal state (failed, error,
  cancelled, no-progress, cap-reached, provider-limit, etc.) the orchestrator still preserves the
  tree as a branch or stash before reap — no terminal state is allowed to reach a force-remove.
  Integration runs in a dedicated integration worktree, never the root checkout, serialized through
  the git-write gate. Only after the branch is integrated, or the session is abandoned with its tree
  preserved, is the worktree reaped.
- **Reap on truth, never on time.** Reap requires either the branch merged into the
  integration branch (a new `git merge-base --is-ancestor` check, not branch-freshness) or an
  explicit abandon that first stashes/branches any dirty tree. Reap refuses a dirty,
  unharvested worktree. The 48h age signal is removed.
- **A persisted registry.** `loop_runs` gains `worktree_path` and `branch_name` columns (today it
  stores only `workspace_cwd`). These land as a **version 9 entry in the `loop-schema.ts` `MIGRATIONS`
  array** (`ALTER TABLE loop_runs ADD COLUMN worktree_path TEXT; ADD COLUMN branch_name TEXT;`),
  bumping `LOOP_SCHEMA_VERSION` to 9; both columns are nullable so existing rows migrate cleanly. A
  boot reconcile adopts or safely reaps orphaned leases before the existing orphan-intent scan runs.
- **Serialized git-writes plus managed gc.** A single-flight `GitWriteQueue` wraps every orchestrator
  git write with backoff retry on lock errors, and we set `gc.auto 0` so an agent's own `git
  status`/`diff` cannot trigger an unserialized gc on the shared `.git`. Because that disables
  automatic maintenance, the queue also runs a periodic full `git gc` (serialized like any other
  write) so `.git` does not grow unbounded. The gate reduces contention; it cannot fully serialize
  agent-side git, which is acknowledged.
- **Runtime namespacing.** Worktrees isolate files, not ports. `.mise.toml` pins
  `AIO_RENDERER_PORT=4567` for every dir, so any session that starts the renderer or an
  electron smoke check needs a per-session port injected at acquire time.

## Decisions to confirm

**Decision A — node_modules spin-up.** Recommended: on acquire, clone the root `node_modules`
into the worktree with an APFS copy-on-write clone that preserves symlinks (`cp -Rc`), then
(1) assert the two `@ai-orchestrator/*` links are still relative symlinks resolving inside the
worktree, (2) run the existing native-ABI verify and rebuild for the worktree's runtime rather
than gating on lockfile equality, and (3) fall back to a full copy or `npm install` on
`EXDEV`/non-APFS (keep `.worktrees` on the repo's volume; note existing worktrees under
`~/.config/superpowers` sit on another volume and would defeat the reflink). Long-term, migrate
to pnpm with `enableGlobalVirtualStore`; it removes the copy-preservation and duplication
questions, though native modules still need an Electron-ABI build. pnpm is a tracked follow-up,
not a blocker. Rejected: the current cold per-worktree install.

**Decision B — integration topology.** Recommended interim: never run a session with
`executionCwd` at the repo root, run integration in a dedicated integration worktree (never
`cwd: repoRoot`), serialize merges through the gate, and add a pre-commit/pre-push guard against
direct work on root `main`. Optional later: a bare-repo hub where `main` is just another
worktree. The integration-worktree change is pulled forward into the hardening phase, not
deferred, because the current merge path is broken under concurrency.

*Hook safety (verified).* The root-`main` guard is safe against AIO's own commit paths: the app
performs no git writes on shutdown, the only orchestrator commit (`default-invokers.ts:841`,
branch-select) targets a worktree and already passes `--no-verify`, and the repo has no existing
hooks. The guard exists to catch a *human* or an *agent* accidentally committing on the root
checkout. To keep AIO's automation consistent, every orchestrator commit (branch-select and the
new harvest) commits on a branch inside a worktree and passes `--no-verify`. Because P4 makes the
strict reap/merge behavior opt-in (see the caller-impact note in "v2 to v3"), the 5 existing
`WorktreeManager` callers keep today's semantics until migrated individually.

**Decision C — harvest policy (new).** Because agents do not commit, the orchestrator must
capture the worktree's output. Recommended: on terminal-success, auto-commit the worktree's
changes to the session branch (durable, cleanly mergeable, matches how Crystal/container-use
work); on abandon, preserve as a branch or stash before reap. Alternative: keep work as a patch
and never auto-commit. Recommend auto-commit to the session branch only (never to `main`, never
pushed), which stays within `AGENTS.md` since the orchestrator, not the agent, is the committer.

*Staging scope and commit flags.* Harvest does not run a blind `git add -A`. Because P1 moves all
durable loop state (`.aio-loop-state`, `.aio-loop-control`, attachments) out of the worktree and
back to the repo root, the worktree now contains only real code changes — but harvest must still
(a) respect the repo `.gitignore` so build artifacts and any per-worktree `node_modules` are never
staged, and (b) commit with the orchestrator identity and `--no-verify` (consistent with Decision B
and the existing branch-select committer at `default-invokers.ts:841`). Harvest never touches the
root checkout and never pushes.

*Terminal-state coverage.* "Terminal-success" is only one of the loop's terminal states. The loop
status enum (`loop.types.ts`) also includes `failed`, `error`, `cancelled`, `no-progress`,
`cap-reached`, `provider-limit`, `cost-exceeded`, `needs-human-arbitration`, and
`reviewer-unreliable`. Decision C policy by class: **success** → harvest-commit to the session
branch; **every other terminal state** → preserve the worktree's tree as a branch or stash before
reap (the agent's partial work is often the most valuable artifact of a failed run). Reap refuses a
dirty, unharvested/unpreserved tree in all cases — there is no force-remove path on a terminal loop.

**Decision D — fail-closed isolation on acquire/restore failure (new).** When `isolateLoopWorkspaces`
is true the contract "every session runs in its own worktree" must be enforced, not aspirational.
Recommended behavior: if `createWorktree` fails at start, write a `BLOCKED.md` (describing the
error) and halt the loop rather than silently proceeding with the shared root. If `executionCwd` is
missing on restore (crash + manual cleanup), surface a block rather than clearing the field and
continuing. Both cases notify the operator, who can then inspect the workspace and restart the loop.
Alternative (degrade-with-warning): fall back to root but emit a persistent UI warning and require
operator acknowledgement before proceeding. Recommended over the alternative because degraded-but-silent
is what the current code already does; the plan must strengthen the contract if isolation is the goal.
This decision replaces the existing silent fallbacks in `loop-coordinator.ts:751-756` and `:962-975`.

## Phased delivery

Each phase is independently shippable and guarded by an `isolateLoopWorkspaces` flag so it can
land while sessions are live. Order matters: the state decoupling (P1) is a prerequisite for
isolating execution (P2).

| Phase | Outcome | Main touch points |
| --- | --- | --- |
| P0 Stabilise now (one-time op, not a code phase) | The live sessions each in their own worktree; merged worktrees reaped; root `main` committed/stashed | operational runbook, reconcile script already delivered; live counts re-checked at run time |
| P1 Decouple durable state | Loop state/control/recovery/memory key stay at repo root; **every agent-visible path is made absolute** (`relDir` and all prompt path vars) and the prompt copy that says "relative to your working directory" (`loop-stage-machine.ts:507`) is updated to match; legacy root `BLOCKED.md` fallback gated on isolation status | `loop-artifact-paths.ts` (`relDir`), `loop-stage-machine.ts` (prompt path vars + copy at :507), `loop-attachments.ts`, `loop-control.ts`, `initialization-steps.ts`, memory key, `loop-coordinator-state-helpers.ts` (gate root BLOCKED.md fallback) |
| P2 Add executionCwd | Thread `executionCwd` to **all** session working-tree readers (spawn cwd + workspace snapshots + completion-gate diffs + ping-pong diffs); `workspaceCwd` stays root; acquire on start; **fail-closed** when isolation requested and worktree unavailable | `loop-coordinator.ts`, `default-invokers.ts`, `loop-coordinator-completion-gates.ts`, `loop-pingpong-completion.ts`, new `workspace.schemas.ts` |
| P3 Lifecycle + registry + harvest | `loop_runs` gains worktree/branch columns via a **v9 `MIGRATIONS` entry** (bump `LOOP_SCHEMA_VERSION`, nullable cols) + boot reconcile; scoped harvest-commit (`--no-verify`, gitignore-respecting) on success and tree-preserve on non-success before reap; release on terminal | `loop-schema.ts` (v9 migration), `loop-store.ts`, `loop-coordinator.ts`, `worktree-manager.ts` |
| P4 Harden manager | `execFile` everywhere; new `merge-base --is-ancestor` reap check; **opt-in** refuse-dirty reap + dedicated-integration-worktree merge (existing callers keep current semantics); remove age signal; make singleton injected / don't arm health monitor at import | `worktree-manager.ts`, reuse `vcs-manager.ts`; caller-compat audit of the 5 callers |
| P5 Git-write gate | `GitWriteQueue` + backoff; `gc.auto 0` plus a periodic full `git gc` through the queue; scope `GitStatusWatcher` per worktree | new `git-write-queue.ts`, `git-status-watcher.ts` |
| P6 Spin-up perf | clonefile with symlink-preserve assert + per-worktree native-ABI rebuild + same-volume fallback | `worktree-manager.ts` install step, `scripts/verify-native-abi.js` |
| P7 Port namespacing | Per-session `AIO_RENDERER_PORT` for renderer/smoke sessions | acquire path, env injection |
| P8 (optional) Bare hub | `main` becomes a worktree; no privileged root | repo topology + bootstrap |

Acceptance criteria:

- **P1:** terminating a loop leaves `.aio-loop-state/<runId>/` and the control archive intact at
  the repo root; boot recovery still finds prior runs' intents. **And** every agent-visible path
  (the prompt's `*Rel` vars and attachment paths) resolves to the root state dir even when the
  agent's cwd is the worktree, not the root. **And** when `isolateLoopWorkspaces` is true, the
  root `BLOCKED.md` fallback in `loop-coordinator-state-helpers.ts` is skipped (a spec with two
  concurrent loops asserts that a root `BLOCKED.md` does not pause the sibling loop). Covered by
  a recovery spec that runs a loop in a worktree, reaps it, and asserts state and recovery
  survive, plus a path-resolution spec that sets cwd to a worktree and asserts each agent-handed
  path points back into `<workspaceCwd>/.aio-loop-state`.
- **P2:** starting N isolated loops yields N worktrees; each session's CLI spawns with cwd inside
  its worktree while `workspaceCwd` stays the repo root. **And** workspace snapshots and
  `collectWorkspaceDiff` in `default-invokers.ts`, `loop-coordinator-completion-gates.ts`, and
  `loop-pingpong-completion.ts` all read from `executionCwd` when isolation is active (a spec
  asserts that file changes made in the worktree are counted in the iteration delta and appear in
  reviewer diffs). **And** attempting to start or resume an isolated loop when no valid worktree
  is available surfaces a block rather than silently falling back to the shared root (a spec
  asserts that `createWorktree` failure → block state, not silent root fallback).
- **P3:** the v9 migration applies cleanly on a pre-v9 database (existing rows get null
  worktree/branch columns, no data loss); on success the session's changes are committed to its
  branch before reap; on any non-success terminal state the tree is preserved (branch/stash), never
  force-removed; a crash mid-session leaves a registry row that boot reconcile adopts or reaps; no
  orphaned lease.
- **P4:** reap removes a worktree only when its branch is merged or it was abandoned with the
  tree preserved; reap refuses a dirty, unharvested tree; no git call passes user text through a
  shell; integration never runs in the root checkout. **And** the new strict behavior is opt-in:
  the 5 existing callers (branch-select, parallel coordinator, repo-job, campaign, IPC handler)
  keep passing today and importing `WorktreeManager` does not arm the health-monitor interval (a
  spec asserts no timer is created on `getInstance()` / injected construction).
- **P5:** a concurrency stress test (acquire/commit/merge/reap across many worktrees) produces no
  unhandled lock failures, and no auto-gc fires outside the queue.
- **P6:** a fresh worktree is ready well under the current install time, the two workspace
  symlinks remain symlinks resolving inside the worktree, `git status` in the fresh worktree shows
  no spurious modifications from the cloned `node_modules` (i.e. `.gitignore` covers it), and
  `verify-native-abi` passes for the worktree's runtime.
- **P7:** two renderer/smoke sessions run in parallel without a port collision.

## P4 caller-impact matrix (compatibility)

The hardening pass touches `mergeWorktree`/`cleanupWorktree`/`abandonWorktree`, which have five
callers today. The strict reap and dedicated-integration-worktree behaviors are therefore gated
behind an explicit option so none of these break on the day P4 lands; each caller migrates onto the
isolation path on its own schedule (open question 3).

| Caller | Methods | Relies on `--force` cleanup? | Expects root-checkout merge? | Action under P4 |
| --- | --- | --- | --- | --- |
| `default-invokers.ts` (branch-select) `:924,978,992` | create / merge / abandon | Yes — abandons loser worktrees holding commits | Yes (`mergeWorktree(winner)`) | Keep current semantics (no `requireClean`); migrate later |
| `parallel-worktree-coordinator.ts` `:217,251,349,468` | create / complete / merge / abandon | Yes — abandon after merge | Yes (merge under root lock) | Keep current semantics; revisit lock strategy when migrated |
| `repo-job-service.ts` `:447,493` | create / complete | No (cleanup deferred elsewhere) | No (`previewMerge` only) | No change |
| `campaign-coordinator.ts` `:206` | create | No | No | No change |
| `verification-ipc-handler.ts` (renderer): create `:54`, complete `:82`, merge `:134`, cleanup `:161`, abandon `:185` | create/complete/merge/cleanup/abandon | Renderer contract | Renderer expects root merge | No change until renderer updated to handle a `DirtyWorktreeError` and isolated-merge result |

Net: P4 adds new opt-in parameters/methods (e.g. `reap({ requireClean })` or a dedicated
`reapWorktree`) used only by the new loop-isolation lifecycle; the `execFile` migration and stale-event
removal are invisible to all callers. The renderer's missing `WORKTREE_DELETE/LIST/GET_STATUS`
handlers and event emitters (defined in contracts, unimplemented) are tracked separately and are not
on the P4 critical path.

## Risks and mitigations

- **Durable state in a reaped dir (was a blocker).** Fixed structurally by P1: only `executionCwd`
  is ephemeral; `workspaceCwd` and everything keyed off it stay at the root.
- **Agent reads/writes the wrong files after the cwd split (was hidden in v2).** The prompt hands the
  agent workspace-relative paths (`relDir` -> `loop-stage-machine.ts:400-407,507`; attachments
  `loop-attachments.ts:79`). Once cwd is the worktree, those resolve into the worktree and the backend
  loses sight of them. Fixed by P1 converting all agent-visible paths to absolute, backed by the
  path-resolution acceptance spec.
- **Breaking the 5 existing `WorktreeManager` callers.** Avoided by making P4's strict reap and
  dedicated-merge behavior opt-in (see the caller-impact matrix); existing callers keep current
  semantics until individually migrated.
- **Root-`main` guard breaking AIO's own commits.** Verified non-issue: no shutdown commit exists,
  the only orchestrator commit is worktree-scoped and already `--no-verify`, and no hooks exist. The
  harvest commit follows the same `--no-verify` worktree-scoped pattern.
- **Lost uncommitted output (primary data-loss path).** Fixed by Decision C harvest plus a
  dirty-tree-aware reap; abandonment preserves the tree first.
- **Broken merge under concurrency.** Fixed by moving integration into a dedicated worktree and
  serializing through the gate (pulled into P4).
- **Native-ABI skew from cloning.** Fixed by a per-worktree `verify-native-abi`/rebuild that is
  not gated solely on lockfile equality.
- **Agent-side git contention and auto-gc.** Reduced, not eliminated: `gc.auto 0` plus the gate
  for orchestrator writes; agent reads/commits stay on their own index and are bounded by retry.
- **Cross-loop memory regression.** Avoided by keeping the memory key at the repo root (P1), not
  the per-loop worktree path.
- **Orchestrator reads working-tree state from repo root while agent writes to worktree.** When
  isolation is active, `snapshotWorkspaceFiles`/`snapshotFileChangesViaWorkspace`/`snapshotFileChangesViaGit`
  in `default-invokers.ts` and `collectWorkspaceDiff` in `loop-coordinator-completion-gates.ts`
  and `loop-pingpong-completion.ts` still read from `workspaceCwd` (the repo root). The agent's
  edits are in the worktree — these callers see zero changes, corrupting no-progress detection
  and reviewer context. Fixed by P2 threading `executionCwd` to all session working-tree readers.
- **Silent fallback to shared root when worktree unavailable.** Current code falls back silently
  to `workspaceCwd` when `createWorktree` fails or `executionCwd` is missing on restore. This
  recreates the collision/data-loss class isolation is meant to prevent, but invisibly. Fixed by
  Decision D: fail-closed when `isolateLoopWorkspaces` is true — block and notify rather than
  degrade.
- **Cross-loop BLOCKED.md pollution.** `loop-coordinator-state-helpers.ts` reads both the
  scoped per-run path and `<workspaceCwd>/BLOCKED.md`. A stale or concurrent root `BLOCKED.md`
  can pause the wrong loop. Fixed by P1 gating the root fallback on isolation status.
- **Landing while 3 sessions run.** Everything ships behind `isolateLoopWorkspaces`, enabled per
  session, instantly reversible.

## Test strategy (Vitest)

Co-located `*.spec.ts`, matching `vcs-manager.write.spec.ts` and `session-mutex.spec.ts`.
Git-integration units (acquire, harvest, reap classification, merge-base check, write queue,
clonefile) run against a real temp git repo created per test, not a mocked `child_process`. Pure
logic (lockfile-diff decision, port allocation, registry reconcile) is unit-tested directly. A
recovery spec backs P1, and a concurrency stress spec backs P5.

## Open questions

1. Isolation default: opt-in per loop, or default-on once stable?
2. Harvest granularity (Decision C): one squash commit per session, or preserve the agent's
   incremental file states? (Staging scope and `--no-verify` are now settled; only granularity is open.)
3. Do branch-select and parallel-execution flows (which already call `createWorktree`) move onto
   the same acquire/harvest/reap path, or stay separate? (Now scoped by the P4 caller-impact matrix:
   they stay on current semantics under P4 and migrate individually afterward.)
4. pnpm migration timing (Decision A long-term).

Resolved during the gap-closing pass:

- ~~`WorktreeManager` singleton: make it injected so phases and tests do not arm the health monitor
  at import.~~ **Resolved:** confirmed the constructor arms a 5-min interval at `getInstance()`
  (`worktree-manager.ts:47-51,519-521`); making it injected and not arming at import is now a P4 task
  with its own acceptance check.
