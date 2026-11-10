# Local AI CLI parity — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-04-local-ai-cli-parity_plan_completed.md](2026-10-04-local-ai-cli-parity_plan_completed.md)

**Prerequisites:** rebuild and restart Harness from this checkout (`npm run build:main &&
npm run build:renderer && npm run build:aio-mcp-dist`, then restart) so the new CLI RPC methods
and the local-completion recording are loaded. Before that, the installed `aio-mcp` and the
running app answer `Unknown orchestrator-tools RPC method: orchestrator_tools.local_ai.status`.
All of this is covered in-loop by unit specs; only the end-to-end run against the live app is
deferred.

## 1. Status matches the Health Centre

Steps: `$AIO_MCP local-ai status` and `$AIO_MCP local-ai status --json`; open Monitoring → Local
AI Guard in the app.

Expected: the same targets and states as the Health Centre; the LM Studio target shows routes and
recent worker/endpoint/model/canary checks; no probe message or evidence text in the JSON.

## 2. Rename the LM Studio target

Steps: take its id from `$AIO_MCP local-ai list`, then
`$AIO_MCP local-ai rename <id> "windows-pc · LM Studio"`.

Expected: the CLI confirms; `list`, `status` and the Health Centre card all show the new label;
routing is unaffected (`auxiliaryModel.generate` dispatches continue in app.log).

## 3. Run check

Steps: `$AIO_MCP local-ai recheck <id>` then `$AIO_MCP local-ai recheck <id> --kind functional`.

Expected: each prints fresh check ages (seconds ago); the functional run refreshes the canary.

## 4. Effectiveness counts local work

Steps: let normal helper traffic run for at least 30 minutes after the restart, then
`$AIO_MCP local-ai summary` and compare with the Health Centre's "Local AI effectiveness" panel.

Expected: local tasks well above zero (most helper calls run locally), matching the panel; the
fallback spend budget is unchanged by local work.

## 5. Edit and acknowledge

Steps: `$AIO_MCP local-ai update <id> '{"warningLatencyMs":15000}'` (the value it already has),
and, if an incident is open, `$AIO_MCP local-ai acknowledge <incident-id>`.

Expected: update succeeds with no change in behaviour; the incident shows as acknowledged in
`status` and in the Health Centre.

## Evidence run — 2026-10-04 (orchestrating session, packaged app)

Environment: packaged app built 19:06 from `3d05e250e`, started 20:45:59 BST; `$AIO_MCP` built
19:06. The new RPC methods answer (no `Unknown orchestrator-tools RPC method`). The Harness UI is a
hard-denied Computer Use target and the packaged app has no debug port, so every "matches the
Health Centre" clause is **unobserved** here; the CLI was instead cross-checked against the same
`rlm.db` tables the Health Centre reads. Evidence copies: `_scratch/lt-2026-10-04/orch/`.

| Check | Verdict | Evidence |
| --- | --- | --- |
| 1. Status | **CLI PASS; UI comparison open** | 23:19, `local-ai status` → `Overall: healthy (enrolled 1, healthy 1 …)`, LM Studio target with all 12 routes and `worker/endpoint/model/canary` check ages. `--json` contains aggregate, target layers (`ok`, `checkedAt`, `durationMs`) and incidents only — no probe message or evidence text. Incident list included `51c88683-…`, an open `connection-refused` incident for the **retired** Ollama target (see LT-664). |
| 2. Rename | **CLI PASS; UI card open** | 23:20:26, `local-ai rename afa37744-… "windows-pc · LM Studio"` → `… is now labelled "windows-pc · LM Studio".` `list` and `status` both show the new label. Routing unaffected: 2 local `auxiliaryModel.generate` completions on `windows-pc` after the rename (last 23:25:36), both recorded `actual_route = local`. The rename is intentionally left in place (it is the requested end state). |
| 3. Run check | **PASS** | `recheck afa37744-…` → worker/endpoint/model `0s ago`, canary still `3m ago`; `recheck … --kind functional` → canary `0s ago`. Every layer's `checkedAt` in the following `status --json` was later than the pre-recheck timestamp. |
| 4. Effectiveness | **CLI PASS; panel open** | `summary` (24h): `75% local (189 of 252 tasks)`, 1,248,007 local tokens, 63 fallbacks proposed/allowed, $0.1049 measured cloud cost. `rlm.db` agrees exactly: `local_ai_routing_events` last 24 h = `local/not-needed` 189 rows (1,248,007 tokens, first at 20:47:09, i.e. only after the rebuilt app started) and `frontier/allowed` 63. The 7d window shows the same 189 local, consistent with local-completion recording being new in this build. Whether the fallback *budget* is untouched by local work was not separately measured. |
| 5. Edit and acknowledge | **CLI PASS; Health Centre open** | `update afa37744-… '{"warningLatencyMs":15000}'` (value was already 15000) → `Updated windows-pc · LM Studio`; list unchanged otherwise. `acknowledge 51c88683-…` → `is now acknowledged`; `status` lists it as `acknowledged`. |

## Status — 2026-10-04

On main: yes (this landing commit)
Open: 5 (every check's CLI half passes; each still needs one read-only look at Monitoring → Local
AI Guard in the running app to confirm the UI matches) · Closed: 0 · Failed: 0.
New defect from check 1: LT-664 (incidents of a retired target never close).

## Evidence run — 2026-10-27 (resumed Plan Queue worker)

### Scope and environment

Read the completed plan's as-built notes, this document and the campaign runbook. Worktree
HEAD was `80412201a`; `git log main..HEAD` and `git diff main...HEAD` were empty, and the
worktree had no pending changes. This run made no product-code changes. The document remains
at its original absolute path in the root checkout and has not been copied or renamed.

Evidence directory, relative to the queue worktree:
`_scratch/lt-2026-10-27-local-ai-cli-parity/`. It contains command receipts, exact CLI outputs,
build/check logs, read-only SQL and results, a retained main-process log slice, and `seal.json`.
All times below are UTC (also London time on this date). Historical evidence above remains
historical; a successful CLI result is not a Health Centre observation.

Built `build:main`, `build:renderer` and `build:aio-mcp-dist` successfully in the supplied
worktree. The freshly built standalone CLI also answered `local-ai status --json` successfully
through the inherited parent-app connection. **That connection belongs to the existing packaged
app, not the disposable dev app.** CLI/shared-data results below are from that packaged app.

Attempted the required isolated dev launch at 07:48:22, using
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-4b39d4ca`, `--remote-debugging-port=9709`, and the
worktree's built renderer on a disposable local server at port 4589. The debug protocol became
reachable, but the app then failed: Electron logged `sandbox initialization failed: Operation
not permitted`, GPU/Network Service subprocess exits, and `GPU process isn't usable. Goodbye.`
The actual Electron process exit was `-5` (signal 5), **not a successful startup**. The launch
helper itself exited zero after collecting the failure and reaping its child; the receipts
explicitly distinguish these outcomes. No sandbox restriction was disabled. No renderer/DOM
assertions or Health Centre comparisons were made, so focus emulation was not used to support
any assertion. A future DOM run must enable it before inspecting the page.

Browser Gateway health at 07:45 reported `windows-pc` connected, its extension channel fresh,
and commands deliverable. Preflight of the debug URL selected no existing target. Windows
Chrome is not the Mac Electron Health Centre, so this is neither evidence that Windows is down
nor a UI comparison. No Mac browser or Computer Use fallback was used. The instruction to
preserve outstanding Health Centre comparisons remains in force.

### Results for every check

| Check | Current result | Dated evidence and exact residual |
| --- | --- | --- |
| 1. Status matches Health Centre | **CLI/shared data PASS; UI comparison OPEN** | 07:46:29 JSON and 07:47:16 text: one enrolled, healthy `windows-pc · LM Studio` target, all 12 expected routes, worker/endpoint/model/canary outcomes and ages, zero incidents. The 07:50:26 JSON remained healthy. Recursive inspection found no `message`, `probeMessage`, `evidence` or `evidenceText` keys. Read-only target and health-sample queries corroborated the target and fresh checks. **Still open:** observe that same target, state, routes and check ages in Monitoring → Local AI Guard. |
| 2. Rename LM Studio target | **CLI/shared data/routing PASS; UI card OPEN** | 07:47:17 `rename afa37744-ae04-4e0d-9efd-eca955d37777 "windows-pc · LM Studio"` confirmed the label. It already had that requested label, so this was an idempotent repeat, not a newly demonstrated different-label transition; the 2026-10-04 transition evidence is retained. Subsequent `list`, `status` and the database agree. Routing roles and configuration stayed identical apart from the later update timestamp. At 07:50:45.273 the packaged app dispatched `auxiliaryModel.generate` to `windows-pc`, request `coord-9469`, and at 07:50:49.879 it completed in 4606 ms. The matching local compression completion was recorded at 07:50:49.880 (`0a7f91b3-f902-4970-9ad7-4cceee1d9695`, `actual_route=local`, `disposition=not-needed`). The two exact log lines are retained in `auxiliary-route-log-slice.log`. **Still open:** observe the requested label on the Health Centre card. |
| 3. Run check | **PASS** | 07:47:44 lightweight recheck: worker/endpoint/model all `0s ago`; canary retained its earlier age. 07:47:50–51 functional recheck: all layers, including canary, `0s ago`. Inference `checkedAt=1793087270937`, duration 327 ms. The following status and persisted samples confirm timestamps advanced beyond the initial read, rather than merely printing cached ages. This check's stated steps require no Health Centre comparison. |
| 4. Effectiveness counts local work | **CLI/shared data/budget exclusion PASS; panel comparison OPEN** | At 07:46:30, 120 local tasks and 422,272 tokens; at 07:51:35, **121 of 124 tasks local (98%)**, 426,156 local tokens, 3 proposed/allowed fallbacks, zero deferred/blocked, and $0 measured/estimated cloud cost. SQL at 07:51:12 agrees exactly. Local rows span 2026-10-26 09:15:37 to 2026-10-27 07:50:49, exceeding the required 30-minute normal-traffic window in the existing app; this was not a new 30-minute run in the failed dev app. The new local completion increased both counters. No local row matches the paid-spend disposition filter. Global spend at 07:48:39 and after the completion at 07:51:12 remained $0 known / $0 estimated with 13,136 unknown reservations; the latter also includes the same outstanding historical reservations when using the actual UTC-day budget boundary. Global and target UTC-day spend queries return identical results with local rows included or explicitly excluded (target unknown reservations 760). These reservation counts are not represented as newly verified pricing or empty budgets. The focused spend regression also passed with a non-zero local cost estimate. **Still open:** compare the effectiveness panel with CLI figures from the same window. |
| 5. Edit and acknowledge | **Update PASS; conditional acknowledgement not exercised; UI comparison OPEN** | 07:47:51 `update ... '{"warningLatencyMs":15000}'` succeeded. The initial and final `list` both have 15000, the same configuration otherwise, and the final status is healthy; the later normal local completion confirms continued operation. No incident was open, so the conditional acknowledge step was skipped rather than inventing an incident or claiming a new acknowledgement. The 2026-10-04 acknowledgement evidence is retained. **Still open:** observe the Health Centre edit state and, when a genuine open incident exists or an isolated dev fixture can run, compare the CLI-acknowledged incident with the UI. |

Budget path inspected: `local-ai-routing-guard.ts:179` supplies the UTC-day boundary;
`local-ai-fallback-store.ts:220` calls `getLocalAiFallbackSpend` for global, target and incident
ceilings; `local-ai-fallback-spend.ts:22` selects only `allowed`/`pending-confirmation` rows.
Local completions use `not-needed` in `local-ai-routing-guard.ts:240`. The runtime hook is
installed in `local-ai-runtime.ts:400`, forwarding through `local-ai-auxiliary-bridge.ts:76`
from `auxiliary-local-ai-guard.ts:236`, reached after successful endpoint work in
`auxiliary-llm-service.ts:292`. These are source-path checks plus persisted live evidence,
not claims that the Health Centre was viewed.

### Existing defect and verification

The previously cited retired-target incident `51c88683-e9a8-4d29-84f5-1eafada561b4` is now
`resolved` in the live database, with `resolved_at=1791402554707`; no retired target has an
open or acknowledged incident. This no longer reproduces LT-664's historical stuck incident.
It does not independently exercise the new retirement transaction, so the register's separate
retire-with-an-open-incident acceptance is not closed by this observation. No new product defect
was reproduced. The dev launch permission failure is an environment failure, not a newly
diagnosed Local AI product defect; no remediation-register item was invented for it.

Current verification receipts all report exit zero for:

- `npm run build:main`
- `npm run build:renderer`
- `npm run build:aio-mcp-dist`
- Built standalone CLI `local-ai status --json`
- `npx tsc --noEmit`
- `npm run typecheck:spec`
- Focused quiet tests: CLI, authenticated RPC dispatch, management operations, fallback spend,
  and auxiliary success attribution (5 files, 80 tests)
- Read-only shared-data audit, including exact final CLI/SQL counter agreement

No full-suite or lint claim is made: this evidence run changed no product code. The isolated
dev app did not reach a usable renderer. No independent completion verdict is claimed; the
queue coordinator retains verification and document-renaming ownership.

The runbook asks for a backlog update, but the backlog's newer reconciliation header explicitly
says it is historical and directs current updates to the owning live-test document. This section
is that update; the historical backlog was left untouched.

Cleanup at 07:55:30: the owned Electron PID no longer exists; debug port 9709 and the
disposable renderer server port 4589 are closed. Removed the generated `dist/` tree and
`/tmp/aio-lt-queue-4b39d4ca` profile after writing the report, receipts and initial seal.
The pre-existing dependency installation was retained; no dependency or browser download was
made. Small test-runner logs/results were consolidated into the evidence directory before
removing their duplicate scratch copies. `cleanup.json` records these checks. No settings,
targets, automations or provider instances were created for this campaign. The existing label
and warning latency remain as requested; the no-op update advanced its normal update timestamp.
No commit, stash, branch/worktree creation or document rename was performed.

## Status — 2026-10-27

**Evidence recorded for all 5 checks. Fully passed: 1 (check 3). Still open: 4 (checks 1, 2, 4,
5), retaining every unobserved Health Centre comparison.** The supported CLI/shared-data portions
pass as qualified above. Check 5's current acknowledgement branch was inapplicable because no
incident was open. There is no new product defect and no new authority decision for James.

Remaining work needs a usable dev runtime and an approved way to observe the Health Centre;
the current dev launch's Electron sandbox permission failure is the technical prerequisite.
A packaged-app observation through hard-denied Computer Use is not an available substitute.
Do not infer UI parity from the database, or rename this document `_completed` from this run.

## Evidence run — 2026-10-27 (review correction, isolated live dev app)

### As-built scope and review findings

This section supersedes the preceding **current** open-check status, while preserving both
earlier evidence runs unchanged. The resumed checkout starts at `359a0706c`; `git log main..HEAD`
and `git diff main...HEAD` were empty, as was its working-tree status. The earlier worker's
evidence was read before continuing. No Local AI production source, tests, contracts or stored
production settings were changed in this correction. Changes in the queue checkout are the
campaign runbook, a newly reproduced navigation-defect register entry, and durable evidence.

Checkout fact-check: despite the task prompt saying the owner is absent from this worktree,
HEAD already contains a tracked October 4 copy at the same relative name. That historical
copy was not edited, copied, removed or used as the current owner; its bytes still match HEAD.
All current live-test evidence was appended directly to this root-checkout file as instructed.

Evidence is retained in the queue checkout at the repository-relative path
`docs/plans/2026-10-27-local-ai-cli-parity_evidence/`, including `REPORT.md`, command receipts,
exact CLI outputs, CDP DOM/snapshot captures, screenshots, assertion results, cleanup receipts
and a SHA-256 seal. The coordinator must retain this directory when integrating the branch.
Its current absolute location is
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-04-local-ai-cli-parity-39d4ca/docs/plans/2026-10-27-local-ai-cli-parity_evidence/`.

The old `_scratch/lt-2026-10-04/orch/` directory is absent. Those October 4 statements are
historical, **not independently re-checkable saved evidence**, and are not used to close any
current requirement. Fresh rename, recheck, update and acknowledgement receipts below replace
that dependency. The preceding October 27 raw evidence is also archived in the durable bundle.

### Runtime and fixture boundaries

Rebuilt the main process, renderer and standalone CLI in this worktree. The initial SEA build
under the shell's Homebrew Node failed because that binary lacks the SEA fuse; the same build
passes with the repository's pinned Node 24.22.1. The failed command and successful retry are
both retained. The renderer build retains its existing initial-bundle size warning.

Launched the worktree's Electron binary with
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-4b39d4ca`, renderer port 4589,
`--remote-debugging-port=9709`, `--no-sandbox --disable-gpu`, and
`--js-flags=--max-old-space-size=8192`. Main-process inspection used a separate port 9710.
The actual supervised app PID was 32343. An initial launch without the heap flag relaunched
as PID 9245; that app was explicitly stopped before recreating the disposable profile.
The runbook now documents the sandbox retry and the relaunch/PID ownership issue.

Every renderer assertion enabled focus emulation first and verified `document.hidden:false`,
`visibilityState:'visible'`, and completed animation frames. This Chromium does not implement
`Emulation.setPageVisibilityOverride`; its protocol error is retained, rather than reported as
success. A cached page reload left an empty `app-root`; a cache-disabled CDP reload while
holding the focus-emulated connection open restored the real page. Empty observations were
not counted as passes. No forced Angular change detection or patched DOM was used.

The dev profile has no paired Windows worker. Its target is an explicitly **synthetic
coordinator OpenAI-compatible HTTP endpoint**, not the real Windows LM Studio service.
It advertises a fixture model and answers the bounded canary. The real Local AI repositories,
scheduler, probes, management operations, renderer IPC/store and compiled CLI all run normally.
A test-owned authenticated RPC server in the dev main process uses those same management
operations; its capability is passed only through the CLI child's environment, never saved or
printed. The inherited `$AIO_MCP` remains the packaged-app connection and is used only for
labelled, read-only production observations in this correction.

### Per-check results

| Check | Result | New dated evidence |
| --- | --- | --- |
| 1. Status matches Health Centre | **PASS in isolated live runtime** | `dev-status-final-json.out`, `dev-status-final-text.out` and `dom-final.json`: the same target id, healthy target/aggregate state, all 12 routing roles, and worker/endpoint/model/canary outcomes. The final paired CLI and DOM capture at 08:11:47–48 have exactly equal layer timestamps, not merely similar printed ages. `dom-final.png` shows the rendered Health Centre. Recursive checks on both isolated and current packaged CLI JSON find no probe `message`, `evidence`, `evidenceText` or `probeMessage` keys. |
| 2. Rename LM Studio target | **PASS in isolated live runtime** | At 08:04:46 the CLI changes the fixture's distinct default label to `windows-pc · LM Studio`. `dev-list-before.out`, `dev-rename.out`, `dev-list-renamed.out` and `dom-renamed-ready.json` prove a genuine label transition and the matching card. Every other config field is identical apart from `updatedAt`. Three later calls through the actual `AuxiliaryLlmService.generate('compression', …)` reach the HTTP endpoint and return `source:'local'` with the same managed target id (`live-helper.json`); rename does not break routing. The original real-worker dispatch evidence remains separately archived. |
| 3. Run check | **PASS, freshly repeated** | At 08:11:47, `dev-before-lightweight-json.out` → `dev-lightweight-json.out` proves worker/endpoint/model timestamps advance while the prior canary timestamp is preserved. `dev-functional-json.out` then advances the canary. Both text commands also succeed; `dev-functional-text-final.out` prints all four layers at `0s ago`. No October 4 receipt is needed for this pass. |
| 4. Effectiveness counts local work | **PASS with explicit normal-history replay** | At 08:05:38 three actual helper dispatches increase the dev runtime from 0 to 3 local tasks and 78 local tokens; global fallback spend stays exactly $0 known / $0 estimated / 0 unknown reservations. At 08:07:19 a read-only production export captures **129 local of 132 tasks**, 440,803 local tokens, with normal local records spanning **22.847 hours**, from 2026-10-26 09:15:37 to 2026-10-27 08:06:27. Current packaged CLI summary agrees. Those bounded routing records are explicitly replayed into the disposable dev repository, with namespaced event ids and the fixture target id. Together with the 3 newly dispatched fixture calls, both the dev CLI and rendered panel show **98%, 132 of 135 tasks, 440,881 local tokens, 3 proposed/allowed fallbacks, 0 deferred/blocked, $0 measured/estimated cloud cost**. See `normal-traffic-replay-input.json`, `normal-traffic-replayed.json`, `dev-summary-final-json.out`, `dom-effectiveness-final.json` and its screenshot. This is a real panel/CLI comparison over the same dev data, plus independently observed normal production history; it is **not a new 30-minute normal-traffic wait in the dev profile**. |
| 5. Edit and acknowledge | **PASS in isolated live runtime** | The 08:04:47 CLI no-op update leaves `warningLatencyMs:15000` and every other config field intact apart from `updatedAt`; the live Edit form shows “Latency warning (milliseconds)” at 15000 (`dom-edit.json`). At 08:06:02 three deliberately failed HTTP probes produce a real scheduler-owned open fixture incident. `dom-incident-open.json` shows “open” with Acknowledge. At 08:06:15 the built CLI acknowledges it; `dev-incident-ack-status.out` and `dom-incident-ack.json` show the same incident as `acknowledged`, and its Acknowledge button is absent. Restoring the fixture and rechecking twice resolves the incident. This branch was actually exercised, not skipped because the packaged profile had no incident. |

The executable assertions in `evidence-assertions.json` pass for the rendered state and exact
timestamps, routes, distinct-label transition, unchanged config, both kinds of recheck, new
local attribution, unchanged fallback budget, normal-history duration, replay arithmetic,
panel metrics, Edit value, open/acknowledged incident transition and every CLI exit status.
This is implementer verification, not an independent completion verdict.

### New defect, verification and remaining boundaries

The CDP capture also records a real renderer exception in the control-page shell:
`findActiveSurfaceId` reads `current.snapshot.data` before the snapshot exists, through the
constructor's immediate router subscription. Filed as **LT-790** with observed behaviour,
root cause, required behaviour and acceptance in the queue worktree's remediation register.
Implementation is explicitly still open in the root-owned, untracked
`2026-10-27-control-surface-route-snapshot_plan.md`. The historical July `_completed` plan was
not extended; new scope belongs in that active follow-up. Local AI cards and panel render
and match the CLI despite that separately recorded shell error. No product fix is claimed.

Fresh commands passing in this correction: main build, renderer build, standalone CLI build
under pinned Node, both typechecks, seven selected CLI/management/budget/store/panel/incident
spec files, and the separately run auxiliary-success-attribution spec. The first selection
also named a nonexistent old service-spec path; the runner matched seven real files, so the
actual attribution spec was located and run separately. No tests were changed or suppressed.
Full-suite and lint were not repeated because this correction changes no product code or
tests; the coordinator retains the independent verification gate. The exact commands and
their exit results are retained, including failed harness attempts and the failed Node SEA
build. `git diff --check` passes.

The four previously unobserved comparisons have now been exercised in the isolated dev app,
with the fixture/replay qualifications above. Direct observation of the packaged app's own
screen, a newly paired dev Windows worker, and a fresh 30-minute dev traffic campaign were
not performed. None is represented as observed. No additional human authority is needed for
the recorded checks, and no production target, routing policy, credential or session was
changed. The old “sandbox failure means the UI cannot be checked” conclusion is superseded.

## Status — 2026-10-27, after review correction

**5 of 5 procedures have passing current evidence, using the explicitly isolated fixture and
normal-history replay where stated. Independent verifier acceptance remains pending.**
LT-790 is separately open and unimplemented; it is not silently counted as fixed.
The coordinator owns document closure. This file remains at its original root-checkout path
and its original `_livetest.md` name, with no worker commit, staging or branch change.

Runtime removal and the final integrity seal are recorded in the durable evidence bundle's
`cleanup-receipt.json` and `seal.json`. Preserve those receipts with the report when harvesting
this queue checkout; do not retain the disposable profile or compiled runtime.

> Plan Queue parked work: `queue/2026-10-04-local-ai-cli-parity-39d4ca` — 2 commit(s), reason: land-blocked.


## Evidence run — 2026-10-27 (campaign-defects queue worker)

Retirement lifecycle acceptance PASS: actual IPC retirement resolved staged open and acknowledged incidents, re-enrolment kept them resolved, and a newly staged stale retired-target incident resolved on a real app restart. Read-only production CLI status showed no incidents, and targeted read-only lookup found the former 51c88683-e9a8-4d29-84f5-1eafada561b4 incident resolved. No active production endpoint was changed. This does not close any separate Health Centre visual-parity clause.

Full scoped evidence: [campaign final handoff](2026-10-05-livetest-campaign-defects_livetest.md), with command/observation receipts in `2026-10-05-livetest-campaign-defects_evidence/2026-10-27-bd99c0f5/` in the assigned queue checkout. Source f5fffc23c653de06d1dfe409f74b0f776dc2e1db; isolated profile and all owned providers were stopped. No completed-name rename or source repair is claimed.


## Evidence run — 2026-11-10 (Plan Queue livetest worker a690a7, isolated dev app)

Worktree HEAD `08d54fbcb`, no product-code changes. Evidence (receipts, scripts, `REPORT.md`, `seal.json`, `cleanup-receipt.txt`) is in the worktree at `docs/plans/2026-11-10-local-ai-cli-parity_evidence/` (the directory is gitignored, so it stays in the worktree only). Times are UTC (London = UTC today).

**Environment.** Built `build:main`, a dev-config renderer and `build:aio-mcp-dist` from the worktree (exit 0). Launched the dev app with `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-25a690a7`, `--remote-debugging-port=9824`, `--no-sandbox --disable-gpu`. Every DOM read followed focus emulation (`hidden:false`, rAF fired). The freshly built CLI ran against the **dev app's own** orchestrator-tools socket using a capability minted for a real dev instance, so this run exercised the new RPC methods in this build, not the packaged app. The target is a **stand-in OpenAI-compatible server on the coordinator** (no paired Windows worker in a disposable profile), enrolled through `local-ai enrol` with all 12 routing roles. In the UI the page is named "Local models" under Control Center (the document says "Local AI Guard").

| Check | Result | Evidence (UTC) |
| --- | --- | --- |
| 1. Status matches Health Centre | **PASS (dev app, stand-in target)** | 07:12:36 DOM capture vs 07:12:35 `status`/`--json`: same target, Healthy aggregate (enrolled 1, healthy 1), same 12 routes, worker/endpoint/model checks 15-16s ago, canary "not checked" in both. Recursive scan of `--json`: no `message`, `probeMessage`, `evidence` or `evidenceText` keys. `receipts/03-*`, `dom-1.json`, `shot-card.png`. |
| 2. Rename | **PASS** | 07:12:42 `rename … "windows-pc · LM Studio"` confirmed; `list`, `status` and the card all show the label (a real change from the enrol-time default). Three later `AuxiliaryLlmService.generate('compression', …)` calls all routed to the managed target (`source:local`, `intendedTargetId` = the target). `receipts/04-*`, `05-helper-after-rename.json`, `dom-2.json`. |
| 3. Run check | **PASS** | 07:13:06 lightweight recheck advanced worker/endpoint/model timestamps (…771202 → …786431) and left the canary absent; functional recheck then set the canary (…786725), card showed Canary 1 ms 0s ago. `receipts/06-*`, `dom-3.json`. |
| 4. Effectiveness counts local work | **PASS (with stated limits)** | 32 real helper calls, one per minute from 07:13:15 to 07:44:19 (window ≥ 30 min, `traffic.log`; end marker 07:45:19). At 07:45 the CLI `summary` read **38 of 38 tasks local (100%), 1,550 local tokens, 0 proposed/allowed/deferred/blocked fallbacks, $0 measured/estimated**; the Local models panel showed the same figures (38 local tasks, 1,550 tokens, 0 fallbacks, $0.00). Fallback spend from the dev database before (07:13:37) and after (07:45:22): $0 known / $0 estimated / 0 unknown reservations, while local rows went 7 → 38 (all `local/not-needed`). `receipts/07-*`, `08-*`, `10-*`, `dom-4.json`. Limits: the traffic was driven through the real auxiliary service, not organic app helper calls; 2 early rows came from another worker's fake Ollama on 127.0.0.1:11434 before localhost Ollama was switched off in the throwaway profile. |
| 5. Edit and acknowledge | **PASS** | 07:44 `update <id> '{"warningLatencyMs":15000}'` succeeded; only `updatedAt` changed; Edit form showed "Latency warning (milliseconds)" = 15000. Stopping the stand-in server and four functional rechecks opened a real incident (`3f3b60aa-…`, open/warning/connection-refused); card showed Open + Acknowledge; 07:45:57 `acknowledge` → `status` lists it as acknowledged and the card shows Acknowledged with the button gone. Server restored; three rechecks resolved it and `status` returned healthy. `receipts/09-*`, `11-*`, `12-*`, `13-*`, `dom-5-open.json`, `dom-6-ack.json`. |

**Not observed.** The real windows-pc LM Studio target, the packaged app's own screen, and organic (not driven) helper traffic. Focused specs (CLI, RPC dispatch, management operations, fallback spend): 4 files, 84 tests, exit 0. No full suite or lint was run because no code changed.

**Findings, none filed as defects.** (a) A dev Claude instance created only to carry the CLI capability went `hibernated` after about 30 minutes idle and the next CLI call failed with `unknown orchestrator-tools instance`; recreating an instance fixed it. This is expected capability-bound behaviour, not a Local AI defect. The log also showed `Illegal lifecycle transition blocked hibernated → initializing` from the idle monitor during that hibernation; it is outside this document's scope and was not investigated. (b) After `Browser.close` and SIGTERM the dev Electron main process kept running and needed SIGKILL; only processes carrying this run's profile path or ports were killed. No new `LT-NNN` was added to the register.

## Status — 2026-11-10

**5 of 5 checks have passing current evidence from a fresh isolated dev app, with the stand-in target and driven-traffic limits above.** Independent verifier acceptance is pending; the coordinator owns closure and renaming. No code, settings or production state was changed; the dev profile, build output and processes were removed after the receipts and seal were written.

## Evidence run — 2026-11-10 (verification round 1 correction)

The verifier found that `seal.json` in `docs/plans/2026-11-10-local-ai-cli-parity_evidence/` listed a temporary file (`seal.json.tmp`) that no longer existed, so `shasum -a 256 -c seal.json` exited non-zero. The seal was regenerated over every other file in the bundle (212 files, itself excluded) and `shasum -a 256 -c seal.json` now exits 0 with every file OK. No receipt content, product code or check result changed; the 5-of-5 status above stands, with the stand-in target and driven-traffic limits unchanged. Independent verifier acceptance is still pending.
