# Plan Queue checkout preparation timeout

## Status

On main: no (timeout repair itself landed at bca871e72; the original queue batch remains open).
The timeout repair has historical source and runtime verification. The original ten-item batch is 3 of 10
accepted; Phase 1 has a later accepted checkpoint and awaits coordinator integration/verification under its own
current plan. Its owning coordinator retains control. No parent-batch acceptance follows from the narrow repair.
Next: follow each original item's current Status and AIO ownership; do not resume stranded work before Phase A's
installed guard prerequisites are proven. Preserve unrelated root changes and never restart Harness here.
Historical evidence, including the former status and all dated continuations, is preserved verbatim in
[history](2026-10-18-plan-queue-checkout-timeout_history.md). The latest batch handoff is the final section there.



## Observed failure

At the original failure, all ten Queue items parked before implementation during `git worktree add`, at round zero. The original Phase 0 retry also parked during the existing-branch checkout. `gitExec` defaults to 30 seconds, and both WorktreeManager creation and PlanQueueWorktreeService reattachment previously used that default. Existing Queue ownership and cleanup remain authoritative. Historical native snapshot `status-awaiting-handoff.json` does not establish why the six previously paused items subsequently attempted preparation. The later installed-runtime continuation is recorded at the end of this plan.

## Change and risks

Give worktree checkout operations a separate bounded, longer timeout, shared by new worktree creation and Queue reattachment. Keep ordinary Git commands at their current timeout. Preserve argument arrays, the Git write queue, ownership persistence, failure cleanup and no-loss guards. A genuinely stuck checkout will take longer to report failure, so the deadline must remain finite. Prove the executing callers use the new deadline and retain meaningful timeout/error-path coverage.

## Work

- [x] Read complete affected implementation, callers, types and tests; trace the executing deadline and record the limits of historical failure evidence. The stored error projection omits termination signal, so the precise historical cause remains unproven; the 30-second checkout deadline is verified.
- [x] Implement the smallest timeout repair and verify the actual production helper/call paths with a disposable automated runtime fixture before updating regression tests.
- [x] Add focused regression coverage for both creation and reattachment, preserving normal command deadlines and failure behavior.
- [x] Resolve the repeatedly reproduced retirement-control verification blocker with deterministic synchronization after runtime proof; preserve all behavioral assertions and existing test deadlines.
- [x] Reproduce the session-test cleanup race with actual filesystem writes before editing, then await the existing queue drain in test teardown without changing production semantics, assertions or deadlines.
- [x] Run current-source focused checks, both TypeScript checks, lint, LOC, both builds and the full quiet suite, preserving full logs and exit receipts.
- [x] Obtain a fresh independent task-completion-gate PASS; fix all actionable findings and repeat with a fresh reviewer.
- [x] Prepare the verified update and running-app continuation steps. Respect the recorded shared-app restart deferral; do not ask again or interrupt the app.
- [ ] Resume the original ten-plan batch through supported Queue controls when the repaired runtime is available. Never count registration or a parked item as implementation completion.


> Evidence: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Installed-runtime continuation — 18 October 2026: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Native landing notice and next independent item — 18 October 2026: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Follow-up corrections and current verification window — 18 October 2026: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Serialized continuation preparation — 18 October 2026: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Further acceptance corrections — 18 October 2026: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Final consensus dispatch-boundary review: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Corrected Phase0 accepted; serialized continuation resumes: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Large-status current caller correction: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Current large-status correction accepted; next original item ready: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Original Phase1 resumed after accepted correction: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Phase1 worker handoff and automatic synchronization conflicts: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Continuation after interruption, 19October: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Native verification and hook repair, 19October: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Coherent remediation handoff,19October01:46UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Capacity retry and continued acceptance work: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Continuing repair and broader review,19October02:23UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Requirement review and native repair progress,19October02:45UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Paused audit handoff and supported continuation, 19 October 03:13 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Final source comparison and native checking, 19 October 03:25 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Native FAIL returned to worker, 19 October 03:27 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Fixed checkpoint and serialized final verification, 19 October 03:48 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Normal verification passed; fresh completion gate started, 19 October 04:08 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Fresh completion gate FAIL; lifecycle repair required, 19 October 04:13 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Supported lifecycle repair continuation, 19 October 04:16 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Exclusive paused-checkout repair ownership, 19 October 04:20 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Lifecycle repair checkpoint and current normal verification, 19 October 04:36 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Lifecycle-repaired normal PASS; new whole-item fresh gate, 19 October 04:54 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Fresh UI finding and repair ownership, 19 October 05:03 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Coherent UI and helper-limit correction, 19 October 05:11 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Keyboard repair verified; backend execution transfer, 19 October 05:16 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Additional existing-scope source findings batched before full verification, 19 October 05:26 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Coherent preflight adds truthful statistics and async paste ownership, 19 October 05:33 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Paste proof, truthful thread counts and remaining preflight, 19 October 05:48 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Account-switch custody and replacement owners, 19 October 05:52 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Post-switch review and delivery evidence boundaries, 19 October 06:00 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Current scoped evidence and remaining report boundaries, 19 October 06:21 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Durable notice, report populations and final typing preflight, 19 October 06:42 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Coherent corrective checkpoint and normal verification, 19 October 07:04 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Final corrective normal PASS and new whole-item gate, 19 October 07:21 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> New independent failure and coherent acceptance corrections, 19 October: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Successful-receipt repairs and new normal gate, 19 October 08:05 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> New corrective normal PASS and genuinely fresh review, 19 October 08:27 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Fresh read-only audit failure and scoped repair, 19 October 08:43 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Audit-readonly and early-guardrail repairs, 19 October 09:39 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Corrective normal PASS, fresh shortened-population failure and repair handoff, 19 October 10:16 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Shortened-population and compaction-receipt repairs, 19 October 11:04 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Compaction renderer boundary and interrupted normal run, 19 October 11:24 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Boundary repairs, full-suite fixture failure and next normal, 19 October 12:04 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Normal verification passed; new independent cancellation finding, 19 October 12:42 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Owner repair, test correction and current whole review, 19 October 15:09 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Checked-thread baseline finding and correction in progress, 19 October 15:30 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Baseline correction checkpointed; full normal running, 19 October 15:56 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Unchanged packaging failure investigated; observed full attempt running, 19 October 16:25 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Pre-closure scratch-collector correction, 19 October 16:33 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> LocalAB saved-billing custody correction, 19 October 16:35 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Observed normal passed; genuinely new whole verifier owns runtime, 19 October 16:48 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> New whole-source rejection: concrete live-model verification, 19 October 17:10 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Model runtime correction proven; extraction source leads separated, 19 October 17:20 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Extraction failures reproduced and corrected before regression tests, 19 October 17:25 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Combined current normal full running, 19 October 17:32 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> First-message guidance source lead held for reproduction, 19 October 17:52 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Current four-path normal passed; initial guidance delivery defect reproduced, 19 October 18:01 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Guidance retry paths reproduced with corrected first-person fixture, 19 October 18:10 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Narrow first-message delivery repair authorized after provenance controls, 19 October 18:19 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Initial guidance production correction passed the frozen reproductions, 19 October 18:30 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Supported source and metadata checkpoints ready for final normal verification, 19 October 18:38 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Final guidance normal PASS and genuinely new whole review, 19 October 19:05 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Fresh whole review rejected three acceptance gaps; narrow repair reopened, 19 October: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Three acceptance repairs passed focused verification and supported checkpoint, 19 October 19:43 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> New three-repair normal PASS; genuinely new whole acceptance dispatched, 19 October 20:15 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Unknown-cost correction checkpointed; current full verification running, 19 October 20:50 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Unknown-cost normal run passed; fresh whole review next, 19 October 21:15 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Phase 1 fresh whole gate failed; repair checkpointed; second fresh gate next, 19 October 23:50 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
> Phase 1 status, 20 October 06:35 UTC: evidence moved to `2026-10-18-plan-queue-checkout-timeout_history.md`.
