# Capability repair 289cd23b-6d9a-453e-b548-e8cafccfdd23

## Status

On main: yes (this landing commit)
Active. Built: both adapters log a debug line per provider call (`agy prompt size` / `gemini prompt size`: surface, sessionId, promptChars, advisoryMemoryDelivered; never prompt text). Test in google-prompt-delivery.spec.ts (9 pass, re-run 19 Nov); `npm run checks` and full suite passed earlier; adapter code unchanged since. Last probe failed on setup only: ct-test-mac has neither `gemini` nor `agy` visible to Harness. 19 Nov: `list_remote_nodes` shows windows-pc advertises antigravity (no gemini), so the agy half can be probed there. **Decision (James, 20 Nov): the Gemini CLI is retired (Google withdrew it in June 2026; Antigravity replaced it), so the runtime probe covers Antigravity only, on windows-pc. The Gemini half is out of scope; do not ask for Gemini to be installed or signed in.** A repaired control never marks its originating check passed. Round evidence: capability-289cd23b-6d9a-453e-b548-e8cafccfdd23_plan_history_8eb17776f4ded437841e6fc5680d68c9cc758b4584c8bfe5dec1a7fb2d3ff842_completed.md.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "process-argument-read-in-fence",
  "check": "Disposable Gemini and Antigravity sessions receive advisory memory only on the first provider call",
  "requiredAction": "Read the length of the spawned agy/gemini command line per turn without exposing its text",
  "platform": "macos",
  "provider": "antigravity",
  "classification": "capability",
  "attempts": [
    {
      "operation": "ps -axo pid,command polled during an Antigravity turn",
      "observedAt": 1794879368000,
      "result": "operation not permitted (ps refused inside the session fence)."
    }
  ],
  "alternative": "Adapter unit tests cover advisoryMemoryDelivered and systemPromptAfterFirstTurn; the per-turn rtk surface log is live.",
  "expectedResult": "First-call prompt is larger than later calls by the advisory memory block; later calls keep instructions and RTK.",
  "implementation": "Log the per-call prompt character count (surface and session only) from the Antigravity and Gemini adapters at debug level, so it can be read through logGetLogs without ps."
}
</capability_evidence>

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives. (`ps` still refused inside the fence; no adapter logged prompt length.)
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions. (Files: `src/main/cli/adapters/antigravity-cli-adapter.ts`, `gemini-cli-adapter.ts`, `google-prompt-delivery.spec.ts`. Acceptance: one debug line per call from sendMessage and sendMessageStream, numbers and flags only, first call larger than later ones.)
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant. (No new resource or permission; test asserts prompt text never reaches the log.)
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Disposable Gemini and Antigravity sessions receive advisory memory only on the first provider call",
  "expectedResult": "First-call prompt is larger than later calls by the advisory memory block; later calls keep instructions and RTK."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
