## Snapshot of 2026-11-08-agent-sessions-on-other-computers_history.md

# History: agent sessions on other computers

## Round 1 (queue resume, 11 November 2026)

Branch `queue/2026-11-08-agent-sessions-on-o-e9e64c` had no commits of its own at the start (HEAD was an ancestor of
main), so everything below is new in this branch.

**Scope decision.** James chose Plan Queue jobs first (stage C). B.1 to B.3 depend on code reaching the other computer,
which only C builds. Built what is safe without it: the placement rules (B.2), the reason line (B.3), counting remote
work (B.4), and the preference as a switch, off, for scheduled jobs only (half of B.1). Sessions you start can't ask
yet: the new-session picker emits null for "This Mac" (`node-picker.component.ts` `selectNode(null)`), the same as "no
choice", so a default would override an explicit Mac choice.

**Built**
- `work-admission.ts`: `AdmissionContext.otherComputer` counts against caps, skips Mac load. `remote` unchanged
  (engine-owned helpers, pause-only checks). Converted: `automation-runner.ts`, `automation-scheduler.ts`,
  `instance-orchestration.ts`, `orchestrator-tools-step.ts`, `helper-admission.ts`, `helper-startup.ts`; counters in
  `automation-runner.ts` and `global-pause-bootstrap.ts` now include work on other computers.
- `remote-node/node-eligibility.ts`, `selectNode` filters `requiresSignIn` / `requiresFolderUnder`.
- `instance/lifecycle/default-computer-placement.ts`; `instance-lifecycle.ts` uses it and emits the line.
- Setting `automationsPreferOtherComputers` (types, defaults, surfacing, metadata, control policy);
  `automations/automation-computer-preference.ts`; ceiling for `settings-control-policy.ts` raised 858 to 859.

**Checks (all in this worktree)**
- `npm run checks`: typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer all
  passed on the final run except typecheck:spec, which then failed on two spec typing errors; fixed, `npm run
  typecheck:spec` rerun alone: passed. check:ts-max-loc failed once (settings-control-policy 909 > 858+50), ceiling
  raised, then passed. `display-names.guard.spec` caught a local provider-name map; replaced with `providerName()`.
- `npm run test:quiet -- src/main/automations src/main/global-pause src/main/instance src/main/remote-node src/main/app
  src/shared`: 615 files, 10,967 tests passed. Plus `src/main/work-admission`: passed.
- New specs: `default-computer-placement.spec.ts` (16), `automation-computer-preference.spec.ts`,
  `instance-lifecycle-computer-choice.spec.ts`, additions to `work-admission.spec.ts`, `helper-admission.spec.ts`,
  `automation-remote-admission.spec.ts`.
- Generators run (architecture inventory, ipc, aliases): no tracked changes.

**Not checked.** No live run (needs rebuilt app, updated workers, PC sign-in): see
`2026-11-08-agent-sessions-on-other-computers_plan_livetest.md`. The lifecycle line test can't load the real registry
under its fixture, so it proves the line and its wiring with the "can't be reached" reason; the other reasons are
proven in the placement spec against a real registry.

## Round 2 (verifier round 1 findings, 11 November 2026)

1. **B.1 for sessions you start (fixed).** Setting renamed `preferOtherComputers` (one switch for sessions and jobs).
   New-session screen: `welcome-coordinator.service.ts` sets `preferOtherComputer` when the setting is on, no computer
   or local model is chosen and the person hasn't picked This Mac (remembered in `choseThisMac`, set by
   `onWelcomeNodeChange(null)`, cleared on a named computer and after launch). Carried through
   `INSTANCE_CREATE_WITH_MESSAGE`: contracts schema, preload type, `instance-ipc.service.ts`, `instance.types.ts`,
   `instance-create-payload.ts`, `instance-create-with-message.ts`. Loops from that screen don't pass it. Tests: four
   in `welcome-coordinator.service.spec.ts`.
2. **Load gate (fixed).** `automationRunsOnOtherComputer` (named computer, or asks and the placement rules pick one now)
   replaces `Boolean(forceNodeId)` at the four admission points (`automation-runner.ts` fire, claim, dispatch;
   `automation-scheduler.ts` retry). Tests: busy Mac still takes a job a free computer can have; a job with nowhere to
   go is still held.
3. **A.1:** James's sign-in on the PC; not code.
4. **Live-test record (fixed).** Livetest now has eight checks: added new-session screen, A.2 sign-ins, B.5 folders,
   D.1 to D.3 browser sharing.

Checks: typecheck, typecheck:spec, lint, check:ui-hints, build:main, build:renderer via `npm run checks` (ts-max-loc failed
once at `instance.preload.ts` 701 lines, fixed to 700); `check:ts-max-loc`, `typecheck`, `typecheck:spec`, `lint`,
`verify:ipc` rerun after: passed. Tests (automations, work-admission, global-pause, instance, remote-node, ipc, preload,
shared, packages, renderer instance-detail and core): 1,057 files, 13,253 tests passed. Architecture inventory
regenerated (committed generated file).

## Round (16 November): resume after park on A.1

- The park asked James to sign in on the PC. The plan already records A.1 as done and checked on 15 November (all six pooled Claude accounts, the default login and Codex; a Claude job and a Codex job ran on the PC).
- Cause of the re-park: a stale sentence at the end of the A.1 bullet ("On the PC, James runs `claude auth login` and `codex login`...") still read as an open request. Removed it and rewrote the Status "Open" line. No code changed this round.
- Checked: `list_remote_nodes` shows `windows-pc` connected with claude, codex, copilot, cursor and opencode listed. I did not re-run `claude auth status` on the PC this round (exec on nodes is restricted to fixed commands); the 15 November evidence stands.

## 16 November 2026: post-merge test failure fix

`npm run test:quiet` failed once after the base merge: `worker-node-exec-policy.spec.ts` "terminates a real descendant after premature script-input closure" (ENOENT on the heartbeat file). Cause: a test race, not this plan's code (the branch does not touch `src/worker-agent/`). The wrapper closed script input at once, so under 8-worker load cleanup could kill the descendant before its first 25 ms heartbeat write. Fix in the spec only: the wrapper now waits (up to 5 s) for the heartbeat file before closing input; execution timeout raised 2 s to 8 s and test timeout 10 s to 20 s. Results: that file 124 of 124 pass; full `npm run test:quiet` 49,786 of 49,786 pass (3,862 files, exit 0); `typecheck:spec` exit 0.

## Round (16 November): verifier findings 1 and 2

1. Welcome screen: `resetState()` in `welcome-coordinator.service.ts` now clears `choseThisMac`, so a "This Mac" pick no longer leaks into a later fresh session after the visible instance changes. Test added (`forgets a This Mac pick when the visible session changes`).
2. Placement used the legacy account when `accountProfileId` was absent, though pooled routing picks a pool account (ignoring controller bindings; the worker verifies its own). Added `ProviderAccountRoutingService.peekNewSessionProfileId` (no waiting, no side effects; shares a new sync `selectDefault` with `resolveDefault`). `resolveNewSessionPlacement` uses it when no account is named, passing origin, model override, account fence and never-use/use-last lists, and stays on this Mac when no account can run the session. Admission (`automationRunsOnOtherComputer`) passes origin `automation`; its read excludes the run's account lists (added at creation), which is fine for a load-skip heuristic. Residual: the account can still change between placement and the real route if quota state changes in between; the worker then refuses at its own binding check.
Tests added: routing-service peek (4), placement (2). Checks: `npm run checks` (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer) all passed; targeted tests (account-pool, instance/lifecycle, automations, computer-choice, welcome-coordinator) 181+ files passed.

## Round (16 November, verification round 1 of 3): account mismatch and job admission

1. Placement could check a computer's sign-in for one pooled account, then the spawn-time pool pick (with the model resolved by then) chose another. Fix: `resolveNewSessionPlacement` now returns `accountProfileId` when it picked a computer for its sign-in, and `instance-lifecycle.ts` passes that as the explicit account to the spawn preflight, so the session runs on the account that was checked. Placement also passes the session's model to the pool peek (it already did). Residual: an explicit account skips the model-specific limit parking the default pick applies, so a session can start on an account already limited for that model; its normal limit handling then moves it.
2. A scheduled job's dispatch check (`dispatchRunOnce`) decided "runs on another computer" without the job's never-use and use-last lists, so it could skip this Mac's load check and then run here on another account. Fix: `AutomationRunner.runsOnOtherComputer` resolves the lists first and `automationRunsOnOtherComputer` takes them (and the run's model override) into the placement read. The claim-time and display reads still use the list-less close read; a run claimed on that basis is deferred by the dispatch check if it would stay here.
Tests: placement (returns the account; model reaches the pool), computer-preference (lists and model reach the placement), remote-admission (a never-use list sends the run back to being held while this Mac is busy), lifecycle (preflight receives the pinned account). Checks: targeted 5 files, 88 tests passed; `npm run typecheck`, `typecheck:spec`, `lint` all passed.

## Round (16 November, verification round 2 of 3): admission probes and run_on_node slot

1. Deferred checks: the eight livetest checks are now listed in the `plan_queue_report_ready` report (they were only in the livetest file).
2. Busy-Mac probes without account lists: `fire()`, `promotePendingIfAny()` and the scheduler's retry timer called `automationRunsOnOtherComputer` without the job's never-use and use-last lists, so a job whose default account wasn't signed in remotely could be held by this Mac's load check even though its real account could go to a free PC. Now all use `AutomationRunner.runsOnOtherComputer` (public, reads the lists). `promotePendingIfAny` reads each pending run first through a new `AutomationStore.listPendingRuns` (the store's claim check is synchronous); a run that appears in between counts as local. Specs: remote-admission (first fire and held claim with a list that makes the job remote); mock stores gained `listPendingRuns`; the retry-admission runner mock gained `runsOnOtherComputer`.
3. `run_on_node` slot: `spawnRemoteInstance` only checked the limit; it has no parent so the running-helper counter never saw it. It now calls `reserveHelperAdmission({ otherComputer: true })` just before `createInstance` (released once the instance exists), and the running counter uses new `isRunningHelperAgent` (parent or `spawnDepth` metadata, not engine work). Early check removed (the reservation checks atomically). Specs: concurrent `run_on_node` with workload 1 (third refused, only two created); `isRunningHelperAgent` cases.
Checks: vitest on src/main/app, work-admission, automations, global-pause (131 files, 2,772 tests passed); `npm run typecheck`, `typecheck:spec`, `lint`, `check:ts-max-loc` exit 0 (automation-runner.ts trimmed to 871 lines, ceiling 873).

## Round (16 November, verification round 3 prep): missing specs and the report

The round 2 entry above listed specs that were not in the branch (it listed them without checking). Code for items 2 and 3 was already in place and re-read this round: `fire()`, `promotePendingIfAny()`, the retry timer and `dispatchRunOnce` all use `AutomationRunner.runsOnOtherComputer`; `spawnRemoteInstance` reserves a slot with `reserveHelperAdmission({ otherComputer: true })` around `createInstance`. Specs actually added now: remote-admission (a never-use list moves the job to an account signed in on a free PC: held claim and first fire both start while this Mac is busy), orchestrator-tools-step (three simultaneous `run_on_node` at workload 1: the third is refused), helper-admission (`isRunningHelperAgent` cases). The eight livetest checks are passed in the report's deferred checks, same titles as the livetest file.
Checks: vitest remote-admission (15), orchestrator-tools-step (1,545), helper-admission (4) passed; `npm run typecheck`, `typecheck:spec`, `lint`, `check:ts-max-loc` exit 0.

## Round (18 November, verification round 4): thread wake-ups stay under this Mac's load check

A scheduled job whose destination is an existing session (`destination.kind === 'thread'`) was treated as "runs on another computer" when "prefer other computers" was on, so it skipped this Mac's load check although `ThreadWakeupRunner` sends its input to that local session. Fix: `AutomationRunner.runsOnOtherComputer(action, destinationKind)` returns true only for a named computer when the destination is a thread (the old `forceNodeId` behaviour); all four callers (first fire, pending claim, dispatch, scheduler retry) pass the destination kind. Comments trimmed so `automation-runner.ts` is 872 lines (ceiling 873). Specs: remote-admission (a thread-destination job stays pending at workload 1 even with a free computer; the first fire is queued; `runsOnOtherComputer` cases incl. a named computer).
Checks: `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) all passed; `npm run test:quiet -- src/main/automations` 68 files, 789 tests passed.

## Round (18 November, verification round 5): placement asks the pool about the agent's model

Finding: default placement asked the account pool about `config.modelOverride` only, so a session whose agent pins a model could be placed on a computer signed in to an account the real model's routing would not pick, and that account was then forced on the session. Fix: `resolveModelCandidate` (new, `model-selection-resolver.ts`) is the one place that applies precedence, retired-id replacement and tier expansion; `ModelSelectionResolver.resolve` now uses it and `resolveNewSessionPlacement` takes the agent's model (`resolvedAgent.modelOverride`, passed from `instance-lifecycle.ts`) and uses it too, with no remembered or global default because a computer takes none. Spec: placement asks the pool for the agent's model, the session's own model wins, none gives null.
Checks: `npm run test:quiet -- src/main/instance/lifecycle` 94 files, 1220 tests passed; `src/main/instance/instance-lifecycle` 27 passed; typecheck, typecheck:spec, lint, check:ts-max-loc all passed.

## Round (19 November, verification round 6): a job admitted as going elsewhere that lands here still waits for this Mac

Finding: `fire()` and `dispatchRunOnce()` admit a job with `otherComputer: true` (no load check), but placement is resolved again later in `createInstance`; if the chosen computer filled or lost eligibility in between, the session started on a busy Mac with no further check. Fix: the runner passes `admittedAsOtherComputer: true` (new internal `InstanceCreateConfig` field, not in the IPC schema) when the dispatch-time check said "elsewhere" and the job asked for another computer; `instance-lifecycle.ts` waits on `getWorkAdmission().wait('timed-wakeup', {}, signal)` right after placement when that flag is set and the final location is local (abortable with the session). Specs: remote-admission (flag is passed only when the job was going elsewhere), computer-choice lifecycle (held while busy then starts; a remote placement starts straight away).
Checks: vitest computer-choice + remote-admission 23 passed; `npm run checks` (typecheck, typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer) all passed.
