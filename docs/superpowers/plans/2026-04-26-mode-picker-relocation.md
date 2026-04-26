# Mode Picker Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project commit policy:** The user's CLAUDE.md says "NEVER commit or push unless the user explicitly asks you to". Each task ends with a `git commit` step that names the message — pause and confirm with the user before running it.

**Goal:** Move the agent-mode picker from the sidebar into the new-session composer toolbar (defaulting to Build), replace the giant gradient "+" with a header-icon button consistent with History/Settings, and plumb `agentId` end-to-end through `createInstanceWithMessage` so the picker actually takes effect (it currently doesn't).

**Architecture:** Bottom-up changes. First make the backend (contract schema → preload type → main IPC handler) accept `agentId`. Then refactor the renderer's store layer to an options-object signature that includes `agentId`. Add `agentId` to `NewSessionDraftService` (per-draft state, default `'build'`, resets on `clearActiveComposer`). Wire the welcome-coordinator to pass it. Finally, restructure the sidebar header (drop the launch row, move "+" to header-actions) and the composer (add a Mode pill rendered by a refactored `AgentSelectorComponent`).

**Tech Stack:** Angular 21 (zoneless, signals, standalone components, OnPush), TypeScript 5.9, Zod 4 contracts, Electron 40 IPC, Vitest.

**Spec:** `docs/superpowers/specs/2026-04-26-mode-picker-relocation-design.md`

---

## File Structure

**Created:** none (no new files; all changes modify existing modules).

**Modified:**

| File | Responsibility |
|---|---|
| `packages/contracts/src/schemas/instance.schemas.ts` | Add `agentId` to `InstanceCreateWithMessagePayloadSchema`. |
| `src/preload/domains/instance.preload.ts` | Add `agentId?` to the IPC payload type. |
| `src/main/ipc/handlers/instance-handlers.ts` | Pass `validated.agentId` through to `instanceManager.createInstance`. |
| `src/shared/validation/ipc-schemas.spec.ts` | New schema test cases for `agentId`. |
| `src/renderer/app/core/services/ipc/instance-ipc.service.ts` | Add `agentId?` to `CreateInstanceWithMessageConfig`. |
| `src/renderer/app/core/state/instance/instance-list.store.ts` | Refactor `createInstanceWithMessage(...)` to options-object signature including `agentId`. |
| `src/renderer/app/core/state/instance/instance.store.ts` | Mirror the options-object signature on the wrapper. |
| `src/renderer/app/core/services/new-session-draft.service.ts` | Add `agentId` to `NewSessionDraftState`, `createEmptyDraft`, `hydrateDraft`, `clearActiveComposer`; new `setAgentId` method and `agentId` computed. |
| `src/renderer/app/core/services/new-session-draft.service.spec.ts` | New tests; update existing `clearActiveComposer` test. |
| `src/renderer/app/features/instance-detail/welcome-coordinator.service.ts` | Read `newSessionDraft.agentId()` and pass via options object. |
| `src/renderer/app/features/dashboard/sidebar-header.component.ts` | Drop `.launch-row` and `<app-agent-selector />`; add "+" as third `.btn-header-icon` with `--primary` modifier. |
| `src/renderer/app/features/dashboard/sidebar-header.component.scss` | Remove `.launch-row`, `.btn-create`, `.btn-icon` rules; add `.btn-header-icon--primary` modifier. |
| `src/renderer/app/features/agents/agent-selector.component.ts` | Convert to fully-controlled component (required `selectedAgentId` input, drop `AgentStore` dependency); restyle trigger to composer-pill aesthetic. |
| `src/renderer/app/features/instance-detail/input-panel.component.ts` | Import `AgentSelectorComponent`; add `selectedAgentId` computed and `onAgentSelected` handler. |
| `src/renderer/app/features/instance-detail/input-panel.component.html` | Add `<app-agent-selector>` between provider selector and YOLO toggle inside `.default-controls`. |

Each task below produces a self-contained, commitable change. The backend (Tasks 1–2) accepts `agentId` before any UI emits it; the draft service (Task 3) holds the field before the composer wires up; the welcome-coordinator (Task 4) flows it through; the UI changes (Tasks 5–7) layer on a working pipeline.

---

## Task 1: Backend accepts `agentId` on the create-with-message path

**Files:**
- Modify: `packages/contracts/src/schemas/instance.schemas.ts:28-35`
- Modify: `src/preload/domains/instance.preload.ts:32-44`
- Modify: `src/main/ipc/handlers/instance-handlers.ts:166-174`
- Test: `src/shared/validation/ipc-schemas.spec.ts`

- [ ] **Step 1: Add failing schema test for `agentId` acceptance**

Open `src/shared/validation/ipc-schemas.spec.ts`. After the existing `describe('InstanceCreatePayloadSchema forceNodeId', ...)` block (around line 36), add a new describe:

```typescript
describe('InstanceCreateWithMessagePayloadSchema agentId', () => {
  it('accepts an optional agentId string', () => {
    const result = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      message: 'hello',
      agentId: 'plan',
    });
    expect(result.success).toBe(true);
  });

  it('accepts payload without agentId', () => {
    const result = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      message: 'hello',
    });
    expect(result.success).toBe(true);
  });

  it('rejects agentId longer than 100 characters', () => {
    const result = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      message: 'hello',
      agentId: 'x'.repeat(101),
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Tighten the first test so it fails when `agentId` is stripped**

Zod by default strips unknown keys without erroring, so a naive `expect(result.success).toBe(true)` will pass even before the schema accepts `agentId`. Tighten the first test to assert the parsed value round-trips:

```typescript
  it('accepts an optional agentId string', () => {
    const result = InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/tmp/project',
      message: 'hello',
      agentId: 'plan',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.agentId).toBe('plan');
  });
```

Now run: `npx vitest run src/shared/validation/ipc-schemas.spec.ts -t "agentId"`
Expected:
- "accepts an optional agentId string" — **FAIL** (`result.data.agentId` is `undefined`).
- "accepts payload without agentId" — PASS (sanity case; passes before and after).
- "rejects agentId longer than 100 characters" — **FAIL** (101-char input is silently stripped, so `success` is currently `true`).

- [ ] **Step 3: Add `agentId` to `InstanceCreateWithMessagePayloadSchema`**

Edit `packages/contracts/src/schemas/instance.schemas.ts`. Locate `InstanceCreateWithMessagePayloadSchema` (currently lines 28–35) and add `agentId`:

```typescript
export const InstanceCreateWithMessagePayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  message: z.string().min(0).max(500000),
  attachments: z.array(FileAttachmentSchema).max(10).optional(),
  agentId: z.string().max(100).optional(),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
  model: z.string().max(100).optional(),
  forceNodeId: z.string().uuid().optional(),
});
```

- [ ] **Step 4: Run the schema tests and verify they pass**

Run: `npx vitest run src/shared/validation/ipc-schemas.spec.ts -t "agentId"`
Expected: All three tests PASS.

- [ ] **Step 5: Add `agentId` to the preload type**

Edit `src/preload/domains/instance.preload.ts`. The `createInstanceWithMessage` payload type (currently around lines 32–44) needs `agentId`:

```typescript
createInstanceWithMessage: (payload: {
  workingDirectory: string;
  message: string;
  attachments?: unknown[];
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';
  model?: string;
  forceNodeId?: string;
}): Promise<IpcResponse> => {
  return ipcRenderer.invoke(
    ch.INSTANCE_CREATE_WITH_MESSAGE,
    payload
  );
},
```

- [ ] **Step 6: Forward `agentId` from the IPC handler to `instanceManager.createInstance`**

Edit `src/main/ipc/handlers/instance-handlers.ts`. The `INSTANCE_CREATE_WITH_MESSAGE` handler currently calls `instanceManager.createInstance({...})` without passing `agentId` (around lines 166–174). Update the call:

```typescript
const instance = await instanceManager.createInstance({
  workingDirectory,
  initialPrompt: validated.message,
  attachments,
  initialOutputBuffer: [createInitialUserMessage(validated.message, attachments)],
  agentId: validated.agentId,
  provider: validated.provider as import('../../../shared/types/instance.types').InstanceProvider | undefined,
  modelOverride: validated.model,
  forceNodeId: validated.forceNodeId
});
```

- [ ] **Step 7: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

Run: `npm run lint`
Expected: PASS (no new errors).

- [ ] **Step 8: Commit**

```bash
git add packages/contracts/src/schemas/instance.schemas.ts \
        src/preload/domains/instance.preload.ts \
        src/main/ipc/handlers/instance-handlers.ts \
        src/shared/validation/ipc-schemas.spec.ts
git commit -m "feat(ipc): accept agentId on createInstanceWithMessage

Plumbs agentId through the contract schema, preload type, and main
IPC handler. The renderer doesn't emit it yet — that comes next."
```

---

## Task 2: Refactor `createInstanceWithMessage` to options-object, add `agentId`

**Files:**
- Modify: `src/renderer/app/core/services/ipc/instance-ipc.service.ts:21-28`
- Modify: `src/renderer/app/core/state/instance/instance-list.store.ts:119-177`
- Modify: `src/renderer/app/core/state/instance/instance.store.ts:494-510`
- Modify: `src/renderer/app/features/instance-detail/welcome-coordinator.service.ts:186-194` (single call site update)

This task is a refactor: positional args → options object, with the new `agentId?` field included. There is one external caller (`welcome-coordinator`) so the refactor is contained.

- [ ] **Step 1: Add `agentId` to `CreateInstanceWithMessageConfig`**

Edit `src/renderer/app/core/services/ipc/instance-ipc.service.ts`. Around lines 21–28:

```typescript
export interface CreateInstanceWithMessageConfig {
  workingDirectory: string;
  message: string;
  attachments?: FileAttachment[];
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';
  model?: string;
  forceNodeId?: string;
}
```

The body of `createInstanceWithMessage(config)` already passes `config` straight through to the preload — no body change needed.

- [ ] **Step 2: Refactor `instance-list.store.ts createInstanceWithMessage` to options-object**

Edit `src/renderer/app/core/state/instance/instance-list.store.ts`. Locate the method at line 119. Replace the positional signature with:

```typescript
interface CreateInstanceWithMessageOptions {
  message: string;
  files?: File[];
  workingDirectory?: string;
  agentId?: string;
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';
  model?: string;
  forceNodeId?: string;
}

async createInstanceWithMessage(
  options: CreateInstanceWithMessageOptions,
): Promise<boolean> {
  const { message, files, workingDirectory, agentId, provider, model, forceNodeId } = options;

  console.log('InstanceListStore: createInstanceWithMessage called with:', {
    message,
    filesCount: files?.length,
    workingDirectory,
    agentId,
    provider,
    model,
  });

  if (files && files.length > 0) {
    const validationErrors = this.validateFiles(files);
    if (validationErrors.length > 0) {
      const errorMessage = validationErrors.join('\n');
      console.error('InstanceListStore: File validation failed:', errorMessage);
      this.stateService.setError(`Cannot create instance:\n${errorMessage}`);
      return false;
    }
  }

  this.stateService.setLoading(true);

  try {
    const attachments =
      files && files.length > 0
        ? (await Promise.all(files.map((f) => this.fileToAttachments(f)))).flat()
        : undefined;

    const result = await this.ipc.createInstanceWithMessage({
      workingDirectory: workingDirectory || '.',
      message,
      attachments,
      agentId,
      provider: provider === 'auto' ? undefined : provider,
      model,
      forceNodeId,
    });
    console.log('InstanceListStore: createInstanceWithMessage result:', result);
    this.stateService.setLoading(false);
    if (!result.success) {
      this.stateService.setError(result.error?.message || 'Failed to create instance');
    } else {
      this.syncInstanceFromResponse(result.data, true);
    }
    return result.success;
  } catch (error) {
    console.error('InstanceListStore: createInstanceWithMessage error:', error);
    this.stateService.setLoading(false);
    this.stateService.setError(`Failed to create instance: ${(error as Error).message}`);
    return false;
  }
}
```

Place `CreateInstanceWithMessageOptions` near the top of the file (just after the imports/other interfaces) and export it so `instance.store.ts` can import the type.

- [ ] **Step 3: Mirror the signature on `instance.store.ts`**

Edit `src/renderer/app/core/state/instance/instance.store.ts`. The wrapper at line 494:

```typescript
import type { CreateInstanceWithMessageOptions } from './instance-list.store';

// ...

async createInstanceWithMessage(
  options: CreateInstanceWithMessageOptions,
): Promise<boolean> {
  return this.listStore.createInstanceWithMessage(options);
}
```

(Remove the old positional parameters.)

- [ ] **Step 4: Update the single external caller in `welcome-coordinator.service.ts`**

Edit `src/renderer/app/features/instance-detail/welcome-coordinator.service.ts`. The call at line 187:

```typescript
const launched = await this.store.createInstanceWithMessage({
  message: finalMessage,
  files: this.pendingFiles(),
  workingDirectory: effectiveWorkingDir,
  provider,
  model,
  forceNodeId,
});
```

Note: `agentId` is intentionally omitted here — Task 4 will read it from the draft and add it. For now the call is unchanged in behavior.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS — if any `_spec.ts` test was using the old positional signature, fix it now (none expected based on a grep of `createInstanceWithMessage(`, but verify).

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/core/services/ipc/instance-ipc.service.ts \
        src/renderer/app/core/state/instance/instance-list.store.ts \
        src/renderer/app/core/state/instance/instance.store.ts \
        src/renderer/app/features/instance-detail/welcome-coordinator.service.ts
git commit -m "refactor(instance-store): options-object signature for createInstanceWithMessage

Adds agentId to the options. The renderer-side IPC config and stores
now accept agentId; welcome-coordinator does not yet pass it (next task)."
```

---

## Task 3: `NewSessionDraftService` — add `agentId` field, default Build, reset on clear

**Files:**
- Modify: `src/renderer/app/core/services/new-session-draft.service.ts` (multiple sections)
- Test: `src/renderer/app/core/services/new-session-draft.service.spec.ts`

`NewSessionDraftService` holds per-directory `NewSessionDraftState` records inside a single state signal (line 12). Adding a field means: extend the interface, the empty/hydrate factories, the persistence type, and add a public computed + setter. `clearActiveComposer` extends to reset `agentId` (the spec calls this out as deliberate divergence from provider/model behavior, which still preserve).

- [ ] **Step 1: Add a failing test for the default `agentId` value**

Open `src/renderer/app/core/services/new-session-draft.service.spec.ts`. After the existing tests, add:

```typescript
  it('defaults agentId to "build" on a fresh draft', () => {
    expect(service.agentId()).toBe('build');
  });

  it('updates agentId via setAgentId', () => {
    service.setAgentId('plan');
    expect(service.agentId()).toBe('plan');
  });

  it('persists agentId across reload', () => {
    service.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    service.setAgentId('review');

    const reloaded = new NewSessionDraftService();
    reloaded.open('/Users/suas/work/orchestrat0r/claude-orchestrator');
    expect(reloaded.agentId()).toBe('review');
  });

  it('hydrates legacy persisted records (no agentId field) to "build"', () => {
    window.localStorage.setItem(
      'new-session-drafts:v1',
      JSON.stringify({
        version: 1,
        activeKey: '__default__',
        drafts: {
          __default__: {
            workingDirectory: null,
            prompt: 'old draft',
            provider: null,
            model: null,
            pendingFolders: [],
            updatedAt: 0,
          },
        },
      }),
    );

    const reloaded = new NewSessionDraftService();
    expect(reloaded.agentId()).toBe('build');
  });

  it('hydrates an unknown agent id to "build"', () => {
    window.localStorage.setItem(
      'new-session-drafts:v1',
      JSON.stringify({
        version: 1,
        activeKey: '__default__',
        drafts: {
          __default__: {
            workingDirectory: null,
            prompt: '',
            provider: null,
            model: null,
            agentId: 'made-up-agent',
            pendingFolders: [],
            updatedAt: 0,
          },
        },
      }),
    );

    const reloaded = new NewSessionDraftService();
    expect(reloaded.agentId()).toBe('build');
  });
```

- [ ] **Step 2: Update the existing `clearActiveComposer` test to expect `agentId` reset**

Edit the existing test at line 31 (`clears the active composer without discarding scoped provider or model choices`). After `service.setModel('gpt-5-codex')`, also call `service.setAgentId('plan')`. After the `clearActiveComposer()` call, also assert:

```typescript
    expect(service.agentId()).toBe('build');
    expect(service.provider()).toBe('codex');     // unchanged
    expect(service.model()).toBe('gpt-5-codex');  // unchanged
```

The existing assertions for provider/model preservation remain.

- [ ] **Step 3: Run the spec, verify failures**

Run: `npx vitest run src/renderer/app/core/services/new-session-draft.service.spec.ts`
Expected: 5 new tests fail (`service.agentId is not a function`); 1 existing test fails (no `setAgentId` method).

- [ ] **Step 4: Add `agentId` to `NewSessionDraftState` and `PersistedNewSessionDraft`**

Edit `src/renderer/app/core/services/new-session-draft.service.ts`. At the bottom of the file (line 550):

```typescript
interface NewSessionDraftState {
  workingDirectory: string | null;
  prompt: string;
  provider: ProviderType | null;
  model: string | null;
  nodeId: string | null;
  yoloMode: boolean | null;
  agentId: string;
  pendingFolders: string[];
  updatedAt: number;
}
```

And around line 567:

```typescript
interface PersistedNewSessionDraft {
  workingDirectory: string | null;
  prompt: string;
  provider: ProviderType | null;
  model: string | null;
  nodeId?: string | null;
  yoloMode?: boolean | null;
  agentId?: string;
  pendingFolders: string[];
  updatedAt: number;
}
```

- [ ] **Step 5: Add the `getDefaultAgent` import and `BUILTIN_AGENTS` for validation**

Near the top of the file (after the existing imports on lines 1–3):

```typescript
import { BUILTIN_AGENTS, getDefaultAgent } from '../../../../shared/types/agent.types';
```

- [ ] **Step 6: Update `createEmptyDraft` to initialize `agentId`**

Find `createEmptyDraft` (line 431). Add `agentId: getDefaultAgent().id`:

```typescript
private createEmptyDraft(workingDirectory: string | null): NewSessionDraftState {
  return {
    workingDirectory,
    prompt: '',
    provider: null,
    model: null,
    nodeId: null,
    yoloMode: null,
    agentId: getDefaultAgent().id,
    pendingFolders: [],
    updatedAt: Date.now(),
  };
}
```

- [ ] **Step 7: Update `hydrateDraft` to validate persisted `agentId`**

Find `hydrateDraft` (line 355). Add agentId resolution:

```typescript
private hydrateDraft(draft: PersistedNewSessionDraft | undefined): NewSessionDraftState {
  const provider = this.isProviderType(draft?.provider) ? draft.provider : null;
  const persistedAgentId = typeof draft?.agentId === 'string' ? draft.agentId.trim() : '';
  const isKnownAgent = persistedAgentId.length > 0
    && BUILTIN_AGENTS.some((a) => a.id === persistedAgentId);
  return {
    workingDirectory: this.normalizePath(draft?.workingDirectory),
    prompt: typeof draft?.prompt === 'string' ? draft.prompt : '',
    provider,
    model: this.normalizeDraftModel(
      provider,
      typeof draft?.model === 'string' && draft.model.trim().length > 0 ? draft.model : null,
    ),
    nodeId: typeof draft?.nodeId === 'string' && draft.nodeId.trim().length > 0 ? draft.nodeId : null,
    yoloMode: typeof draft?.yoloMode === 'boolean' ? draft.yoloMode : null,
    agentId: isKnownAgent ? persistedAgentId : getDefaultAgent().id,
    pendingFolders: Array.isArray(draft?.pendingFolders)
      ? draft.pendingFolders
          .map((entry) => this.normalizePath(entry))
          .filter((entry): entry is string => !!entry)
      : [],
    updatedAt: typeof draft?.updatedAt === 'number' ? draft.updatedAt : Date.now(),
  };
}
```

- [ ] **Step 8: Add the public `agentId` computed and `setAgentId` method**

In the readonly computeds block (around lines 14–26), add `agentId`:

```typescript
readonly agentId = computed(() => this.activeDraft().agentId);
```

Place it next to the other field computeds (after `readonly yoloMode` and before `readonly nodeId`).

After `setYoloMode` (around line 166), add:

```typescript
setAgentId(agentId: string): void {
  this.updateActiveDraft((draft) => {
    if (draft.agentId === agentId) {
      return draft;
    }
    return {
      ...draft,
      agentId,
      updatedAt: Date.now(),
    };
  });
}
```

- [ ] **Step 9: Update `clearActiveComposer` to reset `agentId`**

Find `clearActiveComposer` (line 258). Add `agentId: getDefaultAgent().id` to the patched draft:

```typescript
clearActiveComposer(): void {
  const activeKey = this.state().activeKey;
  this.updateActiveDraft((draft) => ({
    ...draft,
    prompt: '',
    pendingFolders: [],
    agentId: getDefaultAgent().id,
    updatedAt: Date.now(),
  }));
  const hadFiles = (this.pendingFilesByKey()[activeKey] ?? []).length > 0;
  if (hadFiles) {
    this.pendingFilesByKey.update((current) => ({
      ...current,
      [activeKey]: [],
    }));
    this.bumpRevision();
  }
}
```

- [ ] **Step 10: Run the spec, verify all tests pass**

Run: `npx vitest run src/renderer/app/core/services/new-session-draft.service.spec.ts`
Expected: All tests PASS (the 5 new ones plus the updated `clearActiveComposer` test plus the original tests unchanged).

- [ ] **Step 11: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/renderer/app/core/services/new-session-draft.service.ts \
        src/renderer/app/core/services/new-session-draft.service.spec.ts
git commit -m "feat(new-session-draft): hold agentId per draft, default 'build'

agentId joins the per-directory draft state with a Build default,
hydrated defensively from persisted records (legacy/unknown ids fall
back to 'build'). clearActiveComposer resets agentId on launch/discard;
provider/model preservation is unchanged."
```

---

## Task 4: `welcome-coordinator` passes `agentId` from the draft

**Files:**
- Modify: `src/renderer/app/features/instance-detail/welcome-coordinator.service.ts:186-194`

After this task, the full pipeline works: pick a mode in the (yet-to-be-added) UI → draft holds it → coordinator passes it → IPC accepts it → instance launches with it. Until the composer pill is added (Task 7), the draft always holds `'build'`, so behavior is identical to today's defaults.

- [ ] **Step 1: Pass `agentId` in the options object**

Edit `welcome-coordinator.service.ts`. The call at line 187:

```typescript
const launched = await this.store.createInstanceWithMessage({
  message: finalMessage,
  files: this.pendingFiles(),
  workingDirectory: effectiveWorkingDir,
  agentId: this.newSessionDraft.agentId(),
  provider,
  model,
  forceNodeId,
});
```

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Smoke verification**

Start the app: `npm run dev`. Create a new session by clicking "+" (the existing giant gradient button) and sending a prompt. After creation, inspect the instance's `agentId` field — easiest is to open the renderer DevTools console and run:

```js
const inst = window.electronAPI ? null : null; // confirm shape
// Or read from the instance store:
document.querySelector('app-root'); // sanity check app booted
```

Or check the running session in the UI — it should report Build mode (default). The point of this smoke test is to confirm the wiring doesn't crash, not to test the picker (which doesn't exist yet).

If the dev environment is already running, this can be a build/typecheck-only verification.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/instance-detail/welcome-coordinator.service.ts
git commit -m "feat(welcome): forward draft agentId to createInstanceWithMessage

End-to-end agentId flow now works. Draft still defaults to 'build'
until the composer mode pill is added."
```

---

## Task 5: Sidebar header — drop the launch row, move "+" to header-actions

**Files:**
- Modify: `src/renderer/app/features/dashboard/sidebar-header.component.ts` (template + imports)
- Modify: `src/renderer/app/features/dashboard/sidebar-header.component.scss`

After this task the agent-mode picker is no longer visible in the UI (it's removed from the sidebar; the composer pill comes in Task 7). The default behavior — Build for every new session — already works end-to-end after Task 4, so the user gets the same result they got 99% of the time before.

- [ ] **Step 1: Update the template — single row of three icon buttons, no launch row**

Edit `src/renderer/app/features/dashboard/sidebar-header.component.ts`. Remove the `AgentSelectorComponent` import (line 7), remove it from the `imports` array (line 12), and replace the entire template with:

```typescript
template: `
  <div class="sidebar-header">
    <div class="header-row">
      <div class="header-copy">
        <p class="header-eyebrow">Operator Workspace</p>
        <h1 class="header-title">Projects</h1>
      </div>
      <div class="header-actions">
        <button
          class="btn-header-icon"
          (click)="historyClicked.emit()"
          title="History (⌘H)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        </button>
        <button
          class="btn-header-icon"
          (click)="settingsClicked.emit()"
          title="Settings (⌘,)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
        <button
          class="btn-header-icon btn-header-icon--primary"
          (click)="createClicked.emit()"
          title="New session (⌘N)"
          aria-label="Create a new session"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>
    </div>
  </div>
`,
```

The `<div class="launch-row">` block is fully removed. Three header-icon buttons, in order: History, Settings, "+" (with the `--primary` modifier).

- [ ] **Step 2: Update the SCSS — drop launch styles, add `--primary` modifier**

Edit `src/renderer/app/features/dashboard/sidebar-header.component.scss`. Remove these blocks entirely:
- `.btn-create { ... }` (currently lines 72–96)
- `.btn-icon { ... }` (currently lines 98–101)
- `.launch-row { ... }` (currently lines 103–107)
- `.launch-row app-agent-selector { ... }` (currently lines 109–112)

After the existing `.btn-header-icon { ... }` rule (currently lines 51–70), add:

```scss
.btn-header-icon--primary {
  background: rgba(var(--primary-rgb), 0.12);
  border-color: rgba(var(--primary-rgb), 0.4);
  color: var(--primary);

  &:hover {
    background: rgba(var(--primary-rgb), 0.22);
    border-color: rgba(var(--primary-rgb), 0.55);
    color: var(--text-primary);
  }
}
```

The `:hover` rule on `.btn-header-icon` already provides the base hover transition; the modifier overrides specific properties.

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Visual verification**

Start the dev server (`npm run dev`) and confirm:
- The sidebar header shows a single row of icons: History (clock), Settings (gear), "+" (plus).
- The "+" icon is visually distinguished by a subtle primary tint vs. the muted History/Settings icons.
- Clicking "+" still opens the welcome screen.
- The big gradient "+" and "Build ▾" pill are gone.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/dashboard/sidebar-header.component.ts \
        src/renderer/app/features/dashboard/sidebar-header.component.scss
git commit -m "feat(sidebar): collapse launch row, '+' joins header icons

Removes the gradient '+' and the agent-mode dropdown from the
sidebar. '+' is now a 34x34 header-icon button with a subtle
primary tint, sitting alongside History and Settings."
```

---

## Task 6: `AgentSelectorComponent` — controlled component, composer-pill styling

**Files:**
- Modify: `src/renderer/app/features/agents/agent-selector.component.ts`

The component has no consumers after Task 5 until Task 7 wires it into the composer. This task makes the refactor clean — required input, no `AgentStore` dependency, pill aesthetic.

- [ ] **Step 1: Convert to controlled component, drop `AgentStore`**

Replace the entire file `src/renderer/app/features/agents/agent-selector.component.ts` with:

```typescript
/**
 * Agent Selector Component - Compact pill that selects agent mode
 *
 * Fully controlled: caller owns state via [selectedAgentId] / (agentSelected).
 * Renders the dropdown menu of built-in agent profiles (Build, Plan, Review,
 * Retriever) with their per-mode color cue.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { BUILTIN_AGENTS } from '../../../../shared/types/agent.types';
import type { AgentProfile } from '../../../../shared/types/agent.types';

@Component({
  selector: 'app-agent-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="agent-selector">
      <button
        type="button"
        class="selected-agent"
        [style.border-color]="selectedAgent().color"
        (click)="toggleDropdown()"
        [title]="'Mode: ' + selectedAgent().name"
      >
        <span class="agent-icon" [style.color]="selectedAgent().color">
          @switch (selectedAgent().icon) {
            @case ('hammer') {
              <span class="icon-symbol">&#9874;</span>
            }
            @case ('map') {
              <span class="icon-symbol">&#128506;</span>
            }
            @case ('eye') {
              <span class="icon-symbol">&#128065;</span>
            }
            @default {
              <span class="icon-symbol">&#9679;</span>
            }
          }
        </span>
        <span class="agent-name">{{ selectedAgent().name }}</span>
        <span class="dropdown-arrow">{{
          isOpen() ? '&#9650;' : '&#9660;'
        }}</span>
      </button>

      @if (isOpen()) {
        <div
          class="dropdown-menu"
          (click)="$event.stopPropagation()"
          (keydown.enter)="$event.stopPropagation()"
          (keydown.space)="$event.stopPropagation()"
          role="menu"
          tabindex="-1"
        >
          @for (agent of allAgents; track agent.id) {
            <button
              type="button"
              class="agent-option"
              [class.selected]="agent.id === selectedAgent().id"
              [style.border-left-color]="agent.color"
              (click)="selectAgent(agent)"
            >
              <span class="agent-icon" [style.color]="agent.color">
                @switch (agent.icon) {
                  @case ('hammer') {
                    <span class="icon-symbol">&#9874;</span>
                  }
                  @case ('map') {
                    <span class="icon-symbol">&#128506;</span>
                  }
                  @case ('eye') {
                    <span class="icon-symbol">&#128065;</span>
                  }
                  @default {
                    <span class="icon-symbol">&#9679;</span>
                  }
                }
              </span>
              <div class="agent-info">
                <span class="agent-name">{{ agent.name }}</span>
                <span class="agent-description">{{ agent.description }}</span>
              </div>
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-block;
      }

      .agent-selector {
        position: relative;
        z-index: 100;
      }

      .selected-agent {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        height: 32px;
        box-sizing: border-box;
        background: transparent;
        border: 1px solid;
        border-radius: 6px;
        color: var(--text-primary);
        cursor: pointer;
        transition: background var(--transition-fast);
        font-size: 13px;
      }

      .selected-agent:hover {
        background: var(--bg-tertiary);
      }

      .agent-icon {
        font-size: 14px;
      }

      .icon-symbol {
        display: inline-block;
        width: 16px;
        text-align: center;
      }

      .agent-name {
        font-weight: 500;
      }

      .dropdown-arrow {
        font-size: 10px;
        opacity: 0.6;
      }

      .dropdown-menu {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        min-width: 220px;
        margin-top: 4px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        overflow: hidden;
        z-index: 101;
      }

      .agent-option {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        background: transparent;
        border: none;
        border-left: 3px solid transparent;
        color: var(--text-primary);
        cursor: pointer;
        text-align: left;
        transition: background var(--transition-fast);
      }

      .agent-option:hover {
        background: var(--bg-tertiary);
      }

      .agent-option.selected {
        background: var(--bg-tertiary);
      }

      .agent-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .agent-info .agent-name {
        font-size: 13px;
      }

      .agent-description {
        font-size: 11px;
        color: var(--text-secondary);
      }
    `,
  ],
})
export class AgentSelectorComponent {
  private elementRef = inject(ElementRef<HTMLElement>);

  readonly selectedAgentId = input.required<string>();
  readonly agentSelected = output<AgentProfile>();

  protected readonly allAgents = BUILTIN_AGENTS;
  protected readonly isOpen = signal(false);
  protected readonly selectedAgent = computed<AgentProfile>(() => {
    const id = this.selectedAgentId();
    return BUILTIN_AGENTS.find((a) => a.id === id) ?? BUILTIN_AGENTS[0];
  });

  toggleDropdown(): void {
    this.isOpen.update((v) => !v);
  }

  closeDropdown(): void {
    this.isOpen.set(false);
  }

  selectAgent(agent: AgentProfile): void {
    this.agentSelected.emit(agent);
    this.closeDropdown();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.isOpen()) return;
    const target = event.target as Node | null;
    if (target && !this.elementRef.nativeElement.contains(target)) {
      this.closeDropdown();
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) {
      this.closeDropdown();
    }
  }
}
```

Key changes vs. the previous file:
- Removed `AgentStore` injection and all reads/writes against it.
- `selectedAgentId` is now a required `input.required<string>()` (Angular signal-input).
- `selectedAgent` is a `computed<AgentProfile>` derived from the input + `BUILTIN_AGENTS`. Falls back to the first built-in (Build) if the id is unknown — defensive.
- `selectAgent` only emits; no store write.
- Trigger styling now matches the composer pill aesthetic: 32px height, transparent default bg, border-only color cue, smaller padding/font.

- [ ] **Step 2: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS — the component has no consumers right now (sidebar removed it, composer hasn't added it yet), so no template-check failures should fire.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/features/agents/agent-selector.component.ts
git commit -m "refactor(agent-selector): controlled component, composer-pill style

Component now requires [selectedAgentId] and emits (agentSelected);
parent owns the state. Drops AgentStore dependency. Trigger styling
matches the composer toolbar pills (Claude / YOLO)."
```

---

## Task 7: Add the Mode pill to the new-session composer

**Files:**
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.html`

This is the final task. Wires the refactored `AgentSelectorComponent` into the existing `.default-controls` row (already gated by `isDraftComposer()`), reading from and writing to `NewSessionDraftService`.

- [ ] **Step 1: Import the component and add handlers in `input-panel.component.ts`**

Edit `src/renderer/app/features/instance-detail/input-panel.component.ts`. Update the imports near the top:

```typescript
import { AgentSelectorComponent } from '../agents/agent-selector.component';
import type { AgentProfile } from '../../../../shared/types/agent.types';
```

Update the component's `imports` array (around line 42) to include `AgentSelectorComponent`:

```typescript
imports: [ProviderSelectorComponent, CopilotModelSelectorComponent, AgentSelectorComponent],
```

Add these readonly/method members alongside the other computeds in the class body (place near the existing `selectedProvider` / `selectedModel` computeds, around lines 151–175):

```typescript
readonly selectedAgentId = computed(() => this.newSessionDraft.agentId());

onAgentSelected(agent: AgentProfile): void {
  this.newSessionDraft.setAgentId(agent.id);
}
```

`computed` is already imported from `@angular/core` in this file — no import update needed for it.

- [ ] **Step 2: Add `<app-agent-selector>` to the template**

Edit `src/renderer/app/features/instance-detail/input-panel.component.html`. Inside the existing `@if (isDraftComposer()) { ... .default-controls ... }` block (currently lines 54–80), insert the agent selector between the model selector and the YOLO button:

```html
<div class="default-controls">
  <app-provider-selector
    [provider]="selectedProvider()"
    (providerSelected)="onProviderSelected($event)"
  />
  @if (selectedProvider() === 'copilot') {
    <app-copilot-model-selector
      [model]="selectedModel()"
      (modelSelected)="onModelSelected($event)"
    />
  }
  <app-agent-selector
    [selectedAgentId]="selectedAgentId()"
    (agentSelected)="onAgentSelected($event)"
  />
  <button
    class="yolo-toggle"
    [class.active]="effectiveYoloMode()"
    (click)="onToggleYoloMode()"
    [title]="effectiveYoloMode() ? 'YOLO mode ON — auto-approve all actions' : 'YOLO mode OFF — will prompt for approvals'"
  >
    <span class="yolo-icon">{{ effectiveYoloMode() ? '⚡' : '🛡️' }}</span>
    <span class="yolo-label">YOLO {{ effectiveYoloMode() ? 'ON' : 'OFF' }}</span>
  </button>
</div>
```

- [ ] **Step 3: Typecheck and lint**

Run: `npx tsc --noEmit`
Expected: PASS.

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Run targeted Vitest specs**

Run: `npx vitest run src/renderer/app/core/services/new-session-draft.service.spec.ts src/shared/validation/ipc-schemas.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS (or, if any pre-existing flakes, no NEW failures).

- [ ] **Step 6: Manual smoke verification**

Start the app: `npm run dev`. Then:

1. Click "+" in the sidebar header — welcome screen opens.
2. The composer toolbar shows three pills, in order: provider (Claude/Codex/etc.), Mode pill (`⚒ Build ▾`), YOLO toggle.
3. Click the Mode pill — dropdown opens with Build / Plan / Review / Retriever, color-coded.
4. Pick "Plan". The pill updates to show Plan with the indigo border.
5. Type a short prompt and send.
6. Once the session starts, confirm it's running in plan mode (e.g., the running session reflects plan-mode restrictions; you can check the in-app instance metadata).
7. Click "+" again to open a fresh welcome. The Mode pill should be reset to `⚒ Build` (default), since `clearActiveComposer` reset the draft after the previous launch.

If the running session in step 6 reports `agentId: 'plan'` (visible in DevTools console via `__appState` or by inspecting the instance object), the end-to-end pipeline is working.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/app/features/instance-detail/input-panel.component.ts \
        src/renderer/app/features/instance-detail/input-panel.component.html
git commit -m "feat(composer): mode pill in new-session toolbar

Adds the agent-mode picker to the new-session composer alongside
the provider and YOLO controls. Defaults to Build; resets to Build
after each launch via clearActiveComposer. Replaces the (silently
broken) sidebar dropdown removed in the prior commit."
```

---

## Final verification (after Task 7)

- [ ] **Step 1: Full typecheck pass on both projects**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS.

- [ ] **Step 2: Full lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 4: Manual smoke (golden + regression paths)**

- Golden path: pick Plan in composer → send prompt → session reports `agentId: 'plan'` and applies plan-mode restrictions.
- Regression path 1: pick Build (default) → send → session reports `agentId: 'build'` and behaves as before.
- Regression path 2: open a second welcome screen (from a different project directory) → Mode defaults to Build for that project's draft (per-directory state).
- Regression path 3: confirm "+" still triggers `⌘N`, History (`⌘H`) and Settings (`⌘,`) still work.
- Regression path 4: confirm the welcome screen's existing controls — provider selector, copilot model selector (when copilot is selected), YOLO toggle — all work.
