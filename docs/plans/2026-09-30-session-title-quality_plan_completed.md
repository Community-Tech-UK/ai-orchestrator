# Session title quality repair

Status: completed source implementation and in-loop verification in James's
supplied main checkout. Fresh independent gate: PASS (twelfth reviewer, plus a
confirming reviewer for the final test-coverage additions). Work is uncommitted.
Three packaged-app adoption checks remain deferred in the linked live-test document.

## Evidence and cause

Title-only production evidence for `cz3mwn04e` on 2026-09-30 records an instant
Work Finder health-watchdog title followed by a contextual AI upgrade to `1.`.
The original raw model response was not recorded. A synthetic real-service
reproduction confirms the formatter could reduce numbered prose to `1.` after
the previous length-only check; display sanitization then produced `1`.
This is a reproduced path, not a claim to have captured the original response.

The repair validates raw model output and its formatted result. It also fixes
independently reproduced display-recovery, original-request retention and late
callback defects. Earlier incomplete reviews and interrupted/failed suites are
historical investigation only. Their accumulated notes were preserved under
`_scratch/title-plan-history-before-round14.md`; they are not current PASS proof.
A retained claim of a prior eleventh review was withdrawn when no report existed.
The actual eleventh report is `_scratch/title-completion-gate-11.md`, FAIL before
its topic-label finding was repaired.

## Acceptance and implementation

- [x] Reject numeric/recognizable opaque-ID titles, numbered or multiline answers,
  model-answer labels, narration and subjectless generic states before and after
  formatting. Preserve identifying subjects, versions, filenames and rail ellipses.
- [x] Share the escaped, data-delimited local/CLI prompt. Reserve opening-task and
  first-reply space independently so a long opener cannot consume all context.
- [x] Register contextual naming for short openers without opener-only model spend.
  Keep history local-only generation local even when paid fallback is authorised.
- [x] Reject unusable automatic saved/live candidates before formatting hides their
  structure. Prefer useful established names/history or the earliest genuine opener.
  History's own absence sentinel cannot outrank a real live opener. Nullish first
  previews and empty manual-history fields do not crash or win as evidence.
- [x] Retain the earliest genuine opener beside bounded main/renderer buffers plus
  the newest nineteen other prompts, chronologically. Map retained prompts and
  rename state; preserve opener through streaming trims and loaded-history release.
  Internal/cross-session traffic is excluded from original-request selection.
- [x] Preserve explicit manual and useful established names. Naming callbacks check
  current manual state; completed contextual naming fences slower opening/retry
  results. All shared termination routes clear naming state before await/early exit.
- [x] Invalid CLI answers proceed to the next permitted provider, retaining existing
  automation exclusions, route preflight, authorization/cost wrappers and timeouts.
- [x] Verify actual compiled service/provider/display and actual Angular-store paths
  before permanent regression additions. Root additionally reproduced Tab/Summary
  label inconsistencies and consolidated label nouns into one shared vocabulary.
- [x] Finish the current uncached full suite.
- [x] Obtain a genuinely fresh independent task-completion-gate PASS with no
  unresolved actionable findings.

Deferred packaged adoption: three checks in the linked live-test document below.

The lexical policy is conservative: it cannot infer subjects from input that has
none, or distinguish every all-letter/trailing-version-shaped ID from a real word.
Useful names and deliberate renames take priority over guessing. No universal
natural-language quality guarantee is claimed.

## Current verification

All twenty scoped source/test paths are frozen in
`_scratch/title-round14-source-sha256.json`. No task dependencies, test runner,
configuration, thresholds, skips or suppressions were changed.

Current actual exit-0 gates: `npx tsc --noEmit`, `npm run typecheck:spec`, both
lint commands, LOC ratchet, main build, renderer production build and diff check.
Evidence: `_scratch/title-*-round14.log/.exit`; final spec/lint/diff use
`*-final-round14`. Main build completed before compiled runtime validation.
Focused tests: fourteen files / 1,647 tests, uncached, actual exit 0;
`_scratch/title-focused-round14.log/.exit`, raw
`_scratch/test-run.title-round14-focused.log`.

Root label-grammar runtime checks: 297 assertions pass across the compiled
service, local/CLI provider paths, stored/live resolvers and manual/useful controls.
The pre-repair Tab/Summary probe failed 32 assertions, and the prior topic probe
failed 16. Current evidence: `_scratch/title-round14-label-nouns-after.log/.exit`;
pre-repair logs use `title-round13-*-before`. An earlier after-probe loaded stale
dist while a build was pending and is expressly excluded from repaired proof.
Actual Angular rail/history assignment matches the header; mapper/stream/release
preserves the opener and manual names. Evidence:
`_scratch/title-round13-sentinel-run.log/.exit` and
`_scratch/title-round13-renderer-run.log/.exit` (same retained/display source).

The round13 full run was interrupted with actual exit 130 before the Tab/Summary
repair. No PASS is claimed for it. Round14's current full suite runs only after
all compiler/build jobs finished, with documented four-fork override and cache
bypass. Summary/exit: `_scratch/title-full-suite-round14.log/.exit`; raw:
`_scratch/test-run.title-round14-parent.log`. Actual exit 0: 2,267 files / 28,451
passed tests, six pre-existing skips, 676.7 seconds. All twenty frozen hashes
still match afterward.

The genuinely fresh twelfth reviewer assessed the entire scoped patch and returned
`VERDICT: PASS` with no unresolved actionable findings. All canonical gates were
independently reproduced with actual exit 0, along with fourteen focused files /
1,647 tests and the uncached full suite: 2,267 files / 28,451 passed tests, six
existing skips, 535.7 seconds. Independent compiled probes pass 256 controls;
actual Angular stores pass fourteen. Final twenty hashes match with zero source
edits by the reviewer. Report: `_scratch/title-completion-gate-12.md`; evidence
uses `title-review12-*`, including `focused-final`, `runtime-final`, `renderer`
and `full`. Raw full log: `_scratch/test-run.title-review12-full.log`.

A separate concurrent review cycle identified two test-coverage gaps on top of
the PASS: the contextual-naming log distinction ("instance cleared" vs
"no usable title") had no assertion, and `hasModelAnswerLabel`'s `task`/`subject`
nouns had no label-form cases. Both were fixed with test-only additions:
`Task: …`/`Subject: …` (plus `Suggested` variants) in the rejected-presentation
list, and two `mockLog.debug` assertions — the cleared case uses a deferred
`generateTitle` so the instance is cleared while the model call is in flight.
No source behaviour changed. Focused verification passes five title files /
1,547 tests. All eight canonical gates pass with actual exit 0
(`title-*-round15.*`). A confirming fresh review covers the test additions.

## Constraints and adoption

No branch/worktree creation, commit, push, deployment, live-session data rewrite,
packaged-app replacement or restart. Unrelated staged/unstaged work is preserved.
Verification uses the supplied checkout and existing installed/native dependencies;
no clean-install or packaged-runtime proof is implied.

Packaged adoption checks genuinely require the rebuilt/restarted app and remain
in [the live-test document](2026-09-30-session-title-quality_livetest.md). The agent
cannot interactively control Harness through Computer Use. All agent-runnable
checks and the fresh gate passed before the live-test backlink was updated and
this plan received its completed filename. Both documents remain uncommitted.
