## Snapshot of 2026-11-14-livetest-capability-repair_history.md

# Capability repair working evidence

Active, uncommitted working history. The plan Status block is the current summary; this records the first investigation and focused-check evidence, not a completion verdict.

## 14 November investigation and first implementation

- Both supplied screenshot files were viewed. Ten questions identified; all ten owning documents now have a narrow capability reassessment and retain their original acceptance checkboxes.
- Current Browser Gateway health showed both remote channels ready. `dev-app.js status` initially showed no remote copies.
- An owned test-Mac development app demonstrated real hardened Claude create/send/OK/terminate, zero tool use, empty-app pause transitions and actual Plan Queue page rendering after selecting the coordinator role. Exact-account, packaged, provider-limit, multi-account, expiry, sign-out, real-work restart and billing criteria were not proved. Durable evidence: [remote probe](2026-11-14-livetest-capability-repair_evidence/remote-probe.md), with linked safe receipts. Cleanup receipt records no copy, no tunnel, free port and removed profile.
- Detailed runtime provider detection found Claude installed; OpenCode and Codex were not detected in this app. Provider profile records are not installation/authentication proof.
- Readiness recheck regression reproduced before implementation. Implementer focused checks passed; primary-agent re-execution: `npm run test:quiet -- src/main/plan-queue/plan-queue-recheck-readiness.spec.ts`, exit 0, 30 tests, Windows PC, log `_scratch/test-run.pid-76656.log`. This is focused evidence only; final canonical gates and independent review remain outstanding.
- Task 1 source scope: recheck helper/spec, queue control schemas/MCP/CLI, coordinator helper call, state transition, triage batch invalidation and attempts reset, unanswered live-test memory reassessment; actual human answers/skips remain. Shared CLI docs contain unrelated session-reading edits that must be preserved.
- The fresh design review found and corrected omissions in the spec: capture from triage/worker/checker, repair links surviving report clearing, inherited account restrictions, bounded derived repair ownership/recovery, current remote-runtime evidence and per-check resolution. The full implementation is still in progress.
- Three implementation responsibilities currently run independently: queue repair service and persistence; account restriction preservation/start-run extraction; isolated packaged fixture and launcher receipts. Primary agent owns combined gates, independent final review and documentation reconciliation.
- Another session committed previously staged unrelated work during investigation. Current base observed as `11720ef18` (October updates). This task has made no commits, staged nothing and created no branch/worktree. Preserve unrelated ongoing transcript-reader, CLI-doc and snapshot-test changes.

## Design review artifact

The interactive artifact is `.aio-review/2026-11-14-livetest-capability-repair.html`, generated from the spec plus ten-case table using the unchanged repository review runtime. It was submitted through `request_doc_review` and remains optional feedback while authorised implementation continues. Re-render after final design changes; Markdown is authoritative. No local browser was opened.

## Current provider prerequisites

- Fresh connected-worker inventory reports OpenCode and Codex on Windows; the test Mac advertises Claude and Copilot. Worker advertisements establish available commands, not signed-in accounts or quota. The actual earlier isolated Mac app detector remains the stronger evidence for that app's own environment.
- Current read-only app settings show the original `comtechspare-f7a6` profile now labelled `ComTechMimo`, still enabled in Amsterdam with routed work allowed. Do not mistake the renamed label for a new account or substitute the other MiMo key.
- A freshly synced private Bitwarden inventory found a coding key matching the named OpenCode 1 credential by in-memory equality, and an existing Xiaomi website login. No secret values were output, retained, transferred or changed. The private vault copy and session were removed. [Safe evidence](2026-11-14-livetest-capability-repair_evidence/provider-credential-readiness.json).
- This establishes a provisioning route to investigate, not current authentication, quota, OpenCode 2 credential selection or a saved MiMo usage connection. The first usage read still needs its own actual process evidence.
- Documentation mismatch: `docs/DEVELOPMENT.md` names the old `opencode-ai` install, while current provider doctor/launcher code prefers supported OpenCode 2 via `@opencode/cli@2` and retains version 1 separately. Follow executable source and preserve the original version-1 acceptance case.

## Combined verification and packaged runtime

- `npm run checks` completed successfully on the Windows PC: both typechecks, lint, source-size and UI-hint checks, main build and renderer build. This snapshot preceded the final allocator changes.
- Full `npm run test:quiet` on that snapshot failed 26 of 48,239 tests; retained output `_scratch/test-run.pid-74229.log`. Failure groups: startup VM fixtures, prompt/schema budgets, queue role structural guard, pause/close ordering, state transition and migration inventories. Some corresponding source/test updates already exist after that snapshot; focused reproduction must establish what still fails. No completion claim follows from the earlier green builds.
- Signed packaged runtime evidence is in [packaged-runtime.md](2026-11-14-livetest-capability-repair_evidence/packaged-runtime.md): hardened Claude, busy pause with note, quit/relaunch persistence and exactly-once continuation. It explicitly retains the narrower UI/unfinished-work limits and owned cleanup receipts.
- Self-review found that original-check PASS could be accepted without each retrying capability origin having checker evidence for its current checkpoint. A coordinator-level reproduction and service guard are being implemented; this is distinct from merely leaving the capability record unresolved after landing.
- The expanded screenshot inventory is [the active follow-up](2026-11-14-expanded-livetest-blockers_plan.md). Atomic local/common-root reservations and parser repair passed focused checks; independent remote clones still lack a synchronous coordinator allocation route and must not be declared fixed by a prompt requesting one.

## Current verified snapshot and independent review

- Latest `npm run checks` passed all seven gates on the Windows PC in 2m 8s (session 15403). Full `npm run test:quiet` exited 0 in 8m 37s; retained log `_scratch/test-run.pid-24378.log`. The independent reviewer read its raw totals as 48,228 passing and 43 skipped tests, with 3,760 passing and one skipped file (the wrapper's aggregate summary differed). This includes the actual remote reservation report/response implementation and current original-check PASS guard.
- Earlier full-suite log `_scratch/test-run.pid-84746.log` had three failures. The remote worker timeout followed its old assertion rejecting absent `workerReport` as undefined instead of null, preventing the fake worker's idle event. The visible-error ratchet named a concurrently edited renderer site already corrected through `presentError`; focused ratchet passed. The operator fixture's destination `.git/objects` disappearance did not reproduce in its 36-test focused run (`_scratch/test-run.pid-88184.log`) or the latest full suite. No speculative retries or fixture changes were added.
- A separate session committed the core capability implementation as `9989efa1d`; root did not stage or commit. Independent review must cover that commit and current task diffs/untracked sources, not only HEAD-to-working-tree changes. The active spec/plans remain untracked.
- Provider setup and exact limits are recorded in [provider-setup.json](2026-11-14-livetest-capability-repair_evidence/provider-setup.json). Installed commands and provisioned credential are setup evidence, not original provider acceptance. Actual Community Tech Codex phone verification was escalated; no phone data was entered and no account policy changed.
- A fresh independent reviewer is checking the full implementation and unfinished acceptance; original live-test documents remain open. The next signed runtime campaign reuses the supported owned fixture route for the exact OpenCode account and project cases.

## Independent review recovery fixes

- [Fresh review](2026-11-14-livetest-capability-repair_review.md) returned FAIL for two reproduced defects: a blocking FIFO receipt open and interruption between resuming an original item and recording its retry state. It also preserves the unfinished original-check acceptance.
- Root reproduced the actual evidence reader hanging on a named pipe in a disposable child process: focused run `_scratch/test-run.pid-26187.log`, one failure of two checks. The fix rejects a non-regular final path before opening and uses nonblocking open to cover substitution after inspection, retaining descriptor identity/size/read checks. Regular-file, FIFO and actual regular-file-to-FIFO substitution checks plus service tests pass: `_scratch/test-run.pid-8294.log`, two files/21 tests on the test Mac. No child or temporary directory remains.
- Durable original-retry recovery is owned by a separate implementation agent. Final checks and another genuinely fresh review are required after all findings are fixed.
- Remote browser health again reports both channels fresh and deliverable. The existing Windows input-control document still requires a newer extension and retains an unresolved text-field attach fault; healthy transport is not a passing keyboard check. Test-Mac load is above the campaign threshold, so the exact packaged provider campaign is prepared but not running. No unrelated process was stopped to make room.
- Updated the campaign runbook's packaged-fixture and log-isolation guidance to the implemented owned runner and early profile setup. The old fake-home/keychain-link workaround is no longer the testing procedure.

## 15 November verification and remaining runtime work

- Recovery-focused evidence/service/store run passed (`_scratch/test-run.pid-5570.log`). Canonical checks passed (session 34834). Subsequent prompt-budget failures in `_scratch/test-run.pid-51413.log` were resolved by shortening only shared example prose by 63 characters; no limits or assertions changed. Focused prompt suites passed (`_scratch/test-run.pid-23004.log`). Full suite exited 0 (`_scratch/test-run.pid-92882.log`); independent review records its raw totals rather than the differing wrapper aggregate.
- [Second independent review](2026-11-15-livetest-capability-repair_review.md) confirms both recovery defects fixed and no new confirmed implementation findings, with independent focused checks passing. Overall task verdict remains FAIL because the complete live repair-to-original-check path and original campaigns remain unfinished.
- The real packaged launcher repeatedly returned local fallback rather than waiting only for an authorised remote host. The [remote-only follow-up](2026-11-15-livetest-remote-only-launch_plan.md) implements an explicit start option without changing capacity admission. Focused tests passed (`_scratch/test-run.pid-510.log`); all seven canonical checks passed again (session 6779). Actual remote-only waiting is retained in `2026-11-14-livetest-capability-repair_evidence/opencode-remote-wait.json`; a waiting command is not a started app or passing provider test.
- Latest full suite `_scratch/test-run.pid-84880.log` exited 1 with three timeouts in RLM process ownership, loop resource governor and worker browser setup. All three files passed in isolation without code or timeout changes (`_scratch/test-run.pid-87444.log`). No cause is asserted and the failing full run is not relabelled a pass. A fresh scoped launcher review is running.
- James explicitly restricted Codex to `james@shutupandshave.com`. The provider worker observed that exact signed-in browser identity. Earlier Community Tech sign-in/phone evidence concerns the wrong account for this requirement. Native profile provisioning and its secure device-code handoff remain under investigation; no unrelated account is signed out or revoked.

## 26 November round (queue worker, worktree `queue/2026-11-14-livetest-capability-59ed7b`, base `dafef52e5`)

- The worktree already holds everything the plan lists for Tasks 1 and 2 (recheck-readiness, capability service/store/evidence/launch, canonical repair links, original-retry recovery, `--remote-only` launch). Landed since the plan was written: recheck of originals after a repair lands (`2cb42de95`), Set aside sessions owning a run (`70b9fdd2a`), owner-item linking (`7cabf1e16`). No source edit was needed this round.
- Focused: `npm run test:quiet -- <recheck-readiness, check-recheck, capability service/store/evidence/launch, dev-app specs>` exit 0, 7 files / 225 tests, Windows PC, `_scratch/test-run.pid-89555.log`. The specs cover owner, foreign and queue-worker callers, cancelled/completed runs, answer race, paused run across restart, pre-classification persisted questions, repeated reports, cycle refusal, stale assignment, cancellation, missing plan.
- Wider: `src/main/plan-queue`, `src/main/mcp/plan-queue-tools`, `src/shared`, `packages/contracts`: exit 0, 410 files / 6,642 tests, `_scratch/test-run.pid-13305.log`.
- `npm run checks`: all seven gates passed on the Windows PC in 2m 25s. The full suite was not run (verifier's job).
- `dev-app.js status` showed one test-Mac copy (port 9473, a verifier's) and none on the PC; left alone. No new copy, provider turn, account change or browser use this round.
- The fixture (`plan-queue-livetest-fixture.ts`) offers workloads `small` and `long` only, so it cannot produce a worker gap report; the end-to-end repair loop therefore needs a hand-written scratch plan and real provider turns. Deferred, with the other campaigns, in `2026-11-14-livetest-capability-repair_livetest.md`.
- Earlier evidence still stands as recorded: packaged OpenCode ran three real `OK` replies on configuration-only mirrors, which does not close the originals.
- Stale plan text: none found among the listed direct changes.

### Verification round 1 fix (26 November)

- Finding: the verifier prompt said "if this is a capability repair plan, PASS requires a probe", so the checker of this plan (which implements the feature and owns no repair) tried `plan_queue_report_capability_probe` and was refused ("This item does not own a capability repair", `plan-queue-capability-service.ts` `reportProbe`). `assertCanPass` already only required a probe for `forRepairItem(item.id)`; the prompt was the part that disagreed.
- Fix: `CheckerPromptInput.ownsRepair` is set in `plan-queue-verification.ts` from `capabilities.forRepairItem(item.id)`, passed through the markdown source to `buildVerifierPrompt` and `capabilityCheckerRules(item, repoRoot, ownsRepair)`. The probe steps appear only when the repository has the launcher and the item owns a repair; otherwise the checker is told no probe is needed and not to report the missing link as a finding.
- Tests: new cases in `plan-queue-capability-service.spec.ts` (launcher present, no repair link: no probe steps) and `plan-queue-verification.spec.ts` (prompt carries the note); host stubs in verification, run-hold and orphan-checkout specs gained `store.capabilities`. `src/main/plan-queue` + `src/main/mcp`: 275 files / 4,181 tests passed; `npm run checks` all seven gates passed (Windows PC). No dev-app copy, provider turn or browser used.
- Stale plan text: none.

## 26 Nov: post-merge budget fix
After merging main, `npm run test:quiet` failed two prompt-length ceilings (queueVerifier 9,902 vs 9,900; queueLivetestVerifier 8,233 vs 8,200). Cause: the new "not a Queue-linked capability repair" checker line was too long. Shortened it in plan-queue-capability-prompts.ts; ceilings unchanged. Re-run: prompt-budgets + capability + verification specs 226 passed; src/main/plan-queue + src/main/context 4,261 passed; all 7 `npm run checks` gates pass. The only 2 failures in the earlier full run were these two.
