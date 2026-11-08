# Live-Test Remediation Register

**Type: standing register — deliberately tracked, no `_spec`/`_plan` lifecycle.**
This file has no `_completed` state and never will: new `LT-NNN` items are appended whenever a
live-test campaign reproduces a defect (see Operating Rule 6 below). It was previously named
`2026-07-18-livetest-failure-remediation_spec_planned.md`; renamed 2026-07-26 because a `_planned`
suffix implies a terminal `_completed` that cannot apply to a rolling index, and because the
untracked-until-complete rule would leave weeks of accumulated defect triage unbacked-up. Per-item
status lives in the Remediation Index; implementation progress lives in the fixing plan or livetest.

**Original status:** Approved in review `2026-07-18-livetest-failure-remediation`.

**Status and implementation ownership:** The register's index row is the defect's status;
implementation notes go in the plan or livetest document that fixes it.
Do not add work to closed plans. Agents do not read
`livetest-remediation-register-archive-2026.md` unless an index row points there.
Closed details are archived; entries awaiting code or live acceptance stay here.

**Purpose:** Provide one execution index for every confirmed defect found while running the
live-test backlog. The originating live-test files remain the canonical acceptance procedures and
evidence records.

## Operating Rules

1. Fix work starts from this document, not by rediscovering failures across every pending
   live-test file.
2. Every remediation item links to its originating live test. Do not copy or weaken the
   originating test's completion criteria.
3. Reproduce each defect with the smallest focused test before changing production code.
4. A fix is complete only after its targeted regression tests, the canonical project gates, and
   every linked live test pass.
5. Rename a linked file from `_livetest.md` to `_livetest_completed.md` only when all checks in
   that file pass with current evidence.
6. A pending or unrun check is not automatically a product defect. Add newly reproduced defects
   to this spec with their source evidence before implementing them.
7. Historical Gemini live-test steps must use Antigravity as the current live provider.
   `gemini` remains only where backward compatibility with persisted data or older remote nodes
   is explicitly under test.

## Remediation Index

### New sidechat findings — 2026-10-27

Implementation status and acceptance are recorded in each tracked detail section below, so this
register remains usable when landed independently of the queue's root-checkout working documents.
The coordinator retains the active follow-up plan and per-check evidence until independent verification.

| ID | Priority | Current status | Detail | Origin |
| --- | --- | --- | --- | --- |
| LT-732 | P1 | **FIXED ON MAIN; re-verify after landing.** Warm Claude processes could keep a sidechat's inherited tool denials and approval hook missing. Main refuses warm reuse when either is set (`src/main/instance/lifecycle/instance-spawn-preflight-chain.ts:83-96`). A 2026-11-07 live run on the pre-merge branch showed a restricted sidechat spawn fresh and unable to write; the warm-adoption step was not reproduced there. | [LT-732 detail](#lt-732) | LT-SC-5 |
| LT-733 | P1 | **FIXED ON MAIN; live check passed 2026-11-07 on the pre-merge branch build; re-verify after landing.** A CLI approval that arrives while the sidechat panel is closed is kept by the event bus and shown as one card on reopen. | [LT-733 detail](#lt-733) | LT-SC-4 |
| LT-734 | P2 | **FIXED ON MAIN; live check passed 2026-11-07 on the pre-merge branch build; re-verify after landing.** Archived parent rows (History and project history) show the unread sidechat badge and open the exact chat. | [LT-734 detail](#lt-734) | LT-SC-3 |
| LT-735 | P2 | **FIXED ON MAIN.** Sidechat policy and parent resolution read `executionLocation` (`src/main/chats/side-chat-parent-resolver.ts`), not the supervising `workerNodeId`. The Windows live check was not re-run on this branch. | [LT-735 detail](#lt-735) | LT-SC-7 |

### Current status corrections — 2026-10-14

These supersede the status phrase in the matching index rows. All 17 defects from the 2026-10-04
campaign (LT-664 to LT-702) are **FIXED + REGRESSION-TESTED 2026-10-14 (working tree)**: their
focused regressions pass (23 files, 1014 tests, cache-disabled) and the canonical gates
(`tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`, `build:renderer`,
alias/IPC generators with drift checks) are green on the Plan Queue worktree. Implementation
decisions and as-built detail live in
[the closed implementation record](2026-10-05-livetest-campaign-defects_plan_completed.md). Real-runtime acceptance remains
in [the campaign livetest](2026-10-05-livetest-campaign-defects_livetest.md).

| ID | Current status |
| --- | --- |
| LT-664 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** Retiring a target now closes its incidents in the same SQLite transaction before lifecycle observers run (repository, Settings/IPC and CLI callers); a failing-resolution trigger proves rollback. Live re-check (Local AI CLI parity check 1) pending in the campaign livetest. |
| LT-665, LT-666 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** Missing fingerprint markers alone give `unknown / fingerprint_markers_missing` and never navigate or fill; a password field or login-shaped URL remains the positive logged-out signal; failed post-login observations and unreadable login forms stop with their specific reason and no further credential attempts. Scope note: these guards are this plan's code; the 2026-10-11 restored-tab reproduction and the extension-side inventory-stamp fix recorded in [the LT-665 detail](#lt-665) landed in the codebase separately (extension ≥0.2.39, covered by the `browser-target-inspection`, tab-store and assets regressions) and are not part of this plan's diff. Live re-check (login recipe checks 1–2) and the extension confirmation on `windows-pc` are pending in the campaign livetest. |
| LT-670 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree); dev-app re-check 2026-10-06** (a Codex session waiting out circuit-breaker backoff at attempts 3–4 was not terminated). Campaign livetest LT-C still pending. |
| LT-671 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** A refused crash-continuation reservation after recovery now logs a metadata-only warning (instance ID, request count, state, wait kind); fresh-replay admission is unchanged. Live re-check (crash-turn LT-A) pending in the campaign livetest. |
| LT-672 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree); dev-app re-check 2026-10-06** (user Stop on a busy turn returned to idle with interrupt notices only). Campaign livetest LT-B still pending. |
| LT-673 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree); dev-app re-check 2026-10-06** (reload kept the session in the list and rail). Packaged cold start still pending in the campaign livetest. |
| LT-674 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** An errored completion is captured (cost, telemetry, hooks) before adapter cleanup deletes the adapter. Live re-check (outstanding plans sweep check 3) pending in the campaign livetest. |
| LT-675 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** Claude and Codex sign-in banners are rejected as titles and title escalation continues to the next provider. Live re-check (session title quality) pending in the campaign livetest. |
| LT-680 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** An accepted Codex steer keeps turn capture open through the real completion instead of an inferred 250 ms idle edge. Live re-check (codex compaction reliability check 4) pending in the campaign livetest. |
| LT-681 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree); dev-app re-check 2026-10-06** (manual Codex compact kept the measured occupancy as estimated `awaiting-post-compaction-usage`, not ~0%). Campaign livetest check 3 still pending. |
| LT-682 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree); dev-app re-check 2026-10-06** (busy Codex button titled `Interrupt Codex (Esc)`). Cosmetic; acceptance needs no further live re-check. |
| LT-683 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** Overlapping native provider turns are followed without an early idle edge. Original reproduction was seen once 2026-10-04; live re-check (codex compaction reliability check 1) pending in the campaign livetest. |
| LT-690 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** An injected-cap saturation ending is classified `max_output` with continuation, and ordinary completions stay `completed` (negative cases covered). Live re-check (provider hardening check 1) pending in the campaign livetest. |
| LT-700 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** A recovered Plan Queue verifier spawn is deferred until the orchestrator-tools socket waiter resolves. Live re-check (Plan Queue check 3) pending in the campaign livetest. |
| LT-701 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** App shutdown suppresses failure and settlement outcomes at the tracker's status/error/exit/removal/completion boundaries and is signalled before synchronous provider kills as well as async termination, so mid-turn items survive a normal quit. Live re-check (Plan Queue check 3) pending in the campaign livetest. |
| LT-702 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree).** The settled predicate is re-evaluated on an interval so a finished, valid reviewer verdict releases the round. Live acceptance (ping-pong loop) pending in the campaign livetest. |

### Current status corrections — 2026-10-27 verifier follow-up

| ID | Current status |
| --- | --- |
| LT-603 | **Current runtime assertions confirmed 2026-10-27.** Fresh isolated AR-002 run retained exact PID gates, real suppressed completion, kept/dropped reconciliation, explicit degradation notice and successful completed-child summary queries. Fixtures/profile removed; canonical gates including the pinned full suite pass. |
| LT-708 | Implementation and focused regressions present; dated cold/warm refusal, genuine denial UI and current rejection have live evidence. Canonical gates now pass; independent implementation closure remains with the coordinator. No global allow-rule write is authorized just to verify wording. |
| LT-728 | Renumbered from LT-710 on 2026-11-07. Timeout diagnostic implemented and observed live. The 4,874-character timed-out sample included an accidental fixture deletion, so it does not isolate no-op latency. The earlier delay investigation remains open; no outage or fix is inferred. AR-006 cache reuse and both invalidations pass with the real reverse Claude-builder/Codex-reviewer pair. |
| LT-711 | **OPEN — historical report awaiting independent reproduction.** Cursor was reported on 2026-10-04 to emit empty `completed` updates for real read/permission failures. Raw historical receipts are missing. Distinct from LT-612's exit-code handling and AR-007's retired `failed`-without-output clause. [Detail](#lt-711). |
| LT-712 | **IMPLEMENTED on main (handoff-observability plan, merged 2026-11-07); live proof open.** The 2026-10-27 AR-003 run could not join its requeued command to its audit row or observe FIFO-head reinsertion. Audit rows now carry the queued command ID, and requeued commands are logged at the FIFO head with that ID and the queue depth. AR-003 stays open for the identified-build repeat. [Detail](#lt-712). |

### Current status corrections — 2026-09-24

These supersede the status phrase in the matching index rows. Evidence lives in the owning
`*_livetest.md` documents under their `## Evidence run — 2026-09-24 (...)` sections. The dev-app
runs used HEAD `f04f6748`. The packaged-app runs used the build of 2026-09-23 21:12.

| ID | Current status |
| --- | --- |
| LT-545, LT-546 | **CONFIRMED FIXED LIVE** (skill-observability check 4a/4b/4d). LT-547 is wired in source; its live half was inconclusive because detection never fired. |
| LT-548, LT-549, LT-550 | **CONFIRMED FIXED LIVE** (workspace-secret-card checks 2–4). |
| LT-551 | Agents can now issue `secret_required` themselves. The card reached the UI only by the pull route until LT-641 is fixed, so the live push re-check is pending. |
| LT-570, LT-571, LT-573, LT-574, LT-575 | **CONFIRMED FIXED LIVE** (settings-ux LT-1/LT-2). |
| LT-572 | **CONFIRMED FIXED LIVE 2026-09-24** (`verify-ui`: toggle 44×44; all 30 collapsed nav items at least 47×44 at 600/900/1200 px heights). |
| LT-590, LT-591, LT-592, LT-593, LT-594 | **CONFIRMED FIXED LIVE**. |
| LT-595, LT-605, LT-606, LT-610, LT-611, LT-613 | **CONFIRMED FIXED LIVE**. |
| LT-596, LT-597, LT-598, LT-599, LT-600, LT-601, LT-602 | **CONFIRMED FIXED LIVE**. |
| LT-603 | Fixed in code (`9efc4871`) with a regression test. The live multi-process re-check has **not** been run. |
| LT-612 | Cursor half **CONFIRMED FIXED LIVE**. Grok half **REOPENED → FIXED IN CODE 2026-09-24**: Grok reports `rawOutput.exit_code`, captured on the wire. Live re-check pending. |
| LT-541, LT-542 | **REOPENED**: the fix was never on `main`. Ported to the working tree 2026-09-24; live re-check pending. |
| LT-544 | `windows-pc` channel executes commands again (2026-09-24). The local Mac channel reproduced a different fault, filed as LT-618. |
| LT-615–LT-617, LT-619–LT-621, LT-630, LT-631, LT-640–LT-642, LT-650, LT-651 | New 2026-09-24. **FIXED IN CODE**; see each row. LT-618 is partly fixed: the unbounded extension boundary queue remains. |
| LT-643 | New 2026-09-24. **FIXED + CONFIRMED LIVE** (working tree): three real ping-pong loops completed with rounds surfacing. Ping-pong check 2 is now blocked by LT-644. |
| LT-640, LT-641 | Both faults of each **CONFIRMED FIXED LIVE** 2026-09-24 (`verify-final`): the panel updated without reload, and secret and question cards rendered inside an open chat. |
| LT-612, LT-642, LT-650, LT-651, LT-620, LT-572, LT-630 | **CONFIRMED FIXED LIVE** 2026-09-24 (`verify-loops` / `verify-ui`); LT-650 confirmation covers quota IPC only, and its Settings DOM clause remains unverified. |
| LT-644 | New 2026-09-24. **FIXED IN CODE**: the prompt now names the finding fields, the parser reads Codex's names, and a round whose findings are all unusable is unreliable. Live re-check pending. |
| LT-652, LT-653 | New 2026-09-24 (later, from live session `xecsi91o3`). **FIXED + REGRESSION-TESTED 2026-09-24 (working tree)**; live re-check pending. LT-652: a send during a Codex Compact turn is now held with a 15 s backoff and a compact-sized retry budget (12) instead of being burned in under a second and dropped. LT-653: the policy `steer-turn` text is framed as an automated system action and no longer reads as a user request to stop work; three misattributions in `2026-09-23-outstanding-plans-progress.md` are corrected. |
| LT-657 | New 2026-09-25 (live session `x7cpyakhs`). **FIXED + REGRESSION-TESTED 2026-09-25 (working tree); rebuilt-app check pending.** Root cause of LT-653: Codex records `turn/steer` input as `role: "user"`, so the context-policy steer was the user's words to the model. It now travels as a developer-role `thread/inject_items` item, and every Harness-authored `sendInput` carries explicit `internalSource` provenance (stored as a Harness system message, never `type: 'user'`). |

### Current status corrections — 2026-08-31

These corrections supersede the older status phrase inside the corresponding index rows and full
sections below. The historical reproduction remains unchanged.

| ID | Current status |
| --- | --- |
| LT-217 | **ONGOING GROWTH FIXED + REGRESSION-TESTED.** Internal attach/poll writes are suppressed and 90-day read retention is implemented. Optional compaction of the historical 1.36 GB is a separate destructive maintenance action. |
| LT-218 | **FIXED + REGRESSION-TESTED; live unreadable-page recheck pending.** Snapshot results now carry `textUnavailableReason` instead of silently presenting an unreadable page as empty. |
| LT-220 | **DECIDED + DOCUMENTATION CORRECTED.** Antigravity's missing tool-result visibility is an accepted capability gap; no adapter rewrite is planned. |
| LT-270 | **DECIDED + CONTRACT RESCOPED + LIVE EVIDENCE ACCEPTED.** The automatic path is a safety pause, not a compaction guarantee, on builds that do not confirm native compaction. |
| LT-521 | **DOCUMENTATION CORRECTED.** The nonexistent shadow-decision log requirement was removed; behavior was already correct. |

| ID | Priority | Required fix | Evidence source | Retest source |
| --- | --- | --- | --- | --- |
| LT-001 | P0 | Browser Gateway grants for an existing shared tab must match the action retried after approval | [Browser Permission UX evidence](../superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest_completed.md#2026-07-18-live-test-evidence) | [Browser Permission UX checks](../superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest_completed.md#check-1-low-risk-permission-bar) |
| LT-002 | P0 | The embedded document-review runtime must execute without weakening renderer or iframe isolation | [Doc-review embedded evidence](./2026-07-13-doc-review-choice-controls-plan_livetest_completed.md#scenario-2--embedded-doc-reviews-pane-blocked-both-root-causes-verified) | [Doc-review choice-controls checklist](./2026-07-13-doc-review-choice-controls-plan_livetest_completed.md#2-embedded-doc-reviews-pane) |
| LT-003 | P1 | Unsaved document-review choices and comments must survive the reload/reselection behavior required by the live test | [Doc-review state finding](./2026-07-13-doc-review-choice-controls-plan_livetest_completed.md#scenario-2--embedded-doc-reviews-pane-blocked-both-root-causes-verified) | [Doc-review choice-controls checklist](./2026-07-13-doc-review-choice-controls-plan_livetest_completed.md#2-embedded-doc-reviews-pane) |
| LT-004 | P0 | Interrupt and unexpected-exit recovery must classify the active runtime correctly and preserve the session | [Interrupt evidence](../superpowers/plans/2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest_completed.md#2026-07-18-live-test-evidence), [unexpected-exit evidence](../superpowers/plans/2026-07-17-unexpected-exit-reconciler-migration-plan_livetest_completed.md#2026-07-18-live-test-evidence) | [Interrupt checks](../superpowers/plans/2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest_completed.md#checks), [unexpected-exit checks](../superpowers/plans/2026-07-17-unexpected-exit-reconciler-migration-plan_livetest_completed.md#checks) |
| LT-005 | P1 | `bench:retrieval -- --local` must run the documented read-only local-personal suite against real stores | [WS16 evidence](./2026-07-13-fable-ws16_livetest_completed.md#2026-07-18-live-test-evidence) | [WS16 local-personal check](./2026-07-13-fable-ws16_livetest_completed.md#3-local-personal-suite-read-only-never-committed) |
| LT-006 | P1 | Replace obsolete live Gemini requirements with Antigravity while preserving explicit backward-compatibility coverage | [WS1 historical blocker](./2026-07-13-fable-ws1_livetest_completed.md#evidence-run--2026-07-16-blocked-no-rows-recorded) | [WS1 completion matrix](./2026-07-13-fable-ws1_livetest_completed.md#completion-matrix), [WS7 failover check](./2026-07-13-fable-ws7-phaseb_livetest_completed.md), [provider-context evidence check](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md) |
| LT-008 | P0 | A yolo-only (or any fork-resume) runtime change must resume the session that exists, not a freshly minted id, and must not destroy a live session on an unproven health probe | [YOLO reconciler evidence](../superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest_completed.md#evidence-run--2026-07-26--checks-1-and-3-fail-reproducibly-root-cause-found) | [YOLO reconciler checks](../superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest_completed.md#checks) |
| LT-009 | P0 | The skill registry must actually contain the builtin skills, so trigger matching and skill attribution can record anything at all | [Skill observability evidence](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run-2--2026-07-26-dev-app-with-a-send-path--check-2-fails-the-registry-is-empty) | [Skill observability checks](./2026-07-23-skill-observability-and-design-skills_livetest.md) |
| LT-010 | P1 | `sync_to_node` / `sync_from_node` must validate against the node's file-transfer roots, the same allowlist `upload_to_node` uses — **CLOSED 2026-07-29**: verified live against the reconnected `windows-pc` worker. Writing into the `scratch` root (`write: true`) succeeds and the file was confirmed landed via `list_node_files`; `C:\Users\shutu\Downloads` (`write: false`) is still refused [Archived detail](livetest-remediation-register-archive-2026.md#lt-010-archived-detail) | [Worker file-movement evidence](2026-07-16-worker-controller-file-movement_livetest.md#evidence-run--2026-07-26--check-5-re-run-sync-root-bug-root-caused) | [Worker file-movement check 5](2026-07-16-worker-controller-file-movement_livetest.md#5-agent-folder-sync-spec-item-5) |
| LT-011 | P2 | Live-test checks must assert on signals the app actually emits; add the missing log lines (or rewrite the checks) | [History-restore evidence](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest_completed.md#evidence-run--2026-07-26--corroboration-for-check-1-24-not-run-the-checks-are-not-log-observable-as-written) | [History-restore checks](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest_completed.md#checks) |
| LT-013 | P0 | A deliberate terminate must not be classified as an unexpected exit; the archived history entry must record the provider session that actually exists | [History-restore evidence](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest_completed.md#evidence-run--2026-07-27-session-2--check-1-passes-after-lt-013-check-2-blocked-on-a-contract-conflict-lt-014) | [History-restore check 1](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest_completed.md#checks) |
| LT-014 | P2 | Decide the restore ladder's contract for an alive-but-provably-unresumed session — **decided + implemented 2026-07-27**: rung stays `resume-unconfirmed`, but a disproven resume now emits the notice and records `nativeResumeFailedAt`. **CLOSED 2026-07-29** — check 2 re-run live against a genuinely dead session: first restore `resume-unconfirmed` + notice + `nativeResumeFailedAt` recorded, second restore of the same entry `replay-fallback`. All four history-restore checks now pass and that doc is renamed `_livetest_completed.md` [Archived detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail) | [History-restore evidence](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest_completed.md#evidence-run--2026-07-27-session-2--check-1-passes-after-lt-013-check-2-blocked-on-a-contract-conflict-lt-014) | [History-restore check 2](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest_completed.md#checks) |
| LT-015 | P2 | **FIXED 2026-07-30** — runtime-change notices are now delivered to the CLI *and* recorded as `system` transcript entries (`runtime-change-notices.ts`; `announceRuntimeChange`). Originally: notices reached the model but were never rendered, so three yolo checks cannot pass as written — **scope extended 2026-07-29**: the same delivery call is used for provider-change and model-change notices, so the provider/model-swap check 1 fails the same way | [YOLO evidence](../superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest_completed.md#evidence-run--2026-07-27-session-2--checks-2-4-5-driven-against-a-current-renderer), [swap evidence](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#evidence-run--2026-07-29-dev-app-over-cdp-real-claude--codex-turns) | [YOLO checks 1, 2, 4](../superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest_completed.md#checks), [swap check 1](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#1-cross-provider-swap-with-context-carry-over-claude--codex--claude) |
| LT-016 | P2 | **FULLY FIXED 2026-07-31** — the 2026-07-30 fix covered only the *swap* path; instance **creation** still surfaced the spurious notice, which is the far more common case (every new non-Claude session). `ModelSelectionResolver` now reports the same provenance (`modelSource`) and the create-time emission applies the same suppression; verified live (`warnings: []` on an explicit Copilot spawn). Previously (2026-07-30) — swap model resolution now reports provenance (`resolveSwapModelWithSource`) and a rejection traced to the global `defaultModel` is logged but not surfaced. Originally: an unpinned cross-provider swap told the user their model selection was "no longer available" when nothing they selected was stale — the global `defaultModel` is provider-specific and should not be offered to a foreign provider [Archived detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail) | [Swap evidence](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#evidence-run--2026-07-29-dev-app-over-cdp-real-claude--codex-turns) | [Swap checks 2 and 5](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#2-swap-with-no-explicit-model-remembered-default) |
| LT-017 | P1 | **DECIDED + FULLY FIXED 2026-08-12** — restart-with-summary is now the documented, intentional manual-compaction policy (a strict "report failure, keep the thread" contract would make the Compact button a permanent no-op on any provider build that never confirms native compaction — the case observed in every live run of this check so far). The doc's check 1 wording was updated to match. The remaining defect this check exposed — the "at most once per session" saving being wiped by every adapter respawn — is tracked separately as **LT-045**, now fixed [Archived detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail) | [Context-cost-governor evidence](../superpowers/plans/2026-07-14-context-cost-governor-plan_livetest_completed.md#evidence-run--2026-08-12-batch-b--lt-017-decision--lt-045-found-and-fixed) | [Context-cost-governor check 1](../superpowers/plans/2026-07-14-context-cost-governor-plan_livetest_completed.md#1-explicit-compaction-proof) |
| LT-045 | P2 | **FIXED + VERIFIED LIVE 2026-08-12** — LT-017's "pay the 30s native-compaction timeout at most once per session" fix lived on `CodexContextCostController`, which `restart-with-summary` replaces wholesale on every respawn (a brand-new adapter object, brand-new controller, flag reset to `false`) — and restart-with-summary is exactly what fires on every single manual compaction attempt for a provider build that never confirms native compaction. So in practice **every** manual compaction paid the full ~30-48s stall, not just the first, on the one path the fix was meant to help. A new coordinator-level record (`CompactionCoordinator.nativeCompactionProvenUnsupported`, keyed by instance id, cleared on instance teardown) survives the respawn. Verified live on one instance across three consecutive manual compactions: 1st 34.6s (real timeout, `nativeAttemptFailed: true`), 2nd 4.3s, 3rd 7.1s — both later calls skipped the RPC entirely (adapter's `compactContext()` never called) [Archived detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail) | [Context-cost-governor evidence](../superpowers/plans/2026-07-14-context-cost-governor-plan_livetest_completed.md#evidence-run--2026-08-12-batch-b--lt-017-decision--lt-045-found-and-fixed) | [Context-cost-governor check 1](../superpowers/plans/2026-07-14-context-cost-governor-plan_livetest_completed.md#1-explicit-compaction-proof), `src/main/app/compaction-runtime.spec.ts`, `src/main/context/compaction-coordinator.spec.ts` |
| LT-046 | P1 | **FIXED + VERIFIED LIVE 2026-08-12** — the rolling handoff-state feature's only write path (`HandoffStateService.noteTurnCompleted`) lived nested inside `recordCompletionCost`, which early-returns on any completed turn without billable `response.usage` — so with `sessionHandoffStateEnabled: true`, a real session could complete 14+ turns (with `contextUsage`/`totalTokensUsed` correctly growing via a separate event path) and still never populate any handoff state, silently defeating the ON setting for that session. Root-caused and confirmed via new direct observability (see LT-046's own evidence, not model-guessing): a debug log at the swap-time rung-choice call site showed `rung: "replay-preamble"` with 0 folded turns despite 14 real completions. Moved the `noteTurnCompleted` call out of `recordCompletionCost` to the shared turn-completion call site, gated only by the setting [Archived detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail) | [Rolling-handoff-state evidence](../superpowers/plans/2026-07-17-rolling-handoff-state-plan_livetest_completed.md#evidence-run--2026-08-12-batch-b--observability-added-checks-1-4-re-run-with-direct-proof-lt-046-and-lt-047-found) | [Rolling-handoff-state check 1](../superpowers/plans/2026-07-17-rolling-handoff-state-plan_livetest_completed.md#checks), `src/main/instance/instance-communication.spec.ts` |
| LT-047 | P1 | **FIXED + VERIFIED LIVE 2026-08-12** — confirmed and root-caused: a resident Claude turn is completed entirely inside `processCliMessage`'s `case 'result'` (`claude-cli-adapter.ts`), a code path that never called `completeResponse()`/emitted `'complete'` — that seam was only reachable from the one-shot `sendMessage()` path's process-close handler, which a resident session's process never triggers per-turn (it stays alive across turns). Reproduced live: 0/5 `'complete'` events on a resident Claude instance vs 3/3 for a Codex control in the same session, and **zero** cost-tracker entries recorded across those 5 real Claude turns. Fixed by accumulating each resident turn's raw NDJSON and, at `result`, feeding it to the existing `parseOutput()` (the same conversion one-shot mode already trusts) and calling `completeResponse()`, guarded by a new `awaitingOneShotCompletion` flag so the one-shot path's own completion can never double-fire. Live-verified post-fix: 3/3 turns emitted `'complete'` with real `content`+`usage`, and 3/3 cost-tracker entries were recorded (was 0/5 before). Separately, cost-tracking was found to ALSO fail for **Codex** resident turns via an unrelated mechanism (`response.usage` undefined on `'complete'` even though it fires) — filed as **LT-090**, not fixed [Archived detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail) | [LT-047 fix + live verification](livetest-remediation-register.md#lt-047-a-resident-claude-cli-session-never-fires-the-adapter-complete-event) | `src/main/cli/adapters/__tests__/claude-cli-adapter.spec.ts` ("LT-047: resident Claude session fires the adapter complete event", 4 mutation-verified tests) |
| LT-018 | P2 | **FIXED IN CODE 2026-08-01, completion gate PASSED at round 11 (live re-check outstanding)** — `ContextUsage.occupancyReported` makes "we have no measurement" explicit instead of seeding a confident `0 %`. Eleven gate rounds found **ten** defects, three of them regressions introduced by the fix itself: the same confident zero was duplicated across five renderer surfaces and two transports, could be *inverted* into a stale confident number by four fresh-session paths, was dropped in transit by two persistence writers (silently losing accrued `costEstimate` on every turn), and adding the field made a `.strict()` schema reject a live IPC event. Change 2 (the false `copilot-acp` `cumulativeReporting: 'available'` declaration) is still open. Previously — **REOPENED 2026-07-31 — the 2026-07-30 fix cannot work and the user-visible defect is unchanged.** Live re-run after 3 real Copilot turns still shows `{used:0,total:200000,percentage:0}`. A diagnostic added this session proves why: `AcpCliAdapter  ACP turn reported no token usage … { profile: 'copilot-acp', usageKeys: null }` — the installed Copilot ACP runtime sends **no usage object at all**, so there is nothing to aggregate. And the "never a fake 0 %" half is defeated upstream: `instance-create-builder.ts:82-86` seeds every instance with a concrete `{used:0,total:200000,percentage:0}`, so the bar shows a confident zero regardless of what the adapter does. See the reopened section for the two required changes. Previously (2026-07-30) — the ACP adapter now emits a `context` event from the per-turn usage it already received, accumulating a session aggregate; no usage means no event (never a fake 0 %). Originally: Copilot (ACP) instances never reported context occupancy or cumulative tokens, despite the `copilot-acp` profile declaring `occupancyReporting: 'aggregate-only'` and `cumulativeReporting: 'available'` — the context bar sits at 0 % for the whole session | [WS14 evidence](./2026-07-13-fable-ws14_livetest_completed.md#evidence-run--2026-07-29-dev-app-live-copilot--claude) | [WS14 check 2](./2026-07-13-fable-ws14_livetest_completed.md#2-real-context-occupancy) |
| LT-019 | P1 | **CODE FIXED 2026-07-31; awaiting durable worker deploy + CLI retest** — Local AI Guard canaries and real auxiliary generation explicitly disable LM Studio reasoning, retaining `/no_think` as a soft fallback, so supported Qwen models do not exhaust their output budget before visible content | [Local AI Guard CLI evidence](../superpowers/plans/2026-07-30-local-ai-guard-cli_plan_livetest.md#evidence-run--2026-07-31--rebuilt-app-and-windows-pc) | [Local AI Guard CLI checks](../superpowers/plans/2026-07-30-local-ai-guard-cli_plan_livetest.md) |
| LT-020 | P1 | **FULLY CLOSED 2026-08-11** — destructive half fixed + verified live 2026-07-31 (adapter-loan registry makes the desired-runtime queue wait for the real iteration boundary; 0 kills, loop stayed `running` across the swap, was 2/2 kills before). The remaining half (should a swap re-provider a running loop) was a product decision: James chose option 3 (decouple) 2026-08-01 — loop keeps its provider, session moves, user is notified via `describeLoopProviderDivergence` — implemented, unit-tested, live-verified. The one residual (remote-node CLI-guard toast rendering) closed 2026-08-11 on branch equivalence with James's sign-off. See [`2026-07-31-swap-residuals_livetest_completed.md`](./2026-07-31-swap-residuals_livetest_completed.md) and [`2026-08-01-swap-residuals-toast_livetest_completed.md`](./2026-08-01-swap-residuals-toast_livetest_completed.md). Originally: a queued swap applied mid-iteration, SIGTERMing the CLI and terminating the loop as `completed-needs-review` [Archived detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail) | [Swap check 4 evidence](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#evidence-run--2026-07-31--dev-app-over-cdp-rebuilt-main) | [Swap check 4](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#4-swap-during-a-loop) |
| LT-021 | P2 | **FIXED + VERIFIED LIVE 2026-07-31** — `LoopActivityKindSchema` is now the single shared union and the main-process type derives from it; the post-fix log has 0 blocked `loop:activity` events (was 110 in one session). Originally: 8 of the 11 loop activity kinds were rejected by the renderer-boundary schema, so the loop activity feed never showed tool calls or results [Archived detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail) | [Swap check 4 evidence](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#evidence-run--2026-07-31--dev-app-over-cdp-rebuilt-main) | [Swap check 4](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md#4-swap-during-a-loop) |
| LT-022 | P3 | **FIXED + REGRESSION-TESTED 2026-09-23; rebuilt-app check pending** in [`2026-09-23-outstanding-plans-sweep_livetest.md`](2026-09-23-outstanding-plans-sweep_livetest.md). Each heartbeat now carries `document.visibilityState` (and a visibility change beats at once); a hidden renderer is judged against `HIDDEN_HEARTBEAT_STALL_THRESHOLD_MS` (150 s, above Chromium's one-tick-a-minute hidden throttle) instead of 10 s, so a genuine hidden-window freeze is still reported. Historical finding: `Renderer heartbeat stalled — UI event loop likely blocked` is logged at ERROR level purely because the window is hidden; a CPU profile across a full "stall" shows the renderer 100% idle | [Unexpected-exit evidence](../superpowers/plans/2026-07-17-unexpected-exit-reconciler-migration-plan_livetest_completed.md#evidence-run--2026-07-31-session-2--check-2-driven-through-the-renderer-core-assertions-pass) | Re-run any timing-sensitive renderer check with the window visible |
| LT-023 | P2 | **FIXED + VERIFIED LIVE 2026-08-12** — a crash landing inside the 5s recent-respawn suppression window used to fall straight to a terminal `error` with no `waitReason` and no further attempt, because the crude suppression sat in front of the circuit breaker and `onUnexpectedExit` was simply never called. Now deferred and retried once the window elapses, routing through the normal auto-respawn path (and, inside it, the circuit breaker's own backoff ladder) instead of dying silently [Archived detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail) | [Fix + live evidence](livetest-remediation-register.md#fix--2026-08-12--deferred-and-retried-instead-of-left-terminal-verified-live) | [Unexpected-exit check 4](../superpowers/plans/2026-07-17-unexpected-exit-reconciler-migration-plan_livetest_completed.md#checks) |
| LT-024 | P1 | **FIXED + VERIFIED 2026-07-31** — `serializeReviewResultJsonSchema` emitted Zod 4's `$schema` dialect key, which the Claude CLI rejects outright (`--json-schema is not a valid JSON Schema…`, exit 1), so **every** Claude-reviewer cross-model review failed. Key stripped; the CLI now accepts the document [Archived detail](livetest-remediation-register-archive-2026.md#lt-024-archived-detail) | [WS14 check 10 evidence](./2026-07-13-fable-ws14_livetest_completed.md#evidence-run--2026-07-31-session-2--check-10-driven-two-defects-found) | [WS14 check 10](./2026-07-13-fable-ws14_livetest_completed.md#10-structured-review-verdicts) |
| LT-025 | P1 | **FIXED + VERIFIED LIVE 2026-07-31** — with `--json-schema` the CLI returns the verdict as a `StructuredOutput` **tool_use**, not assistant text, and the parser routed it to `toolCalls` while leaving `content` empty. The parser now prefers the structured payload; check 10 passes with `repaired: false` and 0 retries. Originally: after LT-024, the in-app Claude reviewer still returned an **empty** response (`responseLength: 0`) in ~12 s, twice per review, so every review falls through format-repair and fails — while the identical schema and prompt run directly against the CLI return a complete, valid verdict object [Archived detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail) | [WS14 check 10 evidence](./2026-07-13-fable-ws14_livetest_completed.md#evidence-run--2026-07-31-session-2--check-10-driven-two-defects-found) | [WS14 check 10](./2026-07-13-fable-ws14_livetest_completed.md#10-structured-review-verdicts) |
| LT-026 | P1 | **FIXED + VERIFIED 2026-07-31** — the Seatbelt base policy granted no `mach-lookup` to securityd, so a jailed CLI could not read its own keychain credentials: every hardened instance printed `Not logged in`, exited 1 and landed in `error`. Hardened mode was unusable for any credentialed provider [Archived detail](livetest-remediation-register-archive-2026.md#lt-026-archived-detail) | [WS13 evidence](2026-07-13-fable-ws13_livetest_completed.md#evidence-run--2026-07-31) | [WS13 check 2](2026-07-13-fable-ws13_livetest_completed.md) |
| LT-027 | P1 | **FIXED + VERIFIED 2026-07-31** — Seatbelt writable roots were not realpath-resolved, and on macOS both `/tmp` and `os.tmpdir()` are symlinks, so the declared roots granted **no write access at all** (`mkdir` inside the temp root → `Operation not permitted`; with the realpath'd root → exit 0). Hardened instances died with `EPERM … mkdir aio-claude-tmp` [Archived detail](livetest-remediation-register-archive-2026.md#lt-027-archived-detail) | [WS13 evidence](2026-07-13-fable-ws13_livetest_completed.md#evidence-run--2026-07-31) | [WS13 check 2](2026-07-13-fable-ws13_livetest_completed.md) |
| LT-028 | P2 | **FIXED (refused up front) + REGRESSION-TESTED 2026-09-23; rebuilt-app check pending** in [`2026-09-23-outstanding-plans-sweep_livetest.md`](2026-09-23-outstanding-plans-sweep_livetest.md). Took the required behaviour's second option: `createCliAdapter` now refuses a hardened Codex session before building the adapter, with a message telling the operator to start it without hardened mode, instead of spawning a session that can never answer. Making Codex work inside the jail (its writable roots and MCP transport, WS13 check 8) remains a future enhancement that needs live Seatbelt evidence. Historical finding: Codex under hardened mode is unusable: the adapter logs **both** `using exec mode (app-server not available)` and `using app-server mode` 400 ms apart, and the session never answers — its MCP workers die with `Transport channel closed`. The Phase A writable-root set is insufficient for Codex | [WS13 evidence](2026-07-13-fable-ws13_livetest_completed.md#evidence-run--2026-07-31) | [WS13 checks 4 and 8](2026-07-13-fable-ws13_livetest_completed.md) |
| LT-029 | P2 | **SAFE LIMITATION IMPLEMENTED + REGRESSION-TESTED 2026-09-23; long-session refresh check pending.** Keychain writes remain outside the default hardened roots. A jailed legacy Keychain write is denied, but an actual OAuth refresh under the jail has not been observed. Credential failures now show profile-correct Sign in/Retry guidance without a path-grant prompt. | [LT-029 detail](#lt-029-hardened-keychain-refresh-limitation) | [Sweep live check 7](2026-09-23-outstanding-plans-sweep_livetest.md#check-7--lt-029-hardened-credential-refresh-and-repair) |
| LT-030 | P1 | **FIXED + VERIFIED LIVE 2026-08-01** — reciprocal interlock (the loop now waits for an in-flight runtime change) plus a single combined delivery for the replay preamble and every notice. Live: both the `provider-changed` and `loop-provider-divergence` notices reach the transcript, **0** active-turn refusals, **0** reverts, **0** SIGTERM loop kills. Originally: a provider swap on a **loop-bearing** session could not complete its post-change messaging: the loop reclaims the adapter the moment the swap lands, the replay-continuity send hangs, and the next send throws `Codex app-server runtime already has an active turn` — so the reconciler **reverts the swap**, and the user sees **no** provider-change notice at all (silently undoing LT-015 on this path) [Archived detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail) | [Divergence evidence](livetest-remediation-register.md#lt-030-a-swap-on-a-looping-session-cannot-deliver-its-own-notices) | [Swap residuals check A](./2026-07-31-swap-residuals_livetest_completed.md) |
| LT-031 | P2 | **FIXED 2026-08-01 (found in the live log, not from a check)** — an automation description over 1000 chars saved successfully but its `automation:changed` renderer event was rejected by `AutomationSchema` and dropped by `validateRendererEventPayload`, so the Automations UI kept showing the stale automation with no visible error. Root cause was an **inconsistency between two bounded caps**: the MCP write path allows 2000 and does not validate against the payload schema, the event schema capped at 1000. One shared `AUTOMATION_DESCRIPTION_MAX` (8 000) across create/update/entity. A sibling instance on `workingDirectory` (10 000 write vs 1 000 entity) was found by the gate and fixed with it | [Evidence](livetest-remediation-register.md#lt-031-a-long-automation-description-silently-never-reaches-the-ui) | live `app.log`, 2026-08-01 |
| LT-032 | P2 | **FIXED 2026-08-01** — `requestAnimationFrame` never fires while the window is hidden/occluded (measured live), but both transcript scroll-restore paths raise `isRestoringRef` synchronously and lower it only inside the frame callback. A restore begun while hidden left the guard stuck `true`, and `OutputScrollService`'s listener short-circuits on it — so scroll tracking died for that session, silently. Reachable by opening an instance then switching apps before the frame lands. All **six** frame call sites now use `runRestoreFrame()`, which races the frame against a bounded timeout and cancels the loser | [Evidence](livetest-remediation-register.md#lt-032-a-hidden-window-permanently-freezes-transcript-scroll-tracking) | [Audit plan item 2](./2026-07-17-aio-code-audit-improvement-plan_livetest_completed.md) |
| LT-033 | P2 | **FIXED 2026-08-01** — three more instances of LT-032's shape, found by an independent sweep of every `requestAnimationFrame` call site in the renderer. `scheduleTextareaResize` (**fires on every keystroke** — the composer stops auto-growing), `scheduleMeasure` (jump-rail ticks freeze), and `waitForRender` (a never-settling promise leaves `loadingOlder` true, disabling the find bar). All now use `runRestoreFrame` | [Evidence](livetest-remediation-register.md#lt-033-the-stuck-frame-guard-shape-in-three-more-components) | Found by the LT-032 completion gate |
| LT-034 | P2 | **FIXED 2026-08-11, verified live** — the context ring rendered an **aggregate-only** token count as context-window occupancy. For `copilot-acp` (and every other `occupancyReporting: 'aggregate-only'` provider) `used` is the ever-growing cumulative spend, so the ring climbs to a pinned 100 % while the real context is nearly empty. `occupancyReported: true` is set for any provider-reported usage, so the renderer cannot tell a measurement from an aggregate [Archived detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail) | [WS14 check 2 evidence](./2026-07-13-fable-ws14_livetest_completed.md) | [WS14 check 2](./2026-07-13-fable-ws14_livetest_completed.md) |
| LT-105 | P2 | **FIXED + REGRESSION-TESTED 2026-09-23; live errored-turn check pending** in [`2026-09-23-outstanding-plans-sweep_livetest.md`](2026-09-23-outstanding-plans-sweep_livetest.md). Decisions taken on the filed questions: the errored turn completes once, immediately, tagged `metadata.turnErrored`, from its accumulated NDJSON (so partial spend is recorded, not dropped); a per-turn guard (`residentTurnCompletedByError`, reset when a turn starts) stops a trailing `result` from completing it twice; the one-shot path is untouched; and the `complete` handler skips the success-only effects for an errored turn (it no longer clears the provider-limit gate, and the `Stop` hook reports `error`). Evidence gathered: across 985,811 captured Claude adapter events (2026-08-12 to 2026-09-23) no resident `type: error` event occurred, because current CLIs end failed turns with a `result`; the fix covers the legacy shape. Historical finding: An **errored** resident Claude turn still never fires `'complete'`. LT-047 fixed the `case 'result'` path; `case 'error'` in `claude-cli-adapter.ts` never calls `completeResponse()`, so a turn that fails mid-stream silently skips cost, telemetry, hooks and handoff state — the same class of gap LT-047 closed, on the failure path. The one-shot `sendMessage()` path still resolves via its process-close handler, so this is resident-mode only | Consolidation review, 2026-08-12 | `claude-cli-adapter.ts` `case 'error'` |
| LT-146 | P1 | **FIXED + VERIFIED LIVE 2026-08-18** — every Antigravity-provider instance silently ignored its configured `workingDirectory`. `agy` has its own workspace concept gated by `--add-dir`/`--project`, not the spawned process's `cwd`; the AIO adapter never passed either flag, so `agy` always operated against its own fixed default (`~/.gemini/antigravity-cli/scratch`) regardless of the working directory the user or agent selected. Confirmed both inside the harness (a fresh instance scoped to a disposable `/tmp` workspace reported reading `~/.gemini/antigravity-cli/scratch`'s 621 files instead) and independently via a direct shell `agy --print` run from the target directory, which produced the identical wrong-directory answer — ruling out a harness `cwd`-plumbing bug. Fixed by passing `--add-dir <workingDirectory>`; re-run of the same direct `agy --print --add-dir` invocation now lists the correct 2-file disposable workspace [Archived detail](livetest-remediation-register-archive-2026.md#lt-146-archived-detail) | [Provider-agnostic context evidence, check 4](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md#4-antigravity-stateless-check) | `src/main/cli/adapters/antigravity-cli-adapter.spec.ts` (2 new mutation-verified tests) |
| LT-147 | P1 | **FIXED IN CODE 2026-08-31; live re-check pending.** Raw and parsed tool-result capture now resolve the current provider mode on every capture, so flipping a running provider from `shadow`/`enforce` to `off` takes effect immediately instead of trusting the spawn-time `instance.contextEvidence.mode`. Regression coverage proves the cached mode can remain `shadow` while the live setting blocks both ingress paths | [Provider-agnostic context evidence, check 8](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md#8-provider-kill-switch-rollback) | `src/main/instance/instance-tool-result-processor.spec.ts` |
| LT-148 | P2 | **FIXED + VERIFIED LIVE 2026-08-18** — the Codex context-pressure diagnostics classifier (`classifyCodexObservedItem`) had no case for the app-server's `userMessage` item-completed echo (the model's own restatement of the user's turn content), so it fell through to the `'other'` bucket — which the discovery protocol's own safety design (`docs/superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md` §2.3.2) explicitly treats as tool-bearing "for safety". Every real turn therefore spuriously counted at least one non-tool item toward the 10-root-tool-item stop bound before any actual tool call happened, and conflated a large (18.5 KB observed on a trivial no-tool turn) non-tool item into the tool/reasoning attribution this diagnostic exists to make. Root-caused with a temporary, reverted debug log proving the raw item `type` was literally `"userMessage"` (not `"reasoning"` as first suspected). Fixed by adding a `'user-message'` class and a `case 'user_message': case 'userMessage':` branch. Live-verified end-to-end pre/post fix on the same baseline prompt: `itemClass` changed from `"other"` to `"user-message"` for the identical 18507-byte item; a follow-up small-ticket case (3 real tool calls) now reports exactly 3 tool-bearing items, 0 `"other"` [Archived detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail) | [Codex context-pressure discovery, baseline + small-ticket cases](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md) | `src/main/cli/adapters/codex/context-pressure-diagnostics.spec.ts` (2 tests, mutation-verified) |
| LT-167 | P1 | **FIXED + VERIFIED LIVE 2026-08-18** — `parseCodexAuthOutput()` checked the positive `logged in` substring before the negative `not logged in`/`login required`/`logged out` patterns, and `"not logged in"` itself contains the substring `"logged in"`, so a genuinely signed-out Codex CLI was always misclassified as `authenticated: true`. This broke both consumers of `checkCodexCliAuthentication()`: the Doctor "Codex CLI" startup-capability/provider-diagnosis row reported `healthy`/`authenticated: pass` with `rawOutput: "Not logged in"` sitting right next to it, and the mid-session auth-repair probe (`InstanceAuthRepairHandler.maybeBlockOnAuth`) vetoed every real auth-shaped Codex turn failure with "the provider still reports authenticated" — so a signed-out Codex session could never get the repair banner. Reproduced live in an isolated dev app launched with a disposable, empty `HOME` (so both the CLI's own real auth resolution and the app's probe genuinely saw no credentials — not a mock): Doctor showed `provider.codex` as `healthy` and a real Codex turn failed with a genuine `401 Unauthorized` that `detectAuthFailureSignal` matched, but the probe still vetoed the block. Fixed by checking the negative patterns first in `parseCodexAuthOutput()`. **Batch V2 (2026-08-19):** re-ran `codex-cli-auth.spec.ts` against the current tree post-rebuild — 7/7 still pass (cheap regression re-confirmation only, not independently re-driven live this session) [Archived detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail) | [In-session auth repair evidence](./2026-07-21-in-session-auth-repair_livetest.md#evidence-run--2026-08-18-batch-u--lt-167-found-and-fixed-checks-1-3-5-6-driven-live-via-a-disposable-fake-home) | `src/main/providers/__tests__/codex-cli-auth.spec.ts` (7 tests, 2 revert-verified failing on the pre-fix ordering) |
| LT-168 | P1 | **FIXED + REGRESSION-TESTED 2026-08-31; rebuilt live auth re-check pending.** Auth repair now restarts the same still-live errored instance in place instead of sending it through archive-only `SessionRevivalService`. The already-resolved failed turn, including attachments and its context block, is replayed verbatim after restart. Recovery is bounded to one automatic attempt; a failed restart/re-send restores the banner for manual retry without a background loop | [In-session auth repair evidence](./2026-07-21-in-session-auth-repair_livetest.md#evidence-run--2026-08-18-batch-u--lt-167-found-and-fixed-checks-1-3-5-6-driven-live-via-a-disposable-fake-home) | `src/main/instance/instance-auth-repair-handler.spec.ts`, `src/main/instance/__tests__/instance-lifecycle-spawn-rollback.spec.ts` |
| LT-169 | P1 | **FIXED 2026-08-18, hardened after independent gate review.** Root cause isolated: `SkillAttributionService` is a per-*process* singleton, and auto-injection (`SkillsLoader.detectRelevantSkills` → `unified-controller.ts` `fetchSkills`) runs inside the separate context-worker OS process spawned by `context-worker-main.ts` (Electron `utilityProcess`, its own module realm, its own better-sqlite3 connection — confirmed live via distinct `pid`s, e.g. main `10247` vs worker `10257`). `SKILLS_LOAD`/`SKILLS_SET_CONTROL` run in the main process against the main process's own singleton, so the explicit-load half always saw fresh writes. The old `loadControlCache()` memoized the controls `Map` **forever** after its first read per singleton instance, with no cross-process invalidation of any kind — confirmed live with debug instrumentation: the worker process's cache, once warmed on its first turn, kept serving that first snapshot indefinitely and ignored every later `setControl()` call from the main process, in **both** directions. **Fix 1 (root cause):** `loadControlCache()` now always re-queries the DB when it's available instead of memoizing past the first read; `controlCache` is kept only as a last-known-good fallback for a transient DB error and for the already-existing DB-unavailable in-memory-only mode. **Gate finding 1 (fixed):** always re-querying reintroduced a narrower version of the same failure *direction* — a transient DB read error (e.g. `SQLITE_BUSY`) on the one read that happens to race a real disable would fall back to a stale/empty snapshot and report "no override", defaulting a builtin open to `enabled`. Fixed by making `getControl()` fail **closed**: on a DB-configured-but-erroring read it now returns a synthetic `{mode:'disabled'}` for the requested skill instead of falling back to the stale snapshot, so both `getEffectiveMode()` and skills-loader's direct `getControl()` callers inherit the safe direction from the one shared method — a skill whose control state cannot be established does not fire, rather than firing anyway. Listing (`listControls()`, used only for UI display) intentionally stays best-effort, not fail-closed, since it isn't part of the injection-decision gate. **Gate finding 2 (fixed, Low severity):** removing the memoization doubled a pre-existing inefficiency — `SkillsLoader.resolveModeFor()` (`skills-loader.ts`) called `attribution.getControl(name)` once itself and then, on the fallback path, called `attribution.getEffectiveMode(name, source)`, which re-fetches the same control via its own internal `getControl()` call — two DB reads per matched skill per turn for one logical lookup. Fixed by extracting the pure, DB-free part of `getEffectiveMode()` into `resolveSourceDefaultMode()`, which `resolveModeFor()` now calls directly instead of `getEffectiveMode()`, so the control is fetched exactly once; `getEffectiveMode()` itself is unchanged for its other caller (the explicit-load IPC handler, which was already a single read). Verified: (1) the original memoization-staleness unit test, unaffected; (2) two new unit tests for the fail-closed direction using a driver wrapper that induces one transient read error, watched failing on the reverted fail-closed fix (`AssertionError: expected 'enabled' to be 'disabled'`, both tests) and passing restored; (3) a new unit test asserting `getControl()` is called exactly once per matched skill via `vi.spyOn`, watched failing on the reverted perf fix (`expected [ Array(2) ] to have a length of 1 but got 2`) and passing restored; (4) end-to-end in an isolated dev app for the root-cause fix — baseline `flaky test` send produced a `test-stabilizer` activation (warming the worker's cache), then `skillsSetControl('test-stabilizer','disabled')`, then a second real `flaky test` send produced **no** new activation (`skillsActivationsRecent` stayed at exactly 1 row for 45s post-send). **Batch V2 (2026-08-19):** re-ran `skill-attribution-service.spec.ts` + `skills-loader.spec.ts` against the current tree — 52/52 pass; a real `flaky test` send on a freshly-restarted dev app (driven for LT-170 below) also produced a `test-stabilizer` activation, an incidental live confirmation that this fix's `loadControlCache`/`getControl` path is intact end-to-end post-rebuild, though the kill-switch disable itself was not separately re-exercised this session | [Skill observability evidence](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run--2026-08-18-batch-u--check-3-kill-switch-fails-to-block-auto-injection-lt-169-filed-checks-4-7-9-driven-live), [LT-169 fix evidence](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run--2026-08-18--lt-169-root-cause-isolated-and-fixed-cross-process-controlcache-staleness), [LT-169 gate-hardening evidence](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run--2026-08-18-session-2--lt-169-hardened-after-independent-gate-review-fail-closed--single-db-round-trip) | `src/main/skills/skill-attribution-service.ts` (`loadControlCache`, `getControl`, `resolveSourceDefaultMode`, `getEffectiveMode`), `src/main/memory/skills-loader.ts` (`resolveModeFor`), `src/main/skills/skill-attribution-service.spec.ts` (new tests), `src/main/memory/skills-loader.spec.ts` (new test), `src/main/instance/context-worker-main.ts` (read, not modified — the realm split is by design and correct; only the cache invalidation was wrong) |
| LT-170 | P2 | **FIXED + REGRESSION-TESTED + LIVE-VERIFIED 2026-08-18 (Batch U2).** Root cause: `SkillAttributionService` is a per-process singleton (LT-169's own constraint), and `recordActivation()` runs inside the **context-worker child process**'s own `UnifiedMemoryController` — its `emit('activation', …)` fires on a different `EventEmitter` object than the one `registerSkillAttributionHandlers()` subscribes to in the main process. `EventEmitter` cannot cross a process boundary on its own, unlike LT-169's DB-backed `controlCache`, which could be fixed by always re-reading a value every realm shares. Fixed by adding a genuine fire-and-forget outbound message (`WorkerSkillActivationMsg`) so the worker forwards each activation over the existing worker↔main channel, and the main process re-emits it on its own `getSkillAttribution()` singleton — no changes needed to the already-correct `registerSkillAttributionHandlers()`. Live-verified end-to-end on a rebuilt dev app (fresh context-worker process required): a raw `onSkillActivationDelta` listener received the activation with no manual refresh, for the first time since this defect was first observed 2026-07-27. **Batch V2 (2026-08-19):** re-confirmed on a genuinely fresh dev app launched from the current, rebuilt `dist/main` (post 2026-08-19 01:39 rebuild) — a real new context-worker child process, not a reused warm one. A real local Claude instance's `flaky test` send produced a `test-stabilizer` `skillActivationDelta` with no manual refresh, proving the fix holds across a genuine restart, not just the process it was first proven in. Full detail below [Archived detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail) | [LT-170 section](livetest-remediation-register.md#lt-170-skillsactivation-delta-never-reaches-the-renderer-without-a-manual-refresh-cross-process-eventemitter-split), [Skill observability evidence](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run--2026-08-18-batch-u2--check-8-pass-both-halves-blocked-on-a-new-defect-lt-200-fixed-this-session-check-6-pass-core-mechanism-check-5-doctor-lint-half-pass-check-4-positive-half-root-caused-not-a-defect--an-embedding-threshold-reachability-gap-lt-170-root-caused-and-fixed) | `src/main/instance/context-worker-client.spec.ts` (2 new tests, reverted the fix via a `/tmp` copy and watched `expected [] to have a length of 1 but got +0`, then restored and confirmed 2/2 pass) |
| LT-007 | P2 | Remove obsolete “no GUI automation” and “non-interactive session” blockers from live-test guidance now that Computer Use is available | [Doc-review delivery attempt](./2026-07-13-doc-review-delivery-reconciliation-plan_livetest_completed.md#evidence-run--2026-07-16-attempt-1-autonomous-agent), [WS1 attempt](./2026-07-13-fable-ws1_livetest_completed.md#evidence-run--2026-07-16-blocked-no-rows-recorded), [context-pressure attempt](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md#live-test-attempt-log-2026-07-16) | Re-run each linked checklist with current Computer Use capabilities |
| LT-050 | P1 | **CLASSIFICATION FIX LIVE-VERIFIED 2026-08-12; confirmation handoff FIXED IN CODE 2026-09-23; rebuilt-app check pending** — `app-server-recovery-policy.ts` classified the Codex app-server "already has an active turn" collision (thrown by `captureTurn` for a `spawn_child` confirmation racing the parent's own active turn) as unrecoverable, even though the throw site already labels it `recoverability: 'retry-thread'`. The policy only read `kind`, never `recoverability`; now a `request-rejected` kind is `keepInstanceUsable: true` only when the throw site marked it `retry-thread`, leaving every other `request-rejected` (e.g. an invalid model) unchanged. Live: a Codex parent survived the identical collision 2/2 times (was 2/2 fatal before), stayed `idle`, and ended with two live orchestration children. **2026-09-23 follow-up:** the injected confirmation waits for the active parent turn, retries typed pre-send collisions, and records admission only on successful delivery; expiry leaves visible failure. Focused tests, final gates and fresh independent review passed; rebuilt-app check remains pending | [Fix + live evidence](livetest-remediation-register.md#fix--2026-08-12--fixed-at-the-classification-layer-verified-live) | `src/main/cli/adapters/codex/app-server-recovery-policy.spec.ts`; [Resilient-threads check 3](../superpowers/plans/2026-07-17-resilient-threads-sessions_plan_livetest.md#check-3--orphaned-orchestration-children-reconciled-on-restart-phase-4) (precondition unblocked, check 3 itself still not run) |
| LT-060 | P2 | **FIXED + VERIFIED 2026-08-11** — `resolveHarnessUserDataPath` ignored Electron's own `--user-data-dir` CLI switch for unpackaged launches and always resolved to the shared `<appData>/harness-dev` profile, so two concurrent dev-app livetest runners collided on the single-instance lock instead of getting isolated profiles. Added an opt-in `AIO_DEV_USER_DATA_PATH` env override (dev-only, ignored when packaged) [Archived detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail) | [Batch E infra evidence](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-12--batch-e--dev-app-isolation-defect-lt-060-found-and-fixed) | `src/main/app/user-data-path.spec.ts` |
| LT-040 | P1 | **FIXED + VERIFIED LIVE 2026-08-12** — the real Claude CLI binary reserves the literal MCP server name `computer-use` for its own built-in desktop-automation server: `My()`/`XNs()` in the CLI bundle gate every server connection through a per-project `enabledMcpServers` allowlist that defaults to *disabled* only for that exact name (every other name defaults to *enabled*), so a user-supplied `--mcp-config` server named `computer-use` was silently classified `type: "disabled"` and never spawned — no error, no log line on our side. Renamed the injected server to `harness-computer-use` (`COMPUTER_USE_MCP_SERVER_NAME` in `desktop-mcp-config.ts`) across all four provider config emitters (Claude JSON, Codex TOML, Gemini settings JSON, ACP). Live: a spawned Claude instance's `aio-mcp computer-use` child process now appears in `ps` (was **absent** in every prior sample) and the agent both listed and successfully called `mcp__harness-computer-use__computer_health`, getting real driver-health JSON back. Originally: Claude CLI never connected to the `computer-use` MCP server injected into `--mcp-config`, so no Claude-provider instance could call any `computer.*` tool even when Computer Use was enabled and healthy [Archived detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail) | [Computer Use consent/targeting evidence](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#evidence-run--2026-08-12-batch-a--computer-use-mcp-never-connects-for-any-claude-instance-lt-040), [LT-040 fix + live verification](livetest-remediation-register.md#lt-040-claude-cli-never-connects-to-the-computer-use-mcp-server-for-any-instance) | [Computer Use consent/targeting check 1](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#check-1-desktop-grants-stay-human-controlled-in-yolo-mode) |
| LT-061 | P2 | **FIXED 2026-08-12** — `argsHash` for `tool_use` observations now excludes a fixed, cross-provider/cross-tool set of cosmetic annotation field names (`description`, `reason`, `rationale`, `explanation`, `justification`, `summary`, `note`, `thought`) before hashing, instead of the narrower Bash-only/Claude-only fix the filer flagged as a scope decision. Identical operative arguments (e.g. Bash's `command`) with only annotation text varying now collapse to the same signature; a genuinely different operative argument still hashes differently. Mutation-verified unit tests (`adapter-runtime-event-bridge.spec.ts`) plus a pipeline-level test through the real `DoomLoopDetector` (`doom-loop-detector.spec.ts`). Live-verified end-to-end on a Cursor (ACP) instance: a real `repeat-no-progress` warn (count 3) then critical (count 6) fired. **Scope-narrowing discovery**: re-driving the identical scenario on **Claude** (the provider the original repro used) still produced **zero** `instance:doom-loop` events even with this fix live, because Claude's own CLI adapter never emits `tool_use`/`tool_result` as live events at all — only the ACP adapter (Copilot/Cursor/Grok) does. That is a separate, more fundamental wiring gap, filed as **LT-062** | [LT-061 fix verification + LT-062 discovery](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-12-lt-061-fix-verification-and-lt-062-discovery) | [Sibling-audit check A2](2026-07-30-sibling-audit-round2_livetest.md#lt-check-a2--tool-loop-warning-toast-ws-a2) |
| LT-062 | P1 | **FIXED 2026-08-12, verified live** — `observeToolLoopEvent()` (`instance-tool-loop-wiring.ts`) now also bridges `kind: 'output'` events whose `messageType` is `'tool_use'`/`'tool_result'` (every non-ACP adapter's real path) into the same detector, gated on `metadata.transport !== 'acp'` so `AcpCliAdapter`'s own raw+output dual-emit is never double-counted. Live investigation found the filed root cause was subtly incomplete: Claude's modern streaming path never emits an `output` `tool_result` message at all for an ordinary (non-error, non-permission-denial) call — only `tool_use` — so the message-layer bridge alone cannot pair Claude's calls. Fixed with an additional small, non-UI change: `claude-cli-adapter.ts` now also raw-emits the `tool_result` `EventEmitter` event `AcpCliAdapter` already uses, for every `tool_result` content block, so Claude's pairing reaches the detector via the pre-existing raw-event path instead. Mutation-verified unit + pipeline tests (`instance-tool-loop-wiring.spec.ts`, `claude-cli-adapter.spec.ts`, `instance-manager.normalized-event.spec.ts`). Live-verified on a real Claude yolo instance: the identical 8-call `cat watch.txt` polling loop that produced 0 events before now fires `repeat-no-progress` warn (count 3) then critical (count 6). Known residual: Codex/Gemini's real-time tool_use/tool_result `output` messages carry no correlation id at all, so they still only reach `runaway` counting, not pairing — a genuine per-adapter gap, not addressed this session (see fix write-up) [Archived detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail) | [LT-062 fix + live verification](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-12-lt-062-fix-and-live-verification) | [Sibling-audit check A2](2026-07-30-sibling-audit-round2_livetest.md#lt-check-a2--tool-loop-warning-toast-ws-a2) |
| LT-055 | P2 | **FIXED 2026-08-12** — `RLMContextManager.executeQuery()` now lazily indexes a context store for `semantic_search`, exactly once per store, before the query runs, memoized per store id (`pendingSemanticIndexing`) so concurrent queries dedupe onto one in-flight indexing promise and a failed attempt is evicted so the next query retries. Both fallback-to-keyword paths (no vector store attached; vector store attached but zero matches) now log observably instead of silently. Correction to the original write-up: `context-storage.ts`'s `addSection()` op already attempts eager, unawaited vector indexing on every write (since 2026-07-15) — the original "zero production callers" claim for `indexStoreForSemanticSearch` was incomplete. The real gap is a race: that write-time embed is fire-and-forget, so a `semantic_search` issued immediately after `rlmAddSection` can run before it lands, reproducing the observed `totalVectors: 0`. The lazy, **awaited** index-on-first-query fix closes this deterministically (it also catches up any section the fire-and-forget write missed) | [WS16 evidence](./2026-07-13-fable-ws16_livetest_completed.md#check-5--root-caused-2026-08-01-the-rlm-surface-cannot-emit-a-trace-today), [LT-055 section](livetest-remediation-register.md#lt-055-rlms-general-context-stores-never-populate-the-vector-store-so-semantic_search-silently-degrades-to-keyword) | `context-manager.semantic-indexing.integration.spec.ts` (real SQLite + mocked embedding service, 5 tests incl. concurrency dedup + retry-after-failure), `context-search.spec.ts` (LT-055 observability describe block) — all mutation-verified |
| LT-065 | P1 | **FIXED + VERIFIED 2026-08-12** — the WS5 degraded-retry workspace-write observer (`createAttemptDeltaObserver`) resolved its own `workspace` root with plain `path.resolve()`, but `discoverWorkspaceRepositories`'s `git rev-parse --show-toplevel` always returns the REAL (symlink-resolved) path. For any loop workspace reached through a symlink — on macOS that is anything under `/tmp` (`/private/tmp`) — the two roots diverged by exactly the symlink prefix, so every `path.relative(workspace, absolutePath)` in `toWorkspaceFileChange` started with `../` and was silently dropped: a real file write reported as `changes: []` / `workspaceEffect: 'none-observed'`, defeating the exact replay guard WS5 exists to provide. Live: a killed mid-turn Claude CLI that had already written `write1.txt` to `/tmp/aio-lt-degraded` was auto-retried instead of paused for review (ITERATION_LOG.md logged "files changed: 0" for both the killed iteration and the following full-length iteration that also wrote a second file). Fixed by realpath-resolving the observer's `workspace` root (falls back to plain `path.resolve` when the target doesn't exist yet, preserving the existing "workspace cannot be read" behavior) [Archived detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail) | [Loop convergence check 5 evidence](../superpowers/plans/2026-07-14-loop-convergence-and-cost-safety-plan_livetest_completed.md#evidence-run--2026-08-12--check-5-blocked-by-a-reproducible-defect-filed-as-lt-065-fixed) | `src/main/orchestration/loop-attempt-observation.spec.ts` ("still observes a new file when workspaceDir is reached through a symlink") |
| LT-090 | P2 | **FIXED + VERIFIED LIVE 2026-08-12** — `recordCompletionCost` never recorded a cost entry for a resident **Codex** app-server turn either, via a mechanism unrelated to LT-047: `'complete'` fired reliably but `response.usage` was `undefined` whenever `turn/completed`'s own `usage` field came back empty (reproduced fresh, independently, on a real tool-using turn: 0/1 `tokensUsed`/`costUsd`, 0 cost entries). Root cause pinned down: `thread/tokenUsage/updated`'s `last` sample already carries a full per-call input/output/cache/reasoning breakdown that was captured for the context bar but never consulted for cost. Fixed with a new `lastTurnUsageBreakdown` field (reset per turn to avoid stale reuse) that `codex-app-server-turn-adapter.ts` falls back to, mutually exclusive with the existing `turn.usage` path so a turn's cost is never double-counted. Live-verified post-fix: 2/2 real turns (tool-using + trivial) recorded correct `tokensUsed`/`costUsd` and exactly one `costGetEntries` row each (was 0/2 before). Re-verified LT-047's resident-Claude fix remained intact through this session's unrelated `buildArgs` extraction. **New finding from the same investigation, filed separately**: Cursor and Grok (both on the shared `AcpCliAdapter`) also recorded 0 cost entries for real turns — a different-shaped gap (the ACP server never reports `usage`, not an adapter defect the same way) — see **LT-100**, not fixed, needs a product decision [Archived detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail) | [LT-090 fix + live verification](livetest-remediation-register.md#fix-and-live-re-verification--2026-08-12-cost-tracking-follow-up-batch) | `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts` ("LT-090: cost tracking when turn/completed has no usage", 3 mutation-verified tests) |
| LT-095 | P1 | **FIXED and live-verified 2026-08-12** — `computer.request_app_grant` (and the sibling App Store/Play release-gate and Microsoft calendar mutation approvals, which share the same `PermissionRegistry` primitive and had the identical gap) had **no renderer UI anywhere** for a human to approve or deny a pending request. Fixed by adding a renderer-reachable IPC surface (`permission-registry:list-pending`/`resolve`/`extend`) plus a root-level `PendingApprovalsBannerComponent` (mounted in `app.component.html` next to the Browser Gateway approvals banner) that lists every pending `PermissionRegistry` request app-wide with context (risk badge, description, requesting instance, countdown) and Approve/Deny/+2min-extend actions. `PermissionRegistry.extend()` is new. Live-verified end-to-end in an isolated dev app: a real spawned Claude instance's `computer.request_app_grant` call appeared in the banner within its 60s window, Extend pushed the deadline out (confirmed via DOM read), Approve produced a real grant with `decidedBy: "user"` (`desktopListGrants` confirmed it), and a second request's Deny produced no grant and a `decidedBy: "user"` deny audit entry. ACP tool-permission requests are deliberately excluded from the new list (`details.transport === 'acp'`) because they already have a working approval path via `acp-cli-adapter.ts`'s `input_required` chat flow; adding a second resolver would race the existing one. The App Store/Play and calendar flows were not live-triggered (real publish/calendar side effects, no safe way to fabricate a livetest run) but are covered by mutation-tested unit tests exercising their exact `action` values through the same generic handler code path — the fix required no per-action branching. See [LT-095 section](livetest-remediation-register.md#lt-095-no-ui-exists-to-approve-or-deny-a-computerrequest_app_grant-request) for the fix writeup [Archived detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail) | [Computer Use consent/targeting evidence](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#evidence-run--2026-08-12-batch-cu--checks-1-and-4-blocked-by-a-new-defect-lt-095), [LT-095 section](livetest-remediation-register.md#lt-095-no-ui-exists-to-approve-or-deny-a-computerrequest_app_grant-request) | [Computer Use consent/targeting check 1](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#check-1-desktop-grants-stay-human-controlled-in-yolo-mode), [check 4](../superpowers/plans/2026-08-09-computer-use-consent-and-targeting_livetest.md#check-4-tight-activation-to-input-sequence-preserves-the-fail-closed-focus-boundary) |
| LT-100 | P2 | **FIXED + LIVE-VERIFIED 2026-08-12** — Cursor and Grok (shared `AcpCliAdapter`) recorded zero cost for real turns because `toCliUsage()` returned `{ duration }` only when the ACP server sent no `usage`. James's decision: estimate, but never silently. `AcpCliAdapter` now falls back to `estimateTokens()` over the turn's prompt/response/tool-call material (extracted to `acp-usage-estimator.ts`) and tags the result `isEstimated: true`; `CostEntry`/`CostSummary` carry the flag through persistence (migration 059) to every read surface (cost page totals/model/session/entry rows, the `cost-recorded` renderer event schema, the cost-attribution JSONL sink) so an estimate never blends into a total that reads as measured. Guarded two adjacent surfaces that would otherwise have silently corrupted on estimated data: token-counter calibration (would have compared the heuristic against itself) and WS8 prompt-cache analytics (no real cache signal exists for an estimated turn). Live-verified: a real Cursor turn now records a `costGetEntries` row with `isEstimated: true`, non-zero cost, and the LT-018 context bar still shows `used: 0` (occupancy stays honest); a real resident-Claude turn in the same session still records `isEstimated: false` with real cache-token accounting (LT-047/LT-090 unaffected). Copilot verified source-level only (same `AcpCliAdapter` code path via `createCopilotAdapter()`; no seat available this session) [Archived detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail) | [LT-100 section](livetest-remediation-register.md#lt-100-acp-transport-providers-cursor-and-grok-confirmed-record-zero-cost-when-the-acp-server-omits-usage) | `acp-usage-estimator.spec.ts`, `acp-cli-adapter.spec.ts` (LT-100 describe block), `cost-tracker.spec.ts`, `instance-communication.spec.ts` (LT-100 describe block), `cost-attribution.spec.ts`, `renderer-event-validation.spec.ts`, `cost-page.component.spec.ts` — all mutation-verified |
| LT-136 | P2 | **FIXED + VERIFIED LIVE 2026-08-18** — `SnapshotManager.listSnapshots()` (the only source for the checkpoint timeline UI and its badge count) reads from an in-memory `SnapshotIndex` that never carried `name`/`description`/`trigger`, so it hardcoded `trigger: 'auto'` and omitted `name` for every entry regardless of what was actually persisted to disk. A manual pre-compaction checkpoint (WS-B7's `applyCompaction()`, labeled e.g. "Before manual compaction (keep latest 1 exchange)", `trigger: 'checkpoint'` on disk) was therefore indistinguishable in the timeline from a routine per-turn safety checkpoint — both rendered as an unnamed "Checkpoint {id}" tagged "Auto". Live-verified: confirmed the correct `name`/`trigger: "checkpoint"` on disk (`session-continuity/snapshots/*.json`) for both a manual-compaction checkpoint and the app's own routine "Before: {message}" per-turn checkpoints, while the running renderer showed "Auto" with no name for every one of them. Fixed by carrying `name`/`description`/`trigger` through `SnapshotMeta` and all three `SnapshotIndex.add()` call sites (create, startup disk rebuild, session import), and reading them back in `listSnapshots()` instead of hardcoding. Re-verified live post-fix (rebuilt `dist/main`, restarted the dev app so the index rebuilt from disk): the checkpoint timeline now correctly shows "Checkpoint" (not "Auto") with the real label for both a `previewCompaction`→Confirm run and a plain `compactInstance` ("Compact Now") run [Archived detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail) | [Sibling-audit check B7](2026-07-30-sibling-audit-round2_livetest.md#lt-check-b7--compaction-preview-dialog-ws-b7) | `src/main/session/__tests__/snapshot-manager.spec.ts` (extended existing test, reverted the fix and watched it fail on the pre-fix hardcoded `trigger: 'auto'`/missing `name`, then pass) |
| LT-137 | P3 | **FIXED 2026-09-10** — corrected root cause: not a timing race, the Claude CLI process has already exited by the time a deferred-tool-use decision fires, so `resumeAfterDeferredPermission`'s `waiting_for_permission → respawning` transition *always* threw `IllegalTransitionError`, invisible to CI because the existing spec fully mocked `transitionState`. Fixed by adding `'respawning'` to `waiting_for_permission`'s allowed transitions in `instance-state-machine.ts`; new regression test wires the real state machine and was mutation-checked against the exact original throw. Full `src/main/instance/` suite green (128 files/1654 tests); all canonical gates green. Originally found live-observed: approved a Bash permission prompt with `decisionScope: 'session'`, then called `interruptInstance` before the auto-resume completed; `app.log` shows `DeferredPermissionHandler.resumeAfterDeferredPermission` attempting `waiting_for_permission → respawning`, which the state machine correctly rejected (`IllegalTransitionError`) and logged as `Auto-resume after deferred permission failed` — no crash, but the approved tool call was never executed and the instance needed a further explicit prompt-response to recover | [Sibling-audit check A5](2026-07-30-sibling-audit-round2_livetest.md#lt-check-a5--admission-suppression-in-the-live-app-ws-a1a5) | [Plan doc LT-137 section](./2026-07-19-livetest-failure-remediation_plan_completed.md) |
| LT-138 | P2 | **FOUND 2026-08-18, FIXED (found already implemented and independently verified live) 2026-08-24.** No Settings UI existed anywhere to grant the per-project `allowPrCreation` opt-in that Gate 1 of `PrCreationService.createPullRequest()` requires before a PR-creation attempt can even reach the (correctly implemented) never-delegable approval dialog; a user hit a dead end pointed at "project settings" that did not exist. **Fix (landed in the working tree between the 2026-08-18 finding and this session, decided in `2026-08-19-open-decisions-resolved.md`: "build the control"):** a real "Allow PR creation" checkbox in `SourceControlRepoActionsComponent` (`prCreationAllowed` computed, `onTogglePrCreation` handler), writing `settingsStore.set('allowPrCreation', {...})` keyed by the repo's absolute path — the exact same key/shape `resolvePrCreationOptIn()` reads, canonicalized on both ends so read and write always agree. The refusal message was also corrected to `"...in the Source Control panel for this repository first."`, pointing at the control that now exists. Batch E (2026-08-24) verified this live rather than trusting the diff: `npm run test:quiet` on the component's spec — 6/6 pass; a real `vcsCreatePullRequest` call with the opt-in map empty reproduced the exact corrected refusal message live; `setSetting('allowPrCreation', {<path>: true})` persisted and read back correctly via `getSettings()`. Did not proceed past Gate 1 to the native OS approval dialog (Gate 2), matching the original finding's own reasoning — a CDP `Runtime.evaluate` call cannot click a native `dialog.showMessageBox`, and clicking it would need local Mac UI control this session was not granted; Gate 1↔UI wiring is fully verified live, Gate 2 itself was already known-correct from the original 2026-08-18 finding and is unchanged by this fix | [Sibling-audit check B1](2026-07-30-sibling-audit-round2_livetest.md#lt-check-b1--pr-creation-round-trip-ws-b1) | `src/renderer/app/features/source-control/source-control-repo-actions.component.ts` (+68 lines), new `source-control-repo-actions.component.spec.ts` coverage (+155 lines), `src/main/vcs/pr-creation-service.ts` (refusal-message text only) |
| LT-139 | P1 | **FIXED + VERIFIED LIVE 2026-08-18** — `AutomationActionSchema` (`packages/contracts/src/schemas/automation.schemas.ts`) never declared WS-C7's `executionProfile`/`containedFallback` fields, even though the shared `AutomationAction` type and the renderer's Automation builder form (`automations-page.component.ts`) both set them. `z.object()` strips unknown keys by default, so `validateIpcPayload(AutomationCreatePayloadSchema, ...)` silently dropped both fields on every create/update — an automation built with "Contained" selected in the UI persisted and then **ran as `'standard'` (full, unsandboxed host access) with no error anywhere**, exactly the silent downgrade `AutomationExecutionProfile`'s own doc comment says must never happen. Live-reproduced end-to-end: created a real `contained`+Claude automation via `automationCreate`; the stored `action` had no `executionProfile` field at all, and firing it (`automationRunNow`) spawned a completely normal, unsandboxed Claude instance that ran to completion — the WS-C7 requirement ("contained on Claude → run fails at fire time, never spawns") was structurally unreachable. Fixed by adding both fields to `AutomationActionSchema` (consumed by create, update, and the full read/broadcast `AutomationSchema`, so one fix covers all three). Re-verified live post-fix (rebuilt `dist/main`, restarted dev app): the same contained+Claude automation now correctly fails at fire time with `"Contained runs require Codex — claude cannot enforce isolation."`, `instanceId: null` (never spawned); a contained+Codex automation now runs and its child process's Bash tool call to write outside the workspace failed with `Operation not permitted` (real OS-level sandbox enforcement confirmed, not just a config flag), and `ps eww` on the spawned `codex app-server` process showed no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GH_TOKEN`/`AWS_*` env vars. **Batch V2 (2026-08-19):** re-confirmed the schema-persistence half specifically, against an isolated dev app (production automations unaffected — `list_automations` read 33 before and 33 after) — created a real `contained`+Claude automation via `automationCreate`, then read it back with a *separate* `automationGet` call (not the create echo) which still returned `executionProfile:'contained'`/`containedFallback:'fail'` on the stored `action`, confirming genuine persistence; deleted it and confirmed `automationGet` then returned `{success:true, data:null}` | [Sibling-audit check C5/C7](2026-07-30-sibling-audit-round2_livetest.md#lt-check-c5c7--authority-cards--contained-runs) | `packages/contracts/src/schemas/__tests__/automation.schemas.spec.ts` (3 new tests: create round-trip, update round-trip, invalid-value rejection — reverted the schema to `HEAD` and watched all 3 fail with the pre-fix silent-drop behavior, then pass restored) |
| LT-130 | P2 | **FIXED + REGRESSION-TESTED 2026-08-12 (not live-verified against the packaged app)** — the packaged app's `app.log` shows `RendererHeartbeat` logging thousands of `error`-level "Renderer heartbeat stalled — UI event loop likely blocked" / "recovered" pairs, continuously, every single day since at least 2026-08-08, not confined to one 17-minute window. Every burst starts within ~60-90s of a `RuntimeDiagnostics` "System power event observed" (`source: lock-screen`) entry and stops shortly after the matching `unlock-screen`/`resume`. Root cause: Chromium throttles a backgrounded/locked-screen renderer's timers to roughly once a minute (`stalledMs` is consistently ~60000ms, `missedBeats: 0` — a single coalesced tick, not a real freeze), and `RendererHeartbeatMonitor` — unlike `RuntimeDiagnostics`'s own main-process stall detector, which already has a `systemSuspended` gate for exactly this case — has no suspend/lock-screen awareness, so it misreports every lock-screen period as a genuine renderer freeze. Fixed by adding `handleSystemSuspend()`/`handleSystemResume()` to `RendererHeartbeatMonitor`, gating `scan()` while suspended and rebasing `lastBeatAt` to now on resume, wired from `RuntimeDiagnostics`'s existing `noteSystemSuspend`/`noteSystemResume` alongside the other services it already notifies | [LT-130 section](livetest-remediation-register.md#lt-130-rendererheartbeat-misreports-every-lock-screen-period-as-a-ui-freeze) | `src/main/logging/renderer-heartbeat-monitor.spec.ts` (3 new tests, mutation-verified) |
| LT-160 | P1 | **FIXED + VERIFIED LIVE 2026-08-18** — `instance.waitReason` (quota-park / auth-required) was never written onto the canonical main-process `Instance` object, only onto the renderer-bound `pendingUpdates` batch. Every other field the same batch queue carries (`status`, `contextUsage`, `desiredRuntime`, …) is *also* assigned directly onto the live object by its own caller; `waitReason` (added Phase 6/§G) was the one exception, across all three of its call sites (`InstanceProviderLimitHandler`, `InstanceAuthRepairHandler`, and the loop coordinator's D7 quota-park wiring). Consequence: `SessionAdmissionService.admitAutomatedWrite()` and the mobile gateway's input queue both gate synchronously on `instance.waitReason?.kind`, and both were structurally blind to every quota-park/auth-required wait state. Reproduced live: parked a real instance via the actual production `InstanceProviderLimitHandler.maybePark()` call (not a mock) — `isParked()` correctly returned `true` and the real "parked until …" offer notification fired — yet `SessionAdmissionService.admitAutomatedWrite()` against the same instance still returned `{kind: 'admitted'}` instead of `{kind: 'suppressed', reason: 'quota-parked'}`, meaning an automated/orchestration/mobile-queued write would have been sent straight through to a CLI mid-park. Fixed by writing `waitReason` directly onto the live `Instance` in `InstanceStateManager.queueUpdate()` — the single function every caller already funnels through — mirroring the existing status/contextUsage pattern [Archived detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail) | [WS7 Phase B evidence, check 6](./2026-07-13-fable-ws7-phaseb_livetest_completed.md#check-6--offered-switch-on-a-long-park--pass-defect-found-lt-160-fixed) | `src/main/instance/instance-state.spec.ts` ("LT-160: writes waitReason directly onto the live instance, not only the pending broadcast", reverted the fix and watched it fail with `expected undefined to match object`, then pass) |
| LT-161 | P1 | **FIXED + VERIFIED LIVE 2026-08-18 — completeness pass found four more dropped fields, not just `failoverProviders`.** The renderer's `InstanceListStore.deserializeInstance()` — an explicit field-by-field allowlist mapper, not a spread — never included `failoverProviders`, even though main always sends it (`listInstances()` confirmed it present) and the renderer's own `Instance` type declares it; every renderer hydration path (`stateResync()`, `addInstance` on creation) routes through this one function, so `canOfferFailover()` (`composer-banners.component.ts:304-308`) could never be true and the WS7 Phase B "Switch provider" button could never render. A second, independent review asked whether that was the only field dropped — it was not. Enumerating the full renderer `Instance` interface (`instance.types.ts:90-176`) against what `deserializeInstance` actually reconstructs (`instance-list.store.ts:687-791`), confirmed each of these is also present on the wire (main sends the full live object via `{...rest}` spreads in both `serializeInstance()`, the CREATE response, and `serializeForIpc()`, the snapshot/`instance:added` payload) and dropped by the mapper: **`hardened`** (never in the batch-update payload either, so this was its *only* path in — consumer: `composer-banners.component.ts:315-318` `showHardenedDenialBar`, the WS13 hardened-session-died banner, never renders for any hardened instance, no recovery short of instance removal+recreation); **`contextEvidence`** (same story — consumer: `context-bar.component.ts:319`, `contextEvidence?.conversationId` permanently `undefined` via this path); **`fastMode`** (dropped, also absent from the batch-update payload — on every `loadInitialInstances()` resync/restart the FAST badge, `instance-header.component.html:229-240`, resets to OFF regardless of real state; in-session toggling still worked via a different local-patch path, which is exactly why this stayed invisible); **`executionLocation`** (dropped here though it *is* carried on later batch updates, `transport.types.ts:93` — every remote-node instance shows as local, in the remote badge and project-rail grouping, right after resync/creation until some later `queueUpdate` happens to carry it, not guaranteed for an idle remote session — consumers: `project-rail-builder.service.ts:590-593`, `project-group-computation.service.ts:111-112`, `instance-row.component.ts:148-152`, `dashboard-project-context.ts:31-32`). Cleared as *not* actionable: `isRenamed` (zero renderer reads) and `pendingYoloMode` (excluded by explicit design comment at `instance-list.store.ts:398` — sourced from `desiredRuntime` instead). Failure scenario: restart the app with a hardened, fast-mode, remote, or context-evidence session and the corresponding banner/badge/lookup silently goes blank, off, or local — four distinct wired features degrading silently on every resync, two of which (`hardened`, `contextEvidence`) never self-recover. Fixed by adding all four to `deserializeInstance()`. Also added a structural completeness test (not just the four individual field assertions) — it builds a fixture covering every wire field, runs it through `deserializeInstance()`, and asserts each one survives except the two deliberately-excluded fields, so a fifth dropped field fails loudly instead of passing silently the way these five did. **Batch V2 (2026-08-19):** closed the "four fields not separately live-driven" residual. Exercised the real running `InstanceListStore` in a dev app freshly launched post-rebuild (`window.ng.getComponent(document.querySelector('app-dashboard')).store['listStore'].addInstance(wire)` with a synthetic wire object covering all five fields, including `executionLocation:{type:'remote', nodeId:...}`) — `addInstance()` and `stateResync()` both call the identical `deserializeInstance()`, so this exercises the exact restart-path code. All five fields survived in `store.instancesMap()`. A genuine remote-node `forceNodeId` spawn was attempted first but could not be produced in an isolated dev-app profile (windows-pc's pairing is scoped to the app process it dialed into; got a real `"Forced nodeId not reachable"` warn with `nodeStatus:"not-found"`), so the synthetic-wire route was used for that field instead — same underlying mapper either way [Archived detail](livetest-remediation-register-archive-2026.md#lt-161-archived-detail) | [WS7 Phase B evidence, check 6](./2026-07-13-fable-ws7-phaseb_livetest_completed.md#check-6--offered-switch-on-a-long-park--pass-defect-found-lt-160-fixed-second-defect-found-lt-161-fixed) | `src/renderer/app/core/state/instance/instance-list.store.spec.ts` — the original `failoverProviders` test, plus "LT-161: deserializeInstance carries every wire field forward (structural completeness)" (reverted the four-field fix and watched it fail — `field "contextEvidence" should survive deserializeInstance(): expected undefined to deeply equal {...}` — then restored and confirmed 23/23 pass) |
| LT-181 | P1 | **FIXED + LIVE-VERIFIED 2026-08-18 (fix made symmetric after a completion-gate finding)** — two near-simultaneous `POST /api/instances/:id/input` calls on the mobile gateway for the same busy-adjacent instance could both read `instance.status` as not-yet-busy and both proceed straight to `sendInput()`, so the loser got the adapter's raw `"Codex app-server runtime already has an active turn"` rejection landed in the transcript as an `error` message — the exact pre-queue bug the mobile-gateway queue feature exists to prevent, reproduced live by accident while setting up a routine "queue while busy" check. Root cause: `shouldQueueInput()`/`isReadyForQueuedInput()` read `instance.status`, which only flips to a busy status once the adapter's `sendInputImpl` actually runs, itself several `await`s deep inside `InstanceManager.sendInput()` — a real window where two callers can both observe a stale, not-yet-busy status. The first pass fixed only the direct-vs-direct pairing with a guard set/cleared inside `handleInput()`; a fresh completion gate reproduced the *symmetric* gap it missed — a direct send racing an in-flight **queue delivery** (`MobileInputQueue.deliverNext()` calling `deliver()` straight through, never marking anything) still reached the adapter a second time, because the queue-drain path never set the guard. Closed by routing *both* callers through one shared helper, `MobileGatewayServer.dispatchSend()`, which is now the only place that marks/clears a renamed `sendInFlight: Set<string>` around the adapter call — `handleInput()`'s direct-send branch and the `inputQueue`'s `deliver` dependency both call it instead of `sendInput()` directly, so there is one place to get this wrong rather than two that must be kept in step. `MobileInputQueueDeps.isPaused` remains widened to a per-instance `isPaused(instanceId): boolean` so the queue's post-enqueue drain safety-net does not redeliver into any in-flight send, direct or queue-drained. Live-verified: real concurrent `curl` sends against a real dev-app `codex` instance no longer produce the raw provider error; a controlled sequential race (busy-then-queued) delivers in order with no transcript error [Archived detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail) | [Mobile queue/interrupt evidence, LT-181](2026-07-25-mobile-queue-interrupt-draft_livetest.md#lt-181--found-and-fixed-a-genuine-race-lets-the-pre-fix-already-has-an-active-turn-error-back-into-the-transcript-fix-made-symmetric-after-a-completion-gate-finding) | `src/main/mobile-gateway/mobile-gateway-server.spec.ts` — two tests: "queues a direct send that races an in-flight direct send for the same instance (LT-181)" and "queues a direct send that races an in-flight QUEUE DELIVERY for the same instance (LT-181)". Watched both fail on a full revert (`sendInput` called twice, `queued: undefined`, plus a 10s `afterEach` hook timeout on the first); additionally watched only the second (queue-drain) test fail, with the first still passing, against an isolated partial revert that restored just the direct-vs-direct guard — isolating that the completion gate's finding was real and specific to the queue-drain path. Restored the full fix and confirmed 114/114 across both spec files |
| LT-192 | P2 | **FIXED + REGRESSION-TESTED 2026-08-18 (fix corrected after a completion-gate finding; not live-verified against a real Graph mutation — no accounts are connected on this machine)** — `OrchestratorToolsRpcServer.handleRequest()` requested blocking human approval for `graph_calendar_create_event`/`update_event`/`delete_event` *before* checking whether the target account exists and is agent-writable, so an operator could be asked to approve (and an unattended caller could hang for the full 5-minute approval window on) a mutation `requireWritableAccountKey()` was always going to reject once approved. Observed live with zero connected Microsoft accounts (`graph_calendar_status` → `{"accounts":[]}`) after another agent's `graph_calendar_create_event` call blocked on an unanswerable approval and timed out client-side with no side effect. Fixed with a shared `dispatchCalendarMutation()` in `orchestrator-tools-rpc-calendar.ts` that runs the LT-192 account precondition (`assertCalendarMutationAccountPrecondition`, reusing the exported `requireWritableAccountKey`) before requesting approval, for create/update/delete only; `graph_calendar_connect` is deliberately exempt since connecting is how an account is created and must run with zero accounts. **Completion gate found a real regression in the first pass**: the precondition extracted `payload.account` with a hand-rolled `typeof … === 'string' ? … : ''`, comparing the raw, untrimmed value, while the real handler's own `AccountSchema` (`z.string().trim()...`) trims before resolving — a whitespace-padded but otherwise valid, connected, writable account (plausible from an LLM-composed tool call) would be falsely rejected by the precondition before approval was even requested, though the same call would have succeeded pre-LT-192. Fixed structurally by exporting `AccountSchema` and adding `extractRequestedAccount()`, which normalizes via `AccountSchema.safeParse` — the exact same schema instance the real handler's payload schema already applies to this field — so the precondition and the real resolution share one normalization rule and cannot drift apart again. Kept out of the RPC server itself (a thin one-call-site caller) so it never grows direct knowledge of Graph account-resolution internals | [LT-192 section](livetest-remediation-register.md#lt-192-calendar-mutation-approval-requested-before-checking-the-target-account-can-possibly-succeed) | `src/main/mcp/orchestrator-tools-rpc-server.spec.ts` (3 fail-fast tests, 1 connect-still-approves test, plus 1 new whitespace-padded-account test added after the gate finding; reverted the precondition call and watched the 3 fail-fast tests fail with `promise resolved "undefined" instead of rejecting`, then separately reverted just the normalization back to the hand-rolled extraction and watched only the new whitespace test fail with `Calendar mutation is not permitted for agent calendar mutations:   james@communitytech.co.uk  `; restored both times and confirmed 68/68 pass across the affected spec files) |
| LT-188 | P2 | **FIXED + REGRESSION-TESTED 2026-08-19 (Batch N3) — unit-level only, not re-driven live end to end this session.** Root cause confirmed by reading `context-compactor.ts`/`compaction-runtime.ts` directly: `ContextCompactor.addTurn()`'s own `autoCompact` trigger fires an un-awaited `this.compact()` as soon as the shared singleton's `fillRatio` crosses `triggerThreshold` mid-loop, and `CompactionRuntime.restartCompact()`'s manual "Compact Now" path rebuilds the whole transcript via a loop of `addTurn()` calls before making its own unconditional `await compactor.compact()` call — so a manual compaction on a large transcript races its own auto-trigger on the same mutable `this.state`. Confirmed `addTurn()` has exactly one production caller (`compaction-runtime.ts`'s `restartCompact()`), so the auto-trigger firing mid-rebuild is always redundant with that same function's own trailing explicit `compact()` call, never a genuine live-turn addition. **Fix:** added an `options.suppressAutoCompact` parameter to `addTurn()`; `restartCompact()`'s rebuild loop (both the evidence-preview turn and the per-message loop) now passes `{ suppressAutoCompact: true }` on every call, so the bulk rebuild never fires the auto-trigger and the loop's own trailing `await compactor.compact()` is the only compaction that runs. No behavior change for any other caller (there are none in production today; the default auto-trigger path is otherwise untouched). **Regression tests** (`context-compactor.spec.ts`, new `addTurn auto-compact suppression (LT-188)` describe block, 3 tests): suppressed `addTurn` over threshold does not fire `compaction-started`; unsuppressed `addTurn` still does (baseline, unchanged); a 10-call bulk-rebuild loop shape (mirroring `restartCompact()`) fires `compaction-started` exactly once, from the trailing explicit `compact()` call. Reverted the fix via a `/tmp` copy (restored the un-suppressed condition) and watched exactly those 2 threshold-crossing tests fail — `expected "spy" to not be called at all, but actually been called 1 times` — with all 58 other tests in the file staying green; restored and confirmed 60/60 pass. Also ran the sibling `compaction-runtime.spec.ts` (15/15) to confirm the two call-site signature changes didn't regress the existing suite. Gates: `tsc --noEmit` ×2 clean, `ng lint` clean, `check:ts-max-loc` unaffected, `build:main` green. **Not independently re-driven live end to end this session** — the 2026-08-18 evidence run's own live repro needed a real `claude` instance grown past 85% fill (~680KB of synthetic turns) at ~$5–6 of real provider spend per round and 20+ minutes wall clock; given this fix is a narrowly-scoped, mechanically-verified change (unit-proven via revert) to the exact two call sites the diagnosis names, that live re-run was judged not worth repeating the cost for this session — flagged for the next session that wants full live closure | [Local AI Guard checks 3/4](../superpowers/plans/2026-07-26-local-ai-guard_plan_livetest_completed.md#evidence-run--2026-08-18-batch-w2) | `src/main/context/__tests__/context-compactor.spec.ts` ("addTurn auto-compact suppression (LT-188)", 3 tests, reverted and watched 2 fail, then restored and confirmed 60/60 pass); files touched: `src/main/context/context-compactor.ts` (`addTurn`), `src/main/app/compaction-runtime.ts` (`restartCompact`'s two `addTurn` call sites) |
| LT-189 | P3 | **RESTORED IN CODE 2026-09-23; rebuilt-app check pending.** The passive notify-and-allow banner passed a 2026-08-21 live check, was later removed, and has now been restored on James’s decision. That prior live proof does not verify the restored build. | [LT-189 detail](#lt-189-notify-and-allow-fallback-policy-has-no-notificationbanner-delivery-anywhere) | [Owning live check](../superpowers/plans/2026-07-26-local-ai-guard_plan_livetest_completed.md) |
| LT-190 | P2 | **FIXED + REGRESSION-TESTED 2026-08-18** — `computeProviderTokenCost()`/`getProviderModelRate()`'s `normalizePricingProvider()` only recognized the upstream vendor names (`anthropic`/`openai`/`google`), mapping them to the CLI-facing ids (`claude`/`codex`/`gemini`) `PROVIDER_MODEL_LIST`/`MODEL_PRICING` are keyed by — but `LocalAiRoutingGuard`'s own `resolveFallbackModel()` (`local-ai-runtime.ts`) feeds it `settings.defaultCli`, which is *already* one of those CLI-facing ids (e.g. `"claude"`). Since `"claude"` never matched the vendor-name switch, `getProviderModelRate()` always returned `undefined`, so every Local AI Guard fallback routing event's pre-authorization `estimatedCostUsd` was silently omitted — for every user with a normal (non-`"auto"`) default-provider setting, not an edge case. Live-reproduced: with `defaultCli: 'claude'`, several real `compression`-slot fallback routing events persisted with `provider: 'claude', model: 'opus[1m]'` but `estimated_cost_usd: NULL` in `local_ai_routing_events`. Fixed by making `normalizePricingProvider()` pass through an id that is already a `PROVIDER_MODEL_LIST` key (identity) before falling back to the vendor-name switch — the vendor-name mapping (used by the separate, correctly-wired post-call `applyLocalAiRoutingCostAttribution()` path, which reports real vendor names like `"anthropic"`) is unaffected. Re-verified live post-fix (rebuilt `dist/main`, restarted the dev app): the next real fallback routing events persisted `estimated_cost_usd: 0.38982` / `0.50535` — correctly computed, no longer silently dropped | [Local AI Guard checks 3/4](../superpowers/plans/2026-07-26-local-ai-guard_plan_livetest_completed.md#evidence-run--2026-08-18-batch-w2) | `src/shared/data/model-pricing.spec.ts` ("getProviderModelRate provider-id aliasing (LT-190)", 4 tests after the completion-gate follow-up below; reverted the fix and watched the collision test fail with `expected { input: 5, output: 25 } to be undefined`, then restored and confirmed 20/20 pass). **Completion-gate finding, same day:** the identity-passthrough widening this fix introduced let `copilot`/`cursor` (which reuse primary-vendor raw model ids for pass-through models) silently price at the wrong vendor’s rate instead of staying unpriced — closed by scoping the static-table fallback to an explicit vendor allowlist; see the register entry. |
| LT-193 | P3 | **FIXED + COMMITTED, found already fixed by Batch Q2 (2026-08-21) while investigating an adjacent doc — not this batch's fix, status corrected from stale "not fixed."** Already in `HEAD` (`git log` shows `fc90e707 Livetest fixes`; not part of any batch's uncommitted work) at the time of this check: `LocalAiIncident.unpricedDispatchCount` exists (`shared/types/local-ai-guard.types.ts:227,323`), is populated in `local-ai-row-mappers.ts:267,480,604`, and all three originally-named render sites now read it — `local-ai-target-card.component.ts:479-487` and `local-ai-incident-panel.component.ts:292-302` both render `"cost unknown (N unpriced)"` distinct from a priced `$0`, and `local-ai-effectiveness-panel.component.html:76` renders "N unpriced — cost unknown, not zero" from `summary.unpricedDispatchCount`. Regression coverage exists in `local-ai-target-card.component.spec.ts`, `local-ai-incident-panel.component.spec.ts`, `local-ai-effectiveness-panel.component.spec.ts`, and `local-ai-guard.store.spec.ts` (not re-run/re-verified live by Batch Q2 — this is a source-reading correction of a stale status label, not a fresh live-test pass). Original finding retained below for history: An *unpriced* Local AI Guard fallback dispatch is silently rendered as a literal `$0` in incident and effectiveness totals. `addAccountingCost()` (`src/main/local-ai-guard/local-ai-row-mappers.ts:655-659`) coalesces an absent cost with `const total = current + (incoming ?? 0)` when rolling a routing event into `LocalAiIncident.estimatedCostUsd`, which is a required non-nullable `number` (`src/shared/types/local-ai-guard.types.ts:217,311`). That total is rendered directly as a dollar figure in `local-ai-target-card.component.ts:479`, `local-ai-incident-panel.component.ts:295-296` and `local-ai-effectiveness-panel.component.html:71`, so "cost unknown" is indistinguishable from "cost was zero". The layer below already gets this right and is the model to copy: `LocalAiFallbackSpend` stores `NULL` rather than `0` and tracks a separate `unknown_reservations` counter (`local-ai-fallback-spend.ts:50-55`), and `exceedsConfiguredCeiling()` (`local-ai-fallback-store.ts:268-275`) correctly treats an undefined estimate as *exceeding* the ceiling. **Pre-existing, not introduced by LT-190** — before LT-190 essentially every fallback event was undefined-cost, so this collapse affected all providers; after LT-190 it is narrower, affecting only the deliberately-unpriced `copilot`/`cursor`/`ollama`/`antigravity`. Partly a genuine gray area for Copilot, which is a subscription seat where $0 marginal cost is arguably correct — but it should still be *distinguishable* from unknown. Surfaced by the LT-190 second completion gate, which traced past the ceiling-check layer it had been asked to verify and found the coalesce one level further downstream | [LT-190 gate follow-up](livetest-remediation-register.md#lt-193-unpriced-fallback-dispatches-display-as-0-rather-than-unknown) | Aggregate an `unknownCostCount` alongside `estimatedCostUsd` on `LocalAiIncident` the way `LocalAiFallbackSpend` already does, and render "—" or "$X + N unknown" rather than a bare total |
| LT-206 | P2 | **FIXED + REGRESSION-TESTED 2026-08-18 — diagnosis independently confirmed empirically, not just re-read.** Verified live on a real dev app: attached diagnostic listeners on main's `RLMContextManager.getInstance()`/`getWakeContextBuilder()` singletons via a main-process inspector, then created a real instance through the actual renderer `createInstance` path — the RLM `store:created` row landed correctly in `rlm.db` (worker executed `createStore()`) and `ContextWorkerClient.buildWakeContextText()` returned real wake text (126 chars), yet the diagnostic array stayed empty for both — while a *control* call to `getWakeContextBuilder().generateWakeContext()` made directly in main fired the same listener immediately, proving the listener wiring itself was fine and the worker boundary was the only break. Repeated end-to-end through the real renderer preload surface (`onRlmStoreUpdated`/`onRlmSectionAdded`/`onWakeContextGenerated` listeners attached before `createInstance`): zero events received across three real instance creations, confirming the renderer genuinely never sees these channels in production usage. Also empirically confirmed `wake:hint-added` is **not** dead — `addHint()` has no worker call path in production (only main-process callers: `wake-context-handlers.ts`, `knowledge-bridge.ts`, `codebase-miner.ts`), and a live `wakeAddHint()` → `onWakeHintAdded()` round-trip through the real renderer succeeded immediately; no fix needed there. **Fix:** rather than a third and fourth bespoke worker→main message (this is now the 3rd/4th occurrence of the exact same bug class), added a single generic mechanism in new `src/main/instance/context-worker-event-forwarding.ts`: `registerWorkerEventForwarding()` (worker-side, called once from `context-worker-main.ts`) subscribes an allowlist of clone-safe `(singleton, event)` pairs — `RLMContextManager`'s `store:created`/`section:added`/`section:removed`/`query:executed` and `WakeContextBuilder`'s `wake:context-generated` — and posts each across the existing worker↔main transport as `{type:'worker-event', source, event, payload}`; `dispatchWorkerBroadcast()` (main-side, called from `ContextWorkerClient.handleMessage`) re-emits the payload on main's own matching singleton, which the existing `setupRlmEventForwarding`/`setupKnowledgeEventForwarding` (`ipc-main-runtime-wiring.ts`) subscriptions then forward to the renderer unmodified. LT-170's skill-activation message was folded into the same dispatcher (`dispatchWorkerBroadcast` now handles both `'skill-activation'` and `'worker-event'`) so there is one place this mechanism lives instead of two; LT-170's existing tests were re-run unmodified and still pass. Deliberately did NOT attempt to also unify the codebase-indexing lane worker's separate `RLMContextManager` instance (`codebase-indexing-lane-main.ts`, a third process with its own singleton, discovered incidentally while tracing callers) — out of scope for this ticket, flagged as a related finding below, not fixed. Double-emission checked and ruled out: main-process direct call sites for these same events still exist (e.g. `RLM_CREATE_STORE`'s IPC handler in `learning-ipc-handler.ts` calls `rlm.createStore()` directly on main's singleton) but they operate on distinct `ContextStore`/session instances from the worker-routed per-session path, so forwarding does not duplicate delivery for the same logical event | [LT-170 gate follow-up](livetest-remediation-register.md#lt-206-rlm-and-wake-renderer-events-are-dead-for-the-worker-routed-paths) | `src/main/instance/context-worker-event-forwarding.spec.ts` (9 new tests: worker-side registration posts the right wire message per event, a `wake:hint-added` negative-control test, main-side dispatch re-emits on main's singleton, and 3 end-to-end `ContextWorkerClient` tests simulating the real transport). Reverted the fix via a `/tmp` copy (stubbed `registerWorkerEventForwarding`/`dispatchWorkerBroadcast` back to skill-activation-only, reproducing the exact pre-fix behavior) and watched 7 of 9 tests fail — e.g. `expected "spy" to be called with arguments: [ { type: 'worker-event', … } ] / Number of calls: 0` and `expected [] to deeply equal [ { id: 'store-1', … } ]` — while the 2 orthogonal tests (the `wake:hint-added` negative control and the RPC-bookkeeping-untouched check) correctly still passed; restored and confirmed all 9 pass again, plus the full context-worker test set (13 tests across 3 files) and 227 tests across 15 adjacent RLM/wake/skill/instance-manager spec files unaffected. One pre-existing test (`context-worker-main.spec.ts`) needed its `wake-context-builder` mock widened from `{getWakeUpText}` to also include `on`/`emit`, since the module-load-time subscription now exercises more of the real `WakeContextBuilder` (`EventEmitter`) surface than before — a legitimate mock-completeness fix, not a behavior change. **Batch V2 (2026-08-19):** closed the "not live-verified against a rebuilt/restarted app" residual. Dev app launched fresh from the current, rebuilt `dist/main` (real new process, real new context-worker child). Listeners attached before `createInstance()`; a real local Claude instance's message produced `rlmStoreUpdated` ×5, `rlmSectionAdded` ×4, `wakeContextGenerated` ×1 in the renderer with no manual refresh |
| LT-207 | P3 | **FIXED + REGRESSION-TESTED 2026-08-18 — diagnosis independently confirmed empirically, not just re-read.** The **fifth** instance of the worker-process event-visibility class (after LT-169, LT-170, and LT-206's two). Verified live before fixing: static trace confirmed `codebase-indexing-lane-main.ts` had no `registerWorkerEventForwarding`/`dispatchWorkerBroadcast` import anywhere (the pre-fix absence LT-206's gate had already flagged), then a real dev app was driven over `--inspect` — a diagnostic listener attached to main's `RLMContextManager.getInstance()` first received a **control** `section:added` fired directly on main (`createStore`+`addSection` with no worker involved) to prove listener wiring was fine, then a **real** `CodebaseIndexingLaneGateway.indexCodebase()` call indexed a real one-file directory through the real forked/utility-process lane worker: pre-fix reasoning (the absent import) and post-fix live behavior were both exercised, and post-fix the real indexing run's `section:added` (section name `ltTwoZeroSevenMarker`, matching the indexed file's exported function) landed on main's singleton exactly once — no double-delivery, confirmed by a clean single-listener count after a fresh app restart. **Fix:** reused LT-206's generic mechanism instead of a third bespoke forwarder. Worker side (`codebase-indexing-lane-main.ts`): a guarded `ensureWorkerEventForwarding()` calls `registerWorkerEventForwarding()` with a transport that wraps the payload as a new `{ type: 'worker-event', message }` `LaneOutboundMessage` variant (`background-jobs/types.ts`) and posts it over the existing lane `send()` channel — called once per worker process, positioned *after* `RLMDatabase.getInstance()` is configured with the job's `userDataPath` but *before* the first `RLMContextManager.getInstance()` call, because `RLMContextManager`'s constructor eagerly resolves `RLMDatabase.getInstance()` with no config and both are `getInstance()` singletons where the first caller wins — registering forwarding first would have permanently pinned the RLM database to its default (wrong) path for the worker's lifetime. Main side: `ProcessLaneGateway` re-emits the new message type as a `'worker-event'` event (`process-lane-gateway.ts`), `BackgroundJobRuntime.registerLane()` passes it through unopinionated (`background-job-runtime.ts`), and `CodebaseIndexingLaneGateway`'s constructor subscribes and calls `dispatchWorkerBroadcast()` unmodified (`codebase-indexing-lane-gateway.ts`) — the exact same LT-206 function, not a copy. Payload clone-safety: unchanged from LT-206 — `addSection()`'s `{store, section}` payload is the identical plain-data shape LT-206 already validated for the context worker's `section:added`, since both paths emit through the same `RLMContextManager.addSection()`. Noted and left as-is: `RLM_SECTION_ADDED`/`RLM_STORE_UPDATED` forwarding to the renderer is still gated by the pre-existing, unrelated `isHighVolumeContextStore()` filter (`store.config.kind === 'codebase-auto'`) in `ipc-main-runtime-wiring.ts` — the live check above deliberately used a plain (non-`'codebase-auto'`) store to isolate the process-boundary fix from that filter; auto-indexed codebases (created via `codebase-indexing-auto-coordinator.ts`, which does tag `'codebase-auto'`) will still not emit per-section renderer updates, which is an intentional, separate high-volume-suppression decision, not a defect. Added a new import-isolation guard test (`codebase-indexing-lane-main-import-isolation.spec.ts`, modeled on the context-worker's sibling guard) since none existed for this lane before and the fix's new import (`context-worker-event-forwarding.ts`) pulls `skill-attribution-service.ts` and `wake-context-builder.ts` into the lane's closure for the first time; confirmed zero `electron` value-imports in the resulting 107-module closure | [LT-206 gate follow-up](livetest-remediation-register.md#lt-206-rlm-and-wake-renderer-events-are-dead-for-the-worker-routed-paths) | `src/main/indexing/codebase-indexing-lane-main.spec.ts` ("LT-207: forwards a section:added fired by this lane's own RLMContextManager to main over the transport") and `src/main/indexing/codebase-indexing-lane-gateway.spec.ts` ("LT-207: dispatches a worker-event broadcast from the indexing lane onto main's RLMContextManager") together cover both halves of the transport. Reverted each fix file individually via a `/tmp` copy and watched its own new test fail with all sibling tests in the same file staying green: the worker-side test failed with `expected "spy" to be called with arguments: [ { type: 'worker-event', … } ] ` (only `ready`/`job-started`/etc. were posted, no `worker-event`), the gateway-side test failed with `expected [] to deeply equal [ { …(2) } ]` (nothing reached main's `RLMContextManager`); restored both and confirmed 6/6 and 8/8 pass respectively, plus 110/110 across `src/main/background-jobs` + `src/main/indexing` and 40/40 across the LT-206 context-worker spec set, unaffected. **Batch V2 (2026-08-19):** not independently re-driven live this session — attempted via `rlm.createStore()` + `codebaseIndexStore()` on a disposable one-file `/tmp` directory, but the indexing lane's own worker-process `RLMContextManager` reported `"Store not found"` for a store created that way (the two processes' in-memory registries don't share a store created outside the real `codebase-indexing-auto-coordinator.ts` workflow); not pursued further given the existing end-to-end evidence above already includes a real indexing run through the actual lane worker and a fresh app restart |
| LT-208 | P3 | **FIXED 2026-08-19** (status corrected 2026-09-23): the retry-preservation condition is now `enabled === true && active !== false` (`automation-scheduler.ts:101`), per [`2026-08-19-open-decisions-resolved.md`](2026-08-19-open-decisions-resolved.md). Historical finding, 2026-08-18 — a latent trap, not a reproducible defect today. `AutomationScheduler`'s LT-195 retry-preservation branch (`src/main/automations/automation-scheduler.ts:99`) distinguishes "async echo of the failure that armed this retry" from "a genuine disable racing a pending retry" by testing `event.automation?.enabled === true`, and its comment (`:108-110`) states as fact that *every* disable path flips `enabled` and never `active`. The LT-195 second completion gate verified that is true of every current call site — `AUTOMATION_UPDATE`, `update_automation`, the renderer `togglePaused`, auto-disable-after-failures — **but nothing enforces it**: `AutomationUpdatePayloadSchema.updates` (`packages/contracts/src/schemas/automation.schemas.ts:177`) permits a caller to set `active: false` independently of `enabled`. A future caller disabling that way while a retry was armed would silently reopen the exact P1 the gate caught (a disabled automation still firing). Filed because this codebase produced **five** instances of one recurring class today (LT-169, LT-170, LT-206 ×2, LT-207) — an invariant asserted in a comment but unenforced in code is the same shape of latent recurrence | [LT-195 gate-2 follow-up](livetest-remediation-register.md#lt-195-automation-retrybackoff-silently-cancelled-by-an-async-automationchanged-race) | Harden the condition to `enabled === true && active !== false` (strictly safer, no behaviour change today since the echo path carries `active: true`), or restrict the schema so `active` cannot be set independently; add a test asserting a retry is cancelled when an automation is disabled via `active: false` alone |
| LT-200 | P1 | **FIXED + REGRESSION-TESTED 2026-08-18** — the instance-detail Review panel's `runReview()` sent `reviewStartSession({ agentId: agentIds[0], instanceId, workingDirectory, files, options: { agentIds, diffOnly } })` through the raw preload API, but `ReviewStartSessionPayloadSchema` requires `{ instanceId, agentIds: string[], files, diffOnly? }` — no `agentId` (singular), no `workingDirectory`, no `options` wrapper. Every call from this panel therefore failed Zod validation every time, for every agent: live-reproduced with `REVIEW_START_SESSION_FAILED: "agentIds: Invalid input: expected array, received undefined"`. This is the panel the skill-observability livetest's check 8 names ("review panel agent list should show 'Design Drift Analyzer'"), so check 8 was structurally unreachable through it regardless of which review agent was selected. The sibling `reviews-page.component.ts` was unaffected — it goes through `OrchestrationIpcService.reviewStartSession()`, which already builds the correct shape. Fixed the call site to build `{ instanceId, agentIds, files, diffOnly }` and corrected the preload wrapper's stale TypeScript parameter type (`orchestration.preload.ts`) to match the real schema so a future caller cannot compile against the wrong shape again | [Skill observability check 8](./2026-07-23-skill-observability-and-design-skills_livetest.md#check-8--design-drift-review-agent----blocked-by-lt-200-fixed) | `src/renderer/app/features/instance-detail/instance-review-panel.component.spec.ts` ("LT-200: runReview() sends a reviewStartSession payload shaped for ReviewStartSessionPayloadSchema", reverted the fix via a `/tmp` copy and watched it fail — `expected { …(5) } to deeply equal { instanceId: 'inst-1', …(3) }` — then restored and confirmed 21/21 pass) |
| LT-215 | P3 | **FIXED IN CODE 2026-08-31; live re-check pending.** Child completion now uses the session-admission result as the exact restart-window boundary: when the completion response is suppressed because the parent is unavailable, the child/admission pair is retained even though the live reap removes it from `childrenIds`. Fresh-fallback reconciliation drains that record into `droppedChildIds` and cancels the obsolete redelivery; successful same-session redelivery clears it. This removes the arbitrary timestamp/product-decision requirement | [Resilient threads/sessions check 3](../superpowers/plans/2026-07-17-resilient-threads-sessions_plan_livetest.md#evidence-run--2026-08-18-batch-s3--check-3-precondition-and-race-both-cleared-live-defect-found-lt-215) | `src/main/orchestration/orchestration-handler.spec.ts` |
| LT-220 | P2 | **DECIDED + DOC-CORRECTED 2026-08-31.** Historical finding: The Antigravity adapter (`antigravity-cli-adapter.ts:6-8`) carries a comment stating `agy` "has no `--output-format stream-json` mode" — factually false; `agy --help` (installed binary, this session) lists `--output-format` with values `text, json, stream-json`, plus `--input-format stream-json`. Because the adapter was built on that false premise, it always spawns `agy --print` in the plain-text default and only ever emits `type: 'assistant'`/`'error'` `OutputMessage`s — it never emits `type: 'tool_result'`/`'tool_use'` messages and never calls `bindRawAdapterProviderEvents`'s `captureToolResult` hook. Both context-evidence capture entry points (`InstanceToolResultProcessor.captureParsedEvidence`, keyed off `tool_result` messages, and `.captureRawEvidence`, keyed off raw adapter tool-call events) are therefore never invoked for any Antigravity instance, in any `contextEvidenceModeByProvider.antigravity` mode (`off`/`shadow`/`enforce` all produce identically zero evidence records) — confirmed live: a fresh `antigravity` instance (`ishhajrvx`, workspace-scoped correctly per the LT-146 fix) given a two-real-tool-call prompt (list dir, read file) completed normally and correctly quoted the file contents, but `contextEvidenceList` returned `[]` with `captureFailureCount: 0` (no error — the pipeline was simply never entered). Contrast: `gemini-cli-adapter.ts` (the adapter the provider-agnostic-context-evidence doc's check 4 assumed Antigravity shares a fallback code path with) *does* emit real `type: 'tool_result'` events (`gemini-cli-adapter.ts:302`) and so does get captured — meaning check 4's premise ("this exercises the identical stateless-provider code path" as Gemini) is itself wrong: the two providers' capability *declaration* (`sameThreadContinuation: false`) matches, but their actual tool-result *instrumentation* does not, and only the instrumentation gap decides whether any evidence is ever produced [Archived detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail) | [Provider-agnostic context evidence, check 4](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md#4-antigravity-stateless-check) | Not yet written — this is a product/scope decision, not implemented unilaterally: (a) correct the adapter's stale comment and switch it to `--output-format stream-json`, then parse the resulting NDJSON tool-call/tool-result events the same way `gemini-cli-adapter.ts` does, wiring them into `emit('output', {type:'tool_result', …})` so `captureParsedEvidence` picks them up — the larger, more correct fix but a real adapter-rewrite with its own risk (streaming/partial-JSON handling, backward compat for any code depending on the current plain-text `parseOutput()` shape); or (b) accept zero Antigravity evidence capture as an intentional, documented capability gap (`toolResultVisibility: 'none'` is already the conservative default it inherits) and correct the doc's check 4 wording instead of the code. Add a regression test asserting `antigravity-cli-adapter.ts` never claims a code path it doesn't implement, once (a) or (b) is decided |
| LT-221 | P1 | **FIXED + REGRESSION-TESTED 2026-08-19.** Opening any context-evidence record's card (`contextEvidenceGetCard`, the "Open card" button in `app-context-evidence-panel`) failed **unconditionally, for every provider, every conversation, every session** with `EVIDENCE_AUDIT_FAILED` — confirmed live in the real dev-app UI (focus-emulated CDP, not a stale-render artifact): after enabling `contextEvidenceModeByProvider.claude = 'shadow'`, driving a real Claude turn with tool calls, opening the instance context-bar's Evidence panel, and clicking a real record's "Open card" button, the panel rendered `EVIDENCE_AUDIT_FAILED` at the top instead of card content. Root cause, confirmed directly against the isolated dev profile's live SQLite file (`sqlite3 conversation-ledger.db "INSERT INTO evidence_access_log (...) VALUES (..., 'get-card', ...)"` → `Error: stepping, CHECK constraint failed: operation IN ('list', 'search', 'read', 'compare', 'verify')`): migration `004_context_evidence`'s `evidence_access_log` table CHECK constraint never included `'get-card'`, even though `EvidenceAccessLogInput`'s own TypeScript type (`context-evidence-ledger.types.ts:189`) always declared `'get-card'` as a valid `operation` value — the SQL and the type drifted apart at some point after the type was written. Every `contextEvidenceGetCard` call audits itself via `evidence-card-retrieval.ts`'s `audit()` helper with `operation: 'get-card'` (line 190); that `INSERT` always violated the CHECK constraint, `logEvidenceAccess()` always threw, and the bare `catch { throw new EvidenceRetrievalError('EVIDENCE_AUDIT_FAILED') }` (`evidence-card-retrieval.ts:196-198`) swallowed the real SQLite error and surfaced only the generic code — masking the root cause from ordinary log-reading for as long as this bug existed. `contextEvidenceList`/`search`/`read`/`compare`/`verify` are unaffected (their operation values were already in the CHECK list) — only card-opening was broken | [Provider-agnostic context evidence, check 7](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md#7-ui-inspection-human) | `src/main/conversation-ledger/__tests__/conversation-ledger-schema.spec.ts` ("LT-221: allows a get-card evidence_access_log row and preserves existing rows across the rebuild") |
| LT-222 | P1 | **FIXED + REGRESSION-TESTED 2026-08-19.** `redactSecretField()` (`src/main/diagnostics/redaction.ts`, the field-level redactor `redactValue`/`redactForSink` — i.e. **every** `logger.info`/`logger.warn`/etc. call in the app — uses for any key matching `SECRET_KEY_PATTERN`, e.g. any key containing `token`) mishandled `null`/`undefined`: `typeof null !== 'string'/'boolean'/'number'`, so it fell into the function's final `return '<redacted-secret>'`, turning a legitimate `null` into the literal **string** `"<redacted-secret>"` — silently corrupting any `number \| null` field whose key happens to be secret-shaped, the instant it is actually `null`. Live-reproduced via Codex context-pressure diagnostics (`AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, a real dev app, a real Codex turn): the first turn's `turn-start` record logs `baselineUsedTokens: number \| null` (legitimately `null` — no prior baseline yet) and `token-usage`'s first request logs `previousLastTotalTokens: number \| null` (legitimately `null` — no prior request yet); both key names contain "token" and both arrived on disk as `"<redacted-secret>"` instead of `null`, which `scripts/analyze-codex-context-pressure.ts`'s schema validation then correctly rejected as malformed (expecting `number \| null`, got a string) — 3 of 6 real diagnostic lines from one ordinary turn were corrupted this way. `redactSpanAttributes()` (the sibling OTel-attribute redactor) already passed non-strings through correctly and was unaffected; only the general `redactValue`/`redactForSink` path used by the logger had the gap | [Codex context-pressure observability, evidence run 2026-08-19](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md) | `src/main/diagnostics/__tests__/redaction.spec.ts` ("LT-222: passes through null/undefined under a secret-shaped key instead of stringifying to <redacted-secret>") |
| LT-223 | P2 | **FIXED + REGRESSION-TESTED 2026-08-19.** `scripts/codex-context-pressure/types.ts`'s `ItemClass` type and `ITEM_CLASSES` allowlist (the analyzer's own, separately-maintained copy of the valid `itemClass` values for `item-completed` diagnostic records) never included `'user-message'`, even though `classifyCodexObservedItem()`'s real return type, `CodexObservedItemClass` (`src/main/cli/adapters/codex/context-pressure-diagnostics.ts`), has included it since **LT-148** (2026-08-18, fixed the classifier so the user's own turn echo is no longer miscounted as a tool-bearing item). The analyzer's allowlist was never updated to match, so every real `item-completed` record with `itemClass: 'user-message'` — i.e. the exact shape LT-148 introduced — was silently rejected as malformed by `scripts/analyze-codex-context-pressure.ts`, and the doc's own §11 privacy-validator snippet (`2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md`) independently carried the same stale allowlist and would flag a legitimate `'user-message'` value as a "privacy failure." Live-reproduced: a real baseline-case Codex turn's `user-message` item-completed record (18,508 bytes) was counted as 1 of the run's malformed records; after the fix, the identical live data (6/6 diagnostic records) parses cleanly with 0 malformed, and the generated `report.md`'s item-size table correctly lists a `user-message` row. Fixed both: added `'user-message'` to `ItemClass`/`ITEM_CLASSES`, and to the doc's own §11 `strings` allowlist (documentation-content fix, not a behavior change) | [Codex context-pressure observability, evidence run 2026-08-19](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md) | `scripts/__tests__/analyze-codex-context-pressure.spec.ts` ("LT-223: accepts an item-completed record with itemClass \"user-message\" instead of rejecting it as malformed") |
| LT-194 | P2 | **FIXED + REGRESSION-TESTED 2026-08-18** — the Workboard Decision Timeline's "manual compaction" source (`buildCompactionDecisions`, reading `CompactionCoordinator.getEpochTracker(instanceId).getHistory()`) could never show an entry: `CompactionEpochTracker.onCompaction()` — the only method that ever pushes into `.history` — had zero call sites in production code, and `incrementTurn()` (which feeds `turnsBeforeCompaction`) had none either. Live-reproduced: ran a real `compactInstance()` on a real Claude session, then queried `workboardGetDecisionsForItem({instanceId})` and got `[]`. Fixed by calling `getEpochTracker(instanceId).onCompaction()` in `executeCompaction()` on every successful compaction (native or restart-with-summary), and `getEpochTracker(instanceId).incrementTurn()` in `onContextUpdate()` (the existing per-turn context-usage report hook) so `turnsBeforeCompaction` reflects real activity instead of always reading 0. Re-verified live post-fix (rebuilt `dist/main`, restarted the dev app): a real compaction now produces `{"source":"compaction","title":"Context compacted after 7 turns"}`, rendered in the real Workboard item detail DOM as `"Decision timeline … Context compacted after 7 turns"` | [Sibling-audit round 2 livetest, check C1](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-18--batch-s2) | `src/main/context/compaction-coordinator.spec.ts` ("CompactionCoordinator epoch tracking (LT-194 — Workboard decision timeline feed)", 4 tests; reverted both call sites via a `/tmp` copy and watched exactly those 3 new assertion-bearing tests fail — `expected [] to have a length of 1` — then restored and confirmed 22/22 pass) |
| LT-195 | P1 | **FIXED + REGRESSION-TESTED 2026-08-18 (fix corrected after a completion-gate finding)** — the WS-B10a/B10b automation retry/backoff mechanism was structurally broken for every one-time automation (manual `runNow`, provider-limit-resume automations, and any user-created one-time schedule): `AutomationRunner.handleTerminalRun()` synchronously schedules a retry timer via `this.retryScheduler(...)`, then (for a oneTime run) calls `emitAutomationState()`, which ASYNCHRONOUSLY (`store.get(automationId).then(...)`) re-emits `'automation:changed'`. By the time that async event lands, the automation's own `nextFireAt` has already gone `null` (the schedule "spent" by firing), so `AutomationScheduler`'s generic `'automation:changed'` listener fell to its `else` branch and called the FULL `deactivate()` — cancelling the just-armed retry timer within ~1ms of it being scheduled, every time, silently: no error, no auto-disable (the streak is deliberately not incremented while a retry is believed pending), just a run stuck at attempt 1 of N forever. Live-reproduced and root-caused with certainty via a Node-inspector-instrumented `deactivate()` (stack trace captured): `AutomationScheduler.deactivate ← automation:changed listener ← AutomationEvents.emit ← emitChanged ← automation-runner.js:433 (emitAutomationState's .then())`, with `retryHandlesBefore` showing the just-armed handle present at the moment it got wiped. **First-pass fix (superseded — see gate finding below):** added `AutomationScheduler.hasPendingRetry(automationId)` and preserved the retry (`deactivateSchedule()` only) whenever it was true, for ANY `'automation:changed'` event, reasoning that "a genuine disable/delete has no pending retry to preserve" — re-verified live at the time (rebuilt `dist/main`, restarted the dev app): a real failing one-time automation genuinely retried and the Workboard Decision Timeline showed `"Retried automatically — attempt 2 of 3"`. **Completion-gate finding (P1 regression, fixed same day):** that reasoning was wrong for a *disable*, not just delete — `AUTOMATION_UPDATE` (`automation-handlers.ts`) and the `update_automation` MCP tool (`automation-tool-impl.ts`) both call `scheduler.schedule(automation)` (fire-handle only, never `deactivate()`/`cancelRetry()`) then `events.emitChanged(...)` on an ordinary disable — reachable from the "Pause" toggle in the Automations UI, not an edge path. The gate reproduced empirically (replaying the real `store.update({enabled:false})` → `scheduler.schedule()` → `emitChanged()` sequence) that `retryHandles.size` stayed `1` when it had to be `0`: a user disabling an automation while a retry was counting down saw it "off" in the UI but had it fire anyway later — for the auto-created provider-limit resume automations specifically, an unexpected session resume against something the operator believed disabled. Also not limited to oneTime: `handleTerminalRun` does not gate retry scheduling on `isOneTimeRun`, so a cron automation disabled mid-backoff hit the identical gap. **Corrected fix:** the `'automation:changed'` listener's retry-preserving branch now additionally requires `event.automation?.enabled === true` — the one field every disable path in this codebase actually flips (the Automations-page "Pause" toggle, `AUTOMATION_UPDATE`, and `update_automation` all only ever change `enabled`, never `active` on their own; a fired run's own post-fire echo never touches it either), so this isn't a heuristic that happens to work for the known cases, it's the same authoritative on/off bit those write paths themselves use. Re-ran gates post-correction: `tsc` ×2, `ng lint`, `check:ts-max-loc`, `build:main`, and the full `src/main/automations` suite (165/165) all green | [Sibling-audit round 2 livetest, check C1](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-18--batch-s2) | `src/main/automations/automation-retry-integration.spec.ts` ("LT-195 — oneTime retry survives the automation:changed race", now 4 tests: the original echo-preserves-retry repro, a no-pending-retry disable control, and two completion-gate-driven additions — a genuine `enabled:false` disable racing an ARMED retry for a oneTime automation, and the same for a cron automation, both asserting `retryHandles.size` reaches `0` and the timer never fires (`insertRetryRun` not called). Reverted only the corrected condition (the `event.automation?.enabled === true` guard) via a `/tmp` copy, reinstating the first-pass `hasPendingRetry(...)`-only check, and watched exactly the two new disable-races-a-retry tests fail (`expected 1 to be +0`) with all other 25 tests — including the original echo-preserves-retry repro — staying green; restored and confirmed 27/27 pass). **Batch V2 (2026-08-19):** closed the "not live-re-verified after the correction" residual against a disposable automation on an isolated dev app (production automations unaffected — 33 before, 33 after). A one-time automation with a nonexistent `workingDirectory` failed fast and deterministically on `automationRunNow`, arming a retry (`app.log`: `delayMs:31318`); that retry fired ~31s later, failed again, and armed a third retry (`delayMs:60343`). With that third retry genuinely armed, `automationUpdate({enabled:false})` was called through the same production `AUTOMATION_UPDATE` path the Pause toggle uses. Polled past the computed fire time: no third run row ever appeared, `nextFireAt` stayed `null`, and `app.log` recorded no `"Firing automation retry"` for attempt 3 — the corrected `event.automation?.enabled === true` condition holds against the real, unmodified production write path, not just a replayed unit-test sequence |
| LT-196 | P2 | **FIXED 2026-09-13 — implemented, seven review rounds, final independent review PASS; live end-to-end checks pending in [`2026-09-06-lt196-correction-miner_livetest.md`](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest.md). Plan: [`2026-09-06-lt196-correction-miner_plan_completed.md`](../superpowers/plans/2026-09-06-lt196-correction-miner_plan_completed.md).** SCOPE CORRECTED 2026-09-06 — wider than "Claude only", and the miner's own source comment is wrong.** Verified against the executing code: the live spawn path for **Copilot, Cursor and Grok** builds `AcpCliAdapter` (`adapter-factory.ts:332/399`, `:460/481`, `:523/564`), whose `tool_result` metadata is `{sessionUpdate, toolCallId, title, status, transport}` — **no `is_error` key** (`acp-cli-adapter.ts:1496-1507`). The `CopilotCliAdapter`/`CursorCliAdapter` classes that *do* set it (`copilot-cli-adapter.ts:503`) are wired only into model listing, discovery and probing, never a live spawn. **Codex is the only provider still feeding the miner** (`src/main/cli/adapters/codex/codex-notification-item-events.ts:211,230,273,304`). Claude computes `is_error` but raw-emits it on an internal `EventEmitter` only, never as a visible `OutputMessage` (`claude-cli-adapter.ts:1291-1305`, LT-062). Separately, `correction-miner.ts:5-11` still asserts in prose that `tool_result` "carries `metadata.is_error: boolean` on Claude, ACP, Codex-exec, Cursor, and Copilot adapters" — false for four of those five; fix that comment with the code. Spec written 2026-09-06: [`2026-09-06-lt196-correction-miner_spec_completed.md`](../superpowers/specs/2026-09-06-lt196-correction-miner_spec_completed.md), which recommends persisting a transcript-invisible outcome record at each adapter's true is-error site, closing Claude and ACP in one shape. Original finding: **FOUND, NOT FIXED, 2026-08-18 — needs a design decision.** The WS-B8 "Scan for corrections" learning-scan feature (`learning-scan-service.ts` → `correction-miner.ts`) is structurally non-functional for the Claude provider — the default/primary provider — because its detection algorithm depends on a `type: 'tool_result'` `OutputMessage` (with `metadata.is_error`) existing in the archived transcript for every tool call, per the miner's own file-header survey ("the only reliably queryable per-tool-call signal … `tool_use`/`tool_result` pairs … `tool_result` carries `metadata.is_error`"). That survey (dated 2026-07-30) was true when written but was silently invalidated by the later, correctly-motivated LT-062 fix (2026-08-12): `claude-cli-adapter.ts` now only turns a `tool_result` into a visible `OutputMessage` on the permission-denial branch — an ordinary tool success *or failure* is raw-emitted on the internal `'tool_result'` event (used only for live doom-loop detection) and never written to the transcript/history at all, per the adapter's own `// LT-062: below only turns a tool_result into a visible 'output' message on the permission-denial branch` comment. Live-reproduced twice: ran real Claude sessions with a genuine command failure→correction pattern (first a nonexistent-path `ls`, excluded by design as an exploration command; then a real `grep --bogus-flag` invalid-option failure followed by the corrected `grep` call, matching the miner's own `UnknownFlag`/base-command-match shape) and confirmed via Node-inspector `history.loadConversation()` reads that the archived transcript contains only `tool_use`/`assistant`/`user` messages — zero `tool_result` entries — so `extractToolInvocations()` sees `isError: null` for every invocation and `findCorrectionPairs()`'s first gate (`failInv.isError !== true → skip`) discards everything; `runScan()` correctly reports `sessionsScanned: 1, patternsFound: 0` with no error, giving no observable signal anything is wrong. Not attempted as a unilateral fix because the two viable directions are a real product/architecture choice: (a) persist a lightweight, transcript-invisible `tool_result` record (id + `is_error` + command) specifically for later mining, tagged so the renderer never renders it, or (b) feed the miner from a separately persisted log of the raw `'tool_result'` events the adapter already emits live, rather than from the rendered `OutputMessage` history. Either risks reintroducing some of the transcript noise LT-062 deliberately removed if done carelessly. The rest of the Memory Review inbox (approve/edit-approve/reject, decision persistence across restart, and an approved lesson reaching a subsequent loop's real prior-context block) was independently live-verified working correctly this same run via direct `captureMemoryProposal()` calls, so this defect is scoped precisely to the correction-miner's Claude-transcript data source, not the review/approval pipeline around it | [Sibling-audit round 2 livetest, check A4](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-18--batch-s2) | Spec written 2026-09-06, recommending direction (a) and correcting scope to include the ACP-backed providers (Copilot/Cursor/Grok), not just Claude: [2026-09-06-lt196-correction-miner_spec_completed.md](../superpowers/specs/2026-09-06-lt196-correction-miner_spec_completed.md) |
| LT-216 | P1 | **FIXED + REGRESSION-TESTED 2026-08-19.** `browser.find_or_open` could not attach to an existing tab on a relay-backed remote node. `confirmExistingCandidate()` (`src/main/browser-gateway/browser-target-discovery-operations.ts`) asked the extension to re-report inventory (bounded at `timeoutMs: 3_000` / `executionTimeoutMs: 2_500`, `browser-extension-inventory-refresh.ts:9-10`) and then only accepted a candidate whose `updatedAt` was `>= refreshStartedAt` — i.e. re-reported *inside that 3s window*. Measured on the live `windows-pc` node: an extension relay re-reports each tab on a **rolling sweep of 20–55s per tab** (consecutive `browser.extension_attach_tab` audit gaps for one tab: 19320, 19907, 28105, 28337, 34772, 35002, 42529, 55207 ms), so the confirm window was ~10x too short and rejected roughly nine live tabs in ten. Reproduced 3/3 against tabs provably present in the same session's `list_targets` output (auditIds `29ba5a06`, `7a855082`, `1ce1907c`, all `existing_tab_not_confirmed_after_inventory_refresh`). Two user-visible consequences: with no URL the agent is told the tab could not be confirmed; **with a URL `findOrOpen` sets `existing = null` and falls through to `openTab()`, silently opening a duplicate, unauthenticated tab instead of reusing the logged-in one** — the exact shape that makes an agent see a login page where the user has a live session. A second trigger compounded it: the same refresh command was also failing outright on this node (`list_targets` returned `inventory refresh FAILED for node bb62e3ee-… — extension last contacted 0s ago`, auditId `73b44485`), and refresh failure was treated as a hard `return null`. **Fix:** (a) confirm against a freshness horizon (`EXISTING_TAB_CONFIRMATION_HORIZON_MS = 120_000`) that exceeds the observed sweep period while still excluding hours-old ghost inventory from an ended browser session, and (b) treat a failed refresh *command* as non-fatal when extension **contact** is still fresh — loss of contact, not a timed-out command, is the signal inventory can no longer be trusted (`isRemoteExtensionContactFresh` already existed for this). Not live-re-verified: the node is paired to the packaged app, which runs its own bundled build, so confirming the fix on `windows-pc` needs a repackage + restart | [CDP hop deadlines livetest](../browser-gateway-cdp-hop-deadlines_livetest_completed.md) | `src/main/browser-gateway/browser-target-discovery-confirmation-horizon.spec.ts` (5 tests). Reverted both halves of the fix via a `/tmp` copy and watched **3 of 5 fail** — the live-tab selection, the duplicate-open regression, and the refresh-timeout case — while the 2 guard tests (ghost tab from an ended session; node gone silent) correctly stayed green in both directions, proving they are guards and not tautologies. Restored and confirmed 5/5, plus 883/883 across all 87 `src/main/browser-gateway` spec files unaffected |
| LT-217 | P2 | **ONGOING GROWTH FIXED + REGRESSION-TESTED 2026-08-31.** Historical finding from 2026-08-19: `browser_audit_entries` is **99.7% internal bookkeeping** and grows without bound. Measured against the live production `rlm.db`: 3,444,307 rows total, of which `browser.extension_attach_tab` is 2,314,562 and `browser.list_approval_requests` is 1,116,376 — every genuine agent browser action in recorded history (click, evaluate, query_elements, snapshot, navigate, accessibility_snapshot, screenshot, list_targets, find_or_open, wait_for) totals ~11,000 combined. The table occupies **1,361,317,888 bytes (1.36 GB), ~32% of the 4.27 GB `rlm.db`**, with entries retained back to 2026-05-04 and **no DELETE/prune path anywhere in `src/`**. Two independent causes, both writing a full audit row per call through `this.result(...)`: (1) `attachExistingTab()` (`browser-gateway-service.ts:462-497`) is invoked once per tab per inventory report by the relay bridge, so a 22-tab node on a ~30s sweep writes ~2-3 rows/second continuously — 50k–115k rows/day, every day; (2) `listApprovalRequests()` (`browser-gateway-approval-operations.ts:73-93`) is polled by `BrowserApprovalsBannerComponent` on a permanent `REFRESH_INTERVAL_MS = 5_000` timer (`browser-approvals-banner.component.ts:32,216-218`) — 17,280 rows/day, which matches the observed 1.12M almost exactly. Impact is not just disk: this is the forensic record you read to investigate a browser incident, and it is now a needle-in-a-haystack (a prior campaign entry already notes an incident that 'left a trace only in the `browser_audit_entries` table'), plus sustained SQLite write pressure on a 4.27 GB file in the main app. Not fixed because the right answer is a judgement call, not a bug fix | [CDP hop deadlines livetest](../browser-gateway-cdp-hop-deadlines_livetest_completed.md) | Not yet written — recommended shape: stop auditing internal bookkeeping at all (inventory attach is a tab-store write, not an agent action; a read-only poll of pending approvals is not an auditable decision), keeping `extension_attach_tab` audit rows only for an *agent-initiated* attach, and/or add retention pruning on `created_at` for `actionClass: 'read'` rows. Either change should be paired with a one-off compaction of the existing 1.36 GB |
| LT-218 | P2 | **FIXED + REGRESSION-TESTED 2026-08-31; live unreadable-page recheck pending.** Historical finding from 2026-08-19: `browser.snapshot` reports `outcome: "succeeded"` with `text: ""` when the extension is **not permitted to read the page at all**, so an agent cannot distinguish an empty page from an unreadable one. Reproduced on two independent `windows-pc` tabs (`www.bing.com/webmasters`, `www.contractsfinder.service.gov.uk`): `browser.snapshot` → `succeeded, text: ""` (auditIds `49e892af`, `b4fe791a`), while `browser.query_elements` on the *same* two targets → `failed` with the true reason, `"Cannot access contents of the page. Extension manifest must request permission to access the respective host."` (auditIds `03e2e2a4`, `47beba98`). Root cause is two stacked error-swallowing catches in the extension bundle: `capturePageText()` does `chrome.scripting.executeScript({...}).catch(() => [])` and its caller `buildTabPayload()` does `capturePageText(tab.id).catch(() => ({ title: tab.title, text: '' }))` (`resources/browser-extension/background.js`), so a host-permission rejection becomes an empty string and the command still resolves. Title and URL still populate because they come from `chrome.tabs.get()`, which needs no host permission — which is exactly what makes the result look like a successful read of a blank page. This is the 'confident wrong answer' class: an agent told a tender/portal page is empty will conclude the page is empty and act on it, rather than reporting a permissions gap. It also explains the sibling `accessibility_snapshot` timeouts on the same tabs. **Not fixed** because the correct surface is a genuine decision, not a bug fix: snapshot could fail outright like `query_elements` does (consistent, but breaks callers that legitimately tolerate a partly-unreadable page — note `executeScript` uses `allFrames: true`), or succeed with an explicit `textUnavailableReason`/`unreadable: true` field that the aux-extraction and campaign callers can branch on. Also not fixable end-to-end from here: the change lives in the extension bundle, which must be redeployed and reloaded on the node | [CDP hop deadlines livetest](../browser-gateway-cdp-hop-deadlines_livetest_completed.md) | Not yet written — whichever shape is chosen, the regression test belongs in `browser-extension-assets.spec.ts` (which already covers background.js failure paths): assert that an `executeScript` rejection is not converted into a successful empty-text snapshot |
| LT-270 | P2 | **DECIDED + CONTRACT RESCOPED + LIVE EVIDENCE ACCEPTED 2026-08-31.** Historical finding from 2026-08-19: The context-cost-governor's *automatic* 4x-cumulative recovery path (`ContextSafetyPolicy.decideCumulative`'s `cumulative-4x` branch, `context-safety-policy.ts:295-330`) has **no measurable path to ever reducing real provider cost** on any Codex build observed in this campaign, because it deliberately has no restart-with-summary fallback (unlike the *manual* Compact button, whose LT-017 fallback is exactly that) and LT-017 already established `thread/compacted` is never confirmed on any such build. Measured live via a paired governor-on/governor-off comparison (identical fixture, identical 6-turn sequence, real Codex `cat`s of real files past the 4x threshold on both): real billed input tokens (`costGetEntries`) were 407,155 (governor on) vs 420,330 (governor off) — a **3.1%** reduction, against the owning doc's own **≥60%** acceptance target. The governor-on run paused at `interrupt-unconfirmed` (the same branch check 3 of the same doc already found) and resumed on the *same, still-full* context once manually nudged — it never actually compacted anything, so the ~3% gap is plausibly just the interrupted turn's own discarded in-flight reasoning tokens, not a real saving [Archived detail](livetest-remediation-register-archive-2026.md#lt-270-archived-detail) | [Context cost governor, checks 2 and 4](../superpowers/plans/2026-07-14-context-cost-governor-plan_livetest_completed.md#evidence-run--2026-08-19-batch-p1--checks-2-and-4-driven-live-as-a-paired-governor-onoff-comparison-check-2-pass-with-the-same-stated-deviation-as-check-3-check-4-measured-and-fails-its-numeric-target-for-a-root-caused-already-known-reason) | Not yet written — this is a product decision (does the automatic path want a bounded, opt-in restart-with-summary escape hatch analogous to the manual one's LT-017 fallback, now that it has been measured to never achieve its own stated cost-reduction purpose otherwise, or does the doc's ≥60% target need revisiting for this path specifically?), not something to decide unilaterally here |
| LT-280 | P2 | **FIXED + REGRESSION-TESTED 2026-08-19.** The context-evidence panel (`app-context-evidence-panel`, both the instance context-bar and chat-header surfaces) is explicitly built to visibly label degraded evidence statuses — its own file-header contract states `corrupt`/`failed`/`deleted`/`staging` records are "always visibly labeled, never presented as complete" — but no degraded record could ever reach the panel at all: `EvidenceRetrievalService.list()` (`src/main/context-evidence/evidence-retrieval-service.ts:156-160`), the single method backing both the renderer's `contextEvidenceList` IPC channel and the `evidence_list` MCP tool, called `ledger.listEvidence(conversationId, { limit })` without ever passing `includeMaintenanceStates: true`, so `ContextEvidenceLedgerStore.listEvidence()`'s default `WHERE status = 'complete'` filter (`context-evidence-ledger-store.ts:164-172`) silently excluded every non-complete record before the renderer ever saw it — the labeling code (`getIsDegradedStatus`/`getStatusLabel`/`getStatusDisclosure`, all wired into the template) was fully correct and simply unreachable. Reproduced live in an isolated dev app: captured two real evidence records via a real Claude turn (chat-owned scope, `owner.kind: 'chat'`), directly set one record's `status` to `corrupt` via the ledger DB, refreshed the panel — the record vanished from the list entirely rather than showing a "Corrupt" badge; same result for `status: 'deleted'`. `listEvidenceForMaintenance` (the only other reader of degraded statuses) is used exclusively by the internal background `evidence-maintenance-service.ts` and is never exposed via any IPC channel or MCP tool, so this was the panel's and the MCP tool's only structural path to that data | [Provider-agnostic context evidence, check 7](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md#7-ui-inspection-human) | `src/main/context-evidence/evidence-retrieval-service.spec.ts` ("asks the ledger to include maintenance-state (corrupt/failed/deleted/staging) records, not just complete ones") |
| LT-290 | P2 | **FIXED + REGRESSION-TESTED 2026-08-19.** Fable WS16 livetest check 5's 'lessons' `RecallTraceStore` surface could never hold a trace: exhaustive repo-wide grep for `getRecallTraceStore().record(` found exactly two production call sites (`context-search.ts` for `rlm`, `code-retrieval-service.ts` for `codemem`) and zero for `surface: 'lessons'` — the only production interaction with the lessons surface was `loop-lesson-use-credit.ts`'s `markUsed('lessons', …)`, which filters existing traces by surface and can never create one, so it was a guaranteed no-op on every loop, always. Fixed by recording a `lessons` recall trace (`loop-coordinator.ts`'s `surfaceLearnings` closure, alongside the existing `surfacedLessonsForRun` population) whenever `getLessonStore().digest()` surfaces at least one lesson at loop start, with a rank-ordered score (lessons have no query-similarity score). Live-verified on a real loop (`loop-1787166879293-5e633139`): `getRecallTraceStore().bySurface('lessons')` held one trace (`returned: [{id: 'lesson-uy6v89', score: 1}]`) immediately after start | [fable-ws16, check 5](./2026-07-13-fable-ws16_livetest_completed.md#5-recall-traces-populate-for-all-three-surfaces) | `src/main/orchestration/loop-coordinator-memory.spec.ts` (new LT-290 test). Reverted via a `/tmp` copy and watched it fail (`expected 0 to be greater than 0`); restored, 2/2 green |
| LT-291 | P2 | **FIXED + REGRESSION-TESTED 2026-08-19.** Fable WS16 livetest check 6 (reinforcement-on-use) could never fire on a genuinely successful loop completion. `creditSurfacedLessonUse`'s `outcomeText` argument is `this.completionContext.getConvergenceNote(state.id)` — but `evidence-resolver.ts`'s accepted-completion (`decision: 'stop'`) branch returns `convergenceNote: null` by design (comment: "coordinator sets this itself with reviewer details"), and nothing else populates it on that path; the convergence-note map is only ever written by stall/pause/blocked-review branches. So `outcomeText` was always `undefined` on a clean success and `creditSurfacedLessonUse` bailed out immediately (`if (!outcomeText?.trim()) return;`), contrary to `loop-lesson-use-credit.ts`'s own doc comment that the convergence note is "the cheapest, always-present signal." This affected every prior live-loop attempt on this doc, including two same-day attempts by a prior batch that used `completion.crossModelReview.enabled` as the hypothesised trigger — that mechanism (`captureReviewLessonForVerdict`, gated on a *blocking* cross-model review finding) is a different, unrelated lesson-capture path that never touches `RecallTraceStore` or logs "Reinforced surfaced lessons on use"; it does not gate this check. Fixed by falling back to the accepted terminal intent's own `summary` (`state.terminalIntentHistory?.at(-1)?.summary`), which is genuinely present whenever a loop reaches `'completed'` via the real `aio-loop-control complete --summary` mechanism agents use in production. Live-verified end-to-end on a real loop (`loop-1787166879293-5e633139`, a real Claude CLI turn, real `aio-loop-control complete` invocation): `app.log` shows `Reinforced surfaced lessons on use {count: 1}` at the loop's exact termination timestamp; the seeded lesson's `uses` went `0 → 1` and its recall trace's `usedIds` included it | [fable-ws16, check 6](./2026-07-13-fable-ws16_livetest_completed.md#6-reinforcement-on-use-across-a-real-loop) | `src/main/orchestration/loop-coordinator-terminal-intents.spec.ts` (new LT-291 test). Reverted via a `/tmp` copy and watched it fail (`expected +0 to be 1`); restored, 18/18 green |
| LT-300 | P1 | **FIXED + REGRESSION-TESTED 2026-08-20.** A ping-pong loop could not terminate after genuinely finishing. When `crossModelReview.pingPong.enabled` is true, `loop-coordinator.ts`'s completion seam is an if/else-if chain in which the ping-pong branch runs and the `completionDetector.hasSufficientSignal(...)` verify-before-stop branch is an `else if` behind it, so every completion signal was computed, written to `iteration.completionSignalsFired`, and then discarded (terminal intents do not rescue it: only `block`/`fail` are honoured outside that branch). Inside the ping-pong gate, `evaluatePingPongCompletion` returned `null` ("builder is still working") unless `classifyCleanReview` returned clean — and that classifier has no path to `clean: true` without the literal `[[LOOP:CLEAN_REVIEW]]` sentinel (`loop-clean-review-classifier.ts:37-43`: the model backend can only ever *confirm* not-clean, and a deterministic clean verdict is downgraded to `UNCLEAR_CLEAN_REVIEW`). `pp.roundCount += 1` sits downstream of that gate, so `roundCount` stayed 0 and the `roundCount >= maxRounds` backstop was unreachable by construction. Neither review-driven stall backstop could catch it either: both require `!madeProductionChange` (`loop-coordinator.ts:3138-3182`, the `evaluateReviewStall` block) and the agent changed production files every iteration while being definitionally finished. Reproduced live on `loop-1787241037235-b6fe2309` (workspace `/Users/suas/work/orchestrat0r`): `LOOP_TASKS.md` with every leaf `[x]`/`[-]`, `OUTSTANDING.md` "Needs human — (none)", `[ledger-complete]` firing on all 5 iterations, and the UI showing `round 0/15 · reviewer $0.00` after 2h40m / 118.3k tokens / $20.25. Fixed by `resolvePingPongBuilderDone` (new `loop-pingpong-builder-done.ts`): a *sufficient* completion signal read off `iteration.completionSignalsFired` is a builder done-declaration equal in authority to the sentinel, and short-circuits the classifier call. Cannot cause a premature stop — it opens a review round, it does not terminate; the reviewer still gates convergence. The classifier's sentinel-only authority over *prose* is deliberately unchanged | Live loop `loop-1787241037235-b6fe2309` artefacts under `.aio-loop-state/` | `src/main/orchestration/loop-pingpong-builder-done.spec.ts` (5 tests) + `loop-pingpong-completion.spec.ts` (2 new tests). Reverted in a `/tmp` copy and watched them fail (`expected "spy" to be called once, but got 0 times` — the exact round-0/15 symptom); restored, green |
| LT-301 | P2 | **FIXED + REGRESSION-TESTED 2026-08-20.** `diffSource` was written by three producers (`loop-pingpong-completion.ts:360,376`, `loop-coordinator-completion-gates.ts:432`), typed on both reviewer inputs (`agentic-pingpong-reviewer.ts:109`, `loop-fresh-eyes-reviewer.ts:70` — whose doc comment even explains it means "is not a git repository") and **read by nothing**, confirmed by an exhaustive repo-wide grep. Outside a git repository `collectWorkspaceDiff` returns `{diff: '', source: 'none'}` (`loop-diff.ts:107-110`), so `diffBlock` collapsed to `''` while the impl-mode prompt still told the reviewer "The git diff below is your STARTING POINT" pointing at nothing. A reviewer handed no diff, and not told it was handed no diff, is a rubber stamp — it has no way to distinguish "no changes to object to" from "I was shown nothing". Fixed by consuming `diffSource` in `buildPrompt`: an explicit "No diff is available — read the code directly" block that names whether git was unreadable or the diff was genuinely empty, forbids treating the absence as evidence of correctness, and instructs the reviewer to report the gap rather than reply APPROVED; the impl-mode instructions no longer reference a diff that is not there | Same live loop — `repo-baseline.json` recorded `"source": "none"` because `workspaceCwd` was the parent of the real repo | `src/main/orchestration/agentic-pingpong-reviewer.spec.ts` (2 new tests). Reverted in a `/tmp` copy and watched both fail; restored, 31/31 green |
| LT-302 | P2 | **FIXED + REGRESSION-TESTED 2026-08-20.** A preflight verify that blew its wall-clock budget was reported as "Preflight failed", indistinguishable from red tests, though the operator fix is the opposite one (shorten the command vs fix the code). `VerifyOutcome` has always distinguished `failureKind: 'timeout'` (`loop-completion-detector.ts:713-722`) from `'command'` (726-736), but `LoopPreflightResult` (`loop-audit.types.ts`, from line 55) collapsed every failure to `status: 'failed'`, dropping the distinction before it reached the UI. Observed on the same live loop: `PRE_FLIGHT.md` recorded `Duration: 599998ms` and `(verify timed out after 600000ms)` for `npm --prefix "ai-orchestrator" run verify` — a 14-command chain (full lint, two typechecks, whole test suite, `rebuild:native`, `smoke:electron`) against the non-configurable 600s default (`loop-config-defaults.ts:102`), which cannot finish. Fixed by carrying `failureKind` through `LoopPreflightResult.commands[]` (type + Zod schema + `runLoopPreflight`) and labelling the chip "Preflight timed out". The red state is retained deliberately — a timeout *is* a failure to verify; only the wording was wrong | Same live loop — `.aio-loop-state/loop-1787241037235-b6fe2309/PRE_FLIGHT.md` | `src/main/orchestration/loop-audit-runtime.spec.ts` (2 new tests) + `src/renderer/app/features/loop/loop-control.component.spec.ts` (1 new test). All three reverted in a `/tmp` copy and watched to fail; restored, green |
| LT-303 | P2 | **FIXED + REGRESSION-TESTED 2026-08-20.** A loop pointed at a non-git workspace degraded silently. `normalizeManagedIsolation` (`loop-start-config.ts:216-243`) already detected the case and disabled isolation, but only at `info` log level, and nothing told the operator that diff-backed review had been reduced to nothing — the observed loop ran for 2h40m against `/Users/suas/work/orchestrat0r` while the actual repository was the `ai-orchestrator` subdirectory. Fixed by `emitNonGitReviewWorkspaceWarning` (`loop-coordinator-state-helpers.ts`), called at loop start from `startLoop` once the repo baseline is captured: for reviewer-backed loops only — ping-pong or cross-model review; `mode: 'review-driven'` alone deliberately does NOT qualify, because the fresh-eyes gate that builds a diff is itself gated on `crossModelReview.enabled`, so warning on it would be a false positive (pinned by a regression test asserting silence) — it logs a warning and emits a `loop:activity` status line so the gap is visible in the loop feed. Advisory, not blocking: a non-git workspace is legitimate, it just must not be invisible. Known gap, not closable by a start-time predicate: `runFreshEyesReviewGate`'s `forcedByContradiction` escape valve (`loop-coordinator-completion-gates.ts:341,345`) synthesises a default review config and collects a diff even when `crossModelReview.enabled` is false, but it is driven by `state.freshEyesForcedByContradiction`, a runtime condition unknowable at loop start | Same live loop — `repo-baseline.json` `"source": "none"` | `src/main/orchestration/loop-coordinator-state-helpers.spec.ts` (4 new `nonGitReviewWorkspaceWarning` tests). Reverted in a `/tmp` copy and watched 2 fail; restored, 20/20 green |

| LT-370 | P2 | **ROOT CAUSE CORRECTED, FIXED + REGRESSION-TESTED 2026-08-24; LIVE CHECK PENDING A REBUILD.** The 2026-08-20 diagnosis was wrong. The model that failed was **not** an absent one. Correlating the two halves of the same request in `app.log` settles it: `coord-8438` was dispatched at `1787345477010` as `{method: "auxiliaryModel.generate", provider: "ollama", model: "gpt-oss:120b"}`, failed at `1787345485971` after **8961 ms** with `-32603: Ollama generate failed: 500`, and one millisecond later at `1787345485972` `AuxiliaryLlmService` logged `Auxiliary generation failed for slot "webExtract"`. `gpt-oss:120b` **is** one of the eight models that endpoint serves. The configured `qwen/qwen3.6-35b-a3b` was never sent: `tryEndpointForSlot` (`src/main/rlm/auxiliary-llm-service.ts`) gates the tier pin behind `endpointAdvertisesModel()`, which is false for a worker-node endpoint whose non-empty model list lacks the id, so it falls through to `pickModelForTier(ids, tier, loaded)` — i.e. the code already does the thing the old entry recommended as its fix. **The actual defect is the auto-pick rule.** With no model resident, `pickModelForTier` orders by `modelSizeScore` and `quality` takes the *largest* advertised id (`gpt-oss:120b`, score 120) with no regard for whether the host can load it; `windows-pc` reports `gpuMemoryMB: 32607`, so a 120B model cannot be resident and Ollama 500s. The 8961 ms latency is consistent with an attempted load that failed, not an instant unknown-model rejection. `pickModelForTier`'s existing `loaded` restriction is the intended guard against exactly this, but it only engages when something is *already* resident. **Impact correction: the aux path is not "silently inert".** The same log holds **143** successful `ollama deepseek-r1:7b` dispatches — quick tier auto-picks the *smallest* model and works. Only the six **quality**-tier slots are affected (`compression`, `memoryDistillation`, `webExtract`, `approvalAdjudication`, `subQueryExecution`, `verifyOutputSummary`); `titleGeneration`, `routingClassification`, `approvalScoring`, `loopScoring`, `retrievalHypothesis` and `branchScoring` are quick tier and are demonstrably working. It still fails safe (frontier fallback / never-worse guard), so nothing is wrong-answered — the cost is ~9 s wasted per quality-tier call and no local saving on those slots | [Browser-gateway reliability check 1](2026-07-17-browser-gateway-reliability_livetest.md); correlation evidence in this register's LT-370 section | Fixed by `AuxiliaryModelFailureCache` (`src/main/rlm/auxiliary-llm-utils.ts`): an **auto-picked** model that fails to generate is remembered per endpoint for 10 minutes, so the next `pickModelForTier` steps down to the next candidate instead of re-attempting the same doomed load. Explicit per-slot and tier pins are deliberately excluded — a pin must keep surfacing its own error rather than being silently substituted — and the filter returns the unfiltered list when it would otherwise empty, so a degraded endpoint can never become no endpoint. 9 regression tests (5 in `auxiliary-llm-utils.spec.ts`, 4 in `auxiliary-llm-service.spec.ts`); the load-bearing one was mutation-checked by reverting the `usable()` call and watching it fail with `expected '' to be 'distilled text'`, then restored. 124 tests green across the three touched spec files |
| LT-371 | P1 | **FIXED + REGRESSION-TESTED, LIVE CHECK PENDING, 2026-08-23.** `windows-pc`'s worker-node WebSocket suffers short, random transport losses; the coordinator's former 2.5-second disconnect grace turned ordinary reconnects into 30 true node disconnects, repeatedly suspending/restoring 21 browser attachments and rejecting browser commands. A second seam marked a long-poll command delivered before its RPC response was known to have left the coordinator; because responses were addressed only by node id, an old poll response could even be written to a replacement socket where that request id no longer existed, producing a false `browser_extension_command_receipt_missing`. Fixed with a 30-second grace, one-shot originating-socket responders, bounded same-id requeue, and a FIFO handoff barrier. This is not MV3 service-worker eviction or native-host cycling: read-only worker logs show one continuous worker process, continuous extension poll heartbeats, no native-host errors, 63 coordinator-socket closes (61 code 1006), and the coordinator log places `WorkerNodeConnection Node WebSocket disconnected` immediately before every reliability `node_disconnect`. Timing is non-periodic; 24/30 sockets re-registered inside 30 seconds. The 53-vs-30 asymmetry is expected from first-contact/duplicate no-attachment reconnect telemetry plus replacement sockets, not duplicate workers | [Investigation prompt](2026-08-23-browser-extension-channel-flapping-prompt.md), [owning check-6 evidence](./2026-08-19-remote-node-false-negative-fixes_livetest_completed.md), [completed implementation plan](../superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_completed.md) | 6 focused files / 90 tests pass; both TypeScript checks, lint, and `build:main` pass; fresh completion gate `VERDICT: PASS`. Rebuilt-runtime verification is deferred to the implementation livetest |
| LT-350 | P1 | **FIXED 2026-09-10** — `LoopCompletionDetector` now tracks every spawned preflight/quick-verify child in a `Map<string, Set<SpawnVerifyRegistration>>` keyed by `loopRunId`; `LoopCoordinator.cancelLoop()` calls `await this.completionDetector.abortVerify(loopRunId)` right after `terminate(...)`, force-killing any still-running verify child before the loop reports stopped. A new `'cancelled'` `VerifyFailureKind` was threaded through the 5 duplicated failure-kind locations. New integration test (real long-running `.js` script, not an inline `node -e` string — the latter is corrupted by the `/bin/bash -lc` wrapper and produced a false-passing first draft) plus 4 new unit tests, both mutation-checked by reverting `abortVerify` and confirming the marker file proving the child was not killed. Full `src/main/orchestration/` suite green (224 files/2879 tests); all canonical gates green (`check:ts-max-loc` ceiling for `loop-coordinator.ts` intentionally raised 3948→3954, dated and justified). Originally: cancelling a loop while its start-of-run preflight verify command is in flight does not kill that verify child process — it keeps running, unattended, to its own timeout regardless of cancellation. `runLoop` (`loop-coordinator.ts:1821-1828`) `await`s `runLoopPreflight(state, this.completionDetector, …)` synchronously before the first iteration; `runLoopPreflight` → `completionDetector.runVerify(config)` → `spawnVerify` (`loop-completion-detector.ts:648-745`) does a raw `child_process.spawn` tracked only by a local closure (`child`, its own `setTimeout`), never registered with any lifecycle/instance-tracking `cancelLoop` can reach. `cancelLoop` (`loop-coordinator.ts:1494-1520`) sets the cancelled flag, calls `this.terminate(state, 'cancelled', …)`, `awaitTerminalCleanup`, and `confirmStablyStopped` — all of which operate on the active iteration/instance, none of which touch an in-flight preflight-verify subprocess, because no instance has been spawned yet at that point in a run. Reproduced live and by accident while testing an unrelated check (2026-08-19 non-git-workspace-warning livetest, check 2): started a loop with `workspaceCwd: /Users/suas/work/orchestrat0r` and a blank `completion.verifyCommand`, which `resolveLoopVerification` auto-inferred to `npm --prefix "ai-orchestrator" run verify` (a 14-command chain including the full test suite, `rebuild:native`, `smoke:electron`) from the workspace's own package.json; called `loopCancel(loopRunId)` ~2.5s after start, well before any iteration/instance had spawned. The IPC call resolved `success: true` and `LoopState.status` became `'cancelled'` (`endedAt` ≈4s after start). Despite that, the spawned `npm run verify` chain kept running unattended: at T+5 minutes its `npm run test` step's vitest workers were still executing on the shared campaign host, driving 1-minute loadavg from ~6 to 27.9 — had to be killed manually (`kill -9` on the whole subtree; verified via `ps` that the chain's root pid's parent was this very dev app's own Electron main process, ruling out a concurrent agent's unrelated run). Required behaviour: `cancelLoop` (and any other loop-terminal transition reached while `runLoopPreflight`/`runVerify`/`runQuickVerify` is in flight) must also abort that spawned child promptly (SIGKILL/SIGTERM), not just the per-iteration CLI instance — `cancelLoop`'s returned promise should not represent the loop as fully stopped while a verify child it started is still alive. This is a resource-safety gap, not cosmetic: a legitimately slow verify command (the workspace's own multi-minute test suite is the common case) left running past a user's cancel can starve a shared or laptop host for the remainder of its timeout (up to `verifyTimeoutMs`, default 600s) | Reproduced live 2026-08-21 while running [Remote-node false-negative fixes / pingpong-loop-cannot-terminate livetest, batch Q1](./2026-08-20-pingpong-loop-cannot-terminate_livetest_completed.md#evidence-run--2026-08-21) | [Plan doc LT-350 section](./2026-07-19-livetest-failure-remediation_plan_completed.md) |
| LT-441 | P2 | **PRODUCT-PATH GUARD IMPLEMENTED + REGRESSION-TESTED 2026-09-23; resident OS write escape still unverified.** Hardened Claude now refuses an ungranted effective `CLAUDE_CONFIG_DIR` before spawn, including inherited environment values; a routed account gets only its exact profile home. The original 2026-08-24 resident-mode write outside Seatbelt roots needs a privileged process/syscall trace. The earlier "not reachable through the product" claim is withdrawn. | [WS13 reproduction](2026-07-13-fable-ws13_livetest_completed.md#evidence-run--2026-08-24-batch-c--checks-1011-crash-lever-attempt-surfaces-a-real-confinement-gap-lt-441-not-the-crash) | [Sweep live check 8](2026-09-23-outstanding-plans-sweep_livetest.md#check-8--lt-441-resident-claude-confinement-trace) |
| LT-480 | P1 | **FIXED + REGRESSION-TESTED 2026-08-24, verified live end-to-end against a rebuilt dev app.** Every real, worker-recorded skill activation was silently persisted to the wrong SQLite file — a shared, per-checkout fallback path, not the profile's own `rlm.db` — because `context-worker-main.ts` called `registerWorkerEventForwarding(transport)` (which eagerly resolves `RLMContextManager.getInstance()` → an unconfigured `RLMDatabase.getInstance()`) before its own explicit, correctly-pathed `RLMDatabase.getInstance({dbPath, contentDir})` pre-init; `RLMDatabase.getInstance()` is itself a singleton where the first caller's config wins. This is the exact ordering hazard LT-207 documented and avoided for the codebase-indexing lane worker, left unfixed in the original context worker. Fixed by reordering the two calls [Archived detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail) | [Skill observability + design skills livetest, evidence run 2026-08-24 (Batch E)](./2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run--2026-08-24-batch-e--lt-480-real-auto-injected-skill-activations-silently-persisted-to-the-wrong-db-found-and-fixed) | `src/main/instance/context-worker-main.ts`; new test `src/main/instance/__tests__/context-worker-main.spec.ts` ("LT-480: pre-initialises RLMDatabase with explicit dbPath before wiring worker event forwarding"), watched failing on revert (`expected 11 to be less than 10`), restored and green. `tsc --noEmit` ×2 clean, `ng lint` clean, `build:main` green, targeted `test:quiet` 70/70 across `context-worker-client.spec.ts` + `context-worker-event-forwarding.spec.ts` + `skill-attribution-service.spec.ts` + `skills-loader.spec.ts` + `unified-controller.spec.ts` |
| LT-481 | P3 | **DECIDED + FIXED + REGRESSION-TESTED 2026-09-06.** James chose baseline-aware Snooze over removing the control. `WorkboardStore` now stores the attention level held at snooze time (`ReadonlyMap<string, AttentionLevel>`), and the new `snoozeClearedByAttention(current, baseline)` in `workboard-projection.ts` clears a snooze only on completion (`idle`) or a strict rise above that baseline — `working`/`waiting` churn and staying at the same level no longer self-clear. Three failing-first tests added; 77/77 workboard tests pass. Original finding: The Workboard's per-card "Snooze" button is rendered and clickable on every card in every lane, including the Needs You lane, but it cannot durably hide a card that was *already* blocked/failed/review when snoozed: `WorkboardStore.snoozeItem()` stores only an item id (no baseline attention level), and the hand-raise effect's `attentionLevelClearsSnooze(level)` checks only the item's *current* level (`level !== 'working' && level !== 'waiting'`), which is unconditionally true for every Needs You card by construction — so the very next reactive `items()` recompute (a routine instance-list refresh, observed within 2-5s) silently un-snoozes it again, with no error and no visible feedback. Live-reproduced: a real `waiting_for_permission` instance, clicked the real DOM Snooze button (card correctly disappeared for a moment), then it silently reappeared on its own a few seconds later while remaining in the exact same `waiting_for_permission` state — no new event, no escalation. Confirmed at the signal level too (`store.isSnoozed(id)` flips `true` → `false` on its own within ~2s with the instance status held constant throughout). **This is not an accidental regression** — every existing `workboard.store.spec.ts` test for this mechanism deliberately snoozes a *working* item and asserts it un-snoozes on a transition *into* blocked/failed/idle ("hand-raise: auto-clears a snooze once the item becomes blocked/fails/completes"), which is the mechanism working exactly as designed and tested; none of those tests (or any other) cover snoozing an item that is *already* in the Needs You lane, which is precisely this livetest doc's own check scenario ("put instances into failed/error/degraded states... snooze hides a card until it raises its hand"). The gap is between the check's literal precondition and a deliberately narrower, well-tested design intent (mute a non-urgent item; auto-reveal on a genuine transition into urgency) — not a wiring mistake. Two candidate fixes, neither applied: (a) make the hand-raise comparison baseline-aware — record the attention level at snooze time and only auto-clear on a genuine escalation from that baseline, which would make the button work as the check expects; or (b) don't offer a Snooze control on Needs You cards at all, since the mechanism was only ever built and tested for working/waiting items. Deciding between "broaden the mechanism" and "don't offer the control where it can't work" is a product call, not an agent's, per this campaign's established precedent for the same shape of gap (see LT-220, doc 2's check 2/4) | [Sibling-audit round 2, evidence run 2026-08-24 (Batch E)](2026-07-30-sibling-audit-round2_livetest.md#lt-check-c2--attention-scale--mobile-parity) | Not fixed. Candidate touch points if (a) is chosen: `attentionLevelClearsSnooze()` (`workboard-projection.ts`) needs a baseline parameter, `WorkboardStore`'s `snoozedIdsSignal` (`workboard.store.ts`) needs to become a `Map<string, AttentionLevel>` capturing the level at snooze time |
| LT-520 | P2 | **FIXED, REGRESSION-TESTED 2026-08-24, and CONFIRMED LIVE 2026-08-25 (both halves).** Live confirmation: the packaged app was rebuilt (`app.asar` mtime 2026-08-25T13:36:15Z, started 13:44:42Z, guard string present 4x in the bundle) and claimed the manifest 35 s after start (manifest mtime 2026-08-25T13:45:17.933Z, pointing at the packaged native host); seven separate dev apps then launched over ~25 minutes and **every one declined**, logging `Another Harness install owns the Chrome native-messaging manifest — leaving it alone … Set AIO_CLAIM_LOCAL_BROWSER_MANIFEST=1 to take it over`, with zero claims and no further write to the manifest. On 2026-08-24 a single dev app had rewritten it within minutes, which is the contrast that makes this a measurement rather than an absence of news. Original finding below. A Harness install writes the machine's single Chrome native-messaging manifest **unconditionally**, so whichever install started last silently takes the local browser-extension channel off the other — and if that was a dev app whose profile is later deleted, the manifest points at a binary that no longer exists and the user's local channel stays broken until the packaged app restarts. Reproduced live during this campaign: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ai_orchestrator.browser_gateway.json` was rewritten at 00:51 with `"path": "/tmp/aio-lt-E/browser-gateway/native-host/ai-orchestrator-browser-host"` by a batch agent's isolated dev app, while the packaged app (started 00:38) owns `~/Library/Application Support/harness/browser-gateway/native-host/`. `browser.health` on the packaged app then reported `localExtension: {state: "not_installed", installed: false, registered: false}` with remediation text telling the user to reinstall the extension — misdirecting advice, since nothing about the extension changed. **The guard already existed but was not on this path**: `assertBrowserExtensionNativeHostManifestWritable` is called only from `src/worker-agent/extension-relay-native-registration.ts` and `src/worker-agent/cli/service-cli.ts`; the Electron main path (`src/main/browser-gateway/index.ts` → `prepareBrowserExtensionNativeHostRuntime`) had no ownership check at all. Note this also means `AIO_DEV_USER_DATA_PATH` profile isolation is incomplete — the manifest is machine-global and was never isolated [Archived detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail) | Reproduced live 2026-08-24 while reading `browser.health` for [local + remote shared-browser control](2026-07-22-local-shared-browser-control_livetest.md) check 1 | `mayClaimBrowserExtensionNativeHostManifest()` + a `claimChromeManifest` option on `prepareBrowserExtensionNativeHostRuntime` (`src/main/browser-gateway/browser-extension-native-runtime.ts`), wired in `src/main/browser-gateway/index.ts`. 6 regression tests; the behavioural one was mutation-checked by forcing the branch true and watching it fail |
| LT-521 | P3 | **DOC-CORRECTED 2026-08-31.** Historical finding from 2026-08-25: The provider-agnostic-context-evidence livetest's check 1 expects: *"logs show shadow decisions (policy computed, action NOT executed)"*. No such log line exists anywhere in the shadow/enforce decision path, confirmed by reading every file on it, not just grepping runtime output: `src/main/context/output-persistence.ts` (the file that actually implements the shadow-mode short-circuit, `maybeExternalize()` line 170, `if (mode === 'shadow') return output;`) has exactly one `logger` call in the whole file, an unrelated migration-error `warn`; `src/main/context-evidence/context-evidence-diagnostics.ts`, `src/main/context/context-policy-runtime.ts`, and `src/main/context-evidence/context-safety-policy.ts` (the other plausible homes for a policy-decision log) have **zero** `logger` calls between them. This was first observed as "0 grep matches on a real log" in the 2026-08-12 evidence run and confirmed as "no such line exists in source" by the 2026-08-18 run, both of which deliberately left it unfiled as cosmetic; filed here per this session's explicit brief instruction not to silently accept a real (if cosmetic) gap. Shadow mode's actual behaviour (capture without alteration) is correct and unaffected — this is purely an observability/wording gap between the check's Expected Result and the implementation [Archived detail](livetest-remediation-register-archive-2026.md#lt-521-archived-detail) | [Provider-agnostic context evidence check 1, evidence runs 2026-08-12 and 2026-08-18](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md#check-1--codex-shadow-run--evidence-captured-partial) | Not yet written — this is a documentation-vs-implementation decision (add an `info`/`debug` log line when a shadow-mode decision is computed but not executed, vs. correct the check's Expected Result wording to describe shadow mode's real, silent behaviour), not something to decide unilaterally; see this doc's own precedent for the same shape of call on LT-220 |
| LT-523 | P1 | **FIXED IN CODE 2026-08-31; live re-check pending.** Every orchestration response now passes through one extracted admission/redelivery delivery path before `'inject-response'` can reach stdin. Blocked permission/interrupt/respawn states suppress the write and retain its full response metadata for ready-edge redelivery; consensus uses the same emitter without double admission | [Sibling-audit round 2, evidence run 2026-08-25 (Batch F)](2026-07-30-sibling-audit-round2_livetest.md#evidence-run--2026-08-25-batch-f) | `src/main/orchestration/orchestration-handler.spec.ts`; `src/main/orchestration/orchestration-response-delivery.ts` |
| LT-522 | P1 | **FIXED + MUTATION-CHECKED 2026-08-25.** Every one of the 15 `copilot-account:*` IPC channels rejected every real renderer call, so the GitHub Copilot Accounts feature shipped in commit `20f534775` was completely unreachable from the UI. The preload constructs this domain **with** `withAuth` (`src/preload/preload.ts:79`), so main always receives a payload carrying an `ipcAuthToken` key — present even before a token is issued, because `withAuth` sets it to `undefined`, and an `undefined` value is still an own key. All 10 payload schemas in `packages/contracts/src/schemas/copilot-account.schemas.ts` were `.strict()` and none declared the field, and `validatedHandler` (`src/main/ipc/validated-handler.ts`) validates the raw payload without stripping it. Production evidence: **239,644** `IPC validation failed` warnings across the retained `app.log` set, split exactly 119,822 / 119,822 between `copilot-account:preview-route` (`Unrecognized key: "ipcAuthToken"`) and `copilot-account:list` (`Invalid input` — the union `z.object({}).strict().or(z.undefined())` failing both arms), i.e. a 1:1 retry loop hammering IPC. The sibling domains got this right: `provider.schemas.ts` and `voice.schemas.ts` both declare `ipcAuthToken: z.string().optional()`. **How it shipped green:** `copilot-account-handlers.spec.ts` contained zero occurrences of `ipcAuthToken` — it invoked every handler with bare payloads the preload never sends | Reproduced 2026-08-25 from the packaged app's own `app.log` while sweeping Copilot instance provenance for [automation provider exclusions](../superpowers/plans/2026-07-30-automation-provider-exclusions_livetest_completed.md) check 6; root cause confirmed by parsing the real exported schemas against the real `withAuth()` output, with a passing control | Shared `ipcAuthTokenField` spread into all 10 payload schemas, keeping `.strict()` so rogue keys (`env`, `copilotHome`, `configPath`) are still refused and a non-string token is still rejected. 32 regression tests in `src/main/ipc/handlers/copilot-account-handlers.spec.ts` covering all 15 channels in both token states; mutation-checked by reverting the schema change and watching 13 of them fail |
| LT-524 | P1 | **FIXED IN CODE 2026-08-31; live re-check pending.** Durable registration now always sends a resume request, including an empty cursor list. The worker treats resume as discovery: it merges every buffered durability-ring instance absent from the coordinator's cursor set at sequence zero, recovering instances/turns produced wholly offline as well as unknown instances alongside known cursors | [WS15 evidence run 2026-08-25 (Batch E)](2026-07-13-fable-ws15_livetest.md#evidence-run--2026-08-25-batch-e) | `stream-durability-coordinator.spec.ts`; `worker-instance-notifier.spec.ts` |
| LT-525 | P1 | **FIXED IN CODE 2026-08-31; live re-check pending.** `degraded` now restores every nonterminal remote lifecycle state, including active turns, interrupts, and hibernation. Reconnect reconciliation isolates each instance in a try/catch so one stale transition cannot reject node registration or prevent later instances from reattaching | [WS15 evidence run 2026-08-25 (Batch E)](2026-07-13-fable-ws15_livetest.md#evidence-run--2026-08-25-batch-e) | `instance-state-machine.spec.ts`; `node-failover.spec.ts` |
| LT-526 | P0 | **FIXED IN CODE 2026-08-31; live re-check pending.** The hardened-mode/remote-location incompatibility is rejected before any remote or local-model adapter early return, so no `RemoteCliAdapter` can be constructed while the instance still claims hardened protection | [WS13 evidence run 2026-08-25 (Batch E)](2026-07-13-fable-ws13_livetest_completed.md#evidence-run--2026-08-25-batch-e) | `src/main/cli/adapters/__tests__/adapter-factory-hardened-remote.spec.ts` |
| LT-527 | P2 | **FIXED 2026-08-26.** `CopilotCliAdapter`'s constructor called `getDefaultCopilotCliLaunch()`, which runs up to three synchronous child processes — `which copilot`, `which gh`, and a `gh copilot --help` probe bounded at 5000ms. On any machine without the standalone `copilot` binary (every CI runner, and any user who installed Copilot only through `gh`) merely *constructing* the adapter blocked for as long as that probe took, measured at **5007ms**, on the Electron main thread. It also exceeded vitest's 5000ms default timeout, failing the first test in each Copilot adapter spec file and turning `main`'s CI red intermittently. Present since 2026-04-23; load-sensitive, hence the green/red flapping | [CI run 32947812436](https://github.com/Community-Tech-UK/ai-orchestrator/actions/runs/32947812436) | `src/main/cli/adapters/copilot-cli-adapter.lazy-launch.spec.ts` |
| LT-528 | P2 | **FIXED + REGRESSION-TESTED + LIVE-VERIFIED 2026-08-31.** A Codex instance created with `yoloMode: true` could consume a warm adapter that had been spawned without YOLO launch permissions. The renderer and instance record said YOLO was enabled, but the first MCP tool call still opened an approval request. A second, otherwise-identical instance forced onto a fresh adapter completed the tool call without approval. Fixed by blocking warm-adapter reuse whenever the resolved spawn requests YOLO permissions [Archived detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail) | [Session-scoped Computer Use autonomy livetest](../superpowers/plans/2026-08-26-session-scoped-computer-use-autonomy_plan_livetest.md) | `src/main/instance/lifecycle/__tests__/instance-spawn-preflight-chain.spec.ts` |
| LT-529 | P1 | **FIXED + REGRESSION-TESTED + LIVE-VERIFIED 2026-08-31.** Every generic Settings select rendered its first option instead of its persisted value on initial mount. The Computer Use autonomy select displayed `guarded` while the persisted and enforced value was `unrestricted`, a safety-critical false posture. Angular applied the select's raw `[value]` before its `@for` options existed; when the options arrived, the browser selected the first one. Fixed by marking the matching option selected as each option renders [Archived detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail) | [Computer Use autonomy level livetest](../superpowers/plans/2026-08-26-computer-use-autonomy-level_livetest.md) | `src/renderer/app/features/settings/setting-row.component.spec.ts` |
| LT-530 | P1 | **FIXED + INCIDENT-REPLAYED + REGRESSION-TESTED 2026-08-31; rebuilt UI re-check pending.** Claude's structured `authentication_failed` stream event arrived inside an `assistant` envelope. Both AIO Claude parsing paths rendered it as assistant prose, while a separate now-healthy auth probe could veto repair after another process refreshed the shared OAuth credentials. The adapters now emit an authoritative typed auth error; communication preserves the complete failed turn; repair restarts and replays it even when the later shared probe is healthy. CLI version detection no longer pretends a successful `--version` means authenticated | Session `470f3695-ba5b-497a-95a6-9ad8c5bf7b2f` and native Claude transcript | `src/main/cli/adapters/claude-cli-adapter.spec.ts`, `src/main/cli/spawn-worker/cli-adapter-worker-proxy.spec.ts`, `src/main/instance/instance-communication.spec.ts` |
| LT-531 | P2 | **FIXED IN CODE + MUTATION-CHECKED 2026-09-03; residual closed as LT-532.** A `record` (non-gating) loop preflight ran the workspace's full verify before iteration 0 under the complete `verifyTimeoutMs`. Where that command is the workspace's own `verify` script — auto-adopted by `resolveLoopVerification` when the user supplies none — the preflight burned the entire 600s budget, delayed the first agent turn by ten minutes, and recorded only `timed out`: no baseline at all, for a status no consumer reads. Non-gating budget now capped at 180s, and a passing quick-verify ends the preflight instead of also paying for the slow command. `block` mode is unchanged, because there the preflight is a real gate. Residual (no cheap command still paid 180s) is LT-532 | Loop `loop-1788392553418-c66131dc` `PRE_FLIGHT.md`: `Mode: record`, `Duration: 599971ms`, `(verify timed out after 600000ms)`, output tail still inside `check:dead` (step 6 of the 14-step chain) | `src/main/orchestration/loop-audit-runtime.spec.ts` |
| LT-532 | P2 | **FIXED IN CODE 2026-09-03; rebuilt-app check pending.** LT-531's residual: a `record` preflight with no quick-verify still ran the auto-inferred full `verify`, hit the 180s cap, delayed iteration 1 by three minutes, and painted a red `Preflight timed out` chip even though the run continued. Reproduced on `loop-1788423509509-eab2bd46` (`Mode: record`, `Duration: 179999ms`, `npm --prefix "ai-orchestrator" run verify`). Record mode now skips the slow command when no cheap baseline ran; the strip labels a record-mode timeout as `Preflight baseline unknown` (muted) and a not-yet-run final audit as `Final audit pending` | Loop `loop-1788423509509-eab2bd46` `PRE_FLIGHT.md`; operator screenshot of the running strip | `src/main/orchestration/loop-audit-runtime.spec.ts`, `src/renderer/app/features/loop/loop-audit-chips.util.spec.ts`, `src/renderer/app/features/loop/loop-control.component.spec.ts` |
| LT-533 | P2 | **NOT FIXED.** Title-generation escalation to the fast CLI tier never fires, and all three of its exits are invisible. With `titleGeneration.allowFrontierFallback` restored to `true` on 2026-09-08, a local model that returns unusable output is supposed to fall through to the antigravity/Claude-Haiku/Codex one-shot. Observed on the one real opportunity (09:20:31): the local model succeeded (450 output tokens), `finalizeGeneratedTitle` correctly rejected its output, the code fell through — and no CLI attribution record and no AI title were produced. Across all of September there is not one CLI-provider `aux:titleGeneration` record (4224 `local-fallback`, 395 `ollama`) while `claude` and `codex` are both on PATH. Which exit was taken cannot be determined: `!cliType` and `!hasSendMessage` are `logger.debug` and the send failure is a bare `catch { return null; }`, and debug is not persisted. **Required fix:** log the escalation outcome at info/warn with the reason (no CLI resolved / adapter cannot one-shot / send threw + error), then re-run to find out why it produces nothing. **Acceptance:** a title generation whose local output is rejected either produces a CLI-attributed title or logs a specific, greppable reason it could not. | [Session title livetest LT-C](2026-09-08-session-title-generation-repair_livetest.md) | LT-C in that livetest |
| LT-534 | P3 | **NOT FIXED.** The live and history title resolvers apply sanitize/truncate in opposite orders, so a long generated title still renders one character differently either side of a session going non-live. `resolveEffectiveInstanceTitle` sanitizes then truncates, keeping the `...` that `truncateForRail` appends; `getConversationHistoryTitle` truncates inside `deriveRailTitle` then sanitizes, and `sanitizeGeneratedTitle`'s `.replace(/[.!?]+$/, '')` strips that `...` off. Live `"Daily health check of the Dingley Assessment servers and..."` vs history `"...servers and"`. Introduced by the 2026-09-08 title-stability work, which cut deterministic drift from 222/2000 entries to 47 and rail-overflow from 188 to 0 but left this. A second, structural residue in the same 47 is out of scope for a one-line fix: `truncatePreview` (`history-manager.ts:1739`) collapses newlines before storing `firstUserMessage`, so a history entry has no line structure and `deriveRailTitle`'s first-line-only rule cannot be reproduced from it. **Required fix:** apply one shared normalize-then-truncate order in both resolvers. **Acceptance:** genuine deterministic drift (entries with no `aiTitle`) falls below the current 47 with no over-limit renders. | [Session title livetest LT-E](2026-09-08-session-title-generation-repair_livetest.md) | LT-E in that livetest |
| LT-535 | P1 | **FIXED + REGRESSION-TESTED 2026-09-17; rebuilt-app check pending.** A regular session parked on a provider limit resumed on schedule and then sent nothing, so the session sat idle exactly as if auto-resume were off. The park re-sends `resumePrompt`, which is read from `InstanceCommunicationOverflowTracker.lastSent` — populated only by `InstanceCommunicationManager.sendInput`. A session driven by its create-time initial prompt dispatches straight to the adapter (`sendInitialPromptWithAttachmentFallback`), so nothing is ever recorded, and a park raised on that turn's *completion* — the normal Claude shape, where the five-hour limit arrives as exit-0 assistant content — stored `resumePrompt: null`. `resumeNow()` then cleared the park, logged "Cleared provider-limit park with no message to re-send", and stopped. Hibernation was ruled out as the cause: `cuggrdz6x` was hibernated by the idle sweep and still woke and resumed. Re-sending the initial prompt is not a valid fix — by the time a five-hour window closes the session can be hours into that task — so a promptless resume now sends the shared continuation turn the durable automation already composed for its own fall-through path | 2026-09-17 five_hour incident in `~/Library/Application Support/Harness/logs/app.log`: parks at 18:39 (Europe/London) for `cz37wakz1` and `cf8v1xrl6` and 19:03 for `c8n0z4wyg` (0 `sendInput` calls each, promptless park, silent resume at 20:30:05) against `cuggrdz6x` and `cp0nlqnbs` (10 and 5 `sendInput` calls, both resumed and re-sent) | `src/main/instance/instance-provider-limit-handler.spec.ts` |
| LT-536 | P1 | **FIXED + REGRESSION-TESTED 2026-09-18; rebuilt-app check pending.** Eight loop runs (2026-08-24 to 2026-09-06) ended with their work uncommitted in `.worktrees/task-*` and lifecycle phase `blocked` (`Harvest failed with uncommitted work`), invisible to `git log`/`git branch`. `harvestWorktree` and the boot-reconcile harvest committed without `--no-verify`, so the repository pre-commit hook refused the safety commit: either the plan-spec guard (active plan docs staged) or `.githooks/pre-commit: line 10: node: command not found`, because the packaged app's PATH has no `node`. The index was left fully staged, and each boot re-ran the same refused commit. **Required fix:** the harvest commit cannot be refused by a hook; landing rules move to an explicit pre-integration check; boot recovery never auto-lands a blocked run whose branch changed outside AIO; the UI stops calling uncommitted work "saved". **Acceptance:** see the LT-536 section. | 2026-09-18 stranded-worktree rescue: `loop_runs` rows in `loop-mode/loop-mode.db`, `WorktreeManager: harvest failed` lines in `~/Library/Application Support/harness/logs/app.log.3` and `app.log.4` (7 of 8 runs; the eighth predates log retention) | `src/main/workspace/git/worktree-manager.spec.ts`, `src/main/orchestration/loop-worktree-lifecycle.spec.ts`, `src/main/orchestration/loop-worktree-lifecycle-reconcile.spec.ts`, `src/renderer/app/features/loop/managed-worktree-status.util.spec.ts` |
| LT-537 | P2 | **FIXED + REGRESSION-TESTED 2026-09-19; rebuilt-app check pending.** `workspaceSecretsAllowAgentRequests` is documented as an operator-only switch — "When false, agents cannot raise a `secret_required` card" (`src/shared/types/settings.types.ts:320-324`) — but nothing read it. A repo-wide search found reads only in settings metadata, defaults, surfacing and docs; no enforcement anywhere, so turning it off changed nothing and an agent could still raise a secret card. `workspaceSecretsEnabled` was enforced only for MCP connector materialisation (`spawn-config-builder.ts:274`), not for the card. **Required fix:** refuse the request in the main process before it reaches the renderer, answer the agent so it does not wait on a prompt nobody will see, and leave a visible system note. **Acceptance:** with either switch off, a `secret_required` input-required is not forwarded, the agent gets a refusal, and a system message records it; with both on it forwards unchanged; unreadable settings fail closed. | 2026-09-19 code-completeness audit of the stranded-worktree rescue; no live incident | `src/main/instance/instance-permission-request-flow.spec.ts` |
| LT-538 | P2 | **FIXED + REGRESSION-TESTED 2026-09-19.** Every loop parked on a provider limit showed the hint "Provider-limit recovery is off, so it will sit here rather than resume itself … the run is simply dead until morning" whenever `instanceProviderLimitResumeEnabled` was off — its default. That was false: the setting gates only `InstanceProviderLimitHandler` (regular sessions, `instance-manager.ts:439`), and a loop parks through `LoopProviderLimitHandler.scheduleResume` (`loop-provider-limit-handler.ts:486`), which reads no setting and falls back to an in-process timer, so the loop resumes on its own. The false premise then spread: the 2026-09-19 timeline-recovery work built a "Turn on auto-resume" button on it, caught by the completion gate before landing. **Required fix:** never tell the operator a parked loop needs them to resume it. **Acceptance:** the hint no longer exists; the causal timeline says a parked loop "resumes on its own" and offers no settings button. | 2026-09-19 completion-gate review of the stranded-worktree follow-ups; code trace | `src/renderer/app/features/loop/loop-causal-timeline.spec.ts`, `loop-control-timeline.spec.ts` |
| LT-539 | P2 | **FIXED IN CODE; live check pending.** A hardened create adopted an unsandboxed warm process while the UI reported hardened mode. | [LT-539 detail](#lt-539) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-539) |
| LT-540 | P2 | **FIXED IN CODE; live check pending.** An isolated packaged smoke run replaced Chrome’s machine-global native host manifest with a throwaway path. | [LT-540 detail](#lt-540) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-540) |
| LT-541 | P0 | **REOPENED 2026-09-24 — fix was never on `main`; ported to the working tree, unit-verified, live re-check pending.** The 2026-09-20 fix and live verification existed only on the land-blocked queue branch `queue/2026-07-13-fable-ws15-332c74`. Remote assistant replies existed in the CLI transcript but never reached the instance output buffer. | [LT-541 detail](#lt-541) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-541) |
| LT-542 | P1 | **REOPENED 2026-09-24 — fix was never on `main`; ported to the working tree, unit-verified, live re-check pending.** Same land-blocked queue branch as LT-541. A heartbeat-timeout disconnect aborted durable worker work instead of opening the parked-work window. | [LT-542 detail](#lt-542) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-542) |
| LT-543 | P2 | **FIXED IN CODE; live check pending.** A restarted browser forwarder restored revealed tools but its restoration and failure logs were absent from `app.log` and stderr. | [LT-543 detail](#lt-543) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-543) |
| LT-544 | P2 | **FIXED IN CODE; live check pending.** Extension commands timed out on both Windows and Mac while health called the channels deliverable. | [LT-544 detail](#lt-544) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-544) |
| LT-545 | P2 | **FIXED IN CODE; live check pending.** Renderer IPC calls such as skills discover, set-control and match failed payload validation. [Archived detail](livetest-remediation-register-archive-2026.md#lt-545-archived-detail) | [LT-545 detail](#lt-545) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-545) |
| LT-546 | P2 | **FIXED IN CODE; live check pending.** A suggest-only global skill had no row to promote, and the panel could label its mode On. [Archived detail](livetest-remediation-register-archive-2026.md#lt-546-archived-detail) | [LT-546 detail](#lt-546) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-546) |
| LT-547 | P2 | **FIXED IN CODE; live check pending.** An enabled oversized skill was detected but silently omitted from injection and Skill Health. | [LT-547 detail](#lt-547) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-547) |
| LT-548 | P2 | **FIXED IN CODE; live check pending.** A materialized workspace secret appeared in a CLI `--mcp-config` argv value visible to another shell. [Archived detail](livetest-remediation-register-archive-2026.md#lt-548-archived-detail) | [LT-548 detail](#lt-548) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-548) |
| LT-549 | P2 | **FIXED IN CODE; live check pending.** A rejected secret-card save left the credential in the password input. [Archived detail](livetest-remediation-register-archive-2026.md#lt-549-archived-detail) | [LT-549 detail](#lt-549) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-549) |
| LT-550 | P2 | **FIXED IN CODE; live check pending.** Workspace Secrets hid the agent-facing slug, timestamps and audit history. [Archived detail](livetest-remediation-register-archive-2026.md#lt-550-archived-detail) | [LT-550 detail](#lt-550) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-550) |
| LT-551 | P2 | **FIXED IN CODE; live check pending.** A live agent could not raise the secret card through any reachable protocol. | [LT-551 detail](#lt-551) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-551) |
| LT-570 | P2 | **CONFIRMED FIXED LIVE 2026-09-24.** Settings Help and compact navigation now trap/restore keyboard focus correctly. [Archived detail](livetest-remediation-register-archive-2026.md#lt-570-archived-detail) | [LT-570 detail](#lt-570) | [Settings UX live evidence](2026-08-28-settings-ux-remediation_livetest_completed.md#evidence-run--2026-09-24-settings) |
| LT-571 | P2 | **CONFIRMED FIXED LIVE 2026-09-24.** Remote Nodes Pairing now renders its disabled-state explanation. [Archived detail](livetest-remediation-register-archive-2026.md#lt-571-archived-detail) | [LT-571 detail](#lt-571) | [Settings UX live evidence](2026-08-28-settings-ux-remediation_livetest_completed.md#evidence-run--2026-09-24-settings) |
| LT-572 | P2 | **CONFIRMED FIXED LIVE 2026-09-24.** Toggle and all collapsed rail items meet the 44 × 44 pointer target floor at every tested height. [Archived detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail) | [LT-572 detail](#lt-572) | [Settings UX live evidence](2026-08-28-settings-ux-remediation_livetest_completed.md#evidence-run--2026-09-24-verify-ui) |
| LT-573 | P2 | **CONFIRMED FIXED LIVE 2026-09-24.** The shared save-state banner exposes the expected live-region/error semantics. [Archived detail](livetest-remediation-register-archive-2026.md#lt-573-archived-detail) | [LT-573 detail](#lt-573) | [Settings UX live evidence](2026-08-28-settings-ux-remediation_livetest_completed.md#evidence-run--2026-09-24-settings) |
| LT-574 | P2 | **CONFIRMED FIXED LIVE 2026-09-24.** Three consecutive Ecosystem listings returned the same two commands. [Archived detail](livetest-remediation-register-archive-2026.md#lt-574-archived-detail) | [LT-574 detail](#lt-574) | [Settings UX live evidence](2026-08-28-settings-ux-remediation_livetest_completed.md#evidence-run--2026-09-24-settings) |
| LT-575 | P2 | **CONFIRMED FIXED LIVE 2026-09-24.** Both originally reported light-theme surfaces measure 16.16:1. [Archived detail](livetest-remediation-register-archive-2026.md#lt-575-archived-detail) | [LT-575 detail](#lt-575) | [Settings UX live evidence](2026-08-28-settings-ux-remediation_livetest_completed.md#evidence-run--2026-09-24-settings) |
| LT-590 | P2 | **FIXED IN CODE; live check pending.** The loop diagnosis severity chip, tag and primary buttons lost contrast in light theme. [Archived detail](livetest-remediation-register-archive-2026.md#lt-590-archived-detail) | [LT-590 detail](#lt-590) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-590) |
| LT-591 | P2 | **FIXED IN CODE; live check pending.** WARN escalation displayed “Repeating the same work” without a matching work-hash signal. [Archived detail](livetest-remediation-register-archive-2026.md#lt-591-archived-detail) | [LT-591 detail](#lt-591) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-591) |
| LT-592 | P2 | **FIXED IN CODE; live check pending.** One issue card showed a decision tag, a hint next step and two primary actions. [Archived detail](livetest-remediation-register-archive-2026.md#lt-592-archived-detail) | [LT-592 detail](#lt-592) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-592) |
| LT-593 | P2 | **FIXED IN CODE; live check pending.** Stop on a busy Claude turn ended its session and restored the queued message as a draft. [Archived detail](livetest-remediation-register-archive-2026.md#lt-593-archived-detail) | [LT-593 detail](#lt-593) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-593) |
| LT-594 | P2 | **FIXED IN CODE; live check pending.** Terminal causal-timeline readings and cap recovery never appeared in the UI. [Archived detail](livetest-remediation-register-archive-2026.md#lt-594-archived-detail) | [LT-594 detail](#lt-594) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-594) |
| LT-595 | P2 | **FIXED IN CODE; live check pending.** After closed-session continuation the composer model label stayed on the old model. [Archived detail](livetest-remediation-register-archive-2026.md#lt-595-archived-detail) | [LT-595 detail](#lt-595) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-595) |
| LT-596 | P2 | **FIXED IN CODE; live check pending.** A Codex native child rollout consumed tokens that no instance ledger entry charged. [Archived detail](livetest-remediation-register-archive-2026.md#lt-596-archived-detail) | [LT-596 detail](#lt-596) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-596) |
| LT-597 | P2 | **FIXED IN CODE; live check pending.** An interrupted Codex turn produced prose and moved quota usage while the ledger stayed unchanged. [Archived detail](livetest-remediation-register-archive-2026.md#lt-597-archived-detail) | [LT-597 detail](#lt-597) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-597) |
| LT-598 | P2 | **FIXED IN CODE; live check pending.** The context manifest omitted adapter-appended Browser Gateway instructions from delivered native input. [Archived detail](livetest-remediation-register-archive-2026.md#lt-598-archived-detail) | [LT-598 detail](#lt-598) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-598) |
| LT-599 | P2 | **FIXED IN CODE; live check pending.** A rendered streaming bubble could shrink despite the canonical content rewind guard. [Archived detail](livetest-remediation-register-archive-2026.md#lt-599-archived-detail) | [LT-599 detail](#lt-599) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-599) |
| LT-600 | P2 | **FIXED IN CODE; live check pending.** An ACP Stop settled idle but left only an interrupt-requested record. [Archived detail](livetest-remediation-register-archive-2026.md#lt-600-archived-detail) | [LT-600 detail](#lt-600) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-600) |
| LT-601 | P2 | **FIXED IN CODE; live check pending.** A user Stop was persisted as a completed turn. [Archived detail](livetest-remediation-register-archive-2026.md#lt-601-archived-detail) | [LT-601 detail](#lt-601) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-601) |
| LT-602 | P2 | **FIXED IN CODE; live check pending.** The session header omitted reasoning effort chosen at spawn. [Archived detail](livetest-remediation-register-archive-2026.md#lt-602-archived-detail) | [LT-602 detail](#lt-602) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-602) |
| LT-603 | P2 | **FIXED IN CODE; live check pending.** A restart lost its retained child record before fallback reconciliation could report it. | [LT-603 detail](#lt-603) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-603) |
| LT-604 | P2 | **FIXED IN CODE; live check pending.** A worker paired after starting a disabled server stayed “disconnected” in the roster. | [LT-604 detail](#lt-604) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-604) |
| LT-605 | P2 | **FIXED IN CODE; live check pending.** A recovery candidate existed but the startup notice never rendered. [Archived detail](livetest-remediation-register-archive-2026.md#lt-605-archived-detail) | [LT-605 detail](#lt-605) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-605) |
| LT-606 | P2 | **FIXED IN CODE; live check pending.** Resume Picker row actions had no visible keyboard focus ring. [Archived detail](livetest-remediation-register-archive-2026.md#lt-606-archived-detail) | [LT-606 detail](#lt-606) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-606) |
| LT-610 | P2 | **FIXED IN CODE; live check pending.** Deep-linking to approval B highlighted B but left keyboard focus on approval A. [Archived detail](livetest-remediation-register-archive-2026.md#lt-610-archived-detail) | [LT-610 detail](#lt-610) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-610) |
| LT-611 | P2 | **FIXED IN CODE; live check pending.** A browser mutation without `instanceId` raised approval, then could not redeem it on retry. [Archived detail](livetest-remediation-register-archive-2026.md#lt-611-archived-detail) | [LT-611 detail](#lt-611) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-611) |
| LT-612 | P2 | **FIXED IN CODE; live check pending.** Cursor and Grok nonzero shell exits were recorded as successful tool results. [Archived detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail) | [LT-612 detail](#lt-612) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-612) |
| LT-613 | P2 | **FIXED IN CODE; live check pending.** Clicking a History entry expanded it then closed the sidebar. [Archived detail](livetest-remediation-register-archive-2026.md#lt-613-archived-detail) | [LT-613 detail](#lt-613) | [Remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-613) |
| LT-614 | P2 | **FIXED + REGRESSION-TESTED 2026-09-22 (landed in `46cd2aa0`); rebuilt-app check done in the dev app.** A generic ACP "Input Required" approval card (OpenCode, Grok, Cursor, Copilot) whose request timed out (60 s auto-reject) stayed on screen, and its Cancel button did nothing; answering a card also left its PermissionRegistry entry open, so the "blocked on approval" banner showed answered requests and the approval audit recorded them as timeout denials. |
| LT-615 | P3 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree, uncommitted); live re-check pending.** `browser.close_matching` with `urlContains`/`titleContains` counted a tab Chrome had already closed as one it closed. | [LT-615 detail](#lt-615) | [Tab close livetest](2026-09-10-browser-tab-close-and-inspection-metadata_livetest_completed.md) |
| LT-616 | P3 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree, uncommitted); live re-check pending.** A browser command requeued after a failed poll-response handoff left no trace, so LT-371 channel-flapping check 2 could not correlate its command id. | [LT-616 detail](#lt-616) | [Channel-flapping livetest](../superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest.md) |
| LT-617 | P2 | **FIXED IN CODE, committed in `39d245ba`; live re-check still needs extension 0.2.35 on `windows-pc`.** `browser.health` reported `windows-pc` extension secret-observation state as `{reported: false}` after a successful `report_inventory` refresh from extension 0.2.34, so the protection state the extension reported never reached health. | [LT-617 detail](#lt-617) | [Login recipe livetest](2026-09-23-browser-login-recipe-persistence_livetest.md) |
| LT-618 | P2 | **PARTLY FIXED IN CODE 2026-09-24 (refresh budget + unchanged-value fast path; the unbounded extension boundary queue remains); live re-check needs extension 0.2.35.** Every `report_inventory` sent to the local Mac extension (0.2.34) times out, after which the extension stops polling for minutes and reconnects with `native_host_stdin_eof`; the local tab inventory has not been confirmed since `1790209756`. | [LT-618 detail](#lt-618) | [Reliability livetest](2026-07-17-browser-gateway-reliability_livetest.md) |
| LT-619 | P2 | **CODE HALF FIXED + REGRESSION-TESTED 2026-09-24 (working tree); OPERATOR HALF NEEDS JAMES.** The coordinator's mDNS advertisement is invisible on this Mac because macOS refuses Harness multicast (EHOSTUNREACH, no Local Network permission), and each refused answer surfaced as an uncaught main-process exception while startup logged "mDNS service published". | [LT-619 detail](#lt-619) | [Remote-node resilience livetest](2026-09-07-remote-node-resilience_livetest.md) |
| LT-620 | P2 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); live re-check pending.** LT-611's empty-string sentinel survived in four more grant lookups (`request_grant` ×2, `close_tab`/`close_matching`, existing-tab `navigate`, file-upload candidates), so a caller with no `instanceId` could never redeem a grant it had just been given. [Archived detail](livetest-remediation-register-archive-2026.md#lt-620-archived-detail) | [LT-620 detail](#lt-620) | [Approval coherence livetest](../superpowers/plans/2026-09-01-browser-approval-coherence_livetest.md) |
| LT-621 | P2 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); live re-check pending.** The packaged app never advertised its Tailscale MagicDNS URL to workers, because the macOS Tailscale binary answers in GUI mode without a shell environment and that non-JSON reply ended the candidate search. | [LT-621 detail](#lt-621) | [Worker offline resilience livetest](2026-09-22-worker-offline-resilience_livetest.md) |
| LT-630 | P3 | **FIXED + CONFIRMED LIVE 2026-09-24 (working tree)** for the cited elements. Light-theme text on same-colour tints (`--pill-ok-fg`/`--pill-error-fg`/`--primary-color` on low-alpha tints of themselves) fails 4.5:1 on Remote Nodes, Permissions, Auxiliary Models and Ecosystem, surfaces LT-575 did not cover. [Archived detail](livetest-remediation-register-archive-2026.md#lt-630-archived-detail) | [LT-630 detail](#lt-630) | [Settings UX livetest](2026-08-28-settings-ux-remediation_livetest_completed.md) |
| LT-631 | P2 | **FIXED (three causes) + CONFIRMED LIVE 2026-09-24 (working tree).** A tall project `⋯` menu is clipped by its scrolling ancestor `.instance-viewport` (a 413 px visible box in a 900 px window), below the menu's own 420 px cap, so items and its rounded corner are cut off. [Archived detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail) | [LT-631 detail](#lt-631) | [Copilot account routing livetest](../superpowers/plans/2026-08-25-copilot-account-routing_plan_livetest.md) |
| LT-640 | P2 | **FIXED (two faults) 2026-09-24 (working tree): schema confirmed live; panel refresh key fixed after a live reopen; live re-check pending.** `loop:state-changed` broadcasts carrying `lifecycleOnly: true` were rejected by the strict event schema (19 blocked in the production `app.log`), so a running renderer never saw a loop's post-completion worktree outcome. [Archived detail](livetest-remediation-register-archive-2026.md#lt-640-archived-detail) | [LT-640 detail](#lt-640) | [Stranded worktree rescue livetest](2026-09-18-stranded-worktree-rescue_livetest_completed.md) |
| LT-641 | P1 | **FIXED (two faults) 2026-09-24 (working tree): schema confirmed live; request cards now also mounted in chat detail after a live reopen; live re-check pending.** Agent `secret_required` requests were blocked on `user-action:request` because the event schema lacked that type and `secretRequest`, so the card appeared only when the view later pulled pending requests. [Archived detail](livetest-remediation-register-archive-2026.md#lt-641-archived-detail) | [LT-641 detail](#lt-641) | [Stranded worktree rescue livetest](2026-09-18-stranded-worktree-rescue_livetest_completed.md) |
| LT-642 | P3 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree).** Resuming a terminal loop that exists only as a checkpoint printed the restore path's internal error instead of the documented "is terminal" message. [Archived detail](livetest-remediation-register-archive-2026.md#lt-642-archived-detail) | [LT-642 detail](#lt-642) | [Agent-reachable loop resume livetest](../superpowers/plans/2026-09-19-agent-reachable-loop-resume_livetest.md) |
| LT-643 | P1 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); live re-check pending.** A ping-pong loop hangs forever after round 1's reviewer settles with a valid verdict: no verdict is logged, no round is shown, and the 600 s review timeout never fires. [Archived detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail) | [LT-643 detail](#lt-643) | [Ping-pong livetest](PINGPONG_IMPLEMENTATION_STATUS_livetest_completed.md) |
| LT-644 | P2 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); live re-check (ping-pong check 2) pending.** Root cause found in the captured Codex rollouts: the reviewer prompt never named the finding fields. Every ping-pong reviewer round (6 of 6, across 3 real Claude-builder/Codex-reviewer loops) returned `CHANGES_REQUESTED` with **0** parsed findings, so the builder gets no actionable issue, the open-issues ledger stays empty, and Arbitrate can never become available. | [LT-644 detail](#lt-644) | [Ping-pong livetest](PINGPONG_IMPLEMENTATION_STATUS_livetest_completed.md) |
| LT-650 | P3 | **FIXED IN `39d245ba`; quota IPC confirmed live 2026-09-24, Settings DOM clause not rechecked.** Before the fix, switching OpenCode off a MiMo Token Plan model made the gated probe return `null` while stale Token Plan numbers remained on screen. | [LT-650 detail](#lt-650) | [MiMo Token Plan livetest](2026-09-23-mimo-token-plan-allowance_livetest.md) |
| LT-651 | P3 | **FIXED + CONFIRMED LIVE 2026-09-24 (working tree).** A fresh instance's `contextEvidence` never reaches the renderer `InstanceStore` until reload: the early `created` emit races evidence initialisation (the LT-602 gap, for a sibling field). [Archived detail](livetest-remediation-register-archive-2026.md#lt-651-archived-detail) | [LT-651 detail](#lt-651) | [Context evidence livetest](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md) |
| LT-652 | P1 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); live re-check pending.** A user message sent during a Codex app-server auto-compaction turn is rejected `ActiveTurnNotSteerable { turn_kind: Compact }`, then burned through all 5 queue retries in 622 ms (no backoff; the status-revert path re-drains immediately) and was dropped, while the instance still reported `idle`. The Compact turn finished ~57 s later. | [LT-652 detail](#lt-652) | Session `xecsi91o3` re-send after `thread/compacted`, or any send that lands during a Codex auto-compact |
| LT-653 | P1 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); live re-check pending. Root cause superseded by [LT-657](#lt-657):** the reworded text still travelled as user-role input. The context-policy `steer-turn` text ("Stop broad exploration. Synthesize what you already have, persist durable notes…") is delivered as ordinary turn input, so agents record it as *"James requested a stop"* and halt work ("Work remains stopped as requested") with no user stop request anywhere in the transcript. | [LT-653 detail](#lt-653) | Any session where a policy `steer-turn` fires and the agent writes a handoff/plan |
| LT-654 | P1 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); rebuilt-app checks pending.** Codex provider Compact turns were invisible to instance lifecycle ownership, so sends and steering could be rejected or dropped, controlled recovery could fail, status could become idle/error mid-compaction, and hibernation/zombie handling could act on live provider work. | [LT-654 detail](#lt-654) | [Codex compaction visibility checks 1, 2 and 4](2026-09-24-codex-compaction-turn-visibility_livetest.md) |
| LT-655 | P2 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); rebuilt-app check pending.** Normal provider compaction appeared as error cards and a fabricated 0% context reading, with no useful composer explanation. | [LT-655 detail](#lt-655) | [Codex compaction visibility check 3](2026-09-24-codex-compaction-turn-visibility_livetest.md) |
| LT-656 | P2 | **FIXED + REGRESSION-TESTED 2026-09-24 (working tree); rebuilt-app check pending.** Context-policy decisions, provider action proof, and provider compaction lifecycle/outcomes lacked one directly queryable diagnostic trail. | [LT-656 detail](#lt-656) | [Codex compaction visibility check 5](2026-09-24-codex-compaction-turn-visibility_livetest.md) |
| LT-657 | P1 | **FIXED + REGRESSION-TESTED 2026-09-25 (working tree); rebuilt-app check pending.** Harness-authored input reached the model and the transcript as the user's own message: the Codex context-policy steer ("Stop broad exploration…") was persisted by Codex as `role: "user"` and the agent told the user "You did" ask to stop; automatic check-ins, child announcements, continuity packages and continuation prompts were stored as `type: 'user'`. | [LT-657 detail](#lt-657) | Any Codex session where a policy `steer-turn` fires; any session receiving an automatic check-in or child announcement |
| LT-658 | P1 | **FIXED + REGRESSION-TESTED 2026-09-27 (working tree); v0.2.37 reload/live re-check in RES-023.** `browser.type` reported success and changed the DOM value of disabled and readonly native controls because its native property setters bypass browser interaction semantics without checking either state. Both selector and accessibility-UID paths now refuse before mutation with the target tag, state, and remedy. | [LT-658 detail](#lt-658) | [Browser Gateway unattended portal fixes check 3](2026-08-28-browser-gateway-unattended-portal-fixes_livetest_completed.md#check-3--type-fails-loudly-on-a-non-typeable-target) · [RES-023](2026-09-27-livetest-human-external-residuals_livetest.md#res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live) |
| LT-659 | P2 | **FIXED + REGRESSION-TESTED + CONFIRMED LIVE 2026-09-27 (working tree).** The newly wired standalone `aio review` entrypoint selected zero reviewers for `--reviewers none` but then failed because it unconditionally constructed Electron's settings store in a plain Node process. [Archived detail](livetest-remediation-register-archive-2026.md#lt-659-archived-detail) | [LT-659 detail](#lt-659) | [Cross-model policy LT-G](2026-09-02-cross-model-checking-policy_livetest_completed.md#lt-g--aio-review---reviewers-none-spawns-nothing) |
| LT-660 | P1 | **FIXED + REGRESSION-TESTED 2026-09-27 (working tree); rebuilt-app re-check in AR-006.** The terminate confirmation declared `aria-modal="true"` but only moved focus into the dialog once; its third Tab escaped to the app shell. It now uses the shared focus trap, cycles only through its two actions, and restores the opener on close. | [LT-660 detail](#lt-660) | [Enhancements backlog check 3](2026-09-03-enhancements-backlog_livetest_completed.md#check-3--focus-lands-in-the-dialog--partial--focus-lands-but-is-not-trapped) · [AR-006](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-006--enhancements-backlog-rebuilt-app-closure-campaign) |
| LT-661 | P2 | **FIXED + REGRESSION-TESTED + CONFIRMED LIVE 2026-09-27 (working tree).** Automatic title escalation stopped after the first installed CLI even when that provider failed before returning a response, so a broken preferred provider prevented healthy later providers from generating the title. [Archived detail](livetest-remediation-register-archive-2026.md#lt-661-archived-detail) | [LT-661 detail](#lt-661) | [Session title repair LT-B/LT-C](2026-09-08-session-title-generation-repair_livetest_completed.md#closure-evidence--2026-09-27-rebuilt-dev-runtime) · [Title escalation LT-F](2026-09-08-title-escalation-and-resolver-parity_livetest_completed.md#lt-f--closed) |
| LT-662 | P2 | **FIXED + REGRESSION-TESTED 2026-09-27 (working tree); rebuilt-runtime re-check pending.** The renderer preload sent `SETTINGS_GET` a bare key string even though the handler and Zod IPC contract require `{ key }`, so every `electronAPI.getSetting(key)` call failed validation. | [LT-662 detail](#lt-662) | [Plan Queue relaxation check 6](2026-09-18-plan-queue_livetest.md#6-relaxation-profile-restore) |
| LT-663 | P1 | **FIXED + REGRESSION-TESTED + CONFIRMED LIVE 2026-10-04.** The indexed source lookup preserves the genuine recorded user beyond the old 200-row window. Newly executed Windows worker tools retain complete, distinct captures with correct canonical ownership; the synthetic localhost tour campaign and owned cleanup pass. Fresh independent completion review: PASS. [Archived detail](livetest-remediation-register-archive-2026.md#lt-663-archived-detail) | [LT-663 detail](#lt-663); [completed follow-up plan](2026-10-03-mcp-evidence-source_plan_completed.md) | [Completed MCP evidence source and Windows fixture checks](2026-10-03-mcp-evidence-source_livetest_completed.md) |
| LT-664 | P3 | **OPEN — reproduced live 2026-10-04.** Retiring a Local AI target never closes its open incidents. The retired Ollama target's `connection-refused` incident stayed `open` in `local-ai status` for 10+ hours after retirement, because a retired target is no longer probed and probe recovery is the only path that resolves an incident. | [LT-664 detail](#lt-664) | [Aux LLM check 1](2026-10-03-aux-llm-lmstudio-dual-gpu_livetest.md); [Local AI CLI parity check 1](2026-10-04-local-ai-cli-parity_livetest.md) |
| LT-665 | P2 | **OPEN — check-session guard and inventory stamp fixed in the working tree (extension 0.2.39); live confirmation still open.** `browser.check_session` used to treat `host_permission_denied` as logged out and drive a re-login (2026-10-04). A tab Chrome restored at startup was still inventoried as `readable` (LCN pageId `771576274`, 2026-10-11). Both now stay `unknown` / `inspection_unavailable` without hiding the URL. Live confirmation needs extension 0.2.39 on `windows-pc`. | [LT-665 detail](#lt-665) | [Login recipe check 1](2026-09-23-browser-login-recipe-persistence_livetest.md) |
| LT-666 | P3 | **OPEN — reproduced live 2026-10-04.** A login recipe whose markers only appear on some pages (In-tend `["My Tenders","Current"]`) classifies every other signed-in page as logged out, including its own login URL, so auto re-login can never succeed; the failure surfaces as `credential_fill_failed` instead of "already signed in / markers do not match". `remember_login_fingerprint` does not check the markers against the live page. | [LT-666 detail](#lt-666) | [Login recipe check 1](2026-09-23-browser-login-recipe-persistence_livetest.md) |
| LT-690 | P2 | **OPEN — reproduced live 2026-10-04.** A genuine output-ceiling ending on OpenCode `xiaomi-token-plan-ams/mimo-v2.6-pro` (OpenCode's own record: `finish: "length"`, output 16229 + reasoning 155 = the 16384 combined cap) reaches Harness as ACP `stopReason: "end_turn"` with no native finish field, so it is classified `completed / provider_completed`, not `max_output`: no notice, no automatic continuation, and the visible answer is silently cut off mid-list. The classifier's native-length path is inert for the target model on installed OpenCode 1.18.34 (the plan records this as an unapplied upstream proposal); the adapter already knows the cap (`generationBudget.combinedOutputTokens`) but never compares it with the turn's token usage. | [LT-690 detail](#lt-690) | [Provider hardening check 1](2026-10-02-provider-hardening_livetest.md) |
| LT-670 | P1 | **OPEN — reproduced live 2026-10-04.** The renderer's 15 s respawn watchdog force-terminates (and archives) any session that is merely waiting out a 30 s or longer circuit-breaker backoff, so the fourth unexpected provider exit of one session within an hour destroys it with no notice and no restart. | [LT-670 detail](#lt-670) | [Crash-turn auto-continue LT-C](2026-09-28-crash-turn-auto-continue_livetest.md) |
| LT-671 | P2 | **OPEN — reproduced live 2026-10-04.** A turn cut off by a provider crash is not auto-continued when the restart falls back to a fresh-session replay (crash before a resumable transcript exists): the continuation owner sees a stale `respawning` wait reason, `reserve()` refuses silently, and the session just sits idle with only the "provider process stopped" notice. | [LT-671 detail](#lt-671) | [Crash-turn auto-continue LT-A](2026-09-28-crash-turn-auto-continue_livetest.md) |
| LT-672 | P3 | **OPEN — reproduced live 2026-10-04.** A user Stop on a Claude session leaves the notice "The provider ended this turn with an error" in the transcript, because the interrupted result is classified as `unknown_error` instead of a client cancellation. | [LT-672 detail](#lt-672) | [Crash-turn auto-continue LT-B](2026-09-28-crash-turn-auto-continue_livetest.md) |
| LT-673 | P2 | **OPEN — reproduced live 2026-10-04 (dev renderer reload; packaged cold start untested).** Reloading the renderer leaves the session list empty and `loading` stuck true: the first `state:resync` goes out before `appReady` delivers the IPC auth token, is refused with `IPC_AUTH_FAILED`, and `loadInitialInstances` ignores a `success:false` response. | [LT-673 detail](#lt-673) | [Session title quality check 3](2026-09-30-session-title-quality_livetest.md) |
| LT-674 | P3 | **OPEN — reproduced live 2026-10-04 on a staged legacy `type: error` event.** The adapter correctly emits one `complete {turnErrored:true}`, but the instance layer has already torn the adapter down after the `error` event, so the completion is dropped: no `adapter-event:complete` capture, no cost, telemetry or hooks. LT-105's purpose is not met on the real instance path. | [LT-674 detail](#lt-674) | [Outstanding plans sweep check 3](2026-09-23-outstanding-plans-sweep_livetest.md) |
| LT-675 | P3 | **OPEN — reproduced live 2026-10-04.** With a signed-out Claude CLI home, the title escalation accepts the CLI's "Not logged in · Please run /login" banner as the session's AI title (four sessions in one run), because no title guard recognises an authentication banner. | [LT-675 detail](#lt-675) | [Session title quality](2026-09-30-session-title-quality_livetest.md); [LT-441 check](2026-09-23-outstanding-plans-sweep_livetest.md) |
| LT-680 | P2 | **OPEN — reproduced live 2026-10-04 (three times).** A message sent while Codex is running a goal-continuation turn is delivered into that turn, but Codex's reply to it never reaches the transcript and the session reads `idle` for the rest of the turn (22 s in the longest case): Harness infers the turn finished 250 ms after the turn's first final answer, but Codex applies the steer at the next sampling boundary and keeps working on the same turn. | [LT-680 detail](#lt-680) | [Codex compaction reliability check 4](2026-09-27-codex-compaction-reliability_livetest.md) |
| LT-681 | P3 | **OPEN — reproduced live 2026-10-04.** Pressing Compact now on a Codex session replaces the context meter with `~0/258,400 (~0%)` and writes "Context compacted [native] (33% → 0%)" into the transcript, and the meter stays at ~0% until the next turn completes; Codex's real post-compaction occupancy was 13-27%. Provider self-compaction (the inline path) is correct. | [LT-681 detail](#lt-681) | [Codex compaction turn visibility check 3](2026-09-24-codex-compaction-turn-visibility_livetest.md) |
| LT-682 | P3 | **OPEN — reproduced live 2026-10-04 (cosmetic).** The header's interrupt button hard-codes the tooltip "Interrupt Claude (Esc)" for every provider, including Codex sessions. [Archived detail](livetest-remediation-register-archive-2026.md#lt-682-archived-detail) | [LT-682 detail](#lt-682) | [Codex compaction reliability check 3](2026-09-27-codex-compaction-reliability_livetest.md) |
| LT-683 | P3 | **OPEN — seen once on 2026-10-04, not reproduced in a clean 13-turn run.** One Codex goal-continuation turn, starting 7 ms after the previous goal turn ended, was not followed by Harness (no "Following a turn Codex started by itself" line): the session read `idle` for the 19.5 s the turn ran. Nine goal threads that day: 39 goal turns, 3 not followed; two of those were in runs where I was also sending messages into the turn, the third (`01a10929-21e4`) in an uninterrupted run that had compacted inline earlier. A clean 14-turn run (`01a10933-e358`) followed 13 of 13. | [LT-683 detail](#lt-683) | [Codex compaction reliability check 1](2026-09-27-codex-compaction-reliability_livetest.md) |
| LT-700 | P2 | **OPEN — reproduced live 2026-10-04 (dev app, 1 of 1 restarts with a `verifying` item).** After an app restart, Plan Queue recovery starts a fresh verifier about 6 s after the coordinator initialises, but the orchestrator-tools socket only starts listening about 7 s after that. The verifier is spawned with no orchestrator-tools MCP (`Orchestrator-tools MCP not configured — … socket missing`), so it has no `plan_queue_report_verdict`, works for ~5 minutes, ends its turn without a verdict, and the item parks `verifier-unreliable`. A verifier started later in the same session (after the socket exists) reported its verdict normally. | [LT-700 detail](#lt-700) | [Plan Queue check 3](2026-09-18-plan-queue_livetest.md) |
| LT-701 | P2 | **OPEN — reproduced live 2026-10-04 (1 of 1).** A normal quit (SIGTERM, shutdown path ran to "Cleanup complete") while two Plan Queue workers were mid-turn parks both items `worker-error: instance entered terminated` and ends the run `completed` during shutdown, so nothing is left for the restart-recovery path to resume. The check expects the working items to be resumed on the same `queue/…` branch after restart. | [LT-701 detail](#lt-701) | [Plan Queue check 3](2026-09-18-plan-queue_livetest.md) |
| LT-702 | P1 | **OPEN — reproduced live 2026-10-04 (1 of 6 ping-pong loops that day; LT-643's hang again, intermittent).** A ping-pong reviewer (Codex) settled with a complete, parseable `CHANGES_REQUESTED` verdict about 46 s after spawn, but the loop never noticed: `inFlightRound: 1`, no `Ping-pong reviewer produced a verdict` line, for 757 s. Cancelling the loop released the wait instantly and the same verdict then parsed normally (+334 ms), proving the instance was settled and the output valid the whole time. The five other loops that day completed rounds in 50–100 s. | [LT-702 detail](#lt-702) | [Ping-pong livetest](PINGPONG_IMPLEMENTATION_STATUS_livetest_completed.md) |
| LT-703 | P1 | **FIXED + REGRESSION-TESTED 2026-10-10 (working tree). Live re-check 2026-10-11 did not pass:** after a reload made the restored LCN tab readable, `fill_credential` reached the extension write and failed `dispatch:credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state` (audit `19d7214e-…`); `#username` and the password field stayed empty and the form was not submitted. The `dispatch:` prefix shows the coordinator reason plumbing is live; the code after it is the extension's unclassified fallback, not an origin-bound code. Original defect: the writer injected only into top-level-origin frames of `https://www.lcn.com/login` (form is `https://login.lcn.com` in `#login-iframe`) and swallowed the miss. | [LT-703 detail](#lt-703) | [Browser Gateway credential login — embedded form](browser-gateway-credential-login_livetest.md#lt-703-embedded-cross-origin-login-form) |
| LT-704 | P1 | **CODE VERIFIED 2026-10-13 — independent completion-gate PASS; queue re-verified 2026-10-14; packaged smokes pending.** Candidate discovery now inherits the trusted environment before caller overrides, retaining the working NVM CLI and confirming `aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`. Source and independently checked compiled default/High replies, six canonical gates and full suite pass. The install/restart prerequisite is satisfied (installed 2026-10-14 13:00 UTC, booted 13:08 UTC, compiled launcher byte-identical to the verified build); the two packaged smoke checks remain unrun and their exact deferred procedure is recorded inline in [LT-704 detail](#lt-704-deferred-packaged-acceptance) (branch-resident) and mirrored in the untracked root-checkout [startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md). This is not confirmed fixed live. | [LT-704 detail](#lt-704) | [Plan-owned packaged default/High checks](2026-10-13-opencode-launch-environment_livetest.md); [original failure evidence](2026-10-13-opencode-effort-variant-startup_livetest.md#evidence-run--2026-10-13-rebuilt-packaged-app) |
| LT-705 | P1 | **MACHINE REPAIR + CODE VERIFIED 2026-10-13 — gates and full suite pass, independent reviews PASS; queue re-verified 2026-10-14; packaged smoke pending.** OpenCode 1 failed in `~/work/communitytech` (`no such column: project_id`) after OpenCode 2 rebuilt the shared `workspace` table, so selection fell back to OpenCode 2, whose `acp` ignores the per-spawn overlay and lacked the second account's key. Added nullable `workspace.project_id` (backed up); selection now refuses OpenCode 2 and explains why. The install/restart prerequisite is satisfied as for LT-704; the communitytech packaged smoke remains unrun and its exact deferred procedure is recorded inline in [LT-705 detail](#lt-705-deferred-packaged-acceptance) (branch-resident) and mirrored in the untracked root-checkout [startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md). | [LT-705 detail](#lt-705) | [Plan-owned packaged checks](2026-10-13-opencode-launch-environment_livetest.md) |
| LT-706 | P2 | **FIXED + REGRESSION-TESTED 2026-10-14 (working tree); live re-check pending.** A MiMo step that spends the whole combined cap on reasoning (OpenCode `finish: "length"`, ACP `end_turn`) was classified `completed` (or `dangling_tool_result`), so the session stopped silently. LT-690's saturation check skipped empty text, judged from whole-turn text while usage covers only the final step, and the shared observation layer could not see the cap. MiMo cap raised 16384 → 32000 at James's request. | [LT-706 detail](#lt-706) | [MiMo reasoning-cap live checks](2026-10-14-mimo-reasoning-cap-cutoff_livetest.md) |
| LT-707 | P2 | **FIXED + REGRESSION-TESTED 2026-10-24 (working tree); live cell re-run pending (Windows PC outage #5).** `finalizeScoredRun` persists the record before best-effort cleanup and `cleanupWorkspace` retries transient ENOTEMPTY/EBUSY; regression tests cover record-survives-cleanup-throw and the retry paths. Implementation status lives in [the active plan](2026-10-14-local-model-plan-execute-ab_plan.md). Original report: reproduced 2026-10-24 (benchmark campaign harness, `benchmarks/plan-execute-ab/` — experiment tooling, not app code; owned by plan 2026-10-14-local-model-plan-execute-ab).** A completed scored pilot run is discarded when workspace cleanup flakes: `runArm` calls `cleanupWorkspace` (bare `rmSync` recursive) BEFORE `appendRunRecord`, so a transient `ENOTEMPTY` (macOS removal race) lost the AIO-05 C1 run after coding, patch capture and scoring — the batch logged `run failed: ENOTEMPTY, Directory not empty` and the leftover workspace then blocks re-export (`workspace already exists`). | [LT-707 detail](#lt-707) | [Local-model plan/execute deferred checks A5/A6](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
| LT-708 | P1 | **OPEN — reproduced live 2026-10-27.** A non-YOLO Claude session consuming a warm adapter has no defer hook. The genuine CLI error `This command requires approval` is not recognised as a permission denial, so the session becomes idle without an approval card. A fresh adapter shows the deferred-permission card for the same harmless command. | [LT-708 detail](#lt-708) | [Agent runtime residuals AR-006](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-27-plan-queue-worker) |
| LT-710 | P2 | **REPRODUCED 2026-10-27; not fixed in this checkout.** Main and context-worker startup can collide on fresh-profile migration discovery. Reusing the migrated isolated profile reaches the renderer. This reuses the existing saved-login/housekeeping defect identifier; the housekeeping worker owns its fix. | [LT-710 detail](#lt-710) | [Worker auto-update live checks](2026-10-14-worker-auto-update_livetest.md#evidence-run--2026-10-27-plan-queue-worker); [active remediation follow-up](2026-07-19-livetest-failure-remediation-followup_plan.md#lt-710) |
| LT-709 | P2 | **OPEN — reproduced in the compiled runtime 2026-10-26; unimplemented.** A provider-slot runtime package installs, but its worker fails on a compiled `require('file://...')` before provider registration; the normal session-create schema also rejects its plugin provider identifier. Phase 1 records the failure and omits the custom-provider claim. | [LT-709 detail](#lt-709) | [Plugins cleanup Phase 1](2026-10-26-plugins-cleanup-and-global-connectors_plan_completed.md#phase-1-plugins-page-cleanup); [implementation status](2026-07-19-livetest-failure-remediation-followup_plan.md#lt-709) |
| LT-722 | P2 | **OPEN — reproduced live 2026-10-27 (1 of 3 triage runs that day); unimplemented.** A Plan Queue triage agent looked for `plan_queue_report_triage` only in its provider's own tool list, never in Harness's `orchestrator_tool_search`, so it could not report; both the Claude attempt and the Codex retry ended without answering and the document parked `triage-failed`. The triage prompt has no tool-discovery steps (the verifier prompt gained them separately). | [LT-722 detail](#lt-722) | [Implementation status](2026-07-19-livetest-failure-remediation-followup_plan.md#lt-722) |
| LT-723 | P2 | **CONFIRMED FIXED LIVE 2026-11-06. Source fix verified 2026-11-04; installed provisioning passed 2026-11-05; shared receipts and saving passed 2026-11-06.** Preparing a shared Plan Queue check parks the leader when a scripts-only Node project triggers unnecessary `npm ci` with the packaged app's stripped PATH. Dependency setup must be required by the checked-out project, use the discovered CLI environment, and choose `ci` only for an npm lockfile/shrinkwrap. | [LT-723 detail](#lt-723) | [Batched checks installed-app evidence](2026-11-02-plan-queue-batched-checks_livetest.md#evidence-follow-up--2026-11-04-balanced-rerun-failure); [verified source repair](2026-11-04-plan-queue-check-copy-provisioning_plan_completed.md); [installed evidence](2026-11-04-plan-queue-check-copy-provisioning_livetest_completed.md#evidence--2026-11-05-real-shared-check-and-later-member-recheck) |
| LT-724 | P2 | **CONFIRMED FIXED LIVE 2026-11-06. Source fix verified 2026-11-05; the rebuilt installed run used one checklist for three jobs, with three separate reviews and mandatory landing sync.** A successful grouped checklist is rerun for its waiting member after the first member independently passes and lands. A real two-member group ran, but the later member lost shared receipt reuse and the run used three checklists for three jobs. Preserve checked-base provenance and strict proof while retaining separate reviews and mandatory serialized landing synchronization. | [LT-724 detail](#lt-724) | [Verified receipt-reuse repair](2026-11-05-plan-queue-group-receipt-reuse_plan_completed.md); [installed batching evidence](2026-11-02-plan-queue-batched-checks_livetest.md#evidence-follow-up--2026-11-05-real-group-with-lost-later-member-reuse) |
| LT-725 | P2 | **SOURCE FIX VERIFIED 2026-11-06; rebuilt installed acceptance pending.** Automatic code context was mostly irrelevant on real messages: about 7% of top results were relevant and 75% of short messages got code. It now needs a source file named after two words of the message, and skips text too long to search whole. Blind review on unseen messages: 52% relevant, 12% of short messages get code. | [LT-725 detail](#lt-725) | [Fixing plan](2026-11-06-code-context-precision_plan_completed.md); [installed check 3](2026-11-06-search-and-memory-repair_plan_livetest.md#3-automatic-code-context-is-relevant-and-quiet-when-it-should-be) |
| LT-726 | P2 | **SOURCE FIX VERIFIED 2026-11-06 in a Linux container; first AppImage release build pending.** Linux packages could not finish building, because `scripts/set-electron-fuses.js` opened `Harness` when the binary is `harness`, so the security fuses were never set. | [LT-726 detail](#lt-726) | [Fixing plan](2026-11-06-code-context-precision_plan_completed.md); [installed check 9](2026-11-06-search-and-memory-repair_plan_livetest.md#9-windows-and-linux-packages-hold-only-their-own-runtime) |
| LT-727 | P1 | **SOURCE FIX VERIFIED 2026-11-06; rebuilt-app check pending.** Every Microsoft 365 connector tool call was refused before reaching Microsoft, because the connector rejected the standard `_meta` field that MCP clients add to a call. | [LT-727 detail](#lt-727) | [Check 3](2026-10-26-plugins-cleanup-and-global-connectors_livetest.md#3-microsoft-365-account-routing-and-write-policy) |

| LT-1006 | P2 | **REPAIRS WIRED 2026-10-27; clean scoring still OPEN.** Fresh queue dependencies expose Vitest 4 to archived tasks whose quiet runner requires the Vitest 3 export map. Both broken and fixed task commands crash before tests. Temporary historical dependencies remove that crash but reveal LT-1002. Renumbered from this campaign's conflicting LT-709 label. | [LT-1000 detail](#lt-1006) | [Local-model checks A5–A8](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
| LT-1001 | P1 | **OPEN, reproduced 2026-10-27.** A fresh isolated dev profile fails startup with a duplicate migration-name constraint while main and the context worker initialize the same database. Restarting that owned profile succeeds; no application fix made. | [LT-1001 detail](#lt-1001) | [Local-model campaign startup evidence](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
| LT-1002 | P1 | **V2 ADOPTED 2026-10-27; clean control/rescoring OPEN.** AIO-01's held-back test suite passes on both the known-broken parent and its fixed commit under the compatible historical test library. The task no longer establishes a valid negative control, so new pilot scoring and recommendations are withheld. | [LT-1002 detail](#lt-1002) | [Local-model checks A5–A8](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
| LT-1003 | P2 | **SECOND-TURN CACHE BEHAVIOR DEMONSTRATED 2026-10-27.** Preserved structured system blocks yield request-two cache17106/input43 and much shorter client first-response latency; no pure server prompt-time claim. Final independent verification remains separate. | [LT-1003 detail](#lt-1003) | [Local-model check A4](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
| LT-1004 | P1 | **OPEN evidence loss, confirmed 2026-10-27.** Thirty A/D/G candidates reconstructed with provenance; eight later settled C1 and ten C2 full records remain absent from the portable session mirror. CLI transcripts and printed score summaries survive, but cannot support rescoring or a complete-matrix decision. | [LT-1004 detail](#lt-1004) | [Local-model checks A6–A8](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
| LT-1005 | P3 | **OPEN, reproduced 2026-11-07.** The benchmark's local translator cannot reach a native server bound to an IPv6 address: it passes the bracketed host to Node's HTTP client, so every request returns 502 (`getaddrinfo ENOTFOUND`). A plain byte forwarder was used instead; the translator is unchanged. | [LT-1005 detail](#lt-1005) | [Local-model check A2](2026-10-14-local-model-plan-execute-ab_plan_livetest.md) |
### New input-controls findings — 2026-10-27

| ID | Priority | Status | Detail | Origin |
| --- | --- | --- | --- | --- |
| LT-997 | P1 | **OPEN — local 0.2.45 repair implemented; Windows rerun pending.** Native Tab/Shift+Tab do not move focus and Enter does not activate a harmless link; trusted events have empty key/code. Effect-checked Enter fails honestly; unverified focus keys report applied success. | [LT-997 detail](#lt-997) | [Input controls checks 1/4](2026-10-14-browser-gateway-input-controls_livetest.md) |
| LT-998 | P1 | **OPEN — local 0.2.45 repair implemented; Windows rerun pending.** Tab-scoped 768×1024 emulation disappears when the command ends; subsequent page reads remain desktop-sized. A repeated set reports tab_emulation despite mismatched actual dimensions. | [LT-998 detail](#lt-998) | [Input controls check 2](2026-10-14-browser-gateway-input-controls_livetest.md) |
| LT-999 | P2 | **OPEN — local 0.2.45 repair implemented; Windows rerun pending.** Window read mode returns zero width/height for the live Chrome window, preventing a usable original-bounds capture. Optional shared-window resizing was not attempted. | [LT-999 detail](#lt-999) | [Input controls restoration protocol](2026-10-14-browser-gateway-input-controls_livetest.md) |
| LT-1000 | P2 | **OPEN — observed on the Windows worker (extension 0.2.50).** With 200% browser zoom and a 768×1024 tab emulation active, viewport reads fail with `browser_tab_viewport_dimensions_mismatch` although the emulation is correct and the page is laid out at the expected width. Cause not proven. | [LT-1000 detail](#lt-1000) | [Input controls check 2](2026-10-14-browser-gateway-input-controls_livetest.md) |
| LT-728 | P2 | **OPEN — reproduced live 2026-10-27 (recorded as LT-710 on the agent-runtime branch; renumbered 2026-11-07 because main uses LT-710 for the fresh-profile migration race).** The required Claude fresh-eyes checker stays active without a verdict until the headless deadline expires, then reports `Review cancelled`. The deadline is the headless request budget, not the ordinary cross-model timeout/floor. Clean-cache and invalidation live checks remain blocked by this reproduced failure, not an established provider outage. | [LT-728 detail](#lt-728) | [Agent runtime residuals AR-006](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-27-verifier-follow-up) |
| LT-711 | P3 | **OPEN — historical report, awaiting independent reproduction.** Cursor was reported on 2026-10-04 to emit empty `completed` updates for real failed reads and rejected shell permissions. The raw receipt is absent, so no current miner or provider behaviour is claimed. Distinct from LT-612 and from AR-007’s retired clause. The detail section sets no priority; P3 is assigned for an unreproduced historical report. | [LT-711 detail](#lt-711) | [Agent runtime residuals 2026-10-04 batch report](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-04-orchestrating-session-and-batch-agents) |
| LT-712 | P3 | **IMPLEMENTED on main (handoff-observability plan, merged 2026-11-07); live proof open.** Audit rows now carry the queued command ID, and head reinsertion is logged with that ID and the queue depth; the LT-616 handoff log is unchanged. AR-003 stays open until an identified rebuilt coordinator repeats the handoff run and the audit join is observed live. | [LT-712 detail](#lt-712) | [Agent runtime residuals AR-003](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-003--lt-371-live-browser-command-socket-handoff-correlation) |

### New findings — 2026-10-27 human/external residual campaign

| ID | Priority | Status / observed defect | Evidence | Acceptance owner |
| --- | --- | --- | --- | --- |
| LT-780 | P2 | **REPAIR IMPLEMENTED; REVIEW PENDING.** Rebuilt CLI reads pass through the real authenticated parent; transport regression reproduces the original wrapper failure. | [LT-780 detail](#lt-780) | [Review corrections](2026-10-27-human-external-review2_plan.md) |
| LT-781 | P2 | **REPAIR IMPLEMENTED; REVIEW PENDING.** Rebuilt CLI preserves all 115,377 bytes through a pipe, matching file output; slow-reader regression covers larger output and nonzero errors. | [LT-781 detail](#lt-781) | [Review corrections](2026-10-27-human-external-review2_plan.md) |
| LT-890 | P1 | **OBSERVED LIVE; NOT FIXED.** Fresh isolated startup throws `database is locked` at RLM WAL initialization during critical Work controls setup and leaves no renderer target. Restarting the same profile succeeds. | [LT-890 detail](#lt-890) | [Resumed residual campaign](2026-09-27-livetest-human-external-residuals_livetest.md#evidence-run--2026-10-27-resumed-worker) |
| LT-991 | P1 | **REPRODUCED LIVE; REPAIR IMPLEMENTED, LIVE RETEST PENDING.** Persistence sentinel ignores the extension evaluate JSON envelope, so a stale/save-failed form reports successful writes and verified persistence. | [LT-991 detail](#lt-991) | [Review corrections](2026-10-27-human-external-review2_plan.md#lt-991-implementation-status) |
| LT-992 | P2 | **REPRODUCED; NOT REPAIRED.** Packaging repeatability cannot collect under supported Node 26; the unchanged cases pass under supported Node 24. | [LT-992 detail](#lt-992) | [Review corrections](2026-10-27-human-external-review2_plan.md#lt-992-implementation-status) |

## LT-001: Existing-Tab Browser Grant Scope Mismatch

### Observed behavior

A real request for `read`, `navigate`, and `input` on a shared localhost tab was approved with
`Allow for session`. The resulting `browser.type` retry returned `requires_user` with
`no_matching_grant` and created another request.

### Required behavior

The approved session grant must authorize the same instance, provider, shared target, origin, and
requested action classes. The retry must type into the harmless field without another prompt.
The fix must not broaden the grant to another node, tab, origin, instance, provider, or action
class.

### Investigation boundary

- `src/main/browser-gateway/browser-grant-scope.ts`
- `src/main/browser-gateway/browser-grant-policy.ts`
- `src/main/browser-gateway/browser-gateway-approval-operations.ts`
- `src/main/browser-gateway/browser-gateway-action-guard.ts`
- Existing-tab attachment and request construction in
  `src/main/browser-gateway/browser-existing-tab-operations.ts`

The evidence suggests a scope-normalization mismatch: an approved existing-tab grant may be
stored with node scope while the retried action is matched with profile/target scope or without
the same node identifier. Treat this as a hypothesis until a focused regression test reproduces
the exact approved-grant and retry inputs.

### Required regression coverage

- A session grant created from a local existing-tab approval matches the immediately retried
  `input` action.
- The same grant does not match another instance, provider, node, target, origin, or unrequested
  action class.
- Remote existing-tab node scope remains distinct from local scope.
- Per-action consumption and autonomous submit/destructive requirements remain unchanged.

### Acceptance

Run the focused Browser Gateway specs, the canonical project verification checklist, and all
three checks in the linked Browser Permission UX live test. Record the created grant's bounded
scope fields and the successful harmless retry without recording browser content.

## LT-002: Embedded Document-Review Runtime Is Blocked by CSP

### Observed behavior

The same artifact runtime passes in the standalone capture-server browser path. In the Electron
Doc Reviews pane, the sandboxed `srcdoc` iframe renders static option labels but no generated
radio buttons, checkboxes, default marker, mirrored controls, or runtime messages. The renderer
CSP uses `script-src 'self'`, and the inline artifact runtime does not execute in the inherited
CSP context.

The earlier forwarder defect is already fixed: a real Codex instance successfully invoked
`request_doc_review` on 2026-07-18. Do not reopen that resolved item unless a new reproduction
fails.

### Required behavior

The artifact runtime must execute in the sandboxed review iframe while retaining script
isolation. Do not add renderer-wide `'unsafe-inline'`, `allow-same-origin`, direct app-DOM
injection, or an unrestricted message channel.

Acceptable designs include a narrowly scoped nonce/hash path or a self-hosted runtime asset whose
messages continue to pass the existing schemas and `event.source` check. The implementation plan
must choose one design after reproducing the current CSP failure.

### Investigation boundary

- `src/renderer/index.html`
- `src/renderer/app/features/doc-review/doc-review-viewer.component.ts`
- The artifact runtime/template that generates the inline review script
- Existing viewer, page, and template specs

### Required regression coverage

- The sandboxed embedded artifact emits its ready message and renders radio/checkbox controls.
- The standalone capture-server artifact continues to work.
- Arbitrary artifact scripts cannot access the parent DOM or acquire same-origin privileges.
- Unknown, malformed, or wrong-source messages remain ignored.
- The renderer CSP remains restrictive outside the review runtime.

### Acceptance

Complete both standalone and embedded scenarios in the linked choice-controls live test, then
run the delivery-reconciliation live test because all of its decision paths depend on a working
embedded review runtime.

## LT-003: Document-Review Draft State Does Not Meet Reload/Reselection Contract

### Observed behavior

Source inspection shows that pre-submit item state exists only in
`DocReviewPageComponent.itemStates`. Changing the selected review calls
`resetDecisionState()`, and persistence occurs only during final submission. The CSP failure
currently prevents a clean runtime reproduction, but this implementation does not satisfy the
live test's requirement that selections survive reload or reselection.

### Required behavior

Pending review decisions, comments, single choices, multiple choices, overall decision, and
general feedback must rehydrate after the exact reload/reselection boundary defined by the
canonical live test. Draft state must remain isolated by review id and must be cleared after a
successful final submission or explicit dismissal.

### Investigation boundary

- `src/renderer/app/features/doc-review/doc-review-page.component.ts`
- `src/renderer/app/features/doc-review/doc-review.store.ts`
- Doc-review IPC schemas and persistence only if renderer-local draft persistence cannot satisfy
  the reload requirement

### Required regression coverage

- Draft state survives route-away/route-back and full reload for the same pending review.
- Switching between two pending reviews never leaks choices or comments.
- Submitted or dismissed reviews do not restore stale draft state.
- Host state and iframe controls converge after the artifact ready/init handshake.

### Acceptance

LT-002 must pass first. Then exercise choice, reload, reselection, mirror synchronization, and
submission in the linked embedded choice-controls scenario.

## LT-004: Runtime Exit Classification Bypasses Recovery

### Observed behavior

A disposable Codex session started in app-server mode. Killing its verified child PID logged:

```text
Adapter exit event
Ignoring per-turn process exit for stateless exec adapter
```

The UI then showed interrupt/recovery states, removed the session, and returned to the
new-session draft. A normal Escape interrupt also failed to show the documented
`interrupting -> respawning -> idle` path and transcript marker.

### Required behavior

Lifecycle decisions must use the adapter's active runtime mode and capabilities, not only its
provider name. A resident Codex app-server exit must enter the recovery reconciler. A genuine
per-turn exec exit must remain ignored. Interrupt, resume fallback, unexpected exit, queued
messages, idle recovery, and crashloop backoff must preserve their documented semantics.

### Investigation boundary

- `src/main/instance/instance-communication-adapter-helpers.ts`
- `src/main/instance/instance-communication.ts`
- `src/main/cli/adapters/base-cli-adapter.ts`
- Codex adapter app-server/exec mode transitions
- `src/main/instance/lifecycle/interrupt-respawn-handler.ts`
- `src/main/instance/lifecycle/runtime-reconciler.ts`

The first focused reproduction must record the adapter class, `getSpawnMode()`, runtime
capabilities, resident-session capability, instance status, and exit route without logging
conversation content. Determine whether interrupt and unexpected-exit failures share this
classification defect before splitting the implementation work.

### Required regression coverage

- Codex app-server is never classified as stateless exec after it has entered app-server mode.
- Codex exec fallback remains stateless and ignores its normal per-turn exit.
- App-server exit during busy and idle routes once through unexpected-exit recovery.
- Escape interrupt routes once through interrupt recovery and cannot race with the generic exit
  path.
- Queued messages remain ordered across recovery.
- Double-Escape, termination-during-respawn, resume fallback, and crashloop backoff retain their
  existing safety behavior.

### Acceptance

All checks in both linked lifecycle live tests must pass in a disposable session. Evidence must
include the runtime mode, bounded lifecycle transitions, successful contextual follow-up, and
absence of duplicate/zombie provider processes.

## LT-005: Local-Personal Retrieval Benchmark Is a Stub

### Observed behavior

`npm run bench:retrieval` passes the committed synthetic regression gate.
`npm run bench:retrieval -- --local` exits successfully but only prints that live-store support
is not wired.

### Required behavior

The `--local` mode must discover James's real RLM and codemem stores, open them read-only, run the
documented local-personal queries, print local-only metrics, and never update fixtures, the
baseline, either store, or tracked files. Missing stores must produce an explicit skipped result;
an opened-but-unqueryable store must fail the local run.

### Investigation boundary

- `scripts/bench-retrieval.ts`
- Existing RLM and codemem read-only database discovery/opening helpers
- `src/main/memory/retrieval-eval/`
- `docs/testing.md` WS16 procedure

### Required regression coverage

- Store discovery uses the current Harness user-data layout without embedding James's absolute
  home path.
- SQLite connections use read-only mode.
- A test fixture proves the command does not write or create database files.
- Missing-store, schema-mismatch, and successful local-suite outcomes are distinct.
- `--update-baseline` behavior remains limited to the committed synthetic suite.

### Acceptance

Run the synthetic benchmark, then the local benchmark. Record store modification times before
and after and confirm they are unchanged. Complete the remaining WS16 checks before renaming its
live-test file.

## LT-006: Migrate Live Provider Coverage from Gemini to Antigravity

### Observed behavior

Several pending live tests still require a live Gemini CLI even though the contracts state that
Antigravity is the live successor and `gemini` is retained only as a deprecated compatibility
alias. The old wording caused Antigravity-capable checks to be treated as blocked.

### Required behavior

- New live-provider fixtures and provider-interaction tests use `antigravity`.
- Existing `gemini` fixtures remain only where replay compatibility with persisted historical
  data is intentionally tested.
- Failover and provider-context tests use Antigravity as the live Google-backed provider.
- Hardened-mode checks verify the real Antigravity configuration roots discovered at runtime;
  they must not assume `~/.gemini` is required solely because an old checklist says so.

### Investigation boundary

- `docs/plans/2026-07-13-fable-ws1_livetest.md`
- `docs/plans/2026-07-13-fable-ws7-phaseb_livetest.md`
- `docs/plans/2026-07-13-fable-ws13_livetest_completed.md`
- `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`
- `src/main/providers/__tests__/parity/fixture-replay.spec.ts`
- `packages/contracts/src/__fixtures__/provider-events/`
- `scripts/capture-provider-fixture.ts`

### Required regression coverage

- A sanitized Antigravity `basic-conversation` fixture replays to the canonical event stream.
- The historical Gemini fixture still replays as backward-compatibility coverage, or its removal
  is justified by a separate persisted-data migration.
- Failover selects Antigravity in the live successor slot.
- Provider-agnostic context evidence includes a real Antigravity session.

### Acceptance

Update the affected live-test instructions before running them. Complete their provider matrices
with Antigravity in the live successor role; do not report a missing Gemini executable as a
blocker.

## LT-007: Retire Obsolete Automation Blockers

### Observed behavior

Historical evidence in three pending live tests says an autonomous agent cannot operate Electron
GUI controls, approve actions, interrupt a session, or inspect resulting UI state. Computer Use
can now perform those actions. Those historical observations remain valid records of their
original attempts, but they are no longer current blockers.

### Required behavior

- Preserve historical evidence with its date.
- Add a current note to each affected checklist stating that Computer Use is the supported
  interaction path.
- Do not require a new product IPC or Electron E2E harness merely to make a live test agent-runnable.
- Continue to require explicit care for destructive actions such as TCC resets, production-app
  restarts, credential use, or terminating unrelated sessions.

### Acceptance

Re-run the linked checklists with Computer Use. Replace current prerequisite/status summaries
with the new evidence while retaining the dated historical attempts. Any product defect found
during those runs must be added to this remediation spec before implementation.

## Retest-Only Items: No Confirmed Fix Yet

The following observations do not currently justify code changes:

- [Provider/model swap](./2026-07-16-session-provider-model-swap-plan_livetest_completed.md): the tested
  Claude-to-Codex swap succeeded. Remaining checks require available provider quota, busy/loop
  scenarios, restart, and a current remote worker.
- [Local macOS signing](../superpowers/plans/2026-07-13-local-macos-computer-use-signing-plan_livetest.md):
  signing verification and steady-state TCC attribution passed. Clean first-prompt attribution
  remains unrun.
- [Computer Use onboarding](../superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan_livetest.md):
  steady-state permissions report Ready. Missing, denied, revoked, repair, and relaunch flows
  remain unrun.
- Every other pending untracked live test remains a discovery/retest item until it produces a
  current, reproducible mismatch between observed and expected behavior.

## Implementation and Retest Order

1. LT-006 and LT-007: correct the live-test contract and remove obsolete blockers.
2. LT-001: fix grant matching and complete Browser Permission UX.
3. LT-002, then LT-003: restore the embedded review runtime and draft-state contract.
4. Re-run document-review delivery reconciliation; add any newly reproduced delivery defects.
5. LT-004: fix the lifecycle classification/recovery cluster and complete both lifecycle tests.
6. LT-005: wire the read-only local benchmark and finish WS16.
7. Work through every remaining pending live test with Codex, Antigravity, Copilot, Computer Use,
   and a current remote worker where required. Add only reproduced defects to this spec.
8. **LT-008 first among the 2026-07-26 additions** — it corrupts every fork-resume runtime change on
   Claude, which also blocks session-provider-model-swap and rolling-handoff from being tested
   meaningfully. Then LT-009, LT-010, LT-011.

## LT-008: Fork-Resume Passes a Never-Minted Session Id as the Resume Source

**Priority P0. Found 2026-07-26, reproduced 2 of 2 on a real Claude session.**

### Observed behavior

`toggleYoloMode({ enabled })` on an **idle** Claude instance with conversation history returns
`TOGGLE_YOLO_MODE_FAILED: "Illegal transition: error → busy"`. The CLI is SIGTERM'd, the instance
drops to `error`, and roughly 45 s later the generic `process_exited_unexpected` recovery recipe
respawns it with a **fresh provider session and a replayed transcript**. No
`[System: YOLO mode enabled …]` notice ever appears. Provider session id changed on every toggle
(`0fd999dd… → a9d33453… → 3d359928… → 12e02cae…`).

### Root cause

`src/main/instance/lifecycle/runtime-reconciler.ts:194-206` resolves a yolo-only change on a
conversation-bearing Claude session to `native-resume-fork` (Claude reports `supportsForkSession`).
Lines 238-241 then mint the fork's *target* id and overwrite the instance with it **before** spawn:

```ts
const newSessionId = shouldResume && shouldForkSession
  ? generateId()                                   // an id the CLI has never minted
  : (shouldResume ? instance.sessionId : generateId());
instance.sessionId = newSessionId;
```

That id is passed as `spawnOptions.sessionId` (line 265). `claude-cli-adapter.ts:1064-1069` treats
`spawnOptions.sessionId` as the **source** to resume from and builds
`--resume <id> --fork-session`; `UnifiedSpawnOptions` carries no separate source-id field (only
`forkSession?: boolean`). `shouldUseNativeResume()` finds no transcript for the never-used id,
logs `Skipping --resume: no transcript for session under current cwd`, and spawns **without**
`--resume`. No resume proof arrives, so `waitForResumeHealth` is false, and line 301 throws
`Native resume did not stabilize after model change` → `adapter.terminate(true)`.

### Required behavior

1. For a fork, pass the **existing** `instance.sessionId` as the resume source and let the CLI mint
   the forked id — the adapter already adopts the authoritative id from the init message
   (`claude-cli-adapter.ts:1080-1084`). The reconciler must not pre-generate the target id, or must
   pass source and target as distinct fields.
2. **Same file, related hazard:** the runtime-change path uses the boolean `waitForResumeHealth`
   (line 301), where an `inconclusive` verdict collapses to `false` and destroys the session. The
   recovery path deliberately does not — `resolveRecoveryResumeHealth` (line 488) retries once and
   then *keeps* the live session, commenting that tearing it down "is exactly what previously lost
   the live thread and in-flight background agents on 'resume failed'". Apply the same policy to the
   runtime-change path.

### Acceptance

A yolo toggle on an idle Claude instance with history keeps the same provider session id, emits the
system notice, and answers a pre-toggle question from native context — YOLO reconciler checks 1 and
3, plus check 2's apply-on-settle half.

## LT-009: Skill Registry Is Empty, So Skill Observability Records Nothing

**Priority P0. Found 2026-07-26.**

### Observed behavior

Six real `sendInput` turns carrying exact builtin trigger phrases — including the bare phrase
`flaky test` (100% of the message) and the slash form `/test-stabilizer` — produced **zero**
`skill_activations` rows on a profile where migration `053_skill_attribution` is applied and both
tables exist. Every send logged `RLM context injected`; **no** send logged
`UnifiedMemory context injected`, i.e. the branch carrying skills never yielded a payload.
`/test-stabilizer` came back from the agent as `Unknown command: /test-stabilizer`.

The min-confidence gate is **not** the cause: `triggerMinConfidence` is `0.05`
(`skills-loader.ts:56`); the bare-phrase send scores 1.0.

### Root cause (partially established)

`skillsList()` returns **0 skills** — confirmed via two independent call paths, and it takes no
payload so it cannot be a validation artifact. Meanwhile **17 builtin skill directories exist on
disk** under `src/main/skills/builtin/`. With an empty registry `SkillRegistry.matchTrigger()` can
never match, so `detectRelevantSkills()` returns nothing and `fetchSkills()`
(`unified-controller.ts:765-801`) records nothing.

**Open:** why discovery/registration finds none of the 17 builtins. That is the first thing to chase.

### Required behavior

The builtin skills are registered at startup; a message containing a builtin trigger injects the
skill and writes a `skill_activations` row with `matched_by='trigger'`; `/test-stabilizer` resolves.

### Acceptance

Skill-observability checks 2, 4, 7 and 9 become scoreable (they are currently *indeterminate*, not
passing — their negative halves are vacuous while nothing can inject at all).

## LT-010: Sync Handler Validates Against the Wrong Allowlist

[Read the detail](livetest-remediation-register-archive-2026.md#lt-010-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-010-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-010-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-010-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-010-archived-detail).

## LT-011: Live-Test Checks That Assert on Signals the App Never Emits

**Priority P2. Found 2026-07-26.**

### Observed behavior

- History-restore check 4 instructs the runner to "check the app log for
  `Browser gateway MCP disabled for instance`". ~~That string is never logged.~~
  **Correction (2026-07-27): that claim was wrong.** The line has existed since commit `c3d3714a`
  (2026-07-17) at `spawn-config-builder.ts:322` —
  `logger.info('Browser gateway MCP disabled for instance (browserToolsMode=off)', { instanceId })`.
  It matched 0 times on 2026-07-26 because **no instance in that app had `browserToolsMode: 'off'`**,
  not because the signal is absent. Check 4 is runnable as written: create the instance with
  `browserToolsMode: 'off'` (the `createInstance` IPC accepts it), then grep.
- `restoreMode`, `native-resume` and `replay-fallback` genuinely were not logged — the rung was
  visible only in the IPC result and the rendered transcript.
- `VectorStore.getStats()` has no log line and no IPC exposure, so
  `2026-07-21-rlm-vector-store-memory_livetest.md` check 2 cannot be read at all.
- Stale preload wrappers: `electronAPI.skillsDiscover` sends `{ directory }` and
  `electronAPI.skillsMatch` sends `{ query, maxResults }`
  (`src/preload/domains/orchestration.preload.ts:534-536, 589-591`) while the contracts require
  `{ searchPaths }` and `{ text }` (`packages/contracts/src/schemas/provider.schemas.ts:326-328`),
  so both fail Zod validation. The Angular `OrchestrationIpcService` sends the correct shapes, so
  this is a latent inconsistency rather than a user-facing break — but it silently breaks any agent
  probing through `electronAPI`.

### Required behavior

Either emit the signals the checks name (a `restoreMode` log line at each rung; a
`Browser gateway MCP disabled for instance` line; a `getStats()` diagnostics field or log line), or
rewrite those checks to assert on something real. Align the stale preload wrappers with the
contracts.

## LT-012: `npm run build:main` Has Been Broken Since the TypeScript 6 Upgrade

**Priority P0. Found 2026-07-27.**

### Observed behavior

`npm run build:main` exits non-zero on two config deprecation errors:

```
tsconfig.electron.json(16,25): error TS5107: Option 'moduleResolution=node10' is deprecated …
tsconfig.electron.json(77,5): error TS5101: Option 'baseUrl' is deprecated …
```

TypeScript was bumped `~5.6.0 → ~6.0.3` in commit `a7f18c43` (2026-07-26 20:48), which promoted
both to hard errors. The failure is **silent and dangerous**: `tsc` still emits to `dist/src/`, but
the `&&` chain stops before `scripts/sync-dist.js` mirrors `dist/src/main` → `dist/main`. Electron
loads `dist/main/index.js` (package.json `main`), so every build since that commit left the app
running **stale main-process code** while appearing to have rebuilt. On this machine
`dist/main/index.js` was from 2026-07-26 12:24 while `dist/src/main/index.js` was current.

This also escaped the canonical gates: `tsc --noEmit` (tsconfig.json) and
`tsc --noEmit -p tsconfig.spec.json` are both clean — only `tsconfig.electron.json` is affected —
so "gates green" and "the app can be rebuilt" had come apart.

### Root cause

`tsconfig.electron.json` still uses `moduleResolution: "node"` and `baseUrl` (both required by this
CommonJS Electron build and its `paths` aliases), which TypeScript 6 rejects without an explicit
`ignoreDeprecations` acknowledgement.

### Required behavior

`npm run build:main` compiles and completes the dist mirror. A failure of any build step must not be
able to leave a stale-but-loadable `dist/main`.

### Acceptance

- `npm run build:main` exits 0 and refreshes `dist/main/index.js`.
- Migration to node16 module resolution is tracked separately; the acknowledgement is explicit and
  commented, not silent.

## LT-013: A Deliberate Terminate Archives a Session Id That Never Existed

**Priority P0. Found 2026-07-27 (session 2), reproduced 4/4 across two independent campaigns.**

### Observed behavior

Every archived Claude conversation records a provider session id for which **no transcript exists on
disk**, so History restore can never reach the `native-resume` rung.

Measured directly: for four archived entries (three from the 2026-07-27 session-1 yolo workspace,
one created fresh for this check), the entry's `sessionId` had no matching
`~/.claude/projects/<escaped-cwd>/<sessionId>.jsonl`. The conversation's real transcript was on disk
under a *different* id the whole time — the one `session-continuity/states/<instanceId>.json` still
recorded correctly.

Concrete run: instance `c1hucq0ox` in `/tmp/aio-lt28-hist` held its conversation in
`44910961-08df-4dd0-913a-b8d4fb01cfbc.jsonl`. Its history entry recorded
`cfcd8dcf-6963-4aa2-ae7c-dfbe1622d0b0`. Restoring it produced:

```
ClaudeCliAdapter | Skipping --resume: no transcript for session under current cwd
  { sessionId: "cfcd8dcf-…", cwd: "/tmp/aio-lt28-hist" }
HistoryRestoreCoordinator | History restore complete { restoreMode: "resume-unconfirmed", … }
```

### Root cause

`terminateInstance` SIGTERMs the adapter **while the instance is still `idle`** and only calls
`markTerminated()` afterwards (`instance-termination.ts`: `terminateAdapter` at the top, archive at
`archiveRootConversation`, `markTerminated` after both). The adapter's own exit (code 143) therefore
reaches the still-attached listener in `instance-communication.ts`, whose guard is
`instance.status !== 'terminated'` — so a deliberate terminate is classified as an **unexpected**
exit and fires `onUnexpectedExit`.

`respawnAfterUnexpectedExit` (`interrupt-respawn-handler.ts`) then assigns
`instance.sessionId = newSessionId` **before it spawns anything**, and for a conversation-bearing
Claude session the recovery plan is `provider-fork`, so `newSessionId = generateId()` — a UUID no
CLI has ever minted. `archiveRootConversation` runs ~30 ms later and persists exactly that value.

The respawn does not even complete — it aborts with `Skipping auto-respawn after CLI resolution`
400 ms later because the instance is gone. Its only lasting effect is destroying the archive's
resume anchor.

Log chain (single terminate, timestamps ms):

```
480690  InstanceCommunication | Adapter exit event { code: 143 }
480690  InstanceCommunication | Auto-respawning instance after unexpected exit { previousStatus: "idle" }
480691  InterruptRespawn       | Auto-respawning after unexpected exit
480720  HistoryManager         | Archived instance          ← reads the just-overwritten sessionId
481090  InterruptRespawn       | Skipping auto-respawn after CLI resolution
```

This is the same failure family as LT-008 item 3: a SIGTERM the app itself sent being handled as a
real instance exit because listeners were never detached.

### Required behavior

A user-requested terminate must not be observable as an unexpected exit, and the archived entry must
record the provider session the conversation actually lives in.

### Acceptance

- The adapter's terminate exit reaches no subscriber; no respawn is started by a terminate.
- The archived `sessionId` equals the live provider session id, and a transcript exists for it.
- Restoring that entry reports `restoreMode: native-resume` with no fallback notice, and the model
  recalls the pre-archive conversation from the provider side.
- Errored instances still archive as `error`, and teardown still completes.

## LT-014: Restore Ladder Contract Conflict for an Alive-but-Unresumed Session

[Read the detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail).

### Cost of the current semantics

[Read the detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail).

### Decision — 2026-07-27 (James) — option 1's rung, option 2's bookkeeping

[Read the detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-014-archived-detail).

## LT-015: Runtime-Change System Notices Are Model-Only, Never Rendered

**Priority P2. Found 2026-07-27 (session 2).**

### Observed behavior

YOLO checks 1, 2 and 4 all assert the transcript *shows*
`[System: YOLO mode enabled - tool permissions are now pre-configured for this mode.]` (and, for
check 4, the model-change notice too). It never appears.

Measured on the real renderer, not the main-process buffer: after a yolo toggle applied on settle,
`app-output-stream`'s own `messages()` held 5 messages and **none** contained the notice, and
`el.textContent` did not contain `tool permissions are now pre-configured`.

The notice *is* delivered — asked "did you receive a message containing the words 'YOLO mode
enabled'?", the session answered **YES** — and after the combined change of check 4 the model
volunteered "model switched to Sonnet and YOLO mode is off, so tool calls will need your approval".
So both notices arrive at the CLI and neither reaches the user.

Beware a false positive here: a naive `textContent` search for "YOLO mode enabled" matches, because
the *probe question* contains that phrase. Match the full notice text.

### Root cause

`runtime-reconciler.ts` emits these notices with `adapter.sendInput(...)`, which writes straight to
the CLI. Only `InstanceCommunication.sendInput` records a visible message into `outputBuffer`, so
nothing is ever queued for display.

### Required behavior

James's call:

1. **Render them** — surface the notices as system messages in the transcript, which is what all
   three checks describe and what makes a permission-posture change visible after the fact; or
2. **Keep them model-only** and rewrite checks 1, 2 and 4 to assert the observable state instead
   (the header's YOLO indicator, `yoloPending()`, `desiredRuntimeLabel()`), recording that the
   notices are deliberately model-directed control messages.

### Acceptance

The yolo live test and the runtime-reconciler agree on where these notices are observable, and
checks 1, 2 and 4 can be judged without inspecting CLI-side state.

### Knock-on

The 2026-07-27 session-1 PASS for check 1 did not evidence its notice sub-assertion. Check 1 is
therefore **partial**, not clean, until this is settled — its session-continuity substance
(native-resume fork, context survival) genuinely does pass.

## LT-016: Unpinned cross-provider swap reports a false "model no longer available"

[Read the detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail).

### Required regression coverage

[Read the detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail).

### Priority rationale

[Read the detail](livetest-remediation-register-archive-2026.md#lt-016-archived-detail).

## LT-017: Manual Codex compaction stalls 30 s, then silently restarts the thread

[Read the detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail).

### Required regression coverage

[Read the detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail).

### Priority rationale

[Read the detail](livetest-remediation-register-archive-2026.md#lt-017-archived-detail).

## LT-018: Copilot instances report 0 % context for the entire session

**Found:** 2026-07-29, running WS14 check 2.

### Observed behavior

A live Copilot instance (`@github/copilot@1.0.62`, model `gemini-3.1-pro-preview`) after **three**
real turns:

```
after turn 1:  {used: 0, total: 200000, percentage: 0}
after turn 2:  {used: 0, total: 200000, percentage: 0}
after turn 3:  {used: 0, total: 200000, percentage: 0}
```

`cumulativeTokens` is absent entirely. A Codex instance in the same session, for contrast, reported
`{used: 23930, total: 258400, percentage: 9.26, cumulativeTokens: 23930}`.

### Why this is a defect and not a declared gap

`src/main/cli/adapters/acp-cli-adapter.ts:349-362` declares, specifically for the `copilot-acp`
profile:

```ts
occupancyReporting: 'aggregate-only',
cumulativeReporting: 'available',
```

Both are contradicted by the observed state. Either the adapter is not wiring Copilot's
`session.usage_info` (or the ACP equivalent) into `emitContext`, or the capability declaration is
wrong. One of the two must change.

### Required behavior

Either:

- **Wire it** — the context bar moves with real occupancy for Copilot instances, and
  `cumulativeTokens` is populated; or
- **Declare honestly** — set `occupancyReporting: 'none'` and `cumulativeReporting: 'none'` for
  `copilot-acp`, and make the UI show *unknown* rather than a confident **0 %**.

The second is the important half either way: a bar reading 0 % on a session with real history is
worse than a bar reading "unknown", because the user acts on it. This is the same principle the
provider-agnostic context-evidence plan states — "the meter never shows fabricated occupancy".

### Required regression coverage

- A Copilot instance with N turns reports non-zero occupancy **or** an explicit unknown, never a
  confident zero.
- The declared `ProviderContextCapabilities` for `copilot-acp` match what the adapter actually
  emits.

### Priority rationale

P2. Nothing breaks and no context is lost — but auto-compaction and the user's own judgement both
key off this number, and a permanent 0 % means Copilot sessions never trigger context management
and always look empty.

### Reopened 2026-07-31 — the 2026-07-30 fix cannot work, and the visible defect is unchanged

Re-ran check 2 against the rebuilt app: a fresh Copilot instance (`p2lr4r0fo`, model
`gemini-3.1-pro-preview`, workspace `/tmp/aio-lt31-ws14`) took **three real turns** and reported
`{used: 0, total: 200000, percentage: 0}` at every single sample — identical to 2026-07-29.

The 2026-07-30 change was built on the premise that *"ACP hands us real per-turn token counts, but
they were only ever attached to the response"*. That premise is false for the installed runtime. A
diagnostic added this session (`acp-cli-adapter.ts`, one line per session) settles it:

```
[INFO] [AcpCliAdapter] ACP turn reported no token usage; context bar stays empty for this session
       { profile: 'copilot-acp', usageKeys: null }
```

`usageKeys: null` — `session/prompt` returns **no usage object at all**. `publishContextUsageFromTurn`
is correct code with nothing to publish, so the aggregate can never leave zero.

The second half — *"no usage means no event (never a fake 0 %)"* — is defeated before the adapter
is ever consulted. `instance-create-builder.ts:82-86` seeds **every** instance with a concrete

```ts
contextUsage: { used: 0, total: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS, percentage: 0 }
```

so the renderer is handed a confident zero from the moment the instance exists. The renderer already
knows how to say "no data" — `composer-toolbar.component.ts:352-353` returns
`'Context window: no data'` for an absent value — it is simply never given one.

**Two changes are required, and only the first is cheap:**

1. **Stop fabricating the initial zero.** The instance must start with context usage *unknown*, not
   `0 / 200000`. This is the change that actually fixes what the user sees, and it fixes it for
   every provider that cannot report occupancy, not just Copilot.
2. **Correct the `copilot-acp` capability declaration.** `acp-cli-adapter.ts:349-362` declares
   `cumulativeReporting: 'available'`. For the installed runtime that is false. It should be derived
   from, or reconciled against, what the runtime actually sends.

**Not implemented in this session, deliberately.** `Instance.contextUsage` is a **required** field
(`instance.types.ts:58, 325, 591`) and there are unguarded `instance.contextUsage.total` /
`.used` reads across the main process (`context-attribution-service.ts:222-223`,
`instance-event-forwarding.ts:294-326`, `orchestrator-tools-step.ts:272`, and more). Making it
optional is a typed change with a wide blast radius that deserves a deliberate review pass rather
than an unattended edit at the end of a campaign. The diagnostic log line **was** added, so the next
person can tell "the provider sent nothing" from "we dropped what it sent" in one grep.

### Implemented 2026-08-01 — change 1 done, without the wide blast radius

James delegated the design ("whatever you think is best architecturally"). Change 1 above is
implemented, but **not** by making `used`/`total` optional — that was the right instinct to resist.
Instead `ContextUsage` gains an explicit `occupancyReported?: boolean`:

- **Set only where a provider genuinely reports usage** — `instance-communication.ts:1631`,
  `instance.contextUsage = { ...usage, occupancyReported: true }`.
- **The create-time seed is left untouched** (`instance-create-builder.ts:82-86`), so it now
  carries no flag and the renderer reads it as unknown rather than as a measured zero.
- **The renderer already knew how to say it** — `composer-toolbar.component.ts` `ringPct` returns 0
  and `ringTitle` returns `'Context window: no data'` when the flag is absent.

This keeps every existing `.used` / `.total` read valid — the numbers stay required and stay
present — while expressing the one fact that was actually missing: whether they mean anything. It
fixes the confident-zero for every provider that cannot report occupancy, not just Copilot.

**A second defect was found while auditing every writer of the field.**
`buildPostCompactionUsage` (`compaction-runtime.ts:68-82`) rebuilds the object field by field and
dropped the flag, which would have blanked the ring to "no data" after every compaction on providers
that *do* report occupancy — i.e. the fix would have regressed the healthy path. It now preserves
it (a post-compaction `used: 0` is a real measurement), pinned by an assertion in
`compaction-runtime.spec.ts`. Every other writer either spreads the previous object
(`instance-lifecycle.ts:1475`, `instance-communication.ts:1677`) or passes it whole
(`instance-persistence.ts:259`); the `{used, total}` shape at `instance-event-forwarding.ts:315`
feeds the continuity store, not the ring.

Gates: full suite 17 949 tests green, tsc (app + spec), lint, max-loc and `build:main` all pass.

#### Completion-gate round 2 — the first implementation was WRONG, and the gate caught it

An independent fresh-eyes review returned **FAIL** on the above with a confirmed functional
regression, worth recording because it is a subtle failure mode:

**The bug I introduced.** `instance-communication.ts:1631` clones — `{ ...usage,
occupancyReported: true }` — so `instance.contextUsage` and `usage` stopped being the same object.
But the very next call, `:1635`, still queued the *raw* `usage`:

```ts
this.deps.queueUpdate(instanceId, instance.status, usage);   // stale, flagless
```

Before the change, `instance.contextUsage = usage` made those reference-identical, so passing
`usage` was harmless; the clone silently broke that. **What the renderer's ring renders is what
reaches `queueUpdate`** — and `'context'` events are the highest-frequency per-instance update
during an active turn. So the fix intended to *show* real occupancy would instead have shown
**"Context window: no data" for most of a turn on exactly the reporting providers it was for**,
until an unrelated status update happened to win the 50 ms batch race. Fixed to queue
`instance.contextUsage`.

**Two further gaps from the same review, both fixed:**

- **Hibernate/wake dropped the flag.** The persisted continuity shape
  (`session-continuity.types.ts:56-60`) carried only `{used, total, costEstimate?}`, and the wake
  path (`instance-lifecycle.ts:1931-1943`) rebuilt the object field by field — so waking an instance
  whose provider *had* reported real occupancy regressed its ring to "no data". The flag is now
  persisted and restored; absent on pre-flag records, which reads as unreported (safe, and
  self-correcting on the next usage event).
- **Two narrowed local types** (`instance-event-forwarding.ts:281`,
  `update-batcher.service.ts:16-20`) re-declared `contextUsage` as `{used,total,percentage}`.
  Harmless today because every hop copies whole objects, but they would let a future field-by-field
  rebuild drop the flag with **no compiler error**. Both widened to `ContextUsage`.

**On the test that pins it.** The first regression test I wrote passed *with the bug reinstated* —
tautological. The cause was my own verification error: the revert I used to check it hit the first
of **four** identically-shaped `queueUpdate(instanceId, instance.status, instance.contextUsage)`
calls in that file (line 911), not the one under test (line 1640). Re-reverting the correct line
made the test fail as it should, and restoring the fix made it pass. **A regression test is not
evidence until you have watched it fail.**

#### Completion-gate round 3 — round 2 returned PASS, and found the fix was still cosmetically incomplete

A second, differently-briefed fresh-eyes pass confirmed all of round 2's fixes correct (it
independently re-grepped **every** `queueUpdate` call in the repo, traced the full hibernate/wake
round trip including `restoreContext === false`, `checkpoint-manager`, and `session-share-service`,
and confirmed the new test is not tautological). **`VERDICT: PASS`.**

But it raised one thing both earlier passes missed, and it is the part the user actually sees:

**The visible ring label still read "0%".** `composer-toolbar.component.ts` rendered
`{{ ringPct() | number:'1.0-0' }}%` unconditionally. `ringPct()` correctly returns `0` for an
unknown occupancy and `ringTitle()` correctly said *"Context window: no data"* — but the tooltip is
not what anyone reads. **A Copilot session still displayed a confident `0%` digit on the composer
toolbar**, which is the original LT-018 complaint almost verbatim. Fixing only the tooltip fixed the
accessible name and left the defect on screen.

Fixed by adding an `occupancyKnown()` computed and gating the label on it, rendering an en dash when
there is no measurement. `ringPct()` now derives from the same computed rather than repeating the
condition, so the two cannot drift. Two tests added.

Worth carrying forward: **"the value is correct" and "the screen is correct" are different claims.**
Both earlier passes verified the computed logic and the accessible name and stopped there.

#### Completion-gate round 4 — the defect existed in two more places nobody had looked at

A third fresh-eyes pass returned **FAIL** on the label fix, with three findings, all correct:

1. **The new tests did not pin the thing they were written for.** They asserted `occupancyKnown()`,
   not the rendered label — and the reviewer *proved* they still pass with the template reverted to
   the unconditional percentage, by writing a throwaway DOM spec. The tests were green for a UI that
   was wrong. Replaced with a real `TestBed.createComponent` + `detectChanges()` block asserting
   `.ctx-ring__label` textContent, and **verified it fails when the template is reverted** before
   restoring it.
2. **`sidebar-footer.component.ts:35-38` had the identical defect, more visibly.** It renders
   `{{ ...percentage }}% ctx` gated only on `total > 0`, off `totalContextUsage`
   (`instance.queries.ts:107-123`), which summed **every** instance with no occupancy check. Since
   every instance is seeded with a 200 000-token placeholder, `total > 0` was true the moment any
   session existed — so the always-visible sidebar showed a confident **"0% ctx"** for a fleet that
   had merely not reported. Worse than the composer ring, because it shows regardless of which
   instance is focused. The aggregate now sums only reporting instances and exposes its own
   `occupancyReported`; cost still aggregates from all instances, since a provider can bill without
   reporting window occupancy.
3. **`provider-diagnostics-panel.component.ts:205-224` synthesised a context row from the
   placeholder.** `contextUsage` is a required, always-populated field, so the `snapshot.context ??`
   fallback fired for providers that never emit a real `context` event and reported "0%". Now gated
   on `occupancyReported`; a genuine provider event still wins.

**The lesson, which is the reason this took four rounds:** the first three passes each verified the
*computed value* and stopped. LT-018 is a defect about **what is on the screen**, and the same
defect had been copy-pasted into three separate surfaces. Fixing the one named in the ticket was
never going to close it.

#### Completion-gate rounds 5 and 6 — two more surfaces, and one reviewer finding declined

**Round 5** found a fourth renderer surface: `context-bar.component.ts`, rendered in the instance
header for **every** open instance, printed a precise-looking `0/200,000 (0%)` off the placeholder.
Now gated; the detailed view shows "no data" and the compact view an en dash, with cost still shown
(a provider can bill without reporting occupancy). Four DOM tests added, plus a **new spec file for
`sidebar-footer`**, which had none at all — which is how round 4's fleet-scope defect had gone
unseen.

**Round 6** found two more, one of which was outside the renderer entirely:

- **`mobile-gateway-serializers.ts` sent `contextPercentage` unconditionally.** The DTO documents it
  as *"0–100 context window usage, when known"*, and omission is how the phone is told there is
  nothing to show — so every unreported session shipped a confident `0` to the mobile client. The
  same defect, on a surface no renderer search would ever have found. Now gated, with tests
  including the case that a genuine reported `0 %` must still be **sent**, not omitted.

- **A woken pre-flag session showed "no data" everywhere while the warning banner offered to
  compact it.** Records persisted before this field existed carry real numbers and no flag.

**One round-5 finding was declined, deliberately.** The reviewer wanted `contextWarningLevel`
(`instance-detail.component.ts`) gated on `occupancyReported`. That would have been wrong: the
banner only fires at `percentage >= 75`, which the placeholder (percentage 0) can **never** reach, so
gating it suppresses a *legitimate* compaction warning rather than preventing a fabricated one. The
real defect was upstream, in the restore. Fixed there instead — `context-usage-restore.ts` now
infers `occupancyReported` from a persisted `used > 0`, which is sound because every placeholder and
reset path writes `used: 0` (the create seed, `buildPostCompactionUsage`, and
`restoreContext === false`). A woken legacy session now shows its real occupancy on every surface,
and the banner is consistent with the bar. Extracted as a pure helper with 8 tests precisely so that
invariant is stated once and pinned.

**The cumulative lesson.** Six rounds, five separate surfaces, one defect: the confident zero was
copy-pasted wherever a context figure was rendered. Every early round verified the *computed value*
and stopped. Two of my own regression tests were green against broken UI until I made a habit of
**watching each test fail with its fix reverted** — one because my revert had hit the wrong one of
four identical call sites, another because its fixture passed under both the old and new condition.

#### Completion-gate rounds 7–10 — the defect had a second transport, and the fix broke a feature

**Round 7** found the defect at its *source*. The Codex app-server adapter emits
`{used: 0, isEstimated: true}` to mean "no per-call occupancy yet and no prior occupancy", and the
`'context'` handler stamped `occupancyReported: true` on **every** event — republishing the
confident zero from the provider, past every renderer gate that had just been built.

**Round 8 caught a regression in that very fix.** `codex/compaction-presentation.ts` emits the
*identical* shape for a genuine provider-observed compaction reset. Discriminating on shape alone
meant a session at 62 % would drop to "no data" the moment Codex self-compacted. Rewritten to
discriminate on **history** — a reset cannot *un*-report — which is the rule
`buildPostCompactionUsage` already applied to AIO-driven compaction. Round 8 also found a **second,
parallel transport**: `ProviderContextEvent` carries the same numbers to the diagnostics panel and
had no flag at all, and its `applyEvent` path wins permanently over the gated fallback. The
decision is now computed **once** and handed to both transports so they cannot drift.

**Round 9** found the defect running the other way — **stale flags**. A provider swap spread the old
`contextUsage` across the change, keeping `used` *and* `occupancyReported: true` while `total` became
the new provider's window: a confident percentage computed from the previous provider's tokens
against a different window, broadcast in a visible `idle` state before the new runtime ran a single
turn. A swap to a smaller window could fake **≥95 %, which disables the composer**. Fixed via
`resolveSwapContextUsage`.

**Round 10 found three more, including the worst of the campaign — caused by this fix.**

1. The swap reset ran *before* spawn, on the assumption the resume would succeed. When the health
   probe then failed and the code fell back to a fresh session, occupancy was never recomputed —
   the same defect, via the fallback branch of the function that fixed it.
2. `applyRecoveryRespawn` had **no** `contextUsage` handling at all, so the interrupt-recovery path
   kept pre-crash occupancy across a fresh session. Its sibling restart flows already reset
   correctly via `resetBackendSessionState`; this one was simply never given the same treatment.
3. **`ContextUsageEventSchema` is `.strict()`.** Adding `occupancyReported` to `ContextUsage`
   therefore made `safeParse` **reject** the whole `instance:compact-status` `completed` event rather
   than strip the key — `validateRendererEventPayload` dropped it, and the renderer sat on
   "compacting" forever. **The LT-018 fix silently broke a working feature**, on a path no renderer
   search would ever have looked at.

**What this campaign is actually worth recording.** Ten rounds, nine defects, zero false positives —
and **three of the nine were regressions introduced by the fix itself**. Every early round verified
the computed value and stopped; the defect was a *rendered* one, duplicated across five surfaces and
two transports, and its repair had a blast radius into a strict IPC schema nobody would have
predicted. Two habits did the work: computing a decision **once** and passing it, rather than
re-deriving it per consumer; and **reverting every fix to watch its test fail** before accepting it —
which exposed two of my own tests as decorative (one revert had hit the wrong one of four identical
call sites; one fixture passed under both the old and new condition).

#### Completion gate — round 11 **PASS**, after eleven rounds and ten defects

Round 10 found two more, one of them a correction to me. The first was live data loss:
`instance-event-forwarding.ts` narrowed the persisted usage to `{used, total}`, and because
`session-continuity.updateState` does a **shallow `Object.assign`**, that replaced the stored
`contextUsage` wholesale — dropping `occupancyReported`, `percentage` and **`costEstimate`** from
the on-disk record on **every ordinary turn**. Accrued spend silently vanished on any
hibernate/wake or restart. Ironically, a comment thirty lines above it (added earlier in this same
campaign) warned against exactly this field-by-field rebuild. Fixed here and in the parallel
`session-archive.ts` narrowing.

The second finding was that **my own verification claim was false.** I had stated all three of
round 10's fixes were revert-verified; the `applyRecoveryRespawn` reset had **no test at all**, and
its fixture seeded `{used: 0}` — indistinguishable from the reset outcome, so nothing would have
caught its removal. Tests added that seed a *real* reading first, and confirmed failing on revert.

**Round 11 returned `VERDICT: PASS`** with no new findings, having independently reverted each fix
and confirmed the tests fail — rather than taking the claim on trust. The one hygiene note it left
(`session-archive.ts` had no spec at all) is now closed with a spec that is itself revert-verified.

##### What eleven rounds actually bought

Ten defects, zero false positives, and **three of them were regressions introduced by the fix
itself** — including one that made a `.strict()` Zod schema reject a live IPC event, leaving the
renderer stuck on "compacting" forever. A confident `0 %` looks like a one-line rendering bug. It
was not: the same defect was duplicated across **five renderer surfaces and two independent
transports**, it could be *inverted* into a stale confident number by four different
fresh-session paths, and it was being dropped in transit by two persistence writers.

Three habits did the work, and are worth keeping:

1. **Compute the decision once, pass it.** Re-deriving "is this real?" per consumer is precisely how
   five surfaces and two transports drifted apart.
2. **Revert every fix and watch its test fail before accepting it.** This exposed three of my own
   tests as decorative — one because the revert hit the wrong one of four identical call sites, one
   because its fixture passed under both conditions, and one that never existed despite my claiming
   it did.
3. **"The value is correct" and "the screen is correct" are different claims.** The first three
   rounds verified computed signals and accessible names and stopped; the user-visible digit stayed
   wrong throughout.

**Still open:** change 2 (the `copilot-acp` capability declaration claiming
`cumulativeReporting: 'available'` when the installed runtime sends nothing) is **not** done. And
this is a code fix awaiting its live re-check — WS14 check 2 stays FAIL until a rebuilt app is
observed showing "no data" on Copilot and unchanged real occupancy on Claude, including across a
compaction.

## LT-019: Reasoning Models Exhaust the Local AI Exact-Token Canary Budget

**Priority P1. Found 2026-07-31 while running the Local AI Guard CLI live test against the rebuilt
app and connected `windows-pc` worker.**

### Observed behavior

The worker, OpenAI-compatible endpoint, and both required model-catalog checks pass. Functional
validation fails only at the required inference layer for both configured Qwen canaries:

- `qwen/qwen3.5-9b`: `malformed-inference-output`, 13,690 ms;
- `qwen/qwen3.6-35b-a3b`: `malformed-inference-output`, 21,946 ms.

No target was created. A bounded direct request reproducing the health payload returned HTTP 200
with `finish_reason=length`, which is the response shape used by LM Studio when a reasoning model
spends the small output budget on hidden reasoning before emitting visible content.

### Root cause

`WorkerLocalAiHealth.runCanary()` sends a single user message and `max_tokens: 8` to LM Studio
without any reasoning control. The real worker generation path in
`worker-auxiliary-generate.ts` prepends `/no_think`, but live testing against the installed Qwen
3.5 model proved that this soft prompt directive is not sufficient on its own: `/no_think` plus a
32-token budget still returned `finish_reason=length` with zero visible characters. LM Studio's
explicit OpenAI-compatible `reasoning_effort: "none"` control made the same request return the
exact sentinel with `finish_reason=stop` in 479 ms. Both paths therefore need the explicit runtime
control, with `/no_think` retained as a compatible prompt-level fallback.

The live plan's 2,000 ms warning threshold is also below the measured 13–22 second cold/model-swap
latency. That is a target-configuration correction, not the parser defect: the retest uses a
30,000 ms threshold while retaining a 30,000 ms hard timeout.

### Required behavior

- OpenAI-compatible canaries and real worker auxiliary generation send LM Studio's explicit
  `reasoning_effort: "none"` control and retain the bounded `/no_think` prompt directive.
- Ollama local canaries use the bounded `/no_think` prompt directive.
- The exact-token contract remains strict: only trimmed `AIO_HEALTH_OK` is accepted; thinking tags,
  suffixes, arbitrary model text, empty content, and malformed response shapes still fail.
- The output budget remains finite but large enough for the sentinel after reasoning suppression.
- No model output is returned in probe evidence or logs.

### Required regression coverage

- The OpenAI-compatible canary body contains both `reasoning_effort: "none"` and a
  reasoning-suppressed system instruction, with a bounded output budget large enough for the
  exact sentinel.
- The real OpenAI-compatible auxiliary-generation body carries the same explicit reasoning
  control so a passing canary represents the routed workload.
- The Ollama canary prompt carries the same suppression directive.
- Exact sentinel responses pass; empty/length-truncated and extra-text responses still fail without
  exposing their content.

### Acceptance

Run the focused worker health tests and canonical project gates, deploy/restart the updated worker,
then repeat the linked CLI validation. Both Qwen models must remain required, the 9B canary must
pass with every required layer healthy, enrolment must create exactly one target, readback must
match, and a duplicate enrolment must fail safely.

Code verification passed 2026-07-31: 53 focused response/health tests, 410 worker-agent tests,
both TypeScript checks, lint, max-LOC, main/worker builds, and the 1,692-file / 17,492-test full
suite. Direct bounded LM Studio probes with the implemented request contract returned exact
sentinels for 9B (479 ms) and 35B after swap (10,083 ms). The rebuilt worker artifact is staged
with verified SHA-256; durable deployment and authenticated enrol/list/duplicate checks remain.

## LT-020: A queued provider/model swap kills the loop iteration it lands on

[Read the detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail).

### Required regression coverage

[Read the detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-020-archived-detail).

## LT-021: Loop tool activity never reaches the renderer — 8 of 11 activity kinds are dropped

[Read the detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail).

### Required regression coverage

[Read the detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-021-archived-detail).

## LT-022: The renderer heartbeat reports a UI freeze that is not happening

**Priority P3. Found 2026-07-31 while running unexpected-exit check 2.**

### Observed behavior

With the dev app running headlessly (`nohup npx electron .`), the log fills with, on a perfect
60-second cadence:

```
[ERROR] [RendererHeartbeat] Renderer heartbeat stalled — UI event loop likely blocked
        { senderId: 1, gapMs: 14295, lastSeq: 58 }
[WARN]  [RendererHeartbeat] Renderer heartbeat recovered { stalledMs: 60005, missedBeats: 0 }
```

The UI event loop is **not** blocked. Established, not assumed:

- Stopping **all** CDP activity for 200 s did not change the cadence, so the harness was not the
  cause.
- A CPU profile across a full stall window (`Profiler.start`/`stop`, 25 s, 1 ms sampling) returned
  **`25000ms (idle)`** — the renderer executed no JavaScript at all.
- `document.visibilityState === 'hidden'`, `document.hasFocus() === false`, and a direct
  measurement showed `setTimeout(…, 1000)` firing at **1261 / 1999 / 2001 / 1999 ms**.

### Root cause

Chromium throttles timers in a hidden/occluded renderer. The heartbeat is a `setInterval`
(`renderer-heartbeat.service.ts:36`), so it is throttled along with everything else. The monitor
interprets "beat did not arrive on time" as "the UI event loop is blocked", which is one possible
cause but not the only one — and not the one that applies here.

### Required behavior

The monitor should distinguish "the renderer is throttled because its window is hidden" from "the
renderer's event loop is genuinely blocked" — e.g. by sending `document.visibilityState` with the
beat and downgrading the log to `debug`/`info` when hidden. As it stands, an ERROR-level line
asserts a specific, alarming diagnosis that the evidence contradicts.

### Priority rationale

P3 — cosmetic in production (a visible window does not throttle), but it actively misleads during
headless testing, which is exactly when someone is reading the log. It cost this session a CPU
profile and a 200-second controlled experiment to rule out.

### Fix — 2026-09-23

The renderer sends `visibility` (`'visible' | 'hidden'`) with every beat and beats immediately on
`visibilitychange` (`renderer-heartbeat.service.ts`); the payload schema accepts it as optional so an
older renderer still beats. `RendererHeartbeatMonitor` records the last reported visibility and judges a
hidden renderer against `HIDDEN_HEARTBEAT_STALL_THRESHOLD_MS` (150 s) rather than 10 s; the stall log
carries `hidden`. Regression tests: `renderer-heartbeat-monitor.spec.ts` "hidden window (LT-022)" (two of
them fail with the threshold change reverted) and `renderer-heartbeat.service.spec.ts`. Live check in
`2026-09-23-outstanding-plans-sweep_livetest.md`.


## LT-023: Two rapid CLI crashes leave the session dead, silently

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

### Required regression coverage

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

### Related observation (not filed separately)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

### Fix — 2026-08-12 — deferred and retried instead of left terminal, verified live

[Read the detail](livetest-remediation-register-archive-2026.md#lt-023-archived-detail).

## LT-024: Zod's `$schema` key made every Claude-reviewer review fail

[Read the detail](livetest-remediation-register-archive-2026.md#lt-024-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-024-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-024-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-024-archived-detail).

### Verified

[Read the detail](livetest-remediation-register-archive-2026.md#lt-024-archived-detail).

## LT-025: The in-app Claude reviewer returns an empty response

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### The control that makes this app-side

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### Where to look first

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### Root cause and fix (2026-07-31)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### Follow-up found while gating the fix (2026-07-31)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

### LT-016 create-path fix — a deliberate trade, recorded

[Read the detail](livetest-remediation-register-archive-2026.md#lt-025-archived-detail).

## LT-026: Hardened mode killed every session it was enabled on

[Read the detail](livetest-remediation-register-archive-2026.md#lt-026-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-026-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-026-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-026-archived-detail).

## LT-027: Seatbelt writable roots granted nothing (symlinked prefixes)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-027-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-027-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-027-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-027-archived-detail).

### Verified

[Read the detail](livetest-remediation-register-archive-2026.md#lt-027-archived-detail).

## LT-028: Codex is unusable under hardened mode

**Priority P2. Found 2026-07-31 running WS13 check 4. NOT fixed.**

### Observed behavior

A `hardened: true` Codex instance reaches idle but never answers. Two distinct problems:

1. **Contradictory mode selection**, 389 ms apart on the same instance:
   ```
   09:01:37.856 [CodexCliAdapter] Codex adapter using exec mode (app-server not available)
   09:01:38.245 [CodexCliAdapter] App-server thread started fresh { threadId: '019fbc8e-…' }
   09:01:38.245 [CodexCliAdapter] Codex adapter using app-server mode
   ```
   WS13 check 4 requires exec mode and explicitly *not* the app-server line. Both are emitted.
2. **The MCP transport dies inside the jail.** The transcript fills with
   `rmcp::transport::worker: worker quit with fatal: Transport channel closed` and
   `codex_models_manager: failed to refresh available models: stream disconnected`. No answer is
   ever produced.

### Required behavior

Hardened Codex must either work — with whatever additional allowance its MCP transport needs added
to the base policy, evidenced per WS13 check 8 — or be refused up front with a clear reason, the way
remote placement fails closed. Silently spawning an unusable session is the one option to avoid.

### Note

This is also the Codex half of WS13 check 8's writable-root review: the Phase A root set is
**insufficient** for Codex. Claude's is sufficient (write/read/shell all verified) after LT-027.


### Follow-ups found while gating LT-026/LT-027 (2026-07-31)

The security review of these two fixes reproduced both independently and confirmed them necessary,
then found four things worth recording. Three are fixed; one is a decision.

**Fixed in the same pass:**

- **The non-existent-root passthrough did not work.** `realpathForSandbox` returned an unresolved
  path on ENOENT, so the LT-027 bug survived verbatim in the *"Allow path & retry"* lever — the
  denial message names a file that was never created, so the granted path never exists, so it was
  passed through unresolved and the retry landed in a jail that denied the write again, with no
  diagnostic. Now walks up to the nearest existing ancestor, resolves that, and re-appends the tail.
- **`com.apple.SecurityServer.xpc` is not a real service** on macOS 26.5 — it publishes in neither
  the system nor gui bootstrap domain, and A/B shows it alone does not work. Removed. Only
  `com.apple.SecurityServer` is load-bearing for the CLI path that broke; `com.apple.securityd.xpc`
  is retained deliberately (the modern SecItem endpoint, granted to every App Store app by Apple's
  own `application.sb`) and the policy now says so instead of implying all three were proven.
- **The policy header misquoted its own contract.** It read "keychains are protected by TCC anyway",
  which is false — TCC is inherited from the responsible app, and a jailed process can read
  `login.keychain-db` raw. The header now states plainly that securityd mach-lookup is granted and
  that **per-item keychain ACLs**, not TCC, are the boundary. Keychain *mutation* remains gated by
  the writable-root grants (verified: a jailed `security add-generic-password` outside the roots
  fails `Operation not permitted`).

### Fix — 2026-09-23

Refused up front, per the required behaviour's second option. `createCliAdapter`
(`adapter-factory.ts`) throws before constructing a Codex adapter for a hardened instance, with an
operator-readable reason, so a hardened Codex session fails at spawn instead of idling forever.
Regression test: `adapter-factory-hardened-remote.spec.ts` (fails with the guard removed). Making Codex
work inside the jail stays open as an enhancement that needs WS13 check 8 evidence.


## LT-029: hardened Keychain refresh limitation

**P2. Safe limitation chosen in code 2026-09-23; live refresh proof pending.** Hardened mode may
prevent credential refresh even when startup succeeds.

LT-026 fixed the credential *read*. Writes are a different path: the Claude binary shells out to
`/usr/bin/security add-generic-password -U`, and a legacy keychain write is a client-side **file**
write to `~/Library/Keychains`, which is in none of the current default writable roots. Measured
directly: a jailed `touch ~/Library/Keychains/<probe>` → `Operation not permitted`.

Startup can therefore work through the read-only path while a later OAuth refresh or `/login`
attempt may need a Keychain write. The direct jailed write was observed; an actual long-session
provider token refresh has not been observed, so its outcome remains a live check. The options were:

1. Add `~/Library/Keychains` as a hardened writable root — accepting that a jailed CLI can then
   modify or delete login-keychain items.
2. Accept it as a documented hardened-mode limitation, and add a long-session livetest check that
   exercises a token refresh under the jail.

The safe policy is option 2: keep `~/Library/Keychains` out of the default writable roots. Adding it
would let a jailed process alter the whole login Keychain. Credential failures on a terminal
hardened exit now get a credential-specific notification and a composer banner with Sign in and
Retry session; the banner does not offer Allow path & retry. A real file denial still offers that
path grant. For a routed Claude account, Sign in opens that exact account profile's login; a delayed
login result cannot update a different selected instance. These code paths have focused regression
tests. The rebuilt-app, long-session refresh check is
[Check 7](2026-09-23-outstanding-plans-sweep_livetest.md#check-7--lt-029-hardened-credential-refresh-and-repair).

**Update 2026-10-17 — the jailed refresh was observed, and it is worse than a failed session.** Both
pooled Claude accounts were revoked (`OAuth token revoked`) after hardened sessions ran on them; each
account's `.credentials.json` fallback was rewritten at the minute of its revoke. Claude Code 2.1.302
stores a refresh it cannot write to the Keychain in that file, the Keychain keeps the spent
single-use refresh token, and the next refresh from the Keychain gets the whole login revoked for
every session on the account. The Keychain stays out of the jail; instead hardened Claude spawns are
handed the access token through `CLAUDE_CODE_OAUTH_TOKEN` and never hold a refresh token. See
[2026-10-17-claude-signout-failover-and-hardened-login_plan_completed.md](2026-10-17-claude-signout-failover-and-hardened-login_plan_completed.md).


## LT-030: A swap on a looping session cannot deliver its own notices

[Read the detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail).

### Fix (2026-08-01) — three parts, because there were three causes

[Read the detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail).

### Verified live

[Read the detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail).

### Knock-on — resolved

[Read the detail](livetest-remediation-register-archive-2026.md#lt-030-archived-detail).

## 2026-07-26 observations — triage needed, not yet classified as defects

Reproduced and evidenced, but each needs a judgement call before it becomes an LT item:

1. **76% of production sends (51 of 67) miss the 500 ms `INPUT_CONTEXT_DEADLINE_MS`** and defer
   their context bundle to the next turn. Unified-memory context yielded a payload on only 2 of 67
   sends. Deferral is by design (`instance-manager.ts:1789-1802`); the *rate* may not be.
2. **Automation-initiated turns are entirely outside skill observability** — an automation delivers
   its prompt as the instance's initial prompt at spawn, which never runs `buildInputContexts` →
   `fetchSkills`, so scheduled work can never produce a `skill_activations` row.
3. **28 `codex app-server` wrapper processes** parented to the Harness main process, several 4–12 h
   old, against `activeInstances: 0` on the remote node. Possible orphan-process leak.
4. **`rlm-storage:get-health` blocks the main event loop** — `syncMs` 189 / 214 / 266 and once
   **2164 ms** against a 100 ms threshold (`IpcHandlerTiming`, `SlowOperations`).
5. **The dev app still writes its `app.log` into the production profile** (wave-2 finding 12,
   re-confirmed 2026-07-26). This actively contaminates log-based evidence gathered from
   `harness/logs/` while a dev app is running.

## Completion Criteria

This remediation program is complete when:

- LT-001 through LT-012 satisfy their acceptance criteria.
- Every linked source live test is renamed `_livetest_completed.md`.
- Every newly discovered defect has been fixed and linked here before its retest is completed.
- All remaining untracked `_livetest.md` files have either passed and been renamed or contain a
  current external prerequisite that is not a software defect.
- The canonical project verification checklist passes after all implementation changes.

## LT-031: A long automation description silently never reaches the UI

**Found:** 2026-08-01, by grepping the packaged app's own `app.log` for
`Blocked invalid renderer event payload` — not by running a check. Worth noting how it was found:
this class of bug is invisible from the UI and invisible from tests; the only trace is that one warn
line.

### Observed behaviour

```
Blocked invalid renderer event payload
{ channel: "automation:changed",
  issues: [{ path: "automation.description",
             message: "Too big: expected string to have <=1000 characters" }] }
```

One occurrence, 2026-08-01. The automation ("Weekday research and morning outreach desk") had an
operational note appended by an agent earlier the same day. The write **succeeded** — the long
description is present and live, confirmed via `list_automations`. Only the renderer notification
was dropped, so the Automations page kept rendering the previous version, with no error surfaced
anywhere a user could see.

### Root cause

An inconsistency between two validation points that nobody had reason to compare:

- **The write path allowed 2000.** `CreateAutomationArgsSchema` / `UpdateAutomationArgsSchema`
  (`src/main/mcp/orchestrator-automation-tools.ts`) cap `description` at 2000 — and, unlike the IPC
  path (`automation-handlers.ts`, which validates against `AutomationCreatePayloadSchema` before
  writing), the MCP path writes **without** validating against the payload schema at all.
- **The event path capped at 1000.** `AutomationSchema.description`
  (`packages/contracts/src/schemas/automation.schemas.ts`) was `z.string().max(1000)`, and
  `automation:changed` is validated against it before `webContents.send`.

So the system happily accepted a value it could then never tell the renderer about. And 1000 was
below *real* usage regardless — James's automations routinely carry multi-paragraph operational
notes ("PAUSED 2026-08-01 because …, original description: …"), several already close to the cap.

### Required behaviour and fix

Raised to a single shared `AUTOMATION_DESCRIPTION_MAX = 8_000` used by all three sites (create
payload, update payload, entity), so the write path and the event path cannot disagree.
**Deliberately raised rather than truncated on write** — clipping would silently destroy the note,
which is the same class of harm as dropping the event. Still bounded, so a runaway payload is
rejected.

### Acceptance

Three tests in `automation.schemas.spec.ts`: a realistic ~1600-char note parses on create and on
update, and an 8001-char one is rejected. Verified the first two fail when the cap is put back to
1000.

### Correction, and the sibling defect it hid

My first write-up of this item stated **"the write path caps nothing"**. That was **wrong**:
`description` has been capped at 2000 in the MCP args schema since 2026-06-09 (commit `06f4a500`).
I asserted the negative from a `grep` that returned no matches, without opening
`orchestrator-automation-tools.ts` to read the schema I was blaming. The real shape is an asymmetry
between two *bounded* caps, not an unbounded write.

That matters beyond pedantry, because the same unverified assumption hid a **second, live instance of
the identical bug** — caught by the completion gate, not by me:

**`workingDirectory`: 10 000 at the MCP write path vs 1 000 at the entity bound.**
`WorkingDirectorySchema` (`common.schemas.ts`) is `max(1000)` and reaches
`AutomationChangedEventSchema` via `AutomationSchema.action`. Both MCP tools allowed
`max(10_000)`. Because the MCP path does not validate against the payload schema, any
`workingDirectory` of 1001–10 000 chars would write successfully and then have its
`automation:changed` event silently dropped — the exact LT-031 mechanism on a different field.
Not observed in `app.log` (no such automation exists), but unambiguous in code.

Fixed by pointing both MCP sites at the shared `WorkingDirectorySchema`, so the write and event
bounds are now literally the same object. A path over 1000 chars exceeds `PATH_MAX` on every
supported platform, so tightening rather than raising is the correct direction here — the opposite
call to `description`, and for a concrete reason rather than symmetry.

**Checked and clear:** `name` (200 everywhere) and `prompt` (MCP 100 000 is *tighter* than the
entity's 500 000, so it can only reject early, never drop an event). `workspaceId` is not an MCP arg.

### The class is now closed, not just the two instances

Checking fields by hand does not scale — a third looser bound added tomorrow reopens this. So the
MCP write path now validates before writing, which is what the IPC path always did:
`assertWritablePayload()` in `automation-tool-impl.ts` runs the payload schema immediately before
`createWithScheduling(input)` and before `store.update(...)`, and throws naming the offending field.

**It validates the MAPPED object, not the raw args** — deliberately. The MCP arg shape is flat
(`cron` / `runAt` / `workingDirectory` / `prompt`) while the payload shape is nested
(`schedule` / `action`), and the mapping does real work first (cron validation, `Date.parse`,
defaulting the working directory from the calling chat). Only after that is there a payload-shaped
object to check. Validating raw args would fail on shape for every legitimate call.

**Why this is safe against false rejection**, checked before writing it rather than assumed: neither
`AutomationCreatePayloadSchema` nor `AutomationUpdatePayloadSchema.shape.updates` is `.strict()` —
the only two `.strict()` schemas in the file are the *event* schemas — so extra keys are stripped,
not rejected. `AutomationActionSchema` requires just `prompt` and `workingDirectory`, both always
supplied by the mapping, and `destination` carries a `.default()`. The guard can therefore only fire
on a genuine bound or enum violation, which is exactly its purpose. All 148 `src/main/automations`
tests pass unchanged.

**All three MCP write sites are covered**, not two. A gate pass pointed out that my first pass said
"closing the class" while leaving `postponeAutomation` — which also writes via `store.update` —
outside the guard. It was not exploitable today (its `runAt` is a derived number and its timezone is
copied from an already-valid schedule), but "not exploitable today" is precisely the reasoning that
let this class exist in the first place, so it is now covered too.

The two hand-fixed bounds (`description`, `workingDirectory`) are kept rather than reverted: they
are the correct bounds on their own merits, and this guard is defence in depth behind them, not a
replacement.

**Note on live status:** this is working-tree code. Until the app is rebuilt, the packaged app still
runs the unvalidated path, so this cannot be exercised live yet.

### The generalisable lesson

`validateRendererEventPayload` **does** log every drop, and that log is the only evidence this
failure mode leaves. It is worth grepping `Blocked invalid renderer event payload` periodically —
doing so on 2026-08-01 also surfaced 110 dropped `loop:activity` events from 2026-07-31, which
independently confirms LT-021 was a genuine live defect rather than a theoretical one.

## LT-032: A hidden window permanently freezes transcript scroll tracking

**Found:** 2026-08-01, while verifying the scroll-edge-loading fix for the audit plan's item 2. Found
by *driving* the check rather than reasoning about it — the fix under test worked, and the check
still failed, which is what exposed the second cause.

### Observed behaviour

With an instance open and a populated transcript, the viewport was genuinely scrollable and scrolled
(`scrollTop` 886 → 0, held), the listener was bound (`boundViewport: true`,
`viewportCleanup: true`), and yet **no scroll state moved**: `showScrollToBottom` stayed `false`
with 886 px of distance from the bottom.

The gate was `isRestoringRef.value === true`, stuck.

### Root cause

Measured directly in the running renderer:

```
{ rafFires: false, hidden: true, visibilityState: "hidden", hasFocus: false }
```

`requestAnimationFrame` does not fire **at all** in a hidden window — not late, not throttled.
Both restore paths (`output-stream.component.ts`, the instance-switch restore and the
deferred-restore watcher) set `isRestoringRef.value = true` **synchronously** and clear it **only
inside the rAF callback**. No frame, no clear. `OutputScrollService`'s listener short-circuits on
that guard (`output-scroll.service.ts:52`), so every scroll event is then discarded for the life of
that session.

### Why it matters beyond the test harness

This is not a CDP artefact. Any user who opens an instance and switches to another app — or whose
window is fully occluded — before the frame lands gets a session whose scroll tracking is dead:
no scroll-to-bottom button, no position saving, and no scroll-edge loading of older messages. There
is no error and nothing in the log.

It also means the 2026-07-25 audit's conclusion was only half right. It attributed the frozen
listener state entirely to the one-shot `afterNextRender` binding. That binding bug was real and is
fixed, but fixing it alone does not make the check pass, because the guard still sticks.

### Fix

`runRestoreFrame()` (`restore-frame.ts`) runs the step on the next frame **or** after a bounded
timeout, whichever comes first, exactly once. Frame-aligned when visible — which is what the restore
wants, to avoid a visible jump — and guaranteed to run when not. All five restore/scroll frame call
sites in `output-stream.component.ts` use it.

### Acceptance

4 tests in `restore-frame.spec.ts`: runs on the frame; **still runs when the frame never arrives**;
runs exactly once when a late frame lands after the fallback; no double-run when the frame is
prompt. Verified that removing the fallback fails 2 of the 4.

## LT-033: The stuck-frame-guard shape in three more components

**Found:** 2026-08-01, by the LT-032 completion gate. I asked the reviewer to sweep the whole
renderer for the *shape* rather than re-check my fix, and it came back with three more. That request
was worth more than the review itself.

### The shape

A boolean guard (or an awaited promise) is raised **synchronously**, gates re-entry, and is lowered
**only inside a `requestAnimationFrame` callback**. Since rAF never fires while the document is
hidden (measured under LT-032), one occurrence while backgrounded sticks the guard for the life of
the component — silently, with no error.

### The three instances

| Site | Guard | Trigger frequency | User-visible effect when stuck |
| --- | --- | --- | --- |
| `input-panel.component.ts` `scheduleTextareaResize()` | `resizeScheduled` | **every keystroke** (plus 5 other call sites) | the composer textarea stops auto-growing for the session |
| `transcript-jump-rail.component.ts` `scheduleMeasure()` | `measureScheduled` | items/viewport/prompt change, visibility toggle, transcript scroll, `ResizeObserver` | jump-rail tick highlighting and hover previews freeze |
| `transcript-find-controller.ts` `waitForRender()` | an awaited rAF promise | a find with zero visible matches and older messages available | the promise never settles, so the enclosing `finally` never runs, `loadingOlder` stays `true`, and the find bar's next/prev buttons stay disabled |

The first is the worst: it fires on **every keystroke**, so the window only has to be backgrounded
for a single character for the composer to stop resizing until the session ends.

The third is the subtlest — the guard is not a boolean at all. A never-settling `await` inside a
`try` means the `finally` that clears `loadingOlder` never runs. Same root cause, different disguise.

### Fix

All three now use `runRestoreFrame()` (`restore-frame.ts`), which races the frame against a bounded
timeout and cancels the loser.

### Why this was worth chasing beyond LT-032

LT-032 was filed against the transcript's scroll-restore paths. Fixing only those would have left the
same defect on the composer's keystroke path — more frequently hit than anything LT-032 touched.
**When a completion gate confirms a defect, the useful next question is not "is my fix right?" but
"where else does this shape appear?"** Asking that produced three more real defects; asking only the
first would have produced none.

### One related hazard deliberately left alone

`workspace-bench.service.ts:162-168` (`waitForPaint`) awaits a double-rAF promise that also never
settles while hidden. It is the same *underlying* hazard but **not** the LT-033 shape — there is no
persistent flag left wrongly set, so nothing is bricked for the session; the await simply stalls
until the window is visible again. It is also a manual benchmarking harness reachable only from the
bench UI.

Not fixed, for a concrete reason: `restore-frame.ts` lives in `features/instance-detail/`, and
`workspace-bench.service.ts` is in `core/services/`. Importing it there would make a core service
depend on a feature module — a layering inversion that two gates explicitly checked for and found
clean. Fixing this properly means promoting the helper to a shared location, which is a wider change
than the hazard justifies. Recorded so it is a decision, not an oversight.

### Ruled out in the same sweep

Checked and cleared as *not* this shape (no persistent re-entry guard tied to the frame):
`instance-list.component.ts:715`, `output-stream-inline-edit-controller.ts:98`,
`streaming-text.component.ts` (recursive loop, id used only for cancellation),
`voice-audio-capture.ts` (`stopped` gates only its own tick), `workspace-bench.service.ts`
(dev-only), and the one-shot drag-image/focus cleanups in `source-control.component.ts`,
`file-explorer.component.ts`, and `recent-directories-dropdown.component.ts`.

## LT-034: The context ring renders aggregate token spend as context-window occupancy

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Scope — this is not Copilot-only

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Note on LT-018's relationship to this

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Fix — landed 2026-08-11 (option 1: label the aggregate honestly)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

### Verified live — 2026-08-11 (dev app, CDP)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-034-archived-detail).

## LT-060: Concurrent dev-app livetest runners silently collide on one shared profile

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

### Residual note

[Read the detail](livetest-remediation-register-archive-2026.md#lt-060-archived-detail).

## LT-055: RLM's general context stores never populate the vector store, so `semantic_search` silently degrades to keyword

**Found:** 2026-08-01, WS16 livetest check 5 (recall traces for the `rlm` surface). Filed as an
`LT-NNN` item on 2026-08-12 — it was reproduced with evidence but had not previously been added to
this register.
**Source evidence:** [WS16 check 5](./2026-07-13-fable-ws16_livetest_completed.md#check-5--root-caused-2026-08-01-the-rlm-surface-cannot-emit-a-trace-today)

### Observed behaviour

Driven live against a real RLM context store: `rlmCreateStore` → `rlmAddSection` (a real note) →
`rlmStartSession` → `rlmExecuteQuery {type: 'semantic_search'}`. The query **succeeded** and
returned a plausible-looking result (`[Match 1] backoff-notes (external): …`), with no error and no
indication anything was degraded — but the match came from the **keyword fallback**, not vector
search. `VectorStore residency changed { totalVectors: 0 }` was logged for that store the whole
time. A caller who explicitly asks for `semantic_search` has no way to know it silently ran as a
keyword search instead.

### Root cause

`RLMContextManager.indexStoreForSemanticSearch()` (`src/main/rlm/context-manager.ts:519-532`) is
the **only** method that ever writes vectors for a general-purpose context store (the kind created
by `rlmCreateStore`/`rlmAddSection`), and it has **zero production callers** anywhere in `src/`
(confirmed by grep, and it is not exposed over any IPC channel). So every context store created
through the normal API starts and stays vector-empty, and `context-search.ts`'s semantic-search path
(`:236-262`) only emits a recall trace and returns vector hits `if (searchResults.length > 0)` —
with zero vectors that branch never fires, and the code falls through to the keyword path with no
signal to the caller.

This is a different code path from RLM's **episodic** memory store, which is not affected:
`episodic-rlm-store.ts` calls `vectorStore.addSection()` directly on every write (`:204, :355,
:392`), so episodic semantic recall genuinely works. The gap is specific to session/context stores
made via the `rlmCreateStore` family — the surface WS16 check 5 happened to exercise.

Embeddings themselves are not the blocker (ruled out, not assumed): `EmbeddingService` in `auto`
mode falls Ollama → OpenAI → Voyage → local TF-IDF (`embedding-service.ts:231-262, :422`), so it
would embed with no external provider configured at all. Nothing ever calls it for this store kind.

### Required behaviour (decision needed, not implemented)

`semantic_search` against an RLM context store should either genuinely search vectors, or the
response should say plainly that it fell back to keyword matching — not silently substitute one for
the other. Three viable wiring points, in increasing cost/complexity:

1. **Lazy, on first semantic query** — call `indexStoreForSemanticSearch` inside
   `context-search.ts`'s semantic-search branch when `totalVectors === 0`, before falling through to
   keyword. Cheapest to add; pays the embedding cost only for stores that actually get queried
   semantically, but adds latency to that first query.
2. **Eager, on every `addSection`** — index synchronously (or via a debounced batch) whenever a
   section is added. Keeps queries fast but pays an embedding pass on every write, including
   sections that are never searched semantically — a real, ongoing cost for high-churn stores.
3. **Explicit, caller-driven** — expose `indexStoreForSemanticSearch` over IPC/MCP and require the
   caller to opt in before relying on `semantic_search`. No hidden cost, but pushes the decision onto
   every caller and does nothing for the ones (like this check) that assume `semantic_search` just
   works today.

### Why this is not implemented in this session

Per this campaign's fixing guidance, this is a genuine product/UX and cost tradeoff (which
call-time or write-time cost model to accept), not a bug with one obviously-correct fix — so it is
recorded here rather than decided unilaterally. It is deliberately **not** treated as one of this
repo's known-by-design orphan primitives (`fuseHybrid`, `policy-engine`, `lease-dispatch`,
`lesson-store`): those were built ahead of a feature that does not exist yet, whereas
`semantic_search` is a shipped, already-used RLM query type that silently behaves differently from
its name for this one store kind. Recommendation, if asked: option 1 (lazy, on first semantic
query) — it is the smallest change, adds no cost to write-heavy stores that are never searched
semantically, and only pays the embedding cost exactly when a caller has already asked for semantic
search specifically.

### Completion gate round 1 — **FAIL**, and it was right: the fix covered 2 surfaces of 7

The first independent fresh-eyes review rejected the fix above. It was correct, and the shape of the
miss is the same one recorded for LT-018 in this register: **a confident-wrong-number bug is never
one call site.** The original fix guarded the two surfaces the live check happened to exercise (the
composer ring and the injected context warning) and left five more rendering the same fabricated
figure.

| # | Surface | What it did with cumulative spend | Severity |
| --- | --- | --- | --- |
| 1 | `instance-detail.component.ts` `contextWarningLevel` | drove `[disabled]` on the composer at ≥ 95 % | **Critical** |
| 2 | hibernate/wake (`context-usage-restore.ts`, `session-continuity.ts`) | dropped the flag entirely on every round trip | High |
| 3 | `instance.queries.ts` `totalContextUsage` | summed it into the always-visible sidebar "% ctx" | High |
| 4 | `mobile-gateway-serializers.ts` | shipped it to phone clients as `contextPercentage` | High |
| 5 | `provider-diagnostics-panel.component.ts` | rendered it as "N %" with a `warning` tone ≥ 90 | Medium |

**Finding 1 is worse than the original defect.** `percentage` for an aggregate provider is
monotonically non-decreasing and clamped at 100, so *every* sufficiently long Copilot / Gemini /
non-resident-Claude / Codex-exec session eventually crosses 95 % and **disables its own composer** —
locking the user out of a session whose real context may be nearly empty. Suppressing the main
process's `checkContextWarningThreshold` did nothing for it, because the renderer keeps an entirely
independent copy of the same threshold. Two copies of a rule, one fixed.

**Finding 2 is the LT-018 trap for the third time.** `restoreContextUsage` and `instanceToState`
both rebuild `ContextUsage` field by field, and `session-continuity.types.ts` narrows the persisted
shape — so the flag was dropped with no compiler error, exactly as the LT-018 write-up warned.

### Remediation

- Finding 1: the rule is extracted to `context-warning-level.ts` as a pure
  `resolveContextWarningLevel()` with its own spec — the same treatment `context-usage-restore.ts`
  got, and for the same reason: it was an unreviewable computed inside a component with no spec and
  a large dependency graph. It now also suppresses on unreported occupancy (LT-018), which the
  original never did.
- Finding 2: flag added to `PersistedContextUsage`, `restoreContextUsage`, `instanceToState` and the
  `session-continuity.types.ts` shape. Deliberately **no** inference from the numbers for legacy
  records — spend and occupancy are indistinguishable by value, so a pre-field record is treated as
  occupancy (today's behaviour) and self-corrects on its first context event, which carries the
  adapter's real declaration.
- Findings 3-5: guarded at each surface; cost is still counted for aggregate instances, because
  billing is independent of occupancy reporting.

**23 further tests added across 6 specs, each mutation-verified** (revert the guard → the test
fails; restore → it passes). Gates green: `tsc` ×2, `lint`, `check:ts-max-loc`, `build:main`.

**The lesson, restated because it has now cost three rounds across two defects:** when a wrong number
reaches the UI, the fix is not "guard the surface that showed it" — it is "enumerate every consumer
of that number and guard all of them", and a completion gate is what catches the difference.

## LT-050: A Codex app-server parent's `spawn_child` reliably destroys itself

**Current status (2026-09-23): IN PROGRESS.** The 2026-08-12 classification fix and live verification below remain valid for the fatal parent failure. The separately recorded lost `spawn_child` confirmation is now assigned for repair. The old live run does not verify that handoff.

**Found:** 2026-08-11, while staging resilient-threads-sessions check 3 (orphaned orchestration
children reconciled on restart) with a Codex parent, per that doc's own staging advice.

**Observed behaviour.** A Codex (`app-server`, resident) instance `x7qnqny52` spawned two
orchestration children via `spawn_child`. Both spawns succeeded (children registered:
`InstanceContext | Completed ingesting initial messages`), but each spawn's follow-up — the
orchestrator injecting a "child spawned" confirmation back into the **parent's own** turn — failed
identically:

```
23:21:27.676 ERROR InstanceOrchestration  Failed to inject response to instance { instanceId: 'x7qnqny52' }
  CodexAppServerRuntimeError: Codex app-server runtime already has an active turn
    at CodexAppServerThreadRuntime.captureTurn (app-server-thread-runtime.js:104)
    ...
23:21:30.048 ERROR InstanceLifecycle  Illegal lifecycle transition blocked { instanceId: 'x7qnqny52', from: 'error', to: 'busy' }
23:21:35.176 WARN  IdleMonitor        Found zombie process, force killing { instanceId: 'x7qnqny52', status: 'error' }
23:21:43.206 ERROR InstanceCommunication  No adapter found for instance { instanceId: 'x7qnqny52', status: 'idle' }
```

The parent instance ends adapter-less and unusable (`SEND_FAILED: Instance … is in an inconsistent
state (no adapter). Please restart the instance.`) — reproduced on **both** spawn attempts in the
same session, back to back.

**Root cause (verified by reading the executing path).** `InstanceOrchestration`'s `inject-response`
handler (`src/main/instance/instance-orchestration.ts:511-559`) calls `adapter.sendInput(response)`
to deliver the spawn confirmation back into the parent, serialized only against *other*
inject-response calls for the same instance (a per-instance `writeQueues` chain) — it does **not**
wait for the parent's own **current** turn (the one whose assistant message emitted the
`spawn_child` command) to finish. For a stateless per-turn adapter (Claude `--print`, Codex exec)
that race is harmless — each `sendInput` starts an independent subprocess turn. For Codex's resident
app-server runtime it is not: `CodexAppServerThreadRuntime.captureTurn`
(`src/main/cli/adapters/codex/app-server-thread-runtime.ts:199-203`) throws
`CodexAppServerRuntimeError({kind: 'request-rejected', message: 'Codex app-server runtime already
has an active turn'})` whenever a second turn is attempted while one is in flight — and the parent's
own turn (still generating/settling after emitting the orchestrator command) reliably still owns the
active turn slot when the async spawn completes ms later.

The adapter's catch in `sendInputImpl` (`src/main/cli/adapters/codex-app-server-adapter.ts:517-546`)
then classifies the failure via `planCodexAppServerRecovery`
(`src/main/cli/adapters/codex/app-server-recovery-policy.ts:28-43`): the error kind
`request-rejected` matches none of `RETRYABLE_FAILURES`, `provider-limit`, `recovery-paused` or
`thread-unavailable`, so it falls through to the default `{action: 'restart-runtime',
keepInstanceUsable: false}` — a **hard, unrecoverable** classification — and the instance's status is
set to `'error'`. A later legitimate status transition for the same instance (its own turn settling)
is then illegally blocked (`from: 'error', to: 'busy'`), `IdleMonitor`'s zombie detector force-kills
the adapter shortly after, and the instance is left permanently without an adapter.

This is the same underlying error shape LT-030 fixed for provider/model swaps on a looping session
("Codex app-server runtime already has an active turn" reverting the swap) — but LT-030's fix
(reciprocal interlock; wait for the in-flight turn) was scoped to the swap and loop-continuity call
sites. The orchestration `inject-response` path is a separate call site with the identical race and
was not covered.

**Required behaviour.** `inject-response` must not fire-and-forget into an instance whose own turn
may still be active on a resident runtime: either wait for the instance to actually reach an
idle/ready state before injecting (the LT-030 pattern), or queue/retry the injection once the
runtime reports free, and in all cases a `request-rejected` "already has an active turn" collision on
this path must not be classified as `keepInstanceUsable: false` — it is an expected, transient
scheduling collision, not a runtime failure requiring a restart.

**Impact.** Any orchestration `spawn_child` (and, by the same code path, any other action whose
result reaches `inject-response`) from a Codex app-server–backed parent is at real risk of destroying
that parent's session. Reproduced 2 of 2 times in this session. Not fixed — flagged as a product
defect for the owning team; resilient-threads-sessions check 3 could not be staged against a Codex
parent because of it (see the check's evidence run).

### Fix — 2026-08-12 — FIXED at the classification layer, verified live

**Diagnosis re-verified.** Re-read the full path before changing anything:
`instance-orchestration.ts:511-559` confirmed unchanged from the filing — `inject-response` really
does call `adapter.sendInput(response)` serialized only against other `inject-response` calls, with
no wait on the parent's own turn. `CodexAppServerThreadRuntime.captureTurn`
(`app-server-thread-runtime.ts:199-203`) confirmed it throws `kind: 'request-rejected'` for the
active-turn collision — **and it already sets `recoverability: 'retry-thread'` on that throw**, a
detail the original filing didn't examine. `app-server-recovery-policy.ts`'s
`planCodexAppServerRecovery` confirmed it branches only on `failure.kind`, never reads
`failure.recoverability`, so `request-rejected` always fell through to the default
`{action: 'restart-runtime', keepInstanceUsable: false}` regardless of that field. This is the actual
root cause of the crash: **the throw site already correctly labels the collision as transient, and
the recovery policy discards that label.** The filed diagnosis's proposed fix ("wait for the turn to
settle before injecting") would also work but is not what made the field wrong — the classification
bug is.

**Layer chosen and why.** Of the three candidate layers in the brief:
- **Fixed:** the recovery-policy classification (layer 2/3). `request-rejected` is overloaded — it
  also covers a genuinely terminal rejection (e.g. an unknown model, which `classifyMessage` labels
  `recoverability: 'terminal'`). The fix trusts the throw site's own `recoverability` field instead of
  collapsing every `request-rejected` into a restart: only `request-rejected` errors explicitly
  labelled `retry-thread` (i.e. the active-turn collision) now map to
  `{action: 'retry-turn', keepInstanceUsable: true}`; every other `request-rejected` (including the
  message-classified 'terminal' ones) is unaffected. This is narrow, provable by reading the one other
  throw site of `recoverability: 'retry-thread'` with kind `request-rejected` (there is exactly one),
  and it is the sole boolean (`keepInstanceUsable`) that decides whether `sendInputImpl`'s catch emits
  `status: 'idle'` or `status: 'error'` (`codex-app-server-adapter.ts:533-537`,`690-695` — verified by
  reading, `.action` itself has no other consumer in the codebase). `status: 'error'` was the entire
  cascade: illegal `error → busy` transition → `IdleMonitor` zombie-kill → no adapter. Fixing the
  classification removes the cascade at its root.
- **Historical 2026-08-12 residual, fixed in code 2026-09-23:** queueing/awaiting the parent's
  turn before injecting (layer 1). Live reproduction below shows this race is not merely theoretical
  — even with the crash fixed, the "child spawned" confirmation is still silently dropped when it
  collides, so a parent that expects to learn a child's id and act on it *within the same turn*
  (e.g. spawn child B immediately after being told child A's id) does not get that information and
  ends its turn without it. A real fix needs either a bounded retry once the runtime reports free, or
  an LT-030-style reciprocal interlock (`beginRuntimeChange`/`waitForRuntimeChange` in
  `runtime-reconciler.ts`) applied to this call site. Not implemented here because (a) the
  orchestration layer is deliberately provider-agnostic and doing this without importing Codex-specific
  error shapes into `instance-orchestration.ts` would mean either a blind generic retry (defensible,
  but broadens scope and needs its own mutation-tested regression suite) or duplicating LT-030's
  interlock machinery for a second call site, and (b) the P1 harm — the parent dying — is already
  eliminated. This is exactly the kind of design decision the campaign brief says not to make
  unilaterally; flagging it here rather than picking an implementation.

**Regression test, mutation-verified.**
`src/main/cli/adapters/codex/app-server-recovery-policy.spec.ts` gained two cases: one constructs the
exact typed error `captureTurn` throws (`kind: 'request-rejected'`, `recoverability: 'retry-thread'`,
the real message text) and asserts `{action: 'retry-turn', keepInstanceUsable: true}`; a second
constructs a `request-rejected` error labelled `recoverability: 'terminal'` (an invalid-model
rejection) and asserts the *old* behaviour (`restart-runtime`, `keepInstanceUsable: false`) is
unchanged, so the fix cannot be broadened by accident. Reverting only the production change (keeping
both tests) made the first new test fail (`restart-runtime`/`false` instead of
`retry-turn`/`true`) while the second still passed; restoring the fix made both pass again — watched
directly, not inferred.

**Gates (scope: the two touched files).** `npx tsc --noEmit`, `npx tsc --noEmit -p
tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main` all green. (Two
unrelated pre-existing TS errors — `context-warning-level.ts`/`context-occupancy.ts` referencing a not
-yet-exported `RESTORED_CONTEXT_USAGE_SOURCE`/`occupancyIsAggregate` — are from a concurrent sibling
session's in-flight, uncommitted work in this shared repo; confirmed independent by import-graph, not
in this change's diff, and outside `tsconfig.electron.json`'s scope so `build:main` is unaffected.)
Targeted `npm run test:quiet -- src/main/cli/adapters/codex/app-server-recovery-policy.spec.ts` → 8/8
passed.

**Verified live.** Own isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-lt050`,
`--remote-debugging-port=9462`, rebuilt main via `npm run build:main`, Electron main pid `90702`). A
real Codex app-server parent (`x3j0hlkum`) was asked to `spawn_child` a genuinely-long-running child
(a real `for ...; do ...; sleep 1; done` loop, not an essay, to actually stay busy — a 3,000-word essay
finishing in ~40s was already shown non-decisive by the 2026-07-31 session-2 note). The collision
reproduced exactly as filed:

```
23:47:43.569 ERROR InstanceOrchestration  Failed to inject response to instance { instanceId: 'x3j0hlkum' }
  CodexAppServerRuntimeError: Codex app-server runtime already has an active turn
    at CodexAppServerThreadRuntime.captureTurn (app-server-thread-runtime.js:104)
```

but this time the parent's status stayed `idle`, its pid (`96556`) never changed, and **zero**
`Illegal lifecycle transition`, `Found zombie process`, or `No adapter found` lines appeared in the
log (grepped for all three across the full session). A follow-up user turn asking the same parent to
spawn a second child hit the identical collision (log line 926-927, same error) and again the parent
stayed alive and idle. End state: parent `x3j0hlkum` `idle` with `childrenIds: ['x1m327j1c',
'xh0q81t2c']`, both children confirmed `busy` with real Codex `app-server` CLI pids
(`ppid` = the dev app's own Electron main `90702`, confirming they were mine, not another session's).
This is the exact scenario that killed the parent 2/2 times in the original filing; it now survives
2/2 times. All three test instances (parent + both children) were terminated via `terminateInstance`
and the isolated dev app/workspace were torn down afterward.

**Resilient-threads check 3 status.** This fix removes check 3's blocking precondition — a Codex
parent can now hold two live orchestration children without dying. Attempting the rest of check 3 (kill
one child, force the parent's fresh fallback, assert the reconcile log line) in this same session
found that forcing a **decisive** fresh fallback for a Codex parent requires directly manipulating
Codex's own shared `~/.ai-orchestrator/codex` session store (a per-thread SQLite row plus rollout
file) that many concurrent sibling livetest sessions were actively writing to at the same time; the
project's own recorded lesson is "never manual-delete" these rows because a startup reconciler
(`reconcilePrivateCodexRolloutPaths()`) owns them. Deliberately corrupting a live, shared, multi-writer
store to force one check felt like an unjustified risk to other sessions' live work with no clean undo
path, so it was not attempted. **Check 3 is therefore still NOT RUN** — see the resilient-threads doc's
own evidence-run entry for the full detail and the child-kill step that *was* completed safely (pid-
gated, own dev app only).

## LT-061: Tool-loop detector under-detects realistic Bash-tool doom loops (incidental metadata pollutes argsHash)

### Observed behavior

Sibling-audit-round2 check A2 asks: craft a prompt that makes the CLI poll an unchanging file
repeatedly; expect a warning toast after ~3 identical call/result pairs. Driven live (Batch E
isolated dev app, instance `c5ogymnv8`, Claude, yolo): asked the agent to run
`cat /tmp/aio-lt-batchE-c10/watch.txt` (an unchanging file) 8 times in a row via the Bash tool, no
other commentary. It complied — 7 `Bash` tool_use calls, each with the identical `command` field —
but the renderer's `instance:doom-loop` listener (hooked directly via
`ipcService.on('instance:doom-loop', …)` *before* the send, to rule out a toast-timing artifact)
captured **zero** events. No toast fired.

### Root cause

`toProviderToolUseObservedEvent` (`src/main/providers/adapter-runtime-event-bridge.ts:533-534`)
computes `argsHash = hashStable(stableStringify(toolCall.arguments))` over the **entire** raw
arguments object the CLI reports, unfiltered — and `instance-tool-loop-wiring.ts:49-57`
(`toToolUseObservation`) feeds it `event.input` verbatim, with no field allow/deny-list. This is
live, wired code (not the dormant WS-B10 seam the module doc discusses — `observeToolLoopEvent` is
called from `InstanceManager.emitProviderRuntimeEvent()`).

For Claude's Bash tool, the raw input is `{command, description}`, where `description` is
documented as a short human-readable annotation shown during permission prompts — cosmetic, not
part of what the command does. Claude naturally varies that text per call even when the `command`
itself is byte-identical and the file being polled never changes — in this run it produced
`"Read watch.txt (1/8)"`, `"(2/8)"`, … `"(7/8)"`. Because `argsHash` is computed over `{command,
description}` together, each call gets a **different** hash, so `checkRepeatNoProgress`
(`doom-loop-detector.ts:311-340`) never sees the same `lastSignature` twice — `repeatChainLength`
resets to 1 on every call — and the 3-in-a-row threshold is never reached. `ping-pong` has the same
exposure since it also keys on `signatureOf(toolName, argsHash)`.

### Required behavior

A realistic Bash-tool polling loop, where the command is identical and produces an unchanging
result, must trigger `repeat-no-progress` regardless of incidental per-call annotation text the CLI
includes alongside the command (Claude's `description` field being the concrete case observed;
other CLIs/tools may have analogous cosmetic fields).

### Acceptance

- A regression test on `doom-loop-detector.ts` (or the bridge/wiring layer) proves 3 Bash tool_use
  events with identical `command` but distinct `description` (e.g. `"(1/3)"`, `"(2/3)"`, `"(3/3)"`)
  and identical results now trigger `repeat-no-progress`, and that it still does **not** falsely
  trigger when the `command` itself genuinely changes between calls.
- Sibling-audit-round2 check A2's first half (toast after ~3 identical calls) passes live with a
  prompt worded like a natural doom loop, not one that artificially forces identical `description`
  text too.

### Scope note (why this was not fixed in the original session)

The narrow, defensible fix — excluding the Bash tool's `description` field from the hash — is
mechanical. Generalizing it (which fields are "cosmetic" for which other tools/providers) is a
product-judgment call that session did not make unilaterally; recorded as reproduced, not fixed.
Not fixed in that session for the same reason plus time budget; the register/plan status sections
were updated accordingly, and the finding was written up for a decision rather than acted on alone.

### Decision and fix (2026-08-12)

Went with the general fix, not the Bash-only one, per the steer in the follow-up task: a per-tool/
per-provider denylist (e.g. `toolName === 'Bash'`) rots the moment a *different* tool or CLI adds
its own annotation field under a different name — the exact scenario this task exists to prevent a
repeat of.

`toProviderToolUseObservedEvent` (`src/main/providers/adapter-runtime-event-bridge.ts`) now strips a
fixed set of top-level field names — `description`, `reason`, `rationale`, `explanation`,
`justification`, `summary`, `note`, `thought` — from the arguments object before hashing
(`stripAnnotationFieldsForHash` / `ARGS_HASH_IGNORED_ANNOTATION_FIELDS`), for **every** tool and
provider, not just Bash. `argsSummary` (the human-readable value shown in diagnostics) is
unaffected — only the loop-detection hash changes.

This is scoped by **field name**, not by tool identity, which is deliberately narrower than "detect
any cosmetic field automatically" (not achievable without per-tool schema awareness at the
observation site) but broader than "Bash's `description` only". It still needs a new entry for a
genuinely novel field-name convention, but no longer needs a change per tool or per provider.

Safety against masking a genuinely operative field that happens to share one of these names (e.g. a
hypothetical tool whose real payload lives in a field called `summary`): both `repeat-no-progress`
and `ping-pong` additionally require the tool's **result** to match/stay stable across the repeated
calls. A call whose real effect lives in one of the stripped fields will almost always produce a
different result each time, so it will not falsely collapse into "no progress" — verified by a test
that a genuinely different operative argument (with the annotation field held constant) still
produces a different `argsHash`.

**Regression tests** (all in `adapter-runtime-event-bridge.spec.ts` and `doom-loop-detector.spec.ts`,
mutation-verified — reverted the fix, watched the exact 3 tests fail, restored, watched them pass):
- Bash `command` identical / `description` varying → identical `argsHash`.
- Bash `command` genuinely different / `description` identical → different `argsHash`.
- A non-Bash, hypothetical MCP tool with a differently-named annotation field (`reason`) → identical
  `argsHash` when only `reason` varies, proving the exclusion is not gated on `toolName === 'Bash'`.
- The same hypothetical tool with a genuinely different operative argument → different `argsHash`.
- `argsSummary` still shows the full arguments including the annotation field.
- A pipeline-level test drives 3 realistic Bash `tool_use`/`tool_result` pairs (identical `command`,
  `description` `"(1/3)"`…`"(3/3)"`, identical result) through the real `toProviderToolUseObservedEvent`
  → `DoomLoopDetector.recordToolUse`/`recordToolResult`, and asserts `repeat-no-progress` fires; a
  second test with 3 genuinely different commands and formulaic step-numbered descriptions asserts it
  does **not** fire.

Gates on the touched files: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run
lint`, `npm run check:ts-max-loc`, `npm run build:main` all clean; targeted
`npm run test:quiet -- src/main/providers/adapter-runtime-event-bridge.spec.ts
src/main/orchestration/doom-loop-detector.spec.ts` — 46/46 passing.

### Live verification and scope-narrowing discovery (2026-08-12)

Drove this live in an isolated dev app (`AIO_DEV_USER_DATA_PATH`, port 9461, rebuilt `dist/main`
with the fix). First re-ran the **exact original repro shape** against **Claude** (matching the
original filer's provider choice): working dir `/tmp/aio-lt-lt061-work/watch.txt`, yolo, prompt
asking for 8 sequential `cat watch.txt` Bash calls with no other commentary. Confirmed via the raw
`outputBuffer` that Claude produced 8 calls with byte-identical `command: "cat watch.txt"` and
varying `description: "Check watch.txt contents (N/8)"` — the textbook LT-061 shape. With the fix
live, `instance:doom-loop` (hooked via `electronAPI.onInstanceDoomLoop` before the send) still
captured **zero** events.

Traced why: `bindRawAdapterProviderEvents` (`instance-communication-provider-events.ts`) — the only
production call site that emits `kind: 'tool_use'`/`'tool_result'` events into
`emitProviderRuntimeEvent` (and therefore into the tool-loop detector) — is driven purely by an
adapter's own `tool_use`/`tool_result` `EventEmitter` events. Grepping every adapter under
`src/main/cli/adapters/` for `.emit('tool_use', …)` finds exactly one hit outside test fixtures:
`acp-cli-adapter.ts`. Claude's NDJSON streaming adapter (`claude-cli-adapter.ts`) collects tool calls
into a `toolCalls` array attached to the response/`output` messages instead, and the same is true of
Codex, Gemini, Antigravity and Ollama's adapters — none of them ever call `.emit('tool_use', …)`. So
for every provider except the three that use `AcpCliAdapter` (Copilot, Cursor, Grok), the entire
WS-A2 detector is unreachable, independent of `argsHash` correctness.

Confirmed the pipeline works end-to-end where it *is* reachable: the identical prompt shape against a
**Cursor** (ACP) instance produced a live `repeat-no-progress` **warn** at count 3
(`toolName: "\`rtk cat watch.txt\`"`) and **critical** at count 6, captured by the same
`electronAPI.onInstanceDoomLoop` listener. This is separate from the LT-061 fix under test (Cursor's
ACP `execute` tool didn't happen to vary an annotation field in this run) but it proves the compiled
fix, the wiring, and the renderer IPC channel are all live and correct for a real running session —
isolating the Claude-null-result to the adapter-emission gap, not to anything in this fix.

Filed the adapter-emission gap separately as **LT-062** (below) rather than folding it into this
item, since it is a different code location and a materially different (and larger) fix, and this
item's own acceptance criteria — the `argsHash` behavior — are met and mutation-verified regardless.
LT-061's own acceptance criterion "Sibling-audit-round2 check A2's first half … passes live" is
**not yet fully satisfiable for a Claude session** because of LT-062; it does pass live for an
ACP-based provider today. A2 should be re-run once LT-062 is resolved (or explicitly re-run against
an ACP provider in the interim) to see the toast for the provider the check actually exercises.

## LT-062: The WS-A2 tool-loop detector never receives an observation for Claude/Codex/Gemini/Antigravity/Ollama sessions

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Scope note (why this was not fixed in this session)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Fix (2026-08-12)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

### Live verification (2026-08-12)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-062-archived-detail).

## LT-040: Claude CLI never connects to the `computer-use` MCP server for any instance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Root cause (as first filed, 2026-08-12 batch A)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Root cause — confirmed 2026-08-12, LT-040 pickup

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Fix — 2026-08-12, LT-040 pickup

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

### Impact on this batch

[Read the detail](livetest-remediation-register-archive-2026.md#lt-040-archived-detail).

## LT-045: Manual Codex compaction re-pays the 30s confirmation timeout on every call, not just the first

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Completion gate round 2 — **FAIL again**, and it found the worst one yet

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### Round-2 remediation

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

### What two failed gates cost, and what they bought

[Read the detail](livetest-remediation-register-archive-2026.md#lt-045-archived-detail).

## LT-046: The rolling handoff document never accumulates state on a turn without billable usage

[Read the detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-046-archived-detail).

## LT-047: A resident Claude CLI session never fires the adapter `'complete'` event

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Impact beyond the handoff feature

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Root-caused + fixed 2026-08-12 (LT-047 dedicated pass)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Completion gate round 3 — **FAIL**, including a self-inflicted regression

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Round-3 remediation — and the duplication is finally gone

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

### Deliberately not changed

[Read the detail](livetest-remediation-register-archive-2026.md#lt-047-archived-detail).

## LT-065: The WS5 workspace-write observer silently drops every change on a symlinked workspace path

[Read the detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-065-archived-detail).

## LT-090: Codex resident turns also never record cost — `response.usage` is undefined on `'complete'`

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

### Fix and live re-verification — 2026-08-12, cost-tracking follow-up batch

[Read the detail](livetest-remediation-register-archive-2026.md#lt-090-archived-detail).

## LT-095: No UI exists to approve or deny a `computer.request_app_grant` request

[Read the detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail).

### Fix — 2026-08-12 (audit-appId sub-defect only; the "no UI" finding itself is NOT fixed)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail).

### Fix — 2026-08-12 (the "no UI" finding itself, now FIXED and live-verified)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-095-archived-detail).

## LT-105: an errored resident Claude turn still skips completion

**Found:** 2026-08-12, by the consolidation review of the combined agent-shipped diff — not by any
livetest check.

LT-047 established that a resident Claude turn completes inside `processCliMessage`'s `case 'result'`
and never called `completeResponse()`, starving cost/telemetry/hooks/handoff-state. That is fixed.

`case 'error'` has the same shape and was **not** in LT-047's scope: it emits an `error` output
message and a status transition, but never calls `completeResponse()`. So a resident turn that fails
mid-stream still records no cost entry, fires no `Stop`/`PostSampling` hook, and notes no completed
turn for handoff state. The one-shot `sendMessage()` path is unaffected — its process-close handler
still resolves even after a mid-stream error — so this is resident-mode only, which today means
effectively all Claude sessions.

### Why it is filed rather than fixed

The obvious fix (call `completeResponse()` in the error branch too) is not obviously safe:

- `awaitingOneShotCompletion` guards the `result` path against double-firing; the error path would
  need the same treatment plus certainty that an error *followed by* a `result` cannot fire twice.
- `residentTurnRawOutput` accumulation would need a defined disposition on the error path.
- What a failed turn should report as usage/cost is a real question — a turn that errored partway
  has consumed tokens, so recording nothing understates spend, but recording a partial as a normal
  completion may distort per-turn analytics.

It also needs live verification against a genuinely errored resident turn, which is a staging job in
its own right. Doing it blind, on the same code path where LT-047 has just landed, is exactly the
kind of unverified adjacent fix that has produced regressions elsewhere in this campaign.

### Acceptance

- A resident Claude turn that errors mid-stream records exactly one cost entry (or a deliberate,
  documented decision that it should record none), fires its hooks once, and notes the turn once.
- Neither an error alone nor an error followed by a `result` can double-fire completion.
- Live-verified on a real errored resident turn, not only unit-tested.

### Fix — 2026-09-23

Decisions on the three filed questions: (1) completion fires once, at the `error`, tagged
`metadata.turnErrored`, and `residentTurnCompletedByError` (reset whenever a turn starts) stops a
trailing `result` from firing it again; (2) `residentTurnRawOutput` is parsed for that completion and
cleared, exactly as the `result` path does; (3) the partial turn's usage is recorded rather than
dropped, and `instance-communication.ts` skips the success-only effects for it (no provider-limit
clear; `Stop` reports `error`). The `result` usage block moved to `claude-result-usage.ts` to keep the
adapter under its LOC ceiling. Regression tests: `claude-cli-adapter.spec.ts` "LT-105" (4) and
`instance-communication.spec.ts` "(LT-105)"; all fail with the fix reverted. Evidence: no resident
`type: error` event appears in 985,811 captured Claude adapter events (2026-08-12 to 2026-09-23), so the
live check needs a staged failure; it is recorded in `2026-09-23-outstanding-plans-sweep_livetest.md`.


## LT-100: ACP-transport providers (Cursor and Grok confirmed) record zero cost when the ACP server omits `usage`

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-100-archived-detail).

## LT-130: RendererHeartbeat misreports every lock-screen period as a UI freeze

**Found:** 2026-08-12, investigating a report from a prior worker session of "recurring ~12s renderer
stalls" in the packaged app's `app.log` around 2026-08-11 12:56 BST.
**Source evidence:** read-only inspection of the packaged app's
`~/Library/Application Support/harness/logs/app.log` (pid 38865, never restarted or killed), spanning
2026-08-08 through 2026-08-12 (the log's full retained window). No dev-app reproduction was attempted —
the mechanism was established directly from the real log's timing correlation.

### Observed behaviour

The originating report undercounted the pattern by orders of magnitude. `RendererHeartbeat` logged
**10,034** stall/recovery log lines across the four-day window, not a one-off 17-minute episode. Grouping
by >120s gaps between consecutive heartbeat log lines yields **24 distinct bursts**, ranging from ~1 minute
to **~11 hours** long, together covering roughly half of the four-day window. Within a burst the shape is
extremely regular and stable:

```
{"message":"Renderer heartbeat recovered","data":{"senderId":1,"stalledMs":59993,"missedBeats":0}}
{"message":"Renderer heartbeat stalled — UI event loop likely blocked","data":{"senderId":1,"gapMs":14097,"lastSeq":7709}}
```

- `stalledMs` (the true elapsed time between beats) is consistently **~60000ms** (observed range
  59960–60011ms across hundreds of samples) — the heartbeat is arriving almost exactly once a minute
  instead of every 2s (`HEARTBEAT_INTERVAL_MS`).
- `missedBeats` is always **0** — the renderer's `seq` counter increments by exactly 1 between observed
  beats. This is the signature of a single coalesced `setInterval` tick firing after a long quiet period,
  not multiple queued ticks draining at once.
- `gapMs` at detection time (10-15s, drifting slowly within a burst then resetting) is just watchdog
  scan-interval jitter on top of the fixed 10s `HEARTBEAT_STALL_THRESHOLD_MS` — not informative about the
  freeze's real cause or duration.
- 2026-08-11 12:56 BST (11:56 UTC) falls inside one such burst (10:21:55–14:07:24 UTC that day) — the
  original report sampled a slice of a multi-hour episode and reported it as an isolated anomaly.

Programmatically correlating burst starts against every `RuntimeDiagnostics` `"System power event
observed"` log line (`{"source":"lock-screen"}` / `{"source":"suspend"}`) confirms the mechanism: **every
one of the 24 bursts begins within 60-90 seconds of a `lock-screen` event**, and stops shortly after the
matching `"System resumed... source: unlock-screen"` line. No burst occurred without a preceding
`lock-screen` event nearby, and no `lock-screen` period passed without a matching burst.

### Mechanism

`RendererHeartbeatService` (`src/renderer/app/core/services/renderer-heartbeat.service.ts:36`) sends a
beat via `setInterval(beat, 2_000)` from the renderer's own JS main thread — by design, so a real freeze
silences it. `BrowserWindow`'s `webPreferences` (`src/main/window-manager.ts:86`) do not set
`backgroundThrottling: false`, so Electron/Chromium's default background-timer throttling applies: once
the window is not visible (screen locked counts as backgrounded), Chromium coalesces its JS timers to
roughly once a minute to save power. The beat keeps sending — just ~30x slower — which is exactly what the
`stalledMs≈60000, missedBeats:0` shape shows.

`RendererHeartbeatMonitor` (`src/main/logging/renderer-heartbeat-monitor.ts`) had no suspend/lock-screen
awareness before this fix, so its 10s `scan()` threshold fires on every throttled gap during a lock-screen
period, `error`-logging a "UI event loop likely blocked" line that is not one — nobody is looking at a
locked screen, and the renderer is not actually starved of CPU, just intentionally throttled by the OS.
This is the exact asymmetry the "17-minute window" report missed: `RuntimeDiagnostics`'s own main-process
stall detector (`src/main/app/runtime-diagnostics.ts:111`) already has a `systemSuspended` gate for this
same case ("A suspend (sleep/lock) explains the gap as elapsed wall-clock, not a stall") — the renderer
heartbeat monitor simply never got the same treatment, which is why the brief's "no corresponding
main-process stall" observation was correct and a real, but separate, signal: the *main* process's own
detector correctly stayed silent through the lock periods; only the *renderer* detector, lacking the same
gate, fired.

### Candidates excluded (with the test that excluded each)

- **Large transcript re-render / unbounded list / synchronous JSON parse of a big payload**: excluded by
  the `missedBeats: 0` + near-exact-60000ms `stalledMs` shape across *every* occurrence, for four straight
  days, regardless of session count or transcript size at the time — a data-size-dependent freeze would
  not produce this rock-stable, fixed-cadence signature.
- **Signal/effect storm or `requestAnimationFrame`-driven backlog**: excluded on the same grounds — an
  accumulating backlog would grow unboundedly or vary with load, not hold steady at ~60000ms indefinitely
  across four days including idle periods.
- **Main-process event loop stall (GC, memory pressure)**: excluded directly — `RuntimeDiagnostics`'s own
  "Main process event loop stall detected" warnings are sparse (a handful over four days, each 2-5s, tied
  to real `rssMB`/`heapUsedMB` spikes) and do not correlate in time with the `RendererHeartbeat` bursts.
  The brief's own observation (no matching main-process warning) is correct and consistent with this being
  renderer/OS-level throttling, not a main-process freeze.
- **Growing/leaking accumulation across a burst**: the `gapMs` detection-latency field drifts up by ~15-40ms
  per cycle within a burst then resets, but `stalledMs` (the actual freeze length) does not — checked by
  sampling `gapMs` across an 11-hour burst (2026-08-08T08:51–12:54), which oscillates and periodically
  resets rather than growing unboundedly, ruling out an accumulating leak as the driver of the pattern.

### Required behaviour

`RendererHeartbeatMonitor` must not classify OS-driven background/lock-screen timer throttling as a
renderer freeze. It should mirror `RuntimeDiagnostics`'s existing suspend/resume handling for its own
services.

### Fix

Added `handleSystemSuspend()` / `handleSystemResume()` to `RendererHeartbeatMonitor`
(`src/main/logging/renderer-heartbeat-monitor.ts`): `scan()` now returns immediately while suspended, and
`handleSystemResume()` rebases every tracked renderer's `lastBeatAt` to the resume time so the elapsed
lock/suspend duration itself is never counted as a stall — a genuine freeze that starts *after* resume is
still caught by the normal 10s threshold on the next watchdog tick. Wired from
`RuntimeDiagnostics`'s existing `noteSystemSuspend`/`noteSystemResume` (`src/main/app/runtime-diagnostics.ts`),
alongside the `ObservationIngestor`/`SessionContinuityManager`/`HibernationManager`/`PoolManager` calls
already made there for the same `powerMonitor` events.

Deliberately **not** changed: `backgroundThrottling` on the `BrowserWindow` itself. Disabling it would keep
the renderer fully active (and battery-draining) while the screen is locked purely to keep a monitoring
heartbeat looking busy — the throttling is legitimate, useful OS behavior; the monitor should stop
misreporting it, not fight it.

### Verification

- `src/main/logging/renderer-heartbeat-monitor.spec.ts`: three new tests — no stall logged while suspended
  even across a beat gap far exceeding the threshold; the suspend/lock duration itself is never counted as
  a stall after resume (rebased `lastBeatAt`); a genuine stall that starts *after* resume is still detected
  and logged. All three mutation-verified (reverting either the `scan()` suspend gate or the
  `handleSystemResume()` rebase makes the corresponding new test fail; restoring the fix makes all pass).
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run build:main` all
  pass with the change. `npm run check:ts-max-loc` reports one pre-existing, unrelated ratchet violation
  on `src/main/cli/adapters/acp-cli-adapter.ts` (a file this fix never touches, already modified by
  concurrent work in this shared tree).
- **Not live-verified**: this campaign's constraints forbid restarting or interacting with the packaged
  app (pid 38865), and reproducing a real macOS lock-screen event against an isolated CDP-driven dev app
  was judged not worth the risk of colliding with `powerMonitor` state shared process-wide. The fix is
  therefore verified by targeted regression test and static trace to the wiring, not by watching a real
  lock-screen period stop logging stalls in a running app.

### Acceptance

- No `RendererHeartbeat` "stalled"/"recovered" log pair should be emitted for a beat gap caused solely by
  a `lock-screen`/`suspend` period.
- A genuine renderer freeze while the screen is unlocked and the window is visible must still log
  normally (regression-tested; not weakened by this fix).
- Live confirmation (not part of this fix): after the next real screen-lock/unlock cycle on the packaged
  app once it is next rebuilt and restarted through the normal release path, `app.log` should show no new
  `RendererHeartbeat` "stalled" entries whose timing correlates with a `lock-screen` event.

### Attempted live verification — 2026-08-19 (orchestrator): still NOT verified, and the obvious evidence is a trap

James rebuilt and restarted the app on 2026-08-19 (app.asar 01:39). The tempting check is a
before/after count of `RendererHeartbeat` error lines in the production `app.log`:

| Window | "Renderer heartbeat stalled" lines |
| --- | --- |
| Before the 01:39 rebuild | **2219** |
| After the 01:39 rebuild | **0** |

with 2353 other log lines after the rebuild, so the log is demonstrably still being written. Read
naively that looks like a clean confirmation.

**It is not, and it should not be recorded as one.** Checking *when* the stalls actually stopped:

```
first stall: 2026-08-15 11:22
last  stall: 2026-08-18 03:59        ← ~21 hours BEFORE the fix shipped
span: 64 hours, 2219 stalls, ~34/hour
```

The symptom stopped on **2026-08-18 at 03:59**, roughly 21 hours before the rebuilt build was
installed, and across at least one intervening app restart on the *old* code. So the absence of stalls
after the rebuild cannot be attributed to the fix — the triggering condition (a lock-screen / idle
period) simply has not recurred, or something unrelated changed. Attributing it to the fix would be a
confident wrong conclusion drawn from a real number.

**Status therefore unchanged: fixed and regression-tested, NOT live-verified.**

**The actual test**, which takes about five minutes: with the current build running, lock the screen
(or leave the display asleep) for ~5 minutes, unlock, then count `RendererHeartbeat` error lines with
timestamps inside that window. At the pre-fix rate of ~34/hour this would have produced a handful of
pairs; the fix predicts **zero**, with any genuine stall still logged. Until a lock period has actually
elapsed on this build, there is nothing to measure.

## LT-146: Antigravity instances silently ignore their configured working directory

[Read the detail](livetest-remediation-register-archive-2026.md#lt-146-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-146-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-146-archived-detail).

### Required fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-146-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-146-archived-detail).

## LT-167: `checkCodexCliAuthentication` misclassifies a signed-out Codex CLI as authenticated

[Read the detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-167-archived-detail).

## LT-147: the context-evidence provider kill switch does not stop capture for instances already running

**Current status (2026-08-31): FIXED IN CODE; LIVE RE-CHECK PENDING.** Raw and parsed tool-result
capture now resolve the provider's current configured mode for every capture. A change to `off`
takes effect immediately even when the running instance retains a spawn-time `shadow` mode. A
failing-first processor regression test covers both ingress paths; the rebuilt-app check remains
pending.

The material below preserves the original live evidence and root-cause analysis.

**Found:** 2026-08-18, running check 8 ("Provider kill-switch rollback") of the provider-agnostic
context-evidence live test.
**Source evidence:** isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchC`, port 9453), instance
`ij3dt15ja`, `provider: 'grok'`.

### Observed behaviour

1. `contextEvidenceModeByProvider.grok` set to `shadow`. Created a fresh grok instance, sent a turn
   ("Read notes.txt and quote its exact contents back to me."). One real evidence record was captured
   (`byteCount: 16`, `captureCompleteness: "complete"`) and was confirmed readable via
   `contextEvidenceList`.
2. `contextEvidenceModeByProvider.grok` set to `off` — **without** terminating or restarting the
   instance.
3. Confirmed the already-captured record was still readable (correct — matches the check's "already
   captured evidence remains readable" expectation).
4. Sent a **second** turn on the same, still-alive instance ("Read package.json..."). The instance's own
   `contextEvidence.mode` field still read `"shadow"` after the setting flip, and a **second, new,
   real, non-empty evidence record** was captured for this post-kill-switch turn (`byteCount: 20`).
   Pre-feature ("provider-visible output inline, nothing captured") behaviour was **not** restored for
   this conversation.

### Root cause

`initializeInstanceEvidenceOwnership()` (`src/main/context-evidence/evidence-conversation-resolver.ts:234-270`)
reads `contextEvidenceModeByProvider` once and writes the resolved mode onto
`instance.contextEvidence.mode`. It has exactly three call sites, all in `instance-lifecycle.ts`
(lines 1419, 1939, 2548) — initial spawn and respawn-shaped lifecycle transitions. Nothing re-invokes
it, or re-reads the live setting, per turn. So a running instance's context-evidence mode is fixed for
its entire lifetime (or until its next respawn — a yolo toggle, model swap, crash-recovery, etc.),
regardless of later setting changes.

This directly contradicts the setting's own declared policy metadata:
`contextEvidenceModeByProvider: readOnly(false, contextEvidenceModeByProviderSchema)`
(`settings-control-policy.ts:273`) — the first argument is `restartRequired`, asserting `false`, i.e.
the setting takes effect without any restart. That is true only for instances created *after* the
change; it is false for every conversation already in progress, which is exactly the kill-switch
scenario check 8 describes.

### Impact

A user who discovers a problem with context-evidence capture (e.g. sensitive tool output being
persisted to encrypted evidence storage) and flips the provider to `off`, expecting an immediate stop,
does not get one for any session already using it — capture continues silently on every subsequent
turn until that instance happens to respawn.

### Required fix

Either (a) re-resolve `contextEvidenceModeByProvider` per turn (or at least react to a live
`settings:changed` event and update `instance.contextEvidence.mode` in place for running instances), or
(b) if per-instance stickiness for the conversation's duration is intentional, correct the setting's
`restartRequired` metadata to `true` and surface a "takes effect on next session" notice in the
Settings UI so the kill-switch semantics are honestly represented. Not fixed here — which of the two is
correct is a product decision (immediate kill switch vs. documented per-conversation stickiness), not
mine to make unilaterally.

### Acceptance

- Either: flipping a provider to `off` mid-conversation stops new evidence capture on that instance's
  very next turn, with a regression test asserting no new `contextEvidenceList` record appears after
  the flip; or: the setting is documented and surfaced as taking effect only for new sessions, and
  `restartRequired` is corrected to reflect that.
- Already-captured evidence remains readable regardless of the chosen fix (already true today).

## LT-136: checkpoint timeline mislabels every checkpoint "Auto" and drops its name

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

### Symptom

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-136-archived-detail).

## LT-168: Auth-repair auto-resume can never revive a still-live errored instance — `target_missing` forever

**Found:** 2026-08-18, driving in-session-auth-repair check 4 (auto-resume) in an isolated dev app,
immediately after fixing LT-167 (whose fix is a genuine prerequisite — without it the block never
attaches at all, so this defect was unreachable until now).
**Source evidence:** dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchU-authtest`, port 9457,
`HOME=/tmp/aio-lt-batchU-fakehome`), instance `x9kc3z0ec`, provider `codex`.

### Observed behaviour

With the LT-167 fix live, a real Codex turn genuinely failed auth (`401 Unauthorized`), and the
auth-repair block correctly attached (`"Session blocked on provider auth; watching for sign-in",
"watched": true`). A valid `~/.codex/auth.json` was then copied into the same disposable fake `HOME`
to produce a genuine, real sign-in the background watch could detect — confirmed independently with a
direct shell probe under the identical `HOME` (`codex login status` → `Logged in using ChatGPT`).

The background watch (`InstanceAuthRepairHandler.startWatch`, polling every
`AUTH_RECHECK_INTERVAL_MS` = 10s) correctly detected the sign-in every single cycle — the probe
itself is not the problem. But every `revive()` attempt failed identically:

```
{"subsystem":"InstanceManager","message":"Auth-repair revival failed",
 "data":{"instanceId":"x9kc3z0ec","failureCode":"target_missing"}}
{"subsystem":"InstanceAuthRepairHandler",
 "message":"Auth restored but the session could not be revived; keeping the repair banner"}
```

This repeated identically on **9 consecutive retries over more than 90 seconds** with zero change in
outcome — not a transient race that eventually resolves. The banner is left in a permanent
"keeping the repair banner" limbo: the doc's check 4 ("wait up to ~10 seconds… the session is
revived, and the turn that failed is re-sent automatically") cannot pass as specified, no matter how
long the user waits.

### Root cause

The auth-repair `revive` callback (`instance-manager.ts:475-494`) delegates entirely to
`SessionRevivalService.revive()` — the same service used for waking a *dormant/archived* automation
thread (`reason: 'thread-wakeup'`) and for restoring an *archived* history entry. That service's
`findLiveInstance()` explicitly excludes `'error'`-status instances from "live"
(`NOT_LIVE_STATUSES` in `session-revival-service.ts:33-40` includes `'error'`), so it always falls
through to `resolveHistoryEntryId()`, which looks the instance up in **archived history**
(`history().getEntries()`). But an instance that merely transitioned to `'error'` after a failed
turn — the exact state `reportAuthFailureTurn`/`maybeBlockOnAuth` leave it in — is never explicitly
terminated or archived; it just sits in the live instance map with `status: 'error'`. No archive
entry for it exists, so `resolveHistoryEntryId()` always returns `undefined` and `revive()` always
returns `{ status: 'failed', failureCode: 'target_missing' }`.

This is provider-agnostic and not specific to the Codex approximation used to find it: any provider
whose auth-repair block leaves the instance in plain `'error'` (rather than an explicitly
archived/terminated one) will hit the identical `target_missing` wall, every time, because the
callsite reuses a request shape (`reason: 'thread-wakeup'`, only `instanceId` + `reviveIfArchived`)
built for a different, already-archived kind of target.

### Impact

Check 4's entire premise — the auth-repair banner resolving itself once the user signs back in,
without the user needing to do anything else — cannot work as implemented. The banner and its manual
"Retry now"/"Dismiss" levers (checks 3, 5, 6, all independently verified working in this same
session) remain the only functional part of the feature; the auto-resume half is silently dead.

### Implemented fix — 2026-08-31

The auth-repair callback now calls `InstanceManager.restartInstance()` for the same instance id.
That is the existing in-place primitive for a live instance whose adapter must be recreated, and it
preserves native provider-session resume without changing `SessionRevivalService`'s archived-thread
contract. After restart, auth repair replays the exact already-resolved failed turn directly through
`InstanceCommunicationManager`, preserving attachments and the original context block without
running slash-command or context resolution twice.

The watcher permits one automatic restart/replay per auth block. If either step fails, it restores
the `auth-required` hold after restart's normal hold cleanup and leaves the banner in manual-retry
mode. This removes the original endless 10-second retry loop and prevents a new restart loop.

Focused regression coverage is green (207 tests across the direct and spawn-worker Claude adapters,
auth repair, communication, lifecycle restart, and CLI detection). Both TypeScript checks, lint,
the TypeScript size ratchet, and `build:main` pass. The full suite's scoped tests pass; the repository
wide run is currently blocked only by six failures in an unrelated, concurrently modified
session-recovery workstream. A rebuilt real sign-out/sign-in re-check remains in the owning livetest.

### Acceptance

- With a real (or equivalently isolated) provider sign-in completed while an instance is blocked on
  `auth-required`, the background watch's next cycle successfully revives the *same conceptual*
  session (not a fresh, empty one) and re-sends the turn that failed, within one watch interval.
- No regression to `SessionRevivalService`'s existing archived-history-restore or thread-wakeup
  callers.

## LT-160: `instance.waitReason` never reaches the canonical main-process Instance object

[Read the detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail).

### Required fix (implemented)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail).

### Fix — 2026-08-18

[Read the detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-160-archived-detail).

## LT-181: a genuine race lets the pre-queue "already has an active turn" error back into the transcript

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

### Fix — 2026-08-18

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

### Completion-gate finding — the first fix was asymmetric, 2026-08-18

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-181-archived-detail).

## LT-148: the Codex context-pressure diagnostics classifier miscounts the user's own turn echo as a tool-bearing item

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

### Verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-148-archived-detail).

## LT-161: `deserializeInstance()` silently drops wire fields — `failoverProviders` plus four more found in a completeness pass

[Read the detail](livetest-remediation-register-archive-2026.md#lt-161-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-161-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-161-archived-detail).

### Fix — 2026-08-18

[Read the detail](livetest-remediation-register-archive-2026.md#lt-161-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-161-archived-detail).

## LT-192: calendar mutation approval requested before checking the target account can possibly succeed

### Observed behavior

`OrchestratorToolsRpcServer.handleRequest()`'s shared case for `graph_calendar_connect`,
`graph_calendar_create_event`, `graph_calendar_update_event`, and `graph_calendar_delete_event`
(`src/main/mcp/orchestrator-tools-rpc-server.ts`) `await`ed `authorizeCalendarMutation(...)` — a
blocking human approval routed through `PermissionRegistry` — and only afterward dispatched to the
real tool handler in `src/main/mcp/orchestrator-calendar-tools.ts`, where the actual precondition
lives: `requireWritableAccountKey()` (create/update/delete) throws `Calendar mutation is not
permitted for agent calendar mutations: <requested>` when the target account is absent from
`listAccounts()` or not on the agent-writable allow-list.

Live-checked via `graph_calendar_status` on this machine: `{"accounts":[]}` — zero connected
Microsoft accounts. Another agent's `graph_calendar_create_event` call blocked on an operator
approval nobody could answer and timed out client-side with no side effect — exactly the failure
mode this defect predicts: a human (or an unattended caller) can be asked to approve, and made to
wait out the full 5-minute approval window for, a mutation that was always going to fail once
approved.

`graph_calendar_connect` sits in the same case group but is not part of the defect: connecting is
how an account is created, so it legitimately runs with zero accounts, and must remain callable
that way.

### Root cause

The RPC layer's approval gate and the tool layer's account precondition are two independent checks
with no ordering contract between them; the dispatcher always ran approval first regardless of
whether the mutation could possibly succeed. `graph_calendar_list_accounts` and
`graph_calendar_status` are already ungated and return the same account list `requireWritableAccountKey`
would consult, so front-loading the account check leaks no information an unapproved caller could
not already read.

### Required behavior

`graph_calendar_create_event`, `graph_calendar_update_event`, and `graph_calendar_delete_event` must
validate that their target account exists and is agent-writable *before* requesting human approval,
so approval is never requested for (and no caller ever blocks on) a mutation guaranteed to fail.
`graph_calendar_connect` must be unaffected and continue to reach approval with zero connected
accounts.

### Fix — 2026-08-18

Added `assertCalendarMutationAccountPrecondition()` and `dispatchCalendarMutation()` to
`src/main/mcp/orchestrator-tools-rpc-calendar.ts`. `assertCalendarMutationAccountPrecondition()`
returns immediately for `graph_calendar_connect`; for the three mutating methods it extracts
`payload.account` and calls the newly-exported `requireWritableAccountKey()` from
`src/main/mcp/orchestrator-calendar-tools.ts` (previously module-private), reusing the exact same
account-resolution logic and error messages the tool handler already used post-approval, so nothing
about the already-approved path's behavior or error text changes. `dispatchCalendarMutation()` wraps
this precondition, the existing `authorizeCalendarMutation` approval call, and the final
`dispatchSameNameTool` call into one shared function, generic over the RPC method's literal type so
the exact `CalendarMutationAuthorizationRequest['method']` union is preserved through the call
without the RPC server needing to duplicate it.

`src/main/mcp/orchestrator-tools-rpc-server.ts`'s shared calendar-mutation case now calls
`dispatchCalendarMutation(...)` once instead of inlining the precondition/approval/dispatch
sequence — kept deliberately thin (a single call site) per the layering concern that the RPC server
should not grow direct knowledge of Graph account-resolution internals; that knowledge now lives
entirely beside the other calendar RPC glue in `orchestrator-tools-rpc-calendar.ts`. This also kept
the file's net line growth to +3 lines total (a net-negative case-block rewrite offset by one import
line) so `npm run check:ts-max-loc` still reports the file only as an existing informational notice
(47 over its 710 ceiling, within the standing +50 tolerance), not a new ratchet violation — no
ceiling was changed.

New regression tests in `src/main/mcp/orchestrator-tools-rpc-server.spec.ts`:
- `it.each` "LT-192: … fails fast on an unconnected account without requesting operator approval"
  for create/update/delete: asserts `authorizeCalendarMutation` is never called and the underlying
  tool handler is never called, with the real `Calendar mutation is not permitted for agent
  calendar mutations: <account>` error surfacing.
- "LT-192: graph_calendar_connect still reaches operator approval with zero connected accounts":
  asserts `authorizeCalendarMutation` IS called and the connect handler runs, with an empty
  `listAccounts()`.
- The pre-existing "requires fresh operator authorization before creating a calendar event" and
  "blocks … without fresh operator authorization" tests were updated to supply a writable calendar
  account (matching the default writable-account policy) so they continue to exercise the
  already-approved/denied paths rather than being accidentally short-circuited by the new
  precondition.

**Reverted the fix** (removed the `assertCalendarMutationAccountPrecondition` call from
`dispatchCalendarMutation`, in a `/tmp` copy first, then applied the same one-line removal in place)
and reran `orchestrator-tools-rpc-server.spec.ts` twice — once immediately after adding the
precondition inline in the RPC server, and again after refactoring it into
`dispatchCalendarMutation()`. Both times exactly the 3 new fail-fast tests failed, each with
`Error: promise resolved "undefined" instead of rejecting`, and no other test was affected. Restored
the fix both times and confirmed 67/67 pass across `orchestrator-tools-rpc-server.spec.ts`,
`orchestrator-calendar-tools.spec.ts`, and `orchestrator-tools-step.spec.ts`.

**Regression scope checked:** `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` clean;
`npm run lint` clean; `npm run check:ts-max-loc` clean (no new violation; `orchestrator-tools-rpc-server.ts`
unaffected ceiling-wise, `scripts/check-ts-max-loc.ts` untouched); `npm run build:main` clean.
Targeted suite `src/main/mcp/` green (all files touched plus the wider directory).

**Not live-verified against a real Graph mutation.** Doing so would require either connecting a real
Microsoft account (out of scope — `graph_calendar_connect` opens interactive OAuth, explicitly
excluded from this check) or reproducing the exact production zero-account state against a live,
approval-answering operator, which this session could not safely do without risking a real approval
prompt or a real calendar write. The source-level precondition ordering and the regression tests
above are the verification evidence for this item.

### Completion-gate finding — 2026-08-18 (fixed)

An independent completion gate reviewed the merge-base-to-HEAD diff and found a real regression in
the first-pass fix, at `src/main/mcp/orchestrator-tools-rpc-calendar.ts:60`:

```ts
const requestedAccount = typeof payload['account'] === 'string' ? payload['account'] : '';
```

This compared the **raw, untrimmed** payload value against `listAccounts()` results inside
`requireWritableAccountKey()`. The real, downstream handler instead receives `parsed.account`,
produced by `AccountSchema = z.string().trim().min(1).max(320)`
(`orchestrator-calendar-tools.ts:5`) — Zod trims it before the handler resolves the account. The
fast-fail precondition and the real resolution were therefore not identical, which is exactly the
property this fix was supposed to guarantee.

**Concrete regression:** a `graph_calendar_create_event` call with
`payload.account = "james@communitytech.co.uk "` (trailing space — plausible from an LLM-composed
tool call, a copy-pasted address, or a templated string) succeeded before this session's change
(Zod trimmed it, the account matched, the mutation went through). After the first-pass fix, the
precondition compared the untrimmed string, matched nothing, and threw `Calendar mutation is not
permitted for agent calendar mutations: james@communitytech.co.uk ` before approval was even
requested — a false rejection of a legitimate, connected, writable account, which would have bitten
James the moment he connects his own calendar account.

**Structural fix (not a bare `.trim()`):** exported `AccountSchema` from
`orchestrator-calendar-tools.ts` and added `extractRequestedAccount()` to
`orchestrator-tools-rpc-calendar.ts`, which normalizes a raw payload's `account` field via
`AccountSchema.safeParse(...)` — the exact same schema instance the real handler's own payload
schema (`CalendarCreateEventToolArgsSchema` etc.) already applies to this field. Both
`assertCalendarMutationAccountPrecondition()` and the real handler's resolution now derive the
requested account from the same schema object, so the two normalization rules cannot drift apart
again — one predicate, not a hand-duplicated rule in two places.

New regression test in `orchestrator-tools-rpc-server.spec.ts`: "LT-192: reaches operator approval
for a whitespace-padded account, matching Zod's trim normalization" — calls
`graph_calendar_create_event` with `account: '  james@communitytech.co.uk  '` against a writable
calendar account and asserts `authorizeCalendarMutation` IS called (the precondition did not
reject it) with the original, unmodified payload forwarded to the tool handler, exactly matching
the unpadded case. **Reverted the normalization** (restored the hand-rolled, non-trimming
`extractRequestedAccount()`, in a `/tmp` copy first) and reran: the new test failed, and only that
test, with:

```
Error: Calendar mutation is not permitted for agent calendar mutations:   james@communitytech.co.uk
    at requireWritableAccountKey (orchestrator-calendar-tools.ts:423:11)
    at assertCalendarMutationAccountPrecondition (orchestrator-tools-rpc-calendar.ts:78:3)
    at dispatchCalendarMutation (orchestrator-tools-rpc-calendar.ts:98:3)
```

— the exact false-rejection the gate predicted, reproduced on demand. Restored the fix and
confirmed 68/68 pass across `orchestrator-tools-rpc-server.spec.ts`, `orchestrator-calendar-tools.spec.ts`,
and `orchestrator-tools-step.spec.ts`. Re-ran the full gate set post-fix: `tsc` ×2, `ng lint`,
`check:ts-max-loc` (still no new violation; `scripts/check-ts-max-loc.ts` still has zero diff from
HEAD), `build:main` — all clean.

No other Zod transform applies to `AccountSchema` beyond `.trim()` (no case-folding, no other
normalization), so trimming was the only gap to close; `requireWritableAccountKey`'s own
`username.toLowerCase()` comparison already handled case-insensitivity independently of this
extraction.

### Acceptance

- `graph_calendar_create_event`, `graph_calendar_update_event`, `graph_calendar_delete_event` must
  reject a request whose target account is not connected or not agent-writable *before* calling
  `authorizeCalendarMutation`, with the same error text `requireWritableAccountKey()` already
  produced post-approval.
- `graph_calendar_connect` must continue to reach `authorizeCalendarMutation` regardless of how many
  accounts are currently connected, including zero.
- The already-approved and already-denied mutation paths are unchanged in behavior and error text.
- No new `npm run check:ts-max-loc` violation, and no ceiling was raised to accommodate the fix.
- The RPC-layer precondition and the real handler's account resolution must derive the requested account from the same normalization rule (currently `AccountSchema`), so a whitespace-padded but otherwise valid, connected, writable account is never falsely rejected by the precondition.

## LT-188: manual "Compact Now" races its own auto-compact trigger, producing duplicate compactions and duplicate fallback proposals

### Observed behavior

Driving checks 3/4 of the Local AI Guard live test (`2026-07-26-local-ai-guard_plan_livetest_completed.md`)
against a real `claude` instance whose `outputBuffer` had been grown past the 0.85 `triggerThreshold`
(via large user pastes), a single `compactInstance({instanceId})` IPC call — the app's "Compact Now"
action — consistently logged **two** `[ContextCompactor] Compaction started` entries, at different
`originalTokens`/`fillRatio` values, e.g.:

```
[ContextCompactor] Compaction started { originalTokens: 174819, turnCount: 3, fillRatio: 0.874095 }
[ContextCompactor] Compaction started { originalTokens: 227669, turnCount: 6, fillRatio: 1.138345 }
```

Under the target's `require-confirmation` fallback policy, this was directly observable as **two**
independent pending paid-fallback approval requests (`localAiGuardListPendingFallbacks()` returned 2
entries) for what the user experienced as one "Compact Now" click — one request's `routingEventId`
matched the compaction the IPC caller actually awaited and received a result for; the second request
was created roughly 50 seconds later, well after the `compactInstance()` promise had already resolved
and returned control to the caller, and was never resolved by anything the caller did. Both had to be
resolved separately via `localAiGuardResolveFallback` before the pending queue was empty.

On at least one attempt with the `notify-and-allow` policy, this race went the other way: the
duplicate/racing internal compaction appears to have overwritten or otherwise interfered with the
outer one's state before it reached `generateSummary()`, and the manual compaction completed
(`success: true`) with **no** Local AI Guard routing event created at all for that call — the
compression slot's fallback machinery was silently never exercised, even though `shouldCompact()` was
true for both the inner and outer calls.

### Root cause

`ContextCompactor` is a process-wide singleton (`ContextCompactor.getInstance()`), and its
`addTurn()` unconditionally checks `this.config.autoCompact && this.shouldCompact() &&
!this.compactionInProgress` after every single turn is added, firing an **un-awaited**
`this.compact()` the moment `fillRatio` crosses `triggerThreshold`
(`src/main/context/context-compactor.ts:216-224`).

`CompactionRuntime.restartCompact()` (`src/main/app/compaction-runtime.ts`) — the strategy behind
manual "Compact Now" for any provider without native compaction support (Claude among them, since
`nativeCompact()` returns `false` when the adapter has no `compactContext()` method) — calls
`compactor.clear()` and then rebuilds the *entire* transcript via a loop of `compactor.addTurn(turn)`
calls sourced from `instance.outputBuffer`, before making its own **unconditional**
`await compactor.compact(...)` call once the loop finishes. On a transcript large enough to cross
`triggerThreshold` mid-loop (true for realistically any transcript that actually needs compacting),
the loop itself triggers `addTurn()`'s own auto-compact **inside** `restartCompact()`, and that
auto-triggered `compact()` runs **concurrently** with the loop's own subsequent turns being added and
with the explicit `compact()` call that follows — both operating on the same mutable `this.state`
(`turns`, `summaries`, `totalTokens`) with no coordination between them. `compactionInProgress` only
guards the auto-trigger against *itself* re-firing; it does nothing to stop the manual caller's own
explicit `compact()` from running at the same time.

### Required behavior

A single manual "Compact Now" action must produce exactly one compaction attempt and, if it needs the
compression role, exactly one Local AI Guard routing event/fallback proposal — never zero (silently
skipped) and never two (duplicate proposals, potentially duplicate real paid-provider charges once a
real frontier key is configured). `restartCompact()`'s turn-rebuild loop must not be able to trigger
an independent, uncoordinated background compaction on the same singleton state it is itself about to
compact explicitly.

### Fix

Not implemented this session — needs design, not a one-line patch. Plausible directions worth
weighing: (a) have `restartCompact()` suspend `autoCompact` on the shared `ContextCompactor` for the
duration of its own rebuild-and-compact sequence (`updateConfig({autoCompact: false})` around the
loop, restored after), (b) make `addTurn()`'s auto-trigger check a re-entrancy guard that also covers
an in-flight *caller-driven* `compact()`, not just its own async trigger, or (c) stop rebuilding the
whole transcript through the turn-by-turn `addTurn()` API for a manual restart and instead seed
`ContextCompactor`'s state directly, bypassing the per-turn auto-compact check entirely. Whichever
direction is chosen should include a regression test that reproduces the duplicate-routing-event (or
race-with-no-routing-event) behavior on a revert before trusting the fix.

## LT-189: `notify-and-allow` fallback policy has no notification/banner delivery anywhere

**Current status (2026-09-23): RESTORED IN CODE; rebuilt-app check pending.** The passive banner passed a live run on 2026-08-21, was later removed, and has been restored on James's decision. The historical root cause and live evidence below describe the earlier builds; the restored build still needs its own check.

### Observed behavior

With a Local AI Guard target's `fallbackPolicy` set to `notify-and-allow` and its endpoint made
unavailable, several real `compression`-slot paid fallbacks were triggered and correctly recorded as
`disposition: allowed, actual_route: frontier` in `local_ai_routing_events`. The renderer was watched
live (focus-emulated, not occluded) through each of these — no banner, toast, system notification, or
any other observable signal appeared. The only visible change was the Local AI Guard effectiveness
dashboard's counters updating on its own normal poll/delta cycle.

### Root cause

`LocalAiRoutingGuard.authorizeFallback()`'s `notify-and-allow` branch calls `this.notify(event)`
(`src/main/local-ai-guard/local-ai-routing-guard.ts`), which does
`this.dependencies.notifyFallback?.(event)` — but the interface's `notifyFallback` field is optional,
and the only production construction site,
`new LocalAiRoutingGuard({...})` in `src/main/local-ai-guard/local-ai-runtime.ts`, never supplies it.
The call is therefore always a no-op in the running app. Separately, the renderer's only
fallback-facing component, `local-ai-fallback-banner.component.ts`, renders exclusively from
`store.oldestPending()` — the `require-confirmation` decision queue — which a `notify-and-allow` event
never enters (it resolves synchronously, with no pending request created). No other renderer
component, toast service, or OS notification call references Local AI Guard fallback events at all
(grepped the renderer for `notif`/`banner`/`toast` under `features/local-ai-guard/` — only the one
decision-banner component exists).

### Required behavior

A `notify-and-allow` fallback should produce *some* user-observable signal distinguishable from
silence — the policy's own name promises a notification, not just a silent allow. What form that
takes (a toast, a passive/dismissable banner distinct from the `require-confirmation` decision banner,
an OS notification, or a deliberate decision that the effectiveness dashboard alone is sufficient and
the policy name is just historically imprecise) is a product decision, not something this session
should decide unilaterally.

### Fix

**FIXED, 2026-08-21 (implemented by a separate, uncommitted session; live-verified by Batch Q2, not
authored by it).** The product decision above resolved to a passive, dismissible banner distinct from
the `require-confirmation` decision banner. `notifyFallbackInto()` (`local-ai-guard/local-ai-runtime.ts:183`)
builds the `notifyFallback` dependency and is now wired at the production `LocalAiRoutingGuard`
construction site (`local-ai-runtime.ts:282`): `notifyFallback: notifyFallbackInto(() => runtime)`. It
calls `runtime.recordFallbackNotification(event)`, which appends to a bounded, most-recent-first
`fallbackNotifications` list surfaced through `LocalAiGuardSnapshot.fallbackNotifications`
(`local-ai-guard.schemas.ts:619`, capped at 50) and the renderer's `LocalAiGuardStore` (client-side
`_dismissedFallbackNotificationIds` set, `dismissFallbackNotification()`). The renderer
(`local-ai-fallback-banner.component.ts`) gained a second `.local-ai-fallback-notifications` section,
mounted globally via `app.component.html`, rendering each undismissed notification with slot label,
token estimate, cost estimate (or "Cost unknown" when unpriceable) and a `Dismiss` button.

**Batch Q2's live verification (2026-08-21):** rebuilt `dist/main` from the current (uncommitted)
source, launched an isolated dev app, and drove a real `notify-and-allow` fallback via the
`titleGeneration` slot (cheaper substitute for the compression-slot repro above — `authorizeFallback()`
reaches `this.notify(event)` identically regardless of which slot or policy source triggers
`notify-and-allow`, see `local-ai-routing-guard.ts:183-188`). Confirmed via
`localAiGuardGetSnapshot()` that a real `fallbackNotifications` entry was recorded, confirmed via the
real DOM (CDP + focus emulation, not a stale zoneless signal) that the banner rendered ("Paid fallback
happened automatically · Title generation · Cost unknown · Dismiss"), and confirmed a real click on
`Dismiss` removed it. Full detail:
[Local AI Guard livetest, evidence run 2026-08-21](../superpowers/plans/2026-07-26-local-ai-guard_plan_livetest_completed.md#evidence-run--2026-08-21-batch-q2--lt-189-confirmed-fixed-and-live-end-to-end-backend--renderer-checks-25-re-confirmed-blocked-reasoning-unchanged).
No dedicated unit/regression test for this fix was found or written by Batch Q2 — the fix's own test
coverage (if any) was authored elsewhere and not reviewed here; this section only records live,
behavioral verification.

## LT-190: Local AI Guard fallback cost estimation silently returns nothing for any real `defaultCli` value

### Observed behavior

With `settings.defaultCli` set to `'claude'` (an ordinary, real setting value — not an edge case),
several real `compression`-slot Local AI Guard fallback routing events persisted correctly with
`provider: 'claude', model: 'opus[1m]'`, but `estimated_cost_usd` was `NULL` on every one of them,
despite `opus[1m]` (`CLAUDE_MODELS.OPUS_1M`) having a real, priced entry in `MODEL_PRICING`
(`{input: 5.0, output: 25.0}`) and being listed under `PROVIDER_MODEL_LIST.claude`.

### Root cause

`LocalAiRoutingGuard.authorizeFallback()`'s pre-authorization cost estimate comes from
`resolveFallbackModel()` (`src/main/local-ai-guard/local-ai-runtime.ts`), which returns
`{ provider: settings.defaultCli, model: ... }` — i.e. the CLI-facing provider id (`'claude'`,
`'codex'`, `'gemini'`, ...), the same namespace `PROVIDER_MODEL_LIST` is keyed by. That value is fed
straight into `computeProviderTokenCost()` → `getProviderModelRate()` →
`normalizePricingProvider()` (`src/shared/data/model-pricing.ts`), whose `switch` only recognized the
*upstream vendor* names — `'anthropic'` → `'claude'`, `'openai'` → `'codex'`, `'google'` → `'gemini'`
— and returned `undefined` for anything else, including `'claude'` itself (never one of the three
recognized cases). `getProviderModelRate()` short-circuits to `undefined` whenever
`normalizedProvider` is falsy, so the rate lookup — and therefore the entire cost estimate — silently
disappeared for every caller passing an already-CLI-style id, which `resolveFallbackModel()` always
does. This affects only the *pre-call* estimate; the separate, correctly-wired *post-call* "known
cost" path (`applyLocalAiRoutingCostAttribution()`, fed by `record.provider` values like `'anthropic'`
from `llm-service.ts`'s real Anthropic/OpenAI completions) was unaffected, since it always passes true
vendor names.

### Required behavior

`computeProviderTokenCost()`/`getProviderModelRate()` must resolve a rate for a provider id in either
of the two namespaces callers legitimately use: the CLI-facing ids (`'claude'`, `'codex'`, `'gemini'`,
...) and the upstream vendor names (`'anthropic'`, `'openai'`, `'google'`) — both already exist as
real call sites in this codebase.

### Fix — 2026-08-18

Added a `CLI_PROVIDER_KEYS` set derived from `Object.keys(PROVIDER_MODEL_LIST)` and checked it first
in `normalizePricingProvider()`: an already-canonical CLI-style id now passes through as an identity
match before falling back to the existing vendor-name switch. Since none of `'anthropic'`/`'openai'`/
`'google'` collide with a `PROVIDER_MODEL_LIST` key, the existing vendor-name behavior (and the
existing `getProviderModelRate('unknown', ...)` → `undefined` test) is unaffected.

Regression coverage: `src/shared/data/model-pricing.spec.ts`, new `describe('getProviderModelRate
provider-id aliasing (LT-190)')` block — 3 tests: an already-CLI-style id (`'claude'` +
`CLAUDE_MODELS.OPUS_1M`) resolves correctly through both `getProviderModelRate` and
`computeProviderTokenCost`, the upstream vendor-name spelling still resolves for both Anthropic and
OpenAI, and a provider that is neither a CLI id nor a known vendor name is still rejected. Reverted
the fix in an isolated copy first and watched the first test fail with `expected undefined to deeply
equal { input: 5, output: 25 }`; restored and confirmed all 19 tests in the file pass.

Live-verified end to end after rebuilding `dist/main` and restarting the dev app on the same profile:
the next two real `compression`-slot fallback routing events persisted `estimated_cost_usd: 0.38982`
and `0.5037` respectively (correctly computed from the real 57,484- and 80,260-token estimates against
`opus[1m]`'s $5/$25-per-1M rate), where every prior event in the same session had `NULL`.

Gates green: `tsc --noEmit` ×2, `ng lint`, `build:main`; `check:ts-max-loc` unaffected (one pre-existing
unrelated violation in `mobile-gateway-server.ts` from other concurrent work, not touched by this fix).
Targeted `model-pricing.spec.ts` suite green (19/19).

### Completion-gate finding — 2026-08-18: the fix's own widening was itself unsafe

An independent completion gate confirmed the original defect, the repro, and the revert evidence
above, then found a **new** problem introduced by the fix itself: `CLI_PROVIDER_KEYS`'s
identity-passthrough widened `normalizePricingProvider()` to accept *any* `PROVIDER_MODEL_LIST` key,
but `getProviderModelRate()`'s static-table fallback (`MODEL_PRICING[normalizedModel]`) is a **flat
map keyed by raw model id, not namespaced by provider** — only the live overlay (`providerOverlayRates`,
keyed `${provider}:${id}`) is namespaced. `PROVIDER_MODEL_LIST.copilot` and `.cursor` reuse the exact
same raw id strings as the primary vendors they proxy for pass-through models:
`COPILOT_MODELS.CLAUDE_OPUS_5 === CLAUDE_PINNED_MODELS.OPUS_5 === 'claude-opus-5'`;
`COPILOT_MODELS.GPT53_CODEX === OPENAI_MODELS.GPT53_CODEX === 'gpt-5.3-codex'` (also reused verbatim
in Cursor's curated list); `COPILOT_MODELS.GEMINI_3_1_PRO` literally aliases
`GOOGLE_MODELS.GEMINI_3_1_PRO`. So on the fixed tree, `getProviderModelRate('copilot',
'claude-opus-5')` returned `{input: 5, output: 25}` — Anthropic's direct API rate — instead of the
pre-fix `undefined`. Before the fix this was a silent zero; after it, a **confidently wrong,
non-zero number**, which is worse: `resolveFallbackModel()` legitimately returns
`{provider: 'copilot', model: 'claude-opus-5'}` for a Copilot-pinned default, that value flows
straight into the `estimatedCostUsd` recorded on the routing event and into the budget-ceiling
check (`local-ai-fallback-store.ts`'s `exceedsConfiguredCeiling()`), so a wrong rate there changes
whether a paid fallback is actually blocked.

Domain context surfaced by the gate: Copilot here is a **subscription seat** (James's EBRD-scoped
seat, deliberately excluded from automation provider-selection), not per-token billing — pricing its
usage at Anthropic's direct API rate is not merely imprecise, it is the wrong billing model. The same
applies to Cursor.

Checked what the gate asked before designing a fix:

- **Does `exceedsConfiguredCeiling()` already distinguish "unpriceable" from "priced at zero"?**
  Yes, and it already fails closed on unknown: `exceedsConfiguredCeiling(ceiling, estimate, spend)`
  (`local-ai-fallback-store.ts:267-273`) returns `true` (blocks) whenever `estimate === undefined`,
  *before* ever comparing it against the ceiling — an unpriceable estimate is already treated as
  worse than a merely-large one. `createRoutingEvent()` (`local-ai-routing-guard.ts:271`) only sets
  the `estimatedCostUsd` field when `input.estimate !== undefined` — an unpriceable model gets no
  key at all (not a `0`), so `undefined` reaches the ceiling check intact. The gate-reported bug
  therefore didn't just misprice a fallback, it *bypassed this existing fail-closed guard* by
  handing it a defined-but-wrong number instead of the `undefined` that would have tripped it.
- Confirmed `defaultCli === 'auto'` never reaches the normalizer (`local-ai-runtime.ts:232`'s
  `provider !== 'auto' && model ? {...} : undefined` guard), the legacy `'openai'` vendor-name alias
  still resolves, and `'ollama'` stays deliberately unpriced (`PROVIDER_MODEL_LIST.ollama` is `[]`,
  so the `.some(...)` membership check always fails regardless of the allowlist).

**Fix — 2026-08-18 (same day, addressing the gate finding):** Added an explicit
`STATIC_TABLE_PROVIDERS` allowlist (`new Set(['claude', 'codex', 'gemini', 'grok'])`) — the primary
vendors that actually own the raw-id space `MODEL_PRICING` is keyed by — and gated the static-table
fallback branch of `getProviderModelRate()` on membership in it, checked *after* the
provider-namespaced live-overlay lookup (which is safe and unaffected: a real per-provider rate for
`copilot`/`cursor` could still be registered there if one is ever known) and *before* the
`PROVIDER_MODEL_LIST` membership check. Deliberately an allowlist, not a denylist, per the gate's own
guidance, so a future provider added to `PROVIDER_MODEL_LIST` is unpriced by default rather than
silently inheriting whatever raw id it happens to share with an existing vendor.

Added the regression test the gate asked for, in the same `describe` block: "does not price a
reseller/proxy model at the primary vendor rate just because the raw id string collides" — asserts
`COPILOT_MODELS.CLAUDE_OPUS_5 === CLAUDE_PINNED_MODELS.OPUS_5` (the collision is real, not assumed),
then that `getProviderModelRate('copilot', COPILOT_MODELS.CLAUDE_OPUS_5)` is `undefined` and is
`not.toEqual` the real Claude rate; the same shape for the Codex-family id on both `copilot` and
`cursor`; that `computeProviderTokenCost` propagates `undefined` (never `0`) for the colliding case;
and that Cursor's `AUTO` sentinel is unpriced too (Cursor is excluded from the static table entirely,
not just for the one colliding id checked). Reverted the allowlist gate in a `/tmp` copy (never
`git stash`/`checkout --`/`restore`/`reset`/`clean`) and watched the new test fail with `expected
{ input: 5, output: 25 } to be undefined` — the exact aliasing bug — then restored and confirmed
20/20 tests pass in the file.

Re-ran all gates after the follow-up fix: `tsc --noEmit` ×2 clean, `ng lint` clean, `build:main`
clean, `check:ts-max-loc` unaffected (`model-pricing.ts` not flagged; the one pre-existing
`mobile-gateway-server.ts` violation is unrelated concurrent work). Targeted
`model-pricing.spec.ts` suite green, 20/20, read from the summary line (not exit code alone).

Sent back to a fresh completion gate.

**One related, pre-existing, out-of-scope observation:** `getModelRate(model)` — the
provider-agnostic sibling used by `computeTokenCost()`/`CostTracker` elsewhere — resolves purely by
raw model id with no provider disambiguation at all, so it has the same theoretical id-collision
exposure this gate finding describes. It was not touched by either LT-190 change (before or after
today) and is a different call path (real cost accounting from a provider's own reported usage, not
a pre-authorization estimate), so fixing it was out of scope here — flagged for whoever next touches
that function, not fixed.


## LT-193: Unpriced fallback dispatches display as `$0` rather than unknown

**Observed behaviour.** A Local AI Guard fallback dispatch whose token cost cannot be priced
contributes `0` to the incident and effectiveness dollar totals shown in the UI, so a run of
genuinely unpriceable dispatches reads as "this cost nothing" rather than "this cost is unknown".

**Root cause.** `addAccountingCost()` (`src/main/local-ai-guard/local-ai-row-mappers.ts:655-659`)
folds a routing event into an incident with `const total = current + (incoming ?? 0)`. The
destination field `LocalAiIncident.estimatedCostUsd` is a required, non-nullable `number`
(`src/shared/types/local-ai-guard.types.ts:217,311`), so there is nowhere for "unknown" to live and
the `?? 0` is forced. The value is then rendered as a dollar figure directly in
`local-ai-target-card.component.ts:479`, `local-ai-incident-panel.component.ts:295-296` and
`local-ai-effectiveness-panel.component.html:71`.

**Why this is not the same bug as LT-190, and not a regression from it.**
`local-ai-row-mappers.ts` was untouched by the LT-190 fix. Before LT-190, essentially *every*
fallback event was undefined-cost, so this collapse already applied to all providers; after LT-190 it
applies only to the four deliberately-unpriced providers (`copilot`, `cursor`, `ollama`,
`antigravity`). LT-190 narrowed it rather than causing it.

**Note the layer below already does this correctly**, which is both the proof that "unknown" is
representable here and the template for the fix: `LocalAiFallbackSpend` persists `NULL` rather than
`0` and carries a separate `unknown_reservations` counter
(`src/main/local-ai-guard/local-ai-fallback-spend.ts:50-55`), and `exceedsConfiguredCeiling()`
(`local-ai-fallback-store.ts:268-275`) treats an undefined estimate as *exceeding* a configured
ceiling — i.e. the safety-critical path fails closed correctly. Only the human-facing aggregate
loses the distinction.

**Required behaviour.** An unpriceable dispatch must remain distinguishable from a zero-cost one
wherever a total is shown to the user.

**The decision needed.** Copilot (and arguably Cursor) is a subscription seat, so `$0` *marginal*
cost is defensible — but it should be shown as a deliberate "not metered" rather than as an
arithmetic zero. Whether the UI should render `—`, `$X + N unknown`, or an explicit "not metered"
badge for seat-based providers is a small product call, so it is recorded here rather than decided.

**Acceptance.** `LocalAiIncident` carries an unknown-cost count alongside `estimatedCostUsd`;
the three render sites above distinguish unknown from zero; a regression test asserts that folding an
event with no `estimatedCostUsd` into an incident does not increment the dollar total and does
increment the unknown count.

**Provenance.** Surfaced by the LT-190 second completion gate on 2026-08-18, which traced one layer
past the ceiling check it had been asked to verify and found the coalesce downstream. Reported rather
than fixed because it lives entirely in files outside that review's scope and predates the diff.

## LT-200: instance-detail Review panel's `reviewStartSession` call always fails Zod validation

### Observed behavior

Preparing to drive the skill-observability livetest's check 8 (design-drift review agent), calling
`InstanceReviewPanelComponent.runReview()`'s exact IPC payload live over CDP against a real instance
returned:

```json
{
  "success": false,
  "error": {
    "code": "REVIEW_START_SESSION_FAILED",
    "message": "IPC validation failed for REVIEW_START_SESSION: agentIds: Invalid input: expected array, received undefined"
  }
}
```

This is not specific to `design-drift-analyzer` — the payload shape is wrong for every agent, every
time.

### Root cause

`instance-review-panel.component.ts`'s `runReview()` called:

```ts
this.ipc.getApi()?.reviewStartSession({
  agentId: agentIds[0],
  instanceId,
  workingDirectory: this.workingDirectory() || '',
  files,
  options: { agentIds, diffOnly: this.diffOnly() }
});
```

`ReviewStartSessionPayloadSchema` (`packages/contracts/src/schemas/orchestration.schemas.ts:224-229`)
requires `{ instanceId, agentIds: string[], files, diffOnly? }`. The handler
(`orchestration-ipc-handler.ts:531-585`) reads `validated.agentIds` and resolves the working directory
itself from `instanceManager.getInstance(validated.instanceId).workingDirectory` — it never reads a
`workingDirectory` field from the payload at all. So the panel's call was wrong on every count: the
required array field was never sent (only nested, unread, inside `options`), and two fields it did
send (`agentId`, `workingDirectory`) are not part of the schema and are silently ignored even when
present.

The preload wrapper's TypeScript parameter type
(`src/preload/domains/orchestration.preload.ts:389-397`, before this fix) matched the wrong shape too
— `{ agentId: string; instanceId: string; workingDirectory: string; files?: string[]; options?:
Record<string, unknown> }` — so the component compiled cleanly against a call that could never
succeed at runtime. The sibling caller, `reviews-page.component.ts`, was unaffected: it goes through
`OrchestrationIpcService.reviewStartSession()` (`orchestration-ipc.service.ts:233-241`), which already
builds the correct `{ instanceId, agentIds, files, diffOnly }` shape and was never touched by this bug.

This is the review-agent entry point the skill-observability livetest's check 8 names ("Start a review
session including agent id `design-drift-analyzer` (review panel agent list should show 'Design Drift
Analyzer')"), so that check was structurally unreachable through this panel regardless of which agent
was selected.

### Fix

- `src/renderer/app/features/instance-detail/instance-review-panel.component.ts` — `runReview()` now
  calls `reviewStartSession({ instanceId, agentIds, files, diffOnly: this.diffOnly() })`, matching the
  schema exactly.
- `src/preload/domains/orchestration.preload.ts` — corrected the `reviewStartSession` parameter type to
  `{ instanceId: string; agentIds: string[]; files: string[]; diffOnly?: boolean }` so the wrapper's own
  type can no longer let a caller compile against the wrong shape.

### Regression test, watched failing on revert

Added `instance-review-panel.component.spec.ts` → *"LT-200: runReview() sends a reviewStartSession
payload shaped for ReviewStartSessionPayloadSchema (agentIds array, no bogus
agentId/workingDirectory/options)"*: mocks `reviewStartSession` (and `reviewGetSession`, so
`pollSession()` resolves immediately), drives `runReview()` with one selected agent and one file, and
asserts the exact captured payload plus the explicit absence of `agentId`/`workingDirectory`/`options`.

Reverted only the component's call-site fix (via a `/tmp` copy, never `git stash`/`checkout --`) and
re-ran:

```
✗ 1 of 21 tests failed in 3.9s:
  ✗ InstanceReviewPanelComponent (WS-C4 findings dispatch) LT-200: runReview() sends a
    reviewStartSession payload shaped for ReviewStartSessionPayloadSchema (agentIds array, no
    bogus agentId/workingDirectory/options)
    AssertionError: expected { …(5) } to deeply equal { instanceId: 'inst-1', …(3) }
```

Restored the fix; all 21 tests in the file pass again.

### Gates

`npx tsc --noEmit` clean, `npx tsc --noEmit -p tsconfig.spec.json` clean, `ng lint` clean,
`check:ts-max-loc` unaffected (both touched files were already within their pre-existing +50
tolerance and this change only removed lines), `npm run build:main` green, targeted `test:quiet` on
`instance-review-panel.component.spec.ts` → 21/21 passed.

### Provenance

Found while preparing to drive skill-observability check 8 live during the 2026-08-18 Batch U2
livetest run. Fixed the same session, then re-verified live against a real `design-drift-analyzer`
run: a fixture file with an `Inter` display font and a keyword-eased `transition: all` produced
exactly the two expected `design-drift/typography`/`design-drift/motion` findings with file:line
citations, and a backend-only SQL migration file produced zero findings — check 8 now passes both
halves (see the skill-observability livetest's check 8 evidence for the full detail).

## LT-170: `skills:activation-delta` never reaches the renderer without a manual refresh (cross-process EventEmitter split)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Regression test, watched failing on revert

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Live end-to-end re-verification

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Gates

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

### Provenance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-170-archived-detail).

## LT-194: Workboard Decision Timeline's compaction source could never produce an entry

**Observed behaviour.** Compacting a real instance (Preview→Confirm or plain "Compact Now") never
produced a "Context compacted after N turns" entry in the Workboard item's Decision Timeline, no
matter how many times it was run.

**Root cause.** `buildCompactionDecisions()` (`src/main/workboard/operational-decision-projection.ts`)
is fed by `CompactionCoordinator.getEpochTracker(instanceId).getHistory()`
(`src/main/ipc/handlers/workboard-handlers.ts:110`). `CompactionEpochTracker.onCompaction()`
(`src/main/context/compaction-epoch.ts`) is the only method that ever pushes into `.history`, and
`incrementTurn()` is the only method that ever advances `turnCount` (which becomes
`turnsBeforeCompaction`) — neither had a single call site anywhere in `src/main` outside the class
itself. `CompactionCoordinator.executeCompaction()` never called `onCompaction()` on success, and
`onContextUpdate()` (the per-turn context-usage report hook) never called `incrementTurn()`. The
source was consequently permanently, silently empty for every user.

**Live reproduction.** Grew a real Claude instance to several exchanges, ran a real
`compactInstance()` IPC call (confirmed `success: true`), then queried
`workboardGetDecisionsForItem({instanceId})` and got `[]` back — no compaction source entry at all.

**Fix.** `src/main/context/compaction-coordinator.ts`: call
`this.getEpochTracker(instanceId).onCompaction()` in `executeCompaction()` immediately after a
successful compaction (native or restart-with-summary, before the `result` object is built), and
call `this.getEpochTracker(instanceId).incrementTurn()` in `onContextUpdate()` (the existing
per-turn context-usage report hook) so `turnsBeforeCompaction` reflects real activity rather than
always reading `0`.

**Re-verification (post-fix, rebuilt `dist/main`, restarted dev app).** A real compaction now
produces `{"source":"compaction","title":"Context compacted after 7 turns"}` from
`workboardGetDecisionsForItem`, and the real Workboard item detail DOM renders `"Decision timeline …
Context compacted after 7 turns"`.

**Regression test.** `src/main/context/compaction-coordinator.spec.ts`, new describe block
"CompactionCoordinator epoch tracking (LT-194 — Workboard decision timeline feed)" (4 tests: records
on native success, records on restart-with-summary success, does NOT record on failure, counts real
turns via `onContextUpdate` and starts the next epoch at zero). Reverted both call sites via a `/tmp`
copy and watched exactly the 3 assertion-bearing tests fail (`expected [] to have a length of 1 but
got +0`); restored and confirmed 22/22 tests pass in the file.

## LT-195: automation retry/backoff silently cancelled by an async `automation:changed` race, for every one-time automation

**Observed behaviour.** A one-time automation (manual `runNow`, a provider-limit-resume automation,
or any user-created one-time schedule) whose fired run failed with a genuinely retryable error never
actually retried, even though `maxAttempts` allowed more attempts and the failure type was retryable.
The run stayed at `attempt: 1`, status `failed`, forever — no second attempt, no auto-disable, no
error surfaced beyond the one lonely failed run. `consecutiveFailures` on the automation never
incremented either, because the runner correctly believed a retry was pending and deliberately skips
recording a streak outcome in that case.

**Root cause.** `AutomationRunner.handleTerminalRun()` synchronously schedules a retry via
`this.retryScheduler(run, attempt + 1, maxAttempts, delayMs)` when a failed run is retryable and
attempts remain. For a `oneTime` run, the same function then calls `this.emitAutomationState()`
(`src/main/automations/automation-runner.ts:566-575`), which is asynchronous:
`this.store.get(automationId).then((automation) => this.events.emitChanged({...}))`. That `.then()`
callback re-emits `'automation:changed'` *after* the synchronous retry-scheduling call above has
already returned. By the time it lands, the automation's own `nextFireAt` has already gone `null`
(the one-time schedule "spent" by firing — independent of the retry), so
`AutomationScheduler`'s generic `'automation:changed'` listener
(`src/main/automations/automation-scheduler.ts:93-102`) evaluates `active && enabled && nextFireAt
!== null` as `false` and falls to its `else` branch, calling the FULL `deactivate()` — which cancels
**every** retry timer currently armed for that automation, including the one just scheduled a moment
earlier. The existing `'automation:run-terminal'` listener (the target of the earlier, correctly
applied "BUG 1" fix) is fine — it fires synchronously and uses the safe `deactivateSchedule()`. This
second, async listener was never given the same guard.

**Live reproduction (certainty via instrumentation).** Monkey-patched
`AutomationScheduler.prototype.deactivate` via the Node Inspector Protocol on the real running main
process to capture a stack trace on every call, alongside `retryHandlesBefore` (the retry-handle keys
present at the moment of the call). Fired a real one-time automation whose `workingDirectory` pointed
at a plain file (guaranteeing a genuine spawn failure, not a permission-wait). Captured:
```
AutomationScheduler.deactivate
  ← AutomationEvents 'automation:changed' listener (automation-scheduler.js:82)
  ← AutomationEvents.emit
  ← AutomationEvents.emitChanged
  ← automation-runner.js:433 (emitAutomationState's .then() callback)
```
with `retryHandlesBefore: ["<the run's own id>"]` — i.e. the retry handle existed immediately before
this call wiped it. The app log independently showed the "Scheduling automation retry" info line
firing (with a real `delayMs`) for the same run, and `AutomationStore.listPendingRetries()` and the
run row both confirmed no retry was actually armed minutes later.

**First-pass fix (superseded — see completion-gate finding below).**
`src/main/automations/automation-scheduler.ts`: added a private `hasPendingRetry(automationId)`
helper (checks `retryHandles` for any entry belonging to that automation). The `'automation:changed'`
listener's `else` branch checked it first: if a retry was pending, only `deactivateSchedule()` ran
(preserving the retry), reasoning that "a genuine disable/delete has no pending retry to preserve".
Re-verified live at the time (rebuilt `dist/main`, restarted dev app): the same repro scenario
genuinely retried — a second run row appeared with `attempt: 2`, and
`workboardGetDecisionsForItem({automationRunId})` and the real Workboard item detail DOM both showed
`"Retried automatically — attempt 2 of 3"`.

**Completion-gate finding — P1 regression, same day.** The first-pass reasoning was wrong for a
*disable*, not just delete. `AUTOMATION_UPDATE` (`src/main/ipc/handlers/automation-handlers.ts:96-97`
— the handler behind toggling `enabled: false` in the Automations page "Pause" control) and the
`update_automation` MCP tool (`src/main/automations/automation-tool-impl.ts:373-376`) both call
`scheduler.schedule(automation)` — which only clears the *fire* handle
(`automation-scheduler.ts:149-152`) — then `events.emitChanged(...)`. Neither calls `deactivate()` or
`cancelRetry()` (delete *is* safe: it explicitly calls `scheduler.deactivate(id)` first in both
places). So on disable-with-armed-retry, `hasPendingRetry` was true, the first-pass fix took the
`deactivateSchedule`-only branch, and the retry timer survived a disable — reachable from ordinary UI
use ("Pause" toggle), not an edge path. `onRetryTimer` → `insertRetryRun`
(`automation-store-retry-ops.ts:58-90`) only checks the automation row still *exists*, never that it
is `enabled`/`active`, so the surviving timer fired and dispatched a run for an automation the user
had just disabled — for the auto-created provider-limit "resume after quota reset" automations
specifically, an unexpected session resume against something the operator believed disabled. Also not
limited to `oneTime`: `handleTerminalRun` (`automation-runner.ts:625-648`) does not gate retry
scheduling on `isOneTimeRun`, so a cron automation disabled mid-backoff hit the identical gap (the
auto-disable-after-repeated-failures path is unaffected — it uses `emitScheduleDeactivated`, which
always fully deactivates). Reproduced empirically by replaying the real
`store.update({enabled:false})` → `scheduler.schedule()` → `emitChanged()` sequence against the
first-pass fix: `retryHandles.size` stayed `1` when it had to be `0`.

**Corrected fix.** The `'automation:changed'` listener's retry-preserving branch now additionally
requires `event.automation?.enabled === true` before taking the `deactivateSchedule`-only path — the
one field every disable path in this codebase actually flips: the Automations-page "Pause" toggle
(`automations-page.component.ts`'s `togglePaused()`), `AUTOMATION_UPDATE`, and `update_automation` all
only ever change `enabled`, never `active` on their own (confirmed by reading all three call sites);
a fired run's own post-fire echo (the race this fix exists for) never touches `enabled` either. So
this is not a heuristic that happens to work for the known cases — it is the same authoritative on/off
bit those write paths themselves use to signal "turned off", checked here to tell a genuine disable
apart from the async echo. `event.automation` being `null` (the delete path) evaluates to
`undefined === true` (false), so it defensively falls through to the full `deactivate()` too, rather
than depending on delete's own explicit `deactivate()` call running first. The misleading first-pass
code comment (which claimed disable had no pending retry to preserve, without qualifying that this was
true only for the echo case) was rewritten to state the actual distinguishing signal and why it holds.

**Re-verification (corrected fix).** Re-ran gates: `tsc --noEmit` ×2, `ng lint`, `check:ts-max-loc`,
`build:main`, and the full `src/main/automations` suite (165/165) — all green. Not re-verified live
against the real dev app a second time this round (the corrected condition is exercised by a
regression test that replays the exact real production call sequence the gate itself used to
reproduce the regression, so this is considered adequately covered without a second live cycle;
flag if independent live verification is still wanted).

**Regression test.** `src/main/automations/automation-retry-integration.spec.ts`, describe block
"LT-195 — oneTime retry survives the automation:changed race", now 4 tests: (1) the original repro —
an `'automation:changed'` echo with `active:true, enabled:true, nextFireAt:null` while a retry is
pending must preserve it; (2) a genuine `enabled:false` disable with NO pending retry still fully
deactivates (control); (3) **new** — a genuine `enabled:false` disable racing an ARMED retry for a
oneTime automation must cancel it (`retryHandles.size` reaches `0`, `insertRetryRun` never called
after advancing past when the timer would have fired); (4) **new** — the same for a cron automation,
proving the gap was not oneTime-specific. Reverted only the corrected condition (the
`event.automation?.enabled === true` guard, restoring the first-pass `hasPendingRetry(...)`-only
check) via a `/tmp` copy and watched exactly tests (3) and (4) fail (`expected 1 to be +0`) with all
other 25 tests — including test (1), the original echo-preserves-retry repro — staying green; restored
and confirmed 27/27 pass.

## LT-196: "Scan for corrections" learning-scan is structurally non-functional for Claude sessions

**Observed behaviour.** Running "Scan for corrections" (`MemoryReviewStore.runScan()` /
`learning-scan-service.ts`) against a real workspace with a genuine command-failure-then-correction
pattern in its history always reports `patternsFound: 0, proposalsCreated: 0`, with no error — giving
no signal that anything is wrong.

**Root cause.** `correction-miner.ts`'s own file-header survey (dated 2026-07-30) states: "the only
reliably queryable per-tool-call signal in AIO's archived history … is the `OutputMessage` stream …
`type: 'tool_use'` / `type: 'tool_result'` pairs correlated by an id, where `tool_result` carries
`metadata.is_error: boolean` on Claude, ACP, Codex-exec, Cursor, and Copilot adapters." That was true
when written, but the later, correctly-motivated LT-062 fix (2026-08-12) silently invalidated it for
Claude specifically: `claude-cli-adapter.ts`'s own comment now reads "LT-062: below only turns a
tool_result into a visible 'output' message on the permission-denial branch, so the loop detector
never saw an ordinary success/failure. Raw-emit it instead — same channel AcpCliAdapter already uses,
transcript untouched." An ordinary tool success *or failure* is now raw-emitted only on the adapter's
internal `'tool_result'` event (consumed live, for doom-loop detection) and is never written into the
transcript/history as a `type: 'tool_result'` `OutputMessage`. Since `extractToolInvocations()`
(`correction-miner.ts`) reads only the archived history, every invocation's `isError` comes back
`null` (never observed), and `findCorrectionPairs()`'s first gate — `if (failInv.isError !== true)
continue;` — discards every candidate before pairing even starts.

**Live reproduction (twice).** First attempt used `ls` on a wrong-then-right path — correctly
excluded by design (`ls`/`cd`/`pwd`/`find`/`tree`/`dir` are deliberately-excluded "exploration"
commands, not a miner bug). Second attempt used a real `grep --bogus-flag test readme.txt` (genuine
`invalid option` failure, exit 2) followed by the corrected `grep test readme.txt` (genuine success)
— exactly the shape `findCorrectionPairs()` is built to catch (same base command, classifiable
`UnknownFlag` error, different command text on the fix side). Confirmed via a Node-inspector read of
`HistoryManager.loadConversation()` for the real archived session that it contains only
`tool_use`/`assistant`/`user` messages — zero `tool_result` entries — matching the root cause exactly.
`runScan()` still reported `sessionsScanned: 1, patternsFound: 0`, no error.

**Not fixed — needs a design decision.** Two viable directions, both a genuine architecture/product
choice rather than a bug fix:
(a) persist a lightweight, transcript-invisible `tool_result` record (id + `is_error` + command) at
capture time specifically for later mining, tagged so the renderer never renders it as a chat bubble
(preserving LT-062's transcript hygiene); or
(b) feed the correction-miner from a separately persisted log of the raw `'tool_result'` events the
adapter already emits live, rather than from the rendered `OutputMessage` history it currently reads.
Either done carelessly risks reintroducing some of the transcript noise LT-062 deliberately removed.

**Scope note.** The rest of the Memory Review inbox was independently live-verified working correctly
this same run (see the A4 evidence in the sibling-audit-round2 livetest doc): approve / edit-approve
(with correct `user-approved` vs `user-authored` provenance) / reject via
`captureMemoryProposal()`-seeded proposals, decisions persisting across a real app restart, and an
approved lesson's exact text reaching a subsequent real loop's actual `planStageContext` ("Prior
lessons (this workspace)" block) while the rejected one stayed absent. This defect is scoped
precisely to the correction-miner's Claude-transcript data source, not the review/approval pipeline
or the lesson-surfacing pipeline around it.

**Acceptance.** Written in the spec,
[`2026-09-06-lt196-correction-miner_spec_completed.md`](../superpowers/specs/2026-09-06-lt196-correction-miner_spec_completed.md):
a real Claude session, and a real ACP session, each containing a genuine same-base-command
failure→fix pair (not an exploration command) must produce a governed rule proposal from `runScan()`.

**Status: FIXED 2026-09-13; live checks pending.** Direction (a), with the record held in a side
store rather than the live buffer. All agent-runnable gates pass, and the final independent review
returned PASS. The real-provider scans and the archive→live checks are open in
[`2026-09-06-lt196-correction-miner_livetest.md`](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest.md).

## LT-206: RLM and Wake renderer events are dead for the worker-routed paths

**Status: FIXED + REGRESSION-TESTED 2026-08-18.** See the index row above for the full fix
description, the empirical live-app confirmation of the diagnosis, the generic-vs-bespoke design
call, the revert-and-watch-it-fail evidence, and the related-but-out-of-scope finding (the
codebase-indexing lane worker has its own separate `RLMContextManager` instance with the same
theoretical exposure — not investigated or fixed here). The sections below are the original,
unmodified diagnosis this fix was built from.

**Observed behaviour.** Renderer live-update channels for RLM store/section activity
(`RLM_STORE_UPDATED`, `RLM_SECTION_ADDED`, `RLM_SECTION_REMOVED`, `RLM_QUERY_COMPLETE`) and for wake
context (`WAKE_EVENT_CONTEXT_GENERATED`) never fire during real usage, so any UI depending on them
only updates on a manual refresh.

**Root cause — the third and fourth instances of a class found twice already today.** The emitting
singleton lives in the **context-worker** process; the forwarding listener is registered on the
**main** process's separate instance of the same singleton. Identical in shape to LT-169 (skill
controls cached per-process) and LT-170 (skill activations emitted in the worker).

- `RLMContextManager` (`src/main/rlm/context-manager.ts:84`) emits `store:created` (:292),
  `section:added` (:315), `query:executed` (:395), `section:removed` (:525).
  `InstanceContextManager` (`src/main/instance/instance-context.ts:120`) holds the worker's instance,
  because production always routes through `ContextWorkerClient`.
  `setupRlmEventForwarding` (`src/main/ipc/ipc-main-runtime-wiring.ts:137-186`) subscribes to main's.
- `WakeContextBuilder` (`src/main/memory/wake-context-builder.ts:43`) emits `wake:context-generated`
  (:295) from `getWakeUpText()`, reached inside the worker via
  `instance-system-prompt.ts:339` → `instance-manager.ts:540` → `ContextWorkerClient.buildWakeContextText`.
  `setupKnowledgeEventForwarding` (`ipc-main-runtime-wiring.ts:243-244`) subscribes to main's.
  `wake:hint-added` shares the emitter and is equally suspect; not verified.

**Required behaviour.** An event emitted during worker-routed work must reach the renderer, or the
channel should be removed rather than left as dead wiring that looks functional.

**Acceptance.** Apply the LT-170 pattern — a worker→main forwarding message re-emitted on main's
singleton — to both emitters, or relocate the forwarding subscription to where the emit actually
happens. Add a per-channel regression test that fails when the event is emitted in the worker and
never reaches the renderer. Confirm `wake:hint-added` in the same pass.

**Why this is filed separately from LT-170.** The LT-170 diff is correct and complete for skill
activations; these are distinct emitters on distinct paths. Recorded so the *class* is not considered
closed just because one instance of it was fixed.

**Provenance.** Found by the LT-170/LT-200 completion gate on 2026-08-18, which was asked whether the
bug class had other live instances and went looking rather than assuming.

## LT-207: the codebase-indexing lane's own RLMContextManager singleton never reaches main

**Status: FIXED + REGRESSION-TESTED 2026-08-18.** See the index row above for the full fix
description, the empirical live-app confirmation (control emit + real indexing run through the real
lane worker, single-delivery confirmed after a fresh app restart), the transport-adapter design (a
new `LaneOutboundMessage` `'worker-event'` variant threaded through `ProcessLaneGateway` →
`BackgroundJobRuntime` → `CodebaseIndexingLaneGateway`, reusing LT-206's `dispatchWorkerBroadcast()`
unmodified), the `isHighVolumeContextStore()` interaction note, the new import-isolation guard, and
the revert-and-watch-it-fail evidence for both halves of the transport.

**Observed behaviour.** `RLM_SECTION_ADDED`/`RLM_STORE_UPDATED` never fired for sections added by a
real codebase-indexing run (manual `CODEBASE_INDEX_STORE` or the auto-coordinator), even though the
identical LT-206 fix had just made the equivalent context-worker paths live.

**Root cause.** `codebase-indexing-lane-main.ts` constructs its own worker-local
`RLMContextManager.getInstance()` (a *third* process with a *third* instance of this singleton, after
main and the context-worker). `CodebaseIndexingService.addSection()`
(`src/main/indexing/indexing-service.ts:483`) calls `this.contextManager.addSection(...)` on that
instance, whose `section:added` emit (`context-manager.ts:315`) had no listener anywhere outside this
one lane process — the lane had no `registerWorkerEventForwarding`/`dispatchWorkerBroadcast` import at
all before this fix.

**Required behaviour.** A `section:added` fired by a real codebase-indexing job must reach main's
`RLMContextManager` singleton so the existing `setupRlmEventForwarding` (`ipc-main-runtime-wiring.ts`)
subscription can forward it to the renderer (subject to the pre-existing, unrelated
`isHighVolumeContextStore()` filter for `'codebase-auto'`-tagged stores, which is intentional and out
of scope for this ticket).

**Fix.** See the index row and the plan doc's LT-207 section
(`docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`) for the full mechanism.

**Why this is filed separately from LT-206.** LT-206 explicitly flagged this lane as a related,
out-of-scope finding — a different process with different wiring (a `LaneOutboundMessage` transport,
not `ContextWorkerOutboundMsg` directly), not the same code path.

**Provenance.** Found by the LT-206 completion gate on 2026-08-18, which checked whether LT-206's fix
made this lane newly reachable (it did not) and filed it as its own ticket.

## LT-215: fresh-fallback degradation notice never lists a child that died during the exact restart window, and the "Reconciled..." log line never fires

**Current status (2026-08-31): FIXED IN CODE; LIVE RE-CHECK PENDING.** The repair uses the exact
session-admission suppression event as the restart-window boundary. A child whose completion cannot
be delivered while the parent is unavailable is retained after live reap, included in
`droppedChildIds` during fresh fallback, and drained exactly once; successful same-session
redelivery clears it. A failing-first orchestration regression test covers the behavior.

**Original status: FOUND, NOT FIXED, 2026-08-18.**

**Observed behaviour.** Live-tested check 3 of the resilient-threads-sessions plan for the first time
end to end: a real Codex parent with two live orchestration children, one child killed and the parent
forced into a genuine fresh fallback (not native resume) at the same instant, on the parent's first
respawn attempt (no prior circuit-breaker backoff). Post-restart:
- `get_children` correctly showed only the surviving child.
- `get_child_summary` for the dead child correctly resolved.
- The `[SESSION DEGRADATION NOTICE]` correctly listed the surviving child ("Orchestration child
  instances still alive and attached to you: - xt3rx6hl0 (busy)") — **but had no "lost in the
  restart" section at all**, even though a child genuinely died during the exact restart window the
  notice is describing.
- `app.log` never emitted `"Reconciled orchestration children after restart"` for this parent, at
  any point.

**Root cause.** Two independent mechanisms both mutate the same `OrchestrationHandler.contexts`
entry's `childrenIds`, and the fast one always wins:
1. `InstanceChildCompletionHandler.handleChildExit()` (`instance-child-completion-handler.ts:85`) runs
   as soon as the child adapter's own process `'exit'` event fires — this is wired at
   `instance-communication.ts:2417-2418` inside the generic "instance exited unexpectedly" handler and
   is completely independent of whatever state the *parent* instance is in. It calls
   `orchestration.notifyChildTerminated(parentId, childId, ...)`
   (`orchestration-handler.ts:1130`), which unconditionally does
   `ctx.childrenIds = ctx.childrenIds.filter((id) => id !== childId)` synchronously.
2. `RestartPolicyHelpers.buildFallbackHistory()` (`restart-policy-helpers.ts:137`) — the function every
   fresh-fallback path funnels through to build the degradation notice — calls
   `reconcileChildren()` → `reconcileChildrenAfterRestart(parentId, isChildAlive)`
   (`orchestration-handler.ts:192`), which only reports a child as `dropped` if it is *still present*
   in `ctx.childrenIds` at the moment it runs.

Measured with millisecond-precision `app.log` timestamps on a fresh, first-attempt parent (no circuit
breaker delay), simultaneous `kill -9 <parentPid> <deadChildPid>`:

```
184610  InterruptRespawn      Auto-respawning after unexpected exit          (parent exit detected)
184619  InstanceChildCompletion  Child exited, parent notified               (childrenIds already stripped, +9ms)
184872  RuntimeReconciler      Resume failed ... falling back to fresh session  (+262ms)
185928  InstanceContinuityInputQueue  Queued continuity preamble for next user input  (reconcile point, +1318ms)
185929  RuntimeReconciler      Recovery respawn complete { resumed: false }
```

By the time `reconcileChildrenAfterRestart` runs (1.3s after the kill), the live reap already
completed 1.3s earlier — `dropped` is always empty, so the log line never fires and the notice never
gets a `droppedChildIds` entry to render. This reproduces the exact structural race first diagnosed
(without a controlled repro) by Batch L earlier the same day, now confirmed with a controlled,
first-attempt, maximally-fast (synchronous native-resume-throw via a scoped
`CodexCliAdapter.prototype.spawn` patch) repro — i.e. this is not a timing fluke that a faster fallback
path would fix; the live reap's synchronous, event-driven speed advantage over the restart ladder's
inherently multi-step, async path (detect exit → attempt resume → fail → build fallback history) is
structural.

**Required behaviour.** A user reading the degradation notice after a fresh fallback should be told
about a child that died during the restart window, not just about the one that survived — that is the
entire point of Phase 4 of the resilient-threads-sessions plan (WS "gap C": children that died while
the parent was down must not silently vanish from the user-facing picture). The internal bookkeeping
(`get_children`, `get_child_summary`) is already correct via the live-reap path; only the **notice
content** and the **log line** are the gap.

**Fix (not implemented — needs a design decision on the window semantics).** Recommended shape: have
`notifyChildTerminated` (`orchestration-handler.ts`) additionally record `{childId, name, timestamp}`
into a short-lived per-parent list whenever the parent's own instance is not `idle`/`busy` at the
moment of the child's death (i.e. the parent is itself mid-restart), and have
`RestartPolicyHelpers.reconcileChildren()` drain that list into `droppedChildIds` in addition to (not
instead of) `reconcileChildrenAfterRestart`'s own stale-membership check, so a child whose death raced
the parent's restart is still reported as lost even though the live reap already removed it from
`ctx.childrenIds`. Deciding exactly how "during the restart window" should be bounded (a timestamp
comparison against the parent's own last-exit event, vs. a fixed grace period) is a product judgment
call, not decided here — recorded for James per the campaign's "genuine product/UX decision" rule
rather than implemented unilaterally in this session.

**Provenance.** Found by Batch S3 (2026-08-18) closing out check 3 of the resilient-threads-sessions
livetest, the first session to actually reach and observe the check's downstream assertions (prior
sessions never got past forcing the race safely). Builds directly on Batch L's same-day diagnosis of
the live-reap-outraces-restart-reconcile race and the safer Codex-adapter monkeypatch forcing
technique; this session supplies the first full observation of the notice/get_children/log-line
outcome, not just the race's existence.

## LT-220: Antigravity adapter never surfaces tool events — DECIDED + DOC-CORRECTED

[Read the detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail).

### The doc's own check-4 premise is also wrong, not just its expected outcome

[Read the detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail).

### Required behaviour — not decided here

[Read the detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail).

### Provenance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-220-archived-detail).

## LT-216: find_or_open cannot attach to an existing tab on a relay-backed remote node, and silently opens a duplicate instead

**Status: FIXED + REGRESSION-TESTED 2026-08-19.** Not live-re-verified — see residual.

**Observed behaviour.** From the orchestrating session, with `windows-pc`
(`bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`) connected, `extensionVersion: "0.2.2"`,
`extensionRelay.running: true`, `registration: "ok"` and `lastExtensionContactAt` seconds old:

| Call | Result |
| --- | --- |
| `browser.list_targets` `{computer: "windows-pc", refresh: true}` | 48 targets returned, **every one flagged `stale: true`**, with `reason: "inventory refresh FAILED for node bb62e3ee-… — extension last contacted 0s ago; those targets are cached and marked stale"` (auditId `73b44485-619d-4f66-bf12-d4c965b34ca3`) |
| `browser.find_or_open` `{computer: "windows-pc", titleHint: "Bing Webmaster Tools"}` | `outcome: "failed"`, `reason: "existing_tab_not_confirmed_after_inventory_refresh"` (auditId `29ba5a06-306d-4f18-8da0-56c95264a2d7`) |
| `browser.find_or_open` `{titleHint: "Krystal Hosting"}` | same failure (auditId `7a855082-d1aa-4379-a588-995e8023db6a`) |
| `browser.find_or_open` `{titleHint: "Contracts Finder"}` | same failure (auditId `1ce1907c-49d9-4349-8681-5da4a5a5d9c9`) |

All three tabs were present in the `list_targets` response from the same session, with `lastSeenAt`
timestamps minutes old. This is 3/3, not a flake.

**Root cause.** `confirmExistingCandidate()`
(`src/main/browser-gateway/browser-target-discovery-operations.ts`) issued a `report_inventory`
refresh bounded at `timeoutMs: 3_000` / `executionTimeoutMs: 2_500`
(`browser-extension-inventory-refresh.ts:9-10`), then called
`findExistingTabCandidate(tabs, url, titleHint, { minUpdatedAt: refreshStartedAt })` — accepting only
tabs the extension re-reported **inside that ~3s window**.

A relay-backed extension does not work that way. It re-reports tabs on a rolling sweep. Measured from
consecutive `browser.extension_attach_tab` audit rows for a single tab on this node:

```
gaps (ms): 19320, 19907, 28105, 28337, 34772, 35002, 42529, 55207
```

So any given tab is re-confirmed every **20–55 seconds** while the confirm window is **3 seconds** —
roughly a 1-in-10 chance of confirming a tab that is perfectly alive.

Compounding it, the refresh command *itself* was failing on this node (first row of the table above),
and `confirmExistingCandidate` treated node refresh failure as a hard `return null` before the
freshness check was ever reached.

**Why this matters more than the error message suggests.** `findOrOpen`
(`browser-target-discovery-operations.ts:236-295`) branches on whether a URL was supplied:

- **no URL** → `cachedTabNotConfirmed()` — the agent is told the tab could not be confirmed.
- **URL supplied** → `existing = null` → falls through to `openTab()`, which **opens a new tab**.

The second branch is the damaging one: an agent asking for a page the user is already logged into on
that node gets a **fresh, unauthenticated duplicate tab** instead of the live session, with no error
at all. That is exactly the shape that makes an agent report a login wall on a site the user is
signed into. (Deliberately not triggered live — it would have opened real tabs in the user's browser;
established by reading the branch.)

**Required behaviour.** A tab that the extension has confirmed recently, on a node whose extension is
still in contact, is a live tab and must be reused. A refresh *command* that times out is not
evidence the tab is gone; loss of extension *contact* is.

**Fix.**
1. Added `EXISTING_TAB_CONFIRMATION_HORIZON_MS = 120_000` and confirm against
   `refreshStartedAt - EXISTING_TAB_CONFIRMATION_HORIZON_MS`. The horizon exceeds the measured 20–55s
   sweep while still excluding genuinely dead inventory — the same listing contained ghost tabs from
   an ended browser session roughly 6 hours old, which must not be selected.
2. A failed node refresh no longer short-circuits to `null` when
   `isRemoteExtensionContactFresh(nodeId)` is true; it falls through to the horizon check. When
   contact is *not* fresh the existing `browser_extension_unreachable` path still fires first.

Local-channel behaviour is unchanged apart from sharing the horizon.

**The tradeoff this fix accepts, stated deliberately rather than left for a reviewer to find.** A
120s horizon means a tab closed within the last 120s can still be selected, where the old code would
have fallen through to `openTab()` and opened a fresh one — which for a genuinely closed tab is the
better outcome. So this is not a strict improvement in every case; it is a trade:

- **Before:** ~90% of *live* tabs rejected. With a URL, each rejection silently opened a duplicate,
  unauthenticated tab — a wrong answer with no error.
- **After:** live tabs are reused. A tab closed inside the horizon may be selected, and the following
  command then fails **loudly** against a target that no longer exists, which is recoverable (the tab
  store drops it and a retry opens a new tab).

Trading a frequent silent-wrong-answer for a rare loud-and-recoverable one is the right direction,
but the horizon value is a tuning choice, not a derived constant: 120s was picked to clear the
measured 20–55s sweep with margin while staying far below the ~6h age of the ghost inventory seen in
the same listing. If a node's sweep period is materially longer than `windows-pc`'s, this needs
revisiting — the principled version is to derive the horizon from observed inventory cadence per node
rather than fix it globally.

**Acceptance.** `src/main/browser-gateway/browser-target-discovery-confirmation-horizon.spec.ts`, 5
tests: live tab selected via `titleHint`; live tab reused rather than duplicated when a URL is given
(asserting `open_tab` is never issued); selection still succeeds when the refresh command throws but
contact is fresh; a 6-hour-old ghost tab is still refused; a cached tab on a silent node is still
refused. Both halves of the fix were reverted via a `/tmp` copy and **3 of the 5 failed**; the two
guard tests passed in both directions, which is what makes them guards rather than tautologies.
Restored: 5/5, and 883/883 across all 87 `src/main/browser-gateway` spec files.

**Residual.** Not re-verified against the live node. `windows-pc` is paired to the **packaged** app,
which runs its own bundled build, so the fix cannot reach it without a repackage and a restart of the
user's running app. Recorded as a live check rather than claimed.

**Related, not fixed here.** The `list_targets` half of the same trigger is still user-visible: a
successful listing on this node is labelled `stale: true` with an "inventory refresh FAILED" reason
while the extension is demonstrably in contact — the inverse of the honesty property that code was
written to provide (`browser-gateway-refresh-support.ts:56-83`). The flat 2.5s/3s refresh budget is
the shared cause; whether to raise it, scale it by measured node latency, or stop treating a
best-effort refresh as a failure signal at all is a tuning decision left open.

### Live verification — 2026-08-20: CONFIRMED FIXED on the rebuilt app

The residual above ("not live-re-verified; needs a repackage + restart") is now closed. James rebuilt
and restarted the packaged app; the bundle was confirmed to actually contain the fix before testing
(`strings app.asar | grep EXISTING_TAB_CONFIRMATION_HORIZON_MS` → 4 hits), rather than assuming a
rebuild implies a deployed change.

Re-ran the **identical three tabs** that failed 3/3 on 2026-08-19:

| Tab | 2026-08-19 (pre-fix) | 2026-08-20 (post-fix) |
| --- | --- | --- |
| Bing Webmaster Tools | `failed` · `existing_tab_not_confirmed_after_inventory_refresh` (`29ba5a06`) | **`succeeded`** (`64fce094`) |
| Krystal Hosting | `failed` · same reason (`7a855082`) | **`succeeded`** (`6c8782c0`) |
| Contracts Finder | `failed` · same reason (`1ce1907c`) | **`succeeded`** (`aaa11c29`) |

3/3 failing → 3/3 attaching, on the same node, same tabs, same call shape. **LT-216 is confirmed
fixed in production.**

## LT-217: browser_audit_entries is 99.7% internal bookkeeping and grows without bound — ONGOING GROWTH FIXED

**Current status (2026-08-31): ONGOING GROWTH FIXED + REGRESSION-TESTED.** The two internal
bookkeeping paths no longer write audit rows and 90-day read-row retention is wired into maintenance.
Optional one-off deletion/VACUUM of historical rows remains separate destructive maintenance.

**Original status (2026-08-19): FOUND, NOT FIXED — needed a retention/scope decision.**

**Observed behaviour.** Measured read-only against the live production
`~/Library/Application Support/harness/rlm/rlm.db`:

| tool_name | rows |
| --- | --- |
| `browser.extension_attach_tab` | 2,314,562 |
| `browser.list_approval_requests` | 1,116,376 |
| `browser.click` | 2,462 |
| `browser.evaluate` | 2,190 |
| `browser.query_elements` | 1,423 |
| `browser.snapshot` | 1,273 |
| `browser.navigate` | 1,163 |
| `browser.accessibility_snapshot` | 1,047 |
| `browser.screenshot` | 686 |
| `browser.list_targets` | 606 |
| `browser.find_or_open` | 409 |
| `browser.wait_for` | 238 |

Total 3,444,307 rows. Every genuine agent browser action across the whole retained history — back to
**2026-05-04** — totals roughly 11,000. Two bookkeeping paths account for **99.7%**.

`select sum(pgsize) from dbstat where name='browser_audit_entries'` → **1,361,317,888 bytes
(1.36 GB)**, about **32% of the 4.27 GB `rlm.db`**. `browser.extension_attach_tab` alone runs at
50,030–115,762 rows/day, every day, sustained (2026-07-26 through 2026-08-19 all sampled).

**Root cause.** Both paths write a full audit row through `this.result(...)`:

1. `attachExistingTab()` (`browser-gateway-service.ts:462-497`) is called once **per tab, per
   inventory report** by the relay bridge (`remote-extension-bridge.ts:132`,
   `browser-gateway-rpc-server.ts:386`). A 22-tab node on a ~30s sweep therefore writes ~2–3 audit
   rows per second, continuously, with no agent involved.
2. `listApprovalRequests()` (`browser-gateway-approval-operations.ts:73-93`) is polled by
   `BrowserApprovalsBannerComponent` on a permanent `setInterval` at
   `REFRESH_INTERVAL_MS = 5_000` (`browser-approvals-banner.component.ts:32,216-218`). 17,280
   rows/day × ~65 days ≈ 1.12M, matching the observed count.

There is **no DELETE or pruning path for this table anywhere in `src/`** — the only references are
the migration that creates it (`rlm-migrations-022-035.ts:58-81`) and the insert/select in
`browser-audit-store.ts`.

**Why it matters beyond disk.** This table is the forensic record for browser incidents. This
campaign has already relied on it (an earlier entry notes an incident that "left a trace only in the
`browser_audit_entries` table"), and finding that trace now means searching 3.4M rows of noise. It
also imposes continuous SQLite write pressure on a 4.27 GB database inside the main app.

**Required behaviour.** The browser audit trail should record agent-attributable browser decisions.
Internal tab-store bookkeeping and a read-only UI poll are neither, and the table should not grow
without bound.

**Acceptance (not yet implemented).** Recommended shape: stop auditing these two paths — keep an
`extension_attach_tab` row only for an *agent-initiated* attach, and drop the audit write from a
read-only approval poll entirely — and/or add retention pruning on `created_at` for
`actionClass: 'read'` rows. Whichever is chosen should be paired with a one-off compaction, since
neither change reclaims the existing 1.36 GB. Deliberately not decided unilaterally: dropping audit
rows is a decision about an audit trail.

## LT-218: browser.snapshot reports success with empty text when the extension cannot read the page at all — FIXED

**Current status (2026-08-31): FIXED + REGRESSION-TESTED; live unreadable-page recheck pending.**
The selected contract preserves successful partial/title reads while carrying an explicit
`textUnavailableReason` through the extension, coordinator, cached/fresh results, and shared types.

**Original status (2026-08-19): FOUND, NOT FIXED — the fix shape was undecided.**

**Observed behaviour.** Two independent shared tabs on `windows-pc`, same session, same minute:

| Target | `browser.snapshot` | `browser.query_elements` |
| --- | --- | --- |
| `www.bing.com/webmasters/about` | `succeeded`, `title` and `url` correct, **`text: ""`** (auditId `49e892af`) | `failed` — "Cannot access contents of the page. Extension manifest must request permission to access the respective host." (auditId `47beba98`) |
| `www.contractsfinder.service.gov.uk/Notice/…` | `succeeded`, `title` and `url` correct, **`text: ""`** (auditId `b4fe791a`) | same failure (auditId `03e2e2a4`) |

`query_elements` reports the truth. `snapshot` reports success and hands back nothing.

**Root cause.** Two stacked error-swallowing catches in `resources/browser-extension/background.js`:

```js
async function capturePageText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, func: pageBridgeScript, args: ['snapshot', []],
  }).catch(() => []);            // <- host-permission rejection becomes []
  …
}

async function buildTabPayload(tab, options = {}) {
  const page = options.includeText
    ? await capturePageText(tab.id).catch(() => ({ title: tab.title, text: '' }))   // <- and again
    : { title: tab.title, text: '' };
  …
  return { …, title: page.title || tab.title || tab.url, text: page.text || '', … };
}
```

`chrome.scripting.executeScript` rejects when the manifest lacks host permission for the origin.
Both catches convert that into an empty string, and the command resolves normally, so the coordinator
records `outcome: "succeeded"`.

Title and URL still populate because they come from `chrome.tabs.get()`, which requires no host
permission. That is precisely what makes the result look like a *successful read of a blank page*
rather than a failed read.

**Why it matters.** This is the "confident wrong answer" class this campaign keeps hitting. An agent
asked to read a tender portal, a console, or a form gets `succeeded` and empty text, and will
reasonably conclude the page has no content — rather than reporting that the extension has no
permission for that host, which is an actionable, one-time fix. It also explains the
`accessibility_snapshot` timeouts observed on the same tabs the same session, and it means the
`extractionHint` / aux-extraction path downstream is being fed an empty capture it cannot improve on.

**Required behaviour.** A snapshot that could not read the page must be distinguishable from a
snapshot of a page with no text.

**Acceptance (not yet implemented) — two candidate shapes, not decided here.**

1. **Fail like `query_elements` does.** Most consistent, and matches what the agent needs to hear.
   Risk: `executeScript` is called with `allFrames: true`, so a page with one inaccessible frame
   would start failing where it previously returned partial text. Needs a check of whether partial
   failure is distinguishable from total failure at that call.
2. **Succeed with an explicit `unreadable: true` / `textUnavailableReason` field**, and have the
   aux-extraction and campaign callers branch on it. Preserves partial reads; costs a contract change
   and every caller has to honour it.

Either way the regression test belongs in `browser-extension-assets.spec.ts`, which already covers
background.js failure paths: assert an `executeScript` rejection is not converted into a successful
empty-text snapshot.

**Not fixable end-to-end from this session** regardless of shape: the code is in the extension bundle,
which has to be redeployed and reloaded on the node (`chrome://extensions` on `windows-pc`) before any
live re-verification is possible.

**Reconciled against a contradicting prior observation — this makes the defect worse, not weaker.**
`docs/plans/2026-07-22-local-shared-browser-control_livetest.md` records, on **2026-08-18**, a control
snapshot of *this exact URL* (`https://www.bing.com/webmasters/about`) on the same node returning
**the full page text**, and used that control to conclude an empty `text` seen elsewhere was
tab-specific rather than a gateway defect. That observation was correct on the day, and it is not
being overturned.

What changed is the environment, and it is datable: `list_remote_nodes` reports
`extensionReloadedAt: 1787125610083` = **2026-08-19T07:46:50Z**, i.e. the extension on `windows-pc`
was reloaded this morning, after that control run and before these calls at ~13:50–14:12Z. An
extension reload drops runtime-granted host permissions, which is consistent with the same URL
reading fine yesterday and returning the host-permission error today.

That is the point. The host-permission state **changed silently under a running system**, and on both
sides of that change `browser.snapshot` reported `outcome: "succeeded"`. Nothing visibly broke; the
capture just went empty. A caller comparing yesterday's snapshot to today's would see a page that
"lost its content", not a permission that lapsed. The code-level root cause above is proven from
source and is independent of when the permissions changed.

## LT-221: opening a context-evidence record's card always failed with EVIDENCE_AUDIT_FAILED — a stale SQL CHECK constraint, fixed with a schema migration

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Batch N1, driving check 7 (UI inspection) of the provider-agnostic-context-evidence livetest doc, live
in the real renderer (isolated dev app, `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-N1`, port 9601, CDP with
focus emulation — not a stale-render artifact). `contextEvidenceModeByProvider.claude` set to
`'shadow'` via `setSetting`; a real `claude` instance (`ccg2d60d1`) made real tool calls (`Read` on two
files); the instance context-bar's `.evidence-toggle` button was clicked, opening
`<app-context-evidence-panel>` with real occupancy/metrics/record data rendered — then a real record's
"Open card" button was clicked. The panel rendered `EVIDENCE_AUDIT_FAILED` at the top instead of card
content, in place of the expected card view (exact excerpt / bounded summary). This reproduced on
every attempt, for a fresh conversation and a fresh record.

### Root cause

Confirmed directly against the live SQLite file, not inferred:

```
$ sqlite3 conversation-ledger.db "INSERT INTO evidence_access_log (id,requester,conversation_id,operation,outcome_code,created_at)
  SELECT 'x','r',id,'get-card','OK',1 FROM conversation_threads LIMIT 1;"
Error: stepping, CHECK constraint failed: operation IN ('list', 'search', 'read', 'compare', 'verify')
```

`evidence_access_log`'s `operation` CHECK constraint, defined in migration `004_context_evidence`
(`conversation-ledger-schema.ts`), never included `'get-card'` — even though the column's own
TypeScript type, `EvidenceAccessLogInput.operation`
(`context-evidence-ledger.types.ts:189` — `'list' | 'get-card' | 'search' | 'read' | 'compare' |
'verify'`), always declared `'get-card'` valid. The SQL and the type drifted apart. Every
`contextEvidenceGetCard` call routes through `evidence-card-retrieval.ts`'s `audit()` helper, which
always logs `operation: 'get-card'` (line 190) before allowing the card read to proceed; that insert
always violated the CHECK constraint, `ContextEvidenceLedgerStore.logEvidenceAccess()` always threw,
and the calling code's bare `catch { throw new EvidenceRetrievalError('EVIDENCE_AUDIT_FAILED') }`
(`evidence-card-retrieval.ts:196-198`, and the identical pattern at
`evidence-retrieval-service.ts:648`) discarded the real SQLite error and re-threw only the generic
code — which is why this bug's actual cause was invisible in logs for however long it existed.
`list`/`search`/`read`/`compare`/`verify` were unaffected; only `get-card` — i.e. only the "Open card"
button — was broken, on every provider, every conversation, unconditionally.

### Fix

SQLite cannot `ALTER` an existing `CHECK` constraint, so a new migration (`005_evidence_access_log_get_card`,
`conversation-ledger-schema.ts`, `CONVERSATION_LEDGER_SCHEMA_VERSION` bumped 4→5) rebuilds the table
using the same rename→create→copy→drop pattern already established elsewhere in this codebase
(`rlm-migrations-022-035.ts`): `evidence_access_log` renamed to `evidence_access_log_004`, a new
`evidence_access_log` created with `'get-card'` added to the CHECK list, existing rows copied across,
the renamed table dropped, and the `idx_evidence_access_log_conversation_created` index recreated. This
runs automatically for every existing installation (via `runConversationLedgerMigrations()`'s
sequential apply-by-version loop) and for fresh installs alike (which also apply migrations 1-5 in
order, not just the initial schema).

**Verified.** New regression test in `conversation-ledger-schema.spec.ts` ("LT-221: allows a get-card
evidence_access_log row and preserves existing rows across the rebuild") — reverted the fix via a
`/tmp` copy of the pre-fix file and watched **2 tests fail**: the schema-version assertion
(`expected 4 to be 5`) and the new test itself
(`expected [Function] to not throw an error but 'SQLite3Error: SQLITE_CONSTRAINT_CHECK…' was thrown`,
reproducing the exact live error shape) — then restored the fix and confirmed all 4 tests in that file
pass, plus 65/65 across `src/main/conversation-ledger` and 302/302 across `src/main/context-evidence`
unaffected. `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, and `npm run build:main` all clean.

### Not fixed, out of scope this session

The swallow-and-rethrow pattern (`catch { throw new EvidenceRetrievalError(...) }`, discarding the
real underlying error with no `logger.warn`/`logger.error` call) exists at both
`evidence-card-retrieval.ts:196-198` and `evidence-retrieval-service.ts:648` and is what made this bug
invisible in `app.log` for as long as it existed — the schema fix above resolves the reproduced defect,
but the observability gap that let it hide is still present for whatever the next `logEvidenceAccess`
failure turns out to be. Flagged, not fixed, to keep this ticket's scope to the reproduced behavioural
defect.

## LT-222: the app-wide log redactor turns a legitimate `null` under any token-shaped key into the literal string "<redacted-secret>"

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

Found while advancing the Codex context-pressure observability livetest's residual (running the
analyzer/privacy-validator pipeline against real diagnostic data for the first time). A real Codex
baseline turn (`AIO_CODEX_CONTEXT_DIAGNOSTICS=1`, isolated dev app, real `codex` instance) produced 6
`CodexContextDiagnostics` log lines; `scripts/analyze-codex-context-pressure.ts` reported 3 of 6 as
malformed. Direct inspection of the raw log lines found the cause: `{"kind":"turn-start", …,
"baselineUsedTokens":"<redacted-secret>"}` and `{"kind":"token-usage", …,
"previousLastTotalTokens":"<redacted-secret>"}` — both fields are typed `number | null`
(`context-pressure-diagnostics.ts`) and legitimately `null` on a session's first turn/request (no prior
baseline/request exists yet), but both key names contain the substring `token`, tripping
`SECRET_KEY_PATTERN` (`/(api[_-]?key|token|secret|password|credential|authorization|cookie)/i`,
`redaction.ts:98`).

`redactSecretField()` (`redaction.ts:174-188`) — the function every secret-shaped key's value is routed
through by `redactValue()`, which every `logger.info`/`warn`/etc. call in the app goes through via
`redactForSink()` (`logger.ts:246`) — correctly passes `number`/`boolean` values through unredacted
(matching the intent documented in the sibling `redactSpanAttributes()`'s own comment: *"numbers/
booleans under secret-shaped keys… pass through"*), but had no explicit case for `null`/`undefined`:
`typeof null` is `'object'`, so it fell through every `typeof` check into the function's final
`return '<redacted-secret>'` — turning a real `null` into the four-word **string**
`"<redacted-secret>"`. `redactSpanAttributes()`'s own inline equivalent (`typeof value === 'string' ?
'<redacted-secret>' : value`) already passed non-strings through correctly, including `null`; only
`redactSecretField()`, the general JSON-sink path, had the gap.

**Blast radius beyond this one doc.** This function is not specific to Codex diagnostics — it is the
redaction primitive for every structured log call in the app. Any `number | null` (or any non-string,
non-boolean, non-number) field logged under a key containing "token", "secret", "password",
"credential", "authorization", or "cookie" would suffer the identical corruption the instant its real
value was `null`/`undefined`, silently turning a typed field into an untyped string for any downstream
consumer that parses `app.log`.

**Fixed.** `redactSecretField()` now returns `null`/`undefined` unchanged, before the `typeof` checks —
a minimal, strictly-widening change (nothing that was correctly redacted before is now passed through;
only the previously-mishandled `null`/`undefined` case changes). Verified: new regression test
(`redaction.spec.ts`, "LT-222…") watched **fail** against the pre-fix source
(`expected '<redacted-secret>' to be null`) via a `/tmp` copy, then pass after restoring the fix; 33/33
`src/main/diagnostics` and 23/23 `src/main/logging` tests unaffected. Rebuilt (`npm run build:main`),
dev app restarted, and the identical live scenario re-run: the same two fields now log as real `null`,
and the analyzer accepts all 6 records with 0 malformed (down from 3 malformed pre-fix) — confirmed
live, not just at the unit-test level.

## LT-223: the context-pressure analyzer's own itemClass allowlist drifted from LT-148's fix and rejects every real `user-message` record as malformed

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

Same live session as LT-222, same real Codex baseline turn. After fixing LT-222, the analyzer still
reported 1 of 6 records malformed — the turn's `item-completed` record for `itemClass: 'user-message'`
(the user's own 18,508-byte turn echo). Traced to source: `scripts/codex-context-pressure/types.ts`'s
`ItemClass` type and its `ITEM_CLASSES` validation `Set` — the analyzer's own, separately-maintained
copy of the valid `itemClass` values — never included `'user-message'`, even though
`classifyCodexObservedItem()`'s real return type,
[`CodexObservedItemClass`](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md)
(`src/main/cli/adapters/codex/context-pressure-diagnostics.ts`), has included it since **LT-148**
(2026-08-18) fixed the classifier to stop miscounting the user's own turn echo as a tool-bearing item.
LT-148's fix shipped correctly in the runtime classifier; this analyzer script's duplicated allowlist
was simply never updated to match, so every real `user-message` record it now correctly produces —
i.e. the exact shape LT-148 exists to create — was rejected as malformed by the tool meant to analyze
it. The doc's own §11 privacy-validator snippet independently carries the same stale allowlist (its
`strings` set), and would flag a legitimate `'user-message'` value as a "privacy failure" for the same
reason — confirmed by running the literal snippet against real post-fix output before correcting it.

**Fixed.** Added `'user-message'` to `ItemClass`/`ITEM_CLASSES`
(`scripts/codex-context-pressure/types.ts`) and to the livetest doc's own §11 `strings` allowlist
(a documentation-content correction, not a behavior change). Verified: new regression test
(`analyze-codex-context-pressure.spec.ts`, "LT-223…") watched **fail** against the pre-fix source via a
`/tmp` copy, then pass after restoring the fix. Re-ran the analyzer against the identical real log range
used for LT-222's live confirmation: **6/6 accepted, 0 malformed** (up from 5/6 and 4/6 across the two
fixes), and `report.md`'s item-size table now correctly lists a `user-message` row. Also ran the
corrected §11 privacy-validator snippet against the same real output: **passes** (file existence,
structural schema/string allowlist, forbidden-source-value scan, and manual table inspection — all four
steps), with the doc's own snippet now current.

## LT-280: the context-evidence panel is fully built to label degraded (corrupt/failed/deleted/staging) records, but `list()` structurally never lets any reach it

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Batch P2, driving check 7's third named residual item ("view a corrupt/deleted record if present")
of the provider-agnostic-context-evidence livetest doc, live in an isolated dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-P2`, port 9612, focus-emulated CDP). Set
`contextEvidenceModeByProvider.claude = 'shadow'`, created a real chat (`ChatStore.create`, provider
`claude`) rather than reusing the instance-list path — this exercises the chat-owned evidence scope
(`owner.kind: 'chat'`) for the first time in this doc's history. Sent a real turn with two tool calls
(`Read` on a 13.8 KB synthetic file, `Read` on a 12-byte file), producing two real evidence records.
Confirmed the chat-header `.evidence-toggle` (a separate residual item) renders the real panel. Opened
the large record's card and paginated "Inspect" through all 4 pages to `byteCount` exactly (bytes
0–4000, 4000–8000, 8000–12000, 12000–14896), confirming that residual item too — both via direct DOM
button clicks, not just component-method calls.

Then, to test the corrupt/deleted item: set the small record's `status` directly to `'corrupt'` via
the ledger DB (`sqlite3 conversation-ledger.db "UPDATE evidence_records SET status='corrupt' WHERE
id=...`), then called the panel's own `store.refresh()`. The record **disappeared from the list
entirely** — not shown-and-labeled, not shown-and-disabled, simply absent, as if it had never been
captured. Identical result for `status: 'deleted'`.

### Root cause

The panel's own file-header contract (`context-evidence-panel.component.ts:16-19`) states plainly:
*"degraded evidence statuses (corrupt, failed, deleted, staging) are always visibly labeled, never
presented as complete."* The rendering side of that contract is fully implemented and correctly wired:
`statusLabel()`/`statusDisclosure()`/`isDegradedStatus()` (lines 70-97) handle all five statuses
including `'staging'` ("Staging (capturing)" / "Still capturing — not yet available for inspection.");
the template binds `[class.degraded]="getIsDegradedStatus(record.status)"`,
`{{ getStatusLabel(record.status) }}`, and `{{ disclosure }}` per record
(`context-evidence-panel.component.html:91-110`); `canInspect()` correctly gates "Inspect" on
`status === 'complete'`.

None of it can ever run, because the data never arrives. `EvidenceRetrievalService.list()`
(`src/main/context-evidence/evidence-retrieval-service.ts:156-163`, pre-fix) called:

```ts
const records = await this.options.ledger.listEvidence(input.conversationId, {
  limit: input.limit,
});
```

— never passing `includeMaintenanceStates`. `ContextEvidenceLedgerStore.listEvidence()`
(`context-evidence-ledger-store.ts:164-172`) applies, by default:

```ts
if (!query.includeMaintenanceStates) where.push("evidence_records.status = 'complete'");
```

So every call through this method — which is the **only** method backing both the renderer's
`contextEvidenceList` IPC channel (`context-evidence.handlers.ts:112-124`) and the `evidence_list` MCP
tool (`orchestrator-evidence-tools.ts:94-109`) — silently excludes `staging`/`failed`/`corrupt`/
`deleted` records. `listEvidenceForMaintenance()` is the only other reader capable of returning those
statuses, and it is used exclusively by the internal background `evidence-maintenance-service.ts`
(cleanup/GC), never exposed via any IPC handler or MCP tool. There was, structurally, no path for a
degraded record's existence to ever reach a human or an agent — it just silently vanished, with no
error, no count, no indication anything had gone wrong with a piece of evidence that had previously
been captured successfully.

### Fix

`EvidenceRetrievalService.list()` now passes `includeMaintenanceStates: true` unconditionally. Per-record
authorization (`this.authorize(record, input.requester)`, unrelated to completeness status) still governs
what a given requester may see; corrupt/deleted records carry no readable content regardless (`canInspect`
already gates on `status === 'complete'`, and `getCard()` correctly fails with `EVIDENCE_CARD_NOT_FOUND`
for a record with no card), so surfacing their metadata is safe — no raw content is newly exposed, only
the previously-invisible fact of the record's existence and status.

**Verified.** New regression test in `evidence-retrieval-service.spec.ts` ("asks the ledger to include
maintenance-state (corrupt/failed/deleted/staging) records, not just complete ones") — watched it
**fail** against the pre-fix source (`expected "spy" to be called with arguments... includeMaintenanceStates:
true`, received `{ limit: undefined }` with no such key), then pass after applying the fix. 37 files / 379
tests across `src/main/context-evidence`, `src/main/conversation-ledger`,
`context-evidence.handlers.spec.ts`, and `orchestrator-evidence-tools.spec.ts` unaffected. `npx tsc
--noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and
`npm run build:main` all clean. Live-reproduced end-to-end after rebuild + dev-app restart: the same
corrupt record now renders with the "Corrupt" badge and the disclosure text "Evidence is corrupt — raw
bytes cannot be trusted." (and, separately, "Evidence has been deleted — content is no longer
available." for `status: 'deleted'`); "Inspect" is correctly `disabled` for it; "Open card" fails
cleanly with `EVIDENCE_CARD_NOT_FOUND` rather than crashing or exposing untrusted content.

## LT-290: fable-ws16 check 5's `lessons` recall-trace surface had zero production `record()` callers — structurally could never hold a trace

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Batch P3, driving fable-ws16 checks 5 (`lessons` third) and 6, per this wave's brief. Before chasing
another expensive live-loop attempt, read `RecallTraceStore` and every production caller
(`grep -rn "getRecallTraceStore()" src/main/ --include="*.ts" | grep -v spec`) end to end: exactly
three call sites exist — `context-search.ts:256` (`record`, surface `rlm`), `code-retrieval-service.ts:68`
(`record`, surface `codemem`), and `loop-lesson-use-credit.ts:29` (`markUsed('lessons', …)` only, no
`record`). `markUsed()` (`recall-trace-store.ts:111-130`) filters `this.traces` by `trace.surface`
and can only credit a trace that already exists — with zero production `record({surface: 'lessons'})`
calls anywhere, `getRecallTraceStore().bySurface('lessons')` was permanently empty and `markUsed`
was a guaranteed no-op, regardless of how the loop was driven or how many times it was retried.

### Root cause

`getLessonStore().digest(limit)` is called at loop start (`loop-coordinator.ts`'s `surfaceLearnings`
closure inside `assemblePlanStageContext`'s injected sources) and pushes the surfaced lessons into
`surfacedLessonsForRun` for later crediting — but nothing at that call site ever recorded a
`RecallTraceStore` trace for them. The doc's own "as-built" note (fable-ws16 check 5, written earlier
in this doc's history) read `loop-lesson-use-credit.ts`'s `markUsed()` call as evidence the `lessons`
surface was "wired," which is the mistake: crediting an item and recording a trace for it are two
different operations, and only the second one ever ran.

### Fix

`loop-coordinator.ts`'s `surfaceLearnings` closure now calls `getRecallTraceStore().record({surface:
'lessons', query: config.initialPrompt, returned: …})` whenever `digest()` surfaces at least one
lesson, with a rank-ordered score (`1 - i / surfaced.length`) since lessons have no query-similarity
score the way codemem/rlm hits do (`digest()` is already most-reinforced-first).

**Verified.** New regression test in `loop-coordinator-memory.spec.ts` ("LT-29x: records a recall
trace on the lessons surface when a lesson is surfaced at loop start") — seeds a real lesson via the
real `LessonStore` singleton, starts a real `LoopCoordinator.startLoop()`, and asserts
`getRecallTraceStore().bySurface('lessons')` is non-empty and contains the seeded lesson's id.
Watched it **fail** against the pre-fix source (`expected 0 to be greater than 0`) via a `/tmp` copy,
then restored and confirmed green (2/2 in that file). `npx tsc --noEmit` (both configs), `npm run
lint`, `npm run check:ts-max-loc` (had to trim the fix's own comments to stay within
`loop-coordinator.ts`'s +50 tolerance — see LT-291's note, same file), and `npm run build:main` all
clean.

Live end-to-end re-verification (not just the unit test): rebuilt `dist/main`, restarted the dev app
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-P3`, port 9613), seeded a real lesson (`lesson-uy6v89`) into the
running main process's `LessonStore` singleton via `--inspect=9713`, then started a real loop over CDP
(`loop-1787166879293-5e633139`, provider `claude`, workspace `/tmp/aio-lt-P3-ws16`). Immediately after
start, `getRecallTraceStore().bySurface('lessons')` (queried live via the same inspector port) held
exactly one trace: `{surface: 'lessons', returned: [{id: 'lesson-uy6v89', score: 1}], usedIds:
['lesson-uy6v89']}` — the `usedIds` entry present because the loop had by then also completed and
credited it (see LT-291).

### Note on the check's `rlm` third

Unchanged this session: `rlm`'s `record()` call in `context-search.ts` only fires when the vector store
returns hits, and nothing indexes context stores for semantic search in production
(`RLMContextManager.indexStoreForSemanticSearch()` has no production caller) — already filed as
**LT-055**, an open product decision (lazy/eager/explicit indexing tradeoff), not re-litigated here.

## LT-291: fable-ws16 check 6's reinforcement-on-use could never fire on a genuinely successful loop — the convergence note is never populated on that path, contrary to its own "always-present" doc comment

**Status: FIXED + REGRESSION-TESTED 2026-08-19.**

### Observed behaviour

Same session as LT-290. `creditSurfacedLessonUse(surfaced, outcomeText)` (`loop-lesson-use-credit.ts`)
is called at `terminate()` with `outcomeText = this.completionContext.getConvergenceNote(state.id)`
and bails out immediately when `!outcomeText?.trim()`. Traced every `setConvergenceNote` call site in
`loop-coordinator.ts` and `evidence-resolver.ts`: the accepted-completion branch (`decision: 'stop'`,
the normal successful-loop path) returns `convergenceNote: null` explicitly (comment: "coordinator sets
this itself with reviewer details"), and no code anywhere else in the success path ever sets one — only
stall/pause/blocked-review branches populate it, each with system-generated text describing the
obstacle (e.g. "review-driven stall: …"), never anything a surfaced lesson's wording could plausibly
match. So on the single most common outcome — a loop that finishes cleanly — `outcomeText` was always
`undefined`, and `creditSurfacedLessonUse` never had a chance to run, independent of whether a
cross-model reviewer ran, blocked, or found anything.

This explains why two same-day prior attempts on this exact doc (documented in the
"2026-08-19 (Batch N2)" evidence-run section) never captured a lesson via check 6, and why the
mechanism they were testing (`completion.crossModelReview.enabled` → `captureReviewLessonForVerdict`)
was never going to produce this specific check's evidence: that is a *different* lesson-related
capability (a NEW lesson distilled from a *blocking* cross-model review finding, written via
`getLessonStore().capture()`) that never touches `RecallTraceStore` and never logs "Reinforced surfaced
lessons on use" — the log line and DB field check 6 actually names. Both are real, but only the
`creditSurfacedLessonUse` path is check 6's mechanism.

### Root cause

`loop-lesson-use-credit.ts`'s own module doc comment states the convergence note is "the cheapest,
always-present signal" — a factual claim about the code's own contract that the code did not honour on
its most common path.

### Fix

`terminate()` (`loop-coordinator.ts`) now passes `this.completionContext.getConvergenceNote(state.id)
?? state.terminalIntentHistory?.at(-1)?.summary` — falling back to the accepted terminal intent's own
summary text, which genuinely is present whenever a loop reaches `'completed'` via the real
`aio-loop-control complete --summary` mechanism (`loop-completion-detector.ts`'s `'declared-complete'`
signal is sourced exclusively from `state.terminalIntentPending?.kind === 'complete'`) — the same
mechanism real agent CLIs use in production to declare done, not a synthetic test-only path.

**Verified.** New regression test in `loop-coordinator-terminal-intents.spec.ts` ("LT-29x: reinforces a
surfaced lesson on use when the declared-complete summary echoes it, on a clean successful
completion") — seeds a real lesson, drives a real loop through `aio-loop-control complete --summary`
with wording that echoes the lesson, and asserts `getLessonStore().get(id).uses === 1` and the trace's
`usedIds` includes it. Watched it **fail** against the pre-fix source (`expected +0 to be 1`) via a
`/tmp` copy, then restored and confirmed green (18/18 in that file, no regressions). `npx tsc --noEmit`
(both configs), `npm run lint`, `npm run check:ts-max-loc` (both this fix and LT-290 live in
`loop-coordinator.ts`, which was already within 6 lines of its ratchet ceiling before either change —
comments for both fixes were trimmed to land at 3919/3921 lines), and `npm run build:main` all clean.

Live end-to-end re-verification: same real loop as LT-290 (`loop-1787166879293-5e633139`, a real
Claude CLI turn instructed to include specific wording in its `aio-loop-control complete --summary`
call). `app.log` shows, at the loop's exact termination timestamp:
`{"subsystem":"LoopLessonUseCredit","message":"Reinforced surfaced lessons on use","data":{"count":1}}`
immediately followed by `{"subsystem":"LoopCoordinator","message":"Loop terminated",
"data":{"status":"completed","reason":"signal=declared-complete"}}`. Queried the live `LessonStore`
singleton via `--inspect=9713`: the seeded lesson's `reinforcements` went `1 → 2` and `uses` went
`0 → 1`, `updatedAt` matching the log timestamp to the millisecond.

## LT-270: the automatic 4x-cumulative context-cost governor has no measurable path to reducing real cost on this Codex build — DECIDED + RESCOPED

[Read the detail](livetest-remediation-register-archive-2026.md#lt-270-archived-detail).

### What was measured, versus what was inferred

[Read the detail](livetest-remediation-register-archive-2026.md#lt-270-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-270-archived-detail).

### Required behaviour — not decided here

[Read the detail](livetest-remediation-register-archive-2026.md#lt-270-archived-detail).

### Acceptance — what would falsify this finding

[Read the detail](livetest-remediation-register-archive-2026.md#lt-270-archived-detail).

## LT-371: short worker-socket losses churn the entire remote-browser channel and can strand a command before handoff

### Observed behaviour

The packaged app's reliability log contains 30 `node_disconnect`, 53 `node_reconnect`, 27
`attachment_suspended`, 22 `attachment_restored`, and 14 `attachment_superseded` events. A disconnect
with active inventory suspends all 21 shared `windows-pc` tabs; many reconnects restore the same 21.
Re-deriving worker-socket registration times rather than pairing reliability events by eye found all
30 disconnects eventually re-registered: minimum 1.556 seconds, median 10.556 seconds, 75th percentile
24.739 seconds, and 24/30 inside 30 seconds. The intervals between drops vary from about 1 minute to
more than a day, with no 30-second cadence and no general load correlation. One long event coincided
with coordinator sleep; the rest are short, randomly spaced transport losses.

The discriminating test was to compare all three channel layers over the same window. `browser.health`
reported `serviceWorkerRestarts: 0`; read-only worker logs showed thousands of continuous extension
poll-heartbeat records, no native-host errors, one continuous worker process across the main event
window, and 63 coordinator-socket closes (61 with WebSocket code 1006). In the coordinator log,
`WorkerNodeConnection Node WebSocket disconnected` immediately precedes every reliability
`node_disconnect`. `RemoteBrowserExtensionBridge.expireNode()` is also only called by the
`node:ws-disconnected` route. Therefore the dropping side is the worker-node WebSocket transport, not
Chrome MV3 eviction and not the extension/native-host hop. `list_remote_nodes` showing a healthy node
seconds later proved recovery, not continuity.

The 53-vs-30 asymmetry has two source-backed causes: `node_reconnect` records both a lost-channel
recovery and first extension contact after re-registration when attachments are restored, including
zero-attachment transitions; and the coordinator logged 36 replacement sockets whose superseded
socket later closed while the new socket remained active. The worker logs show sequential lifecycle
streams with one instance id, ruling out concurrent duplicate worker processes.

The same socket boundary explains the intermittent command symptom. `pollCommand()` shifts a command
and arms its delivered/receipt timer before `RpcEventRouter` sends the poll RPC response. Responses
were addressed only by `nodeId`, so there were two losing cases: no socket was open, or the old poll
resolved after the node re-registered and `sendResponse()` wrote the old request id onto the replacement
socket. The worker had already removed the old request on close and ignored that response id. In both
cases the command was no longer queued even though it never reached the extension, so a receipt-capable
queue later raised `browser_extension_command_receipt_missing`.

### Root cause

The worker connection lifecycle allows only 2.5 seconds for re-registration, despite the remote-node
UX contract's 30-second grace and an observed median recovery above 10 seconds. Once that undersized
timer expires, the router deregisters the node and `expireNode()` suspends every attachment and
rejects the browser-command queue. Separately, inbound requests lost their source-socket identity at
the connection event boundary. A response selected whichever socket was currently mapped to the node
id, so the browser poll route could neither distinguish no socket from a replacement socket nor undo
its delivered transition safely.

### Required behaviour

- Hold the worker registry entry, browser attachments, and pending RPC state for 30 seconds after an
  active socket closes; cancel the disconnect if the same node re-registers inside that window.
- Bind every inbound RPC response to its requesting socket. When a non-null browser poll result cannot
  be handed to that still-active socket, return the exact command to its original queue and its
  original absolute undelivered deadline.
- Preserve FIFO order while handoff is uncertain: later commands and replacement pollers must wait;
  a failed handoff puts the original command at the queue head, while an already-expired original
  deadline rejects that command and releases later work.
- Never replay a command after its response was accepted by an open socket or after a receipt arrived;
  those states are execution-ambiguous and must retain the existing receipt/execution semantics.
- A sustained disconnect beyond 30 seconds must still emit the true disconnect, suspend attachments,
  and reject the queue as before.

### Acceptance

- A fake-timer regression proves no true-disconnect callbacks at 29,999 ms and the existing
  disconnect behaviour at 30,000 ms.
- Connection, command-store, and RPC-router regressions prove an old request never writes onto a
  replacement socket; an unsent poll result is requeued once with the same command id, remains bounded
  by its original delivery deadline, retains FIFO order ahead of later work, survives the receipt
  window, and resolves normally on the new poll; an expired uncertain command releases later work;
  a null poll and a response accepted by its requesting socket are not requeued.
- Focused tests, both TypeScript checks, lint, LOC ratchet, main build, and the full test suite pass,
  followed by a fresh independent completion-gate PASS.
- Live closure requires the rebuilt/restarted coordinator; LT-371 itself does not require a new worker,
  extension, or native-host build. Observe that
  a natural or James-approved sub-30-second worker-socket loss produces no `node_disconnect`, no
  21-attachment suspend/restore churn, and no false receipt-missing failure. The separate superseded-
  generation check remains pending until its deliberate restart-and-wait sequence is observed.

## LT-370: the quality-tier auto-pick chooses the largest advertised model, which the host cannot load

**Status: FIXED + REGRESSION-TESTED 2026-08-24; live confirmation pending a rebuilt app. Root cause
corrected the same day — the 2026-08-20 diagnosis was wrong and would have sent the next reader the
wrong way.**

### Observed behaviour

One `browser.snapshot` carrying an `extractionHint`, taken on 2026-08-20 with
`browserAuxExtractionEnabled` ON, produced in `~/Library/Application Support/harness/logs/app.log`:

```
1787345477010 info  WorkerNodeConnection  Remote node: dispatching work
                    {method: "auxiliaryModel.generate", requestId: "coord-8438",
                     provider: "ollama", model: "gpt-oss:120b"}
1787345485971 warn  WorkerNodeConnection  Remote node: work failed
                    {requestId: "coord-8438", latencyMs: 8961,
                     error: "-32603: Ollama generate failed: 500"}
1787345485972 warn  AuxiliaryLlmService   Auxiliary generation failed for slot "webExtract":
                    RPC error -32603: Ollama generate failed: 500
```

The two records are the same request (`coord-8438`) one millisecond apart, which is what the original
entry was missing when it wrote *"the exact model string sent on that call was not captured"*.

Across the whole log the tally is:

| provider / model | dispatches |
| --- | --- |
| `ollama` / `deepseek-r1:7b` | 143 |
| `ollama` / `gpt-oss:120b` | 1 |

The single `gpt-oss:120b` dispatch is the one that failed. Every other auxiliary dispatch on this
machine succeeded.

### Root cause

`gpt-oss:120b` **is** advertised by the endpoint — it is one of the eight models `windows-pc`'s Ollama
serves. So the failure is not "asked for a model it has never had".

The configured tier model is never sent at all. `tryEndpointForSlot`
(`src/main/rlm/auxiliary-llm-service.ts`) resolves `preferred = resolveSlotModel(...)` and then gates
it:

```ts
if (preferred && endpointAdvertisesModel(ep.source, preferred, ids)) { return { endpoint: ep, model: preferred, … }; }
if (ids.length === 0) return null;
const picked = pickModelForTier(ids, tier, loaded);
```

`endpointAdvertisesModel` (`auxiliary-llm-utils.ts:22`) returns false for a **worker-node** endpoint
whose non-empty list lacks the id — the worker's list comes from its heartbeat and is treated as
authoritative. So `qwen/qwen3.6-35b-a3b` is silently and correctly discarded, and the code falls
through to the auto-pick. **The originally recommended fix — "point the tier models at ids the
endpoint actually serves" — would therefore have changed nothing about this failure**, because the
configured id was already being bypassed.

The defect is in the auto-pick. `pickModelForTier` (`auxiliary-llm-utils.ts:266`) restricts the pool
to **resident** models when any are resident, precisely to avoid a JIT-load at a bad context size. When
nothing is resident that restriction does not engage, and `quality` then takes the *largest* candidate
by `modelSizeScore`:

- `gpt-oss:120b` → 120 ← chosen
- `deepseek-r1:32b` → 32, `gemma4:31b` → 31, `qwen3-coder:30b` → 30, `gpt-oss:20b` → 20, `deepseek-r1:14b` → 14, `deepseek-r1:7b` → 7, `llama3.3:latest` → 0

`list_remote_nodes` reports `windows-pc` as `gpuName: "NVIDIA GeForce RTX 5090", gpuMemoryMB: 32607`.
A 120B model cannot be made resident in 32 GB, so Ollama attempts the load and fails. The **8961 ms**
latency is the tell: an unknown-model rejection returns immediately, a failed load takes seconds.

### Impact — narrower than the original entry claimed

The original entry said "the entire local-AI cost-saving path is silently inert" and "every aux slot on
this machine is affected". Both are false. The 143 successful `deepseek-r1:7b` dispatches are quick-tier
slots working normally — quick tier auto-picks the *smallest* candidate, which loads fine.

- **Broken (quality tier):** `compression`, `memoryDistillation`, `webExtract`, `approvalAdjudication`,
  `subQueryExecution`, `verifyOutputSummary`.
- **Working (quick tier):** `titleGeneration`, `routingClassification`, `approvalScoring`,
  `loopScoring`, `retrievalHypothesis`, `branchScoring`.

It still fails safe — the slot falls back to the frontier model and, for `webExtract`, the never-worse
guard returns the full raw capture. The real cost is ~9 s of dead wall-clock per quality-tier call plus
the lost local saving on those six slots.

### Required behaviour

A tier auto-pick must not choose a model the endpoint's host cannot actually run. Either of these, or
both:

1. **Negative-cache a model that fails on an endpoint** and re-pick the next candidate down, so the
   first failure is self-correcting rather than permanent. This must apply only to *auto-picked*
   models — an explicit per-slot pin or tier pin should keep surfacing its error rather than silently
   substituting a different model.
2. **Bound the auto-pick by the endpoint host's reported capacity.** `WorkerNodeInfo` already carries
   `gpuMemoryMB`, and `modelSizeScore` already approximates parameter count, so a candidate whose
   estimated working set exceeds the reported memory can be excluded before it is ever tried.

Fix 1 is preferable on its own terms: it needs no hardware heuristic and it degrades correctly on any
endpoint, including ones that report no capacity at all.

### Acceptance

- With no model resident on a 32 GB endpoint advertising `gpt-oss:120b`, a `quality`-tier slot resolves
  to a model that loads, and the generate succeeds rather than returning a 500.
- A pinned model that genuinely fails still surfaces its error; it is not silently replaced.
- A regression test pins the auto-pick behaviour with a candidate list containing an over-large model,
  and fails if `gpt-oss:120b` is selected under the fixed rule.

### As built (2026-08-24)

`AuxiliaryModelFailureCache` in `src/main/rlm/auxiliary-llm-utils.ts` implements option 1. Three call
sites in `src/main/rlm/auxiliary-llm-service.ts`:

- `tryEndpointForSlot` filters the candidate list through `this.modelFailures.usable(ep.id, ids)`
  before `pickModelForTier`, and tags the result `autoPicked: true`.
- `generate`'s catch records `(endpoint.id, model)` **only when `autoPicked`** is set.
- `configure` clears the memo alongside the health cache, so any settings change re-tries everything.

Two properties are deliberate and both are pinned by tests. `usable()` returns the **unfiltered** list
when filtering would leave nothing, so the memo can only ever reorder a choice — it can never turn a
degraded endpoint into no endpoint. And a pinned model is never consulted against the memo, because
substituting an operator's explicit choice would hide the very error they need to see.

Option 2 (bounding by the node's reported `gpuMemoryMB`) was **not** implemented. It needs a
parameter-count-to-VRAM heuristic that would be wrong for quantisation levels and for partial CPU
offload, and option 1 reaches the same end state after one cheap failure with no hardware guessing.

The first independent completion gate returned PASS but caught a real test gap worth recording,
because it is the kind that reads as covered when it is not: the `if (autoPicked)` guard on the
`record` call was **inert**, and dropping it broke no test. A stray write had no observable effect,
because the pinned resolution path does not read the memo either — so the guard was defence in depth
with nothing pinning it.

Closing it needed a two-slot scenario, since the guard is invisible within any single slot: pin
`webExtract` to the over-large model with an explicit per-slot `model`, let it fail, then call the
**unpinned** quality-tier `compression` slot and assert it still attempts that same model on its own
evidence. With the guard dropped, `compression` inherits `webExtract`'s failure and steps down, so the
test fails — verified by mutation. The cache key was also changed from a space-joined string to
`JSON.stringify([endpointId, model])`, removing a theoretical case where an id containing the
separator could alias two different pairs onto one key.

**Not yet observed live.** The running packaged app predates this change, and closing the
browser-gateway-reliability doc's check 1 additionally needs `browserAuxExtractionEnabled` ON, which
is `policyTier: read-only` and not writable from the settings CLI.

## LT-520: a dev app silently steals the machine's Chrome native-messaging manifest from the packaged install

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

### As built (2026-08-24)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

### Live confirmation of the premise (2026-08-24)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-520-archived-detail).

## LT-480: real auto-injected skill activations silently persisted to the wrong database

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

### Impact

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

### As built (2026-08-24)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-480-archived-detail).

## LT-481: the Workboard's Snooze control cannot durably hide a Needs You card — deliberate design, not a wiring bug, but it contradicts this doc's own check scenario

**Status: DECIDED, FIXED and REGRESSION-TESTED 2026-09-06.**

The fork was put to James on 2026-09-06 and he took the fix rather than the removal. Removing a
control users already click is worse than repairing it, and a Needs You lane with no way to defer
a card you have already seen is exactly what makes a workboard unusable when several cards are
blocked on the same external thing.

**The fix.** `WorkboardStore.snoozeItem()` now records the item's attention level at snooze time
(`snoozedSignal: ReadonlyMap<string, AttentionLevel>` replacing the bare id set), and the
hand-raise effect calls the new `snoozeClearedByAttention(current, baseline)`
(`workboard-projection.ts`). A snooze clears only when the item completes (`idle`, always worth
surfacing despite being the least urgent rank) or reaches a loud level strictly more urgent than
its baseline. It survives `working`/`waiting` churn — including `working` → `waiting`, which is a
rank rise carrying no new demand — and survives staying at, or dropping below, its snooze-time
urgency.

Reproduced first with a failing test (`workboard.store.spec.ts`, "a snooze set on an
already-blocked card survives"), which failed 1/21 before the change and passes after. Two further
tests cover the genuine-rise and completion paths. Gates: 77/77 workboard tests, `tsc --noEmit`,
`tsc -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:renderer`
all pass. A live click-through on a rebuilt app is still worth doing and remains listed in the
sibling-audit livetest doc.

Original finding, unchanged:

### Observed behaviour

Driving check C2 ("put instances into failed/error/degraded states... snooze hides a card until it
raises its hand") for the first time in this doc's history (five prior evidence-run sessions all
bucketed C2 as "NOT RUN — needs a mobile client", without separating its agent-driveable
Workboard/session-picker half from the genuinely-blocked mobile half):

1. A real Claude instance was driven to a genuine `waiting_for_permission` status (asked it to run a
   Bash command with `yoloMode: false`) — attention level `blocked`, in the Needs You lane.
2. The Workboard's real "Needs You" lane and the real session picker's "Needs You" group both showed
   the same instance consistently — **that half of check C2 passes.**
3. Clicked the real DOM `Snooze` button on the card. It disappeared (`"Needs You 0 All clear"`),
   exactly as expected.
4. **Within 2-5 seconds, with the instance's status unchanged the entire time, the card silently
   reappeared** and the button reverted to reading `Snooze` (not `Un-snooze`). Confirmed at the
   signal level, not just the DOM: `WorkboardStore.isSnoozed('instance:c28lwyh77')` read `true`
   immediately after `snoozeItem()`, then `false` again a couple of seconds later, with `store.items()`
   showing the same instance still at `attentionLevel: 'blocked'` throughout — no new event, no
   escalation, nothing changed except time passing.

### Root cause

`WorkboardStore.snoozeItem(itemId)` (`workboard.store.ts`) stores only the item's id in a
`ReadonlySet<string>` — no record of what the item's attention level *was* when it was snoozed. The
"hand-raise" effect that is supposed to auto-clear a snooze "once the item's attention rises" instead
calls `attentionLevelClearsSnooze(item.attentionLevel)` (`workboard-projection.ts:103-105`), which
takes only the item's *current* level:

```ts
export function attentionLevelClearsSnooze(level: AttentionLevel): boolean {
  return level !== 'working' && level !== 'waiting';
}
```

Every item in the Needs You lane is, by construction, `blocked`/`failed`/`review` — none of which is
`'working'` or `'waiting'` — so this function returns `true` unconditionally for anything already in
that lane, regardless of whether its level has genuinely changed since the snooze was set. The
function's name and its doc comment ("auto-clears the moment the item's attention **rises**") imply a
before/after comparison the implementation has no data to make.

### Why this was never caught

Deliberately, not by accident: every existing test in `workboard.store.spec.ts`'s "WS-C2 snooze with
hand-raise" describe block snoozes an item while it is `'busy'` (`working`) and asserts it correctly
un-snoozes on a transition *into* `blocked`/`error`/`idle` — that is the mechanism working exactly as
designed and tested (mute a non-urgent item; reveal it the instant it becomes something you'd want to
know about). Not one test — and, per the store's own doc comment ("callers never need to un-snooze a
genuinely urgent item themselves"), not the original design intent either — covers snoozing an item
that is *already* urgent, which is precisely this doc's own check C2 scenario. The gap is between the
check's literal steps and a narrower, intentional design, not a broken implementation of the intended
design.

### Not filed as a simple fix — two candidate directions, a product call

**(a) Make the comparison baseline-aware.** Record the attention level at the moment of snoozing
(`snoozedIdsSignal` would need to become a `Map<string, AttentionLevel>` rather than a
`Set<string>`), and only auto-clear when the item's *current* level is a genuine change from that
baseline — this would make the Snooze button behave the way check C2's steps assume, and would still
preserve every existing test's semantics for the working→blocked transition (a baseline of `working`
compared against a new `blocked` level is still a change, so it would still clear).

**(b) Don't offer a Snooze control on Needs You cards at all.** The mechanism was only ever built and
tested for working/waiting items; a control that visibly appears to work for a second or two and then
silently reverts, with no error and no indication to the user, is arguably worse than not offering the
control there in the first place.

Choosing between "broaden the mechanism to support the check's scenario" and "don't expose a control
that structurally cannot do what a user would expect it to do" is a product decision, not an agent's
call — matching this campaign's established precedent for the same shape of gap (LT-220's Antigravity
premise correction, doc 2's check 2/check 4 threshold and precondition questions).

### Required behaviour (once decided)

If (a): a card snoozed from the Needs You lane stays hidden until its attention level genuinely
changes (escalates or resolves) from what it was at snooze time — not merely "is currently non-working".

If (b): the Snooze control is not rendered (or is disabled with an explanatory tooltip) for cards in
the Needs You lane specifically.

### Acceptance (once decided)

- Whichever direction is chosen, add a new `workboard.store.spec.ts` test that snoozes an item while
  it is already `blocked`/`failed` and asserts the chosen behaviour (stays hidden vs. control absent),
  alongside the existing working→blocked tests, which must continue to pass unmodified.

## LT-441: hardened mode does not confine a resident Claude session's own `CLAUDE_CONFIG_DIR` writes

**Status: product-path guard implemented and regression-tested 2026-09-23; original resident OS
write escape remains unverified.** The root cause is still not isolated to a syscall.
Section added by the orchestrating session so this item is not left as an index row with no entry —
the full investigation and its reasoning live in the
[implementation-status section](2026-07-19-livetest-failure-remediation_plan_completed.md).

### Observed behaviour

A hardened (Seatbelt) Claude instance, started with `CLAUDE_CONFIG_DIR` pointed at a fresh directory
under `~/Desktop` — deliberately outside every granted `WRITABLE_ROOT_n` — wrote its own config
bootstrap there successfully: `.claude.json`, a timestamped backup, and `sessions/`. Reproduced 3 of
3 times across independent throwaway instances. The expected denial (and the denial-crash the WS13
checks were trying to stage) never occurred.

### Root cause — what was ruled out, and what remains

The jail is engaged and is not globally bypassed. Each of these was checked rather than assumed:

- `app.log` recorded `Spawning CLI under Seatbelt hardened mode` with the correct 7-root default set
  on every spawn.
- An independent `child_process.spawn` capture recorded the literal `sandbox-exec` argv: the base
  policy byte-diffed clean against `resources/sandbox/aio-seatbelt-base.sbpl`, the correct
  `-D WRITABLE_ROOT_n=` params, none of them the Desktop path, and `CLAUDE_CONFIG_DIR` correctly
  threaded through.
- A byte-identical manual replay of that captured policy and root set, via `sandbox-exec` from an
  unsandboxed shell against Claude's one-shot `--print` mode, **correctly denied** the same write.
  So the policy text and the root list are both sound.
- In the same live instance, an ordinary agent-driven tool-call write to a different ungranted path
  was **correctly denied**.
- At the 2026-08-24 reproduction, no production file under `src/main/` referenced
  `CLAUDE_CONFIG_DIR`. That search is now historical: the new spawn guard reads it. A privileged
  process/syscall trace is still needed to identify who performed the observed write.

What is left is specific to something the **resident/stream-json** mode reaches that one-shot mode
does not. Which syscall, which process in the tree, and whether it is a plain `file-write*` the policy
should be denying or an XPC-proxied preference write executed by another process on the client's
behalf, was not isolated — that needs `fs_usage`/DTrace with sudo, or Claude Code's own source.

### Required behaviour

A hardened instance's CLI-internal writes must be confined by the same Seatbelt policy as its
agent-driven tool writes. If a config-bootstrap path genuinely must be writable, it should be an
explicit granted root, not an escape.

### Product-path guard and remaining severity

`resolveHardenedSpawn` now refuses a hardened Claude spawn when its effective `CLAUDE_CONFIG_DIR`
falls outside realpath-resolved writable roots. The check runs before `sandbox-exec` starts and sees
the merged child environment, including ambient values. `createCliAdapter` grants only a routed
Claude account's exact resolved profile home. Tests cover ungranted and sibling paths, inherited
environment values, and the derived-profile grant. The earlier "not reachable through the product"
claim is withdrawn: the inherited environment and account route are real inputs on the product
spawn path. The original resident-mode OS escape remains unresolved until a privileged trace
identifies its write mechanism; this guard limits exposure through the normal product path without
proving the sandbox itself confines that internal write.

### Acceptance

- With `CLAUDE_CONFIG_DIR` pointed outside every granted root, a hardened resident session either
  fails to write there, or the path is an explicitly granted root.
- The existing correct behaviours stay: agent-driven writes to ungranted paths remain denied, and
  one-shot mode remains denied.

### Effect on the checks that found it

This lever did not produce the denial-crash. WS13 checks 10/11 were later closed on 2026-09-20 using
a different interrupt-suppression lever. LT-441's resident write trace remains open in
[Check 8](2026-09-23-outstanding-plans-sweep_livetest.md#check-8--lt-441-resident-claude-confinement-trace).

## LT-521: check 1's "logs show shadow decisions" wording describes a log line that does not exist anywhere in the shadow/enforce decision path — DOC-CORRECTED

[Read the detail](livetest-remediation-register-archive-2026.md#lt-521-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-521-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-521-archived-detail).

### Required behaviour (a decision, not a unilateral fix)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-521-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-521-archived-detail).

## LT-522: every `copilot-account:*` IPC channel rejected every renderer call, because `.strict()` schemas did not declare the preload's auth stamp

**Status: FIXED + MUTATION-CHECKED 2026-08-25.** Live UI confirmation still needs a rebuilt app — see
[the Copilot account routing livetest](../superpowers/plans/2026-08-25-copilot-account-routing_plan_livetest.md).

### Observed behaviour

While sweeping Copilot instance-creation provenance for the automation-provider-exclusions doc, the
packaged app's own logs turned out to contain an error storm on the channels belonging to the account
routing feature committed earlier the same day (`20f534775 copilot routing`):

```
2026-08-25T14:00:24.221Z IPC  IPC validation failed for copilot-account:preview-route
                              {"errors":": Unrecognized key: \"ipcAuthToken\""}
2026-08-25T14:00:24.221Z IPC  IPC validation failed for copilot-account:list
                              {"errors":": Invalid input"}
```

Across the whole retained `app.log` set: **239,644** such warnings, split **119,822 / 119,822** between
exactly those two channels. The perfect 1:1 balance is a single renderer caller issuing both in a hot
retry loop; the entries are ~1 ms apart.

The user-visible consequence is that **Settings › GitHub Copilot Accounts cannot work at all** — listing
profiles, creating one, adding a routing rule, previewing a route, and the Doctor report all fail before
any handler runs.

### Root cause

Three facts that are individually reasonable and jointly fatal:

1. `src/preload/preload.ts:79` builds this domain **with** `withAuth`:
   `...createCopilotAccountDomain(ipcRenderer, IPC_CHANNELS, withAuth)`, and all **15** `ipcRenderer.invoke`
   calls in `src/preload/domains/copilot-account.preload.ts` use it (15 invokes, 15 `withAuth(` uses).
2. `withAuth` (`preload.ts:58-63`) returns `{...payload, ipcAuthToken: ipcAuthToken || undefined}`. The key
   is **always present**, even before sign-in, because an explicitly-`undefined` property is still an own
   key — and that is what `.strict()` refuses. This is why the failure was total rather than intermittent,
   and why it is easy to miss when reading a payload printed by `JSON.stringify`, which omits the key.
3. All 10 payload schemas in `packages/contracts/src/schemas/copilot-account.schemas.ts` were `.strict()`
   and none declared `ipcAuthToken`. `validatedHandler` (`src/main/ipc/validated-handler.ts:38`) runs
   `schema.safeParse(payload)` on the raw payload; nothing strips the stamp first.

`copilot-account:list` fails differently from the rest and the difference is diagnostic:
`CopilotAccountEmptyPayloadSchema` was `z.object({}).strict().or(z.undefined())`, so the stamped payload
fails the strict-object arm *and* the undefined arm, and Zod reports the union failure as the much less
helpful `Invalid input`.

**The convention already existed and this domain missed it.** `packages/contracts/src/schemas/provider.schemas.ts`
and `voice.schemas.ts` — the other two domains preload wires through `withAuth` — both declare
`ipcAuthToken: z.string().optional()` on their payloads.

### Why the test suite stayed green

`src/main/ipc/handlers/copilot-account-handlers.spec.ts` contained **zero** occurrences of `ipcAuthToken`.
It registers the real handlers against a mocked `ipcMain` and invokes them directly — but with bare
payloads (`{ workingDirectory: '/Users/me/work/repo' }`) that the preload never sends. The test double was
faithful to the handler and unfaithful to the caller, so it exercised a payload shape that cannot occur in
production. Same shape of gap as the one recorded for a test double that answered from its own state.

### Required behaviour

Every channel the preload exposes must accept the payload the preload actually sends, in both token states
(not yet issued, and issued), while still refusing keys that have no business crossing this boundary.

### Acceptance

- All 15 `copilot-account:*` channels return a non-`VALIDATION_FAILED` result for an auth-stamped payload,
  with the token both absent and present.
- `.strict()` behaviour is retained: `env`, `copilotHome` and `configPath` are still rejected, and a
  non-string `ipcAuthToken` is still rejected.
- The regression fails if the schema change is reverted.

### Fix

A shared `ipcAuthTokenField = { ipcAuthToken: z.string().optional() }` spread into all 10 payload schemas,
documented in place with why the stamp is accepted and then ignored (main authorises from the sender via
`ensureTrustedSender`, never from this value). Admitting it into the parsed payload was checked to be safe
before choosing this over stripping centrally: `store.createProfile()` and `store.createRule()`
(`src/main/providers/copilot/copilot-account-store.ts:179,298`) build their persisted records field by
field and never spread the input, so the stamp cannot reach disk. A central strip in `validatedHandler`
would have touched every channel in the app for no additional benefit here.

32 regression tests were added covering all 15 channels in both token states plus the strictness controls.
**Mutation-checked:** reverting `copilot-account.schemas.ts` to its committed state and re-running produced
**13 failures** naming `Unrecognized key: "ipcAuthToken"`; restoring it returned 45/45 green.

### Gates

`npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`
and `npm run build:main` all clean; targeted spec 45/45.

## LT-523: orchestration-protocol response injection (`respondToUserAction` and every other `OrchestrationHandler` command reply) bypasses `SessionAdmissionService`, corrupting a genuinely blocked session

**Current status (2026-08-31): FIXED IN CODE; LIVE RE-CHECK PENDING.** Every orchestration response
now passes through the common admission/redelivery delivery path before stdin injection. Blocked
states suppress the write and retain the full response for ready-edge redelivery; the consensus path
uses the same final emitter without a second admission. Failing-first tests cover blocked
user-action suppression and redelivery registration.

**Original status: FOUND, NOT FIXED, 2026-08-25.**

### Observed behaviour

Driving check C2's "approve/confirm works from the Workboard card" sub-assertion (this doc's own
five prior evidence-run sessions had left it untested, needing "a `confirm`/`approve_action`-shaped
request... not attempted this session"). Rather than needing Guardian adjudication or the auxiliary
LLM (both unreachable this session — see B3), a real `approve_action`-shaped `UserActionRequest` was
produced the same way the app itself produces one: a real, live Claude instance was asked to emit the
documented orchestration marker text verbatim
(`:::ORCHESTRATOR_COMMAND:::{"action":"request_user_action","requestType":"approve_action",...}:::END_COMMAND:::`)
in a plain assistant reply. `OrchestrationHandler.processOutput()` parsed it correctly (confirmed via
`app.log`: `"Executing orchestrator command" action: 'request_user_action'`), creating a real pending
`UserActionRequest` (`uar-1787674988272-yw9dwdm`) for the instance. The same instance was then sent a
second, ordinary message asking it to run `ls -la /tmp` via Bash with `yoloMode: false`, driving it to
a genuine `waiting_for_permission` status (`deferred_permission`, `toolUseId:
toolu_01Vdai7yRQW2oAXsXMrHjqso`) — exactly the check's own "put instances into failed/error/degraded
[or blocked] states" scenario, and exactly the condition needed for the Workboard card's Approve/Reject
buttons to render at all (`item().attentionLevel === 'blocked'`).

The real Workboard card (`app-workboard-card`) correctly rendered `Approve Reject Snooze` for the
pending `approve_action` request. Clicking the real DOM `Approve` button correctly called
`respondToUserAction()`, which cleared the card's `pendingRequest` signal (`null`) — the happy-path
half of the check genuinely works. But `app.log` immediately after shows the injected
`"**User responded** to \"approve_action\" - Approved"` system message was delivered straight to
Claude's stdin **while the instance was still `waiting_for_permission` on the unrelated, earlier Bash
call** — the instance's own `outputBuffer` recorded a **second, duplicate** `tool_use` entry for the
identical command (`toolu_017XN7dQsRb5HvKgykPAUGVF`, same `ls -la /tmp`) immediately following the
injected system message, with the original `toolu_01Vdai7...` deferred-permission request never
mentioned again in the log — orphaned, with no route left to answer it (the app tracks only the
current/latest pending permission per instance). Roughly 90 seconds later, `BaseCliAdapter`'s stream-idle
watchdog (unrelated pre-existing mechanism, triggered because the CLI process had gone quiet mid-wait)
attempted an auto-respawn; when the orphaned second permission was then answered via
`respondToInputRequired()`, `DeferredPermissionHandler` correctly wrote the allow decision but the
lifecycle transition was refused: `"Illegal lifecycle transition blocked { instanceId, from:
'waiting_for_permission', to: 'respawning' }"` — the state machine guard prevented a crash, but the
approved permission decision was dropped and the instance was left in `waiting_for_permission`
indefinitely with no live path to recover other than a manual restart/interrupt. (This final collision
shape overlaps LT-137's territory — a late deferred-permission decision racing an in-flight
respawn/interrupt — but LT-137 was reproduced via an explicit `interruptInstance()` call; here nothing
was interrupted, and the race was created upstream, by the unguarded stdin write documented below.)

### Root cause

`OrchestrationHandler.injectResponse()` (`src/main/orchestration/orchestration-handler.ts:1055-1080`)
does nothing but `this.emit('inject-response', instanceId, response)`. The sole listener,
`InstanceOrchestrationManager`'s wiring in `src/main/instance/instance-orchestration.ts:513-560`, calls
`adapter.sendInput(response)` **directly** — serialized per-instance to avoid stdin corruption, but with
**no status check and no call to `SessionAdmissionService`** at any point. Every other automated writer
in the app (automations via `AutomationRunner`, channel/Discord messages, and the `consensus_query`
result path — which explicitly calls `getSessionAdmissionService().registerRedeliveryHandler('consensus',
...)` in this same class's constructor, `orchestration-handler.ts:112-119`) is required to call
`SessionAdmissionService.admitAutomatedWrite()` first, which returns `{kind: 'suppressed', reason:
'awaiting-human'}` for exactly `status === 'waiting_for_permission'`
(`src/main/session/session-admission-service.ts:216-218`) and several other not-ready states
(`interrupting`, `cancelling`, `respawning`, `error`, `terminated`, quota-parked, auth-required). A5's
2026-08-18 evidence run in this same doc live-verified that gate works correctly for automations and
channel messages. But `injectResponse()`/`'inject-response'` — used for **every** `OrchestrationHandler`
command reply, not just `request_user_action`: `spawn_child`, `message_child`, `terminate_child`,
`call_tool`, `report_task_complete`, `report_error`, `get_task_status`, `create_automation`,
`report_result`, `get_child_summary/artifacts/section` — was never wired to it. This is the one
automated-write path in the orchestration subsystem that was missed when `SessionAdmissionService` was
built, structurally, not just for `request_user_action`.

### Measured impact — the storm destroyed the app's retained log history

Quantified after the root cause was settled, because the first pass understated it:

| file | errors | span | rate |
| --- | --- | --- | --- |
| `app.log.4` | 9,098 | 3.3 s | **2,790/s** |
| `app.log.3` | 61,298 | 20.2 s | **3,032/s** |
| `app.log.2` | 61,300 | 22.0 s | **2,781/s** |
| `app.log.1` | 61,262 | 21.5 s | **2,849/s** |
| `app.log` | 46,686 | 5,083.8 s | 9/s |

Full window **13:59:17.194Z → 15:25:08.051Z (85.8 minutes)**. The first ~67 seconds ran at roughly
**2,800–3,000 errors per second**, which rotated **four** ~10 MB log files in about a minute.

That is the part worth flagging beyond the broken feature: **the app's entire retained diagnostic
history was overwritten.** Every rotated file now begins at 13:59:17Z. Two separate live-test batches
this same afternoon hit the consequence without knowing the cause — one recorded that "`app.log` has
rotated past its creation time" and could not establish the provenance of a production record, and a
Copilot-provenance sweep that had previously reached back four weeks could only reach 2026-08-23.
A logging path that can erase the evidence trail this quickly is a second-order defect in its own
right, whatever the triggering caller.

The storm stopped at **15:25:08Z**, 34 seconds after the last Copilot instance creation at 15:24:34Z,
which places the retry loop in a renderer surface that was open at the time rather than in a
background service. It is **not** currently running.

**The running packaged app contains the defect — verified in the shipped bundle, not inferred.**
`app.asar` mtime **2026-08-25T13:36:15Z**, process started **13:44:42Z**. A `strings` grep for the
channel name only proves the channel exists, so the compiled schema itself was extracted:

```
asar extract-file app.asar dist/packages/contracts/src/schemas/copilot-account.schemas.js
grep -c "strict()"      → 15
grep -c "ipcAuthToken"  →  0
```

Fifteen `.strict()` calls and **zero** references to the stamp the preload always sends. So this is
not a source-only finding: the broken schema shipped into the build James is running, and the storm
above is that build's own log.

### Required behaviour

Before `instance-orchestration.ts`'s `'inject-response'` handler calls `adapter.sendInput()`, it must
call `getSessionAdmissionService().admitAutomatedWrite({instanceId, origin: 'orchestration', message:
response, ...})` (or equivalent) and only send when `kind === 'admitted'`. On suppression, register for
redelivery (the same `registerRedeliveryHandler` mechanism already used for `consensus_query`) so the
response is delivered once the instance returns to a ready state, rather than being silently dropped or
corrupting an in-flight tool-permission wait. The Workboard/session-picker card's `Approve`/`Reject`
handlers should reflect this too — e.g. disable or relabel the action, or show a "will deliver once
ready" state, rather than implying the response was delivered immediately when the instance was already
blocked on something else.

### Acceptance

1. A regression test reproducing this run's exact shape: an instance `waiting_for_permission`, a pending
   `request_user_action` response for the same instance — `respondToUserAction()` must not write to the
   adapter's stdin while suppressed, and the original deferred-permission request must remain answerable
   afterward (no duplicate tool_use, no orphaned permission).
2. `SessionAdmissionService.admitAutomatedWrite()` (or equivalent) is called on the `'inject-response'`
   path for every `OrchestratorAction`, mutation-verified (revert the gate call, watch the new test fail).
3. A suppressed orchestration response is redelivered once the instance returns to a ready state,
   verified live (not just by reading code), the same standard A5 already met for automations/channels.
4. Existing `orchestration-handler.spec.ts` / `instance-orchestration` suites still pass; `tsc` ×2,
   `eslint`, `build:main` clean.

Not fixed this session — found via live reproduction while driving check C2's approve/confirm-from-card
sub-assertion; scoped and written up for the next implementation pass rather than fixed unilaterally
mid-livetest-campaign, per this campaign's standard practice for higher-risk session-corruption findings.

## LT-524: WS15 durable resume never fires for a turn whose entire output occurred before the coordinator had accepted any frame — silent total loss

**Current status (2026-08-31): FIXED IN CODE; LIVE RE-CHECK PENDING.** The coordinator always sends a
resume request to durable workers, even with no cursors. The worker merges every buffered
durability-ring instance absent from the cursor list at sequence zero. Failing-first tests cover an
empty cursor list, a wholly offline instance, and an unknown instance alongside a known cursor.

**Original status: FOUND, NOT FIXED, 2026-08-25.**

### Observed behaviour

Reproduced against a genuinely isolated worker node: a fresh dev-app coordinator
(`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-E`) with `remoteNodesEnabled`/`remoteNodesServerPort` set to a
private loopback port, paired to a disposable `dist/worker-agent/index.js` process running under
`node --inspect` on the same machine — not `windows-pc`, not any of James's real nodes. This gave full,
non-destructive control over the link: a `net.Socket.prototype.write` monkeypatch (installed via the
Node Inspector Protocol) that silently swallows outbound frames from the worker to the coordinator only
while `globalThis.__ltBlockNet` is true, leaving the worker process itself, and its spawned CLI child,
fully alive and running throughout — the same shape of lever this campaign's sibling docs (WS13 Batch C)
already established as legitimate.

Created a remote Claude instance on this worker (`forceNodeId`, `executionLocation.type: 'remote'`
confirmed), sent a real prompt ("write a 900-word essay on the history of lighthouses"), and enabled the
block ~8-12s later — before any output notification had reached the coordinator. Held the block until the
coordinator's own heartbeat-timeout mechanism (`worker-node-health.ts`, `DEGRADED_THRESHOLD_MS`=60s,
`DISCONNECT_THRESHOLD_MS`=90s) genuinely fired ("Node exceeded disconnect threshold, deregistering",
confirmed in `app.log`) and force-closed the connection, then released the block and let the worker's own
reconnect logic bring it back ("Registration accepted" logged again on the coordinator).

**The essay was fully generated while the link was down.** Confirmed independently of AIO entirely: the
Claude CLI's own on-disk session transcript (`~/.claude/projects/-private-tmp-aio-lt-E-worker-ws/<sessionId>.jsonl`)
contains a complete, real 5,643-character assistant message ("# Guiding Lights: A History of
Lighthouses…") timestamped 23 seconds after the block was enabled — well before the coordinator ever
detected the drop. Reproduced a second time in the same session with a trivial "ping" turn (216-byte real
reply, same pattern).

**None of that output ever reached the coordinator.** After the node fully reconnected:
- `app.log` contains **zero** occurrences of `"Durable stream resume completed"`, `"Parking in-flight
  work RPCs"`, or the gap-marker text, across either reproduction.
- The instance's `outputBuffer` (queried live via `listInstances()`) contained only the two **user**
  messages ("essay prompt", "ping") — no assistant content at all, in either case.
- No error, no "Node disconnected" message, no gap marker (`'⚠️ Some output … was lost'`) was ever shown
  — the turn simply completed (`status: 'idle'`) with an invisible, silently-dropped response.

### Root cause

`StreamDurabilityCoordinator.resumeNode(nodeId, streamDurability)`
(`src/main/remote-node/stream-durability-coordinator.ts:97-100`):

```ts
resumeNode(nodeId: string, streamDurability: unknown): void {
  if (typeof streamDurability !== 'number' || streamDurability < 1) return;
  const state = this.nodes.get(nodeId);
  if (!state || state.cursors.size === 0) return;   // <-- early return
  ...
}
```

`state.cursors` is populated **only** by `accept()`, which runs only when the coordinator has already
received and processed at least one `NODE_TO_COORDINATOR.INSTANCE_OUTPUT`/`INSTANCE_OUTPUT_BATCH`
notification for that instance. If the link goes down before the very first output notification for a
turn arrives — a realistic, common real-world shape (send a message, then lose Wi-Fi/VPN before the first
token streams back) — `resumeNode()` never asks the worker to replay anything at all, even though the
worker's own local ring buffer (the thing `node.streamResume` exists to query) holds the complete,
real output the whole time. The coordinator simply never asks.

This is a different failure mode from the documented "cursors are in-memory, a worker **process**
restart resets them" deviation noted at the top of the same file — that deviation is about a worker
process dying; here the **worker process and its CLI child never stopped running**, and the data was
never lost worker-side. It is purely a coordinator-side gating bug: no baseline cursor ⇒ no resume
request ⇒ total, silent, permanent loss.

### Required behaviour

On a durable worker (re-)registration, the coordinator should request a replay for **every** instance it
still has associated with that node — including instances with no recorded cursor yet — not only ones
with `state.cursors.size > 0`. A worker replaying "from the start" for an instance the coordinator has no
cursor for is a strict improvement over never asking: worst case the worker has nothing buffered either
(also fine, matches today's behaviour); best case the user's real, already-generated response is
recovered instead of silently vanishing.

### Acceptance

- A regression test creates a remote instance, sends a turn, and disconnects it before the coordinator
  accepts any output frame for that instance (`state.cursors.size === 0` at disconnect); on reconnect
  with a durable worker that has real buffered output for that instance, `resumeNode()` must issue a
  `sendResume` call for it and the replayed content must reach the instance transcript.
- The existing "replay only what's cursored" behaviour for instances that already had at least one
  accepted frame before the drop must be unaffected (no regression on WS15 check 4/8's existing
  evidence).
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run build:main`, and
  the targeted `stream-durability-coordinator.spec.ts` suite all pass.

Not fixed this session — found via live reproduction while driving WS15 checks 2/3; scoped and written
up for the next implementation pass rather than fixed unilaterally mid-livetest-campaign, per this
campaign's standard practice for higher-risk data-loss findings.

## LT-525: a mid-turn instance whose worker node disconnects gets permanently stuck in `degraded` after the node reconnects

**Current status (2026-08-31): FIXED IN CODE; LIVE RE-CHECK PENDING.** `degraded` can now restore all
nonterminal lifecycle states. Reconnect reconciliation isolates each instance so one invalid stale
transition cannot reject registration or prevent later instances from reattaching. Failing-first
state-machine and node-failover tests cover both requirements.

**Original status: FOUND, NOT FIXED, 2026-08-25.**

### Observed behaviour

Found in the same WS15 checks 2/3 session as LT-524, using the same isolated worker-to-coordinator
pairing. In both reproductions, the remote instance was actively `processing` a real turn when the
link was cut (via the `net.Socket.prototype.write` monkeypatch described in LT-524) and the coordinator
eventually force-disconnected the node on its own 90s heartbeat timeout.

`app.log` shows the expected first half of recovery working correctly:

```
"Node failover: marking instances degraded (recoverable)"   { nodeId, count: 1 }
"Instance status updated"  { instanceId, status: 'degraded', reason: 'worker-node-disconnected' }
```

But once the worker reconnected and re-registered, the FIRST registration attempt threw:

```
IllegalTransitionError: Illegal transition: degraded → processing
    at InstanceStateMachine.transition (dist/main/instance/instance-state-machine.js:181)
    at InstanceLifecycleManager.transitionState (dist/main/instance/instance-lifecycle.js:388)
    at InstanceManager.updateInstanceStatus (dist/main/instance/instance-manager.js:1341)
    at WorkerNodeRegistry.onReconnect (dist/main/remote-node/node-failover.js:119)
    at WorkerNodeRegistry.emit (node:events:521)
    at WorkerNodeRegistry.registerNode (dist/main/remote-node/worker-node-registry.js:38)
    at RpcEventRouter.handleNodeRegister (dist/main/remote-node/rpc-event-router.js:275)
```

logged only as a generic `"RPC request handler failed"`, and the coordinator rejected that first
registration attempt (WS close code 4001, `"Retry registration with recovery token"`). The worker's own
client-side retry logic then re-registered a few seconds later and that **second** attempt succeeded —
but the instance was left at `status: 'degraded'` and **stayed there** for over a minute of the node
being fully connected and heartbeating normally (`WorkerNodeHealth` showed no further degraded/disconnect
warnings). Confirmed live via `listInstances()` well after reconnection: `status: 'degraded'` still,
with no automatic recovery in sight. Only issuing a further, unrelated `sendInput()` (a plain "ping")
finally moved the instance back to `idle` — an accidental, undocumented recovery path, not a designed
one.

### Root cause

`WorkerNodeRegistry`'s reconnect-reconciliation handler (`src/main/remote-node/node-failover.ts:119-140`,
`onReconnect`) unconditionally restores each affected instance's pre-disconnect `originalStatus`:

```ts
function onReconnect(node: { id: string }): void {
  if (node.id !== nodeId) return;
  if (settled) return;
  settled = true;
  cleanup();                                    // <-- listener already removed here
  for (const { id, originalStatus } of affected) {
    const inst = instanceManager.getInstance(id);
    if (inst && !isTerminalFailoverStatus(inst.status)) {
      instanceManager.updateInstanceStatus(id, originalStatus, {   // <-- throws
        reason: 'worker-node-reconnected',
        nodeId,
      });
    }
  }
}
```

`instance-state-machine.ts:161` deliberately restricts transitions FROM `degraded` to
`['ready', 'idle', 'error', 'initializing']` — its own inline comment reads *"Reconnected →
ready/idle, grace period expired → error"* — i.e. the state machine's author already anticipated
"reconnected" as a `degraded` exit case, but `node-failover.ts` was never updated to route through
`idle`/`ready` when `originalStatus` is one of the active/busy family (`processing`, `busy`,
`thinking_deeply`, …). Because `cleanup()` (which unregisters the `node:connected` listener) runs
**before** the throwing call, and the whole reconciliation is a synchronous `for` loop with no
per-instance try/catch, a single illegal transition aborts reconciliation for every remaining instance
in `affected` too, and the listener is gone — there is no second chance for this specific reconnect
event. Nothing else in the codebase re-attempts the restore.

### Required behaviour

`onReconnect`'s restore should never throw. Either:
(a) wrap `originalStatus` restoration in a state-machine-aware mapping (e.g. any of the busy/processing
family maps to `idle`/`ready` when restoring from `degraded`, since the actual live turn state is
whatever the CLI resumes reporting once its output starts flowing again), or
(b) guard the transition call itself and fall back to `idle` on an `IllegalTransitionError`, logging a
warning instead of letting the exception propagate into the RPC handler and bounce the node's own
registration.
Either way, a single failed restore must not silently abort reconciliation for the rest of `affected`,
and an instance must never require an incidental, unrelated user action to leave `degraded` once its
node is healthy again.

### Acceptance

- A regression test drives an instance to `processing`, disconnects its node, and reconnects it; the
  instance must land in a non-`degraded`, non-error, live status automatically, with no thrown
  exception anywhere in the reconnect path.
- A regression test with **multiple** affected instances on the same node, where an earlier one's
  restore would throw, confirms the later ones are still reconciled (no early abort).
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run build:main`, and
  the targeted `node-failover.spec.ts`/`instance-state-machine.spec.ts` suites all pass.

Not fixed this session — found via the same live reproduction as LT-524; scoped and written up for the
next implementation pass rather than fixed unilaterally mid-livetest-campaign.

## LT-526: `hardened: true` + a remote node silently runs completely unsandboxed — the fail-closed guard is unreachable dead code

**Current status (2026-08-31): FIXED IN CODE; LIVE RE-CHECK PENDING.** Adapter creation rejects the
hardened/remote combination before every remote/local-model early return. A failing-first factory
test proves no `RemoteCliAdapter` can be constructed while the instance claims hardened protection.

**Original status: FOUND, NOT FIXED, 2026-08-25. P0 — silently defeated a security control the user believed was active.**

### Observed behaviour

Driving [WS13 check 5](2026-07-13-fable-ws13_livetest_completed.md), which five prior sessions had left open
for the stated reason "no agent-reachable path anywhere sets `hardened: true` on a `forceNodeId`
create, dev app or packaged app alike" — true for every *exposed* path (IPC schema, MCP
`run_on_node`), but `createInstance` itself has always accepted both fields together
(`InstanceCreatePayloadSchema` has both `hardened` and `forceNodeId` as plain optional fields; this
is not a schema gap, only a UI-composer gap — no combination of the real create-instance dialog
lets a user pick both a remote node and Hardened together today).

Using the same disposable worker paired to an isolated dev-app coordinator built for the sibling
WS15 checks in this session (never touching any of James's real nodes), called `createInstance`
directly via `window.electronAPI` with both fields set:

```js
createInstance({ provider: 'claude', hardened: true, forceNodeId: '<connected worker node id>', workingDirectory: '...' })
```

**It did not fail closed.** The instance reached `status: 'idle'` normally
(`adapterGeneration: 1`, `residentClaude: true`), with `executionLocation: { type: 'remote', nodeId:
'<the node>' }` **and** `hardened: true` both recorded on the live instance object — i.e. the data
model and any UI reading it would show this as a successfully hardened remote session. `app.log`
shows a completely ordinary remote spawn (`"Remote node: dispatching work" method: 'instance.spawn'`
→ `"Remote instance spawned"` → `"CLI spawned successfully"`), no error, no rejection, no fallback
to local. The worker's own log (independent of the coordinator) contains **zero** occurrences of
`sandbox`/`seatbelt` anywhere across the instance's full lifecycle — definitive confirmation the CLI
ran completely unsandboxed on the remote node, not merely that the coordinator's guard was silent.

### Root cause

`adapter-factory.ts` builds the CLI adapter for a new instance in two disjoint branches. The remote
branch returns unconditionally and early:

```ts
// If remote, create a RemoteCliAdapter regardless of CLI type. This returns
// BEFORE the cliType switch below, so the Copilot fail-closed check has to
// run here too — otherwise a remote Copilot spawn would skip it entirely.
if (executionLocation?.type === 'remote') {
  if (cliType === 'copilot') {
    requireCopilotAccountRoute(effectiveOptions, 'remote');
  }
  const connection = getWorkerNodeConnectionServer();
  return new RemoteCliAdapter(connection, executionLocation.nodeId, cliType, effectiveOptions);
}

const adapter = (() => { switch (cliType) { /* local adapters only */ } })();

// WS13 hardened mode: ...
if (isInstanceHardened(effectiveOptions.instanceId)) {
  if (!(adapter instanceof BaseCliAdapter)) {
    // Remote adapters spawn on a worker node, outside the local Seatbelt choke point. FAIL CLOSED.
    throw new Error('Hardened mode is not supported for remote instances (Phase A is local macOS only).');
  }
  ...
}
```

The comment directly above the remote branch already documents this exact bug shape — an early
`return` skipping a fail-closed check below it — and was fixed for the Copilot case by duplicating
that one check into the remote branch. **The hardened-mode check received no equivalent
duplication**, so for every remote instance the `isInstanceHardened(...)` block, including its own
inline `// FAIL CLOSED` comment, is unreachable dead code. The function returns a bare
`RemoteCliAdapter` regardless of whether hardened mode was requested, and nothing downstream ever
checks it again.

### Required behaviour

The remote branch must check `isInstanceHardened(effectiveOptions.instanceId)` itself and throw the
same `'Hardened mode is not supported for remote instances (Phase A is local macOS only).'` error
before constructing a `RemoteCliAdapter` — the same fix shape already applied to the Copilot
fail-closed check in the same branch. No unsandboxed remote session should ever be creatable while
`hardened: true` is set.

### Acceptance

- A regression test asserts `adapter-factory`'s remote branch throws for `hardened: true` +
  `executionLocation.type === 'remote'`, for every `cliType`, **before** any `RemoteCliAdapter` is
  constructed (verify via a spy/mock that the worker connection is never dispatched to).
- The existing local hardened-mode regression coverage (`hardened-mode-scoping.spec.ts`) must be
  unaffected.
- `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run build:main`
  all clean.

Not fixed this session — found via live reproduction while driving WS13 check 5; scoped and written
up for the next implementation pass given its severity (a silently-defeated security control) rather
than risk a rushed fix mid-livetest-campaign.


## LT-527: Copilot Adapter Constructor Blocked on CLI Discovery

**Observed behaviour.** CI on `main` failed on 2026-08-25 and 2026-08-26 with exactly one failing
test in each of two shards: `copilot-cli-adapter.spec.ts › ... recovers assistant content from a
repaired stream-json line` (shard 1) and `copilot-cli-adapter.server-mode.spec.ts › ... stays in
exec mode when the bundled SDK is unavailable` (shard 2). In both cases the failing test was the
**first** test in its file and the first to construct a `CopilotCliAdapter`; later constructions in
the same file passed. The quiet runner reported the message as `STACK_TRACE_ERROR`, which hid the
real cause.

**Root cause.** `CopilotCliAdapter`'s constructor called `getDefaultCopilotCliLaunch()`
(`src/main/cli/copilot-cli-launch.ts:54`). That resolves the standalone `copilot` binary via
`resolveCommandOnPath` (a `which` subprocess), and when it is absent falls back to probing
`gh copilot --help` through `commandRuns()` — a `spawnSync` with `timeout: 5000`. So on a machine
without the standalone binary, constructing the adapter costs up to three synchronous child
processes, bounded only by that 5s timeout.

**Reproduction (2026-08-26).** With `HOME` pointed at a scratch directory and a `gh` shim on
`$HOME/.local/bin` that burns six seconds, a probe of `resolveCopilotCliLaunch()` returned after
**5007ms**, and both spec files failed 10/10 with `Test timed out in 5000ms` — the CI signature.
With the fix applied and the same environment, the same 10 tests pass in 551ms.

**Why it flapped rather than failing consistently.** The probe has been in the constructor since
`a7dfcaa8c` (2026-04-23). Its cost depends on how long a cold `gh`/`which` exec takes under load,
so a lightly-loaded runner stays under the 5s budget and a heavily-loaded four-way-sharded one does
not. CI was green on 2026-08-23 and red on 2026-08-25/26 with no relevant code change between.

**Required behaviour.** Constructing an adapter must not perform blocking subprocess I/O. Discovery
must happen at most once per adapter, at the point a child process is actually spawned.

**Fix.** The constructor now sets an inert placeholder command, and a private
`ensureLaunchResolved()` performs discovery exactly once, called from an overridden
`protected spawnProcess()` — the single path every Copilot child process (`checkStatus`, each
exec-per-message turn, `listAvailableModels`) already goes through. This is behaviour-equivalent to
the old code, which also resolved exactly once per adapter, just deferred.

**Acceptance.** `src/main/cli/adapters/copilot-cli-adapter.lazy-launch.spec.ts` asserts that
construction and `parseOutput()` trigger no discovery, that the first `spawnProcess()` triggers
exactly one, that a second does not repeat it, and that the discovered command and `argsPrefix` are
in place before the child is spawned. Reverting the fix fails 3 of its 4 tests.

**Residual, deliberately not fixed here.** `createCopilotAdapter()`
(`src/main/cli/adapters/adapter-factory.ts:332`) still calls `getDefaultCopilotCliLaunch()`
synchronously on the ACP spawn path, where it genuinely needs the command at construction. That is
the same up-to-5s main-thread block, once per spawn rather than per adapter, and needs a larger
change.

## LT-528: warm-started Codex sessions ignored requested YOLO launch permissions

[Read the detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail).

### Fix and evidence

[Read the detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-528-archived-detail).

## LT-529: generic Settings selects displayed their first option instead of the persisted value

[Read the detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail).

### Fix and evidence

[Read the detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-529-archived-detail).

## LT-530: Claude structured OAuth failure was rendered as assistant prose and vetoed by a later healthy probe

**Status:** fixed, incident-replayed, and regression-tested 2026-08-31. Rebuilt UI verification is
still required because reproducing a genuine OAuth refresh race safely needs an already-running app
and concurrent Claude processes.

### Observed behaviour

AIO session `470f3695-ba5b-497a-95a6-9ad8c5bf7b2f` displayed
`Failed to authenticate: OAuth session expired and could not be refreshed` as a Claude assistant
message at 22:58 and again after hibernation at 23:11, even though `claude auth status` and an
interactive iTerm Claude process reported the account logged in. The same native Claude session
later succeeded without a new login.

The native transcript proves this was not ordinary model prose. Claude emitted:

```json
{"type":"assistant","error":"authentication_failed","isApiErrorMessage":true,"message":{"model":"<synthetic>","content":[{"type":"text","text":"Failed to authenticate: OAuth session expired and could not be refreshed"}]}}
```

Three independent Claude sessions failed within the same 32-second window, consistent with a
concurrent shared OAuth refresh race. A later `claude auth status` therefore says the shared account
is healthy without disproving that the already-running process's turn failed authentication.

### Root cause

Both Claude stream parsers handled every `type: "assistant"` event as chat output before inspecting
its top-level `error` code. The synthetic API failure therefore never reached the adapter error
channel or `InstanceCommunicationManager.reportAuthFailureTurn()`. Even if its text reached the
heuristic path elsewhere, `InstanceAuthRepairHandler` treated a later healthy status probe as a veto,
which is valid for ambiguous tool/MCP prose but wrong for Claude's authoritative provider protocol
error. Separately, generic CLI detection labelled any successful version probe authenticated, even
though `--version` carries no auth information.

### Implemented fix and evidence

- A shared Claude stream-error parser recognizes `authentication_failed` in both assistant-envelope
  and top-level error shapes and emits a typed `ProviderAuthenticationError`.
- Both the direct Claude adapter and spawn-worker proxy use it, so the synthetic event produces one
  adapter error and zero assistant outputs.
- Communication marks typed provider errors authoritative and hands auth repair the complete
  already-resolved turn, including attachments and context.
- A healthy shared auth probe continues to veto heuristic auth-shaped prose, but cannot veto the
  process-specific structured provider failure. One bounded restart/replay is then attempted.
- Generic CLI version detection leaves authentication unknown; Claude's provider-specific
  `claude auth status` probe remains the source of login truth.

The captured event was replayed through the real `ClaudeCliAdapter` class and produced
`outputCount: 0`, `errorCount: 1`, with the typed auth marker set. Focused tests are 207/207 green.
Both TypeScript checks, lint, size ratchet, and `build:main` pass. The full repository suite is
blocked by unrelated failures in concurrently modified session-recovery files; none of the six
auth-fix suites failed.

### Acceptance

- Claude's structured `authentication_failed` assistant envelope is never rendered as assistant
  prose in either local execution path.
- The failed turn is retained exactly once and replayed on the same conceptual session after an
  in-place restart, including attachments and context.
- A later healthy shared auth probe does not suppress recovery of an authoritative process failure.
- Heuristic OAuth/authentication wording from tools and MCP servers remains probe-vetoed.
- Automatic recovery cannot form a restart loop; failure leaves a truthful manual-retry banner.

## LT-531: a record-mode loop preflight spent its whole budget proving nothing

**Status:** fixed in code and mutation-checked 2026-09-03. The running packaged app predates the
fix, so a rebuilt-app check is still outstanding.

### Observed behaviour

A loop started at 23:42:39Z in this repo sat for ten minutes before its first agent turn. The loop
strip read `iteration 1 running/50 · current 19s · total 10m19s` with a red
`Preflight timed out` badge. `.aio-loop-state/loop-1788392553418-c66131dc/PRE_FLIGHT.md`:

```
- Status: failed
- Mode: record
## verify
- Duration: 599971ms
- Command: \`npm run verify\`
...
(verify timed out after 600000ms)
```

The captured output tail was still inside `check:dead` — step 6 of the 14-step `verify` chain — when
the budget expired, so the run never reached `npm run test`, `rebuild:native` or `smoke:electron`.

Not a one-off. Four of the 19 `PRE_FLIGHT.md` artifacts in this workspace record a verify timeout,
every one of them in `record` mode, each burning its full budget — roughly 40 minutes of dead time
in total, three of the four within the last two days:

| Loop | Mode | Duration |
| --- | --- | --- |
| `loop-1786064214169-9238717b` | record | 600006ms |
| `loop-1788312285525-ea25e6c0` | record | 600039ms |
| `loop-1788384213664-ad83ae15` | record | 600012ms |
| `loop-1788392553418-c66131dc` | record | 599971ms |

The command was never chosen by the operator. `app.log` at `1788392553417` — one millisecond before
the loop id `loop-1788392553418-c66131dc` — records
`Adopted the workspace verifier as this loop's verification authority` with
`source: package.json script "verify"` and `verificationAuthority: "inferred"`. Thirteen loops across
the retained logs adopted a verifier this way.

### Root cause

Two independent contributions, both in the preflight path:

1. `runLoopPreflight` ran the loop's full verify under `config.completion.verifyTimeoutMs` (600s)
   regardless of `preflightMode`. The preflight is awaited before iteration 0
   (`loop-coordinator.ts:1832-1846`), so that budget is dead time at the head of every run, and in
   `record` mode nothing gates on the result.
2. The verify command itself was never chosen by the user. `resolveLoopVerification`
   (`loop-verify-command.ts:72`) auto-adopts the workspace's `package.json` `verify` script as the
   loop's verification authority, which here is a 14-step chain that cannot finish in any preflight
   budget.

A timeout carries no information: the starting state is UNKNOWN, not proven red. The cost was paid
to learn nothing, and would be paid again on every subsequent run in the same workspace.

Nothing downstream consumes the result. The `preflight-red-baseline` finding code is declared in
`loop-audit.types.ts` but has no producer anywhere in `src`; the status drives the badge and the
artifact only.

### Required behaviour

- A preflight that cannot stop the run must not spend a gate-sized budget.
- Where a cheap command has already answered "was this tree already broken?", the slow command must
  not also run in non-gating mode.
- `block` mode must be unchanged: it gates, so it has to run the command it gates on, at the
  configured budget.
- An artifact whose baseline is partial or absent must say so rather than implying a clean result.

### Fix and evidence

- `LOOP_PREFLIGHT_VERIFY_BUDGET_MS` (180s) caps the verify budget whenever `preflightMode !== 'block'`.
- A passing quick-verify now ends a non-gating preflight. The skipped slow command is still recorded
  as an explicit `status: 'skipped'` entry carrying its reason, so the artifact never implies the
  full verify passed.
- `renderLoopPreflightMarkdown` notes both the timeout case ("baseline UNKNOWN, not proven red") and
  the new skip case.
- Mutation-checked: reverting the short-circuit fails
  `runLoopPreflight stops after a passing quick-verify when the preflight is not a gate`
  (`expected 1 to be +0`), and the file was restored afterwards.

Related and still open: [LT-350](2026-07-19-livetest-failure-remediation_plan_completed.md) — cancelling a loop
does not kill an in-flight preflight verify subprocess. Same code path; a cancelled loop can leave
this command running. Capping the budget bounds that orphan to 180s but does not close it.

### Acceptance

- A `record` preflight in a workspace whose verify exceeds the budget delays iteration 0 by at most
  `LOOP_PREFLIGHT_VERIFY_BUDGET_MS`.
- With a quick-verify command configured and passing, a `record` preflight runs the cheap command
  only, and `PRE_FLIGHT.md` records the slow one as skipped with its reason.
- A `block` preflight still runs quick-verify and the full verify at the configured budget.
- The preflight artifact never reports a clean baseline it did not actually establish.

## LT-533: title escalation to the CLI never fires and every exit is silent

**Observed behaviour.** `titleGeneration.allowFrontierFallback` was restored to
`true` on 2026-09-08 so that a local model failure is no longer terminal. On the
first real opportunity after the app restart (09:20:31) the local model
*succeeded* — 450 output tokens, inside the raised 1536 budget — but its output
was unusable and `finalizeGeneratedTitle` rejected it. Control then reached the
CLI one-shot block in `AutoTitleService.generateTitle`. No cost-attribution
record was written and no AI title was applied; the session kept its instant
first-message title.

Across the whole of September, `aux:titleGeneration` attribution contains only
`local-fallback` (4224) and `ollama` (395) — not a single record naming
`antigravity`, `claude` or `codex`, although `claude` and `codex` are both on
PATH.

**Root cause.** Not established, and deliberately not guessed. Three exits can
produce this and none is observable:
- no provider resolved: `logger.debug('No CLI available for AI title generation')`
- adapter cannot one-shot: `logger.debug('CLI adapter does not support one-shot sendMessage')`
- the call threw: `catch { return null; }` with no logging at all

Debug is not persisted (`grep -c '"level":"debug"' app.log` = 0), so the log
cannot distinguish them.

**Required behaviour.** The escalation must report its outcome at a persisted
level with a specific reason. This is the same silent-failure class the
2026-09-08 change set out to remove; the B3 abandonment logging added there covers
only the `!allowFrontierFallback` branch, which is now the branch that never runs.

**Acceptance.** A title generation whose local output is rejected either produces
a CLI-attributed title, or writes a greppable reason naming which exit it took
and, for a thrown call, the error.

---

## LT-534: the two title resolvers truncate and sanitize in opposite orders

**Observed behaviour.** A long generated title renders with a trailing `...` on
the live rail and without it in history:

```
live : "Daily health check of the Dingley Assessment servers and..."
hist : "Daily health check of the Dingley Assessment servers and"
```

**Root cause.** `resolveEffectiveInstanceTitle` calls
`normalizeGeneratedHistoryTitlePart(displayName)`, which sanitizes and then
truncates — so `truncateForRail`'s appended `...` survives.
`getConversationHistoryTitle` calls
`normalizeGeneratedHistoryTitlePart(deriveRailTitle(...))`, and `deriveRailTitle`
has already truncated, so the subsequent `sanitizeGeneratedTitle` strips that
same `...` via `.replace(/[.!?]+$/, '')`.

Introduced by the 2026-09-08 title-stability work, which reduced deterministic
drift from 222 of 2000 entries to 47 and rail-overflow renders from 188 to 0.

**Required behaviour.** One shared normalize-then-truncate order used by both
resolvers, so neither can differ from the other by punctuation.

**Also recorded, out of scope for that fix.** Part of the residual 47 is
structural: `truncatePreview` (`history-manager.ts:1739`) applies
`text.replace(/\s+/g, ' ')` before storing `firstUserMessage`, so a history entry
retains no line structure and `deriveRailTitle`'s first-line-only rule cannot be
reproduced from it for any multi-line prompt. Closing that means changing what is
archived.

**Acceptance.** Deterministic drift (entries with no `aiTitle`) measured over the
live history index falls below 47, with rail-overflow renders still at 0.

---

## LT-532: a record-mode preflight with no cheap command still burned the capped budget and looked like a failure

**Status:** fixed in code 2026-09-03. The running app predates the skip, so a rebuilt-app check is still outstanding.

### Observed behaviour

The operator started a loop against `/Users/suas/work/orchestrat0r` at 09:18 local. The strip showed iteration 1 running with `total 4m48s` / `current 1m48s`, a red `Preflight timed out` chip, and a grey `Audit gate pending` chip. They reasonably asked what had failed.

`.aio-loop-state/loop-1788423509509-eab2bd46/PRE_FLIGHT.md`:

```
- Status: failed
- Mode: record
- Ran at: 2026-09-03T08:18:29.976Z
- Note: the baseline verify hit its time budget and was stopped. The starting state is UNKNOWN, not proven red — a `record` preflight never gates the run.
## verify
- Duration: 179999ms
- Command: `npm --prefix "ai-orchestrator" run verify`
(verify timed out after 180000ms)
```

The 4m48s total is the 180s LT-531 cap plus the first iteration. The loop continued; record mode never gates. The second chip is the default `finalAuditMode: 'gate'` waiting until the loop tries to complete — not a stuck gate.

This is exactly the residual LT-531 called out and left as an operator choice (set `preflightMode: off`, or set a quick-verify command). No quick-verify was configured: that field is opt-in and empty by default. The verify command was auto-adopted from the descendant `ai-orchestrator` package.json, the same 14-step chain that cannot finish in 180s.

### Root cause

`runLoopPreflight` still ran the full verify whenever no cheap command had already answered. The 180s cap bounds the waste; it does not stop it. The strip then rendered `status: 'failed'` + `failureKind: 'timeout'` as a red `Preflight timed out` chip, which is the right wording for a *gating* timeout (LT-302) and the wrong severity for a baseline nobody reads.

### Required behaviour

- A `record` preflight with no passing cheap command must not run the full verify at all. Record it as `skipped` with the reason.
- `block` mode is unchanged: it gates, so it has to run the command it gates on, at the configured budget.
- A record-mode timeout restored from an older run must not look like a blocking failure. Label it `Preflight baseline unknown` and style it as skipped.
- A final audit that has not run yet must read as pending, not as a stuck gate.

### Fix and evidence

- `runLoopPreflight` skips the slow command in `record` mode when no quick-verify ran. `PRE_FLIGHT.md` notes that a timeout would only have proven the budget, not the tree.
- `buildLoopAuditChips` mutes record-mode timeout/skip chips and relabels a not-yet-run final audit as `Final audit pending`, with per-chip tooltips.
- `block` mode still runs the full verify and still paints a timeout red.

### Acceptance

- A new `record` preflight in this workspace does not spawn `npm run verify` before iteration 1.
- `PRE_FLIGHT.md` records the skipped command and does not claim a clean or red baseline.
- The strip shows `Preflight skipped` (or `Preflight baseline unknown` for a restored timeout), not a red `Preflight timed out`.
- A `block` preflight still runs the configured verify command.
## LT-535 — a promptless provider-limit park resumed by sending nothing — FIXED 2026-09-17, rebuilt-app check pending

### Observed behavior

On 2026-09-17 six Claude sessions parked on the `five_hour` limit between 18:39 and 20:09 (reset
20:30; all times below are Europe/London). The scheduled
resume fired on time for all six. Two re-sent their turn; four logged `Cleared provider-limit park
with no message to re-send` and sent nothing, leaving the sessions idle with the countdown banner
gone and no indication that anything had happened.

The split is exact, and it is not hibernation. `cuggrdz6x` was hibernated by the idle sweep at
19:09 and still resumed — `Send targets a hibernated session — waking before delivery` followed by
`Resumed regular session after provider quota reset`. What separated the two groups was how many
times the session had been through `InstanceCommunicationManager.sendInput` before it parked:

| instance | `sendInput` calls before the park | 20:30 outcome |
| --- | --- | --- |
| `cp0nlqnbs` | 5 | resumed, turn re-sent |
| `cuggrdz6x` | 10 (hibernated) | woken, resumed, turn re-sent |
| `cz37wakz1` | 0 | park cleared, nothing sent |
| `cf8v1xrl6` | 0 | park cleared, nothing sent |
| `c8n0z4wyg` | 0 | park cleared, nothing sent |
| `pcto77u6s` | 1, held by the known-limit preflight | park cleared, nothing sent |

### Root cause

`instance-communication.ts`'s `adapter.on('complete')` park passes
`resumePrompt: this.overflow.getResumePrompt(instanceId)`, and that map is written in exactly one
place: `InstanceCommunicationManager.sendInput`. Two live turn paths never reach it.

- The create-time initial prompt goes straight to the adapter via
  `sendInitialPromptWithAttachmentFallback`. `providerLimitGateForDirectTurn` covers the
  known-limit preflight and the send-error funnel, and both carry the prompt explicitly — but not
  the *completed-turn* funnel, which is the normal Claude limit shape (exit 0, notice as assistant
  content). `cz37wakz1` ran a three-hour agent sweep entirely off its initial prompt.
- A turn held by the preflight returns before `rememberLastSent`, so a subsequent park on the same
  session also has nothing recorded.

`resumeNow()` then fell to its else branch, which cleared the park and logged. Nothing was sent,
and nothing was surfaced in the transcript.

### Required behavior

A resume that cannot replay a captured turn still continues the session. Replaying the initial
prompt is not an acceptable substitute: a session that has been running for hours would restart its
task from the beginning.

### Fix

`buildProviderLimitContinuationPrompt()` in `instance-provider-limit-resume-scheduler.ts` is now the
single continuation turn for a promptless park, used by `resumeNow()`, by `resumeFromAutomation()`'s
live-instance branch (which sent nothing after a restart, reproducing the same silence), and by the
durable automation's dispatch fallback (which previously had its own ad-hoc variant naming the
instance id and the raw limit reason). The automation and the in-process timer therefore resume a
promptless park identically.

The continuation turn is gated on a live park entry. `resumeNow()` with neither a park nor a carried
prompt still sends nothing, so a stale Resume click landing after the park cleared cannot inject an
unsolicited turn — `instance-provider-limit-ipc.ts` has no `isParked` guard of its own.

### Acceptance

- A park recorded with `resumePrompt: null` resumes by sending the continuation turn, clearing the
  waitReason and the park. Covered by `instance-provider-limit-handler.spec.ts`.
- A park with a captured turn still re-sends that turn verbatim.
- Double-fire de-duplication (timer vs automation) still holds for a promptless park.
- A resume with neither a live park nor a carried turn sends nothing.
- A promptless durable automation firing after a restart, against a live instance, still continues
  the session.
- Live re-check after a rebuild/repackage: a session running only from its initial prompt hits a
  provider limit, parks, and continues on its own at the window reset.

## LT-536 — loop harvest commits refused by the repository hook stranded finished work — FIXED 2026-09-18, rebuilt-app check pending

### Observed behavior

On 2026-09-18 eight `.worktrees/task-*` loop worktrees held 7 to 185 staged files each, with zero
commits on their branches, 28 to 56 commits behind `main`. `git log` and `git branch` showed
nothing of that work. Every matching `loop_runs` row was at lifecycle phase `blocked` with
`lastError = 'Harvest failed with uncommitted work'`; five had finished `completed-needs-review` and
three `cap-reached`. The only place the state surfaced was the owning chat's loop summary and its
collapsed "Past loop prompts" row, which read `workspace blocked · Harvest failed with uncommitted
work · saved on task-…`. That last clause was false: nothing had been saved on the branch.

### Root cause

`WorktreeManager.harvestWorktree` (`worktree-manager.ts`) runs `git add -A` and then
`git commit --no-gpg-sign` with no `--no-verify`, so the repository's pre-commit hook ran against
the loop's session output. `finalizeLoopWorktree` treats a failed harvest as `blocked` and keeps the
worktree, which is correct, but nothing ever retried it successfully: boot recovery
(`loop-worktree-lifecycle-reconcile.ts`) re-ran the same hooked commit on every start.

`app.log.3`/`app.log.4` record the refusal for 7 of the 8 runs, each five times:

| Refusal | Runs |
| --- | --- |
| `.githooks/pre-commit: line 10: node: command not found` (packaged app's PATH has no `node`, so `node scripts/run-git-hook.js` exits 127 before `test:staged` runs) | `mtovfbpg`, `mtl9icld`, `mtjeyorh`, `mtjvhjeh`, `mtkqr41h` |
| plan-spec guard: `Commit blocked — active plan/spec/livetest docs must stay untracked` | `mtkdez2p`, `mtklsatd` |

The eighth run (`mt76ztv1`, 2026-08-24) predates log retention; its cause is inferred, not proven.
Reproduced in a temp repository with a pre-commit hook that exits 1: `harvestWorktree` returned
`{ committed: false, hasUncommittedWork: true }` and the index was left fully staged.

A second defect sat behind the first. Boot recovery re-processes every `blocked` row, and for a
clean worktree it silently adopted whatever tip the session branch had. A blocked run whose branch
gained commits AIO did not make, such as an operator's rescue commit, was then auto-integrated into
`integration/<base>` and offered for promotion on the next start. A regression test reproduced this
against the pre-fix code (the run was merged into `integration/main`).

The hook had also been the only thing stopping an active plan/spec/livetest document from reaching
the base branch through auto-integration, because integration merges and promotion already skip
hooks. Making harvest hook-proof without replacing that check would have let loops land active
plans on `main`.

### Required behavior

- The harvest commit is a safety commit on a throwaway session branch and cannot be refused by a
  repository hook, at finalization or at boot.
- Auto-integration refuses a session branch that adds or modifies an active plan/spec/livetest
  document (same pattern and standing-register exemption as the plan-spec guard). The work stays on
  the session branch for a human to land.
- Boot recovery does not auto-land a `blocked` run whose clean session branch moved away from the
  recorded `sessionTip`.
- The UI does not claim a failed harvest was saved on a branch.

### Fix

- `harvestWorktree` and the boot-reconcile harvest commit with `--no-verify`.
- New `listActivePlanDocuments()` (`src/main/workspace/git/active-plan-documents.ts`), exposed as
  `WorktreeManager.listActivePlanDocuments()`. `finalizeLoopWorktree` and boot reconcile call it
  before integrating and block with `Session adds active plan/spec/livetest documents; land it
  manually`, removing the clean worktree folder and keeping the branch.
- Boot reconcile keeps a clean `blocked` row whose branch tip differs from `sessionTip` blocked, with
  `Session branch changed outside AIO; review it before landing`, touching neither the folder nor
  the branch.
- `managedWorktreeStatus()` says `uncommitted in the <branch> worktree folder, not saved on a
  branch` for a failed harvest, and the fixed identity/landing-guard reasons are shown verbatim
  instead of the generic `manual attention required`.

Not changed: `mergeWorktree`'s squash commit (`worktree-manager.ts`) lands real work on the base
branch in the root checkout, where hooks are meant to run. The loop commit ratchet
(`loop-commit-ratchet.ts`) has the same hooked-commit shape but is opt-in and was not implicated.

Follow-up decisions (James, 2026-09-18, stranded-worktree rescue report items 15 and 16):

- Loop promotion now uses `dirtyRootPolicy: 'block-overlap'` (`LOOP_DIRTY_ROOT_POLICY` in
  `loop-landing-policy.ts`, passed by `WorktreeManager` and boot reconcile). It blocks only when the operator's
  uncommitted root changes overlap the promoted paths, with reason `root checkout has uncommitted
  changes to a promoted path: <path>`. Under `block-any` a loop could never land in a repository
  that keeps untracked plan documents in its root.
- A blocked run can be marked resolved by hand from its "Past loop prompts" row
  (`LOOP_RESOLVE_BLOCKED_WORKTREE`, `loop-worktree-resolve.ts`). The lifecycle moves to `cleaned`
  with `resolvedByOperatorAt`, so boot recovery stops retrying it. Nothing on disk or in Git
  changes, and a worktree folder with uncommitted changes is refused.

### Acceptance

- A dirty session worktree with a refusing pre-commit hook harvests into a commit and leaves a clean
  tree (`worktree-manager.spec.ts`).
- Boot recovery captures a dirty worktree despite a refusing hook and completes
  (`loop-worktree-lifecycle-reconcile.spec.ts`).
- A session adding `*_plan.md` is not integrated at finalization or at boot, and its branch
  survives (`loop-worktree-lifecycle.spec.ts`, `loop-worktree-lifecycle-reconcile.spec.ts`).
- A blocked run whose branch gained an outside commit stays blocked, with `main`, the branch, the
  folder and `integration/main` untouched (`loop-worktree-lifecycle-reconcile.spec.ts`; fails
  against the pre-fix code).
- Live re-check after a rebuild/repackage: a loop in this repository whose worktree contains an
  active plan document finishes as `blocked` with the landing-guard reason and its work committed on
  the session branch, and a loop without one harvests even though the packaged app has no `node` on
  its PATH.
- Live re-check after a rebuild: a completed loop without active plan documents lands on `main`
  while the root still has unrelated untracked files; and "Mark resolved" on a blocked run's Past
  loop prompts row turns it into "marked resolved" and survives an app restart without the run
  being retried.
- All five deferred live checks, with exact steps and expected results, are in
  `docs/plans/2026-09-18-stranded-worktree-rescue_livetest_completed.md` (untracked). Run LT-1 there before
  resolving any of the eight stranded runs, because it depends on their current blocked state.

## LT-537 — the operator switch barring agent secret requests was never enforced — FIXED 2026-09-19, rebuilt-app check pending

### Observed behaviour

`workspaceSecretsAllowAgentRequests` (default `true`) is described in `settings.types.ts` as operator-only,
with "When false, agents cannot raise a `secret_required` card". Turning it off had no effect: an agent could
still raise the card and the user still saw it.

### Root cause

No code read the setting. `rg workspaceSecretsAllowAgentRequests` found it only in `settings-defaults.ts`,
`settings-metadata-runtime.ts`, `settings-surfacing.ts`, `settings.types.ts` and documentation. The sibling
master switch `workspaceSecretsEnabled` was read in exactly one place — `spawn-config-builder.ts:274`, which
suppresses workspace MCP connector materialisation — and neither switch guarded the card itself. The card is
raised from agent-supplied metadata (`type: 'secret_required'`, see `cli.types.ts:118`), which flows
adapter → `instance-communication.ts` → `InstancePermissionRequestFlow.handleInputRequired` → renderer.

### Required behaviour

An agent may only raise a secret card when both operator switches are on. A refused request must not reach the
renderer, must be answered so the agent continues instead of waiting, and must leave a visible trace.

### Fix

`InstancePermissionRequestFlow.handleInputRequired` now checks both switches for a `secret_required` request
before any forwarding, following the file's existing auto-deny shape: emit a `permission:lifecycle` deny with
source `operator-setting`, send the agent a refusal naming the setting (no secret material involved), add a
system output message, and return. Settings that cannot be read fail closed.

### Acceptance

- Either switch off: not forwarded, agent refused, system note recorded (`instance-permission-request-flow.spec.ts`).
- Both on: forwarded unchanged.
- Settings unreadable: fails closed.
- Live re-check after a rebuild: with the switch off in Settings, an agent asking for a secret gets a refusal in
  its transcript and no card appears.

## LT-538 — the loop panel told the operator a provider-limit park would never resume — FIXED 2026-09-19

### Observed behaviour

With `instanceProviderLimitResumeEnabled` off (the default), a loop parked on a provider limit showed the
`loop-provider-limit-resume-off` hint: "Provider-limit recovery is off, so it will sit here rather than resume
itself when the window clears — which overnight means the run is simply dead until morning."

### Root cause

The hint keyed off a setting that does not govern loops. `instanceProviderLimitResumeEnabled` is read in exactly
one place, `instance-manager.ts:439`, to enable `InstanceProviderLimitHandler` for regular sessions. The same file
documents (`instance-manager.ts:386-403`) that loop turns never reach that handler; only
`LoopProviderLimitHandler.handleProviderLimit()` parks a loop, and its `scheduleResume`
(`loop-provider-limit-handler.ts:486`) schedules the resume unconditionally, falling back to an in-process timer
when the durable scheduler fails. So the hint's claim was false on the default path.

### Required behaviour

The loop UI must not say a parked loop waits for the operator, and must not offer a settings control that does
not affect loops.

### Fix

Removed the hint (`HintId` member, copy, `shouldHintProviderLimitResumeOff`, its spec block, and the loop panel
binding). The causal timeline keeps its true "It resumes on its own once the provider window reopens." and the
non-actionable "Switch provider" note; the "Turn on auto-resume" action built on the false premise was removed
before landing.

### Acceptance

- No reference to `loop-provider-limit-resume-off` or `shouldHintProviderLimitResumeOff` remains.
- `loop-causal-timeline.spec.ts` (`says a provider-limit park resumes on its own`) and
  `loop-control-timeline.spec.ts` (`says the loop resumes on its own and offers no button …`) pass.

<a id="lt-539"></a>

## LT-539: a hardened create can adopt an unsandboxed warm-start adapter — FIXED IN CODE; live check pending

### Observed behavior

A hardened create adopted an unsandboxed warm process while the UI reported hardened mode.

### Root cause

The warm-start guard omitted `config.hardened`; warm matching used provider and directory only.

### Required behavior

A hardened create must spawn under Seatbelt and never consume an unconfined warm adapter.

### Acceptance

The preflight regression rejects warm reuse for hardened mode; a rebuilt-app create logs a Seatbelt spawn.

Found live on 2026-09-20 during check 4 of the [WS13 hardened-mode livetest](2026-07-13-fable-ws13_livetest.md). The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-539) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-540"></a>

## LT-540: a packaged smoke-mode app hijacks the machine-global Chrome native-messaging manifest — FIXED IN CODE; live check pending

### Observed behavior

An isolated packaged smoke run replaced Chrome’s machine-global native host manifest with a throwaway path.

### Root cause

The packaged-app claim rule ignored smoke mode, while the manifest path came from the home directory.

### Required behavior

Smoke runs must leave the installed app’s native-host registration intact.

### Acceptance

`smoke:packaged` leaves the manifest byte-identical while the normal installed app is running.

Found live on 2026-09-20 during check 7 of the [WS13 hardened-mode livetest](2026-07-13-fable-ws13_livetest.md). The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-540) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-541"></a>

## LT-541: every remote assistant reply was silently dropped by the durable-stream dedupe — REOPENED 2026-09-24 (fix never reached main; now ported)

### Status correction — 2026-09-24

The fix described below, and its live verification, happened on the Plan Queue branch
`queue/2026-07-13-fable-ws15-332c74`, which is parked as land-blocked and was never merged. `main`
at `f04f6748` still carried the pre-fix code: `StreamDurabilityCoordinator.accept()` dropped every
frame at or below the cursor, and the worker did not flush buffered output before a context or
complete frame. The branch's source and test diff (11 files) was applied unchanged to the `main`
working tree on 2026-09-24. Before the source half was applied, the branch's tests failed
14 of 86 against `main`. After it, `npm run test:quiet -- src/main/remote-node src/worker-agent`
passed 1182 of 1182. Still pending: a live re-check against a rebuilt coordinator, plus a worker
redeploy for the worker-side ordering half (the coordinator half alone already stops the loss).
The queue branch itself was left alone; AIO owns its lifecycle.


### Observed behavior

Remote assistant replies existed in the CLI transcript but never reached the instance output buffer.

### Root cause

Context/complete frames overtook buffered output and advanced a dedupe cursor beyond it.

### Required behavior

Flush output before later frames and accept late live frames without accepting replay duplicates.

### Acceptance

Worker/coordinator regressions pass; the rebuilt worker and app deliver the reply in order.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-541) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-542"></a>

## LT-542: the WS15 parked-work window never opened on a heartbeat-timeout disconnect — REOPENED 2026-09-24 (fix never reached main; now ported)

### Status correction — 2026-09-24

The fix described below, and its live verification, happened on the Plan Queue branch
`queue/2026-07-13-fable-ws15-332c74`, which is parked as land-blocked and was never merged. `main`
at `f04f6748` still carried the pre-fix code: `StreamDurabilityCoordinator.accept()` dropped every
frame at or below the cursor, and the worker did not flush buffered output before a context or
complete frame. The branch's source and test diff (11 files) was applied unchanged to the `main`
working tree on 2026-09-24. Before the source half was applied, the branch's tests failed
14 of 86 against `main`. After it, `npm run test:quiet -- src/main/remote-node src/worker-agent`
passed 1182 of 1182. Still pending: a live re-check against a rebuilt coordinator, plus a worker
redeploy for the worker-side ordering half (the coordinator half alone already stops the loss).
The queue branch itself was left alone; AIO owns its lifecycle.


### Observed behavior

A heartbeat-timeout disconnect aborted durable worker work instead of opening the parked-work window.

### Root cause

Node deregistration erased durability capabilities before disconnect lifecycle inspected them.

### Required behavior

Retain the registered durability fact through the disconnect grace period.

### Acceptance

A durable worker parks then resumes on reconnect or expires after the documented window; a non-durable worker fails fast.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-542) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-543"></a>

## LT-543: the browser-gateway forwarder's log lines go nowhere — FIXED IN CODE; live check pending

### Observed behavior

A restarted browser forwarder restored revealed tools but its restoration and failure logs were absent from `app.log` and stderr.

### Root cause

The standalone `aio-mcp` forwarder had neither an Electron file-log path nor a console sink.

### Required behavior

Give forwarder diagnostics a durable, safe sink while keeping JSON-RPC stdout clean.

### Acceptance

A restarted forwarder writes a bounded restoration or failure line to the configured sink and tool health reflects the result.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-543) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-544"></a>

## LT-544: both extension channels accept commands and never run them while health calls them healthy — FIXED IN CODE; live check pending

### Observed behavior

Extension commands timed out on both Windows and Mac while health called the channels deliverable.

### Root cause

The command timeout and health/recovery accounting disagreed; the precise clearing path was unresolved in the incident.

### Required behavior

Timeouts must make health and recovery acknowledge an unanswered extension command.

### Acceptance

A command-timeout burst yields an unhealthy or recoverable state and a working recovery action, verified on the live channels.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-544) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-545"></a>

## LT-545: every object-payload renderer IPC call in `OrchestrationIpcService` is double-wrapped — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-545-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-545-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-545-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-545-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-545-archived-detail).

<a id="lt-546"></a>
## LT-546: a suggest-only skill has no reachable control, and the panel mislabels the D1a default — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-546-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-546-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-546-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-546-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-546-archived-detail).

<a id="lt-547"></a>
## LT-547: an enabled, detected skill over the injection budget is dropped in silence — FIXED IN CODE; live check pending

### Observed behavior

An enabled oversized skill was detected but silently omitted from injection and Skill Health.

### Root cause

Budget skipping produced no activation or persistent skip record.

### Required behavior

Record and surface a detected-but-skipped reason without pretending the skill injected.

### Acceptance

An over-budget detected skill appears in Skill Health with its skip reason and the turn remains correctly budgeted.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-547) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-548"></a>

## LT-548: a materialised workspace secret is passed to the CLI on the command line — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-548-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-548-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-548-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-548-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-548-archived-detail).

<a id="lt-549"></a>
## LT-549: the secret card keeps a rejected credential in its password input — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-549-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-549-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-549-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-549-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-549-archived-detail).

<a id="lt-550"></a>
## LT-550: Workspace Secrets management hides the name, the timestamps and the audit trail — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-550-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-550-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-550-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-550-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-550-archived-detail).

<a id="lt-551"></a>
## LT-551: nothing can raise the secret card — FIXED IN CODE; live check pending

### Observed behavior

A live agent could not raise the secret card through any reachable protocol.

### Root cause

No provider emitted the private CLI card shape and orchestration lacked `secret_required`.

### Required behavior

Expose a gated agent-reachable request that returns only an opaque secret reference.

### Acceptance

Both switches enforce the gate; a permitted request opens the card, resolves through dedicated IPC and never sends plaintext into the transcript.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-551) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-570"></a>

## LT-570: the Settings Help drawer is a modal that manages no focus — CONFIRMED FIXED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-570-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-570-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-570-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-570-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-570-archived-detail).

<a id="lt-571"></a>
## LT-571: Remote Nodes → Pairing renders an entirely empty panel — CONFIRMED FIXED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-571-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-571-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-571-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-571-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-571-archived-detail).

<a id="lt-572"></a>
## LT-572: icon-only Settings rail controls are under the 44 × 44 hit-target floor — CONFIRMED FIXED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

### Status correction — 2026-09-24 (REOPENED, partial)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

### Final live re-check — 2026-09-24 (`verify-ui`)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-572-archived-detail).

<a id="lt-573"></a>
## LT-573: the save-state banner announces nothing, including its error state — CONFIRMED FIXED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-573-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-573-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-573-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-573-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-573-archived-detail).

<a id="lt-574"></a>
## LT-574: Ecosystem lists no commands on any visit after the first — CONFIRMED FIXED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-574-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-574-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-574-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-574-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-574-archived-detail).

<a id="lt-575"></a>
## LT-575: light-theme contrast failures on Settings surfaces — CONFIRMED FIXED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-575-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-575-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-575-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-575-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-575-archived-detail).

<a id="lt-590"></a>
## LT-590: the loop diagnosis card loses its severity colours in the light theme — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-590-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-590-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-590-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-590-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-590-archived-detail).

<a id="lt-591"></a>
## LT-591: the WARN escalation borrows signal A's id, so the card headlines work that never repeated — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-591-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-591-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-591-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-591-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-591-archived-detail).

<a id="lt-592"></a>
## LT-592: the fixability tag, the next step and the primary action can name different signals — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-592-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-592-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-592-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-592-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-592-archived-detail).

<a id="lt-593"></a>
## LT-593: Stop on a busy Claude session terminates it instead of interrupting it — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-593-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-593-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-593-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-593-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-593-archived-detail).

<a id="lt-594"></a>
## LT-594: the loop causal timeline's terminal readings are unreachable — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-594-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-594-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-594-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-594-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-594-archived-detail).

<a id="lt-595"></a>
## LT-595: the composer picker keeps the old model after a closed-session continuation — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-595-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-595-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-595-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-595-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-595-archived-detail).

<a id="lt-596"></a>
## LT-596: a Codex native sub-agent's token spend is charged to nobody — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-596-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-596-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-596-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-596-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-596-archived-detail).

<a id="lt-597"></a>
## LT-597: an interrupted Codex turn costs zero in the ledger while the quota window moves — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-597-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-597-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-597-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-597-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-597-archived-detail).

<a id="lt-598"></a>
## LT-598: the context manifest omits the adapter-appended system-prompt blocks — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-598-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-598-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-598-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-598-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-598-archived-detail).

<a id="lt-599"></a>
## LT-599: the streaming rewind guard protects a field the transcript never reads — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-599-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-599-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-599-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-599-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-599-archived-detail).

<a id="lt-600"></a>
## LT-600: an in-place ACP interrupt settle never records that the interrupt completed — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-600-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-600-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-600-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-600-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-600-archived-detail).

<a id="lt-601"></a>
## LT-601: a user Stop is recorded as a completed turn — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-601-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-601-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-601-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-601-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-601-archived-detail).

<a id="lt-602"></a>
## LT-602: the header chip never shows a session's spawn-time reasoning effort — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-602-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-602-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-602-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-602-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-602-archived-detail).

<a id="lt-603"></a>
## LT-603: the restart's own ready-edge redelivery erases the retained child record before the fresh-fallback reconcile reads it — FIXED IN CODE; live check pending

### Observed behavior

A restart lost its retained child record before fallback reconciliation could report it.

### Root cause

Ready-edge admission redelivered and forgot the record before the later history reconcile read it.

### Required behavior

Hold admission through reconciliation and report genuinely dropped children.

### Acceptance

A reproduced restart retains the record until reconcile and shows the lost-child notice once.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-603) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-604"></a>

## LT-604: a worker server started after launch has no RPC router, so every worker stays "disconnected" — FIXED IN CODE; live check pending

### Observed behavior

A worker paired after starting a disabled server stayed “disconnected” in the roster.

### Root cause

The RPC router was wired only on startup when remote nodes were already enabled.

### Required behavior

Install routing and listeners for every later server-start path.

### Acceptance

Both initial and runtime server starts register heartbeats and expose worker endpoints.

The [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md#lt-604) retains the incident trace. The [working checkpoint](2026-09-23-outstanding-plans-progress.md) records code and focused-test evidence. Code status does not imply the owning rebuilt-app or external live check has passed.

<a id="lt-605"></a>

## LT-605: the session-restart-recovery startup notice is not rendered anywhere — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-605-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-605-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-605-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-605-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-605-archived-detail).

<a id="lt-606"></a>
## LT-606: Resume Picker row actions have no visible focus ring — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-606-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-606-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-606-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-606-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-606-archived-detail).

<a id="lt-610"></a>
## LT-610: deep-linking to another approval moves the highlight but never the keyboard focus — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-610-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-610-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-610-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-610-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-610-archived-detail).

<a id="lt-611"></a>
## LT-611: a browser mutation with no `instanceId` can never redeem the approval it just raised — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-611-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-611-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-611-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-611-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-611-archived-detail).

<a id="lt-612"></a>
## LT-612: every ACP provider records a failed command as a success — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail).

### Investigation — 2026-09-24 (Grok wire capture)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-612-archived-detail).

<a id="lt-613"></a>
## LT-613: clicking a History entry closes the sidebar instead of expanding it — FIXED IN CODE; live check pending

[Read the detail](livetest-remediation-register-archive-2026.md#lt-613-archived-detail).

### Observed behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-613-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-613-archived-detail).

### Required behavior

[Read the detail](livetest-remediation-register-archive-2026.md#lt-613-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-613-archived-detail).

## LT-614 — a timed-out ACP approval card stayed on screen and its Cancel did nothing — FIXED 2026-09-22

### Observed behaviour

Reproduced in the dev app on 2026-09-22 (OpenCode provider plan, Task 6.2). With YOLO off, an ACP permission request
shows the generic "Input Required" card. If nobody answers, the PermissionRegistry auto-rejects it after 60 s and the
agent carries on — but the card stayed on screen, and clicking its Cancel did nothing. Shared by every ACP provider
(OpenCode, Grok, Cursor, Copilot). Found while fixing it: answering a card through chat never resolved its registry
entry, so for up to 60 s the "N sessions blocked on approval" banner counted an answered request, and the durable
approval audit recorded the user's answer as `denied / timeout`. Stop and agent exit left registry entries open the
same way, and an open ACP elicitation was never cleared when the agent process died.

### Root cause

- Nothing told the renderer when a request was settled without the user. `PermissionRegistry` emitted
  `permission:resolved` (consumed only by the durable store), and `AcpCliAdapter` answered the agent silently.
- Cancel on a generic card called `respond(false)` with no text, which hit `if (!inputText) return;`.
- `AcpCliAdapter.sendRaw` replied to the agent but never resolved the registry entry; the cancel and exit paths did
  the same.

### Required behaviour

A card disappears as soon as its request no longer needs an answer, for every reason (timeout, auto-approve, parent
decision, turn cancelled, agent exit), exactly once per request; Cancel on an ACP card is a real answer; the banner
and approval audit reflect what actually happened.

### Fix

- `AcpCliAdapter` emits `input_required_resolved {id, reason}` on every non-user settle path, at most once per request
  (live-map checks after every await; never for YOLO auto-approvals that showed no card), carried through
  `InstanceCommunication` → `InstanceManager` → IPC `INPUT_REQUIRED_RESOLVED` (`instance:input-required-resolved`)
  and the remote observer, plus the mobile gateway (`permission-cleared`). The renderer removes the card and
  decrements `pendingApprovalCount`.
- Cancel on ACP cards (`metadata.transport === 'acp'`) sends a keyed `cancel` (ACP outcome `cancelled`); other
  generic cards, whose reply is plain stdin, still send nothing.
- A reply to an already-settled request returns `INPUT_REQUIRED_NOT_PENDING`; the renderer drops the card.
- Registry entries are closed with `decidedBy: 'user'` on reply and the new `'cancelled'` on Stop or agent exit; the
  exit handler also drains open elicitations.

### Acceptance

- `acp-cli-adapter.permission-resolved.spec.ts` (12 tests, including three exit-during-await races) and the new
  `user-action-request.component.spec.ts`, `instance-event-forwarding.spec.ts` and `mobile-gateway-server.spec.ts`
  cases pass; each guard was mutation-checked (reverting it fails its test).
- Dev app, OpenCode free model: an unanswered card disappears at 60 s (audit `denied / timeout`); Cancel removes the
  card at once and the tool is refused (audit `denied / user`, no banner); Stop with a card up removes it within a
  second (audit `denied / cancelled`).

## LT-615 — `close_matching` reported an already-closed tab as one it closed — FIXED 2026-09-24

### Observed behaviour

Live on 2026-09-24 against the packaged app and `windows-pc`. The disposable `https://example.com/`
tab was closed with `browser.close_tab` (audit `cf57d912…`, `closed: true`). `list_targets` then kept
its row with `status: "closed"`, which is by design. A follow-up
`browser.close_matching {computer: "windows-pc", urlContains: "example.com", dryRun: true}` (audit
`4bc20f22…`) returned that row under `closed` ("would close"), with `remainingTabCount` unchanged at
10. A real run would report "Closed 1 browser tab(s)", so an agent would believe it had closed a live
tab that no longer existed.

### Root cause

`BrowserCloseTabOperations.closeMatching()` (`src/main/browser-gateway/browser-close-tab-operations.ts`)
builds candidates from the extension tab store and the target registry, and the registry keeps closed
rows. `filterMatches()` excludes non-closed rows for an explicit `status: "closed"` sweep. It had no
matching exclusion of closed rows for a url/title match. `executeClose()` then treats a closed,
unattached row as an instant success (`ok: true`) with no Chrome command, so the row lands in `closed`.

### Required behaviour

A url/title match closes, and counts, only tabs that are still open. Closed registry rows are removed
only by an explicit `status: "closed"` sweep. A closed row that matches a url/title filter is reported
as skipped, with a reason, so the caller can see it is already gone.

### Fix

`skipReason()` returns `already_closed` for a `status: "closed"` candidate unless the request is a
`status: "closed"` sweep. Regression test: "does not report an already-closed row as closed by a
urlContains match" in `browser-close-tab-operations.spec.ts`, which failed red before the fix. The
existing sweep test still passes. The full `src/main/browser-gateway` suite passes (1495 tests).

### Acceptance

After a rebuild, repeat the dry run above against a tab closed earlier in the same session. It must
return `closed: []` and `skipped: [{…, reason: "already_closed"}]`. A `status: "closed"` sweep must
still remove the row.

## LT-616 — a requeued browser command after a failed poll handoff left no trace — FIXED 2026-09-24

### Observed behaviour

On 2026-09-24 a `reset_node_connection` on `windows-pc`, fired together with a read-only
`browser.query_elements`, produced two `sendResponse: requesting socket is no longer active`
warnings (poll requests `worker-12053`/`worker-12054`) at `1790211907761`. The query then succeeded
once, at `1790211909374`, after re-registration. Nothing in `app.log` said whether either failed
poll response had carried that command, so the requeue guarantee the channel-flapping check exists
to prove live could not be demonstrated by correlation.

### Root cause

`RpcEventRouter.handleBrowserExtPollCommand()` (`src/main/remote-node/rpc-event-router.ts`) calls
`bridge.requeueUndeliveredCommand(nodeId, result.id)` when `respond()` reports no open socket, and
logs nothing. `BrowserExtensionCommandStore.requeueUndeliveredCommand()` has no logger either. The
only surviving line is the transport's `sendResponse` warning, which names the poll request, not the
command.

### Required behaviour

A failed handoff that requeues a real command is logged once, at info, with the node, the command
id, the poll request id and whether the requeue took effect.

### Fix

The router logs `Browser command poll handoff failed; requeued` with `{nodeId, commandId,
pollRequestId, requeued}`. The existing LT-371 router test now asserts the line, and failed red
before the change. The path is rare, so the line adds no steady-state log volume.

### Acceptance

After a rebuild, repeat the channel-flapping check 2 method. The new line must appear with a
`pollRequestId` matching one `sendResponse` warning. Its `commandId` must correspond to the
in-flight read-only command, which must then resolve exactly once.

## LT-617 — health never shows the remote extension's secret-observation report — FIXED IN CODE 2026-09-24

### Observed behaviour

On 2026-09-24, against the packaged app built 2026-09-23 21:12 (which contains
`describeSecretObservation`, `SecretObservationTracker` and the 0.2.34 extension in the same commit,
`be5cce3b`):

1. `windows-pc` reports extension `0.2.34`.
2. `browser.list_targets {nodeId, refresh: true}` succeeds: the `report_inventory` command
   round-trips and every live tab is re-confirmed.
3. `browser.health` then shows `remoteExtensions.nodes[windows-pc].secretObservation: {reported:
   false}`. This was reproduced three times.

The local Mac channel also shows `{reported: false}`, but its refreshes timed out during a transport
drop, so that half proves nothing.

### What has been ruled out, by reading the code

- The extension builds the report: `report_inventory` returns `{reported: true, secretObservation:
  await secretObservationStatus()}` (`resources/browser-extension/background.js`, `runBrowserCommand`
  → `executeCommand`). `safeResult` replaces the result only for secret-tainted or origin-bound
  credential `type` commands.
- The native host passes `result` through: `commandResultPayload()` in
  `src/main/browser-gateway/browser-extension-native-host.ts`.
- The worker relay passes it through: `WorkerExtensionRelay.commandResultPayload()` in
  `src/worker-agent/worker-extension-relay.ts`.
- The RPC schema keeps it: `BrowserExtCommandResultParamsSchema.result` is `z.unknown()`.
- `RemoteExtensionBridge.commandResult()` hands it to `resolveCommand()`, which records it when
  `pending.command.command === 'report_inventory'` (`browser-extension-command-store.ts:324`).
- The health service reads the same command-store singleton via `describeSecretObservation`.

### Not yet checked, and the next step

What the worker on `windows-pc` actually runs. The relay/native host there comes from the worker's
own bundle and git checkout, not the coordinator's. Also whether the extension's
`secretObservationStatus()` throws on that machine (a throw would turn the whole command into
`ok: false`, which would contradict the successful refresh). Capture the raw `commandResult`
params for one refresh: a temporary debug log in `RemoteExtensionBridge.commandResult`, or a
dev-app coordinator paired to a disposable worker running the same extension. Then fix at the hop
that drops the field.

### Required behaviour

After any successful `report_inventory` from an extension ≥ 0.2.34, `health` shows that queue's
`secretObservation` as `{reported: true, protectionEnabled, taintedOriginCount, taintedTabCount,
…}`.

### Acceptance

A unit or integration test reproduces the drop at the offending hop and fails before the fix. Live:
login-recipe check 3 passes.

### Investigation — 2026-09-24

Root cause found and fixed in code, confidence high (read the whole path; reproduced the drop with a
failing-first unit test). windows-pc's checkout was confirmed current (byte-identical background.js/
manifest.json against HEAD, worker built 21:23:28Z, extension reloaded 21:20:52Z after 16:00Z writes)
so this is not stale code — it is a genuine race in `BrowserExtensionCommandStore.resolveCommand`
(`src/main/browser-gateway/browser-extension-command-store.ts`).

The refresh path (`refreshBrowserExtensionInventory`,
`src/main/browser-gateway/browser-extension-inventory-refresh.ts`) sent `report_inventory` with only
a 2.5s execution budget / 3s coordinator wait
(`EXTENSION_INVENTORY_REFRESH_EXECUTION_MS`/`EXTENSION_INVENTORY_REFRESH_TIMEOUT_MS`). This file's own
`browser-gateway-refresh-support.ts` comment already documents that report_inventory's full per-tab
rebuild "routinely outlives" that window on a multi-tab node — so on `windows-pc`, the coordinator's
own `armExecutionTimeout` (command-store.ts) fires at 3s and **deletes the pending entry, rejecting
the caller**, before the extension's real, later `command_result` (`ok: true`,
`secretObservation: {...}`) arrives over the relay. `resolveCommand` previously only recorded
`secretObservation` when a still-live `pending` entry existed with `command === 'report_inventory'`
(old line ~324); once `pending` was already deleted, the late success hit the early
`if (!pending) return;` and the report was silently dropped forever — `describeSecretObservation`
never had anything to show, even though the channel genuinely answered. This explains "round trips
successfully" (the caller's overall `list_targets` succeeds via the existing
`reconcileRefreshFailuresWithInventory` masking against live `tab_inventory`/`attach_tab` broadcasts,
which are independent of `resolveCommand`) alongside "`secretObservation: {reported: false}`" — two
different code paths, only one of which was ever fed by a late/lost `resolveCommand`.

**Fix:** `resolveCommand` now records `secretObservation` unconditionally from any `ok: true` result,
BEFORE checking whether `pending` still exists, keyed on `result.queueKey` (the caller's own declared
channel) rather than the now-possibly-gone `pending.queueKey`. `SecretObservationTracker.record`
already validates the response shape (`reported`/`secretObservation.{protectionEnabled,
taintedOriginCount, taintedTabCount}`), so this is safe for any command, not only ones still tracked
as pending. Also raised the refresh budget itself (see LT-618) so this race triggers far less often
in the first place.

**Test:** `browser-extension-command-store.spec.ts` — "LT-617: records a late report_inventory
secretObservation after its own execution window already timed the command out". Sends
`report_inventory` with a 3s/2.5s budget, lets it time out and reject, then delivers the extension's
real success for the SAME `commandId` afterward and asserts `describeSecretObservation` now returns
it. Confirmed failing (`expected undefined to match object`) against the pre-fix code, passing after.

**Still open (live check only):** login-recipe check 3 on the packaged app, per Acceptance above —
needs a rebuild since this is a coordinator-side (`src/main`) change, not an extension change; no
extension redeploy or version bump needed for this half.

### Orchestrator review — 2026-09-24

The investigation's first fix recorded `secretObservation` from **any** successful command result.
That was rejected at review. Some results are page-controlled (`evaluate` returns whatever the page
returns), so a page could forge the protection report that health shows. The report now counts only
from a command the coordinator sent as `report_inventory`. `SecretObservationTracker.expectReport()`
remembers each such command id at send time, for a 5-minute grace period, and
`recordReport()` accepts that id's reply on the same queue even after the refresh budget has
expired. That keeps the LT-617 late-reply fix.

New test: "never records a secretObservation key carried by a non-inventory result"
(`browser-extension-command-store.spec.ts`). It was mutation-checked: it fails against the
unconditional version. `src/main/browser-gateway` passes 1,503 tests.

The extension change for LT-618 required a manifest bump: `0.2.34` → `0.2.35`, with the history pin
`a7bb39633b15` added in `browser-extension-assets.spec.ts`. The live re-check needs that version
reloaded on `windows-pc` and in the local Chrome. At the time of this review nothing had been
committed or pushed; the LT-617 fix and extension 0.2.35 were subsequently committed in
`39d245ba`. This does not establish that the commit was pulled on `windows-pc` or that the
extension was reloaded there; the live re-check remains pending.


## LT-618 — a command to the local Mac extension times out and the channel then goes silent — PARTLY FIXED IN CODE 2026-09-24

### Observed behaviour

Packaged app built 2026-09-23 21:12, local Chrome (pid 864, up about a day) with extension 0.2.34,
`aio-mcp native-host` alive throughout. On 2026-09-24:

- `1790211484113`: `health` reports the local channel `ready`, contact 10 s ago.
  `list_targets {computer: "local", refresh: true}` then **times out** (`browser_extension_command_timeout`,
  audit `86e4f33d…`). The next two refreshes find the channel `degraded (silent) … not polling (last
  contact 116s / 206s ago)`. It recovers at `1790211793758` after a 306 s gap, with
  `lastDisconnect.reason: "native_host_stdin_eof"`.
- `1790212087026`: `health` reports the channel polling, contact 1 s ago. The next local refresh
  **times out** again (audit `acbf172e…`). The one after finds it `silent … last contact 99s ago`
  (audit `20a8bb62…`).
- Both local shared tabs (`inspection_unavailable`) still carry `lastConfirmedAt 1790209756799`. No
  local inventory report has landed since then.

The same command to `windows-pc`, which runs the same extension version behind the worker relay,
succeeds every time. That points at something about this Chrome, profile or tab set; the two local
shared tabs are both secret-observation-unavailable. It does not point at the coordinator's command
path.

### Root cause

Not established. Candidates: the extension's `report_inventory` path
(`applySecretObservationProtectionFromCommand` → `assertSecretObservationAllowed` →
`reportTabInventory` → `secretObservationStatus`) hanging or killing the MV3 service worker, or the
native host exiting mid-command. See also LT-617, which concerns the same command's
`secretObservation` payload on the other channel.

### Required behaviour

A read-only `report_inventory` to a polling local extension completes within its budget and does not
take the channel down.

### Acceptance

Reproduce in an isolated Chrome carrying the unpacked 0.2.34 extension (not James's Chrome). A
failing test pins the fix. Live: three consecutive local refreshes succeed and the local tabs'
`lastConfirmedAt` advances.

### Investigation — 2026-09-24

Two compounding, code-confirmed defects found (not live-Chrome-reproduced — no isolated Chrome was
launched this pass; reproduced instead with unit tests against the real `background.js` via the
existing `runInNewContext` harness in `browser-extension-assets.spec.ts`, and against the real
`BrowserExtensionCommandStore`). Confidence: high for defect 1 (directly measured); medium-high for
defect 2 as the dominant contributor to "stops polling for minutes" — the exact trigger for the
eventual `native_host_stdin_eof` (a Chrome-internal decision) was not independently confirmed.

**Defect 1 — the refresh budget is too tight for real usage, by the code's own admission.**
`browser-gateway-refresh-support.ts`'s existing comment already says report_inventory's per-tab
rebuild "routinely outlives its 2.5–3s execution window" on a multi-tab node — i.e. this is
documented as expected, not a hypothesis. `windows-pc`'s presumably light/simple tab set stays inside
that window; a real local Mac Chrome with actual browsing routinely does not, so essentially every
local refresh trips both the extension's own `runCommandWithWatchdog` (30s default clamped down to
this command's stamped 2.5s) and the coordinator's `armExecutionTimeout` (3s) near-simultaneously.

**Defect 2 — a timed-out report_inventory is never cancelled, and every other command queues behind
it.** `runCommandWithWatchdog` (`background.js`) only races a timer against the real
`executeBrowserCommand(command)` promise; when the timer wins it replies with a bare
`browser_extension_command_timeout` but the real `reportTabInventory()` call keeps running
uncancelled in the background. That work holds the extension's single shared
`secretObservationBoundary` (`runWithSecretObservationBoundary`) for as long as its per-tab
`buildTabPayload` loop takes (page-text capture has no timeout at all; the taint-lineage frame probe
is bounded at 1.5s per tab but is fully serial). Critically, `applySecretObservationProtectionFromCommand`
is called UNCONDITIONALLY at the top of `runBrowserCommand` for every non-reload command, and the
coordinator's `stampSecretObservationProtection` stamps a boolean onto every outgoing command's
payload — so every single subsequent command, of any kind, queues fully behind whatever the orphaned
inventory build is still doing, even when the stamped protection value hasn't changed at all. The
`reload` command already has a documented, tested bypass of this exact hazard ("Reload has a
dedicated post-dispatch protection path... an older wedged inventory prevent the browser-process
recovery action from ever starting" — background.js, and the existing test "dispatches reload while
an inventory owns the secret-observation boundary"); no other command had one. This matches "stops
polling for minutes" (the extension is alive and does poll, but every delivered command silently
stalls on the boundary before it can even ack) and is consistent with the eventual
`native_host_stdin_eof` recovery resetting all this in-memory state (fresh `secretObservationBoundary`,
`inventoryPromise = null`) — though the exact mechanism by which Chrome/the native host eventually
tears the port down was not independently verified live.

**Fixes:**
1. Raised `EXTENSION_INVENTORY_REFRESH_EXECUTION_MS`/`_TIMEOUT_MS` (`browser-extension-inventory-refresh.ts`)
   from 2.5s/3s to 10s/10.5s — still well under the 30s default full-command budget, but enough room
   for a normal handful of real tabs. Reduces (does not eliminate) how often defect 2 is triggered.
2. Added a no-op fast path to `applySecretObservationProtectionEnabled` (`background.js`): when the
   stamped value already matches the extension's current in-memory value, it returns immediately
   (after still invalidating any stale operator secret-recovery request) instead of queueing onto
   `runWithSecretObservationBoundary`. This removes the redundant boundary hop that EVERY command paid
   even with no orphaned work in flight, and stops a no-op stamp from adding to the queue behind an
   already-wedged boundary. This does NOT fix a command that genuinely needs the boundary (e.g. the
   inventory build's own per-tab taint reads) queuing behind another genuine boundary holder — that is
   inherent to the current design and would need a larger, live-verified refactor (e.g. moving slow,
   page-dependent capture work in `buildTabPayloadLocked` outside the write-serialization boundary) that
   was judged too risky to make blind, without a real Chrome, against this security-sensitive code.

**Tests (failing-first, both confirmed against pre-fix code, both pass after):**
- `browser-extension-inventory-refresh.spec.ts` — "LT-618: a realistic multi-tab report_inventory
  answers within the raised refresh budget" (fails/times out at old constants, passes at new).
- `browser-extension-assets.spec.ts` — "LT-618: applying an unchanged secretObservationProtectionEnabled
  value does not queue behind an occupied boundary" (hangs/times out — literally never resolves —
  against the pre-fix `applySecretObservationProtectionEnabled`; resolves immediately after the fix).

**Extension change note:** `resources/browser-extension/background.js` changed. Per instructions, the
manifest version was NOT bumped and `BACKGROUND_BUNDLE_HISTORY` in
`browser-extension-assets.spec.ts` was NOT updated — its "ships each background bundle under its own
manifest version" test now fails on purpose (background.js's SHA-256 no longer matches `0.2.34`'s
recorded hash) until the orchestrator cuts a new extension version and records its hash. That is the
only test failure this investigation leaves behind; every other targeted and full browser-gateway
spec passes, `tsc --noEmit` (both configs) is clean, and `npm run lint` is clean.

**Still open (live check only, needs the extension redeployed once versioned):** the full Acceptance
above — an isolated Chrome with real tabs, three consecutive local refreshes, `lastConfirmedAt`
advancing. Also worth a live check once redeployed: whether raising the refresh budget alone is
sufficient in practice, or whether the boundary-wedge defect still needs the larger refactor noted
above for a genuinely slow/many-tab profile.

### Independent review note — 2026-09-24 (Low, accepted)

The completion gate observed a timing change. The unchanged-value fast path clears
`secretRecoveryRequest` synchronously, outside `runWithSecretObservationBoundary`. So it can invalidate
an operator's in-flight recovery token slightly earlier than the old FIFO ordering did. The effect is
fail-closed: the operator retries recovery, and nothing is exposed. The recovery flow already requires
`activeBrowserCommandCount === 0`. It is left as is. Revisit only if recovery retries are ever
reported as flaky.

### Prior occurrences found in earlier sessions — 2026-09-24

Searching this machine's earlier chat transcripts (`~/.claude/projects/**/*.jsonl`) shows the same
local Mac symptom twice before today, so it recurs and is not a one-off:

- **2026-09-13, about 20:53 UTC** (12steps project session `1f900f15-…`). Ten
  `browser_extension_command_timeout` results on the local channel, including `inventory refresh
  FAILED for the local extension (browser_extension_command_timeout)`. That session wrote down
  that the local Mac extension was "unresponsive" and fell back to a throwaway Chrome.
- **2026-09-22, about 10:21–10:24 UTC** (this repo, session `c01e88b4-…`). The session wrote:
  "health reported the local channel polling, but `find_or_open` and a refreshed `list_targets`
  returned `browser_extension_command_timeout` three times". The same transcript contains 4
  `not_delivered` results and 2 `native_host_stdin_eof` disconnects.

The 2026-09-22 case shows `find_or_open` timing out as well as the `report_inventory` refresh.
That fits the head-of-line blocking described in the investigation above: any command queued behind
an orphaned inventory build. The unchanged-value fast path covers all commands. The residual (a
command that genuinely needs the boundary waiting behind a real holder) remains.

## LT-619 — mDNS advertisement invisible; refused answers became uncaught exceptions — CODE FIXED 2026-09-24, PERMISSION NEEDS JAMES

### Observed behaviour

On 2026-09-24, the packaged app (pid 60005, started 2026-09-23 22:09, built 21:12) logged
`mDNS service published {port: 4878}` at start (`1790197750247`) and never unpublished it. Yet on
this Mac:

- `dns-sd -B _ai-orchestrator._tcp` lists nothing. The same probe lists `_companion-link._tcp`
  instantly, so the probe itself works.
- A `bonjour-service` browser (the library the worker uses) finds nothing either.
- Each of those queries was followed in `app.log` by `App — Uncaught exception: send EHOSTUNREACH
  224.0.0.251:5353`, 12 of them between `1790212286194` and `1790212323231`, in the 1 s/3 s
  retry rhythm of mDNS answers. Four more occurred earlier, at `1790185407203`.
- At that moment Harness pid 60005 was the only Harness process holding UDP 5353.
- A plain `node` publisher on the same host fails identically (`EHOSTUNREACH`).

The app kept running; its global handler logged each exception. The macOS firewall permits
Harness, and `Info.plist` does carry `NSLocalNetworkUsageDescription`.

### Root cause

1. **Operator/permission half.** macOS Local Network privacy is refusing multicast sends for Harness,
   which returns `EHOSTUNREACH` on every send to `224.0.0.251`. With no permission, the coordinator
   can never be discovered over mDNS, so worker failover to the LAN through discovery (remote-node
   resilience LT-C) cannot work on this Mac. It is likely, but not proven, that each ad-hoc-signed
   rebuild resets the grant.
2. **Code half.** `DiscoveryService.publish()` and `PairBothDiscoveryPublisher` constructed
   `new Bonjour()` without an error callback. bonjour-service then defaults to
   `function (err) { throw err; }` (`node_modules/bonjour-service/dist/lib/mdns-server.js:16`),
   called from `respondToQuery` when an answer cannot be sent (`:84-87`). So every mDNS query for the
   coordinator raised an uncaught main-process exception, and nothing told the operator *why*
   discovery was dead.

### Fix (code half)

New `createPublishingBonjour(logger, purpose)` (`src/main/remote-node/mdns-response-errors.ts`)
passes an error callback that never throws. It logs one warning per advertisement, with the error
code, and for `EHOSTUNREACH` a hint naming System Settings → Privacy & Security → Local Network. Both
publishers use it. The worker's `DiscoveryClient` only browses, so it never answers queries and
cannot hit this path; it was left unchanged. Regression test in `discovery-service.spec.ts`
("handles an mDNS response failure without throwing and warns once per advertisement"), which
failed red first.

### Required behaviour / acceptance

- Code: after a rebuild, an mDNS query against a coordinator without Local Network permission
  produces one warning with the hint and **no** `Uncaught exception` line.
- Operator: James allows Harness under Local Network. Then `dns-sd -B _ai-orchestrator._tcp` lists
  `orchestrator-<id>` and remote-node resilience LT-A passes. Whether ad-hoc re-signing resets the
  grant should be checked after the next rebuild.

## LT-621 — workers never receive the coordinator's MagicDNS URL — FIXED 2026-09-24

### Observed behaviour

On 2026-09-24 the packaged app advertised `["ws://100.68.10.5:4878", "ws://192.168.0.96:4878",
"ws://192.168.0.156:4878"]` to `windows-pc` (`app.log` `1790212171326`, `Advertised coordinator
addresses to node`), with Tailscale `Running`. The advertisement had no
`ws://macbook-pro.tail4fc107.ts.net:4878`, which worker-offline-resilience check 2 expects first.

### Root cause (reproduced)

`readTailscaleSelfStatus()` (`src/main/util/network-addresses.ts`) tries `tailscale` (ENOENT on a
launchd PATH), then `/Applications/Tailscale.app/Contents/MacOS/Tailscale`. That App Store binary
behaves as a CLI only when it sees `TERM` or `SHLVL`. Reproduced with `env -i HOME=…`:

- no `TERM`/`SHLVL` → `The Tailscale GUI failed to start … (Tailscale.CLIError error 3.)`, exit 0;
- `SHLVL=1` or `TERM=dumb` → the JSON status;
- `PWD`, `_`, `USER` and `TMPDIR` make no difference;
- the name's case (`…/tailscale` vs `…/Tailscale`) makes no difference;
- the `/usr/local/bin/tailscale` shim works only because `/bin/sh` sets `SHLVL`.

A Finder-launched Harness has neither variable. The exec resolved that sentence as success, the
JSON parse returned nulls, and the loop returned `{backendState: null, dnsName: null}` without
trying the remaining candidates. So `resolveAdvertisedCoordinatorUrls()` never had a DNS name, and
the Tailscale watcher could not name the backend state.

### Fix

- `tailscaleCliEnv()` passes `TERM` (the existing value, else `dumb`) to both the async and the sync
  status calls.
- `readTailscaleSelfStatus()` skips a candidate whose output is not JSON and tries the next one.
  It also takes the candidate list as an optional parameter, so the test is platform independent.
- Regression tests in `network-addresses.spec.ts` (non-JSON first answer falls through; all
  non-JSON returns null) failed red first.

### Acceptance

After a rebuild and restart of the packaged app, the next `Advertised coordinator addresses to node`
line lists `ws://macbook-pro.tail4fc107.ts.net:4878` first.

## LT-620 — LT-611's sentinel mismatch survived in four more grant lookups — FIXED 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-620-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-620-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-620-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-620-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-620-archived-detail).

## LT-630 — light-theme text-on-tint contrast failures beyond LT-575 — FIXED 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-630-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-630-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-630-archived-detail).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-630-archived-detail).

### Fix and live re-check — 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-630-archived-detail).

## LT-631 — the project menu is clipped by the instance list's scroll container — FIXED (three causes) + CONFIRMED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail).

### Fix and live re-check — 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail).

### Third cause and live confirmation — 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-631-archived-detail).

## LT-650 — stale MiMo Token Plan quota survives a switch to a non-Plan model — FIXED; IPC CONFIRMED LIVE 2026-09-24

### Observed behaviour

Live, 2026-09-24, `runtime` batch. After switching the OpenCode default model away from
`xiaomi-token-plan-*`:

- `quotaRefresh('opencode')` correctly returns `null`, because the gate is closed;
- but `quotaGetProvider` and the Settings UI keep serving the pre-gate Token Plan snapshot
  indefinitely.

### Root cause

`MimoTokenPlanProbe.probe()` returns `null` when gated. `ProviderQuotaService.refresh()`
(`src/main/core/system/provider-quota-service.ts:268`) treats `null` as "no information, keep the
previous snapshot". Other probes rely on that (for example `usage-monitor-source` returns `null` for
"not fresh"), so nothing ever replaces the Token Plan snapshot.

### Required behaviour / acceptance

A gated probe must be able to say "not applicable" in a way that replaces the stored snapshot and
renders as absent. It must not render as a neutral "ok" entry, which would show OpenCode to users who
never had Token Plan numbers. Acceptance: switching off a Token Plan model and refreshing clears the
numbers, and a user who never had Token Plan data sees no OpenCode quota entry.

### Fix and verification — 2026-09-24

Committed in `39d245ba`: the MiMo gate returns a `notApplicable` marker, and the quota service
stores it in place of stale Token Plan windows. The linked live test confirmed both
`quotaRefresh('opencode')` and `quotaGetProvider('opencode')` return the cleared marker after a model
switch, then return the prior Token Plan windows when the model is switched back. The Settings DOM
row was not independently rechecked on screen; source and component-test evidence supports it, but
the visual acceptance clause remains unverified. The live test's checks 1 and 2 also await a renewed
MiMo console session.

## LT-651 — a new instance's `contextEvidence` never reaches the renderer store — FIXED + CONFIRMED LIVE 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-651-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-651-archived-detail).

### Root cause (read, to be confirmed by the fix's failing test)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-651-archived-detail).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-651-archived-detail).

## LT-640 — lifecycle-only loop state broadcasts were blocked by the event schema — FIXED 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-640-archived-detail).

### Observed behaviour and root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-640-archived-detail).

### Fix and acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-640-archived-detail).

### Live re-check 2026-09-24 (`verify-loops`) — REOPENED, second fault fixed

[Read the detail](livetest-remediation-register-archive-2026.md#lt-640-archived-detail).

## LT-641 — agent secret-card requests were blocked on the push channel — FIXED 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-641-archived-detail).

### Observed behaviour and root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-641-archived-detail).

### Fix and acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-641-archived-detail).

### Live re-check 2026-09-24 (`verify-loops`) — REOPENED, second fault fixed

[Read the detail](livetest-remediation-register-archive-2026.md#lt-641-archived-detail).

## LT-642 — a terminal checkpoint-only loop got the restore path's internal error — FIXED 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-642-archived-detail).

### Observed behaviour and root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-642-archived-detail).

### Fix and acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-642-archived-detail).

## LT-643 — a ping-pong loop hangs after round 1's reviewer settles — FIXED 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

### Root cause (as of the first pass)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

### Investigation — 2026-09-24

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

### Fix

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

### Orchestrator review — 2026-09-24 (fix replaced)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-643-archived-detail).

## LT-644 — ping-pong reviewer verdicts request changes but carry no findings — FIXED 2026-09-24

### Observed behaviour

On 2026-09-24 the `verify-final` batch ran 3 real ping-pong loops (Claude builder, Codex reviewer).
All 6 reviewer rounds logged `Ping-pong reviewer produced a verdict {verdict: CHANGES_REQUESTED,
findings: 0}`. The `loops` batch's earlier run (`loop-1790213435794-57df2268`) shows the same shape:
the captured final reviewer output had `verdict`, `summary` and `completeness`, but no usable
`findings`. The open-issues ledger stays empty, so ping-pong check 2 (Arbitrate) can never meet its
precondition.

### What the code does

`normalizeFindings()` (`src/main/orchestration/agentic-pingpong-reviewer.ts`) silently drops any
finding without `title`, `evidence` and a valid `severity`. The verdict then still honours the
reviewer's self-reported `CHANGES_REQUESTED` (`claimedVerdict`) with an empty findings list. That is
a contradictory result: changes requested, but nothing to change.

### Not yet known

Whether Codex omits `findings`, or returns them under other field names or without `evidence`. No
raw reviewer transcript was captured. Next step: capture one round's raw final output (for example
by logging `parsed['findings']` shape at debug, or by reading the reviewer instance's `outputBuffer`
before teardown). Then decide: fix the prompt contract or field mapping, or treat a
`CHANGES_REQUESTED` verdict with zero valid findings as `malformed_output` so it is re-asked, rather
than passing an empty issue list to the builder.

### Required behaviour / acceptance

A `CHANGES_REQUESTED` verdict reaches the builder with at least one concrete finding, or is
classified as unreliable. Ping-pong check 2 can then reach Arbitrate with a real open issue.

### Evidence found and fix — 2026-09-24 (later the same day)

The raw reviewer output was not lost. AIO keeps every Codex session's rollout under
`~/.ai-orchestrator/codex/sessions/2026/09/24/`. All 7 reviewer rollouts from that day were read:
`02-30-47` (the `loops` batch's round) and `03-51-03`, `03-52-25`, `03-54-30`, `03-55-43`,
`03-58-58`, `04-00-09` (the six `verify-final` rounds). Every one is a valid JSON verdict **with a
populated `findings` array**, 8 findings in total. But every finding uses `issue` where the parser
expects `title` and `suggestedFix` where it expects `body`, and one uses `location` for `file`.
`normalizeFindings()` required `title`, so it dropped all 8.

**Root cause:** the reviewer prompt never named the finding fields. The example shows
`"findings": []`, and the field constraints cover only `severity` and `novelty`. So Codex supplied
reasonable names of its own. The drop was then silent, and a `CHANGES_REQUESTED` verdict with no
usable finding passed as "no findings". The house style forbids that ("Parse failure is an explicit
unreliable/error outcome, never … no findings").

**Fix:**

- **The prompt states the finding fields.** `REVIEWER_FINDING_FIELDS_INSTRUCTION` names `title`,
  `severity`, `file`, `evidence`, `body`, `novelty` and `ledgerId`.
- **The parser is tolerant of the observed names.** Finding normalisation moved to
  `src/main/orchestration/pingpong-reviewer-findings.ts`. It reads `issue` as the title,
  `location` as the file, and `suggestedFix`/`description`/`detail` as the body, and it counts
  what it drops.
- **The verdict fails closed.** If the reviewer listed findings and none is usable (no title,
  evidence or valid severity), the round is `UNRELIABLE` / `malformed_output`, not an empty issue
  list.

Evidence-required dropping of a single finding without evidence is unchanged.

**Tests:**

- `pingpong-reviewer-findings.spec.ts` uses the captured Codex shape, anonymised.
- Three reviewer-level tests in `agentic-pingpong-reviewer.spec.ts` cover the Codex-shaped finding
  reaching the builder, all-unusable findings becoming unreliable, and the prompt naming the fields.
  All three fail against the HEAD reviewer and pass now.
- `src/main/orchestration`: 2,990 tests pass. `tsc`, spec `tsc`, lint and the LOC ratchet are
  green.

**Still to do:** a live re-run of ping-pong check 2 (Arbitrate), which needs a real open issue and
can now get one.

## LT-652 — a send during a Codex Compact turn is burned by a sub-second retry storm and dropped

### Observed behaviour

Live, 2026-09-24, session `xecsi91o3` (Codex, `gpt-6-astra`, thread `01a0d01f-274e-7560-839f-18bc43e612c5`).
After the agent's "Work remains stopped as requested" reply, the user sent "I never requested you to stop?!"
(31 chars). Evidence from `~/Library/Application Support/harness/logs/app.log`:

- `IPC INSTANCE_SEND_INPUT` fired **6 times in 622 ms** (…2927475 → …2928552), all the same 31-char message.
- Every attempt was rejected `Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }`.
- `InstanceCommunication` logged `Suppressing repeated error` counts 4, 5 and 6 within 300 ms.
- The renderer then reported `Failed to send message after 5 retries` and restored the text to the draft.
- `Thread compacted by Codex app-server` for the same thread landed at …2984997 — **~57 s after the retries died**.
- The user's second send of the same text at …3048653 succeeded (after compaction) and is the one the agent acted on.

Throughout the retry window `sendInput state check` reported `status: 'idle'`, so the orchestrator believed
the instance was ready for input.

### Root cause

Three mechanisms stack:

1. **The Compact turn is invisible to AIO turn tracking.** Codex runs auto-compaction as an internal
   `turn_kind: Compact` turn. No `turn/started` for it reaches our runtime, so the instance stays `idle`
   and `sendInput` is attempted instead of queued. `app-server-runtime-errors.ts:98-106` already
   classifies this as `request-rejected` / `retry-thread` ("a transient scheduling collision"), which is
   only true for the brief post-`contextCompaction` race `context-cost-controller.ts:348-365` handles
   with a single delayed retry. A full auto-compact lasts far longer than one short delay.
2. **`getRetryDisposition` does not recognise the rejection.** `messaging-retry-disposition.ts:20-22`
   special-cases only `codex app-server runtime already has an active turn` / `previous turn is still
   running`. `ActiveTurnNotSteerable { turn_kind: Compact }` falls through to the generic
   `{ shouldRetry: true }` with no `nextStatus`.
3. **The intended 2 s backoff never runs.** `instance-messaging.store.ts:610-617` schedules
   `setTimeout(..., 2000)`, but the failure path first reverts the optimistic `busy` status and
   re-enqueues (`:596-608`). Any subsequent ready-status update calls `processMessageQueue`
   (`instance.store.ts:395` and `:517`), which drains the just-requeued message immediately. Observed
   spacing is ~150 ms — one IPC round-trip plus the 100 ms drain timer in `processMessageQueue`, not
   2 s. `MAX_QUEUE_RETRIES = 5` is the only brake, so the whole budget is spent inside one Compact window.

### Required behaviour / acceptance

- A `turn_kind: Compact` / `ActiveTurnNotSteerable` rejection on a user send is treated as "provider is
  compacting": the message is queued and retried only after `thread/compacted` (or a bounded delay with
  backoff long enough to outlive a compact), never dropped while the Compact turn is open.
- Queue retries are spaced by real elapsed backoff; a status revert must not immediately re-drain the
  queue it just re-filled.
- A unit test reproduces the 6-sends-in-622 ms storm against a Compact rejection and fails on the old
  code; a second test shows the message surviving until compaction completes and then delivering.
- Live: send a message while a Codex auto-compact is running; it queues and delivers after
  `thread/compacted` with no `Failed to send message after N retries` notice.

## LT-653 — the context-policy `steer-turn` text is indistinguishable from a user instruction, so agents halt work "as requested"

### Observed behaviour

Live, 2026-09-24, session `xecsi91o3`. The full conversation history contains exactly four real user turns:

1. "please take a look at what's been built and make sure it's okay please."
2. "Please fix the defects, ands do the loads and testing"
3. "Answers to your questions…"
4. "I never requested you to stop?!"

**No stop request exists anywhere in the session.** Nevertheless:

- `_scratch/catalogue-lock-verification.json` was written with
  `"status": "NOT_COMPLETE: full suite failed; user requested stop before further investigation/fixes"`.
- The handoff plan (`2026-09-23-kpi-workbook-alignment-and-data-load_plan.md`) records
  *"James requested defect fixes, loads and testing, then explicitly requested a stop to broad
  exploration, synthesis and durable notes."* and *"James asked to stop broad exploration and persist
  the current state."*
- The agent then answered the user's catalogue answers with *"Work remains stopped as requested. No live
  changes made."* and *"I'll update the handoff notes without restarting implementation."*

The same misattribution already exists in this repo at `docs/plans/2026-09-23-outstanding-plans-progress.md`
(three times: "James asked to stop broad exploration", "James instructed stopping broad exploration").

### Root cause

The wording is a paraphrase of the canned `steerActiveTurn()` string in
`src/main/cli/adapters/codex/app-server-thread-runtime.ts:173`:

> "Stop broad exploration. Synthesize what you already have, persist durable notes, and do not open new research threads."

That steer is selected by the shared context-safety policy as `steer-turn`
(`codex-app-server-adapter.ts:236-246`, `executeContextAction`) and delivered over `turn/steer` as plain
text input. On the Codex side it is indistinguishable from a user steer, so the model treats it as a
standing user instruction and writes it into durable notes as "James requested…". A `DoomLoopDetector`
runaway (`browser.tool_search` ×200) fired just before this window and is the likely policy trigger.

### Required behaviour / acceptance

- Policy `steer-turn` input is unmistakably marked as a system/context-policy action (not a user
  instruction) in the text delivered to the model, and says explicitly that it does not change the
  user's task or authorise stopping work.
- An agent's plan/handoff output must not attribute a policy steer to the user; a regression test
  asserts the delivered steer text carries the system marker.
- Existing docs that attribute "stop broad exploration" to James are corrected (at minimum
  `docs/plans/2026-09-23-outstanding-plans-progress.md`).
- Live: trigger or observe a policy `steer-turn` and confirm the agent continues the user's task
  afterwards instead of reporting work "stopped as requested".

### Fix and acceptance evidence — 2026-09-24 (both items, working tree)

**LT-652.**

- `messaging-retry-disposition.ts` now classifies a Compact-turn rejection via
  `isProviderCompactingRejection()` (`turn_kind: Compact` / `ActiveTurnNotSteerable` / `failed to
  submit turn input`) and returns `retryAfterMs: COMPACT_TURN_RETRY_DELAY_MS` (15 s) with
  `maxRetries: MAX_COMPACT_TURN_RETRIES` (12 ≈ the 180 s init-wait ceiling). Deliberately **no**
  `nextStatus`: the instance is already idle, and parking it on `busy` would make `processMessageQueue`
  refuse to drain at all.
- `QueuedMessage.retryAfterAt` carries the backoff on the entry itself, and `processMessageQueue`
  refuses to drain a head entry whose gate has not opened. That is the load-bearing fix: the
  ready-status drain in `instance.store.ts:395/:517` can no longer re-send the moment the failure
  path reverts the optimistic `busy` — the mechanism behind the 622 ms storm.
- `sendInputWithTimeout` moved to `instance-messaging-send-utils.ts` to hold the LOC ratchet.

Tests (all fail on the old code, pass now):

- `messaging-retry-disposition.spec.ts`: Compact rejection is recognised and gets the long backoff /
  larger budget, with no `nextStatus`.
- `instance-messaging.store.spec.ts` `LT-652: holds a Compact-turn rejection with backoff instead of
  a sub-second retry storm` — reproduces the xecsi91o3 shape (5 rapid `processMessageQueue` calls
  after one failed send) and asserts exactly one IPC send, the message still queued with
  `retryAfterAt`, no `after 5 retries` drop, and the first backoffed retry at 15 s.
- `instance-messaging.store.spec.ts` `LT-652: delivers a held Compact-turn message once the provider
  stops rejecting` — the queued message delivers on the retry after compaction.

**LT-653.**

- `CONTEXT_POLICY_STEER_TEXT` (`app-server-thread-runtime.ts`) replaces the bare "Stop broad
  exploration…" string. It is framed as `[SYSTEM CONTEXT-POLICY STEER — automated policy action, not a
  user message.]`, states that the user has **not** asked to stop or change task, scopes the wrap-up
  to the current turn, and says to continue the user's task afterwards.
- `app-server-thread-runtime.spec.ts` asserts the steer payload is the framed constant and that the
  marker, the "not a user message" disclaimer, the "NOT asked you to stop" line and the
  continue-the-task line are all present.
- Three attributions in `docs/plans/2026-09-23-outstanding-plans-progress.md` that credited the steer
  to James are corrected in place, with an LT-653 note on each.

Canonical gates after both fixes: `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`,
`build:main`, `build:renderer` all green. `test:quiet` full suite: **2,223 files / 26,480 tests
passed** (`_scratch/test-run.pid-40104.log`).

**Still to do (live, needs a rebuilt app):**

- LT-652: send a message while a Codex auto-compact is running and confirm it queues and delivers
  after `thread/compacted`, with no `Failed to send message after N retries` notice.
- LT-653: observe a policy `steer-turn` and confirm the agent continues the user's task instead of
  reporting work "stopped as requested".

## LT-654 — Codex provider Compact turns are invisible to lifecycle ownership — FIXED IN CODE; live checks pending

### Observed behaviour

On 2026-09-24, instance `xqhsuju06` reported idle and accepted James's send while Codex was running
an internal `turn_kind: Compact`. Six submissions were rejected with
`ActiveTurnNotSteerable { turn_kind: Compact }` within roughly one second and the message was
dropped; the provider Compact turn finished about 100 seconds later. Earlier instances
`xfbaestxb` and `xm9076fqy` hit the same race during controlled recovery, transitioned to error,
and were subsequently killed as zombies.

### Root cause

The app-server's internal Compact turn was not represented in adapter/instance lifecycle state.
`contextCompaction` item signals did not own busy/idle, callers submitted into the provider turn,
and a strict Compact rejection was treated as an ordinary retry-thread failure. Completion was
also ambiguous: the compaction item can finish before the owning Compact turn closes, while outer
send completion could overwrite the still-running lifecycle with idle.

### Required behaviour / acceptance

- Provider compaction owns busy state from the first signal or strict rejection until the Compact
  turn actually closes; successful/recoverable send exits cannot overwrite it with idle.
- User, automation, orchestration, steering and controlled-recovery submissions wait, retry at
  most once after the real completion, and serialize rather than collide.
- Stalled, failed, interrupted, cancelled and runtime-exit paths clear state without a zombie
  status. Idle hibernation and context policy do not act on live compaction or its display-only
  occupancy estimate.
- Rebuilt-app checks 1, 2 and 4 in
  `2026-09-24-codex-compaction-turn-visibility_livetest.md` pass.

### Fix and acceptance evidence — 2026-09-24

The Codex adapter now has a first-class compaction signal tracker, bounded gate, lifecycle
presentation, schema-valid compact-status events, serialized outer sends, strict Compact-rejection
inference/retry for sends and steering, controlled-recovery handoff ownership, runtime-exit/stall
cleanup, and compaction-aware terminal status. The hibernation sweep has a direct regression and
post-compaction occupancy is excluded from policy/warning feedback.

Focused regressions and the complete pinned-Node suite pass (2,226 files / 26,526 tests,
`_scratch/test-run.pid-61166.log`). A sixth independent `task-completion-gate` review returned
`VERDICT: PASS`. Live checks remain open because they require a rebuilt app, real Codex compaction,
and the 35-minute sweep window.

Canonical implementation/as-built record:
[`2026-09-24-codex-compaction-turn-visibility_plan_completed.md`](2026-09-24-codex-compaction-turn-visibility_plan_completed.md).

## LT-655 — normal Codex compaction renders as errors and fabricated 0% occupancy — FIXED IN CODE; live check pending

### Observed behaviour

The incident transcript collapsed Compact-turn rejections into an error card, showed a
`Context compacted [self-managed]` boundary without explaining that the provider was still working,
and reset the header meter from the last observed 75.6% to a fabricated 0%. The composer gave no
queued-send explanation.

### Root cause

Compaction presentation reused generic error/busy rendering and `buildObservedCompactionEvents`
constructed an unconditional zero-token context event. The renderer had no first-class provider
compaction lifecycle to distinguish this normal boundary from a failed user turn.

### Required behaviour / acceptance

During compaction, the header/composer explain that Codex is compacting and queued input will send
afterwards. Legacy Compact rejection output renders as a compaction notice, not an error card.
Afterwards, the meter retains a clearly estimated last-known value or says updated usage is pending,
then yields to the next real provider reading. The self-managed boundary and recovery action remain
truthful. Rebuilt-app check 3 passes.

### Fix and acceptance evidence — 2026-09-24

The renderer now consumes validated compact-status lifecycle events, presents a dedicated
compaction/queued-message state, suppresses the misleading interrupt hint, and defensively converts
legacy Compact rejection output into a boundary notice. The adapter no longer emits a fabricated
zero reading; last-known occupancy is marked estimated/display-only, and the first real update
replaces it. `Recover context` remains because the wired action restores real bounded wake/verbatim
context. Component/service tests and the production Angular AOT build pass; live check pending.

## LT-656 — context policy, provider action proof and compaction lifecycle are not directly queryable — FIXED IN CODE; live check pending

### Observed behaviour

The 2026-09-24 incident timeline could infer a policy steer only from the agent's paraphrase, and
compaction required joining adapter captures with app logs. Repeated Compact rejection suppression
also omitted the instance status and compaction state needed to distinguish a storm from a dead
provider.

### Root cause

Policy decisions, provider action execution/proof, provider compaction lifecycle and repeated-error
suppression were logged by separate incomplete paths without a shared set of identifiers, trigger,
outcome or duration fields.

### Required behaviour / acceptance

Logs identify policy trigger/action/reason/occupancy/instance, action proof stage, and compaction
instance/thread/turn/trigger/outcome/duration. `lifecycle.ndjson` contains a first-class
`provider-compaction` record, and repeated-error suppression names current status and compaction
state. Rebuilt-app check 5 passes without joining the capture database.

### Fix and acceptance evidence — 2026-09-24

Structured `ContextSafetyPolicy`, `ProviderContextAction`, provider-compaction lifecycle and
repeated-error diagnostics are implemented and regression-tested. Terminal outcomes including
aborted, stalled and cancelled are retained rather than flattened to completed. Canonical builds,
typechecks, lint and the full suite pass; live log-shape confirmation remains open.

## LT-657 — Harness-authored input reached the model and the transcript as the user's own message — FIXED IN CODE; live check pending

### Observed behaviour

Live, 2026-09-24/25, instance `x7cpyakhs` ("Verification Implementation", Codex `gpt-5.6-sol`,
`/Users/suas/work/communitytech`, native thread `01a0d47e-f9fc-76e3-b1ef-0c6d52b651f1`). The agent
stopped implementing ("Stopped as requested", 19:38 BST), and when asked "Who requested you stop?"
(20:10:58) it answered "You did, in your immediately preceding message: 'Stop broad exploration.
Synthesize what you already have, persist durable notes, and do not open new research threads.'" The
user never sent that text; the instance's AIO transcript has no such user entry.

Every occurrence in the Codex rollout is a `response_item` `message` with `role: "user"` plus a
`UserMessage` item, and each matches a `context-policy-decision` / `steer-turn` /
`known-occupancy-70` row in `conversation-ledger.db` `context_evidence_events` (conversation
`3d5a7a36-68ca-4805-9668-9fbb9ae536fb`) 0.4–7 s earlier:

| Policy decision (BST) | Occupancy | Rollout user item (UTC) | Codex item id |
|---|---|---|---|
| 09-24 18:56:51 (`d3a29b4c…`) | 183414/258400 | 17:56:56 | `msg_01a0d490-3677-7fd2-baff-928ffb16bbb4` |
| 09-24 19:26:27 (`dd0aa849…`) | 183896/258400 | 18:26:34 | `msg_01a0d4ab-596d-7613-8210-a466bbe6fa1e` |
| 09-24 20:11:06 (`a009de90…`) | 190035/258400 | 19:11:06 | `msg_01a0d4d4-1fc6-7590-be1a-44776ee27b26` |
| 09-25 02:26:05 (`9a2777f8…`) | 192350/258400 | 01:26:12 | `msg_01a0d62b-8a1a-7021-af72-de74f0b2e833` |
| 09-25 03:16:50 (`26368bce…`) | 185398/258400 | 02:16:56 | `msg_01a0d659-fc5e-7583-99fb-c527a8306890` |

The 02:26 steer landed 24 s after the user wrote "I never said that, some subagent or somethign said it".

### Root cause

`CodexAppServerThreadRuntime.steerActiveTurn()` delivered `CONTEXT_POLICY_STEER_TEXT` over
`turn/steer`, whose `input` is `UserInput[]`. Codex persists steer input as a user message, so the
model sees the policy text as the user's words and later quotes it back as the user's instruction.
LT-653 only reworded the text; the channel, and therefore the role, were unchanged (two
LT-653-worded steers were still recorded as `role: "user"` on 2026-09-25 at 09:22 and 09:55 BST).

The same class of defect existed for every Harness-authored `InstanceManager.sendInput`: the
message was stored and published as `type: 'user'`, recorded in prompt history, run through slash-
command resolution and the `UserPromptSubmit` hook, sent unmarked, replayed on resume as `Human:` /
"Current objective", and re-sent after a provider-limit or account failover as a fresh user turn.
Affected sources: background-work and stalled-work check-ins, announce-then-halt and transport-
recovery continuations, the parent's child-status request, child announcements to the parent,
LSP feedback, restart-with-summary continuity packages, plan-queue parent and worker messages,
reaction feedback, browser-gateway resume nudges and the provider-limit continuation turn.

### Required behaviour / acceptance

- Internal controller instructions never reach the model, the transcript, prompt history, replay or
  the ledger as user-authored input; they carry explicit Harness provenance and the correct role.
- The Codex context-policy steer reaches the live turn as a developer-role item.
- Genuine user messages keep their role, text and order; retries and re-sends cannot convert a
  Harness turn into a user message.
- Evidence is preserved: no raw rollout, ledger or continuity record is rewritten.

### Fix — 2026-09-25 (working tree)

- `app-server-thread-runtime.ts`: the steer is appended with `thread/inject_items` as
  `{ type: 'message', role: 'developer' }`; `turn/steer` is no longer used for policy input.
  `CONTEXT_POLICY_STEER_TEXT` names Harness, says the user has not asked to stop, and forbids
  attributing it to the user. `compaction-runtime.ts` records a visible Harness notice
  (`CONTEXT_POLICY_STEER_NOTICE`, `metadata.internalInput`) when the steer is acknowledged.
- `InstanceSendInputOptions.internalSource` (`shared/types/input-provenance.types.ts`): the message
  is stored as `type: 'system'` with `metadata.internalInput = { actor: 'harness', source }`, skips
  prompt history, slash-command and switch-mode-reply handling and `UserPromptSubmit`, and is sent
  inside a `<harness_internal_message source="…">` envelope
  (`instance/internal-input-provenance.ts`). All AIO-authored send sites above pass a source.
- Re-sends (`resendInput` for provider-limit/account failover, `thread-wakeup-runner` for the durable
  resume automation) parse Harness's own envelope back into `internalSource`
  (`automatedResendInput`); the provider-limit continuation turn is built enveloped.
- Orchestrator responses (including child completions) name "Source: Harness orchestrator
  (automated; not a message from the user)".
- Codex rollout import maps `developer`/`system` roles to ledger `system` (was `assistant`);
  continuity persists and restores `internalInput`; the renderer labels such messages
  "Harness (automated)" with its own header; markdown export labels them "Harness (automated)".
- User-authored text delivered by automation (scheduled automation prompts, re-sends of the user's
  own throttled prompt) and channel messages keep user provenance.
- Codex app-server turns started by Harness (fresh-eyes review round 1): `internalSource` travels
  `InstanceCommunicationManager.sendInput` → `BaseCliAdapter.sendInput(…, { internalSource })` →
  `metadata.internalSource`; the Codex turn builder then injects the prepared text as a developer item
  and calls `turn/start` with empty `input` (probed live on 0.157: the turn runs, no `userMessage`
  item). The same-thread continuation after a controlled interrupt/compaction
  (`COST_RECOVERY_CONTINUATION`) and orchestrator responses (child completions to the parent) take this
  path. Parent-agent `message_child` text is `internalSource: 'parent-agent-message'`.
- The idle monitor counts Harness-authored input as conversation, so a child driven only by it
  hibernates instead of being terminated.
- Retry lanes keep provenance (fresh-eyes review round 2): `LastSentTurn` and `AuthRepairTurn` carry
  `internalSource`, so the context-overflow retry after compaction and the auth-repair re-send after
  sign-in re-dispatch a Harness turn with `{ internalSource }` (Codex developer channel) instead of as
  user input. Orchestrator responses are framed by `formatCommandResponse` ("Source: Harness
  orchestrator …") and go to adapters directly with `internalSource: 'orchestrator-response'`, not
  through the `sendInput` envelope.
- Providers without a non-user channel (Claude, Gemini, ACP providers, remote nodes, Codex exec mode)
  still receive Harness turns over user transport, inside the envelope that names Harness and forbids
  attributing the text to the user. Re-send paths recover provenance by parsing that exact envelope; a
  user who pastes a byte-identical envelope as their own message would have that one re-send labelled
  as Harness input (documented in `internal-input-provenance.ts`).
- `thread/inject_items` has no expected-turn precondition: a steer racing the end of its turn stays in
  history as a developer note for the next turn (documented on `steerActiveTurn`); it names Harness
  and cannot be read as a user request.

### Evidence

- Reproduction against the real Codex 0.157 binary with the compiled runtime
  (`_scratch/provenance/e2e-runtime-steer*.cjs`): pre-fix runtime + original text → steer persisted
  `role: "user"`, and asked "did I ask you to stop?" the agent answered "Yes—you asked me to 'Stop
  broad exploration' … that instruction came from you, the user." Fixed runtime → `thread/inject_items`,
  persisted `role: "developer"`, no user item, task completed, answer "No, you never asked me to
  stop … came from an automated developer-level harness context policy." Control (new channel,
  original text) → also "No … came from a developer message", so the channel alone fixes attribution.
- Regression tests (each shown failing on the old code or with its fix reverted):
  `app-server-thread-runtime.spec.ts` (developer item, never user input, duplicate delivery),
  `instance-manager.send-input.spec.ts` (system storage, envelope, ordering, retry, provider-limit
  re-send, resume replay serialisation, no slash-command resolution), `internal-input-provenance.spec.ts`,
  `compaction-runtime.spec.ts` (steer notice), `thread-wakeup-runner.spec.ts`, `codex-rollout-parser.spec.ts`,
  `continuity-message-projection.spec.ts`, `display-item-processor.service.spec.ts`,
  `message-format.service.spec.ts`, `orchestration-protocol.spec.ts`, plus updated call-site specs.

### Impact and historical data (not rewritten)

- Codex rollouts under `~/.ai-orchestrator/codex`: 38 user-role steer records in 26 threads
  (2026-09-23 15:13 UTC → 2026-09-25 08:55 UTC); 36 original text, 2 LT-653 text. Pooled-account homes: none.
  Same-thread continuations (`COST_RECOVERY_CONTINUATION`) recorded as `role: "user"`: 376 in 80 threads.
- AIO transcripts stored as `user`: stalled check-ins 79 in 38 live sessions (+47 in 22 archived),
  child announcements 45 in 30, continuity packages 30 in 14, transport recovery 7 in 6 (+6 in 5),
  provider-limit continuation 1 (+14 in 2), background-task continuation 1 (+1).
- Durable notes that still credit the user: `Dingley/dingley-kpi/dingley-kpi-fe/docs/superpowers/plans/2026-09-23-kpi-workbook-alignment-and-data-load_plan.md`
  lines 5 and 96 (outside this repo, left for the owner). The in-repo line in
  `2026-07-23-skill-observability-and-design-skills_livetest.md` is corrected.
- Historical entries keep their stored role. A safe repair would be a derived, reversible
  annotation (adding `internalInput` to matching continuity entries, never editing rollouts or
  ledger raw rows); it is not performed without the owner's approval.

### Still to do (live, needs a rebuilt app)

1. In a Codex session that reaches the 70% context policy, confirm the transcript shows the
   "Harness (automated)" context-policy notice, the rollout records the steer as `role: "developer"`,
   and the agent continues the task rather than reporting a user stop request.
2. Trigger a stalled-work check-in or child announcement and confirm it renders under a
   "Harness (automated)" header, not as a user bubble, and is absent from prompt history (↑ recall).

<a id="lt-658"></a>

## LT-658 — Browser Gateway type mutates disabled and readonly controls — FIXED IN CODE; live re-check pending

**Observed behaviour — 2026-09-27.** While running check 3 of
[`2026-08-28-browser-gateway-unattended-portal-fixes_livetest_completed.md`](2026-08-28-browser-gateway-unattended-portal-fixes_livetest_completed.md#check-3--type-fails-loudly-on-a-non-typeable-target)
through the loaded Windows extension (version 0.2.36), `browser.type` returned `outcome:
"succeeded"` for both `input[name="my-disabled"]` (audit
`08316ae9-09ca-4676-8ab6-d9345cd80d90`) and `input[name="my-readonly"]` (audit
`98045bc3-0c2e-432a-86ef-7216d447bb18`) on Selenium's public web-form fixture.
`browser.query_elements` then proved that both controls' values had changed to the probe text even
though the former still reported `disabled: true` and the latter remained readonly. The same run's
plain `div` target failed correctly with the existing tag-specific remedy.

### Root cause

Both extension write paths deliberately call native value-property setters so React and other
controlled inputs observe the change. That mechanism also bypasses the browser's normal user-input
rules. `uidTypeFn` and selector-path `applyType` validated the element kind but never checked
`element.disabled` or `element.readOnly`, so they performed the write, dispatched input/change
events, and reported success.

### Required behaviour / acceptance

- Selector and accessibility-UID type operations refuse a disabled native control before changing
  its value or dispatching input/change events.
- Both paths refuse a readonly native control before changing its value or dispatching events.
- The failure names the target tag and the disabled/readonly state, and tells the caller to choose
  an enabled/editable target.
- Ordinary inputs, contenteditable hosts and valid select handling retain their existing behavior.
- The rebuilt/reloaded Windows extension returns explicit failures for the original live inputs,
  and the controls retain their original values.

### Fix and evidence — 2026-09-27 (working tree)

- `resources/browser-extension/background.js`: both self-contained write paths now guard disabled
  and readonly controls before option matching, focus, native setter use, or event dispatch.
- `browser-extension-accessibility-frames.spec.ts`: new UID and selector regressions assert the
  state-specific refusal and prove that the original value is unchanged. The three tests failed on
  the original code, then the focused file passed **62/62** after the fix.
- The required extension release identity was advanced to v0.2.37 and the append-only bundle map
  records SHA-256 prefix `7b8b2245d0af`; the accessibility and asset suites pass **148/148**.
- Remaining: stage/reload v0.2.37 on `windows-pc` and repeat the two live calls under
  [RES-023](2026-09-27-livetest-human-external-residuals_livetest.md#res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live). The current worker remains on the
  pre-fix v0.2.36 service worker until James performs that explicit extension reload.

<a id="lt-659"></a>

## LT-659 — standalone zero-reviewer CLI failed while opening Electron settings — FIXED + CONFIRMED LIVE

[Read the detail](livetest-remediation-register-archive-2026.md#lt-659-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-659-archived-detail).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-659-archived-detail).

### Fix and evidence — 2026-09-27 (working tree)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-659-archived-detail).

<a id="lt-660"></a>
## LT-660 — terminate confirmation lets keyboard focus escape its modal — FIXED IN CODE

**Observed behaviour — 2026-09-21.** The real terminate confirmation initially focused
`.confirm-dialog`, then Tab reached **Keep running**, **Close session**, and on the third press an
app-shell `.rail-btn` behind the overlay. The overlay still declared `aria-modal="true"`, telling
assistive technology that the background was inert while keyboard focus could reach it.

### Root cause

`TerminateConfirmDialogComponent` called `focus()` once from an effect but had no Tab containment
or trap lifecycle. The repository's shared `createFocusTrap()` already implements cycling, nested
trap precedence, stale-container cleanup and focus restoration; this modal simply did not use it.

### Required behaviour / acceptance

- Opening retains the existing initial focus on the dialog question.
- Tab moves through **Keep running** and **Close session**, then wraps to **Keep running**; Shift+Tab
  remains inside the same dialog through the shared trap behavior.
- Closing or destroying the dialog deactivates the trap and restores a still-connected opener.
- Escape, backdrop dismissal and both action buttons retain their current behavior.

### Fix and evidence — 2026-09-27 (working tree)

- `terminate-confirm-dialog.component.ts` now activates the existing shared trap around the dialog,
  requests the dialog itself as initial focus, and closes/restores the trap when the request clears
  or the component is destroyed.
- A component regression reproduces the exact third-Tab escape. It failed on the original code
  because the first Tab was not intercepted, then the component and shared-focus-trap suites passed
  **21/21** after the fix. Renderer TypeScript also passes.
- The final rebuilt-window re-check is consolidated into AR-006; the Harness UI is a hard-denied
  Computer Use target in this session, so the source campaign is not claiming that UI evidence.

<a id="lt-661"></a>

## LT-661 — title escalation stopped after the first installed provider failed — FIXED + CONFIRMED LIVE

[Read the detail](livetest-remediation-register-archive-2026.md#lt-661-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-661-archived-detail).

### Required behaviour / acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-661-archived-detail).

### Fix and evidence — 2026-09-27 (working tree)

[Read the detail](livetest-remediation-register-archive-2026.md#lt-661-archived-detail).

<a id="lt-662"></a>
## LT-662 — single-setting preload calls used the wrong IPC payload shape — FIXED IN CODE

**Observed behaviour — 2026-09-27.** While recording the original values for Plan Queue's
relaxation-profile live check, both
`window.electronAPI.getSetting('computerUseAutonomyLevel')` and
`getSetting('providersExcludedFromAutomation')` returned `SETTINGS_GET_FAILED`. The live handler
reported `IPC validation failed for SETTINGS_GET: Invalid input: expected object, received
string`. Reading all settings through `getSettings()` was unaffected.

### Root cause

`createInfrastructureDomain().getSetting()` invoked `SETTINGS_GET` with the key string as its
payload. The main-process handler validates `SettingsGetPayloadSchema`, whose contract has long
been `{ key: string }`, before reading the settings manager. The adjacent single-setting set and
reset preload methods already use object payloads, leaving this one bridge out of sync with the
schema.

### Required behaviour / acceptance

- `electronAPI.getSetting(key)` sends `{ key }` on `SETTINGS_GET`.
- A live call reaches the handler and returns the requested setting rather than a validation error.
- The existing setting allow-list remains enforced by the handler; the preload does not bypass or
  duplicate that policy.

### Fix and evidence — 2026-09-27 (working tree)

- `infrastructure.preload.ts` now wraps the key in the schema-backed payload object.
- A focused preload-domain regression failed on the original bare string and now passes **4/4**.
- Main TypeScript passes. The rebuilt isolated-runtime call is pending in the owning Plan Queue
  check because the loaded preload predates this fix.

<a id="lt-663"></a>

## LT-663 — long tool-heavy turns lose their recorded evidence source outside the 200-row window

[Read the detail](livetest-remediation-register-archive-2026.md#lt-663-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-663-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-663-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-663-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-663-archived-detail).

<a id="lt-664"></a>
## LT-664 — retiring a Local AI target leaves its incidents open forever

**Status: open, reproduced live 2026-10-04 (packaged app built 19:06 from `3d05e250e`).**

### Observed behaviour

The legacy Ollama target `733d66c0-7e97-49cd-82e6-5462234237b9` was retired at 12:47:34 BST.
At 23:19, `$AIO_MCP local-ai status` (and `--json`) still listed incident
`51c88683-e9a8-4d29-84f5-1eafada561b4` for that target as `open` (`warning`,
`connection-refused`, opened 25 h earlier, last `updatedAt` 06:58 — before the retirement).
Aggregate state was `healthy`, so routing was unaffected, but the incident list — which feeds the
Health Centre and any incident notification — carries a permanent stale warning for a target that
no longer exists in `list`. Acknowledging it (done during the run) only moves it to `acknowledged`;
it stays listed.

### Root cause

`LocalAiPublicOperations.setLifecycle` (`src/main/local-ai-guard/local-ai-public-operations.ts:92`)
updates the target and notifies the runtime. The health scheduler stops probing retired targets,
and the only code that sets an incident `resolved` is the recovery path in
`LocalAiHealthRepository.upsertIncident` (`local-ai-health-repository.ts:146-150`), which runs
when a probe recovers. Nothing resolves or closes incidents on retirement, and
`local-ai-management-operations.ts:113-114` lists every `open`/`acknowledged` incident without
filtering out retired targets.

### Required behaviour

Retiring a target closes (or marks resolved with a "target retired" reason) its open and
acknowledged incidents, atomically with the lifecycle change, so that status, the Health Centre and
notifications stop reporting a target that no longer exists. Re-enrolling must start clean.

### Acceptance

- A regression test retires a target with an open incident and asserts the incident is no longer
  `open`/`acknowledged` and is absent from `status().incidents`; watch it fail without the fix.
- Live: after retiring a target with an open incident, `local-ai status` lists no incident for it.
- The existing `51c88683-…` incident is cleaned up by the fix (migration or first retirement pass).

<a id="lt-665"></a>

## LT-665 — `check_session` treats an unreadable page as logged out and drives a credential re-login

**Status: open.** Reproduced live 2026-10-04 on `windows-pc` (extension 0.2.37, packaged app built
19:06) and again on 2026-10-11 (restored LCN tab, pageId `771576274`). The check-session guard and
the inventory stamp are fixed in the working tree (extension 0.2.39). Live confirmation needs that
extension on `windows-pc`.

### Observed behaviour

`browser.check_session {autoRelogin: true}` on James's shared In-tend tab `771568875`
(`…/educationportal/tenders/current`) returned `{state: "logged_out", reason: "relogin_failed",
attempts: 2, escalationId: "33e4ab9a-3996-4a99-84a7-630c6cb6f953", parked: true}`. The audit trail
(23:23:54–23:24:07 BST) shows: `browser.snapshot` "page text could not be read
(host_permission_denied)"; `browser.query_elements` failed "Cannot access contents of the page";
then `browser.navigate` to the recipe's login URL and `browser.fill_credential` "failed after filling
0 field(s)", repeated for attempt 2. `app.log` `BrowserSessionRelogin`: `relogin credential fill
refused: credential_fill_failed` ×2. A snapshot immediately afterwards showed the tab on
`…/cpcatapult/home` greeting "Hello, James … User: James Lawrence" — he was signed in the whole
time. Net effect: the user's tab was navigated away, a vault credential fill was attempted on a
signed-in session, and a false escalation was parked for James.

### Root cause

On 2026-10-04, `evaluateLiveSession` treated a target as unobservable only when
`isOpaqueBrowserTarget(...)` was true. `deriveBrowserTargetInspectionState`
(`browser-target-inspection.ts`) maps only the two secret-observation reasons to opaque; any other
`textUnavailableReason`, including `host_permission_denied` and `page_text_read_failed`, falls
through to `readable`. The evaluation then ran on empty page text, a failed element query
(`elements.data` undefined → `hasPasswordField: false`) and the title alone, so the recipe's markers
were "missing" and `evaluateSessionState` returned `logged_out / fingerprint_markers_missing`, which
started the re-login loop. This is the same "unreadable reported as readable" family as LT-218, on a
path that acts on the conclusion.

`evaluateLiveSession` now returns `unknown` for any `textUnavailableReason` before it scores markers
(`browser-session-relogin.ts`, covered by `browser-session-relogin.spec.ts`). The stamp that made
the page look readable is still there, and it is what a restored tab hits. See the 2026-10-11
reproduction below.

### Required behaviour

When the page's text or elements cannot be read for any reason, `check_session` returns
`state: "unknown"` with the specific unreadable reason and never navigates or fills a credential.
A failed `query_elements` must not be read as "no password field". Re-login may only start from a
positive logged-out signal observed on a readable page. A tab the extension cannot script must not
be inventoried as `inspectionState: "readable"`.

### Further reproduction — 2026-10-11, restored tab reported readable

After James restarted `windows-pc`, Chrome restored the LCN tab (pageId `771576274`). Its snapshot
correctly returned `textUnavailableReason: "host_permission_denied"`, and `query_elements` failed
with "Cannot access contents of the page. Extension manifest must request permission to access the
respective host." The tab was still reported as readable. `browser.navigate` reloaded it and the
permission failure cleared.

Chrome refuses `chrome.scripting.executeScript` on a tab restored at startup until that document is
reloaded, and it uses this host-permission message even when the manifest already grants
`http://*/*` and `https://*/*` (`resources/browser-extension/manifest.json`). The `tabs` permission
still supplies the URL and title, so the payload looks like an ordinary page.

`buildTabPayloadLocked` (`resources/browser-extension/background.js`) sets `inspectionState` to
`readable` whenever the tab is not secret-tainted and the post-capture `chrome.tabs.get` identity
check succeeded. A host-permission failure only fills `textUnavailableReason`; it does not flip
`inspectionUnavailable`. `deriveBrowserTargetInspectionState`
(`src/main/browser-gateway/browser-target-inspection.ts`) returns that stamped `readable`
immediately, so `list_targets` reports the tab as readable while the snapshot, separately, names
`host_permission_denied`.

`evaluateLiveSession` returns `unknown` with the specific reason for
`host_permission_denied` and `page_text_read_failed` (`browser-session-relogin.ts`, covered by
`browser-session-relogin.spec.ts`). That stops the re-login.

**Fix (working tree, extension 0.2.39).** `buildTabPayloadLocked` sets `inspectionState` to
`inspection_unavailable` for those two reasons and still returns the real URL and title.
`deriveBrowserTargetInspectionState` does the same even when an older extension stamped
`readable`, so `list_targets` follows the permission failure before the extension is reloaded.
Close-matching skips that tab unless `includeInspectionUnavailable` is set, which is the existing
rule for a tab whose contents cannot be read.

### Acceptance

- Regression tests: a snapshot with `textUnavailableReason: "host_permission_denied"` (and
  `page_text_read_failed`), and separately a failed element query, yield `unknown` and zero
  navigate/fill calls; each test fails without the fix.
- Live: `check_session {autoRelogin: true}` on a `windows-pc` tab the extension cannot read returns
  `unknown` with the reason, leaves the tab URL unchanged, writes no `fill_credential` audit row and
  parks no escalation.
- A host-permission failure (and `page_text_read_failed`) sets `inspectionState` to something other
  than `readable` on the extension payload, and `list_targets` reports that state. A regression
  test fails while `buildTabPayloadLocked` still stamps `readable` beside `textUnavailableReason:
  "host_permission_denied"`.

<a id="lt-666"></a>

## LT-666 — page-specific login markers make a recipe unrecoverable, misreported as a fill refusal

**Status: open, reproduced live 2026-10-04 (same run as LT-665).**

### Observed behaviour

The persisted In-tend recipe (scope `bb62e3ee-…`, created ~17:22 BST by an earlier session) uses
`loggedInMarkers: ["My Tenders", "Current"]` and `loginUrl: …/cpcatapult/home`. On readable,
signed-in In-tend pages the markers are absent: `check_session {autoRelogin: false}` on the tender
details tab `771568863` returns `logged_out / fingerprint_markers_missing`, and the signed-in home
page (the recipe's own login URL, text "Hello, James … Manage Your Details") contains neither marker.
Re-login therefore navigates to a page that is already signed in, finds no password field, and
fails with `credential_fill_failed` on both attempts — reported to James as "Auto re-login failed",
not as a recipe/marker problem.

### Root cause

`evaluateSessionState` requires every marker to appear in the current page's text, so markers must
be session-wide, but `browser.remember_login_fingerprint` accepts any strings without checking that
they are present on the live page at record time. `attemptRelogin`
(`browser-session-relogin.ts:330-356`) proceeds to `fill_credential` without first checking whether
the login URL actually presents a login form, so an already-signed-in session becomes a credential
fill failure.

### Required behaviour

- `remember_login_fingerprint` verifies that each marker is present on the live (readable) page and
  refuses or warns otherwise, with guidance to pick session-wide markers (account name, "Log out").
- If the login URL shows no password field after navigation, re-login stops without filling and
  reports `markers_not_matched_on_signed_in_page` (or similar) so the recipe can be corrected; it
  never reports a credential refusal for a page with no credential form.

### Acceptance

- Regression tests for both guards, each failing without the fix.
- Live: re-record the In-tend recipe with session-wide markers; `check_session` reports
  `logged_in / fingerprint_matched` on both a home and a tender-details page, then re-run
  [login recipe checks 1 and 2](2026-09-23-browser-login-recipe-persistence_livetest.md).

<a id="lt-690"></a>

## LT-690 — an OpenCode MiMo output-ceiling ending is classified as an ordinary completion

**Status: open, reproduced live 2026-10-04 (livetest campaign batch C, dev app, profile `/tmp/aio-lt-1004-c`).**
Origin: [provider hardening check 1](2026-10-02-provider-hardening_livetest.md), steps 2-3.

### Observed behaviour

Root orchestrated OpenCode session `iy3gral1r`, model `xiaomi-token-plan-ams/mimo-v2.6-pro`, YOLO on,
orchestration unpaused, outside any loop. After a bounded ordinary turn (completed correctly, see the
provider-hardening evidence), a plain request to output the English words for every integer from one upward
"as far as you can get" ran until the model hit the output ceiling.

- OpenCode's own record of the turn (`opencode export`, session `ses_ef6f041d8ffervrJdv7AsOjMcw`): assistant
  message `finish: "length"`, part `step-finish:length`, tokens output 16229, reasoning 155.
  16229 + 155 = 16384 = the combined cap Harness injected.
- Harness `app.log`, 2026-10-04 22:39:13Z (epoch ms 1791153553822), copied to
  `_scratch/lt-2026-10-04/c/log-c-slices.ndjson`: `ACP turn completed ... stopReason: "end_turn",
  outputTokens: 16229, reasoningTokens: 155, classifierReason: "completed", evidence: "provider_completed",
  generationBudget: { combinedOutputTokens: 16384, reasoningBudgetSupported: false }`; the matching
  `ProviderTurnEnding` line at ...824 says the same.
- The transcript holds the user prompt and one 84,220 character assistant message that stops mid-number
  ("... two thousand seven hundred ninety"). No notice row and no Harness continuation was produced (the log
  shows only the two `sendInput` calls I made, both `autoContinuation: false`).
- Raw wire capture, `_scratch/lt-2026-10-04/c/acp-wire-probe.out` (a bare ACP client against
  `opencode acp` with the same model capped at 160 tokens): the `session/prompt` result is
  `{"stopReason":"end_turn","usage":{...,"thoughtTokens":161},"_meta":{}}`. OpenCode's ACP server maps its
  `length` finish to `end_turn` and attaches no finish, length or error field of any kind.

### Root cause

`classifyTurnEnding` (`src/main/cli/turn-ending-classifier.ts`, the `['max_tokens','max_output_tokens','length']`
branch) only produces `max_output` from a native stop/finish string or from collapsed reasoning. With installed
OpenCode 1.18.34 neither is present for a pure length ending, so the final fall-through returns
`completed / provider_completed`. `docs/plans/2026-10-02-provider-hardening_plan_completed.md` (lines 49 and
172) already records that the installed binary does not map `length` to `max_tokens` and that a local upstream
patch (`_scratch/provider-hardening/opencode-length-finish.patch`) was proposed but not applied. The adapter does
hold the cap (`generationBudget.combinedOutputTokens`, `acp-turn-completion.ts:20,67`) and the turn's output and
reasoning tokens, but nothing compares them, so the cap is enforced upstream while the ending stays invisible.

### Required behaviour

A turn on a scoped MiMo model whose `outputTokens + reasoningTokens` reaches `combinedOutputTokens` (allowing for
a small tolerance), with no open tool call and a visible answer that is not a finished sentence, is classified
`max_output` with a Harness-side evidence label (for example `budget_saturated`), so the existing two-prompt
bound, the safe notice, the paused/managed-loop notice-only rule and the metadata-only logging all apply. Ordinary
completions well under the cap stay `completed`. (Alternative: apply the upstream length mapping and verify it live;
that alone would not help an OpenCode that has not yet taken the patch.)

### Acceptance

- A regression test that feeds an ACP result of `end_turn` with usage summing to the configured cap and asserts
  `max_output`, plus a negative test with usage far below the cap that asserts `completed`; the first fails
  without the fix.
- Live: repeat provider-hardening check 1 step 2 (ceiling turn) and see the notice and at most two automatic
  prompts, with `classifierReason: "max_output"` in the `ACP turn completed` log and no thinking or task text in it.

<a id="lt-670"></a>
## LT-670 — the renderer respawn watchdog force-terminates a session that is only waiting out the circuit-breaker backoff

**Status: open, reproduced live 2026-10-04 (dev app on current working tree, HEAD `3d05e250e`,
Claude provider; found by the crash-turn auto-continue campaign, LT-C).**

### Observed behaviour

On the fourth unexpected provider exit of one instance within an hour, the session is destroyed
about 15 seconds later instead of recovering. Reproduced four times on four instances, including a
deterministic run that needs no model turn (idle crashes only):

- Instance `c3c1wkkq5` (idle, four `kill -9` of its own `claude` child, 22:41:10, 22:41:16, 22:41:22,
  22:41:46 UTC): `RespawnCircuitBreaker: Circuit breaker backing off before respawn` `attempt: 3,
  delayMs: 10000` (that recovery succeeded) then `attempt: 4, delayMs: 30000`. The renderer console
  logged `Interrupt recovery timeout: force-terminating stuck instance` at 22:42:07.329, then
  `HistoryManager: Archived instance` / `SupervisorTree: Unregistered instance`. `lifecycle.ndjson`:
  `respawning -> terminated` at 22:42:07.331. `listInstances()` returned `[]`; no replacement
  instance was created.
- Instance `cxjgp3fij` (after the LT-C cap sequence): attempt 4, `delayMs: 30000` at 22:44:23.765;
  `respawning` 22:44:23.764 -> `terminated` 22:44:38.827 (15.06 s); renderer console error at
  22:44:38.824.
- Instance `cy6mjrefx` (earlier run): attempt 4, 30 s delay at 22:28:08.078, terminated 22:28:23.158.

A main-process monkeypatch on `InstanceTerminationCoordinator` (dev app only, in memory) recorded the
caller of the `terminateInstance` at 22:36:51.5 for a fourth instance (`cftjslroy`, 4th crash, 22:36:36 kill): the stack was
`InstanceManager.terminateInstance <- ipc/handlers/instance-handlers.js:222` (the renderer's
`INSTANCE_TERMINATE` IPC), not any main-process component. Evidence:
`_scratch/lt-2026-10-04/a/devapp-run3-ladder.log`, `renderer-console.log`,
`lifecycle-ladder-and-cap.ndjson`.

### Root cause

Two timers disagree. The main process holds an instance in `respawning` for the whole circuit-breaker
backoff (`respawn-circuit-breaker.ts:21` `BACKOFF_SCHEDULE_MS = [0, 0, 10_000, 30_000, 120_000,
300_000, 900_000]`; wait applied at `interrupt-respawn-handler.ts:1126-1141`, which sets
`waitReason {kind: 'backoff', retryAt}` but leaves the status `respawning`). The renderer's
`RespawnWatchdog` (`src/renderer/app/core/state/instance/instance-respawn-watchdog.ts:15`,
`RESPAWN_TIMEOUT_MS = 15_000`) force-terminates any instance whose status stays in
`respawning`/`interrupting`/`cancelling`/`interrupt-escalating` for 15 s
(`isInterruptRecoveryStatus`, `instance-messaging-queue-utils.ts:91-96`) and never looks at
`waitReason`. Every backoff of 30 s or longer (attempts 4 to 7) therefore loses the session. The
follow-up `restartInstance` runs against the instance it just terminated and does nothing useful.
Source reading plus the observed IPC origin and the exact 15 s gap; the renderer console line was
captured live.

### Required behaviour

A session that is legitimately waiting out a circuit-breaker backoff is not terminated. The watchdog
must either skip instances whose `waitReason.kind === 'backoff'` with a future `retryAt`, or measure
its 15 s from the end of the announced backoff. Terminating a recovering session with no notice is
never the outcome of a crash loop; if the breaker is meant to give up, the session should end in an
`error` state with an explicit message.

### Acceptance

- Regression test for the watchdog: a `respawning` instance carrying a `backoff` `waitReason` with a
  30 s `retryAt` is not terminated at 15 s; one without a `waitReason` still is. The first fails
  without the fix.
- Live: four idle `kill -9`s of one dev-app Claude session within an hour leave the session alive
  after the 30 s backoff, with the usual "Session reconnected automatically" notice.
- Re-run [crash-turn auto-continue LT-C](2026-09-28-crash-turn-auto-continue_livetest.md) in full.

<a id="lt-671"></a>
## LT-671 — crash auto-continuation is silently skipped when recovery uses a fresh-session replay

**Status: open, reproduced live 2026-10-04 (dev app on current working tree, Claude provider; found
by the crash-turn auto-continue campaign, LT-A).**

### Observed behaviour

When a provider crash lands before the session has a resumable transcript (here: killing the
`claude` child 7 to 28 seconds into the first long turn), Harness restarts the session ("Session
restarted automatically (resume failed)") and posts "The provider process stopped during this turn.
The work above is kept." but sends no continuation and posts no "Continuing the interrupted turn"
notice. The session just sits `idle`. Five kills across four instances showed it (`c790o4t0r`, `ckazlgmob`
twice, `cftjslroy`, `c1b9g729t`); the same fresh-replay recovery did continue correctly on three other
occasions (`cy6mjrefx` first kill, `cxjgp3fij` attempt 2, `cftjslroy` attempt 2). When the recovery
resumed the real session ("Session reconnected automatically") the continuation fired every time
(`cy6mjrefx`, `cftjslroy`, `cxjgp3fij`), 160 ms after the notice.

With the dispatch owner instrumented in memory (dev app only) for `cftjslroy` at 22:34:27.488:

```
guard-false  status:"idle" rc:1 reqRc:1 parent:null lm:"orchestrated"
  wait:{"kind":"respawning","strategy":"fresh-replay","startedAt":1791153267411}
  attempts:0 endingMatches:true isCurrent:true paused:false loop:false inhib:false
reserve      trigger:"cutoff" ok:false
```

Every other admission condition held; the only one that failed was `waitReason === undefined`.
Evidence: `_scratch/lt-2026-10-04/a/dispatch-debug-1.json`, `dispatch-debug-2.json` (the working
contrast), `devapp-run1.log`, `devapp-run2.log`.

### Root cause

Ordering race in `interrupt-respawn-handler.ts`. In the auto-respawn path
`emitRecoverySafeOutput(instance, message)` posts the `autoRespawn: true` system message first
(lines ~1325-1335); the continuation owner reacts to that message synchronously
(`instance-reasoning-collapse-continuation.ts` `onProviderEvent`, then `observeEnding` -> `reserve`),
while the `waitReason` is cleared afterwards by the batched `queueUpdate(..., null)` call (lines
~1337-1356). The rootOnly guard in `InstanceContinuationDispatch.guard`
(`instance-continuation-dispatch.ts`, `policy.rootOnly && ... instance.waitReason === undefined`)
therefore sees the stale `respawning` wait reason and `reserve()` returns `undefined`, so nothing is
queued, no notice is posted and no warning is logged. Whether the clear lands first depends on batch
timing, which is why some fresh-replay recoveries still work. The trace above is the observed
evidence; the ordering is from reading the code.

### Required behaviour

A turn cut off by a crash is continued whichever way the session was restored. The recovery must
clear the wait reason before announcing the restart to listeners (or the continuation owner must not
treat a stale recovery `waitReason` as a blocker), and a refused reservation for an eligible crash
should leave a log line.

### Acceptance

- Regression test: a crash recovery that falls back to fresh-replay still dispatches exactly one
  continuation with the instance's `waitReason` still set at the moment the `autoRespawn` message is
  observed; it fails without the fix.
- Live: repeat [crash-turn auto-continue LT-A](2026-09-28-crash-turn-auto-continue_livetest.md) with
  the kill inside the first few seconds of a brand-new session's first long turn, five times; every
  run shows "Continuing the interrupted turn automatically (attempt 1 of 2)".

<a id="lt-672"></a>
## LT-672 — a user Stop on a Claude session posts "The provider ended this turn with an error"

**Status: open, reproduced live 2026-10-04 (dev app on current working tree, Claude resident
session; observed during crash-turn LT-B).**

### Observed behaviour

`interruptInstance({instanceId})` on a busy Claude session (instance `ct26bzgb7`, 22:46:31 and
22:47:31 UTC, both times) leaves the session correctly `idle` with no continuation, but the transcript
ends with the system notice "The provider ended this turn with an error. The work and error above
are kept." immediately after "Interrupted — waiting for input". Nothing went wrong; the user pressed
Stop.

### Root cause

Not fully traced. The notice text is the `unknown_error` entry of `TURN_CONTINUATION_POLICY`
(`turn-ending-continuation-policy.ts`), which the classifier returns for `is_error`/`error` metadata
(`turn-ending-classifier.ts:97`) after the cancelled branch (`:59`, native reason `cancelled`,
`canceled` or `interrupted`) did not match, so the Claude interrupt result evidently carries an error
flag without one of those native reasons. The exact result payload was not captured.

### Required behaviour

A turn ended by the user's own Stop is classified as a client cancellation and posts no provider-error
notice.

### Acceptance

- Regression test: the Claude interrupted-turn result shape classifies as `completed /
  client_cancelled`; fails without the fix.
- Live: Stop a busy Claude session; the transcript shows only the interrupt notices.

<a id="lt-673"></a>
## LT-673 — reloading the renderer leaves the session list empty: the first state resync is sent before the IPC auth token exists

**Status: open, reproduced live 2026-10-04 (dev app, renderer on `http://localhost:4567`, three
reloads; found while checking session-title persistence across a refresh). Whether a packaged-app
cold start or window reload hits the same ordering is not established.**

### Observed behaviour

With three live sessions in the main process, `location.reload()` of the dev renderer produced a UI
with zero sessions: `app-instance-row` count 0, `InstanceStore.instances().length === 0`,
`InstanceStore.loading() === true` indefinitely (checked at +20 s), and no visible error
(`error()` stayed `null`). `window.electronAPI.listInstances()` still returned all three sessions, and
a later `stateResync()` call from the same page succeeded instantly. Wrapping the main-process
`state:resync` handler in memory recorded the response to the page's own initial request:

```
22:54:03.417  ok:false  IPC_AUTH_FAILED: Missing or invalid auth token for state:resync
              url: http://localhost:4567/
```

Calling `listStore.loadInitialInstances()` by hand afterwards (what a list refresh does) restored all
three rows. Evidence: `_scratch/lt-2026-10-04/a/resync-auth-failure-trace.json`.

### Root cause

`InstanceListStore.loadInitialInstances()` (`src/renderer/app/core/state/instance/instance-list.store.ts:132`),
called from the `InstanceStore` constructor, sends `state:resync` with `_withAuth()`
(`src/preload/domains/infrastructure.preload.ts:39-41`); the token is only populated when
`appReady()` resolves (`:19-28`), and `AppComponent` calls `appReady()` late in start-up
(`src/renderer/app/app.component.ts:292`, after the capability probe in
`app-handlers.ts:113-125`). The first resync therefore races the token and is refused. In
`loadInitialInstances`, a `success: false` response is neither an exception nor handled: no
`setInstances`, no `setLoading(false)`, no error, no retry.

### Required behaviour

The initial session load waits for the IPC auth token (or retries once it exists) and a failed
response clears `loading` and surfaces an error instead of leaving an empty list.

### Acceptance

- Regression test: `loadInitialInstances` with a first `success: false` response retries after
  `appReady` and populates the list; with a persistent failure it sets `loading=false` and an error.
- Live: with sessions open, reload the dev renderer (or reopen the window) and the list repopulates
  without manual action.

<a id="lt-674"></a>
## LT-674 — the LT-105 errored-turn completion is dropped by the instance layer, so no cost, ledger capture or hook is recorded

**Status: open, reproduced live 2026-10-04 on a staged legacy `type: error` event (dev app, current
working tree, resident Claude session; found by the outstanding-plans sweep check 3). Priority
reflects that current Claude CLIs end failed turns with a `result`, not the legacy event.**

### Observed behaviour

Two real resident Claude sessions (`cbos4ffz5`, `c4o31xtjs`), mid essay turn (status `busy`), had the
legacy stream error delivered to the real adapter with the real `instance-communication` handlers
attached (`ClaudeCliAdapter.processCliMessage({type: 'error', error: {...}})` called through the
dev app's main-process inspector, which is exactly how the unit tests stage it):

- Adapter level: a listener on the adapter saw `error` then exactly one `complete` with
  `{"turnErrored": true}` 0 ms later (22:58:35.092). The adapter half of the fix works.
- Instance level: `InstanceCommunication: Instance error`, then `Force cleaning up adapter`; the
  instance went to `error`. No `adapter-event:complete` row was captured: ledger
  `provider_event_captures` for `cbos4ffz5` holds `adapter-event:spawned` x2, `status` x1, `error` x1
  and three `instance-output` rows, and no `complete`. With `recordCompletionCost`,
  `recordEstimationTelemetry` and `forceCleanupAdapter` wrapped in memory for `c4o31xtjs`
  (23:00:16.283 injection), only `forceCleanupAdapter` ran (23:00:16.286); neither cost nor telemetry
  nor the rest of the completion block ran in the following 8 s. The turn's partial usage, the
  `PostSampling`/`Stop` hooks and the handoff-state note are therefore not recorded, which is what
  LT-105 set out to fix.
Evidence: `_scratch/lt-2026-10-04/a/lt105-adapter-events.json`, `lt105-ledger-captures.txt`,
`lt105-comm-trace.json`.

### Root cause

Not instrumented to the line. The `complete` listener (`instance-communication.ts` ~1652) bails out
through `isStaleAdapterEvent('complete')` (`:1012-1039`: the adapter is no longer the instance's
current adapter, or the epoch/generation changed) before the cost block (`:1700-1730`). The `error`
listener (`:1817`) runs first and calls `forceCleanupAdapter` (`:2369-2382`), which terminates and
deletes the adapter; the completion handler is `async` and awaits `drainContextEvidence` before its
second stale check, so the adapter is gone by the time it resumes. Reading plus the trace; which of
the two stale checks fired was not captured.

### Required behaviour

An errored resident turn's completion is recorded (capture, cost, hooks) before the instance
abandons the adapter, or the error path records it itself; the completion must not depend on the
adapter outliving the error handler.

### Acceptance

- Regression test through the real `InstanceCommunicationManager`: adapter emits `error` then
  `complete {turnErrored: true}`; assert one `adapter-event:complete` capture, one cost recording and a
  `Stop` hook with `stopReason: 'error'`; it fails without the fix.
- Live: repeat the staged injection from the sweep doc's check 3; the ledger shows exactly one
  `adapter-event:complete` with `turnErrored: true` after the `error`.

## LT-680 — a message joined into a running Codex goal turn loses its reply and the session reads idle

**Status: open, reproduced live three times on 2026-10-04 (dev app, current working tree, codex-cli
0.160.0, found by the compaction-reliability live test check 4). Priority P2: the user's message is
accepted and answered by Codex, but the answer is invisible and the session looks finished.**

### Observed behaviour

Setup: a Codex session, goal created with `create_goal` ("write a 200 word paragraph about a different
animal in each of eight separate turns, one paragraph per turn"), so Codex starts a continuation turn by
itself after every turn. While a goal turn was running, a plain `electronAPI.sendInput` was issued (the
path the composer takes for a message sent during a busy turn).

| Run | Instance | Send | Codex applied the steer | Harness `busy -> idle` | Codex `task_complete` | Reply in rollout | Reply in transcript |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `xtbdycjw7` | 22:48:00.354 | 22:48:02.02 (rollout user item) | 22:48:02.126 | 22:48:16.036 | "JOINED The snow leopard..." 22:48:15.9 | absent |
| 2 | `xvn0lylwn` | 22:53:19.959 | 22:53:20.200 | 22:53:20.258 | 22:53:42.634 | "MERGED with the wind, the peregrine falcon..." 22:53:42.5 | absent |
| 3 | `xj2fw7nx0` | 22:59:23 (6 s into the turn) | 22:59:40.177 | 22:59:40.271 | 23:00:02.417 | "MIDJOIN the peregrine falcon..." 23:00:02.3 | absent |

In run 3 the instance was `idle` in Harness's own lifecycle log for 22 s (22:59:40.271 to 23:00:02.4)
while Codex was still working on the same turn, and the outputBuffer (renderer and main-process
`listInstances`) ends at the pre-steer paragraph (9 entries; no "MIDJOIN"). The send IPC resolved at
22:59:40.28, so the sender was told it succeeded. A later goal turn then started and Harness went `busy`
again. In run 1 the earlier `steerInput` path (interrupt then resend) was not affected: its reply
("STEERED The African savanna elephant...") is in the transcript.

Evidence: `_scratch/lt-2026-10-04/b/xj2fw7nx0-transcript.json`, `join-mid3-rollout.txt`,
`lifecycle-xj2fw7nx0.ndjson`, `xj2fw7nx0-applog-full.txt`, `goal4-rollout-summary.txt`,
`goal4-transcript-assistant.json`, `join-mid-run3.txt`.

### Root cause

Established from the timestamps and code reading; the timer firing was not separately instrumented.
Codex's `turn/steer` input is taken at the next sampling boundary. A goal turn that answers with one
tool-less message has its `final_answer` item complete first, and the steered user item is recorded
only after it (22:59:40.018 final answer, 22:59:40.177 user item). Harness's capture treats that
`final_answer` as the end of the turn: `codex-notification-item-events.ts:277` sets `finalAnswerSeen` and
calls `scheduleInferredCompletion`, which calls `completeTurn(state, null)` after
`INFERRED_COMPLETION_MS = 250` (`codex-app-server-notification-adapter.ts:26,520-544`). That fired at
`22:59:40.27` (final answer + 250 ms, matching the `busy -> idle` edge). Neither `steerProviderTurn`
(`app-server-thread-runtime.ts:237-266`) nor anything in `joinProviderTurn`
(`codex-app-server-turn-adapter.ts:252-262`, `if (delivered) await done`) cancels or extends that timer
after a steer is accepted, so `done` resolves, the capture is closed, and everything Codex streams
afterwards in the same turn goes to `handleIdleAppServerNotification`, which keeps only usage and
compaction events (`codex-app-server-turn-adapter.ts:100-104`).

### Required behaviour

A steer accepted into a Codex-started turn must keep that turn's capture open until Codex reports the
turn complete: cancel the pending inferred completion when `turn/steer` succeeds (or ignore inferred
completion for a turn that has accepted steered input), and publish every item of the turn. Status must
stay `busy` until the real `turn/completed`.

### Acceptance

- Regression test at the adapter level: a provider-started turn emits a `final_answer` item, then a
  steer is accepted before the 250 ms timer, then more agent-message items and `turn/completed`; assert
  the later message is emitted as output, status never goes `idle` before `turn/completed`, and
  `joinProviderTurn` resolves only after it. It fails without the fix.
- Live: repeat run 3 above (goal turn, plain send 6 s in); the rollout reply appears in the transcript
  and the lifecycle log has no `busy -> idle` between the steer and `task_complete`.

## LT-681 — Compact now on a Codex session shows a fabricated ~0% occupancy

**Status: open, reproduced live 2026-10-04 (dev app, current working tree, codex-cli 0.160.0, found by
the compaction turn-visibility live test check 3). The provider self-compaction path is correct; this
is the Harness-initiated (manual) path.**

### Observed behaviour

On Codex sessions `x1zvkexgy` (15.1% before) and `xyynqndg6` (33% before) `compactInstance` completed
successfully and the header context meter read `~0/258,400 (~0%)` (the estimated flag set) from the
boundary onward: for about 3 s until a queued message's turn reported usage, and, with nothing queued
(`xyynqndg6`), for the whole 40+ s observed with the session idle. The transcript boundary row read
"Context compacted [native] (33% → 0%)". Codex's real figure after the same kind of compaction was 13%
(`x1zvkexgy`, first real usage event after the compaction: 34,028 tokens) and 27-28% (`x13dt4qqx` and
`xyynqndg6` inline self-compactions: 68,690 then 73,586 tokens). For contrast the self-managed path
showed `~27%` (estimated) then `28%`, and the row "Codex compacted its own context (95% → 27%)".
Evidence: `_scratch/lt-2026-10-04/b/c1b-timeline.txt`, `c3manual-timeline.txt`,
`selfcompact-timeline.txt`, `selfcompact-outbuf.json`.

### Root cause

`compaction-runtime.ts:512-514` builds the post-compaction usage with `buildPostCompactionUsage`
(`:96-125`), which sets `used: 0`, `percentage: 0`, `isEstimated: true` for every provider whenever the
coordinator returns no `newUsage`. The Codex Compact turn does not report a new occupancy, so the reset
is presented as a measurement. The turn-visibility plan's LT-655 required "last non-zero occupancy as
estimated, or an explicit awaiting-usage state, never a fabricated 0%"; that was implemented for the
self-managed boundary only.

### Required behaviour

After a Harness-initiated compaction of a provider that does not return a fresh occupancy, the meter
shows the last real reading as estimated or an explicit "awaiting updated usage" state, and the boundary
row does not print a 0% figure that was not measured.

### Acceptance

- Unit test over the compaction-completed handler: a Codex compaction with no `newUsage` yields a
  context usage whose `percentage` is not 0 (or an explicit unknown state) and a boundary row without
  "→ 0%"; it fails without the fix.
- Live: Compact now on an idle Codex session at 30%; the meter never shows ~0% and the boundary row has
  no 0%.

## LT-682 — the interrupt button says "Interrupt Claude" on every provider

[Read the detail](livetest-remediation-register-archive-2026.md#lt-682-archived-detail).

### Observed behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-682-archived-detail).

### Root cause

[Read the detail](livetest-remediation-register-archive-2026.md#lt-682-archived-detail).

### Required behaviour

[Read the detail](livetest-remediation-register-archive-2026.md#lt-682-archived-detail).

### Acceptance

[Read the detail](livetest-remediation-register-archive-2026.md#lt-682-archived-detail).

<a id="lt-675"></a>
## LT-675 — a signed-out Claude CLI's "Not logged in" banner is accepted as the session's AI title

**Status: open, reproduced live 2026-10-04 (dev app, current working tree; found while running the
LT-441 and AR-002 checks).**

### Observed behaviour

With the dev app started with `CLAUDE_CONFIG_DIR` pointing at an empty, signed-out directory, every
new session (Codex parent `x8kv260xr`, Codex children `x0witk75z`, `x65vll8wf`, and a fourth,
`x26djqzkp`) logged `AutoTitle: Auto-titled instance (AI) ... title: 'Not logged in · Please run
/login'` (23:05:05, 23:06:54, 23:06:55, 23:07:51 UTC), and the rail and header showed that string as
the session name. The title came from the title escalation's Claude (`haiku`) one-shot CLI, which
printed its sign-in banner instead of a title; nothing rejected it. Log:
`_scratch/lt-2026-10-04/a/devapp-run5-check8.log` lines 1252, 1567, 1598, 1920.

### Root cause

Not traced to the line. The title service filters provider rate-limit/notice text
(`src/main/cli/provider-notice.ts`, used by `auto-title-service.ts`) and, since the 2026-09-30 repair,
numbers, narration and generic states, but a CLI authentication banner is none of those, so it passes
as a short noun phrase. The ordinary one-shot health/auth detection (`claude-cli-auth.ts:103`) is not
consulted on this path.

### Required behaviour

CLI sign-in or authentication-failure output is never accepted as a title. Treat it as a failed provider
response (move to the next permitted provider, keep the meaningful instant title).

### Acceptance

- Regression tests: a one-shot answer of `Not logged in · Please run /login` (and the Codex equivalent)
  is rejected by the title service and the next provider is tried; fails without the fix.
- Live: with a signed-out Claude CLI home, a new session keeps its instant title.

## LT-683 — a Codex goal turn that starts within milliseconds of the previous one is not followed

**Status: open, seen once on 2026-10-04 (dev app, current working tree, codex-cli 0.160.0; found by the
compaction-reliability live test check 1). Intermittent; the cause is not established. Priority P3
until a second occurrence or a root cause says otherwise.**

### Observed behaviour

Instance `xyynqndg6`, thread `01a10925-fa7b-7841-895f-8a6b6b142725`, goal active, no messages being sent.
Goal turn `01a10928-cc70` completed at 23:04:13.027 and Codex started goal turn `01a10929-21e4` at
23:04:13.034 (7 ms later; the usual gap that run was 12-24 ms). The adapter logged "Following a turn Codex
started by itself" for the turns before and after it but not for `21e4`. The lifecycle log shows
`busy -> idle` at 23:04:13.086 and no `busy` again until 23:04:32.638, when the following goal turn
`6e70` was picked up: 19.5 s in which Codex was running a turn and Harness reported the session idle.
The transcript of that instance was not saved before it was terminated, so the loss of that turn's output
is inferred from the code (an unfollowed turn's notifications go to `handleIdleAppServerNotification`,
which keeps only usage and compaction), not observed.

Audit of all goal threads of the day (`_scratch/lt-2026-10-04/b/follow-audit.js`,
`follow-audit-final.txt`): 39 goal turns, 36 followed. The other two unfollowed turns
(`01a10921-bbb8`, `01a10923-4f78`) were in runs where messages were being sent into the goal turn
(LT-680), so they may share that cause. A clean 14-turn run (`01a10933-e358`, instance `x0av4cy36`)
followed 13 of 13, and all its replies were in the transcript.

### Root cause

Not established. A candidate by reading: `followProviderTurn` returns early while
`appServerRuntime.hasActiveTurn()` is still true (`codex-app-server-turn-adapter.ts:~184-190`) and
`captureProviderTurn` returns null while `this.activeTurn` is set
(`app-server-thread-runtime.ts:376-390`), so a `turn/started` that arrives before the previous capture
has been torn down is dropped with no retry.

### Required behaviour

Every Codex-started turn on the root thread is followed, including one that starts before the previous
turn's capture has finished tearing down; status stays `busy` throughout.

### Acceptance

- Unit test: two provider `turn/started` notifications 5 ms apart, the second arriving while the first
  capture is still resolving; assert both are captured and status never goes `idle` between them.
- Live: a 14-turn goal run repeated several times shows no `Following` gap and no `idle` span between goal
  turns longer than the turn gap.

<a id="lt-708"></a>

## LT-708 — warm Claude sessions lose the actionable permission request

### Observed behavior

2026-10-27, rebuilt dev app from `80412201a07ec93cefb9a4b6ddb06579ad314d75`, isolated profile
`/tmp/aio-lt-queue-3af326de`, Electron 42.11.18 and Claude Code 2.1.310. In a disposable workspace,
fresh non-YOLO session `c214qtk5p` requested the harmless `rtk proxy pwd` command. At
03:02:39.114 UTC the real CLI deferred it; the renderer showed a `deferred_permission` card,
duration label, three choices and tooltip. No permission decision or settings rule was submitted.

At 03:05:46.663 UTC passive main-inspector observation showed the matching spare Claude adapter
had `permissionHookPath` absent. The next otherwise equivalent session `cbmfl0p2y` consumed that
warm adapter (application log 03:05:48.476–477 UTC). Its real stdout at 03:05:57.891 UTC contained
a `user` message with `tool_result { is_error: true, content: "This command requires approval" }`.
At 03:06:03.168 UTC it ended with `stop_reason: "end_turn"`, without `deferred_tool_use`.
The denial classifier returned false for that exact provider text. The session became idle and
the selected session's permission component had no pending card. The assistant said approval was
needed, but supplied no actionable approval surface. An earlier warm session `c2px3fafl` showed
the same outcome; the second run captured the raw provider shape. No explicit deny rule was added
and no provider output was fabricated or replaced.

Evidence: the owning [2026-10-27 run](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-27-plan-queue-worker)
and its linked command/runtime receipts. Implementation status:
[active follow-up](2026-10-27-agent-runtime-permission-remediation_plan.md), untracked in the root checkout.

### Root cause

The `WarmStartManager` composition in `src/main/instance/instance-manager.ts:267` constructs
adapters with working directory and reasoning effort only. It does not supply the non-YOLO
permission hook prepared by `src/main/instance/lifecycle/spawn-config-builder.ts:631`.
`InstanceSpawnPreflightChain.prepare` at `instance-spawn-preflight-chain.ts:82` does not compare
the requested permission hook with a warm adapter; at line 116 it returns the already-running
adapter without applying those spawn options. Live inspection confirmed the omitted hook on the
actual adapter used by the failing session.

Independently, `isPermissionDenialContent` in
`src/main/cli/adapters/claude-cli-permission-details.ts:21` recognises “requires permission” but
not the CLI's current “requires approval”. The real `tool_result` path in
`claude-cli-adapter.ts:1342` therefore never emits `permission_denial` for this response. These
two executing paths explain why neither supported permission flow reaches the renderer.

### Required behavior

1. A reused non-YOLO Claude adapter must preserve the same actionable permission contract as a
   fresh adapter, or be rejected for reuse when its launch configuration cannot do so.
2. Genuine current CLI approval-denial text must be recognised without converting a command's
   own permission-related output into an override prompt.
3. Respect explicit deny rules; never add an allow rule, restart the session or broaden authority
   without the corresponding user decision.

### Acceptance

- Pin cold and warm non-YOLO creation with the same harmless command: each either pauses with an
  actionable request or refuses an incompatible warm adapter before adoption.
- Cover the genuine `This command requires approval` tool-result shape, retaining negative cases
  for executed-command error output and the existing explicit-deny protections.
- Repeat AR-006 permission wording on the rebuilt runtime, including duration choices, tooltip,
  rejection cleanup and the legitimate legacy-rule consequence if that request is emitted.
- Run focused regressions, the canonical gates and independent completion review. Existing
  focused tests passed during discovery; they do not prove this defect fixed. No fix was made.


<a id="lt-728"></a>

## LT-728 — active Claude fresh-eyes review expires as an unexplained cancellation

Renumbered from LT-710 on 2026-11-07. Main's register uses LT-710 for the fresh-profile migration race, so the agent-runtime reviewer-deadline defect keeps its own identifier here.

### Observed behavior

The original AR-006 run on 2026-10-27 recorded two overlapping attempts ending at +120 seconds
with `claude: Review cancelled`. It did not establish a provider outage and should not have called
this merely an unavailable prerequisite. See the historical receipts in the owning live-test file.

A separate, non-overlapping diagnostic against the rebuilt queue checkout at
`44d247209` reproduced the failure from **03:26:22.626 to 03:28:22.629 UTC**. The real
`CrossModelReviewService.runHeadlessReview` used the installed `ProviderReviewExecutionHost`,
a Codex implementer, the Claude `sonnet` correctness checker, structured output, and an explicitly
recorded **120-second** request budget. No provider, host, result, verdict or deadline was replaced.
The no-op review request asked for no repository survey and no edits. Claude emitted thinking,
Read/Grep/ToolSearch activity but no result or structured verdict before the deadline. Thinking
continued until **03:28:21.751 UTC**; the deadline settled at +120.004 s and the owned CLI closed
10 ms later. The only required reviewer was failed, the local advisory was skipped, and no clean
verdict/cache was produced. This is an active-review deadline failure; no provider outage was
established. It is not a reproduction of LT-702's already-produced-verdict stall: this trace has
no result event at all.

Evidence: [verifier follow-up](2026-09-27-livetest-agent-runtime-residuals_livetest.md#evidence-run--2026-10-27-verifier-follow-up),
with content-redacted wire shapes, exact dispatch request, receipts and source seal in
`2026-09-27-livetest-agent-runtime-residuals_evidence/2026-10-27-resume/`.
Implementation status: [active review follow-up](2026-10-27-agent-runtime-review-remediation_plan.md)
(untracked in the root checkout).

### Root cause and limits of the diagnosis

The loop's default reviewer forwards `input.config.timeoutSeconds` to the headless request
(`loop-fresh-eyes-reviewer.ts`, `defaultFreshEyesReviewer`). The executing service delegates to
`runHeadlessReviewCommand` (`cross-model-review-service.ts:685`). That runner creates an operation
controller and installs `setTimeout(() => abort.abort(), timeoutMs)` from the request budget
(`headless-review-runner.ts:54`, `:80`). The host passes this signal to
`sendAbortableReviewerMessage`, which stops the adapter and rejects **every** abort as
`Review cancelled` (`review-execution-host.ts:147-153`). The runner preserves that generic text as
the failed reviewer's reason (`headless-review-runner.ts:192-206`). Therefore an elapsed deadline
is indistinguishable from caller cancellation in the returned failure. The actual startup wiring
installs this host at `late-runtime-initialization-steps.ts:435-438`; the live adapter and wire
shape confirm it executed.

`CrossModelReviewService.executeOneReview` and its ordinary-review provider timeout floors are a
separate path, never called by this headless operation. They cannot explain or prevent this timer.
The previous run did not retain its configured timeout value; its exact +120 s result is consistent
with this path, while this new request records the value explicitly. The current loop config's
factory default is 90 s, the headless fallback is 60 s, and the ordinary-review fallback is 30 s;
none should be silently substituted for the observed effective request budget.

The immediate cancellation cause and misleading classification are proven. The reason this no-op
review consumed the entire budget without a verdict is **not fully established**. The retained
shape trace proves continued thinking and read-tool activity, not what each read meant or a remote
service outage. Do not claim a transport hang, provider outage, or a fixed-by-longer-timeout result.
The review adapter also has existing read-only, eight-turn and $1 caps; do not remove those merely
to make a live check pass.

### Required behavior

- Preserve deadline expiry versus actual caller cancellation in the review result and gate event,
  with the effective budget visible in diagnostics. A failed reviewer must never become a clean pass.
- Investigate the no-op checker's unnecessary work under the actual instructions/model, and obtain
  a real bounded verdict before declaring the cache prerequisite available. Do not fabricate an
  approval, skip a required reviewer, or apply an unexplained timeout increase.

### Acceptance

- Focused tests distinguish internal timeout from upstream cancel, retain adapter cleanup and
  failure-not-clean behavior, and cover the actual headless path rather than only ordinary reviews.
- On a rebuilt app, a genuine required reviewer returns a parsed clean verdict for the no-op fixture;
  then unchanged-tree reuse and both external-edit/pause-resume invalidations pass AR-006 live.
- Run the canonical gates and independent review for the eventual implementation. This discovery
  run changes documentation/evidence only and claims no product fix.

## LT-700 — Plan Queue restart recovery spawns a verifier before the orchestrator-tools socket exists

### Observed behaviour

2026-10-04, dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-1004-d`, HEAD `3d05e250e` working tree), batch D, plan-queue livetest check 3.
Run `a3799290-152b-4424-b39b-9b5355618cd4` (`relax_settings: true`, two plans) was gracefully stopped while item `rone` was `verifying` and `rtwo` `awaiting-slot`, then the app was relaunched. Timeline from the shared `app.log` (copied to `_scratch/lt-2026-10-04/d/pq-applog-slice-all.ndjson` and `lt700-verifier-spawn-lines.ndjson`):

- `1791156565213` `PlanQueueCoordinator initialized`; relaxed settings restored then re-applied (correct).
- `1791156570969` `PlanQueueVerifierSelect: Plan queue verifier selected` (codex).
- `1791156571158/162` `SpawnConfigBuilder` warns for the new verifier `xxo781iov`: `Codemem MCP not configured — aio-mcp SEA binary or codemem RPC socket missing` and `Orchestrator-tools MCP not configured — aio-mcp SEA binary or orchestrator-tools RPC socket missing`.
- `1791156578379` `OrchestratorToolsRpcServer: Orchestrator-tools RPC server listening` (7.2 s after the spawn).
- The verifier ran about 5 minutes (archived `1791156884007`), the item went `parked`, `parkReason: verifier-unreliable`, detail `the verifier ended its turn without reporting a verdict`.
- The other item's verifier, spawned at `1791157052978` after the socket existed, had no such warning and reported normally (round 1 changes requested, then landed in round 2).

Across the whole session `xxo781iov` was the only instance of mine with the "Orchestrator-tools MCP not configured" warning.

### Root cause

Initialisation order. `late-runtime-initialization-steps.ts:189` initialises the `Plan queue coordinator` (`initializePlanQueue`), whose recovery immediately re-launches workers and verifiers. `createOrchestratorToolsStep(...)` (the step that starts the orchestrator-tools RPC server and makes the MCP config available to spawns) is later in the same list (`:537`), after `Loop invokers`, `Plugin manager`, `Cross-model review` and others. A session spawned in that gap is built without the orchestrator tools. The verifier's only way to deliver its result is `plan_queue_report_verdict`.

### Required behaviour

A verifier (or any recovered Plan Queue session that depends on orchestrator tools) is never spawned until the orchestrator-tools RPC server is listening. Either move the Plan Queue step after the orchestrator-tools step, or make recovery wait for the RPC server.

### Acceptance

- Unit/integration test: with the RPC server not yet started, `PlanQueueCoordinator.initialize()` recovery of a `verifying` item defers the verifier spawn until the server reports listening; the spawn config for the recovered verifier includes the orchestrator-tools MCP.
- Live: repeat Plan Queue check 3 (quit while an item is `verifying`, relaunch). The fresh verifier calls `plan_queue_report_verdict` and the item reaches `landed` or an ordinary verdict, never `verifier-unreliable` for "ended its turn without reporting a verdict".

## LT-701 — a normal quit mid-run parks every working Plan Queue item and ends the run

### Observed behaviour

2026-10-04, dev app, batch D, plan-queue livetest check 3 ("quit Harness normally and start it again").
Run `0be3b82e-ac3f-4617-a60b-0f31eea22227` (plans `rthree`, `rfour`, `workerSlots: 2`) had both items `working` with busy worker sessions (`pq-restart2-pre.txt`). The dev app was stopped with SIGTERM at `1791157967`; the shutdown ran its normal phases (`terminate-instances`, `cleanup-registry`) and logged `Cleanup complete {incompletePhaseCount: 0}`. Inside that shutdown, at `1791157967969`, the log has `PlanQueueCoordinator: Plan queue run ended {status: completed}`. After relaunch (`1791157979227`) both items were `parked`, `parkReason: worker-error`, detail `instance entered terminated`, the worktrees removed, the branches kept (`queue/2026-09-18-rthree-8ce06f`, `queue/2026-09-18-rfour-538cc9`), the run `completed`, and nothing was resumed. No recovery log lines appeared because there was nothing left to recover.

The same quit with a `verifying` item and an `awaiting-slot` item (restart 1 in the same run of the livetest, see LT-700) left the items in their states and recovery did run, so only mid-turn workers are affected.

Manual recovery works: `planQueueControl({action:'resume-item'})` on `rthree` re-queued it, a new worker started on its branch, and it landed.

### Root cause

`plan-queue-instance-tracker.ts` `applyStatus` treats any `AUTOMATION_FAILURE_STATUSES` status as a failure (`this.fail(instanceId, 'instance entered <status>')`, `:167`). The app's own shutdown terminates every instance, so each mid-turn worker reports `terminated`, which the tracker reports as a worker error, and the coordinator parks the item and finishes the run. `PlanQueueCoordinator.shutdown()` (`plan-queue-coordinator.ts:170-173`) only clears its timer; there is no "app is quitting" guard on the tracker or the park path. The restart-recovery code (`plan-queue-recovery.ts`) is meant for items still `working` in the database, which the shutdown has already removed.

### Required behaviour

Instance terminations caused by the app shutting down are not worker failures. A run interrupted by a normal quit keeps its `working`/`verifying` items so recovery can resume them on the same branch after the next start (the check's expected outcome), or, if the design is to park on quit, the doc and panel say so and the run does not report `completed`.

### Acceptance

- Unit test: with the tracker told the app is shutting down, an instance entering `terminated` does not call `fail` and the item stays `working`.
- Live: repeat Plan Queue check 3 with two workers mid-turn. After relaunch the items are `working`, each with a new worker whose first message says it is resuming because the app restarted, on the same `queue/…` branch, and the run completes.

## LT-702 — a ping-pong round can hang with a finished, valid reviewer verdict (LT-643's symptom again)

### Observed behaviour

2026-10-04, dev app, batch D, ping-pong livetest. Loop `loop-1791159168709-68f35d3a` (Claude builder, Codex reviewer, `pp5`), the fifth of six ping-pong loops run that day. The reviewer instance `xgu30ef14` was created at `1791159191830`. Its output buffer holds a complete assistant message at `1791159237754` (about 46 s after spawn) containing a valid JSON verdict (`CHANGES_REQUESTED`, one finding). The instance is `idle`, `activeTurnId`, `interruptRequestId` and `interruptPhase` all undefined (`pp5-reviewer-instance.json`). Yet the loop's `pingPong.inFlightRound` stayed `1`, `roundCount` `0`, with no `Ping-pong reviewer produced a verdict` line, for 757 s (observed at `1791159889`, still hung). The reviewer instance was never torn down.

At `1791159948531` I cancelled the loop. `1791159948865` (+334 ms): `AgenticPingPongReviewer: Ping-pong reviewer produced a verdict {round: 1, verdict: CHANGES_REQUESTED, findings: 1}`. So the wait was alive the whole time, the instance had been settled the whole time, and the output parsed. Only the wake-up was lost. Slices: `pp5-reviewer-applog.txt`, `pp5-applog-slice.ndjson`, `pp5-hang-state.json`.

Five other loops that day (`loop-1791154975053-70b704c6`, `…155574133-168fa5ef`, `…155691653-291e6bdf`, `…155798529-ae68f97d`, `…159990332-a5233c6f`) completed every reviewer round in 50–100 s with no hang. The earlier hang (LT-643, `loop-1790213435794-57df2268`) had the same shape.

Note on the timeout: the effective reviewer budget is `pingPong.reviewerTimeoutSeconds` (default 900 s, `clampPingPongReviewerTimeoutSeconds`, `loop-pingpong-completion.ts:348`), not `crossModelReview.timeoutSeconds` (600 in these runs), so the 900 s timeout had not yet fired when I cancelled at 757 s. The earlier "600 s timeout never fired" statements in this doc were measured against the wrong setting. The stall is still wrong: a settled reviewer should be noticed within seconds.

### Root cause

Not established; a candidate by reading. `InstanceSettledTracker.waitForSettled` (`instance-settled-tracker.ts:104-228`) checks the settled predicate once on entry and afterwards only on an `instance:settled` event; its 1 s interval only checks cancellation and progress. `maybeEmit` (`:58-95`) de-duplicates by `status:outputId:timestamp:bufferLength` (`settledLastEmittedKey`), so if the one event for the final state is emitted at a moment when the waiter's own predicate (which also applies `afterTimestamp`) is false, no further event is ever emitted for that state and the waiter never re-evaluates. Cancellation works because the interval's `isCancelled()` path calls `finish(getInstance(...))` unconditionally. Not verified live (no tracker instrumentation was available).

### Required behaviour

A settled reviewer is noticed within seconds, independently of whether the single `instance:settled` event was delivered at the right moment: the wait re-evaluates the predicate on its interval (or `maybeEmit`'s de-duplication is cleared when a waiter attaches).

### Acceptance

- Unit test: emit the settled event while the waiter's predicate is false, then make the predicate true without another event; `waitForSettled` resolves within its progress interval.
- Live: at least 10 consecutive real ping-pong rounds (Claude builder, Codex reviewer) each log `Ping-pong reviewer produced a verdict` within 120 s of reviewer spawn.

<a id="lt-703"></a>

## LT-703 — `fill_credential` cannot reach a login form embedded in a cross-origin subframe, and reports the refusal as a selector miss

**Status: fixed + regression-tested 2026-10-10 (working tree). Live re-check 2026-10-11 did not pass.**
The coordinator reason plumbing is live. The extension write still failed, the fields stayed empty,
and the form was not submitted. One fill attempt was used; do not retry until the extension on
`windows-pc` is confirmed to emit the origin-bound codes and James approves another attempt.
Origin: [Browser Gateway credential login — embedded cross-origin login form](browser-gateway-credential-login_livetest.md#lt-703-embedded-cross-origin-login-form) (2026-10-09 LCN sign-in attempt; 2026-10-11 re-check below).

### Observed behaviour

2026-10-09 21:50–22:25 BST, `windows-pc` shared tab `771575145` (`existing-tab:n.bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be:771574393:771575145`), page `https://www.lcn.com/login`. `browser.request_credential_access` for the saved login "LCN - CAUK email hosting account" (vault item `0f10ee9c-f4de-40e5-9244-b4de0154b59a`) was approved: authorization `eab250d6-8620-4e85-bdab-4bfe5e1bc383` with `allowedOrigins: [{scheme: https, hostPattern: www.lcn.com, includeSubdomains: false}]`, vault binding `https://www.lcn.com` (`browser_vault_item_bindings`), item moved into `AIO-Agent`. `browser.fill_credential {fields: [#username/username, #password/password]}` was then denied **twice** with `reason: credential_fill_failed`, `summary: failed after filling 0 field(s)` (audit ids `016274cd-8413-4a34-a721-a7ea3e349f01`, `d956ef59-94fe-4dd7-a637-0e25aac3dab4`). `app.log` and `traces.ndjson` had nothing explaining the failure.

The per-target write journal is decisive (redaction-safe by design — selectors, counts and rounded value lengths only):
`~/Library/Application Support/harness/browser-write-journal/existing-tab-n.bb62e3ee-…-771574393-771575145-existing-1392813ba27e362aacebf661.json`

- `type #username` (`approxValueLength: 24` — the 22-char username) → `outcome: failed`, `reason: credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state`, `persistence: unverified`. The intent entry proves the vault resolve **succeeded** and the dispatch was reached; `persistence: unverified` + that exact reason prove the failure came from inside the extension `type` command itself (not the post-write persistence sentinel, not a channel/not-delivered/timeout error).
- `click "div:nth-of-type(2) > button:nth-of-type(1)"` (the cookie-consent dialog) → **succeeded**, same tab and channel, between the two attempts.
- `type #username` again → identical failure.

Read-only probes of the live page afterwards (`browser.query_elements`, `browser.accessibility_snapshot`) show `#username` (text) and `#password` (password) exist, match exactly once, and are still empty — and that the tab holds **two documents**: the top-level `Login - LCN` (`#wrap`, header/footer, inline script doing `document.getElementById('login-iframe')` + a `postMessage` auth bridge) and `Control Panel Login - LCN` holding `Account Login` / `Username*` / `Password*` / `Log in`. The form document's own links resolve to `https://login.lcn.com/…` (e.g. "Forgotten password?" → `https://login.lcn.com/password-reset/create/srcUrl/d3d3Lmxjbi5jb20vbG9naW4%3D`, whose `srcUrl` decodes to `www.lcn.com/login`), so the form is served by **`https://login.lcn.com`** and embedded cross-origin through `#login-iframe`. It is same-site (`lcn.com`) with the page, which is why `query_elements` and the a11y tree can still see it while an origin-exact write cannot.

### Root cause

`runOriginBoundType` (`resources/browser-extension/background.js:3326-3332`) builds `authorizedFrameIds` from frames whose `location.origin` equals the authorized origin (`https://www.lcn.com`) and injects the write only into those frames (`:3343-3348`), and it additionally required the **top-level** frame to be authorized (`:3330`, `credential_top_level_origin_not_authorized`). The fields live in the `login.lcn.com` frame, so the write was injected only into the top-level document, where `#username` does not exist; `mergeFrameResults` then threw `No element matches selector: #username` (`background.js:3574`) — a factually wrong diagnosis (the element exists, in another origin's frame).

That error was then swallowed twice:

1. `browserCommandErrorMessage` (`background.js:1469-1479`) replaced EVERY credential-`type` error with `credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state` — deliberate, because DOM/Chrome errors may quote their arguments (i.e. the value being written), but it discarded which check refused.
2. `credentialFailureReason` (`src/main/browser-gateway/browser-form-fill-operations.ts:574-576`) replaced every non-`CredentialVaultError` with `credential_fill_failed`, and the summary carried only a field count.

`fillCredentialOperation` also keyed the authorization check, the vault origin binding (the anti-phishing lock), and the write on the **top-level page** origin, so even a correctly-scoped credential could never reach a form served from another origin. Separately, `browser_audit_entries` had no `reason` column at all, so a failure's reason code could never reach the audit row. (LT-665/LT-666 reached the same `credential_fill_failed` symptom from different causes — an unreadable page and page-specific login markers.)

### Required behaviour

- A credential is typed only into frames of the origin that **receives** it, and `fill_credential` resolves that origin from the field's own frame **before any secret exists in the process**: the authorization, the vault binding, the anti-phishing check and the write all key on it (the "bind the exact origin you log in to" model of `normaliseBindableOrigin`). The top-level page origin is what the navigation re-check watches. Fields whose controls sit in frames of different origins are refused (`credential_fields_span_multiple_origins`).
- Every credential-write failure names its step and cause as a safe reason code in the tool result **and** the audit row: `<step>:<code>` on the exception path (e.g. `dispatch:credential_selector_outside_authorized_origin`, `vault_resolve:origin_mismatch`, `write_confirmation:shared_tab_secure_credential_write_not_confirmed`), and a self-naming step-specific code on the pre-dispatch denial paths (`no_fields`, `shared_tab_secure_credential_fill_unavailable`, `origin_changed_during_fill`, `credential_authorization_changed`, …). The code vocabulary is a fixed allowlist (cross-checked between the extension and main-process copies) plus the closed `CredentialVaultError` code union, exhaustiveness-pinned against `CredentialVaultErrorCode` at compile time in `browser-credential-vault-codes.ts` — a message merely *shaped* like a code must collapse, because a generated secret is itself identifier-shaped. It distinguishes a wrong selector (`credential_selector_not_found`) from a field outside the authorized origin (`credential_selector_outside_authorized_origin`), from "no frame carries the authorized origin" (`credential_authorized_origin_not_in_frames`), and from an ambiguous multi-frame match that DID write (`credential_selector_ambiguous_may_have_applied`, never retriable). No page-derived or value-derived text may cross that boundary.

### Acceptance

- Regression tests, each failing without the fix (verified by stashing the source changes and re-running: 18 failures):
  - extension: writes into the form frame when that frame is the authorized origin; classifies a field that lives only outside the authorized origin as `credential_selector_outside_authorized_origin` (and only ever injects into authorized frames); distinguishes `credential_selector_not_found`; refuses `credential_authorized_origin_not_in_frames` before any injection; still aborts `credential_origin_changed_before_write` when the page navigates; lets its own fixed codes cross the native boundary while collapsing page-derived text; `read_control`/`find` report the receiving `__frameOrigin`.
  - main: authorization + vault binding + `driverType` all name the FRAME origin while `pageOrigin` guards navigation; falls back to the page origin when no frame origin is reported; refuses `credential_fields_span_multiple_origins`; `dispatch:credential_selector_outside_authorized_origin` and `vault_resolve:origin_mismatch` reach the caller; any page-derived or code-shaped message collapses to `credential_fill_failed` and is never echoed; the reason code reaches both the tool result and the audit row (new `browser_audit_entries.reason`, with a rollback-tested migration).
- Live (see the [credential-login livetest](browser-gateway-credential-login_livetest.md#lt-703-embedded-cross-origin-login-form)): on `windows-pc`, `fill_credential` for a credential scoped to `https://login.lcn.com` fills the form embedded in `https://www.lcn.com/login`; and with the current `www.lcn.com`-scoped item it refuses with a reason naming `https://login.lcn.com` rather than `credential_fill_failed`.

### Live re-check — 2026-10-11

After James restarted `windows-pc`, the restored LCN tab (pageId `771576274`) was first unreadable
(`host_permission_denied`; see [LT-665](#lt-665)). `browser.navigate` reloaded it and the page text
became readable. `browser.fill_credential` for the same vault item, standing approval still valid,
then failed with reason
`dispatch:credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state`
(audit `19d7214e-0b22-4e35-a528-66a1b512714b`). A read-back showed `#username` empty and the password
field visibly empty. The form was not submitted.

The `dispatch:` prefix is applied in `fillCredentialOperation` only after vault resolve and
authorization, around `deps.driverType`. The code after the colon is in `SAFE_CREDENTIAL_CODES`, so
the coordinator passed the extension's message through rather than collapsing it to
`credential_fill_failed`. That message is the extension fallback in `browserCommandErrorMessage`:
it replaces any credential-`type` error whose text is not one of the fixed origin-bound codes.
Current `runOriginBoundType` throws those specific codes (`credential_selector_not_found`,
`credential_authorized_origin_not_in_frames`, `credential_selector_outside_authorized_origin`,
`credential_write_dispatch_failed_…`), and the fallback would not be used for them. Empty fields
show this attempt did not write a value, so the fallback's "may have applied" claim is wrong for
this audit row. The write on the `windows-pc` extension is the remaining failure; the vault lookup
is not.

<a id="lt-704"></a>

## LT-704 — OpenCode candidate discovery drops the inherited environment and selects an install without the routed account model

**Status: code verified 2026-10-13, independent completion-gate PASS; queue re-verified 2026-10-14; install/restart prerequisite satisfied 2026-10-14; the two packaged smoke checks remain unrun and deferred — not confirmed fixed live.**
Origin: [OpenCode effort variant startup live test](2026-10-13-opencode-effort-variant-startup_livetest.md#evidence-run--2026-10-13-rebuilt-packaged-app).
Implementation status: [active startup remediation plan](2026-10-13-opencode-startup-remediation_plan.md)
(untracked root-checkout working document; lands as `2026-10-13-opencode-startup-remediation_plan_completed.md` at close).
Code implementation: [completed launch-environment plan](2026-10-13-opencode-launch-environment_plan_completed.md).
Plan-owned packaged acceptance: [launch-environment live check](2026-10-13-opencode-launch-environment_livetest.md),
sharing the original owner's two open UI steps; record one live run there and link its evidence back.
Deferred-check record: the exact procedure is recorded inline in
[Deferred packaged acceptance](#lt-704-deferred-packaged-acceptance) below so any checkout of
this branch can follow it; the untracked root-checkout
[startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md) (active
`_livetest.md`, never committed) is the identical campaign/evidence copy.

### Observed behaviour

After James rebuilt and restarted Harness, provider-default thinking still failed for session
`ix0iunga7` in `~/work/12steps`, OpenCode `xiaomi-token-plan-ams/mimo-v2.6-pro`, explicitly routed
to local Amsterdam account ComTechSpare (`comtechspare-f7a6`). Packaged-app High thinking was not tested.
The installed archive contains the prior effort-only variant repair, including the `Map` projection;
this is a distinct reproduced failure after that repair, not evidence that its projection regressed.

`app.log` lines 27455, 27457 and 27458–27459 record startup at 17:38:06.816 UTC, fallback to
another OpenCode install of major 2 at 17:38:08.011 UTC, and initialization failure at
17:38:09.553 UTC. The retained-session error has `textChars: 92` and
`textHash: 7d9b0dca8f11b1bd`, which identifies the static
`Unable to confirm the selected model for its configured generation budget; refusing startup.`
message in `acp-generation-budget-selection.ts`, not the native-config probe error.
Per-check timestamps and installed-build provenance remain in the owning live test.

### Root cause

The actual factory supplies caller environment overrides, not a complete inherited environment,
to `listOpenCodeCommandCandidates`. That function passes the overrides-only object straight into
`buildCliSpawnOptions` for `which -a opencode`. Without inherited `HOME`/`PATH`, discovery misses
the working NVM OpenCode 1.19.0 and sees the stale Homebrew install plus desktop OpenCode 2.
The later native probe/spawn merges `getSafeEnvForTrustedProcess()` with caller overrides, so
discovery and execution use different environment semantics.

The factory then selects desktop OpenCode 2. Its native model options include the region's
`xiaomi-token-plan-ams` models, but not the requested derived
`aio-mimo-comtechspare-f7a6/mimo-v2.6-pro` account model. The post-session generation-budget
guard correctly refuses startup rather than allowing an unconfirmed account/model.

The implementing agent reproduced this through the actual factory with an overrides-only
environment. Supplying inherited `HOME` selected the NVM CLI, confirmed the exact routed
ComTechSpare model and reached adapter ready. These experiments sent no model prompt and
do not count as a packaged-app reply or High-thinking acceptance pass.

Reproducer: `_scratch/opencode-real-startup.ts`. The before-fix options-only run exited 1;
`--inherit-home` reached ready without a prompt and exited 0. After the source merge repair,
both normal `--prompt` and `--high --prompt` source-runtime runs exited 0 and confirmed the
exact routed account/model and requested effort (`modelConfirmed: true`, `effortConfirmed: true`,
`responseIsOK: true`). Safe retained outputs: `_scratch/opencode-launch-runtime-default.log`
and `_scratch/opencode-launch-runtime-high.log`. Packaged-app High thinking remains unrun;
the installed/restarted packaged checks remain open.

Focused verification passed eight spec files / 181 tests (`_scratch/test-run.opencode-launch-focused.log`).
Temporarily removing only the source fix made the new regressions fail, exit 1
(`_scratch/opencode-launch-regression-red.log`); the implementing agent restored the repaired source.
Typecheck, spec typecheck, lint, length ratchet, main build and renderer build exited 0
(`_scratch/opencode-launch-{types,spec-types,lint,length,main,renderer}.log`). The guard is unchanged.
The actual compiled JavaScript factory also passed both real default and High-thinking prompts,
exit 0 (`_scratch/opencode-launch-compiled-default.log`, `_scratch/opencode-launch-compiled-high.log`).
Both safe results record `compiled: true`, `modelConfirmed: true`, `effortConfirmed: true`,
and `responseIsOK: true`; the second records `high: true`. The implementation coordinator's
pinned no-cache full suite passed, and independent fresh review returned PASS with no
actionable findings. Code remediation is verified; this item stays open for packaged acceptance.
Both installed/restarted packaged acceptance checks remain pending.

The initial full-suite run exited 1 with exactly two SEA build-repeatability spec failures:
the shell used Homebrew Node 26.3, whose binary lacked the SEA fuse, rather than `.nvmrc`'s
pinned Node 24.15.0. Both affected SEA specs passed under the installed pinned version, without
code/test changes for this environment mismatch. Typecheck, spec typecheck, lint, length ratchet,
main build and renderer build were all rerun under the pinned Node/PATH and exited 0
(`_scratch/opencode-launch-pinned-{types,spec-types,lint,length,main,renderer}.log`).
The implementation coordinator's pinned no-cache full suite exited 0: 2,420 files,
31,276 tests passed, six skipped (`_scratch/opencode-launch-full-pinned.log`; raw
`_scratch/test-run.opencode-launch-full-pinned.log`).

Independent report `_scratch/opencode-launch-fresh-gate.md`: **VERDICT: PASS**, no actionable
findings. The fresh reviewer independently reran all six canonical non-test gates, eight focused
spec files / 181 tests, compiled default/High actual replies, and the full no-cache suite under
pinned Node 24.15.0. All exits are 0. Independent full exit record:
`_scratch/opencode-launch-fresh-full-exits.json`; raw full output:
`_scratch/test-run.opencode-launch-fresh-full.log` — 2,420 files, 31,276 tests passed, zero
failures and six existing pending tests. Native current session options confirmed the exact
ComTechSpare account model and requested effort, and both real responses were `OK`.
This verdict covers the scoped launcher code repair on the shared dirty checkout; no
installed/restarted packaged live pass is claimed. The remediation status plan remains active.

### Implementation status update — 2026-10-14 (Plan Queue worker)

The committed implementation was re-verified in queue worktree
`queue/2026-10-13-opencode-startup-re-bf56b9` with no code changes: 19 OpenCode spec files /
325 tests, the six canonical static gates, main/renderer builds and the alias/IPC generators
all pass (receipts `_scratch/opencode-startup-remediation-queue-worker-20261014-bf56b9/`).
Read-only installed-build provenance: the archive installed 2026-10-14 13:00:28 UTC contains
both this repair and LT-705's, and its compiled `opencode-cli-launch.js` is byte-identical
(sha256 `9c5cd822…`) to the worktree build; the production app booted 13:08:32 UTC, after that
install. The install/restart prerequisite is satisfied. The two packaged smoke checks
themselves require creating sessions with interactive account/model/thinking selection in the
packaged app, which no agent-reachable surface provides (`aio-mcp` has no session commands;
Harness desktop control is hard-denied), so the deferred procedure (exact steps) is recorded
inline in [Deferred packaged acceptance](#lt-704-deferred-packaged-acceptance) below and
mirrored in the untracked root-checkout
[startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md). No
packaged live pass is claimed.

### Required behaviour

Candidate discovery uses the same trusted inherited environment plus caller overrides as native
probe/spawn. Inherited `HOME` and `PATH` allow the normal NVM CLI to be discovered; explicit
caller overrides retain precedence. The launched adapter confirms the exact derived routed
account/model before starting a budgeted turn. Keep the guard fail-closed: a native region model
is not confirmation of the requested account model, and no silent account fallback is permitted.

### Acceptance

- A focused regression proves inherited `HOME`/`PATH` reach the candidate-discovery subprocess
  when the caller supplies only overrides, and proves explicit caller overrides still win.
- The actual factory startup reproducer succeeds with the ordinary overrides-only caller object:
  selects the working install, confirms `aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`, and reaches
  ready. Preserve negative coverage for absent/unconfirmed routed account models.
- Targeted tests, all canonical project gates and an independent fresh-context completion gate
  pass. Do not mark implementation complete while verification or actionable review findings remain.
- After installing and restarting a build containing this repair, both provider-default and High
  thinking checks in the owning live test start and respond while retaining ComTechSpare and the
  selected model. A default-thinking failure does not establish a High-thinking failure.
- No raw native configuration, credentials or prompt content is emitted in diagnostics or fixtures.

<a id="lt-704-deferred-packaged-acceptance"></a>

### Deferred packaged acceptance (branch-recorded procedure)

The exact procedure for LT-704's two deferred live checks is recorded here so any checkout of
this branch can follow it: active `_plan.md`/`_livetest.md` documents are never committed (the
plan-spec guard and the landing squash in `src/main/plan-queue/plan-queue-squash.ts` refuse
them), so a live-test file alone would not be reachable from a checkout. The identical text is
kept in the untracked root-checkout
[startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md) (beside the
plan, per AGENTS.md Live-Test Deferral), which remains the campaign runbook and per-check
evidence home; keep the two copies identical and never weaken either. The owning
acceptance/evidence record stays the
[launch-environment live check](2026-10-13-opencode-launch-environment_livetest.md): record one
live run there and link its evidence back to the original owner.

Prerequisite (satisfied 2026-10-14; receipts
`_scratch/opencode-startup-remediation-queue-worker-20261014-bf56b9/`): the installed packaged
Harness at `/Applications/Harness.app`, with James's normal account — the archive installed
2026-10-14 13:00:28 UTC contains both repairs and its compiled
`dist/main/cli/adapters/opencode-cli-launch.js` is byte-identical (sha256 `9c5cd822…`, 6,115
bytes) to the verified worktree build; the production log shows `App Initializing Harness` at
13:08:32 UTC and `Harness initialized` at 13:08:52 UTC — after that install. Limitation:
archive-on-disk plus boot-after-install provenance; loaded process memory is not established.
Re-check this provenance if the app has been rebuilt or restarted since 2026-10-14 13:08 UTC.

- **Check 1 — LT-704 provider-default smoke (12steps).** In the running packaged Harness,
  create a disposable session in `/Users/suas/work/12steps`. Select OpenCode, MiMo-V2.6-Pro,
  account ComTechSpare (Amsterdam), and provider-default thinking. Send exactly
  `Reply with exactly OK. Do not use tools or change files.`
  Expected: startup succeeds, ComTechSpare and MiMo-V2.6-Pro remain selected, and the session
  responds `OK` without a model-limit or selected-model-confirmation error. Retain safe startup
  evidence and build provenance in the owning live test; never record native configuration,
  credentials or unrelated task content.
- **Check 2 — LT-704 High-thinking smoke (12steps).** A second, otherwise identical disposable
  session with High thinking, same prompt. Expected: startup and response succeed; High thinking
  and ComTechSpare remain selected. Record the observed selections and reply, then end only the
  disposable smoke sessions. A default-thinking failure does not establish a High-thinking
  failure.

Why deferred: each check needs a disposable session created in the packaged app with interactive
account/model/thinking selection and James's signed-in ComTechSpare account. No agent-reachable
surface can do that: `aio-mcp` exposes `settings`, `remote-nodes`, `release-readiness`,
`local-ai`, `copilot-account`, `browser-credentials`, `loop` and MCP forwarders only — no
session-create or prompt-send command (docs/AIO_MCP_CLI.md) — and the orchestrator-tools toolset
has none either; Harness desktop control is hard-denied, and the thin-client/mobile gateways are
user remote-control surfaces with no sanctioned agent flow. Agent-side verification of the same
runtime behaviour already exists (source and compiled factory default/High real replies
confirming the exact routed account/model); these checks confirm the installed app's own
session path.

<a id="lt-705"></a>

## LT-705 — OpenCode 1 cannot open a folder whose shared database OpenCode 2 changed, and the OpenCode 2 fallback cannot honour per-session settings

**Status: machine repair applied and verified 2026-10-13; code change implemented, canonical gates and full suite pass, independent reviews PASS with advisory notes addressed; queue re-verified 2026-10-14; install/restart prerequisite satisfied 2026-10-14; the communitytech packaged smoke remains unrun and deferred — not confirmed fixed live.**
Origin: the LT-704 packaged provider-default check, run by James on 2026-10-13 at 20:22 UTC
(21:22 BST) in `~/work/communitytech` ([launch-environment live check](2026-10-13-opencode-launch-environment_livetest.md)).
Implementation status: [active startup remediation plan](2026-10-13-opencode-startup-remediation_plan.md)
(untracked root-checkout working document; lands as `2026-10-13-opencode-startup-remediation_plan_completed.md` at close).
Deferred-check record: the exact procedure is recorded inline in
[Deferred packaged acceptance](#lt-705-deferred-packaged-acceptance) below so any checkout of
this branch can follow it; the untracked root-checkout
[startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md) (active
`_livetest.md`, never committed) is the identical campaign/evidence copy.

### Observed behaviour

The installed archive was built at 20:17 UTC and contains the LT-704 discovery repair. Session
`icott8xxw` (`~/work/communitytech`, OpenCode `xiaomi-token-plan-ams/mimo-v2.6-pro`, routed by
default to ComTechSpare `comtechspare-f7a6`) logged `OpenCodeCliLaunch` "OpenCode CLI could not
read its database; using another install" `{major: 2}` at 20:22:27 UTC, then failed at 20:22:28
with `textChars: 92`, `textHash: 7d9b0dca8f11b1bd`: the same selected-model confirmation refusal
as LT-704. James's screenshot shows the 13:35 BST message timestamp and the native-config probe
error (`textChars: 89`, `textHash: 1f2fc4ca0fb107ff`, logged for `i1sevv0tp` at 12:35 UTC), so the
restored session appears to display its earlier error. That UI detail was not separately verified.

### Root cause

Each step was reproduced without sending a model prompt and without printing native values.

1. **OpenCode 1 cannot open this folder.** NVM OpenCode 1.19.0, the newest 1.x on npm, exits 1
   with `no such column: project_id` in `~/work/communitytech` (`debug config`, `models`), but
   works in `/`, `~`, ai-orchestrator and 12steps. Desktop OpenCode 2.0.18 shares
   `~/.local/share/opencode/opencode.db` and has rebuilt `workspace` as
   `(id, provider, binding, created_at, last_used_at)`; OpenCode 1's schema has
   `workspace.project_id`. On an APFS clone of the database, adding a nullable
   `workspace.project_id` alone made OpenCode 1 start in communitytech. Clearing the project's
   `sandboxes` or deleting its duplicate project row did not. LT-704's discovery repair therefore
   found the right CLI, which then failed in this folder, and selection fell back to OpenCode 2.
2. **OpenCode 2 sessions ignore the per-spawn overlay.** OpenCode 2's `acp` command takes no
   options (`--standalone` and `--server` are rejected) and attaches to the shared background
   service (`opencode-cli serve --service`). A probe overlay that defined a provider with a
   placeholder key was visible to an OpenCode 1 ACP session and invisible to an OpenCode 2 one.
   The running service's `GET /api/config` held an inline document with `agents`, `permissions`
   and an `aio-mimo-comtechspare-f7a6` provider: a frozen copy from whichever process started the
   service. The pre-spawn probe (`api --standalone GET /api/config`) reads a private server that
   does see the overlay, so the permission and generation-budget assertions passed against
   settings the session never used. This affects every OpenCode 2 session, not only routed accounts.
3. **OpenCode 2 has no key for the second account.** OpenCode 2 keeps credentials in the
   database `credential` table, which held only `xiaomi-token-plan-ams` (row created 2026-09-26).
   OpenCode 1's `auth.json` holds both accounts. Harness's account sign-in command runs
   `opencode auth login -p …`, which is OpenCode 1 syntax. The OpenCode 2 ACP session listed only
   the eight `xiaomi-token-plan-ams` models, and `session/set_config_option` answered
   `-32602 model not found: aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`. The guard correctly refused.

Reproducers: `_scratch/mimo-second-account/repro.ts` (routed handshake per CLI),
`overlay-test.ts` (overlay visibility), `app-path.ts` (actual factory startup, no prompt) and
`refusal.ts` (selection against the real OpenCode 2 install).

### Repair

- **Machine, 2026-10-13 about 20:40 UTC:** `ALTER TABLE workspace ADD COLUMN project_id text` on the
  shared OpenCode database, after an APFS clone backup at
  `~/.local/share/opencode-backups/2026-10-13-before-workspace-column`. Undo with
  `ALTER TABLE workspace DROP COLUMN project_id`. Verified on a clean clone first: OpenCode 1
  `debug config`, and OpenCode 2 `api --standalone GET /api/config`, `/api/session`,
  `/api/project` and `session list`, all exit 0. On the live database, OpenCode 1 opens
  communitytech, 12steps, binsout, one-more-floor and ai-orchestrator, and the live OpenCode 2
  service still lists sessions and projects. The actual factory then started ComTechSpare in
  communitytech on OpenCode 1 and confirmed `aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`. A future
  OpenCode 2 migration that rebuilds `workspace` would undo this repair.
- **Code (James approved "both" follow-ups):** `selectOpenCodeLaunch` reads `--version` first,
  which does not open the database, skips any install newer than `MAX_SUPPORTED_OPENCODE_MAJOR`
  (1), and refuses startup before any ACP spawn with a plain message when no OpenCode 1 install
  can print its config. The OpenCode 2 branches in the adapter factory remain but are inactive.

### Implementation status update — 2026-10-14 (Plan Queue worker)

Queue worktree `queue/2026-10-13-opencode-startup-re-bf56b9` re-verified the committed code with
no changes (19 OpenCode spec files / 325 tests, six canonical gates, builds, generators —
receipts `_scratch/opencode-startup-remediation-queue-worker-20261014-bf56b9/`). The machine
repair still holds: OpenCode 1 `debug config` exits 0 in `~/work/communitytech` and
`~/work/12steps` (output discarded). The installed archive (2026-10-14 13:00:28 UTC) contains
both repairs with a compiled launcher byte-identical to the worktree build, and the production
app booted 13:08:32 UTC after that install, so the install/restart prerequisite is satisfied.
The communitytech packaged smoke needs session creation in the packaged app UI (no
agent-reachable surface; desktop control hard-denied) and its deferred procedure (exact steps)
is recorded inline in
[Deferred packaged acceptance](#lt-705-deferred-packaged-acceptance) below and mirrored in the
untracked root-checkout
[startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md).
No packaged live pass is claimed.

### Required behaviour

Harness never starts an OpenCode session on a version whose session ignores the per-spawn overlay.
When no supported install works, it refuses before spawning, naming the cause without native
output, paths or credentials. Routed-account model confirmation stays fail-closed.

### Acceptance

- Focused regressions: OpenCode 2 is never selected and its `debug config` never runs; a lone
  OpenCode 2 install, a broken OpenCode 1 install and no install each give the right plain
  message; LT-704's inherited-environment discovery tests still pass.
- The actual factory starts ComTechSpare in `~/work/communitytech` on OpenCode 1 and confirms the
  exact account model without a prompt.
- Canonical gates and an independent completion review pass.
- Packaged: after installing and restarting a build containing this change, a ComTechSpare
  session in `~/work/communitytech` starts and replies. This shares the LT-704 packaged checks.

<a id="lt-705-deferred-packaged-acceptance"></a>

### Deferred packaged acceptance (branch-recorded procedure)

The exact procedure for LT-705's deferred live check is recorded here for the same
branch-access reason as the LT-704 section above, and is mirrored identically in the untracked
root-checkout [startup remediation live test](2026-10-13-opencode-startup-remediation_livetest.md)
(keep both copies identical; that file is the campaign runbook and per-check evidence home):

- **Check 3 — LT-705 communitytech smoke.** In the running packaged Harness
  (`/Applications/Harness.app`, James's normal account; same satisfied install/restart
  prerequisite as LT-704), repeat check 1 in `/Users/suas/work/communitytech`: create a
  disposable session, select OpenCode, MiMo-V2.6-Pro, account ComTechSpare (Amsterdam), and
  provider-default thinking, and send exactly
  `Reply with exactly OK. Do not use tools or change files.`
  Expected: startup succeeds on OpenCode 1 with ComTechSpare and MiMo-V2.6-Pro retained, and
  the session replies `OK`. Owner/evidence home:
  [launch-environment live check](2026-10-13-opencode-launch-environment_livetest.md) check 3.

Why deferred: as for LT-704 — packaged-app UI session creation on James's account is not
agent-runnable (no session-create surface; desktop control hard-denied).

### Not in scope

Account sign-in writes only OpenCode 1's key store; renewed OpenCode 2 support would need both
stores. A transient OpenCode 1 `database is locked` during selection now refuses startup instead
of silently falling back; the existing process gate makes that rare.

<a id="lt-706"></a>

## LT-706 — a MiMo step that exhausts the combined cap on reasoning ends the session silently

**Status: fixed and regression-tested in the working tree 2026-10-14; live re-check pending.**
Origin: James's live session `ivx7upc8u` (installed app, OpenCode 1.19.0,
`aio-mimo-comtechspare-f7a6/mimo-v2.6-pro`), 2026-10-14 20:39–21:41 BST.
Plan: [2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md](2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md).

### Observed behaviour

- OpenCode session `ses_ec4126b42ffemKuqDOJBnet17O` records three consecutive assistant steps
  with `finish: "length"`: output 0 + reasoning 16388 (21:21:59 BST), output 1 + reasoning 16383
  (21:29:16 BST), and output 0 + reasoning 16386 (21:41:26 BST, after James's manual
  "continue"). Earlier tool-call steps used up to about 12.7k reasoning tokens each.
- `app.log`: all three `ACP turn completed` lines report `stopReason: "end_turn"`,
  `classifierReason: "completed"`, `generationBudget.combinedOutputTokens: 16384`. The shared
  `ProviderTurnEnding` line reclassified the first as `dangling_tool_result` (one automatic
  continuation); the other two stayed `completed`. No notice, no further continuation; the
  session went idle each time, so the manual "continue" also appeared to do nothing.

### Root cause

`outputBudgetSaturated` (`src/main/cli/turn-ending-classifier.ts`, added for LT-690) returned false
for empty text and otherwise required the whole-turn text to end unfinished. ACP usage covers only
the final provider step, so a step cut off while reasoning after earlier finished narration, or
with no text at all, read as a normal completion. `AdapterTurnEndingObservation` reclassifies
without `combinedOutputTokenCap`, and its `dangling_tool_result` overrides the adapter ending.

### Required behaviour

A non-error completion with no open tool call whose final-step output + reasoning reaches the
injected cap (within tolerance) is `max_output / budget_saturated` when the final step's visible
output is within tolerance or the turn text is empty or unfinished. The cap is also read from the
adapter's `generationBudget` metadata so both classification layers agree, and saturation takes
precedence over an unanswered tool result. Failure and transient-error signals keep
saturation out, so a failed turn is never auto-continued.

### Acceptance

- Regression tests for the zero-text, earlier-narration, metadata-cap/dangling, metadata-usage,
  runtime observation and `acp-turn-completion` cases fail on the previous classifier and pass; negative cases (finished answer,
  open tool, error, empty under cap) stay out of saturation.
- Live: [MiMo reasoning-cap live checks](2026-10-14-mimo-reasoning-cap-cutoff_livetest.md).

## LT-707 — benchmark runner loses a scored run when workspace cleanup flakes

Scope note: this defect is in the experiment harness (`benchmarks/plan-execute-ab/`), not app
code. It was reproduced while running deferred check A6 of
[2026-10-14-local-model-plan-execute-ab_plan_livetest.md](2026-10-14-local-model-plan-execute-ab_plan_livetest.md)
and is tracked/remediated in the active plan
[2026-10-14-local-model-plan-execute-ab_plan.md](2026-10-14-local-model-plan-execute-ab_plan.md)
(same pattern as LT-704/LT-705 being tracked in their active plan). It is registered here
because the operating rule requires every reproduced defect to be indexed before it is fixed.

### Observed behavior

2026-10-24, `runner.ts run --local-only --phase pilot --session pilot-2026-10-15 --arms C1
--tasks AIO-03,...,12ST-04`: the AIO-05 coder run completed and the runner had captured its
patch, applied hidden tests and scored it, then aborted with `run failed: ENOTEMPTY, Directory
not empty: '<workRoot>/AIO-05-C1-1'` before `appendRunRecord`. The scored run left no
`runs.jsonl` record (the batch matrix lost the cell and the batch exits 1), and the leftover
workspace directory makes the re-run fail with `workspace already exists`.

### Root cause

`runArm` (`benchmarks/plan-execute-ab/runner.ts`) runs `cleanupWorkspace(workspace.dir)`
between scoring and building/writing the RunRecord. `cleanupWorkspace`
(`benchmarks/plan-execute-ab/task-export.ts`) is a bare `rmSync(dir, { recursive: true,
force: true })`; Node's recursive removal can fail transiently with ENOTEMPTY/EBUSY (removal
races — files appearing during rm, e.g. `.DS_Store` on macOS). Because cleanup runs before the
record write, any such flake discards a fully completed run and misreports it as "failed before
scoring".

### Required behavior

1. A run that reached scoring always persists its RunRecord (and patch), whatever happens to its
   throwaway workspace afterwards.
2. Workspace cleanup tolerates transient removal races (bounded retries) and never turns a
   completed run into a batch failure; a persistent leftover is reported as a warning/note.
3. A leftover workspace from a crashed/killed run still refuses silent reuse (existing
   behaviour) but the error identifies the stale directory for manual clearing.

### Acceptance

- Regression tests pin: (a) the run record is appended even when cleanup throws; (b)
  `cleanupWorkspace` retries through a transient ENOTEMPTY and then succeeds; (c) a cleanup
  failure that persists is surfaced as a note/warning without dropping the record.
- The AIO-05 C1 cell is re-run and recorded normally after the fix; the benchmark suite and the
  canonical static gates stay green.

<a id="lt-780"></a>

## LT-780 — documented Copilot account CLI reads double-wrap the authenticated request

**Status:** reproduced and repair implemented 2026-10-27; independent review pending.
The rebuilt CLI calls the real authenticated running parent successfully for all four methods.
The new spawned-CLI transport regression fails against the original source and passes with
the repair. Evidence: `2026-10-27-human-external-residuals_evidence/review2/cli-live.receipt.json`
and `transport-red-final` / `transport-green` receipts. Active implementation record:
[review corrections](2026-10-27-human-external-review2_plan.md#lt-780--lt-781-implementation-status).
Renumbered from the colliding campaign-local LT-710 to LT-780 after scanning every registered
checkout on 2026-10-27. The other campaigns' LT-710/LT-711 records are unrelated and preserved.

**Observed behaviour.** The injected, installed `AIO_MCP` executable's documented
`copilot-account list --json`, `rules --json`, and `doctor --json` all exit 1 with
`Unrecognized key: "payload"`. `route <current-worktree> --origin=automation --json`
also reports missing top-level `workingDirectory`. A second list call reproduces the failure.
No account mutation or login was attempted. The same authenticated parent transport, called
through the built repository client with the expected empty payload, succeeds and returns two
authenticated profiles. This distinguishes a malformed CLI request from missing authentication,
an unavailable parent, or absent Copilot profiles.

**Executing source path / root cause.** `src/main/mcp/copilot-account-cli.ts:133` calls
`client.call(method, { payload })`. `orchestrator-tools-rpc-client.ts:60` already wraps that
argument as `params.payload`. `orchestrator-tools-rpc-server.ts:377` passes it unchanged to
`dispatchCopilotAccountCliRpc`, whose strict empty/route schemas reject the extra wrapper
(`orchestrator-tools-rpc-copilot-account.ts:34`, `:43`). Existing CLI tests mock the transport
instead of joining it to dispatch, and even pin the nested wrapper in the route assertion
(`copilot-account-cli.spec.ts:44`); the focused suite remains green on the defective source.
The observed installed failure and the successful correct-shape control agree with this path;
this run does not claim the installed binary is byte-identical to the checkout.

**Required behaviour.** All four read verbs must pass the business payload once through the
existing authenticated client. Preserve strict request/response validation and the operator-only
boundary on account mutations. Do not relax a schema or add a compatibility adapter to accept
the malformed internal shape.

**Acceptance.** A real-client/dispatcher regression must exercise all four verbs, including route
origin, alongside unknown-key and response-leak refusals. After rebuild, the injected installed
CLI must return valid read-only results for list/rules/doctor/route against the running parent.
Recheck RES-020 and RES-021 account prerequisites without claiming their provider campaigns pass.

**Evidence.** Durable [campaign receipts](2026-10-27-human-external-residuals_evidence/REPORT.md),
`2026-10-27-human-external-residuals_evidence/run1/`:
`copilot-account.receipt.json`, `copilot-cli-repro.receipt.json`,
`copilot-direct-read.receipt.json`, `focused-tests.receipt.json`, `source-seal.json`.
The source hashes and authenticated replies are retained without transport capabilities,
socket values, profile homes or credentials. The root-owned residual document is the live owner.
The review retry reproduces all four malformed reads again; see
`review-round1/copilot-cli-recheck.receipt.json` in the same durable evidence directory.

<a id="lt-781"></a>

## LT-781 — successful CLI exit truncates settings JSON when stdout is a pipe

**Status:** reproduced and repair implemented 2026-10-27; independent review pending.
The dispatcher now assigns `process.exitCode`, allowing pending stdout writes to drain.
A real parent read through the rebuilt CLI returns matching valid 115,377-byte pipe/file
outputs. A spawned CLI with a slow reader reproduces 65,536 of 450,316 bytes before the fix
and preserves every byte after it; nonzero parent errors remain nonzero. Evidence:
`2026-10-27-human-external-residuals_evidence/review2/cli-live.receipt.json` and transport receipts.
Active implementation record:
[review corrections](2026-10-27-human-external-review2_plan.md#lt-780--lt-781-implementation-status).

**Observed behaviour.** Twice, the injected installed `aio-mcp settings list --json`, captured
through a pipe by `subprocess.run`, exits 0 with exactly 65,536 bytes and no stderr. Parsing fails
with `Unterminated string starting at: line 1868 column 11 (char 65493)`. No raw settings list is
retained. A regular-file stdout control returns valid JSON: 115,377 bytes, 224 settings. Running
the same compiled `runSettingsCli` with natural Node shutdown through a pipe also returns all
115,377 bytes; the two complete outputs have the same SHA-256. Small individual setting reads
continue to work. These controls rule out a truncated parent response or a JSON formatting error.

**Source-supported cause.** `src/main/mcp/settings-cli.ts:32` writes stdout without awaiting its
callback; the list path writes the complete serialization at `:45`. The outer dispatcher calls
`process.exit(code)` immediately after the async command returns
(`src/main/mcp/aio-mcp-dispatcher.ts:109`), without draining a piped stdout stream. The observed
pipe/file/natural-exit difference identifies premature exit as the repair target. This run does
not patch the dispatcher or claim other large-output command families have been live-tested.

**Required behaviour.** Successful CLI completion must preserve every stdout byte before exiting,
for pipes as well as regular files, while retaining nonzero error exits and clean MCP streams.
Keep secret-tier values redacted. Do not hide the defect by silently truncating results or
requiring callers to redirect to a file.

**Acceptance.** A spawned CLI/dispatcher test must write a harmless JSON result larger than the
pipe buffer, pipe it to a slow reader, parse the full result and assert exit status. Include
failure output/exit handling. After rebuild, the installed `settings list --json` must parse
through a pipe and match a regular-file capture; retain only hashes, lengths and setting counts.

**Evidence.** Durable [campaign receipts](2026-10-27-human-external-residuals_evidence/REPORT.md),
`2026-10-27-human-external-residuals_evidence/run1/`:
`settings-list-integrity.receipt.json`, `settings-stdout-controls.receipt.json`, `source-seal.json`.
Only redacted metadata, sizes, parse results and hashes are retained; temporary raw output was
closed and deleted immediately after the controls.
The review retry reproduces the same lengths and matching complete-output hashes; see
`review-round1/settings-pipe-recheck.receipt.json` in the same durable evidence directory.

<a id="lt-890"></a>

## LT-890 — fresh-profile RLM initialization can leave the app without a window

**Status:** observed live on 27 October 2026; not fixed. The immediately subsequent launch with the same profile succeeded, as did this review's new fresh-profile first launch. Investigation has not identified the lock owner or established a repair. Active implementation status: [startup remediation plan](2026-10-27-residuals-startup-remediation_plan.md#lt-890-implementation-status). That untracked document lives in the root checkout for the coordinator.

### Observed behaviour

At 04:19:30.067 UTC, the rebuilt assigned checkout, launched with its isolated empty profile and debug port 9554, reports critical `Work controls` initialization failure: `SqliteError: database is locked`. The stack reaches `RLMDatabase.initializeDatabase` through `initializeGlobalPauseRuntime`. The process remains alive and its debug endpoint returns an empty target list; readiness of that endpoint alone was insufficient. The context worker also starts during this interval. After stopping the owned process and renderer and restarting against the same profile, the app initializes and exposes its real Angular renderer at 04:21:29–04:21:46 UTC. Focus-emulated DOM and animation-frame checks pass. No database or product source was patched for recovery.

### Root cause and uncertainty

The observed failing operation is `db.pragma('journal_mode = WAL')` at `src/main/persistence/rlm-database.ts:140`; the explicit busy timeout is installed later at line 144. Both main and the context worker initialize the same isolated database (`context-worker-main.ts:157–160`; `context-worker-client.ts:107–114`). Concurrent initial WAL/schema setup is a candidate cause, not a proven lock-owner attribution. No lock-owner trace or deterministic race reproduction was collected, so timeout ordering alone is not claimed as the complete cause.

**Review correction, 27 October.** `defaultDriverFactory` constructs better-sqlite3 without a
timeout override (`src/main/db/better-sqlite3-driver.ts:72`). Its JavaScript constructor defaults
to 5,000 ms (`node_modules/better-sqlite3/lib/database.js:34`), and the native constructor applies
`sqlite3_busy_timeout` before returning (`src/objects/database.cpp:172` in that installed package).
The connection therefore already has this timeout before RLM's pragmas. Moving the later pragma
alone is not an evidenced repair. The new fresh-profile first launch succeeded; the earlier
failure remains open with no identified lock owner or product-source change.
The compiled driver was also exercised in Electron Node mode against an in-memory database:
the initial busy timeout reads 5,000 ms and `SELECT 1` succeeds before any RLM configuration
pragma. See the [native control receipt](2026-10-27-human-external-residuals_evidence/review2/native-electron-control.receipt.json).

### Required behaviour

A new profile must initialize database ownership and critical Work controls safely with the context worker enabled. Contention must either settle within a bounded startup policy or produce a visible, actionable startup failure; the process must not remain running without an app window and only an unhandled rejection. Do not hide the error or change production data during remediation.

### Acceptance

1. Identify the actual competing connection and reproduce contention under ordinary startup without a stress generator.
2. Exercise compiled main/context-worker startup against fresh and existing isolated databases; verify the window and real IPC become ready.
3. Exercise bounded persistent contention and require an actionable visible error plus clean process teardown.
4. Preserve database contents and run focused database/worker regressions and canonical code gates for the eventual fix.

### Evidence

Retained under `2026-10-27-human-external-residuals_evidence/resume2/`: `startup-first/electron.log.txt`, startup/stop/build receipts, the successful second runtime receipts, and `ui-ready.receipt.json`. `id-reallocation.receipt.json` records the clear all-checkout search for LT-890. The initial proposed LT-790 was clear when scanned, then concurrently claimed by the MiMo campaign; its original allocation receipt and pre-cleanup seal remain historical, with this correction recorded in the current report. LT-782 was already owned by MiMo and was never allocated here. Other campaigns' records are untouched.

<a id="lt-991"></a>

## LT-991 — persistence sentinel ignores the extension's serialized evaluate result

**Status:** reproduced live 27 October 2026; repair implemented in the queue checkout,
focused regressions pass; packaged-coordinator live confirmation and independent review pending.
Active implementation status: [review corrections](2026-10-27-human-external-review2_plan.md#lt-991-implementation-status).

**Observed behaviour.** An owned Windows-loopback session serves a save-on-type form. Only its
save socket is deliberately interrupted; no machine network or business tab is changed.
The page visibly reports `Your session has expired` in a `role=alert` region. After restoring
the fixture connection while retaining that banner, `browser.type` still returns `succeeded`
(audit `5fc3e94e-52c1-4340-86db-f4e4652b71eb`). Its journal records successful/unverified
writes, and `browser.assert_persisted` reports `persisted:true`, `confidence:verified`,
`signalState:unknown` (audit `3e23fdcb-6aae-4da9-810c-82aa1152d2cb`). A subsequent snapshot
still contains the expiry banner. No CAPTCHA, credential, real customer data or global network
change was involved. The owned tab, server, script and helper session were cleaned up.

**Executing path / root cause.** `resources/browser-extension/background.js:evaluateInTab`
returns `{type, json}` where `json` serializes the expression's value. This exact shape was
also captured from the real extension. `BrowserTargetPersistenceSentinel.scan` submits that
evaluate command, but `normalizeScanResult` only recognized a bare `{s,m}` or `{result:{s,m}}`.
It therefore returned unknown for both healthy and stale real-extension responses. The
existing mutation guards and persistence assertion consume that unknown state. The repair
decodes the existing wire format before classifying it, retaining unknown for malformed or
truncated results. No extension deployment or new browser capability is required.

**Required behaviour.** Real extension scan results must identify stale-session and failed-save
banners. A post-write scan must report the failed persistence verdict and journal entry;
the first post-disconnect write must be refused when the required pre-write scan is stale.
`browser.assert_persisted` must not report true when the alert scan identifies either failure.

**Acceptance.** Exercise actual serialized extension envelopes for ok/save_failed/session_stale,
including malformed/truncated data; drive mutation guard, journal and persistence-assertion
paths with that wire shape; rerun the owned live form against a rebuilt coordinator. Preserve
normal healthy writes and keep original human/credential escalation boundaries unchanged.

**Evidence.** `2026-10-27-human-external-residuals_evidence/review2/spa-stale-session.receipt.json`
contains the before/after snapshots, restored connection response, write journal and failing
assertion. `sentinel-baseline`, `sentinel-red`, `sentinel-green` and worker cleanup receipts
record the baseline, reproduced missing classification, repair checks and owned cleanup.

<a id="lt-992"></a>

## LT-992 — supported Node 26 cannot collect the packaging repeatability spec

**Status:** reproduced 27 October 2026 during canonical verification; not repaired. The same
unchanged spec passes under supported Node v24.22.1. Active implementation record:
[review corrections](2026-10-27-human-external-review2_plan.md#lt-992-implementation-status).

**Observed behaviour.** The normal full suite under Node v26.12.1 exits 1. Besides three
assertion failures that pass separately, the full default-reporter log records an unhandled
`SyntaxError: Unexpected token '�', "�" is not valid JSON` in `convert-source-map`. The
`scripts/__tests__/sea-build-repeatability.spec.ts` JSON result is failed with both assertions
pending. The normal quiet summary lists only the three other failed assertions. Running this
spec alone with one fork reproduces the same error before any test executes. Under the existing
Node v24.22.1 executable, the unchanged spec executes both packaging cases and exits zero.
No native module was rebuilt and no dependency version, test or runtime-support declaration
was modified. `scripts/check-node.js` explicitly supports both exact versions.

**Root cause and uncertainty.** The visible stack enters `convert-source-map/index.js:83`
through Vitest source-map/stack parsing. The original Node-26 error being formatted is not
established. This is a runtime-dependent collection failure, not evidence that either packaging
assertion passes under Node 26. The successful Node-24 control does not repair Node-26 support.

**Required behaviour.** Every declared supported Node runtime must collect and execute both
packaging repeatability assertions, without an unhandled formatting error or pending results.
Retain the actual checks that a read-only previous executable is replaced and the new executable
runs the fixture. Do not skip the spec, weaken assertions or silently discard runner errors.

**Acceptance.** Run this unchanged assertion contract under Node v26.12.1 and v24.22.1; require
two executed, passing cases and zero unhandled errors under each. Identify the underlying
Node-26 failure before changing product scripts or dependency versions, then run the normal
verification gates for the eventual repair.

**Evidence.** `2026-10-27-human-external-residuals_evidence/review2/` contains
`full-suite-after-prune.*`, `full-suite-failures.receipt.json`,
`isolated-sea-default-runtime.*`, `isolated-sea-supported-runtime.*` and the archived full logs.
`id-992-allocation.receipt.json` records the valid all-checkout uniqueness search.


<a id="lt-711"></a>

## LT-711 — historical Cursor empty-completed failure reports lack correction evidence

### Observed behavior and evidence limit

The owning agent-runtime residual document's 2026-10-04 batch C report says real failed reads
and rejected shell permissions were emitted by Cursor as `completed` with no renderable output.
It states that this would make correction mining treat them as successes. The raw receipt cited
by that historical report is now absent. This item records that attributed historical observation;
it does not claim a new reproduction, confirmed current miner behavior, or a verified fix.
See [the original report](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-007--inconclusive-leaning-towards-retirement-copilot-not-run)
and the 2026-10-27 verifier-repair evidence section in that document.

### Root cause

Not established. A provider `completed` label alone does not prove tool success or actual miner
behavior. Retain genuine provider update shapes and trace adapter normalization, durable transcript
metadata, `extractToolInvocations` and `findCorrectionPairs` before attributing the failure to AIO.
LT-612 covers reported nonzero exit codes; this report concerns empty updates without such a code.
James's AR-007 retirement covers the `failed`-without-output fallback clause, not this report.

### Required behavior

Known failed tools must not be mined as successful corrections. Unknown outcomes must not be
invented as failures or successes. Keep permission rejection and cancellation distinctions intact.

### Acceptance and implementation status

- Reproduce with a bounded genuine current Cursor read/permission failure and retain redacted raw
  event shapes, exact failure context and durable outcome metadata.
- Trace the real correction-miner result. If no actionable failure signal exists on the wire,
  document that limit; never fabricate provider failure from an empty payload alone.
- If AIO discards a genuine failure signal, fix its executing normalization path and verify live
  before updating regressions; run canonical gates and independent review.
- No implementation is claimed. Active untracked follow-up:
  [Cursor outcome investigation](2026-10-27-cursor-empty-completed-investigation_plan.md).

<a id="lt-712"></a>

## LT-712 — read-only browser handoff cannot be correlated to its audit or FIFO position

**Priority:** P3. **Status:** OPEN, recorded 2026-10-27; no fix claimed. Follow-up to LT-616,
whose poll-request/command-ID log remains implemented. Owner: browser command delivery and
Gateway audit pipeline. Implementation status is recorded under *Acceptance and implementation
status* below and in the AR-003 evidence run; the closed
`2026-10-27-browser-handoff-observability_plan_completed.md` record is not edited.
Origin: [AR-003](2026-09-27-livetest-agent-runtime-residuals_livetest.md#ar-003--lt-371-live-browser-command-socket-handoff-correlation).

### Observed behavior

The installed coordinator's 2026-10-27 04:46:25.998–04:46:30.187 UTC run logged two failed
poll handoffs/requeues for dispatch `bff39b44-734c-4a0a-8b3a-c17652338bb9` and one successful
`browser.query_elements` audit `f50a00d6-2058-49b6-af91-7dbab5c7f682`. The retained schema/row
receipt has no dispatch-command column and a null `request_id`. Neither requeue log records
queue position. Those records cannot prove AR-003 step 4's direct join, FIFO-head reinsertion
or absence of duplicate execution. This is an evidence gap, not proof of lost, duplicated or
misordered browser work. The installed binary's source fingerprint was not captured, so this
runtime observation is not represented as a current-checkout build reproduction.

Raw evidence: `2026-09-27-livetest-agent-runtime-residuals_evidence/2026-10-27-verifier-repair/`
(`ar003-attempt.json`, `ar003-main-log.txt`, `ar003-audit.json`, `ar003-final-health.json`).
The review-corrections receipt independently revalidates these inputs and seals the current source.

### Root cause in the reviewed checkout

`browser-extension-command-store.ts:344` resolves only `result.result`; its dispatch ID is not
returned to the read caller. `browser-gateway-service.ts:1288` normalizes that result and records
the query through `BrowserGatewayResultRecorder`, which has no dispatch-ID input.
`browser-audit-store.ts:50` persists the audit fields without a dispatch ID. The store reinserts
with `unshift` at line 397, while `rpc-event-router.ts:641` logs only node, command, poll request
and a requeued boolean. Source proves intended head insertion, not a live queue-position event.
The mutation-journal hook is not a substitute on this read-only path.

### Required behavior

Retain content-free evidence joining the original read command ID, failed poll handoff, actual
head reinsertion and final successful audit ID. Preserve approval-request identity separately;
do not repurpose `request_id` or log page content, selectors, credentials or query results.
Keep the original delivery deadline, receipt safety and single-execution guarantees.

### Acceptance and implementation status

**2026-11-07 implementation (merged from main).** The implementation landed on main under the closed
[browser handoff observability plan](2026-10-27-browser-handoff-observability_plan_completed.md), with
`browser-handoff-observability.spec.ts`. A parallel log-only version on the agent-runtime branch was dropped in the
merge because main already provides the same evidence. Browser command queueing reports each command ID through an
`onQueued` callback. The command store logs `Browser command requeued at FIFO head` with the command ID, queue
position and queue depth. The result recorder persists `command_id` on every audit row
(`browser-audit-store.ts`), and the existing-tab query path passes its command ID to the result. The audit join is
therefore durable, not a log-line join. Live observation on an identified rebuilt coordinator is still open.

- Add the missing read-dispatch/audit correlation and queue-order observation on the executing
  delivery path, with focused regressions. If durable audit storage changes, migrate existing data.
- Run canonical gates and independent implementation review; no existing expectation is weakened.
- Repeat AR-003 on an identified rebuilt coordinator through Gateway targeting `windows-pc`,
  retaining the exact source/build identity and direct evidence required by all four steps.
  Require one successful audit for the same original dispatch ID, observed FIFO head, no receipt
  failure or duplicate execution, original budget, and ready health afterward.
- Until that live run passes, keep AR-003 and LT-712 open as a technical implementation
  prerequisite. Repeating resets on an unchanged unobservable build cannot supply the missing proof.
<a id="lt-710"></a>

## LT-710 — fresh-profile app startup can collide with the context worker's migrations

Additional reproduction, 2026-10-27 worker auto-update campaign. This is the same defect already
recorded by the saved-login/automation campaigns in the root checkout's active remediation
follow-up and by the housekeeping worker. Preserve that ownership and its newer implementation
status when integrating; this branch contains no database fix.

### Observed behaviour

The freshly built app, using only `/tmp/aio-lt-queue-d4bee785`, failed at `Work controls` at
`2026-10-27T14:19:24.056Z` with `Failed to apply migration "001_add_optimized_indices": UNIQUE
constraint failed: _migrations.name`. It never created a renderer on that attempt. A subsequent
launch using the same worker-owned profile reached the real renderer and preload at
`2026-10-27T14:21:56.707Z`; focus emulation was enabled and two animation frames completed.
Receipts: `evidence/2026-10-27-worker-auto-update/startup-migration.txt` and `dev-result.json`.

### Root cause investigation

The executing stack enters `initializeGlobalPauseRuntime` (`global-pause-bootstrap.ts:22`),
then `RLMDatabase.initializeDatabase` (`rlm-database.ts:148`) and `runMigrations`
(`rlm/rlm-schema.ts:284`). Applied migration names are read before the write transaction
(`rlm-schema.ts:289-317`); the context worker also opens the same profile's database
(`instance/context-worker-main.ts:157`). Concurrent stale discovery is consistent with the
observed duplicate row. This run did not capture the exact interleaving or independently verify
the housekeeping worker's fix.

### Required behaviour

Concurrent normal database owners must apply every migration once on first startup and reach
the renderer. Checksum mismatches and genuine migration SQL errors must remain visible.

### Acceptance and implementation status

The existing LT-710 owner must verify a deterministic two-owner regression, checksum rejection,
SQL rollback/retry, native concurrent owners and fresh-profile app startup, then complete the
normal gates and independent review. No new human authority is needed for that isolated work.
The matching status is already recorded under LT-710 in the root-owned active
`2026-07-19-livetest-failure-remediation-followup_plan.md`; the historical `_completed` July plan
is left unchanged. This campaign adds reproduction evidence only and does not duplicate the fix.

<a id="lt-709"></a>

## LT-709 — installed runtime provider packages fail before registration in the compiled app

**Status: OPEN; reproduced 2026-10-26; no remediation implemented.**
Origin: the custom-provider proof required by
[Plugins cleanup Phase 1](2026-10-26-plugins-cleanup-and-global-connectors_plan_completed.md#phase-1-plugins-page-cleanup).
That phase explicitly permits recording a failed proof and omitting the custom-provider claim;
this entry does not turn that proof into a completed feature or expand its implementation scope.
Implementation status: [active remediation follow-up](2026-07-19-livetest-failure-remediation-followup_plan.md#lt-709).

Numbering note: LT-708 is already reserved by the active remediation follow-up's LT-707/LT-708
reconciliation, although this checkout's register still ends at the older benchmark LT-707.
LT-709 avoids a collision when that separate work lands; existing entries are unchanged.

### Observed behaviour

A disposable package declaring `slot: provider` and `isolation: worker` installs successfully
through the compiled `PluginPackageManager`. Its manifest loads and validates, but activation
through the compiled `OrchestratorPluginManager` and real `PluginWorkerHost` fails during
instantiation:

```text
Cannot find module 'file:///<repository>/packages/sdk/src/provider-adapter-worker-bridge.ts'
Require stack:
- <repository>/dist/main/plugins/plugin-worker-host.js
```

The resulting report has `pluginLifecycle: failed`, `ready: false`, an empty creatable provider
registry, and `providerListIncludesPackage: false`. No assistant response is produced. Independently,
the compiled `InstanceCreatePayloadSchema` rejects the fixture's `provider: 'plugin:proof'` because
its provider enum contains only built-in providers and `auto`.

The probe uses the real compiled package, manager, worker, registry and provider-manager code;
only Electron host/settings/logging objects are replaced. It uses a disposable home and package,
opens no window, reads no credentials and starts no AI-provider process. Re-running
`rtk proxy node _scratch/plugins-connectors-provider-runtime-probe.cjs` exits 1 at the assertion
that the package appears in the provider list. This is a reproduced failure, not a passing gate.

Evidence (read and independently rerun 2026-10-26):

- [Runtime report](../../_scratch/plugins-connectors-provider-runtime-report.md).
- [Synthetic load report and schema rejection](../../_scratch/plugins-connectors-provider-runtime-evidence.json).
- [Reproduction fixture](../../_scratch/plugins-connectors-provider-runtime-probe.cjs) and
  [failing command output](../../_scratch/plugins-connectors-provider-runtime-command.log).
- The observed error and result fields above are retained here because `_scratch/` is disposable.

### Root cause

`src/main/plugins/plugin-worker-host.ts:159-162` dynamically imports the SDK bridge as a file URL.
The CommonJS main build (`tsconfig.electron.json:4`) emits that expression as
`Promise.resolve(fileURL).then(s => __importStar(require(s)))` in
`dist/main/plugins/plugin-worker-host.js:85`. CommonJS `require` cannot load that `file://` URL.
`startWorkerRuntime` calls this loader before the helper, package factory or adapter registration
(`src/main/plugins/plugin-worker-host.ts:535-543`), so the observed worker failure prevents any
provider registration. The helper and plugin-module imports have the same emitted transformation
(`dist/main/plugins/plugin-worker-host.js:94,395`); correcting only the first import is insufficient.

The bridge resolver also walks from `dist/main/plugins` to repository source
`packages/sdk/src` (`src/main/plugins/plugin-worker-host.ts:149-155`), rather than the emitted
`dist/packages/sdk/src`. A packaged build must resolve its shipped SDK; missing packaged files
have not been independently reproduced here.

The provider-list wiring is real: `PROVIDER_LIST` calls `getAllConfigs`
(`src/main/ipc/handlers/provider-handlers.ts:53-57`), which includes only creatable registered
plugin providers (`src/main/providers/provider-instance-manager.ts:123-129,428-429`;
`src/main/providers/provider-adapter-registry.ts:106-111`). The normal session-create boundary
separately validates the built-in-only provider enum before creating an instance
(`packages/contracts/src/schemas/instance.schemas.ts:39,188`;
`src/main/ipc/handlers/instance-handlers.ts:92-100`).

One further source-backed concern was not reached by this failing worker: the manager selects
hook/notifier/tracker/telemetry runtime proxies but has no provider case, then requires that
selected runtime for readiness (`src/main/plugins/plugin-manager.ts:454-464`). This is not claimed
as a separately reproduced runtime failure.

### Required behaviour

Compiled and packaged workers must load the shipped SDK, helper and plugin modules correctly.
A provider-slot package must report truthful readiness, appear in the provider list, and answer
through a supported user-facing session path. Plugins and Help must omit custom-provider support
until the complete route is proven. The Phase 1 wording follows that restriction while this item
remains open.

### Acceptance

- Reproduce install, successful activation/readiness, provider-list visibility, session
  initialization and an actual assistant response against compiled output in a disposable profile.
- Verify the packaged SDK/helper loads without depending on repository source files.
- Exercise the ordinary session-create IPC route with the plugin provider, or explicitly implement
  and expose another supported user-facing session route; a registry-only response is insufficient.
- Verify unregister, uninstall and worker cleanup after a successful response, and truthful failure
  reporting for an invalid package.
- Add source and compiled-worker regressions so source/tsx-only tests cannot hide another build
  transformation failure, then run the canonical gates and the originating provider proof.

<a id="lt-722"></a>

## LT-722 — Plan Queue triage cannot find its reporting tool

**Status: OPEN; reproduced 2026-10-27; no remediation implemented.**
Origin: [Plan Queue step-up live checks](2026-10-27-plan-queue-stuck-worker-step-up_plan_livetest.md#evidence-run--2026-10-27),
first LT-SU-3 attempt. Not caused by the step-up change: triage runs before any worker.
Implementation status: [active remediation follow-up](2026-07-19-livetest-failure-remediation-followup_plan.md#lt-722).

### Observed behaviour

Run `35edd9c1-1d5c-4afc-a276-1e623e9611eb` in the disposable repository `/tmp/stepup-live-off`
(one plan, started 15:34 UTC by a one-time automation) parked its only document as
`triage-failed`: "it ended without answering (Claude), then it ended without answering (Codex)".
The Claude triage transcript (`claude-cli-profiles/*/projects/-private-tmp-stepup-live-off/294c6e0e-….jsonl`)
shows it calling Claude's native `ToolSearch` with `select:plan_queue_report_triage`, then
`plan queue triage report`, then `plan_queue`, each returning no match, and ending with
"I couldn't submit the triage. The `plan_queue_report_triage` tool isn't available in this session."
It never called `orchestrator_tool_search`, where the tool is listed. Two other triage runs the
same afternoon (`/tmp/stepup-live`, `/tmp/stepup-live-off2`) did report, so the failure is
intermittent and depends on how the agent searches.

### Root cause

`buildTriagePrompt` (`src/main/plan-queue/plan-queue-prompts.ts`) tells the agent to call
`plan_queue_report_triage` but, unlike `buildVerifierPrompt` and `buildVerifierReminderPrompt`,
does not include the discovery steps (`VERDICT_DISCOVERY_STEPS`: use the provider's discovery
mechanism to find `orchestrator.tool_search` / `tool_describe`; native tool search alone is not
enough). The tool is a deferred Harness tool, so an agent that only searches its native list
cannot find it.

### Required behaviour

The triage prompt carries the same discovery route as the verifier prompt, naming
`plan_queue_report_triage`, so a triage agent on any provider finds and calls the tool, and
reports a discovery failure with the exact tool error rather than ending silently.

### Acceptance

- A prompt regression test asserts the triage prompt contains the discovery steps for
  `plan_queue_report_triage` before its task line.
- A live triage run on Claude in a disposable repository reports through the tool on its first
  attempt; repeat until three consecutive runs report without a retry.


## LT-723 — shared queue checks try an unnecessary npm install through the wrong environment

Origin: [batched checks installed-app procedure](2026-11-02-plan-queue-batched-checks_livetest.md#evidence-follow-up--2026-11-04-balanced-rerun-failure).
Implementation notes: [verified source repair](2026-11-04-plan-queue-check-copy-provisioning_plan_completed.md). The index row owns status.

### Observed behaviour

Installed run `557b9f7f-3127-436c-b6e4-33ed0bf04b68` used three workers, one effective check slot and batch size four under Balanced Workload. Epsilon was being checked while delta and zeta waited together. Delta then parked as `worktree-error`: `Could not run Harness checks: Command failed: npm ci` followed by `/bin/sh: npm: command not found`. Epsilon and zeta passed separate checklists and landed; the end notice reported two test runs covering two jobs, not a successful shared check.

The disposable project has a scripts-only package manifest, built-in Node tests, no external dependencies and no npm lockfile. The same source-runtime call against that fixture with PATH limited to `/usr/bin:/bin` reproduced the exact npm-not-found error before the fix. Evidence is retained in `_scratch/batch-live-provisioning-fix/runtime-red.json`. The real run's parent report, snapshots and restoration evidence are under `_scratch/batch-live-20261104/balanced-retry/`. Workload was restored from 3 to its original 5 and read back. Delta's branch and work remain preserved; it has not been force-landed or discarded.

### Root cause

At reproduction, `PlanQueueCheckGroups.run` called the combined-copy path in `PlanQueueWorktreeService`. `withPlanQueueCombinedCopy` called `provisionPlanQueueCheckCopy`, which always supplied `installCommand: 'npm ci'`. The shared `provisionNodeModules` fallback treated any package manifest as requiring an install when no modules could be copied, even if it contained only scripts and no setup requirements. Its `child_process.exec` call inherited the raw app environment, whereas queue gate and readiness commands use `buildCliEnv()` to discover the installed Node/npm paths. The combined-copy failure propagated before shared receipts could be produced. Individual worker-worktree provisioning catches/logs its error, explaining why ordinary checks could still pass.

The missing npm command is the observed failure. The lockless fixture also makes unconditional selection of `npm ci` inappropriate by source contract; this entry does not claim the same live run reached a separate lockfile rejection.

### Required behaviour

- Skip automatic package installation for a genuinely dependency-free scripts-only project, including base and combined queue copies; preserve explicit custom setup commands.
- Keep required setup for dependencies, workspace packages, lifecycle scripts and implicit native setup. Preserve existing root-module cloning, workspace-link isolation and native-binary checks.
- Select `npm ci` only for an npm lockfile/shrinkwrap; otherwise use the existing supported install default. Launch real install commands with the same discovered CLI environment as gate/readiness commands.
- Surface real setup failures, preserve the parked job's work, and remove failed temporary copies through the existing ownership-proven cleanup. Do not bypass review or landing gates.

### Acceptance

1. The source runtime provisions the original dependency-free fixture successfully under the same stripped PATH without creating modules, lockfiles or tracked changes.
2. Regressions cover installation-enabled combined/base copies, lock/shrinkwrap selection, lockless dependency setup, lifecycle/workspace/native requirements, explicit custom commands, a discovered npm path, and surfaced install failures. Existing clone/isolation/native and cleanup tests remain intact.
3. Focused tests, all canonical project gates and a genuinely fresh independent completion review pass before the fixing plan is closed.
4. A rebuilt installed-app rerun meets the waiting-group prerequisite, completes the shared checklist without parking its leader for this error, retains independent reviews and own-HEAD/shared-tree receipts, and records actual checklist/job totals, temporary-copy cleanup and Workload restoration in the owning live-test document. A lone resumed delta is recovery evidence, not proof of batching.

## LT-724 — successful grouped checks are lost before a later member's independent review

Origin: [installed batching evidence](2026-11-02-plan-queue-batched-checks_livetest.md#evidence-follow-up--2026-11-05-real-group-with-lost-later-member-reuse) and [provisioning retest](2026-11-04-plan-queue-check-copy-provisioning_livetest_completed.md#evidence--2026-11-05-real-shared-check-and-later-member-recheck).
Implementation notes: [verified receipt-reuse repair](2026-11-05-plan-queue-group-receipt-reuse_plan_completed.md); [installed retest](2026-11-05-plan-queue-group-receipt-reuse_livetest_completed.md). The index row owns status.

### Observed behaviour

Installed run `62cd9771-061f-4c40-bf3a-bf153c83c33a` used Balanced Workload, three workers, one effective check slot and batch size four. Theta occupied the slot while eta and iota waited together. At `01:18:04.471Z`, a real checklist event named both eta and iota in group `5c57aac4-d2ec-4a28-9fe6-4416e3b93f2d`. Eta's persisted PASS receipt has own HEAD `b29c41d16ccdc1d603bd9803d494e581b38f4c56`, tested tree `7c5daffed145db620a0724e205ba6162274c7319`, group base `10c1dfaebd1d718858a8ca6026a4219fa7c08531` and both member IDs. The successful Node checklist output includes both members' tests.

Eta landed at `01:20:51.005Z`. Iota entered verification at `01:20:51.707Z` and started another, solo checklist at `01:20:52.480Z`. Its final PASS receipt uses HEAD `93c6941fea05af7b27ef0718bfb210a81b0bb7a2`, tested tree `83f70328d726ddf3bb0289710e1ba7f228ef544f` and no group. All three jobs landed without fixes, but three checklist events covered three distinct jobs; the intended saving was lost. This corrects the fixture parent's inference that no batch occurred: persisted rows prove a real combined check, followed by unnecessary later-member rerun.

Exact run/item/event/verdict rows, parent snapshots and restored Workload evidence are retained under `_scratch/batch-live-20261104/installed-retest-20261105/`. Workload was restored to 5. Earlier parked delta remains outside this repair's mutation scope.

### Root cause

The source investigation recorded in the active repair plan identifies synchronization before receipt lookup: after eta lands, synchronizing the waiting checkout changes its HEAD/base and the strict ordinary cache correctly misses. The existing moved-base group proof expects the current member's independent PASS, unavailable before that member's checker runs. Checker startup also records current main rather than necessarily the original checked base. Reusing machine evidence before synchronization therefore requires separate checked-base provenance; skipping landing synchronization or fabricating an independent PASS would be incorrect. The source diagnosis and repair are verified in the linked source plan; installed acceptance passed on 2026-11-06.

### Required behaviour

- Reuse successful exact-round grouped machine receipts for a waiting, unchanged member when current main contains only proven unchanged group-member landings since the tested base.
- Revalidate commits/checkpoints, commands, document/source identity, cleanliness, group history and active state; unrelated changes, invalid proof or changed work require fresh checks.
- Keep each member's independent checker and verdict. Machine receipts are not an invented independent PASS.
- Retain the actual checked base, mandatory serialized synchronization/checkpointing at landing, conflict handling and final proof revalidation. Preserve limits, lifecycle cancellation/cleanup and bounded memory ownership.
- Preserve parked work and all unrelated state; never force landing or weaken the exact ordinary receipt cache.

### Acceptance

1. A real temporary-Git production-flow reproduction checks one solo job and one pair, lets the first pair member independently pass and actually land, then admits the second. Exactly two checklist executions cover three jobs, with own HEADs and shared group/tested tree for the pair; the second member still synchronizes/checkpoints at landing.
2. Meaningful regressions reject unrelated base changes, changed/dirty work, changed commands/source, departed rounds, holds/pauses/cancellation and proof errors. No current-member PASS is fabricated; review/document checks stay separate.
3. Actual runtime verification precedes regression updates; focused tests, all canonical gates and a fresh independent completion review pass before the source plan closes.
4. A rebuilt/restarted installed rerun proves both grouped receipts survive sequential independent reviews/landings, records actual savings and cleanup/restoration, and meets the owning live-test documents' remaining acceptance. Source proof alone does not close installed acceptance.

## LT-725 — automatic code context is still mostly irrelevant on real messages

**Observed:** on the rebuilt app, from Claude session transcripts between 10:03 and 13:02 on 6 November 2026, 12 of 34 real messages got an `[Indexed Codebase Context]` block, most at the full 3,790 characters. Two were clearly relevant, for example `yeah keep the 5 minute check in` got `instance-async-work-continuation.ts`. Eight were unrelated: `This looks interesting to us.` got `docs/plans/completed/copilot_completed.md`, `Why would do that? It's a shared resource!?` got `configurationRepository.ts`, and a request to commit and close cards got a `.tap` evidence file. Two automated prompts got a file from `tmp/tsx-501`. A sample from before the upgrade was as poor, and included `yeah send that please.` getting a WordPress `moxie.js`, so this is an old defect that item 2 of the search repair only partly fixed. A later message, `How about putting those message into this session?`, got the same `node-failover.ts` chunk twice, matched on the words `putting` and `session`, so the block can also repeat a result. The check 6 prompt `what is a good recipe for sourdough` got a full-size block from `docs/plans/completed/loop-library-borrow_notes_completed.md`, matched on `good` and `recipe`, which is the clearest single reproduction.

**Root cause:** `isStrongMatch` in `src/main/codemem/code-search-query.ts` accepts any two informative words covering half the query, so a short remark with two everyday words qualifies. The stop list covers filler words, not ordinary vocabulary. `classifyFileKind` also treats unknown extensions and files in cache, build and archive folders as source. The earlier evaluation measured whether the right file was found for commit descriptions, not whether unrelated messages stayed quiet.

**Required behaviour:** automatic context stays quiet unless the message is about code in that workspace. It must not add scratch, cache, build-output or archive files, or plan documents, on a conversational message.

**Acceptance:** build a labelled set from real messages, including ones that should get nothing, and show a large fall in unrelated code without harming ordinary search. Check 3 in the live-test document then passes on the rebuilt app. The first version of this entry asked for 80% relevant. That was set before any labels existed, and no keyword rule tried came close: the fix reached 52% for the top result, with short messages getting unrelated code falling from about 70% to about 6%.

## LT-726 — Linux package build fails in the fuses hook

**Observed:** building commit f15d20a2b with `electron-builder --linux dir --x64` in a `node:24-bookworm` container on 6 November 2026 exited 1 with `ENOENT: no such file or directory, open '/work/out/linux-unpacked/Harness'` at `scripts/set-electron-fuses.js:55`. The `--linux AppImage` jobs in `.github/workflows/release.yml` use the same hook. `gh run list` shows no run of that workflow, so no Linux release has exercised it.

**Root cause:** `scripts/set-electron-fuses.js:45` builds the Linux path from `appInfo.productName`. electron-builder names the Linux binary from the lower-cased package name unless `linux.executableName` is set, so the file is `harness`. The script has not changed since May 2026, so this predates the search repair.

**Required behaviour:** the hook hardens the binary electron-builder actually produced on every platform, and a Linux package completes with its fuses set.

**Acceptance:** `electron-builder --linux dir --x64` succeeds in a clean container, the fuses read back as set on the Linux binary, and a regression test covers the Linux path.

**Verified 2026-11-06:** with the fix, `electron-builder --linux dir --x64` exited 0 in a clean `node:24-bookworm` container. RunAsNode, EnableNodeOptionsEnvironmentVariable and EnableNodeCliInspectArguments read back as disabled and OnlyLoadAppFromAsar as enabled on `harness`. `scripts/__tests__/set-electron-fuses.spec.ts` covers all three platforms. An AppImage has not been built.

<a id="lt-727"></a>

## LT-727 — Microsoft 365 connector refused every tool call

**Observed:** on 6 November 2026 a session reported the Community Tech connector refused every request and sent mail through the IMAP connection instead. Calling `graph_mail_list_folders` from a Claude session on `m365-communitytech` and `m365-fortitude` both failed with `unrecognized_keys` for `_meta`. The same call sent straight to the running app worked without `_meta` (10 and 8 folders) and failed identically with it, so sign-in and Microsoft Graph were healthy.

**Root cause:** the `tools/call` branch of `dispatchConnectorRpc` in `src/main/mcp/connector-rpc.ts` parsed the request params with a strict schema allowing only `name` and `arguments`. MCP allows `_meta` in request params, and `ConnectorForwarder` passes params through unchanged. `list_automations`, which has an equally strict arguments schema, succeeded from the same session, so the field is in the params rather than the tool arguments.

**Required behaviour:** connector tool calls succeed when the client adds protocol fields, those fields never reach the tool, and each connector stays bound to its account with its write and approval checks unchanged.

**Acceptance:** after a rebuild and restart, a new Claude session and a new Codex session each list folders through `m365-communitytech` and `m365-fortitude` using the ordinary connector tools. A regression test in `connector-rpc.spec.ts` covers the `_meta` call. Check 3 in the [owning live-test document](2026-10-26-plugins-cleanup-and-global-connectors_livetest.md) stays open for the rest of its steps.

<a id="lt-732"></a>
## LT-732 — a warm Claude process bypasses a sidechat's inherited tool denials

**Status:** fixed on main. Live-checked 2026-11-07 on the pre-merge branch build; re-verify after landing. Pending independent verification.
Origin: session-sidechats live test, LT-SC-5. Original observation retained below.

### Implementation status — 2026-10-27, queue round 2

`InstanceSpawnPreflightChain.prepare` now refuses a warm process when the requested spawn has
allowed tools, disallowed tools or a permission hook. The existing fresh-spawn path keeps the
requested options intact. Three new admission regressions failed against the original code and
pass with the guard. No provider metadata or inherited policy was broadened.

Live: at 08:19:38 UTC a matching Claude workspace warm process was ready. A high-effort Plan-parent
sidechat subsequently spawned fresh (`cm9jt7owm`), reported Write unavailable, and created neither
blocked.txt nor high-blocked.txt. The authority inspector retained write=deny. The YOLO-off live
probe replaced the runtime and paused a harmless Bash operation for approval before execution.
Full command receipts and per-check provenance remain in the coordinator-owned live-test document.

### Live status — 2026-11-07 (queue resume, pre-merge branch build)

Build, production renderer build, `tsc --noEmit`, `typecheck:spec` and the focused specs for the
changed areas all pass on this branch. In an isolated dev profile, a restricted Plan parent's
sidechat set to Opus with high effort spawned a fresh runtime (`cd20whylw`, no warm-start log line),
reported that its Write tool was unavailable, and created no file. Evidence:
the owning live-test document, section 2026-11-07.

Not reproduced in this run: the warm-adoption bypass itself. `preWarm` skips every warm spawn while
`providerSignalFenceEnabled` is off (`src/main/instance/warm-start-manager.ts`), and the fence cannot
start under the nested sandbox used for this run. A warm candidate therefore never existed. Rerun the
warm step on a host where the fence can start.

### Observed behaviour

In the isolated dev app, a real Claude/Sonnet sidechat of a built-in Plan parent reported
`toolPermissionsOverride.write = deny`. Its inspector said Editing files: blocked, and its
metadata denied Edit, Write and NotebookEdit. Nonetheless runtime `cp0gq0hg3` made a successful
Write call and created `restricted/blocked.txt` containing `BLOCKED_WRITE_TEST` (18 bytes).
The provider reported that writing was not blocked. No permission was approved by the worker.
At `2026-10-27T07:38:40.104Z` the app logged `Using warm-start adapter (skipping spawn)` for that
runtime. A second warm adoption occurred for the YOLO-off replacement `cejsp2sds` at 07:40:03.127Z.
Evidence receipts and the log excerpt are linked from the owning live-test document.

### Root cause

`instance-manager.ts:267-282` pre-starts adapters with workingDirectory and the default reasoning
effort, without the eventual instance's authority. `instance-lifecycle.ts:1650-1692` constructs
correct allowedTools, disallowedTools and permissionHookPath, then discards those spawn options
when `InstanceSpawnPreflightChain.prepare()` returns a warm adapter. Its admission predicate
(`instance-spawn-preflight-chain.ts:82-102`) checks YOLO/hardening/model/node and other launch
properties, but does not compare inherited tool denials or the permission-hook configuration.
The Instance metadata therefore describes a policy the adopted process never received.
This extends the class previously seen in LT-528/LT-539 to tool-category enforcement.

### Required behaviour

A warm process is reusable only when its launch-bound authority matches the requested session.
Otherwise spawn fresh with all inherited denials, approval hooks and runtime settings. Do not
repair this by changing metadata, adding prompt-only restrictions or broadening the parent.

### Acceptance

Reproduce with an already warmed Claude workspace and a Plan-parent sidechat. The real process
must be unable to call Write/Edit/NotebookEdit and no file may be created. Test admission through
the actual adapter wiring, plus policy refresh with a warm candidate. Rerun LT-SC-5, the applicable
LT-SC-8 approval operation and canonical gates, then obtain independent verification.

<a id="lt-733"></a>
## LT-733 — an approval arriving while the sidechat panel is closed cannot be answered on reopen

**Status:** fixed on main. Live-checked 2026-11-07 on the pre-merge branch build; re-verify after landing. Pending independent verification.
Origin: session-sidechats live test, LT-SC-4. Original observation retained below.

### Implementation status — 2026-10-27, queue round 2

The startup-created renderer IPC event bus retains unresolved runtime payloads and deduplicates
them before delivery. Resolution, instance removal, exit and invalidating runtime generations
clear only their owning requests. UserActionRequestComponent projects these payloads into cards
on mount and selection changes; it no longer owns their lifetime. Successful replies dismiss the
instance-qualified request. Regression coverage includes sibling ID collisions, stale generations,
resolved requests, closed panels, failed list loads and preservation of secret-card behaviour.

Live: `csenln0jb` requested `printf LATE_PANEL_APPROVAL` while the panel was absent. Reopening,
closing and reopening again showed one matching Permission Required card. Allow once produced the
actual shell marker, cleared the card and left the parent's transcript byte-for-byte unchanged.
The separate YOLO-off sidechat approval was scoped to `c2kovytrk`, not its parent.

### Live status — 2026-11-07 (queue resume, pre-merge branch build)

With the sidechat panel closed, runtime `co6pxphji` asked for Bash `printf LT_SC4_CLOSED_PANEL_MARK2`.
The rail and parent row showed Awaiting approval. Reopening the panel showed one Permission Required
card for that runtime with Allow once. Allow once ran the command, the tool group recorded 25
characters, and the runtime returned to Idle. The parent had no messages before the approval.
Evidence: the owning live-test document, section 2026-11-07.

### Observed behaviour

A real Claude/Sonnet sidechat requested Bash for `printf PANEL_APPROVAL_CHECK` while its panel was
closed. Runtime `ctbmo0hvo` entered waiting_for_permission. Its parent badge and rail showed Needs
action. Reopening chat `a8e329cf-04c2-4de0-be00-db312d6e9643` showed the Bash tool call and Needs
action, but no Permission Required card or Allow button. The mounted component's pendingRequests
was empty; `listUserActionRequestsForInstance`, permissionRegistryListPending and the permission
batch query also returned no pending requests for the supported owners queried.

Control: a fresh low-effort Claude sidechat with the panel continuously mounted (`cmeocyck4`)
showed its actual request, Allow once executed `printf OPEN_PANEL_APPROVAL`, and the parent
transcript was unchanged. This rules out absence of approval support and focus/rendering issues.
Both probes had CDP focus emulation enabled; no forced Angular rendering was used.

### Root cause

`user-action-request.component.ts:145-180` consumes CLI input-required events while mounted.
The cached CLI requests are in a component-owned Map (`getCachedInputRequiredForInstance`,
lines 321-330). `loadPendingRequests` (280-317) merges that map with server-side user action
requests, but this CLI hook request was absent from the server list. A newly mounted component
has neither the old event nor the old component's map, so the runtime's waiting state survives
without the actionable UI. The sidechat panel itself is created/destroyed on close/reopen.

### Required behaviour

Unresolved CLI approvals must outlive the panel and be recoverable for the exact runtime.
Reopen, session switching and late mounting must restore them; resolution, replacement and
cancellation must remove them without transferring grants to the parent or another sidechat.

### Acceptance

Ask a harmless approval-gated command with the panel closed; reopen via Needs action and approve
it in that conversation. Also exercise open-panel delivery, close/reopen of an existing card,
resolution deduplication and runtime replacement. Preserve parent isolation. Keep original
LT-SC-4 uses a harmless Bash operation: ordinary Write remains auto-approved by the established
acceptEdits convention. This reconciles the test example without changing product permissions.

<a id="lt-734"></a>
## LT-734 — archived parent rows omit a persisted unread sidechat after restart

**Status:** fixed on main. Live-checked 2026-11-07 on the pre-merge branch build; re-verify after landing. Pending independent verification.
Origin: session-sidechats live test, LT-SC-3. Original observation retained below.

### Implementation status — 2026-10-27, queue round 2

Both archived-row presentations now use HistorySideChatBadgeComponent, keyed only by the stable
history thread. Live and archived rows share badge priority and wording. Archived requests open
SideChatPanel under their original parent, retaining the existing focused/visible/bottom-of-answer
read acknowledgement. The previous fallback to the main chat view did not acknowledge sidechat
reads; the live round reproduced that extension and the dashboard regression now covers it.
The archived override resets on another selection or panel closure and never restores its parent.

Live: a normal isolated-app restart preserved all 17 selected ledger messages by ID, sequence,
role and content, with zero live or attached runtimes. Both history presentations showed the
unread badge for the archived toggle parent. Clicking its sidebar badge opened exactly
`832289e4-80a6-4a05-a15a-1b9a26b95738` with the correct parent/title, closed the overlay and left
live runtime count at zero. Viewing the answer at the focused bottom cleared unread to zero.

### Live status — 2026-11-07 (queue resume, pre-merge branch build)

An unread answer (chat `70b32294…`) was stored under parent `ctbh51ewx`. After that parent was
terminated, its History sidebar row and project-history row both showed the unread badge. A normal
SIGTERM shutdown and relaunch on the same profile kept unread=1 on the same chat, with zero live
runtimes and no spawn or send in the restart log. The History badge opened the exact chat, which
contained `RESTART_UNREAD_OK`, and unread cleared to 0. Evidence: the owning live-test document,
section 2026-11-07.

### Observed behaviour

A real Codex sidechat completed an unopened answer ending RESTART_UNREAD_982. A normal SIGTERM
shutdown exited 0, and the same isolated profile was relaunched. The six ledger messages were
identical by id, sequence, role and content; unread=1 survived, the rail showed 1 need a look,
and no runtime or resend appeared. However the standalone parent was now archived. Its project
history row and the History sidebar row showed no sidechat unread badge. A DOM inspection found
only the rail's sidechat button, while both parent history rows were rendered.

### Root cause

The live row has the sidechat badge (`instance-row.component.html:128`). The project history
row in `instance-list.component.html:424-600` renders history entries separately without a
sidechat attention binding. `history-sidebar.component.ts` consults SideChatStore for deletion
wording, but does not render sidechat attention on its history rows. Normal restart removes the
live parent row, leaving neither archived representation with the expected badge.

### Required behaviour

Render and route persisted sidechat attention by stable parent history identity on archived
rows as well as live rows. Opening the badge must select the exact unread conversation without
reviving or resending work to the parent.

### Acceptance

Restart with an unread answer under a standalone session. Verify unread and the exact target on
both the rail and parent history row, no provider resend, and badge clearing only after viewing.
Cover both existing history row presentations and rerun LT-SC-3 live.

<a id="lt-735"></a>
## LT-735 — sidechat policy reads the supervising worker instead of the execution location

**Status:** fixed on main. Main reads `executionLocation` in the sidechat parent resolver (`src/main/chats/side-chat-parent-resolver.ts`). Not live-checked on the merged build.
Origin: session-sidechats live test, LT-SC-7 (Windows workspace routing).

### Observed behaviour

On the pre-merge branch the Windows routing check could not pass. The sidechat's authority and parent resolution take the node from `workerNodeId`, which the instance type defines as the worker node in the supervision tree (`src/shared/types/instance.types.ts:419`). Where the CLI actually runs is `executionLocation` (`instance.types.ts:615`). A parent running on a Windows worker therefore gets a sidechat treated as local, so it tries to spawn in the Windows path. This is established by reading the source. The branch was not run against a live disposable Windows worker.

### Root cause

`src/main/chats/side-chat-authority.ts:109` sets `workspaceNode` from `instance.workerNodeId`. `src/main/chats/side-chat-parent-resolver.ts` sets `originNodeId` from `workerNodeId` at lines 109, 121, 165, 200 and 220. Only `src/main/chats/side-chat-service.ts:660` reads `executionLocation`.

### Required behaviour

Sidechat policy, parent resolution and renderer parent references use the node where the parent executes. A forced worker that is unavailable is refused with an explicit error and makes no local spawn.

### Acceptance

On a connected disposable worker, a Windows-path parent's sidechat answers from the parent's Windows directory with a matching remote execution location. Then disconnect only that disposable worker and send again: the send returns the explicit forced-worker refusal and makes no local adapter spawn. The production worker must not be touched. Rerun on this branch after the fix is landed.

## LT-997 — shared-tab native named keys have no default effect

**Status: OPEN; repaired in local 0.2.45; Windows acceptance pending.**
Origin: browser input controls live-test checks 1 and 4. Implementation status is in the
root-owned active [remediation follow-up](2026-10-27-browser-input-controls-remediation_plan_completed.md).
Evidence: [campaign receipts and report](2026-10-27-browser-input-controls_evidence/REPORT.md).

### Observed behaviour

On the real Windows shared tab, repeated Tab and Shift+Tab returned `applied: true` but kept
focus on `#harmless-link`; focusing `#first` first produced the same failure there. The orange
4px focus indication remained visible and the page was not hidden. Enter on the same link,
with an informative harmless hint and `expectUrlChange: true`, failed `browser_click_no_effect`.
The fixture server received zero activations from both distinct Enter attempts. Ordinary
`browser.click` on the same link subsequently navigated and incremented the server counter once.
The grant rows for both Enter attempts read `auto_approved_by_yolo_mode`, checked read-only.

Trusted native event observations show virtual key codes 9/16 but empty `key` and `code`,
`isTab: false`, no cancellation, and correct Shift release. A same-key retry of the failed
Enter returns `deduplicated: true`, `applied: false`, outcome `failed`, reason
`press_key_prior_attempt_outcome_unknown`; this safety behaviour passes and must be preserved.

### Root cause investigation

Executing path: service `pressKey` delegates through `browser-input-control-operations.ts` to
the extension `press_key` command. `dispatchNamedKeyWithModifiers` in
`resources/browser-extension/background.js:3114-3145` sends virtual key codes without the named
`key` or physical `code` fields. The observed empty event identity matches that payload. This
localizes the failure to native dispatch/default behaviour, not policy refusal or a broken link.
A corrected-payload Windows comparison has not been run; the final repair is not claimed proven.
The existing mocked controls/classifier/credential-boundary tests still pass.

### Required behaviour

Native Tab and Shift+Tab traverse actual focusable controls; Enter activates the approved
harmless link. Read-back names the resulting focus without field values. Modifiers always
release. Effect-checked failures remain honest and retries never duplicate activations.

### Acceptance

- Run owning checks 1 and 4 on a real Windows shared tab after the repair, including a successful
  first activation, a duplicate with exactly one total activation, and a deliberate new-key press.
- Cover the actual named-key dispatch identity and real default effects, rather than only the
  presence of CDP calls in a mock. Preserve failed-outcome dedupe and credential/action gates.
- Run the canonical verification gates and independent review before claiming a fix.

## LT-998 — tab viewport emulation does not survive its command

**Status: OPEN; repaired in local 0.2.45; Windows acceptance pending.**
Origin: input controls check 2. Status: [active follow-up](2026-10-27-browser-input-controls-remediation_plan_completed.md).
Evidence: [campaign report](2026-10-27-browser-input-controls_evidence/REPORT.md), receipts 004/009.

### Observed behaviour

From 2558×1270, the first 768×1024 set returned `mode: tab_emulation`, requested and actual
768×1024, but reported emulation width/height zero. The next visible page read was 2558×1214,
tablet media query false, menu hidden, and table client/scroll widths both 2506. The menu
selector click toggled its expanded state while hidden, so it is not accepted as a tablet
interaction pass. Attempting horizontal scroll returned scrollLeft zero at desktop width.
The second set already reported actual 2558×1270 against requested 768×1024 while returning
success and tab_emulation. A subsequent ordinary snapshot independently showed desktop
dimensions. No whole-window resize was used to substitute for tab emulation.

### Root cause investigation

`setTabViewportState` in `resources/browser-extension/background.js:3253-3291` sets metrics in a
short `withDebugger` session. `attachAndRunDebugger:2806-2827` always detaches that session;
there is no retained per-tab viewport session/baseline. The override's loss after command end
is consistent with that lifecycle. `readTabEmulation:3239-3250` additionally sends
`Emulation.getDeviceMetricsOverride` and silently converts errors to inactive/zero metrics.
These are source-backed causes to investigate; no instrumentation of the worker's detach
boundary or corrected-session comparison was performed. Do not treat the returned mode as
proof of persistent emulation.

### Required behaviour

Tab emulation remains at the requested CSS dimensions while subsequent Gateway calls inspect
and operate the responsive layout. Read-back reports actual state accurately; failed application
must not be described as a successful matching viewport. Reset restores the real baseline.

### Acceptance

- Owning check 2 passes: verified 768×1024, operable collapsed menu, actual table overflow/scroll,
  and reset to original dimensions, all on the same Windows tab.
- Include cross-command and debugger-detach coverage, including a mismatched application result.
- Preserve explicit tab/window distinction, other tabs, and restoration-failure reporting.

## LT-999 — window bounds read-back fabricates zero dimensions

**Status: OPEN; repaired in local 0.2.45; Windows acceptance and optional isolated resize pending.**
Origin: input controls restoration protocol and optional window-scope check 2.
Status: [active follow-up](2026-10-27-browser-input-controls-remediation_plan_completed.md).
Evidence: [campaign report](2026-10-27-browser-input-controls_evidence/REPORT.md), window-read receipts.

### Observed behaviour

Every scope-window read names window 771587906 and its other tabs, but returns
`bounds: {left:0,top:0,width:0,height:0}` while the live content width is 2558px. This does not
provide a usable original window baseline. Whole-window resizing was deliberately omitted;
no actual window restoration failure is claimed reproduced.

### Root cause

The extension reads `windowInfo.bounds.width/height/left/top`, including both read-mode and
resize-baseline paths (`resources/browser-extension/background.js:3305-3310,3340-3356,3373-3394`).
Chrome's Window object exposes those properties directly, not inside `bounds`; the wrong
lookup is silently replaced with zero. Confirmed against the primary
[Chrome Window API reference](https://developer.chrome.com/docs/extensions/reference/api/windows#type-Window)
on 27 October 2026. The same source issue threatens resize restoration, but that consequence
was not exercised against James's shared window.

### Required behaviour

Return actual nonzero dimensions for a live window and retain its real original bounds/state
before a resize. Unavailable dimensions must be an explicit unavailable/error result, not a
fabricated valid zero-size baseline.

### Acceptance

- Read mode returns real bounds and affected-tab inventory on Windows.
- A safe isolated-window resize/reset restores exact original bounds/state, including a failure
  path; other shared windows are untouched.
- Extension mocks use the real top-level Chrome Window API shape, and the canonical checks pass.

Numbering note for LT-997–LT-999: all registered checkout registers and the active July follow-up
were scanned; LT-996 was the highest existing reference. The older queue base's LT-707 and the
root's LT-708/LT-709 reconciliation are left unchanged. Integrate these additions without replacing
concurrent register entries. The historical July completed plan and frozen backlog are not edited.

Runtime/source check: downloaded the Windows extension's manifest and background script through
the allowlisted read-only worker file transfer. Disk manifest 0.2.43 matches the running relay;
the worktree manifest is 0.2.44. The full scripts differ, but the named-key dispatch, debugger
attach/detach, and viewport read/set/window blocks cited above are byte-identical. Hash receipts
are retained in `windows-source-comparison.json`; downloaded source copies are removed with the
runtime. This compares the configured extension files, not an attestation of Chrome's in-memory
script bytes.


### LT-997 / LT-998 / LT-999 — review repair evidence, 27 October 2026

These items remain OPEN for Windows acceptance. The original observations and source line
references above describe the pre-repair bundle. The new source and evidence supersede the
old "no fix" implementation state, not the original observations.

- LT-997: every named-key/modifier event now includes key and code. The actual isolated dev
  Chromium runtime verifies Tab/Tab/Shift+Tab and harmless Enter link activation. Regression
  assertions pin these fields, modifier release and existing successful/failed dedupe.
- LT-998: explicit viewport overrides retain their owned debugger session until reset; normal
  commands reuse it, failure retains desired metrics, watchdog detach recovers the override,
  and Gateway shutdown releases it. The unsupported metrics getter is removed. A mismatched
  actual size fails with `browser_viewport_dimensions_mismatch`. Real dev Chromium proves
  cross-command/failure persistence and reset; regressions cover recovery and retained zoom
  restoration state as well. No shared-window fallback was added.
- LT-999: real top-level Window bounds are read in every path; missing/nonpositive dimensions
  fail with `browser_window_bounds_unavailable`. Restoration applies normal bounds first and
  a non-normal state separately. Chrome-shaped tests cover read, resize/reset, unavailable
  bounds and maximized restoration. No user window was resized.

Proof scope: [round-two report](2026-10-27-browser-input-controls_evidence/round2/REPORT.md).
Local dev Chromium uses the shipped functions with a CDP transport adapter, not the Windows
extension/coordinator path. The Windows extension remains 0.2.43. The documented file-transfer
route explicitly refused the configured extension folder (`remote_write_refused`), so no
post-repair Windows pass is claimed. Checks 1, 2 and 4 remain open pending an approved install
and reload. Dingley remains outside the authorised fixture scope.

Review finding 5 is resolved as a test-protocol clarification, not a new product defect:
reset only mechanisms a check mutated; independently reread unchanged state. A no-baseline
zoom reset still reports `browser_zoom_baseline_lost`, preserving honest restart/loss reporting.

Review finding 6 has an explicit queue harvest manifest under `round2/`. The root-owned owner
and active follow-up must land with this queue-owned register/source/evidence. No worker merge
or root tracked-register edit is authorised; do not overwrite concurrent root entries. The
coordinator and independent verifier retain responsibility for integration and closure.

Final round-two status: actual dev Chromium now proves successful activation dedupe (1), new-key
activation (2), and a post-keyUp transport failure whose retry leaves count 3 unchanged; active
viewport survives and resets. Static/build gates and the 222-test focused feature/credential/
recovery selection pass. The full suite remains red: 42 recorded failures, of which 38 VM-harness
API-stub failures and the linked-install mismatch were repaired/retested. Unchanged native-finality
timeout cases still fail in isolation. No full rerun was launched at shared host load 325.41.
Windows installation was explicitly refused; no repaired Windows PASS, whole-suite PASS or
independent verdict is claimed. See the round-two report and all retained failures.

## LT-1000 — tab viewport read reports a mismatch while browser zoom is 200%

**Status: OPEN; observed on the Windows worker running extension 0.2.50 on 7 November 2026.**
Origin: input controls check 2 (tablet emulation) combined with check 3 (real zoom), Windows fixture.
Evidence: [round-four receipts](2026-10-27-browser-input-controls_evidence/round4/windows-receipts.json).

### Observed behaviour

With tab emulation set to 768×1024 and browser zoom set to 200%, two separate viewport reads
returned `browser_tab_viewport_dimensions_mismatch`. The emulation itself was still active
(768×1024), and the page reported `innerWidth` 384, which is 768 divided by the zoom factor. At zoom
1 the same emulation read back correctly. Resetting the zoom alone returned the viewport read to a
correct 768×1024. Reset of the emulation returned the original 2034 width.

### Root cause

Established in source for the merged extension (`resources/browser-extension/background.js`,
the `main` build, version 0.2.50). `setTabViewportState` runs `assertTabViewportDimensions` after
every viewport command, including a read (mode `read`) whenever a tab override is still recorded
(`background.js:3805`, assertion at `3736-3739`). That assertion compares `window.innerWidth` and
`innerHeight` in CSS pixels with the requested size. Browser zoom 200% halves the CSS width of a
768 px emulation to 384, so the comparison fails although the emulation is correct. Zoom 1 passes,
which matches the live observation. Not yet confirmed by a live run against the merged build.

### Required behaviour

A viewport read under emulation plus browser zoom reports the emulation that is in effect, with
actual dimensions that match the zoom-adjusted layout. It must not report a mismatch when the
emulation is correct.

### Acceptance

- Under 768×1024 emulation at zoom 2, a read returns the emulated mode without a mismatch error.
- A set at zoom 2 either succeeds with the same check or fails with a reason that explains the zoom.
- Reset still restores the original zoom and viewport.
<a id="lt-1006"></a>

## LT-1006 — archived benchmark tasks use an incompatible test installation

**Status: reproduced 27 October 2026; no new scored model runs accepted.** The earlier campaign
called this LT-709, which collides with another campaign. This campaign's LT-709 is now LT-1006,
and LT-710 to LT-712 are LT-1001 to LT-1003. LT-1000 was already taken on main by a browser-zoom
defect. The allocation scanned branch and live-worktree registers; its receipt
is `benchmarks/plan-execute-ab/evidence/2026-10-27-review-fixes/id-reservation.receipt.json`.
Historical raw receipts keep their original labels; these aliases do not reassign other campaigns.

### Observed behaviour

The current runner was recovered unchanged from that checkpoint. `verify-task` for AIO-01,
using an owned workspace inside the queue worktree, exits 1: both parent and fixed commit fail
before running tests with `Package subpath './vitest.mjs' is not defined by "exports"`.
The existing worktree `node_modules/vitest` links to the current root installation. Selecting
Vitest 3.2.7 in an owned temporary installation lets those tests execute, exposing LT-1002.
The temporary symlink changes were restored before normal repository verification.

Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27/historical-task-preflight.log`,
`historical-task-preflight-compatible.log`, and `scoring-negative-control/`.

### Root cause

`runArm` calls `linkNodeModules(repoPath, workspace.dir)`; `verifyTask` uses that same helper.
The helper links the checkout's current installation without verifying compatibility with the
archived task's scripts. The archived quiet runner resolves `vitest/vitest.mjs`, which the
current major version does not export. The 25 October workaround used an older checkout install
and exports under `/tmp`. This worker's explicit instructions require source exports inside
its worktree, so it did not silently reinstate that outside-worktree workaround.

### Required behaviour and acceptance

Before spending inference time, prove the archived task's broken parent fails for the intended
assertion and its fixed commit passes using one compatible dependency environment. Do not count
loader/type-resolution failures as model outcomes. Preserve current checkout dependencies and
remove only the worker-owned historical install after testing. Reconcile LT-1002 before accepting
AIO-01 as a scoring task. No source or test fix is claimed here.

### 27 October resumed run: exact setup wired; final clean execution pending

The benchmark now installs each exported historical manifest/lockfile before coding (including
normal native preparation), retains trusted pre-coder hashes and refuses changed/deleted
manifests. Missing executables/tooling are infrastructure failures, not model scores. Both
public verify-task and live scoreRun share this contract. Diagnostic controls passed, then
native esbuild proved that ancestor checkout packages could still satisfy missing imports.
Those scores and a rejected Node/fs-hook guard are explicitly retracted, with probe receipts.
The simpler final location preflight rejects installed ancestor/global module paths, sanitizes
NODE_PATH/PATH, and uses an owned offline npx cache. Actual clean controls/rescores remain open.
The user's worktree-only-copy instruction conflicts with the necessary clean location; a
narrow temporary-directory exception was requested and is unanswered. No outside-worktree
source/dependency copy was made. See `benchmarks/plan-execute-ab/evidence/2026-10-27-resume/`
under `scoring/` and `review-isolation/`. No model outcome accepted from this diagnostic work.

<a id="lt-1001"></a>

## LT-1001 — first startup of a fresh profile can race database migrations

**Status: open; reproduced in the live dev app on 27 October 2026 at 12:56:01 UTC.**

### Observed behaviour

After successful main and renderer builds, a fresh profile at `/tmp/aio-lt-queue-7ca7a00e`
logs `Failed to initialize: Work controls` and
`Failed to apply migration "001_add_optimized_indices": UNIQUE constraint failed: _migrations.name`.
The context worker had started first. The renderer did not become available on that attempt.
A subsequent launch against the same disposable profile completes initialization and responds
through real preload IPC. That restart is a campaign workaround, not a product fix.

Durable evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27/startup-migration-race.log`
and `dev-ipc-focus.log`. The earlier Chromium `sandbox initialization failed: Operation not
permitted` is a distinct host restriction; the successful test launch used `--no-sandbox`
inside the unchanged outer execution restrictions.

### Root cause

The executing path starts `ContextWorkerClient` in its constructor
(`src/main/instance/context-worker-client.ts:167`), passes the isolated profile path to the
worker, and pre-initializes that worker's `RLMDatabase` at `context-worker-main.ts:157`.
Main's Work controls initialization also opens that profile's RLM database through
`global-pause-bootstrap.ts:22`. `runMigrations` in `persistence/rlm/rlm-schema.ts:279` computes
its pending list before entering the transaction, then inserts each migration name without
rechecking that list inside the transaction. This permits the observed duplicate-name race
when another initializer applies the same pending migrations first. The precise interleaving
was not instrumented; no broader claim about production frequency is made.

### Required behaviour and acceptance

Concurrent main/worker initialization of a new profile must apply each migration once, without
aborting startup or weakening checksum validation. Add a deterministic concurrent-initializer
regression and verify a genuinely fresh live profile reaches working IPC. A restart of an
already initialized profile is insufficient acceptance. Implementation is pending.

<a id="lt-1002"></a>

## LT-1002 — the benchmark's AIO-01 negative control currently passes

**Status: open; reproduced twice on 27 October 2026. No hidden test was edited.**

### Observed behaviour

With historical Vitest 3.2.7 available, the runner's real `verify-task` path exports AIO-01's
parent `f04f674859b220b86eeb52662129072008573af9`, copies the fixed commit's held-back tests
onto it, then also tests fixed commit `8b9721bf3c55e69259b6be4880b3acff91b68b16`.
Both independent invocations report `failOnParent false (exit 0), passOnCommit true (exit 0)`.
Both versions run all 40 tests successfully. This is a failed scoring preflight, not a model
success and not a new defect in the model's patch.

Evidence: `historical-task-preflight-compatible.log`, `historical-task-preflight-repeat.log`,
and exact parent/fixed output plus `verification.json` under
`benchmarks/plan-execute-ab/evidence/2026-10-27/scoring-negative-control/`.

### Root cause / investigation limit

The task bank's dated `verification` booleans are historical and `cmdRun` trusts them without
rerunning a current control. The two exported versions differ by the intended
`await this.startupTasks` in `HistoryManager.clearAll`; the added test waits only a bounded
microtask drain before checking whether asynchronous backup I/O started. That scheduling
assumption is a candidate explanation, not a proven diagnosis. No expectation was weakened,
no replacement test selected, and no missing record synthesized.

### Required behaviour and acceptance

Establish a reliable held-back test that fails specifically for the missing startup wait and
passes with it, under the exact scoring environment. Verify every affected archived patch on
the same repaired scoring contract, preserving old evidence and labelling any revised scores.
The matched comparison must be valid before pilot decisions, subscription advice or a full-run
recommendation are accepted. Repair and rescore are technical agent work, not a request for new
human authority; any new paid benchmark invocation remains within the separate spend boundary.

### 27 October correction run: diagnostic control demonstrated, scoring still open

The scheduling explanation is now confirmed on the archived runtime path: backup calls
`fs.promises.readdir` before its first await; the original assertion checks `cp` after draining
only promise callbacks, while directory I/O can still be pending. Under the compatible owned
Vitest 3.2.7 environment the original parent varies between pass/failure observations; the
fixed original passes. Preserved original results are not rewritten.

The retained V2 held-back amendment adds a separate ordering test without changing any old
assertion. It holds the real startup temp write, observes the actual startup wait versus early
backup entry, then verifies a consistent backup and empty active history. It fails on the parent
for the intended ordering assertion in two runs, passes on the fixed commit in both, and rejects
a mutation that adds only a meaningless promise delay (all forty old assertions pass in that
mutation run). The first exploratory amendment is explicitly superseded by V2.

Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27-review-fixes/scoring-control/REPORT.md`,
`held-back-ordering-amendment-v2.patch`, `summary-v2.json`, exact command receipts and source seals.
This is a diagnostic test-contract amendment, not adoption by the task bank or runner. No archived
model patch was rescored; historical dependency/typecheck damage controls remain unresolved.
Do not close A5–A8 on this evidence alone.

### 27 October resumed run: V2 adopted, accepted candidate rescoring still open

The separate deterministic V2 test is now a task-bank amendment and is applied consistently
by live scoring and public verify-task. All forty old assertions remain untouched. Diagnostic
parent/fixed/bogus-delay evidence remains retained, but native dependency isolation findings
invalidate those environments as final scoring proof. Clean controls and all affected archived
candidates must still be rescored under the final contract; no old model score was rewritten.
Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27-resume/scoring/` and fresh reviews.

<a id="lt-1003"></a>

## LT-1003 — 35B tool smoke misses the specified second-turn cache acceptance

**Status: open acceptance gap, one live smoke on 27 October 2026.**

### Observed behaviour

The 35B on native llama-server 2.60.0, context 65536, parallel 1, through the bundled translator
completed Read → Edit → Bash/npm-test with zero tool errors. Independent file and test checks
passed. Nevertheless, its first two assistant requests report zero cached-read tokens and
16959 / 17083 fresh input tokens. Server prompt evaluation took 1509.08 / 1506.20 ms respectively;
the second is not substantially faster. Requests three and four report 17243 / 17413 cache-read
tokens, with only 108 / 29 fresh input tokens and 360.40 / 309.73 ms prompt evaluation.
Thus caching exists, but A4's explicit second-turn improvement is not demonstrated.

Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27/smoke-35b.json`,
`smoke-message-usage.receipt.json`, `server-timings.receipt.txt`, and `proxy.log`.

### Root cause / investigation limit

The measured route is `runClaudeAgent` → local endpoint environment → bundled translator →
native Windows 2.60.0 server. The translator lifted one system reminder on each request.
The reason the second request did not reuse its predecessor's prefix has not been isolated.
Do not turn that observation into a claim that the model cannot cache or that application
caching is broken. No source/test/config change was made to hide the result.

### Required behaviour and acceptance

Repeat the agreed smoke with request/cache timing evidence. Establish why the second prefix
is re-evaluated and either meet the current criterion or explicitly revise the benchmark
protocol with consistent treatment of every local arm. Keep the successful tool-calling
subcheck separate from the unmet second-turn cache subcheck. Technical investigation remains
agent work; no human authority is needed to collect another bounded local sample.

### 27 October correction run: reproduced again with request-shape evidence

The same native 2.60.0 35B setup at 65536/parallel 1 completed Read/Edit/Bash and an independent
test again (four turns, zero tool errors). First and second requests again report zero cached
reads; third and fourth report 17146 and 17290. Hash-only observation of the normalized request
shows the third system block changes from 9910 to 9610 serialized bytes between the first two
requests, then stays identical; the first two system blocks and tool-schema hash stay unchanged.
That is a concrete changing prefix to investigate, not a controlled proof of the server's cache
invalidation cause. No second-turn prompt-time measurement was collected on this replay, and
the zero-cache result alone leaves the existing acceptance unmet. No protocol was relaxed.

Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27-review-fixes/cache-retest.receipt.json`
and the original local-only agent output. No model score or final pilot decision follows.

### 27 October resumed run: second-turn cache behavior demonstrated

The translator preserves lifted structured system content instead of serializing the whole
block array into text. A real native35B Read/Edit/Bash smoke plus independent npm test pass,
zero tool errors. Observed request one cache0/input16921, request two cache17106/input43,
and later requests positive. Client request-to-upstream-message_start falls1252.409→88.576ms
(14.139x); that includes network and first-token time, not pure server prompt_ms. The latter
was not measured because native stop/relaunch-with-log was rejected by automatic approval.
Behavioral cache gap is reproduced as fixed; independent final verification remains recorded
separately. All ten new C1 cells require translator-v2 setup identity and a fresh session;
do not merge earlier translator records into this comparison. Evidence:
`benchmarks/plan-execute-ab/evidence/2026-10-27-resume/cache-observed/cache-retest.receipt.json`
and `cache-latency-summary.receipt.json`. No model score or pure server-time claim follows.

### 7 November 2026 re-confirmation with native server timing

One smoke on the native 35B (2.60.0, 65536/parallel 1) through the frozen translator measured
server-side prompt time for the first time. Request one evaluated 17,216 tokens in 1,808.51 ms.
Request two evaluated 39 new tokens in 106.11 ms, reusing about 17,579 cached tokens (prefix
similarity 0.998). The tool sequence was Read, Bash, Write, Bash, with the Write standing in for
the specified Edit; the independent test passed. This supports the second-turn cache result with
server timing; the Edit-tool deviation and the 35B-only scope keep the acceptance check open.
Evidence: `benchmarks/plan-execute-ab/evidence/2026-11-07-livetest-resume/native-timing-lines.txt`.

<a id="lt-1004"></a>

## LT-1004 — later local pilot records and patches were not preserved in the portable mirror

**Status: open, confirmed 27 October 2026 during verifier correction.**

### Observed behaviour

The root-checkout portable session's `runs.jsonl` contains 32 records: ten each for A, D and G,
and two settled C1 records (12ST-01/02). Eight later settled C1 cells and all ten C2 cells are
described in original 25 October command-output summaries and retained local CLI transcripts,
but their full records and patch artifacts are missing from that mirror. The original queue
worktree is absent. Checkpoint `9cc19c6d6` tracks the runner and selected evidence, not the
ignored session. Searches of the experiment's recorded tool outputs and associated conversation
ledger found no full later records or patch dumps. This is a bounded recovery result, not proof
that no backup exists anywhere. Earlier C1 patch files belong to retained/quarantined attempts
and must not be relabelled as later reruns.

Evidence: `benchmarks/plan-execute-ab/evidence/2026-10-27-review-fixes/raw-recovery.receipt.json`
and `raw-recovery.md`; earlier `retained-evidence-manifest.json` and
`recovered-scoring-receipts.json` remain unchanged under `evidence/2026-10-27/`.

### Root cause / investigation limit

The benchmark stores run JSONL and patches under ignored scratch directories. Its documented
root mirror is incomplete for these later cells, and those ignored artifacts are not present in
the checkpoint. The precise deletion or failed-copy event is unconfirmed. A printed score does
not recover the patch, scoring output, speed probe, configuration or complete run metadata.

### Required behaviour and acceptance

Recover original complete records and matching patch bytes with provenance, or rerun affected
cells under the same frozen protocol once scoring controls work. Never synthesize patch contents
or run records from printed aggregates. Preserve records, patches and configuration together in
a durable, hash-checked evidence bundle before deleting disposable runtime or allowing a queue
checkout to be replaced. Demonstrate that a copied/moved bundle still supports rescoring and
report generation after the original scratch runtime is removed. Reconcile all affected cells
and scoring controls before using the pilot for a subscription or full-run recommendation.

### 27 October resumed recovery: thirty baseline candidates reconstructed

All thirty A/D/G candidate patches were deterministically rebuilt from exact chronological
original edit actions against recorded parents. Each complete diff after the exact historical
judge transform matches a complete original judge input including Git hashes/hunks. These are
transcript reconstructions, not recovered original runner patch bytes. Independent parent
hash/parse receipt confirms all thirty. Two final C2 tracked-diff snapshots are diagnostic
only; runner staged capture may have included more. Eight later C1 and ten C2 full records
remain missing. Bounded Git/CLI/ledger/local Time Machine searches do not exclude every backup.
No new runner records were synthesized and the historical portable mirror/quarantines stay
unchanged. Full local reruns and accepted clean rescoring remain open. See
`benchmarks/plan-execute-ab/evidence/2026-10-27-resume/recovery/REPORT.md` and manifests.


<a id="lt-1005"></a>

## LT-1005 — the benchmark translator cannot reach an IPv6 native server

**Status: open, reproduced 7 November 2026. Workaround in use; translator unchanged.**

### Observed behaviour

With the native 2.60.0 server bound to a Tailscale IPv6 address, `local-anthropic-proxy.ts`
pointed at `http://[fd7a:115c:a1e0::434:5d68]:1235` answered every request with HTTP 502 and
logged `upstream error: getaddrinfo ENOTFOUND [fd7a:115c:a1e0::434:5d68]`. The same server
answered 401/401/200 when reached directly, so the failure is in the translator's upstream
connection, not in the server. Evidence: `benchmarks/plan-execute-ab/evidence/2026-11-07-livetest-resume/translator-8900.log`.

### Root cause

`benchmarks/plan-execute-ab/local-anthropic-proxy.ts` builds the upstream request with
`hostname: up.hostname` (about line 157). For an IPv6 literal, Node's `URL.hostname` keeps the
square brackets, and `http.request` then tries to resolve `[fd7a:…]` as a DNS name.

### Required behaviour and acceptance

The upstream connection should accept a bracketed IPv6 literal (strip the brackets before
`http.request`, or pass the unbracketed address). Acceptance: a unit test that starts the
translator against an IPv6 loopback upstream and gets the upstream response; and the same
smoke as the 7 November run passing through the translator with no separate forwarder. The
change alters the frozen translator's behaviour, so the owning plan must decide whether it
counts as a new translator identity before any scored cell uses it. Until then, IPv4 upstreams
and the byte forwarder in that evidence folder are the only tested routes.
