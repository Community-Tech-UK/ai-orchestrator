# Phase 3: Monorepo Consolidation & Renderer Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the monorepo structure with `packages/sdk` for external tool/plugin authors, consolidate renderer IPC into a typed event bus, and clean up shared type boundaries.

**Architecture:** A new `packages/sdk` package provides the public API surface for tool and plugin developers. The renderer gains a typed IPC facade and event bus that replaces ad-hoc listener setup with declarative subscriptions. Main-only types are moved out of the shared layer into their domain directories.

**Tech Stack:** TypeScript 5.9, npm workspaces, Angular 21 signals, RxJS, Vitest

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/sdk/package.json` | SDK package manifest with workspace dependency on contracts |
| Create | `packages/sdk/tsconfig.json` | SDK TypeScript config, CommonJS output for Node consumers |
| Create | `packages/sdk/src/index.ts` | Public barrel export |
| Create | `packages/sdk/src/tools.ts` | Re-exports for tool authors |
| Create | `packages/sdk/src/plugins.ts` | Re-exports for plugin authors |
| Create | `packages/sdk/src/providers.ts` | Re-exports for provider authors |
| Create | `packages/sdk/README.md` | Usage examples for external developers |
| Create | `packages/sdk/src/__tests__/sdk-exports.spec.ts` | Vitest tests verifying all exports resolve |
| Create | `src/renderer/app/core/services/ipc/ipc-event-bus.service.ts` | Single Angular service owning ALL IPC push listeners |
| Modify | `src/renderer/app/core/state/instance/instance.store.ts` | Replace `setupIpcListeners()` with event bus subscriptions |
| Modify | `src/renderer/app/features/instance-detail/instance-detail.component.ts` | Remove direct `window.electronAPI` calls, use injected service |
| Modify | `src/renderer/app/features/rlm/ab-testing.component.ts` | Remove direct `window.electronAPI` access and deep preload import |
| Modify | `src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts` | Remove direct `window.electronAPI` cast, use base service |
| Move | `src/shared/types/observation.types.ts` → `src/main/observation/observation.types.ts` | Main-only types |
| Move | `src/shared/types/reaction.types.ts` → `src/main/reactions/reaction.types.ts` | Main-only types |
| Move | `src/shared/types/consensus.types.ts` → `src/main/orchestration/consensus.types.ts` | Main-only types |
| Modify | `tsconfig.json` | Add `@sdk/*` path alias |
| Modify | `tsconfig.electron.json` | Include `packages/sdk/src` in compilation |
| Modify | `vitest.config.ts` | Add `@sdk` resolve alias |

---

## Task Group A: Extract packages/sdk

### Task A1: Scaffold `packages/sdk`

**Files:**
- Create: `packages/sdk/package.json`
- Create: `packages/sdk/tsconfig.json`

This creates the package skeleton. No source files yet — TypeScript config and manifest only.

- [ ] **Step 1: Create `packages/sdk/package.json`**

```json
{
  "name": "@ai-orchestrator/sdk",
  "version": "0.1.0",
  "description": "SDK for building tools and plugins for AI Orchestrator",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["ai", "orchestrator", "sdk", "tools", "plugins"],
  "license": "MIT",
  "dependencies": {},
  "devDependencies": {},
  "peerDependencies": {
    "zod": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create `packages/sdk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node",
    "paths": {
      "@shared/*": ["../../src/shared/*"]
    },
    "baseUrl": "."
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "src/**/*.spec.ts"]
}
```

- [ ] **Step 3: Verify the directory was created**

Run: `ls packages/sdk/`

Expected output lists `package.json` and `tsconfig.json`.

---

### Task A2: Write SDK source files

**Files:**
- Create: `packages/sdk/src/tools.ts`
- Create: `packages/sdk/src/plugins.ts`
- Create: `packages/sdk/src/providers.ts`
- Create: `packages/sdk/src/index.ts`

These files re-export the existing types and builders from their current locations so external authors import from `@ai-orchestrator/sdk` rather than internal paths.

- [ ] **Step 1: Create `packages/sdk/src/tools.ts`**

Re-exports tool authoring types. Note: `ToolModule`, `ToolContext`, and `ToolSafetyMetadata` are what tool authors need. `ToolRegistry` is internal — do not re-export it.

```typescript
/**
 * Tool authoring exports for AI Orchestrator SDK.
 *
 * Tool module contract:
 * ```js
 * // ~/.orchestrator/tools/my-tool.js
 * const { z } = require('zod');
 * module.exports = {
 *   description: 'My custom tool',
 *   args: { query: z.string() },
 *   execute: async (args, ctx) => `Result for ${args.query}`,
 * };
 * ```
 */

export type { ToolContext, ToolModule } from '../../../src/main/tools/tool-registry';
export type { ToolSafetyMetadata } from '../../../src/shared/types/tool.types';
```

- [ ] **Step 2: Create `packages/sdk/src/plugins.ts`**

Re-exports plugin authoring types. `OrchestratorPluginContext` references `InstanceManager` which is internal — we expose a minimal `PluginInstanceManager` interface instead so the SDK has no hard dependency on the Electron runtime.

```typescript
/**
 * Plugin authoring exports for AI Orchestrator SDK.
 *
 * Plugin module contract:
 * ```js
 * // ~/.orchestrator/plugins/my-plugin.js
 * module.exports = async (ctx) => ({
 *   'instance.created': (payload) => console.log('created', payload),
 *   'instance.output': (payload) => { /* react to output *\/ },
 * });
 * ```
 */

export type { OrchestratorHooks, OrchestratorPluginModule } from '../../../src/main/plugins/plugin-manager';

/**
 * Minimal context surface exposed to plugins.
 * Matches the shape of OrchestratorPluginContext but with InstanceManager
 * replaced by a stable interface that does not leak internal types.
 */
export interface SdkPluginContext {
  /** Absolute path to the app's root directory. */
  appPath: string;
  /** User's home directory, or null if unavailable. */
  homeDir: string | null;
}
```

- [ ] **Step 3: Create `packages/sdk/src/providers.ts`**

Re-exports the provider extension points. `BaseProvider` is an abstract class from `src/main/providers/provider-interface.ts`; we re-export both it and the config types authors need.

```typescript
/**
 * Provider authoring exports for AI Orchestrator SDK.
 *
 * Custom providers are loaded via provider-plugins.ts; this module
 * exports the TypeScript types that describe the plugin contract.
 */

export type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  ProviderEvent,
  ProviderUsage,
  ProviderSessionOptions,
  ProviderAttachment,
  ModelInfo,
} from '../../../src/shared/types/provider.types';

export { BaseProvider } from '../../../src/main/providers/provider-interface';
```

- [ ] **Step 4: Create `packages/sdk/src/index.ts`**

Single barrel entry point.

```typescript
/**
 * @ai-orchestrator/sdk
 *
 * Public SDK for building tools, plugins, and providers for AI Orchestrator.
 *
 * @example
 * import type { ToolModule, ToolContext } from '@ai-orchestrator/sdk';
 *
 * const myTool: ToolModule = {
 *   description: 'My tool',
 *   execute: async (args, ctx: ToolContext) => 'done',
 * };
 */

export * from './tools';
export * from './plugins';
export * from './providers';
```

---

### Task A3: SDK tests and README

**Files:**
- Create: `packages/sdk/src/__tests__/sdk-exports.spec.ts`
- Create: `packages/sdk/README.md`

- [ ] **Step 1: Create `packages/sdk/src/__tests__/sdk-exports.spec.ts`**

This test verifies the SDK exports compile and that key symbols are present. It runs in Vitest via the root `vitest.config.ts` (which uses `src/**/*.spec.ts` — we need to also add `packages/**/*.spec.ts` in Task E1).

```typescript
import { describe, it, expect } from 'vitest';

// Verify named exports are importable at the module level.
// If any of these imports break, the SDK public surface has regressed.
import type { ToolModule, ToolContext, ToolSafetyMetadata } from '../tools';
import type { OrchestratorHooks, OrchestratorPluginModule, SdkPluginContext } from '../plugins';
import type {
  ProviderType,
  ProviderCapabilities,
  ProviderConfig,
} from '../providers';

describe('SDK exports', () => {
  it('exports ToolModule as a type', () => {
    // Structural check: a valid ToolModule must have description and execute.
    const tool: ToolModule = {
      description: 'test tool',
      execute: async (_args: unknown, _ctx: ToolContext) => 'ok',
    };
    expect(tool.description).toBe('test tool');
  });

  it('exports ToolSafetyMetadata as a type', () => {
    const meta: ToolSafetyMetadata = {
      isConcurrencySafe: true,
      isReadOnly: true,
      isDestructive: false,
    };
    expect(meta.isReadOnly).toBe(true);
  });

  it('exports OrchestratorHooks as a type', () => {
    const hooks: OrchestratorHooks = {
      'instance.created': (payload) => { void payload; },
    };
    expect(typeof hooks['instance.created']).toBe('function');
  });

  it('exports SdkPluginContext shape', () => {
    const ctx: SdkPluginContext = { appPath: '/app', homeDir: '/home/user' };
    expect(ctx.appPath).toBe('/app');
  });

  it('exports ProviderConfig as a type', () => {
    // ProviderConfig has a `type` discriminant field.
    const config: ProviderConfig = {
      type: 'anthropic-api',
      workingDirectory: '/cwd',
    };
    expect(config.type).toBe('anthropic-api');
  });
});
```

- [ ] **Step 2: Create `packages/sdk/README.md`**

```markdown
# @ai-orchestrator/sdk

SDK for building tools, plugins, and providers for AI Orchestrator.

## Tools

Drop a `.js` file into `~/.orchestrator/tools/` or `<cwd>/.orchestrator/tools/`:

```js
const { z } = require('zod');

/** @type {import('@ai-orchestrator/sdk').ToolModule} */
module.exports = {
  description: 'Fetch a URL and return its text content',
  args: {
    url: z.string().url(),
  },
  safety: {
    isConcurrencySafe: true,
    isReadOnly: true,
    isDestructive: false,
  },
  execute: async ({ url }, ctx) => {
    const res = await fetch(url);
    return res.text();
  },
};
```

## Plugins

Drop a `.js` file into `~/.orchestrator/plugins/`:

```js
/** @type {import('@ai-orchestrator/sdk').OrchestratorPluginModule} */
module.exports = async (ctx) => ({
  'instance.created': (payload) => {
    console.log(`[my-plugin] New instance: ${payload.id}`);
  },
  'instance.output': (payload) => {
    // React to every output message
  },
});
```

## TypeScript usage

```ts
import type { ToolModule, ToolContext, SdkPluginContext } from '@ai-orchestrator/sdk';
```
```

- [ ] **Step 3: Commit Task Group A**

```bash
git add packages/sdk/
git commit -m "feat(sdk): scaffold packages/sdk with tool, plugin, provider re-exports"
```

---

## Task Group B: Typed IPC Facade — Eliminate Direct `window.electronAPI` Access

There are currently 4 files with direct `window.electronAPI` access outside `ElectronIpcService`:
1. `src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts` (lines 27–28)
2. `src/renderer/app/features/rlm/ab-testing.component.ts` (line 27 + deep preload import on line 16)
3. `src/renderer/app/features/instance-detail/instance-detail.component.ts` (lines 1135–1167)
4. `src/renderer/app/core/services/ipc/electron-ipc.service.ts` (lines 75–76 — this is the ONE legitimate access point)

### Task B1: Fix `cross-model-review-ipc.service.ts`

**Files:**
- Modify: `src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts`

- [ ] **Step 1: Read the file**

Read `src/renderer/app/core/services/ipc/cross-model-review-ipc.service.ts` in full.

- [ ] **Step 2: Replace the raw `window.electronAPI` access with injection of `ElectronIpcService`**

The file currently does:
```typescript
function getCrossModelApi(): CrossModelReviewApi | null {
  if (typeof window === 'undefined' || !window.electronAPI) return null;
  return window.electronAPI as unknown as CrossModelReviewApi;
}
```

Replace the standalone function with an injected accessor inside the `@Injectable` class. The service already has `@Injectable` — change the helper to use `inject(ElectronIpcService)`:

```typescript
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class CrossModelReviewIpcService {
  private base = inject(ElectronIpcService);

  private get api(): CrossModelReviewApi | null {
    return this.base.getApi() as unknown as CrossModelReviewApi | null;
  }
  // ... rest of class unchanged, but replace getCrossModelApi() calls with this.api
}
```

Remove the standalone `getCrossModelApi()` function and all `window.electronAPI` references. The `CrossModelReviewApi` type can remain locally declared — it does not need to move.

- [ ] **Step 3: Run typecheck on the modified file**

```bash
npx tsc --noEmit 2>&1 | grep cross-model-review
```

Expected: no output (no errors).

---

### Task B2: Fix `ab-testing.component.ts`

**Files:**
- Modify: `src/renderer/app/features/rlm/ab-testing.component.ts`

- [ ] **Step 1: Read the file**

Read `src/renderer/app/features/rlm/ab-testing.component.ts` in full.

- [ ] **Step 2: Remove the deep preload import and `window.electronAPI` access**

Line 16 currently:
```typescript
import type { ElectronAPI } from '../../../../preload/preload';
```

Lines 18–27 currently extend `Window` and define a helper returning `window.electronAPI`. Replace this entire block with injection of `ElectronIpcService`:

```typescript
import { Component, inject } from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';

// In the class body:
private electronIpc = inject(ElectronIpcService);
```

Replace every usage of `getElectronApi()` (or equivalent) with `this.electronIpc.getApi()`. Remove the `Window` augmentation block — it is now redundant since `ElectronIpcService` owns the `window.electronAPI` declaration.

- [ ] **Step 3: Verify no remaining preload import**

```bash
grep -n "preload/preload" src/renderer/app/features/rlm/ab-testing.component.ts
```

Expected: no output.

---

### Task B3: Fix `instance-detail.component.ts`

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`

- [ ] **Step 1: Read the relevant section of the file**

Read lines 1120–1175 of `src/renderer/app/features/instance-detail/instance-detail.component.ts`.

- [ ] **Step 2: Identify the two usages**

Both usages (around lines 1135 and 1163) call `window.electronAPI.getFileStats(filePath)`. The `FileIpcService` already has a `getFileStats` method. The component needs to inject `FileIpcService`.

- [ ] **Step 3: Inject `FileIpcService` and replace calls**

Add to imports:
```typescript
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
```

Add to the class (in the `inject()` declarations block that already exists):
```typescript
private fileIpc = inject(FileIpcService);
```

Replace:
```typescript
if (!window.electronAPI) return;
// ...
const stats = await window.electronAPI.getFileStats(filePath);
```

With:
```typescript
const result = await this.fileIpc.getFileStats(filePath);
if (!result.success) return;
const stats = result.data;
```

Apply the same replacement for the second occurrence near line 1163. Remove the `window.electronAPI` guard checks — `FileIpcService` already handles the not-in-Electron case gracefully.

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | grep instance-detail
```

Expected: no errors relating to `instance-detail.component.ts`.

- [ ] **Step 5: Commit Task Group B**

```bash
git add src/renderer/app/
git commit -m "refactor(renderer): eliminate direct window.electronAPI access, route through services"
```

---

## Task Group C: IPC Event Bus

The goal is a single Angular service that sets up every IPC push listener once, and exposes domain-scoped Observables that stores subscribe to. This replaces the 8 individual `this.ipc.onXxx(callback)` calls in `InstanceStore.setupIpcListeners()`.

### Task C1: Create `IpcEventBusService`

**Files:**
- Create: `src/renderer/app/core/services/ipc/ipc-event-bus.service.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * IPC Event Bus
 *
 * Owns ALL IPC push-event subscriptions for the renderer.
 * Stores and components subscribe to domain-scoped Observables
 * instead of calling ipc.onXxx() individually.
 *
 * Design rules:
 * - This service sets up listeners exactly once (providedIn: 'root').
 * - Each domain stream is a Subject that replays nothing (hot observable).
 * - Stores use .pipe(filter(...)) or direct subscription to the typed stream.
 * - NgZone wrapping is handled here; consumers run in the Angular zone.
 */

import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subject, Observable } from 'rxjs';
import { InstanceIpcService } from './instance-ipc.service';

// -----------------------------------------------------------------------
// Typed event union for the instance domain
// -----------------------------------------------------------------------

export interface InstanceCreatedEvent {
  type: 'instance:created';
  payload: unknown;
}

export interface InstanceRemovedEvent {
  type: 'instance:removed';
  payload: string; // instanceId
}

export interface InstanceStateUpdateEvent {
  type: 'instance:state-update';
  payload: unknown;
}

export interface InstanceOutputEvent {
  type: 'instance:output';
  payload: unknown;
}

export interface BatchUpdateEvent {
  type: 'instance:batch-update';
  payload: unknown;
}

export interface OrchestrationActivityEvent {
  type: 'orchestration:activity';
  payload: unknown;
}

export interface CompactStatusEvent {
  type: 'instance:compact-status';
  payload: unknown;
}

export interface InputRequiredEvent {
  type: 'instance:input-required';
  payload: unknown;
}

export interface ContextWarningEvent {
  type: 'context:warning';
  payload: unknown;
}

export type InstanceDomainEvent =
  | InstanceCreatedEvent
  | InstanceRemovedEvent
  | InstanceStateUpdateEvent
  | InstanceOutputEvent
  | BatchUpdateEvent
  | OrchestrationActivityEvent
  | CompactStatusEvent
  | InputRequiredEvent
  | ContextWarningEvent;

// -----------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class IpcEventBusService implements OnDestroy {
  private instanceIpc = inject(InstanceIpcService);

  private _instance$ = new Subject<InstanceDomainEvent>();
  private _unsubscribes: Array<() => void> = [];

  /** All instance-domain push events. Use pipe(filter(...)) to select by type. */
  readonly instance$: Observable<InstanceDomainEvent> = this._instance$.asObservable();

  constructor() {
    this.setupInstanceListeners();
  }

  ngOnDestroy(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._instance$.complete();
  }

  private setupInstanceListeners(): void {
    this._unsubscribes.push(
      this.instanceIpc.onInstanceCreated((payload) =>
        this._instance$.next({ type: 'instance:created', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onInstanceRemoved((payload) =>
        this._instance$.next({ type: 'instance:removed', payload: payload as string })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onInstanceStateUpdate((payload) =>
        this._instance$.next({ type: 'instance:state-update', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onInstanceOutput((payload) =>
        this._instance$.next({ type: 'instance:output', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onBatchUpdate((payload) =>
        this._instance$.next({ type: 'instance:batch-update', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onOrchestrationActivity((payload) =>
        this._instance$.next({ type: 'orchestration:activity', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onCompactStatus((payload) =>
        this._instance$.next({ type: 'instance:compact-status', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onInputRequired((payload) =>
        this._instance$.next({ type: 'instance:input-required', payload })
      )
    );

    this._unsubscribes.push(
      this.instanceIpc.onContextWarning((payload) =>
        this._instance$.next({ type: 'context:warning', payload })
      )
    );
  }
}
```

- [ ] **Step 2: Export from the IPC services barrel**

In `src/renderer/app/core/services/ipc/index.ts`, add after the last `export` line in the re-export block:

```typescript
export { IpcEventBusService } from './ipc-event-bus.service';
export type { InstanceDomainEvent } from './ipc-event-bus.service';
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep ipc-event-bus
```

Expected: no errors.

---

### Task C2: Refactor `InstanceStore` to use `IpcEventBusService`

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance.store.ts`

- [ ] **Step 1: Read the current `setupIpcListeners` method in full**

Read `src/renderer/app/core/state/instance/instance.store.ts` lines 95–215.

- [ ] **Step 2: Replace `setupIpcListeners` with event bus subscriptions**

Replace the entire `private setupIpcListeners(): void` method body. The method changes from 8+ individual `this.ipc.onXxx()` calls to RxJS subscriptions on `ipcEventBus.instance$`.

First, update imports at the top of the file:

```typescript
import { IpcEventBusService } from '../../services/ipc/ipc-event-bus.service';
```

Add injection in the class body (alongside existing `inject()` calls):

```typescript
private ipcEventBus = inject(IpcEventBusService);
```

Replace `setupIpcListeners()`:

```typescript
private setupIpcListeners(): void {
  const sub = this.ipcEventBus.instance$.subscribe((event) => {
    switch (event.type) {
      case 'instance:created': {
        const data = event.payload as { id?: string; sessionId?: string; agentId?: string; workingDirectory?: string };
        this.listStore.addInstance(event.payload);
        if (data.sessionId && data.id) {
          this.statsIpc.statsRecordSessionStart(
            data.sessionId, data.id, data.agentId || 'build', data.workingDirectory || ''
          ).catch(() => { /* stats recording is best-effort */ });
        }
        break;
      }
      case 'instance:removed': {
        const instanceId = event.payload;
        this.activityDebouncer.clearActivity(instanceId);
        this.outputStore.cleanupInstance(instanceId);
        this.listStore.removeInstance(instanceId);
        break;
      }
      case 'instance:state-update': {
        const update = event.payload as StateUpdate;
        if (update.status === 'error' || update.status === 'terminated') {
          this.applyUpdate(update);
        } else {
          this.batcher.queueUpdate(update);
        }
        break;
      }
      case 'instance:output': {
        const data = event.payload as { instanceId: string; message: OutputMessage };
        const { instanceId, message } = data;
        if (message.type === 'tool_use' && message.metadata?.['name']) {
          const toolName = message.metadata['name'] as string;
          const activity = generateActivityStatus(toolName);
          this.activityDebouncer.setActivity(instanceId, activity, toolName);
          const inst = this.stateService.state().instances.get(instanceId);
          if (inst?.sessionId) {
            this.statsIpc.statsRecordToolUsage(inst.sessionId, toolName)
              .catch(() => { /* stats recording is best-effort */ });
          }
        }
        this.outputStore.queueOutput(instanceId, message);
        break;
      }
      case 'instance:batch-update': {
        const data = event.payload as { updates?: StateUpdate[] };
        if (data.updates) {
          this.batcher.queueUpdates(data.updates);
        }
        break;
      }
      case 'orchestration:activity': {
        const data = event.payload as OrchestrationActivityPayload;
        if (data.instanceId && data.activity) {
          this.activityDebouncer.setActivity(
            data.instanceId,
            data.activity,
            `orch:${data.category}`
          );
        }
        break;
      }
      case 'instance:compact-status': {
        const data = event.payload as { instanceId: string; status: string };
        if (data.status === 'started') {
          this._compactingInstances.update(set => {
            const next = new Set(set);
            next.add(data.instanceId);
            return next;
          });
        } else {
          this._compactingInstances.update(set => {
            const next = new Set(set);
            next.delete(data.instanceId);
            return next;
          });
        }
        break;
      }
      case 'instance:input-required': {
        const payload = event.payload as { instanceId: string; requestId: string };
        if (payload.instanceId) {
          const inst = this.stateService.getInstance(payload.instanceId);
          if (inst?.yoloMode) break;
          this.stateService.updateInstance(payload.instanceId, {
            pendingApprovalCount: (inst?.pendingApprovalCount ?? 0) + 1,
          });
        }
        break;
      }
      default:
        break;
    }
  });

  // Store the RxJS subscription as an unsubscribe callback
  this.unsubscribes.push(() => sub.unsubscribe());
}
```

Note: Remove the old individual `this.ipc` listener imports if `ElectronIpcService` is no longer needed directly by this store. Verify the class still compiles — `this.ipc` may still be used for invoke calls (e.g. `this.ipc.compactInstance`).

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit 2>&1 | grep instance.store
```

Expected: no errors.

- [ ] **Step 4: Commit Task Group C**

```bash
git add src/renderer/app/core/services/ipc/ipc-event-bus.service.ts src/renderer/app/core/state/instance/instance.store.ts src/renderer/app/core/services/ipc/index.ts
git commit -m "feat(renderer): add IpcEventBusService, refactor InstanceStore to declarative subscriptions"
```

---

## Task Group D: Shared Types Cleanup

Move types that are exclusively consumed by `src/main/` out of `src/shared/types/`. This reduces the shared surface and clarifies what the renderer actually depends on.

**Pre-audit results** (verified by grepping renderer imports):

| Type file | Renderer usage | Decision |
|-----------|---------------|----------|
| `observation.types.ts` | None found | Move to `src/main/observation/` |
| `reaction.types.ts` | None found | Move to `src/main/reactions/` |
| `consensus.types.ts` | None found | Move to `src/main/orchestration/` |
| `rlm.types.ts` | Used by 7 renderer components | Keep in shared |
| `self-improvement.types.ts` | Used by `rlm-page.component.ts` | Keep in shared |
| `specialist.types.ts` | Used by 2 specialist components | Keep in shared |

### Task D1: Move `observation.types.ts`

**Files:**
- Move: `src/shared/types/observation.types.ts` → `src/main/observation/observation.types.ts`
- Modify: All `src/main/` files that import from `../../shared/types/observation.types`

- [ ] **Step 1: Read `src/shared/types/observation.types.ts` in full**

Read the file to understand its contents before moving.

- [ ] **Step 2: Create `src/main/observation/observation.types.ts`**

Write the file at the new path with identical content.

- [ ] **Step 3: Update all main-process imports**

Run:
```bash
grep -rn "shared/types/observation.types" src/main --include="*.ts"
```

For each file listed, change the import path. The files are:
- `src/main/observation/policy-adapter.ts` — change `../../shared/types/observation.types` to `./observation.types`
- `src/main/observation/observation-ingestor.ts` — change to `./observation.types`
- `src/main/observation/observation-store.ts` — change to `./observation.types`
- `src/main/observation/observer-agent.ts` — change to `./observation.types`
- `src/main/observation/policy-adapter.spec.ts` — change to `./observation.types`
- `src/main/observation/observer-agent.spec.ts` — change to `./observation.types`
- `src/main/observation/reflector-agent.spec.ts` — change to `./observation.types`

Also check if `src/shared/types/index.ts` re-exports observation types and remove that entry.

- [ ] **Step 4: Delete the old file**

```bash
rm src/shared/types/observation.types.ts
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.electron.json 2>&1 | grep observation
```

Expected: no errors.

---

### Task D2: Move `reaction.types.ts`

**Files:**
- Move: `src/shared/types/reaction.types.ts` → `src/main/reactions/reaction.types.ts`
- Modify: All `src/main/` files importing `reaction.types`

- [ ] **Step 1: Read `src/shared/types/reaction.types.ts` in full**

- [ ] **Step 2: Create `src/main/reactions/reaction.types.ts`** with identical content.

- [ ] **Step 3: Update all main-process imports**

Run:
```bash
grep -rn "shared/types/reaction.types" src/main --include="*.ts"
```

Files to update:
- `src/main/reactions/reaction-engine.ts` — change `../../shared/types/reaction.types` to `./reaction.types`
- `src/main/reactions/__tests__/reaction-engine.spec.ts` — change to `../reaction.types`
- `src/main/vcs/remotes/github-pr-poller.ts` — change `../../../shared/types/reaction.types` to `../../reactions/reaction.types`

Check `src/shared/types/index.ts` for re-export and remove if present.

- [ ] **Step 4: Delete the old file**

```bash
rm src/shared/types/reaction.types.ts
```

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit -p tsconfig.electron.json 2>&1 | grep reaction
```

Expected: no errors.

---

### Task D3: Move `consensus.types.ts`

**Files:**
- Move: `src/shared/types/consensus.types.ts` → `src/main/orchestration/consensus.types.ts`
- Modify: All `src/main/` files importing `consensus.types`

- [ ] **Step 1: Read `src/shared/types/consensus.types.ts` in full**

- [ ] **Step 2: Create `src/main/orchestration/consensus.types.ts`** with identical content.

- [ ] **Step 3: Update all main-process imports**

Run:
```bash
grep -rn "shared/types/consensus.types" src/main --include="*.ts"
```

Files to update:
- `src/main/orchestration/orchestration-protocol.ts` — change `../../shared/types/consensus.types` to `./consensus.types`
- `src/main/orchestration/orchestration-handler.ts` — change to `./consensus.types`

Check and update any other files returned by the grep.

Check `src/shared/types/index.ts` for re-export and remove if present.

- [ ] **Step 4: Delete the old file**

```bash
rm src/shared/types/consensus.types.ts
```

- [ ] **Step 5: Typecheck both configs**

```bash
npx tsc --noEmit -p tsconfig.electron.json 2>&1 | grep consensus
npx tsc --noEmit 2>&1 | grep consensus
```

Expected: no errors in either.

- [ ] **Step 6: Commit Task Group D**

```bash
git add src/shared/types/ src/main/observation/ src/main/reactions/ src/main/orchestration/
git commit -m "refactor(shared): move main-only types (observation, reaction, consensus) into their domains"
```

---

## Task Group E: Build & Path Config

### Task E1: Update TypeScript configs and Vitest

**Files:**
- Modify: `tsconfig.json`
- Modify: `tsconfig.electron.json`
- Modify: `vitest.config.ts`

- [ ] **Step 1: Add `@sdk/*` alias to `tsconfig.json`**

In `tsconfig.json`, under `compilerOptions.paths`, add:

```json
"@sdk/*": ["./packages/sdk/src/*"]
```

The paths block becomes:
```json
"paths": {
  "@shared/*": ["./src/shared/*"],
  "@sdk/*": ["./packages/sdk/src/*"]
}
```

- [ ] **Step 2: Add `packages/sdk` to `tsconfig.electron.json`**

In `tsconfig.electron.json`, update `include` to add the SDK:

```json
"include": [
  "src/main/**/*",
  "src/preload/**/*",
  "src/shared/**/*",
  "packages/sdk/src/**/*"
]
```

Also add the `@sdk/*` path alias:

```json
"paths": {
  "@shared/*": ["./src/shared/*"],
  "@sdk/*": ["./packages/sdk/src/*"]
}
```

- [ ] **Step 3: Update `vitest.config.ts` to include SDK tests and alias**

In `vitest.config.ts`, update `test.include` to include package specs:

```typescript
include: ['src/**/*.spec.ts', 'src/**/*.test.ts', 'packages/**/*.spec.ts'],
```

Add the `@sdk` alias in `resolve.alias`:

```typescript
resolve: {
  alias: {
    '@shared': resolve(__dirname, './src/shared'),
    '@sdk': resolve(__dirname, './packages/sdk/src'),
  },
},
```

---

### Task E2: Final Verification

**This task must be completed before marking the plan done.**

- [ ] **Step 1: TypeScript — renderer build**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 2: TypeScript — main process and SDK**

```bash
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: exits 0, no output.

- [ ] **Step 3: TypeScript — spec files**

```bash
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: exits 0, no output.

- [ ] **Step 4: Run test suite**

```bash
npm run test
```

Expected: all tests pass, including the new `packages/sdk/src/__tests__/sdk-exports.spec.ts`.

Confirm the SDK test file appears in the output:
```
packages/sdk/src/__tests__/sdk-exports.spec.ts (5 tests)
```

- [ ] **Step 5: Lint**

```bash
npm run lint
```

Expected: exits 0, no ESLint errors.

- [ ] **Step 6: Confirm zero remaining direct `window.electronAPI` accesses outside `ElectronIpcService`**

```bash
grep -rn "window\.electronAPI" src/renderer --include="*.ts"
```

Expected: only `src/renderer/app/core/services/ipc/electron-ipc.service.ts` lines 75–76 appear.

- [ ] **Step 7: Confirm zero remaining deep preload imports**

```bash
grep -rn "from '.*preload/preload'" src/renderer --include="*.ts"
```

Expected: only `src/renderer/app/core/services/ipc/electron-ipc.service.ts` remains (the one legitimate location).

- [ ] **Step 8: Commit final state**

```bash
git add tsconfig.json tsconfig.electron.json vitest.config.ts
git commit -m "build: add @sdk path aliases, include packages/sdk in builds and tests"
```

---

## Completion Checklist

After all tasks are done, verify each item is actually complete:

| Item | Status |
|------|--------|
| `packages/sdk/` scaffolded with `package.json` and `tsconfig.json` | |
| `packages/sdk/src/tools.ts`, `plugins.ts`, `providers.ts`, `index.ts` written | |
| `packages/sdk/README.md` written | |
| `packages/sdk/src/__tests__/sdk-exports.spec.ts` written and passing | |
| `cross-model-review-ipc.service.ts` — no `window.electronAPI` access | |
| `ab-testing.component.ts` — no `window.electronAPI` or deep preload import | |
| `instance-detail.component.ts` — no `window.electronAPI` access | |
| `IpcEventBusService` created | |
| `IpcEventBusService` exported from `src/renderer/app/core/services/ipc/index.ts` | |
| `InstanceStore.setupIpcListeners()` uses event bus (no individual `ipc.onXxx()` calls) | |
| `observation.types.ts` moved to `src/main/observation/` | |
| `reaction.types.ts` moved to `src/main/reactions/` | |
| `consensus.types.ts` moved to `src/main/orchestration/` | |
| `tsconfig.json` has `@sdk/*` alias | |
| `tsconfig.electron.json` includes `packages/sdk/src/**/*` | |
| `vitest.config.ts` covers `packages/**/*.spec.ts` and has `@sdk` alias | |
| `npx tsc --noEmit` passes | |
| `npx tsc --noEmit -p tsconfig.electron.json` passes | |
| `npx tsc --noEmit -p tsconfig.spec.json` passes | |
| `npm run test` passes | |
| `npm run lint` passes | |
