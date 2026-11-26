# Auxiliary Local Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route bounded low-risk helper calls through local or cheaper models when available, while keeping frontier models for main tool-using agents and high-risk decisions.

**Architecture:** Add a slot-based auxiliary LLM layer on top of the existing RLM `LLMService` and remote-node capability system. Local models are discovered from localhost, manual endpoints, and connected worker nodes; auxiliary slots choose a healthy local model first, then a configured cheap cloud model, then the existing deterministic fallback. Main chat/provider routing remains unchanged until a later optional phase.

**Tech Stack:** Electron main process TypeScript, Angular 21 settings UI, Vitest, Ollama REST API, OpenAI-compatible REST API, existing remote worker WebSocket/RPC infrastructure.

---

## Implementation Status & Ownership Boundary

> Added 2026-06-06. Most of this plan is **already implemented and committed**
> ("Master plan finished"). Verified present in the tree: `auxiliary-llm.types.ts`,
> the `auxiliaryLlm*` settings keys + defaults, `auxiliary-llm-service.ts`,
> `auxiliary-model-client.ts`, `auxiliary-llm-handlers.ts`, the settings UI tab,
> worker-node `localModelEndpoints` capability + RPC, the runbook, and partial
> `LLMService`/`UnifiedMemoryController` wiring.
> **Outstanding:** Task 8 (context-compaction hardening in
> `src/main/context/context-compactor.ts`) and verifying Task 9 wiring is complete.

**This doc OWNS (its lane, disjoint from D1/D4/D5):** `src/main/rlm/**`,
`src/main/context/context-compactor.ts`, `src/main/memory/unified-controller.ts`,
`src/main/routing/model-router.ts`, `src/main/remote-node/**` (rpc, service-rpc),
`src/worker-agent/**`, `src/main/ipc/handlers/auxiliary-llm-handlers.ts`,
`src/shared/types/auxiliary-llm.types.ts`, `src/shared/types/worker-node.types.ts`,
`src/renderer/app/features/settings/auxiliary-models-settings-tab.*` +
`settings-navigation.ts`. It also already edited the **shared** files
`src/shared/types/settings.types.ts` and `src/main/ipc/ipc-main-handler.ts`
(committed) — D4 appends one settings flag, D1-Phase-4 appends one handler
registration; those are additive and non-conflicting.

**Do NOT touch (owned by other docs):** `src/main/event-bus/**`,
`src/main/window-manager.ts`, `src/main/app/instance-event-forwarding.ts` (D1);
`src/main/cli/**`, `src/main/providers/**`, `src/main/instance/**` (D4);
`src/main/plugins/**` + plugin schemas/SDK (D5).

---

## Scope

This plan implements auxiliary routing first. It does not turn Ollama/Gemma into a normal chat provider by default.

Allowed local/cheap auxiliary slots:

- `compression`
- `memoryDistillation`
- `webExtract`
- `titleGeneration`
- `routingClassification`
- `approvalScoring`
- `loopScoring`

Frontier/default provider routing remains mandatory for:

- main interactive coding agents
- file mutation
- shell/tool execution
- security review
- cross-model verification
- architectural decisions
- command approval final authority

`approvalScoring` may provide an advisory score, but approval policy and user confirmation still decide.

## Files

Create:

- `src/shared/types/auxiliary-llm.types.ts` - shared slot, endpoint, model, decision, and diagnostics types.
- `src/main/rlm/auxiliary-model-client.ts` - low-level Ollama and OpenAI-compatible health/list/generate helpers.
- `src/main/rlm/auxiliary-llm-service.ts` - slot resolution, fallback ordering, health cache, and generation facade.
- `src/main/rlm/__tests__/auxiliary-model-client.spec.ts` - REST client tests.
- `src/main/rlm/__tests__/auxiliary-llm-service.spec.ts` - routing/fallback tests.
- `src/main/ipc/handlers/auxiliary-llm-handlers.ts` - discovery/probe/save/test IPC handlers.
- `src/renderer/app/core/services/ipc/auxiliary-llm-ipc.service.ts` - renderer IPC wrapper.
- `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.ts` - manual setup and discovery UI.
- `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.scss` - UI styling.
- `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.spec.ts` - settings UI tests.
- `docs/runbooks/AUXILIARY_LOCAL_MODELS.md` - Windows 5090/Ollama/Tailscale/manual endpoint runbook.

Modify:

- `src/shared/types/settings.types.ts` - persisted auxiliary settings defaults.
- `src/shared/types/settings-metadata-runtime.ts` or dedicated settings component wiring - expose basic toggles.
- `src/shared/types/worker-node.types.ts` - worker-reported local model capability.
- `src/worker-agent/capability-reporter.ts` - detect local Ollama models on worker nodes.
- `src/main/remote-node/worker-node-rpc.ts` and `src/worker-agent/worker-rpc-dispatcher.ts` - add optional local model RPC proxy if direct endpoint is not exposed.
- `src/main/rlm/llm-service.ts` - delegate summarization/sub-query helper calls through auxiliary slots when enabled.
- `src/main/context/context-compactor.ts` - use the `compression` slot and add stronger prompt invariants.
- `src/main/memory/unified-controller.ts` - use `memoryDistillation` for memory summarization.
- `src/main/app/*initialization*` or equivalent bootstrap file - hydrate auxiliary service from settings on startup and setting changes.
- `src/main/ipc/index.ts` or IPC registration barrel - register auxiliary handlers.
- `src/renderer/app/features/settings/settings-navigation.ts` and settings container routing - add "Auxiliary Models" settings section.
- Existing tests listed in the tasks below.

---

## Task 1: Add Shared Auxiliary LLM Types And Settings

**Files:**

- Create: `src/shared/types/auxiliary-llm.types.ts`
- Modify: `src/shared/types/settings.types.ts`
- Test: `src/shared/types/__tests__/auxiliary-llm.types.spec.ts`
- Test: `src/renderer/app/core/state/settings.store.spec.ts`

- [ ] **Step 1: Create the shared auxiliary types**

Add:

```ts
export type AuxiliaryLlmSlot =
  | 'compression'
  | 'memoryDistillation'
  | 'webExtract'
  | 'titleGeneration'
  | 'routingClassification'
  | 'approvalScoring'
  | 'loopScoring';

export type AuxiliaryLlmProvider =
  | 'ollama'
  | 'openai-compatible'
  | 'anthropic'
  | 'openai'
  | 'local-fallback';

export type AuxiliaryLlmRoutingMode = 'off' | 'local-first' | 'cheap-first' | 'manual-only';

export interface AuxiliaryLlmModelInfo {
  id: string;
  name: string;
  provider: AuxiliaryLlmProvider;
  endpointId: string;
  contextWindow?: number;
  parameterSize?: string;
  quantization?: string;
  modifiedAt?: string;
}

export interface AuxiliaryLlmEndpointConfig {
  id: string;
  label: string;
  provider: Exclude<AuxiliaryLlmProvider, 'local-fallback'>;
  baseUrl: string;
  apiKeyEnv?: string;
  source: 'manual' | 'localhost' | 'worker-node';
  workerNodeId?: string;
  enabled: boolean;
}

export interface AuxiliaryLlmSlotConfig {
  enabled: boolean;
  provider?: AuxiliaryLlmProvider | 'auto';
  endpointId?: string;
  model?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
  requireJson: boolean;
  allowFrontierFallback: boolean;
}

export type AuxiliaryLlmSlotConfigMap = Record<AuxiliaryLlmSlot, AuxiliaryLlmSlotConfig>;

export interface AuxiliaryLlmSettings {
  enabled: boolean;
  routingMode: AuxiliaryLlmRoutingMode;
  allowRemoteWorkerModels: boolean;
  endpoints: AuxiliaryLlmEndpointConfig[];
  slots: AuxiliaryLlmSlotConfigMap;
}

export interface AuxiliaryLlmCandidate {
  endpoint: AuxiliaryLlmEndpointConfig;
  models: AuxiliaryLlmModelInfo[];
  healthy: boolean;
  reason?: string;
}

export interface AuxiliaryLlmDecision {
  slot: AuxiliaryLlmSlot;
  provider: AuxiliaryLlmProvider;
  endpointId?: string;
  model?: string;
  source: 'local' | 'cheap-cloud' | 'fallback';
  reason: string;
}
```

- [ ] **Step 2: Add persisted settings**

Add to `AppSettings`:

```ts
auxiliaryLlmEnabled: boolean;
auxiliaryLlmRoutingMode: AuxiliaryLlmRoutingMode;
auxiliaryLlmAllowRemoteWorkerModels: boolean;
auxiliaryLlmEndpointsJson: string;
auxiliaryLlmSlotsJson: string;
```

Add imports at the top:

```ts
import type { AuxiliaryLlmRoutingMode } from './auxiliary-llm.types';
```

Add defaults:

```ts
auxiliaryLlmEnabled: true,
auxiliaryLlmRoutingMode: 'local-first',
auxiliaryLlmAllowRemoteWorkerModels: true,
auxiliaryLlmEndpointsJson: '[]',
auxiliaryLlmSlotsJson: JSON.stringify({
  compression: { enabled: true, provider: 'auto', maxInputTokens: 96000, maxOutputTokens: 4096, temperature: 0.2, timeoutMs: 60000, requireJson: false, allowFrontierFallback: false },
  memoryDistillation: { enabled: true, provider: 'auto', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.2, timeoutMs: 45000, requireJson: false, allowFrontierFallback: false },
  webExtract: { enabled: true, provider: 'auto', maxInputTokens: 64000, maxOutputTokens: 2048, temperature: 0.1, timeoutMs: 30000, requireJson: false, allowFrontierFallback: false },
  titleGeneration: { enabled: true, provider: 'auto', maxInputTokens: 12000, maxOutputTokens: 128, temperature: 0.2, timeoutMs: 15000, requireJson: false, allowFrontierFallback: false },
  routingClassification: { enabled: true, provider: 'auto', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 15000, requireJson: true, allowFrontierFallback: false },
  approvalScoring: { enabled: true, provider: 'auto', maxInputTokens: 16000, maxOutputTokens: 512, temperature: 0, timeoutMs: 15000, requireJson: true, allowFrontierFallback: false },
  loopScoring: { enabled: true, provider: 'auto', maxInputTokens: 32000, maxOutputTokens: 1024, temperature: 0, timeoutMs: 30000, requireJson: true, allowFrontierFallback: false }
}),
```

- [ ] **Step 3: Add tests for type/default integrity**

Test that:

- `DEFAULT_SETTINGS.auxiliaryLlmEnabled` is `true`.
- `DEFAULT_SETTINGS.auxiliaryLlmRoutingMode` is `'local-first'`.
- `auxiliaryLlmSlotsJson` parses and contains all seven slots.
- Every slot has a positive `timeoutMs`, `maxInputTokens`, and `maxOutputTokens`.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npx vitest run src/shared/types/__tests__/auxiliary-llm.types.spec.ts src/renderer/app/core/state/settings.store.spec.ts
```

Expected: all tests pass.

---

## Task 2: Add Local Model REST Client

**Files:**

- Create: `src/main/rlm/auxiliary-model-client.ts`
- Create: `src/main/rlm/__tests__/auxiliary-model-client.spec.ts`

- [ ] **Step 1: Implement Ollama health and model listing**

Expose:

```ts
export async function probeOllamaEndpoint(baseUrl: string, timeoutMs: number): Promise<boolean>;
export async function listOllamaModels(baseUrl: string, timeoutMs: number): Promise<AuxiliaryLlmModelInfo[]>;
```

Use:

- `GET {baseUrl}/api/version` for health.
- `GET {baseUrl}/api/tags` for models.
- `AbortController` for timeout.
- Model ids exactly as Ollama returns them, e.g. `gemma4:12b`.

- [ ] **Step 2: Implement Ollama generation**

Expose:

```ts
export interface AuxiliaryGenerateRequest {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  requireJson: boolean;
}

export async function generateWithOllama(baseUrl: string, request: AuxiliaryGenerateRequest): Promise<string>;
```

Use `POST {baseUrl}/api/generate` with:

```ts
{
  model: request.model,
  prompt: `${request.systemPrompt}\n\nUser: ${request.userPrompt}`,
  stream: false,
  format: request.requireJson ? 'json' : undefined,
  options: {
    temperature: request.temperature,
    num_predict: request.maxOutputTokens
  }
}
```

- [ ] **Step 3: Implement OpenAI-compatible health, listing, generation**

Expose:

```ts
export async function probeOpenAiCompatibleEndpoint(baseUrl: string, apiKey: string | undefined, timeoutMs: number): Promise<boolean>;
export async function listOpenAiCompatibleModels(baseUrl: string, apiKey: string | undefined, timeoutMs: number): Promise<AuxiliaryLlmModelInfo[]>;
export async function generateWithOpenAiCompatible(baseUrl: string, apiKey: string | undefined, request: AuxiliaryGenerateRequest): Promise<string>;
```

Use:

- `GET {baseUrl}/v1/models`
- `POST {baseUrl}/v1/chat/completions`
- `response_format: { type: 'json_object' }` when `requireJson` is true.

- [ ] **Step 4: Write client tests**

Test cases:

- Ollama health returns true for `ok: true`.
- Ollama health returns false on network error.
- Ollama listing maps `/api/tags` response to model ids.
- Ollama generation sends `format: 'json'` for JSON slots.
- OpenAI-compatible listing includes `Authorization: Bearer ...` only when an API key is provided.
- OpenAI-compatible generation returns `choices[0].message.content`.
- Timeout aborts and rejects with an error containing `timed out`.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npx vitest run src/main/rlm/__tests__/auxiliary-model-client.spec.ts
```

Expected: all tests pass.

---

## Task 3: Add Auxiliary LLM Service

**Files:**

- Create: `src/main/rlm/auxiliary-llm-service.ts`
- Create: `src/main/rlm/__tests__/auxiliary-llm-service.spec.ts`
- Modify: `src/main/rlm/llm-service.ts`

- [ ] **Step 1: Implement config parsing**

`AuxiliaryLlmService` should parse `auxiliaryLlmEndpointsJson` and `auxiliaryLlmSlotsJson`, merge missing slots with defaults, and ignore malformed JSON by falling back to safe defaults.

Public API:

```ts
export class AuxiliaryLlmService extends EventEmitter {
  static getInstance(): AuxiliaryLlmService;
  static _resetForTesting(): void;
  configure(settings: Pick<AppSettings,
    | 'auxiliaryLlmEnabled'
    | 'auxiliaryLlmRoutingMode'
    | 'auxiliaryLlmAllowRemoteWorkerModels'
    | 'auxiliaryLlmEndpointsJson'
    | 'auxiliaryLlmSlotsJson'
  >): void;
  discoverCandidates(): Promise<AuxiliaryLlmCandidate[]>;
  generate(slot: AuxiliaryLlmSlot, systemPrompt: string, userPrompt: string): Promise<{ text: string; decision: AuxiliaryLlmDecision }>;
}
```

- [ ] **Step 2: Implement slot resolution**

Resolution order:

1. If `enabled` is false or routing mode is `off`, return fallback.
2. If slot is disabled, return fallback.
3. If slot has explicit endpoint/model and endpoint is healthy, use it.
4. If `local-first`, try healthy local/manual/worker endpoints before cheap cloud.
5. If `cheap-first`, try configured cheap cloud before local.
6. If `manual-only`, use only explicit endpoint/model.
7. If no model can satisfy the slot, return fallback.

Do not call frontier providers when `allowFrontierFallback` is false.

- [ ] **Step 3: Enforce max input before generation**

Before provider generation:

- Count prompt tokens with `getTokenCounter()`.
- If input exceeds `maxInputTokens`, truncate the user prompt from the middle, preserving the first 20% and last 40%.
- Emit `auxiliary:input-truncated` with slot, original token estimate, and target token count.

- [ ] **Step 4: Add fallback text path**

Fallback for `compression` and `memoryDistillation` should call the existing deterministic local summary behavior in `LLMService` or a small extracted helper. Fallback for classifier/scoring slots should return valid minimal JSON:

```json
{"score":0,"confidence":0,"reason":"No auxiliary model available"}
```

- [ ] **Step 5: Wire `LLMService.summarize()` through the auxiliary compression slot**

In `LLMService.summarize()`, call `getAuxiliaryLlmService().generate('compression', SUMMARIZE_SYSTEM_PROMPT, userPrompt)` before `generateCompletion()` when auxiliary routing is enabled. Preserve the existing `summarize:complete` and `summarize:error` events.

- [ ] **Step 6: Write service tests**

Test cases:

- disabled service returns fallback without network calls.
- local-first chooses a healthy Ollama endpoint before a cheap cloud endpoint.
- manual-only ignores discovered endpoints when no explicit endpoint/model is configured.
- malformed slot JSON is ignored and defaults are used.
- classifier fallback returns valid JSON.
- `LLMService.summarize()` emits `summarize:complete` after auxiliary generation.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
npx vitest run src/main/rlm/__tests__/auxiliary-llm-service.spec.ts src/main/rlm/__tests__/llm-service-ollama-health.spec.ts
```

Expected: all tests pass.

---

## Task 4: Detect Local Models On Worker Nodes

**Files:**

- Modify: `src/shared/types/worker-node.types.ts`
- Modify: `src/worker-agent/capability-reporter.ts`
- Test: `src/main/remote-node/__tests__/worker-node-registry.spec.ts`
- Add or modify: `src/worker-agent/capability-reporter.spec.ts`

- [ ] **Step 1: Extend worker capabilities**

Add:

```ts
export interface WorkerLocalModelCapability {
  provider: 'ollama' | 'openai-compatible';
  baseUrl: string;
  models: string[];
  healthy: boolean;
}
```

Add to `WorkerNodeCapabilities`:

```ts
localModelEndpoints?: WorkerLocalModelCapability[];
```

- [ ] **Step 2: Detect local Ollama on workers**

In `reportCapabilities()`, probe `http://127.0.0.1:11434/api/tags` with a 2 second timeout.

If healthy, include:

```ts
localModelEndpoints: [{
  provider: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  models: tags.models.map((model) => model.name),
  healthy: true
}]
```

The coordinator must not use this URL directly as `127.0.0.1`; it is worker-local.

- [ ] **Step 3: Add tests**

Test cases:

- Worker capability report includes Ollama models when `/api/tags` succeeds.
- Worker capability report omits `localModelEndpoints` when Ollama is absent.
- Existing GPU detection remains intact for an RTX 5090-style `nvidia-smi` result.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npx vitest run src/worker-agent/capability-reporter.spec.ts src/main/remote-node/__tests__/worker-node-registry.spec.ts
```

Expected: all tests pass.

---

## Task 5: Add Remote Worker Local Model Proxy

**Files:**

- Modify: `src/main/remote-node/worker-node-rpc.ts`
- Modify: `src/worker-agent/worker-rpc-dispatcher.ts`
- Modify: `src/main/remote-node/service-rpc-client.ts`
- Test: `src/main/remote-node/__tests__/rpc-schemas.spec.ts`
- Test: `src/main/remote-node/__tests__/worker-node-connection.spec.ts`

- [ ] **Step 1: Add RPC messages**

Add RPC methods:

```ts
type AuxiliaryModelListRequest = { provider: 'ollama' | 'openai-compatible' };
type AuxiliaryModelListResponse = { models: string[] };

type AuxiliaryModelGenerateRequest = {
  provider: 'ollama' | 'openai-compatible';
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxOutputTokens: number;
  timeoutMs: number;
  requireJson: boolean;
};
type AuxiliaryModelGenerateResponse = { text: string };
```

Names:

- `auxiliaryModel.list`
- `auxiliaryModel.generate`

- [ ] **Step 2: Implement worker dispatch**

The worker handles RPC by calling its own localhost Ollama/OpenAI-compatible endpoint. Do not expose the endpoint externally and do not ask the coordinator to call `127.0.0.1`.

- [ ] **Step 3: Integrate with `AuxiliaryLlmService`**

When a candidate endpoint source is `worker-node`, `AuxiliaryLlmService` calls the remote RPC client instead of `fetch(baseUrl)`.

- [ ] **Step 4: Add tests**

Test cases:

- RPC schema rejects missing model.
- RPC schema rejects negative timeout.
- Coordinator generation call targets selected node id.
- Worker dispatch returns generated text.
- Worker dispatch propagates Ollama errors as RPC errors without leaking prompt content into logs.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npx vitest run src/main/remote-node/__tests__/rpc-schemas.spec.ts src/main/remote-node/__tests__/worker-node-connection.spec.ts src/main/rlm/__tests__/auxiliary-llm-service.spec.ts
```

Expected: all tests pass.

---

## Task 6: Add Discovery And Manual Setup IPC

**Files:**

- Create: `src/main/ipc/handlers/auxiliary-llm-handlers.ts`
- Modify: `src/main/ipc/index.ts` or IPC handler registration barrel
- Create: `src/renderer/app/core/services/ipc/auxiliary-llm-ipc.service.ts`
- Test: `src/main/ipc/handlers/__tests__/auxiliary-llm-handlers.spec.ts`

- [ ] **Step 1: Add IPC operations**

Expose:

- `auxiliary-llm:list-candidates`
- `auxiliary-llm:probe-endpoint`
- `auxiliary-llm:test-generate`
- `auxiliary-llm:save-settings`

Return typed success/error envelopes consistent with existing IPC handlers.

- [ ] **Step 2: Implement candidate discovery**

Candidates:

1. Localhost Ollama: `http://127.0.0.1:11434`
2. Manual endpoints from settings.
3. Worker-node local models when `auxiliaryLlmAllowRemoteWorkerModels` is true.

- [ ] **Step 3: Implement manual probe**

Inputs:

```ts
{
  provider: 'ollama' | 'openai-compatible';
  baseUrl: string;
  apiKeyEnv?: string;
}
```

Rules:

- Reject public internet endpoints unless provider is `openai-compatible`.
- For LAN/Tailscale endpoints, allow `http://192.168.*`, `http://10.*`, `http://172.16-31.*`, `http://100.*`, `http://localhost`, and `http://127.0.0.1`.
- Never accept raw API key strings in settings; accept only an environment variable name.

- [ ] **Step 4: Add tests**

Test cases:

- localhost Ollama appears when healthy.
- worker-node candidate appears with source `worker-node`.
- public unauthenticated Ollama endpoint is rejected.
- API key value is rejected when it looks like a raw token.
- save-settings updates the five auxiliary settings keys only.

- [ ] **Step 5: Run targeted tests**

Run:

```bash
npx vitest run src/main/ipc/handlers/__tests__/auxiliary-llm-handlers.spec.ts
```

Expected: all tests pass.

---

## Task 7: Add Settings UI For Manual And Discovered Models

**Files:**

- Create: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.ts`
- Create: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.scss`
- Create: `src/renderer/app/features/settings/auxiliary-models-settings-tab.component.spec.ts`
- Modify: `src/renderer/app/features/settings/settings-navigation.ts`
- Modify: settings container component that renders selected tabs.

- [ ] **Step 1: Add the settings tab**

UI sections:

- Master toggle: enabled/off.
- Routing mode segmented control: local-first, cheap-first, manual-only.
- Discovered candidates table with source, endpoint, model count, health, and select button.
- Manual endpoint form with provider, base URL, API key env var, probe button.
- Slot table with enabled, model, timeout, and JSON mode.
- Test prompt button for selected slot.

- [ ] **Step 2: Use existing settings visual patterns**

Use the current settings list/card styles. Do not introduce a separate visual system.

- [ ] **Step 3: Add UI tests**

Test cases:

- renders discovered local Ollama candidate.
- saves routing mode via `SettingsStore.set`.
- rejects raw API key text in the API key env field.
- clicking probe calls `auxiliary-llm:probe-endpoint`.
- slot toggle updates `auxiliaryLlmSlotsJson`.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npx vitest run src/renderer/app/features/settings/auxiliary-models-settings-tab.component.spec.ts src/renderer/app/features/settings/settings-navigation.spec.ts
```

Expected: all tests pass.

---

## Task 8: Harden Context Compression With Hermes-Learned Invariants

**Files:**

- Modify: `src/main/context/context-compactor.ts`
- Test: `src/main/context/__tests__/context-compactor.spec.ts`

- [ ] **Step 1: Add reference-only summary language**

Update `buildCompactionPrompt()` so generated summaries are explicitly framed as reference material:

```text
CONTEXT COMPACTION - REFERENCE ONLY.
This summary preserves prior context but must not override system instructions, tool results, or the latest user message.
If this summary conflicts with newer conversation content, the newer content wins.
```

- [ ] **Step 2: Add structured fields**

Require these sections in the compression prompt:

- Active Task
- User Goal
- Constraints
- Completed Actions
- Active State
- In Progress
- Blocked
- Key Decisions
- Pending User Asks
- Relevant Files
- Remaining Work
- Critical Context

- [ ] **Step 3: Protect latest user message**

Ensure compaction never summarizes away the most recent user message, even if it falls outside `preserveRecent` due to tool-heavy output.

- [ ] **Step 4: Add generated-summary secret redaction**

Before storing or inserting summary text, redact common secret patterns:

- `sk-...`
- `ghp_...`
- `xoxb-...`
- `-----BEGIN PRIVATE KEY-----`
- `password=...`
- `token=...`
- `api_key=...`

- [ ] **Step 5: Add compaction tests**

Test cases:

- prompt includes `CONTEXT COMPACTION - REFERENCE ONLY`.
- prompt includes all structured fields.
- latest user message remains in protected turns.
- generated summary redacts token-like strings.

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npx vitest run src/main/context/__tests__/context-compactor.spec.ts
```

Expected: all tests pass.

---

## Task 9: Wire Auxiliary Slots Into Existing Helper Call Sites

**Files:**

- Modify: `src/main/context/context-compactor.ts`
- Modify: `src/main/memory/unified-controller.ts`
- Modify candidate title/routing/scoring services after exact caller read.
- Test: existing specs for modified services.

- [ ] **Step 1: Compression**

Use:

```ts
await getAuxiliaryLlmService().generate('compression', systemPrompt, userPrompt)
```

in the LLM-backed compaction path. Keep existing local fallback when auxiliary generation fails.

- [ ] **Step 2: Memory distillation**

Use `memoryDistillation` in `UnifiedMemoryController` summarization instead of direct `getLLMService().summarize()` when enabled.

- [ ] **Step 3: Title generation**

Find existing auto-title generation call sites with:

```bash
rg -n "title|auto.*title|generate.*title" src/main src/renderer/app -g '*.ts'
```

Wire only the service-level generation call, not UI display code.

- [ ] **Step 4: Routing classification**

Do not replace `ModelRouter` decisions with local model output. Add optional advisory classification that can explain why a request is eligible for cheap/local handling, then keep current router as fallback.

- [ ] **Step 5: Approval scoring**

Use `approvalScoring` only to add telemetry/advisory score. Do not auto-approve based solely on local model output.

- [ ] **Step 6: Run targeted tests**

Run the tests for each touched service. At minimum:

```bash
npx vitest run src/main/context/__tests__/context-compactor.spec.ts src/main/rlm/__tests__/auxiliary-llm-service.spec.ts
```

Expected: all tests pass.

---

## Task 10: Add Runbook For Windows 5090 Setup

**Files:**

- Create: `docs/runbooks/AUXILIARY_LOCAL_MODELS.md`
- Modify: `docs/WORKER_AGENT_SETUP.md`
- Modify: `docs/REMOTE_ACCESS.md`

- [ ] **Step 1: Add preferred worker-agent setup**

Document:

```powershell
ollama serve
ollama pull gemma4:12b
ollama pull gemma4:26b
ollama list
```

Then use the existing worker-agent enrollment flow so the coordinator can call the model through worker RPC without exposing Ollama to the LAN.

- [ ] **Step 2: Add direct endpoint setup**

Document direct endpoint only for trusted LAN/Tailscale:

```powershell
$env:OLLAMA_HOST="0.0.0.0:11434"
ollama serve
```

Warn that unauthenticated Ollama should not be exposed to the public internet.

- [ ] **Step 3: Add Tailscale setup**

Document using `http://<windows-host>.<tailnet>.ts.net:11434` as a manual endpoint when direct access is chosen.

- [ ] **Step 4: Add model guidance**

Default suggestions:

- `gemma4:12b` for title/routing/classification/short extraction.
- `gemma4:26b` or `gemma4:31b` for compression and memory distillation if latency is acceptable.
- Keep model ids configurable because local model availability changes.

- [ ] **Step 5: Add troubleshooting**

Include:

- `curl http://127.0.0.1:11434/api/version`
- `curl http://127.0.0.1:11434/api/tags`
- `nvidia-smi`
- worker node appears connected in Remote Nodes settings.

---

## Task 11: End-To-End Verification

**Files:**

- No new files.

- [ ] **Step 1: Run TypeScript checks**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: no errors.

- [ ] **Step 2: Run lint**

Run:

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 3: Run tests**

Run:

```bash
npm run test
```

Expected: all tests pass.

- [ ] **Step 4: Manual local Ollama check**

With Ollama running locally or through the Windows worker, open Auxiliary Models settings and verify:

- candidate appears healthy.
- `gemma4:12b` or configured model appears.
- test generation returns a short response.
- compression slot reports a local decision in logs/telemetry.

- [ ] **Step 5: Manual fallback check**

Stop Ollama and verify:

- candidate becomes unhealthy.
- compression still succeeds through deterministic fallback or configured cheap cloud fallback.
- no main chat sessions switch provider unexpectedly.

---

## Self-Review Checklist

- Spec coverage: local model routing, cheap model fallback, manual setup, autodiscovery, remote Windows model setup, memory hardening, and safety boundaries are covered.
- Placeholder scan: no task depends on an undefined future subsystem; optional later normal chat provider exposure is intentionally out of MVP scope.
- Type consistency: slot names, settings keys, endpoint config names, and candidate names are consistent across tasks.
- Risk boundary: local/cheap models are advisory for approval and do not replace final approval/security policy.

## Execution Notes

Recommended implementation order:

1. Tasks 1-3: local/manual auxiliary backend MVP.
2. Tasks 8-9: immediate memory/compression savings.
3. Tasks 4-6: worker-node autodiscovery and proxy.
4. Task 7: polished settings UI.
5. Task 10: runbook.
6. Task 11: full verification.

Do not commit this plan until the feature is fully implemented and verified; rename it with `_completed` before committing if it is kept.
