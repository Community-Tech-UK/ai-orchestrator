# Agent runtime review remediation

Status: active; verifier round-two repair in progress. Focused and full verification are being rerun after two timeout-only full-suite failures. Claude bounded-verdict latency remains unresolved. No completion rename is authorised.

Current checkout evidence: [2026-11-03 verifier repair report, command receipts and source seal](2026-10-27-agent-runtime-review-remediation_evidence/2026-11-03/verifier-repair/worker-report.md). [Earlier restoration-only report](2026-10-27-agent-runtime-review-remediation_evidence/2026-11-03/worker-report.md). Historical native-provider evidence: [2026-10-31 worker report](2026-10-27-agent-runtime-review-remediation_evidence/2026-10-31/worker-report.md). The current update supersedes earlier checkout-specific implementation claims; the plan stays untracked and is not renamed.

Source: [LT-710](livetest-remediation-register.md#lt-710) and
[AR-006 evidence](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-27-verifier-follow-up).

## LT-710 implementation status — 2026-10-27

- [x] Reproduce one non-overlapping real headless review with an explicit 120-second budget.
- [x] Trace the actual runner deadline through the startup-wired host to generic cancellation.
- [x] Retain content-free provider activity proving no verdict before timeout; withdraw the
  earlier unsubstantiated provider-outage classification. Excessive review work remains undiagnosed.
- [x] Implement explicit deadline versus caller-cancel diagnostics, with a focused failing regression
  before production edits. Implemented and verified in this checkout on 2026-10-31; the earlier no-edit statement was historical.
- [x] Investigate the bounded no-op checker's delay without removing read-only, turn or spend caps.
  Bounded current experiments are recorded below; no latency fix or provider-outage cause is claimed.
- [x] Obtain a real clean reviewer verdict and rerun AR-006 cache reuse and both invalidations.
  Current owning-gate evidence is recorded below, including a rejected real regression.
- [x] Run focused tests, both typechecks, lint, length/hint checks, both builds and generator/export checks.
- [x] Run the current full canonical suite after native setup; actual terminal exit 0 is in the verifier repair receipts.
- [x] Obtain qualified fresh independent review of current source/runtime evidence with no actionable finding.
- [ ] Queue coordinator: own the next queue review, harvest/integration and closure; no worker commit or completed rename.

The old remediation plan is completed and cannot receive new scope. This new active follow-up
owns implementation status, stays untracked, and records an open product failure, not a fix.

## Follow-up implementation plan — 2026-10-27 round 3

Keep the existing reviewer deadline, read-only tools, turn and spend caps. Give the headless
runner an explicit TimeoutError reason and preserve that reason through the startup-wired host;
ordinary caller cancellation must still say Review cancelled and stop the owned adapter.
Risk: cancellation/usage settlement changes; cover the actual host and runner plus existing
paid-partial-usage tests. Run existing suites first, reproduce with executing code, validate in
the rebuilt live app, then add regressions without changing passing expectations.

Run AR-006 with the owning non-terminal gate and real provider results; never inject a clean
verdict or cache flag. Preserve AR-004/005 boundaries; do not rename the owning livetest.


## As-built update — 2026-10-27, resumed checkpoint

The parked checkpoint contains the deadline diagnostic and focused regressions. The internal timer
now carries TimeoutError; the real review host preserves deadline text while caller cancellation
still reports Review cancelled. Existing paid-partial-usage and teardown regressions pass in the
current focused run. The earlier no-implementation statement above is historical.

At 04:17:34.701 UTC the owning non-terminal gate ran the actual default reviewer on a real paused
Codex loop iteration, using the unchanged 90-second budget. It failed at 04:19:05.215 UTC with
`claude: Review timed out after 90 seconds`, required correctness coverage failed, and no clean
cache/anchor. This verifies the new diagnostic but leaves LT-710's bounded-verdict problem open.
No provider outage, successful review, instant ALLOW or invalidation pass is inferred.

- [x] Explicit deadline/caller-cancel diagnostics implemented, focused regressions pass, and real
  runtime deadline text is verified.
- [x] Investigate why the bounded no-op reviewer produces no verdict. Current bounded observations and unsuccessful hypotheses are recorded in the 2026-10-31 update; the underlying Claude latency remains unresolved.
- [x] Obtain a real clean verdict, then run unchanged reuse and both external-edit/pause-resume
  invalidations. The historical prerequisite failure is superseded by the accepted 2026-10-31 owning-gate run.
- [ ] Independent completion gate and final closure remain with the queue coordinator.

This plan stays active and untracked. Canonical command results live in the owning report.

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


## Final verification update — 2026-10-27

Canonical gates now all exit0. The successful full no-cache suite used the existing pinned Node24.22.1
and reports35,381 passed, nine existing skips and zero failures/unreported assertions. The old
Homebrew run's two masked SEA assertions are diagnosed, preserved as failed evidence and executed
normally by the successful run. No test/configuration/source change was made to obtain that pass.
Current recovery and AR-006 runtime assertions have direct receipts; actual rule writing remains
outside wording acceptance. Permission implementation closure remains with the coordinator's
independent gate; Claude-delay investigation remains open, with the invalid first tiny-fixture
sample explicitly qualified in the owning report. This plan stays active/untracked and is not renamed.

## As-built worker update — 2026-10-31

The supplied queue checkout did not contain the diagnostic implementation described by the older
checkpoint. Its baseline focused suites passed; new focused regressions then failed on the generic
cancellation text before production edits. The runner now aborts its existing timer with an Error
named TimeoutError carrying the configured duration. The startup-installed host class preserves
that reason before dispatch and in flight, while ordinary caller cancellation remains Review cancelled.
Existing adapter teardown and delayed paid-usage settlement remain intact and are regression-tested.

Current real Claude review attempts prove `claude: Review timed out after 90 seconds` and failed
required coverage without a clean cache. A simpler real no-op request returned a clean verdict in
about 33 seconds. Avoiding unrelated bookkeeping through an experimental system overlay and using
medium reasoning both failed to resolve the fuller request's delay; neither experiment is retained
in production. Observed native deliberation and repository inspection do not establish the upstream
cause. This is an implemented diagnostic fix and a completed bounded investigation, not a latency fix.

Accepted cache evidence is `loop-probe-current-final.json` in the current evidence directory:
real Claude Haiku builder turns, a real Codex correctness reviewer, the unchanged default owning
fresh-eyes gate and 90-second reviewer budget. It obtained a clean anchored verdict at 05:47:53 UTC,
instant unchanged reuse with zero dispatches, a real external-edit review, then cleared the anchor
on normal resume and waited for the resumed builder iteration to settle before obtaining another
real review at 05:50:34 UTC. A subsequent deliberately recursive disposable implementation was
rejected with a high-severity finding and cleared the clean flag. No verdict, cache flag, source
digest or provider event was substituted.

This is a headless production-coordinator integration run, using native builder I/O and actual
progress forwarding in a disposable fixture. It is not a claim to have restarted or driven the
desktop app, or to have repeated the permission/focus campaigns. Earlier fixture errors, missing
activity forwarding and failed/partial attempts remain in the report and are excluded from acceptance.
The fixture uses the existing separate execution-directory option; no branch, commit or worktree
was created. Builder permissions match the ordinary loop builder; reviewer policy is unchanged.

All worker gates pass in current command receipts, including 220 focused tests. Generators leave
their committed output unchanged. The full suite and fresh independent task-completion-gate review
are reserved for the coordinator. No independent PASS or document closure is claimed by this worker.
The report and seal retain source/compiled hashes before cleanup; cleanup.json records removal of
the owned runtime and PID checks. Dependencies remain in the supplied checkout for verification.

Reference mismatch: the current root remediation register has no LT-710 anchor. Requirements here
were taken from this supplied plan and the directly read residuals report; no stale register was
copied into the worktree. AR-004/005 authority boundaries and the owning residuals document are unchanged.

> Plan Queue parked work: `queue/2026-10-27-agent-runtime-revie-5e9400` — 3 commit(s), reason: land-blocked.

## As-built worker update — 2026-11-03

The new supplied queue checkout again lacked the diagnostic fix. Read and restored the five-file
implementation from the retained patch, preserving this checkout's current model-name expectations.
The existing focused suites passed before edits. The new regressions then produced nine expected
assertion failures before production edits, and passed afterward. The timer now sends the configured
duration as TimeoutError; the startup-wired host preserves it without changing caller cancellation,
adapter teardown, late paid-usage accounting, reviewer authority or any runtime cap.

Current verification passes: both typechecks, lint, length/hint checks, both builds, generated
aliases/channels, IPC/export checks and ten focused files containing 281 passing tests. Generators
left their tracked output unchanged. The renderer build retains its initial bundle-size warning;
no build budget or test expectation was relaxed. Receipts record actual command exits.

The changed production files are byte-identical to the previous sealed implementation. The earlier
native JSON receipts were directly read and checked against their original hashes. Their deadline,
clean verdict, cache reuse, both invalidations and rejected recursive-code observations remain
historical evidence dated 2026-10-31, not a new native-provider or desktop campaign. No new paid
campaign or settings change was needed to restore an already investigated, identical implementation.
Claude latency remains unresolved, with no new cause or fix claimed. The missing LT-710 register
link was reconfirmed; no stale register or owning residuals document was changed.

Author diff review found no actionable issue; this is not an independent PASS. The report, source
seal and receipts are retained under the current evidence link. Owned compilation output is removed
after sealing; dependencies remain in the supplied checkout. All worker-owned items are implemented
and checked. The full suite, independent task-completion-gate review, commit and final document
closure remain with the coordinator. This plan remains active, untracked and at its original name.


## As-built verifier round-one repair — 2026-11-03

The verifier's three failed assertions were reproduced unchanged. The two concrete Claude accounting
IDs are now shared constants, with identical values, pricing and picker membership. The dependency
failure came from the linked root installation: this branch locks glob 14.0.3, while the root still
has 13.0.6 and lacks this branch's nested minimatch. A real lockfile install was made only inside
the supplied worktree. The root install, manifests, lockfile and all test expectations are unchanged.
The formerly failing guard and compatibility tests now pass; both typechecks, lint, length/hint checks
and both builds pass. The no-cache full suite is running, with its actual terminal exit still pending.

The original real-provider campaign was rerun against this checkout's current source. At 06:58:36 UTC
the owning gate accepted a real clean verdict, then reused it with zero dispatches. An external edit
caused a new review. Normal resume cleared the anchor, the resumed native builder settled, and a new
review passed at 07:01:01 UTC. At 07:02:01 UTC a deliberately recursive disposable helper was blocked
with a high finding and the clean flag cleared. The command exited 0, all six adapters stopped, no
active loop remained, and captured child PIDs were absent. This supersedes the earlier historical-only
limitation for clean/cache acceptance. It remains a headless coordinator fixture, not a desktop or
permission/focus campaign. Claude's review latency remains unresolved.

The first new campaign attempt failed before reviewer dispatch because its command loaded only the
CommonJS TypeScript hook. That failed receipt is retained; using the complete TypeScript loader
resolved the probe invocation error without production changes. Current repair report and receipts:
[verifier repair evidence](2026-10-27-agent-runtime-review-remediation_evidence/2026-11-03/verifier-repair/worker-report.md).
The plan remains active and untracked, without commit, branch change or completed rename.


Native installation follow-up: the script-free install also needed the project's native SQLite
preparation. The first full run was stopped after that missing binding was reproduced; its real
exit 130 is retained as interrupted failed evidence. `npm run rebuild:native`, the same affected
database suites, native compatibility and the automated headless archive/native smoke check all
now pass unchanged. A fresh uncached full run is active with pinned Node 24.22.1. No test, timeout,
manifest, lockfile, global setting or additional production file was changed for this correction.


## Final verifier-repair result — 2026-11-03

The replacement uncached full suite exited 0 under pinned Node 24.22.1: 36,340 passing tests,
nine existing skips, zero failures/todo/unreported assertions, and all 2,858 file results passed.
All canonical and focused checks pass, including the unchanged model guard and dependency assertions.
A qualified fresh independent task-completion-gate review returned PASS with no actionable finding.
It independently ran focused/native checks and inspected current full/build receipts, without
claiming a clean committed snapshot or a second full rerun. The user requires uncommitted repairs.

Current native clean review, reuse, both invalidations and real recursive-code rejection now have
fresh receipts from this checkout. Failed attempts remain excluded. The linked current repair
report contains exact exits/counts, independent verdict, source seal and cleanup evidence. This
supersedes the pending-full-run progress notes above. Claude latency remains open; no desktop
permission/focus campaign was repeated. The plan stays active and untracked, without branch change,
commit or completed rename. Queue lifecycle and closure remain with the coordinator.


## As-built merge-conflict resolution — 2026-11-03

Resolved and staged both coordinator-reported conflicts. Both parents require shared constants
for the concrete Claude accounting IDs; retained the incoming parent's dedicated
`CLAUDE_PRICING_MODELS` group and removed the redundant worker-added pinned declarations.
Both resolved files exactly match the incoming merge parent, preserving values, rates, picker
membership and the model-literal guard. The five-file review deadline/cancellation change remains
intact against that parent; no test expectation or dependency file changed.

Current targeted checks pass: provider/model guards, attribution/callers, review timeout/cancellation
and usage settlement, plus model-pricing/dependency compatibility. Both typechecks, lint, length/hint
checks, generators, IPC/export checks and both builds pass. Generated tracked output is unchanged;
the renderer retains its existing bundle-size warning. No unresolved index entries remain.
The incoming browser-login proof has pre-existing trailing whitespace; the resolved files' check
passes and the unrelated proof is preserved.

[Current merge-resolution report, seal and receipts](2026-10-27-agent-runtime-review-remediation_evidence/2026-11-03/merge-resolution/worker-report.md).
This continuation performed author review, not a fresh independent PASS. Full suite and independent
verification remain with the coordinator, as requested; prior native-provider observations are not
relabelled as post-merge checks. No new latency fix or desktop/browser validation is claimed.
The merge remains active for the coordinator. No commit, abort, branch/worktree change or completed
rename was made. The root plan stays active and untracked. Owned build/cache output is removed after
sealing; worktree dependencies remain for verification.


## As-built verifier round-two repair — 2026-11-03

The independent verifier's two nonzero full-suite runs remain failed evidence. Their
load-related diagnosis is attributed to the verifier, not treated as an established
cause. This continuation reruns the unchanged affected suites and the complete
canonical gates using the existing two-worker environment setting, pinned Node
24.22.1, unchanged timeouts and assertions, and separate local logs. Results are
pending and will be recorded in the round-two repair report.

The supplied plan was absent from the queue checkout, so this small active copy
was restored from the coordinator's original document. It stays untracked here.
The timeout diagnostic is the implemented behaviour. Claude's bounded-verdict
latency is still unresolved; successful Codex review/cache checks do not resolve
that failure. Coordinator closure remains unchecked. This plan must not be renamed
completed or represented as a latency fix. No production, test, dependency or
configuration change has been made in this continuation.
