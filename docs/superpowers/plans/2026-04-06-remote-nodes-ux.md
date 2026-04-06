# Remote Nodes UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose which machine (local or remote worker node) to run CLI sessions on, see which sessions are remote, and get live node status.

**Architecture:** Add `forceNodeId` to the IPC creation schema (backend already handles it). Create a push-based `RemoteNodeStore` fed by IPC events from the registry. Build a `NodePickerComponent` dropdown for session creation. Update instance row, instance list, and instance header to show remote node info.

**Tech Stack:** Angular 21 (zoneless, signals, standalone components, OnPush), Electron IPC, Zod 4 validation, Vitest

**Spec:** `docs/superpowers/specs/2026-04-06-remote-nodes-ux-design.md`

---

### Task 1: Add `forceNodeId` to IPC Schema

**Files:**
- Modify: `src/shared/validation/ipc-schemas.ts:32-43`
- Test: `src/shared/validation/__tests__/ipc-schemas.spec.ts`

- [ ] **Step 1: Write test for forceNodeId acceptance**

Add to the existing `InstanceCreatePayloadSchema` test section in `src/shared/validation/__tests__/ipc-schemas.spec.ts`:

```typescript
it('should accept optional forceNodeId as valid UUID', () => {
  const result = InstanceCreatePayloadSchema.safeParse({
    workingDirectory: '/tmp/test',
    forceNodeId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  });
  expect(result.success).toBe(true);
});

it('should reject forceNodeId that is not a UUID', () => {
  const result = InstanceCreatePayloadSchema.safeParse({
    workingDirectory: '/tmp/test',
    forceNodeId: 'not-a-uuid',
  });
  expect(result.success).toBe(false);
});

it('should accept payload without forceNodeId', () => {
  const result = InstanceCreatePayloadSchema.safeParse({
    workingDirectory: '/tmp/test',
  });
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/validation/__tests__/ipc-schemas.spec.ts`
Expected: First test FAILs — `forceNodeId` is stripped as unrecognized key.

- [ ] **Step 3: Add forceNodeId to schema**

In `src/shared/validation/ipc-schemas.ts`, add to `InstanceCreatePayloadSchema` (after the `model` field at line 42):

```typescript
forceNodeId: z.string().uuid().optional(),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/shared/validation/__tests__/ipc-schemas.spec.ts`
Expected: All PASS.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 6: Commit**

```
git add src/shared/validation/ipc-schemas.ts src/shared/validation/__tests__/ipc-schemas.spec.ts
git commit -m "feat(remote-nodes): add forceNodeId to instance creation IPC schema"
```

---

### Task 2: Add `forceNodeId` to Renderer Types and IPC Service

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance.types.ts:113-121`
- Modify: `src/renderer/app/core/services/ipc/instance-ipc.service.ts:9-18`

- [ ] **Step 1: Add to renderer state type**

In `src/renderer/app/core/state/instance/instance.types.ts`, add to `CreateInstanceConfig` (after `model?: string;` at line 120):

```typescript
forceNodeId?: string;
```

- [ ] **Step 2: Add to IPC service type**

In `src/renderer/app/core/services/ipc/instance-ipc.service.ts`, add to `CreateInstanceConfig` (after `model?: string;` at line 17):

```typescript
forceNodeId?: string;
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 4: Commit**

```
git add src/renderer/app/core/state/instance/instance.types.ts src/renderer/app/core/services/ipc/instance-ipc.service.ts
git commit -m "feat(remote-nodes): add forceNodeId to renderer instance types"
```

---

### Task 3: Pass `forceNodeId` Through Instance Store

**Files:**
- Modify: `src/renderer/app/core/state/instance/instance-list.store.ts:81-102`

- [ ] **Step 1: Update createInstance()**

In `src/renderer/app/core/state/instance/instance-list.store.ts`, update the `createInstance` method (line 86) to include `forceNodeId`:

```typescript
const result = await this.ipc.createInstance({
  workingDirectory: config.workingDirectory || '.',
  displayName: config.displayName,
  parentInstanceId: config.parentId,
  yoloMode: config.yoloMode,
  agentId: config.agentId,
  provider: config.provider,
  model: config.model,
  forceNodeId: config.forceNodeId,
});
```

- [ ] **Step 2: Update createInstanceWithMessage()**

In the same file, update `createInstanceWithMessage` (line 107) to accept and pass `forceNodeId`. Add it as an optional parameter after `model`:

```typescript
async createInstanceWithMessage(
  message: string,
  files?: File[],
  workingDirectory?: string,
  provider?: 'claude' | 'codex' | 'gemini' | 'copilot' | 'auto',
  model?: string,
  forceNodeId?: string,
): Promise<boolean> {
```

Then in the IPC call inside the method (around line 147), add `forceNodeId` to the config object:

```typescript
const result = await this.ipc.createInstanceWithMessage({
  workingDirectory: workingDirectory || '.',
  message,
  attachments,
  provider: provider === 'auto' ? undefined : provider,
  model,
  forceNodeId,
});
```

Also add `forceNodeId` to the `CreateInstanceWithMessageConfig` interface in `instance-ipc.service.ts` (if it exists as a separate type) or to the IPC call payload type.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 4: Lint**

Run: `npx eslint src/renderer/app/core/state/instance/instance-list.store.ts`
Expected: Clean.

- [ ] **Step 5: Commit**

```
git add src/renderer/app/core/state/instance/instance-list.store.ts
git commit -m "feat(remote-nodes): pass forceNodeId through instance store to IPC"
```

---

### Task 4: Add `nodes-changed` IPC Event Broadcasting

**Files:**
- Modify: `src/shared/types/ipc.types.ts` (add channel constant)
- Modify: `src/main/remote-node/worker-node-connection.ts` (broadcast events)
- Modify: `src/main/remote-node/worker-node-registry.ts` (wire event forwarding)

- [ ] **Step 1: Add IPC channel constant**

In `src/shared/types/ipc.types.ts`, find the `REMOTE_NODE_EVENT` constant and add below it:

```typescript
REMOTE_NODE_NODES_CHANGED: 'remote-node:nodes-changed',
```

- [ ] **Step 2: Add broadcast method to connection server**

In `src/main/remote-node/worker-node-connection.ts`, add a method to broadcast node list to the renderer. Find the class body and add:

```typescript
broadcastNodesToRenderer(nodes: WorkerNodeInfo[]): void {
  try {
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED, nodes);
    }
  } catch {
    // Not in Electron context (e.g., tests)
  }
}
```

Add the necessary imports at the top:

```typescript
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
```

- [ ] **Step 3: Wire registry events to broadcast**

In `src/main/remote-node/worker-node-connection.ts`, in the `start()` method (after the server begins listening), subscribe to registry events:

```typescript
const registry = getWorkerNodeRegistry();
const broadcastAll = () => this.broadcastNodesToRenderer(registry.getAllNodes());
registry.on('node:connected', broadcastAll);
registry.on('node:disconnected', broadcastAll);
registry.on('node:updated', broadcastAll);
```

Store the cleanup function so `stop()` can remove the listeners.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Commit**

```
git add src/shared/types/ipc.types.ts src/main/remote-node/worker-node-connection.ts
git commit -m "feat(remote-nodes): broadcast nodes-changed IPC events to renderer"
```

---

### Task 5: Add Preload Listener for `nodes-changed`

**Files:**
- Modify: `src/preload/preload.ts`

- [ ] **Step 1: Add onRemoteNodeNodesChanged listener**

In `src/preload/preload.ts`, find the existing `onRemoteNodeEvent` listener (line ~2764) and add below it, following the same pattern:

```typescript
onRemoteNodeNodesChanged: (callback: (nodes: unknown) => void): (() => void) => {
  const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
  ipcRenderer.on(IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED, handler);
  return () => ipcRenderer.removeListener(IPC_CHANNELS.REMOTE_NODE_NODES_CHANGED, handler);
},
```

- [ ] **Step 2: Add the IPC channel string**

Find where `REMOTE_NODE_EVENT` is defined in the preload's local `IPC_CHANNELS` object and add:

```typescript
REMOTE_NODE_NODES_CHANGED: 'remote-node:nodes-changed',
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 4: Commit**

```
git add src/preload/preload.ts
git commit -m "feat(remote-nodes): add preload listener for nodes-changed events"
```

---

### Task 6: Create `RemoteNodeStore`

**Files:**
- Create: `src/renderer/app/core/state/remote-node.store.ts`
- Modify: `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts` (add onNodesChanged)

- [ ] **Step 1: Add onNodesChanged to IPC service**

In `src/renderer/app/core/services/ipc/remote-node-ipc.service.ts`, add a new method after `onNodeEvent`:

```typescript
onNodesChanged(callback: (nodes: WorkerNodeInfo[]) => void): () => void {
  if (!this.api) return () => {};
  return this.api.onRemoteNodeNodesChanged(callback as (nodes: unknown) => void);
}
```

- [ ] **Step 2: Create RemoteNodeStore**

Create `src/renderer/app/core/state/remote-node.store.ts`:

```typescript
import { Injectable, signal, computed, inject } from '@angular/core';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';
import { RemoteNodeIpcService } from '../services/ipc/remote-node-ipc.service';

@Injectable({ providedIn: 'root' })
export class RemoteNodeStore {
  private readonly ipc = inject(RemoteNodeIpcService);
  private readonly _nodes = signal<WorkerNodeInfo[]>([]);
  private unsubscribe: (() => void) | null = null;

  /** All known nodes (connected, degraded, disconnected). */
  readonly nodes = this._nodes.asReadonly();

  /** Only nodes with status === 'connected'. */
  readonly connectedNodes = computed(() =>
    this._nodes().filter(n => n.status === 'connected'),
  );

  /** True when at least one node exists (any status). */
  readonly hasNodes = computed(() => this._nodes().length > 0);

  /** Look up a node by ID. Returns undefined if not found. */
  nodeById(id: string): WorkerNodeInfo | undefined {
    return this._nodes().find(n => n.id === id);
  }

  /** Seed from IPC and subscribe to live updates. Call once on app init. */
  async initialize(): Promise<void> {
    const nodes = await this.ipc.listNodes();
    this._nodes.set(nodes);

    this.unsubscribe = this.ipc.onNodesChanged((nodes) => {
      this._nodes.set(nodes);
    });
  }

  /** Cleanup subscription. */
  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
```

- [ ] **Step 3: Initialize store on app startup**

Find where other stores are initialized on app startup (check `app.component.ts` or `app.config.ts` for store init patterns). Add `RemoteNodeStore.initialize()` alongside existing store initializations. The exact location depends on the app bootstrap pattern — look for `SettingsStore.initialize()` or similar calls and add `remoteNodeStore.initialize()` next to it.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 5: Lint**

Run: `npx eslint src/renderer/app/core/state/remote-node.store.ts src/renderer/app/core/services/ipc/remote-node-ipc.service.ts`
Expected: Clean.

- [ ] **Step 6: Commit**

```
git add src/renderer/app/core/state/remote-node.store.ts src/renderer/app/core/services/ipc/remote-node-ipc.service.ts
git commit -m "feat(remote-nodes): add reactive RemoteNodeStore with push-based updates"
```

---

### Task 7: Create `NodePickerComponent`

**Files:**
- Create: `src/renderer/app/shared/components/node-picker/node-picker.component.ts`

- [ ] **Step 1: Create the component**

Create `src/renderer/app/shared/components/node-picker/node-picker.component.ts`:

```typescript
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
import { SettingsStore } from '../../../core/state/settings.store';
import type { WorkerNodeInfo } from '../../../../../shared/types/worker-node.types';

@Component({
  standalone: true,
  selector: 'app-node-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isVisible()) {
      <div class="node-picker" [class.open]="isOpen()">
        <button
          class="node-picker-trigger"
          type="button"
          (click)="toggleOpen()"
          [title]="selectedTooltip()"
        >
          <span class="node-health-dot" [class]="selectedHealthClass()"></span>
          <span class="node-picker-label">{{ selectedLabel() }}</span>
          <span class="node-picker-caret">▾</span>
        </button>

        @if (isOpen()) {
          <div class="node-picker-dropdown">
            <button
              class="node-option"
              [class.selected]="!selectedNodeId()"
              type="button"
              (click)="selectNode(null)"
            >
              <span class="node-health-dot health-local"></span>
              <div class="node-option-content">
                <span class="node-option-name">Local</span>
                <span class="node-option-detail">This machine</span>
              </div>
            </button>

            @if (sortedNodes().length > 0) {
              <div class="node-option-separator"></div>
            }

            @for (node of sortedNodes(); track node.id) {
              <button
                class="node-option"
                [class.selected]="selectedNodeId() === node.id"
                [class.disabled]="!isNodeSelectable(node)"
                [disabled]="!isNodeSelectable(node)"
                [title]="nodeDisabledReason(node)"
                type="button"
                (click)="selectNode(node.id)"
              >
                <span class="node-health-dot" [class]="healthClass(node)"></span>
                <div class="node-option-content">
                  <span class="node-option-name">{{ node.name }}</span>
                  <span class="node-option-detail">{{ nodeSubtitle(node) }}</span>
                </div>
                @if (node.latencyMs != null) {
                  <span class="node-option-latency">{{ node.latencyMs }}ms</span>
                }
              </button>
            }
          </div>

          <button
            type="button"
            class="node-picker-backdrop"
            aria-label="Close node picker"
            (click)="isOpen.set(false)"
          ></button>
        }
      </div>
    }
  `,
  styles: [`
    .node-picker { position: relative; display: inline-flex; }

    .node-picker-trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);
      white-space: nowrap;
    }

    .node-picker-trigger:hover { border-color: var(--border-light); }

    .node-picker-caret { font-size: 10px; color: var(--text-muted); }

    .node-picker-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 100;
      min-width: 280px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,0.3));
      padding: 4px;
      display: flex;
      flex-direction: column;
    }

    .node-option {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      border-radius: var(--radius-sm);
      text-align: left;
      width: 100%;
    }

    .node-option:hover:not(:disabled) { background: var(--bg-hover); }
    .node-option.selected { background: var(--bg-hover); }
    .node-option.disabled { opacity: 0.4; cursor: not-allowed; }

    .node-option-content { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .node-option-name { font-weight: 500; }
    .node-option-detail { font-size: 11px; color: var(--text-muted); }
    .node-option-latency { font-size: 11px; color: var(--text-muted); font-family: var(--font-mono, monospace); }

    .node-option-separator {
      height: 1px;
      background: var(--border-color);
      margin: 4px 0;
    }

    .node-health-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .health-connected { background: var(--success-color, #22c55e); }
    .health-degraded { background: #eab308; }
    .health-disconnected { background: var(--text-muted, #6b7280); }
    .health-local { background: var(--primary-color, #3b82f6); }

    .node-picker-backdrop {
      position: fixed;
      inset: 0;
      z-index: 99;
      background: transparent;
      border: none;
      cursor: default;
    }
  `],
})
export class NodePickerComponent {
  private readonly nodeStore = inject(RemoteNodeStore);
  private readonly settingsStore = inject(SettingsStore);

  /** Currently selected node ID (null = local). */
  selectedNodeId = input<string | null>(null);

  /** Currently selected CLI provider, for capability gating. */
  selectedCli = input<string>('auto');

  /** Emits when user picks a node (or null for local). */
  nodeSelected = output<string | null>();

  isOpen = signal(false);

  /** Only show picker when remote nodes feature is enabled and nodes exist. */
  readonly isVisible = computed(() =>
    this.settingsStore.remoteNodesEnabled() && this.nodeStore.hasNodes(),
  );

  /** All nodes sorted: connected first, then degraded, then disconnected. */
  readonly sortedNodes = computed(() => {
    const order = { connected: 0, degraded: 1, connecting: 2, disconnected: 3 };
    return [...this.nodeStore.nodes()].sort(
      (a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9),
    );
  });

  readonly selectedLabel = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return 'Local';
    const node = this.nodeStore.nodeById(id);
    return node?.name ?? id.slice(0, 8);
  });

  readonly selectedHealthClass = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return 'health-local';
    const node = this.nodeStore.nodeById(id);
    if (!node) return 'health-disconnected';
    return 'health-' + node.status;
  });

  readonly selectedTooltip = computed(() => {
    const id = this.selectedNodeId();
    if (!id) return 'Running on this machine';
    const node = this.nodeStore.nodeById(id);
    if (!node) return 'Node not found';
    return `Running on ${node.name} (${node.capabilities.platform})`;
  });

  toggleOpen(): void {
    this.isOpen.set(!this.isOpen());
  }

  selectNode(nodeId: string | null): void {
    this.nodeSelected.emit(nodeId);
    this.isOpen.set(false);
  }

  isNodeSelectable(node: WorkerNodeInfo): boolean {
    if (node.status !== 'connected' && node.status !== 'degraded') return false;
    const cli = this.selectedCli();
    if (cli === 'auto') return true;
    return node.capabilities.supportedClis.includes(cli as never);
  }

  nodeDisabledReason(node: WorkerNodeInfo): string {
    if (node.status === 'disconnected') return 'Node is disconnected';
    if (node.status === 'connecting') return 'Node is connecting...';
    const cli = this.selectedCli();
    if (cli !== 'auto' && !node.capabilities.supportedClis.includes(cli as never)) {
      return `${cli} CLI not installed on this node`;
    }
    return '';
  }

  healthClass(node: WorkerNodeInfo): string {
    return 'health-' + node.status;
  }

  nodeSubtitle(node: WorkerNodeInfo): string {
    const caps = node.capabilities;
    const parts: string[] = [];

    const platformLabel = caps.platform === 'win32' ? 'Win32' : caps.platform === 'darwin' ? 'macOS' : 'Linux';
    parts.push(platformLabel);

    if (caps.gpuName) parts.push('GPU');
    if (caps.hasBrowserRuntime) parts.push('Chrome');
    if (caps.hasDocker) parts.push('Docker');
    parts.push(`${caps.supportedClis.length} CLI${caps.supportedClis.length !== 1 ? 's' : ''}`);

    return parts.join(' \u00b7 ');
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: Clean.

- [ ] **Step 3: Lint**

Run: `npx eslint src/renderer/app/shared/components/node-picker/node-picker.component.ts`
Expected: Clean.

- [ ] **Step 4: Commit**

```
git add src/renderer/app/shared/components/node-picker/node-picker.component.ts
git commit -m "feat(remote-nodes): add NodePickerComponent with capability gating"
```

---

### Task 8: Integrate Node Picker into Session Creation

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-welcome.component.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts` (or wherever sendMessage is handled)

- [ ] **Step 1: Add node picker to welcome component template**

In `src/renderer/app/features/instance-detail/instance-welcome.component.ts`, find the working directory section (around line 46) and add the node picker below it, before the `<div class="welcome-input-shell">` (around line 83):

```html
<div class="welcome-node-wrapper">
  <app-node-picker
    [selectedNodeId]="selectedNodeId()"
    [selectedCli]="selectedProvider()"
    (nodeSelected)="onNodeSelected($event)"
  />
</div>
```

- [ ] **Step 2: Add imports and signals to welcome component class**

Add to the imports array:

```typescript
import { NodePickerComponent } from '../../shared/components/node-picker/node-picker.component';
```

Add `NodePickerComponent` to the component's `imports` array.

Add to the class body:

```typescript
selectedNodeId = signal<string | null>(null);
selectedProvider = input<string>('auto');
nodeChange = output<string | null>();

onNodeSelected(nodeId: string | null): void {
  this.selectedNodeId.set(nodeId);
  this.nodeChange.emit(nodeId);
}
```

- [ ] **Step 3: Wire forceNodeId through the creation flow**

In the parent component that handles `sendMessage` from the welcome component (likely `instance-detail.component.ts` or wherever `createInstanceWithMessage` is called), pass the selected `forceNodeId` to the store's `createInstance()` call. Find where `createInstanceWithMessage` or `createInstance` is called and add `forceNodeId` from the welcome component's signal.

The exact wiring depends on how the parent handles the event — look for `sendMessage.emit` handling and add `forceNodeId` to the config object.

- [ ] **Step 4: Add submit-time validation**

In the parent component's send handler, before calling `createInstance`, add validation:

```typescript
if (forceNodeId) {
  const node = this.remoteNodeStore.nodeById(forceNodeId);
  if (!node || (node.status !== 'connected' && node.status !== 'degraded')) {
    // Show error toast or set error signal
    this.error.set(`Node '${node?.name ?? forceNodeId.slice(0, 8)}' disconnected. Please select another node or use Local.`);
    return;
  }
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/renderer/app/features/instance-detail/instance-welcome.component.ts`
Expected: Clean.

- [ ] **Step 6: Commit**

```
git add src/renderer/app/features/instance-detail/
git commit -m "feat(remote-nodes): integrate node picker into session creation flow"
```

---

### Task 9: Update Instance Row Badge

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-row.component.ts:115-119, 661-668`

- [ ] **Step 1: Inject RemoteNodeStore**

In the `instance-row.component.ts` class, add:

```typescript
private readonly remoteNodeStore = inject(RemoteNodeStore);
```

Add the import:

```typescript
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
```

- [ ] **Step 2: Add node name and status computed signals**

Replace the existing `remoteNodeId` computed (lines 665-668) and add new computeds:

```typescript
readonly remoteNodeId = computed(() => {
  const loc = this.instance().executionLocation;
  return loc?.type === 'remote' ? loc.nodeId : '';
});

readonly remoteNodeName = computed(() => {
  const nodeId = this.remoteNodeId();
  if (!nodeId) return '';
  const node = this.remoteNodeStore.nodeById(nodeId);
  return node?.name ?? nodeId.slice(0, 8);
});

readonly remoteNodeDisconnected = computed(() => {
  const nodeId = this.remoteNodeId();
  if (!nodeId) return false;
  const node = this.remoteNodeStore.nodeById(nodeId);
  return !node || (node.status !== 'connected' && node.status !== 'degraded');
});
```

- [ ] **Step 3: Update template**

Replace the remote badge template (lines 115-119):

```html
@if (isRemote()) {
  <span
    class="remote-badge"
    [class.remote-badge-warning]="remoteNodeDisconnected()"
    [title]="remoteNodeDisconnected()
      ? 'Node \'' + remoteNodeName() + '\' disconnected — session may be interrupted'
      : 'Running on node: ' + remoteNodeName()"
  >
    {{ remoteNodeName() }}
  </span>
}
```

- [ ] **Step 4: Add warning style**

Add to the component's styles:

```css
.remote-badge-warning {
  background: rgba(234, 179, 8, 0.15) !important;
  color: #eab308 !important;
  border-color: rgba(234, 179, 8, 0.3) !important;
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/renderer/app/features/instance-list/instance-row.component.ts`
Expected: Clean.

- [ ] **Step 6: Commit**

```
git add src/renderer/app/features/instance-list/instance-row.component.ts
git commit -m "feat(remote-nodes): show node name in instance row badge with disconnect warning"
```

---

### Task 10: Add Location Filter to Instance List

**Files:**
- Modify: `src/renderer/app/features/instance-list/instance-list.component.ts`

- [ ] **Step 1: Add filter signal and inject store**

In `instance-list.component.ts`, add to the class:

```typescript
private readonly remoteNodeStore = inject(RemoteNodeStore);
locationFilter = signal<'all' | 'local' | 'remote'>('all');
```

Add the import:

```typescript
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
```

- [ ] **Step 2: Add filter toggle to template**

Find the filter bar in the template (around line 92). Add a location filter inside the `.filter-controls` div, after the existing status filter:

```html
@if (remoteNodeStore.hasNodes()) {
  <label class="filter-select-group">
    <span class="filter-select-label">Location</span>
    <select
      class="status-filter"
      [value]="locationFilter()"
      (change)="onLocationFilterChange($event)"
    >
      <option value="all">All</option>
      <option value="local">Local</option>
      <option value="remote">Remote</option>
    </select>
  </label>
}
```

- [ ] **Step 3: Add event handler**

Add to the class:

```typescript
onLocationFilterChange(event: Event): void {
  this.locationFilter.set((event.target as HTMLSelectElement).value as 'all' | 'local' | 'remote');
}
```

- [ ] **Step 4: Apply filter to instance list**

Find the `projectGroups` computed (around line 1330). Inside the filtering logic where instances are filtered by `status`, add location filtering:

```typescript
// After status filtering, add location filtering:
const location = this.locationFilter();
const locationFiltered = location === 'all'
  ? statusFiltered
  : location === 'remote'
    ? statusFiltered.filter(i => i.executionLocation?.type === 'remote')
    : statusFiltered.filter(i => !i.executionLocation || i.executionLocation.type === 'local');
```

Then use `locationFiltered` instead of `statusFiltered` for the rest of the computed.

- [ ] **Step 5: Update isDragDisabled computed**

Update `isDragDisabled` to also disable drag when location filter is active:

```typescript
isDragDisabled = computed(() =>
  this.filterText().length > 0 || this.statusFilter() !== 'all' || this.locationFilter() !== 'all'
);
```

Same for `isProjectDragDisabled`.

- [ ] **Step 6: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/renderer/app/features/instance-list/instance-list.component.ts`
Expected: Clean.

- [ ] **Step 7: Commit**

```
git add src/renderer/app/features/instance-list/instance-list.component.ts
git commit -m "feat(remote-nodes): add All/Local/Remote filter toggle to instance list"
```

---

### Task 11: Add Node Badge and Tooltip to Instance Header

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-header.component.ts`

- [ ] **Step 1: Inject RemoteNodeStore and add computed signals**

In `instance-header.component.ts`, add:

```typescript
private readonly remoteNodeStore = inject(RemoteNodeStore);
```

Add the import:

```typescript
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
```

Add computed signals:

```typescript
readonly isRemote = computed(() =>
  this.instance().executionLocation?.type === 'remote',
);

readonly remoteNodeId = computed(() => {
  const loc = this.instance().executionLocation;
  return loc?.type === 'remote' ? loc.nodeId : null;
});

readonly remoteNode = computed(() => {
  const id = this.remoteNodeId();
  return id ? this.remoteNodeStore.nodeById(id) ?? null : null;
});

readonly remoteNodeName = computed(() =>
  this.remoteNode()?.name ?? this.remoteNodeId()?.slice(0, 8) ?? '',
);

readonly remoteNodeDisconnected = computed(() => {
  const node = this.remoteNode();
  return this.isRemote() && (!node || (node.status !== 'connected' && node.status !== 'degraded'));
});

readonly remoteNodeTooltip = computed(() => {
  const node = this.remoteNode();
  if (!node) return `Node ${this.remoteNodeId()?.slice(0, 8)} — no longer registered`;
  const caps = node.capabilities;
  const platform = caps.platform === 'win32' ? 'Windows' : caps.platform === 'darwin' ? 'macOS' : 'Linux';
  const lines = [
    node.name,
    `Platform: ${platform} (${caps.arch})`,
    `Latency: ${node.latencyMs != null ? node.latencyMs + 'ms' : 'unknown'}`,
    `CPU: ${caps.cpuCores} cores`,
    `Memory: ${caps.availableMemoryMB != null ? (caps.availableMemoryMB / 1024).toFixed(1) : '?'} / ${(caps.totalMemoryMB / 1024).toFixed(1)} GB`,
  ];
  if (caps.gpuName) lines.push(`GPU: ${caps.gpuName}${caps.gpuMemoryMB ? ' (' + (caps.gpuMemoryMB / 1024).toFixed(0) + ' GB)' : ''}`);
  lines.push(`CLIs: ${caps.supportedClis.join(', ')}`);
  lines.push(`Sessions: ${node.activeInstances} active`);
  lines.push(`Status: ${node.status}`);
  return lines.join('\n');
});
```

- [ ] **Step 2: Add badge to template**

Find the `.instance-meta` div in the template (around line 155). After the `provider-badge` span (around line 160), add:

```html
@if (isRemote()) {
  <span
    class="node-badge"
    [class.node-badge-warning]="remoteNodeDisconnected()"
    [title]="remoteNodeTooltip()"
  >
    {{ remoteNodeName() }}
  </span>
}
```

- [ ] **Step 3: Add styles**

Add to the component's styles:

```css
.node-badge {
  padding: 2px 8px;
  border-radius: var(--radius-sm, 4px);
  font-size: 11px;
  font-weight: 500;
  background: rgba(59, 130, 246, 0.15);
  color: #60a5fa;
  border: 1px solid rgba(59, 130, 246, 0.3);
  cursor: help;
  white-space: pre-line;
}

.node-badge-warning {
  background: rgba(234, 179, 8, 0.15);
  color: #eab308;
  border-color: rgba(234, 179, 8, 0.3);
}
```

- [ ] **Step 4: Add loading state for remote creation**

In the template, find the `.name-row` div (around line 44). Add a loading indicator that shows when the instance is remote and in `initializing` status:

```html
@if (isRemote() && instance().status === 'initializing') {
  <span class="remote-connecting">Connecting to {{ remoteNodeName() }}...</span>
}
```

Add the style:

```css
.remote-connecting {
  font-size: 11px;
  color: var(--text-muted);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npx eslint src/renderer/app/features/instance-detail/instance-header.component.ts`
Expected: Clean.

- [ ] **Step 6: Commit**

```
git add src/renderer/app/features/instance-detail/instance-header.component.ts
git commit -m "feat(remote-nodes): add node badge with rich tooltip to instance header"
```

---

### Task 12: Final Verification

- [ ] **Step 1: Full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: Clean.

- [ ] **Step 2: Full lint**

Run: `npm run lint`
Expected: Clean.

- [ ] **Step 3: Run tests**

Run: `npm run test`
Expected: All pass.

- [ ] **Step 4: Manual smoke test**

Start the app with `npm run dev` and verify:
1. Settings > Remote Nodes tab works (no regressions)
2. Session creation shows "Local" node picker (or hides it if remote nodes disabled)
3. Instance list sidebar shows correctly
4. Instance header shows provider badge without extra node badge for local sessions
