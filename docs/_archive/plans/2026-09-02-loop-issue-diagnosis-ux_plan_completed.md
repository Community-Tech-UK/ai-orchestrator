# Loop Issue Diagnosis UX

Status: completed (visual / screen-reader checks deferred)
Date: 2026-09-02
Live tests: [2026-09-02-loop-issue-diagnosis-ux_livetest.md](./2026-09-02-loop-issue-diagnosis-ux_livetest.md)
Completion gate: PASS (independent fresh-eyes review, 2026-09-02, round 7).
Seven rounds ran; rounds 1–5 each found a real defect, round 6 found one copy
defect, round 7 passed clean. Only the plan's own gate-status prose changed
after that PASS — no code or test changes.

## As-built

Renderer-only. No detector, coordinator, or IPC change.

| Plan item | Where |
|---|---|
| Signal I copy matches what the detector measures | `PROGRESS_SIGNAL_CATALOG.I` — the detector keys on tool + result hash and deliberately ignores arguments (`loop-progress-idempotent-read.ts:17-21`), and fires for grep/glob/ls/search too, so "the same files" was wrong on both counts; now "the same content" |
| `BLOCKED` copy accurate for all three causes it covers | `PROGRESS_SIGNAL_CATALOG.BLOCKED` — main reuses the one id for a BLOCKED.md/block intent, a resource-governor pause and a failed preflight, so the title cannot claim the agent wrote anything; the specific reason rides on the signal's own message |
| Signal catalog (A–I, BLOCKED) + diagnosis view | `src/renderer/app/features/loop/loop-issue-diagnosis.util.ts` |
| Diagnosis card for a WARN/CRITICAL last iteration | `loop-issue-card.component.ts`, wired in `loop-control.component.ts` as `showIssueCard` (hidden when a pause banner is already up) |
| Pause copy scoped to a self-imposed pause | `progressPause` in `loop-control.component.ts` — a manual Pause or awaiting-review pause is `status === 'paused'` too, and must not be described as "paused because it could not prove progress" |
| Headline, problem and next step always name the same signal | `bySeverity` in `loop-issue-diagnosis.util.ts` — the detector emits in fixed id order (A→I) and appends the WARN-escalation CRITICAL last, so the raw array's first entry is routinely not the worst |
| Chip tooltip follows the banner while one is up | `latestVerdict` in `loop-control.component.ts` — the status strip renders alongside the banner, so a blocked pause would otherwise show the real blocker in the banner and a stale iteration WARN in the tooltip below it |
| Banner leads with the signal that actually caused the pause | `bannerIssueView` in `loop-control.component.ts` + the `pauseSignal` input to `buildLoopIssueView`. A BLOCKED / resource-governor / preflight pause is raised out of band (`loop-blocked-file-handler.ts`, `loop-coordinator-state-helpers.ts`) and never reaches `iteration.progressSignals` — the only production writer is the `progressSignals = evaluation.signals` assignment in `loop-coordinator.ts`. Without this the banner headlines a stale WARN and drops the real blocker text |
| STUCK / WATCH / OK chips (`data-verdict` stays CRITICAL/WARN/OK) | `progressVerdictView` / `progressVerdictWord` |
| Inspector evidence in English | `loop-iteration-evidence.component.ts` |
| Pause banner uses diagnosis copy, no `(signal A)` | `loop-control` no-progress banner |

Agent-runnable gates for this change: typecheck ×2, lint, `build:main`, 181 tests
across `src/renderer/app/features/loop/`, and the full suite.

Gates owned by this change all pass: `tsc --noEmit`, `tsc --noEmit -p
tsconfig.spec.json`, `lint`, `build:main`, and 181 tests across
`src/renderer/app/features/loop/`.

Two gates read the whole shared tree and therefore flap while other sessions
edit it — neither reflects this renderer-only change:

- `check:ts-max-loc` passed on the runs bracketing this work, but was observed
  failing mid-review on `loop-coordinator.ts` alone (3948 lines) while another
  session grew it. This feature's own files are well inside tolerance
  (`loop-control.component.ts`, 1160 against a 1125 ceiling plus 50).
- The full suite, below.

The full suite is currently red for a reason outside this change: 20,675 passed,
1 failed — `loop-progress-detector.spec.ts > signal I … does not re-report (or
escalate) a read run the current iteration took no part in`. That test does not
exist in HEAD; it is new and uncommitted, part of another concurrent session's
in-flight fix to `loop-progress-idempotent-read.ts`. A full-suite run of this
same tree immediately before their edits landed was green (20,674, exit 0).

That session's fix is complementary, not conflicting: they are correcting *when*
signal I fires; this plan corrected *what it says*. Their own fix comment cites
the pre-existing label ("Re-reading the same files · STUCK") on turns with no
tool calls as the symptom — which is the copy this plan replaced with
"Re-reading the same content".

Two full-suite caveats, both in unrelated files and both intermittent:

- An earlier run reported 2 *timeouts* (not assertion failures) in
  `src/main/instance/rlm-process-ownership.spec.ts` and
  `src/main/review/local-review-tool-runner.spec.ts`. Both passed in isolation
  (126 tests, 25s) and on the next two full runs. Memory-pressure flakes.
- One run passed every test but the quiet wrapper exited 1 on an unhandled
  post-teardown error: `cancelAnimationFrame is not defined` at
  `src/renderer/app/features/instance-detail/restore-frame.ts:43`, from
  `input-panel.component.spec.ts`. A teardown race — the `setTimeout` fallback
  fires after jsdom is gone — in an unmodified file this renderer-only change
  does not touch. It did not recur on the following full run (exit 0). Worth
  fixing, but it belongs to instance-detail, not this plan.

Behavioural HUD checks are covered by component tests that render the real
template. Only layout, real detector copy and screen-reader announcement are
deferred to the livetest doc.

## Problem

Loop WARN/CRITICAL is shown as operator shorthand (`LAST ITER · CRITICAL`,
`G:CRITICAL, I:CRITICAL`) with no answer to: what happened, whether it is
fixable, and what to do. The pause banner only appears after the loop stops;
the common case is a still-running loop with a prior stuck iteration.

The detector already emits a human `message` on every signal. The HUD throws
that away.

## Approach

Pure diagnosis view over data the store already has. No backend change.

1. Catalog each progress signal (A–I, BLOCKED) with a title, meaning,
   fixability, and next step.
2. Always-visible diagnosis card while the last completed iteration is WARN
   or CRITICAL and no pause banner is already covering it.
3. Human verdict chips: STUCK / WATCH / OK (keep `data-verdict` as
   CRITICAL/WARN/OK for colour).
4. Inspector evidence lists each signal's title + detector message + meaning,
   not `id:verdict`.
5. Pause banner drops `(signal A)` and uses the same diagnosis copy.

## Surfaces

- Active strip chip
- New card under the strip (running WARN/CRITICAL)
- Pause banner
- Inspector iteration header + evidence column

## Out of scope

- Changing detector thresholds or pause policy
- Preflight / audit chip copy (separate, already somewhat labelled)
- Activity-log JSON (tool-arg summariser already exists)
