# Error Recovery & Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add error withholding with multi-stage recovery (context collapse → reactive compact → max-output-tokens escalation → continuation injection) and orphaned message cleanup on provider failover — inspired by Claude Code's layered error recovery in query.ts.

**Architecture:** A new `ErrorWithholder` intercepts API errors and attempts layered recovery before surfacing to the user. A `MaxOutputTokensEscalator` retries with progressively larger output budgets. A `ContinuationInjector` creates seamless continuation messages for truncated output. The existing `FailoverManager` gets enhanced with orphaned message cleanup.

**Tech Stack:** TypeScript, Node.js EventEmitter, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/main/context/error-withholder.ts` | Intercept recoverable errors and attempt recovery |
| Create | `src/main/context/error-withholder.spec.ts` | Tests for error withholder |
| Create | `src/main/context/output-token-escalator.ts` | Max-output-tokens escalation logic |
| Create | `src/main/context/output-token-escalator.spec.ts` | Tests for escalator |
| Create | `src/main/context/continuation-injector.ts` | Seamless continuation after truncation |
| Create | `src/main/context/continuation-injector.spec.ts` | Tests for continuation injector |
| Create | `src/main/instance/orphaned-message-cleaner.ts` | Tombstone stale messages on failover |
| Create | `src/main/instance/orphaned-message-cleaner.spec.ts` | Tests for orphaned cleaner |
| Modify | `src/main/providers/failover-manager.ts` | Integrate orphaned message cleanup |

---

### Task 1: Output Token Escalator

**Files:**
- Create: `src/main/context/output-token-escalator.ts`
- Create: `src/main/context/output-token-escalator.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/output-token-escalator.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { OutputTokenEscalator } from './output-token-escalator';

describe('OutputTokenEscalator', () => {
  let escalator: OutputTokenEscalator;

  beforeEach(() => {
    escalator = new OutputTokenEscalator({
      defaultTokens: 8192,
      maxTokens: 65536,
      maxRecoveryAttempts: 3,
    });
  });

  it('returns default tokens initially', () => {
    expect(escalator.getCurrentLimit()).toBe(8192);
  });

  it('escalates to max on first truncation', () => {
    const result = escalator.onTruncation();
    expect(result.shouldRetry).toBe(true);
    expect(result.newLimit).toBe(65536);
    expect(escalator.getCurrentLimit()).toBe(65536);
  });

  it('allows multi-turn recovery up to max attempts', () => {
    // First escalation
    escalator.onTruncation();

    // Multi-turn recovery attempts
    const r1 = escalator.onMultiTurnTruncation();
    expect(r1.shouldRetry).toBe(true);
    expect(r1.attemptNumber).toBe(1);

    const r2 = escalator.onMultiTurnTruncation();
    expect(r2.shouldRetry).toBe(true);
    expect(r2.attemptNumber).toBe(2);

    const r3 = escalator.onMultiTurnTruncation();
    expect(r3.shouldRetry).toBe(true);
    expect(r3.attemptNumber).toBe(3);

    const r4 = escalator.onMultiTurnTruncation();
    expect(r4.shouldRetry).toBe(false);
    expect(r4.exhausted).toBe(true);
  });

  it('resets recovery count on successful turn', () => {
    escalator.onTruncation();
    escalator.onMultiTurnTruncation();
    escalator.onMultiTurnTruncation();

    escalator.onSuccessfulTurn();
    expect(escalator.getRecoveryCount()).toBe(0);
  });

  it('does not escalate if already at max', () => {
    escalator.onTruncation();
    const secondResult = escalator.onTruncation();
    // Already at max — goes straight to multi-turn recovery
    expect(secondResult.alreadyEscalated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/output-token-escalator.spec.ts`
Expected: FAIL with "Cannot find module './output-token-escalator'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/output-token-escalator.ts
/**
 * Output Token Escalator
 *
 * Implements Claude Code's max-output-tokens escalation strategy:
 * - Start with conservative default (8k)
 * - On first truncation: escalate to max (64k)
 * - On continued truncation: inject continuation messages (up to 3 attempts)
 * - On successful turn: reset recovery count
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('OutputTokenEscalator');

export interface EscalatorConfig {
  defaultTokens: number;
  maxTokens: number;
  maxRecoveryAttempts: number;
}

export interface EscalationResult {
  shouldRetry: boolean;
  newLimit?: number;
  attemptNumber?: number;
  alreadyEscalated?: boolean;
  exhausted?: boolean;
}

const DEFAULT_CONFIG: EscalatorConfig = {
  defaultTokens: 8192,
  maxTokens: 65536,
  maxRecoveryAttempts: 3,
};

export class OutputTokenEscalator {
  private config: EscalatorConfig;
  private currentLimit: number;
  private escalated = false;
  private recoveryCount = 0;

  constructor(config?: Partial<EscalatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentLimit = this.config.defaultTokens;
  }

  getCurrentLimit(): number {
    return this.currentLimit;
  }

  getRecoveryCount(): number {
    return this.recoveryCount;
  }

  /**
   * Called when output was truncated at current limit.
   * First call escalates to max; subsequent calls signal multi-turn recovery.
   */
  onTruncation(): EscalationResult {
    if (!this.escalated) {
      this.currentLimit = this.config.maxTokens;
      this.escalated = true;
      logger.info('Escalated output token limit', {
        from: this.config.defaultTokens,
        to: this.config.maxTokens,
      });
      return { shouldRetry: true, newLimit: this.config.maxTokens };
    }

    return { shouldRetry: false, alreadyEscalated: true };
  }

  /**
   * Called when output is truncated even at max limit.
   * Allows up to maxRecoveryAttempts continuation injections.
   */
  onMultiTurnTruncation(): EscalationResult {
    this.recoveryCount++;

    if (this.recoveryCount <= this.config.maxRecoveryAttempts) {
      logger.info('Multi-turn truncation recovery', {
        attempt: this.recoveryCount,
        maxAttempts: this.config.maxRecoveryAttempts,
      });
      return {
        shouldRetry: true,
        attemptNumber: this.recoveryCount,
      };
    }

    logger.warn('Multi-turn recovery exhausted', {
      attempts: this.recoveryCount,
    });
    return { shouldRetry: false, exhausted: true };
  }

  /**
   * Called after a successful (non-truncated) turn.
   * Resets recovery count but keeps escalated limit.
   */
  onSuccessfulTurn(): void {
    this.recoveryCount = 0;
  }

  /**
   * Full reset (e.g., on session restart).
   */
  reset(): void {
    this.currentLimit = this.config.defaultTokens;
    this.escalated = false;
    this.recoveryCount = 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/output-token-escalator.spec.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/output-token-escalator.ts src/main/context/output-token-escalator.spec.ts
git commit -m "feat(context): add output token escalator for max-output-tokens recovery"
```

---

### Task 2: Continuation Injector

**Files:**
- Create: `src/main/context/continuation-injector.ts`
- Create: `src/main/context/continuation-injector.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/continuation-injector.spec.ts
import { describe, it, expect } from 'vitest';
import { ContinuationInjector, type ConversationMessage } from './continuation-injector';

describe('ContinuationInjector', () => {
  it('creates a continuation message for truncated output', () => {
    const injector = new ContinuationInjector();
    const truncatedMessages: ConversationMessage[] = [
      { role: 'user', content: 'Write a long essay' },
      { role: 'assistant', content: 'Here is the beginning of the essay...' },
    ];

    const continuation = injector.createContinuation(truncatedMessages);
    expect(continuation.role).toBe('user');
    expect(continuation.content).toContain('Resume');
    expect(continuation.content).toContain('no apology');
    expect(continuation.content).toContain('no recap');
    expect(continuation.metadata?.isContinuation).toBe(true);
  });

  it('adds attempt number for multi-turn recovery', () => {
    const injector = new ContinuationInjector();
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Write code' },
      { role: 'assistant', content: 'function...' },
    ];

    const continuation = injector.createContinuation(messages, { attemptNumber: 2 });
    expect(continuation.metadata?.attemptNumber).toBe(2);
  });

  it('includes context hint from truncated output', () => {
    const injector = new ContinuationInjector();
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Write a function' },
      { role: 'assistant', content: 'Here is the code:\n```typescript\nfunction hello() {\n  console.log("' },
    ];

    const continuation = injector.createContinuation(messages);
    // Should include tail of truncated output as context
    expect(continuation.content).toContain('console.log');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/continuation-injector.spec.ts`
Expected: FAIL with "Cannot find module './continuation-injector'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/continuation-injector.ts
/**
 * Continuation Injector
 *
 * Creates seamless continuation messages when model output is truncated.
 * The injected message tells the model to resume directly without
 * apology, recap, or context repetition.
 *
 * Inspired by Claude Code's max-output-tokens recovery injection:
 * "Output token limit hit. Resume directly — no apology, no recap..."
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('ContinuationInjector');

/** How many characters of truncated output to include as context hint */
const CONTEXT_TAIL_LENGTH = 200;

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ContinuationOptions {
  attemptNumber?: number;
}

export class ContinuationInjector {
  /**
   * Create a continuation message to inject after truncated output.
   */
  createContinuation(
    messages: ConversationMessage[],
    options?: ContinuationOptions
  ): ConversationMessage {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const contextTail = lastAssistant
      ? lastAssistant.content.slice(-CONTEXT_TAIL_LENGTH)
      : '';

    const parts: string[] = [
      'Output token limit hit. Resume directly from where you left off — no apology, no recap, no repeating what was already said.',
    ];

    if (contextTail) {
      parts.push(`\nYou stopped at: ...${contextTail}`);
    }

    parts.push('\nContinue immediately.');

    logger.info('Created continuation message', {
      attemptNumber: options?.attemptNumber,
      contextTailLength: contextTail.length,
    });

    return {
      role: 'user',
      content: parts.join(''),
      metadata: {
        isContinuation: true,
        attemptNumber: options?.attemptNumber,
        injectedAt: Date.now(),
      },
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/continuation-injector.spec.ts`
Expected: PASS — all 3 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/continuation-injector.ts src/main/context/continuation-injector.spec.ts
git commit -m "feat(context): add continuation injector for truncated output recovery"
```

---

### Task 3: Error Withholder — Multi-Stage Recovery Orchestrator

**Files:**
- Create: `src/main/context/error-withholder.ts`
- Create: `src/main/context/error-withholder.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/context/error-withholder.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorWithholder, RecoveryOutcome, type RecoveryResult } from './error-withholder';

describe('ErrorWithholder', () => {
  let withholder: ErrorWithholder;
  let mockCollapseRecover: ReturnType<typeof vi.fn>;
  let mockReactiveCompact: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCollapseRecover = vi.fn(async () => ({ success: true, tokensSaved: 5000 }));
    mockReactiveCompact = vi.fn(async () => ({ success: true, tokensSaved: 20000 }));

    withholder = new ErrorWithholder({
      collapseRecovery: mockCollapseRecover,
      reactiveCompact: mockReactiveCompact,
    });
  });

  it('attempts collapse recovery first for prompt-too-long', async () => {
    const result = await withholder.handlePromptTooLong();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.stage).toBe('context_collapse');
    expect(mockCollapseRecover).toHaveBeenCalledOnce();
    expect(mockReactiveCompact).not.toHaveBeenCalled();
  });

  it('falls back to reactive compact when collapse fails', async () => {
    mockCollapseRecover.mockResolvedValueOnce({ success: false });

    const result = await withholder.handlePromptTooLong();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.stage).toBe('reactive_compact');
    expect(mockReactiveCompact).toHaveBeenCalledOnce();
  });

  it('surfaces error when all recovery fails', async () => {
    mockCollapseRecover.mockResolvedValueOnce({ success: false });
    mockReactiveCompact.mockResolvedValueOnce({ success: false });

    const result = await withholder.handlePromptTooLong();
    expect(result.outcome).toBe(RecoveryOutcome.FAILED);
    expect(result.stage).toBe('exhausted');
  });

  it('prevents re-attempting reactive compact', async () => {
    mockCollapseRecover.mockResolvedValue({ success: false });
    mockReactiveCompact.mockResolvedValueOnce({ success: true, tokensSaved: 10000 });

    // First attempt — reactive compact works
    await withholder.handlePromptTooLong();

    // Second attempt — reactive compact already used
    mockReactiveCompact.mockResolvedValueOnce({ success: true, tokensSaved: 5000 });
    const result = await withholder.handlePromptTooLong();

    // Should NOT re-attempt reactive compact
    expect(result.outcome).toBe(RecoveryOutcome.FAILED);
  });

  it('handles max-output-tokens with escalation', async () => {
    const result = await withholder.handleMaxOutputTokens();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.newOutputLimit).toBe(65536);
  });

  it('handles repeated max-output-tokens with continuation injection', async () => {
    // First: escalation
    await withholder.handleMaxOutputTokens();

    // Second: continuation
    const result = await withholder.handleMaxOutputTokens();
    expect(result.outcome).toBe(RecoveryOutcome.RECOVERED);
    expect(result.continuationNeeded).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/context/error-withholder.spec.ts`
Expected: FAIL with "Cannot find module './error-withholder'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/context/error-withholder.ts
/**
 * Error Withholder
 *
 * Intercepts recoverable API errors and attempts layered recovery
 * BEFORE surfacing the error to the user. The error is "withheld"
 * during recovery attempts.
 *
 * Inspired by Claude Code's error withholding pattern in query.ts:
 * - prompt-too-long → context collapse → reactive compact → surface
 * - max-output-tokens → escalate → continuation injection → surface
 */

import { EventEmitter } from 'events';
import { OutputTokenEscalator } from './output-token-escalator';
import { getLogger } from '../logging/logger';

const logger = getLogger('ErrorWithholder');

export enum RecoveryOutcome {
  RECOVERED = 'recovered',
  FAILED = 'failed',
}

export interface RecoveryResult {
  outcome: RecoveryOutcome;
  stage: string;
  tokensSaved?: number;
  newOutputLimit?: number;
  continuationNeeded?: boolean;
}

export interface RecoveryStrategy {
  collapseRecovery: () => Promise<{ success: boolean; tokensSaved?: number }>;
  reactiveCompact: () => Promise<{ success: boolean; tokensSaved?: number }>;
}

export class ErrorWithholder extends EventEmitter {
  private strategies: RecoveryStrategy;
  private hasAttemptedReactiveCompact = false;
  private escalator = new OutputTokenEscalator();

  constructor(strategies: RecoveryStrategy) {
    super();
    this.strategies = strategies;
  }

  /**
   * Handle prompt-too-long (413) error.
   * Attempts recovery in order: collapse → reactive compact → fail.
   */
  async handlePromptTooLong(): Promise<RecoveryResult> {
    this.emit('error:withheld', { type: 'prompt_too_long' });

    // Stage 1: Context collapse recovery (cheapest)
    try {
      const collapseResult = await this.strategies.collapseRecovery();
      if (collapseResult.success) {
        logger.info('Recovered from prompt-too-long via context collapse', {
          tokensSaved: collapseResult.tokensSaved,
        });
        this.emit('recovery:succeeded', { stage: 'context_collapse' });
        return {
          outcome: RecoveryOutcome.RECOVERED,
          stage: 'context_collapse',
          tokensSaved: collapseResult.tokensSaved,
        };
      }
    } catch (err) {
      logger.warn('Context collapse recovery failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Stage 2: Reactive compact (one-shot guard)
    if (!this.hasAttemptedReactiveCompact) {
      this.hasAttemptedReactiveCompact = true;
      try {
        const compactResult = await this.strategies.reactiveCompact();
        if (compactResult.success) {
          logger.info('Recovered from prompt-too-long via reactive compact', {
            tokensSaved: compactResult.tokensSaved,
          });
          this.emit('recovery:succeeded', { stage: 'reactive_compact' });
          return {
            outcome: RecoveryOutcome.RECOVERED,
            stage: 'reactive_compact',
            tokensSaved: compactResult.tokensSaved,
          };
        }
      } catch (err) {
        logger.warn('Reactive compact recovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // All recovery exhausted
    logger.error('All prompt-too-long recovery strategies exhausted');
    this.emit('recovery:failed', { type: 'prompt_too_long' });
    return { outcome: RecoveryOutcome.FAILED, stage: 'exhausted' };
  }

  /**
   * Handle max-output-tokens truncation.
   * Attempts: escalation → continuation injection → fail.
   */
  async handleMaxOutputTokens(): Promise<RecoveryResult> {
    this.emit('error:withheld', { type: 'max_output_tokens' });

    // Try escalation first
    const escalation = this.escalator.onTruncation();
    if (escalation.shouldRetry && escalation.newLimit) {
      logger.info('Escalated max output tokens', { newLimit: escalation.newLimit });
      return {
        outcome: RecoveryOutcome.RECOVERED,
        stage: 'escalation',
        newOutputLimit: escalation.newLimit,
      };
    }

    // Already escalated — try multi-turn continuation
    const multiTurn = this.escalator.onMultiTurnTruncation();
    if (multiTurn.shouldRetry) {
      logger.info('Multi-turn continuation recovery', { attempt: multiTurn.attemptNumber });
      return {
        outcome: RecoveryOutcome.RECOVERED,
        stage: 'continuation',
        continuationNeeded: true,
      };
    }

    logger.error('Max output tokens recovery exhausted');
    this.emit('recovery:failed', { type: 'max_output_tokens' });
    return { outcome: RecoveryOutcome.FAILED, stage: 'exhausted' };
  }

  /**
   * Call after a successful (non-error) turn to reset recovery state.
   */
  onSuccessfulTurn(): void {
    this.escalator.onSuccessfulTurn();
  }

  /**
   * Full reset for new session.
   */
  reset(): void {
    this.hasAttemptedReactiveCompact = false;
    this.escalator.reset();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/context/error-withholder.spec.ts`
Expected: PASS — all 6 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/context/error-withholder.ts src/main/context/error-withholder.spec.ts
git commit -m "feat(context): add error withholder for multi-stage API error recovery"
```

---

### Task 4: Orphaned Message Cleaner

**Files:**
- Create: `src/main/instance/orphaned-message-cleaner.ts`
- Create: `src/main/instance/orphaned-message-cleaner.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/instance/orphaned-message-cleaner.spec.ts
import { describe, it, expect } from 'vitest';
import { OrphanedMessageCleaner, type CleanableMessage } from './orphaned-message-cleaner';

describe('OrphanedMessageCleaner', () => {
  it('tombstones incomplete assistant messages', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'user', content: 'Hello', complete: true },
      { id: '2', role: 'assistant', content: 'I will help you with...', complete: false },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanOnFailover(messages, { failedProvider: 'claude-cli' });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].tombstoned).toBe(true);
    expect(result.messages[1].content).toContain('[Response interrupted');
    expect(result.tombstonedCount).toBe(1);
  });

  it('preserves complete messages', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'user', content: 'Hello', complete: true },
      { id: '2', role: 'assistant', content: 'Hi there!', complete: true },
      { id: '3', role: 'user', content: 'Help me', complete: true },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanOnFailover(messages, { failedProvider: 'claude-cli' });
    expect(result.tombstonedCount).toBe(0);
  });

  it('removes orphaned tool_result messages without matching tool_use', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'user', content: 'Run ls', complete: true },
      { id: '2', role: 'assistant', content: '', complete: false, toolUseId: 'tu-1' },
      { id: '3', role: 'tool', content: 'file1\nfile2', complete: true, toolUseId: 'tu-1' },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanOnFailover(messages, { failedProvider: 'claude-cli' });

    // Both assistant (incomplete) and orphaned tool result should be tombstoned
    expect(result.tombstonedCount).toBe(2);
  });

  it('strips signature blocks from cached-thinking models', () => {
    const messages: CleanableMessage[] = [
      { id: '1', role: 'assistant', content: 'Response\n<signature>abc123</signature>', complete: true },
    ];

    const cleaner = new OrphanedMessageCleaner();
    const result = cleaner.cleanForFallbackModel(messages);
    expect(result.messages[0].content).not.toContain('<signature>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/orphaned-message-cleaner.spec.ts`
Expected: FAIL with "Cannot find module './orphaned-message-cleaner'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/instance/orphaned-message-cleaner.ts
/**
 * Orphaned Message Cleaner
 *
 * Cleans up stale/incomplete messages when switching providers during failover.
 * Prevents the fallback model from being confused by partial responses
 * from the failed model.
 *
 * Inspired by Claude Code's model fallback message cleanup:
 * - Tombstone incomplete assistant messages
 * - Remove orphaned tool_result blocks
 * - Strip signature blocks from cached-thinking models
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('OrphanedMessageCleaner');

export interface CleanableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  complete: boolean;
  toolUseId?: string;
  tombstoned?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FailoverContext {
  failedProvider: string;
}

export interface CleanResult {
  messages: CleanableMessage[];
  tombstonedCount: number;
}

const SIGNATURE_PATTERN = /<signature>[\s\S]*?<\/signature>/g;

export class OrphanedMessageCleaner {
  /**
   * Clean messages for failover to a different provider.
   * Tombstones incomplete messages and orphaned tool results.
   */
  cleanOnFailover(messages: CleanableMessage[], ctx: FailoverContext): CleanResult {
    const result = messages.map(m => ({ ...m }));
    let tombstonedCount = 0;

    // Pass 1: Tombstone incomplete assistant messages
    const tombstonedToolUseIds = new Set<string>();
    for (const msg of result) {
      if (msg.role === 'assistant' && !msg.complete) {
        msg.tombstoned = true;
        msg.content = `[Response interrupted — provider ${ctx.failedProvider} failed. Switching provider.]`;
        tombstonedCount++;

        if (msg.toolUseId) {
          tombstonedToolUseIds.add(msg.toolUseId);
        }
      }
    }

    // Pass 2: Tombstone orphaned tool results (tool_use was tombstoned)
    for (const msg of result) {
      if (msg.role === 'tool' && msg.toolUseId && tombstonedToolUseIds.has(msg.toolUseId)) {
        msg.tombstoned = true;
        msg.content = '[Tool result orphaned — associated tool_use was interrupted]';
        tombstonedCount++;
      }
    }

    if (tombstonedCount > 0) {
      logger.info('Cleaned orphaned messages on failover', {
        tombstonedCount,
        failedProvider: ctx.failedProvider,
      });
    }

    return { messages: result, tombstonedCount };
  }

  /**
   * Clean messages for a fallback model that doesn't support
   * cached-thinking signature blocks.
   */
  cleanForFallbackModel(messages: CleanableMessage[]): CleanResult {
    let strippedCount = 0;
    const result = messages.map(msg => {
      if (msg.role === 'assistant' && SIGNATURE_PATTERN.test(msg.content)) {
        strippedCount++;
        return {
          ...msg,
          content: msg.content.replace(SIGNATURE_PATTERN, '').trim(),
        };
      }
      return { ...msg };
    });

    if (strippedCount > 0) {
      logger.info('Stripped signature blocks for fallback model', { strippedCount });
    }

    return { messages: result, tombstonedCount: strippedCount };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/instance/orphaned-message-cleaner.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/orphaned-message-cleaner.ts src/main/instance/orphaned-message-cleaner.spec.ts
git commit -m "feat(instance): add orphaned message cleaner for failover resilience"
```

---

### Task 5: Wire into Exports

**Files:**
- Modify: `src/main/context/index.ts`

- [ ] **Step 1: Add exports for new error recovery modules**

Append to `src/main/context/index.ts`:

```typescript
export { ErrorWithholder, RecoveryOutcome, type RecoveryResult, type RecoveryStrategy } from './error-withholder';
export { OutputTokenEscalator, type EscalatorConfig, type EscalationResult } from './output-token-escalator';
export { ContinuationInjector, type ConversationMessage } from './continuation-injector';
```

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/context/index.ts
git commit -m "feat(context): export error recovery modules"
```
