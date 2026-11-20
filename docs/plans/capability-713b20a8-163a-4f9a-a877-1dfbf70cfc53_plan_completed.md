# Capability repair 713b20a8-163a-4f9a-a877-1dfbf70cfc53

## Status

On main: yes (this landing commit)
Active. Implemented and checked (rounds 1-2): checker turns on Codex now write a names-only `required-skills` row to the session-policy log (see "Refined design"). Round 2: the exec path records the native Codex thread id. Round 3: the app-server path writes its row only after Codex acknowledges the skill-bearing input (a rejected or stale send writes nothing). Round 4: two adapter files trimmed back under the 700-line limit. Round 6: the command-mode (exec) path now also writes its row only after Codex accepted the input, so a rejected resumed turn leaves no row (new spec fails without the fix). Typecheck, lint, max-loc and targeted/adjacent tests pass. Open: independent review, then the runtime probe on a rebuilt app with signed-in Codex; earlier attempts found the test Mac busy (rounds 7-8), and the last found the checker session had no Browser Gateway control for it (round 9: the gateway reports the test Mac ready from the worker session; steps in the `_livetest.md` beside this plan). Remote-worker checkers are not covered (follow-up). Evidence: the `_history.md` beside this plan. A repaired control never marks its originating check passed.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "codex-session-record-read",
  "check": "Checkers in the omission arm load the named governing skill despite having no automatic catalog",
  "requiredAction": "Read a queue checker's own Codex session record to confirm skill loading",
  "platform": "macos",
  "provider": "codex",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Searched ~/.codex/sessions and archived_sessions for the checker thread id",
      "observedAt": 1795011700000,
      "result": "No file found; per-session Codex homes are used and are not discoverable from the test session."
    }
  ],
  "alternative": "Policy row shows catalog omitted and the verdict PASS from the real report tool; skill loading is unproven.",
  "expectedResult": "A bounded record that the checker read its named governing skill (name only).",
  "implementation": "Log at debug level, per Codex queue checker, whether its first turns referenced the governing skill by name (no content), or expose the session's home path in the policy row."
}
</capability_evidence>

## Refined design (worker, 18 Nov 2026)

Reproduction: the origin check could not find the checker's own Codex record because each Codex session has its own private home, and Harness wrote nothing about which skills a checker's turn named. Existing `session-policy` rows (`codex-thread-requests.ts` `logPolicy`) record only catalog `omitted`/`capped`, not skills named. Call path: `codex-app-server-turn-adapter.ts` `appServerSendMessageInner` builds turn input via `requiredSkillInputs` (internal turns) or `withRequiredSkillMentions` (user turns); `codex-exec-adapter.ts` `prepareMessageForExecution` does the same for exec.

Smallest bounded control: one new `required-skills` row in the existing main-process session-policy log (`<userData>/session-policy/<day>.jsonl`, readable in an owned dev app under its `--data` folder), written for each plan-queue checker (`queueRole==='verifier'`, non-chat) turn. Fields: `threadId?`, `instanceId?`, `queueRole`, `skills` (names only), `via` (`skill-item` | `mention`), `catalogOmitted`, `governingSkillNamed` (all of `CHECKER_REQUIRED_SKILLS` named). A debug log line carries the same. No prompt text, no paths. Other sessions and chats write nothing.
It proves Harness named the skill in the turn input Codex received, not that Codex echoed it back (Codex does not).

Files: `session-policy-log.ts` (record type + writer), `codex-required-skills.ts` (`recordCheckerSkillDelivery`), `codex-app-server-turn-adapter.ts`, `codex-exec-adapter.ts`, specs beside each. Remote-worker checkers: not covered (a worker has no log; needs its own telemetry event), recorded as a follow-up.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Checkers in the omission arm load the named governing skill despite having no automatic catalog",
  "expectedResult": "A bounded record that the checker read its named governing skill (name only)."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-713b20a8-163a-4f9a-a877-1dfbf70cfc53_plan_history_19b1c95e6dd5de41240708bd361f25cb6eaaabeb827b4db9aa5fb335868dcda7_completed.md`.
