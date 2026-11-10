# MiMo stale-session warning retention

On main: code only (hand-merged 5 Nov 2026, commit `03d8c1ea9`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Resumed 2026-11-10. The retention fix (`provider-quota-service.ts`, `retainLastKnownQuotaWindows`), the three adjacent service specs and the LT-782 register entry are already on this branch (hand-merged to main in `03d8c1ea9`). Re-ran this round: 77 targeted tests, typecheck and lint, all exit 0. Done: every code item. Open: queue verifier's full suite and closure; fresh real-app SSO checks are deferred in [the livetest](2026-10-27-mimo-stale-session-warning_livetest.md). Earlier completion statements below are historical, not evidence for this branch. Round evidence: [history](2026-10-27-mimo-stale-session-warning_plan_history_f02fd96c7953e9df06d6cd730e6b04ab04c5ae3e04661ead6e4c32cc6c9bcff1_completed.md).

Owner: [session resilience live test](2026-09-25-mimo-session-resilience_livetest.md), Check 2. Defect: LT-782.

## Scope and cause

A real MiMo 401 with failed SSO sets needsReauth on retained bars. A second Refresh during the 30-minute renewal cooldown returns a transient failure without a new authentication verdict. retainLastKnownQuotaWindows currently interprets its absent verdict as false, clearing the warning without a successful quota read.

## Current queue execution — 2026-11-03

The queued branch starts with the defective `incoming.needsReauth ?? false`
implementation, lacks LT-782 in the tracked remediation register, and lacks the
claimed regressions. The historical work/evidence was not present on this branch.
There is no separate linked spec; the Work and Risks sections below are the
acceptance criteria. The owning live-test report is context, not a separate spec.

Ruling: restore the smallest retention fix and cover it through the public service
refresh path. An omitted authentication verdict preserves the previous verdict
and instruction; explicit true uses the incoming instruction, and explicit false
clears the warning and instruction. Existing
early-return paths replace successful/nonempty/configuration-excluded snapshots.
No provider, renderer, credential, schema, IPC, or generated interface change is
required. Main risks are retaining a warning after recovery or leaking it between
accounts; focused service lifecycle and source-replacement tests cover both.

The queue-worker instruction overrides the historical request for a full suite
and independent completion gate here: the worker runs targeted tests and static
gates, and the queue's separate verifier runs the full suite and completion gate.
No completion verdict, commit, integration, or filename closure is claimed here.

- [x] Read current implementation, callers, types and adjacent tests; baseline
  service/source tests passed (exit 0, 2026-11-03).
- [x] Reproduce the current defect through the real service runtime.
- [x] Implement and verify retention/replacement behavior before adding tests.
- [x] Add and run regressions without weakening existing tests.
- [x] Register LT-782 in the tracked worktree register.
- [x] Run worker gates, retain command receipts/report/seal, clean owned runtime.
- [ ] Queue verifier: full suite, independent review and document closure.

### As built and verification — 2026-11-03

`provider-quota-service.ts` now resolves a missing incoming authentication verdict
from the existing cached verdict and preserves its original instruction. No
other production file changed. A new adjacent service spec covers provider and
secondary-account lifecycles, repeated refresh, thrown errors, successful fresh
readings, explicit true/false replacement, healthy caches, authoritative empty
snapshots, cross-account isolation and source invalidation. Existing tests were
unchanged. No interface/generator input changed, so no generated source update
was necessary.

Before changing production code, a standalone assertion through the actual
`refreshProviderFamily` → `refresh` → `storeSnapshot` → retention/event path failed
with `false !== true` on the repeated failure. The same runtime assertions passed
after the change, preserving bars, instruction, timestamp and pushed snapshots,
and clearing on explicit false and fresh success. This used synthetic probe
snapshots, not fabricated HTTP responses or renderer state. It is service-runtime
proof, not a live MiMo/visual claim. Ruling: use that verified runtime behaviour
before adding regressions; the stricter real-app-before-regressions ordering in
the historical Work section could not be met without a readable live credential.
Fresh real-app acceptance remains open rather than preventing regression coverage.

Baseline service/source tests passed. After implementation, the seven focused
service, source, MiMo probe/renewer/persistence and IPC suites passed (exit 0).
`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
`npm run build:renderer` and `git diff --check` all exited 0. The renderer build
reported an advisory initial-bundle size warning; there was no renderer source
change. The full suite was not run, as explicitly required by the queue-worker
instructions. A fresh independent reviewer found no actionable code findings
and independently reran the service/retention tests successfully. This is a
scoped code-review PASS, not a full completion-gate PASS.

Two headless Electron attempts with a disposable encrypted saved-login copy
stopped before HTTP. The retry diagnostic failed at `safeStorage.decryptString`,
before JSON parsing; no plaintext or cookie value was exported. The original
saved login's ciphertext remained unchanged. This does not diagnose the real
account or remote service as broken. Browser Gateway reported `windows-pc`
healthy with a deliverable extension channel; no local browser was used.

The remaining live checks, exact actions, expected observations, runtime flags,
credential prerequisite and cleanup steps are transferred to
[the active follow-up live test](2026-10-27-mimo-stale-session-warning_livetest.md).
The old owning report's October receipts were not present here; its claims are
retained as attributed historical context, not re-certified. The obsolete
> Earlier journal sections moved to `2026-10-27-mimo-stale-session-warning_plan_history_f02fd96c7953e9df06d6cd730e6b04ab04c5ae3e04661ead6e4c32cc6c9bcff1_completed.md`.
## Work

- Record the reproduced defect in the remediation register. Keep this new implementation status here rather than adding requirements to the closed 2026-07-19 plan.
- Retain the existing authentication warning and instruction when a windowless failure supplies no new authentication verdict. A successful snapshot, explicit false verdict, configuration exclusion or source invalidation still replaces it.
- Rebuild and repeat rejection, repeat Refresh and real saved-SSO renewal in the isolated dev app before adding regressions. No real Chrome cookie edits, logout, fabricated HTTP responses or rendered-state injection. Reset the disposable renewer between failed-SSO and successful-SSO cases solely to avoid its 30-minute attempt cooldown.
- Add service regressions for persistence, fresh-read clearing, explicit false clearing and account isolation. Preserve existing tests.
- Run all canonical gates, obtain a fresh independent completion review, record evidence and clean up runtime.

## Risks and checks

The shared service serves every provider: retaining an old warning too long is the main risk. Cover successful replacement, explicit false, ordinary failures on a healthy cache, account separation and source invalidation. No renderer wording or persistence schema changes.

## As-built notes — 2026-10-27

> Earlier journal sections moved to `2026-10-27-mimo-stale-session-warning_plan_history_f02fd96c7953e9df06d6cd730e6b04ab04c5ae3e04661ead6e4c32cc6c9bcff1_completed.md`.
## Verifier correction — 2026-10-27

The MiMo defect is now LT-782. LT-708 was already reserved for a separate benchmark
issue; both checkout plan directories were scanned to confirm LT-782 was unallocated.
A later fresh scan found a separate LT-790 reservation without any LT-782 conflict. The owning report, register and test titles use
LT-782 consistently, and Markdown targets are repository-relative.

The original Check 3 receipt did not exclude the old valid console session from its
retry. A fresh built-app run removed it from every renewal-phase quota request:
only the three authentication pairs actually returned by SSO were allowed through.
The service token differed from the original; the old service token was never sent
in that phase. The real APIs returned 401 without authentication, then 200 with the
SSO-returned pairs. Negative controls retaining only account identity returned 401;
a real Refresh rereading the persisted renewed login returned 200 again. The real
saved-login ciphertext stayed unchanged. This resolves the original-session
ambiguity while preserving the disclosed limit: controlled outgoing-cookie exclusion
was tested, not natural expiry or sign-out.

Evidence and exact timestamps are in the owning report's “verifier findings,
SSO-only retry” section and its relative review-fixes evidence directory. All earlier
receipts remain historical; a new seal covers this corrected report/plan/register.
Final verification and cleanup are recorded in the owning report. No production
code or test assertion changed during this correction; only the defect labels in
three existing test titles changed.


Final branch-exact verification on 2026-10-27 independently passed all canonical
gates, both production builds and the complete default suite: exit 0, no failed
tests and nine existing pending tests. The deliberately interrupted serial run
remains recorded as exit 143 and is not counted as a passing run. No skip, timeout,
assertion or manifest changed. Final review and cleanup evidence are linked from
the owning live-test report; coordinator closure remains required, with this
active filename and untracked status preserved.


Final handoff 2026-10-27T05:11:50.429295+00:00: both fresh independent passes returned VERDICT: PASS.
Owned runtime, temporary dependencies/binary, builds and private caches were
deleted; the pre-existing dependency directory was restored intact. The owning
report, current evidence seal and cleanup receipt record the actual final state.
This plan remains untracked and retains its active filename for coordinator closure.

> Plan Queue parked work: `queue/2026-10-27-mimo-stale-session-d56868` — 3 commit(s), reason: land-blocked.
