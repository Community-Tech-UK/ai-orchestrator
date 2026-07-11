# Remote Local Model Runtime Design

## Status

Implementation complete under automated verification. Live validation proved
inventory, picker placement, and first-turn execution on `windows-pc`, then
found a session-wide streamed-message id reused across turns and delta-only
chunks without the accumulated-content metadata consumed by the UI stores. The
per-turn identity and accumulation fixes are deployed to a freshly restarted
worker; the visible two-turn and endpoint-stop checks still require a live
recheck.

## Problem

Harness can already show remote worker computers connected to the coordinator.
Workers also probe worker-local model servers such as Ollama and LM Studio, but
that information is not surfaced as a first-class model/runtime choice in the
session window.

The current implementation has three important facts:

- Workers report `capabilities.localModelEndpoints` for Ollama and
  OpenAI-compatible endpoints.
- The Remote Nodes UI focuses on machine/CLI capabilities and does not display
  local model endpoint inventory.
- Interactive session creation is CLI-provider oriented. The renderer picker and
  `InstanceCreateConfig.provider` are built around `CanonicalCliType` values such
  as `claude`, `codex`, `antigravity`, `copilot`, and `cursor`.

Adding remote local models by stuffing them into the existing CLI provider path
would make runtime selection brittle. A model running in LM Studio on
`windows-pc` is not a CLI provider. It is a model endpoint on a specific node,
with different lifecycle, health, streaming, context, and tool capabilities.

## Goals

- Show remote worker local models in the app, including node name, endpoint kind,
  model names, health, and loaded-model context where available.
- Make local models selectable in the session window.
- Preserve a clean architecture: CLI providers remain CLI providers, and local
  model endpoints become a typed runtime family.
- Support both coordinator-local and worker-local endpoints.
- Make remote selection deterministic. If a model lives on `windows-pc`, the
  resulting session target must include `windows-pc`, not only a model string.
- Avoid exposing worker loopback URLs or transport secrets to the renderer or
  logs as actionable connection data.
- Keep older workers compatible.
- Leave room for future tool-use parity without blocking basic local model chat
  sessions.

## Non-Goals

- Do not assume `windows-pc` is always connected.
- Do not let the coordinator dial a worker's `127.0.0.1` endpoint directly.
- Do not overload `CanonicalCliType` with endpoint runtimes.
- Do not make LM Studio/Ollama model IDs globally unique without node/endpoint
  context.
- Do not claim every local model has tool-use support. Capability labels must be
  explicit.
- Do not persist or display secrets, pairing tokens, or worker transport tokens.

## Recommended Architecture

Build a first-class Local Model Runtime alongside, not inside, the CLI runtime.

The runtime has three layers:

1. Worker capability reporting keeps advertising local model endpoints.
2. The coordinator turns connected-node capability data into a sanitized local
   model inventory.
3. Session creation accepts either a CLI provider target or a local model target.

The local model target is a typed object, not just a provider/model string:

```ts
type ModelRuntimeTarget =
  | { kind: 'cli'; provider?: InstanceProvider }
  | {
      kind: 'local-model';
      source: 'this-device' | 'worker-node';
      endpointProvider: 'ollama' | 'openai-compatible';
      modelId: string;
      nodeId?: string;
      endpointId: string;
    };
```

`provider` remains available for existing CLI paths, but new code should prefer
`modelRuntimeTarget` when deciding how to spawn a session.

## Current System Facts

- `WorkerNodeCapabilities.localModelEndpoints` exists in
  `src/shared/types/worker-node.types.ts`.
- Worker capability probing lives in `src/worker-agent/capability-reporter.ts`.
- Ollama and LM Studio loopback defaults are centralized in
  `src/worker-agent/local-model-config.ts`.
- The worker can already proxy one-shot auxiliary calls through
  `auxiliaryModel.list` and `auxiliaryModel.generate`.
- `OllamaCliAdapter` exists and can run a local HTTP-per-message multi-turn
  session against Ollama.
- The renderer `PickerProvider` type currently excludes `ollama` and
  `openai-compatible`.
- `InstanceProvider` is currently `CanonicalCliType`, so local model sessions
  need an explicit runtime target instead of pretending to be CLI sessions.

## Data Contracts

### Worker Capability Contract

Keep `WorkerLocalModelCapability`, but make the transport schema preserve every
field the type promises:

```ts
interface WorkerLocalModelCapability {
  provider: 'ollama' | 'openai-compatible';
  baseUrl: string;
  models: string[];
  loadedModels?: Array<{
    id: string;
    contextLength: number;
  }>;
  healthy: boolean;
}
```

`loadedModels` is already in the shared TypeScript type. The RPC schema should
accept it so LM Studio loaded-state data is not stripped.

Workers should continue sending unhealthy installed endpoints with empty model
lists so the UI can show "installed but server not running" instead of hiding
the endpoint.

### Sanitized Inventory Entry

Add a coordinator-side local model inventory service, for example:

- `src/main/local-models/local-model-inventory-service.ts`

Suggested entry shape:

```ts
interface LocalModelInventoryEntry {
  selectorId: string;
  source: 'this-device' | 'worker-node';
  endpointProvider: 'ollama' | 'openai-compatible';
  endpointId: string;
  modelId: string;
  displayName: string;
  nodeId?: string;
  nodeName?: string;
  platform?: NodePlatform;
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
```

`selectorId` must be an opaque stable identifier suitable for renderer state.
It should encode enough to re-resolve the target, but consumers should use a
parser/helper instead of string splitting in UI code.

Suggested stable format:

```text
lm://worker-node/<encoded-node-id>/<endpoint-provider>/<encoded-model-id>
lm://this-device/<endpoint-provider>/<encoded-model-id>
```

The renderer may display node names and model names. It should not treat
`baseUrl` as a user-dialable URL for worker-local endpoints.

## Coordinator Services

### LocalModelInventoryService

Responsibilities:

- Read connected remote nodes from `RemoteNodeRosterService`.
- Optionally include coordinator-local endpoints from the same probing logic used
  by auxiliary models.
- Produce sanitized inventory entries.
- Listen to worker roster/heartbeat changes and emit `inventory-updated`.
- Mark entries unhealthy/stale when a node disconnects.
- Resolve a selected `selectorId` into a `ModelRuntimeTarget`.

The service should not depend on Angular or renderer concepts. It should be pure
enough to unit test with fake rosters.

### Catalog Integration

The unified model catalog should learn a new source:

```ts
type CatalogSource =
  | 'cli-discovered'
  | 'local-model'
  | 'models-dev'
  | 'user-custom'
  | 'catalog-override'
  | 'static';
```

Local model entries should live in a provider namespace such as `local-model`.
The picker can then render a "Local Models" provider tab without mixing local
endpoint rows into Claude/Codex/Copilot model lists.

The catalog entry can still be simple:

```ts
{
  id: selectorId,
  provider: 'local-model',
  name: 'llama3.2 on windows-pc',
  family: 'Ollama',
  tier: 'balanced',
  source: 'local-model',
  contextWindow: loadedContextLength ?? advertisedContextLength,
  discoveredAt,
}
```

The richer runtime details stay in `LocalModelInventoryService`. The catalog is
for discovery and display; the runtime target resolver owns launch semantics.

## Session Creation

Extend `InstanceCreateConfig` with an optional `modelRuntimeTarget`.

```ts
interface InstanceCreateConfig {
  provider?: InstanceProvider;
  modelOverride?: string;
  modelRuntimeTarget?: ModelRuntimeTarget;
}
```

Rules:

- Missing `modelRuntimeTarget` means legacy CLI behavior.
- `{ kind: 'cli' }` means CLI behavior and uses existing `provider` /
  `modelOverride`.
- `{ kind: 'local-model' }` uses local-model runtime spawning and ignores CLI
  provider resolution.
- Remote local model targets require a live node match and a healthy endpoint.
- A selected worker-local model should set or validate `executionLocation` for
  that node.
- If a stale target cannot be resolved, instance creation fails before any
  process/RPC spawn with a user-facing message such as:
  `llama3.2 is no longer available on windows-pc. Pick another model or start the endpoint on that worker.`

`Instance` should gain a small runtime descriptor for display/history:

```ts
interface InstanceRuntimeSummary {
  kind: 'cli' | 'local-model';
  label: string;
  nodeId?: string;
  nodeName?: string;
  endpointProvider?: 'ollama' | 'openai-compatible';
}
```

This avoids forcing `provider: InstanceProvider` to describe every runtime type.

## Runtime Adapters

### Local Direct Adapters

Extract the current Ollama HTTP logic behind a reusable local model adapter
contract:

```ts
interface LocalModelChatAdapter extends CliAdapter {
  getEndpointProvider(): 'ollama' | 'openai-compatible';
  getModelId(): string;
}
```

Implement:

- `OllamaChatAdapter` for Ollama native `/api/chat`.
- `OpenAiCompatibleChatAdapter` for `/v1/chat/completions` streaming.

Both should emit the same adapter events the instance lifecycle already
understands: output, status, complete, context, error, exit.

### Remote Worker Adapters

Do not reuse `auxiliaryModel.generate` for interactive sessions. It is one-shot
and helper-oriented. Add session-scoped worker RPC methods:

- `localModel.session.start`
- `localModel.session.sendInput`
- `localModel.session.terminate`
- `localModel.session.interrupt` if the backend can cancel inflight HTTP
  requests

The worker side should have a focused manager, for example:

- `src/worker-agent/local-model-session-manager.ts`

It should mirror the shape of `LocalInstanceManager` where useful:

- enforce allowed working directory only if a local-model session receives tools
  or file context;
- enforce capacity;
- keep conversation history per session;
- emit output/context/complete/status events back to the coordinator;
- clean up on node shutdown.

Coordinator-side remote local sessions use a `RemoteLocalModelAdapter`, similar
in spirit to `RemoteCliAdapter`, but with local-model-specific RPC methods and
capabilities.

## Tool Use Strategy

Local model sessions should start with accurate capability labels:

- Chat/multi-turn: supported for Ollama and OpenAI-compatible endpoints.
- File/shell tool execution: disabled unless a Harness-native tool loop is
  explicitly enabled and verified for that model/endpoint.

The architecture should support a later Harness-native tool loop:

- The local model produces tool calls through an OpenAI-compatible tool schema
  or a Harness prompt/protocol wrapper.
- Harness executes tools through the existing permission system.
- Tool results are fed back to the local model session.

This is separate from basic remote local-model selection. The UI must not imply
tool parity for models that only support chat.

## Renderer UX

### Remote Nodes UI

Show local model endpoint inventory in both node cards and node detail:

- Endpoint badges: `Ollama`, `LM Studio`, `OpenAI-compatible`.
- Health: `Running`, `Installed but not running`, `Unavailable`.
- Model count on cards.
- Detail list with model names.
- Loaded model marker and context length where LM Studio reports it.

Example detail row:

```text
Ollama - Running
llama3.2, qwen2.5-coder:14b
```

Example LM Studio row:

```text
LM Studio - Running
qwen2.5-coder-32b-instruct - loaded, 32768 ctx
```

### Session Model Picker

Add `local-model` as a picker provider labeled `Local Models`.

Rows should show:

- model display name;
- node/source label, such as `windows-pc` or `This device`;
- endpoint provider;
- health/loaded state;
- capability chip such as `Chat` or `Tools`.

Selection behavior:

- Selecting a worker-local model writes the `modelRuntimeTarget` into the draft.
- If the selected model belongs to a remote node, the draft node selection is set
  to that node.
- If the user manually selects a node first, the Local Models tab should prefer
  or filter to models available on that node.
- If no local models are healthy, show disabled rows or an empty state pointing
  to Remote Nodes / Auxiliary Models settings.

### Live Instance Toolbar

The live picker should display local-model runtime summaries, but model switching
should initially follow the same safety rule as CLI model switching: only allow
while waiting for user input. Switching across runtime kinds should respawn the
runtime through the instance lifecycle instead of mutating a live adapter in
place.

## Error Handling

- Old worker: no `localModelEndpoints` means no local models.
- Worker disconnected: existing local-model session enters degraded/disconnected
  state using the remote-node handling path; new launches are blocked.
- Endpoint unhealthy: show endpoint in Remote Nodes UI, but disable model rows
  until the server is running.
- Model disappeared: fail launch before spawn; for live sessions, show an
  instance note and require reselection.
- OpenAI-compatible endpoint lacks streaming: fall back to non-streaming response
  if the endpoint is otherwise valid, and mark streaming false in capabilities.
- Context length unknown: use conservative default and mark context accounting as
  estimated.

## Backward Compatibility

- Existing CLI session behavior is unchanged when `modelRuntimeTarget` is
  absent.
- Existing worker capability payloads remain valid.
- Older workers simply report no local model inventory.
- Existing auxiliary model routing can keep using `auxiliaryModel.generate`.
  Session runtime RPCs are a separate path.
- Existing history records without runtime summaries continue to display based
  on provider/currentModel.

## Testing

Focused tests:

- `rpc-schemas.spec.ts`: `localModelEndpoints` accepts `loadedModels`; new
  `localModel.session.*` schemas validate expected payloads.
- `capability-reporter.spec.ts`: Ollama/LM Studio healthy and unhealthy endpoint
  reporting, including loaded context preservation.
- `remote-node-roster-service.spec.ts`: roster preserves sanitized local model
  endpoint capability data without secrets.
- New `local-model-inventory-service.spec.ts`: builds stable selector IDs,
  resolves runtime targets, marks disconnected node entries unhealthy, and
  never exposes worker tokens.
- `unified-model-catalog-service.spec.ts`: local-model source entries merge into
  provider namespace `local-model` and emit catalog updates.
- `compact-model-picker.component.spec.ts`: Local Models provider renders,
  filters by selected node, and emits a runtime target on selection.
- `new-session-draft.service.spec.ts`: draft persistence/hydration for local
  model runtime targets.
- `instance-lifecycle` focused tests: local-model target bypasses CLI provider
  resolution, validates node/endpoint health, and creates the right adapter.
- Worker local-model session manager tests: start/send/terminate, streaming
  output, context events, capacity enforcement, and cleanup.

Verification after implementation:

1. Run targeted specs for worker capability reporting, RPC schemas, inventory,
   catalog, picker, draft state, lifecycle, and adapters.
2. Run `npx tsc --noEmit`.
3. Run `npx tsc --noEmit -p tsconfig.spec.json`.
4. Run `npm run lint`.
5. Run `npm run check:ts-max-loc`.
6. Run `npm run test:quiet`.
7. Manually verify with a connected worker that has Ollama or LM Studio running:
   Remote Nodes shows model names, the session picker shows Local Models, and a
   selected worker model launches a session on that worker.

## Implementation Order

1. Fix and extend the worker/coordinator contracts so model endpoint data is
   complete and preserved.
2. Add `LocalModelInventoryService` and surface inventory through IPC.
3. Show local model inventory in Remote Nodes UI.
4. Add local-model source entries to the unified model catalog.
5. Extend picker/draft state with local-model runtime targets.
6. Implement direct local adapters for Ollama and OpenAI-compatible chat.
7. Implement remote local-model session RPC and worker session manager.
8. Wire instance lifecycle to spawn local-model runtime targets.
9. Add live toolbar/history display support.
10. Run full verification and manual worker validation.

## Risks

- Type migration risk: many code paths assume `InstanceProvider` is a CLI type.
  Keep `modelRuntimeTarget` additive and migrate display/runtime decisions
  incrementally.
- UI ambiguity: local models may be chat-only. Capability chips and disabled tool
  affordances must make this clear.
- Endpoint identity: model IDs are not globally unique. Always pair model ID with
  source, node, and endpoint provider.
- Worker freshness: heartbeats can lag endpoint state. Launch-time validation
  must re-check availability before starting a session.
- Context accuracy: local endpoints often do not publish reliable context
  windows. Prefer loaded-model context when LM Studio reports it; otherwise mark
  accounting estimated.

## Open Follow-Up

After basic remote local-model sessions are stable, design the Harness-native
tool loop for local models as a separate spec. That work should decide how to
represent tool calls, permission prompts, tool results, retry behavior, and
model-specific tool-call compatibility.

## Completion Re-Audit (2026-07-10)

The proposed contracts and architecture are implemented: local-model targets
remain separate from CLI providers; worker loopback endpoints stay behind RPC;
inventory is sanitized; selectors include node/endpoint/model identity; direct
and remote chat adapters preserve multi-turn history; and UI/catalog/lifecycle
paths consume the same typed target.

The pre-existing scaffolding cost-router was also reconciled with this boundary:
it no longer probes or invokes worker Ollama over a coordinator-to-worker HTTP
address. Local scaffolding can probe coordinator localhost; worker-local helper
and session traffic uses the existing authenticated RPC surfaces. The focused
scaffolding/default-invoker safety gate passes 2 files / 33 tests.

The focused gate passes 16 files / 189 tests and the project compile, lint, and
LOC gates pass. Additional two-turn provider coverage proves one stable stream
id per turn, a different id across turns, accumulated visible content, and
preserved prior history. A renderer aggregation regression proves two complete,
distinct turn bubbles; the worker/RPC/remote-adapter/renderer gate passes 6
files / 25 tests. The full repository
suite passes 1,248 files / 12,271 tests and the production build passes.

The rebuilt worker is deployed: the live file hash matched the staged artifact
at transfer time, and the node reports a fresh worker start and coordinator connection. The
design is not renamed `_completed` yet. Confirm that turn two renders as a
distinct assistant message, and stop one endpoint to verify the honest
unavailable error on `windows-pc`.

## Closure (2026-07-10)

Closed by James alongside its implementing plan
(`2026-07-08-remote-local-model-runtime_completed.md`). Design is fully
implemented and automated-gate-verified. The live two-bubble / endpoint-stop UI
smoke is deferred to deploy QA (needs a rebuilt/restarted Harness watched in the
renderer). No live-UI sign-off is claimed.
