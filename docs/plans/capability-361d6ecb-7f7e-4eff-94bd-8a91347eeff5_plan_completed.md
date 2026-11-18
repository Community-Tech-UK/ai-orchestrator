# Capability repair 361d6ecb-7f7e-4eff-94bd-8a91347eeff5

## Status

On main: yes (this landing commit)
Active, awaiting independent review and the checker's runtime probe. Built: a live-test-only disposable session that raises a real question or permission card through the real ACP adapter over a scripted in-process agent (see "Refined implementation"). Gates pass: typecheck, typecheck:spec, ng lint, lint:fast, ts-max-loc, verify:ipc, verify:architecture, check:ui-hints, build:main, build:renderer, 31 new tests plus 260 neighbouring. Run live on a Windows PC dev app over CDP: choice, free-text and permission cards, typed answers echoed, remove path. That run found two defects, both fixed; the second fix (session stuck "busy": a 25 ms answer latency in the scripted agent) is covered by a unit test but NOT re-confirmed live, because the PC refused new connections and the test Mac was overloaded. Resumed 18 Nov after the checker could not run its probe (no remote computer free); no code changed, the Windows PC is connected again, 31 new tests and typecheck re-pass. Next: checker probes the reviewed checkpoint on a remote computer (livetest doc, check 1), then the coordinator reruns the original check (check 2). A repaired control never marks its originating check passed. Evidence: `capability-361d6ecb-7f7e-4eff-94bd-8a91347eeff5_plan_history_abcf8f8309aff9e0d15a484a343b899620481e4240bdf14286ba56ae1570e3b5_completed.md`.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "disposable-question-card",
  "check": "Ask a disposable session to issue a question. Type an exact choice in the composer, then use another question with a free-text answer.",
  "requiredAction": "Create a disposable session that raises a real native question card in the dev app.",
  "platform": "macos",
  "provider": "any",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Claude session (Haiku), asked to use AskUserQuestion",
      "observedAt": 1794836160000,
      "result": "Model said the tool is not in the session's tool list; Harness denies it on every launch (DEFAULT_DISALLOWED_TOOLS in host-cli-tool-policy.ts)."
    },
    {
      "operation": "Codex session in Default mode, asked for request_user_input_async / request_user_input",
      "observedAt": 1794836230000,
      "result": "request_user_input_async not available; request_user_input unavailable in Default mode. No Codex plan/collaboration mode wiring found in src/main/cli/adapters/codex."
    },
    {
      "operation": "OpenCode session, asked to use its question tool",
      "observedAt": 1794836280000,
      "result": "Answered with a plain assistant sentence; no question card or elicitation."
    }
  ],
  "alternative": "Seeding a synthetic card through the renderer stores tests rendering only, not the real provider-to-card lifecycle.",
  "expectedResult": "A real question card appears; typed exact-choice and free-text answers are consumed with a short receipt; a permission card never consumes composer text.",
  "implementation": "Add a test-owned control in the dev app that makes a disposable session emit a genuine question input-required event through the normal adapter path (for example a fixture or test-only provider adapter, or Codex Plan collaboration mode wiring), with cleanup on terminate. Tests: the card appears, answers are consumed and receipted, permission cards ignore composer text.",
  "repairRepository": "/Users/suas/work/orchestrat0r/ai-orchestrator"
}
</capability_evidence>

## Refined implementation

Reproduction (read from the call path, 16 Nov 2026): Claude's `AskUserQuestion` is in `DEFAULT_DISALLOWED_TOOLS` (`host-cli-tool-policy.ts`), enforced on every launch; Codex has no plan-mode wiring; OpenCode's question tool needs a configured model. No real provider can be made to ask on demand, so the card must come from a test-owned agent.

Design: a session made by a live-test-only handler runs the real `AcpCliAdapter` against a scripted in-process agent. Everything from the protocol up (card metadata, answer mapping, receipts, cancel, exit) is production code.

- `src/main/cli/adapters/live-test-question-peer.ts`: the scripted ACP agent. No pid (nothing to signal), no model, tools, files or network. The prompt picks the card: contains "free-text" gives a free-text question, "permission" gives a permission card, anything else an exact-choice question (red/blue). It reports what it received as an assistant message.
- `live-test-question-adapter.ts`: `AcpCliAdapter` subclass (OpenCode-2 question cards, never YOLO) plus `createLiveTestQuestionAdapter`, called first in `createCliAdapter` (`adapter-factory.ts`). Null outside a live-test app; a claimed folder with another provider or a remote placement is refused.
- `live-test-question-fixtures.ts`: the claimed folders (max 8), so every respawn finds the fixture by folder.
- `src/main/ipc/handlers/live-test-question-session-handlers.ts`: `LIVE_TEST_QUESTION_SESSION_CREATE` / `_REMOVE`, registered only when `isHarnessLiveTest()` (`live-test-context.ts`). Create makes a private folder in the test profile and an OpenCode-shaped, non-YOLO instance. Remove refuses any session it did not create, tolerates one already closed, always frees the folder.
- Wiring: contracts channels and schemas, `live-test-question.preload.ts` (`createLiveTestQuestionSession`, `removeLiveTestQuestionSession`), `npm run generate:ipc` and `generate:architecture`.

Acceptance: card appears with options (choice) or none (free-text); typed answers are consumed and echoed; a permission card is a permission card even in a YOLO-flagged adapter; unanswered question withdrawn on remove; no process is signalled; out-of-scope ids, extra payload fields, other providers, remote placement and non-live-test apps are refused; limit of 8 sessions; folders cleaned on every path.

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Ask a disposable session to issue a question. Type an exact choice in the composer, then use another question with a free-text answer.",
  "expectedResult": "A real question card appears; typed exact-choice and free-text answers are consumed with a short receipt; a permission card never consumes composer text."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
