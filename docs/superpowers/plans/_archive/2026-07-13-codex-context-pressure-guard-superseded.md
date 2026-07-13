# SUPERSEDED — DO NOT EXECUTE

This intervention-oriented draft was superseded on 2026-07-13 after source review showed that fixed truncation and repeated compaction could reduce accuracy, especially in long-running sessions. The active plan is [`2026-07-13-codex-context-pressure-observability-discovery-plan.md`](../2026-07-13-codex-context-pressure-observability-discovery-plan.md), which is limited to logging, factual diagnostics, replay analysis, and evidence gathering.

The content below is retained only as design history. It does not authorize implementation.

# Codex Context Pressure Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent one long Codex app-server turn from consuming nearly the entire context window, while preserving continuity and making every protective action visible.

**Architecture:** Apply a provider-native per-tool-result limit before output enters Codex history, then observe provider token notifications during the turn. At 70% AIO steers the active turn toward synthesis; at 82% it interrupts once, waits for proof that native compaction completed, and resumes once on the same thread. A scope-aware capability contract lets AIO compact Codex between turns without pretending provider-owned mid-turn compaction is sufficient. Context UI distinguishes current occupancy, lifetime processing, cache use, and guard state.

**Tech Stack:** TypeScript, Electron main process, Codex app-server JSON-RPC, Angular 21 signals, Zod 4 contracts, Vitest.

## Global Constraints

- Preserve the user's Codex `config.toml`; apply the AIO tool-output limit as a thread/session override only.
- Never store or commit the real incident rollout. Tests use synthetic notification fixtures with no user content or secrets.
- The default model-visible tool-result budget is **6,000 tokens per result**.
- Send the soft same-turn steer once at **70%** current-window occupancy.
- Request the hard interrupt once at **82%** current-window occupancy if the turn continues growing.
- Automatically compact a successfully completed Codex turn at or above **75%**, after the turn is idle.
- Allow at most **one interrupt → compact → resume recovery** for one user submission.
- Never compact an active turn through `thread/compact/start`; steer or interrupt it first.
- Never treat the `thread/compact/start` RPC response as completion. Require a matching `contextCompaction` item or `thread/compacted` notification.
- If pressure-recovery compaction cannot be proven, stop and report a recoverable failure; do not silently start a fresh thread.
- Keep the existing fresh-thread fallback only for the separate Codex per-turn input-character-cap recovery path.
- Do not inject raw provider payloads, command output, paths, or secret-like values into logs or telemetry.
- Do not commit or push during implementation unless James explicitly asks.

---

## Why this order

The 2026-07-13 incident grew from 22,380 to 242,865 tokens in one 86-call turn. AIO's renderer math was correct. The primary failure was unbounded model-visible tool output during the active turn; post-turn compaction alone would only protect the next turn.

The selected order is:

1. Bound each tool result before Codex stores it.
2. Observe and steer the active turn while work can still finish normally.
3. Interrupt only when steering did not arrest growth.
4. Compact with completion proof and resume once on the same thread.
5. Compact high-pressure completed turns before accepting the next user message.
6. Show the user what happened.

The current Codex protocol supports every required primitive: thread-scoped `config`, `turn/steer`, `turn/interrupt`, `thread/tokenUsage/updated`, and `thread/compact/start`. The authoritative references are the [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) and [Codex configuration schema](https://github.com/openai/codex/blob/main/codex-rs/core/config.schema.json).

## Approaches considered

1. **Selected: layered prevention and recovery.** Provider-native output cap, soft steer, bounded hard stop, verified compaction, one same-thread resume, and post-turn cleanup. This is the only option that prevents the active-turn failure while retaining continuity.
2. **Post-turn compaction only.** Smallest patch, but it cannot reduce the cost or risk of the turn already running. It protects only the next message, so it does not close the incident.
3. **Hard tool-call/turn limit.** Easy to enforce, but blind to output size and task shape. It would stop legitimate work after an arbitrary call count and still allow one huge early result to consume the window.

## State flow

```text
normal turn
  │
  ├─ provider tool-output cap keeps each stored result ≤ 6,000 tokens
  │
  ├─ 70% ── turn/steer once ──► "stop broad discovery; synthesize and finish"
  │
  ├─ turn completes < 75% ─────► normal idle
  │
  ├─ turn completes ≥ 75% ─────► verified native compact ─► idle
  │
  └─ 82% while still running ──► turn/interrupt
                                  │
                                  ├─ completion proven
                                  ├─ verified native compact
                                  └─ one continuation turn on same thread

Any failed proof ──► recoverable visible failure; no silent context loss
```

## File map

### New files

- `src/main/cli/adapters/codex/context-pressure-policy.ts` — immutable thresholds, tool-output limit, and pressure instruction copy.
- `src/main/cli/adapters/codex/turn-pressure-governor.ts` — pure per-turn state machine; no RPC or Electron dependencies.
- `src/main/cli/adapters/codex/turn-pressure-governor.spec.ts` — threshold, deduplication, overshoot, and recovery-budget tests.
- `src/main/cli/adapters/codex/app-server-notification-waiter.ts` — bounded matching notification wait used by native compaction.
- `src/main/cli/adapters/codex/app-server-notification-waiter.spec.ts` — matching, timeout, unsubscribe, and cross-thread tests.
- `src/main/cli/adapters/codex/context-pressure-recovery.ts` — pure interrupt/compact/resume ladder.
- `src/main/cli/adapters/codex/context-pressure-recovery.spec.ts` — one-retry, no-fresh-thread, and error behavior.
- `src/renderer/app/features/instance-detail/context-pressure-summary.ts` — pure UI formatting helpers.
- `src/renderer/app/features/instance-detail/context-pressure-summary.spec.ts` — exact display copy and number formatting tests.

### Main modified files

- `src/main/cli/adapters/codex/app-server-types.ts`
- `src/main/cli/adapters/codex/app-server-client.ts`
- `src/main/cli/adapters/codex/app-server-client.spec.ts`
- `src/main/cli/adapters/codex/input-cap-recovery.ts`
- `src/main/cli/adapters/codex/input-cap-recovery.spec.ts`
- Delete after migration: `src/main/cli/adapters/codex/compaction-gate.ts`
- Delete after migration: `src/main/cli/adapters/codex/compaction-gate.spec.ts`
- `src/main/cli/adapters/codex-cli-adapter.ts`
- `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- `src/main/cli/adapters/base-cli-adapter.types.ts`
- All adapter runtime-capability implementations and fixtures returned by `rg -n "selfManagedAutoCompaction" src`
- `src/main/context/compaction-coordinator.ts`
- `src/main/context/compaction-coordinator.spec.ts`
- `src/main/app/compaction-runtime.ts`
- `src/main/app/compaction-runtime.spec.ts`
- `src/main/instance/instance-communication.ts`
- `src/main/instance/instance-state.ts`
- `src/shared/types/instance.types.ts`
- `src/renderer/app/core/state/instance/instance.types.ts`
- `src/renderer/app/core/services/update-batcher.service.ts`
- `src/renderer/app/core/state/instance/instance-list.store.ts`
- `src/renderer/app/core/state/instance/instance.store.ts`
- `src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.ts`
- `src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.spec.ts`
- `src/renderer/app/features/instance-detail/composer-toolbar.component.ts`
- `src/renderer/app/features/instance-detail/composer-toolbar.component.spec.ts`
- `src/renderer/app/features/instance-detail/instance-detail.component.ts`

---

### Task 1: Lock the policy and synthetic incident fixture

**Files:**
- Create: `src/main/cli/adapters/codex/context-pressure-policy.ts`
- Create: `src/main/cli/adapters/codex/turn-pressure-governor.ts`
- Create: `src/main/cli/adapters/codex/turn-pressure-governor.spec.ts`

**Interfaces:**
- Produces: `CODEX_CONTEXT_PRESSURE_POLICY`
- Produces: `TurnPressureGovernor.noteUsage()` and `TurnPressureGovernor.noteToolResult()`
- Produces: serializable `CodexTurnPressureSnapshot`
- Consumes: only plain numbers and strings; no adapter, RPC, timers, or filesystem objects

- [ ] **Step 1: Write failing tests for the real growth shape using synthetic values**

Use a fixture that starts at 22,380 / 258,400, sends several provider usage updates, reaches the soft threshold, and continues toward 242,865. Do not copy tool content from the rollout.

```ts
const WINDOW = 258_400;

it('steers once at 70% and interrupts once at 82%', () => {
  const governor = new TurnPressureGovernor(CODEX_CONTEXT_PRESSURE_POLICY);

  expect(governor.noteUsage({ used: 180_000, total: WINDOW })).toEqual({ kind: 'none' });
  expect(governor.noteUsage({ used: 181_000, total: WINDOW })).toEqual({ kind: 'steer' });
  expect(governor.noteUsage({ used: 200_000, total: WINDOW })).toEqual({ kind: 'none' });
  expect(governor.noteUsage({ used: 212_000, total: WINDOW })).toEqual({ kind: 'interrupt' });
  expect(governor.noteUsage({ used: 242_865, total: WINDOW })).toEqual({ kind: 'none' });
});

it('interrupts immediately when one update jumps past both thresholds', () => {
  const governor = new TurnPressureGovernor(CODEX_CONTEXT_PRESSURE_POLICY);
  expect(governor.noteUsage({ used: 242_865, total: WINDOW })).toEqual({ kind: 'interrupt' });
});
```

- [ ] **Step 2: Run the focused spec and confirm RED**

Run:

```bash
npm run test:quiet -- src/main/cli/adapters/codex/turn-pressure-governor.spec.ts
```

Expected: FAIL because the policy and governor do not exist.

- [ ] **Step 3: Implement the immutable policy and pure governor**

```ts
export interface CodexContextPressurePolicy {
  toolOutputTokenLimit: number;
  steerAtPercentage: number;
  interruptAtPercentage: number;
  postTurnCompactAtPercentage: number;
  maxRecoveryAttempts: number;
}

export const CODEX_CONTEXT_PRESSURE_POLICY: Readonly<CodexContextPressurePolicy> = Object.freeze({
  toolOutputTokenLimit: 6_000,
  steerAtPercentage: 70,
  interruptAtPercentage: 82,
  postTurnCompactAtPercentage: 75,
  maxRecoveryAttempts: 1,
});

export type TurnPressureAction =
  | { kind: 'none' }
  | { kind: 'steer' }
  | { kind: 'interrupt' };

export interface CodexTurnPressureSnapshot {
  phase: 'normal' | 'steered' | 'interrupting' | 'compacting' | 'resuming' | 'recovered' | 'failed';
  apiCalls: number;
  toolCalls: number;
  toolOutputBytes: number;
  peakPercentage: number;
  recoveryAttempts: number;
  toolOutputTokenLimit: number;
}
```

Rules inside `noteUsage()`:

- Calculate `percentage` from `used / total`; ignore invalid or zero totals.
- Update `apiCalls` and `peakPercentage` before deciding.
- Check the hard threshold first so a single jump past 82% interrupts instead of merely steering.
- Emit each action at most once.
- `noteToolResult(bytes)` accepts only finite non-negative numbers and increments the observed counters.
- `beginRecovery()`, `markCompacting()`, `markResuming()`, `markRecovered()`, and `markFailed()` are explicit state transitions.
- `canRecover()` is true only while `recoveryAttempts < maxRecoveryAttempts`.

- [ ] **Step 4: Add edge-case tests**

Cover malformed totals, repeated 70% updates, repeated 82% updates, a direct <70→>82 jump, byte-count normalization, peak tracking, reset between user turns, and the one-recovery ceiling.

- [ ] **Step 5: Run the focused spec and confirm GREEN**

Run the Task 1 test command. Expected: PASS.

---

### Task 2: Make app-server notifications safely observable by concurrent consumers

**Files:**
- Modify: `src/main/cli/adapters/codex/app-server-client.ts`
- Test: `src/main/cli/adapters/codex/app-server-client.spec.ts`
- Create: `src/main/cli/adapters/codex/app-server-notification-waiter.ts`
- Create: `src/main/cli/adapters/codex/app-server-notification-waiter.spec.ts`

**Interfaces:**
- Produces: `AppServerClient.addNotificationListener(listener): () => void`
- Produces: `waitForAppServerNotification(client, predicate, timeoutMs): Promise<'matched' | 'timed-out'>`
- Consumes: `AppServerNotification`

The current client has one swappable handler. That loses idle compaction notifications and makes a compaction waiter race with turn capture. Replace it with a listener set.

- [ ] **Step 1: Write failing fan-out and disposal tests**

```ts
it('delivers one notification to every registered listener', () => {
  const first = vi.fn();
  const second = vi.fn();
  client.addNotificationListener(first);
  client.addNotificationListener(second);

  feedNotification(client, { method: 'thread/compacted', params: { threadId: 'thread-1' } });

  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
});

it('disposer removes only its own listener', () => {
  const first = vi.fn();
  const second = vi.fn();
  const disposeFirst = client.addNotificationListener(first);
  client.addNotificationListener(second);
  disposeFirst();

  feedNotification(client, { method: 'thread/compacted', params: { threadId: 'thread-1' } });

  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Implement listener fan-out with per-listener failure isolation**

```ts
private readonly notificationListeners = new Set<AppServerNotificationHandler>();

addNotificationListener(listener: AppServerNotificationHandler): () => void {
  this.notificationListeners.add(listener);
  return () => this.notificationListeners.delete(listener);
}

private emitNotification(notification: AppServerNotification): void {
  for (const listener of [...this.notificationListeners]) {
    try {
      listener(notification);
    } catch (error) {
      logger.warn('App-server notification listener failed', {
        method: notification.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
```

Do not log notification params.

- [ ] **Step 3: Update turn capture to subscribe/unsubscribe instead of save/restore**

In `captureTurn()`, register its filtered listener before `turn/start` and call the returned disposer in `finally`. Remove `notificationHandler`, `setNotificationHandler()`, and previous-handler forwarding.

- [ ] **Step 4: Implement and test the bounded notification waiter**

Register the listener before the initiating RPC to close the response-before-listener race. Always unsubscribe on match or timeout. Match exact thread IDs and either:

- deprecated `thread/compacted`, or
- `item/completed` whose item type is `contextCompaction`.

Use fake timers to prove timeout cleanup. A notification for `thread-2` must not release a waiter for `thread-1`.

- [ ] **Step 5: Run focused tests**

```bash
npm run test:quiet -- src/main/cli/adapters/codex/app-server-client.spec.ts src/main/cli/adapters/codex/app-server-notification-waiter.spec.ts
```

Expected: PASS.

---

### Task 3: Apply the provider-native tool-output limit to every Codex session path

**Files:**
- Modify: `src/main/cli/adapters/codex/app-server-types.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Test: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Test: `src/main/cli/adapters/codex-cli-adapter.spec.ts`

**Interfaces:**
- Consumes: `CODEX_CONTEXT_PRESSURE_POLICY.toolOutputTokenLimit`
- Produces: `buildCodexThreadConfig(): Record<string, unknown>`
- Produces: typed `turn/steer` request/response entries

- [ ] **Step 1: Extend local protocol types to match the locally generated Codex 0.144.3 schema**

Add `config?: Record<string, unknown> | null` to both `ThreadStartParams` and `ThreadResumeParams`. Add:

```ts
export interface TurnSteerParams {
  threadId: string;
  expectedTurnId: string;
  clientUserMessageId?: string | null;
  input: UserInput[];
}

export interface TurnSteerResponse {
  turnId: string;
}
```

Register `'turn/steer'` in `AppServerMethodMap`.

- [ ] **Step 2: Write failing tests for every thread path**

Assert `config: { tool_output_token_limit: 6000 }` is sent on:

- fresh `thread/start` in `initAppServerMode()`;
- `thread/resume` by exact ID;
- `thread/resume` from `thread/list`;
- `thread/resume` from JSONL scan;
- `thread/start` in `reopenAppServerThread()`;
- exec-mode argument construction.

For exec mode, expect the equivalent Codex override:

```text
-c tool_output_token_limit=6000
```

- [ ] **Step 3: Implement one helper and use it everywhere**

```ts
private buildCodexThreadConfig(): Record<string, unknown> {
  return {
    tool_output_token_limit: CODEX_CONTEXT_PRESSURE_POLICY.toolOutputTokenLimit,
  };
}
```

Do not edit the mirrored `config.toml`. Thread/request overrides keep the policy isolated to AIO sessions.

- [ ] **Step 4: Add a regression test that user config is not rewritten**

Use the existing sandbox-home test. Record `config.toml` before spawn and assert its bytes are unchanged afterward.

- [ ] **Step 5: Run focused tests**

```bash
npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts src/main/cli/adapters/codex-cli-adapter.spec.ts src/main/cli/adapters/codex/codex-home-manager.spec.ts
```

Expected: PASS.

---

### Task 4: Add same-turn steering and a bounded hard-pressure recovery ladder

**Files:**
- Create: `src/main/cli/adapters/codex/context-pressure-recovery.ts`
- Create: `src/main/cli/adapters/codex/context-pressure-recovery.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex/input-cap-recovery.ts`
- Modify: `src/main/cli/adapters/codex/input-cap-recovery.spec.ts`
- Delete: `src/main/cli/adapters/codex/compaction-gate.ts`
- Delete: `src/main/cli/adapters/codex/compaction-gate.spec.ts`
- Test: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`

**Interfaces:**
- Produces: `steerActiveTurnForPressure(threadId, turnId): Promise<boolean>`
- Produces: `compactContext(): Promise<boolean>` where true means completion was proven
- Produces: `recoverFromContextPressure(ops): Promise<'recovered' | 'failed'>`
- Consumes: `TurnPressureGovernor` actions and snapshots

- [ ] **Step 1: Define stable model-visible copy**

Put the copy in `context-pressure-policy.ts`, not inline in the adapter.

```ts
export const CODEX_PRESSURE_STEER_TEXT = [
  '[Context pressure guard]',
  'Current context is above 70%. Stop broad discovery now.',
  'Use the evidence already collected, run only essential targeted checks, and synthesize the final result.',
].join('\n');

export const CODEX_PRESSURE_CONTINUATION_TEXT = [
  '[Context pressure recovery]',
  'The previous turn was interrupted to preserve this thread after context exceeded the hard limit.',
  'Continue the original objective from the compacted state. Preserve completed work, avoid repeating broad discovery, run only essential checks, and finish with a clear result.',
].join('\n');
```

- [ ] **Step 2: Write failing same-turn steer tests**

At the first 70% notification, expect exactly one:

```ts
expect(request).toHaveBeenCalledWith('turn/steer', {
  threadId: 'thread-1',
  expectedTurnId: 'turn-1',
  clientUserMessageId: expect.stringMatching(/^aio-pressure-/),
  input: [{ type: 'text', text: CODEX_PRESSURE_STEER_TEXT, text_elements: [] }],
});
```

Repeated high usage must not steer again. A stale turn ID rejection is logged and ignored if the turn already completed.

- [ ] **Step 3: Refactor native compaction to require proof**

`compactContext()` must:

1. Refuse while `turnInProgress` is true.
2. Start the matching notification waiter before calling `thread/compact/start`.
3. Return true only for `matched`.
4. Return false on RPC failure or timeout.
5. Reset cached occupancy only after proof, not after the start response.

After this change, simplify `InputCapRecoveryOps` by removing `awaitCompaction()`. `compact()` itself is the proven completion boundary. Preserve every existing ladder test.

- [ ] **Step 4: Write the pure recovery ladder tests**

```ts
export interface ContextPressureRecoveryOps {
  interrupt(): Promise<TurnInterruptCompletion>;
  compact(): Promise<boolean>;
  resume(): Promise<void>;
  onPhase(phase: CodexTurnPressureSnapshot['phase']): void;
}
```

Cover:

- accepted interrupt → interrupted completion proof → compact true → resume once → `recovered`;
- turn completed naturally before interrupt landed → compact if still above post-turn threshold, but do not duplicate the answer;
- interrupt rejection → `failed`, no compact or resume;
- compact false/timeout → `failed`, no fresh thread and no resume;
- resume failure → `failed`, no second recovery;
- a second hard-pressure event after recovery is not retried.

- [ ] **Step 5: Wire governor decisions without blocking notification dispatch**

The notification listener updates pressure state synchronously, then schedules RPC work with `queueMicrotask()` or a stored promise. Do not `await` RPCs inside the listener.

Track active items. Dispatch the hard interrupt after the current `item/completed` boundary; if usage jumps above 82% while no item is active, dispatch immediately. User-requested interrupt always wins over the pressure guard.

- [ ] **Step 6: Refactor the app-server send path into one externally completed response**

The pressure-interrupted partial turn must not emit adapter `complete`. The outer send operation owns completion and may run one continuation turn on the same thread. It emits one final response and one `complete` event total.

Preserve streamed assistant/tool messages from the first attempt. Add a system message for each phase transition with metadata only:

```ts
metadata: {
  contextPressureGuard: true,
  phase: 'steered' | 'interrupting' | 'compacting' | 'resuming' | 'recovered' | 'failed',
  percentage,
}
```

- [ ] **Step 7: Run focused recovery tests**

```bash
npm run test:quiet -- src/main/cli/adapters/codex/context-pressure-recovery.spec.ts src/main/cli/adapters/codex/input-cap-recovery.spec.ts src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts
```

Expected: PASS.

---

### Task 5: Replace the binary self-managed flag with scope-aware context ownership

**Files:**
- Modify: `src/main/cli/adapters/base-cli-adapter.types.ts`
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/acp-cli-adapter.ts`
- Modify: `src/main/cli/adapters/antigravity-cli-adapter.ts`
- Modify: `src/main/cli/adapters/copilot-cli-adapter.ts`
- Modify: `src/main/cli/adapters/cursor-cli-adapter.ts`
- Modify: `src/main/cli/adapters/gemini-cli-adapter.ts`
- Modify: `src/main/cli/adapters/local-model-chat-adapter.ts`
- Modify: `src/main/cli/adapters/remote-cli-adapter.ts`
- Modify: `src/main/cli/adapters/remote-local-model-adapter.ts`
- Modify: `src/main/cli/adapters/scripted-cli-adapter.ts`
- Modify: `src/main/cli/spawn-worker/cli-adapter-worker-proxy.ts`
- Modify: `src/main/providers/provider-runtime-service.ts`
- Modify: `src/main/instance/instance-communication-adapter-helpers.ts`
- Modify: `src/main/instance/lifecycle/runtime-readiness.ts`
- Modify: `src/main/context/compaction-coordinator.ts`
- Modify: `src/main/app/compaction-runtime.ts`
- Modify: `src/main/instance/instance-communication.ts`
- Modify: `src/main/instance/instance-state.ts`
- Test: corresponding adapter, coordinator, runtime, and instance-state specs

**Interfaces:**
- Removes: `selfManagedAutoCompaction?: boolean`
- Produces: `contextManagement: AdapterContextManagementCapabilities`
- Produces: `CompactionCoordinator.onTurnCompleted(instanceId)`

- [ ] **Step 1: Add the scope contract and failing capability tests**

```ts
export type ContextManagementScope = 'none' | 'during-turn' | 'between-turns' | 'both';

export interface AdapterContextManagementCapabilities {
  providerAutoCompaction: ContextManagementScope;
  adapterPressureGuard: ContextManagementScope;
  coordinatorAutoCompaction: ContextManagementScope;
}

export interface AdapterRuntimeCapabilities {
  supportsResume: boolean;
  supportsForkSession: boolean;
  supportsNativeCompaction: boolean;
  supportsPermissionPrompts: boolean;
  supportsDeferPermission: boolean;
  contextManagement: AdapterContextManagementCapabilities;
}
```

Required mappings:

| Adapter mode | Provider auto-compaction | Adapter-local guard | Generic coordinator |
|---|---|---|---|
| Claude stream | `both` | `none` | `none` |
| Codex app-server | `during-turn` | `during-turn` | `between-turns` |
| Codex exec | `none` | `none` | `both` |
| Generic/base, Gemini, Copilot, Cursor, local | `none` | `none` | `both` |
| Remote Claude | `both` | `none` | `none` |
| Unknown remote | `none` | `none` | `both` |

- [ ] **Step 2: Replace boolean gating in the coordinator**

`onContextUpdate()` may run the generic in-turn auto-compaction path only when `coordinatorAutoCompaction` includes `during-turn`. Codex app-server reports `adapterPressureGuard: 'during-turn'` and `coordinatorAutoCompaction: 'between-turns'`, so the generic coordinator cannot call `thread/compact/start` while Codex is busy.

Add an injected capability predicate with an explicit name, for example:

```ts
canRunGenericInTurnCompaction(instanceId: string): boolean
```

Do not infer this from `supportsNativeCompaction`.

- [ ] **Step 3: Add between-turn compaction**

Implement:

```ts
async onTurnCompleted(instanceId: string): Promise<CompactionResult | null>
```

For Codex app-server, when the latest usage is at least 75%, the instance is idle, the cooldown/circuit breaker allow it, and native compaction is supported, run verified native compaction. Return null below threshold or when another compaction is running.

The adapter's `complete` event is the trigger. Ensure status becomes idle before the coordinator calls native compaction. Input remains blocked only while verified post-turn compaction is in progress.

- [ ] **Step 4: Keep warnings honest**

Remove the `supportsNativeCompaction` shortcut from `InstanceCommunication.checkContextWarningThreshold()`. A callable compact hook does not mean context pressure is already handled.

Warnings remain visible for Codex. Claude may suppress only the AIO-action warning because its provider scope is `both`; current occupancy remains visible in the diagnostics panel.

- [ ] **Step 5: Replace all boolean serialization and renderer state plumbing**

Run:

```bash
rg -n "selfManagedAutoCompaction|selfManagesAutoCompaction" src
```

Expected after migration: no matches outside a migration note or completed plan. Update every test fixture rather than making the new field optional.

- [ ] **Step 6: Run focused capability and compaction tests**

```bash
npm run test:quiet -- src/main/context/compaction-coordinator.spec.ts src/main/app/compaction-runtime.spec.ts src/main/instance/__tests__/instance-state-self-managed-compaction.spec.ts src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts src/main/cli/adapters/__tests__/claude-cli-adapter.spec.ts src/main/cli/adapters/__tests__/remote-cli-adapter.spec.ts
```

Rename the instance-state spec to `instance-state-context-management.spec.ts` as part of the migration. Expected: PASS.

---

### Task 6: Carry accurate cache and per-turn pressure telemetry to the renderer

**Files:**
- Modify: `src/shared/types/instance.types.ts`
- Modify: `src/renderer/app/core/state/instance/instance.types.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/providers/adapter-runtime-event-bridge.ts`
- Modify: `packages/contracts/src/types/provider-runtime-events.ts`
- Modify: `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`
- Modify: corresponding contract and bridge specs
- Modify: renderer update-batcher and instance stores listed in the file map

**Interfaces:**
- Extends: `ContextUsage`
- Extends: `ProviderContextEvent`

- [ ] **Step 1: Add optional, clone-safe fields**

```ts
export interface ContextUsage {
  // existing fields...
  cachedInputTokens?: number;
  cumulativeCachedInputTokens?: number;
  turnPressure?: CodexTurnPressureSnapshot;
}
```

Put the shared serializable snapshot type in `src/shared/types/instance.types.ts`; the main governor imports it. Do not place class instances, Sets, Maps, Errors, or promises in IPC state.

Extend `ProviderContextEvent` and its Zod schema with the same numeric fields and a bounded pressure object. Every number is finite, integer, and non-negative; percentage is 0–100; phase is an enum.

- [ ] **Step 2: Parse the complete Codex token breakdown**

From `thread/tokenUsage/updated` extract both camelCase and snake_case fields:

```ts
const cachedInputTokens = numberField(last, 'cachedInputTokens', 'cached_input_tokens');
const cumulativeCachedInputTokens = numberField(total, 'cachedInputTokens', 'cached_input_tokens');
const inputTokens = numberField(last, 'inputTokens', 'input_tokens');
const outputTokens = numberField(last, 'outputTokens', 'output_tokens');
```

Attach the current governor snapshot. Keep `last.totalTokens` as occupancy and `total.totalTokens` as lifetime processing.

- [ ] **Step 3: Add contract round-trip and bridge tests**

Prove the new fields survive adapter event → normalized provider event → instance snapshot → renderer store. Also prove old persisted instances without these fields still load.

- [ ] **Step 4: Run focused telemetry tests**

```bash
npm run test:quiet -- packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts src/main/providers/adapter-runtime-event-bridge.spec.ts src/main/instance/__tests__/instance-manager.normalized-event.spec.ts src/renderer/app/core/state/instance/instance-list.store.spec.ts
```

Expected: PASS.

---

### Task 7: Make the context UI explain occupancy, lifetime work, cache, and guard actions

**Files:**
- Create: `src/renderer/app/features/instance-detail/context-pressure-summary.ts`
- Create: `src/renderer/app/features/instance-detail/context-pressure-summary.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/composer-toolbar.component.ts`
- Modify: `src/renderer/app/features/instance-detail/composer-toolbar.component.spec.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`

**Interfaces:**
- Consumes: `ContextUsage`
- Produces: pure `buildContextDiagnosticItems(usage)`

- [ ] **Step 1: Write failing formatting tests**

For the incident values, require these meanings:

```text
Window   242,865 / 258,400 (94%)
Lifetime 18.91M processed · 98.2% cached
Turn     86 calls · 953 kB observed tool output
Guard    Interrupted at 82% · compacting
```

Do not label lifetime processing as current context. Do not show cache percentage when either numerator or denominator is missing. Use “observed tool output” because some MCP/dynamic tools do not expose full result bytes to AIO.

- [ ] **Step 2: Implement pure formatting helpers**

Return diagnostic item models, not HTML. Format token counts with locale separators below one million and two-decimal compact notation at or above one million. Clamp cache percentage to 0–100.

- [ ] **Step 3: Update the diagnostics panel**

Replace the single ambiguous `Context 94%` pill with separate `Window`, optional `Lifetime`, optional `Turn`, and optional `Guard` pills. Tone rules:

- Window warning at 70%, danger at 82%.
- Guard warning for `steered`, danger for `interrupting` or `failed`.
- Compaction/resume phases use the normal informational tone.

- [ ] **Step 4: Keep the compact ring but improve its tooltip**

The ring label remains the rounded current-window percentage. The tooltip includes exact current tokens, lifetime processing, and guard phase when known. It never uses cumulative tokens to calculate the ring.

- [ ] **Step 5: Restore context warnings for Codex**

Replace the renderer's `if (inst.selfManagesAutoCompaction) return null` gate with scope-aware behavior. Codex warnings remain visible and say what AIO has actually done:

- 70–81%: “Context pressure: asked Codex to synthesize.”
- 82%+: “Context pressure: stopping this turn to compact safely.”
- post-turn compaction: “Compacting before the next message.”

Never show “compaction pending” until a compaction has actually been scheduled.

- [ ] **Step 6: Run focused renderer tests**

```bash
npm run test:quiet -- src/renderer/app/features/instance-detail/context-pressure-summary.spec.ts src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.spec.ts src/renderer/app/features/instance-detail/composer-toolbar.component.spec.ts
```

Expected: PASS.

---

### Task 8: Prove bounded growth, continuity, and no duplicate completion

**Files:**
- Modify: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify: `src/main/context/compaction-coordinator.spec.ts`
- Create at implementation completion if external validation remains: `docs/superpowers/plans/2026-07-13-codex-context-pressure-guard_livetest.md`

**Interfaces:**
- Consumes all prior tasks
- Produces acceptance evidence

- [ ] **Step 1: Add the synthetic 86-call regression**

Drive the adapter with synthetic `thread/tokenUsage/updated`, `item/completed`, and `turn/completed` notifications. Assert:

- thread config includes the 6,000-token limit;
- one soft steer at 70%;
- one hard interrupt at 82%;
- no additional tool calls are accepted after interrupt completion;
- compaction waits for matching proof;
- one continuation turn starts on the same thread;
- only one adapter `complete` event fires;
- no fresh thread is created;
- final pressure snapshot records peak percentage and recovery.

- [ ] **Step 2: Add race tests**

Cover:

- turn completes between the 82% notification and `turn/interrupt` response;
- user interrupt and pressure interrupt race;
- `thread/compacted` arrives before `thread/compact/start` returns;
- unrelated thread compacts first;
- app-server exits during compaction;
- stale pressure work from a replaced adapter is ignored;
- model switch/restart clears governor state.

- [ ] **Step 3: Run all targeted specs from Tasks 1–8 together**

Expected: PASS with no focused/skipped tests.

- [ ] **Step 4: Run the canonical project gates**

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

Expected: every command exits 0. If `codex-cli-adapter.ts` breaches the LOC gate, extract orchestration into the new governor/recovery helpers; do not suppress the check.

- [ ] **Step 5: Perform agent-runnable app-server integration checks**

Using a temporary isolated Codex home and the locally installed app-server:

1. Start a temporary thread and inspect the effective request to confirm `tool_output_token_limit=6000`.
2. Run a deterministic command that produces more than 6,000 tokens and confirm the stored model-visible result is bounded.
3. Send `turn/steer` with the active turn ID and confirm the same turn accepts it.
4. Trigger idle `thread/compact/start` and confirm a matching completion item is observed before AIO reports success.
5. Resume the same thread and confirm the effective override remains present.

Do not print auth details, injected MCP secrets, or full config payloads.

- [ ] **Step 6: Record only genuinely external/human checks in a livetest doc**

If the final packaged Electron app must be rebuilt/restarted for visual confirmation, create the `_livetest.md` file with exact prerequisites, actions, expected results, and the reason each check cannot run in-loop. Candidate checks:

- diagnostics pills and tooltip in the packaged renderer;
- long authenticated Codex turn under real backend timing;
- continuity after a real pressure interrupt and native compaction.

Do not rename this plan `_completed` until all agent-runnable checks pass and every remaining check qualifies under the repo's Live-Test Deferral rules.

---

## Acceptance checklist

- [ ] AIO supplies `tool_output_token_limit=6000` to every Codex start/resume/reopen and exec path without modifying user config.
- [ ] Current-window occupancy still comes from Codex `last.totalTokens`.
- [ ] Lifetime processing still comes from Codex `total.totalTokens`.
- [ ] Cached input is parsed and displayed separately.
- [ ] At 70%, a regular active turn receives at most one same-turn steer.
- [ ] At 82%, continued growth triggers at most one interrupt.
- [ ] Pressure recovery compacts only after the turn is no longer active.
- [ ] Compaction success requires a matching completion notification.
- [ ] Recovery resumes at most once on the same thread.
- [ ] Pressure-recovery failure never silently creates a fresh thread.
- [ ] The existing input-character-cap ladder remains operational.
- [ ] A high-pressure successful turn compacts between turns before new input is accepted.
- [ ] One user submission emits one final adapter completion.
- [ ] Codex context warnings are visible and describe actual scheduled actions.
- [ ] The ring is based only on current occupancy, never lifetime tokens.
- [ ] Synthetic incident, race, targeted, typecheck, lint, LOC, and full-suite gates pass.

## Risks and mitigations

| Risk | Mitigation | Required evidence |
|---|---|---|
| 6,000 tokens truncates a whole-file dump | Codex retains a bounded result and the agent can use targeted line ranges; steer copy explicitly requests targeted checks | Oversized-output integration test plus a multi-chunk file-read test |
| `turn/steer` lands after natural completion | Require `expectedTurnId`; treat stale-turn rejection as a no-op | Completion/steer race test |
| Interrupt duplicates or loses final output | Outer send owns one completion; preserve first-attempt stream; resume only without a completed final answer | One-complete and natural-completion race tests |
| Compaction start is mistaken for compaction completion | Register a matching notification waiter before the RPC and require proof | Early-notification and timeout tests |
| Provider and AIO compaction race | Scope-aware ownership; no `thread/compact/start` during an active turn; compaction single-flight | Concurrent auto/manual compaction test |
| Hard stop loops forever | One recovery attempt per user submission | Second-pressure-event test |
| A pressure failure silently loses context | No fresh-thread fallback in pressure recovery | Compact-failure test asserting `reopenThread` is absent |
| UI repeats the original misleading 94% story | Separate Window, Lifetime, Turn, and Guard labels | Exact incident-format test |

## Out of scope

- Automatic subagent spawning when multi-agent policy is `explicitRequestOnly`.
- Changing project instructions that require whole-file reading.
- Replacing Codex's context manager or stored rollout format.
- A provider-agnostic hard-interrupt governor for Claude, Gemini, Copilot, Cursor, or local models.
- Polling redesign for long shell commands; completion notifications remain a separate performance task.
- Claiming cached input protects the context ceiling. It only reduces repeated-processing cost and latency.

## Implementation handoff

Execute tasks in order. Tasks 1–4 form the preventative Codex guard. Task 5 makes compaction ownership honest. Tasks 6–7 make the behavior observable. Task 8 is the completion gate. Keep each task's diff reviewable and run its focused tests before moving on.
