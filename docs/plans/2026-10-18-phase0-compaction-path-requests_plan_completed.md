# Phase 0 path-leading user requests in saved context

Status: completed on 18 October 2026, uncommitted. Implementation, all seven canonical gates and the genuinely fresh independent correction gate pass. Separate follow-up to the closed Phase 0 plan. The original completed document remains untouched. This is a deterministic continuity-contract defect, not a claim of complete latest-request loss in a live provider session.

**Goal:** preserve legitimate user requests beginning with paths in verbatim user history and the dedicated latest-request field, while excluding actual commands and internal inputs.

**Architecture:** use stored command provenance to classify commands. A pure exact built-in name/alias lookup may preserve legacy unmarked built-in command exclusion. Unknown slash/path text remains ordinary user input. Mark resolved dynamic native commands at their existing dispatch boundary so compaction does not need live registry calls or I/O.

**Stack:** TypeScript, OutputMessage metadata, restart compaction and Vitest.

**Acceptance source:** original Phase 0 Step 10.6/10.8 and sealed F2 evidence in `_scratch/changed-plans-queue-2026-10-18/phase0-landed-review/`.

## Evidence and limits

`realUserMessages` currently excludes every user string beginning with `/`. Actual input resolution keeps unknown path text unchanged and stores it as ordinary user input without command metadata. As a result, a path-leading real request is absent from `user_messages`, and `latest_user_request` can incorrectly name an earlier ask. The normal tail selector always retains the newest user turn, so the newest ask still exists in `recent_messages`; do not describe this as complete latest-request loss. Older path-leading asks outside that tail lack their required deterministic verbatim fallback and depend on the model summary/index.

Immutable RED helper/package controls: `compaction-user-probe.spec.ts`, its config, controls log and actual-exit receipt (two failures, one passing ordinary/actual-command control). Supplemental command-resolution and normal prepareRestartCompaction probe has two passing tests and records the recent-tail qualification. Both seals and full call-path evidence are retained alongside `finding-F2.md` / `finding-F2-callpath-supplement.md`. Do not overwrite them.

## Scope and constraints

- Existing root branch/checkout only; no new branch/worktree, manual AIO lifecycle edits, staging, commit, push, installation or app restart.
- Ownership: `src/main/context/compaction-continuity.ts`, its adjacent spec, `src/main/instance/instance-native-command-input.ts` and a focused adjacent dispatch spec. Reuse the pure built-in definitions in `src/shared/types/command.types.ts` without changing command policy. Read all full affected files/callers/types/tests before edits; record any necessary scope expansion first.
- Preserve the first correction's adapter/spec changes and every unrelated dirty file. Other agents and a native Queue verifier remain active.
- Keep command/internal/cross-session exclusions, redaction, package delimiters and budgets. Do not add async registry or filesystem work inside compaction classification.
- No browser/desktop work is needed. Any browser step must preflight Browser Gateway on `windows-pc`; never fall back to the Mac. Harness desktop control stays forbidden.
- Broad verification waits for the current native Queue checker. Both this correction and the separate settlement correction may share one source-stable canonical run; their acceptance and exact diffs remain explicit. Fresh independent review is mandatory before closure.

## Work

- [x] Read the full helper/package/input/command/native-dispatch path and existing tests. Independently replay immutable RED controls and qualifying call-path probe before any edit.
- [x] Correct user classification with authoritative metadata plus a pure exact legacy built-in fallback; preserve unknown slash/path inputs. Mark genuinely resolved dynamic native commands at dispatch so their user messages remain excluded without heuristic overreach. Verify actual helper/package and dispatch behavior before permanent test updates.
- [x] Add meaningful regressions: absolute multi-component and single-component POSIX paths, unknown slash/path text, exact built-in names/aliases, command metadata, dynamic native provenance, internal/cross-session exclusions, actual latest-request field and older user requests outside the recent tail. Preserve existing redaction/budget/delimiter and provider dispatch checks.
- [x] Run focused continuity/restart/native-command/input tests and all canonical gates: both TypeScript checks, lint, LOC, main/renderer builds and the full quiet suite. Retain actual exits, raw logs and unchanged-source fingerprints; do not overlap full suites with live Queue workers/checkers.
- [x] Obtain a genuinely fresh task-completion-gate PASS for the exact correction; fix every actionable finding and repeat with a fresh verifier. Preserve the broader Phase 0 audit as independently outstanding.
- [x] Record as-built evidence and rename this plan `_completed` only after all its own runnable checks and fresh review pass. Leave it uncommitted and preserve closed original documents.

## Review focus

Path input versus a command token; legacy exact-name/alias matching without prefix false positives; dynamically resolved native command provenance; admission/deferred-commit/retry behavior; full-window verbatim preservation versus recent-tail survival; secret redaction and finite budgets. No assumption about what a provider may infer from conflicting package fields substitutes for correct fields.

## Current verification evidence — 2026-10-18

The implementation evidence is retained in `_scratch/changed-plans-queue-2026-10-18/compaction-path-fix/`: immutable pre-edit failure receipts, corrected real-path probes before permanent test updates, focused tests, source/config fingerprints and exact owned diff. Initial fixture typing failures in the path-request work remain recorded; the final typed fixtures and both final TypeScript checks pass.

Shared current-source canonical verification is retained in `_scratch/changed-plans-queue-2026-10-18/acceptance-corrections-verification/`. `checks.json` records both TypeScript checks, lint, LOC, main build, renderer build and full quiet suite with actual exit zero and no source drift. `full-summary.json` plus `child-exits.jsonl` independently records the actual Vitest child exit zero, no signal, no failing tests and stable source. Full runner logs and structured results remain in `_scratch/test-run.phase0-corrections-full.log` and `_scratch/test-results.phase0-corrections-full.json`.

At that checkpoint these results did not close this plan; the independent correction reviewer was still running its own isolated verification. The later as-built closure below supersedes only that pending gate status. The original broad Phase 0 acceptance audit and the remaining batch continuation remain separate, outstanding work.

## As-built closure — 18 October 2026

Compaction classifies actual command provenance and exact legacy built-in names/aliases while preserving unknown slash/path requests. Resolved dynamic native commands carry provenance at their existing dispatch boundary; admission, retry and deferred history behavior retain their original flow.

Fresh independent completion review: [final narrow report](../../_scratch/changed-plans-queue-2026-10-18/corrections-fresh-gate/FINAL-REPORT.md), `VERDICT: PASS`, no unresolved actionable finding within the exact six-file correction scope. The reviewer independently replayed original failing bytes and corrected controls, ran focused tests and all seven canonical checks with the report's explicit split-context proof. The final canonical full's actual Vitest child exited zero without a signal; structured results have zero failed tests and exactly the existing seven pending cases, with the complete status multiset matching the normal root run. Source/config, index, additional assets and all clean-installed dependency entries remained stable.

Root read the full final report, actual child events, final canonical receipt and final assessment, then independently rehashed all six owned source files and 128 sealed evidence artifacts with no mismatch. Exact receipt: `corrections-fresh-gate/parent-independent-final-seal-check.json`. Earlier verifier install/context failures, vacuous snapshot LOC and interrupted unknown-status full remain explicitly recorded rather than converted to success.

This closes this follow-up only. The original whole-Phase-0 audit and original batch continuation remain open, with separate newly investigated caller/ownership leads. No real-provider incidence, installed-app delivery, app installation/restart, original-plan acceptance, manual integration, commit or push is claimed. The completed plan and source/test changes remain uncommitted.
