# Codex native goal following — LT-683 recurrence

Status: ready for independent queue verification. Implementation, focused/static/build checks, compiled probes, real-provider runtime recheck and fresh preliminary review PASS are recorded for 2026-10-31. Full-suite/clean-state acceptance and deferred desktop observations remain open. No worker rename or commit.

Owner/evidence: [compaction reliability live test](2026-09-27-codex-compaction-reliability_livetest.md#evidence-run--2026-10-27-plan-queue-isolated-dev-runtime).
Register: [LT-683](livetest-remediation-register.md#lt-683--a-codex-goal-turn-that-starts-within-milliseconds-of-the-previous-one-is-not-followed).

The previous completed remediation plans are historical and are not edited. This plan records the
current implementation status required by the campaign runbook; it does not claim a fix.

- [x] Reproduce using real Codex 0.164.0: a joined goal-turn reply is retained, but four subsequent
  goal replies are missing and the app remains idle while Codex works.
- [x] Retain transcript, rollout, lifecycle, command receipts and source hashes outside the disposable runtime.
- [x] Investigate why the pending-follow replay recaptures the completed initial turn after the joined
  provider turn finishes. The stale turn id is logged; the enqueue origin has not been instrumented.
- [x] Fix the executing path and add a regression covering a Harness-originated initial turn, provider
  continuations, accepted mid-turn user input and later native turns. Preserve real completion semantics.
- [ ] Run focused and full canonical verification, then repeat the live scenario and verify all replies,
  status and pending-send completion. Obtain an independent completion-gate PASS before closure.

No James-only step is identified. Verifier feedback authorized implementation; source fixes and current live checks are recorded below. Full-suite and independent acceptance remain gates before closure.

## Round 2 implementation approach

The connection observer precedes the per-turn subscriber. While a Harness turn is starting, its id is unknown to the runtime; recording that notification as pending recaptures the completed initial turn after the first provider turn. Ignore notifications owned by the current capture, and drain a genuinely different pending turn after either capture origin releases its slot. Preserve busy when a successful send ends with another native turn active. Verify real goal continuations, joined sends, stop over two minutes, busy compaction refusal, native compaction, and legacy settings on the rebuilt dev runtime. Then add regression coverage and run the canonical gates. Keep the root livetest document and worktree changes separate as required; supply a landing manifest and hashes for the coordinator.

## Additional reproduced defect: LT-708

The high-context campaign exposed a separate main-loop stall: a 400,219-character message blocked retrieval for 153,712 ms before provider dispatch (2026-10-27 03:07:36.807–03:10:11.016 UTC). Recorded as LT-708 in the worktree register with observed behavior, source hypothesis, required behavior and acceptance. No retrieval fix is included in the goal-following change; short fixture-read prompts provide a separate path to the required native-compaction check. This remains a technical follow-up, not a human-only action.


## As-built notes — verifier round 2, 2026-10-27

The connection observer precedes the capture subscriber. Own turn/started notifications were saved
as future provider turns when the runtime id was null or equal, then replayed after a provider capture.
The fix rejects both cases, drains a different pending turn after Harness capture as well as provider
capture, and keeps successful sends busy when native work remains. Three regressions prove the old
code fails and the fix passes, alongside 168 focused adapter/runtime tests.

Real runtime evidence is in root `.aio-review/lt-c8434b3e-round2/` and the owner document. The original
accepted-join sequence retains later replies; Stop prevents any restart for 142.403 seconds and a later
normal send succeeds. Two complete fourteen-turn goals and one seven-turn goal retain all 32 native
continuations and all assistant/tool output, including two provider-managed compactions. Settings and
busy manual-compaction refusal were repeated on this build. The compaction provider selected ~74%
fill, and two non-executable convergence-review decisions were logged; those exact differences from
the original document are preserved for verification, not silently treated as literal passes.

All canonical gates except the still-running unsharded full suite have passed. The worktree owner
copy remains untouched; the coordinator reads the root document and includes its closed content with
the branch in one landing commit. No document is renamed by this worker.


## Parked-item resume — 2026-10-27

The source and regression hashes match round 2, and rebuilding produces byte-identical changed
JavaScript. Raw evidence consistency was rerun successfully. The resumed checkout's provided install
has unrelated extra dependencies and no compiled assets; it was preserved inside the worktree,
an exact offline locked install succeeded, native binaries were reused only at identical versions,
and focused Codex/worker/dependency tests passed. Canonical gates and final suite are recorded in
the owner document and resume command receipts. No source or manifest changes in this resume.

Additional defect LT-715 is open: the first isolated-profile startup failed at the RLM journal-mode
pragma with `database is locked` (04:21:01.574 UTC). One same-profile restart reached the renderer
and read-only IPC. Exact lock ownership remains unproven; no database or source repair was made.
The worktree register carries observed behavior, candidate cause, required behavior and acceptance.
This status replaces any instruction to append new work to the historical completed remediation plan.

Check 2 remains qualified against its original literal assertions; no human-only fact or authority
is missing, and the worker does not rename either document. Independent queue acceptance is still
required before closure.


## Fresh review counterexample — 2026-10-27 04:28 UTC

LT-683 is reopened. The original joined-goal scenario passes, but the fresh independent reviewer
found a complete-turn batching gap. A separate compiled production transport/runtime probe confirms
that a single chunk containing two complete native turns loses the second reply/completion and
leaves capture busy; splitting the same frames after cleanup works. Full raw evidence and control
are in root `.aio-review/lt-c8434b3e-resume/`. This is controlled runtime evidence, not a claimed
new provider-backed live run. No production fix or test change in this resume.

- [x] Preserve pending-turn events through capture handoff, including output and completion in the
  same chunk, multiple short continuations and both capture origins. Verify ordering, usage and teardown.
- [x] Add meaningful regressions only after the executing fix is verified; do not weaken old tests.
- [ ] Repeat the relevant real-provider checks, full suite and fresh independent gate after remediation.
- [x] Resolve Check 2's threshold and advisory-action qualifications in the executing runtime; the historical renderer-label mismatch and remaining displayed-app observations are explicitly recorded below and in the follow-up livetest. This does not authorize closure.

Fresh gate: FAIL, one actionable code finding. Its shell test command was denied by sandbox setup;
the worker separately passed focused/static gates and reproduced the finding in unchanged compiled
code with the actual transport parser/hub. No full-suite success is claimed. This worker stops at
the requested evidence handoff with Check 1 failed, Check 2 qualified, Checks 3–6 passing. No James-
only action is identified, and neither active document is renamed or committed.


## Verifier findings remediation — 2026-10-27

The resumed worker reproduced the batched-transport defect with both capture origins and multiple
queued turns. The as-built change buffers full notification sequences, replays one turn at a time
through the runtime subscriber, and drains Harness handoffs after response publication. Regressions
also verify tool results, exact usage and status order. The compiled transport parser/hub probe
passes for batched and separated streams, both origins. Inline convergence-review decisions are
suppressed before logging/publication, preserving other policy safety actions.

Static gates and both production builds pass; full suite, real-provider recheck and independent
gate remain in progress. The original Check 2 threshold wording is unchanged pending an explicit
acceptance decision. Current evidence: root `.aio-review/lt-c8434b3e-fix/`. No rename or commit.


## Current live and fixture evidence — 2026-10-27

The complete batched-turn queue and inline advisory-log fixes are implemented and runtime verified.
Current real-provider evidence covers two fourteen-turn goals, accepted joined input, 122.011 seconds
without restart after Stop, later ordinary send, busy manual-compaction refusal and settings save.
An additional isolated native-tuning run actually passes 90%: compaction rows 93%→13% and 96%→13%,
meter refresh 635/1989 ms, zero non-none policy decisions. All 46 native turns and tool results appear
in IPC and DOM; the native rollout genuinely repeats step 19 once, and exact order/multiplicity are
preserved. The richer existing renderer label is recorded without changing acceptance wording.
The earlier threshold qualification is superseded by this actual run, not an inferred amendment.

Two cold full suites failed the unchanged Claude real-child fixture under host load. Readiness is
now explicit before dispatch, keeping the 150 ms product watchdog, 25 ms final write and every old
assertion; an exactly-once spawn assertion was added. Focused checks, spec typecheck and lint pass.
The third uncached, unsharded full suite is running; no full-suite PASS is claimed yet.

LT-715 recurred on first-profile startup at 05:35:20.558 UTC. A same-profile restart completed live
checks, but exact lock ownership remains unproven; no RLM code repair is included. LT-708 and LT-715
remain separate open defects. Owned Electron and renderer processes are stopped; final receipts,
independent preliminary review and runtime removal remain to be recorded. This plan and the owner
livetest remain active and uncommitted for coordinator verification. Neither is renamed by this worker.


## Fresh review follow-up — 2026-10-27 06:03 UTC

The first fresh review returns CHANGES_REQUIRED: notification capture can finish before response
publication, allowing reversed replies and merged usage during asynchronous reconciliation. A real
compiled parser/hub probe reproduces both origins. Extend adapter ownership through publication,
delay and replay connection-level notification effects with their turn, and wait/rejoin queued native
work after a predecessor finishes. Both-origin regressions prove the old code fails and ordering,
usage, compaction row and joined-send behavior pass after the fix. The two-column LT-683 status row
is also corrected. New verification and a genuinely fresh review remain necessary.

The third full suite is nonzero with two pending SEA tests hidden by the source-map formatter bug.
Diagnostic logging exposes wrong worker Node selection (Homebrew 26 lacks the SEA fuse); restored
runner bytes and pinned .nvmrc Node 24.22.1 pass both SEA cases unchanged. Full rerun will use that
runtime. No package/lockfile/config change or error suppression is included.


## Worker verification handoff — 2026-10-27 06:40 UTC

Implementation and all agent-runnable gates pass on the final unchanged source. The pinned Node
24.22.1 cold unsharded suite exits 0 (35,378 passing tests; existing skips retained), both builds,
both typechecks, lint, file-size and UI-hint checks pass. The independent fresh preliminary review
returns NO_ACTIONABLE_FINDINGS and independently verifies extra publication/retry/compaction,
trailing-usage and termination interleavings. It is not a clean-state Gate 0 certificate.

The final rebuilt dev app repeats all six checks. The 45-turn goal retains exactly 45 native/IPC/
completion replies, 44 follows and 45 tools; native compactions at 93%/96% refresh the meter after
422/1126 ms and log zero non-none policy decisions. Stop holds for 122.005 seconds; later send and
joined input pass, with join resolution 11 ms after completion. Busy refusal and legacy settings
save pass. Existing before/after compaction wording remains explicitly recorded versus the old
quoted label. The earlier monitor failure is retained separately; its corrective retry exits 0.

All nine created goals are complete or paused; all instances/automations are empty; owned app,
renderer and goal-cleanup helper are stopped. Receipt/archive preservation precedes runtime removal;
cleanup evidence will be appended after deletion. LT-708 and LT-715 remain open outside this fix.
This plan stays active/untracked. Coordinator clean-state verification, acceptance and closure are
still pending; no worker commit or filename rename is made.


## Runtime removed — 2026-10-27 06:55 UTC

Owned profile/databases, dependency install/Electron, compiled assets, fixtures/review runtime,
raw scratch output and 212 attributable tsx cache entries are removed. The provided dependency
directory is restored by rename; app/renderer PIDs are absent, ports closed, all owned native goals
complete/paused. Compressed redacted command output, report and seals remain in the root evidence
directory. Cleanup exits 0 after a bounded recovery from Finder metadata creation; earlier failures
remain recorded. No commit, branch action or filename rename. Coordinator acceptance remains pending.

## Assigned-checkout implementation — 2026-10-31

The supplied checkout did not contain the source changes described in the historical notes above.
Its clean starting HEAD was `fa835dc38`. The retained patch was compared to the current executing
path and restored selectively; newer native-ownership and input-admission guards were preserved.
No separate linked specification exists: the owner livetest's six checks and this remediation plan
are the acceptance sources. The root owner document was read as evidence and is not edited here.

A new standalone probe through the real production socket chunk parser, notification hub, adapter
and runtime reproduced loss of complete batched turns for both capture origins. Blocking rollout
reconciliation also reproduced reversed replies and merged usage. The repaired executing path
retains complete notification streams, follows one native turn at a time, owns output/usage through
publication, drains Harness handoffs after publication, rejoins queued native work, and keeps the
outer send busy when another native turn remains. The compiled runtime probe now retains all
three replies with exact separate usage. Regression tests were added after this runtime check;
no existing assertion was weakened. Inline convergence-review advisory suppression is restored
before logging/publication, while retaining state updates and other executable policy decisions.

The first genuinely fresh scoped review found an additional valid-protocol child-usage race:
with a reused owned child, two 18-token root-plus-child turns were published as 24 and 12 tokens.
The queue now records notification identity and the previous runtime subscriber defers those
events. Replay releases each notification before applying its connection and capture effects.
Explicit preceding-root events remain live, preserving the existing overlapping-start regression.
The reviewer's compiled parser probe now gives 18 and 18 for both origins, matching its separated
control. Both-origin regressions cover reused children and accepted legacy untagged usage.

Ruling: the requested full suite and clean-state independent completion gate belong to the queue
verifier, because the current worker assignment explicitly says not to run the full suite or
commit. The grouped closure checkboxes therefore stay open until coordinator acceptance. This
worker's fresh reviews are preliminary diff reviews, not Gate 0 certificates. No active document
will be renamed or staged by this worker.

Evidence and command receipts: root `.aio-review/2026-10-31-goal-following/`. Final live results,
fresh-review disposition, source seal and runtime-cleanup evidence will be appended below after
they are observed. Earlier failed receipts remain failures, including the first read-only native
sandbox run (`sandbox_apply: Operation not permitted`); no application permission decision is
inferred from that runtime error.

## Final worker handoff — 2026-10-31

The second fresh review found a further valid-protocol status race: an accepted joined send could
emit idle while the next native turn's publication was blocked and a third native turn was queued.
The app-server layer now asks `hasPendingProviderWork` as well as checking active capture when
settling status, presenting compaction, refusing manual compaction and exposing public active state.
It excludes Harness-only publication from that hook so input-cap recovery can still compact safely.
Both-origin production-parser probes and new regressions retain busy and refuse `thread/compact/start`
in this exact state. The earlier narrow current-provider capture test still governs steering.

All worker gates pass: `npm run typecheck` (root and Electron programs), `typecheck:spec`, lint,
file-size and UI-hint checks, main and renderer production builds, alias/IPC generators, 14 focused
files / 295 tests, and the unchanged formatter/system-event tests. The renderer build reports its
initial-bundle budget warning. No dependency, lockfile, compiler/test-runner configuration or
renderer source change is included. The full suite was deliberately not run under this assignment.

A third genuinely fresh context used `task-completion-gate` and returned **VERDICT: PASS**, scoped
to the uncommitted diff, with no unresolved actionable findings. It independently passed 214
focused tests and compiled supported publication/join/usage/status/manual-compaction probes.
Report: root `.aio-review/2026-10-31-goal-following/review-status/report.md`. This is explicitly
not the coordinator's clean-state Gate 0 certificate. The two earlier FAIL reports remain retained.
One proposed late-predecessor-usage ordering was rejected after the reviewer traced upstream's
sequential terminal-event path; its diagnostic is retained as a qualified limitation, not a pass.

Real Codex **0.166.0**, GPT-5.6 Sol / low, on the final functional compiled code retained exactly
45 native final replies and 45 command results in order, byte-for-byte, with 45 completion events.
Joined input resolved 3 ms after its native completion. Manual compaction while busy returned false.
Native compaction crossed 92.56% and produced one self-managed boundary with zero non-none policy
decisions; actual context usage dropped to 9.51% before the completion notification, then 8.42%
1,129 ms after the boundary output. Stop produced a paused goal and no native restart across the
122-second watch; the later ordinary send returned `AFTER_STOP_OK`. Raw events, exact tool/reply
reconciliation, final paused-goal receipt and command exit 0 are retained in the evidence directory.

The first live profile's read-only sandbox failed; its goal was blocked and its process was stopped.
All four owned native PIDs are independently confirmed absent in `process-cleanup.json`. The live
script's asynchronous termination tail did not emit its intended final PID line, so that independent
process check supplies cleanup evidence rather than inferring it from the script's exit 0. No
normal provider configuration, stored authentication or running Harness desktop was changed.

Ruling on Check 2 wording: the current formatter at
`src/renderer/app/features/instance-detail/message-format.service.ts:155-160` intentionally shows
before/after percentages when both are known and `(was N%)` when only the prior reading exists.
Follow that established code instead of regressing the UI to the historical quoted string. The
actual past-90% and zero-action conditions are now observed, not inferred or waived. Desktop DOM,
header/control observations and Memory settings open/save are unverified on this rebuilt source;
they are explicitly deferred to
[the follow-up livetest](2026-10-27-codex-goal-following-remediation_livetest.md), with prerequisites,
exact steps, expected results and the browser/desktop boundary. Both active root documents remain
untracked. The linked owner livetest remains unchanged.

Worker checklist: implementation and regression items pass; focused/static/build/generator gates
pass; real-provider runtime checks pass; fresh preliminary review passes. Coordinator full-suite
and clean-state acceptance, plus the four deferred displayed-application checks, remain open.
Evidence preservation and runtime cleanup are recorded by the report/seals/receipts; no plan rename,
staging, commit, branch change or worktree operation is made by this worker.

Cleanup confirmed at 2026-10-31 08:42 UTC: both disposable native homes/databases and fixtures,
compiled output and 240 attributable tsx cache entries are removed. Provided dependencies remain
in place for the verifier. All ten source/test hashes still match the independent PASS review;
22 archived raw test artifacts pass hash verification. The final cleanup readback exits 0; the
earlier Finder-metadata race and post-removal receipt-key assertion remain recorded as failed
attempts. Report, source/document seals, native event receipts and compressed test evidence remain
in root `.aio-review/2026-10-31-goal-following/`. Nothing is renamed, staged or committed.
