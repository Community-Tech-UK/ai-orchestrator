# Capability repair df6fa124-0b22-4efc-ae38-25f643b40cba

## Status

On main: yes (this landing commit)
Built, awaiting independent review and the runtime probe. Two debug log lines now record what a Claude machine session starts with: `claude settings overlay` (role, key names, hook event names, numbers and switches; no hook commands) and `claude native limits` (the four spawn/concurrency/fork limits, numbers only). Done: code, specs, `npm run checks` green. Next: checker rebuilds the app, spawns a queue worker, reads both lines through logGetLogs and reports the probe. Probe steps are in the `_livetest.md` beside this plan. Evidence: `_history.md`. Round 1 verifier finding fixed: a queue worker runs in YOLO mode, where the builder deliberately adds no permission hooks, so its overlay line shows PreCompact only (no PermissionRequest); the probe expectation in the `_livetest.md` was wrong and is corrected, and a spec now covers the YOLO queue-worker path. Key finding: the limits are environment variables set in `claude-env-pack.ts`, not keys in the `--settings` overlay, so the proposal's single line became two.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "claude-spawn-overlay-read",
  "check": "Queue/loop/automation overlays contain the verified native depth/spawn/concurrency/fork limits and role-specific PreCompact preservation block alongside the existing permission hook",
  "requiredAction": "Read the settings overlay passed to a spawned Claude queue worker (key names only, no values of secrets)",
  "platform": "macos",
  "provider": "claude",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Read process arguments of the spawned claude process",
      "observedAt": 1795011800000,
      "result": "ps refused inside the session fence (operation not permitted)."
    },
    {
      "operation": "Searched the temp folder aio-claude-args-* directories for PreCompact",
      "observedAt": 1795011810000,
      "result": "Directories for this app's spawns held only MCP server lists or were already removed; no overlay content found; the overlay is not logged."
    }
  ],
  "alternative": "Unit tests cover the overlay builder; live behaviour of the compact hook was seen only indirectly.",
  "expectedResult": "A debug-level, redacted record of the overlay's top-level keys and limit values per spawn, readable through logGetLogs.",
  "implementation": "In claude-cli-argv-builder.ts, where the --settings overlay is materialised, add a debug log line (instance id, role, top-level keys, numeric limits, hook event names, no hook command text) like the prompt-size line in capability repair 289cd23b; test with a spec."
}
</capability_evidence>

## Refined design

Reproduction (item 1): `ps` is refused in the fence and the `aio-claude-args-*` folders hold no overlay. Reading the path: `buildClaudeCliArgs` in `src/main/cli/adapters/claude-cli-argv-builder.ts` materialises `--settings` and its only log line (`buildArgs complete`) carries no overlay content. The limits are set in `applyClaudeHygieneEnv` (`claude-env-pack.ts`) as `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `_MAX_SUBAGENTS_PER_SESSION`, `_MAX_CONCURRENT_SUBAGENTS`, `CLAUDE_CODE_FORK_SUBAGENT`. Neither place logged.

Changes: (1) `summarizeClaudeSettingsOverlay` plus a `claude settings overlay` debug line in `claude-cli-argv-builder.ts` (subsystem `ClaudeCliAdapter`); (2) a `claude native limits` debug line in `claude-env-pack.ts` (subsystem `ClaudeEnvPack`), machine roles plan-queue/loop/automation only, values shown only when 1 to 6 digits, otherwise `non-numeric`. Specs in `claude-cli-argv-builder.spec.ts` and `claude-env-pack.spec.ts` cover role, no hook command text, no overlay for plain/own sessions, caller-supplied values, and silence for ordinary and review sessions. No new interface, resource or approval path, so ownership/cleanup/cancellation do not apply. The separate worker-args builder (`cli-adapter-worker-args.ts`) builds no PreCompact or limits and is untouched.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Queue/loop/automation overlays contain the verified native depth/spawn/concurrency/fork limits and role-specific PreCompact preservation block alongside the existing permission hook",
  "expectedResult": "A debug-level, redacted record of the overlay's top-level keys and limit values per spawn, readable through logGetLogs."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-df6fa124-0b22-4efc-ae38-25f643b40cba_plan_history_f68396ba4960da40328c7a2fd3440f26128aa8f4ab57319187bd71711081afc5_completed.md`.
