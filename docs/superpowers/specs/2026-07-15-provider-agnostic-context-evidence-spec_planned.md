# Provider-Agnostic Context Evidence Architecture

**Date:** 2026-07-15  
**Status:** Approved by James's explicit implementation request on 2026-07-15; active and uncommitted  
**Implementation plan:** `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan.md`  
**Scope:** Interactive AIO conversations and agentic turns across Codex, Claude, Gemini, and Copilot

## Summary

AIO will separate durable evidence from the provider's active context window. Every complete tool result visible to AIO remains available for the lifetime of the conversation, while each provider receives a bounded working set made from current intent, recent dialogue, validated evidence cards, and exact retrieved excerpts. Provider-native evidence that AIO cannot observe in full is recorded as an explicit capability gap rather than represented as complete. A shared safety controller manages context pressure and cumulative processing through staged, proof-backed actions. Provider adapters expose capabilities and execute provider-specific controls, but do not own retention policy.

This architecture is provider-agnostic. Codex is the first stress case because its 258,400-token window exposes runaway retention sooner than Claude's one-million-token window. A larger window changes absolute capacity, not the evidence lifecycle or safety policy.

## Incident and problem statement

The motivating Codex turn began at 20,344 input tokens, then made 44 tool calls and 45 model requests. Tool outputs added 900,532 characters, including 580,831 characters from web research, 278,427 from shell/file/database work, and 41,274 from tool discovery. Current occupancy reached 246,825 of 258,400 tokens (95.52%), while cumulative processing reached 5,693,312 tokens. The context meter was accurate; the failure was unbounded retained evidence and disabled cost recovery.

The same failure mode exists with every provider:

- Tool output is treated as transcript content rather than durable evidence.
- Larger windows delay pressure but permit more expensive repeated requests.
- Provider-native compaction can lose exact source detail and behaves differently by provider.
- AIO's existing output cache, microcompaction, generic compaction, provider-specific governor, and diagnostics operate at different layers.
- The renderer groups tool activity without showing the actual retained bytes or request count.
- A summary can become the only surviving representation of a source even when accuracy requires the original.

The architecture must control cost and occupancy without reducing factual, diagnostic, or verification accuracy.

## Goals

1. Preserve every complete tool result AIO can observe byte-for-byte for the lifetime of its conversation, and report provider-native visibility gaps explicitly.
2. Keep provider working context bounded independently of provider window size.
3. Make important claims traceable to exact stored evidence spans.
4. Share retention and pressure policy across Codex, Claude, Gemini, and Copilot.
5. Use provider-native compaction and interruption only through explicit capability contracts and observed proof.
6. Prevent automatic recovery from duplicating side effects.
7. Survive crashes, restarts, key rotation, partial writes, and storage corruption without silent evidence loss.
8. Make current occupancy, cumulative processing, evidence storage, and interventions separately visible.
9. Delete conversation evidence predictably when the conversation is deleted.
10. Roll out incrementally with shadow decisions and per-provider kill switches.

## Non-goals

- Replacing provider-native transcript storage.
- Treating generated summaries as authoritative evidence.
- Importing old temporary output-cache files or provider-event captures as trusted evidence.
- Rebuilding every provider integration around one lowest-common-denominator transport.
- Allowing unlimited retrieval merely because raw evidence is stored externally.
- Silently truncating required system instructions, the latest user request, or current task state.
- Cross-conversation evidence deduplication in the first implementation. Conversation-scoped storage is simpler to secure and delete correctly.
- Solving general project memory, semantic memory, or code indexing beyond evidence created during a conversation.

## Design principles

1. **Raw evidence is durable; context is a working set.** Context eviction never deletes evidence.
2. **Summaries are indexes, not truth.** A card must point back to exact content.
3. **Provider capacity is not retention policy.** Claude and Codex follow the same proportional budget.
4. **Capabilities are explicit.** AIO never assumes it can rewrite a native transcript.
5. **Proof precedes recovery.** Interrupt and compaction acknowledgements are not completion proof.
6. **Failure is visible.** Storage, integrity, citation, compaction, and recovery failures cannot silently downgrade accuracy.
7. **Untrusted evidence stays data.** Tool output and retrieved web content never become instructions.
8. **Policy is pure where possible.** Budgeting, ranking, pressure decisions, and retry decisions are deterministic and directly testable.

## Architecture

### 1. ContextEvidenceCoordinator

`ContextEvidenceCoordinator` is the shared orchestration boundary. It accepts normalized tool lifecycle events, creates capture receipts, finalizes evidence, requests cards, supplies bounded provider results, records context samples, and asks the safety policy for decisions.

It does not know provider protocol details. It depends on:

- `EvidenceStore`
- `EvidenceCardBuilder`
- `WorkingSetPlanner`
- `EvidenceRetrievalService`
- `ContextSafetyPolicy`
- a `ProviderContextCapabilities` projection supplied by the active adapter

The coordinator is the only production entrypoint for new durable evidence. Existing caches and provider adapters delegate to it rather than creating parallel retention rules.

### 2. EvidenceStore

The store uses SQLite for metadata and conversation references, plus authenticated encrypted files for content. Evidence is namespaced to one conversation. Deduplication is allowed within that conversation using a keyed content identifier; cross-conversation deduplication is disabled.

Required records:

```ts
interface EvidenceRecord {
  id: string;
  conversationId: string;
  provider: string;
  providerThreadRef?: string;
  turnRef?: string;
  toolCallRef?: string;
  toolName: string;
  sourceKind: 'command' | 'file' | 'database' | 'web' | 'mcp' | 'browser' | 'other';
  sourceLocator?: string;
  status: 'staging' | 'complete' | 'failed' | 'corrupt' | 'deleted';
  keyedContentId?: string;
  byteCount: number;
  tokenEstimate?: number;
  mimeType: string;
  sensitivity: 'normal' | 'sensitive' | 'restricted';
  provenanceTrust: 'runtime-authenticated' | 'legacy-unverified';
  createdAt: number;
  completedAt?: number;
  keyVersion?: number;
  captureMode: 'pre-retention' | 'post-retention' | 'observed-only';
  captureCompleteness: 'complete' | 'bounded' | 'metadata-only';
  truncationReason?: string;
}
```

The model receives opaque evidence IDs, never storage paths. Retrieval validates conversation ownership and range limits before reading.

#### Crash-safe write sequence

1. Create a metadata receipt in `staging` state.
2. Stream output into an authenticated encrypted staging file.
3. Finalize the keyed content identifier, size, and authentication tag.
4. Flush and atomically rename the blob within the conversation namespace.
5. Commit the completed metadata transaction.
6. Mark the receipt `failed` if finalization cannot complete.
7. Sweep stale staging rows/files and unreferenced finalized blobs after a grace period.

If storage fails before a provider result can be bounded, AIO preserves the original result for accuracy and immediately raises pressure state. It must compact or pause before a known-unbounded result can cause unsafe continuation.

#### Encryption and secrets

- Content uses authenticated encryption with random nonces and versioned keys.
- Key material resides in the OS keychain/safe-storage facility.
- Content identifiers are keyed so metadata does not expose reusable hashes of known private content.
- Rotation re-encrypts blobs incrementally and records key version per blob.
- Plaintext metadata is allowlisted. Full commands, URLs with query strings, file contents, database values, and sensitive locators remain encrypted or are stored only in redacted form.
- Logs contain evidence IDs, classifications, sizes, and status only.
- Secret detection affects sensitivity and export policy; it never prints or summarizes detected values into diagnostics.
- If keychain/safe-storage access is unavailable, AIO does not fall back to durable plaintext storage. It preserves the provider result, marks durable capture unavailable, and compacts or pauses before unsafe continuation.

### 3. EvidenceCardBuilder

The card builder produces a compact, derived index. It runs tool-specific deterministic extraction first and may then use an auxiliary model to improve synthesis.

```ts
interface EvidenceCitation {
  evidenceId: string;
  startByte: number;
  endByte: number;
  contentDigest: string;
}

interface EvidenceCard {
  id: string;
  evidenceId: string;
  version: number;
  status: 'validated' | 'partial' | 'failed';
  summary: string;
  findings: EvidenceFinding[];
  citations: EvidenceCitation[];
  freshness?: { observedAt: number; sourcePublishedAt?: number };
  contradictions: EvidenceContradiction[];
  derivedBy: { kind: 'deterministic' | 'model-assisted'; version: string };
  createdAt: number;
}
```

Deterministic extractors cover at least:

- commands: command class, exit status, duration, changed paths, test counts, warnings;
- files: canonical path, revision/content identity, line ranges, parse status;
- databases: query identity, column names, row count, selected rows, truncation state;
- web: canonical URL, title, retrieval time, publication/update time when available, exact spans;
- browser: URL, page identity, visible state, interaction outcome;
- MCP/dynamic tools: server/tool identity, structured output fields, status.

Model-assisted findings are accepted only when every important claim cites a valid exact span. Invalid citations are rejected. Model-assisted extraction may use only an auxiliary model authorized for the evidence's sensitivity and configured data boundary; otherwise AIO uses deterministic extraction. `bounded` and `metadata-only` records cannot produce claims that imply complete source coverage. A failed card build leaves the raw evidence available and returns a bounded head/tail preview plus retrieval reference; it never substitutes an unverified summary.

Evidence cards and excerpts are wrapped as untrusted source material. Tool output containing instructions cannot override system, developer, user, or task instructions.

### 4. WorkingSetPlanner

Before a managed request, the planner builds the provider-visible working set. For native CLI threads that AIO cannot rebuild, it controls new injections and retrievals while the safety controller uses provider-native compaction at request boundaries.

Selection considers:

- latest user intent and active task state;
- required instructions and tool schemas;
- recency and unresolved decisions;
- task relevance;
- evidence freshness;
- prior citation use;
- contradictions;
- verification importance;
- whether an exact excerpt is still needed after a derived claim has been recorded.

The planner uses provider tokenization when available and a conservative tokenizer/character fallback otherwise. It records estimates separately from provider-reported actual usage.

#### Default context allocation

| Allocation | Default ceiling |
| --- | ---: |
| Instructions, schemas, latest user intent | 15% |
| Recent dialogue and active task state | 15% |
| Evidence cards | 15% |
| Exact retrieved excerpts | 15% |
| Reasoning and answer reserve | 25% |
| Emergency and compaction reserve | 15% |

The normal working set stays at or below 60%. Unused allocation flows to reasoning/answer and emergency reserve, not automatically to more retained evidence.

Required instructions and latest user intent are never blindly truncated. If the required control plane exceeds its target, the planner reports the overage and shrinks lower-priority sections. If it exceeds 30% of the provider window, the request enters a degraded state: route to a larger compatible model when authorized, reduce optional tool schemas/instructions through existing supported mechanisms, or pause visibly. It must not silently drop required instructions.

#### Per-result and retrieval limits

- Inline complete result: at most `min(1% of context window, 4,096 tokens)`, with a 512-token floor.
- Exact retrieval call: the same limit.
- Concurrent exact excerpts: at most the 15% excerpt allocation.
- Evidence cards: at most the 15% card allocation.
- A retrieval that would exceed its allocation must replace lower-ranked excerpts or require an explicit staged rebuild; it cannot simply expand the prompt.

### 5. EvidenceRetrievalService

All providers receive the same logical operations, adapted to their tool surface:

- `evidence.search(query, filters)` returns IDs and bounded card metadata;
- `evidence.read(evidenceId, range)` returns an exact bounded range;
- `evidence.compare(leftId, rightId, ranges?)` returns bounded differences and citations;
- `evidence.verify(citations)` checks ownership, ranges, and digests;
- `evidence.list(turnRef?)` supports task and audit navigation.

Retrieval is conversation-scoped, path-safe, range-bounded, and auditable. Returned excerpts carry evidence and range markers and are treated as untrusted data. Retrieval output is itself subject to the working-set budget but does not create duplicate raw evidence blobs.

### 6. ContextSafetyPolicy

The shared policy consumes provider-reported occupancy when available, cumulative processing, evidence/output growth, model request count, recovery epoch, evidence novelty, and provider capabilities.

```ts
interface ContextPressureSample {
  occupancy: { status: 'known'; used: number; total: number } | { status: 'unknown'; reason: string };
  cumulativeTokens?: number;
  outputBytesSinceCompaction: number;
  providerRequestCount: number;
  newEvidenceCount: number;
  newValidatedFindingCount: number;
  recoveryEpoch: number;
}
```

Current occupancy and cumulative processing are never substituted for each other.

#### Default escalation

| Trigger | Action |
| --- | --- |
| New oversized result | Externalize before retention when capability permits; otherwise record post-retention pressure. |
| 60% known occupancy | Rebuild managed working set and remove superseded previews/excerpts. |
| 75% known occupancy | Request proven provider-native compaction when supported and safe. |
| 85% known occupancy | Stop broad research; require synthesis or targeted retrieval. |
| 92% known occupancy | Controlled interrupt, observed compaction, and same-thread continuation; otherwise pause. |
| 2x context-window cumulative processing in epoch | Emit one warning and require an evidence-progress checkpoint. |
| 4x cumulative processing in epoch | Controlled recovery regardless of current occupancy. |
| Repeated requests without new evidence/findings | Convergence review; do not launch more broad research automatically. |

The policy emits one decision per threshold per epoch. An epoch resets only after observed compaction or a provider-confirmed counter reset. RPC acceptance alone does not reset it.

An implementation may tune thresholds from controlled measurements, but default changes require characterization tests and incident replay. Provider window size scales absolute budgets; it does not disable thresholds.

### 7. Provider capability contract

Adapters expose granular capabilities rather than a single optimistic flag:

```ts
interface ProviderContextCapabilities {
  toolResultControl: 'pre-retention' | 'post-retention' | 'none';
  toolResultVisibility: 'full' | 'bounded' | 'metadata-only' | 'none';
  transcriptControl: 'rebuild' | 'native-compaction' | 'none';
  occupancyReporting: 'current' | 'aggregate-only' | 'none';
  cumulativeReporting: 'available' | 'none';
  interruptProof: 'observed' | 'acknowledged-only' | 'none';
  compactionProof: 'observed' | 'acknowledged-only' | 'none';
  sameThreadContinuation: boolean;
}
```

The UI may summarize adapters as:

- **Managed:** AIO controls results before provider retention and can rebuild the working set.
- **Observed:** AIO cannot rewrite retained native history but receives current usage and can perform proof-backed compaction/recovery.
- **Opaque:** AIO lacks current occupancy or proof-backed controls and therefore uses conservative call/output budgets and visible pauses.

A provider is never classified as managed because it has a large window.

#### Unavoidable native-tool limitation

Some provider-native shell, web, or internal tools may insert output into the provider transcript before AIO receives an event. AIO must record such evidence as `post-retention` or `observed-only`, set `captureCompleteness` truthfully, react at the next provider boundary, and prefer provider configuration/tool instructions that request bounded output. Prompt guidance is defense in depth, not the enforcement mechanism. The UI and accuracy gate must never describe a bounded or metadata-only capture as full raw evidence.

### 8. Accuracy gate

The gate applies stricter checks to evidence-backed research, high-stakes factual output, and completion claims while keeping casual conversation responsive. A response enters evidence-backed mode when the user requests research/audit/verification/current facts, when external tools provide factual support, or when AIO presents citations. Completion mode applies to claims that code, tests, builds, deployments, or external actions succeeded. High-stakes mode follows the existing medical, legal, financial, security, and safety policy boundaries.

Before emitting an important claim:

1. Referenced evidence IDs must exist in the same conversation.
2. Citation ranges and digests must resolve.
3. Freshness requirements must be satisfied or the age disclosed.
4. Known contradictions must be resolved or presented.
5. Model-assisted summaries must not be the sole evidence when raw spans are available.
6. Test/build/runtime claims require current execution receipts.
7. Missing or corrupt evidence lowers confidence visibly and can block a completion claim.
8. Bounded or metadata-only capture is disclosed whenever it limits coverage.

The gate validates evidence linkage; it does not pretend to prove every interpretation true.

### 9. Recovery and failure handling

- **Storage write failure:** keep the original result, mark capture failed, raise pressure, and compact or pause before unsafe continuation.
- **Card failure:** keep evidence, return bounded raw preview/reference, record card failure.
- **Integrity failure:** mark evidence corrupt, refuse citation, surface the failure.
- **Unknown occupancy:** never infer occupancy from cumulative totals; use output/request budgets and conservative pauses.
- **Interrupt unconfirmed:** do not compact or replay; preserve the thread and pause.
- **Compaction unobserved:** do not continue automatically; preserve the thread and pause.
- **Side effects observed or unknown:** do not replay the original task automatically.
- **Recovery ceiling:** after three automatic recoveries in one outer send or one epoch, whichever occurs first, pause for review. Resetting an epoch never resets the outer-send ceiling.
- **Provider disconnect:** preserve durable evidence and runtime identity; resume only through provider-specific proof.

### 10. Renderer and diagnostics

The context surface separates:

- current provider occupancy;
- cumulative processing;
- current working-set tokens;
- evidence cards and exact-excerpt tokens;
- externally stored evidence bytes;
- actual model request count;
- actual tool-call count and result bytes;
- provider enforcement level;
- last pruning, compaction, interruption, continuation, or pause.

Collapsed tool groups show truthful aggregate text such as `44 calls · 900,532 characters · 25 results externalized`. Each call opens its evidence card and, when authorized, the complete stored result.

Diagnostics are content-free by default. They record IDs, classifications, byte/token counts, thresholds, decisions, proof stages, durations, and failure codes. Privacy-safe exports omit provider/conversation identifiers and evidence bodies.

## Integration with existing AIO systems

- `OutputPersistenceManager` becomes a compatibility facade over the evidence capture/store path. Its 24-hour plaintext cache is retired only after reconciliation. Reconciled legacy files are classified `legacy-unverified`, remain visibly limited, and cannot be the sole support for important or completion claims.
- `Microcompact` becomes a working-set transform, not a deletion mechanism.
- `ContextCompactor` continues to summarize conversation state but emits/consumes evidence references.
- `CompactionCoordinator` delegates policy decisions to the shared safety policy and provider actions to adapters.
- The Codex `CodexContextCostController` becomes the Codex observed-mode executor behind the shared decision contract.
- Conversation-ledger provider-event captures remain a forensic stream, not the evidence source of truth; duplicate ingress captures must not create duplicate evidence.
- Capture receipts are idempotent by conversation/tool-call identity and content identity so adapter/runtime duplicate events cannot create duplicate evidence records. The same logical capture key is idempotent only when the keyed content identity also matches; divergent content for a reused key is a visible integrity conflict and never aliases the existing record.
- Existing verification receipts and loop evidence ledgers link to evidence IDs where available.
- RLM, Codemem, and project memory may index validated cards later, but do not own raw conversation evidence.

## Persistence and deletion lifecycle

Evidence remains available across app restarts for the lifetime of the conversation.

Conversation deletion:

1. marks evidence records deleted in the canonical conversation-ledger transaction, using the same conversation identity as transcript deletion;
2. revokes retrieval immediately;
3. queues encrypted blobs for deletion after a short crash-recovery grace period;
4. verifies no live metadata references remain;
5. records content-free deletion evidence;
6. retries failed filesystem deletion without restoring model access.

Because the first implementation does not deduplicate across conversations, deletion does not depend on another conversation's references. Evidence capture requires a canonical conversation identity. Outputs emitted before a provider-native thread exists attach to the existing AIO conversation and are reconciled to the native thread later; native thread identity never replaces conversation ownership.

## Rollout

### Phase 0: Characterize and freeze contracts

- Reproduce the 44-call incident from sanitized fixtures.
- Characterize output cache, microcompaction, compaction, provider capture, and adapter event behavior.
- Define provider capability snapshots without enabling enforcement.

### Phase 1: Durable store and managed capture

- Add encrypted conversation-scoped evidence storage.
- Capture AIO-managed tool results before provider retention.
- Preserve current provider-visible output while shadow cards and budgets are measured.

### Phase 2: Cards, retrieval, and working-set enforcement

- Add deterministic extractors and validated cards.
- Expose shared retrieval operations.
- Enforce inline result and managed working-set budgets.

### Phase 3: Shared safety controller in shadow mode

- Emit decisions without interrupting or compacting.
- Compare estimated working-set and provider-reported occupancy.
- Tune only from controlled evidence.

### Phase 4: Codex observed-mode enforcement

- Complete the existing proof-backed governor live test.
- Enable staged recovery for Codex app-server.
- Keep exec/opaque modes conservative.

### Phase 5: Claude, Gemini, and Copilot parity

- Implement capability contracts and provider-specific live tests.
- Enable managed or observed enforcement per proven capability.

### Phase 6: Renderer, reconciliation, and retirement

- Ship evidence inspection and truthful counters.
- Reconcile old output-cache markers.
- Retire parallel retention paths only after orphan/deletion checks pass.

Every phase has a kill switch. A provider advances only after its focused contract tests and rebuilt-app checks pass.

## Testing strategy

### Pure and property tests

- Working-set allocation never exceeds provider capacity or protected reserves.
- Latest intent and required instructions are never silently dropped.
- Evidence ranking is deterministic for the same inputs.
- One safety decision is emitted per threshold per epoch.
- Cumulative totals never become occupancy.
- Retrieval ranges cannot escape the target evidence record.
- Citation spans and digests resolve exactly.

### Storage and security tests

- Streaming writes, atomic finalize, crash points, orphan cleanup, and disk-full behavior.
- Encryption authentication, wrong-key failure, key rotation, and corruption detection.
- Conversation ownership, deletion revocation, filesystem cleanup retries, and path traversal resistance.
- Secret-bearing fixtures use obvious placeholders and never enter logs or snapshots.
- Prompt-injection content remains labelled untrusted data.

### Provider contract tests

- Managed, observed, and opaque capability combinations.
- Pre-retention and post-retention output paths.
- Current occupancy, aggregate-only usage, and absent usage.
- Interrupt accepted/observed, completion races, unconfirmed interrupt, compaction observed/unobserved, continuation, and recovery ceiling.
- Same-thread identity and no original-message replay.

### Integration and incident replay

- Replay the sanitized 44-call/900,532-character shape.
- Verify byte-for-byte evidence retrieval and exact citations.
- Verify peak occupancy stays below the accepted threshold or proof-backed compaction occurs.
- Compare cumulative/cached tokens with the ungoverned baseline.
- Confirm no duplicate edits or commands during recovery.
- Restart and continue the same conversation.
- Delete the conversation and verify retrieval revocation plus eventual blob deletion.

### Renderer tests

- Occupancy, cumulative processing, working-set, and stored-evidence metrics remain distinct.
- Collapsed groups show actual counts and bytes.
- Full evidence remains inspectable after externalization and restart.
- Failure and degraded states are visible and accessible.

## Acceptance criteria

For the reproduced incident and each supported provider:

1. Every tool result exposed in full to AIO is byte-for-byte retrievable for the conversation lifetime; bounded, metadata-only, and unobservable provider-native results are classified and disclosed.
2. Important final-answer claims resolve to exact evidence spans.
3. At the first provider request boundary at or above 75% known occupancy, AIO begins the configured proof-backed pressure action and completes it before unsafe continuation.
4. Cumulative/cached input is at least 60% lower than the ungoverned baseline when replaying the controlled incident on providers capable of the equivalent workload; other providers must satisfy the shared budget and evidence-integrity invariants.
5. No duplicate side effects occur during recovery.
6. Unknown occupancy never produces a false utilization percentage or an unsafe recycle.
7. Storage, integrity, interruption, and compaction failures are visible and fail safely.
8. Restart preserves evidence, cards, citations, and provider runtime identity.
9. Conversation deletion immediately revokes evidence access and eventually removes every conversation-scoped blob.
10. All targeted tests and the canonical repository verification checklist pass before completion.

## Design decisions

1. Provider-agnostic policy with capability-specific execution.
2. Conversation-lifetime evidence retention.
3. Conversation-scoped encrypted evidence; no initial cross-conversation deduplication.
4. Raw evidence authoritative; cards are validated derived indexes.
5. Proportional budgets shared across providers.
6. Exact retrieval rather than large retained outputs.
7. Native compaction as a staged safety mechanism, not the primary evidence system.
8. Proof-backed interrupt/compact/continue with safe pause on uncertainty.
9. Shadow-first, provider-by-provider rollout.
10. Existing parallel systems are reconciled and retired rather than layered indefinitely.

## Deferred implementation details

The implementation plan must choose concrete table names, migration numbers, IPC channels, and file paths after reading the owning persistence and adapter modules in full. It may tune tokenizer choice, grace periods, and threshold floors only if the design invariants and acceptance criteria remain unchanged. Any change to retention lifetime, provider capability semantics, proof requirements, or accuracy gates requires a design update and written review.
