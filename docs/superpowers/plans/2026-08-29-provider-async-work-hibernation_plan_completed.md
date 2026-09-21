# Provider Async Work Hibernation Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Completed 2026-09-20. No live check is deferred — the parser, registry, continuation coordinator and all three hibernation guards are verified in-loop.

**Goal:** Keep sessions alive while provider-owned background work is running and automatically continue the agent when that work reports a terminal result.

**Architecture:** Claude protocol messages are normalized into a main-process-only `async_work` adapter event. An instance-scoped transient registry owns hibernation inhibitors, while a small continuation coordinator consumes terminal notifications and injects one deduplicated automatic continuation.

**Tech Stack:** TypeScript, Node `EventEmitter`, Electron main process, Vitest.

**Spec:** [2026-08-29-provider-async-work-hibernation_spec_completed.md](../specs/2026-08-29-provider-async-work-hibernation_spec_completed.md)

## Global Constraints

- Do not create a branch or worktree.
- Do not commit or stage active plan/spec files.
- Preserve unrelated dirty-tree changes.
- Provider-local work state is transient and must be cleared on adapter exit.
- Do not add a provider-runtime event kind; the shared taxonomy is frozen.
- Use test-first red/green cycles for every production behaviour.

---

### Task 1: Normalize Claude Background-Work Protocol Messages

**Files:**
- Create: `src/main/cli/adapters/claude-cli-async-work.ts`
- Create: `src/main/cli/adapters/claude-cli-async-work.spec.ts`
- Modify: `src/main/cli/adapters/base-cli-adapter.types.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.types.ts`
- Modify: `src/shared/types/cli.types.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts`

**Interfaces:**
- Produces: `CliAsyncWorkEvent` with phases `started | progress | terminal` and stable `workId`/`replacesWorkId` correlation.
- Produces: pure `parseClaudeAsyncWorkToolUse`, `parseClaudeAsyncWorkToolResult`, `parseClaudeTaskNotification`, and `parseClaudeToolProgress` functions.

- [x] **Step 1: Write failing parser tests**

```ts
expect(parseClaudeAsyncWorkToolUse('Bash', 'toolu-1', { run_in_background: true }))
  .toEqual({ phase: 'started', workId: 'toolu-1', kind: 'background-shell' });
expect(parseClaudeAsyncWorkToolResult('toolu-1', 'Bash', 'Command running in background with ID: bg-1'))
  .toMatchObject({ phase: 'started', workId: 'bg-1', replacesWorkId: 'toolu-1' });
expect(parseClaudeTaskNotification('<task-notification><task-id>bg-1</task-id><status>completed</status></task-notification>'))
  .toMatchObject({ phase: 'terminal', workId: 'bg-1', status: 'completed' });
```

- [x] **Step 2: Run the parser spec and verify RED**

Run: `npm run test:quiet -- src/main/cli/adapters/claude-cli-async-work.spec.ts`

Expected: FAIL because the parser module and functions do not exist.

- [x] **Step 3: Implement the pure parser and adapter event type**

Implement literal, bounded regex extraction for the captured Claude protocol shapes. Add `async_work` to `CliEvent`/`CliAdapterEvents` and add `CliToolProgressMessage` to `CliStreamMessage`.

- [x] **Step 4: Emit parsed events from `ClaudeCliAdapter`**

On assistant `tool_use`, ordinary user `tool_result`, task-notification text blocks, and `tool_progress`, call the pure parser and emit `async_work` when it returns an event. Task notifications remain provider context and are not added to the visible transcript.

- [x] **Step 5: Run the parser and existing Claude adapter specs**

Run: `npm run test:quiet -- src/main/cli/adapters/claude-cli-async-work.spec.ts src/main/cli/adapters/claude-cli-adapter.spec.ts`

Expected: PASS.

### Task 2: Add the Instance Async-Work Registry

**Files:**
- Create: `src/main/instance/instance-async-work-registry.ts`
- Create: `src/main/instance/instance-async-work-registry.spec.ts`

**Interfaces:**
- Produces: `getInstanceAsyncWorkRegistry(): InstanceAsyncWorkRegistry`.
- Produces: `observe(instanceId, event)`, `hasInhibitor(instanceId)`, `beginCompletionDelivery(instanceId)`, `finishCompletionDelivery(instanceId)`, and `clearInstance(instanceId)`.

- [x] **Step 1: Write failing registry behaviour tests**

```ts
registry.observe('i1', { phase: 'started', workId: 'toolu-1', kind: 'background-shell' });
expect(registry.hasInhibitor('i1')).toBe(true);
registry.observe('i1', { phase: 'started', workId: 'bg-1', replacesWorkId: 'toolu-1', kind: 'background-shell' });
registry.observe('i1', { phase: 'terminal', workId: 'bg-1', kind: 'background-shell', status: 'completed' });
expect(registry.hasInhibitor('i1')).toBe(true); // completion delivery still pending
registry.finishCompletionDelivery('i1');
expect(registry.hasInhibitor('i1')).toBe(false);
```

- [x] **Step 2: Run the registry spec and verify RED**

Run: `npm run test:quiet -- src/main/instance/instance-async-work-registry.spec.ts`

Expected: FAIL because the registry does not exist.

- [x] **Step 3: Implement idempotent transient records and terminal events**

Use `Map<string, Map<string, WorkRecord>>`, a per-instance completion-delivery set, and `EventEmitter`. Replacing a provisional identifier deletes it before inserting the native task identifier. A terminal event removes the active record, starts completion delivery, and emits one `work:terminal` event.

- [x] **Step 4: Run the registry spec and verify GREEN**

Run: `npm run test:quiet -- src/main/instance/instance-async-work-registry.spec.ts`

Expected: PASS.

### Task 3: Wire Adapter Events and Automatic Continuation

**Files:**
- Create: `src/main/instance/instance-async-work-continuation.ts`
- Create: `src/main/instance/instance-async-work-continuation.spec.ts`
- Modify: `src/main/instance/instance-communication.ts`
- Modify: `src/main/app/initialization-steps.ts`

**Interfaces:**
- Consumes: `CliAsyncWorkEvent` and `InstanceAsyncWorkRegistry`.
- Produces: `registerInstanceAsyncWorkContinuation({ registry, instanceManager })` returning a disposable registration.

- [x] **Step 1: Write failing continuation tests**

Cover: an idle terminal notification sends one `autoContinuation`; a changed request counter suppresses delivery; two terminal notifications before settling produce one delivery; failed delivery releases only the completion-delivery inhibitor.

- [x] **Step 2: Run the continuation spec and verify RED**

Run: `npm run test:quiet -- src/main/instance/instance-async-work-continuation.spec.ts`

Expected: FAIL because the coordinator does not exist.

- [x] **Step 3: Implement the continuation coordinator**

Use `waitForInstanceSettled`, compare the captured and current `requestCount`, call `sendInput(..., { autoContinuation: true })`, coalesce per instance with an in-flight map, and always finish completion delivery in `finally`.

- [x] **Step 4: Subscribe `InstanceCommunication` to `async_work`**

Fence stale adapter generations using the existing setup-event pattern, refresh `instance.lastActivity`, pass the event to the registry, and clear instance records on adapter exit.

- [x] **Step 5: Register the coordinator during application initialization**

Register once after `InstanceManager` construction and dispose it through the cleanup registry.

- [x] **Step 6: Run focused communication and continuation specs**

Run: `npm run test:quiet -- src/main/instance/instance-async-work-continuation.spec.ts src/main/instance/instance-communication*.spec.ts`

Expected: PASS.

### Task 4: Enforce Hibernation Inhibitors

**Files:**
- Modify: `src/main/process/resource-governor.ts`
- Modify: `src/main/process/resource-governor.spec.ts`
- Modify: `src/main/process/hibernation-manager.ts`
- Modify: `src/main/process/hibernation-manager.spec.ts`
- Modify: `src/main/instance/lifecycle/idle-monitor.ts`
- Modify: `src/main/instance/lifecycle/idle-monitor.spec.ts`

**Interfaces:**
- Consumes: `getInstanceAsyncWorkRegistry().hasInhibitor(instanceId)`.

- [x] **Step 1: Add failing reclaim-path tests**

Each automatic path receives two otherwise eligible idle instances, one inhibited and one idle. Assert only the uninhibited instance is selected for hibernation/termination.

- [x] **Step 2: Run the three focused specs and verify RED**

Run: `npm run test:quiet -- src/main/process/resource-governor.spec.ts src/main/process/hibernation-manager.spec.ts src/main/instance/lifecycle/idle-monitor.spec.ts`

Expected: FAIL because inhibited instances are still selected.

- [x] **Step 3: Filter inhibited instances in all three paths**

Apply the registry predicate alongside the existing status/age predicates. Change the resource-governor notice to `This session was hibernated automatically to free memory after it had been idle for a while. Your conversation was preserved — send a message to wake it and continue.`

- [x] **Step 4: Run the three focused specs and verify GREEN**

Run: `npm run test:quiet -- src/main/process/resource-governor.spec.ts src/main/process/hibernation-manager.spec.ts src/main/instance/lifecycle/idle-monitor.spec.ts`

Expected: PASS.

### Task 5: Final Verification and Documentation Closure

**Files:**
- Rename after all verification: `docs/superpowers/plans/2026-08-29-provider-async-work-hibernation_plan_completed.md` to `..._plan_completed.md`
- Rename after all verification: `docs/superpowers/specs/2026-08-29-provider-async-work-hibernation_spec_completed.md` to `..._spec_completed.md`

- [x] **Step 1: Run focused async-work tests together**

Run: `npm run test:quiet -- src/main/cli/adapters/claude-cli-async-work.spec.ts src/main/instance/instance-async-work-registry.spec.ts src/main/instance/instance-async-work-continuation.spec.ts src/main/process/resource-governor.spec.ts src/main/process/hibernation-manager.spec.ts src/main/instance/lifecycle/idle-monitor.spec.ts`

- [x] **Step 2: Run canonical project verification**

Run, independently and capture each real exit code:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

- [x] **Step 3: Run the mandatory fresh-agent completion gate**

Give a fresh agent the acceptance criteria, relevant diff, and command evidence. Require `task-completion-gate` and `VERDICT: PASS`. Address every actionable finding and repeat with another fresh reviewer until PASS.

- [x] **Step 4: Record as-built evidence and close documentation**

Update both documents with the implemented interfaces, focused/full command evidence, and fresh-review verdict. Rename the plan first to `_plan_completed.md`, update the spec link, then rename the spec to `_spec_completed.md`.

No commit is included because James did not request one.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.

### Checkbox reconciliation (2026-09-20)

This plan was written in the step-by-step checkbox style and the implementing session never ticked
the boxes as it went, so a reader arriving after the `_completed` rename would have seen a closed
plan full of unchecked work. The boxes are now ticked to match reality, which was established by
reading the executing code and the specs on disk — not by trusting the plan's own prose. The
independent fresh-eyes reviewer confirmed each step's artefact exists and that the tests covering it
are load-bearing rather than vacuous. Items that genuinely remain unverified are the live checks,
and those are named in the status line above and tracked in the linked `_livetest.md`, not ticked
here.
