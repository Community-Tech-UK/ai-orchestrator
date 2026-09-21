# Provider Async Work Hibernation Safety Specification

**Status:** Completed 2026-09-20 — implemented, independently gate-reviewed (`VERDICT: PASS`), and green on the full canonical checklist. Approved for implementation on 2026-08-29. No live check is deferred.

**Plan:** [2026-08-29-provider-async-work-hibernation_plan_completed.md](../plans/2026-08-29-provider-async-work-hibernation_plan_completed.md)

## Problem

Harness can classify a resident provider session as `idle` after an assistant turn even when that provider still owns background work. Under critical memory pressure, `ResourceGovernor` uses only `status === 'idle'` and an age threshold, so it can hibernate the session and kill the provider process that owns the background command or subagent.

The reproduced incident followed this sequence:

1. Claude launched a full test suite with `run_in_background: true`.
2. The Bash tool returned a background task identifier immediately.
3. Claude ended its assistant turn, so the Harness instance became `idle`.
4. Six minutes later, critical memory pressure hibernated the instance.
5. On the next user-triggered wake, Claude reported that the background suite and background reviewer had both been stopped with the previous process.

Claude also emits `tool_progress` heartbeats for long-running tools. The current adapter logs these as unrecognized messages and does not translate them into Harness activity.

## Required Behaviour

1. Provider-owned background work automatically inhibits automatic hibernation and memory-pressure reclamation. The model and user do not set a manual flag.
2. Claude background Bash commands and asynchronous Agent jobs are recognized from their native tool-use/tool-result protocol.
3. Claude task notifications release the matching inhibitor on `completed`, `failed`, or `stopped`.
4. A terminal task notification received while the session is otherwise idle schedules one automatic continuation so the model can inspect the notification and continue the promised work.
5. If a user or another turn starts before automatic continuation is delivered, the automatic continuation is suppressed to avoid a duplicate turn.
6. Multiple terminal notifications arriving together are coalesced into one continuation.
7. Adapter exit, instance removal, and explicit termination clear stale provider-owned inhibitors.
8. `tool_progress` is recognized as activity and refreshes the owning instance's activity timestamp without adding transcript noise.
9. Resource-pressure, normal idle-hibernation, and child idle-cleanup paths all exclude instances with active provider work or a pending completion delivery.
10. The hibernation notice must say that conversation state was preserved; it must not make the broader false claim that nothing was lost.

## Architecture

### Claude protocol parsing

Add a pure parser module beside `claude-cli-adapter.ts`. It recognizes:

- `Bash` tool uses whose input has `run_in_background: true`;
- Bash launch results containing `Command running in background with ID: <id>`;
- asynchronous Agent launch results containing `agentId: <id>`;
- `<task-notification>` payloads containing `<task-id>`, `<status>`, and optional `<tool-use-id>`;
- `tool_progress` payloads, using `parent_tool_use_id` as the stable correlation key.

The adapter emits a typed `async_work` event. This event is main-process-only and does not expand the frozen provider-runtime event taxonomy.

### Instance work registry

Add a singleton `InstanceAsyncWorkRegistry` in the instance domain. It stores a set of work records per Harness instance, supports provisional-to-native identifier replacement, tracks a short-lived completion-delivery inhibitor, and emits terminal notifications. It is transient by design: provider-local background work cannot survive the provider process, so adapter exit clears it rather than persisting a false lease across restart.

### Automatic continuation

Register a coordinator during main-process initialization. On a terminal notification it keeps the completion-delivery inhibitor active, waits for the instance to settle, and calls:

```ts
instanceManager.sendInput(
  instanceId,
  'A background task has finished. Review its task notification and result, then continue the work you were waiting to complete.',
  undefined,
  { autoContinuation: true },
);
```

The coordinator captures the instance request counter when the notification arrives. If that counter changes before delivery, another user/automated turn already took ownership and the continuation is skipped. Notifications received in a short burst share one delivery.

### Hibernation integration

Every automatic reclaim path consults `InstanceAsyncWorkRegistry.hasInhibitor(instanceId)`. An inhibited session remains live even under critical memory pressure; if all candidates are inhibited, the existing fail-safe behaviour applies: request GC and ride out pressure rather than destroy active work.

## Failure Handling

- An unparseable Claude message remains fail-open for message processing but is logged once through the existing unknown-message diagnostic.
- A failed automatic continuation logs the failure and releases only the completion-delivery inhibitor; active work records remain governed by their own terminal events or adapter exit.
- Adapter exit clears all records for that instance because the provider-local work can no longer produce a valid result.
- Duplicate start, progress, and terminal events are idempotent by work identifier.

## Verification

- Parser unit tests use captured, redacted message shapes from the reproduced incident.
- Registry tests prove active work and pending delivery inhibit hibernation, replacement is idempotent, terminal notifications release work, and exit cleanup removes stale records.
- Resource governor, hibernation manager, and idle monitor tests prove inhibited instances are excluded.
- Integration-level instance communication tests prove adapter async-work events are scoped to the correct Harness instance and refresh activity.
- Coordinator tests prove idle completion triggers one auto-continuation, user activity suppresses it, and bursts coalesce.
- Canonical project verification runs after focused tests.

## Non-Goals

- Persisting provider-local tasks across provider restart.
- Keeping a session alive for a model merely saying it is waiting without an observed runtime event.
- Adding a user-facing keep-awake toggle.
- Changing manual terminate/quit semantics.
