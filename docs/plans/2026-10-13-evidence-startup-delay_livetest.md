# Evidence startup delay: packaged window validation

Status: packaged-window checks pending. Implementation, all agent-runnable gates and genuinely fresh independent review passed on 13 October 2026. No actual packaged launch or installed-app activation is claimed.

Plan: [implementation plan](2026-10-13-evidence-startup-delay_plan_completed.md).

Prerequisites: current verified complete packaged build, an isolated synthetic profile seeded by `scripts/evidence-maintenance-fixture.ts` and the encrypted fixture procedure in `scripts/isolated-evidence-startup.ts`, and an authorized GUI route. No replacement or restart of James's running application is authorized by the implementation request. Browser/UI control must use Browser Gateway health/channel preflight and explicitly target `windows-pc`. A headed Mac launch needs James's task-specific approval; Harness Computer Use remains hard-denied.

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before running this campaign. Record any newly reproduced defect in [livetest-remediation-register.md](livetest-remediation-register.md). The historical remediation implementation plan is closed; create a dated follow-up plan or reopen it before adding implementation status. Never add requirements to a `_completed` document. Keep dated per-check evidence in this file.

## 1. Three actual packaged launches

- [ ] Build/package the complete app through the normal pipeline. Record executable/build identity and host; do not replace individual installed files.
- [ ] Use the smoke helper's `seedProfile` dependency on its newly created temporary profile, placing the database at `conversation-ledger/conversation-ledger.db`. Seed schema v6 with 400,000 placeholder records and 400,000 placeholder cards using the shared fixture helper; generate authentic encrypted referenced/prepared/stale-orphan blobs using the isolated storage fixture procedure. Use random fixture data keys wrapped by the target packaged platform's real `safeStorage`, through an authorized no-window seeding process on that host. The CLI harness's process-only fake wrapping key is unsuitable for a packaged launch and must not be copied into its keyring. Never copy James's real profile.
- [ ] Run one v6 upgrade launch with the self-quitting smoke flag through an authorized remote/headless packaged GUI environment. Preserve the post-window ready marker, elapsed time, stdout/stderr and logs. Confirm no degraded context-evidence warning or critical initialization failure appears. Expected: actual post-window readiness within 30 seconds, evidence encryption available.
- [ ] Using a retained isolated migrated profile on the same otherwise idle machine, run two further packaged launches and retain the same receipts. The helper's normal disposable-profile mode must not recreate a v6 database for these migrated runs. Expected: each actual post-window readiness marker within 30 seconds.
- [ ] Separately launch the same isolated build without self-quitting smoke mode. Observe the content-free maintenance start after window readiness plus five seconds, eventual finish and validated evidence operations while pending. Confirm existing referenced blobs and prepared recovery survive, only old orphans disappear, and shutdown prevents further scheduled destructive work. Repeat with an interrupted sweep and restart.

Why deferred: this checks actual Electron renderer/window loading and packaged startup, which cannot be established by the headless Node runtime used for the implementation checks. Opening a Mac window is currently unauthorized; no authorized packaged GUI route was used in this task. All CLI-verifiable populated metadata, native migration/query, capture/read, encrypted cleanup, cancellation and restart behavior has been exercised in the implementation loop and is not deferred.

## Evidence already available

- `_scratch/evidence-startup-delay/query/native/baseline.json`: original native traversal and plans.
- `_scratch/evidence-startup-delay/query/native/result.json`: current indexed native traversal and plans; reuse results identify migration repeat cost separately from fresh upgrade evidence.
- `_scratch/evidence-startup-delay/query/native/upgrade-migration.json`: fresh populated upgrade preservation/idempotence.
- `_scratch/evidence-startup-delay/query/worker-upgrade/result.json`: actual worker initial requests and interleaved latency with unchanged deadline.
- `_scratch/evidence-startup-delay/startup/startup-results.json`: authentic encrypted isolated-profile safety and headless evidence readiness; explicitly `packagedWindowVerified: false`.

All live checkboxes remain open. Rename this document `_livetest_completed.md` only after the actual checks above pass with evidence.

## Historical queue-worker report — 13 October 2026

The queue worker reported its supplied worktree as `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-13-evidence-startup-de-94a931`, base `02df9b4e2be4c6a00c0026c50184b2af8057f6d1`. Its 218 targeted tests, six non-suite canonical gates, native 400,000-record/400,000-card benchmark, authentic encrypted-profile harness and compiled production worker checks pass. That queue-worker handoff predates current-root completion; it is historical provenance, not current verification or queue-promotion evidence. The reported checkout was absent at final root verification.

Current queue receipts: `_scratch/evidence-startup-delay/query/native-j4srrL/result.json`, `_scratch/evidence-startup-delay/startup/startup-results.json`, and `_scratch/evidence-queue/native-worker-result.json`, all relative to that worktree. CLI evidence readiness was 453.629 ms for the v6 upgrade and 1.369 / 1.082 ms subsequently; restart maintenance completed in 23.278 seconds. The compiled worker's first read/stage including migration took 748.869 ms within the unchanged 10-second deadline. These are headless runtime checks; `packagedWindowVerified` remains false.

Read-only worker/channel preflight found `windows-pc` connected and Browser Gateway's remote channel fresh with commands deliverable. The queue checkout has no `release/` directory or unpacked executable. The remaining prerequisite is a complete verified packaged artifact and an authorized isolated launch route, with real platform `safeStorage` fixture wrapping as described above. The preflight does not authorize a Mac window, app replacement, installed-app restart or release. All live checkboxes remain open.


## Current verified implementation receipt

Fresh independent review: `_scratch/evidence-startup-delay/fresh-review-resumed/report.md` — VERDICT: PASS. Both typechecks, lint, LOC, both builds, the focused regressions and the corrected unfiltered full suite passed. Current native worker and encrypted-profile checks also passed. The report explicitly leaves actual packaged-window launches deferred. The completed plan's section 14 is the current implementation evidence authority; historical queue receipts above do not replace it.

All actual live checkboxes remain open. A complete packaged artifact, isolated fixture with real platform wrapping, and authorized launch route are still required. Do not replace/restart James's installed app or claim the three window-launch target from headless CLI results.
