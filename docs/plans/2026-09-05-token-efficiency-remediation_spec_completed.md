# Token efficiency remediation

Status: implemented and verified; all canonical checks and fresh independent completion review passed. Uncommitted. Live rollout and measured savings remain pending in the linked check document.

Implementation: [plan](2026-09-05-token-efficiency-remediation_plan_completed.md).
Live rollout: [pending checks](2026-09-05-token-efficiency-remediation_livetest.md).
Evidence: [usage audit](../audits/2026-09-05-astra-token-efficiency-audit.md).

## 1. Accurate consumption

Account for all observed Codex internal calls, cached input and reasoning without counting subsets twice. Deduplicate cumulative snapshots, handle resumed baselines and resets, isolate child occupancy, preserve partial failed/interrupted spend, and avoid charging a completion twice. Subscription quota remains provider-reported and separate from API-equivalent estimates. Expose uncertainty where the provider does not report model or tier.

## 2. Memory that reaches the adapter

Replace arbitrary middle truncation with deterministic block budgets. Preserve governing instructions and tool permissions, reserve bounded space for advisory memory, remove exact duplicate instruction content only when proven identical, and make manifest sizes/hashes match delivered blocks. Never infer that native Codex loaded a file merely because it exists. Apply advisory budgeting across providers; preserve stable order and first-turn/resume behavior.

## 3. Smaller compatible tool discovery

Investigate a stable search/describe/validated-execute surface for snapshotting MCP clients. Enable only with invocation and security-path evidence. Preserve approval, credential and argument validation. Retain compatibility fallback when the installed client cannot support the optimized surface.

## 4. Safe operating controls

Improve producer-side output guidance without hiding failures or weakening full-file investigation and completion review. Make cost/context observations useful before enforcing interventions. Do not enable gross cumulative-token compaction, rewrite selected models/effort, or run paid quality benchmarks merely to demonstrate savings. Record concrete rollout checks for client-dependent experiments and measured savings; fixes are not proof of a particular percentage reduction.

## 5. Acceptance

Regression evidence covers multiple calls, duplicates, resets, cache/reasoning subsets, failed/interrupted turns, child events, deterministic memory delivery, and relevant MCP validation. Run all canonical project gates and an independent fresh completion review. Preserve other work; no branch, commit, push or live setting change is required.
