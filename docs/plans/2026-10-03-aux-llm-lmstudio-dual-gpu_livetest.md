# Auxiliary LLM on LM Studio (dual GPU) — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-03-aux-llm-lmstudio-dual-gpu_plan_completed.md](2026-10-03-aux-llm-lmstudio-dual-gpu_plan_completed.md)

**Prerequisites:**

- Rebuild and restart Harness from this checkout (`npm run build:main && npm run build:renderer &&
  npm run build:aio-mcp-dist`, then restart) and let windows-pc's worker reconnect. The code fixes
  below only run in a rebuilt app and a rebuilt `aio-mcp`; they are covered in-loop by unit specs,
  which is why these checks are deferred rather than skipped.
- windows-pc: LM Studio serving `qwen/qwen3.6-35b-a3b` (229376 ctx shared by 2 parallel slots,
  RTX 5090) and `qwen/qwen3.5-9b` (65536 ctx, RTX 3080 Ti). Configured and verified live on
  2026-10-03; the 35B moved from 131072 ctx with 4 slots to 229376 with 2 on 2026-10-04 (see
  [the follow-up plan](2026-10-04-local-ai-restart-canary-cadence_plan_completed.md)). Do not restore
  131072: two concurrent ~96k compressions exhaust it. Neither needs the rebuild.

## 1. Retire the legacy Ollama Local AI target

Why deferred: `local-ai set-lifecycle` is new CLI/RPC surface; the running app predates it.

Steps:

```sh
$AIO_MCP local-ai list --json            # note the ollama target id (733d66c0-… on 2026-10-03)
$AIO_MCP local-ai set-lifecycle 733d66c0-7e97-49cd-82e6-5462234237b9 retired --json
$AIO_MCP local-ai list --json
```

Expected: the command prints the target with `"lifecycle": "retired"`; the final list shows only
the `openai-compatible` LM Studio target (afa37744-…). No further Ollama canary runs (Ollama stays
stopped on windows-pc).

## 2. Tier models route to LM Studio even when Ollama is advertised first

Why deferred: needs the rebuilt routing code and a worker reporting both endpoints.

Steps: start Ollama on windows-pc without loading a model; temporarily set
`auxiliaryLlmEndpointsJson` to `[]` (re-enables auto-discovery of the worker Ollama endpoint);
trigger auxiliary traffic (open a session; title generation and compression run); read
`~/Library/Application Support/harness/logs/app.log` for `auxiliaryModel.generate` dispatches.
Then restore `auxiliaryLlmEndpointsJson` to the disabled-Ollama entry and stop Ollama again.

Expected: every dispatch shows `provider: openai-compatible` with `qwen/qwen3.6-35b-a3b` (quality)
or `qwen/qwen3.5-9b` (quick); none go to Ollama.

## 3. `exec_on_node` explains its allowlist

Why deferred: coordinator copy and error text change only after restart.

Steps: call `exec_on_node` on windows-pc with executable `tasklist`, args `[]`.

Expected: refused with text that names curl https and literal-output PowerShell and points to
`run_on_node`, instead of only "cannot launch or drive the operator's shared Chrome/session".

## 4. `run_on_node` accepts Windows OS wording

Why deferred: classifier change needs the rebuilt coordinator.

Steps: `run_on_node` on windows-pc with prompt
`Read-only: on this Windows PC, report the real GPU memory use with nvidia-smi.`

Expected: an instance starts (no "cannot access Browser Gateway" refusal).

## 5. Reboot survival on windows-pc

Why deferred: needs a real logon. The task was run manually on 2026-10-03 (LastTaskResult 0,
both models reloaded with the right contexts and GPUs).

Steps: after the next windows-pc reboot and logon, wait two minutes, then run `lms ps` and
`nvidia-smi --query-gpu=index,name,memory.used --format=csv,noheader` there and read the tail of
`%USERPROFILE%\.lmstudio\aio-loader\start.log`.

Expected: both models loaded, the 35B at context 229376 with 2 parallel slots (changed
2026-10-04, see the follow-up plan) and the 9B at 65536; about 28.4 GB used on the 5090 and
about 8.6 GB on the 3080 Ti; the log ends with `AIO LM Studio models loaded successfully`.

## 6. Local routing resumes promptly after a Harness restart

Added 2026-10-04 by the follow-up
[2026-10-04-local-ai-restart-canary-cadence_plan_completed.md](2026-10-04-local-ai-restart-canary-cadence_plan_completed.md).
Why deferred: needs the rebuilt scheduler and a restart.

While Harness runs, the canary repeats every ten minutes, so it never gets old enough on its own.
The canary has to age while Harness is closed.

Case A (stale evidence, the 2026-10-04 incident): note the LM Studio target's last canary time in
the Health Centre, quit Harness, keep it closed until that canary is more than twelve minutes
old, then start Harness. Watch the Health Centre and
`~/Library/Application Support/harness/logs/app.log`.

Expected A: a canary runs within about a minute of the worker reconnecting, the target leaves
"Checking", and `auxiliaryModel.generate` dispatches go to LM Studio. No run of
`health-checking` fallbacks lasting ten minutes, as seen on 2026-10-04 10:45–10:55.

Case B (quick restart): restart Harness when the last canary is only a few minutes old.

Expected B: the target routes within seconds of the worker reconnecting (the first lightweight
check succeeds and the canary evidence is still fresh), and the next canary
runs about ten minutes after the previous canary, not ten minutes after the restart.

## Evidence run — 2026-10-04 (orchestrating session, packaged app)

Environment: `/Applications/Harness.app` built 19:06 from `3d05e250e` (contains `set-lifecycle`,
the new `exec_on_node` copy and the `run_on_node` classifier — confirmed by bundle search), started
20:45:59 BST. `$AIO_MCP` binary also built 19:06. `windows-pc` connected, worker 0.1.0. Evidence
copies: `_scratch/lt-2026-10-04/orch/`.

| Check | Verdict | Evidence |
| --- | --- | --- |
| 1. Retire legacy Ollama target | **PASS** | The Ollama target `733d66c0-…` was already `retired` in `rlm.db` (`retired_at` 2026-10-04 12:47:34, set by an earlier session). Re-running `local-ai set-lifecycle 733d66c0-… retired --json` at 23:19 against the rebuilt app exited 0 and printed the target with `"lifecycle":"retired"`; `local-ai list --json` then showed only `afa37744-…` (`openai-compatible`, enrolled). No Ollama canary entries appear in the current `app.log` (covers 10:54 onward). Two side observations: re-retiring overwrote `retiredAt` with the new time (`local-ai-target-repository.ts:142` sets `retiredAt: updatedAt` unconditionally, unlike the `current.retiredAt ?? now` at :63), so the original retirement time is lost — minor, not filed; and the retired target's old `connection-refused` incident stayed **open** — filed as LT-664. |
| 2. Tier models route to LM Studio when Ollama is advertised first | **NOT RUN** | Needs Ollama started on `windows-pc` plus a temporary `auxiliaryLlmEndpointsJson: []` on James's live app, which re-enables auto-discovery while his sessions are using auxiliary routing. Left for a coordinated window rather than mutating live routing unattended. Current routing is already LM Studio-only: 189 local / 0 Ollama dispatches since 20:47 (`local_ai_routing_events`). |
| 3. `exec_on_node` explains its allowlist | **PASS** | 23:21:02, `exec_on_node {node: windows-pc, executable: tasklist, args: []}` → `exec_on_node refused this command. It only runs curl with an https:// URL and PowerShell that writes literal text (Write-Output, Write-Host, Write-Error, Write-Verbose, Write-Warning, exit N), so it can never launch or drive the operator's shared Chrome/session. Use run_on_node for anything else, including diagnostics such as tasklist, nvidia-smi or Get-CimInstance.` The tool description carries the same guidance. |
| 4. `run_on_node` accepts Windows OS wording | **PASS** | 23:21:11, `run_on_node {node: windows-pc, provider: antigravity, prompt: "Read-only: on this Windows PC, report the real GPU memory use with nvidia-smi."}` → instance `i109u6v1y` started (no Browser Gateway refusal) and answered: RTX 5090 ~28.5 GB used, RTX 3080 Ti ~8.6 GB used. Instance terminated afterwards. |
| 5. Reboot survival on windows-pc | **NOT RUN** | Needs a real Windows reboot and logon. Today's GPU reading (28.5 / 8.6 GB) matches the expected loaded state but says nothing about reboot survival. |
| 6. Local routing resumes promptly after a Harness restart | **NOT RUN** | Needs a Harness quit/restart with timed canary ageing — James's action. Partial signal only: after today's 20:45 restart the first local completion was recorded at 20:47:09 (`local_ai_routing_events`), but the canary age before the restart was not captured, so neither case A nor B is proven. |

## Status — 2026-10-04

Open: 3 (checks 2, 5, 6 not run) · Closed: 3 (checks 1, 3, 4) · Failed: 0. LT-664 is a side
finding from check 1, not a check failure.
