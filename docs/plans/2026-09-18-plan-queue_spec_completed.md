# Plan Queue Specification

**Status:** Approved by James 2026-09-18 via review artifact `2026-09-18-plan-queue` (overall
APPROVED; decisions 1, 3 and 6 changed from the draft, recorded below). Implemented and verified
2026-09-19 (fresh-eyes gate VERDICT PASS); live checks deferred to `2026-09-18-plan-queue_livetest.md`. The two behaviours that
had differed from this text were resolved on 2026-09-19 at James's direction: the landing commit now
runs the repository's hooks, and the closed documents land inside that same commit (Landing below).
**Date:** 2026-09-18
**Plan:** [2026-09-18-plan-queue_plan_completed.md](./2026-09-18-plan-queue_plan_completed.md)

## Problem

On 2026-09-18 this checkout held 20 active `*_plan.md` files, 55 open `*_livetest.md` files and
8 `*_spec_planned.md` files, all untracked. James wants to say "work through all the plan files"
(and the same for livetests) and have AIO do it: one first-class, visibly-parented child instance
per document, each independently verified as done.

Loop mode was meant to do this and does not do it reliably.

1. A loop is not a session. It is a state machine (`src/main/orchestration/loop-*`) that
   re-invokes a CLI per iteration and infers "done" from six forensic signals, a four-tier evidence
   ladder, ping-pong review and audit gates. `docs/plans/2026-09-03-loop-execution-cwd-and-reviewer-budget_plan_completed.md`
   records 0 of 35 loops reaching a clean `completed` between 2026-06-30 and 2026-09-03 (that
   plan's own measurement; not re-measured here).
2. `CampaignCoordinator` (`src/main/orchestration/campaign-coordinator.ts`) already runs several
   plans, but every node is a loop (`:153`, `loopStarter`), so it inherits the same behaviour.
3. Isolated work is being lost in worktrees today. On 2026-09-18 `.worktrees/` holds 8 stranded
   loop worktrees (`task-*`) from earlier attempts at this same request, each 0 commits ahead of
   `main` and 28–56 commits behind it; four hold 185, 117, 101 and 52 staged-but-uncommitted
   files. Nothing in them is visible to `git log` or `git branch`. (Corrected: an earlier draft
   said "11 `task-*` checkouts". The 11 counted every registered entry under `.worktrees/`; the
   other three are a live loop run parked on a provider limit, a detached
   `composer-resize-verification` checkout with 2 modified files, and
   `harness-auto-update-v0.1.0` with 1 unmerged commit. Two more dirty worktrees sit under
   `.claude/worktrees/`.)
4. **Why they were stranded (diagnosed 2026-09-18).** `loop_runs` in `loop-mode.db` shows all
   eight of those runs ended with worktree lifecycle phase `blocked` and
   `lastError = 'Harvest failed with uncommitted work'`; five of the eight had reached
   `completed-needs-review` and three `cap-reached`. `finalizeLoopWorktree` stops at that point and keeps the worktree
   (`src/main/orchestration/loop-worktree-lifecycle.ts:102-106`). In every leftover inspected the
   index is fully staged (`A `/`M `), so `git add -A` ran and the commit was refused.
   `harvestWorktree` commits without `--no-verify` (`worktree-manager.ts:367`), so the repo's
   pre-commit hook runs: the plan-spec guard refuses any staged `_plan.md` / `_livetest.md` /
   `_spec_planned.md` (3 to 11 such files are staged in the worktrees that have them), and
   `scripts/run-git-hook.js` runs `test:staged`, which unfinished work can fail. The hook refusal
   itself is inferred from that evidence, not re-run, because re-running it means committing in
   those worktrees. Consequence for this design: a safety commit must never be refusable by a
   hook (review decision 4).
5. A second block sits behind the first. `promoteIntegrationBranch` refuses when the root
   checkout has any uncommitted change, and an unrelated untracked file counts
   (`src/main/workspace/git/worktree-integration.ts:262-280`, `:395-397`). Verified: the existing
   test "blocks on a dirty root without changing main or the dirty file"
   (`worktree-integration.spec.ts:361`) writes one untracked file and expects `blocked`; the file
   passes 18/18. James's lifecycle deliberately keeps about 120 untracked plan files in the root,
   so a checked-out `main` could not be promoted even after a successful harvest.
6. `WorktreeManager.sessions` is in-memory only (`worktree-manager.ts:60`), so ownership of a
   worktree is forgotten on restart.

## Decisions James made on 2026-09-18

1. Parallel execution is required. One worktree per item is acceptable only if work can never be
   orphaned or hidden in a worktree.
2. The queue may make local squash commits on `main`, one per verified item. It never pushes.
3. Default parallelism: 3 plan workers, 1 livetest worker. Both configurable.
4. The worker uses the provider of the session James started the queue from. The verifier uses a
   different provider.
5. An item that still fails after the round limit is marked and the queue continues. It reports at
   the end.
6. Documents that are not ready (awaiting review, no plan, open decision) are called out, and the
   parent session asks James about them rather than guessing.
7. Most "needs James" livetest gates are not real. The queue must prove James is actually needed,
   and may temporarily relax rules for a run. Review decision 1 (option c): only the two
   settings are relaxable for now — `computerUseAutonomyLevel` and
   `providersExcludedFromAutomation`. Computer Use self-approval, the real-login boundary and the
   push approval dialog are out of scope for this iteration.
8. Loop mode and Campaigns are left untouched. No refactor, no removal.
9. Entry point: an orchestrator MCP tool any session can call, plus a queue panel.
10. Review decision 3 (option b): two verifications may run at once; James accepts the load.
    Landing itself stays serial.
11. Review decision 6 (option c): the leftover worktrees are out of scope. The
    reconciler manages only what the queue created.
12. Review decisions 2, 4, 5, 7, 8 confirmed as drafted: coordinator-only `_completed` rename;
    `--no-verify` on throwaway `queue/*` checkpoint commits only; documents stay in the root
    checkout; first live run against a scratch repository; the name is Plan Queue.

## Required Behaviour

1. A session calls one tool with a document kind (`plans` or `livetests`) and an optional
   glob. That session becomes the parent of everything the run spawns.
2. The coordinator discovers matching documents, classifies each by filename state and content,
   and returns the list before any worker starts.
3. Each ready item gets one worker: a first-class instance created with `parentId` set to the
   parent session, shown nested under it in the instance rail, holding one long-lived conversation
   for the life of the item.
4. When a worker finishes a turn, a separate verifier instance with fresh context and a different
   provider reviews the work and reports a structured verdict through an MCP tool. No completion
   decision is ever parsed from prose.
5. On FAIL the findings go back to the same worker and a new verifier checks the result, up to a
   round limit (default 3).
6. A worker never renames its own document to `_completed`. The coordinator performs the rename,
   and only after a PASS.
7. Every item runs in its own worktree. Worktree ownership is a database row written before the
   worktree exists. Work is committed to the item's branch by the coordinator at every worker idle
   and before any teardown.
8. Every item reaches exactly one terminal state, and no terminal state leaves a worktree
   directory on disk:
   - **landed** — one squash commit on `main`, document renamed, worktree and branch deleted.
   - **parked** — final checkpoint commit made, worktree removed, branch kept and listed in the
     panel with its reason and diffstat. Actions: Resume, Land anyway, Discard.
   - **skipped** — never started (not ready, or James said skip). No worktree was created.
9. A worktree directory is removed only when its tree is clean and HEAD equals the recorded
   checkpoint. A branch is deleted only after it has landed or James has clicked Discard.
10. On boot a reconciler compares `.worktrees/queue-*` directories and `queue/*` branches against
    the database and surfaces any mismatch in the panel. It ignores worktrees the queue did not
    create. It never deletes anything on its own.
11. Landing on `main` must work while the root checkout holds untracked documents.
12. Queue state survives app restart, provider-limit parking and worker hibernation.
13. Livetests run through the same machinery with livetest-specific prompts and outcomes, and end
    with one consolidated list of checks that genuinely need James.
14. Not-ready documents produce structured questions for James, answerable with radio buttons in
    the panel or through the parent session.

## Non-Goals (this iteration)

- Changing, fixing or removing loop mode or Campaigns.
- Dependency ordering between plans. Items are independent; an item that needs another to land
  first is parked with that reason.
- Running workers on remote nodes.
- Pushing, opening PRs, or any other outward-facing git action.
- The leftover worktrees. Out of scope by review decision 6; the queue neither lists nor adopts
  them. A separate rescue prompt covers them:
  `docs/plans/2026-09-18-stranded-worktree-rescue_prompt.md`.
- Relaxing Computer Use self-approval, the real-login boundary or the push approval dialog.

## Design

### Shape

A new main-process singleton, `PlanQueueCoordinator`, in `src/main/plan-queue/`. It is a
deterministic state machine. No LLM decides what runs next, whether an item is done, or when to
land. LLMs do three jobs only: triage a document, do the work, judge the work.

It is modelled on two pieces of code that already work:

- `AutomationRunner` (`src/main/automations/automation-runner.ts:256`, `:312-401`) for spawning a
  first-class instance with an `initialPrompt` and tracking it to turn completion
  (`status === 'idle'` after assistant output), including `waiting_for_input` /
  `waiting_for_permission` and provider-limit classification.
- `CampaignCoordinator` for the persisted-run shape, boot recovery and IPC/renderer wiring.

### Item state machine

```
discovered → triaged ─┬→ skipped                                   (terminal)
                      ├→ needs-answer → (James answers) → queued
                      └→ queued → preparing → working ⇄ fixing
                                                │
                                   awaiting-slot → verifying ─┬→ landing → landed   (terminal)
                                                              ├→ fixing (FAIL, rounds left)
                                                              └→ parked             (terminal)
any non-terminal state → parked   (cancelled, worker error, land blocked, round limit)
```

Two independent concurrency limits:

- **Worker slots** — 3 for plans, 1 for livetests.
- **Verification slots** — 2 by default (review decision 3), configurable, shared by every run.
  Only the verifier runs the full canonical gate list, so at most two full suites run at once.
  The campaign runbook records a loadavg-300 incident from a full suite running beside batch
  agents (`livetest-campaign-runbook.md` §4); James accepted that risk, and the load gate below
  still applies before each verification starts. Workers are told to run targeted tests, both
  `tsc` invocations and lint, not the full suite.
- **The landing lock** — exactly 1. Landings are serial regardless of verification slots.

Before dispatching a worker or starting a verification the coordinator samples load and waits while the
1-minute and 5-minute averages exceed a configurable ceiling (default 30).

### Discovery and triage

Discovery is pure code: glob, then classify by filename (`_plan.md`, `_livetest.md`; ignore
`_completed`, `_spec*`, prompts, standing registers). A plan whose linked spec is missing, or a
spec with no plan, is reported as not ready.

Triage is one short-lived child instance per run (not per item). It reads every discovered
document and reports, through a `plan_queue_report_triage` tool call, one record per document:
`ready`, `needs-answer` (with a question and 2–4 options), or `skip` (with a reason). Signals it
looks for: a Status line saying awaiting review or decision, an open-decisions section, a
dependency on another unfinished plan, a plan that is already fully implemented and only needs
closing.

Ready items start immediately. `needs-answer` items wait without holding up the rest.

### Questions to James

Questions are stored on the item and shown in the panel with radio controls (James does not type
option letters). The parent session is also sent the list and told to ask James using its native
structured-question capability where the provider has one; that path already renders through
`user-action-request.component.ts`. Either route writes the answer through the same
`plan_queue_answer` operation. The panel is authoritative.

### Worker

Created with `createInstance({ parentId, workingDirectory: <worktree>, initialPrompt, provider,
modelOverride, yoloMode: true, metadata: { planQueueRunId, planQueueItemId, planQueueRole:
'worker' } })`. `instance-lifecycle.ts:1363-1371` already links the child into the parent's
`childrenIds`, and `instance-row.component.ts` already nests children. The `metadata` keys drive a
small provenance marker in the rail, following the `automationId` clock indicator
(`instance-row.component.ts:91`).

The worker prompt states:

- the absolute path of the document in the **root checkout**, and that the document is edited
  there, never copied into the worktree (see Document location);
- the worktree path, and that all code changes happen there;
- follow `AGENTS.md`; run targeted tests, both `tsc` commands and lint; do not run the full suite;
- never commit, never rename the document to `_completed`, never create a branch or worktree;
- when finished, update the document's status and as-built notes and, if checks genuinely need a
  rebuilt app, a human or an external service, create the `_livetest.md` per the Live-Test
  Deferral rules; then stop.

Turn completion, `waiting_for_*` and provider-limit handling follow `AutomationRunner`. A worker
that parks awaiting input has its question surfaced in the panel like a triage question rather
than being failed. Follow-up input uses main-process `sendInput`, which already waits out a
respawn (`instance-communication.ts:560-639`).

A worker waiting for a verification slot or for a verdict is idle and therefore eligible for hibernation
(30 min) or memory-pressure reclaim (`resource-governor.ts`). Hibernation is acceptable: the
coordinator wakes the worker by sending input, and its work is already checkpointed. The plan
adds an explicit coordinator hold so the governor prefers other instances; it does not reuse the
async-work inhibitor, which is tied to provider background-work records.

### Verifier and verdict

A new instance per round, same `parentId`, `workingDirectory` = the item's worktree, provider
chosen by `resolveCheckerPlan` (`src/main/review/checker-plan.ts:234`) with the worker's provider
and model as the implementer context. That function already enforces model-family diversity and
Copilot licence containment. If it returns no candidate the item parks with that reason; it does
not fall back to the same provider silently.

The verifier prompt embeds the completion-gate criteria inline (diff against the merge base,
acceptance criteria in the document, architecture, test integrity, security, async/state handling,
deferral legitimacy) and the canonical gate list from `AGENTS.md`. It must not edit tracked files.

It reports through `plan_queue_report_verdict { verdict: 'PASS' | 'FAIL', findings[], gatesRun[] }`.
The RPC server accepts the call only from the instance currently registered as that item's
verifier; a worker cannot report its own verdict. The coordinator records HEAD and
`git status` before and after verification; if the tree changed, the verdict is discarded and the
round repeats with a fresh verifier.

A verifier that ends its turn without calling the tool counts as an errored round, not a FAIL.
Two errored rounds park the item as `verifier-unreliable`.

### Worktree lifecycle — the no-lost-work invariants

1. **Row before worktree.** `plan_queue_items` records branch name and intended path, then
   `WorktreeManager.createWorktree` runs with prefix `queue-`. Dependencies are cloned by the
   existing `worktree-deps.ts` path.
2. **Coordinator checkpoints.** At every worker idle, before verification starts, and before any
   teardown: `git add -A && git commit --no-verify` on the item branch through `GitWriteQueue`.
   `--no-verify` is deliberate here and only here: the branch is throwaway, and a checkpoint that a
   hook can refuse is a checkpoint that can lose work. The existing `harvestWorktree` does not pass
   it (`worktree-manager.ts:367`), so the queue uses its own checkpoint function.
3. **Proof before removal.** Directory removal requires clean tree and HEAD = recorded checkpoint.
   Branch deletion requires `landed`, or an explicit Discard.
4. **Boot reconciliation.** Compares `.worktrees/queue-*`, `queue/*` branches and rows.
   Mismatches become panel alerts. Worktrees and branches the queue did not create are ignored.
5. **Parked work is findable from the document.** The coordinator appends one line to the
   document naming the branch, commit count and reason.

### Keeping the branch current

When an item takes a verification slot and `main` has moved since its base, the coordinator merges
`main` into the item branch itself. On conflict it aborts nothing: it leaves the conflict in the
worktree, tells the worker which files conflict, and the worker resolves them without committing.
The coordinator then checkpoints. Landing squashes, so branch history does not matter. This
follows the published finding that a separate integrator role becomes a bottleneck and workers
handle conflicts themselves.

### Landing

With two verification slots, a PASS can be stale: another item may land while this one is being
verified. Under the landing lock, after PASS, the coordinator first checks whether `main` moved
since verification began. If it did, it merges `main` into the item branch. A conflicted merge
sends the item back to its worker and then to a fresh verifier. A clean merge is followed by a
deterministic post-merge gate run by the coordinator, not an LLM (default `npx tsc --noEmit` and
`npx tsc --noEmit -p tsconfig.spec.json`, configurable); a failure sends the item back to
`fixing` with the output. This is weaker than re-running the full suite and is the accepted cost
of decision 3.

Then, still under the landing lock:

1. Prepare the closed documents without touching the root checkout: the plan's
   `_plan_completed.md` and its spec's `_spec_completed.md`, with the links in both re-pointed.
   If they cannot be prepared (missing, a completed name already taken, plan and spec split across
   the repository boundary), the item parks `land-blocked` and nothing has landed.
2. Build one squash commit in the item's own worktree, which has the repository's dependencies:
   squash the item branch onto `main`'s tip and add the closed documents, so code and documents
   land together or not at all. The commit runs the repository's pre-commit hook: the plan-spec
   guard, the committed-artifact generators and `test:staged`. The coordinator also refuses an item
   branch carrying active plan/spec/livetest documents itself, so repositories without that hook
   are covered. A refusal goes back to the worker with the hook's output once; a second refusal
   parks the item `land-blocked`. The count is stored on the item, so a restart does not reset it,
   and a hook that runs past its 15-minute budget, leaves a process running when it exits, or is
   still running when the app quits is stopped with every process in its process group. A process
   that moved itself out of that group cannot be stopped this way; the landing reports it and
   stops waiting for it rather than hanging. The worktree holds
   only this item's work, so the generators cannot sweep anyone else's state into the commit.
3. Fast-forward `main` in the root checkout. The stay-on-main guard always allows this while the
   root is on `main`; no `AIO_ALLOW_MAIN_UPDATE` is needed.
4. **Dirty-root rule change.** `promoteIntegrationBranch` gains an opt-in policy,
   `block-overlap`: block only when a root uncommitted or untracked path is also a path in the
   landing diff. Existing callers keep today's `block-any`. `git merge --ff-only` already refuses
   to overwrite local or untracked files, so the policy is a precheck with a clear reason, not the
   only safeguard.
5. Remove the root checkout's now-superseded untracked `_plan.md` / `_spec_planned.md`, but only
   a copy still identical to what landed; a copy edited meanwhile is kept and reported. Documents
   outside the repository or ignored by it are never committed; they are renamed in place.
6. Remove the worktree, delete the branch, mark `landed`.

If any step blocks, the item parks as `land-blocked` with the reason. Nothing is deleted.

Commits are made with the repository's configured identity, which is currently
`Test <test@example.com>` — the leaked identity `.githooks/README-stay-on-main.md` already asks
James to fix. The plan does not change git config; it flags this.

### Document location

Plan and livetest documents are untracked, so a worktree cut from HEAD does not contain them. They
stay in the root checkout, where James reads them, and are edited there by absolute path. Two
workers never share a document. Tracked shared documents (for example
`livetest-remediation-register.md`) are edited in the worktree and land like code; with livetest
parallelism at 1 they do not conflict with each other.

### Livetest mode

Same machinery, three differences.

- **Prompt.** `docs/plans/livetest-campaign-runbook.md` is the instruction set: launch an isolated
  dev app with `AIO_DEV_USER_DATA_PATH` and its own debug port, enable focus emulation, record
  evidence in the owning document, file reproduced defects in the register.
- **Outcomes.** A livetest item may legitimately end `landed` with the document still open. Its
  verdict is about evidence quality: every claimed pass has current dated evidence, nothing was
  renamed `_livetest_completed.md` unless every check passes, no defect was silently dropped. The
  rename to `_livetest_completed.md` follows the same coordinator-only rule.
- **Need-James audit.** For every check a worker leaves as "needs James", the verifier must
  classify it as *physical/identity/decision* (real), *policy-gated* (relaxable) or *stale* (retry
  it). Only the first kind reaches the end-of-run list, which replaces hand-maintaining
  `needjamesfor.md`.

### Relaxation profile

A named, per-run set of overrides, snapshotted before the run and restored at the end, and
restored on boot if the app died mid-run (the snapshot is persisted with the run). Every use of a
relaxed rule is logged against the item.

In scope (review decision 1, option c), both operator-only settings in
`src/main/core/config/settings-control-policy.ts` (`:84`, `:108`):

1. `computerUseAutonomyLevel`.
2. `providersExcludedFromAutomation` (lets a run use Copilot).

`SettingsManager.get/set` are plain main-process calls with no built-in transaction, so the
profile snapshots each value, applies the override, and restores it. Restore compares against the
value it applied and leaves the setting alone if James changed it by hand during the run.

Out of scope for this iteration: an agent approving its own Computer Use grant, the documented
"no agent performs a real login" boundary, and the native push approval dialog. Checks blocked by
those stay on the end-of-run need-James list, classified as *policy-gated* so the number is
visible. Hard-denied Computer Use targets stay denied; nothing here touches that list.

### Persistence

Two tables in `loop-mode.db`, added as migration 17 in `src/main/orchestration/loop-schema.ts`
(current `LOOP_SCHEMA_VERSION = 16`), the same home as `campaigns` / `campaign_nodes`:
`plan_queue_runs` (id, parent instance id, kind, config JSON, relaxation snapshot JSON, status,
timestamps) and `plan_queue_items` (run id, document path, state, branch, worktree path, base
commit, checkpoint commit, worker instance id, verifier instance id, round, question JSON, answer,
park reason, verdict JSON, timestamps). Every state transition is written before the side effect
it authorises.

### MCP tool surface

In `src/main/mcp/`, following `run_on_node`: `plan_queue_start`, `plan_queue_status`,
`plan_queue_answer`, `plan_queue_control` (pause, resume, skip item, cancel) for the parent
session; `plan_queue_report_triage` and `plan_queue_report_verdict` for the role instances,
caller-checked against the item row. Registered in the definitions file, the RPC server dispatch
and toolsets, and the stdio forwarder; `npm run build:aio-mcp-dist` afterwards.

### IPC and renderer

Channels `PLAN_QUEUE_*` in `packages/contracts/src/channels/`, Zod schemas in
`packages/contracts/src/schemas/plan-queue.schemas.ts`, handlers in
`src/main/ipc/handlers/plan-queue-handlers.ts`, `npm run generate:ipc`. Renderer: a signal store,
an IPC service, and a routed page registered in `control-surface.registry.ts` beside Campaigns.
The page lists runs and items with state, round, verdict findings, questions with radio controls,
parked branches with diffstat and the three actions, reconciler alerts, and the end-of-run
need-James list. Standalone `OnPush` components, signals, `inject()`.

### Restart recovery

On boot, after `LoopStoreService` initialises (the same step that recovers campaigns,
`late-runtime-initialization-steps.ts:175-181`): restore any persisted relaxation snapshot, run
the queue worktree reconciler, then for each non-terminal item re-attach to its worker instance if it
still exists, otherwise checkpoint the worktree and respawn a worker with a resume prompt that
points at the document and the branch. An item found in `verifying` re-enters `awaiting-slot`; an
item found in `landing` resumes landing, whose steps are idempotent.

## Risks and open points

- The harvest-refused-by-hook diagnosis rests on database rows, staged indexes and the hook's
  contents. The refusal was not re-run. Task 1.4's spec proves the queue's own checkpoint cannot
  be refused by a hook, which is the property that matters.
- A squash landing runs the pre-commit hook in the integration worktree; its cost under load is
  unmeasured.
- Three workers plus one verifier plus James's own sessions may exceed provider quota. Provider
  limits park the item and the run continues; they do not fail it.
- Verifier prompts are provider-neutral and do not depend on the `task-completion-gate` skill
  being installed for that provider.
- Prompt changes follow `docs/prompt-engineering-house-style.md`.

## Verification

Unit and integration tests cover: the item state machine; discovery classification; caller checks
on the verdict and triage tools; checkpoint, removal-proof and reconciler logic against real
temporary git repositories; the `block-overlap` promotion policy; boot recovery from every
non-terminal state; relaxation snapshot restore after a simulated crash. The canonical
verification checklist in `AGENTS.md` gates completion. Checks that need a rebuilt app (a real
three-item run against disposable plan files, the rail nesting, the panel) go to a
`_livetest.md`.

## Prior art consulted

- Cursor, "Scaling long-running autonomous coding": planner/worker/judge; integrators became a
  bottleneck; periodic fresh starts counter drift. https://cursor.com/blog/scaling-agents
- Augment Code, git worktrees for parallel agents: leaked worktrees are the main failure mode;
  needs lifecycle tracking and health checks.
  https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution
