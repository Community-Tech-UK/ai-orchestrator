# Loop Artifact Scoping — per-run state directory

> **Date:** 2026-06-03
> **Status:** COMPLETED — implemented & verified (tsc electron+spec clean, lint clean, 944 orchestration tests green).

## Incident root cause (evidence-backed) — completion correctness ≠ state scoping

Per-run state scoping fixes STAGE/NOTES/LOOP_TASKS/DONE collisions, but it is
**not** the whole fix for the reported incident. The actual completion trigger
(from `app.log`, run `loop-1780446272561`):

```
CompletedFileWatcher fired ... token-efficiency-accuracy-medium_completed.md
CompletedFileWatcher fired ... token-efficiency-accuracy-linkedin_completed.md
```
and `ITERATION_LOG.md`: `[completed-rename] A *_Completed.md rename was observed`.

The `completed-rename` signal is **sufficient** and the `CompletedFileWatcher`
accepted ANY `*_completed.md` rename in the workspace — so the agent (steered by
the stale ledger's "rename these files" gate) renamed two unrelated blog drafts
and the loop stopped. Three additional defects, now fixed:

1. **Over-broad completion acceptance (cross-run + cross-file).**
   `completed-rename` now only fires for a rename of THIS loop's *configured
   plan file* (`isCompletedRenameForPlan`). Renaming an unrelated doc, or a
   concurrent loop's plan, no longer completes a loop. No-plan loops can't
   complete via rename at all (DONE.txt + verify + ledger only). This also
   neutralizes the `CompletedFileWatcher` cross-talk between distinct-plan
   concurrent loops without per-run-scoping the watcher (it must stay
   workspace-scoped — plan files live in the user tree).
2. **Root `.md` misclassified as plans.** `scanUncompletedPlanFiles` now
   requires a plan-ish filename OR a markdown checklist, so prose docs (blog
   drafts) are no longer flagged as "uncompleted plans" the agent is told to
   rename.
3. **Same-plan concurrent policy.** `startLoop` refuses a second concurrent
   loop driving the same `(workspace, planFile)` — they'd both complete on one
   rename. Distinct-plan / no-plan loops are allowed (now isolated by #1 + the
   per-run state dir).

## As-built notes (deviations from the original sketch)

- **Decision locked: run-id scoping** under `<workspace>/.aio-loop-state/<loopRunId>/`.
- **Archive-reset dropped.** With a unique per-run dir, a new run always gets a
  FRESH empty dir, so a prior run's ledger can never be inherited — the
  `LOOP_TASKS.prev.md` archive hack from the earlier stale-ledger fix is
  unnecessary and would harm same-run recovery. `bootstrap` is now idempotent
  "write-if-absent" (preserves in-progress files on the only path that re-enters
  it, same-run recovery).
- **BLOCKED.md is tolerant:** read prefers the per-run dir but falls back to the
  workspace root (a misfiled BLOCKED only *pauses*, never falsely completes, so
  tolerance is safe and reduces agent path-discipline risk). DONE.txt / ledger /
  stage are strict (per-run only) because they drive completion.
- **GC of old `.aio-loop-state/<runId>` dirs: deferred** — they accumulate like
  the existing `.aio-loop-control/<runId>` dirs (no regression vs today).
- Files: new `loop-artifact-paths.ts` (+spec); threaded through
  `loop-stage-machine.ts`, `loop-completion-detector.ts`, `loop-coordinator.ts`;
  gitignore via `loop-attachments.ts` + repo `.gitignore`; codemem ignore;
  `default-invokers.ts` blocked-nudge made path-agnostic. 8 specs migrated.
  Verify: electron+spec tsc 0 errors, lint clean, 927 orchestration tests green.

---

## Original plan (for reference)
> **Trigger:** Loops write their state files to the **workspace root**, so two loops
> in the same workspace (different chats) collide on `STAGE.md` / `NOTES.md` /
> `LOOP_TASKS.md` / `DONE.txt`. Also caused the "loop ran the wrong doc" bug —
> a new run inherited a prior run's root `LOOP_TASKS.md`.

## Problem (code-verified)

- `LoopCoordinator.startLoop` enforces **one active loop per *chat*** only
  (`loop-coordinator.ts:497`). Its own comment: *"they'd fight over STAGE.md,
  NOTES.md, and the plan file."* Two **different chats** on the same workspace
  are allowed to run concurrently → shared-root collision.
- `LoopStageMachine` is constructed with `config.workspaceCwd` as `this.cwd`
  and writes/reads all scaffolding at the **root**:
  `STAGE.md`, `NOTES.md`, `ITERATION_LOG.md`, `LOOP_TASKS.md`
  (+ `LOOP_TASKS.prev.md` archive), and the prompt embeds those bare names.
- `LoopCompletionDetector` reads root `LOOP_TASKS.md`, `DONE.txt`, `NOTES.md`.
- `LoopCoordinator` reads root `BLOCKED.md` and the `DONE.txt` sentinel.
- The **agent** reads/writes these by the bare names embedded in the prompt
  (its cwd is the workspace root).

### Already per-run scoped (precedent to mirror)
- Loop **control plane**: `<workspace>/.aio-loop-control/<loopRunId>/`
  (`loop-control.ts:80`), deterministically re-derivable from
  `(workspaceCwd, loopRunId)` for recovery (`loop-control.ts:252`).
- **Attachments**: `<workspace>/.aio-loop-attachments/<loopRunId>/`
  (`loop-attachments.ts`).

So the control plane and attachments are already isolated per run; only the
**state files** are not. This plan extends the same `<root>/<runId>/` pattern.

## Decision — scoping key  ✅ run-id (recommended)

Scope state files under **`<workspace>/.aio-loop-state/<loopRunId>/`**.

- **Run-id** (recommended): mirrors `.aio-loop-control/<loopRunId>` exactly;
  recovery re-derives the dir from persisted `(workspaceCwd, loopRunId)`
  (LoopStore already stores both). A brand-new run gets a **fresh empty dir**,
  so the stale-ledger bug becomes structurally impossible — no archive hack
  needed for the primary path. Cost: dirs accumulate (needs a cleanup/GC pass,
  same as control dirs today).
- Chat-id (rejected): more human-navigable and matches "per chat", but sequential
  re-runs in a chat reuse the dir → stale `LOOP_TASKS.md` returns; and it buys
  nothing over run-id for the cross-chat collision (the one-loop-per-chat guard
  already makes chat↔active-run 1:1 at any instant). We can still surface
  *"this chat's current loop dir"* in the UI via the run→chat mapping.

## What moves vs. what stays

**Moves into `.aio-loop-state/<runId>/`** (loop-owned scaffolding):
`STAGE.md`, `NOTES.md`, `ITERATION_LOG.md`, `LOOP_TASKS.md`,
`LOOP_TASKS.prev.md`, `DONE.txt` (sentinel), `BLOCKED.md`.

**Stays at workspace root / user-specified path** (NOT loop-owned):
- `planFile` (`config.planFile`) — a **user** doc (often the attached plan).
  Relocating it would break the user's expectations and the `_completed`
  rename gate. Two chats working *different* plan files don't collide on the
  plan; they collide on the scaffolding (which moves). Keep plan handling
  workspace-relative.
- The `*_completed.md` rename gate + `CompletedFileWatcher` — keyed off the
  user's plan path; unchanged.
- `.aio-loop-attachments/<runId>/` — already scoped; unchanged.

## Implementation sketch

1. **`LoopArtifactPaths` helper** (new, pure): given `(workspaceCwd, loopRunId)`,
   returns the state dir + absolute paths for each artifact. Deterministic
   re-derivation (mirror `loop-control.ts:252`) so recovery + detector + agent
   all agree. Add `STATE_DIR_NAME = '.aio-loop-state'`.
2. **`LoopStageMachine`** — take the resolved state dir (or `(cwd, runId)`) in
   the constructor; route `ARTIFACT_FILES`, `LOOP_TASKS_FILE`, bootstrap,
   readStage/readPlan(stays root for planFile)/readTaskLedger/snapshot through
   the helper. `buildPrompt` emits the **scoped relative paths**
   (`.aio-loop-state/<runId>/STAGE.md`, …) and a one-line "all loop state lives
   in this dir" instruction.
3. **`LoopCompletionDetector`** — read `LOOP_TASKS.md` / `DONE.txt` / `NOTES.md`
   from the scoped dir. planFile + completed-rename stay root.
4. **`LoopCoordinator`** — `BLOCKED.md` + `DONE.txt` sentinel reads use the
   scoped dir; pass `loopRunId` to the stage machine / detector. Gitignore
   `.aio-loop-state/` (mirror `ensureLoopAttachmentsIgnored`).
5. **Cleanup/GC** — on terminal/cancel, optionally retain (for forensics) and
   GC old state dirs like control dirs. Decide retention.
6. **Migration / back-compat** — first run after upgrade: no scoped dir exists →
   bootstrap creates it fresh; any pre-existing root `STAGE.md`/`LOOP_TASKS.md`
   is simply ignored (not inherited), which is the desired behavior. Keep the
   `bootstrap` archive-reset (already landed) as belt-and-braces for the
   degenerate case where an agent writes to root anyway.

## Risks

- **Agent path discipline (primary risk).** The agent must write
  `DONE.txt`/`BLOCKED.md`/`LOOP_TASKS.md` to the scoped dir, not root. Mitigate:
  (a) prompt emits the full scoped relative path everywhere it names a file;
  (b) detector/coordinator read **scoped-only** (a root fallback would re-open
  the cross-chat collision for `DONE.txt`); (c) keep the bootstrap archive-reset
  so a stray root ledger can't hijack a future run.
- **Recovery** must re-derive the same dir — covered by deterministic
  `(workspaceCwd, loopRunId)` derivation; LoopStore persists both.
- **Verify command / cwd** — verify still runs in `workspaceCwd`; unaffected.

## Test plan

- `LoopArtifactPaths` unit: deterministic paths; re-derivation equality.
- `LoopStageMachine`: bootstrap writes into the scoped dir, not root; prompt
  contains scoped paths; two run-ids → two isolated dirs (no cross-talk).
- `LoopCompletionDetector`: ledger/sentinel read from scoped dir; root files
  ignored.
- Coordinator integration: two concurrent loops (different chats, same
  workspace) keep independent STAGE/LOOP_TASKS/DONE — the regression that
  motivated this.
- `tsc` electron + spec, `eslint`, targeted vitest green.
</content>
