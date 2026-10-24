# Plan Queue: pause that really stops, and changing a run's provider

Status: implemented, 2026-10-18. Automated verification and fresh independent completion review passed. Real provider, account, spending and app-restart checks are deferred in the linked live-check document; they are not claimed as verified. Changes remain uncommitted.
Requested by James, 2026-10-18: "For Plan Queues, I'd like to be able to pause them easily and
change their provider."

Builds on [2026-10-13-plan-queue-provider-account-control_plan_completed.md](2026-10-13-plan-queue-provider-account-control_plan_completed.md)
(providers and accounts fixed at run start). Nothing in that plan is reopened; this is a follow-up.

## Before this change (investigated on 2026-10-18)

### Pause

- `Pause` sets the run to `paused` (`plan-queue-coordinator.ts` `control()`, ~line 483). The only
  effect is in the scheduler (`pump()`, ~line 584): no new document starts, no new check starts and
  no new triage starts.
- Everything already in progress carries on. A worker mid-turn keeps going. A checker keeps going.
  A failed check sends the document straight back to its live worker
  (`plan-queue-item-flow.ts` `toFixing` → `runWorkerTurn` → `sendInput`), so a paused run can keep
  working and spending round after round. Landing carries on and can also send work back.
- The page says so ("Pause stops new work from starting"), but it is not what "pause" means to a
  person, and there is no way to stop the spending now short of Cancel, which ends the run.
- There is no "pause everything" control. Each run has its own button; on the 17 Oct screenshot
  four runs were running at once.
- **Traced in code, not yet reproduced in a test:** when a paused run needs a new session (the
  worker died between rounds, or the app restarted), the spawn chokepoint refuses because the run
  is not `running` (`plan-queue-coordinator.ts` ~line 306, `PlanQueueSpawnStoppedByUser`), and
  `spawnWorker` parks the document as `cancelled` with the message "Stopped: you closed its
  session" (`plan-queue-item-flow.ts` ~line 219). James did not close anything. After a restart
  every in-progress document of a paused run is parked this way, because sessions never survive a
  restart (`plan-queue-recovery.ts` `recoverItem` → `resumeAfterRestart`).

### Provider

- A run fixes its providers and accounts when it starts: `run.workerProvider`, `run.workerModel`
  and `run.config.routing` (`resolveRunRouting` in `plan-queue-routing.ts`). Nothing can change them
  afterwards: there is no control action, IPC call, MCP action or button for it.
- Every session the run starts reads those fields at spawn time: workers (`spawnWorker`), the first
  triage attempt (`plan-queue-triage.ts` `spawn`), and checkers (`startVerification` passes
  `run.config.routing.verifiers`). So changing the stored fields is enough for new sessions; live
  sessions keep the provider they were started on.
- Resuming a parked document (`resume-item`) re-queues it on the same run, so it uses the run's
  fixed provider. Today the only way to move parked work to another provider is to start a new run.
- The worker's provider and its account fence are read at two different moments: `spawnWorker`
  reads the run for the provider, then `routeQueueSpawn` reads it again for the accounts. Once
  routing can change, a change landing between the two reads could pair one provider with another
  provider's accounts.

### Related defect seen in James's current run (read-only check of `loop-mode.db`, 18 Oct)

The MiMo run started 17 Oct 18:31 has eight documents parked `triage-failed` with "copilot has been
added to the 'never auto-pick' list". The triage retry picks its provider with `selectVerifier`
but passes no `choices` (`plan-queue-triage.ts` ~line 73), so it ignores the run's chosen checkers
and falls back to the automatic pick (here the licence-pinned Copilot seat), which the spawn
chokepoint then refuses. Changing the run's provider would not help those documents unless triage
uses the run's routing.

## Implemented decisions

1. **Pause means stop now.** Pause stops the run's workers, checkers and triage straight away.
   After each writer stops, work done so far is committed to the document's branch (the existing checkpoint). Each
   in-progress document goes back to the waiting line marked "Paused", keeping its branch and its
   worktree on disk, so Resume picks up where it left off without reinstalling. Resume starts a
   fresh session per document on its branch with the existing resume prompt.
   *Why:* this is what "pause" means, it actually stops the spending, and it is what makes a
   provider change take effect.
   *Cost:* the worker's conversation is lost; the next session rebuilds context from the branch,
   the document's as-built notes and (new, item 7) the last checker's findings.
2. **A document that is mid-landing finishes landing.** Landing is short and serial, and stopping
   a commit or a hook part way is unsafe. If landing would send the document back to a worker
   (merge conflict, failed gate, hook refusal) while the run is paused, it waits as "Paused"
   instead of starting a worker, and the reason is kept for the resume prompt.
3. **A running check is stopped and judged again later.** The checker is stopped, anything it
   changed is reverted to the last checkpoint (the same routine boot recovery uses), and the
   document waits for a checker. It does not count as a failed check round.
4. **"Pause all" and "Resume all"** at the top of the Runs section, with the count (for example
   "Pause all (4 running)"). Per-run Pause and Resume stay.
5. **Change provider on a run.** Each run that could still start work (running, paused, or
   finished with parked documents) gets a "Change" button beside its "Workers: … · Checkers: …"
   line. It opens the same choices as the "Providers and accounts" panel, filled in with the run's
   current choice, plus "Same as the session that started the run". Saving checks the choice with
   the same rules as starting a run (installed CLI, not on the never-auto-pick list, account
   allowed for automatic work, a checker that differs from the workers) and refuses with a plain
   reason.
6. **What a change affects.** Every session the run starts from then on: new documents, documents
   resumed from Parked work, triage and checkers. On a paused run nothing else is needed; Resume
   uses the new choice. On a running run the dialog asks "Move documents in progress now?"
   (unticked by default): ticked, each in-progress document is paused (decision 1) and restarted on
   the new provider straight away; unticked, they finish their current session on the old provider
   and switch at their next new session. The simple path is Pause → Change → Resume.
7. **The resume prompt carries the last checker's findings** when the document was being fixed,
   and the landing reason when landing sent it back, so a fresh session (same or new provider)
   does not lose the to-do list.
8. **Pausing never parks a document.** A session refused because the run is paused puts the
   document in "Paused", never in Parked with "you closed its session". After a restart, a paused
   run starts no sessions until it is resumed.
9. **The parent session can do it too.** `plan_queue_control` gets the new pause behaviour and a
   `set-routing` action for the run's parent session (same authority rules as today). An agent's
   checker list is refused in a repository covered by a protected work Copilot rule, exactly as
   per-run checker lists are at start; James's change from the page is treated like his saved
   setting and is allowed there.
10. **Triage retries use the run's chosen checkers** when it has some (fixes the eight parked
    documents above from happening again). Included because without it a provider change does not
    reach triage.
11. **Recorded, not silent.** A change is written to the log and sent to the run's parent session
    ("James changed this run's workers from X to Y"). The run row shows the current choice.

Not included: a pause control outside the Plan Queue page (title bar, session rail), pausing a
single document, and saving a run's change back as the default for new runs. Each is a small
follow-up if wanted.

## Implementation

Before implementation, the coordinator was 678 lines against the 700-line limit and the item flow was 637. The new hold, run-control, routing-change, checker-selection and shared-spawn logic therefore lives in separate modules; the original modules remain within the limit.

### Main process

- [x] **Reproduce first.** Coordinator specs that show today's behaviour: (a) a paused run's
      worker carries on into a fix round after a FAIL; (b) a paused run whose worker is gone parks
      the document `cancelled` / "you closed its session"; (c) the same after a restart. Keep them
      as regression tests with the expected behaviour flipped.
- [x] New `plan-queue-run-hold.ts`: `holdItem(item, reason)` under the item lock. Preparing: let
      preparation finish, then do not spawn. Working/fixing: stop and await the worker, then checkpoint (leave an unresolved merge
      uncommitted, as `parkUnlocked` does), and move to `queued` with
      `workerInstanceId: null`, a `heldAt` marker and the pending instruction (decision 7).
      Verifying: stop and await the checker, restore the checkpoint, move to `awaiting-slot` with no
      errored round. Serial landing finishes; its session/proof cleanup is awaited and retryable. Held worktrees remain on disk.
- [x] Item state stays within the existing state machine (`queued` / `awaiting-slot`); add only the
      fields needed: `held_at` and `pending_instruction` on `plan_queue_items` (new migration in
      the loop-mode store; nullable, no backfill). `plan-queue-state.ts` originally allowed
      verifying → awaiting-slot but not preparing/working/fixing → queued; add those three edges,
      with a test per edge.
- [x] `control('pause')`: set `paused`, then hold every in-progress item of the run; also stop the
      run's triage session (its documents stay `discovered`, no attempt counted).
      `control('resume')`: retry any unfinished stop/checkpoint/reset, then set `running` and pump; `startItem` reattaches an existing
      branch and builds the resume prompt.
- [x] New `pause-all` / `resume-all` control actions (no run id; panel only; MCP keeps per-run).
- [x] Spawn refusal for a paused run: a distinct `PlanQueueSpawnRunPaused` error at the
      `createInstance` chokepoint, separate from the Close-all `PlanQueueSpawnStoppedByUser`.
      `spawnWorker` and landing's send-back hold the item on it instead of parking (decision 8).
      Close all keeps its current behaviour.
- [x] Recovery: for a paused run, `recoverItem` holds working/fixing/preparing items instead of
      calling `resumeAfterRestart`.
- [x] `buildResumePrompt` includes `pending_instruction` (checker findings via the existing
      `buildFixPrompt` text, or the landing reason) and clears it once the worker starts.
- [x] New `plan-queue-run-routing-change.ts`: `changeRunRouting(run, choice, actor)` validates with
      `resolveRunRouting` (worker + checkers, parent route for "same as starting session",
      `relaxSettings` honoured, protected-scope rule for MCP callers), then saves
      `workerProvider`, `workerModel` and `config.routing` in one `upsertRun`. Optional
      `moveInProgress`: hold each in-progress item, then pump.
- [x] `routeQueueSpawn` fills the worker's provider, model and account fence from a single read of
      the run, so a change can never pair one provider with another's accounts. Test the race.
- [x] Contracts: `PlanQueueControlPayloadSchema` gains `set-routing` (`runId`, `routing`,
      `moveInProgress?`), `pause-all`, `resume-all`; `PlanQueueControlArgsSchema` gains
      `set-routing` with snake_case route choices for MCP. Authority: `set-routing` is
      parent-or-panel only, not a stranded-rescue action.
- [x] Triage retry passes `choices: run.config.routing?.verifiers` and `choicesOverrideLicence`
      to `selectVerifier` (decision 10).
- [x] Parent notification on change (decision 11); log line on pause, resume and change.

### Renderer

- [x] Run controls: Pause/Resume labels unchanged; status shows "Paused · N documents waiting to
      resume". Item list shows held documents as "Paused" (from `held_at`), not "Queued".
- [x] Runs section header: "Pause all (N running)" / "Resume all (N paused)", hidden when zero.
- [x] Update the Runs purpose line: "Pause stops the run's sessions now; work so far is saved on
      each document's branch and Resume carries on from there. Cancel ends the run…".
- [x] "Change" on the run's routing line opens an inline editor. Reuse the routing panel's
      editing logic by extracting the draft/validation code into a shared helper (or a
      `mode: 'saved' | 'run'` input) rather than copying it; the panel itself must keep working
      unchanged. Save calls `set-routing`; the main-process refusal text shows inline and the
      edits are kept on failure (as the panel does today). "Move documents in progress now" only
      appears for a running run with work in progress.
- [x] Store/IPC: no new channel; `control()` already carries the payload. Preload type follows the
      contract.

### Docs

- [x] `docs/AIO_MCP_CLI.md` and `docs/llm/AIO_MCP_CLI_REFERENCE.md`: new pause meaning,
      `set-routing`.
- [x] Plan Queue help copy (`tooltip-copy.ts` / `control-surface-help.ts` if they mention Pause).

## Tests

- Coordinator: pause holds working, fixing, preparing and verifying items as described; landing
  completes; landing send-back while paused holds instead of parking; nothing spawns while paused;
  resume restarts on the same branch with the resume prompt and pending instruction; worktree kept
  and reattached without reinstall; pause then cancel; pause racing a spawn in flight; pause during
  checkpoint; two runs, pause one; Pause all / Resume all.
- Restart: paused run with in-progress items → no spawns, no parks; resume afterwards works.
- Routing change: each refusal reason; new worker, triage and checker spawns use the new choice;
  fence and provider from one read (race test); `moveInProgress`; finished run with parked items →
  resume uses the new provider; MCP authority and protected-scope refusal; parent notified.
- Triage retry respects chosen checkers and the never-auto-pick list.
- Renderer: run controls, Pause all, change editor (validation mirrors main, edits kept on
  failure), routing panel unchanged.
- Mutation-check each new guard (remove it, see the test fail): hold-not-park on paused spawn,
  recovery hold, single-read routing, triage choices, `set-routing` authority.
- Canonical gates: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run test:quiet`.
- Fresh-eyes completion gate until PASS.

## Deferred live checks

Real provider, account, spending and rebuilt-app restart checks are recorded with exact steps, expected results and prerequisites in [the live-check document](2026-10-18-plan-queue-pause-and-provider-switch_livetest.md). These checks remain pending and are not part of the automated verification claim.

## As-built notes

Implementation ledger: `_scratch/queue-pause/progress.md`.

- Work split: root owns pause/hold/recovery/persistence and integration; renderer and routing/contracts are separate scoped tasks.
- Existing unrelated working-tree changes are preserved. No branch, worktree, commit or push is authorised.
- Ruling: stop and await a session before its final pause checkpoint so it cannot write after the checkpoint; preserve any unresolved merge without committing it. This strengthens the no-lost-work requirement while using the existing checkpoint routine.
- Ruling: capture the starting session route in run configuration for new runs so choosing it later survives provider changes and restarts; older runs use the surviving parent when available and refuse if it cannot be reconstructed.
- Ruling: the run-control lock also covers triage creation already in flight and its late cleanup. Pause and move wait for that cleanup; a failed stop keeps the run paused with ownership retained so Resume or Cancel can retry, without spending a readiness attempt.
- Ruling: concurrent Close all keeps its distinct meaning. Failed late cleanup retains the worker/checker/triage ID and cause; a worker is stopped before parking/checkpointing, and a stopped checker restores its snapshot before returning to the checker queue.
- Review repairs: final dispatch refreshes checker and triage-retry provider/model/account choices across readiness waits, including legacy runs without stored routing. Control-level regressions cover deferred creation, failed cleanup, Pause/Resume, move, Cancel and concurrent Close all. Full canonical verification and the fresh independent completion gate passed on the final repaired source.
- Ruling: the page/status snapshot includes every running and paused run, and every terminal run with parked documents, alongside the latest limited recent-run window. Bulk totals remain complete and Change stays reachable for parked work even beyond fifty newer finished runs; ordinary inert history remains bounded. Two bulk reads share one read transaction; items are grouped once. The generic DAO history method remains limited. MCP status and the CLI references describe the new snapshot limit semantics.
- Ruling: outcome-driven retirement uses the same stop barrier as Pause. Checker ownership, verdict and tree snapshot remain available until termination succeeds; failed worker retirement is awaited before replacement or a park checkpoint. Triage outcome retirement retains its stop ID and pending promise so Pause, Resume and Cancel can await or retry it.
- Ruling: normal run completion also waits for triage ownership to settle, including a report that makes every document terminal while triage creation or shutdown is pending. A failed stop leaves the run operational and controllable; only successful cleanup permits terminal status.
- Ruling: a promoted item keeps its worker/checker IDs as durable final-cleanup ownership until their shutdown succeeds. Initial landing, locked Pause/Resume/move/Cancel retries and active-run recovery use the same post-promotion cleanup path. It stops writers before worktree/branch proof cleanup, never repeats promotion/document closing or resets/checkpoints landed code, and blocks new scheduling or run completion while cleanup IDs remain.

## Verification evidence

- All seven required project gates passed on the final frozen source: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, and the unfiltered `npm run test:quiet`. Root receipts/raw logs: `_scratch/queue-pause/gates-after-review5/`; all task hashes were unchanged during verification.
- A genuinely new independent verifier used `task-completion-gate`, reran the seven required commands, reviewed the task diff and executing paths, and returned `VERDICT: PASS` with no unresolved actionable findings. Report: `_scratch/queue-pause/fresh-gate-6.md`; its command evidence is under `_scratch/queue-pause/fresh-gate-6/`.
- Focused runtime/component coverage includes real Git checkpoint/reset/reattachment, held recovery, deferred and failed cleanup, concurrent controls, atomic routing and account selection, protected-scope authority, editor draft retention, complete operational-run listing and migration compatibility. Outcome-retirement and landing-cleanup repairs passed their focused Plan Queue suites before the project-wide gates; repair evidence is recorded in `_scratch/queue-pause/checker-cleanup-fix.md` and `_scratch/queue-pause/landing-cleanup-fix.md`.
- The five named plan guards and additional dispatch, scheduling and terminal-readiness guards were removed temporarily to prove their regressions fail, then restored before final verification. Evidence remains in `_scratch/queue-pause/`; no mutations, test skips, assertion weakening, harness changes or dependency changes remain in this task.
- Verification used the project's already-installed Node v24.15.0 through child-process PATH only. The documented four-fork quiet-suite setting changed no test selection or harness. Installed dependencies were used; no clean reinstall or whole-repository health certification is claimed.
- The active app was not restarted, no real backlog or provider session was changed, and no local interactive browser/desktop was used. Real provider/account/spend/restart evidence remains explicitly deferred. No development branch or checkout worktree was created, and no commit or push was made.
