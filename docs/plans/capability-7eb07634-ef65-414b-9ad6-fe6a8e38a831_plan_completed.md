# Capability repair 7eb07634-ef65-414b-9ad6-fe6a8e38a831

## Status

On main: yes (this landing commit)
Active. Implement the bounded missing control, independently verify it, then rerun the originating check. A repaired control never marks its originating check passed.

Built: tunnel retry (3 tries), stale-tunnel stop and far-side probe in `scripts/remote-checks/dev-app.js` and `remote-run.sh`, with specs. Passed: dev-app spec (112), `npm run checks`, a real forced-failure run and a real normal run on the Windows PC (CDP reached, copy stopped cleanly). Open: independent review and the checker's runtime probe on the reviewed checkpoint (`start --windows`, attach CDP, stop). Cause is inferred from timings (slow tunnel session), not seen directly. Evidence: `capability-7eb07634-ef65-414b-9ad6-fe6a8e38a831_plan_history_27949c84fa3729cd5b5ddabea8b0b50a41576fb395ffe72a14d6c1bc2ab3352c_completed.md`.

## Refined implementation (worker, 26 Nov 2026)

Observed: `dev-app.js start --windows` on the PC succeeded when run alone (copy ready, tunnel up, CDP answered, `seed` worked). The failing runs in `runs.jsonl` (23:08-23:11) all ended "the tunnel did not open", while `9455.tunnel.log` was only written (`held`) at the moment the run ended. That fits a tunnel whose SSH session was slower than the fixed 20 s wait: `openTunnel` gave up, the launcher destroyed the freshly built copy, and the late SSH process was left running. Earlier "port in use here" failures fit such leftovers. This is inferred from timings, not seen directly.

Changes (all in the Harness repository):
1. `scripts/remote-checks/dev-app.js`: `openTunnel` kills the SSH process it started when it times out, returns a reason, and appends to one durable `<port>.tunnel.log`. New `connectTunnel` makes up to 3 attempts (wait per attempt 30 s, `AIO_DEVAPP_TUNNEL_WAIT_MS` overrides for tests), re-checks the port answers after each, stops a tunnel that does not answer, and on final failure asks the far computer (`devapp-probe`) whether the copy answers there, then reports every attempt's reason and the log path before stopping the copy as before.
2. `scripts/remote-checks/remote-run.sh`: `devapp-probe <port>` prints one result line, `answers` or `silent`, from a loopback request to the copy's debugging port where the tunnel's far end reaches it.
3. `scripts/remote-checks/dev-app.spec.ts`: launcher-level checks for the ready-to-CDP path: slow tunnel recovers on a retry, tunnel up but silent recovers on a retry, three failed attempts stop the copy and report each reason plus the far probe, the stale tunnel is stopped, and `devapp-probe` itself.
4. Docs: `livetest-capability-repair-runbook.md` row/notes unchanged; the usage text in `dev-app.js` mentions the retry.

Acceptance: targeted spec green; `npm run checks` green; on the Windows PC a reviewed-checkpoint start reaches CDP, `seed` runs, `stop` clears the copy and port.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "windows-dev-app-cdp-tunnel",
  "check": "Open the Plan Queue page in a rebuilt isolated Windows fixture and verify Step 8 layout and interactions.",
  "requiredAction": "Launch the reviewed tree on the Windows fixture and attach its CDP endpoint from this verifier session.",
  "platform": "windows",
  "provider": "harness",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Start the checked tree with dev-app.js --windows --checked-tree and inspect its CDP endpoint",
      "observedAt": 1795734786720,
      "result": "The launcher built and started the Windows copy, then reported that its connection back to this session did not work; dev-app seed returned fetch failed and status showed no active copy on port 9455."
    }
  ],
  "alternative": "The current full unit suite, renderer build and source tracing cover the wording and component bindings, but cannot prove the rebuilt Windows fixture layout or interaction.",
  "expectedResult": "The isolated Windows fixture remains reachable over CDP long enough to seed the queue store and inspect the Plan Queue page, then stops cleanly.",
  "implementation": "Repair the dev-app Windows tunnel lifecycle in the Harness repository so a ready copy has a usable local CDP endpoint or returns a durable, actionable failure. Add a bounded launcher-level regression check for the ready-to-CDP path; do not change the blocked Plan Queue application behavior as a workaround.",
  "repairRepository": "/Users/suas/work/orchestrat0r/ai-orchestrator"
}
</capability_evidence>

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Open the Plan Queue page in a rebuilt isolated Windows fixture and verify Step 8 layout and interactions.",
  "expectedResult": "The isolated Windows fixture remains reachable over CDP long enough to seed the queue store and inspect the Plan Queue page, then stops cleanly."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
