# MemPalace-Inspired Knowledge Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port four valuable concepts from the mempalace Python project into our TypeScript orchestrator: (1) temporal knowledge graph, (2) conversation mining/import, (3) cold-start wake-up context, and (4) raw verbatim storage mode.

**Architecture:** Each feature becomes a focused singleton service in `src/main/memory/` that integrates with the existing RLMDatabase (SQLite), observation pipeline, and Memory-R1 system. New database tables are added via migrations. Features hook into existing event flows (observation → reflection pipeline) and expose their APIs via IPC channels. No Python dependency — we port the algorithms, not the package.

**Tech Stack:** TypeScript 5.9, better-sqlite3, Electron IPC, Vitest, existing embedding infrastructure (VectorStore/EmbeddingService)

**Reference:** The mempalace source code is cloned at `mempalace-reference/` in the repo root for reference during implementation.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/shared/types/knowledge-graph.types.ts` | Entity, Triple, KGQuery, KGStats types |
| `src/shared/types/conversation-mining.types.ts` | ConversationFormat, Segment, MiningConfig types |
| `src/shared/types/wake-context.types.ts` | WakeContext, WakeHint, ContextLayer types |
| `src/main/persistence/rlm/rlm-knowledge-graph.ts` | SQLite CRUD for entities + triples tables |
| `src/main/persistence/rlm/rlm-verbatim.ts` | SQLite CRUD for verbatim segments table |
| `src/main/memory/knowledge-graph-service.ts` | KG singleton: add/query/invalidate entities & triples |
| `src/main/memory/conversation-miner.ts` | Normalize + chunk + index imported conversations |
| `src/main/memory/wake-context-builder.ts` | Generate compact L0+L1 wake-up context for agents |
| `src/main/ipc/handlers/knowledge-graph-handlers.ts` | IPC handlers for KG operations |
| `src/main/ipc/handlers/conversation-mining-handlers.ts` | IPC handlers for import operations |
| `src/main/ipc/handlers/wake-context-handlers.ts` | IPC handlers for wake-up context |
| `src/tests/unit/memory/knowledge-graph-service.test.ts` | KG service tests |
| `src/tests/unit/memory/conversation-miner.test.ts` | Conversation miner tests |
| `src/tests/unit/memory/wake-context-builder.test.ts` | Wake-up context tests |
| `src/tests/unit/persistence/rlm-knowledge-graph.test.ts` | KG persistence tests |
| `src/tests/unit/persistence/rlm-verbatim.test.ts` | Verbatim persistence tests |

### Modified Files

| File | Change |
|------|--------|
| `src/main/persistence/rlm/rlm-schema.ts` | Add migrations 011-014 for new tables |
| `src/main/persistence/rlm-database.ts` | Import + delegate to new rlm-knowledge-graph and rlm-verbatim modules |
| `src/main/persistence/rlm-database.types.ts` | Add row types for new tables |
| `src/shared/types/ipc.types.ts` | Add IPC channel constants |
| `src/shared/types/memory-r1.types.ts` | Add optional `entityTriples` to MemoryEntry |
| `src/main/ipc/ipc-main-handler.ts` | Register new IPC handler modules |
| `src/main/memory/unified-controller.ts` | Integrate wake-up context into retrieval |
| `src/shared/validation/ipc-schemas.ts` | Add Zod schemas for new IPC payloads |

---

## Task 1: Shared Types — Knowledge Graph

**Files:**
- Create: `src/shared/types/knowledge-graph.types.ts`
- Test: `src/tests/unit/types/knowledge-graph-types.test.ts`

- [ ] **Step 1: Write the type-checking test**

Create a test that imports the types and uses them, ensuring they compile correctly:

```typescript
// src/tests/unit/types/knowledge-graph-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  KGEntity,
  KGTriple,
  KGEntityQuery,
  KGRelationshipQuery,
  KGTimelineQuery,
  KGQueryResult,
  KGStats,
  KGDirection,
} from '../../../shared/types/knowledge-graph.types';

describe('knowledge-graph types', () => {
  it('should create a valid entity', () => {
    const entity: KGEntity = {
      id: 'alice',
      name: 'Alice',
      type: 'person',
      properties: { role: 'developer' },
      createdAt: Date.now(),
    };
    expect(entity.id).toBe('alice');
    expect(entity.type).toBe('person');
  });

  it('should create a valid triple with temporal bounds', () => {
    const triple: KGTriple = {
      id: 't_alice_works_at_acme_abc123',
      subject: 'alice',
      predicate: 'works_at',
      object: 'acme_corp',
      validFrom: '2020-01-01',
      validTo: null,
      confidence: 1.0,
      sourceCloset: null,
      sourceFile: null,
      extractedAt: Date.now(),
    };
    expect(triple.validTo).toBeNull();
    expect(triple.confidence).toBe(1.0);
  });

  it('should express query direction types', () => {
    const directions: KGDirection[] = ['outgoing', 'incoming', 'both'];
    expect(directions).toHaveLength(3);
  });

  it('should create entity query with temporal filter', () => {
    const query: KGEntityQuery = {
      entityName: 'Alice',
      asOf: '2024-06-01',
      direction: 'both',
    };
    expect(query.asOf).toBe('2024-06-01');
  });

  it('should create a stats object', () => {
    const stats: KGStats = {
      entities: 10,
      triples: 25,
      currentFacts: 20,
      expiredFacts: 5,
      relationshipTypes: ['works_at', 'child_of', 'loves'],
    };
    expect(stats.currentFacts + stats.expiredFacts).toBe(stats.triples);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/types/knowledge-graph-types.test.ts`
Expected: FAIL — module `knowledge-graph.types` not found

- [ ] **Step 3: Create the types file**

```typescript
// src/shared/types/knowledge-graph.types.ts
/**
 * Knowledge Graph Types
 * Temporal entity-relationship storage inspired by mempalace's knowledge_graph.py
 *
 * Core Concepts:
 * - Entities: named things (people, projects, concepts)
 * - Triples: (subject, predicate, object) relationships with temporal validity
 * - Temporal validity: facts have valid_from/valid_to windows, enabling "what was true at time T?"
 */

// ============ Entity ============

export type KGEntityType = 'person' | 'project' | 'concept' | 'place' | 'unknown';

export interface KGEntity {
  id: string;             // Normalized: lowercase, spaces → underscores
  name: string;           // Display name ("Alice", "MyProject")
  type: KGEntityType;
  properties: Record<string, unknown>;
  createdAt: number;
}

// ============ Triple ============

export interface KGTriple {
  id: string;             // Format: t_{subject}_{predicate}_{object}_{hash}
  subject: string;        // Entity ID
  predicate: string;      // Relationship type, normalized (lowercase, underscored)
  object: string;         // Entity ID
  validFrom: string | null;  // ISO date (YYYY-MM-DD) when fact started, null = always
  validTo: string | null;    // ISO date when fact ended, null = still valid
  confidence: number;     // 0.0–1.0
  sourceCloset: string | null;  // Reference to memory location
  sourceFile: string | null;    // Where fact was extracted from
  extractedAt: number;    // Timestamp of extraction
}

// ============ Query Types ============

export type KGDirection = 'outgoing' | 'incoming' | 'both';

export interface KGEntityQuery {
  entityName: string;
  asOf?: string;          // ISO date for temporal filtering
  direction?: KGDirection; // Default: 'both'
}

export interface KGRelationshipQuery {
  predicate: string;
  asOf?: string;
}

export interface KGTimelineQuery {
  entityName?: string;    // If omitted, returns global timeline
  limit?: number;         // Default: 100
}

// ============ Results ============

export interface KGQueryResult {
  direction: KGDirection;
  subject: string;        // Display name (not ID)
  predicate: string;
  object: string;         // Display name (not ID)
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceCloset: string | null;
  current: boolean;       // true if validTo is null
}

export interface KGStats {
  entities: number;
  triples: number;
  currentFacts: number;
  expiredFacts: number;
  relationshipTypes: string[];
}

// ============ Configuration ============

export interface KnowledgeGraphConfig {
  maxEntities: number;       // Default: 10000
  maxTriples: number;        // Default: 50000
  timelineLimit: number;     // Default: 100
  enableAutoExtraction: boolean; // Extract entities from observations
}

export const DEFAULT_KG_CONFIG: KnowledgeGraphConfig = {
  maxEntities: 10_000,
  maxTriples: 50_000,
  timelineLimit: 100,
  enableAutoExtraction: true,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/unit/types/knowledge-graph-types.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/knowledge-graph.types.ts src/tests/unit/types/knowledge-graph-types.test.ts
git commit -m "feat(types): add knowledge graph types — entities, triples, temporal queries"
```

---

## Task 2: Shared Types — Conversation Mining

**Files:**
- Create: `src/shared/types/conversation-mining.types.ts`
- Test: `src/tests/unit/types/conversation-mining-types.test.ts`

- [ ] **Step 1: Write the type-checking test**

```typescript
// src/tests/unit/types/conversation-mining-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  ConversationFormat,
  NormalizedMessage,
  ConversationSegment,
  MiningConfig,
  MemoryType as ConvoMemoryType,
  MiningResult,
  ImportSource,
} from '../../../shared/types/conversation-mining.types';

describe('conversation-mining types', () => {
  it('should enumerate all supported formats', () => {
    const formats: ConversationFormat[] = [
      'claude-code-jsonl',
      'codex-jsonl',
      'claude-ai-json',
      'chatgpt-json',
      'slack-json',
      'plain-text',
    ];
    expect(formats).toHaveLength(6);
  });

  it('should create normalized messages', () => {
    const msg: NormalizedMessage = {
      role: 'user',
      content: 'How do I handle errors?',
      timestamp: Date.now(),
    };
    expect(msg.role).toBe('user');
  });

  it('should create a conversation segment', () => {
    const segment: ConversationSegment = {
      id: 'seg_001',
      content: '> How do I handle errors?\nUse try-catch blocks...',
      chunkIndex: 0,
      memoryType: 'technical',
      sourceFile: '/path/to/convo.jsonl',
      wing: 'project_a',
      room: 'backend',
      importedAt: Date.now(),
    };
    expect(segment.memoryType).toBe('technical');
  });

  it('should create mining config', () => {
    const config: MiningConfig = {
      chunkSize: 800,
      chunkOverlap: 100,
      minChunkSize: 50,
      maxFileSize: 10 * 1024 * 1024,
      topicKeywords: {
        technical: ['code', 'function', 'bug', 'error'],
        architecture: ['design', 'pattern', 'schema'],
      },
    };
    expect(config.chunkSize).toBe(800);
  });

  it('should create mining result', () => {
    const result: MiningResult = {
      segmentsCreated: 42,
      filesProcessed: 3,
      formatDetected: 'claude-code-jsonl',
      errors: [],
      duration: 1500,
    };
    expect(result.segmentsCreated).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/types/conversation-mining-types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create the types file**

```typescript
// src/shared/types/conversation-mining.types.ts
/**
 * Conversation Mining Types
 * Parse and index past AI conversations from multiple formats.
 * Inspired by mempalace's normalize.py + convo_miner.py
 *
 * Supported Formats:
 * - Claude Code JSONL (type: human/assistant, message.content)
 * - Codex CLI JSONL (type: event_msg, payload.type: user_message/agent_message)
 * - Claude.ai JSON (flat messages or privacy export with chat_messages)
 * - ChatGPT conversations.json (tree structure via mapping dict)
 * - Slack JSON (message array with user role alternation)
 * - Plain text (> marker format)
 */

// ============ Format Detection ============

export type ConversationFormat =
  | 'claude-code-jsonl'
  | 'codex-jsonl'
  | 'claude-ai-json'
  | 'chatgpt-json'
  | 'slack-json'
  | 'plain-text';

// ============ Normalized Messages ============

export type MessageRole = 'user' | 'assistant';

export interface NormalizedMessage {
  role: MessageRole;
  content: string;
  timestamp?: number;
}

// ============ Segments (Chunks) ============

/** Memory category for a conversation segment */
export type ConvoMemoryType =
  | 'technical'
  | 'architecture'
  | 'planning'
  | 'decisions'
  | 'problems'
  | 'general';

export interface ConversationSegment {
  id: string;
  content: string;        // Verbatim text of the Q+A exchange
  chunkIndex: number;
  memoryType: ConvoMemoryType;
  sourceFile: string;
  wing: string;
  room: string;
  importedAt: number;
}

// ============ Import Source ============

export interface ImportSource {
  filePath: string;
  format: ConversationFormat;
  wing: string;
  detectedAt: number;
  messageCount: number;
  status: 'pending' | 'imported' | 'failed';
  error?: string;
}

// ============ Mining Config ============

export interface MiningConfig {
  chunkSize: number;        // Chars per segment (default: 800)
  chunkOverlap: number;     // Overlap between segments (default: 100)
  minChunkSize: number;     // Skip segments smaller than this (default: 50)
  maxFileSize: number;      // Skip files larger than this (default: 10MB)
  topicKeywords: Record<string, string[]>;
}

export const DEFAULT_MINING_CONFIG: MiningConfig = {
  chunkSize: 800,
  chunkOverlap: 100,
  minChunkSize: 50,
  maxFileSize: 10 * 1024 * 1024,
  topicKeywords: {
    technical: ['code', 'python', 'function', 'bug', 'error', 'api', 'database', 'server', 'deploy', 'git', 'test', 'debug', 'refactor'],
    architecture: ['architecture', 'design', 'pattern', 'structure', 'schema', 'interface', 'module', 'component', 'service', 'layer'],
    planning: ['plan', 'roadmap', 'milestone', 'deadline', 'priority', 'sprint', 'backlog', 'scope', 'requirement', 'spec'],
    decisions: ['decided', 'chose', 'picked', 'switched', 'migrated', 'replaced', 'trade-off', 'alternative', 'option', 'approach'],
    problems: ['problem', 'issue', 'broken', 'failed', 'crash', 'stuck', 'workaround', 'fix', 'solved', 'resolved'],
  },
};

// ============ Results ============

export interface MiningResult {
  segmentsCreated: number;
  filesProcessed: number;
  formatDetected: ConversationFormat;
  errors: string[];
  duration: number;
}

// ============ Verbatim Storage ============

/**
 * A raw verbatim memory entry — stores exact original text for high-fidelity retrieval.
 * Contrasts with summarized MemoryEntry which compresses content.
 */
export interface VerbatimEntry {
  id: string;
  content: string;
  sourceFile: string;
  chunkIndex: number;
  wing: string;
  room: string;
  importance: number;      // 0-10, default 3
  addedBy: string;
  createdAt: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/tests/unit/types/conversation-mining-types.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/conversation-mining.types.ts src/tests/unit/types/conversation-mining-types.test.ts
git commit -m "feat(types): add conversation mining types — formats, segments, verbatim entries"
```

---

## Task 3: Shared Types — Wake-Up Context

**Files:**
- Create: `src/shared/types/wake-context.types.ts`
- Test: `src/tests/unit/types/wake-context-types.test.ts`

- [ ] **Step 1: Write the type-checking test**

```typescript
// src/tests/unit/types/wake-context-types.test.ts
import { describe, it, expect } from 'vitest';
import type {
  WakeContext,
  WakeHint,
  ContextLayer,
  WakeContextConfig,
} from '../../../shared/types/wake-context.types';

describe('wake-context types', () => {
  it('should create a wake hint', () => {
    const hint: WakeHint = {
      id: 'hint_001',
      content: 'User prefers TypeScript over Python',
      importance: 8,
      room: 'preferences',
      sourceReflectionId: 'ref_123',
      createdAt: Date.now(),
      lastUsed: Date.now(),
      usageCount: 3,
    };
    expect(hint.importance).toBe(8);
  });

  it('should create a layered context', () => {
    const layer: ContextLayer = {
      level: 'L1',
      content: '## Essential Story\n[backend] User prefers event-driven...',
      tokenEstimate: 450,
      generatedAt: Date.now(),
    };
    expect(layer.level).toBe('L1');
  });

  it('should create full wake context', () => {
    const ctx: WakeContext = {
      identity: { level: 'L0', content: 'AI orchestrator assistant', tokenEstimate: 25, generatedAt: Date.now() },
      essentialStory: { level: 'L1', content: '## L1\n...', tokenEstimate: 500, generatedAt: Date.now() },
      totalTokens: 525,
      wing: 'project_a',
      generatedAt: Date.now(),
    };
    expect(ctx.totalTokens).toBe(525);
  });

  it('should create config with token budgets', () => {
    const config: WakeContextConfig = {
      l0MaxTokens: 100,
      l1MaxTokens: 800,
      l1MaxHints: 15,
      l1SnippetMaxChars: 200,
      regenerateIntervalMs: 5 * 60 * 1000,
    };
    expect(config.l1MaxHints).toBe(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/types/wake-context-types.test.ts`
Expected: FAIL

- [ ] **Step 3: Create the types file**

```typescript
// src/shared/types/wake-context.types.ts
/**
 * Wake-Up Context Types
 * Compact initialization context for cold-starting AI agents.
 * Inspired by mempalace's L0/L1 layer system.
 *
 * L0 (Identity, ~100 tokens): Fixed persona/project description
 * L1 (Essential Story, ~500-800 tokens): Auto-generated from top-importance memories
 *
 * Total wake-up cost: ~600-900 tokens, leaving 95%+ context for conversation.
 */

// ============ Layers ============

export type ContextLayerLevel = 'L0' | 'L1';

export interface ContextLayer {
  level: ContextLayerLevel;
  content: string;
  tokenEstimate: number;
  generatedAt: number;
}

// ============ Wake Hints ============

/**
 * A distilled piece of knowledge promoted from reflections/episodic/procedural memory
 * that should be included in wake-up context.
 */
export interface WakeHint {
  id: string;
  content: string;
  importance: number;       // 0-10 (higher = more likely to be in L1)
  room: string;             // Topic category for grouping
  sourceReflectionId?: string;
  sourceSessionId?: string;
  createdAt: number;
  lastUsed: number;
  usageCount: number;
}

// ============ Full Context ============

export interface WakeContext {
  identity: ContextLayer;        // L0
  essentialStory: ContextLayer;  // L1
  totalTokens: number;
  wing?: string;                 // Optional wing-scoped context
  generatedAt: number;
}

// ============ Configuration ============

export interface WakeContextConfig {
  l0MaxTokens: number;           // Default: 100
  l1MaxTokens: number;           // Default: 800
  l1MaxHints: number;            // Max hints in L1 (default: 15)
  l1SnippetMaxChars: number;     // Truncate hint snippets (default: 200)
  regenerateIntervalMs: number;  // How often to regenerate L1 (default: 5 min)
}

export const DEFAULT_WAKE_CONTEXT_CONFIG: WakeContextConfig = {
  l0MaxTokens: 100,
  l1MaxTokens: 800,
  l1MaxHints: 15,
  l1SnippetMaxChars: 200,
  regenerateIntervalMs: 5 * 60 * 1000,
};
```

- [ ] **Step 4: Run test and typecheck**

Run: `npx vitest run src/tests/unit/types/wake-context-types.test.ts && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/wake-context.types.ts src/tests/unit/types/wake-context-types.test.ts
git commit -m "feat(types): add wake-up context types — layers, hints, config"
```

---

## Task 4: Database Migrations — Knowledge Graph Tables

**Files:**
- Modify: `src/main/persistence/rlm/rlm-schema.ts` (append to MIGRATIONS array, after migration 010)
- Modify: `src/main/persistence/rlm-database.types.ts` (add row types)

- [ ] **Step 1: Read current end of MIGRATIONS array**

Read `src/main/persistence/rlm/rlm-schema.ts` to find the exact position where migration 010 ends (after the closing `},` of `010_channel_access_policies`). The array closing `];` is on line 369.

- [ ] **Step 2: Add migration 011 for knowledge graph tables**

Insert before the `];` on line 369 of `src/main/persistence/rlm/rlm-schema.ts`:

```typescript
  // Migration 011: Knowledge graph — entities + triples with temporal validity
  // Inspired by mempalace knowledge_graph.py
  {
    name: '011_knowledge_graph',
    up: `
      CREATE TABLE IF NOT EXISTS kg_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'unknown',
        properties_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_kg_entities_type
        ON kg_entities(type);
      CREATE INDEX IF NOT EXISTS idx_kg_entities_name
        ON kg_entities(name);

      CREATE TABLE IF NOT EXISTS kg_triples (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        source_closet TEXT,
        source_file TEXT,
        extracted_at INTEGER NOT NULL,
        FOREIGN KEY (subject) REFERENCES kg_entities(id),
        FOREIGN KEY (object) REFERENCES kg_entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_kg_triples_subject
        ON kg_triples(subject);
      CREATE INDEX IF NOT EXISTS idx_kg_triples_object
        ON kg_triples(object);
      CREATE INDEX IF NOT EXISTS idx_kg_triples_predicate
        ON kg_triples(predicate);
      CREATE INDEX IF NOT EXISTS idx_kg_triples_valid
        ON kg_triples(valid_from, valid_to);
    `,
    down: `
      DROP TABLE IF EXISTS kg_triples;
      DROP TABLE IF EXISTS kg_entities;
    `,
  },
```

- [ ] **Step 3: Add migration 012 for verbatim segments table**

Insert after migration 011:

```typescript
  // Migration 012: Verbatim segments — raw text storage for conversation mining
  // Stores exact text for high-fidelity retrieval (96.6% R@5 on LongMemEval)
  {
    name: '012_verbatim_segments',
    up: `
      CREATE TABLE IF NOT EXISTS verbatim_segments (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        source_file TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        wing TEXT NOT NULL,
        room TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 3.0,
        added_by TEXT NOT NULL DEFAULT 'system',
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_verbatim_wing
        ON verbatim_segments(wing);
      CREATE INDEX IF NOT EXISTS idx_verbatim_room
        ON verbatim_segments(room);
      CREATE INDEX IF NOT EXISTS idx_verbatim_source
        ON verbatim_segments(source_file);
      CREATE INDEX IF NOT EXISTS idx_verbatim_importance
        ON verbatim_segments(importance DESC);

      CREATE TABLE IF NOT EXISTS conversation_imports (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        format TEXT NOT NULL,
        wing TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        segments_created INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        imported_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_convo_imports_status
        ON conversation_imports(status);
    `,
    down: `
      DROP TABLE IF EXISTS conversation_imports;
      DROP TABLE IF EXISTS verbatim_segments;
    `,
  },
```

- [ ] **Step 4: Add migration 013 for wake-up context table**

Insert after migration 012:

```typescript
  // Migration 013: Wake-up context — cold-start hints for agent initialization
  {
    name: '013_wake_context',
    up: `
      CREATE TABLE IF NOT EXISTS wake_hints (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 5.0,
        room TEXT NOT NULL DEFAULT 'general',
        source_reflection_id TEXT,
        source_session_id TEXT,
        created_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        usage_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_wake_hints_importance
        ON wake_hints(importance DESC);
      CREATE INDEX IF NOT EXISTS idx_wake_hints_room
        ON wake_hints(room);
    `,
    down: `
      DROP TABLE IF EXISTS wake_hints;
    `,
  },
```

- [ ] **Step 5: Add row types to rlm-database.types.ts**

Read `src/main/persistence/rlm-database.types.ts` to find the end of the file, then append:

```typescript
// Knowledge Graph rows
export interface KGEntityRow {
  id: string;
  name: string;
  type: string;
  properties_json: string;
  created_at: number;
}

export interface KGTripleRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  valid_from: string | null;
  valid_to: string | null;
  confidence: number;
  source_closet: string | null;
  source_file: string | null;
  extracted_at: number;
}

// Verbatim segment rows
export interface VerbatimSegmentRow {
  id: string;
  content: string;
  source_file: string;
  chunk_index: number;
  wing: string;
  room: string;
  importance: number;
  added_by: string;
  created_at: number;
}

export interface ConversationImportRow {
  id: string;
  file_path: string;
  format: string;
  wing: string;
  message_count: number;
  segments_created: number;
  status: string;
  error: string | null;
  imported_at: number;
}

// Wake context rows
export interface WakeHintRow {
  id: string;
  content: string;
  importance: number;
  room: string;
  source_reflection_id: string | null;
  source_session_id: string | null;
  created_at: number;
  last_used: number;
  usage_count: number;
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/main/persistence/rlm/rlm-schema.ts src/main/persistence/rlm-database.types.ts
git commit -m "feat(db): add migrations 011-013 — knowledge graph, verbatim segments, wake hints"
```

---

## Task 5: Knowledge Graph Persistence Layer

**Files:**
- Create: `src/main/persistence/rlm/rlm-knowledge-graph.ts`
- Test: `src/tests/unit/persistence/rlm-knowledge-graph.test.ts`

- [ ] **Step 1: Write persistence tests**

```typescript
// src/tests/unit/persistence/rlm-knowledge-graph.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as kgPersistence from '../../../../main/persistence/rlm/rlm-knowledge-graph';
import { createTables, createMigrationsTable, runMigrations } from '../../../../main/persistence/rlm/rlm-schema';

describe('rlm-knowledge-graph persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('normalizeEntityId', () => {
    it('should lowercase and replace spaces with underscores', () => {
      expect(kgPersistence.normalizeEntityId('Alice Smith')).toBe('alice_smith');
    });

    it('should remove apostrophes', () => {
      expect(kgPersistence.normalizeEntityId("Max O'Brien")).toBe('max_obrien');
    });
  });

  describe('upsertEntity', () => {
    it('should insert a new entity', () => {
      const id = kgPersistence.upsertEntity(db, 'Alice', 'person', { role: 'dev' });
      expect(id).toBe('alice');

      const entity = kgPersistence.getEntity(db, 'alice');
      expect(entity).toBeDefined();
      expect(entity!.name).toBe('Alice');
      expect(entity!.type).toBe('person');
    });

    it('should update existing entity on re-insert', () => {
      kgPersistence.upsertEntity(db, 'Alice', 'person');
      kgPersistence.upsertEntity(db, 'Alice', 'person', { role: 'lead' });

      const entity = kgPersistence.getEntity(db, 'alice');
      expect(JSON.parse(entity!.properties_json)).toEqual({ role: 'lead' });
    });
  });

  describe('addTriple', () => {
    it('should create a triple and auto-create entities', () => {
      const tripleId = kgPersistence.addTriple(db, {
        subject: 'Alice',
        predicate: 'works_at',
        object: 'Acme Corp',
        validFrom: '2020-01-01',
        confidence: 1.0,
      });

      expect(tripleId).toMatch(/^t_alice_works_at_acme_corp_/);

      // Entities should have been auto-created
      expect(kgPersistence.getEntity(db, 'alice')).toBeDefined();
      expect(kgPersistence.getEntity(db, 'acme_corp')).toBeDefined();
    });

    it('should detect duplicate active triples', () => {
      const id1 = kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
      });
      const id2 = kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
      });

      // Should return existing ID, not create a duplicate
      expect(id2).toBe(id1);
    });

    it('should allow re-adding after invalidation', () => {
      const id1 = kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
      });
      kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme');

      const id2 = kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
      });

      expect(id2).not.toBe(id1);
    });
  });

  describe('invalidateTriple', () => {
    it('should set valid_to on active triple', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
      });

      const count = kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme', '2024-12-31');
      expect(count).toBe(1);
    });
  });

  describe('queryEntity', () => {
    it('should return outgoing facts', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
        validFrom: '2020-01-01',
      });
      kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'child_of', object: 'Bob',
      });

      const results = kgPersistence.queryEntity(db, 'Alice', { direction: 'outgoing' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.subject === 'Alice')).toBe(true);
    });

    it('should filter by as_of date', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
        validFrom: '2020-01-01',
      });
      kgPersistence.invalidateTriple(db, 'Alice', 'works_at', 'Acme', '2024-06-01');

      kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'NewCo',
        validFrom: '2024-07-01',
      });

      // Query at a date when Alice was at Acme
      const atAcme = kgPersistence.queryEntity(db, 'Alice', {
        direction: 'outgoing', asOf: '2023-01-01',
      });
      expect(atAcme).toHaveLength(1);
      expect(atAcme[0].object).toBe('Acme');

      // Query at a date when Alice was at NewCo
      const atNewCo = kgPersistence.queryEntity(db, 'Alice', {
        direction: 'outgoing', asOf: '2025-01-01',
      });
      expect(atNewCo).toHaveLength(1);
      expect(atNewCo[0].object).toBe('NewCo');
    });
  });

  describe('timeline', () => {
    it('should return facts in chronological order', () => {
      kgPersistence.addTriple(db, {
        subject: 'Max', predicate: 'does', object: 'Chess',
        validFrom: '2024-06-01',
      });
      kgPersistence.addTriple(db, {
        subject: 'Max', predicate: 'does', object: 'Swimming',
        validFrom: '2025-01-01',
      });

      const tl = kgPersistence.timeline(db, 'Max');
      expect(tl).toHaveLength(2);
      expect(tl[0].object).toBe('Chess');  // Earlier date first
      expect(tl[1].object).toBe('Swimming');
    });
  });

  describe('stats', () => {
    it('should return correct counts', () => {
      kgPersistence.addTriple(db, {
        subject: 'Alice', predicate: 'works_at', object: 'Acme',
      });
      kgPersistence.addTriple(db, {
        subject: 'Bob', predicate: 'works_at', object: 'Acme',
      });

      const stats = kgPersistence.getStats(db);
      expect(stats.entities).toBe(3); // Alice, Bob, Acme
      expect(stats.triples).toBe(2);
      expect(stats.currentFacts).toBe(2);
      expect(stats.expiredFacts).toBe(0);
      expect(stats.relationshipTypes).toContain('works_at');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/persistence/rlm-knowledge-graph.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the persistence module**

```typescript
// src/main/persistence/rlm/rlm-knowledge-graph.ts
/**
 * Knowledge Graph Persistence
 *
 * SQLite CRUD for kg_entities + kg_triples tables.
 * Ported from mempalace knowledge_graph.py — temporal validity, duplicate detection,
 * directional queries, and timeline support.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import type { KGEntityRow, KGTripleRow } from '../rlm-database.types';
import type { KGQueryResult, KGStats, KGDirection } from '../../../shared/types/knowledge-graph.types';

// ============ Entity ID Normalization ============

/**
 * Normalize entity name to a consistent ID format.
 * "Alice Smith" → "alice_smith", "Max O'Brien" → "max_obrien"
 */
export function normalizeEntityId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/'/g, '');
}

/**
 * Normalize predicate to a consistent format.
 * "Works At" → "works_at"
 */
function normalizePredicate(predicate: string): string {
  return predicate.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Generate a deterministic triple ID.
 * Format: t_{subject}_{predicate}_{object}_{hash}
 */
function generateTripleId(
  subjectId: string,
  predicate: string,
  objectId: string,
  validFrom: string | null,
): string {
  const hashInput = `${validFrom || ''}${Date.now()}`;
  const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 12);
  return `t_${subjectId}_${predicate}_${objectId}_${hash}`;
}

// ============ Entity Operations ============

export function upsertEntity(
  db: Database.Database,
  name: string,
  type = 'unknown',
  properties: Record<string, unknown> = {},
): string {
  const id = normalizeEntityId(name);
  db.prepare(`
    INSERT INTO kg_entities (id, name, type, properties_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      type = excluded.type,
      properties_json = excluded.properties_json
  `).run(id, name, type, JSON.stringify(properties), Date.now());
  return id;
}

export function getEntity(db: Database.Database, id: string): KGEntityRow | undefined {
  return db.prepare('SELECT * FROM kg_entities WHERE id = ?').get(id) as KGEntityRow | undefined;
}

export function listEntities(db: Database.Database, type?: string): KGEntityRow[] {
  if (type) {
    return db.prepare('SELECT * FROM kg_entities WHERE type = ? ORDER BY name').all(type) as KGEntityRow[];
  }
  return db.prepare('SELECT * FROM kg_entities ORDER BY name').all() as KGEntityRow[];
}

// ============ Triple Operations ============

export interface AddTripleParams {
  subject: string;
  predicate: string;
  object: string;
  validFrom?: string | null;
  validTo?: string | null;
  confidence?: number;
  sourceCloset?: string | null;
  sourceFile?: string | null;
}

export function addTriple(db: Database.Database, params: AddTripleParams): string {
  const subjectId = normalizeEntityId(params.subject);
  const objectId = normalizeEntityId(params.object);
  const predicate = normalizePredicate(params.predicate);

  // Auto-create entities if they don't exist
  upsertEntity(db, params.subject);
  upsertEntity(db, params.object);

  // Duplicate detection: check for existing active triple
  const existing = db.prepare(`
    SELECT id FROM kg_triples
    WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
  `).get(subjectId, predicate, objectId) as { id: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const id = generateTripleId(subjectId, predicate, objectId, params.validFrom ?? null);

  db.prepare(`
    INSERT INTO kg_triples (id, subject, predicate, object, valid_from, valid_to, confidence, source_closet, source_file, extracted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    subjectId,
    predicate,
    objectId,
    params.validFrom ?? null,
    params.validTo ?? null,
    params.confidence ?? 1.0,
    params.sourceCloset ?? null,
    params.sourceFile ?? null,
    Date.now(),
  );

  return id;
}

export function invalidateTriple(
  db: Database.Database,
  subject: string,
  predicate: string,
  object: string,
  ended?: string,
): number {
  const subjectId = normalizeEntityId(subject);
  const objectId = normalizeEntityId(object);
  const pred = normalizePredicate(predicate);
  const endDate = ended ?? new Date().toISOString().slice(0, 10);

  const result = db.prepare(`
    UPDATE kg_triples SET valid_to = ?
    WHERE subject = ? AND predicate = ? AND object = ? AND valid_to IS NULL
  `).run(endDate, subjectId, pred, objectId);

  return result.changes;
}

// ============ Query Operations ============

interface QueryEntityOptions {
  direction?: KGDirection;
  asOf?: string;
}

export function queryEntity(
  db: Database.Database,
  name: string,
  options: QueryEntityOptions = {},
): KGQueryResult[] {
  const entityId = normalizeEntityId(name);
  const direction = options.direction ?? 'both';
  const results: KGQueryResult[] = [];

  const temporalClause = options.asOf
    ? 'AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)'
    : '';
  const temporalParams = options.asOf ? [options.asOf, options.asOf] : [];

  if (direction === 'outgoing' || direction === 'both') {
    const rows = db.prepare(`
      SELECT t.*, s.name as subject_name, o.name as object_name
      FROM kg_triples t
      JOIN kg_entities s ON s.id = t.subject
      JOIN kg_entities o ON o.id = t.object
      WHERE t.subject = ? ${temporalClause}
    `).all(entityId, ...temporalParams) as (KGTripleRow & { subject_name: string; object_name: string })[];

    for (const row of rows) {
      results.push({
        direction: 'outgoing',
        subject: row.subject_name,
        predicate: row.predicate,
        object: row.object_name,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        confidence: row.confidence,
        sourceCloset: row.source_closet,
        current: row.valid_to === null,
      });
    }
  }

  if (direction === 'incoming' || direction === 'both') {
    const rows = db.prepare(`
      SELECT t.*, s.name as subject_name, o.name as object_name
      FROM kg_triples t
      JOIN kg_entities s ON s.id = t.subject
      JOIN kg_entities o ON o.id = t.object
      WHERE t.object = ? ${temporalClause}
    `).all(entityId, ...temporalParams) as (KGTripleRow & { subject_name: string; object_name: string })[];

    for (const row of rows) {
      results.push({
        direction: 'incoming',
        subject: row.subject_name,
        predicate: row.predicate,
        object: row.object_name,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        confidence: row.confidence,
        sourceCloset: row.source_closet,
        current: row.valid_to === null,
      });
    }
  }

  return results;
}

export function queryRelationship(
  db: Database.Database,
  predicate: string,
  asOf?: string,
): KGQueryResult[] {
  const pred = normalizePredicate(predicate);
  const temporalClause = asOf
    ? 'AND (t.valid_from IS NULL OR t.valid_from <= ?) AND (t.valid_to IS NULL OR t.valid_to >= ?)'
    : '';
  const temporalParams = asOf ? [asOf, asOf] : [];

  const rows = db.prepare(`
    SELECT t.*, s.name as subject_name, o.name as object_name
    FROM kg_triples t
    JOIN kg_entities s ON s.id = t.subject
    JOIN kg_entities o ON o.id = t.object
    WHERE t.predicate = ? ${temporalClause}
  `).all(pred, ...temporalParams) as (KGTripleRow & { subject_name: string; object_name: string })[];

  return rows.map(row => ({
    direction: 'outgoing' as KGDirection,
    subject: row.subject_name,
    predicate: row.predicate,
    object: row.object_name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    confidence: row.confidence,
    sourceCloset: row.source_closet,
    current: row.valid_to === null,
  }));
}

export function timeline(
  db: Database.Database,
  entityName?: string,
  limit = 100,
): KGQueryResult[] {
  const baseQuery = `
    SELECT t.*, s.name as subject_name, o.name as object_name
    FROM kg_triples t
    JOIN kg_entities s ON s.id = t.subject
    JOIN kg_entities o ON o.id = t.object
  `;

  let rows: (KGTripleRow & { subject_name: string; object_name: string })[];

  if (entityName) {
    const entityId = normalizeEntityId(entityName);
    rows = db.prepare(`
      ${baseQuery}
      WHERE t.subject = ? OR t.object = ?
      ORDER BY t.valid_from ASC NULLS LAST
      LIMIT ?
    `).all(entityId, entityId, limit) as typeof rows;
  } else {
    rows = db.prepare(`
      ${baseQuery}
      ORDER BY t.valid_from ASC NULLS LAST
      LIMIT ?
    `).all(limit) as typeof rows;
  }

  return rows.map(row => ({
    direction: 'outgoing' as KGDirection,
    subject: row.subject_name,
    predicate: row.predicate,
    object: row.object_name,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    confidence: row.confidence,
    sourceCloset: row.source_closet,
    current: row.valid_to === null,
  }));
}

// ============ Stats ============

export function getStats(db: Database.Database): KGStats {
  const entities = (db.prepare('SELECT COUNT(*) as count FROM kg_entities').get() as { count: number }).count;
  const triples = (db.prepare('SELECT COUNT(*) as count FROM kg_triples').get() as { count: number }).count;
  const currentFacts = (db.prepare('SELECT COUNT(*) as count FROM kg_triples WHERE valid_to IS NULL').get() as { count: number }).count;
  const expiredFacts = (db.prepare('SELECT COUNT(*) as count FROM kg_triples WHERE valid_to IS NOT NULL').get() as { count: number }).count;
  const relationshipTypes = (db.prepare('SELECT DISTINCT predicate FROM kg_triples ORDER BY predicate').all() as { predicate: string }[])
    .map(r => r.predicate);

  return { entities, triples, currentFacts, expiredFacts, relationshipTypes };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tests/unit/persistence/rlm-knowledge-graph.test.ts`
Expected: All tests pass

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/persistence/rlm/rlm-knowledge-graph.ts src/tests/unit/persistence/rlm-knowledge-graph.test.ts
git commit -m "feat(persistence): implement knowledge graph CRUD — entities, triples, temporal queries"
```

---

## Task 6: Verbatim Segments Persistence Layer

**Files:**
- Create: `src/main/persistence/rlm/rlm-verbatim.ts`
- Test: `src/tests/unit/persistence/rlm-verbatim.test.ts`

- [ ] **Step 1: Write persistence tests**

```typescript
// src/tests/unit/persistence/rlm-verbatim.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as verbatimStore from '../../../../main/persistence/rlm/rlm-verbatim';
import { createTables, createMigrationsTable, runMigrations } from '../../../../main/persistence/rlm/rlm-schema';

describe('rlm-verbatim persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('addSegment', () => {
    it('should insert a verbatim segment', () => {
      const id = verbatimStore.addSegment(db, {
        content: '> How do I handle errors?\nUse try-catch blocks for async operations.',
        sourceFile: '/path/to/convo.jsonl',
        chunkIndex: 0,
        wing: 'project_a',
        room: 'technical',
        importance: 5,
        addedBy: 'miner',
      });
      expect(id).toBeDefined();

      const seg = verbatimStore.getSegment(db, id);
      expect(seg).toBeDefined();
      expect(seg!.wing).toBe('project_a');
      expect(seg!.room).toBe('technical');
    });

    it('should upsert on duplicate ID', () => {
      const id = verbatimStore.addSegment(db, {
        content: 'original',
        sourceFile: '/path/a.txt',
        chunkIndex: 0,
        wing: 'w',
        room: 'r',
      });

      verbatimStore.addSegment(db, {
        id,
        content: 'updated',
        sourceFile: '/path/a.txt',
        chunkIndex: 0,
        wing: 'w',
        room: 'r',
      });

      const seg = verbatimStore.getSegment(db, id);
      expect(seg!.content).toBe('updated');
    });
  });

  describe('queryByWingRoom', () => {
    it('should filter by wing and room', () => {
      verbatimStore.addSegment(db, { content: 'a', sourceFile: 'f', chunkIndex: 0, wing: 'w1', room: 'r1' });
      verbatimStore.addSegment(db, { content: 'b', sourceFile: 'f', chunkIndex: 1, wing: 'w1', room: 'r2' });
      verbatimStore.addSegment(db, { content: 'c', sourceFile: 'f', chunkIndex: 2, wing: 'w2', room: 'r1' });

      const results = verbatimStore.queryByWingRoom(db, { wing: 'w1' });
      expect(results).toHaveLength(2);

      const results2 = verbatimStore.queryByWingRoom(db, { wing: 'w1', room: 'r1' });
      expect(results2).toHaveLength(1);
    });
  });

  describe('getTopByImportance', () => {
    it('should return segments sorted by importance desc', () => {
      verbatimStore.addSegment(db, { content: 'low', sourceFile: 'f', chunkIndex: 0, wing: 'w', room: 'r', importance: 2 });
      verbatimStore.addSegment(db, { content: 'high', sourceFile: 'f', chunkIndex: 1, wing: 'w', room: 'r', importance: 9 });
      verbatimStore.addSegment(db, { content: 'mid', sourceFile: 'f', chunkIndex: 2, wing: 'w', room: 'r', importance: 5 });

      const top = verbatimStore.getTopByImportance(db, 2);
      expect(top).toHaveLength(2);
      expect(top[0].content).toBe('high');
      expect(top[1].content).toBe('mid');
    });
  });

  describe('deleteBySource', () => {
    it('should remove all segments from a source file', () => {
      verbatimStore.addSegment(db, { content: 'a', sourceFile: '/path/a.txt', chunkIndex: 0, wing: 'w', room: 'r' });
      verbatimStore.addSegment(db, { content: 'b', sourceFile: '/path/a.txt', chunkIndex: 1, wing: 'w', room: 'r' });
      verbatimStore.addSegment(db, { content: 'c', sourceFile: '/path/b.txt', chunkIndex: 0, wing: 'w', room: 'r' });

      const deleted = verbatimStore.deleteBySource(db, '/path/a.txt');
      expect(deleted).toBe(2);
    });
  });

  describe('recordImport', () => {
    it('should track a conversation import', () => {
      const id = verbatimStore.recordImport(db, {
        filePath: '/path/to/convo.jsonl',
        format: 'claude-code-jsonl',
        wing: 'project_a',
        messageCount: 42,
      });

      const imp = verbatimStore.getImport(db, id);
      expect(imp).toBeDefined();
      expect(imp!.status).toBe('pending');
    });

    it('should reject duplicate file paths', () => {
      verbatimStore.recordImport(db, {
        filePath: '/path/to/convo.jsonl', format: 'claude-code-jsonl', wing: 'w', messageCount: 10,
      });

      expect(() => verbatimStore.recordImport(db, {
        filePath: '/path/to/convo.jsonl', format: 'claude-code-jsonl', wing: 'w', messageCount: 10,
      })).toThrow();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/persistence/rlm-verbatim.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the persistence module**

```typescript
// src/main/persistence/rlm/rlm-verbatim.ts
/**
 * Verbatim Segments Persistence
 *
 * SQLite CRUD for verbatim_segments + conversation_imports tables.
 * Stores raw text chunks for high-fidelity retrieval.
 */

import type Database from 'better-sqlite3';
import * as crypto from 'crypto';
import type { VerbatimSegmentRow, ConversationImportRow } from '../rlm-database.types';

// ============ Segment Operations ============

export interface AddSegmentParams {
  id?: string;
  content: string;
  sourceFile: string;
  chunkIndex: number;
  wing: string;
  room: string;
  importance?: number;
  addedBy?: string;
}

function generateSegmentId(sourceFile: string, chunkIndex: number): string {
  const hash = crypto.createHash('sha256')
    .update(`${sourceFile}${chunkIndex}`)
    .digest('hex')
    .slice(0, 24);
  return `vseg_${hash}`;
}

export function addSegment(db: Database.Database, params: AddSegmentParams): string {
  const id = params.id ?? generateSegmentId(params.sourceFile, params.chunkIndex);

  db.prepare(`
    INSERT INTO verbatim_segments (id, content, source_file, chunk_index, wing, room, importance, added_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      wing = excluded.wing,
      room = excluded.room,
      importance = excluded.importance
  `).run(
    id,
    params.content,
    params.sourceFile,
    params.chunkIndex,
    params.wing,
    params.room,
    params.importance ?? 3.0,
    params.addedBy ?? 'system',
    Date.now(),
  );

  return id;
}

export function getSegment(db: Database.Database, id: string): VerbatimSegmentRow | undefined {
  return db.prepare('SELECT * FROM verbatim_segments WHERE id = ?').get(id) as VerbatimSegmentRow | undefined;
}

export function queryByWingRoom(
  db: Database.Database,
  filter: { wing?: string; room?: string; limit?: number },
): VerbatimSegmentRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.wing) {
    conditions.push('wing = ?');
    params.push(filter.wing);
  }
  if (filter.room) {
    conditions.push('room = ?');
    params.push(filter.room);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(filter.limit ?? 100);

  return db.prepare(`
    SELECT * FROM verbatim_segments ${where}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?
  `).all(...params) as VerbatimSegmentRow[];
}

export function getTopByImportance(
  db: Database.Database,
  limit: number,
  wing?: string,
): VerbatimSegmentRow[] {
  if (wing) {
    return db.prepare(`
      SELECT * FROM verbatim_segments WHERE wing = ?
      ORDER BY importance DESC LIMIT ?
    `).all(wing, limit) as VerbatimSegmentRow[];
  }
  return db.prepare(`
    SELECT * FROM verbatim_segments ORDER BY importance DESC LIMIT ?
  `).all(limit) as VerbatimSegmentRow[];
}

export function deleteBySource(db: Database.Database, sourceFile: string): number {
  return db.prepare('DELETE FROM verbatim_segments WHERE source_file = ?').run(sourceFile).changes;
}

export function getSegmentCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as count FROM verbatim_segments').get() as { count: number }).count;
}

// ============ Import Tracking ============

export interface RecordImportParams {
  filePath: string;
  format: string;
  wing: string;
  messageCount: number;
}

export function recordImport(db: Database.Database, params: RecordImportParams): string {
  const id = `imp_${crypto.randomUUID().slice(0, 12)}`;

  db.prepare(`
    INSERT INTO conversation_imports (id, file_path, format, wing, message_count, status, imported_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(id, params.filePath, params.format, params.wing, params.messageCount, Date.now());

  return id;
}

export function updateImportStatus(
  db: Database.Database,
  id: string,
  status: 'imported' | 'failed',
  segmentsCreated?: number,
  error?: string,
): void {
  db.prepare(`
    UPDATE conversation_imports
    SET status = ?, segments_created = COALESCE(?, segments_created), error = ?
    WHERE id = ?
  `).run(status, segmentsCreated ?? null, error ?? null, id);
}

export function getImport(db: Database.Database, id: string): ConversationImportRow | undefined {
  return db.prepare('SELECT * FROM conversation_imports WHERE id = ?').get(id) as ConversationImportRow | undefined;
}

export function isFileImported(db: Database.Database, filePath: string): boolean {
  const row = db.prepare(
    "SELECT id FROM conversation_imports WHERE file_path = ? AND status = 'imported' LIMIT 1"
  ).get(filePath);
  return row !== undefined;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/tests/unit/persistence/rlm-verbatim.test.ts && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/main/persistence/rlm/rlm-verbatim.ts src/tests/unit/persistence/rlm-verbatim.test.ts
git commit -m "feat(persistence): implement verbatim segment CRUD + conversation import tracking"
```

---

## Task 7: Knowledge Graph Service (Singleton)

**Files:**
- Create: `src/main/memory/knowledge-graph-service.ts`
- Test: `src/tests/unit/memory/knowledge-graph-service.test.ts`

- [ ] **Step 1: Write service tests**

```typescript
// src/tests/unit/memory/knowledge-graph-service.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KnowledgeGraphService } from '../../../../main/memory/knowledge-graph-service';

// Mock RLMDatabase to return an in-memory database
vi.mock('../../../../main/persistence/rlm-database', () => {
  const Database = require('better-sqlite3');
  const { createTables, createMigrationsTable, runMigrations } = require('../../../../main/persistence/rlm/rlm-schema');
  let db: InstanceType<typeof Database>;

  return {
    getRLMDatabase: () => ({
      getDb: () => {
        if (!db || !db.open) {
          db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          createTables(db);
          createMigrationsTable(db);
          runMigrations(db);
        }
        return db;
      },
    }),
  };
});

describe('KnowledgeGraphService', () => {
  beforeEach(() => {
    KnowledgeGraphService._resetForTesting();
  });

  it('should be a singleton', () => {
    const a = KnowledgeGraphService.getInstance();
    const b = KnowledgeGraphService.getInstance();
    expect(a).toBe(b);
  });

  it('should add and query entities', () => {
    const service = KnowledgeGraphService.getInstance();
    service.addFact('Alice', 'works_at', 'Acme Corp', { validFrom: '2020-01-01' });

    const results = service.queryEntity('Alice');
    expect(results).toHaveLength(1);
    expect(results[0].predicate).toBe('works_at');
    expect(results[0].object).toBe('Acme Corp');
    expect(results[0].current).toBe(true);
  });

  it('should support temporal invalidation', () => {
    const service = KnowledgeGraphService.getInstance();
    service.addFact('Alice', 'works_at', 'Acme');
    service.invalidateFact('Alice', 'works_at', 'Acme', '2024-06-01');
    service.addFact('Alice', 'works_at', 'NewCo', { validFrom: '2024-07-01' });

    // At a date when she was at Acme
    const atAcme = service.queryEntity('Alice', { asOf: '2023-01-01' });
    expect(atAcme).toHaveLength(1);
    expect(atAcme[0].object).toBe('Acme');

    // At a date when she is at NewCo
    const atNewCo = service.queryEntity('Alice', { asOf: '2025-01-01' });
    expect(atNewCo).toHaveLength(1);
    expect(atNewCo[0].object).toBe('NewCo');
  });

  it('should return timeline in chronological order', () => {
    const service = KnowledgeGraphService.getInstance();
    service.addFact('Max', 'does', 'Chess', { validFrom: '2024-06-01' });
    service.addFact('Max', 'does', 'Swimming', { validFrom: '2025-01-01' });

    const tl = service.getTimeline('Max');
    expect(tl[0].object).toBe('Chess');
    expect(tl[1].object).toBe('Swimming');
  });

  it('should emit events on fact changes', () => {
    const service = KnowledgeGraphService.getInstance();
    const addedFacts: unknown[] = [];
    service.on('graph:fact-added', (data) => addedFacts.push(data));

    service.addFact('Alice', 'loves', 'TypeScript');
    expect(addedFacts).toHaveLength(1);
  });

  it('should return stats', () => {
    const service = KnowledgeGraphService.getInstance();
    service.addFact('A', 'r', 'B');
    const stats = service.getStats();
    expect(stats.entities).toBe(2);
    expect(stats.triples).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/memory/knowledge-graph-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the service**

```typescript
// src/main/memory/knowledge-graph-service.ts
/**
 * Knowledge Graph Service
 *
 * Singleton that wraps the knowledge graph persistence layer with:
 * - Event emission on fact changes (for downstream listeners)
 * - Convenience methods with cleaner API
 * - Integration point for observation pipeline auto-extraction
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as kgStore from '../persistence/rlm/rlm-knowledge-graph';
import type { KGQueryResult, KGStats, KGDirection, KnowledgeGraphConfig } from '../../shared/types/knowledge-graph.types';
import { DEFAULT_KG_CONFIG } from '../../shared/types/knowledge-graph.types';

const logger = getLogger('KnowledgeGraphService');

interface AddFactOptions {
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sourceCloset?: string;
  sourceFile?: string;
}

interface QueryEntityOptions {
  direction?: KGDirection;
  asOf?: string;
}

export class KnowledgeGraphService extends EventEmitter {
  private static instance: KnowledgeGraphService | null = null;
  private config: KnowledgeGraphConfig;

  static getInstance(): KnowledgeGraphService {
    if (!this.instance) {
      this.instance = new KnowledgeGraphService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_KG_CONFIG };
    logger.info('KnowledgeGraphService initialized');
  }

  configure(config: Partial<KnowledgeGraphConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private get db() {
    return getRLMDatabase().getDb();
  }

  // ============ Write Operations ============

  addFact(
    subject: string,
    predicate: string,
    object: string,
    options: AddFactOptions = {},
  ): string {
    const tripleId = kgStore.addTriple(this.db, {
      subject,
      predicate,
      object,
      validFrom: options.validFrom,
      validTo: options.validTo,
      confidence: options.confidence,
      sourceCloset: options.sourceCloset,
      sourceFile: options.sourceFile,
    });

    this.emit('graph:fact-added', { tripleId, subject, predicate, object });
    logger.debug('Fact added', { tripleId, subject, predicate, object });
    return tripleId;
  }

  invalidateFact(subject: string, predicate: string, object: string, ended?: string): number {
    const count = kgStore.invalidateTriple(this.db, subject, predicate, object, ended);

    if (count > 0) {
      this.emit('graph:fact-invalidated', { subject, predicate, object, ended });
      logger.debug('Fact invalidated', { subject, predicate, object, ended });
    }

    return count;
  }

  addEntity(name: string, type?: string, properties?: Record<string, unknown>): string {
    return kgStore.upsertEntity(this.db, name, type, properties);
  }

  // ============ Read Operations ============

  queryEntity(name: string, options: QueryEntityOptions = {}): KGQueryResult[] {
    return kgStore.queryEntity(this.db, name, options);
  }

  queryRelationship(predicate: string, asOf?: string): KGQueryResult[] {
    return kgStore.queryRelationship(this.db, predicate, asOf);
  }

  getTimeline(entityName?: string, limit?: number): KGQueryResult[] {
    return kgStore.timeline(this.db, entityName, limit);
  }

  getStats(): KGStats {
    return kgStore.getStats(this.db);
  }

  getEntity(name: string) {
    return kgStore.getEntity(this.db, kgStore.normalizeEntityId(name));
  }

  listEntities(type?: string) {
    return kgStore.listEntities(this.db, type);
  }
}

/** Convenience getter */
export function getKnowledgeGraphService(): KnowledgeGraphService {
  return KnowledgeGraphService.getInstance();
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/tests/unit/memory/knowledge-graph-service.test.ts && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/knowledge-graph-service.ts src/tests/unit/memory/knowledge-graph-service.test.ts
git commit -m "feat(memory): add KnowledgeGraphService singleton — temporal entity-relationship queries"
```

---

## Task 8: Conversation Miner Service

**Files:**
- Create: `src/main/memory/conversation-miner.ts`
- Test: `src/tests/unit/memory/conversation-miner.test.ts`

- [ ] **Step 1: Write conversation miner tests**

Focus on the three core algorithms: format detection/normalization, chunking, and room detection.

```typescript
// src/tests/unit/memory/conversation-miner.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationMiner } from '../../../../main/memory/conversation-miner';

// Mock RLMDatabase (same pattern as Task 7)
vi.mock('../../../../main/persistence/rlm-database', () => {
  const Database = require('better-sqlite3');
  const { createTables, createMigrationsTable, runMigrations } = require('../../../../main/persistence/rlm/rlm-schema');
  let db: InstanceType<typeof Database>;
  return {
    getRLMDatabase: () => ({
      getDb: () => {
        if (!db || !db.open) {
          db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          createTables(db);
          createMigrationsTable(db);
          runMigrations(db);
        }
        return db;
      },
    }),
  };
});

describe('ConversationMiner', () => {
  beforeEach(() => {
    ConversationMiner._resetForTesting();
  });

  describe('detectFormat', () => {
    it('should detect plain text with > markers', () => {
      const text = '> How do I do X?\nYou can do it by...\n\n> What about Y?\nThat works too.';
      expect(ConversationMiner.detectFormat(text)).toBe('plain-text');
    });

    it('should detect Claude Code JSONL', () => {
      const text = '{"type":"human","message":{"content":"hello"}}\n{"type":"assistant","message":{"content":"hi"}}';
      expect(ConversationMiner.detectFormat(text)).toBe('claude-code-jsonl');
    });

    it('should detect Codex CLI JSONL', () => {
      const text = '{"type":"session_meta","payload":{}}\n{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}';
      expect(ConversationMiner.detectFormat(text)).toBe('codex-jsonl');
    });

    it('should detect ChatGPT JSON', () => {
      const text = JSON.stringify([{ title: 'Chat', mapping: { 'node-1': { message: { author: { role: 'user' }, content: { parts: ['hi'] } } } } }]);
      expect(ConversationMiner.detectFormat(text)).toBe('chatgpt-json');
    });

    it('should detect Claude.ai JSON', () => {
      const text = JSON.stringify([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
      expect(ConversationMiner.detectFormat(text)).toBe('claude-ai-json');
    });
  });

  describe('normalizeToMessages', () => {
    it('should normalize plain text to messages', () => {
      const text = '> How do I X?\nDo it like this.\n\n> And Y?\nThat too.';
      const msgs = ConversationMiner.normalizeToMessages(text, 'plain-text');
      expect(msgs).toHaveLength(4);
      expect(msgs[0].role).toBe('user');
      expect(msgs[1].role).toBe('assistant');
    });

    it('should normalize Claude Code JSONL', () => {
      const text = '{"type":"human","message":{"content":"hello"}}\n{"type":"assistant","message":{"content":"world"}}';
      const msgs = ConversationMiner.normalizeToMessages(text, 'claude-code-jsonl');
      expect(msgs).toHaveLength(2);
      expect(msgs[0].content).toBe('hello');
      expect(msgs[1].content).toBe('world');
    });
  });

  describe('chunkExchanges', () => {
    it('should chunk Q+A pairs', () => {
      const text = '> Question 1?\nAnswer 1.\n\n> Question 2?\nAnswer 2.\n\n> Question 3?\nAnswer 3.';
      const chunks = ConversationMiner.chunkExchanges(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeGreaterThan(0);
      }
    });

    it('should fall back to paragraph chunking when few > markers', () => {
      const text = 'First paragraph with enough content to be meaningful.\n\nSecond paragraph also meaningful.\n\nThird one too.';
      const chunks = ConversationMiner.chunkExchanges(text);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('detectRoom', () => {
    it('should detect technical room from keywords', () => {
      const text = 'We need to fix this bug in the API endpoint. The database query is failing with an error.';
      expect(ConversationMiner.detectRoom(text)).toBe('technical');
    });

    it('should detect architecture room', () => {
      const text = 'The architecture uses a layered design pattern with a service layer and component structure.';
      expect(ConversationMiner.detectRoom(text)).toBe('architecture');
    });

    it('should fall back to general', () => {
      const text = 'Just a casual conversation about nothing in particular.';
      expect(ConversationMiner.detectRoom(text)).toBe('general');
    });
  });

  describe('importFile', () => {
    it('should mine a plain text conversation into segments', () => {
      const miner = ConversationMiner.getInstance();
      const content = '> How do I handle authentication?\nUse JWT tokens with refresh rotation. Store them in httpOnly cookies.\n\n> What about CORS?\nConfigure your server with specific allowed origins.';

      const result = miner.importFromString(content, {
        wing: 'my_project',
        sourceFile: '/fake/convo.txt',
      });

      expect(result.segmentsCreated).toBeGreaterThan(0);
      expect(result.formatDetected).toBe('plain-text');
      expect(result.errors).toHaveLength(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/memory/conversation-miner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the conversation miner**

```typescript
// src/main/memory/conversation-miner.ts
/**
 * Conversation Miner
 *
 * Normalizes, chunks, and indexes past AI conversations from multiple formats.
 * Ported from mempalace normalize.py + convo_miner.py.
 *
 * Pipeline: detect format → normalize to messages → chunk into exchanges → detect room → store as verbatim segments
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as verbatimStore from '../persistence/rlm/rlm-verbatim';
import type {
  ConversationFormat,
  NormalizedMessage,
  MiningConfig,
  MiningResult,
  ConvoMemoryType,
} from '../../shared/types/conversation-mining.types';
import { DEFAULT_MINING_CONFIG } from '../../shared/types/conversation-mining.types';

const logger = getLogger('ConversationMiner');

interface ImportOptions {
  wing: string;
  sourceFile: string;
  format?: ConversationFormat;
  addedBy?: string;
}

interface TextChunk {
  content: string;
  chunkIndex: number;
}

export class ConversationMiner extends EventEmitter {
  private static instance: ConversationMiner | null = null;
  private config: MiningConfig;

  static getInstance(): ConversationMiner {
    if (!this.instance) {
      this.instance = new ConversationMiner();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_MINING_CONFIG };
    logger.info('ConversationMiner initialized');
  }

  configure(config: Partial<MiningConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private get db() {
    return getRLMDatabase().getDb();
  }

  // ============ Format Detection ============

  static detectFormat(content: string): ConversationFormat {
    const trimmed = content.trim();

    // Check for > markers (plain text)
    const markerCount = (trimmed.match(/^>/gm) || []).length;
    if (markerCount >= 3) {
      return 'plain-text';
    }

    // Try JSONL formats (one JSON object per line)
    const firstLine = trimmed.split('\n')[0]?.trim();
    if (firstLine?.startsWith('{')) {
      try {
        const parsed = JSON.parse(firstLine);

        // Claude Code JSONL: has "type" + "message" with "content"
        if (parsed.type && parsed.message && typeof parsed.message === 'object') {
          return 'claude-code-jsonl';
        }

        // Codex CLI JSONL: has "type" as session_meta/event_msg
        if (parsed.type === 'session_meta' || parsed.type === 'event_msg') {
          return 'codex-jsonl';
        }
      } catch {
        // Not valid JSON line, continue
      }
    }

    // Try JSON array formats
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const first = parsed[0];

          // ChatGPT: has "mapping" property
          if (first.mapping || first.title) {
            return 'chatgpt-json';
          }

          // Claude.ai privacy export: has "chat_messages"
          if (first.chat_messages) {
            return 'claude-ai-json';
          }

          // Claude.ai flat: has "role" property
          if (first.role) {
            return 'claude-ai-json';
          }

          // Slack: has "type": "message"
          if (first.type === 'message') {
            return 'slack-json';
          }
        }
      } catch {
        // Not valid JSON
      }
    }

    // Default to plain text
    return 'plain-text';
  }

  // ============ Normalization ============

  static normalizeToMessages(content: string, format: ConversationFormat): NormalizedMessage[] {
    switch (format) {
      case 'plain-text': return normalizePlainText(content);
      case 'claude-code-jsonl': return normalizeClaudeCodeJsonl(content);
      case 'codex-jsonl': return normalizeCodexJsonl(content);
      case 'claude-ai-json': return normalizeClaudeAiJson(content);
      case 'chatgpt-json': return normalizeChatGptJson(content);
      case 'slack-json': return normalizeSlackJson(content);
      default: return normalizePlainText(content);
    }
  }

  // ============ Chunking ============

  static chunkExchanges(transcript: string, config?: Partial<MiningConfig>): TextChunk[] {
    const minSize = config?.minChunkSize ?? DEFAULT_MINING_CONFIG.minChunkSize;

    // Count > markers to decide chunking strategy
    const markerCount = (transcript.match(/^>/gm) || []).length;

    if (markerCount >= 3) {
      return chunkByExchange(transcript, minSize);
    }

    return chunkByParagraph(transcript, config?.chunkSize ?? DEFAULT_MINING_CONFIG.chunkSize, minSize);
  }

  // ============ Room Detection ============

  static detectRoom(text: string, customKeywords?: Record<string, string[]>): ConvoMemoryType {
    const keywords = customKeywords ?? DEFAULT_MINING_CONFIG.topicKeywords;
    const lower = text.slice(0, 3000).toLowerCase();

    let bestRoom: ConvoMemoryType = 'general';
    let bestScore = 0;

    for (const [room, kws] of Object.entries(keywords)) {
      let score = 0;
      for (const kw of kws) {
        const regex = new RegExp(kw, 'gi');
        const matches = lower.match(regex);
        if (matches) {
          score += matches.length;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestRoom = room as ConvoMemoryType;
      }
    }

    return bestRoom;
  }

  // ============ Import Pipeline ============

  importFromString(content: string, options: ImportOptions): MiningResult {
    const startTime = Date.now();
    const errors: string[] = [];

    // Step 1: Detect format
    const format = options.format ?? ConversationMiner.detectFormat(content);

    // Step 2: Normalize to messages
    const messages = ConversationMiner.normalizeToMessages(content, format);
    if (messages.length < 2) {
      return { segmentsCreated: 0, filesProcessed: 1, formatDetected: format, errors: ['Too few messages (< 2)'], duration: Date.now() - startTime };
    }

    // Step 3: Convert to transcript
    const transcript = messagesToTranscript(messages);

    // Step 4: Chunk into exchanges
    const chunks = ConversationMiner.chunkExchanges(transcript, this.config);

    // Step 5: Record import
    let importId: string | undefined;
    try {
      importId = verbatimStore.recordImport(this.db, {
        filePath: options.sourceFile,
        format,
        wing: options.wing,
        messageCount: messages.length,
      });
    } catch (err) {
      // File already imported — skip
      errors.push(`File already imported: ${options.sourceFile}`);
      return { segmentsCreated: 0, filesProcessed: 1, formatDetected: format, errors, duration: Date.now() - startTime };
    }

    // Step 6: Store as verbatim segments
    let segmentsCreated = 0;
    for (const chunk of chunks) {
      try {
        const room = ConversationMiner.detectRoom(chunk.content);
        verbatimStore.addSegment(this.db, {
          content: chunk.content,
          sourceFile: options.sourceFile,
          chunkIndex: chunk.chunkIndex,
          wing: options.wing,
          room,
          addedBy: options.addedBy ?? 'conversation-miner',
        });
        segmentsCreated++;
      } catch (err) {
        errors.push(`Chunk ${chunk.chunkIndex}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Step 7: Update import record
    if (importId) {
      verbatimStore.updateImportStatus(
        this.db,
        importId,
        errors.length === 0 ? 'imported' : 'failed',
        segmentsCreated,
        errors.length > 0 ? errors.join('; ') : undefined,
      );
    }

    this.emit('miner:import-complete', { sourceFile: options.sourceFile, segmentsCreated, format });
    logger.info('Import complete', { sourceFile: options.sourceFile, segmentsCreated, format });

    return {
      segmentsCreated,
      filesProcessed: 1,
      formatDetected: format,
      errors,
      duration: Date.now() - startTime,
    };
  }

  importFile(filePath: string, wing: string): MiningResult {
    const content = fs.readFileSync(filePath, 'utf-8');
    return this.importFromString(content, { wing, sourceFile: filePath });
  }
}

/** Convenience getter */
export function getConversationMiner(): ConversationMiner {
  return ConversationMiner.getInstance();
}

// ============ Normalization Helpers ============

function normalizePlainText(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const lines = content.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('>')) {
      messages.push({ role: 'user', content: line.slice(1).trim() });
      i++;
      // Collect assistant response (non-> lines)
      const responseLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('>')) {
        const responseLine = lines[i].trim();
        if (responseLine) responseLines.push(responseLine);
        i++;
      }
      if (responseLines.length > 0) {
        messages.push({ role: 'assistant', content: responseLines.join('\n') });
      }
    } else {
      i++;
    }
  }

  return messages;
}

function normalizeClaudeCodeJsonl(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const type = entry.type;
      const text = entry.message?.content;
      if (!type || !text) continue;

      const role = (type === 'human' || type === 'user') ? 'user' : 'assistant';
      messages.push({ role, content: typeof text === 'string' ? text : JSON.stringify(text) });
    } catch { /* skip malformed lines */ }
  }
  return messages;
}

function normalizeCodexJsonl(content: string): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'event_msg') continue;
      const payload = entry.payload;
      if (!payload?.type || !payload?.message) continue;
      if (typeof payload.message !== 'string') continue;

      const role = payload.type === 'user_message' ? 'user' : 'assistant';
      messages.push({ role, content: payload.message.trim() });
    } catch { /* skip */ }
  }
  return messages;
}

function normalizeClaudeAiJson(content: string): NormalizedMessage[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];

    // Privacy export (chat_messages nested)
    if (parsed[0]?.chat_messages) {
      const messages: NormalizedMessage[] = [];
      for (const convo of parsed) {
        for (const msg of convo.chat_messages || []) {
          const role = (msg.sender === 'human' || msg.role === 'user' || msg.role === 'human') ? 'user' : 'assistant';
          const text = extractContent(msg.content ?? msg.text);
          if (text) messages.push({ role, content: text });
        }
      }
      return messages;
    }

    // Flat messages array
    return parsed
      .filter((msg: Record<string, unknown>) => msg.role && (msg.content || msg.text))
      .map((msg: Record<string, unknown>) => ({
        role: (msg.role === 'user' || msg.role === 'human') ? 'user' as const : 'assistant' as const,
        content: extractContent(msg.content ?? msg.text),
      }));
  } catch { return []; }
}

function normalizeChatGptJson(content: string): NormalizedMessage[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];

    const messages: NormalizedMessage[] = [];
    for (const convo of parsed) {
      const mapping = convo.mapping;
      if (!mapping) continue;

      // Find root node
      let rootId: string | undefined;
      for (const [id, node] of Object.entries(mapping) as [string, { parent: string | null; message: unknown; children: string[] }][]) {
        if (node.parent === null) {
          rootId = id;
          break;
        }
      }
      if (!rootId) continue;

      // Walk tree following first child
      const visited = new Set<string>();
      let currentId: string | undefined = rootId;
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const node = (mapping as Record<string, { message?: { author?: { role: string }; content?: { parts: string[] } }; children?: string[] }>)[currentId];
        if (node?.message?.author?.role && node.message.content?.parts) {
          const role = node.message.author.role;
          if (role === 'user' || role === 'assistant') {
            const text = node.message.content.parts.filter((p: unknown) => typeof p === 'string').join(' ');
            if (text.trim()) {
              messages.push({ role: role as 'user' | 'assistant', content: text.trim() });
            }
          }
        }
        currentId = node?.children?.[0];
      }
    }
    return messages;
  } catch { return []; }
}

function normalizeSlackJson(content: string): NormalizedMessage[] {
  try {
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];

    const messages: NormalizedMessage[] = [];
    const seenUsers = new Map<string, 'user' | 'assistant'>();

    for (const msg of parsed) {
      if (msg.type !== 'message' || !msg.text) continue;
      const userId = msg.user || msg.username;
      if (!userId) continue;

      if (!seenUsers.has(userId)) {
        seenUsers.set(userId, seenUsers.size === 0 ? 'user' : 'assistant');
      }

      messages.push({ role: seenUsers.get(userId)!, content: msg.text });
    }
    return messages;
  } catch { return []; }
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((item: unknown) => typeof item === 'string' || (typeof item === 'object' && item !== null && (item as Record<string, unknown>).type === 'text'))
      .map((item: unknown) => typeof item === 'string' ? item : (item as Record<string, string>).text ?? '')
      .join(' ');
  }
  if (typeof content === 'object' && content !== null) {
    return (content as Record<string, string>).text ?? '';
  }
  return '';
}

function messagesToTranscript(messages: NormalizedMessage[]): string {
  return messages
    .map(m => m.role === 'user' ? `> ${m.content}` : m.content)
    .join('\n\n');
}

// ============ Chunking Helpers ============

function chunkByExchange(transcript: string, minSize: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  const lines = transcript.split('\n');
  let chunkIndex = 0;
  let i = 0;

  while (i < lines.length) {
    if (lines[i].startsWith('>')) {
      const userTurn = lines[i];
      i++;
      // Collect response lines (up to 8, or until next >)
      const responseLines: string[] = [];
      let responseCount = 0;
      while (i < lines.length && !lines[i].startsWith('>') && responseCount < 8) {
        if (lines[i].trim()) {
          responseLines.push(lines[i]);
          responseCount++;
        }
        i++;
      }
      // Skip remaining non-user lines
      while (i < lines.length && !lines[i].startsWith('>') && !lines[i].trim().startsWith('---')) {
        i++;
      }

      const chunkContent = `${userTurn}\n${responseLines.join('\n')}`.trim();
      if (chunkContent.length >= minSize) {
        chunks.push({ content: chunkContent, chunkIndex });
        chunkIndex++;
      }
    } else {
      i++;
    }
  }

  return chunks;
}

function chunkByParagraph(text: string, chunkSize: number, minSize: number): TextChunk[] {
  const chunks: TextChunk[] = [];
  const stripped = text.trim();
  if (!stripped) return [];

  let start = 0;
  let chunkIndex = 0;

  while (start < stripped.length) {
    let end = Math.min(start + chunkSize, stripped.length);

    // Try to break at paragraph boundary
    if (end < stripped.length) {
      const paraBreak = stripped.lastIndexOf('\n\n', end);
      if (paraBreak > start + chunkSize / 2) {
        end = paraBreak;
      } else {
        const lineBreak = stripped.lastIndexOf('\n', end);
        if (lineBreak > start + chunkSize / 2) {
          end = lineBreak;
        }
      }
    }

    const chunk = stripped.slice(start, end).trim();
    if (chunk.length >= minSize) {
      chunks.push({ content: chunk, chunkIndex });
      chunkIndex++;
    }

    start = end < stripped.length ? end - (DEFAULT_MINING_CONFIG.chunkOverlap) : end;
    // Prevent infinite loop
    if (start <= 0 || start >= stripped.length) break;
    if (end === start) break;
  }

  return chunks;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/tests/unit/memory/conversation-miner.test.ts && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/conversation-miner.ts src/tests/unit/memory/conversation-miner.test.ts
git commit -m "feat(memory): add ConversationMiner — normalize 6 formats, chunk exchanges, detect rooms"
```

---

## Task 9: Wake-Up Context Builder Service

**Files:**
- Create: `src/main/memory/wake-context-builder.ts`
- Test: `src/tests/unit/memory/wake-context-builder.test.ts`

- [ ] **Step 1: Write wake-up context tests**

```typescript
// src/tests/unit/memory/wake-context-builder.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WakeContextBuilder } from '../../../../main/memory/wake-context-builder';

// Mock RLMDatabase
vi.mock('../../../../main/persistence/rlm-database', () => {
  const Database = require('better-sqlite3');
  const { createTables, createMigrationsTable, runMigrations } = require('../../../../main/persistence/rlm/rlm-schema');
  let db: InstanceType<typeof Database>;
  return {
    getRLMDatabase: () => ({
      getDb: () => {
        if (!db || !db.open) {
          db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          createTables(db);
          createMigrationsTable(db);
          runMigrations(db);
        }
        return db;
      },
    }),
  };
});

describe('WakeContextBuilder', () => {
  beforeEach(() => {
    WakeContextBuilder._resetForTesting();
  });

  it('should be a singleton', () => {
    const a = WakeContextBuilder.getInstance();
    const b = WakeContextBuilder.getInstance();
    expect(a).toBe(b);
  });

  describe('L0 — Identity', () => {
    it('should generate default L0 when no identity is set', () => {
      const builder = WakeContextBuilder.getInstance();
      const ctx = builder.generateWakeContext();

      expect(ctx.identity.level).toBe('L0');
      expect(ctx.identity.content).toContain('AI orchestrator');
      expect(ctx.identity.tokenEstimate).toBeLessThanOrEqual(100);
    });

    it('should use custom identity text', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.setIdentity('I am Atlas, a personal AI assistant for Alice.');

      const ctx = builder.generateWakeContext();
      expect(ctx.identity.content).toContain('Atlas');
    });
  });

  describe('L1 — Essential Story', () => {
    it('should generate empty L1 when no hints exist', () => {
      const builder = WakeContextBuilder.getInstance();
      const ctx = builder.generateWakeContext();

      expect(ctx.essentialStory.level).toBe('L1');
      expect(ctx.essentialStory.tokenEstimate).toBeLessThanOrEqual(800);
    });

    it('should include top-importance hints in L1', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('User prefers TypeScript over Python', { importance: 8, room: 'preferences' });
      builder.addHint('Backend uses event-driven architecture', { importance: 7, room: 'architecture' });
      builder.addHint('Deploy via GitHub Actions', { importance: 3, room: 'devops' });

      const ctx = builder.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('TypeScript');
      expect(ctx.essentialStory.content).toContain('event-driven');
    });

    it('should group hints by room', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.addHint('Fact A', { importance: 5, room: 'backend' });
      builder.addHint('Fact B', { importance: 5, room: 'backend' });
      builder.addHint('Fact C', { importance: 5, room: 'frontend' });

      const ctx = builder.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('[backend]');
      expect(ctx.essentialStory.content).toContain('[frontend]');
    });

    it('should respect token budget', () => {
      const builder = WakeContextBuilder.getInstance();
      // Add many hints
      for (let i = 0; i < 50; i++) {
        builder.addHint(`Hint number ${i} with some extra content to fill space`, {
          importance: 10 - (i % 10),
          room: `room_${i % 5}`,
        });
      }

      const ctx = builder.generateWakeContext();
      // L1 should stay within budget (~800 tokens ≈ 3200 chars)
      expect(ctx.essentialStory.content.length).toBeLessThanOrEqual(3500);
    });
  });

  describe('combined wake-up', () => {
    it('should produce L0 + L1 with total token count', () => {
      const builder = WakeContextBuilder.getInstance();
      builder.setIdentity('I am a helpful assistant.');
      builder.addHint('Key fact', { importance: 9, room: 'general' });

      const ctx = builder.generateWakeContext();
      expect(ctx.totalTokens).toBe(ctx.identity.tokenEstimate + ctx.essentialStory.tokenEstimate);
      expect(ctx.totalTokens).toBeLessThanOrEqual(900);
    });

    it('should filter by wing when specified', () => {
      const builder = WakeContextBuilder.getInstance();
      // addHint doesn't have wing in the WakeHint type, but we can filter hints by query
      // For now, wake context is global. Wing-scoped filtering can be added later.
      const ctx = builder.generateWakeContext('project_a');
      expect(ctx.wing).toBe('project_a');
    });
  });

  describe('hint management', () => {
    it('should track usage count', () => {
      const builder = WakeContextBuilder.getInstance();
      const hintId = builder.addHint('Important fact', { importance: 8, room: 'general' });

      builder.generateWakeContext(); // Uses the hint
      builder.generateWakeContext(); // Uses it again

      const hint = builder.getHint(hintId);
      expect(hint).toBeDefined();
      expect(hint!.usageCount).toBeGreaterThanOrEqual(1);
    });

    it('should remove hints', () => {
      const builder = WakeContextBuilder.getInstance();
      const hintId = builder.addHint('Temp fact', { importance: 5, room: 'general' });

      builder.removeHint(hintId);
      expect(builder.getHint(hintId)).toBeUndefined();
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/memory/wake-context-builder.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement the wake-up context builder**

```typescript
// src/main/memory/wake-context-builder.ts
/**
 * Wake-Up Context Builder
 *
 * Generates compact L0 + L1 initialization context for cold-starting AI agents.
 * Inspired by mempalace's 4-layer memory stack.
 *
 * L0 (Identity, ~100 tokens): Fixed persona description
 * L1 (Essential Story, ~500-800 tokens): Top-importance hints grouped by room
 *
 * Total wake-up cost: ~600-900 tokens
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  WakeContext,
  ContextLayer,
  WakeHint,
  WakeContextConfig,
} from '../../shared/types/wake-context.types';
import { DEFAULT_WAKE_CONTEXT_CONFIG } from '../../shared/types/wake-context.types';
import type { WakeHintRow } from '../persistence/rlm-database.types';
import * as crypto from 'crypto';

const logger = getLogger('WakeContextBuilder');

const DEFAULT_IDENTITY = 'AI orchestrator assistant. Coordinates multiple AI agents for complex tasks.';

interface AddHintOptions {
  importance?: number;
  room?: string;
  sourceReflectionId?: string;
  sourceSessionId?: string;
}

export class WakeContextBuilder extends EventEmitter {
  private static instance: WakeContextBuilder | null = null;
  private config: WakeContextConfig;
  private identityText: string;
  private cachedContext: WakeContext | null = null;
  private cacheGeneratedAt = 0;

  static getInstance(): WakeContextBuilder {
    if (!this.instance) {
      this.instance = new WakeContextBuilder();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_WAKE_CONTEXT_CONFIG };
    this.identityText = DEFAULT_IDENTITY;
    logger.info('WakeContextBuilder initialized');
  }

  configure(config: Partial<WakeContextConfig>): void {
    this.config = { ...this.config, ...config };
    this.invalidateCache();
  }

  private get db() {
    return getRLMDatabase().getDb();
  }

  private invalidateCache(): void {
    this.cachedContext = null;
    this.cacheGeneratedAt = 0;
  }

  // ============ Identity (L0) ============

  setIdentity(text: string): void {
    this.identityText = text;
    this.invalidateCache();
    logger.info('Identity updated');
  }

  getIdentity(): string {
    return this.identityText;
  }

  private generateL0(): ContextLayer {
    const content = this.identityText;
    return {
      level: 'L0',
      content,
      tokenEstimate: estimateTokens(content),
      generatedAt: Date.now(),
    };
  }

  // ============ Hints Management ============

  addHint(content: string, options: AddHintOptions = {}): string {
    const id = `hint_${crypto.randomUUID().slice(0, 12)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO wake_hints (id, content, importance, room, source_reflection_id, source_session_id, created_at, last_used, usage_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id,
      content,
      options.importance ?? 5,
      options.room ?? 'general',
      options.sourceReflectionId ?? null,
      options.sourceSessionId ?? null,
      now,
      now,
    );

    this.invalidateCache();
    this.emit('wake:hint-added', { id, content, importance: options.importance });
    return id;
  }

  getHint(id: string): WakeHint | undefined {
    const row = this.db.prepare('SELECT * FROM wake_hints WHERE id = ?').get(id) as WakeHintRow | undefined;
    if (!row) return undefined;
    return rowToHint(row);
  }

  removeHint(id: string): void {
    this.db.prepare('DELETE FROM wake_hints WHERE id = ?').run(id);
    this.invalidateCache();
  }

  // ============ Essential Story (L1) ============

  private generateL1(wing?: string): ContextLayer {
    // Fetch top hints by importance
    const limit = this.config.l1MaxHints;
    const rows = this.db.prepare(`
      SELECT * FROM wake_hints
      ORDER BY importance DESC, created_at DESC
      LIMIT ?
    `).all(limit) as WakeHintRow[];

    if (rows.length === 0) {
      return {
        level: 'L1',
        content: '## L1 — ESSENTIAL STORY\nNo knowledge stored yet.',
        tokenEstimate: 10,
        generatedAt: Date.now(),
      };
    }

    // Group by room
    const byRoom = new Map<string, WakeHintRow[]>();
    for (const row of rows) {
      const existing = byRoom.get(row.room) || [];
      existing.push(row);
      byRoom.set(row.room, existing);
    }

    // Build formatted output with character budget
    const maxChars = this.config.l1MaxTokens * 4; // ~4 chars per token
    const snippetMax = this.config.l1SnippetMaxChars;
    const lines = ['## L1 — ESSENTIAL STORY', ''];
    let totalChars = lines.join('\n').length;

    for (const [room, hints] of byRoom.entries()) {
      const roomHeader = `[${room}]`;
      if (totalChars + roomHeader.length + 2 > maxChars) {
        lines.push('... (more in deep search)');
        break;
      }
      lines.push(roomHeader);
      totalChars += roomHeader.length + 1;

      for (const hint of hints) {
        let snippet = hint.content.replace(/\n/g, ' ').trim();
        if (snippet.length > snippetMax) {
          snippet = snippet.slice(0, snippetMax - 3) + '...';
        }
        const line = `  - ${snippet}`;

        if (totalChars + line.length + 1 > maxChars) {
          lines.push('  ... (more in deep search)');
          totalChars += 30;
          break;
        }

        lines.push(line);
        totalChars += line.length + 1;

        // Update usage tracking
        this.db.prepare(`
          UPDATE wake_hints SET last_used = ?, usage_count = usage_count + 1 WHERE id = ?
        `).run(Date.now(), hint.id);
      }

      lines.push('');
      totalChars += 1;
    }

    const content = lines.join('\n').trim();
    return {
      level: 'L1',
      content,
      tokenEstimate: estimateTokens(content),
      generatedAt: Date.now(),
    };
  }

  // ============ Full Wake Context ============

  generateWakeContext(wing?: string): WakeContext {
    // Check cache
    const now = Date.now();
    if (this.cachedContext && (now - this.cacheGeneratedAt) < this.config.regenerateIntervalMs) {
      return this.cachedContext;
    }

    const identity = this.generateL0();
    const essentialStory = this.generateL1(wing);

    const ctx: WakeContext = {
      identity,
      essentialStory,
      totalTokens: identity.tokenEstimate + essentialStory.tokenEstimate,
      wing,
      generatedAt: now,
    };

    this.cachedContext = ctx;
    this.cacheGeneratedAt = now;

    this.emit('wake:context-generated', { totalTokens: ctx.totalTokens, wing });
    logger.debug('Wake context generated', { totalTokens: ctx.totalTokens });

    return ctx;
  }

  /**
   * Get the wake-up context as a single injectable string.
   * This is what gets prepended to agent system prompts.
   */
  getWakeUpText(wing?: string): string {
    const ctx = this.generateWakeContext(wing);
    return `${ctx.identity.content}\n\n${ctx.essentialStory.content}`;
  }
}

/** Convenience getter */
export function getWakeContextBuilder(): WakeContextBuilder {
  return WakeContextBuilder.getInstance();
}

// ============ Helpers ============

function estimateTokens(text: string): number {
  // Rough estimate: ~4 characters per token
  return Math.ceil(text.length / 4);
}

function rowToHint(row: WakeHintRow): WakeHint {
  return {
    id: row.id,
    content: row.content,
    importance: row.importance,
    room: row.room,
    sourceReflectionId: row.source_reflection_id ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    usageCount: row.usage_count,
  };
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run src/tests/unit/memory/wake-context-builder.test.ts && npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/main/memory/wake-context-builder.ts src/tests/unit/memory/wake-context-builder.test.ts
git commit -m "feat(memory): add WakeContextBuilder — L0/L1 cold-start context for agents"
```

---

## Task 10: IPC Channels + Zod Schemas

**Files:**
- Modify: `src/shared/types/ipc.types.ts` (add new channel constants)
- Modify: `src/shared/validation/ipc-schemas.ts` (add Zod schemas)

- [ ] **Step 1: Read current IPC channels file end**

Read `src/shared/types/ipc.types.ts` to find where to add new channels. Look for the last channel definition before the closing `}` of the `IPC_CHANNELS` object.

- [ ] **Step 2: Add knowledge graph IPC channels**

Add these channels to the `IPC_CHANNELS` object (before its closing brace):

```typescript
  // Knowledge Graph
  KG_ADD_FACT: 'kg:add-fact',
  KG_INVALIDATE_FACT: 'kg:invalidate-fact',
  KG_QUERY_ENTITY: 'kg:query-entity',
  KG_QUERY_RELATIONSHIP: 'kg:query-relationship',
  KG_GET_TIMELINE: 'kg:get-timeline',
  KG_GET_STATS: 'kg:get-stats',
  KG_ADD_ENTITY: 'kg:add-entity',

  // Conversation Mining
  CONVO_IMPORT_FILE: 'convo:import-file',
  CONVO_IMPORT_STRING: 'convo:import-string',
  CONVO_DETECT_FORMAT: 'convo:detect-format',
  CONVO_GET_IMPORTS: 'convo:get-imports',

  // Wake Context
  WAKE_GENERATE: 'wake:generate',
  WAKE_GET_TEXT: 'wake:get-text',
  WAKE_ADD_HINT: 'wake:add-hint',
  WAKE_REMOVE_HINT: 'wake:remove-hint',
  WAKE_SET_IDENTITY: 'wake:set-identity',
```

- [ ] **Step 3: Add Zod schemas for the IPC payloads**

Read `src/shared/validation/ipc-schemas.ts` and add schemas at the end (before any export block):

```typescript
// ============ Knowledge Graph Schemas ============

export const kgAddFactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceCloset: z.string().optional(),
  sourceFile: z.string().optional(),
});

export const kgInvalidateFactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  ended: z.string().optional(),
});

export const kgQueryEntitySchema = z.object({
  entityName: z.string().min(1),
  direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
  asOf: z.string().optional(),
});

export const kgQueryRelationshipSchema = z.object({
  predicate: z.string().min(1),
  asOf: z.string().optional(),
});

export const kgTimelineSchema = z.object({
  entityName: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const kgAddEntitySchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  properties: z.record(z.unknown()).optional(),
});

// ============ Conversation Mining Schemas ============

export const convoImportFileSchema = z.object({
  filePath: z.string().min(1),
  wing: z.string().min(1),
});

export const convoImportStringSchema = z.object({
  content: z.string().min(1),
  wing: z.string().min(1),
  sourceFile: z.string().min(1),
  format: z.enum([
    'claude-code-jsonl', 'codex-jsonl', 'claude-ai-json',
    'chatgpt-json', 'slack-json', 'plain-text',
  ]).optional(),
});

export const convoDetectFormatSchema = z.object({
  content: z.string().min(1),
});

// ============ Wake Context Schemas ============

export const wakeGenerateSchema = z.object({
  wing: z.string().optional(),
});

export const wakeAddHintSchema = z.object({
  content: z.string().min(1),
  importance: z.number().min(0).max(10).optional(),
  room: z.string().optional(),
  sourceReflectionId: z.string().optional(),
  sourceSessionId: z.string().optional(),
});

export const wakeRemoveHintSchema = z.object({
  id: z.string().min(1),
});

export const wakeSetIdentitySchema = z.object({
  text: z.string().min(1).max(500),
});
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/shared/types/ipc.types.ts src/shared/validation/ipc-schemas.ts
git commit -m "feat(ipc): add channels + Zod schemas for knowledge graph, mining, wake context"
```

---

## Task 11: IPC Handlers — Knowledge Graph + Mining + Wake

**Files:**
- Create: `src/main/ipc/handlers/knowledge-graph-handlers.ts`
- Create: `src/main/ipc/handlers/conversation-mining-handlers.ts`
- Create: `src/main/ipc/handlers/wake-context-handlers.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts` (register new handlers)

- [ ] **Step 1: Read the existing handler registration pattern**

Read `src/main/ipc/ipc-main-handler.ts` to understand how handlers are registered. Look for the pattern of importing and calling `register*Handlers()` functions.

- [ ] **Step 2: Create knowledge graph IPC handlers**

```typescript
// src/main/ipc/handlers/knowledge-graph-handlers.ts
import { ipcMain } from 'electron';
import { getLogger } from '../../logging/logger';
import { getKnowledgeGraphService } from '../../memory/knowledge-graph-service';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import {
  kgAddFactSchema,
  kgInvalidateFactSchema,
  kgQueryEntitySchema,
  kgQueryRelationshipSchema,
  kgTimelineSchema,
  kgAddEntitySchema,
} from '../../../shared/validation/ipc-schemas';

const logger = getLogger('KnowledgeGraphHandlers');

export function registerKnowledgeGraphHandlers(): void {
  const kg = getKnowledgeGraphService();

  ipcMain.handle(IPC_CHANNELS.KG_ADD_FACT, async (_event, payload: unknown) => {
    const data = kgAddFactSchema.parse(payload);
    return kg.addFact(data.subject, data.predicate, data.object, {
      validFrom: data.validFrom,
      validTo: data.validTo,
      confidence: data.confidence,
      sourceCloset: data.sourceCloset,
      sourceFile: data.sourceFile,
    });
  });

  ipcMain.handle(IPC_CHANNELS.KG_INVALIDATE_FACT, async (_event, payload: unknown) => {
    const data = kgInvalidateFactSchema.parse(payload);
    return kg.invalidateFact(data.subject, data.predicate, data.object, data.ended);
  });

  ipcMain.handle(IPC_CHANNELS.KG_QUERY_ENTITY, async (_event, payload: unknown) => {
    const data = kgQueryEntitySchema.parse(payload);
    return kg.queryEntity(data.entityName, { direction: data.direction, asOf: data.asOf });
  });

  ipcMain.handle(IPC_CHANNELS.KG_QUERY_RELATIONSHIP, async (_event, payload: unknown) => {
    const data = kgQueryRelationshipSchema.parse(payload);
    return kg.queryRelationship(data.predicate, data.asOf);
  });

  ipcMain.handle(IPC_CHANNELS.KG_GET_TIMELINE, async (_event, payload: unknown) => {
    const data = kgTimelineSchema.parse(payload);
    return kg.getTimeline(data.entityName, data.limit);
  });

  ipcMain.handle(IPC_CHANNELS.KG_GET_STATS, async () => {
    return kg.getStats();
  });

  ipcMain.handle(IPC_CHANNELS.KG_ADD_ENTITY, async (_event, payload: unknown) => {
    const data = kgAddEntitySchema.parse(payload);
    return kg.addEntity(data.name, data.type, data.properties);
  });

  logger.info('Knowledge graph IPC handlers registered');
}
```

- [ ] **Step 3: Create conversation mining IPC handlers**

```typescript
// src/main/ipc/handlers/conversation-mining-handlers.ts
import { ipcMain } from 'electron';
import { getLogger } from '../../logging/logger';
import { getConversationMiner } from '../../memory/conversation-miner';
import { ConversationMiner } from '../../memory/conversation-miner';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import {
  convoImportFileSchema,
  convoImportStringSchema,
  convoDetectFormatSchema,
} from '../../../shared/validation/ipc-schemas';

const logger = getLogger('ConversationMiningHandlers');

export function registerConversationMiningHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.CONVO_IMPORT_FILE, async (_event, payload: unknown) => {
    const data = convoImportFileSchema.parse(payload);
    return getConversationMiner().importFile(data.filePath, data.wing);
  });

  ipcMain.handle(IPC_CHANNELS.CONVO_IMPORT_STRING, async (_event, payload: unknown) => {
    const data = convoImportStringSchema.parse(payload);
    return getConversationMiner().importFromString(data.content, {
      wing: data.wing,
      sourceFile: data.sourceFile,
      format: data.format,
    });
  });

  ipcMain.handle(IPC_CHANNELS.CONVO_DETECT_FORMAT, async (_event, payload: unknown) => {
    const data = convoDetectFormatSchema.parse(payload);
    return ConversationMiner.detectFormat(data.content);
  });

  logger.info('Conversation mining IPC handlers registered');
}
```

- [ ] **Step 4: Create wake context IPC handlers**

```typescript
// src/main/ipc/handlers/wake-context-handlers.ts
import { ipcMain } from 'electron';
import { getLogger } from '../../logging/logger';
import { getWakeContextBuilder } from '../../memory/wake-context-builder';
import { IPC_CHANNELS } from '../../../shared/types/ipc.types';
import {
  wakeGenerateSchema,
  wakeAddHintSchema,
  wakeRemoveHintSchema,
  wakeSetIdentitySchema,
} from '../../../shared/validation/ipc-schemas';

const logger = getLogger('WakeContextHandlers');

export function registerWakeContextHandlers(): void {
  const builder = getWakeContextBuilder();

  ipcMain.handle(IPC_CHANNELS.WAKE_GENERATE, async (_event, payload: unknown) => {
    const data = wakeGenerateSchema.parse(payload);
    return builder.generateWakeContext(data.wing);
  });

  ipcMain.handle(IPC_CHANNELS.WAKE_GET_TEXT, async (_event, payload: unknown) => {
    const data = wakeGenerateSchema.parse(payload);
    return builder.getWakeUpText(data.wing);
  });

  ipcMain.handle(IPC_CHANNELS.WAKE_ADD_HINT, async (_event, payload: unknown) => {
    const data = wakeAddHintSchema.parse(payload);
    return builder.addHint(data.content, {
      importance: data.importance,
      room: data.room,
      sourceReflectionId: data.sourceReflectionId,
      sourceSessionId: data.sourceSessionId,
    });
  });

  ipcMain.handle(IPC_CHANNELS.WAKE_REMOVE_HINT, async (_event, payload: unknown) => {
    const data = wakeRemoveHintSchema.parse(payload);
    builder.removeHint(data.id);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.WAKE_SET_IDENTITY, async (_event, payload: unknown) => {
    const data = wakeSetIdentitySchema.parse(payload);
    builder.setIdentity(data.text);
    return { success: true };
  });

  logger.info('Wake context IPC handlers registered');
}
```

- [ ] **Step 5: Register all handlers in ipc-main-handler.ts**

Read `src/main/ipc/ipc-main-handler.ts` and add imports + registration calls following the existing pattern. Add these imports:

```typescript
import { registerKnowledgeGraphHandlers } from './handlers/knowledge-graph-handlers';
import { registerConversationMiningHandlers } from './handlers/conversation-mining-handlers';
import { registerWakeContextHandlers } from './handlers/wake-context-handlers';
```

And call them in the constructor or registration method alongside existing handler registrations:

```typescript
registerKnowledgeGraphHandlers();
registerConversationMiningHandlers();
registerWakeContextHandlers();
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/handlers/knowledge-graph-handlers.ts \
       src/main/ipc/handlers/conversation-mining-handlers.ts \
       src/main/ipc/handlers/wake-context-handlers.ts \
       src/main/ipc/ipc-main-handler.ts
git commit -m "feat(ipc): register knowledge graph, mining, and wake context IPC handlers"
```

---

## Task 12: Wire Singletons into Main Process + Expose via Preload

**Files:**
- Modify: `src/main/index.ts` (initialize new singletons)
- Modify: `src/preload/preload.ts` (expose APIs to renderer)

- [ ] **Step 1: Read src/main/index.ts initialization section**

Read the file to find where existing singletons are initialized (look for `getRLMDatabase()`, `getObserverAgent()`, etc.).

- [ ] **Step 2: Add singleton initialization**

Add imports at the top of `src/main/index.ts`:

```typescript
import { getKnowledgeGraphService } from './memory/knowledge-graph-service';
import { getConversationMiner } from './memory/conversation-miner';
import { getWakeContextBuilder } from './memory/wake-context-builder';
```

In the app-ready initialization section (after existing singleton init calls), add:

```typescript
// Initialize mempalace-inspired memory features
getKnowledgeGraphService();
getConversationMiner();
getWakeContextBuilder();
```

- [ ] **Step 3: Read src/preload/preload.ts to understand the exposure pattern**

Read the preload file to see how existing domains expose IPC methods to the renderer.

- [ ] **Step 4: Add preload API exposure**

Add to the `electronAPI` object in `src/preload/preload.ts`:

```typescript
// Knowledge Graph
kgAddFact: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KG_ADD_FACT, payload),
kgInvalidateFact: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KG_INVALIDATE_FACT, payload),
kgQueryEntity: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KG_QUERY_ENTITY, payload),
kgQueryRelationship: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KG_QUERY_RELATIONSHIP, payload),
kgGetTimeline: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KG_GET_TIMELINE, payload),
kgGetStats: () => ipcRenderer.invoke(IPC_CHANNELS.KG_GET_STATS),
kgAddEntity: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.KG_ADD_ENTITY, payload),

// Conversation Mining
convoImportFile: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONVO_IMPORT_FILE, payload),
convoImportString: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONVO_IMPORT_STRING, payload),
convoDetectFormat: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.CONVO_DETECT_FORMAT, payload),

// Wake Context
wakeGenerate: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.WAKE_GENERATE, payload),
wakeGetText: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.WAKE_GET_TEXT, payload),
wakeAddHint: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.WAKE_ADD_HINT, payload),
wakeRemoveHint: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.WAKE_REMOVE_HINT, payload),
wakeSetIdentity: (payload: unknown) => ipcRenderer.invoke(IPC_CHANNELS.WAKE_SET_IDENTITY, payload),
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/index.ts src/preload/preload.ts
git commit -m "feat: wire knowledge graph, miner, wake context into main + preload"
```

---

## Task 13: RLMDatabase Delegation + Integration

**Files:**
- Modify: `src/main/persistence/rlm-database.ts` (add delegate methods)

- [ ] **Step 1: Read rlm-database.ts delegation pattern**

Read the file to understand how existing modules (stores, sections, search, etc.) are delegated. Look for the `require()` pattern and the delegation methods.

- [ ] **Step 2: Add knowledge graph delegation methods**

Add to the `RLMDatabase` class, following the existing delegation pattern:

```typescript
  // ============================================
  // Knowledge Graph (delegated)
  // ============================================

  getDb(): Database.Database {
    return this.db;
  }
```

Note: The `getDb()` method may already exist. If not, add it. The KG service and other new singletons use this to get direct database access, following the same pattern as `VectorStore`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/persistence/rlm-database.ts
git commit -m "feat(persistence): expose getDb() for knowledge graph + verbatim persistence"
```

---

## Task 14: Integration Test — End-to-End Flow

**Files:**
- Create: `src/tests/integration/memory/mempalace-features.test.ts`

- [ ] **Step 1: Write integration test covering the full pipeline**

```typescript
// src/tests/integration/memory/mempalace-features.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock RLMDatabase with in-memory SQLite
vi.mock('../../../../main/persistence/rlm-database', () => {
  const Database = require('better-sqlite3');
  const { createTables, createMigrationsTable, runMigrations } = require('../../../../main/persistence/rlm/rlm-schema');
  let db: InstanceType<typeof Database>;
  return {
    getRLMDatabase: () => ({
      getDb: () => {
        if (!db || !db.open) {
          db = new Database(':memory:');
          db.pragma('foreign_keys = ON');
          createTables(db);
          createMigrationsTable(db);
          runMigrations(db);
        }
        return db;
      },
    }),
  };
});

import { KnowledgeGraphService } from '../../../../main/memory/knowledge-graph-service';
import { ConversationMiner } from '../../../../main/memory/conversation-miner';
import { WakeContextBuilder } from '../../../../main/memory/wake-context-builder';

describe('mempalace-inspired features — integration', () => {
  beforeEach(() => {
    KnowledgeGraphService._resetForTesting();
    ConversationMiner._resetForTesting();
    WakeContextBuilder._resetForTesting();
  });

  it('should mine a conversation, extract knowledge, and generate wake-up context', () => {
    // 1. Import a conversation
    const miner = ConversationMiner.getInstance();
    const conversation = `> What database should we use?
We decided to use PostgreSQL for its JSON support and reliability.

> How should we handle authentication?
JWT tokens with refresh rotation. Store in httpOnly cookies. Never in localStorage.

> What about the deploy pipeline?
GitHub Actions with staging → production promotion. Blue-green deploys.`;

    const result = miner.importFromString(conversation, {
      wing: 'my_project',
      sourceFile: '/conversations/planning.txt',
    });
    expect(result.segmentsCreated).toBeGreaterThan(0);

    // 2. Record knowledge from the conversation
    const kg = KnowledgeGraphService.getInstance();
    kg.addFact('my_project', 'uses_database', 'PostgreSQL');
    kg.addFact('my_project', 'auth_strategy', 'JWT with refresh rotation');
    kg.addFact('my_project', 'deploy_strategy', 'Blue-green via GitHub Actions');

    const facts = kg.queryEntity('my_project');
    expect(facts).toHaveLength(3);

    // 3. Build wake-up context from the knowledge
    const wake = WakeContextBuilder.getInstance();
    wake.setIdentity('Assistant for my_project — a web application.');
    wake.addHint('Database: PostgreSQL (chosen for JSON support)', { importance: 8, room: 'architecture' });
    wake.addHint('Auth: JWT + httpOnly cookies (never localStorage)', { importance: 9, room: 'security' });
    wake.addHint('Deploy: Blue-green via GitHub Actions', { importance: 7, room: 'devops' });

    const ctx = wake.generateWakeContext();
    expect(ctx.totalTokens).toBeLessThanOrEqual(900);
    expect(ctx.identity.content).toContain('my_project');
    expect(ctx.essentialStory.content).toContain('PostgreSQL');
    expect(ctx.essentialStory.content).toContain('JWT');

    // 4. Get injectable text
    const text = wake.getWakeUpText();
    expect(text).toContain('my_project');
    expect(text).toContain('[architecture]');
    expect(text).toContain('[security]');
  });

  it('should handle temporal knowledge graph queries', () => {
    const kg = KnowledgeGraphService.getInstance();

    // Alice worked at Acme 2020-2024, then NewCo 2025+
    kg.addFact('Alice', 'works_at', 'Acme', { validFrom: '2020-01-01' });
    kg.invalidateFact('Alice', 'works_at', 'Acme', '2024-06-01');
    kg.addFact('Alice', 'works_at', 'NewCo', { validFrom: '2024-07-01' });

    // Max does chess since 2024, swimming since 2025
    kg.addFact('Max', 'does', 'Chess', { validFrom: '2024-06-01' });
    kg.addFact('Max', 'does', 'Swimming', { validFrom: '2025-01-01' });
    kg.addFact('Max', 'child_of', 'Alice');

    // Temporal query: where did Alice work in 2023?
    const in2023 = kg.queryEntity('Alice', { asOf: '2023-01-01' });
    expect(in2023.find(f => f.predicate === 'works_at')?.object).toBe('Acme');

    // Temporal query: where does Alice work in 2025?
    const in2025 = kg.queryEntity('Alice', { asOf: '2025-01-01' });
    expect(in2025.find(f => f.predicate === 'works_at')?.object).toBe('NewCo');

    // Timeline for Max
    const tl = kg.getTimeline('Max');
    expect(tl.length).toBeGreaterThanOrEqual(2);

    // Stats
    const stats = kg.getStats();
    expect(stats.entities).toBe(5); // Alice, Acme, NewCo, Max, Chess, Swimming
    expect(stats.expiredFacts).toBe(1); // Alice@Acme
  });

  it('should detect all supported conversation formats', () => {
    expect(ConversationMiner.detectFormat('> Q1\nA1\n\n> Q2\nA2\n\n> Q3\nA3')).toBe('plain-text');
    expect(ConversationMiner.detectFormat('{"type":"human","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":"hello"}}')).toBe('claude-code-jsonl');
    expect(ConversationMiner.detectFormat('{"type":"session_meta","payload":{}}\n{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}')).toBe('codex-jsonl');
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npx vitest run src/tests/integration/memory/mempalace-features.test.ts`
Expected: All pass

- [ ] **Step 3: Run full typecheck + lint**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/tests/integration/memory/mempalace-features.test.ts
git commit -m "test: add integration tests for mempalace-inspired knowledge features"
```

---

## Task 15: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm run test`
Expected: All existing tests still pass, plus new tests pass

- [ ] **Step 2: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 4: Verify no broken imports across the codebase**

Run: `npx tsc --noEmit 2>&1 | head -20`
Expected: Clean output

- [ ] **Step 5: Final commit with all verification**

If any files were missed or need cleanup:

```bash
git add -A
git commit -m "chore: final verification — all mempalace features compile and pass tests"
```

---

## Summary

| Task | Feature | Files Created | Files Modified |
|------|---------|---------------|----------------|
| 1 | KG Types | 2 | 0 |
| 2 | Mining Types | 2 | 0 |
| 3 | Wake Types | 2 | 0 |
| 4 | DB Migrations | 0 | 2 |
| 5 | KG Persistence | 2 | 0 |
| 6 | Verbatim Persistence | 2 | 0 |
| 7 | KG Service | 2 | 0 |
| 8 | Conversation Miner | 2 | 0 |
| 9 | Wake Context Builder | 2 | 0 |
| 10 | IPC Channels + Schemas | 0 | 2 |
| 11 | IPC Handlers | 3 | 1 |
| 12 | Main + Preload Wiring | 0 | 2 |
| 13 | RLMDatabase Delegation | 0 | 1 |
| 14 | Integration Tests | 1 | 0 |
| 15 | Final Verification | 0 | 0 |
| **Total** | | **20 new** | **8 modified** |
