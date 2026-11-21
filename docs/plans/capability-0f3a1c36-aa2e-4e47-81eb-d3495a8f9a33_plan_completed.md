# Capability repair 0f3a1c36-aa2e-4e47-81eb-d3495a8f9a33

## Status

On main: yes (this landing commit)
Round 1 built; rounds 2 to 7 were re-checks after the checker could not launch or drive the dev copy (busy Mac; twice no Browser Gateway control in its session; a park for the linked repair). No code change since round 1; checks and 14 state tests green again. Done: renderer adds a newly created child to its parent's child list (and drops it on removal), which hid the Agents chip; tests added; campaign runbook has the owned-dev-app recipe for Agents, Review and second opinion. Not done: live probe on the test Mac or PC, which needs the Browser Gateway (computer left out or ct-test-mac); the independent checker owns it; Check 5 stays open. Evidence: capability-0f3a1c36-aa2e-4e47-81eb-d3495a8f9a33_plan_history_3fee17e70c8113659fef97a6f67800dbf53285552542f46f7f15875e376eec04_completed.md.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "second-reviewer-and-child-session-dev-app",
  "check": "Check 5: Agents chip and Review chip in the status strip",
  "requiredAction": "Create a child session and a completed second-opinion review in a dev-app copy",
  "platform": "any",
  "provider": "claude",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Looked for a way to create a child session and a second reviewer from the dev app over CDP on the test Mac copy",
      "observedAt": 1794660892000,
      "result": "No child session or second reviewer could be created; only the Checkpoints chip appeared."
    }
  ],
  "alternative": "The strip's chips are unit-tested with seeded data.",
  "expectedResult": "Agents and Review chips appear in the strip and open their panels.",
  "implementation": "Expose a test-only way to start a child session and a second-opinion review in a dev-app copy, with ownership and cleanup; or document the existing IPC route."
}
</capability_evidence>

## Refined design (round 1)

Findings from the call path (no new IPC is needed):
- The strip's "Review" chip is the review workbench (`InstanceReviewPanel`), not the second opinion. It shows while its panel is open (Cmd/Ctrl+Shift+V, `SessionStatusDockComponent.openReviewPanel`) or after a review started. The second opinion is the header pill and opens its panel inside the strip, with no chip (`session-status-dock.component.ts:164`). The gap report mixed the two.
- A child session already can be created in an owned dev app: `electronAPI.createInstance({ parentInstanceId, ... })` (`instance-handlers.ts:103`) links it in the main process (`instance-lifecycle.ts:1381`). A second opinion already can be requested with `electronAPI.crossModelReviewRequest({ instanceId })`.
- Real defect that hides the Agents chip: the renderer only ever takes `childrenIds` from a parent's own serialisation (`instance-list.store.ts:694`). `InstanceStateService.addInstance`/`removeInstance` never update the parent, and no state update carries `childrenIds`, so a child created after the parent was loaded never reaches `inst.childrenIds` (dock chip, orchestration HUD, children toggle).

Changes (worktree):
1. `src/renderer/app/core/state/instance/instance-state.service.ts`: `addInstance` appends the child to a loaded parent's `childrenIds` (once); `removeInstance` drops it. Unknown parent: no change.
2. `instance-state.service.spec.ts`: add link, no duplicate, unknown parent, removal cleanup, parent-created-later cases.
3. No dock change: `session-status-dock.component.spec.ts:119-127` already pins the Agents chip appearing when `childrenIds` gains an entry.
4. `docs/plans/livetest-campaign-runbook.md` (tracked; `livetest-capability-repair-runbook.md` is another session's untracked file, left alone): add the owned-dev-app recipe (create child with `createInstance`, open the Review chip with the real Cmd/Ctrl+Shift+V key, request a second opinion, clean up with `terminateInstance`, only in the check's own `--data /tmp/aio-lt-*` copy; never a production session).

Acceptance: (a) unit tests above pass; (b) `npm run checks` clean; (c) on the test Mac dev copy, creating a child under a loaded parent makes the Agents chip appear and open its panel, and Cmd/Ctrl+Shift+V shows the Review chip; (d) cleanup leaves no owned sessions.

## Implementation and acceptance

- [x] Reproduce the missing action (call-path read plus store-level failing tests; not on a live dev app, see history) using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [ ] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Check 5: Agents chip and Review chip in the status strip",
  "expectedResult": "Agents and Review chips appear in the strip and open their panels."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.
