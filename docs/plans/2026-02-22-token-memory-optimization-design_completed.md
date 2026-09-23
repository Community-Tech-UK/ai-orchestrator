# Token & Memory Optimization Suite

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](2026-09-23-outstanding-plans-sweep_plan_completed.md)): CLOSED.** See the reconciliation
> block in `2026-02-22-token-memory-optimization-plan_completed.md` for the per-task disposition.

**Date:** 2026-02-22
**Status:** Design Approved
**Scope:** 7 improvements to reduce token usage and improve memory management across the orchestrator

## Overview

Cross-referencing latest 2025-2026 research (NeurIPS, ACL, arXiv) against the orchestrator's existing token/memory systems reveals 7 concrete improvement opportunities. The orchestrator already has sophisticated infrastructure (RLM, Memory-R1, smart compaction, prompt caching, JIT loader, unified memory controller). These improvements target gaps and apply recent findings to existing systems.

### Research Sources

| Technique | Source | Key Finding |
|-----------|--------|-------------|
| Observation Masking | JetBrains/NeurIPS 2025 (arXiv:2508.21433) | Simple masking matches LLM summarization at half the cost |
| Token-Efficient Tool Use | Anthropic (Feb 2026) | Up to 70% output token reduction on tool calls |
| SupervisorAgent | "Stop Wasting Your Tokens" (arXiv:2510.26585) | LLM-free context filter reduces tokens 23-39% |
| AgentDropout | ACL 2025 (aclanthology.org/2025.acl-long.1170) | Dynamic agent pruning: 21.6% prompt token reduction |
| Observational Memory | Mastra/VentureBeat 2026 | Event-based logs cut costs 10x vs prose summaries |
| Prompt Compression | LLMLingua/Microsoft | 20x compression with minimal quality loss |
| Graph Memory | Mem0g (arXiv:2504.19413) | Conflict detection prevents memory corruption |

### Priority Order

| # | Improvement | Effort | Token Savings | Risk |
|---|------------|--------|---------------|------|
| 1 | Observation Masking | Low | 30-50% on compaction | Very low |
| 2 | Token-Efficient Tool Use | Very low | ~14% output tokens | None |
| 3 | Output Supervisor | Medium | 23-39% per agent | Low |
| 4 | AgentDropout for Multi-Verify | Medium | ~20% on verification | Medium |
| 5 | Event-Based Decision Logs | Medium | 10x storage, 50% compaction LLM | Low |
| 6 | Prompt Compression for Children | High | Up to 2.5x on child context | Medium |
| 7 | Graph Memory + Conflict Detection | High | Indirect (quality) | Medium |

---

## Improvement 1: Observation Masking

### Problem

`SmartCompactionManager` and `SessionCompactor` call LLM to summarize old turns. Most old turns are tool outputs (file reads, search results) that carry little reasoning value after a few turns but consume significant tokens during summarization.

### Design

Add a pre-pass in `smart-compaction.ts` that replaces tool outputs older than N turns with a one-line placeholder before any LLM summarization runs. Only conversational/reasoning turns get expensive LLM summaries.

### Changes

**File: `src/main/rlm/smart-compaction.ts`**

New method:
```typescript
maskStaleToolOutputs(session: RLMSession, turnsThreshold: number): MaskingResult {
  // Walk session turns from oldest to newest
  // For each turn older than (currentTurn - turnsThreshold):
  //   If turn contains tool output:
  //     Replace content with: "[Tool output masked: {toolName} at turn {N} — {tokenCount} tokens freed]"
  //     Track tokens freed
  // Return { maskedCount, tokensFree }
}
```

Integration point — called at the start of `performCompaction()`:
```typescript
async performCompaction(session, store, reason) {
  // NEW: mask tool outputs first (cheap, no LLM)
  const maskResult = this.maskStaleToolOutputs(session, this.config.clearToolOutputsAfterTurns);

  // EXISTING: if still over threshold, apply tiered summarization (expensive LLM)
  if (this.stillOverThreshold(session)) {
    const classification = this.classifyContent(session);
    await this.applySummarizationTier(session, classification);
  }
}
```

### Config

Uses existing `clearToolOutputsAfterTurns` (default: 10). No new config needed.

### Mask Format

```
[Tool output masked: {toolName} at turn {N} — {tokenCount} tokens freed]
```

Preserves tool name and turn number for traceability without consuming tokens.

### Expected Impact

- 30-50% reduction in compaction LLM costs
- Near-zero risk — tool outputs are already cleared after N turns, this just does it more efficiently
- Hybrid approach (mask + summarize) saves additional 7-11% vs either alone (per JetBrains research)

---

## Improvement 2: Token-Efficient Tool Use

### Problem

The `AnthropicApiProvider` doesn't opt into Anthropic's token-efficient tool use beta header, missing up to 70% output token reduction on tool-calling responses.

### Design

Add the `token-efficient-tools-2025-05-14` beta header when constructing the Anthropic SDK client.

### Changes

**File: `src/main/providers/anthropic-api-provider.ts`**

In `initialize()`, add beta header to client constructor:
```typescript
this.client = new Anthropic({
  apiKey: config.apiKey,
  defaultHeaders: {
    ...(config.enableTokenEfficientTools !== false
      ? { 'anthropic-beta': 'token-efficient-tools-2025-05-14' }
      : {}),
  },
});
```

**File: `src/shared/types/provider.types.ts`**

Extend `ProviderConfig`:
```typescript
enableTokenEfficientTools?: boolean;  // default: true
```

### Expected Impact

- Average 14% output token reduction (up to 70% on tool-heavy interactions)
- Zero risk — behavior is identical, only encoding efficiency changes
- ~10 lines of code

---

## Improvement 3: Output Supervisor

### Problem

No mechanism detects when child instances enter repetitive loops or produce excessively verbose output. Tokens are wasted until manual intervention or context overflow.

### Design

New `OutputSupervisor` singleton with two heuristic detectors — no LLM calls required.

### Architecture

```
instance:output event
       │
       ▼
┌──────────────────┐
│ OutputSupervisor  │
│                  │
│  ┌─────────────┐ │     Auto-truncate
│  │ Verbose     │─┼──── (truncated output returned to pipeline)
│  │ Detector    │ │
│  └─────────────┘ │
│                  │
│  ┌─────────────┐ │     Alert parent
│  │ Loop        │─┼──── supervisor:loop-detected event
│  │ Detector    │ │
│  └─────────────┘ │
└──────────────────┘
```

### Changes

**New file: `src/main/process/output-supervisor.ts`**

```typescript
export interface OutputSupervisorConfig {
  /** Max tokens for a single tool output before truncation (default: 8000) */
  maxToolOutputTokens: number;
  /** Lines to keep from head and tail when truncating (default: 50 each) */
  truncateKeepLines: number;
  /** Sliding window size for loop detection (default: 5) */
  loopWindowSize: number;
  /** Jaccard similarity threshold for loop detection (default: 0.8) */
  loopSimilarityThreshold: number;
  /** Min consecutive similar outputs to trigger loop alert (default: 3) */
  loopMinConsecutive: number;
  /** Enable verbose truncation (default: true) */
  enableVerboseTruncation: boolean;
  /** Enable loop detection (default: true) */
  enableLoopDetection: boolean;
}

export class OutputSupervisor extends EventEmitter {
  private static instance: OutputSupervisor;
  private outputWindows: Map<string, OutputWindow>; // instanceId → sliding window

  // A) Verbose Output Truncation — automatic, immediate
  processOutput(instanceId: string, output: OutputMessage): OutputMessage {
    if (this.isToolOutput(output) && this.estimateTokens(output) > config.maxToolOutputTokens) {
      return this.truncateToHeadTail(output);
      // Format: first N lines + "[{X} tokens truncated]" + last N lines
    }
    return output;
  }

  // B) Loop Detection — alert parent, no auto-action
  checkForLoop(instanceId: string, output: OutputMessage): void {
    const window = this.getWindow(instanceId);
    window.push(this.extractNGrams(output));
    if (window.length >= config.loopMinConsecutive) {
      const similarities = this.computePairwiseSimilarity(window.lastN(config.loopMinConsecutive));
      if (similarities.average > config.loopSimilarityThreshold) {
        this.emit('supervisor:loop-detected', {
          instanceId,
          consecutiveCount: config.loopMinConsecutive,
          averageSimilarity: similarities.average,
          suggestion: 'Instance may be stuck in a loop'
        });
      }
    }
  }
}
```

**File: `src/main/instance/instance-communication.ts`**

Hook supervisor into output pipeline:
```typescript
setupAdapterEvents(instanceId, adapter) {
  const supervisor = getOutputSupervisor();

  adapter.on('output', (message) => {
    // NEW: run through supervisor before processing
    const processed = supervisor.processOutput(instanceId, message);
    supervisor.checkForLoop(instanceId, processed);

    // EXISTING: emit to listeners
    this.emit('instance:output', { instanceId, message: processed });
  });
}
```

### Behavior

| Detection | Action | Latency |
|-----------|--------|---------|
| Verbose tool output (>8K tokens) | Auto-truncate to head+tail | Immediate, in-pipeline |
| Loop detected (3+ similar outputs) | Emit `supervisor:loop-detected` | Immediate, non-blocking |

Parent instance receives loop alerts and can choose to:
- Send a redirect message to the child
- Terminate the child
- Ignore (if the repetition is expected)

### Expected Impact

- 23-39% token reduction per agent session (per research)
- Zero LLM cost — pure heuristic processing
- Low risk — truncation preserves head/tail for context, loop detection is advisory only

---

## Improvement 4: AgentDropout for Multi-Verify & Debate

### Problem

`MultiVerifyCoordinator` spawns N agents and waits for all to complete, even when early responses already show strong consensus. The debate system runs all rounds even when agents converge early.

### Design

Add early termination with conservative 80% similarity threshold.

### Changes

**File: `src/main/orchestration/multi-verify-coordinator.ts`**

New method and modified verification flow:
```typescript
interface EarlyTerminationConfig {
  /** Similarity threshold for consensus (default: 0.8) */
  consensusThreshold: number;
  /** Min agents before early termination is considered (default: minSuccessfulAgents) */
  minAgentsForConsensus: number;
  /** Enable early termination (default: true) */
  enabled: boolean;
}

// Called as each agent response arrives
async checkEarlyConsensus(responses: AgentResponse[]): Promise<boolean> {
  if (responses.length < this.config.earlyTermination.minAgentsForConsensus) {
    return false;
  }

  const embeddings = await Promise.all(
    responses.map(r => this.embeddingService.getEmbedding(r.content))
  );

  const avgSimilarity = this.computeAveragePairwiseSimilarity(embeddings);
  return avgSimilarity >= this.config.earlyTermination.consensusThreshold;
}
```

Modified `runVerification()` flow:
```typescript
async runVerification(request) {
  // Spawn all agents concurrently
  const agentPromises = agents.map(a => this.runAgent(request, a));

  // Collect responses as they arrive
  const responses: AgentResponse[] = [];
  for await (const response of raceAll(agentPromises)) {
    responses.push(response);

    // NEW: check for early consensus
    if (await this.checkEarlyConsensus(responses)) {
      // Cancel remaining agents
      this.cancelPendingAgents(request.id);
      logger.info('Early consensus reached', {
        respondedAgents: responses.length,
        totalAgents: agents.length,
        tokensSaved: this.estimateSavedTokens(agents.length - responses.length)
      });
      break;
    }
  }

  return this.analyzeResponses(responses, request.config);
}
```

**File: `src/main/orchestration/debate-coordinator.ts`**

Add consensus check between rounds:
```typescript
async runDebate(debate) {
  await this.runInitialRound(debate);
  await this.runCritiqueRound(debate);

  // NEW: check if positions converged after critique
  if (this.config.skipDefenseOnConsensus) {
    const converged = await this.checkPositionConvergence(debate);
    if (converged) {
      logger.info('Debate converged after critique round, skipping defense');
      return this.synthesizeResponses(debate);
    }
  }

  await this.runDefenseRound(debate);
  return this.synthesizeResponses(debate);
}
```

### Expected Impact

- ~20% token reduction on multi-agent verification
- Potentially larger savings on debates that converge early (skip entire round)
- Conservative threshold (0.8) minimizes risk of missing minority insights
- Uses existing `EmbeddingService` — no new dependencies

---

## Improvement 5: Event-Based Decision Logs

### Problem

Session compaction produces prose summaries via LLM calls. These are expensive to generate, imprecise to search, and lose structured detail.

### Design

Replace prose summaries with structured observation events using a hybrid extraction approach (heuristic + lightweight LLM).

### Data Model

```typescript
interface ObservationEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  turn: number;
  type: 'decision' | 'discovery' | 'error' | 'tool_result' | 'task_progress' | 'preference';
  priority: 1 | 2 | 3;  // 1=critical, 2=important, 3=informational
  content: string;       // One sentence max (~20-50 tokens)
  metadata?: Record<string, string>;
  sourceType: 'heuristic' | 'llm_extracted';
}
```

### Extraction Pipeline

```
Turn to compact
       │
       ▼
┌──────────────┐     tool_result events (no LLM)
│ Heuristic    │────────────────────────────────────┐
│ Extractor    │     error events (pattern match)   │
│              │────────────────────────────────────┤
│              │     decision events (DECISION: tag)│
│              │────────────────────────────────────┤
└──────┬───────┘                                    │
       │ conversational turns only                  │
       ▼                                            │
┌──────────────┐     1-3 events per turn            │
│ LLM Haiku    │────────────────────────────────────┤
│ Extractor    │     (structured output prompt)     │
└──────────────┘                                    │
                                                    ▼
                                          ┌──────────────┐
                                          │ Observation   │
                                          │ Store (SQLite)│
                                          └──────────────┘
```

### Changes

**New file: `src/main/rlm/observation-extractor.ts`**

```typescript
export class ObservationExtractor {
  // Heuristic extraction — no LLM
  extractFromToolResult(turn: ArchivedTurn): ObservationEvent[] {
    // Parse tool name, success/failure, key output metrics
    // Return structured event(s)
  }

  extractFromPatterns(turn: ArchivedTurn, patterns: RegExp[]): ObservationEvent[] {
    // Match against preservePatterns (DECISION:, ERROR:, etc.)
    // Extract the tagged content as events
  }

  // LLM extraction — Haiku, structured output
  async extractFromConversation(turn: ArchivedTurn): Promise<ObservationEvent[]> {
    // Prompt: "Extract 1-3 key observations from this conversation turn.
    //          Each observation should be one sentence.
    //          Classify as: decision/discovery/error/task_progress/preference.
    //          Assign priority 1-3."
    // Uses structured output for reliable parsing
  }
}
```

**File: `src/main/rlm/session-compactor.ts`**

Replace `generateArchiveSummary()`:
```typescript
async compact(session) {
  const turnsToArchive = this.selectTurnsToArchive(session);

  // NEW: extract structured events instead of prose summary
  const extractor = getObservationExtractor();
  const events: ObservationEvent[] = [];

  for (const turn of turnsToArchive) {
    if (this.isToolOutput(turn)) {
      events.push(...extractor.extractFromToolResult(turn));
    } else if (this.matchesPreservePatterns(turn)) {
      events.push(...extractor.extractFromPatterns(turn, this.config.preservePatterns));
    } else {
      events.push(...await extractor.extractFromConversation(turn));
    }
  }

  await this.storeObservations(session.id, events);
  this.archiveTurns(session.id, turnsToArchive);

  // FALLBACK: if extraction yields < 1 event per 5 turns, generate prose summary
  if (events.length < turnsToArchive.length / 5) {
    const summary = await this.generateArchiveSummary(turnsToArchive);
    await this.storeCompactionSummary(session.id, turnsToArchive, summary);
  }
}
```

**Database: `src/main/persistence/rlm-database.ts`**

New table:
```sql
CREATE TABLE IF NOT EXISTS session_observations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  turn INTEGER NOT NULL,
  type TEXT NOT NULL,
  priority INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  source_type TEXT NOT NULL DEFAULT 'heuristic',
  embedding BLOB,
  FOREIGN KEY (session_id) REFERENCES rlm_sessions(id)
);

CREATE INDEX idx_observations_session ON session_observations(session_id);
CREATE INDEX idx_observations_type ON session_observations(type);
CREATE INDEX idx_observations_priority ON session_observations(priority);
```

### Expected Impact

- 10x storage reduction vs prose summaries
- 50%+ reduction in compaction LLM calls (most events extracted heuristically)
- Faster, more precise search via structured fields + embeddings
- Fallback to prose ensures no information loss

---

## Improvement 6: Parent Context Compression for Children

### Problem

Child instances receive the last 10 parent messages uncompressed, wasting child context budget on verbose content that could be compressed.

### Design

Extractive compression using existing TF-IDF infrastructure — no external model needed.

### Algorithm

```
Parent messages (last 10)
       │
       ▼
┌─────────────────────┐
│ Sentence Tokenizer  │  Split into sentences
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ TF-IDF Scorer       │  Score each sentence against child's task description
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Preserve Filter     │  Always keep: code blocks, structured data, URLs
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Threshold Filter    │  Keep sentences above score threshold
└──────────┬──────────┘
           │
           ▼
Compressed context (target: 50% of original)
```

### Changes

**New file: `src/main/context/parent-context-compressor.ts`**

```typescript
export interface CompressionConfig {
  /** Target compression ratio (default: 0.5 = keep 50%) */
  targetRatio: number;
  /** Min tokens to trigger compression (default: 500) */
  minTokensToCompress: number;
  /** Always preserve code blocks (default: true) */
  preserveCodeBlocks: boolean;
  /** Always preserve URLs and file paths (default: true) */
  preserveReferences: boolean;
}

export class ParentContextCompressor {
  constructor(private tokenCounter: TokenCounter) {}

  compress(parentMessages: string[], childTaskDescription: string, config: CompressionConfig): string {
    const totalTokens = this.tokenCounter.countTokens(parentMessages.join('\n'));
    if (totalTokens < config.minTokensToCompress) {
      return parentMessages.join('\n');
    }

    const sentences = this.tokenize(parentMessages);
    const scored = this.scoreSentences(sentences, childTaskDescription);
    const preserved = this.applyPreservationRules(scored, config);
    const filtered = this.filterByThreshold(preserved, config.targetRatio);

    return this.reassemble(filtered);
  }

  private scoreSentences(sentences: Sentence[], taskDescription: string): ScoredSentence[] {
    // Use TF-IDF similarity between each sentence and the task description
    // Higher score = more relevant to child's task
  }
}
```

**File: `src/main/instance/instance-orchestration.ts`**

Integration point:
```typescript
async createChildInstance(parentId, command, routing) {
  const parentContext = this.getRecentParentMessages(parentId, 10);

  // NEW: compress parent context before injection
  const compressor = getParentContextCompressor();
  const compressed = compressor.compress(
    parentContext,
    command,  // child's task description
    { targetRatio: 0.5 }
  );

  // Inject compressed context into child
  child.initialContext = compressed;
}
```

### Expected Impact

- Up to 2.5x compression on parent context injected into children
- No external model dependencies — uses existing TF-IDF
- Code blocks and structured data preserved verbatim
- Low risk — extractive compression only removes, never rewrites

---

## Improvement 7: Graph Memory with Conflict Detection

### Problem

Memory-R1 does ADD/UPDATE/DELETE/NOOP but has no conflict detection. An UPDATE can silently replace a correct memory with a hallucinated or context-dependent observation.

### Design

Add conflict detection layer and typed graph edges to `MemoryManagerAgent`.

### Architecture

```
New content arrives
       │
       ▼
┌──────────────────┐
│ Memory-R1        │  Proposes: UPDATE entry #42
│ Decision Engine  │
└──────────┬───────┘
           │
           ▼
┌──────────────────┐         ┌────────────────┐
│ ConflictDetector │────────►│ Heuristic Pass │
│                  │         │ (negation,     │
│                  │         │  antonym,      │
│                  │         │  value change) │
│                  │         └───────┬────────┘
│                  │                 │ ambiguous?
│                  │                 ▼
│                  │         ┌────────────────┐
│                  │         │ LLM Fallback   │
│                  │         │ (Haiku)        │
│                  │         └───────┬────────┘
└──────────────────┘                 │
           │                         │
           ▼                         ▼
   ┌───────────────┐         ┌───────────────┐
   │ No Conflict   │         │ Conflict Found│
   │ → Apply UPDATE│         │ → Mark both   │
   │               │         │   'contested' │
   └───────────────┘         └───────────────┘
```

### Changes

**New file: `src/main/memory/conflict-detector.ts`**

```typescript
export interface ConflictResult {
  hasConflict: boolean;
  type?: 'contradiction' | 'value_change' | 'negation' | 'temporal_override';
  confidence: number;  // 0-1
  existingEntryId: string;
  reasoning?: string;
}

export class ConflictDetector {
  // Phase 1: Heuristic checks (no LLM)
  heuristicCheck(newContent: string, existingContent: string): ConflictResult | null {
    // Check for negation patterns: "X is Y" vs "X is not Y"
    // Check for value changes: "timeout is 30s" vs "timeout is 60s"
    // Check for antonyms: "enabled" vs "disabled", "success" vs "failure"
    // Return null if ambiguous → triggers LLM fallback
  }

  // Phase 2: LLM fallback for ambiguous cases (Haiku — cheap)
  async llmCheck(newContent: string, existingContent: string, linkedEntries: MemoryEntry[]): Promise<ConflictResult> {
    // Prompt: "Do these two statements contradict each other?
    //          Statement A: {existing}
    //          Statement B: {new}
    //          Related context: {linked entries}
    //          Answer: { hasConflict: bool, type: string, confidence: 0-1 }"
  }
}
```

**File: `src/shared/types/memory-r1.types.ts`**

Extend types:
```typescript
// Add to MemoryEntry
interface MemoryEntry {
  // ... existing fields ...
  status: 'active' | 'contested' | 'archived';
}

// Add edge types to linked entries
interface MemoryLink {
  targetId: string;
  edgeType: 'related' | 'supports' | 'contradicts' | 'supersedes';
  createdAt: string;
}

// Replace linkedEntries: string[] with:
linkedEntries: MemoryLink[];
```

**File: `src/main/memory/r1-memory-manager.ts`**

Integrate conflict detection into decision pipeline:
```typescript
async decideOperation(context, candidateContent, taskId) {
  const decision = await this.baseDecision(context, candidateContent, taskId);

  // NEW: if UPDATE, check for conflicts
  if (decision.operation === 'UPDATE' && decision.targetEntryId) {
    const existing = this.state.entries.get(decision.targetEntryId);
    if (existing) {
      const detector = getConflictDetector();
      const conflict = detector.heuristicCheck(candidateContent, existing.content)
        ?? await detector.llmCheck(candidateContent, existing.content, this.getLinkedEntries(existing));

      if (conflict.hasConflict && conflict.confidence > 0.7) {
        // Don't replace — mark both as contested
        return {
          operation: 'CONTEST' as MemoryOperation,
          targetEntryId: decision.targetEntryId,
          conflictResult: conflict,
          reasoning: `Conflict detected (${conflict.type}): preserving both versions`
        };
      }
    }
  }

  return decision;
}
```

**Auto-resolution:**
```typescript
// After N successful task completions using one version of a contested entry
async checkContestedResolution(entryId: string): Promise<void> {
  const entry = this.state.entries.get(entryId);
  if (entry?.status !== 'contested') return;

  const contestedPair = this.getContestedPair(entryId);
  if (!contestedPair) return;

  // Compare access counts and outcome scores
  const [a, b] = contestedPair;
  if (a.accessCount >= 3 && a.relevanceScore > b.relevanceScore + 0.2) {
    b.status = 'archived';
    a.status = 'active';
    // Update edge: a supersedes b
    a.linkedEntries.push({ targetId: b.id, edgeType: 'supersedes', createdAt: new Date().toISOString() });
  }
}
```

**Database: `src/main/persistence/rlm-database.ts`**

New table for conflict tracking:
```sql
CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY,
  entry_a_id TEXT NOT NULL,
  entry_b_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  confidence REAL NOT NULL,
  resolved_at TEXT,
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (entry_a_id) REFERENCES memory_entries(id),
  FOREIGN KEY (entry_b_id) REFERENCES memory_entries(id)
);

CREATE INDEX idx_conflicts_unresolved ON memory_conflicts(resolved_at) WHERE resolved_at IS NULL;
```

### Expected Impact

- Prevents silent memory corruption from hallucinated or context-dependent observations
- Auto-resolution ensures contested entries don't accumulate indefinitely
- Graph edges (supports/contradicts/supersedes) enable richer retrieval
- Heuristic-first approach keeps LLM costs low (Haiku only for ambiguous cases)

---

## Testing Strategy

Each improvement should have:

1. **Unit tests** for new classes/methods
2. **Integration tests** verifying correct hookup with existing systems
3. **Token counting tests** measuring actual savings vs baseline

Key test scenarios:
- Observation masking: verify tool outputs are masked, reasoning turns preserved
- Token-efficient tools: verify beta header is sent, responses still parse correctly
- Output supervisor: verify truncation format, loop detection thresholds
- AgentDropout: verify early termination fires at correct similarity, doesn't fire below threshold
- Event extraction: verify heuristic extraction for tool results, LLM extraction for conversation
- Context compression: verify code blocks preserved, compression ratio within target
- Conflict detection: verify contradiction caught, contested status set, auto-resolution works

---

## Non-Goals

- No changes to the core RLM context manager architecture
- No new external model dependencies (LLMLingua requires GPT-2/LLaMA — excluded in favor of extractive compression)
- No changes to the Angular frontend (all improvements are main-process only)
- No changes to CLI adapter interfaces
