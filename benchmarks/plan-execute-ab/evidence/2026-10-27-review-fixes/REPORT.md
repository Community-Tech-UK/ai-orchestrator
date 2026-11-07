# Local-model pilot verifier corrections, 27 October 2026

**Status: incomplete pilot; no completion claim or document rename.** Six reporting findings
are corrected (2–7); finding 1 remains technically incomplete and finding 8 remains blocked by
automatic approval review. This is a correction report, not a final subscription recommendation.
The canonical live-test document remains only at the root-checkout absolute path given by the
queue task. Its current status and final dated section supersede earlier operational headlines.

## Findings and actual disposition

| Finding | Current evidence and disposition |
| --- | --- |
| 1. Open campaign checks | **Still incomplete.** A5's ten B cells, sound scores for the later C1/C2 cells, final A8 report and finishing are not passed. A4's second-turn cache criterion was reproduced unmet again. Optional A2 tuning remains unrun. Hosted sharing/full spend remain unauthorized, prompt skim optional, BIOS condition unestablished. The final live-test section lists every check without treating a disposition as a pass. |
| 2. Colliding IDs | **Corrected.** Scanned all local branch registers and live-worktree registers, including uncommitted root state. Maximum prior ID 999. Campaign labels LT-709–LT-712 are LT-1000–LT-1003; missing-record loss is LT-1004. Canonical register, follow-up and live-test links use corrected IDs. Historical raw receipts preserve original labels with this explicit mapping. `id-reservation.receipt.json` records the scan. |
| 3. Missing records unfiled | **Corrected registration, recovery still open.** LT-1004 has index/detail/acceptance and matching follow-up status. A bounded search found no original eight later C1 or ten C2 full records/patches. `raw-recovery.receipt.json` preserves sources, queries, hashes and selected original rows, with limits in `raw-recovery.md`. No synthetic records or patch reconstruction. |
| 4. Wrong cleanup reference | **Corrected.** Canonical live-test references to the cleanup-flake fix point to LT-707; no dangling LT-708 reference remains there. |
| 5. Historical C1 interpretation | **Corrected with stronger provenance.** The 0/10 printed aggregate is unvalidated historical scoring, not ten demonstrated model failures. The rich AIO-01 loader-crash receipt is the earlier quarantined 154057 ms / 13-turn attempt, removed before the later 60-minute / 9-turn rerun. It cannot establish a loader crash in that later cell. Later full scoring output is missing. |
| 6. Stale status/key requirement | **Corrected.** New leading 27 October status and current secure-route paragraph explain prior placeholder reuse and its limits. No new secret handoff is claimed necessary for eligible local work. No private credential was provisioned or disclosed. |
| 7. LAN proof overstated | **Corrected.** Mac 'No route to host' establishes only missing Mac-to-LAN connectivity. Server-side complete listener inventory establishes private binding; neither is mislabelled a successful LAN port-closure probe. The original `lan-proof.json` remains unchanged. |
| 8. Remote files retained | **Still blocked.** A guarded exact-file deletion was rejected again before execution: `rejected: blocked by policy`. Eight files totaling 13399 bytes remain in the already recorded Windows scratch directory. No alternate deletion method was used. Full response and retained filenames/sizes are in `remote-cleanup.receipt.json`. |

## New bounded checks

The recovered benchmark source is unchanged from checkpoint `9cc19c6d6`; the source seal
identifies it for recovery after runtime removal. Its focused suite passes 182 tests. Current
main and production-renderer builds pass. An isolated app was launched from this worktree with
the prescribed profile and port 9800. Focus emulation preceded DOM assertions: hidden false,
visibility visible, app-root present, real listInstances IPC success with an empty list.
Optional visibility override is unsupported by this Chromium build. The fresh launch succeeded;
that does not disprove or fix the earlier migration race. Shutdown logged all eight cleanup
phases but the app process did not exit inside the supervisor's 15-second grace period and was
force-stopped. `dev-app.receipt.json` records that limitation; no graceful-exit claim is made.

The scoring investigation confirmed the old test's ten microtask drains cannot establish that
the backup's real directory I/O has advanced. An additions-only diagnostic V2 amendment now
waits for positive ordering evidence while holding the actual startup write. It fails for the
intended ordering assertion on both parent repeats, passes the fixed version twice, and rejects
a meaningless promise-delay mutation even when all forty original assertions pass. Original
tests and results remain intact. `scoring-control/REPORT.md` contains the exact reproduction,
pinning, dependency limitations, patch, command receipts, source seals and owned-runtime cleanup.
This demonstrates the control only: it does not integrate a revised scoring contract into the
runner, provide a clean historical dependency graph, or rescore any archived model patch.

Native 2.60.0 was temporarily started without creating remote files, using the same 35B,
65536 context, parallel 1, batch/ubatch 4096, 12 threads and private listener. Windows and Mac
both returned 401/401/200 for absent/wrong/configured key. The local-only three-tool smoke
passed again in four turns with zero tool errors; answer bytes and independent npm test pass.
First/second requests again have zero cache reads. Third/fourth have 17146/17290. Hash-only
request observation shows one normalized system block changes between requests one/two,
then remains stable; other system blocks and the tool-schema hash are unchanged. This is
correlated prefix evidence, not an isolated causal experiment or a second-turn timing pass.
No protocol was relaxed and A4 remains open. `cache-retest.receipt.json` retains the readbacks.

No new paid benchmark, judge, planner, hosted-provider, full-run or BIOS action was invoked.
Remote diagnostic agents used the normal worker provider; no zero-cloud-token claim is made.
The earlier retained metered total remains $66.278098505 with its historical invoice/recovery
limitations, not a fresh invoice reconciliation.

## Verification limits and cleanup

The full repository suite was not started on this correction run. Measured shared-machine load
rose from 61 to 257 (later 129), above the runbook's threshold of 30. The earlier full-suite
exit 143 remains a failure to complete, not a pass. No production application, runner or task-bank
source was changed here; new tests are diagnostic evidence patches only. This run makes no new
root/spec-typecheck or lint claim. Prior static receipts remain historical evidence.

The final cleanup receipt records local source/runtime/cache removal after this report and
source seal, owned process/port checks, helper/routing restoration and remote-agent termination.
Only evidence, seals and command receipts are retained. Pre-existing dependencies, original
models, key file, historical mirror and AIO-managed worktrees are preserved. Remote cleanup of
the eight old files remains explicitly blocked as above. No commits, staging, stashing, branch
changes, worktree creation or completion renames were performed.

Restoration detail: LM Studio itself replaced one temporary chat-template file while reloading
the normal helper. That active helper file is preserved as restored application state; it is not
a benchmark export/install or an extra diagnostic file. The restoration receipt lists the exact
change. No zero-new-files claim is made for LM Studio's internal runtime.

Fresh independent review is retained as `independent-review.md`: **VERDICT: FAIL for the
original campaign**, no new actionable findings in corrections 2–7. It checked original-row,
source and diagnostic-patch hashes and local cleanup, but did not rerun the full repository
gate. Findings 1 and 8 remain unresolved. No coordinator completion approval is inferred.
