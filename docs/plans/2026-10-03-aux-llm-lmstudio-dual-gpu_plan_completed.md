# Auxiliary LLM: LM Studio on both worker GPUs — plan

Status: COMPLETED (2026-10-03). Checks that need a rebuilt and restarted Harness, or a
windows-pc reboot, are in
[2026-10-03-aux-llm-lmstudio-dual-gpu_livetest.md](2026-10-03-aux-llm-lmstudio-dual-gpu_livetest.md).

## Why

James reported windows-pc fans at full speed. Diagnosis (2026-10-03):

- Ollama `gemma4:31b` (dense 31B) ran on the RTX 5090 at ~94% / ~496 W for the
  auxiliary LLM `quality` tier, with `deepseek-r1:7b` (always-thinking, Jan 2025)
  as the `quick` tier on the same card. The RTX 3080 Ti sat idle.
- A Local AI Guard target enrolled on the worker Ollama endpoint runs a
  `gemma4:31b` canary every 10 minutes. Its request set no `keep_alive`, so the
  worker's `OLLAMA_KEEP_ALIVE=24h` pinned the 20 GB model, and no `num_ctx`, so
  Ollama reloaded the model at its default context and the next auxiliary call
  reloaded it again.
- Auxiliary calls sized `num_ctx` per call, so slots sharing the quality model
  also forced reloads (observed: resident context flipping 32768 → 8192).
- LM Studio 0.4.25 was installed with newer models downloaded, but its server
  was off, its default context is 8192, and JIT loading evicts the previous JIT
  model.

James asked (2026-10-03): use LM Studio instead of Ollama, the correct model,
provider and context window, put the small model on the 3080 Ti, and fix the
other issues found.

## Decisions

- Quality tier: `qwen/qwen3.6-35b-a3b` (35B MoE, ~3B active) on the RTX 5090,
  loaded at 131072 context (compression budget 96000 in + 4096 out).
  AA-LCR non-reasoning 64% vs Gemma 4 31B 47% (artificialanalysis.ai, checked
  2026-10-03).
- Quick tier: `qwen/qwen3.5-9b` on the RTX 3080 Ti, loaded at 65536 context
  (largest quick slot is loopScoring 32000 in + 1024 out).
- Keep two tiers: the quick model gives latency isolation from long compression
  prefills on an otherwise idle GPU.
- Ollama stays installed but is removed from auxiliary routing and stopped on the
  worker so the legacy canary cannot reclaim the 5090.
- `exec_on_node` keeps its narrow allowlist; only its refusal text and
  description change. Widening a security allowlist was out of scope.

## Work items (as built)

### Worker machine (windows-pc), live

1. [x] LM Studio server running (`lms server start`, port 1234).
2. [x] Models pinned per GPU with the LM Studio SDK per-load `gpu` config
       (`disabledGpus`), no TTL, via `%USERPROFILE%\.lmstudio\aio-loader\load-models.mjs`.
       Evidence: after unloading a stray JIT model, 5090 25.9 GB / 3080 Ti 8.6 GB used;
       `lms ps` contexts 131072 / 65536. Scheduled Task "AIO LM Studio models" (at logon,
       60 s delay) runs `start-aio-models.ps1`; a manual run returned 0 and reloaded both
       models. The first manual run exposed a stderr/ErrorActionPreference bug in the
       script, fixed before the passing run.
3. [x] Ollama models unloaded and processes stopped; startup shortcut moved to
       `%USERPROFILE%\.ollama\disabled-autostart\Ollama.lnk` (no Run-key entry existed).
       `OLLAMA_*` variables untouched.

Behaviour evidence over the OpenAI-compatible API: JSON scoring replies with empty
`reasoning_content` in 0.52 s (35B) and 0.64 s (9B); a 60,542-token prompt answered by the
35B in 10.5 s with 0 reasoning tokens. Generating power on the 5090 measured ~297 W against
~496 W before.

### Harness settings, live (via `$AIO_MCP`)

4. [x] `auxiliaryLlmQualityModel` = `qwen/qwen3.6-35b-a3b`,
       `auxiliaryLlmQuickModel` = `qwen/qwen3.5-9b`.
5. [x] `auxiliaryLlmEndpointsJson` persists the worker Ollama endpoint with
       `enabled: false`.
6. [x] Local AI Guard target `afa37744-…` enrolled for the worker LM Studio endpoint, both
       models required with `minContextLength`, canary on the 9B every 10 minutes
       (validation canary 263–373 ms).

Live routing after the change (app.log): 35 quality dispatches to `qwen/qwen3.6-35b-a3b`,
4 quick dispatches to `qwen/qwen3.5-9b`; the only failures were two compression calls during
the deliberate model reload at 22:55, which fell back as designed.

### Code fixes (take effect after app rebuild/restart)

7. [x] Routing: `resolveFirstEligible` in `auxiliary-llm-service.ts` returns the first
       endpoint advertising the pinned/tier model and auto-picks only when none does.
8. [x] `OllamaNumCtxHighWater` (per endpoint and model) never shrinks the `num_ctx` sent
       in a session, so a smaller call cannot force Ollama to reload a model a larger call
       loaded. Replaced a first design (size every call to the largest slot budget sharing
       the model) after the completion gate showed it still alternated, at larger sizes, when
       both tiers auto-pick one model, and over-allocated on small hosts. A window is only
       remembered after a call at that size succeeds (`sizeFor` / `recordSuccess`), so a
       failed oversized load cannot pin later calls to the failing size.
9. [x] Ollama requests send `think: false` (coordinator client, worker generator, worker
       canary). Ollama only rejects `think: true` for models without thinking support
       (research read of Ollama `server/routes.go`, 2026-10-03; not run against
       a live Ollama because it is now stopped on the worker).
10. [x] Worker canary reuses the resident Ollama context and sends `keep_alive`. The extra
        `/api/ps` request is counted in both health-check timeout budgets
        (`healthRpcBudget` in the probe service, `functionalProbeRpcTimeoutMs` in the CLI);
        the first full test run caught it missing.
11. [x] `exec_on_node` refusal text and tool descriptions state the allowlist.
12. [x] `run_on_node` browser-intent classifier no longer reads "Windows" (the OS, the
        worker name, registry paths) as a browser window.
13. [x] `aio-mcp local-ai set-lifecycle <id> <enrolled|paused|retired>` (CLI, RPC method,
        public operation; docs in `docs/AIO_MCP_CLI.md` and the LLM reference).
14. [x] Prompt truncation keeps less than 60% when 60% would still exceed the slot budget
        (LM Studio rejects over-long prompts at a fixed loaded context).
15. [x] Worker Ollama generation moved into `worker-auxiliary-generate.ts` beside the LM
        Studio generator (keeps `worker-rpc-dispatcher.ts` under the 700-line ratchet).

### Not changed, noted

- The legacy Ollama Local AI target `733d66c0-…` is still enrolled; retiring it needs the
  new CLI in a rebuilt app (livetest check 1) or the Settings UI.

## Verification

- Targeted specs for every code item, each new regression test confirmed to fail without
  its fix (routing, Windows-OS classifier).
- `tsc --noEmit`, `typecheck:spec`, `lint`, `build:main`, `build:renderer` pass.
- Full `test:quiet`: the only failures are outside this work (the other session's in-flight
  `orchestrator-tools*.evidence` specs, and a `serve-review` spec that passes alone).
- Fresh-eyes completion gate: pass 1 FAIL (spec typing; cross-tier `num_ctx`), pass 2 FAIL
  (high-water recorded before success); all fixed. Pass 3 (2026-10-03): VERDICT PASS, no
  actionable findings.
- Final full `test:quiet`: 1 of 29406 failed, in the other session's in-flight
  `src/main/chats/chat-transcript-bridge.standalone.spec.ts`.

## Follow-ups noted by the gate (not required)

- `src/main/mcp/aio-mcp-dispatcher.ts` top-level help still says "Discover, validate, and enrol"
  (already incomplete before this work; `local-ai --help` lists every subcommand).
- `think: false` for Ollama is verified from source, not against a live server.
