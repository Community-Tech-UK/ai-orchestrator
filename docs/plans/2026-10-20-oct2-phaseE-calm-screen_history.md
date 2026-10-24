# Phase E implementation evidence

Plan: [2026-10-20-oct2-phaseE-calm-screen_plan.md](2026-10-20-oct2-phaseE-calm-screen_plan.md).

## Execution contract and rulings

- Code belongs only to the supplied AIO checkout; root untracked plan/history stay at their original absolute paths. No standalone spec is linked: the approved plan and U1–U12 backlog sections are the requirements.
- Worker instruction overrides generic finishing/full-suite requirements: no commit, branch switch, stash, merge, worktree creation, full test suite or completion rename. The coordinator owns those operations and fresh independent acceptance.
- Ruling: existing Phase 3 receipt and other dependencies claimed by the plan are absent on this base. Inspect their runtime contracts, reuse compatible existing seams and record actual integration gaps; never silently import another branch or fabricate a prerequisite.
- Ruling: parallel CLI implementation agents use this checkout with explicit file ownership, no MCP/browser access, no commits or installs. They leave reports and command evidence in `_scratch/phasee-evidence/`. Parent reviews integration and runs combined gates.
- Shared interfaces: Step 2 emits `exitCode`, `isCheck`, `checkFailed` alongside transport-only `is_error` for Step 9 and loop failure detection. Steps 4/5 export shared name/status presentation for Step 6/7 and mobile. Step 9 owns output stream while Step 11 owns composer; Step 10 integrates after those edits finish.

## Checklist

- [x] Step 1: explicit routine audience and inspectable groups.
- [x] Step 2: command exit semantics and readers.
- [x] Step 3: shared error presenter and source integration.
- [x] Step 4: shared display names and quota presentation.
- [x] Step 5: shared status presenter including phone/widget source.
- [x] Step 6: actionable health indicators hidden when healthy.
- [x] Step 7: all small copy changes and context-price tick.
- [x] Step 8: browser card and shared approval scope wording.
- [x] Step 9: per-turn summary, git comparison and failed-edit warnings.
- [x] Step 10: failure card and safe continuation.
- [x] Step 11: composer question answers and receipts.
- [x] Step 12: seven-day usage causes and actions.
- [x] Focused tests and required static/build checks.
- [ ] Independent verifier PASS (coordinator).

## Evidence

Initial checkout `git status --short` was empty. Supplied `node_modules` pre-exists and is not worker-created. Root plan is active and must not be renamed by this worker.

### Parent integration evidence

- Error presenter RED: missing module; then a real naming mismatch (MiMo account vs OpenCode process concurrency). Corrected the concurrency case to name the process while account failures use MiMo. Presenter/failed-turn/queue batch: 28 tests green; source logs in `_scratch/phasee-evidence/presenter-failure-queue.green.log`.
- `turnErrored` transport RED: the normalized complete event lacked the field. Added optional validated contract and bridge projection. Two tests green in `turn-failure-transport.green.log`. Existing normalized event forwarding already sends complete events to renderer, so no extra parallel IPC channel is needed.
- Held-message RED: 4 assertions reproduced internal jargon and missing runtime countdown. Replaced with plain wait sentences and actual retry deadlines. Four formatter tests green. Queue UI uses a one-second timer only while waiting; after two minutes offers keep waiting or the existing cancel-and-restore action. Seven queue UI tests green in `held-queue-ui.log`. The owning detail component's `restoreQueuedMessageToComposer` preserves text and attached files.
- Raw-error source ratchet: baseline generated from `HEAD`, never the edited tree, and keyed by source fingerprint rather than line number. New direct `${error}` or error `.message` sites fail. Diagnostic logger calls are excluded. Three tests green in `visible-errors.green.log`; baseline can be pruned but never raised to accommodate new copy.
- Interrupted continuation: explicit validated `continueInterrupted` flag, existing IPC domain and normal main send path. Main supplies saved original request and UTF-8-safe last 8192 bytes of partial output through a dedicated one-shot interrupted-context slot alongside the existing continuity queue; visible input remains only the safe continuation. Seven focused context/dispatch tests green in `continuation.green.log`.
- Ruling: preserve a bounded partial-output context for every user-requested interrupted continuation, rather than guessing which provider/version retains a cancelled turn. The original request stays exact; partial output alone is capped at 8 KiB. This costs at most that partial-output suffix plus the saved request on a manual Continue, and avoids missing context for a provider that drops a cancelled turn. No context is attached to ordinary sends.
- Interrupted UI: three tests initially green. A new regression reproduced a disabled Continue on the second interruption of the same session; the component now resets its send receipt once work resumes. Current result is recorded in `interrupted-repeat.green.log`.

- Integration review found that the existing continuity setter replaces a pending replay/compaction preamble. The manual continuation now has its own queue slot, merged at the existing prepare/commit boundary, with generation ownership and normal session cleanup. RED reproduced missing context and lost newer context; 10 focused tests green in `continuation-existing-context.green.log`. This avoids editing the two size-constrained manager files for another public API.
- Active-turn guard: a question in a newer active turn must never expose interrupted Continue based on the previous outcome. RED reproduced the extra button; renderer and main guard now reject an active `activeTurnId`. Nine UI/dispatch tests green in `interrupted-active-turn.green.log`.
- Failed-turn generation guard: unversioned main-process user input belongs to the current generation, not generation zero. RED reproduced a stuck old failure; nine tracker/card tests green in `unversioned-failure.green.log`.
- Automatic retry: the actual working-row component reads `waitReason.retryAt`, counts down every second, and is mounted for backoff even without queued input. Four activity tests green in `activity-retry.green.log`; no transcript retry spam added.

### Integration checklist closed before handoff

- [x] Mount RunFailureNoticeComponent and EventErrorDetailsComponent in output stream after the turn-summary owner finishes; initialise RunFailureStateService at app startup after the health owner finishes.
- [x] Mount InterruptedContinuationComponent for an empty, attachment-free composer; pass waitReason to ComposerQueueComponent; replace the provider-specific compaction hint using shared names after the question owner finishes.
- [x] Fix two raw error sites caught in usage-insight.controller.ts by the new ratchet; never increase the baseline. Review overlapping refresh/poll response ordering.
- [x] Integrate usage-advice tooltip exports into context ring, effort and helper controls after their owners finish.
- [x] Check all 17 name-map migrations/guard exceptions, including input/output modules excluded from the names agent ownership.
- [x] Check explicit default system audience at main transport; unflagged attention must stay visible.
- [x] Run actual mobile status specs: root Vitest currently does not include apps/, despite the old plan claim. Use a focused mobile config if necessary; record Swift/widget source validation separately from device build.
- [x] Browser follow-up: carry actual reason/computer data through request persistence where supplied, use computerName, unify browser bar/page scope wording and rerun targeted suites. Browser once is already consumed per mutation; CLI once remains Phase A separately owned prerequisite.
- [x] Combined no-cache focused tests, typechecks, lint, size, main/renderer builds, IPC/alias generators and relevant contract/export checks. Then own fresh review, reports/seal/receipts and cleanup of worker-created compile output only. No full suite or completion rename.

### Second integration pass (21 October)

- Read each first-pass report and treated disclosed ownership gaps as implementation work. Extended the existing workers to cover complete runtime paths rather than leave helpers unmounted. No new approval or branch was needed.
- Names ruling: Ready and Stopping are truthful additions to the eight suggested labels. Generic OpenCode sessions must remain OpenCode; only account/model evidence permits MiMo. Tool/config names use a separate shared accessor. Removed map migrations are not allowed an ownership-based guard exception.
- Reproduced and fixed explicit Continue bypassing quota/auth/backoff waits: renderer and main now reject all current wait reasons, with 31 focused tests green (`continue-wait-guards.green.log`). Fixed the one-second concurrency plural in the same batch.
- Reproduced and fixed failure-card retry over a newer active question: three component tests green (`retry-active-turn.green.log`). Classified process crashes now reach failure state without showing numeric exit codes in the headline: nine tracker tests green (`failure-process-exit.green.log`).
- Reproduced interrupted context surviving a rejected continuation and attaching to later ordinary input. Dispatch now discards only its own pending generation on rejection; it cannot discard a newer continuation. Twelve context/dispatch tests green (`continuation-rejected-send.green.log`).
- Usage review found a rounded-threshold bug (9.5% shown as 10%), two raw diagnostic paths, same-scope request ordering, and an absent session mount. Assigned correction plus visible measurement/coverage qualifications. Tooltips are being wired through the shared sentence exports.
- Turn-note review found an asynchronous baseline race, delayed/repeated end snapshots, repository filter execution and unsafe global temporary-folder scavenging. Assigned runtime barrier/snapshot-safety fixes plus the actual Claude outcome transport, review-panel binding, failure/Details mounts and four-total-segment cap. These remain implementation items until evidence is recorded.

- Browser integration review reproduced unknown failure codes/IPC diagnostics as visible text and an unhandled background refresh rejection. Kept a closed diagnostic disclosure, used fixed failure sentences, preserved unknown saved-login errors under Details, and made scope changes clear stale cards before reloading. Five focused files / 164 tests passed without cache (`browser-error-integration-green.log`, receipt in `_commands.jsonl`). Replaced conventional password fixtures with obvious `PLACEHOLDER` values. Scope, saved-login duration and typed-phrase tests still pass.
- Preliminary integrated main TypeScript check passed (`typecheck.integration-1.log`, actual exit 0). This is not the final gate: worker follow-ups are still changing the tree. Final command runner records the real exit code and a SHA-256 of every retained log; no pipeline/tail output is used as success evidence.

- Follow-up async review reproduced acknowledgements arriving after resumed work and after a later interruption. Continue receipts are now scoped to the captured idempotency key; failure-card retry locks are cleared only by their owning notice. Four failure-card tests green (`failure-late-ack-green.log`); Continue's combined state/order/session tests are being rerun after fixing an Angular effect short-circuit dependency caught by the new cases. Earlier failed outputs remain in receipts.
- Electron integration build failed at `instance-provider-limit-handler.ts:655` (`opts` possibly undefined). This is a real build failure, not a passed gate; the optional access must be corrected before final builds. Root TypeScript and Electron compilation cover different programs.
- Source trace found a load-bearing renderer projection gap: main clears `activeTurnId` on settlement, while single/batch renderer updates preserve the old value with `??`. Assigned a ninth, narrowly scoped integration worker to reproduce real store update paths and correct turn settlement without touching question lifecycle or main dispatch ownership. A stale renderer turn id would otherwise disable the new continuation controls after real turns.

- Continue/Retry question race: question registration now has a reactive presence check, so a question can suppress continuation before a status packet arrives. The registry also scopes in-flight replies by session plus provider request id. RED reproduced both the bypass and cross-session false-busy response; 33 tests in four files pass without cache (`continuation-question-session-green.log`).
- Idempotency-key reuse after switching sessions was reproduced and fixed. The combined Continue suite caught a short-circuit in an Angular effect that failed to subscribe to state changes; after reading the computed unconditionally, all 11 then-current cases passed (`continue-session-key-green-2.log`). The later question cases are included in the 33-test batch.
- Preload instance domain crossed the 700-line hard cap as continuation and receipt fields met. Reused the existing `InstanceSendInputPayload` contract for scalar fields, retaining its existing unknown attachment boundary. No runtime behavior or authorization changed; file is 698 lines, without raising its limit.
- Preliminary diff forensics: no manifest/lockfile or test/compiler/lint config changes; no newly skipped/only/todo tests; no existing test has fewer `expect()` assertions; no new production file above 700 lines. One narrow no-control-regex suppression in the turn tool-text cleaner is for deliberately replacing control characters in diagnostic text, not bypassing a type/test failure. Final scan follows once workers stop.

### Provider-limit interruption and continued implementation

- Claude implementation contexts ended with `usage_limit_reached` / HTTP429 and an account monthly spend-limit message. This was a provider error, not a permission denial. No account limit, credential, login or provider configuration was changed.
- Continued using the already-installed, working Codex CLI against the same supplied checkout. Six scopes cover backend/notices, names/status/settlement, questions/receipts, turn notes/snapshots, usage and health/copy. They read the existing reports and partial code before changing it. This is implementation continuation, not the coordinator's independent verifier.
- Browser final cleanup is parent-owned: moved closed failure wording into core rules and retained the feature re-export. Ordinary permission-bar IPC/reason/transport errors now have plain copy and closed Details, with no scope or phrase-rule change. Four files /133 tests passed without cache (`browser-bar-errors-green.log`). All three unnecessary file-size ceiling increases were removed; `scripts/check-ts-max-loc.ts` is identical to HEAD.
- Mobile dependency baseline was only four `.vite` cache entries, no install. Ran exact lockfile `npm ci --prefix apps/mobile --workspaces=false --ignore-scripts --no-audit --no-fund` locally: 442 packages installed, actual exit0 receipt retained. Manifest and lockfile stayed unchanged. This worker-created mobile install and resulting build/cache output will be removed after verification; supplied root dependencies remain untouched.

## Current worker handoff, 21 October 2026

Status: ready for independent verification; implementation source complete, acceptance pending. No commit, staging, stash, branch/worktree change, integration or completion rename. The coordinator owns the full suite and genuinely fresh `task-completion-gate` review. This implementer review is not a substitute or a PASS verdict.

All twelve source items are checked above. The plan’s as-built table maps each to the actual result. Current scoped reports under the supplied worktree’s `_scratch/phasee-evidence/` are `backend-final.md`, `names-final.md`, `health-final.md`, `browser.md` plus parent integration receipts, `turn-final.md`, `questions-final.md`, `usage-final.md`, `wording-final.md` and `computer-surfaces-final.md`. Earlier provisional reports are historical; the current reports and final parent receipts supersede their disclosed implementation gaps.

### Final integration corrections and review

- Closed all source ownership handoffs. Both failure/Details and continuation controls are mounted; failure tracking starts at root construction. Usage explanations are mounted on Costs and the actual session disclosure; shared advice is consumed by context, effort and helper controls.
- Real single/batch/IPC queue tests reproduced stale active-turn IDs. The fix covers main coalescing, renderer coalescing and both store projections, with lifecycle-generation guards. All 31 cross-process cases now live in the existing `src/tests/renderer-integration/instance-turn-settlement.spec.ts` suite; no architecture/test-config exemption was added.
- Electron compilation caught `opts` possibly undefined; corrected optional access and exercised the absent-options path. Later compiler runs caught ES2023-only array methods under ES2022 and incomplete return paths. Replaced them with bounded reverse searches/explicit returns; preserved runtime behavior and test intent. The test adapter’s cast is confined to its structural test-double boundary.
- Turn snapshots no longer run configured filters, fsmonitor, hooks, textconv or external diffs, mutate the real index/object store, scavenge unknown temp folders, miss fast initial edits or extend completed turns. Real fixtures verify raw tracked/untracked/ignored/binary changes and unchanged `.git` bytes/mtimes, including split indexes. Compression is asynchronous. Unsupported/slow/remote/uncertain captures truthfully return no count.
- Own review reproduced five false failed-edit recoveries from quoted redirections, comments and no-clobber copies; RED had five failures, then the five-file warning/UI batch passed 186 tests. The turn owner also covered help/version and shell-escape cases. A pending or cancelled write cannot clear a warning.
- The broad renderer run exposed an unimplemented Workboard stale-request assertion. The actual card now retires only its own closed request and preserves a replacement when an old acknowledgement arrives. Two failures reproduced before the fix; 36 Workboard tests pass afterwards. The final 102-file renderer/integration run passes all 1,826 tests. The narrow IPC error shape is respected by a runtime code-property guard; no type suppression or broad contract change.
- Raw-error guard covers renderer copy and main-process transcript sinks, permits diagnostic fields/logs and parses escaped/commented expressions. Baselines came from HEAD only, then decreased (renderer 653 to 648 occurrences; main 7 to 6). Cheap syntax filters removed a source-scan timeout without raising any test timeout or debt budget.
- Final source forensics: no new skipped/only/todo tests, type suppressions, existing-test assertion-count drops, oversized untracked production files, staged paths or secret-shaped additions. LOC policy is byte-identical to HEAD. The only compiler/test configuration change is the mobile app’s contracts path aliases needed to import the real shared presenter; no strictness or test coverage was weakened. Source inventory: `final-source-forensics.json`.
- Browser review retained scope/phrase/credential constraints, persisted supplied reasons separately from untrusted page context, and uses actual computer routing. Unknown/IPC/transport diagnostics on both browser approval surfaces stay behind closed Details. Migration 078 is additive; its persistence tests ran in the main batch. No live credential, purchase or destructive action was performed.
- Bounded real local transcript inspection recorded field/count/shape data only: 5 files, 16.55 MB, 5,314 complete lines, 617 deduplicated requests, 4 sessions. No transcript content, arguments, private paths, identities or secret values were emitted. Usage shares are local API-price proxies, with overlapping estimates and explicit missing-effort/coverage notes.

### Final verification results

Every command receipt records argv, cwd, environment, actual exit status, duration, full log path and SHA-256. Tests disable the result cache and model failure summaries; explicit spec-file lists are required. All command-log hashes were checked. Failed RED, preliminary build/type and first renderer/architecture attempts remain retained and are not presented as successes.

| Check | Latest result / receipt label |
|---|---|
| Main changed-spec batch | 102 files / 2,093 tests, exit 0; `changed-main-specs-integration` |
| Additional changed voice spec | 1 file / 10 tests, exit 0; `remaining-voice-spec-final` |
| Renderer/integration changed-spec batch | 102 files / 1,826 tests, exit 0; `renderer-post-review` |
| Shared/contracts/preload/guard changed-spec batch | 26 files / 697 tests, exit 0; `shared-contract-specs-final` |
| Mobile changed-spec batch, actual package runner | 8 files / 170 tests, exit 0; `changed-mobile-specs-final` |
| Compiled provider/cost seams | 3 files / 45 tests, exit 0; `compiled-provider-cost-seams` |
| TypeScript | exit 0; `workboard-final-types` |
| Spec TypeScript, documented 8 GiB script | exit 0; `spec-types-closed-request-final` |
| Full lint / fast lint | exit 0; `lint-closed-request-final`, `fast-lint-post-review` |
| LOC | exit 0; `loc-post-review`; supplemental untracked-production scan also passes |
| Electron/main build and asset/preload sync | exit 0; `build-main-final`; later changes are renderer-only or tests excluded by the unchanged Electron config |
| Angular production build | exit 0; `renderer-build-closed-request-final`; nonblocking initial-bundle warning: 1.37 MB against 1 MB warning budget |
| Mobile TypeScript / lint / build | all exit 0; `mobile-typecheck-final`, `mobile-lint-final`, `mobile-build-final` |
| Swift | source parse exit 0 in `names-swift-parse.log`; no signed ActivityKit/device-build claim |
| Alias / IPC / architecture generators | exit 0; `aliases-final`, `ipc-generate-final`, `architecture-generate-post-review` |
| IPC coverage/use, exports and contracts | all exit 0; `ipc-verify-final`, `ipc-usage-final`, `exports-final`, `contracts-final` |
| Architecture/import/cwd/inventory | exit 0; `architecture-verify-post-review` |
| Extra renderer-event inventory audit | exit 1, pre-existing baseline; details below |
| Full suite / independent PASS | not run / pending coordinator; deliberately not self-certified |

### Additional baseline audit finding

`verify:renderer-events` reports three unregistered static channels (`instance:transcript-chunk`, `local-ai-guard:status-delta`, `plan-queue:state-changed`) and two unresolved dynamic sites (`cost-handlers.ts`, `cross-model-review-event-forwarding.ts`). The checker, registry and all five reported send-site files are byte-for-byte unchanged from HEAD; hashes are in `renderer-event-inventory-baseline.json`. This extra audit is not one of the required worker gates and its inherited findings are not hidden, suppressed or reclassified as live testing.

### Dependency and live boundaries

The linked `_livetest.md` contains only actual deployed/native-provider/browser/device checks, including optional widget payload fallback and suspended-app APNs delivery. No Windows health/preflight was attempted and no claim of Windows availability is made. No Mac browser/desktop was used. CLI once-consumption belongs to separately owned Phase A; real big-tool cap controls belong to Phase D. This worker did not merge another phase or invent those controls.

### Evidence and cleanup

The history is the retained report. The root `_seal.json` pins source/tests/generated output, this plan/history/livetest, command receipts and scoped reports. The root `_commands.jsonl` retains successful and failed attempts. Cleanup is the last action after those artifacts are written; its receipt records removed owned runtime and protected dependencies/cache/scratch. No completed-name document is created by this worker.

Cleanup result: 13 owned runtime paths removed after report/seal creation, including `dist`, the mobile install/build, the Swift/probe binaries, tiny git fixture, copied source snapshots and temporary compiler/helper inputs. `_cleanup.json` and `cleanup-runtime-final` record actual exit 0, no remaining owned runtime, unchanged root dependency-entry/symlink identity, unchanged unrelated scratch, unchanged supplied branch/HEAD, empty staging and zero mismatches across all 571 sealed source/generated/test paths. Helper/config inputs remain only as inert receipt data. Rebuild main before rerunning compiled-provider tests; mobile reproduction starts with the exact recorded lockfile install.
