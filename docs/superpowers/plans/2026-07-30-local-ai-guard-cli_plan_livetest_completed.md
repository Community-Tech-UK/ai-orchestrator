# Local AI Guard CLI Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. A pending or unrun check is not
> automatically a defect, but a *reproduced* one belongs there. Per-check evidence stays in this
> file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: rebuild and restart Harness from the
> [Local AI Guard CLI plan](./2026-07-30-local-ai-guard-cli_plan_completed.md), confirm `windows-pc` is
> connected and advertising its OpenAI-compatible endpoint, then start a fresh local
> Harness-spawned agent whose shell contains `AIO_MCP`,
> `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET`, and
> `AI_ORCHESTRATOR_INSTANCE_ID`. Do not print those values.

## Status — completed 2026-09-27

Open: 0 · Closed here: 1 · Transferred residual campaign: 1 · Failed: 0

The read-only discovery/validation check passed. The two dependent `enrol` checks now live as one
bounded authorised campaign in
[RES-018](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-018--authorised-local-ai-guard-enrolment-and-duplicate-refusal).
They require both a currently advertised compatible model endpoint and explicit authority to reroute
eleven live auxiliary roles, so retaining a two-item source checklist added no independent work.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Check 1 — Discover and validate the Windows target | 2026-08-01 | `aio-mcp local-ai validate` output: worker/endpoint/model/inference all `ok: true`, `canaryOutputValid: true` in 640 ms (vs. 13,690–21,946 ms `malformed-inference-output` pre-fix on 2026-07-31); [LT-019](../../plans/livetest-remediation-register.md#lt-019-reasoning-models-exhaust-the-local-ai-exact-token-canary-budget) register entry |

## Checks 2–3 transferred — enrol, read back and duplicate refusal

Current evidence on 2026-09-27 supersedes the old disconnected-worker note: Browser Gateway health
reports `windows-pc` running with a fresh v0.2.36 extension channel. However, current auxiliary
discovery in the rebuilt isolated app returns only `ollama-localhost`, unhealthy with zero models;
the live settings file contains zero configured auxiliary endpoints; `ollama` is absent locally and
port 11434 refuses the connection. There is therefore still no compatible endpoint to validate or
enrol. The saved non-secret configuration remains at `_scratch/lag-config.json`.

Even after an endpoint is restored, `enrol` deliberately mutates the live routing for eleven roles.
That consequential mutation needs explicit authority. Duplicate refusal is inseparable from the
durable target created by the first command, so both checks moved together to RES-018.

## Completion

This source checklist is complete by one pass and one explicit residual transfer. Completion of
RES-018 will be recorded in the consolidated residual document rather than reopening this file.
