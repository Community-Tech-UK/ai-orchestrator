# Usage-limit account switching implementation plan

Status: implemented and verified on 2026-10-16, with the installed-app observation deferred to the [live-check document](2026-10-16-usage-limit-account-switch_livetest.md). No commit, branch, worktree, deployment or live settings changes were made.

## Goal and confirmed cause

Honour an acknowledged automatic account pool when Claude usage telemetry stops a session, while preserving the prohibition on paid overage.

Production logs at 2026-10-16 13:25:33 London time show the usage-overage interrupt followed immediately by a park. Automatic pool mode and ownership acknowledgement were enabled, both bindings were authenticated, automatic quota resume was enabled, and paid overage was disabled. The production `maybeParkOnUsageLimit` path bypassed the account coordinator, so the normal error-path switch never ran. This establishes the bypass; it does not establish the sibling account's exact quota at the incident time.

## Completed tasks

- [x] Reproduce rejected weekly telemetry through the production guard and handler with a configured switch candidate; retain before/after runtime evidence.
- [x] Add optional credit policy to account failover, covering cached and fresh candidate selection while preserving existing caller defaults.
- [x] Connect the usage stop to the configured switch policy before parking, with one continuation, duplicate protection and an unconditional safe fallback.
- [x] Verify runtime event handling and add regression coverage for successful switching, policy modes, missing candidates, failures, cancellation, recovery and later user turns.
- [x] Pass focused tests and every canonical project gate: main/spec typechecks, lint, line limits, both builds and the full quiet test suite.
- [x] Obtain an independent fresh-context task-completion-gate PASS with no unresolved actionable findings. Record the external installed-app check separately.

## As built

The usage guard still interrupts first. The handler durably records the exhausted account, then consults the existing acknowledged pool policy. A successful handoff sends one internal Harness continuation that preserves prior work and accurately announces the account change. It does not replay the original user request or claim the old account's quota reset.

Safety-driven selection disallows known paid-only siblings in both cached planning and fresh quota selection. That restriction persists through durable safety-limit records, normal error/pre-send re-entry and early recovery. Purchased credits cannot clear a safety hold. Existing non-safety callers keep their credit-selection defaults.

A pending-switch token suppresses duplicate source-account signals while allowing the changed account's continuation through normal dispatch. New user input during a pending handoff receives an explicit unsent/resend notice. Releasing an instance aborts active coordinator operations, with checks after asynchronous boundaries and immediately before continuation, including synchronous notification callbacks. Late results cannot add a stale park or trigger cancellation fallback sends.

Off/ask/no-eligible/failed switching still holds safely, including when automatic reset-resume is off or the workspace is missing. Early sibling recovery removes the old banner while preserving the source ledger. Different new user input resets the per-turn allowance while keeping cooldown and same-turn caps.

Quota resolution was extracted into `instance-usage-limit-stop.ts` to keep the handler within its enforced line ceiling. An unrelated intentionally invalid persisted-version test fixture needed a typing-only correction in `session-continuity-state.spec.ts` (`as unknown as SessionState`); its existing rejection assertion and surrounding user changes were preserved. No dependencies, schema, settings or UI templates changed in this task.

## Verification evidence

Evidence directory: `_scratch/usage-failover/` (ignored local investigation output).

- Runtime reproduction: `reproduce.ts` failed before the fix (interrupted then parked; zero switches), and passed after it (interrupted then switched; exactly one handoff, no park). The independent reviewer reran this successfully.
- Focused final implementation checks: 9 files / 207 tests passed, `_scratch/test-run.pid-80125.log`. The fixture and unrelated OpenCode rechecks also passed without task changes to those implementations.
- `npx tsc --noEmit`: exit 0, `typecheck-main.log`.
- `npm run typecheck:spec`: exit 0, `typecheck-spec.log`.
- `npm run lint`: exit 0, `lint.log`.
- `npm run check:ts-max-loc`: exit 0, `line-limits.log`.
- `npm run build:main`: exit 0, `build-main.log`.
- `npm run build:renderer`: exit 0, `build-renderer.log`; existing initial bundle-budget warning remains.
- Unfiltered `npm run test:quiet`: exit 0, 2,589 files / 32,941 tests passed, 7 existing skipped tests, zero failures. Summary: `current-full-gate.log`; raw: `_scratch/test-run.usage-failover-current.log`; structured: `_scratch/test-results.usage-failover-current.json`. No watched source/package fingerprints changed during this settled run.
- Independent fresh-context completion gate: **VERDICT: PASS**, no unresolved actionable findings. Report: `completion-gate-1.md`. Independently reran 211 uncached tests, both typechecks, lint, runtime smoke and added-line secret scan. Independently inspected the raw canonical full-suite/build results and verified all 15 source/package fingerprints. A clean dependency reinstall and another full-suite run were intentionally avoided in the shared dirty checkout; these verification limits are explicit in the report.
- Earlier cancelled/mixed-version full runs are retained as investigation evidence only and are not used to claim completion. Unrelated edits elsewhere in the shared checkout were preserved.

The genuinely external installed-app validation is recorded in the [pending live check](2026-10-16-usage-limit-account-switch_livetest.md). No real provider quota was deliberately exhausted, no paid request made, and James's active app was not restarted.
