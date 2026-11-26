# Streaming Tool Executor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the synchronous child-process tool execution with a streaming, concurrency-aware executor that supports parallel tool calls, progress streaming, sibling abort cascading, error classification, pre-model tool filtering, and async tool-use summaries — modeled after Claude Code's StreamingToolExecutor.

**Architecture:** A new `StreamingToolExecutor` class manages concurrent tool execution with safety metadata per tool. Tools marked `concurrencySafe` run in parallel; others run exclusively. Progress messages stream in real-time via EventEmitter. Sibling errors cascade-cancel related tools. A `ToolErrorClassifier` categorizes errors for telemetry. A `ToolListFilter` removes denied tools before model prompt construction. An async `ToolUseSummarizer` generates cheap summaries during model streaming time.

**Tech Stack:** TypeScript, Node.js EventEmitter, AbortController, Zod 4, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/main/tools/streaming-tool-executor.ts` | Concurrent tool execution with progress streaming |
| Create | `src/main/tools/streaming-tool-executor.spec.ts` | Tests for streaming executor |
| Create | `src/main/tools/tool-error-classifier.ts` | Error classification for telemetry safety |
| Create | `src/main/tools/tool-error-classifier.spec.ts` | Tests for error classifier |
| Create | `src/main/tools/tool-list-filter.ts` | Pre-model tool filtering by deny rules |
| Create | `src/main/tools/tool-list-filter.spec.ts` | Tests for tool list filter |
| Create | `src/main/tools/tool-use-summarizer.ts` | Async tool-use summary generation |
| Create | `src/main/tools/tool-use-summarizer.spec.ts` | Tests for summarizer |
| Modify | `src/main/tools/tool-registry.ts` | Add concurrency metadata, integrate executor |
| Modify | `src/main/tools/tool-runner-child.ts` | Add progress message support |
| Modify | `src/main/tools/index.ts` | Export new modules |

---

### Task 1: Tool Error Classifier

**Files:**
- Create: `src/main/tools/tool-error-classifier.ts`
- Create: `src/main/tools/tool-error-classifier.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/tools/tool-error-classifier.spec.ts
import { describe, it, expect } from 'vitest';
import {
  classifyToolError,
  ToolErrorCategory,
} from './tool-error-classifier';

describe('classifyToolError', () => {
  it('classifies ENOENT as filesystem error', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.FILESYSTEM);
    expect(result.code).toBe('ENOENT');
    expect(result.telemetrySafe).toBe(true);
    expect(result.telemetryMessage).toBe('ENOENT');
  });

  it('classifies EACCES as permission error', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.PERMISSION);
    expect(result.code).toBe('EACCES');
    expect(result.telemetrySafe).toBe(true);
  });

  it('classifies timeout errors', () => {
    const err = new Error('Tool execution timed out');
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.TIMEOUT);
    expect(result.telemetrySafe).toBe(true);
  });

  it('classifies Zod validation errors', () => {
    const err = new Error('Invalid tool arguments');
    (err as any).name = 'ZodError';
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.VALIDATION);
    expect(result.telemetrySafe).toBe(true);
  });

  it('classifies unknown errors without leaking user data', () => {
    const err = new Error('Something with /Users/secret/path broke');
    const result = classifyToolError(err);
    expect(result.category).toBe(ToolErrorCategory.UNKNOWN);
    expect(result.telemetrySafe).toBe(true);
    expect(result.telemetryMessage).toBe('Error');
    // Original message preserved in non-telemetry field
    expect(result.originalMessage).toContain('/Users/secret/path');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/tools/tool-error-classifier.spec.ts`
Expected: FAIL with "Cannot find module './tool-error-classifier'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/tools/tool-error-classifier.ts
/**
 * Tool Error Classifier
 *
 * Classifies tool execution errors into telemetry-safe categories.
 * Inspired by Claude Code's classifyToolError() pattern:
 * - Never leak user data (file paths, content) to telemetry
 * - Categorize errors for aggregated metrics
 * - Preserve original message for local debugging
 */

export enum ToolErrorCategory {
  FILESYSTEM = 'filesystem',
  PERMISSION = 'permission',
  TIMEOUT = 'timeout',
  VALIDATION = 'validation',
  PROCESS = 'process',
  NETWORK = 'network',
  UNKNOWN = 'unknown',
}

export interface ClassifiedError {
  category: ToolErrorCategory;
  code?: string;
  /** Safe to send to telemetry (no user data) */
  telemetrySafe: boolean;
  /** Message safe for telemetry logging */
  telemetryMessage: string;
  /** Original error message (for local logs only) */
  originalMessage: string;
}

const FS_ERROR_CODES = new Set([
  'ENOENT', 'EACCES', 'EPERM', 'EEXIST', 'EISDIR', 'ENOTDIR',
  'EMFILE', 'ENFILE', 'ENOSPC', 'EROFS', 'EBUSY',
]);

const PERMISSION_CODES = new Set(['EACCES', 'EPERM']);

const NETWORK_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
]);

export function classifyToolError(error: unknown): ClassifiedError {
  const err = error instanceof Error ? error : new Error(String(error));
  const originalMessage = err.message;
  const code = (err as NodeJS.ErrnoException).code;
  const name = err.name || err.constructor?.name;

  // 1. Node.js filesystem errors (code property)
  if (code && PERMISSION_CODES.has(code)) {
    return {
      category: ToolErrorCategory.PERMISSION,
      code,
      telemetrySafe: true,
      telemetryMessage: code,
      originalMessage,
    };
  }

  if (code && FS_ERROR_CODES.has(code)) {
    return {
      category: ToolErrorCategory.FILESYSTEM,
      code,
      telemetrySafe: true,
      telemetryMessage: code,
      originalMessage,
    };
  }

  if (code && NETWORK_CODES.has(code)) {
    return {
      category: ToolErrorCategory.NETWORK,
      code,
      telemetrySafe: true,
      telemetryMessage: code,
      originalMessage,
    };
  }

  // 2. Timeout errors
  if (originalMessage.toLowerCase().includes('timed out') || originalMessage.toLowerCase().includes('timeout')) {
    return {
      category: ToolErrorCategory.TIMEOUT,
      telemetrySafe: true,
      telemetryMessage: 'timeout',
      originalMessage,
    };
  }

  // 3. Validation / Zod errors
  if (name === 'ZodError' || originalMessage.includes('Invalid tool arguments')) {
    return {
      category: ToolErrorCategory.VALIDATION,
      telemetrySafe: true,
      telemetryMessage: 'validation_error',
      originalMessage,
    };
  }

  // 4. Process errors
  if (originalMessage.includes('SIGKILL') || originalMessage.includes('SIGTERM') || originalMessage.includes('exited with code')) {
    return {
      category: ToolErrorCategory.PROCESS,
      telemetrySafe: true,
      telemetryMessage: 'process_error',
      originalMessage,
    };
  }

  // 5. Fallback: unknown — never leak user data
  return {
    category: ToolErrorCategory.UNKNOWN,
    telemetrySafe: true,
    telemetryMessage: 'Error',
    originalMessage,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/tools/tool-error-classifier.spec.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/tool-error-classifier.ts src/main/tools/tool-error-classifier.spec.ts
git commit -m "feat(tools): add tool error classifier for telemetry-safe error categorization"
```

---

### Task 2: Tool List Filter (Pre-Model Deny Rules)

**Files:**
- Create: `src/main/tools/tool-list-filter.ts`
- Create: `src/main/tools/tool-list-filter.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/tools/tool-list-filter.spec.ts
import { describe, it, expect } from 'vitest';
import { ToolListFilter, type DenyRule, type FilterableTool } from './tool-list-filter';

describe('ToolListFilter', () => {
  const tools: FilterableTool[] = [
    { id: 'bash', description: 'Run commands' },
    { id: 'read', description: 'Read files' },
    { id: 'write', description: 'Write files' },
    { id: 'mcp__server__action', description: 'MCP tool' },
    { id: 'mcp__server__query', description: 'MCP query' },
    { id: 'dangerous_delete', description: 'Delete everything' },
  ];

  it('filters tools by exact name deny rules', () => {
    const rules: DenyRule[] = [
      { pattern: 'dangerous_delete', type: 'blanket' },
    ];
    const filter = new ToolListFilter(rules);
    const result = filter.filterForModel(tools);
    expect(result.map(t => t.id)).not.toContain('dangerous_delete');
    expect(result).toHaveLength(5);
  });

  it('filters tools by prefix pattern (MCP server)', () => {
    const rules: DenyRule[] = [
      { pattern: 'mcp__server', type: 'blanket' },
    ];
    const filter = new ToolListFilter(rules);
    const result = filter.filterForModel(tools);
    expect(result.map(t => t.id)).not.toContain('mcp__server__action');
    expect(result.map(t => t.id)).not.toContain('mcp__server__query');
    expect(result).toHaveLength(4);
  });

  it('filters tools by glob pattern', () => {
    const rules: DenyRule[] = [
      { pattern: 'mcp__*', type: 'blanket' },
    ];
    const filter = new ToolListFilter(rules);
    const result = filter.filterForModel(tools);
    expect(result).toHaveLength(4);
  });

  it('returns all tools when no deny rules', () => {
    const filter = new ToolListFilter([]);
    const result = filter.filterForModel(tools);
    expect(result).toHaveLength(6);
  });

  it('supports runtime-deny rules (visible but blocked at execution)', () => {
    const rules: DenyRule[] = [
      { pattern: 'write', type: 'runtime' },
    ];
    const filter = new ToolListFilter(rules);
    const result = filter.filterForModel(tools);
    // Runtime deny keeps tool visible
    expect(result.map(t => t.id)).toContain('write');
    expect(filter.isRuntimeDenied('write')).toBe(true);
    expect(filter.isRuntimeDenied('read')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/tools/tool-list-filter.spec.ts`
Expected: FAIL with "Cannot find module './tool-list-filter'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/tools/tool-list-filter.ts
/**
 * Tool List Filter
 *
 * Filters tools BEFORE sending them to the model in the prompt.
 * Inspired by Claude Code's filterToolsByDenyRules() pattern.
 *
 * Two deny types:
 * - 'blanket': Tool removed from model's tool list entirely (never sees it)
 * - 'runtime': Tool visible to model but execution blocked (for user-controlled overrides)
 */

export interface FilterableTool {
  id: string;
  description: string;
}

export interface DenyRule {
  /** Pattern to match against tool ID (exact, prefix with __, or glob with *) */
  pattern: string;
  /** 'blanket' = hide from model, 'runtime' = visible but blocked at execution */
  type: 'blanket' | 'runtime';
}

export class ToolListFilter {
  private blanketPatterns: string[];
  private runtimePatterns: string[];

  constructor(private rules: DenyRule[]) {
    this.blanketPatterns = rules
      .filter(r => r.type === 'blanket')
      .map(r => r.pattern);
    this.runtimePatterns = rules
      .filter(r => r.type === 'runtime')
      .map(r => r.pattern);
  }

  /**
   * Filter tools for model prompt — removes blanket-denied tools entirely.
   * Runtime-denied tools remain visible.
   */
  filterForModel<T extends FilterableTool>(tools: T[]): T[] {
    return tools.filter(tool => !this.matchesAny(tool.id, this.blanketPatterns));
  }

  /**
   * Check if a tool is runtime-denied (visible but blocked at execution time).
   */
  isRuntimeDenied(toolId: string): boolean {
    return this.matchesAny(toolId, this.runtimePatterns);
  }

  /**
   * Check if a tool is blanket-denied (hidden from model entirely).
   */
  isBlanketDenied(toolId: string): boolean {
    return this.matchesAny(toolId, this.blanketPatterns);
  }

  private matchesAny(toolId: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.matchPattern(toolId, pattern));
  }

  private matchPattern(toolId: string, pattern: string): boolean {
    // Exact match
    if (toolId === pattern) return true;

    // Prefix match (e.g., 'mcp__server' matches 'mcp__server__action')
    if (toolId.startsWith(pattern + '__') || toolId.startsWith(pattern + ':')) return true;

    // Glob match (convert * to regex)
    if (pattern.includes('*')) {
      const regexStr = '^' + pattern.replace(/\*/g, '.*') + '$';
      return new RegExp(regexStr).test(toolId);
    }

    return false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/tools/tool-list-filter.spec.ts`
Expected: PASS — all 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/tool-list-filter.ts src/main/tools/tool-list-filter.spec.ts
git commit -m "feat(tools): add pre-model tool list filter with deny rules"
```

---

### Task 3: Streaming Tool Executor Core

**Files:**
- Create: `src/main/tools/streaming-tool-executor.ts`
- Create: `src/main/tools/streaming-tool-executor.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/tools/streaming-tool-executor.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamingToolExecutor, ToolStatus, type TrackedTool } from './streaming-tool-executor';

describe('StreamingToolExecutor', () => {
  let executor: StreamingToolExecutor;
  const makeExecuteFn = (result: unknown, delayMs = 0) =>
    vi.fn(async () => {
      if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
      return { ok: true as const, output: result };
    });

  const makeFailingExecuteFn = (error: string) =>
    vi.fn(async () => ({ ok: false as const, error }));

  beforeEach(() => {
    executor = new StreamingToolExecutor();
  });

  it('executes a single tool and returns result', async () => {
    const executeFn = makeExecuteFn('hello');
    executor.addTool({
      toolUseId: 'tool-1',
      toolId: 'bash',
      args: {},
      concurrencySafe: true,
      executeFn,
    });

    const results: any[] = [];
    for await (const result of executor.getRemainingResults()) {
      results.push(result);
    }

    expect(results).toHaveLength(1);
    expect(results[0].toolUseId).toBe('tool-1');
    expect(results[0].output).toBe('hello');
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it('runs concurrency-safe tools in parallel', async () => {
    const startTimes: number[] = [];
    const makeTimed = (id: string) => vi.fn(async () => {
      startTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 50));
      return { ok: true as const, output: id };
    });

    executor.addTool({ toolUseId: 'a', toolId: 'read', args: {}, concurrencySafe: true, executeFn: makeTimed('a') });
    executor.addTool({ toolUseId: 'b', toolId: 'read', args: {}, concurrencySafe: true, executeFn: makeTimed('b') });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results).toHaveLength(2);
    // Both should start within ~10ms of each other (parallel)
    expect(Math.abs(startTimes[0] - startTimes[1])).toBeLessThan(30);
  });

  it('runs non-concurrent tools exclusively', async () => {
    const startTimes: number[] = [];
    const makeTimed = (id: string) => vi.fn(async () => {
      startTimes.push(Date.now());
      await new Promise(r => setTimeout(r, 50));
      return { ok: true as const, output: id };
    });

    executor.addTool({ toolUseId: 'a', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: makeTimed('a') });
    executor.addTool({ toolUseId: 'b', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: makeTimed('b') });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results).toHaveLength(2);
    // Second should start after first finishes (~50ms gap)
    expect(startTimes[1] - startTimes[0]).toBeGreaterThanOrEqual(40);
  });

  it('cascades sibling abort on error when tool is non-concurrent', async () => {
    const failFn = makeFailingExecuteFn('disk full');
    const slowFn = vi.fn(async (_args: unknown, _ctx: unknown, signal?: AbortSignal) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, output: 'done' }), 5000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return { ok: true as const, output: 'done' };
    });

    // Non-concurrent: first fails, second should be aborted
    executor.addTool({ toolUseId: 'fail', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: failFn });
    executor.addTool({ toolUseId: 'slow', toolId: 'bash', args: {}, concurrencySafe: false, executeFn: slowFn });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    const failResult = results.find(r => r.toolUseId === 'fail');
    const slowResult = results.find(r => r.toolUseId === 'slow');
    expect(failResult?.ok).toBe(false);
    expect(slowResult?.ok).toBe(false);
    expect(slowResult?.error).toContain('sibling');
  });

  it('emits progress events', async () => {
    const progressMessages: any[] = [];
    executor.on('progress', (msg) => progressMessages.push(msg));

    const executeFn = vi.fn(async () => {
      executor.emitProgress('tool-1', 'Working on it...');
      return { ok: true as const, output: 'done' };
    });

    executor.addTool({ toolUseId: 'tool-1', toolId: 'bash', args: {}, concurrencySafe: true, executeFn });

    for await (const _r of executor.getRemainingResults()) { /* drain */ }

    expect(progressMessages).toHaveLength(1);
    expect(progressMessages[0].message).toBe('Working on it...');
  });

  it('returns results in submission order', async () => {
    // Tool 'b' finishes before tool 'a', but results should be in add order
    executor.addTool({
      toolUseId: 'a', toolId: 'read', args: {}, concurrencySafe: true,
      executeFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 80));
        return { ok: true as const, output: 'a-result' };
      }),
    });
    executor.addTool({
      toolUseId: 'b', toolId: 'read', args: {}, concurrencySafe: true,
      executeFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 10));
        return { ok: true as const, output: 'b-result' };
      }),
    });

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results[0].toolUseId).toBe('a');
    expect(results[1].toolUseId).toBe('b');
  });

  it('discards pending tools when discard() is called', async () => {
    executor.addTool({
      toolUseId: 'a', toolId: 'read', args: {}, concurrencySafe: true,
      executeFn: vi.fn(async () => {
        await new Promise(r => setTimeout(r, 5000));
        return { ok: true as const, output: 'done' };
      }),
    });

    executor.discard();

    const results: any[] = [];
    for await (const r of executor.getRemainingResults()) results.push(r);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toContain('discard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/tools/streaming-tool-executor.spec.ts`
Expected: FAIL with "Cannot find module './streaming-tool-executor'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/tools/streaming-tool-executor.ts
/**
 * Streaming Tool Executor
 *
 * Manages concurrent tool execution with:
 * - Concurrency safety metadata per tool
 * - Parallel execution for safe tools, exclusive for unsafe
 * - Progress message streaming via EventEmitter
 * - Sibling abort cascading on errors
 * - Results returned in submission order
 * - Discard support for streaming abort
 *
 * Inspired by Claude Code's StreamingToolExecutor.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';

const logger = getLogger('StreamingToolExecutor');

export enum ToolStatus {
  QUEUED = 'queued',
  EXECUTING = 'executing',
  COMPLETED = 'completed',
  YIELDED = 'yielded',
  DISCARDED = 'discarded',
}

export interface ToolExecutionResult {
  toolUseId: string;
  toolId: string;
  ok: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
}

export interface AddToolParams {
  toolUseId: string;
  toolId: string;
  args: unknown;
  concurrencySafe: boolean;
  executeFn: (args: unknown, ctx: unknown, signal?: AbortSignal) => Promise<{ ok: boolean; output?: unknown; error?: string }>;
}

export interface TrackedTool {
  toolUseId: string;
  toolId: string;
  args: unknown;
  concurrencySafe: boolean;
  executeFn: AddToolParams['executeFn'];
  status: ToolStatus;
  result?: ToolExecutionResult;
  startedAt?: number;
  abortController: AbortController;
  promise?: Promise<void>;
}

export interface ProgressMessage {
  toolUseId: string;
  toolId?: string;
  message: string;
  timestamp: number;
}

export class StreamingToolExecutor extends EventEmitter {
  private tools: TrackedTool[] = [];
  private siblingAbortController = new AbortController();
  private hasErrored = false;
  private discarded = false;
  private resolveWaiting: (() => void) | null = null;

  addTool(params: AddToolParams): void {
    if (this.discarded) {
      logger.warn('addTool called after discard', { toolUseId: params.toolUseId });
      return;
    }

    const toolAbortController = new AbortController();

    // Link to sibling abort
    this.siblingAbortController.signal.addEventListener('abort', () => {
      toolAbortController.abort('sibling_error');
    });

    const tracked: TrackedTool = {
      toolUseId: params.toolUseId,
      toolId: params.toolId,
      args: params.args,
      concurrencySafe: params.concurrencySafe,
      executeFn: params.executeFn,
      status: ToolStatus.QUEUED,
      abortController: toolAbortController,
    };

    this.tools.push(tracked);
    this.processQueue();
  }

  emitProgress(toolUseId: string, message: string): void {
    const msg: ProgressMessage = {
      toolUseId,
      message,
      timestamp: Date.now(),
    };
    this.emit('progress', msg);
  }

  /**
   * Discard all pending/executing tools (streaming abort).
   * Generates synthetic error results for unfinished tools.
   */
  discard(): void {
    this.discarded = true;
    this.siblingAbortController.abort('discard');

    for (const tool of this.tools) {
      if (tool.status === ToolStatus.QUEUED || tool.status === ToolStatus.EXECUTING) {
        tool.status = ToolStatus.DISCARDED;
        tool.result = {
          toolUseId: tool.toolUseId,
          toolId: tool.toolId,
          ok: false,
          error: 'Tool execution discarded (streaming abort)',
          durationMs: tool.startedAt ? Date.now() - tool.startedAt : 0,
        };
      }
    }

    // Wake up any waiters
    this.resolveWaiting?.();
  }

  /**
   * Async generator that yields results in submission order.
   * Waits for executing tools to complete.
   */
  async *getRemainingResults(): AsyncGenerator<ToolExecutionResult> {
    for (const tool of this.tools) {
      // Wait for tool to finish if still executing
      while (tool.status === ToolStatus.QUEUED || tool.status === ToolStatus.EXECUTING) {
        await new Promise<void>(resolve => {
          this.resolveWaiting = resolve;
          // Also resolve when tool completes
          const check = () => {
            if (tool.status !== ToolStatus.QUEUED && tool.status !== ToolStatus.EXECUTING) {
              resolve();
            }
          };
          this.on('tool:completed', check);
          this.on('tool:discarded', check);
          // Timeout safety: check periodically
          const timer = setTimeout(check, 100);
          const cleanup = () => {
            clearTimeout(timer);
            this.off('tool:completed', check);
            this.off('tool:discarded', check);
          };
          // Resolve once then cleanup
          const originalResolve = resolve;
          resolve = () => {
            cleanup();
            originalResolve();
          };
        });
      }

      if (tool.result) {
        tool.status = ToolStatus.YIELDED;
        yield tool.result;
      }
    }
  }

  private processQueue(): void {
    if (this.discarded) return;

    const executing = this.tools.filter(t => t.status === ToolStatus.EXECUTING);
    const queued = this.tools.filter(t => t.status === ToolStatus.QUEUED);

    if (queued.length === 0) return;

    const hasNonConcurrentExecuting = executing.some(t => !t.concurrencySafe);

    // If a non-concurrent tool is executing, wait
    if (hasNonConcurrentExecuting) return;

    for (const tool of queued) {
      if (!tool.concurrencySafe) {
        // Non-concurrent: only start if nothing else is executing
        if (executing.length === 0 && this.tools.filter(t => t.status === ToolStatus.EXECUTING).length === 0) {
          this.executeTool(tool);
          return; // Only one non-concurrent tool at a time
        }
        return; // Wait for concurrent tools to finish
      } else {
        // Concurrent: start immediately unless non-concurrent is queued first
        const firstQueued = queued[0];
        if (!firstQueued.concurrencySafe && firstQueued !== tool) {
          return; // Non-concurrent tool is ahead in queue, wait
        }
        this.executeTool(tool);
      }
    }
  }

  private executeTool(tool: TrackedTool): void {
    tool.status = ToolStatus.EXECUTING;
    tool.startedAt = Date.now();

    tool.promise = (async () => {
      try {
        const result = await tool.executeFn(tool.args, {}, tool.abortController.signal);
        const durationMs = Date.now() - tool.startedAt!;

        tool.result = {
          toolUseId: tool.toolUseId,
          toolId: tool.toolId,
          ok: result.ok,
          output: result.ok ? result.output : undefined,
          error: result.ok ? undefined : result.error,
          durationMs,
        };

        if (!result.ok && !tool.concurrencySafe) {
          // Non-concurrent tool error: cascade abort to siblings
          this.hasErrored = true;
          this.siblingAbortController.abort('sibling_error');
        }
      } catch (err) {
        const durationMs = Date.now() - (tool.startedAt || Date.now());
        const message = err instanceof Error ? err.message : String(err);
        const isAbort = tool.abortController.signal.aborted;

        tool.result = {
          toolUseId: tool.toolUseId,
          toolId: tool.toolId,
          ok: false,
          error: isAbort ? `Cancelled: sibling tool errored` : message,
          durationMs,
        };

        if (!isAbort && !tool.concurrencySafe) {
          this.hasErrored = true;
          this.siblingAbortController.abort('sibling_error');
        }
      } finally {
        tool.status = tool.status === ToolStatus.DISCARDED ? ToolStatus.DISCARDED : ToolStatus.COMPLETED;
        this.emit('tool:completed', tool.toolUseId);
        // Process next queued tools
        this.processQueue();
      }
    })();
  }

  getStatus(): { total: number; queued: number; executing: number; completed: number; discarded: number } {
    return {
      total: this.tools.length,
      queued: this.tools.filter(t => t.status === ToolStatus.QUEUED).length,
      executing: this.tools.filter(t => t.status === ToolStatus.EXECUTING).length,
      completed: this.tools.filter(t => t.status === ToolStatus.COMPLETED || t.status === ToolStatus.YIELDED).length,
      discarded: this.tools.filter(t => t.status === ToolStatus.DISCARDED).length,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/tools/streaming-tool-executor.spec.ts`
Expected: PASS — all 7 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/streaming-tool-executor.ts src/main/tools/streaming-tool-executor.spec.ts
git commit -m "feat(tools): add streaming tool executor with concurrency control and sibling abort"
```

---

### Task 4: Tool Use Summarizer

**Files:**
- Create: `src/main/tools/tool-use-summarizer.ts`
- Create: `src/main/tools/tool-use-summarizer.spec.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/tools/tool-use-summarizer.spec.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolUseSummarizer } from './tool-use-summarizer';
import type { ToolExecutionResult } from './streaming-tool-executor';

describe('ToolUseSummarizer', () => {
  it('generates a summary from tool results', async () => {
    const mockLlm = vi.fn(async (_prompt: string) => 'Read 3 files and edited config.json');
    const summarizer = new ToolUseSummarizer(mockLlm);

    const results: ToolExecutionResult[] = [
      { toolUseId: '1', toolId: 'read', ok: true, output: 'file contents...', durationMs: 100 },
      { toolUseId: '2', toolId: 'edit', ok: true, output: 'edited', durationMs: 200 },
    ];

    const summary = await summarizer.summarize(results);
    expect(summary).toBe('Read 3 files and edited config.json');
    expect(mockLlm).toHaveBeenCalledOnce();
  });

  it('returns fallback summary when LLM call fails', async () => {
    const mockLlm = vi.fn(async () => { throw new Error('API down'); });
    const summarizer = new ToolUseSummarizer(mockLlm);

    const results: ToolExecutionResult[] = [
      { toolUseId: '1', toolId: 'bash', ok: true, output: 'ok', durationMs: 50 },
    ];

    const summary = await summarizer.summarize(results);
    expect(summary).toContain('bash');
    expect(summary).toContain('1 tool');
  });

  it('returns null for empty results', async () => {
    const mockLlm = vi.fn();
    const summarizer = new ToolUseSummarizer(mockLlm);
    const summary = await summarizer.summarize([]);
    expect(summary).toBeNull();
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('includes error information in summary prompt', async () => {
    const mockLlm = vi.fn(async () => 'Attempted bash command but it failed');
    const summarizer = new ToolUseSummarizer(mockLlm);

    const results: ToolExecutionResult[] = [
      { toolUseId: '1', toolId: 'bash', ok: false, error: 'command not found', durationMs: 30 },
    ];

    const summary = await summarizer.summarize(results);
    expect(mockLlm).toHaveBeenCalledOnce();
    const prompt = mockLlm.mock.calls[0][0] as string;
    expect(prompt).toContain('failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/tools/tool-use-summarizer.spec.ts`
Expected: FAIL with "Cannot find module './tool-use-summarizer'"

- [ ] **Step 3: Write the implementation**

```typescript
// src/main/tools/tool-use-summarizer.ts
/**
 * Tool Use Summarizer
 *
 * Generates concise summaries of tool execution results.
 * Designed to run async during model streaming time (non-blocking).
 *
 * Inspired by Claude Code's async tool_use_summary generation
 * using a fast model (Haiku ~1s) while the main model streams (5-30s).
 */

import type { ToolExecutionResult } from './streaming-tool-executor';
import { getLogger } from '../logging/logger';

const logger = getLogger('ToolUseSummarizer');

export type LlmSummarizeFn = (prompt: string) => Promise<string>;

export class ToolUseSummarizer {
  constructor(private llmFn: LlmSummarizeFn) {}

  /**
   * Generate a summary of tool execution results.
   * Returns null for empty results.
   * Falls back to a local summary if LLM call fails.
   */
  async summarize(results: ToolExecutionResult[]): Promise<string | null> {
    if (results.length === 0) return null;

    const prompt = this.buildPrompt(results);

    try {
      return await this.llmFn(prompt);
    } catch (err) {
      logger.warn('LLM summarization failed, using fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallbackSummary(results);
    }
  }

  /**
   * Fire-and-forget: returns a promise that resolves to the summary.
   * Designed to run in background during model streaming.
   */
  summarizeAsync(results: ToolExecutionResult[]): Promise<string | null> {
    return this.summarize(results).catch(err => {
      logger.warn('Async summarization failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this.fallbackSummary(results);
    });
  }

  private buildPrompt(results: ToolExecutionResult[]): string {
    const toolSummaries = results.map(r => {
      if (r.ok) {
        const outputPreview = typeof r.output === 'string'
          ? r.output.slice(0, 200)
          : JSON.stringify(r.output)?.slice(0, 200) ?? '';
        return `- ${r.toolId}: succeeded (${r.durationMs}ms) → ${outputPreview}`;
      } else {
        return `- ${r.toolId}: failed → ${r.error}`;
      }
    }).join('\n');

    return `Summarize what these tool calls accomplished in one concise sentence (max 100 words):

${toolSummaries}

Summary:`;
  }

  private fallbackSummary(results: ToolExecutionResult[]): string {
    const succeeded = results.filter(r => r.ok);
    const failed = results.filter(r => !r.ok);
    const toolNames = [...new Set(results.map(r => r.toolId))].join(', ');

    const parts: string[] = [];
    parts.push(`${results.length} tool${results.length === 1 ? '' : 's'} executed`);
    parts.push(`(${toolNames})`);
    if (failed.length > 0) parts.push(`${failed.length} failed`);

    return parts.join(' — ');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/tools/tool-use-summarizer.spec.ts`
Expected: PASS — all 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/tools/tool-use-summarizer.ts src/main/tools/tool-use-summarizer.spec.ts
git commit -m "feat(tools): add async tool-use summarizer for context compaction"
```

---

### Task 5: Integrate New Tool Modules into Registry and Exports

**Files:**
- Modify: `src/main/tools/tool-registry.ts`
- Modify: `src/main/tools/tool-runner-child.ts`
- Modify: `src/main/tools/index.ts`

- [ ] **Step 1: Add concurrency metadata to ToolModule interface**

In `src/main/tools/tool-registry.ts`, add the `concurrencySafe` property:

```typescript
// After line 37, add to ToolModule interface:
  /** Whether this tool can run concurrently with other tools (default: true) */
  concurrencySafe?: boolean;
```

And propagate it in `LoadedTool`:

```typescript
// After line 44, add to LoadedTool interface:
  concurrencySafe: boolean;
```

Update `toLoadedTool` to extract the flag:

```typescript
// In toLoadedTool method, add before the return:
    return {
      id: toolId,
      description: def.description,
      filePath,
      schema,
      concurrencySafe: def.concurrencySafe !== false, // Default true
    };
```

- [ ] **Step 2: Add progress IPC to tool-runner-child.ts**

In `src/main/tools/tool-runner-child.ts`, add progress message support:

```typescript
// Replace the existing main() and process.on handler with:

type ProgressMessage = { type: 'progress'; message: string; timestamp: number };
type RunnerResponse =
  | { ok: true; output: unknown }
  | { ok: false; error: string };

async function main(req: RunnerRequest): Promise<RunnerResponse> {
  try {
    const def = loadTool(req.toolFilePath);
    if (!def || typeof def !== 'object') {
      return { ok: false, error: 'Tool module did not export an object' };
    }
    if (typeof def.execute !== 'function') {
      return { ok: false, error: 'Tool module missing execute()' };
    }

    // Provide a progress callback to the tool
    const progress = (message: string) => {
      const msg: ProgressMessage = { type: 'progress', message, timestamp: Date.now() };
      if (process.send) process.send(msg);
    };

    const out = await def.execute(req.args ?? {}, { ...req.ctx, progress });
    return { ok: true, output: out };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
```

- [ ] **Step 3: Update tool-registry.ts to handle progress messages from child**

In `runToolInChildProcess`, handle progress messages separately from final results:

```typescript
// In runToolInChildProcess, replace the child.once('message') handler:
      const progressHandler = (msg: any) => {
        if (msg && msg.type === 'progress') {
          // Forward to caller — stored for streaming executor
          this.emit('tool:progress', {
            toolFilePath: params.toolFilePath,
            message: msg.message,
            timestamp: msg.timestamp,
          });
          return;
        }
        // Final result
        clearTimeout(timer);
        child.off('message', progressHandler);
        try { child.kill(); } catch { /* ignore */ }
        if (msg && msg.ok === true) {
          resolve({ ok: true, output: msg.output });
          return;
        }
        resolve({ ok: false, error: msg?.error ? String(msg.error) : 'Tool execution failed' });
      };

      child.on('message', progressHandler);
```

- [ ] **Step 4: Update index.ts exports**

```typescript
// src/main/tools/index.ts
export { ToolRegistry, getToolRegistry, type ToolContext, type ToolModule } from './tool-registry';
export { StreamingToolExecutor, ToolStatus, type ToolExecutionResult, type AddToolParams, type TrackedTool, type ProgressMessage } from './streaming-tool-executor';
export { classifyToolError, ToolErrorCategory, type ClassifiedError } from './tool-error-classifier';
export { ToolListFilter, type DenyRule, type FilterableTool } from './tool-list-filter';
export { ToolUseSummarizer, type LlmSummarizeFn } from './tool-use-summarizer';
```

- [ ] **Step 5: Run typecheck and tests**

Run: `npx tsc --noEmit && npx vitest run src/main/tools/`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/main/tools/
git commit -m "feat(tools): integrate streaming executor, error classifier, list filter, and summarizer into tool registry"
```
