# Ping-pong loops cannot terminate — remediation plan

**Status:** completed — code, tests and gates done; live validation deferred to
[2026-08-20-pingpong-loop-cannot-terminate_livetest.md](2026-08-20-pingpong-loop-cannot-terminate_livetest.md)
**Created:** 2026-08-20
**Trigger:** Live defect reproduced on loop `loop-1787241037235-b6fe2309`
(workspace `/Users/suas/work/orchestrat0r`, goal "Project Analysis for AIO Improvement").

## Observed behaviour

The loop completed its goal during iteration 0 and then ran four more iterations
(2h40m, 118.3k tokens, $20.25, iteration 5/50) without ever reaching a terminal.

Evidence from the run's own artefacts:

- `.aio-loop-state/loop-1787241037235-b6fe2309/LOOP_TASKS.md` — every leaf item is
  `[x]` done or `[-]` deferred-with-reason.
- `OUTSTANDING.md` — `## Needs human` → `- (none) — everything in scope … has been
  completed and fact-checked`.
- `ITERATION_LOG.md` — `[ledger-complete]` fired on **all five** iterations;
  `[self-declared] TASK COMPLETE / DONE` also fired on iteration 0.
- UI: `PING-PONG round 0/15 · 0 open issues · reviewer $0.00` — the reviewer never
  ran once in 2h40m.

## Root cause

Four independent defects, one of which is fatal on its own.

> **Line references in this section are to the code as it stood before the fix.**
> Several of the cited files were edited by this change, so the numbers no longer
> resolve at HEAD. Post-fix locations are given in the work items below and in the
> LT-300..303 register rows.

### D1 (fatal) — ping-pong owns the only terminal path, and its entry gate ignores the completion detector

`loop-coordinator.ts:2426-2445` is an if/else-if chain:

```
if (pingPongEnabled)                                        → evaluatePingPongCompletion
else if (reviewDriven)                                      → evaluateReviewDrivenCompletion
else if (completionDetector.hasSufficientSignal(signals))   → verify-before-stop, terminate
```

With ping-pong on, `completionSignals` are computed (2397), written to
`iteration.completionSignalsFired` (2404), and then **discarded**. Terminal intents do
not rescue it: only `block` and `fail` are honoured outside that branch
(`loop-coordinator.ts:2916-2923`); a `complete` intent flows through the completion
branch that ping-pong owns.

Inside the ping-pong gate, `loop-pingpong-completion.ts:264-271` returns `null`
("builder is still working") unless `classifyCleanReview` returns clean. That
classifier has **no path to `clean: true`** without the literal
`[[LOOP:CLEAN_REVIEW]]` sentinel (`loop-clean-review-classifier.ts:37-43`): the model
backend can only ever *confirm* not-clean (`if (!model.clean && …) return model`), and
a deterministic clean verdict is explicitly downgraded to `UNCLEAR_CLEAN_REVIEW`. That
asymmetry is deliberate and is **not** being changed here — the sentinel being the sole
*prose* authority is a sound guard against premature stops.

`pp.roundCount += 1` only happens at `loop-pingpong-completion.ts:556`, downstream of
that gate. So `roundCount` stays 0, and the `roundCount >= maxRounds` backstop
(line 300) is unreachable by construction.

Existing stall backstops cannot catch this either — both require
`!madeProductionChange` (`loop-coordinator.ts:3136-3180`), and this loop changed
production files every iteration (18/5/15/19/9) while being definitionally finished.
The `maxCompletionAttempts` budget (2496) and `pauseBecauseCompletionCannotBeVerified`
(2612) are both inside the bypassed else-if branch.

**Fix:** a sufficient completion signal (e.g. `ledger-complete`) is an equally
authoritative builder done-declaration as the sentinel. Ping-pong must open a round on
either. This does not stop the loop — the reviewer still gates convergence — so it
cannot cause a premature stop.

### D2 — `diffSource` is written by three producers and read by none

Repo-wide, `diffSource` is set at `loop-pingpong-completion.ts:357,373` and
`loop-coordinator-completion-gates.ts:432`, typed at
`agentic-pingpong-reviewer.ts:109` and `loop-fresh-eyes-reviewer.ts:70` (whose doc
comment even explains it means "is not a git repository") — and **never read**.

When `workspaceCwd` is not a git repo, `collectWorkspaceDiff` returns
`{diff: '', source: 'none'}` (`loop-diff.ts:107-110`), `diffBlock` collapses to `''`
(`agentic-pingpong-reviewer.ts:310-316`), and the reviewer is still instructed
"The git diff below is your STARTING POINT" (line 301) pointing at nothing. A reviewer
handed no diff, and not told it was handed no diff, is a rubber stamp.

**Fix:** when `diffSource === 'none'`, say so explicitly in the reviewer prompt and
forbid treating an absent diff as evidence of correctness.

### D3 — a verify timeout is reported as "Preflight failed"

`PRE_FLIGHT.md` recorded `Duration: 599998ms` and `(verify timed out after 600000ms)`.
`VerifyOutcome` already distinguishes this (`failureKind: 'timeout'` vs `'command'`,
`loop-completion-detector.ts:713-722` vs `726-736`), but `LoopPreflightResult`
(`loop-audit.types.ts:55-65`) collapses every failure to `status: 'failed'`, so the UI
badge is identical for "your tests are red" and "your command cannot finish in 10
minutes". The configured command here was `npm run verify` — a 14-command chain
including the full test suite, `rebuild:native` and `smoke:electron` — against a
non-configurable 600s cap (`loop-config-defaults.ts:102`).

**Fix:** carry `failureKind` through to `LoopPreflightResult.commands[]` and label the
chip honestly. Keep the red state (a timeout *is* a failure to verify); fix the words.

### D4 — a non-git loop workspace degrades silently

`normalizeManagedIsolation` (`loop-start-config.ts:216-243`) already detects a non-git
workspace and silently disables isolation with only an `info` log. Nothing tells the
user that diff-based review has been reduced to nothing.

**Fix:** emit a visible loop-activity warning at start when the effective repo cwd is
not a git repo and a reviewer is enabled.

## Work items

- [x] W1 — D1: accept a sufficient completion signal as a builder done-declaration.
      **As built:** the resolution logic lives in a new `loop-pingpong-builder-done.ts`
      (`resolvePingPongBuilderDone` + `emitBuilderDoneSignalActivity`). Deviation from
      the original sketch: rather than threading a new `completionSignals` dep through
      the coordinator, the gate reads `iteration.completionSignalsFired`, which the
      coordinator already assigns before the ping-pong branch runs. One source of
      truth, no new plumbing, and `iteration` was already a gate dependency.
      Audited every `sufficient: true` producer in `loop-completion-detector.ts`
      (`declared-complete`, `completed-rename`, `done-sentinel`, `plan-checklist`,
      `ledger-complete`) — all are in-run, agent-initiated done declarations, and
      prose-only `self-declared` is *always* `sufficient: false`, so optimistic wording
      still cannot open a round.
- [x] W2 — D2: `buildPrompt` now consumes `diffSource` and emits an explicit
      "No diff is available" block, distinguishing a non-git workspace from an empty
      diff. The impl-mode instructions no longer reference an absent diff.
- [x] W3 — D3: `failureKind` added to `LoopPreflightResult.commands[]` (type + Zod),
      populated by `runLoopPreflight`, rendered as "Preflight timed out". Kept the red
      state deliberately — a timeout is a failure to verify; only the wording was wrong.
- [x] W4 — D4: `emitNonGitReviewWorkspaceWarning` in `loop-coordinator-state-helpers.ts`,
      called from `startLoop`. **Corrected during self-review:** the first cut treated
      `mode: 'review-driven'` as reviewer-backed, which is wrong — the fresh-eyes gate
      that builds a diff is itself gated on `crossModelReview.enabled`, so a plain
      review-driven loop never builds one. Warning on it would have been a false
      positive. Predicate narrowed to cross-model-review or ping-pong, tests rewritten
      to pin the corrected behaviour.
- [x] W5 — regression tests: 14 new tests across 6 spec files. Each was reverted in an
      isolated `/tmp` copy and watched to fail before being restored; W1's reverts
      reproduce the original symptom exactly (`expected "spy" to be called once, but
      got 0 times` — round 0/15).
- [x] W6 — canonical verification checklist, all green in the real repo:
      `tsc --noEmit`, `tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
      `npm run check:ts-max-loc`, `npm run build:main`, `npm run test:quiet`
      (1759 files / 18,526 tests, exit 0).
- [x] W7 — LT-300..303 in `livetest-remediation-register.md` plus implementation-status
      sections in `2026-07-19-livetest-failure-remediation_plan.md`.
- [x] W8 — independent completion-gate review. Pass 1 returned FAIL on one actionable
      finding: the LT-303 register row and plan section still described the *pre-tightening*
      predicate (including `mode: 'review-driven'`), contradicting the shipped code and its
      own regression test — a stale audit trail that would misdirect a future reader. Both
      documents corrected. The reviewer also surfaced a verified non-blocking gap now
      recorded in LT-303: `runFreshEyesReviewGate`'s `forcedByContradiction` valve
      (`loop-coordinator-completion-gates.ts:341,345`) collects a diff even when
      `crossModelReview.enabled` is false, which no start-time predicate can anticipate.

### Size-ratchet note

Both edited files were already at their `check:ts-max-loc` limits before this change
(`loop-pingpong-completion.ts` at exactly 700, `loop-coordinator.ts` two lines under its
tolerance), so any fix touching them trips the gate. Handled by extracting the new logic
into `loop-pingpong-builder-done.ts` and the advisory into the state helpers, keeping
`loop-coordinator.ts` within its existing ceiling and taking a documented +3 allowlist
entry for `loop-pingpong-completion.ts`. No existing ceiling was raised.

## Explicitly out of scope

- Changing `classifyCleanReview`'s sentinel-only authority for prose (D1 discussion).
- Making `verifyTimeoutMs` user-configurable — worth doing, but a separate UX change.
- The loop prompt's "N consecutive zero-change iterations" stop rule, which is a poor
  fit for open-ended analysis goals. Recorded as a follow-up, not fixed here.
