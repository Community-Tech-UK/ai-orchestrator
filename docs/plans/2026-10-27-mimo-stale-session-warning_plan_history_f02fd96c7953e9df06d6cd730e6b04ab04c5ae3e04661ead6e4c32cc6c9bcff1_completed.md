## Snapshot of 2026-10-27-mimo-stale-session-warning_history.md

# MiMo stale-session warning: round history

## 2026-11-10 (resume of paused queue item)

- Worktree was clean; the fix is already in the branch base (`retainLastKnownQuotaWindows` resolves `incoming.needsReauth ?? previous.needsReauth ?? false`, preserving the previous instruction when no new verdict arrives).
- `npm run test:quiet` on provider-quota-service.reauth-retention / .spec / .account-source: 3 files, 77 tests passed, exit 0.
- `npm run typecheck`: exit 0. `npm run lint`: exit 0.
- LT-782 register entry present in `docs/plans/livetest-remediation-register.md`.
- No code change was needed this round. Full suite, build gates and live SSO checks left to the verifier and the linked livetest.


runbook references to extending a closed July plan or using a standing Mac
fallback were not followed; current instructions control both.

Portable evidence (in the worktree until queue harvest):
[worker report](2026-10-27-mimo-stale-session-warning_receipts/2026-11-03/worker-report.json),
[commands and actual exits](2026-10-27-mimo-stale-session-warning_receipts/2026-11-03/command-receipts.jsonl),
[scoped independent review](2026-10-27-mimo-stale-session-warning_receipts/2026-11-03/independent-code-review.json).
The final cleanup receipt and verification seal sit beside these files. Both
this plan and the new livetest remain untracked in the root checkout; neither
was copied into the worktree or renamed. The queue coordinator owns closure.

Cleanup completed: disposable encrypted session/user data, generated build output
and raw scratch output were deleted after the pre-cleanup report/seal. Compressed
verbatim test logs, small recipes and receipts remain. Both test Electron PIDs
were confirmed exited. Pre-existing linked dependencies/caches and AIO's checkout
were preserved for the verifier. No runtime was left running. The final seal
covers the resulting files and root working documents; the pre-cleanup seal is
retained as historical evidence.


The shared retention helper now carries an unresolved authentication verdict and its original instruction through windowless transient failures. New service tests cover the provider-level and secondary-account lifecycle, explicit false clearing and cross-account isolation. Existing tests were neither weakened nor removed.

The rebuilt app reproduced LT-782 before the change, retained the warning on repeated cooldown failures afterwards, showed an older updated age, and completed the real Xiaomi SSO redirect/retry with the current saved login. The original encrypted saved-login file stayed unchanged; only the disposable profile persisted rotated cookies. See the owning live-test evidence run for exact observations and the disclosed renewal-budget reset between independent cases.

- [x] Reproduce and register LT-782.
- [x] Implement retention fix.
- [x] Verify fixed rejection, repeat Refresh, cached age, notification and real saved-SSO recovery in the live app.
- [x] Add and pass focused regression tests; all static gates and both builds pass.
- [x] Canonical gates and full suite passed with pinned Node and exact dependencies; earlier failed attempts and environment corrections remain recorded.
- [x] Fresh completion gate returned VERDICT: PASS without actionable findings.
- [x] Evidence sealed; stopped runtime, temporary dependencies/binary, generated build, private caches and raw test artifacts removed; original dependency links restored.

The queue coordinator owns commits, integration and document closure. The task explicitly forbids completed renames, so this follow-up remains at its active filename for coordinator handling.


