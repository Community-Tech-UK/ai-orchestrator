# Global Operator Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the persistent top-level Orchestrator conversation foundation with no execution engine.

**Architecture:** Add a small internal `orchestrator` conversation adapter to the existing conversation ledger, then expose a narrow `operator:get-thread` / `operator:send-message` IPC facade. The renderer gets an `OperatorStore`, a pinned sidebar row above projects, and an `OperatorPage` that renders the durable transcript and composer.

**Tech Stack:** Electron main process, Angular 21 standalone components, TypeScript 5.9, Zod IPC schemas, Vitest.

---

## File Map

- Create `packages/contracts/src/channels/operator.channels.ts`: operator IPC channel names.
- Modify `packages/contracts/src/channels/index.ts`: merge/export operator channels.
- Create `packages/contracts/src/schemas/operator.schemas.ts`: get-thread and send-message payload validation.
- Modify `packages/contracts/src/schemas/conversation-ledger.schemas.ts`: allow `orchestrator` start payloads with nullable workspace path.
- Modify `src/shared/types/conversation-ledger.types.ts`: allow internal start requests without a project path.
- Create `src/main/conversation-ledger/internal-orchestrator-conversation-adapter.ts`: internal durable conversation adapter.
- Modify `src/main/conversation-ledger/conversation-ledger-service.ts`: register the internal adapter and remove the Codex-only start guard.
- Create `src/main/operator/operator-thread-service.ts`: owns the singleton global operator thread and message persistence.
- Create `src/main/operator/index.ts`: operator service exports.
- Create `src/main/ipc/handlers/operator-handlers.ts`: operator IPC handlers.
- Modify `src/main/ipc/handlers/index.ts`: export operator handlers.
- Modify `src/main/ipc/ipc-main-handler.ts`: register operator handlers.
- Create `src/preload/domains/operator.preload.ts`: typed preload methods.
- Modify `src/preload/preload.ts`: compose operator preload domain.
- Run `npm run generate:ipc`: update `src/preload/generated/channels.ts`.
- Modify alias files: `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`.
- Create `src/renderer/app/core/services/ipc/operator-ipc.service.ts`: renderer IPC wrapper.
- Modify `src/renderer/app/core/services/ipc/index.ts`: export operator IPC service.
- Create `src/renderer/app/core/state/operator.store.ts`: signals for selection, thread, messages, loading, and send.
- Create `src/renderer/app/features/operator/operator-page.component.ts`: persistent global conversation UI.
- Modify `src/renderer/app/features/dashboard/dashboard.component.ts`: wire operator selection.
- Modify `src/renderer/app/features/dashboard/dashboard.component.html`: add pinned row and conditional operator page.
- Modify `src/renderer/app/features/dashboard/dashboard.component.scss`: style pinned row.
- Test files:
  - `packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts`
  - `src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts`
  - `src/main/operator/operator-thread-service.spec.ts`
  - `src/renderer/app/core/state/operator.store.spec.ts`

## Tasks

### Task 1: Ledger accepts internal Orchestrator conversations

**Files:**
- Modify: `packages/contracts/src/schemas/conversation-ledger.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts`
- Modify: `src/shared/types/conversation-ledger.types.ts`
- Create: `src/main/conversation-ledger/internal-orchestrator-conversation-adapter.ts`
- Modify: `src/main/conversation-ledger/conversation-ledger-service.ts`
- Modify: `src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts`

- [ ] **Step 1: Write failing schema test**

Add an assertion that `ConversationLedgerStartPayloadSchema` accepts:

```ts
{
  provider: 'orchestrator',
  workspacePath: null,
  title: 'Orchestrator',
  metadata: { scope: 'global' },
}
```

Run:

```bash
npx vitest run packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts
```

Expected: fail because `provider` is currently `z.literal('codex')`.

- [ ] **Step 2: Write failing service test**

Add a test that starts an `orchestrator` thread, sends a turn, reloads the same service database, and verifies the user message persists.

Run:

```bash
npx vitest run src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts
```

Expected: fail because the service rejects non-Codex starts and no internal adapter exists.

- [ ] **Step 3: Implement ledger support**

Use a discriminated union for the start schema:

```ts
const CodexConversationLedgerStartPayloadSchema = z.object({
  provider: z.literal('codex'),
  workspacePath: z.string().min(1),
  model: z.string().min(1).nullable().optional(),
  title: z.string().min(1).nullable().optional(),
  ephemeral: z.boolean().optional(),
  approvalPolicy: z.string().min(1).nullable().optional(),
  sandbox: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
  personality: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const OrchestratorConversationLedgerStartPayloadSchema = CodexConversationLedgerStartPayloadSchema.extend({
  provider: z.literal('orchestrator'),
  workspacePath: z.string().min(1).nullable().optional(),
});

export const ConversationLedgerStartPayloadSchema = z.discriminatedUnion('provider', [
  CodexConversationLedgerStartPayloadSchema,
  OrchestratorConversationLedgerStartPayloadSchema,
]);
```

Change `NativeThreadStartRequest.workspacePath` to `workspacePath?: string | null`.

Create an internal adapter with `provider = 'orchestrator'`, `nativeVisibilityMode = 'none'`, and `sendTurn()` returning one user message with a stable native turn id.

Remove the Codex-only guard in `ConversationLedgerService.startConversation()`, register the internal adapter by default, and keep orchestrator turn sync status `synced` after `sendTurn()`.

- [ ] **Step 4: Verify Task 1**

Run:

```bash
npx vitest run packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts
```

Expected: pass.

### Task 2: Operator IPC foundation

**Files:**
- Create: `packages/contracts/src/channels/operator.channels.ts`
- Modify: `packages/contracts/src/channels/index.ts`
- Create: `packages/contracts/src/schemas/operator.schemas.ts`
- Create: `src/main/operator/operator-thread-service.ts`
- Create: `src/main/operator/operator-thread-service.spec.ts`
- Create: `src/main/operator/index.ts`
- Create: `src/main/ipc/handlers/operator-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Create: `src/preload/domains/operator.preload.ts`
- Modify: `src/preload/preload.ts`
- Modify: alias files and generated channels.

- [ ] **Step 1: Write failing operator service test**

Test that `OperatorThreadService.getThread()` creates one global thread and repeated calls reuse it; test that `sendMessage('Pull all repos')` appends a user message.

Run:

```bash
npx vitest run src/main/operator/operator-thread-service.spec.ts
```

Expected: fail because the service file does not exist.

- [ ] **Step 2: Implement operator contracts and service**

Add channels:

```ts
export const OPERATOR_CHANNELS = {
  OPERATOR_GET_THREAD: 'operator:get-thread',
  OPERATOR_SEND_MESSAGE: 'operator:send-message',
} as const;
```

Add schemas:

```ts
export const OperatorGetThreadPayloadSchema = z.object({}).optional();
export const OperatorSendMessagePayloadSchema = z.object({
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
```

Implement `OperatorThreadService` with:

- `getThread(): Promise<ConversationLedgerConversation>`
- `sendMessage(input: { text: string; metadata?: Record<string, unknown> }): Promise<ConversationLedgerConversation>`
- one global native thread id: `orchestrator-global`
- metadata `{ scope: 'global', operatorThreadKind: 'root' }`

- [ ] **Step 3: Wire IPC and preload**

Register handlers that validate payloads and return `IpcResponse`.

Expose preload methods:

- `getOperatorThread(payload?: unknown)`
- `sendOperatorMessage(payload: unknown)`

Run:

```bash
npm run generate:ipc
```

Add `@contracts/schemas/operator` and `@contracts/channels/operator` aliases everywhere the repo requires exact aliases.

- [ ] **Step 4: Verify Task 2**

Run:

```bash
npx vitest run src/main/operator/operator-thread-service.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: pass.

### Task 3: Renderer operator store and page

**Files:**
- Create: `src/renderer/app/core/services/ipc/operator-ipc.service.ts`
- Modify: `src/renderer/app/core/services/ipc/index.ts`
- Create: `src/renderer/app/core/state/operator.store.ts`
- Create: `src/renderer/app/core/state/operator.store.spec.ts`
- Create: `src/renderer/app/features/operator/operator-page.component.ts`

- [ ] **Step 1: Write failing store test**

Test that `OperatorStore.initialize()` loads the thread, `select()` marks it selected, and `sendMessage()` appends the returned persisted user message.

Run:

```bash
npx vitest run src/renderer/app/core/state/operator.store.spec.ts
```

Expected: fail because the store does not exist.

- [ ] **Step 2: Implement IPC service and store**

`OperatorIpcService` should wrap the preload API and return typed `IpcResponse<ConversationLedgerConversation>`.

`OperatorStore` should expose:

- `selected`
- `thread`
- `messages`
- `loading`
- `sending`
- `error`
- `initialize()`
- `select()`
- `deselect()`
- `sendMessage(text: string)`

Do not create run graph state in Wave 1.

- [ ] **Step 3: Implement page**

`OperatorPageComponent` should render:

- header title `Orchestrator`
- transcript messages from `OperatorStore.messages()`
- an empty state when there are no messages
- textarea composer
- send button disabled while sending or empty

The component calls `store.initialize()` on init and `store.sendMessage()` on submit.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
npx vitest run src/renderer/app/core/state/operator.store.spec.ts
npx tsc --noEmit
```

Expected: pass.

### Task 4: Dashboard integration

**Files:**
- Modify: `src/renderer/app/features/dashboard/dashboard.component.ts`
- Modify: `src/renderer/app/features/dashboard/dashboard.component.html`
- Modify: `src/renderer/app/features/dashboard/dashboard.component.scss`

- [ ] **Step 1: Add dashboard selection behavior**

Inject `OperatorStore`, add `selectOperator()`, update `hasWorkspaceSelection`, and hide the file explorer while operator is selected.

- [ ] **Step 2: Render pinned row and page**

Add a pinned button above `<app-instance-list />` and swap main content between `<app-operator-page />` and `<app-instance-detail />` based on `operatorStore.selected()`.

- [ ] **Step 3: Verify Task 4**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npx vitest run packages/contracts/src/schemas/__tests__/conversation-ledger.schemas.spec.ts src/main/conversation-ledger/__tests__/conversation-ledger-service.spec.ts src/main/operator/operator-thread-service.spec.ts src/renderer/app/core/state/operator.store.spec.ts
```

Expected: all pass.

## Self-Review

Spec coverage for Wave 1:

- Persistent global conversation: covered by Task 1 and Task 2.
- Conversation ledger guard lift and internal adapter: covered by Task 1.
- Operator IPC contracts and preload domain: covered by Task 2.
- Renderer operator store: covered by Task 3.
- Pinned Orchestrator row and global view: covered by Task 4.
- Persist/restart acceptance: covered by Task 1 service reload test; manual app restart verification is deferred until the dev server/app can be launched.

Known out-of-scope work for later waves:

- project registry, run graph, Git batch, delegated project workers, instance settled events, verification executor, budgets, audit events, and recovery links.
