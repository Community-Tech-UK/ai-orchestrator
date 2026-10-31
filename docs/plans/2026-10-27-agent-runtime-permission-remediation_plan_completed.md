# Agent runtime permission remediation

Status: implementation ready for queue verification, 2026-10-31. Current local gates pass;
authenticated rebuilt-app acceptance is deferred below. Independent review/full-suite closure
belongs to the coordinator. Created 2026-10-27 by the residual live-test worker.

Source: [LT-708](livetest-remediation-register.md#lt-708) and the dated
[AR-006 evidence](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-27-plan-queue-worker).

## Permission remediation implementation status — updated 2026-10-31

- [x] Reproduce on the rebuilt isolated dev app and retain redacted cold/warm comparison evidence.
- [x] Trace the missing warm-adapter hook and unrecognised genuine CLI denial to executing code.
- [x] Implement the smallest correction with failing regressions first. The current worker
  reproduced both defects in this checkout, then added the two production corrections.
- [x] Verify local cold/warm spawn selection, approval-event parsing, rejection/explicit-deny
  protection, rendered wording and decision/hook behavior; run both typechecks, lint,
  length/hint checks, generators, IPC verification and both production builds.
- [ ] Full suite and independent completion review: reserved for the queue verifier by the
  current worker instructions. No full suite was run by this implementation worker.
- [ ] Repeat the owning AR-006 permission checks against a rebuilt app: see the
  [pending live campaign](2026-10-27-agent-runtime-permission-remediation_livetest.md).
  Do not retire the legacy request clause merely because this defect prevents it appearing.

This active follow-up owns the new implementation status. The campaign runbook names the old
`2026-07-19-livetest-failure-remediation_plan_completed.md`, but that record is closed and the
current lifecycle instructions prohibit adding new scope to a completed plan. The register already
uses active follow-ups for later defects; this follows that convention. Keep this file untracked.


## As-built update — 2026-10-27, resumed checkpoint

The parked checkpoint `256c090b3` contains the implementation and added regressions: exact anchored
approval-required denial recognition, and fresh-spawn refusal of a warm Claude adapter when the
create needs its launch-scoped permission hook. The earlier “not implemented” text above is historical.
No production/test edit was made by this resumed worker.

Current isolated runtime evidence is in the owning AR-006 report's 04:14 UTC section. Cold and
warm-available non-YOLO creates both selected fresh configured adapters and showed genuine deferred
approvals. Both were rejected and settled idle. A separately scoped unhooked fixture produced a
genuine actionable legacy denial, displayed the current global-rule/restart consequence, and was
rejected. No Always approval or global Claude rule write was performed. The initial bare-mode
legacy fixture was invalid because it lacked authentication; its result is not a capability claim.

- [x] Implementation and focused new/existing regressions are present and currently passing.
- [x] Cold/warm-available configured paths, genuine unhooked denial, current UI wording and rejection
  were exercised against a rebuilt isolated app.
- Coverage limit, not a new acceptance item: live authored-deny/actual approval persistence
  was not claimed by that run. The scope clarification below excludes global Always writes.
- [ ] Independent completion gate and final closure remain with the queue coordinator.

This plan stays active and untracked. See the owning report for final canonical command receipts.

Canonical verification follow-up: builds, both typechecks, lint, length/hint checks and focused
regressions passed. Full suite exited1 on the supplied installation's twelve extraneous production
dependencies; the same dependency assertion failed alone. No install, package files, test expectations
or marker were changed. The owning report and receipts retain this open gate; no completion is claimed.


## As-built update — 2026-10-27 verifier repair

The owning report's verifier-repair section supersedes prior runtime and installation blockers where
it provides new proof. No production or test edit in this continuation. Current focus, deferred/
legacy permission wording and normal UI rejection have receipts; no Always approval was submitted.
The reverse authenticated pair (Claude builder/Codex reviewer) produced a real clean verdict,
instant unchanged reuse and both real invalidation reviews. The accepted final pause/resume gate
waited for the resumed builder to settle. Claude's own bounded review delay remains LT-710 open;
the accurate timeout diagnostic is not a fix for that delay.

The twelve unreferenced packages were quarantined locally, without package/test changes. The
formerly failing dependency suite now passes. Full canonical receipts and independent review are
recorded in the owning report. Keep this plan active/untracked; the coordinator owns closure.


Scope clarification from the current AR-006 contract: an actual global Always allow-rule write is
neither required nor authorized for the wording check. Its earlier unchecked live-persistence line
is a coverage limit, not a new completion requirement. Existing authored-deny/error-output
regressions remain intact; this run submitted no Always approval and no user-authored deny override.


## Final verification update — 2026-10-27

Canonical gates now all exit0. The successful full no-cache suite used the existing pinned Node24.22.1
and reports35,381 passed, nine existing skips and zero failures/unreported assertions. The old
Homebrew run's two masked SEA assertions are diagnosed, preserved as failed evidence and executed
normally by the successful run. No test/configuration/source change was made to obtain that pass.
Current recovery and AR-006 runtime assertions have direct receipts; actual rule writing remains
outside wording acceptance. Permission implementation closure remains with the coordinator's
independent gate; Claude-delay investigation remains open, with the invalid first tiny-fixture
sample explicitly qualified in the owning report. This plan stays active/untracked and is not renamed.

## Current queue worker as-built — 2026-10-31

This section supersedes historical implementation/verification claims for the current checkout.
The supplied queue base did not contain either described permission fix: the spawn preflight
could still consume an unhooked warm Claude adapter and the denial matcher returned false for
`This command requires approval`. No linked spec is named by this plan; the owning AR-006
permission contract is the acceptance source. Its old retained evidence directory was absent,
so this worker does not certify those historical receipts.

Ruling: implement the two missing corrections directly in this AIO-owned checkout, preserving
the existing policy gate, UI contract and user rules. The LT-708 number collides with the
separate benchmark record in the current register; this work is identified by this plan and
the AR-006 permission report and does not overwrite the other record.

As built:

- `InstanceSpawnPreflightChain.prepare` requires a fresh Claude adapter when the create has
  a permission hook. The lifecycle already passes that hook before preflight, while the warm
  manager's adapter is launched without it; the correction preserves the launch-time config.
- `isPermissionDenialContent` recognises only the whole approval-required sentence (optional
  final period, surrounding whitespace and case variation). Exit-code, prefixed, extended and
  multiline command output remains non-actionable. The real adapter still requires a
  non-YOLO error result before emitting `permission_denial`.
- Added regressions for both defects plus a stream integration spec exercising the actual
  NDJSON parser, original Bash context, deferred approval path, YOLO and successful/error
  result distinctions. No tests, expectations or guards were weakened.

Current evidence: baseline passed; the new regressions failed on both defects; both production
corrections made them pass. The expanded focused run and real hook subprocess tests pass.
Both TypeScript checks, lint, length/hint checks, alias/IPC generators, IPC verification,
main/preload build and production renderer build exit 0. A smoke check executes the compiled
denial classifier successfully. The renderer build emits a non-fatal initial bundle-size warning.
Generators produced no tracked changes. The worker's own final diff/call-path review found no
remaining actionable implementation issue; it is not an independent gate verdict.

Report, command receipts, logs and source/build seal:
[current worker evidence](2026-10-27-agent-runtime-permission-remediation_evidence/2026-10-31-queue-worker/report.md).
Remaining provider/window acceptance is exclusively in the pending live campaign above;
component tests and synthetic protocol inputs are not called genuine live-provider proof.
No global Always approval or settings write was submitted. No full suite or independent PASS
is claimed. The coordinator owns review, commits, document renaming and integration.
