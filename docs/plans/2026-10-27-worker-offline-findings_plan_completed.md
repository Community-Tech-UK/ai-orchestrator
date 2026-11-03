# Worker offline live-test findings — implementation follow-up

Status: worker implementation ready for independent queue verification, 3 November 2026.
This is an untracked root-checkout plan. Keep it uncommitted and do not rename it in the worker.
No separate spec exists; this plan and the originating evidence run define acceptance.

Origin: [worker-offline live test](2026-09-22-worker-offline-resilience_livetest.md#evidence-run--2026-10-27-plan-queue-isolated-dev-app-and-read-only-windows-report).
Register: [LT-710](livetest-remediation-register.md#lt-710), [LT-711](livetest-remediation-register.md#lt-711).
The referenced register sections and original evidence directory are absent from both the
current root checkout and this queue checkout. Their observations and executing paths survive
in the linked origin's 27 October evidence run; implementation used that source and reproduced
the remaining contract rejection. No missing spec or register text was guessed.
Current worker evidence: `docs/evidence/worker-offline-followup-2026-11-03/` in
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-worker-offline-find-26fd34`.
The coordinator must carry this new bundle with the code; it does not recreate the missing old bundle.

The July remediation plan is already `_completed`; it is preserved. This active follow-up
provides the matching implementation-status sections required by the campaign runbook, following
the register's existing later-defect precedent. This document does not authorize rollout,
Tailscale interruption, Windows sign-in-policy changes, or a Windows Update restart.

## LT-710

Implementation status: already implemented in the supplied base, rechecked
by this worker on 3 November. `runMigrations()` takes `BEGIN IMMEDIATE` before discovering
applied/pending migrations, then validates checksums and applies/records changes in the same
transaction. The existing deterministic two-process/two-connection regression passes, as do
rollback, checksum-mismatch and full-database error regressions. No duplicate implementation
was added. A compiled Electron utility context worker reached `ready` and answered `list-stores`
while main opened the same fresh-profile database; all 75 migrations were unique and none pending.

- [x] Record observed failure, executing path, root cause and retained reproduction.
- [x] Serialize migration-state discovery and application correctly; retain checksum validation.
- [x] Add the controlled two-connection regression and verify fresh-profile worker readiness.
- [ ] Run canonical gates and a fresh independent completion review before closing the fix.

## LT-711

Implementation status: shared contract fixed in the worktree; both-view transport verification passed.
The direct baseline probe rejected all four supported route states. The strict `coordinator-route`
variant now accepts `running|stopped|absent|unknown`; missing, invalid, null, numeric and extra-field
payloads remain rejected. Regression tests cover watcher-to-event-bus-to-Electron-transport
delivery, deduplication of unchanged polls and rejection before webContents send.

- [x] Record the dropped event, source wiring, stale DOM and current roster response.
- [x] Add the route-state variant to the existing shared event contract, with invalid-state rejection.
- [x] Verify automatic appearance and removal of hints in both open node views through real transport.
- [ ] Run canonical gates and a fresh independent completion review before closing the fix.

## Worker verification — 3 November 2026

Passed: focused tests (5 files, 28 tests), `npx tsc --noEmit`, `npm run typecheck:spec`,
`npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
`npm run build:renderer`, alias/IPC generation and contracts-alias validation. Generators
produced no tracked drift. Renderer build retains the existing initial-bundle budget warning.
The compiled worker probe emitted an environment sandbox-extension warning but reached readiness
and answered its request successfully; no migration error was observed.

The offscreen Electron fixture mounted both actual parent views and child templates, using the
production event bus, validating Electron transport, full preload, renderer IPC services and
roster builder. With a paired worker kept disconnected, the actual hint elements changed
absent → present → absent in both views; the same parent elements remained mounted and roster
requests rose 2 → 4 → 6. The previous-schema control left both views stale even though main's
roster had the hint. Runtime source, outputs, screenshots and receipts are retained in the bundle.
This deterministic fixture used synthetic route probes/settings/paired-node dependencies and
read-only IPC registration, Angular JIT templates and omitted external SCSS. The host denied
Chromium child sandbox initialization, so the hidden test used `--no-sandbox`; this does not
verify production sandbox enforcement or full-app startup. No live network was interrupted.

A fresh agent used `task-completion-gate`, traced the executing path, reran focused tests,
typecheck and lint independently, inspected the exact runtime fixtures/results and verified
their hashes. It returned `VERDICT: PASS` for worker readiness with no actionable findings.
It explicitly did not certify the full-suite/clean-state coordinator gate. See `fresh-review.md`.

The full suite is intentionally not run by this worker, per the current Plan Queue instruction.
The two canonical/fresh-completion checkboxes remain open for the coordinator's final verifier.
No document is renamed or staged, no commit is created, and no branch/worktree lifecycle action
is performed by this worker. Compiled output and disposable runtime/profile files are removed
after the report, source seal and receipts; dependencies and small evidence remain for verification.

## Remaining original acceptance

The original check 1 is superseded/transferred to the worker-auto-update live-test owner;
its maintenance and rollout checks remain distinct. Check 2 retains its prior PASS with current
corroboration. The actual Tailscale outage and visible macOS banner, elevated Windows sign-in-policy
application and genuine Windows Update restart remain untested. Those are not silently replaced
by the isolated runtime observations. The owning live-test document remains open and the
coordinator owns any final rename after independent verification.
