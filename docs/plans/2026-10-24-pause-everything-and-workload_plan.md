# Pause everything for a restart, and a workload slider — implementation plan

On main: no.

**Status:** NOT STARTED. Written 2026-10-24 from a read-only investigation; no code changed. Revised the same day after
an independent review (3 high, 5 medium, 3 low findings, all applied; see "Review log" at the end). Waiting on James's
answers to the spec's section 8 decisions. Every step assumes the recommended answer; where a different answer changes a
step, the step says so.
**Spec:** [2026-10-24-pause-everything-and-workload_spec_planned.md](2026-10-24-pause-everything-and-workload_spec_planned.md).
**Replaces:** step 1 (L11) of [2026-10-20-oct2-later_plan.md](2026-10-20-oct2-later_plan.md).

## Ground rules

- Read the whole file plus its callers, types and tests before editing. Reproduce each "today" behaviour in a failing
  test before changing it.
- Work in the current checkout. No branch or worktree, never `git stash`, never stage or revert other sessions' work.
- Never restart the running Harness while it has live sessions. Anything needing a rebuilt or restarted app goes into
  the livetest doc (Phase 7).
- No browser or desktop app on the Mac. Renderer checks use the dev app with store seeding or the headless test
  runners. Anything needing a real browser goes to `windows-pc` or into the livetest doc.
- Respect the file-size ratchet (`npm run check:ts-max-loc`). `settings.types.ts` is at 888 of about 889 lines and
  `instance-manager.ts` is very large: new logic goes in new modules, with one-line hooks in the existing files.
- New `@contracts/schemas/...` or `@contracts/types/...` subpaths must be added to `tsconfig.json`,
  `tsconfig.electron.json`, `src/main/register-aliases.ts` and `vitest.config.ts`.
- Prompts follow `docs/prompt-engineering-house-style.md`. Visible wording follows `docs/screen-and-wording-guide.md`.
- Commit only when James asks. Keep this plan and the spec untracked until both are `_completed`.

## Evidence (read on 24 October; re-check line numbers before editing)

`[V]` = read on the executing path. `[E]` = exists, wiring not confirmed. `(checked twice)` = confirmed by the planner
or the independent reviewer as well as the research pass. Re-confirm the rest when the step that depends on them starts.

**Existing pause (the VPN feature's)**
- `PauseCoordinator` (`src/main/pause/pause-coordinator.ts`): reasons `vpn | user | detector-error`, persisted in the
  electron-store `pause-state`, dropped at boot if older than 24 h (`:18`, `:63-66`). [V, checked twice]
- While paused it refuses **everything**, James's own messages included: `sendInput` (`instance-manager.ts:1451`),
  permission answers (`instance-handlers.ts:1055`, `instance-communication.ts:1065`), recovery-banner restores
  (`continuity-recovery-coordinator.ts:92`), and a new chat's first message is queued (`instance-lifecycle.ts:1035`).
  On `pause` it interrupts every active instance (`instance-manager.ts:906-927`). [V, checked twice]
  **Consequence for this plan:** the global pause must not use `PauseCoordinator`, or James is locked out of his chats.
- The toggle is shown only when `pauseFeatureEnabled` (`app.component.html:25`); James's live value is `false`. The
  network gate blocks main-process HTTP on any reason while the feature is on (`pause-feature-bootstrap.ts:177`). [V,
  checked twice] This plan leaves the VPN feature and its toggle unchanged.

**Interrupt, wait, restore**
- `InstanceManager.interruptInstance` → `InterruptRespawnHandler.interrupt` (`lifecycle/interrupt-respawn-handler.ts:278-536`):
  15 s completion deadline, force-cancel at 30 s, leaving the session `cancelled`. Claude (resident), Codex app-server,
  Copilot server and ACP interrupt in place; Gemini, Cursor and Antigravity fall back to SIGINT. [V]
- `waitForInstanceSettled(id, {afterTimestamp, timeoutMs, signal})` (`instance-settled-tracker.ts:108-236`). [V]
- Automatic continuations (`instance-continuation-dispatch.ts:236-242`, announce-then-halt, async-work,
  reasoning-collapse, crash-turn) check only `PauseCoordinator.isPaused()` and managed-loop status. [V, checked twice]
  The renderer drains James's queued messages on the idle transition, gated only on the pause store
  (`instance-messaging.store.ts:117, 656`). [V]
- Children: `parentId`/`childrenIds`; terminate cascades by default, interrupt does not. Children are excluded from
  recovery and History (`session-recovery-candidate-service.ts:249-258`). Gemini sessions are also excluded from
  recovery candidates (`:250`). [V]
- **Engine-owned sessions are mixed.** Plan Queue workers and verifiers are children of the run's parent session
  (`plan-queue-item-flow.ts:212, 407`, `parentId: liveParentId(run)`). Ping-pong reviewers, automation and repo-job
  sessions are root-level with no parent (`reviewer-session-spawner.ts:154-166`). Claude loops usually borrow the parent
  chat's own provider process rather than a child (`loop-adapter-borrow.ts:112-128`, with an adapter loan). [V, checked
  twice]
- Quit kills every CLI process synchronously after saving continuity state (`index.ts:147-156, 366-402`); notes cannot be
  collected during quit. [V]
- Launch restarts no session. History restore: `SessionRevivalService.revive(request)`; the request requires
  `reviveIfArchived: boolean` and `reason: 'thread-wakeup' | 'history-restore'`; the result's `restoreMode` is
  `native-resume | resume-unconfirmed | replay-fallback`; lookup matches `id`, `originalInstanceId`, `historyThreadId`
  or `sessionId` (`session-revival-service.ts:12-27, 170-183`). [V, checked twice]
- Provider-limit park resume calls `sendInput`, which fails while paused and is only logged
  (`instance-provider-limit-handler.ts:689-730`). [V]

**Engines**
- Plan Queue: `pauseRun` → `holdItem` stops worker/verifier and commits "Plan queue checkpoint: paused"
  (`plan-queue-run-hold.ts`, `plan-queue-worktree.ts:164-193`). `pauseAll`/`resumeAll` (`plan-queue-coordinator.ts:413-419`)
  record nothing. The pump (`:519-556`) uses per-run `workerSlots` (schema 1–8), a verification cap shared across runs,
  a raw `maxLoadAverage` (30), and also starts triage (`:540`). [V, checked twice]
- Loops: `pauseLoop` lets the round finish (`loop-coordinator.ts:1346-1355`); boot sets running loops to `paused` /
  `app-restart` (`loop-store.ts:561-583`); loop timed wake-ups at `:1410`. No global cap, no expiry. [V, checked twice]
- Campaigns start the next loop when a node finishes; after a restart a campaign stays paused until its node's loop is
  resumed (`campaign-coordinator.ts:175-185`). [V, checked twice]
- Automations: pause = `enabled`; per-automation `skip|queue`; no global cap; a run in progress at quit is failed at
  next launch (`automation-store.ts:686-701`); catch-up also runs on wake from sleep (`automation-scheduler.ts:161`). [V]
- Other unattended starters: repo jobs (`repo-job-service.ts:565`), cross-model review, multi-verify/debate/review/
  workflow runs through `default-invokers.ts`, the orchestration provider-limit resume timer
  (`provider-limit-resume-scheduler.ts:76`), `run_on_node` spawns (`orchestrator-tools-step.ts:445`). [V per review]

**Limits that the slider can drive**
- `maxTotalInstances` (20, counts James's chats, refuses) and `maxChildrenPerParent` (10, lifetime) in
  `instance-orchestration.ts:276-305`. [V, checked twice]
- `concurrencyLimitByProvider` (ACP only; waiters time out after 30–60 s and fail). [V]
- Codemem prewarm (2), codebase auto-index (1), knowledge mirror (1): read live. [V]
- Shared worktree cap 5, fixed (`worktree.types.ts:181`). [V]
- Settings emit `setting:<key>` on change (`settings-manager.ts:261-262`). [V]

**Litter to avoid repeating:** loop `HANDOFF.json` under `.aio-loop-state/` has no cleanup; `last-stop.json` is not
cleared after restore. [V]

## Design in one paragraph

One new main-process service, **WorkAdmission**, answers "may this piece of unattended work start now?" at every
start-of-work point. It combines the **GlobalPause** state (none, holding, collecting, ready, resuming) with the
**WorkloadPolicy** for the slider level, live counts and the load average. Over-limit work waits and is re-pumped on
`admission-changed`. GlobalPause owns one persisted **pause batch** in SQLite listing the sessions, queue runs, loops,
campaigns and automation runs it stopped, with at most one note per session. GlobalPause **does not use
`PauseCoordinator`**: James can always open and use any session. Instead it holds the *recorded* sessions against
automatic input only (continuations, wake-ups, the renderer's queued-message drain), and a message James types into a
recorded session takes that session out of the pause and voids its note. An **engine-owned classifier** keeps Plan
Queue workers and verifiers, loop sessions, reviewers, automation and repo-job sessions out of note collection and out
of the helper count; their engines pause them their own way.

## Phase 0. Reproduce today's behaviour (failing tests first)

1. Plan Queue with `PauseCoordinator` paused: the pump still starts a queued item and the refused first message sets it
   aside (claim from the 20 Oct investigation). Expected after Phase 1: under GlobalPause the pump does not start it.
2. Provider-limit resume while held: today it is dropped after a logged failure. Expected: deferred to release/Resume.
3. Loops: interrupting an in-flight round, both a child-backed round and a Claude round borrowing the chat's adapter.
   Record what the loop logs (failed iteration, transport error, crash count). Phase 3 step 4 depends on the result.
4. Automation run in progress at quit is failed at the next launch. Expected after Phase 4: re-tracked when its session
   is in an open batch.
5. An announce-then-halt continuation fires after a reply ending in "Next step: …". Expected after Phase 3: not for a
   held session.

## Phase 1. WorkAdmission, GlobalPause skeleton, and "Hold new work" (L11)

1. `src/main/work-admission/work-admission.ts`: singleton (`getInstance`, `getWorkAdmission()`, `_resetForTesting`).
   `check(kind, ctx) → { allowed: true } | { allowed: false; reason: 'held' | 'paused' | 'over-limit' | 'computer-busy';
   detail: string }`. Kinds: `queue-job`, `queue-check`, `queue-triage`, `loop-round`, `campaign-node`, `automation-run`,
   `repo-job`, `helper-agent`, `consult` (multi-verify/debate/review/workflow/cross-model), `background-index`,
   `timed-wakeup`. Engines register counters (`registerCounter(kind, () => number)`); the service holds no engine state.
   Emits `admission-changed`.
2. `src/main/work-admission/engine-ownership.ts`: `ownedByEngine(instance)` keyed on the existing markers
   (`planQueueRole`, ping-pong reviewer, automation run id, repo job id, loop run id / adapter loan, campaign). Unit tests
   for each marker, including a Plan Queue worker that has a `parentId`.
3. `src/main/global-pause/global-pause-service.ts`, phases `none | holding | collecting | ready | resuming`. Phase 1
   implements `none ↔ holding`, persisted with `since` and `reason`.
4. Gates. **Hold** stops engine starts only; work a running session starts for itself (helpers, consults) continues,
   because "anything already running finishes". **Pause for restart** (Phase 3) stops all kinds.
   - Plan Queue pump: no `startItem`, `startVerification` or `triage.maybeStart` while not admitted; re-pump on
     `admission-changed`.
   - Loop round start and loop timed wake-ups: wait on WorkAdmission, reusing the `waitWhilePaused` pattern.
   - Campaigns: no next node while not admitted.
   - Automations: held fires (including sleep-wake catch-up) become pending rows, not `skipped`, dispatched on release.
   - Repo jobs: queued, not started.
   - Timed wake-ups (provider-limit resumes in both schedulers, automation retries, crash-turn auto-continue, doc-review
     and cross-model deliveries): kept and replayed on release, never dropped.
5. IPC: `global-pause:get-state`, `global-pause:hold`, `global-pause:release`, `global-pause:state-changed` (push), in new
   contracts modules `channels/global-pause.channels.ts` and `schemas/global-pause.schemas.ts` (Zod), preload exposure,
   `src/main/ipc/handlers/global-pause-handlers.ts`. Update the four alias files.
6. Sentinel: `userData/hold-new-work` present at launch or appearing while running engages Hold ("Held by a file in the
   data folder"). Removing the file does not release it.
7. Hold reminder: after 3 days the chip says "Holding new work since <day> · Release". Hold never expires on its own.
8. Tests: WorkAdmission and GlobalPause units; one test per gate proving held work waits and runs on release; Phase 0
   tests 1 and 2 pass.

## Phase 2. Workload slider (main process)

1. Setting `workloadLevel: 1 | 2 | 3 | 4 | 5`, default `3`, in a new `src/shared/types/workload-settings.types.ts` that
   `AppSettings` extends. Default in `settings-defaults.ts`, metadata in `settings-metadata-runtime.ts`, policy tier
   `open` in `settings-control-policy.ts` so `aio-mcp settings set workloadLevel` works.
2. `src/main/work-admission/workload-policy.ts`: pure `limitsFor(level, cpuCount)`, the spec's section 6 table. Rules,
   pinned by unit tests:
   - Level 3 returns `null` for every new limit: each run keeps its own slots, no cross-run cap, the queue keeps its own
     `maxLoadAverage`, and nothing else gets a load gate. The default changes nothing.
   - Levels 4 and 5 are never stricter than level 3 on any axis: they add no cross-run cap and no load gate for loops or
     automations; they raise each run's effective slots to at least 4/5 workers and 2/3 checks, raise the queue load
     threshold to at least 2.5/3.0 per core, and double background indexing. All bounded by the 5 shared work folders.
   - Levels 1 and 2 add cross-run caps, per-core load gates for every engine, and helper-agent caps.
3. WorkAdmission applies the limits:
   - `queue-job`, `queue-check`: the cross-run cap at levels 1–2, on top of each run's own slots.
   - `helper-agent`: running children that are local (remote excluded, decision 9) and **not** `ownedByEngine`, against
     `limits.helperAgents`. James's own sessions never count. Over the limit, `spawn-child` refuses: "Harness is set to a
     light workload (at most N helper agents at once). Carry on without one, or try again when one finishes."
     (Decision 8b would replace this with a wait queue; not in the first version.)
   - `loop-round`, `campaign-node`, `automation-run`, `repo-job`: cross-engine caps at levels 1–2; over the limit waits.
   - `computer-busy`: 1- and 5-minute load average against `limits.loadPerCore × cpuCount`.
4. Background helpers read the override when present: level 1 pauses codemem prewarm, auto-index and knowledge mirror
   (their queues are kept); level 5 doubles today's values.
5. Live change: on `setting:workloadLevel`, recompute and emit `admission-changed`. Lowering never stops running work.
   Test: with 3 queue jobs running, lowering to level 1 lets all 3 finish and starts none until the count drops below 1.

## Phase 3. Pause for restart: batch store and note collection

1. SQLite tables in `rlm.db` (next free RLM migration at implementation time; 079 was free on 24 Oct, re-check):
   - `global_pause_batches(id, phase, created_at, ready_at, resumed_at, discarded_at, expired_at)`; a partial unique index
     allows one batch with `phase NOT IN ('resumed','discarded','expired')`.
   - `global_pause_entries(id, batch_id, kind, target_id, display_name, workspace, provider, original_instance_id,
     history_thread_id, provider_session_id, was_busy, note_text, note_kind, state, void_reason, created_at,
     updated_at)`. `kind`: `session | queue-run | loop | campaign | automation-run`. `note_kind`: `agent | basic | none`.
     `state`: `pending | note-requested | ready | resumed | failed | void`. Unique `(batch_id, kind, target_id)`.
   - `src/main/global-pause/global-pause-store.ts` with prepared statements and tests on the suite's wasm SQLite.
2. `GlobalPauseService.pauseForRestart({ withNotes })`, in this order:
   1. Phase `collecting`; WorkAdmission refuses every kind (`paused`), so add the remaining gates now: `spawn-child`,
      `run_on_node` and consult starts (multi-verify, debate, review, workflow, cross-model). Reuse the open batch if
      there is one.
   2. Record entries: each live session that is not `ownedByEngine` and has no parent (`was_busy` = busy or waiting;
      idle = no note needed); each `running` Plan Queue run; each running loop; each running campaign; each automation run
      in progress.
   3. Hold the recorded sessions against automatic input: the continuation dispatcher, announce-then-halt, async-work,
      reasoning-collapse and crash-turn guards, and the provider-limit resume all check
      `GlobalPause.holdsAutomaticInput(instanceId)`; the renderer's queued-message drain waits for held sessions (queued
      messages are sent after the continuation turn on Resume, or straight away if James messages the session himself).
   4. Plan Queue: new `pauseRunsForGlobalPause(): Promise<string[]>` beside `pauseAll`, using `pauseRun`, returning exactly
      the runs it paused, and awaited before anything else touches those sessions (the checkpoint commit must finish).
   5. Loops: `pauseLoop`, then interrupt the round: the child if there is one, or the borrowed chat adapter. Wait for the
      adapter loan to end before that chat's note is requested. Apply the Phase 0 test 3 finding: if an interrupted round
      counts as a failed or crashed iteration, add an `interrupted-by-pause` outcome that re-runs the round on resume, as
      the boot reconcile does for `app-restart`. Campaigns: recorded; their node loops are in the batch.
   6. Helper agents (children of recorded sessions that are not `ownedByEngine`): capture each one's last assistant
      message (first 1,500 characters) onto the parent's entry, then terminate them through the normal terminate path.
   7. Notes: `global-pause-note-collector.ts`, at most N sessions in parallel (N = slider level 1–5). For each `was_busy`
      session: interrupt and wait to settle (up to 30 s; force-cancelled → basic note); record `T`; send the note prompt
      with a dedicated internal input source `global-pause-note`; `waitForInstanceSettled({ afterTimestamp: T,
      timeoutMs: 180_000 })`; store the last assistant message. Parked, hibernated, uninterruptible, remote-disconnected
      and timed-out sessions get a **basic note** with no model call: last request, last assistant excerpt, helper
      excerpts.
   8. Note prompt (`global-pause-prompts.ts`, provider-neutral, house style): role and goal first; headings Task, Done,
      In progress, Next step, Waiting on James; about 200 words; "do not start new work or run tools; reply with the
      note only". One complete example. Tests: headings present; the continuation guards ignore a held session whose
      note ends with "Next step: …" (Phase 0 test 5).
   9. `withNotes: false` ("Skip the rest" or "Pause now without notes") writes basic notes for the remaining sessions.
   10. Phase `ready`. No `PauseCoordinator` reason is added.
3. James during `collecting`/`ready`: he can open any session and start new chats. A message he types into a recorded
   session is sent normally, marks its entry `void` (`void_reason: 'picked-up-by-james'`) and lifts its automatic-input
   hold. Spec section 3.4 states this.
4. Remote sessions: same flow over `RemoteCliAdapter` RPC; a disconnected node gets a basic note and says so.
5. Tests: collector with fakes for success, timeout, force-cancel, parked, remote disconnect; one batch at a time; queue
   workers excluded from notes and helper capture; checkpoint finishes before anything else touches queue sessions; only
   runs that were running are recorded; a typed message voids the entry.

## Phase 4. Resume (in place and after a restart)

1. Boot: `GlobalPauseService.bootstrap()` reads the open batch.
   - `ready`: keep WorkAdmission at `paused` and the automatic-input holds (by recorded identity, since instance ids may
     change after a restart).
   - `collecting` (quit or crash mid-pause): treat as `ready`; entries without a note get a basic note.
   - `resuming` (quit or crash mid-resume): carry on with the entries not yet `resumed`/`failed` when James presses
     Resume again; the chip says "Resume was interrupted · Resume the rest".
   - No 24 h expiry (decision 6a); Phase 5 handles old batches.
2. `resume()`:
   1. Phase `resuming`; WorkAdmission admits again, subject to the slider.
   2. Sessions, paced by the slider (1–5 at a time). Live instance with that id → send the continuation prompt.
      Otherwise call `SessionRevivalService.revive({ instanceId, providerSessionId, workingDirectory,
      reviveIfArchived: true, reason: 'global-pause-resume' })` (add the reason to the union), using the recorded
      `original_instance_id`, `history_thread_id` and provider session id. `native-resume` → short prompt ("Harness
      paused you for a restart. Your last reply is your note on where you got to. Carry on from there."). `resume-
      unconfirmed` and `replay-fallback` → the note goes into the prompt inside a named delimiter. Idle entries are only
      reopened. Then drain any queued messages for that session.
   3. Gemini sessions are excluded from recovery candidates; confirm History revival works for them, or mark their
      entries "reopen from History by hand" with the note shown.
   4. Recovery banner: hide candidates that belong to the open batch, so nothing is restored twice.
   5. `resumeRun` for exactly the recorded queue runs; `resumeLoop` (live) or `resumeLoopRun` (after a restart) for the
      recorded loops; resume recorded campaigns once their loop is running; re-track recorded automation runs instead of
      failing them at boot (Phase 0 test 4).
   6. Replay held wake-ups, then provider-limit parks whose reset time has passed.
   7. Each entry ends `resumed` or `failed` with a plain reason; the batch ends `resumed`; push a one-line summary.
3. `discard()`: phase `discarded`, null every `note_text`, lift holds. Recorded queue runs, loops and campaigns stay
   paused and the summary says so.
4. Tests: resume in place; resume after a simulated restart for all three restore modes; a failed revival affects only
   its entry; banner dedupe; only recorded runs resume; boot from `collecting` and from `resuming`.

## Phase 5. Stale-note hygiene

1. Void triggers (entry `state = void`, `note_text = NULL`, `void_reason` set): James closes or deletes the session (not
   the automatic terminate during quit); James types into it (Phase 3 step 3); its queue item or run ends; its loop or
   campaign is closed or completed; its automation run ends; its History entry is deleted.
2. Sweep at startup and every 6 hours (`global-pause-sweep.ts`, timer `unref`'d and cleared on shutdown):
   - Batch age ≥ 3 days, still waiting: the chip says "Paused 3 days ago · Resume or discard".
   - Age ≥ 14 days: phase `expired`, `note_text = NULL`, holds lifted. Sessions stay in History with their notes in
     their conversations. Recorded queue runs, loops and campaigns stay paused, as with Discard, and a notice says so.
   - Delete `resumed`/`discarded`/`expired` batches and their entries 30 days after they ended.
3. No note files are written to project folders or `userData`.
4. Tests: each void trigger; the 3-day flag; 14-day expiry; 30-day purge; an expired batch no longer blocks a new pause.

## Phase 6. Renderer, settings, aio-mcp, docs

1. `src/renderer/app/core/state/global-pause/global-pause.store.ts` (signals; private writable, readonly exposure) and an
   IPC service in the existing facade pattern. The messaging store's drain consults it for held sessions.
2. `work-control.component.ts` (standalone, OnPush, `inject()`, signal inputs) in the title bar, always shown.
   `<app-pause-toggle>` stays behind `pauseFeatureEnabled` for the VPN feature.
   - Plain button when healthy. Chip states: holding; collecting ("Writing notes: 4 of 6"); ready ("Safe to restart" +
     **Quit Harness**); waiting after restart ("Paused for restart, 6 sessions waiting · Resume"); resume interrupted;
     old pause or old hold.
   - Panel: Pause for restart with its consequence beside it; Hold new work; the Workload slider with the level's
     one-line meaning; the running-work count; Resume / Discard / Skip the rest when relevant. Discard says the notes are
     deleted and which runs stay paused.
   - Icon-only controls use `[appIconButton]`; consequences sit beside controls; tooltip text in `TOOLTIP_COPY`; glossary
     entry for "Workload" if the settings text needs one.
   - A held session's header shows one quiet line: "Paused for restart. Typing here takes it out of the pause."
3. Settings: a "Workload" section in the Orchestration tab with the same slider (the setting is the single source).
4. `aio-mcp`: `workloadLevel` through the settings commands; a `pause` group with `status`, `hold` and `release` only.
   Pause for restart, Resume and Discard stay with James. Update `docs/AIO_MCP_CLI.md` and
   `docs/llm/AIO_MCP_CLI_REFERENCE.md`.
5. Renderer tests: chip states from seeded store values; slider writes the setting; Discard confirmation text; the
   drain waits for a held session; `npm run check:ui-hints` clean.
6. If decision 11 is (a), edit the Later plan's step 1 to a one-line pointer to this plan (it is active, so allowed).

## Phase 7. Verification and completion

1. Targeted tests per phase (`npm run test:quiet -- <files>`), then the full `AGENTS.md` checklist: `npx tsc --noEmit`,
   `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
   `npm run build:renderer`, `npm run test:quiet`.
2. Dev-app checks (not the running Harness): hold and release with a fake queue run; slider change visible in the panel
   and in admission decisions; pause for restart with two scripted sessions giving one agent note and one basic note;
   typing into a held session voids it; resume in place.
3. Livetest doc `2026-10-24-pause-everything-and-workload_livetest.md` (with the standard remediation header) for what
   needs a rebuilt app and James: a real pause for restart with live Claude and Codex sessions, a Plan Queue run and a
   loop; quit; relaunch; Resume; each session carries on from its note and only recorded runs restart; a remote session
   on `windows-pc`; the slider at Lightest during a heavy period, watched with `uptime`.
4. Fresh-eyes completion gate (a new agent using `task-completion-gate`), repeated until it passes.
5. Update both documents' status and as-built notes, then rename both to `_completed` (spec link first).

## Risks and open questions

- **Interrupt reliability varies by provider.** SIGINT-only providers can exit, and a respawn after exit may send input
  without checking holds (`instance-communication.ts:2084-2094`, [E]). Phase 3 must confirm no respawn sends input to a
  held session, and that force-cancelled sessions still revive.
- **Loop interruption semantics** (Phase 0 test 3) may need a new iteration outcome, especially for borrowed adapters.
- **Concurrent writers.** Other sessions edit this repo and add migrations; re-check the migration number and re-read
  files immediately before editing.
- **Cost.** One short turn per busy session; "Skip the rest" and the no-notes option bound it.

## Review log

2026-10-24, independent read-only review of the first draft. Applied:
- H1: the first draft added a `restart` reason to `PauseCoordinator`, which would have refused James's own messages,
  permission answers and banner restores for up to 14 days. Replaced with per-session automatic-input holds;
  `PauseCoordinator` is untouched.
- H2: engine-owned classifier added; queue checkpoint awaited before anything else touches queue sessions.
- H3: continuation guards and the renderer drain respect holds from `collecting` onward.
- M1: revival call corrected (`reviveIfArchived`, reason union, three restore modes, recorded identifiers).
- M2: gates added for triage, consults, loop wake-ups, both provider-limit schedulers, campaigns, repo jobs, sleep-wake
  catch-up, `run_on_node` (via the helper kind's remote rule).
- M3: borrowed loop adapters handled. M4: boot from `collecting`/`resuming`. M5: Hold reminder.
- L1–L3: level 3 = today exactly, levels 4–5 never stricter; cross-run checks wording; expiry keeps runs paused; Gemini
  route stated.
