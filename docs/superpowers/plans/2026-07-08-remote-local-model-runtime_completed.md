# Remote Local Model Runtime Implementation Plan

**Status (2026-07-10):** Automated implementation and the full verification
suite are complete. The streamed-message identity and delta-aggregation fixes
have been deployed to `windows-pc`, and a fresh worker start/connection proves
the replacement is live. Do not rename `_completed` until Task 12 Step 4's
visible two-turn and endpoint-stop checks are rerun.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make worker-local and coordinator-local Ollama/LM Studio models visible in Harness and selectable as first-class session runtimes.

**Architecture:** Keep CLI providers and local model endpoints separate. Add a typed local-model runtime target, a sanitized coordinator inventory, catalog rows for discovery, picker/draft support for selection, and dedicated local/remote local-model adapters for multi-turn chat sessions. Existing Claude/Codex/Cursor/Gemini/Antigravity/Copilot session behavior stays on the current CLI path when no local-model target is present.

**Tech Stack:** Electron main-process TypeScript, Angular 21 standalone components and signals, Zod IPC/RPC validation, Vitest, existing remote worker WebSocket/RPC infrastructure, Ollama `/api/chat`, OpenAI-compatible `/v1/chat/completions`.

## Global Constraints

- Do not overload `CanonicalCliType` with local model endpoint runtimes.
- Do not expose worker loopback URLs, transport tokens, pairing tokens, or API keys to renderer UI, tests, logs, docs, or diagnostics.
- Existing CLI session behavior must be unchanged when `modelRuntimeTarget` is absent.
- Worker-local endpoints must be accessed through worker RPC; the coordinator must not dial a worker's `127.0.0.1` endpoint directly.
- Model IDs are not globally unique; every local-model selection must include source, endpoint provider, model ID, and node ID when remote.
- Follow project completion gates: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, targeted specs, and a final `npm run test:quiet`.
- Do not commit unless James explicitly asks. At task checkpoints, report `git status --short` and the relevant verification output instead of creating commits.

---

## File Structure

Create:

- `src/shared/types/local-model-runtime.types.ts` - shared selector, inventory, runtime target, and runtime summary types.
- `src/main/local-models/local-model-selector.ts` - stable selector ID encode/decode helpers.
- `src/main/local-models/local-model-inventory-service.ts` - sanitized inventory built from coordinator-local probes and remote worker roster data.
- `src/main/local-models/__tests__/local-model-selector.spec.ts` - selector round-trip and invalid selector tests.
- `src/main/local-models/__tests__/local-model-inventory-service.spec.ts` - inventory construction and target resolution tests.
- `src/main/cli/adapters/local-model-chat-adapter.ts` - shared local-model adapter contract/helpers.
- `src/main/cli/adapters/openai-compatible-chat-adapter.ts` - OpenAI-compatible chat completions adapter for LM Studio and similar endpoints.
- `src/main/cli/adapters/remote-local-model-adapter.ts` - coordinator adapter that proxies local-model sessions to a worker.
- `src/worker-agent/local-model-session-manager.ts` - worker-side session manager for remote local-model chat sessions.
- `src/worker-agent/__tests__/local-model-session-manager.spec.ts` - worker session start/send/terminate tests.

Modify:

- `src/shared/types/worker-node.types.ts` - preserve loaded local-model metadata and add optional endpoint IDs.
- `src/main/remote-node/rpc-schemas.ts` - validate `loadedModels` and add `localModel.session.*` RPC schemas.
- `src/worker-agent/capability-reporter.ts` - keep endpoint identity stable and preserve loaded context metadata.
- `src/main/remote-node/remote-node-roster-service.ts` - preserve sanitized local model capability data in roster entries.
- `src/main/remote-node/worker-node-rpc.ts` and `src/worker-agent/worker-rpc-dispatcher.ts` - route local-model session RPC methods.
- `src/main/providers/unified-model-catalog-service.ts` - add local-model source rows.
- `src/shared/types/unified-model-catalog.types.ts` - add `local-model` catalog source.
- `src/main/ipc/handlers/provider-handlers.ts` - expose inventory through model/catalog IPC and push updates.
- `src/preload/domains/provider.preload.ts` and `src/renderer/app/core/services/ipc/provider-ipc.service.ts` - renderer API for local model inventory.
- `src/renderer/app/features/models/unified-catalog.store.ts` - consume local-model catalog rows.
- `src/renderer/app/features/models/compact-model-picker.types.ts` - add local-model picker/runtime target selection shape.
- `src/renderer/app/features/models/provider-menu.constants.ts` - add `Local Models` provider label/color.
- `src/renderer/app/features/models/compact-model-picker.component.ts` and `src/renderer/app/features/models/model-selection-panel.component.ts` - render and emit local-model selections.
- `src/renderer/app/core/services/new-session-draft.types.ts` and `src/renderer/app/core/services/new-session-draft.service.ts` - persist draft runtime target state.
- `src/shared/types/instance.types.ts` - add `modelRuntimeTarget` and `runtimeSummary`.
- `src/main/instance/lifecycle/execution-location-resolver.ts` - validate local-model execution location.
- `src/main/instance/lifecycle/instance-create-builder.ts` - seed local-model current model and runtime summary.
- `src/main/instance/instance-lifecycle.ts` - spawn local-model adapters when requested.
- `src/main/instance/instance-manager-logging.ts` - sanitize runtime target logs.
- `src/main/ipc/handlers/session-handlers.ts` and `src/shared/validation/ipc-schemas.ts` - validate and forward runtime target create payloads.
- `src/renderer/app/core/state/instance/instance.types.ts`, `src/renderer/app/core/state/instance/instance-list.store.ts`, and `src/renderer/app/core/services/ipc/instance-ipc.service.ts` - renderer create payload/runtime summary typing.
- `src/renderer/app/features/remote-nodes/node-card.component.ts` and `src/renderer/app/features/remote-nodes/node-detail.component.ts` - show local model endpoint inventory.
- `src/renderer/app/shared/components/node-picker/node-picker.component.ts` - treat selected local-model targets as node-scoped eligibility.
- Focused specs beside the modified files.

---

## Task 1: Preserve Worker Local Model Capability Metadata

**Files:**

- Modify: `src/shared/types/worker-node.types.ts`
- Modify: `src/main/remote-node/rpc-schemas.ts`
- Modify: `src/worker-agent/capability-reporter.ts`
- Modify: `src/main/remote-node/remote-node-roster-service.ts`
- Test: `src/main/remote-node/remote-node-roster-service.spec.ts`
- Test: `src/worker-agent/capability-reporter.spec.ts`

**Interfaces:**

- Produces: `WorkerLocalModelCapability.endpointId?: string` and preserved `loadedModels`.
- Consumes: Existing worker heartbeat capability payloads.

- [x] **Step 1: Write failing schema and roster tests**

Add a test payload containing LM Studio loaded model context:

```ts
const localModelEndpoints = [{
  provider: 'openai-compatible',
  endpointId: 'lm-studio',
  baseUrl: 'http://127.0.0.1:1234',
  models: ['qwen2.5-coder-32b-instruct'],
  loadedModels: [{ id: 'qwen2.5-coder-32b-instruct', contextLength: 32768 }],
  healthy: true,
}];
```

Assert `RemoteNodeRegisterPayloadSchema.parse(...)` keeps `endpointId` and `loadedModels`, then assert `RemoteNodeRosterService.list()` returns the same loaded model ID and context length.

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm run test:quiet -- src/main/remote-node/remote-node-roster-service.spec.ts src/worker-agent/capability-reporter.spec.ts
```

Expected: fail because the RPC schema does not preserve `loadedModels` and endpoint identity is not stable.

- [x] **Step 3: Extend the shared capability shape**

In `src/shared/types/worker-node.types.ts`, make this shape explicit:

```ts
export interface WorkerLocalModelCapability {
  provider: 'ollama' | 'openai-compatible';
  endpointId?: string;
  baseUrl: string;
  models: string[];
  loadedModels?: Array<{
    id: string;
    contextLength: number;
  }>;
  healthy: boolean;
}
```

- [x] **Step 4: Update Zod validation**

In `src/main/remote-node/rpc-schemas.ts`, add:

```ts
const WorkerLoadedLocalModelSchema = z.object({
  id: z.string().min(1).max(256),
  contextLength: z.number().int().positive().max(10_000_000),
});

const WorkerLocalModelCapabilitySchema = z.object({
  provider: z.enum(['ollama', 'openai-compatible']),
  endpointId: z.string().min(1).max(128).optional(),
  baseUrl: z.string().min(1).max(2048),
  models: z.array(z.string().min(1).max(256)).max(512),
  loadedModels: z.array(WorkerLoadedLocalModelSchema).max(64).optional(),
  healthy: z.boolean(),
});
```

Use that schema wherever `localModelEndpoints` is parsed.

- [x] **Step 5: Stabilize endpoint IDs at report time**

In `src/worker-agent/capability-reporter.ts`, ensure reported endpoints use deterministic IDs:

```ts
function endpointIdForLocalModelProvider(provider: WorkerLocalModelCapability['provider']): string {
  return provider === 'ollama' ? 'ollama' : 'openai-compatible';
}
```

Set `endpointId` on each reported endpoint and preserve any loaded model context discovered from LM Studio/OpenAI-compatible probing.

- [x] **Step 6: Run focused tests**

Run:

```bash
npm run test:quiet -- src/main/remote-node/remote-node-roster-service.spec.ts src/worker-agent/capability-reporter.spec.ts
```

Expected: pass.

- [x] **Step 7: Check worktree**

Run:

```bash
git status --short
```

Expected: only Task 1 files changed, plus pre-existing untracked docs.

## Task 2: Add Shared Local Model Runtime Types And Selector Helpers

**Files:**

- Create: `src/shared/types/local-model-runtime.types.ts`
- Create: `src/main/local-models/local-model-selector.ts`
- Create: `src/main/local-models/__tests__/local-model-selector.spec.ts`
- Modify: `src/shared/types/instance.types.ts`

**Interfaces:**

- Produces: `LocalModelSelectorId`, `LocalModelInventoryEntry`, `ModelRuntimeTarget`, `InstanceRuntimeSummary`.
- Consumes: `WorkerLocalModelCapability` and `ExecutionLocation`.

- [x] **Step 1: Write failing selector tests**

Create tests:

```ts
it('round-trips worker local model selector IDs', () => {
  const id = encodeLocalModelSelector({
    source: 'worker-node',
    nodeId: 'node/windows pc',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId: 'qwen2.5-coder:14b',
  });

  expect(id).toBe('lm://worker-node/node%2Fwindows%20pc/ollama/ollama/qwen2.5-coder%3A14b');
  expect(decodeLocalModelSelector(id)).toEqual({
    source: 'worker-node',
    nodeId: 'node/windows pc',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId: 'qwen2.5-coder:14b',
  });
});

it('rejects non-local-model selectors', () => {
  expect(() => decodeLocalModelSelector('http://127.0.0.1:11434')).toThrow('Invalid local model selector');
});
```

- [x] **Step 2: Run selector tests and verify failure**

Run:

```bash
npm run test:quiet -- src/main/local-models/__tests__/local-model-selector.spec.ts
```

Expected: fail because the files do not exist.

- [x] **Step 3: Add shared types**

Create `src/shared/types/local-model-runtime.types.ts` with:

```ts
export type LocalModelEndpointProvider = 'ollama' | 'openai-compatible';
export type LocalModelSource = 'this-device' | 'worker-node';
export type LocalModelSelectorId = string;

export interface LocalModelLoadedModel {
  id: string;
  contextLength: number;
}

export interface LocalModelInventoryEntry {
  selectorId: LocalModelSelectorId;
  source: LocalModelSource;
  endpointProvider: LocalModelEndpointProvider;
  endpointId: string;
  modelId: string;
  displayName: string;
  nodeId?: string;
  nodeName?: string;
  platform?: string;
  healthy: boolean;
  loaded: boolean;
  loadedContextLength?: number;
  advertisedContextLength?: number;
  capabilities: {
    streaming: boolean;
    multiTurn: boolean;
    toolUse: 'none' | 'probable' | 'verified';
    vision: 'unknown' | 'no' | 'yes';
  };
  discoveredAt: number;
}

export type ModelRuntimeTarget =
  | { kind: 'cli'; provider?: import('./provider.types').InstanceProvider }
  | {
      kind: 'local-model';
      source: LocalModelSource;
      endpointProvider: LocalModelEndpointProvider;
      endpointId: string;
      modelId: string;
      selectorId: LocalModelSelectorId;
      nodeId?: string;
    };

export interface InstanceRuntimeSummary {
  kind: 'cli' | 'local-model';
  label: string;
  nodeId?: string;
  nodeName?: string;
  endpointProvider?: LocalModelEndpointProvider;
  modelId?: string;
}
```

- [x] **Step 4: Add selector helpers**

Create `src/main/local-models/local-model-selector.ts`:

```ts
import type { LocalModelEndpointProvider, LocalModelSource } from '../../shared/types/local-model-runtime.types';

export interface DecodedLocalModelSelector {
  source: LocalModelSource;
  nodeId?: string;
  endpointProvider: LocalModelEndpointProvider;
  endpointId: string;
  modelId: string;
}

export function encodeLocalModelSelector(input: DecodedLocalModelSelector): string {
  const parts = input.source === 'worker-node'
    ? ['lm:', '', 'worker-node', encode(input.nodeId ?? ''), input.endpointProvider, encode(input.endpointId), encode(input.modelId)]
    : ['lm:', '', 'this-device', input.endpointProvider, encode(input.endpointId), encode(input.modelId)];
  return parts.join('/');
}

export function decodeLocalModelSelector(value: string): DecodedLocalModelSelector {
  const parts = value.split('/');
  if (parts[0] !== 'lm:' || parts[1] !== '') {
    throw new Error('Invalid local model selector');
  }
  if (parts[2] === 'worker-node' && parts.length === 7) {
    return {
      source: 'worker-node',
      nodeId: decode(parts[3]),
      endpointProvider: parseEndpointProvider(parts[4]),
      endpointId: decode(parts[5]),
      modelId: decode(parts[6]),
    };
  }
  if (parts[2] === 'this-device' && parts.length === 6) {
    return {
      source: 'this-device',
      endpointProvider: parseEndpointProvider(parts[3]),
      endpointId: decode(parts[4]),
      modelId: decode(parts[5]),
    };
  }
  throw new Error('Invalid local model selector');
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function decode(value: string): string {
  return decodeURIComponent(value);
}

function parseEndpointProvider(value: string): LocalModelEndpointProvider {
  if (value === 'ollama' || value === 'openai-compatible') return value;
  throw new Error('Invalid local model selector');
}
```

- [x] **Step 5: Extend instance types additively**

In `src/shared/types/instance.types.ts`, import and add optional fields:

```ts
import type { InstanceRuntimeSummary, ModelRuntimeTarget } from './local-model-runtime.types';
```

Then add to `InstanceCreateConfig`:

```ts
modelRuntimeTarget?: ModelRuntimeTarget;
```

And add to `Instance`:

```ts
runtimeSummary?: InstanceRuntimeSummary;
```

- [x] **Step 6: Run focused tests and typecheck the touched shared files**

Run:

```bash
npm run test:quiet -- src/main/local-models/__tests__/local-model-selector.spec.ts
npx tsc --noEmit
```

Expected: tests pass; typecheck either passes or reports the next task's expected missing consumers if this task is executed without batching.

## Task 3: Build Coordinator Local Model Inventory Service

**Files:**

- Create: `src/main/local-models/local-model-inventory-service.ts`
- Create: `src/main/local-models/__tests__/local-model-inventory-service.spec.ts`
- Modify: `src/main/app/unified-model-catalog-initialization.ts`

**Interfaces:**

- Consumes: `RemoteNodeRosterService.list()`.
- Produces: `LocalModelInventoryService.list()`, `resolveTarget(selectorId)`, and `inventory-updated`.

- [x] **Step 1: Write failing inventory tests**

Add tests for:

```ts
it('builds one inventory row per worker model without exposing baseUrl', () => {
  const svc = new LocalModelInventoryService({ roster: fakeRoster([workerWithOllama]) });
  const rows = svc.list();
  expect(rows[0]).toMatchObject({
    source: 'worker-node',
    endpointProvider: 'ollama',
    modelId: 'qwen2.5-coder:14b',
    nodeName: 'windows-pc',
    healthy: true,
  });
  expect(JSON.stringify(rows)).not.toContain('127.0.0.1');
});

it('resolves a healthy worker model into a runtime target', () => {
  const svc = new LocalModelInventoryService({ roster: fakeRoster([workerWithOllama]) });
  const target = svc.resolveTarget(svc.list()[0].selectorId);
  expect(target).toMatchObject({
    kind: 'local-model',
    source: 'worker-node',
    nodeId: 'node-win',
    endpointProvider: 'ollama',
    modelId: 'qwen2.5-coder:14b',
  });
});
```

- [x] **Step 2: Run inventory tests and verify failure**

Run:

```bash
npm run test:quiet -- src/main/local-models/__tests__/local-model-inventory-service.spec.ts
```

Expected: fail because the service does not exist.

- [x] **Step 3: Implement `LocalModelInventoryService`**

Create a service that normalizes roster entries:

```ts
export class LocalModelInventoryService extends EventEmitter {
  constructor(private readonly deps: { roster: { list(): RemoteNodeRosterEntry[] } }) {
    super();
  }

  list(): LocalModelInventoryEntry[] {
    const now = Date.now();
    return this.deps.roster.list().flatMap((node) => entriesForNode(node, now));
  }

  resolveTarget(selectorId: string): ModelRuntimeTarget {
    const entry = this.list().find((candidate) => candidate.selectorId === selectorId);
    if (!entry || !entry.healthy) {
      throw new Error('Local model is no longer available');
    }
    return {
      kind: 'local-model',
      selectorId: entry.selectorId,
      source: entry.source,
      endpointProvider: entry.endpointProvider,
      endpointId: entry.endpointId,
      modelId: entry.modelId,
      ...(entry.nodeId ? { nodeId: entry.nodeId } : {}),
    };
  }
}
```

`entriesForNode` must derive `loaded` and `loadedContextLength` from `loadedModels`, set `toolUse: 'none'`, set `streaming: true` for Ollama and OpenAI-compatible unless probing proves otherwise, and never include `baseUrl` in returned entries.

- [x] **Step 4: Run inventory tests**

Run:

```bash
npm run test:quiet -- src/main/local-models/__tests__/local-model-inventory-service.spec.ts
```

Expected: pass.

## Task 4: Feed Local Models Into IPC And Unified Catalog

**Files:**

- Modify: `src/shared/types/unified-model-catalog.types.ts`
- Modify: `src/main/providers/unified-model-catalog-service.ts`
- Modify: `src/main/providers/__tests__/unified-model-catalog-service.spec.ts`
- Modify: `src/main/ipc/handlers/provider-handlers.ts`
- Modify: `src/preload/domains/provider.preload.ts`
- Modify: `src/renderer/app/core/services/ipc/provider-ipc.service.ts`
- Modify: `src/renderer/app/features/models/unified-catalog.store.ts`

**Interfaces:**

- Consumes: `LocalModelInventoryService.list()`.
- Produces: provider namespace `local-model`, catalog source `local-model`, and renderer inventory fetch.

- [x] **Step 1: Write failing catalog tests**

Add a test that calls a new catalog method:

```ts
catalog.onLocalModelInventoryRefreshed([{
  selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
  provider: 'local-model',
  modelId: 'qwen',
  displayName: 'qwen on windows-pc',
  discoveredAt: 1783468800000,
}]);
```

Assert `getModelsByProvider('local-model')` returns one entry with source `local-model` and ID equal to the selector ID.

- [x] **Step 2: Run catalog tests and verify failure**

Run:

```bash
npm run test:quiet -- src/main/providers/__tests__/unified-model-catalog-service.spec.ts
```

Expected: fail because `local-model` is not a `CatalogSource` and no refresh method exists.

- [x] **Step 3: Add catalog source and merge layer**

Add `local-model` to `CatalogSource` and `CATALOG_SOURCE_PRIORITY`, store local model rows inside `UnifiedModelCatalogService`, and add:

```ts
onLocalModelInventoryRefreshed(entries: LocalModelInventoryEntry[]): void {
  this.localModelEntries = entries;
  this.localModelLastRefreshedAt = Date.now();
  this.scheduleRebuild('local-model');
}
```

During rebuild, remove old provider `local-model` rows and add entries with:

```ts
{
  id: entry.selectorId,
  provider: 'local-model',
  name: entry.displayName,
  tier: 'balanced',
  family: entry.endpointProvider === 'ollama' ? 'Ollama' : 'OpenAI-compatible',
  contextWindow: entry.loadedContextLength ?? entry.advertisedContextLength,
  source: 'local-model',
  discoveredAt: entry.discoveredAt,
}
```

- [x] **Step 4: Add IPC access**

Add provider IPC methods:

```ts
getLocalModelInventory(): Promise<IpcResponse<{ models: LocalModelInventoryEntry[] }>>;
onLocalModelInventoryUpdated(callback: (payload: { models: LocalModelInventoryEntry[] }) => void): () => void;
```

Wire them through `provider-handlers.ts`, `provider.preload.ts`, and `provider-ipc.service.ts`. Handler responses must not include endpoint `baseUrl`.

- [x] **Step 5: Update renderer catalog display fallback**

In `UnifiedCatalogStore.displayModelsForProvider`, allow `provider === 'local-model'` to use entry `name` directly and skip static curated lookup.

- [x] **Step 6: Run focused tests**

Run:

```bash
npm run test:quiet -- src/main/providers/__tests__/unified-model-catalog-service.spec.ts src/renderer/app/features/models/unified-catalog.store.spec.ts
```

Expected: pass.

## Task 5: Surface Local Models In Remote Nodes UI

**Files:**

- Modify: `src/renderer/app/features/remote-nodes/node-card.component.ts`
- Modify: `src/renderer/app/features/remote-nodes/node-detail.component.ts`
- Test: existing or new specs beside these components.

**Interfaces:**

- Consumes: `RemoteNodeRosterEntry.capabilities.localModelEndpoints`.
- Produces: visible endpoint health, model count, loaded model context.

- [x] **Step 1: Write failing component tests**

Assert a node with Ollama and LM Studio endpoints renders:

```text
2 local models
Ollama
LM Studio
qwen2.5-coder-32b-instruct
32768 ctx
```

- [x] **Step 2: Run component tests and verify failure**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/remote-nodes/node-card.component.spec.ts src/renderer/app/features/remote-nodes/node-detail.component.spec.ts
```

Expected: fail if specs do not exist or if UI does not render local model endpoints.

- [x] **Step 3: Add compact card display**

Render a small local-model line on node cards:

```html
@if (localModelCount(node) > 0) {
  <span class="node-capability">Local models: {{ localModelCount(node) }}</span>
}
```

- [x] **Step 4: Add detail endpoint list**

Render endpoint rows in node detail with provider label, running state, model names, and loaded context:

```html
@for (endpoint of node.capabilities.localModelEndpoints ?? []; track endpoint.endpointId ?? endpoint.provider) {
  <section class="local-model-endpoint">
    <h4>{{ localModelProviderLabel(endpoint.provider) }} - {{ endpoint.healthy ? 'Running' : 'Unavailable' }}</h4>
    @for (model of endpoint.models; track model) {
      <div>{{ model }}{{ loadedContextLabel(endpoint, model) }}</div>
    }
  </section>
}
```

- [x] **Step 5: Run component tests**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/remote-nodes/node-card.component.spec.ts src/renderer/app/features/remote-nodes/node-detail.component.spec.ts
```

Expected: pass.

## Task 6: Add Runtime Target To Draft State And Create Payloads

**Files:**

- Modify: `src/renderer/app/core/services/new-session-draft.types.ts`
- Modify: `src/renderer/app/core/services/new-session-draft.service.ts`
- Modify: `src/renderer/app/core/services/new-session-draft.service.spec.ts`
- Modify: `src/shared/validation/ipc-schemas.ts`
- Modify: `src/main/ipc/handlers/session-handlers.ts`
- Modify: `src/renderer/app/core/state/instance/instance-list.store.ts`
- Modify: `src/renderer/app/core/state/instance/instance.types.ts`
- Modify: `src/renderer/app/core/services/ipc/instance-ipc.service.ts`

**Interfaces:**

- Consumes: `ModelRuntimeTarget`.
- Produces: create instance payload with optional `modelRuntimeTarget`.

- [x] **Step 1: Write failing draft and IPC tests**

Add draft tests for:

```ts
service.setModelRuntimeTarget({
  kind: 'local-model',
  source: 'worker-node',
  selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
  nodeId: 'node-win',
  endpointProvider: 'ollama',
  endpointId: 'ollama',
  modelId: 'qwen',
});
expect(service.snapshot().modelRuntimeTarget?.kind).toBe('local-model');
expect(service.provider()).toBe('auto');
```

Add IPC schema tests that accept local-model targets and reject missing `selectorId`.

- [x] **Step 2: Run focused tests and verify failure**

Run:

```bash
npm run test:quiet -- src/renderer/app/core/services/new-session-draft.service.spec.ts src/main/ipc/handlers/__tests__/session-handlers.spec.ts
```

Expected: fail because draft state and IPC schemas do not know runtime targets.

- [x] **Step 3: Extend draft service**

Add `modelRuntimeTarget` to draft state and methods:

```ts
setModelRuntimeTarget(target: ModelRuntimeTarget | null): void {
  this.patchDraft({
    modelRuntimeTarget: target,
    provider: target?.kind === 'local-model' ? 'auto' : this.draft().provider,
    model: target?.kind === 'local-model' ? target.modelId : this.draft().model,
    remoteNodeId: target?.kind === 'local-model' ? (target.nodeId ?? null) : this.draft().remoteNodeId,
  });
}
```

- [x] **Step 4: Extend IPC schemas**

Add Zod schemas for `ModelRuntimeTarget` in `src/shared/validation/ipc-schemas.ts` and include it in `InstanceCreatePayloadSchema`.

- [x] **Step 5: Forward target through renderer create store and session handlers**

Ensure `InstanceListStore.createInstance` includes `modelRuntimeTarget` in the payload and `session-handlers.ts` forwards it to `InstanceManager.createInstance`.

- [x] **Step 6: Run focused tests**

Run:

```bash
npm run test:quiet -- src/renderer/app/core/services/new-session-draft.service.spec.ts src/main/ipc/handlers/__tests__/session-handlers.spec.ts
```

Expected: pass.

## Task 7: Add Local Models Provider To The Picker

**Files:**

- Modify: `src/renderer/app/features/models/compact-model-picker.types.ts`
- Modify: `src/renderer/app/features/models/provider-menu.constants.ts`
- Modify: `src/renderer/app/features/models/model-picker.controller.ts`
- Modify: `src/renderer/app/features/models/compact-model-picker.component.ts`
- Modify: `src/renderer/app/features/models/model-selection-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/features/instance-detail/composer-toolbar.component.ts`
- Test: `src/renderer/app/features/models/compact-model-picker.component.spec.ts`
- Test: `src/renderer/app/features/models/model-picker.controller.spec.ts`

**Interfaces:**

- Consumes: local-model catalog rows and local-model inventory entries.
- Produces: `PendingSelection.modelRuntimeTarget`.

- [x] **Step 1: Write failing picker tests**

Add tests that set provider list to include `local-model`, load a catalog row with selector ID, click it, and assert:

```ts
expect(emitted[0]).toMatchObject({
  provider: 'local-model',
  model: 'lm://worker-node/node-win/ollama/ollama/qwen',
  modelRuntimeTarget: {
    kind: 'local-model',
    nodeId: 'node-win',
    modelId: 'qwen',
  },
});
```

- [x] **Step 2: Run picker tests and verify failure**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/models/compact-model-picker.component.spec.ts src/renderer/app/features/models/model-picker.controller.spec.ts
```

Expected: fail because `PickerProvider` excludes `local-model`.

- [x] **Step 3: Extend picker types/constants**

Add:

```ts
export type PickerProvider = ChatProvider | 'cursor' | 'local-model';
```

Set:

```ts
export const DEFAULT_INSTANCE_PROVIDERS: PickerProvider[] = [
  'claude',
  'codex',
  'antigravity',
  'copilot',
  'cursor',
  'local-model',
];
```

Add label/color:

```ts
local-model: 'Local Models'
```

- [x] **Step 4: Resolve local-model selections to runtime targets**

Add a renderer helper that decodes local-model selector IDs through a shared parser or IPC inventory lookup. Do not string-split inside template code. On model row selection for provider `local-model`, emit `PendingSelection.modelRuntimeTarget`.

- [x] **Step 5: Connect draft composer behavior**

In `InputPanelComponent.onCompactPickerSelectionChange`, call `newSessionDraft.setModelRuntimeTarget(selection.modelRuntimeTarget ?? null)` before provider/model setters. If a local-model target has `nodeId`, set the draft remote node to that node.

- [x] **Step 6: Run picker tests**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/models/compact-model-picker.component.spec.ts src/renderer/app/features/models/model-picker.controller.spec.ts
```

Expected: pass.

## Task 8: Implement Direct Local Model Chat Adapters

**Files:**

- Create: `src/main/cli/adapters/local-model-chat-adapter.ts`
- Modify: `src/main/cli/adapters/ollama-cli-adapter.ts`
- Create: `src/main/cli/adapters/openai-compatible-chat-adapter.ts`
- Modify: `src/main/cli/adapters/adapter-factory.ts`
- Test: existing or new adapter specs.

**Interfaces:**

- Consumes: `ModelRuntimeTarget` for `source: 'this-device'`.
- Produces: `CliAdapter`-compatible local-model chat adapters.

- [x] **Step 1: Write failing adapter tests**

Add tests that stub HTTP responses and assert adapters emit output and complete events for:

```ts
await adapter.sendInput('hello');
expect(events.output.join('')).toContain('hi');
expect(events.complete).toBe(true);
```

Include OpenAI-compatible streaming chunks and non-streaming fallback.

- [x] **Step 2: Run adapter tests and verify failure**

Run:

```bash
npm run test:quiet -- src/main/cli/adapters/__tests__/ollama-cli-adapter.spec.ts src/main/cli/adapters/__tests__/openai-compatible-chat-adapter.spec.ts
```

Expected: fail until the shared contract and OpenAI-compatible adapter exist.

- [x] **Step 3: Extract shared local-model adapter contract**

Create `LocalModelChatAdapter`:

```ts
export interface LocalModelChatAdapter extends CliAdapter {
  getEndpointProvider(): LocalModelEndpointProvider;
  getModelId(): string;
}
```

Move common conversation history, cancellation, output event, and context estimate helpers into the new file without changing Ollama behavior.

- [x] **Step 4: Add OpenAI-compatible adapter**

Implement `/v1/chat/completions` with streaming request body:

```ts
{
  model,
  messages,
  stream: true,
  temperature: 0.2
}
```

Parse `data:` SSE chunks, emit content deltas, and fall back to a non-streaming response when the endpoint returns a clear streaming unsupported error.

- [x] **Step 5: Run adapter tests**

Run:

```bash
npm run test:quiet -- src/main/cli/adapters/__tests__/ollama-cli-adapter.spec.ts src/main/cli/adapters/__tests__/openai-compatible-chat-adapter.spec.ts
```

Expected: pass.

## Task 9: Add Remote Local Model Session RPC

**Files:**

- Modify: `src/main/remote-node/rpc-schemas.ts`
- Modify: `src/main/remote-node/worker-node-rpc.ts`
- Modify: `src/worker-agent/worker-rpc-dispatcher.ts`
- Create: `src/worker-agent/local-model-session-manager.ts`
- Create: `src/worker-agent/__tests__/local-model-session-manager.spec.ts`
- Create: `src/main/cli/adapters/remote-local-model-adapter.ts`

**Interfaces:**

- Consumes: `ModelRuntimeTarget` for `source: 'worker-node'`.
- Produces: `localModel.session.start`, `localModel.session.sendInput`, `localModel.session.terminate`, and `RemoteLocalModelAdapter`.

- [x] **Step 1: Write failing worker RPC tests**

Test a worker session:

```ts
const started = await manager.start({
  sessionId: 'lm-1',
  endpointProvider: 'ollama',
  endpointId: 'ollama',
  modelId: 'qwen',
});
expect(started.sessionId).toBe('lm-1');
await manager.sendInput({ sessionId: 'lm-1', text: 'hello' });
await manager.terminate({ sessionId: 'lm-1' });
```

- [x] **Step 2: Run RPC tests and verify failure**

Run:

```bash
npm run test:quiet -- src/worker-agent/__tests__/local-model-session-manager.spec.ts src/main/remote-node/worker-node-rpc.spec.ts
```

Expected: fail because the RPC methods do not exist.

- [x] **Step 3: Add RPC schemas**

Add schemas for:

```ts
localModel.session.start
localModel.session.sendInput
localModel.session.terminate
localModel.session.interrupt
```

Each request must include `sessionId`, `endpointProvider`, `endpointId`, and `modelId` for start. `sendInput` includes `text` and optional attachments only when support exists.

- [x] **Step 4: Implement worker session manager**

The manager must keep per-session message history, enforce max concurrent local model sessions, emit output/status/complete events, and clean up all sessions on worker shutdown.

- [x] **Step 5: Implement coordinator remote adapter**

`RemoteLocalModelAdapter` should mirror `RemoteCliAdapter` lifecycle shape but call local-model RPC methods. It must translate worker output events into the same adapter events `InstanceLifecycleManager` already handles.

- [x] **Step 6: Run RPC tests**

Run:

```bash
npm run test:quiet -- src/worker-agent/__tests__/local-model-session-manager.spec.ts src/main/remote-node/worker-node-rpc.spec.ts
```

Expected: pass.

## Task 10: Wire Instance Lifecycle To Local Model Runtime Targets

**Files:**

- Modify: `src/main/instance/lifecycle/execution-location-resolver.ts`
- Modify: `src/main/instance/lifecycle/instance-create-builder.ts`
- Modify: `src/main/instance/instance-lifecycle.ts`
- Modify: `src/main/instance/instance-manager-logging.ts`
- Modify: `src/main/instance/lifecycle/__tests__/instance-create-builder.spec.ts`
- Modify: focused instance lifecycle specs.

**Interfaces:**

- Consumes: `ModelRuntimeTarget`.
- Produces: local-model session spawn with runtime summary and validated execution location.

- [x] **Step 1: Write failing lifecycle tests**

Add tests asserting:

```ts
const instance = await manager.createInstance({
  name: 'Local qwen',
  workingDirectory: '/tmp/project',
  provider: 'claude',
  modelRuntimeTarget: {
    kind: 'local-model',
    source: 'worker-node',
    selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
    nodeId: 'node-win',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId: 'qwen',
  },
});

expect(instance.executionLocation).toEqual({ type: 'remote', nodeId: 'node-win' });
expect(instance.runtimeSummary).toMatchObject({
  kind: 'local-model',
  label: 'qwen on windows-pc',
});
expect(createRuntimeAdapter).toHaveBeenCalledWith(expect.objectContaining({
  runtimeTarget: expect.objectContaining({ kind: 'local-model' }),
}));
```

- [x] **Step 2: Run lifecycle tests and verify failure**

Run:

```bash
npm run test:quiet -- src/main/instance/lifecycle/__tests__/instance-create-builder.spec.ts src/main/instance/__tests__/instance-lifecycle-spawn-rollback.spec.ts
```

Expected: fail because lifecycle ignores `modelRuntimeTarget`.

- [x] **Step 3: Validate execution location**

In `execution-location-resolver.ts`, make local-model worker targets force remote execution for the selected node:

```ts
if (config.modelRuntimeTarget?.kind === 'local-model' && config.modelRuntimeTarget.nodeId) {
  return { type: 'remote', nodeId: config.modelRuntimeTarget.nodeId };
}
```

Coordinator-local targets return `{ type: 'local' }`.

- [x] **Step 4: Seed model and runtime summary**

In `instance-create-builder.ts`, set `currentModel` to `target.modelId` and `runtimeSummary` to a user-facing local-model label when `modelRuntimeTarget.kind === 'local-model'`.

- [x] **Step 5: Spawn local-model adapters**

In `instance-lifecycle.ts`, before CLI provider resolution creates a CLI adapter, branch on `config.modelRuntimeTarget?.kind === 'local-model'`. Resolve inventory freshness, create direct or remote local-model adapter, and throw before spawn with this message when missing:

```text
<modelId> is no longer available on <nodeName>. Pick another model or start the endpoint on that worker.
```

- [x] **Step 6: Sanitize create config logging**

In `instance-manager-logging.ts`, keep provider/model/node labels and drop endpoint URLs or secret-like fields from `modelRuntimeTarget`.

- [x] **Step 7: Run lifecycle tests**

Run:

```bash
npm run test:quiet -- src/main/instance/lifecycle/__tests__/instance-create-builder.spec.ts src/main/instance/__tests__/instance-lifecycle-spawn-rollback.spec.ts
```

Expected: pass.

## Task 11: Live Toolbar, Node Picker, History, And Display Polish

**Files:**

- Modify: `src/renderer/app/features/instance-detail/composer-toolbar.component.ts`
- Modify: `src/renderer/app/features/instance-detail/instance-header.component.ts`
- Modify: `src/renderer/app/shared/components/node-picker/node-picker.component.ts`
- Modify: `src/main/history/history-manager.ts`
- Modify: renderer specs beside changed components.

**Interfaces:**

- Consumes: `Instance.runtimeSummary`.
- Produces: stable display labels and node eligibility for local-model sessions.

- [x] **Step 1: Write failing display tests**

Assert local-model instances display `Local Models - qwen on windows-pc`, and node picker allows a node when it advertises the selected local model even if `supportedClis` does not include the active CLI.

- [x] **Step 2: Run display tests and verify failure**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/instance-detail/composer-toolbar.component.spec.ts src/renderer/app/shared/components/node-picker/node-picker.component.spec.ts
```

Expected: fail until runtime summaries and node eligibility are consumed.

- [x] **Step 3: Display runtime summary**

Prefer `instance.runtimeSummary.label` in live toolbar/header when `runtimeSummary.kind === 'local-model'`; keep existing provider/model display for CLI instances.

- [x] **Step 4: Update node eligibility**

Add node-picker input for selected local model target and allow a remote node when `node.capabilities.localModelEndpoints` contains a healthy endpoint with matching provider, endpoint ID, and model ID.

- [x] **Step 5: Persist runtime summary in history**

Store `runtimeSummary` with history entries so restored sessions show the same local-model label even if the worker is offline.

- [x] **Step 6: Run display tests**

Run:

```bash
npm run test:quiet -- src/renderer/app/features/instance-detail/composer-toolbar.component.spec.ts src/renderer/app/shared/components/node-picker/node-picker.component.spec.ts
```

Expected: pass.

## Task 12: Final Verification And Manual Worker Validation

**Files:**

- Modify only files required by failures found during verification.

**Interfaces:**

- Consumes: all prior tasks.
- Produces: verified local-model runtime feature.

- [x] **Step 1: Run targeted test set**

Run:

```bash
npm run test:quiet -- \
  src/main/remote-node/remote-node-roster-service.spec.ts \
  src/worker-agent/capability-reporter.spec.ts \
  src/main/local-models/__tests__/local-model-selector.spec.ts \
  src/main/local-models/__tests__/local-model-inventory-service.spec.ts \
  src/main/providers/__tests__/unified-model-catalog-service.spec.ts \
  src/renderer/app/features/models/compact-model-picker.component.spec.ts \
  src/renderer/app/core/services/new-session-draft.service.spec.ts \
  src/main/ipc/handlers/__tests__/session-handlers.spec.ts
```

Expected: pass.

- [x] **Step 2: Run project gates**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
```

Expected: all pass with no new file-size violations.

- [x] **Step 3: Run full suite**

Run:

```bash
npm run test:quiet
```

Expected: pass.

- [ ] **Step 4: Manual validation with `windows-pc`**

Start the app with the worker connected and Ollama or LM Studio running on `windows-pc`. Verify:

- Remote Nodes detail shows endpoint provider, health, model names, loaded context when reported.
- New session model picker includes `Local Models`.
- Selecting a `windows-pc` local model sets the node selection to `windows-pc`.
- Creating the session starts a local-model runtime on `windows-pc`.
- Sending two messages preserves conversation history.
- Stopping the endpoint disables new launches with a clear error instead of silently falling back to Claude/Codex.

Live evidence on 2026-07-10 now proves the first four bullets with both LM
Studio and Ollama on `windows-pc`. Both providers also completed a second turn,
but the UI did not create a second assistant bubble because
`BaseLocalModelChatAdapter` reused its session id as the streaming message id
across every turn and emitted delta chunks without the accumulated-content
metadata consumed by the main and renderer stores. The base adapter now creates
one stable message id per turn, accumulates visible content, and clears both at
the turn boundary. Two-turn provider tests fail on the old behavior and pass
with the fix, including full prior-history assertions. A renderer aggregation
regression proves two complete, distinct turn bubbles. Worker, RPC,
remote-adapter, and renderer focused coverage passes 6 files / 25 tests. The
rebuilt worker has now been installed at the live worker path, its SHA-256
matched the staged deployment artifact at transfer time, and the restarted node
reports a fresh worker start and coordinator connection. The visible two-turn UI check and endpoint-stop
check still need to close this step.

- [x] **Step 5: Final worktree check**

Run:

```bash
git status --short
```

Expected: only intentional implementation files and uncommitted docs are listed.

## Self-Review Notes

- Spec coverage: remote worker model visibility is covered by Tasks 1, 3, 4, and 5; session selection is covered by Tasks 6, 7, 10, and 11; direct and remote runtime execution is covered by Tasks 8, 9, and 10; verification is covered by Task 12.
- Security coverage: base URLs and tokens are intentionally excluded from inventory rows and logging; worker-local endpoints are accessed through worker RPC.
- Type consistency: `ModelRuntimeTarget`, `LocalModelInventoryEntry`, `InstanceRuntimeSummary`, and provider namespace `local-model` are introduced once and consumed by later tasks.

## Completion Re-Audit (2026-07-10)

- Tasks 1-11 are present and integrated across capability reporting, sanitized
  inventory, catalog/IPC/preload, Remote Nodes UI, draft/picker state, local and
  remote adapters, worker session RPC, lifecycle creation, placement, and live
  display state.
- The focused implementation gate passes 16 files / 189 tests, including direct
  OpenAI-compatible chat, remote adapter/session RPC, inventory/selectors,
  lifecycle builders/resolution, catalog, preload, draft, picker, model panel,
  and remote-node display.
- TypeScript, spec TypeScript, lint, and the TypeScript LOC ratchet pass.
- The unfiltered repository suite passes 1,248 files / 12,271 tests, and the
  production build completes through the renderer, Electron, desktop-helper,
  worker-agent, loop-control, and bundled CLI stages.
- The older scaffolding cost-router no longer dials a connected worker's Ollama
  address directly. Coordinator-local scaffolding probes localhost only;
  worker-local auxiliary generation and interactive sessions stay behind the
  authenticated worker RPC paths. The dedicated scaffolding/default-invoker
  regression gate passes 2 files / 33 tests.
- Live `windows-pc` evidence proves worker-local inventory, picker selection,
  automatic placement, and first-turn execution for both LM Studio and Ollama.
  Persisted lifecycle traces prove both second turns completed. The missing
  second assistant bubble and truncated first reply were traced to a
  session-wide streaming message id plus missing accumulated-content metadata.
  Both are fixed locally with per-turn identity, two-turn history, and renderer
  aggregation tests.

The deployment portion of operational Task 12 Step 4 is complete: the live file
hash matched the staged deployment artifact at transfer time and the connected
node reports a new worker process start. Repeat the visible two-turn check and stop one endpoint to verify
the honest unavailable error. Do not mark this plan complete before that
evidence exists.

## Closure (2026-07-10)

Closed by James as implemented. Tasks 1–11 plus the Task 12 code fix (per-turn
streaming message identity, two-turn history, renderer aggregation) are complete
and verified by the automated gate: 16 files / 189 tests, tsc, spec-tsc, lint,
LOC ratchet, and the full 12,297-test suite green. Live windows-pc evidence
proved worker-local inventory, picker selection, placement, and first-turn
execution for LM Studio and Ollama.

DEFERRED, not performed: the visible two-turn UI check (two distinct assistant
bubbles) and the endpoint-stop honest-error check in the AIO renderer. The code
fix is in the tree but not in the running build (needs rebuild + restart). This
rename records implementation completeness, not a live-UI sign-off.
