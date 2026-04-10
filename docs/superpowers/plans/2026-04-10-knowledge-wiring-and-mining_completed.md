# Knowledge Wiring, Auto-Mining & Codebase Intelligence Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the mempalace knowledge features (KG, ConversationMiner, WakeContextBuilder) into the live system so they automatically mine sessions, inject wake context into agents, extract facts from the observation pipeline, mine codebase config files, and forward events to the renderer.

**Architecture:** Six integration layers: (1) Fix contracts channel alignment to prevent generated code breakage, (2) inject wake-up text into instance system prompts, (3) auto-mine transcripts on session end/hibernate, (4) bridge the observation pipeline into KG facts and wake hints, (5) mine codebase config files on instance creation, (6) forward events to the renderer. A new `CodebaseMiner` service handles file mining. A `KnowledgeBridge` module wires observation events → KG/wake.

**Tech Stack:** TypeScript, better-sqlite3, EventEmitter, chokidar (already installed), node:fs/promises

---

## File Structure

### New files
| File | Responsibility |
|------|---------------|
| `src/main/memory/knowledge-bridge.ts` | Listens to observation pipeline events, extracts KG facts + wake hints |
| `src/main/memory/codebase-miner.ts` | Reads known config files from workingDirectory, extracts facts + hints |
| `src/tests/unit/memory/knowledge-bridge.test.ts` | Tests for KnowledgeBridge |
| `src/tests/unit/memory/codebase-miner.test.ts` | Tests for CodebaseMiner |

### Modified files
| File | What changes |
|------|-------------|
| `packages/contracts/src/channels/memory.channels.ts` | Add 15 KG/mining/wake channels + 5 event channels |
| `src/shared/types/ipc.types.ts` | Add 5 event-forwarding channels |
| `src/shared/validation/ipc-schemas.ts` | Add codebase mining schemas |
| `src/preload/generated/channels.ts` | Regenerated via `npm run generate:ipc` |
| `src/preload/domains/memory.preload.ts` | Add codebase mining bridge methods |
| `src/main/ipc/ipc-main-handler.ts` | Add `setupKnowledgeEventForwarding()` |
| `src/main/instance/instance-lifecycle.ts` | Inject wake context + mine on terminate/hibernate |
| `src/main/index.ts` | Initialize KnowledgeBridge + CodebaseMiner, wire events |

---

## Task 1: Fix Contracts Channel Alignment

The 15 new channels (KG, CONVO, WAKE) were added to the legacy `ipc.types.ts` and hand-edited into the generated `preload/generated/channels.ts`, but they're missing from the contracts source of truth. The next `npm run generate:ipc` will **destroy** them.

**Files:**
- Modify: `packages/contracts/src/channels/memory.channels.ts`
- Regenerate: `src/preload/generated/channels.ts` (via script)

- [ ] **Step 1: Read the contracts memory channels file**

Read `packages/contracts/src/channels/memory.channels.ts` to see the current end of the `MEMORY_CHANNELS` object.

- [ ] **Step 2: Add knowledge graph, mining, wake, and event channels**

Add these channels before the `} as const;` closing brace of `MEMORY_CHANNELS` in `packages/contracts/src/channels/memory.channels.ts`:

```typescript
  // Knowledge Graph operations
  KG_ADD_FACT: 'kg:add-fact',
  KG_INVALIDATE_FACT: 'kg:invalidate-fact',
  KG_QUERY_ENTITY: 'kg:query-entity',
  KG_QUERY_RELATIONSHIP: 'kg:query-relationship',
  KG_GET_TIMELINE: 'kg:get-timeline',
  KG_GET_STATS: 'kg:get-stats',
  KG_ADD_ENTITY: 'kg:add-entity',

  // Conversation Mining operations
  CONVO_IMPORT_FILE: 'convo:import-file',
  CONVO_IMPORT_STRING: 'convo:import-string',
  CONVO_DETECT_FORMAT: 'convo:detect-format',

  // Wake Context operations
  WAKE_GENERATE: 'wake:generate',
  WAKE_GET_TEXT: 'wake:get-text',
  WAKE_ADD_HINT: 'wake:add-hint',
  WAKE_REMOVE_HINT: 'wake:remove-hint',
  WAKE_SET_IDENTITY: 'wake:set-identity',

  // Codebase Mining operations
  CODEBASE_MINE_DIRECTORY: 'codebase:mine-directory',
  CODEBASE_GET_STATUS: 'codebase:get-status',

  // Knowledge event forwarding (main -> renderer)
  KG_EVENT_FACT_ADDED: 'kg:event:fact-added',
  KG_EVENT_FACT_INVALIDATED: 'kg:event:fact-invalidated',
  CONVO_EVENT_IMPORT_COMPLETE: 'convo:event:import-complete',
  WAKE_EVENT_HINT_ADDED: 'wake:event:hint-added',
  WAKE_EVENT_CONTEXT_GENERATED: 'wake:event:context-generated',
```

- [ ] **Step 3: Add the same 5 event channels to the legacy ipc.types.ts**

In `src/shared/types/ipc.types.ts`, add these channels alongside the existing KG/CONVO/WAKE channels (before `} as const;`):

```typescript
  // Codebase Mining
  CODEBASE_MINE_DIRECTORY: 'codebase:mine-directory',
  CODEBASE_GET_STATUS: 'codebase:get-status',

  // Knowledge event forwarding (main -> renderer)
  KG_EVENT_FACT_ADDED: 'kg:event:fact-added',
  KG_EVENT_FACT_INVALIDATED: 'kg:event:fact-invalidated',
  CONVO_EVENT_IMPORT_COMPLETE: 'convo:event:import-complete',
  WAKE_EVENT_HINT_ADDED: 'wake:event:hint-added',
  WAKE_EVENT_CONTEXT_GENERATED: 'wake:event:context-generated',
```

- [ ] **Step 4: Regenerate the preload channels file**

Run: `npm run generate:ipc`
Expected: `src/preload/generated/channels.ts` regenerated with ALL channels including KG/CONVO/WAKE/CODEBASE/events.

- [ ] **Step 5: Verify channel sync**

Run: `npm run verify:ipc`
Expected: No mismatches.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/channels/memory.channels.ts \
       src/shared/types/ipc.types.ts \
       src/preload/generated/channels.ts
git commit -m "fix(channels): add KG/mining/wake/codebase channels to contracts source of truth"
```

---

## Task 2: Inject Wake Context Into Instance System Prompts

Currently `getWakeUpText()` is never called — agents get no wake-up context.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Read the system prompt construction code**

Read `src/main/instance/instance-lifecycle.ts` lines 868-910 to see the current prompt assembly flow:
1. Line 876: `systemPrompt = resolvedAgent.systemPrompt || ''`
2. Lines 877-881: Instruction prompts prepended
3. Lines 884-896: Observation context injected
4. Lines 900-904: Tool permissions appended

Wake context should be injected **after observation context** (line 896) and **before tool permissions** (line 898).

- [ ] **Step 2: Add the wake context import**

At the top of `src/main/instance/instance-lifecycle.ts`, add to the existing imports:

```typescript
import { getWakeContextBuilder } from '../memory/wake-context-builder';
```

- [ ] **Step 3: Inject wake-up text into the system prompt**

In `src/main/instance/instance-lifecycle.ts`, after the observation context injection block (after the closing `}` of the catch block at line 896) and before the tool permissions block (line 898), add:

```typescript
        // Inject wake-up context (mempalace L0 identity + L1 essential story)
        if (instance.depth === 0) {
          try {
            const wakeText = getWakeContextBuilder().getWakeUpText(instance.workingDirectory);
            if (wakeText && wakeText.trim().length > 30) {
              systemPrompt = `${wakeText}\n\n---\n\n${systemPrompt}`;
              logger.info('Injected wake-up context into system prompt', {
                tokenEstimate: Math.ceil(wakeText.length / 4),
              });
            }
          } catch (err) {
            logger.warn('Failed to inject wake context', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
```

Key design decisions:
- Only inject for root instances (`depth === 0`) — child instances inherit context from their parent's task
- Minimum 30 chars to avoid injecting empty/stub context
- Uses `workingDirectory` as the wing parameter so projects get project-specific context
- Prepended (not appended) so it sits above all other instructions — identity comes first
- Wrapped in try/catch to prevent wake failures from blocking instance creation

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "feat(lifecycle): inject wake-up context (L0+L1) into agent system prompts"
```

---

## Task 3: Auto-Mine Transcripts on Session End

When an instance terminates, its output buffer should be mined into verbatim segments for future retrieval.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Read the terminate flow**

Read `src/main/instance/instance-lifecycle.ts` lines 1239-1250 to see the archive block. After history archival, we add mining.

- [ ] **Step 2: Add conversation miner import**

At the top of `src/main/instance/instance-lifecycle.ts`, add to imports:

```typescript
import { getConversationMiner } from '../memory/conversation-miner';
```

- [ ] **Step 3: Add transcript mining after history archival in terminateInstance**

In `src/main/instance/instance-lifecycle.ts`, after the history archive try/catch block (after line 1249, after the `}` closing the `if (!instance.parentId...)` block), add:

```typescript
      // Mine transcript into verbatim storage (async, non-blocking)
      if (!instance.parentId && instance.outputBuffer.length >= 4) {
        try {
          const transcript = instance.outputBuffer
            .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
            .map((msg) => msg.type === 'user' ? `> ${msg.content}` : msg.content)
            .join('\n\n');

          if (transcript.length > 100) {
            const wing = instance.workingDirectory || 'default';
            const sourceFile = `session://${instance.id}`;
            getConversationMiner().importFromString(transcript, {
              wing,
              sourceFile,
            });
            logger.info('Mined transcript into verbatim storage', {
              instanceId,
              messageCount: instance.outputBuffer.length,
            });
          }
        } catch (error) {
          logger.warn('Failed to mine transcript', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
```

Key design decisions:
- Only root instances (same guard as history archival)
- Minimum 4 messages (at least 2 exchanges) to avoid mining trivial sessions
- Minimum 100 chars of actual transcript
- Uses `session://{id}` as sourceFile — the verbatim store's `isFileImported` check prevents double-mining
- Uses `workingDirectory` as wing so project sessions are grouped
- Wrapped in try/catch — mining failure must never block termination
- Synchronous call (ConversationMiner.importFromString is sync) — runs fast, no async needed

- [ ] **Step 4: Add the same mining to hibernateInstance**

In `src/main/instance/instance-lifecycle.ts`, inside the `hibernateInstance` method, after the session state persistence block (after `await continuity.stopTracking(instanceId, true);` around line 1369) and before the adapter termination block (before `const adapter = this.deps.getAdapter(instanceId);` around line 1372), add:

```typescript
      // Mine transcript before hibernation (non-blocking)
      if (instance.outputBuffer.length >= 4) {
        try {
          const transcript = instance.outputBuffer
            .filter((msg) => msg.type === 'user' || msg.type === 'assistant')
            .map((msg) => msg.type === 'user' ? `> ${msg.content}` : msg.content)
            .join('\n\n');

          if (transcript.length > 100) {
            const wing = instance.workingDirectory || 'default';
            const sourceFile = `session://${instanceId}`;
            getConversationMiner().importFromString(transcript, {
              wing,
              sourceFile,
            });
            logger.info('Mined transcript before hibernation', { instanceId });
          }
        } catch (error) {
          logger.warn('Failed to mine transcript before hibernation', {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
```

Note: No `!instance.parentId` guard here because only root instances can be hibernated (child instances don't support hibernation).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "feat(lifecycle): auto-mine transcripts on terminate and hibernate"
```

---

## Task 4: Knowledge Bridge — Observation Pipeline → KG + Wake Hints

Create a bridge that listens to observation/reflection events and automatically creates KG facts and wake hints from them.

**Files:**
- Create: `src/main/memory/knowledge-bridge.ts`
- Test: `src/tests/unit/memory/knowledge-bridge.test.ts`

- [ ] **Step 1: Write tests for KnowledgeBridge**

```typescript
// src/tests/unit/memory/knowledge-bridge.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';

let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { KnowledgeBridge } from '../../../main/memory/knowledge-bridge';
import { KnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';
import type { Reflection, ReflectedPattern } from '../../../main/observation/observation.types';

describe('KnowledgeBridge', () => {
  beforeEach(() => {
    KnowledgeBridge._resetForTesting();
    KnowledgeGraphService._resetForTesting();
    WakeContextBuilder._resetForTesting();
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  describe('onReflectionCreated', () => {
    it('should extract KG facts from success patterns', () => {
      const bridge = KnowledgeBridge.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      const reflection: Reflection = {
        id: 'ref_1',
        title: 'typescript pattern',
        insight: 'TypeScript preferred over Python for backend services',
        observationIds: ['obs_1', 'obs_2'],
        patterns: [{
          type: 'success_pattern',
          description: 'Successful pattern observed across 5 signals',
          evidence: ['Used TypeScript for API layer'],
          strength: 0.8,
        }],
        confidence: 0.7,
        applicability: ['typescript', 'backend'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      };

      bridge.onReflectionCreated(reflection);

      const stats = kg.getStats();
      expect(stats.triples).toBeGreaterThanOrEqual(1);
    });

    it('should skip low-confidence reflections', () => {
      const bridge = KnowledgeBridge.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      const reflection: Reflection = {
        id: 'ref_2',
        title: 'weak pattern',
        insight: 'Some weak observation',
        observationIds: ['obs_3'],
        patterns: [],
        confidence: 0.2,
        applicability: ['misc'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      };

      bridge.onReflectionCreated(reflection);

      const stats = kg.getStats();
      expect(stats.triples).toBe(0);
    });
  });

  describe('onPromotedToProcedural', () => {
    it('should create a wake hint from a promoted reflection', () => {
      const bridge = KnowledgeBridge.getInstance();
      const wake = WakeContextBuilder.getInstance();

      const reflection: Reflection = {
        id: 'ref_3',
        title: 'deploy pattern',
        insight: 'Blue-green deploys with GitHub Actions are reliable',
        observationIds: ['obs_4', 'obs_5', 'obs_6'],
        patterns: [{
          type: 'success_pattern',
          description: 'Successful deployment pattern',
          evidence: ['Deploy succeeded 5 times'],
          strength: 0.9,
        }],
        confidence: 0.85,
        applicability: ['deploy', 'devops'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 3,
        effectivenessScore: 0.8,
        promotedToProcedural: true,
      };

      bridge.onPromotedToProcedural(reflection);

      const ctx = wake.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('deploy pattern');
    });
  });

  describe('extractFactsFromReflection', () => {
    it('should extract pattern-type facts', () => {
      const bridge = KnowledgeBridge.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      const reflection: Reflection = {
        id: 'ref_4',
        title: 'error handling pattern',
        insight: 'Try-catch with specific error types prevents cascading failures',
        observationIds: ['obs_7'],
        patterns: [
          {
            type: 'success_pattern',
            description: 'Error handling success',
            evidence: ['Caught TypeError before propagation'],
            strength: 0.75,
          },
          {
            type: 'failure_pattern',
            description: 'Unhandled promise rejections cause crashes',
            evidence: ['Process exited with unhandled rejection'],
            strength: 0.6,
          },
        ],
        confidence: 0.65,
        applicability: ['error_handling', 'reliability'],
        createdAt: Date.now(),
        ttl: 3_600_000,
        usageCount: 0,
        effectivenessScore: 0,
        promotedToProcedural: false,
      };

      bridge.onReflectionCreated(reflection);

      // Should create facts for each pattern with strength >= 0.5
      const stats = kg.getStats();
      expect(stats.triples).toBeGreaterThanOrEqual(2);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/memory/knowledge-bridge.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement KnowledgeBridge**

```typescript
// src/main/memory/knowledge-bridge.ts
/**
 * Knowledge Bridge
 *
 * Listens to observation pipeline events (reflections, promotions) and
 * automatically creates KG facts and wake hints from them.
 *
 * This is the glue between the observation pipeline and the knowledge layer.
 */

import { getLogger } from '../logging/logger';
import { getKnowledgeGraphService } from './knowledge-graph-service';
import { getWakeContextBuilder } from './wake-context-builder';
import type { Reflection } from '../observation/observation.types';

const logger = getLogger('KnowledgeBridge');

/** Minimum confidence for a reflection to generate KG facts */
const MIN_CONFIDENCE_FOR_FACTS = 0.5;

/** Minimum pattern strength to generate a KG fact */
const MIN_PATTERN_STRENGTH = 0.5;

export class KnowledgeBridge {
  private static instance: KnowledgeBridge | null = null;

  static getInstance(): KnowledgeBridge {
    if (!this.instance) {
      this.instance = new KnowledgeBridge();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    logger.info('KnowledgeBridge initialized');
  }

  /**
   * Called when a reflection is created by the ReflectorAgent.
   * Extracts KG facts from patterns with sufficient confidence + strength.
   */
  onReflectionCreated(reflection: Reflection): void {
    if (reflection.confidence < MIN_CONFIDENCE_FOR_FACTS) {
      logger.debug('Skipping low-confidence reflection for KG extraction', {
        reflectionId: reflection.id,
        confidence: reflection.confidence,
      });
      return;
    }

    const kg = getKnowledgeGraphService();

    for (const pattern of reflection.patterns) {
      if (pattern.strength < MIN_PATTERN_STRENGTH) continue;

      try {
        // Create a fact: reflection_title → has_pattern → pattern_description
        const subject = reflection.title.toLowerCase().replace(/\s+/g, '_').slice(0, 60);
        const predicate = pattern.type;
        const object = pattern.description.slice(0, 120);

        kg.addFact(subject, predicate, object, {
          confidence: Math.min(reflection.confidence, pattern.strength),
          sourceFile: `reflection://${reflection.id}`,
        });

        logger.debug('KG fact extracted from reflection', {
          reflectionId: reflection.id,
          pattern: pattern.type,
          subject,
        });
      } catch (error) {
        logger.warn('Failed to extract KG fact from reflection', {
          reflectionId: reflection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Also create entity for each applicability tag
    for (const tag of reflection.applicability) {
      try {
        kg.addEntity(tag, 'topic');
      } catch {
        // Entity may already exist — that's fine
      }
    }
  }

  /**
   * Called when a reflection is promoted to procedural memory.
   * Creates a wake hint so this knowledge appears in cold-start context.
   */
  onPromotedToProcedural(reflection: Reflection): void {
    try {
      const wake = getWakeContextBuilder();
      const importance = Math.round(reflection.confidence * 10);
      const room = reflection.applicability[0] || 'general';
      const content = `${reflection.title}: ${reflection.insight}`.slice(0, 300);

      wake.addHint(content, {
        importance: Math.max(1, Math.min(10, importance)),
        room,
        sourceReflectionId: reflection.id,
      });

      logger.info('Wake hint created from promoted reflection', {
        reflectionId: reflection.id,
        importance,
        room,
      });
    } catch (error) {
      logger.warn('Failed to create wake hint from promoted reflection', {
        reflectionId: reflection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function getKnowledgeBridge(): KnowledgeBridge {
  return KnowledgeBridge.getInstance();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tests/unit/memory/knowledge-bridge.test.ts`
Expected: All pass

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/memory/knowledge-bridge.ts src/tests/unit/memory/knowledge-bridge.test.ts
git commit -m "feat(memory): add KnowledgeBridge — observation pipeline → KG facts + wake hints"
```

---

## Task 5: Wire KnowledgeBridge into Main Process Events

Connect the KnowledgeBridge to the ReflectorAgent's events.

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Read the initialization section**

Read `src/main/index.ts` lines 427-432 to see where the mempalace singletons are initialized.

- [ ] **Step 2: Add KnowledgeBridge import and initialization**

Add the import at the top of `src/main/index.ts`:

```typescript
import { getKnowledgeBridge } from './memory/knowledge-bridge';
```

In the initialization steps array, after the existing mempalace block (after line 430 `{ name: 'Wake context builder', fn: () => { getWakeContextBuilder(); } },`), add:

```typescript
        { name: 'Knowledge bridge', fn: () => {
          const bridge = getKnowledgeBridge();
          const reflector = getReflectorAgent();
          reflector.on('reflector:reflection-created', (reflection) => {
            bridge.onReflectionCreated(reflection);
          });
          reflector.on('reflector:promoted-to-procedural', (reflection) => {
            bridge.onPromotedToProcedural(reflection);
          });
          logger.info('Knowledge bridge wired to reflector events');
        } },
```

Note: `getReflectorAgent` is already imported in `src/main/index.ts` (confirmed at line 19 in the research).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "feat: wire KnowledgeBridge to reflector events in main process"
```

---

## Task 6: Codebase Miner Service

Create a service that reads known config files from a working directory and extracts KG facts and wake hints.

**Files:**
- Create: `src/main/memory/codebase-miner.ts`
- Test: `src/tests/unit/memory/codebase-miner.test.ts`

- [ ] **Step 1: Write tests for CodebaseMiner**

```typescript
// src/tests/unit/memory/codebase-miner.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import * as fs from 'fs/promises';

let _testDb: InstanceType<typeof Database> | undefined;

vi.mock('../../../main/persistence/rlm-database', async () => {
  const BetterSQLite3 = (await import('better-sqlite3')).default;
  const schema = await import('../../../main/persistence/rlm/rlm-schema');
  return {
    getRLMDatabase: () => ({
      getRawDb: () => {
        if (!_testDb || !_testDb.open) {
          _testDb = new BetterSQLite3(':memory:');
          _testDb.pragma('foreign_keys = ON');
          schema.createTables(_testDb);
          schema.createMigrationsTable(_testDb);
          schema.runMigrations(_testDb);
        }
        return _testDb;
      },
    }),
  };
});

vi.mock('../../../main/logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('fs/promises');

import { CodebaseMiner } from '../../../main/memory/codebase-miner';
import { KnowledgeGraphService } from '../../../main/memory/knowledge-graph-service';
import { WakeContextBuilder } from '../../../main/memory/wake-context-builder';

const mockedFs = vi.mocked(fs);

describe('CodebaseMiner', () => {
  beforeEach(() => {
    CodebaseMiner._resetForTesting();
    KnowledgeGraphService._resetForTesting();
    WakeContextBuilder._resetForTesting();
    vi.clearAllMocks();
    if (_testDb?.open) {
      _testDb.close();
    }
    _testDb = undefined;
  });

  describe('mineDirectory', () => {
    it('should extract tech stack facts from package.json', async () => {
      const miner = CodebaseMiner.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({
            name: 'my-app',
            dependencies: {
              'express': '^4.18.0',
              'typescript': '^5.0.0',
            },
            devDependencies: {
              'vitest': '^3.0.0',
            },
          });
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/project');
      expect(result.factsExtracted).toBeGreaterThan(0);

      const stats = kg.getStats();
      expect(stats.entities).toBeGreaterThanOrEqual(1);
    });

    it('should extract hints from README.md', async () => {
      const miner = CodebaseMiner.getInstance();
      const wake = WakeContextBuilder.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('README.md')) {
          return '# My App\n\nA web application for managing tasks. Built with React and Node.js.\n\n## Getting Started\n\nnpm install && npm run dev';
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/project');
      expect(result.hintsCreated).toBeGreaterThan(0);

      const ctx = wake.generateWakeContext();
      expect(ctx.essentialStory.content).toContain('My App');
    });

    it('should extract hints from CLAUDE.md or AGENTS.md', async () => {
      const miner = CodebaseMiner.getInstance();
      const wake = WakeContextBuilder.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('CLAUDE.md')) {
          return '# Instructions\n\nAlways use TypeScript. Never use var. Prefer const over let.';
        }
        throw new Error('ENOENT');
      });

      const result = await miner.mineDirectory('/fake/project');
      expect(result.hintsCreated).toBeGreaterThan(0);
    });

    it('should handle missing files gracefully', async () => {
      const miner = CodebaseMiner.getInstance();

      mockedFs.readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await miner.mineDirectory('/fake/empty');
      expect(result.factsExtracted).toBe(0);
      expect(result.hintsCreated).toBe(0);
      expect(result.errors).toHaveLength(0); // Missing files are not errors
    });

    it('should not re-mine a directory that was already mined', async () => {
      const miner = CodebaseMiner.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({ name: 'test', dependencies: { express: '1.0' } });
        }
        throw new Error('ENOENT');
      });

      const result1 = await miner.mineDirectory('/fake/project');
      const result2 = await miner.mineDirectory('/fake/project');

      expect(result1.factsExtracted).toBeGreaterThan(0);
      expect(result2.skipped).toBe(true);
    });
  });

  describe('extractPackageJsonFacts', () => {
    it('should extract project name and dependencies', async () => {
      const miner = CodebaseMiner.getInstance();
      const kg = KnowledgeGraphService.getInstance();

      mockedFs.readFile.mockImplementation(async (filePath: fs.FileHandle | string) => {
        const path = String(filePath);
        if (path.endsWith('package.json')) {
          return JSON.stringify({
            name: '@scope/cool-app',
            dependencies: { react: '^18', next: '^14' },
            devDependencies: { jest: '^29' },
          });
        }
        throw new Error('ENOENT');
      });

      await miner.mineDirectory('/fake/project');

      // Should have entities for react, next
      const facts = kg.queryEntity('@scope/cool-app');
      expect(facts.length).toBeGreaterThan(0);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tests/unit/memory/codebase-miner.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement CodebaseMiner**

```typescript
// src/main/memory/codebase-miner.ts
/**
 * Codebase Miner
 *
 * Reads known config files from a working directory and extracts:
 * - KG facts (project name, tech stack, dependencies)
 * - Wake hints (project description, key instructions)
 * - Verbatim segments (README, CLAUDE.md content)
 *
 * Designed to run once per directory, with deduplication.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getKnowledgeGraphService } from './knowledge-graph-service';
import { getWakeContextBuilder } from './wake-context-builder';

const logger = getLogger('CodebaseMiner');

interface MineResult {
  factsExtracted: number;
  hintsCreated: number;
  filesRead: number;
  errors: string[];
  skipped?: boolean;
}

/** Files to look for, in priority order */
const CONFIG_FILES = [
  'package.json',
  'README.md',
  'CLAUDE.md',
  'AGENTS.md',
  '.claude/CLAUDE.md',
  'tsconfig.json',
  'Cargo.toml',
  'pyproject.toml',
  'go.mod',
];

/** Maximum chars to read from any single file */
const MAX_FILE_SIZE = 20_000;

/** Key dependencies that indicate tech stack (dependency name → topic) */
const NOTABLE_DEPS = new Map<string, string>([
  ['react', 'frontend'], ['next', 'frontend'], ['vue', 'frontend'], ['angular', 'frontend'], ['svelte', 'frontend'],
  ['express', 'backend'], ['fastify', 'backend'], ['koa', 'backend'], ['hono', 'backend'], ['nestjs', 'backend'],
  ['prisma', 'database'], ['drizzle', 'database'], ['typeorm', 'database'], ['mongoose', 'database'], ['better-sqlite3', 'database'],
  ['vitest', 'testing'], ['jest', 'testing'], ['mocha', 'testing'], ['playwright', 'testing'], ['cypress', 'testing'],
  ['typescript', 'language'], ['zod', 'validation'], ['electron', 'desktop'], ['tailwindcss', 'styling'],
]);

export class CodebaseMiner extends EventEmitter {
  private static instance: CodebaseMiner | null = null;
  private minedDirectories = new Set<string>();

  static getInstance(): CodebaseMiner {
    if (!this.instance) {
      this.instance = new CodebaseMiner();
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
    logger.info('CodebaseMiner initialized');
  }

  /**
   * Mine a directory for config files and extract knowledge.
   * Skips if directory was already mined in this session.
   */
  async mineDirectory(dirPath: string): Promise<MineResult> {
    const normalizedDir = path.resolve(dirPath);

    if (this.minedDirectories.has(normalizedDir)) {
      logger.debug('Directory already mined, skipping', { dirPath: normalizedDir });
      return { factsExtracted: 0, hintsCreated: 0, filesRead: 0, errors: [], skipped: true };
    }

    this.minedDirectories.add(normalizedDir);

    const result: MineResult = { factsExtracted: 0, hintsCreated: 0, filesRead: 0, errors: [] };

    for (const configFile of CONFIG_FILES) {
      const filePath = path.join(normalizedDir, configFile);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const trimmed = content.length > MAX_FILE_SIZE ? content.slice(0, MAX_FILE_SIZE) : content;
        result.filesRead++;

        if (configFile === 'package.json') {
          this.extractPackageJsonFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'tsconfig.json') {
          this.extractTsconfigFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'README.md') {
          this.extractReadmeHints(trimmed, normalizedDir, result);
        } else if (configFile === 'CLAUDE.md' || configFile === '.claude/CLAUDE.md' || configFile === 'AGENTS.md') {
          this.extractInstructionHints(trimmed, configFile, normalizedDir, result);
        } else if (configFile === 'Cargo.toml') {
          this.extractCargoFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'pyproject.toml') {
          this.extractPyprojectFacts(trimmed, normalizedDir, result);
        } else if (configFile === 'go.mod') {
          this.extractGoModFacts(trimmed, normalizedDir, result);
        }
      } catch {
        // File doesn't exist — that's fine, not an error
      }
    }

    this.emit('codebase:mine-complete', { dirPath: normalizedDir, ...result });
    logger.info('Codebase mining complete', { dirPath: normalizedDir, ...result });

    return result;
  }

  private extractPackageJsonFacts(content: string, dirPath: string, result: MineResult): void {
    try {
      const pkg = JSON.parse(content) as Record<string, unknown>;
      const kg = getKnowledgeGraphService();
      const projectName = (pkg['name'] as string) || path.basename(dirPath);

      // Create project entity
      kg.addEntity(projectName, 'project', { path: dirPath });
      result.factsExtracted++;

      // Extract notable dependencies
      const allDeps = {
        ...(pkg['dependencies'] as Record<string, string> || {}),
        ...(pkg['devDependencies'] as Record<string, string> || {}),
      };

      for (const [depName, version] of Object.entries(allDeps)) {
        const topic = NOTABLE_DEPS.get(depName);
        if (topic) {
          kg.addFact(projectName, `uses_${topic}`, depName, {
            confidence: 1.0,
            sourceFile: path.join(dirPath, 'package.json'),
          });
          result.factsExtracted++;
        }
      }

      // Create a tech stack wake hint
      const notableDeps = Object.keys(allDeps).filter((d) => NOTABLE_DEPS.has(d));
      if (notableDeps.length > 0) {
        const wake = getWakeContextBuilder();
        wake.addHint(`Tech stack: ${notableDeps.join(', ')}`, {
          importance: 7,
          room: 'architecture',
        });
        result.hintsCreated++;
      }
    } catch (error) {
      result.errors.push(`package.json parse error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extractTsconfigFacts(content: string, dirPath: string, result: MineResult): void {
    try {
      // tsconfig can have comments — strip them for JSON parsing
      const stripped = content.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      const tsconfig = JSON.parse(stripped) as Record<string, unknown>;
      const kg = getKnowledgeGraphService();
      const projectName = path.basename(dirPath);
      const compilerOptions = tsconfig['compilerOptions'] as Record<string, unknown> | undefined;

      if (compilerOptions) {
        if (compilerOptions['strict'] === true) {
          kg.addFact(projectName, 'typescript_config', 'strict mode enabled', {
            confidence: 1.0,
            sourceFile: path.join(dirPath, 'tsconfig.json'),
          });
          result.factsExtracted++;
        }
        const target = compilerOptions['target'] as string | undefined;
        if (target) {
          kg.addFact(projectName, 'typescript_target', target, {
            confidence: 1.0,
            sourceFile: path.join(dirPath, 'tsconfig.json'),
          });
          result.factsExtracted++;
        }
      }
    } catch {
      // tsconfig parse failure — not critical
    }
  }

  private extractReadmeHints(content: string, dirPath: string, result: MineResult): void {
    const wake = getWakeContextBuilder();

    // Extract first heading + first paragraph as project description
    const lines = content.split('\n');
    const heading = lines.find((l) => l.startsWith('# '));
    const firstParagraph = lines
      .filter((l) => !l.startsWith('#') && l.trim().length > 0)
      .slice(0, 3)
      .join(' ')
      .trim()
      .slice(0, 300);

    if (heading || firstParagraph) {
      const description = heading
        ? `${heading.replace(/^#\s+/, '')}: ${firstParagraph}`
        : firstParagraph;

      wake.addHint(description.slice(0, 300), {
        importance: 6,
        room: 'project',
      });
      result.hintsCreated++;
    }
  }

  private extractInstructionHints(content: string, fileName: string, _dirPath: string, result: MineResult): void {
    const wake = getWakeContextBuilder();

    // Extract key instructions (lines that look like rules/instructions)
    const lines = content.split('\n');
    const instructionLines = lines.filter((l) => {
      const trimmed = l.trim();
      // Look for bullet points, numbered lists, or imperative sentences
      return (trimmed.startsWith('- ') || trimmed.startsWith('* ') || /^\d+\./.test(trimmed))
        && trimmed.length > 20
        && trimmed.length < 200;
    });

    // Take top 5 instruction lines
    for (const line of instructionLines.slice(0, 5)) {
      const cleaned = line.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '').trim();
      wake.addHint(cleaned, {
        importance: 8,
        room: 'instructions',
      });
      result.hintsCreated++;
    }

    if (instructionLines.length === 0 && content.length > 50) {
      // Fall back to first meaningful paragraph
      const firstParagraph = content
        .split('\n\n')
        .find((p) => p.trim().length > 30 && !p.startsWith('#'));
      if (firstParagraph) {
        wake.addHint(`[${fileName}] ${firstParagraph.trim().slice(0, 250)}`, {
          importance: 7,
          room: 'instructions',
        });
        result.hintsCreated++;
      }
    }
  }

  private extractCargoFacts(content: string, dirPath: string, result: MineResult): void {
    const kg = getKnowledgeGraphService();
    const projectName = path.basename(dirPath);
    kg.addFact(projectName, 'uses_language', 'Rust', {
      confidence: 1.0,
      sourceFile: path.join(dirPath, 'Cargo.toml'),
    });
    result.factsExtracted++;

    // Extract package name from [package] section
    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      kg.addEntity(nameMatch[1], 'project', { language: 'rust', path: dirPath });
      result.factsExtracted++;
    }
  }

  private extractPyprojectFacts(content: string, dirPath: string, result: MineResult): void {
    const kg = getKnowledgeGraphService();
    const projectName = path.basename(dirPath);
    kg.addFact(projectName, 'uses_language', 'Python', {
      confidence: 1.0,
      sourceFile: path.join(dirPath, 'pyproject.toml'),
    });
    result.factsExtracted++;

    const nameMatch = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      kg.addEntity(nameMatch[1], 'project', { language: 'python', path: dirPath });
      result.factsExtracted++;
    }
  }

  private extractGoModFacts(content: string, dirPath: string, result: MineResult): void {
    const kg = getKnowledgeGraphService();
    const projectName = path.basename(dirPath);
    kg.addFact(projectName, 'uses_language', 'Go', {
      confidence: 1.0,
      sourceFile: path.join(dirPath, 'go.mod'),
    });
    result.factsExtracted++;

    const moduleMatch = content.match(/^module\s+(\S+)/m);
    if (moduleMatch) {
      kg.addEntity(moduleMatch[1], 'project', { language: 'go', path: dirPath });
      result.factsExtracted++;
    }
  }
}

export function getCodebaseMiner(): CodebaseMiner {
  return CodebaseMiner.getInstance();
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tests/unit/memory/codebase-miner.test.ts`
Expected: All pass

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/memory/codebase-miner.ts src/tests/unit/memory/codebase-miner.test.ts
git commit -m "feat(memory): add CodebaseMiner — extract KG facts + wake hints from project config files"
```

---

## Task 7: Wire CodebaseMiner into Instance Creation

Automatically mine the working directory when a root instance is created.

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts`

- [ ] **Step 1: Add codebase miner import**

At the top of `src/main/instance/instance-lifecycle.ts`, add:

```typescript
import { getCodebaseMiner } from '../memory/codebase-miner';
```

- [ ] **Step 2: Trigger codebase mining after system prompt construction**

In `src/main/instance/instance-lifecycle.ts`, after the wake context injection block (added in Task 2) and before the tool permissions block (line 898 area), add:

```typescript
        // Trigger codebase mining for the working directory (async, fire-and-forget)
        if (instance.depth === 0 && instance.workingDirectory) {
          getCodebaseMiner().mineDirectory(instance.workingDirectory).catch((err) => {
            logger.warn('Codebase mining failed', {
              error: err instanceof Error ? err.message : String(err),
              workingDirectory: instance.workingDirectory,
            });
          });
        }
```

Key design decisions:
- Fire-and-forget (`catch` only, no `await`) — mining should not block instance creation
- Only root instances (`depth === 0`)
- Only when workingDirectory exists
- CodebaseMiner internally deduplicates (won't re-mine same directory)

- [ ] **Step 3: Add CodebaseMiner singleton initialization**

In `src/main/index.ts`, add import:

```typescript
import { getCodebaseMiner } from './memory/codebase-miner';
```

In the initialization steps, after the KnowledgeBridge step, add:

```typescript
        { name: 'Codebase miner', fn: () => { getCodebaseMiner(); } },
```

- [ ] **Step 4: Add IPC handlers for codebase mining**

In `src/main/ipc/handlers/knowledge-graph-handlers.ts`, add two new handlers at the end of the `registerKnowledgeGraphHandlers` function (before the closing `logger.info` line):

First, add imports at the top:

```typescript
import { getCodebaseMiner } from '../../memory/codebase-miner';
```

Then add to `src/shared/validation/ipc-schemas.ts`:

```typescript
// ============ Codebase Mining Schemas ============

export const CodebaseMineDirectoryPayloadSchema = z.object({
  dirPath: z.string().min(1),
});

export const CodebaseGetStatusPayloadSchema = z.object({
  dirPath: z.string().min(1),
});
```

Then add handlers in `knowledge-graph-handlers.ts`:

```typescript
  ipcMain.handle(
    IPC_CHANNELS.CODEBASE_MINE_DIRECTORY,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const { CodebaseMineDirectoryPayloadSchema } = await import('../../../shared/validation/ipc-schemas');
        const data = CodebaseMineDirectoryPayloadSchema.parse(payload);
        const result = await getCodebaseMiner().mineDirectory(data.dirPath);
        return { success: true, data: result };
      } catch (error) {
        logger.error('CODEBASE_MINE_DIRECTORY failed', error as Error);
        return {
          success: false,
          error: {
            code: 'CODEBASE_MINE_DIRECTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
```

- [ ] **Step 5: Add preload bridge for codebase mining**

In `src/preload/domains/memory.preload.ts`, after the wake context methods, add:

```typescript
  // Codebase Mining
  codebaseMineDirectory: (payload: unknown) => ipcRenderer.invoke(ch.CODEBASE_MINE_DIRECTORY, payload),
  codebaseGetStatus: (payload: unknown) => ipcRenderer.invoke(ch.CODEBASE_GET_STATUS, payload),
```

Note: Use `ch.CODEBASE_MINE_DIRECTORY` — the generated channels file will have this after `npm run generate:ipc` in Task 1.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts \
       src/main/index.ts \
       src/main/ipc/handlers/knowledge-graph-handlers.ts \
       src/shared/validation/ipc-schemas.ts \
       src/preload/domains/memory.preload.ts
git commit -m "feat: auto-mine codebase on instance creation + IPC handlers"
```

---

## Task 8: Event Forwarding to Renderer

Forward knowledge graph, mining, and wake events to the renderer.

**Files:**
- Modify: `src/main/ipc/ipc-main-handler.ts`

- [ ] **Step 1: Read the event forwarding section**

Read `src/main/ipc/ipc-main-handler.ts` lines 575-595 to see the debate event forwarding pattern.

- [ ] **Step 2: Add the knowledge event forwarding method**

Add a new private method in `IpcMainHandler` (after the existing `setupReactionEventForwarding` method):

```typescript
  /**
   * Forward knowledge graph, mining, and wake events to renderer
   */
  private setupKnowledgeEventForwarding(): void {
    try {
      const kg = getKnowledgeGraphService();
      const miner = getConversationMiner();
      const wake = getWakeContextBuilder();
      const send = (channel: string, data: unknown) =>
        this.windowManager.getMainWindow()?.webContents.send(channel, data);

      kg.on('graph:fact-added', (data) => send(IPC_CHANNELS.KG_EVENT_FACT_ADDED, data));
      kg.on('graph:fact-invalidated', (data) => send(IPC_CHANNELS.KG_EVENT_FACT_INVALIDATED, data));
      miner.on('miner:import-complete', (data) => send(IPC_CHANNELS.CONVO_EVENT_IMPORT_COMPLETE, data));
      wake.on('wake:hint-added', (data) => send(IPC_CHANNELS.WAKE_EVENT_HINT_ADDED, data));
      wake.on('wake:context-generated', (data) => send(IPC_CHANNELS.WAKE_EVENT_CONTEXT_GENERATED, data));
    } catch {
      logger.warn('Knowledge services not available for event forwarding');
    }
  }
```

Add the imports at the top of the file:

```typescript
import { getKnowledgeGraphService } from '../memory/knowledge-graph-service';
import { getConversationMiner } from '../memory/conversation-miner';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
```

- [ ] **Step 3: Register the forwarding in registerHandlers**

In the `registerHandlers()` method, after the existing `this.setupReactionEventForwarding();` line (around line 324), add:

```typescript
    this.setupKnowledgeEventForwarding();
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/ipc-main-handler.ts
git commit -m "feat(ipc): forward knowledge graph, mining, and wake events to renderer"
```

---

## Task 9: Integration Test — Full Pipeline

Test the complete flow: codebase mining → KG facts → wake context injection → transcript mining.

**Files:**
- Modify: `src/tests/integration/memory/mempalace-features.test.ts`

- [ ] **Step 1: Read the existing integration test**

Read `src/tests/integration/memory/mempalace-features.test.ts` to see the existing tests and mock pattern.

- [ ] **Step 2: Add integration tests for the new wiring**

Add these tests to the existing describe block in `src/tests/integration/memory/mempalace-features.test.ts`:

```typescript
  // Add imports at the top (after the existing imports):
  // import { KnowledgeBridge } from '../../../main/memory/knowledge-bridge';
  // import type { Reflection } from '../../../main/observation/observation.types';

  // Add to beforeEach:
  // KnowledgeBridge._resetForTesting();

  it('should bridge promoted reflections into wake hints', () => {
    const bridge = KnowledgeBridge.getInstance();
    const wake = WakeContextBuilder.getInstance();

    const reflection: Reflection = {
      id: 'ref_integration_1',
      title: 'TDD is effective',
      insight: 'Test-driven development catches bugs early and reduces rework',
      observationIds: ['obs_i1', 'obs_i2'],
      patterns: [{
        type: 'success_pattern',
        description: 'TDD reduced bug count by 50%',
        evidence: ['3 sessions used TDD with fewer failures'],
        strength: 0.85,
      }],
      confidence: 0.8,
      applicability: ['testing', 'workflow'],
      createdAt: Date.now(),
      ttl: 3_600_000,
      usageCount: 5,
      effectivenessScore: 0.9,
      promotedToProcedural: true,
    };

    // Simulate promotion
    bridge.onPromotedToProcedural(reflection);

    // Should appear in wake context
    const ctx = wake.generateWakeContext();
    expect(ctx.essentialStory.content).toContain('TDD is effective');
  });

  it('should extract KG facts from reflections with sufficient confidence', () => {
    const bridge = KnowledgeBridge.getInstance();
    const kg = KnowledgeGraphService.getInstance();

    const reflection: Reflection = {
      id: 'ref_integration_2',
      title: 'async error handling',
      insight: 'Always wrap async calls in try-catch',
      observationIds: ['obs_i3'],
      patterns: [{
        type: 'success_pattern',
        description: 'Proper error handling prevented crashes',
        evidence: ['Handled 5 async errors gracefully'],
        strength: 0.7,
      }],
      confidence: 0.65,
      applicability: ['error_handling'],
      createdAt: Date.now(),
      ttl: 3_600_000,
      usageCount: 0,
      effectivenessScore: 0,
      promotedToProcedural: false,
    };

    bridge.onReflectionCreated(reflection);

    const stats = kg.getStats();
    expect(stats.triples).toBeGreaterThanOrEqual(1);
  });

  it('should NOT extract facts from low-confidence reflections', () => {
    const bridge = KnowledgeBridge.getInstance();
    const kg = KnowledgeGraphService.getInstance();

    const reflection: Reflection = {
      id: 'ref_integration_3',
      title: 'weak observation',
      insight: 'Maybe this is useful',
      observationIds: ['obs_i4'],
      patterns: [{
        type: 'workflow_optimization',
        description: 'Possible optimization',
        evidence: ['Saw it once'],
        strength: 0.3,
      }],
      confidence: 0.3,
      applicability: ['misc'],
      createdAt: Date.now(),
      ttl: 3_600_000,
      usageCount: 0,
      effectivenessScore: 0,
      promotedToProcedural: false,
    };

    bridge.onReflectionCreated(reflection);

    const stats = kg.getStats();
    expect(stats.triples).toBe(0);
  });
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/tests/integration/memory/mempalace-features.test.ts`
Expected: All pass (original 3 + new 3 = 6 tests)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add src/tests/integration/memory/mempalace-features.test.ts
git commit -m "test: add integration tests for knowledge bridge and auto-mining pipeline"
```

---

## Task 10: Final Verification

- [ ] **Step 1: Regenerate channels and verify sync**

Run: `npm run generate:ipc && npm run verify:ipc`
Expected: Clean output, no mismatches

- [ ] **Step 2: Run full typecheck**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 3: Run all mempalace tests**

Run: `npx vitest run src/tests/`
Expected: All pass

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: No NEW failures (pre-existing failures are OK)

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: All files pass

- [ ] **Step 6: Verify event wiring completeness**

Manually trace each event chain:
1. `reflector:reflection-created` → KnowledgeBridge.onReflectionCreated → KG.addFact → `graph:fact-added` → renderer
2. `reflector:promoted-to-procedural` → KnowledgeBridge.onPromotedToProcedural → Wake.addHint → `wake:hint-added` → renderer
3. Instance create → CodebaseMiner.mineDirectory → KG facts + wake hints
4. Instance terminate → ConversationMiner.importFromString → verbatim segments
5. Instance hibernate → ConversationMiner.importFromString → verbatim segments
6. Instance create → Wake.getWakeUpText → injected into system prompt

- [ ] **Step 7: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore: final verification — knowledge wiring and auto-mining complete"
```

---

## Summary

| Task | Feature | Files Created | Files Modified |
|------|---------|---------------|----------------|
| 1 | Contracts channel alignment | 0 | 3 (contracts, ipc.types, generated) |
| 2 | Wake context injection | 0 | 1 (instance-lifecycle) |
| 3 | Auto-mine on terminate/hibernate | 0 | 1 (instance-lifecycle) |
| 4 | KnowledgeBridge service | 2 | 0 |
| 5 | Wire KnowledgeBridge | 0 | 1 (index.ts) |
| 6 | CodebaseMiner service | 2 | 0 |
| 7 | Wire CodebaseMiner | 0 | 5 (lifecycle, index, handlers, schemas, preload) |
| 8 | Event forwarding | 0 | 1 (ipc-main-handler) |
| 9 | Integration tests | 0 | 1 (existing test file) |
| 10 | Final verification | 0 | 0 |
| **Total** | | **4 new** | **10 modified** |
