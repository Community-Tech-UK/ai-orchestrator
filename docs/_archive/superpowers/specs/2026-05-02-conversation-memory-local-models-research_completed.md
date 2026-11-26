# Conversation, Memory, And Local Model Research

**Date:** 2026-05-02
**Status:** Research and architecture note - not an implementation plan
**Related:** `docs/superpowers/specs/2026-05-02-ai-orchestrator-direction-draft.md`

## Executive Summary

AI Orchestrator should move toward three connected capabilities:

1. A canonical conversation ledger that can see, resume, and reconcile provider-native chats.
2. A source-attributed memory layer built from conversations, project state, and child-agent outputs.
3. A compute fabric that can route bounded tasks to local models, local CLIs, cloud models, or remote worker nodes.

The first implementation slice should be **Conversation Ledger + Codex Native Adapter Foundation**. Local model routing and shared memory both depend on trustworthy conversation IDs, source attribution, and transcript normalization. Starting with routing before the ledger would make memory and provenance weaker.

Codex app visibility should be best-effort for the first version. AI Orchestrator itself must be writable and authoritative for Orchestrator-origin chats; provider-native visibility can follow where the provider has stable APIs or stable storage behavior.

## Source-Backed External Findings

### Ollama

Ollama exposes a local native chat API at `POST /api/chat`, including messages, tools, structured output, streaming, and usage fields. It also exposes OpenAI-compatible endpoints under `http://localhost:11434/v1/`, including chat completions and responses. Sources:

- https://docs.ollama.com/api/chat
- https://docs.ollama.com/api/openai-compatibility

Local observation on this machine:

- Ollama server version: `0.21.1`
- Ollama client version: `0.22.0`
- OpenAI-compatible `GET /v1/models` is live on `localhost:11434`
- Installed models visible through Ollama:
  - `kimi-k2.6:cloud`
  - `gemma4:31b`
  - `nemotron-3-nano:30b`

Implication: AI Orchestrator should not need an Ollama CLI adapter for generation. It should use an HTTP model-provider adapter, preferably through the OpenAI-compatible surface first, with native Ollama endpoints used for model details and Ollama-specific operations.

### LM Studio

LM Studio exposes OpenAI-compatible endpoints on its local server, including:

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `POST /v1/completions`

LM Studio also documents Codex integration through its OpenAI-compatible `POST /v1/responses` endpoint and recommends using models with more than about 25k context for Codex-style tool use. Sources:

- https://lmstudio.ai/docs/developer/openai-compat
- https://lmstudio.ai/docs/integrations/codex

Local observation on this machine:

- `lms` CLI is installed.
- LM Studio server is currently off.
- `lms ls --json` reports multiple large local models, including models with long context windows, tool-use metadata, and vision metadata.

Implication: LM Studio should be handled as another OpenAI-compatible local endpoint. Because the server may be off, discovery should be able to report "installed but not serving" separately from "available for execution."

### llama.cpp

`llama-server` exposes REST APIs and a web UI, with OpenAI-compatible chat completions, responses, and embeddings routes, plus GPU/CPU execution options, function calling, schema-constrained JSON output, and monitoring endpoints. Source:

- https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

Implication: llama.cpp should not need a special path initially. It can be supported through a configurable OpenAI-compatible endpoint, then enhanced with optional llama.cpp-specific health and capability probes later.

### vLLM

vLLM provides an HTTP server with OpenAI-compatible APIs, including completions, responses, chat completions, embeddings, audio endpoints, tokenizer endpoints, scoring, and reranking APIs. Source:

- https://docs.vllm.ai/en/latest/serving/openai_compatible_server/

Implication: for the Windows 5090 machine, vLLM or llama.cpp/LM Studio/Ollama can all be exposed to AI Orchestrator as model-serving nodes. The orchestrator should care about endpoint capabilities, hardware, latency, context, and tool support, not the brand of local server first.

### Codex App Server

Codex has an app-server protocol with thread operations such as:

- `thread/start`
- `thread/resume`
- `thread/read`
- `thread/turns/list`
- `thread/fork`
- `thread/archive`
- `thread/unarchive`
- thread metadata and memory-mode operations

The app-server README documents persistent thread operations, read-with-turns behavior, and ephemeral forks. Source:

- https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md

Implication: AI Orchestrator should use Codex app-server as the primary writable integration path. Filesystem JSONL scanning should be a reconciliation and import path, not the only integration mechanism.

## Current Codebase Findings

### Conversation And History

Relevant files:

- `src/main/history/history-manager.ts`
- `src/main/history/native-claude-importer.ts`
- `src/shared/types/history.types.ts`
- `src/main/history/transcript-snippet-service.ts`

Current behavior:

- History is centered on terminated or archived Orchestrator instances.
- Native Claude import exists and stores imported conversations into the existing history archive/index model.
- Imported history source typing currently only covers native Claude.
- History search and transcript snippets already provide useful building blocks for memory and recall.

Gap:

- The current history model is not enough for live provider-native conversations, external changes, sync cursors, writable continuation, and conflict tracking.

Recommendation:

- Keep `HistoryManager` for archives and existing UI behavior.
- Add a canonical conversation ledger beside it, then bridge ledger conversations into history search, transcript snippets, and project memory.

### Codex

Relevant files:

- `src/main/cli/adapters/codex-cli-adapter.ts`
- `src/main/cli/adapters/codex/app-server-client.ts`
- `src/main/cli/adapters/codex/app-server-types.ts`
- `src/main/cli/adapters/codex/session-scanner.ts`
- `src/main/cli/adapters/codex/exec-transcript-parser.ts`
- `src/main/cli/adapters/adapter-factory.ts`

Current behavior:

- Codex app-server support already exists for starting, resuming, listing, naming, compacting, interrupting, and running turns.
- `CodexCliConfig.ephemeral` controls whether a Codex thread is ephemeral.
- `adapter-factory.ts` currently defaults Codex to ephemeral for Orchestrator-owned sessions, so they do not leak into standalone Codex desktop state unless the caller opts out.
- Local Codex rollout JSONL currently uses a `payload.type` event shape. The existing scanner and parser need to be hardened around current payload forms and future format shifts.

Gap:

- There is no provider-native conversation adapter boundary that says which Codex operations are durable, visible, resumable, or best-effort.

Recommendation:

- Use non-ephemeral Codex threads for user-facing durable Codex conversations in AI Orchestrator.
- Keep ephemeral Codex threads for throwaway child tasks, verification runs, debate branches, and experiments.
- Treat app-server as the authoritative writable path and JSONL/import as reconciliation/readback.

### Memory

Relevant files:

- `src/main/memory/conversation-miner.ts`
- `src/main/memory/project-memory-brief.ts`
- `src/main/memory/unified-controller.ts`
- `src/main/memory/wake-context-builder.ts`
- `src/main/session/session-recall-service.ts`
- `src/main/persistence/rlm/rlm-schema.ts`

Current behavior:

- Conversation mining already supports multiple transcript formats, including Codex JSONL.
- Project memory briefs combine prompt history, history transcripts, transcript snippets, and session recall.
- Wake context already has L0/L1 context construction from memory hints.
- RLM schema already has verbatim segments, conversation imports, wake hints, and vector tables.

Gap:

- Memory sources are not yet conversation-ledger native.
- Memory provenance is present in some places but not yet strong enough to support "every claim points back to a conversation/message/source."

Recommendation:

- Feed the memory layer from canonical conversation records.
- Store memory-source links at message or segment granularity.
- Use local models for low-risk memory extraction and summarization, but stage or verify promoted durable memory.

### Local And Remote Compute

Relevant files:

- `src/main/providers/model-discovery.ts`
- `src/shared/types/provider.types.ts`
- `src/shared/types/settings.types.ts`
- `src/main/cli/cli-detection.ts`
- `src/main/cli/adapters/adapter-factory.ts`
- `src/worker-agent/capability-reporter.ts`
- `src/shared/types/worker-node.types.ts`
- `src/main/remote-node/worker-node-registry.ts`
- `src/main/routing/model-router.ts`

Current behavior:

- Ollama model discovery exists in `model-discovery.ts`.
- Shared provider types include `ollama` and `openai-compatible`.
- CLI detection knows about `ollama`.
- `adapter-factory.ts` still falls back when asked for an Ollama adapter.
- Worker capability reporting detects `ollama` but skips it because canonical CLI typing does not include it.
- Remote worker registry can already reason about GPUs, memory, CLI support, active tasks, and latency.
- The current model router is keyword/length/tier based and does not represent local/cloud/remote placement policy.

Gap:

- Local model execution is not first-class.
- Remote worker capabilities do not advertise model-serving endpoints or per-model capabilities.
- Routing does not yet account for privacy, risk, tool requirements, hardware, context length, verification, or provider capabilities.

Recommendation:

- Introduce a local/OpenAI-compatible HTTP model provider.
- Extend worker node capabilities with model-serving endpoints and advertised models.
- Replace or wrap `ModelRouter` with a task-placement router that returns execution target, model, node, risk class, verification requirement, and explanation.

## Proposed Architecture

### 1. Canonical Conversation Ledger

Add a durable ledger with tables or records equivalent to:

#### `conversation_threads`

- `id`
- `provider`
- `nativeThreadId`
- `nativeSessionId`
- `sourceKind`
- `sourcePath`
- `workspacePath`
- `title`
- `createdAt`
- `updatedAt`
- `lastSyncedAt`
- `writable`
- `nativeVisibilityMode`
- `syncStatus`
- `conflictStatus`
- `parentConversationId`
- `metadataJson`

#### `conversation_messages`

- `id`
- `threadId`
- `nativeMessageId`
- `turnId`
- `role`
- `phase`
- `content`
- `createdAt`
- `tokenInput`
- `tokenOutput`
- `rawRef`
- `rawJson`
- `sourceChecksum`

#### `conversation_sync_cursors`

- `provider`
- `sourcePath`
- `nativeThreadId`
- `lastSeenMtime`
- `lastSeenOffset`
- `lastSeenEventId`
- `lastImportVersion`

#### `conversation_memory_links`

- `conversationId`
- `messageId`
- `memoryObjectType`
- `memoryObjectId`
- `confidence`
- `extractionModel`
- `createdAt`

This ledger should not immediately replace every history surface. It should become the canonical substrate that history search, memory, and session recall can consume.

### 2. Provider Native Conversation Adapter

Define a provider-neutral adapter contract:

```typescript
interface NativeConversationAdapter {
  provider: string;
  getCapabilities(): NativeConversationCapabilities;
  discover(scope: ConversationDiscoveryScope): Promise<DiscoveredConversation[]>;
  readThread(ref: NativeConversationRef, options?: ReadThreadOptions): Promise<NativeConversationThread>;
  startThread(request: StartNativeThreadRequest): Promise<NativeConversationThread>;
  resumeThread(ref: NativeConversationRef): Promise<NativeConversationHandle>;
  sendTurn(handle: NativeConversationHandle, request: NativeTurnRequest): Promise<NativeTurnResult>;
  updateMetadata(ref: NativeConversationRef, patch: NativeThreadMetadataPatch): Promise<void>;
  reconcile(ref: NativeConversationRef, ledgerThread: LedgerThread): Promise<ReconciliationResult>;
}
```

Capability flags should include:

- `canDiscover`
- `canRead`
- `canResume`
- `canSendTurn`
- `canCreateDurableThread`
- `canCreateEphemeralThread`
- `canUpdateTitle`
- `canArchive`
- `canWriteNativeStore`
- `nativeVisibility`
- `conflictDetection`

Codex should be the first adapter. Claude Code should follow because native import already exists. Gemini and Copilot can begin as read/import-only until their native storage and write paths are understood.

### 3. Memory Pipeline

The memory pipeline should become:

1. Provider/native conversation adapter imports or updates the ledger.
2. Ledger normalizer emits provider-neutral transcript segments.
3. Conversation miner extracts candidate facts, decisions, unresolved questions, and useful verbatim snippets.
4. Local or cloud model summarizes/extracts memory candidates depending on risk and context size.
5. Memory promotion stores source-attributed items and links them back to conversation messages.
6. Project memory brief, session recall, wake context, and retrieval use those links.

Important behavior:

- Store raw transcript references, not only summaries.
- Prefer fresh, source-attributed, project-scoped memory over global prompt dumps.
- Track conflicts when new conversations contradict older memory.
- Allow private conversations to be excluded from memory.

### 4. Local Model Provider

Introduce a model provider that can call local HTTP endpoints:

- Ollama OpenAI-compatible: `http://localhost:11434/v1`
- LM Studio: `http://localhost:1234/v1`
- llama.cpp: user-configured, commonly `http://localhost:8080/v1`
- vLLM: user-configured, commonly `http://localhost:8000/v1`
- Remote Windows 5090 endpoint: user-configured or discovered through worker node capability reporting.

Minimum interface:

- list models
- chat completion or responses
- embeddings if supported
- structured output if supported
- tool-call support if supported
- health check
- token usage extraction
- cancellation/timeout
- concurrency limits

Capability metadata:

- `backend`
- `baseUrl`
- `modelId`
- `contextWindow`
- `supportsTools`
- `supportsVision`
- `supportsStructuredOutput`
- `supportsEmbeddings`
- `supportsResponsesApi`
- `supportsChatCompletions`
- `locality`
- `hardware`
- `estimatedVramOrRam`
- `qualityTier`
- `trustLevel`

The model provider should not be called "Ollama adapter" in the execution layer. Ollama is one discovery/runtime backend; the durable abstraction is local or OpenAI-compatible model serving.

### 5. Task Placement Router

Replace the current simple tier router with a policy router:

```typescript
interface TaskPlacementDecision {
  target: 'local-model' | 'local-cli' | 'cloud-model' | 'remote-worker' | 'hybrid';
  provider: string;
  model?: string;
  nodeId?: string;
  risk: 'low' | 'medium' | 'high';
  confidence: number;
  requiresVerification: boolean;
  verifyWith?: string;
  reason: string;
}
```

Inputs:

- task class
- expected context size
- required tools
- file-write requirement
- privacy class
- risk class
- model capabilities
- provider availability
- hardware and node availability
- cost and latency preference
- user preference
- project policy

Good local-model tasks:

- transcript import summaries
- memory extraction candidates
- duplicate detection
- narrow consistency checks
- codebase search synthesis over retrieved snippets
- first-pass review with citations
- test-output explanation
- "find relevant files" and "compare these snippets" tasks

Poor first-version local-model tasks:

- broad architecture final decisions
- high-blast-radius edits
- security-sensitive conclusions
- final answer synthesis when evidence conflicts
- unbounded autonomous coding
- native-store write-back without a stronger verifier

### 6. Remote Model Serving

The Windows 5090 machine should be represented as a worker node that can advertise both hardware and model-serving capabilities.

Extend worker capability reporting with:

- model server processes and URLs
- reachable base URLs from the coordinator
- model list and loaded/unloaded state
- context window
- tool and structured-output support
- embedding/rerank support
- GPU name and VRAM
- concurrency limit
- current load

Routing should be able to choose:

- local Mac Ollama for a quick low-risk summary,
- LM Studio on Mac for a specific long-context local model,
- Windows 5090 vLLM/llama.cpp/LM Studio for heavier local inference,
- cloud/frontier model for synthesis or verification.

## Recommended Implementation Waves

### Wave 1: Conversation Ledger And Codex Native Adapter

Deliverables:

- Ledger schema and service.
- Provider-native conversation adapter interface.
- Codex adapter backed by app-server for durable start/resume/read/send-turn.
- JSONL reconciliation/import path hardened against current Codex payload shapes.
- UI read model showing ledger conversations with source and sync state.
- Tests using fixtures for current Codex rollout JSONL and app-server response shapes.

Why first:

- It gives stable conversation IDs, provenance, and resumability.
- It unlocks memory with source links.
- It avoids building local-model routing on top of weak transcript ownership.

### Wave 2: Ledger-To-Memory Integration

Deliverables:

- Conversation-ledger transcript source for conversation mining.
- Memory links back to conversation/message IDs.
- Project memory brief updated to include ledger-derived memory.
- Privacy/exclusion flag for conversations.
- Candidate memory staging for local-model extraction.

### Wave 3: OpenAI-Compatible Local Model Provider

Deliverables:

- Configurable OpenAI-compatible endpoint provider.
- Built-in discovery probes for Ollama and LM Studio.
- Model capability registry.
- Health checks, cancellation, timeouts, and usage accounting.
- Basic local-model smoke test action.

### Wave 4: Task Placement Router And Local Child Tasks

Deliverables:

- Policy router for local/cloud/CLI/remote placement.
- Bounded local child task runner.
- Verification policy.
- UI/execution logs showing why a task was delegated locally.
- First supported tasks: transcript summaries, memory extraction candidates, duplicate checks, and retrieval synthesis.

### Wave 5: Remote Model Node Capabilities

Deliverables:

- Worker capability reporter advertises model-serving endpoints and models.
- Coordinator can route local-model tasks to a remote worker node.
- Windows 5090 machine can be used for heavier local inference.
- Load and concurrency are visible in routing decisions.

### Wave 6: Native Write-Back And Reconciliation

Deliverables:

- Provider-specific write-back where safe.
- Conflict detection and preservation of both sides.
- Codex native visibility upgraded from best-effort if app-server/storage behavior is reliable.
- Claude/Gemini/Copilot write paths assessed separately.

## Data And Safety Rules

- Do not write directly into provider stores until the adapter has explicit support and tests.
- Do not silently overwrite external conversation changes.
- Do not promote local-model-extracted memory without provenance.
- Do not let private/import-excluded conversations feed shared memory.
- Do not use local models for high-risk final decisions without verification.
- Do not treat context-window size as a replacement for retrieval, ranking, and source attribution.

## First Concrete Spec To Write Next

Write a detailed implementation spec for:

**Conversation Ledger + Codex Native Adapter Foundation**

The spec should include:

- ledger schema,
- migration strategy,
- adapter interface,
- Codex durable vs ephemeral behavior,
- current Codex JSONL fixture coverage,
- read/write/resume flow,
- UI read model,
- memory-source hooks,
- verification commands.

This is the correct first slice because it creates the substrate for both shared memory and local model delegation without forcing risky native write-back or broad local autonomy too early.
