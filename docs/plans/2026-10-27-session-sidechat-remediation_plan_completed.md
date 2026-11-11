# Session sidechat live-test remediation

## Status

On main: yes (this landing commit)
- Done: every checklist item (LT-710, LT-711, LT-712, LT-723) is ticked. The code is already in this branch's base (commit `1b71b7719`, hand-merged 6 Nov 2026); this resume added no code.
- Resume check, 11 Nov 2026: 16 related spec files (315 tests) pass; typecheck, typecheck:spec, lint, check:ts-max-loc and check:ui-hints exit 0 (details in `2026-10-27-session-sidechat-remediation_plan_history_ef9bdfd640671c2013eeed0199a63feb3ce814671adb6ac448bc0a844db777d0_completed.md`).
- Windows acceptance (LT-SC-7) passed in-loop on 4 Nov; no live-test deferral. Earlier independent gate: VERDICT: PASS, full suite green on the pre-merge snapshot.
- Decision: acceptEdits behaviour for ordinary Write is preserved (see the reconciliation section).
- Next: independent verifier runs the full suite and builds; the coordinator owns the `_completed` rename. Created 2026-10-27.

Source acceptance and dated evidence: [session sidechat live test](2026-10-02-session-sidechats_livetest.md#evidence-run--2026-10-27-resumed-plan-queue).

This is the matching implementation-status follow-up for LT-710–LT-712. The older
`2026-07-19-livetest-failure-remediation_plan_completed.md` remains closed and is not extended.
This follows the register's existing active-follow-up ownership convention for LT-704–LT-707.
The original campaign made no product changes. Round 2 adds warm-adapter authority admission,
retained CLI approval requests and archived-row badges. Do not mark fixes complete before live
checks, canonical gates and independent verification. This untracked, coordinator-owned follow-up
carries the current implementation status and evidence; its filename remains active for the verifier.

## LT-710 — inherited restrictions lost when a warm Claude adapter is adopted

- [x] Make warm-process admission compare all launch-bound authority, including tool denials and permission hooks; otherwise use a fresh configured process.
- [x] Reproduce with a warmed workspace and a Plan-parent sidechat. The 2026-10-27 runtime `cp0gq0hg3` reported write=deny but successfully used Write to create `restricted/blocked.txt`.
- [x] Add regression coverage for the real admission → adapter option path, not just metadata on InstanceCreateConfig.
- [x] Repeat LT-SC-5 with a real provider and verify tool-layer refusal and an unchanged directory.
- [x] Recheck permission changes between turns, including a warm candidate, using an operation the current CLI actually requires approval for.

## LT-711 — closed sidechat loses a pending CLI approval card

- [x] Retain unresolved input-required requests above the component lifetime, or retrieve them from the authoritative main-process owner.
- [x] Reproduce: send a Bash question with the panel closed, wait for Needs action, reopen the exact conversation. On 2026-10-27 `ctbmo0hvo` was waiting_for_permission while its newly mounted panel component had no pending requests and no approval buttons.
- [x] Verify close/reopen, session switching, exact runtime scoping, resolution removal and deduplication. Do not retain resolved or superseded approval grants.
- [x] Repeat live with a harmless shell command. A continuously mounted panel already worked: `cmeocyck4` displayed Permission Required, Allow once ran `printf OPEN_PANEL_APPROVAL`, and the parent transcript stayed unchanged.

## LT-712 — unread sidechat omitted from an archived parent row

- [x] Render sidechat attention for a stable session history identity in both the project history row and history sidebar.
- [x] Connect the badge to the exact unread conversation without reviving or sending input to the parent.
- [x] Repeat LT-SC-3: restart with an unread answer and check the rail plus the parent history row. On 2026-10-27 the ledger and rail survived, but neither rendered history presentation had a parent unread badge.

## Acceptance wording that needs reconciliation

LT-SC-4 and LT-SC-8 currently expect an ordinary Write call to ask for approval when YOLO is off.
`claude-cli-argv-builder.ts:186-193` deliberately uses acceptEdits in that mode, so ordinary file
edits are automatically approved. Preserve that established behaviour unless explicitly changed;
use a harmless approval-gated Bash operation to verify approval routing and policy refresh.
The 2026-11-03 live checks used harmless approval-gated Bash commands. A separate real Write
created `allowed.txt` with YOLO off, zero approval requests and an unchanged parent transcript.
The existing acceptEdits convention is preserved rather than changing application policy.

## Windows acceptance — passed in-loop on 2026-11-04

Both LT-SC-7 checks passed through the rebuilt isolated app's preload/IPC. Claude answered from the parent's exact Windows workspace on the disposable worker, with an unchanged parent transcript. After that disposable worker became unavailable, sending to the same sidechat returned the explicit forced-worker-unavailable error and invoked no CLI adapter factory. An error placeholder remains listed by the normal failed-spawn lifecycle; it is not a local process. The earlier unverified connection attempt is historical, not an accepted live-test deferral. The production worker was neither stopped nor re-paired. Detailed evidence: [Windows follow-up](2026-10-27-session-sidechat-remediation_livetest.md).

## Required verification after fixes

The supplied round 3 independent verifier reported all canonical gates passing for the previous source state. That report is attributed evidence, not a new worker full-suite run. LT-723 passed fresh focused tests, both type checks, lint, size/UI-hint checks, both production builds and the full suite. The independent reviewer reran all eight canonical gates and returned PASS. Current worker receipts are in /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4/command-receipts.jsonl. This plan, the original campaign and the Windows follow-up retain their active names solely as explicitly instructed; queue lifecycle acceptance remains pending.


## As-built notes — 2026-11-03

- All twelve remediation checklist items above have implementation/regression or affected-live evidence. The checkmarks record the worker result, not independent acceptance.
- Warm admission now refuses additional tool denials beyond the shared ordinary denylist, explicit allowed-tool lists, review-only mode and environment filtering/contained execution, retaining the existing permission-hook, YOLO, hardened, account/routing and effort guards. Baseline regressions reproduced the missing tool/environment guards. The added integration spec follows built-in Plan permissions through the real mapper, admission and Claude adapter/argv construction.
- Complete unresolved CLI requests now live in the startup-created IPC event bus. Cards survive closing/reopening and session changes, remain scoped by instance/request identity, and disappear on resolution, cancellation, removal, exit or runtime replacement. Typed secret values remain component-local.
- Both history presentations use the stable parent history identity and shared badge wording. Archived badge requests now open the normal sidechat panel under the original parent without restoring it. The panel's existing focused/bottom-of-transcript read acknowledgement works there. Quiet badges use the panel's selector directly rather than starting a separate asynchronous prefetch.
- Real Claude checks passed for inherited Write refusal, including a matching high-effort warmed workspace; closed-panel Bash approval after reopening; YOLO-on to off runtime replacement and approval; and ordinary permitted Write auto-approval. The restricted project remained empty. Actual Bash markers were retained as tool results, and the parent remained unchanged by the sidechat approval/edit operations.
- A repeated settled restart preserved message IDs, sequences, roles and contents with zero attached runtimes or resends. Both sidebar and project-row badges rendered; each opened its exact conversation without a parent runtime. The global rail retained the unread total and a previously viewed archived answer stayed read. Project rendering used test-only neutral directory labels because the existing project list intentionally excludes queue-worktree histories; stored identities, contents and main-process records were not rewritten.
- Recovered useful code/tests from the parked October queue checkpoint after reproducing the defects on this branch, preserving newer tooltip/focus changes. Self-review added the environment/review-mode admission guards, removed the unnecessary quiet-badge prefetch and kept visible status text. No dependencies, persistence formats or IPC channel contracts changed; generators produced no diff.
- The older completed design/implementation documents remain closed. This follow-up has no new linked active spec. LT-710–LT-712 register additions were in parked queue checkpoints and absent from this checkout's tracked register, so this active follow-up contains its own current evidence instead of extending a completed remediation document.
> Earlier journal sections moved to `2026-10-27-session-sidechat-remediation_plan_history_ef9bdfd640671c2013eeed0199a63feb3ce814671adb6ac448bc0a844db777d0_completed.md`.
## Independent verification round 1 remediation — 2026-11-03

- Reproduced all 15 branch-related focused failures before editing: 14 missing normalized event-stream test doubles and one default warm-start ordering regression.
- Admission now compares tool denials against the shared default denylist rather than checking whether the property exists. Allowed-tool restrictions, inherited additional denials and existing launch guards still require fresh processes.
- The three affected renderer integration suites now instantiate the real InstanceEventsService; their assertions and production retained-approval lifecycle are unchanged. The previously failing focused run passed (113 tests).
- Added production-mapper regression coverage for both built-in Build and Plan permissions across Claude, Codex, Gemini and Cursor.
- Reproduced the three dependency failures: the linked root installation has glob 13 where the lock requires 14, a missing nested minimatch and Vite 7 where Angular requires Vite 8. Rebuilding a lockfile-exact worktree-local install without changing shared packages or manifests.
- LT-SC-7 is agent-runnable and remains required in-loop; investigating an isolated disposable Windows connection. Its open document records pending work, not an accepted deferral or completion claim.
- New round evidence: `.aio-review/2026-11-03-session-sidechat-round2/` in the assigned worktree. The original evidence bundle remains historical.

Historical verification update before round 3 (superseded by the final results below): every static/build gate and the expanded focused run passed. The first full run under Node 26 had zero assertion failures but exited 1 on a Vitest source-map error, with two executable-build tests pending. The unchanged executable-build spec passes under the pinned .nvmrc Node 24.22.1, and the full suite is being repeated with that runtime. No green full-suite or independent acceptance is yet claimed.

## Fresh-review repairs — 2026-11-04

- Reproduced and fixed the remaining default-denial mismatch in both direct and worker Claude argv. All five defaults now share one policy definition and are enforced even when the warm spawn passes no explicit denylist. Actual factory/worker argv regression cases pass.
- Reproduced and fixed unfinished answer/scope loss across session changes. Component-local drafts/errors are scoped by instance/request identity; controlled textarea values and DOM identity restore the correct session's draft, failed replies retain it, and settled requests clear their drafts. Typed secrets remain local and clear on session changes.
- Updated the original campaign's Windows summary to include the real fixture attempt and cleanup. The networking cause remains unproven; no successful Windows dispatch/refusal result is claimed.
- The superseded pinned full run was interrupted (exit130) before these fixes; it is not green evidence. At that historical checkpoint, focused regressions passed and final static/build checks plus independent full verification were pending; the current status is recorded above and in the round 3 repair notes below.

## LT-723 — Windows execution provenance (round 3 findings, 2026-11-04)

- [x] Restore the accidentally deleted tracked source acceptance document from the parent of the last checkpoint, preserving its existing acceptance and evidence.
- [x] Establish a disposable Windows worker connection without changing the production worker. A bounded Node 24 WebSocket relay reaches the isolated coordinator on loopback; the earlier direct ingress failed from both local and Windows sources. The precise OS/network cause is not asserted.
- [x] Reproduce the product routing failure with the connected worker: a remote Claude parent starts, then `sideChatSend` tries its Windows directory on the coordinator.
- [x] Repeat online and offline sidechat acceptance after deriving policy, context provenance and renderer parent references from `executionLocation`, rather than the supervision-tree `workerNodeId`.
- [x] Correct runtime test doubles, add regression coverage, run canonical gates and retain a fresh review. Focused235 cases pass; the independent full run passes36492 tests with zero failures and nine pre-existing pending cases. All other canonical gates exit0; VERDICT: PASS.

Risk: incorrect provenance could send a sidechat to the wrong machine or leave a stopped worker's send eligible for local execution. Focused coverage must distinguish a supervision identifier from an execution node, cover local and remote parents and retain policy across parent termination. The supplied round 3 verifier reports the previous canonical gates all passing; this is attributed verifier evidence, not a new full run by this worker. New code requires new verification. No completion rename or commit is authorised.

## As-built notes — round 3 findings repaired, 2026-11-04
> Earlier journal sections moved to `2026-10-27-session-sidechat-remediation_plan_history_ef9bdfd640671c2013eeed0199a63feb3ce814671adb6ac448bc0a844db777d0_completed.md`.
## Final worker verification — 2026-11-04

- Fresh independent task-completion-gate: **VERDICT: PASS**, no unresolved actionable findings. Report: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4/independent-review.md. The reviewer traced the whole merge-base-to-HEAD range plus working-tree repairs and restored acceptance source, and confirmed all43 recorded path hashes and HEAD unchanged before/after review.
- Independent canonical receipts: /Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-27-session-sidechat-re-022b2b/.aio-review/2026-11-04-session-sidechat-round4/independent-gate0/receipts.jsonl. Both type checks, lint, size/hint checks, both builds and the full unfiltered suite exit0. Full suite: 2867 files,36492 passing tests,0 failures,9 pre-existing pending tests. Parent focused235 cases also pass. Renderer build retains its existing initial-bundle warning.
- Clean-state limit: reviewed the exact hash-matched dirty snapshot in this assigned worktree. No clean checkout was created because commits, staging active documents, branches/worktrees and source copies were forbidden. The independent report records this rather than claiming a clean build.
- Cleanup: Windows fixture folder and its own stale lock removed, fixture/launcher PIDs absent; production windows-pc still connected. Local offscreen profile, test credentials, worker bundle and relay removed. Only reports, seals, small replay sources and command receipts remain, with dependency installs in the worktree. Final cleanup/seal receipts are in the evidence bundle.
- All three round-3 findings are addressed. This document remains `_plan.md` because the worker was explicitly forbidden to rename it, not because agent-runnable checks were deferred. No new live-test deferral, commit, staging, stash, branch change or `_completed` rename.

> Plan Queue parked work: `queue/2026-10-27-session-sidechat-re-022b2b` — 6 commit(s), reason: land-blocked.
