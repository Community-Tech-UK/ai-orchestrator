# Doc-review submit/wake reconciliation implementation plan — completed

**Status:** Completed — 2026-07-15. All agent-runnable implementation and verification checks pass. Electron-only validation remains in [`2026-07-13-doc-review-delivery-reconciliation-plan_livetest.md`](2026-07-13-doc-review-delivery-reconciliation-plan_livetest.md).

**Goal:** Verify the superseded submit/wake draft against the canonical delivery-reconciliation implementation, then close only proven functional or test-coverage gaps without duplicating the landed architecture.

**Architecture:** Preserve `DocReviewService` as the durable decision/journal owner and `DocReviewDeliveryCoordinator` as the lifecycle-aware router. Preserve the portable capture server's exit notification as the standalone wake signal. Any fixes must remain at those existing boundaries and must keep durable capture/decision persistence ahead of delivery side effects.

## Constraints

- Treat `docs/plans/2026-07-13-doc-review-submit-wake-plan.md` as historical; it explicitly says not to execute it separately.
- Use `docs/plans/2026-07-13-doc-review-delivery-reconciliation-plan_completed.md` as the canonical in-app design.
- Preserve unrelated dirty-tree work and do not commit or push.
- Use failing regression tests before production changes.
- Do not defer anything that can be verified through Vitest, TypeScript, lint, or the dev runtime.

## Tasks

- [x] Read the canonical plan, portable capture implementation and skill, doc-review service/store/contracts/UI, delivery coordinator, application wiring, loop gate, continuity revival seam, settings policy, and their relevant tests.
- [x] Run the focused doc-review, lifecycle-revival, loop-routing, contracts, settings, and renderer tests to establish the current baseline.
- [x] Build an acceptance matrix mapping every non-superseded requirement to code and a test; record verified gaps here before editing production code.
- [x] For each verified gap, add a failing behavioral test, confirm the expected failure, implement the smallest complete fix, and rerun the focused suite.
- [x] Update the portable skill documentation, canonical source documentation, and live-test checklist only where the verified runtime differs.
- [x] Run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and `npm run test:quiet`.
- [x] Review the final diff for unrelated changes, test suppression, stale imports, and requirement coverage.
- [x] Record as-built evidence, rename this file with `_completed`, and leave the Electron-only live check in the existing `_livetest.md` document if it still genuinely requires a rebuilt app.

## Current-state findings

- The portable and in-app `serve-review.mjs` copies are byte-identical and implement durable write, canonical stdout output, an optional shell-free capture hook, response flush, default exit, and `--stay-alive`.
- `DocReviewService.submitDecision()` persists the verdict and a `dispatching` journal entry before invoking delivery, then appends the terminal/queued result.
- `DocReviewDeliveryCoordinator` routes idle, busy, globally paused, hibernated, terminated/missing, successor-instance, and loop-owned submissions through existing lifecycle APIs.
- `InstanceManager.reviveFromContinuity()` delegates restoration to the lifecycle-owned continuity helper and refuses revival while globally paused.
- The default-on `docReviewResumeOnSubmit` setting is operator-only in the safe-settings control policy.
- Focused tests and a line-by-line acceptance matrix are still required before deciding whether production edits are necessary.

## Acceptance matrix

| Requirement | Runtime evidence | Automated evidence | Result |
| --- | --- | --- | --- |
| Durable standalone capture precedes wake/exit | `serve-review.mjs` awaits `writeFile()` before stdout, hook, response, or shutdown | `serve-review.spec.ts` checks the file, canonical block, 200 response, and exit 0 | Covered |
| Default exit wakes the launcher; `--stay-alive` preserves iterative serving | `closeAfterCapture()` closes after the response callback unless opted out | Two focused server specs | Covered |
| Hook receives the decisions path without shell or inherited secrets and cannot block capture | `execFile()` is shell-free and asynchronous, receives an absolute executable, gets an empty environment, and has a 60 s cap | Path argv, empty environment, absolute-path rejection, and long-running non-blocking behavior are covered | Covered |
| Portable and in-app server copies stay identical | Same bytes currently on disk | Copy-sync spec | Covered |
| Skill instructions describe background wake, iterative, and detached modes | `.claude/skills/doc-review-artifact/SKILL.md` | Manual source review | Covered |
| Decision persistence precedes lifecycle delivery | `submitDecision()` stores verdict then dispatch guard before `deliver()` | Service ordering/failure specs | Covered |
| Idle, busy, paused, hibernated, terminated/missing, and live-successor chat delivery | Delivery coordinator and continuity revival helper | Coordinator, service, and lifecycle specs | Covered |
| Revival failure preserves a failed, retryable decision | Coordinator converts revival errors to failed attempts; service persists them | Coordinator-level revival rejection and service persistence specs | Covered |
| Loop-owned review routes through accept/intervene/resume and never restarts terminal loops | Paused-loop creation and coordinator routing | Loop-handler and delivery-coordinator specs | Covered |
| Default-on setting is operator-only | Defaults, metadata, app wiring, and read-only safe-settings policy | Typecheck/policy coverage; targeted source review | Covered |
| Delivery outcome remains visible and pollable | SQLite journal, renderer status/retry UI, MCP result payload | Store/service/renderer tests | Covered |
| Per-rung desktop notifications | Superseded by the canonical plan's durable review-pane/poll/retry recovery contract | Not applicable | Deliberately replaced |
| Real Electron behavior | Existing live-test checklist covers all five delivery paths | Requires rebuilt app and real CLI instances | Deferred in existing `_livetest.md` |

Focused baseline (cache disabled, 2026-07-15): 7 files, 100 tests passed.

## As-built notes

- Preserved the canonical in-app delivery coordinator rather than executing the superseded draft's incompatible notification/resume assumptions.
- Enforced an absolute executable for `--on-capture` and removed all inherited environment entries from the capture hook.
- Added integration coverage proving relative hooks fail closed, the decisions path is the only hook argument, no `PATH` is inherited, and a slow hook cannot delay the successful response or launcher wake exit.
- Added coordinator coverage proving continuity revival errors become a failed, retryable delivery attempt without sending input to a missing runtime.
- Kept the ignored portable skill copy byte-identical to the tracked in-app asset; the existing copy-sync spec and a direct `cmp` both pass.
- No new live-test document was needed. The existing delivery checklist already covers idle, busy, hibernated, terminated/disabled-revival, and loop-gate behavior against a rebuilt Electron app.

## Verification evidence

- Focused red phase: the new relative-hook test failed because the server remained alive instead of exiting 2.
- Focused green phase: 2 files, 22 tests passed.
- Broader feature suite: 16 files, 158 tests passed with `AIO_TEST_NO_CACHE=1`.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed (one pre-existing allowlisted lifecycle file remains inside its tolerance).
- Full unsharded `npm run test:quiet` with `AIO_TEST_NO_CACHE=1`: 1,361 files, 13,389 tests passed in 301.4 seconds.
- Relevant `git diff --check`: passed; no focused/skipped tests, suppression directives, or unrelated paths were added.
