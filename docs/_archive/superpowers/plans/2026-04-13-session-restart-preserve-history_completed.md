# Session Restart — Preserve History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the nuclear `restartInstance` with two explicit user actions — `Restart (resume context)` that wires through the existing `SessionRecoveryHandler`, and `Restart (fresh context)` that archives the old transcript and starts a new backend session while keeping the prior conversation visible.

**Architecture:** Add identity-splitting fields (`providerSessionId`, `restartEpoch`, `recoveryMethod`, `archivedUpToMessageId`) to `Instance`. Implement the two production deps (`nativeResume`, `replayFallback`) that `SessionRecoveryHandler` needs, wire them into a refactored `restartInstance`, and add a new `restartFreshInstance` code path. A monotonic `restartEpoch` tag on adapter events prevents late events from killed processes from leaking into the new session. Renderer exposes a split button; failure enters a banner-guarded error state.

**Tech Stack:** TypeScript 5.9, Electron 40 (main), Angular 21 zoneless + signals (renderer), Zod 4 (IPC), vitest, better-sqlite3 (unchanged for this feature).

**Spec:** `docs/superpowers/specs/2026-04-13-session-restart-preserve-history-design.md`

**Scope note (MVP only):** This plan implements the MVP subset from the spec (§10). Deferred to V2: `TranscriptSegment[]` data-model migration (this plan uses the `archivedUpToMessageId` sentinel), fine-grained `backendSession*` / `threadLifetime*` counter split, confirmed resume support for Gemini and Copilot adapters.

---

## File Map

**Types / IPC contract:**
- Modify: `src/shared/types/instance.types.ts` (add fields to `Instance`)
- Modify: `packages/contracts/src/channels/instance.channels.ts` (new channel)
- Modify: `packages/contracts/src/schemas/instance.schemas.ts` (new payload schema)
- Modify: `src/preload/domains/instance.preload.ts` (expose new IPC method)

**Main-process restart logic:**
- Modify: `src/main/instance/instance-lifecycle.ts` (refactor `restartInstance`, add `restartFreshInstance`, wire epoch)
- Modify: `src/main/instance/instance-manager.ts` (add `restartFreshInstance` delegator)
- Create: `src/main/instance/lifecycle/recovery-deps.ts` (production `nativeResume` + `replayFallback` for `SessionRecoveryHandler`)
- Modify: `src/main/ipc/handlers/instance-handlers.ts` (new IPC handler)

**Context-construction boundary:**
- Modify: any site that converts `instance.outputBuffer` into prompt context — confirmed sites: `src/main/instance/instance-lifecycle.ts:491-495` (existing fallback-history path) and any send-input paths — add an `archivedUpToMessageId` filter helper in a new small util.
- Create: `src/main/instance/lifecycle/transcript-window.ts` (helper `getActiveMessages(instance): OutputMessage[]`)

**Renderer:**
- Modify: `src/renderer/app/features/instance-row.component.ts` (split button, emits `restart` or `restartFresh`)
- Modify: `src/renderer/app/features/instance-row.component.html` (split-button markup)
- Modify: `src/renderer/app/features/instance-row.component.scss` (styling)
- Modify: parent component that currently handles `restart.emit(instanceId)` (trace via `restart.emit(instanceId)` usage) — add a sibling handler for `restartFresh`
- Modify: renderer-side store or service that calls `window.electronAPI.restartInstance(...)` — add `restartFreshInstance` mirror
- Modify: renderer component that renders the instance error banner — add recovery-failure variant with CTA

**Tests:**
- Create: `src/main/instance/lifecycle/__tests__/recovery-deps.spec.ts`
- Create: `src/main/instance/lifecycle/__tests__/transcript-window.spec.ts`
- Modify: `src/main/ipc/handlers/__tests__/instance-handlers.spec.ts` (new channel coverage)
- Modify: (or create) a vitest spec for `restartInstance` / `restartFreshInstance` under `src/main/instance/__tests__/` — follow existing patterns

---

## Task 1: Add new fields to `Instance` type

**Files:**
- Modify: `src/shared/types/instance.types.ts` (lines ~170-240 and the `createEmptyInstanceMetrics`/factory around line 355)
- Modify (if present): any `createEmptyInstance`-style factory in the same file or `src/main/instance/instance-factory.ts`

- [ ] **Step 1: Write the failing test**

Create: `src/shared/types/__tests__/instance.types.spec.ts` (or append to an existing factory test if one exists — check first):

```ts
import { describe, it, expect } from 'vitest';
import type { Instance } from '../instance.types';

describe('Instance type — restart identity fields', () => {
  it('has providerSessionId and restartEpoch required for new instances', () => {
    const instance = {
      // minimal fields — will fail to typecheck until Instance is extended
      id: 'inst-1',
      sessionId: 'sess-1',
      providerSessionId: 'sess-1',
      historyThreadId: 'thread-1',
      restartEpoch: 0,
      restartCount: 0,
    } satisfies Partial<Instance>;

    expect(instance.providerSessionId).toBe('sess-1');
    expect(instance.restartEpoch).toBe(0);
  });

  it('accepts optional recoveryMethod and archivedUpToMessageId', () => {
    const i: Partial<Instance> = {
      recoveryMethod: 'replay',
      archivedUpToMessageId: 'msg-42',
    };
    expect(i.recoveryMethod).toBe('replay');
    expect(i.archivedUpToMessageId).toBe('msg-42');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/shared/types/__tests__/instance.types.spec.ts`
Expected: FAIL — typecheck errors on `providerSessionId`, `restartEpoch`, `recoveryMethod`, `archivedUpToMessageId` not being properties of `Instance`.

- [ ] **Step 3: Add the fields to the `Instance` interface**

In `src/shared/types/instance.types.ts`, locate the `Instance` interface. Add:

```ts
export interface Instance {
  // ... existing fields ...

  /** Stable thread-continuity key. Already exists; now required and explicit. */
  historyThreadId: string;

  /**
   * Current provider-backend resumable session handle. New on replay-fallback
   * and fresh restart; preserved on native resume. Semantically distinct from
   * `sessionId` (legacy alias; reads through to this field during migration).
   */
  providerSessionId: string;

  /**
   * Monotonic restart counter used to tag adapter events. Events whose epoch
   * does not match `instance.restartEpoch` are dropped — prevents ghost output
   * from a slow-terminating old adapter leaking into the new session.
   */
  restartEpoch: number;

  /** Last recovery outcome for debugging + UI surface. Unset before first restart. */
  recoveryMethod?: 'native' | 'replay' | 'fresh' | 'failed';

  /**
   * MVP-only sentinel: ID of the last `OutputMessage` that is part of the
   * archived (previous) session. Context-construction must ignore messages
   * at-or-before this ID. V2 replaces this with TranscriptSegment[].
   */
  archivedUpToMessageId?: string;

  // ... rest of existing fields (status, outputBuffer, contextUsage, etc.) ...
}
```

Also update any in-file factory that builds default `Instance` instances to default `providerSessionId = sessionId` and `restartEpoch = 0`. If such a factory does not exist in this file, add the same defaults in the creation site at `src/main/instance/instance-lifecycle.ts` around line 531 / 687 (where `sessionId` is assigned today) — done in Task 2.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/shared/types/__tests__/instance.types.spec.ts`
Expected: PASS (2/2).

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: May surface new errors in call sites that construct `Instance` — fix each site by initializing `providerSessionId: sessionId` and `restartEpoch: 0`. Common sites: `instance-lifecycle.ts` (creation path near lines 531 and 687), any test fixtures under `src/main/instance/__tests__/`.

Record every file touched in this sweep; commit them together in step 6.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/instance.types.ts src/shared/types/__tests__/instance.types.spec.ts \
  src/main/instance/instance-lifecycle.ts \
  $(git diff --name-only | grep -E '__tests__|instance-factory|instance-manager')
git commit -m "feat(instance): add providerSessionId, restartEpoch, recoveryMethod, archivedUpToMessageId fields"
```

---

## Task 2: Populate new fields at instance creation

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` (creation paths around lines 531 and 687)

- [ ] **Step 1: Write the failing test**

Append to (or create) `src/main/instance/__tests__/instance-creation.spec.ts` — follow the singleton `_resetForTesting()` pattern used in existing `instance-lifecycle` tests:

```ts
describe('instance creation — identity fields', () => {
  it('sets providerSessionId equal to sessionId and restartEpoch to 0 on new instance', async () => {
    // Use existing test fixture for creating an instance.
    // Replace `createTestInstance` with your codebase's actual fixture.
    const instance = await createTestInstance({ provider: 'claude' });

    expect(instance.providerSessionId).toBe(instance.sessionId);
    expect(instance.restartEpoch).toBe(0);
    expect(instance.recoveryMethod).toBeUndefined();
    expect(instance.archivedUpToMessageId).toBeUndefined();
  });
});
```

If no test fixture exists, construct the instance via the same public entry point that production code uses (e.g., `instanceManager.createInstance(...)`) with minimal config.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/instance/__tests__/instance-creation.spec.ts -t "identity fields"`
Expected: FAIL — either `providerSessionId` is `undefined` or fields are missing.

- [ ] **Step 3: Initialize fields in the creation paths**

In `src/main/instance/instance-lifecycle.ts`, at the two construction sites around lines 531 and 687, set:

```ts
const newSessionId = config.sessionId || generateId();
const instance: Instance = {
  // ... existing ...
  sessionId: newSessionId,
  providerSessionId: newSessionId,   // NEW
  historyThreadId: config.historyThreadId || newSessionId,
  restartEpoch: 0,                   // NEW
  // recoveryMethod and archivedUpToMessageId intentionally undefined
  // ... existing ...
};
```

Repeat at line ~531 for the other path.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/main/instance/__tests__/instance-creation.spec.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts src/main/instance/__tests__/instance-creation.spec.ts
git commit -m "feat(instance): initialize providerSessionId and restartEpoch on creation"
```

---

## Task 3: Restart epoch tagging on adapter events (race protection)

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` — the `setupAdapterEvents` dependency and any inline handlers that read `instance.outputBuffer` from adapter callbacks.

- [ ] **Step 1: Locate `setupAdapterEvents` wiring**

Find the `setupAdapterEvents(instanceId, adapter)` call site (referenced in `restartInstance` at line 1782). Open the implementation — it's a dep function provided to `InstanceLifecycle` via `this.deps.setupAdapterEvents`. Trace back to where those deps are constructed and open that file.

- [ ] **Step 2: Write the failing test**

Create: `src/main/instance/lifecycle/__tests__/adapter-event-epoch.spec.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { wrapAdapterEventHandlerWithEpoch } from '../adapter-event-epoch';

describe('wrapAdapterEventHandlerWithEpoch', () => {
  it('dispatches events whose epoch matches the instance epoch', () => {
    const handler = vi.fn();
    const instance = { restartEpoch: 2 } as { restartEpoch: number };
    const wrapped = wrapAdapterEventHandlerWithEpoch(handler, instance, 2);

    wrapped({ type: 'output', data: 'hello' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('drops events whose captured epoch is stale', () => {
    const handler = vi.fn();
    const instance = { restartEpoch: 3 } as { restartEpoch: number };
    const wrapped = wrapAdapterEventHandlerWithEpoch(handler, instance, 2);

    wrapped({ type: 'output', data: 'ghost' });
    expect(handler).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/adapter-event-epoch.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Create the helper**

Create `src/main/instance/lifecycle/adapter-event-epoch.ts`:

```ts
export function wrapAdapterEventHandlerWithEpoch<TEvent>(
  handler: (event: TEvent) => void,
  instance: { restartEpoch: number },
  capturedEpoch: number,
): (event: TEvent) => void {
  return (event: TEvent) => {
    if (instance.restartEpoch !== capturedEpoch) return;
    handler(event);
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/adapter-event-epoch.spec.ts`
Expected: PASS (2/2).

- [ ] **Step 6: Apply the wrapper in adapter event setup**

In the `setupAdapterEvents` implementation file, for each adapter event subscription (e.g., `adapter.on('output', handler)`, `adapter.on('tool-call', handler)`, etc.), capture the current `instance.restartEpoch` at subscription time and wrap the handler:

```ts
// Before:
adapter.on('output', (event) => { /* ... */ });

// After:
const epochAtSubscribe = instance.restartEpoch;
adapter.on(
  'output',
  wrapAdapterEventHandlerWithEpoch(
    (event) => { /* ... same body ... */ },
    instance,
    epochAtSubscribe,
  ),
);
```

Do this for **all** event types emitted by the adapter that mutate `instance` state or fire IPC updates.

- [ ] **Step 7: Typecheck + run existing instance tests**

Run: `npx tsc --noEmit && npx vitest run src/main/instance/`
Expected: PASS. If any test asserts on event ordering, re-run — epoch wrapping should be transparent in single-restart happy paths.

- [ ] **Step 8: Commit**

```bash
git add src/main/instance/lifecycle/adapter-event-epoch.ts \
  src/main/instance/lifecycle/__tests__/adapter-event-epoch.spec.ts \
  $(git diff --name-only | grep -E 'instance.*lifecycle|event')
git commit -m "feat(instance): tag adapter events with restart epoch to drop ghost events"
```

---

## Task 4: Clear pending interactive state on restart

**Context:** The spec (§3.2 / §4.2) requires clearing pending interactive state — pending tool-call approvals, `INPUT_REQUIRED` prompts, in-flight IPC awaits — so the new adapter doesn't inherit broken state from the dead process. Investigation found no explicit `pendingApproval` field on the `Instance` type, so pending state lives in per-manager maps. This task surveys the managers, builds a small helper, and wires it into both restart paths.

**Files:**
- Create: `src/main/instance/lifecycle/pending-state.ts`
- Create: `src/main/instance/lifecycle/__tests__/pending-state.spec.ts`
- Modify: `src/main/instance/instance-lifecycle.ts` (call from restart paths — Tasks 8 and 10)

- [ ] **Step 1: Survey per-instance pending state**

Run each of these and record the hits:
- `Grep "INPUT_REQUIRED" src/main` — input-required prompts waiting on user reply.
- `Grep "pendingApprov" src/main` — MCP permission / tool-call approvals.
- `Grep "Map<string" src/main/instance src/main/mcp src/main/ipc` — any per-instance registry that may hold pending requests keyed by instanceId.

Write findings into scratch notes. Expected categories:
- MCP permission approvals awaiting user response.
- INPUT_REQUIRED prompts (`instance:input-required` → `instance:input-required-respond`).
- Any ad-hoc `Map<instanceId, Promise>` waiting on adapter output.

Only include in the clear helper those that genuinely persist across adapter lifecycle (i.e., that the new adapter could observe as stale). Ignore state that lives on the old adapter object — it dies with `terminate(true)`.

- [ ] **Step 2: Write the failing test**

Create `src/main/instance/lifecycle/__tests__/pending-state.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { clearPendingInstanceState } from '../pending-state';

describe('clearPendingInstanceState', () => {
  it('invokes every registered clearer with the instanceId', () => {
    const clearA = vi.fn();
    const clearB = vi.fn();

    clearPendingInstanceState('inst-1', { clearers: [clearA, clearB] });

    expect(clearA).toHaveBeenCalledWith('inst-1');
    expect(clearB).toHaveBeenCalledWith('inst-1');
  });

  it('does not throw when a clearer throws; logs and continues', () => {
    const throwing = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const second = vi.fn();

    expect(() => clearPendingInstanceState('inst-1', {
      clearers: [throwing, second],
    })).not.toThrow();

    expect(second).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/pending-state.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the helper**

Create `src/main/instance/lifecycle/pending-state.ts`:

```ts
import { getLogger } from '../../logging/logger';

const logger = getLogger('PendingState');

export type PendingStateClearer = (instanceId: string) => void;

export interface ClearPendingConfig {
  clearers: PendingStateClearer[];
}

export function clearPendingInstanceState(
  instanceId: string,
  config: ClearPendingConfig,
): void {
  for (const clear of config.clearers) {
    try {
      clear(instanceId);
    } catch (err) {
      logger.warn('pending-state clearer threw; continuing', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
```

- [ ] **Step 5: Register clearers from the main process setup**

At the site where `InstanceLifecycle` is constructed (same file as Task 9), build the clearer list from the registries found in Step 1:

```ts
import { clearPendingInstanceState } from './lifecycle/pending-state';

const pendingClearers = [
  (id: string) => getMcpManager().clearPendingApprovals?.(id),
  (id: string) => getInputRequiredRegistry().clearForInstance?.(id),
  // add one line per registry found in Step 1
];

// Pass into lifecycle deps:
this.lifecycle = new InstanceLifecycle({
  // ... other deps ...
  clearPendingState: (id: string) =>
    clearPendingInstanceState(id, { clearers: pendingClearers }),
});
```

If a registry doesn't yet have a `clearForInstance` / `clearPendingApprovals` method, add a minimal one that calls `.delete(id)` on its internal Map and emits a `RestartCancelled` rejection to any pending promise:

```ts
// Example pattern for a registry holding pending promises
clearForInstance(instanceId: string): void {
  const pending = this.pendingByInstance.get(instanceId);
  if (!pending) return;
  for (const { reject } of pending.values()) {
    reject(new Error('RestartCancelled'));
  }
  this.pendingByInstance.delete(instanceId);
}
```

- [ ] **Step 6: Add `clearPendingState` to `InstanceLifecycleDeps`**

```ts
interface InstanceLifecycleDeps {
  // ...
  clearPendingState: (instanceId: string) => void;
}
```

(Tasks 8 and 10 will call `this.deps.clearPendingState(instanceId)` at the top of the restart flows — right after bumping `restartEpoch`, before terminating the adapter.)

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/pending-state.spec.ts && npx tsc --noEmit`
Expected: PASS (2/2). Typecheck passes.

- [ ] **Step 8: Commit**

```bash
git add src/main/instance/lifecycle/pending-state.ts \
  src/main/instance/lifecycle/__tests__/pending-state.spec.ts \
  $(git diff --name-only | grep -E 'instance-manager|mcp-manager|ipc/handlers')
git commit -m "feat(instance): add clearPendingInstanceState helper with registry integration"
```

---

## Task 5: Implement `nativeResume` and `replayFallback` deps

**Files:**
- Create: `src/main/instance/lifecycle/recovery-deps.ts`
- Create: `src/main/instance/lifecycle/__tests__/recovery-deps.spec.ts`

- [ ] **Step 1: Write the failing test for `nativeResume`**

Create `src/main/instance/lifecycle/__tests__/recovery-deps.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createRecoveryDeps } from '../recovery-deps';

describe('nativeResume', () => {
  it('spawns adapter with resume flag and the existing providerSessionId', async () => {
    const instance = {
      id: 'inst-1',
      providerSessionId: 'psess-abc',
      historyThreadId: 'thread-1',
      currentModel: 'claude-sonnet-4-6',
      provider: 'claude',
      workingDirectory: '/tmp',
      yoloMode: false,
      executionLocation: 'local',
    };
    const spawn = vi.fn().mockResolvedValue(1234);
    const adapter = { spawn, terminate: vi.fn() };
    const createAdapter = vi.fn().mockReturnValue(adapter);

    const deps = createRecoveryDeps({
      getInstance: () => instance,
      createAdapter,
      setAdapter: vi.fn(),
      setupAdapterEvents: vi.fn(),
      nativeResumeTimeoutMs: 15_000,
    });

    const result = await deps.nativeResume('inst-1', 'psess-abc');

    expect(createAdapter).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ sessionId: 'psess-abc', resume: true }),
      'local',
    );
    expect(spawn).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('returns failure when spawn rejects', async () => {
    const instance = {
      id: 'inst-1',
      providerSessionId: 'psess-abc',
      provider: 'claude',
      workingDirectory: '/tmp',
      yoloMode: false,
      currentModel: 'claude-sonnet-4-6',
      executionLocation: 'local',
    };
    const spawn = vi.fn().mockRejectedValue(new Error('no such session'));
    const createAdapter = vi.fn().mockReturnValue({ spawn, terminate: vi.fn() });

    const deps = createRecoveryDeps({
      getInstance: () => instance,
      createAdapter,
      setAdapter: vi.fn(),
      setupAdapterEvents: vi.fn(),
      nativeResumeTimeoutMs: 15_000,
    });

    const result = await deps.nativeResume('inst-1', 'psess-abc');
    expect(result.success).toBe(false);
    expect(result.error).toContain('no such session');
  });

  it('returns failure when spawn exceeds timeout', async () => {
    const instance = {
      id: 'inst-1', providerSessionId: 'psess-abc', provider: 'claude',
      workingDirectory: '/tmp', yoloMode: false, currentModel: 'x', executionLocation: 'local',
    };
    const spawn = vi.fn().mockImplementation(() => new Promise(() => { /* never */ }));
    const createAdapter = vi.fn().mockReturnValue({ spawn, terminate: vi.fn() });

    const deps = createRecoveryDeps({
      getInstance: () => instance,
      createAdapter,
      setAdapter: vi.fn(),
      setupAdapterEvents: vi.fn(),
      nativeResumeTimeoutMs: 50,
    });

    const result = await deps.nativeResume('inst-1', 'psess-abc');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/timed out|timeout/i);
  });
});

describe('replayFallback', () => {
  it('mints a new providerSessionId, spawns fresh adapter, sends fallback history as first turn', async () => {
    const instance = {
      id: 'inst-1',
      providerSessionId: 'old-psess',
      provider: 'claude',
      currentModel: 'claude-sonnet-4-6',
      workingDirectory: '/tmp',
      yoloMode: false,
      executionLocation: 'local',
      outputBuffer: [
        { id: 'm1', type: 'user', content: 'Hello', timestamp: 1 },
        { id: 'm2', type: 'assistant', content: 'Hi', timestamp: 2 },
      ],
    };
    const spawn = vi.fn().mockResolvedValue(5678);
    const sendInput = vi.fn().mockResolvedValue(undefined);
    const adapter = { spawn, terminate: vi.fn(), sendInput };
    const createAdapter = vi.fn().mockReturnValue(adapter);
    const buildHistory = vi.fn().mockReturnValue('[RECOVERY CONTEXT]\n...');

    const deps = createRecoveryDeps({
      getInstance: () => instance,
      createAdapter,
      setAdapter: vi.fn(),
      setupAdapterEvents: vi.fn(),
      generateId: () => 'new-psess',
      buildFallbackHistoryMessage: buildHistory,
      nativeResumeTimeoutMs: 15_000,
      replayFallbackTimeoutMs: 20_000,
    });

    const result = await deps.replayFallback('inst-1', 'old-psess');

    expect(instance.providerSessionId).toBe('new-psess');
    expect(createAdapter).toHaveBeenCalledWith(
      'claude',
      expect.objectContaining({ sessionId: 'new-psess', resume: false }),
      'local',
    );
    expect(spawn).toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledWith('[RECOVERY CONTEXT]\n...');
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/recovery-deps.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `recovery-deps.ts`**

Create `src/main/instance/lifecycle/recovery-deps.ts`:

```ts
import type { Instance } from '../../../shared/types/instance.types';
import type { RecoveryDeps, RecoveryResult } from './session-recovery';
import { generateId as defaultGenerateId } from '../../../shared/utils/id-generator';
import { buildFallbackHistoryMessage as defaultBuildFallbackHistoryMessage } from '../../session/fallback-history';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RecoveryDeps');

export interface RecoveryDepsConfig {
  getInstance: (id: string) => Instance | undefined;
  createAdapter: (provider: string, spawnOptions: unknown, executionLocation: string) => {
    spawn: () => Promise<number>;
    terminate: (force?: boolean) => Promise<void>;
    sendInput: (text: string) => Promise<void>;
  };
  setAdapter: (id: string, adapter: unknown) => void;
  setupAdapterEvents: (id: string, adapter: unknown) => void;
  generateId?: () => string;
  buildFallbackHistoryMessage?: typeof defaultBuildFallbackHistoryMessage;
  nativeResumeTimeoutMs?: number;
  replayFallbackTimeoutMs?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
           (e) => { clearTimeout(timer); reject(e); });
  });
}

export function createRecoveryDeps(cfg: RecoveryDepsConfig): RecoveryDeps {
  const generateId = cfg.generateId ?? defaultGenerateId;
  const buildFallback = cfg.buildFallbackHistoryMessage ?? defaultBuildFallbackHistoryMessage;
  const nativeTimeout = cfg.nativeResumeTimeoutMs ?? 15_000;
  const replayTimeout = cfg.replayFallbackTimeoutMs ?? 20_000;

  return {
    nativeResume: async (instanceId, sessionId): Promise<RecoveryResult> => {
      const instance = cfg.getInstance(instanceId);
      if (!instance) return { success: false, error: `instance ${instanceId} missing` };

      try {
        const adapter = cfg.createAdapter(
          instance.provider,
          {
            sessionId,
            resume: true,
            workingDirectory: instance.workingDirectory,
            yoloMode: instance.yoloMode,
            model: instance.currentModel,
          },
          instance.executionLocation,
        );
        cfg.setupAdapterEvents(instanceId, adapter);
        cfg.setAdapter(instanceId, adapter);

        await withTimeout(adapter.spawn(), nativeTimeout, 'nativeResume.spawn');
        return { success: true };
      } catch (err) {
        logger.warn('nativeResume failed', { instanceId, error: (err as Error).message });
        return { success: false, error: (err as Error).message };
      }
    },

    replayFallback: async (instanceId, _sessionId): Promise<RecoveryResult> => {
      const instance = cfg.getInstance(instanceId);
      if (!instance) return { success: false, error: `instance ${instanceId} missing` };

      const newProviderSessionId = generateId();
      instance.providerSessionId = newProviderSessionId;
      instance.sessionId = newProviderSessionId; // keep legacy alias consistent

      try {
        const adapter = cfg.createAdapter(
          instance.provider,
          {
            sessionId: newProviderSessionId,
            resume: false,
            workingDirectory: instance.workingDirectory,
            yoloMode: instance.yoloMode,
            model: instance.currentModel,
          },
          instance.executionLocation,
        );
        cfg.setupAdapterEvents(instanceId, adapter);
        cfg.setAdapter(instanceId, adapter);

        await withTimeout(adapter.spawn(), replayTimeout, 'replayFallback.spawn');

        const contextWindow = 200_000; // TODO(follow-up): plumb from getProviderModelContextWindow
        const history = buildFallback(
          instance.outputBuffer,
          'Original session could not be resumed',
          contextWindow,
        );
        if (history) {
          await adapter.sendInput(history);
        }

        return { success: true };
      } catch (err) {
        logger.warn('replayFallback failed', { instanceId, error: (err as Error).message });
        return { success: false, error: (err as Error).message };
      }
    },
  };
}
```

Note on the `TODO(follow-up)` for context window: resolve in Step 7 by importing `getProviderModelContextWindow` from the existing utility (grep `getProviderModelContextWindow` — it's used in `instance-lifecycle.ts:1762`). Don't leave the `TODO` in the final commit.

- [ ] **Step 4: Resolve the context-window TODO immediately**

Replace the `contextWindow = 200_000` line with:

```ts
import { getProviderModelContextWindow } from '../../../shared/utils/provider-context';
// ... and in replayFallback:
const contextWindow = getProviderModelContextWindow(instance.provider, instance.currentModel);
```

If the import path differs, find it with `Grep "export function getProviderModelContextWindow"`. Use whatever path that returns.

- [ ] **Step 5: Run to verify tests pass**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/recovery-deps.spec.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/lifecycle/recovery-deps.ts \
  src/main/instance/lifecycle/__tests__/recovery-deps.spec.ts
git commit -m "feat(instance): implement production nativeResume and replayFallback recovery deps"
```

---

## Task 6: Transcript-window helper (MVP sentinel boundary)

**Files:**
- Create: `src/main/instance/lifecycle/transcript-window.ts`
- Create: `src/main/instance/lifecycle/__tests__/transcript-window.spec.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/instance/lifecycle/__tests__/transcript-window.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getActiveMessages } from '../transcript-window';
import type { OutputMessage } from '../../../../shared/types/instance.types';

function msg(id: string, type: OutputMessage['type'] = 'user'): OutputMessage {
  return { id, timestamp: 0, type, content: id };
}

describe('getActiveMessages', () => {
  it('returns all messages when no archive boundary is set', () => {
    const messages = [msg('a'), msg('b'), msg('c')];
    expect(getActiveMessages({ outputBuffer: messages })).toEqual(messages);
  });

  it('returns only messages after the archived boundary', () => {
    const messages = [msg('a'), msg('b'), msg('boundary', 'system'), msg('c'), msg('d')];
    const result = getActiveMessages({
      outputBuffer: messages,
      archivedUpToMessageId: 'boundary',
    });
    expect(result.map((m) => m.id)).toEqual(['c', 'd']);
  });

  it('returns empty array when boundary is the last message', () => {
    const messages = [msg('a'), msg('boundary', 'system')];
    const result = getActiveMessages({
      outputBuffer: messages,
      archivedUpToMessageId: 'boundary',
    });
    expect(result).toEqual([]);
  });

  it('falls back to all messages when boundary ID is not found', () => {
    const messages = [msg('a'), msg('b')];
    const result = getActiveMessages({
      outputBuffer: messages,
      archivedUpToMessageId: 'nonexistent',
    });
    expect(result).toEqual(messages);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/transcript-window.spec.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

Create `src/main/instance/lifecycle/transcript-window.ts`:

```ts
import type { OutputMessage } from '../../../shared/types/instance.types';

export interface TranscriptWindowInput {
  outputBuffer: OutputMessage[];
  archivedUpToMessageId?: string;
}

export function getActiveMessages(input: TranscriptWindowInput): OutputMessage[] {
  if (!input.archivedUpToMessageId) return input.outputBuffer;

  const boundaryIndex = input.outputBuffer.findIndex(
    (m) => m.id === input.archivedUpToMessageId,
  );
  if (boundaryIndex === -1) return input.outputBuffer;

  return input.outputBuffer.slice(boundaryIndex + 1);
}
```

- [ ] **Step 4: Run to verify tests pass**

Run: `npx vitest run src/main/instance/lifecycle/__tests__/transcript-window.spec.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/lifecycle/transcript-window.ts \
  src/main/instance/lifecycle/__tests__/transcript-window.spec.ts
git commit -m "feat(instance): add getActiveMessages helper for archived-boundary filtering"
```

---

## Task 7: Wire transcript-window into context-construction

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` around line 494 (existing `buildFallbackHistoryMessage` call) and other sites that consume `instance.outputBuffer` to form CLI input.

- [ ] **Step 1: Find every read of `instance.outputBuffer` used for prompt construction**

Run: `Grep "instance\.outputBuffer" src/main/` — enumerate hits. For each, classify:
- **Prompt construction path** (must respect `archivedUpToMessageId`) — use `getActiveMessages(instance)`.
- **UI / archive / logging path** (should see all messages including archived) — leave unchanged.

Write findings into a scratch `notes/transcript-window-audit.md` (or just a scrollback note). There should be 2–5 prompt-construction sites.

- [ ] **Step 2: Write failing integration test**

Append to `src/main/instance/__tests__/instance-creation.spec.ts` (or create a new file `src/main/instance/__tests__/restart-context-boundary.spec.ts`):

```ts
import { describe, it, expect, vi } from 'vitest';
import { buildFallbackHistoryMessage } from '../../session/fallback-history';

// Stub / import the function under test that composes the CLI first-turn prompt
// from instance.outputBuffer. Replace `composePromptFromInstance` with its real name.
import { composePromptFromInstance } from '../instance-lifecycle-helpers'; // ADJUST path as needed

describe('prompt construction respects archivedUpToMessageId', () => {
  it('excludes messages at or before the boundary', () => {
    const instance = {
      outputBuffer: [
        { id: 'old-1', type: 'user', content: 'archived', timestamp: 1 },
        { id: 'boundary', type: 'system', content: '— previous session archived —', timestamp: 2 },
        { id: 'new-1', type: 'user', content: 'fresh', timestamp: 3 },
      ],
      archivedUpToMessageId: 'boundary',
      provider: 'claude',
      currentModel: 'claude-sonnet-4-6',
    };

    const prompt = composePromptFromInstance(instance);
    expect(prompt).not.toContain('archived');
    expect(prompt).toContain('fresh');
  });
});
```

If prompt-construction is spread across multiple functions, pick the one you identified as the primary CLI-input path in Step 1 and test that one. Write one such test per prompt-construction site.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/main/instance/__tests__/restart-context-boundary.spec.ts`
Expected: FAIL — archived content leaks into prompt.

- [ ] **Step 4: Patch each prompt-construction site**

At each site identified in Step 1:

```ts
// Before:
const messages = instance.outputBuffer;

// After:
import { getActiveMessages } from './lifecycle/transcript-window';
const messages = getActiveMessages(instance);
```

For the site at `instance-lifecycle.ts:494`:

```ts
// Before:
const fallback = buildFallbackHistoryMessage(deduped, reason, contextWindow);

// After:
const activeMessages = getActiveMessages(instance);
const dedupedActive = deduplicate(activeMessages); // reuse existing dedupe logic
const fallback = buildFallbackHistoryMessage(dedupedActive, reason, contextWindow);
```

- [ ] **Step 5: Run to verify tests pass**

Run: `npx vitest run src/main/instance/__tests__/restart-context-boundary.spec.ts`
Expected: PASS.

- [ ] **Step 6: Full test sweep**

Run: `npx vitest run src/main/instance/`
Expected: PASS. If pre-existing tests depended on `outputBuffer` being read whole in prompt construction, update them to include `archivedUpToMessageId: undefined` or confirm they already work (no boundary = all messages).

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/lifecycle/transcript-window.ts src/main/instance/instance-lifecycle.ts \
  src/main/instance/__tests__/restart-context-boundary.spec.ts
git commit -m "feat(instance): prompt construction respects archivedUpToMessageId boundary"
```

---

## Task 8: Refactor `restartInstance` to route through `SessionRecoveryHandler`

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` (the `restartInstance` method around line 1732)

- [ ] **Step 1: Write failing test — successful native resume preserves identity**

Create (or append to) `src/main/instance/__tests__/restart-resume.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
// Import your instance lifecycle fixture — follow existing test patterns

describe('restartInstance (resume context)', () => {
  beforeEach(() => { /* _resetForTesting on relevant singletons */ });

  it('preserves providerSessionId, historyThreadId, and outputBuffer on native resume success', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([
      { id: 'm1', type: 'user', content: 'hi', timestamp: 1 },
    ]);
    const originalProviderSession = instance.providerSessionId;
    const originalThread = instance.historyThreadId;

    // Force native resume to succeed by stubbing the recovery deps
    stubRecoveryDeps({ nativeResume: async () => ({ success: true }) });

    await lifecycle.restartInstance(instance.id);

    expect(instance.providerSessionId).toBe(originalProviderSession);
    expect(instance.historyThreadId).toBe(originalThread);
    expect(instance.outputBuffer).toHaveLength(1);
    expect(instance.recoveryMethod).toBe('native');
  });

  it('mints new providerSessionId on replay fallback, preserves historyThreadId and outputBuffer', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([
      { id: 'm1', type: 'user', content: 'hi', timestamp: 1 },
    ]);
    const originalProviderSession = instance.providerSessionId;
    const originalThread = instance.historyThreadId;

    stubRecoveryDeps({
      nativeResume: async () => ({ success: false, error: 'not resumable' }),
      replayFallback: async () => {
        instance.providerSessionId = 'new-psess-minted-by-replay';
        return { success: true };
      },
    });

    await lifecycle.restartInstance(instance.id);

    expect(instance.providerSessionId).toBe('new-psess-minted-by-replay');
    expect(instance.historyThreadId).toBe(originalThread);
    expect(instance.outputBuffer).toHaveLength(1);
    expect(instance.recoveryMethod).toBe('replay');
  });

  it('transitions to error state without mutating identity when both recovery methods fail', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([
      { id: 'm1', type: 'user', content: 'hi', timestamp: 1 },
    ]);
    const originalProviderSession = instance.providerSessionId;

    stubRecoveryDeps({
      nativeResume: async () => ({ success: false, error: 'nope' }),
      replayFallback: async () => ({ success: false, error: 'nope either' }),
    });

    await lifecycle.restartInstance(instance.id);

    expect(instance.status).toBe('error');
    expect(instance.recoveryMethod).toBe('failed');
    expect(instance.providerSessionId).toBe(originalProviderSession); // unchanged
    expect(instance.outputBuffer).toHaveLength(1); // preserved
  });

  it('increments restartEpoch before terminating old adapter', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([]);
    const originalEpoch = instance.restartEpoch;

    stubRecoveryDeps({ nativeResume: async () => ({ success: true }) });

    await lifecycle.restartInstance(instance.id);

    expect(instance.restartEpoch).toBe(originalEpoch + 1);
  });
});
```

Fixture helpers (`setupInstanceWithTranscript`, `stubRecoveryDeps`) need to be created alongside. Follow the patterns in existing lifecycle specs (look at `src/main/instance/__tests__/` and `src/main/instance/lifecycle/__tests__/`). Keep them in a sibling `restart-test-fixtures.ts`.

- [ ] **Step 2: Run to verify tests fail**

Run: `npx vitest run src/main/instance/__tests__/restart-resume.spec.ts`
Expected: FAIL on all four tests — current `restartInstance` clears `outputBuffer`, regenerates `sessionId`, doesn't set `recoveryMethod`, doesn't bump `restartEpoch`.

- [ ] **Step 3: Refactor `restartInstance`**

Replace the body of `restartInstance` in `src/main/instance/instance-lifecycle.ts:1732`:

```ts
async restartInstance(instanceId: string): Promise<void> {
  const instance = this.deps.getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  // Race protection: bump epoch BEFORE terminating so any straggler events from
  // the old adapter are dropped by the epoch-wrapped event handlers.
  instance.restartEpoch += 1;

  // Reject any pending interactive state (approvals, input-required prompts, etc.)
  // with a RestartCancelled error before killing the process.
  this.deps.clearPendingState(instanceId);

  this.deps.stopStuckTracking?.(instanceId);

  const oldAdapter = this.deps.getAdapter(instanceId);
  if (oldAdapter) {
    try {
      await withTimeout(oldAdapter.terminate(true), 5_000, 'adapter.terminate');
    } catch (error) {
      logger.warn('Adapter terminate failed or timed out during restart, proceeding', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  this.deps.deleteDiffTracker?.(instanceId);
  if (this.deps.setDiffTracker) {
    this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
  }

  // Route through the recovery handler. Deps were wired at construction time (see
  // InstanceLifecycle constructor — Task 9 adds the wiring there).
  const handler = this.deps.getSessionRecoveryHandler();
  this.transitionState(instance, 'initializing');
  instance.restartCount += 1;

  const result = await handler.recover(instanceId, instance.providerSessionId);

  if (result.success) {
    instance.recoveryMethod = result.method === 'native-resume' ? 'native' : 'replay';
    // Counters: preserve on native; reset backend-session counters on replay.
    if (result.method === 'replay-fallback') {
      instance.contextUsage = {
        used: 0,
        total: getProviderModelContextWindow(instance.provider, instance.currentModel),
        percentage: 0,
      };
      instance.diffStats = undefined;
    }
    this.transitionState(instance, 'idle');
    this.deps.startStuckTracking?.(instanceId);
  } else {
    instance.recoveryMethod = 'failed';
    this.transitionState(instance, 'error');
    logger.warn('Restart (resume context) failed; leaving instance in error state', {
      instanceId, error: result.error,
    });
    // Do NOT mutate providerSessionId, historyThreadId, outputBuffer, or
    // firstMessageTracking. User must explicitly Restart (fresh context).
  }

  this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
}
```

Add a small `withTimeout` helper at the top of the file if not already present:

```ts
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
           (e) => { clearTimeout(timer); reject(e); });
  });
}
```

Note: this refactor removes the old `generateId()` call and `outputBuffer = []` clear. The `firstMessageTracking` reset is also removed for the resume path — it only resets on Fresh (Task 9).

- [ ] **Step 4: Add `getSessionRecoveryHandler` to `InstanceLifecycleDeps`**

In `src/main/instance/instance-lifecycle.ts`, find the `Deps` interface (search `interface InstanceLifecycleDeps` or similar). Add:

```ts
interface InstanceLifecycleDeps {
  // ... existing deps ...
  getSessionRecoveryHandler: () => SessionRecoveryHandler;
}
```

Don't worry about wiring it yet — that's Task 9. The test fixture will supply a stub.

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/main/instance/__tests__/restart-resume.spec.ts`
Expected: PASS (4/4).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS. Existing call sites that construct `InstanceLifecycle` will now fail typecheck — fix by adding `getSessionRecoveryHandler: () => ...` to each; for now, stub with `() => new SessionRecoveryHandler({ nativeResume: async () => ({ success: false }), replayFallback: async () => ({ success: false }) })`. Task 9 replaces the stub with real deps.

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts \
  src/main/instance/__tests__/restart-resume.spec.ts \
  $(git diff --name-only | grep -E 'instance-lifecycle|__tests__')
git commit -m "feat(instance): route restart through SessionRecoveryHandler, preserve transcript"
```

---

## Task 9: Wire production recovery deps into `InstanceLifecycle`

**Files:**
- Modify: whichever file constructs `InstanceLifecycle` (find via `Grep "new InstanceLifecycle"`).

- [ ] **Step 1: Find the construction site**

Run: `Grep "new InstanceLifecycle" src/main/`
Typical location: `src/main/instance/instance-manager.ts`.

- [ ] **Step 2: Wire the deps**

At the construction site, replace the stub `getSessionRecoveryHandler` with:

```ts
import { SessionRecoveryHandler } from './lifecycle/session-recovery';
import { createRecoveryDeps } from './lifecycle/recovery-deps';

// inside the manager's constructor or factory, where `this.lifecycle = new InstanceLifecycle(...)` happens:
const recoveryDeps = createRecoveryDeps({
  getInstance: (id) => this.getInstance(id),
  createAdapter: (provider, opts, loc) => createCliAdapter(provider, opts, loc),
  setAdapter: (id, a) => this.adapters.set(id, a),
  setupAdapterEvents: (id, a) => this.setupAdapterEvents(id, a),
});
const recoveryHandler = new SessionRecoveryHandler(recoveryDeps);

this.lifecycle = new InstanceLifecycle({
  // ... existing deps ...
  getSessionRecoveryHandler: () => recoveryHandler,
});
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the full instance test suite**

Run: `npx vitest run src/main/instance/`
Expected: PASS. Any test that previously used a stub handler still works — production wiring doesn't change behavior for tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/instance-manager.ts
git commit -m "feat(instance): wire production recovery deps into InstanceLifecycle"
```

---

## Task 10: Implement `restartFreshInstance`

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts` (new method)
- Modify: `src/main/instance/instance-manager.ts` (new delegator)

- [ ] **Step 1: Write failing test**

Create `src/main/instance/__tests__/restart-fresh.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
// Import / set up fixtures

describe('restartFreshInstance', () => {
  it('archives the old transcript via archiveInstance', async () => {
    const archive = vi.fn().mockResolvedValue(undefined);
    const { lifecycle, instance } = await setupInstanceWithTranscript([
      { id: 'm1', type: 'user', content: 'hi', timestamp: 1 },
    ], { archive });

    await lifecycle.restartFreshInstance(instance.id);

    expect(archive).toHaveBeenCalledWith(instance, 'restarted-fresh');
  });

  it('appends a session-boundary sentinel and sets archivedUpToMessageId', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([
      { id: 'm1', type: 'user', content: 'hi', timestamp: 1 },
    ]);

    await lifecycle.restartFreshInstance(instance.id);

    const last = instance.outputBuffer[instance.outputBuffer.length - 1];
    expect(last.type).toBe('system');
    expect(last.metadata).toMatchObject({ kind: 'session-boundary', archived: true });
    expect(instance.archivedUpToMessageId).toBe(last.id);
    expect(instance.outputBuffer.find((m) => m.id === 'm1')).toBeDefined();
  });

  it('mints new providerSessionId and historyThreadId', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([]);
    const oldProv = instance.providerSessionId;
    const oldThread = instance.historyThreadId;

    await lifecycle.restartFreshInstance(instance.id);

    expect(instance.providerSessionId).not.toBe(oldProv);
    expect(instance.historyThreadId).not.toBe(oldThread);
    expect(instance.recoveryMethod).toBe('fresh');
  });

  it('resets counters', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([]);
    instance.contextUsage = { used: 500, total: 200_000, percentage: 0.25 };
    instance.totalTokensUsed = 5_000;
    instance.diffStats = { added: 10, removed: 3, files: 2 } as unknown as typeof instance.diffStats;

    await lifecycle.restartFreshInstance(instance.id);

    expect(instance.contextUsage.used).toBe(0);
    expect(instance.totalTokensUsed).toBe(0);
    expect(instance.diffStats).toBeUndefined();
  });

  it('bumps restartEpoch and increments restartCount', async () => {
    const { lifecycle, instance } = await setupInstanceWithTranscript([]);
    const oldEpoch = instance.restartEpoch;
    const oldCount = instance.restartCount;

    await lifecycle.restartFreshInstance(instance.id);

    expect(instance.restartEpoch).toBe(oldEpoch + 1);
    expect(instance.restartCount).toBe(oldCount + 1);
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

Run: `npx vitest run src/main/instance/__tests__/restart-fresh.spec.ts`
Expected: FAIL — method doesn't exist.

- [ ] **Step 3: Implement `restartFreshInstance`**

In `src/main/instance/instance-lifecycle.ts`, below `restartInstance`, add:

```ts
/**
 * Explicit "Restart (fresh context)". Archives the old transcript, mints new
 * identities, appends a session-boundary sentinel (MVP — V2 uses TranscriptSegment[]),
 * and spawns a fresh adapter.
 */
async restartFreshInstance(instanceId: string): Promise<void> {
  const instance = this.deps.getInstance(instanceId);
  if (!instance) throw new Error(`Instance ${instanceId} not found`);

  const cliType = await this.resolveCliTypeForInstance(instance);

  instance.restartEpoch += 1;
  this.deps.clearPendingState(instanceId);
  this.deps.stopStuckTracking?.(instanceId);

  const oldAdapter = this.deps.getAdapter(instanceId);
  if (oldAdapter) {
    try {
      await withTimeout(oldAdapter.terminate(true), 5_000, 'adapter.terminate');
    } catch (err) {
      logger.warn('Adapter terminate failed during fresh restart, proceeding', {
        instanceId, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Archive BEFORE minting new identity — archive should key off the old thread.
  try {
    await this.deps.archiveInstance(instance, 'restarted-fresh');
  } catch (err) {
    logger.warn('archiveInstance failed on fresh restart; proceeding anyway', {
      instanceId, error: err instanceof Error ? err.message : String(err),
    });
  }

  // Append session-boundary sentinel to visible transcript (MVP).
  const boundaryId = generateId();
  instance.outputBuffer.push({
    id: boundaryId,
    timestamp: Date.now(),
    type: 'system',
    content: '— Previous session archived — new session starts below —',
    metadata: { kind: 'session-boundary', archived: true },
  });
  instance.archivedUpToMessageId = boundaryId;

  // Mint new identities.
  const newSessionId = generateId();
  instance.providerSessionId = newSessionId;
  instance.sessionId = newSessionId;
  instance.historyThreadId = generateId();

  // Reset counters.
  instance.contextUsage = {
    used: 0,
    total: getProviderModelContextWindow(cliType, instance.currentModel),
    percentage: 0,
  };
  instance.diffStats = undefined;
  instance.totalTokensUsed = 0;
  this.deps.clearFirstMessageTracking(instanceId);

  // Spawn fresh adapter.
  const spawnOptions: UnifiedSpawnOptions = {
    sessionId: newSessionId,
    workingDirectory: instance.workingDirectory,
    yoloMode: instance.yoloMode,
    model: instance.currentModel,
    mcpConfig: this.getMcpConfig(instance.executionLocation),
    permissionHookPath: this.getPermissionHookPath(instance.yoloMode),
  };
  const adapter = createCliAdapter(cliType, spawnOptions, instance.executionLocation);
  this.deps.setupAdapterEvents(instanceId, adapter);
  this.deps.setAdapter(instanceId, adapter);
  this.deps.deleteDiffTracker?.(instanceId);
  if (this.deps.setDiffTracker) {
    this.deps.setDiffTracker(instanceId, new SessionDiffTracker(instance.workingDirectory));
  }

  this.transitionState(instance, 'initializing');
  instance.restartCount += 1;

  try {
    const pid = await adapter.spawn();
    instance.processId = pid;
    instance.recoveryMethod = 'fresh';
    this.transitionState(instance, 'idle');
    this.deps.startStuckTracking?.(instanceId);
  } catch (err) {
    instance.recoveryMethod = 'failed';
    this.transitionState(instance, 'error');
    logger.error('Fresh restart failed to spawn adapter', err instanceof Error ? err : undefined, { instanceId });
  }

  this.deps.queueUpdate(instanceId, instance.status, instance.contextUsage);
}
```

Add `archiveInstance` to the `InstanceLifecycleDeps` interface:

```ts
interface InstanceLifecycleDeps {
  // ...
  archiveInstance: (instance: Instance, reason: string) => Promise<void>;
}
```

- [ ] **Step 4: Wire `archiveInstance` dep in the manager**

In `src/main/instance/instance-manager.ts`, at the `new InstanceLifecycle({...})` site, add:

```ts
archiveInstance: (instance, reason) => getHistoryManager().archiveInstance(instance, reason),
```

(Use the existing import path for `getHistoryManager` — check `src/main/history/` for the getter convention.)

- [ ] **Step 5: Add `restartFreshInstance` delegator on `InstanceManager`**

In `src/main/instance/instance-manager.ts`, alongside `restartInstance`:

```ts
async restartFreshInstance(instanceId: string): Promise<void> {
  return this.lifecycle.restartFreshInstance(instanceId);
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/main/instance/__tests__/restart-fresh.spec.ts`
Expected: PASS (5/5).

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts src/main/instance/instance-manager.ts \
  src/main/instance/__tests__/restart-fresh.spec.ts
git commit -m "feat(instance): implement restartFreshInstance with archive + sentinel boundary"
```

---

## Task 11: IPC contract for fresh restart

**Files:**
- Modify: `packages/contracts/src/channels/instance.channels.ts`
- Modify: `packages/contracts/src/schemas/instance.schemas.ts`
- Modify: `src/main/ipc/handlers/instance-handlers.ts`
- Modify: `src/preload/domains/instance.preload.ts`

- [ ] **Step 1: Write failing test for the IPC handler**

Append to `src/main/ipc/handlers/__tests__/instance-handlers.spec.ts`:

```ts
describe('INSTANCE_RESTART_FRESH', () => {
  it('delegates to instanceManager.restartFreshInstance and returns success', async () => {
    vi.mocked(mockInstanceManager.restartFreshInstance).mockResolvedValue(undefined);

    const response = await invoke('instance:restart-fresh', { instanceId: 'inst-7' });

    expect(response.success).toBe(true);
    expect(mockInstanceManager.restartFreshInstance).toHaveBeenCalledWith('inst-7');
  });

  it('returns RESTART_FAILED error code when the delegator throws', async () => {
    vi.mocked(mockInstanceManager.restartFreshInstance).mockRejectedValue(new Error('boom'));

    const response = await invoke('instance:restart-fresh', { instanceId: 'inst-7' });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('RESTART_FAILED');
  });
});
```

Ensure the mock `instanceManager` has `restartFreshInstance: vi.fn()` added alongside `restartInstance` in the test setup (around line 111 of the file).

- [ ] **Step 2: Run to verify tests fail**

Run: `npx vitest run src/main/ipc/handlers/__tests__/instance-handlers.spec.ts -t INSTANCE_RESTART_FRESH`
Expected: FAIL — channel and handler don't exist.

- [ ] **Step 3: Add the channel**

In `packages/contracts/src/channels/instance.channels.ts`, add inside `INSTANCE_CHANNELS`:

```ts
INSTANCE_RESTART_FRESH: 'instance:restart-fresh',
```

- [ ] **Step 4: Add the payload schema**

In `packages/contracts/src/schemas/instance.schemas.ts`, after `InstanceRestartPayloadSchema`:

```ts
export const InstanceRestartFreshPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});
export type InstanceRestartFreshPayload = z.infer<typeof InstanceRestartFreshPayloadSchema>;
```

- [ ] **Step 5: Add the IPC handler**

In `src/main/ipc/handlers/instance-handlers.ts`, after the existing `INSTANCE_RESTART` handler (line 297-319):

```ts
ipcMain.handle(
  IPC_CHANNELS.INSTANCE_RESTART_FRESH,
  async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
    try {
      const validated = validateIpcPayload(
        InstanceRestartFreshPayloadSchema,
        payload,
        'INSTANCE_RESTART_FRESH',
      );
      await instanceManager.restartFreshInstance(validated.instanceId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'RESTART_FAILED',
          message: (error as Error).message,
          timestamp: Date.now(),
        },
      };
    }
  },
);
```

Update imports at top of file to include `InstanceRestartFreshPayloadSchema`.

- [ ] **Step 6: Expose via preload**

In `src/preload/domains/instance.preload.ts`, add alongside `restartInstance` (currently at line 81):

```ts
restartFreshInstance: (instanceId: string): Promise<IpcResponse> =>
  ipcRenderer.invoke(IPC_CHANNELS.INSTANCE_RESTART_FRESH, { instanceId }),
```

Also update the type declaration (usually in `src/shared/types/electron-api.types.ts` or similar — find via `Grep "restartInstance:" src/shared`).

- [ ] **Step 7: Run tests**

Run: `npx vitest run src/main/ipc/handlers/__tests__/instance-handlers.spec.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/channels/instance.channels.ts \
  packages/contracts/src/schemas/instance.schemas.ts \
  src/main/ipc/handlers/instance-handlers.ts \
  src/preload/domains/instance.preload.ts \
  src/shared/types/electron-api.types.ts \
  src/main/ipc/handlers/__tests__/instance-handlers.spec.ts
git commit -m "feat(ipc): add instance:restart-fresh channel + handler"
```

---

## Task 12: Renderer — split-button UI

**Files:**
- Modify: `src/renderer/app/features/instance-row.component.ts` (around line 732 — current `restart.emit(instanceId)`)
- Modify: `src/renderer/app/features/instance-row.component.html`
- Modify: `src/renderer/app/features/instance-row.component.scss`
- Modify: parent container that listens for `restart` event and calls the IPC — add `restartFresh`
- Modify: renderer store/service that wraps `electronAPI.restartInstance` — add `restartFreshInstance`

- [ ] **Step 1: Find the renderer chain**

Run: `Grep "restart.emit" src/renderer` — find the emitter.
Run: `Grep "@Output.*restart" src/renderer` — find the output decorator.
Run: `Grep "restartInstance" src/renderer` — find the IPC call site in renderer stores.

Record the parent component and store for Step 4.

- [ ] **Step 2: Add the `restartFresh` output + handler methods**

In `src/renderer/app/features/instance-row.component.ts`:

```ts
@Output() restart = new EventEmitter<string>();
@Output() restartFresh = new EventEmitter<string>();

onRestartResume(): void {
  this.restart.emit(this.instanceId);
}

onRestartFresh(): void {
  this.restartFresh.emit(this.instanceId);
}
```

Replace any existing direct `restart.emit(instanceId)` button binding with `onRestartResume()`.

- [ ] **Step 3: Update the template**

In `src/renderer/app/features/instance-row.component.html`, replace the current restart button with a split button. Match existing button-group styling in the file. A minimal sketch:

```html
<div class="restart-split">
  <button type="button" class="btn-restart" (click)="onRestartResume()" title="Restart and resume conversation">
    <icon name="restart" />
    <span>Restart</span>
  </button>
  <button type="button" class="btn-restart-chevron" (click)="toggleRestartMenu()"
          [attr.aria-expanded]="restartMenuOpen()" aria-label="Restart options">
    <icon name="chevron-down" />
  </button>
  @if (restartMenuOpen()) {
    <div class="restart-menu" role="menu">
      <button role="menuitem" (click)="onRestartResume(); closeRestartMenu()">
        Restart (resume context)
        <small>Keep conversation, replace CLI</small>
      </button>
      <button role="menuitem" (click)="onRestartFresh(); closeRestartMenu()">
        Restart (fresh context)
        <small>Archive conversation, start clean</small>
      </button>
    </div>
  }
</div>
```

Add the signal-based menu state to the component class:

```ts
restartMenuOpen = signal(false);
toggleRestartMenu(): void { this.restartMenuOpen.update((v) => !v); }
closeRestartMenu(): void { this.restartMenuOpen.set(false); }
```

Follow the existing template style (native control flow `@if`, signals-first). If `icon` is not the project's actual icon component, substitute the correct one from the existing file.

- [ ] **Step 4: Style the split button**

In `src/renderer/app/features/instance-row.component.scss`, add minimal styling that matches the existing row buttons. Don't re-theme from scratch — reuse existing tokens.

- [ ] **Step 5: Wire the parent container**

Find the parent component that currently binds `(restart)="handleRestart($event)"`. Add `(restartFresh)="handleRestartFresh($event)"` and a corresponding method that calls the store's new `restartFreshInstance` action.

- [ ] **Step 6: Wire the store**

In the store/service (e.g., `instance.store.ts`), add an action that calls `window.electronAPI.restartFreshInstance(instanceId)`. Use the same error-handling pattern as the existing `restartInstance` action.

- [ ] **Step 7: Start the dev server and manually verify (per CLAUDE.md UI verification rule)**

Run: `npm run dev`

In the app:
1. Start a Claude instance, send a few messages.
2. Click the primary Restart button → transcript must still be visible after the adapter respawns.
3. Click the chevron → menu opens showing both options.
4. Pick "Restart (fresh context)" → old messages still visible, followed by a "— Previous session archived —" divider, followed by the fresh active session.

Screenshot each state. Paste into the PR description.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/app/features/instance-row.component.{ts,html,scss} \
  $(git diff --name-only | grep -E 'renderer.*(store|service|parent)')
git commit -m "feat(renderer): split Restart button with resume/fresh options"
```

---

## Task 13: Renderer — recovery failure banner

**Files:**
- Modify: renderer instance-row component (same as Task 12)
- Modify: any existing banner/notification component in `src/renderer/app/features` or `src/renderer/app/shared`

- [ ] **Step 1: Locate existing error UI for an instance**

Run: `Grep "error.*banner|status === 'error'" src/renderer/app/features` — find where the instance error state renders. If no banner exists yet, add one scoped to the instance row.

- [ ] **Step 2: Read `recoveryMethod` from the instance in the template**

Instance objects arrive in the renderer via the existing IPC state-update channel; `recoveryMethod` is already serialized from the main process (no extra plumbing required — it's a plain property on the `Instance` type).

Add a banner shown when `instance.status === 'error' && instance.recoveryMethod === 'failed'`:

```html
@if (instance().status === 'error' && instance().recoveryMethod === 'failed') {
  <div class="recovery-failure-banner" role="alert">
    <strong>Couldn't resume this session.</strong>
    Your transcript is preserved. Start a fresh session to continue.
    <button type="button" (click)="onRestartFresh()">Restart (fresh context)</button>
  </div>
}
```

- [ ] **Step 3: Style**

Match existing banner/alert tokens from `src/renderer/app/shared` if present. Otherwise, minimal inline styling in `instance-row.component.scss`.

- [ ] **Step 4: Manual verification**

Force a recovery failure: in a debug build, temporarily stub both `nativeResume` and `replayFallback` to return `{ success: false }` in `recovery-deps.ts`. Run `npm run dev`, click Restart, confirm the banner appears and the CTA triggers the fresh flow. Revert the stub before committing.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/instance-row.component.{ts,html,scss}
git commit -m "feat(renderer): show recovery-failure banner with fresh-restart CTA"
```

---

## Task 14: Surface `recoveryMethod` as a toast

**Files:**
- Modify: renderer toast/notification service (find via `Grep "toast" src/renderer/app/shared`)
- Modify: renderer store that dispatches the restart action

- [ ] **Step 1: Identify toast mechanism**

If the app has a toast service, use it. If not, add minimal toast UI in the instance row (short-lived text under the row).

- [ ] **Step 2: Emit on successful restart**

After the store's `restartInstance` / `restartFreshInstance` action resolves, read `instance.recoveryMethod` from the updated state and toast:

```ts
const label = {
  native: 'Resumed via native session',
  replay: 'Resumed by replaying transcript',
  fresh: 'Started a fresh session',
}[recoveryMethod] ?? 'Restarted';
toast.show(label);
```

- [ ] **Step 3: Manual verification**

In the dev server, exercise all three paths (native, replay — force via corrupted session ID, fresh) and confirm the toast text matches.

- [ ] **Step 4: Commit**

```bash
git add $(git diff --name-only | grep -E 'renderer.*(toast|store)')
git commit -m "feat(renderer): toast the recovery method on restart"
```

---

## Task 15: Provider capability degrade (UI)

**Files:**
- Create: `src/renderer/app/shared/provider-capabilities.ts`
- Modify: `src/renderer/app/features/instance-row.component.ts`
- Modify: template/scss for the split button

- [ ] **Step 1: Define the capability table**

Create `src/renderer/app/shared/provider-capabilities.ts`:

```ts
export interface ProviderRecoveryCapabilities {
  nativeResume: boolean;
  replayFallback: boolean;
}

export const PROVIDER_RECOVERY_CAPABILITIES: Record<string, ProviderRecoveryCapabilities> = {
  claude: { nativeResume: true, replayFallback: true },
  codex:  { nativeResume: true, replayFallback: true },
  gemini: { nativeResume: false, replayFallback: false }, // pending verification — see spec §9
  copilot:{ nativeResume: false, replayFallback: false }, // pending verification — see spec §9
};

export function canResumeContext(provider: string): boolean {
  const c = PROVIDER_RECOVERY_CAPABILITIES[provider];
  return !!c && (c.nativeResume || c.replayFallback);
}
```

- [ ] **Step 2: Gate the split button**

In `instance-row.component.ts`:

```ts
import { canResumeContext } from '../../shared/provider-capabilities';

readonly canResume = computed(() => canResumeContext(this.instance().provider));
```

In the template, collapse the menu when `canResume()` is false and show only a single "Restart (fresh only)" button with a tooltip explaining why:

```html
@if (canResume()) {
  <!-- split button from Task 12 -->
} @else {
  <button type="button" (click)="onRestartFresh()"
          title="This provider doesn't support session resume — restart starts a fresh session.">
    <icon name="restart" />
    Restart (fresh only)
  </button>
}
```

- [ ] **Step 3: Manual verification**

Dev server: confirm Claude/Codex rows show the split button, Gemini/Copilot rows show the single degraded button.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/shared/provider-capabilities.ts \
  src/renderer/app/features/instance-row.component.{ts,html,scss}
git commit -m "feat(renderer): degrade restart UI to fresh-only for providers without resume support"
```

---

## Task 16: Full verification sweep

- [ ] **Step 1: Typecheck everything**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS with zero errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS. Fix any lint errors introduced.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: PASS. Any pre-existing test that assumed nuclear restart behavior must be updated — check that their new expectations match the spec's behavior (transcript preserved on resume, sentinel boundary on fresh).

- [ ] **Step 4: Manual UI verification — golden paths**

With `npm run dev`:

- **Claude — resume happy path:**
  1. Create an instance. Send 2 messages. Note the `providerSessionId` via devtools.
  2. Restart (resume context).
  3. Verify: toast says "Resumed via native session"; transcript intact; `providerSessionId` unchanged.

- **Claude — replay fallback:**
  1. Create an instance. Send 2 messages.
  2. In devtools, manually overwrite the `.claude` session file to be corrupted (or kill the CLI mid-run).
  3. Restart (resume context).
  4. Verify: toast says "Resumed by replaying transcript"; transcript intact; `providerSessionId` is new; new adapter received a `[RECOVERY CONTEXT]` first turn.

- **Claude — fresh path:**
  1. Create an instance. Send 2 messages.
  2. Click chevron → Restart (fresh context).
  3. Verify: toast says "Started a fresh session"; old messages still visible with a divider; `historyThreadId` and `providerSessionId` are new; new messages go to the fresh session (the CLI has no memory of the old).

- **Failure banner:**
  1. Temporarily stub both recovery deps to fail.
  2. Restart (resume context).
  3. Verify: instance enters error state; banner appears with CTA; clicking CTA triggers Restart (fresh context) and recovers.
  4. Revert the stub.

- **Provider degrade:**
  1. Create a Gemini or Copilot instance.
  2. Verify: Restart button shows only "Restart (fresh only)" with the tooltip.

- **Codex resume:**
  1. Create a Codex instance. Send 2 messages.
  2. Restart (resume context).
  3. Verify: Codex's own resume mechanism fires (toast says "Resumed via native session"); transcript intact.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -u
git commit -m "chore(restart): manual-verification pass fixes"
```

Only commit if Step 4 found issues that required changes.

---

## Spec Coverage Check

| Spec section | Addressed by |
|---|---|
| §1 Two explicit restart actions | Tasks 8, 10, 11, 12 |
| §2 Identity split (`providerSessionId` vs `historyThreadId`) | Tasks 1, 2, 5, 10 |
| §3 Resume flow (cascade, timeouts, failure) | Tasks 5, 8 |
| §3.2 / §4.2 Pending-state cleanup | Task 4 |
| §4 Fresh flow (archive, sentinel, new identity) | Task 10 |
| §5 Restart epoch race protection | Task 3 |
| §6 Transcript segmentation — MVP sentinel | Tasks 6, 7, 10 |
| §7 Replay source (outputBuffer used, audit deferred) | Task 5 |
| §8 Counter accounting (coarse MVP) | Tasks 8, 10 |
| §9 Provider matrix + capability degrade | Task 15 |
| §10 MVP scope | Entire plan |
| UI: split button | Task 12 |
| UI: recovery-failure banner | Task 13 |
| UI: toast recovery method | Task 14 |
| Data model additions | Task 1 |
| IPC channel + schema | Task 11 |

Deferred to V2 (explicit non-goals of this plan): `TranscriptSegment[]` refactor, `backendSession*` / `threadLifetime*` counter split, confirmed resume support for Gemini and Copilot adapters, `outputBuffer` pollution audit (§7).

---

## Post-plan followups to file as tickets

1. **Session mutex on restart paths** — spec §3.1 / §4.1 say to serialize with the session mutex. MVP does not; low-risk under normal UI but worth adding before shipping to power users.
2. **Gemini / Copilot resume verification** — spec §9 leaves these as "pending verification". Pair with each adapter maintainer to implement and test. When verified, update `PROVIDER_RECOVERY_CAPABILITIES` in `src/renderer/app/shared/provider-capabilities.ts` accordingly.
3. **`outputBuffer` pollution audit** — spec §7 flags the risk of UI banners / partial stream content leaking into the replay-fallback prompt. Audit each adapter's write path to `outputBuffer`.
4. **V2: `TranscriptSegment[]` data model** — replaces `archivedUpToMessageId` sentinel. Plan a dedicated spec + plan.
5. **V2: `backendSession*` / `threadLifetime*` counters** — rename and split the counter fields per spec §8 full table.
