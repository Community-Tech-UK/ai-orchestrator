## Snapshot of 2026-11-12-mac-still-pinned-part-b_history.md

# Part B history

## Round 1 (26 November 2026): B1 and the switch rule of B2

Prerequisites found landed: [agent sessions on other computers](2026-11-08-agent-sessions-on-other-computers_plan_completed.md) (B.1 to B.4)
and [Plan Queue jobs on other computers](2026-11-08-plan-queue-jobs-on-other-computers_plan_completed.md). Part A has been in use with the
switch off (`useThisMac: false` in the real config).

**Built (worktree `queue/2026-11-12-mac-still-pinned-pa-cbef2c`):**

- Queue placement (`plan-queue-remote-placement.ts`): with the switch off, a job that a computer set to take jobs could take later (away,
  paused, at its job limit) gets `wait`, not `here`. Jobs nothing could take (no computer set to take jobs, tool not signed in, tool other
  than Claude/Codex, project not checked, older Harness) still run here, with the reason on the timeline (a new line when no computer takes jobs).
- Pump (`plan-queue-pump.ts`): a `wait` job stays queued with "Waiting for a computer: ...". It ignores this Mac's load, since that no longer matters.
  `startItem` reserves the job's place on the computer before the next job is decided (`reservePlace`), so jobs started in one pass can't overfill it.
- Away jobs (`awayExpired`): with the switch off a job keeps waiting for its computer instead of carrying on here after ten minutes.
- Automations: `automationComputerRule` (switch off): only the connected test Mac (a macOS test machine, matched by `nodeName ?? host`
  against the computer's name); a job in a Git repository stays here with the reason (waits for B2's checkout move); none linked: stays with the reason.
  The switch implies "ask for another computer". `selectNode` got `limitToNodeIds`. `resolveNewSessionPlacement` reports `mightWaitForComputer`
  (busy, paused, away, unknown sign-in) separately from lasting causes. Admission got `waitingForComputer`, asked at each check, so the existing
  5-second admission tick starts a held run once the test Mac is free. The runner's three admission sites share `admissionContext`.
- `scripts/check-ts-max-loc.ts`: automation-runner ceiling 823 to 835 (on purpose).

**Checks:** `npm run typecheck`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `check:ui-hints`, `build:main`, `build:renderer` all passed
(`npm run checks`). Targeted: `npm run test:quiet -- src/main/instance src/main/automations src/main/work-admission src/main/plan-queue
src/main/remote-node src/main/computers scripts` 788 files, 10,982 tests passed. `generate:architecture` changed nothing.

**Not built, and why:**

- **B3 (PC sessions inside its Linux)**: needs the Linux worker run for real and a sign-in for each tool inside it; can't be proven here. The queue
  already lets the PC take jobs through its Windows worker when James turns that on per computer (tests route to its Linux side); automations
  exclude the PC until B3 as the plan says.
- **Loops on another computer** (named in B2's title): a loop keeps control files, verify and its working copy on this disk; needs its own design.
- **Undistilled's two browser tests** (Part A, A5): a change in that project, which had uncommitted work in the same files; untouched.
- **Faults mid-job** (send failure, session would not start, computer has no copy) still carry the job on here from its last checkpoint, with the switch off too.
- **Repository automations** stay here until their checkout can move.

## Round 2 (26 November 2026): scope narrowed after verifier finding

A verifier failed round 1 because the plan still described unbuilt work (loops on another computer, repository automations, mid-job faults, B3).
No code changed. The plan now covers only B1 and the B2 switch rule, which are built and checked above. The unbuilt items moved unchanged in
substance to [Part C](2026-11-26-mac-still-pinned-part-c_plan.md) (untracked, active). The livetest is unchanged: it only covers B1 and the switch rule.
Livetest checks LT-B1a to LT-B2c stay deferred (they need a rebuilt and restarted app).

## Round 3 (26 November 2026): two races fixed after verifier round 2

**Finding 1 (queue job starts here after the computers fill up):** `PlanQueueRemoteTurns.arrange` re-reads the placement under the placement lock.
When it says `wait` and the job is still `preparing`, the job is now moved back to `queued` with the reason (`host.transition`), and
`PlanQueueRemoteFlow.arrange` returns null for a queued result so `startItem` stops (its folder stays, as after a transient fault, and the next
start reattaches it). A job already running (restart, new worker, step-up) still carries on here with the timeline note.

**Finding 2 (automation starts here after the test Mac fills up post-admission):** `refuseToRunHereWhileWaiting` (default-computer-placement.ts)
throws `ComputerBusyError` when a session with a `computerRule` would be placed locally with `mightWaitForComputer`. `createInstance` checks it
before the session exists, and again when the session is placed (phase 2). `AutomationRunner` catches it at both points
(`waitForComputerAgain`): the run stays running with no session, and a deferred dispatch (5 s pause, then admission) starts it again.
`check-ts-max-loc` ceiling for automation-runner.ts raised 835 -> 860.

**Tests added:** turns spec (preparing job goes back to queued; running job carries on), flow spec (queued result stops), placement spec
(`refuseToRunHereWhileWaiting`), automation admission spec (ComputerBusyError keeps the run running, then retries after 5 s).

**Checks:** `npm run checks` typecheck, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer passed; `typecheck:spec` passed after fixing two
spec type errors. `npm run test:quiet -- src/main/plan-queue src/main/automations src/main/instance/lifecycle src/main/instance/instance-lifecycle`:
361 files, 5,333 tests passed. Livetest unchanged (the races are covered by unit tests).

## Round 4 (26 November 2026): verifier round 3 findings

- **Finding 1 (paused or away computer without the job's sign-in made the job wait):** `refusalDetail` in
  `src/main/plan-queue/remote/plan-queue-remote-placement.ts` now judges lasting problems first (tool other than Claude or
  Codex, older Harness, missing sign-in, project not checked or failed), from whatever is known even while the computer is
  paused or away. Only then do paused, away and full count as "wait". An away computer whose report is gone (the registry
  drops it on disconnect) still reads as "away" and waits, because its sign-ins aren't known.
  New specs in `plan-queue-remote-placement.spec.ts`: five combined cases run here with the lasting reason; an away computer
  with no report still waits.
- **Finding 2 (deferred checks missing from the report):** the six live checks LT-B1a to LT-B1c and LT-B2a to LT-B2c are
  reported as deferred, under the same titles as the livetest document.
- **Checks:** `npm run test:quiet -- src/main/plan-queue/remote/ src/main/plan-queue/plan-queue-pump-remote.spec.ts
  src/main/plan-queue/plan-queue-remote-jobs.spec.ts` exit 0 (13 files, 199 tests); `npm run checks` exit 0 (typecheck,
  typecheck:spec, lint, check:ts-max-loc, check:ui-hints, build:main, build:renderer).
