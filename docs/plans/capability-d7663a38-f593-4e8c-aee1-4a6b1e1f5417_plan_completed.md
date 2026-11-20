# Capability repair d7663a38-f593-4e8c-aee1-4a6b1e1f5417

## Status

On main: yes (this landing commit)
Active. The gap's premise was wrong (16 Nov): the test Mac already has `codex` and `opencode`, so nothing is installed. The capacity check ran on 19 Nov (max two work folders, four scratch plans): two started, two waited and started as folders freed, none parked, all landed. The verifier found the extras showed no reason while waiting, so `plan-queue-pump.ts` now writes "Waiting for a free work folder (N in use)" on a queued job held back by the folder limit, but only when no run hold applies; a folder note left over once the run is held and a folder is free is cleared (round 5, after the verifier found it overwrote "Waiting for the run to come off hold"; unit specs, plan-queue tests, typecheck, lint pass). On 20 Nov I re-ran the check on the test Mac against reviewed tree 71eaa5c7: the two extras showed that exact text with no worktree, started when folders freed, text cleared, all four landed. Open: the checker's own runtime probe on a rebuilt copy (20 Nov 10:29: test Mac load 2.7, no copies, so the earlier "too busy" park has cleared). The running queue service rejects launcher mode "windows" in receipts although the source accepts it; it needs a restart on the new build (environment, not code). Evidence: history file.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "second-provider-on-test-mac",
  "check": "Capacity: start more scratch queue documents than free worktrees; extras stay queued with 'Waiting for a free work folder (N in use)' then start when a worktree is released",
  "requiredAction": "Install a supported non-Claude provider CLI (for example OpenCode) on the test Mac, or approve running the dev app on this Mac for this check",
  "platform": "macos",
  "provider": "opencode",
  "classification": "setup",
  "attempts": [
    {
      "operation": "ssh ct-test-mac: command -v for claude, codex, opencode, gemini, copilot, cursor-agent, grok",
      "observedAt": 1794845800000,
      "result": "Only claude is installed; the other six return nothing."
    },
    {
      "operation": "Earlier dev-app run on test Mac (14 Nov): planQueueStart with maxConcurrentWorktrees=2 and four scratch documents",
      "observedAt": 1794600000000,
      "result": "Refused: no installed provider other than claude is available for verification (plan-queue-verifier-select.ts:149)."
    }
  ],
  "alternative": "Run the dev app on this Mac, which has OpenCode 1.19.5; not done because no approval for local Mac use was given for this task.",
  "expectedResult": "With maxConcurrentWorktrees=2 and four documents, two start and two show 'Waiting for a free work folder (N in use)', then start as folders are freed; none parks for capacity.",
  "implementation": "No code change needed. Setup only: install OpenCode on the test Mac, or have James approve a local run, then re-run the capacity check with a low maxConcurrentWorktrees in an isolated dev-app profile."
}
</capability_evidence>

## Implementation and acceptance

Refined proposal: no files change. The refusal at `plan-queue-verifier-select.ts:149` is the intended rule (a verifier never shares the worker's provider; Claude serves only Anthropic models, so `sameProviderCheckerCanDiffer` cannot help). It fires only when detection sees no second provider. Weakening it for a test-only mode would break that rule, so none is added. Acceptance: a dev app on the test Mac, started by `dev-app.js`, passes the start preflight for a Claude worker with maxConcurrentWorktrees=2 and four scratch documents.

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] (No control needed, per the refined proposal: no files change.) Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Capacity: start more scratch queue documents than free worktrees; extras stay queued with 'Waiting for a free work folder (N in use)' then start when a worktree is released",
  "expectedResult": "With maxConcurrentWorktrees=2 and four documents, two start and two show 'Waiting for a free work folder (N in use)', then start as folders are freed; none parks for capacity."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-d7663a38-f593-4e8c-aee1-4a6b1e1f5417_plan_history_a4068586782533ea7abf96e65b11678485142b52e6e23b9e00445fba73b0c683_completed.md`.
