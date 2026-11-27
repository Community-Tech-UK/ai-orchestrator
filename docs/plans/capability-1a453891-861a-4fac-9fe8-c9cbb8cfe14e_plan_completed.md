# Capability repair 1a453891-861a-4fac-9fe8-c9cbb8cfe14e

## Status

On main: yes (this landing commit)
Active, round 2 (27 Nov). Done: `scripts/remote-checks/serving-window.js` + 27-test spec, checks green. Round 2 fix: the checker's probe stopped because the GPU still held 3,279 MiB (desktop apps) after unload, above the old 2,048 MiB default; the default is now 4,096 (the decision already in the livetest) with a test using the real reading. Routing pause: `get_setting`/`set_setting` on `auxiliaryLlmRoutingMode` work (read: `local-first`, writable, open); no `$AIO_MCP` needed. Next: re-run the probe on windows-pc ([livetest](capability-1a453891-861a-4fac-9fe8-c9cbb8cfe14e_plan_livetest.md)). A2 stays open until a real window with the benchmark key.
Evidence: `_history.md`.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "windows-local-model-serving-window",
  "check": "A2: frozen native serving and security proof (plan step 2)",
  "requiredAction": "Free the RTX 5090 (unload helper models), start the frozen llama-server with the benchmark key and prove 401/401/200 plus Tailscale-only binding",
  "platform": "windows",
  "provider": "llama-server",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Codex node task: list llama processes and GPU memory on windows-pc",
      "observedAt": 1795773532449,
      "result": "One llama-server (pid 32992); 29,903 of 32,607 MiB GPU memory in use."
    },
    {
      "operation": "Claude node task: read-only inventory on windows-pc",
      "observedAt": 1795773504826,
      "result": "Instance finished with no assistant message."
    },
    {
      "operation": "exec_on_node inventory",
      "observedAt": 1795773500000,
      "result": "Only curl https and literal PowerShell are allowed, so process and GPU inventory is refused."
    }
  ],
  "alternative": "A node agent session on the PC (Codex works) or a person at the PC",
  "expectedResult": "Frozen server answers only with the key, bound to Tailscale, helpers restored afterwards",
  "implementation": "Extend a node-side serving-window helper that pauses helper models, starts the frozen server, runs the 401/401/200 probe and restores helpers, with cleanup tests."
}
</capability_evidence>

## Design (refined from the proposal)

Reproduction (27 Nov): `exec_on_node` on windows-pc refuses `nvidia-smi` (only curl https and literal-text PowerShell are allowed; that restriction stays). `run_on_node` (a Codex agent) can run the commands but each window is hand-assembled. Read-only inventory showed `lms ps --json` fields `identifier, modelKey, path, ttlMs, contextLength, status, queued, parallel`; Node 24, `lms`, `nvidia-smi` on PATH; backend `...cuda12-avx2-2.60.0` present; one helper (35B, ctx 229376, parallel 2) holding 29,727 of 32,607 MiB.

Smallest bounded interface: one dependency-free Node script, `scripts/remote-checks/serving-window.js`, run by a `run_on_node` agent (or a person) on the PC with `node serving-window.js <inventory|start|stop|status> <config.json>`. No change to `exec_on_node` or any approval rule.
- Config is strict: owned `windowDir` (`plan-ex-ab-*` folder), backend folder must end in the frozen version (default 2.60.0), `.gguf` model, existing key file (never printed; optional `expectedKeySha256` binding), bind address must be a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48; never wildcard, LAN or loopback), port 1024-65535 and not LM Studio's 1234.
- `start`: snapshot `lms ps --json` and write it to the ownership record before unloading; refuse if a helper is busy or lacks what is needed to reload it; unload; require GPU used at or below a limit; start the detached frozen server (key by `--api-key-file`); prove listeners (every listener of that port or process is on the bind address, owned by the started pid); probe none/wrong/configured key and require 401/401/200; write a redacted receipt. Any failure stops the owned server and reloads the helpers.
- `stop`: kill only a process whose exe and creation time match the record (a stale record never kills another program); confirm the port is empty; reload helpers from the snapshot and read them back idle; optionally delete the key file; idempotent and retryable.
- Coordinator-side routing pause (`auxiliaryLlmRoutingMode`) stays a `$AIO_MCP settings` step outside this script (it is a Mac setting).

Acceptance: `scripts/remote-checks/serving-window.spec.ts` covers config refusals, busy/unrestorable helpers, GPU-not-freed rollback, wrong-bind rollback, probe-failure rollback, stale ownership, repeat `stop`, restore failure keeps the record. Probe on windows-pc is a live check.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "A2: frozen native serving and security proof (plan step 2)",
  "expectedResult": "Frozen server answers only with the key, bound to Tailscale, helpers restored afterwards"
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-1a453891-861a-4fac-9fe8-c9cbb8cfe14e_plan_history_3a0d6f331ee149998096ab4e54b8e99078284ca29369d5d8e4d2231104177957_completed.md`.
