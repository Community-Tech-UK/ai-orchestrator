# Token & Memory Optimization Suite — Implementation Plan

> **RECONCILED 2026-09-04** (gate G5 of `2026-09-03-enhancements-backlog_plan.md`, task W4.1).
> This plan sat unsuffixed since February while parts of it silently shipped. Verified against
> today's tree by reading the executing call paths, not by grepping for symbol names:
>
> | Task | State | Evidence |
> |---|---|---|
> | 1 — Observation masking in smart compaction | **SHIPPED** | `maskStaleToolOutputs` defined at `src/main/rlm/smart-compaction.ts:706` and called on the live compaction path at `:463`. |
> | 2 — Token-efficient tool-use header | **SHIPPED, differently than specified** | **Correction 2026-09-06 (adversarial second pass on the W4.6 wave gate): the prior "no header anywhere" claim was false** — `token-efficient-tools-2025-02-19` is sent on every Anthropic API call: `anthropic-api-provider.ts:278` (standard `.create()` path), `:495` (`.countTokens()` path), and `context-editing-fallback.ts:322` (the context-editing fallback path, via its `betas` array). It differs from Task 2's spec in three ways: applied per-request inside each call rather than via `defaultHeaders` at client construction; uses beta version `2025-02-19` rather than the spec's `2025-05-14`; and has no `enableTokenEfficientTools` config toggle to disable it — it is unconditional. Functionally shipped; the original spec's exact shape (configurable, set once at init) was not followed. |
> | 3–5 — Output supervisor (truncation, loop detection, pipeline wiring) | **NOT SHIPPED** | No `OutputSupervisor` symbol exists. Superseded in intent by T7 of the enhancements plan (truncate-to-disk + prune on the CHILD session), which targets the loop path this one never reached. |
> | 6–7 — AgentDropout (early consensus, debate round skipping) | **NOT SHIPPED** | No `AgentDropout` symbol exists. |
> | 8–9 — Event-based decision logs | **NOT SHIPPED** | No `DecisionLog` / `decision_logs` symbol or table. |
> | 10 — Parent context compression | **NOT SHIPPED** | No implementation. Overlaps T10 of the enhancements plan (bootstrap caps on a fresh window). |
> | 11–12 — Conflict detector for Memory-R1 | **SHIPPED** | `src/main/memory/conflict-detector.ts`, exported from `memory/index.ts:100`, and genuinely wired: `observation-store.ts:72` calls `detectObservationConflicts` from `storeObservation`, which calls `getConflictDetector().heuristicCheck` at `:517`. |
> | 13 — Final integration verification | **NOT RUN** | Blocked on the tasks above. |
>
> **Decision:** the shipped tasks (1, 2, 11, 12) are done and need no further work. Task 2's
> deviation from spec (unconditional, per-request, older beta version) is accepted as-is — nobody
> has asked to disable token-efficient-tools, so the missing config toggle is not a gap worth
> building for. The rest are
> DEFERRED rather than abandoned — tasks 3–5 and 10 are partly superseded by T7/T10 of the
> enhancements plan, which aim the same idea at the loop transcript (the surface that actually
> costs money) instead of the RLM session objects this plan targeted. Do not implement 3–5 or 10
> from here without first checking those items.
>
> This plan therefore stays open only for tasks 6–9 and 13. Nothing under `src/main/context/`
> should be edited against this document without re-reading this block first (G5).


> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement 7 token/memory optimizations that reduce costs 20-50% across compaction, verification, child spawning, and memory management.

**Architecture:** Each improvement is independent and can be implemented/tested in isolation. Order follows priority: quick wins first (Tasks 1-2), then medium-effort improvements (Tasks 3-5), then higher-effort features (Tasks 6-7). All changes are main-process only — no frontend changes.

**Tech Stack:** TypeScript, Vitest, EventEmitter pattern, SQLite (better-sqlite3), Anthropic SDK

**Design Doc:** `docs/plans/2026-02-22-token-memory-optimization-design.md`

---

## Task 1: Observation Masking in Smart Compaction

**Files:**
- Modify: `src/main/rlm/smart-compaction.ts`
- Test: `src/main/rlm/smart-compaction.spec.ts` (create)

**Step 1: Write the failing tests**

Create `src/main/rlm/smart-compaction.spec.ts` with tests for:
- `maskStaleToolOutputs()` masks tool outputs older than threshold, preserving recent ones
- Returns zero maskedCount when no tool outputs are old enough
- Mask placeholder includes tool name and token count

Use helpers to create mock `RLMSession` objects with `ContextQueryResult` arrays containing both `tool_output` and `message` type results at various turn indices.

Key assertions:
- Old tool outputs (turn index < totalQueries - threshold) are replaced with `[Tool output masked: {toolName} at turn {N} — {tokenCount} tokens freed]`
- Recent tool outputs and all message-type results are untouched
- `maskedCount` and `tokensFreed` are accurate

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/rlm/smart-compaction.spec.ts`
Expected: FAIL — `maskStaleToolOutputs` method does not exist

**Step 3: Implement observation masking**

Add `MaskingResult` interface and `maskStaleToolOutputs()` method to `SmartCompactionManager`:
- Walk session queries from oldest to newest
- For queries older than `(totalQueries - turnsThreshold)`, replace `tool_output` type results with mask placeholder
- Use `this.tokenCounter.countTokens()` for accurate token tracking
- Emit `tool_outputs_cleared` event via existing `SmartCompactionEvent` system

Integrate into `performCompaction()` — call `maskStaleToolOutputs()` as the first operation, before `classifyContent()`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/rlm/smart-compaction.spec.ts`
Expected: PASS

**Step 5: Type check**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

**Step 6: Commit**

Stage `src/main/rlm/smart-compaction.ts` and `src/main/rlm/smart-compaction.spec.ts`.
Message: "feat: add observation masking pre-pass to smart compaction"

---

## Task 2: Token-Efficient Tool Use Header

**Files:**
- Modify: `src/main/providers/anthropic-api-provider.ts`
- Modify: `src/main/providers/anthropic-api-provider.spec.ts`

**Step 1: Write the failing test**

Add tests to `anthropic-api-provider.spec.ts`:
- Verifies the Anthropic constructor is called with `anthropic-beta: 'token-efficient-tools-2025-05-14'` header by default
- Verifies the header is omitted when `enableTokenEfficientTools: false`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/providers/anthropic-api-provider.spec.ts`
Expected: FAIL — no beta header being passed

**Step 3: Implement the change**

In `anthropic-api-provider.ts`:
1. Add `enableTokenEfficientTools?: boolean` to `AnthropicApiProviderConfig` interface
2. In `initialize()`, modify line ~176 where `this.client = new Anthropic({ apiKey })` to include `defaultHeaders` with the beta header, gated on `this.options.enableTokenEfficientTools !== false`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/providers/anthropic-api-provider.spec.ts`
Expected: PASS

**Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 6: Commit**

Stage both files. Message: "feat: enable token-efficient tool use beta header"

---

## Task 3: Output Supervisor — Verbose Truncation

**Files:**
- Create: `src/main/process/output-supervisor.ts`
- Create: `src/main/process/output-supervisor.spec.ts`

**Step 1: Write the failing tests for verbose truncation**

Test cases:
- Truncates tool_result outputs exceeding `maxToolOutputTokens`
- Preserves tool outputs under the threshold
- Never truncates assistant messages regardless of length
- Truncated output includes head and tail sections with truncation marker
- Metadata on truncated output includes `truncatedBySupervisor: true` and `originalTokens`

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/process/output-supervisor.spec.ts`
Expected: FAIL — module does not exist

**Step 3: Implement OutputSupervisor**

Create `OutputSupervisor` singleton following the project's singleton pattern:
- `processOutput(instanceId, output)` — checks if tool_result, estimates tokens, truncates to head+tail if over threshold
- Config: `maxToolOutputTokens` (8000), `truncateKeepLines` (50)
- Uses `getTokenCounter()` for estimation
- Truncation format: `{head}\n\n[... {N} lines, ~{M} tokens truncated ...]\n\n{tail}`

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/process/output-supervisor.spec.ts`
Expected: PASS

**Step 5: Type check**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`

**Step 6: Commit**

Stage both files. Message: "feat: add OutputSupervisor with verbose tool output truncation"

---

## Task 4: Output Supervisor — Loop Detection

**Files:**
- Modify: `src/main/process/output-supervisor.ts`
- Modify: `src/main/process/output-supervisor.spec.ts`

**Step 1: Write the failing tests for loop detection**

Test cases:
- Emits `supervisor:loop-detected` when 3+ consecutive outputs are highly similar (Jaccard > 0.8)
- Does not emit for diverse outputs
- Tracks loops per instance independently
- `cleanupInstance()` clears the window, preventing false triggers after cleanup

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/process/output-supervisor.spec.ts`
Expected: FAIL — `checkForLoop` does not exist

**Step 3: Implement loop detection**

Add to `OutputSupervisor`:
- `checkForLoop(instanceId, output)` — extracts n-grams, pushes to sliding window, computes pairwise Jaccard similarity
- `extractNGrams(text, n)` — splits text into word n-grams
- `jaccardSimilarity(a, b)` — set intersection / set union
- Uses `outputWindows: Map<string, string[][]>` for per-instance sliding windows
- Config: `loopWindowSize` (5), `loopSimilarityThreshold` (0.8), `loopMinConsecutive` (3)

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/process/output-supervisor.spec.ts`
Expected: PASS

**Step 5: Type check and commit**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Message: "feat: add loop detection to OutputSupervisor"

---

## Task 5: Wire Output Supervisor into Communication Pipeline

**Files:**
- Modify: `src/main/instance/instance-communication.ts`

**Step 1: Integrate OutputSupervisor into setupAdapterEvents**

1. Add import: `import { getOutputSupervisor } from '../process/output-supervisor';`
2. In `setupAdapterEvents()`, within the `adapter.on('output', ...)` handler at line ~279:
   - After the adapter guard check and instance lookup
   - Before circuit breaker checks
   - Add: `message = supervisor.processOutput(instanceId, message);`
   - Add: `supervisor.checkForLoop(instanceId, message);`
   - Change the `message` parameter binding from implicit const to `let`

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Commit**

Message: "feat: wire OutputSupervisor into instance communication pipeline"

---

## Task 6: AgentDropout — Early Consensus in Multi-Verify

**Files:**
- Modify: `src/main/orchestration/multi-verify-coordinator.ts`
- Modify: `src/shared/types/verification.types.ts`
- Create or modify: `src/main/orchestration/multi-verify-coordinator.spec.ts`

**Step 1: Add EarlyTerminationConfig type**

In `src/shared/types/verification.types.ts`:
- Add `EarlyTerminationConfig` interface with `consensusThreshold` (number), `minAgentsForConsensus` (number), `enabled` (boolean)
- Add `earlyTermination?: EarlyTerminationConfig` to `VerificationConfig`

**Step 2: Write the failing tests**

Test cases for `checkEarlyConsensus()`:
- Returns true when responses are highly similar and above minAgentsForConsensus
- Returns false when below minAgentsForConsensus
- Returns false when disabled

Mock the embedding service to return controllable embeddings.

**Step 3: Run test to verify it fails**

Run: `npx vitest run src/main/orchestration/multi-verify-coordinator.spec.ts`
Expected: FAIL — `checkEarlyConsensus` does not exist

**Step 4: Implement checkEarlyConsensus**

Add to `MultiVerifyCoordinator`:
- `checkEarlyConsensus(responses, config)` — gets embeddings for all responses, computes average pairwise cosine similarity, returns true if above threshold
- Uses existing `this.embeddingService`

**Step 5: Run test to verify it passes**

Run: `npx vitest run src/main/orchestration/multi-verify-coordinator.spec.ts`
Expected: PASS

**Step 6: Type check and commit**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Message: "feat: add early consensus detection for multi-agent verification"

---

## Task 7: AgentDropout — Debate Round Skipping

**Files:**
- Modify: `src/main/orchestration/debate-coordinator.ts`
- Modify: `src/shared/types/debate.types.ts`

**Step 1: Add config option**

In `src/shared/types/debate.types.ts`, add `skipDefenseOnConsensus?: boolean` to `DebateConfig`.

**Step 2: Implement convergence check**

Add `checkPositionConvergence(debate)` to `DebateCoordinator`:
- Gets the latest round's contributions
- Computes pairwise embedding similarity
- Returns true if average > convergence threshold

**Step 3: Integrate into runDebate()**

After `runCritiqueRound()`, before `runDefenseRound()`:
- Check `this.config.skipDefenseOnConsensus !== false`
- If converged, skip defense and go straight to `synthesizeResponses()`

**Step 4: Type check and commit**

Run: `npx tsc --noEmit`
Message: "feat: skip defense round when debate positions converge"

---

## Task 8: Event-Based Decision Logs — Types & Extractor

**Files:**
- Create: `src/shared/types/observation-event.types.ts`
- Create: `src/main/rlm/observation-extractor.ts`
- Create: `src/main/rlm/observation-extractor.spec.ts`

**Step 1: Create the ObservationEvent types**

```typescript
// src/shared/types/observation-event.types.ts
export type ObservationEventType = 'decision' | 'discovery' | 'error' | 'tool_result' | 'task_progress' | 'preference';

export interface ObservationEvent {
  id: string;
  sessionId: string;
  timestamp: string;
  turn: number;
  type: ObservationEventType;
  priority: 1 | 2 | 3;
  content: string;
  metadata?: Record<string, string>;
  sourceType: 'heuristic' | 'llm_extracted';
}
```

**Step 2: Write the failing tests**

Test cases for heuristic extraction:
- `extractFromToolResult()` creates tool_result events with summary content
- `extractFromPatterns()` extracts decision events from `DECISION:` tagged content
- `extractFromPatterns()` extracts error events from `ERROR:` tagged content
- Returns empty array when no patterns match

**Step 3: Implement ObservationExtractor**

- `extractFromToolResult(turn, sessionId, turnIndex)` — summarizes tool output to ~150 chars, creates tool_result event
- `extractFromPatterns(turn, patterns, sessionId, turnIndex)` — matches preserve patterns, maps to event types using `PATTERN_TO_TYPE` map
- Both methods use `generateId()` for event IDs, return `sourceType: 'heuristic'`

**Step 4: Run tests, type check, commit**

Message: "feat: add ObservationExtractor for structured event-based compaction"

---

## Task 9: Event-Based Decision Logs — Database & Integration

**Files:**
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Modify: `src/main/rlm/session-compactor.ts`

**Step 1: Add migration for session_observations table**

Add to `MIGRATIONS` array in `rlm-schema.ts`:
- `session_observations` table with: id, session_id, timestamp, turn, type, priority, content, metadata, source_type, embedding
- Indices on session_id, type, priority

**Step 2: Integrate into SessionCompactor**

Modify `compact()` to use `ObservationExtractor` as primary strategy:
- For tool_output turns: `extractor.extractFromToolResult()`
- For pattern-matching turns: `extractor.extractFromPatterns()`
- For conversational turns: `extractor.extractFromConversation()` (LLM via Haiku)
- Store events via new `storeObservations()` method
- Fallback to `generateArchiveSummary()` if < 1 event per 5 turns

**Step 3: Type check and commit**

Message: "feat: integrate event-based decision logs into session compactor"

---

## Task 10: Parent Context Compression

**Files:**
- Create: `src/main/context/parent-context-compressor.ts`
- Create: `src/main/context/parent-context-compressor.spec.ts`
- Modify: `src/main/instance/instance-manager.ts`

**Step 1: Write the failing tests**

Test cases:
- Returns input unchanged when below `minTokensToCompress`
- Compresses long messages to approximately target ratio
- Preserves code blocks even when they score low
- Preserves file paths and URLs

**Step 2: Implement ParentContextCompressor**

- `compress(parentMessages, childTaskDescription, config)` — segments text, scores by word overlap with task description, filters by token budget
- Preservation rules: code blocks (```` ``` ````) always kept, file paths and URLs always kept
- `segmentText()` — extracts code blocks as preserved segments, splits remaining into sentences
- `scoreSegments()` — word overlap scoring against task description
- `filterByBudget()` — keeps preserved + highest-scored segments within token budget

**Step 3: Run tests**

Run: `npx vitest run src/main/context/parent-context-compressor.spec.ts`
Expected: PASS

**Step 4: Integrate into instance-manager.ts**

In `createChildInstance()` at line ~758:
1. Import `getParentContextCompressor`
2. After `parentContextMessages` is built, compress via `compressor.compress([joined], command.task, config)`

**Step 5: Type check and commit**

Message: "feat: add extractive compression for parent context injected into children"

---

## Task 11: Conflict Detector for Memory-R1

**Files:**
- Create: `src/main/memory/conflict-detector.ts`
- Create: `src/main/memory/conflict-detector.spec.ts`

**Step 1: Write the failing tests**

Test cases:
- Detects negation conflicts ("X is enabled" vs "X is not enabled")
- Detects value change conflicts ("timeout is 30" vs "timeout is 60")
- Detects antonym conflicts ("enabled" vs "disabled" in shared context)
- Returns null for ambiguous cases (no clear conflict pattern)
- Returns no conflict for compatible statements

**Step 2: Implement ConflictDetector**

- `heuristicCheck(newContent, existingContent)` — three-phase check:
  1. Negation patterns: "is not" vs "is", "cannot" vs "can", "does not" vs "does"
  2. Value changes: same key, different numeric value
  3. Antonym pairs: common antonyms (enabled/disabled, true/false, success/failure, etc.) with shared context check (2+ common words)
- Returns `ConflictResult` or `null` (null = ambiguous, triggers LLM fallback)

**Step 3: Run tests, type check, commit**

Message: "feat: add heuristic ConflictDetector for Memory-R1"

---

## Task 12: Integrate Conflict Detection into Memory-R1

**Files:**
- Modify: `src/shared/types/memory-r1.types.ts`
- Modify: `src/main/memory/r1-memory-manager.ts`
- Modify: `src/main/memory/r1-memory-manager.spec.ts`

**Step 1: Extend types**

In `memory-r1.types.ts`:
1. Add `MemoryLink` interface: `{ targetId, edgeType: 'related' | 'supports' | 'contradicts' | 'supersedes', createdAt }`
2. Add `status: 'active' | 'contested' | 'archived'` to `MemoryEntry`
3. Change `linkedEntries: string[]` to `linkedEntries: MemoryLink[]`
4. Add `'CONTEST'` to `MemoryOperation` type

**Step 2: Update existing tests**

Update `createEntry()` helper in `r1-memory-manager.spec.ts` to include `status: 'active'` and use `MemoryLink[]` for `linkedEntries`.

**Step 3: Add conflict detection to decision pipeline**

In `r1-memory-manager.ts`:
1. Import `getConflictDetector`
2. In the decision flow, when UPDATE is proposed, run `heuristicCheck()` against the target entry
3. If conflict detected with confidence > 0.7, return CONTEST operation instead of UPDATE
4. CONTEST handler marks both entries as `status: 'contested'` and adds `contradicts` edge

**Step 4: Add auto-resolution**

Add `checkContestedResolution(entryId)`:
- If one contested entry has `accessCount >= 3` and `relevanceScore > other + 0.2`, resolve by archiving the loser and setting `supersedes` edge

**Step 5: Write integration test**

Test that adding conflicting content results in CONTEST operation and both entries marked as contested.

**Step 6: Run all tests, type check, commit**

Message: "feat: integrate conflict detection into Memory-R1 decision pipeline"

---

## Task 13: Final Integration Verification

**Step 1: Run full type check**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

**Step 2: Run full test suite**

Run: `npm run test`
Expected: All tests pass

**Step 3: Run linter**

Run: `npm run lint`
Expected: No new lint errors

**Step 4: Fix any issues found**

If any test/lint/typecheck failures, fix and commit with message: "fix: address integration issues from token optimization suite"
