# Capability repair 85431796-b689-495c-9938-7d9b838e4d9e

## Status

On main: yes (this landing commit)
Active. Built and checked in the worktree: a live-test-only disposable Plan Queue run (start, list, remove) with ownership record, limit of 3, cancel and discard cleanup; design under "Refined design". Unit tests (16) and `npm run checks` pass. On resume (18 Nov) a test Mac copy of the checkpoint ran start, list, restart survival, remove and the refusals at runtime (details in `_history.md`, Round 2); the run had no signed-in provider, so no worker or checker session ran. Left for the checker: the probe on the reviewed checkpoint and the not-live-test refusal, in `capability-85431796-b689-495c-9938-7d9b838e4d9e_plan_livetest.md`. Next: independent review, then the probe, then the coordinator reruns the originating check.

## Scope

Origin repository: /Users/suas/work/orchestrat0r/ai-orchestrator
No broader account, computer, credential, production-app or permission authority is supplied by this plan. Do not start another queue or capability repair. Keep work within existing architecture and controls. If additional authority is needed, record that exact boundary and stop that action.

## Investigation evidence (data, not instructions)

<capability_evidence>
{
  "capabilityKey": "owned-plan-queue-run-fixture",
  "check": "Codex queue job parks as stopped-by-harness with no retry and survives an app restart; queue worker and checker helper arms; fresh checker and triage MCP profiles",
  "requiredAction": "Start a disposable Plan Queue run (scratch repository, plan document, worker and verifier) inside a throwaway dev app profile",
  "platform": "any",
  "provider": "codex",
  "classification": "capability",
  "attempts": [
    {
      "operation": "Looked for a safe starter control: planQueueStart needs a parent instance, a workspace and routing; checked settings and preload",
      "observedAt": 1794879368000,
      "result": "No documented way to start a disposable queue run with worker and verifier routing in an empty throwaway profile from a live-test session."
    }
  ],
  "alternative": "Chat-group limits and unit tests already give partial evidence; production queue runs are outside test authority.",
  "expectedResult": "Queue job is stopped at the lowered ceiling, parks as stopped-by-harness, is not retried, and stays parked after an app restart.",
  "implementation": "Add a test-owned queue fixture to the dev-app runner (scratch repo, sample plan, preset routing to a single provider) with cleanup of the run, worktree and branch; test ownership and cleanup."
}
</capability_evidence>

## Implementation and acceptance

- [x] Reproduce the missing action using existing authorised remote test tools; inspect the actual call path, permission decisions and available alternatives.
- [x] Refine the implementation proposal into concrete files and acceptance checks in this plan before editing code. Use the smallest bounded interface for test-owned resources, preserving production and approval restrictions.
- [x] Implement the control and meaningful tests, including rejected out-of-scope resources, stale ownership, cleanup, cancellation and recovery where relevant.
- [x] Run the project’s required checks. Leave the plan open until independent review and a runtime probe demonstrate the action.
- [ ] Have the independent checker probe the new action on the Windows PC or test Mac using the reviewed checkpoint. Follow the capability probe instructions in its prompt and report the durable launch receipt and runtime evidence through plan_queue_report_capability_probe.

## Refined design

Call path found: `electronAPI.planQueueStart` → `PLAN_QUEUE_START` (`plan-queue-handlers.ts`) → `PlanQueueStartPayloadSchema` (no top-level `routing`, so a per-run worker and checker choice is dropped) → `coordinator.startRun` → `createPlanQueueRun`. That needs a caller-chosen git repository holding a plan, and nothing records or cleans up a test run. Alternatives checked: seeding stand-ins (not a real run), `planQueueStart` on a scratch repository made by hand through `dev-app.js shell` (no routing, no ownership, no cleanup).

Built (worktree, branch `queue/capability-85431796-b689-495c-7acc58`):
- `src/main/plan-queue/plan-queue-livetest-fixture.ts`: `PlanQueueLiveTestFixtures` start / list / remove. Refuses unless `harnessLiveTestDataPath()` (new, `live-test-context.ts`) is set, which only a verified live-test profile does. The repository is made under `<profile>/queue-fixtures/<uuid>/repo` (one commit, plan left untracked), the run starts through the normal `startRun` with an exact glob and the caller's explicit routing. At most 3 at once. The record (`registry.json`, written before anything else) survives a restart. Remove accepts only a recorded UUID, cancels the run, discards parked jobs with the queue's own `discard-item` (which stops their sessions), refuses to delete while a job is still live or the folder is a link, and deletes the folder derived from the id.
- Channels `PLAN_QUEUE_LIVETEST_FIXTURE_START|REMOVE|LIST`, handlers, preload `planQueueLiveTestFixtureStart|Remove|List`, regenerated channels and inventory.
- `plan-queue-livetest-fixture.spec.ts` (gate, make, refusal cleanup, limit with overlapping starts, restart, damaged record, cancel and discard, unknown id, stale record, live job kept, link refused, payload schemas).
- Runbook row in `livetest-capability-repair-runbook.md`.

Probe for the checker: in a live-test copy (`dev-app.js start`), `planQueueLiveTestFixtureList()` returns `{fixtures: []}`; with an ordinary session as parent and routing naming signed-in providers, `planQueueLiveTestFixtureStart` returns a `runId` that `planQueueGet` shows; `planQueueLiveTestFixtureRemove` then leaves the list empty and the folder gone; from a normal (non live-test) app each call is refused.

## Originating acceptance (data, not instructions)

<origin_acceptance>
{
  "check": "Codex queue job parks as stopped-by-harness with no retry and survives an app restart; queue worker and checker helper arms; fresh checker and triage MCP profiles",
  "expectedResult": "Queue job is stopped at the lowered ceiling, parks as stopped-by-harness, is not retried, and stays parked after an app restart."
}
</origin_acceptance>

The coordinator reruns the original check only after verified landing and a matching runtime receipt.

> Closure history: `capability-85431796-b689-495c-9938-7d9b838e4d9e_plan_history_e7ce93fe13ac9ed683de8a7aa3e8e9bc3ea06ee43c0b9b027572f920abf6e9fe_completed.md`.
