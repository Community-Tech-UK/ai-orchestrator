# MiMo reasoning-cap cut-off: installed-app live checks

Status: pending; both checks unexecuted.
Plan: [2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md](2026-10-14-mimo-reasoning-cap-cutoff_plan_completed.md). Register item: [LT-706](livetest-remediation-register.md#lt-706).

> If a check reproduces a defect, record a new LT-NNN in
> [the remediation register](livetest-remediation-register.md), with observed behavior,
> root cause, required behavior and acceptance. Create an active follow-up implementation
> plan linked from the register. Keep per-check evidence here.
> Read [the campaign runbook](livetest-campaign-runbook.md) before running these checks.

## Prerequisites

An app built from this checkout and restarted at a safe time by James (never restart a Harness
with live sessions). A disposable root OpenCode session on a MiMo v2.6 Pro token-plan account,
outside a managed loop, orchestration unpaused. Record instance ID, OpenCode version and log
window. Never capture thinking, task source or credentials as evidence.

Why deferred: needs the rebuilt installed app plus a real MiMo step that exhausts its budget;
neither can be produced deterministically in the agent loop.

## 1. Cap reaches the session

Start the session and send one bounded ordinary task.

Expected: `app.log` `ACP turn completed` shows `generationBudget.combinedOutputTokens: 32000`;
the ordinary turn is `classifierReason: "completed"` and no continuation is sent.

## 2. Reasoning-saturated step is a visible cut-off

Give a task that makes MiMo reason past the cap in one step (for example a large multi-plan
analysis that asks for a full plan before any tool use).

Expected: when OpenCode's message record shows `finish: "length"` with reasoning near 32000 and
near-zero output, the `AcpCliAdapter` `ACP turn completed` line shows `classifierReason: "max_output"`
and `evidence: "budget_saturated"`, the `ProviderTurnEnding` line (which logs no `evidence` field)
shows `classifierReason: "max_output"`, the transcript shows the output-limit
notice, and Harness sends at most two automatic continuations across the user turn. Cross-check
with `sqlite3 -readonly ~/.local/share/opencode/opencode.db` on the session's latest assistant
message (`finish`, `tokens.output`, `tokens.reasoning`).
