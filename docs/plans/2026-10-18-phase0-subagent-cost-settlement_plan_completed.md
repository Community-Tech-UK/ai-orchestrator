# Phase 0 subagent-frame cost settlement correction

Status: completed on 18 October 2026, uncommitted. Implementation, all seven canonical gates and the genuinely fresh independent correction gate pass. New follow-up to the closed Phase 0 implementation document; that document remains unchanged. This is an acceptance defect reproduced by the fresh landed-diff audit, not a verified live-provider incident.

**Goal:** retain the provider's final main-turn charge when a subagent assistant frame arrives between a main-turn error and its trailing result.

**Architecture:** preserve Claude's existing resident settlement owner and its finite fallback. Only frames belonging to the next main turn may establish the main-turn boundary. CostTracker, billing identity, deferred attribution and completion ownership retain their existing contracts.

**Stack:** TypeScript, Vitest, Claude native-frame adapter, InstanceCommunication and CostTracker.

**Acceptance source:** the original Phase 0 cost criteria 7b/F3; fresh audit evidence in `_scratch/changed-plans-queue-2026-10-18/phase0-landed-review/`. No new feature or accounting policy is introduced.

## Constraints and ownership

- Work in the existing root branch/checkout; no branch/worktree creation or manual Queue lifecycle edits. Never commit or push without James's explicit request.
- Preserve unrelated dirty Mimo files, active Queue workers and all closed documents. The original Phase 0 plan is not reopened or edited by this correction.
- Implementation ownership: `src/main/cli/adapters/claude-cli-adapter.ts` and meaningful regression coverage in `src/main/cli/adapters/claude-direct-failed-usage.spec.ts`. Broaden source scope only when the executing path proves it necessary and record why first.
- Read full source, executing callers, shared types and existing tests before edits. Reproduce with the immutable scratch fixture before editing. Confirm the corrected actual adapter-to-accounting path before adding/updating permanent tests.
- No browser or desktop control is needed. Any future browser step must preflight Browser Gateway and target `windows-pc`; no Mac fallback. Do not install/restart Harness.
- Keep historical failing logs immutable. Normal current-source verification and a genuinely fresh independent completion-gate PASS are required before closing this plan. Do not run the full suite alongside native Queue workers/checkers; coordinate the execution window.

## Reproduction and root-cause hypothesis

The independent reviewer exercised the real Claude adapter → InstanceCommunication → CostTracker with controlled native-frame data and a mocked process. A first main result records cumulative 0.50; the next main turn errors, then a subagent assistant frame arrives before cumulative native result 0.75. Actual tracked total is 0.501 rather than 0.75. Exactly two completion events and two attribution rows remain, so the defect concerns early fallback replacing the native delta, not duplicate completion.

Three paired controls pass and only the subagent-interleaving case fails. The ten imported production files match landed source. Evidence: `subagent-settlement-probe.spec.ts`, `probe.config.ts`, `subagent-controls.log`, `subagent-controls-receipt.json` and `subagent-probe-source-proof.json` in the review directory. Raw actual exit is one. Real provider occurrence frequency is not inferred from this fixture.

Hypothesis to confirm: `processCliMessage` settles an old errored resident turn on every assistant frame before checking `parent_tool_use_id`. A subagent frame therefore closes main billing early. Preserve the main-turn assistant boundary while excluding subordinate frames from it.

## Work and verification

- [x] Read full affected source/tests and relevant callers; independently replay the immutable failing fixture and controls before editing.
- [x] Apply the smallest production correction that preserves main-turn settlement, finite fallback, cancellation/exit cleanup, provider cost deltas and one semantic completion per main turn. Record the real-path GREEN result before permanent test updates.
- [x] Add permanent regression coverage for the exact interleaving: final cumulative 0.75, provider attribution delta 0.25, exactly two rows and exactly two completions. Retain paired control, split/same-chunk behavior and next-main-turn/absence-of-result fallback coverage without weakening assertions or timeouts.
- [x] Run appropriate focused adapter/accounting tests, both TypeScript checks, lint, LOC, main build, renderer build and full quiet suite. Retain raw logs, actual child exits and source freshness. Wait for the current Queue verification execution window before the full suite.
- [x] Obtain a genuinely fresh `task-completion-gate` review of the exact correction and acceptance. Fix all actionable findings and repeat with a fresh reviewer until PASS.
- [x] Update as-built notes, rename this plan `_completed` only after its own required checks pass, and leave it uncommitted. The original whole-Phase-0 audit and remaining ten-plan continuation stay open independently.

## Review focus

Subagent frames after main errors; the first assistant of a later main turn; native result arriving in the same or a later stdout chunk; missing-result fallback and terminal cleanup; cumulative model cost and attribution identity; no duplicate completion or booking. Existing independent source-review gaps remain acceptance blockers outside this narrow repair.

## Current verification evidence — 2026-10-18

The implementation evidence is retained in `_scratch/changed-plans-queue-2026-10-18/subagent-settlement-fix/`: immutable pre-edit failure receipts, corrected real-path probes before permanent test updates, focused tests, source/config fingerprints and exact owned diff. Initial fixture typing failures in the path-request work remain recorded; the final typed fixtures and both final TypeScript checks pass.

Shared current-source canonical verification is retained in `_scratch/changed-plans-queue-2026-10-18/acceptance-corrections-verification/`. `checks.json` records both TypeScript checks, lint, LOC, main build, renderer build and full quiet suite with actual exit zero and no source drift. `full-summary.json` plus `child-exits.jsonl` independently records the actual Vitest child exit zero, no signal, no failing tests and stable source. Full runner logs and structured results remain in `_scratch/test-run.phase0-corrections-full.log` and `_scratch/test-results.phase0-corrections-full.json`.

At that checkpoint these results did not close this plan; the independent correction reviewer was still running its own isolated verification. The later as-built closure below supersedes only that pending gate status. The original broad Phase 0 acceptance audit and the remaining batch continuation remain separate, outstanding work.

## As-built closure — 18 October 2026

Only main-thread assistant frames settle a pending failed main turn and reset main-turn state; subagent output remains observable without taking over its billing boundary. Exact native totals/deltas, row/completion counts, chunk variants and finite terminal fallback are covered.

Fresh independent completion review: [final narrow report](../../_scratch/changed-plans-queue-2026-10-18/corrections-fresh-gate/FINAL-REPORT.md), `VERDICT: PASS`, no unresolved actionable finding within the exact six-file correction scope. The reviewer independently replayed original failing bytes and corrected controls, ran focused tests and all seven canonical checks with the report's explicit split-context proof. The final canonical full's actual Vitest child exited zero without a signal; structured results have zero failed tests and exactly the existing seven pending cases, with the complete status multiset matching the normal root run. Source/config, index, additional assets and all clean-installed dependency entries remained stable.

Root read the full final report, actual child events, final canonical receipt and final assessment, then independently rehashed all six owned source files and 128 sealed evidence artifacts with no mismatch. Exact receipt: `corrections-fresh-gate/parent-independent-final-seal-check.json`. Earlier verifier install/context failures, vacuous snapshot LOC and interrupted unknown-status full remain explicitly recorded rather than converted to success.

This closes this follow-up only. The original whole-Phase-0 audit and original batch continuation remain open, with separate newly investigated caller/ownership leads. No real-provider incidence, installed-app delivery, app installation/restart, original-plan acceptance, manual integration, commit or push is claimed. The completed plan and source/test changes remain uncommitted.
