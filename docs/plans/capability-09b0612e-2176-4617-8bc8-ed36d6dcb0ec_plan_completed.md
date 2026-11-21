# Capability repair 09b0612e-2176-4617-8bc8-ed36d6dcb0ec

## Status

On main: yes (this landing commit)
Built, awaiting independent review and the runtime probe. A live-test copy of Harness now reads an optional `codex-config-overlay.toml` from its own data folder and adds its `[mcp_servers.<name>]` entries to each Codex session home; nothing else changes, and `~/.codex` is never written. Review fixes: a bare `[mcp_servers]` table or `mcp_servers = ...` key is refused (round 1); now only standard two-part `[mcp_servers.<name>]` tables pass, so sub-tables, dotted root keys and array tables are refused too (round 2). Unit tests, typecheck and lint pass (re-run 21 Nov after the seventh resume; no code change since). The last park was because no computer had Codex; it is now installed on the test Mac (sign-in is for the copy to confirm). Builds passed before. Not yet done: the checker's probe on the test Mac (`dev-app.js start --needs codex --mac`) and the originating check; steps are in `capability-09b0612e-2176-4617-8bc8-ed36d6dcb0ec_plan_livetest.md`. Round evidence: `..._history.md`.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "isolated-codex-home-for-broken-tool-server",
  "check": "Against a disposable deliberately broken tool-server configuration, obtain a real deployed Codex diagnostic sample.",
  "requiredAction": "Run a Codex session against an isolated Codex home with a deliberately broken tool server, without touching the shared real Codex config.",
  "platform": "macos",
  "provider": "codex",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Project .codex/config.toml with a missing-binary tool server (11 Nov run)",
      "observedAt": 1794836000000,
      "result": "Codex answered normally; no diagnostic; project config appears ignored while untrusted."
    },
    {
      "operation": "Inspect where the dev app reads Codex config on 16 Nov",
      "observedAt": 1794836300000,
      "result": "Harness's Codex home is the real ~/.ai-orchestrator/codex/config.toml, shared with the installed app; editing it is outside test authority and a copied home would need sign-in tokens."
    }
  ],
  "alternative": "Parser/routing unit tests cover the diagnostic shape but not the real deployed Codex event stream.",
  "expectedResult": "One plain tool-server message per turn/category with the server's safe display name; raw details only under Details; config restored afterwards.",
  "implementation": "Let a dev-app session set a per-profile Codex config overlay (for example an AIO_DEV Codex config path honoured by the Codex home builder) that is deleted with the dev data folder, so a broken tool server can be configured without the real config or credentials. Tests: overlay is used only in dev profiles and is removed on cleanup.",
  "repairRepository": "/Users/suas/work/orchestrat0r/ai-orchestrator"
}
</capability_evidence>

## Implementation and acceptance

Refined design (item 2). Codex homes are built in `src/main/cli/adapters/codex/codex-home-manager.ts`, which copies `~/.codex/config.toml` (the real one, shared with the installed app) into a private per-session home. Overlay: `<live-test data folder>/codex-config-overlay.toml`, read by new `codex-live-test-overlay.ts` and merged into all three home-building paths. Bounds: only inside a validated live-test copy (`getHarnessLiveTestDataPath()`, new, from `live-test-context.ts`); a regular non-symlink file, owned by the user, not group/other-writable, at most 16 KB; `[mcp_servers.<name>]` standard tables only (any other entry, including a bare `[mcp_servers]` table or key, a sub-table, a dotted root key or an array table, is refused); same-named real servers are replaced; an unusable file fails the session start. It goes away with the data folder. Docs: `docs/testing.md`.

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives. (Call path read: the home builder only ever reads `~/.codex/config.toml`; no per-profile setting exists. No provider turn was run; see history.)
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project's required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Against a disposable deliberately broken tool-server configuration, obtain a real deployed Codex diagnostic sample.",
  "expectedResult": "One plain tool-server message per turn/category with the server's safe display name; raw details only under Details; config restored afterwards."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-09b0612e-2176-4617-8bc8-ed36d6dcb0ec_plan_history_5757a59a48d3eb8e52a00a46f7928316c4b3d132c05664a40c03a2c90fb0756c_completed.md`.
