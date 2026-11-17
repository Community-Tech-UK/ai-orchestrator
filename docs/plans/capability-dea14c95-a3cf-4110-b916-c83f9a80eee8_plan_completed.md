# Capability repair dea14c95-a3cf-4110-b916-c83f9a80eee8

## Status

On main: yes (this landing commit)
Active. Control built and checked in-loop (24 targeted tests pass, `npm run checks` green) and now probed in a running owned app (17 Nov, Windows PC WSL copy, no `--mac`): stand-in used, session parked, Close all removed it, restart cleared the folder. Awaiting the independent checker's own probe. A repaired control never marks its originating check passed.

Done: `resolveLiveTestClaudeStandIn()` (`src/main/app/live-test-context.ts`), adapter switch in `claude-cli-adapter.ts`, runner clears `live-test-overrides/` on start, stand-in script `scripts/remote-checks/claude-limit-stand-in.js`, four specs, and livetest checks 1 to 3 run once (evidence in `_history.md` Round 4).
Next: checker probes on a remote computer and reports the receipt. Steps: [livetest doc](capability-dea14c95-a3cf-4110-b916-c83f9a80eee8_plan_livetest.md).
Note: the test Mac stayed busy (load 22-29), but the PC's copy runs in WSL Linux and hosts the stand-in fine; start without `--mac`. The copy has no real Claude, which the probe does not need.
Decision: file in the owned profile (no env var, no dev-app.js change); unsafe file throws rather than falling back to the real CLI. Out of scope: hardened sessions, remote workers.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "disposable-provider-quota-limit",
  "check": "A quota-parked session closed with Close all is not revived when the limit resets",
  "requiredAction": "Provide a test-owned way to make one Claude session report a provider limit with a reset time a few minutes ahead, so the real provider-limit handler parks it.",
  "platform": "macos",
  "provider": "claude",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Checked real allowances (quotaGetProvider and provider status)",
      "observedAt": 1794812000000,
      "result": "Claude 54% used, Codex 44%, Antigravity 0%; Gemini returns IneligibleTierError (retired tier, not a quota stop); Copilot not signed in. No usable provider is at its limit."
    },
    {
      "operation": "Put a stand-in claude (stream-json limit events) first on PATH of the dev app",
      "observedAt": 1794812100000,
      "result": "The app resolved the real Claude binary; the stand-in was never started (no log written) and a real turn ran."
    }
  ],
  "alternative": "Exhausting a real allowance would spend the user's quota and cannot be arranged on demand.",
  "expectedResult": "The session parks with an auto-resume time; Close all removes it; after the reset time no process starts and no resume fires.",
  "implementation": "Add a test-only, profile-scoped override for the Claude CLI path (honoured only under the explicit live-test context), or a test-owned session control that injects a limit result, so a stand-in provider can be used; cover with a spec that the override is ignored outside a live-test profile and is removed with the profile."
}
</capability_evidence>

## Refined design (worker, 16 Nov 2026)

Cause, read from source: `buildCliPath` (`src/main/cli/cli-environment.ts`) puts `~/.local/bin`, `/opt/homebrew/bin` etc. before the inherited PATH, and `PosixSpawnCommandResolver` resolves bare `claude` with that PATH, so a stand-in on the app's PATH is always shadowed by the real binary.

Interface (smallest bounded): a file `<live-test profile>/live-test-overrides/claude`.
- `src/main/app/live-test-context.ts`: new `resolveLiveTestClaudeStandIn()`. Returns null outside a live-test context or when the file is absent. Inside one it requires the profile marker still present, the file to be a regular non-link file owned by this user, owner-executable, not group/world-writable, with a real path inside the profile; any other state throws (never falls back to the real CLI, which would spend quota).
- `src/main/cli/adapters/claude-cli-adapter.ts`: constructor calls `setSpawnCommand(standIn)` when non-null. Covers the session turns and the `--version`/`--help` probes of that adapter only; quota, auth and detection probes keep the real CLI.
- `scripts/remote-checks/live-test-copy.js` `prepareOwner`: deletes `live-test-overrides/` on every start, so a reused profile never keeps a stand-in.
- `scripts/remote-checks/claude-limit-stand-in.js`: stream-json stand-in that answers `--version`/`--help` and, on the first user message, emits a rejected `rate_limit_event` (reset N minutes ahead, default 3) and a 429 error result.
- Specs: `live-test-context.spec.ts` (ignored outside live test; rejects symlink, wrong owner, writable-by-others, non-executable, missing marker; accepts valid), `claude-cli-adapter` spec (command switched only when resolver returns a path), `live-test-copy.spec.ts` (cleared on start), a stand-in spec running the script.
- Not covered: hardened (Seatbelt) sessions, remote workers, Windows.
- Runtime probe and the original check: `capability-dea14c95-a3cf-4110-b916-c83f9a80eee8_plan_livetest.md`.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "A quota-parked session closed with Close all is not revived when the limit resets",
  "expectedResult": "The session parks with an auto-resume time; Close all removes it; after the reset time no process starts and no resume fires."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-dea14c95-a3cf-4110-b916-c83f9a80eee8_plan_history_d20fbc7bc417c886be12cfbff57deb5e1d752273f9536bd4b335e4e1cc3fc6e4_completed.md`.
