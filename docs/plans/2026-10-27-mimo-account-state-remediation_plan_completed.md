# MiMo account state remediation plan

On main: code only (hand-merged 6 Nov 2026, commit `9bb035697`); the plan stays open for any unticked item below.

## Status

On main: yes (this landing commit)
Active, 2026-11-10 queue round (item 0b24c0). All code for LT-1008, LT-1009 and LT-1010
is on the base (`9bb035697`; LT-1012 repair `0389bf165`; Vitest 5 is in `package.json`).
This round changed no code. It re-ran on that base: 10 focused files (135 tests) pass,
`npm run checks` (typecheck, spec typecheck, lint, size, UI hints, both builds) passes, and
the IPC/alias/architecture generators leave no diff. Evidence: `_history.md` beside this plan.
Still open, not for the worker: unfiltered full suite and independent completion gate
(verifier); the live checks in the `_livetest.md` (paid continuation, Windows worker,
independent usage sessions, installed-app capture). The "evidence receipts" folder cited
below was left on the parked branch and is not in this checkout. Untracked; no rename.

## Current queue implementation — 2026-11-03

Active in the assigned `queue/2026-10-27-mimo-account-state-891161` checkout. Historical
checked items below describe the earlier parked multi-account branch, not this checkout:
source comparison confirms the LT-1008/LT-1009 fixes and their regressions are absent here.
They must be implemented here before verification. No separate spec is linked by this
remediation plan; the owning live-test acceptance criteria remain authoritative.

- [x] Implement and reproduce LT-1008 delayed native selection in this checkout.
- [x] Implement and verify LT-1009 durable in-place and respawn handoffs here.
- [x] Capture the ACP error envelope safely; document supplied versus unavailable HTTP fields.
- [x] Establish current LT-1011/LT-1012 toolchain status from source and focused execution.
- [x] Run focused tests and static/build gates; leave the full suite to the queue verifier.
- [x] Review the final changes, retain report/seal/command receipts and remove owned runtime.

Baseline (2026-11-03): five focused files pass (account chip, handoff, native finality,
provider-limit detection, raw-payload projection). This baseline does not cover the missing
delayed-selection or immediate-hibernation regressions. Current native-finality already
waits for the child final-write acknowledgement before advancing the watchdog's fake clock.

Implementation: restore per-option selection; update tracked account state and use the
existing lock-held identity write-through before publishing successful handoffs. Preserve
resume cursor for same-provider handoffs. Keep rejected switches and admission unchanged.
For LT-1010 use the supported ACP transport, preserve safely redacted supplied error fields
through `Error.cause` (already projected to the capture ledger), and explicitly distinguish
missing upstream HTTP data from data received. No inference from native storage.

This worker will not commit, run the full suite, rename this document, deploy/restart the
installed app, or alter the AIO-owned branch/worktree. Those queue-specific instructions
supersede older full-suite and completion-rename instructions below.

### As-built and current acceptance

- LT-1008: per-option selected bindings fix the native selected value after delayed loading.
  The added draft/session/continuation controls all failed before the repair, then passed.
  Hosts still pass the stamped account through the session header and composer. Existing
  confirmation, selection rollback and async-generation behaviour are retained.
- LT-1009: both live and respawn handoffs update tracked account state and call the existing
  lock-held identity write-through. Same-provider handoffs retain the native cursor and
  provider-session handle. The real continuity manager, disk persistence and lifecycle wake
  regression checks B, logical model, Low spawn effort and prior user/assistant history.
  Successful native selection/effort is separately exercised by scripted ACP handoff tests.
- Fresh review found a save-failure inconsistency: a completed native switch could reject
  before publication and reset the renderer to A. Both paths now publish actual B and show
  an explicit unsaved-change warning if either save fails, preserving ownership checks.
  Four forced-save failures reproduced the issue before repair and pass afterwards.
- LT-1010: errors retain a redacted supported ACP envelope in `Error.cause`; the existing
  Error projection, capture service and SQLite store preserve it. JSON-encoded structured
  data is decoded before shared secret redaction, with bounded nesting. A real OpenCode
  1.19.5 request returned -32603 / `Internal error: quota exhausted` with
  `{service: session, errorName: APIError}`. It supplied neither upstream HTTP status nor
  body. The supported transport decision is ACP capture with those fields explicitly
  unavailable, not reconstructed native-store data. Tests include the observed shape,
  absent data and redaction of actually supplied status/body/headers.
- LT-1011: exact formatter reproduction against installed Vitest 4 loses the original
  failure and leaves both test results pending. Vitest 5.1 reports that same deliberate
  failure and its passing control correctly. This uses the upstream repair
  [vitest-dev/vitest#10893](https://github.com/vitest-dev/vitest/pull/10893), without local
  parser patches or error suppression. The identity of the historical full-suite failure
  lost by the old formatter has not been recovered; the new reproducer establishes its
  executing formatter stack independently. A local install matches this branch's lockfile.
  The shared root install was not modified (its stale glob install failed the baseline).
- Vitest 5 requires the benchmark API migration: all 30 callbacks and measurement options
  are unchanged under TypeScript AST normalization. Existing two-minute measurement budgets
  fit within explicit outer benchmark-test timeouts. The benchmark smoke exercises one
  indexing and one search case in each existing project, and the JSON output remains at
  `benchmark-results.json` through the npm command. `clearMocks: false` preserves the prior
> Earlier journal sections moved to `2026-10-27-mimo-account-state-remediation_plan_history_15d2631a39f48b244bc8956321404b8c7bd39234670cf8dfe196d9a44015f160_completed.md`.
## Historical parked-branch record — 2026-10-27

Origin: [MiMo multi-account live checks](2026-10-10-mimo-multi-account_livetest.md#evidence-run--2026-10-27).
Register: [LT-1008](livetest-remediation-register.md#lt-1008) and [LT-1009](livetest-remediation-register.md#lt-1009).

- [x] Reproduce on the actual dev renderer with focus emulation: both header and composer
  label Test B while their native select values are `legacy` after delayed account loading.
- [x] Add a delayed-list regression that asserts the actual selected option on a non-first account.
- [x] Repair account-select binding using per-option selected bindings; preserve
  draft/session/continuation behaviour, confirmation, and async generation guards.
- [ ] Run focused tests, canonical gates and the independent completion gate.
- [x] Re-run the originating live chip check and record dated DOM evidence. Paid next-turn
  completion remains open because both accounts return quota exhausted.

Implementation scope: bind each option's selected state after delayed loading; persist successful
in-place and respawn account handoffs using the existing continuity update/write-through path.
Risks: draft automatic choice, continuation choice, rejected-switch rollback, native resume cursor.
Checks: existing focused baselines, added regressions after real runtime confirmation, live
switch/hibernate/wake, all canonical gates. External quota/sign-in checks remain explicitly open.
The observed exhaustion-message fixture is a separate acceptance item in the owning live test.


## LT-1009 implementation status

- [x] Reproduce real A → B in-place switch, immediate hibernate and wake without a model turn:
  before and sleeping stamp B; ready after wake stamp A; all IPC actions report success.
- [x] Add a real lifecycle/continuity regression for immediate post-switch hibernation.
- [x] Persist successful account-only handoffs through existing continuity writes, including
  in-place and respawn paths, without weakening admission or rollback.
- [ ] Verify actual executing account, logical model, effort and history on wake; run canonical
  gates, independent completion review and the originating live checks.

As-built: in-place success writes the account snapshot under the existing lock before notices;
respawn success updates the tracked provider/account state. Account-only writes preserve the
native cursor and provider-session handle. Real no-turn wake now keeps B and Low; actual
lifecycle regression also keeps prior user/assistant history. Paid continuation is quota-limited.
Independent source/focused review found no actionable MiMo code defects, but returned FAIL
overall because the unfiltered full suite has two isolated-only-passing timing assertions
and an unhandled parser error (LT-1011). The overall campaign also has external prerequisites.

## Verifier follow-up

- [x] Repair LT-1008 and LT-1009; rerun actual account selection and wake controls.
- [x] Revisit every partial check and record precise external or human prerequisites.
- [x] Give the check 8 capture limitation a registered owner and acceptance criteria.
- [x] Replace branch-only dangling evidence links with branch-owned observation receipts,
  preserving the queue's root-only source-document rule.
- [x] Use a lockfile-exact local dependency install; investigate the source-map failure.
- [ ] Run focused/full verification, request fresh independent review, stop owned processes,
  remove disposable runtime, retain only evidence and receipts, and keep documents open.

## LT-1010 implementation status and owner

Status: open, provider adapter/event-capture remediation owns the supported transport and
retention decision. The root livetest and branch register both retain its acceptance criteria.

- [x] Assign missing upstream HTTP status/body capture, with current ledger/native provenance.
- [x] Trace ACP Error construction, Error projection and turn-error capture allowlist.
- [x] Capture the received ACP envelope without credentials and establish actual structured fields.
- [x] Preserve safely redacted supplied fields, or choose a supported upstream transport and
  explicitly report unavailable fields; do not invent native-store data as captured payloads.
- [ ] Re-run exact ledger-field acceptance, canonical gates and independent review before closure.

## LT-1011 implementation status and owner

Status: open, test-toolchain remediation. Direct parser reproduction identifies two locked
tsx bundles; the exact generating stack in the full suite remains unknown. A local exact
install fixes dependency compatibility but still reports the parser error. No dependencies,
runner settings, assertions or suppressions were changed to hide it.

- [x] Reproduce with the same installed convert-source-map parser and retain bundle hashes.
- [x] Re-run the complete suite and retain its actual exit 1 and raw error.
- [x] Isolate the two unchanged timeout-test failures: all eight tests pass alone, no edits.
- [x] Find the generating stack/test and implement a supported toolchain repair (current
  isolated formatter reproducer; the historical lost test identity remains unrecovered).
- [ ] Obtain an unfiltered full-suite pass and fresh independent gate PASS.

This remaining gate and the campaign's external quota/sign-in/allowance prerequisites prevent
closure. The plan stays active and untracked; no `_completed` rename is appropriate.


## LT-1012 implementation status and owner (2026-10-27, verifier round 2)

Status: open, native-finality test/runtime investigation. The prior full-suite missing-marker
failures now have a separate register entry. A fresh isolated run also fails at the same
assertion, in `partial-unpaused`; the previous isolated pass does not establish overload.

- [x] Retain the prior full-suite failure and isolated pass as Git-visible text receipts.
- [x] Rerun the isolated test without source edits; retain its new missing-marker failure.
- [x] Register observed behaviour, unconfirmed cause, owner and acceptance as LT-1012.
- [x] Diagnose child startup, timeout, final write, observer delivery and close ordering
  (inherited 2026-10-29 repair; current focused controls pass).
- [x] Repair the demonstrated cause without weakening terminal accounting/timeout assertions
  (already in the assigned baseline; no finality edits by this worker).
- [ ] Obtain an unfiltered full-suite pass and independent completion-gate PASS.

## Round-2 evidence retention and scope

The original check-1 Settings observations are copied byte-for-byte into the item worktree;
no source document or active plan was copied. Ignored historical command logs have `.txt`
receipts, mapped by hash in the new retention manifest. Prior seals are preserved as history.
The branch still has only 1 of 8 live checks passing. Paid success, worker sign-ins, independent
usage sessions and LT-1010 remain open. No subscription/release/credential-transfer authority
is inferred from the readiness answer. The worker will not close or rename either document.

Final documented-cache-disabled targeted recheck: all five MiMo files pass; native-finality
fails the missing marker and the native-error-versus-timeout assertion. LT-1012 retains both.
Main typecheck/build and new live focus-emulated Settings repeat pass. No new production,
test or dependency changes were made. Overall campaign/verification remains open.

Fresh independent review completed: FAIL overall because seven acceptance checks and
LT-1011/LT-1012 remain open, with no actionable MiMo code findings. Its one command-output
pointer warning was corrected and independently rechecked; no remaining actionable receipt
finding from that check. Owned profile/build/helper runtime is removed. This plan remains
active/untracked; neither document is closed or renamed by the worker.

> Plan Queue parked work: `queue/2026-10-27-mimo-account-state-891161` — 7 commit(s), reason: land-blocked.
