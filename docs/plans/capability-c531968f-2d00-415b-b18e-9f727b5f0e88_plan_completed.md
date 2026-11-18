# Capability repair c531968f-2d00-415b-b18e-9f727b5f0e88

## Status

On main: yes (this landing commit)
Active. No product code change this round; earlier test fix (update-connection-cli.spec.ts compared the raw ACL ID, not the resolved name) stands. 18 Nov 2026: the control works. `dev-app.js start --remote-only` on tree 6dd16941c7db2f964d2847616ac193032a545d55 started a copy on ct-test-mac (exit 0, receipt printed), CDP answered (Electron 42.11.18, Harness(Dev)), a page reload brought the renderer back on the same page, and `stop` removed the copy. Windows PC SSH relay also answered `ok` this time. Next: the independent checker repeats the probe and reports it through plan_queue_report_capability_probe. Evidence: `_history.md`.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "dev-app-remote-computer",
  "check": "Normal-command renderer first paint (steps 1 and 2 passed on the current tree) and session reload",
  "requiredAction": "Start the isolated dev app on a remote computer and drive it over CDP for the session reload step",
  "platform": "any",
  "provider": "harness",
  "classification": "setup",
  "attempts": [
    {
      "operation": "dev-app.js start with the seeded profile, restart on the Windows PC",
      "observedAt": 1794847900000,
      "result": "Remote reported ready but the SSH tunnel timed out at the banner exchange; later status said the PC could not be reached."
    },
    {
      "operation": "dev-app.js start --remote-only, waited about an hour",
      "observedAt": 1794849500000,
      "result": "Test Mac busy at load 128 to 194 on 10 processors and the PC unreachable, so no copy started; independent checks showed windows-pc connected to Harness and answering tailscale ping."
    }
  ],
  "alternative": "This Mac is barred for desktop apps without James's consent and the worker cannot ask.",
  "expectedResult": "A dev app copy starts on a free remote computer and the session reload step runs with evidence.",
  "implementation": "None needed in code: re-run the deferred step when the PC's SSH side or the test Mac is available."
}
</capability_evidence>

## Refined proposal

The proposal in the evidence ("none needed in code") holds. Call path read: `dev-app.js start` -> `copyMachines` (test Mac, then PC) -> `lookAt` -> `sendScript` over SSH -> `busyReason` (load >= 1.5 per core) -> waits `RECHECK_MS` and looks again; never exits for busy. No permission decision is involved. Observed 16 Nov 2026 around 20:25 to 20:30 BST:

- Test Mac: reachable, no copies, 5-minute load 138 to 180 on 10 processors from other agents' remote test runs. Correctly reported busy.
- Windows PC: Harness worker connected (latency 1 ms), but `ssh harness-checks` (via Tailscale `:2222` into the `harness-checks` WSL distro) connects and then times out at the banner exchange. A read-only diagnostic on the PC showed sshd active and idle, listening on 2222, last log line three hours earlier, while `wslrelay` (pid 7632) holds 127.0.0.1:2222 with a CloseWait socket. Inferred, not tested: the relay stopped forwarding; the restart would be `wsl.exe --shutdown` (kills the distro's other work) or ending `wslrelay.exe`, a change on that computer this plan does not authorise.

Acceptance for the deferred step is in `capability-c531968f-2d00-415b-b18e-9f727b5f0e88_plan_livetest.md`.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives. (Done; see Refined proposal and `_history.md`.)
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions. (Done: no code needed.)
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant. (Not applicable: the control `scripts/remote-checks/dev-app.js start --remote-only` already exists, with its own tests in `dev-app.spec.ts`; no source was changed.)
- [ ] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Normal-command renderer first paint (steps 1 and 2 passed on the current tree) and session reload",
  "expectedResult": "A dev app copy starts on a free remote computer and the session reload step runs with evidence."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-c531968f-2d00-415b-b18e-9f727b5f0e88_plan_history_74e118e4c1a9f949e0bacc28a862e200cc47f459aa66cbadaa5baca898e0a071_completed.md`.
