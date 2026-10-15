# Consolidated Agent-Runnable Runtime Live Tests

## Status — 2026-09-27

Open: 7 · Closed: 0 · Failed: 0

This document consolidates expensive, exclusive or duplicate live-runtime checks that remain safe
for an autonomous agent but should be executed once against the current build. Source checklists
link to the exact item moved here and may close after all of their other checks pass.

> **Found a defect while running these checks?** Record it in the remediation register at
> `docs/plans/livetest-remediation-register.md`, with matching implementation status in the active
> remediation record. Pending or unrun work is not itself a defect.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

## AR-001 — Codex context-evidence occupancy and recovery ladder

**Source:** [Provider-Agnostic Context Evidence live test](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest_completed.md), former check 2. Later live-test documents that repeat the same occupancy ladder should link here instead of launching a second provider campaign.

**Known passed half:** in `enforce` mode, 18 real evidence records externalized 5,222,138 bytes
while occupancy stayed at 42.7% over five turns. Externalized cards, real provider accounting and
the three-recovery-per-epoch implementation are already covered by live and automated evidence.

**Remaining live procedure:**

1. Use an isolated current dev profile and an authenticated Codex app-server instance. Record the
   exact model, reasoning effort and reported context window. Set only Codex's
   `contextEvidenceModeByProvider` entry to `enforce`; restore the prior value afterward.
2. Grow the thread with sustained non-tool dialogue/reasoning, because oversized tool output is
   deliberately externalized before it can raise occupancy. Do not manufacture provider-visible
   files outside a disposable workspace.
3. Record provider-reported occupancy through 60%, 70%, 75% and 80%, evidence-card counts,
   recovery attempts, turn outcomes and any compaction. Never derive occupancy from cumulative
   input. At 70% require the synthesis/no-new-research `turn/steer`; while a turn is still running
   at 75%, require that `thread/compact/start` does not fire.
4. Stop at the first of: 80% occupancy, three recoveries in the current epoch, provider limit/error,
   20 completed turns, or 60 minutes. Do not increase the bounds after the run begins.
5. At 80%, require interrupt → compact → same-thread continuation, and require the instance to
   receive the 80% context warning rather than being treated as self-managed. Also verify oversized
   results remain bounded/externalized, cited claims still resolve through the accuracy gate,
   controlled recovery preserves the thread when supported, no more than three recoveries occur in
   one epoch, and the UI never fabricates an occupancy percentage.
6. Terminate only the disposable instance, restore settings, and retain content-free numeric
   evidence only.

**Pass:** 60%, 70%, 75% and 80% are observed from provider telemetry and every threshold-specific
and context-evidence acceptance property holds.

**Bounded inconclusive:** if the fixed limit fires before 60%, record the achieved maximum and why;
do not call the behavior passed. The item remains open unless later duplicate evidence reaches both
thresholds.

## AR-002 — Orphaned orchestration children reconcile during recovery respawn

**Source:** [Resilient Threads & Sessions live test](../superpowers/plans/2026-07-17-resilient-threads-sessions_plan_livetest_completed.md), former check 3 / LT-603.

**Known state:** LT-603's targeted fix is present and unit-verified. The admission service holds
`respawning` orchestration `child_completed` writes across the entire recovery respawn, including
the ready edge that previously erased the suppressed record before reconciliation. The last live
run predated that fix and reproduced the race four times.

**Dedicated live procedure:**

1. Launch a rebuilt isolated dev app with a main-process inspector and an empty disposable profile.
   Snapshot all provider PIDs before creating any test instance.
2. Rederive a current scoped interception point for recovery resume failure. The old
   `CodexCliAdapter.prototype.spawn(cliConfig)` hook is stale because `spawn()` now takes no
   arguments; scope the replacement by the adapter's owned working directory/config or by the
   `createRuntimeAdapter` request. Do not patch production source on disk.
3. Create one fresh Codex parent in a disposable workspace and use real orchestration
   `spawn_child` commands to start two children. Each child must run a genuine multi-minute loop so
   neither finishes inside the collision window.
4. Verify every target PID is new since step 1, is a child of this dev app's exact main PID, and has
   the expected Codex app-server command line. On the parent's first recovery respawn only, issue
   one exact `kill -9 <parentPid> <deadChildPid>` invocation. Never use a glob, name-wide kill or a
   PID not proven to belong to this fixture.
5. After fallback settles, require: the `Reconciled orchestration children after restart` log lists
   the dead child in `dropped` and live child in `kept`; the degradation notice names the live child
   as attached and dead child as lost; `get_children` returns only the live child; and
   `get_child_summary` for the dead child still resolves from the completed set.
6. Remove the inspector monkeypatch, terminate only fixture instances/processes, stop the isolated
   dev app and remove its disposable workspace/profile.

**Pass:** all five assertions hold in one clean run against the fixed build. A timing miss is an
inconclusive fixture run, not a product failure; a cleanly staged run that repeats the old missing
`dropped`/lost result is a reproduced LT-603 regression and must re-open remediation.

## AR-003 — LT-371 live browser-command socket-handoff correlation

**Source:** [Browser-Extension Channel Flapping live test](../superpowers/plans/2026-08-23-browser-extension-channel-flapping_plan_livetest_completed.md), former check 2 / LT-616.

**Known passed behavior:** natural short and sustained socket-loss behavior, disconnect grace,
attachment restore and generation pruning passed live. On 2026-09-24 a bounded reset overlapped one
read-only query: the socket refusal branch fired twice, the worker re-registered in 1.4 seconds, and
the query succeeded once 209 ms later. LT-616 added the one missing log correlation between command
ID and failed poll handoff.

**Current prerequisite:** run from a Harness session that owns current conversation evidence. On
2026-09-27 Browser Gateway health reported `windows-pc` ready on extension v0.2.36 and an independent
read-only query succeeded, but `reset_node_connection` was refused before mutation with
`EVIDENCE_CAPTURE_REQUIRED`. This is an authorization-context limitation, not a product failure; do
not bypass it with direct production-app IPC.

**Procedure:**

1. Select a harmless readable shared tab on `windows-pc` and confirm one independent
   `browser.query_elements` call succeeds.
2. In one tool batch, invoke `reset_node_connection {node:"windows-pc"}` and another read-only query
   against that tab. Do not click, type, evaluate, restart the worker or revoke its registration.
3. From the reset timestamp onward, match `Resetting worker node connection`, socket close,
   `sendResponse: requesting socket is no longer active`,
   `Browser command poll handoff failed; requeued`, and continuous-session re-registration by
   `pollRequestId` and `commandId`.
4. Match the same command to exactly one successful browser audit row. Require the original command
   ID, FIFO head requeue, no `browser_extension_command_receipt_missing`, no duplicate execution and
   completion inside the original 90-second budget.

**Pass:** every correlation is visible in one bounded run and Browser Gateway health returns ready.

<a id="ar-004--exclusive-real-corpus-rlm-budget-and-single-owner-campaign"></a>

## AR-004 — Exclusive real-corpus RLM budget and single-owner campaign

**Source:** [RLM global budget and single owner live test](2026-08-30-rlm-global-budget-single-owner_livetest_completed.md), former checks 1–6.

**Why this is consolidated here:** the acceptance criterion requires the normal Harness process to
stop, then a rebuilt app to become the only owner of James's existing, non-isolated RLM database.
Stopping that coordinator terminates an agent session hosted by it; running a second isolated app
cannot prove the real-corpus properties. This is safe for an autonomous agent only as a dedicated
external/exclusive campaign with durable evidence collection and restoration of the installed app.

**Prerequisites and safety boundary:**

1. Arrange an exclusive maintenance window with no other process using the real RLM database.
2. Build the current main/preload and renderer, record the checkout/diff fingerprint, and prepare a
   timestamped external evidence collector that survives the coordinator shutdown.
3. Stop the installed Harness cleanly. Launch exactly one rebuilt dev app without
   `AIO_DEV_USER_DATA_PATH`, so it uses the existing profile. Never run two owners against the same
   database.
4. Enable CDP focus emulation before DOM assertions. Redact section content, query text, store IDs,
   paths and provider credentials. Do not compact, migrate, prune or delete existing RLM data.
   Create and later remove only one clearly disposable store/section.

**One bounded campaign:**

1. At startup, prove exactly one long-lived interactive `RLMContextManager` owner exists in the
   context worker and none in Electron main. Require the configured ceilings: 50,000 metadata
   sections, 64 MiB content, 20,000 content sections, 128 content stores, 5,000 sections per store,
   and a 48-hour hot window.
2. From process start through worker readiness, require `startupContentBytes: 0`; zero initial
   resident content bytes/sections/stores and hot counters; no lexical term-map build, section
   content reads or embedding; no hot-prewarm start before ready; renderer store-list availability
   at ready; and no event-loop stall over five seconds.
3. Let the 48-hour prewarm finish before any query. Compare redacted stable labels with active
   sessions and the captured cutoff. Require old inactive, individually oversized and codebase-auto
   stores to be skipped; yields between stores; every global/per-store ceiling honored; and missing
   capacity reported as a skip rather than over-budget admission.
4. Observe ten idle minutes with bounded RSS, heap, event-loop, residency and owner-count samples.
   Then use normal renderer/API paths for store list, section list, lexical query, semantic query,
   one disposable add/remove, and a worker-originated renderer update. Require compatible response
   shapes, on-demand hydration, one renderer delivery, no doubled residency after reload, one owner
   throughout, and no stale-generation mutation.
5. Against an unchanged store with complete durable vectors, run a semantic query and require zero
   section-content embedding calls. Add one obvious disposable section and repeat: only that missing
   section may be read, embedded and persisted; `missing = indexed + skipped + failed`; retries are
   a subset; no existing vector is rewritten. Remove only the disposable section afterward.
6. Compare main/context-worker RSS and heap with the pre-change baseline as diagnostic evidence.
   Require main below its configured heap-warning threshold, no startup/runtime event-loop stall
   over five seconds, and all deterministic residency ceilings respected. RSS alone is non-gating.

**Cleanup and pass:** stop the rebuilt app cleanly, remove only disposable data, restore and verify
the normal installed app, and prove no repository Vitest process, disposable Electron process,
temporary RLM profile or unwanted simulator remains. Close AR-004 only when timestamp-bounded,
redacted evidence proves every assertion above in one exclusive real-corpus run.

<a id="ar-005--enterprise-copilot-cross-model-policy-campaign"></a>

## AR-005 — Enterprise Copilot cross-model policy campaign

**Source:** [Cross-model checking policy live test](2026-09-02-cross-model-checking-policy_livetest_completed.md), former LT-A through LT-F. The source's seat-capability premise and zero-reviewer CLI check already pass.

**Why this is consolidated here:** all six remaining assertions need one rebuilt coordinator using
the real `lawrencj` Copilot routing profile and real provider calls. The current isolated dev
profile cannot establish that enterprise account boundary, while pointing a concurrent dev app at
the installed profile would risk shared-state ownership. Run these as one bounded campaign rather
than six separate seat-consuming probes.

**Prerequisites and safety boundary:**

1. Rebuild and relaunch the intended coordinator with the `lawrencj` Copilot profile still routed
   to `/Users/suas/work/ebrd`, automation policy initially `allow-routed`, and `copilot` still in
   `providersExcludedFromAutomation`.
2. Create a disposable, remote-free scratch repository under `/Users/suas/work/ebrd/`; never use a
   client repository. Record the selected builder/checker models and bounded log timestamps.
3. Snapshot the two settings changed below (`crossModelReviewModelByProvider.copilot` and the
   profile automation policy), restore them in `finally` cleanup, and verify the restored values.

**One bounded campaign:**

1. Start an interactive Copilot session in the scratch repository and make a harmless small
   change. On idle review, require `licencePinned: true`, the `LAWRENCJ` route, two distinct
   `copilot:<model>` checkers, and model families different from the builder. One checker is a
   regression of the former provider-key collapse.
2. Require both checker spawns to resolve to the `lawrencj` profile and at least one parsed
   `review:completed` verdict. There must be no `automation-disallowed` failure despite Copilot's
   general automation exclusion, proving the protected-seat carve-out.
3. In a non-EBRD disposable repository, temporarily configure a known-unavailable Copilot model
   such as `claude-sonnet-4.6`; trigger one review, require the refusal to produce
   `Learned Copilot seat entitlements from a model refusal`, then require the next review not to
   select that model. Restore the model setting.
4. Back in the EBRD scratch repository, run a ping-pong loop with a Copilot builder. Require
   `Ping-pong reviewer pinned to the enterprise Copilot seat`, the same `lawrencj` profile, and a
   different-family Copilot model rather than Claude/Codex/Cursor.
5. Temporarily change the enterprise profile to `manual-only`, then trigger an in-session review
   and ping-pong round. Require `Checker plan blocked — enterprise seat forbids automatic use`, no
   Copilot reviewer spawn, and no off-seat fallback spawn. Restore `allow-routed`.
6. Trigger an in-session review in this repository. Require `licencePinned` absent/false, normal
   configured reviewers, and no Copilot reviewer while it remains excluded from automation.

**Cleanup and pass:** terminate only disposable instances, remove the scratch repository, restore
both settings, and retain redacted log excerpts. Close AR-005 only when all six assertions pass in
one current-build campaign; a provider quota/seat outage is bounded inconclusive, not a pass.

<a id="ar-006--enhancements-backlog-rebuilt-app-closure-campaign"></a>

## AR-006 — Enhancements backlog rebuilt-app closure campaign

**Source:** [Enhancements backlog live test](2026-09-03-enhancements-backlog_livetest_completed.md),
former checks 3, 17, 18 and 24. Checks 1–16, 19 and 23 otherwise pass; billed checks 20/21 are
RES-025, and the duplicate Codex threshold campaign in check 22 is part of AR-001.

**Known state:** LT-660 fixes the reproduced third-Tab escape with the shared focus trap and its
component regression passes. LT-594's terminal causal timeline and LT-593's interrupt recovery are
already confirmed fixed live. Permission check 24 live-confirmed the duration label and tooltip;
the remaining sentence is rendered only for the older `permission_denial` request type, while the
current actionable non-YOLO Claude flow emits `deferred_permission`. A project-local explicit deny
correctly denied without raising an override prompt.

**One bounded rebuilt-app campaign:** 

1. Launch one isolated current dev app and disposable repository with a working authenticated
   reviewer pair. Record the build/diff fingerprint and restore every changed setting afterward.
2. Open the terminate confirmation from a real session. Without using the mouse, require initial
   focus on the dialog, then Tab through **Keep running** → **Close session** → **Keep running** and
   Shift+Tab back to **Close session**. Close with Escape and require focus to return to the opener.
3. Run a loop to a clean fresh-eyes verdict at a non-terminal gate. Without changing the tree, let
   it declare done again and require `Fresh-eyes gate: instant ALLOW — clean verdict cached, no
   production changes since` plus `loop:fresh-eyes-review-passed { instantAllow: true }`.
4. Change one tracked file outside the app, declare done again and require a real review rather than
   cache reuse. Restore that disposable change, obtain another clean cached verdict, park or pause
   the run, change the tree again, resume, and again require a real review. If current ordinary
   completion makes the non-terminal fixture impossible, use the owning gate/park path rather than
   weakening the assertion.
5. For the permission surface, first repeat the reachable real `deferred_permission` flow and
   require the visible **Remember this decision** label, Once/Session/Always choices and duration
   tooltip, with no claim that Always writes a settings rule. Then obtain a genuine current
   `permission_denial` request without adding an explicit deny rule. If the current provider no
   longer emits that request class, record the runtime capability as absent and retire only that
   obsolete clause; do not offer to override a user-authored deny. If it is emitted, require the
   visible `Always writes an allow rule to ~/.claude/settings.json` sentence.
6. Terminate only disposable instances, remove the scratch repository/profile, restore settings,
   and retain timestamp-bounded redacted evidence.

**Pass:** the focus cycle/restore, both fresh-eyes invalidation branches and the reachable current
permission contract all hold. A reviewer/provider outage is bounded inconclusive. An absent legacy
`permission_denial` class is a documented contract retirement, not a product failure.

<a id="ar-007--acp-no-output-terminal-failure-fallback"></a>

## AR-007 — ACP no-output terminal-failure fallback

**Source:** [LT-196 correction miner live test](../superpowers/plans/2026-09-06-lt196-correction-miner_livetest_completed.md), remaining sub-clause of check 2.

**Known passed behavior:** real Claude fail→fix mining and archive/restore/crash-recovery hiding all
pass. Cursor and Grok now record nonzero shell exits as `is_error: true`, their fixes as false, and
the miner finds the correction. A cancelled ACP call emits neither `is_error` nor fallback record.
The only unobserved branch is a provider reporting a terminal failure with no renderable output;
the fallback itself is unit-tested.

**Bounded procedure:** 

1. In one isolated current dev profile and disposable workspace, use each already-authenticated ACP
   provider available on the machine. Do not add accounts or consume more than three candidate
   commands per provider.
2. Try benign commands/tools that can terminate failed without stdout/stderr. Inspect the raw ACP
   terminal update and archived transcript. Do not suppress provider output inside AIO merely to
   force the branch.
3. If a genuine `failed` terminal update has no renderable output, require exactly one hidden
   `tool_outcome { is_error: true }`, no visible `tool_result`, no transcript/mobile/replay exposure,
   and a subsequent successful correction that the miner finds.
4. If every available current ACP provider always supplies renderable output or an exit code,
   record those wire shapes and retire the live clause as unreachable on current providers; retain
   the unit regression because the protocol still permits the fallback shape.
5. Terminate only disposable instances, remove the profile/workspace and retain content-redacted
   shape/exit evidence.

**Pass:** either one genuine provider event proves the fallback end to end, or bounded current-wire
evidence proves no supported provider can emit the required shape and the clause is explicitly
retired. A provider outage is inconclusive, not a pass.

## Evidence run — 2026-10-04 (orchestrating session and batch agents)

Packaged app built 19:06 from `3d05e250e`, restarted 20:45:59 BST; `windows-pc` extension 0.2.37.

### AR-003 — PASS

Run from this Harness session (which owns current conversation evidence, so
`reset_node_connection` was accepted this time). Tab: James's public Find a Tender notice tab
`771568857` on `windows-pc`. Times are relative to T0 = `1791153090126` (23:31:30.126 BST). Log slice:
`_scratch/lt-2026-10-04/orch/ar003-correlation.txt`.

1. Independent `browser.query_elements` at −2.6 s → `succeeded` (audit `f7fdf1b8`).
2. One batch: `reset_node_connection {node: "windows-pc"}` → `{reset: true}`, plus a second read-only
   `query_elements` on the same tab.
3. Log correlation, all for node `bb62e3ee-…`: +0.083 s `Resetting worker node connection`
   (`reason: Agent reset_node_connection`); +0.134 s `Worker WebSocket closed` (code 4010,
   `activeInstances: 1`, `inFlightWork: 0`); +1.574 s `Node re-registered within disconnect grace —
   treating as continuous session` / `Node registered`; +1.602 s and +1.603 s
   `sendResponse: requesting socket is no longer active` for `worker-292619` and `worker-292623`, each
   followed by `Browser command poll handoff failed; requeued` with the same
   `commandId: 0873c485-6237-4144-9fb4-b8bd2a876c99` and its `pollRequestId`, `requeued: true`.
4. Exactly one audit row exists for the concurrent query: `2b992623`, `browser.query_elements`,
   `succeeded` at +2.025 s — well inside the 90-second budget. No other browser command was issued in
   the window, `browser_extension_command_receipt_missing` occurs 0 times in `app.log`, and the
   command ID appears only in the two requeue lines (no duplicate dispatch). `list_remote_nodes`
   afterwards: connected, relay `registration: ok`, extension contact 7 s old.

Caveat stated plainly: audit rows carry no command ID, so the command-to-audit match is by the
unique command in the window rather than by ID, and the log does not state the queue position, so
"requeued at the FIFO head" is inferred from the 0.4 s completion rather than observed.

### AR-004 — NOT RUN

Requires stopping James's installed Harness (which hosts live sessions, including this one) for an
exclusive real-corpus window. Not done.

### AR-001 — NOT PASSED AS WRITTEN (procedure out of date; no defect)

Batch B, isolated dev profile, Codex 0.160.0 `gpt-5.6-sol` effort `high`, window 258,400 tokens,
instance `x13dt4qqx`. Occupancy was observed at 62.8%, 71.3%, 75.2% and 80.8% (the last two crossed
mid-turn); Harness took no action at 70% or 80% and Codex compacted itself at about 95%. That matches
the 2026-09-27 inline-compaction design (Codex receives no executable policy actions), but this
item's steps still expect the older steer and interrupt-compact ladder, which can no longer occur
for Codex. The procedure needs rewriting for the inline design before it can pass. Full evidence:
`_scratch/lt-2026-10-04/b/AR-001-evidence.md`. (This also makes
[outstanding-plans sweep check 5](2026-09-23-outstanding-plans-sweep_livetest.md)'s "only if James
enables `enforce`" gate stale — see that doc.)

### AR-002 — PASS

Batch A, isolated dev profile on the current tree (the LT-603 fix commit `9efc4871` is an ancestor of
HEAD). Codex parent `xlfu1rgt5` spawned two real children through `:::ORCHESTRATOR_COMMAND:::`
(`x5wqgz23g`, `xtg7eux1p`), both busy. The parent's provider process and child `xtg7eux1p` were killed
under the pid gates, with a one-shot in-memory resume failure staged on the parent's adapter (scoped
by its own working directory; fired exactly once). Result: `Reconciled orchestration children after
restart` kept `x5wqgz23g` and dropped `xtg7eux1p`; the degradation notice named the live child as
attached and the dead one as lost; `get_children` returned only the live child; `get_child_summary`
resolved the dead child from the completed set. An earlier attempt was discarded as an invalid
fixture (a `CLAUDE_CONFIG_DIR` override broke the children) before the clean run. Full evidence:
`_scratch/lt-2026-10-04/a/AR-002-evidence.md`.

### AR-007 — INCONCLUSIVE, leaning towards retirement (Copilot not run)

Batch C spoke raw ACP to each provider's own server with a content-redacted probe client, three benign
candidates each. No provider produced a genuine `failed` terminal `tool_call_update` with no
renderable output, so the fallback branch (`buildAcpToolOutcomeFallback`,
`src/main/cli/adapters/acp-tool-call-material.ts:83`) was never reached by a real event: OpenCode's
`failed` always carries error text, Cursor reports empty failures (a failed read, a rejected shell
permission) as `completed`, and Grok always completed with output. Copilot was not run because the
personal account could not be proven. Retiring the live clause is an owner decision; Copilot remains
the residual. Side note recorded for the owner: Cursor's `completed`-with-nothing for real failures
means the correction miner would record those as successes. Full evidence:
`_scratch/lt-2026-10-04/c/AR-007-evidence.md`.

### AR-005, AR-006

AR-005 (enterprise Copilot) was not attempted: it needs the EBRD seat, which agents must never use.
AR-006 was assigned to batch D; see the batch D note below if present.

## Status — 2026-10-04

Open: 5 (AR-001, AR-004, AR-005, AR-006, AR-007) · Closed: 2 (AR-002, AR-003) · Failed: 0.

## Decision — 2026-10-05

James decided on 2026-10-05 to drop **AR-007** (the live "ACP no-output terminal failure" clause).
The 2026-10-04 probes showed no current provider produces that event shape (Copilot was not
exercised); the fallback branch keeps its unit regression. AR-007 is retired, not passed.

## Status — 2026-10-05

Open: 4 (AR-001, AR-004, AR-005, AR-006) · Closed: 2 (AR-002, AR-003) · Retired: 1 (AR-007) · Failed: 0.
