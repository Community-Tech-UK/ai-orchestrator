# MiMo reasoning-cap cut-off and output cap raise

Status: completed 2026-10-14 (fresh completion-gate review 5: `VERDICT: PASS`); live checks deferred. Register item: [LT-706](livetest-remediation-register.md#lt-706).
Live checks: [2026-10-14-mimo-reasoning-cap-cutoff_livetest.md](2026-10-14-mimo-reasoning-cap-cutoff_livetest.md).

## Problem

Session `ivx7upc8u` (OpenCode, `aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`, 2026-10-14) stopped
silently. OpenCode's own record shows three consecutive steps with `finish: "length"` against
the injected 16384 combined cap: output 0 + reasoning 16388, output 1 + reasoning 16383, and,
after James's manual "continue", output 0 + reasoning 16386. ACP reported all three as
`end_turn`. Harness classified the first as `dangling_tool_result` (one continuation) and the
other two as `completed`, so no notice and no further continuation.

Root cause: `outputBudgetSaturated` in `src/main/cli/turn-ending-classifier.ts` returned false
for empty turn text and judged "finished" from whole-turn text, while ACP usage covers only the
final provider step. The shared observation layer (`adapter-turn-ending-observation.ts`)
reclassified without the cap and let `dangling_tool_result` override the adapter's ending.

James asked on 2026-10-14 to raise the MiMo cap and fix the silent stop.

## Changes

1. Classifier: a saturated cap whose final step produced at most the tolerance in visible output
   tokens is `max_output / budget_saturated`, regardless of earlier narration. Empty text under a
   saturated cap is also a cut-off. The cap is read from `combinedOutputTokenCap` or the
   adapter's `generationBudget` metadata, so the observation layer agrees. The check runs before
   the dangling-tool-result check and applies only to completions with no open tool call and no
   failure or transient-error signal (error kind or stop reason, `is_error`, `error`,
   `completionStatus: failed`, 502/503/504 or retrying text). Transient errors stay `retryable` as
   before. Failure signals are now `unknown_error` even under a saturated cap (previously a
   saturated failure with unfinished text was `max_output`), so a failed turn never auto-continues.
2. Cap: `MIMO_COMBINED_OUTPUT_TOKEN_CAP = 32_000` in `opencode-generation-budget.ts` (was
   16384). MiMo documents 131072 as default and maximum (`mimo.mi.com/docs/en-US/api/chat/openai-api`,
   re-fetched 2026-10-14). OpenCode 1.19.0 also sends `max_tokens` clamped to its own 32000
   ceiling (isolated loopback wire capture, `_scratch/mimo-cap-wire-smoke.py`): at a 65536 cap
   the request carried `max_completion_tokens=65536, max_tokens=32000` (captured with the helper
   constant temporarily at 65536; the saved script exercises the shipped value). 32000 keeps both fields
   equal, so the classifier's cap is the cap the provider enforced. Raising beyond 32000 needs
   OpenCode's experimental `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX`, deliberately not used.

## Verification

- Six new tests fail on the previous classifier and pass now: four classifier cases (zero text,
  earlier narration, metadata cap over a dangling result, metadata usage), the shared runtime
  observation case and the `acp-turn-completion` saturation case.
- Isolated OpenCode 1.19.0 wire capture: `max_completion_tokens=32000, max_tokens=32000`.
- Canonical gates: see as-built notes.

## As-built notes

- First gate run (before review fixes), live checkout: all seven canonical gates exit 0
  (`test:quiet` 2430 files, 31506 tests).
- Fresh completion-gate review 1: `VERDICT: PASS` with two Low findings (plan/register said two
  length endings, not three, and gave a wrong earlier-step range; the error-case test asserted
  only a negative) and one advisory (comment the near-empty-step trade-off). All three fixed;
  focused rerun (438 files, 6373 tests), `tsc`, eslint on the changed files and
  `check:ts-max-loc` exit 0.
- Fresh completion-gate review 2: `VERDICT: FAIL` on one Medium (livetest expected an `evidence`
  field on the `ProviderTurnEnding` line, which never logs it) and one Low (saturation could
  override failure signals other than error kind / `is_error`), plus a Low origin-time typo and
  advisories (historical livetest wording, no ACP-path test). All fixed: failure and transient
  checks are computed once and gate saturation; new parameterised negative test and an
  `acp-turn-completion` saturation test added.
- Fresh completion-gate review 3: `VERDICT: FAIL` on one Low (this plan said 4 failing tests on
  the old classifier; it is 5) plus advisories (metadata-only open-tool and output-token fallbacks
  untested; 65536 wire variant not saved). Fixed: register acceptance names the ACP case and
  tests now cover the metadata-only guards (the failing-test count is now six, see Verification).
- Final gates. Live checkout, after review-2 fixes: `tsc --noEmit`, `typecheck:spec`, `lint`,
  `check:ts-max-loc`, `build:main`, `build:renderer` exit 0 (the review-3 test-only additions
  came after this run and are covered by the isolated tree below); its full-suite run overlapped another
  session's 22:48 commit and showed 16 failures in that session's files (model pricing, RLM
  maintenance schemas, Claude usage probe), which pass on rerun. That session's later in-progress
  browser-gateway files then broke `typecheck:spec` and `check:ts-max-loc` in the live checkout.
  Isolated tree `/tmp/mimo-cap-verify` (`git archive HEAD` plus only this task's files):
  `tsc --noEmit` and `typecheck:spec` exit 0 with no errors; full suite 31681 of 31682 pass. The
  one failure (`generate-architecture-inventory` reading `HEAD`) is an artifact of that tree having
  no commits, and it passes in the live checkout.
- Fresh completion-gate review 4: `VERDICT: FAIL` on one Low (failing-test count is six, not five)
  plus wording advisories on failure-signal labels and gate provenance. All fixed in this document
  and the register.
- Fresh completion-gate review 5: `VERDICT: PASS`, advisories only.
- Live checks deferred to the linked livetest (rebuilt app plus a real capped MiMo step).
