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

Open: 5 (every check's CLI half passes; each still needs one read-only look at Monitoring → Local
AI Guard in the running app to confirm the UI matches) · Closed: 0 · Failed: 0.
New defect from check 1: LT-664 (incidents of a retired target never close).
