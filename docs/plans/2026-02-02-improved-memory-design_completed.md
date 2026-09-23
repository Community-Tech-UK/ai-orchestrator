# Improved Memory System Design

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE / SUPERSEDED.** Phase 1
> token stats shipped (`src/main/memory/token-stats.ts`: recorded per tool output from `instance-communication.ts` and persisted via `initializeTokenStatsPersistence`). Phase 2's child folding is
> delivered as stored child summaries (`getChildResultStorage().getChildSummary()` feeds
> `buildAnnouncement` in `instance-orchestration.ts`). Phase 3's goal, keeping large tool output out
> of context, is delivered by output persistence (`src/main/context/output-persistence.ts`) and the
> Codex `tool_output_token_limit`; the RLM masking implementation (`maskStaleToolOutputs`) exists
> but its `checkAndCompact` path has no production caller.

**Date:** 2026-02-02
**Status:** Draft
**Goal:** Reduce context rot through measurement, compression, and smarter defaults

## Problem Statement

Context rot occurs as token count grows - model accuracy degrades even within the context window. Current pain points:

1. **Unknown distribution** - We don't know which tool types consume the most context
2. **Large tool outputs** - File reads, grep results, bash outputs can be 5-10k tokens each
3. **Child agent overhead** - Full transcripts may be injected when summaries would suffice
4. **No automatic compression** - Large outputs go into context verbatim

## Solution Overview

Three complementary systems, implemented in phases:

```
┌─────────────────────────────────────────────────────────────┐
│                    Existing: RLM                            │
│         (semantic search, summarization, queries)           │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐   ┌─────────────────┐   ┌─────────────────┐
│ Token Stats   │   │ Child Folding   │   │  Observation    │
│ (Phase 1)     │   │ (Phase 2)       │   │  Masking        │
│               │   │                 │   │  (Phase 3)      │
├───────────────┤   ├─────────────────┤   ├─────────────────┤
│ Measure where │   │ Summary-only    │   │ Auto-compress   │
│ tokens go     │   │ by default      │   │ large outputs   │
└───────────────┘   └─────────────────┘   └─────────────────┘
        │                     │                     │
        └─────────────────────┴─────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Extended RLM     │
                    │  SQLite Database  │
                    └───────────────────┘
```

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Storage | Extend existing RLM SQLite | Single source of truth, existing patterns |
| Token counting | Character estimation (chars/4) | Fast, good enough for relative comparisons |
| Masking timing | At context injection, not storage | Preserve full data, only compress what enters LLM |
| Child defaults | Summary-only | Drill-down commands already exist |
| Graph memory | Deferred | Existing git/snapshots may suffice; revisit after stats |

---

## Phase 1: Token Stats Logging

### Purpose
Continuous lightweight logging to understand where context tokens actually go. **Measure before optimizing.**

### Database Schema

Add to `src/main/rlm/rlm-database.ts`:

```sql
CREATE TABLE token_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  instance_id TEXT NOT NULL,
  session_id TEXT,
  tool_type TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  char_count INTEGER NOT NULL,
  truncated BOOLEAN DEFAULT FALSE,
  metadata TEXT
);

CREATE INDEX idx_token_stats_instance ON token_stats(instance_id);
CREATE INDEX idx_token_stats_tool ON token_stats(tool_type);
CREATE INDEX idx_token_stats_time ON token_stats(timestamp);
```

### Tool Type Classification

```typescript
type ToolType =
  | 'file_read'           // Read tool output
  | 'file_write'          // Write confirmation
  | 'grep'                // Grep/search results
  | 'glob'                // File listing
  | 'bash'                // Command execution
  | 'child_transcript'    // Child agent output
  | 'user_message'        // User input
  | 'assistant_response'  // Model output
  | 'context_injection'   // RLM/memory injection
  | 'other';
```

### Service Interface

```typescript
// src/main/memory/token-stats.ts

interface TokenStatsEntry {
  instanceId: string;
  sessionId?: string;
  toolType: ToolType;
  tokenCount: number;
  charCount: number;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
}

interface TokenStatsSummary {
  totalTokens: number;
  totalMessages: number;
  byToolType: Record<ToolType, {
    count: number;
    tokens: number;
    avgTokens: number;
    maxTokens: number;
  }>;
  largestMessages: Array<{
    toolType: ToolType;
    tokens: number;
    timestamp: number;
    metadata?: Record<string, unknown>;
  }>;
  timeRange: { start: number; end: number };
}

class TokenStatsService {
  // Recording
  record(entry: TokenStatsEntry): Promise<void>;

  // Queries
  getSummary(query: TokenStatsQuery): Promise<TokenStatsSummary>;
  getRecent(limit: number): Promise<TokenStatsEntry[]>;
  getLargest(limit: number, toolType?: ToolType): Promise<TokenStatsEntry[]>;

  // Maintenance
  cleanup(olderThanDays: number): Promise<number>;
}
```

### Integration Point

Hook into `OutputStorageManager.addMessage()`:

```typescript
// src/main/memory/output-storage.ts

async addMessage(instanceId: string, message: OutputMessage): Promise<void> {
  // Existing storage logic...

  // NEW: Log token stats
  const toolType = this.classifyMessageType(message);
  const charCount = this.getContentLength(message);
  const tokenCount = Math.ceil(charCount / 4); // Estimation

  await this.tokenStats.record({
    instanceId,
    sessionId: message.sessionId,
    toolType,
    tokenCount,
    charCount,
    truncated: message.metadata?.truncated ?? false,
    metadata: this.extractMetadata(message, toolType)
  });
}

private classifyMessageType(message: OutputMessage): ToolType {
  if (message.type === 'user') return 'user_message';
  if (message.type === 'assistant') return 'assistant_response';
  if (message.type === 'tool_result') {
    const toolName = message.metadata?.toolName;
    if (toolName === 'Read') return 'file_read';
    if (toolName === 'Write' || toolName === 'Edit') return 'file_write';
    if (toolName === 'Grep') return 'grep';
    if (toolName === 'Glob') return 'glob';
    if (toolName === 'Bash') return 'bash';
    if (toolName === 'Task') return 'child_transcript';
  }
  return 'other';
}
```

### IPC Channels

Add to `src/shared/types/ipc.types.ts`:

```typescript
// Token Stats operations
TOKEN_STATS_GET_SUMMARY: 'token-stats:get-summary',
TOKEN_STATS_GET_RECENT: 'token-stats:get-recent',
TOKEN_STATS_GET_LARGEST: 'token-stats:get-largest',
TOKEN_STATS_CLEANUP: 'token-stats:cleanup',
```

### Files to Create/Modify

| File | Action |
|------|--------|
| `src/main/memory/token-stats.ts` | Create - TokenStatsService |
| `src/main/rlm/rlm-database.ts` | Modify - add table schema |
| `src/main/memory/output-storage.ts` | Modify - add recording hook |
| `src/main/ipc/handlers/memory-ipc-handler.ts` | Modify - add IPC handlers |
| `src/shared/types/ipc.types.ts` | Modify - add channel definitions |
| `src/shared/types/memory.types.ts` | Modify - add TokenStats types |

### Estimated Scope
~300 lines new code

---

## Phase 2: Child Folding Audit

### Purpose
Ensure child agents return summary-only by default. This is likely a configuration change, not new infrastructure.

### Current State

The `ChildResultStorage` system already provides:
- `getChildSummary()` - Returns compact summary (~500 tokens)
- `getChildArtifacts()` - Returns filtered artifacts
- `getChildSection()` - Returns specific sections
- `getChildOutput()` - Returns full transcript

### Audit Tasks

1. **Trace child completion flow:**
   - Where does parent receive notification of child completion?
   - What data is automatically injected into parent context?
   - Is `getChildOutput()` called anywhere it shouldn't be?

2. **Files to audit:**
   - `src/main/orchestration/orchestrator-*.ts`
   - `src/main/process/instance-context.ts`
   - `src/main/orchestration/child-result-storage.ts`

### Expected Change

```typescript
// BEFORE (suspected):
const childResult = await childStorage.getChildOutput(childId);
this.injectToParentContext(childResult.fullTranscript);

// AFTER:
const summary = await childStorage.getChildSummary(childId);
this.injectToParentContext(formatChildSummary(summary));
```

### Summary Format

```typescript
function formatChildSummary(summary: ChildSummary): string {
  const status = summary.success ? '✓ completed' : '✗ failed';
  return `
## Child "${summary.name}" ${status}

${summary.summary}

**Artifacts:** ${summary.artifactCount} (${formatArtifactTypes(summary.artifactsByType)})
**Duration:** ${formatDuration(summary.durationMs)} | **Tokens used:** ${summary.tokenCount}

> Use \`get_child_artifacts\` or \`get_child_section\` for details.
`.trim();
}
```

### Files to Modify

| File | Action |
|------|--------|
| `src/main/orchestration/orchestrator-*.ts` | Audit - find injection point |
| `src/main/process/instance-context.ts` | Audit - verify summary usage |
| Injection point (TBD) | Modify - switch to summary |

### Estimated Scope
~50 lines changed (audit may take longer than fix)

---

## Phase 3: Observation Masking

### Purpose
Automatically compress large tool outputs before they enter context. Full content preserved in storage.

### Flow

```
Tool Output Received
       │
       ▼
  Token count > threshold?
       │
   no  │  yes
   │   │
   │   ▼
   │   Compress:
   │   ├─ Keep first N lines (head)
   │   ├─ Keep last M lines (tail)
   │   ├─ Generate summary of middle
   │   └─ Store reference to full content
   │
   ▼   ▼
 Return (original or masked)
```

### Configuration

```typescript
// src/shared/types/memory.types.ts

interface ObservationMaskingConfig {
  enabled: boolean;

  // Token thresholds per tool type (compress if exceeded)
  thresholds: {
    file_read: number;        // default: 2000
    grep: number;             // default: 1500
    bash: number;             // default: 1000
    child_transcript: number; // default: 500
    default: number;          // default: 2000
  };

  // Compression settings
  compression: {
    headLines: number;        // default: 20
    tailLines: number;        // default: 10
    maxSummaryTokens: number; // default: 200
  };
}
```

### Masked Output Format

```typescript
interface MaskedObservation {
  masked: true;
  originalTokens: number;
  compressedTokens: number;

  head: string;              // First N lines
  tail: string;              // Last M lines
  summary: string;           // Middle content summary
  omittedLines: number;      // Lines not shown

  fullContentRef: string;    // ID to retrieve full content
  toolType: ToolType;
  metadata?: Record<string, unknown>;
}
```

### Compression Strategies (Per Tool Type)

#### File Reads
```typescript
function maskFileRead(content: string, config: CompressionConfig): MaskedObservation {
  const lines = content.split('\n');

  // For code files: extract structure
  const imports = extractImports(lines);
  const signatures = extractSignatures(lines); // class/function definitions

  return {
    masked: true,
    head: lines.slice(0, config.headLines).join('\n'),
    tail: lines.slice(-config.tailLines).join('\n'),
    summary: `File with ${lines.length} lines. Imports: ${imports.length}. Definitions: ${signatures.join(', ')}`,
    // ...
  };
}
```

#### Grep Results
```typescript
function maskGrepResults(content: string, config: CompressionConfig): MaskedObservation {
  const matches = parseGrepOutput(content);
  const shown = matches.slice(0, config.headLines);
  const omitted = matches.length - shown.length;

  const fileCount = new Set(matches.map(m => m.file)).size;

  return {
    masked: true,
    head: formatMatches(shown),
    tail: '',
    summary: `${matches.length} matches in ${fileCount} files. Showing first ${shown.length}.`,
    omittedLines: omitted,
    // ...
  };
}
```

#### Bash Output
```typescript
function maskBashOutput(content: string, exitCode: number, config: CompressionConfig): MaskedObservation {
  const lines = content.split('\n');

  // Special handling for test output
  if (looksLikeTestOutput(content)) {
    const testSummary = extractTestSummary(content); // pass/fail counts
    return {
      masked: true,
      head: lines.slice(0, config.headLines).join('\n'),
      tail: lines.slice(-config.tailLines).join('\n'),
      summary: `Tests: ${testSummary.passed} passed, ${testSummary.failed} failed. Exit code: ${exitCode}`,
      // ...
    };
  }

  return {
    masked: true,
    head: lines.slice(0, config.headLines).join('\n'),
    tail: lines.slice(-config.tailLines).join('\n'),
    summary: `Command output: ${lines.length} lines. Exit code: ${exitCode}`,
    // ...
  };
}
```

### Service Interface

```typescript
// src/main/memory/observation-masking.ts

class ObservationMaskingService {
  constructor(
    private config: ObservationMaskingConfig,
    private outputStorage: OutputStorageManager
  ) {}

  /**
   * Mask observation if it exceeds threshold for its tool type.
   * Returns original if under threshold or masking disabled.
   */
  mask(
    content: string,
    toolType: ToolType,
    metadata?: Record<string, unknown>
  ): string | MaskedObservation {
    if (!this.config.enabled) return content;

    const tokens = this.estimateTokens(content);
    const threshold = this.config.thresholds[toolType] ?? this.config.thresholds.default;

    if (tokens <= threshold) return content;

    // Store full content, return masked version
    const fullContentRef = this.outputStorage.storeFullContent(content);
    return this.compressForToolType(content, toolType, fullContentRef, metadata);
  }

  /**
   * Retrieve full content for a masked observation.
   */
  async getFullContent(ref: string): Promise<string | null> {
    return this.outputStorage.getFullContent(ref);
  }
}
```

### Integration Point

Apply masking at context injection, not storage:

```typescript
// src/main/process/instance-context.ts

async buildContextForInstance(instanceId: string): Promise<string> {
  const messages = await this.outputStorage.getMessages(instanceId);

  const contextParts: string[] = [];

  for (const message of messages) {
    if (message.type === 'tool_result') {
      // Apply masking for context injection
      const masked = this.maskingService.mask(
        message.content,
        this.classifyToolType(message),
        message.metadata
      );
      contextParts.push(this.formatMessage(message, masked));
    } else {
      contextParts.push(this.formatMessage(message, message.content));
    }
  }

  return contextParts.join('\n\n');
}
```

### Files to Create/Modify

| File | Action |
|------|--------|
| `src/main/memory/observation-masking.ts` | Create - MaskingService |
| `src/main/memory/output-storage.ts` | Modify - add full content storage |
| `src/main/process/instance-context.ts` | Modify - integrate masking |
| `src/shared/types/memory.types.ts` | Modify - add types |
| `src/main/settings/settings-schema.ts` | Modify - add config |

### Estimated Scope
~500 lines new code

---

## Success Metrics

After all phases:

| Metric | Before | Target |
|--------|--------|--------|
| Child agent context overhead | ~10k tokens | ~500-1k tokens |
| Large file read in context | ~5k tokens | ~500 tokens |
| Grep results in context | ~3k tokens | ~300 tokens |
| Visibility into token usage | None | Full stats dashboard |

### How to Measure

1. **Before implementation:** Run token stats logging for a few sessions to establish baseline
2. **After each phase:** Compare token distribution
3. **Success:** Average context size per turn reduced by 50%+

---

## Deferred: Graph Memory

### Why Deferred

1. **Existing alternatives:**
   - Git tracks file modifications: `git log --name-only`
   - Snapshot system tracks changes per instance
   - RLM can answer many relationship queries

2. **Uncertain value:**
   - Token stats will reveal if we actually need relationship tracking
   - May be solving a problem we don't have

3. **Revisit criteria:**
   - After Phase 1 stats show relationship queries are common
   - After existing systems prove insufficient for "what changed" queries

---

## Implementation Order

```
Week 1: Phase 1 - Token Stats
├── Day 1-2: Database schema, TokenStatsService
├── Day 3: Integration with OutputStorageManager
├── Day 4: IPC handlers
└── Day 5: Let it run, gather baseline data

Week 2: Phase 2 - Child Folding
├── Day 1: Audit child result flow
├── Day 2: Implement fix (likely small)
└── Day 3: Verify drill-down still works

Week 3-4: Phase 3 - Observation Masking
├── Day 1-3: MaskingService core
├── Day 4-5: Per-tool-type strategies
├── Day 6-7: Integration with context injection
├── Day 8: Configuration UI
└── Day 9-10: Testing and tuning thresholds
```

---

## Open Questions

1. **Token estimation accuracy:** Is chars/4 good enough, or should we use tiktoken?
2. **Masking UI:** Should masked content show an "expand" option in the UI?
3. **Threshold tuning:** Should thresholds be per-instance or global?
4. **Summary generation:** Use LLM for summaries or keep it heuristic-only?

---

## References

- [JetBrains: Efficient Context Management](https://blog.jetbrains.com/research/2025/12/efficient-context-management/)
- [MIT: Recursive Language Models](https://www.primeintellect.ai/blog/rlm)
- [Anthropic: Effective Context Engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Apple: LazyLLM Dynamic Token Pruning](https://arxiv.org/abs/2407.14057)
- [SWE-Pruner: Context Pruning for Coding Agents](https://www.arxiv.org/pdf/2601.16746)
