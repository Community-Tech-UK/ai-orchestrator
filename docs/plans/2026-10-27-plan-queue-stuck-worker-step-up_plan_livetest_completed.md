# Plan Queue: hand a stuck worker's document to a stronger model — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-27-plan-queue-stuck-worker-step-up_plan_completed.md](2026-10-27-plan-queue-stuck-worker-step-up_plan_completed.md)

**Prerequisites:**

- Rebuild and restart Harness from the checkout carrying this work
  (`npm run build:main && npm run build:renderer`, then restart). The `stepUp` routing field, loop
  migration 25 (`plan_queue_items.stepped_up_at`), the handover and the new "If a worker gets stuck"
  group only load after that restart. Do not restart Harness while James has live sessions: build
  first and let James restart.
- Every check needs **real provider turns** (paid Claude Haiku and Opus sessions plus a Codex checker
  on James's accounts) and an app restart, which is why they could not run in-loop. Everything
  verifiable without them is covered by tests: the handover, the once-only rule, restart between
  "handover recorded" and "new worker started", Pause during the handover and Resume of a parked
  handed-over document (`plan-queue-coordinator.spec.ts`, "handing a stuck document to the step-up
  worker"), routing and refusals (`plan-queue-routing.spec.ts`, `plan-queue-run-routing-change.spec.ts`),
  storage (`plan-queue-store.spec.ts`) and the screen (`plan-queue-routing-panel.component.spec.ts`,
  `plan-queue-item-list.component.spec.ts`).
- Run every check against a **scratch repository**, never the real backlog. For example:
  `git init /tmp/stepup-live && cd /tmp/stepup-live`, commit a README, and add one small plan
  `docs/plans/2026-10-27-hello_plan.md` ("Create hello.txt containing hello") with no spec.
- Verifier gate that fails once and then passes, kept **outside** the repository so the checker
  cannot change it: `/tmp/stepup-gate.sh` containing
  `if [ -f /tmp/stepup-gate.passed ]; then exit 0; fi; touch /tmp/stepup-gate.passed; exit 1`
  (`chmod +x`). Delete `/tmp/stepup-gate.passed` before each check.

## Checks

### LT-SU-1 — Forced handover

1. On the Plan Queue page, saved routing: Workers "Only these, in this order" → Claude, model
   "Haiku latest" (`haiku`, picked from the model suggestions); "If a worker gets stuck" → "Hand it
   to a stronger worker" → Claude, "Opus latest" (`opus`); Checkers "Choose automatically". Save.
2. From a Claude session in `/tmp/stepup-live`, call `plan_queue_start` with `kind: "plans"`,
   `max_rounds: 1`, `verifier_gates: ["/tmp/stepup-gate.sh"]`, `post_merge_gate: []`.

**Expected:** round 1 FAILs (the gate exits 1) → the document row says "Handed to a stronger worker
(claude / opus) after 1 failed check(s)" → a new nested worker session runs on Opus (its model shows
Opus; the Haiku worker session is closed) → the second check passes → the document lands with one
squash commit on the scratch repository's base branch. The starting session gets exactly one message
saying the document was handed to the stronger worker. `plan_queue_status` shows
`routing.stepUp: "claude / opus"` and `handedToStepUpAt` on the item.

### LT-SU-2 — Restart during the step-up worker's turn

1. Repeat LT-SU-1, but with a plan large enough that the Opus worker is still working for a minute
   (for example "write a 1,500-word essay into essay.md").
2. While the Opus worker is busy, quit and relaunch Harness.

**Expected:** after the restart the document resumes with a new worker session on **Opus**, not
Haiku; no second "handed to the stronger worker" message arrives; the document lands after its check.

### LT-SU-3 — Off by default

1. Set "If a worker gets stuck" back to "Stop and wait for me" and save. Delete
   `/tmp/stepup-gate.passed` and use a gate that always fails (`exit 1`).
2. Start the same run with `max_rounds: 1`.

**Expected:** the document parks as "Still failing after the last check" (`round-limit`) exactly as
before, with no Opus session and no handover message.

## Evidence run — 2026-10-27

Harness restarted by James on the build carrying this work. Each run was started by a one-time
automation (Claude Sonnet, auto-approve) whose session became the run's parent and passed
`workers` / `step_up` per run, so James's saved Plan Queue routing (empty) was not changed. The gate
`/tmp/stepup-gate.sh` failed until the tester created `/tmp/stepup-gate.passed`, which was done
only after the handover was seen (15:38:20), so round 1 could not pass by a re-run.

### LT-SU-1 — Forced handover: PASS

Run `6ef5e594-2c8b-4890-bfaf-3a941ccb1f72`, `/tmp/stepup-live`, `max_rounds: 1`, workers
`claude / haiku`, step-up `claude / opus`, checkers automatic.

- Triage reported ready (Claude). Worker 1 ran on `claude-haiku-5-5` (transcript 15:35:27–15:35:50 UTC).
- Checker (Codex `gpt-5.6-terra`) failed round 1 on the gate. At 15:38:00.209 the item was handed
  over: `plan_queue_status` showed `state: fixing`, `round: 0`, `handedToStepUpAt:
  2026-10-27T15:38:00.209Z`, detail "Handed to a stronger worker (claude / opus) after 1 failed
  check(s)." and run routing `stepUp: "claude / opus"`.
- Worker 2 ran on `claude-opus-5-5` (15:38:02–15:38:48 UTC); its first prompt began "You are
  resuming a Plan Queue item" and carried the step-up instruction.
- The second check (Codex) passed; the item `landed`, round 1, verdict PASS.
  `/tmp/stepup-live` `main`: `94e1283 Plan: 2026-10-27-hello_plan` over `887dd21 base`, one squash
  commit adding `hello.txt` and `docs/plans/2026-10-27-hello_plan_completed.md`; the queue branch
  was removed.
- Parent messages: exactly one handover notice (15:38:01, "2026-10-27-hello_plan.md failed its
  checks in all 1 verification round(s), so it was handed to the stronger worker James chose
  (claude / opus)…") and the run summary (15:41:03, "Landed 1, parked 0, skipped 0").

### LT-SU-3 — Off by default: PASS

First attempt (`35edd9c1-1d5c-4afc-a276-1e623e9611eb`, `/tmp/stepup-live-off`) never reached a
worker: triage could not find `plan_queue_report_triage` on Claude or Codex and the document parked
`triage-failed`. That is a separate, pre-existing defect, recorded as
[LT-722](livetest-remediation-register.md#lt-722); it is not caused by this feature.

Retry `6d7d014e-f1a6-4ad7-baf7-20a67811dcb5`, `/tmp/stepup-live-off2`, `max_rounds: 1`, workers
`claude / haiku`, no step-up (`stepUp: "stop and wait"`), gate `/tmp/stepup-gate-fail.sh` (always
exits 1):

- Triage reported ready. The only worker ran on `claude-haiku-5-5` (15:44:11–15:44:32 UTC); no
  Opus session exists for this repository.
- The checker failed round 1 on the gate; the item parked `round-limit`, round 1, detail "Still
  failing after 1 verification round(s): [critical, confidence 100] The required queue gate
  failed…", with no `handedToStepUpAt`.
- The parent received only the run summary (15:47:05, "Landed 0, parked 1"), no handover message.
  `main` is unchanged (`999ef13 base`); the branch `queue/2026-10-27-hello-767d2e` is kept.

### LT-SU-2 — Restart during the step-up worker's turn: OPEN

Not run yet. It needs James to quit and relaunch Harness while the Opus worker is busy, and the
hello plan gives Opus under a minute. Set-up for the next attempt is below.
Prepared 2026-10-27:

- Repository `/tmp/stepup-live-restart` (`b044b69 base`) with `docs/plans/2026-10-27-essays_plan.md`
  (five ~1,500-word essays, so each worker turn takes several minutes).
- Gate `/tmp/stepup-gate-restart.sh` fails until `/tmp/stepup-gate-restart.passed` exists.
- Automation "Step-up live test: restart during handover (LT-SU-2)" (switched off) starts the run with
  workers `claude / haiku`, step-up `claude / opus`, `max_rounds: 1`. Before enabling it, set
  auto-approve on and the parent model to Sonnet, as for the other runs.

Steps once James is at the keyboard: enable the automation; wait for the handover
(`handedToStepUpAt` set and an Opus "Queue · 2026-10-27-essays_plan" session busy); James quits
and relaunches Harness; confirm the item resumes with a new **Opus** worker (transcript model
`claude-opus-5-5`, first prompt "the app restarted"), no second handover message, the same
`handedToStepUpAt`; then create `/tmp/stepup-gate-restart.passed` and confirm it lands.


## Evidence run — 2026-11-14

Queue live-test worker. Dev app built from the step-up queue worktree (`npm run build:main`, renderer built with
`ng build --configuration development` and served by a small static server with a single-page fallback), data
`/tmp/aio-lt-queue-1f911387`, debugging port 9881, driven over CDP with focus emulation on. Provider turns were real
(Claude Sonnet parent, Haiku and Opus workers, Codex `gpt-5.6-terra` checker). The run was started from a Claude session in
the dev app calling `plan_queue_start` with `max_rounds: 1`, `verifier_gates: ["/tmp/stepup-gate-restart.sh"]`,
`post_merge_gate: []`, workers `claude / haiku`, `step_up: claude / opus`, checkers automatic. Scratch repository
`/tmp/stepup-live-restart` with one plan (`docs/plans/2026-10-27-essays_plan.md`, five essays of about 1,500 words). The gate
exits 1 until `/tmp/stepup-gate-restart.passed` exists.

Where it ran: first on the test Mac, then on this Mac. The test Mac copy cannot run Plan Queue at all, because it can use Claude
only and the queue refuses a checker from the same model family as the workers ("no installed provider other than claude is
available for verification (installed: claude)"). Its sessions also got no orchestrator tools until the `aio-mcp` helper was
made findable (LT-1118; I linked it into the shared Electron resources folder on the test Mac for a few minutes and put the
original, already dangling, link back afterwards). The test Mac copy was stopped before any run started. The run itself was
on this Mac because Codex is needed as the checker, which is the runbook's rule for a check that needs another tool.

### Defect found first: the hand-over never happened when Harness's own command check failed — LT-1120

Run `221f616e-c02d-4ceb-b20b-2c03d162b1d9`, build before the repair. The Haiku worker finished, the item went `verifying`, then
`parked` with `parkReason: round-limit`, detail "Checks still fail after 1 rounds: /tmp/stepup-gate-restart.sh",
`steppedUpAt: null`, no checker and no Opus session, although the run's routing showed `stepUp: claude / opus`. The earlier
2026-10-27 run (LT-SU-1) reached the hand-over only because its failure came through the independent checker; a failing
command check parks first (`PlanQueueVerification.prepareChecks`). Recorded as
[LT-1120](livetest-remediation-register.md#lt-1120) and repaired in this branch: `prepareChecks` now asks `canStepUp` at the
round limit and returns a `step-up` result, which `startQueueVerification` passes to the same hand-over the checker path uses
(`PlanQueueItemFlow.stepUp`). Regression test in `plan-queue-coordinator-routing.spec.ts` ("hands a document to the step-up
worker when Harness's own checks are still red at the round limit, without starting a checker"): fails with the repair taken
out, passes with it. A second case in `plan-queue-start-verification.spec.ts` covers the new result.

### LT-SU-2 — Restart during the step-up worker's turn: PASS (on the repaired build)

Run `ff3c3495-5f7f-4d2f-9c64-ef781dc809dd`. Times are UTC, 2026-11-14; item events are from the dev app's
`loop-mode.db` (`plan_queue_item_events`).

- 07:47:49 Haiku worker (`claude-haiku`, session `cbcqj16ha`) started; it ended 07:50:38. 07:50:39 the item entered
  `verifying`, the command check ran and failed, and at 07:50:40.117 the event `verifying → fixing "Handed to a stronger
  worker (claude / opus) after 1 failed check(s)."` was written. `plan_queue_status` data: `state: fixing`, `round: 0`,
  `steppedUpAt: 1794642640117`. The Haiku session was gone from the session list; a new Opus worker `cuvsqadm2`
  ("Queue · 2026-10-27-essays_plan", model `opus`, parent = the starting session) was `busy`; its first prompt began "You are
  resuming a Plan Queue item" and carried the step-up instruction.
- The starting session received exactly one handover notice (07:50): "Plan Queue: 2026-10-27-essays_plan.md failed its checks in
  all 1 verification round(s), so it was handed to the stronger worker James chose (claude / opus). That worker gets up to 1
  more round(s)…".
- 07:51:04 with the Opus worker `busy`, I quit the dev app (SIGTERM; it exited in about 2 seconds) and relaunched it on the same
  data folder at 07:51:10. Event `restart-resume` at 07:51:11 and a new session at 07:51:36: `ctff7oqh6`, model `opus` (not
  Haiku), `busy`. Its first prompt: "Your session was stopped and has now been reopened. Reason: the app restarted. Your earlier
  work is committed on your branch. Continue where you left off." followed by the verifier findings (the failed Harness gate).
  `steppedUpAt` was still `1794642640117`, and the event log holds exactly one hand-over transition.
- I created `/tmp/stepup-gate-restart.passed` at 07:51:49. The Opus worker finished at 07:52:04, the checks passed, the Codex
  checker (`gpt-5.6-terra`, 07:52:06 to 07:54:57) returned PASS, and the item `landed` at 07:54:59, round 1, landed commit
  `dcc2efa2b731a1a02768b69d9deafe3183350821`. `/tmp/stepup-live-restart` `main`: `dcc2efa Plan: 2026-10-27-essays_plan` over
  `e66c210 base`, adding `essay1.md` to `essay5.md` (1,563 to 1,765 words each) and the closed plan; the queue branch and
  worktree were removed. Run status `completed`.

Not directly observed: whether a second handover message reached the starting session after the restart. The starting session
was not reopened by the restarted dev app (it showed no session of its own in the list), so its inbox could not be read. What
supports it: the only code that sends the notice is the hand-over itself (`stepUpItem`), the event log has one hand-over, and
`plan-queue-coordinator-routing.spec.ts` ("starts the step-up worker after a restart that came between recording the handover
and starting it") asserts a single notice across a restart.

### LT-SU-1 and LT-SU-3

Not re-run. Their 2026-10-27 passes stand. The repair moved the existing checker-path hand-over into a shared method without
changing its behaviour, and the routing spec's checker-path cases (hand over once, park after a failed step-up round, park
without a step-up choice) still pass. Today's live run exercised the shared hand-over itself.

### Observations, not filed

- The Haiku worker's final message said `plan_queue_report_ready` "is not available in this session". The queue carried on from
  the end of its turn, so nothing was lost here, but a worker that cannot find its report tool is worth a separate look.

### Checks run (this worktree)

`npm run checks` (typecheck, typecheck:spec, lint, ts-max-loc, ui-hints, build:main, build:renderer): all passed on the Windows
PC, exit 0. `npm run test:quiet` full suite on the PC: 46,817 passed; two failures in `scripts/remote-checks/remote-run.linux.spec.ts`
("reports no slot…") while the PC was busy, and that file passes on its own (22 of 22). `plan-queue-coordinator-routing.spec.ts`
43 of 43; `plan-queue-start-verification.spec.ts` 2 of 2.

### Cleanup

Dev app (port 9881) and the static screens server stopped; the dev data folder, scratch repository, gate script and renderer
build on this Mac deleted. A few small files from the abandoned test Mac attempt remain under that machine's `/tmp` (scratch
repository and data folder, cleared when it restarts); `dev-app shell` can no longer reach them because that copy was stopped.
