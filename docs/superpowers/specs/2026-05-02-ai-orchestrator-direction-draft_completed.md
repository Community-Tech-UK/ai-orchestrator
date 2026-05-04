# AI Orchestrator Direction Draft

**Date:** 2026-05-02
**Status:** Direction draft - not an implementation plan
**Purpose:** Capture what AI Orchestrator is trying to become before designing one narrow slice.

## Why This Exists

AI Orchestrator should not become another isolated chat surface. It should become the operator hub for AI work across the machine, across providers, across local and cloud models, and across time.

The direction is driven by three changes:

- Local models are becoming good enough to handle more real work, especially retrieval, summarization, checking, first-pass review, and bounded child tasks.
- Context windows are growing, which makes project-scale and history-scale memory more useful if the right material is selected and attributed.
- AI work is already fragmented across apps and CLIs. The orchestrator should see that work, continue it where possible, and share useful memory between agents.

## North Star

AI Orchestrator is the conversation, memory, and delegation layer for AI-assisted development.

It should know about relevant AI conversations on the machine, preserve and summarize what mattered, make that context available to future agents, and route work to the best available execution target: local model, local CLI, cloud model, or remote worker node.

## Product Goals

### 1. Conversation Hub

AI Orchestrator should have visibility into AI chats that happen outside the app when their local data is accessible. Codex, Claude Code, Gemini, Copilot, and similar tools should eventually appear in the orchestrator as first-class conversations, not as disconnected logs.

The orchestrator must also be writable. A chat created or continued in AI Orchestrator should be a real provider-backed conversation, not a read-only mirror. Where a provider exposes a stable native session mechanism, AI Orchestrator should be able to resume, continue, and reconcile that session.

For providers whose app storage can safely be written, AI Orchestrator can add best-effort native app visibility. For example, a Codex-backed conversation started in AI Orchestrator should ideally appear in the Codex app if the Codex app's session format and discovery rules are stable enough. This should be handled through provider-specific native-store adapters, not ad hoc file writes.

First-version Codex app visibility is a best-effort target, not a hard launch requirement. The hard requirement is that AI Orchestrator itself is writable, authoritative, resumable, and able to preserve memory and provenance for Codex-backed work.

### 2. Shared Project Memory

The system should treat memory as a shared project asset, not as a property of one chat.

Agents should be able to access:

- important prior decisions,
- relevant previous conversations,
- project conventions,
- mistakes and fixes,
- current goals and unresolved questions,
- useful retrieved source snippets,
- summaries with links back to raw source conversations.

Memory should work across local and cloud models. A local model should not be blind just because it is running locally, and a cloud model should not need the user to manually restate project context every time.

### 3. Local And Remote Delegation

AI Orchestrator should use installed local models and remote machines when that makes sense.

The target environment includes high-memory Apple Silicon machines, a Windows machine with an NVIDIA 5090 GPU, and potential future Mac Studio-class hardware. The orchestrator should treat this as a compute pool with different strengths, not merely as "local vs cloud."

Local models are especially appropriate for:

- file retrieval and codebase search,
- transcript import and summarization,
- memory extraction,
- duplicate or consistency checks,
- first-pass lint-style reasoning,
- low-risk review passes,
- generating candidate plans or questions,
- comparing retrieved context against a narrow claim.

Cloud or stronger frontier models remain better defaults for:

- final architecture decisions,
- edits with broad blast radius,
- security-sensitive conclusions,
- ambiguous product tradeoffs,
- work requiring deep cross-file reasoning,
- final synthesis after child agents disagree.

The routing policy should be explicit and observable. The user should be able to see why work was sent to a local model, cloud model, CLI, or remote node.

## Current Codebase Anchors

This direction should build on existing systems rather than bypass them:

- `src/main/cli/adapters/` already owns provider-specific CLI integration.
- `src/main/cli/adapters/codex/` already has Codex app-server, broker, session scanning, and transcript parsing support.
- `src/main/history/` already stores archived conversations and imports native Claude transcripts.
- `src/main/prompt-history/` already stores prompt recall data by project.
- `src/main/memory/` already contains unified memory, conversation mining, wake context, project memory briefs, hybrid retrieval, episodic memory, procedural memory, and knowledge graph services.
- `src/main/session/` already handles continuity, recall, archive, recovery, fallback history, snapshots, and agent tree persistence.
- `src/main/providers/` already has provider registration, model discovery, and Ollama model discovery.
- `src/main/remote-node/` already has worker-node pairing, capability reporting, GPU detection, and remote execution plumbing.
- `src/main/routing/` already has a basic model router, though it is currently too model-tier focused for local/cloud/remote delegation policy.

## Design Principles

### Orchestrator-Owned Ledger

AI Orchestrator should maintain its own canonical conversation ledger. External provider stores are sources and sync targets, not the only source of truth.

This gives us stable IDs, project memory links, provenance, permissions, and recovery even when provider-specific storage changes.

### Native Adapters, Not One-Off Imports

Each external chat source should have a native conversation adapter with explicit capabilities:

- discover external conversations,
- import or refresh conversation metadata,
- read raw transcript content,
- map native IDs to orchestrator IDs,
- continue or resume when supported,
- write back or expose to the native app when safely supported,
- detect conflicts and external edits.

Read-only import may be an early capability for safety, but it is not the product goal.

### Source-Attributed Memory

Every memory item should carry source attribution. If an agent says "we decided X last week," the orchestrator should be able to point to the conversation, message, child result, or imported transcript that produced that claim.

Memory without provenance will become untrustworthy as the system scales.

### Tiered Memory, Not One Giant Prompt

The memory system should build context in layers:

- identity and project rules,
- active task state,
- recent conversation state,
- high-confidence project facts,
- relevant historical snippets,
- raw transcript retrieval only when needed.

Growing context windows help, but they do not remove the need for selection, deduplication, freshness, and conflict detection.

### Delegation Requires Boundedness

Local delegation should not be "send anything cheap to local." A task is a good local child task when it is bounded, has clear inputs, has a verifiable output, and does not require irreversible edits without supervision.

Routing should consider:

- task type,
- required context depth,
- expected output risk,
- model capability,
- local hardware availability,
- privacy constraints,
- cost and latency,
- whether a stronger model will verify or synthesize the result.

### Reconciliation Over Blind Sync

If the same conversation can be changed by AI Orchestrator and an external app, sync must be reconciled. The system should detect divergence and preserve both sides rather than silently overwriting.

## Capability Pillars

### Pillar A: Conversation Fabric

The conversation fabric is the shared model for all chats, whether they started in AI Orchestrator or elsewhere.

It needs:

- stable orchestrator conversation IDs,
- provider/native session IDs,
- project/workspace association,
- parent/child relationships,
- message timeline,
- transcript storage,
- native source metadata,
- sync status,
- conflict status,
- resume/write capabilities.

### Pillar B: Memory Fabric

The memory fabric turns conversations and project activity into useful context.

It needs:

- raw transcript storage,
- mined verbatim segments,
- summaries,
- durable project facts,
- decisions and rationale,
- unresolved questions,
- learned workflows,
- retrieval indices,
- source links,
- conflict and freshness markers.

### Pillar C: Compute Fabric

The compute fabric knows what can run where.

It needs:

- local CLI/provider availability,
- local Ollama or OpenAI-compatible model availability,
- remote worker node capabilities,
- GPU and memory capacity,
- concurrency limits,
- model capability metadata,
- privacy and permission policy,
- routing decisions with explanations.

### Pillar D: Orchestration UX

The UI should make cross-chat and cross-agent work understandable.

It needs:

- all relevant conversations visible in one place,
- clear source labels for imported/native/orchestrator-created chats,
- memory cards or context previews with provenance,
- routing explanations for delegated work,
- child task outputs that can be promoted to memory,
- conflict and sync status that does not require reading logs.

## Initial Program Shape

This should be split into separate specs and implementation waves.

### Wave 1: Conversation Inventory And Canonical Ledger

Create the shared conversation model and provider adapter boundary. Start with Codex and Claude because there is already code for both. The first useful outcome is that external and orchestrator-created conversations appear in one indexed place with stable IDs and source metadata.

This wave should not require final native write-back into every provider app, but it must design for writability from the beginning. Codex app visibility should be attempted where safe, but failure to expose an Orchestrator-created conversation inside the Codex app should not block the first version.

### Wave 2: Project Memory From Conversations

Connect the ledger to project memory. Imported and orchestrator-created conversations should feed project memory briefs, session recall, conversation mining, and wake context with source attribution.

The output should be better context at agent start and better retrieval during a task.

### Wave 3: Local Model And Worker Routing Policy

Extend model/provider routing from simple tier selection into a policy engine that can choose local, cloud, CLI, or remote worker execution. Start with bounded child tasks and retrieval/checking jobs, then expand only where quality evidence supports it.

### Wave 4: Safe Native Write-Back

For providers with stable stores or APIs, add native write-back so AI Orchestrator-origin conversations can appear in external apps and external app changes can be reconciled.

This is deliberately separate because write-back can corrupt provider stores if implemented casually.

## Open Questions

- Should AI Orchestrator be the only authoritative conversation ledger, or should specific providers remain authoritative for some sessions?
- Which provider-native visibility targets should move from best-effort to hard requirements after the first writable Orchestrator slice?
- Which external chat sources matter most after Codex and Claude Code?
- How should private or sensitive conversations be excluded from shared memory?
- Should memory promotion be automatic, user-reviewed, or hybrid?
- What is the minimum quality bar before a local model can perform a child task without cloud verification?
- Should local models be used for embeddings and reranking before they are used for language generation?
- How much raw transcript should be retained, and what should be redacted before indexing?
- How should conflicts be surfaced when an external app and AI Orchestrator both modify the same conversation?

## Non-Goals For The First Implementation Slice

- Do not rewrite all provider adapters at once.
- Do not assume every external app supports safe write-back.
- Do not send broad, high-risk coding tasks to local models just because they are cheaper.
- Do not build memory as a prompt dump.
- Do not create untraceable memory facts without source links.
- Do not couple the memory model to one provider's native session format.

## Success Criteria

AI Orchestrator is moving in the right direction when:

- a user can find relevant prior AI conversations without remembering which app created them,
- a new agent receives useful project context from prior work without manual restatement,
- memory items can be traced back to source conversations,
- local and remote models are used for bounded tasks where they add speed, privacy, or cost advantages,
- routing decisions are explainable,
- provider-native chat visibility improves without risking silent data corruption,
- the system remains useful even if one provider changes its local storage format.
