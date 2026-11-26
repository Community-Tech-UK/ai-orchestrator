# Context & Token Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a layered compaction pipeline (microcompact + context collapse), per-turn token budget tracking with diminishing returns detection, and turn-ID analytics across compaction boundaries — inspired by Claude Code's query loop token management.

**Architecture:** The existing 2-phase compaction (prune + summarize) gets augmented with two cheaper intermediate stages. A new `TokenBudgetTracker` monitors per-turn productivity to detect runaway loops. Compaction epochs get unique turn IDs for analytics tuning.

**Tech Stack:** TypeScript, Node.js EventEmitter, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/main/context/microcompact.ts` | Surgical tool-result removal preserving recent context |
| Create | `src/main/context/microcompact.spec.ts` | Tests for microcompact |
| Create | `src/main/context/context-collapse.ts` | Read-time projection that avoids full summarization |
| Create | `src/main/context/context-collapse.spec.ts` | Tests for context collapse |
| Create | `src/main/context/token-budget-tracker.ts` | Per-turn budget tracking with diminishing returns |
| Create | `src/main/context/token-budget-tracker.spec.ts` | Tests for budget tracker |
| Create | `src/main/context/compaction-epoch.ts` | Turn ID tracking across compaction boundaries |
| Create | `src/main/context/compaction-epoch.spec.ts` | Tests for epoch tracking |
| Modify | `src/main/context/context-compactor.ts` | Integrate microcompact + collapse into pipeline |
| Modify | `src/main/context/compaction-coordinator.ts` | Integrate budget tracker and epoch tracking |
| Modify | `src/main/context/index.ts` | Export new modules |

---

### Task 1: Microcompact — Surgical Tool Output Removal

**Files:**
- Create: `src/main/context/microcompact.ts`
- Create: `src/main/context/microcompact.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/microcompact.spec.ts
import { describe, it, expect } from 'vitest';
import { Microcompact, type MicrocompactTurn } from './microcompact';

describe('Microcompact', () => {
  const makeTurn = (id: string, tokenCount: number, toolOutputTokens = 0): MicrocompactTurn => ({
    id,
    role: 'assistant',
    content: 'response',
    tokenCount,
    timestamp: Date.now(),
    toolCalls: toolOutputTokens > 0 ? [{
      id: `tc-${id}`,
      name: 'bash',
      input: 'ls',
      output: 'file1\nfile2',
      inputTokens: 10,
      outputTokens: toolOutputTokens,
    }] : undefined,
  });

  it('removes tool outputs from old turns, preserving recent ones', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 2, minSavingsTokens: 100 });
    const turns = [
      makeTurn('old1', 100, 500),
      makeTurn('old2', 100, 600),
      makeTurn('recent1', 100, 300),
      makeTurn('recent2', 100, 200),
    ];

    const result = mc.compact(turns);
    expect(result.tokensSaved).toBeGreaterThan(0);
    // Old turns should have tool outputs cleared
    expect(result.turns[0].toolCalls![0].output).toBe('[microcompacted]');
    expect(result.turns[1].toolCalls![0].output).toBe('[microcompacted]');
    // Recent turns preserved
    expect(result.turns[2].toolCalls![0].output).toBe('file1\nfile2');
    expect(result.turns[3].toolCalls![0].output).toBe('file1\nfile2');
  });

  it('skips compaction when savings below threshold', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 2, minSavingsTokens: 5000 });
    const turns = [
      makeTurn('old1', 100, 50),
      makeTurn('recent1', 100, 50),
    ];

    const result = mc.compact(turns);
    expect(result.tokensSaved).toBe(0);
    expect(result.skipped).toBe(true);
  });

  it('preserves turns with no tool calls', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 0 });
    const turns = [
      { id: 'plain', role: 'user' as const, content: 'hello', tokenCount: 50, timestamp: Date.now() },
      makeTurn('recent', 100, 200),
    ];

    const result = mc.compact(turns);
    expect(result.turns[0].content).toBe('hello');
  });

  it('reports correct metrics', () => {
    const mc = new Microcompact({ recentTurnsToProtect: 1, minSavingsTokens: 0 });
    const turns = [
      makeTurn('old', 100, 1000),
      makeTurn('recent', 100, 500),
    ];

    const result = mc.compact(turns);
    expect(result.turnsCompacted).toBe(1);
    expect(result.tokensSaved).toBe(1000 - 5); // output tokens minus placeholder cost
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/microcompact.spec.ts`
Expected: FAIL with "Cannot find module './microcompact'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/microcompact.ts
/**
 * Microcompact
 *
 * Surgical removal of old tool outputs without full summarization.
 * Much cheaper than auto-compact — preserves message structure and
 * only clears tool result content from older turns.
 *
 * Inspired by Claude Code's microcompact system which uses cache_edits
 * to preserve API cache prefixes. Our version operates on the turn array
 * directly since we don't have cache_edits API support.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('Microcompact');

/** Minimal placeholder cost for compacted tool output */
const PLACEHOLDER_TOKEN_COST = 5;

export interface MicrocompactConfig {
  /** Number of recent turns to protect from compaction */
  recentTurnsToProtect: number;
  /** Minimum token savings to justify compaction */
  minSavingsTokens: number;
}

export interface MicrocompactToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MicrocompactTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount: number;
  timestamp: number;
  toolCalls?: MicrocompactToolCall[];
  metadata?: Record<string, unknown>;
}

export interface MicrocompactResult {
  turns: MicrocompactTurn[];
  tokensSaved: number;
  turnsCompacted: number;
  skipped: boolean;
}

const DEFAULT_CONFIG: MicrocompactConfig = {
  recentTurnsToProtect: 3,
  minSavingsTokens: 500,
};

export class Microcompact {
  private config: MicrocompactConfig;

  constructor(config?: Partial<MicrocompactConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  compact(turns: MicrocompactTurn[]): MicrocompactResult {
    // Deep copy to avoid mutating input
    const result = turns.map(t => ({
      ...t,
      toolCalls: t.toolCalls?.map(tc => ({ ...tc })),
    }));

    const protectedStartIndex = Math.max(0, result.length - this.config.recentTurnsToProtect);

    // First pass: calculate potential savings
    let potentialSavings = 0;
    for (let i = 0; i < protectedStartIndex; i++) {
      const turn = result[i];
      if (!turn.toolCalls) continue;
      for (const tc of turn.toolCalls) {
        if (tc.output && tc.outputTokens > PLACEHOLDER_TOKEN_COST) {
          potentialSavings += tc.outputTokens - PLACEHOLDER_TOKEN_COST;
        }
      }
    }

    if (potentialSavings < this.config.minSavingsTokens) {
      return { turns: result, tokensSaved: 0, turnsCompacted: 0, skipped: true };
    }

    // Second pass: compact old tool outputs
    let tokensSaved = 0;
    let turnsCompacted = 0;

    for (let i = 0; i < protectedStartIndex; i++) {
      const turn = result[i];
      if (!turn.toolCalls) continue;

      let turnCompacted = false;
      for (const tc of turn.toolCalls) {
        if (tc.output && tc.outputTokens > PLACEHOLDER_TOKEN_COST) {
          tokensSaved += tc.outputTokens - PLACEHOLDER_TOKEN_COST;
          tc.output = '[microcompacted]';
          tc.outputTokens = PLACEHOLDER_TOKEN_COST;
          turnCompacted = true;
        }
      }

      if (turnCompacted) {
        turnsCompacted++;
        // Update turn's total token count
        turn.tokenCount = Math.max(0, turn.tokenCount - tokensSaved);
      }
    }

    logger.info('Microcompact completed', { tokensSaved, turnsCompacted });

    return { turns: result, tokensSaved, turnsCompacted, skipped: false };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/microcompact.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/microcompact.ts src/main/context/microcompact.spec.ts
git commit -m "feat(context): add microcompact for surgical tool output removal"
```

---

### Task 2: Context Collapse — Read-Time Projection

**Files:**
- Create: `src/main/context/context-collapse.ts`
- Create: `src/main/context/context-collapse.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/context-collapse.spec.ts
import { describe, it, expect } from 'vitest';
import { ContextCollapse, type CollapsibleTurn } from './context-collapse';

describe('ContextCollapse', () => {
  const makeTurn = (id: string, tokens: number, age: 'old' | 'recent'): CollapsibleTurn => ({
    id,
    role: 'assistant',
    content: `Response for ${id}`,
    tokenCount: tokens,
    timestamp: age === 'old' ? Date.now() - 600000 : Date.now(),
    collapsible: true,
  });

  it('stages collapses for old turns that exceed threshold', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 2, minTokensToCollapse: 100 });
    const turns = [
      makeTurn('old1', 500, 'old'),
      makeTurn('old2', 300, 'old'),
      makeTurn('recent1', 200, 'recent'),
      makeTurn('recent2', 100, 'recent'),
    ];

    const staged = collapse.stageCollapses(turns);
    expect(staged.collapsedTurnIds).toContain('old1');
    expect(staged.collapsedTurnIds).toContain('old2');
    expect(staged.collapsedTurnIds).not.toContain('recent1');
    expect(staged.estimatedTokensSaved).toBeGreaterThan(0);
  });

  it('applies staged collapses to produce compressed turns', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 1, minTokensToCollapse: 50 });
    const turns = [
      makeTurn('old1', 500, 'old'),
      makeTurn('recent1', 200, 'recent'),
    ];

    const staged = collapse.stageCollapses(turns);
    const applied = collapse.applyCollapses(turns, staged);

    // Old turn should be collapsed to a brief summary marker
    expect(applied.turns[0].content).toContain('[collapsed]');
    expect(applied.turns[0].tokenCount).toBeLessThan(500);
    // Recent turn untouched
    expect(applied.turns[1].content).toBe('Response for recent1');
  });

  it('can recover from overflow by force-collapsing more aggressively', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 3, minTokensToCollapse: 100 });
    const turns = [
      makeTurn('a', 1000, 'old'),
      makeTurn('b', 1000, 'old'),
      makeTurn('c', 1000, 'recent'),
    ];

    const result = collapse.recoverFromOverflow(turns);
    // Should collapse even "recent" turns when recovering from overflow
    expect(result.collapsedTurnIds.length).toBeGreaterThanOrEqual(2);
  });

  it('skips turns marked as not collapsible', () => {
    const collapse = new ContextCollapse({ collapseAfterTurns: 1, minTokensToCollapse: 0 });
    const turns: CollapsibleTurn[] = [
      { ...makeTurn('old1', 500, 'old'), collapsible: false },
      makeTurn('recent1', 200, 'recent'),
    ];

    const staged = collapse.stageCollapses(turns);
    expect(staged.collapsedTurnIds).not.toContain('old1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/context-collapse.spec.ts`
Expected: FAIL with "Cannot find module './context-collapse'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/context-collapse.ts
/**
 * Context Collapse
 *
 * Read-time projection over conversation history that can avoid expensive
 * LLM summarization by collapsing old turns to brief structural markers.
 *
 * Inspired by Claude Code's context_collapse system:
 * - Staged collapses computed cheaply (no LLM needed)
 * - Applied only when needed (saves ~90% of full summarization cost)
 * - Overflow recovery as first-resort before reactive compact
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('ContextCollapse');

/** Collapsed turn placeholder cost in tokens */
const COLLAPSE_PLACEHOLDER_TOKENS = 15;

export interface ContextCollapseConfig {
  /** Number of recent turns protected from collapse */
  collapseAfterTurns: number;
  /** Minimum token count for a turn to be worth collapsing */
  minTokensToCollapse: number;
}

export interface CollapsibleTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount: number;
  timestamp: number;
  collapsible?: boolean;
  toolCalls?: Array<{ name: string; id: string }>;
}

export interface StagedCollapse {
  collapsedTurnIds: string[];
  estimatedTokensSaved: number;
}

export interface ApplyResult {
  turns: CollapsibleTurn[];
  tokensSaved: number;
}

const DEFAULT_CONFIG: ContextCollapseConfig = {
  collapseAfterTurns: 5,
  minTokensToCollapse: 100,
};

export class ContextCollapse {
  private config: ContextCollapseConfig;
  /** Track which turns have been collapsed (persists across calls) */
  private collapsedStore = new Set<string>();

  constructor(config?: Partial<ContextCollapseConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Stage collapses: identify which turns CAN be collapsed.
   * This is a cheap computation (no LLM). Collapses are not applied yet.
   */
  stageCollapses(turns: CollapsibleTurn[]): StagedCollapse {
    const protectedIndex = Math.max(0, turns.length - this.config.collapseAfterTurns);
    const collapsedTurnIds: string[] = [];
    let estimatedTokensSaved = 0;

    for (let i = 0; i < protectedIndex; i++) {
      const turn = turns[i];
      if (turn.collapsible === false) continue;
      if (turn.tokenCount < this.config.minTokensToCollapse) continue;
      if (this.collapsedStore.has(turn.id)) continue; // Already collapsed

      collapsedTurnIds.push(turn.id);
      estimatedTokensSaved += turn.tokenCount - COLLAPSE_PLACEHOLDER_TOKENS;
    }

    return { collapsedTurnIds, estimatedTokensSaved };
  }

  /**
   * Apply staged collapses to the turn array.
   * Returns a new array with collapsed turns replaced by placeholders.
   */
  applyCollapses(turns: CollapsibleTurn[], staged: StagedCollapse): ApplyResult {
    const collapseSet = new Set(staged.collapsedTurnIds);
    let tokensSaved = 0;

    const result = turns.map(turn => {
      if (!collapseSet.has(turn.id)) return { ...turn };

      const toolNames = turn.toolCalls?.map(tc => tc.name).join(', ') || '';
      const summary = toolNames
        ? `[collapsed: ${turn.role} turn with tools: ${toolNames}]`
        : `[collapsed: ${turn.role} turn]`;

      tokensSaved += turn.tokenCount - COLLAPSE_PLACEHOLDER_TOKENS;
      this.collapsedStore.add(turn.id);

      return {
        ...turn,
        content: summary,
        tokenCount: COLLAPSE_PLACEHOLDER_TOKENS,
        toolCalls: undefined,
      };
    });

    logger.info('Context collapse applied', {
      turnsCollapsed: staged.collapsedTurnIds.length,
      tokensSaved,
    });

    return { turns: result, tokensSaved };
  }

  /**
   * Emergency: recover from prompt-too-long by aggressively collapsing.
   * Protects only the last turn.
   */
  recoverFromOverflow(turns: CollapsibleTurn[]): StagedCollapse {
    const protectedIndex = Math.max(0, turns.length - 1); // Protect only last turn
    const collapsedTurnIds: string[] = [];
    let estimatedTokensSaved = 0;

    for (let i = 0; i < protectedIndex; i++) {
      const turn = turns[i];
      if (turn.collapsible === false) continue;
      if (this.collapsedStore.has(turn.id)) continue;
      if (turn.tokenCount <= COLLAPSE_PLACEHOLDER_TOKENS) continue;

      collapsedTurnIds.push(turn.id);
      estimatedTokensSaved += turn.tokenCount - COLLAPSE_PLACEHOLDER_TOKENS;
    }

    logger.warn('Context collapse overflow recovery', {
      turnsToCollapse: collapsedTurnIds.length,
      estimatedTokensSaved,
    });

    return { collapsedTurnIds, estimatedTokensSaved };
  }

  /** Reset tracked collapses (e.g., on session reset) */
  reset(): void {
    this.collapsedStore.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/context-collapse.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/context-collapse.ts src/main/context/context-collapse.spec.ts
git commit -m "feat(context): add context collapse for cheap read-time projection"
```

---

### Task 3: Token Budget Tracker with Diminishing Returns

**Files:**
- Create: `src/main/context/token-budget-tracker.ts`
- Create: `src/main/context/token-budget-tracker.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/token-budget-tracker.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TokenBudgetTracker, BudgetAction } from './token-budget-tracker';

describe('TokenBudgetTracker', () => {
  let tracker: TokenBudgetTracker;

  beforeEach(() => {
    tracker = new TokenBudgetTracker({ totalBudget: 10000 });
  });

  it('allows continuation when under 90% of budget', () => {
    const result = tracker.checkBudget({ turnTokens: 5000 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
    expect(result.nudgeMessage).toContain('Keep working');
  });

  it('stops when over 90% of budget', () => {
    const result = tracker.checkBudget({ turnTokens: 9500 });
    expect(result.action).toBe(BudgetAction.STOP);
  });

  it('detects diminishing returns after 3+ continuations', () => {
    // Simulate 4 continuations with decreasing output
    tracker.recordContinuation(2000);
    tracker.recordContinuation(1000);
    tracker.recordContinuation(400);
    tracker.recordContinuation(200); // < 500 tokens delta

    const result = tracker.checkBudget({ turnTokens: 3600 });
    expect(result.action).toBe(BudgetAction.STOP);
    expect(result.reason).toContain('diminishing');
  });

  it('does not detect diminishing returns with < 3 continuations', () => {
    tracker.recordContinuation(2000);
    tracker.recordContinuation(200); // Low delta but only 2 continuations

    const result = tracker.checkBudget({ turnTokens: 2200 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
  });

  it('resets state correctly', () => {
    tracker.recordContinuation(5000);
    tracker.recordContinuation(300);
    tracker.recordContinuation(100);
    tracker.recordContinuation(50);

    tracker.reset();

    const result = tracker.checkBudget({ turnTokens: 3000 });
    expect(result.action).toBe(BudgetAction.CONTINUE);
  });

  it('provides accurate fill percentage in nudge', () => {
    const result = tracker.checkBudget({ turnTokens: 5000 });
    expect(result.nudgeMessage).toContain('50%');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/token-budget-tracker.spec.ts`
Expected: FAIL with "Cannot find module './token-budget-tracker'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/token-budget-tracker.ts
/**
 * Token Budget Tracker
 *
 * Monitors per-turn token usage and detects diminishing returns.
 * Prevents runaway cost from unproductive agent loops.
 *
 * Inspired by Claude Code's BudgetTracker in query/tokenBudget.ts:
 * - Checks if turn tokens exceed 90% of budget
 * - After 3+ continuations, detects if delta < 500 tokens (diminishing)
 * - Provides nudge messages to keep agent focused
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('TokenBudgetTracker');

/** Minimum delta tokens per continuation to consider productive */
const MIN_PRODUCTIVE_DELTA = 500;

/** Number of continuations before checking for diminishing returns */
const DIMINISHING_CHECK_THRESHOLD = 3;

/** Budget fill ratio to stop at */
const STOP_RATIO = 0.9;

export enum BudgetAction {
  CONTINUE = 'continue',
  STOP = 'stop',
}

export interface BudgetCheckResult {
  action: BudgetAction;
  reason?: string;
  nudgeMessage?: string;
  fillPercentage: number;
}

export interface TokenBudgetConfig {
  totalBudget: number;
}

export class TokenBudgetTracker {
  private config: TokenBudgetConfig;
  private continuationCount = 0;
  private deltas: number[] = [];
  private lastTurnTokens = 0;

  constructor(config: TokenBudgetConfig) {
    this.config = config;
  }

  /**
   * Record a continuation with its token output.
   */
  recordContinuation(deltaTokens: number): void {
    this.continuationCount++;
    this.deltas.push(deltaTokens);
    this.lastTurnTokens += deltaTokens;
  }

  /**
   * Check whether the agent should continue or stop.
   */
  checkBudget(params: { turnTokens: number }): BudgetCheckResult {
    const fillPercentage = Math.round((params.turnTokens / this.config.totalBudget) * 100);

    // Check diminishing returns (before budget check)
    if (this.continuationCount >= DIMINISHING_CHECK_THRESHOLD) {
      const lastDelta = this.deltas[this.deltas.length - 1] ?? 0;
      if (lastDelta < MIN_PRODUCTIVE_DELTA) {
        logger.info('Diminishing returns detected', {
          continuationCount: this.continuationCount,
          lastDelta,
          fillPercentage,
        });
        return {
          action: BudgetAction.STOP,
          reason: `diminishing returns: last delta ${lastDelta} tokens after ${this.continuationCount} continuations`,
          fillPercentage,
        };
      }
    }

    // Check budget fill ratio
    if (params.turnTokens >= this.config.totalBudget * STOP_RATIO) {
      return {
        action: BudgetAction.STOP,
        reason: `budget ${fillPercentage}% full`,
        fillPercentage,
      };
    }

    return {
      action: BudgetAction.CONTINUE,
      nudgeMessage: `Stopped at ${fillPercentage}% of token target (${params.turnTokens} / ${this.config.totalBudget}). Keep working — do not summarize.`,
      fillPercentage,
    };
  }

  reset(): void {
    this.continuationCount = 0;
    this.deltas = [];
    this.lastTurnTokens = 0;
  }

  getStats(): { continuations: number; totalDelta: number; lastDelta: number } {
    return {
      continuations: this.continuationCount,
      totalDelta: this.deltas.reduce((sum, d) => sum + d, 0),
      lastDelta: this.deltas[this.deltas.length - 1] ?? 0,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/token-budget-tracker.spec.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/token-budget-tracker.ts src/main/context/token-budget-tracker.spec.ts
git commit -m "feat(context): add token budget tracker with diminishing returns detection"
```

---

### Task 4: Compaction Epoch Tracking

**Files:**
- Create: `src/main/context/compaction-epoch.ts`
- Create: `src/main/context/compaction-epoch.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/compaction-epoch.spec.ts
import { describe, it, expect } from 'vitest';
import { CompactionEpochTracker } from './compaction-epoch';

describe('CompactionEpochTracker', () => {
  it('starts with epoch 0 and turnCount 0', () => {
    const tracker = new CompactionEpochTracker();
    expect(tracker.getCurrentEpoch().epochId).toBeDefined();
    expect(tracker.getCurrentEpoch().turnCount).toBe(0);
  });

  it('increments turn count', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();
    expect(tracker.getCurrentEpoch().turnCount).toBe(2);
  });

  it('resets turn count and creates new epoch ID on compaction', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();

    const oldEpochId = tracker.getCurrentEpoch().epochId;
    tracker.onCompaction();

    expect(tracker.getCurrentEpoch().turnCount).toBe(0);
    expect(tracker.getCurrentEpoch().epochId).not.toBe(oldEpochId);
  });

  it('records compaction history', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.onCompaction();

    tracker.incrementTurn();
    tracker.onCompaction();

    const history = tracker.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].turnsBeforeCompaction).toBe(3);
    expect(history[1].turnsBeforeCompaction).toBe(1);
  });

  it('computes average turns between compactions', () => {
    const tracker = new CompactionEpochTracker();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.onCompaction(); // 2 turns

    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.incrementTurn();
    tracker.onCompaction(); // 4 turns

    expect(tracker.getAverageTurnsBetweenCompactions()).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/compaction-epoch.spec.ts`
Expected: FAIL with "Cannot find module './compaction-epoch'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/compaction-epoch.ts
/**
 * Compaction Epoch Tracker
 *
 * Tracks turn IDs and turn counts across compaction boundaries.
 * Each compaction resets the turn counter and creates a new epoch.
 * History enables tuning compaction thresholds based on actual usage.
 *
 * Inspired by Claude Code's AutoCompactTrackingState.
 */

import { randomBytes } from 'crypto';

export interface CompactionEpoch {
  epochId: string;
  turnCount: number;
  startedAt: number;
}

export interface CompactionRecord {
  epochId: string;
  turnsBeforeCompaction: number;
  timestamp: number;
}

const MAX_HISTORY = 100;

export class CompactionEpochTracker {
  private currentEpoch: CompactionEpoch;
  private history: CompactionRecord[] = [];

  constructor() {
    this.currentEpoch = {
      epochId: this.generateId(),
      turnCount: 0,
      startedAt: Date.now(),
    };
  }

  getCurrentEpoch(): CompactionEpoch {
    return { ...this.currentEpoch };
  }

  incrementTurn(): void {
    this.currentEpoch.turnCount++;
  }

  onCompaction(): void {
    // Record the completed epoch
    this.history.push({
      epochId: this.currentEpoch.epochId,
      turnsBeforeCompaction: this.currentEpoch.turnCount,
      timestamp: Date.now(),
    });

    // Trim history
    if (this.history.length > MAX_HISTORY) {
      this.history = this.history.slice(-MAX_HISTORY);
    }

    // Start new epoch
    this.currentEpoch = {
      epochId: this.generateId(),
      turnCount: 0,
      startedAt: Date.now(),
    };
  }

  getHistory(): CompactionRecord[] {
    return [...this.history];
  }

  getAverageTurnsBetweenCompactions(): number {
    if (this.history.length === 0) return 0;
    const total = this.history.reduce((sum, r) => sum + r.turnsBeforeCompaction, 0);
    return Math.round(total / this.history.length);
  }

  private generateId(): string {
    return randomBytes(8).toString('base64url');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/compaction-epoch.spec.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/compaction-epoch.ts src/main/context/compaction-epoch.spec.ts
git commit -m "feat(context): add compaction epoch tracker for turn-ID analytics"
```

---

### Task 5: Integrate into Compaction Pipeline

**Files:**
- Modify: `src/main/context/context-compactor.ts`
- Modify: `src/main/context/compaction-coordinator.ts`
- Modify: `src/main/context/index.ts`

- [ ] **Step 1: Add microcompact + collapse imports to context-compactor.ts**

At the top of `src/main/context/context-compactor.ts`, add:

```typescript
import { Microcompact, type MicrocompactTurn } from './microcompact';
import { ContextCollapse, type CollapsibleTurn } from './context-collapse';
```

Add instance fields after the `compactionInProgress` field (around line 109):

```typescript
  private microcompact = new Microcompact();
  private contextCollapse = new ContextCollapse();
```

- [ ] **Step 2: Add new compact pipeline method**

Add this method to `ContextCompactor` class after the existing `compact()` method:

```typescript
  /**
   * Layered compaction pipeline (inspired by Claude Code):
   * 1. Microcompact — surgical tool output removal (cheapest)
   * 2. Context collapse — read-time projection (cheap)
   * 3. Prune tool outputs — existing pruneToolOutputs()
   * 4. Full summarization — existing summarize (most expensive)
   *
   * Returns after the first stage that brings usage below threshold.
   */
  async compactLayered(): Promise<CompactionResult & { stage: string }> {
    this.metrics.attempts++;
    const originalTokens = this.state.totalTokens;

    // Stage 1: Microcompact
    const mcTurns: MicrocompactTurn[] = this.state.turns.map(t => ({
      id: t.id,
      role: t.role,
      content: t.content,
      tokenCount: t.tokenCount,
      timestamp: t.timestamp,
      toolCalls: t.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        input: tc.input,
        output: tc.output,
        inputTokens: tc.inputTokens,
        outputTokens: tc.outputTokens,
      })),
    }));

    const mcResult = this.microcompact.compact(mcTurns);
    if (!mcResult.skipped && mcResult.tokensSaved > 0) {
      this.applyMicrocompactResult(mcResult);
      this.updateFillRatio();

      if (!this.shouldCompact()) {
        this.metrics.successes++;
        this.metrics.totalTokensSaved += mcResult.tokensSaved;
        return this.buildResult(originalTokens, 'microcompact');
      }
    }

    // Stage 2: Context Collapse
    const collapseTurns: CollapsibleTurn[] = this.state.turns.map(t => ({
      id: t.id,
      role: t.role,
      content: t.content,
      tokenCount: t.tokenCount,
      timestamp: t.timestamp,
      collapsible: true,
      toolCalls: t.toolCalls?.map(tc => ({ name: tc.name, id: tc.id })),
    }));

    const staged = this.contextCollapse.stageCollapses(collapseTurns);
    if (staged.collapsedTurnIds.length > 0) {
      const applied = this.contextCollapse.applyCollapses(collapseTurns, staged);
      this.applyCollapseResult(applied);
      this.updateFillRatio();

      if (!this.shouldCompact()) {
        this.metrics.successes++;
        this.metrics.totalTokensSaved += applied.tokensSaved;
        return this.buildResult(originalTokens, 'context_collapse');
      }
    }

    // Stage 3 + 4: Existing prune + summarize
    const result = await this.compact();
    return { ...result, stage: 'full_compact' };
  }

  private applyMicrocompactResult(mcResult: import('./microcompact').MicrocompactResult): void {
    // Update turns in-place with compacted tool outputs
    for (let i = 0; i < this.state.turns.length && i < mcResult.turns.length; i++) {
      const turn = this.state.turns[i];
      const mcTurn = mcResult.turns[i];
      if (turn.toolCalls && mcTurn.toolCalls) {
        for (let j = 0; j < turn.toolCalls.length; j++) {
          if (mcTurn.toolCalls[j]) {
            turn.toolCalls[j].output = mcTurn.toolCalls[j].output;
            turn.toolCalls[j].outputTokens = mcTurn.toolCalls[j].outputTokens;
          }
        }
      }
      turn.tokenCount = mcTurn.tokenCount;
    }
    this.state.totalTokens -= mcResult.tokensSaved;
  }

  private applyCollapseResult(result: import('./context-collapse').ApplyResult): void {
    for (let i = 0; i < this.state.turns.length && i < result.turns.length; i++) {
      this.state.turns[i].content = result.turns[i].content;
      this.state.turns[i].tokenCount = result.turns[i].tokenCount;
      this.state.turns[i].toolCalls = undefined;
    }
    this.state.totalTokens -= result.tokensSaved;
  }

  private buildResult(originalTokens: number, stage: string): CompactionResult & { stage: string } {
    const result: CompactionResult & { stage: string } = {
      originalTokens,
      compactedTokens: this.state.totalTokens,
      reductionRatio: 1 - (this.state.totalTokens / originalTokens),
      turnsRemoved: 0,
      turnsPreserved: this.state.turns.length,
      summaryGenerated: false,
      timestamp: Date.now(),
      stage,
    };
    this.recordCompaction(result);
    return result;
  }
```

- [ ] **Step 3: Add budget tracker import and epoch wiring to compaction-coordinator.ts**

In `src/main/context/compaction-coordinator.ts`, add imports and wire budget + epoch tracking:

```typescript
import { TokenBudgetTracker } from './token-budget-tracker';
import { CompactionEpochTracker } from './compaction-epoch';
```

Add fields to the class:

```typescript
  private budgetTrackers = new Map<string, TokenBudgetTracker>();
  private epochTrackers = new Map<string, CompactionEpochTracker>();
```

Add helper methods:

```typescript
  getBudgetTracker(instanceId: string, totalBudget = 200000): TokenBudgetTracker {
    let tracker = this.budgetTrackers.get(instanceId);
    if (!tracker) {
      tracker = new TokenBudgetTracker({ totalBudget });
      this.budgetTrackers.set(instanceId, tracker);
    }
    return tracker;
  }

  getEpochTracker(instanceId: string): CompactionEpochTracker {
    let tracker = this.epochTrackers.get(instanceId);
    if (!tracker) {
      tracker = new CompactionEpochTracker();
      this.epochTrackers.set(instanceId, tracker);
    }
    return tracker;
  }
```

- [ ] **Step 4: Update index.ts exports**

```typescript
// Append to src/main/context/index.ts:
export { Microcompact, type MicrocompactConfig, type MicrocompactResult } from './microcompact';
export { ContextCollapse, type ContextCollapseConfig, type CollapsibleTurn } from './context-collapse';
export { TokenBudgetTracker, BudgetAction, type BudgetCheckResult, type TokenBudgetConfig } from './token-budget-tracker';
export { CompactionEpochTracker, type CompactionEpoch, type CompactionRecord } from './compaction-epoch';
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run src/main/context/`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/main/context/
git commit -m "feat(context): integrate layered compaction pipeline with budget tracking and epoch analytics"
```
