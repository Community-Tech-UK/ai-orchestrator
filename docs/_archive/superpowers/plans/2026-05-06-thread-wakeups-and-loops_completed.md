# Thread Wakeups and Loops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let scheduled automations target an existing thread, revive it when allowed, and send the scheduled prompt into that thread instead of always creating a fresh instance.

**Architecture:** Add a destination layer to automations, with `newInstance` preserving current behavior and `thread` using a new wakeup runner. Extract reusable history restore logic into `SessionRevivalService` so archived-session wakeups have a real domain API instead of duplicating IPC handler code.

**Tech Stack:** Electron main process, TypeScript, Zod contracts, better-sqlite3 RLM migrations, Angular signal stores, Vitest.

---

## File Map

- Modify `packages/contracts/src/schemas/automation.schemas.ts`: add automation destination schemas.
- Modify `src/shared/types/automation.types.ts`: add `AutomationDestination` types and fields.
- Modify `src/main/persistence/rlm/rlm-schema.ts`: add an additive migration for `automation_thread_destinations`.
- Modify `src/main/automations/automation-store.ts`: persist and hydrate destinations.
- Modify `src/main/automations/automation-runner.ts`: dispatch by destination.
- Create `src/main/automations/thread-wakeup-runner.ts`: live-send and revive-then-send behavior.
- Create `src/main/session/session-revival-service.ts`: reusable history restore/replay service.
- Modify `src/main/ipc/handlers/session-handlers.ts`: delegate history restore heavy logic to `SessionRevivalService`.
- Modify `src/main/ipc/handlers/automation-handlers.ts`: accept destination payloads.
- Modify `src/renderer/app/core/state/automation.store.ts`: expose destination state.
- Modify `src/renderer/app/features/instance-detail/instance-detail.component.ts`: wakeup creation/cancel entrypoint.
- Modify `src/renderer/app/features/instance-detail/input-panel.component.html`: add compact wakeup control if this is the local control surface used by the current detail page.
- Add tests:
  - `src/main/session/session-revival-service.spec.ts`
  - `src/main/automations/thread-wakeup-runner.spec.ts`
  - `src/main/automations/automation-store.thread-destination.spec.ts`
  - `src/renderer/app/core/state/automation.store.spec.ts`

## Tasks

### Task 1: Destination Contracts and Migration

**Files:**
- Modify: `packages/contracts/src/schemas/automation.schemas.ts`
- Modify: `src/shared/types/automation.types.ts`
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Test: `src/main/automations/automation-store.thread-destination.spec.ts`

- [x] **Step 1: Write failing schema tests**

Add tests that parse both destination shapes:

```ts
const newInstance = AutomationCreatePayloadSchema.parse({
  name: 'Daily check',
  schedule: { type: 'oneTime', runAt: Date.now() + 60_000 },
  action: { prompt: 'Check status', workingDirectory: process.cwd() },
  destination: { kind: 'newInstance' },
});

const thread = AutomationCreatePayloadSchema.parse({
  name: 'Wake current thread',
  schedule: { type: 'oneTime', runAt: Date.now() + 60_000 },
  action: { prompt: 'Continue', workingDirectory: process.cwd() },
  destination: {
    kind: 'thread',
    instanceId: 'instance-1',
    sessionId: 'session-1',
    reviveIfArchived: true,
  },
});

expect(newInstance.destination.kind).toBe('newInstance');
expect(thread.destination.kind).toBe('thread');
```

Run:

```bash
npx vitest run packages/contracts/src/schemas/__tests__/automation.schemas.spec.ts
```

Expected: fail until destination schema exists.

- [x] **Step 2: Add shared destination types**

Add:

```ts
export type AutomationDestination =
  | { kind: 'newInstance' }
  | {
      kind: 'thread';
      instanceId: string;
      sessionId?: string;
      historyEntryId?: string;
      reviveIfArchived: boolean;
    };
```

Then add `destination: AutomationDestination` to `Automation`, `CreateAutomationInput`, `UpdateAutomationInput`, and `AutomationConfigSnapshot`. Default existing input reads to `{ kind: 'newInstance' }`.

- [x] **Step 3: Add Zod destination schema**

Add:

```ts
export const AutomationDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('newInstance') }),
  z.object({
    kind: z.literal('thread'),
    instanceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200).optional(),
    historyEntryId: z.string().min(1).max(200).optional(),
    reviveIfArchived: z.boolean().default(true),
  }),
]);
```

Add `destination: AutomationDestinationSchema.default({ kind: 'newInstance' })` to create/update schemas.

- [x] **Step 4: Add RLM migration**

Append a migration after the current last migration:

```sql
CREATE TABLE IF NOT EXISTS automation_thread_destinations (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  session_id TEXT,
  history_entry_id TEXT,
  revive_if_archived INTEGER NOT NULL DEFAULT 1
);
```

Down migration drops only `automation_thread_destinations`.

- [x] **Step 5: Implement store persistence**

In `AutomationStore.create()` and `AutomationStore.update()`, write a row only when `destination.kind === 'thread'`; delete any row when destination becomes `newInstance`. In `mapAutomation()`, left join or lookup the thread destination and default to `{ kind: 'newInstance' }` when absent.

- [x] **Step 6: Verify Task 1**

Run:

```bash
npx vitest run src/main/automations/automation-store.thread-destination.spec.ts src/main/automations/automation-store.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: all pass.

### Task 2: Session Revival Service

**Files:**
- Create: `src/main/session/session-revival-service.ts`
- Test: `src/main/session/session-revival-service.spec.ts`
- Modify: `src/main/ipc/handlers/session-handlers.ts`

- [x] **Step 1: Write failing revival tests**

Cover:

```ts
await expect(service.revive({ instanceId: 'live-1', reviveIfArchived: false, reason: 'thread-wakeup' }))
  .resolves.toMatchObject({ status: 'live', instanceId: 'live-1' });

await expect(service.revive({ historyEntryId: 'history-1', reviveIfArchived: false, reason: 'thread-wakeup' }))
  .resolves.toMatchObject({ status: 'failed', failureCode: 'target_not_live' });

await expect(service.revive({ historyEntryId: 'history-1', reviveIfArchived: true, reason: 'thread-wakeup' }))
  .resolves.toMatchObject({ status: 'revived', restoreMode: expect.any(String) });
```

Run:

```bash
npx vitest run src/main/session/session-revival-service.spec.ts
```

Expected: fail because the service does not exist.

- [x] **Step 2: Extract session revival API**

Create these exported interfaces:

```ts
export interface SessionRevivalRequest {
  instanceId?: string;
  historyEntryId?: string;
  providerSessionId?: string;
  workingDirectory?: string;
  reviveIfArchived: boolean;
  reason: 'thread-wakeup' | 'history-restore';
}

export interface SessionRevivalResult {
  status: 'live' | 'revived' | 'failed';
  instanceId?: string;
  restoredMessages?: unknown[];
  restoreMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
  failureCode?: 'target_missing' | 'target_not_live' | 'resume_failed';
  error?: string;
}
```

- [x] **Step 3: Move reusable restore behavior**

Move the heavy logic from `HISTORY_RESTORE` into `SessionRevivalService.revive()`, preserving:

- native resume attempt when provider session ID is usable;
- replay fallback when native resume fails;
- remote-node availability behavior;
- `nativeResumeFailedAt` marking;
- output storage of hidden restored messages.

Keep the IPC handler as validation + service call + response mapping.

- [x] **Step 4: Verify Task 2**

Run:

```bash
npx vitest run src/main/session/session-revival-service.spec.ts
npx vitest run src/main/ipc/handlers/session-handlers.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: all pass. If no session handler spec exists, add focused coverage for the delegated `HISTORY_RESTORE` success and failure mapping.

### Task 3: Thread Wakeup Runner

**Files:**
- Create: `src/main/automations/thread-wakeup-runner.ts`
- Modify: `src/main/automations/automation-runner.ts`
- Test: `src/main/automations/thread-wakeup-runner.spec.ts`

- [x] **Step 1: Write failing runner tests**

Cover live instance send:

```ts
await runner.fireThreadWakeup({
  run,
  automation,
  destination: { kind: 'thread', instanceId: 'instance-1', reviveIfArchived: false },
});

expect(instanceManager.sendInput).toHaveBeenCalledWith('instance-1', automation.action.prompt, automation.action.attachments);
expect(store.markRunStarted).toHaveBeenCalled();
expect(store.markRunSucceeded).toHaveBeenCalled();
```

Cover missing target and revive failure:

```ts
expect(result.status).toBe('failed');
expect(result.failureCode).toBe('target_missing');
```

- [x] **Step 2: Implement runner**

Implement `ThreadWakeupRunner` with constructor deps for:

- `instanceManager.sendInput`;
- `SessionRevivalService`;
- `AutomationStore`;
- logger.

Behavior:

1. Mark run started.
2. If live target exists, send prompt.
3. If live target missing and `reviveIfArchived`, call `SessionRevivalService.revive()`.
4. Send prompt to revived instance.
5. Mark run succeeded/failed and include failure code in `error`.

- [x] **Step 3: Dispatch from `AutomationRunner`**

In the point where `AutomationRunner` currently calls `manager.createInstance(...)`, branch:

```ts
if (automation.destination.kind === 'thread') {
  return this.threadWakeupRunner.fireThreadWakeup({ automation, run, destination: automation.destination });
}
```

Preserve the existing new-instance branch exactly.

- [x] **Step 4: Verify Task 3**

Run:

```bash
npx vitest run src/main/automations/thread-wakeup-runner.spec.ts src/main/automations/automation-runner.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: pass.

### Task 4: Renderer Thread Wakeup Controls

**Files:**
- Modify: `src/renderer/app/core/state/automation.store.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html`
- Test: `src/renderer/app/core/state/automation.store.spec.ts`

- [x] **Step 1: Add store tests**

Add coverage that creating a thread wakeup sends:

```ts
{
  destination: {
    kind: 'thread',
    instanceId,
    sessionId,
    reviveIfArchived: true,
  }
}
```

Run:

```bash
npx vitest run src/renderer/app/core/state/automation.store.spec.ts
```

Expected: fail until store supports destination.

- [x] **Step 2: Add store method**

Add a method:

```ts
createThreadWakeup(input: {
  instanceId: string;
  sessionId?: string;
  workingDirectory: string;
  prompt: string;
  runAt: number;
  reviveIfArchived: boolean;
}): Promise<void>
```

It calls the existing automation create IPC with `destination.kind = 'thread'`.

- [x] **Step 3: Add UI entrypoint**

Add a compact wakeup menu in the instance detail controls with:

- one-shot time input;
- interval preset choices;
- revive archived toggle only when the target is not live;
- cancel pending wakeup action.

Use the existing design style; no landing-page or explanatory card.

- [x] **Step 4: Verify Task 4**

Run:

```bash
npx vitest run src/renderer/app/core/state/automation.store.spec.ts
npx tsc --noEmit
```

Expected: pass.

### Task 5: Full Slice Verification

- [x] **Step 1: Run focused tests**

```bash
npx vitest run src/main/session/session-revival-service.spec.ts src/main/automations/thread-wakeup-runner.spec.ts src/main/automations/automation-store.thread-destination.spec.ts src/renderer/app/core/state/automation.store.spec.ts
```

- [x] **Step 2: Run required quality gates**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
```

- [x] **Step 3: Manual verification**

Run the app, create a one-shot wakeup for a live thread, wait for it to fire, and confirm the prompt appears in the same thread. Then archive/restore a session, create a wakeup with `reviveIfArchived: true`, and confirm the session revives or records a visible failed run.

## Completion Validation

- Focused slice tests passed: contracts, automation store, automation runner, thread wakeup runner, session revival, session handlers, renderer automation store, operator follow-up scheduler, and orchestration handler.
- Full project checks passed: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run test` (571 files, 5306 tests), and `npm run build`.
- `npm run rebuild:native` was run after the full test suite restored test-runtime native modules, returning `better-sqlite3` to Electron ABI 143.
- Fresh-eyes validation fixed three issues before completion: archived-thread lookup now resolves by original instance/history/session metadata, recurring wakeups reuse an already revived live thread, and the session-handler refactor preserves `HISTORY_ARCHIVE`/`HISTORY_DELETE`.
