# ACP Loop Liveness and Failed-Usage Accounting Implementation Plan

> **For agentic workers:** Follow the repository's live-first debugging rule. Do not update tests
> until the rebuilt application behaviour has been verified.
>
> **Gate resolution (2026-09-03):** James instructed "Please fully implement this", which authorised
> proceeding past Task 5's stop-and-confirm gate. The live Cursor/Grok checks genuinely need a
> rebuilt app and a real provider that goes silent mid-turn, so they were deferred into
> [2026-09-03-acp-loop-liveness-accounting_livetest.md](./2026-09-03-acp-loop-liveness-accounting_livetest.md)
> rather than skipped, and the regression tests were written against reproduced unit/integration
> behaviour. Each new test was verified load-bearing by reverting its production change and
> observing the failure.

**Status:** Completed 2026-09-20. The independent fresh-eyes gate returned PASS and the canonical
checklist is green on this tree, so the `_completed` rename is taken. Live checks remain deferred to
[2026-09-03-acp-loop-liveness-accounting_livetest.md](./2026-09-03-acp-loop-liveness-accounting_livetest.md).

**Goal:** Make ACP loop liveness truthful and retain estimated usage from failed partial turns.

**Architecture:** Real provider notifications remain the only ACP heartbeat source. Partial usage is
estimated at the adapter error boundary, sanitized through the loop invocation error payload, and
charged once by a focused orchestration helper. The HUD distinguishes settled totals from pending
current-turn usage.

**Tech Stack:** TypeScript, Electron, Angular signals/templates, Vitest, better-sqlite3.

**Spec:** [2026-09-03-acp-loop-liveness-accounting_spec_completed.md](./2026-09-03-acp-loop-liveness-accounting_spec_completed.md)

## Global Constraints

- Preserve unrelated dirty-tree changes.
- Do not create a branch or worktree.
- Do not change workspace side-effect retry decisions.
- Do not fabricate ACP context occupancy.
- Treat all fallback usage as estimated.
- Do not update tests before rebuilt-app verification.

## Task 1: Truthful ACP liveness

**Files:**

- Modify `src/main/cli/adapters/acp-cli-adapter.ts`.

- [x] Remove prompt-pending synthetic heartbeat emission.
- [x] Retain heartbeat emission for valid inbound `session/update` notifications.
- [x] Confirm statically that the existing ACP inactivity timeout and stream-idle watchdog now observe real traffic.

## Task 2: Preserve partial usage on ACP failures

**Files:**

- Reuse `src/main/cli/adapters/acp-usage-estimator.ts`.
- Modify `src/main/cli/adapters/acp-cli-adapter.ts`.
- Modify `src/main/orchestration/loop-invocation-error-payload.ts`.
- Modify `src/main/orchestration/loop-child-invoker.ts`.
- Modify `src/main/orchestration/loop-coordinator.types.ts`.

- [x] Estimate usage from prompt, partial assistant text, and tool activity before turn buffers clear.
- [x] Attach the estimate and model to the thrown adapter error.
- [x] Sanitize finite non-negative fields into `LoopChildInvocationError`.
- [x] Preserve those fields when the callback payload becomes an `Error` at the coordinator boundary.

## Task 3: Charge a failed attempt once

**Files:**

- Create `src/main/orchestration/loop-failed-attempt-usage.ts`.
- Modify `src/main/orchestration/loop-coordinator.ts`.

- [x] Resolve tokens and cost through the existing model-pricing path.
- [x] Apply a charge once per failed invocation attempt.
- [x] Update token-without-progress accounting.
- [x] Emit a visibly estimated activity entry and a state broadcast.
- [x] Preserve retry, failover, terminal-intent, and writes-observed pause semantics.

## Task 4: Honest in-flight HUD copy

**Files:**

- Modify `src/renderer/app/features/loop/loop-control.component.ts`.

- [x] Render `tokens pending` / `cost pending` for the first unsettled iteration.
- [x] Render settled totals plus `current pending` when earlier iterations exist.
- [x] Preserve terminal and idle formatting.

## Task 5: Build and live verification

- [x] Run both TypeScript checks, `npm run build:main`, and `npm run build:renderer` — green, but in
      an isolated `/tmp` copy of the tree. The live tree cannot currently rebuild: a concurrent
      session's `loop-iteration-prompt.ts:70` is missing `includeSessionReplay`. See Verification.
- [x] Live Cursor/Grok verification deferred — see the livetest doc (needs a rebuilt app and a real
      silent/timing-out ACP provider, neither producible in-loop).
- [x] Gate resolved by James's "fully implement this" instruction; recorded in the header above.

## Task 6: Regression tests and completion gates

- [x] Add focused tests. Six files: adapter liveness + partial usage, error-payload sanitization,
      invoker seam, the failed-attempt charge (unit + coordinator integration), and HUD copy.
- [x] Run both TypeScript checks, lint, LOC gate, main build, and full quiet test suite.
- [x] Run an independent fresh-agent `task-completion-gate` review and resolve every finding.
- [x] Update as-built notes and rename both documents with `_completed` suffixes.

## As-Built Notes

- **Task 1.** `PROMPT_LIVENESS_HEARTBEAT_MS` and both synthetic emissions are gone from
  `AcpCliAdapter.sendMessage()`. The sole remaining `emit('heartbeat')` sits on the validated
  inbound `session/update` path — after the session-id match, deliberately before payload-shape
  validation, since a malformed frame from the right session is still real inbound traffic — beside
  `refreshCurrentPromptTimeout()` and `resetStallWatchdog()`, so the ACP inactivity timeout and
  stall watchdog now observe only real traffic.
- **Task 2.** The catch block reuses `estimateAcpCliUsage()` against the prompt text, the partial
  assistant chunks, and the tool-activity chunks before the turn buffers clear, and attaches
  `partialUsage` / `partialModel` to the thrown error only when the estimate yields positive tokens.
  Occupancy is untouched — the estimate is never fed to `buildAcpContextUsageEvent()`.
  `sendMessage()` now holds the turn in a local rather than re-reading `this.currentPrompt` after
  the await: the process `'exit'` handler nulls that field synchronously before rejecting the
  pending request, so a crashed or SIGKILLed agent used to lose both its buffered output and its
  partial-usage estimate. Caught by the third fresh-eyes gate pass; covered by a regression test
  that kills the fake process mid-turn rather than only answering with an RPC error.
  The attach is additionally gated on *observed* assistant text or tool activity, not on the
  estimate being positive. `estimateAcpCliUsage()` counts the outbound prompt as input, so gating on
  `totalTokens > 0` alone would have charged every failure past the `sendRequest` call — including a
  transport failure that never reached the provider — for tokens nobody spent, breaking Required
  Behaviour 7. Caught by the fourth gate pass; the previous "no material" test hid it by using an
  empty prompt, which Loop Mode never sends. Replaced with a realistic-prompt RPC-error case, a
  realistic-prompt process-death case, and a tool-activity-only case that must still charge.
- **Known limitation (deliberate).** "Observed material" means `turn.chunks` (agent_message_chunk)
  or `turn.toolActivityChunks` (tool_call / tool_call_update). A `plan` session update is real model
  output but is rendered straight to structured output and never retained on the turn, so a turn
  that emitted only a plan and then died stays uncharged. This matches the spec, which enumerates
  the estimate's sources as "the prompt, partial assistant text, and observed tool activity" — plan
  entries are not among them — and it errs toward under-charging rather than inventing a number
  (Required Behaviour 7). Retaining plan text would also change the *successful*-turn estimate,
  which is outside this plan's scope. Reasoning/thought deltas are likewise not captured; the
  adapter has no `agent_thought` branch at all, which predates this work.
- **Task 3.** `chargeFailedAttemptUsage()` has exactly one call site, immediately after the
  invocation try/catch and before every retry, failover, cap-wrap-up, and pause-for-review decision.
  A user cancellation short-circuits above it so a terminal checkpoint is never mutated by a
  late-rejecting abandoned promise.
- **Deviation from the first implementation pass.** That pass also hard-terminated the run with
  `cap-reached` when the charge crossed a hard cap. Removed: it was a second cap path that skipped
  the `capWrapUpIteration` wrap-up turn `LoopPreIterationGuard` guarantees. The guard re-checks
  `checkLoopHardCaps(state)` at the top of the next iteration, so the charge is still enforced,
  through the one correct path.
- **Cost basis.** `chargeFailedAttemptUsage()` forwards `usage` to `resolveIterationCost()` only
  when it carries a field `computeTokenCost()` actually prices. That pricer reads the
  input/output/cache/reasoning breakdown and ignores `totalTokens`, while `hasUsageBreakdown()`
  selects its `computed` basis from any positive number — so a totals-only snapshot would have
  priced a real token charge at $0.00. Withholding it falls back to the legacy flat estimate.
- **Known asymmetry.** A charged failed attempt lands in `LoopState` totals and the HUD, but not in
  the global CostTracker ledger: `recordCostAttribution()` sits on the success path only, and a
  failed turn never calls `completeResponse()`. Spec-conformant — Required Behaviour 5 scopes the
  charge to "run token/cost totals" — but recorded here so it is not rediscovered as a bug
  alongside the LT-100 cost-tracking notes.
- **Task 4.** The HUD predicate is `usageUnsettled` — `runningIteration() || status === 'running'`.
  `runningIteration()` alone was insufficient: `LoopStore.runningIterationByLoop` is written only by
  the live `loop:iteration-started` push and has no hydration path, so a renderer that reloads
  mid-iteration would have fallen back to `0 tok · $0.00`, violating Required Behaviour 3. Caught by
  the fresh-eyes gate. The adjacent elapsed field needed the same treatment for the same reason:
  `currentIterationElapsed()` returns a hard `0` without a running iteration and `humanDuration(0)`
  is `"0s"`, so widening that binding to `status === 'running'` had replaced `idle` with a
  fabricated `current 0s` for a turn that might have been running for twenty minutes. It now renders
  `pending` in that window and keeps `idle` for a run that genuinely is not running, preserving the
  idle formatting Task 4 requires. Caught by the fifth gate pass.
- **File-size gate.** The four status-strip helpers initially pushed `loop-control.component.ts`
  from 1163 to 1180 lines, past its 1125 + 50 hard limit — a gate this plan owned and failed, caught
  by the sixth gate pass. They now live in `loop-usage-copy.util.ts` as pure functions with their
  own spec, matching the extraction pattern the concurrent audit-chips work used; the component is
  back to 1160 lines. `npm run check:ts-max-loc` now reports one violation, `loop-stage-machine.ts`
  at 794 lines, which belongs to the concurrent prompt-assembly refactor and is untouched here.
- **Deliberately not changed.** `sendMessage()`'s `finally` still reads
  `this.recentAssistantTurn = this.currentPrompt ?? this.recentAssistantTurn` rather than the
  hoisted local. On the process-exit path the `'exit'` handler clears `recentAssistantTurn` on
  purpose; assigning `turn` there would resurrect a reference it just cleared, and no late chunk can
  arrive from a dead process. The hoist was needed for the usage estimate, not for this cleanup.
- **Verification.** `ng lint` clean. Full quiet suite: 20892 tests, the only failure in
  `loop-stage-machine.spec.ts`, owned by a concurrent session's uncommitted `includeSessionReplay`
  work. Both `tsc --noEmit` invocations, `build:main` (including `sync-dist.js`) and `build:renderer`
  were run to green in an isolated `/tmp` copy of the tree, patched *only* to work around two
  in-flight breaks belonging to other sessions (`loop-iteration-prompt.ts` missing
  `includeSessionReplay`, and `blindReviewerWorkspaceStartError` imported before it was exported).
  Those two breaks are not attributable to this plan and are still red in the live tree.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.

### Checkbox reconciliation (2026-09-20)

This plan was written in the step-by-step checkbox style and the implementing session never ticked
the boxes as it went, so a reader arriving after the `_completed` rename would have seen a closed
plan full of unchecked work. The boxes are now ticked to match reality, which was established by
reading the executing code and the specs on disk — not by trusting the plan's own prose. The
independent fresh-eyes reviewer confirmed each step's artefact exists and that the tests covering it
are load-bearing rather than vacuous. Items that genuinely remain unverified are the live checks,
and those are named in the status line above and tracked in the linked `_livetest.md`, not ticked
here.
